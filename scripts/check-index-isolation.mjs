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
//      #history），两个看板页底部周历的逐日额度各自等于本指数重算值，
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

    // 7.3 两个看板页底部的历史段现在是「周历」：每周一行、五个工作日格，
    //     过去且有数据的交易日直接写当日额度，其余灰格写休市原因。
    // ★ 2026-10-25 之前这里是「每日快照」分页账本（tr.dayrow + label[for=dayp-N]）。
    //   那天先并入月历、当天又改成周历，分页整个消失——断言跟着重写：
    //   不再数表格行，而是把渲染出的「日期 → 额度 / 开门数」与数据逐日对齐。
    // ★ 额度取 cal-tip 里的精确值（¥1,084），不拿格子上那个大字：大字按量级自适应
    //   （1,084元 / 1.2万），拿它做等值断言等于把 fmtAmt 抄一遍；大字只验单位与量级。
    const TODAY = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
    const TODAY_DOW = new Date(`${TODAY}T00:00:00Z`).getUTCDay(); // 0 = 周日
    const DOW_ZH = ['周一', '周二', '周三', '周四', '周五'];
    const shift = (d, n) =>
      new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
    const mondayOf = (d) => shift(d, -((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7));
    // aria-label 里只有「9月14日」，年份靠 TODAY 推：取数窗 60 天，只有 TODAY 落在
    // 1~2 月时才可能跨年（那时 11~12 月属于去年）。
    const thisYear = +TODAY.slice(0, 4);
    const thisMonth = +TODAY.slice(5, 7);
    const toDate = (m, d) =>
      `${thisMonth <= 2 && m >= 11 ? thisYear - 1 : thisYear}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

    const cssSrc = fs.readFileSync(path.join(ROOT, 'src', 'styles', 'global.css'), 'utf8');
    const wk = {}; // 指数 → { cells, rows }
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
      // 标题只写「交易日历」：这页已经是某个指数的页面，标题再带指数名是重复
      ok(
        `${k} 历史段标题不带指数名`,
        /<h2 class="sec-t">交易日历<\/h2>/.test(html) && !html.includes('交易日历 · '),
      );

      // 逐格解析。★ 类名必须写成 `wk-d` 后跟引号或空格：只写 `wk-d[^"]*` 会把
      //   `wk-days`、`wk-dt` 一起吞掉，格子数与行数全部虚高（这类错误会让断言「看起来过了」）。
      const opens = [...html.matchAll(/<span class="(wk-d(?:\s[^"]*)?)"([^>]*)>/g)];
      const cells = opens.map((m, i) => {
        const body = html.slice(
          m.index + m[0].length,
          i + 1 < opens.length ? opens[i + 1].index : html.length,
        );
        const aria = (m[2].match(/aria-label="([^"]*)"/) || [])[1] || '';
        const dm = aria.match(/^(\d+)月(\d+)日 (周[一二三四五六日])：/);
        const ariaAmt = aria.match(/可投 ¥([\d,]+) · (\d+) 家开门/);
        const amt = body.match(/<span class="wk-amt">([^<]*)<u>([^<]*)<\/u>/);
        const tip = body.match(
          /<i class="ct-k">额度<\/i>\s*<b class="ct-v">¥([\d,]+)<\/b>\s*<span class="ct-why">·\s*(\d+)\s*家开门/,
        );
        return {
          cls: m[1],
          date: dm ? toDate(+dm[1], +dm[2]) : '',
          weekday: dm ? dm[3] : '',
          day: (body.match(/<span class="wk-dt">(\d+)<\/span>/) || [])[1] || '',
          amtN: amt ? amt[1] : null,
          amtU: amt ? amt[2] : null,
          reason: (body.match(/<span class="wk-reason">([^<]*)<\/span>/) || [])[1] || '',
          total: tip ? +tip[1].replace(/,/g, '') : null,
          opened: tip ? +tip[2] : null,
          ariaTotal: ariaAmt ? +ariaAmt[1].replace(/,/g, '') : null,
          ariaOpened: ariaAmt ? +ariaAmt[2] : null,
        };
      });
      const rowOpens = [...html.matchAll(/<div class="wk-row([^"]*)"/g)].map((m) => m[1]);
      wk[k] = { cells, rows: rowOpens.length };

      ok(
        `${k} 周历每一格都解析得出日期`,
        cells.length > 0 && cells.every((c) => c.date),
        `${cells.length} 格，${cells.filter((c) => !c.date).length} 格解析失败`,
      );
      eq(`${k} 周历格子数 == 行数 × 5`, cells.length, rowOpens.length * 5);
      ok(
        `${k} 每行按周一到周五排列`,
        cells.every((c, i) => c.weekday === DOW_ZH[i % 5]),
        cells.filter((c, i) => c.weekday !== DOW_ZH[i % 5]).slice(0, 3).map((c) => `${c.date} ${c.weekday}`).join(','),
      );
      ok(
        `${k} 格子上的日号与 aria-label 一致`,
        cells.every((c) => +c.day === +c.date.slice(8)),
        cells.filter((c) => +c.day !== +c.date.slice(8)).slice(0, 3).map((c) => `${c.date} 日号${c.day}`).join(','),
      );

      // 日期序列：周内 +1 天、跨行 +3 天（周五→下周一）。列错位、漏排一周都会在这里露出来。
      const badSeq = [];
      for (let i = 1; i < cells.length; i++) {
        const want = shift(cells[i - 1].date, i % 5 === 0 ? 3 : 1);
        if (cells[i].date !== want) badSeq.push(`${cells[i - 1].date}→${cells[i].date}（应为 ${want}）`);
      }
      ok(`${k} 日期序列按周连续`, badSeq.length === 0, badSeq.slice(0, 2).join('; '));

      // 窗口：起点＝最早有数据那周的周一；终点＝含今天的那一周 + 1（未来一周给预判）。
      // 取数窗与 loadDailySummaries(60) 同口径：本指数代码的全部日期，降序取 60 天再升序。
      const dates60 = [
        ...new Set(
          Object.entries(history)
            .filter(([code]) => codeSets[k].has(code))
            .flatMap(([, arr]) => arr.map((p) => p.date)),
        ),
      ]
        .sort()
        .reverse()
        .slice(0, 60)
        .sort();
      eq(`${k} 窗口起点对齐最早数据的周一`, cells[0] && cells[0].date, mondayOf(dates60[0]));
      // 构建日与检查日可能差一天（23:59 构建、00:01 检查），所以末行允许是本周或下周
      ok(
        `${k} 窗口终点是本周或下一周`,
        [mondayOf(TODAY), shift(mondayOf(TODAY), 7)].includes(cells[cells.length - 5]?.date),
        cells[cells.length - 5]?.date,
      );

      // ★ 核心断言：渲染出的「日期 → 额度/开门数」== 数据重算，双向等值。
      //   写成「大部分对上」等于容得下几天丢失——那正是这里最该拦的错。
      const got = new Map(cells.filter((c) => c.total !== null).map((c) => [c.date, c]));
      const want = new Map(dates60.map((d) => [d, summarizeDay(funds, history, d, k)]));
      const missing = [...want.keys()].filter((d) => !got.has(d));
      const extra = [...got.keys()].filter((d) => !want.has(d));
      ok(`${k} 有数据的交易日一个都没漏`, missing.length === 0, missing.slice(0, 3).join(','));
      ok(`${k} 没有数据里不存在的日子`, extra.length === 0, extra.slice(0, 3).join(','));
      const diffAmt = [...want.entries()]
        .filter(([d, w]) => got.has(d) && (got.get(d).total !== w.total || got.get(d).opened !== w.opened))
        .map(([d, w]) => `${d} 页面=${got.get(d).total}/${got.get(d).opened} 重算=${w.total}/${w.opened}`);
      ok(`${k} 逐日额度 / 开门数 == 重算`, diffAmt.length === 0, diffAmt.slice(0, 2).join('; '));
      // 读屏念的那串与看得见的那串必须同一个数（两处各写一遍，很容易只改一处）
      const ariaDiff = cells
        .filter((c) => c.total !== null)
        .filter((c) => c.ariaTotal !== c.total || c.ariaOpened !== c.opened)
        .map((c) => `${c.date} aria=${c.ariaTotal}/${c.ariaOpened} tip=${c.total}/${c.opened}`);
      ok(`${k} aria-label 与悬停提示同一个数`, ariaDiff.length === 0, ariaDiff.slice(0, 2).join('; '));

      // 未来日期不能写额度（写了就是把「还没抓到的明天」当成已知）
      const futureAmt = cells.filter((c) => c.date > TODAY && c.total !== null).map((c) => c.date);
      ok(`${k} 未来格子不写额度`, futureAmt.length === 0, futureAmt.slice(0, 3).join(','));

      // 灰格必须有说法：只留一个空框，读者分不清是休市还是没抓到数据
      const muteOff = cells
        .filter((c) => c.cls.includes('is-off') && !String(c.reason).trim())
        .map((c) => c.date);
      ok(`${k} 休市格都写了原因`, muteOff.length === 0, muteOff.slice(0, 3).join(','));

      // 大字额度只验单位与量级（精确值上面已经对齐过）
      const badFmt = cells
        .filter((c) => c.total !== null)
        .map((c) => {
          const unit = c.total >= 10000 ? '万' : '元';
          const scale = unit === '万' ? 10000 : 1;
          const shown = Number.parseFloat(String(c.amtN)) * scale;
          const okUnit = c.amtU === unit;
          const okScale = Number.isFinite(shown) && Math.abs(shown - c.total) <= 0.5 * scale;
          return okUnit && okScale ? null : `${c.date} ${c.amtN}${c.amtU} vs ${c.total}`;
        })
        .filter(Boolean);
      ok(`${k} 格子大字额度的单位与量级对得上`, badFmt.length === 0, badFmt.slice(0, 2).join('; '));

      // 本周与今天：标了还不够——CSS 里没有对应规则就等于没标（能看见格子、看不出是哪周）
      const nowIdx = rowOpens.findIndex((c) => c.includes('is-this-week'));
      eq(`${k} 恰好一行标为本周`, rowOpens.filter((c) => c.includes('is-this-week')).length, 1);
      const nowWeek = nowIdx >= 0 ? cells.slice(nowIdx * 5, nowIdx * 5 + 5) : [];
      ok(`${k} 「本周」标在含今天的那一行`, nowWeek.some((c) => c.date === TODAY), nowWeek.map((c) => c.date).join(','));
      ok(`${k} 本周标记有对应样式`, /\.wk-row\.is-this-week/.test(cssSrc));
      const todayCells = cells.filter((c) => c.cls.includes('is-today')).map((c) => c.date);
      const todayShown = TODAY_DOW >= 1 && TODAY_DOW <= 5 && nowWeek.some((c) => c.date === TODAY);
      eq(`${k} 「今天」标且只标在今天那一格`, todayCells.join(','), todayShown ? TODAY : '');
      ok(`${k} 今天标记有对应样式`, /\.wk-d\.is-today/.test(cssSrc));
    }

    // 7.4 两个看板页在同一个交易日必须给出不同额度：相同就说明有一边取错了指数
    const ndxC = wk[NDX]?.cells ?? [];
    const spByDate = new Map(
      (wk[SP500]?.cells ?? []).filter((c) => c.total !== null).map((c) => [c.date, c]),
    );
    const sharedDays = ndxC.filter((c) => c.total !== null && spByDate.has(c.date));
    const latestShared = sharedDays[sharedDays.length - 1];
    ok(
      '两个看板页同日额度不同（取最近共同交易日）',
      !!latestShared && spByDate.get(latestShared.date).total !== latestShared.total,
      latestShared
        ? `${latestShared.date} 纳指 ${latestShared.total} / 标普 ${spByDate.get(latestShared.date).total}`
        : '无共同交易日',
    );

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
      // ★ 比的是 :root 里解析出来的纸色，不是再抄一份字面量：抄一份就多一处
      //   改纸色时会被忘掉的地方（2026-10-26 换纸色时就差点漏了这里）。
      eq(`${p_(rel)} 的 theme-color 是共用纸色`, themeOf(h), rootVars.paper);
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
