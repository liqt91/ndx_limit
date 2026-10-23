// 东方财富「全市场基金列表」快照：一次请求拿到 28000+ 只基金的状态与申购限额。
//
// 用途（旁路，不替代逐页抓取）：
//   1) 对账：与我们逐页抓到的人民币份额比金额，发现解析漂移；
//   2) 兜底：某只基金详情页抓取失败时，用快照补一个点，避免当天记 UNKNOWN；
//   3) 缺口：用关键字扫全市场，找出我们名单里没有的纳指100 份额（含 I 类），交人工确认。
//
// 为什么它是旁路而不是主链路：快照的**额度字段可信**（2026-10-21 与 56 个份额逐只比对
// 金额 56/56 相等），但**状态字段有噪声**——实测 016055 写「暂停申购」却同时给
// 日累计限额 100000000000（1e11 是「没设这个字段」的占位值，不是无限额），
// 而 021000 写「限大额」、实际页面是「该基金暂不开放购买」。所以状态只信详情页。
//
// ★ 安全：上游返回的是一段 JS 对象字面量（`var reData={datas:[...]}`）。
// 绝不能 `new Function()` / eval 执行它——那等于给构建机开一个「跑远端代码」的口子。
// 本模块手写扫描器把它转成 JSON 文本再 JSON.parse。
//
// 依赖：仅 Node 22 内置。

const SNAPSHOT_URL =
  'https://fund.eastmoney.com/Data/Fund_JJJZ_Data.aspx?t=8&page=1,50000&js=reData&sort=fcode,asc';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const MAX_BYTES = 24 * 1024 * 1024;
const TIMEOUT = 45000;
const MAX_ATTEMPTS = 3;

// 一亿以上一律视为「未设上限」的占位值（实测 1e11；留 1e9 的余量以防上游改量纲）
const UNLIMITED_MARK = 1e9;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 把 `var reData={datas:[...],record:27849}` 这类 JS 对象字面量转成合法 JSON 文本。
 * 只在字符串字面量**之外**给裸 key 加引号——
 * 只用正则会破坏内容里恰好出现的 `,x:` 片段（基金名/公告标题里都可能出现）。
 */
