#!/usr/bin/env node
// 历史数据回填：把「同套代码的另一个站」各份额详情页「历史快照」表里的近 30 天
// 「申购状态 / 单日额度 / 净值」补齐进 data/history.json。
//
// 为什么需要它：scrape.mjs 只能从今天开始逐日累积，新站首次上线时 30 天柱状图
// 只有一两个柱子。回填是**一次性补历史**，之后仍由 scrape.mjs 每天追加。
//
// 来源站按指数分（每个 indexKey 一个源站，见 SOURCE_HOSTS）。两个站是同一套代码的
// 不同部署，所以页面结构一致、解析器共用；但**数据不能互串**，--index 决定抓哪个站、
// 写哪些份额。
//
// 合并策略（重要）：
//   - 只写 A 股交易日（沿用 digest.mjs 的 isTradingDay，周末/法定节假日一律丢弃，
//     源头那几天只是把上一个交易日的值重复了一遍）
//   - 同日冲突默认保留本地值（本地是当天亲自抓的，更可信），用 --prefer=remote 反转
//   - 单只基金抓取失败 → 跳过并保留其原有历史，绝不清空
//   - 解析成功数低于阈值（默认 80%）→ 不写文件，非零退出（与 scrape 的健康门禁同一套思路）
//   - 「限大额」但来源没给出金额 → 降级为 UNKNOWN，不采信为可买（见 parsePage 注释）
//
// 用法：
//   node scripts/import-history.mjs                     # 所有有源站的指数依次回填
//   node scripts/import-history.mjs --index=标普500     # 只回填一个指数
//   node scripts/import-history.mjs --dry-run           # 只report不写
//   node scripts/import-history.mjs 019736 012751       # 只补指定代码
//   node scripts/import-history.mjs --prefer=remote     # 冲突时以来源站为准
//   node scripts/import-history.mjs --keep=60           # 每只基金最多留多少个交易日（默认 60，与 scrape 一致）
//
// 依赖：仅 Node 22 内置（fetch / fs）+ 本地 digest.mjs，无需安装 npm 包。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isTradingDay } from './digest.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');

// 每个指数的历史来源站。同一套代码的两个部署，页面结构一致。
// 漏配某个指数 = 它不会被回填（脚本会明确提示，不静默跳过）。
const SOURCE_HOSTS = {
  纳斯达克100: 'nasdaq.jaelchen.cn',
  标普500: 'sp500.jaelchen.cn',
};

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const FETCH_TIMEOUT = 20000;
const MAX_ATTEMPTS = 4;
const BASE_DELAY = 500;
const REQUEST_GAP = 300; // 礼貌限速：约 3 请求/秒
const MIN_OK_RATIO = 0.8; // 解析成功率门禁

// ── 参数 ──
const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const FORCE = argv.includes('--force');
const PREFER = (argv.find((a) => a.startsWith('--prefer=')) || '--prefer=local').split('=')[1];
const KEEP = Number((argv.find((a) => a.startsWith('--keep=')) || '--keep=60').split('=')[1]);
const ONLY = argv.filter((a) => /^\d{6}$/.test(a));
const INDEX_ARG = (argv.find((a) => a.startsWith('--index=')) || '').split('=')[1] || null;

