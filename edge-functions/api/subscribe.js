// POST /api/subscribe —— 收订阅邮箱（跑在 EdgeOne 边缘节点，与站点同域）
//
// 为什么要有它：站点是纯静态的，收表单必须有个「能执行代码」的地方。之前用第三方
// 表单（Buttondown）导致国内打不开、且邮箱落在别人手里。这个函数让访客全程只访问
// qdii.liqt91.top：同域提交、原地成功、不跳转、不出现第三方品牌。
//
// 职责边界：只做「校验 → 去重 → 写 KV → （可选）发一封确认信」，然后立刻返回。
// 每天群发是长任务（要重试、要日志），交给 GitHub Actions 跑，见 scripts/send.mjs。
//
// 订阅偏好（indices）：请求体可直接带 { indices: ["纳斯达克100","标普500"] }。
//   KV 里存 {"email","indices","ts"}；**老记录是纯邮箱字符串，读时一律按「只订纳指」处理**
//   （2026-10-23 之前只有纳指日报，替用户补上标普500 等于替他做决定）。
//   已确认的邮箱再次提交：只做偏好合并（只增不减），不重发确认信——他已经确认过了。
//   两侧（这里与 scripts/broadcast-plan.mjs）的归一逻辑必须同语义，check-broadcast.mjs 会核。
//
// 双重确认（默认开启）：
//   1) 写入 pend_<sha>（待确认）与 tok_<token>（token → 邮箱的索引，供 /api/confirm 反查）
//   2) 调 Brevo 事务邮件 API 发一封确认信，链接指到本站 /api/confirm?t=<token>
//   3) 访客点链接 → confirm.js 把 pend_ 转成 sub_，subscribers.js 只返回 sub_
//   意义：别人无法拿你的邮箱「代填」让你收日报；打错的地址不会进名单（硬退信会毁
//   Brevo 对新域名的信誉）。
//
// 为什么发信走 API 而不是 SMTP：边缘函数 CPU 只有 200ms，但 fetch 是 I/O 不占 CPU，
// 一次事务邮件几十毫秒就返回。SMTP 握手在边缘运行时里没有可用实现。
//
// 部署前提（EdgeOne 控制台，一次性）：
//   1. 存储 → KV → 创建命名空间 → 绑定到本项目，变量名填 SUBS_KV
//   2. 项目 → 环境变量：
//        BREVO_API_KEY    Brevo → SMTP & API → API Keys
//        MAIL_FROM        digest@liqt91.top（必须是在 Brevo 里验证过的发信域名）
//        REQUIRE_CONFIRM  默认 true；填 false 退回「填了即入名单」的单确认
//        SITE_URL         默认 https://qdii.liqt91.top
//        ALLOWED_ORIGIN   默认 https://qdii.liqt91.top
//   3. 安全防护 → 加 1 条精确限频规则（免费版含 1 条），对 /api/subscribe 限 IP
//
// KV 最终一致性：写入后同节点立即可读，其它节点最长 60s 读到旧值。订阅是低频写，
// 去重偶尔漏判只会重复写同一个 key（幂等），无副作用。

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL = 254; // RFC 5321 上限
const MAX_BODY = 2048;

const KEY_SUB = 'sub_'; // 已确认名单（subscribers.js 只认这个前缀）
const KEY_PEND = 'pend_'; // 待确认
const KEY_TOK = 'tok_'; // token → 邮箱 索引，供 confirm.js 反查

// 指数白名单。★ 必须与 scripts/digest.mjs 的 INDEX_KEYS 逐字一致（顺序也一致）：
// 边缘函数是独立一份文件，import 不到仓库里的模块，只能靠 check-broadcast.mjs 比对字面量。
const INDEX_KEYS = ['纳斯达克100', '标普500'];
const LEGACY_INDEX = '纳斯达克100'; // 老记录（纯邮箱）只订过纳指

