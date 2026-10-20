// 交易日判定的「口径事实」——只放能对外讲、且会被页面文案引用的数字。
//
// 为什么要有这个文件：口径文案里出现的年份范围必须来自数据，不能写死在模板里。
// 否则明年公告更新、文案还写着旧年份，它就变成了新的错误信息源。
//
// 现状：日历还没落地（方案 B 的 S1），这里先手写常量。
// S1 落地后改成本文件的 loader —— 读 data/calendars/us-nasdaq.json 的
// coveredFrom / coveredTo / verifiedThrough，以及 cn-fund-announced.json 的条目数。
// 对外契约（字段名与语义）保持不变，页面无需改动。

export interface CalendarFacts {
  /** 美股日历中「已由交易所官方公告逐日核对」的起止年份 */
  usVerifiedFromYear: number;
  usVerifiedToYear: number;
  /** 这份日历的外推终点（规则推导，无官方背书） */
  usCoveredToYear: number;
}

export const CALENDAR_FACTS: CalendarFacts = {
  usVerifiedFromYear: 2026,
  usVerifiedToYear: 2028,
  usCoveredToYear: 2035,
};
