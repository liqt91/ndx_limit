const app = getApp();
const store = require('../../utils/store.js');
const fmt = require('../../utils/format.js');

/**
 * 交易日历：沪纽双市场四态。
 * 口径与网页版 src/data/trading-days.ts 一致——判定结果在 bundle.calendar 里，
 * 这里只负责把某个月铺成网格。
 */
function monthGrid(calendar, y, m) {
  const pad = (n) => ('0' + n).slice(-2);
  const first = `${y}-${pad(m)}-01`;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lead = (fmt.dowOf(first) + 6) % 7; // 周一为一周之始
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  let tradeCount = 0;
  let usClosedCount = 0;
  for (let d = 1; d <= lastDay; d++) {
    const date = `${y}-${pad(m)}-${pad(d)}`;
    const info = calendar[date];
    const state = info ? info.s : 'UNKNOWN';
    if (state === 'TRADING') tradeCount++;
    if (state === 'US_CLOSED') usClosedCount++;
    cells.push({
      date: date,
      day: d,
      state: state,
      trade: state === 'TRADING',
      cnReason: info ? info.cr : '日历未覆盖',
      usReason: info ? info.ur : '日历未覆盖',
      usHoliday: info ? info.uh : null,
      title: info ? info.t : `${m}月${d}日`,
    });
  }
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks = [];
  const weekMap = {};
  for (let i = 0; i < cells.length; i += 7) {
    const week = cells.slice(i, i + 7);
    weeks.push(week);
    for (const c of week) if (c) weekMap[c.date] = c;
  }
  return {
    year: y,
    month: m,
    label: `${y} 年 ${m} 月`,
    shortLabel: `${m} 月`,
    weeks: weeks,
    weekMap: weekMap,
    tradeCount: tradeCount,
    usClosedCount: usClosedCount,
  };
}

Page({
  data: {
    ready: false,
    weeks: [],
    label: '',
    year: 0,
    month: 0,
    tradeCount: 0,
    usClosedCount: 0,
    today: '',
    todayMark: '',
    selected: null,
  },

  onLoad() {
    this.setData({ today: fmt.todayCST(), todayMark: fmt.todayCST() });
    this.load();
  },

  onShow() {
    this.load();
  },

  onBundleUpdate(bundle) {
    this.apply(bundle);
  },

  load() {
    const b = app.globalData.bundle;
    if (b) {
      this.apply(b);
      return;
    }
    store.loadCached().then((cached) => {
      if (cached) this.apply(cached);
    });
  },

  apply(raw) {
    const t = fmt.todayCST();
    const y = Number(t.slice(0, 4));
    const m = Number(t.slice(5, 7));
    this.showMonth(raw.calendar || {}, y, m);
  },

  showMonth(calendar, y, m) {
    const g = monthGrid(calendar, y, m);
    this.setData({
      ready: true,
      weeks: g.weeks,
      label: g.label,
      year: g.year,
      month: g.month,
      tradeCount: g.tradeCount,
      usClosedCount: g.usClosedCount,
      selected: null,
    });
    this.weekMap = g.weekMap;
  },

  shiftMonth(e) {
    const dir = Number(e.currentTarget.dataset.dir);
    const b = app.globalData.bundle;
    if (!b) return;
    let ny = this.data.year;
    let nm = this.data.month + dir;
    if (nm < 1) {
      nm = 12;
      ny--;
    } else if (nm > 12) {
      nm = 1;
      ny++;
    }
    this.showMonth(b.calendar || {}, ny, nm);
  },

  pick(e) {
    const date = e.currentTarget.dataset.date;
    if (!date) return;
    if (this.data.selected && this.data.selected.date === date) {
      this.setData({ selected: null });
      return;
    }
    const cell = this.weekMap ? this.weekMap[date] : null;
    this.setData({ selected: cell || { date: date, title: date } });
  },
});
