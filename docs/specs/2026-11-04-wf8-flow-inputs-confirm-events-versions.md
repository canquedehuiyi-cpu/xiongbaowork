# WF8 WakerFlow 输入参数、确认回答与跳过、运行事件与错误恢复、版本与回滚 设计规格

- 日期：2026-11-04
- 状态：**已定稿**（2026-11-04）。第 4 节的待决策项已全部决定，均采纳建议；本文不含代码。
- 故事：`docs/acceptance/STORIES.md` WF8（D10）：输入参数、确认回答与跳过、运行事件及错误恢复、版本定义与回滚。11-02 的 MVP 决定曾把它移到 v1.0 后，现在拉回范围。
- 原文出处：`docs/specs/2026-10-06-qoderwake-replica.md` 里没有 WF8 的逐条描述（D10 只定义了组团流水线）。功能清单来自 `docs/plans/2026-10-10-完整仿制接手.md:61-67` 对原版 `WorkflowPage` 客户端契约的只读审计："运行 args/idempotencyKey、事件、分页历史、terminate 和 retryFromCorrelationId；确认 answer/skip；定义版本与 rollback；meta.inputSchema 参数输入；Flow 触发器的 args"。该审计的原始证据文件不在本仓库，原版的后台语义也**没有经过付费实测**，所以本文写的是我们自己的语义，不是对原版行为的断言。
- 一并处理：AUT3 遗留缺口（`STORIES.md:166`）：自动任务启动 WakerFlow 时固定传 `inputs: {}`，自动任务表单也没有填 Flow 输入的地方。
- 相关：WF7（节点类型，本文之后做）、WF9（会话与分享，最后做）、AUT1–AUT3、WF-F（重启恢复）。

---

## 1. 现状（基线：`claude/magical-archimedes-8a6ljj`，`bcdc46f`）

### 1.1 输入参数：只有"必填/选填的字符串"

- `shared/wakerflows.ts:1` 的 `WakerFlowPlan.inputs` 是 `{ key, label, required }[]`。没有类型、默认值、说明或可选项。
- `server/src/wakerflows/plan.ts:28` 限制最多 20 个输入；`plan.ts:92` 的 `flowInputs()` 只检查三件事：未声明的名字被拒，必填项不能为空，单值不超过 10000 字、合计不超过 20000 字。值一律是字符串。
- 运行入口 `server/src/wakerflows/store.ts:999` 的 `start()`：先算指纹（`kind/flowId/revision/inputs`），再在 `:1042` 调 `flowInputs()`，最后把输入原样交给 `pipeline.start()`（`:1107`），写进 `group_task_runs.inputs`。
- 执行时 `server/src/pipeline/store.ts:986` 把步骤 `inputKeys` 对应的值拼进指令（"此步骤的输入：…"）。
- 前端：`app/src/components/wakerflow/run-panel.tsx:112` 按 `plan.inputs` 生成输入框，只发送填了的值；`plan-editor.tsx:213` 编辑 key/label/required。

### 1.2 AUT3：自动任务启动 Flow 时没有输入

- `server/src/automations/types.ts:53` 的 wakerflow 目标是 `{ kind: "wakerflow", flowId }`，`.strict()`，没有输入字段。
- `server/src/automations/waker-executor.ts:362-366` 的 `runFlow()` 固定调用 `flows.start(owner, owner, flowId, { requestId: firing.id, revision: flow.revision, inputs: {} })`。只要 Flow 有必填输入，`flowInputs()` 就抛错，这次触发以失败结束。
- 保存时的校验 `waker-executor.ts:116` 的 `wakerflowAutomationTarget().verify()` 只检查 Flow 存在且 `ready`，不看输入。
- 前端 `app/src/components/automations/automation-form.tsx:91-95` 只让人选一个 Flow。
- `automations` 表的 `target` 是 jsonb（`db/schema/automation-foundations.ts:21`），加字段不需要迁移。

### 1.3 确认回答与跳过：底层有，WakerFlow 没接

