# 纳指开门日报 · 微信小程序

这是网页版（<https://ndx.liqt91.top>）的**只读展示壳**。真身在网页版，小程序里不放任何开户、
购买、跳转入口——这是它能被个人主体上架的前提。

```
抓取脚本 → data/*.json → scripts/mp-sync.mjs → miniprogram/data/bundle.json
                                                    ↓（上传到云存储）
                                            小程序 wx.cloud.downloadFile
```

数据不打包进小程序包：包内 JSON 随版本发布走，而数据每天变，打进包里每更新一次就得
重新提审一次。包内那份 `data/bundle.json` 只是兜底（云开发没配好时也能看到最近一次数据）。

## 一、上架前要办的三件事

1. **注册小程序**（个人主体即可）。在 <https://mp.weixin.qq.com> 走完注册与实名。
2. **选服务类目**：推荐「信息查询、办公、备忘录」这类工具类目。名称建议避开
   「基金 / 理财 / 额度 / 投资」等词（例如「纳指开门日报」），并在「关于」页写清
   口径与免责。本项目只做信息汇总，不提供交易入口——类目与内容必须一致。
3. **小程序备案**：自 2023-09 起强制，个人主体也能办，在后台提交即可（1–20 个工作日）。
   备案只影响上架，不影响开发与体验版。

> 域名 ICP 备案不用做：小程序不直连任何自有域名（邮箱订阅由云函数转发），
> `ndx.liqt91.top` 托管在境外，无法备案也不影响。

## 二、云开发环境

小程序 → 云开发 → 开通环境（选按量付费或免费额度），记下**环境 ID**。

需要建一个集合 `subs`（云数据库 → 新建集合），用于存订阅推送次数。

然后把 `miniprogram/config.js` 填上：

```js
module.exports = {
  CLOUD_ENV: '你的环境 ID',
  CLOUD_BUNDLE: 'cloud://你的环境 ID/data/bundle.json',
  SUBSCRIBE_TEMPLATE_ID: '订阅消息模板 ID',
  API_SUBSCRIBE: 'https://ndx.liqt91.top/api/subscribe',
  ...
};
```

`SUBSCRIBE_TEMPLATE_ID` 在小程序后台「订阅消息 → 公共模板」里挑一个「服务通知」类的，
把模板 ID 填进来；字段名要与模板一致，否则发送会报 47003。

## 三、云函数

两个函数在 `miniprogram/cloudfunctions/` 下，用微信开发者工具「上传并部署：云端安装依赖」：

| 函数 | 作用 |
| --- | --- |
| `notify` | 查/攒推送次数；`action=dispatch` 时给所有额度 > 0 的用户发一条订阅消息并扣 1 次 |
| `subscribe-email` | 把小程序里的邮箱订阅转发到网页版的 `/api/subscribe`（名单仍在 EdgeOne KV） |

**每日推送**：`notify` 的 `dispatch` 需要一个定时触发器。在云开发控制台给该函数配
「定时触发器」，cron 填 `0 50 14 * * *`（每天 14:50，对齐抓取的收盘前那次）。
定时触发器只能在控制台配，开发者工具里改 `config.json` 无效。

额度上限 60 次；发送失败**不扣**额度（用户攒了 50 次一次都没收到是最坏的体验）。

## 四、数据更新

抓取跑完后（`npm run scrape`），同步一次小程序数据：

```bash
node scripts/mp-sync.mjs      # 重新生成 miniprogram/data/bundle.json
```

然后把 `miniprogram/data/bundle.json` 上传到云存储的 `data/bundle.json` 路径：

- **最省事**：云开发控制台 → 存储 → 上传文件，选 `miniprogram/data/bundle.json`，
  存储路径填 `data/bundle.json`。
- **自动化**：装 `@cloudbase/node-sdk` 后用 `scripts/mp-upload.mjs`（见该文件头部的说明），
  密钥从环境变量读，不要写进仓库。

校验（建议进 CI，与抓取同一个 job 里跑）：

```bash
node scripts/mp-check.mjs      # 结构 / 语法 / 事件绑定 / 数据同步 / 口径交叉验证 / 合规自检
```

`mp-check` 里有三组口径交叉验证：小程序端的装配、Node 端的摘要、抓取脚本当时记下的值，
三者必须给出同一个答案——数字对不上说明某处口径漂了。

## 五、本地开发

用微信开发者工具打开 `miniprogram/` 目录（`project.config.json` 里 `miniprogramRoot` 是 `./`）。
`appid` 暂时是 `touristappid`（测试号），换成自己的 AppID 后把 `cloudfunctionRoot`
指向 `cloudfunctions/`（已经是了）。

体验版即可自测，不必等备案与审核。

## 六、已知的坑

- **别把额度数据塞进包内 JSON 就完事**：那样每次数据更新都要重新提审，走不通。
- **订阅次数必须存在云端**：本地存储换设备、清缓存就丢，用户会莫名发现额度没了。
- **`wx.requestSubscribeMessage` 一次授权只对应一条消息**：想每天推就得让用户攒次数，
  攒够 50 次 = 推 50 天。UI 上要写清规则，否则用户点一下发现只多一条会以为被骗。
- **不要在小程序里放外链跳转**：`web-view` 的业务域名要在目标域名根目录放校验文件，
  第三方域名放不了；自己的域名又因托管在境外无法备案。
- **合规自检在 `mp-check.mjs` 里**：新增页面若出现「立即购买」这类行动号召、
  `web-view`、或页面里直接 `wx.request`，门禁会变红。
