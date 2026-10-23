#!/usr/bin/env node
// 抓取脚本：从天天基金详情页读取每只基金的「交易状态 / 单日累计购买上限 / 官方简称」，
// 写入 data/history.json（按天累积）与 data/fund-meta.json（官方名称）。
//
// 健壮性（对齐 qdii-purchase-limits 的设计）：
//   - 抓取失败 → 指数退避 + 抖动重试（默认最多 4 次）
//   - 响应大小上限（防畸形响应撑爆内存）
//   - HTTPS 主机白名单（只允许天天基金域名，死锁防止误打到别处）
//   - 原子写：先写临时文件再 rename，避免构建并发读到半截
//   - 健康门禁：人民币覆盖率低于阈值（默认 90%）或目标数为 0 → 非零退出，使 CI 不部署假象
//
// 2026-10-21 增加三件事（数据完整性与健壮性）：
//   1) **全量快照旁路**（em-snapshot.mjs）：一次请求拿到全市场 28000+ 只基金。
//      用途是对账（金额为准）、兜底（详情页抓失败时补点）、缺口（扫出名单外的纳指100 份额）。
//      快照的**状态字段不可信**（016055 写「暂停申购」却给 1e11 限额、021000 写「限大额」
//      实际是「暂不开放购买」），所以它只做旁路，主链路仍是逐页。
//   2) **双时点抓取**：07:50 与收盘前各抓一次，同日幂等覆盖，并把每次运行写进 fetch-meta.json
//      的 runs[]（含该时点的开门数/可投额、以及与同日另一次运行的差异），供下午报「较今晨」用。
//   3) **公告解释源**（announcements.mjs）：只对当日有变化的份额拉公告，回答「为什么变了」。
//
// 2026-10-21 晚增加第四件事（备选信息源）：
//   4) **晨星旁路**（ms-fallback.mjs）：详情页与快照都失败时，用晨星中国（morningstar.cn）
//      的「申购状态 / 单日申购限额」补点——快照的状态字段不可信，晨星补的正是状态。
//      另做每日对账（--no-ms-check 可关）：60 份额实测与详情页 51/60 一致，分歧均可解释
//      （详见 ms-fallback.mjs 头部注释）。新浪也有限额字段但数据滞后（仅 14/60 一致），未接入。
//
// 用法：
//   node scripts/scrape.mjs                      # 抓 funds.json 全部（时点按北京时间自动判）
//   node scripts/scrape.mjs --slot close         # 指定时点（morning / close）
//   node scripts/scrape.mjs 019736 000834        # 只抓指定代码（调试用）
//   node scripts/scrape.mjs --no-snapshot        # 跳过全量快照旁路（离线调试）
//   SCRAPE_MIN_COVERAGE=0.9 node scripts/scrape.mjs   # 自定义覆盖率阈值
//
// 依赖：仅 Node 22 内置（fetch / fs / Intl）+ 本地 digest.mjs / em-snapshot.mjs / announcements.mjs。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isTradingDay, aggregateCny, NDX, SP500, INDEX_KEYS } from './digest.mjs';
import { fetchSnapshot, scanNasdaq100, scanSp500, excludeExchangeTraded } from './em-snapshot.mjs';
import { fetchMorningstar } from './ms-fallback.mjs';
import { refreshAnnouncements, loadAnnouncementStore } from './announcements.mjs';

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
const MAX_MISMATCH_KEEP = 10; // fetch-meta 里最多留几条对账差异（给人看的，不是全量日志）
const MAX_GAP_KEEP = 30; // 名单外缺口最多记几条

// ── 命令行 ──
const argv = process.argv.slice(2);
const onlyCodes = [];
let slotArg = null;
let useSnapshot = true;
let useMsCheck = true; // 晨星对账（旁路③）：默认开，--no-ms-check 关
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--slot') {
    slotArg = argv[++i] ?? null;
    continue;
  }
  if (a.startsWith('--slot=')) {
    slotArg = a.slice('--slot='.length);
    continue;
  }
  if (a === '--no-snapshot') {
    useSnapshot = false;
    continue;
  }
  if (a === '--no-ms-check') {
    useMsCheck = false;
    continue;
  }
  if (a.startsWith('--')) continue;
  onlyCodes.push(a);
}

