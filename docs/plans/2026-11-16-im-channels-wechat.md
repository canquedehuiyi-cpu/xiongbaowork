# 微信 ClawBot 通道 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 每个人在熊宝里扫码绑定自己的微信（官方 ClawBot 插件），在微信私聊里给员工派活、收回复，用回复数字拍板审批，用文字命令处理交付闭环的逾期、交付和清点。

**Architecture:** 服务器直接实现微信 iLink Bot HTTP 协议（不装 OpenClaw）：每个绑定的人一条长轮询（数据库租约保证多副本只有一个在拉），入站消息经 `delivery_inbox` 去重后，按「@员工名 / 上次的员工」落到这个人和该员工的默认单聊，用现有 `deliveryRouter.converse` 开一轮；出站是新 transport `wechat`，走现有发件箱。微信没有按钮，所以拍板和交付闭环的处理都用文字命令。主动推送有时间窗，超时就跳过微信、改走其他出口。

**Tech Stack:** Bun、TypeScript、Hono、Drizzle + PostgreSQL（RLS）、现有 delivery 模块；前端 React + TanStack Query。

**Spec:** `docs/specs/2026-11-16-im-channels.md`（「微信机器人（ClawBot，第一个接）」一节及通用部分）。协议原文：`github.com/Tencent/openclaw-weixin` 的 `docs/protocol_zh_CN.md`。

**范围：** 只做规格分期表里的「1 微信服务器」和「2 微信界面」。飞书、企业微信、钉钉另写计划。

## Global Constraints

- 路径默认相对 `openbot/`（目录改名 PR 合入后改为 `xiongbao/`，开工前看 main 用哪个）。
- 中文文案；员工名用员工的显示名，动作说法用 `wantsTo(botName, action)`（`server/src/approvals/types.ts:1070`），不出现内部名字和上游品牌。
- 每条员工消息前缀 `【员工名】`；联系人名「微信 ClawBot」改不了，不做任何「假装是熊宝」的处理。
- iLink 基础地址 `https://ilinkai.weixin.qq.com`（以绑定时返回的 `baseurl` 为准）；固定主机用 `fetch` 加可注入的 `ProviderFetch`（同 `delivery/twilio.ts:56`），不经 `guardedFetch`。
- 请求头照协议：`Content-Type: application/json`、`AuthorizationType: ilink_bot_token`、`Authorization: Bearer <bot_token>`、`X-WECHAT-UIN`（随机 uint32 十进制再 base64）、`iLink-App-Id: bot`、`iLink-App-ClientVersion`（取值由 Task 1 实测确定，写成常量）。二维码轮询只带应用头。
- 长轮询：`getupdates` 超时按响应的 `longpolling_timeout_ms`，缺省 35000；游标 `get_updates_buf` 只在非空时保存。
- `ret`/`errcode` 为 `-14`：该账号暂停 1 小时。
- 主动推送时间窗：最后一次入站超过 **10 小时**就不往微信发主动内容；发送返回失败（如 `ret=-2`）当作时间窗已关，不重试。
- `bot_token`、`context_token` 不进日志、错误信息、接口响应；`bot_token` 用 `sealCredential`（AAD 绑行）存，`context_token` 只存数据库列、不出接口。
- 多租户：账号行、提示行、入站收件箱都带这个人的 `tenant_id`；轮询器在 `platform` 帧认领，处理每条消息用 `runAsTenant(account.tenantId, …)`；出站在本人帧，发前 `authoriseScope`。
- 迁移放 `server/recovery/recovery-20261018-v1/sql/`，从 `0223` 起，同时登记 `meta/_journal.json`；新表照 `0220_task_briefings.sql` 的 RLS 四条策略和授权。
- 新测试文件登记：仓库根执行 `bun scripts/ci/server-shards.mjs --write`。
- 发送结果只记「已发出」（`sent`），不写成「已送达」。

## Review Focus

