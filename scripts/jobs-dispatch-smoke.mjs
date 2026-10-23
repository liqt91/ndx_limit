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
import { onRequestGet as statusGet, onRequestPost as statusPost } from '../edge-functions/api/jobs/status.js';
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
function guardKey(job, slot = 'preopen') {
  return `job_sent_${job}_${slot}_${CST_TODAY}`;
}
function rejected() {
  const raw = globalThis.SUBS_KV._m.get(`job_rejected_${CST_TODAY}`);
  return raw ? JSON.parse(raw) : null;
}
function events() {
  const raw = globalThis.SUBS_KV._m.get('job_events');
  return raw ? JSON.parse(raw) : [];
}
function makeStatusEnv(over = {}) {
  return { SUBS_KV: globalThis.SUBS_KV, GH_DISPATCH_TOKEN: 'ghp_test_token', CRON_SECRET: 'cron-secret-123', ALERT_EMAIL: 'q@example.com', ...over };
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
    check('响应带 slot=preopen（默认）', j.slot === 'preopen', JSON.stringify(j));
    check('每日闸 key 已写（带 slot）', globalThis.SUBS_KV._m.has(guardKey('refresh', 'preopen')));
    const rawGuard = globalThis.SUBS_KV._m.get(guardKey('refresh', 'preopen'));
    const gv = rawGuard ? JSON.parse(rawGuard) : {};
    check('闸 key 记录 via=nonce', gv.via === 'nonce');
    const evs = events();
    check('事件流水写了 1 条', evs.length === 1, JSON.stringify(evs));
    check('事件字段齐全（job/slot/via/status/ok/alert）', evs[0] && evs[0].job === 'refresh' && evs[0].slot === 'preopen' && evs[0].via === 'nonce' && evs[0].status === 204 && evs[0].ok === true && evs[0].alert === null && typeof evs[0].at === 'string', JSON.stringify(evs[0]));
  }

  // ---- 栈 2a：同一 job 同一 slot 当天第二次（nonce）被闸拦下 ----
  // ★ 409 不再写事件流水，只累加「今日被拒」计数：流水只有 50 条，被刷时会被灌满
  {
    const r = await onRequestPost({ request: makeReq({ job: 'refresh', nonce: EO_NONCE }), env: makeEnv() });
    const j = await r.json();
    check('refresh 当天第二次：409', r.status === 409 && j.error === 'already_triggered_today', `status=${r.status}`);
    check('409 响应带 slot', j.slot === 'preopen', JSON.stringify(j));
    check('被拦下时不再调 GitHub', githubCalls().length === 1);
    check('409 不写事件流水（流水仍是 1 条）', events().length === 1, JSON.stringify(events()));
    const rj = rejected();
    check('409 计入今日被拒：n=1、lastError/lastStatus 正确', !!rj && rj.n === 1 && rj.lastError === 'already_triggered_today' && rj.lastStatus === 409, JSON.stringify(rj));
  }

  // ---- 栈 2b：另外两个时点（09:40 早盘 / 14:30 收盘前）各自的闸键独立 ----
  // 这是「一天三抓」的核心：闸键不带 slot 时，09:40 与 14:30 都会被 409 静默挡掉
  {
    const r = await onRequestPost({ request: makeReq({ job: 'refresh', slot: 'intraday', nonce: EO_NONCE }), env: makeEnv() });
    const j = await r.json();
    check('refresh slot=intraday（09:40）放行：200', r.status === 200 && j.ok === true && j.slot === 'intraday', `status=${r.status}`);
    check('intraday 闸 key 独立已写', globalThis.SUBS_KV._m.has(guardKey('refresh', 'intraday')));
    const r2 = await onRequestPost({ request: makeReq({ job: 'refresh', slot: 'close', nonce: EO_NONCE }), env: makeEnv() });
    const j2 = await r2.json();
    check('refresh slot=close 放行：200', r2.status === 200 && j2.ok === true && j2.slot === 'close', `status=${r2.status}`);
    check('close 抓取又调了一次 GitHub（累计 3 次）', githubCalls().length === 3);
    check('close 闸 key 独立已写', globalThis.SUBS_KV._m.has(guardKey('refresh', 'close')));
    check('preopen 闸 key 未被改写', globalThis.SUBS_KV._m.has(guardKey('refresh', 'preopen')));
    check('三次抓取共 3 条流水（每次都是真业务终态）', events().length === 3, `len=${events().length}`);
  }

  // ---- 栈 2c：slot 写错不静默归一，直接 400 ----
  // 静默归一到 preopen 的后果：那个时点被前面那次占掉，整天静默少抓一次
  {
    const r = await onRequestPost({ request: makeReq({ job: 'refresh', slot: 'morning', nonce: EO_NONCE }), env: makeEnv() });
    const j = await r.json();
    check('refresh slot 用旧值 morning：400 bad_slot', r.status === 400 && j.error === 'bad_slot', `status=${r.status}`);
    check('bad_slot 不调 GitHub', githubCalls().length === 3);
    const rj = rejected();
    check('bad_slot 计入今日被拒', !!rj && rj.lastError === 'bad_slot' && rj.lastStatus === 400, JSON.stringify(rj));
  }

  // ---- 栈 3：broadcast 正常链路，默认 mode=send、edition=close ----
  reset();
  {
    const r = await onRequestPost({ request: makeReq({ job: 'broadcast', nonce: EO_NONCE }), env: makeEnv() });
    const j = await r.json();
    check('broadcast 受理：200 ok', r.status === 200 && j.ok === true);
    const sent = lastGhBody();
    check('broadcast inputs.mode=send', sent.inputs && sent.inputs.mode === 'send');
    check('broadcast 默认透传 inputs.edition=close', sent.inputs && sent.inputs.edition === 'close', JSON.stringify(sent.inputs));
    check('broadcast 闸 key 已写', globalThis.SUBS_KV._m.has(guardKey('broadcast', 'close')));
    const r2 = await onRequestPost({ request: makeReq({ job: 'broadcast', nonce: EO_NONCE }), env: makeEnv() });
    check('broadcast 同 slot 当天第二次：409', r2.status === 409);
    check('refresh 与 broadcast 闸互不干扰', !globalThis.SUBS_KV._m.has(guardKey('refresh', 'preopen')) && !globalThis.SUBS_KV._m.has(guardKey('refresh', 'close')));
  }

  // ---- 栈 3b：未鉴权发盘前报 → 403（盘前报 schedule 已下线，闸键还在，不挡就能凭空多发一封） ----
  reset();
  {
    const r = await onRequestPost({ request: makeReq({ job: 'broadcast', mode: 'send', edition: 'morning', nonce: EO_NONCE }), env: makeEnv() });
    const j = await r.json();
    check('未鉴权 edition=morning：403 slot_not_scheduled', r.status === 403 && j.error === 'slot_not_scheduled', `status=${r.status}`);
    check('越权组合不调 GitHub', githubCalls().length === 0);
    check('越权组合不落闸', !globalThis.SUBS_KV._m.has(guardKey('broadcast', 'morning')));
    const rj = rejected();
    check('越权组合计入今日被拒', !!rj && rj.lastError === 'slot_not_scheduled' && rj.lastStatus === 403, JSON.stringify(rj));
  }

  // ---- 栈 3c：带 CRON_SECRET 的盘前报手动重跑不受组合白名单限制 ----
  {
    const r = await onRequestPost({ request: makeReq({ job: 'broadcast', mode: 'send', edition: 'morning', cron_secret: 'cron-secret-123' }), env: makeEnv() });
    const j = await r.json();
    check('鉴权后 edition=morning 放行：200', r.status === 200 && j.ok === true && j.slot === 'morning', `status=${r.status}`);
    const sent = lastGhBody();
    check('手动补发盘前报透传 edition=morning', sent.inputs && sent.inputs.edition === 'morning', JSON.stringify(sent.inputs));
  }

  // ---- 栈 3d：收盘前报（edition=close）独立触发并透传 ----
  reset();
  {
    const r = await onRequestPost({ request: makeReq({ job: 'broadcast', mode: 'send', edition: 'close', nonce: EO_NONCE }), env: makeEnv() });
    const j = await r.json();
    check('下午报受理：200', r.status === 200 && j.ok === true && j.slot === 'close', `status=${r.status}`);
    const sent = lastGhBody();
    check('收盘前报透传 inputs.edition=close', sent.inputs && sent.inputs.edition === 'close' && sent.inputs.mode === 'send', JSON.stringify(sent.inputs));
    check('收盘前报闸 key 独立已写', globalThis.SUBS_KV._m.has(guardKey('broadcast', 'close')));
    check('下午报事件带 slot=close', events()[0] && events()[0].slot === 'close', JSON.stringify(events()[0]));
  }

  // ---- 栈 4：CRON_SECRET 鉴权（body）绕过每日闸 ----
  reset();
  globalThis.SUBS_KV.put(guardKey('refresh', 'preopen'), '{"seeded":true}');
  {
    const before = globalThis.SUBS_KV._m.get(guardKey('refresh', 'preopen'));
    const r = await onRequestPost({
      request: makeReq({ job: 'refresh', cron_secret: 'cron-secret-123' }),
      env: makeEnv(),
    });
    const j = await r.json();
    check('带 cron_secret 绕过闸：200', r.status === 200 && j.ok === true, `status=${r.status}`);
    check('绕过时仍调 GitHub', githubCalls().length === 1);
    check('绕过不改写已有闸 key', globalThis.SUBS_KV._m.get(guardKey('refresh', 'preopen')) === before);
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
    check('401 不写事件流水（流水为空）', events().length === 0, JSON.stringify(events()));
    const rj = rejected();
    check('连续 3 次 401 只累加计数：n=3', !!rj && rj.n === 3 && rj.lastStatus === 401 && rj.lastError === 'unauthorized', JSON.stringify(rj));
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
    check('失败不落闸（当天可重试）', !globalThis.SUBS_KV._m.has(guardKey('refresh', 'preopen')));
    const evs = events();
    check('失败也写事件流水（面板可见）', evs.length === 1 && evs[0].ok === false && evs[0].status === 401 && evs[0].alert === 'sent', JSON.stringify(evs));
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
    check('edgeone.json 有 4 条 schedule（三抓一报）', SCHEDULES.length === 4, `实际 ${SCHEDULES.length}`);
    const byName = Object.fromEntries(SCHEDULES.map((s) => [s.name, s]));
    check(
      'schedule 名：refresh-0750 / refresh-0940 / refresh-1430 / broadcast-1445',
      !!byName['refresh-0750'] && !!byName['refresh-0940'] && !!byName['refresh-1430'] && !!byName['broadcast-1445']
    );
    check('08:10 的早报 schedule 已下线（现只有 14:45 收盘前报）', !byName['broadcast-0810']);
    const rf = byName['refresh-0750'] || {};
    const rf15 = byName['refresh-0940'] || {};
    const rf2 = byName['refresh-1430'] || {};
    const bc2 = byName['broadcast-1445'] || {};
    const all = [rf, rf15, rf2, bc2];
    check('四条都指向 /api/jobs/dispatch', all.every((s) => s.path === '/api/jobs/dispatch'));
    check('四条都是 POST', all.every((s) => s.method === 'POST'));
    check('cron 都是 5 段', all.every((s) => /^\S+ \S+ \S+ \S+ \S+$/.test(s.cron || '')));
    check('cron 时刻 = 07:50 / 09:40 / 14:30 / 14:45', (rf.cron || '').startsWith('50 7 ') && (rf15.cron || '').startsWith('40 9 ') && (rf2.cron || '').startsWith('30 14 ') && (bc2.cron || '').startsWith('45 14 '));
    check('时区显式 Asia/Shanghai', all.every((s) => s.timezone === 'Asia/Shanghai'));
    check('refresh payload.job=refresh 且三个时点各不相同', rf.payload && rf.payload.job === 'refresh' && rf.payload.slot === 'preopen' && rf15.payload && rf15.payload.slot === 'intraday' && rf2.payload && rf2.payload.slot === 'close');
    check('broadcast payload.job=broadcast 且 mode=send、显式 edition=close', bc2.payload && bc2.payload.job === 'broadcast' && bc2.payload.mode === 'send' && bc2.payload.edition === 'close');
    check('nonce 非空', typeof EO_NONCE === 'string' && EO_NONCE.length >= 32, `len=${EO_NONCE.length}`);
    check('四条 schedule nonce 一致', all.every((s) => s.payload && s.payload.nonce === EO_NONCE));
    check('cloudFunctions region 含 ap-guangzhou', Array.isArray(EO.cloudFunctions && EO.cloudFunctions.mainlandRegions) && EO.cloudFunctions.mainlandRegions.includes('ap-guangzhou'));
    const raw = readFileSync(new URL('../edgeone.json', import.meta.url), 'utf8');
    check('edgeone.json 不含非空 cron_secret（公开仓库禁带真 secret）', !/"cron_secret"\s*:\s*"[^"]+"/.test(raw));

    // ★ 跨文件不变量：调度表里的每个 (job, slot) 必须真被 dispatch 接受，
    // 否则 schedule 会被 400/403 静默挡掉——这是本项目最容易复发的一类错（配了但没生效）。
    const REFRESH_SLOTS = ['preopen', 'intraday', 'close'];
    const BROADCAST_SLOTS = ['close'];
    check(
      '调度表 slot 全在 dispatch 白名单内',
      rf.payload.slot === 'preopen' &&
        rf15.payload.slot === 'intraday' &&
        rf2.payload.slot === 'close' &&
        REFRESH_SLOTS.includes(rf15.payload.slot) &&
        BROADCAST_SLOTS.includes(bc2.payload.edition)
    );
    // 未鉴权组合白名单必须覆盖全部 schedule（少一条 → 那条 schedule 每次 403）
    reset();
    for (const s of all) {
      const body = { job: s.payload.job, nonce: EO_NONCE };
      if (s.payload.job === 'refresh') body.slot = s.payload.slot;
      else {
        body.mode = s.payload.mode;
        body.edition = s.payload.edition;
      }
      const r = await onRequestPost({ request: makeReq(body), env: makeEnv() });
      check(`${s.name} 的 payload 未鉴权即可通过（不是 403）`, r.status === 200, `status=${r.status}`);
    }
  }

  // ---- 栈 16：事件流水细节 + /api/jobs/status 只读端点 ----
  reset();
  {
    // 16a 匿名 401 **不写**事件流水（改为计数）：流水 50 条，被刷时会灌满、
    // 把「今天四跳触没触发」的视野冲掉——监控被噪声挤掉比被刷本身更严重
    const r = await onRequestPost({ request: makeReq({ job: 'refresh', nonce: 'wrong' }), env: makeEnv() });
    check('匿名失败：401', r.status === 401);
    let evs = events();
    check('401 不写事件流水', evs.length === 0, JSON.stringify(evs));
    let rj = rejected();
    check('401 计入今日被拒（n=1）', !!rj && rj.n === 1 && rj.lastError === 'unauthorized', JSON.stringify(rj));

    // 16b 每日闸拦下（409）同样只计数
    globalThis.SUBS_KV.put(guardKey('refresh', 'preopen'), '{"seeded":true}');
    const r2 = await onRequestPost({ request: makeReq({ job: 'refresh', nonce: EO_NONCE }), env: makeEnv() });
    check('闸拦下：409', r2.status === 409);
    evs = events();
    check('409 也不写事件流水', evs.length === 0, JSON.stringify(evs));
    rj = rejected();
    check('409 累加计数（n=2）', !!rj && rj.n === 2 && rj.lastStatus === 409, JSON.stringify(rj));

    // 16c 流水上限 50：塞满 50 条旧事件后再成功一次，长度不变、最新在最前
    const seeded = Array.from({ length: 50 }, (_, i) => ({ at: new Date(Date.now() - (i + 1) * 60000).toISOString(), job: 'refresh', via: 'nonce', status: 204, ok: true, alert: null }));
    globalThis.SUBS_KV.put('job_events', JSON.stringify(seeded));
    const r3 = await onRequestPost({ request: makeReq({ job: 'broadcast', cron_secret: 'cron-secret-123' }), env: makeEnv() });
    check('鉴权重跑：200', r3.status === 200);
    evs = events();
    check('流水截断在 50 条', evs.length === 50, `len=${evs.length}`);
    check('最新事件在最前', evs[0].job === 'broadcast' && evs[0].via === 'cron_secret' && evs[0].mode === 'send', JSON.stringify(evs[0]));
  }

  // 16d status 端点：KV 有闸 key + 流水时全量返回（jobs 按 job×slot 双层结构）
  reset();
  globalThis.SUBS_KV.put(guardKey('refresh', 'preopen'), JSON.stringify({ at: '2026-10-21T07:50:01Z', via: 'nonce', mode: null, slot: 'preopen' }));
  globalThis.SUBS_KV.put(guardKey('refresh', 'intraday'), JSON.stringify({ at: '2026-10-21T09:41:00Z', via: 'nonce', mode: null, slot: 'intraday' }));
  globalThis.SUBS_KV.put(guardKey('refresh', 'close'), JSON.stringify({ at: '2026-10-21T14:31:00Z', via: 'nonce', mode: null, slot: 'close' }));
  globalThis.SUBS_KV.put('job_rejected_' + CST_TODAY, JSON.stringify({ n: 7, first: '2026-10-21T01:00:00Z', last: '2026-10-21T05:00:00Z', lastError: 'unauthorized', lastStatus: 401, lastJob: 'broadcast', lastSlot: 'morning' }));
  globalThis.SUBS_KV.put(
    'job_events',
    JSON.stringify([
      { at: new Date().toISOString(), job: 'refresh', slot: 'close', mode: null, via: 'nonce', status: 204, ok: true, error: null, alert: null },
      { at: new Date(Date.now() - 3600e3).toISOString(), job: 'refresh', slot: 'intraday', mode: null, via: 'nonce', status: 401, ok: false, error: 'github_error', alert: 'sent' },
    ])
  );
  {
    const r = await statusGet({ env: makeStatusEnv() });
    const j = await r.json();
    check('status GET：200 ok', r.status === 200 && j.ok === true);
    check('cstToday 与测试同源', j.cstToday === CST_TODAY, j.cstToday);
    const rj = j.jobs.refresh || {}; // 防呆：status 少报槽位时断言要「红」，不能取 undefined 属性崩掉
    const bj = j.jobs.broadcast || {};
    check('refresh 盘前今日已触发', !!rj.preopen && rj.preopen.dispatchedToday === true && rj.preopen.via === 'nonce' && rj.preopen.at === '2026-10-21T07:50:01Z', JSON.stringify(j.jobs));
    check('refresh 早盘今日已触发', !!rj.intraday && rj.intraday.dispatchedToday === true && rj.intraday.at === '2026-10-21T09:41:00Z', JSON.stringify(j.jobs));
    check('refresh 收盘前今日已触发', !!rj.close && rj.close.dispatchedToday === true && rj.close.at === '2026-10-21T14:31:00Z', JSON.stringify(j.jobs));
    check('refresh 恰好三个时点（preopen/intraday/close）', Object.keys(j.jobs.refresh || {}).join(',') === 'preopen,intraday,close', Object.keys(j.jobs.refresh || {}).join(','));
    check('broadcast 两个时点今日都未触发', !!bj.morning && !!bj.close && bj.morning.dispatchedToday === false && bj.close.dispatchedToday === false && bj.morning.at === null, JSON.stringify(j.jobs));
    check('今日被拒计数原样暴露', !!j.rejected && j.rejected.n === 7 && j.rejected.lastError === 'unauthorized' && j.rejected.lastJob === 'broadcast', JSON.stringify(j.rejected));
    check('事件流水按原序返回（最新在前）', Array.isArray(j.events) && j.events.length === 2 && j.events[0].job === 'refresh' && j.events[0].slot === 'close' && j.events[0].ok === true, JSON.stringify(j.events));
    check('告警摘要取最近一条带 alert 的事件', j.alerts && j.alerts.last && j.alerts.last.alert === 'sent' && j.alerts.last.status === 401, JSON.stringify(j.alerts));
    check('config 只暴露布尔', j.config && j.config.ghToken === true && j.config.cronSecret === true && j.config.alertEmail === true && Object.values(j.config).every((v) => typeof v === 'boolean'), JSON.stringify(j.config));
    check('config 不含任何 secret 值', !JSON.stringify(j).includes('ghp_test_token') && !JSON.stringify(j).includes('cron-secret-123'));
    const rp = await statusPost();
    check('status POST：405', rp.status === 405);
  }

  // 16e KV 未绑定 → 500，不把「看不见」伪装成「没触发」
  delete globalThis.SUBS_KV;
  {
    const r = await statusGet({ env: {} });
    const j = await r.json();
    check('无 KV：500 kv_not_configured', r.status === 500 && j.error === 'kv_not_configured', `status=${r.status}`);
  }
  // 16f 流水损坏（非 JSON 数组）不崩，按空处理
  reset();
  globalThis.SUBS_KV.put('job_events', '{"not":"array"}');
  {
    const r = await statusGet({ env: makeStatusEnv() });
    const j = await r.json();
    check('流水损坏按空处理', r.status === 200 && j.ok === true && Array.isArray(j.events) && j.events.length === 0, JSON.stringify(j.events));
  }

  // ---- 汇总 ----
  console.log(`\n${fail === 0 ? '全部通过' : '存在失败'}：${pass} 通过 / ${fail} 失败`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error('冒烟测试自身崩溃：', e);
  process.exit(1);
});