function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8'));
  } catch {
    return fallback;
  }
}

// 中国 A股休市日（法定节假日实际放假日期），来源 data/market-holidays.json。
// 交易日 = 工作日 且 不在该集合；调休补班日若在周末市场仍休市，无需单独处理。
// 判定函数从 digest.mjs 取，避免「星期怎么算」在三个脚本里各写一份（曾经三份都带时区 bug）。
const HOLIDAYS = new Set(readJson('market-holidays.json', []));

// 原子写：先写临时文件，再 rename 覆盖，避免构建侧读到半截文件。
function writeJsonAtomic(name, obj) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = path.join(DATA_DIR, name + '.tmp');
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, path.join(DATA_DIR, name));
}

// 东八区的日期 / 时刻 / ISO 三件套。一律用 Intl 取，不自己加减时区偏移。
function nowCST() {
  const fmt = (opts) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', ...opts }).format(new Date());
  const date = fmt({});
  const time = fmt({ hour: '2-digit', minute: '2-digit', hour12: false });
  const iso =
    fmt({ year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).replace(' ', 'T') +
    '+08:00';
  return { date, time, iso };
}
const NOW = nowCST();
const today = NOW.date;

// 抓取时点：早间（开盘前）/ 收盘前。
// 之所以默认按时刻自动判，而不是让调度端传参：定时触发端正在从轻量云 crontab 迁往
// EdgeOne schedules，两个会话同时改调度容易对不上；需要精确指定时用 --slot。
const SLOT = slotArg || process.env.SCRAPE_SLOT || (NOW.time < '12:00' ? 'morning' : 'close');
const SLOT_LABEL = { morning: '早间', close: '收盘前' }[SLOT] || SLOT;

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
  // 暂不开放购买 = 官网明确的「当前不可申购」信号，优先级高于「限大额」。
  // 如天弘D类(022525)交易状态字段写「限大额 开放赎回」却紧跟「该基金暂不开放购买」，
  // 若不拦截会被误判为可买的 LIMITED。命中即视为不可买。
  // 南方 I 类(021000)同样如此：「限大额 开放赎回」+「该基金暂不开放购买」。
  else if (/暂不开放购买/.test(chunk)) status = 'STOPPED';
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

const samePoint = (a, b) => !!a && !!b && a.status === b.status && a.limit === b.limit;

async function main() {
  const funds = readJson('funds.json', { funds: [] }).funds;
  const history = readJson('history.json', {});
  const meta = readJson('fund-meta.json', {});
  const prevFetchMeta = readJson('fetch-meta.json', {});

  // 非交易日（周末/法定节假日）：不抓取、不写数据，避免 history.json 混入休市日记录。
  // CI 仍每日触发，但今日无有效数据可抓 → 直接成功退出，不污染数据、也不产生空 commit。
  if (!isTradingDay(today, HOLIDAYS)) {
    console.log(`今日 ${today} 为非交易日（休市），跳过抓取，不写入任何数据。`);
    process.exit(0);
  }

  // 代码 → 币种 / 指数映射，用于「仅看人民币」的健康门禁与分指数统计
  const codeCurrency = new Map();
  const codeIndex = new Map();
  const allCodes = [];
  for (const f of funds) {
    for (const c of f.codes) {
      allCodes.push(c.code);
      codeCurrency.set(c.code, f.currency);
      codeIndex.set(c.code, f.indexKey);
    }
  }
  const targets = onlyCodes.length ? onlyCodes : allCodes;

  // 指数全集：以 funds.json 实际出现的 indexKey 为准，而不是常量表。
  // 否则有人往 funds.json 塞一个新 indexKey 时，它的份额会被静默算进纳指的覆盖率分母。
  const indexKeys = [...new Set([...INDEX_KEYS, ...funds.map((f) => f.indexKey)])];

  // 目录守卫：目标数为 0 = funds.json 解析失败或为空，绝不空跑（否则会把整站写成全 UNKNOWN）
  if (targets.length === 0) {
    console.error('✗ 目标基金数为 0（funds.json 可能解析失败或为空），拒绝抓取。');
    process.exit(3);
  }

  console.log(`抓取时点：${SLOT_LABEL}（slot=${SLOT}，${NOW.iso}）  目标 ${targets.length} 个份额`);

  // ── 旁路①：全量快照。失败不影响主流程（null）──
  let snap = null;
  if (useSnapshot) {
    const t0 = Date.now();
    snap = await fetchSnapshot();
    if (snap) {
      console.log(`✓ 全量快照：${snap.rows.size} 只，${((Date.now() - t0) / 1000).toFixed(1)}s`);
    } else {
      console.log('⚠ 全量快照不可用：本次只走逐页抓取（对账/兜底/缺口检测跳过）');
    }
  }

  // 分指数统计：覆盖率门禁按指数各算各的。标普500 抓不稳时只降级它自己，
  // 不能连坐纳指——纳指的日报/页面是本站在跑的主业务。
  const perIndex = new Map();
  for (const k of indexKeys) {
    perIndex.set(k, { cnyTargets: 0, cnyOk: 0, recovered: 0, msRecovered: 0, status: {} });
  }
  const stats = { OPEN: 0, LIMITED: 0, STOPPED: 0, CLOSED: 0, UNKNOWN: 0, fail: 0 };
  let okCount = 0; // 成功解析到名称 = 有效记录（全部目标）

  const pageResults = new Map(); // code → 逐页解析结果（用于对账）
  const beforeDay = new Map(); // code → 覆盖前 history 里「今天」那条（算盘中差异）
  const prevTrading = new Map(); // code → 覆盖前 history 里「今天之前」最近一条（算跨日变化）
  const pointByCode = {}; // code → 今日最终点
  const warnings = [];

  for (const code of targets) {
    const idxKey = codeIndex.get(code) ?? NDX;
    const idxStat = perIndex.get(idxKey) ?? perIndex.get(NDX);
    const isCny = codeCurrency.get(code) !== 'USD';
    if (isCny) idxStat.cnyTargets++;

    let r = await fetchFund(code);
    let fromSnapshot = false;
    let fromMorningstar = false;

    if (r.error && snap) {
      const row = snap.rows.get(code);
      // 兜底只在快照自己说得清状态时生效：UNKNOWN 兜底等于换个地方写「不知道」
      if (row && row.status !== 'UNKNOWN') {
        r = { code, name: row.name, status: row.status, limit: row.limit, min: row.min };
        fromSnapshot = true;
        if (isCny) idxStat.recovered++;
      }
    }

    // 旁路③：快照也没有（或没开快照）时找晨星。它补的主要是「状态」——
    // 快照的状态字段有噪声，详情页又抓不到时，这是最后一个能说清「能不能买」的来源。
    // 名称沿用 fund-meta 里上次成功抓到的官方简称（晨星页名与天天基金口径不同，不混用）；
    // 没有历史名称时 name 为 null，该点仍写入 history，但不算「有效解析」（门禁照不到绿灯）。
    if (r.error && !fromSnapshot) {
      const ms = await fetchMorningstar(code);
      if (!ms.error) {
        r = { code, name: meta[code]?.name ?? null, status: ms.status, limit: ms.limit, min: null };
        fromMorningstar = true;
        if (isCny) idxStat.msRecovered++;
      }
    }

    if (!fromSnapshot && !fromMorningstar) pageResults.set(code, r);
    if (r.name) {
      meta[code] = { name: r.name };
      okCount++;
      if (isCny && !fromSnapshot) idxStat.cnyOk++;
    }
    if (r.error) {
      stats.fail++;
      console.warn(`✗ ${code} 抓取失败: ${r.error}${fromSnapshot ? '（已用全量快照兜底）' : fromMorningstar ? '（已用晨星兜底）' : ''}`);
    } else {
      const tag = fromSnapshot ? ' ↺快照' : fromMorningstar ? ' ↺晨星' : '';
      console.log(`✓ ${code} ${r.name} [${r.status}${r.limit != null ? ' ' + r.limit + '元' : ''}]${tag}`);
    }
    stats[r.status] = (stats[r.status] || 0) + 1;
    idxStat.status[r.status] = (idxStat.status[r.status] || 0) + 1;

    // 上限 < 起购 = 实际买不到。历史上 0 条，属于预防性提示：不擅自改状态，只记一条告警，
    // 让「限 1 元、起购 10 元」这种自相矛盾的数据能被发现，而不是安静地显示成可买 1 元。
    if (r.limit != null && r.min != null && r.limit < r.min) {
      warnings.push(`${code} 单日上限 ${r.limit} 元 < 起购 ${r.min} 元`);
    }

    const arr = history[code] || [];
    const last = arr[arr.length - 1];
    if (last && last.date === today) beforeDay.set(code, { ...last });
    const prev = [...arr].reverse().find((p) => p.date !== today);
    if (prev) prevTrading.set(code, { ...prev });

    const point = { date: today, status: r.status, limit: r.limit };
    pointByCode[code] = point;

    await sleep(250); // 礼貌限速
  }

  // 名称与状态无关：抓到了就留下。门禁不该把名称一起回滚。
  writeJsonAtomic('fund-meta.json', meta);

  // ── 健康门禁（分指数，仅看人民币份额）──
  // cnyOk 只统计「详情页抓取成功」。用快照 / 晨星兜底的份额不计入——快照状态字段有噪声，
  // 若让兜底也算成功，上游页面改版时门禁会变成假绿灯。
  const coverage = {};
  for (const k of indexKeys) {
    const st = perIndex.get(k);
    coverage[k] = st.cnyTargets ? st.cnyOk / st.cnyTargets : 1;
  }

  // 纳指不达标 → 整轮不写任何点，exit 2。既有契约：宁可不出新数据，
  // 也不发布「今日全暂停 / 全未知」的假象（CI 红 → 不提交 → EdgeOne 保留上次好构建）。
  if (coverage[NDX] < MIN_COVERAGE) {
    console.error(
      `\n✗ 健康门禁未通过（纳指100）：人民币覆盖率 ${(coverage[NDX] * 100).toFixed(1)}% < 阈值 ` +
        `${(MIN_COVERAGE * 100).toFixed(0)}%。本次不写入任何数据。`
    );
    console.error('  可能是天天基金改版 / 网络抖动 / 被限流。');
    process.exit(2);
  }

  // 其他指数不达标 → 只丢它今天的点（history 保留上次好数据，页面会亮「数据过期」），
  // 不阻断纳指。标普500 抓失败不该让纳指的日报和页面停摆。
  const degradedIndexes = [];
  for (const k of indexKeys) {
    if (k === NDX || coverage[k] >= MIN_COVERAGE) continue;
    degradedIndexes.push(k);
    let dropped = 0;
    for (const code of Object.keys(pointByCode)) {
      if (codeIndex.get(code) === k) {
        delete pointByCode[code];
        dropped++;
      }
    }
    console.warn(
      `⚠ ${k} 覆盖率 ${(coverage[k] * 100).toFixed(1)}% < 阈值 ${(MIN_COVERAGE * 100).toFixed(0)}%：` +
        `丢弃它今天的 ${dropped} 个点，保留上次数据（页面会显示过期提示）`
    );
  }

  // 生效点写入 history：同日幂等覆盖，最多留 60 天（loader 读取时再截 30）
  for (const code of Object.keys(pointByCode)) {
    const point = pointByCode[code];
    const arr = history[code] || [];
    const last = arr[arr.length - 1];
    if (last && last.date === today) arr[arr.length - 1] = point;
    else arr.push(point);
    history[code] = arr.slice(-60);
  }
  writeJsonAtomic('history.json', history);

  // ── 旁路①的对账与缺口 ──
  const shadow = { available: !!snap, checked: 0, agree: 0, mismatch: [], recovered: [], gaps: null, warnings };
  if (snap) {
    for (const [code, r] of pageResults) {
      if (!r.name) continue;
      const row = snap.rows.get(code);
      if (!row || row.status === 'UNKNOWN') continue; // 快照自己说不清，不参与对账
      shadow.checked++;
      const pageBuy = r.status === 'OPEN' || r.status === 'LIMITED';
      const snapBuy = row.status === 'OPEN' || row.status === 'LIMITED';
      const pageLimit = pageBuy ? r.limit : null;
      const snapLimit = snapBuy ? row.limit : null;
      if (pageBuy !== snapBuy || pageLimit !== snapLimit) {
        if (shadow.mismatch.length < MAX_MISMATCH_KEEP) {
          shadow.mismatch.push({
            code,
            page: { status: r.status, limit: r.limit },
            snapshot: { status: row.status, limit: row.limit },
          });
        }
      } else {
        shadow.agree++;
      }
    }
    for (const code of targets) {
      if (!pageResults.has(code) && pointByCode[code]) shadow.recovered.push(code);
    }
    // 名单外缺口：只报不改。funds.json 要人工维护，自动并入会让口径失控。
    // 场内 ETF 不算缺口——它们没有「场外申购限额」这个概念，本站明确只统计场外份额。
    // 把它们算缺口会天天报几条噪声，真正的缺口（新发的 I 类份额之类）就会被淹掉。
    //
    // 判据不能用「代码 15/51 开头」：161125、160213 这类 LOF 场外可申购，会被误伤。
    // 统一用 excludeExchangeTraded（名称含 ETF 但不含「联接」= 场内）。
    //
    // 分指数各扫各的：标普500 的缺口混进纳指那份清单里，人工确认时根本分不清该改哪一行。
    const gapFor = (indexKey, scan) => {
      const idxKnown = new Set();
      for (const f of funds) if (f.indexKey === indexKey) for (const c of f.codes) idxKnown.add(c.code);
      const outside = scan.filter((r) => !idxKnown.has(r.code));
      const { exchange, over } = excludeExchangeTraded(outside);
      return {
        scoped: scan.length,
        known: idxKnown.size,
        excludedExchange: exchange.length,
        missing: over
          .map((r) => ({ code: r.code, name: r.name, status: r.status, limit: r.limit, type: r.type }))
          .slice(0, MAX_GAP_KEEP),
      };
    };
    const SCANNERS = { [NDX]: scanNasdaq100, [SP500]: scanSp500 };
    shadow.gapsByIndex = {};
    for (const k of indexKeys) {
      const scan = SCANNERS[k] ? SCANNERS[k](snap.rows) : [];
      shadow.gapsByIndex[k] = gapFor(k, scan);
    }
    shadow.gaps = shadow.gapsByIndex[NDX]; // 兼容：notify.mjs 读的是顶层 gaps
  }

  // ── 旁路③：晨星对账（独立第二意见，只对「详情页抓成功」的份额比）──
  // 快照对账只信金额（状态字段有噪声）；晨星对账补的正是状态这一维。
  // 失败静默跳过：晨星只是备选源，它挂掉不该影响主链路与门禁。
  const msCheck = { available: false, checked: 0, agree: 0, mismatch: [] };
  if (useMsCheck && !onlyCodes.length) {
    for (const [code, r] of pageResults) {
      if (!r.name) continue;
      const ms = await fetchMorningstar(code);
      if (ms.error) continue;
      msCheck.available = true;
      msCheck.checked++;
      const same = ms.status === r.status && (r.status !== 'LIMITED' || ms.limit === r.limit);
      if (same) msCheck.agree++;
      else if (msCheck.mismatch.length < MAX_MISMATCH_KEEP) {
        msCheck.mismatch.push({
          code,
          page: { status: r.status, limit: r.limit },
          ms: { status: ms.status, limit: ms.limit },
        });
      }
      await sleep(150); // 礼貌限速
    }
    if (msCheck.available) {
      console.log(`✓ 晨星对账：${msCheck.agree}/${msCheck.checked} 与详情页一致` +
        (msCheck.mismatch.length ? `（${msCheck.mismatch.length} 处差异已记录，详情页口径不变）` : ''));
    } else {
      console.log('⚠ 晨星对账不可用（本次跳过，不影响数据）');
    }
  }

  // ── 旁路②：公告（只对「与上一个交易日相比有变化」的份额抓）──
  const changedVsPrevDay = [];
  for (const code of targets) {
    const prev = prevTrading.get(code);
    if (!prev || !pointByCode[code]) continue;
    if (!samePoint(prev, pointByCode[code])) {
      changedVsPrevDay.push({ code, from: prev, to: pointByCode[code] });
    }
  }
  let annResult = { updated: 0, total: 0, store: loadAnnouncementStore() };
  if (changedVsPrevDay.length) {
    annResult = await refreshAnnouncements(changedVsPrevDay.map((c) => c.code), annResult.store);
    console.log(`✓ 公告：${changedVsPrevDay.length} 个份额有变化，成功刷新 ${annResult.updated} 只的公告`);
  }

  // ── 运行记录（fetch-meta.json）──
  // runs[] 供下午报回答「较今晨变了什么」。history 每个交易日只有一条点，
  // 同日的「早间值」会被覆盖掉，所以差异必须在覆盖前后各取一次快照算出来存这里。
  const prevRuns = prevFetchMeta.date === today && Array.isArray(prevFetchMeta.runs) ? prevFetchMeta.runs : [];
  const otherRuns = prevRuns.filter((r) => r.slot !== SLOT);
  const intraday = [];
  for (const [code, before] of beforeDay) {
    if (before && pointByCode[code] && !samePoint(before, pointByCode[code])) {
      intraday.push({ code, from: { status: before.status, limit: before.limit }, to: { status: pointByCode[code].status, limit: pointByCode[code].limit } });
    }
  }
  const existingRun = prevRuns.find((r) => r.slot === SLOT);
  // 只有「今天已经有别的时点跑过」时，这个差异才有意义；重跑同一时点时不要把它抹成空
  const changed = intraday.length ? intraday.slice(0, 20) : existingRun && existingRun.changed ? existingRun.changed : null;

  // ★ fetch-meta 的顶层字段永远是纳指（日报、页面首屏、小程序都按这个读，语义不变）。
  //   标普500 等其它指数放进 byIndex，缺字段 = 该指数今天没有有效聚合（被门禁丢弃）。
  const agg = aggregateCny(funds, pointByCode, NDX);
  const changedOf = (k) =>
    changed ? changed.filter((c) => (codeIndex.get(c.code) ?? NDX) === k) : null;
  const byIndex = {};
  for (const k of indexKeys) {
    if (k === NDX) continue;
    const a = aggregateCny(funds, pointByCode, k);
    byIndex[k] = {
      opened: a.opened,
      total: a.total,
      families: a.families,
      degraded: degradedIndexes.includes(k),
      changed: changedOf(k),
    };
  }
  const run = {
    slot: SLOT,
    at: NOW.iso,
    time: NOW.time,
    opened: agg.opened,
    total: agg.total,
    families: agg.families,
    changed: otherRuns.length ? changed : null,
    byIndex,
  };
  const runs = [...otherRuns, run].sort((a, b) => (a.at < b.at ? -1 : 1));

  // 调试模式（命令行指定了代码）不写 fetch-meta：那次聚合只覆盖被指定的份额，
  // 写进去会让页面/下午报读到「3 家开门」这种以偏概全的数。
  if (onlyCodes.length) {
    console.log('调试模式（指定了代码）：history/meta 已更新，跳过 fetch-meta 与旁路报告');
  } else {
    writeJsonAtomic('fetch-meta.json', { date: today, fetchedAt: NOW.iso, slot: SLOT, runs, shadow, ms: msCheck });
  }

  // ── 汇总打印（分指数）──
  console.log('\n==== 今日抓取汇总 (' + today + ' ' + SLOT_LABEL + ') ====');
  console.log(
    `开门 OPEN: ${stats.OPEN}  限购 LIMITED: ${stats.LIMITED}  ` +
      `暂停 STOPPED: ${stats.STOPPED}  封闭 CLOSED: ${stats.CLOSED}  ` +
      `未知 UNKNOWN: ${stats.UNKNOWN}  失败: ${stats.fail}（两指数合计）`
  );
  for (const k of indexKeys) {
    const st = perIndex.get(k);
    const cov = coverage[k];
    const a = aggregateCny(funds, pointByCode, k);
    const tail = [
      st.recovered ? `快照兜底 ${st.recovered}` : '',
      st.msRecovered ? `晨星兜底 ${st.msRecovered}` : '',
      degradedIndexes.includes(k) ? '今日点已丢弃（保留上次数据）' : '',
    ].filter(Boolean).join(' · ');
    console.log(
      `[${k}] 人民币有效解析 ${st.cnyOk}/${st.cnyTargets}  覆盖率 ${(cov * 100).toFixed(1)}%  ` +
        `→ 当日聚合 ${a.opened}/${a.families} 家开门，合计 ${a.total} 元可投` +
        (tail ? `（${tail}）` : '')
    );
  }
  if (intraday.length) console.log(`较同日上一次运行有 ${intraday.length} 处变化`);
  if (shadow.mismatch.length) {
    console.warn(`⚠ 对账差异 ${shadow.mismatch.length} 处（金额以逐页为准，需人工确认）：`);
    for (const m of shadow.mismatch) {
      console.warn(`   ${m.code} 页面=${m.page.status}/${m.page.limit ?? '—'}  快照=${m.snapshot.status}/${m.snapshot.limit ?? '—'}`);
    }
  } else if (snap) {
    console.log(`对账：${shadow.agree}/${shadow.checked} 与全量快照一致`);
  }
  // 缺口按指数分别报：合在一起报，人工确认时不知道该去 funds.json 的哪一段加行
  for (const k of indexKeys) {
    const g = shadow.gapsByIndex?.[k];
    if (!g) continue;
    if (g.missing.length) {
      console.warn(`⚠ 名单外${k} 份额 ${g.missing.length} 个（未收录，需人工确认）：`);
      for (const m of g.missing) console.warn(`   ${m.code} ${m.name} [${m.status}${m.limit != null ? ' ' + m.limit + '元' : ''}]`);
    } else {
      console.log(`[${k}] 名单外只有场内 ETF ${g.excludedExchange} 个（按口径不收），无场外份额缺口`);
    }
  }
  if (msCheck.mismatch.length) {
    console.warn(`⚠ 晨星对账差异 ${msCheck.mismatch.length} 处（以详情页口径为准，需人工确认）：`);
    for (const m of msCheck.mismatch) {
      console.warn(`   ${m.code} 页面=${m.page.status}/${m.page.limit ?? '—'}  晨星=${m.ms.status}/${m.ms.limit ?? '—'}`);
    }
  }
  for (const w of warnings) console.warn(`⚠ ${w}`);
  console.log(`已更新 -> ${path.join(DATA_DIR, 'history.json')}、fund-meta.json、fetch-meta.json`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
