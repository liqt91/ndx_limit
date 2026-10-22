#!/usr/bin/env node
/**
 * 小程序数据打包：data/*.json → miniprogram/data/bundle.json
 *
 * 为什么要有这一步：
 *   小程序的包内 JSON 是「随版本发布」的，而数据每天变。把数据打进包里，
 *   每更新一次数据就得重新提审一次（审核要几小时到几天），这条链路走不通。
 *   所以数据的真身放在云存储里，这个脚本只负责：
 *     1. 把站上已有的多份 JSON 合成一份小程序用得上的 bundle（少一次请求、少一份重复）
 *     2. 顺带生成一份包内兜底（云开发没配好时小程序也能看到最近一次数据）
 *
 * 口径全部沿用网页版（src/data/loader.ts、src/data/trading-days.ts）：
 *   - 分组：company + baseName + currency
 *   - 只保留交易日（周末 + A 股法定休市）
 *   - 日历四态：TRADING / US_CLOSED / CN_CLOSED / BOTH_CLOSED / UNKNOWN
 * 改口径时两处一起改。
 *
 * 用法：
 *   node scripts/mp-sync.mjs            生成 miniprogram/data/bundle.json
 *   node scripts/mp-sync.mjs --check    只校验，不写文件（CI 用）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const OUT = path.join(ROOT, 'miniprogram', 'data', 'bundle.json');

const CHECK_ONLY = process.argv.includes('--check');

/* ── 读取源数据 ─────────────────────────────────────────────── */

function readJson(rel, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA, rel), 'utf8'));
  } catch {
    return fallback;
  }
}

/* ── 日期工具（纯字符串 + UTC，不碰本地时区） ────────────────── */

