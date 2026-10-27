import fs from 'node:fs';
import path from 'node:path';

// ──────────────────────────────────────────────────────────────
// 份额的「非额度」附加信息：费率 与 年化跟踪误差
//
// 这两项不参与任何「今天能不能买」的判断，是买之前的成本与质量参考，
// 所以单独一份数据、单独一个读取层——不要塞进 FundShare：
//   · FundShare 是「某天某份额能买多少」，每天变、按天存档；
//   · 费率是合同属性（年费）或渠道报价（申购费），跟踪误差是每周更新的滞后指标。
//   混在一起会让「历史快照」这种按天回放的页面读到一个会随时间漂移的费率。
//
// ★ 两者都是**可选**的：上游抓不到就返回 null，页面留空或写「—」，
//   绝不填 0 或拿同类均值顶上——费率 0 和「没抓到」是两件事。
// ★ 数据源（scripts/fetch-fees.mjs / fetch-tracking.mjs，天天基金 F10）：
//   fund-fees.json    { updatedAt, codes: { 代码: { mgmt, custody, sales,
//                       annualTotal, purchase, purchaseOrig, purchaseDiscount, ok } } }
//   fund-tracking.json{ updatedAt, asOf, asOfSet, codes: { 代码: {
//                       index, trackingError, peerError, asOf, ok } } }
// ──────────────────────────────────────────────────────────────

const DATA_DIR = path.join(process.cwd(), 'data');

/** 单份额费率。单位一律 %。 */
export interface FeeInfo {
  /** 年运作费合计 = 管理费 + 托管费 + 销售服务费（每年从基金资产计提，各渠道相同） */
  annualTotal: number | null;
  mgmt: number | null;
  custody: number | null;
  /** 销售服务费：C/D 类才有，A 类为 0 */
  sales: number | null;
  /** 天天基金实际执行的申购费（仅「100 万元以下」档，属渠道报价，不进首页表格） */
  purchase: number | null;
  /** 合同约定的原申购费率（产品属性） */
  purchaseOrig: number | null;
  purchaseTier: string | null;
  /** 优惠折扣：0.1 = 1 折 */
  purchaseDiscount: number | null;
}

/** 单份额年化跟踪误差。这是**滞后指标**，必须连同 asOf 一起用。 */
export interface TrackingInfo {
  /** 跟踪的标的指数名，如「纳斯达克100指数」 */
  index: string | null;
  /** 年化跟踪误差（%）：日收益差的标准差再年化。越小跟得越准 */
  trackingError: number | null;
  /** 同类平均跟踪误差（%），用作参照 */
  peerError: number | null;
  asOf: string | null;
}

function readJson<T>(name: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8')) as T;
  } catch {
    // 文件不存在 = 还没抓过（本地首建、或 CI 里抓取步骤失败）。
    // 静默回落空表，页面显示「—」而不是崩掉整个构建。
    return fallback;
  }
}

const EMPTY_FEE: FeeInfo = {
  annualTotal: null,
  mgmt: null,
  custody: null,
  sales: null,
  purchase: null,
  purchaseOrig: null,
  purchaseTier: null,
  purchaseDiscount: null,
};

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

let feeCache: Record<string, FeeInfo> | null = null;

/** 全部份额费率，按代码索引。文件缺失时返回空对象（不是抛错）。 */
export function loadFees(): Record<string, FeeInfo> {
  if (feeCache) return feeCache;
  const raw = readJson<{ codes?: Record<string, any> }>('fund-fees.json', {});
  const out: Record<string, FeeInfo> = {};
  for (const [code, v] of Object.entries(raw.codes || {})) {
    if (!v || v.ok === false) continue;
    out[code] = {
      annualTotal: num(v.annualTotal),
      mgmt: num(v.mgmt),
      custody: num(v.custody),
      sales: num(v.sales),
      purchase: num(v.purchase),
      purchaseOrig: num(v.purchaseOrig),
      purchaseTier: typeof v.purchaseTier === 'string' ? v.purchaseTier : null,
      purchaseDiscount: num(v.purchaseDiscount),
    };
  }
  feeCache = out;
  return out;
}

/** 取单个份额的费率；没有就返回一份全 null 的结构，调用方无需判空。 */
export function feeOf(code: string): FeeInfo {
  return loadFees()[code] || EMPTY_FEE;
}

export interface TrackingTable {
  /** 整批共用的截止日（YYYY-MM-DD）。页面必须显示它——这是滞后指标 */
  asOf: string | null;
  codes: Record<string, TrackingInfo>;
}

let trackingCache: TrackingTable | null = null;

/** 全部份额的跟踪误差 + 整批截止日。文件缺失时 asOf 为 null、codes 为空。 */
export function loadTracking(): TrackingTable {
  if (trackingCache) return trackingCache;
  const raw = readJson<{ asOf?: string; codes?: Record<string, any> }>('fund-tracking.json', {});
  const codes: Record<string, TrackingInfo> = {};
  for (const [code, v] of Object.entries(raw.codes || {})) {
    if (!v || v.ok === false) continue;
    const te = num(v.trackingError);
    // 没有跟踪误差的记录直接丢掉：留着只会让「有值/没值」的分支多一层
    if (te == null) continue;
    codes[code] = {
      index: typeof v.index === 'string' ? v.index : null,
      trackingError: te,
      peerError: num(v.peerError),
      asOf: typeof v.asOf === 'string' ? v.asOf : null,
    };
  }
  trackingCache = {
    asOf: typeof raw.asOf === 'string' ? raw.asOf : null,
    codes,
  };
  return trackingCache;
}

/**
 * 家族级跟踪误差：同一只基金的不同份额类别跟踪的是同一个组合，实测 18 个家族里
 * 11 个各类别完全相同、其余仅差 0.01%，所以只需取一个代表值在家族首行显示一次。
 * 按传入顺序取第一个有值的份额——调用方传的已是按类别排好序的 shares。
 */
export function familyTracking(shares: { code: string }[]): TrackingInfo | null {
  const table = loadTracking();
  for (const s of shares) {
    const hit = table.codes[s.code];
    if (hit) return hit;
  }
  return null;
}

/** 百分比格式化：一位小数会抹平 0.05 的差，两位小数与上游口径一致。 */
export const fmtPct = (v: number | null, digits = 2): string =>
  v == null ? '—' : `${v.toFixed(digits)}%`;
