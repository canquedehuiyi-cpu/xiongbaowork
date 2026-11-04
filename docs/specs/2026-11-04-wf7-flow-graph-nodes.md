# WF7 WakerFlow 流程图：worker 提示词、decision 条件分支、嵌套 Flow 与动作节点 设计规格

- 日期：2026-11-04
- 状态：**已定稿**（2026-11-04）。第 4 节的待决策项已全部决定，均采纳建议；本文不含代码。
- 故事：`docs/acceptance/STORIES.md` WF7（D10）：流程图 worker 提示词、decision 条件分支、嵌套 Flow 和动作实现的编辑与执行。11-02 的 MVP 决定曾把它移到 v1.0 后，现在拉回范围。
- 原文出处：`docs/specs/2026-10-06-qoderwake-replica.md` 的 D10（第 167 行）只定义了串行组团流水线，并在 §6（第 203 行）写明"组团模板本期只支持串行步骤"。WF7 的功能清单来自 `docs/plans/2026-10-10-完整仿制接手.md:65` 对原版客户端契约的只读审计："员工提示词、决策表达式/分支、嵌套 targetWakerflowId 和 action implementation 编辑"。原版的后台执行语义**没有经过实测**，本文定义的是我们自己的语义。
- 前置：WF8（运行事件、版本表）先做，见总览。相关：ADR `docs/decisions/0001-组团流水线的执行通道.md`（每一步都走已有的无人值守通道）、SEC1（工具权限）、I6（逐步校验发起人能否使用该员工）。

---

## 1. 现状（基线：`claude/magical-archimedes-8a6ljj`，`bcdc46f`）

### 1.1 计划是一条直线

- `shared/wakerflows.ts:1` 的 `WakerFlowPlan.steps` 是 `{ id, agentId, instruction, inputKeys, outputKey }[]`，没有节点类型，也没有跳转。
- 校验在 `server/src/wakerflows/plan.ts:23` 的 `wakerFlowPlanSchema`（最多 10 步、10 个成员）。`superRefine`（`:55`）按数组顺序检查：一步只能读取流程输入或**前面**步骤的输出，输出名不能重复。
- 保存时 `server/src/wakerflows/store.ts:565` 把计划步骤映射成模板步骤 `PipelineStepRow`（`server/src/db/schema/pipeline.ts`：`id/agentId/instruction/inputKeys/outputKey`），写入新的 `group_task_templates`。

### 1.2 执行是一个游标

- `server/src/pipeline/store.ts:756` 的 `advance()` 从 `cursor` 开始逐步执行：每一步调用 `executeStep`（生产环境是 `pipeline/turn-channel.ts` 的 `createPipelineStepRunner`，即 `routines/runner.ts` 的 `TurnRunner`，ADR-0001 = A），完成后 `cursor += 1`（`:1022`）。
- 指令在 `:984` 拼装：`步骤指令 + "任务：" + 运行指令 + 本步输入（或前面步骤的产出）+ 缺失提示`。缺失提示（`:877-883` 计算，`:994` 拼进指令）把 `skipped` 和 `failed` 的步骤都算作"没有产出"。
- 步骤状态 `PipelineStepStateRow.state` 有 `pending|running|awaiting_action|done|failed|skipped|aborted`；`stepIsSettled()` 定义终态。

### 1.3 "worker 提示词"：成员角色没有进入执行

- 计划的 `members[].role`（`plan.ts:15`，≤160 字）只在编辑器和错误文案里出现（`store.ts:561`），**不会**写进模板步骤，执行时员工看不到自己在这个流程里的角色。每一步只有 `instruction`。

### 1.4 没有条件分支、嵌套和动作节点

- 没有任何条件求值。服务端已有 CEL 求值库 `cel-js`（`server/package.json:32`，`computer/policy.ts:17` 在用），不需要新增依赖。
- 没有子流程：`group_task_runs`（`db/schema/pipeline.ts:129`）没有父运行字段；`pipeline.start()`（`pipeline/store.ts:637`）没有父任务参数。
- 没有不经模型的"动作"步骤。可用的受治调用入口有：`plugins/store.ts:8012` 的 `callTool({ ref, args, botId, actorId, initiator })`（MCP 工具，内部在 `:8304` 走审批闸门），以及 `computer/gateway.ts:726` 的审批闸门。轮次级的闸门是 `agents/lifecycle.ts:150` 的 `guardBotTurn`（暂停）和 `admin/controls.ts:1049` 的 `headlessTurnRefusal`（Use Bots、模型白名单）；ADR-0001 选 A 的理由正是"每一步都过这两道闸"。
- `waker_flows.definition_mode` 的 CHECK（`db/schema/wakerflows.ts:43`）只允许 `json-plan-v1` 和 `js-source-v1`。JS 源码模式受 `server/recovery/recovery-20261018-v1/FLOW-ACTIVATION-CONTRACT.md` 约束（"ACTIVATION_BLOCKED"），本故事**不启用**它。

