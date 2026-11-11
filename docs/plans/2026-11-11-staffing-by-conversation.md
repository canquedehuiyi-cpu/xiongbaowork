# 对话招员工 / 组群聊 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让小管家（及被打开该能力的员工）在对话里起草新员工、改员工、新群聊、改群聊，用户在对话里的卡片上确认后以本人身份执行。

**Architecture:** 新增内置工具服务 `builtin-staffing`（与 `builtin-routines` 并列），工具只往新表 `staffing_proposals` 写草稿并返回卡片标记；前端把标记渲染成可编辑卡片；用户点确认后调用 `/api/proposals/:id/apply`，由执行器以用户本人身份调用现有的建员工、授予、访问申请、定时任务、群聊服务。

**Tech Stack:** Bun 1.3.14、Hono、Drizzle + PostgreSQL（RLS）、React + TanStack Router/Query、bun:test、happy-dom、`@copilotkit/aimock`（e2e）。

**Spec:** `docs/specs/2026-11-11-staffing-by-conversation.md`（用户 2026-11-11 同意）。执行者先读规格，再读本计划。

## Global Constraints

- 原有测试一行不改、不跳过、不放宽；只新增测试文件或在新文件里加用例。
- 不新增出帧门：`server/tests/tenant-invariants.test.ts` 的 `SRC_DOORS` 不改。需要跨人读写时复用已有的帧（请求里的本人帧、`ensureAlwaysOnApp` 已有的循环）；做不到就停下报告，不改该测试。
- 新表：`tenant_id` 默认 `current_setting('app.tenant_id', true)`，ENABLE + FORCE RLS，四条 `tenant_isolation*` 策略，GRANT `openbot_app`（照 `0200_single_user_identity.sql`）。
- 迁移放 `openbot/server/recovery/recovery-20261018-v1/sql/`，编号 `0201`，journal `idx 201`、`when` 取提交当时的毫秒时间戳且大于 1794375869182。
- 审批底线（`approvals/policy.ts`）、签到只读门、凭据只进 vault、#455/#456 的管理员门，一概不动。
- 字段限长沿用 `CreateAgentInput`：`name` ≤80，`title` ≤120，`roleDescription` 1–1000，`instructions` ≤1000，`bible` ≤8000；定时任务 `instruction` ≤2000、`title` ≤100、cron 间隔 ≥15 分钟、启用中 ≤20。
- 提议：7 天过期；每人 `pending` 上限 20；同一人在同一会话里 10 分钟内最多新建 5 份提议（工具连接里没有运行 id，按会话 + 时间窗计数）。
- 用户可见文案一律中文；注释和测试名里不写 "review" / 「评审」（`comments-say-the-reason.test.ts`）；期望值不含 `undefined`（`assertion-shape.test.ts`）。
- 新增 server 测试文件后运行 `node scripts/ci/server-shards.mjs --write` 并提交 `scripts/ci/server-tests.list.txt`。
- 提交信息结尾：`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` 与 `Claude-Session: https://claude.ai/code/session_01MJUqVcFToyopKbNJ4sEoWY`。

## Review Focus

1. 起草后、确认前，目标员工被改名或删除，或群被改过 → 执行答 409「内容已变化」，什么都不改。（Task 4）
2. 起草后用户失去某应用或技能的授予能力（降权、主人可授予被关）→ 执行时该项转为访问申请或标为失败，不照草稿授予。（Task 4）
3. 草稿里的群成员在确认前变成私有或被删除 → 建群失败并说出是哪位员工，不建出缺人的群。（Task 4）
4. 群聊里别人看到卡片并调用 apply → 403，卡片对他只显示摘要。（Task 5、Task 8）
5. 同一提议同时被 PATCH 和 apply → 只有一方成功；apply 读到的是条件更新那一刻的草稿。（Task 2、Task 4）

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `server/recovery/.../sql/0201_staffing_proposals.sql`、`meta/_journal.json` | 新表与 RLS |
| `server/src/db/schema/staffing.ts`（并在 `schema/index.ts` 导出） | Drizzle 表定义 |
| `server/src/staffing/types.ts` | 提议、草稿、结果项的类型 |
| `server/src/staffing/draft.ts` | 草稿的解析与校验（工具与 PATCH 共用） |
| `server/src/staffing/store.ts` | 提议的读写、状态迁移、过期 |
| `server/src/staffing/executor.ts` | 以用户身份执行提议 |
| `server/src/staffing/routes.ts` | `/api/proposals` 路由 |
| `server/src/channels/group.ts` | 新增 `addBots` / `removeBots` / `reorder` 与路由 |
| `server/src/plugins/builtin-staffing.ts` | 六个工具 |
| `server/src/plugins/transport.ts`、`catalogue.ts` | 注册 `builtin-staffing` |
| `server/src/staffing/default-grant.ts` | 分身默认授予与升级补授 |
| `shared/staffing-proposal.ts` | 工具名、卡片标记、读写函数 |
| `app/src/components/staffing/*.tsx` | 四种卡片 |
| `app/src/components/channels/chat-transcript.tsx` | `ServerToolLine` 分支 |
| `scripts/e2e/staffing-lifecycle.ts`、`.github/workflows/ci.yml` | 端到端流程 |

