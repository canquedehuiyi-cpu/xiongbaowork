# 招入外部智能体当员工 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用户电脑上的 Codex、Claude Code、Hermes（及任何支持 ACP 的智能体）能被招成熊宝员工：在用户电脑上干活，实时过程进对话，请求许可进「等你确认」，离线排队。

**Architecture:** runner 新增 ACP 客户端（JSON-RPC over stdio），把适配器的 `session/update` 和 `session/request_permission` 以 `acp.*` 帧经现有 runner WebSocket 送上服务器。服务器新增员工类型 `device_acp`，其 AG-UI 传输 `DeviceAcpAgent` 把帧翻译成线程事件；许可请求经现有策略引擎 `decideAction` 判定，需要人批时开审批记录，决定后由监听器把答案发回设备。轮次按对话线程排在新表 `acp_turns`，不复用电脑动作队列。

**Tech Stack:** Bun、TypeScript、Drizzle + Postgres（RLS）、Hono、`@ag-ui/client`（`AbstractAgent`、rxjs `Observable`）、React + TanStack Router/Query、bun:test + happy-dom、Tauri runner。

**Spec:** `docs/specs/2026-11-15-external-agents.md`（用户 2026-11-15 确认）。设计稿：https://claude.ai/artifact/1oaAV9rkPVwBdnUNYCUbzu

## 分期与截图关口

| 期 | 任务 | 关口 |
|---|---|---|
| 一 地基 | 1–4 | 测试全绿即可推（无界面） |
| 二 服务器 | 5–9 | 用假 ACP 智能体跑通端到端的服务器测试；无界面 |
| 三 界面 | 10–12 | 暗色真实系统截图（含 390px 手机）给用户确认后推 |
| 四 真机 | 13 | 发设备端新版（用户推标签），用户在自己电脑上验收 |

每期一个 PR，合并方式 `merge`。

## Global Constraints

- 员工类型枚举值：`device_acp`；界面称「外部员工」，标记文案「外部员工 · <Codex|Claude Code|Hermes|名字>」。
- `harness` 取值：`codex` | `claude-code` | `hermes` | `custom`。
- 帧类型前缀 `acp.`：服务器→设备 `acp.open`、`acp.prompt`、`acp.cancel`、`acp.permission.answer`；设备→服务器 `acp.update`、`acp.permission.request`、`acp.turn.end`、`acp.turn.ack`。
- 路径和命令不上服务器：工作文件夹只存 `fld_…` 引用（`DeviceRoot.ref`），自定义智能体只存 `app_…` 引用（`DeviceApp.ref`）；路径是否在工作文件夹内由设备判定。
- 外部员工 `visibility` 固定 `private`，`ownerUserId` = 招聘人；只有招聘人能单聊、派活、改配置、批它的许可、把它拉进或移出群组。
- 只能在 `registered_devices.paired_by_user_id` = 本人的电脑上招；个人版迁移时回填为唯一用户，团队版留空。
- 占「wakers」名额；外部员工的 token 不走熊宝计量。
- 五项规则键与默认：`editInside`=`direct`、`touchOutside`=`ask`、`runCommand`=`dangerous`、`network`=`ask`、`push`=`ask`；取值 `direct` | `ask`（`runCommand` 另有 `dangerous`）。
- 现有全部底线照旧适用（删除一律问且只给批准这一次；付款结账确认收货；对外发送；凭据；安全设置；分享与发布）。招聘页底线文案：「付款和下单 · 删除文件 · 对外发消息或邮件」。
- 熊宝审批选项映射 ACP：批准→`allow_once`，这次对话里都允许→`allow_always`，拒绝→`reject_once`；底线与管理员拒绝不给「这次对话里都允许」。
- 适配器空闲 600000 ms 关闭（与 `runner/src/app-host.ts` 的 `IDLE_MS` 相同）。
- runner 每轮更新缓存上限 1000 条或 5 MB，超出只保留最新的 `plan` 与每个工具调用的最后状态。
- 新会话上下文：人设 + 本线程最近 20 条消息 + 当前任务卡。
- 这一步外部员工不接例行任务、职责、主动工作、定时触发；这些入口对 `device_acp` 不显示、服务器拒绝。
- 日报项不显示。
- 文案中文；沿用工作台 `--wb-*` 令牌；只作用于默认皮肤的样式写在 xiongbao 皮肤里。

## Review Focus

