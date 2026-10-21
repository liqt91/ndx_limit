#!/usr/bin/env node
// scripts/jobs-dispatch-smoke.mjs —— /api/jobs/dispatch 边缘函数冒烟测试（零外网）。
//
// 打的是真函数（直接 import edge-functions/api/jobs/dispatch.js），用桩替身顶掉
// fetch（GitHub API / Brevo）、KV（Map）、env。覆盖：鉴权两层、每日一次闸、
// GitHub 各状态码分支、告警发送与降级、edgeone.json 与代码的 nonce 一致性。
//
// 跑法：npm run jobs:smoke
// 判据变更后必须重做负向验证（插破坏 → 确认红在对的位置 → 逐字节还原）。

import { readFileSync } from 'node:fs';
import { onRequestGet, onRequestPost } from '../edge-functions/api/jobs/dispatch.js';

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log('  ok  ' + name);
  } else {
    fail++;
    console.log('  FAIL ' + name + (detail ? '  —— ' + detail : ''));
  }
}

// ---- edgeone.json 是部署事实的唯一来源：nonce / 路径 / cron 都以它为准 ----
const EO = JSON.parse(readFileSync(new URL('../edgeone.json', import.meta.url), 'utf8'));
const SCHEDULES = EO.schedules || [];
const EO_NONCE = SCHEDULES[0] && SCHEDULES[0].payload ? SCHEDULES[0].payload.nonce : '';
const CST_TODAY = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);

// ---- 桩替身 ----
const state = { githubStatus: 204, githubBody: '', brevoStatus: 200, brevoBody: '{}' };
const fetchCalls = [];

function stubResponse(status, body) {
  // Node 的 Response 构造器禁止 204/304 带 body，GitHub 成功就是 204 + 空 body
  if (status === 204 || status === 304) return new Response(null, { status });
  return new Response(body, { status });
}

globalThis.fetch = async (url, init) => {
  const u = String(url);
  fetchCalls.push({ url: u, init });
  if (u.includes('api.github.com')) return stubResponse(state.githubStatus, state.githubBody);
  if (u.includes('api.brevo.com')) return stubResponse(state.brevoStatus, state.brevoBody);
  throw new Error('unstubbed fetch: ' + u);
};

function makeKV() {
  const m = new Map();
  return {
    _m: m,
    async get(k) {
      return m.has(k) ? m.get(k) : null;
    },
    async put(k, v) {
      m.set(k, String(v));
    },
    async delete(k) {
      m.delete(k);
    },
  };
}

function reset() {
  fetchCalls.length = 0;
  state.githubStatus = 204;
  state.githubBody = '';
  state.brevoStatus = 200;
  state.brevoBody = '{}';
  globalThis.SUBS_KV = makeKV();
}

