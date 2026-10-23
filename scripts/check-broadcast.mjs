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

console.log('');
if (fails.length) {
  console.error(`✗ ${fails.length} 项失败：`);
  for (const f of fails) console.error(`   - ${f}`);
  process.exit(1);
}
console.log(`✓ 发信口径门禁通过：${pass} 项断言全绿`);
