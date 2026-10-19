#!/usr/bin/env node
// 抓取脚本：从天天基金详情页读取每只基金的「交易状态 / 单日累计购买上限 / 官方简称」，
// 追加写入 data/history.json（按天累积，用于 30 天柱状图）与 data/fund-meta.json（官方名称）。
//
// 健壮性（对齐 qdii-purchase-limits 的设计）：
//   - 抓取失败 → 指数退避 + 抖动重试（默认最多 4 次）
//   - 响应大小上限（防畸形响应撑爆内存）
//   - HTTPS 主机白名单（只允许天天基金域名，死锁防止误打到别处）
//   - 原子写：先写临时文件再 rename，避免构建并发读到半截
//   - 健康门禁：人民币覆盖率低于阈值（默认 90%）或目标数为 0 → 非零退出，使 CI 不部署假象
//
// 用法：
//   node scripts/scrape.mjs                # 抓取 funds.json 里的全部基金
//   node scripts/scrape.mjs 019736 000834   # 只抓指定代码（调试用）
//   SCRAPE_MIN_COVERAGE=0.9 node scripts/scrape.mjs   # 自定义覆盖率阈值
//
// 依赖：仅 Node 22 内置（fetch / fs / Intl），无需安装任何 npm 包。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// ── 抓取健壮性配置 ──
const MAX_ATTEMPTS = 4; // 含首次，最多 4 次
const BASE_DELAY = 600; // 退避基数 ms
const MAX_DELAY = 8000; // 退避上限 ms
const JITTER = 400; // 抖动上限 ms
const FETCH_TIMEOUT = 15000; // 单次请求超时 ms
const MAX_BYTES = 6 * 1024 * 1024; // 响应体上限 6MB
const ALLOWED_HOSTS = new Set(['fund.eastmoney.com', 'fundf10.eastmoney.com']);
const MIN_COVERAGE = Number(process.env.SCRAPE_MIN_COVERAGE ?? 0.9); // 健康门禁阈值（仅看人民币份额）

function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8'));
  } catch {
    return fallback;
  }
}

// 原子写：先写临时文件，再 rename 覆盖，避免构建侧读到半截文件。
function writeJsonAtomic(name, obj) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = path.join(DATA_DIR, name + '.tmp');
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, path.join(DATA_DIR, name));
}

function todayCST() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 指数退避 + 抖动：600 → 1200 → 2400 … 上限 8s，每档再加 0~400ms 随机，避免集体同步重试。
const backoff = (attempt) => Math.min(MAX_DELAY, BASE_DELAY * 2 ** (attempt - 1)) + Math.random() * JITTER;

function parseName(html) {
  const m = html.match(/<title>([\s\S]*?)\((\d{6})\)基金净值/);
  return m ? m[1].trim() : null;
}
function stripTags(s) {
  return s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

// 从详情页解析交易状态与单日限额。返回 { status, limit, min }。
// limit 抽不到时返回 null，由上层打 dataQuality 标记，绝不臆造金额。
function parseTrading(html) {
  const i = html.indexOf('交易状态：');
  const chunk = i >= 0 ? stripTags(html.slice(i, i + 800)) : '';
  let status = 'UNKNOWN';
  if (/暂停申购/.test(chunk)) status = 'STOPPED';
  else if (/封闭/.test(chunk)) status = 'CLOSED';
  else if (/限大额/.test(chunk)) status = 'LIMITED';
  else if (/开放申购/.test(chunk)) status = 'OPEN';

  let limit = null;
  const lm = chunk.match(/单日累计购买上限\s*([\d.]+)\s*(元|万元)/);
  if (lm) {
    let v = parseFloat(lm[1]);
    if (lm[2] === '万元') v *= 10000;
    limit = Math.round(v);
  }
  let min = null;
  const mm = chunk.match(/起购金额[：: ]*([\d.]+)\s*元/);
  if (mm) min = parseFloat(mm[1]);

  // 暂停 / 封闭时无法买入，上限置空
  if (status === 'STOPPED' || status === 'CLOSED') limit = null;
  // 开放但带上限 → 实为限大额
  if (status === 'OPEN' && limit != null) status = 'LIMITED';

  return { status, limit, min };
}

async function fetchFund(code, attempt = 1) {
  const url = `https://fund.eastmoney.com/${code}.html`;
  // 主机白名单：死锁只认天天基金域名，防止误请求
  let host;
  try {
    host = new URL(url).host;
  } catch {
    return { code, name: null, status: 'UNKNOWN', limit: null, min: null, error: 'URL 非法' };
  }
  if (!ALLOWED_HOSTS.has(host)) {
    return { code, name: null, status: 'UNKNOWN', limit: null, min: null, error: `host 不在白名单: ${host}` };
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: 'https://fund.eastmoney.com/' },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error('HTTP ' + res.status);

    // 响应大小上限：先读字节再按上限判断，避免畸形/超大响应撑爆内存
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_BYTES) throw new Error(`响应过大 ${(buf.byteLength / 1024 / 1024).toFixed(1)}MB`);
    const html = buf.toString('utf8');

    const name = parseName(html);
    const { status, limit, min } = parseTrading(html);
    if (!name) throw new Error('未解析到基金名称');
    return { code, name, status, limit, min };
  } catch (e) {
    if (attempt < MAX_ATTEMPTS) {
      await sleep(backoff(attempt));
      return fetchFund(code, attempt + 1);
    }
    return {
      code,
      name: null,
      status: 'UNKNOWN',
      limit: null,
      min: null,
      error: String(e && e.message ? e.message : e),
      attempts: MAX_ATTEMPTS,
    };
  }
}