function makeReq(body, headers = {}) {
  return {
    method: 'POST',
    headers: {
      get: (k) => {
        const v = headers[k.toLowerCase()];
        return v == null ? null : v;
      },
    },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

function makeEnv(over = {}) {
  return {
    GH_DISPATCH_TOKEN: 'ghp_test_token',
    GH_REPO: 'liqt91/ndx_limit',
    DISPATCH_NONCE: EO_NONCE,
    CRON_SECRET: 'cron-secret-123',
    BREVO_API_KEY: 'brevo-key',
    MAIL_FROM: 'digest@liqt91.top',
    ALERT_EMAIL: 'q@example.com',
    ...over,
  };
}

function githubCalls() {
  return fetchCalls.filter((c) => c.url.includes('api.github.com'));
}
function brevoCalls() {
  return fetchCalls.filter((c) => c.url.includes('api.brevo.com'));
}
// 断言要能「红」而不是「崩」：取不到就返回 {}，让检查项自然失败
function lastGhBody() {
  const c = githubCalls()[githubCalls().length - 1];
  if (!c || !c.init || !c.init.body) return {};
  try {
    return JSON.parse(c.init.body);
  } catch {
    return {};
  }
}
function guardKey(job) {
  return `job_sent_${job}_${CST_TODAY}`;
}

async function main() {
  // ---- 栈 1：refresh 正常链路（nonce 鉴权） ----
  reset();
  {
    const r = await onRequestPost({ request: makeReq({ job: 'refresh', nonce: EO_NONCE }), env: makeEnv() });
    const j = await r.json();
    check('refresh 受理：200 ok', r.status === 200 && j.ok === true, `status=${r.status}`);
    check('refresh 调了一次 GitHub dispatches', githubCalls().length === 1);
    check(
      'URL 指向 refresh.yml',
      githubCalls()[0] && githubCalls()[0].url.endsWith('/actions/workflows/refresh.yml/dispatches')
    );
    const sent = lastGhBody();
    check('dispatch body：ref=main 且不带 inputs（refresh 无输入）', sent.ref === 'main' && !('inputs' in sent));
    check('authorization 头带 PAT', githubCalls()[0].init.headers.authorization === 'Bearer ghp_test_token');
    check('每日闸 key 已写', globalThis.SUBS_KV._m.has(guardKey('refresh')));
    const rawGuard = globalThis.SUBS_KV._m.get(guardKey('refresh'));
    const gv = rawGuard ? JSON.parse(rawGuard) : {};
    check('闸 key 记录 via=nonce', gv.via === 'nonce');
  }

  // ---- 栈 2：同一任务当天第二次（nonce）被闸拦下 ----
  {
    const r = await onRequestPost({ request: makeReq({ job: 'refresh', nonce: EO_NONCE }), env: makeEnv() });
    const j = await r.json();
    check('refresh 当天第二次：409', r.status === 409 && j.error === 'already_triggered_today', `status=${r.status}`);
    check('被拦下时不再调 GitHub', githubCalls().length === 1);
  }

  // ---- 栈 3：broadcast 正常链路，默认 mode=send ----
  reset();
  {
    const r = await onRequestPost({ request: makeReq({ job: 'broadcast', nonce: EO_NONCE }), env: makeEnv() });
    const j = await r.json();
    check('broadcast 受理：200 ok', r.status === 200 && j.ok === true);
    const sent = lastGhBody();
    check('broadcast inputs.mode=send', sent.inputs && sent.inputs.mode === 'send');
    check('broadcast 闸 key 已写', globalThis.SUBS_KV._m.has(guardKey('broadcast')));
    const r2 = await onRequestPost({ request: makeReq({ job: 'broadcast', nonce: EO_NONCE }), env: makeEnv() });
    check('broadcast 当天第二次：409', r2.status === 409);
    check('refresh 与 broadcast 闸互不干扰', !globalThis.SUBS_KV._m.has(guardKey('refresh')));
  }

  // ---- 栈 4：CRON_SECRET 鉴权（body）绕过每日闸 ----
  reset();
  globalThis.SUBS_KV.put(guardKey('refresh'), '{"seeded":true}');
  {
    const before = globalThis.SUBS_KV._m.get(guardKey('refresh'));
    const r = await onRequestPost({
      request: makeReq({ job: 'refresh', cron_secret: 'cron-secret-123' }),
      env: makeEnv(),
    });
    const j = await r.json();
    check('带 cron_secret 绕过闸：200', r.status === 200 && j.ok === true, `status=${r.status}`);
    check('绕过时仍调 GitHub', githubCalls().length === 1);
    check('绕过不改写已有闸 key', globalThis.SUBS_KV._m.get(guardKey('refresh')) === before);
  }

  // ---- 栈 5：Bearer 头鉴权 ----
  reset();
  {
    const r = await onRequestPost({
      request: makeReq({ job: 'broadcast' }, { authorization: 'Bearer cron-secret-123' }),
      env: makeEnv(),
    });
    check('Bearer 鉴权：200', r.status === 200);
    check('Bearer 不带 nonce 也能过', githubCalls().length === 1);
  }

  // ---- 栈 6：错误 nonce / 缺 nonce / 未配 DISPATCH_NONCE 一律 401 ----
  reset();
  {
    const r1 = await onRequestPost({ request: makeReq({ job: 'refresh', nonce: 'wrong' }), env: makeEnv() });
    check('nonce 错误：401', r1.status === 401);
    const r2 = await onRequestPost({ request: makeReq({ job: 'refresh' }), env: makeEnv() });
    check('缺 nonce：401', r2.status === 401);
    const r3 = await onRequestPost({
      request: makeReq({ job: 'refresh', nonce: EO_NONCE }),
      env: makeEnv({ DISPATCH_NONCE: undefined }),
    });
    check('未配 DISPATCH_NONCE：401', r3.status === 401);
    check('三种失败都不调 GitHub', githubCalls().length === 0);
  }

  // ---- 栈 7：未配 CRON_SECRET 时 nonce 仍可用（降级模式） ----
  reset();
  {
    const r = await onRequestPost({
      request: makeReq({ job: 'refresh', nonce: EO_NONCE }),
      env: makeEnv({ CRON_SECRET: undefined }),
    });
    check('未配 CRON_SECRET 时 nonce 链路照常：200', r.status === 200);
  }

  // ---- 栈 8：GitHub 401（PAT 过期）→ 502 + 告警 + 不落闸 ----
  reset();
  state.githubStatus = 401;
  state.githubBody = '{"message":"Bad credentials"}';
  {
    const r = await onRequestPost({ request: makeReq({ job: 'refresh', nonce: EO_NONCE }), env: makeEnv() });
    const j = await r.json();
    check('GitHub 401 → 502', r.status === 502 && j.error === 'github_error' && j.status === 401);
    check('提示指向 PAT 过期', String(j.hint).includes('PAT'));
    check('告警邮件已发（alert=sent）', j.alert === 'sent');
    check('Brevo 被调用一次', brevoCalls().length === 1);
    const mail = JSON.parse(brevoCalls()[0].init.body);
    check('告警信收件人是 ALERT_EMAIL', mail.to[0].email === 'q@example.com');
    check('告警信主题带任务与状态', String(mail.subject).includes('refresh') && String(mail.subject).includes('401'));
    check('失败不落闸（当天可重试）', !globalThis.SUBS_KV._m.has(guardKey('refresh')));
  }

  // ---- 栈 9：GitHub 500 / 网络异常 ----
  reset();
  state.githubStatus = 500;
  state.githubBody = 'boom';
  {
    const r = await onRequestPost({ request: makeReq({ job: 'refresh', nonce: EO_NONCE }), env: makeEnv() });
    const j = await r.json();
    check('GitHub 500 → 502', r.status === 502 && j.status === 500);
    check('500 也发告警', j.alert === 'sent');
  }
  reset();
  // 场景 A：全网不通（GitHub 与 Brevo 都抛）——告警自己也发不出去，属预期
  globalThis.fetch = async (url) => {
    fetchCalls.push({ url: String(url), init: null });
    throw new Error('connect ECONNREFUSED');
  };
  {
    const r = await onRequestPost({ request: makeReq({ job: 'refresh', nonce: EO_NONCE }), env: makeEnv() });
    const j = await r.json();
    check('网络异常 → 502 dispatch_failed', r.status === 502 && j.error === 'dispatch_failed');
    check('响应带出口排查 hint', String(j.hint || '').includes('出口'));
    check('全网挂时告警报 failed（不假装成功）', j.alert === 'failed');
  }
  // 场景 B：只有 GitHub 不通，Brevo 正常——告警应发出
  reset();
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    fetchCalls.push({ url: u, init });
    if (u.includes('api.github.com')) throw new Error('connect ETIMEDOUT api.github.com');
    return stubResponse(state.brevoStatus, state.brevoBody);
  };
  {
    const r = await onRequestPost({ request: makeReq({ job: 'refresh', nonce: EO_NONCE }), env: makeEnv() });
    const j = await r.json();
    check('仅 GitHub 不通 → 502', r.status === 502 && j.error === 'dispatch_failed');
    check('仅 GitHub 不通时告警照常发出', j.alert === 'sent' && brevoCalls().length === 1);
  }
  // 还原 fetch 桩
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    fetchCalls.push({ url: u, init });
    if (u.includes('api.github.com')) return stubResponse(state.githubStatus, state.githubBody);
    if (u.includes('api.brevo.com')) return stubResponse(state.brevoStatus, state.brevoBody);
    throw new Error('unstubbed fetch: ' + u);
  };

  // ---- 栈 10：缺 GH_DISPATCH_TOKEN → 500，不外呼 ----
  reset();
  {
    const r = await onRequestPost({
      request: makeReq({ job: 'refresh', nonce: EO_NONCE }),
      env: makeEnv({ GH_DISPATCH_TOKEN: undefined }),
    });
    const j = await r.json();
    check('缺 PAT 环境变量：500 not_configured', r.status === 500 && j.error === 'not_configured');
    check('不外呼 GitHub', githubCalls().length === 0);
  }

  // ---- 栈 11：入参校验 ----
  reset();
  {
    const r1 = await onRequestPost({ request: makeReq({ job: 'nope', nonce: EO_NONCE }), env: makeEnv() });
    check('非法 job：400', r1.status === 400);
    const r2 = await onRequestPost({ request: makeReq({ job: 'broadcast', mode: 'nope', nonce: EO_NONCE }), env: makeEnv() });
    check('非法 mode：400', r2.status === 400);
    const r3 = await onRequestPost({ request: makeReq({ job: 'broadcast', mode: 'dry', nonce: EO_NONCE }), env: makeEnv() });
    const sent = lastGhBody();
    check('mode=dry 映射为 dry-run', r3.status === 200 && sent.inputs && sent.inputs.mode === 'dry-run');
    const r4 = await onRequestPost({ request: makeReq('null'), env: makeEnv() });
    check('body=null：400 不崩', r4.status === 400);
    const r5 = await onRequestPost({ request: makeReq('x'.repeat(5000)), env: makeEnv() });
    check('超大 body：413', r5.status === 413);
    const r6 = await onRequestPost({ request: makeReq('{oops'), env: makeEnv() });
    check('坏 JSON：400', r6.status === 400);
  }

  // ---- 栈 12：GET 405 ----
  {
    const r = await onRequestGet();
    check('GET：405', r.status === 405);
  }

  // ---- 栈 13：告警未配置时不影响 dispatch 结果 ----
  reset();
  state.githubStatus = 401;
  {
    const r = await onRequestPost({
      request: makeReq({ job: 'refresh', nonce: EO_NONCE }),
      env: makeEnv({ BREVO_API_KEY: undefined, MAIL_FROM: undefined, ALERT_EMAIL: undefined }),
    });
    const j = await r.json();
    check('未配告警仍返回 502 + alert=not_configured', r.status === 502 && j.alert === 'not_configured');
    check('未配告警时不调 Brevo', brevoCalls().length === 0);
  }

  // ---- 栈 14：KV 未绑定时未鉴权调用 fail closed，鉴权调用放行 ----
  reset();
  delete globalThis.SUBS_KV;
  {
    const r = await onRequestPost({ request: makeReq({ job: 'refresh', nonce: EO_NONCE }), env: makeEnv() });
    const j = await r.json();
    check('无 KV + nonce：500 guard_not_configured', r.status === 500 && j.error === 'guard_not_configured');
    check('fail closed 不外呼', githubCalls().length === 0);
    const r2 = await onRequestPost({
      request: makeReq({ job: 'refresh', cron_secret: 'cron-secret-123' }),
      env: makeEnv(),
    });
    check('无 KV + CRON_SECRET：照常放行', r2.status === 200);
  }

  // ---- 栈 15：edgeone.json 与代码/运行时不变量 ----
  {
    check('edgeone.json 有 2 条 schedule', SCHEDULES.length === 2, `实际 ${SCHEDULES.length}`);
    const byName = Object.fromEntries(SCHEDULES.map((s) => [s.name, s]));
    check('schedule 名：refresh-0750 / broadcast-0810', !!byName['refresh-0750'] && !!byName['broadcast-0810']);
    const rf = byName['refresh-0750'] || {};
    const bc = byName['broadcast-0810'] || {};
    check('两条都指向 /api/jobs/dispatch', rf.path === '/api/jobs/dispatch' && bc.path === '/api/jobs/dispatch');
    check('两条都是 POST', rf.method === 'POST' && bc.method === 'POST');
    check('cron 都是 5 段', /^\S+ \S+ \S+ \S+ \S+$/.test(rf.cron || '') && /^\S+ \S+ \S+ \S+ \S+$/.test(bc.cron || ''));
    check('cron 时刻 = 07:50 / 08:10', (rf.cron || '').startsWith('50 7 ') && (bc.cron || '').startsWith('10 8 '));
    check('时区显式 Asia/Shanghai', rf.timezone === 'Asia/Shanghai' && bc.timezone === 'Asia/Shanghai');
    check('refresh payload.job=refresh', rf.payload && rf.payload.job === 'refresh');
    check('broadcast payload.job=broadcast 且 mode=send', bc.payload && bc.payload.job === 'broadcast' && bc.payload.mode === 'send');
    check('nonce 非空', typeof EO_NONCE === 'string' && EO_NONCE.length >= 32, `len=${EO_NONCE.length}`);
    check('两条 schedule nonce 一致', rf.payload && bc.payload && rf.payload.nonce === bc.payload.nonce);
    check('cloudFunctions region 含 ap-guangzhou', Array.isArray(EO.cloudFunctions && EO.cloudFunctions.mainlandRegions) && EO.cloudFunctions.mainlandRegions.includes('ap-guangzhou'));
    const raw = readFileSync(new URL('../edgeone.json', import.meta.url), 'utf8');
    check('edgeone.json 不含非空 cron_secret（公开仓库禁带真 secret）', !/"cron_secret"\s*:\s*"[^"]+"/.test(raw));
  }

  // ---- 汇总 ----
  console.log(`\n${fail === 0 ? '全部通过' : '存在失败'}：${pass} 通过 / ${fail} 失败`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error('冒烟测试自身崩溃：', e);
  process.exit(1);
});
