import type { DailySnapshot, FundShare, DayPoint } from './types';
import { lastNDates } from './dates';
import fs from 'node:fs';
import path from 'node:path';

// 兜底数据生成器：仅在「没有真实抓取历史」时（本地首次 build / 未跑 scrape）使用。
// 真实数据接入后由 loader 直接读 data/history.json，不再走这里。

const HISTORY_DAYS = 30;
export const MAX_CAP = 10000;

function readFunds(): any[] {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'funds.json'), 'utf8'));
    return raw.funds || [];
  } catch {
    return [];
  }
}

// 确定性哈希：同一个 (code+date) 永远得到同一个 0..1 值，保证每次构建可复现。
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

function genDay(code: string, date: string): DayPoint {
  const r = hashStr(`${code}@${date}`);
  if (r < 0.12) return { date, status: 'STOPPED', limit: null };
  if (r > 0.93) return { date, status: 'LIMITED', limit: 100 };
  return { date, status: 'LIMITED', limit: 10 };
}

/** 根据「构建日」生成一份日报快照（兜底用）。 */
export function buildSnapshot(today: string): DailySnapshot {
  const dates = lastNDates(HISTORY_DAYS, today);
  const funds = readFunds();
  const shares: FundShare[] = [];

  for (const f of funds) {
    for (const c of f.codes) {
      const history = dates.map((date) => genDay(c.code, date));
      const last = history[history.length - 1];
      shares.push({
        code: c.code,
        shortName: `${f.company}${f.baseName}${f.currency === 'USD' ? '美元' : ''}${c.cls}类`,
        company: f.company,
        baseName: f.baseName,
        indexKey: f.indexKey,
        shareClass: c.cls,
        currency: f.currency,
        purchaseStatus: last.status,
        dailyLimit: last.limit,
        minPurchase: last.limit != null ? 1 : null,
        limitText: last.limit != null ? `${last.limit} 元` : null,
        directLimitText: null,
        directAnnTitle: null,
        directAnnUrl: null,
        channelHighlight: 'agency',
        history,
      });
    }
  }

  return { snapDate: today, shares, monitoredCount: shares.length };
}
