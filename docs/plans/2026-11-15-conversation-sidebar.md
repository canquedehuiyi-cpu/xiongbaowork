# 对话侧栏 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 员工单聊和群组对话右侧常驻、可折叠的侧栏（环境 · 目标 · 上下文 · 输出内容），上下文用量总量准确、分类估算，并新做手动 + 自动的压缩会话。

**Architecture:** 服务器新增一个侧栏读取服务和 `GET /api/threads/:threadId/sidebar`，从已有表（`model_token_calls`、`tasks`、`thread_runs`、`project_context_bindings`、设备与员工资料）汇总；上下文上限来自模型库新列 `context_window`，分类比例在组装 prompt 时按段统计并落库；压缩存进新表并在组装消息时替换早期历史。前端在单聊 `DetailPanel` 与群组页加同一侧栏组件，可分块折叠、整栏收成图标条，手机为全屏页。

**Tech Stack:** Bun、TypeScript、Drizzle + Postgres（RLS）、Hono、`@ag-ui/client`、React + TanStack Router/Query、bun:test + happy-dom。

**Spec:** `docs/specs/2026-11-15-conversation-sidebar.md`（用户 2026-11-15 确认）。设计稿：https://claude.ai/artifact/3qe3uDJ2CVXKozJJWXtLNb

## 分期与关口

| 期 | 任务 | 关口 |
|---|---|---|
| 一 服务器 | 1–4 | 测试全绿即推（无界面） |
| 二 界面 | 5–7 | 暗色真实系统截图（含 390px 手机）给用户确认后推 |

与外部员工第二期并行。迁移编号：本计划用 `0216`；若外部员工分支先占用 0216，本计划顺延到下一个空号（裁定，见执行台账）。

## Global Constraints

- 用量只来自 `model_token_calls`；`usage_status = 'unknown'` 的不算；取不到时显示「—」或「还没有用量数据」，不编数。
- 已用口径：已用 = 计量记录的 `input_tokens`。AI SDK v3 报的输入总数已含缓存读写（如 Anthropic），不再另加缓存数。
- 上限取值顺序：员工绑定的 `model_registry` 行 → `platform_model_pool` 行 → 按实际调用的服务商 + 模型名查模型目录（models.dev `limit.context`）→ 无（不显示百分比、不自动压缩）。
- 自动压缩预留 = 上限的 10%；空余 = max(0, 上限 − 已用 − 预留)；「距自动压缩还剩」= 空余。
- 分类键与顺序：`messages` 消息、`system` 人设与系统提示、`tools` 工具、`skills` 技能、`memory` 记忆；另有派生的 `reserve` 自动压缩预留、`free` 空余。
- 压缩保留最近 10 条消息；更早的（含上次摘要）总结成一段；原消息保留在线程里。
- 总结指令保留：用户的决定和约定、未完成的事、关键事实与数字、文件和链接名；去掉：寒暄、重复、已被推翻的内容。
- 群组：环境成员、目标、输出内容全群一致；上下文按「查看者 × 每位员工」各自那条 `group_bot_threads` 线程；压缩只压缩查看者与该员工那条；群消息里不插分隔线，侧栏该员工用量行下方显示「已压缩 · 看摘要」。
- 外部员工（`device_acp`）：上下文写「由 <Codex|Claude Code|Hermes|名字> 自己管理」；压缩接口返回 409；这一期不接改动清单和计划步数。
- 侧栏宽 300px；整栏收起 56px；桌面宽度 < 1200px 默认收成图标条；折叠状态存浏览器本地，键含线程 id；读不到默认全部展开。
- 输出内容超过 3 条显示「查看全部 N 项」。
- 文案中文；沿用 `--wb-*` 令牌；只作用于默认皮肤。

## Review Focus

