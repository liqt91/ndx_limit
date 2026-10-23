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
//   7. 若 dist/ 已构建：路由结构——/ 、/daily 、两条 /xx/daily 都是跳转壳（后者跳本板
//      #history），两个看板页底部历史段的逐日数字各自等于本指数重算值，
//      共用页（/my）不带两个当前页
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

    // 7.2 旧路径不能 404：/daily 与两条 /xx/daily 现在都是跳转壳（历史已并入看板页）
    const oldDaily = readPage(path.join('daily', 'index.html'));
    ok('/daily 兼容壳存在且跳 /ndx100/#history', !!oldDaily && oldDaily.includes('url=/ndx100/#history'));

    // 7.3 两个看板页底部的历史段：行数一致、逐日数字各自等于本指数重算值。
    // ★ 2026-10-23 之前这段读的是 xx/daily/index.html；历史页拆掉后读看板页本身。
    // ★ 从「铺 7 天 + <details> 收 8 天」改成每页 8 天、最多 3 页的分页之后，
    //   所有页仍然全在 HTML 里（可见性交给 CSS 的 :checked），所以行数断言照旧成立，
    //   只是上限从 15 变成 24，并且多验一件事：每页行数不超过 PAGE。
    const PAGE = 8;
    const MAX_DAYS = PAGE * 3;
    const cssSrc = fs.readFileSync(path.join(ROOT, 'src', 'styles', 'global.css'), 'utf8');
    for (const k of indexes) {
      const rel = path.join(k === NDX ? 'ndx100' : 'sp500', 'index.html');
      const html = readPage(rel);
      ok(`${rel} 存在`, html !== null);
      if (!html) continue;
      // 旧路由必须还在，且跳到本板的锚点（跳错板块等于把标普读者送到纳指历史）
      const shell = readPage(path.join(k === NDX ? 'ndx100' : 'sp500', 'daily', 'index.html'));
      const wantTo = k === NDX ? 'url=/ndx100/#history' : 'url=/sp500/#history';
      ok(`${k} 的旧 daily 壳跳本板锚点`, !!shell && shell.includes(wantTo), wantTo);
      ok(`${k} 看板页有 #history 锚点`, html.includes('id="history"'));
      // 标题只写「每日快照」：这页已经是某个指数的页面，标题再带指数名是重复
      ok(
        `${k} 每日快照标题不带指数名`,
        /<h2 class="sec-t">每日快照<\/h2>/.test(html) && !html.includes('每日快照 · '),
      );

      const rows = [...html.matchAll(/<tr class="dayrow">([\s\S]*?)<\/tr>/g)].map((m) => clean(m[1]));
      // 日期从 history 推：与 loader 同一份数据、同一个排序（降序取 PAGE*3 天）
      const dates = [
        ...new Set(
          Object.entries(history)
            .filter(([code]) => codeSets[k].has(code))
            .flatMap(([, arr]) => arr.map((p) => p.date))
        ),
      ]
        .sort()
        .reverse()
        .slice(0, MAX_DAYS);
      eq(`${k} 看板页历史段行数`, rows.length, Math.min(MAX_DAYS, dates.length));
      const mismatch = [];
      dates.forEach((d, i) => {
        const row = rows[i] || '';
        const want = summarizeDay(funds, history, d, k);
        // 行文本形如「10-23 五 7 17 135 元」（日期 + 星期 + 开门 + 监控 + 额度）
        const m = row.match(/^(\d{2}-\d{2}) [日一二三四五六] (\d+) (\d+) (\d+) 元$/);
        if (!m) {
          mismatch.push(`${d} 行解析失败`);
          return;
        }
        if (m[1] !== d.slice(5) || +m[2] !== want.opened || +m[3] !== want.families || +m[4] !== want.total) {
          mismatch.push(`${d} 页面=${m[1]}/${m[2]}/${m[3]}/${m[4]} 重算=${d.slice(5)}/${want.opened}/${want.families}/${want.total}`);
        }
      });
      ok(`${k} 看板页历史段逐日 日期/开门/监控/额度 == 重算`, mismatch.length === 0, mismatch.slice(0, 3).join('; '));

      // 分页结构：页数 = ceil(天数/8)，页码数一致，每页不超过 8 行
      const pageCount = Math.ceil(rows.length / PAGE);
      const navLabels = [...html.matchAll(/<label for="dayp-(\d+)">/g)].map((m) => +m[1]);
      eq(`${k} 每日快照页码数`, navLabels.length, pageCount > 1 ? pageCount : 0);
      eq(`${k} 每日快照页码是 1..N`, navLabels.join(','), pageCount > 1 ? [...Array(pageCount)].map((_, i) => i + 1).join(',') : '');
      const pageTables = [...html.matchAll(/<table class="tbl daytbl">([\s\S]*?)<\/table>/g)].map(
        (m) => (m[1].match(/<tr class="dayrow">/g) || []).length
      );
      eq(`${k} 每日快照页数`, pageTables.length, Math.max(1, pageCount));
      ok(`${k} 每页不超过 ${PAGE} 行`, pageTables.every((n) => n > 0 && n <= PAGE), pageTables.join('/'));
      // ★ 页码当前态靠 CSS 的 :has(#dayp-N:checked)：页数涨了而规则没补，
      //   翻页仍然可用、只是不高亮——这种「能用但不说话」的退化最难发现，所以写进断言。
      const missing = navLabels.filter(
        (n) => !new RegExp(`:has\\(#dayp-${n}:checked\\)\\s*label\\[for="dayp-${n}"\\]`).test(cssSrc)
      );
      ok(`${k} 每个页码都有当前态样式`, missing.length === 0, `缺 ${missing.join(',')}`);
    }

    // 7.4 两边首行数字必须不同：相同就说明有一边取错了指数
    const firstNums = (h) => {
      // 必须先取出一行再剥标签：直接对整篇 HTML 匹配，`<td>` 会把日期与星期隔开
      const row = (h.match(/<tr class="dayrow">([\s\S]*?)<\/tr>/) || [])[1];
      const m = row ? clean(row).match(/^(\d{2}-\d{2}) [日一二三四五六] (\d+) (\d+) (\d+) 元$/) : null;
      return m ? `${m[2]}/${m[3]}/${m[4]}` : '';
    };
    const ndxFirst = firstNums(readPage(path.join('ndx100', 'index.html')) || '');
    const spFirst = firstNums(readPage(path.join('sp500', 'index.html')) || '');
    ok('两个看板页历史段首行数字不同', ndxFirst !== '' && ndxFirst !== spFirst, `${ndxFirst} vs ${spFirst}`);

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