- 流水线已经能停在某一步上等人：`StepResult` 的 `awaiting_action`（`pipeline/store.ts:60`），审批或提问都会让这一步停下，`approvalId` 可以为空（提问没有审批行）。
- 流水线路由有继续和跳过：`server/src/pipeline/routes.ts:160` 的 `POST /runs/:runId/resume`（`store.resume()`，`pipeline/store.ts:1305`）和 `:204` 的 `POST /runs/:runId/skip`（`store.skip()`，`:1175`，记为 `skipped`，不清掉）。
- **WakerFlow 的路由**（`server/src/wakerflows/routes.ts`）只有 `runs`、`runs/:runId` 和 `runs/:runId/abort`，没有回答或跳过；`run-panel.tsx` 的 `RunDetail` 只有"停止"按钮（`:396`）。也就是说，Flow 的某一步停在提问上时，WakerFlow 页面上没有办法回答或跳过它。
- 休眠表 `flow_confirmations`（`server/src/db/schema/flow-run-coordination.ts:22`，迁移 `0088`）的字段正好对应：`run_id`、`node_id`、`question`、`inputs`、`status ∈ pending|answered|skipped`、`answer`、`request_id`。没有代码读写它；它有 RLS 但**没有 FORCE**，策略里也没有 `platform` 分支（与 0072 之后的兄弟表不一致）。

### 1.4 运行事件与错误恢复：只有最终快照

- 一次运行的全部状态就是 `group_task_runs` 的一行：`status`、`cursor` 和 `steps`（jsonb，每步 `state/output/error`）。过程中的状态变化直接覆盖，事后读不到"第 2 步什么时候开始、停过几次、谁跳过的"。
- 休眠表 `flow_run_events`（`flow-run-coordination.ts:93`：`sequence bigserial`、`run_id`、`correlation_id`、`type`、`payload`）和 `flow_run_retries`（`:160`：`source_run_id`、`source_revision`、`definition_revision`、`node_id`、`new_run_id`、`fingerprint`、`status ∈ prepared|ready|unknown|cancelled`）同样无人读写，同样没有 FORCE。
- 重启恢复 `server/src/wakerflows/recovery.ts:17-40`（WF-F，#90）：进程中途死掉的运行一律**以失败收尾，不重放**，"由人决定是否重新运行"。但现在"重新运行"只能从第一步开始，前面已经完成、已经花了额度的步骤要再跑一遍。

### 1.5 版本与回滚：每次保存已经留下了模板版本，但没有完整定义

- `store.ts:524` 的 `save()`：每次保存都**新建**一条 `group_task_templates`（名字 `"<name> · 第 N 版"`，`:652`），并把 `waker_flows.template_id` 指向它；`revision` 自增，做乐观并发。运行记录的是它开始时的模板（`group_task_runs.template_id`）。
- 但模板只存 `steps`（`db/schema/pipeline.ts:93`），**不存** `members`、`inputs`、`name`、`description`、`modelRef`。所以无法从模板还原出某一版完整的计划，也就没有版本列表或回滚。
- 休眠的 `flow_source_versions`（`flow-source-foundations.ts:20`）是 JS 源码模式（`js-source-v1`）的版本表：`artifact.runtimeReady` 被 CHECK 固定为 `false`，并受 `FLOW-ACTIVATION-CONTRACT.md` 约束。**它不适合存 JSON 计划版本，本文不用它。**

### 1.6 已有测试

`server/tests/wakerflow-run.integration.test.ts`、`wakerflow-routes.test.ts`、`wakerflow-restart-recovery.integration.test.ts`、`automation-waker-executor.test.ts`、`automation-routes.test.ts`、`app/tests/wakerflow-runs.test.tsx`、`app/tests/automation-form.test.tsx`。

---

## 2. 差距

| # | 故事要求 | 差距 |
| --- | --- | --- |
| G1 | 输入参数 | 只有字符串；没有类型、默认值、说明、下拉选项 |
| G2 | 自动任务带输入启动 Flow（AUT3） | 固定传 `{}`；表单没有输入框；保存时不校验 |
| G3 | 确认回答与跳过 | WakerFlow 没有回答或跳过的入口；提问内容没有落库 |
| G4 | 运行事件 | 只有最终快照，没有事件流和分页历史 |
| G5 | 错误恢复 | 失败（包括重启判失败）后只能从头再跑 |
| G6 | 版本定义与回滚 | 模板版本不含完整计划；没有版本列表，也没有回滚 |
| G7 | 测试 | 以上都没有测试 |

---

## 3. 方案

### 3.1 输入参数（G1）

