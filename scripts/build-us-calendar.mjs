#!/usr/bin/env node
/**
 * 生成纳斯达克（NYSE/Nasdaq 共用）交易日历。
 *
 * 为什么自算而不用第三方包：美股假日是 10 条规则，规则十年不变；
 * 而权威公告本身（NYSE 官网一次公布未来三年）就是最好的测试夹具。
 * 自算 + 用官方抄录逐日断言，比任何第三方实现的「信任」都硬。
 *
 * 流程：
 *   1. 读 data/calendars/nyse-official.json（手工抄录的 2026–2028 官方休市日）
 *   2. 按规则自算 2025–2036（跨年 observed 会被归到实际落地的年份）
 *   3. 断言 2026–2028 与官方【逐日相等】——不是「包含」，是多一天少一天都失败
 *   4. 通过后写出 data/calendars/us-nasdaq.json
 *
 * 用法：
 *   node scripts/build-us-calendar.mjs          # 生成并写文件
 *   node scripts/build-us-calendar.mjs --check  # 只校验，不写文件（CI 用）
 *
 * 退出码：0 成功 / 1 断言失败（不写文件）
 *
 * 维护动作：每年秋季 NYSE 发新三年公告后，把 nyse-official.json 往前推一年，
 * 重跑本脚本；旧年份可以保留（它们已经成为历史事实）。
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const OFFICIAL = path.join(ROOT, 'data/calendars/nyse-official.json');
const OUTPUT = path.join(ROOT, 'data/calendars/us-nasdaq.json');

// 生成区间：起点与「本项目第一份数据」对齐，终点取十年，够用且不必每年重跑
const COVERED_FROM = '2026-01-01';
const COVERED_TO = '2035-12-31';

const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};

// ── 日期小工具（全部用 UTC，避免构建机时区把日期推前/推后一天）──────────────
const DAY = 86400000;
const utc = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
const addDays = (dt, n) => new Date(dt.getTime() + n * DAY);
const fmt = (dt) => dt.toISOString().slice(0, 10);
const dow = (dt) => dt.getUTCDay(); // 0=周日 … 6=周六

/** 某月第 n 个星期 w（w：0=周日） */
function nthWeekday(y, m, w, n) {
  const first = utc(y, m, 1);
  const offset = (w - dow(first) + 7) % 7;
  return addDays(first, offset + (n - 1) * 7);
}

/** 某月最后一个星期 w */
function lastWeekday(y, m, w) {
  const last = new Date(Date.UTC(y, m, 0)); // 上个月最后一天 → 当月最后一天
  const offset = (dow(last) - w + 7) % 7;
  return addDays(last, -offset);
}

/** 复活节（Meeus/Jones/Butcher 算法），用于推耶稣受难日 */
function easterSunday(y) {
  const a = y % 19;
  const b = Math.floor(y / 100);
  const c = y % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return utc(y, month, day);
}

/**
 * 固定日期假日的 observed 规则：周六提前到周五，周日顺延到周一。
 * shiftSaturday=false 用于元旦——元旦遇周六【不补】，这与圣诞/六月节相反。
 */
function observed(dt, shiftSaturday = true) {
  const w = dow(dt);
  if (w === 6) return shiftSaturday ? addDays(dt, -1) : null;
  if (w === 0) return addDays(dt, 1);
  return dt;
}

