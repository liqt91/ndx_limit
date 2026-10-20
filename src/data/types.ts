// 数据模型：对齐原站 /api/holdings 返回的字段结构。
// 抓取脚本（scripts/scrape.mjs）写入 data/history.json + data/fund-meta.json，
// loader 读取后装配成同样的形状；页面无需改动。

export type PurchaseStatus = 'OPEN' | 'LIMITED' | 'STOPPED' | 'CLOSED' | 'UNKNOWN';

export type Currency = 'CNY' | 'USD';

/** 单只基金份额在某一天的情况（用于 30 天柱状图 / 历史快照） */
export interface DayPoint {
  date: string; // YYYY-MM-DD
  status: PurchaseStatus;
  limit: number | null; // 代销单日上限（元），null = 未公布/不可买
  /** 单位净值。可选：只有 scripts/import-history.mjs 回填的历史才带，scrape 不写；
   *  缺失 = 未采集，不是 0。当前页面不展示，留作日后画净值曲线。 */
  nav?: number | null;
}

/** 单只基金份额（如「宝盈纳斯达克100 A 类，代码 019736」） */
export interface FundShare {
  code: string;
  shortName: string; // 官方简称（来自抓取），缺省时由 company+baseName+类 兜底
  company: string;
  baseName: string; // 基金家族名，如「纳斯达克100」，用于分组
  indexKey: string; // 纳斯达克100 / 标普500（多品牌用）
  shareClass: string; // A / C / D
  currency: Currency;
  purchaseStatus: PurchaseStatus; // 今日状态（= history 最后一项）
  dailyLimit: number | null; // 今日代销单日上限
  limitMissing: boolean; // LIMITED/OPEN 但抽不到单日上限 → 额度待核验，绝不臆造金额
  minPurchase: number | null;
  limitText: string | null; // 例如 "10 元"
  directLimitText: string | null; // 直销渠道限额文案（手工维护）
  directAnnTitle: string | null; // 直销/限购公告标题
  directAnnUrl: string | null; // 公告原文链接
  channelHighlight: 'agency' | 'direct' | null;
  history: DayPoint[]; // 最近 30 天（含今日），从旧到新
}

/** 某一天的完整日报快照 */
export interface DailySnapshot {
  snapDate: string;
  shares: FundShare[];
  monitoredCount: number; // 监控的份额总数
}