- **I-A（推荐）：在现有 `inputs` 上加可选字段，值仍然是字符串。** 每个输入增加 `type ∈ text|textarea|number|select|boolean`（缺省为 `text`，旧计划不变）、`description`（≤200）、`default`（字符串）、`options`（仅 `select`，1–20 个，每个 ≤80）。`flowInputs()` 按类型校验：`number` 必须能解析成有限数，`boolean` 只能是 `"true"`/`"false"`，`select` 必须是选项之一；没填且有 `default` 时用默认值。`group_task_runs.inputs` 仍是 `Record<string,string>`，执行侧（`pipeline/store.ts:986`）不改。
- I-B：直接采用 JSON Schema（对应原版的 `meta.inputSchema`）。表达力强，但要引入校验器（不能加依赖），编辑器也要能编辑任意 schema。**不推荐**。

### 3.2 自动任务的输入（G2）

- 目标改为 `{ kind: "wakerflow", flowId, inputs?: Record<string,string> }`（`automations/types.ts:53`，仍然 strict）。
- **保存时**：`wakerflowAutomationTarget().verify()` 用当前计划跑一遍 `flowInputs()`，必填项缺失直接拒绝保存，错误文案与运行面板一致。
- **触发时**：`runFlow()` 把 `target.inputs ?? {}` 交给 `start()`。如果 Flow 在保存自动任务之后改了版本，导致输入不再合法（新增了必填项、删了某个输入），这次触发以失败结束，原因写清楚"WakerFlow 的输入已变更，请编辑自动任务"，**不悄悄丢掉或补上**。
- 事件入口（webhook）请求体能否填输入：见决策 D3（已决定：v1.0 不开放）。

### 3.3 确认回答与跳过（G3）

- 启用 `flow_confirmations`：当 Flow 的一步因提问停下时（`awaiting_action` 且没有 `approvalId`），WakerFlow 的驱动层写一行 `pending`，`question` 存提问内容，`node_id` 存步骤 id，`inputs` 存这一步当时的输入快照。审批类停顿**不**写这张表：审批仍走现有审批收件箱，避免同一件事有两个入口。
- 新增 `POST /api/wakerflows/:id/runs/:runId/confirmations/:confirmationId/answer`（`{ requestId, answer }`）和 `…/skip`（`{ requestId }`）：
  - 回答：把行改为 `answered`，调用 `pipeline.resume({ output: answer })`。这一步的输出就是人的回答，后续步骤照常读取。
  - 跳过：把行改为 `skipped`，调用 `pipeline.skip({ stepId })`，这一步记为 `skipped`。后续读它输出的步骤会看到"（此输入未产生）"，这是现有行为（`pipeline/store.ts:987`）。
  - 两者都按 `status = 'pending'` 做条件更新，重复提交或两人同时提交只有一个生效；`request_id` 保证重试安全。
- 确认节点（主动发问的步骤类型）属于 WF7 的节点类型，见 WF7 规格；它产生的也是同一张表的一行。

### 3.4 运行事件（G4）

- **E-A（推荐）：启用 `flow_run_events`，事件和状态写在同一个事务里。** `pipeline/store.ts` 的 `writeRun()` 是所有状态变化的唯一出口，已经按 revision 做条件更新。给 `createPipelineStore` 增加可选参数 `events`，`writeRun()` 在同一事务里为 `flow_id` 不为空的运行插入事件。不是 Flow 的组团运行不写事件。
  - 事件类型：`run_started`、`step_started`、`step_done`、`step_parked`、`step_answered`、`step_skipped`、`step_failed`、`run_done`、`run_failed`、`run_aborted`、`run_retried`，以及 WF7 的 `branch_taken`。`correlation_id` 等于这一步的 `runRef`。`payload` 只存状态、错误摘要和长度，**不存步骤输出全文**（全文已在 `steps` 和任务卡里）。
  - 读取：`GET /api/wakerflows/:id/runs/:runId/events?after=<sequence>&limit=50`，按 `sequence` 正序分页。
- E-B：只在 `wakerflows/store.ts` 里对比前后快照来补写事件。不需要改流水线，但后台驱动的步骤变化发生在 `advance` 里，wakerflows 层看不到，事件会漏。**不推荐**。

### 3.5 错误恢复（G5）

- 启用 `flow_run_retries`：`POST /api/wakerflows/:id/runs/:runId/retry`（`{ requestId }`），只对 `failed` 的运行开放：
  1. 新运行使用**源运行的模板**（不是 Flow 当前的模板），所以定义不变；`definition_revision` 记录源运行开始时的 Flow 版本，`source_revision` 记录发起重试时的 Flow 版本。
  2. 新运行的 `steps` 预置为：失败步骤之前已经 `done` 的步骤原样复制 `state/output`，**不重新执行**；从失败的那一步开始 `pending`。`pipeline.start()` 增加可选参数 `seed`（已完成步骤的记录与起始游标）。
  3. 额度只按剩下的步骤数检查（`assertCapacity(..., remaining + 1)`）。
  4. I6 照常执行：发起重试的人必须仍能使用剩下每一步的员工，否则拒绝，并在原因里列出这些步骤。
  5. 行状态从 `prepared` 到 `ready`；进程在两者之间死掉时，由 `wakerflows/recovery.ts` 把它判为 `unknown`，**不重放**，与 WF-F 的语义一致。
