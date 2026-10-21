# EdgeOne 免费额度接入与迁移方案

> 2026-10-21 立档。回答两个问题：**Server酱/飞书未开通，观察与通知换什么；L2 把抓取/发信
> 搬进 Cloud Functions 后免费额度够不够，扩品类（标普500、债基）后还够不够。**
> L1（定时触发器代发）已落地，代码与部署见下文；L2 待 L1 稳定后评估。

## 结论先说

1. **通知换 Brevo 事务邮件**（`BREVO_API_KEY` / `MAIL_FROM` 订阅链路已在用，零新增依赖、
   零新账号、300 封/天免费）。推送层 = dispatch 失败告警 + 每日变化摘要；拉取层 =
   EdgeOne 日志分析 + 首页 stale-hint + 日报到达本身。
2. **L2 免费额度够用，扩品类后也够**。Cloud Functions 月用量预估约 800 GB-s / 500K 上限
   （0.16%），请求 65 次 / 1M 上限。唯一需要设计的是**执行时长**：抓取从 56 只加到
   ~126 只后，顺序抓会超过 30s 默认上限——先并行化（并发 8），再不行把超时配到 120s。
   真正的长期天花板不在 EdgeOne，在 Brevo 的 300 封/日（订阅者破 300 才碰）。

## 能力对照：EdgeOne 免费版 vs 我们的链路

免费版配额（2026-10-21 查证，可能随商业化调整）：Edge Functions 3M 请求 + 3M ms CPU/月
（V8 运行时，约 200ms CPU/次，代码 5MB，可读写 KV）；Cloud Functions 1M 请求 +
500K GB-s/月（Node v20，30s 默认可配 120s，128MB 含依赖，多 region）；KV 1GB；
构建 500 次/月（20 分钟/次，4 核 6GB）；Agents 200K 次/100K GB-s（LLM 循环场景）；
Sandbox 100K GB-s（跑不可信代码）；Models 500K tokens/月。

| 链路环节 | 搬到哪 | 适配 |
|---|---|---|
| 订阅/退订/双重确认 | Edge Functions（`edge-functions/api/`，已在跑） | 已接入 |
| 定时触发（crontab 替代） | `edgeone.json` 的 `schedules`（5 段 cron，IANA 时区） | L1 已落地 |
| 抓取 scrape（15s，零依赖） | Cloud Functions（L2） | 够用，需并行化 |
| 群发 broadcast（门禁+发信） | Cloud Functions（L2） | 够用，须 Brevo HTTP API |
| 数据真源 | **留在 git**（函数提交回仓库 → push 照常触发 Pages 构建） | 不变 |
| Agents / Sandbox / Models | 无对应场景 | 不用 |

三条硬约束（查证所得，写代码前当事实用）：

- **Cloud Functions 读不了 KV**（KV 仅 Edge Functions 可用）→ 订阅名单继续留 edge fn，
  broadcast 函数 HTTP 调 `/api/subscribers` 拿。
- **Node 函数不能直连 SMTP**（有真实项目实测后改用 Go 函数桥接）→ 发信必须走 Brevo
  HTTP API；nodemailer 只留本地手动用。
- **打包器只解析入口可达的依赖**（实测裸导入直接构建失败，非入口文件不落运行时 FS）
  → 零依赖策略不动；`import '../scripts/digest.mjs' 能否打包待冒烟`。

## 通知渠道决策（2026-10-21）

**已排除**：Server酱、飞书（均未开通）。**备选未采用**：企业微信/钉钉机器人（与飞书同等
接入成本，需先有账号）、Bark / ntfy（需手机 app，出口可达性未验证）、Telegram（大陆
出口基本不通）、腾讯云短信（¥0.045/条起，需模板签名，有持续成本）。

**选定：Brevo 事务邮件 API → 站长邮箱（`ALERT_EMAIL`）**。理由：订阅链路已经在用同一套
密钥发确认信（`edge-functions/api/subscribe.js`），渠道本身已被生产验证过；对新项目
来说是零新增依赖、零新账号。两层用途：

