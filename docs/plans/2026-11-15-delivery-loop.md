# 交付闭环 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「派出 → 已接下 → 已交成果 → 你验收」做成产品机制：一件活一张卡、服务器证据门、只追加的流水、服务器到期核对与催办、开工 / 收工清点、外部员工同一套规约，以及看板 / 对话 / 手机的界面。

**Architecture:** `tasks` 加在跟相关列和 `cancelled` 状态，新表 `task_events` 只追加；所有对在跟卡的写入集中在新模块 `tasks/delivery.ts`（三个员工工具、证据门、退回 / 取消 / 延期、把后续轮次挂到原卡）。新后台循环 `tasks/delivery-checker.ts` 每分钟按租户核对、用专门的「催办轮次」催员工、按作息和上限通知；清点由 `tasks/briefing.ts` 生成，走现有投递（推送新种类 `briefing` / `overdue`、Slack / Teams / 短信）。前端改看板、卡片详情、对话卡片、作息设置、手机清点页，原生 App 加深链。

**Tech Stack:** Bun、TypeScript、Drizzle + Postgres（RLS）、Hono、`@ag-ui/client`、React + TanStack Router/Query、Expo（`openbot/mobile`）、bun:test + happy-dom。

**Spec:** `docs/specs/2026-11-15-delivery-loop.md`（用户 2026-11-15「通过」）。设计稿：https://claude.ai/artifact/RVcerNZLZcgPsKuzayCvKv

## 分期与关口

| 期 | 任务 | 关口 |
|---|---|---|
| 一 服务器 | 1–4 | 测试全绿即推（无界面） |
| 二 服务器 | 5–7 | 测试全绿即推；Task 7 等外部员工第二期合入 main 后做 |
| 三 界面 | 8–11 | 暗色真实系统截图（桌面 + 390px 手机）给用户确认后推；App 发版由用户推标签 |

排在对话侧栏服务器期之后开工（Task 4 依赖侧栏服务器期合入）；与外部员工第二期并行时，`channels/group.ts`、`threads/postgres-runner.ts`、`tasks/projector.ts` 可能冲突：每个任务开工前先 rebase 到最新 main。迁移编号用当时 main 上的下一个空号（写作 `NNNN`）。

## Global Constraints

- 进三步的只有三种：员工调 `accept_task`、用户点「当作一件活来跟」（`POST /api/tasks/:id/track`）、外部员工排队的活。例行、职责、主动调研、自动化、员工互相 @ 的转交、群组流水线都不自动进。
- 一件活一张卡：某线程里某员工有未结束的在跟卡时，该线程该员工的后续轮次（追问、催办、退回后续跑）挂到这张卡，不另开卡、不另扣月度任务配额；同线程再次 `accept_task` 开新在跟卡，后续轮次挂到最新接下的那张。
- 只有用户验收（含在跟卡上的归档）或取消才结束一件活；在跟卡上一轮出错不结束，记 `last_error`；`failed` 只用于不在跟的卡。重启回收、流水线回收跳过在跟卡。
- 核对时间：待接下 5 分钟催员工、再 30 分钟通知用户；到期 5 分钟（`due_at + 5min`）催员工、`due_at + 35min` 记逾期并通知；之后每 2 小时最多一次；同一件活每天（按用户时区）最多通知用户 3 次；没报预计时间按接下后 2 小时核对；员工轮次在跑时跳过。
- 作息默认：开工 09:00、收工 18:00、周末不发；作息外不推送，提醒并进下一次开工清点；没有在跟的卡不发清点。
- 催办轮次：以系统身份在本卡挂的线程开一轮，挂在本卡；不推送、不占员工唤醒额度（每天 20 / 同时 5）、不扣任务配额；模型用量照常计量。
- 证据门：至少一项交付物且真实存在、属于本租户和本卡；只有 `note` 时 `checks` ≥ 1；`criteria` 写了「必需：A、B、C」时逐一被 `items` 标题或 `checks` 提到；交付后 `PATCH` 改预计时间 / 标准被拒，退回后可改。
- `original_due_at` 永远是员工第一次报的；用户改或准许延期只改 `due_at`。
- 权限：验收、退回、取消、延期、改标准、换人、再催只有卡片所在租户的人（派活的人）能做；群主不能代验收。所有读写在租户帧里。
- `task_events` 只追加：迁移里对应用角色 `REVOKE UPDATE, DELETE, TRUNCATE`（`0054_app_role.sql` 默认授予，先例 `0134_waker_flow_versions.sql:57-59`）。
- `DeliverableRef` 保持 `kind: "deliverable"`，只加 `links`、`diffs`、`notes`、`checks`。
- 四条规约原文（人设说明、外部员工提示前缀都用这段）：
  `【熊宝交付规约】1 接活先回：已接下 + 预计几点交　2 做完再交：交付物 + 你怎么查过的　3 交不了就说：缺什么、要延到几点　4 没被验收前，不要说「做完了」`
