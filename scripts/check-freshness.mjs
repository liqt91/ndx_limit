#!/usr/bin/env node
// 发信前的「数据新鲜度」门禁。
//
// 为什么需要它：抓取（refresh.yml）与发信（broadcast.yml）拆成两个独立调度后，
// 发信侧不能假定抓取一定成功——必须自己验数据，否则一旦抓取失败，会拿昨天的数据
// 当今天发出去。所以门禁验证的是「事实」（history.json 的最新日期是不是「应有交易日」），
// 而不是「另一个 job 的状态」。
//
// ★ 2026-10-23 起**分指数判**：纳指100 与标普500 各抓各的，一个挂了不该连坐另一个。
//   以前 latestDate 不传 codes，标普500 有今天的点就能让整轮通过，纳指的旧数据照样被发出去。
//   现在每个指数各自回答「你的数据是今天的吗、覆盖率够吗」，结论写进 usable/degraded。
//
// 交易日意识：抓取（scrape.mjs）在非交易日会跳过、不写数据，history.json 最新日期
// 永远停在最近交易日。因此：
//   - 今天若是交易日：期望最新数据 == 今天；
//   - 今天若是休市日：期望最新数据 == 最近交易日（prevTradingDay）；并放行但置 skip=true，
//     让 Send 步骤跳过群发，避免周末/节假日刷「今日休市」邮件。
//
// 退出码（非 0 即拒绝发信）：
//   0  至少一个指数可用（部分不可用时输出 degraded=true，workflow 末尾会把这个 job 标红）
//   2  所有可发指数的数据都不是应有交易日（抓取失败/未跑完）—— 最常见
//   3  完全没有历史数据
//   4  覆盖率低于阈值（数据不完整）
//
// GITHUB_OUTPUT：
//   usable=<指数1,指数2>   本次允许发的指数 → 传给 send.mjs 的 DIGEST_INDICES
//   degraded=true|false    有指数被剔除（数据不可用）→ workflow 末尾标红，别让漏发静默
//   skip=true              今天休市，Send 步骤整体跳过
//
// 用法：
//   node scripts/check-freshness.mjs                 生产用
//   node scripts/check-freshness.mjs --allow-stale   本地调试用，日期不符只警告
//
// 依赖：仅 Node 22 内置（复用 digest.mjs 的口径，避免覆盖率/新鲜度算法两处漂移）。

import fs from 'node:fs';
import { readJson, evaluateFreshness, loadHolidays, todayShanghai, INDEX_KEYS, INDEX_LABEL, MIN_COVERAGE } from './digest.mjs';

const ALLOW_STALE = process.argv.includes('--allow-stale');

const history = readJson('history.json', {});
const funds = readJson('funds.json', { funds: [] }).funds;
const meta = readJson('fund-meta.json', {});

const holidays = loadHolidays();
const today = todayShanghai();
const fres = evaluateFreshness({ funds, history, meta, today, holidays });

function out(pairs) {
  if (!process.env.GITHUB_OUTPUT) return;
  for (const [k, v] of Object.entries(pairs)) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);
}

console.log(`today (Asia/Shanghai) = ${today} ${fres.trading ? '(交易日)' : '(非交易日)'}`);
console.log(`expected latest date  = ${fres.expected || '(无)'}`);

for (const k of INDEX_KEYS) {
  const r = fres.byIndex[k];
  const flags = [
    `最新 ${r.date || '(空)'}`,
    `覆盖率 ${(r.coverage * 100).toFixed(1)}%（阈值 ${(MIN_COVERAGE * 100).toFixed(0)}%）`,
    r.fresh ? '新鲜' : '过期',
    r.covered ? '完整' : '不完整',
  ].join('  ');
  console.log(`- ${INDEX_LABEL[k]}（${r.codes} 份额）：${flags}`);
}

// 可用 = 「日期对得上（或 --allow-stale）」且「覆盖率达标」。两个条件缺一不可：
// 只有日期对但覆盖率 60% 的信，会把「大部分基金暂停」当成事实发给读者。
const usable = INDEX_KEYS.filter((k) => {
  const r = fres.byIndex[k];
  return (r.fresh || (ALLOW_STALE && !!r.date)) && r.covered;
});
const dropped = INDEX_KEYS.filter((k) => !usable.includes(k));

if (!usable.length) {
  const allNoHistory = INDEX_KEYS.every((k) => fres.byIndex[k].problems.includes('no-history'));
  const anyStale = INDEX_KEYS.some((k) => fres.byIndex[k].problems.includes('stale'));
  if (allNoHistory) {
    console.error('✗ 没有任何历史数据，拒绝发信。');
    process.exit(3);
  }
  if (anyStale) {
    const msg = INDEX_KEYS.filter((k) => fres.byIndex[k].problems.includes('stale'))
      .map((k) => `${INDEX_LABEL[k]} 最新 ${fres.byIndex[k].date}，期望 ${fres.expected}`)
      .join('；');
    console.error(`✗ ${msg}。数据缺失或抓取未跑完，拒绝发信——宁可当天不发，也不把旧数据当今天推出去。`);
    process.exit(2);
  }
  console.error(`✗ 人民币覆盖率低于阈值，数据不完整，拒绝发信。`);
  process.exit(4);
}

if (dropped.length) {
  // 部分剔除不阻断另一个指数，但必须留下明显痕迹：workflow 末尾的 gate 步骤会因此变红，
  // 顺便在 Actions 页面上打一条 annotation——日志里一行 warning 没人会翻。
  const why = dropped.map((k) => `${INDEX_LABEL[k]}（${fres.byIndex[k].problems.join('/')}）`).join('、');
  console.warn(`⚠ 本次剔除 ${why}：这些指数的订户今天收不到信，其余指数照常发。`);
  if (process.env.GITHUB_ACTIONS === 'true') console.log(`::warning title=有指数被剔除::${why} 的订户今天收不到日报`);
  out({ degraded: 'true' });
} else {
  out({ degraded: 'false' });
}
out({ usable: usable.join(',') });

if (!fres.trading) {
  console.log(`✓ 今日休市，使用最近交易日数据，跳过群发。`);
  out({ skip: 'true' });
}

console.log(`✓ 门禁通过：本次可发 ${usable.map((k) => INDEX_LABEL[k]).join(' + ') || '(无)'}。`);
