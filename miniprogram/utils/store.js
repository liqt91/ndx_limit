/**
 * 数据加载与装配。
 *
 * 三层来源，优先级从高到低：
 *   1. 云存储 data/bundle.json（最新，抓取脚本每天写）
 *   2. 本地缓存（storage，上次成功拿到的，12 小时内直接用）
 *   3. 包内 data/bundle.json（构建期打包的兜底，云开发没配好时也能看）
 *
 * 装配（assemble）把原始 bundle 变成页面直接能渲染的结构，口径与网页版一致：
 *   - 分组：company + baseName + currency
 *   - 首屏开门家数：组内任一份额可买即算开门
 *   - 家族卡状态：可买/不可买混合 → 部分可投（PARTIAL），与网页版 FamilyCard 同口径
 *   - 家族额度：可买份额的单日上限之和；含「额度未公布」的可买份额时用 ≈ 标注
 *   - 家族热力：合并组内各份额的历史，任一可买即当日开门，额度取当日家族合计
 */
const config = require('../config.js');
const fmt = require('./format.js');

/* ── 原始数据 ─────────────────────────────────────────────── */

function readBundled() {
  try {
    // 包内兜底数据（由 scripts/mp-sync.mjs 生成）
    return require('../data/bundle.json');
  } catch (e) {
    return null;
  }
}

function readCache() {
  try {
    const c = wx.getStorageSync(config.CACHE_KEY);
    if (!c || !c.bundle) return null;
    const ageH = (Date.now() - c.savedAt) / 3600000;
    if (ageH > config.CACHE_MAX_AGE_H) return null;
    return c.bundle;
  } catch (e) {
    return null;
  }
}

function writeCache(bundle) {
  try {
    wx.setStorageSync(config.CACHE_KEY, { savedAt: Date.now(), bundle: bundle });
  } catch (e) {
    /* 缓存写失败不影响主流程 */
  }
}

/* ── 云存储 ───────────────────────────────────────────────── */

function cloudReady() {
  return !!(config.CLOUD_ENV && config.CLOUD_BUNDLE);
}

