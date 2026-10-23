/**
 * 运行时配置。改这里，不要改业务代码。
 *
 * 上架前需要填的：
 *   CLOUD_ENV            云开发环境 ID（小程序 → 云开发 → 设置）
 *   CLOUD_BUNDLE         云存储里数据文件的 fileID，形如 cloud://<env>/data/bundle.json
 *   SUBSCRIBE_TEMPLATE_ID  订阅消息模板 ID（小程序 → 订阅消息 → 公共模板 → 挑一个「服务通知」类）
 *
 * 留空时的行为：不报错，只是对应能力不可用（云存储拿不到 → 用包内兜底数据；
 * 模板 ID 为空 → 订阅按钮提示「未配置」；邮箱订阅走 API_SUBSCRIBE）。
 */
module.exports = {
  CLOUD_ENV: '',
  CLOUD_BUNDLE: '',
  SUBSCRIBE_TEMPLATE_ID: '',

  /** 邮箱订阅接口（由云函数转发，避开小程序的 request 合法域名限制） */
  API_SUBSCRIBE: 'https://qdii.liqt91.top/api/subscribe',
  API_UNSUBSCRIBE: 'https://qdii.liqt91.top/api/unsubscribe',

  /** 网页版地址：只在「关于」页作为纯文本给出，不做成可点跳转 */
  SITE_URL: 'https://qdii.liqt91.top',
  SITE_NAME: '纳指开门日报',

  /** 缓存 key 与最长有效期（小时） */
  CACHE_KEY: 'ndx_bundle_cache',
  CACHE_MAX_AGE_H: 12,
};