async function main() {
  const funds = readJson('funds.json', { funds: [] }).funds;
  const history = readJson('history.json', {});
  const meta = readJson('fund-meta.json', {});
  const today = todayCST();

  const only = process.argv.slice(2);
  // 代码 → 币种映射，用于「仅看人民币」的健康门禁
  const codeCurrency = new Map();
  const allCodes = [];
  for (const f of funds) {
    for (const c of f.codes) {
      allCodes.push(c.code);
      codeCurrency.set(c.code, f.currency);
    }
  }
  const targets = only.length ? only : allCodes;

  // 目录守卫：目标数为 0 = funds.json 解析失败或为空，绝不空跑（否则会把整站写成全 UNKNOWN）
  if (targets.length === 0) {
    console.error('✗ 目标基金数为 0（funds.json 可能解析失败或为空），拒绝抓取。');
    process.exit(3);
  }

  const stats = { OPEN: 0, LIMITED: 0, STOPPED: 0, CLOSED: 0, UNKNOWN: 0, fail: 0 };
  let okCount = 0; // 成功解析到名称 = 有效记录（全部目标）
  let cnyTargets = 0;
  let cnyOk = 0; // 人民币份额的有效记录

  for (const code of targets) {
    const isCny = codeCurrency.get(code) !== 'USD';
    if (isCny) cnyTargets++;
    const r = await fetchFund(code);
    if (r.name) {
      meta[code] = { name: r.name };
      okCount++;
      if (isCny) cnyOk++;
    }
    if (r.error) {
      stats.fail++;
      console.warn(`✗ ${code} 抓取失败: ${r.error}`);
    } else {
      console.log(`✓ ${code} ${r.name} [${r.status}${r.limit != null ? ' ' + r.limit + '元' : ''}]`);
    }
    stats[r.status] = (stats[r.status] || 0) + 1;

    const arr = history[code] || [];
    const point = { date: today, status: r.status, limit: r.limit };
    const last = arr[arr.length - 1];
    if (last && last.date === today) arr[arr.length - 1] = point; // 同日幂等覆盖
    else arr.push(point);
    history[code] = arr.slice(-60); // 最多保留 60 天，loader 读取时再截 30
    await sleep(250); // 礼貌限速
  }

  writeJsonAtomic('history.json', history);
  writeJsonAtomic('fund-meta.json', meta);

  // ── 健康门禁（仅看人民币份额，美元失败不应阻断人民币展示）──
  const cnyCoverage = cnyTargets ? cnyOk / cnyTargets : 1;
  const health = cnyCoverage >= MIN_COVERAGE ? 'OK' : 'DEGRADED';
  console.log('\n==== 今日抓取汇总 (' + today + ') ====');
  console.log(
    `开门 OPEN: ${stats.OPEN}  限购 LIMITED: ${stats.LIMITED}  ` +
      `暂停 STOPPED: ${stats.STOPPED}  封闭 CLOSED: ${stats.CLOSED}  ` +
      `未知 UNKNOWN: ${stats.UNKNOWN}  失败: ${stats.fail}`
  );
  console.log(
    `人民币有效解析: ${cnyOk}/${cnyTargets}  覆盖率: ${(cnyCoverage * 100).toFixed(1)}%  ` +
      `门禁阈值: ${(MIN_COVERAGE * 100).toFixed(0)}%  →  健康: ${health}`
  );
  console.log(`已更新 -> ${path.join(DATA_DIR, 'history.json')} 和 fund-meta.json`);

  if (health === 'DEGRADED') {
    console.error(
      `\n✗ 健康门禁未通过：人民币覆盖率 ${(cnyCoverage * 100).toFixed(1)}% < 阈值 ` +
        `${(MIN_COVERAGE * 100).toFixed(0)}%。`
    );
    console.error(
      '  可能是天天基金改版 / 网络抖动 / 被限流。本次结果不部署（CI 将失败），' +
        '避免发布「今日全暂停 / 全未知」的假象。'
    );
    process.exit(2);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
