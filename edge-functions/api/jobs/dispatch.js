// POST /api/jobs/dispatch —— 把「轻量云 crontab → gh-dispatch.sh → GitHub API」这一跳
// 搬到 EdgeOne 边缘函数（由 edgeone.json 的 schedules 定时触发，时区 Asia/Shanghai）。
// 整条数据链路自此不依赖任何自有服务器；服务器上只剩运维面板（只听回环）。
//
// 两种触发方式，面向不同调用方：
//   1) EdgeOne schedules：POST + payload { job, nonce }。schedule 不能带 Authorization
//      头，且 edgeone.json 在公开仓库里、放不下真 secret——nonce 只是防扫描的隐匿层，
//      不是鉴权。对它的实际约束是下面的「每日一次」KV 闸。
//   2) 面板 / curl / 当天重跑：body.cron_secret 或 Authorization: Bearer 带 CRON_SECRET
//      （只存在于 EdgeOne 控制台环境变量，不进仓库）。鉴权调用不受每日闸限制。
//
// 为什么未鉴权调用要加「每日一次」闸：nonce 在公开仓库里，理论上有人能照着触发一次
// broadcast。闸把未鉴权调用压成「每任务每天最多一次」，且只在 GitHub 真的受理（204）
// 后才落 key——失败重试不被卡。最坏情况从「随便刷」变成「当天提前发一封日报」。
// KV 最终一致性最长 60s，60s 内的连发理论上能漏过去一两次，可接受（见部署文档）。
//
// 告警：GitHub 侧非 204（PAT 过期、仓库/工作流名写错、网络不通）时，经 Brevo 事务
// 邮件 API 给站长发一封告警信。Server酱/飞书未开通，邮件是唯一零新增依赖的推送渠道，
// 与 /api/subscribe 复用同一套 BREVO_API_KEY / MAIL_FROM。告警尽力而为：配没配都
// 不影响 dispatch 本身的结果，响应里带 alert 字段说明发没发。
//
// 边界：本函数只对「dispatch 这一跳」负责。workflow 内部失败（抓取覆盖率不达标、
// 发信失败）仍由 GitHub 邮件通知——那是另一段，L2 把活搬进来后才由函数自己告警。
//
// 部署前提（EdgeOne 控制台，一次性，详见 docs/ops/edgeone-迁移.md）：
//   项目 → 环境变量：
//     GH_DISPATCH_TOKEN   细粒度 PAT（Actions: write），与服务器 /root/.gh_dispatch_token 同值
//     GH_REPO              默认 liqt91/ndx_limit
//     DISPATCH_NONCE       随机长字符串，必须与仓库 edgeone.json 里 payload.nonce 一致
//     CRON_SECRET          建议配置；面板/curl 鉴权用，配了才能当天重跑
//     ALERT_EMAIL          告警收件人（站长邮箱）
//     BREVO_API_KEY / MAIL_FROM   已存在（订阅链路在用）
//   KV：SUBS_KV 已绑定（订阅链路在用），本函数复用；key 前缀 job_ 与 sub_ 不冲突。

const JOBS = {
  refresh: { workflow: 'refresh.yml', inputs: {} },
  broadcast: { workflow: 'broadcast.yml', inputs: { mode: 'send' } },
};

const MAX_BODY = 4096;
const MODE_ALIAS = { send: 'send', dry: 'dry-run', 'dry-run': 'dry-run' };

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

// CST（UTC+8）日历日。不用 toLocaleDateString：边缘运行时不保证带中文区 ICU 数据，
// 本地时区也不可依赖；加 8 小时再取 UTC 日期是纯算术，构建机在哪都是 UTC 也成立。
function cstDate(now = Date.now()) {
  return new Date(now + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

// 变长比较会通过耗时泄露「对了多少字符」，先要求等长再逐位比。
function secretEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0) return false;
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// 绑定命名空间后 KV 是全局变量（与 subscribe.js 同款两种取法）。
function getKV(env) {
  return globalThis.SUBS_KV ?? (env && env.SUBS_KV);
}

// "纳指开门日报 <digest@liqt91.top>" 或裸地址，两种写法都接（与 subscribe.js 一致）。
function parseSender(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^(.*)<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim() || '纳指开门日报', email: m[2].trim() };
  return { name: '纳指开门日报', email: s };
}