// ── 十条规则 ────────────────────────────────────────────────────────────────
// nameZh 用大陆常见译名；observed 的补休在原名称后加「补休」
function holidaysOf(y) {
  const out = [];

  const push = (dt, name, nameZh, shifted) => {
    if (!dt) return;
    out.push({ date: fmt(dt), name: shifted ? `${name} (observed)` : name, nameZh: shifted ? `${nameZh}补休` : nameZh });
  };

  // 1. 元旦：遇周日顺延，遇周六不补
  const ny = utc(y, 1, 1);
  const nyObs = observed(ny, false);
  push(nyObs, "New Year's Day", '元旦', nyObs && fmt(nyObs) !== fmt(ny));

  // 2. 马丁·路德·金日：1 月第三个周一
  push(nthWeekday(y, 1, 1, 3), 'Martin Luther King, Jr. Day', '马丁·路德·金日', false);

  // 3. 总统日：2 月第三个周一
  push(nthWeekday(y, 2, 1, 3), "Washington's Birthday", '总统日', false);

  // 4. 耶稣受难日：复活节前的周五
  push(addDays(easterSunday(y), -2), 'Good Friday', '耶稣受难日', false);

  // 5. 阵亡将士纪念日：5 月最后一个周一
  push(lastWeekday(y, 5, 1), 'Memorial Day', '阵亡将士纪念日', false);

  // 6. 六月节：6-19
  const jt = utc(y, 6, 19);
  push(observed(jt), 'Juneteenth National Independence Day', '六月节', fmt(observed(jt)) !== fmt(jt));

  // 7. 独立日：7-4
  const id = utc(y, 7, 4);
  push(observed(id), 'Independence Day', '独立日', fmt(observed(id)) !== fmt(id));

  // 8. 劳动节：9 月第一个周一
  push(nthWeekday(y, 9, 1, 1), 'Labor Day', '劳动节', false);

  // 9. 感恩节：11 月第四个周四
  push(nthWeekday(y, 11, 4, 4), 'Thanksgiving Day', '感恩节', false);

  // 10. 圣诞：12-25
  const xm = utc(y, 12, 25);
  push(observed(xm), 'Christmas Day', '圣诞节', fmt(observed(xm)) !== fmt(xm));

  return out;
}

// ── 1. 读官方金标准 ─────────────────────────────────────────────────────────
if (!fs.existsSync(OFFICIAL)) fail(`缺少官方金标准文件：${OFFICIAL}`);
const official = JSON.parse(fs.readFileSync(OFFICIAL, 'utf8'));
const officialYears = Object.keys(official.years || {}).map(Number).sort();
if (!officialYears.length) fail('官方金标准里没有任何年份');

// ── 2. 自算 ─────────────────────────────────────────────────────────────────
// 年份范围要同时盖住「官方金标准年份」和「覆盖区间」：多算前后各一年，
// 跨年的 observed（如 2032-12-25 周六 → 12-24）才能落到正确年份。
const YEAR_FROM = Math.min(...officialYears, new Date(`${COVERED_FROM}T00:00:00Z`).getUTCFullYear()) - 1;
const YEAR_TO = Math.max(...officialYears, new Date(`${COVERED_TO}T00:00:00Z`).getUTCFullYear()) + 1;
const byYear = new Map();
for (let y = YEAR_FROM; y <= YEAR_TO; y++) {
  for (const h of holidaysOf(y)) {
    const yy = Number(h.date.slice(0, 4));
    if (!byYear.has(yy)) byYear.set(yy, []);
    byYear.get(yy).push(h);
  }
}
for (const arr of byYear.values()) arr.sort((a, b) => a.date.localeCompare(b.date));

// ── 3. 与官方逐日断言 ───────────────────────────────────────────────────────
let bad = 0;
for (const y of officialYears) {
  const want = official.years[y].map((h) => h.date).sort();
  const got = (byYear.get(y) || []).map((h) => h.date);

  if (got.length !== want.length) {
    console.error(`   ${y}：自算 ${got.length} 天 / 官方 ${want.length} 天`);
  }

  const missing = want.filter((d) => !got.includes(d)); // 官方有、自算漏
  const extra = got.filter((d) => !want.includes(d)); // 自算多、官方无

  if (missing.length || extra.length) {
    bad++;
    if (missing.length) console.error(`✗ ${y} 自算漏了：${missing.join(', ')}`);
    if (extra.length) console.error(`✗ ${y} 自算多出：${extra.join(', ')}`);
  }
  // 官方日期本身必须都是工作日（抄错了会出现周末）
  for (const d of official.years[y]) {
    if ([0, 6].includes(dow(new Date(`${d.date}T00:00:00Z`))))
      console.error(`✗ 官方金标准里 ${d.date} 是周末，抄录有误`);
  }
}