1. **同一个微信号被两个人绑定**：第二个人扫码确认后，熊宝拒绝绑定并说明「这个微信已绑在别的账号上」，第一个人的绑定不受影响（Task 4 测试）。
2. **同一条消息被重复投递**（游标回退、重启后重拉）：员工只开一轮（Task 5 测试）。
3. **没有待处理请求时回了「1」**：当普通消息交给员工，不报错、不吞掉（Task 7 测试）。
4. **底线类请求回「3」**：答「这条只能批准一次或拒绝」，不放行（Task 7 测试）。
5. **用户在微信里删了 ClawBot / 绑定失效**（接口返回鉴权失败）：账号标记失效、停止轮询，网页「我 › 通知」显示「微信已断开，请重新绑定」（Task 5 测试、Task 10 截图）。

---

### Task 1: 真实微信实测（探针脚本 + 给用户的步骤）

**Files:**
- Create: `scripts/wechat-probe.ts`
- Create: `docs/acceptance/wechat-probe.md`（步骤 + 结果记录表）
- Test: 无（这是对外部服务的实测；脚本本身的纯函数在 Task 2 测）

**Interfaces:**
- Produces: 实测结论，写进 `docs/acceptance/wechat-probe.md` 和规格「已知限制」：`iLink-App-ClientVersion` 的取值、主动推送时间窗的实测时长、`ret=-2` 是否就是时间窗已关、消息 ID 字段名、`ilink_user_id` 是否稳定、同一个微信号重复扫码的返回状态。

- [ ] **Step 1: 写探针脚本 `scripts/wechat-probe.ts`**，子命令：
  - `bind`：调 `get_bot_qrcode?bot_type=3`，在终端打印二维码图片地址（`qrcode_img_content`）并轮询 `get_qrcode_status`，确认后把 `bot_token`、`ilink_bot_id`、`ilink_user_id`、`baseurl` 写进本机 `~/.wechat-probe.json`（权限 600，不打印 token）。
  - `listen`：循环 `getupdates`，每条入站打印时间、发送者、消息 ID、文本、是否带 `context_token`，并原样回一句「收到：<文本>」。
  - `push --after <分钟>`：等指定分钟后不等入站直接 `sendmessage`，打印 `ret`/`errcode`。
  - 全程只用协议里的接口和请求头，不依赖 OpenClaw。
- [ ] **Step 2: 写 `docs/acceptance/wechat-probe.md`**：前提（微信 8.0.70+、「我 › 设置 › 插件」里能看到 ClawBot、建议用小号）、在哪台机器跑（有 Bun 的电脑或京东云服务器）、逐条命令、每步该看到什么、结果记录表（时间窗：发消息后 1h / 6h / 11h / 15h / 24h 主动推是否成功）。
- [ ] **Step 3: 本地自检**：`bun scripts/wechat-probe.ts --help` 输出子命令说明；`bunx biome check scripts/wechat-probe.ts` 通过。
- [ ] **Step 4: 提交**，并把 `docs/acceptance/wechat-probe.md` 发给用户执行。**等用户回结果后再开始 Task 5～8**（Task 2～4 不依赖实测，可以先做）。结果如与规格不符，先改规格再继续。

```bash
git add scripts/wechat-probe.ts docs/acceptance/wechat-probe.md
git commit -m "chore(wechat): ClawBot 实测探针与操作步骤"
```

### Task 2: iLink 协议客户端

**Files:**
- Create: `server/src/delivery/wechat/ilink.ts`
- Test: `server/tests/wechat-ilink.test.ts`

**Interfaces:**
- Produces:
  - `type IlinkSession = { baseUrl: string; botToken: string }`
  - `createIlinkClient(options: { fetch?: ProviderFetch; clientVersion: string }): IlinkClient`
  - `IlinkClient.getBotQrcode(): Promise<{ qrcode: string; imageContent: string }>`
  - `IlinkClient.getQrcodeStatus(qrcode: string): Promise<{ status: "wait" | "scaned" | "confirmed" | "expired" | "need_verifycode" | "verify_code_blocked" | "scaned_but_redirect" | "binded_redirect"; session?: IlinkSession & { botId: string; userId: string } }>`
  - `IlinkClient.getUpdates(session: IlinkSession, cursor: string): Promise<{ messages: IlinkMessage[]; cursor: string | null; timeoutMs: number }>`（`cursor` 为响应里非空的新游标，否则 null）
  - `IlinkClient.sendText(session: IlinkSession, input: { toUserId: string; contextToken: string; text: string }): Promise<void>`
  - `type IlinkMessage = { id: string; fromUserId: string; text: string | null; contextToken: string | null; groupId: string | null }`
  - 错误：`class IlinkPausedError`（-14）、`class IlinkWindowClosedError`（发送失败的非零 `ret`，名字以 Task 1 结论为准）、`class IlinkUnauthorizedError`（鉴权失败），都继承 `DeliveryProviderError`（provider `"wechat"`）。

