// 抓取基金费率（管理费 / 托管费 / 销售服务费 / 申购优惠费率），来源：天天基金 F10 费率页。
//
// 用途（POC）：为基金列表补充「费率」列 —— 投资者最关心的持有成本。
//   管理/托管/销售服务 是「每年」的运作费，C 类比 A 类多一笔销售服务费；
//   申购优惠费率 = 天天基金实际执行的优惠申购费（A 类约 0.12%，C 类 0.00%）。
//
// ★ 安全：只解析 HTML 文本里的 <td> 数值，绝不 eval/Function 远端脚本。
// ★ 上游：fundf10.eastmoney.com —— 需带 UA + Referer，否则 403。
// ★ 礼貌：请求间留 150ms，单只超时 15s，失败重试 2 次。

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const REFERER = 'https://fundf10.eastmoney.com/';
const TIMEOUT = 15000;
const MAX_ATTEMPTS = 2;
const GAP_MS = 150;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 从费率页 HTML 解析四费率（数值，单位 %）。解析不到的字段为 null。 */
export function parseFees(html) {
  const getAnnual = (label) => {
    const i = html.indexOf(label);
    if (i < 0) return null;
    const m = html.slice(i, i + 260).match(/<td[^>]*>([\d.]+)%（每年）<\/td>/);
    return m ? parseFloat(m[1]) : null;
  };
  const mgmt = getAnnual('管理费率');
  const custody = getAnnual('托管费率');
  const sales = getAnnual('销售服务费率');

  // 申购费：分为「原费率」（基金合同约定的标准费率）与「天天基金优惠费率」。
  // 两者合并在同一单元格里，形如
  //   <td><strike>1.20%</strike>&nbsp;|&nbsp;0.12%</td>
  // → 第一个百分比是原费率，最后一个百分比是天天基金实际执行的优惠费率。
  //
  // ★ 重要口径：申购费是**分档**的，按单笔金额递减（如 <100万 1.20%、
  //   100–200万 0.90%、200–500万 0.60%、≥500万 每笔1000元）。这里只取**第一档**
  //   （即「小于100万元」），因为它是绝大多数个人投资者的实际档位。
  //   因此 purchaseOrig / purchase 都只代表小额档，不能当「这只基金申购费多少」的全貌。
  //
  // ★ 另一层口径：原费率是**产品属性**（各渠道相同），优惠费率是**渠道报价**
  //   （天天基金 1 折；银行多为 8 折或不打折；支付宝/券商视基金而定）。
  //   所以页面展示时应标注「天天基金」，否则会被读成全市场费率。
  let purchaseOrig = null;
  let purchase = null;
  let purchaseTier = null;
  let purchaseTierCount = 0;
  const si = html.indexOf('申购费率');
  if (si >= 0) {
    const seg = html.slice(si, si + 1600);
    for (const m of seg.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gs)) {
      const tds = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => x[1].trim());
      // 跳过表头行（只有一列）与说明行
      if (tds.length < 2) continue;
      const cell = tds[1] || '';
      const pcts = [...cell.matchAll(/([\d.]+)%/g)].map((x) => parseFloat(x[1]));
      if (!pcts.length) continue;
      purchaseTierCount++;
      if (purchase === null) {
        const label = tds[0].replace(/<[^>]+>/g, '').trim();
        purchaseTier = label || null;
        purchaseOrig = pcts[0];
        purchase = pcts[pcts.length - 1];
      }
    }
  }

  // 折扣：优惠费率 / 原费率，保留两位小数（1 折 = 0.1）。
  const purchaseDiscount =
    purchaseOrig > 0 && purchase !== null
      ? Math.round((purchase / purchaseOrig) * 100) / 100
      : null;

  // ★ 必须舍入：0.6 + 0.3 会算出 0.8999999999999999，直接写进 JSON 会污染数据。
  const annualTotal =
    Math.round([mgmt, custody, sales].reduce((a, v) => a + (v || 0), 0) * 100) / 100;

  return {
    mgmt,
    custody,
    sales,
    purchase,
    purchaseOrig,
    purchaseTier,
    purchaseDiscount,
    purchaseTierCount,
    annualTotal,
  };
}

async function fetchOne(code, attempt = 1) {
  const url = `https://fundf10.eastmoney.com/jjfl_${code}.html`;
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
    const fees = parseFees(html);
    return { code, ...fees, ok: true };
  } catch (e) {
    if (attempt < MAX_ATTEMPTS) {
      await sleep(400 * attempt);
      return fetchOne(code, attempt + 1);
    }
    return { code, ok: false, error: e.message };
  }
}

/** 批量抓取。codes 为份额代码数组。返回 { updatedAt, codes: {...} }。 */
export async function fetchFees(codes) {
  const out = {};
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    const r = await fetchOne(code);
    out[code] = r;
    if (i < codes.length - 1) await sleep(GAP_MS);
  }
  return { updatedAt: new Date().toISOString().slice(0, 10), codes: out };
}

// 直接运行：抓名录里的**全部**份额（两个指数、人民币与美元），写入 data/fund-fees.json。
// ★ 不能只抓纳指人民币：美元份额与标普500 份额在页面上跟人民币同表展示，
//   漏抓会让那一半的行「年费」永远空着，读起来像数据缺失。
if (process.argv[1] && process.argv[1].endsWith('fetch-fees.mjs')) {
  const fs = await import('fs');
  const f = JSON.parse(fs.readFileSync('./data/funds.json', 'utf8'));
  const codes = f.funds.flatMap((x) => x.codes.map((c) => c.code));
  console.log(`抓取 ${codes.length} 个份额费率（全指数、含美元）…`);
  const result = await fetchFees(codes);
  const okCount = Object.values(result.codes).filter((c) => c.ok).length;
  fs.writeFileSync('./data/fund-fees.json', JSON.stringify(result, null, 2));
  console.log(`完成：${okCount}/${codes.length} 成功 → data/fund-fees.json`);
}
