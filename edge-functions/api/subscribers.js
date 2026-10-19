// GET /api/subscribers —— 供 GitHub Actions 每天早上拉取订阅名单（仅此用途）
//
// 为什么不直接把名单放 Brevo：名单是资产，放自己的 KV 里，换发信服务商（Brevo →
// Resend → 腾讯云 SES）时名单一行不用动；Brevo 只当 SMTP 通道，不知道你有多少订阅者。
//
// 鉴权：Authorization: Bearer <SUBSCRIBERS_TOKEN>（EdgeOne 项目 → 环境变量里配，
// 与 GitHub Secrets 里那个同名密钥保持一致）。没有这个头一律 401。
//
// 返回：{ ok, count, emails: string[] }
//
// 注意这是公网端点，务必：① token 用足够长的随机串；② 在控制台对该路径加限频规则；
// ③ 一旦泄露立刻在 EdgeOne 与 GitHub 两侧同时轮换。

const MAX_KEYS = 20000; // 顺手兜住异常膨胀，避免函数被拖死
const PAGE = 256; // KV list 上限
const GET_BATCH = 20; // 并发 get 的批大小

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
  const emails = [];
  for (let i = 0; i < keys.length; i += GET_BATCH) {
    const chunk = keys.slice(i, i + GET_BATCH);
    const vals = await Promise.all(chunk.map((k) => kv.get(k)));
    for (const v of vals) if (typeof v === 'string' && v) emails.push(v);
  }

  emails.sort();
  return json({ ok: true, count: emails.length, emails });
}
