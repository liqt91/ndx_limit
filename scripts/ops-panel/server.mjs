#!/usr/bin/env node
// qdii_limit 运维面板 —— 聚合「定时触发 → workflow → 数据/站点/订阅」全链路状态，可手动触发。
//
// 安全模型（改代码前先读）：
//   * 默认只听 127.0.0.1:8780，访问靠 SSH 隧道，不进公网。启动时校验监听地址，
//     只放行回环与 Tailscale 段（100.x），其它一律拒绝启动（exit 3）——防误配成 0.0.0.0。
//   * 面板无登录态：能连上 127.0.0.1:8780，说明流量已经过了 SSH 这一关。
//   * broadcast 真发信必须二次确认（confirm=send），防误触群发。
//   * 所有面板触发写审计日志（AUDIT_LOG），手动发信可追溯。
//
// 零依赖：只用 Node 内置模块。要求 Node >= 18（fetch / AbortSignal.timeout）。
//
// 用法：
//   node scripts/ops-panel/server.mjs                # 默认 127.0.0.1:8780
//   PANEL_PORT=9000 node scripts/ops-panel/server.mjs
//
// 配置项、部署与访问方式见 docs/ops/管理面板.md。
// 冒烟测试（零外部网络）：node scripts/ops-panel/smoke.mjs

import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, appendFileSync } from 'node:fs';

// ---------------------------------------------------------------- 配置

