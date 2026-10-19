# 纳指开门日报（静态复刻版）

一个**纯静态**的「纳斯达克 QDII 基金每日申购额度追踪」站。技术栈 **Astro（SSG）**，
通过 **GitHub Actions 每天定时重新构建** 实现「每日更新」——构建在哪天跑，页面数据就体现哪天，
全程**不需要服务器、数据库或运行时**。产物是纯 HTML/CSS/JS，可直接托管到任意静态服务
（本方案默认部署到**腾讯云 COS 静态网站**）。

## 功能

- **今日**：代销总可投、开门/暂停统计、每只基金份额卡片 + 近 30 天开门柱状图
- **详情** `/f/[code]`：单只基金份额的状态变化记录、历史快照、相关公告
- **历史** `/daily`：最近 15 天每日快照摘要
- **我的基金** `/my`：在浏览器 localStorage 里存基金代码，纯前端过滤展示（不上传）
- **订阅** `/subscribe`：纯静态表单（依赖第三方表单服务，见下）

## 本地开发

```bash
npm install
npm run dev        # 本地预览 http://localhost:4321
npm run build      # 产出 dist/ 静态文件
npm run preview    # 预览构建产物
```

## 部署到腾讯云 COS（静态网站）

1. 在腾讯云创建一个**公有读**存储桶，开启 **静态网站托管**（得到 `*.cos-website.*` 域名）。
2. 在 GitHub 仓库 `Settings → Secrets and variables → Actions` 添加：
   - `COS_BUCKET`：存储桶名称
   - `COS_REGION`：地域，如 `ap-guangzhou`
   - `COS_SECRET_ID` / `COS_SECRET_KEY`：具有该桶读写权限的 API 密钥
3. 把代码推到 GitHub，Actions 会**每天北京时间 08:00** 自动 `build + 部署`；也可以在
   Actions 页面手动 `Run workflow` 立即触发。
4. （可选）在 COS / DNS 控制台绑自定义域名并开启 CDN，加速国内访问。

> 部署脚本见 `scripts/deploy-cos.sh`，使用腾讯云官方 `coscli` 做增量同步（`--delete` 会清理已删除文件）。

## 数据从哪来（真实抓取）

数据由 `scripts/scrape.mjs` 从**天天基金详情页**（`https://fund.eastmoney.com/{code}.html`）
解析「交易状态 / 单日累计购买上限 / 官方简称」，写入两个文件：

- `data/history.json`：每只基金按天的 `{date, status, limit}`，**追加式累积**（保留 60 天，
  loader 读取时截 30 天），这就是 30 天柱状图的数据源。
- `data/fund-meta.json`：每只基金的官方简称。

`src/data/loader.ts` 读取 `funds.json`(目录) + 上面两个文件（+ 可选的 `direct-overrides.json`），
装配成 `DailySnapshot`，页面直接用。**静态站「每日更新」靠 CI 每天重建**
(见 deploy.yml)：重建日 = 数据日，无需服务器/数据库。

```bash
node scripts/scrape.mjs            # 抓全部基金
node scripts/scrape.mjs 019736     # 只抓某只（调试）
npm run ci:build                  # 抓取 + 构建一步到位
```

> 本地没跑 scrape 时，`loader` 会自动回退到 `src/data/mock.ts` 的兜底数据，保证能 build。

### 直销渠道与公告（可选，本版默认不使用）

本版本**仅使用代销渠道（天天基金自动抓取）的数据**，直销渠道限额与基金公司公告暂不涉及。
若日后需要补充某只基金的直销额度/公告，可在 `data/direct-overrides.json` 按代码手工填写
（`directLimitText` / `directAnnTitle` / `directAnnUrl`），缺省留空即可，不影响任何页面。

### 数据字段对照（`src/data/types.ts`）

对齐原站 `/api/holdings`：`purchaseStatus`(OPEN/LIMITED/STOPPED/CLOSED/UNKNOWN)、
`dailyLimit`(代销单日上限)、`limitText`、`directLimitText`、`directAnnUrl`、`history`(30 天)。

## 多品牌（纳指 / 标普）

原站同套代码跑了 `nasdaq` 和 `sp500` 两个子站。复刻时可以用环境变量（如 `INDEX_KEY`）
切换基金清单与文案，CI 里跑两次构建分别部署到不同 bucket/子域名。

## 订阅功能

纯静态站没有后端，`/subscribe` 是一个 POST 到第三方表单服务的表单。部署前把
`src/pages/subscribe.astro` 里的 `FORM_ACTION` 换成你自己的接收地址：

- **Formspree**（最简单）：`https://formspree.io/f/YOUR_FORM_ID`
- **腾讯云函数 / 自建接口**：任何支持表单 POST 的 HTTPS 地址

每天早上 8 点发邮件的能力需要单独的定时任务（例如云函数定时触发器调用邮件服务），
不在本静态站范围内，可另起一个轻量服务实现。

## 目录结构

```
src/
  data/        数据层：types（schema）、mock（mock 生成器）、loader（数据获取抽象）、dates
  layouts/     BaseLayout
  components/  SiteHeader、Bars（30天柱状图）、FundCard（基金卡片）
  pages/       index（今日）、f/[code]（详情）、daily（历史）、my（我的基金）、subscribe（订阅）
public/       logo / favicon / hero 等静态资源
scripts/      deploy-cos.sh 部署脚本
.github/      workflows/deploy.yml 定时构建+部署
```