（路径相对 `openbot/`。）

---

## S1：服务端执行层

### Task 1: 提议表与迁移

**Files:**
- Create: `server/recovery/recovery-20261018-v1/sql/0201_staffing_proposals.sql`
- Modify: `server/recovery/recovery-20261018-v1/meta/_journal.json`
- Create: `server/src/db/schema/staffing.ts`；Modify: `server/src/db/schema/index.ts`
- Test: `server/tests/staffing-proposals-table.integration.test.ts`

**Interfaces:**
- Produces: Drizzle 表 `staffingProposals`，列：`id uuid pk default gen_random_uuid()`、`tenantId`（`tenantId()` helper）、`ownerId text not null`、`proposedByAgentId text not null`、`threadId text null`、`kind text not null check in ('employee','employee_change','group','group_change')`、`draft jsonb not null`、`baseVersion text null`、`status text not null default 'pending' check in ('pending','applying','applied','partially_applied','discarded','expired')`、`result jsonb null`、`createdAt`、`updatedAt`、`expiresAt timestamptz not null`。索引：`(tenant_id, owner_id, status)`。

- [ ] **Step 1: 写失败测试** `staffing-proposals-table.integration.test.ts`：
  - `rows are visible only inside the owner's tenant frame`：在租户 A 帧插入一行，租户 B 帧 `select` 得 0 行，A 帧得 1 行。
  - `a row cannot be written into another tenant`：在 B 帧插入 `tenant_id = A` 的行，期望抛错（RLS `WITH CHECK`）。
  - `kind and status outside the lists are refused`：插入 `kind:"x"` 抛 check 约束错误。
- [ ] **Step 2: 运行确认失败**：`bun test server/tests/staffing-proposals-table.integration.test.ts` → 失败（表不存在）。
- [ ] **Step 3: 写迁移与 schema**：SQL 照 `0200_single_user_identity.sql` 的结构（语句间 `--> statement-breakpoint`，头部 `/* */` 注释说明这张表存什么、为什么按租户隔离），journal 追加 `idx 201`。
- [ ] **Step 4: 运行通过**，并跑 `bun test server/tests/rls-write-scope.test.ts server/tests/migration-reach.test.ts tests/tenant-invariants.test.ts`（在 `server/` 下）全过。
- [ ] **Step 5: 提交**：`feat(staffing): 提议表 staffing_proposals（迁移 0201，按租户隔离）`。

### Task 2: 草稿校验与提议存储

**Files:**
- Create: `server/src/staffing/types.ts`、`server/src/staffing/draft.ts`、`server/src/staffing/store.ts`
- Test: `server/tests/staffing-draft.test.ts`、`server/tests/staffing-store.integration.test.ts`