1. 电脑重连时同一个许可请求再报一次：不能出现两条「等你确认」（按 `requestId` 去重）。→ Task 7 测试。
2. 工作文件夹判定遇到 `..`、符号链接、Windows 大小写不同的路径：按设备上 `realpath` 后的结果判定，`C:\Code\x` 与 `c:\code\x\..\x` 算同一处。→ Task 4 测试。
3. 等许可等几个小时：这一轮不能被 stall guard 或运行超时杀掉，看板保持「需要操作」。→ Task 6 测试。
4. 群里非招聘人直接调审批接口批外部员工的许可：403，许可保持挂起。→ Task 7 测试。
5. 自定义智能体从不请求许可：招聘时必须二次确认，名片上有警示。→ Task 8、Task 11 测试。

---

## 期一：地基

### Task 1: 数据库：员工类型、设备认主、轮次表

**Files:**
- Create: `openbot/server/recovery/recovery-20261018-v1/sql/0215_external_agents.sql`
- Modify: `openbot/server/recovery/recovery-20261018-v1/meta/_journal.json`（追加 idx 215）
- Modify: `openbot/server/src/db/schema/core.ts:31-37`（枚举加值）、`openbot/server/src/db/schema/devices.ts`（两列）、新建 `openbot/server/src/db/schema/acp-turns.ts` 并在 schema 索引导出
- Modify（放宽类型联合）：`server/src/agents/profile-store.ts:476,488,495,580,614`、`server/src/agents/registry.ts:14`、`server/src/agents/framework.ts:37`、`server/src/tenant-package.ts:276`、`server/src/copilot.ts:604`、`server/src/plugins/store.ts:7278`
- Test: `openbot/server/tests/external-agents-schema.integration.test.ts`；更新 `server/tests/schema.test.ts` 的列/外键/索引期望和分片清单（`bun scripts/ci/server-shards.mjs --write`）

**Interfaces:**
- Produces: 枚举值 `device_acp`；`registeredDevices.pairedByUserId: text | null`；`devicePairCodes.mintedByUserId: text | null`；表 `acp_turns`（Drizzle 名 `acpTurns`）列：`id uuid pk`、`tenant_id text not null`、`agent_id text not null`、`thread_id text not null`、`device_id text not null`、`turn_id text not null unique`、`status text not null check in ('queued','sent','running','awaiting','done','interrupted','cancelled')`、`prompt jsonb not null`、`last_seq integer not null default 0`、`created_at`、`updated_at`；索引 `(tenant_id, thread_id, created_at)`；RLS 与租户策略同 `work_items`。

- [ ] **Step 1: 写失败的集成测试** `external-agents-schema.integration.test.ts`：
  - `test("agent_type accepts device_acp")`：插入 `type: "device_acp"` 的 agents 行成功。
  - `test("acp_turns is tenant-isolated")`：租户 A 写入的行，租户 B 帧内读不到。
  - `test("personal tenants backfill paired_by_user_id")`：迁移前插一台设备（单用户租户），迁移后该列 = 那个用户。
- [ ] **Step 2: 跑测试确认失败**：`source <scratchpad>/sum-env.sh && cd openbot/server && bun test tests/external-agents-schema.integration.test.ts` → FAIL。
- [ ] **Step 3: 写 0215 迁移**（中文头注释：目的、回填、权限、回滚），`ALTER TYPE "public"."agent_type" ADD VALUE 'device_acp'` 单独一句；回填：`tenant_id` 对应租户只有一个用户时写该用户。更新 Drizzle schema 与类型联合。
- [ ] **Step 4: 迁移并跑测试**：`DATABASE_URL=$OWNER_URL bun run scripts/migrate.ts && bun test tests/external-agents-schema.integration.test.ts tests/schema.test.ts` → PASS；`bunx tsc --noEmit -p server` 0 错误。
- [ ] **Step 5: Commit** `feat(db): 外部员工类型、设备认主与 ACP 轮次表（0215）`

### Task 2: 配对时记下是谁配的

**Files:**
- Modify: `openbot/server/src/devices/routes.ts:60`（`POST /pair`）、`openbot/server/src/devices/store.ts:332`（`redeemPairCode`）、`store.ts` 的 `mintPairCode`、`DeviceRecord`（加 `pairedByUserId`）
- Test: `openbot/server/tests/devices.test.ts`（或其集成版）

**Interfaces:**
- Consumes: Task 1 两列。
- Produces: `mintPairCode(tenantId: string, mintedByUserId: string): Promise<…>`；`redeemPairCode` 把 `minted_by_user_id` 写入设备的 `paired_by_user_id`（插入与再配对都写）；`DeviceRecord.pairedByUserId: string | null`。

