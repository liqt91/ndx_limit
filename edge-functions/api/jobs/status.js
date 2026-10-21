// GET /api/jobs/status —— 只读：把 EdgeOne 调度层（dispatch 这一跳）的状态暴露给
// 轻量云上的运维面板（只听 127.0.0.1，SSH 隧道访问）聚合展示。
//
// 为什么单独一个端点：crontab 退役后，「今天调度到底触没触发」只存在于 EdgeOne 侧
// （KV 每日闸 + 事件流水），服务器本地再也没有日志可看。面板打这个端点补上视野。
//
// 无鉴权：只暴露「今天两跳各触发没有、最近 50 条事件、告警邮件发没发、关键环境变量
// 配没配」，不含任何 secret 值。这与首页公开信息同级， Scanner 扫到也没有可操作的
// 东西；要触发动作得去 POST /api/jobs/dispatch（那边有 nonce / CRON_SECRET / 每日闸）。
//
// 数据来源（全部 KV，与 dispatch.js 同一命名空间 SUBS_KV）：
//   job_sent_<job>_<CST日期>   每日闸 key，存在即「该任务今天已由调度触发且 GitHub 受理」
//   job_events                 事件流水数组（最新在前，≤50），dispatch.js 每次终态都写
//
// 注意：KV 最终一致性最长 60s，刚触发完立刻查可能查不到，属预期；面板 30s 轮询兜底。
// 本文件保持自包含（不 import dispatch.js）：边缘函数按入口独立打包，跨文件相对导入
// 能否被解析未经实测（见 docs/ops/edgeone-迁移.md 待验证清单），订阅链路同样是每个
// 文件各写一份小助手。

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

// CST（UTC+8）日历日，纯算术，构建机/运行时在任何时区都成立（与 dispatch.js 同款）。
function cstDate(now = Date.now()) {
  return new Date(now + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function getKV(env) {
  return globalThis.SUBS_KV ?? (env && env.SUBS_KV);
}

const JOBS = ['refresh', 'broadcast'];

export async function onRequestGet({ env }) {
  const kv = getKV(env);
  if (!kv) {
    // 与 dispatch 的 fail closed 同构：没有 KV 就说没有，不让面板把「看不见」当成「没触发」
    return json({ ok: false, error: 'kv_not_configured', hint: '绑定 SUBS_KV 命名空间' }, 500);
  }

  let events = [];
  try {
    const raw = await kv.get('job_events');
    if (raw) {
      events = JSON.parse(raw);
      if (!Array.isArray(events)) events = [];
    }
  } catch (e) {
    return json({ ok: false, error: 'kv_read_failed', detail: String((e && e.message) || e).slice(0, 200) }, 500);
  }

  const today = cstDate();
  const jobs = {};
  for (const job of JOBS) {
    let guard = null;
    try {
      guard = await kv.get(`job_sent_${job}_${today}`);
    } catch (e) {
      return json({ ok: false, error: 'kv_read_failed', detail: String((e && e.message) || e).slice(0, 200) }, 500);
    }
    let parsed = null;
    if (guard) {
      try {
        parsed = JSON.parse(guard);
      } catch {
        parsed = { at: String(guard) };
      }
    }
    jobs[job] = {
      dispatchedToday: !!guard,
      at: parsed && parsed.at ? parsed.at : null,
      via: parsed && parsed.via ? parsed.via : null,
      mode: parsed && parsed.mode ? parsed.mode : null,
    };
  }

  // 告警摘要：最近一条真发过告警的事件（alert 字段非空）。面板据此显示「告警渠道是否
  // 还活着」——dispatch 失败时唯一推给站长的手段就是它。
  let lastAlert = null;
  for (const e of events) {
    if (e && e.alert) {
      lastAlert = { at: e.at, job: e.job, status: e.status, alert: e.alert };
      break;
    }
  }

  return json({
    ok: true,
    cstToday: today,
    jobs,
    events: events.slice(0, 20),
    alerts: { last: lastAlert },
    // 只暴露「配没配」的布尔，不暴露值——面板要提醒的是「缺配置」，不需要知道内容。
    config: {
      ghToken: !!(env && env.GH_DISPATCH_TOKEN),
      cronSecret: !!(env && env.CRON_SECRET),
      alertEmail: !!(env && env.ALERT_EMAIL),
    },
  });
}

export async function onRequestPost() {
  return json({ ok: false, error: 'method_not_allowed', hint: '只读端点，用 GET' }, 405);
}