### 1.5 前端

- `app/src/components/wakerflow/plan-editor.tsx` 是表单式编辑器（成员、输入、步骤列表）；`app/src/routes/_authed/_app/wakerflows.$flowId.tsx` 展示计划和运行；没有流程图。`app/package.json` 没有图形库，不能新增依赖。

---

## 2. 差距

| # | 故事要求 | 差距 |
| --- | --- | --- |
| G1 | 流程图编辑与查看 | 只有表单列表 |
| G2 | worker 提示词 | 成员的流程内角色不进入执行 |
| G3 | decision 条件分支 | 没有节点类型、没有跳转、没有条件求值 |
| G4 | 嵌套 Flow | 没有子运行、父子关联、等待与恢复 |
| G5 | 动作实现 | 没有动作节点 |
| G6 | 执行安全 | 分支必须能终止；子流程不能成环；每一步仍要过 I6 和 ADR-0001 的闸门 |
| G7 | 测试 | 以上都没有测试 |

---

## 3. 方案

### 3.1 计划结构

- **P-A（推荐）：保留步骤数组，增加节点类型和"只能向前"的跳转。** 仍然是 `json-plan-v1`，旧计划不变（没有 `kind` 的步骤就是 `worker`）。
  - 每一步增加 `kind ∈ worker|decision|flow|action`（缺省 `worker`），以及可选的 `next: <stepId>`：本步结束后跳到哪一步；不填就是下一项。
  - `decision`：`{ id, kind: "decision", inputKeys, branches: [{ label, when, next }], otherwise }`，最多 8 个分支。`when` 是 CEL 表达式（≤500 字），`next` 和 `otherwise` 都是步骤 id。decision 不指派员工，也不调用模型。
  - **只能向前**：`next`、`branches[].next`、`otherwise` 指向的步骤在数组里必须排在后面。这样执行路径一定是有向无环的，运行必然终止，不需要循环上限。
  - **输入可达性**：`superRefine` 改为按控制流图做支配分析，一步只能读取"在所有到达它的路径上都已产生"的输出，否则保存时报错（"输入 x 只在部分分支中产生"）。
  - 步数上限从 10 提到 20（决策 D4，已决定），成员上限不变。
- P-B：真正的图结构（节点 + 边，允许汇合与回环）。表达力最强，但需要循环上限、新的执行器和新的存储形状，等于另造一个引擎，与 ADR-0001"只编排、不另造通道"的方向相违。**不推荐**。
- P-C：启用 `js-source-v1`，用脚本写流程。受激活契约阻塞，也没有沙箱。**不可用**。

### 3.2 worker 提示词（G2）

- 成员增加 `prompt`（≤4000 字，可空），含义是"你在这个流程里负责什么、怎么做"。保存时把所属成员的 `role` 和 `prompt` 写进该员工每一步的模板步骤（`PipelineStepRow` 增加可选字段 `rolePrompt`；`steps` 是 jsonb，不需要迁移）。
- 执行时 `pipeline/store.ts:984` 把它作为"本流程中你的角色"一段，放在步骤指令**之前**。它是任务层面的说明，不覆盖员工自己的系统提示和人设（`shared/persona.ts` 的 `personaGuidance` 仍然生效）。
- 层级选成员级还是步骤级：决策 D2，已决定。

### 3.3 decision 条件分支（G3）

- 由编排器在 `advance()` 里求值，不占用员工轮次。求值环境：`inputs.<key>` 和 `outputs.<key>`，值都是字符串，只包含这一步 `inputKeys` 声明的那些；可以使用 `cel-js` 内置的 `contains`、`startsWith`、`matches`、`size`、`int()`、`double()` 和比较运算。
- 按 `branches` 的顺序取第一个为真的分支，都不为真就走 `otherwise`。**求值出错（类型错误、未知字段）时这一步判为失败**，运行以失败结束，错误写明是哪个表达式。不会因为出错就走 `otherwise`（失败即关闭，fail closed）。
- 没有走到的步骤记为 `skipped`，并加 `skipReason: "branch"`（jsonb 字段，不需要迁移），与人工跳过（`skipReason: "person"`）区分。`:881` 的缺失列表和总结**不把分支跳过算作缺失**。
- 写入 WF8 的运行事件 `branch_taken`（`payload`：分支 label、命中的表达式下标）。
- 保存时用 `cel-js` 解析每个表达式，语法错误在编辑器里就地显示。
- "让员工来判定"的分支（模型读输出后选一个 label）：决策 D3：v1.0 不做。

