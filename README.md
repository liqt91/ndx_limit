# 纳指开门日报（静态复刻版）

一个**纯静态**的「QDII 基金每日申购额度追踪」站，涵盖**纳斯达克100**与**标普500**两个指数分站。
技术栈 **Astro（SSG）**，全程**不需要服务器、数据库或运行时**。产物是纯 HTML/CSS/JS，托管在
**EdgeOne Pages**（腾讯云免费的静态网站服务，自带全球 CDN + HTTPS + DDoS 防护）；
**每日更新**由 **GitHub Actions cron**（永久免费）每天抓取数据并回写仓库、自动触发 EdgeOne 重建实现
——构建在哪天跑，页面数据就体现哪天。

## 功能

- **今日**：代销总可投、开门/暂停统计、每只基金份额卡片 + 近 30 天开门柱状图
  - `/` 纳斯达克100（主站，域名 `ndx.liqt91.top`）
  - `/sp500/` 标普500（同一份构建产物里的第二个分站，2026-10-23 上线）
- **详情** `/f/[code]`：单只基金份额的状态变化记录、历史快照、相关公告（两个指数共用一套路由）
- **历史** `/daily`：交易日历（两个指数通用）+ 最近 15 天每日快照摘要（纳指口径）
- **我的基金** `/my`：在浏览器 localStorage 里存基金代码，纯前端过滤展示（不上传，跨两个指数）
- **订阅** `/subscribe`：本站原生表单，同域边缘函数收邮箱（见下）

> 注：只展示**人民币份额**。美元份额仍在 `funds.json` 目录与抓取范围内（历史数据继续累积），
> 只是不在站内首页渲染——过滤点在 `src/data/loader.ts` 的 `loadTodaySnapshot()`，日后想展示删掉那两行即可。

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

### 历史回填（一次性，`scripts/import-history.mjs`）

`scrape.mjs` 只能从今天起逐日累积，新站上线时 30 天柱状图只有一两根柱子。回填脚本从
`https://nasdaq.jaelchen.cn/f/{code}` 的「历史快照」表取近 30 天数据，合并进 `data/history.json`：

```bash
node scripts/import-history.mjs --dry-run    # 只打印报告，不写盘（先跑这个）
node scripts/import-history.mjs              # 全量回填（56 只份额，含 19 个美元份额）
node scripts/import-history.mjs --prefer=remote   # 同日冲突改以来源站为准
```

- **只写 A 股交易日**：来源站按自然日给数（周末/假日只是重复上个交易日），这里用 `digest.mjs`
  的 `isTradingDay` 过滤掉，与 `scrape.mjs` 口径一致。
- **同日冲突默认保留本地值**：本地是当天亲自抓的。已知口径差异——天天基金写「限大额」但补一句
  「该基金暂不开放购买」时，本站判 `STOPPED`（见 `parseTrading` 注释），来源站判 `LIMITED`。
- **单只失败不清空**：抓取失败的份额跳过，保留原历史；解析成功率低于 80% 直接拒绝写盘。
- 顺带把 `nav`（单位净值）写进 `DayPoint`（可选字段，页面暂不展示，留作以后画净值曲线）。

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

## 多指数分站（纳指100 / 标普500）

2026-10-23 从「单一纳指站」扩为**同一次构建、两个路由**的多指数站：

| 指数 | 路由 | 站名 | 份额（场外） |
|---|---|---|---|
| 纳斯达克100 | `/` | 纳指开门日报 | 60（41 人民币 + 19 美元），17 家公司 |
| 标普500 | `/sp500/` | 标普500开门日报 | 25（16 人民币 + 9 美元），7 家公司 |

两个分站共用：抓取管线、数据文件（`history.json` 按 code 平铺）、交易日历、订阅名单、
边缘函数、小程序（小程序只装纳指）。差异只有 `indexKey` 与由它派生的文案。

**加一个指数要改三处**，其余全部自动适配：

