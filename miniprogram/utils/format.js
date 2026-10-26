/**
 * 展示口径工具。
 *
 * 这里的每一处阈值、每一句措辞都必须与网页版一致：
 *   - 额度分档：src/lib/amount-scale.ts（30 / 300 / 600，左开右闭）
 *   - 状态文案：src/lib/status.ts
 *   - 日期算法：src/data/dates.ts（纯字符串 + UTC，不碰本地时区）
 * 改一处必须改两处，否则小程序和网页版会给出两套答案。
 */

/** 额度分档阈值（左开右闭）：limit > stop 才进下一档。 */
const LIMIT_STOPS = [30, 300, 600];

/**
 * 额度落在第几档；null 表示没有额度数字，颜色不管，交给纹理。
 * 0 元（能买但当天额度是 0）属于第一档，不是 null。
 */
function heatLevel(limit) {
  if (limit === null || limit === undefined || !isFinite(limit)) return null;
  var level = 1;
  for (var i = 0; i < LIMIT_STOPS.length; i++) {
    if (limit > LIMIT_STOPS[i]) level++;
  }
  return level;
}

/** 热力方块的形状类：实心四档 / 空心暂停 / 斜纹未公布 / 虚线未知 */
function heatKind(status, limit) {
  var open = status === 'OPEN' || status === 'LIMITED';
  if (open) {
    var lv = heatLevel(limit);
    return lv === null ? 'miss' : 'l' + lv;
  }
  return status === 'UNKNOWN' ? 'unk' : 'off';
}

/** 完整状态文案 */
var STATUS_LABEL = {
  OPEN: '开放申购',
  LIMITED: '限额申购',
  STOPPED: '暂停申购',
  CLOSED: '封闭期',
  UNKNOWN: '额度未公布',
};

/** 短状态文案 */
var STATUS_SHORT = {
  OPEN: '可投',
  LIMITED: '限大额',
  STOPPED: '暂停',
  CLOSED: '封闭',
  UNKNOWN: '未公布',
};

/** 状态标签的颜色类（方点 + 字色） */
function statusClass(s) {
  if (s === 'STOPPED') return 'tag-stop';
  if (s === 'CLOSED') return 'tag-closed';
  if (s === 'UNKNOWN') return 'tag-unknown';
  // 限额＝橄榄（与热力条同族），与网页 statusClass / FamilyCard 同口径
  if (s === 'LIMITED') return 'tag-limit';
  return 'tag-ok';
}

/** 份额类别的固定次序：A → C → D → E → F → 其它 */
var CLASS_ORDER = 'ACDEFGHIJ';
function classRank(cls) {
  var i = CLASS_ORDER.indexOf((cls || '').toUpperCase());
  return i < 0 ? 99 : i;
}

/** 金额：千分位 + 元 */
function money(n) {
  if (n === null || n === undefined || !isFinite(n)) return '—';
  return Number(n).toLocaleString('zh-CN');
}

/** 额度文字：有限额写「N 元」，无数字写 null */
function limitText(limit) {
  return limit === null || limit === undefined ? null : limit + ' 元';
}

// ── 日期：纯字符串 + UTC，绝不碰设备本地时区 ──────────────────
// 小程序跑在用户手机上，跨时区用户不少；用 Date 本地方法会差一天。

/** 星期几：0=周日 … 6=周六 */
function dowOf(date) {
  var p = date.split('-');
  return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])).getUTCDay();
}

/** 日期加减天数，返回 YYYY-MM-DD */
function shiftDate(date, days) {
  var p = date.split('-');
  return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] + days)).toISOString().slice(0, 10);
}

var WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 中文「10月18日 周日」 */
function prettyDate(date) {
  var p = date.split('-');
  return +p[1] + '月' + +p[2] + '日 ' + WEEK[dowOf(date)];
}

/** 「10月18日」 */
function mdLabel(date) {
  var p = date.split('-');
  return +p[1] + '月' + +p[2] + '日';
}

/** 设备当前的东八区日期（小程序里用云函数时间或本地偏移均可，这里取本地 UTC+8 口径） */
function todayCST() {
  var now = new Date();
  // 微信小程序运行在中国用户设备上，但为了口径稳定，仍按东八区算
  var utc = now.getTime() + now.getTimezoneOffset() * 60000;
  var bj = new Date(utc + 8 * 3600000);
  return (
    bj.getFullYear() +
    '-' +
    ('0' + (bj.getMonth() + 1)).slice(-2) +
    '-' +
    ('0' + bj.getDate()).slice(-2)
  );
}

/** 东八区当前时刻 HH:MM */
function nowHM() {
  var now = new Date();
  var utc = now.getTime() + now.getTimezoneOffset() * 60000;
  var bj = new Date(utc + 8 * 3600000);
  return ('0' + bj.getHours()).slice(-2) + ':' + ('0' + bj.getMinutes()).slice(-2);
}

module.exports = {
  LIMIT_STOPS: LIMIT_STOPS,
  heatLevel: heatLevel,
  heatKind: heatKind,
  STATUS_LABEL: STATUS_LABEL,
  STATUS_SHORT: STATUS_SHORT,
  statusClass: statusClass,
  classRank: classRank,
  money: money,
  limitText: limitText,
  dowOf: dowOf,
  shiftDate: shiftDate,
  prettyDate: prettyDate,
  mdLabel: mdLabel,
  todayCST: todayCST,
  nowHM: nowHM,
};
