const app = getApp();
const store = require('../../utils/store.js');
const fmt = require('../../utils/format.js');

/**
 * 份额详情：某一只份额的当前状态、额度、21 天走势与相关公告。
 * 口径与网页版 /f/<code> 一致。
 */
Page({
  data: {
    ready: false,
    notFound: false,
    code: '',
    name: '',
    company: '',
    cls: '',
    currency: '',
    status: '',
    statusLabel: '',
    statusClass: '',
    statusShort: '',
    limitText: '',
    limitValue: '',
    hasMissing: false,
    heat: [],
    heatFrom: '',
    heatTo: '',
    anns: [],
  },

  onLoad(q) {
    this.code = q && q.code ? q.code : '';
    this.load();
  },

  onShow() {
    if (this.code) this.load();
  },

  onBundleUpdate() {
    this.load();
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
    if (!this.code) {
      this.setData({ ready: true, notFound: true });
      return;
    }
    let share = null;
    for (var i = 0; i < raw.shares.length; i++) {
      if (raw.shares[i].code === this.code) {
        share = raw.shares[i];
        break;
      }
    }
    if (!share) {
      this.setData({ ready: true, notFound: true });
      return;
    }

    var hist = (share.history || []).slice(-21);
    var heat = hist.map(function (d) {
      var kind = fmt.heatKind(d.s, d.l);
      var tip;
      if (d.s === 'OPEN' || d.s === 'LIMITED') tip = d.l === null ? '可申购，额度未公布' : d.l + '元';
      else if (d.s === 'CLOSED') tip = '封闭期';
      else if (d.s === 'UNKNOWN') tip = '状态未公布';
      else tip = '暂停申购';
      return { kind: kind, tip: fmt.prettyDate(d.d) + ' ' + tip };
    });

    var anns = (raw.announcements && raw.announcements[this.code]) || [];

    this.setData({
      ready: true,
      notFound: false,
      code: share.code,
      name: share.name,
      company: share.company,
      cls: share.cls,
      currency: share.currency,
      status: share.status,
      statusLabel: fmt.STATUS_LABEL[share.status] || '',
      statusShort: fmt.STATUS_SHORT[share.status] || '',
      statusClass: fmt.statusClass(share.status),
      limitValue: share.limit === null || share.limit === undefined ? '' : String(share.limit),
      limitText:
        share.limit === null || share.limit === undefined
          ? share.status === 'LIMITED'
            ? '额度未公布'
            : '—'
          : share.limit + ' 元',
      hasMissing: share.limitMissing === true,
      heat: heat,
      heatFrom: hist.length ? hist[0].d : '',
      heatTo: hist.length ? hist[hist.length - 1].d : '',
      anns: anns,
    });
  },
});
