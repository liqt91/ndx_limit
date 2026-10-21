#!/usr/bin/env node
// ndx_limit 运维面板 —— 聚合「定时触发 → workflow → 数据/站点/订阅」全链路状态，可手动触发。
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
  repo: process.env.REPO || 'liqt91/ndx_limit',
  ghApiBase: (process.env.GH_API_BASE || 'https://api.github.com').replace(/\/+$/, ''),
  rawBase: (
    process.env.RAW_BASE ||
    `https://raw.githubusercontent.com/${process.env.REPO || 'liqt91/ndx_limit'}/main`
  ).replace(/\/+$/, ''),
  siteOrigin: (process.env.SITE_ORIGIN || 'https://ndx.liqt91.top').replace(/\/+$/, ''),
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

const SLOTS = [
  { job: 'refresh', wf: 'refresh.yml', hhmm: '07:50' },
  { job: 'broadcast', wf: 'broadcast.yml', hhmm: '08:10' },
];

function collectDispatch() {
  let text;
  try {
    text = readFileSync(CFG.dispatchLog, 'utf8');
  } catch {
    return { state: 'unknown', note: `日志不可读：${CFG.dispatchLog}`, slots: [], recent: [] };
  }
  const entries = parseDispatchLog(text);
  const today = cstToday();
  const todayEntries = entries.filter((e) => e.cstDate === today);
  const slots = SLOTS.map((s) => {
    const hit = todayEntries.find((e) => e.wf === s.wf);
    const expectedMin = Number(s.hhmm.slice(0, 2)) * 60 + Number(s.hhmm.slice(3));
    let state;
    if (hit) state = hit.code === 204 ? 'ok' : 'fail';
    else if (cstParts().minutes >= expectedMin) state = 'missing';
    else state = 'pending';
    return { job: s.job, wf: s.wf, hhmm: s.hhmm, state, at: hit ? hit.cstTime : null, code: hit ? hit.code : null };
  });
  let state = 'ok';
  if (slots.some((s) => s.state === 'fail')) state = 'fail';
  else if (slots.some((s) => s.state === 'missing')) state = 'missing';
  return { state, slots, recent: entries.slice(-6).reverse() };
}

function computeOverall(s) {
  if (s.dispatch.state === 'fail' || s.dispatch.state === 'missing') return 'bad';
  if (s.runs && !s.runs.error) {
    for (const key of ['refresh', 'broadcast']) {
      const latest = Array.isArray(s.runs[key]) ? s.runs[key][0] : null;
      if (latest && latest.status === 'completed' && latest.conclusion !== 'success') return 'bad';
    }
  }
  if (s.data && s.data.error === undefined && s.data.isToday === false) return 'warn';
  if (s.token && s.token.state === 'recorded' && s.token.daysLeft <= 30) return 'warn';
  if (s.subscribers && s.subscribers.error) return 'warn';
  if (s.runs && s.runs.error) return 'warn';
  return 'ok';
}

async function collectStatus() {
  const [runs, data, subscribers] = await Promise.all([collectRuns(), collectData(), collectSubs()]);
  const s = {
    now: new Date().toISOString(),
    cstToday: cstToday(),
    cstClock: cstParts().time,
    dispatch: collectDispatch(),
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
  console.log(`ndx_limit 运维面板：http://${CFG.host}:${CFG.port}（仅限本机/隧道访问，勿暴露公网）`);
  if (!CFG.ghToken) console.warn('提醒：未配置 GH_DISPATCH_TOKEN，workflow 运行状态将不可见');
  if (!CFG.subsToken) console.warn('提醒：未配置 SUBSCRIBERS_TOKEN，订阅数将不可见');
});

// ---------------------------------------------------------------- 页面（静态，数据全靠 /api/status）

const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ndx_limit 运维面板</title>
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
  <h1>ndx_limit 运维面板</h1>
  <span class="pill" id="overall">…</span>
  <span class="clock" id="clock"></span>
</header>
<div class="grid">
  <section class="card"><h2>定时触发<span class="v" id="dispatch-state"></span></h2><div id="dispatch"></div><div class="log" id="dispatch-log"></div></section>
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
var SLOT_TEXT = { ok: 'ok', fail: '失败', missing: '缺失', pending: '未到点' };

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
  $('dispatch-state').textContent = d.state === 'ok' ? '今日两跳都通' : (d.state === 'unknown' ? '日志不可读' : '需处理');
  var html = '';
  (d.slots || []).forEach(function (sl) {
    var right = sl.code != null ? ('HTTP ' + sl.code + ' · ' + sl.at) : SLOT_TEXT[sl.state];
    html += '<div class="row"><span class="k">' + dot(sl.state === 'ok' ? 'ok' : sl.state) + esc(sl.job + ' ' + sl.hhmm) + '</span><span class="v">' + esc(right) + '</span></div>';
  });
  if (d.note) html += row('备注', esc(d.note));
  $('dispatch').innerHTML = html;
  $('dispatch-log').textContent = (d.recent || []).map(function (e) {
    return e.cstDate + ' ' + e.cstTime + '  ' + e.wf + ' -> HTTP ' + e.code;
    // 换行必须用 fromCharCode(10)：整页嵌在服务端模板字符串里，任何反斜杠转义
    // （连注释里的也算）都会被外层吃掉，浏览器收到裸换行会报 SyntaxError。
    // 2026-10-21 实测踩过两次；smoke.mjs 的「内联脚本可编译」断言专防这个。
  }).join(String.fromCharCode(10));

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