- [ ] **Step 1: 测试** `test("a device remembers who minted its pair code")`：用户 U 调 `/pair` 得码，runner 用码 `/register`，`DeviceRecord.pairedByUserId === "U"`；`test("re-pairing by another person moves the owner")`。
- [ ] **Step 2: 跑测试确认失败。**
- [ ] **Step 3: 实现。** `/pair` 把 `context.var.actor.id` 同时作为 mintedBy 传入。
- [ ] **Step 4: 跑测试通过。**
- [ ] **Step 5: Commit** `feat(devices): 配对时记下认主人`

### Task 3: runner：ACP 客户端与发现

**Files:**
- Create: `openbot/shared/acp.ts`（runner 与服务器共用的类型：`AcpHarness`、`AcpRuleKey`、`ACP_RULE_DEFAULTS`、全部 `acp.*` 帧的 TS 类型）
- Create: `openbot/runner/src/acp/client.ts`（JSON-RPC over stdio）、`openbot/runner/src/acp/manifest.ts`（三家启动参数清单）、`openbot/runner/src/acp/discover.ts`
- Modify: `openbot/runner/src/mcp-client.ts`（把 `launchSpec` / `StdioTransport` 的入参从 `AppEntry` 放宽为 `{command; args; env; cwd?}`，MCP 调用方不变）、`openbot/runner/src/discover-actions.ts:44`（登记 `agents.discover`）
- Create: `openbot/runner/tests/fixtures/fake-acp-agent.ts`（按剧本回应的假 ACP 智能体，后续任务共用）
- Test: `openbot/runner/tests/acp-client.test.ts`、`openbot/runner/tests/acp-discover.test.ts`

**Interfaces:**
- Produces:
  - `shared/acp.ts`：`type AcpHarness = "codex" | "claude-code" | "hermes" | "custom"`；`type AcpRuleKey = "editInside" | "touchOutside" | "runCommand" | "network" | "push"`；`ACP_RULE_DEFAULTS: Record<AcpRuleKey, "direct" | "ask" | "dangerous">` = Global Constraints 里的默认；Task 4 列出的每个帧一个类型。
  - `createAcpClient(spec: {command: string; args: string[]; env: Record<string,string>; cwd: string}, handlers: {onUpdate(sessionId: string, update: unknown): void; onPermission(sessionId: string, request: {toolCall: unknown; options: {optionId: string; kind: string; name: string}[]}): Promise<{outcome: "selected"; optionId: string} | {outcome: "cancelled"}>}): AcpClient`
  - `AcpClient = { initialize(): Promise<{loadSession: boolean}>; newSession(cwd: string): Promise<string>; loadSession(sessionId: string, cwd: string): Promise<boolean>; prompt(sessionId: string, content: unknown[]): Promise<{stopReason: string}>; cancel(sessionId: string): void; close(): Promise<void>; readonly alive: boolean }`
  - `ACP_MANIFEST: Record<Exclude<AcpHarness,"custom">, {binary: string; adapter: {command: string; args: string[]}; askMode: string[]}>`：`askMode` 是让该智能体「每个非只读动作都请求许可」的启动参数（以各适配器当时文档为准，实现者核对后写死并在注释写出处）。
  - `agents.discover` 输出 `{agents: {harness: AcpHarness; version: string | null; installed: boolean; acpReady: boolean; signedIn: boolean | null}[]}`
- 客户端能力声明：不声明 `fs`、`terminal`，让智能体用自己的工具并为非只读动作请求许可。

- [ ] **Step 1: 测试**（用 fake-acp-agent）：
  - `test("initialize → newSession → prompt streams updates then resolves stopReason")`：`onUpdate` 收到剧本里 3 条更新，`prompt` 返回 `{stopReason: "end_turn"}`。
  - `test("permission request is answered with the option the handler picks")`：handler 返回 `allow_once` 的 optionId，假智能体收到同一 id。
  - `test("cancel sends session/cancel and pending permission resolves cancelled")`。
  - `test("child exit rejects in-flight calls and alive becomes false")`。
  - discover：`test("reports installed, acpReady and signedIn null when status cannot be read")`；`test("never returns file contents, only booleans and version")`（输出 JSON 的键集合恰为上述五个）。
- [ ] **Step 2: 跑测试确认失败**：`cd openbot/runner && bun test tests/acp-client.test.ts tests/acp-discover.test.ts`。
- [ ] **Step 3: 实现。** 换行分隔的 JSON-RPC 2.0；Windows 复用 `launchSpec` 的 `.cmd` 包装与 `StdioTransport.stop()` 的进程树终止。
- [ ] **Step 4: 跑测试通过**，并跑 `bun test tests/mcp-client.test.ts tests/app-host.test.ts` 确认 MCP 未回归。
- [ ] **Step 5: Commit** `feat(runner): ACP 客户端、启动清单与 agents.discover`

