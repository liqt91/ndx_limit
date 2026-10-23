// 每日日报构建模块：读取 data/，计算人民币覆盖率与「今日 vs 昨日」变化，
// 产出要发送的标题与正文。通知（notify.mjs，管理员自通知）与群发（broadcast.mjs，订阅人）
// 共用本模块，保证两者口径一致、不会漂移。
//
// 设计对齐 scrape 门禁：覆盖率低于阈值视为数据不完整（healthy=false），调用方据此不发送误导内容。
// 「无变化」也产出文本（含「今日无变化」说明），由 broadcast 决定仍群发。
//
// 依赖：仅 Node 22 内置。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'data');

export const MIN_COVERAGE = Number(process.env.SCRAPE_MIN_COVERAGE ?? 0.9);

// 分指数口径（2026-10-23 起 funds.json 里有纳指100 与标普500 两个 indexKey）。
// ★ 所有聚合都必须显式带 indexKey：省略 = 纳指（早报/小程序的既有契约）。
//   不存在「不分指数的全量聚合」这种用法——那会静默把两个指数的额度加在一起。
//   与 src/data/loader.ts 的 NDX / SP500 常量必须逐字一致。
export const NDX = '纳斯达克100';
export const SP500 = '标普500';
export const INDEX_KEYS = [NDX, SP500];

/** 按指数过滤 funds.json 条目。indexKey 省略时原样返回（调用方自己去保证语义）。 */
export function fundsOfIndex(funds, indexKey) {
  if (!indexKey) return funds;
  return funds.filter((f) => f.indexKey === indexKey);
}

export function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8'));
  } catch {
    return fallback;
  }
}

export function classifyChange(from, to) {
  const fromBuy = from.status === 'OPEN' || from.status === 'LIMITED';
  const toBuy = to.status === 'OPEN' || to.status === 'LIMITED';
  if (to.status === 'UNKNOWN' && from.status !== 'UNKNOWN') return 'unknown';
  if (!fromBuy && toBuy) return 'opened';
  if (fromBuy && !toBuy) return 'stopped';
  if (fromBuy && toBuy) {
    if (from.limit == null && to.limit != null) return 'limit-set';
    if (from.limit != null && to.limit == null) return 'limit-clear';
    if (from.limit != null && to.limit != null && from.limit !== to.limit)
      return to.limit > from.limit ? 'limit-up' : 'limit-down';
  }
  return 'other';
}

export function kindOrder(k) {
  return (
    { opened: 0, stopped: 1, 'limit-up': 2, 'limit-down': 3, 'limit-set': 4, 'limit-clear': 5, unknown: 6, other: 7 }[k] ?? 9
  );
}

// 全量历史里最新的那一天（YYYY-MM-DD）。用于判断数据是不是「今天的」。
// ★ 传 codes 时只看这些代码——否则标普500 抓到了、纳指没抓到，日期照样是今天，
//   发信门禁会放行一封用昨天纳指数据拼出来的早报。
export function latestDate(history, codes) {
  let max = '';
  for (const code in history) {
    if (codes && !codes.has(code)) continue;
    const arr = history[code];
    if (Array.isArray(arr) && arr.length) {
      const d = arr[arr.length - 1].date;
      if (d > max) max = d;
    }
  }
  return max;
}

// 北京时间的今天（YYYY-MM-DD）。scrape 写数据用的是同一口径，两边必须一致。
export function todayShanghai() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
}

// 人民币份额覆盖率（分母只算人民币份额，与 scrape 门禁口径一致）。
// indexKey 默认纳指：早报发的是纳指，标普500 抓失败不该阻断纳指的推送。
export function computeCoverage(funds, meta, indexKey = NDX) {
  const scoped = fundsOfIndex(funds, indexKey);
  let cnyTargets = 0;
  let cnyOk = 0;
  const codeCurrency = new Map();
  for (const f of scoped)
    for (const c of f.codes) {
      codeCurrency.set(c.code, f.currency);
      if (f.currency !== 'USD') cnyTargets++;
    }
  // ★ 只认「明确记在本指数名录里、且为 CNY」的代码。早先写的是 `!== 'USD'`，
  //   而 Map 对未收录的 code 返回 undefined，`undefined !== 'USD'` 恒真——
  //   fund-meta 里任何别的指数的份额都会被算成「本指数人民币抓取成功」。
  //   2026-10-23 加标普500 后这个隐患立刻显形：纳指覆盖率报出 161%。
  for (const code in meta) {
    if (codeCurrency.get(code) === 'CNY' && meta[code] && meta[code].name) cnyOk++;
  }
  return cnyTargets ? cnyOk / cnyTargets : 1;
}

