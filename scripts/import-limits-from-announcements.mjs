#!/usr/bin/env node
// 历史额度回填（公告版）：对**源站没有收录**的份额，从基金公司「调整大额申购」公告的
// 正文里取「代销渠道单日限额」，按生效日展开成逐日额度，补进 data/history.json。
//
// 为什么需要它：import-history.mjs 只能从同套代码的另一个站抓（那几个站有各份额的
// 「历史快照」表）。大成标普500等权重 4 个份额源站不收录（/f/096001 实测 404），
// 只能靠本站逐日累积 —— 也就是热力图上它永远是「1 个格子」。而基金公司其实把每天的
// 限额写在公告里：一条「调整大额申购」公告 = 一段区间的固定额度，展开就是逐日数据。
//
// ── 数据源（都是免密钥的公开接口）──
// 公告列表  https://api.fund.eastmoney.com/f10/JJGG?fundcode=<code>&pageIndex=N&pageSize=50&type=0
//           ★ 必须带 Referer: https://fundf10.eastmoney.com/ ，否则 403。
// 公告正文  https://np-cnotice-stock.eastmoney.com/api/content/ann?art_code=<ID>&client_source=web&page_index=1
//           → data.notice_content 是纯文本全文；data.eitime 精确到秒；data.security[] 列出同一只
//           基金的全部份额代码（四份额共用一批公告，按主代码查即可）。
//           ★ fund.eastmoney.com/gonggao/<code>,<ID>.html 这个页面正文是**空的**（JS 渲染），
//           别爬它 —— 「公告正文拿不到」这个误判就是这么来的。
//
// ── 三条硬约束（写错了不会抛异常，只会在页面上安静地显示错的额度）──
// 1. 生效日取正文里的「调整大额申购起始日」，**不取 PUBLISHDATE**。
//    2026-10-15 发的公告写「自 2026 年 10 月 16 日起」，用发布日会让整条时间线错一天。
// 2. 只取「**通过各代销机构**申购…不超过 X 元」那一句。我们页面展示的是东财详情页口径
//    ＝代销。2026 年起公告分直销/代销两档（10-16 起代销 50 / 直销 500），取错档会差 10 倍。
//    ★ 某币种**没有代销段落**（或表内代销栏是「-」）→ 判 STOPPED，绝不写成可买：
//      美元份额经代销根本买不到，公告里只给了直销 75 美元。这条与「限大额但没金额 → STOPPED」
//      的既有口径一致（2026-10-20 定），否则热力图上会亮一格假绿。
// 3. **回填出来的最后一个交易日必须等于当前实抓值**，不等就整体不写。
//    公告只到昨天、今天的实测是本站自己抓的，两者对不上说明解析或口径变了（也可能是新公告
//    还没收录），此时宁可中止，也不能用公告覆盖今天的实测。
//
// 另外：起始日从「本指数其余份额已有的历史」推，保证与它们对齐（不自己造日历）。
//
// 用法：
//   node scripts/import-limits-from-announcements.mjs --dry-run   # 只看不写（默认也可以先跑它）
//   node scripts/import-limits-from-announcements.mjs             # 写入
//   node scripts/import-limits-from-announcements.mjs --start=2026-09-16   # 指定对齐起点
//   node scripts/import-limits-from-announcements.mjs --force     # 末点不一致也写（仅限人工确认后）
//
// 依赖：仅 Node 22 内置（fetch / fs），不需要 npm 包。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');

// ── 回填目标 ──
// 每项 = 一只基金的「主代码 + 全部份额」。公告按主代码查，份额代码各自展开。
// 加新目标时只需照抄一份，脚本会自动：① 找到同指数其余份额的历史做对齐基准；
// ② 按 funds.json 里的币种挑选正文段落。
const TARGETS = [
  {
    indexKey: '标普500',
    label: '大成标普500等权重',
    mainCode: '096001',
    codes: ['096001', '008401', '013404', '015545'],
  },
];

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const FETCH_TIMEOUT = 20000;
const MAX_ATTEMPTS = 6;
const BASE_DELAY = 600;
const REQUEST_GAP = 350; // 礼貌限速
const MAX_PAGES = 8;
const LOOKBACK_DAYS = 60; // 从起始日再往前翻多久的公告（公告可能提前几十天发）

