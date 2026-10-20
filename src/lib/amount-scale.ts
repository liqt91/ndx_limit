/**
 * 额度 → 颜色档：全站唯一口径。
 *
 * 分档是「左开右闭」的固定阈值：[…,30] (30,300] (300,600] (600,∞)
 * 也就是说 30 元还算第一档、300 元算第二档、600 元算第三档。
 * （定稿时从「左闭右开」翻过来的：20 元和 30 元都是「几十块」，量级相同，
 *   把它们劈成两种颜色，读者看不出道理；上百、几百才是真正的台阶。）
 *
 * 阈值固定，不跟当期最大值缩放。柱状图时代标尺是 `max(家族合计)` 取整到 10 的倍数，
 * 分母随数据漂：今天 400 满格、明天 20 满格，同一个高度在两页里是不同金额，
 * 而且图例得跟着换（「柱高 400 元满格」）。固定阈值让 20 元和 400 元在哪儿都同一个色。
 */
export const LIMIT_STOPS = [30, 300, 600] as const;

/** 四档的边界文案（图例、悬停、无障碍读屏共用） */
export const LIMIT_LABELS = ['≤ 30', '30–300', '300–600', '> 600'] as const;

export type HeatLevel = 1 | 2 | 3 | 4;

/**
 * 额度落在第几档；null 表示「没有额度数字」，颜色不管，交给纹理。
 * 0 元（能买但当天额度是 0）属于第一档，不是 null。
 */
export function heatLevel(limit: number | null | undefined): HeatLevel | null {
  if (limit == null || !Number.isFinite(limit)) return null;
  let level = 1;
  for (const stop of LIMIT_STOPS) if (limit > stop) level++;
  return level as HeatLevel;
}
