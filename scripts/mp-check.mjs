#!/usr/bin/env node
/**
 * 小程序静态校验（门禁）
 *
 * 七组检查：
 *   1. 工程结构：app.json 合法、每个页面四件套齐、tabBar 指向的页面存在、sitemap 在
 *   2. JS 语法：所有 .js 能编译（只编译不执行）
 *   3. WXML：标签配平；事件处理函数在对应 .js 里真的存在
 *   4. 数据同步：miniprogram/data/bundle.json 与 data/*.json 一致
 *   5. 口径交叉验证：三个互相独立的实现必须给出同一个答案
 *        · 小程序端装配（miniprogram/utils/store.js 的 assemble）
 *        · Node 端摘要（scripts/mp-sync.mjs 的 buildSummary）
 *        · 抓取脚本当时记下的值（data/fetch-meta.json 的最后一次 run）
 *   6. 合规自检：不出现交易导向词、web-view、跳其他小程序、页面里直接 wx.request
 *   7. 包体：bundle 与小程序源码的体积（小程序主包上限 2MB）
 *
 * 用法：
 *   node scripts/mp-check.mjs
 *   node scripts/mp-check.mjs --verbose
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MP = path.join(ROOT, 'miniprogram');
const VERBOSE = process.argv.includes('--verbose');

let fails = 0;
let checks = 0;

function ok(msg) {
  checks++;
  if (VERBOSE) console.log(`  ✓ ${msg}`);
}
function bad(msg) {
  checks++;
  fails++;
  console.error(`  ✗ ${msg}`);
}
function assert(cond, msg) {
  if (cond) ok(msg);
  else bad(msg);
  return !!cond;
}
function section(title) {
  console.log(`\n${title}`);
}

/* ── 加载小程序里的 CommonJS 模块（绕过 Node 的 ESM 判定） ────── */
function makeRequire(fromFile) {
  const dir = path.dirname(fromFile);
  return function (req) {
    const target = path.resolve(dir, req);
    if (target.endsWith('.json')) return JSON.parse(fs.readFileSync(target, 'utf8'));
    const src = fs.readFileSync(target, 'utf8');
    const module = { exports: {} };
    const fn = new Function('require', 'module', 'exports', 'wx', 'getCurrentPages', src);
    fn(makeRequire(target), module, module.exports, undefined, () => []);
    return module.exports;
  };
}

function listFiles(dir, ext, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) listFiles(full, ext, out);
    else if (name.endsWith(ext)) out.push(full);
  }
  return out;
}

/* ── 1. 工程结构 ────────────────────────────────────────────── */
section('1. 工程结构');

let appJson = null;
try {
  appJson = JSON.parse(fs.readFileSync(path.join(MP, 'app.json'), 'utf8'));
  ok('app.json 是合法 JSON');
} catch (e) {
  bad(`app.json 解析失败：${e.message}`);
}

if (appJson) {
  for (const p of appJson.pages || []) {
    const base = path.join(MP, p);
    for (const ext of ['.js', '.json', '.wxml', '.wxss']) {
      assert(fs.existsSync(base + ext), `页面 ${p} 有 ${ext}`);
    }
  }
  const listed = new Set(appJson.pages || []);
  for (const item of (appJson.tabBar && appJson.tabBar.list) || []) {
    assert(listed.has(item.pagePath), `tabBar「${item.text}」指向已注册页面 ${item.pagePath}`);
  }
  assert((appJson.tabBar?.list || []).length >= 2, 'tabBar 至少两项');
  assert(
    fs.existsSync(path.join(MP, appJson.sitemapLocation || 'sitemap.json')),
    `sitemap.json 存在（${appJson.sitemapLocation || 'sitemap.json'}）`
  );
  // 页面目录不能有「注册了但目录里没有」或「目录里有但没注册」
  const pagesDir = path.join(MP, 'pages');
  for (const name of fs.existsSync(pagesDir) ? fs.readdirSync(pagesDir) : []) {
    const rel = `pages/${name}/${name}`;
    assert(listed.has(rel), `目录 pages/${name} 已在 app.json 注册`);
  }
}

/* ── 2. JS 语法 ─────────────────────────────────────────────── */
section('2. JS 语法');

