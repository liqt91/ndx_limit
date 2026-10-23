#!/usr/bin/env node
// 多指数口径隔离门禁。
//
// 为什么需要它：2026-10-23 站内从「单一纳指」扩为「纳指100 + 标普500 两个分站」，
// 两个指数的份额共用同一份 data/history.json（按 code 平铺）与同一套聚合函数。
// 只要有一处聚合忘了带 indexKey，首屏就会把两个指数的份额加在一起——
// 页面照样渲染、数字照样像真的，是典型的静默错误。
//
// 本脚本检查的六件事（任何一条不成立都 exit 1）：
//   1. 每个 indexKey 的份额代码集合互不相交（同一只基金不能同时属于两个指数）
//   2. 覆盖率先天在 [0,1] 内——`codeCurrency.get(x) !== 'USD'` 这类写法会把
//      未收录的代码算成「本指数人民币抓取成功」，实测曾报出 161%
//   3. fetch-meta.runs[] 顶层聚合 == 默认指数（纳指）重算值（既有读取方靠它）
//   4. fetch-meta.runs[].byIndex[k] == k 的重算值
//   5. 若 dist/ 已构建：每个分站首页的家族数与「该指数 CNY + USD 家族数」逐项相等
//   6. 若 dist/ 已构建：每个分站首页不含对方指数的家族名（渲染层不串台）
//   7. 若 dist/ 已构建：路由结构——/ 与 /daily 是跳转壳，两个指数的历史页逐日数字
//      各自等于本指数重算值，共用页（/my）不带两个当前页
//
// 用法：
//   node scripts/check-index-isolation.mjs            # 有 dist 就一起验渲染层
//   node scripts/check-index-isolation.mjs --no-dist  # 只验数据层
//
// 依赖：仅 Node 22 内置。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, aggregateCny, computeCoverage, summarizeDay, NDX, SP500 } from './digest.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECK_DIST = !process.argv.includes('--no-dist');