### Task 4: runner：会话宿主与 acp.* 帧

**Files:**
- Create: `openbot/runner/src/acp/host.ts`、`openbot/runner/src/acp/paths.ts`
- Modify: `openbot/runner/src/index.ts:1245`（`handleFrame` 在 `screens.handle` 之后、`dispatch` 之前交给 `acp.handle`）、`index.ts:965-989`（每个连接创建 host 的发送端；host 本身跨连接存活）、`index.ts:1214`（`shutDown` 调 `acpHost.closeAll()`）
- Test: `openbot/runner/tests/acp-host.test.ts`、`openbot/runner/tests/acp-paths.test.ts`

**Interfaces:**
- Consumes: Task 3 `createAcpClient`、`ACP_MANIFEST`；runner 的 roots 表（`fld_` → 本机路径）与 apps 表（`app_` → `AppEntry`）。
- Produces:
  - `createAcpHost(deps: {roots: (ref: string) => string | null; apps: (ref: string) => AppEntry | null; spawn?: typeof createAcpClient; idleMs?: number; bufferLimit?: {count: number; bytes: number}}): AcpHost`
  - `AcpHost = { handle(frame: Record<string, unknown>): Promise<boolean>; attach(send: (frame: Record<string, unknown>) => void): void; detach(): void; closeAll(): Promise<void> }`
  - 帧（下行）：`acp.open {agentId, threadId, harness, workdirRef, appRef?, sessionHint?}`、`acp.prompt {threadId, turnId, content}`、`acp.cancel {threadId, turnId}`、`acp.permission.answer {requestId, optionId | null}`
  - 帧（上行）：`acp.turn.ack {turnId}`、`acp.update {threadId, turnId, seq, update}`、`acp.permission.request {threadId, turnId, requestId, toolCall, options, facts: {insideWorkdir: boolean | null; paths: string[]}}`、`acp.turn.end {threadId, turnId, stopReason, interrupted: boolean}`、`acp.session {threadId, sessionId, loaded: boolean}`
  - `classifyPath(workdir: string, candidate: string, platform: NodeJS.Platform): "inside" | "outside"`（`paths.ts`；realpath 后比较，win32 不分大小写）
  - `paths` 只用于判定，上行 `facts.paths` 只给相对工作文件夹的路径或文件名，不给绝对路径。

- [ ] **Step 1: 测试**（注入假 spawn）：
  - `test("acp.prompt acks, streams numbered updates and ends the turn")`：上行依次 `acp.turn.ack`、`acp.update` seq 1..n、`acp.turn.end`。
  - `test("updates sent while detached are replayed in order on attach")`。
  - `test("buffer over limit keeps the latest plan and each tool call's last state")`：`bufferLimit {count: 3}`。
  - `test("pending permission is re-sent after reattach with the same requestId")`。
  - `test("child dies mid-turn → acp.turn.end interrupted: true")`。
  - `test("idle adapter closes after idleMs and next open loads the session when supported")`：`acp.session.loaded === true`。
  - `test("unknown workdirRef or appRef answers an error and spawns nothing")`。
  - paths：`test("dot-dot and symlink resolve before comparing")`、`test("win32 compares case-insensitively")`。
- [ ] **Step 2: 跑测试确认失败。**
- [ ] **Step 3: 实现。** 一个员工一个进程，一个 threadId 一个 ACP 会话；同一线程的 prompt 串行，不同线程并行。
- [ ] **Step 4: 跑测试通过**；`bun test` 整个 runner 目录无回归。
- [ ] **Step 5: Commit** `feat(runner): ACP 会话宿主、断线缓存与重放`

## 期二：服务器

### Task 5: 设备帧路由与轮次存储

**Files:**
- Create: `openbot/server/src/agents/acp/turns.ts`、`openbot/server/src/agents/acp/relay.ts`
- Modify: `openbot/server/src/devices/socket.ts:107-142`（在 screen 帧之后、`result` 之前：`type` 以 `acp.` 开头交给 `relay.fromRunner`，同样要求 `channel.isAttached`）；`socket.ts` 的 heartbeat 分支 `channel.flush` 之后调 `relay.resumeQueued(target)`
- Test: `openbot/server/tests/acp-relay.test.ts`、`openbot/server/tests/acp-turns.integration.test.ts`

