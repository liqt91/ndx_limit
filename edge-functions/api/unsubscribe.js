// GET /api/unsubscribe?e=<email>&t=<token> —— 点日报底部的退订链接落到这里
//
// 为什么要有它：确认（opt-in）和退订（opt-out）是同一条生命周期的两端。只做确认不做
// 退订，等于「进得来、出不去」——既不合《个人信息保护法》的「撤回同意」，也会让人
// 直接点「举报垃圾邮件」，那比退订伤账号得多。
//
// token 为什么不用存 KV：token = sha256(email + ':' + UNSUB_SECRET)，两边各自算一遍即可
// 校验，不需要为每个订阅者多存一条索引。代价是轮换 UNSUB_SECRET 会让所有历史邮件里的
// 链接失效（可接受：重发新邮件就会带新链接）。
//
// 退订是真删：把 sub_<sha> 从 KV 里删掉，下次群发就取不到这个地址。不留「已退订名单」，
// 少存一份个人信息。

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL = 254;
const KEY_SUB = 'sub_';
const KEY_PEND = 'pend_';
const TOKEN_RE = /^[a-f0-9]{64}$/;

function getKV(env) {
  return globalThis.SUBS_KV ?? (env && env.SUBS_KV);
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 定长比较：避免用 === 提前返回，从耗时上泄露 token 前缀
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function siteUrl(env) {
  return String((env && env.SITE_URL) || 'https://ndx.liqt91.top').replace(/\/+$/, '');
}

// status: ok | already | invalid
function page(env, status) {
  const site = siteUrl(env);
  const map = {
    ok: {
      code: 200,
      title: '已退订',
      body: '这个地址已经从名单里删掉了，之后不会再收到日报。<br>想再订的话，回订阅页重新填一次邮箱就行。',
    },
    already: {
      code: 200,
      title: '这个地址已不在名单里',
      body: '可能之前已经退订过了。之后不会再收到日报。',
    },
    invalid: {
      code: 400,
      title: '链接无效',
      body: '这个退订链接对不上，可能是转发时被截断了。<br>把整条链接完整复制到浏览器再试一次。',
    },
  };
  const m = map[status] || map.invalid;

  return new Response(
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${m.title} - 纳指开门日报</title>
<style>
  :root{--bg:#f6f7f9;--card:#fff;--fg:#1a1a1a;--muted:#666;--line:#e6e8eb;--accent:#1a1a1a;--accent-fg:#fff}
  @media (prefers-color-scheme:dark){:root{--bg:#111315;--card:#1a1d20;--fg:#e8eaed;--muted:#9aa0a6;--line:#2a2e33;--accent:#e8eaed;--accent-fg:#111315}}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;
       background:var(--bg);color:var(--fg);
       font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,'PingFang SC','Microsoft YaHei',sans-serif}
  .card{width:100%;max-width:460px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:30px 26px}
  h1{font-size:19px;margin:0 0 14px;line-height:1.4}
  p{font-size:14px;line-height:1.8;color:var(--muted);margin:0 0 22px}
  a.btn{display:inline-block;background:var(--accent);color:var(--accent-fg);text-decoration:none;
        padding:11px 22px;border-radius:8px;font-size:14px;font-weight:600}
</style></head>
<body><div class="card">
  <h1>${m.title}</h1>
  <p>${m.body}</p>
  <a class="btn" href="${site}/subscribe">重新订阅</a>
</div></body></html>`,
    { status: m.code, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } }
  );
}

export async function onRequestGet({ request, env }) {
  const secret = (env && env.UNSUB_SECRET) || '';
  if (!secret) {
    console.error('UNSUB_SECRET 未配置：退订链接无法校验，请在 EdgeOne 项目环境变量里设置');
    return page(env, 'invalid');
  }

  const kv = getKV(env);
  if (!kv) {
    console.error('SUBS_KV 未绑定：请在 EdgeOne 项目 → KV 存储里绑定命名空间');
    return page(env, 'invalid');
  }

  const u = new URL(request.url);
  const email = String(u.searchParams.get('e') || '')
    .trim()
    .toLowerCase();
  const token = String(u.searchParams.get('t') || '')
    .trim()
    .toLowerCase();

  if (!email || email.length > MAX_EMAIL || !EMAIL_RE.test(email) || !TOKEN_RE.test(token)) {
    return page(env, 'invalid');
  }
  // 与 scripts/send.mjs 里的算法必须一致：sha256(email + ':' + secret)
  if (!safeEqual(await sha256Hex(email + ':' + secret), token)) return page(env, 'invalid');

  const sha = await sha256Hex(email);
  const existed = await kv.get(KEY_SUB + sha);
  await kv.delete(KEY_SUB + sha);
  await kv.delete(KEY_PEND + sha); // 万一他还在待确认状态，也一并清掉

  return page(env, existed ? 'ok' : 'already');
}