let pass = 0;
const fails = [];
function ok(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ok  ${name}`);
  } else {
    fails.push(`${name}${detail ? ' — ' + detail : ''}`);
    console.log(`  ✗   ${name}${detail ? ' — ' + detail : ''}`);
  }
}
function eq(name, actual, expected) {
  ok(name, actual === expected, `实际 ${JSON.stringify(actual)} / 期望 ${JSON.stringify(expected)}`);
}

const funds = readJson('funds.json', { funds: [] }).funds;
const history = readJson('history.json', {});
const meta = readJson('fund-meta.json', {});
const fetchMeta = readJson('fetch-meta.json', {});

const indexes = [...new Set(funds.map((f) => f.indexKey))].sort();
console.log(`\n1. 名录结构（${indexes.join(' / ')}）`);
eq('至少两个指数', indexes.length >= 2, true);

const codesOf = (k) =>
  new Set(funds.filter((f) => f.indexKey === k).flatMap((f) => f.codes.map((c) => c.code)));

const codeSets = {};
for (const k of indexes) codeSets[k] = codesOf(k);
eq('纳指的份额数', codeSets[NDX]?.size, 60);
eq('标普500 的份额数', codeSets[SP500]?.size, 25);

for (let i = 0; i < indexes.length; i++) {
  for (let j = i + 1; j < indexes.length; j++) {
    const a = codeSets[indexes[i]];
    const b = codeSets[indexes[j]];
    const overlap = [...a].filter((c) => b.has(c));
    eq(`${indexes[i]} 与 ${indexes[j]} 的代码集合无交集`, overlap.length, 0);
  }
}

// 每只基金的代码必须是 6 位数字，且同一 indexKey 内不重复
for (const k of indexes) {
  const list = funds.filter((f) => f.indexKey === k).flatMap((f) => f.codes.map((c) => c.code));
  eq(`${k} 的代码格式全为 6 位数字`, list.every((c) => /^\d{6}$/.test(c)), true);
  eq(`${k} 的代码无重复`, new Set(list).size, list.length);
}

console.log('\n2. 覆盖率（必须各自独立且 ≤ 100%）');
for (const k of indexes) {
  const cov = computeCoverage(funds, meta, k);
  ok(`${k} 覆盖率 ${(cov * 100).toFixed(1)}% 在 [0,1] 内`, cov >= 0 && cov <= 1);
}

console.log('\n3. fetch-meta 顶层 = 默认指数（纳指）');
const runs = Array.isArray(fetchMeta.runs) ? fetchMeta.runs : [];
if (!runs.length) {
  console.log('  （无 runs，跳过：本地还没跑过 scrape）');
} else {
  const last = runs[runs.length - 1];
  // 只取「今天有数据」的份额重算，避免把某只基金的历史点算进今日聚合
  const todayPts = {};
  for (const code in history) {
    const arr = history[code];
    const tail = arr[arr.length - 1];
    if (tail && tail.date === fetchMeta.date) todayPts[code] = tail;
  }
  const ndx = aggregateCny(funds, todayPts, NDX);
  eq('顶层 opened == 纳指重算', last.opened, ndx.opened);
  eq('顶层 total == 纳指重算', last.total, ndx.total);
  eq('顶层 families == 纳指重算', last.families, ndx.families);

  console.log('\n4. fetch-meta.byIndex = 各非默认指数');
  for (const k of indexes) {
    if (k === NDX) continue;
    const want = aggregateCny(funds, todayPts, k);
    const got = last.byIndex?.[k];
    if (!got) {
      // 门禁丢弃该指数时会缺这个字段。此时该指数的 history 里也不该有今天的点——
      // 若两者同时成立（有数据点却没聚合），说明 scrape 忘了写 byIndex，是真 bug。
      const hasToday = [...codeSets[k]].some((c) => {
        const arr = history[c];
        return arr && arr[arr.length - 1] && arr[arr.length - 1].date === fetchMeta.date;
      });
      ok(`${k} 无 byIndex 时今日也不该有点（视为被门禁丢弃）`, !hasToday);
      continue;
    }
    eq(`${k}.opened == 重算`, got.opened, want.opened);
    eq(`${k}.total == 重算`, got.total, want.total);
    eq(`${k}.families == 重算`, got.families, want.families);
    ok(`${k} 不是纳指的子集（families 与本指数名录一致）`, got.families === want.families);
  }
}

console.log('\n5. 历史点覆盖');
for (const k of indexes) {
  const withToday = [...codeSets[k]].filter((c) => {
    const arr = history[c];
    return arr && arr[arr.length - 1] && arr[arr.length - 1].date === fetchMeta.date;
  });
  eq(`${k} 全部 ${codeSets[k].size} 个份额都带最新数据点 (${fetchMeta.date ?? '—'})`, withToday.length, codeSets[k].size);
}

if (CHECK_DIST) {
  const dist = path.join(ROOT, 'dist');
  if (!fs.existsSync(path.join(dist, 'ndx100', 'index.html'))) {
    console.log('\n6. 渲染层：dist/ 未构建，跳过（先 npm run build）');
  } else {
    console.log('\n6. 渲染层（dist）');
    const clean = (s) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const famNames = (html) =>
      [...html.matchAll(/<div class="fam-name">([\s\S]*?)<\/div>/g)].map((m) => clean(m[1]));

    const pages = [
      { file: path.join('ndx100', 'index.html'), key: NDX, brand: '纳指开门日报', other: '标普500' },
      { file: path.join('sp500', 'index.html'), key: SP500, brand: '标普500开门日报', other: '纳斯达克100' },
    ];
    for (const p of pages) {
      const full = path.join(dist, p.file);
      if (!fs.existsSync(full)) {
        ok(`${p.file} 存在`, false);
        continue;
      }
      const html = fs.readFileSync(full, 'utf8');
      const expectFams = new Set(
        funds.filter((f) => f.indexKey === p.key).map((f) => `${f.company}${f.baseName}${f.currency === 'USD' ? '美元' : ''}`)
      );
      const got = famNames(html);
      eq(`${p.file} 家族数 == ${p.key} 名录家族数`, got.length, expectFams.size);
      const extra = got.filter((n) => !expectFams.has(n));
      eq(`${p.file} 没有名录外的家族`, extra.length, 0);
      const missing = [...expectFams].filter((n) => !got.includes(n));
      eq(`${p.file} 名录内家族全部渲染`, missing.length, 0);
      // 标题与站名
      ok(`${p.file} <title> 是「${p.brand}」`, html.includes(`<title>${p.brand}</title>`));
      // 「对方指数的家族名」一个都不能出现
      const leaked = got.filter((n) =>
        p.key === NDX ? n.includes('标普500') : n.includes('纳斯达克')
      );
      eq(`${p.file} 未串入对方指数的家族`, leaked.length, 0);
    }

    // ── 7. 路由结构（2026-10-23 换域 + 路径重构后新增）──
    console.log('\n7. 路由结构');
    const readPage = (rel) => {
      const full = path.join(dist, rel);
      return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
    };

    // 7.1 根路径只是跳转壳：真内容在 /ndx100/，不能让搜索引擎把两个 URL 当两页
    const root = readPage('index.html');
    ok('dist/index.html 存在', root !== null);
    if (root) {
      ok('根路径跳转到 /ndx100/', root.includes('content="0; url=/ndx100/"'));
      ok('根路径 noindex（同一内容的第二个 URL 不该被收录）', root.includes('name="robots" content="noindex'));
      ok('根路径 canonical 指向 /ndx100/', /rel="canonical" href="[^"]*\/ndx100\/"/.test(root));
      ok('根路径仍带 og:image（贴链接不该是白卡）', root.includes('property="og:image"'));
    }

    // 7.2 旧路径不能 404
    const oldDaily = readPage(path.join('daily', 'index.html'));
    ok('/daily 兼容壳存在且跳 /ndx100/daily', !!oldDaily && oldDaily.includes('url=/ndx100/daily'));

    // 7.3 两套历史页：行数一致、逐日数字各自等于本指数重算值
    for (const k of indexes) {
      const rel = path.join(k === NDX ? 'ndx100' : 'sp500', 'daily', 'index.html');
      const html = readPage(rel);
      ok(`${rel} 存在`, html !== null);
      if (!html) continue;
      const rows = [...html.matchAll(/<li class="dayrow">([\s\S]*?)<\/li>/g)].map((m) => clean(m[1]));
      // 日期从 history 推：与 loader 同一份数据、同一个排序（降序取 15 天）
      const dates = [
        ...new Set(
          Object.entries(history)
            .filter(([code]) => codeSets[k].has(code))
            .flatMap(([, arr]) => arr.map((p) => p.date))
        ),
      ]
        .sort()
        .reverse()
        .slice(0, 15);
      eq(`${k} 历史页行数`, rows.length, Math.min(15, dates.length));
      const mismatch = [];
      dates.forEach((d, i) => {
        const row = rows[i] || '';
        const want = summarizeDay(funds, history, d, k);
        // 行文本形如「10月23日 周五 7 家开门 · 共监控 17 家（人民币） 135 元」
        const m = row.match(/(\d+) 家开门 · 共监控 (\d+) 家（人民币） (\d+) 元/);
        if (!m) {
          mismatch.push(`${d} 行解析失败`);
          return;
        }
        if (+m[1] !== want.opened || +m[3] !== want.total) {
          mismatch.push(`${d} 页面=${m[1]}/${m[3]} 重算=${want.opened}/${want.total}`);
        }
      });
      ok(`${k} 历史页逐日 opened/total == 重算`, mismatch.length === 0, mismatch.slice(0, 3).join('; '));
    }

    // 7.4 两边首行数字必须不同：相同就说明有一边取错了指数
    const firstNums = (h) => {
      // 必须先取出一行再剥标签：直接对整篇 HTML 匹配，`<b>` 会把数字和文字隔开
      const row = (h.match(/<li class="dayrow">([\s\S]*?)<\/li>/) || [])[1];
      const m = row ? clean(row).match(/(\d+) 家开门 · 共监控 (\d+) 家（人民币） (\d+) 元/) : null;
      return m ? `${m[1]}/${m[2]}/${m[3]}` : '';
    };
    const ndxFirst = firstNums(readPage(path.join('ndx100', 'daily', 'index.html')) || '');
    const spFirst = firstNums(readPage(path.join('sp500', 'daily', 'index.html')) || '');
    ok('两套历史页首行数字不同', ndxFirst !== '' && ndxFirst !== spFirst, `${ndxFirst} vs ${spFirst}`);

    // 7.5 共用页 /my：只能有一个当前页，且收录两边的份额
    const my = readPage(path.join('my', 'index.html'));
    ok('dist/my/index.html 存在', my !== null);
    if (my) {
      // 「两个 aria-current」是这个页面在加指数时的确踩过的 bug（SiteHeader 缺省
      // navKey 会落到纳指，于是「纳指」和「我的基金」同时声称自己是当前页）
      const currents = [...my.matchAll(/aria-current="page"[^>]*>([^<]*)</g)].map((m) => m[1]);
      eq('/my 的 aria-current 恰好 1 个', currents.length, 1);
      eq('/my 的当前页是「我的基金」', currents[0], '我的基金');
      const known = JSON.parse((my.match(/id="knownCodes"[^>]*>([^<]*)</) || [])[1] || '[]');
      const cnyUnion = new Set(
        indexes.flatMap((k) =>
          funds
            .filter((f) => f.indexKey === k && f.currency !== 'USD')
            .flatMap((f) => f.codes.map((c) => c.code))
        )
      );
      eq('/my 的 knownCodes == 两指数人民币份额并集', known.length, cnyUnion.size);
      const idxInPage = [...new Set([...my.matchAll(/data-index="([^"]*)"/g)].map((m) => m[1]))].sort();
      eq('/my 按指数分段，段集合 == 指数集合', idxInPage.join(','), [...indexes].sort().join(','));
    }

    // 7.6 详情页回跳：纳指的份额回纳指，标普的回标普
    for (const [k, label] of [
      [NDX, '纳指'],
      [SP500, '标普500'],
    ]) {
      const code = [...codeSets[k]][0];
      const html = readPage(path.join('f', code, 'index.html')) || '';
      ok(`/f/${code} 回跳指向${label}`, html.includes(`← 返回${label}`));
    }
  }
}

console.log('');
if (fails.length) {
  console.error(`✗ ${fails.length} 项失败：`);
  for (const f of fails) console.error(`   - ${f}`);
  process.exit(1);
}
console.log(`✓ 口径隔离门禁通过：${pass} 项断言全绿`);