### 3.4 嵌套 Flow（G4）

- 节点：`{ id, kind: "flow", targetFlowId, targetRevision, inputMap: { 子输入名: 父键 }, outputKey, resultKey? }`。
- **版本固定**：保存父 Flow 时记录子 Flow 当时的 `revision`。运行时如果子 Flow 已经有了新版本，仍按记录的版本执行（从 WF8 的 `waker_flow_versions` 取模板 id），编辑器提示"子流程有新版本"，由人决定是否更新（决策 D5，已决定）。
- **防环与深度**：保存时沿 `targetFlowId` 递归读取子 Flow 的计划，发现回到自己就拒绝；运行时嵌套深度上限为 3，超过则这一步失败。
- **执行**：
  1. 父步骤用确定性的 `requestId`（由父运行 id 和步骤 id 派生）调用 `wakerflows/store.ts` 的启动逻辑，以**父运行的发起人**身份启动子运行。所以 I6、额度检查、请求幂等全部沿用 `start()` 的现有实现，重试不会启动第二个子运行。
  2. 父步骤停在 `awaiting_action`（没有 `approvalId`），记录 `childRunId`。
  3. 子运行进入终态时：`done` 则父步骤的输出为子运行 `resultKey` 对应的输出（缺省为最后一个完成步骤的输出），通过 `pipeline.resume()` 继续父运行；`failed` 或 `aborted` 则父步骤失败。
  4. 中止父运行时，连带中止仍在运行的子运行。
- **存储**：`group_task_runs` 增加两列 `parent_run_id uuid null`、`parent_step_id text null`（迁移 **0138**），子运行据此找到父运行。
- **重启**：`wakerflows/recovery.ts` 增加一个阶段：父运行停在 `flow` 步骤、而子运行已经是终态时，补做第 3 步（`resume` 本身按停顿状态做了条件更新，重复执行没有副作用）。子运行被判失败时，父运行跟着走失败路径，**不重放**，与 WF-F 一致。
- **看板**：子运行的父卡挂在父步骤的卡下面（`pipeline.start()` 增加可选的父卡引用）。如果任务投影器不支持三层嵌套，退而在父步骤卡上放子运行链接（在 WF7-3 内确认）。

### 3.5 动作节点（G5）

"动作实现"指一个确定的工具调用，不让模型自由发挥。节点：`{ id, kind: "action", agentId, tool: "<serverId>/<toolName>", args: { 参数名: 模板字符串 }, inputKeys, outputKey }`。模板里的 `{{key}}` 用输入或前面步骤的输出替换。

- **A-1（推荐）：不经模型的受治调用。** 编排器以该员工身份调用 `plugins/store.ts:8012` 的 `callTool`，`actorId` 为运行发起人。调用之前先过与轮次相同的两道闸：`guardBotTurn`（员工被暂停时拒绝）和 `headlessTurnRefusal`（Use Bots 等管控）。审批闸门在 `callTool` 内部照常生效：需要审批时，这一步停在 `awaiting_action` 并带上 `approvalId`，批准后由审批续跑路径重新调用一次（在 WF7-4 内验证续跑上下文：`runId` 用这一步的 `runRef`，`threadId` 用 `group-run-<runRef>`，`toolCallId` 用步骤 id）。
  - 优点：确定、不花模型额度、参数就是编辑器里写的参数。
  - 代价：这是 ADR-0001 之外的第二条执行路径。补充条款已写入 `docs/decisions/0001-组团流水线的执行通道.md` 的"补充（2026-11-04）"一节：动作节点可以直调工具，但必须先过同样的闸门，并由测试锁定（决策 D6，已决定）。
  - 保存时检查：工具必须已授权给该员工（来自员工的插件授权）；SEC1 设为"禁用"的工具不能选。
  - 参数值来自前面步骤的输出，可能包含模型生成的内容，按不可信内容对待：只做字符串替换，不做表达式求值，单个值不超过 10000 字。
- A-2：受限轮次。给员工一轮对话，只允许调用这一个工具（需要给 `TurnRunner` 增加按轮限定工具的参数）。完全符合 ADR-0001，但仍然花模型额度，参数也可能被模型改写。作为 D6 不通过时的备选。
- A-3：用 JS 写动作实现。没有沙箱，并且受激活契约阻塞。**不可用**。
- v1.0 只支持 MCP 工具；电脑动作（shell、文件、浏览器）作为动作节点留到以后（决策 D7，已决定）。

