#!/usr/bin/env node
// 群发每日日报给所有订阅者（SMTP，服务商无关）。
// 适用于 Brevo（300/天永久免费）、Resend（100/天）、阿里云 DirectMail、腾讯云 SES、QQ/163 等任意 SMTP。
// 设计要点：
//   - 发信在 GitHub Actions（境外）执行，订阅者只需「收邮件」，全程不访问境外网站。
//   - 订阅者名单来自国内表单的导出/接口（SUBSCRIBERS_URL 或 SUBSCRIBERS_FILE），
//     邮箱绝不进仓库（见 .gitignore）。
//
// 环境变量：
//   SMTP_HOST / SMTP_PORT / SMTP_SECURE('true'|'false', 可省略按端口推断)
//   SMTP_USER / SMTP_PASS            SMTP 认证（Brevo: smtp-relay.brevo.com:587 + 登录名/密钥）
//   MAIL_FROM                        发件人，如 "纳指开门日报 <digest@liqt91.top>"
//   SUBSCRIBERS_URL                  GET 返回 JSON：["a@b.com"] / {"emails":[...]} / [{email}...]
//   SUBSCRIBERS_TOKEN                若 SUBSCRIBERS_URL 需要鉴权，会以 Bearer 头发送
//   SUBSCRIBERS_FILE                 本地 JSON / CSV / 换行分隔 文件（手动测试用）
//   RATE_DELAY_MS                    每封间隔毫秒（默认 200，避免触发频率限制）
//   UNSUBSCRIBE_URL                  退订接口，如 https://ndx.liqt91.top/api/unsubscribe
//   UNSUB_SECRET                     与 EdgeOne 环境变量同名同值，用于签退订链接
//   UNSUBSCRIBE_MAILTO               退订邮箱（可选），会一起写进 List-Unsubscribe 头
//
// 用法：
//   node scripts/send.mjs --dry-run   只打印，不发送
//   node scripts/send.mjs             真正发送
//
// 版次（edition）：
//   morning（默认）早报；close 下午报（收盘前，先给当日快照再给「较今晨」）。
//   用 --edition=close 或环境变量 DIGEST_EDITION=close 指定。
//   定时侧怎么传见 docs/ops/双时点抓取与下午报接入.md——本期不改调度配置。

import fs from 'node:fs';
import nodemailer from 'nodemailer';
import { buildDailyDigest } from './digest.mjs';
import { unsubLink } from './unsub.mjs';

const DRY = process.argv.includes('--dry-run');
const EDITION =
  (process.argv.find((a) => a.startsWith('--edition=')) || '').split('=')[1] ||
  process.env.DIGEST_EDITION ||
  'morning';
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

function toEmailList(data) {
  const out = [];
  const push = (v) => {
    if (typeof v === 'string') out.push(v);
    else if (v && typeof v === 'object') out.push(v.email || v.email_address || v.address || '');
  };
  if (Array.isArray(data)) data.forEach(push);
  else if (data && Array.isArray(data.emails)) data.emails.forEach(push);
  else if (data && Array.isArray(data.subscribers)) data.subscribers.forEach(push);
  else if (typeof data === 'string') out.push(data);
  return out;
}

function parseRaw(text) {
  const t = text.trim();
  if (!t) return [];
  if (t.startsWith('[') || t.startsWith('{')) {
    try {
      return toEmailList(JSON.parse(t));
    } catch {
      /* fall through to CSV */
    }
  }
  // CSV / 换行分隔
  return t
    .split(/[\n,;\t]+/)
    .map((s) => s.trim().replace(/^"|"$/g, ''))
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
    raw = ct.includes('json') ? toEmailList(JSON.parse(body)) : parseRaw(body);
  } else if (SUB_FILE) {
    raw = parseRaw(fs.readFileSync(SUB_FILE, 'utf8'));
  }
  // 规整 + 去重 + 校验
  const seen = new Set();
  const list = [];
  for (const e of raw) {
    const s = String(e || '').trim().toLowerCase();
    if (!EMAIL_RE.test(s) || seen.has(s)) continue;
    seen.add(s);
    list.push(s);
  }
  return list;
}

async function main() {
  const d = buildDailyDigest({ edition: EDITION === 'close' ? 'close' : 'morning' });
  if (!d.healthy) {
    console.log(`ℹ 数据不健康（覆盖率不足），本次不群发。\n${d.text}`);
    // dry-run 只打印；真发时用它兜住「门禁被绕过」的情况，让失败可见而不是静默成功。
    if (!DRY) process.exit(2);
    return;
  }

  const subs = await loadSubscribers();
  console.log(`[${d.edition || 'morning'}] subject: ${d.subject}`);
  console.log(`订阅者: ${subs.length} 人${subs.length ? `（示例 ${subs.slice(0, 3).join(', ')}…）` : ''}`);
  if (!UNSUB_URL || !UNSUB_SECRET) {
    // 静默缺失最麻烦：日报发出去了、却没有退订口，收件人只能点「举报垃圾邮件」
    console.log('⚠ 未配置 UNSUBSCRIBE_URL / UNSUB_SECRET：日报里将不带退订链接。');
  }
  console.log('---');
  console.log(d.text);
  console.log('---');

  if (DRY) {
    console.log('\nℹ dry-run，未发送。');
    return;
  }
  if (!subs.length) {
    console.log('ℹ 无订阅者，未发送。');
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
  for (let i = 0; i < subs.length; i++) {
    const to = subs[i];
    const link = linkFor(to);
    const body = link ? `${d.text}\n\n——\n退订：${link}\n（点一下就把这个地址从名单里删掉，之后不再收到日报。）` : d.text;
    const headers = {};
    if (link) headers['List-Unsubscribe'] = `<${link}>${UNSUB ? `, <mailto:${UNSUB}>` : ''}`;
    else if (UNSUB) headers['List-Unsubscribe'] = `<mailto:${UNSUB}>`;
    try {
      await transport.sendMail({ from: FROM, to, subject: d.subject, text: body, headers });
      ok++;
      process.stdout.write(`\r发送中 ${i + 1}/${subs.length}  成功 ${ok}  失败 ${fail}`);
    } catch (e) {
      fail++;
      console.error(`\n✗ ${to} 失败：${e.message || e}`);
    }
    if (i < subs.length - 1 && DELAY > 0) await new Promise((r) => setTimeout(r, DELAY));
  }
  console.log(`\n✓ 完成：成功 ${ok}，失败 ${fail}。`);
  if (ok === 0 && fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error('✗ 群发失败：', e.message || e);
  process.exit(1);
});
