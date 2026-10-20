// ──────────────────────────────────────────────────────────────
// 交易日判定内核（双市场四态）
//
// 为什么不能只用 A 股日历：QDII 申购要「沪、纽两地同时开门」。
//   · A 股休市 → 代销平台不接单（周末、国内法定假日）
//   · 美股休市 → 平台照常营业，但基金按境外收盘价估值、当日无法申购
//     （基金合同里「境外主要市场休市日暂停申购」，一年 7 天，全部落在周一到周五）
// 旧实现只有一个 boolean，第二种情况被静默当成「交易日」。
//
// 数据来源（全部是仓库里的静态 JSON，构建期零联网、零依赖）：
//   data/market-holidays.json          A 股法定休市日（日期唯一来源）
//   data/calendars/cn-coverage.json    A 股覆盖到哪些年、哪年可靠
//   data/calendars/us-nasdaq.json      美股交易日白名单 + 休市日名称（由 scripts/build-us-calendar.mjs 生成）
//
// 关键设计：白名单 + 三态。日历没覆盖到的日期返回 UNKNOWN，绝不默认「开市」——
// 漏一条的后果是「这天不发日报」，而不是「发一份错的」。
// ──────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { dowOf, shiftDate } from './dates';

const DATA_DIR = path.join(process.cwd(), 'data');

function readJson<T>(rel: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, rel), 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export interface UsHoliday {
  date: string;
  name: string;
  nameZh: string;
}

interface UsCalendar {
  coveredFrom: string;
  coveredTo: string;
  verifiedThrough: string;
  extrapolatedFrom: string;
  closed: UsHoliday[];
  days: string[];
}

interface CnCoverage {
  years: Record<string, { status: 'official' | 'provisional'; basis: string }>;
}

const CN_HOLIDAYS = new Set<string>(readJson<string[]>('market-holidays.json', []));
const CN_COVERAGE = readJson<CnCoverage>('calendars/cn-coverage.json', { years: {} });
const US = readJson<UsCalendar>('calendars/us-nasdaq.json', {
  coveredFrom: '',
  coveredTo: '',
  verifiedThrough: '',
  extrapolatedFrom: '',
  closed: [],
  days: [],
});
const US_DAYS = new Set<string>(US.days);
const US_CLOSED = new Map<string, UsHoliday>(US.closed.map((h) => [h.date, h]));

// ── 单市场开闭市（null = 覆盖不到，不知道）─────────────────────────────────

/** 沪深是否开市。年份不在 cn-coverage 里 → null（不猜）。 */
export function cnOpen(date: string): boolean | null {
  const y = date.slice(0, 4);
  if (!CN_COVERAGE.years[y]) return null;
  const dow = dowOf(date);
  if (dow === 0 || dow === 6) return false;
  return !CN_HOLIDAYS.has(date);
}

/** 纳斯达克是否开市。只认白名单；落在覆盖区间外 → null。 */
export function usOpen(date: string): boolean | null {
  if (!US.coveredFrom || date < US.coveredFrom || date > US.coveredTo) return null;
  return US_DAYS.has(date);
}

// ── 四态 ────────────────────────────────────────────────────────────────────

export type DayState =
  | 'TRADING' // 两市都开：今晚可申购
  | 'US_CLOSED' // 美股假日而 A 股开市：平台开着，但买不了
  | 'CN_CLOSED' // 国内休市：没有日报可发
  | 'BOTH_CLOSED' // 两头都休
  | 'UNKNOWN'; // 日历覆盖不到

export const STATE_LABEL: Record<DayState, string> = {
  TRADING: '开市',
  US_CLOSED: '美股休市',
  CN_CLOSED: '休市',
  BOTH_CLOSED: '两市休市',
  UNKNOWN: '未知',
};

export interface DayInfo {
  date: string;
  day: number; // 几号
  dow: number; // 0=周日 … 6=周六
  weekend: boolean;
  state: DayState;
  cnOpen: boolean | null;
  usOpen: boolean | null;
  usHoliday: string | null; // 中文假日名（含「补休」）
  cnHoliday: boolean; // 是否落在 A 股法定休市日（区别于周末）
  provisional: boolean; // 该年 A 股日历是预排
  title: string; // 悬浮/无障碍说明
}