**Interfaces:**
- Consumes: Task 1 `acpTurns`；`DeviceChannel.notify`。
- Produces:
  - `createAcpTurnStore(database): AcpTurnStore`，`AcpTurnStore = { enqueue(t: {tenantId; agentId; threadId; deviceId; turnId; prompt: unknown}): Promise<void>; nextForThread(tenantId, threadId): Promise<AcpTurnRow | null>; queuedForDevice(tenantId, deviceId): Promise<AcpTurnRow[]>; setStatus(turnId, status, lastSeq?): Promise<void>; countQueued(tenantId, agentId): Promise<number> }`
  - `createAcpRelay(deps: {channel: DeviceChannel; turns: AcpTurnStore; startQueuedTurn: (row: AcpTurnRow) => Promise<void>}): AcpRelay`，`AcpRelay = { fromRunner(from: DispatchTarget, frame: Record<string, unknown>): void; subscribe(turnId: string, listener: (frame: Record<string, unknown>) => void): () => void; send(target: DispatchTarget, frame: Record<string, unknown>): boolean; resumeQueued(target: DispatchTarget): Promise<number> }`
  - 归属规则：`fromRunner` 只接受 `turnId` 属于该 `tenantId + deviceId` 的帧，其余丢弃并记日志；`acp.update` 的 `seq` ≤ 已见过的丢弃。

- [ ] **Step 1: 测试**：
  - `test("a frame for another tenant's turn is dropped")`、`test("duplicate and stale seq are dropped, gaps are passed in order")`、`test("resumeQueued starts queued turns per thread in creation order, one at a time per thread")`、`test("two threads on one device run in parallel")`、`test("an unknown acp.* type does not reach the 'Nothing handles' error path")`。
- [ ] **Step 2–4: 失败 → 实现 → 通过**（`bun test tests/acp-relay.test.ts tests/acp-turns.integration.test.ts tests/devices.test.ts`）。
- [ ] **Step 5: Commit** `feat(server): ACP 帧路由与按线程排队的轮次`

### Task 6: `device_acp` 的运行传输

**Files:**
- Create: `openbot/server/src/agents/acp/agent.ts`、`openbot/server/src/agents/acp/translate.ts`、`openbot/server/src/agents/acp/context.ts`
- Modify: `openbot/server/src/copilot.ts`：`registeredAgentFromRow`（612）认 `device_acp`；`buildAgent`（1868 附近）对 `device_acp` 返回 `DeviceAcpAgent`；`onOpenBotRunner`（438）、`runByThisDeployment`（456）、`answersOwnRunsHere`（476）补 `device_acp` 分支（由本部署运行，不是外部 HTTP）；`openbot/server/src/agents/runtime-agents.ts:45`（不为 `device_acp` 解析 headers）
- Modify: `openbot/server/src/index.ts`：用 `queued-results.ts` 同款「往线程里投一轮」的接线实现 Task 5 的 `startQueuedTurn`
- Test: `openbot/server/tests/acp-translate.test.ts`、`openbot/server/tests/acp-agent.test.ts`

**Interfaces:**
- Consumes: Task 5 `AcpRelay`、`AcpTurnStore`；`AbstractAgent`、`EventType`。
- Produces:
  - `class DeviceAcpAgent extends AbstractAgent`，构造 `{agentId; ownerUserId; tenantId; deviceId; harness; workdirRef; appRef?; relay: AcpRelay; turns: AcpTurnStore; reachable: () => boolean; context: (threadId: string) => Promise<unknown[]>}`；`run(input)`：可达 → `acp.open`（必要时）+ `acp.prompt`，把上行帧经 `translate` 变成 AG-UI 事件，`acp.turn.end` 时 `RUN_FINISHED`；不可达 → 入队，输出一条文本「<名字>的电脑现在离线，这件活已排队，电脑回来后自动继续。」并结束。
  - `translateUpdate(update: unknown): BaseEvent[]`：`agent_message_chunk` → TEXT_MESSAGE_*；`tool_call` / `tool_call_update` → TOOL_CALL_START/ARGS/RESULT（工具名 `acp/<kind>`）；`plan` → `CUSTOM { name: "acp.plan", value: entries }`；`edit` 类内容里的 diff 汇总为 `CUSTOM { name: "acp.diff", value: {files: {path; added; removed}[]} }`。
  - `buildFirstTurnContext(input: {persona: string; recent: {role: string; text: string}[]; taskCard: string | null}): unknown[]`：最近消息截到 20 条。
  - 中断：`acp.turn.end interrupted` → 文本「电脑关机，这件活中断了。」+ `CUSTOM { name: "acp.interrupted", value: {turnId, prompt} }`。
  - 等待期间每 20 秒发一次 `CUSTOM { name: "acp.waiting" }`，让 stall guard 视为活动。

