// 每日日报构建模块：读取 data/，计算人民币覆盖率与「今日 vs 昨日」变化，
// 产出要发送的标题与正文。管理员通知（notify.mjs）、订阅群发（send.mjs）与发信门禁
// （check-freshness.mjs）共用本模块，保证三者口径一致、不会漂移。
//
// 设计对齐 scrape 门禁：覆盖率低于阈值视为数据不完整（healthy=false），调用方据此不发送误导内容。
// 「无变化」也产出文本（含「今日无变化」说明），由 broadcast 决定仍群发。
//
// ⚠ 版次命名（2026-10-23 更正）：生产每天只发**一封**，时点 14:45，是**收盘前报**——
//   场外申购 15:00 截止，这一封回答的是「今天还能不能下单」。edition=close 为默认值。
//   edition=morning 是**盘前报**（无调度，只在人工补发时用），不是「早报」的俗称来源。
//   两处措辞别再混：正文里「早上 8 点」「明早 08:10 再报」这类说法一律不许出现。
//
// 依赖：仅 Node 22 内置。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'data');

export const MIN_COVERAGE = Number(process.env.SCRAPE_MIN_COVERAGE ?? 0.9);

// 分指数口径（2026-10-23 起 funds.json 里有纳指100 与标普500 两个 indexKey）。
// ★ 所有聚合都必须显式带 indexKey：省略 = 纳指（页面/小程序/管理员通知的既有契约）。
//   不存在「不分指数的全量聚合」这种用法——那会静默把两个指数的额度加在一起。
//   与 src/data/loader.ts 的 NDX / SP500 常量必须逐字一致。
export const NDX = '纳斯达克100';
export const SP500 = '标普500';
export const INDEX_KEYS = [NDX, SP500];

// 邮件里给人看的短名（indexKey 本身太长，标题会被邮箱客户端截断）。
export const INDEX_LABEL = { [NDX]: '纳指100', [SP500]: '标普500' };

// 版次：close=收盘前报（生产唯一在发的那封）；morning=盘前报（人工补发用，无调度）。
export const DEFAULT_EDITION = 'close';
export const EDITIONS = ['close', 'morning'];
export const EDITION_LABEL = { close: '收盘前', morning: '盘前' };

export const indexLabel = (indexKey) => INDEX_LABEL[indexKey] || indexKey;

/** 按指数过滤 funds.json 条目。indexKey 省略时原样返回（调用方自己去保证语义）。 */
export function fundsOfIndex(funds, indexKey) {
  if (!indexKey) return funds;
  return funds.filter((f) => f.indexKey === indexKey);
}

