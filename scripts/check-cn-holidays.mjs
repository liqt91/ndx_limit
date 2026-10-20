#!/usr/bin/env node
// A 股「休市日 ↔ 休市日名称」一致性校验。
//
// 为什么需要：日历悬停提示那句原因，来自 data/calendars/cn-holiday-names.json；
// 而「这天到底休不休」来自 data/market-holidays.json。两份文件一旦不同步，
// 页面会一本正经地说错话——比如名称表多写了一天，那天提示「国庆假期」，
// 但 A 股其实开市，读者据此错过一个交易日。
//
// 三个方向都查：
//   1. 名称区间里的每个工作日，market-holidays 必须真的休市
//   2. market-holidays 里每个工作日休市日，必须有名称（否则提示只能含糊说「法定假日」）
//   3. 区间之间不许重叠、不许倒序、年份必须落在 cn-coverage 的覆盖年份里
//
// 零依赖、零联网：只读仓库里的三个 JSON。
// 用法：node scripts/check-cn-holidays.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

function fail(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

// 星期几：0=周日。纯字符串 + UTC，不受运行机器时区影响（与 src/data/dates.ts 同口径）
function dowOf(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function shiftDate(date, days) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

const isWorkday = (date) => {
  const w = dowOf(date);
  return w !== 0 && w !== 6;
};

const holidays = new Set(readJson('data/market-holidays.json'));
const names = readJson('data/calendars/cn-holiday-names.json');
const coverage = readJson('data/calendars/cn-coverage.json');

const problems = [];
const named = new Map(); // date -> name
let spanCount = 0;
let spanDayCount = 0;

for (const [year, spans] of Object.entries(names.years ?? {})) {
  if (!coverage.years?.[year]) {
    problems.push(`${year} 年在 cn-holiday-names.json 里有假期，但 cn-coverage.json 没声明该年覆盖`);
  }
  for (const span of spans) {
    spanCount++;
    const { from, to, name } = span;
    if (!name) problems.push(`${from} 起的区间没有 name`);
    if (from > to) problems.push(`${name}：from ${from} 晚于 to ${to}`);
    if (from.slice(0, 4) !== year || to.slice(0, 4) !== year) {
      problems.push(`${name}：区间 ${from}~${to} 跨了年份，请拆成两段（按年归档才查得出漏项）`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      problems.push(`${name}：日期格式必须是 YYYY-MM-DD`);
      continue;
    }

    for (let d = from; d <= to; d = shiftDate(d, 1)) {
      spanDayCount++;
      if (named.has(d)) {
        problems.push(`${d} 被两个假期区间同时覆盖：${named.get(d)} / ${name}`);
      }
      named.set(d, name);
      // 方向一：名称说有假，日期表必须也休市
      if (isWorkday(d) && !holidays.has(d)) {
        problems.push(`${d}（${name}）在名称表里算假期，但 market-holidays.json 里没有这天——A 股其实开市`);
      }
    }
  }
}

// 方向二：日期表说休市的工作日，必须有名字
const missing = [];
for (const d of holidays) {
  if (!isWorkday(d)) continue; // 周末本来就休，不需要名字
  if (!named.has(d)) missing.push(d);
}
if (missing.length) {
  problems.push(
    `${missing.length} 个工作日休市日没有名称，悬停提示只能含糊说「法定假日」：${missing.sort().join('、')}`
  );
}

// 方向三：日期表与名称表的年份覆盖应当一致
const holidayYears = [...new Set([...holidays].map((d) => d.slice(0, 4)))].sort();
const namedYears = Object.keys(names.years ?? {}).sort();
if (holidayYears.join() !== namedYears.join()) {
  problems.push(`年份不一致：market-holidays 有 ${holidayYears.join('、')}，名称表有 ${namedYears.join('、')}`);
}

if (problems.length) {
  fail(`A 股休市日与名称表不一致（${problems.length} 处）：\n  · ${problems.join('\n  · ')}`);
}

const workdayHolidays = [...holidays].filter(isWorkday).length;
console.log(
  `✓ A 股假日校验通过：${holidayYears.join('/')} 共 ${spanCount} 个假期区间、${spanDayCount} 个自然日；` +
    `其中工作日休市 ${workdayHolidays} 天，全部有名称，且没有一个落在开市日`
);