1. 一个对话里有多位员工（单聊里转交过、或群组）：上下文必须按员工分开，不能把 A 的用量算到 B 头上。→ Task 3 测试。
2. 模型换过（中途改了员工的模型）：上限按最近一次调用实际用的模型算，不按当前配置算。→ Task 2 测试。
3. 压缩正在进行时又来一轮：不能并发压缩同一条线程两次，第二次等第一次或直接跳过。→ Task 4 测试。
4. 总结失败或模型返回空：不写压缩记录，这一轮照常跑，界面提示一次。→ Task 4 测试。
5. 看不到这个对话的人（别人的单聊、没加入的群组）请求侧栏或压缩：404，不泄露存在与否。→ Task 3、Task 4 测试。

---

## 期一：服务器

### Task 1: 数据库与模型目录

**Files:**
- Create: `openbot/server/recovery/recovery-20261018-v1/sql/0216_conversation_sidebar.sql`（+ journal 追加 idx 216）
- Create: `openbot/server/src/db/schema/thread-context.ts`（两张新表），并在 schema 索引导出
- Modify: `openbot/server/src/db/schema/model.ts`（`modelRegistry`、`platformModelPool` 加 `contextWindow`）、`openbot/server/src/model-catalogue.ts:638-660`（`Capability` 增 `contextWindow?: number`，`parseCapabilities` 保留 models.dev `limit.context`）、模型库新增模型的写入处（用目录值预填 `context_window`）、模型库编辑接口（允许管理员改 `contextWindow`，正整数或 null）
- Test: `openbot/server/tests/conversation-sidebar-schema.integration.test.ts`、`openbot/server/tests/model-catalogue.test.ts`（加用例）

**Interfaces:**
- Produces:
  - 列 `model_registry.context_window integer null`、`platform_model_pool.context_window integer null`，CHECK `> 0`。
  - 索引 `model_token_calls (tenant_id, thread_id, agent_id, started_at)`、`tasks (tenant_id, channel_ref, updated_at)`。
  - 表 `thread_context_breakdowns`（Drizzle `threadContextBreakdowns`）：`id uuid pk`、`tenant_id`、`thread_id`、`agent_id`、`run_id`、`shares jsonb not null`（`{messages,system,tools,skills,memory}` 0–1 小数，和为 1）、`created_at`；索引 `(tenant_id, thread_id, agent_id, created_at)`。
  - 表 `thread_compactions`（Drizzle `threadCompactions`）：`id uuid pk`、`tenant_id`、`thread_id`、`agent_id`、`upto_message_id text not null`、`summary text not null`、`tokens_before integer`、`tokens_after integer`、`auto boolean not null`、`created_at`；索引 `(tenant_id, thread_id, agent_id, created_at)`。
  - 两表 RLS 与租户策略同 0215 的 `acp_turns`。
  - `Capability.contextWindow?: number`。

- [ ] **Step 1: 测试**：`test("context_window accepts positive integers and null, rejects 0")`；`test("thread_context_breakdowns and thread_compactions are tenant-isolated")`；目录：`test("parseCapabilities keeps limit.context as contextWindow")`；模型库：`test("adding a model pre-fills context_window from the catalogue")`、`test("admin can edit context_window")`。
- [ ] **Step 2: 跑确认失败**（DB 环境：`source <scratchpad>/sum-env.sh`，`DATABASE_URL=$OWNER_URL bun run scripts/migrate.ts`）。
- [ ] **Step 3: 实现**（迁移头注释：目的、回填（无）、权限、回滚）。
- [ ] **Step 4: 迁移 + 测试通过**；`schema.test.ts` 若断言所涉表的列则同步；新测试文件后跑 `bun scripts/ci/server-shards.mjs --write`；server tsc。
- [ ] **Step 5: Commit** `feat(db): 对话侧栏的上下文上限、分类比例与压缩记录（0216）`

### Task 2: 用量、上限与分类比例

**Files:**
- Create: `openbot/server/src/threads/context-usage.ts`、`openbot/shared/conversation-sidebar.ts`（`ContextUsage` 起，Task 3 继续补类型）
- Modify: `openbot/server/src/copilot.ts`（`builtInAgentConfiguration` 约 1074–1160 的分段处与消息拼接处：统计各段字数，运行开始时写一行 `thread_context_breakdowns`）
- Test: `openbot/server/tests/context-usage.test.ts`、`openbot/server/tests/context-usage.integration.test.ts`

