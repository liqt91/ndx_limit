import fs from 'node:fs';
import path from 'node:path';
import type { DailySnapshot, FundShare, DayPoint } from './types';
import { buildSnapshot } from './mock'; // 兜底：无真实数据时
import { todayCST, lastNDates, prettyDateCST } from './dates';

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

export function getToday(): string {
  return todayCST();
}

function assemble(today: string): DailySnapshot {
  const funds = readJson<{ funds: any[] }>('funds.json', { funds: [] }).funds;
  const history = readJson<Record<string, DayPoint[]>>('history.json', {});
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
  const history = readJson<Record<string, DayPoint[]>>('history.json', {});
  const hasRealData = Object.keys(history).length > 0;
  // 有真实抓取历史 → 用真实数据；否则回退 mock，保证本地/首次也能 build。
  return hasRealData ? assemble(getToday()) : buildSnapshot(getToday());
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
  const history = readJson<Record<string, DayPoint[]>>('history.json', {});
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