// ── 参数 ──
const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const FORCE = argv.includes('--force');
const START_ARG = (argv.find((a) => a.startsWith('--start=')) || '').split('=')[1] || null;
const KEEP = Number((argv.find((a) => a.startsWith('--keep=')) || '--keep=60').split('=')[1]);

if (START_ARG && !/^\d{4}-\d{2}-\d{2}$/.test(START_ARG)) {
  console.error(`✗ --start 需要 YYYY-MM-DD，收到 ${START_ARG}`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(name, obj) {
  const tmp = path.join(DATA_DIR, name + '.tmp');
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, path.join(DATA_DIR, name));
}

// ── 日期（一律走 Date.UTC + 纯字符串，避免 UTC 构建机上差一天）──
function toUTC(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}
function fromUTC(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
function shiftDays(iso, delta) {
  return fromUTC(toUTC(iso) + delta * 86400000);
}

// ── 抓取 ──
async function fetchJson(url, referer) {
  let last;
  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT);
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json', ...(referer ? { Referer: referer } : {}) },
        signal: ctl.signal,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      last = e;
      await sleep(BASE_DELAY * 2 ** (i - 1) + Math.random() * 300);
    } finally {
      clearTimeout(timer);
    }
  }
  throw last;
}

// 翻页拉公告列表，直到翻过 floor（起始日往前 LOOKBACK 天）或没有更多
async function listAnnouncements(code, floor) {
  const out = [];
  for (let p = 1; p <= MAX_PAGES; p++) {
    const j = await fetchJson(
      `https://api.fund.eastmoney.com/f10/JJGG?fundcode=${code}&pageIndex=${p}&pageSize=50&type=0`,
      'https://fundf10.eastmoney.com/'
    );
    const rows = j?.Data || [];
    out.push(...rows);
    const oldest = rows.length ? rows[rows.length - 1].PUBLISHDATEDesc : null;
    if (rows.length < 50 || (oldest && oldest < floor)) break;
    await sleep(REQUEST_GAP);
  }
  return out;
}

async function getContent(id) {
  const j = await fetchJson(
    `https://np-cnotice-stock.eastmoney.com/api/content/ann?art_code=${id}&client_source=web&page_index=1`,
    'https://data.eastmoney.com/'
  );
  return j?.data || {};
}