### 3.6 流程图（G1）

- 新组件 `flowchart.tsx`：用 CSS 网格和内联 SVG 画纵向流程图，不引入图形库。worker、action、flow 画成矩形，decision 画成菱形，分支线上标 label，跳过和失败的节点用不同样式；运行详情复用同一个组件，按步骤状态着色。
- 编辑仍然以表单为主：点选流程图上的节点，右侧打开该节点的表单（类型、员工、提示词、条件、子流程选择、工具选择）。不做拖拽连线，因为"只能向前"的约束在表单里更容易保证（决策 D8，已决定）。
- WF2 的自然语言生成（`wakerflows/generator.ts`）在 v1.0 只生成 worker 步骤，分支、子流程和动作由人添加（决策 D9，已决定）。

---

## 4. 待决策（已全部决定，2026-11-04）

| 编号 | 问题 | 决定 |
| --- | --- | --- |
| D1 | 计划结构用 P-A（数组加向前跳转）还是 P-B（任意图） | 已决定（2026-11-04）：P-A |
| D2 | worker 提示词放在成员上还是每个步骤上 | 已决定（2026-11-04）：放在成员上，每一步仍有自己的指令 |
| D3 | 是否支持"由员工判定"的分支 | 已决定（2026-11-04）：v1.0 不支持，只用 CEL 表达式 |
| D4 | 步骤上限是否从 10 提到 20 | 已决定（2026-11-04）：提到 20，额度按实际执行的步骤计 |
| D5 | 子流程固定版本还是总用最新版本 | 已决定（2026-11-04）：固定版本，编辑器提示有新版本 |
| D6 | 动作节点用 A-1（直调工具，补 ADR）还是 A-2（受限轮次） | 已决定（2026-11-04）：A-1，前提是 ADR 补充条款签字，并有测试锁定两道闸 |
| D7 | 动作节点是否支持电脑动作 | 已决定（2026-11-04）：v1.0 只支持 MCP 工具 |
| D8 | 流程图是否支持拖拽连线 | 已决定（2026-11-04）：不支持，点选节点后用表单编辑 |
| D9 | 自然语言生成是否产出分支、子流程和动作 | 已决定（2026-11-04）：v1.0 只生成 worker 步骤 |
| D10 | 嵌套深度上限 | 已决定（2026-11-04）：3 |

---

## 5. 分阶段计划

前置：WF8-3（版本表，嵌套固定版本要用）、WF8-5（运行事件）已合入。迁移编号按总览预留，本故事用 **0138**。新增服务端测试后运行 `bun scripts/ci/server-shards.mjs --write`。

### WF7-1：计划结构、校验与 worker 提示词（服务端，无迁移，6 个文件）
- 文件：`shared/wakerflows.ts`、`server/src/wakerflows/plan.ts`（节点类型、向前跳转、支配分析、CEL 语法检查）、`server/src/wakerflows/store.ts`（编译新字段到模板步骤）、`server/src/db/schema/pipeline.ts`（只改 `PipelineStepRow`/`PipelineStepStateRow` 的 TS 类型，不改列）、`server/src/pipeline/store.ts`（`rolePrompt` 拼进指令）、`server/tests/wakerflow-plan-graph.test.ts`（新增）。
- 验收：
  1. 所有现有计划（没有 `kind`）解析结果与改动前完全一致；`wakerflow-*` 现有测试全部通过。
  2. 向后跳转、指向不存在的步骤、只在一个分支产生的输入被另一分支之后的步骤读取：保存都被拒，错误指向具体字段。
  3. CEL 语法错误在保存时被拒。
  4. 成员带 `prompt` 时，该员工每一步收到的指令以"本流程中你的角色"开头。

### WF7-2：decision 执行（服务端，4 个文件）
- 文件：`server/src/pipeline/decision.ts`（新增，纯函数：求值与选分支）、`server/src/pipeline/store.ts`（`advance()` 按 `kind` 分派，处理跳转和 `skipReason`）、`server/tests/pipeline-decision.test.ts`（新增）、`server/tests/wakerflow-run.integration.test.ts`（增加分支运行）。
- 验收：
  1. 两分支流程：输入使条件为真时只执行 A 分支，B 分支步骤为 `skipped`（`skipReason: "branch"`），步骤执行器的调用次数等于 A 分支的步数。
  2. 表达式运行时出错：decision 步骤 `failed`，运行 `failed`，后续步骤没有执行。
  3. decision 步骤不创建员工轮次，不计入模型用量。
  4. 产生 `branch_taken` 事件。
  5. 总结的缺失提示不包含分支跳过的步骤。