// ── 8. 分站视觉身份 ──────────────────────────────────────────────
// 两个看板版式完全一样，靠纸色区分板块。纸色是**纯 CSS**，改错了不报错、不崩页面，
// 只会让两个板块重新长得一模一样——典型静默退化，所以必须有断言。
console.log('\n8. 分站视觉身份（纸色 / 身份色）');

const CSS_PATH = path.join(ROOT, 'src', 'styles', 'global.css');
// ★ 先剥注释再解析：负向验证里「把 --accent 注释掉」的注入差点被判成通过——
//   不带这行的解析器会把 `/* --accent: #5b3b60; */` 当成仍然生效的声明。
const css = fs.readFileSync(CSS_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

// 断言里的路径统一用正斜杠：Windows 下 path.join 产物是 `ndx100\index.html`，
// 同一条断言在两台机器上文案不同，负向验证按字符串找红点就会漏判。
const p_ = (rel) => rel.split(path.sep).join('/');

// 取某个选择器块里的自定义属性。`[^}]*` 够用：这些块里没有嵌套规则。
const varsIn = (body) => {
  const out = {};
  for (const [, name, value] of body.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) out[name] = value.trim();
  return out;
};
const blockVars = (selector) => {
  const m = css.match(new RegExp(selector.replace(/[[\]'=]/g, (c) => '\\' + c) + '\\s*\\{([^}]*)\\}'));
  return m ? varsIn(m[1]) : null;
};

// 对比度：纸色是这条链上唯一会被「调浅一点更好看」改坏的东西
const lum = (hex) => {
  const h = String(hex).replace('#', '');
  const ch = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const [r, g, b] = ch.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (fg, bg) => {
  const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
};

// CIE76 色差。纸色统一后，「两个板块能不能一眼分开」全靠两个 --accent，
// 而「看着不一样」这件事没法用字符串比较表达——两个都偏红褐的值字面不同、肉眼相同。
const toLab = (hex) => {
  const ch = [0, 2, 4].map((i) => parseInt(String(hex).replace('#', '').slice(i, i + 2), 16) / 255);
  const [r, g, b] = ch.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t) => (t > 0.008856 ? t ** (1 / 3) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
};
const deltaE = (a, b) => {
  const [la, aa, ba] = toLab(a);
  const [lb, ab, bb] = toLab(b);
  return Math.hypot(la - lb, aa - ab, ba - bb);
};

const rootVars = blockVars(':root') || {};
const BOARDS = [
  { slug: 'ndx100', key: NDX },
  { slug: 'sp500', key: SP500 },
];
const boardVars = {};
for (const b of BOARDS) {
  // 纸色只写在 html[data-board]（一页一张纸）；印色写在 [data-board]（html 与 /my 的分段共用）。
  // 两处分开解析，别用一个正则同时糊住——`html[data-board='x']` 也含 `[data-board='x']`，
  // 糊着写会把印色块当成纸色块，于是「声明了 --paper」在 accent 块上通过，实际没人声明纸色。
  const pageM = css.match(new RegExp(`html\\[data-board='${b.slug}'\\]\\s*\\{([^}]*)\\}`));
  const inkM = css.match(new RegExp(`(?:^|\\n)\\s*\\[data-board='${b.slug}'\\]\\s*\\{([^}]*)\\}`));
  const pageVars = pageM ? varsIn(pageM[1]) : null;
  const inkVars = inkM ? varsIn(inkM[1]) : null;
  ok(`global.css 有 html[data-board='${b.slug}'] 块（纸色）`, pageVars !== null);
  ok(`global.css 有 [data-board='${b.slug}'] 块（印色）`, inkVars !== null);
  boardVars[b.slug] = { ...(pageVars || {}), ...(inkVars || {}) };
  for (const need of ['paper', 'surface']) {
    ok(`${b.slug} 声明了 --${need}`, Boolean((pageVars || {})[need]));
  }
  ok(`${b.slug} 声明了 --accent`, Boolean((inkVars || {}).accent));
  // 印色块只放印色：热力四档是全站量纲色，一旦按板块派生，「深」的含义就跟着版面漂移
  ok(
    `${b.slug} 的印色块里没有 --heat-*（热力条不按板块走）`,
    !/--heat-/.test((inkM || [])[1] || ''),
    '--heat-* 只能在 :root 定义'
  );
}

// 2026-10-23 起两个板块共用一张暖纸，身份改由 --accent 承担，所以这里断言的是**相同**。
// 仍然值得断言：纸色现在有三处（:root / ndx100 / sp500），只改其中一处就会露馅。
const [[s1, v1], [s2, v2]] = Object.entries(boardVars);
ok(`两套 --paper 相同（${v1.paper} vs ${v2.paper}）`, v1.paper === v2.paper);
ok(`分站纸色 == :root 纸色（${v1.paper} / ${rootVars.paper}）`, v1.paper === rootVars.paper);
ok(`两套 --accent 不同（${v1.accent} vs ${v2.accent}）`, v1.accent !== v2.accent);

// 纸色统一之后，「一眼看出在哪个板块」全押在这两个色上，必须真的拉得开。
// ΔE < 25 时并排也只是「两种相近的红褐」，等于没区分——而这是纯视觉退化，不报错。
// 阈值 40 而不是 25：25 是「勉强能分」的底线，但纳指赭 vs 标普红是 28.7 时，
// 用户的实际反馈是「差异不够大」。蓝 vs 红是 78.8，留足余量再调也不会掉回去。
const accentDE = deltaE(v1.accent, v2.accent);
ok(`两套 --accent 色差 ΔE ≥ 40（一眼分得开）`, accentDE >= 40, `ΔE=${accentDE.toFixed(1)}`);

// ── 额度热力条的四档：全站唯一一套，不跟板块走 ─────────────────────────
// 它编码的是**额度**，是一把尺：同一只基金 400 元，在纳指页、标普页、/my 的两段里
// 必须是同一个颜色。2026-10-23 一度按板块从 --accent 派生，旋即撤回——
// 结论色可以分板块，量纲色不行（否则「深」的含义会跟着版面漂移）。
//
// 回归：它曾经是一支独立的松绿，heat-4 #2f6650 与状态色 --ok #2c6e4f 的 ΔE 只有 7，
// 「额度最大」和「可投」几乎是同一种绿。中间走过钢蓝、中性灰、灰紫（排除法），
// 用户 2026-10-23 都否了，最后定在**橄榄绿**——绿是用户要的，但色相往黄侧让开
// --ok（117° vs 150°），深档 ΔE 24.6 才成立。下面那条 ΔE ≥ 20 就是在守这一让。
// ★ 别把阈值降到 10：松绿那版 ΔE 7 会立刻「通过」，等于把坑放回来。
const heat = [1, 2, 3, 4].map((i) => rootVars[`heat-${i}`]);
ok(':root 声明了 --heat-1..4（全站唯一一套热力色）', heat.every(Boolean), heat.join(' / '));

if (heat.every(Boolean)) {
  // 四档必须是**同一条阶梯**，不是四个碰巧明暗不同的颜色。
  // 判据用 Lab 色相角：同一色相的四档，色相角应当几乎重合（当前极差 2.4°）。
  // 这比「色度相近」更准——浅档彩度天然低，色度本来就差一截，但色相不该变。
  const hues = heat.map((h) => {
    const [, a, b] = toLab(h);
    return (Math.atan2(b, a) * 180) / Math.PI;
  });
  ok(
    '热力四档同色相（Lab 色相角极差 ≤ 12°）',
    Math.max(...hues) - Math.min(...hues) <= 12,
    `极差 ${(Math.max(...hues) - Math.min(...hues)).toFixed(1)}°（${hues.map((x) => x.toFixed(1)).join(' / ')}）`
  );

  // 明度阶梯是热力条唯一的编码维度：顺序错了「额度大」会看成「额度小」
  const Ls = heat.map((h) => toLab(h)[0]);
  ok(
    '热力四档明度严格递减',
    Ls.every((L, i) => i === 0 || L < Ls[i - 1] - 2),
    `L*= ${Ls.map((L) => L.toFixed(1)).join(' > ')}`
  );

  const steps = [1, 2, 3].map((i) => deltaE(heat[i - 1], heat[i]));
  ok(
    '热力相邻两档 ΔE ≥ 10（并排分得开）',
    Math.min(...steps) >= 10,
    `ΔE= ${steps.map((d) => d.toFixed(1)).join(' / ')}`
  );

  const fade = deltaE(heat[0], rootVars.paper);
  ok('热力最浅档与纸色 ΔE ≥ 8（第一档看得见）', fade >= 8, `ΔE=${fade.toFixed(1)}`);

  // 热力条不许和任何「含义」撞色：两个状态墨是结论，两个印色是身份。
  // 撞了以后同一个颜色在页面上读两种意思，而字面值全都合法——只有算色差才发现。
  // ★ --warn（限额）是**唯一豁免**：用户 2026-10-23 明确要求「限额申购的绿色也换成热力条这个」，
  //   两处同值 #505f24。豁免的理由：热力最深档只在额度 >600 时才出现（实际数据里几乎没有），
  //   而同屏最常见的限额点旁边是 l1/l2——所以下面单独断言「前三档必须让开」。
  const clashes = [
    ['--ok（可投）', rootVars.ok],
    ['--stop（暂停）', rootVars.stop],
    ['纳指印色', boardVars.ndx100?.accent],
    ['标普印色', boardVars.sp500?.accent],
  ];
  for (const [name, color] of clashes) {
    if (!color) continue;
    const d = Math.min(...heat.map((h) => deltaE(h, color)));
    ok(`热力四档都不接近 ${name}（ΔE ≥ 20）`, d >= 20, `最小 ΔE=${d.toFixed(1)}`);
  }
  const warnGap = Math.min(...heat.slice(0, 3).map((h) => deltaE(h, rootVars.warn)));
  ok(
    '--warn（限额）与热力前三档 ΔE ≥ 20（只允许撞最深档）',
    warnGap >= 20,
    `最小 ΔE=${warnGap.toFixed(1)}`
  );
}

// 一份定义就够：出现第二份（不管挂在哪个选择器上），两页的「深」就不是同一件事了。
// 只匹配 `--heat-N:`（定义），不匹配 .hc 里的 var(--heat-N, …)。
const heatDefs = [...css.matchAll(/([^{}]+)\{([^{}]*--heat-[1-4]\s*:[^}]*)\}/g)].map(([, sel]) =>
  sel.trim().replace(/\s+/g, ' ')
);
ok('--heat-* 只在 :root 定义（不许按板块另起一套）', heatDefs.length === 1 && heatDefs[0] === ':root', heatDefs.join(' | '));

// 格子必须引用变量：写死颜色等于多出一套没法校验的色值
for (const lv of [1, 2, 3, 4]) {
  ok(
    `.hc.l${lv} 用 var(--heat-${lv})`,
    new RegExp(`\\.hc\\.l${lv}\\s*\\{[^}]*var\\(--heat-${lv}\\b`).test(css)
  );
}

// 小程序与网页同源同色：WXSS 不认 color-mix，那四档是抄过去的固定值，
// 而「抄」最容易在改配色时漏掉——漏了以后两端对同一只基金给两种深浅。
const MP_CSS = path.join(ROOT, 'miniprogram', 'app.wxss');
ok('miniprogram/app.wxss 存在（跨端色值可校验）', fs.existsSync(MP_CSS));
if (fs.existsSync(MP_CSS)) {
  const mpCss = fs.readFileSync(MP_CSS, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const mpVars = {};
  for (const [, name, value] of mpCss.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) mpVars[name] = value.trim();
  for (const lv of [1, 2, 3, 4]) {
    eq(
      `小程序 --heat-${lv} 与网页逐字一致`,
      (mpVars[`heat-${lv}`] || '').toLowerCase(),
      String(rootVars[`heat-${lv}`] || '').toLowerCase()
    );
  }
  eq('小程序 --stop 与网页一致（暂停同色）', (mpVars.stop || '').toLowerCase(), String(rootVars.stop || '').toLowerCase());
  eq('小程序 --warn 与网页一致（限额同色）', (mpVars.warn || '').toLowerCase(), String(rootVars.warn || '').toLowerCase());
}

// 三个状态墨是三个**结论**，互相之间也必须分得开——可投与限额现在都在绿区（限额跟着热力条走），
// 这是全站唯一一处「结论色同色相」的地方，最容易随手调成一样。
const okWarnDE = deltaE(rootVars.ok, rootVars.warn);
ok('--ok（可投）与 --warn（限额）ΔE ≥ 20', okWarnDE >= 20, `ΔE=${okWarnDE.toFixed(1)}`);
const warnPaper = (() => {
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const L = (hex) => {
    const n = String(hex).replace('#', '');
    const [r, g, b] = [0, 2, 4].map((i) => lin(parseInt(n.slice(i, i + 2), 16) / 255));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [a, b] = [L(rootVars.warn), L(rootVars.paper)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
})();
ok('--warn 对纸色 ≥ 4.5:1（要当小号标签字用）', warnPaper >= 4.5, `${warnPaper.toFixed(2)}:1`);

// 暂停＝灰。红已经让给标普当身份色，暂停要是还红着，标普页上「暂停申购」的标签
// 会和品牌色同色，读者分不清哪个是结论、哪个是装饰。
// 判据用通道极差当饱和度代理：砖红 #a33a2f 极差 116，真正的中性灰 ≤ 24。
const stopHex = rootVars.stop || '';
const stopCh = [0, 2, 4].map((i) => parseInt(String(stopHex).replace('#', '').slice(i, i + 2), 16));
const stopSpread = Math.max(...stopCh) - Math.min(...stopCh);
ok('暂停色 --stop 是中性灰（通道极差 ≤ 24）', Boolean(stopHex) && stopSpread <= 24, `${stopHex} 极差=${stopSpread}`);
ok('.tag-closed 与 .tag-stop 同色（封闭期＝暂停）', /\.tag-closed\s*\{[^}]*var\(--stop\)/.test(css));

// 卡片等高：.fam-head 的 min-height 是手写的常量，必须等于 .fam-big 的行高。
// 这层耦合不出现在任何模板里——把数字块字号从 24px 调到 26px，暂停的卡片就重新矮 2px，
// 一页里两类卡片混排时整页行高会跟着板块变，切指数就上下跳。没有断言就只能靠眼睛发现。
const ruleBody = (sel) => (css.match(new RegExp(sel.replace(/[.[\]\\]/g, (c) => '\\' + c) + '\\s*\\{([^}]*)\\}')) || [])[1] || '';
const bigBody = ruleBody('.fam-big');
const headBody = ruleBody('.fam-head');
const bigFs = parseFloat((/font-size:\s*([\d.]+)px/.exec(bigBody) || [])[1] || '0');
const bigLh = parseFloat((/line-height:\s*([\d.]+)/.exec(bigBody) || [])[1] || '0');
const headMin = parseFloat((/min-height:\s*([\d.]+)px/.exec(headBody) || [])[1] || '0');
const bigLine = bigFs * bigLh;
ok(
  '.fam-head 的 min-height 对得上 .fam-big 的行高（等高不跳）',
  headMin > 0 && bigLine > 0 && Math.abs(headMin - bigLine) <= 1,
  `min-height=${headMin} vs ${bigFs}×${bigLh}=${bigLine.toFixed(1)}（容差 1px 是取整）`
);

// 身份色不许接近状态墨：「暂停」的红点与板块色撞车，读者会把装饰读成结论
const statusInks = ['ok', 'warn', 'stop'].map((k) => rootVars[k]).filter(Boolean);
for (const [slug, v] of Object.entries(boardVars)) {
  ok(
    `${slug} 的 --accent 不是状态墨之一`,
    Boolean(v.accent) && !statusInks.includes(v.accent),
    `accent=${v.accent} 状态墨=${statusInks.join('/')}`
  );
  // 纸色变浅一档，AA 就掉了——而正文次级灰与小号数字全靠它
  for (const [name, key] of [
    ['ink-3', 'ink-3'],
    ['accent', 'accent'],
  ]) {
    const fg = v[key] || rootVars[key];
    const ratio = fg && v.paper ? contrast(fg, v.paper) : 0;
    ok(`${slug} 的 --${name} 对纸色 ≥ 4.5:1`, ratio >= 4.5, `${fg} on ${v.paper} = ${ratio.toFixed(2)}`);
  }
}

// 吸顶色带：唯一「滚动时一直在场」的板块标识
ok('global.css 定义了 .site-head::before 色带', /html\[data-board\] \.site-head::before\s*\{[^}]*background:\s*var\(--accent\)/.test(css));

// 2026-10-23 追加的两处落点：选中文字、/my 分段标题的竖条。
// 它们都很小，但「印色只出现在顶栏」会让身份感止步于首屏——而选中文字是
// 复制数据时天天碰到的动作，/my 是唯一一页「两个指数同屏」的地方。
ok('::selection 用印色', /::selection\s*\{[^}]*background:\s*var\(--accent\)/.test(css));
ok(
  '/my 分段标题前的竖条用印色',
  /\.my-sec\s*>\s*\.sec\s+\.sec-t::before\s*\{[^}]*background:\s*var\(--accent\)/.test(css)
);

// 首屏背后那道装饰带（TrendBackdrop 的柱 + 折线 + 基线）也走印色。
// ★ 与热力条的区别要按住：这道带只画形状、没有档位，读者读不到数值，所以可以跟身份走；
//   热力条每一格对着一个额度区间，深浅即结论，必须全站一套（见上面那组断言）。
// 写死颜色不会报错、只会静默丢掉一个板块标识，所以这里断言「必须是变量」。
for (const [sel, prop] of [
  ['.mt-bar', 'fill'],
  ['.mt-line', 'stroke'],
  ['.mt-base', 'stroke'],
]) {
  ok(
    `装饰带 ${sel} 的 ${prop} 用印色`,
    new RegExp(`${sel.replace(/\./g, '\\.')}\\s*\\{[^}]*${prop}:\\s*var\\(--accent\\)`).test(css)
  );
}
// 反方向：装饰带里不许再出现 --ink —— 那意味着某处漏改，两页共用一处墨色柱子
ok(
  '装饰带没有残留的 --ink（半改回去会一页彩一页灰）',
  !/\.mt-(bar|line|base)\s*\{[^}]*var\(--ink\)/.test(css)
);

if (CHECK_DIST) {
  const dist = path.join(ROOT, 'dist');
  const pageOf = (rel) => {
    const f = path.join(dist, rel);
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
  };
  const htmlTag = (h) => (h.match(/<html[^>]*>/) || [''])[0];
  const themeOf = (h) => (h.match(/name="theme-color" content="([^"]+)"/) || [])[1];

  if (!pageOf(path.join('ndx100', 'index.html'))) {
    console.log('   dist/ 未构建，跳过纸色渲染层断言');
  } else {
    // 2026-10-23 起每个板块只有一张内容页（历史已并入看板页，/xx/daily 只剩跳转壳，
    // 壳页没有 data-board、没有站标，审不了这三条）。
    for (const b of BOARDS) {
      const rel = path.join(b.slug, 'index.html');
      const h = pageOf(rel);
      ok(`${p_(rel)} 存在`, h !== null);
      if (!h) continue;
      ok(`${p_(rel)} 的 <html> 带 data-board="${b.slug}"`, htmlTag(h).includes(`data-board="${b.slug}"`), htmlTag(h));
      eq(`${p_(rel)} 的 theme-color == 本板块纸色`, themeOf(h), boardVars[b.slug].paper);
      // 站标必须是内联 SVG：老的 /nasdaq-logo.svg 是两个板块共用的「N」方块，
      // 顶在标普500 页面上是错的
      ok(`${p_(rel)} 站标是内联 .site-mark`, h.includes('class="site-mark"') && !h.includes('/nasdaq-logo.svg'));
    }
    // 共用页没有指数身份：纸色与色带都必须回到中性，否则「我在哪个板块」会被说错
    for (const rel of [path.join('my', 'index.html'), path.join('subscribe', 'index.html')]) {
      const h = pageOf(rel);
      ok(`${p_(rel)} 存在`, h !== null);
      if (!h) continue;
      ok(`${p_(rel)} 不带 data-board`, !/data-board=/.test(htmlTag(h)), htmlTag(h));
      eq(`${p_(rel)} 的 theme-color 是共用纸色`, themeOf(h), '#f9f0dd');
    }
    // /my 一页两个指数：分段靠 data-board 拿各自的印色（段标题竖条、份额悬停线）。
    // ★ 分段不要再挂 data-heat：热力条是全站量纲色，段里若各有一套「深」，
    //   同一页里两段的颜色就没法互相比较了——那正是这轮撤掉的做法。
    const myHtml = pageOf(path.join('my', 'index.html'));
    if (myHtml) {
      const secTags = [...myHtml.matchAll(/<section[^>]*my-sec[^>]*>/g)].map((m) => m[0]);
      ok('/my 有指数分段（可校验印色作用域）', secTags.length >= 1, `${secTags.length} 段`);
      ok(
        '/my 每个指数分段都带 data-board（段内才有本板块印色）',
        secTags.length >= 1 && secTags.every((t) => /data-board="(ndx100|sp500)"/.test(t)),
        secTags.map((t) => (t.match(/data-board="([^"]+)"/) || [])[1] || '缺失').join(' / ')
      );
      ok(
        '/my 的分段不再带 data-heat（热力色不按段走）',
        secTags.every((t) => !/data-heat=/.test(t))
      );
    }
    // 详情页跟着份额所属指数走：点进标普500 的份额，不该顶着纳指的身份色
    for (const [k, slug] of [
      [NDX, 'ndx100'],
      [SP500, 'sp500'],
    ]) {
      const code = [...codeSets[k]][0];
      const h = pageOf(path.join('f', code, 'index.html'));
      ok(`/f/${code} 的 data-board == ${slug}`, Boolean(h) && htmlTag(h).includes(`data-board="${slug}"`), h ? htmlTag(h) : '页面缺失');
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