- [ ] **Step 1: 测试**：
  - translate：`test("message chunks become one text message")`、`test("tool_call kinds map to acp/<kind> tool calls with results")`、`test("edit diffs are summarised per file with added/removed counts")`。
  - agent（假 relay）：`test("reachable run streams to RUN_FINISHED and the board card closes with the diff deliverable")`、`test("unreachable run queues the turn and answers the queued sentence")`、`test("a run awaiting permission for 3 simulated hours is not ended by the stall guard")`（假时钟）、`test("first turn of a new session carries persona, last 20 messages and the task card")`、`test("interrupted turn emits acp.interrupted with the original prompt")`。
- [ ] **Step 2–4: 失败 → 实现 → 通过**；`bun test tests/acp-*.test.ts`；`bunx tsc --noEmit -p server`。
- [ ] **Step 5: Commit** `feat(server): 外部员工的运行传输与事件翻译`

### Task 7: 许可桥：规则、底线、审批、回答

**Files:**
- Create: `openbot/server/src/agents/acp/permissions.ts`
- Modify: `openbot/server/src/approvals/service.ts`：新增 `onDecided(listener: (record: ApprovalRecord, decision: ApprovalDecision) => void): () => void`，在 `decide`（738）落库后同步通知；`decide` 对 `toolRef` 以 `acp/` 开头的记录要求 `ownerUserId` 等于外部员工的招聘人（否则抛与现有越权相同的错误 → 403）
- Test: `openbot/server/tests/acp-permissions.test.ts`、`openbot/server/tests/acp-permissions.integration.test.ts`

**Interfaces:**
- Consumes: `decideAction`（policy.ts:1826）、`onceOnlyFloor`、`safetyRequirement`、`dangerousCommand`、`ApprovalStore.open`、Task 5 relay、Task 6 agent。
- Produces:
  - （`AcpRuleKey` 来自 `shared/acp.ts`）
  - `classifyRequest(req: {kind: string; title: string; rawInput: unknown; facts: {insideWorkdir: boolean | null}}): {rules: AcpRuleKey[]; candidate: ApprovalCandidate}`：`toolRef` = `acp/<kind>`；`execute` 的命令放进 `args.command` 并按 `computer_run_command` 同样的形状交给危险命令与敏感路径判定；`delete` 置 `destructive: true`。
  - `resolvePermission(input: {request; employeeRules: Record<AcpRuleKey, string>; threadAllows: Set<string>; policy: (c: ApprovalCandidate) => Promise<ApprovalPolicyOutcome>}): Promise<{kind: "allow"} | {kind: "deny"; reason: string} | {kind: "ask"; offerConversation: boolean}>`：顺序按规格「和现有审批层的关系」1→5；多条规则取最严；`facts.insideWorkdir === null` 视为在外。
  - `createAcpPermissionBridge(deps): { onRequest(from: DispatchTarget, frame): Promise<void>; dispose(): void }`：`ask` → `ApprovalStore.open`（审批记录带：员工、电脑名、一句话动作、命令或路径原文、命中的规则或底线、本轮摘要、改动文件）；按 `requestId` 去重；决定后映射 ACP optionId 经 relay 回设备；「这次对话里都允许」写入本线程放行集合。
  - 群组：许可卡只有招聘人可批（服务端由上面的 `decide` 校验保证）。

- [ ] **Step 1: 测试**：
  - 规则：每个 `AcpRuleKey` 的 direct/ask 两种取值各一例；`test("several rules matched → the strictest wins")`；`test("delete always asks and never offers conversation-wide allow")`；`test("payment/outbound/credentials floors ask and never offer conversation-wide allow")`；`test("admin deny / SEC1 disabled / custom deny auto-reject with the rule named")`；`test("approvals switched off turns rule-level ask into allow but keeps floors")`；`test("insideWorkdir null is treated as outside")`。
  - 集成：`test("same requestId reported twice opens one approval")`（Review Focus 1）；`test("a group member who is not the hirer gets 403 deciding")`（Review Focus 4）；`test("allow_conversation answers allow_always and auto-allows the next same-kind request in the thread")`；`test("deny answers reject_once")`。
- [ ] **Step 2–4: 失败 → 实现 → 通过**；含 `bun test tests/approvals-policy.test.ts` 无回归。
- [ ] **Step 5: Commit** `feat(server): 外部员工许可桥（规则、底线、审批、回答）`

### Task 8: 招聘与配置接口

**Files:**
- Create: `openbot/server/src/agents/acp/routes.ts`（挂在 `/api/agents/external`）
- Modify: `openbot/server/src/channels/group.ts:1633,1654`（`addBots` / `removeBots`：成员里有 `device_acp` 员工时，只有它的招聘人能加或移出，群主也不行）
- Modify: `openbot/server/src/agents/profile-store.ts:1050`（`create` 接受 `{external: {...}}` 分支产出 `device_acp`）、`profile-store.ts:1146`（`update` 只允许招聘人改 external 配置）、`openbot/server/src/devices/routes.ts`（`GET /api/devices/:deviceId/agents` → 非持久 `dispatch("agents.discover")`）、例行任务/职责/主动工作的创建接口对 `device_acp` 返回 409
- Test: `openbot/server/tests/acp-hire.integration.test.ts`

