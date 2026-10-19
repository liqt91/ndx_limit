# 纳指开门日报（静态复刻版）

一个**纯静态**的「纳斯达克 QDII 基金每日申购额度追踪」站。技术栈 **Astro（SSG）**，
全程**不需要服务器、数据库或运行时**。产物是纯 HTML/CSS/JS，托管在 **EdgeOne Pages**（腾讯云免费的
静态网站服务，自带全球 CDN + HTTPS + DDoS 防护）；**每日更新**由 **GitHub Actions cron**（永久免费）
每天抓取数据并回写仓库、自动触发 EdgeOne 重建实现——构建在哪天跑，页面数据就体现哪天。

## 功能

- **今日**：代销总可投、开门/暂停统计、每只基金份额卡片 + 近 30 天开门柱状图
- **详情** `/f/[code]`：单只基金份额的状态变化记录、历史快照、相关公告
- **历史** `/daily`：最近 15 天每日快照摘要
- **我的基金** `/my`：在浏览器 localStorage 里存基金代码，纯前端过滤展示（不上传）
- **订阅** `/subscribe`：纯静态表单（依赖第三方表单服务，见下）

> 注：只展示**人民币份额**。美元份额仍在 `funds.json` 目录与抓取范围内（历史数据继续累积），
> 只是不在站内渲染——过滤点在 `src/data/loader.ts` 的 `loadTodaySnapshot()`，日后想展示删掉那两行即可。

## 本地开发

```bash
npm install
npm run dev        # 本地预览 http://localhost:4321
npm run build      # 产出 dist/ 静态文件
npm run preview    # 预览构建产物
```

## 部署（EdgeOne Pages + GitHub Actions）

整合方案：**发布托管在 EdgeOne Pages（免费、push 触发、自带 CDN），每日调度在 GitHub Actions cron（永久免费）**。
两条免费链路叠加，整站零成本、零腾讯密钥。

### 1. EdgeOne Pages（一次性）