- 文案中文；沿用 `--wb-*` 令牌；只作用于默认皮肤。

## Review Focus

1. 用户在在跟卡的线程里聊了一件无关的事（员工没调 `accept_task`）：这轮挂到原卡记一行进度，不把原卡推进、不开新卡、不触发交付。→ Task 2 测试。
2. 员工在同一轮里先 `accept_task` 再 `deliver_task`（快活一轮做完）：卡直接进「已交成果」，流水两行，催办不会再来。→ Task 3 测试。
3. 用户时区跨日（例如 UTC+8 的 00:30）：「每天最多 3 次」按用户时区的日界重置，不按 UTC。→ Task 5 测试。
4. 换人接手时原员工的轮次正在跑：原轮次被停下，迟到的 `deliver_task` 不能把卡推进（卡的执行人已换）。→ Task 5 测试。
5. 两个副本同时扫到同一张逾期卡：只催一次、只通知一次、流水只一行。→ Task 5 测试。

---

## 期一：服务器

### Task 1: 数据结构、流水与交付物格式

**Files:**
- Create: `openbot/server/recovery/recovery-20261018-v1/sql/NNNN_delivery_loop.sql`（+ journal 追加）
- Create: `openbot/server/src/db/schema/task-events.ts`（schema 索引导出）、`openbot/server/src/tasks/events.ts`
- Modify: `openbot/server/src/db/schema/tasks.ts`（新列、`cancelled`、改写第 40–46 行「执行路径从不读」的注释为「不在跟的卡执行路径不读；在跟的卡由 `tasks/delivery.ts` 读写」）、`openbot/server/src/tasks/projector.ts:131-164`（`DeliverableRef` 加四个可选数组，`isDeliverableRef` 接受新旧两种）
- Test: `openbot/server/tests/delivery-schema.integration.test.ts`、`openbot/server/tests/task-deliverable.test.ts`（加用例）

**Interfaces:**
- Produces:
  - `tasks` 列：`tracked boolean not null default false`、`thread_ref text`、`accepted_at`、`due_at`、`original_due_at`、`overdue_at`（timestamptz null）、`due_reported boolean not null default false`、`criteria text`、`last_error text`、`nudges integer not null default 0`、`returns integer not null default 0`；`task_status` 加 `cancelled`；索引 `tasks (tenant_id, tracked, status, due_at)`、`tasks (tenant_id, thread_ref, executor_agent_id) where tracked`。
  - 表 `task_events(id uuid, tenant_id, task_id uuid not null, kind text not null, actor text not null, detail jsonb not null default '{}', created_at)`，RLS 按租户，索引 `(tenant_id, task_id, created_at)`。
  - `type TaskEventKind = "dispatched"|"accepted"|"progress"|"extension_requested"|"extension_granted"|"extension_denied"|"bounced"|"delivered"|"run_ended"|"run_failed"|"nudged"|"nudge_skipped"|"overdue"|"notified"|"reviewed"|"returned"|"cancelled"|"reassigned"|"edited"`
  - `appendTaskEvent(db, {tenantId, taskId, kind, actor: \`user:${string}\`|\`agent:${string}\`|"system", detail?}): Promise<void>`；`listTaskEvents(db, {tenantId, taskId}): Promise<TaskEvent[]>`（按 `created_at` 正序）。
  - `DeliverableRef = {kind: "deliverable"; components?; attachments?; links?: {url, title}[]; diffs?: {files: number; added: number; removed: number; ref: string}[]; notes?: string[]; checks?: string[]}`。