**Interfaces:**
- Produces:
  - `POST /api/agents/external` 请求体 `{deviceId; harness: AcpHarness; name; department?; workdirRef; appRef?; rules: Record<AcpRuleKey,string>; acknowledgeNoPermission?: boolean}` → `201 {agent}`；规则：设备 `pairedByUserId` ≠ 本人 → 403「只能在你自己配对的电脑上招」；`workdirRef` / `appRef` 不在该设备最近一次心跳上报里 → 400；`harness: "custom"` 且没有 `acknowledgeNoPermission: true` → 400（Review Focus 5）；名额满 → 402（`quota.assertCapacityWithin(..., "wakers")`）；`visibility` 固定 private、`ownerUserId` = 本人。
  - `PATCH /api/agents/external/:agentId` 同字段可改（不含 `harness`）；非招聘人 403。
  - `GET /api/devices/:deviceId/agents` → `{online: boolean; agents: [...]}`；离线 → `{online: false, agents: []}`。

- [ ] **Step 1: 测试**：上述每条规则各一例 + `test("created employee is private, owned by the hirer and counted against wakers")` + `test("routines cannot be created for a device_acp employee")` + `test("only the hirer can add or remove an external employee in a group, even if someone else created the group")`。
- [ ] **Step 2–4: 失败 → 实现 → 通过。**
- [ ] **Step 5: Commit** `feat(server): 招聘外部员工与发现接口`

### Task 9: 状态：离线与排队数

**Files:**
- Modify: `openbot/server/src/agents/presence.ts`（`AgentPresenceStatus` 加 `"offline"`；`AgentPresence` 加 `queued?: number`）、`openbot/app/src/lib/agents/presence.ts`（同步类型）、`openbot/app/src/components/agents/status-dot.tsx`（`offline` 用 `--wb-paused` 灰，标题「离线」）
- Test: `openbot/server/tests/agent-presence.integration.test.ts`（加用例）、`openbot/app/tests/workbench-presence.test.tsx`（加用例）

**Interfaces:**
- Produces: `device_acp` 员工：设备不可达 → `{status: "offline", doing: null, queued: n}`；可达时沿用现有忙碌/空闲/暂停计算。

- [ ] **Step 1: 测试** `test("an external employee whose computer is away is offline with its queued count")`；前端 `test("offline dot is gray and reads 离线 · 2 件排队中")`。
- [ ] **Step 2–4: 失败 → 实现 → 通过。**
- [ ] **Step 5: Commit** `feat: 外部员工的离线状态与排队数`

**期二收尾：** 用 Task 3 的假 ACP 智能体写一条服务器端到端测试 `openbot/server/tests/acp-e2e.integration.test.ts`：招聘 → 发一轮 → 请求推送 → 招聘人批准 → 设备收到 `allow_once` → 轮次结束、看板卡关闭带改动交付物；电脑断开 → 新轮次排队 → 重连 → 自动继续。通过后开期二 PR。

## 期三：界面

### Task 10: 招人：页签、发现、招聘设置

**Files:**
- Modify: `openbot/app/src/components/bots/bots-page.tsx:91`（顶部 `SegmentedTabs`：人才市场 / 从我的电脑招 / 云端（下一步）；`search.source` = `market` | `computer` | `cloud`）、`openbot/app/src/components/wakers/wakers-search.ts`（加 `source`）
- Create: `openbot/app/src/components/agents/external/hire-from-computer.tsx`、`openbot/app/src/components/agents/external/hire-settings.tsx`、`openbot/app/src/lib/agents/external.ts`（查询与变更）
- Test: `openbot/app/tests/external-hire.test.tsx`

**Interfaces:**
- Consumes: Task 8 接口；设备列表（现有 `/api/devices`）。
- Produces: `HireFromComputer({deviceId?})`、`HireSettings({deviceId, harness, onHired: (agentId: string) => void})`；文案与设计稿第 1、2 屏一致，底线文案按 Global Constraints。