// ── 解析 ──
// 正文里为了排版会插入大量换行与全角空格（「公\n 告」这种词都被拆开），统一压成单空格
function normalize(s) {
  return String(s || '')
    .replace(/[\u3000\u00a0]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// 标题 → 公告类型。只认「申购额度/状态」类；公司层面、渠道、诈骗提醒一律丢。
function kindOf(title) {
  const t = normalize(title);
  if (!t) return null;
  if (/直销|境外|节假日|费率|销售服务费|招募说明书|托管|审计|基金经理|分红|净值|谨防|第三方互联网平台|终止|增加|代销机构名单/.test(t))
    return null;
  if (/调整.{0,40}(大额申购|限制金额|金额限制)|限制大额申购|暂停大额申购|限制申购金额/.test(t)) return 'limit';
  if (/暂停.{0,40}申购/.test(t)) return 'suspend';
  if (/恢复.{0,40}申购|开放.{0,40}申购/.test(t)) return 'open';
  return null;
}

const AMT_RE = '([\\d,]+(?:\\.\\d+)?)\\s*(万|千)?\\s*元';
function num(s, unit) {
  const v = Number(String(s).replace(/,/g, ''));
  if (!Number.isFinite(v)) return null;
  if (unit === '万') return v * 10000;
  if (unit === '千') return v * 1000;
  return v;
}

// 「…日**起**」里的日期。★ 不能取「句子里第一个日期」：公告正文的表格段落常常没有句号，
// 第一句能从标题一路连到「1、对于人民币份额，2026 年 10 月 16 日起…」，句首那个日期是
// 「公告送出日期」（＝发布日），取第一个就正好踩中约束 1 要避免的坑。日期必须锚在「起」上。
function dateBeforeQi(s) {
  const m = String(s).match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*起/);
  return m ? `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}` : null;
}

// 表格里的「调整大额申购起始日」——排版把标签拆成「调整大额申购起 … 始日」，
// 日期夹在中间，所以正则只锚前半截，允许中间出现日期。
// 没有「起」字排版的版本（「调整大额申购起始日 2026 年 10 月 16 日」）另给一条。
// ★ 绝不退回到「正文里第一个日期」：那个位置通常是「公告送出日期」，用它就等于用了发布日。
function startDateFromTable(c) {
  const m =
    c.match(/调整大额申购起\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/) ||
    c.match(/调整大额申购起始日\s*[:：]?\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/) ||
    c.match(/调整限制(?:申购)?金额起始日\s*[:：]?\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  return null;
}

/**
 * 从公告正文里抽出「各币种 · 代销渠道」的生效日与限额。
 * 返回 { start, bodyDate, agent: { CNY: 100, USD: null }, direct: { CNY: 1000, USD: 150 } }
 *
 * 只认「各代销机构」那一句（约束 2）；美元份额若没有这一句，agent.USD = null，
 * 由调用方判成 STOPPED。
 * start 来自表格的「调整大额申购起始日」，bodyDate 来自正文「对于…份额，X 日起，通过各代销机构…」，
 * 两个来源互相校验——只信一个的话，排版一变就会悄悄差一天。
 */
function parseAnnouncement(content) {
  const c = normalize(content);
  const start = startDateFromTable(c);
  const agent = { CNY: null, USD: null };
  const direct = { CNY: null, USD: null };
  let bodyDate = null;

  // 按句号/分号切句：一句 = 一个币种 + 一个渠道 + 一个日期 + 一个金额
  for (const raw of c.split(/[。；]/)) {
    const s = raw.trim();
    if (!s) continue;
    const cur = /美元份额/.test(s) ? 'USD' : /人民币份额/.test(s) ? 'CNY' : null;
    if (!cur) continue;
    if (/日起/.test(s) && !bodyDate) bodyDate = dateBeforeQi(s);
    const m = s.match(new RegExp('不超过\\s*' + AMT_RE));
    const amt = m ? num(m[1], m[2]) : null;
    if (/各代销机构|代销渠道/.test(s)) {
      if (agent[cur] == null) agent[cur] = amt;
    } else if (/直销渠道|直销柜台|本公司直销/.test(s)) {
      if (direct[cur] == null) direct[cur] = amt;
    }
  }

  return { start, bodyDate, agent, direct };
}

// ── 主流程 ──
function codeCurrencyMap(funds) {
  const m = new Map();
  for (const f of funds) for (const c of f.codes || []) m.set(c.code, f.currency || null);
  return m;
}

async function runTarget(target, funds, history, currencyOf) {
  const out = {
    target,
    announcements: [],
    timeline: [], // { date, kind, agent: {CNY,USD}, id, published }
    skipped: [],
    report: [],
    conflicts: [],
    gateFailures: [],
    errors: [],
  };

  // ── 对齐基准：同指数里**不在本目标内**的份额已有的日期 ──
  const siblings = [];
  for (const f of funds) {
    if (f.indexKey !== target.indexKey) continue;
    for (const c of f.codes || []) if (!target.codes.includes(c.code)) siblings.push(c.code);
  }
  const dateSet = new Set();
  for (const code of siblings) for (const p of history[code] || []) dateSet.add(p.date);
  const alignDates = [...dateSet].sort();
  if (!alignDates.length) {
    out.errors.push(`找不到对齐基准：${target.indexKey} 其余份额（${siblings.join('/')}）没有任何历史`);
    return out;
  }

  const startDate = START_ARG || alignDates[0];
  if (START_ARG && START_ARG > alignDates[alignDates.length - 1]) {
    out.errors.push(`--start=${START_ARG} 晚于对齐基准的最后一个交易日 ${alignDates[alignDates.length - 1]}`);
    return out;
  }
  // 目标日期 = 对齐基准里 >= startDate 的那些（不自己造日历，跟别人用同一套交易日）
  const targetDates = alignDates.filter((d) => d >= startDate);
  out.align = { siblings: siblings.length, from: targetDates[0], to: targetDates[targetDates.length - 1], days: targetDates.length };

  // ── 拉公告 ──
  const floor = shiftDays(startDate, -LOOKBACK_DAYS);
  const list = await listAnnouncements(target.mainCode, floor);
  out.listCount = list.length;

  for (const a of list) {
    const published = a.PUBLISHDATEDesc || '';
    if (published && published < floor) continue;
    const kind = kindOf(a.TITLE);
    if (!kind) continue;

    let data;
    try {
      data = await getContent(a.ID);
      await sleep(REQUEST_GAP);
    } catch (e) {
      out.errors.push(`公告 ${a.ID}（${published}）正文抓取失败：${e?.message || e}`);
      continue;
    }

    // 公司层面的公告（如「旗下部分基金…」）不含本基金份额代码 → 跳过
    const secCodes = (data.security || []).map((s) => String(s.stock || '')).filter(Boolean);
    if (secCodes.length && !secCodes.some((c) => target.codes.includes(c))) {
      out.skipped.push(`${published} ${a.ID} 不含本基金份额代码`);
      continue;
    }

    const parsed = parseAnnouncement(data.notice_content || '');
    // 约束 1：生效日只能来自「生效日/起始日」这两处结构化的表述，两条都没有就报错，
    // 绝不退回「正文里第一个日期」（那是公告送出日期＝发布日）。
    const start = parsed.start || parsed.bodyDate;
    if (!start) {
      out.errors.push(`公告 ${a.ID}（${published}）找不到生效日（约束 1：不许退回用发布日）`);
      continue;
    }
    if (parsed.start && parsed.bodyDate && parsed.start !== parsed.bodyDate) {
      out.errors.push(
        `公告 ${a.ID} 表格起始日 ${parsed.start} 与正文「对于…份额…起」${parsed.bodyDate} 不一致，拒绝挑一个用`
      );
      continue;
    }
    // 生效日早于发布日是反常识的（公告不会倒签），出现即视为解析错位
    if (published && start < published) {
      out.errors.push(`公告 ${a.ID} 生效日 ${start} 早于发布日 ${published}，疑似解析错位`);
      continue;
    }

    out.announcements.push({ id: a.ID, published, start, kind, agent: parsed.agent, direct: parsed.direct });
  }

  // 只保留落在回填区间附近的公告（生效日 <= 最后一个目标日）
  const lastTarget = targetDates[targetDates.length - 1];
  const timeline = out.announcements
    .filter((a) => a.start <= lastTarget)
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  out.timeline = timeline;

  if (!timeline.length) {
    out.errors.push('没有可用的额度公告');
    return out;
  }
  // 约束 1 的另一半：第一条公告必须在起始日之前（或当天）生效，否则起点状态未知
  if (timeline[0].start > startDate) {
    out.errors.push(
      `最早一条额度公告生效于 ${timeline[0].start}，晚于回填起点 ${startDate} —— 起点那几天状态未知，拒绝猜测`
    );
    return out;
  }

  // ── 每条公告 → 每个份额的状态/额度 ──
  const pointAt = (ann, code) => {
    const cur = currencyOf.get(code);
    if (!cur) return { status: 'UNKNOWN', limit: null, why: 'funds.json 查不到币种' };
    if (ann.kind === 'suspend') return { status: 'STOPPED', limit: null, why: '暂停申购公告' };
    if (ann.kind === 'open') return { status: 'OPEN', limit: null, why: '恢复/开放申购公告' };
    const amt = ann.agent[cur];
    if (amt == null) return { status: 'STOPPED', limit: null, why: `${cur} 无代销档（不写成可买）` };
    return { status: 'LIMITED', limit: amt, why: `${cur} 代销 ${amt}` };
  };
  const stateOn = (code, date) => {
    let hit = null;
    for (const a of timeline) {
      if (a.start <= date) hit = a;
      else break;
    }
    return hit ? pointAt(hit, code) : null;
  };

  // ── 约束 3：末点必须等于当前实抓 ──
  for (const code of target.codes) {
    const local = history[code] || [];
    if (!local.length) {
      out.gateFailures.push(`${code} 本地没有任何实测点，无法校验末点（先跑一次 scrape）`);
      continue;
    }
    const real = local[local.length - 1];
    const implied = stateOn(code, real.date);
    if (!implied) {
      out.gateFailures.push(`${code} ${real.date} 公告推算为空`);
      continue;
    }
    const same = real.status === implied.status && (real.limit ?? null) === (implied.limit ?? null);
    out.report.push({
      code,
      gate: { date: real.date, real: `${real.status}/${real.limit ?? '—'}`, implied: `${implied.status}/${implied.limit ?? '—'}`, same },
    });
    if (!same) {
      out.gateFailures.push(
        `${code} ${real.date} 实抓 ${real.status}/${real.limit ?? '—'} ≠ 公告推算 ${implied.status}/${implied.limit ?? '—'}`
      );
    }
  }
  if (out.gateFailures.length) return out;

  // ── 合并：只填空格子；已有本地点一个不动（那天是本站亲眼看到的）──
  const segs = new Map();
  for (const code of target.codes) {
    const local = history[code] || [];
    const byDate = new Map(local.map((p) => [p.date, { ...p }]));
    let added = 0;
    let same = 0;
    for (const d of targetDates) {
      const implied = stateOn(code, d);
      if (!implied) continue;
      const cur = byDate.get(d);
      if (!cur) {
        byDate.set(d, { date: d, status: implied.status, limit: implied.limit });
        added++;
        continue;
      }
      if (cur.status === implied.status && (cur.limit ?? null) === (implied.limit ?? null)) {
        same++;
        continue;
      }
      out.conflicts.push({
        code,
        date: d,
        local: `${cur.status}/${cur.limit ?? '—'}`,
        ann: `${implied.status}/${implied.limit ?? '—'}`,
        kept: 'local',
      });
    }
    const merged = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    history[code] = merged.slice(-KEEP);
    out.report.find((r) => r.code === code).added = added;
    out.report.find((r) => r.code === code).same = same;
    out.report.find((r) => r.code === code).total = history[code].length;

    // 对齐自检：写完后本份额的日期集合必须覆盖 targetDates
    const have = new Set(history[code].map((p) => p.date));
    const missing = targetDates.filter((d) => !have.has(d));
    if (missing.length) {
      out.errors.push(`${code} 仍缺 ${missing.length} 个交易日：${missing.join(' ')}`);
    }

    // 段落摘要（同一段连续相同取值合并成一行）
    const keys = [];
    for (const d of targetDates) {
      const s = stateOn(code, d);
      if (!s) continue;
      const txt = `${s.status}/${s.limit ?? '—'}`;
      const last = keys[keys.length - 1];
      if (last && last.txt === txt) last.to = d;
      else keys.push({ from: d, to: d, txt });
    }
    for (const k of keys) segs.set(code, [...(segs.get(code) || []), k]);
  }
  out.segments = segs;
  return out;
}

async function main() {
  const funds = readJson('funds.json', { funds: [] }).funds;
  const history = readJson('history.json', {});
  if (!funds || !funds.length) {
    console.error('✗ funds.json 为空或解析失败，拒绝回填。');
    process.exit(3);
  }
  const currencyOf = codeCurrencyMap(funds);

  const beforePts = Object.values(history).reduce((a, arr) => a + (arr?.length || 0), 0);
  const results = [];
  for (const t of TARGETS) {
    console.log(`\n════ ${t.indexKey} · ${t.label}（${t.codes.join('/')}）════`);
    const r = await runTarget(t, funds, history, currencyOf);
    results.push(r);

    if (r.align) {
      console.log(
        `对齐基准：本指数其余 ${r.align.siblings} 只份额，${r.align.from} → ${r.align.to} 共 ${r.align.days} 个交易日`
      );
    }
    console.log(`公告列表 ${r.listCount ?? 0} 条 → 本基金额度公告 ${r.announcements.length} 条`);
    for (const a of r.announcements) {
      const cny = a.agent.CNY == null ? '—' : `${a.agent.CNY}`;
      const usd = a.agent.USD == null ? '—' : `${a.agent.USD}`;
      console.log(
        `  · 生效 ${a.start}（发布 ${a.published}）${a.kind} · 代销 人民币 ${cny} / 美元 ${usd}` +
          `（直销 ${a.direct.CNY ?? '—'} / ${a.direct.USD ?? '—'}）  [${a.id}]`
      );
    }
    if (r.skipped.length) console.log(`  … 跳过 ${r.skipped.length} 条与本基金无关的公告`);

    if (r.segments) {
      console.log('展开成逐日：');
      for (const [code, segs] of r.segments) {
        console.log(`  ${code} ${(currencyOf.get(code) || '?').padEnd(3)} ` + segs.map((s) => `${s.from}→${s.to} ${s.txt}`).join(' · '));
      }
    }
    if (r.report.length) {
      console.log('末点校验（约束 3）：');
      for (const x of r.report) {
        console.log(`  ${x.code} ${x.gate.date} 实抓 ${x.gate.real} / 公告 ${x.gate.implied} ${x.gate.same ? '✓' : '✗'}`);
      }
    }
    if (r.errors.length) {
      console.error('✗ 错误：');
      for (const e of r.errors) console.error(`  ${e}`);
    }
    if (r.gateFailures.length) {
      console.error('✗ 末点校验未通过（拒绝写入）：');
      for (const e of r.gateFailures) console.error(`  ${e}`);
    }
    if (r.conflicts.length) {
      console.log(`⚠ 有 ${r.conflicts.length} 个已有本地点与公告不一致（保留本地实测）：`);
      for (const c of r.conflicts.slice(0, 10)) console.log(`  ${c.code} ${c.date} 本地 ${c.local} / 公告 ${c.ann} → 保留 ${c.kept}`);
    }
    if (r.report.length) {
      const add = r.report.reduce((a, x) => a + (x.added || 0), 0);
      console.log(`写入：新增 ${add} 个点`);
    }
  }

  const errors = results.flatMap((r) => r.errors || []);
  const gateFailures = results.flatMap((r) => r.gateFailures || []);
  const afterPts = Object.values(history).reduce((a, arr) => a + (arr?.length || 0), 0);

  if (errors.length) {
    console.error(`\n✗ 有 ${errors.length} 个解析错误，未写入。`);
    process.exit(4);
  }
  if (gateFailures.length && !FORCE) {
    console.error('\n✗ 末点校验未通过，未写入（确认口径无误可加 --force）。');
    process.exit(4);
  }

  if (DRY_RUN) {
    console.log('\n--dry-run：未写入任何文件。');
    return;
  }

  writeJsonAtomic('history.json', history);
  console.log(`\nhistory.json 记录点：${beforePts} → ${afterPts}`);
  console.log(`✓ 已写入 ${path.join(DATA_DIR, 'history.json')}`);
}

main().catch((e) => {
  console.error('✗ 回填异常：', e);
  process.exit(1);
});