- [ ] **Step 1: 写失败测试**（用假 `fetch` 记录请求）：
  - `getUpdates` 带 `Authorization: Bearer t1`、`AuthorizationType: ilink_bot_token`、`iLink-App-Id: bot`，`X-WECHAT-UIN` 是 base64；请求体 `get_updates_buf` 等于传入游标；响应游标为空字符串时返回 `cursor: null`。
  - `getQrcodeStatus` 不带 `Authorization`。
  - `ret: -14` 抛 `IlinkPausedError`；发送返回非零 `ret` 抛 `IlinkWindowClosedError`；HTTP 401 抛 `IlinkUnauthorizedError`。
  - 抛出的错误信息里不含 `t1`（token）。
  - 非文本消息（`item_list` 无 type 1）解析为 `text: null`。
- [ ] **Step 2: 运行确认失败** `cd server && bun test tests/wechat-ilink.test.ts` → 模块不存在。
- [ ] **Step 3: 实现 `server/src/delivery/wechat/ilink.ts`**（字段名照协议文档；`iLink-App-ClientVersion` 来自 `options.clientVersion`）。
- [ ] **Step 4: 运行通过**；登记测试清单；提交。

```bash
git add server/src/delivery/wechat/ilink.ts server/tests/wechat-ilink.test.ts scripts/ci/server-tests.list.txt
git commit -m "feat(wechat): iLink 协议客户端"
```

### Task 3: 数据表与迁移

**Files:**
- Create: `server/recovery/recovery-20261018-v1/sql/0223_credential_kind_chat.sql`（`ALTER TYPE "public"."credential_kind" ADD VALUE IF NOT EXISTS 'chat';`，单独一个迁移）
- Create: `server/recovery/recovery-20261018-v1/sql/0224_wechat_accounts.sql`
- Modify: `server/recovery/recovery-20261018-v1/meta/_journal.json`（idx 223、224，`when` 依次 +1）
- Modify: `server/src/db/schema/core.ts:41`（`credentialKind` 加 `chat`）
- Create: `server/src/db/schema/wechat.ts`；Modify: `server/src/db/schema/index.ts`、`server/drizzle.config.ts`
- Test: `server/tests/wechat-store.integration.test.ts`

**Interfaces:**
- Produces（表，全部带 `tenant_id` 与 RLS 四条策略）：
  - `wechat_accounts`：`id`、`tenant_id`、`user_id`（唯一，一人一个）、`ilink_bot_id`、`ilink_user_id`（**全部署唯一**，部分唯一索引 `where status <> 'unbound'`）、`base_url`、`credential_id`（指向 `credentials`，kind `chat`、provider `wechat`）、`cursor`、`context_token`、`last_inbound_at`、`last_agent_id`、`status`（`bound` | `paused` | `unbound`）、`paused_until`、`lease_owner`、`lease_until`、`missed_count`（时间窗关闭时没发出去的条数）、`created_at`、`updated_at`。
  - `wechat_bind_attempts`：`id`、`tenant_id`、`user_id`、`qrcode`、`image_content`、`status`、`expires_at`（10 分钟）、`created_at`。
  - `wechat_prompts`：`id`、`tenant_id`、`user_id`、`code`（如 `A1`，每人自增，按天不重置）、`kind`（`approval` | `extension` | `handin` | `overdue` | `pick_agent`）、`ref_id`、`state`（`open` | `done`）、`created_at`；唯一 (`user_id`, `code`)。
  - `server/src/delivery/wechat/store.ts`：`createWechatStore(database): WechatStore`，方法 `account(userId)`、`accountByIlinkUser(ilinkUserId)`（平台帧）、`saveAccount(...)`、`markInbound(accountId, { at, contextToken })`、`setCursor`、`pause(accountId, until)`、`unbind(userId)`、`claimForPolling(owner, leaseMs, limit)`、`renewLease`、`openPrompt(userId, kind, refId): Promise<{ code }>`、`openPrompts(userId)`、`closePrompt(userId, code)`。