function readSecret(file, envVar) {
  if (process.env[envVar]) return process.env[envVar].trim();
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

const CFG = {
  host: process.env.PANEL_HOST || '127.0.0.1',
  port: Number(process.env.PANEL_PORT || 8780),
  repo: process.env.REPO || 'liqt91/qdii_limit',
  ghApiBase: (process.env.GH_API_BASE || 'https://api.github.com').replace(/\/+$/, ''),
  rawBase: (
    process.env.RAW_BASE ||
    `https://raw.githubusercontent.com/${process.env.REPO || 'liqt91/qdii_limit'}/main`
  ).replace(/\/+$/, ''),
  siteOrigin: (process.env.SITE_ORIGIN || 'https://qdii.liqt91.top').replace(/\/+$/, ''),
  // EdgeOne 调度层（2026-10-21 起主触发路径）：status 只读端点 + 手动触发走的
  // CRON_SECRET。manual 优先走 EO 端点——服务器上的 PAT 过期不影响面板能触发，
  // 每次点击还顺带验证 EO 这条路径是活的。
  eoStatusUrl: (process.env.EO_STATUS_URL || `${process.env.SITE_ORIGIN || 'https://qdii.liqt91.top'}/api/jobs/status`).replace(/\/+$/, ''),
  eoCronSecret: readSecret(process.env.EO_CRON_SECRET_FILE || '/root/.eo_cron_secret', 'EO_CRON_SECRET'),
  dispatchVia: process.env.DISPATCH_VIA || 'auto',
  dispatchScript: process.env.DISPATCH_SCRIPT || '/usr/local/bin/gh-dispatch.sh',
  dispatchLog: process.env.DISPATCH_LOG || '/var/log/gh-dispatch.log',
  auditLog: process.env.AUDIT_LOG || '/var/log/ops-panel-audit.log',
  tokenMeta: process.env.TOKEN_META || '/root/.gh_dispatch_token.meta.json',
  ghToken: readSecret(process.env.GH_DISPATCH_TOKEN_FILE || '/root/.gh_dispatch_token', 'GH_DISPATCH_TOKEN'),
  subsToken: readSecret(process.env.SUBSCRIBERS_TOKEN_FILE || '/root/.subs_token', 'SUBSCRIBERS_TOKEN'),
};

// 监听地址守卫：只放行回环与 Tailscale CGNAT 段。宁可起不来，也不误暴露到公网。
function hostAllowed(h) {
  if (h === '127.0.0.1' || h === '::1' || h === 'localhost') return true;
  return /^100\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}
if (!hostAllowed(CFG.host)) {
  console.error(
    `拒绝启动：PANEL_HOST=${CFG.host} 不在放行范围。面板只允许监听回环（127.0.0.1/::1）` +
      '或 Tailscale 段（100.x）；公网访问请走 SSH 隧道，不要把面板暴露出去。'
  );
  process.exit(3);
}

// ---------------------------------------------------------------- 时间助手（一律按北京 UTC+8 显式计算）

function cstParts(instant) {
  const d = new Date((instant == null ? Date.now() : instant) + 8 * 3600e3);
  const iso = d.toISOString();
  return {
    date: iso.slice(0, 10),
    time: iso.slice(11, 19),
    minutes: Number(iso.slice(11, 13)) * 60 + Number(iso.slice(14, 16)),
  };
}
const cstToday = () => cstParts().date;

function ageLabel(iso) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  const ms = Date.now() - t;
  if (ms < 60000) return '刚刚';
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

// ---------------------------------------------------------------- 数据采集

async function fetchJson(url, opts = {}) {
  const r = await fetch(url, { signal: AbortSignal.timeout(15000), ...opts });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
}

function ghHeaders() {
  return {
    authorization: `Bearer ${CFG.ghToken}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'ndx-ops-panel',
  };
}

function mapRun(r) {
  const start = new Date(r.run_started_at || r.created_at).getTime();
  const end = r.status === 'completed' ? new Date(r.updated_at).getTime() : NaN;
  return {
    id: r.id,
    event: r.event,
    status: r.status,
    conclusion: r.conclusion,
    startedAt: r.run_started_at || r.created_at,
    durationSec: Number.isFinite(end - start) ? Math.round((end - start) / 1000) : null,
    htmlUrl: r.html_url,
  };
}

async function collectRuns() {
  if (!CFG.ghToken) {
    return { error: 'no_token', hint: '未配置 GH_DISPATCH_TOKEN，workflow 状态不可见（dispatch 仍可触发）' };
  }
  const out = {};
  for (const [wf, key] of [['refresh.yml', 'refresh'], ['broadcast.yml', 'broadcast']]) {
    try {
      const j = await fetchJson(
        `${CFG.ghApiBase}/repos/${CFG.repo}/actions/workflows/${wf}/runs?per_page=3`,
        { headers: ghHeaders() }
      );
      out[key] = (j.workflow_runs || []).map(mapRun);
    } catch (e) {
      out[key] = { error: String(e.message || e) };
    }
  }
  return out;
}

async function collectData() {
  const base = { lastDataCommit: null };
  try {
    const m = await fetchJson(`${CFG.rawBase}/data/fetch-meta.json`);
    base.date = m.date;
    base.fetchedAt = m.fetchedAt;
    base.isToday = m.date === cstToday();
    base.ageLabel = ageLabel(m.fetchedAt);
  } catch (e) {
    base.error = String(e.message || e);
  }
  if (CFG.ghToken) {
    try {
      const j = await fetchJson(
        `${CFG.ghApiBase}/repos/${CFG.repo}/commits?path=data%2Ffetch-meta.json&per_page=1`,
        { headers: ghHeaders() }
      );
      const c = (j || [])[0];
      if (c) {
        base.lastDataCommit = {
          at: c.commit.committer.date,
          message: String(c.commit.message).split('\n')[0],
          htmlUrl: c.html_url,
        };
      }
    } catch {
      /* 最近数据 commit 只是锦上添花，失败不记入 error */
    }
  }
  return base;
}

async function collectSubs() {
  if (!CFG.subsToken) return { state: 'unconfigured', hint: '未配置 SUBSCRIBERS_TOKEN，订阅数不可见' };
  try {
    const r = await fetch(`${CFG.siteOrigin}/api/subscribers`, {
      headers: { authorization: `Bearer ${CFG.subsToken}` },
      signal: AbortSignal.timeout(15000),
    });
    if (r.status === 401) return { error: 'token 无效（401），检查 EdgeOne 与两侧是否一致' };
    const j = await r.json();
    if (!j.ok) return { error: j.error || 'unknown' };
    return { count: j.count };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

function collectTokenMeta() {
  try {
    const m = JSON.parse(readFileSync(CFG.tokenMeta, 'utf8'));
    if (!m.expiresAt) return { state: 'unrecorded' };
    return {
      state: 'recorded',
      issuedAt: m.issuedAt || null,
      expiresAt: m.expiresAt,
      daysLeft: Math.ceil((new Date(m.expiresAt).getTime() - Date.now()) / 86400e3),
    };
  } catch {
    return { state: 'unrecorded', hint: `把 {issuedAt, expiresAt} 写进 ${CFG.tokenMeta} 可显示到期剩余天数` };
  }
}

// dispatch 日志行形如：2026-10-21T07:50:01Z refresh.yml -> HTTP 204
const DISPATCH_LINE_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)\s+(\S+)\s+->\s+HTTP\s+(\d{3})\s*$/;

function parseDispatchLog(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const m = DISPATCH_LINE_RE.exec(line.trim());
    if (!m) continue;
    const p = cstParts(new Date(m[1]).getTime());
    out.push({ atUtc: m[1], cstDate: p.date, cstTime: p.time, wf: m[2], code: Number(m[3]) });
  }
  return out;
}

// 一天四跳：盘前抓 07:50 → 早盘抓 09:40 → 收盘前抓 14:30 → 收盘前报 14:45（北京时间）。
// slot 与 dispatch.js 的 resolveSlot / KV 闸键一一对应：refresh 用 payload.slot、
// broadcast 用 payload.edition。
// ★ 07:50 与 09:40 都是 refresh，闸键必须靠 slot 区分（preopen / intraday）；
//   09:40 这一抓专为覆盖早盘公告窗口（07:51 之后才发的当日额度调整）。
// ★ 08:10 的早报已于 2026-10-21 下线，现在每天只发一封**收盘前报**（14:45，场外 15:00 截止前）。
//   别再把这一跳叫「下午报」或「早报」——名字错了，补发时就容易挑错 edition。
const SLOTS = [
  { job: 'refresh', wf: 'refresh.yml', hhmm: '07:50', slot: 'preopen', label: '盘前' },
  { job: 'refresh', wf: 'refresh.yml', hhmm: '09:40', slot: 'intraday', label: '早盘' },
  { job: 'refresh', wf: 'refresh.yml', hhmm: '14:30', slot: 'close', label: '收盘前' },
  { job: 'broadcast', wf: 'broadcast.yml', hhmm: '14:45', slot: 'close', label: '收盘前报' },
];
// 按 job 索引而不是按 slot 索引：close 同时属于 refresh 与 broadcast，
// 单靠 slot 名取不到唯一标签（以前 SLOT_LABEL[slot] 只够两槽用）。
const SLOT_LABEL = Object.fromEntries(SLOTS.map((s) => [`${s.job}:${s.slot}`, s.label]));
const slotLabel = (job, slot) => SLOT_LABEL[`${job}:${slot}`] || slot || '';
// 标签必须在服务端算好塞进 slot 对象：整页内联脚本是独立作用域，拿不到这里的常量
// （以前客户端直接写 SLOT_LABEL[sl.slot]，浏览器里是 ReferenceError，调度卡整块渲染不出来）。
function labelize(slots) {
  return slots.map((s) => ({ ...s, label: slotLabel(s.job, s.slot) }));
}
// 本地日志降级视图用：没有 slot 字段，只能按时刻落点归槽。
// 09:00 前算盘前、09:00–12:00 算早盘、12:00 之后算收盘前（broadcast 半分界在 12:00）。
const cstMinutes = (t) => Number(String(t).slice(0, 2)) * 60 + Number(String(t).slice(3, 5));
const SLOT_WINDOW = {
  'refresh:preopen': (m) => m < 9 * 60,
  'refresh:intraday': (m) => m >= 9 * 60 && m < 12 * 60,
  'refresh:close': (m) => m >= 12 * 60,
  'broadcast:morning': (m) => m < 12 * 60,
  'broadcast:close': (m) => m >= 12 * 60,
};

// EdgeOne 调度层状态（GET /api/jobs/status，只读、无鉴权）。拿不到不猜：
// 返回 { ok:false, error }，由 collectDispatch 决定回退到本地日志。
async function collectEO() {
  try {
    const j = await fetchJson(CFG.eoStatusUrl);
    if (!j || j.ok !== true) return { ok: false, error: (j && j.error) || 'bad_response' };
    return { ok: true, ...j };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// 本地 dispatch 日志（crontab 退役前的历史；也是 EO 端点不可达时的降级视图）。
// 退役后日志停更，所以只有 EO 不可达才会用它，且必须带 note 说明来源。
function collectLocalDispatch() {
  let text;
  try {
    text = readFileSync(CFG.dispatchLog, 'utf8');
  } catch {
    return null;
  }
  const entries = parseDispatchLog(text);
  if (entries.length === 0) return null;
  return entries;
}

function slotStateFromEO(eo, slot) {
  const j = (eo.jobs && eo.jobs[slot.job] && eo.jobs[slot.job][slot.slot]) || null;
  const expectedMin = Number(slot.hhmm.slice(0, 2)) * 60 + Number(slot.hhmm.slice(3));
  const pastDue = cstParts().minutes >= expectedMin;
  // 今天该任务该时点的事件：成功（204）算触发；502 级失败（GitHub 错/网络错）算失败；
  // 401/409 是扫描噪音和每日闸，只进事件流，不改变槽位结论。
  // 必须同时匹配 job 与 slot——否则 14:30 的 refresh 事件会把 07:50 的槽位也点亮。
  const todayEvt = (eo.events || []).find((e) => {
    if (!e || e.job !== slot.job || e.slot !== slot.slot) return false;
    const d = new Date(e.at).getTime();
    if (!Number.isFinite(d)) return false;
    return cstParts(d).date === eo.cstToday;
  });
  const hardFail = todayEvt && todayEvt.ok === false && todayEvt.error !== 'unauthorized' && todayEvt.error !== 'already_triggered_today';
  if (hardFail) {
    return { job: slot.job, wf: slot.wf, hhmm: slot.hhmm, slot: slot.slot, state: 'fail', at: cstParts(new Date(todayEvt.at).getTime()).time, code: todayEvt.status, via: todayEvt.via, note: todayEvt.error };
  }
  if (j && j.dispatchedToday) {
    return {
      job: slot.job,
      wf: slot.wf,
      hhmm: slot.hhmm,
      slot: slot.slot,
      state: 'ok',
      at: j.at ? cstParts(new Date(j.at).getTime()).time : null,
      code: 204,
      via: j.via,
      note: null,
    };
  }
  if (pastDue) return { job: slot.job, wf: slot.wf, hhmm: slot.hhmm, slot: slot.slot, state: 'missing', at: null, code: null, via: null, note: null };
  return { job: slot.job, wf: slot.wf, hhmm: slot.hhmm, slot: slot.slot, state: 'pending', at: null, code: null, via: null, note: null };
}

function slotStateFromLog(entry, slot) {
  // 本地日志没有 slot 字段（crontab 时代只记 wf 名），且退役后已停更：
  // 无条目的槽位记 unknown 而非 missing——「没有记录」不等于「没有触发」，
  // 降级视图不能假装给出坏消息；真要判 missing 是 EO 正版视图的职责。
  if (entry) return { job: slot.job, wf: slot.wf, hhmm: slot.hhmm, slot: slot.slot, state: entry.code === 204 ? 'ok' : 'fail', at: entry.cstTime, code: entry.code, via: 'cron', note: null };
  return { job: slot.job, wf: slot.wf, hhmm: slot.hhmm, slot: slot.slot, state: 'unknown', at: null, code: null, via: null, note: null };
}

// 调度卡片数据。EO 端点可达 → source='edgeone'（crontab 退役后的正版视图）；
// 不可达 → 回退本地日志（source='local-log'，退役后可能停在旧记录，必须带 note）；
// 两者皆无 → source='none'，槽位全 unknown，overall 至少 warn。
function collectDispatch(eo) {
  if (eo && eo.ok) {
    const slots = labelize(SLOTS.map((s) => slotStateFromEO(eo, s)));
    let state = 'ok';
    if (slots.some((s) => s.state === 'fail')) state = 'fail';
    else if (slots.some((s) => s.state === 'missing')) state = 'missing';
    const recent = (eo.events || []).slice(0, 6).map((e) => ({
      cstDate: Number.isFinite(new Date(e.at).getTime()) ? cstParts(new Date(e.at).getTime()).date : null,
      cstTime: Number.isFinite(new Date(e.at).getTime()) ? cstParts(new Date(e.at).getTime()).time : null,
      wf: e.job === 'broadcast' ? 'broadcast.yml' : 'refresh.yml',
      slot: e.slot || null,
      code: e.status,
      via: e.via,
      ok: e.ok,
      alert: e.alert,
    }));
    return { source: 'edgeone', state, slots, recent, alerts: eo.alerts || { last: null }, config: eo.config || null, rejected: eo.rejected || null, note: null };
  }
  const entries = collectLocalDispatch();
  if (entries) {
    const today = cstToday();
    const todayEntries = entries.filter((e) => e.cstDate === today);
    // 本地日志没有 slot 字段（crontab 时代只记 wf 名），按**落点时刻**归槽而不是按出现顺序：
    // 现在 refresh 有三个时点，顺序分配会把退役前 14:30 那条错标成「早盘」。
    // 退役后日志停更，降级视图本来就会停在旧记录，靠 note 告知，不装作是今天的成绩。
    const byJob = {};
    for (const e of todayEntries) {
      (byJob[e.wf] = byJob[e.wf] || []).push(e);
    }
    for (const k of Object.keys(byJob)) byJob[k].sort((a, b) => (a.atUtc < b.atUtc ? -1 : a.atUtc > b.atUtc ? 1 : 0));
    const slots = labelize(
      SLOTS.map((s) => {
        const win = SLOT_WINDOW[`${s.job}:${s.slot}`];
        const entry = (byJob[s.wf] || []).find((e) => win && win(cstMinutes(e.cstTime))) || null;
        return slotStateFromLog(entry, s);
      })
    );
    // 降级视图只把「日志证明的失败」升级为 fail；unknown 不参与汇总——
    // 它只表示「本地没留记录」，而 computeOverall 里 source!=='edgeone' 的 warn 已兜底。
    let state = 'ok';
    if (slots.some((s) => s.state === 'fail')) state = 'fail';
    return {
      source: 'local-log',
      state,
      slots,
      recent: entries.slice(-6).reverse().map((e) => ({ cstDate: e.cstDate, cstTime: e.cstTime, wf: e.wf, slot: null, code: e.code, via: 'cron', ok: e.code === 204, alert: null })),
      alerts: { last: null },
      config: null,
      rejected: null,
      note: `EdgeOne 状态端点不可达（${eo ? eo.error : '未查询'}）；已回退本地脚本日志。crontab 已退役，该日志可能停在退役前，仅作降级视图。`,
    };
  }
  return {
    source: 'none',
    state: 'unknown',
    slots: labelize(SLOTS.map((s) => ({ job: s.job, wf: s.wf, hhmm: s.hhmm, slot: s.slot, state: 'unknown', at: null, code: null, via: null, note: null }))),
    recent: [],
    alerts: { last: null },
    config: null,
    rejected: null,
    note: eo ? `EdgeOne 状态端点不可达（${eo.error}），本地也无 dispatch 日志。` : 'EdgeOne 状态端点未查询，本地无 dispatch 日志。',
  };
}

function computeOverall(s) {
  if (s.dispatch.state === 'fail' || s.dispatch.state === 'missing') return 'bad';
  if (s.runs && !s.runs.error) {
    for (const key of ['refresh', 'broadcast']) {
      const latest = Array.isArray(s.runs[key]) ? s.runs[key][0] : null;
      if (latest && latest.status === 'completed' && latest.conclusion !== 'success') return 'bad';
    }
  }
  if (s.dispatch.source !== 'edgeone') return 'warn';
  const lastAlert = s.dispatch.alerts && s.dispatch.alerts.last;
  if (lastAlert && lastAlert.alert !== 'sent') return 'warn';
  if (s.dispatch.config && s.dispatch.config.cronSecret === false) return 'warn';
  if (s.data && s.data.error === undefined && s.data.isToday === false) return 'warn';
  if (s.token && s.token.state === 'recorded' && s.token.daysLeft <= 30) return 'warn';
  if (s.subscribers && s.subscribers.error) return 'warn';
  if (s.runs && s.runs.error) return 'warn';
  return 'ok';
}

async function collectStatus() {
  const [runs, data, subscribers, eo] = await Promise.all([collectRuns(), collectData(), collectSubs(), collectEO()]);
  const s = {
    now: new Date().toISOString(),
    cstToday: cstToday(),
    cstClock: cstParts().time,
    dispatch: collectDispatch(eo),
    runs,
    data,
    subscribers,
    token: collectTokenMeta(),
    audit: readAudit(),
    busy: dispatchBusy,
  };
  s.overall = computeOverall(s);
  return s;
}

// ---------------------------------------------------------------- 手动触发

let dispatchBusy = false;

function runScript(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    // Windows 上 .cmd/.bat 必须经 shell 启动；Linux 直接执行 .sh（部署目标只有 Linux）。
    const child =
      process.platform === 'win32'
        ? spawn(cmd, args, { timeout: timeoutMs, shell: true })
        : spawn(cmd, args, { timeout: timeoutMs });
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.stderr.on('data', (d) => {
      out += d;
    });
    const finish = (code) => {
      if (!done) {
        done = true;
        resolve({ code, stdout: out, stderr: '' });
      }
    };
    child.on('error', (e) => finish(-1));
    child.on('close', (code) => finish(code == null ? -1 : code));
  });
}

function audit(rec) {
  try {
    appendFileSync(CFG.auditLog, `${JSON.stringify(rec)}\n`);
  } catch (e) {
    console.error('审计日志写入失败：', e.message);
  }
}

function readAudit() {
  try {
    const lines = readFileSync(CFG.auditLog, 'utf8')
      .split('\n')
      .filter(Boolean);
    return lines
      .slice(-8)
      .reverse()
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function validateDispatch(body) {
  if (!body || typeof body !== 'object') return { error: 'bad_request' };
  const job = String(body.job || '');
  if (job !== 'refresh' && job !== 'broadcast') return { error: 'bad_job' };
  const mode = body.mode === undefined ? 'send' : String(body.mode);
  if (job === 'broadcast' && mode !== 'dry-run' && mode !== 'send') return { error: 'bad_mode' };
  if (job === 'broadcast' && mode === 'send' && body.confirm !== 'send') {
    return { error: 'confirm_required', hint: '真发信需要二次确认：confirm=send' };
  }
  return { job, mode: job === 'refresh' ? null : mode };
}

async function runDispatch(job, mode) {
  if (dispatchBusy) return { ok: false, error: 'busy', hint: '已有一个触发在执行，稍后再试' };
  dispatchBusy = true;
  const startedAt = new Date();
  try {
    // 优先走 EdgeOne 端点（DISPATCH_VIA=local 可强制回退本地脚本）：
    // 服务器 PAT 过期不影响面板触发，且每次点击都是对 EO 调度路径的活体验证。
    if (CFG.eoCronSecret && CFG.dispatchVia !== 'local') {
      // 手动触发也带时点：按当前时刻就近落槽（与调度同款三分法），
      // refresh 有 preopen/intraday/close 三档，broadcast 只有 morning/close 两版。
      // 鉴权调用不受每日闸与组合白名单限制，这里传 slot/edition 是为了语义正确——
      // 12:00 之后手点 broadcast 发的应是收盘前报（close），不是盘前报重发。
      const mins = cstParts().minutes;
      const refreshSlot = mins >= 12 * 60 ? 'close' : mins >= 9 * 60 ? 'intraday' : 'preopen';
      const edition = mins >= 12 * 60 ? 'close' : 'morning';
      const r = await fetch(`${CFG.siteOrigin}/api/jobs/dispatch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          job,
          mode: job === 'broadcast' ? (mode === 'dry-run' ? 'dry' : 'send') : undefined,
          slot: job === 'refresh' ? refreshSlot : undefined,
          edition: job === 'broadcast' ? edition : undefined,
          cron_secret: CFG.eoCronSecret,
        }),
        signal: AbortSignal.timeout(90000),
      });
      const j = await r.json().catch(() => null);
      const ok = r.ok && !!j && j.ok === true;
      const output = JSON.stringify(j);
      audit({ at: startedAt.toISOString(), via: 'edgeone', job, mode, ok, exitCode: r.status, output: output.slice(0, 500) });
      return { ok, job, mode, exitCode: r.status, output: output.slice(0, 1000), at: startedAt.toISOString(), via: 'edgeone' };
    }
    const args = job === 'refresh' ? ['refresh'] : ['broadcast', mode === 'dry-run' ? 'dry' : 'send'];
    const res = await runScript(CFG.dispatchScript, args, 90000);
    const output = (res.stdout + res.stderr).trim();
    const ok = res.code === 0 && /HTTP 204/.test(output);
    audit({
      at: startedAt.toISOString(),
      via: 'panel',
      job,
      mode,
      ok,
      exitCode: res.code,
      output: output.slice(0, 500),
    });
    return {
      ok,
      job,
      mode,
      exitCode: res.code,
      output: output.slice(0, 1000),
      at: startedAt.toISOString(),
      via: 'script',
    };
  } finally {
    dispatchBusy = false;
  }
}

