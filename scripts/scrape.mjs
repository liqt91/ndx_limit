#!/usr/bin/env node
// 抓取脚本：从天天基金详情页读取每只基金的「交易状态 / 单日累计购买上限 / 官方简称」，
// 追加写入 data/history.json（按天累积，用于 30 天柱状图）与 data/fund-meta.json（官方名称）。
//
// 用法：
//   node scripts/scrape.mjs            # 抓取 funds.json 里的全部基金
//   node scripts/scrape.mjs 019736 000834   # 只抓指定代码（调试用）
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

function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8'));
  } catch {
    return fallback;
  }
}
function writeJson(name, obj) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, name), JSON.stringify(obj, null, 2) + '\n');
}
function todayCST() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseName(html) {
  const m = html.match(/<title>([\s\S]*?)\((\d{6})\)基金净值/);
  return m ? m[1].trim() : null;
}
function stripTags(s) {
  return s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

// 从详情页解析交易状态与单日限额。返回 { status, limit, min }。
function parseTrading(html) {
  const i = html.indexOf('交易状态：');
  const chunk = i >= 0 ? stripTags(html.slice(i, i + 800)) : '';
  let status = 'UNKNOWN';
  if (/暂停申购/.test(chunk)) status = 'STOPPED';
  else if (/封闭/.test(chunk)) status = 'CLOSED';
  else if (/限大额/.test(chunk)) status = 'LIMITED';
  else if (/开放申购/.test(chunk)) status = 'OPEN';

  // 单日累计购买上限：可能带「万元」单位，需换算
  let limit = null;
  const lm = chunk.match(/单日累计购买上限\s*([\d.]+)\s*(元|万元)/);
  if (lm) {
    let v = parseFloat(lm[1]);
    if (lm[2] === '万元') v *= 10000;
    limit = Math.round(v);
  }
  // 起购金额
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
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: 'https://fund.eastmoney.com/' },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const html = await res.text();
    const name = parseName(html);
    const { status, limit, min } = parseTrading(html);
    if (!name) throw new Error('未解析到基金名称');
    return { code, name, status, limit, min };
  } catch (e) {
    if (attempt < 2) {
      await sleep(800);
      return fetchFund(code, attempt + 1);
    }
    return {
      code,
      name: null,
      status: 'UNKNOWN',
      limit: null,
      min: null,
      error: String(e.message || e),
    };
  }
}

async function main() {
  const funds = readJson('funds.json', { funds: [] }).funds;
  const history = readJson('history.json', {});
  const meta = readJson('fund-meta.json', {});
  const today = todayCST();

  const only = process.argv.slice(2);
  const allCodes = [];
  for (const f of funds) for (const c of f.codes) allCodes.push(c.code);
  const targets = only.length ? only : allCodes;

  const stats = { OPEN: 0, LIMITED: 0, STOPPED: 0, CLOSED: 0, UNKNOWN: 0, fail: 0 };

  for (const code of targets) {
    const r = await fetchFund(code);
    if (r.name) meta[code] = { name: r.name };
    if (r.error) {
      stats.fail++;
      console.warn(`✗ ${code} 抓取失败: ${r.error}`);
    } else {
      console.log(
        `✓ ${code} ${r.name} [${r.status}${r.limit != null ? ' ' + r.limit + '元' : ''}]`
      );
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

  writeJson('history.json', history);
  writeJson('fund-meta.json', meta);

  console.log('\n==== 今日抓取汇总 (' + today + ') ====');
  console.log(
    `开门 OPEN: ${stats.OPEN}  限购 LIMITED: ${stats.LIMITED}  ` +
      `暂停 STOPPED: ${stats.STOPPED}  封闭 CLOSED: ${stats.CLOSED}  ` +
      `未知 UNKNOWN: ${stats.UNKNOWN}  失败: ${stats.fail}`
  );
  console.log(`已更新 -> ${path.join(DATA_DIR, 'history.json')} 和 fund-meta.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
