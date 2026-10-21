// POST /api/jobs/dispatch —— 把「轻量云 crontab → gh-dispatch.sh → GitHub API」这一跳
// 搬到 EdgeOne 边缘函数（由 edgeone.json 的 schedules 定时触发，时区 Asia/Shanghai）。
// 整条数据链路自此不依赖任何自有服务器；服务器上只剩运维面板（只听回环）。
//
// 两种触发方式，面向不同调用方：
//   1) EdgeOne schedules：POST + payload { job, nonce, slot|edition }。schedule 不能带
//      Authorization 头，且 edgeone.json 在公开仓库里、放不下真 secret——nonce 只是防扫描
//      的隐匿层，不是鉴权。对它的实际约束是下面的「每日一次」KV 闸。
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
  refresh: { workflow: 'refresh.yml' },
  broadcast: { workflow: 'broadcast.yml' },
};

const MAX_BODY = 4096;
const MODE_ALIAS = { send: 'send', dry: 'dry-run', 'dry-run': 'dry-run' };

// 时点（slot）：broadcast 用 payload.edition（早报 morning / 下午报 close），
// refresh 用 payload.slot（抓取时刻由 scrape.mjs 自己判定，这里只用于分闸）。
// 为什么键里必须带 slot：一天两抓两报（07:50/08:10 + 14:30/14:45），闸不按时点分键，
// 第二次调用会被 409 already_triggered_today 静默挡掉，下午报永远发不出去
// （2026-10-21《双时点抓取与下午报接入.md》第五节第 2 项）。
function resolveSlot(job, data) {
  if (job === 'broadcast') return data.edition === 'close' ? 'close' : 'morning';
  return data.slot === 'close' ? 'close' : 'morning';
}
// 调度事件流水：KV 单 key 存数组，最新在前，最多 50 条。给 /api/jobs/status（运维
// 面板聚合用）当数据源。读-改-写在最终一致性窗口内有丢更新风险，但本函数一天就
// 两三次调用，可接受；写失败绝不影响 dispatch 本身的结果。
const EVENTS_KEY = 'job_events';
const MAX_EVENTS = 50;

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

// 事件落流水（best-effort）：面板的「调度」卡片完全靠它，写不进去也只是监控降级，
// 不能把一次成功的 dispatch 报成失败。
async function recordEvent(kv, evt) {
  if (!kv) return;
  try {
    let arr = [];
    const raw = await kv.get(EVENTS_KEY);
    if (raw) {
      try {
        arr = JSON.parse(raw);
      } catch {
        arr = [];
      }
      if (!Array.isArray(arr)) arr = [];
    }
    arr.unshift(evt);
    if (arr.length > MAX_EVENTS) arr = arr.slice(0, MAX_EVENTS);
    await kv.put(EVENTS_KEY, JSON.stringify(arr));
  } catch (e) {
    console.error('[dispatch] 事件流水写入失败（不影响本次结果）：', e.message || e);
  }
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
    `时点：${info.slot === 'close' ? '收盘前 close' : '早间 morning'}`,
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
  if (status === 422) return 'ref 或 inputs 不合法（分支名 / mode / edition 取值；edition 需 broadcast.yml 已声明该 input）。';
  return '看 EdgeOne 日志分析与 GitHub Status 页确认。';
}