// ---------------------------------------------------------------- HTTP 服务

function json(res, body, status = 200) {
  const s = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(s);
}

function readBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(PAGE);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      json(res, await collectStatus());
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/dispatch') {
      let body;
      try {
        body = JSON.parse(await readBody(req) || '{}');
      } catch {
        json(res, { error: 'bad_json' }, 400);
        return;
      }
      const v = validateDispatch(body);
      if (v.error) {
        json(res, v, 400);
        return;
      }
      json(res, await runDispatch(v.job, v.mode));
      return;
    }
    json(res, { error: 'not_found' }, 404);
  } catch (e) {
    json(res, { error: 'internal', message: String(e.message || e) }, 500);
  }
});

server.listen(CFG.port, CFG.host, () => {
  console.log(`qdii_limit 运维面板：http://${CFG.host}:${CFG.port}（仅限本机/隧道访问，勿暴露公网）`);
  if (!CFG.ghToken) console.warn('提醒：未配置 GH_DISPATCH_TOKEN，workflow 运行状态将不可见');
  if (!CFG.subsToken) console.warn('提醒：未配置 SUBSCRIBERS_TOKEN，订阅数将不可见');
  if (!CFG.eoCronSecret) console.warn('提醒：未配置 EO_CRON_SECRET，手动触发将回退本地 gh-dispatch.sh（依赖服务器 PAT）');
});

