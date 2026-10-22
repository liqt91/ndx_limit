#!/usr/bin/env node
/**
 * 上传小程序数据到云存储（可选的自动化路径）。
 *
 * 为什么需要它：小程序包内的数据不随数据更新而更新（每更新一次就得重新提审），
 * 数据的真身放在云存储里，抓取跑完要把 bundle 传上去。
 *
 * 依赖（首次使用装一次）：
 *   npm i -D @cloudbase/node-sdk
 *
 * 用法（密钥从环境变量读，不要写进仓库）：
 *   TENCENTCLOUD_SECRETID=xxx TENCENTCLOUD_SECRETKEY=xxx \
 *   MP_CLOUD_ENV=your-env-id node scripts/mp-upload.mjs
 *
 * 不装依赖也能用：云开发控制台 → 存储 → 上传文件，把
 * miniprogram/data/bundle.json 传到 data/bundle.json 路径，效果一样。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'miniprogram', 'data', 'bundle.json');
const DEST = 'data/bundle.json';

const envId = process.env.MP_CLOUD_ENV;
const secretId = process.env.TENCENTCLOUD_SECRETID;
const secretKey = process.env.TENCENTCLOUD_SECRETKEY;

if (!envId || !secretId || !secretKey) {
  console.error('缺少环境变量：MP_CLOUD_ENV / TENCENTCLOUD_SECRETID / TENCENTCLOUD_SECRETKEY');
  console.error('或者直接在云开发控制台手动上传：miniprogram/data/bundle.json → ' + DEST);
  process.exit(2);
}

let cloudbase;
try {
  cloudbase = await import('@cloudbase/node-sdk');
} catch (e) {
  console.error('没装 @cloudbase/node-sdk：先跑 npm i -D @cloudbase/node-sdk');
  console.error('或者改用云开发控制台手动上传。');
  process.exit(2);
}

if (!fs.existsSync(SRC)) {
  console.error('找不到 ' + SRC + '，先跑 node scripts/mp-sync.mjs');
  process.exit(2);
}

const app = cloudbase.init({ env: envId, secretId, secretKey });
const content = fs.readFileSync(SRC);

try {
  const res = await app.uploadFile({ cloudPath: DEST, fileContent: content });
  console.log('✓ 已上传到 cloud://' + envId + '/' + DEST, res.fileID || '');
} catch (e) {
  console.error('✗ 上传失败：' + (e && e.message ? e.message : e));
  process.exit(1);
}