if (!['local', 'remote'].includes(PREFER)) {
  console.error(`✗ --prefer 只接受 local / remote，收到 ${PREFER}`);
  process.exit(1);
}
if (INDEX_ARG && !SOURCE_HOSTS[INDEX_ARG]) {
  console.error(`✗ --index 不认识 ${INDEX_ARG}，可选：${Object.keys(SOURCE_HOSTS).join(' / ')}`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const backoff = (attempt) => BASE_DELAY * 2 ** (attempt - 1) + Math.random() * 300;

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

const HOLIDAYS = new Set(readJson('market-holidays.json', []));

// ── 解析 ──
function stripTags(s) {
  return s
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

const STATUS_MAP = {
  限大额: 'LIMITED',
  暂停申购: 'STOPPED',
  封闭期: 'CLOSED',
  开放申购: 'OPEN',
  正常申购: 'OPEN',
  开放: 'OPEN',
};

const UNKNOWN_STATUS_TEXTS = new Set();

function mapStatus(text) {
  const s = STATUS_MAP[text];
  if (s) return s;
  if (!text || text === '—' || text === '-') return 'UNKNOWN';
  UNKNOWN_STATUS_TEXTS.add(text);
  return 'UNKNOWN';
}

/** 「10 元」→ 10；「1.2 万元」→ 12000；「限大额 / 未公布 / —」→ null（额度未公布，绝不臆造） */
function parseLimit(text) {
  if (!text) return null;
  const wan = text.match(/([\d,]+(?:\.\d+)?)\s*万\s*元/);
  if (wan) return Number(wan[1].replace(/,/g, '')) * 10000;
  const yuan = text.match(/([\d,]+(?:\.\d+)?)\s*元/);
  if (yuan) return Number(yuan[1].replace(/,/g, ''));
  return null; // 限大额 / 未公布 / — / 不限
}

function parseNav(text) {
  if (!text) return null;
  const m = text.match(/^-?\d+(?:\.\d+)?$/);
  return m ? Number(text) : null;
}

/** 从详情页取「历史快照」表。返回 { rows, currency, title }；表格不存在时 rows=null。 */
function parsePage(html) {
  const title = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [, ''])[1];
  const cur = (html.match(/<td class="code">币种<\/td><td class="num">([\s\S]*?)<\/td>/) || [, ''])[1];

  const at = html.indexOf('历史快照');
  if (at < 0) return { rows: null, currency: stripTags(cur) || null, title: stripTags(title) };

  const tbodyStart = html.indexOf('<tbody', at);
  const tbodyEnd = html.indexOf('</tbody>', tbodyStart);
  if (tbodyStart < 0 || tbodyEnd < 0) {
    return { rows: null, currency: stripTags(cur) || null, title: stripTags(title) };
  }

  const body = html.slice(tbodyStart, tbodyEnd);
  const rows = [];
  for (const tr of body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => stripTags(m[1]));
    if (cells.length < 4) continue;
    const [date, statusText, limitText, navText] = cells;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    let status = mapStatus(statusText);
    const limit = parseLimit(limitText);
    // 「限大额」但来源站没给出金额 → 判 STOPPED，绝不写成可买。两层理由：
    //  1) 项目在 2026-10-20 就定过这个口径：代销渠道未公布单日额度，本质就是当前不可买
    //     （docs/worklog/2026-10-20.md，当时把 history.json 里 106 条 LIMITED+null 改判 STOPPED）。
    //  2) 来源站把这类点标成「限大额」，是因为它只读东财「交易状态」字段；而东财对这类份额
    //     同时写着「该基金暂不开放购买」（022523 天弘D、017642/017643 摩根美元 A/C 实测都是），
    //     真能买的会给出上限金额（017641 写「限大额 (单日累计购买上限10.00元)」）。
    // 照搬来源站的「可买」会让热力图上亮出 3 只假绿——这正是回填最容易带进来的错。
    if (status === 'LIMITED' && limit == null) status = 'STOPPED';
    rows.push({
      date,
      status,
      statusText,
      limit,
      nav: parseNav(navText),
    });
  }
  return { rows, currency: stripTags(cur) || null, title: stripTags(title) };
}

async function fetchPage(host, code) {
  const url = `https://${host}/f/${code}`;
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
      });
      // 404 = 源站没收录这个份额（比如标普站不收大成等权重那 4 只）。
      // 这是「本来就没有」，不是「抓失败」：重试没意义，也不能计入成功率分母，
      // 否则每次跑都固定扣掉几个百分点，门禁阈值会被慢慢耗尽。
      if (res.status === 404) {
        const e = new Error('源站未收录');
        e.notCovered = true;
        throw e;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      if (html.length > 6 * 1024 * 1024) throw new Error('响应过大');
      return parsePage(html);
    } catch (e) {
      lastErr = e;
      if (e.notCovered) break;
      if (attempt < MAX_ATTEMPTS) await sleep(backoff(attempt));
    }
  }
  throw lastErr;
}

