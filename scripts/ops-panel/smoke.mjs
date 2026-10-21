#!/usr/bin/env node
// 运维面板冒烟测试：零依赖（仅 Node 内置），不访问外部网络。
//
// 做法：用桩替身顶替 GitHub API / raw.githubusercontent / 站点 API / dispatch 脚本 /
// 日志文件，起真实的面板进程打 HTTP，断言：
//   1. 页面 HTML 关键锚点（按钮、接口路径）；
//   2. /api/status 聚合结果（dispatch 槽位、workflow runs、数据新鲜度、订阅数、PAT 剩余天数）；
//   3. 手动触发：refresh 通、broadcast dry-run 通、broadcast send 无二次确认必须 400；
//   4. 非法 job / 非法 mode / 未知路由 → 400/404；
//   5. 主机守卫：PANEL_HOST=0.0.0.0 必须拒绝启动（exit 3）；
//   6. 状态灯逻辑：dispatch 出现 500 → overall=bad；数据非今日 → overall=warn。
//
// 跑法：node scripts/ops-panel/smoke.mjs
// 任何一条断言失败即以非零退出，并保留现场目录便于排查。

import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = new URL('.', import.meta.url);
const SERVER_PATH = fileURLToPath(new URL('server.mjs', HERE));
const IS_WIN = process.platform === 'win32';

// 与 server.mjs 相同的 CST 计算（server  import 有副作用，不能直接引）
function cstParts(instant) {
  const d = new Date((instant == null ? Date.now() : instant) + 8 * 3600e3);
  const iso = d.toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 19) };
}
const cstToday = () => cstParts().date;
const cstShiftDays = (n) => {
  const [y, m, d] = cstToday().split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n, 12, 0, 0));
  return t.toISOString().slice(0, 10);
};
// 北京hh:mm 对应的 UTC 时刻串（dispatch 日志里存的是 UTC）
function utcAtCst(dateStr, hhmm) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d, Number(hhmm.slice(0, 2)), Number(hhmm.slice(3)), 1) - 8 * 3600e3);
  return t.toISOString().slice(0, 19) + 'Z';
}