function initCloud() {
  if (!cloudReady()) return false;
  try {
    if (!wx.cloud) return false;
    wx.cloud.init({ env: config.CLOUD_ENV, traceUser: false });
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 从云存储拉最新 bundle。
 * 云开发没配置 / 网络失败 / 文件不存在 → 返回 null，调用方回落到缓存与包内数据。
 */
function fetchRemote() {
  return new Promise(function (resolve) {
    if (!initCloud()) {
      resolve(null);
      return;
    }
    wx.cloud.downloadFile({
      fileID: config.CLOUD_BUNDLE,
      success: function (res) {
        wx.getFileSystemManager().readFile({
          filePath: res.tempFilePath,
          encoding: 'utf8',
          success: function (r) {
            try {
              const bundle = JSON.parse(r.data);
              writeCache(bundle);
              resolve(bundle);
            } catch (e) {
              resolve(null);
            }
          },
          fail: function () {
            resolve(null);
          },
        });
      },
      fail: function () {
        resolve(null);
      },
    });
  });
}

/** 缓存优先的加载：先给缓存（能立刻渲染），再给云端最新 */
function loadCached() {
  return new Promise(function (resolve) {
    const c = readCache();
    if (c) {
      resolve(c);
      return;
    }
    const b = readBundled();
    resolve(b);
  });
}

/* ── 装配 ─────────────────────────────────────────────────── */

function isBuyable(status) {
  return status === 'LIMITED' || status === 'OPEN';
}

/** 家族状态摘要：与网页版 FamilyCard 同口径 */
function familyStatus(shares) {
  var buyable = 0;
  var stopped = 0;
  var closed = 0;
  var unknown = 0;
  var hasOpen = false;
  for (var i = 0; i < shares.length; i++) {
    var s = shares[i].status;
    if (isBuyable(s)) {
      buyable++;
      if (s === 'OPEN') hasOpen = true;
    } else if (s === 'STOPPED') stopped++;
    else if (s === 'CLOSED') closed++;
    else if (s === 'UNKNOWN') unknown++;
  }
  var nonBuyable = stopped + closed + unknown;
  if (buyable > 0 && nonBuyable > 0) return 'PARTIAL';
  if (buyable > 0) return hasOpen ? 'OPEN' : 'LIMITED';
  if (closed > 0) return 'CLOSED';
  if (unknown > 0) return 'UNKNOWN';
  return 'STOPPED';
}

var FAM_LABEL = {
  OPEN: '开放申购',
  LIMITED: '限额申购',
  STOPPED: '暂停申购',
  CLOSED: '封闭期',
  UNKNOWN: '额度未公布',
  PARTIAL: '部分可投',
};

function famLabel(s) {
  return FAM_LABEL[s] || '';
}

function famCls(s) {
  if (s === 'STOPPED') return 'tag-stop';
  if (s === 'CLOSED') return 'tag-closed';
  if (s === 'UNKNOWN') return 'tag-unknown';
  if (s === 'PARTIAL') return 'tag-partial';
  return 'tag-ok';
}

/** 家族额度：可买份额上限之和；有「额度未公布」的可买份额时用 ≈ 标注被低估 */
function familyTotal(shares) {
  var total = 0;
  var missing = false;
  for (var i = 0; i < shares.length; i++) {
    var s = shares[i];
    if (!isBuyable(s.status)) continue;
    if (s.limit === null || s.limit === undefined) missing = true;
    else total += s.limit;
  }
  return { total: total, missing: missing };
}

/** 家族 21 天热力：任一可买即当日开门，额度取当日家族合计 */
function familyHistory(shares, n) {
  var byDate = {};
  var order = [];
  for (var i = 0; i < shares.length; i++) {
    var hist = shares[i].history || [];
    for (var j = 0; j < hist.length; j++) {
      var d = hist[j].d;
      if (!byDate[d]) {
        byDate[d] = [];
        order.push(d);
      }
      byDate[d].push(hist[j]);
    }
  }
  order.sort();
  var out = order.slice(-n);
  return out.map(function (d) {
    var entries = byDate[d];
    var open = entries.filter(function (e) {
      return isBuyable(e.s);
    });
    var closed = entries.find(function (e) {
      return e.s === 'CLOSED';
    });
    var unknown = entries.find(function (e) {
      return e.s === 'UNKNOWN';
    });
    var status = open.length
      ? 'LIMITED'
      : closed
        ? 'CLOSED'
        : unknown
          ? 'UNKNOWN'
          : 'STOPPED';
    var sum = 0;
    for (var k = 0; k < open.length; k++) sum += open[k].l || 0;
    return { d: d, s: status, l: open.length && sum > 0 ? sum : null };
  });
}

/** 变化分类：与网页版 classifyChange 同规则 */
function classifyChange(from, to) {
  var fromBuy = isBuyable(from.s);
  var toBuy = isBuyable(to.s);
  if (to.s === 'UNKNOWN' && from.s !== 'UNKNOWN') return 'unknown';
  if (!fromBuy && toBuy) return 'opened';
  if (fromBuy && !toBuy) return 'stopped';
  if (fromBuy && toBuy) {
    if (from.l === null && to.l !== null) return 'limit-set';
    if (from.l !== null && to.l === null) return 'limit-clear';
    if (from.l !== null && to.l !== null && from.l !== to.l) {
      return to.l > from.l ? 'limit-up' : 'limit-down';
    }
  }
  return 'other';
}

/** 今天是交易日吗（只看 A 股口径：周末 + 法定休市） */
function isTradingDay(date, holidays) {
  var dow = fmt.dowOf(date);
  if (dow === 0 || dow === 6) return false;
  return !(holidays && holidays.indexOf(date) >= 0);
}

/**
 * 装配：原始 bundle → 页面用的结构。
 * 装配放在客户端做（而不是在抓取脚本里算好），是为了让「今天休市吗」「数据过期了吗」
 * 这类判断跟着设备当前日期走——静态站靠客户端脚本做同一件事。
 */
function assemble(raw) {
  if (!raw || !raw.shares || !raw.shares.length) return null;

  var today = fmt.todayCST();
  var holidays = raw.holidays || [];
  var trading = isTradingDay(today, holidays);
  var snapDate = raw.snapDate || today;
  var stale = trading && snapDate !== today;

  // 分组
  var map = {};
  var order = [];
  for (var i = 0; i < raw.shares.length; i++) {
    var s = raw.shares[i];
    var key = s.company + '|' + s.baseName + '|' + s.currency;
    if (!map[key]) {
      map[key] = { key: key, company: s.company, baseName: s.baseName, currency: s.currency, shares: [] };
      order.push(key);
    }
    map[key].shares.push(s);
  }
  var groups = order.map(function (k) {
    return map[k];
  });
  for (var gi = 0; gi < groups.length; gi++) {
    groups[gi].shares.sort(function (a, b) {
      return fmt.classRank(a.cls) - fmt.classRank(b.cls);
    });
  }

  // 家族卡
  function buildFamily(g) {
    var st = familyStatus(g.shares);
    var tt = familyTotal(g.shares);
    var hist = familyHistory(g.shares, 21);
    return {
      key: g.key,
      name: g.company + g.baseName + (g.currency === 'USD' ? '美元' : ''),
      currency: g.currency,
      status: st,
      statusLabel: famLabel(st),
      statusClass: famCls(st),
      total: tt.total,
      totalText: tt.total > 0 ? (tt.missing ? '≈' : '') + fmt.money(tt.total) : tt.missing ? '待核验' : '',
      totalUnit: tt.total > 0 ? '元' : '',
      hasMissing: tt.missing,
      shares: g.shares.map(function (s) {
        return {
          code: s.code,
          cls: s.cls,
          name: s.name,
          status: s.status,
          limit: s.limit,
          limitText: s.limit === null || s.limit === undefined ? '未公布' : s.limit + '元',
          missing: s.limitMissing === true,
          statusLabel: fmt.STATUS_LABEL[s.status] || '',
          statusShort: fmt.STATUS_SHORT[s.status] || '',
        };
      }),
      heat: hist.map(function (d) {
        return { kind: fmt.heatKind(d.s, d.l), tip: fmt.prettyDate(d.d) + ' ' + heatTip(d) };
      }),
      heatFrom: hist.length ? hist[0].d : '',
      heatTo: hist.length ? hist[hist.length - 1].d : '',
    };
  }

  function heatTip(d) {
    if (isBuyable(d.s)) {
      return d.l === null ? '可申购，额度未公布' : d.l + '元';
    }
    if (d.s === 'CLOSED') return '封闭期';
    if (d.s === 'UNKNOWN') return '状态未公布';
    return '暂停申购';
  }

  var cnyFamilies = [];
  var usdFamilies = [];
  for (var g2 = 0; g2 < groups.length; g2++) {
    if (groups[g2].currency === 'USD') usdFamilies.push(buildFamily(groups[g2]));
    else cnyFamilies.push(buildFamily(groups[g2]));
  }

  // 首屏：开门家数 = 组内任一份额可买；总额 = 可买份额上限之和
  var opened = 0;
  var total = 0;
  for (var c = 0; c < cnyFamilies.length; c++) {
    var fam = cnyFamilies[c];
    var any = fam.shares.some(function (x) {
      return isBuyable(x.status);
    });
    if (any) {
      opened++;
      for (var t = 0; t < fam.shares.length; t++) {
        var sh = fam.shares[t];
        if (isBuyable(sh.status) && sh.limit !== null && sh.limit !== undefined) total += sh.limit;
      }
    }
  }

  // 今日变化：与上一交易日比较
  var changes = [];
  var prevDate = raw.prevDate || null;
  if (prevDate) {
    for (var ci = 0; ci < cnyFamilies.length; ci++) {
      for (var si = 0; si < cnyFamilies[ci].shares.length; si++) {
        var share = cnyFamilies[ci].shares[si];
        var full = null;
        for (var fi = 0; fi < raw.shares.length; fi++) {
          if (raw.shares[fi].code === share.code) {
            full = raw.shares[fi];
            break;
          }
        }
        if (!full || !full.history || full.history.length < 2) continue;
        var to = full.history[full.history.length - 1];
        var from = full.history[full.history.length - 2];
        var kind = classifyChange(from, to);
        if (kind === 'other') continue;
        var ann = null;
        if (raw.announcements && raw.announcements[share.code]) {
          for (var ai = 0; ai < raw.announcements[share.code].length; ai++) {
            var a = raw.announcements[share.code][ai];
            if (a.date >= fmt.shiftDate(snapDate, -3)) {
              ann = a;
              break;
            }
          }
        }
        changes.push({
          code: share.code,
          name: share.name,
          kind: kind,
          fromStatus: from.s,
          toStatus: to.s,
          fromLimit: from.l,
          toLimit: to.l,
          fromText: sideText(from.s, from.l),
          toText: sideText(to.s, to.l),
          ann: ann ? { action: ann.action, title: ann.title, date: ann.date } : null,
        });
      }
    }
    changes.sort(function (x, y) {
      var orderMap = {
        opened: 0, stopped: 1, 'limit-up': 2, 'limit-down': 3,
        'limit-set': 4, 'limit-clear': 5, unknown: 6, other: 7,
      };
      return (orderMap[x.kind] || 7) - (orderMap[y.kind] || 7);
    });
  }

  function sideText(status, limit) {
    if (status === 'LIMITED' && limit !== null && limit !== undefined) return '限 ' + limit + ' 元';
    return fmt.STATUS_SHORT[status] || '';
  }

  var openedCount = changes.filter(function (x) {
    return x.kind === 'opened';
  }).length;
  var stoppedCount = changes.filter(function (x) {
    return x.kind === 'stopped';
  }).length;
  var limitCount = changes.filter(function (x) {
    return x.kind.indexOf('limit') === 0;
  }).length;

  var parts = [];
  if (openedCount) parts.push(openedCount + ' 只开门');
  if (stoppedCount) parts.push(stoppedCount + ' 只暂停');
  if (limitCount) parts.push(limitCount + ' 只调额度');
  var verdict = parts.length ? parts.join('，') : '没有变化';

  // 首屏结论句：永远以「今天」开头
  var headline;
  if (!trading) {
    headline = '今日休市（非交易日）';
  } else if (opened === 0) {
    headline = '今天 ' + cnyFamilies.length + ' 家全部暂停';
  } else if (opened === cnyFamilies.length) {
    headline = '今天 ' + opened + ' 家全部开门，' + fmt.money(total) + '元可投';
  } else {
    headline = '今天 ' + opened + ' 家开门，' + fmt.money(total) + '元可投';
  }

  var updatedLabel = snapDate === today ? '今日' : fmt.mdLabel(snapDate);
  var summaryDelta = '';
  if (trading && prevDate) {
    summaryDelta = '较上个交易日（' + prevDate + '）' + verdict + '。';
  } else if (!trading && snapDate) {
    summaryDelta = '最近交易日（' + snapDate + '）' + opened + ' 家开门 · 可投 ' + fmt.money(total) + ' 元。';
  }

  return {
    snapDate: snapDate,
    prevDate: prevDate,
    today: today,
    isTrading: trading,
    isStale: stale,
    headline: headline,
    headlineParts: headlineParts(headline),
    summaryDelta: summaryDelta,
    updatedLabel: updatedLabel,
    updatedTime: raw.fetch ? raw.fetch.time : null,
    slot: raw.fetch ? raw.fetch.slot : null,
    families: cnyFamilies,
    usdFamilies: usdFamilies,
    changes: changes,
    opened: opened,
    total: total,
    monitored: cnyFamilies.length,
    calendar: raw.calendar || {},
    holidays: holidays,
    generatedAt: raw.generatedAt || '',
  };
}

/** 把结论句拆成「文本 + 数字」两段，页面上数字用等宽 */
function headlineParts(text) {
  var re = /(\d[\d,]*)/g;
  var out = [];
  var last = 0;
  var m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ t: text.slice(last, m.index), num: false });
    out.push({ t: m[1], num: true });
    last = m.index + m[1].length;
  }
  if (last < text.length) out.push({ t: text.slice(last), num: false });
  return out;
}

module.exports = {
  assemble: assemble,
  loadCached: loadCached,
  fetchRemote: fetchRemote,
  readBundled: readBundled,
  isTradingDay: isTradingDay,
  isBuyable: isBuyable,
  familyHistory: familyHistory,
};