// ── 主流程 ──

/** 回填一个指数：只抓它自己的源站、只写它自己的份额。返回 null 表示没有可回填的目标。 */
async function runForIndex(indexKey, funds, history) {
  const host = SOURCE_HOSTS[indexKey];
  const shards = funds.filter((f) => f.indexKey === indexKey);
  const codeMeta = new Map(); // code → { currency, company, cls }
  for (const f of shards) {
    for (const c of f.codes) codeMeta.set(c.code, { currency: f.currency, company: f.company, cls: c.cls });
  }

  let targets = [...codeMeta.keys()];
  if (ONLY.length) targets = targets.filter((c) => ONLY.includes(c));
  if (!targets.length) return null;

  const out = {
    indexKey,
    host,
    targets,
    report: [],
    conflicts: [],
    protected: [],
    failures: [],
    notCovered: [],
    currencyMismatch: [],
  };

  for (const code of targets) {
    const meta = codeMeta.get(code) || {};
    let parsed;
    try {
      parsed = await fetchPage(host, code);
    } catch (e) {
      if (e?.notCovered) {
        out.notCovered.push(code);
      } else {
        out.failures.push({ code, reason: String(e?.message || e) });
        console.warn(`✗ ${code} 抓取失败: ${e?.message || e}`);
      }
      await sleep(REQUEST_GAP);
      continue;
    }

    if (!parsed.rows || parsed.rows.length === 0) {
      out.failures.push({ code, reason: '页面无历史快照表' });
      console.warn(`✗ ${code} 无历史快照（页面结构可能已变）`);
      await sleep(REQUEST_GAP);
      continue;
    }

    // 交叉校验币种：来源站写「美元」而 funds.json 写 CNY（或反之）说明代码配错了
    const siteCur = parsed.currency === '美元' ? 'USD' : parsed.currency === '人民币' ? 'CNY' : null;
    if (siteCur && meta.currency && siteCur !== meta.currency) {
      out.currencyMismatch.push({ code, site: siteCur, local: meta.currency });
      console.warn(`⚠ ${code} 币种不一致：来源 ${siteCur} / 本地 ${meta.currency}`);
    }

    const rows = parsed.rows.filter((r) => isTradingDay(r.date, HOLIDAYS));
    const local = history[code] || [];
    const byDate = new Map(local.map((p) => [p.date, { ...p }]));
    // 本地最新那一天永远是本站亲手抓的（scrape 只写当天），即使 --prefer=remote
    // 也不许被来源站改写——来源站只是同一天的另一份读数，不是更正。
    // 没有这条保护时，--prefer=remote 会把「今天确认暂停」改成来源站的「限大额」，
    // 等于用别人的口径覆盖自己的实测。
    const newestLocal = local.length ? local[local.length - 1].date : null;
    let added = 0;
    let updated = 0;
    let same = 0;

    for (const r of rows) {
      const point = { date: r.date, status: r.status, limit: r.limit, nav: r.nav };
      const cur = byDate.get(r.date);
      if (!cur) {
        byDate.set(r.date, point);
        added++;
        continue;
      }
      const differs = cur.status !== point.status || cur.limit !== point.limit;
      if (!differs) {
        same++;
        // 本地没有净值时顺手补上（净值不影响任何状态聚合）
        if (cur.nav == null && point.nav != null) byDate.set(r.date, { ...cur, nav: point.nav });
        continue;
      }
      const protectedNewest = r.date === newestLocal;
      out.conflicts.push({
        code,
        date: r.date,
        local: `${cur.status}/${cur.limit ?? '—'}`,
        remote: `${point.status}/${point.limit ?? '—'}`,
        kept: PREFER === 'remote' && !protectedNewest ? 'remote' : 'local',
      });
      if (protectedNewest) {
        out.protected.push({ code, date: r.date, local: `${cur.status}/${cur.limit ?? '—'}` });
        if (cur.nav == null && point.nav != null) byDate.set(r.date, { ...cur, nav: point.nav });
      } else if (PREFER === 'remote') {
        byDate.set(r.date, point);
        updated++;
      } else if (cur.nav == null && point.nav != null) {
        // 状态/额度冲突不影响净值：净值是独立事实，本地缺就补上
        byDate.set(r.date, { ...cur, nav: point.nav });
      }
    }

    const merged = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    history[code] = merged.slice(-KEEP);
    out.report.push({
      code,
      currency: meta.currency || '?',
      days: rows.length,
      added,
      updated,
      same,
      span: rows.length ? `${rows[rows.length - 1].date} → ${rows[0].date}` : '—',
      total: history[code].length,
    });
    await sleep(REQUEST_GAP);
  }

  // 成功率的分母要扣掉「源站本来就没收录」的份额
  const inScope = targets.length - out.notCovered.length;
  out.ratio = inScope > 0 ? out.report.length / inScope : 0;
  return out;
}