- [ ] **Step 1: 写失败测试**（真库）：A 的行在 B 的帧里读不到；`ilink_user_id` 相同的第二个 `bound` 行插入失败；`openPrompt` 对同一人连续两次给 `A1`、`A2`；`claimForPolling` 两个 owner 同时认领只有一个拿到同一账号，租约过期后另一个能拿到。
- [ ] **Step 2: 运行确认失败**（临时库：owner 建库、`bun scripts/migrate.ts`，用完删库）。
- [ ] **Step 3: 写两个迁移、Drizzle 表、`store.ts`**。
- [ ] **Step 4: 运行通过**；`bun test tests/rls-write-scope.test.ts` 也通过；登记测试清单；提交。

### Task 4: 扫码绑定与解绑接口

**Files:**
- Create: `server/src/delivery/wechat/bind.ts`
- Modify: `server/src/delivery/routes.ts`（挂三个接口）、`server/src/index.ts`（注入 `ilink`、`wechatStore`、`credentialStore`）
- Test: `server/tests/wechat-bind.integration.test.ts`

**Interfaces:**
- Consumes: Task 2 `IlinkClient`，Task 3 `WechatStore`。
- Produces（都在 `/api/delivery` 下，需登录，只能操作本人）：
  - `POST /wechat/start` → `{ attemptId, imageContent, expiresInMinutes: 10 }`
  - `GET /wechat/attempts/:id` → `{ status: "wait" | "scaned" | "bound" | "expired" | "taken" | "failed", message?: string }`（服务器在请求里调一次 `getQrcodeStatus`；`confirmed` 时在平台帧查 `ilink_user_id` 是否已被别人绑，是则 `taken`、不保存；否则 `sealCredential` 存 token、写账号行、`status: "bound"`）
  - `DELETE /wechat` → 解绑：账号 `unbound`、凭据作废、清 `context_token`。
  - `GET /` 的 `available` 增加 `wechat: true`，响应增加 `wechat: { status, boundAt, paused, windowOpen } | null`（不含任何 token 和 ilink id）。

- [ ] **Step 1: 写失败测试**（假 `IlinkClient`）：绑定成功后 `GET /` 显示 `bound`，响应 JSON 里搜不到 token 原文；Review Focus 1（第二个人绑同一 `ilink_user_id` 得 `taken`，第一个人仍 `bound`）；别人的 `attemptId` 404；`expired` 透传；解绑后状态为 null。
- [ ] **Step 2: 运行确认失败。**
- [ ] **Step 3: 实现。**
- [ ] **Step 4: 运行通过；server tsc；登记；提交。**

### Task 5: 长轮询器

**Files:**
- Create: `server/src/delivery/wechat/poller.ts`
- Modify: `server/src/index.ts`（`startup.acquireSync(() => repeatAfterEach(...))`，每 2 秒认领一批；同 `index.ts:4425` 的 delivery sweep 写法）
- Test: `server/tests/wechat-poller.integration.test.ts`

**Interfaces:**
- Consumes: Task 2、Task 3；`deliveryStore.recordInbox`（`source: "wechat"`、`realm: ilink_bot_id`、`externalId: message.id`）。
- Produces: `createWechatPoller(deps: { database; wechat: WechatStore; ilink: IlinkClient; credentials; keyEncryptionKey; inbound: (account, message) => Promise<void>; owner: string; now?: () => Date }): { tick(): Promise<void> }`。`inbound` 由 Task 6 提供。

