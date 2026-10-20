// GET /api/confirm?t=<token> —— 点确认信里的链接落到这里
//
// 一次点击完成三件事：把 pend_<sha> 转成 sub_<sha>（真正入名单）→ 返回一个「订阅成功」
// 的 HTML 页 → 保留 tok_ 索引，让重复点击能显示「已确认」而不是「链接无效」。
//
// 为什么不用 Astro 页面：确认必须带副作用（写 KV），静态页做不到；放在同一个边缘函数
// 里还能保证「点开链接」和「入名单」是原子的，不存在中间态。
//
// 为什么不用 token 换 email 再查 pend_：KV 只能按 key 精确取值，没法按 value 反查。
// 所以写入时额外存一条 tok_<token> → {email, ts} 索引，确认时 O(1) 反查。
//
// 失效的四种情况都返回可读的 HTML（不是 JSON）：访客是点邮件链接来的，看到 JSON
// 只会以为站点坏了。

const KEY_SUB = 'sub_';
const KEY_PEND = 'pend_';
const KEY_TOK = 'tok_';

const PENDING_TTL_MS = 24 * 3600 * 1000; // 与 subscribe.js 保持一致（1 天）
const TOKEN_RE = /^[a-f0-9]{48}$/;

function getKV(env) {
  return globalThis.SUBS_KV ?? (env && env.SUBS_KV);
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function siteUrl(env) {
  return String((env && env.SITE_URL) || 'https://ndx.liqt91.top').replace(/\/+$/, '');
}

// status: ok | already | expired | invalid
function page(env, status) {
  const site = siteUrl(env);
  const map = {
    ok: {
      code: 200,
      title: '订阅成功',
      body: '已经记下这个邮箱了。每天早上 8 点，日报会发到你的收件箱。<br>第一封如果没看到，先翻一下垃圾箱，并把发件人加进白名单——新域名会有个「养号」过程。',
    },
    already: {
      code: 200,
      title: '已经确认过了',
      body: '这个邮箱早就在名单里，不需要重复确认。<br>如果收不到日报，检查一下垃圾箱，或把发件人加进白名单。',
    },
    expired: {
      code: 410,
      title: '确认链接已过期',
      body: '这个链接超过 1 天了。回订阅页重新填一次邮箱，会收到新的确认信。',
    },
    invalid: {
      code: 404,
      title: '链接无效',
      body: '这个确认链接不存在，或者已经被新的请求替换掉了。<br>回订阅页重新填一次邮箱即可。',
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
  <a class="btn" href="${site}/">回首页看今天的数据 →</a>
</div></body></html>`,
    {
      status: m.code,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    }
  );
}

export async function onRequestGet({ request, env }) {
  const kv = getKV(env);
  if (!kv) {
    console.error('SUBS_KV 未绑定：请在 EdgeOne 项目 → KV 存储里绑定命名空间');
    return page(env, 'invalid');
  }

  const t = String(new URL(request.url).searchParams.get('t') || '').trim();
  if (!TOKEN_RE.test(t)) return page(env, 'invalid');

  const tokKey = KEY_TOK + t;
  const tokRaw = await kv.get(tokKey);
  if (!tokRaw) return page(env, 'invalid');

  let tok;
  try {
    tok = JSON.parse(tokRaw);
  } catch {
    return page(env, 'invalid');
  }

  const email = String((tok && tok.email) || '')
    .trim()
    .toLowerCase();
  const ts = Number((tok && tok.ts) || 0);
  if (!email || !ts) return page(env, 'invalid');

  const sha = await sha256Hex(email);
  const subKey = KEY_SUB + sha;

  // 已经确认过：直接告诉他，别报「链接无效」让人以为失败了
  if (await kv.get(subKey)) return page(env, 'already');

  if (Date.now() - ts > PENDING_TTL_MS) {
    await kv.delete(tokKey);
    await kv.delete(KEY_PEND + sha);
    return page(env, 'expired');
  }

  await kv.put(subKey, email);
  await kv.delete(KEY_PEND + sha);
  // 保留 tok_ 索引：再点一次能显示「已经确认过了」

  return page(env, 'ok');
}
