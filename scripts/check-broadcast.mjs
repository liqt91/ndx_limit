#!/usr/bin/env node
// 发信口径门禁：订阅偏好、按指数裁剪、收盘前报的默认版次。
//
// 为什么需要它：2026-10-23 起日报按订阅范围分指数裁剪（只订标普500 的人不该在信里
// 看到纳指的数字），而「裁剪」这种逻辑全是纯字符串拼装——错了不会报错，只会把别人
// 的数字安静地塞进你的信里。同时这一版把默认版次从 morning 改成 close（收盘前报），
// 一旦有人把默认值改回去，订阅者收到的信措辞与视角就全错，而 CI 依旧全绿。
//
// 检查五组（任何一条不成立都 exit 1）：
//   1. composeEmail：单指数信里不许出现另一个指数的任何片段；两个都订时两节都在，
//      顺序固定；不可用指数即使被要求也丢弃
//   2. 订阅记录解析：老记录（纯邮箱）只订纳指；JSON 里 indices 空/乱写也只回纳指
//   3. 收件人计划：所订指数今天不可用 → 跳过而不是「发一封什么都没有的信」
//   4. 边缘函数与脚本的指数白名单逐字一致（三份独立实现，靠字面量比对防漂移）
//   5. 默认版次 = close（收盘前报）；产出文案里不许再出现「早上 8 点」「明早 08:10」
//
// 用法：
//   node scripts/check-broadcast.mjs
//
// 依赖：仅 Node 22 内置。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readJson,
  buildDailyDigest,
  composeEmail,
  evaluateFreshness,
  loadHolidays,
  todayShanghai,
  buyableFamilies,
  buyableBlocks,
  aggregateCny,
  summarizeDay,
  DEFAULT_EDITION,
  INDEX_KEYS,
  INDEX_LABEL,
  NDX,
  SP500,
} from './digest.mjs';
import { normalizeIndices, parseSubscriberValue, mergeIndices, planRecipients, countByIndex } from './broadcast-plan.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

const read = (rel) => {
  try {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8');
  } catch {
    return '';
  }
};

// ── 1. composeEmail 的裁剪 ──
// 用合成 digest 而不是真实数据：真实数据里两个指数的开门数偶尔会撞车（都 7 家），
// 那时「A 的数字没出现在 B 的信里」这条断言会因为数字相同而变成假绿。
// 合成值刻意取不可能谐音的数：31337 / 62626。
console.log('\n1. 按订阅范围裁剪正文（合成 digest）');
const fake = (k, label, fakeN) => ({
  healthy: true,
  indexKey: k,
  label,
  edition: 'close',
  date: '2026-10-23',
  subject: `${label} 开门日报 · 2026-10-23 收盘前`,
  text: `【${label} 开门日报 · 2026-10-23 收盘前】\n\n收盘前：${fakeN} 家开门 · 合计 ${fakeN} 元可投\n\n15:00 前下单按今日净值。`,
  parts: {
    head: `【${label} 开门日报 · 2026-10-23 收盘前】`,
    blocks: [`收盘前：${fakeN} 家开门 · 合计 ${fakeN} 元可投`],
    footer: '15:00 前下单按今日净值。明天收盘前再报。',
  },
});
const digests = { [NDX]: fake(NDX, INDEX_LABEL[NDX], 31337), [SP500]: fake(SP500, INDEX_LABEL[SP500], 62626) };

const ndxOnly = composeEmail({ digests, indices: [NDX] });
ok('只订纳指：标题只提纳指100', ndxOnly.subject.includes('纳指100') && !ndxOnly.subject.includes('标普500'), ndxOnly.subject);
ok('只订纳指：正文不含标普500 字样', !ndxOnly.text.includes('标普500'), ndxOnly.text.slice(0, 80));
ok('只订纳指：正文不含标普的额度 62626', !ndxOnly.text.includes('62626'));
ok('只订纳指：正文含自己的额度 31337', ndxOnly.text.includes('31337'));

const spOnly = composeEmail({ digests, indices: [SP500] });
ok('只订标普：标题只提标普500', spOnly.subject.includes('标普500') && !spOnly.subject.includes('纳指100'), spOnly.subject);
ok('只订标普：正文不含纳指100 字样', !spOnly.text.includes('纳指100'), spOnly.text.slice(0, 80));
ok('只订标普：正文不含纳指的额度 31337', !spOnly.text.includes('31337'));
ok('只订标普：正文含自己的额度 62626', spOnly.text.includes('62626'));