**Interfaces:**
- Produces（`types.ts`）：
  - `type ProposalKind = "employee" | "employee_change" | "group" | "group_change"`
  - `type ProposalStatus = "pending" | "applying" | "applied" | "partially_applied" | "discarded" | "expired"`
  - `type EmployeeDraft = { name: string; title: string; avatar?: { preset: PortraitPreset } | { seed: string }; roleDescription: string; instructions?: string; persona?: Persona; bible?: string; roleTemplate?: { id: string; version: number }; model?: { modelRef: string } | { platformModelRef: string }; skills: string[]; apps: { app: string; actions: string[] }[]; routines: { title?: string; instruction: string; cron: string; timezone?: string }[]; visibility: "private" | "public"; staffingTools: boolean }`
  - `type EmployeeChangeDraft = { agentId: string; set: Partial<Omit<EmployeeDraft, "roleTemplate" | "staffingTools">>; appsRemove: { app: string; actions: string[] }[]; routinesRemove: string[] }`
  - `type GroupDraft = { name: string; members: string[] }`（至少 2、至多 20、不重复）
  - `type GroupChangeDraft = { channelId: string; name?: string; add: string[]; remove: string[]; order?: string[] }`
  - `type ResultItem = { step: string; target?: string; outcome: "done" | "requested" | "needs_connection" | "failed"; message?: string }`
  - `type Proposal = { id; ownerId; proposedByAgentId; threadId: string | null; kind: ProposalKind; draft: EmployeeDraft | EmployeeChangeDraft | GroupDraft | GroupChangeDraft; baseVersion: string | null; status: ProposalStatus; result: ResultItem[] | null; createdAt: Date; updatedAt: Date; expiresAt: Date }`
- Produces（`draft.ts`）：`parseDraft(kind: ProposalKind, input: unknown): { ok: true; draft: …; dropped: { field: string; value: string; reason: string }[] } | { ok: false; error: string }`——只做形状与限长校验、去控制字符；不查库。
- Produces（`store.ts`）：`createStaffingProposalStore(db)` 返回：
  - `create(input: { ownerId; proposedByAgentId; threadId: string | null; kind; draft; baseVersion: string | null }): Promise<Proposal>`——超过每人 20 份 `pending` 抛 `ProposalLimitError`。
  - `get(id): Promise<Proposal | null>`（读时把已过 `expiresAt` 的 `pending` 视为 `expired` 并落库）。
  - `updateDraft(id, ownerId, draft): Promise<Proposal>`——仅 `pending`；条件更新 `where status='pending' and owner_id=…`，0 行时抛 `ProposalStateError`。
  - `claim(id, ownerId): Promise<Proposal>`——条件更新 `pending → applying` 并返回更新后的行；0 行时按原因抛 `ProposalExpiredError` / `ProposalStateError` / `ProposalNotFoundError`。
  - `finish(id, status: "applied" | "partially_applied", result: ResultItem[]): Promise<Proposal>`。
  - `reopenFailed(id, ownerId): Promise<Proposal>`——`partially_applied → applying`，供重试。
  - `discard(id, ownerId): Promise<Proposal>`——仅 `pending`。

- [ ] **Step 1: 写失败测试** `staffing-draft.test.ts`：
  - `an employee draft keeps the CreateAgentInput limits`：`name` 81 字 → `ok:false`；`roleDescription` 空 → `ok:false`；1000 字 → `ok:true`。
  - `control characters are removed from names and text`：`"小\u0007红"` → `"小红"`。
  - `a group needs two to twenty distinct members`：1 位 → `ok:false`；有重复 → `ok:false`；21 位 → `ok:false`。
  - `a routine below fifteen minutes is dropped with its reason`：`cron:"*/5 * * * *"` → `ok:true`，`dropped` 含 `field:"routines"`。
- [ ] **Step 2: 写失败测试** `staffing-store.integration.test.ts`（照 `owner-grants-hardening.integration.test.ts` 起库与 `runAsTenant`）：
  - `the twenty-first pending proposal is refused`。
  - `claim moves pending to applying once`：并发两次 `claim`，恰好一次成功，另一次抛 `ProposalStateError`。
  - `a pending proposal past its expiry reads as expired and cannot be claimed`。
  - `editing after claim is refused`：`claim` 后 `updateDraft` 抛 `ProposalStateError`。
  - `another person cannot claim, edit or discard`：同租户另一 `ownerId` 调用三者均抛 `ProposalNotFoundError`。
- [ ] **Step 3: 运行确认失败。**
- [ ] **Step 4: 实现 `types.ts`、`draft.ts`、`store.ts`。** 状态迁移全用单条带条件的 `UPDATE … RETURNING`，不先读后写。
- [ ] **Step 5: 运行通过**，`server-shards --write`，提交 `feat(staffing): 草稿校验与提议存储`。

### Task 3: 群聊加 / 移员工与改顺序

**Files:**
- Modify: `server/src/channels/group.ts`（`GroupStore`、`createGroupConversations`、`createGroupRoutes`）
- Test: `server/tests/group-bots-change.integration.test.ts`