- [ ] **Step 1: 写失败测试**（假 `IlinkClient` 按脚本返回）：
  - 收到 2 条消息 → `inbound` 调 2 次，`last_inbound_at`、`context_token` 更新，游标保存；
  - Review Focus 2：同一消息 ID 再次返回 → `inbound` 不再调用；
  - 返回空游标 → 不覆盖已存游标；
  - `IlinkPausedError` → 账号 `paused`、`paused_until = now + 1h`，期间 `tick` 不拉它；
  - Review Focus 5：`IlinkUnauthorizedError` → 账号 `unbound`，不再拉；
  - 两个轮询器同时 `tick` → 同一账号只被拉一次（租约）。
- [ ] **Step 2: 运行确认失败。**
- [ ] **Step 3: 实现**（每个账号一次 `getUpdates` 后立即释放租约给下一轮；处理每条消息在 `runAsTenant(account.tenantId, …)` 里）。
- [ ] **Step 4: 运行通过；登记；提交。**

### Task 6: 入站分流：选员工、开一轮、回复

**Files:**
- Create: `server/src/delivery/wechat/inbound.ts`
- Modify: `server/src/delivery/types.ts:8-9`（`BindingTransport` 加 `"wechat"`）、`server/src/delivery/router.ts`（`converse` 接受 `"wechat"`；`receive` 不变）、`server/src/agents/lifecycle.ts:38-50`（`UpdateTransport`、`UPDATE_TRANSPORTS` 加 `wechat`）、`server/src/db/schema/lifecycle.ts:62`（类型）
- Test: `server/tests/wechat-inbound.integration.test.ts`

**Interfaces:**
- Consumes: Task 3 store；`channelStore.direct(actorFor(userId), agentId)`（`channels/routes.ts:232`）；`deliveryScopeFor`；`deliveryStore.bind`；`deliveryRouter.converse`。
- Produces: `createWechatInbound(deps): (account: WechatAccount, message: IlinkMessage) => Promise<void>`，规则：
  1. `text === null` → 回「目前只认文字，图片和文件请在熊宝里发」。
  2. 文本是待处理提示的回复（Task 7 的 `matchPromptReply`）→ 交给 Task 7，结束。
  3. 以 `@名字` 开头 → 在这个人能看到的员工里按显示名匹配；唯一命中即选中，去掉前缀；多个命中 → 开 `pick_agent` 提示，列编号候选；零命中 → 回「没找到叫 X 的员工」。
  4. 否则用 `last_agent_id`；没有 → 开 `pick_agent` 提示，列最近 5 位员工「回复数字选员工」。
  5. 选中员工后：取默认单聊 → `scopeFor` → 确保有一条 `delivery_bindings`（`transport: "wechat"`、`realm: ilink_bot_id`、`identity: ${ilink_user_id}#${agentId}`、`address: ilink_user_id`）→ `converse` 开一轮 → 回复文本加前缀 `【员工名】` 发回；记 `last_agent_id`。

- [ ] **Step 1: 写失败测试**（假发送器收集文本、假 `runTurn`）：`@代码熊 看下报错` → 代码熊那段单聊开了一轮、回复以「【代码熊】」开头、熊宝对话里有这条用户消息；不带 @ 用上次的员工；首次无员工时回编号名单；两个同名员工出选人；图片消息回提示；两个不同的人各自的消息只进各自的单聊。
- [ ] **Step 2: 运行确认失败。**
- [ ] **Step 3: 实现**（新 transport 名在 `router.ts:236`、`opentag` 映射等处按需补齐，只加不改原有分支）。
- [ ] **Step 4: 运行通过；`delivery-router.test.ts`、`delivery-attention.integration.test.ts` 也通过；server tsc；登记；提交。**

### Task 7: 文字拍板与交付闭环命令

**Files:**
- Create: `server/src/delivery/wechat/prompts.ts`
- Create: `server/src/tasks/return-task.ts`（把 `server/src/tasks/routes.ts:678-780` 的「认领 → 说原因 → 退回 / 撤回」抽成服务；路由改为调用它，行为不变）
- Test: `server/tests/wechat-prompts.integration.test.ts`、`server/tests/delivery-routes.integration.test.ts`（原有退回用例保持全绿，作为抽取的回归）

