const config = require('../../config.js');

/**
 * 订阅页。
 *
 * 两条通道，各有各的门槛：
 *   1. 微信订阅通知：平台规则是「一次授权 = 一条消息」，所以这里用「攒次数」的办法——
 *      用户每点一次按钮就多攒一条发送额度，攒够 N 次就能推 N 天。次数存在云函数侧
 *      （云数据库），本地不存（换设备、清缓存都会丢）。
 *   2. 邮箱订阅：与网页版同一套名单（EdgeOne KV）。小程序端不直连——那需要把域名
 *      配进 request 合法域名，而域名得先完成 ICP 备案；改由云函数转发，绕开这个限制。
 */
Page({
  data: {
    cloudReady: false,
    templateReady: false,
    quota: null,
    quotaMsg: '',
    busy: false,
    email: '',
    emailMsg: '',
    emailState: '',
  },

  onLoad() {
    this.setData({
      cloudReady: !!(config.CLOUD_ENV),
      templateReady: !!(config.SUBSCRIBE_TEMPLATE_ID),
    });
    if (config.CLOUD_ENV) this.queryQuota();
  },

  onShow() {
    if (config.CLOUD_ENV) this.queryQuota();
  },

  call(name, data) {
    if (!config.CLOUD_ENV) {
      return Promise.reject(new Error('未配置云开发环境'));
    }
    if (!wx.cloud) {
      return Promise.reject(new Error('基础库不支持云开发'));
    }
    try {
      wx.cloud.init({ env: config.CLOUD_ENV, traceUser: false });
    } catch (e) {
      /* 已初始化时忽略 */
    }
    return wx.cloud.callFunction({ name: name, data: data });
  },

  queryQuota() {
    this.call('notify', { action: 'query' })
      .then((res) => {
        const r = res && res.result ? res.result : {};
        this.setData({
          quota: typeof r.quota === 'number' ? r.quota : 0,
          quotaMsg: r.ok ? '' : r.error || '',
        });
      })
      .catch((e) => {
        this.setData({ quotaMsg: '云函数调用失败：' + (e && e.message ? e.message : e) });
      });
  },

  /** 攒一次发送额度：先请求订阅授权，用户允许了才记次数 */
  addQuota() {
    if (this.data.busy) return;
    if (!config.SUBSCRIBE_TEMPLATE_ID) {
      this.setData({ quotaMsg: '还没配置订阅消息模板（config.js 的 SUBSCRIBE_TEMPLATE_ID）' });
      return;
    }
    this.setData({ busy: true, quotaMsg: '' });

    wx.requestSubscribeMessage({
      tmplIds: [config.SUBSCRIBE_TEMPLATE_ID],
      success: (res) => {
        const state = res[config.SUBSCRIBE_TEMPLATE_ID];
        if (state !== 'accept') {
          this.setData({
            busy: false,
            quotaMsg: state === 'reject' ? '你拒绝了通知授权，之后不会再弹窗。可在「设置-小程序-通知」里重新打开。' : '这次没有授权成功。',
          });
          return;
        }
        this.call('notify', { action: 'add', count: 1 })
          .then((r) => {
            const rr = r && r.result ? r.result : {};
            this.setData({
              busy: false,
              quota: typeof rr.quota === 'number' ? rr.quota : this.data.quota,
              quotaMsg: '',
            });
          })
          .catch((e) => {
            this.setData({ busy: false, quotaMsg: '记账失败：' + (e && e.message ? e.message : e) });
          });
      },
      fail: (e) => {
        this.setData({ busy: false, quotaMsg: '请求授权失败：' + (e && e.errMsg ? e.errMsg : e) });
      },
    });
  },

  onEmailInput(e) {
    this.setData({ email: e.detail.value, emailMsg: '', emailState: '' });
  },

  subscribeEmail() {
    const email = (this.data.email || '').trim();
    if (!email) {
      this.setData({ emailMsg: '请填邮箱', emailState: 'err' });
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      this.setData({ emailMsg: '这个邮箱地址看起来不太对', emailState: 'err' });
      return;
    }
    this.setData({ busy: true, emailMsg: '正在提交…', emailState: '' });
    this.call('subscribe-email', { email: email })
      .then((r) => {
        const rr = r && r.result ? r.result : {};
        this.setData({
          busy: false,
          emailMsg: rr.ok ? '已提交。若要求确认，请去邮箱点一下确认链接。' : rr.error || '提交失败',
          emailState: rr.ok ? 'ok' : 'err',
          email: rr.ok ? '' : this.data.email,
        });
      })
      .catch((e) => {
        this.setData({ busy: false, emailMsg: '提交失败：' + (e && e.message ? e.message : e), emailState: 'err' });
      });
  },
});