**Interfaces:**
- Consumes: Task 1 表与列；`model_token_calls`。
- Produces:
  - `usedTokens(row: {provider: string; inputTokens: number | null; cachedInputTokens: number | null; cacheWriteTokens: number | null}): number | null`
  - `resolveContextLimit(input: {modelRef: string | null; platformModelRef: string | null; provider: string; modelName: string}, deps): Promise<number | null>`（顺序见 Global Constraints）
  - `type ContextUsage = {used: number | null; limit: number | null; percent: number | null; categories: {key: "messages"|"system"|"tools"|"skills"|"memory"|"reserve"|"free"; tokens: number}[]; untilAutoCompact: number | null; lastModel: {provider: string; name: string} | null}`（放在 `openbot/shared/conversation-sidebar.ts`，前端共用）
  - `readContextUsage(tenantId: string, threadId: string, agentId: string, deps): Promise<ContextUsage>`
  - `promptShares(sections: {key: "messages"|"system"|"tools"|"skills"|"memory"; chars: number}[]): Record<…, number>`
  - 段到类别的映射：`identity/persona/handbook/person_instructions/avatar_sources/project/run_mode/working/asking/model/today/routine_checklist/picked_skill` → `system`；`apps`/工具 schema → `tools`；`learned_skills` → `skills`；个人记忆中间件注入 → `memory`；历史消息与压缩摘要 → `messages`。

- [ ] **Step 1: 测试**：
  - `test("anthropic-family usage adds cached and cache-write tokens")`、`test("openai-family usage takes input_tokens only")`、`test("unknown usage gives null")`。
  - `test("limit prefers registry, then pool, then catalogue by provider+model, else null")`。
  - `test("limit follows the model of the latest call, not the current configuration")`（Review Focus 2）。
  - `test("categories split used by the latest shares and add reserve 10% and free")`：已用 53 200、上限 128 000、shares {messages .583, system .128, tools .180, skills .058, memory .051} → reserve 12 800、free 62 000、各类按比例四舍五入且和 = 已用。
  - `test("no limit → percent, reserve, free and untilAutoCompact are null")`。
  - 集成：`test("a built-in run writes one breakdown row whose shares sum to 1")`。
- [ ] **Step 2–4: 失败 → 实现 → 通过**；server tsc。
- [ ] **Step 5: Commit** `feat(server): 对话上下文用量、上限与分类比例`

### Task 3: 侧栏接口

**Files:**
- Create: `openbot/server/src/threads/sidebar.ts`、`openbot/server/src/threads/sidebar-routes.ts`（挂 `/api/threads/:threadId/sidebar`；群组按频道：`/api/channels/:channelId/sidebar`）
- Test: `openbot/server/tests/conversation-sidebar.integration.test.ts`

**Interfaces:**
- Consumes: Task 2 `readContextUsage`；`tasks`、`thread_runs`、`project_context_bindings`、设备记录、员工资料、`group_bot_threads`、`thread_compactions`。
- Produces（两个接口共用的返回类型，写在 `openbot/shared/conversation-sidebar.ts`）：
  - `SidebarEnvironment = {kind: "cloud" | "device"; deviceName?: string; online?: boolean; project?: {id: string; name: string} | null; workdirName?: string | null; model: {label: string; external?: {harness: string}} | null; members?: {agentId: string; name: string; status: "working"|"resting"|"paused"|"offline"|"unknown"; where: string; doing: string | null}[]}`
  - `SidebarGoal = {title: string; status: "running"|"needs_action"|"awaiting_review"|"done"|"failed"; rounds: number; lastCheck: string; pendingApprovalId: string | null} | null`（`lastCheck` = 状态一句话 + 员工最近一条回复第一句，截 60 字）
  - `SidebarContext = {managedBy?: string; usage?: ContextUsage; perAgent?: {agentId: string; name: string; percent: number | null; managedBy?: string; compactedAt?: string | null}[]; lastCompaction?: {id: string; auto: boolean; at: string} | null}`
  - `SidebarOutput = {kind: "file"|"table"|"link"|"diff"|"report"; title: string; href: string; at: string; byAgentId?: string}`
  - `ConversationSidebar = {environment: SidebarEnvironment; goal: SidebarGoal; context: SidebarContext; outputs: {items: SidebarOutput[]; total: number}}`（items 最多 3 条）
  - `GET /api/threads/:threadId/sidebar` → `ConversationSidebar`；`GET /api/channels/:channelId/sidebar?agentId=`（群组，`agentId` 取某员工明细）→ 同类型。权限：现有对话可见性；看不到 → 404。
  - 任务卡匹配：`channel_ref IN (threadId, 该线程所属频道 id)`，取 `updated_at` 最新一张。