// 交易日判定（与 src/data/dates.ts 同源：data/market-holidays.json）。
// 交易日 = 工作日 且 非法定休市日；调休补班日若在周末市场仍休市，无需单独处理。
//
// 星期的算法只能用 UTC：`new Date(date + 'T00:00:00+08:00').getDay()` 在 UTC 构建机
// （GitHub Actions 默认）上会把时刻回退 16 小时，「周一」判成「周日」——抓取侧表现为
// 每周少一天、且周六反而照常抓。本地开发机在 UTC+8，永远看不出这个偏差。
export function dowOf(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
export function shiftDate(date, days) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
export function loadHolidays() {
  return new Set(readJson('market-holidays.json', []));
}
export function isTradingDay(date, holidays) {
  const dow = dowOf(date);
  if (dow === 0 || dow === 6) return false; // 周末
  return !holidays.has(date);
}
export function prevTradingDay(date, holidays) {
  for (let i = 1; i <= 30; i++) {
    const cand = shiftDate(date, -i);
    if (isTradingDay(cand, holidays)) return cand;
  }
  return null;
}

// 人民币份额的当日聚合（与页面同一口径）：按「公司 + 基金名」成组，组内任一可买即算开门，
// 可买份额的单日上限相加为可投总额。scrape.mjs 的 fetch-meta.runs[] 也用它，避免两处口径漂移。
// ★ 必须传 indexKey：两个指数的份额混算会得出「24 家开门」这种既不是纳指也不是标普的数。
export function aggregateCny(funds, pointByCode, indexKey = NDX) {
  const groups = new Map();
  for (const f of fundsOfIndex(funds, indexKey)) {
    if (f.currency !== 'CNY') continue;
    const key = `${f.company}|${f.baseName}`;
    if (!groups.has(key)) groups.set(key, { buyable: false, total: 0 });
    const g = groups.get(key);
    for (const c of f.codes) {
      const p = pointByCode[c.code];
      if (!p) continue;
      if (p.status === 'OPEN' || p.status === 'LIMITED') {
        g.buyable = true;
        if (p.limit != null) g.total += p.limit;
      }
    }
  }
  const arr = [...groups.values()];
  return { opened: arr.filter((g) => g.buyable).length, total: arr.reduce((a, g) => a + g.total, 0), families: arr.length };
}

/** 指定日期的人民币聚合（history 里每只基金取该日那条）。 */
export function summarizeDay(funds, history, date, indexKey = NDX) {
  const pts = {};
  for (const code in history) {
    const arr = history[code];
    if (!Array.isArray(arr)) continue;
    const hit = arr.find((d) => d.date === date);
    if (hit) pts[code] = hit;
  }
  return aggregateCny(funds, pts, indexKey);
}

// 一条变化 → 一行文案。页面、早报、下午报共用一套说法，避免「限大额 10 元」与
// 「限 10 元」两种写法在不同地方各说一遍。
export function formatChangeLine(c) {
  switch (c.kind) {
    case 'opened':
      return `✅ 开门：${c.name}${c.to.limit != null ? `（限 ${c.to.limit}元）` : ''}`;
    case 'stopped':
      return `⛔ 暂停：${c.name}`;
    case 'limit-up':
      return `🔺 额度上调：${c.name}（${c.from.limit}元→${c.to.limit}元）`;
    case 'limit-down':
      return `🔻 额度下调：${c.name}（${c.from.limit}元→${c.to.limit}元）`;
    case 'limit-set':
      return `🔒 新限额：${c.name}（${c.to.limit}元）`;
    case 'limit-clear':
      return `🔓 取消限额：${c.name}`;
    case 'unknown':
      return `❓ 数据待核验：${c.name}`;
    default:
      return `• ${c.name}`;
  }
}

// ── 日报正文 ──
// edition=morning：早报（07:50 抓、08:10 发），说明当天开盘前的情况；
// edition=close ：下午报（14:30 抓、14:45 发），收盘前最后一次刷新——
//   这个时点才是「今天还能不能下单」的答案（场外 15:00 截止），所以它先给当日快照，
//   再给「较昨日」，最后给「较今晨」，让读者一眼看出上午到现在有没有变。
export function buildDailyDigest({ edition = 'morning' } = {}) {
  // 早报只发纳指：标普500 有自己的站内页面。两个指数混进一封邮件，
  // 「17 家开门」就既不是纳指也不是标普的数了。
  const funds = fundsOfIndex(readJson('funds.json', { funds: [] }).funds, NDX);
  const history = readJson('history.json', {});
  const meta = readJson('fund-meta.json', {});
  const fetchMeta = readJson('fetch-meta.json', {});
  const isClose = edition === 'close';

  if (!Object.keys(history).length) {
    return { healthy: false, noChange: true, date: '', subject: '纳指开门日报', text: 'ℹ 暂无抓取历史，日报暂缓。', changes: [] };
  }

  const coverage = computeCoverage(funds, meta);
  const date = latestDate(history);

  if (coverage < MIN_COVERAGE) {
    return {
      healthy: false,
      noChange: true,
      coverage,
      date,
      subject: '纳指开门日报 · 数据暂缓',
      text: `⚠️ 今日数据抓取覆盖率 ${(coverage * 100).toFixed(1)}% 低于阈值 ${(MIN_COVERAGE * 100).toFixed(0)}%，日报暂缓，明日恢复。`,
      changes: [],
    };
  }

  const changes = [];
  let prevDate = null;
  for (const f of funds) {
    if (f.currency === 'USD') continue;
    for (const c of f.codes) {
      const arr = history[c.code];
      if (!arr || arr.length < 2) continue;
      if (!prevDate) prevDate = arr[arr.length - 2].date;
      const to = arr[arr.length - 1];
      const from = arr[arr.length - 2];
      const kind = classifyChange(from, to);
      if (kind === 'other') continue;
      const name = (meta[c.code] && meta[c.code].name) || `${f.company}${f.baseName}${c.cls}类`;
      changes.push({ name, from, to, kind });
    }
  }

  changes.sort((a, b) => kindOrder(a.kind) - kindOrder(b.kind) || a.name.localeCompare(b.name));

  const opened = changes.filter((c) => c.kind === 'opened').length;
  const stopped = changes.filter((c) => c.kind === 'stopped').length;
  const limitChanged = changes.filter((c) => ['limit-up', 'limit-down', 'limit-set', 'limit-clear'].includes(c.kind)).length;

  const lines = changes.map(formatChangeLine);
  const deltaLine = `较 ${prevDate}：${opened} 家开门 · ${stopped} 家暂停 · ${limitChanged} 家额度变动`;
  const head = isClose ? `【纳指开门日报 · ${date} 收盘前】` : `【纳指开门日报 · ${date}】`;
  const blocks = [head];

  // 下午报先给当日快照：读者此刻只关心「现在还能买多少」
  const runs = Array.isArray(fetchMeta.runs) ? fetchMeta.runs : [];
  const slotTime = (slot) => runs.find((r) => r.slot === slot)?.time || null;
  const dataTime = slotTime('close') || slotTime('morning') || null;
  if (isClose) {
    const agg = summarizeDay(funds, history, date, NDX);
    blocks.push(`收盘前：${agg.opened} 家开门 · 合计 ${agg.total} 元可投${dataTime ? `（${dataTime} 抓取）` : ''}`);
  }

  blocks.push(changes.length ? `${deltaLine}\n\n${lines.join('\n')}` : `${deltaLine.replace(/：.*$/, '：今日无变化，所有纳指 QDII 额度状态与昨日一致。')}`);

  if (isClose) {
    // 较今晨：history 只留当日最后一个点，早间值只存在 fetch-meta.runs[] 里
    const closeRun = runs.find((r) => r.slot === 'close');
    const intraday = Array.isArray(closeRun?.changed) ? closeRun.changed : [];
    const morningTime = slotTime('morning');
    // 早间那次正常在 07:5x；手动补跑可能落在任何时刻，那就别叫「今晨」
    const prevLabel = !morningTime
      ? '较同日上一次运行'
      : morningTime < '12:00'
        ? `较今晨 ${morningTime}`
        : `较同日 ${morningTime}`;
    if (intraday.length) {
      const intr = intraday
        .map((c) => {
          const kind = classifyChange(c.from, c.to);
          const name = (meta[c.code] && meta[c.code].name) || c.code;
          return formatChangeLine({ name, from: c.from, to: c.to, kind });
        })
        .join('\n');
      blocks.push(`${prevLabel}：${intraday.length} 处变化\n\n${intr}`);
    } else if (morningTime) {
      blocks.push(`${prevLabel}：没有变化。`);
    }
    blocks.push('15:00 前下单按今日净值。明早 08:10 再报。');
  } else {
    blocks.push('额度盘中可能调整（多为当日公告生效），收盘前 14:45 会再发一次当日最终额度。');
  }

  const text = blocks.join('\n\n');
  const subject = isClose ? `纳指开门日报 · ${date} 收盘前` : `纳指开门日报 · ${date}`;

  return { healthy: true, noChange: changes.length === 0, coverage, date, prevDate, subject, text, changes, edition };
}
