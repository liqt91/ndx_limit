import type { PurchaseStatus } from '../data/types';

/** 完整状态文案（详情/表格用） */
export const STATUS_LABEL: Record<PurchaseStatus, string> = {
  OPEN: '开放申购',
  LIMITED: '限额申购',
  STOPPED: '暂停申购',
  CLOSED: '封闭期',
  UNKNOWN: '额度未公布',
};

/** 短状态文案（列表/概览用，状态即信息，不只靠颜色） */
export const STATUS_SHORT: Record<PurchaseStatus, string> = {
  OPEN: '可投',
  LIMITED: '限大额',
  STOPPED: '暂停',
  CLOSED: '封闭',
  UNKNOWN: '未公布',
};

/** 状态文字配色类（低饱和，仅作辅助，文字本身已说明含义）。
 *  ★ 2026-10-26：LIMITED（限额）不再跟 OPEN 共用 --ok 松绿，改用橄榄（--warn）——
 *    与家族卡上的「限额申购」标签同口径，也与额度热力条同一支颜色。
 *    同一页里「能买」原本有两支绿（松绿的字 / 橄榄的格子），读起来像没调准。 */
export function statusClass(s: PurchaseStatus): string {
  return s === 'STOPPED'
    ? 'st-stop'
    : s === 'CLOSED'
      ? 'st-closed'
      : s === 'UNKNOWN'
        ? 'st-unknown'
        : s === 'LIMITED'
          ? 'st-limit'
          : 'st-ok';
}

/**
 * 份额类别的固定次序：A → C → D → E → F → 其它。
 * 抓取顺序不靠谱——天弘纳斯达克100 的 D 类在 funds.json 里是独立条目，排出来是 D/A/C；
 * 读者要在一行里找「C 类」就得来回横跳。页面上永远按字母序排，位置就固定了。
 */
const CLASS_ORDER = 'ACDEFGHIJ';
export function classRank(cls: string): number {
  const i = CLASS_ORDER.indexOf((cls || '').toUpperCase());
  return i < 0 ? 99 : i;
}
