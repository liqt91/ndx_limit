const config = require('../../config.js');

/** 关于页：口径、来源、边界。全部是静态内容，不依赖数据加载。 */
Page({
  data: {
    siteUrl: '',
    siteName: '',
  },

  onLoad() {
    this.setData({ siteUrl: config.SITE_URL, siteName: config.SITE_NAME });
  },
});