// 规整订阅偏好：保序、去重、丢掉认不出来的；一个都不认 → 用 fallback。
// 新提交（表单默认两个都勾着）fallback = 两个都要；老记录 fallback = 只有纳指。
function normalizeIndices(input, fallback = INDEX_KEYS) {
  const raw = Array.isArray(input) ? input : typeof input === 'string' ? input.split(/[,，、\s]+/) : [];
  const picked = INDEX_KEYS.filter((k) => raw.some((x) => String(x).trim() === k));
  return picked.length ? picked : [...fallback];
}

// 解析 KV 里的 sub_ 值：JSON（新）或纯邮箱（老）。
function parseSubValue(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return null;
  if (text.startsWith('{')) {
    try {
      const rec = JSON.parse(text);
      const email = String((rec && rec.email) || '').trim().toLowerCase();
      if (!email) return null;
      return { email, indices: normalizeIndices(rec.indices, [LEGACY_INDEX]) };
    } catch {
      return null;
    }
  }
  return { email: text.toLowerCase(), indices: [LEGACY_INDEX] };
}

const PENDING_TTL_MS = 24 * 3600 * 1000; // 确认链接有效期 1 天（confirm.js 必须一致）
const RESEND_COOLDOWN_MS = 10 * 60 * 1000; // 同一邮箱 10 分钟内不重复发信

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

// 默认开启双重确认；只有显式填 false/0/off/no 才退回单确认。
function confirmRequired(env) {
  const v = env && env.REQUIRE_CONFIRM;
  if (v == null || String(v).trim() === '') return true;
  return !/^(false|0|off|no)$/i.test(String(v).trim());
}

function newToken() {
  const b = new Uint8Array(24); // 192 bit，足够防猜
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

// "QDII 开门日报 <digest@liqt91.top>" 或裸地址，两种写法都接
function parseSender(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^(.*)<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim() || 'QDII 开门日报', email: m[2].trim() };
  return { name: 'QDII 开门日报', email: s };
}

function indicesText(indices) {
  return (indices || []).join(' 与 ');
}

