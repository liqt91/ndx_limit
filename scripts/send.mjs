#!/usr/bin/env node
// 群发每日日报给订阅者（SMTP，服务商无关）。
// 适用于 Brevo（300/天永久免费）、Resend（100/天）、阿里云 DirectMail、腾讯云 SES、QQ/163 等任意 SMTP。
// 设计要点：
//   - 发信在 GitHub Actions（境外）执行，订阅者只需「收邮件」，全程不访问境外网站。
//   - 订阅者名单来自本站边缘函数（SUBSCRIBERS_URL 或 SUBSCRIBERS_FILE），邮箱绝不进仓库（见 .gitignore）。
//   - **每人一封**：正文按他的订阅范围裁剪（只订标普500 的人看不到纳指的那一节）。
//
// 环境变量：
//   SMTP_HOST / SMTP_PORT / SMTP_SECURE('true'|'false', 可省略按端口推断)
//   SMTP_USER / SMTP_PASS            SMTP 认证（Brevo: smtp-relay.brevo.com:587 + 登录名/密钥）
//   MAIL_FROM                        发件人，如 "QDII 开门日报 <digest@liqt91.top>"
//   SUBSCRIBERS_URL                  GET 返回 {subscribers:[{email,indices}]} 或 ["a@b.com"]
//   SUBSCRIBERS_TOKEN                若 SUBSCRIBERS_URL 需要鉴权，会以 Bearer 头发送
//   SUBSCRIBERS_FILE                 本地 JSON / CSV / 换行分隔 文件（手动测试用）
//   RATE_DELAY_MS                    每封间隔毫秒（默认 200，避免触发频率限制）
//   UNSUBSCRIBE_URL                  退订接口，如 https://qdii.liqt91.top/api/unsubscribe
//   UNSUB_SECRET                     与 EdgeOne 环境变量同名同值，用于签退订链接
//   UNSUBSCRIBE_MAILTO               退订邮箱（可选），会一起写进 List-Unsubscribe 头
//   DIGEST_EDITION                   close（默认，收盘前报）| morning（盘前报，人工补发用）
//   DIGEST_INDICES                   本次允许发的指数，逗号分隔（由 check-freshness 的 usable 输出决定）
//
// 用法：
//   node scripts/send.mjs --dry-run              只打印，不发送
//   node scripts/send.mjs                        真正发送
//   node scripts/send.mjs --edition=morning      发盘前报
//   node scripts/send.mjs --indices=标普500      只发标普500（数据不可用的指数会被自动剔除）
//
// ★ 版次口径：生产每天只发一封，14:45 的**收盘前报**（场外 15:00 截止）。
//   「早报」是历史叫法，08:10 的调度已于 2026-10-21 下线，代码里不要再按「早间视角」描述默认行为。

import fs from 'node:fs';
import nodemailer from 'nodemailer';
import { buildDailyDigest, composeEmail, INDEX_KEYS, INDEX_LABEL, DEFAULT_EDITION, NDX } from './digest.mjs';
import { parseSubscriberValue, planRecipients, countByIndex, normalizeIndices } from './broadcast-plan.mjs';
import { unsubLink } from './unsub.mjs';

const DRY = process.argv.includes('--dry-run');
const argOf = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : '';
};
const EDITION =
  argOf('edition') || process.env.DIGEST_EDITION || DEFAULT_EDITION;
const HOST = process.env.SMTP_HOST || '';
const PORT = Number(process.env.SMTP_PORT || 587);
const SECURE =
  process.env.SMTP_SECURE != null
    ? String(process.env.SMTP_SECURE).toLowerCase() === 'true'
    : PORT === 465;
const USER = process.env.SMTP_USER || '';
const PASS = process.env.SMTP_PASS || '';
const FROM = process.env.MAIL_FROM || '';
const SUB_URL = process.env.SUBSCRIBERS_URL || '';
const SUB_TOKEN = process.env.SUBSCRIBERS_TOKEN || '';
const SUB_FILE = process.env.SUBSCRIBERS_FILE || '';
const DELAY = Number(process.env.RATE_DELAY_MS ?? 200);
const UNSUB = process.env.UNSUBSCRIBE_MAILTO || '';
const UNSUB_URL = (process.env.UNSUBSCRIBE_URL || '').replace(/\/+$/, '');
const UNSUB_SECRET = process.env.UNSUB_SECRET || '';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const linkFor = (email) => unsubLink(email, UNSUB_URL, UNSUB_SECRET);

