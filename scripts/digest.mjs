// 每日日报构建模块：读取 data/，计算人民币覆盖率与「今日 vs 昨日」变化，
// 产出要发送的标题与正文。通知（notify.mjs，管理员自通知）与群发（broadcast.mjs，订阅人）
// 共用本模块，保证两者口径一致、不会漂移。
//
// 设计对齐 scrape 门禁：覆盖率低于阈值视为数据不完整（healthy=false），调用方据此不发送误导内容。
// 「无变化」也产出文本（含「今日无变化」说明），由 broadcast 决定仍群发。
//
// 依赖：仅 Node 22 内置。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'data');

export const MIN_COVERAGE = Number(process.env.SCRAPE_MIN_COVERAGE ?? 0.9);

export function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8'));
  } catch {
    return fallback;
  }
}

export function classifyChange(from, to) {
  const fromBuy = from.status === 'OPEN' || from.status === 'LIMITED';
  const toBuy = to.status === 'OPEN' || to.status === 'LIMITED';
  if (to.status === 'UNKNOWN' && from.status !== 'UNKNOWN') return 'unknown';
  if (!fromBuy && toBuy) return 'opened';
  if (fromBuy && !toBuy) return 'stopped';
  if (fromBuy && toBuy) {
    if (from.limit == null && to.limit != null) return 'limit-set';
    if (from.limit != null && to.limit == null) return 'limit-clear';
    if (from.limit != null && to.limit != null && from.limit !== to.limit)
      return to.limit > from.limit ? 'limit-up' : 'limit-down';
  }
  return 'other';
}

export function kindOrder(k) {
  return (
    { opened: 0, stopped: 1, 'limit-up': 2, 'limit-down': 3, 'limit-set': 4, 'limit-clear': 5, unknown: 6, other: 7 }[k] ?? 9
  );
}

// 全量历史里最新的那一天（YYYY-MM-DD）。用于判断数据是不是「今天的」。
export function latestDate(history) {
  let max = '';
  for (const code in history) {
    const arr = history[code];
    if (Array.isArray(arr) && arr.length) {
      const d = arr[arr.length - 1].date;
      if (d > max) max = d;
    }
  }
  return max;
}

// 北京时间的今天（YYYY-MM-DD）。scrape 写数据用的是同一口径，两边必须一致。
export function todayShanghai() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
}

// 人民币份额覆盖率（分母只算人民币份额，与 scrape 门禁口径一致）。
export function computeCoverage(funds, meta) {
  let cnyTargets = 0;
  let cnyOk = 0;
  const codeCurrency = new Map();
  for (const f of funds)
    for (const c of f.codes) {
      codeCurrency.set(c.code, f.currency);
      if (f.currency !== 'USD') cnyTargets++;
    }
  for (const code in meta) if (codeCurrency.get(code) !== 'USD' && meta[code] && meta[code].name) cnyOk++;
  return cnyTargets ? cnyOk / cnyTargets : 1;
}

// 交易日判定（与 src/data/dates.ts、scripts/scrape.mjs 同源：data/market-holidays.json）。
// 交易日 = 工作日 且 非法定休市日；调休补班日若在周末市场仍休市，无需单独处理。
export function loadHolidays() {
  return new Set(readJson('market-holidays.json', []));
}
export function isTradingDay(date, holidays) {
  const dow = new Date(date + 'T00:00:00+08:00').getDay();
  if (dow === 0 || dow === 6) return false; // 周末
  return !holidays.has(date);
}
export function prevTradingDay(date, holidays) {
  const dt = new Date(date + 'T00:00:00+08:00');
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

// 返回结构化日报。healthy=false 时 text 为数据异常提示；无论有无变化都返回 text（无变化含说明）。
export function buildDailyDigest() {
  const funds = readJson('funds.json', { funds: [] }).funds;
  const history = readJson('history.json', {});
  const meta = readJson('fund-meta.json', {});

  if (!Object.keys(history).length) {
    return { healthy: false, noChange: true, date: '', subject: '纳指开门日报', text: 'ℹ 暂无抓取历史，日报暂缓。', changes: [] };
  }

  const coverage = computeCoverage(funds, meta);
  const date = latestDate(history);

  if (coverage < MIN_COVERAGE) {
    return {
      healthy: false,
      noChange: true,
      coverage,
      date,
      subject: '纳指开门日报 · 数据暂缓',
      text: `⚠️ 今日数据抓取覆盖率 ${(coverage * 100).toFixed(1)}% 低于阈值 ${(MIN_COVERAGE * 100).toFixed(0)}%，日报暂缓，明日恢复。`,
      changes: [],
    };
  }

  const changes = [];
  let prevDate = null;
  for (const f of funds) {
    if (f.currency === 'USD') continue;
    for (const c of f.codes) {
      const arr = history[c.code];
      if (!arr || arr.length < 2) continue;
      if (!prevDate) prevDate = arr[arr.length - 2].date;
      const to = arr[arr.length - 1];
      const from = arr[arr.length - 2];
      const kind = classifyChange(from, to);
      if (kind === 'other') continue;
      const name = (meta[c.code] && meta[c.code].name) || `${f.company}${f.baseName}${c.cls}类`;
      changes.push({ name, from, to, kind });
    }
  }

  changes.sort((a, b) => kindOrder(a.kind) - kindOrder(b.kind) || a.name.localeCompare(b.name));

  const opened = changes.filter((c) => c.kind === 'opened').length;
  const stopped = changes.filter((c) => c.kind === 'stopped').length;
  const limitChanged = changes.filter((c) => ['limit-up', 'limit-down', 'limit-set', 'limit-clear'].includes(c.kind)).length;

  const lines = changes.map((c) => {
    switch (c.kind) {
      case 'opened':
        return `✅ 开门：${c.name}${c.to.limit != null ? `（限大额 ${c.to.limit}元）` : ''}`;
      case 'stopped':
        return `⛔ 暂停：${c.name}`;
      case 'limit-up':
        return `🔺 额度上调：${c.name}（${c.from.limit}元→${c.to.limit}元）`;
      case 'limit-down':
        return `🔻 额度下调：${c.name}（${c.from.limit}元→${c.to.limit}元）`;
      case 'limit-set':
        return `🔒 新限额：${c.name}（${c.to.limit}元）`;
      case 'limit-clear':
        return `🔓 取消限额：${c.name}`;
      case 'unknown':
        return `❓ 数据待核验：${c.name}`;
      default:
        return `• ${c.name}`;
    }
  });

  const text = changes.length
    ? `【纳指开门日报 · ${date}】\n较 ${prevDate}：${opened} 家开门 · ${stopped} 家暂停 · ${limitChanged} 家额度变动\n\n` + lines.join('\n')
    : `【纳指开门日报 · ${date}】\n较 ${prevDate}：今日无变化，所有纳指 QDII 额度状态与昨日一致。`;

  return { healthy: true, noChange: changes.length === 0, coverage, date, prevDate, subject: `纳指开门日报 · ${date}`, text, changes };
}