if (bad) fail(`自算结果与 NYSE 官方公告有 ${bad} 年不一致，已中止（未写文件）`);
console.log(
  `✓ 自算与官方逐日一致：${officialYears.map((y) => `${y} ${official.years[y].length} 天`).join(' / ')}`
);

// ── 4. 铺交易日白名单 ───────────────────────────────────────────────────────
// 只存交易日（白名单）：漏一条的后果是「判成 UNKNOWN、当天不发」，而不是「照常发假数据」。
const from = new Date(`${COVERED_FROM}T00:00:00Z`);
const to = new Date(`${COVERED_TO}T00:00:00Z`);
const closedAll = [];
for (let y = from.getUTCFullYear(); y <= to.getUTCFullYear(); y++) {
  for (const h of byYear.get(y) || []) closedAll.push(h);
}
closedAll.sort((a, b) => a.date.localeCompare(b.date));
const closedSet = new Set(closedAll.map((h) => h.date));

const days = [];
for (let dt = from; dt <= to; dt = addDays(dt, 1)) {
  const w = dow(dt);
  if (w === 0 || w === 6) continue;
  const s = fmt(dt);
  if (closedSet.has(s)) continue;
  days.push(s);
}

// 产物自检：升序、无重复、无周末、不含休市日
for (let i = 1; i < days.length; i++) {
  if (days[i] <= days[i - 1]) fail(`交易日列表未升序或有重复：${days[i - 1]} → ${days[i]}`);
}
for (const s of days) {
  if (closedSet.has(s)) fail(`交易日列表里混进了休市日：${s}`);
  if ([0, 6].includes(dow(new Date(`${s}T00:00:00Z`)))) fail(`交易日列表里混进了周末：${s}`);
}
const insideClosed = closedAll.filter((h) => h.date >= COVERED_FROM && h.date <= COVERED_TO);
if (closedAll.length !== insideClosed.length) {
  const out = closedAll.filter((h) => !insideClosed.includes(h));
  fail(`休市日落在覆盖区间外：${out.map((h) => h.date).join(', ')}（跨年的 observed 需要人工确认）`);
}

const verifiedThrough = `${Math.max(...officialYears)}-12-31`;
const payload = {
  market: 'us-nasdaq',
  generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  source: '自算规则（NYSE/Nasdaq 共用假日表 + Meeus 复活节 + observed 规则）',
  officialSource: official.source,
  officialTranscribedAt: official.transcribedAt,
  coveredFrom: COVERED_FROM,
  coveredTo: COVERED_TO,
  verifiedThrough,
  extrapolatedFrom: `${Math.max(...officialYears) + 1}-01-01`,
  note: '只判开/闭市，不含 13:00 早收盘；早收盘日仍是交易日，不影响当日能否申购。',
  closed: insideClosed,
  days,
};

if (process.argv.includes('--check')) {
  // 只校验：已有产物必须与本次自算完全一致，否则说明有人手改了文件
  if (!fs.existsSync(OUTPUT)) fail(`--check 模式下产物不存在：${OUTPUT}`);
  const prev = JSON.parse(fs.readFileSync(OUTPUT, 'utf8'));
  if (JSON.stringify(prev.days) !== JSON.stringify(days) || JSON.stringify(prev.closed) !== JSON.stringify(insideClosed))
    fail('产物与自算结果不一致，请重跑生成（不要手改 data/calendars/us-nasdaq.json）');
  console.log(`✓ 产物一致：${days.length} 个交易日 / ${insideClosed.length} 个休市日`);
  process.exit(0);
}

fs.writeFileSync(OUTPUT, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
console.log(
  `✓ 已写出 ${path.relative(ROOT, OUTPUT)}：${COVERED_FROM} ~ ${COVERED_TO}，` +
    `${days.length} 个交易日 / ${insideClosed.length} 个休市日，` +
    `官方背书至 ${verifiedThrough}`
);
