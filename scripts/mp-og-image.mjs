#!/usr/bin/env node
/**
 * 生成分享卡片图 public/og.png（1200×630，OG 规范尺寸）。
 *
 * 为什么手写 PNG：站点没有图形依赖，SVG 又不被多数分享平台接受（Twitter/OG 要求
 * PNG/JPG）。用 node 自带的 zlib 手写一份 PNG 不引任何依赖。
 *
 * 画的是什么：一条墨色标题线 + 一行副标题线 + 21 格额度热力方块 + 一条分隔细线。
 * 用的是站点那套纸感配色——分享出去的那张图应该一眼看出是同一个东西。
 *
 * 用法：node scripts/mp-og-image.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public', 'og.png');

const W = 1200;
const H = 630;

const PAPER = [0xfa, 0xf9, 0xf6];
const INK = [0x14, 0x13, 0x0f];
const INK3 = [0x6b, 0x68, 0x59];
const RULE = [0xe3, 0xe0, 0xd6];
const HEAT = [
  [0xc4, 0xda, 0xcc],
  [0x92, 0xb6, 0xa2],
  [0x63, 0x94, 0x7c],
  [0x2f, 0x66, 0x50],
];

const px = Buffer.alloc(W * H * 3);
for (let i = 0; i < W * H; i++) {
  px[i * 3] = PAPER[0];
  px[i * 3 + 1] = PAPER[1];
  px[i * 3 + 2] = PAPER[2];
}

function rect(x, y, w, h, color) {
  const x0 = Math.max(0, Math.round(x));
  const y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(W, Math.round(x + w));
  const y1 = Math.min(H, Math.round(y + h));
  for (let yy = y0; yy < y1; yy++) {
    let off = (yy * W + x0) * 3;
    for (let xx = x0; xx < x1; xx++) {
      px[off] = color[0];
      px[off + 1] = color[1];
      px[off + 2] = color[2];
      off += 3;
    }
  }
}

// 标题线与副标题线（代替文字：没有字体渲染，线段比方块更接近排版的节奏）
rect(120, 168, 430, 30, INK);
rect(120, 224, 286, 14, INK3);

// 21 格额度热力：7 列 × 3 行，格子 46px，间距 8px
const cell = 46;
const gap = 8;
const gx = 120;
const gy = 316;
const levels = [3, 3, 2, 2, 1, 1, 4, 3, 2, 2, 1, 1, 0, 2, 3, 4, 4, 3, 2, 1, 0];
for (let i = 0; i < levels.length; i++) {
  const col = i % 7;
  const row = Math.floor(i / 7);
  const x = gx + col * (cell + gap);
  const y = gy + row * (cell + gap);
  const lv = levels[i];
  if (lv === 0) {
    // 暂停：空心细框
    rect(x, y, cell, cell, RULE);
    rect(x + 3, y + 3, cell - 6, cell - 6, PAPER);
  } else {
    rect(x, y, cell, cell, HEAT[lv - 1]);
  }
}

// 状态方点（与站点 .tag::before 同一个 5px 方点的放大版）
rect(120, 520, 14, 14, INK);
rect(148, 526, 190, 8, INK3);

// 底部分隔细线
rect(120, 566, W - 240, 1, RULE);

/* ── PNG 编码 ─────────────────────────────────────────────── */

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 2; // color type: truecolor RGB
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y++) {
  raw[y * (W * 3 + 1)] = 0; // filter: none
  px.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

fs.writeFileSync(OUT, png);
console.log(`✓ 写出 ${path.relative(ROOT, OUT)}（${W}×${H}，${(png.length / 1024).toFixed(1)} KB）`);