**Interfaces:**
- Produces（`GroupConversations`）：
  - `addBots(owner: string, channelId: string, agentIds: string[]): Promise<{ added: string[] }>`
  - `removeBots(owner: string, channelId: string, agentIds: string[]): Promise<{ removed: string[] }>`
  - `reorder(owner: string, channelId: string, agentIds: string[]): Promise<void>`
- 规则：只有群的发起人（`store.people(channel)[0]`）可调用，否则抛与 `removeMember` 相同的拒绝；加的员工要过 `profileStore.getWithin(tx, actor, id)`（不可用则抛 `AgentNotFoundError` 并说出 id）；移除后群里员工少于 2 位则拒绝；`reorder` 的列表必须正好是群里现有员工的一个排列。写 `channel_agents` 与 `group_bot_threads`（`reorder` 按新顺序重写 `createdAt` 递增毫秒，与 `seedOrder` 同一套表示）。
- Produces（路由）：`POST /api/groups/:id/bots {agentIds}`、`DELETE /api/groups/:id/bots {agentIds}`、`PUT /api/groups/:id/order {agentIds}`。

- [ ] **Step 1: 写失败测试**：
  - `the creator adds a bot and it answers last`：建 A、B 的群，加 C，`order()` 得 `[A,B,C]`。
  - `a bot the creator cannot run is refused by name`：加别人的私有员工，期望拒绝且错误里含该 id，群不变。
  - `removing down to one bot is refused`。
  - `reorder must be a permutation of the current bots`：缺一位或多一位都拒绝。
  - `a member who is not the creator cannot change bots`：第二个人调用三个方法都被拒。
- [ ] **Step 2: 运行确认失败。**
- [ ] **Step 3: 实现三个方法与三个路由**（路由层沿用 `requireUser`，`owner = context.var.actor.id`）。
- [ ] **Step 4: 运行通过**，并跑 `bun test server/tests/group*` 确认原有群聊测试不受影响。
- [ ] **Step 5: 提交** `feat(groups): 已有群聊加 / 移员工与改回答顺序`。

### Task 4: 执行器

**Files:**
- Create: `server/src/staffing/executor.ts`
- Test: `server/tests/staffing-executor.integration.test.ts`

**Interfaces:**
- Consumes: Task 2 的 store；Task 3 的 `addBots/removeBots/reorder`；现有 `AgentProfileStore.create/update/get`、`QuotaService.assertCapacityWithin`、`PluginStore.grant/skillOwner/inspectApp/fileAppAccessRequest`、`ownerGrantRefusal`、`RoutineStore.create/remove`、`GroupConversations.create`、`ChannelStore.rename`、`PortraitStore.set`、`ModelCatalogueReader.allows`、`recordAuditEvent`。
- Produces：`createStaffingExecutor(deps)` 返回 `apply(actor: AuthenticatedActor, proposalId: string): Promise<Proposal>` 与 `retry(actor, proposalId): Promise<Proposal>`。
- 顺序与规则（全部在请求的本人帧里执行，不开新帧）：
  - `employee`：`create`（带 `quota.assertCapacityWithin(tx, actor.id, "wakers")`、`roleTemplate`；超额抛 `QuotaExceeded` 时什么都不建，提议回到 `pending`，向上抛出由路由答 402）→ 有 `model` 时 `update` 写 `modelRef`/`platformModelRef`（先 `allows`）→ 头像 `PortraitStore.set` → 技能逐个按现有自助授予规则 `grant("skill", …)` → 应用逐个：`inspectApp` 后，可授予的 `grant("mcp", ref, id, email, {as:"owner"})`，`needs-admin` 的 `fileAppAccessRequest({kind:"grant", maxPending: 20, …})` 记 `requested`，未连接的记 `needs_connection` → 定时任务逐个 `RoutineStore.create` → `staffingTools` 为真时授予 `staffing/*`。
  - `employee_change`：比对 `baseVersion`（员工 `updatedAt` 的 ISO 字符串），不一致抛 `ProposalStaleError`（不改任何东西，提议回到 `pending`）；然后 `update`（以当前员工资料为底合并 `set`）、增删授予、增删定时任务。
  - `group`：`GroupConversations.create(actor.id, {agentIds: members})`，再 `rename` 成 `name`。
  - `group_change`：比对 `baseVersion`（`versionOfGroup({ name, order })`：群当前名字与员工顺序一起的 JSON，改名或改顺序都会让它变），然后 `rename`、`addBots`、`removeBots`、`reorder`。
  - 每一步写一个 `ResultItem`；任一步抛错只记 `failed` 并继续下一步（`create` 抛错例外：什么都没建，提议回到 `pending` 并向上抛出）；全部 `done/requested/needs_connection` 为 `applied`，否则 `partially_applied`。
  - `retry` 只重做 `failed` 的项。
  - 每一步沿用现有审计事件，payload 加 `proposalId`；结束写 `staffing.proposal_applied` 或 `staffing.proposal_partially_applied`。