const both = composeEmail({ digests, indices: INDEX_KEYS });
ok('两个都订：标题是中性站名', both.subject.startsWith('QDII 开门日报'), both.subject);
ok('两个都订：两节都在', both.text.includes('纳指100') && both.text.includes('标普500'));
ok('两个都订：纳指在标普之前', both.text.indexOf('━━ 纳指100 ━━') < both.text.indexOf('━━ 标普500 ━━'));
ok('两个都订：各自数字都在自己那节', both.text.includes('31337') && both.text.includes('62626'));
ok('两个都订：小节分隔线成对出现', (both.text.match(/━━/g) || []).length === 4, String((both.text.match(/━━/g) || []).length));

const half = composeEmail({
  digests: { ...digests, [SP500]: { ...digests[SP500], healthy: false, text: '⚠ 标普500 数据不完整' } },
  indices: INDEX_KEYS,
});
ok('指数不可用时被丢弃（不拼进信）', !half.text.includes('标普500'), half.subject);
ok('丢弃后退化成单指数标题', half.subject.includes('纳指100'));
eq('composeEmail 回报实际发了哪些指数', half.indices.join(','), NDX);

const none = composeEmail({ digests: { [NDX]: { ...digests[NDX], healthy: false } }, indices: [NDX] });
eq('全部不可用 → 空信（调用方据此跳过）', none.text, '');
eq('composeEmail 省略 indices 时按两个指数', composeEmail({ digests }).indices.length, 2);

// ── 2. 订阅记录解析 ──
console.log('\n2. 订阅记录解析（老记录默认只纳指）');
const legacy = parseSubscriberValue('Foo@Bar.com');
eq('老记录（纯邮箱）取出邮箱', legacy.email, 'foo@bar.com');
eq('老记录只订纳指', legacy.indices.join(','), NDX);
eq('老记录标记 legacy', legacy.legacy, true);

const jsonBoth = parseSubscriberValue(JSON.stringify({ email: 'a@b.com', indices: INDEX_KEYS }));
eq('新记录两个指数都在', jsonBoth.indices.join(','), INDEX_KEYS.join(','));
eq('新记录不算 legacy', jsonBoth.legacy, false);

eq('JSON 里 indices 为空 → 只纳指', parseSubscriberValue(JSON.stringify({ email: 'a@b.com', indices: [] })).indices.join(','), NDX);
eq('JSON 里 indices 乱写 → 只纳指', parseSubscriberValue(JSON.stringify({ email: 'a@b.com', indices: ['标普100'] })).indices.join(','), NDX);
eq('坏 JSON → null（整条丢弃，不猜）', parseSubscriberValue('{oops'), null);
eq('空值 → null', parseSubscriberValue(''), null);
eq('只有标普也认', parseSubscriberValue(JSON.stringify({ email: 'a@b.com', indices: [SP500] })).indices.join(','), SP500);

eq('normalizeIndices 认字符串', normalizeIndices('标普500').join(','), SP500);
eq('normalizeIndices 保持 INDEX_KEYS 顺序', normalizeIndices([SP500, NDX]).join(','), INDEX_KEYS.join(','));
eq('normalizeIndices 去重', normalizeIndices([NDX, NDX]).join(','), NDX);
eq('mergeIndices 只增不减', mergeIndices([NDX], [SP500]).join(','), INDEX_KEYS.join(','));
eq('mergeIndices 不重复', mergeIndices(INDEX_KEYS, [NDX]).join(','), INDEX_KEYS.join(','));

// ── 3. 收件人计划 ──
console.log('\n3. 收件人计划（按可用指数裁剪 / 不可用就跳过）');
const subs = [
  { email: 'ndx@x.com', indices: [NDX] },
  { email: 'sp@x.com', indices: [SP500] },
  { email: 'both@x.com', indices: [...INDEX_KEYS] },
];
const planAll = planRecipients({ subscribers: subs, usable: INDEX_KEYS });
eq('两个指数都可用 → 全部实发', planAll.recipients.length, 3);
eq('per-index 计数：纳指', countByIndex(planAll.recipients)[NDX], 2);
eq('per-index 计数：标普', countByIndex(planAll.recipients)[SP500], 2);

const planSp = planRecipients({ subscribers: subs, usable: [SP500] });
eq('只标普可用 → 纳指独订者被跳过', planSp.recipients.map((r) => r.email).join(','), 'sp@x.com,both@x.com');
eq('跳过原因是 index_unusable', planSp.skipped[0].reason, 'index_unusable');
eq('两个都订的人只剩标普', planSp.recipients.find((r) => r.email === 'both@x.com').indices.join(','), SP500);
eq('全不可用 → 零实发', planRecipients({ subscribers: subs, usable: [] }).recipients.length, 0);

