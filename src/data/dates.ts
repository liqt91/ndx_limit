// 日期工具：统一使用东八区（Asia/Shanghai）日期，避免构建机时区导致「今日」漂移。

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

/** 返回 end 当天及往前 (n-1) 天，从旧到新，例如 lastNDates(3,'2026-10-18') => ['2026-10-16','2026-10-17','2026-10-18'] */
export function lastNDates(n: number, end: string): string[] {
  const out: string[] = [];
  const dt = new Date(`${end}T00:00:00+08:00`);
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(dt);
    d.setDate(dt.getDate() - i);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    out.push(`${y}-${m}-${day}`);
  }
  return out;
}

/** 中文「10月18日 周日」 */
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
export function prettyDateCST(date: string): string {
  const dt = new Date(`${date}T00:00:00+08:00`);
  const m = dt.getMonth() + 1;
  const d = dt.getDate();
  return `${m}月${d}日 ${WEEK[dt.getDay()]}`;
}

// ──────────────────────────────────────────────────────────────
// 交易日判定
//
// 中国 A股休市日来源：data/market-holidays.json
//   - 2026：国务院办公厅已公布的官方放假安排
//   - 2027：央行/票交所预设（官方通知尚未发布，待公布后核对）
// 集合只列「法定休市日」；周末由下面的星期判断自动覆盖，二者取并集即非交易日。
// 调休补班日若落在周末，市场仍休市，因此无需单独处理补班日。
//
// 交易日 = 周一至周五 且 不在休市日集合。
// ──────────────────────────────────────────────────────────────

/** 是否为交易日：工作日 且 非法定休市日。holidays 为 market-holidays.json 解析出的集合。 */
export function isTradingDay(date: string, holidays: Set<string>): boolean {
  const dt = new Date(`${date}T00:00:00+08:00`);
  const dow = dt.getDay();
  if (dow === 0 || dow === 6) return false; // 周末
  return !holidays.has(date);
}

/** 返回 date 之前最近的一个交易日（含回退最多 30 天）；找不到返回 null。 */
export function prevTradingDay(date: string, holidays: Set<string>): string | null {
  const dt = new Date(`${date}T00:00:00+08:00`);
  for (let i = 1; i <= 30; i++) {
    dt.setDate(dt.getDate() - 1);
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const d = String(dt.getDate()).padStart(2, '0');
    const cand = `${y}-${m}-${d}`;
    if (isTradingDay(cand, holidays)) return cand;
  }
  return null;
}