- 失败的那一步如果已经对外产生了副作用（发了消息、写了文件），重试会再执行它一次。界面在重试按钮旁明确提示这一点（决策 D6，已决定）。

### 3.6 版本与回滚（G6）

- **V-A（推荐）：新表 `waker_flow_versions`，每次保存写一行完整定义。** 字段：`tenant_id`、`flow_id`、`revision`（保存后的版本号）、`plan` jsonb、`model_ref`、`template_id`、`created_by`、`created_at`。主键为 `(tenant_id, flow_id, revision)`；只能追加（UPDATE/DELETE 策略为 `false`，与 `0108` 对 `flow_source_*` 的做法一致）；RLS 为本租户或 `platform`，并且 FORCE。由 `save()` 在同一事务里写入。
  - 版本列表：`GET /api/wakerflows/:id/versions`（新到旧，不含 plan 全文）；`GET …/versions/:revision`（含 plan）。
  - **回滚就是"用旧版本的计划再保存一次"**：`POST …/versions/:revision/restore`（`{ revision: <当前版本> }`）在服务端读出旧计划，走完整的 `save()`：重新检查 I6、生成新模板、`revision + 1`。历史不改写，回滚本身也是一个新版本。正在跑的运行不受影响，因为它用的是自己开始时的模板。
  - 已有的 Flow 没有历史版本：迁移只为每个已编译的 Flow 补一行当前版本（来自 `waker_flows.plan`），不伪造更早的版本。
- V-B：给 `group_task_templates` 加 `plan` 和 `flow_revision` 两列，让模板本身充当版本。少一张表，但组团模板是通用表，不是每个模板都属于 Flow，语义会混在一起。**不推荐**。
- V-C：复用 `flow_source_versions`。受激活契约约束，且结构是 JS 源码专用的。**不可用**。

### 3.7 休眠表的启用规则（本文和 WF7、WF9 共用）

- 休眠表的 Drizzle 定义被 `server/tests/recovery-*.test.ts` 按元数据逐项锁定（`recovery-flow-run-coordination.test.ts:752` 等）。**不修改这些 schema 文件里的任何结构**，直接使用已有的 Drizzle 对象。
- 启用迁移只追加以下内容：`FORCE ROW LEVEL SECURITY`；与兄弟表一致的 `platform` 分支策略（新建，不修改旧策略）；必要的 CHECK。
- 这属于**有意的设计变更**：把"仅历史结构"的表变成活表，已签字确认（决策 D1，2026-11-04）。动工前先在迁移后的库上跑一遍全部 `recovery-*` 测试，确认后续迁移不会触发它们的围栏断言。

---

## 4. 待决策（已全部决定，2026-11-04）

| 编号 | 问题 | 决定 |
| --- | --- | --- |
| D1 | 是否同意启用休眠表 `flow_confirmations`、`flow_run_events`、`flow_run_retries`（只追加 FORCE、`platform` 策略和 CHECK，不改结构） | 已决定（2026-11-04）：同意；结构正好对应需求，新建等价表只会多出第二个事实来源 |
| D2 | 输入参数用 I-A（扩展字段）还是 I-B（JSON Schema） | 已决定（2026-11-04）：I-A |
| D3 | 事件入口（webhook）的请求体能否覆盖或填充 Flow 输入 | 已决定（2026-11-04）：v1.0 不开放，只用自动任务里保存的固定值；以后再做显式映射，并对外部值套用不可信内容声明 |
| D4 | 自动任务保存后 Flow 的输入变了怎么办 | 已决定（2026-11-04）：触发失败并写明原因，不自动补默认值或丢弃多余值 |
| D5 | 审批类停顿是否也在 WakerFlow 页面直接处理 | 已决定（2026-11-04）：不在 WakerFlow 页面处理，只显示"去审批"链接；审批只有一个入口 |
| D6 | 从失败步骤重试时，失败步骤可能重复产生副作用 | 已决定（2026-11-04）：允许重试，按钮旁提示"失败的那一步会重新执行一次"，重试之前要求确认 |
| D7 | 重试用源运行的定义，还是 Flow 当前的定义 | 已决定（2026-11-04）：源运行的定义；想用新定义就重新运行 |
| D8 | 版本用新表（V-A）还是扩展模板（V-B） | 已决定（2026-11-04）：V-A |
| D9 | 版本保留多久 | 已决定（2026-11-04）：不自动清理；删除 Flow 时随软删除一起隐藏 |
| D10 | 事件 payload 是否包含步骤输出 | 已决定（2026-11-04）：不包含，只存状态、错误摘要和长度 |

