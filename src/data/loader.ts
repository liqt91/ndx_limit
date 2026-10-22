import fs from 'node:fs';
import path from 'node:path';
import type { DailySnapshot, FundShare, DayPoint } from './types';
import { buildSnapshot } from './mock'; // 兜底：无真实数据时
import { todayCST, lastNDates, prettyDateCST, isTradingDay, prevTradingDay, shiftDate } from './dates';

// ──────────────────────────────────────────────────────────────
// 数据获取层
//
// 真实数据流（CI 每天跑）：
//   scripts/scrape.mjs 抓取天天基金详情页
//     → 写入 data/history.json（每只基金按天的状态/额度，追加式）
//     → 写入 data/fund-meta.json（每只基金官方简称）
//   loader 读取 funds.json + history.json + fund-meta.json + direct-overrides.json
//     → 装配成 DailySnapshot，页面直接用。
//
// 静态站「每日更新」靠 CI 每天重建：重建日 = 数据日，无需服务器/数据库。
// 本地首次 build（未跑 scrape）→ 回退到 mock 兜底数据。
// ──────────────────────────────────────────────────────────────

const DATA_DIR = path.join(process.cwd(), 'data');

function readJson<T>(name: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8')) as T;
  } catch {
    return fallback;
  }
}

// 中国 A股休市日集合（法定节假日实际放假日期，已含调休）。数据源 data/market-holidays.json。
// 交易日判定只认「周末 + 此集合」；调休补班日若在周末仍休市，无需单独列出。
const HOLIDAYS = new Set<string>(readJson<string[]>('market-holidays.json', []));

// ──────────────────────────────────────────────────────────────
// 申购类公告（scripts/announcements.mjs 写 data/announcements.json）
//
// 公告解释「今天为什么变了」。只存与代销申购额度相关的那几类（调整大额申购限额 /
// 暂停申购 / 恢复申购 / 开放日常申购 / 调整规模上限），直销渠道公告、境外节假日
// 临时暂停、费率优惠都已在上游筛掉——它们解释不了代销额度的变化。
// ──────────────────────────────────────────────────────────────
export interface AnnouncementRef {
  id?: string;
  date: string;
  kind: string;
  action: string;
  title: string;
  url: string;
}

function readAnnouncements(): Record<string, AnnouncementRef[]> {
  const raw = readJson<{ codes?: Record<string, AnnouncementRef[]> }>('announcements.json', {});
  return raw.codes || {};
}

/** 与今日变化相关的公告：只认最近 days 天内的——更早的公告解释不了今天为什么变。 */
function pickRecentAnnouncement(
  map: Record<string, AnnouncementRef[]>,
  code: string,
  today: string,
  days = 3
): AnnouncementRef | null {
  const arr = map[code];
  if (!arr || !arr.length) return null;
  const from = shiftDate(today, -days);
  return arr.find((a) => a.date >= from) || null;
}

/** 详情页用：某份额最近的申购类公告（已按日期倒序）。没有就返回空数组。 */
export function loadAnnouncementsFor(code: string, limit = 6): AnnouncementRef[] {
  const arr = readAnnouncements()[code] || [];
  return arr.slice(0, limit);
}

// history.json 里只保留交易日记录：非交易日（周末/法定节假日）数据不参与任何聚合与展示，
// 既修掉「把周日当上个交易日」的误判，也保证 /daily 与 30 天柱图只出现交易日。
function filterTradingDays(history: Record<string, DayPoint[]>): Record<string, DayPoint[]> {
  const out: Record<string, DayPoint[]> = {};
  for (const code in history) {
    const kept = history[code].filter((d) => isTradingDay(d.date, HOLIDAYS));
    if (kept.length) out[code] = kept;
  }
  return out;
}

function readHistory(): Record<string, DayPoint[]> {
  return filterTradingDays(readJson<Record<string, DayPoint[]>>('history.json', {}));
}

export function getToday(): string {
  return todayCST();
}

/** history 里出现过的最大日期（= 最近一次抓到的交易日）。空历史返回 null。 */
function latestDataDate(history: Record<string, DayPoint[]>): string | null {
  let max: string | null = null;
  for (const code in history) {
    for (const d of history[code]) if (!max || d.date > max) max = d.date;
  }
  return max;
}

