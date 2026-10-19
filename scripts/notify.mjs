#!/usr/bin/env node
// 变化通知脚本：在 CI 构建后（或本地）运行，读取 data/history.json + funds.json，
// 计算人民币份额覆盖率和「今日 vs 昨日」变化；仅当数据健康（覆盖率达标）且确有变化时才推送。
//
// 设计对齐 qdii-purchase-limits 的门禁：数据不完整（覆盖率低于阈值）或没有变化 → 不发送，
// 避免「假开关」：要么不发，要么发的是可信结论。
//
// 用法：
//   node scripts/notify.mjs                 # 推送（需 NOTIFY_WEBHOOK 环境变量）
//   NOTIFY_WEBHOOK=https://open.feishu...  node scripts/notify.mjs
//   node scripts/notify.mjs --dry-run       # 只打印待发送内容，不请求网络
//
// 通知格式默认按「飞书自定义机器人」text 消息构造；其它 webhook 服务若接受相同 JSON 也可直接用。
//
// 依赖：仅 Node 22 内置。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'data');

const MIN_COVERAGE = Number(process.env.SCRAPE_MIN_COVERAGE ?? 0.9);
const DRY_RUN = process.argv.includes('--dry-run');
const WEBHOOK = process.env.NOTIFY_WEBHOOK || '';

function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8'));
  } catch {
    return fallback;
  }
}

function classifyChange(from, to) {
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

function main() {
  const funds = readJson('funds.json', { funds: [] }).funds;
  const history = readJson('history.json', {});
  const meta = readJson('fund-meta.json', {});

  if (!Object.keys(history).length) {
    console.log('ℹ 无抓取历史，跳过通知。');
    return;
  }

  // 人民币覆盖率（与 scrape 门禁口径一致）
  let cnyTargets = 0;
  let cnyOk = 0;
  const codeCurrency = new Map();
  for (const f of funds)
    for (const c of f.codes) {
      codeCurrency.set(c.code, f.currency);
      if (f.currency !== 'USD') cnyTargets++;
    }
  for (const code in meta) if (codeCurrency.get(code) !== 'USD' && meta[code] && meta[code].name) cnyOk++;
  const coverage = cnyTargets ? cnyOk / cnyTargets : 1;

  if (coverage < MIN_COVERAGE) {
    console.log(
      `ℹ 覆盖率 ${(coverage * 100).toFixed(1)}% < 阈值 ${(MIN_COVERAGE * 100).toFixed(0)}%，数据不完整，不发送通知。`
    );
    return;
  }

  // 变化检测（仅人民币，至少两天）
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

  if (!changes.length) {
    console.log('ℹ 今日无变化，不发送通知。');
    return;
  }

  changes.sort((a, b) => kindOrder(a.kind) - kindOrder(b.kind) || a.name.localeCompare(b.name));

  const opened = changes.filter((c) => c.kind === 'opened').length;
  const stopped = changes.filter((c) => c.kind === 'stopped').length;
  const limitChanged = changes.filter((c) => ['limit-up', 'limit-down', 'limit-set', 'limit-clear'].includes(c.kind)).length;
  const date = changes[0].to.date;

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

  const msg =
    `【纳指开门日报 · ${date}】\n` +
    `较 ${prevDate}：${opened} 家开门 · ${stopped} 家暂停 · ${limitChanged} 家额度变动\n\n` +
    lines.join('\n');

  if (DRY_RUN || !WEBHOOK) {
    console.log(msg);
    console.log(`\nℹ ${DRY_RUN ? 'dry-run' : '未配置 NOTIFY_WEBHOOK'}，仅打印，未发送。`);
    return;
  }

  fetch(WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msg_type: 'text', content: { text: msg } }),
  })
    .then((r) => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      console.log('✓ 通知已发送。');
    })
    .catch((e) => {
      console.error('✗ 通知发送失败：', e.message || e);
      process.exit(1);
    });
}

function kindOrder(k) {
  return (
    { opened: 0, stopped: 1, 'limit-up': 2, 'limit-down': 3, 'limit-set': 4, 'limit-clear': 5, unknown: 6, other: 7 }[k] ?? 9
  );
}

main();
