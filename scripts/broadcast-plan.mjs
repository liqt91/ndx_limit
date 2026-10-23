// 订阅偏好（订哪个指数）的唯一口径。
//
// 为什么单独一个文件：这套语义有两处实现——边缘函数（写/读 KV，跑在 EdgeOne，不能 import
// 仓库里的 ESM）与发送脚本（按偏好裁剪）。两处实现不可能共享代码，只能共享**口径**：
// 这里的 normalizeIndices / parseSubscriberValue 是规格书，check-broadcast.mjs 会拿它
// 去敲边缘函数源码里的字面量，防止两边悄悄走偏（同 unsub.mjs 的做法）。
//
// 存储格式（KV，key = sub_<sha256(email)>）：
//   老记录：纯邮箱字符串            → 视为只订纳指（2026-10-23 之前的订阅者只收到过纳指日报）
//   新记录：{"email","indices":[…],"ts"} → indices 是 indexKey 数组
// ★ 老记录绝不能被解释成「两个指数都要」——那是替用户做决定，会让他一天多收一节
//   他从没订过的标普500。这正是 parseSubscriberValue 里 fallback 只给 [NDX] 的原因。
//
// 依赖：仅 Node 22 内置。

import { INDEX_KEYS, NDX } from './digest.mjs';

export const SUB_PREFIX = 'sub_';
export const PEND_PREFIX = 'pend_';
export const TOK_PREFIX = 'tok_';

/** 把任意输入规整成合法的 indexKey 数组（保序、去重、丢弃认不出来的）。 */
export function normalizeIndices(input, { fallback = INDEX_KEYS } = {}) {
  const raw = Array.isArray(input)
    ? input
    : typeof input === 'string'
      ? input.split(/[,，、\s]+/)
      : [];
  const picked = [];
  for (const k of INDEX_KEYS) {
    if (raw.some((x) => String(x).trim() === k) && !picked.includes(k)) picked.push(k);
  }
  if (picked.length) return picked;
  // 全部认不出来（或缺省）→ 用 fallback。新订阅默认两个都要，老记录默认只要纳指。
  return Array.isArray(fallback) ? [...fallback] : [fallback];
}

/**
 * 解析 KV 里的一条 sub_ 值。
 * @returns {{email:string, indices:string[], legacy:boolean}|null} 解析不出邮箱时返回 null
 */
export function parseSubscriberValue(raw) {
  if (raw == null) return null;
  const text = String(raw).trim();
  if (!text) return null;

  if (text.startsWith('{')) {
    let rec;
    try {
      rec = JSON.parse(text);
    } catch {
      return null;
    }
    const email = String((rec && rec.email) || '')
      .trim()
      .toLowerCase();
    if (!email) return null;
    return { email, indices: normalizeIndices(rec.indices, { fallback: [NDX] }), legacy: false };
  }

  // 老记录：纯邮箱。只订过纳指，所以只给纳指。
  return { email: text.toLowerCase(), indices: [NDX], legacy: true };
}

/** 写 KV 用的值。ts 用于排障（什么时候写进来的），不影响发信。 */
export function serializeSubscriber({ email, indices, ts = Date.now() }) {
  return JSON.stringify({ email: String(email).trim().toLowerCase(), indices: normalizeIndices(indices), ts });
}

/** 合并偏好：只增不减（重填表单不会把已订的指数弄丢）。 */
export function mergeIndices(oldIndices, newIndices) {
  return normalizeIndices([...(oldIndices || []), ...(newIndices || [])], { fallback: [NDX] });
}

/**
 * 收件人计划：每个订阅者只收「他订了 且 今天数据可用」的指数。
 * @returns {{recipients:{email:string,indices:string[]}[], skipped:{email:string,reason:string}[]}}
 */
export function planRecipients({ subscribers, usable }) {
  const ok = Array.isArray(usable) ? usable : [];
  const recipients = [];
  const skipped = [];
  for (const s of subscribers || []) {
    const want = (s.indices || []).filter((k) => ok.includes(k));
    if (!want.length) {
      const why = (s.indices || []).length ? 'index_unusable' : 'no_index';
      skipped.push({ email: s.email, reason: why });
      continue;
    }
    recipients.push({ email: s.email, indices: want });
  }
  return { recipients, skipped };
}

/** 汇总每个指数要发给多少人（日志与门禁都用它，避免只看总数看不出漏发）。 */
export function countByIndex(recipients) {
  const out = Object.fromEntries(INDEX_KEYS.map((k) => [k, 0]));
  for (const r of recipients || []) for (const k of r.indices || []) if (k in out) out[k]++;
  return out;
}
