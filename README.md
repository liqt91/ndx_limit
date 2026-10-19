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
- **订阅** `/subscribe`：本站原生表单，同域边缘函数收邮箱（见下）

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

### 2. GitHub Actions（两个独立 workflow，已内置）

抓数据与发邮件**故意拆成两个 workflow**，各自调度、各自失败，互不牵连：

| workflow | 时间（北京） | 职责 |
|---|---|---|
| `refresh.yml` | 08:00 | `scrape.mjs` 抓今日数据 → 回写 `history.json` / `fund-meta.json` 并 push |
| `broadcast.yml` | 08:20 | 校验数据是今天的 → 拉订阅名单 → SMTP 群发日报 |

为什么拆开：
- `scrape.mjs` 只用 Node 内置模块，**不需要 `npm ci`**，抓取那一步从 50 秒降到 15 秒级，也少掉「装依赖失败」一整类故障；
- 发信失败不该把「数据更新成功」染红（以前混在一起，红了分不清是谁坏了）；
- 想重试发信时，不必重跑抓取、也不必再 push 一次数据。

- **健康门禁联动**：覆盖率 < 90% 时 `scrape.mjs` 以非零码退出，job 中止、不回写、EdgeOne 保留上次好构建。
- **发信前二次门禁**：`broadcast.yml` 先跑 `scripts/check-freshness.mjs`，要求 `history.json` 最新日期**就是今天**
  且覆盖率达标，否则退出码 2、一封信都不发——宁可当天不发，也不把旧数据当今天推出去。
- **手动触发**：`broadcast.yml` 的 `Run workflow` 默认 `mode=dry-run`（只打印不发信），确认无误再选 `send`。
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
(见 `refresh.yml`)，那次 push 触发 EdgeOne Pages 重建：重建日 = 数据日，无需服务器/数据库。

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

访客全程只访问本域名：不跳转、不出现第三方品牌、国内无需任何代理。整条链路零服务器。

1. **收邮箱（同域边缘函数）**：`/subscribe` 是本站原生表单，`fetch POST /api/subscribe`
   → `edge-functions/api/subscribe.js`，跑在 EdgeOne 边缘节点，写入 KV。
   - 邮箱归一化为小写、SHA-256 后做 key（`sub_<hex>`），重复订阅幂等；
   - 蜜罐字段 + Origin 校验防刷，另建议在控制台对 `/api/subscribe` 加限频规则；
   - 只收集邮箱一个字段，页面已写明用途与退订方式。
2. **取名单（带鉴权的只读接口）**：`GET /api/subscribers`，需 `Authorization: Bearer <SUBSCRIBERS_TOKEN>`，
   分页遍历 KV 返回 `{count, emails}`。名单放在自己的腾讯云账号里，换发信服务商不用迁移。
3. **每日群发**：`broadcast.yml` 每天 08:20 拉名单 → `scripts/send.mjs` 用 SMTP 逐封发送。
   **无变化也发**（正文含「今日无变化」）。
4. **管理员自通知（可选）**：`refresh.yml` 里跑 `scripts/notify.mjs`，把变化推给站长自己（飞书/微信）。

### 一次性配置

**EdgeOne 侧**
- 存储 → KV → 开通账户并创建命名空间 → 绑定到本项目，运行时变量名填 `SUBS_KV`；
- 项目 → 环境变量：`SUBSCRIBERS_TOKEN`（≥32 位随机串），可选 `ALLOWED_ORIGIN`（默认 `https://ndx.liqt91.top`）；
- 安全防护 → 给 `/api/subscribe` 加精确限频（免费版含 1 条该规则，优先给它）。

**GitHub 侧（Settings → Secrets → Actions）**

| Secret | 用途 |
|---|---|
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | SMTP 凭据（Brevo：`smtp-relay.brevo.com` 端口 `587`） |
| `MAIL_FROM` | 发件人，如 `纳指开门日报 <digest@liqt91.top>` |
| `SUBSCRIBERS_URL` | `https://ndx.liqt91.top/api/subscribers` |
| `SUBSCRIBERS_TOKEN` | 与 EdgeOne 环境变量同名同值 |
| `UNSUBSCRIBE_MAILTO`（可选） | 写入 `List-Unsubscribe` 头 |
| `NOTIFY_WEBHOOK` + `NOTIFY_CHANNEL`（可选） | 站长自通知：`feishu`（默认）/`wechat`（Server酱） |

### 免费额度与已知限制

- 免费额度：EdgeOne Edge Functions 300 万次/月 + KV 1 GB；GitHub Actions（公开仓库）免费；Brevo 300 封/天永久免费。几百人规模全部在额度内。
- **送达率才是最大变量**：Brevo 往 QQ/163 发信，**必须**在 `liqt91.top` 的 DNS 配好它给的 SPF/DKIM（TXT 记录），
  否则大概率进垃圾箱。这一步不做，前面所有体验优化都白费。
- Brevo 自带退订页在境外域名，国内可能打不开；已用 `List-Unsubscribe: mailto:` 兜底。
- 早期方案已弃用：Formspree 只收不发；Buttondown 国内打不开（`buttondown.com` 不可达 → 订阅按钮必然失败）。

## 目录结构

```
src/
  data/        数据层：types（schema）、mock（mock 生成器）、loader（数据获取抽象）、dates
  layouts/     BaseLayout
  components/  SiteHeader、Bars（30天柱状图）、FundCard（基金卡片）
  pages/       index（今日）、f/[code]（详情）、daily（历史）、my（我的基金）、subscribe（订阅）
public/       logo / favicon / hero 等静态资源
scripts/      scrape.mjs 抓取、check-freshness.mjs 发信前数据门禁、digest.mjs 日报构建、
              send.mjs 群发（SMTP）、notify.mjs 管理员自通知（deploy-cos.sh 已弃用）
edge-functions/api/  subscribe.js 收邮箱入 KV、subscribers.js 供 Actions 拉名单（Bearer 鉴权）
.github/      workflows/refresh.yml 每日抓取+回写、workflows/broadcast.yml 每日群发（触发 EdgeOne 重建）
```
