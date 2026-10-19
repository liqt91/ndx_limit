// 日期工具：统一使用东八区（Asia/Shanghai）日期，避免构建机时区导致「今日」漂移。

/** 当前东八区日期 YYYY-MM-DD */
export function todayCST(): string {
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
