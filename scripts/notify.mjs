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

import fs from 'node:fs';
import { buildBroadcastDigest, INDEX_KEYS } from './digest.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const WEBHOOK = process.env.NOTIFY_WEBHOOK || '';
const ALERT_EMAIL = process.env.ALERT_EMAIL || '';

// 抓取巡检：把 scrape.mjs 记在 fetch-meta.json 里的旁路结论带进管理员通知。
// 这些是「给自己看的」——订阅人不需要知道对账差异，也不该看到名单外份额。
// 没有这条，对账差异、快照兜底、新份额缺口只会沉在 CI 日志里，没人会翻。
function opsReport() {
  let m;
  try {
    m = JSON.parse(fs.readFileSync(new URL('../data/fetch-meta.json', import.meta.url), 'utf8'));
  } catch {
    return { text: '', slot: null, anomalies: [] };
  }
  const s = m.shadow || {};
  const lines = [];
  const anomalies = [];
  const runs = Array.isArray(m.runs) ? m.runs : [];
  if (runs.length) {
    lines.push(
      '时点：' +
        runs.map((r) => `${r.slot} ${r.time}（${r.opened} 家 / ${r.total} 元${r.changed ? `，较上次 ${r.changed.length} 处变化` : ''}）`).join(' · ')
    );
  }
  if (s.checked) lines.push(`对账：${s.agree}/${s.checked} 与全量快照一致`);
  if (s.mismatch && s.mismatch.length) {
    lines.push(
      `⚠ 对账差异 ${s.mismatch.length} 处：${s.mismatch
        .map((x) => `${x.code} 页面${x.page.status}/${x.page.limit ?? '—'} vs 快照${x.snapshot.status}/${x.snapshot.limit ?? '—'}`)
        .join('；')}`
    );
    anomalies.push('mismatch');
  }
  if (s.recovered && s.recovered.length) {
    lines.push(`↺ 快照兜底 ${s.recovered.length} 个：${s.recovered.join(', ')}`);
    anomalies.push('recovered');
  }
  if (s.gaps && s.gaps.missing && s.gaps.missing.length) {
    lines.push(`⚠ 名单外纳指100 份额 ${s.gaps.missing.length} 个：${s.gaps.missing.map((x) => `${x.code} ${x.name}`).join('；')}`);
    anomalies.push('gaps');
  }
  const ms = m.ms || {};
  if (ms.checked) lines.push(`晨星对账：${ms.agree}/${ms.checked} 与详情页一致`);
  if (ms.mismatch && ms.mismatch.length) {
    lines.push(
      `⚠ 晨星差异 ${ms.mismatch.length} 处：${ms.mismatch
        .map((x) => `${x.code} 页面${x.page.status}/${x.page.limit ?? '—'} vs 晨星${x.ms.status}/${x.ms.limit ?? '—'}`)
        .join('；')}`
    );
    anomalies.push('ms-mismatch');
  }
  if (s.warnings && s.warnings.length) {
    lines.push(`⚠ ${s.warnings.join('；')}`);
    anomalies.push('warnings');
  }
  return { text: lines.length ? `\n\n— 抓取巡检 —\n${lines.join('\n')}` : '', slot: m.slot || null, anomalies };
}

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
  // 管理员自通知看全量：两个指数都拼进来，任何一个数据不可用都在正文里明写
  // （订阅者那边是按偏好裁剪的，站长这边不需要裁剪——巡检要看到「哪个指数今天没数据」）。
  const d = buildBroadcastDigest({ edition: 'close', indices: INDEX_KEYS });
  const ops = opsReport();
  const text = (d.text || '今日没有可用指数（两个指数的数据都不完整）。') + ops.text;

  // 一天抓两次（早间 + 收盘前），但管理员通知不需要两封：
  // 收盘前那次只在巡检发现异常时才发，正常的「下午也一样」不值一封邮件。
  const quiet =
    ops.slot === 'close' && ops.anomalies.length === 0 && !DRY_RUN && !process.argv.includes('--always');
  if (quiet) {
    console.log(text);
    console.log('\nℹ 收盘前时点且巡检无异常，不发管理员通知（需要照发请加 --always）。');
    return;
  }

  if (DRY_RUN || CHANNEL === 'none' || (CHANNEL === 'email' && !canSendEmail())) {
    console.log(text);
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

  send(text, d.subject).catch((e) => {
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
        sender: { name: 'QDII 开门日报', email: process.env.MAIL_FROM },
        to: [{ email: ALERT_EMAIL }],
        subject: `【QDII】${date} 数据已更新`,
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