const checks = [];
function check(name, cond, detail) {
  checks.push({ name, pass: !!cond, detail: detail == null ? '' : String(detail) });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function j(res, body, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function freePort() {
  const srv = http.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  await new Promise((r) => srv.close(r));
  return port;
}

async function startStack(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ops-panel-smoke-'));
  const today = cstToday();
  const staleDate = cstShiftDays(-1);

  // dispatch 日志 fixture：今天两个槽位；failStack 把 refresh 换成 500
  const lines = [
    `${utcAtCst(today, '07:50')} refresh.yml -> HTTP ${opts.failRefresh ? 500 : 204}`,
    `${utcAtCst(today, '08:10')} broadcast.yml -> HTTP 204`,
    `${utcAtCst(cstShiftDays(-1), '07:50')} refresh.yml -> HTTP 204`,
  ];
  const dispatchLog = join(dir, 'gh-dispatch.log');
  writeFileSync(dispatchLog, lines.join('\n') + '\n', 'utf8');

  const tokenMeta = join(dir, 'token.meta.json');
  writeFileSync(
    tokenMeta,
    JSON.stringify({ issuedAt: '2026-01-01T00:00:00+08:00', expiresAt: new Date(Date.now() + 200 * 86400e3).toISOString() }),
    'utf8'
  );

  // mock dispatch 脚本：记录参数、打印 HTTP 204（或 500 变体）
  const argsFile = join(dir, 'mock-args.txt');
  const mockOk = join(dir, IS_WIN ? 'mock-ok.cmd' : 'mock-ok.sh');
  const mockFail = join(dir, IS_WIN ? 'mock-fail.cmd' : 'mock-fail.sh');
  if (IS_WIN) {
    writeFileSync(mockOk, '@echo off\r\necho %1 %2> "%MOCK_ARGS_FILE%"\r\necho mock %1 HTTP 204\r\nexit /b 0\r\n', 'utf8');
    writeFileSync(mockFail, '@echo off\r\necho mock %1 HTTP 500\r\nexit /b 1\r\n', 'utf8');
  } else {
    writeFileSync(mockOk, '#!/usr/bin/env bash\necho "$1 ${2:-}" > "${MOCK_ARGS_FILE:?}"\necho "mock $1 HTTP 204"\nexit 0\n', 'utf8');
    writeFileSync(mockFail, '#!/usr/bin/env bash\necho "mock $1 HTTP 500"\nexit 1\n', 'utf8');
    chmodSync(mockOk, 0o755);
    chmodSync(mockFail, 0o755);
  }

  // 桩：GitHub API
  let ghAuthSeen = '';
  const gh = await startStub((req, res) => {
    const u = new URL(req.url, 'http://x');
    ghAuthSeen = req.headers.authorization || '';
    if (u.pathname.endsWith('/actions/workflows/refresh.yml/runs')) return j(res, { workflow_runs: runs() });
    if (u.pathname.endsWith('/actions/workflows/broadcast.yml/runs')) return j(res, { workflow_runs: runs() });
    if (u.pathname.endsWith('/commits')) return j(res, [commit()]);
    j(res, { error: 'stub 404' }, 404);
  });
  // 桩：raw（fetch-meta，可按选项返回非今日）
  const raw = await startStub((req, res) => {
    if (req.url.endsWith('/data/fetch-meta.json')) {
      return j(res, { date: opts.staleData ? staleDate : today, fetchedAt: new Date(Date.now() - 25 * 60000).toISOString() });
    }
    j(res, { error: 'stub 404' }, 404);
  });
  // 桩：站点（订阅数 + EdgeOne 调度层两个端点）
  let subsAuthSeen = '';
  let eoDispatchSeen = null;
  const site = await startStub((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/api/subscribers') {
      subsAuthSeen = req.headers.authorization || '';
      return j(res, { ok: true, count: 7, emails: [] });
    }
    if (u.pathname === '/api/jobs/status') {
      if (opts.eoDown) return j(res, { ok: false, error: 'kv_not_configured' }, 500);
      return j(res, eoPayload(opts.eoStatus || {}));
    }
    if (u.pathname === '/api/jobs/dispatch' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        eoDispatchSeen = { body: JSON.parse(body || '{}'), auth: req.headers.authorization || '' };
        j(res, { ok: true, job: 'refresh', workflow: 'refresh.yml', status: 204 });
      });
      return;
    }
    j(res, { error: 'stub 404' }, 404);
  });

  const port = await freePort();
  const panel = spawn(process.execPath, [SERVER_PATH], {
    env: {
      ...process.env,
      PANEL_HOST: '127.0.0.1',
      PANEL_PORT: String(port),
      GH_API_BASE: `http://127.0.0.1:${gh.address().port}`,
      RAW_BASE: `http://127.0.0.1:${raw.address().port}`,
      SITE_ORIGIN: `http://127.0.0.1:${site.address().port}`,
      DISPATCH_LOG: dispatchLog,
      DISPATCH_SCRIPT: mockOk,
      AUDIT_LOG: join(dir, 'audit.log'),
      TOKEN_META: tokenMeta,
      GH_DISPATCH_TOKEN: 'smoke-token',
      SUBSCRIBERS_TOKEN: 'smoke-subs',
      MOCK_ARGS_FILE: argsFile,
      // 手动触发走 EO 端点的开关：配了就走 https 站点端点（桩），没配走本地脚本
      ...(opts.eoCron ? { EO_CRON_SECRET: 'smoke-eo-secret' } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const panelExit = new Promise((r) => panel.on('exit', (code) => r(code)));
  let panelErr = '';
  panel.stderr.on('data', (d) => {
    panelErr += d;
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitReady(baseUrl);
  return { dir, baseUrl, panel, panelExit, panelErr: () => panelErr, authSeen: () => ({ gh: ghAuthSeen, subs: subsAuthSeen }), srvs: [gh, raw, site], argsFile, dispatchLog, auditLog: join(dir, 'audit.log'), mockFail, eoDispatchSeen: () => eoDispatchSeen };
}

// EdgeOne /api/jobs/status 的桩载荷：今天四跳都成功（晨/午各两跳）、一条未鉴权 401、
// 昨天一次 github_error 且告警已发（alerts.last 指向它）。over 供各栈按需覆盖。
// jobs 为 job×slot 双层结构，与 status.js 一致；事件带 slot，与 dispatch.js 一致。
function eoPayload(over = {}) {
  const at1 = new Date(Date.now() - 30 * 60000).toISOString();
  const at2 = new Date(Date.now() - 90 * 60000).toISOString();
  const at3 = new Date(Date.now() - 200 * 60000).toISOString();
  const at4 = new Date(Date.now() - 190 * 60000).toISOString();
  const atOld = new Date(Date.now() - 26 * 3600e3).toISOString();
  const atFail = new Date(Date.now() - 25 * 3600e3).toISOString();
  return {
    ok: true,
    cstToday: cstToday(),
    jobs: {
      refresh: {
        morning: { dispatchedToday: true, at: at1, via: 'nonce', mode: null },
        close: { dispatchedToday: true, at: at3, via: 'nonce', mode: null },
      },
      broadcast: {
        morning: { dispatchedToday: true, at: at2, via: 'nonce', mode: 'send' },
        close: { dispatchedToday: true, at: at4, via: 'nonce', mode: 'send' },
      },
    },
    events: [
      { at: at4, job: 'broadcast', slot: 'close', mode: 'send', via: 'nonce', status: 204, ok: true, error: null, alert: null },
      { at: at3, job: 'refresh', slot: 'close', mode: null, via: 'nonce', status: 204, ok: true, error: null, alert: null },
      { at: at2, job: 'broadcast', slot: 'morning', mode: 'send', via: 'nonce', status: 204, ok: true, error: null, alert: null },
      { at: at1, job: 'refresh', slot: 'morning', mode: null, via: 'nonce', status: 204, ok: true, error: null, alert: null },
      { at: atOld, job: 'refresh', slot: 'morning', mode: null, via: 'anonymous', status: 401, ok: false, error: 'unauthorized', alert: null },
      { at: atFail, job: 'refresh', slot: 'morning', mode: null, via: 'nonce', status: 502, ok: false, error: 'github_error', alert: 'sent' },
    ],
    alerts: { last: { at: atFail, job: 'refresh', status: 502, alert: 'sent' } },
    config: { ghToken: true, cronSecret: true, alertEmail: true },
    ...over,
  };
}

function runs() {
  const mk = (id) => ({
    id,
    event: 'workflow_dispatch',
    status: 'completed',
    conclusion: 'success',
    run_started_at: '2026-10-20T23:55:00Z',
    updated_at: '2026-10-21T00:10:00Z',
    html_url: `https://github.com/liqt91/ndx_limit/actions/runs/${id}`,
    name: 'Daily Data Refresh',
  });
  return [mk(3), mk(2), mk(1)];
}
function commit() {
  return {
    commit: { committer: { date: '2026-10-20T23:56:00Z' }, message: `data: daily scrape ${cstToday()}` },
    html_url: 'https://github.com/liqt91/ndx_limit/commit/deadbeef',
  };
}

async function startStub(handler) {
  const srv = http.createServer(handler);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return srv;
}

async function waitReady(baseUrl, timeoutMs = 10000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(baseUrl + '/api/status');
      if (r.ok) return;
    } catch {
      /* 还没起来 */
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`面板未在 ${timeoutMs}ms 内就绪`);
    await sleep(100);
  }
}

async function stopStack(s) {
  try {
    s.panel.kill('SIGKILL');
  } catch {
    /* 已退出 */
  }
  await s.panelExit;
  for (const srv of s.srvs) {
    try {
      srv.close();
    } catch {
      /* 已关闭 */
    }
  }
}

async function getJson(url) {
  const r = await fetch(url);
  return { status: r.status, body: await r.json() };
}
async function postJson(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

// ---------------------------------------------------------------- 主流程

async function main() {
  // ---- 栈 1：全绿 ----
  const ok = await startStack();
  try {
    const page = await fetch(ok.baseUrl + '/');
    const html = await page.text();
    check('GET / 返回 200', page.status === 200, page.status);
    check('页面含标题', html.includes('ndx_limit 运维面板'));
    check('页面含 refresh 按钮', html.includes('立即 refresh'));
    check('页面含真发信按钮', html.includes('broadcast 真发信'));
    check('页面引用 /api/status', html.includes('/api/status'));

    // 内联脚本必须可编译：整页嵌在服务端模板字符串里，客户端 JS 若写了 '\n' 之类
    // 会被外层吃掉转义，浏览器拿到裸换行报 SyntaxError，页面全是空卡片（2026-10-21 实测）。
    // new Function 只编译不执行，专抓这类「服务端渲染时被静默改坏」的语法错误。
    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
    let compileErr = '';
    try {
      if (scriptMatch) new Function(scriptMatch[1]);
      else compileErr = '未找到内联脚本';
    } catch (e) {
      compileErr = String(e.message || e);
    }
    check('页面内联脚本可编译', compileErr === '', compileErr);

    const st = await getJson(ok.baseUrl + '/api/status');
    check('GET /api/status 返回 200', st.status === 200, st.status);
    const s = st.body;
    check('overall === ok', s.overall === 'ok', s.overall);
    check('dispatch.source === edgeone（EO 优先）', s.dispatch && s.dispatch.source === 'edgeone', s.dispatch && s.dispatch.source);
    check('dispatch.state === ok', s.dispatch && s.dispatch.state === 'ok', JSON.stringify(s.dispatch && s.dispatch.state));
    check('四个槽位都是 ok/204', Array.isArray(s.dispatch.slots) && s.dispatch.slots.length === 4 && s.dispatch.slots.every((x) => x.state === 'ok' && x.code === 204), JSON.stringify(s.dispatch.slots));
    check('槽位覆盖晨/午 × refresh/broadcast', s.dispatch.slots.map((x) => x.job + ':' + x.slot).join(',') === 'refresh:morning,broadcast:morning,refresh:close,broadcast:close', JSON.stringify(s.dispatch.slots.map((x) => x.job + ':' + x.slot)));
    check('槽位标注触发方式 via=nonce', s.dispatch.slots.every((x) => x.via === 'nonce'), JSON.stringify(s.dispatch.slots.map((x) => x.via)));
    check('事件流可见午间槽位', s.dispatch.recent.some((e) => e.slot === 'close' && e.ok === true), JSON.stringify(s.dispatch.recent));
    check('事件流水进入面板（含今日与昨日）', Array.isArray(s.dispatch.recent) && s.dispatch.recent.length >= 3 && s.dispatch.recent.some((e) => e.cstDate === cstToday() && e.ok === true), JSON.stringify(s.dispatch.recent));
    check('未鉴权调用也在事件流里可见', s.dispatch.recent.some((e) => e.via === 'anonymous' && e.code === 401), JSON.stringify(s.dispatch.recent));
    check('最近告警=已发送', s.dispatch.alerts && s.dispatch.alerts.last && s.dispatch.alerts.last.alert === 'sent', JSON.stringify(s.dispatch.alerts));
    check('调度鉴权已配置可见', s.dispatch.config && s.dispatch.config.cronSecret === true, JSON.stringify(s.dispatch.config));
    check('refresh runs 最新 success', Array.isArray(s.runs.refresh) && s.runs.refresh[0].conclusion === 'success');
    check('broadcast runs 最新 success', Array.isArray(s.runs.broadcast) && s.runs.broadcast[0].conclusion === 'success');
    check('run 时长 900s', s.runs.refresh[0].durationSec === 900, s.runs.refresh[0].durationSec);
    check('数据日期为今日', s.data && s.data.date === cstToday() && s.data.isToday === true, JSON.stringify(s.data));
    check('最近数据 commit 展示', s.data && s.data.lastDataCommit && s.data.lastDataCommit.message.includes('daily scrape'));
    check('订阅数 7', s.subscribers && s.subscribers.count === 7, JSON.stringify(s.subscribers));
    check('PAT 剩余约 200 天', s.token && s.token.state === 'recorded' && s.token.daysLeft >= 199 && s.token.daysLeft <= 200, JSON.stringify(s.token));
    check('初始无审计记录', Array.isArray(s.audit) && s.audit.length === 0);
    check('GitHub API 带了 token', ok.authSeen().gh === 'Bearer smoke-token', ok.authSeen().gh);
    check('订阅接口带了 token', ok.authSeen().subs === 'Bearer smoke-subs', ok.authSeen().subs);

    // 手动触发：refresh
    const r1 = await postJson(ok.baseUrl + '/api/dispatch', { job: 'refresh' });
    check('refresh 触发 ok', r1.status === 200 && r1.body && r1.body.ok === true && r1.body.exitCode === 0, JSON.stringify(r1.body));
    check('refresh 输出含 HTTP 204', r1.body && /HTTP 204/.test(r1.body.output || ''), r1.body && r1.body.output);
    const st2 = await getJson(ok.baseUrl + '/api/status');
    check('审计记录已写入', Array.isArray(st2.body.audit) && st2.body.audit.length === 1 && st2.body.audit[0].job === 'refresh' && st2.body.audit[0].via === 'panel', JSON.stringify(st2.body.audit));

    // broadcast dry-run
    const r2 = await postJson(ok.baseUrl + '/api/dispatch', { job: 'broadcast', mode: 'dry-run' });
    check('broadcast dry-run ok', r2.status === 200 && r2.body && r2.body.ok === true, JSON.stringify(r2.body));

    // broadcast send 无二次确认 → 必须 400
    const r3 = await postJson(ok.baseUrl + '/api/dispatch', { job: 'broadcast', mode: 'send' });
    check('broadcast send 无确认 → 400 confirm_required', r3.status === 400 && r3.body && r3.body.error === 'confirm_required', `status=${r3.status} body=${JSON.stringify(r3.body)}`);

    // broadcast send 带确认 → ok，且脚本收到 send 参数
    const r4 = await postJson(ok.baseUrl + '/api/dispatch', { job: 'broadcast', mode: 'send', confirm: 'send' });
    check('broadcast send 带确认 ok', r4.status === 200 && r4.body && r4.body.ok === true, JSON.stringify(r4.body));
    const argsText = await import('node:fs/promises').then((fs) => fs.readFile(ok.argsFile, 'utf8').catch(() => ''));
    check('脚本收到 broadcast send', argsText.trim() === 'broadcast send', argsText);

    // 非法请求
    const r5 = await postJson(ok.baseUrl + '/api/dispatch', { job: 'nope' });
    check('非法 job → 400 bad_job', r5.status === 400 && r5.body && r5.body.error === 'bad_job', `status=${r5.status}`);
    const r6 = await postJson(ok.baseUrl + '/api/dispatch', { job: 'broadcast', mode: 'whatever' });
    check('非法 mode → 400 bad_mode', r6.status === 400 && r6.body && r6.body.error === 'bad_mode', `status=${r6.status}`);
    const r7 = await fetch(ok.baseUrl + '/api/nope');
    check('未知路由 → 404', r7.status === 404, r7.status);
  } finally {
    await stopStack(ok);
  }

  // ---- 栈 2：EO 报告今日早间 refresh 硬失败（GitHub 502）→ overall=bad ----
  {
    const failAt = new Date(Date.now() - 45 * 60000).toISOString();
    const bad = await startStack({
      eoStatus: eoPayload({
        jobs: {
          refresh: {
            morning: { dispatchedToday: false, at: null, via: null, mode: null },
            close: { dispatchedToday: true, at: new Date(Date.now() - 200 * 60000).toISOString(), via: 'nonce', mode: null },
          },
          broadcast: {
            morning: { dispatchedToday: true, at: new Date(Date.now() - 90 * 60000).toISOString(), via: 'nonce', mode: 'send' },
            close: { dispatchedToday: true, at: new Date(Date.now() - 190 * 60000).toISOString(), via: 'nonce', mode: 'send' },
          },
        },
        events: [
          { at: new Date(Date.now() - 190 * 60000).toISOString(), job: 'broadcast', slot: 'close', mode: 'send', via: 'nonce', status: 204, ok: true, error: null, alert: null },
          { at: new Date(Date.now() - 200 * 60000).toISOString(), job: 'refresh', slot: 'close', mode: null, via: 'nonce', status: 204, ok: true, error: null, alert: null },
          { at: new Date(Date.now() - 90 * 60000).toISOString(), job: 'broadcast', slot: 'morning', mode: 'send', via: 'nonce', status: 204, ok: true, error: null, alert: null },
          { at: failAt, job: 'refresh', slot: 'morning', mode: null, via: 'nonce', status: 502, ok: false, error: 'github_error', alert: 'sent' },
        ],
        alerts: { last: { at: failAt, job: 'refresh', status: 502, alert: 'sent' } },
      }),
    });
    try {
      const s = (await getJson(bad.baseUrl + '/api/status')).body;
      check('EO 报今日早间 refresh 失败 → overall=bad', s.overall === 'bad', s.overall);
      check('dispatch.state === fail', s.dispatch.state === 'fail', s.dispatch.state);
      check('失败槽位带 502 与时间（仅早间 refresh）', s.dispatch.slots[0].state === 'fail' && s.dispatch.slots[0].code === 502 && !!s.dispatch.slots[0].at && s.dispatch.slots[0].slot === 'morning', JSON.stringify(s.dispatch.slots[0]));
      check('午间 refresh 槽位不受早间失败影响', s.dispatch.slots[2].state === 'ok', JSON.stringify(s.dispatch.slots[2]));
      const la2 = s.dispatch.alerts && s.dispatch.alerts.last;
      check('告警摘要指向这次失败', !!la2 && la2.status === 502 && la2.alert === 'sent', JSON.stringify(s.dispatch.alerts));
    } finally {
      await stopStack(bad);
      rmSync(bad.dir, { recursive: true, force: true });
    }
  }

  // ---- 栈 3：数据非今日 → overall=warn ----
  const stale = await startStack({ staleData: true });
  try {
    const s = (await getJson(stale.baseUrl + '/api/status')).body;
    check('数据非今日 → overall=warn', s.overall === 'warn', s.overall);
    check('数据非今日 → isToday=false', s.data.isToday === false && s.data.date === cstShiftDays(-1), JSON.stringify(s.data));
  } finally {
    await stopStack(stale);
  }

  // ---- 栈 4：EO 端点不可达 → 回退本地日志，source=local-log，overall=warn ----
  {
    const down = await startStack({ eoDown: true });
    try {
      const s = (await getJson(down.baseUrl + '/api/status')).body;
      check('EO 不可达 → source=local-log', s.dispatch.source === 'local-log', s.dispatch.source);
      check('降级时 note 说明来源', String(s.dispatch.note || '').includes('EdgeOne 状态端点不可达'), s.dispatch.note);
      check('本地日志早间两槽仍可读（今天 204）', s.dispatch.slots[0].state === 'ok' && s.dispatch.slots[1].state === 'ok', JSON.stringify(s.dispatch.slots));
      check('午间槽位无记录 → unknown（不伪装成 missing）', s.dispatch.slots[2].state === 'unknown' && s.dispatch.slots[3].state === 'unknown', JSON.stringify(s.dispatch.slots));
      check('EO 不可达 → overall=warn', s.overall === 'warn', s.overall);
    } finally {
      await stopStack(down);
      rmSync(down.dir, { recursive: true, force: true });
    }
  }

  // ---- 栈 5：告警渠道异常（alert=failed）→ warn ----
  {
    const af = await startStack({ eoStatus: eoPayload({ alerts: { last: { at: new Date().toISOString(), job: 'refresh', status: 502, alert: 'failed' } } }) });
    try {
      const s = (await getJson(af.baseUrl + '/api/status')).body;
      check('告警发送失败 → overall=warn', s.overall === 'warn', s.overall);
      check('页面数据里告警状态是 failed', (s.dispatch.alerts.last || {}).alert === 'failed', JSON.stringify(s.dispatch.alerts));
    } finally {
      await stopStack(af);
      rmSync(af.dir, { recursive: true, force: true });
    }
  }

  // ---- 栈 6：手动触发走 EO 端点（EO_CRON_SECRET 已配）----
  {
    const eo = await startStack({ eoCron: true });
    try {
      const r1 = await postJson(eo.baseUrl + '/api/dispatch', { job: 'refresh' });
      check('EO 路径 refresh 触发 ok', r1.status === 200 && r1.body && r1.body.ok === true && r1.body.via === 'edgeone', JSON.stringify(r1.body));
      // 防呆：EO 路径被破坏时桩根本没被调用，seen 是 null——取不到要让检查项自然失败，而不是崩
      const seenBody = () => (eo.eoDispatchSeen() && eo.eoDispatchSeen().body) || {};
      const seen1 = eo.eoDispatchSeen();
      check('EO 端点收到 job=refresh 与 cron_secret', !!seen1 && seen1.body.job === 'refresh' && seen1.body.cron_secret === 'smoke-eo-secret', JSON.stringify(seen1 && seen1.body));
      check('refresh 不带 mode 字段', !!seen1 && !('mode' in seen1.body), JSON.stringify(seen1 && seen1.body));
      check('refresh 带 slot（按面板当前时刻判晨/午）', !!seen1 && ['morning', 'close'].includes(seen1.body.slot), JSON.stringify(seen1 && seen1.body));
      const st = await getJson(eo.baseUrl + '/api/status');
      check('审计记录 via=edgeone', Array.isArray(st.body.audit) && st.body.audit.length === 1 && st.body.audit[0].via === 'edgeone', JSON.stringify(st.body.audit));

      const r2 = await postJson(eo.baseUrl + '/api/dispatch', { job: 'broadcast', mode: 'dry-run' });
      check('EO 路径 dry-run ok', r2.status === 200 && r2.body.ok === true);
      check('dry-run 映射为 mode=dry', seenBody().mode === 'dry', JSON.stringify(seenBody()));
      const r3 = await postJson(eo.baseUrl + '/api/dispatch', { job: 'broadcast', mode: 'send' });
      check('EO 路径真发信无确认 → 400', r3.status === 400 && r3.body.error === 'confirm_required', `status=${r3.status}`);
      const r4 = await postJson(eo.baseUrl + '/api/dispatch', { job: 'broadcast', mode: 'send', confirm: 'send' });
      check('EO 路径真发信带确认 ok', r4.status === 200 && r4.body.ok === true);
      check('真发信映射为 mode=send', seenBody().mode === 'send', JSON.stringify(seenBody()));
      check('真发信带 edition（下午手点发下午报）', ['morning', 'close'].includes(seenBody().edition), JSON.stringify(seenBody()));
    } finally {
      await stopStack(eo);
      rmSync(eo.dir, { recursive: true, force: true });
    }
  }

  // ---- 栈 4：主机守卫 ----
  {
    const guard = spawn(process.execPath, [SERVER_PATH], {
      env: { ...process.env, PANEL_HOST: '0.0.0.0', PANEL_PORT: '18799' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    guard.stderr.on('data', (d) => {
      err += d;
    });
    // 拒绝启动应立刻退出；若 5 秒后还在跑（说明守卫生效被破坏），判失败并杀掉，避免挂死。
    const timedOut = Symbol('timeout');
    const code = await Promise.race([
      new Promise((r) => guard.on('exit', r)),
      sleep(5000).then(() => timedOut),
    ]);
    if (code === timedOut) {
      try {
        guard.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
      check('0.0.0.0 监听被拒绝（exit 3）', false, '5 秒后仍在运行，守卫未生效');
    } else {
      check('0.0.0.0 监听被拒绝（exit 3）', code === 3, `exit=${code}`);
    }
    check('拒绝信息说明原因', err.includes('拒绝启动'), err.trim().slice(0, 120));
  }

  // ---- 汇总 ----
  const failed = checks.filter((c) => !c.pass);
  for (const c of checks) {
    console.log(`${c.pass ? '通过' : '失败'}  ${c.name}${c.pass || !c.detail ? '' : '  （' + c.detail + '）'}`);
  }
  console.log(`\n${checks.length - failed.length}/${checks.length} 通过`);
  if (failed.length) {
    console.error('冒烟测试未通过：' + failed.map((f) => f.name).join('；'));
    process.exit(1);
  }
  for (const s of [ok, stale]) rmSync(s.dir, { recursive: true, force: true });
  console.log('全部通过');
}

main().catch((e) => {
  console.error('冒烟测试异常退出：', e);
  process.exit(1);
});