function alertText(info) {
  return [
    `任务：${info.job}（${info.workflow}）`,
    `时间：${new Date().toISOString()}（CST ${cstDate()}）`,
    `GitHub 响应：HTTP ${info.status}`,
    info.detail ? `详情：${info.detail}` : null,
    info.hint ? `建议：${info.hint}` : null,
    '',
    '这一跳由 EdgeOne 边缘函数代发（原轻量云 crontab）。workflow 内部失败另有 GitHub 邮件，',
    '数据是否更新看首页「数据更新于」或 EdgeOne 日志分析。',
  ]
    .filter(Boolean)
    .join('\n');
}

async function sendAlert(env, info) {
  const to = env && env.ALERT_EMAIL;
  if (!env || !env.BREVO_API_KEY || !env.MAIL_FROM || !to) {
    // 不静默：日志里留全量现场，响应也会告诉调用方 alert=not_configured
    console.error('[dispatch] 告警未发送：缺 BREVO_API_KEY / MAIL_FROM / ALERT_EMAIL', JSON.stringify(info));
    return 'not_configured';
  }
  try {
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        sender: parseSender(env.MAIL_FROM),
        to: [{ email: to }],
        subject: `【ndx】dispatch 失败：${info.job} HTTP ${info.status}`,
        textContent: alertText(info),
        htmlContent: `<pre style="font-family:ui-monospace,monospace;font-size:13px;line-height:1.7;white-space:pre-wrap">${alertText(info)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')}</pre>`,
      }),
    });
    if (!r.ok) throw new Error(`Brevo HTTP ${r.status}`);
    console.log('[dispatch] 告警邮件已发送 →', to);
    return 'sent';
  } catch (e) {
    console.error('[dispatch] 告警邮件发送失败：', e.message || e);
    return 'failed';
  }
}

function hintFor(status) {
  if (status === 401)
    return 'PAT 可能已过期或权限不足。重新生成细粒度 PAT（Actions: write），同步更新两处：服务器 /root/.gh_dispatch_token 与 EdgeOne 控制台 GH_DISPATCH_TOKEN。';
  if (status === 404) return '仓库名或 workflow 文件名不对（检查 GH_REPO 与 JOBS 表）。';
  if (status === 422) return 'ref 或 inputs 不合法（分支名 / mode 取值）。';
  return '看 EdgeOne 日志分析与 GitHub Status 页确认。';
}

async function callGitHub(env, job, mode) {
  const spec = JOBS[job];
  const inputs = job === 'broadcast' ? { mode } : {};
  const body = Object.keys(inputs).length > 0 ? { ref: 'main', inputs } : { ref: 'main' };
  const url = `https://api.github.com/repos/${env.GH_REPO || 'liqt91/ndx_limit'}/actions/workflows/${spec.workflow}/dispatches`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return { spec, res, url, body };
}