// ── 4. 三份指数白名单逐字一致 ──
console.log('\n4. 指数白名单：digest.mjs / subscribe.js / confirm.js / subscribers.js 一致');
const ws = `\\['${INDEX_KEYS.join("', '")}'\\]`;
for (const rel of ['edge-functions/api/subscribe.js', 'edge-functions/api/confirm.js', 'edge-functions/api/subscribers.js']) {
  const src = read(rel);
  ok(`${rel} 的白名单 == INDEX_KEYS`, new RegExp(`const INDEX_KEYS = ${ws};`).test(src));
  ok(`${rel} 的老记录默认指数 == 纳指`, new RegExp(`const LEGACY_INDEX = '${NDX}';`).test(src));
}
ok('subscribers.js 返回带 indices 的名单', /subscribers: subs/.test(read('edge-functions/api/subscribers.js')));
ok('confirm.js 把 indices 写进 sub_（不是只写邮箱）', /JSON\.stringify\(\{ email, indices, ts/.test(read('edge-functions/api/confirm.js')));
ok('subscribe.js 存 JSON 记录', /JSON\.stringify\(\{ email, indices, ts/.test(read('edge-functions/api/subscribe.js')));

// ── 5. 默认版次与文案 ──
console.log('\n5. 默认版次 = close（收盘前报）');
eq('digest.mjs 默认版次', DEFAULT_EDITION, 'close');
ok('send.mjs 用 DEFAULT_EDITION 当缺省', /process\.env\.DIGEST_EDITION \|\| DEFAULT_EDITION/.test(read('scripts/send.mjs')));
const wf = read('.github/workflows/broadcast.yml');
ok('broadcast.yml 的 edition 默认 close', /edition:[\s\S]{0,400}?default: close/.test(wf), wf.match(/edition:[\s\S]{0,400}?default: (\w+)/)?.[1]);
ok('broadcast.yml 里没有 default: morning', !/default: morning/.test(wf));
ok('broadcast.yml 把门禁 usable 传给 send', /DIGEST_INDICES: \$\{\{ inputs\.indices \|\| steps\.freshness\.outputs\.usable \}\}/.test(wf));

// 产出文案：不许再出现「早上 8 点」「明早 08:10」这类已经不存在的时点。
// 只扫**非注释行**：注释里写「别再写早上 8 点」正是为了防止它再次出现，
// 把警示语本身判成违规会让门禁变成「谁提就罚谁」，下一个人只会把注释删掉。
console.log('\n6. 产出文案（不许再写早上 8 点）');
const codeOnly = (src) =>
  src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('<!--'));
    })
    .join('\n');
for (const rel of ['scripts/digest.mjs', 'scripts/send.mjs', 'edge-functions/api/confirm.js', 'edge-functions/api/subscribe.js', 'src/pages/subscribe.astro']) {
  const src = codeOnly(read(rel));
  ok(`${rel} 无「早上 8 点」`, !/早上\s*8\s*点/.test(src));
  ok(`${rel} 无「明早 08:10」`, !/明早\s*08:10/.test(src));
}
const closeD = buildDailyDigest({ edition: 'close', indexKey: NDX });
if (closeD.healthy) {
  ok('收盘前报标题带「收盘前」', closeD.subject.endsWith('收盘前'), closeD.subject);
  ok('收盘前报正文有当日快照', /收盘前：\d+ 家开门/.test(closeD.text), closeD.text.split('\n')[2]);
  ok('收盘前报收尾写「明天收盘前再报」', closeD.text.includes('明天收盘前再报'));
  ok('收盘前报不写「今晨 08:10」', !/08:10/.test(closeD.text));
} else {
  console.log('  --  纳指今天的 digest 不健康，跳过正文断言（数据门禁会单独报）');
}
const morningD = buildDailyDigest({ edition: 'morning', indexKey: NDX });
ok('盘前报标题带「盘前」而不是「早报」', !morningD.subject.includes('早报') && (morningD.healthy ? morningD.subject.endsWith('盘前') : true), morningD.subject);

// ── 7. 分指数新鲜度：一个过期不连坐另一个 ──
console.log('\n7. 分指数新鲜度');
const realFunds = readJson('funds.json', { funds: [] }).funds;
const holidays = loadHolidays();
const today = todayShanghai();
const codesOf = (k) => new Set(realFunds.filter((f) => f.indexKey === k).flatMap((f) => f.codes.map((c) => c.code)));
const mkHistory = (ndxDate, spDate) => {
  const h = {};
  for (const c of codesOf(NDX)) h[c] = [{ date: ndxDate, status: 'OPEN', limit: 10 }];
  for (const c of codesOf(SP500)) h[c] = [{ date: spDate, status: 'OPEN', limit: 10 }];
  return h;
};
const stubMeta = {};
for (const c of [...codesOf(NDX), ...codesOf(SP500)]) stubMeta[c] = { name: 'x' };

const f1 = evaluateFreshness({ funds: realFunds, history: mkHistory(today, '2020-01-02'), meta: stubMeta, today, holidays });
ok('纳指今天、标普过期 → 纳指健康', f1.byIndex[NDX].healthy);
ok('纳指今天、标普过期 → 标普被判 stale', f1.byIndex[SP500].problems.includes('stale'), f1.byIndex[SP500].problems.join(','));
ok('整体 allHealthy=false', f1.allHealthy === false);

const f2 = evaluateFreshness({ funds: realFunds, history: mkHistory(today, today), meta: stubMeta, today, holidays });
ok('都新鲜 → 两个都健康', f2.byIndex[NDX].healthy && f2.byIndex[SP500].healthy);

const f3 = evaluateFreshness({ funds: realFunds, history: mkHistory(today, today), meta: {}, today, holidays });
ok('metadata 全缺 → 覆盖率 0，判不完整', f3.byIndex[NDX].problems.includes('coverage') && f3.byIndex[SP500].problems.includes('coverage'));

// ── 8. 今日能买清单（代码 + 额度）──
// 为什么需要它：清单是「读者照着下单」的那一段，错了不会报错——他会买错代码，
// 或者看不到自己那只。而且清单要靠「和标题合计对得上」才算同一份数据，
// 所以这里既验结构（谁该进来、谁不该进来），也验等值（额度加总 == 标题合计）。
console.log('\n8. 今日能买清单（代码 + 额度）');
const D = '2026-10-26';
const fxFunds = [
  // 甲：三种额度写法各一个（有数字 / 不限 / 待核验）+ 暂停 + 只有昨天的数据
  {
    company: '甲',
    baseName: '纳斯达克100',
    indexKey: NDX,
    currency: 'CNY',
    codes: [
      { cls: 'A', code: '900001' },
      { cls: 'B', code: '900002' },
      { cls: 'C', code: '900003' },
      { cls: 'D', code: '900004' },
      { cls: 'E', code: '900005' },
    ],
  },
  // 乙：整家今天都买不到 → 连名字都不该出现
  { company: '乙', baseName: '纳斯达克100', indexKey: NDX, currency: 'CNY', codes: [{ cls: 'A', code: '900006' }] },
  // 丙：美元份额，必须单独一组、额度写「美元」
  { company: '丙', baseName: '纳斯达克100', indexKey: NDX, currency: 'USD', codes: [{ cls: 'A', code: '900007' }] },
  // 丁：另一个指数 → 纳指的清单里不许出现
  { company: '丁', baseName: '标普500', indexKey: SP500, currency: 'CNY', codes: [{ cls: 'A', code: '900009' }] },
];
const fxHistory = {
  '900001': [{ date: D, status: 'LIMITED', limit: 10 }],
  '900002': [{ date: D, status: 'OPEN', limit: null }],
  '900003': [{ date: D, status: 'LIMITED', limit: null }],
  '900004': [{ date: D, status: 'STOPPED', limit: null }],
  '900005': [{ date: '2026-10-25', status: 'LIMITED', limit: 7 }],
  '900006': [{ date: D, status: 'STOPPED', limit: null }],
  '900007': [{ date: D, status: 'LIMITED', limit: 5 }],
  '900009': [{ date: D, status: 'LIMITED', limit: 99 }],
};
const fxFams = buyableFamilies({ funds: fxFunds, history: fxHistory, date: D, indexKey: NDX });
// 取份额时一律走这个兜底：断言本身不许抛异常。一次 undefined 就让脚本在 section 8
// 中途崩掉的话，后面所有断言（含跨指数泄漏）都不会执行，那才是真正的假绿灯——
// 「红了」只是运气好，报的是堆栈而不是能修的那一条（2026-10-26 负向注入实测撞到）。
const fxShare = (i) => fxFams[0]?.shares?.[i] ?? {};
eq('只留「今天有点位且能买」的家族', fxFams.map((f) => f.name).join(','), '甲纳斯达克100,丙纳斯达克100美元');
eq('甲家列出 3 个份额（暂停 / 旧数据各剔掉一个）', fxFams[0]?.shares.length, 3);
eq('额度有数字 → 10元', fxShare(0).amount, '10元');
eq('OPEN 无数字 → 不限（不是 0，也不是待核验）', fxShare(1).amount, '不限');
eq('LIMITED 无数字 → 待核验（不能当 0 报）', fxShare(2).amount, '待核验');
eq('美元份额额度带币种 → 5美元', fxFams[1]?.shares?.[0]?.amount ?? {}, '5美元');
ok('暂停的份额不进清单', !fxFams.flatMap((f) => f.shares).some((s) => s.code === '900004'));
ok('当天没点位的份额不进清单', !fxFams.flatMap((f) => f.shares).some((s) => s.code === '900005'));
ok('另一个指数的份额不进本指数清单', !fxFams.flatMap((f) => f.shares).some((s) => s.code === '900009'));

const fxBlocks = buyableBlocks({ funds: fxFunds, history: fxHistory, date: D, indexKey: NDX });
const fxBlock = (i) => fxBlocks[i] || '';
eq('两个币种 → 两组（人民币在前）', fxBlocks.length, 2);
ok('人民币组标题报份额数', /^今日能买（人民币份额 3 个）/.test(fxBlock(0)), fxBlock(0).split('\n')[0]);
ok('美元组标题报份额数', /^今日能买（美元份额 1 个）/.test(fxBlock(1)), fxBlock(1).split('\n')[0]);
ok('一家一行，份额之间用「·」', fxBlock(0).includes('甲纳斯达克100：A类 900001 10元 · B类 900002 不限 · C类 900003 待核验'));

// 等值：清单里能加总的额度，必须正好等于标题里的「合计 X 元可投」。
// 这是「清单和合计是同一份数据」的唯一硬证据——分开算两遍，数字对不上就是有一遍错了。
const fxPts = {};
for (const code in fxHistory) {
  const hit = fxHistory[code].find((p) => p.date === D);
  if (hit) fxPts[code] = hit;
}
const fxAgg = aggregateCny(fxFunds, fxPts, NDX);
const fxSum = fxFams
  .filter((f) => f.currency === 'CNY')
  .flatMap((f) => f.shares)
  .reduce((a, s) => a + (s.limit ?? 0), 0);
eq('清单额度加总 == 人民币合计', fxSum, fxAgg.total);
eq('清单家族数 == 开门家数', fxFams.filter((f) => f.currency === 'CNY').length, fxAgg.opened);

// 真实数据：这段刻意**不复用 buyableFamilies**（上面那节已经单独验过它的语义），
// 改成从 funds.json + history.json 直接重算一遍「今天该出现哪些代码、每个该写多少」。
// ★ 为什么必须重算：拿同一个函数同时生成正文和期望值，任何「少列一个份额」之类的
//   缺陷会在两边同时发生，断言照样全绿（2026-10-26 负向注入实测确实没红过）。
const realHistory = readJson('history.json', {});
for (const k of INDEX_KEYS) {
  const d = k === NDX ? closeD : buildDailyDigest({ edition: 'close', indexKey: k });
  const label = INDEX_LABEL[k];
  if (!d.healthy) {
    console.log(`  --  ${label} 今天的 digest 不健康，跳过正文清单断言（数据门禁会单独报）`);
    continue;
  }
  const rows = [];
  const famsWithBuyable = [];
  for (const f of realFunds.filter((x) => x.indexKey === k)) {
    const unit = f.currency === 'USD' ? '美元' : '元';
    let any = false;
    for (const c of f.codes) {
      const hit = (realHistory[c.code] || []).find((p) => p.date === d.date);
      if (!hit) continue;
      if (hit.status !== 'OPEN' && hit.status !== 'LIMITED') continue;
      any = true;
      rows.push({
        code: c.code,
        limit: hit.limit == null ? null : hit.limit,
        text: hit.limit != null ? `${hit.limit}${unit}` : hit.status === 'OPEN' ? '不限' : '待核验',
      });
    }
    if (any) famsWithBuyable.push(f);
  }
  if (!rows.length) {
    ok(`${label}：今天没有可买份额 → 正文不出现「今日能买」`, !d.text.includes('今日能买'));
    continue;
  }
  // 把「今日能买」那一块从正文里切出来（到下一个空行为止），只在这一块里数代码，
  // 不然变化清单里的数字会被当成代码，断言就永远为真了。
  const block = (d.text.match(/今日能买[\s\S]*?(?=\n\n|$)/) || [''])[0];
  const shown = [...new Set((block.match(/\b\d{6}\b/g) || []))].sort();
  const want = rows.map((r) => r.code).sort();
  eq(`${label}：清单里的代码集合 == 当日可买份额`, shown.join(','), want.join(','));
  // 逐条等值：每个代码后面紧跟它自己的额度（数字、不限、待核验三种写法都要对）
  const wrong = rows.filter((r) => !block.includes(`${r.code} ${r.text}`));
  ok(`${label}：每个代码后面紧跟自己的额度`, wrong.length === 0, wrong.slice(0, 3).map((r) => `${r.code} 期望「${r.text}」`).join('；'));
  const agg = summarizeDay(realFunds, realHistory, d.date, k);
  eq(`${label}：清单家族数 == 标题开门家数`, famsWithBuyable.length, agg.opened);
  const listedSum = rows.reduce((a, r) => a + (r.limit ?? 0), 0);
  if (rows.every((r) => r.limit != null)) eq(`${label}：清单额度加总 == 标题里的合计`, listedSum, agg.total);
  else console.log(`  --  ${label} 有「不限/待核验」的份额，跳过加总断言（合计本身不含它们）`);
  // 暂停的份额不许混进来（拿今天确实暂停的一个代码做反向样本）
  const stoppedCode = Object.keys(realHistory).find((code) => {
    const hit = realHistory[code].find((p) => p.date === d.date);
    return hit && hit.status === 'STOPPED' && !want.includes(code);
  });
  ok(`${label}：暂停的份额不进清单`, !stoppedCode || !block.includes(stoppedCode), stoppedCode || '（今天没有暂停样本）');
  ok(`${label}：清单位于变化清单之后、页脚之前`, d.text.indexOf('今日能买') > d.text.indexOf('较 ') && d.text.indexOf('今日能买') < d.text.indexOf(d.parts.footer));
}
// 分指数裁剪对清单同样生效：只订纳指的人不该在信里看到标普的任何代码
const realDigests = { [NDX]: closeD, [SP500]: buildDailyDigest({ edition: 'close', indexKey: SP500 }) };
const allSpCodes = realFunds.filter((f) => f.indexKey === SP500).flatMap((f) => f.codes.map((c) => c.code));
const ndxMail = composeEmail({ digests: realDigests, indices: [NDX] });
ok('只订纳指：信里没有标普的任何代码', !allSpCodes.some((c) => ndxMail.text.includes(c)));

// ── 9. 订阅页的日报墙与信同源 ──
// 墙上每一张卡片都是邮件的镜像。2026-10-26 邮件加了「代码 + 额度」，墙却没跟上——
// 用户打开订阅页看「最近日报」，发现能买的基金一个都没有。根因是墙上那套拼装是
// 另一份实现。这里钉死「只许有一份」：清单函数由 loader 从 digest.mjs 引过去。
console.log('\n9. 订阅页日报墙与信同源（清单只许有一份实现）');
const loaderSrc = read('src/data/loader.ts');
const wallSrc = read('src/components/DigestWall.astro');
const subPageSrc = read('src/pages/subscribe.astro');
ok('loader 从 digest.mjs 引入 buyableFamilies（不另写一份）', /import\s*\{[^}]*buyableFamilies[^}]*\}\s*from\s*'\.\.\/\.\.\/scripts\/digest\.mjs'/.test(loaderSrc));
ok('loader 不再自己拼额度文案', !/amount:\s*p\.limit/.test(loaderSrc));
ok('订阅页把 buyable 传给日报墙（两个指数各一处）', (subPageSrc.match(/buyable:\s*(ndx|sp)Buy\.get/g) || []).length === 2);
ok('日报墙渲染清单', wallSrc.includes('dw-buy-row') && wallSrc.includes('seg.buyable'));
ok('日报墙的清单按币种分组（人民币在前）', /\[\s*\{\s*key:\s*'CNY'[\s\S]{0,120}key:\s*'USD'/.test(wallSrc));

console.log('');
if (fails.length) {
  console.error(`✗ ${fails.length} 项失败：`);
  for (const f of fails) console.error(`   - ${f}`);
  process.exit(1);
}
console.log(`✓ 发信口径门禁通过：${pass} 项断言全绿`);
