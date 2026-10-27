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
    // ★ 家族名从 `data-fam` 属性取，不再从 `div.fam-name` 的文字取。
    //   2026-10-27 看板从卡片改成表格时，列宽只够放公司名（「宝盈」而不是
    //   「宝盈纳斯达克100」——整页就是一个指数，再印 41 遍指数名是纯重复）。
    //   若继续读可见文字，这条断言就会因为「排版变窄」而误红，或者反过来逼着
    //   把 41 行重复的指数名写回去。属性值与排版解耦，判据仍然等值。
    const famNames = (html) => [...html.matchAll(/data-fam="([^"]*)"/g)].map((m) => m[1]);

    const pages = [
      { file: path.join('ndx100', 'index.html'), key: NDX, brand: '纳指100开门日报', other: '标普500' },
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

      // ── 列表结构（2026-10-27：双列卡片 → 一份额一行的表格）──
      // 表格的形状由组件模板 + colgroup 共同决定，改版时最容易发生的三件退化
      // 都不报错：漏渲染某个份额（行数变少）、把家族级指标复制到每一行（噪音）、
      // 热力条没画满 21 格（新份额只剩几格，读起来像缺数据）。
      const trs = [...html.matchAll(/<tr class="fr[^"]*"[\s\S]*?<\/tr>/g)].map((m) => m[0]);
      const expectShares = funds
        .filter((f) => f.indexKey === p.key)
        .flatMap((f) => f.codes.map((c) => c.code));
      eq(`${p.file} 份额行数 == ${p.key} 份额数`, trs.length, expectShares.length);

      // 每行的单元格数：序号 / 基金 / 份额 / 额度 / 年费 / 跟踪误差 / 热力 = 7 格。
      // ★ 2026-10-27 二轮：跟踪误差改成 rowspan 跨满整个家族 → 续行 6 格。
      // ★ 2026-10-27 三轮：序号与基金名也跟着跨行 → 续行只剩 4 格（份额/额度/年费/热力）。
      //   「4 或 7」单独一条太松——真正要抓的退化是**列错位**，而错位会让某行变成
      //   3 格或 8 格。所以三条一起：只允许 4/7、7 格数 == 家族数、4 格数 == 续行数。
      const cellCounts = trs.map((t) => (t.match(/<td[ >]/g) || []).length);
      eq(`${p.file} 每行 4/7 个单元格（无列错位）`, cellCounts.filter((n) => n !== 4 && n !== 7).length, 0);
      eq(`${p.file} 家族首行 7 格 == 家族数`, cellCounts.filter((n) => n === 7).length, expectFams.size);
      eq(
        `${p.file} 续行 4 格 == 份额数 − 家族数`,
        cellCounts.filter((n) => n === 4).length,
        expectShares.length - expectFams.size
      );
      // 表头列数必须与数据列数相等，否则列宽会整体错位一格
      const tables = (html.match(/<table class="ftbl">/g) || []).length;
      eq(`${p.file} 表头列数 == 每行单元格数`, (html.match(/<th[ >]/g) || []).length, tables * 7);

      // 热力格：每行都要画满 21 格。新发份额只有几个历史点，不足的要补成
      // 「不可投」的空心格——留白会被读成缺数据，而事实是那天它还没成立。
      eq(`${p.file} 热力格总数 == 行数 × 21`, (html.match(/<i class="hc /g) || []).length, trs.length * 21);

      // 跟踪误差是家族级指标，只该在家族首行出现一次。
      // 全页出现次数 == 家族数（不是份额数）——多了就是把同一个数字复制了 N 遍。
      // 只数「有值的」：没有跟踪误差的家族渲染成「—」，它也是值（照样占一个首行位置）；
      // 续行根本不再渲染这个格子（rowspan 已经占了那一列），不是空单元格。
      // ★ 正则必须吃 `rowspan` 属性（`<td class="c-te" rowspan="3">`）：写死
      //   `<td class="c-te">` 会在改版当天静默变成「计数 2 / 期望 27」这种假红/假绿。
      const teShown = (html.match(/<td class="c-te"[^>]*>[^<]+<\/td>/g) || []).length;
      eq(`${p.file} 跟踪误差只在家族首行出现`, teShown, expectFams.size);

      // rowspan 必须**跨满整个家族**：值等于该家族的份额数。
      // 少跨一行，下一组的第一行会被它吃掉；多跨一行，会串到隔壁家。
      // ★ 2026-10-27 三轮：序号 / 基金名 / 跟踪误差三格都跨行，所以三类各查一遍。
      //   少查一类，就等于允许「名字还挤在首行」这种半改状态混过去。
      // ★ 名录要按**页面用的分组键**聚合再比（company|baseName|currency，与 IndexBoard 一致）。
      //   名录里允许同一家被写成两条（分两条抓取），页面会把它们并成一组；
      //   直接拿 `f.codes.length` 比，纳指就会差一个「2」对不上，白白误报。
      const famSizes = new Map();
      for (const f of funds.filter((f) => f.indexKey === p.key)) {
        const k = `${f.company}|${f.baseName}|${f.currency}`;
        famSizes.set(k, (famSizes.get(k) || 0) + f.codes.length);
      }
      const multiFams = [...famSizes.values()].filter((n) => n > 1);
      const asc = (a, b) => a - b;
      const spansOf = (cls) =>
        [...html.matchAll(new RegExp(`<td class="${cls}"[^>]*rowspan="(\\d+)"`, 'g'))].map((m) => Number(m[1]));
      const spanSets = { 'c-no': spansOf('c-no'), 'c-fund': spansOf('c-fund'), 'c-te': spansOf('c-te') };
      for (const [cls, arr] of Object.entries(spanSets)) {
        eq(`${p.file} ${cls} rowspan 格数 == 多份额家族数`, arr.length, multiFams.length);
        ok(
          `${p.file} ${cls} 每个 rowspan 都等于该家族的份额数`,
          JSON.stringify([...arr].sort(asc)) === JSON.stringify([...multiFams].sort(asc)),
          `渲染 ${JSON.stringify(arr)} / 名录 ${JSON.stringify(multiFams)}`
        );
      }
      // 三格的 span 序列必须逐组相同：不同 → 三行对齐的「组」被拆成了两块，
      // 而且会有一格串到隔壁组，屏幕上表现为名字掉到别家头上。
      ok(
        `${p.file} 序号/基金名/跟踪误差的 rowspan 逐组一致`,
        JSON.stringify(spanSets['c-no']) === JSON.stringify(spanSets['c-fund']) &&
          JSON.stringify(spanSets['c-fund']) === JSON.stringify(spanSets['c-te']),
        `no ${JSON.stringify(spanSets['c-no'])} / fund ${JSON.stringify(spanSets['c-fund'])} / te ${JSON.stringify(
          spanSets['c-te']
        )}`
      );

      // 额度：每行 data-limit 必须等于该份额最新一次抓取的额度（不可买时为空）
      const attrOf = (t, k) => (t.match(new RegExp(k + '="([^"]*)"')) || [])[1];
      const badLimit = trs.filter((t) => {
        const code = attrOf(t, 'data-code');
        const arr = history[code] || [];
        const last = arr[arr.length - 1];
        const want = last && last.limit != null ? String(last.limit) : '';
        // ★ Astro 把空字符串属性渲染成**无值属性**（`data-limit` 而不是 `data-limit=""`），
        //   读到 undefined 是「没有额度」的正常形态，必须归一成 '' 再比。
        const got = attrOf(t, 'data-limit') ?? '';
        return got !== want;
      });
      eq(`${p.file} 每行额度 == 该份额最新抓取值`, badLimit.length, 0);
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
    // ★ 2026-10-26 额度换成「右对齐数字 + 柱（--h = total / 窗口内最大值）」，
    //   带宽从「常量青条」变成比例量纲；同时未来一周不再占格子，改由表下一行
    //   文字回答「还能买多久、下次哪天买不了」。于是新增三件事要验：
    //     ① --h 与当日额度成固定比例（不是「同序」——同序容得下整批缩放）
    //     ② 缺数据的交易日必须写出来（未收录/待更新），不能和「还没到」长得一样
    //     ③ 表下那行文字的日期与天数 == 用同一份日历重算的结果
    const TODAY = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
    const TODAY_DOW = new Date(`${TODAY}T00:00:00Z`).getUTCDay(); // 0 = 周日
    const DOW_ZH = ['周一', '周二', '周三', '周四', '周五'];
    const DOW_ALL = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const shift = (d, n) =>
      new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
    const mondayOf = (d) => shift(d, -((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7));
    const dowOf = (d) => new Date(`${d}T00:00:00Z`).getUTCDay();
    // aria-label 里只有「9月14日」，年份靠 TODAY 推：取数窗 60 天，只有 TODAY 落在
    // 1~2 月时才可能跨年（那时 11~12 月属于去年）。
    const thisYear = +TODAY.slice(0, 4);
    const thisMonth = +TODAY.slice(5, 7);
    const toDate = (m, d) =>
      `${thisMonth <= 2 && m >= 11 ? thisYear - 1 : thisYear}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const mdOf = (d) => `${Number(d.slice(5, 7))}月${Number(d.slice(8, 10))}日`;

    // 双市场四态：与 src/data/trading-days.ts 同口径（这里只需要「能不能买」与休市说法，
    // 不复刻 UNKNOWN：日历已覆盖到 2027，落到覆盖区外时本门禁会先报日期不对，仍会红）。
    const CN_HOLIDAYS = new Set(readJson('market-holidays.json', []));
    const CN_NAME = new Map();
    for (const spans of Object.values(readJson('calendars/cn-holiday-names.json', { years: {} }).years)) {
      for (const sp of spans) for (let d = sp.from; d <= sp.to; d = shift(d, 1)) CN_NAME.set(d, sp.name);
    }
    const US_CAL = readJson('calendars/us-nasdaq.json', { days: [], closed: [] });
    const US_DAYS = new Set(US_CAL.days);
    const US_HOL = new Map(US_CAL.closed.map((h) => [h.date, h]));
    const stateOf = (d) => {
      const dow = dowOf(d);
      if (dow === 0 || dow === 6) return 'BOTH_CLOSED';
      const cn = !CN_HOLIDAYS.has(d);
      const us = US_DAYS.has(d);
      if (cn && us) return 'TRADING';
      if (cn && !us) return 'US_CLOSED';
      if (!cn && us) return 'CN_CLOSED';
      return 'BOTH_CLOSED';
    };
    // 未来展望的重算（buyOutlook 的同口径）：周末不算「买不了」，会跳过
    const outlookWant = (() => {
      if (stateOf(TODAY) !== 'TRADING') {
        for (let i = 1; i <= 120; i++) {
          const d = shift(TODAY, i);
          if (stateOf(d) === 'TRADING') return { todayTradable: false, nextTradable: d };
        }
        return { todayTradable: false, nextTradable: null };
      }
      let tradingDays = 0;
      let lastTradable = null;
      for (let i = 1; i <= 120; i++) {
        const d = shift(TODAY, i);
        if (dowOf(d) === 0 || dowOf(d) === 6) continue;
        const s = stateOf(d);
        if (s === 'TRADING') {
          tradingDays++;
          lastTradable = d;
          continue;
        }
        const hol = US_HOL.get(d);
        return {
          todayTradable: true,
          tradingDays,
          lastTradable,
          nextOff: {
            date: d,
            daysAway: i,
            reason:
              s === 'US_CLOSED'
                ? hol
                  ? `美股${hol.nameZh || hol.name}`
                  : '美股休市'
                : CN_NAME.has(d)
                  ? `${CN_NAME.get(d)}假期`
                  : '法定假日',
          },
        };
      }
      return { todayTradable: true, tradingDays, lastTradable, nextOff: null };
    })();

    // ★ 必须剥掉注释再断言。2026-10-26 第四轮踩过：删掉柱以后我在注释里写了
    //   「原先的 `.wk-bar { --wk-track: 22px }` 一并删除」，于是「样式里没有 .wk-bar」
    //   这条判据被自己的说明文字判红。凡是用源码文本做「不许出现 X」的断言，
    //   输入都必须是**代码**，不是带注释的文件。
    const cssSrc = fs
      .readFileSync(path.join(ROOT, 'src', 'styles', 'global.css'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
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
        // 2026-10-26 第四轮起日历里没有柱（不用图形编码额度）。
        // 取「是否出现柱」而不是「--h 是多少」——后者在无柱时全是 null，
        // 任何「比例对不对」的断言都会变成永远为真的死断言（比报红更危险）。
        const hasBar = /class="wk-bar/.test(body) || /style="--h:/.test(body);
        return {
          cls: m[1],
          date: dm ? toDate(+dm[1], +dm[2]) : '',
          weekday: dm ? dm[3] : '',
          day: (body.match(/<span class="wk-dt">(\d+)<\/span>/) || [])[1] || '',
          amtN: amt ? amt[1] : null,
          amtU: amt ? amt[2] : null,
          reason: (body.match(/<span class="wk-reason">([^<]*)<\/span>/) || [])[1] || '',
          gap: (body.match(/<span class="wk-gap">([^<]*)<\/span>/) || [])[1] || '',
          hasBar,
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

      // 窗口：起点＝最早有数据那周的周一；终点＝含今天的那一周（★ 不再往后排一周：
      // 未来移出网格，改由表下那行文字回答，见 buyOutlook）。
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
      // 末行必须是本周。唯一的例外是「周日深夜构建、周一凌晨检查」——那种情况下
      // 构建时属于上一周，此时 TODAY_DOW 是周一，容忍上一周。★ 不能容忍下一周：
      // 那正是「未来一周又排回网格」这个回退的样子。
      const lastRow = cells[cells.length - 5]?.date;
      ok(
        `${k} 窗口终点是本周（没有未来一周）`,
        lastRow === mondayOf(TODAY) || (TODAY_DOW === 1 && lastRow === shift(mondayOf(TODAY), -7)),
        lastRow,
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

      // ── 日历不用图形编码额度（2026-10-26 第四轮）──────────────────────────
      // 用户：「交易不用热力图的展现形式，只是区分交易日和非交易日呢？」
      // 原先每格底部画一根柱、高度 ∝ 当日额度。撤掉的理由有两层：
      //   ① 分辨率：格子 50–90px 宽、柱区只有 28px，纳指 9 个额度值只落成 7 档，
      //      图形能给的信息还不如旁边的数字；
      //   ② 语义：柱高抢走了「这天开不开门」的对比 —— 而后者才是日历该回答的问题。
      // 所以断言从「柱高 == 额度/最大值」反转成「格子与样式里都不许再有柱」。
      ok(
        `${k} 格子里不画柱（日历只回答「这天开不开门」）`,
        cells.every((c) => !c.hasBar),
        cells.filter((c) => c.hasBar).map((c) => c.date).slice(0, 3).join(',')
      );
      ok(
        `${k} 样式里没有 .wk-bar（柱不许回来）`,
        !/\.wk-bar\b/.test(cssSrc),
        (cssSrc.match(/\.wk-bar[^{]*\{[^}]*\}/) || [])[0]?.slice(0, 80) || ''
      );

      // ── 三种「格子里的内容」互斥：有额度 / 缺数据 / 还没到 ────────────────
      const futureCells = cells.filter((c) => c.date > TODAY);
      ok(
        `${k} 未来格不写额度、不画柱`,
        futureCells.every((c) => c.total === null && !c.hasBar && !c.amtN),
        futureCells.filter((c) => c.total !== null || c.hasBar).map((c) => c.date).join(',')
      );
      ok(
        `${k} 未来格不写休市原因（还没到，不是不能买）`,
        futureCells.every((c) => !c.reason),
        futureCells.filter((c) => c.reason).map((c) => `${c.date} ${c.reason}`).join(','),
      );
      // 缺数据：交易日、已经过去、却没有额度。★ 必须写出来——留白会被读成「休市」，
      // 而它其实只是「那天的数字丢了」（标普 9-14、9-15 就是这样），和「还没到」逐像素同款。
      const gapWant = cells
        .filter((c) => c.total === null && c.date <= TODAY && stateOf(c.date) === 'TRADING')
        .map((c) => c.date);
      const gapGot = cells.filter((c) => c.cls.includes('is-gap')).map((c) => c.date);
      eq(`${k} 缺数据的交易日 == 标了 is-gap 的格子`, gapGot.join(','), gapWant.join(','));
      ok(
        `${k} 缺数据的格子写了「未收录」/「待更新」`,
        cells.filter((c) => c.cls.includes('is-gap')).every((c) => ['未收录', '待更新'].includes(c.gap)),
        cells.filter((c) => c.cls.includes('is-gap') && !c.gap).map((c) => c.date).join(','),
      );

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

      // ── 表下那行：未来还能连着买多久、下次哪天买不了 ──────────────────────
      // 这一行的日期与天数全部用同一份日历重算核对：写错一天，读者会白等一个交易日。
      const outM = html.match(/<p class="wk-out">([\s\S]*?)<\/p>/);
      ok(`${k} 表下有「未来可买」那一行`, !!outM);
      if (outM) {
        const text = clean(outM[1]);
        if (!outlookWant.todayTradable) {
          ok(
            `${k} 今天买不了：那行给出下一个交易日`,
            !!outlookWant.nextTradable &&
              text.includes(`${mdOf(outlookWant.nextTradable)} ${DOW_ALL[dowOf(outlookWant.nextTradable)]}`),
            text,
          );
        } else if (outlookWant.nextOff) {
          const o = outlookWant.nextOff;
          eq(
            `${k} 「接下来 N 个交易日」== 重算`,
            (text.match(/接下来 (\d+) 个交易日/) || [])[1],
            String(outlookWant.tradingDays),
          );
          ok(`${k} 「到哪天为止」== 重算`, text.includes(`到 ${mdOf(outlookWant.lastTradable)}`), text);
          ok(`${k} 「下次买不了」的日期 == 重算`, text.includes(`${mdOf(o.date)} ${DOW_ALL[dowOf(o.date)]}`), text);
          ok(`${k} 「还有几天」== 重算`, text.includes(`${o.daysAway} 天后`), text);
          ok(`${k} 写明了那天为什么买不了`, text.includes(o.reason), `${o.reason} / ${text}`);
        } else {
          ok(`${k} 展望：覆盖范围内没有休市日时说清楚`, text.includes('没有休市日'), text);
        }
      }
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
      [NDX, '纳指100'],
      [SP500, '标普500'],
    ]) {
      const code = [...codeSets[k]][0];
      const html = readPage(path.join('f', code, 'index.html')) || '';
      ok(`/f/${code} 回跳指向${label}`, html.includes(`← 返回${label}`));
    }

    // 7.7 订阅页「最近日报」必须带「今日能买」清单（邮件正文最后一段的镜像）
    // ★ 2026-10-26：邮件正文加了「代码 + 额度」，墙上没有 —— 用户一眼看出「预览和信不一样」。
    //   订阅页存在的意义就是把「订阅后收到什么」摊开，缺这一段等于把卖点藏起来。
    //   这里验渲染层（dist），源码层「loader 必须复用 digest.mjs 的实现」在 check:broadcast 里。
    const sub = readPage(path.join('subscribe', 'index.html'));
    ok('dist/subscribe/index.html 存在', sub !== null);
    if (sub) {
      ok('订阅页日报墙渲染了「今日能买」清单', sub.includes('dw-buy-row'));
      // 标题与内容必须对得上：每组「今日能买（人民币份额 16 个）」下面就得真有 16 个份额。
      // ★ 只断言「页面上出现过某句话」是假绿：47 组里改坏一组，全页搜索照样命中
      //   （2026-10-26 负向注入实测没红）。
      const groups = sub.split('class="dw-buy"').slice(1).map((s) => s.split('class="dw-buy"')[0]);
      const badGroups = [];
      for (const g of groups) {
        const m = g.match(/class="dw-buy-h">今日能买（(?:人民币|美元)份额 (\d+) 个）/);
        const n = (g.match(/class="dw-buy-sh"/g) || []).length;
        if (!m) badGroups.push('缺标题');
        else if (Number(m[1]) !== n) badGroups.push(`${m[1]}≠${n}`);
      }
      eq('每组「今日能买（…份额 N 个）」的 N == 实际画出的份额数', badGroups.slice(0, 3).join(','), '');
      ok('清单组数 > 0', groups.length > 0, `${groups.length} 组`);
      // 只数清单块里的代码（<i>A类</i><b>019736</b>），别把变化清单/详情链接里的数字算进来
      const shown = new Set([...sub.matchAll(/class="dw-buy-sh"><i>[^<]*<\/i><b>(\d{6})<\/b>/g)].map((m) => m[1]));
      ok('清单里的代码全部来自名录', shown.size > 0 && [...shown].every((c) => codeSets[NDX].has(c) || codeSets[SP500].has(c)), `${shown.size} 个`);
      // 最新一天（纳指）的可买份额必须全在墙上——漏一个就是「订阅前看不到这只」
      const ndxDates = Object.keys(history)
        .filter((c) => codeSets[NDX].has(c))
        .flatMap((c) => history[c].map((d) => d.date))
        .sort();
      const lastDate = ndxDates[ndxDates.length - 1];
      const buyableNow = [];
      const stoppedNow = [];
      for (const code of codeSets[NDX]) {
        const hit = (history[code] || []).find((d) => d.date === lastDate);
        if (!hit) continue;
        if (hit.status === 'OPEN' || hit.status === 'LIMITED') buyableNow.push(code);
        else if (hit.status === 'STOPPED') stoppedNow.push(code);
      }
      if (buyableNow.length) {
        // ★ 只能看**最新那一天**的卡片：墙上是 30 天归档，今天暂停的份额在十天前
        //   多半是能买的，拿全页做「暂停不许出现」的断言必然误报（实测撞了 3 个）。
        const firstDay = (sub.split('class="dw-day"')[1] || '').split('class="dw-day"')[0];
        const shownFirst = new Set([...firstDay.matchAll(/class="dw-buy-sh"><i>[^<]*<\/i><b>(\d{6})<\/b>/g)].map((m) => m[1]));
        const missing = buyableNow.filter((c) => !shownFirst.has(c));
        ok(`${lastDate} 纳指可买的 ${buyableNow.length} 个份额都在墙上`, missing.length === 0, missing.slice(0, 5).join(','));
        const leaked = stoppedNow.filter((c) => shownFirst.has(c));
        ok('暂停的份额不进最新那天的清单', leaked.length === 0, leaked.slice(0, 3).join(','));
      } else {
        console.log(`  --  ${lastDate} 纳指没有可买份额，跳过清单等值断言`);
      }
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

// ★ 日历已经从「用图形量额度」退回「只区分开不开门」（2026-10-26 第四轮），
// 原来这下面有两条断言守着柱身色（必须 var(--heat-1)、不许 color-mix）。
// 柱整根撤掉后那两条的**对象不存在**了，留着会让 correct 的实现在「未找到规则」上红，
// 所以整段删除——不是放宽判据，是被判的东西没了。反方向的「不许再有 .wk-bar」
// 已经写在 7.3 那段（按渲染 + 样式源码各断言一次）。

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

// 印色落点。2026-10-26 用户要求移除顶栏那道 3px 色带，它是原来「滚动时一直在场」
// 的板块标识。删掉之后身份色只剩这几处小面积墨迹——它们任何一处丢失，页面照样
// 渲染、只是「我在哪个板块」这个信息静默消失，所以这里逐处按住（等值，不用 ≥）。
ok(
  'global.css 不再有顶栏 3px 色带（2026-10-26 已移除）',
  !/html\[data-board\]\s*\.site-head::before/.test(css)
);
for (const [name, re] of [
  // 站标是两种形态，印色落在两者各自的「方块」上：指数页是 SVG rect 的 fill，
  // 共用页是字标的 background。两条都按住 —— 少任一条，那一种形态就会退成死色方块。
  ['站标方块（字母形态）', /\.site-mark rect\s*\{[^}]*fill:\s*var\(--accent\)/],
  ['站标方块（QDII 字标形态）', /\.site-mark-text\s*\{[^}]*background:\s*var\(--accent\)/],
  [
    '当前导航项的下划线',
    /html\[data-board\] \.site-nav a\[aria-current="page"\]\s*\{[^}]*border-bottom-color:\s*var\(--accent\)/,
  ],
  ['小节编号 [01]', /html\[data-board\] \.sec-i\s*\{[^}]*color:\s*var\(--accent\)/],
]) {
  ok(`印色仍落在${name}`, re.test(css));
}

// 2026-10-23 追加的两处落点：选中文字、/my 分段标题的竖条。
// 它们都很小，但「印色只出现在顶栏」会让身份感止步于首屏——而选中文字是
// 复制数据时天天碰到的动作，/my 是唯一一页「两个指数同屏」的地方。
ok('::selection 用印色', /::selection\s*\{[^}]*background:\s*var\(--accent\)/.test(css));
ok(
  '/my 分段标题前的竖条用印色',
  /\.my-sec\s*>\s*\.sec\s+\.sec-t::before\s*\{[^}]*background:\s*var\(--accent\)/.test(css)
);

// ── 语义色的收敛（2026-10-26）──────────────────────────────────────
// 用户原话：「纳指、标普各自页面颜色太多了」。审计下来根因不是色值数量，而是
// **同一支绿被写成了三遍**：--ok #2c6e4f 与 --accent-open #3f7d63 的 ΔE 只有 7.3
// （色相角 159° vs 163°），--cal-trade-bg #e7f1ec 是第三遍，而且三处还散在一页的不同位置
// ——并排看像「同一块绿没对齐」，散开看就是「好几种绿」。
// 另外还有一支孤零零的赭黄 --accent-changed #b5732a（色相角 68°），
// 页面里唯一的第三色相，只用来给「今日变化」的方点染色。
// 收敛后一个色相只承担一个含义：
//   绿   = 能买    （--ok）
//   橄榄 = 额度    （--heat-1..4，--warn 与最深档同值，用户 2026-10-23 指定）
//   灰   = 结构    （墨阶 / --stop / --ink-3）
//   蓝/红 = 身份   （每页只出现一支）
// ★ 2026-10-26 第二轮（用户：「暂停申购、交易日历的绿色不一样」）：
//   第一轮把「同一支绿写三遍」合并成一支，但**日历整段还是 159° 松绿**，而卡片里的
//   额度是 117° 橄榄——两个绿在一条页面上各占一片（日历那段 2.8 万像素），
//   扫一眼就是「还没统一」。判据从「几处用同一支绿」升级成「一个色相只给一件事」：
//     · 日历柱的高度就是额度 → 必须用额度那支橄榄（--warn），不许用 --ok；
//     · 本周书签 / 「本周」二字 / 今天环说的是**时间**，不是状态 → 退墨阶；
//     · 暂停的灰必须是真中性（C* ≤ 3），旧的 #6b665a C*=7.5、色相 92°，
//       贴在橄榄格旁边读成「褪色的绿」，且与 --ink-3 的 ΔE 只有 2.0（同灰两遍）。
// 下面四组守三件事：别长回第四支色相、别把同一支颜色写第二遍、别让颜色跟错东西。
// ★ 全是定量判据。字面值全都合法（`#3f7d63` 与 `#2c6e4f` 都是漂亮的绿），
//   不数色相角，这两类退化一条都拦不住，页面也照常渲染。

// A. 已删的变量不许回来。每一个都只是某个已有含义的第二遍涂色。
for (const dead of ['accent-open', 'accent-changed', 'accent-faint', 'cal-trade-bg', 'cal-amt', 'cal-off']) {
  ok(
    `:root 不再声明 --${dead}（2026-10-26 已并入 --ok / --warn / --ink-3）`,
    !new RegExp(`--${dead}\\s*:`).test(css)
  );
}

// B. 「能买」只有 --ok 一个值：说「这只 / 这天能买」的地方，颜色必须同一支。
//    ★ 2026-10-26 第二轮把日历那四项从这份名单里移出去了——它们不是「能买」：
//      柱子说的是额度、书签说的是哪一周、环说的是今天。名单里留的只剩
//      「状态结论」本身（日报墙、变化行的「变好」）。
for (const [where, sel, prop] of [
  ['日报墙的日期圆点', '.dw-dot', 'background'],
  ['日报墙的可投数字', '.dw-idx-sum b', 'color'],
  ['变化行「变好」的方点', '.cl-dot-opened, .cl-dot-limit-up', 'background'],
]) {
  ok(
    `${where}用 var(--ok)（「能买」全站只有一支绿）`,
    new RegExp(`${prop}\\s*:[^;]*var\\(--ok\\)`).test(ruleBody(sel))
  );
}
// B1c. 基金名只出现一次，而且**跟着组走**（2026-10-27 三轮 / 六轮改判据）。
//   二轮：名字落在家族首行、续行靠 `.fam-cont` 复读（桌面 display:none、窄屏 block）。
//   三轮：序号 / 基金名 / 跟踪误差三格一起 rowspan 跨满整组，续行连那个格子都没有了，
//         `.fam-cont` 从模板和样式里一起删掉；窄屏续块改用 `tr[data-name]::before` 复读名字。
//   六轮：用户「把 C/D 上面显示的家族名称移除了，这样 C/D 是下层的信息更明显一点」——
//         窄屏那个备胎也删了。续块直接从 `[C] 008971` 开始，比组首块矮一行，
//         再靠「组内 5px < 组间 16px」的间距差交代归属。
//   ★ 断言三条：
//     ① 样式里不许再有 `.fam-cont`（防回潮：它一旦回来，名字就又是一个独立的 DOM 复读）
//     ② 窄屏不许再用 `attr(data-name)` 补名字（六轮的反方向断言）
//     ③ 组内间距必须**小于**组间间距——名字删掉之后，这是「谁属于谁」唯一的排版线索
//   桌面「一行一个名字」由 dist 侧的 `.fam-name` 计数守（见下），这里不重复。
{
  ok(
    '桌面基金名靠跨行格，不再有 .fam-cont 复读',
    !/\.fam-cont/.test(css),
    (css.match(/[^\n]*\.fam-cont[^\n]*/) || ['（已删除）'])[0].slice(0, 80)
  );
  ok(
    '窄屏续块不复读家族名（C/D 是下层信息）',
    !/content:\s*attr\(data-name\)/.test(css),
    '（还有 tr[data-name]::before 在补名字）'
  );
  // ★ 不能用 ruleBody()：它只转义 `.[]\`，`:not(...)` 里的括号会被当成正则分组，
  //   匹配的是字面量 `.ftbl tbody tr:not.fr-head`，永远抓不到。直接锚原串。
  const contPad = Number((css.match(/\.ftbl tbody tr:not\(\.fr-head\)\s*\{[^}]*?padding-top:\s*(\d+)px/) || [])[1]);
  const headPad = Number(
    (css.match(/\.ftbl tbody tr\.fr-head:not\(:first-child\)\s*\{[^}]*?padding-top:\s*(\d+)px/) || [])[1]
  );
  ok(
    '窄屏组内间距 < 组间间距（删掉名字后靠间距读归属）',
    contPad > 0 && headPad > contPad,
    `续块 padding-top ${contPad || '?'}px / 组头 ${headPad || '?'}px`
  );
}

// B1c2. 窄屏里「跟踪误差」跟**组标签**同一行，不跟「年费」挤一行（2026-10-27 五轮）。
//   原来是 `"no fee  te"`：这个组级指标挂在 A 那一块的最后一个数据位上
//   （000834 / 10 元 / 年费 1.00% / 1.03%），读起来像 A 类自己的值，C/D 块又压根没有它。
//   现在 te 与 fund（序号 + 基金名）同一行、右对齐：它是这一家的注脚。
//   ★ 判据不写死整串 areas（改个名字就误报），只解析出每一行，问三件事：
//     ① te 必须和 fund 同行；② te 不许和 fee 同行；③ fee 要独占一行。
{
  // 取「含 no fund 的那一段 grid-template-areas」：样式里可能还有别的网格（别处另有 areas）
  const blocks = [...css.matchAll(/grid-template-areas:\s*((?:"[^"]*"\s*)+)/g)].map((m) => m[1]);
  const areaText = blocks.find((b) => b.includes('no fund') && b.includes('te')) || '';
  const rows = [...areaText.matchAll(/"([^"]*)"/g)].map((m) => m[1].trim().split(/\s+/));
  ok('窄屏 grid 里有 fund 行（找得到布局表）', rows.length > 0, areaText.slice(0, 80) || '（没找到 no fund 的 areas）');
  ok('窄屏跟踪误差与组标签（序号 + 基金名）同一行', rows.some((r) => r.includes('fund') && r.includes('te')));
  ok('窄屏跟踪误差不再与年费同一行', !rows.some((r) => r.includes('fee') && r.includes('te')));
  ok('窄屏年费独占一行（每块同构）', rows.some((r) => r.filter((c) => c === 'fee').length === 2));
}

// B1d. 跨行格的垂直位置靠「所有行等高」这一条撑着，不许在跨行格里补 padding。
//   2026-10-27 我一度给它补到 28（误以为「8 + 组头留白」），结果两份额组的名字
//   整体偏下 4px —— 用户看着截图说「06 万家、07 华安 有点偏下」。
//   四轮起组头那条 20px 留白也删了（它让每个家族的 A 份额行比别的行高 20px，
//   用户：「除第一个基金家族外，其他家族 A 份额的行要高一点」），所以现在
//   跨行格 padding 8 时内容中心就是组高的一半，天然居中，不需要任何补偿。
//   判据：凡是带 [rowspan] 的 td 规则里都不许出现 padding-top。
//   ★ 正则必须只锚 `[rowspan]`，不能写 `td\[rowspan\]`：真实写法是
//     `.ftbl td.c-te[rowspan]`（td 与 [rowspan] 之间夹着类名），写死 `td[rowspan]`
//     只能抓住 `.ftbl td[rowspan]` 这一种写法——负向验证第二例就是这么漏过去的。
{
  const bad = css.match(/[^{}]*\[rowspan\][^{]*\{[^}]*padding-top[^}]*\}/g) || [];
  eq('跨行格不额外设 padding-top（居中靠行等高）', bad.length, 0);
}

// B1e. 行必须等高，组界必须真的画出来（2026-10-27 四轮）。
//   两件事都在同一次改动里踩到，而且互为因果：
//   ① 组头那条 `padding-top: 20px` 把每个家族的 A 份额行撑到 61px、其余 41px。
//      表格行高一不等，视线扫列时每隔几行要重新对基线——用户一句「其他家族 A 份额的行
//      要高一点」点破。判据：`fr-head` 的规则里不许出现非零 padding-top。
//   ② 组界那条「--rule-2 深一档」整整两轮没上屏：`border-collapse: collapse` 下，
//      上一行的 `border-bottom: 1px solid var(--rule)` 与组头行的
//      `border-top: 1px solid var(--rule-2)` 争同一条边，同宽同样式时裁决落在
//      同级优先级 + 先后顺序上，前一行先到、颜色归它。行边框并非「不绘制」
//      （把这条临时改成 3px 红，屏幕上立刻出现 15960 个红像素）。
//      修法是把边框落到 `> td`（cell 优先级高于 row），判据因此锚 `> td` 且必须 --rule-2；
//      只锚「有 border-top」不够——降回 --rule 仍然画得出来，但组界又消失了。
//   ③ 窄屏 tr 是 display:grid，边框照画，所以窄屏那条 tr 边框要留；
//      但桌面这条 `tr.fr-head > td` 是 0,2,3，会压过窄屏的 `.ftbl tbody td { border: none }`
//      （0,1,2），不显式归零窄屏每组首块就多一条横线。判据守这个归零。
{
  // ★ 只锚 `fr-head` 里的 **td**：桌面那条加高规则写成 `… tr.fr-head:not(:first-child) td { padding-top: 20px }`；
  //   窄屏的分组间距是 `tr.fr-head { padding-top: 16px }`（窄屏 tr 是 display:grid，合法）。
  //   写 `tr\.fr-head[^{]*\{[^}]*padding-top` 会把窄屏那条一起判红 —— 假阳性。
  const headPad = /[^{}]*tr\.fr-head[^{]*\btd\b[^{]*\{[^}]*padding-top:\s*[1-9]/.test(css);
  ok('组头行不加高（fr-head 的 td 不许 padding-top，行必须等高 41px）', !headPad);
  ok(
    '组界线画在单元格上且是 --rule-2（行级会被上一行的 --rule 抢走颜色）',
    /\.ftbl tbody tr\.fr-head\s*>\s*td\s*\{[^}]*border-top:\s*1px solid var\(--rule-2\)/.test(css),
    '（没找到 `.ftbl tbody tr.fr-head > td { border-top: 1px solid var(--rule-2) }`）'
  );
  ok(
    '窄屏把桌面的单元格组界归零（否则每组首块多一条线）',
    /\.ftbl tbody tr\.fr-head\s*>\s*td\s*\{[^}]*border-top:\s*0/.test(css)
  );
}

// B2. 日历里「时间」用墨——这一组说的是哪一周 / 哪一天，不是状态。
// ★ 2026-10-26 第四轮：柱撤掉后，「额度」在日历里已经没有任何颜色承载
// （数字是墨色）。原来这儿还有两条守柱身/柱顶线的断言，对象不存在了，一并删除；
// 反方向的「日历样式里不许出现 --ok / --heat」在下面 B3，那才是防回潮的那一条。
// ★ 2026-10-27：本周书签从 --ink-2 提到 --ink、2px 加到 3px，同时删掉整行的
//   2.2% 灰底。理由是「本周」与「休市」原来都用「铺一层中性底」这一个手法，
//   读者分不清哪层说时间、哪层说状态。现在底色独属「不开放」，本周只用线。
//   书签既然是本周唯一的标识，就得站到墨阶最深那档——所以这一条不再和别的
//   断言共用 --ink-2，改成逐条给期望令牌。
for (const [where, sel, prop, token] of [
  ['今天那格的描边', '.wk-d.is-today', 'outline', '--ink-2'],
  ['本周书签', '.wk-row.is-this-week .wk-lbl', 'box-shadow', '--ink'],
  // 原来这一条是「『本周』二字用 var(--ink-2)」。那两个字已被删除（它是行高的
  // 第三个来源，见 B4），同一句话改由**周范围的墨深**来说：本周 ink/700、其余 ink-2。
  // 断言迁到新的落点上——判据没放宽，只是被染色的对象换了。
  ['本周那一行的周范围', '.wk-lbl b', 'color', '--ink-2'],
]) {
  ok(
    `${where}用 var(${token})（说的是时间，不是状态；灰＝结构）`,
    new RegExp(`${prop}\\s*:[^;]*var\\(${token}\\)`).test(ruleBody(sel))
  );
}
// B2b. 反方向：本周行**不许再铺底色**。
//   底色在日历里只表示一件事——这天不开放（.wk-d.is-off）。2026-10-27 之前
//   本周行也有 2.2% 的底，两个灰叠在一起时用户直接问「本周和休市是不是同一个颜色」。
//   这条断言盯着它别再回来：本周的时间定位只能用线（书签）和墨阶，不能用面。
{
  const body = ruleBody('.wk-row.is-this-week');
  ok(
    '本周行不铺底色（底色只归「不开放」，时间用线不用面）',
    !/background(-color)?\s*:/.test(body),
    body.slice(0, 100) || '（.wk-row.is-this-week 没有任何规则）'
  );
}
// B3. 反方向：日历这一整块不许再出现任何彩色状态墨或额度色。
//    只断言「用的对不对」不够——只要有人把某一条改回 green，上面三条会红但没人知道原因；
//    这条直接把「日历里不许有 --ok / --heat」写在门禁上。
// ★ 2026-10-26 第四轮加了 --heat：日历已经退回「只区分开不开门」，
//   格子里唯一该有颜色的是「未收录」的 --warn（缺数据要看得见），其余全墨色。
{
  const wkRules = [...css.matchAll(/\.wk[^{]*\{[^}]*\}/g)].map((m) => m[0]).join('\n');
  ok(
    '日历样式里不再出现 var(--ok)（避免日历变成第二片绿）',
    !/var\(--ok\)/.test(wkRules),
    (wkRules.match(/[^{}]*var\(--ok\)[^;]*;/g) || []).join(' ')
  );
  ok(
    '日历样式里不再出现 var(--heat-*)（额度不再由颜色承载）',
    !/var\(--heat-/.test(wkRules),
    (wkRules.match(/[^{}]*var\(--heat-[^;]*;/g) || []).join(' ')
  );
}
// B4. 周历的行高是**常量**（2026-10-26 第五轮）。
//   第四轮撤掉柱以后，格子高度只剩内容决定，同一页里并存 38 / 46.6 / 48 / 49 / 53.1
//   五种行高，三个来源：休市格多一行原因、左列周范围折成两行、「本周」二字占一行。
//   用户看到的是「不能交易的日期把行撑高了」。现在行高写死在 --wk-h，下面四条
//   守住让内容撑不高行的前提。★ 这几条都在 CSS 源码上判，不是因为它们只是文本检查，
//   而是「等高」这件事本身没有 DOM 可量（脚本不跑浏览器）；渲染侧由 --h 那组旧断言
//   的位置空出来以后，靠人工截图复核（2026-10-26 实测桌面 7×46、窄屏 7×42）。
{
  const rowBody = ruleBody('.wk-row');
  ok(
    '周历行高由常量 --wk-h 决定（内容撑不高行）',
    /--wk-h\s*:\s*\d+px/.test(rowBody) && /height\s*:\s*var\(--wk-h\)/.test(rowBody),
    rowBody.slice(0, 140)
  );
  const dBody = ruleBody('.wk-d');
  ok(
    '周历格子不再设 min-height（有它行高就又回到内容手里）',
    !/min-height/.test(dBody),
    dBody.slice(0, 140)
  );
  const reasonBody = ruleBody('.wk-reason');
  ok(
    '休市原因单行 + 省略号（一折行就顶高整行 10–13px）',
    /white-space\s*:\s*nowrap/.test(reasonBody) && /text-overflow\s*:\s*ellipsis/.test(reasonBody),
    reasonBody.slice(0, 160)
  );
  // 反方向：「本周」二字不许回来。它是行高第三个来源，说的是「哪一周」这件事
  // 上面两条 CSS（书签 + 淡底）加周范围的墨深已经说完了。
  // ★ 读模板源码而不是 dist：这两条在 --no-dist 下也要能判（refresh.yml 跑的就是它）。
  const wkTpl = fs.readFileSync(path.join(ROOT, 'src', 'components', 'WeekCal.astro'), 'utf8');
  ok(
    '周历不再写「本周」二字（同一句话由书签 + 墨深承担）',
    !/wk-now/.test(wkTpl) && !/\.wk-now/.test(css),
    (wkTpl.match(/wk-now[^\n]*/) || [])[0] || (css.match(/\.wk-now\s*\{[^}]*\}/) || [])[0] || ''
  );
  // 窄屏只留周一那天：46px 放不下 8 个等宽字符，折行会断成「10.12–」/「16」。
  ok(
    '窄屏周标签只留周一日期（后半段 .wk-rng 隐藏）',
    /<span class="wk-rng">/.test(wkTpl) && /\.wk-rng\s*\{\s*display:\s*none/.test(css),
    (css.match(/\.wk-rng\s*\{[^}]*\}/g) || []).join(' ')
  );
}

// B5. 休市格的底色必须是**中性**的（2026-10-27）。
//   用户：「看下交易日历，感觉区分度不够」。根因是四种状态全落在同一个白底上，
//   只能靠「日期浓淡 + 10px 小字」区分——额度是数字、原因是文字，100% 缩放下一个样。
//   现在给休市格压一层极淡底，让图底关系成立：可买＝白纸（默认，不画），
//   买不到＝压暗（异常，画出来）。这两条守的是它**是什么颜色**：
//   只许 R=G=B（纸上一块压暗的灰），不许变成任何一支状态墨的浅色版 ——
//   绿/橄榄/红在站内各有主人，日历再借一个色相就成了第四套语义。
{
  const offBody = ruleBody('.wk-d.is-off');
  const bg = (offBody.match(/background(?:-color)?\s*:\s*([^;]+);/) || [])[1] || '';
  const rgb = bg.match(/rgba?\(\s*(\d+)\s*[,\s]\s*(\d+)\s*[,\s]\s*(\d+)/);
  ok('休市格有一层底色（区分度靠图底关系，不靠 10px 小字）', !!rgb, offBody.slice(0, 120) || '（.wk-d.is-off 没有底色）');
  ok('休市格的底色是中性的（R=G=B，不是色块）', !!rgb && rgb[1] === rgb[2] && rgb[2] === rgb[3], bg);
}

// 反方向那两支：变坏用 --warn（橄榄），不知道用 --ink-3（墨灰）。
// 它们原来是独立的 --accent-changed（赭黄）/ --accent-faint，方点因此成了页面上
// 唯一需要第三、第四种颜色才说得清的东西——而同一行右端已经用状态墨说过结论。
for (const [where, sel, v] of [
  ['变化行「变坏」的方点', '.cl-dot-stopped, .cl-dot-limit-down, .cl-dot-limit-set, .cl-dot-limit-clear', 'warn'],
  ['变化行「不知道」的方点', '.cl-dot-unknown', 'ink-3'],
]) {
  ok(
    `${where}用 var(--${v})（不另起颜色）`,
    new RegExp(`background\\s*:[^;]*var\\(--${v}\\)`).test(ruleBody(sel))
  );
}

// D. 限额标签＝橄榄，不是可投的松绿。
// 一张卡里同时有「右上角状态标签」和「下方 21 格热力条」：标签若是松绿、格子是橄榄，
// 同一个视野里就是两支绿——这是 2026-10-26「颜色太多」的另一半（前半是同一支绿写三遍）。
// 用户 2026-10-23 原话「限额申购的绿色也换成热力条这个」，指的正是这一条。
const famCard = fs.readFileSync(path.join(ROOT, 'src', 'components', 'FamilyCard.astro'), 'utf8');
ok(
  "FamilyCard 里 LIMITED 走 tag-limit（限额＝橄榄，与热力条同族）",
  /famStatus === 'LIMITED'\s*\?\s*'tag-limit'/.test(famCard),
  '限额标签若回退到 tag-ok，一张卡里又会出现两支绿'
);
ok('.tag-limit 用 var(--warn)', /\.tag-limit\s*\{[^}]*color:\s*var\(--warn\)/.test(css));
ok(
  '.st-limit 用 var(--warn)（详情页状态列与家族卡同口径）',
  /\.st-limit\s*\{[^}]*color:\s*var\(--warn\)/.test(css)
);
// 跨端：小程序自己算 famCls，漏改就是「网页橄榄、小程序松绿」
const mpStorePath = path.join(ROOT, 'miniprogram', 'utils', 'store.js');
if (fs.existsSync(mpStorePath)) {
  const mpStore = fs.readFileSync(mpStorePath, 'utf8');
  ok(
    "小程序 famCls 里 LIMITED 走 tag-limit",
    /s === 'LIMITED'\)\s*return 'tag-limit'/.test(mpStore)
  );
}

// C. 色相家族计数 + 同相窗口去重。
const chroma = (hex) => {
  const [, a, b] = toLab(hex);
  return Math.hypot(a, b);
};
const hueDeg = (hex) => {
  const [, a, b] = toLab(hex);
  const d = (Math.atan2(b, a) * 180) / Math.PI;
  return d < 0 ? d + 360 : d;
};
// 阈值 12 而不是 8：--ink-3 #6b6859 的 C* 是 9.0（一层很浅的暖灰），色相角 101°——
// 定 8 会把它当成一支橄榄，家族数虚高，断言看着过其实在比错的节点。
const CHROMATIC_MIN = 12;

// C0. 暂停必须是**中性**灰。这一条是 2026-10-26 第二轮反馈的直接产物：
// 旧的 #6b665a 看着是灰，算出来 C*=7.5、色相 92°——一支偏橄榄的暖灰。
// 它夹在卡片的橄榄格里（117°）就读成「褪色的绿」，而它与 --ink-3 的 ΔE 只有 2.0，
// 也就是说「暂停」和「未公布」本来是同一支灰写了两遍。两条都只有算才看得见。
const dE = (a, b) => {
  const A = toLab(a), B = toLab(b);
  return Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]);
};
ok(
  `--stop 是中性灰（C* ≤ 3，实测 ${chroma(rootVars.stop).toFixed(1)}）`,
  chroma(rootVars.stop) <= 3,
  '偏暖就会在橄榄格里读成「褪色的绿」——用户 2026-10-26 的原话是「暂停申购的绿不一样」'
);
ok(
  `--stop 与 --ink-3 的 ΔE ≥ 5（实测 ${dE(rootVars.stop, rootVars['ink-3']).toFixed(1)}）`,
  dE(rootVars.stop, rootVars['ink-3']) >= 5,
  '两支灰差不到 3 就等于一支灰写了两遍，而它们的含义完全不同（买不了 / 不知道）'
);

const palette = new Map();
for (const [name, val] of Object.entries(rootVars)) {
  const v = String(val).trim();
  if (/^#[0-9a-f]{6}$/i.test(v) && chroma(v) >= CHROMATIC_MIN) palette.set(name, v);
}
for (const [slug, v] of Object.entries(boardVars)) {
  if (v.accent && chroma(v.accent) >= CHROMATIC_MIN) palette.set(`${slug}.accent`, v.accent);
}

const HUE_TOL = 20;
const sorted = [...palette]
  .map(([name, hex]) => ({ name, hex, hue: hueDeg(hex) }))
  .sort((a, b) => a.hue - b.hue);
const clusters = [];
for (const e of sorted) {
  const last = clusters[clusters.length - 1];
  if (last && e.hue - last[last.length - 1].hue <= HUE_TOL) last.push(e);
  else clusters.push([e]);
}
// 色相是环：355° 与 5° 是同一族，首尾也要合一次
if (clusters.length > 1) {
  const head = clusters[0];
  const tail = clusters[clusters.length - 1];
  if (head[0].hue + 360 - tail[tail.length - 1].hue <= HUE_TOL) {
    clusters[0] = [...tail, ...head];
    clusters.pop();
  }
}
const famDesc = clusters.map((c) => c.map((e) => `${e.name}@${e.hue.toFixed(0)}°`).join('+')).join(' | ');
ok('非中性色相家族 ≤ 4（绿 / 橄榄 / 蓝 / 红）', clusters.length <= 4, famDesc);

// 同一支颜色写了第二遍：同一个 20° 窗口里不许出现两个不同的语义。
// 热力四档是**同色相的明度阶梯**（这是它的设计，不是失误），所以白名单只放它们，
// 外加 --warn（与 heat-4 同值，用户 2026-10-23 明确要求「限额的绿换成热力条这个」）。
const HEAT_FAMILY = new Set(['heat-1', 'heat-2', 'heat-3', 'heat-4', 'warn']);
for (const c of clusters) {
  const outsiders = c.filter((e) => !HEAT_FAMILY.has(e.name));
  ok(
    `色相 ${c[0].hue.toFixed(0)}° 家族里只有一个语义（${outsiders.map((e) => e.name).join(' / ') || '热力阶梯'}）`,
    outsiders.length <= 1,
    outsiders.map((e) => `${e.name}=${e.hex}`).join(' , ')
  );
}

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
  // 站标是两种形态，各取各的证据：
  //   字母形态 = 内联 SVG（取 <path> 的 d），字标形态 = QDII 文字。
  // ★ 只断言「页面里有 site-mark」会漏掉形态互换（N 出现在 /my、QDII 出现在标普页都不报错），
  //   所以两种形态分别取指纹、逐页等值。
  const markPathOf = (h) => ((h || '').match(/<svg class="site-mark"[\s\S]{0,300}?<path d="([^"]*)"/) || [])[1] ?? null;
  const markTextOf = (h) => ((h || '').match(/<span class="site-mark site-mark-text"[^>]*>([^<]*)<\/span>/) || [])[1] ?? null;
  // 顶栏站名（.site-brand 里最后一个 span）。共用页站标已经是 QDII 字标，
  // 站名再以 QDII 开头就成了「[QDII] QDII 开门日报」——同一个词读两遍。
  const brandTextOf = (h) => {
    const m = (h || '').match(/<a class="site-brand"[^>]*>([\s\S]*?)<\/a>/);
    if (!m) return null;
    const t = [...m[1].matchAll(/<span[^>]*>([^<]*)<\/span>/g)].map((x) => x[1].trim());
    return t.length ? t[t.length - 1] : null;
  };

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
      // 指数页保留单字母站标（用户 2026-10-26：「纳指、标普还是单字母logo」）。
      // N 全直线、S 是曲线，用 path 的开头当指纹——两个字形互换会立刻红。
      const wantLetter = b.slug === 'sp500' ? 'M23.5 13.5 C' : 'M10 11 ';
      const mp = markPathOf(h);
      ok(
        `${p_(rel)} 站标是单字母 ${b.slug === 'sp500' ? 'S' : 'N'}`,
        !!mp && mp.startsWith(wantLetter),
        mp || '（没有 SVG 站标）'
      );
      ok(`${p_(rel)} 站标不是 QDII 字标（指数页用字母）`, markTextOf(h) === null, markTextOf(h) || '');
      ok(`${p_(rel)} 站标不再用外部 SVG`, !h.includes('/nasdaq-logo.svg'));
      // 站名带指数名（headerBrand 是给共用页用的，指数页别顺手也传）
      eq(`${p_(rel)} 顶栏站名带指数名`, brandTextOf(h), b.slug === 'sp500' ? '标普500开门日报' : '纳指100开门日报');
    }
    // 共用页：没有指数身份 → 换成 QDII 字标（用户原话「其他情况用QDII logo，包括我的基金、订阅」）。
    for (const rel of [path.join('my', 'index.html'), path.join('subscribe', 'index.html')]) {
      eq(`${p_(rel)} 站标字是 QDII`, markTextOf(pageOf(rel)), 'QDII');
      ok(`${p_(rel)} 站标不用字母形态（共用页不冒充板块）`, markPathOf(pageOf(rel)) === null);
      eq(`${p_(rel)} 顶栏站名不再重复 QDII`, brandTextOf(pageOf(rel)), '开门日报');
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
      // 详情页有指数身份（导航里那个指数是当前项）→ 站标跟指数走，不换 QDII 字标。
      const fp = markPathOf(h);
      ok(
        `/f/${code} 站标仍是单字母 ${slug === 'sp500' ? 'S' : 'N'}`,
        !!fp && fp.startsWith(slug === 'sp500' ? 'M23.5 13.5 C' : 'M10 11 '),
        fp || '（没有 SVG 站标）'
      );
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