// ---------------------------------------------------------------- 页面（静态，数据全靠 /api/status）

const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>qdii_limit 运维面板</title>
<style>
:root{--paper:#faf9f6;--surface:#fffefb;--ink:#14130f;--ink2:#56544b;--ink3:#767366;--rule:#e3e0d6;--rule2:#cfccc0;--ok:#2c6e4f;--warn:#8a6320;--bad:#a33a2f;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--paper);color:var(--ink);font:14px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;padding:24px;max-width:920px;margin:0 auto}
header{display:flex;align-items:center;gap:12px;border-bottom:1px solid var(--rule2);padding-bottom:12px;margin-bottom:16px;flex-wrap:wrap}
h1{font-size:15px;font-weight:500}
.pill{font-size:12px;padding:2px 10px;border:1px solid;border-radius:999px;font-family:var(--mono)}
.pill.ok{color:var(--ok);border-color:var(--ok)}
.pill.warn{color:var(--warn);border-color:var(--warn)}
.pill.bad{color:var(--bad);border-color:var(--bad)}
.clock{margin-left:auto;font-family:var(--mono);font-size:12px;color:var(--ink3)}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:720px){.grid{grid-template-columns:1fr}}
.card{border:1px solid var(--rule);background:var(--surface);padding:14px 16px}
.card h2{font-size:13px;font-weight:500;color:var(--ink2);margin-bottom:8px;display:flex;justify-content:space-between;gap:8px}
.row{display:flex;justify-content:space-between;gap:10px;padding:5px 0;border-top:1px solid var(--rule);font-size:13px}
.card .row:first-of-type{border-top:0}
.k{color:var(--ink2);white-space:nowrap}
.v{font-family:var(--mono);font-size:12px;text-align:right;word-break:break-all}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:1px}
.dot.ok{background:var(--ok)}.dot.warn{background:var(--warn)}.dot.bad{background:var(--bad)}
.dot.pending{background:var(--rule2)}.dot.unknown{background:var(--ink3)}
.log{font-family:var(--mono);font-size:11.5px;color:var(--ink2);white-space:pre-wrap;word-break:break-all;margin-top:8px;max-height:110px;overflow:auto}
.ops{margin-top:16px;border:1px solid var(--rule);background:var(--surface);padding:14px 16px}
.ops h2{font-size:13px;font-weight:500;color:var(--ink2);margin-bottom:10px}
button{font:13px system-ui,-apple-system,"Segoe UI",sans-serif;padding:6px 14px;border:1px solid var(--rule2);background:var(--paper);color:var(--ink);cursor:pointer;margin-right:8px}
button:hover{border-color:var(--ink3)}
button.danger{border-color:var(--bad);color:var(--bad)}
button:disabled{opacity:.45;cursor:not-allowed}
input{font:13px var(--mono);padding:6px 8px;border:1px solid var(--rule2);background:var(--paper);color:var(--ink);width:110px}
#result{margin-top:10px;font-family:var(--mono);font-size:12px;white-space:pre-wrap;word-break:break-all;color:var(--ink2);min-height:20px}
a{color:var(--ink)}
.note{font-size:12px;color:var(--ink3);margin-top:8px}
</style>
</head>
<body>
<header>
  <h1>qdii_limit 运维面板</h1>
  <span class="pill" id="overall">…</span>
  <span class="clock" id="clock"></span>