/** 某个指数名下的全部份额代码。发信门禁与分指数日报都用它把 history 收窄。 */
export function codesOfIndex(funds, indexKey) {
  const set = new Set();
  for (const f of fundsOfIndex(funds, indexKey)) for (const c of f.codes) set.add(c.code);
  return set;
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
//   发信门禁会放行一封用昨天纳指数据拼出来的日报。
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
// indexKey 默认纳指：调用方大多只关心纳指，而「不传 = 纳指」是本仓库的既有契约。
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

// 一条变化 → 一行文案。页面、日报、盘前报共用一套说法，避免「限大额 10 元」与
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

// ── 发信门禁：分指数判新鲜度与覆盖率 ──
// 为什么必须分指数：两个指数各抓各的，标普500 抓失败不该让纳指的日报停发，
// 反过来标普500 抓成功也不该给纳指的旧数据背书（以前 latestDate 不传 codes，
// 标普500 有今天的点就让整轮门禁通过，纳指的旧数据被当成今天的发出去）。
export function evaluateFreshness({ funds, history, meta, today, holidays }) {
  const trading = isTradingDay(today, holidays);
  const expected = trading ? today : prevTradingDay(today, holidays);
  const out = {};
  for (const indexKey of INDEX_KEYS) {
    const codes = codesOfIndex(funds, indexKey);
    const date = latestDate(history, codes);
    const coverage = computeCoverage(funds, meta, indexKey);
    const problems = [];
    if (!date) problems.push('no-history');
    else if (date !== expected) problems.push('stale');
    if (coverage < MIN_COVERAGE) problems.push('coverage');
    out[indexKey] = {
      indexKey,
      codes: codes.size,
      date,
      expected,
      trading,
      coverage,
      fresh: !!date && date === expected,
      covered: coverage >= MIN_COVERAGE,
      healthy: problems.length === 0,
      problems,
    };
  }
  return { today, trading, expected, byIndex: out, allHealthy: INDEX_KEYS.every((k) => out[k].healthy) };
}

// ── 单指数日报 ──
// edition=close（默认）：收盘前报（14:45 发）。场外 15:00 截止，这一封才是「今天还能不能下单」
//   的答案，所以它先给当日快照，再给「较上一交易日」，最后给「较盘前」。
// edition=morning：盘前报（无调度，人工补发用）。只说明当天开盘前的情况。
//
// 返回里的 parts 是给「多指数合并成一封」用的原料：head / blocks / footer 分开存，
// 单指数直发时 text = [head, ...blocks, footer]，多指数时共用一个 head 与一个 footer。
export function buildDailyDigest({ edition = DEFAULT_EDITION, indexKey = NDX } = {}) {
  const label = indexLabel(indexKey);
  const ed = edition === 'morning' ? 'morning' : 'close';
  const edLabel = EDITION_LABEL[ed];
  const isClose = ed === 'close';

  const funds = fundsOfIndex(readJson('funds.json', { funds: [] }).funds, indexKey);
  const history = readJson('history.json', {});
  const meta = readJson('fund-meta.json', {});
  const fetchMeta = readJson('fetch-meta.json', {});
  const codes = codesOfIndex(funds, indexKey);

  const base = { edition: ed, indexKey, label };

  if (!Object.keys(history).length) {
    return { ...base, healthy: false, noChange: true, date: '', subject: `${label} 开门日报`, text: `ℹ 暂无抓取历史，日报暂缓。`, changes: [] };
  }

  const coverage = computeCoverage(funds, meta, indexKey);
  const date = latestDate(history, codes);

  if (!date || coverage < MIN_COVERAGE) {
    const why = !date
      ? `${label} 还没有任何抓取记录`
      : `今日${label}数据抓取覆盖率 ${(coverage * 100).toFixed(1)}% 低于阈值 ${(MIN_COVERAGE * 100).toFixed(0)}%`;
    return {
      ...base,
      healthy: false,
      noChange: true,
      coverage,
      date: date || '',
      subject: `${label} 开门日报 · 数据暂缓`,
      text: `⚠️ ${why}，本期暂缓，下期恢复。`,
      changes: [],
    };
  }

  const changes = [];
  const prevDates = [];
  for (const f of funds) {
    if (f.currency === 'USD') continue;
    for (const c of f.codes) {
      const arr = history[c.code];
      if (!arr || arr.length < 2) continue;
      const to = arr[arr.length - 1];
      const from = arr[arr.length - 2];
      if (to.date === date) prevDates.push(from.date);
      const kind = classifyChange(from, to);
      if (kind === 'other') continue;
      const name = (meta[c.code] && meta[c.code].name) || `${f.company}${f.baseName}${c.cls}类`;
      changes.push({ name, from, to, kind });
    }
  }

  changes.sort((a, b) => kindOrder(a.kind) - kindOrder(b.kind) || a.name.localeCompare(b.name));

  // 基准日取「多数份额的上一交易日」而不是「第一只基金的前一天」：某只份额缺过几天时，
  // 第一只的 from.date 可能比别的都早，标题上就会出现一个谁也对不上的日期。
  const prevDate = modeOf(prevDates) || null;

  const opened = changes.filter((c) => c.kind === 'opened').length;
  const stopped = changes.filter((c) => c.kind === 'stopped').length;
  const limitChanged = changes.filter((c) => ['limit-up', 'limit-down', 'limit-set', 'limit-clear'].includes(c.kind)).length;

  const runs = Array.isArray(fetchMeta.runs) ? fetchMeta.runs : [];
  const slotTime = (slot) => runs.find((r) => r.slot === slot)?.time || null;
  const closeTime = slotTime('close');
  const dataTime = closeTime || slotTime('morning') || null;
  // 时刻必须说准：拿盘前那次的数据冒充「收盘前抓取」比不说更糟
  const dataNote = closeTime ? `${closeTime} 抓取` : dataTime ? `${dataTime} 抓取，收盘前那次没跑成` : '';

  const blocks = [];

  // 收盘前报先给当日快照：读者此刻只关心「现在还能买多少」
  if (isClose) {
    const agg = summarizeDay(funds, history, date, indexKey);
    blocks.push(`收盘前：${agg.opened} 家开门 · 合计 ${agg.total} 元可投${dataNote ? `（${dataNote}）` : ''}`);
  }

  // 变化清单：单位是「处」而不是「家」——这里数的是份额，同一家基金的两个份额是两条
  const deltaHead = prevDate
    ? `较 ${prevDate}：${opened} 处开门 · ${stopped} 处暂停 · ${limitChanged} 处额度变动`
    : `本指数首次记录（${date}），暂无上一交易日可比`;
  if (changes.length) blocks.push(`${deltaHead}\n\n${changes.map(formatChangeLine).join('\n')}`);
  else
    blocks.push(
      prevDate
        ? `较 ${prevDate}：今日无变化，${label} QDII 份额的申购状态与额度都和上一交易日一致。`
        : `本指数首次记录（${date}），暂无上一交易日可比。`
    );

  if (isClose) {
    // 较盘前：history 只留当日最后一个点，早间值只存在 fetch-meta.runs[] 里。
    // 纳指读 run.changed；其它指数读 run.byIndex[<indexKey>].changed（scrape 已按指数分好）。
    const closeRun = runs.find((r) => r.slot === 'close');
    const morningTime = slotTime('morning');
    // 没有 close 那次运行就没得比：此时 history 里的点来自更早的时点，
    // 「较盘前 10:16：没有变化」等于自己跟自己比，是句废话（本地 dry-run 常见）。
    if (closeRun) {
      const perRun = indexKey === NDX ? closeRun.changed : closeRun.byIndex?.[indexKey]?.changed;
      const intraday = Array.isArray(perRun) ? perRun : [];
      const prevLabel = !morningTime
        ? '较同日上一次运行'
        : morningTime < '12:00'
          ? `较盘前 ${morningTime}`
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
    }
  }

  const head = `【${label} 开门日报 · ${date} ${edLabel}】`;
  const footer = isClose
    ? '15:00 前下单按今日净值。明天收盘前再报。'
    : '额度盘中可能调整（多为当日公告生效），收盘前 14:45 会再发一次当日最终额度。';
  const subject = `${label} 开门日报 · ${date} ${edLabel}`;

  return {
    ...base,
    healthy: true,
    noChange: changes.length === 0,
    coverage,
    date,
    prevDate,
    subject,
    text: [head, ...blocks, footer].join('\n\n'),
    parts: { head, blocks, footer },
    changes,
    aggDate: date,
  };
}

// ── 把若干指数的日报拼成一封信 ──
// 纯函数：不读文件，只按传入的 digests 装配。订阅偏好裁剪就靠它——
// 只订了标普500 的人，正文里不许出现纳指的任何数字（这就是「按偏好裁剪」的全部含义）。
// 不可用的指数（healthy=false）即使被要求也直接丢掉：宁可少一节，也不发过期的数。
export function composeEmail({ digests, indices }) {
  const want = (Array.isArray(indices) && indices.length ? indices : INDEX_KEYS).filter(
    (k) => digests[k] && digests[k].healthy !== false
  );
  if (!want.length) return { subject: '', text: '', indices: [] };
  if (want.length === 1) {
    const d = digests[want[0]];
    return {
      subject: d.subject,
      text: d.text || [d.parts?.head, ...(d.parts?.blocks || []), d.parts?.footer].filter(Boolean).join('\n\n'),
      indices: want,
    };
  }
  const first = digests[want[0]];
  const date = first.date || '';
  const ed = first.edition || DEFAULT_EDITION;
  const edLabel = EDITION_LABEL[ed] || '';
  const head = `【QDII 开门日报 · ${date} ${edLabel}】`;
  const body = [];
  for (const k of want) {
    const d = digests[k];
    body.push(`━━ ${d.label} ━━`);
    body.push(...(d.parts?.blocks || [d.text]));
  }
  const footer = first.parts?.footer || '';
  return {
    subject: `QDII 开门日报 · ${date} ${edLabel}`,
    text: [head, ...body, footer].filter(Boolean).join('\n\n'),
    indices: want,
  };
}

/** 直接构建一整封（内部逐指数 buildDailyDigest），给不发信但需要正文的场合用。 */
export function buildBroadcastDigest({ edition = DEFAULT_EDITION, indices = INDEX_KEYS } = {}) {
  const digests = {};
  for (const k of INDEX_KEYS) digests[k] = buildDailyDigest({ edition, indexKey: k });
  const usable = (indices || INDEX_KEYS).filter((k) => digests[k] && digests[k].healthy);
  const skipped = INDEX_KEYS.filter((k) => !usable.includes(k)).map((k) => ({
    indexKey: k,
    reason: digests[k]?.text || 'no-digest',
  }));
  const email = composeEmail({ digests, indices: usable.length ? usable : [] });
  return { ...email, edition, digests, usable, skipped, healthy: usable.length > 0 };
}

// 众数（并列时取较晚的日期，保证稳定）
function modeOf(list) {
  if (!list.length) return null;
  const cnt = new Map();
  for (const x of list) cnt.set(x, (cnt.get(x) || 0) + 1);
  let best = null;
  let bestN = -1;
  for (const [k, n] of cnt) {
    if (n > bestN || (n === bestN && k > best)) {
      best = k;
      bestN = n;
    }
  }
  return best;
}
