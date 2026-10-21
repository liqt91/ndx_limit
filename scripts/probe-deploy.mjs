#!/usr/bin/env node
/**
 * 部署窗口可用性探测。
 *
 * 目的：回答「拉数据触发重建的那几十秒，正在访问的用户会不会卡」。
 * 做法：以固定间隔持续请求首页 + 首页引用到的 CSS，把每次的状态码、耗时、
 *      CSS 指纹记下来。资源指纹变化的那一刻就是「新部署已生效」的切换点，
 *      于是能把切换前后分开看——有没有 5xx、有没有 HTML 拿到新指纹而
 *      CSS 404、延迟有没有尖刺。
 *
 * 零依赖（Node 18+ 自带 fetch）。只能在线上跑，本地跑没有意义：
 * 本地静态服务器不会因为你在旁边 npm run build 就中断。
 *
 *   node scripts/probe-deploy.mjs --url https://ndx.liqt91.top --minutes 8
 *   node scripts/probe-deploy.mjs --url ... --interval 3 --json out.json
 *
 * 建议用法：先跑起探测，再去触发一次 refresh（或直接推一个空提交），
 * 让探测窗口完整覆盖「构建 + 发布」。
 */

import { writeFileSync } from 'node:fs';

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(`用法：node scripts/probe-deploy.mjs --url <站点根地址> [选项]

  --url <url>        必填，例如 https://ndx.liqt91.top
  --minutes <n>      探测时长，默认 8
  --interval <n>     采样间隔（秒），默认 5
  --timeout <n>      单请求超时（秒），默认 10
  --json <path>      额外把原始采样写成 JSON
  --help             显示本说明`);
  process.exit(0);
}

const base = String(args.url || '').replace(/\/+$/, '');
if (!base) {
  console.error('缺少 --url（例：--url https://ndx.liqt91.top）');
  process.exit(2);
}
const totalMs = Number(args.minutes || 8) * 60_000;
const intervalMs = Number(args.interval || 5) * 1000;
const timeoutMs = Number(args.timeout || 10) * 1000;

/** 单次请求，永不抛异常：失败也是一种结果，必须被记录而不是打死探测。 */
async function hit(url) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'cache-control': 'no-cache', 'user-agent': 'ndx-deploy-probe/1' },
    });
    const body = await res.text();
    return { ok: res.ok, status: res.status, ms: Date.now() - t0, bytes: body.length, body };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, bytes: 0, error: String(e && e.message ? e.message : e) };
  }
}

const samples = [];
let cssSeen = null; // 当前观察到的 CSS 指纹文件名
let switches = 0;
let stopped = false;

function stderr(line) {
  process.stderr.write(line + '\n');
}

/** 从首页 HTML 里找出构建产物的 CSS 指纹（/_astro/xxx.<hash>.css）。 */
function cssRefOf(html) {
  const m = html.match(/(?:href|src)="(\/_astro\/[^"]+\.css)"/);
  return m ? m[1] : null;
}

async function tick() {
  const at = new Date();
  const page = await hit(base + '/');
  const cssPath = page.ok ? cssRefOf(page.body) : null;

  let css = null;
  if (cssPath) {
    css = await hit(base + cssPath);
  }

  // 指纹变了 = 新部署生效。只认「拿到了不同的文件名」，不认请求失败。
  let switched = false;
  if (cssPath && cssSeen && cssPath !== cssSeen) {
    switched = true;
    switches += 1;
  }
  if (cssPath) cssSeen = cssPath;

  const s = {
    at: at.toISOString(),
    page: { status: page.status, ms: page.ms, bytes: page.bytes, error: page.error || null },
    css: css ? { path: cssPath, status: css.status, ms: css.ms, bytes: css.bytes, error: css.error || null } : null,
    switched,
  };
  samples.push(s);

  const flag = s.page.status === 200 && (!s.css || s.css.status === 200) ? ' ' : '!';
  stderr(
    `${flag} ${at.toLocaleTimeString('zh-CN', { hour12: false })}  ` +
      `page=${s.page.status || 'ERR'} ${String(s.page.ms).padStart(5)}ms  ` +
      (s.css ? `css=${s.css.status || 'ERR'} ${String(s.css.ms).padStart(4)}ms  ` : 'css=--      ') +
      (switched ? '← 部署切换' : '')
  );
}

/** p 分位（最近秩法，够用）。 */
function pct(list, p) {
  if (!list.length) return 0;
  const a = [...list].sort((x, y) => x - y);
  const i = Math.min(a.length - 1, Math.max(0, Math.ceil((p / 100) * a.length) - 1));
  return a[i];
}