- [ ] **Step 1: 测试**：`test("task_events rejects UPDATE and DELETE for the app role")`（以应用角色连接执行 UPDATE / DELETE 抛权限错误）；`test("task_events rows are tenant-isolated")`；`test("cancelled is a valid task_status")`；`test("isDeliverableRef accepts links, diffs, notes and checks and still accepts the old shape")`；`test("board deliverable label renders for a ref with only links")`。
- [ ] **Step 2: 跑测试确认失败**：`cd openbot/server && bun test tests/delivery-schema.integration.test.ts tests/task-deliverable.test.ts` → FAIL。
- [ ] **Step 3: 实现**迁移、schema、`events.ts`、`DeliverableRef` 扩展。
- [ ] **Step 4: 跑测试确认通过**，再跑 `bun test tests/task-card-reclaim.test.ts tests/task-card-run-error.test.ts` 与 `bunx tsc --noEmit -p .` 无回归。
- [ ] **Step 5: Commit** `feat(server): 交付闭环的数据结构与只追加流水`

### Task 2: 一件活一张卡

**Files:**
- Create: `openbot/server/src/tasks/delivery.ts`
- Modify: `openbot/server/src/threads/postgres-runner.ts:400, 509-573`（开卡前查在跟卡，有则抑制开卡并把本轮挂上；收尾交给 `delivery.runEnded`）、`openbot/server/src/channels/group.ts:1238-1252`（群线程同样处理）、`openbot/server/src/tasks/projector.ts:431-444`（`finished()` 跳过在跟卡）、`openbot/server/src/tasks/reclaim.ts:57-71` 与 `projector.ts:562-590`（回收跳过在跟卡）、`openbot/server/src/pipeline/reap.ts:109-118`（跳过在跟卡）、`openbot/server/src/tasks/routes.ts:525-539`（在跟卡归档 = 验收）
- Test: `openbot/server/tests/delivery-one-card.integration.test.ts`

**Interfaces:**
- Consumes: Task 1 的列与 `appendTaskEvent`。
- Produces（`tasks/delivery.ts`）：
  - `openTrackedCard(tenantId, threadRef, agentId): Promise<{id: string} | null>` —— 本线程本员工最新接下（`accepted_at` 最大，未接下的按 `created_at`）且未结束的在跟卡。
  - `attachRun(tenantId, taskId, runId): Promise<void>` —— 本轮挂到卡（写 `progress` 由 `runEnded` 补）。
  - `runEnded(tenantId, taskId, {runId, failed: boolean, error?: string, firstSentence?: string}): Promise<void>` —— 不改状态；失败记 `last_error` + `run_failed`，成功清 `last_error` + `run_ended`；有首句则记一条 `progress`（截 60 字）。
  - `markTracked(tenantId, taskId, actor): Promise<void>` —— 置 `tracked = true`、`thread_ref`，流水 `dispatched`。

- [ ] **Step 1: 测试**：`test("follow-up, nudge-like and return-like turns on a tracked card's thread add no new card and charge quota once")`（同线程三轮后该员工该线程只有 1 张卡，配额计数 +1）；`test("an unrelated turn on a tracked thread logs one progress line and does not advance the card")`（Review Focus 1）；`test("a second accept on the same thread opens a new tracked card and later turns attach to it")`（用 `markTracked` + 设 `accepted_at` 模拟，工具在 Task 3）；`test("a failed run keeps the tracked card running with last_error and a run_failed event")`；`test("reclaimAbandoned and pipeline reap skip tracked cards")`；`test("archiving a tracked awaiting_review card reviews it and logs reviewed")`；`test("untracked cards keep one card per turn")`；`test("group: tracked card lives on the viewer×employee group thread, other group messages do not attach")`。
- [ ] **Step 2: 确认失败**：`bun test tests/delivery-one-card.integration.test.ts` → FAIL。
- [ ] **Step 3: 实现** `delivery.ts` 上述函数，并接入 runner、群聊、`finished()`、回收、归档。
- [ ] **Step 4: 通过**，再跑 `bun test tests/task-card-reclaim.test.ts tests/task-card-run-error.test.ts tests/tasks-approval-decision.integration.test.ts` 及群聊套件、tsc。
- [ ] **Step 5: Commit** `feat(server): 在跟的活一件一张卡`