- [ ] **Step 1: 测试**：四块的单聊用例；`test("no usage yet → context.usage.used null")`；`test("external employee → context.managedBy is the harness label and no usage")`；`test("group: members list, per-agent usage is the viewer's own thread per employee")`；`test("two employees in one thread keep separate usage")`（Review Focus 1）；`test("someone who cannot see the conversation gets 404")`（Review Focus 5）；`test("outputs are newest first, deduped, capped at 3 with total")`。
- [ ] **Step 2–4: 失败 → 实现 → 通过**。
- [ ] **Step 5: Commit** `feat(server): 对话侧栏接口`

### Task 4: 压缩会话

**Files:**
- Create: `openbot/server/src/threads/compaction.ts`
- Modify: 消息组装处（个人记忆中间件旁，`copilot.ts` 约 2569–2600）：有压缩记录时，把 `upto_message_id` 及之前的消息换成一条系统消息「早前对话摘要：<summary>」；运行开始前的自动压缩判断；`sidebar-routes.ts` 增加 `POST /api/threads/:threadId/compact`、`POST /api/channels/:channelId/compact {agentId}`
- Test: `openbot/server/tests/compaction.test.ts`、`openbot/server/tests/compaction.integration.test.ts`

**Interfaces:**
- Consumes: Task 1 `thread_compactions`；Task 2 `readContextUsage`；员工绑定的模型调用。
- Produces:
  - `compactThread(input: {tenantId; threadId; agentId; auto: boolean}, deps): Promise<{status: "compacted"; tokensBefore: number | null; tokensAfter: number | null} | {status: "skipped"; reason: "too_short" | "in_progress" | "external" | "failed"}>`
  - `applyCompaction(messages: Message[], record: {uptoMessageId: string; summary: string} | null): Message[]`
  - `shouldAutoCompact(usage): boolean`（`used >= limit - reserve` 且 limit 非空）
  - `COMPACTION_KEEP_LAST = 10`；总结指令常量 `COMPACTION_INSTRUCTION`（内容按 Global Constraints 的保留 / 去掉清单）。
  - 接口：成功 200 `{tokensBefore, tokensAfter}`；外部员工 409；进行中 409 `{reason:"in_progress"}`；不可见 404。

- [ ] **Step 1: 测试**：`test("keeps the last 10 messages and summarises the rest into one system message")`；`test("the original messages stay in the thread")`；`test("a second compaction folds the previous summary in")`；`test("concurrent compaction of the same thread runs once")`（Review Focus 3）；`test("summary failure or empty output writes nothing and the run proceeds")`（Review Focus 4）；`test("auto compaction runs before a turn when used >= limit - reserve")`；`test("no limit → never auto-compacts")`；`test("external employee → 409")`；`test("cannot see the conversation → 404")`；`test("the compaction call is metered on this thread")`。
- [ ] **Step 2–4: 失败 → 实现 → 通过**；含 copilot/thread 相关套件无回归。
- [ ] **Step 5: Commit** `feat(server): 压缩会话（手动与自动）`

**期一收尾：** 整期评审 → 推送 → PR（草稿）→ CI 绿 + Codex 评审 → 合入。

## 期二：界面

