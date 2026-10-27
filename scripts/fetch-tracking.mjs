// 抓取指数基金的「年化跟踪误差」+ 同类平均，来源：天天基金 F10「特色数据」页。
//
// 用途（POC）：为基金列表补充「跟得准不准」这一维度 —— 指数基金最该看的指标之一。
//
// 指标口径（天天基金原文）：
//   「跟踪误差：是跟踪偏离度的标准差的年化值。是根据历史的收益率差值数据来描述基金与
//     标的指数之间的密切程度……跟踪误差越小，基金经理的管理能力越强。」
//   → 注意：**跟踪误差 ≠ 跟踪偏离度**。偏离度是「日收益差」，误差是「日收益差的标准差年化」。
//     页面只给年化跟踪误差，不给日均跟踪偏离度（后者只出现在基金合同的投资目标里）。
//
// ★ 这是个**滞后指标**：页面标「截止至 YYYY-MM-DD」，通常是上周最后交易日。必须把日期一起存。
// ★ 安全：只解析 HTML 文本表格，绝不 eval 远端脚本。
// ★ 上游：fundf10.eastmoney.com —— 需带 UA + Referer，否则 403。

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const REFERER = 'https://fundf10.eastmoney.com/';
const TIMEOUT = 15000;
const MAX_ATTEMPTS = 2;
const GAP_MS = 150;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 从文本里取第一个百分比数值（单位 %）。 */
function firstPct(text) {
  const m = text.match(/([\d.]+)\s*%/);
  return m ? parseFloat(m[1]) : null;
}

/**
 * 解析特色数据页。
 * 只认「指数基金指标」那张表：表头是 跟踪指数 / 年化跟踪误差 / 同类平均跟踪误差。
 * 表头也可能是「跟踪偏差」等变体，所以按表头定位、按列序取值，不写死文案位置。
 */
export function parseTracking(html) {
  const out = {
    index: null,
    trackingError: null,
    peerError: null,
    asOf: null,
    isIndexFund: false,
  };

  const headIdx = html.indexOf('跟踪指数');
  if (headIdx < 0) return out; // 非指数基金没有这张表

  // ★ 截止日期必须从表格所在位置往后找：整页有多个「截止至：」（规模/份额等），
  //   第一个是 2026-09-30（季报口径），跟踪误差那张表自己的是 2026-10-23（上周最后交易日）。
  const tail = html.slice(headIdx);
  const asOfM = tail.match(/截止至[：:]\s*(\d{4}-\d{2}-\d{2})/);
  if (asOfM) out.asOf = asOfM[1];

  // ★ 表头行的 <tr> 起点在「跟踪指数」文字**之前**，从文字处切片已越过表头，
  //   所以不能假设 rows[1] 是数据行 —— 取「第一个含 ≥3 个 <td> 的行」。
  const seg = tail.slice(0, 1200);
  let cells = null;
  for (const m of seg.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const tds = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)]
      .map((x) => x[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim());
    if (tds.length >= 3) {
      cells = tds;
      break;
    }
  }
  if (!cells) return out;

  out.isIndexFund = true;
  out.index = cells[0] || null;
  out.trackingError = firstPct(cells[1] || '');
  out.peerError = firstPct(cells[2] || '');
  return out;
}

async function fetchOne(code, attempt = 1) {
  const url = `https://fundf10.eastmoney.com/tsdata_${code}.html`;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: REFERER },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const html = await res.text();
    return { code, ...parseTracking(html), ok: true };
  } catch (e) {
    if (attempt < MAX_ATTEMPTS) {
      await sleep(400 * attempt);
      return fetchOne(code, attempt + 1);
    }
    return { code, ok: false, error: e.message };
  }
}

/** 批量抓取。codes 为份额代码数组。返回 { updatedAt, asOf, codes: {...} }。 */
export async function fetchTracking(codes) {
  const out = {};
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    out[code] = await fetchOne(code);
    if (i < codes.length - 1) await sleep(GAP_MS);
  }
  // 整批共用一个截止日（若出现不一致，取字符串最大的那个并在汇总里体现）
  const dates = Object.values(out)
    .map((v) => v.asOf)
    .filter(Boolean)
    .sort();
  return {
    updatedAt: new Date().toISOString().slice(0, 10),
    asOf: dates.length ? dates[dates.length - 1] : null,
    asOfSet: [...new Set(dates)],
    codes: out,
  };
}

// 直接运行：抓名录里的**全部**份额（两个指数、人民币与美元），写入 data/fund-tracking.json。
// ★ 美元份额是同一只基金的另一个币种份额，跟踪误差按家族级指标看待（实测同类份额仅差 0.01%），
//   但抓全量才不会在表格里留空。
if (process.argv[1] && process.argv[1].endsWith('fetch-tracking.mjs')) {
  const fs = await import('fs');
  const f = JSON.parse(fs.readFileSync('./data/funds.json', 'utf8'));
  const codes = f.funds.flatMap((x) => x.codes.map((c) => c.code));
  console.log(`抓取 ${codes.length} 个份额的跟踪误差（全指数、含美元）…`);
  const result = await fetchTracking(codes);
  const vals = Object.values(result.codes);
  const okCount = vals.filter((c) => c.ok).length;
  const hasVal = vals.filter((c) => c.trackingError != null).length;
  fs.writeFileSync('./data/fund-tracking.json', JSON.stringify(result, null, 2));
  console.log(
    `完成：${okCount}/${codes.length} 请求成功，${hasVal} 个有跟踪误差 → data/fund-tracking.json（截止 ${result.asOf}）`
  );
}