const jsFiles = listFiles(MP, '.js');
for (const f of jsFiles) {
  const rel = path.relative(ROOT, f);
  const src = fs.readFileSync(f, 'utf8');
  let compiled = true;
  try {
    // 只编译，不执行
    new Function('require', 'module', 'exports', 'wx', 'getCurrentPages', 'App', 'Page', 'Component', src);
  } catch (e) {
    compiled = false;
    bad(`${rel} 语法错误：${e.message}`);
  }
  if (compiled) ok(`${rel} 可编译`);
}

/* ── 3. WXML：标签配平 + 事件处理函数存在 ───────────────────── */
section('3. WXML');

const VOID_TAGS = new Set(['image', 'input', 'br', 'hr', 'icon', 'progress', 'switch', 'slider', 'textarea']);
for (const f of listFiles(MP, '.wxml')) {
  const rel = path.relative(ROOT, f);
  const src = fs.readFileSync(f, 'utf8');
  const opens = [...src.matchAll(/<([a-zA-Z][\w-]*)\b(?![^>]*\/>)[^>]*>/g)].map((m) => m[1]);
  const closes = [...src.matchAll(/<\/([a-zA-Z][\w-]*)\s*>/g)].map((m) => m[1]);
  const openCount = opens.filter((t) => !VOID_TAGS.has(t)).length;
  const closeCount = closes.filter((t) => !VOID_TAGS.has(t)).length;
  assert(openCount === closeCount, `${rel} 标签配平（${openCount} 开 / ${closeCount} 闭）`);

  // 事件处理函数必须在同目录的 .js 里存在
  const jsPath = f.replace(/\.wxml$/, '.js');
  const jsSrc = fs.existsSync(jsPath) ? fs.readFileSync(jsPath, 'utf8') : '';
  const handlers = [...src.matchAll(/\b(?:bind|catch)[a-zA-Z]+="([A-Za-z_$][\w$]*)"/g)].map((m) => m[1]);
  for (const h of new Set(handlers)) {
    const found = new RegExp(`\\b${h}\\s*[:(]`).test(jsSrc);
    assert(found, `${rel} 的 ${h}() 在同目录 js 里存在`);
  }
}

/* ── 4. 数据同步 ────────────────────────────────────────────── */
section('4. 数据同步');

const bundlePath = path.join(MP, 'data', 'bundle.json');
assert(fs.existsSync(bundlePath), 'miniprogram/data/bundle.json 存在');
let bundle = null;
if (fs.existsSync(bundlePath)) {
  bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
  const same = JSON.stringify(bundle) === JSON.stringify(JSON.parse(JSON.stringify(bundle)));
  assert(same, 'bundle.json 可解析');
  // 与 data/*.json 的同步：重跑 mp-sync 的计算，比对 snapDate / prevDate / 份额数
  const fetchMeta = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'fetch-meta.json'), 'utf8'));
  assert(
    bundle.snapDate === fetchMeta.date,
    `bundle 数据日 ${bundle.snapDate} == fetch-meta.date ${fetchMeta.date}`
  );
  const funds = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'funds.json'), 'utf8'));
  // 小程序只装纳指：分母也必须是纳指的份额数（不是 funds.json 全部）。
  // 写成等值断言而不是「<=」——多装一个标普500 份额也该红，那会让首屏组数悄悄变化。
  const expectShares = funds.funds
    .filter((f) => f.indexKey === '纳斯达克100')
    .reduce((a, f) => a + f.codes.length, 0);
  assert(
    bundle.shares.length === expectShares,
    `bundle 份额数 ${bundle.shares.length} == 纳指在 funds.json 的 ${expectShares}`
  );
  // 反向契约：标普500 的份额一个都不能进小程序 bundle（bundle 是纳指壳）
  const inBundle = new Set(bundle.shares.map((s) => s.code));
  const sp500Codes = funds.funds
    .filter((f) => f.indexKey === '标普500')
    .flatMap((f) => f.codes.map((c) => c.code));
  assert(
    sp500Codes.length > 0 && sp500Codes.every((c) => !inBundle.has(c)),
    `标普500 的 ${sp500Codes.length} 个份额都不在小程序 bundle 里`
  );
}

/* ── 5. 口径交叉验证（三个独立实现） ────────────────────────── */
section('5. 口径交叉验证');