| 层 | 触发条件 | 实现 |
|---|---|---|
| 失败告警（推送） | dispatch 这一跳非 204：PAT 过期、网络不通、配置缺失 | `edge-functions/api/jobs/dispatch.js` 内 `sendAlert()` |
| 每日摘要（推送，可选） | 抓取成功后的变化摘要，早晨一眼巡检 | `scripts/notify.mjs` 的 `email` 渠道（refresh.yml 可选步骤） |

**拉取式观察**（不依赖任何推送）：EdgeOne 控制台「日志分析」看函数日志（免费内置）；
首页「数据更新于 <月日>」+ stale-hint；以及最传统的负向信号——**日报没到就是出事**。

**边界（重要）**：告警只覆盖 dispatch 这一跳。workflow 内部失败（覆盖率门禁拒写、
发信失败）仍由 GitHub 邮件通知。L2 把抓取/发信搬进函数后，函数自己知道结果，告警才能
覆盖到业务本身——那是 L2 的附带收益，不是 L1 的。

## L2 容量测算（现在 vs 扩品类后）

假设：标普500 约 20 只场外份额 + 债基约 50 只（与现 56 只纳指 QDII 叠加 → ~126 只），
每日抓取 + 发信各一次，函数内存按 512MB 估。

| 维度 | 免费上限 | 现状（56 只） | 扩品类后（~126 只） | 占比 |
|---|---|---|---|---|
| Cloud Fn 请求 | 1M/月 | ~65/月 | ~65/月 | 0.007% |
| Cloud Fn 内存时长 | 500K GB-s/月 | ~800 GB-s/月 | ~1,600 GB-s/月 | ≤0.3% |
| Cloud Fn 执行时长 | 30s 默认 / 120s 可配 | 15s（顺序） | **顺序 ~35–40s 超默认；并行（并发 8）~6s** | 需设计 |
| Edge Fn 请求 | 3M/月 | ~1–3K/月（仅 /api/*） | ~1–3K/月 | ≤0.1% |
| Edge Fn CPU | 3M ms/月 | ~60K ms/月 | ~60K ms/月 | 2% |
| KV | 1GB | <200KB（订阅者+每日闸） | <200KB | ≈0% |
| 构建次数 | 500/月 | ~46/月（31 数据 + ~15 代码） | ~46/月 | 9% |
| 构建时长 | 20 分钟/次 | 41 页 / 11.5s | ~120 页 / 估 30–60s | 充裕 |

换算参考：Edge Fn CPU 按 20ms/次估，上限约 150K 次 API 调用/月；history.json 随基金数
线性增长（现 140KB，126 只约 315KB），git 与构建均无压力；扩品类不增加构建次数
（仍是每日一次数据 commit）。

**真正的长期天花板在第三方，不在 EdgeOne**：Brevo 免费 300 封/日（每订阅人每日 1 封，
订阅者破 300 才碰顶）；GitHub API 5,000 req/h（L2 若用 Contents API 提交，每次 run 仅
2–3 个请求）；天天基金上游（抓取要礼貌：并发上限 + 抖动，现有重试退避保留）。

## L1：定时触发器代发（2026-10-21 已落地，未 push）

**架构**：`edgeone.json` schedules（北京时间 **07:50 / 09:40 / 14:30** 三抓 +
**14:45** 下午报，共四跳，`Asia/Shanghai`）→ POST `/api/jobs/dispatch`（Edge Function）→
GitHub `workflow_dispatch`。workflow 逻辑近零改动（broadcast.yml 多声明一个 `edition` input），
整条数据链路不再依赖自有服务器。★ **轻量云 crontab 目前仍在运行**（EdgeOne 未部署、备案未下），
必须等四跳验证通过后按《定时触发.md》的顺序删除。下午报发收盘前最终额度，详见
《双时点抓取与下午报接入.md》。

★ 2026-10-21 下午修订：**08:10 早报下线，换 09:40 早盘抓取**。理由与代价：
- 加 09:40 是因为 07:50 偏早、单向少报——当日额度调整公告多在 07:51 之后发布，
  早间那一抓会漏（实测 56 份额漏 2 个，而全天平均只变 1.3 个）。盘中额度几乎不动，
  所以这一抓的价值在**覆盖早盘公告窗口**，不是追波动。
- 去掉 08:10 的早报意味着**订阅者每天只收一封（14:45 下午报）**。早间抓取仍在（07:50），
  站点数据照样早上就更新；只是不再单独发一封早间邮件。
- 现在四个槽位是 3 个 refresh（`preopen` / `intraday` / `close`）+ 1 个 broadcast（`close`）。
  **refresh 的 slot 从两个变三个**，闸键必须跟着分三档，否则 09:40 与 14:30 会被
  409 静默挡掉（同第五节第 2 项那类病）。
- 注意两套 slot 不要混：`scrape.mjs` 的 slot 仍是 `morning`/`close` 两档（按时刻自动判），
  dispatch 的 refresh slot 是三档——**前者管 fetch-meta 的记录，后者只管分闸**，
  09:40 那次在 fetch-meta 里仍记作 `morning`，会覆盖 07:50 那条记录（同日幂等覆盖的设计如此），
  于是下午报的「较今晨」基准从 07:50 变成 09:40 的值（更新，不是错）。

**可观测（2026-10-21 补）**：dispatch 每次终态（204 / GitHub 错 / 网络错 / 401 / 409）都写
KV 事件流水 `job_events`（≤50 条，最新在前，事件带 `slot`），GET `/api/jobs/status` 只读暴露
「今日四跳（job × 晨/午）触发没有 + 事件流 + 告警发没发 + 关键环境变量配没配（布尔）」。
轻量云运维面板聚合这个端点，crontab 退役后服务器本地无日志可看的缺口由此补上
（详见《管理面板.md》）。

文件：

| 文件 | 职责 |
|---|---|
| `edgeone.json` | 四条 schedule（三抓一报）+ Cloud Functions region（ap-guangzhou，为 L2 预备） |
| `edge-functions/api/jobs/dispatch.js` | 代发 + 两层鉴权 + 未鉴权组合白名单 + 每时点闸 + 拒绝计数 + 失败告警邮件 + 事件流水 |
| `edge-functions/api/jobs/status.js` | 只读状态端点（无鉴权，无 secret），面板数据源；暴露今日被拒次数 |
| `scripts/jobs-dispatch-smoke.mjs` | 冒烟测试 125 断言（`npm run jobs:smoke`），零外网 |
| `scripts/notify.mjs` | 新增 `email` 渠道（Brevo API），默认渠道；飞书/Server酱留作兼容 |

**安全模型**（为什么这么设计）：

- schedules 不能带 Authorization 头，且 `edgeone.json` 在公开仓库里放不下真 secret →
  payload 里的 `nonce` 只是**防扫描的隐匿层，不是鉴权**；
- 对未鉴权（nonce）调用的约束有三层：
  1. **组合白名单**（403 `slot_not_scheduled`）：只接受调度表里真实存在的 job×slot
     （refresh 的 `preopen`/`intraday`/`close` + broadcast 的 `close`）。闸键只挡「同一动作
     重复」，挡不住「多出一个动作」——早报 schedule 下线后 `broadcast/morning` 的闸键还在，
     不白名单的话匿名者能凭空给全体订阅者多发一封早报；
  2. **每时点闸**（409）：key = `job_sent_<job>_<slot>_<CST日期>`，复用 SUBS_KV，前缀 `job_`
     与 `sub_` 不冲突；只在 GitHub 真的受理（204）后才落 key，失败重试不被卡。
     **键里必须带 slot**——三抓一报，不带 slot 时 09:40 与 14:30 会被静默挡掉
     （2026-10-21 踩过两次，冒烟有专项断言）；
  3. **拒绝计数**（`job_rejected_<CST日期>`）：401/403/409/400 只累加次数，**不写事件流水**。
     流水只有 50 条，几十次无效请求就能灌满、把「今天四跳触没触发」的视野冲掉——
     被刷的真实伤害是被刷到看不见真实状态；
- **CRON_SECRET 鉴权**（body 或 Bearer 头，只存 EdgeOne 控制台环境变量）不受闸与白名单限制——
  面板、curl、当天重跑、手动发早报都用它。KV 未绑定时未鉴权调用 **fail closed**（500），
  鉴权调用放行；
- KV 最终一致性最长 60s，60s 内的连发理论上能漏一两次；拒绝计数同理会少记（读-改-写竞态），
  计数是下限不是精确值。两者都可接受（记录在案）。

### 能不能防住被刷（2026-10-21 结论）

**不能彻底防住，只要 payload 必须写在公开仓库里。** 结论与依据：

- `edgeone.json` 在公开仓库 → nonce、job、slot、cron 时刻全部公开，nonce 不具秘密性。
  任何人照抄一次 POST 就能触发，这不是配置问题，是「secret 放在公开文件里」的结构问题。
- 但**最坏后果很小**，因为下游还有一道门禁：broadcast 之前跑 `check-freshness`，数据不是
  今天的数据直接 `exit 2`、一封不发。所以被抢跑的结果只能是「当天那封日报提前几小时发出」，
  不会发错数据、不会发第二封（闸 + 白名单各挡一层）。
- 已被堵掉的三条：凭空多发一封信（403 白名单）、同一动作重复触发（409 闸）、
  监控被噪声灌满（拒绝计数不进流水）。
- **不建议加时间窗校验**：调度平台自身有抖动（GitHub 自带 schedule 实测延迟 2h44m 才被弃用），
  硬窗口一旦误杀就是「数据整天没更新」——误杀的代价远大于被刷的代价。
- 要根治只有一条路：**把 payload（含 nonce）移出公开仓库**，改在 EdgeOne 控制台可视化配置
  schedule。这样 nonce 才升级成真凭证。是否可行取决于控制台能力，列在下面待验证清单第 1 条；
  若可行，届时应把 nonce 换成更强的随机串并只在控制台保留。

**部署步骤**（控制台 + git push，约 10 分钟）：

1. EdgeOne 控制台 → 项目 → 环境变量，新增：
   - `GH_DISPATCH_TOKEN`：细粒度 PAT（Actions: write），**与服务器 `/root/.gh_dispatch_token` 同值**
   - `GH_REPO`：`liqt91/ndx_limit`（默认值即此，可省）
   - `DISPATCH_NONCE`：与仓库 `edgeone.json` 里 `payload.nonce` 一致（已生成，见文件）
   - `CRON_SECRET`：自定随机长字符串（面板/curl 用；**不进仓库**）
   - `ALERT_EMAIL`：站长邮箱（告警收件人）
   - `BREVO_API_KEY` / `MAIL_FROM`：已存在（订阅链路在用），确认即可
2. `git push` → EdgeOne 自动重建，`edge-functions/` 与 `edgeone.json` 一起部署。
3. 验证路由可达（嵌套路径映射需实测，两个嵌套路由都要验）：
   `curl -i -X POST https://ndx.liqt91.top/api/jobs/dispatch -d '{}'` → 期望 400（证明路由通、
   函数在；401/404 都说明映射有问题，看日志分析）；
   `curl -s https://ndx.liqt91.top/api/jobs/status` → 期望 200 JSON（含 `cstToday`、`jobs`、
   `rejected`、`events`；KV 没绑定时是 500 `kv_not_configured`，那也是「函数在」的证据）。
4. 观察首个 07:50 schedule 触发：日志分析里应有 `[dispatch] refresh/preopen → refresh.yml HTTP 204`；
   KV 里出现 `job_sent_refresh_preopen_<日期>`；09:40 / 14:30 两条同理多出 `_intraday` / `_close`
   键，14:45 多出 `job_sent_broadcast_close_<日期>`。**四个键都出现才算调度表整体生效**。
5. **删除服务器 crontab 两行**（保留 `gh-dispatch.sh`：运维面板与手动兜底还在用）。
   注意必须删——crontab 与 schedule 双跑会让 broadcast 给订阅者发两遍。
6. PAT 续期时**同步两处**：服务器文件 + EdgeOne 控制台环境变量。

**回滚**（一分钟）：把 crontab 两行加回去即可，workflow 侧无需任何改动； EdgeOne 侧的
schedule 从 `edgeone.json` 删掉再 push 一次。

**已验证**：`npm run jobs:smoke` 125 断言零外网全绿（2026-10-21 下午改三抓一报后重跑）；
负向验证 14 个方向，其中本期新增 5 个方向（拆「未鉴权只许调度表内组合」白名单、把 401 改回写
事件流水、闸键去掉 slot、status 少报一个时点、调度表把 09:40 的 slot 写成旧值 morning）
全部精准红在对应断言上，还原后工作区与注入前逐字节一致。面板侧另加一条静态守卫：
「内联脚本不得引用服务端常量」（注入 `SLOT_LABEL[sl.slot]` 回客户端 → 断言红）。

**待验证（部署后才能闭环）**：

1. git push 后 `schedules` 是否自动注册**四条**（09:40 那条是新增、08:10 那条已删）；
   若没有，用 `npx edgeone makers deploy` 补一次，或看控制台是否支持可视化配置
   （可视化配置还能把 payload 整体移出公开仓库，那才是防刷的根本解）；
2. `edge-functions/api/jobs/` 下两个嵌套路径是否分别映射为 `/api/jobs/dispatch` 与
   `/api/jobs/status`（上面第 3 步的两条 curl 就是判据）；
3. ap-guangzhou 出口到 `api.github.com` / `api.brevo.com` 的可达性——首次触发即验证，
   不通时告警邮件里会带「查出口」的提示；
4. KV 60s 一致性对每时点闸、拒绝计数与事件流水的影响（已知可接受，记录在案）。
5. **08:10 那条 schedule 是否真的从平台侧消失**：从 `edgeone.json` 删掉只是不再声明，
   若平台保留了旧的调度记录，仍会每天 08:10 调一次 dispatch，然后被 403 白名单挡住
   （不会再发信，但会污染拒绝计数）。判据：14:45 首跑后看 `job_rejected_*` 里有没有 08:10 的
   `slot_not_scheduled`；有就去控制台删掉那条遗留 schedule。

## L2：抓取与发信进 Cloud Functions（待 L1 稳定后）

前置改造（与 L1 独立，可先做）：**scrape 并行化**——现为顺序抓（56 只 / 15s ≈ 270ms/只），
改并发 8 + 抖动后约 6s，同时给 Actions 现状提速；这是 Cloud Fn 30s 时长约束的对策。

主体：定时器 → Cloud Function 跑 scrape（零依赖 + `digest.mjs`）→ 覆盖率门禁不过不提交 →
GitHub Contents API 提交回仓库 → push 照常触发 Pages 构建；broadcast 同理（raw 读数据 +
check-freshness 门禁 + HTTP 调 `/api/subscribers` 拿名单 + Brevo HTTP API 发信）。
之后 GitHub Actions 退化为 PR 专用 CI，轻量云只剩运维面板——续费前（2027-10-15）再评估
面板去留（改 token 保护的云函数，或砍掉用日志分析 + 告警邮件代替）。

搬前冒烟 4 项：① schedule 能否直达 cloud-functions 路径（不能就 edge 中转）；② ap-guangzhou
出口到 GitHub / 天天基金 / Brevo；③ cloud fn 相对导入 `../scripts` 的打包；④ edge/cloud
同前缀 `/api/*` 的路由优先级（新端点走 `/api/jobs/*` 独立路径绕开）。