**Interfaces:**
- Consumes: `approvalService.decide(owner, id, decision)`、`offersStandingRule(action)`、ACP 的 `acpCardOf(action).offerConversation`；`Delivery.review`、`Delivery.decideExtension`、`Delivery.cancelTask`、`NudgeRuns.nudgeNow`、`NudgeRuns.reassignTask`；Task 3 `openPrompt`/`openPrompts`/`closePrompt`。
- Produces:
  - `returnTaskWithReason(deps, tenantId, taskId, { actor, reason }): Promise<{ ok: true; returns: number; runId: string | null } | { ok: false; why: "pending" | "not_returnable" | "refused" | "unavailable"; message?: string }>`（`server/src/tasks/return-task.ts`）
  - `matchPromptReply(text: string, open: WechatPrompt[]): { prompt: WechatPrompt; answer: string } | null`：
    - 只有一条待处理时，`1`/`2`/`3`/`验收`/`退回 原因`/`再催`/`延期 时间`/`换人`/`取消` 直接对它生效；
    - 多条时必须带编号：`A2 1`、`A2 验收`；只回数字则答「有几条待处理，请带编号回复，例如 A2 1」并列出；
    - 没有待处理时返回 null（Review Focus 3：交给员工当普通消息）。
  - `approvalText(prompt, record, botName)`：`【代码熊】想要 删除 ~/build 目录（在「修复构建」里）。回复 1 批准一次，2 拒绝，3 这次对话里都允许；详情：<链接>`；底线类不出现「3」；多条待处理时每条带编号。
  - 决定后：`1` → `allow_once`，`2` → `deny`，`3` → `allow_conversation`（底线类回「这条只能批准一次或拒绝」，Review Focus 4）；已被别处处理 → 「这条已由 某某 在 网页 处理」。

- [ ] **Step 1: 写失败测试**：单条待处理回「1」批准；两条回「A2 2」只拒第二条；只回「1」而有两条 → 提示带编号；无待处理回「1」→ 原样交给员工；底线类回「3」→ 拒绝并说明；网页先拒绝后再回「1」→ 答已处理；交付卡回「退回 缺 C 家发票」→ 卡片回到进行中、流水有「退回」；逾期卡回「延期 明早10点」→ 预计时间改变；「再催」「换人」「取消」各一例。
- [ ] **Step 2: 运行确认失败。**
- [ ] **Step 3: 先抽 `return-task.ts`，跑 `delivery-routes.integration.test.ts` 全绿；再实现 `prompts.ts`。**
- [ ] **Step 4: 运行通过；登记；提交。**

### Task 8: 出站：发件箱 transport、时间窗兜底

**Files:**
- Create: `server/src/delivery/wechat/transport.ts`
- Modify: `server/src/delivery/routes.ts:393`（`configuredDeliveryProviders` 加 `wechat`）、`server/src/index.ts:4007-4035`（传入 provider）、`server/src/delivery/router.ts`（`notify`/`notifyPerson` 跳过时间窗已关的微信绑定）
- Test: `server/tests/wechat-transport.integration.test.ts`

**Interfaces:**
- Consumes: Task 2、Task 3、Task 7（审批文本、交付闭环提示文本）。
- Produces: `createWechatTransport(deps): TextTransport`：按 `address`（`ilink_user_id`）找账号，取 `context_token`，`sendText`；`IlinkWindowClosedError` → 抛 `DeliveryProviderError("wechat", "window_closed")`（状态 `failed`）并把账号 `missed_count + 1`；成功只记 `sent`。

- [ ] **Step 1: 写失败测试**：
  - 时间窗开着（`last_inbound_at` 在 10 小时内）：员工请求许可 → 微信收到带编号的请求文字；逾期 → 微信收到「回复 再催 / 延期 … / 换人 / 取消」；同时手机推送照常；
  - 时间窗关了（11 小时前）：逾期提醒不往微信发，手机推送照发，`missed_count + 1`；下次入站时先补一句「有 1 条提醒在熊宝里：<链接>」并清零；
  - 发送返回失败 → 发件箱 `failed`，不重试；
  - 开工清点时间窗开着 → 末尾带「回复任意内容，今天的提醒就能继续发到这里」；
  - 主动提醒仍受作息和「同一件活每天 3 次」限制（沿用现有 `createTaskNotices`）；审批作息外照常推；
  - 网页里发起的普通回复不推到微信（`notify` 的 `reply` 只发给入站来源为微信的那一轮）。