</header>
<div class="grid">
  <section class="card"><h2>调度（EdgeOne）<span class="v" id="dispatch-state"></span></h2><div id="dispatch"></div><div class="log" id="dispatch-log"></div></section>
  <section class="card"><h2>workflow 最近运行</h2><div id="runs"></div></section>
  <section class="card"><h2>数据新鲜度</h2><div id="data"></div></section>
  <section class="card"><h2>订阅与凭据</h2><div id="misc"></div></section>
</div>
<section class="ops">
  <h2>手动触发</h2>
  <button id="btn-refresh">立即 refresh</button>
  <button id="btn-dry">broadcast dry-run</button>
  <button id="btn-send" class="danger">broadcast 真发信</button>
  <span id="confirm-wrap" style="display:none">确认请输入 <input id="confirm-input" placeholder="send" autocomplete="off"> <button id="btn-send-go">确认发送</button></span>
  <div id="result"></div>
  <div class="note">broadcast 真发信会立即群发日报给全部订阅者，故需二次确认。所有面板触发都写入审计日志（/var/log/ops-panel-audit.log）。</div>
</section>
<script>
var $ = function (id) { return document.getElementById(id); };
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}
function row(k, v) { return '<div class="row"><span class="k">' + esc(k) + '</span><span class="v">' + v + '</span></div>'; }
function dot(state) { return '<span class="dot ' + esc(state || 'unknown') + '"></span>'; }
function fmtCst(iso) {
  if (!iso) return '—';
  var d = new Date(iso);
  if (isNaN(d)) return esc(iso);
  var c = new Date(d.getTime() + 8 * 3600e3);
  return c.toISOString().slice(0, 16).replace('T', ' ');
}
function age(iso) {
  if (!iso) return '—';
  var ms = Date.now() - new Date(iso).getTime();
  if (!isFinite(ms) || ms < 0) return '—';
  var m = Math.floor(ms / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return m + ' 分钟前';
  var h = Math.floor(m / 60);
  if (h < 24) return h + ' 小时前';
  return Math.floor(h / 24) + ' 天前';
}
function link(u, t) { return u ? '<a href="' + esc(u) + '" target="_blank" rel="noopener">' + esc(t || '查看') + '</a>' : '—'; }
function dur(sec) { return sec == null ? '—' : (sec >= 60 ? Math.floor(sec / 60) + 'm' + (sec % 60) + 's' : sec + 's'); }

var OVERALL_TEXT = { ok: '链路正常', warn: '需关注', bad: '异常' };
var SLOT_TEXT = { ok: 'ok', fail: '失败', missing: '缺失', pending: '未到点', unknown: '未知' };
var SOURCE_TEXT = { edgeone: 'EdgeOne 调度', 'local-log': '本地日志（降级）', none: '无数据源' };
var VIA_TEXT = { nonce: '调度触发', cron_secret: '鉴权手动', cron: 'cron 时代', anonymous: '未鉴权' };
// 槽位中文名由服务端随 slot 对象下发（sl.label）；这里只保留事件流用的兜底映射，
// 因为事件里的 slot 字符串没有附带 job 上下文。
var SLOT_CN = { preopen: '盘前', intraday: '早盘', close: '收盘前', morning: '盘前报' };

function slotDot(state) {
  if (state === 'ok') return 'ok';
  if (state === 'pending') return 'pending';
  if (state === 'unknown') return 'unknown';
  return 'bad';
}

function evtLine(e) {
  // 换行必须用 fromCharCode(10)：整页嵌在服务端模板字符串里，任何反斜杠转义
  // （连注释里的也算）都会被外层吃掉，浏览器收到裸换行会报 SyntaxError。
  // 2026-10-21 实测踩过两次；smoke.mjs 的「内联脚本可编译」断言专防这个。
  var left = (e.cstDate || '??') + ' ' + (e.cstTime || '--') + '  ' + String(e.wf || '').replace('.yml', '') + (e.slot ? '·' + (SLOT_CN[e.slot] || e.slot) : '');
  var right = e.code == null ? '网络异常' : 'HTTP ' + e.code;
  if (e.ok) {
    right += ' ok';
  } else if (e.alert === 'sent') {
    right += ' 失败·告警已发';
  } else if (e.alert) {
    right += ' 失败·告警异常(' + e.alert + ')';
  } else {
    right += ' 拒绝';
  }
  if (e.via === 'anonymous') right += '（未鉴权调用）';
  return left + '  ' + right;
}

function renderRuns(runs) {
  if (!runs || runs.error) {
    return row('状态', esc((runs && runs.hint) || '不可见'));
  }
  var html = '';
  ['refresh', 'broadcast'].forEach(function (key) {
    var list = runs[key];
    var label = key === 'refresh' ? 'refresh' : 'broadcast';
    if (!Array.isArray(list)) { html += row(label, '查询失败'); return; }
    if (!list.length) { html += row(label, '无运行记录'); return; }
    list.forEach(function (r, i) {
      var st = r.status !== 'completed' ? 'pending' : (r.conclusion === 'success' ? 'ok' : 'bad');
      var name = (i === 0 ? label : label + ' #' + (i + 1)) + ' · ' + fmtCst(r.startedAt);
      html += '<div class="row"><span class="k">' + dot(st) + esc(name) + '</span><span class="v">' +
        esc(r.status === 'completed' ? (r.conclusion || r.status) : r.status) + ' · ' + dur(r.durationSec) + ' ' + link(r.htmlUrl) + '</span></div>';
    });
  });
  return html;
}

function render(s) {
  var pill = $('overall');
  pill.textContent = OVERALL_TEXT[s.overall] || s.overall;
  pill.className = 'pill ' + (s.overall || 'unknown');
  $('clock').textContent = '北京 ' + s.cstClock + ' · ' + s.cstToday + ' · 页面 ' + fmtCst(s.now);

  var d = s.dispatch;
  $('dispatch-state').textContent = SOURCE_TEXT[d.source] || d.source;
  var html = '';
  (d.slots || []).forEach(function (sl) {
    var right = sl.code != null ? ('HTTP ' + sl.code + (sl.at ? ' · ' + sl.at : '')) : (SLOT_TEXT[sl.state] || sl.state);
    if (sl.via) right += ' · ' + (VIA_TEXT[sl.via] || sl.via);
    html += '<div class="row"><span class="k">' + dot(slotDot(sl.state)) + esc(sl.job + ' ' + sl.hhmm + ' ' + (sl.label || '')) + '</span><span class="v">' + esc(right) + '</span></div>';
  });
  if (d.note) html += row('备注', esc(d.note));
  // 今日被拒：dispatch 故意不把 401/403/409/400 写进事件流水（50 条会被噪声灌满），
  // 所以「有没有人在扫这个端点」只能靠这个计数看。非零不等于出事，但值得看一眼。
  var rj = d.rejected;
  html += row(
    '今日被拒',
    rj && rj.n ? esc('共 ' + rj.n + ' 次 · 最近 ' + String(rj.last || '').replace('T', ' ').slice(0, 16) + ' · ' + (rj.lastError || '—') + '（' + (rj.lastJob || '?') + '/' + (rj.lastSlot || '?') + '）') : '无'
  );
  var la = d.alerts && d.alerts.last;
  html += row(
    '最近告警',
    la ? esc(fmtCst(la.at)) + ' · ' + esc(la.job) + ' · ' + esc(la.alert === 'sent' ? '已发送' : la.alert || '—') : '最近无告警'
  );
  html += d.config
    ? row('调度鉴权', d.config.cronSecret ? 'CRON_SECRET 已配置' : '未配置（当天无法重跑）')
    : row('调度鉴权', '不可见');
  $('dispatch').innerHTML = html;
  $('dispatch-log').textContent = (d.recent || []).map(evtLine).join(String.fromCharCode(10));

  $('runs').innerHTML = renderRuns(s.runs);

  var data = s.data || {};
  var dh = '';
  if (data.error) {
    dh += row('状态', '读取失败：' + esc(data.error));
  } else {
    dh += row('数据日期', esc(data.date) + (data.isToday ? ' · 今日' : ' · 非今日'));
    dh += row('抓取于', esc(fmtCst(data.fetchedAt)) + ' · ' + esc(data.ageLabel || ''));
    if (data.lastDataCommit) {
      dh += row('最近数据 commit', esc(data.lastDataCommit.message) + ' · ' + esc(fmtCst(data.lastDataCommit.at)) + ' ' + link(data.lastDataCommit.htmlUrl));
    }
  }
  $('data').innerHTML = dh;

  var mh = '';
  var sub = s.subscribers || {};
  mh += sub.state === 'unconfigured' ? row('订阅数', '未配置 token') : (sub.error ? row('订阅数', esc(sub.error)) : row('订阅数', esc(sub.count) + ' 人'));
  var t = s.token || {};
  mh += t.state === 'recorded'
    ? row('PAT 到期', esc(String(t.expiresAt).slice(0, 10)) + ' · 剩余 ' + esc(t.daysLeft) + ' 天')
    : row('PAT 到期', '未登记' + (t.hint ? '（' + esc(t.hint) + '）' : ''));
  (s.audit || []).slice(0, 3).forEach(function (a) {
    mh += row('审计 ' + fmtCst(a.at), esc(a.job + (a.mode ? ' ' + a.mode : '') + ' → ' + (a.ok ? 'ok' : 'fail')));
  });
  $('misc').innerHTML = mh;

  var busy = !!s.busy;
  $('btn-refresh').disabled = busy;
  $('btn-dry').disabled = busy;
  $('btn-send').disabled = busy;
  if (busy) $('result').textContent = '有触发正在执行…';
}

function dispatch(body) {
  $('result').textContent = '提交中…';
  fetch('/api/dispatch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  }).then(function (r) {
    return r.json().then(function (j) { return { status: r.status, body: j }; });
  }).then(function (o) {
    $('result').textContent = 'HTTP ' + o.status + ' · ' + JSON.stringify(o.body);
    $('confirm-wrap').style.display = 'none';
    $('confirm-input').value = '';
    setTimeout(refresh, 800);
  }).catch(function (e) {
    $('result').textContent = '请求失败：' + e;
  });
}

$('btn-refresh').onclick = function () { dispatch({ job: 'refresh' }); };
$('btn-dry').onclick = function () { dispatch({ job: 'broadcast', mode: 'dry-run' }); };
$('btn-send').onclick = function () { $('confirm-wrap').style.display = 'inline'; $('confirm-input').focus(); };
$('btn-send-go').onclick = function () {
  if ($('confirm-input').value.trim() !== 'send') {
    $('result').textContent = '请输入 send 二次确认';
    return;
  }
  dispatch({ job: 'broadcast', mode: 'send', confirm: 'send' });
};

function refresh() {
  fetch('/api/status').then(function (r) { return r.json(); }).then(render).catch(function (e) {
    $('overall').textContent = '状态获取失败：' + e;
    $('overall').className = 'pill bad';
  });
}
refresh();
setInterval(refresh, 30000);
</script>
</body>
</html>
`;
