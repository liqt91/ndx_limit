// 晨星中国（morningstar.cn）备选信息源：抓每只基金的「申购状态 / 单日申购限额」。
//
// 为什么需要它（2026-10-21 实测）：
//   主链路（天天基金详情页）单点故障时（页面改版、域名被封、CI 网络抖动），
//   需要一个独立来源补点。全量快照（em-snapshot.mjs）能做金额兜底，但它的
//   **状态字段不可信**（016055 写「暂停申购」却给 1e11 限额、021000 写「限大额」
//   实际「暂不开放购买」），兜底只能补金额、不能补状态。晨星补的正是这一块。
//
// 实测结论（60 个份额全量比对，2026-10-21）：
//   - 与天天基金详情页 51/60 一致；分歧 9 个均可解释：021000/022525 是主链路
//     特意覆盖的「暂不开放购买」特例、4 个美元份额晨星显示「限大额 1 美元」而
//     详情页写暂停、019442 金额 5 vs 10（当日调限额，可能更新时序差）、
//     019738/019739 晨星无数据。
//   - 时效性好：华安 040046 于 10-20 公告暂停申购，晨星次日即显示「不可申购」。
//   - 页面结构：标签在 .basic-title、值在紧随的 .basic-value（见 parseMorningstar）。
//
// 与新浪的对比（为什么不选新浪）：新浪 FdFundService.getDealRule 同样有结构化
// 限额字段，但数据滞后——040046 暂停后仍显示「可申购 5 元」、019441 当日调限额
// 后仍显示「无限制」，60 只仅 14 只与天天基金一致。滞后源做备选会引入错误，
// 故不接入。
//
// ★ 访问方式：必须带全 User-Agent / Accept / Accept-Language 三个头，
//   否则晨星反爬返回 403（2026-10-21 实测：缺头 403，带齐 200）。
// ★ 页面约 400KB/只，60 只约 25MB——只在对账或兜底时抓，不每轮重复抓。
//
// 依赖：仅 Node 22 内置。

const MS_HOSTS = new Set(['www.morningstar.cn', 'morningstar.cn']);

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const MAX_BYTES = 2 * 1024 * 1024; // 单页上限 2MB（实测 ~430KB，留一倍余量）
const TIMEOUT = 20000;
const MAX_ATTEMPTS = 3;
const BASE_DELAY = 600;
const MAX_DELAY = 5000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const backoff = (attempt) => Math.min(MAX_DELAY, BASE_DELAY * 2 ** (attempt - 1)) + Math.random() * 300;

/**
 * 从晨星基金页解析「申购状态 / 单日申购限额」。
 * 页面结构（data-v-* 属性名可能变，按 class 名找）：
 *   <div class="basic-title">申购状态 <!----></div><div class="basic-value">限大额</div>
 *   <div class="basic-title">单日申购限额 <!----></div><div class="basic-value">10元</div>
 * 返回 { state, limit }：state ∈ 可申购/限大额/不可申购/…（原样），limit 为金额数字或 null。
 */
export function parseMorningstar(html) {
  const field = (kw) => {
    const m = html.match(new RegExp(kw + '[\\s\\S]{0,240}?basic-value[^>]*>([^<]+)<'));
    return m ? m[1].trim() : null;
  };
  const state = field('申购状态');
  const raw = field('单日申购限额');
  let limit = null;
  if (raw && raw !== '无限制' && raw !== '--') {
    //  alternation 必须长的在前：「万美元」若排在「元」后面，「1万美元」会被截成 1 元
    const m = raw.match(/([\d.]+)\s*(万美元|万元|万|千万|百万|千|美元|港币|元)/);
    if (m) {
      let v = parseFloat(m[1]);
      if (m[2] === '万美元' || m[2] === '万元' || m[2] === '万') v *= 10000;
      else if (m[2] === '千万') v *= 10000000;
      else if (m[2] === '百万') v *= 1000000;
      else if (m[2] === '千') v *= 1000;
      limit = Math.round(v);
    }
  }
  return { state, limit };
}

/** 晨星状态 → 本站口径（UNKNOWN 绝不臆造；认不出的状态原样上交由调用方决定）。 */
export function msStatusToLocal(state) {
  if (state === '可申购') return 'OPEN';
  if (state === '限大额') return 'LIMITED';
  if (state === '不可申购' || state === '暂停申购') return 'STOPPED';
  return 'UNKNOWN';
}

/**
 * 抓一只基金的晨星页。返回 { code, status, limit, error }——
 * status/limit 为本站口径；失败时 error 非空、status 为 'UNKNOWN'。
 */
export async function fetchMorningstar(code, attempt = 1) {
  const url = `https://www.morningstar.cn/fund/${code}.html`;
  try {
    if (!MS_HOSTS.has(new URL(url).host)) {
      return { code, status: 'UNKNOWN', limit: null, error: 'host 不在白名单' };
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'zh-CN,zh;q=0.9' },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_BYTES) throw new Error(`响应过大 ${(buf.byteLength / 1024).toFixed(0)}KB`);
    const html = buf.toString('utf8');

    const { state, limit } = parseMorningstar(html);
    const status = msStatusToLocal(state);
    if (status === 'UNKNOWN') throw new Error(`无法识别的申购状态: ${state ?? '字段缺失'}`);
    // 「不可申购」却带着额度是自相矛盾的（040046 实测：不可申购 + 无限制）——不可买即无额度
    return { code, status, limit: status === 'STOPPED' ? null : limit, error: null };
  } catch (e) {
    if (attempt < MAX_ATTEMPTS) {
      await sleep(backoff(attempt));
      return fetchMorningstar(code, attempt + 1);
    }
    return { code, status: 'UNKNOWN', limit: null, error: String(e && e.message ? e.message : e) };
  }
}