// 只保留认得出来的指数；一个都不认 → 不猜，按「全部」交给下游（下游还有健康过滤）。
const REQUESTED = normalizeIndices(argOf('indices') || process.env.DIGEST_INDICES || INDEX_KEYS, {
  fallback: INDEX_KEYS,
});

// 把各种名单形状都拉平成 [{email, indices}]。
// 老名单（纯邮箱）走 parseSubscriberValue → 只订纳指；这是刻意的兼容，不是偷懒。
function toSubscribers(data) {
  const out = [];
  const push = (v) => {
    if (typeof v === 'string') {
      const p = parseSubscriberValue(v);
      if (p) out.push(p);
      return;
    }
    if (v && typeof v === 'object') {
      const email = String(v.email || v.email_address || v.address || '').trim().toLowerCase();
      if (!email) return;
      const p = parseSubscriberValue(JSON.stringify({ email, indices: v.indices }));
      if (p) out.push(p);
    }
  };
  if (Array.isArray(data)) data.forEach(push);
  else if (data && Array.isArray(data.subscribers)) data.subscribers.forEach(push);
  else if (data && Array.isArray(data.emails)) data.emails.forEach(push);
  else if (typeof data === 'string') push(data);
  return out;
}

function parseRaw(text) {
  const t = text.trim();
  if (!t) return [];
  if (t.startsWith('[') || t.startsWith('{')) {
    try {
      return toSubscribers(JSON.parse(t));
    } catch {
      /* fall through to CSV */
    }
  }
  // CSV / 换行分隔：只有邮箱，没有偏好 → 全部按老记录处理（只订纳指）
  return t
    .split(/[\n,;\t]+/)
    .map((s) => parseSubscriberValue(s.trim().replace(/^"|"$/g, '')))
    .filter(Boolean);
}

async function loadSubscribers() {
  if (!SUB_URL && !SUB_FILE) {
    // dry-run 只预览正文，没有名单也允许跑；真发时缺名单必须失败，不能「假装发过了」。
    if (DRY) {
      console.log('ℹ 未配置名单来源，dry-run 仅预览正文。');
      return [];
    }
    throw new Error('未配置订阅名单来源（SUBSCRIBERS_URL / SUBSCRIBERS_FILE），拒绝「假装发过了」');
  }
  let raw = [];
  if (SUB_URL) {
    const r = await fetch(SUB_URL, SUB_TOKEN ? { headers: { Authorization: `Bearer ${SUB_TOKEN}` } } : undefined);
    if (!r.ok) throw new Error(`SUBSCRIBERS_URL HTTP ${r.status}`);
    const ct = r.headers.get('content-type') || '';
    const body = await r.text();
    raw = ct.includes('json') ? toSubscribers(JSON.parse(body)) : parseRaw(body);
  } else if (SUB_FILE) {
    raw = parseRaw(fs.readFileSync(SUB_FILE, 'utf8'));
  }
  // 规整 + 去重（同一邮箱以第一次出现为准）+ 校验
  const seen = new Set();
  const list = [];
  for (const s of raw) {
    const email = String(s.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email) || seen.has(email)) continue;
    seen.add(email);
    list.push({ email, indices: normalizeIndices(s.indices, { fallback: [NDX] }) });
  }
  return list;
}