1. `data/funds.json` 加条目，`indexKey` 填新指数名（同一指数的不同币种必须共用同一个 indexKey）
2. `src/data/loader.ts` 的 `INDEXES` 加一项（key / short / brand / path / label）
3. `src/pages/` 加一个三行的页面：`<IndexBoard indexKey="..." />`

抓取会自动纳入新条目（`scrape.mjs` 遍历 `funds.json`），覆盖率门禁也按 `indexKey` 各算各的。

### ★ 口径隔离（这是本次扩张唯一容易出事的地方）

两个指数的份额躺在同一份 `history.json` 里，任何一处聚合忘了带 `indexKey`，首屏就会把两边的
额度加在一起——页面照样渲染、数字照样像真的。为此：

- `loader.ts` 的每个聚合函数都收 `indexKey`，**默认值一律是纳指**（既有页面、早报、小程序不传参时
  行为与扩容前逐字节一致）
- `digest.mjs` 的 `aggregateCny` / `computeCoverage` / `summarizeDay` / `latestDate` 同样必须传
- `scrape.mjs` 把 fetch-meta 的**顶层字段永远写成纳指**，其它指数放进 `runs[].byIndex`
- `scripts/check-index-isolation.mjs`（`npm run check:index`）是专门的门禁，29 项断言覆盖
  代码集合互斥、覆盖率 ≤100%、fetch-meta 与重算值一致、dist 渲染层不串台。
  已进 `refresh.yml`（`--no-dist`）；本地带 dist 跑能连渲染层一起验。

**踩过的坑（都写成了断言）**：`computeCoverage` 原本写 `codeCurrency.get(code) !== 'USD'`，
Map 对未收录的 code 返回 `undefined`，于是 `fund-meta` 里任何别的指数的份额都被算成
「本指数人民币抓取成功」——加标普500 后纳指覆盖率立刻报出 **161%**。现在只认 `=== 'CNY'`。

### 部署到独立域名（可选，当前没做）

现在两个分站在同一份 `dist/` 里，`ndx.liqt91.top/sp500/` 直接可用。若要把标普500 放到
`sp500.liqt91.top`：DNS 加 CNAME → EdgeOne 控制台绑定子域名，再加一条 rewrite
（`/` → `/sp500/index.html`）即可，不需要第二次构建。

## 订阅功能

访客全程只访问本域名：不跳转、不出现第三方品牌、国内无需任何代理。整条链路零服务器。

1. **收邮箱（同域边缘函数）**：`/subscribe` 是本站原生表单，`fetch POST /api/subscribe`
   → `edge-functions/api/subscribe.js`，跑在 EdgeOne 边缘节点，写入 KV。
   - 邮箱归一化为小写、SHA-256 后做 key，重复订阅幂等；
   - 蜜罐字段 + Origin 校验防刷，另建议在控制台对 `/api/subscribe` 加限频规则；
   - 只收集邮箱一个字段，页面已写明用途与退订方式。
2. **双重确认（默认开启）**：提交后不直接入名单，而是写 `pend_<sha>` 并调 Brevo 事务邮件 API
   发一封确认信，链接指到本站 `GET /api/confirm?t=<token>`。
   - 点了链接才把记录转成 `sub_<sha>`（真正入名单），确认链接 1 天有效；
   - 优势：别人无法拿你的邮箱「代填」让你收日报；打错的地址进不了名单——硬退信会毁掉新域名的发信信誉；
   - 同一邮箱 10 分钟内重复提交不重发（防被用来轰炸某人邮箱）；
   - 发信失败会回滚 `pend_`/`tok_` 并返回 502，不留「有记录、无链接」的死状态；
   - 需要退回「填了即入名单」时，把环境变量 `REQUIRE_CONFIRM` 设成 `false` 即可，不用改代码。
3. **取名单（带鉴权的只读接口）**：`GET /api/subscribers`，需 `Authorization: Bearer <SUBSCRIBERS_TOKEN>`，
   分页遍历 KV 返回 `{count, emails}`。
   **只返回已确认的 `sub_`**，`pend_`/`tok_` 一律不出现。名单放在自己的腾讯云账号里，换发信服务商不用迁移。