async function main() {
  const funds = readJson('funds.json', { funds: [] }).funds;
  const history = readJson('history.json', {});
  if (!funds.length) {
    console.error('✗ funds.json 为空或解析失败，拒绝回填。');
    process.exit(3);
  }

  const indexes = INDEX_ARG ? [INDEX_ARG] : Object.keys(SOURCE_HOSTS);
  const noSource = [...new Set(funds.map((f) => f.indexKey))].filter((k) => k && !SOURCE_HOSTS[k]);
  if (noSource.length && !INDEX_ARG) console.log(`… 无源站配置的指数（不回填）：${noSource.join(' / ')}`);

  const beforeDays = Object.values(history).reduce((a, arr) => a + (arr?.length || 0), 0);
  const runs = [];
  for (const idx of indexes) {
    console.log(`\n════ ${idx} ← ${SOURCE_HOSTS[idx]} ════`);
    const r = await runForIndex(idx, funds, history);
    if (!r) {
      console.log('… 该指数没有可回填的份额，跳过');
      continue;
    }
    runs.push(r);
  }
  if (!runs.length) {
    console.error('✗ 没有任何指数被回填（检查 --index 与 funds.json 的 indexKey 是否对得上）。');
    process.exit(3);
  }

  const conflicts = runs.flatMap((r) => r.conflicts);
  const failures = runs.flatMap((r) => r.failures.map((f) => ({ ...f, indexKey: r.indexKey })));
  const currencyMismatch = runs.flatMap((r) => r.currencyMismatch.map((m) => ({ ...m, indexKey: r.indexKey })));
  const afterDays = Object.values(history).reduce((a, arr) => a + (arr?.length || 0), 0);

  // ── 报告（按指数分块）──
  for (const r of runs) {
    const cny = r.report.filter((x) => x.currency === 'CNY');
    const usd = r.report.filter((x) => x.currency === 'USD');
    const avg = (arr) => (arr.length ? (arr.reduce((a, x) => a + x.days, 0) / arr.length).toFixed(1) : '0');
    console.log(`\n── ${r.indexKey} 回填结果 ──`);
    console.log(
      `目标 ${r.targets.length} 只 · 成功 ${r.report.length} 只（${(r.ratio * 100).toFixed(0)}%）· 失败 ${r.failures.length} 只` +
        (r.notCovered.length ? ` · 源站未收录 ${r.notCovered.length} 只（不计入成功率）` : '')
    );
    console.log(`人民币 ${cny.length} 只，平均 ${avg(cny)} 个交易日；美元 ${usd.length} 只，平均 ${avg(usd)} 个交易日`);
    console.log(
      `新增 ${r.report.reduce((a, x) => a + x.added, 0)} 条，按 --prefer=remote 改写 ${r.report.reduce((a, x) => a + x.updated, 0)} 条`
    );

    const thin = r.report.filter((x) => x.total < 20);
    if (thin.length) {
      console.log(`⚠ 历史仍不足 20 个交易日的份额（${thin.length} 只）：`);
      for (const x of thin) console.log(`  ${x.code} ${x.currency} 共 ${x.total} 天`);
    }
  }

  console.log(`\nhistory.json 记录点：${beforeDays} → ${afterDays}`);
  if (conflicts.length) {
    console.log(`\n⚠ 同日取值冲突 ${conflicts.length} 条（默认保留本地，--prefer=remote 才反转）：`);
    for (const c of conflicts.slice(0, 15)) {
      console.log(`  ${c.code} ${c.date} 本地 ${c.local} / 来源 ${c.remote} · 保留 ${c.kept}`);
    }
    if (conflicts.length > 15) console.log(`  … 其余 ${conflicts.length - 15} 条略`);
  }
  const protectedList = runs.flatMap((r) => r.protected.map((x) => ({ ...x, indexKey: r.indexKey })));
  if (protectedList.length) {
    console.log(`\n🔒 最新一天的点受保护（--prefer=remote 也不改写，那是本站当天的实测）：`);
    for (const x of protectedList) console.log(`  ${x.indexKey} ${x.code} ${x.date} 保留本地 ${x.local}`);
  }
  if (currencyMismatch.length) {
    console.log(`\n✗ 币种不一致 ${currencyMismatch.length} 条（请核对 funds.json 代码）：`);
    for (const m of currencyMismatch) console.log(`  ${m.indexKey} ${m.code} 来源 ${m.site} / 本地 ${m.local}`);
  }
  if (failures.length) {
    console.log(`\n✗ 失败清单（这些份额保留原历史，未被清空）：`);
    for (const f of failures) console.log(`  ${f.indexKey} ${f.code} ${f.reason}`);
  }
  const notCovered = runs.flatMap((r) => r.notCovered.map((code) => `${r.indexKey} ${code}`));
  if (notCovered.length) {
    console.log(`\n… 源站未收录（正常，这些份额只能靠本站逐日累积）：${notCovered.join(' / ')}`);
  }
  if (UNKNOWN_STATUS_TEXTS.size) {
    console.log(`\n⚠ 未识别的状态词（按 UNKNOWN 写入，需补映射）：${[...UNKNOWN_STATUS_TEXTS].join(' / ')}`);
  }

  // ── 门禁 ──
  const lowRatio = runs.filter((r) => r.ratio < MIN_OK_RATIO);
  if (currencyMismatch.length && !FORCE) {
    console.error('\n✗ 存在币种不一致，拒绝写入（确认无误可加 --force）。');
    process.exit(4);
  }
  if (lowRatio.length && !FORCE) {
    for (const r of lowRatio) {
      console.error(
        `\n✗ ${r.indexKey} 解析成功率 ${(r.ratio * 100).toFixed(0)}% < ${(MIN_OK_RATIO * 100).toFixed(0)}%，拒绝写入` +
          '（避免写入半截历史；可加 --force 强制）。'
      );
    }
    process.exit(4);
  }

  if (DRY_RUN) {
    console.log('\n--dry-run：未写入任何文件。');
    return;
  }

  writeJsonAtomic('history.json', history);
  console.log(`\n✓ 已写入 ${path.join(DATA_DIR, 'history.json')}`);
}

main().catch((e) => {
  console.error('✗ 回填异常：', e);
  process.exit(1);
});