### Task 5: 侧栏组件与单聊接入

**Files:**
- Create: `openbot/app/src/skins/xiongbao/conversation-sidebar/{sidebar.tsx,environment.tsx,goal.tsx,context.tsx,outputs.tsx,collapse.ts}`、`openbot/app/src/lib/threads/sidebar.ts`（查询：15 秒轮询；运行结束、审批变化时失效）
- Modify: `openbot/app/src/routes/_authed/_app/channel/$channelId.tsx`（`DetailPanel` 放侧栏，替换 `AgentProfile` 区块；`ConversationApprovals` 并入目标的「去确认」）；模型库编辑表单加「上下文长度」字段（`components/resources/model-zones.tsx` 或 `/admin/providers` 对应表单）
- Test: `openbot/app/tests/conversation-sidebar.test.tsx`

**Interfaces:**
- Consumes: `shared/conversation-sidebar.ts` 类型；Task 3、4 接口。
- Produces: `ConversationSidebar({source: {threadId: string} | {channelId: string}, variant: "panel" | "page"})`；`useSidebarCollapse(key: string): {section(name): {open: boolean; toggle(): void}; whole: {collapsed: boolean; toggle(): void}}`（本地存储，读写都包 try/catch）。

- [ ] **Step 1: 测试**：`test("renders 环境/目标/上下文/输出内容 in that order")`；`test("context bar segments and legend match categories; percent and 53.2k / 128k format")`；`test("no limit shows used only and hides 距自动压缩")`；`test("each section collapses and shows its one-line summary")`；`test("whole sidebar collapses to the 56px icon strip with 42% and the pending dot")`；`test("collapse state survives remount for the same thread")`；`test("width < 1200 starts collapsed")`；`test("去确认 scrolls to the pending approval card")`；`test("outputs show 3 and 查看全部 N 项")`；`test("external employee shows 由 Codex 自己管理")`；`test("model library edits 上下文长度")`。
- [ ] **Step 2–4: 失败 → 实现 → 通过**（`cd openbot/app && bun test tests/conversation-sidebar.test.tsx`）。
- [ ] **Step 5: Commit** `feat(app): 对话侧栏与单聊接入`

### Task 6: 群组、手机与压缩界面

**Files:**
- Modify: `openbot/app/src/routes/_authed/_app/group/$channelId.tsx`（右侧面板，`source: {channelId}`）、手机布局（对话顶栏按钮 → 全屏侧栏页，「返回对话」）、`openbot/app/src/components/channels/chat-transcript.tsx`（单聊的「已压缩 · 看摘要」分隔线）
- Create: `openbot/app/src/skins/xiongbao/conversation-sidebar/compact-dialog.tsx`、`summary-view.tsx`
- Test: `openbot/app/tests/conversation-sidebar-group.test.tsx`

- [ ] **Step 1: 测试**：`test("group sidebar lists members with status dots and where/doing")`；`test("group per-agent bars; clicking a name shows that employee's breakdown and compact button")`；`test("group shows 已压缩 · 看摘要 under the employee row, not in the transcript")`；`test("compact dialog shows before → estimated after and calls the endpoint")`；`test("single chat shows the divider with 看摘要 expanding the summary")`；`test("auto compaction divider reads 已自动压缩")`；`test("phone: header button opens the full-screen sidebar with 返回对话")`。
- [ ] **Step 2–4: 失败 → 实现 → 通过**；app 全量 `bun test`、tsc、biome。
- [ ] **Step 5: Commit** `feat(app): 群组侧栏、手机全屏与压缩会话`

### Task 7: 截图关口

- [ ] **Step 1:** 用 `scratchpad/wb-shots` 的启动脚本起真实系统（模拟模型返回带 usage 的回复，模型库给一个上下文长度），拍暗色截图：单聊（展开、分块收起、整栏收起）、群组、压缩弹窗与分隔线、390px 手机全屏侧栏。
- [ ] **Step 2:** 发截图页给用户，确认后整期评审 → 推送 → PR → CI + Codex → 合入。
