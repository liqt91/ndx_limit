import fs from 'node:fs';
import path from 'node:path';
import type { DailySnapshot, FundShare, DayPoint } from './types';
import { buildSnapshot } from './mock'; // 兜底：无真实数据时
import { todayCST, lastNDates, prettyDateCST, isTradingDay, prevTradingDay } from './dates';

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

function assemble(today: string): DailySnapshot {
  const funds = readJson<{ funds: any[] }>('funds.json', { funds: [] }).funds;
  const history = readHistory();
  const meta = readJson<Record<string, { name: string }>>('fund-meta.json', {});
  const overrides = readJson<Record<string, any>>('direct-overrides.json', {});

  const shares: FundShare[] = [];

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

  return { snapDate: today, shares, monitoredCount: shares.length };
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
    const byGroup = new Map<string, { currency: string; statuses: string[]; limits: number[] }>();
    for (const f of funds) {
      for (const c of f.codes) {
        const entry = (history[c.code] || []).find((d) => d.date === date);
        if (!entry) continue;
        const key = `${f.company}|${f.baseName}|${f.currency}`;
        if (!byGroup.has(key)) byGroup.set(key, { currency: f.currency, statuses: [], limits: [] });
        const g = byGroup.get(key)!;
        g.statuses.push(entry.status);
        if (entry.limit != null) g.limits.push(entry.limit);
      }
    }
    const groups = [...byGroup.values()];
    const cny = groups.filter((g) => g.currency === 'CNY');
    const opened = cny.filter((g) => g.statuses.some((s) => s === 'LIMITED' || s === 'OPEN')).length;
    const total = cny.reduce(
      (a, g) =>
        a +
        g.limits
          .filter((_, i) => g.statuses[i] === 'LIMITED' || g.statuses[i] === 'OPEN')
          .reduce((x, y) => x + y, 0),
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
  const byGroup = new Map<string, { currency: string; statuses: string[]; limits: number[] }>();
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
      if (!byGroup.has(key)) byGroup.set(key, { currency: f.currency, statuses: [], limits: [] });
      const g = byGroup.get(key)!;
      g.statuses.push(entry.status);
      if (entry.limit != null) g.limits.push(entry.limit);
    }
  }
  const groups = [...byGroup.values()];
  const cny = groups.filter((g) => g.currency === 'CNY');
  const opened = cny.filter((g) => g.statuses.some((s) => s === 'LIMITED' || s === 'OPEN')).length;
  const total = cny.reduce(
    (a, g) =>
      a +
      g.limits
        .filter((_, i) => g.statuses[i] === 'LIMITED' || g.statuses[i] === 'OPEN')
        .reduce((x, y) => x + y, 0),
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

export interface TradingContext {
  today: string;
  isTrading: boolean;
  lastTrading: LastTradingDay | null;
}

/** 首页首屏所需的交易日上下文：今天是否交易日 + （若休市）最近交易日快照。 */
export function getTradingContext(): TradingContext {
  const today = getToday();
  const isTrading = isTradingDay(today, HOLIDAYS);
  if (isTrading) return { today, isTrading, lastTrading: null };
  const prev = prevTradingDay(today, HOLIDAYS);
  if (!prev) return { today, isTrading, lastTrading: { date: null, opened: 0, total: 0, count: 0 } };
  const agg = aggregateForDate(prev);
  return { today, isTrading, lastTrading: { date: prev, ...agg } };
}
