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
// 为什么未鉴权调用要加「每日每时点一次」闸：nonce 在公开仓库里，理论上有人能照着触发。
// 闸把未鉴权调用压成「每个 job×slot 每天最多一次」，且只在 GitHub 真的受理（204）后才
// 落 key——失败重试不被卡。KV 最终一致性最长 60s，60s 内的连发理论上能漏过去一两次，
// 可接受（见部署文档）。
//
// 能不能彻底防刷？**不能**，只要 payload 必须写在公开仓库里，nonce 就不是秘密。所以这里
// 不追求「挡住」，而是把最坏后果压到可接受，并保证监控不被噪声挤掉：
//   · 越权组合 403 —— 未鉴权只许调度表里真实存在的 job×slot，堵掉「凭空多发一封信」；
//   · 每时点闸 409 —— 同一天同一个动作最多生效一次，堵掉「刷 N 次发 N 封」；
//   · 拒绝计数 —— 401/403/409/400 不写 50 条的事件流水，只累加次数（否则几十次无效
//     请求就能把面板的视野灌满，「被刷」的真实伤害是被刷到看不见真实状态）；
//   · 剩余风险由下游门禁兜底 —— broadcast 前有 check-freshness：数据不是今天的直接
//     exit 2 一封不发。所以即便被抢跑，也只会「当天那封日报早发几小时」，不会发错数据。
//   要根治只有一条路：把 payload（含 nonce）移出公开仓库，改在 EdgeOne 控制台配置
//   schedule——那要等控制台是否能可视化配 payload 验证过（见迁移文档待验证清单）。
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

// 时点（slot）：broadcast 用 payload.edition（收盘前报 close / 盘前报 morning），
// refresh 用 payload.slot（抓取时刻由 scrape.mjs 自己判定，这里只用于分闸）。
// 为什么键里必须带 slot：一天多抓一报（07:50 / 09:40 / 14:30 + 14:45），闸不按时点分键，
// 第二次调用会被 409 already_triggered_today 静默挡掉，后面的抓取永远发不出去
// （2026-10-21《双时点抓取与下午报接入.md》第五节第 2 项）。
//
// 09:40 这一抓（slot=intraday）的理由：07:50 偏早、单向少报——当日额度调整公告多在
// 07:51 之后发布，早间那一抓会漏掉（2026-10-21 实测 56 份额漏 2 个，而全天平均只变 1.3 个）。
// 盘中额度本身几乎不动，所以这一抓的价值在覆盖早盘公告窗口，不是追波动。
const REFRESH_SLOTS = ['preopen', 'intraday', 'close'];
// 生产只有一个：close（14:45 收盘前报）。morning 是盘前报，保留给人工补发，调度表里没有它。
const BROADCAST_SLOTS = ['morning', 'close'];

// 调度表里真实存在的 job×slot 组合（必须与 edgeone.json 的 schedules 一致）：
// 未鉴权调用只许这些组合。否则匿名者可以凭空造出调度表里没有的动作——最典型的就是
// 用 edition=morning 发一封「盘前报」：它的 schedule 已经下线，可闸键还在，
// 白白多给所有订阅者多发一封信。
const SCHEDULED = {
  refresh: ['preopen', 'intraday', 'close'],
  broadcast: ['close'],
};

// 显式校验，不做「认不出来就当默认值」的静默归一：slot 写错（paylaod 手抖、旧文档照抄）
// 若被静默归到 preopen，后果是这个时点被前面那次占掉、整天静默少抓一次，
// 正是上一版踩过的坑。认不出来就 400，让它在拒绝计数里露头。
function resolveSlot(job, data) {
  const raw = job === 'broadcast' ? data.edition : data.slot;
  const list = job === 'broadcast' ? BROADCAST_SLOTS : REFRESH_SLOTS;
  if (raw == null || raw === '') return { slot: job === 'broadcast' ? 'close' : 'preopen' };
  const s = String(raw);
  if (!list.includes(s)) return { error: 'bad_slot', slot: s, hint: `${job} 的 slot 取值：${list.join(' | ')}` };
  return { slot: s };
}
// 调度事件流水：KV 单 key 存数组，最新在前，最多 50 条。给 /api/jobs/status（运维
// 面板聚合用）当数据源。读-改-写在最终一致性窗口内有丢更新风险，但**只有真正走到
// GitHub 的业务终态才写这里**（每天 ≤4 条），可接受；写失败绝不影响 dispatch 本身的结果。
const EVENTS_KEY = 'job_events';
const MAX_EVENTS = 50;

