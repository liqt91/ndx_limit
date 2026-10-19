#!/usr/bin/env node
// 管理员自通知（飞书 / 微信 Server酱）：把每日变化推给站长自己，便于巡检。
// 注意：这是「单收件人」自通知，不是给订阅人广播——订阅人群发请用 broadcast.mjs（Buttondown）。
//
// 用法：
//   node scripts/notify.mjs                 # 推送（需 NOTIFY_WEBHOOK 环境变量）
//   NOTIFY_WEBHOOK=https://open.feishu...  node scripts/notify.mjs          # 飞书（默认）
//   NOTIFY_CHANNEL=wechat NOTIFY_WEBHOOK=<SCKEY> node scripts/notify.mjs    # 微信（Server酱）
//   node scripts/notify.mjs --dry-run       # 只打印待发送内容与目标端点，不请求网络
//
// 渠道（NOTIFY_CHANNEL，默认 feishu）：
//   feishu  —— 飞书自定义机器人，NOTIFY_WEBHOOK 为完整 webhook 地址，POST 飞书 text 消息。
//   wechat  —— Server酱（sctapi.ftqq.com），NOTIFY_WEBHOOK 填 SCKEY（纯 key，脚本自动拼成发送地址），
//             推送到绑定的微信；免域名、零成本。该渠道仅适合「通知自己」，不适合群发给订阅人。
//
// 依赖：仅 Node 22 内置。日报内容由 ./digest.mjs 统一构建。

import { buildDailyDigest } from './digest.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const CHANNEL = (process.env.NOTIFY_CHANNEL || 'feishu').toLowerCase();
const WEBHOOK = process.env.NOTIFY_WEBHOOK || '';

// 由 key/URL 解析出最终发送端点。wechat 渠道下，纯 SCKEY 自动拼成 Server酱 发送地址。
function resolveEndpoint(key) {
  if (/^https?:\/\//i.test(key)) return key;
  if (CHANNEL === 'wechat') return `https://sctapi.ftqq.com/${key}.send`;
  return key;
}

function main() {
  const d = buildDailyDigest();

  if (DRY_RUN || !WEBHOOK) {
    console.log(d.text);
    const endpoint = WEBHOOK ? resolveEndpoint(WEBHOOK) : '(未配置 NOTIFY_WEBHOOK)';
    console.log(
      `\nℹ 渠道=${CHANNEL} 目标=${endpoint}；${DRY_RUN ? 'dry-run' : '未配置 NOTIFY_WEBHOOK'}，仅打印，未发送。`
    );
    return;
  }

  send(d.text, d.subject).catch((e) => {
    console.error('✗ 通知发送失败：', e.message || e);
    process.exit(1);
  });
}

// 按渠道发送。飞书走 JSON text 消息；微信（Server酱）走 form-urlencoded（title/desp）。
async function send(msg, date) {
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
