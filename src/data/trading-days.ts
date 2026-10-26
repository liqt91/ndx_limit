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
//   data/calendars/cn-holiday-names.json  A 股休市日的名称（只用于回答「为什么休市」）
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

interface CnHolidayNames {
  years: Record<string, { from: string; to: string; name: string }[]>;
}

const CN_HOLIDAYS = new Set<string>(readJson<string[]>('market-holidays.json', []));
const CN_COVERAGE = readJson<CnCoverage>('calendars/cn-coverage.json', { years: {} });

// 名称按连续区间存，这里展开成 日期→名称。
// 只对 A 股真正休市的工作日有意义；周末落进假期区间时也按假期说（「春节假期」比「周末」更接近事实）。
const CN_NAMES = readJson<CnHolidayNames>('calendars/cn-holiday-names.json', { years: {} });
const CN_HOLIDAY_NAME = new Map<string, string>();
for (const spans of Object.values(CN_NAMES.years)) {
  for (const span of spans) {
    for (let d = span.from; d <= span.to; d = shiftDate(d, 1)) CN_HOLIDAY_NAME.set(d, span.name);
  }
}
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
  md: string; // 「11月26日」
  dow: number; // 0=周日 … 6=周六
  weekZh: string; // 「周四」
  weekend: boolean;
  state: DayState;
  cnOpen: boolean | null;
  usOpen: boolean | null;
  usHoliday: string | null; // 中文假日名（含「补休」）
  cnHoliday: boolean; // 是否落在 A 股法定休市日（区别于周末）
  /** 沪市为什么开/不开：「正常交易」「周末」「春节假期」「日历未覆盖」 */
  cnReason: string;
  /** 纽市为什么开/不开：「正常交易」「感恩节」「圣诞节补休」「日历未覆盖」 */
  usReason: string;
  provisional: boolean; // 该年 A 股日历是预排
  /** 三段式说明，供 aria-label 与读屏；视觉提示由 MonthCal 渲染成三行 */
  title: string;
}