// 被拒计数：未鉴权 401 / 越权组合 403 / 每日闸拦截 409 / 参数错 400 一律**不写事件流水**，
// 只把当天的次数与最后一次原因累加进一个 key。
// 为什么这么改：流水只有 50 条，而这个端点在公网上、nonce 又在公开仓库里，
// 谁都能照着 POST。以前每次 401 都写一条事件，几十次无效请求就能把流水灌满，
// 面板上的「今天四跳到底触没触发」直接失真——**监控被噪声挤掉比被刷本身的危害更大**。
// 现在流水里只剩真正走到 GitHub 的业务终态（每天 ≤4 条），拒绝证据仍在计数里看得见。
const REJECTED_PREFIX = 'job_rejected_';

async function bumpRejected(kv, info) {
  if (!kv) return;
  const key = `${REJECTED_PREFIX}${cstDate()}`;
  try {
    let cur = null;
    const raw = await kv.get(key);
    if (raw) {
      try {
        cur = JSON.parse(raw);
      } catch {
        cur = null;
      }
    }
    const now = new Date().toISOString();
    await kv.put(
      key,
      JSON.stringify({
        n: (cur && Number.isFinite(cur.n) ? cur.n : 0) + 1,
        first: (cur && cur.first) || now,
        last: now,
        lastError: info.error,
        lastStatus: info.status,
        lastJob: info.job || null,
        lastSlot: info.slot || null,
      })
    );
  } catch (e) {
    // 计数失败不影响响应：它是监控辅助，不是业务结果
    console.error('[dispatch] 拒绝计数写入失败：', e.message || e);
  }
}

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

// "QDII 开门日报 <digest@liqt91.top>" 或裸地址，两种写法都接（与 subscribe.js 一致）。
function parseSender(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^(.*)<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim() || 'QDII 开门日报', email: m[2].trim() };
  return { name: 'QDII 开门日报', email: s };
}

// 时点中文名按 job×slot 给全：刷新的 preopen/intraday/close 与群发的 close/morning 同名不同义，
// 只按 slot 判会让「07:50 盘前抓取失败」的告警写成「早间 morning」，运维看过去不知道该重跑哪一跳。
const SLOT_CN = {
  'refresh:preopen': '盘前抓取 preopen',
  'refresh:intraday': '早盘抓取 intraday',
  'refresh:close': '收盘前抓取 close',
  'broadcast:close': '收盘前报 close',
  'broadcast:morning': '盘前报 morning',
};

function alertText(info) {
  return [
    `任务：${info.job}（${info.workflow}）`,
    `时点：${SLOT_CN[`${info.job}:${info.slot}`] || info.slot || '(缺)'}`,
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
  const rs = resolveSlot(job, data);
  if (rs.error) {
    // 参数错不写流水（同「被拒」口径：任何人都能构造，写进去就是灌流水）
    await bumpRejected(getKV(env), { job, slot: rs.slot, error: rs.error, status: 400 });
    return json({ ok: false, error: rs.error, job, slot: rs.slot, hint: rs.hint }, 400);
  }
  const slot = rs.slot;

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
    await bumpRejected(getKV(env), { job, slot, error: 'unauthorized', status: 401 });
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
    // 未鉴权只许调度表里真实存在的组合：闸键只挡「同一动作重复」，挡不住「多出一个动作」。
    // 盘前报 schedule 已下线而 broadcast/morning 的闸键还在——不挡的话匿名者能凭空多发一封信。
    if (!SCHEDULED[job].includes(slot)) {
      console.error('[dispatch] 越权组合（不在调度表内）：', JSON.stringify({ job, slot }));
      await bumpRejected(kv, { job, slot, error: 'slot_not_scheduled', status: 403 });
      return json(
        {
          ok: false,
          error: 'slot_not_scheduled',
          job,
          slot,
          hint: `未鉴权调用只接受调度表内的组合：${Object.keys(SCHEDULED)
            .map((k) => `${k}(${SCHEDULED[k].join('/')})`)
            .join('、')}；其他组合请带 CRON_SECRET`,
        },
        403
      );
    }
    const sent = await kv.get(guardKey);
    if (sent) {
      await bumpRejected(kv, { job, slot, error: 'already_triggered_today', status: 409 });
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