const WEEK_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function dayInfo(date: string): DayInfo {
  const dow = dowOf(date);
  const usHol = US_CLOSED.get(date) ?? null;
  const co = cnOpen(date);
  const uo = usOpen(date);

  let state: DayState;
  if (co === null || uo === null) state = 'UNKNOWN';
  else if (co && uo) state = 'TRADING';
  else if (co && !uo) state = 'US_CLOSED';
  else if (!co && uo) state = 'CN_CLOSED';
  else state = 'BOTH_CLOSED';

  const day = Number(date.slice(8, 10));
  const md = `${Number(date.slice(5, 7))}月${day}日`;

  let detail: string;
  if (state === 'UNKNOWN') detail = '日历未覆盖，不做判断';
  else if (state === 'TRADING') detail = '两市开市，可申购';
  else if (state === 'US_CLOSED') detail = `A 股开市，但美股休市（${usHol?.nameZh ?? '美股假日'}），QDII 当日不开放申购`;
  else if (state === 'CN_CLOSED') detail = 'A 股休市，无日报';
  else detail = `两市同时休市${usHol ? `（${usHol.nameZh}）` : ''}`;

  return {
    date,
    day,
    dow,
    weekend: dow === 0 || dow === 6,
    state,
    cnOpen: co,
    usOpen: uo,
    usHoliday: usHol?.nameZh ?? null,
    cnHoliday: CN_HOLIDAYS.has(date),
    provisional: CN_COVERAGE.years[date.slice(0, 4)]?.status === 'provisional',
    title: `${md} ${WEEK_ZH[dow]} · ${detail}`,
  };
}

/** 这一天是不是「可以申购」的日子（页面各处判定统一用这个）。 */
export function isBuyableDay(date: string): boolean {
  return dayInfo(date).state === 'TRADING';
}

// ── 月视图 ──────────────────────────────────────────────────────────────────

export interface MonthGrid {
  year: number;
  month: number; // 1-12
  label: string; // 「2026 年 10 月」
  shortLabel: string; // 「10 月」
  /** 每行 7 格，周一起；月首月尾用 null 补齐 */
  weeks: (DayInfo | null)[][];
  tradeCount: number; // 本月可申购天数（两市都开）—— 比「休市几天」更有用
  closedCount: number; // 本月 A 股休市天数
  usClosedCount: number; // 本月「美股休市而 A 股开市」天数（= 让人措手不及的那几天）
  provisional: boolean;
  unknown: boolean; // 整月不在覆盖区间
}

export function monthGrid(year: number, month: number): MonthGrid {
  const pad = (n: number) => String(n).padStart(2, '0');
  const first = `${year}-${pad(month)}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();

  const cells: (DayInfo | null)[] = [];
  const lead = (dowOf(first) + 6) % 7; // 周一为一周之始
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= lastDay; d++) cells.push(dayInfo(`${year}-${pad(month)}-${pad(d)}`));
  while (cells.length % 7 !== 0) cells.push(null);

  const weeks: (DayInfo | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

  const days = cells.filter((c): c is DayInfo => c !== null);
  return {
    year,
    month,
    label: `${year} 年 ${month} 月`,
    shortLabel: `${month} 月`,
    weeks,
    tradeCount: days.filter((d) => d.state === 'TRADING').length,
    closedCount: days.filter((d) => d.cnOpen === false).length,
    usClosedCount: days.filter((d) => d.state === 'US_CLOSED').length,
    provisional: days.some((d) => d.provisional),
    unknown: days.every((d) => d.state === 'UNKNOWN'),
  };
}

/** 从某天所在月起，连续 n 个自然月。 */
export function monthGridsFrom(fromDate: string, n: number): MonthGrid[] {
  let y = Number(fromDate.slice(0, 4));
  let m = Number(fromDate.slice(5, 7));
  const out: MonthGrid[] = [];
  for (let i = 0; i < n; i++) {
    out.push(monthGrid(y, m));
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

// ── 未来「美股休市」明细（页面上要单独列出来的那几天）───────────────────────

export interface UpcomingClosure {
  date: string;
  md: string; // 11月26日
  week: string; // 周四
  nameZh: string;
  daysAway: number; // 距今天数
}

/** 从 from 起（不含当天之前的）往后 n 个月，列出「美股休市而 A 股开市」的日子。 */
export function upcomingUsClosures(fromDate: string, months: number): UpcomingClosure[] {
  const out: UpcomingClosure[] = [];
  const end = shiftDate(fromDate, months * 31);
  const t0 = Date.parse(`${fromDate}T00:00:00Z`);
  for (let d = fromDate; d <= end; d = shiftDate(d, 1)) {
    const info = dayInfo(d);
    if (info.state !== 'US_CLOSED' || !info.usHoliday) continue;
    out.push({
      date: d,
      md: `${Number(d.slice(5, 7))}月${Number(d.slice(8, 10))}日`,
      week: WEEK_ZH[info.dow],
      nameZh: info.usHoliday,
      daysAway: Math.round((Date.parse(`${d}T00:00:00Z`) - t0) / 86400000),
    });
  }
  return out;
}

// ── 口径元信息（页面「判定口径」小字用）────────────────────────────────────

export const CALENDAR_META = {
  usCoveredFrom: US.coveredFrom,
  usCoveredTo: US.coveredTo,
  /** 这段以内有 NYSE 官方公告背书，之后是规则外推 */
  usVerifiedThrough: US.verifiedThrough,
  usExtrapolatedFrom: US.extrapolatedFrom,
  cnYears: Object.keys(CN_COVERAGE.years).sort(),
  cnProvisionalYears: Object.keys(CN_COVERAGE.years)
    .filter((y) => CN_COVERAGE.years[y].status === 'provisional')
    .sort(),
  usHolidayCount: US.closed.length,
};