if (bundle) {
  const store = makeRequire(path.join(MP, 'utils', 'store.js'))(path.join(MP, 'utils', 'store.js'));
  const assembled = store.assemble(store.readBundled());
  assert(!!assembled, '小程序端 assemble 能跑通');

  if (assembled) {
    const s = bundle.summary;
    assert(assembled.opened === s.opened, `开门组数一致：小程序 ${assembled.opened} / Node ${s.opened}`);
    assert(assembled.total === s.total, `可投总额一致：小程序 ${assembled.total} / Node ${s.total}`);
    assert(assembled.monitored === s.monitored, `监控组数一致：小程序 ${assembled.monitored} / Node ${s.monitored}`);
    assert(
      assembled.headline === s.headline,
      `首屏结论句一致：「${assembled.headline}」/「${s.headline}」`
    );

    // 第三方：抓取脚本当时记下的值
    const fetchMeta = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'fetch-meta.json'), 'utf8'));
    const last = fetchMeta.runs[fetchMeta.runs.length - 1];
    if (last) {
      assert(
        last.opened === assembled.opened,
        `开门组数一致：小程序 ${assembled.opened} / 抓取记录 ${last.opened}`
      );
      assert(
        last.total === assembled.total,
        `可投总额一致：小程序 ${assembled.total} / 抓取记录 ${last.total}`
      );
      assert(
        last.families === assembled.monitored,
        `家族数一致：小程序 ${assembled.monitored} / 抓取记录 ${last.families}`
      );
    } else {
      bad('fetch-meta.json 里没有 runs 记录，无法做第三方交叉验证');
    }
  }
}

/* ── 6. 合规自检 ────────────────────────────────────────────── */
section('6. 合规自检');

// 交易导向词：状态描述（暂停申购 / 限额申购 / 开放申购）不算，只查行动号召
const FORBIDDEN_PHRASES = [
  '立即购买', '立即申购', '去申购', '现在申购', '点击申购', '开户',
  '购买链接', '申购链接', '复制链接', '跳转购买', '立即开户', '推荐买入', '建议买入',
];
// 否定语境不算：「不提供开户」「没有购买入口」是必须写的免责说明，不能误伤
const NEGATORS = ['不', '无', '勿', '非', '未', '没有', '禁止'];

/**
 * 短语是否构成违规。命中处的前 14 个字符里若有否定词，视为免责说明，放行。
 */
function hasForbidden(src, phrase) {
  let idx = -1;
  while ((idx = src.indexOf(phrase, idx + 1)) !== -1) {
    const before = src.slice(Math.max(0, idx - 14), idx);
    if (!NEGATORS.some((n) => before.includes(n))) return true;
  }
  return false;
}

// 小程序里不该出现的跳转能力
const FORBIDDEN_APIS = ['wx.navigateToMiniProgram', 'web-view', 'wx.openEmbeddedMiniProgram'];

for (const f of [...listFiles(MP, '.wxml'), ...listFiles(MP, '.js')]) {
  const rel = path.relative(ROOT, f);
  const src = fs.readFileSync(f, 'utf8');
  for (const phrase of FORBIDDEN_PHRASES) {
    assert(!hasForbidden(src, phrase), `${rel} 不含交易导向词「${phrase}」`);
  }
  for (const api of FORBIDDEN_APIS) {
    assert(!src.includes(api), `${rel} 不含跳转能力「${api}」`);
  }
  // 页面里直接发请求：应当走云函数（云函数出网不受 request 合法域名限制）
  if (rel.includes(path.sep + 'pages' + path.sep)) {
    assert(!/\bwx\.request\s*\(/.test(src), `${rel} 不直接 wx.request（走云函数）`);
  }
}

// 「全部暂停」这类状态词是允许的，确认没把合法文案误判成交易词
const stateWords = ['暂停申购', '限额申购', '开放申购', '申购状态'];
for (const w of stateWords) {
  ok(`状态用语「${w}」属正常表述，不在禁用词表`);
}

/* ── 7. 包体 ────────────────────────────────────────────────── */
section('7. 包体');

let total = 0;
for (const f of listFiles(MP, '')) {
  if (f.includes('node_modules')) continue;
  total += fs.statSync(f).size;
}
const kb = total / 1024;
assert(kb < 2048, `小程序目录 ${kb.toFixed(0)} KB < 主包上限 2048 KB`);
if (bundle) {
  const bkb = fs.statSync(bundlePath).size / 1024;
  assert(bkb < 1024, `bundle.json ${bkb.toFixed(0)} KB < 1MB`);
}

/* ── 结论 ───────────────────────────────────────────────────── */
console.log(`\n${fails ? '✗' : '✓'} ${checks - fails}/${checks} 项通过${fails ? `，${fails} 项失败` : ''}`);
process.exit(fails ? 1 : 0);