- [ ] **Step 1: 写失败测试**（每条都断言库里的真实结果，不只看返回值）：
  - `an applied employee draft creates the bot with its model, skills, apps and routines`。
  - `an app the person cannot give becomes an access request, not a grant`：`ownerGrants:"admin"` 的应用 → `plugin_grants` 无该行，`app_access_requests` 有一行，结果项 `requested`。
  - `a full plan creates nothing and keeps the proposal pending`：名额已满 → `apply` 抛 `QuotaExceeded`，员工数不变，提议状态仍是 `pending`。
  - `a stale change applies nothing and the proposal stays pending`：起草后改员工名，`apply` 抛 `ProposalStaleError`，员工名仍是外部改后的值，提议 `pending`。
  - `a member gone private fails the group by name`：起草后某成员改私有，`apply` 后结果项 `failed` 且 `message` 含该员工名，没有新群。
  - `a demoted admin's apply grants only what a member could`：会话角色 admin、`user_roles` 为 user → 管理员专属授予转为 `requested`。
  - `retry redoes only the failed steps`：第一次让定时任务失败（注入 `RoutineLimitError`），`retry` 后只多一条定时任务、员工仍是同一个。
  - `staffing tools are granted only when asked`：`staffingTools:false` → 新员工没有 `staffing/*` 授予。
- [ ] **Step 2: 运行确认失败。**
- [ ] **Step 3: 实现执行器。**
- [ ] **Step 4: 运行通过**，提交 `feat(staffing): 以本人身份执行提议`。

### Task 5: 提议路由与审计事件

**Files:**
- Create: `server/src/staffing/routes.ts`
- Modify: `server/src/app.ts`（挂 `/api/proposals`，在 `createApp` 依赖里接 store 与 executor）、`server/src/index.ts`（组装）、`server/src/audit.ts`（`auditEventTypes` 加六个事件）、`shared/audit-words.ts`（中文：创建 / 修改 / 执行 / 部分执行 / 作废 / 过期 招聘提议）
- Test: `server/tests/staffing-routes.integration.test.ts`

**Interfaces:**
- Produces：`createProposalRoutes(store, executor, requireUser, canSeeThread: (actor, threadId) => Promise<boolean>)`：
  - `GET /:id` → 主人：`200 { proposal, canAct: true }`；同租户能看到该会话的人：`200 { summary: { kind, title, ownerName, status }, canAct: false }`；其他：404。
  - `PATCH /:id {draft}` → 主人且 `pending`：`parseDraft` 后 `updateDraft`，写 `staffing.proposal_edited`；否则 403 / 409。
  - `POST /:id/apply` → 主人：`200 { proposal }`；非主人 403；过期 410；状态不对 409；`ProposalStaleError` → 409 `{ error: "内容已变化，请让小管家重新起草。" }`；`QuotaExceeded` → 402（沿用 `thrown.body`）。
  - `POST /:id/discard`、`POST /:id/retry`。
- 员工运行的机器凭证进不了这些路由（只挂 `requireUser`）。

- [ ] **Step 1: 写失败测试**：
  - `only the owner can apply, edit or discard`：同租户另一人 403，别的租户 404。
  - `a person in the same group sees a summary without actions`：`canAct:false`，返回体里没有 `draft`。
  - `an expired proposal answers 410`。
  - `a run's machine credential is refused`：用员工运行签名凭证调 `apply` → 401。
  - `each step writes an audit row carrying the proposal id`。
- [ ] **Step 2: 运行确认失败。**
- [ ] **Step 3: 实现路由、挂载与审计事件。**
- [ ] **Step 4: 运行通过**，并跑 `bun test tests/tenant-invariants.test.ts tests/assertion-shape.test.ts tests/comments-say-the-reason.test.ts`（在 `server/`）全过；`server-shards --write`。
- [ ] **Step 5: 提交** `feat(staffing): 提议的确认、作废、重试接口与审计`。开 PR「S1：对话招员工的服务端执行层」。

