// GET /api/subscribers —— 供 GitHub Actions 每天收盘前拉取订阅名单（仅此用途）
//
// 为什么不直接把名单放 Brevo：名单是资产，放自己的 KV 里，换发信服务商（Brevo →
// Resend → 腾讯云 SES）时名单一行不用动；Brevo 只当 SMTP 通道，不知道你有多少订阅者。
//
// 鉴权：Authorization: Bearer <SUBSCRIBERS_TOKEN>（EdgeOne 项目 → 环境变量里配，
// 与 GitHub Secrets 里那个同名密钥保持一致）。没有这个头一律 401。
//
// 返回：{ ok, count, emails: string[], subscribers: [{email, indices}], byIndex: {…} }
//   emails     扁平邮箱数组（老客户端/手工用）
//   subscribers 带订阅范围，发信侧按它裁剪正文
//   ★ 老记录（纯邮箱）一律读成「只订纳指」——2026-10-23 之前只有纳指日报，
//     把它当成「两个指数都要」等于替订阅者做决定，会让他一天多收一节没订过的内容。
//
// 注意这是公网端点，务必：① token 用足够长的随机串；② 在控制台对该路径加限频规则；
// ③ 一旦泄露立刻在 EdgeOne 与 GitHub 两侧同时轮换。

const MAX_KEYS = 20000; // 顺手兜住异常膨胀，避免函数被拖死
const PAGE = 256; // KV list 上限
const GET_BATCH = 20; // 并发 get 的批大小

// 与 subscribe.js / confirm.js / scripts/digest.mjs 必须逐字一致（顺序也一致）
const INDEX_KEYS = ['纳斯达克100', '标普500'];
const LEGACY_INDEX = '纳斯达克100';

function normalizeIndices(input, fallback = [LEGACY_INDEX]) {
  const raw = Array.isArray(input) ? input : typeof input === 'string' ? input.split(/[,，、\s]+/) : [];
  const picked = INDEX_KEYS.filter((k) => raw.some((x) => String(x).trim() === k));
  return picked.length ? picked : [...fallback];
}

/** 一条 KV 值 → {email, indices}。老格式（纯邮箱）→ 只订纳指。 */
function parseSubValue(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return null;
  if (text.startsWith('{')) {
    try {
      const rec = JSON.parse(text);
      const email = String((rec && rec.email) || '').trim().toLowerCase();
      if (!email) return null;
      return { email, indices: normalizeIndices(rec.indices) };
    } catch {
      return null;
    }
  }
  return { email: text.toLowerCase(), indices: [LEGACY_INDEX] };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function getKV(env) {
  return globalThis.SUBS_KV ?? (env && env.SUBS_KV);
}

// 定长比较，避免用 === 提前返回泄露 token 前缀。
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function onRequestGet({ request, env }) {
  const expected = (env && env.SUBSCRIBERS_TOKEN) || '';
  if (!expected) {
    console.error('SUBSCRIBERS_TOKEN 未配置：请在 EdgeOne 项目环境变量里设置');
    return json({ ok: false, error: 'not_configured' }, 500);
  }

  const auth = request.headers.get('authorization') || '';
  const given = auth.replace(/^Bearer\s+/i, '').trim();
  if (!safeEqual(given, expected)) return json({ ok: false, error: 'unauthorized' }, 401);

  const kv = getKV(env);
  if (!kv) {
    console.error('SUBS_KV 未绑定：请在 EdgeOne 项目 → KV 存储里绑定命名空间');
    return json({ ok: false, error: 'not_configured' }, 500);
  }

  // 分页列出所有 `sub_` 开头的 key
  const keys = [];
  let cursor;
  for (;;) {
    const page = await kv.list({ prefix: 'sub_', limit: PAGE, cursor });
    for (const k of page.keys || []) keys.push(k.key);
    if (keys.length > MAX_KEYS) {
      console.error(`key 数超过 ${MAX_KEYS}，疑似异常，已中止`);
      return json({ ok: false, error: 'too_many_keys' }, 500);
    }
    if (page.complete || !page.cursor) break;
    cursor = page.cursor;
  }

  // 批量取回邮箱（并发有上限，避免一次打太多 KV 请求）
  const subs = [];
  for (let i = 0; i < keys.length; i += GET_BATCH) {
    const chunk = keys.slice(i, i + GET_BATCH);
    const vals = await Promise.all(chunk.map((k) => kv.get(k)));
    for (const v of vals) {
      const rec = parseSubValue(v);
      if (rec) subs.push(rec);
    }
  }

  subs.sort((a, b) => (a.email < b.email ? -1 : a.email > b.email ? 1 : 0));
  const byIndex = {};
  for (const k of INDEX_KEYS) byIndex[k] = subs.filter((s) => s.indices.includes(k)).length;

  return json({
    ok: true,
    count: subs.length,
    emails: subs.map((s) => s.email),
    subscribers: subs,
    byIndex,
  });
}