1. 登录 [EdgeOne Pages 控制台](https://console.cloud.tencent.com/edgeone/pages)，「新建项目 → 导入 Git 仓库」连到本 GitHub 仓库。
2. 框架预设选 **Astro**（连仓库后自动识别 install/build/dist）；**构建命令务必用 `npm run build`**，
   **不要**填裸 `astro build`——EdgeOne 构建 shell 里没有全局 astro，裸跑会 `command not found`（exit 127）。
3. 首次部署即用当前代码 + 已提交的 `data/` 构建出一个线上站点，分配 `*.edgeone.app` 默认域名。
   - 国内版：国内 CDN 快，绑自定义域名需 **ICP 备案**；国际版：免备案、全球快但国内慢。
4. **绑定自定义子域名 `ndx.liqt91.top`（推荐）**：在 EdgeOne 项目「自定义域名」里添加 `ndx.liqt91.top`，
   按控制台提示在 DNS 给 `ndx` 加一条 **CNAME**（指向 EdgeOne 提供的地址，或把 `liqt91.top` 整体 NS 托管给 EdgeOne），
   等证书下发后该子域名即生效。同时把 `astro.config.mjs` 的 `site` 改成 `https://ndx.liqt91.top`（已填好），
   这样 sitemap / canonical / 绝对链接都用正式域名，搜索引擎与分享卡片不会指向 `*.edgeone.app`。

### 2. GitHub Actions（每日调度，已内置）

`deploy.yml` 每天北京时间 08:00 触发：跑 `scrape.mjs` 抓今日数据 → 把 `history.json` / `fund-meta.json`
**回写并 push 仓库**。这次 push 自动触发 EdgeOne 重新构建部署。不需要 COS / coscli / 任何腾讯密钥。

- **健康门禁联动**：覆盖率 < 90% 时 `scrape.mjs` 以非零码退出，job 中止、不回写、EdgeOne 保留上次好构建。
- **可选通知**：仓库 `Settings → Secrets` 加 `NOTIFY_WEBHOOK`（飞书机器人）即开启「今日变化」推送。
- **手动触发**：Actions 页面 `Run workflow` 可立即跑一轮（首次验证用）。
- 回写那次 commit 同时保住了 GitHub 对公开仓库「60 天无活动停用定时任务」的规则，日程不会被静默停。

> 历史部署用的 `scripts/deploy-cos.sh`（coscli + COS）已弃用；如需改回 COS 见 git 历史。

## 数据从哪来（真实抓取）

数据由 `scripts/scrape.mjs` 从**天天基金详情页**（`https://fund.eastmoney.com/{code}.html`）
解析「交易状态 / 单日累计购买上限 / 官方简称」，写入两个文件：

- `data/history.json`：每只基金按天的 `{date, status, limit}`，**追加式累积**（保留 60 天，
  loader 读取时截 30 天），这就是 30 天柱状图的数据源。
- `data/fund-meta.json`：每只基金的官方简称。

`src/data/loader.ts` 读取 `funds.json`(目录) + 上面两个文件（+ 可选的 `direct-overrides.json`），
装配成 `DailySnapshot`，页面直接用。**静态站「每日更新」靠 GitHub Actions 每天抓取并回写仓库**
(见 deploy.yml)，那次 push 触发 EdgeOne Pages 重建：重建日 = 数据日，无需服务器/数据库。

```bash
node scripts/scrape.mjs            # 抓全部基金
node scripts/scrape.mjs 019736     # 只抓某只（调试）
npm run ci:build                  # 本地：抓取 + 构建一步到位（= scrape.mjs && astro build）
```

> 本地没跑 scrape 时，`loader` 会自动回退到 `src/data/mock.ts` 的兜底数据，保证能 build。

### 直销渠道与公告（可选，本版默认不使用）

本版本**仅使用代销渠道（天天基金自动抓取）的数据**，直销渠道限额与基金公司公告暂不涉及。
若日后需要补充某只基金的直销额度/公告，可在 `data/direct-overrides.json` 按代码手工填写
（`directLimitText` / `directAnnTitle` / `directAnnUrl`），缺省留空即可，不影响任何页面。

### 抓取健康门禁与数据质量

- **健康门禁**：`scrape.mjs` 跑完会统计人民币份额覆盖率（成功解析数 / 目标数），低于阈值（默认 90%，
  可用 `SCRAPE_MIN_COVERAGE` 环境变量覆盖）即以退出码 2 结束，使 `npm run ci:build` 失败、**不部署**——
  防止天天基金改版或网络抖动时把「今日全暂停 / 全未知」当真事发出来。抓取本身也做了
  指数退避 + 抖动重试、响应大小上限、HTTPS 主机白名单、原子写（`tmp → rename`）。
- **每日变化**：构建时 `loader.loadDailyChanges()` 对比每只人民币份额最近两天，产出「开门 / 暂停 /
  额度变动」清单，首页「今日变化」区块展示；`scripts/notify.mjs` 在 CI 构建后把同一份变化推送至
  `NOTIFY_WEBHOOK`（飞书机器人 text 格式），无变化或数据不完整时静默跳过。
- **额度待核验**：个别份额页面显示「限大额」却未公布具体上限，`loader` 会打 `limitMissing` 标记，
  前端显示「限额待核验 / 含待核验额度（≈）」，**不臆造金额**——宁可未知、不赌错。

### 数据字段对照（`src/data/types.ts`）

对齐原站 `/api/holdings`：`purchaseStatus`(OPEN/LIMITED/STOPPED/CLOSED/UNKNOWN)、
`dailyLimit`(代销单日上限)、`limitText`、`directLimitText`、`directAnnUrl`、`history`(30 天)。

## 多品牌（纳指 / 标普）

原站同套代码跑了 `nasdaq` 和 `sp500` 两个子站。复刻时可以用环境变量（如 `INDEX_KEY`）
切换基金清单与文案，CI 里跑两次构建分别部署到不同 bucket/子域名。

## 订阅功能

纯静态站没有后端，订阅与每日群发都交给 **Buttondown**（免费邮件简报服务，免费额度 100 订阅者），
站点本身**不存储任何邮箱**。整条链路仍跑在既有的免费 GitHub Actions 上，零服务器：

1. **收邮箱**：`/subscribe` 页面表单 POST 到 Buttondown 公开 embed 端点
   `https://buttondown.com/api/emails/embed-subscribe/liqt91`（免密钥，需带隐藏字段 `embed=1`）。
   用户名已固化为 `liqt91`（= `buttondown.com/liqt91`）。
2. **每日群发**：`deploy.yml` 在每天 08:00 抓取后调用 `scripts/broadcast.mjs`，调 Buttondown API
   `POST /v1/emails`（密钥 `BUTTONDOWN_API_KEY`，仅服务端使用）把日报群发给全部订阅者。
   **无变化也发送**（正文含「今日无变化」），满足每日打卡。
3. **自定义订阅成功页**：站内已有 `/subscribed`（`src/pages/subscribed.astro`）。在 Buttondown
   后台把两个跳转字段都指向它，即可让访客提交/确认后落到自己的品牌页，而不是 Buttondown 默认页：
   - `subscription_redirect_url` → `https://ndx.liqt91.top/subscribed`（提交表单后立刻跳，此时尚未确认）
   - `subscription_confirmation_redirect_url` → `https://ndx.liqt91.top/subscribed`（点确认信后跳，真正成功）

   这两个字段在 Buttondown 后台 Settings 里设置；若 UI 未暴露，可用 API `PATCH /v1/newsletters/{id}`
   写入（`id` 先由 `GET /v1/newsletters` 取得）。双重确认下 `/subscribed` 页面已同时兼容
   「去收信确认」与「已确认」两种到达时机。
4. **管理员自通知（可选）**：另可在仓库 Secrets 配 `NOTIFY_WEBHOOK`（飞书机器人 / Server酱 SCKEY），
   让 `scripts/notify.mjs` 把变化推给站长自己巡检（单收件人，非订阅人广播）。

所需密钥（仓库 `Settings → Secrets → Actions`）：
- `BUTTONDOWN_API_KEY`：Buttondown API Key（Settings → API），启用订阅人群发。
- `NOTIFY_WEBHOOK` + 可选 `NOTIFY_CHANNEL`：管理员飞书/微信自通知，不填则不发。

> 早期方案（Formspree + 云函数定时发信）已弃用：Formspree 仅收邮箱不发信，仍需另起服务，
> 不如 Buttondown 一站式（收+发+名单+送达率）且免费额度够用。

## 目录结构

```
src/
  data/        数据层：types（schema）、mock（mock 生成器）、loader（数据获取抽象）、dates
  layouts/     BaseLayout
  components/  SiteHeader、Bars（30天柱状图）、FundCard（基金卡片）
  pages/       index（今日）、f/[code]（详情）、daily（历史）、my（我的基金）、subscribe（订阅）
public/       logo / favicon / hero 等静态资源
scripts/      scrape.mjs 抓取、digest.mjs 日报构建、notify.mjs 管理员自通知、broadcast.mjs 订阅人群发（deploy-cos.sh 已弃用）
.github/      workflows/deploy.yml 每日抓取+回写（触发 EdgeOne Pages 重建）
```