- [ ] **Step 2: 运行确认失败。**
- [ ] **Step 3: 实现。**
- [ ] **Step 4: 运行通过；全部 `delivery-*` 测试通过；server tsc；登记；提交；推送并开 PR（服务器期测试全绿即推）。**

### Task 9: 「我 › 通知 › 微信」绑定界面（界面期：先截图）

**Files:**
- Create: `app/src/components/settings/wechat-binding.tsx`
- Modify: `app/src/routes/_authed/settings/notifications.tsx`（加一节）、`app/src/lib/delivery.ts`（`Reachability.available.wechat`、`wechat` 状态；`startWechatBindMutationOptions()`、`wechatAttemptQueryOptions(id)`（2 秒轮询）、`unbindWechatMutationOptions(qc)`）、`app/src/components/settings/update-routing.tsx:66-71`（`TRANSPORTS` 加「微信」）、`app/src/components/settings/devices.tsx:37-39`（标签）、`app/src/lib/bot-lifecycle/queries.ts:8`
- Test: `app/tests/wechat-binding.test.tsx`

**Interfaces:**
- Consumes: Task 4 接口。
- 界面：
  - 未绑：「微信」一行 + 「绑定微信」→ 对话框显示二维码和三步说明（打开微信 › 我 › 设置 › 插件 › 微信 ClawBot；扫码；在手机上确认），状态随轮询变化（已扫码 / 已绑定 / 已过期，可「换一张」/ 已被别的账号绑定）。
  - 已绑：「已绑定 · 最近一次消息 X 分钟前」；时间窗已关时提示「超过 10 小时没在微信里说话，提醒会先发到手机，回一句就恢复」；暂停时「微信让我们歇一会儿，约 X 分钟后恢复」；失效时「微信已断开，请重新绑定」（Review Focus 5）；「解绑」按钮二次确认。

- [ ] **Step 1: 写失败测试**：未绑显示按钮；点了显示二维码；轮询到 `bound` 后关闭对话框、显示已绑定；`taken` 显示原因；解绑后回到未绑。
- [ ] **Step 2: 运行确认失败。**
- [ ] **Step 3: 实现**（用现有 `Item`/`Dialog`，样式走 `--wb-*` 令牌，只作用于默认皮肤）。
- [ ] **Step 4: 运行通过；app tsc；品牌护栏通过。**
- [ ] **Step 5: 起真服务器拍截图（暗色、2 倍）：未绑、二维码对话框、已绑定、时间窗已关、已断开**；发给用户确认。**确认后再推送。**

### Task 10: 对话里的「来自微信」小字（界面期：先截图）

**Files:**
- Modify: 服务器端 `index.ts:4036-4075` 记录用户消息的活动时带上来源（`source: "wechat"`）；前端对话转录在用户消息下方渲染小字「来自微信」（找到渲染用户消息元信息的组件后改，沿用已有的小字样式）
- Test: `app/tests/chat-transcript-source.test.tsx`，以及服务器端在 Task 6 的测试里断言来源被记下

- [ ] **Step 1: 写失败测试**：来源为微信的用户消息显示「来自微信」，网页发的不显示。
- [ ] **Step 2: 运行确认失败；实现；运行通过。**
- [ ] **Step 3: 截图（与 Task 9 一起发用户确认），确认后推送。**

---

## 开工与推送顺序

1. Task 1 先交给用户实测；Task 2～4 同时开工（不依赖实测结论）。
2. 用户回实测结果后，按结论修订规格和 Task 2 的常量，再做 Task 5～8。
3. Task 8 完成且服务器测试全绿 → 推送、开 PR（Codex 审、CI 绿、用户说「可以合」才合）。
4. Task 9～10 截图给用户确认后推送、开 PR。
