import fs from 'node:fs';
import path from 'node:path';
import type { DailySnapshot, FundShare, DayPoint } from './types';
import { buildSnapshot } from './mock'; // 兜底：无真实数据时
import { todayCST, lastNDates, prettyDateCST, isTradingDay, prevTradingDay, shiftDate } from './dates';
// 「今日能买清单」的唯一实现放在 scripts/digest.mjs（邮件也用它）。
// ★ 订阅页的「最近日报」是邮件正文的镜像，但它曾经是独立拼的一套逻辑：邮件加了
//   「代码 + 额度」清单之后墙上没有，用户一眼就看出「预览和信长得不一样」。
//   所以这里直接复用，不再靠「两边记得一起改」；金额写法（10元 / 不限 / 待核验）也只有一份。
import { buyableFamilies } from '../../scripts/digest.mjs';

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

// ──────────────────────────────────────────────────────────────
// 分指数（indexKey）
//
// 2026-10-23 起本站从「单一纳指站」扩为「多指数分站」：同一份 funds.json 里
// 每个条目带 indexKey，页面按它切数据，抓取/邮件/小程序按它切口径。
//
// ★ 所有聚合（开门数、可投总额、变化清单、覆盖率）都必须带 indexKey——
//   两个指数的份额混在一起算，首屏会从「17 家开门」变成「24 家」，是静默错误。
// ★ 默认值一律 NDX：既有页面、日报、小程序不传参时行为与扩容前逐字节一致。
// ──────────────────────────────────────────────────────────────
export const NDX = '纳斯达克100';
export const SP500 = '标普500';

export interface IndexMeta {
  key: string;
  /** 短名，用在小节文案与对比里（正文一律用它，带数字：纳指100 / 标普500） */
  short: string;
  /** 超链接上的名字（导航、指数切换器）：只有这里用两字短名「纳指」「标普」。
   *  两个理由：① 导航是并排的链接，两条字数不等会显得其中一条是例外；
   *  ② 链接的空间只有几个字，而链接的目标就在右边，不必在链接里把全称念完。
   *  ★ 别再让 navLabel 与 short 合流：合流后要么导航变长（窄屏要折行），
   *    要么正文写成「纳指」，读者会以为跟踪的是纳斯达克综合指数。 */
  navLabel: string;
  /** 站名（<title>、OG、页脚） */
  brand: string;
  /** 分站首页路径 */
  path: string;
  /** 页面主标题前的那半句，例如「标普500」 */
  label: string;
}

// 2026-10-23 换域并统一路径：根目录不再承载纳指看板，改成 /ndx100。
// 根 / 只留一个跳转空壳（src/pages/index.astro），所以这里没有 '/' 了——
// 任何「meta.path === '/'」式的判断都必须改成按 key 判断，否则会静默失效。
// 2026-10-27 用户：「在导航处用纳指、标普，在其他地方用纳指100和标普500」。
// 于是短名（short/label/brand）统一带数字，只有 navLabel 仍是两字短名——
// 导航是并排的两个链接，字数不等会显得一个是例外；正文里写全了才不会把
// 「纳指」误读成纳斯达克综合指数（那是另一条指数，点位口径也不同）。
export const INDEXES: IndexMeta[] = [
  { key: NDX, short: '纳指100', navLabel: '纳指', brand: '纳指100开门日报', path: '/ndx100/', label: '纳指100' },
  { key: SP500, short: '标普500', navLabel: '标普', brand: '标普500开门日报', path: '/sp500/', label: '标普500' },
];

export function indexMeta(key: string = NDX): IndexMeta {
  return INDEXES.find((i) => i.key === key) ?? INDEXES[0];
}

/**
 * 路由 slug（ndx100 / sp500）——也就是 CSS 里 `data-board` 的取值。
 *
 * 从 path 推导而不是在 IndexMeta 里加一个字段：加指数时只改 funds.json、INDEXES
 * 和 src/pages 下那三个短页面，不该再多一份要同步的清单。
 * 两个地方用它：`<html data-board>`（整页身份）与 /my 的分段（每段一种印色），
 * 两边必须得到同一个字符串，所以只留这一处定义。
 */
