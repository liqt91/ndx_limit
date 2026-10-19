// POST /api/subscribe —— 收订阅邮箱（跑在 EdgeOne 边缘节点，与站点同域）
//
// 为什么要有它：站点是纯静态的，收表单必须有个「能执行代码」的地方。之前用第三方
// 表单（Buttondown）导致国内打不开、且邮箱落在别人手里。这个函数让访客全程只访问
// ndx.liqt91.top：同域提交、原地成功、不跳转、不出现第三方品牌。
//
// 职责边界：只做「校验 → 去重 → 写入 KV」，然后立刻返回。**不发信**。
// 发信是长任务（要重试、要日志），交给 GitHub Actions 每天跑，见 scripts/send.mjs。
//
// 部署前提（EdgeOne 控制台，一次性）：
//   1. 存储 → KV → 创建命名空间 → 绑定到本项目，变量名填 SUBS_KV
//   2. 项目 → 环境变量 → 可选 ALLOWED_ORIGIN（默认 https://ndx.liqt91.top）
//   3. 安全防护 → 加 1 条精确限频规则（免费版含 1 条），对 /api/subscribe 限 IP
//
// KV 最终一致性：写入后同节点立即可读，其它节点最长 60s 读到旧值。订阅是低频写，
// 去重偶尔漏判只会重复写同一个 key（幂等），无副作用。

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL = 254; // RFC 5321 上限
const MAX_BODY = 2048;
const KEY_PREFIX = 'sub_'; // KV key 只允许数字/字母/下划线

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 绑定命名空间后 KV 是全局变量（官方示例即 my_kv.get(...)），这里两种取法都兼容。
function getKV(env) {
  return globalThis.SUBS_KV ?? (env && env.SUBS_KV);
}

export async function onRequestPost({ request, env }) {
  const allowed = (env && env.ALLOWED_ORIGIN) || 'https://ndx.liqt91.top';
  const origin = request.headers.get('origin') || '';
  // 浏览器同源 POST 会带 Origin；带了对不上就拒绝。缺失 Origin（curl/服务端）放行，
  // 真正的防刷靠蜜罐 + 控制台限频。
  if (origin && origin !== allowed) return json({ ok: false, error: 'bad_origin' }, 403);

  const raw = await request.text();
  if (raw.length > MAX_BODY) return json({ ok: false, error: 'too_large' }, 413);

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: 'bad_json' }, 400);
  }

  // 蜜罐字段：CSS 隐藏 + 不给 tab 焦点，正常人填不到。被填即机器人，
  // 假装成功以免对方换策略。
  if (data && typeof data.trap === 'string' && data.trap.trim() !== '') return json({ ok: true });

  const email = String((data && data.email) || '')
    .trim()
    .toLowerCase();
  if (!email || email.length > MAX_EMAIL || !EMAIL_RE.test(email)) {
    return json({ ok: false, error: 'bad_email' }, 400);
  }

  const kv = getKV(env);
  if (!kv) {
    console.error('SUBS_KV 未绑定：请在 EdgeOne 项目 → KV 存储里绑定命名空间');
    return json({ ok: false, error: 'not_configured' }, 500);
  }

  const key = KEY_PREFIX + (await sha256Hex(email));
  const exists = await kv.get(key);
  if (exists) return json({ ok: true, duplicated: true });

  await kv.put(key, email);
  return json({ ok: true });
}