async function callGitHub(env, job, mode, slot) {
  const spec = JOBS[job];
  // workflow_dispatch 的 inputs 只认已声明的 input：broadcast.yml 必须已声明 edition，
  // 否则这里透传会被 GitHub 以 422 拒掉（两处必须一起上线，见迁移文档第五节第 3 项）。
  const inputs = job === 'broadcast' ? { mode, edition: slot } : {};
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
  const slot = resolveSlot(job, data);

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
    console.error('[dispatch] 鉴权失败：nonce 不匹配且未提供有效 CRON_SECRET', JSON.stringify({ job, slot }));
    await recordEvent(getKV(env), {
      at: new Date().toISOString(),
      job,
      slot,
      mode: job === 'broadcast' ? mode : null,
      via: 'anonymous',
      status: 401,
      ok: false,
      error: 'unauthorized',
      alert: null,
    });
    return json({ ok: false, error: 'unauthorized' }, 401);
  }

  const kv = getKV(env);
  const guardKey = `job_sent_${job}_${slot}_${cstDate()}`;
  if (!authed) {
    if (!kv) {
      // fail closed：没有闸就不能放未鉴权调用进来，而不是悄悄跳过
      console.error('[dispatch] SUBS_KV 未绑定，拒绝未鉴权调用（fail closed）');
      return json({ ok: false, error: 'guard_not_configured', hint: '绑定 SUBS_KV，或改用 CRON_SECRET 鉴权调用' }, 500);
    }
    const sent = await kv.get(guardKey);
    if (sent) {
      await recordEvent(kv, {
        at: new Date().toISOString(),
        job,
        slot,
        mode: job === 'broadcast' ? mode : null,
        via: 'nonce',
        status: 409,
        ok: false,
        error: 'already_triggered_today',
        alert: null,
      });
      return json(
        {
          ok: false,
          error: 'already_triggered_today',
          job,
          slot,
          date: cstDate(),
          hint: '未鉴权调用每任务每天每时点仅一次；当天重跑请带 CRON_SECRET',
        },
        409
      );
    }
  }

  let out;
  try {
    out = await callGitHub(env, job, mode, slot);
  } catch (e) {
    const detail = String((e && e.message) || e).slice(0, 300);
    const hint = 'EdgeOne 出口到 api.github.com 不通？先用探针函数验证（见部署文档冒烟清单）。';
    console.error('[dispatch] GitHub 请求异常：', detail);
    const alert = await sendAlert(env, {
      job,
      slot,
      workflow: JOBS[job].workflow,
      status: 'network_error',
      detail,
      hint,
    });
    await recordEvent(getKV(env), {
      at: new Date().toISOString(),
      job,
      slot,
      mode: job === 'broadcast' ? mode : null,
      via: authed ? 'cron_secret' : 'nonce',
      status: null,
      ok: false,
      error: 'network_error',
      alert,
    });
    return json({ ok: false, error: 'dispatch_failed', detail, hint, alert }, 502);
  }

  if (out.res.status !== 204) {
    const detail = (await out.res.text().catch(() => '')).slice(0, 300);
    console.error('[dispatch] GitHub 非 204：', out.res.status, detail);
    const alert = await sendAlert(env, {
      job,
      slot,
      workflow: JOBS[job].workflow,
      status: out.res.status,
      detail,
      hint: hintFor(out.res.status),
    });
    await recordEvent(getKV(env), {
      at: new Date().toISOString(),
      job,
      slot,
      mode: job === 'broadcast' ? mode : null,
      via: authed ? 'cron_secret' : 'nonce',
      status: out.res.status,
      ok: false,
      error: 'github_error',
      alert,
    });
    return json({ ok: false, error: 'github_error', status: out.res.status, detail, hint: hintFor(out.res.status), alert }, 502);
  }

  if (!authed) {
    try {
      // 只在 GitHub 真的受理后落闸；失败重试不被卡
      await kv.put(guardKey, JSON.stringify({ at: new Date().toISOString(), via: 'nonce', mode, slot }));
    } catch (e) {
      // dispatch 已成功，落闸失败不能把成功报成失败；日志留痕，最坏是当天可多重跑一次
      console.error('[dispatch] 每日闸落 key 失败（dispatch 已成功）：', e.message || e);
    }
  }
  console.log(`[dispatch] ${job}/${slot} → ${JOBS[job].workflow} HTTP 204（${authed ? 'CRON_SECRET 鉴权' : 'nonce，已记每日闸'}）`);
  await recordEvent(getKV(env), {
    at: new Date().toISOString(),
    job,
    slot,
    mode: job === 'broadcast' ? mode : null,
    via: authed ? 'cron_secret' : 'nonce',
    status: 204,
    ok: true,
    error: null,
    alert: null,
  });
  return json({ ok: true, job, slot, workflow: JOBS[job].workflow, mode: job === 'broadcast' ? mode : undefined, status: 204 });
}

export async function onRequestGet() {
  return json(
    { ok: false, error: 'method_not_allowed', hint: 'POST JSON：{ job: "refresh" | "broadcast", nonce }，或带 CRON_SECRET' },
    405
  );
}