---

## 5. 分阶段计划

迁移编号按 `docs/specs/2026-11-04-deferred-stories-overview.md` 的预留：本故事用 **0134** 和 **0137**。推送前检查 origin，如果号码被占用就顺延。新增服务端测试后运行 `bun scripts/ci/server-shards.mjs --write`（清单文件不计入文件数）。

### WF8-1：输入类型与自动任务输入（服务端，无迁移，7 个文件）
- 文件：`shared/wakerflows.ts`、`server/src/wakerflows/plan.ts`、`server/src/automations/types.ts`、`server/src/automations/waker-executor.ts`、`server/tests/wakerflow-plan-inputs.test.ts`（新增）、`server/tests/automation-waker-executor.test.ts`、`server/tests/automation-routes.test.ts`。
- 验收：
  1. 没有 `type` 的旧计划照常保存和运行；`number` 输入填 `abc` 时运行被拒，返回 400 和中文原因。
  2. 没填但有 `default` 的输入按默认值进入 `group_task_runs.inputs`。
  3. 必填输入缺失的自动任务保存时被拒；带齐输入的自动任务触发后，这次运行的 `inputs` 与保存的值完全一致。
  4. 保存自动任务后，Flow 新增一个必填输入：下一次触发为 `failed`，原因包含"输入已变更"，并且没有创建任何运行。

### WF8-2：输入类型与自动任务输入（前端，7 个文件）
- 文件：`app/src/components/wakerflow/flow-input-fields.tsx`（新增，运行面板和自动任务表单共用）、`run-panel.tsx`、`plan-editor.tsx`、`app/src/lib/wakerflows.ts`、`app/src/components/automations/automation-form.tsx`、`app/tests/wakerflow-runs.test.tsx`、`app/tests/automation-form.test.tsx`。
- 验收：
  1. 编辑器可以选择类型、填写默认值和下拉选项；`select` 没有选项时提示错误，不能保存。
  2. 运行面板按类型渲染：多行文本、数字、下拉、开关。
  3. 自动任务表单选中 Flow 后出现它的输入框，必填项为空时不能提交。

### WF8-3：版本表与回滚（服务端，迁移 0134，6 个文件）
- 文件：`server/recovery/recovery-20261018-v1/sql/0134_waker_flow_versions.sql`、`…/meta/_journal.json`、`server/src/db/schema/wakerflows.ts`、`server/src/wakerflows/store.ts`、`server/src/wakerflows/routes.ts`、`server/tests/wakerflow-versions.integration.test.ts`（新增）。如果 `tests/tenant-invariants.test.ts` 要求登记新表，再加这一个文件（7 个）。
- 验收：
  1. 连续保存三次，版本列表有三行，按版本号倒序。
  2. 恢复第 1 版后 `revision` 变为 4，计划与第 1 版完全一致，并生成了新模板；第 2、3 版仍然可读。
  3. 恢复时 I6 生效：第 1 版用到的员工现在不可用，恢复被拒，Flow 保持不变。
  4. 应用角色对 `waker_flow_versions` 执行 UPDATE 或 DELETE 一律失败；租户 B 读租户 A 的版本返回 404。
  5. 迁移在一个已有已编译 Flow 的库上运行后，该 Flow 恰好有一行当前版本。

### WF8-4：版本界面（前端，4 个文件）
- 文件：`app/src/routes/_authed/_app/wakerflows.$flowId.tsx`、`app/src/components/wakerflow/version-list.tsx`（新增）、`app/src/lib/wakerflows.ts`、`app/tests/wakerflow-versions.test.tsx`（新增）。
- 验收：Flow 页面有"版本"区；点"恢复此版本"需要二次确认；恢复后编辑器显示新版本号；版本冲突时提示刷新。