export function indexSlug(key: string): string | null {
  return INDEXES.find((i) => i.key === key)?.path.replace(/\//g, '') ?? null;
}


function readJson<T>(name: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** funds.json 全量条目（不分指数）。 */
function allFundEntries(): any[] {
  return readJson<{ funds: any[] }>('funds.json', { funds: [] }).funds;
}

/** 按指数过滤后的 funds.json 条目。不传 indexKey = 全量（只有详情页/我的基金用）。 */
function fundEntries(indexKey?: string): any[] {
  const all = allFundEntries();
  return indexKey ? all.filter((f) => f.indexKey === indexKey) : all;
}

/** 某指数收录的份额代码集合。用于把 history.json（按 code 平铺）切回单指数。 */
function codesOf(indexKey?: string): Set<string> {
  const out = new Set<string>();
  for (const f of fundEntries(indexKey)) for (const c of f.codes) out.add(c.code);
  return out;
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

/** history 里出现过的最大日期（= 最近一次抓到的交易日）。空历史返回 null。
 *  传 indexKey 时只看该指数收录的代码——否则某个指数抓失败会被另一个指数的新鲜日期掩盖。 */
function latestDataDate(history: Record<string, DayPoint[]>, indexKey?: string): string | null {
  const codes = indexKey ? codesOf(indexKey) : null;
  let max: string | null = null;
  for (const code in history) {
    if (codes && !codes.has(code)) continue;
    for (const d of history[code]) if (!max || d.date > max) max = d.date;
  }
  return max;
}

function assemble(today: string, indexKey: string = NDX): DailySnapshot {
  const funds = fundEntries(indexKey);
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
  return { snapDate: latestDataDate(history, indexKey) ?? today, shares, monitoredCount: shares.length };
}

export function loadTodaySnapshot(indexKey: string = NDX): DailySnapshot {
  const history = readHistory();
  // 「有没有真实数据」也要按指数判断：标普500 首日还没抓过时不该回退 mock，
  // 而应如实返回空快照（页面显示 0 家 + 过期提示），否则会渲染出编造的额度。
  const codes = codesOf(indexKey);
  const hasRealData = Object.keys(history).some((c) => codes.has(c));
  // mock 只是「本地首建也能 build」的兜底，内容是纳指标本——绝不能喂给标普500 页面，
  // 否则标普500 首日会渲染出 17 张纳指卡片（数字全是编的）。其他指数无数据就是空。
  const snap = hasRealData
    ? assemble(getToday(), indexKey)
    : indexKey === NDX
      ? buildSnapshot(getToday())
      : { snapDate: getToday(), shares: [], monitoredCount: 0 };
  // 美元份额不在站内展示：只监控人民币份额。统一在此过滤，首页/我的基金/详情页
  // （getStaticPaths 同源）全部生效；scrape 仍继续抓美元数据，日后想展示删掉这两行即可。
  snap.shares = snap.shares.filter((s) => s.currency !== 'USD');
  snap.monitoredCount = snap.shares.length;
  return snap;
}

/** 「我的基金」需要全量份额清单；前端按 localStorage 里的代码做纯展示过滤，不需要后端接口。
 *  不传 indexKey = 跨指数全量（用户持有的可能是任一指数的人民币份额）。 */
export function loadAllShares(indexKey?: string): FundShare[] {
  const history = readHistory();
  // 完全无历史（本地首次未跑 scrape）→ 回退 mock，保证 /f/[code] 仍有页面可构建
  if (!Object.keys(history).length) {
    return buildSnapshot(getToday()).shares.filter((s) => s.currency !== 'USD');
  }
  const keys = indexKey ? [indexKey] : INDEXES.map((i) => i.key);
  const out: FundShare[] = [];
  for (const k of keys) {
    const codes = codesOf(k);
    // 该指数一条历史都没有 → 跳过，不产出全 UNKNOWN 的卡片
    if (!Object.keys(history).some((c) => codes.has(c))) continue;
    out.push(...assemble(getToday(), k).shares.filter((s) => s.currency !== 'USD'));
  }
  return out;
}

/** 美元份额清单（美元现汇/现钞类）。首页「美元家族」区块专用；其余页面仍默认只看人民币。 */
export function loadUsdShares(indexKey?: string): FundShare[] {
  const history = readHistory();
  if (Object.keys(history).length === 0) return [];
  const keys = indexKey ? [indexKey] : INDEXES.map((i) => i.key);
  const out: FundShare[] = [];
  for (const k of keys) {
    const codes = codesOf(k);
    if (!Object.keys(history).some((c) => codes.has(c))) continue;
    out.push(...assemble(getToday(), k).shares.filter((s) => s.currency === 'USD'));
  }
  return out;
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

export function loadDailySummaries(n: number, indexKey: string = NDX): DailySummary[] {
  const funds = fundEntries(indexKey);
  const history = readHistory();
  const codes = codesOf(indexKey);
  const hasReal = Object.keys(history).some((c) => codes.has(c));

  // 无真实抓取历史（本地首次未跑 scrape）→ 回退 mock 逐日生成，保证能 build。
  // 同样只对纳指成立：其他指数没有 mock 标本，无数据就返回空数组（页面画不出趋势带）。
  if (!hasReal) {
    if (indexKey !== NDX) return [];
    return lastNDates(n, getToday()).map((date) => summarizeSnapshot(buildSnapshot(date)));
  }

  // 真实数据：从 history.json 按天聚合（只看本指数的代码）
  const dateSet = new Set<string>();
  for (const code in history) {
    if (!codes.has(code)) continue;
    for (const d of history[code]) dateSet.add(d.date);
  }
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
// 今日能买清单（按天，代码 + 额度）
//
// 与 scripts/digest.mjs 的 buyableFamilies 同一个实现：邮件正文那一段
// 「今日能买（人民币份额 16 个）/ 宝盈纳斯达克100：A类 019736 10元 …」就是它产出的。
// 订阅页要让人看见「订阅后收到什么」，所以这份清单必须在墙上也在。
//
// 日期轴直接取 loadDailySummaries 的那一串（同一份 history、同一套交易日过滤），
// 否则墙上「7 家开门」与下面清单会不是同一天的口径。
// ──────────────────────────────────────────────────────────────
export interface BuyableShare {
  cls: string;
  code: string;
  status: string;
  limit: number | null;
  /** 已排好版的说法：10元 / 5美元 / 不限 / 待核验 */
  amount: string;
}

export interface BuyableFamily {
  name: string;
  currency: string;
  shares: BuyableShare[];
}

export function loadDailyBuyable(n: number, indexKey: string = NDX): Map<string, BuyableFamily[]> {
  const out = new Map<string, BuyableFamily[]>();
  const dates = loadDailySummaries(n, indexKey).map((s) => s.date);
  if (!dates.length) return out;
  const funds = allFundEntries();
  const history = readHistory();
  for (const date of dates) {
    const fams = buyableFamilies({ funds, history, date, indexKey }) as BuyableFamily[];
    if (fams.length) out.set(date, fams);
  }
  return out;
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

/** 变化种类展示次序：开门 > 暂停 > 额度上调 > 下调 > 新限额 > 取消限额 > 未知。
 *  三处变化排序（今日 / 历史逐日 / 日内）共用同一把尺，避免不同位置顺序漂移。 */
const CHANGE_ORDER: Record<ChangeKind, number> = {
  opened: 0,
  stopped: 1,
  'limit-up': 2,
  'limit-down': 3,
  'limit-set': 4,
  'limit-clear': 5,
  unknown: 6,
  other: 7,
};

export function loadDailyChanges(indexKey: string = NDX): DailyChanges {
  const funds = fundEntries(indexKey);
  const history = readHistory();
  const meta = readJson<Record<string, { name: string }>>('fund-meta.json', {});
  const annMap = readAnnouncements();
  const today = getToday();

  const codes = codesOf(indexKey);
  const hasReal = Object.keys(history).some((c) => codes.has(c));
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
  // 排序复用模块级 CHANGE_ORDER
  changes.sort((a, b) => CHANGE_ORDER[a.kind] - CHANGE_ORDER[b.kind] || a.company.localeCompare(b.company));

  const opened = changes.filter((c) => c.kind === 'opened').length;
  const stopped = changes.filter((c) => c.kind === 'stopped').length;
  const limitChanged = changes.filter((c) =>
    ['limit-up', 'limit-down', 'limit-set', 'limit-clear'].includes(c.kind)
  ).length;

  return {
    date: today,
    // 无论今天有没有变化，都要给出对比基准日：否则无变化日页面会渲染成「较 null」
    prevDate: arr_prevDate(history, codes),
    changes,
    opened,
    stopped,
    limitChanged,
    hasData: true,
  };
}

// 取任一份额「前一天」日期作为对比基准日（用于页面副标题“较 X”）。
// 只看本指数的代码：跨指数取会拿到另一个指数的日期，标普500 首日就会显示「较 10-21」。
function arr_prevDate(history: Record<string, DayPoint[]>, codes?: Set<string>): string | null {
  for (const code in history) {
    if (codes && !codes.has(code)) continue;
    const arr = history[code];
    if (arr && arr.length >= 2) return arr[arr.length - 2].date;
  }
  return null;
}

// 取某交易日「前一交易日」作为对比基准日（用于历史日报副标题「较 X」）。
// 语义与 arr_prevDate 一致，只是以给定 date 为锚而非「最后一天」。
function prevDateFor(date: string, history: Record<string, DayPoint[]>, codes?: Set<string>): string | null {
  for (const code in history) {
    if (codes && !codes.has(code)) continue;
    const arr = history[code];
    if (!arr) continue;
    const i = arr.findIndex((d) => d.date === date);
    if (i > 0) return arr[i - 1].date;
  }
  return null;
}

/** 最近 n 个交易日的逐日变化（降序）。日报墙按任意日期取「当天 vs 前一交易日」。
 *  口径与 loadDailyChanges（今日）一致：仅对比人民币份额、仅保留有实质意义的变动、
 *  排序 opened > stopped > 额度变动。无真实抓取历史（本地未跑 scrape）→ 空数组。 */
export function loadDailyChangeHistory(n: number, indexKey: string = NDX): DailyChanges[] {
  const funds = fundEntries(indexKey);
  const history = readHistory();
  const meta = readJson<Record<string, { name: string }>>('fund-meta.json', {});
  const annMap = readAnnouncements();
  const codes = codesOf(indexKey);

  const hasReal = Object.keys(history).some((c) => codes.has(c));
  if (!hasReal) return [];

  const dateSet = new Set<string>();
  for (const code in history) {
    if (!codes.has(code)) continue;
    for (const d of history[code]) dateSet.add(d.date);
  }
  const allDates = [...dateSet].sort().reverse().slice(0, n);

  // 排序复用模块级 CHANGE_ORDER

  return allDates.map((date) => {
    const changes: ChangeRecord[] = [];
    for (const f of funds) {
      if (f.currency === 'USD') continue; // 仅对比展示中的人民币份额
      for (const c of f.codes) {
        const arr = history[c.code];
        if (!arr) continue;
        const i = arr.findIndex((d) => d.date === date);
        if (i <= 0) continue; // 至少两天才有对比
        const to = arr[i];
        const from = arr[i - 1];
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
          ann: pickRecentAnnouncement(annMap, c.code, date),
        });
      }
    }
    // 排序：开门 > 暂停 > 额度变动 > 未知；同类按公司名稳定排序
    changes.sort((a, b) => CHANGE_ORDER[a.kind] - CHANGE_ORDER[b.kind] || a.company.localeCompare(b.company));
    const opened = changes.filter((c) => c.kind === 'opened').length;
    const stopped = changes.filter((c) => c.kind === 'stopped').length;
    const limitChanged = changes.filter((c) =>
      ['limit-up', 'limit-down', 'limit-set', 'limit-clear'].includes(c.kind)
    ).length;
    return {
      date,
      prevDate: prevDateFor(date, history, codes),
      changes,
      opened,
      stopped,
      limitChanged,
      hasData: true,
    };
  });
}

// ──────────────────────────────────────────────────────────────
// 日内变化（较盘前 / 较同日上一次运行）—— 邮件日报的第 3 段
//
// 同一天早间 run 与收盘前 run 之间的差异，回答「盘中额度有没有动」。
// 数据只存在于 data/fetch-meta.json 当天的 runs[]（每天最多两条：morning / close），
// 历史日没有逐日 intraday 记录，所以日报墙只在「最新一天」能补上这一段——
// 这与真实邮件本身一致：每一封邮件也只有它当天的 intraday，历史邮件的盘中差异并未留存。
// ──────────────────────────────────────────────────────────────
export interface IntradayBlock {
  /** 展示用对比标签，如「较盘前 10:16」「较同日 10:16」「较同日上一次运行」 */
  prevLabel: string;
  /** 当天的日内变化清单（已按 CHANGE_ORDER 排序） */
  changes: ChangeRecord[];
}

/** 读取某指数「最新一天」的日内变化；没有 close run 或盘中无变化则返回 null。 */
export function loadDailyIntraday(indexKey: string = NDX): IntradayBlock | null {
  const meta = loadFetchMeta();
  if (!meta.date || !meta.runs.length) return null;
  const closeRun = meta.runs.find((r) => r.slot === 'close');
  const run = closeRun || meta.runs[meta.runs.length - 1];
  const perRun = indexKey === NDX ? run.changed : run.byIndex?.[indexKey]?.changed;
  const intraday = Array.isArray(perRun) ? perRun : [];

  const slotTime = (slot: string) => meta.runs.find((r) => r.slot === slot)?.time || null;
  const morningTime = slotTime('morning');
  // 没有 close 那次运行就没得比：此时 history 里的点来自更早的时点，
  // 「较盘前 10:16：没有变化」等于自己跟自己比，是句废话（本地 dry-run 常见）。
  if (!closeRun && !morningTime) return null;
  const prevLabel = !morningTime
    ? '较同日上一次运行'
    : morningTime < '12:00'
      ? `较盘前 ${morningTime}`
      : `较同日 ${morningTime}`;

  if (!intraday.length) return null; // 无变化或收盘前那次没跑成 → 邮件里这一段本就不存在

  const metaNames = readJson<Record<string, { name: string }>>('fund-meta.json', {});
  const funds = fundEntries(indexKey);
  const nameOf = (code: string): string => {
    if (metaNames[code]?.name) return metaNames[code].name;
    for (const f of funds) for (const c of f.codes) if (c.code === code) return `${f.company}${f.baseName}${c.cls}类`;
    return code;
  };

  const changes: ChangeRecord[] = intraday
    .map((c) => {
      const from = c.from;
      const to = c.to;
      const kind = classifyChange(from, to);
      if (kind === 'other') return null;
      return {
        code: c.code,
        shortName: nameOf(c.code),
        company: '',
        baseName: '',
        shareClass: '',
        fromStatus: from.status,
        toStatus: to.status,
        fromLimit: from.limit ?? null,
        toLimit: to.limit ?? null,
        kind,
      } as ChangeRecord;
    })
    .filter((c): c is ChangeRecord => c !== null);

  if (!changes.length) return null;
  changes.sort((a, b) => CHANGE_ORDER[a.kind] - CHANGE_ORDER[b.kind] || a.shortName.localeCompare(b.shortName));
  return { prevLabel, changes };
}

/** 当日快照的抓取时刻说明（邮件第 1 段末尾的括号内容）。
 *  仅最新一天有——历史日没有逐日时刻记录，旧邮件的「14:45 抓取」也没留存。 */
export function loadDataTimeNote(): { date: string | null; note: string } {
  const meta = loadFetchMeta();
  if (!meta.date) return { date: null, note: '' };
  const slotTime = (slot: string) => meta.runs.find((r) => r.slot === slot)?.time || null;
  const closeTime = slotTime('close');
  const dataTime = closeTime || slotTime('morning') || null;
  // 时刻必须说准：拿盘前那次的数据冒充「收盘前抓取」比不说更糟
  const note = closeTime ? `${closeTime} 抓取` : dataTime ? `${dataTime} 抓取，收盘前那次没跑成` : '';
  return { date: meta.date, note };
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
function aggregateForDate(date: string, indexKey: string = NDX): { opened: number; total: number; count: number } {
  const funds = fundEntries(indexKey);
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
  /** 分指数口径下的日内差异（scrape 按指数分好）。纳指读 run.changed，其余指数读这里。 */
  byIndex?: Record<string, { opened?: number; total?: number; changed?: { code: string; from: DayPoint; to: DayPoint }[] | null }>;
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
export function getTradingContext(dataDate?: string, indexKey: string = NDX): TradingContext {
  const today = getToday();
  const isTrading = isTradingDay(today, HOLIDAYS);
  const dd = dataDate ?? latestDataDate(readHistory(), indexKey) ?? today;
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
  const agg = aggregateForDate(dd, indexKey);
  return { ...base, lastTrading: { date: dd, ...agg } };
}