function assemble(today: string): DailySnapshot {
  const funds = readJson<{ funds: any[] }>('funds.json', { funds: [] }).funds;
  const history = readHistory();
  const meta = readJson<Record<string, { name: string }>>('fund-meta.json', {});
  const overrides = readJson<Record<string, any>>('direct-overrides.json', {});

  const shares: FundShare[] = [];

  // 份额类别的次序在分组之后排（见 index.astro / my.astro）：
  // 同一家族的不同类别可能横跨 funds.json 里多个条目（天弘的 D 类就单独一条），
  // 在这里按 fund 排序管不到跨条目的先后。

  for (const f of funds) {
    for (const c of f.codes) {
      const code = c.code;
      const hist = (history[code] || []).slice(-30);
      const last = hist[hist.length - 1];
      const status = last ? last.status : 'UNKNOWN';
      const limit = last ? last.limit : null;
      const ov = overrides[code] || {};
      const hasDirect = ov.directLimitText != null || ov.directAnnUrl != null;

      shares.push({
        code,
        shortName:
          meta[code]?.name ||
          `${f.company}${f.baseName}${f.currency === 'USD' ? '美元' : ''}${c.cls}类`,
        company: f.company,
        baseName: f.baseName,
        indexKey: f.indexKey,
        shareClass: c.cls,
        currency: f.currency,
        purchaseStatus: status,
        dailyLimit: limit,
        limitMissing: status === 'LIMITED' && limit == null,
        minPurchase: limit != null ? (ov.minPurchase ?? 1) : null,
        limitText: limit != null ? `${limit} 元` : null,
        directLimitText: ov.directLimitText ?? null,
        directAnnTitle: ov.directAnnTitle ?? null,
        directAnnUrl: ov.directAnnUrl ?? null,
        channelHighlight: hasDirect ? (ov.channelHighlight ?? 'direct') : 'agency',
        history: hist.length ? hist : [{ date: today, status: 'UNKNOWN', limit: null }],
      });
    }
  }

  // snapDate 用「数据实际日期」而不是构建日：早上数据还没更新时构建，
  // 页面必须承认自己展示的是哪一天的数据——用构建日会让它谎称「今天」。
  return { snapDate: latestDataDate(history) ?? today, shares, monitoredCount: shares.length };
}

export function loadTodaySnapshot(): DailySnapshot {
  const history = readHistory();
  const hasRealData = Object.keys(history).length > 0;
  // 有真实抓取历史 → 用真实数据；否则回退 mock，保证本地/首次也能 build。
  const snap = hasRealData ? assemble(getToday()) : buildSnapshot(getToday());
  // 美元份额不在站内展示：只监控人民币份额。统一在此过滤，首页/我的基金/详情页
  // （getStaticPaths 同源）全部生效；scrape 仍继续抓美元数据，日后想展示删掉这两行即可。
  snap.shares = snap.shares.filter((s) => s.currency !== 'USD');
  snap.monitoredCount = snap.shares.length;
  return snap;
}

/** 「我的基金」需要全量份额清单；前端按 localStorage 里的代码做纯展示过滤，不需要后端接口。 */
export function loadAllShares(): FundShare[] {
  return loadTodaySnapshot().shares;
}

/** 美元份额清单（美元现汇/现钞类）。首页「美元家族」区块专用；其余页面仍默认只看人民币。 */
export function loadUsdShares(): FundShare[] {
  const history = readHistory();
  if (Object.keys(history).length === 0) return [];
  const snap = assemble(getToday());
  return snap.shares.filter((s) => s.currency === 'USD');
}

// ──────────────────────────────────────────────────────────────
// 历史日报摘要（/daily 用）：最近 n 天，每天聚合开门数 / 总额 / 监控数。
// 口径与首页一致：按「公司 + 指数 + 币种」成组，组内任一份额开门即算开门，
// 人民币可买份额的单日上限相加为总额。
// ──────────────────────────────────────────────────────────────
export interface DailySummary {
  date: string;
  label: string;
  opened: number; // 人民币开门组数
  total: number; // 人民币可投总额（元）
  count: number; // 人民币监控组数
}