---

## S2：员工工具

### Task 6: 「招聘与组群」内置工具服务

**Files:**
- Create: `server/src/plugins/builtin-staffing.ts`、`shared/staffing-proposal.ts`
- Modify: `server/src/plugins/transport.ts`（`TransportKind` 加 `"builtin-staffing"`，`TRANSPORTS` 加条目）、`server/src/plugins/catalogue.ts`（条目 `key:"staffing"`、`host:"builtin://staffing"`、`transport:"builtin-staffing"`、`auth:{kind:"builtin"}`、`readTools` 列全部六个工具名、`writeTools: []`）、`server/src/index.ts`（`useStaffingTools(deps)`）
- Test: `server/tests/builtin-staffing.integration.test.ts`、`shared/tests/staffing-proposal.test.ts`

**Interfaces:**
- Produces（`shared/staffing-proposal.ts`）：
  - `STAFFING_PROPOSAL_MARKER = "<<openbot:staffing-proposal>>"`
  - `type StaffingProposalCard = { proposalId: string; kind: ProposalKind; title: string }`
  - `writeStaffingProposalAnswer(card: StaffingProposalCard, sentence: string): string`（`MARKER + JSON + "\n" + sentence`）
  - `readStaffingProposalAnswer(text: string): { card: StaffingProposalCard; sentence: string } | null`（逐字段校验，任何不符返回 null）
  - `STAFFING_TOOL_NAMES = ["list_staff","propose_employee","propose_employee_change","propose_group","propose_group_change","proposal_status"] as const`
- Produces（`builtin-staffing.ts`）：`useStaffingTools(deps: { proposals; profiles; plugins; routines; groups; catalogue; roleTemplates } | null): void`、`listTools(): Promise<McpTool[]>`、`listNeedsCredential = false`、`listIsThisCode = true`、`callTool(connection: { url; token?; actorId?; botId?; threadId? }, toolName: string, args: unknown): Promise<McpCallResult>`。
  - 主人 `connection.actorId`、员工 `connection.botId`、会话 `connection.threadId`；缺 `actorId` 或 `botId` 时返回 `isError`。
  - `list_staff`：返回本人能用的员工（id、名字、头衔、角色模板）、本人发起的群（id、名字、员工顺序）、角色模板、`catalogue` 允许的模型、可装技能、`giveableApps` 与其状态。
  - `propose_*`：`parseDraft` → 查库校验（模型 `allows`、技能 `skillOwner`、应用 `inspectApp`、改动类读目标并取 `baseVersion`、群成员 `canRunAgent`、改群要求发起人）→ 剔除无效项进 `dropped` → `proposals.create` → 写 `staffing.proposal_created` → 返回 `writeStaffingProposalAnswer(card, sentence)`，`sentence` 给模型看：已起草、等待用户确认、剔除了什么，并明确「不要说已经建好」。
  - `propose_group` 的需求里对不上的角色：参数里允许 `missingRoles: string[]`，原样写进给模型的句子，提示它问用户要不要先招。
  - 同一主人在同一会话（`connection.actorId` + `connection.threadId`）里 10 分钟内已新建 5 份提议时，再调 `propose_*` 返回 `isError`（按 `staffing_proposals.created_at` 计数，不在内存里记）。
  - `proposal_status`：只读本人的提议，返回状态与 `result` 摘要。
  - 工具 `description` 写明第 7 节「小管家怎么说话」的规则。

- [ ] **Step 1: 写失败测试**：
  - `shared`：`a written answer reads back`；`a tampered marker reads as null`（缺字段、kind 不在列表、非 JSON 各一条）。
  - `server`：
    - `a proposal is owned by the person in the run, not by an argument`：args 里塞 `ownerId:"other"`，提议的 `ownerId` 仍是 `connection.actorId`。
    - `a model outside the catalogue is dropped and named`。
    - `a group with someone else's private bot is refused`。
    - `changing a group the person did not start is refused`。
    - `the sixth proposal in ten minutes in one conversation is refused, and another conversation is not`。
    - `propose_* never creates a bot or a group`：调用后 `agents`、`channels` 行数不变。
    - `the catalogue lists every staffing tool as a read`：条目 `readTools` 含六个名字、`writeTools` 为空。