### Task 3: 员工的三个工具与证据门

**Files:**
- Create: `openbot/server/src/tasks/delivery-tools.ts`、`openbot/server/src/tasks/evidence-gate.ts`、`openbot/server/src/tasks/due-time.ts`
- Modify: `openbot/server/src/index.ts:2612-2622`（`loadGrantedToolsForActor` 加入三个工具；关掉 `accept_task` 即不走三步）、内置员工人设组装处（加四条规约说明与「普通问答不要用」）
- Test: `openbot/server/tests/delivery-tools.integration.test.ts`、`openbot/server/tests/due-time.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `openTrackedCard`、`markTracked`；`currentModelRun()`（`models/token-metering.ts:59`）取 `runId`、`threadId`。
- Produces:
  - 工具 ref：`accept_task`、`deliver_task`、`request_extension`，参数同规格第 4 节。
  - `parseDueTime(text: string, now: Date, timeZone: string): Date | null`（支持「40 分钟」「2 小时」「15:00」「下午三点」「明早 10 点」）。
  - `checkEvidence(input: {tenantId; taskId; threadRef; items; checks; criteria}): Promise<{ok: true; ref: DeliverableRef} | {ok: false; reason: string; missing?: string[]}>`。
  - `delivery.requestExtension(tenantId, taskId, {dueAt, reason})`；对话里的卡片事件：`CUSTOM delivery.accepted {taskId, dueAt, criteria}`、`CUSTOM delivery.extension_requested {taskId, dueAt, reason}`、`CUSTOM delivery.delivered {taskId, deliverable}`、`CUSTOM delivery.bounced {taskId, reason}`（前端 Task 9 渲染）。

- [ ] **Step 1: 测试**：
  - `test("accept_task marks the card tracked, sets accepted_at, due_at = original_due_at, criteria, and emits delivery.accepted")`；
  - `test("accept_task without due_at sets due_reported false")`；
  - `test("accept then deliver in one run lands in awaiting_review with two events")`（Review Focus 2）；
  - 证据门：`test("no items → bounced")`、`test("attachment from another thread → bounced")`、`test("component not drawn on this card → bounced")`、`test("note only without checks → bounced")`、`test("criteria 必需：A、B、C with C missing → bounced naming C")`、`test("all good → awaiting_review and deliverable merged into deliverableRef")`；
  - `test("a bounce leaves the card unchanged and returns the reason to the employee")`；
  - `test("request_extension does not change due_at")`；
  - `test("disabled accept_task tool is not offered")`；
  - `parseDueTime` 各格式按 `Asia/Shanghai` 换算的表驱动用例，无法解析返回 null。
- [ ] **Step 2: 确认失败**：`bun test tests/delivery-tools.integration.test.ts tests/due-time.test.ts` → FAIL。
- [ ] **Step 3: 实现**三个工具、证据门、时间解析、人设说明。
- [ ] **Step 4: 通过** + tsc。
- [ ] **Step 5: Commit** `feat(server): 接活、交付、延期三个工具与证据门`

### Task 4: 卡片接口与侧栏配套

**Files:**
- Modify: `openbot/server/src/tasks/routes.ts`（新接口与列表新字段、`?overdue=1`）、`openbot/server/src/tasks/delivery.ts`（`returnTask`、`cancelTask`、`decideExtension`、`editTask`、`trackTask`）、侧栏（侧栏服务器期合入后）：`openbot/shared/conversation-sidebar.ts`（`SidebarGoalStatus` 加 `cancelled`，`SidebarGoal` 加 `stage`、`dueAt`、`overdue`、`returns`）、`openbot/server/src/threads/sidebar.ts`（`STATUS_WORDS` 加 `cancelled`；`goalOf` 优先取未结束在跟卡；「上次检查」取最近一条流水）
- Test: `openbot/server/tests/delivery-routes.integration.test.ts`、侧栏集成测试加用例

**Interfaces:**
- Consumes: Task 1–3。
- Produces:
  - `GET /api/tasks/:id`、`GET /api/tasks/:id/events`、`POST /api/tasks/:id/return {reason}`、`POST /api/tasks/:id/cancel`、`POST /api/tasks/:id/extension {decision, dueAt?}`、`PATCH /api/tasks/:id {dueAt?, criteria?}`、`POST /api/tasks/:id/track`；列表项新字段 `tracked, threadRef, acceptedAt, dueAt, originalDueAt, dueReported, criteria, overdueAt, lastError, nudges, returns`。
  - `stage = tracked ? (status==="done" ? "reviewed" : status==="awaiting_review" ? "delivered" : acceptedAt ? "accepted" : "pending_accept") : null`。
  - 退回以用户名义发消息开一轮：`sendAsUser(tenantId, threadRef, agentId, text)`（参照 `channels/dispatch.ts`；群线程从 `thread_ref` 取，不用频道 id）。

- [ ] **Step 1: 测试**：`test("return moves awaiting_review to running, returns+1, posts the reason as the user's message and starts a turn")`；`test("cancel stops a running turn and marks cancelled")`；`test("extension grant changes due_at, keeps original_due_at; deny keeps both")`；`test("PATCH after delivery is rejected; after a return it is allowed")`；`test("PATCH by the user changes due_at but not original_due_at")`；`test("track on an untracked card enters pending_accept and the next turn is asked for a receipt")`；`test("track is refused when the employee's accept_task is disabled")`；`test("another tenant gets 404 on every endpoint, including a group owner on a member's card")`；`test("overdue=1 lists only cards with overdue_at")`；侧栏：`test("sidebar goal prefers the open tracked card and reports stage")`。
- [ ] **Step 2: 确认失败** → FAIL。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 通过**，跑看板、侧栏、群聊套件与 tsc。
- [ ] **Step 5: Commit** `feat(server): 交付闭环的卡片接口`

## 期二：服务器

### Task 5: 交付核对器与换人接手

**Files:**
- Create: `openbot/server/src/tasks/delivery-checker.ts`、`openbot/server/src/tasks/nudge-run.ts`
- Modify: `openbot/server/src/index.ts:4100-4118` 附近（照 `repeatAfterEach` 挂循环）、`openbot/server/src/tasks/routes.ts`（`POST /api/tasks/:id/reassign {agentId}`、`POST /api/tasks/:id/nudge`）
- Test: `openbot/server/tests/delivery-checker.integration.test.ts`

**Interfaces:**
- Consumes: Task 1–4；作息读取 `readWorkHours(userId): Promise<WorkHours>`（Task 6 产出；本任务先用默认值实现，Task 6 接上）。
- Produces:
  - `runDeliveryCheck(deps, now: Date): Promise<void>`（一次扫描，测试直接调用）；`deps.notify(tenantId, {kind: "overdue"|"pending_accept", taskId, text}): Promise<"sent"|"deferred"|"capped">`。
  - `startNudgeRun(tenantId, taskId, text): Promise<"started"|"skipped_running">`（系统身份，挂本卡，不推送、不占唤醒额度、不扣配额）。
  - `reassignTask(tenantId, taskId, agentId, actor)`。

- [ ] **Step 1: 测试**（注入时钟）：`test("pending accept: nudge at 5 min, notify at 35 min")`；`test("accepted: nudge at due+5, overdue_at and notify at due+35, overdue_at kept after delivery")`；`test("reminders at most every 2 hours and 3 notifications per day")`；`test("the daily cap resets at the user's local midnight, not UTC")`（Review Focus 3，`Asia/Shanghai`）；`test("no due reported → checked at accepted_at + 2h")`；`test("outside work hours: not pushed, kept for the next start briefing")`；`test("a running turn is skipped, no event written")`；`test("nudge run attaches to the card, opens no card, does not push, does not touch wake-up quota or task quota")`；`test("two concurrent checks nudge and notify once")`（Review Focus 5）；`test("reassign stops the old turn, swaps executor and thread, back to pending_accept, keeps original_due_at")`；`test("a late deliver_task from the old employee after reassign is refused")`（Review Focus 4）。
- [ ] **Step 2: 确认失败** → FAIL。
- [ ] **Step 3: 实现**核对器、催办轮次、换人与再催接口。
- [ ] **Step 4: 通过** + 唤醒相关套件、tsc。
- [ ] **Step 5: Commit** `feat(server): 交付核对器、催办与换人接手`

### Task 6: 作息、清点与通知出口

**Files:**
- Create: `openbot/server/src/tasks/briefing.ts`
- Modify: `openbot/server/src/user-preferences.ts`（`workHours: {start: "HH:MM"; end: "HH:MM"; timeZone: string; weekends: boolean}`，默认 `09:00 / 18:00 / 浏览器写入 / false`）、`openbot/server/src/user-preferences-routes.ts`、`openbot/server/src/delivery/types.ts:52`（`DeliveryKind` 加 `briefing`、`overdue`；范围允许不绑定对话，照 `attention`）、`openbot/server/src/delivery/push.ts:14-31`（两种新跳转：`/briefing`、`/tasks/:id`）、投递路由（Slack / Teams / 短信同样发送，遵守作息与上限）、`openbot/server/src/tasks/delivery-checker.ts`（接入 `readWorkHours` 与真实 `notify`）
- Test: `openbot/server/tests/delivery-briefing.integration.test.ts`

**Interfaces:**
- Produces: `readWorkHours(userId)`；`buildBriefing(tenantId, kind: "start"|"end", now): Promise<Briefing | null>`（`null` = 没有在跟的卡）；`Briefing = {reviewed: number; awaitingReview: {taskId, title, agentName, deliveredAt}[]; inProgress: {taskId, title, agentName, dueAt}[]; overdue: {taskId, title, minutes, nudges}[]; deferred: string[]}`；`GET /api/me/briefing?kind=start|end`；到点发送的循环（每分钟检查各用户本地时间是否到开工 / 收工，每天每种只发一次）。

- [ ] **Step 1: 测试**：`test("no tracked cards → no briefing sent")`；`test("briefing numbers match the board")`；`test("start briefing carries reminders deferred overnight")`；`test("weekends off by default")`；`test("each briefing is sent once per local day even across restarts")`；`test("push for briefing deep-links to /briefing and overdue to /tasks/:id")`；`test("overdue also goes to a bound Slack binding and respects the daily cap")`；`test("timeZone is written on first save from the browser value")`。
- [ ] **Step 2: 确认失败** → FAIL。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 通过**，跑投递套件、tsc。
- [ ] **Step 5: Commit** `feat(server): 作息、开工收工清点与通知出口`

### Task 7: 外部员工的规约与代走三步（外部员工第二期合入 main 后）

**Files:**
- Modify: `openbot/server/src/agents/acp/agent.ts`（第一轮提示前加规约，每卡一次；轮次开始即 `accepted_at`；回复里取「预计」；结束时用改动汇总或附件过证据门）、`openbot/server/src/agents/acp/translate.ts`（汇总 edit 类工具调用的 diff 为 `DeliverableRef.diffs`）、外部员工排队处（排队即 `markTracked`）
- Test: `openbot/server/tests/acp-delivery.integration.test.ts`

**Interfaces:**
- Consumes: Task 2–6；外部员工第二期的 `DeviceAcpAgent`、`acpTurnStore`、`acpPromptOf(...).runRef`。

- [ ] **Step 1: 测试**：`test("queued external work is pending_accept; turn start sets accepted_at")`；`test("protocol prefix is added once per card, not on resumed turns")`；`test("预计 16:00 / 预计 40 分钟 in the reply sets due_at and due_reported")`；`test("edit diffs become a deliverable and pass the gate")`；`test("a turn with no diff or attachment stays accepted and posts 它没交东西")`；`test("cancelling the card cancels the queued ACP turn")`。
- [ ] **Step 2: 确认失败** → FAIL。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 通过**，跑 acp 套件、tsc。
- [ ] **Step 5: Commit** `feat(server): 外部员工按交付规约走三步`

## 期三：界面（先截图给用户确认）

### Task 8: 看板四列、任务卡详情与流水

**Files:**
- Modify: `openbot/app/src/routes/_authed/_app/tasks.tsx`（在跟卡四列：派出 · 待接下 / 已接下 · 在做 / 已交成果 · 等你验收 / 已验收，`cancelled` 折叠在已验收下；逾期红框 + 「逾期 N 分钟 · 已催 N 次」+「催一下」「准许延期」；顶部清点条；「只看逾期」筛选）
- Create: `openbot/app/src/routes/_authed/_app/tasks.$taskId.tsx`（卡片详情：四步进度、交付物与证据、验收标准、验收 / 退回（写原因）/ 取消、流水正序）
- Test: `openbot/app/src/routes/_authed/_app/tasks.test.tsx`（happy-dom）

- [ ] **Step 1: 测试**：四列归类（含 `needs_action` 未接下卡在待接下列带「等你操作」）；逾期卡渲染文案；退回必须填原因才能提交；流水按时间正序；不在跟的卡照旧列。
- [ ] **Step 2–4: 失败 → 实现 → 通过**（`cd openbot/app && bun test src/routes/_authed/_app/tasks.test.tsx`）。
- [ ] **Step 5: 截图**（暗色、1440 桌面 + 390 手机）存 scratchpad，交控制方。**Commit** `feat(app): 看板三步收货与任务卡详情`

### Task 9: 对话里的四种卡

**Files:**
- Modify: 单聊与群聊消息渲染（`openbot/app/src/skins/xiongbao/message-list.tsx` 及默认皮肤对应组件）：渲染 `delivery.accepted`（接活回执：预计时间、验收标准、「改预计时间」「改验收标准」）、`delivery.extension_requested`（准许 / 不准）、`delivery.delivered`（交付卡：交付物、自查、验收 / 退回）、`delivery.bounced`（灰色系统行）；退回弹层
- Test: 对应组件测试（happy-dom）

- [ ] **Step 1: 测试**：四种事件各渲染出设计稿 3 的文案与按钮；按钮调用 Task 4 接口；非派活人看不到操作按钮。
- [ ] **Step 2–4: 失败 → 实现 → 通过**。
- [ ] **Step 5: 截图**（单聊、群聊各一）。**Commit** `feat(app): 对话里的接活回执、延期、交付与退回`

### Task 10: 作息设置、清点页、逾期页与侧栏目标

**Files:**
- Modify: `openbot/app/src/skins/xiongbao/me-page.tsx`（「通知」里的作息设置，首次打开写入浏览器时区）、`openbot/app/src/skins/xiongbao/workbench-home.tsx`（顶部清点条）、侧栏「目标」块（侧栏界面期的组件；若侧栏界面期尚未做，则在其任务里按本设计实现四段进度）
- Create: `openbot/app/src/routes/_authed/_app/briefing.tsx`（手机清点页，设计稿 4）
- Test: 对应组件测试

- [ ] **Step 1: 测试**：作息保存与回显；清点页数字与 `/api/me/briefing` 一致、无清点时显示空状态；逾期卡详情在手机宽度下显示四个处理按钮（设计稿 5）；侧栏目标四段进度按 `stage` 着色。
- [ ] **Step 2–4: 失败 → 实现 → 通过**。
- [ ] **Step 5: 截图**（手机清点页、逾期页、作息设置、侧栏目标）。**Commit** `feat(app): 作息设置、清点页与侧栏目标进度`

### Task 11: 原生 App 深链与新推送

**Files:**
- Modify: `openbot/mobile/src/notifications.ts`、`openbot/mobile/src/links.ts`（`briefing` → 清点页，`overdue` → 卡片详情；用 `xiongbao://` 打开网页端同一页面的 WebView 或对应原生页）
- Test: `openbot/mobile` 现有测试方式下的链接解析用例

- [ ] **Step 1: 测试**：两种新推送解析到正确路由；旧推送不变。
- [ ] **Step 2–4: 失败 → 实现 → 通过**。
- [ ] **Step 5: Commit** `feat(mobile): 清点与逾期推送深链`；发版需要用户推 App 标签（不在本计划内执行）。
