// 天天基金公告：给「今天为什么变了」一个可点开的出处。
//
// 背景（2026-10-21 实测）：当天 56 个份额里只有万家发了《调整大额申购金额限制》公告，
// 也只有它俩状态变了——公告与状态变化 1:1 对应，且公告发布于早上 07:51 抓取之后。
// 所以公告能补上「额度为什么变」这个页面原来答不了的问题。
//
// 接口：https://api.fund.eastmoney.com/f10/JJGG?fundcode=X&pageIndex=1&pageSize=N&type=0
//   需要 Referer: https://fundf10.eastmoney.com/；免密钥。
//   字段：TITLE / PUBLISHDATEDesc（只有日期，没有时分）/ ID / NEWCATEGORY
//   ★ NEWCATEGORY 不可靠：「取消总规模上限」是 cat6，「调整大额申购」是 cat5，
//     所以按标题关键词分类，不按分类码。
//   ★ 公告日期只有「日」，钉不住「几点变」——展示时只说「10-21 公告」，不说「上午发布」。
//
// 只存与**代销申购额度**相关的公告，三类噪声必须排除：
//   1) 直销渠道公告（「调整直销机构大额申购…」）—— 影响的是直销，不是我们展示的代销口径；
//   2) 境外节假日临时暂停（「因境外主要投资市场节假日暂停申购」）—— 是休市，不是限购；
//   3) 费率优惠/参加认申购活动 —— 与额度无关。
//
// 依赖：仅 Node 22 内置。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'announcements.json');

const API_HOST = 'api.fund.eastmoney.com';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const MAX_KEEP = 6; // 每只份额保留最近几条（够解释最近几天的变化）
const FETCH_TIMEOUT = 15000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// kind → 固定短语。不截断原标题当文案：标题里全是「关于××基金(QDII)调整…的公告」，
// 真正有信息量的只有那个动作，金额在正文里（拿不到就不臆造）。
export const KIND_ACTION = {
  limit: '调整大额申购限额',
  suspend: '暂停申购',
  resume: '恢复申购',
  open: '开放日常申购',
  cap: '调整规模上限',
};

/**
 * 按标题分类。返回 kind（limit/suspend/resume/open/cap）或 null（与额度无关，丢弃）。
 * 顺序有讲究：「恢复大额申购」既是恢复又含「大额申购」，必须先判恢复；
 * 「暂停大额申购」不是暂停，是压低额度，所以要先于「暂停申购」判。
 */
export function classifyAnnouncement(title) {
  const t = String(title || '');
  if (!t) return null;
  // 噪声一：渠道不同
  if (/直销/.test(t)) return null;
  // 噪声二：休市，不是限购
  if (/境外主要投资市场节假日|因.{0,12}节假日/.test(t)) return null;
  // 噪声三：促销/费率
  if (/费率优惠|参加.{0,20}(认申购|申购)|销售服务费/.test(t)) return null;

  // 距离要放宽：正式标题会带完整基金全名，「暂停招商纳斯达克100交易型开放式指数证券投资基金
  // 发起式联接基金(QDII)申购」里「暂停」和「申购」隔了 40 多个字，用 {0,10} 会漏。
  if (/恢复.{0,40}申购/.test(t)) return 'resume';
  if (/调整.{0,40}(大额申购|限制金额|金额限制)|限制大额申购|暂停大额申购|限制申购/.test(t)) return 'limit';
  if (/暂停.{0,60}申购/.test(t)) return 'suspend';
  if (/开放.{0,40}申购/.test(t)) return 'open';
  if (/规模上限/.test(t)) return 'cap';
  return null;
}

export function announcementUrl(code, id) {
  return `https://fund.eastmoney.com/gonggao/${code},${id}.html`;
}

/** 拉一只基金的公告列表，只留与额度相关的。失败返回 null（调用方决定是否继续）。 */
export async function fetchAnnouncements(code) {
  const url = `https://api.fund.eastmoney.com/f10/JJGG?fundcode=${encodeURIComponent(code)}&pageIndex=1&pageSize=8&type=0`;
  try {
    const host = new URL(url).host;
    if (host !== API_HOST) throw new Error(`host 不在白名单: ${host}`);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: 'https://fundf10.eastmoney.com/' },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    if (j.ErrCode !== 0 || !Array.isArray(j.Data)) throw new Error(`ErrCode=${j.ErrCode}`);

    const out = [];
    for (const a of j.Data) {
      const kind = classifyAnnouncement(a.TITLE);
      if (!kind) continue;
      out.push({
        id: String(a.ID || ''),
        date: String(a.PUBLISHDATEDesc || '').slice(0, 10),
        kind,
        action: KIND_ACTION[kind],
        title: String(a.TITLE || ''),
        url: announcementUrl(code, a.ID),
      });
    }
    return out;
  } catch (e) {
    console.warn(`⚠ ${code} 公告拉取失败：${e && e.message ? e.message : e}`);
    return null;
  }
}

export function loadAnnouncementStore() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { generatedAt: j.generatedAt || null, codes: j.codes || {} };
  } catch {
    return { generatedAt: null, codes: {} };
  }
}

export function saveAnnouncementStore(store) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, FILE);
}

/**
 * 刷新指定份额的公告，合并进 store（同一 id 去重、按日期倒序、每只保留 MAX_KEEP 条）。
 * 只抓「今日有变化」的份额：一天通常 1~3 只，60 只全抓是浪费（且对上游不礼貌）。
 */
export async function refreshAnnouncements(codes, store = loadAnnouncementStore()) {
  const list = [...new Set(codes)];
  let updated = 0;
  for (const code of list) {
    const got = await fetchAnnouncements(code);
    if (got) {
      const byId = new Map((store.codes[code] || []).map((a) => [a.id, a]));
      for (const a of got) byId.set(a.id, a);
      store.codes[code] = [...byId.values()]
        .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.id < b.id ? 1 : -1))
        .slice(0, MAX_KEEP);
      updated++;
    }
    if (list.length > 1) await sleep(250);
  }
  if (updated) {
    store.generatedAt = new Date().toISOString();
    saveAnnouncementStore(store);
  }
  return { updated, total: list.length, store };
}

/** 某份额「最近一条与额度相关的公告」，超过 days 天的不算（旧公告解释不了今天的变化）。 */
export function latestRelevant(store, code, { days = 3, today } = {}) {
  const arr = store.codes[code];
  if (!arr || !arr.length) return null;
  const limit = today ? shiftBack(today, days) : null;
  for (const a of arr) {
    if (!limit || a.date >= limit) return a;
  }
  return null;
}

function shiftBack(date, days) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - days)).toISOString().slice(0, 10);
}

// ── CLI：node scripts/announcements.mjs [--all|--dry] ──
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const all = process.argv.includes('--all');
  const funds = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'funds.json'), 'utf8')).funds || [];
  const codes = all ? funds.flatMap((f) => f.codes.map((c) => c.code)) : [];
  if (!codes.length) {
    console.log('用法：node scripts/announcements.mjs --all    # 刷新全部份额的额度类公告');
    process.exit(0);
  }
  refreshAnnouncements(codes).then(({ updated, total, store }) => {
    console.log(`✓ 公告刷新完成：${updated}/${total} 只成功。`);
    for (const [code, arr] of Object.entries(store.codes)) {
      console.log(`  ${code} ${arr.length} 条，最近 ${arr[0]?.date} ${arr[0]?.action}`);
    }
  });
}