export function jsLiteralToJson(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let quote = null;
  while (i < n) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') {
        const nxt = src[i + 1] ?? '';
        // 单引号字符串里的 \' 在 JSON 里非法，要还原成裸引号
        if (quote === "'" && nxt === "'") {
          out += "'";
          i += 2;
          continue;
        }
        out += ch + nxt;
        i += 2;
        continue;
      }
      if (ch === quote) {
        out += '"';
        quote = null;
        i++;
        continue;
      }
      // 单引号字符串里的 " 必须转义，否则拼出来的 JSON 会被截断
      out += ch === '"' ? '\\"' : ch;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += '"';
      i++;
      continue;
    }
    if (ch === '{' || ch === ',') {
      out += ch;
      i++;
      let ws = '';
      while (i < n && (src[i] === ' ' || src[i] === '\n' || src[i] === '\r' || src[i] === '\t')) {
        ws += src[i];
        i++;
      }
      const m = /^([A-Za-z_$][\w$]*)\s*:/.exec(src.slice(i, i + 80));
      if (m) {
        out += `${ws}"${m[1]}":`;
        i += m[0].length;
        continue;
      }
      out += ws;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 单行归一：`['019441','万家…','指数型-海外股票','1.6764','10-19','限大额','开放赎回','','5.0','5.0',…]`
 * 字段位：0 代码 / 1 名称 / 2 类型 / 3 净值 / 4 净值日 / 5 申购状态 / 6 赎回状态 /
 *         8 起购金额 / 9 单日累计申购限额
 * 返回 { code, name, type, status, limit, min, rawStatus }；状态口径与详情页解析对齐。
 */
export function normalizeRow(row) {
  const code = String(row[0] || '').trim();
  const name = String(row[1] || '').trim();
  const type = String(row[2] || '').trim();
  const rawStatus = String(row[5] || '').trim();
  const min = num(row[8]);
  const max = num(row[9]);

  const capped = max != null && max > 0 && max < UNLIMITED_MARK;

  let status = 'UNKNOWN';
  if (/场内/.test(rawStatus)) status = 'CLOSED'; // 场内 ETF 没有「申购限额」这个概念
  else if (/暂停/.test(rawStatus)) status = 'STOPPED';
  else if (/封闭/.test(rawStatus)) status = 'CLOSED';
  else if (/限大额/.test(rawStatus)) status = capped ? 'LIMITED' : 'UNKNOWN';
  else if (/开放申购/.test(rawStatus)) status = capped ? 'LIMITED' : 'OPEN';

  // 暂停/封闭时金额无意义（016055 就是这种自相矛盾的行）
  const limit = status === 'LIMITED' ? Math.round(max) : null;
  return { code, name, type, status, limit, min, rawStatus };
}

/** 拉全量快照。失败返回 null（旁路，不该影响主抓取）。 */
export async function fetchSnapshot({ attempt = 1 } = {}) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
    const res = await fetch(SNAPSHOT_URL, {
      headers: { 'User-Agent': UA, Referer: 'https://fund.eastmoney.com/' },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error('HTTP ' + res.status);

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_BYTES) throw new Error(`响应过大 ${(buf.byteLength / 1024 / 1024).toFixed(1)}MB`);
    const text = buf.toString('utf8');

    const start = text.indexOf('{');
    if (start < 0) throw new Error('未找到对象起始位置');
    const body = text.slice(start).replace(/;\s*$/, '');
    const json = jsLiteralToJson(body);
    const data = JSON.parse(json);
    if (!Array.isArray(data.datas)) throw new Error('datas 字段缺失');

    const rows = new Map();
    for (const row of data.datas) {
      const r = normalizeRow(row);
      if (r.code) rows.set(r.code, r);
    }
    return { rows, record: data.record ?? rows.size, showday: data.showday ?? null, bytes: buf.byteLength };
  } catch (e) {
    if (attempt < MAX_ATTEMPTS) {
      await sleep(800 * attempt);
      return fetchSnapshot({ attempt: attempt + 1 });
    }
    console.warn(`⚠ 全量快照拉取失败（旁路跳过）：${e && e.message ? e.message : e}`);
    return null;
  }
}

// 纳指100 的识别关键字。宁可宽一点（后面还有人工确认），也不要漏掉新份额。
export const NAQ_KEYWORDS = ['纳斯达克100', '纳指100', 'NASDAQ100', 'Nasdaq100', 'NASDAQ 100', 'Nasdaq 100'];

// 标普500 的识别关键字。2026-10-23 普查实测命中 29 只（含 4 只场内 ETF）。
export const SP500_KEYWORDS = ['标普500', '标普 500', 'S&P500', 'S&P 500', 'SP500'];

/** 场内 ETF 判定：名称含 ETF 但**不含「联接」**。
 *  场外的场外份额是「××标普500ETF联接 A」，含联接；纯 ETF（标普500ETF博时）不含。
 *  不能按代码段判（1/5 开头）：161125、160213 这类 LOF 场外可申购，会被误伤。 */
function isExchangeTraded(row) {
  if (/场内/.test(row.rawStatus)) return true;
  return /ETF/.test(row.name) && !/联接/.test(row.name);
}

/** 全市场里名字命中指定关键字的份额。用于「名单外缺口」提示，不自动并入 funds.json。 */
export function scanIndex(rows, keywords) {
  const out = [];
  for (const r of rows.values()) {
    const hay = `${r.name}${r.type}`.toLowerCase();
    if (keywords.some((k) => hay.includes(k.toLowerCase()))) out.push(r);
  }
  out.sort((a, b) => a.code.localeCompare(b.code));
  return out;
}

/** 全市场里名字含纳指100 关键字的份额（含场内，供缺口判断排除用）。 */
export function scanNasdaq100(rows) {
  return scanIndex(rows, NAQ_KEYWORDS);
}

/** 全市场里名字含标普500 关键字的份额（含场内）。 */
export function scanSp500(rows) {
  return scanIndex(rows, SP500_KEYWORDS);
}

/** 从扫描结果里剔掉场内 ETF，剩下的才是「场外申购份额」。 */
export function excludeExchangeTraded(rows) {
  return {
    exchange: rows.filter(isExchangeTraded),
    over: rows.filter((r) => !isExchangeTraded(r)),
  };
}