const WEEK_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 开 / 休 / 未知 —— 页面与提示共用同一套措辞，避免两处各写一套慢慢漂移 */
export function openWord(open: boolean | null): string {
  return open === null ? '未知' : open ? '开市' : '休市';
}

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
  const weekend = dow === 0 || dow === 6;
  const cnName = CN_HOLIDAY_NAME.get(date) ?? null;

  // 原因只来自日历本身，不做推断：
  //   A 股 —— 假期名优先于「周末」（周末落在春节里，说「春节假期」才是有用的信息）
  //   美股 —— 只认休市日名称表，查不到就退成「假日」，绝不猜
  let cnReason: string;
  if (co === null) cnReason = '日历未覆盖';
  else if (co) cnReason = '正常交易';
  else if (cnName) cnReason = `${cnName}假期`;
  else if (weekend) cnReason = '周末';
  else cnReason = '法定假日';

  let usReason: string;
  if (uo === null) usReason = '日历未覆盖';
  else if (uo) usReason = '正常交易';
  else if (usHol) usReason = usHol.nameZh;
  else if (weekend) usReason = '周末';
  else usReason = '假日';

  return {
    date,
    day,
    md,
    dow,
    weekZh: WEEK_ZH[dow],
    weekend,
    state,
    cnOpen: co,
    usOpen: uo,
    usHoliday: usHol?.nameZh ?? null,
    cnHoliday: CN_HOLIDAYS.has(date),
    cnReason,
    usReason,
    provisional: CN_COVERAGE.years[date.slice(0, 4)]?.status === 'provisional',
    title: `${md} ${WEEK_ZH[dow]}：A 股${openWord(co)}·${cnReason}；美股${openWord(uo)}·${usReason}`,
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

/** 以 date 所在月为中心，往前 before 个月、往后 after 个月。 */
export function monthGridsAround(date: string, before: number, after: number): MonthGrid[] {
  const y0 = Number(date.slice(0, 4));
  const m0 = Number(date.slice(5, 7)) - 1; // 换成 0 基，跨年取模才不会出错
  const out: MonthGrid[] = [];
  for (let i = -before; i <= after; i++) {
    const t = m0 + i;
    out.push(monthGrid(y0 + Math.floor(t / 12), (((t % 12) + 12) % 12) + 1));
  }
  return out;
}

// ── 周视图 ──────────────────────────────────────────────────────────────────

export interface WeekGrid {
  monday: string; // 周一日期
  label: string; // 「10.19–25」（跨月则「10.28–11.03」），现只覆盖周一~周五
  days: DayInfo[]; // 7 个，周一..周日（组件渲染时过滤掉周末）
}

/** date 所在周的周一。dow 0=周日…6=周六，周一起算则回退 (dow+6)%7 天。 */
export function mondayOf(date: string): string {
  return shiftDate(date, -((dowOf(date) + 6) % 7));
}

export function weekGrid(monday: string): WeekGrid {
  const m1 = Number(monday.slice(5, 7));
  const d1 = Number(monday.slice(8, 10));
  // 周历只展示交易日（周一~周五），标签也用当周实际范围（周五），不再把周末算进跨度。
  const fri = shiftDate(monday, 4);
  const m2 = Number(fri.slice(5, 7));
  const d2 = Number(fri.slice(8, 10));
  const label = m1 === m2 ? `${m1}.${d1}–${d2}` : `${m1}.${d1}–${m2}.${d2}`;
  const days = Array.from({ length: 7 }, (_, i) => dayInfo(shiftDate(monday, i)));
  return { monday, label, days };
}

/** 以 today 所在周为最新一周，往前 weeksBack 周、往后 weeksFwd 周，返回 [最旧…最新…未来]。
 *  调用方倒序即可让最新周置顶；weeksFwd>0 时末尾多追加未来周。 */
export function weeksAround(today: string, weeksBack: number, weeksFwd = 0): WeekGrid[] {
  const thisMon = mondayOf(today);
  const out: WeekGrid[] = [];
  for (let i = weeksBack; i >= -weeksFwd; i--) out.push(weekGrid(shiftDate(thisMon, -i * 7)));
  return out;
}

// ── 「买不了」的说法（格子与表下那行文字共用同一套措辞）────────────────────

/** 这一天为什么买不了。可申购日返回空串。 */
export function offReason(d: DayInfo): string {
  // 美股假日名加「美国·」前缀，与国内「国庆节假期」区分开，避免误读成 A 股休市
  if (d.state === 'US_CLOSED') return d.usHoliday ? `美国·${d.usHoliday}` : '美股休市';
  if (d.state === 'CN_CLOSED' || d.state === 'BOTH_CLOSED') return d.cnReason;
  if (d.state === 'UNKNOWN') return '日历未覆盖';
  return '';
}

// ── 未来：还能连着买几天、下次哪天买不了 ────────────────────────────────────
//
// 2026-10-26：原先页面上排了「未来一周」5 个格子，而它们绝大多数时候说的是
// 同一句话「能买」；真正想知道的「下次哪天买不了」通常落在窗口之外
// （感恩节 11-26 距 10-26 有 31 天）。所以未来不再占格子，改成表下一行文字。
// 这一行同时回答「还能连着买多久」与「哪天断」，信息量高于它替换掉的格子。

interface DayBrief {
  date: string;
  md: string; // 11月26日
  weekZh: string; // 周四
}

export interface BuyOutlook {
  /** 今天能不能申购 */
  todayTradable: boolean;
  /** 今天买不了的原因（「国庆节假期」）；今天能买 → null */
  todayReason: string | null;
  /** 今天买不了时，往后第一个可申购日 */
  nextTradable: DayBrief | null;
  /** 明天起连续可申购的交易日数（不含今天；今天能买才统计） */
  tradingDays: number;
  /** 这串可买日的最后一天 */
  lastTradable: DayBrief | null;
  /** 紧接着这串可买日、第一个买不了的工作日 */
  nextOff: (DayBrief & { reason: string; daysAway: number }) | null;
}

/**
 * 以 fromDate 为「今天」，往前看 horizonDays 天。
 * 周末不算「买不了」的答案（每周都休，写出来是噪音），所以会跳过，可买区间可跨周。
 */
export function buyOutlook(fromDate: string, horizonDays = 120): BuyOutlook {
  const t0 = Date.parse(`${fromDate}T00:00:00Z`);
  const brief = (d: string): DayBrief => ({
    date: d,
    md: `${Number(d.slice(5, 7))}月${Number(d.slice(8, 10))}日`,
    weekZh: WEEK_ZH[dowOf(d)],
  });
  const todayInfo = dayInfo(fromDate);
  const out: BuyOutlook = {
    todayTradable: todayInfo.state === 'TRADING',
    todayReason: todayInfo.state === 'TRADING' ? null : offReason(todayInfo),
    nextTradable: null,
    tradingDays: 0,
    lastTradable: null,
    nextOff: null,
  };

  // 今天买不了：网格画到今天就断了，这一行只需要给出「下一个能买的日子」
  if (!out.todayTradable) {
    for (let i = 1; i <= horizonDays; i++) {
      const d = shiftDate(fromDate, i);
      if (dayInfo(d).state === 'TRADING') {
        out.nextTradable = brief(d);
        break;
      }
    }
    return out;
  }

  for (let i = 1; i <= horizonDays; i++) {
    const d = shiftDate(fromDate, i);
    const info = dayInfo(d);
    if (info.weekend) continue;
    if (info.state === 'TRADING') {
      out.tradingDays++;
      out.lastTradable = brief(d);
      continue;
    }
    out.nextOff = {
      ...brief(d),
      reason:
        info.state === 'US_CLOSED'
          ? info.usHoliday
            ? `美股${info.usHoliday}`
            : '美股休市'
          : info.cnReason,
      daysAway: Math.round((Date.parse(`${d}T00:00:00Z`) - t0) / 86400000),
    };
    break;
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