### WF8-5：运行事件与确认回答/跳过（服务端，迁移 0137，7 个文件）
- 文件：`sql/0137_flow_run_coordination_active.sql`（对 `flow_confirmations`、`flow_run_events`、`flow_run_retries` 三张表加 FORCE 和 `platform` 策略）、`meta/_journal.json`、`server/src/pipeline/store.ts`（`events` 参数，`writeRun()` 同事务写事件）、`server/src/wakerflows/store.ts`（`events()`、`answer()`、`skipConfirmation()`，停顿时写确认行）、`server/src/wakerflows/routes.ts`、`server/src/index.ts`（接线）、`server/tests/wakerflow-run-events.integration.test.ts`（新增）。
- 验收：
  1. 一次三步运行产生 `run_started`、3 个 `step_started`、3 个 `step_done` 和 `run_done`，`sequence` 严格递增；`after` 参数分页不重复、不遗漏。
  2. 状态更新失败（revision 冲突）时不留下事件行。
  3. 第 2 步因提问停下：出现一行 `pending` 确认；回答之后第 2 步的输出等于回答，第 3 步读到它；同一个回答提交两次只生效一次。
  4. 跳过：第 2 步为 `skipped`，确认行为 `skipped`，运行继续到结束。
  5. 非 Flow 的组团运行不写事件（现有的 `pipeline-*` 测试保持通过）。
  6. 租户 B 读事件和确认都返回 404。

### WF8-6：从失败步骤重试（服务端，5 个文件）
- 文件：`server/src/pipeline/store.ts`（`start()` 的 `seed` 参数）、`server/src/wakerflows/store.ts`（`retry()`）、`server/src/wakerflows/routes.ts`、`server/src/wakerflows/recovery.ts`（`prepared` 超时判 `unknown`）、`server/tests/wakerflow-retry.integration.test.ts`（新增）。
- 验收：
  1. 第 3 步失败的运行重试后，新运行的第 1、2 步为 `done`，输出与源运行相同，步骤执行器只被调用一次（第 3 步）。
  2. 同一个 `requestId` 重试两次只创建一个新运行；指纹不同则返回 409。
  3. 对 `done` 或 `running` 的运行重试返回 400。
  4. 进程在 `prepared` 与 `ready` 之间退出：重启后该行为 `unknown`，没有新运行被驱动。
  5. 重试使用源运行的模板：Flow 在失败后改过计划，新运行的步骤仍是旧定义。

### WF8-7：事件、确认与重试界面（前端，6 个文件）
- 文件：`app/src/components/wakerflow/run-panel.tsx`、`app/src/components/wakerflow/run-timeline.tsx`（新增）、`app/src/lib/wakerflows.ts`、`app/tests/wakerflow-runs.test.tsx`、`app/tests/wakerflow-run-timeline.test.tsx`（新增）、`scripts/e2e/wakerflow-lifecycle.ts`（端到端路径，见 §6 第 8 条）。
- 验收：运行详情显示事件时间线（加载更多）；停在提问上的步骤显示问题、回答框和"跳过"按钮；失败的运行显示"从失败步骤重试"，确认框写明哪一步会重新执行。

---

## 6. 验收测试

服务端测试一律在 `runAsTenant` 中进行，使用真库；不调用真实模型（步骤执行器用测试替身）。

1. `server/tests/wakerflow-plan-inputs.test.ts`（纯函数）：每种类型正反例各至少 3 条；旧计划（没有 `type`）解析结果与改动前一致；`select` 选项重复被拒。
2. `server/tests/automation-waker-executor.test.ts`：带输入的触发把输入原样传给 `start()`；Flow 输入变更后触发失败，并且 `start()` 没有被调用。
3. `server/tests/wakerflow-versions.integration.test.ts`：见 WF8-3 验收 1–5。
4. `server/tests/wakerflow-run-events.integration.test.ts`：见 WF8-5 验收 1–6。
5. `server/tests/wakerflow-retry.integration.test.ts`：见 WF8-6 验收 1–5。
6. 回归：`wakerflow-run.integration.test.ts`、`wakerflow-restart-recovery.integration.test.ts`、`pipeline-*`、全部 `recovery-flow-*` 测试保持通过。
7. 前端：`app/tests/wakerflow-runs.test.tsx`、`automation-form.test.tsx`、新增的 `wakerflow-versions.test.tsx`、`wakerflow-run-timeline.test.tsx`。
8. G4 浏览器端到端（`scripts/e2e/wakerflow-lifecycle.ts`，CI job `e2e-wakerflow`，模拟模型）在 WF8-7 中增加一条路径：带类型输入运行 → 第 2 步提问 → 页面回答 → 运行完成。