export async function onRequestPost({ request, env }) {
  if (!env || !env.GH_DISPATCH_TOKEN) {
    console.error('[dispatch] GH_DISPATCH_TOKEN 未配置');
    return json({ ok: false, error: 'not_configured', hint: '在 EdgeOne 控制台项目环境变量里配置 GH_DISPATCH_TOKEN' }, 500);
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY) return json({ ok: false, error: 'too_large' }, 413);

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: 'bad_json' }, 400);
  }
  if (!data || typeof data !== 'object') return json({ ok: false, error: 'bad_body' }, 400);

  const job = data.job;
  if (!Object.prototype.hasOwnProperty.call(JOBS, job)) {
    return json({ ok: false, error: 'bad_job', hint: 'job 取值：refresh | broadcast' }, 400);
  }

  let mode = 'send';
  if (job === 'broadcast') {
    const m = data.mode == null ? 'send' : String(data.mode);
    if (!Object.prototype.hasOwnProperty.call(MODE_ALIAS, m)) {
      return json({ ok: false, error: 'bad_mode', hint: 'mode 取值：send | dry' }, 400);
    }
    mode = MODE_ALIAS[m];
  }

  const authHeader = request.headers.get('authorization') || '';
  const bearer = authHeader.replace(/^Bearer\s+/i, '');
  const authed =
    !!env.CRON_SECRET &&
    (secretEqual(data.cron_secret, env.CRON_SECRET) || secretEqual(bearer, env.CRON_SECRET));

  if (!authed && (!env.DISPATCH_NONCE || !secretEqual(data.nonce, env.DISPATCH_NONCE))) {
    console.error('[dispatch] 鉴权失败：nonce 不匹配且未提供有效 CRON_SECRET', JSON.stringify({ job }));
    return json({ ok: false, error: 'unauthorized' }, 401);
  }

  const kv = getKV(env);
  const guardKey = `job_sent_${job}_${cstDate()}`;
  if (!authed) {
    if (!kv) {
      // fail closed：没有闸就不能放未鉴权调用进来，而不是悄悄跳过
      console.error('[dispatch] SUBS_KV 未绑定，拒绝未鉴权调用（fail closed）');
      return json({ ok: false, error: 'guard_not_configured', hint: '绑定 SUBS_KV，或改用 CRON_SECRET 鉴权调用' }, 500);
    }
    const sent = await kv.get(guardKey);
    if (sent) {
      return json(
        {
          ok: false,
          error: 'already_triggered_today',
          job,
          date: cstDate(),
          hint: '未鉴权调用每任务每天仅一次；当天重跑请带 CRON_SECRET',
        },
        409
      );
    }
  }

  let out;
  try {
    out = await callGitHub(env, job, mode);
  } catch (e) {
    const detail = String((e && e.message) || e).slice(0, 300);
    const hint = 'EdgeOne 出口到 api.github.com 不通？先用探针函数验证（见部署文档冒烟清单）。';
    console.error('[dispatch] GitHub 请求异常：', detail);
    const alert = await sendAlert(env, {
      job,
      workflow: JOBS[job].workflow,
      status: 'network_error',
      detail,
      hint,
    });
    return json({ ok: false, error: 'dispatch_failed', detail, hint, alert }, 502);
  }

  if (out.res.status !== 204) {
    const detail = (await out.res.text().catch(() => '')).slice(0, 300);
    console.error('[dispatch] GitHub 非 204：', out.res.status, detail);
    const alert = await sendAlert(env, {
      job,
      workflow: JOBS[job].workflow,
      status: out.res.status,
      detail,
      hint: hintFor(out.res.status),
    });
    return json({ ok: false, error: 'github_error', status: out.res.status, detail, hint: hintFor(out.res.status), alert }, 502);
  }

  if (!authed) {
    try {
      // 只在 GitHub 真的受理后落闸；失败重试不被卡
      await kv.put(guardKey, JSON.stringify({ at: new Date().toISOString(), via: 'nonce', mode }));
    } catch (e) {
      // dispatch 已成功，落闸失败不能把成功报成失败；日志留痕，最坏是当天可多重跑一次
      console.error('[dispatch] 每日闸落 key 失败（dispatch 已成功）：', e.message || e);
    }
  }
  console.log(`[dispatch] ${job} → ${JOBS[job].workflow} HTTP 204（${authed ? 'CRON_SECRET 鉴权' : 'nonce，已记每日闸'}）`);
  return json({ ok: true, job, workflow: JOBS[job].workflow, mode: job === 'broadcast' ? mode : undefined, status: 204 });
}

export async function onRequestGet() {
  return json(
    { ok: false, error: 'method_not_allowed', hint: 'POST JSON：{ job: "refresh" | "broadcast", nonce }，或带 CRON_SECRET' },
    405
  );
}
