// 日期工具：所有「今天是哪天」统一走东八区；所有「这天是星期几」统一走 UTC。
// 两者都不能碰构建机的本地时区——CI 跑在 UTC，本地开发跑在 UTC+8，混用必然差一天。

/** 当前东八区日期 YYYY-MM-DD */
export function todayCST(): string {
  // 调试/预览用：设 N8X_TODAY=YYYY-MM-DD 可覆盖「今天」，便于在任意日期下检视首页渲染。
  const forced = process.env.N8X_TODAY;
  if (forced && /^\d{4}-\d{2}-\d{2}$/.test(forced)) return forced;
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === 'year')!.value;
  const m = parts.find((p) => p.type === 'month')!.value;
  const d = parts.find((p) => p.type === 'day')!.value;
  return `${y}-${m}-${d}`;
}

// ──────────────────────────────────────────────────────────────
// 日期基本运算：只用字符串 + UTC，禁止依赖构建机时区
//
// 曾经的写法是 `new Date(date + 'T00:00:00+08:00').getDay()`——在 UTC 构建机上
// 它把时刻回退到前一天的 16:00，于是「周一」被判成「周日」：
//   · 抓取侧：周一不抓（等于每周少一天数据）
//   · 反向：周六被判成周五（等于周六照常抓取）
//   · 展示侧：「10月20日 周二」被渲染成「10月19日 周一」
// 本地开发机在 UTC+8 完全看不出问题，CI 一跑就错。凡是「这个日期是星期几」
// 的计算，一律走下面的 UTC 版本（scripts/digest.mjs 里是同一份实现，改一处必须改两处）。
// ──────────────────────────────────────────────────────────────

/** 星期几：0=周日 … 6=周六。与时区无关。 */
export function dowOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** 日期加减天数，返回 YYYY-MM-DD。与时区无关。 */
export function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** 返回 end 当天及往前 (n-1) 天，从旧到新，例如 lastNDates(3,'2026-10-18') => ['2026-10-16','2026-10-17','2026-10-18'] */
export function lastNDates(n: number, end: string): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(shiftDate(end, -i));
  return out;
}

/** 中文「10月18日 周日」 */
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
export function prettyDateCST(date: string): string {
  const [, m, d] = date.split('-').map(Number);
  return `${m}月${d}日 ${WEEK[dowOf(date)]}`;
}

// ──────────────────────────────────────────────────────────────
// 交易日判定（仅 A 股口径，供抓取与首页门禁使用）
//
// 中国 A股休市日来源：data/market-holidays.json
//   - 2026：国务院办公厅已公布的官方放假安排
//   - 2027：按公开预排口径整理（见 data/calendars/cn-coverage.json）
// 集合只列「法定休市日」；周末由星期判断自动覆盖，二者取并集即非交易日。
// 调休补班日若落在周末，市场仍休市，因此无需单独处理补班日。
//
// 「沪纽双市场」的完整四态判定在 src/data/trading-days.ts，别在这里加美股逻辑。
// ──────────────────────────────────────────────────────────────

/** 是否为交易日：工作日 且 非法定休市日。holidays 为 market-holidays.json 解析出的集合。 */
export function isTradingDay(date: string, holidays: Set<string>): boolean {
  const dow = dowOf(date);
  if (dow === 0 || dow === 6) return false; // 周末
  return !holidays.has(date);
}

/** 返回 date 之前最近的一个交易日（含回退最多 30 天）；找不到返回 null。 */
export function prevTradingDay(date: string, holidays: Set<string>): string | null {
  for (let i = 1; i <= 30; i++) {
    const cand = shiftDate(date, -i);
    if (isTradingDay(cand, holidays)) return cand;
  }
  return null;
}
