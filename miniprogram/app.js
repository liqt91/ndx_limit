/**
 * 纳指开门日报 · 小程序
 *
 * 定位：只读的展示壳。真正的数据在网页版（https://ndx.liqt91.top），
 * 小程序里不放任何开户 / 购买 / 跳转入口——这是它能被个人主体上架的前提。
 *
 * 数据流：
 *   抓取脚本 → data/*.json → scripts/mp-sync.mjs → miniprogram/data/bundle.json
 *     →（云开发）云存储 data/bundle.json → 小程序 wx.cloud.downloadFile
 *   包内 data/bundle.json 是兜底：云存储还没配好时也能看到最近一次的数据。
 */
const store = require('./utils/store.js');

App({
  globalData: {
    /** 当前 bundle（已装配好首屏与列表） */
    bundle: null,
    /** bundle 载入时间戳（毫秒） */
    loadedAt: 0,
  },

  onLaunch() {
    // 冷启动时先读缓存渲染，再异步拉云存储覆盖：首屏不等网络
    store.loadCached().then((cached) => {
      if (cached) this.globalData.bundle = cached;
      store.fetchRemote().then((fresh) => {
        if (fresh) {
          this.globalData.bundle = fresh;
          this.globalData.loadedAt = Date.now();
          // 数据变了就通知当前页面重绘
          const pages = getCurrentPages();
          if (pages.length) {
            const top = pages[pages.length - 1];
            if (top && typeof top.onBundleUpdate === 'function') top.onBundleUpdate(fresh);
          }
        }
      });
    });
  },
});
