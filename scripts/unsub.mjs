// 退订链接的唯一实现 —— 两端共用，避免「发送侧按一种算法签、校验侧按另一种验」。
//
// 发送侧：scripts/send.mjs（Node，每天群发时给每封邮件拼退订链接）
// 校验侧：edge-functions/api/unsubscribe.js（Web Crypto 手写同一算法）
// 测试：verify-subscribe-api.mjs 直接 import 本文件，用它签出来的链接去敲真实边缘函数，
//       任一端改了口径都会立刻红。
//
// 算法刻意做得极简：sha256(email + ':' + secret)。不引入 HMAC 的额外参数，
// 也不依赖任何 Node 专有 API 之外的特性，两边各写十行就能对齐。

import { createHash } from 'node:crypto';

export function unsubToken(email, secret) {
  return createHash('sha256').update(`${String(email).trim().toLowerCase()}:${secret}`).digest('hex');
}

export function unsubLink(email, base, secret) {
  if (!base || !secret) return '';
  const root = String(base).replace(/\/+$/, '');
  return `${root}?e=${encodeURIComponent(String(email).trim().toLowerCase())}&t=${unsubToken(email, secret)}`;
}
