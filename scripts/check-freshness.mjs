#!/usr/bin/env node
// 发信前的「数据新鲜度」门禁。
//
// 为什么需要它：抓取（refresh.yml）与发信（broadcast.yml）拆成两个独立调度后，
// 发信侧不能假定抓取一定成功——必须自己验数据，否则一旦抓取失败，会拿昨天的数据
// 当今天发出去。所以门禁验证的是「事实」（history.json 的最新日期是不是今天），
// 而不是「另一个 job 的状态」。
//
// 退出码（与 scrape 门禁风格一致，非 0 即拒绝发信）：
//   0  通过
//   2  最新数据不是今天（抓取失败/未跑完）—— 最常见
//   3  完全没有历史数据
//   4  人民币覆盖率低于阈值（数据不完整）
//
// 用法：
//   node scripts/check-freshness.mjs                 生产用，日期必须等于今天
//   node scripts/check-freshness.mjs --allow-stale   本地调试用，日期不符只警告
//
// 依赖：仅 Node 22 内置（复用 digest.mjs 的口径，避免覆盖率算法两处漂移）。

import { readJson, latestDate, todayShanghai, computeCoverage, MIN_COVERAGE } from './digest.mjs';

const ALLOW_STALE = process.argv.includes('--allow-stale');

const history = readJson('history.json', {});
const funds = readJson('funds.json', { funds: [] }).funds;
const meta = readJson('fund-meta.json', {});

const today = todayShanghai();
const date = latestDate(history);
const coverage = computeCoverage(funds, meta);

console.log(`today (Asia/Shanghai) = ${today}`);
console.log(`history latest date   = ${date || '(空)'}`);
console.log(`CNY coverage          = ${(coverage * 100).toFixed(1)}% (阈值 ${(MIN_COVERAGE * 100).toFixed(0)}%)`);

if (!date) {
  console.error('✗ 没有任何历史数据，拒绝发信。');
  process.exit(3);
}

if (date !== today) {
  const msg = `✗ 最新数据是 ${date}，不是今天 ${today}：抓取可能失败或尚未跑完。`;
  if (ALLOW_STALE) {
    console.warn(`⚠ ${msg}（--allow-stale，仅本地调试放行）`);
  } else {
    console.error(`${msg} 拒绝发信——宁可当天不发，也不把旧数据当今天推出去。`);
    process.exit(2);
  }
}

if (coverage < MIN_COVERAGE) {
  console.error(`✗ 人民币覆盖率 ${(coverage * 100).toFixed(1)}% 低于阈值，数据不完整，拒绝发信。`);
  process.exit(4);
}

console.log('✓ 门禁通过：数据是今天的，覆盖率达标。');