async function main() {
  const edition = EDITION === 'morning' ? 'morning' : 'close';
  const digests = {};
  for (const k of INDEX_KEYS) digests[k] = buildDailyDigest({ edition, indexKey: k });

  // 可用指数 = 「数据健康」∩「本次允许（门禁 usable）」。
  // ★ 健康与否按指数各判各的：纳指覆盖率不达标不该让标普500 的读者收不到信心，
  //   但反过来也绝不能用旧数据凑数——不可用的指数在这一步就被剔掉，不会进任何一封信。
  const usable = INDEX_KEYS.filter((k) => REQUESTED.includes(k) && digests[k].healthy);
  if (!usable.length) {
    const detail = INDEX_KEYS.map((k) => `- ${INDEX_LABEL[k]}：${digests[k].text || '无内容'}`).join('\n');
    console.log(`ℹ 没有一个指数可发（数据不健康），本次不群发。\n${detail}`);
    // dry-run 只打印；真发时用它兜住「门禁被绕过」的情况，让失败可见而不是静默成功。
    if (!DRY) process.exit(2);
    return;
  }
  for (const k of INDEX_KEYS) {
    if (usable.includes(k)) continue;
    const why = REQUESTED.includes(k) ? digests[k].text || '数据不可用' : '不在本次发送范围（DIGEST_INDICES）';
    console.log(`⚠ ${INDEX_LABEL[k]} 本次不发：${why}`);
  }

  const subs = await loadSubscribers();
  const { recipients, skipped } = planRecipients({ subscribers: subs, usable });
  const perIndex = countByIndex(recipients);

  console.log(`[${edition}] 可用指数：${usable.map((k) => INDEX_LABEL[k]).join(' + ')}`);
  console.log(
    `订阅者: ${subs.length} 人 → 实发 ${recipients.length} 人` +
      `（纳指100 ${perIndex['纳斯达克100']} / 标普500 ${perIndex['标普500']}）` +
      (skipped.length ? `，跳过 ${skipped.length} 人（所订指数的数据今天不可用）` : '')
  );
  if (!UNSUB_URL || !UNSUB_SECRET) {
    // 静默缺失最麻烦：日报发出去了、却没有退订口，收件人只能点「举报垃圾邮件」
    console.log('⚠ 未配置 UNSUBSCRIBE_URL / UNSUB_SECRET：日报里将不带退订链接。');
  }

  // 正文按「指数组合」缓存：订阅者通常只有两三种组合，不必为每个人重算一遍
  const cache = new Map();
  const emailFor = (indices) => {
    const key = indices.join('|');
    if (!cache.has(key)) cache.set(key, composeEmail({ digests, indices }));
    return cache.get(key);
  };

  // 预览：挑「订阅范围最窄」的那个人打印——只有这样才能看出裁剪真的生效了
  // （打印一位两个指数都订的订阅者，看不出「只订标普500 的人收到的信里没有纳指」）。
  const sample = recipients.length
    ? recipients.reduce((best, r) => (!best || r.indices.length < best.indices.length ? r : best), null)
    : null;
  const preview = sample ? emailFor(sample.indices) : composeEmail({ digests, indices: usable });
  console.log(`预览：${sample ? `${sample.email}（订 ${sample.indices.map((k) => INDEX_LABEL[k]).join(' + ')}）` : '无人订阅，按全部可用指数'}`);
  console.log('---');
  console.log(`subject: ${preview.subject}`);
  console.log(preview.text);
  console.log('---');

  if (DRY) {
    console.log('\nℹ dry-run，未发送。');
    return;
  }
  if (!recipients.length) {
    console.log('ℹ 无可发订阅者，未发送。');
    return;
  }
  if (!HOST || !FROM) {
    console.error('✗ 未配置 SMTP_HOST / MAIL_FROM，无法发信。本地预览请用 --dry-run。');
    process.exit(2);
  }

  const transport = nodemailer.createTransport({
    host: HOST,
    port: PORT,
    secure: SECURE,
    auth: USER ? { user: USER, pass: PASS } : undefined,
  });

  let ok = 0;
  let fail = 0;
  for (let i = 0; i < recipients.length; i++) {
    const { email: to, indices } = recipients[i];
    const mail = emailFor(indices);
    const link = linkFor(to);
    const body = link
      ? `${mail.text}\n\n——\n退订：${link}\n（点一下就把这个地址从名单里删掉，之后不再收到日报。）`
      : mail.text;
    const headers = {};
    if (link) headers['List-Unsubscribe'] = `<${link}>${UNSUB ? `, <mailto:${UNSUB}>` : ''}`;
    else if (UNSUB) headers['List-Unsubscribe'] = `<mailto:${UNSUB}>`;
    try {
      await transport.sendMail({ from: FROM, to, subject: mail.subject, text: body, headers });
      ok++;
      process.stdout.write(`\r发送中 ${i + 1}/${recipients.length}  成功 ${ok}  失败 ${fail}`);
    } catch (e) {
      fail++;
      console.error(`\n✗ ${to} 失败：${e.message || e}`);
    }
    if (i < recipients.length - 1 && DELAY > 0) await new Promise((r) => setTimeout(r, DELAY));
  }
  console.log(`\n✓ 完成：成功 ${ok}，失败 ${fail}。`);
  if (ok === 0 && fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error('✗ 群发失败：', e.message || e);
  process.exit(1);
});
