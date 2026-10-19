#!/usr/bin/env node
// 群发日报给所有订阅人（Buttondown）。由 GitHub Actions 每天 08:00 抓取后调用。
// 与 notify.mjs（管理员自通知）不同，本脚本面向订阅人，走 Buttondown 邮件服务。
// 无论有无变化都发送：无变化时正文含「今日无变化」说明（满足「无变化也推送」需求）。
//
// 用法：
//   node scripts/broadcast.mjs                 # 群发（需 BUTTONDOWN_API_KEY 环境变量）
//   BUTTONDOWN_API_KEY=xxx node scripts/broadcast.mjs
//   node scripts/broadcast.mjs --dry-run       # 只打印待发送内容，不请求网络
//
// 依赖：仅 Node 22 内置。密钥 BUTTONDOWN_API_KEY 仅服务端使用，不暴露给浏览器。
// 订阅人收集在 /subscribe 页面，表单 POST 到 Buttondown 公开 embed 端点（免密钥）。

import { buildDailyDigest } from './digest.mjs';

const API_KEY = process.env.BUTTONDOWN_API_KEY || '';
const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  const d = buildDailyDigest();

  if (DRY_RUN) {
    console.log('subject:', d.subject);
    console.log(d.text);
    console.log('\nℹ dry-run，未发送到 Buttondown。');
    return;
  }

  if (!API_KEY) {
    console.log(d.text);
    console.log('ℹ 未配置 BUTTONDOWN_API_KEY，仅打印，未发送。');
    return;
  }

  const r = await fetch('https://api.buttondown.com/v1/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Token ${API_KEY}` },
    body: JSON.stringify({ subject: d.subject, body: d.text, status: 'sent' }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('HTTP ' + r.status + (j && j.message ? ' ' + j.message : ''));
  console.log(
    `✓ 日报已通过 Buttondown 群发给所有订阅者（${d.noChange ? '今日无变化' : d.changes.length + ' 条变化'}）。`
  );
}

main().catch((e) => {
  console.error('✗ 群发失败：', e.message || e);
  process.exit(1);
});
