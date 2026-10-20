#!/usr/bin/env node
// 发信前的「数据新鲜度」门禁。
//
// 为什么需要它：抓取（refresh.yml）与发信（broadcast.yml）拆成两个独立调度后，
// 发信侧不能假定抓取一定成功——必须自己验数据，否则一旦抓取失败，会拿昨天的数据
// 当今天发出去。所以门禁验证的是「事实」（history.json 的最新日期是不是「应有交易日」），
// 而不是「另一个 job 的状态」。
//
// 交易日意识：抓取（scrape.mjs）在非交易日会跳过、不写数据，history.json 最新日期
// 永远停在最近交易日。因此：
//   - 今天若是交易日：期望最新数据 == 今天；
//   - 今天若是休市日：期望最新数据 == 最近交易日（prevTradingDay）；并放行但置 skip=true，
//     让 Send 步骤跳过群发，避免周末/节假日刷「今日休市」邮件。
//
// 退出码（与 scrape 门禁风格一致，非 0 即拒绝发信）：
//   0  通过（交易日数据新鲜，或休市日已用最近交易日数据）
//   2  最新数据不是应有交易日（抓取失败/未跑完）—— 最常见
//   3  完全没有历史数据
//   4  人民币覆盖率低于阈值（数据不完整）
//
// 用法：
//   node scripts/check-freshness.mjs                 生产用
//   node scripts/check-freshness.mjs --allow-stale   本地调试用，日期不符只警告
//
// 依赖：仅 Node 22 内置（复用 digest.mjs 的口径，避免覆盖率算法两处漂移）。

import fs from 'node:fs';
import { readJson, latestDate, todayShanghai, computeCoverage, MIN_COVERAGE, loadHolidays, isTradingDay, prevTradingDay } from './digest.mjs';

const ALLOW_STALE = process.argv.includes('--allow-stale');

const history = readJson('history.json', {});
const funds = readJson('funds.json', { funds: [] }).funds;
const meta = readJson('fund-meta.json', {});

const holidays = loadHolidays();
const today = todayShanghai();
const date = latestDate(history);
const coverage = computeCoverage(funds, meta);

const trading = isTradingDay(today, holidays);
// 非交易日时，最新数据应为「最近交易日」而非今天
const expected = trading ? today : prevTradingDay(today, holidays);

console.log(`today (Asia/Shanghai) = ${today} ${trading ? '(交易日)' : '(非交易日)'}`);
console.log(`history latest date   = ${date || '(空)'}`);
console.log(`expected latest date  = ${expected || '(无)'}`);
console.log(`CNY coverage          = ${(coverage * 100).toFixed(1)}% (阈值 ${(MIN_COVERAGE * 100).toFixed(0)}%)`);

if (!date) {
  console.error('✗ 没有任何历史数据，拒绝发信。');
  process.exit(3);
}

if (date !== expected) {
  const msg = `✗ 最新数据是 ${date}，期望 ${expected}（今日 ${today}${trading ? '' : ' 休市'}）。数据缺失或抓取未跑完。`;
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

if (!trading) {
  console.log(`✓ 今日休市，使用最近交易日 ${date} 数据，跳过群发。`);
  // 通过 GITHUB_OUTPUT 告知 Send 步骤跳过（broadcast.yml 的 Send 步骤 if 判断 skip != 'true'）
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'skip=true\n');
}

console.log('✓ 门禁通过：数据是最新交易日的，覆盖率达标。');