export function loadDailySummaries(n: number): DailySummary[] {
  const funds = readJson<{ funds: any[] }>('funds.json', { funds: [] }).funds;
  const history = readHistory();
  const hasReal = Object.keys(history).length > 0;

  // 无真实抓取历史（本地首次未跑 scrape）→ 回退 mock 逐日生成，保证能 build
  if (!hasReal) {
    return lastNDates(n, getToday()).map((date) => summarizeSnapshot(buildSnapshot(date)));
  }

  // 真实数据：从 history.json 按天聚合
  const dateSet = new Set<string>();
  for (const code in history) for (const d of history[code]) dateSet.add(d.date);
  const allDates = [...dateSet].sort().reverse().slice(0, n); // 最近 n 天，降序

  return allDates.map((date) => {
    // entries 成对收集（status 与 limit 同条推进）：早先版本把两者分压两个数组，
    // 组内「暂停（limit=null，不进 limits）排在限额份额之前」时索引错位，
    // 会把限额份额的额度整条漏掉（2026-09-14~18 实测少 100 元）。
    const byGroup = new Map<string, { currency: string; entries: DayPoint[] }>();
    for (const f of funds) {
      for (const c of f.codes) {
        const entry = (history[c.code] || []).find((d) => d.date === date);
        if (!entry) continue;
        const key = `${f.company}|${f.baseName}|${f.currency}`;
        if (!byGroup.has(key)) byGroup.set(key, { currency: f.currency, entries: [] });
        byGroup.get(key)!.entries.push(entry);
      }
    }
    const groups = [...byGroup.values()];
    const cny = groups.filter((g) => g.currency === 'CNY');
    const opened = cny.filter((g) =>
      g.entries.some((e) => e.status === 'LIMITED' || e.status === 'OPEN')
    ).length;
    const total = cny.reduce(
      (a, g) =>
        a +
        g.entries
          .filter((e) => e.status === 'LIMITED' || e.status === 'OPEN')
          .reduce((x, e) => x + (e.limit ?? 0), 0),
      0
    );
    return { date, label: prettyDateCST(date), opened, total, count: cny.length };
  });
}

// ──────────────────────────────────────────────────────────────
// 每日变化检测（首页「今日变化」区块用）：对比 history.json 中每只人民币份额
// 的最近两天，产出「开门 / 暂停 / 额度变动」清单。仅在真实数据下有意义。
// ──────────────────────────────────────────────────────────────
export type ChangeKind =
  | 'opened' // 由不可买 → 可买
  | 'stopped' // 由可买 → 不可买
  | 'limit-up' // 限额上调
  | 'limit-down' // 限额下调
  | 'limit-set' // 由无限额 → 有限额
  | 'limit-clear' // 由有限额 → 无限额
  | 'unknown' // 变为未知（数据降级）
  | 'other'; // 其余（如持续暂停、未知→未知）

export interface ChangeRecord {
  code: string;
  shortName: string;
  company: string;
  baseName: string;
  shareClass: string;
  fromStatus: PurchaseStatus;
  toStatus: PurchaseStatus;
  fromLimit: number | null;
  toLimit: number | null;
  kind: ChangeKind;
  /** 解释这条变化的那份公告（有就展示，没有就不写——不猜原因） */
  ann?: AnnouncementRef | null;
}

export interface DailyChanges {
  date: string;
  prevDate: string | null;
  changes: ChangeRecord[];
  opened: number;
  stopped: number;
  limitChanged: number;
  hasData: boolean; // 是否有可对比的历史（至少两天）
}