function dowOf(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function shiftDate(date, days) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function todayCST() {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const g = (t) => parts.find((p) => p.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}

/* ── A 股日历 ───────────────────────────────────────────────── */

const CN_HOLIDAYS = new Set(readJson('market-holidays.json', []));
const CN_COVERAGE = readJson('calendars/cn-coverage.json', { years: {} });
const CN_NAMES = readJson('calendars/cn-holiday-names.json', { years: {} });
const CN_HOLIDAY_NAME = new Map();
for (const spans of Object.values(CN_NAMES.years || {})) {
  for (const span of spans) {
    for (let d = span.from; d <= span.to; d = shiftDate(d, 1)) CN_HOLIDAY_NAME.set(d, span.name);
  }
}

const US = readJson('calendars/us-nasdaq.json', { coveredFrom: '', coveredTo: '', closed: [], days: [] });
const US_DAYS = new Set(US.days || []);
const US_CLOSED = new Map((US.closed || []).map((h) => [h.date, h]));

function cnOpen(date) {
  const y = date.slice(0, 4);
  if (!CN_COVERAGE.years || !CN_COVERAGE.years[y]) return null;
  const dow = dowOf(date);
  if (dow === 0 || dow === 6) return false;
  return !CN_HOLIDAYS.has(date);
}

function usOpen(date) {
  if (!US.coveredFrom || date < US.coveredFrom || date > US.coveredTo) return null;
  return US_DAYS.has(date);
}

const WEEK_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 与 src/data/trading-days.ts 的 dayInfo 同规则 */
function dayInfo(date) {
  const dow = dowOf(date);
  const usHol = US_CLOSED.get(date) || null;
  const co = cnOpen(date);
  const uo = usOpen(date);

  let state;
  if (co === null || uo === null) state = 'UNKNOWN';
  else if (co && uo) state = 'TRADING';
  else if (co && !uo) state = 'US_CLOSED';
  else if (!co && uo) state = 'CN_CLOSED';
  else state = 'BOTH_CLOSED';

  const weekend = dow === 0 || dow === 6;
  const cnName = CN_HOLIDAY_NAME.get(date) || null;

  let cnReason;
  if (co === null) cnReason = '日历未覆盖';
  else if (co) cnReason = '正常交易';
  else if (cnName) cnReason = `${cnName}假期`;
  else if (weekend) cnReason = '周末';
  else cnReason = '法定假日';

  let usReason;
  if (uo === null) usReason = '日历未覆盖';
  else if (uo) usReason = '正常交易';
  else if (usHol) usReason = usHol.nameZh;
  else if (weekend) usReason = '周末';
  else usReason = '假日';

  return {
    state,
    cnOpen: co,
    usOpen: uo,
    cnReason,
    usReason,
    usHoliday: usHol ? usHol.nameZh : null,
    cnHoliday: CN_HOLIDAYS.has(date),
    weekZh: WEEK_ZH[dow],
    title: `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日 ${WEEK_ZH[dow]}：A 股${
      co === null ? '未知' : co ? '开市' : '休市'
    }·${cnReason}；美股${uo === null ? '未知' : uo ? '开市' : '休市'}·${usReason}`,
  };
}

/* ── 组装 ───────────────────────────────────────────────────── */

function build() {
  const funds = readJson('funds.json', { funds: [] }).funds || [];
  const history = readJson('history.json', {});
  const meta = readJson('fund-meta.json', {});
  const annRaw = readJson('announcements.json', { codes: {} });
  const fetchMeta = readJson('fetch-meta.json', null);
  const overrides = readJson('direct-overrides.json', {});

  // 只保留交易日（与 loader.filterTradingDays 同规则）
  const tradingHistory = {};
  for (const code of Object.keys(history)) {
    const kept = history[code].filter((d) => {
      const dow = dowOf(d.date);
      if (dow === 0 || dow === 6) return false;
      return !CN_HOLIDAYS.has(d.date);
    });
    if (kept.length) tradingHistory[code] = kept;
  }

  // 数据日 = history 里出现的最大日期
  let snapDate = null;
  for (const code of Object.keys(tradingHistory)) {
    for (const d of tradingHistory[code]) {
      if (!snapDate || d.date > snapDate) snapDate = d.date;
    }
  }
  if (!snapDate) snapDate = todayCST();

  // 对比基准日：任一份额的前一天（与 loader.arr_prevDate 同规则）
  let prevDate = null;
  for (const code of Object.keys(tradingHistory)) {
    const arr = tradingHistory[code];
    if (arr && arr.length >= 2) {
      prevDate = arr[arr.length - 2].date;
      break;
    }
  }

  const shares = [];
  for (const f of funds) {
    for (const c of f.codes) {
      const code = c.code;
      const hist = (tradingHistory[code] || []).slice(-30);
      const last = hist[hist.length - 1];
      const status = last ? last.status : 'UNKNOWN';
      const limit = last ? last.limit : null;
      const ov = overrides[code] || {};
      shares.push({
        code,
        name: meta[code]?.name || `${f.company}${f.baseName}${f.currency === 'USD' ? '美元' : ''}${c.cls}类`,
        company: f.company,
        baseName: f.baseName,
        cls: c.cls,
        currency: f.currency,
        status,
        limit,
        limitMissing: status === 'LIMITED' && limit == null,
        minPurchase: limit != null ? (ov.minPurchase ?? 1) : null,
        directLimitText: ov.directLimitText ?? null,
        history: hist.map((d) => ({ d: d.date, s: d.status, l: d.limit })),
      });
    }
  }

  // 公告：只留最近 6 条、3 天内的（页面只认 3 天内）
  const announcements = {};
  for (const code of Object.keys(annRaw.codes || {})) {
    const from = shiftDate(snapDate, -3);
    const list = (annRaw.codes[code] || [])
      .filter((a) => a.date >= from)
      .slice(0, 6)
      .map((a) => ({ date: a.date, kind: a.kind, action: a.action, title: a.title }));
    if (list.length) announcements[code] = list;
  }

  // 日历窗口：过去 60 天 + 未来 400 天
  const calendar = {};
  const today = todayCST();
  for (let i = -60; i <= 400; i++) {
    const d = shiftDate(today, i);
    const info = dayInfo(d);
    calendar[d] = {
      s: info.state,
      cr: info.cnReason,
      ur: info.usReason,
      uh: info.usHoliday,
      w: info.weekZh,
      t: info.title,
    };
  }

  const time = fetchMeta && fetchMeta.fetchedAt ? String(fetchMeta.fetchedAt).match(/T(\d{2}:\d{2})/)?.[1] || null : null;

  // 摘要：给云函数「每日推送」用——它不需要整个 bundle，只要能填进模板的那句话。
  // 这里算一遍首屏口径（与 miniprogram/utils/store.js 的 assemble 独立实现，
  // 两者由 scripts/mp-check.mjs 交叉验证：数字必须完全相等）。
  const summary = buildSummary({ shares, prevDate, snapDate, fetchMeta, time });

  return {
    generatedAt: fetchMeta?.fetchedAt || new Date().toISOString(),
    snapDate,
    prevDate,
    fetch: { time, slot: fetchMeta?.slot || null },
    summary,
    shares,
    announcements,
    calendar,
    holidays: [...CN_HOLIDAYS].sort(),
  };
}

/* ── 首屏摘要（口径见上） ──────────────────────────────────── */

function isBuyable(s) {
  return s === 'LIMITED' || s === 'OPEN';
}

function buildSummary({ shares, prevDate, snapDate, fetchMeta, time }) {
  // 分组：company + baseName + currency
  const groups = new Map();
  for (const s of shares) {
    const key = `${s.company}|${s.baseName}|${s.currency}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  const cny = [...groups.values()].filter((g) => g[0].currency === 'CNY');

  let opened = 0;
  let total = 0;
  for (const g of cny) {
    const any = g.some((s) => isBuyable(s.status));
    if (!any) continue;
    opened++;
    for (const s of g) {
      if (isBuyable(s.status) && s.limit != null) total += s.limit;
    }
  }

  // 变化计数（与网页版 classifyChange 同规则）
  let openedCnt = 0;
  let stoppedCnt = 0;
  let limitCnt = 0;
  for (const s of shares) {
    if (s.currency !== 'CNY') continue;
    const h = s.history;
    if (!h || h.length < 2) continue;
    const to = h[h.length - 1];
    const from = h[h.length - 2];
    const fromBuy = isBuyable(from.s);
    const toBuy = isBuyable(to.s);
    let kind = 'other';
    if (to.s === 'UNKNOWN' && from.s !== 'UNKNOWN') kind = 'unknown';
    else if (!fromBuy && toBuy) kind = 'opened';
    else if (fromBuy && !toBuy) kind = 'stopped';
    else if (fromBuy && toBuy) {
      if (from.l === null && to.l !== null) kind = 'limit-set';
      else if (from.l !== null && to.l === null) kind = 'limit-clear';
      else if (from.l !== null && to.l !== null && from.l !== to.l) {
        kind = to.l > from.l ? 'limit-up' : 'limit-down';
      }
    }
    if (kind === 'opened') openedCnt++;
    else if (kind === 'stopped') stoppedCnt++;
    else if (kind.startsWith('limit')) limitCnt++;
  }

  const parts = [];
  if (openedCnt) parts.push(`${openedCnt} 只开门`);
  if (stoppedCnt) parts.push(`${stoppedCnt} 只暂停`);
  if (limitCnt) parts.push(`${limitCnt} 只调额度`);
  const verdict = parts.length ? parts.join('，') : '没有变化';

  const today = todayCST();
  const co = cnOpen(today);
  const trading = co === null ? false : co;

  let headline;
  if (!trading) {
    headline = '今日休市（非交易日）';
  } else if (opened === 0) {
    headline = `今天 ${cny.length} 家全部暂停`;
  } else if (opened === cny.length) {
    headline = `今天 ${opened} 家全部开门，${total.toLocaleString('zh-CN')}元可投`;
  } else {
    headline = `今天 ${opened} 家开门，${total.toLocaleString('zh-CN')}元可投`;
  }

  const summaryDelta = trading && prevDate ? `较上个交易日（${prevDate}）${verdict}。` : '';
  const updatedLabel = snapDate === today ? '今日' : `${Number(snapDate.slice(5, 7))}月${Number(snapDate.slice(8, 10))}日`;

  return {
    headline,
    summaryDelta,
    updatedLabel,
    updatedTime: time,
    opened,
    total,
    monitored: cny.length,
  };
}

/* ── 主流程 ─────────────────────────────────────────────────── */

const bundle = build();
const text = JSON.stringify(bundle);

if (CHECK_ONLY) {
  const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (cur !== text) {
    console.error('✗ miniprogram/data/bundle.json 与 data/*.json 不同步，请跑 node scripts/mp-sync.mjs');
    process.exit(1);
  }
  console.log('✓ bundle 与 data/ 一致');
  process.exit(0);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, text, 'utf8');

const kb = (Buffer.byteLength(text) / 1024).toFixed(1);
console.log(`✓ 写出 ${path.relative(ROOT, OUT)}`);
console.log(
  `  数据日 ${bundle.snapDate} · 基准日 ${bundle.prevDate || '—'} · 份额 ${bundle.shares.length} · ` +
    `公告 ${Object.keys(bundle.announcements).length} 码 · 日历 ${Object.keys(bundle.calendar).length} 天 · ${kb} KB`
);
