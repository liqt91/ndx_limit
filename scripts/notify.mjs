#!/usr/bin/env node
// 管理员自通知：把每日变化推给站长自己，便于巡检。
// 注意：这是「单收件人」自通知，不是给订阅人广播——订阅人群发请用 broadcast.yml。
//
// 渠道（NOTIFY_CHANNEL，默认自动判断）：
//   email  —— Brevo 事务邮件 API 发到站长邮箱（ALERT_EMAIL）。Server酱/飞书均未开通，
//             邮件是唯一零新增依赖的推送渠道：与 /api/subscribe 复用同一套
//             BREVO_API_KEY / MAIL_FROM，300 封/天永久免费。**默认渠道。**
//   feishu —— 飞书自定义机器人，NOTIFY_WEBHOOK 为完整 webhook 地址（未开通，留作兼容）。
//   wechat —— Server酱，NOTIFY_WEBHOOK 填 SCKEY（未开通，留作兼容）。
//
// 自动判断规则：显式设了 NOTIFY_CHANNEL 就用它；否则有 NOTIFY_WEBHOOK 走 feishu，
// 都没有但配了 BREVO_API_KEY + ALERT_EMAIL 走 email，再什么都没有只打印不发送。
//
// 用法：
//   node scripts/notify.mjs                 # 推送（按上面规则自动选渠道）
//   NOTIFY_CHANNEL=email ALERT_EMAIL=q@example.com node scripts/notify.mjs
//   node scripts/notify.mjs --dry-run       # 只打印待发送内容与目标端点，不请求网络
//
// 依赖：仅 Node 22 内置。日报内容由 ./digest.mjs 统一构建。

import { buildDailyDigest } from './digest.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const WEBHOOK = process.env.NOTIFY_WEBHOOK || '';
const ALERT_EMAIL = process.env.ALERT_EMAIL || '';

function pickChannel() {
  const explicit = (process.env.NOTIFY_CHANNEL || '').toLowerCase();
  if (explicit) return explicit;
  if (WEBHOOK) return 'feishu';
  if (process.env.BREVO_API_KEY && ALERT_EMAIL) return 'email';
  return 'none';
}
const CHANNEL = pickChannel();

function canSendEmail() {
  return !!(process.env.BREVO_API_KEY && process.env.MAIL_FROM && ALERT_EMAIL);
}

// 由 key/URL 解析出最终发送端点。wechat 渠道下，纯 SCKEY 自动拼成 Server酱 发送地址。
function resolveEndpoint(key) {
  if (/^https?:\/\//i.test(key)) return key;
  if (CHANNEL === 'wechat') return `https://sctapi.ftqq.com/${key}.send`;
  return key;
}

function main() {
  const d = buildDailyDigest();

  if (DRY_RUN || CHANNEL === 'none' || (CHANNEL === 'email' && !canSendEmail())) {
    console.log(d.text);
    let target;
    if (CHANNEL === 'email') {
      target = canSendEmail() ? ALERT_EMAIL : '(缺 BREVO_API_KEY / MAIL_FROM / ALERT_EMAIL)';
    } else if (WEBHOOK) {
      target = resolveEndpoint(WEBHOOK);
    } else {
      target = '(未配置任何渠道)';
    }
    console.log(`\nℹ 渠道=${CHANNEL} 目标=${target}；仅打印，未发送。`);
    return;
  }

  send(d.text, d.subject).catch((e) => {
    console.error('✗ 通知发送失败：', e.message || e);
    process.exit(1);
  });
}

// 按渠道发送。email 走 Brevo 事务邮件 API；飞书走 JSON text；微信走 form-urlencoded。
async function send(msg, date) {
  if (CHANNEL === 'email') {
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': process.env.BREVO_API_KEY,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        sender: { name: '纳指开门日报', email: process.env.MAIL_FROM },
        to: [{ email: ALERT_EMAIL }],
        subject: `【ndx】${date} 数据已更新`,
        textContent: msg,
      }),
    });
    if (!r.ok) throw new Error(`Brevo HTTP ${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}`);
    console.log(`✓ 邮件通知已发送（Brevo → ${ALERT_EMAIL}，管理员自通知）。`);
    return;
  }
  if (CHANNEL === 'wechat') {
    const endpoint = resolveEndpoint(WEBHOOK);
    const body = new URLSearchParams({ title: date, desp: msg });
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || (j && typeof j.code === 'number' && j.code !== 0))
      throw new Error('HTTP ' + r.status + (j && j.message ? ' ' + j.message : ''));
    console.log('✓ 微信通知已发送（Server酱 → 微信，管理员自通知）。');
    return;
  }
  const r = await fetch(WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msg_type: 'text', content: { text: msg } }),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  console.log('✓ 通知已发送（飞书，管理员自通知）。');
}

main();