- [ ] **Step 2: 运行确认失败。**
- [ ] **Step 3: 实现。**
- [ ] **Step 4: 运行通过**，跑 `tenant-invariants`、`assertion-shape`、`comments-say-the-reason`；`server-shards --write`。
- [ ] **Step 5: 提交** `feat(staffing): 招聘与组群内置工具`。

### Task 7: 分身默认授予、升级补授、`bot-creator` 改用新工具

**Files:**
- Create: `server/src/staffing/default-grant.ts`
- Modify: 开通分身处（`tenant/provisioning.ts` 或 `tenant-package.ts` 写技能授予的同一处，二选一以实际代码为准）、启动处（`index.ts` 在 `ensureAlwaysOnApp` 旁调用补授）、`examples/qoderwake/skills/bot-creator/*`（技能说明改为调用 `mcp__staffing__propose_employee` / `propose_group`）
- Test: `server/tests/staffing-default-grant.integration.test.ts`

**Interfaces:**
- Produces：`grantStaffingToAvatar(store: PluginStore, avatarId: string): Promise<void>`（对 `staffing/*` 每个工具 `grant("mcp", ref, avatarId, "openbot:staffing-default")`，已存在则不动）；`backfillStaffingForAvatars(deps): Promise<number>`（复用 `ensureAlwaysOnApp` 已有的逐人循环与帧，不新增出帧门；只给 `avatar-*` 补，跳过 `granted_by` 已有任何 `staffing/*` 行或曾被 SEC1 关闭的员工）。

- [ ] **Step 1: 写失败测试**：
  - `a new person's avatar can propose employees`。
  - `an upgraded avatar gets the tools once`：跑两次 `backfill`，授予行数不变。
  - `a bot other than the avatar is not granted`。
  - `an avatar whose owner switched staffing off stays off`：先 SEC1 关闭，再 `backfill`，`disabledTools` 仍拦住。
- [ ] **Step 2: 运行确认失败。**
- [ ] **Step 3: 实现**；若补授必须新增出帧门，停下报告，不改 `tenant-invariants`。
- [ ] **Step 4: 运行通过**，提交 `feat(staffing): 小管家默认会招人组群，bot-creator 改用新工具`。开 PR「S2：招聘与组群工具」（base S1 分支）。

---

## S3：前端卡片

### Task 8: 四种卡片

**Files:**
- Create: `app/src/components/staffing/staffing-proposal-card.tsx`（按 `kind` 分发）、`employee-proposal.tsx`（复用 `components/agents/proposed-bot.tsx` 的布局与样式）、`employee-change-proposal.tsx`、`group-proposal.tsx`、`proposal-result.tsx`、`app/src/lib/staffing/queries.ts`（`useProposal(id)`、`useEditProposal`、`useApplyProposal`、`useDiscardProposal`、`useRetryProposal`）
- Modify: `app/src/components/channels/chat-transcript.tsx`（`ServerToolLine`：`readStaffingProposalAnswer(result)` 命中，且工具名去掉 `mcp__staffing__` 前缀后是 `propose_employee` / `propose_employee_change` / `propose_group` / `propose_group_change` 之一时渲染卡片（导出 `isStaffingProposalTool(name: string): boolean` 放在 `shared/staffing-proposal.ts`））、必要时 `channels/tool-activity.tsx`（不把卡片折进工具活动）
- Test: `app/tests/staffing-proposal-card.test.tsx`

**Interfaces:**
- Consumes: Task 5 的 `GET/PATCH/apply/discard/retry` 返回形状；Task 6 的 `readStaffingProposalAnswer`。
- 交互：
  - 新员工：头像、名字、「基于模板：××」；可折叠可编辑的「人设与风格 / 工作指令 / 模型与技能 / 应用（带状态标签）/ 定时任务 / 也给它招聘与组群能力」；底部名额提示「这是你的第 N / M 个员工」、「确认创建」「作废」。名额满时「确认创建」禁用并给升级入口。
  - 改员工：只列改动字段，「改前 → 改后」，旧值删除线。
  - 群：群名、成员头像按顺序一行可拖动排序、缺的角色与「先去招」（往输入框填「先帮我招一个××」并发送）。
  - 执行后：逐项 ✓ / 已转申请 / 需要先连接（带连接按钮）/ 失败可重试；「打开员工」「打开群聊」。
  - 非主人：一行摘要「××的小管家拟了一个新员工：××（待××确认）」，无按钮。
  - 作废 / 过期：变灰。
  - 黑白红（`docs/design/ios-studio`），手机宽度可用，按钮点击区 ≥44px。