- [ ] **Step 1: 测试**：`test("lists installed agents with 已安装/已登录/登录状态未知 tags")`、`test("not-installed agents show 怎么安装 links")`、`test("offline device shows 电脑离线 and no hire buttons")`、`test("device not paired by me shows 这台电脑还没认主人…")`、`test("workdir picker lists only the device's shared folders")`、`test("custom agent requires the second confirmation checkbox")`、`test("hire posts rules with the spec defaults")`、`test("cloud tab is informational and has no hire button")`。
- [ ] **Step 2–4: 失败 → 实现 → 通过**（`cd openbot/app && bun test tests/external-hire.test.tsx`）。
- [ ] **Step 5: Commit** `feat(app): 从我的电脑招员工`

### Task 11: 外部员工的标记、名片、顶栏、离线条

**Files:**
- Modify: `openbot/app/src/skins/xiongbao/contacts.tsx`（员工卡标记）、`openbot/app/src/skins/xiongbao/employee-card.tsx:340`（标记、在哪台电脑、无许可警示、配置入口跳 HireSettings 编辑态）、`openbot/app/src/components/channels/conversation-header-card.tsx:32`（副标题「状态 · 此刻 · 在 <电脑名> 上」）、`openbot/app/src/routes/_authed/_app/channel/$channelId.tsx:297-324`（「看它的屏幕」按钮，打开现有实时画面）、`openbot/app/src/skins/xiongbao/message-list.tsx`（顶部离线提示条）、`openbot/app/src/components/bot-profile/setup.tsx:478`（「运行方式」显示外部员工信息）
- Test: `openbot/app/tests/external-marks.test.tsx`

- [ ] **Step 1: 测试**：`test("contacts card shows 外部员工 · Codex")`、`test("header subtitle reads 忙碌 · <此刻> · 在 何总的 MacBook Pro 上")`、`test("看它的屏幕 opens the device screen viewer")`、`test("custom agent card shows the no-permission warning")`、`test("message list shows the offline banner with the queued count when any external employee is offline")`、`test("routine/duty entries are hidden for an external employee")`。
- [ ] **Step 2–4: 失败 → 实现 → 通过。**
- [ ] **Step 5: Commit** `feat(app): 外部员工的标记、名片、顶栏与离线提示`

### Task 12: 对话卡片与手机审批页

**Files:**
- Create: `openbot/app/src/components/channels/acp-cards.tsx`（进度卡 `acp.plan`、改动卡 `acp.diff`、中断卡 `acp.interrupted`）
- Modify: `openbot/app/src/components/approvals/inline-approval.tsx:82`（`acp/` 审批：命令原文、说明、批准 / 拒绝 / 这次对话里都允许；`offerConversation` 为假时不显示第三个；非招聘人显示「等 <招聘人> 确认」且无按钮；底部「已同时推到你的手机」）、`openbot/app/src/components/channels/chat-transcript.tsx`（渲染上述 CUSTOM 事件）、审批详情的手机布局（`routes/_authed/_app/approvals.tsx` 详情视图：设计稿第 5 屏）
- Test: `openbot/app/tests/acp-cards.test.tsx`

- [ ] **Step 1: 测试**：`test("plan card ticks done steps and dots the running one")`、`test("diff card lists files with +/- and expands")`、`test("permission card offers three choices, two when offerConversation is false")`、`test("non-hirer sees 等 X 确认 and no buttons")`、`test("interrupted card re-sends the original prompt as a new turn on 重新派")`、`test("phone approval page has a fixed bottom 批准 button at 390px")`。
- [ ] **Step 2–4: 失败 → 实现 → 通过**；app 全量 `bun test`、`bunx tsc --noEmit`、biome 干净。
- [ ] **Step 5: Commit** `feat(app): 外部员工的进度、改动、许可与中断卡片`

**期三收尾（截图关口）：** 用 `scratchpad/wb-shots/` 的启动脚本 + 假 ACP 智能体（以「已配对的假设备」跑 runner），拍暗色截图：从电脑招、招聘设置、对话里的进度卡与许可卡、离线条、名片、390px 手机审批页。发截图页给用户，确认后开期三 PR。

## 期四：真机

### Task 13: 设备端发版与真机验收

**Files:**
- Modify: `openbot/desktop-device` 版本号与发布说明；`docs/acceptance/STORIES.md`（新增「外部员工」故事与验收记录）

- [ ] **Step 1:** 合入期一至期三后准备设备端发版 PR（版本号、发布说明）。
- [ ] **Step 2:** 请用户推设备端标签；盯发布流水线。
- [ ] **Step 3:** 给用户一份真机验收清单：Windows 与 macOS 各一台，分别招 Codex、Claude Code，各完成「改代码 → 跑测试 → 请求推送 → 手机网页批准 → 推送成功」；断网再恢复，排队的活继续。
- [ ] **Step 4:** 按用户回报更新 `STORIES.md`；问题另开修复任务。