function classifyChange(from: DayPoint, to: DayPoint): ChangeKind {
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

export function loadDailyChanges(): DailyChanges {
  const funds = readJson<{ funds: any[] }>('funds.json', { funds: [] }).funds;
  const history = readHistory();
  const meta = readJson<Record<string, { name: string }>>('fund-meta.json', {});
  const annMap = readAnnouncements();
  const today = getToday();

  const hasReal = Object.keys(history).length > 0;
  if (!hasReal) return { date: today, prevDate: null, changes: [], opened: 0, stopped: 0, limitChanged: 0, hasData: false };

  const changes: ChangeRecord[] = [];
  for (const f of funds) {
    if (f.currency === 'USD') continue; // 仅对比展示中的人民币份额
    for (const c of f.codes) {
      const arr = history[c.code];
      if (!arr || arr.length < 2) continue; // 至少两天才有对比
      const to = arr[arr.length - 1];
      const from = arr[arr.length - 2];
      const kind = classifyChange(from, to);
      if (kind === 'other') continue; // 仅保留有实质意义的变动
      changes.push({
        code: c.code,
        shortName: meta[c.code]?.name || `${f.company}${f.baseName}${c.cls}类`,
        company: f.company,
        baseName: f.baseName,
        shareClass: c.cls,
        fromStatus: from.status,
        toStatus: to.status,
        fromLimit: from.limit,
        toLimit: to.limit,
        kind,
        ann: pickRecentAnnouncement(annMap, c.code, today),
      });
    }
  }

  // 排序：开门 > 暂停 > 额度变动 > 未知；同类按公司名稳定排序
  const order: Record<ChangeKind, number> = {
    opened: 0,
    stopped: 1,
    'limit-up': 2,
    'limit-down': 3,
    'limit-set': 4,
    'limit-clear': 5,
    unknown: 6,
    other: 7,
  };
  changes.sort((a, b) => order[a.kind] - order[b.kind] || a.company.localeCompare(b.company));

  const opened = changes.filter((c) => c.kind === 'opened').length;
  const stopped = changes.filter((c) => c.kind === 'stopped').length;
  const limitChanged = changes.filter((c) =>
    ['limit-up', 'limit-down', 'limit-set', 'limit-clear'].includes(c.kind)
  ).length;

  return {
    date: today,
    // 无论今天有没有变化，都要给出对比基准日：否则无变化日页面会渲染成「较 null」
    prevDate: arr_prevDate(history),
    changes,
    opened,
    stopped,
    limitChanged,
    hasData: true,
  };
}

// 取任一份额「前一天」日期作为对比基准日（用于页面副标题“较 X”）
function arr_prevDate(history: Record<string, DayPoint[]>): string | null {
  for (const code in history) {
    const arr = history[code];
    if (arr && arr.length >= 2) return arr[arr.length - 2].date;
  }
  return null;
}

function summarizeSnapshot(snap: DailySnapshot): DailySummary {
  const byGroup = new Map<string, FundShare[]>();
  for (const s of snap.shares) {
    const k = `${s.company}|${s.baseName}|${s.currency}`;
    if (!byGroup.has(k)) byGroup.set(k, []);
    byGroup.get(k)!.push(s);
  }
  const groups = [...byGroup.values()];
  const cny = groups.filter((g) => g[0].currency === 'CNY');
  const opened = cny.filter((g) => g.some((s) => s.purchaseStatus === 'LIMITED' || s.purchaseStatus === 'OPEN')).length;
  const total = snap.shares
    .filter(
      (s) =>
        s.currency === 'CNY' &&
        (s.purchaseStatus === 'LIMITED' || s.purchaseStatus === 'OPEN') &&
        s.dailyLimit != null
    )
    .reduce((a, s) => a + (s.dailyLimit as number), 0);
  return { date: snap.snapDate, label: prettyDateCST(snap.snapDate), opened, total, count: cny.length };
}

// ──────────────────────────────────────────────────────────────
// 交易日上下文（首页首屏用）
//
// 首页需要回答两个问题：
//   1) 今天是不是交易日？
//   2) 若今天休市，最近一个交易日各家族开门数与总额是多少（用于「最近交易日」快照）？
// 口径与全站一致：按「公司+指数+币种」成组，组内任一可买即开门，人民币可买份额上限相加为总额。
// ──────────────────────────────────────────────────────────────

/** 聚合指定日期（含之前最近一条）的人民币开门数与可投总额。 */
function aggregateForDate(date: string): { opened: number; total: number; count: number } {
  const funds = readJson<{ funds: any[] }>('funds.json', { funds: [] }).funds;
  const history = readHistory();
  // entries 成对收集：与 loadDailySummaries 同一修法——statuses/limits 分压两个数组时，
  // 组内暂停份额（limit=null）排在限额份额之前会索引错位、漏算额度。
  const byGroup = new Map<string, { currency: string; entries: DayPoint[] }>();
  for (const f of funds) {
    for (const c of f.codes) {
      const arr = history[c.code] || [];
      // 取 date 当天或之前最近的一条（YYYY-MM-DD 字符串比较即时间序）
      let entry: DayPoint | null = null;
      for (const d of arr) {
        if (d.date <= date) {
          if (!entry || d.date > entry.date) entry = d;
        }
      }
      if (!entry) continue;
      const key = `${f.company}|${f.baseName}|${f.currency}`;
      if (!byGroup.has(key)) byGroup.set(key, { currency: f.currency, entries: [] });
      byGroup.get(key)!.entries.push(entry);
    }
  }
  const groups = [...byGroup.values()];
  const cny = groups.filter((g) => g.currency === 'CNY');
  const opened = cny.filter((g) =>
    g.entries.some((e) => e.status === 'LIMITED' || e.status === 'OPEN')
  ).length;
  const total = cny.reduce(
    (a, g) =>
      a +
      g.entries
        .filter((e) => e.status === 'LIMITED' || e.status === 'OPEN')
        .reduce((x, e) => x + (e.limit ?? 0), 0),
    0
  );
  return { opened, total, count: cny.length };
}

export interface LastTradingDay {
  date: string | null;
  opened: number;
  total: number;
  count: number;
}

export interface FetchRun {
  /** morning（早间）/ close（收盘前） */
  slot: string;
  at: string;
  /** 展示用 HH:MM */
  time: string;
  opened: number;
  total: number;
  /** 与同日另一次运行相比的差异；当天只跑过一次时为 null */
  changed: { code: string; from: DayPoint; to: DayPoint }[] | null;
}

export interface FetchMeta {
  /** 抓取日 YYYY-MM-DD（应与 history 最新日期一致） */
  date: string | null;
  /** 抓取时刻 ISO（+08:00） */
  fetchedAt: string | null;
  /** 展示用 HH:MM；没有 fetch-meta.json 时为 null */
  time: string | null;
  /** 本次抓取时点：morning / close */
  slot: string | null;
  /** 当日各时点的运行记录（每天最多两条：早间、收盘前） */
  runs: FetchRun[];
}

/** 抓取时刻（data/fetch-meta.json，scrape.mjs 写）。缺失时全部为 null，页面只显示日期不显示钟点。 */
export function loadFetchMeta(): FetchMeta {
  const raw = readJson<{ date?: string; fetchedAt?: string; slot?: string; runs?: FetchRun[] } | null>(
    'fetch-meta.json',
    null
  );
  const fetchedAt = typeof raw?.fetchedAt === 'string' ? raw.fetchedAt : null;
  const m = fetchedAt?.match(/T(\d{2}:\d{2})/);
  return {
    date: typeof raw?.date === 'string' ? raw.date : null,
    fetchedAt,
    time: m ? m[1] : null,
    slot: typeof raw?.slot === 'string' ? raw.slot : null,
    runs: Array.isArray(raw?.runs) ? raw!.runs : [],
  };
}

/** 数据日期相对今天的措辞：「今日」/「上个交易日」/「10月19日 周一」。
 *  「昨天」不许用——昨天可能是周六，上一个有数据的交易日未必是昨天。 */
export function dataDateLabel(dataDate: string, today = getToday()): string {
  if (dataDate === today) return '今日';
  const prev = prevTradingDay(today, HOLIDAYS);
  if (prev && dataDate === prev) return '上个交易日';
  return prettyDateCST(dataDate);
}

/** 窗口内每一天的交易日标记，1=交易日 0=休市。给客户端判断「今天该不该有新数据」、
 *  「数据日是不是上个交易日」用。窗口含过去 10 天（要往前找上一个交易日）+ 未来 30 天。
 *  页面超过窗口没重建时查不到今天 → 客户端按「数据过期」提示。 */
export function tradingWindowMap(pastDays = 10, futureDays = 30): Record<string, 0 | 1> {
  const today = getToday();
  const out: Record<string, 0 | 1> = {};
  for (let i = -pastDays; i < futureDays; i++) {
    const d = shiftDate(today, i);
    out[d] = isTradingDay(d, HOLIDAYS) ? 1 : 0;
  }
  return out;
}

export interface TradingContext {
  today: string;
  isTrading: boolean;
  lastTrading: LastTradingDay | null;
  /** 页面展示的数据日期（history 最新交易日） */
  dataDate: string;
  /** 数据日期相对今天的措辞：今日 / 上个交易日 / 具体日期 */
  dataLabel: string;
  /** 抓取时刻 HH:MM，无 fetch-meta.json 时为 null */
  updatedTime: string | null;
  /** 今天是交易日、但数据不是今天（早上还没抓 / 抓取失败 / 页面隔夜未重建） */
  isStale: boolean;
}

/** 首页首屏所需的交易日上下文：今天是否交易日、（若休市）最近交易日快照、数据新鲜度。 */
export function getTradingContext(dataDate?: string): TradingContext {
  const today = getToday();
  const isTrading = isTradingDay(today, HOLIDAYS);
  const dd = dataDate ?? latestDataDate(readHistory()) ?? today;
  const base = {
    today,
    isTrading,
    dataDate: dd,
    dataLabel: dataDateLabel(dd, today),
    updatedTime: loadFetchMeta().time,
    isStale: isTrading && dd !== today,
  };
  if (isTrading) return { ...base, lastTrading: null };
  // 休市时「最近交易日」用数据里最新的那一天，不用日历推算——推算出来的那天可能
  // 根本没抓到数据（抓取失败/长假），aggregate 会返回 0 家开门，比不给数字更误导。
  const agg = aggregateForDate(dd);
  return { ...base, lastTrading: { date: dd, ...agg } };
}