- [ ] **Step 1: 写失败测试**（`routed(...)` + QueryClientProvider，mock fetch）：
  - `an owner sees the draft and confirms it`：点「确认创建」后发出 `POST /api/proposals/p1/apply`，结果项渲染出来。
  - `an edit is saved before confirming`：改名字后点确认，先 `PATCH` 再 `apply`，`PATCH` 体里是新名字。
  - `a full plan disables confirm and shows the upgrade link`。
  - `someone else sees a summary without buttons`。
  - `a stale answer asks to draft again`：`apply` 回 409，显示「内容已变化，请让小管家重新起草。」。
  - `group members can be reordered before confirming`：键盘可操作的上移 / 下移按钮改变顺序，`PATCH` 体里 `members` 顺序变了。
  - `a forged marker draws nothing`：`ServerToolLine` 收到坏标记时不渲染卡片。
- [ ] **Step 2: 运行确认失败**：`bun test app/tests/staffing-proposal-card.test.tsx`。
- [ ] **Step 3: 实现。**
- [ ] **Step 4: 运行通过**；app 的 `tsc`、`biome lint`、app 全量测试通过。
- [ ] **Step 5: 提交** `feat(app): 招聘与组群的确认卡片`。

### Task 9: 下线前端 `save_bot`

**Files:**
- Modify: `app/src/lib/copilot/bot-tools.tsx`、`app/src/lib/copilot/bot-offer.ts`（不再注册 / 提供 `save_bot`）
- Test: `app/tests/save-bot-retired.test.tsx`

- [ ] **Step 1: 写失败测试** `a bot with bot-creator is no longer offered save_bot`。
- [ ] **Step 2: 运行确认失败。**
- [ ] **Step 3: 移除注册**；`ProposedBotCard` 若已被 Task 8 复用则保留组件。原有引用 `save_bot` 的测试若因此失败，停下报告（不改原有测试），改为保留注册但不再向员工提供。
- [ ] **Step 4: 运行通过**，提交 `refactor(app): 对话建员工改走服务端提议，前端不再提供 save_bot`。开 PR「S3：招聘与组群卡片」（base S2 分支）。

---

## S4：端到端与文档

### Task 10: 端到端流程、文档、CHANGELOG

**Files:**
- Create: `scripts/e2e/staffing-lifecycle.ts`（照 `wakerflow-lifecycle.ts` 的结构）
- Modify: `.github/workflows/ci.yml`（新增 job「G6 staffing lifecycle (browser, mocked model)」，与 G4 同样的服务与环境）、`docs/` 用户文档一页（`docs/staffing.md`：怎么让小管家招人、组群，以及确认卡片上的各项）、`CHANGELOG.md` 的 `## Unreleased`
- Test: 该脚本本身

**Interfaces:**
- 模拟模型：`mock.onMessage` 处理器在最后一条 user 文本含「招」且消息里还没有 `role:"tool"` 时返回 `{ toolCalls: [{ name: "mcp__staffing__propose_employee", arguments: JSON.stringify({...}) }] }`；已有工具结果时返回一句中文 `{content}`。建群同理用 `propose_group`。

- [ ] **Step 1: 写脚本**，断言：
  - 发出「帮我招一个小红书运营」后出现卡片；改名字；点确认；`GET /api/agents` 多出这位员工且名字是改后的；卡片显示逐项结果；之后小管家的下一句话出现在对话里。
  - 「把 A 和 B 拉个群」→ 卡片 → 确认 → `GET /api/groups` 里有这个群，员工顺序是 `[A, B]`。
  - 用另一个账号打开同一会话，看不到按钮。
- [ ] **Step 2: 本地跑通**：`bun scripts/e2e/staffing-lifecycle.ts`，全部断言通过。
- [ ] **Step 3: 加 CI job，写文档与 CHANGELOG。**
- [ ] **Step 4: 推送后 CI 全绿**（含新 job 与 G4）。
- [ ] **Step 5: 提交** `test(e2e): 招聘与组群的浏览器流程；docs: 用户说明与 CHANGELOG`。开 PR「S4：端到端与文档」（base S3 分支）。

---

## 每个 PR 的收尾

独立只读审查 → 修复 → CI 全绿 → 转为待审触发 Codex → 回复并解决意见 → 依次合入（S1 → S2 → S3 → S4，前一个合入后把后一个的 base 改成 main）。