4. **每日群发**：`broadcast.yml` 每天 08:20 拉名单 → `scripts/send.mjs` 用 SMTP 逐封发送。
   **无变化也发**（正文含「今日无变化」）。每封底部带签名退订链接。
5. **退订**：`GET /api/unsubscribe?e=<email>&t=<sha256(email + ':' + UNSUB_SECRET)>`，
   校验通过就真删 `sub_<sha>`。签名算法只存在于 `scripts/unsub.mjs`（发送侧）与
   `edge-functions/api/unsubscribe.js`（校验侧），测试直接 import 前者去敲后者，任一端改口径立刻红。
6. **管理员自通知（可选）**：`refresh.yml` 里跑 `scripts/notify.mjs`，把变化推给站长自己（飞书/微信）。

### 一次性配置

**EdgeOne 侧**
- 存储 → KV → 开通账户并创建命名空间 → 绑定到本项目，运行时变量名填 `SUBS_KV`；
- 项目 → 环境变量：

| 变量 | 说明 |
|---|---|
| `SUBSCRIBERS_TOKEN` | ≥32 位随机串，`/api/subscribers` 的 Bearer 口令 |
| `BREVO_API_KEY` | Brevo → SMTP & API → API Keys，用于发确认信 |
| `MAIL_FROM` | 确认信发件人，如 `纳指开门日报 <digest@liqt91.top>`（域名须在 Brevo 验证过） |
| `UNSUB_SECRET` | 退订链接签名密钥，与 GitHub Secrets 同名同值 |
| `REQUIRE_CONFIRM` | 默认 `true`（双重确认）；填 `false` 退回单确认 |
| `SITE_URL` | 默认 `https://ndx.liqt91.top`，确认/退订链接的域名前缀 |
| `ALLOWED_ORIGIN` | 默认 `https://ndx.liqt91.top`，跨站提交会被 403 |

- 安全防护 → 给 `/api/subscribe` 加精确限频（免费版含 1 条该规则，优先给它）。

**GitHub 侧（Settings → Secrets → Actions）**

| Secret | 用途 |
|---|---|
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | SMTP 凭据（Brevo：`smtp-relay.brevo.com` 端口 `587`） |
| `MAIL_FROM` | 发件人，如 `纳指开门日报 <digest@liqt91.top>` |
| `SUBSCRIBERS_URL` | `https://ndx.liqt91.top/api/subscribers` |
| `SUBSCRIBERS_TOKEN` | 与 EdgeOne 环境变量同名同值 |
| `UNSUBSCRIBE_URL` | `https://ndx.liqt91.top/api/unsubscribe`；不配则日报不带退订链接（日志会警告） |
| `UNSUB_SECRET` | 与 EdgeOne 环境变量同名同值 |
| `UNSUBSCRIBE_MAILTO`（可选） | 追加 `<mailto:>` 到 `List-Unsubscribe` 头 |
| `NOTIFY_WEBHOOK` + `NOTIFY_CHANNEL`（可选） | 站长自通知：`feishu`（默认）/`wechat`（Server酱） |

### 免费额度与已知限制

- 免费额度：EdgeOne Edge Functions 300 万次/月 + KV 1 GB；GitHub Actions（公开仓库）免费；Brevo 300 封/天永久免费。几百人规模全部在额度内。
- **送达率才是最大变量**：Brevo 往 QQ/163 发信，**必须**在 `liqt91.top` 的 DNS 配好它给的 SPF/DKIM（TXT 记录），
  否则大概率进垃圾箱。这一步不做，前面所有体验优化都白费。
- Brevo 自带退订页在境外域名，国内可能打不开；日报里的退订链接指向本站 `/api/unsubscribe`，不依赖它。
- 双重确认的确认信本身也要过 QQ/163 的垃圾箱。域名没养起来前若确认信大面积进垃圾箱，订阅转化会归零——
  此时把 `REQUIRE_CONFIRM` 设为 `false` 可临时退回单确认，先拿到人、再慢慢养域名。
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