function confirmationHtml(link, email, indices) {
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,'PingFang SC','Microsoft YaHei',sans-serif;color:#1a1a1a">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:10px;padding:28px 26px">
    <h1 style="font-size:17px;margin:0 0 14px">确认订阅 QDII 开门日报</h1>
    <p style="font-size:14px;line-height:1.75;margin:0 0 18px;color:#333">
      有人用这个地址订阅了 ${indicesText(indices)} 的场外申购额度日报（每天收盘前发一封）。如果是你本人操作，点下面的按钮完成确认。
    </p>
    <p style="margin:0 0 20px">
      <a href="${link}" style="display:inline-block;background:#1a1a1a;color:#fff;text-decoration:none;padding:11px 22px;border-radius:8px;font-size:14px">确认订阅</a>
    </p>
    <p style="font-size:12.5px;line-height:1.7;margin:0 0 10px;color:#666">
      链接 1 天内有效。如果按钮点不动，把下面这行复制到浏览器打开：<br>
      <span style="color:#0a58ca;word-break:break-all">${link}</span>
    </p>
    <p style="font-size:12.5px;line-height:1.7;margin:0;color:#666">
      不是你本人操作？直接忽略这封邮件即可，该地址不会被加入名单，也不会再收到任何推送。
    </p>
  </div>
  <p style="max-width:520px;margin:14px auto 0;text-align:center;font-size:11.5px;color:#999">
    本次确认请求发送至 ${email}
  </p>
</body></html>`;
}

async function sendConfirmation(env, email, token, indices) {
  const apiKey = env.BREVO_API_KEY;
  const sender = parseSender(env.MAIL_FROM);
  const site = String(env.SITE_URL || 'https://qdii.liqt91.top').replace(/\/+$/, '');
  const link = `${site}/api/confirm?t=${token}`;

  const r = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender,
      to: [{ email }],
      subject: '确认订阅：QDII 开门日报',
      htmlContent: confirmationHtml(link, email, indices),
      textContent: `确认订阅 QDII 开门日报（${indicesText(indices)}）\n\n请在浏览器打开下面的链接完成确认（1 天内有效）：\n${link}\n\n不是你本人操作？忽略这封邮件即可，该地址不会被加入名单。`,
      // 确认信属于事务邮件，带 List-Unsubscribe 反而容易被判为营销邮件的同类处理
      headers: { 'X-Entity-Ref-ID': token },
    }),
  });

  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new Error(`Brevo HTTP ${r.status} ${detail.slice(0, 200)}`);
  }
}

export async function onRequestPost({ request, env }) {
  const allowed = (env && env.ALLOWED_ORIGIN) || 'https://qdii.liqt91.top';
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

  // 订阅范围：缺省或全认不出来 → 两个都要（表单默认两个都勾着，前端没传就按默认走）。
  const indices = normalizeIndices(data && data.indices);

  const sha = await sha256Hex(email);
  const subKey = KEY_SUB + sha;
  const existingRaw = await kv.get(subKey);
  if (existingRaw) {
    // 已确认过的邮箱又提交了一次：只合并偏好（只增不减），绝不重发确认信。
    // 这是「我原来只订纳指，现在想加标普500」唯一的入口——如果他只能收到 duplicated，
    // 就再也没有办法自己改订阅范围了（退订重订要重走一遍确认，还丢历史）。
    const cur = parseSubValue(existingRaw) || { email, indices: [LEGACY_INDEX] };
    const merged = normalizeIndices([...cur.indices, ...indices], [LEGACY_INDEX]);
    const changed = merged.length !== cur.indices.length;
    if (changed) await kv.put(subKey, JSON.stringify({ email, indices: merged, ts: Date.now() }));
    return json({ ok: true, duplicated: true, updated: changed, indices: merged });
  }

  // 单确认：直接入名单（REQUIRE_CONFIRM=false 时的退路）
  if (!confirmRequired(env)) {
    await kv.put(subKey, JSON.stringify({ email, indices, ts: Date.now() }));
    return json({ ok: true, indices });
  }

  if (!env || !env.BREVO_API_KEY || !env.MAIL_FROM) {
    // 宁可报错也不静默降级成单确认：悄悄改行为比订阅失败更难排查
    console.error('REQUIRE_CONFIRM 已开启，但缺少 BREVO_API_KEY / MAIL_FROM，无法发确认信');
    return json({ ok: false, error: 'mailer_not_configured' }, 500);
  }

  const now = Date.now();
  const pendKey = KEY_PEND + sha;
  const pendRaw = await kv.get(pendKey);
  let pend = null;
  try {
    pend = pendRaw ? JSON.parse(pendRaw) : null;
  } catch {
    pend = null;
  }
  // 冷却期内重复提交：不重发，避免被人拿来对某个邮箱做「邮件轰炸」
  if (pend && typeof pend.ts === 'number' && now - pend.ts < RESEND_COOLDOWN_MS) {
    return json({ ok: true, pending: true, resent: false, indices: normalizeIndices(pend.indices, indices) });
  }

  const token = newToken();
  // 作废旧 token，否则同一邮箱会同时存在多个可用链接
  if (pend && typeof pend.token === 'string' && pend.token) await kv.delete(KEY_TOK + pend.token);

  // 偏好跟着 pend_ 走：确认时 confirm.js 从 tok_ 取，用完即写进 sub_。
  await kv.put(pendKey, JSON.stringify({ email, token, ts: now, indices }));
  await kv.put(KEY_TOK + token, JSON.stringify({ email, ts: now, indices }));

  try {
    await sendConfirmation(env, email, token, indices);
  } catch (e) {
    // 发不出去就把残留清掉，否则这个地址会被冷却期卡住、又没有可用链接
    await kv.delete(pendKey);
    await kv.delete(KEY_TOK + token);
    console.error('确认信发送失败：', e.message || e);
    return json({ ok: false, error: 'mail_failed' }, 502);
  }

  return json({ ok: true, pending: true, resent: true, indices, expiresIn: PENDING_TTL_MS / 1000 });
}