### WF7-3：嵌套 Flow（服务端，迁移 0138，8 个文件）
- 文件：`sql/0138_group_task_runs_parent.sql`、`meta/_journal.json`、`server/src/db/schema/pipeline.ts`（新列）、`server/src/pipeline/store.ts`（flow 节点停顿、子运行终态回调父运行）、`server/src/wakerflows/store.ts`（启动子运行、保存时防环）、`server/src/wakerflows/recovery.ts`（补做恢复）、`server/src/index.ts`（接线）、`server/tests/wakerflow-nested.integration.test.ts`（新增）。
- 验收：
  1. 父 → 子 → 父继续：父步骤输出等于子运行的结果，父运行 `done`。
  2. 发起人不能使用子 Flow 的某位员工：父步骤失败，原因写明子流程中的哪一步，子运行没有被创建。
  3. A 嵌套 B、B 嵌套 A：保存被拒；深度为 4 时运行时失败。
  4. 中止父运行，子运行同时变为 `aborted`。
  5. 子运行结束后、父运行恢复之前杀掉进程：重启后父运行继续，且子运行没有被重新执行。
  6. 同一个父步骤被驱动两次，只有一个子运行。

### WF7-4：动作节点（服务端，6 个文件）
- 文件：`server/src/pipeline/action-step.ts`（新增：模板替换、两道闸、`callTool`）、`server/src/pipeline/store.ts`、`server/src/wakerflows/plan.ts`（工具必须已授权）、`server/src/wakerflows/store.ts`、`server/src/index.ts`、`server/tests/wakerflow-action-step.integration.test.ts`（新增）。ADR-0001 的补充条款已经写好（`docs/decisions/0001-组团流水线的执行通道.md` 的"补充（2026-11-04）"一节），本阶段的测试按其中的闸门清单逐条锁定。
- 验收：
  1. 动作节点以给定参数调用一次工具，输出等于工具返回的文本；没有模型调用。
  2. 员工被暂停或 Use Bots 关闭：动作被拒，工具一次都没有被调用。
  3. 工具需要审批：这一步停下并带 `approvalId`；批准后工具恰好执行一次；拒绝后这一步失败。
  4. 选择未授权给该员工的工具，或 SEC1 设为禁用的工具：保存被拒。

### WF7-5：流程图与节点编辑（前端，7 个文件）
- 文件：`app/src/components/wakerflow/flowchart.tsx`（新增）、`app/src/components/wakerflow/plan-editor.tsx`、`app/src/lib/wakerflows.ts`（`planProblems` 同步新规则）、`app/src/routes/_authed/_app/wakerflows.$flowId.tsx`、`app/src/components/wakerflow/run-panel.tsx`（运行详情用流程图着色）、`app/tests/wakerflow-flowchart.test.tsx`（新增）、`app/tests/wakerflows-screen.test.tsx`。
- 验收：
  1. 分支流程按菱形和分支线显示，分支 label 可见。
  2. 编辑器中把 `next` 指向前面的步骤时，下拉框里根本没有这些选项。
  3. 运行详情里分支跳过和人工跳过的样式不同，并有文字说明（"分支未选中" / "已跳过"）。
  4. 子流程节点可以点开子 Flow；子 Flow 有新版本时显示提示。

---

## 6. 验收测试

1. `server/tests/wakerflow-plan-graph.test.ts`（纯函数）：向前跳转、支配分析、CEL 语法检查，正反例各至少 10 条；旧计划的兼容性回归。
2. `server/tests/pipeline-decision.test.ts`（纯函数）：分支顺序、`otherwise`、求值错误时失败；不暴露未声明的输入。
3. `server/tests/wakerflow-run.integration.test.ts`、`wakerflow-nested.integration.test.ts`、`wakerflow-action-step.integration.test.ts`：见各阶段验收。全部使用真库和测试替身的步骤执行器，不调用真实模型。
4. ADR-0001 的锁定：一条测试断言 worker 步骤仍然只经过 `createPipelineStepRunner`；另一条断言动作节点在 `guardBotTurn` 或 `headlessTurnRefusal` 拒绝时不调用 `callTool`。
5. 回归：`pipeline-*`、`wakerflow-*`、`recovery-group-pipeline-start-receipts.test.ts` 全部保持通过。
6. 前端：`app/tests/wakerflow-flowchart.test.tsx`、`wakerflows-screen.test.tsx`、`wakerflow-runs.test.tsx`。
