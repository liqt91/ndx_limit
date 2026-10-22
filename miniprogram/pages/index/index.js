const app = getApp();
const store = require('../../utils/store.js');

Page({
  data: {
    ready: false,
    empty: false,
    headlineParts: [],
    headline: '',
    summaryDelta: '',
    updatedLabel: '',
    updatedTime: '',
    snapDateMd: '',
    isStale: false,
    isTrading: true,
    families: [],
    usdFamilies: [],
    changes: [],
    hasChanges: false,
  },

  onLoad() {
    this.load();
  },

  onShow() {
    this.load();
  },

  /** 云存储拉到新数据后由 app 派发过来 */
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
    const a = store.assemble(raw);
    if (!a) {
      this.setData({ ready: true, empty: true });
      return;
    }
    const md = require('../../utils/format.js').mdLabel(a.snapDate);
    this.setData({
      ready: true,
      empty: false,
      headlineParts: a.headlineParts,
      headline: a.headline,
      summaryDelta: a.summaryDelta,
      updatedLabel: a.updatedLabel,
      updatedTime: a.updatedTime || '',
      snapDateMd: md,
      isStale: a.isStale,
      isTrading: a.isTrading,
      families: a.families,
      usdFamilies: a.usdFamilies,
      changes: a.changes,
      hasChanges: a.changes.length > 0,
    });
  },

  goDetail(e) {
    const code = e.currentTarget.dataset.code;
    if (!code) return;
    wx.navigateTo({ url: '/pages/detail/detail?code=' + code });
  },
});