function summarize() {
  const pageOk = samples.filter((s) => s.page.status === 200);
  const pageBad = samples.filter((s) => s.page.status !== 200);
  const cssBad = samples.filter((s) => s.css && s.css.status !== 200);
  const cssMissing = samples.filter((s) => !s.css); // 首页拿不到 CSS 引用
  const ms = pageOk.map((s) => s.page.ms);

  // 切换点定位：切换那一次采样，以及它前后的采样有没有失败
  const idxSwitch = samples.map((s, i) => (s.switched ? i : -1)).filter((i) => i >= 0);
  const aroundSwitch = idxSwitch.flatMap((i) => samples.slice(Math.max(0, i - 1), i + 2));
  const switchBad = aroundSwitch.filter((s) => s.page.status !== 200 || (s.css && s.css.status !== 200));

  const lines = [];
  lines.push('');
  lines.push('── 汇总 ────────────────────────────────────────');
  lines.push(`站点          ${base}`);
  lines.push(`采样          ${samples.length} 次 / 间隔 ${intervalMs / 1000}s`);
  lines.push(`首页成功率    ${pageOk.length}/${samples.length}` + (pageBad.length ? `  ← 失败 ${pageBad.length} 次` : ''));
  if (ms.length) {
    lines.push(`首页耗时      min ${Math.min(...ms)}ms · p50 ${pct(ms, 50)}ms · p95 ${pct(ms, 95)}ms · max ${Math.max(...ms)}ms`);
  }
  if (cssBad.length) lines.push(`CSS 非 200    ${cssBad.length} 次  ← 这是会白屏的那种失败`);
  if (cssMissing.length) lines.push(`首页未解析出 CSS 引用  ${cssMissing.length} 次（可能是错误页）`);
  lines.push(`部署切换      ${switches} 次${switches ? `（第 ${idxSwitch.map((i) => i + 1).join('、')} 次采样观测到）` : '，未覆盖到发布窗口'}`);
  if (switches) {
    lines.push(`切换窗口内失败 ${switchBad.length} 次${switchBad.length ? '  ← 新旧版本交接有问题' : '  ← 交接干净'}`);
  }

  const fatal = pageBad.length + cssBad.length;
  let verdict;
  if (!samples.length) verdict = '没有采样，探测未运行';
  else if (fatal === 0 && switches > 0) verdict = '构建与发布窗口内零失败：用户不会感知到重建';
  else if (fatal === 0) verdict = '零失败，但没覆盖到一次发布；需要重跑并跨过构建';
  else verdict = '存在失败样本，看下面的明细';
  lines.push('');
  lines.push(`结论          ${verdict}`);

  const bad = samples.filter((s) => s.page.status !== 200 || (s.css && s.css.status !== 200));
  if (bad.length) {
    lines.push('');
    lines.push('失败明细（最多 10 条）：');
    for (const s of bad.slice(0, 10)) {
      lines.push(
        `  ${s.at}  page=${s.page.status || 'ERR'}${s.page.error ? ` (${s.page.error})` : ''}` +
          (s.css ? `  css=${s.css.status || 'ERR'}${s.css.error ? ` (${s.css.error})` : ''}` : '')
      );
    }
  }
  return lines.join('\n');
}

async function main() {
  stderr(`探测 ${base}  时长 ${(totalMs / 60000).toFixed(1)} 分钟，间隔 ${intervalMs / 1000}s`);
  stderr('采样中（! 表示该次有非 200）…\n');

  const onSignal = () => {
    stopped = true;
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const deadline = Date.now() + totalMs;
  while (!stopped && Date.now() < deadline) {
    await tick();
    const left = deadline - Date.now();
    if (left <= 0) break;
    await new Promise((r) => setTimeout(r, Math.min(intervalMs, left)));
  }

  const report = summarize();
  process.stdout.write(report + '\n');
  if (args.json) {
    writeFileSync(
      args.json,
      JSON.stringify({ url: base, intervalMs, switches, samples: samples.map(({ page, css, ...rest }) => ({ ...rest, page, css })) }, null, 2),
      'utf8'
    );
    process.stdout.write(`原始采样已写入 ${args.json}\n`);
  }
  // 有失败就非零退出，方便挂到任何 CI/面板里当门禁
  const fatal = samples.filter((s) => s.page.status !== 200 || (s.css && s.css.status !== 200)).length;
  process.exit(fatal ? 1 : 0);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    if (key === 'help') {
      out.help = true;
      continue;
    }
    const val = argv[i + 1];
    if (val === undefined || val.startsWith('--')) continue;
    out[key] = val;
    i += 1;
  }
  return out;
}

main();
