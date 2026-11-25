# 借鉴外部项目的三项改进 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 AG-UI 升到 1.0.5，并在卡片历史里区分「停下」和「出错」；记忆认出本人的纠正；看板卡失败时自动写交接；交付时复跑员工声明的核对命令。

**Architecture:** 全部改在现有模块上，不改无人值守运行的终结事件类型，也不引入外部项目代码：

- 判定逻辑都写成 `xiongbao/shared` 里的纯函数，前后端共用，可以单测，例如停下原因、「测过」说法、改动类命令、数字比对；
- 服务器只做接线：交付门、`runEnded`、抽取、注入、子代理；
- 前端只做显示。

**Tech Stack:** Bun、TypeScript、Hono 服务器、React 前端、drizzle + Postgres、CopilotKit / AG-UI。

**Spec:** `docs/specs/2026-11-25-borrowed-improvements.md`

## Global Constraints

- 开工前提：去品牌化 R1（Task 10–14）已全部合入 main。每个 PR 从最新 origin/main 开分支，不叠分支。
- 升级后，`xiongbao/bun.lock` 里每个 `@ag-ui/*` 和 `@copilotkit/*` 包只能有一个版本；不单独升 `@ag-ui/*`；`@copilotkit/aimock` 不动。
- 不改无人值守运行的终结事件类型：现在以 `RUN_ERROR` 结束的照旧，只改显示。
- 单聊里的停止显示不改。
- 员工抽的记忆要本人确认，确认了才同步。待确认的条目不调 `supersede`、不同步、不删旧条。
- 复跑从不创建审批请求；原来经审批执行的命令不复跑；改动类命令不复跑。
- 新开关一律 `XIONGBAO_*`，默认开，写 `off` 才关：`XIONGBAO_MEMORY_CORRECTIONS`、`XIONGBAO_DELIVERY_RERUN`、`XIONGBAO_DELIVERY_RERUN_CLAIM_GATE`。
- 数值写死如下：
  - 失败交接最多 1500 字符、5 次工具调用、10 个文件；
  - 复跑每条命令超时 120 秒，最多 3 条；数字相对偏差阈值 0.1；挡回满 2 次后第 3 次放行；
  - 附给抽取模型的已有记忆最多 5 条；
  - 纠正提示里旧条内容取前 40 字。
- 面向用户的文字全部用中文。`server/src`、`app/src` 不写字面「熊宝」，用品牌出口。
- 只对改动的文件跑 `bunx biome check --write <files>`。在 `xiongbao/` 下，以下三项要通过：
  - `bunx biome lint --error-on-warnings --diagnostic-level=warn .`
  - `bun run typecheck`
  - `bun run typecheck:tests`

  新增 server 或 app 测试文件后，跑 `bun run test:shards`。
- 中文提交，结尾两行：
  - `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  - `Claude-Session: https://claude.ai/code/session_01MJUqVcFToyopKbNJ4sEoWY`
- 界面有变化的 PR（2、3、4、5）先截图给用户确认，再转为可合并。

## Review Focus

1. 员工的回答里正好在讨论「测试」二字，但交付并没有声称测过。期望：说法门只看 `checks` 和 note 里的说法，不看对话。词表测试加反例「这份测试报告的格式」，这句不算声称测过（Task 9）。
2. 同一条命令前后跑过多次，最近一次失败、更早一次成功。期望：基准取最近一次，挡回并说明「这条命令最近一次没有成功」，而不是拿更早那次去比（Task 10）。
3. 测试输出里带耗时，比如 `Ran 12 tests in 0.53s`、`12 passed in 1.20s`。期望：时间类数字去掉后，结果判一致（Task 9）。
4. 抽取模型返回了附件名单之外的 id，例如 `replaces:<别人的记忆 id>`。期望：按 `new` 处理，绝不碰别人的记忆（Task 5）。
5. 失败那一轮的错误文字或工具参数里带着密钥。期望：失败交接经过 `mask`，密钥不进卡片历史（Task 7）。

---

## PR 1：AG-UI 与 CopilotKit 升级

### Task 1：升级 CopilotKit 与 AG-UI 到同一族版本

**Files:**
- Modify：`xiongbao/package.json`，以及 `xiongbao/server/package.json`、`xiongbao/toolkit/package.json`、`xiongbao/app/package.json`、`xiongbao/extension/package.json` 里的 `@copilotkit/*`（aimock 除外）、`@ag-ui/client|core|proto`、`@ag-ui/mastra`
- Modify：`xiongbao/bun.lock`，只能通过 `bun install` 重新生成
- 可能修改：用到 CopilotKit `ɵ` 私有接口的文件，用 `git grep -n "ɵ" -- xiongbao/server/src xiongbao/toolkit/src xiongbao/app/src` 找出
- 可选修改：`xiongbao/agent-bot`、`xiongbao/agent-langgraph`、`xiongbao/examples/*` 的 `@ag-ui/*`；`xiongbao/agent-langgraph-agui/requirements.txt`

**Interfaces:**
- Produces：`@ag-ui/client` 和 `@ag-ui/core` 1.0.5 的类型。Task 2 要从中取 `RunAgentInput.protocolVersion` 的取值。

- [ ] **Step 1：选版本。** 先看上游有没有升过 CopilotKit（看 M5b 上游同步会话记录，或上游仓库的 `package.json`）。升过就对齐上游版本；没升过，取 npm 上依赖 `@ag-ui/core` 1.0.5、发布满 14 天的最新补丁版。可用 `curl -s https://registry.npmjs.org/@copilotkit/runtime` 查。版本号和理由写进 PR 描述。
- [ ] **Step 2：改版本号并重装。** 改完各 `package.json` 后，在 `xiongbao/` 下运行 `bun install`。
- [ ] **Step 3：校验只有一个版本。**
  运行：`cd xiongbao && grep -oE '"@(ag-ui|copilotkit)/[a-z0-9-]+@[0-9][^"]*"' bun.lock | sed -E 's/@[0-9][^"]*"$//' | sort | uniq -d`
  期望：没有输出，aimock 也只出现一次。
- [ ] **Step 4：核对私有接口。** 逐个检查仓库用到的 `ɵ` 接口在新版本里仍然导出、签名没变。变了的，按新签名改，并在 PR 描述里列出。
- [ ] **Step 5：跑全量检查。**
  运行：`cd xiongbao && bun run typecheck && bun run typecheck:tests && bunx biome lint --error-on-warnings --diagnostic-level=warn . && bun test toolkit && cd server && bun test tests/*.test.ts`
  期望：通过。与 main 上同一批测试对比，不出现新的失败。
- [ ] **Step 6：升级独立 agent 包（可选）。** 按 Files 列出的范围逐个升级，各自跑自己的测试；过不了的退回原版本，并在 PR 描述里写明。
- [ ] **Step 7：做页面冒烟。** 按项目已有的启动方式（`run` 技能或 `xiongbao/README` 的开发启动）跑一遍：单聊发一条、群聊发一条、看板卡跑一轮、例行任务跑一轮、单聊中途按停止。逐项截图保存到 PR 工作目录。期望：五项都正常，没有控制台报错。
- [ ] **Step 8：提交。** 提交说明为 `升级 CopilotKit 与 AG-UI 到 1.0.5 一族`。

---

## PR 2：「取消」结局与卡片历史分类

### Task 2：浏览器运行带上 protocolVersion

**Files:**
- Modify：前端发起运行、构造 `RunAgentInput` 的那一层。入口在 `xiongbao/app/src/components/channels/channel-chat.tsx:1373`、`:2001` 的 `copilotkit.runAgent`，往下追到 CopilotKit 提供的配置位或 agent 构造处。仓库外的库不改；只能在仓库内设的，在仓库内设。
- Test：`xiongbao/server/tests/run-cancelled-outcome.test.ts`（新建）
- Modify：确认 `outcome.type` 的读取点不会误判，位置在 `xiongbao/server/src/computer/turn-artifacts.ts:114`、`learning/remote.ts:221`、`threads/chat-server-tools.ts:182`

**Interfaces:**
- Consumes：Task 1 的 `@ag-ui/core` 1.0.5。

- [ ] **Step 1：写失败测试。**
  `run-cancelled-outcome.test.ts` 用 CopilotKit 内置 agent 和 aimock 起一轮，期间中止，断言流的最后一个事件满足：
  ```ts
  expect(last.type).toBe(EventType.RUN_FINISHED);
  expect(last.outcome).toEqual({ type: "cancelled" });
  ```
  再加一个用例：`turn-artifacts`、`remote`、`chat-server-tools` 各自的结局判定函数，在输入 `{ type: "cancelled" }` 时不当成 interrupt，也不当成交付成功。
- [ ] **Step 2：运行，确认失败。**
  运行：`cd xiongbao/server && bun test tests/run-cancelled-outcome.test.ts`
  期望：第一个用例失败，因为 `outcome` 为 `undefined`。
- [ ] **Step 3：实现。** 让浏览器发起的运行输入带上 `protocolVersion`，值取 `@ag-ui/core` 1.0.5 schema 的当前协议版本常量。三处读取点按需加 `cancelled` 分支。
- [ ] **Step 4：运行，确认通过。** 命令同 Step 2，期望通过。
- [ ] **Step 5：提交。** 提交说明为 `运行带 protocolVersion，停止以 cancelled 结局结束`。

### Task 3：卡片历史区分「被停下」和「出错」

**Files:**
- Create：`xiongbao/shared/run-stop.ts`
- Test：`xiongbao/shared/run-stop.test.ts`、`xiongbao/server/tests/delivery-events.test.ts`（追加用例）、`xiongbao/app/tests/delivery-run-stop.test.tsx`（新建）
- Modify：`xiongbao/server/src/tasks/events.ts:127-131`、`xiongbao/app/src/lib/tasks/delivery.ts:559-570`
- Modify：把 `RUN_ENDED_EARLY` 和 `SEGMENT_LIMIT_MESSAGE` 的字符串常量改为从 `xiongbao/shared/run-stop.ts` 导出，`toolkit/src/headless-tools.ts` 和 `learning/remote.ts` 改为从这里导入。如果 toolkit 不能依赖 shared，就反过来由 shared 引用 toolkit 的常量，以仓库现有的依赖方向为准。

**Interfaces:**
- Produces：
  ```ts
  export type RunStopReason = "ended_early" | "segment_limit" | "timeout";
  export function runStopReasonOf(error: string): { reason: RunStopReason; seconds?: number } | null;
  export function runStopText(stop: { reason: RunStopReason; seconds?: number }): string;
  // runStopText 的返回值：
  //   ended_early   → "提前结束"
  //   segment_limit → "步数到顶"
  //   timeout       → "超时 N 秒"（没有 seconds 时为「超时」）
  ```
  Task 7 用 `runStopReasonOf` 和 `runStopText` 写失败交接里「停在哪」那一句。

- [ ] **Step 1：写失败测试。**
  ```ts
  test("认出三种停下", () => {
    expect(runStopReasonOf(RUN_ENDED_EARLY)).toEqual({ reason: "ended_early" });
    expect(runStopReasonOf(SEGMENT_LIMIT_MESSAGE)).toEqual({ reason: "segment_limit" });
    expect(runStopReasonOf("The routine's turn was stopped after 1500s.")).toEqual({ reason: "timeout", seconds: 1500 });
    expect(runStopReasonOf("The subagent did not finish: The routine's turn was stopped after 90s.")).toEqual({ reason: "timeout", seconds: 90 });
    expect(runStopReasonOf("ECONNRESET")).toBeNull();
  });
  test("说法", () => { expect(runStopText({ reason: "timeout", seconds: 1500 })).toBe("超时 1500 秒"); });
  ```
  在 `delivery-events.test.ts` 追加：detail 为 `{ error: SEGMENT_LIMIT_MESSAGE }` 的 `run_failed`，文字为「这一轮被停下了：步数到顶」；`{ error: "ECONNRESET" }` 仍以「这一轮出错了」开头。
  在 app 测试里，同样两条显示的分别是「这一轮被停下了：步数到顶」（不带 warn 样式）和「这一轮出错了」（带 warn 样式）。
- [ ] **Step 2：运行，确认失败。**
  运行：`cd xiongbao && bun test shared/run-stop.test.ts server/tests/delivery-events.test.ts app/tests/delivery-run-stop.test.tsx`
- [ ] **Step 3：实现。** `run-stop.ts` 按上面的签名实现；超时用 `/stopped after (\d+)s/` 匹配，允许外面再包一层前缀。`events.ts` 与 `delivery.ts` 在 `superseded` 分支之后、出错分支之前插入停下分支。
- [ ] **Step 4：运行，确认通过。** 命令同 Step 2。
- [ ] **Step 5：截图并提交。** 卡片历史里两种显示各截一张，存进台账目录。提交说明为 `卡片历史把被停下和出错分开显示`。

---

## PR 3：记忆的纠正信号

### Task 4：记忆表加三列，存储读写

**Files:**
- Modify：`xiongbao/server/src/db/schema/memory.ts:51-103`（`personalMemories`）
- Create：`xiongbao/server/drizzle/0081_memory_corrections.sql` 以及 meta。编号接 main 当前最大号顺延，用 `bun run db:generate` 生成；生成命令以 `server/package.json` 为准。
- Modify：`xiongbao/server/src/memory/types.ts`（`MemoryRecord`、`formedMemorySchema` / `FormedMemoryInput`）、`xiongbao/server/src/memory/store.ts`（`formMemory`:389、`update`:479、读取映射）
- Test：`xiongbao/server/tests/memory-store.integration.test.ts`（追加）

**Interfaces:**
- Produces：
  ```ts
  // MemoryRecord 新增
  fromCorrection: boolean;      // 列 from_correction，默认 false
  correctionCount: number;      // 列 correction_count，默认 0
  replacesId: string | null;    // 列 replaces_id，可空，无外键级联；删除旧条时由代码清空引用
  // FormedMemoryInput 新增可选字段 fromCorrection?、correctionCount?、replacesId?
  // MemoryStore 新增
  bumpCorrection(ownerUserId: string, id: string): Promise<void>; // correction_count+1，updated_at=now，只改本人的
  ```

- [ ] **Step 1：写失败测试。** 新增三个用例：
  - `formMemory` 传入 `fromCorrection: true, correctionCount: 1, replacesId` 后，读回字段一致；
  - 不传这些字段时，读回 `false / 0 / null`；
  - `bumpCorrection` 让次数加一；用别人的 `ownerUserId` 调用不改任何东西。
- [ ] **Step 2：运行，确认失败。**
  运行：`cd xiongbao/server && TEST_DATABASE_URL=... bun test tests/memory-store.integration.test.ts`。本机没有数据库就以 CI 为准，并在报告里写明。
- [ ] **Step 3：实现 schema、迁移和存储。**
- [ ] **Step 4：运行，确认通过。**
- [ ] **Step 5：提交。** 提交说明为 `记忆加纠正来源、纠正次数与取代关系三列`。

### Task 5：抽取认出纠正，判断重复与取代

**Files:**
- Modify：`xiongbao/server/src/memory/extract.ts`（`EXTRACTION_SYSTEM`:77、`parseExtraction`:203、`extractMemories`:268、`createMemoryExtractor`:322）
- Test：`xiongbao/server/tests/memory-extract.test.ts`（追加）、`memory-extract.integration.test.ts`（追加）

**Interfaces:**
- Consumes：Task 4 的字段与 `bumpCorrection`。
- Produces：
  ```ts
  export const MAX_RELATED_MEMORIES = 5;
  export function memoryCorrectionsEnabled(env?: Record<string, string | undefined>): boolean; // XIONGBAO_MEMORY_CORRECTIONS
  export type MemoryRelation = { type: "new" } | { type: "repeats"; id: string } | { type: "replaces"; id: string };
  // ObservedMemory 新增：correction: boolean; relation: MemoryRelation
  export function parseExtraction(text: string, relatedIds?: readonly string[]): ObservedMemory[];
  ```

- [ ] **Step 1：写失败测试。** `memory-extract.test.ts` 追加以下用例：
  - `parseExtraction` 收到 `{"memories":[{"content":"周报用 Excel 不用 Word","kind":"preference","confidence":0.9,"correction":true,"relation":"replaces:m1"}]}`，`relatedIds=["m1"]`，得到 `relation: {type:"replaces", id:"m1"}` 和 `correction: true`；
  - 同一输入但 `relatedIds=[]`，`relation` 为 `{type:"new"}`（Review Focus 4）；
  - 输入 `relation: "repeats:m1"` 得到 repeats；缺省或非法时得到 new；
  - `memoryCorrectionsEnabled({XIONGBAO_MEMORY_CORRECTIONS:"off"})` 为 false，其余为 true；
  - 开关关闭时，`correction:true` 的条目被丢弃，非纠正条目照常保留。
  - `memory-extract.integration.test.ts` 追加写入规则三例：
    - 纠正加 repeats，且目标也是纠正：不新增行，目标次数加一；
    - 纠正加 replaces：新增一行，字段为 `fromCorrection=true, correctionCount=1, replacesId=目标`，目标行未变，也没有调用 `supersede`。测试里给 intelligence 打桩，断言调用次数为 0；
    - 非纠正条目：沿用原来的重复判定。
- [ ] **Step 2：运行，确认失败。**
  运行：`cd xiongbao/server && bun test tests/memory-extract.test.ts`
- [ ] **Step 3：实现。**
  - **提示词：** 在 `EXTRACTION_SYSTEM` 里加纠正的定义。正例：本人指出员工做错并说明应该怎样，如「不是这样，要……」「我说过别……」「以后……」。反例：员工的自我更正；只对这件事有效的一次性改需求。要求输出 `correction` 和 `relation`。
  - **附相关记忆：** 用户消息里附上「已有记忆」，最多 `MAX_RELATED_MEMORIES` 条，每条带 id 和内容，按与本轮人话的 `similarity` 从高到低挑选。
  - **写入：** 按规格 5.3 的三条写入规则。
- [ ] **Step 4：运行，确认通过。** 运行 Step 2 的命令，再加 integration 测试。
- [ ] **Step 5：提交。** 提交说明为 `记忆抽取认出本人纠正，判断重复与取代`。

### Task 6：注入排序与提示、确认后旧条退役、记忆页标记

**Files:**
- Modify：`xiongbao/server/src/memory/ingestion.ts`（`quoteMemoryContext`:136 及排序处）
- Modify：`xiongbao/server/src/memory/store.ts`（`update`:479，状态变为 confirmed 或 edited 时）
- Modify：`xiongbao/app/src/components/memory/memories.tsx`（列表项与确认按钮，约 :245）
- Test：`xiongbao/server/tests/memory-unconfirmed.test.ts`（追加）、`memory-store.integration.test.ts`（追加）、`xiongbao/app/tests/bot-memory.test.tsx`（追加）

**Interfaces:**
- Consumes：Task 4 的字段。
- Produces：注入块里固定的三种说法：
  - `本人最近纠正了『<旧条前 40 字>』，以这条为准`
  - `本人纠正过 N 次`
  - 旧条上加 `已被本人最近的纠正取代，以纠正为准`

- [ ] **Step 1：写失败测试。**
  - **注入：** 待确认记忆里有一条纠正和一条普通的，相关度相同时纠正排在前面。有 `replacesId` 的纠正带「本人最近纠正了『…』，以这条为准」，旧条带「已被本人最近的纠正取代」。`correctionCount=2` 的条目带「本人纠正过 2 次」。
  - **退役：** 把一条带 `replacesId` 的纠正 `update` 为 confirmed 后：
    - 旧条已删除（走 `remove`，镜像撤下）；
    - 新条的变更记录里有旧条内容；
    - 其他行中指向旧条的 `replacesId` 被清空。

    把纠正删除后，旧条仍然在。旧条是 `formedBy: "person"` 时，确认纠正后同样会删除。
  - **页面：** 来自纠正的条目显示「纠正」标记和次数。有 `replacesId` 的显示「将取代：<旧条>」，确认按钮旁有「确认后旧条会被删除」。
- [ ] **Step 2：运行，确认失败。**
  运行：`cd xiongbao && bun test server/tests/memory-unconfirmed.test.ts app/tests/bot-memory.test.tsx`
- [ ] **Step 3：实现。** 新条的「变更记录」沿用 store 现有的编辑历史或来源字段；没有现成字段时，把旧条内容写进新条的 `source` 备注，并在报告里说明。
- [ ] **Step 4：运行，确认通过。**
- [ ] **Step 5：截图并提交。** 记忆页截一张。提交说明为 `纠正在注入中优先，确认后旧条退役，记忆页显示纠正`。

---

## PR 4：失败交接

### Task 7：看板卡失败交接的生成、存储与带入下一轮

**Files:**
- Create：`xiongbao/server/src/tasks/failure-handoff.ts`
- Modify：`xiongbao/server/src/db/schema/task-events.ts:9`（`TASK_EVENT_KINDS` 加 `"failure_handoff"`；如果枚举落在数据库约束里，就加迁移）
- Modify：`xiongbao/server/src/tasks/delivery.ts`（`runEnded`:868，失败分支）
- Modify：开新一轮的入口：`xiongbao/server/src/tasks/card-turns.ts`（`startThreadTurn`:216 的调用方 `sendAsUser`）、`tasks/nudge-run.ts`；以及 `tasks/delivery-checker.ts` 的 `handoverText`:447
- Modify：`xiongbao/server/src/tasks/events.ts`、`xiongbao/app/src/lib/tasks/delivery.ts`，加「失败交接」的显示，可展开
- Test：`xiongbao/server/tests/failure-handoff.test.ts`（新建）、`delivery-store.integration.test.ts`（追加）、`delivery-checker.integration.test.ts`（追加）

**Interfaces:**
- Consumes：Task 3 的 `runStopReasonOf`、`runStopText`。
- Produces：
  ```ts
  export const FAILURE_HANDOFF_CHARS = 1500;
  export type RunStep = { tool: string; summary: string; ok: boolean };
  export type FailureHandoff = { stoppedAt: string; progress: string | null; steps: RunStep[]; files: string[] };
  export function failureHandoffOf(input: { error: string; events: readonly BaseEvent[]; progress: string | null }): FailureHandoff;
  export function renderFailureHandoff(handoff: FailureHandoff): string; // 不超过 1500 字符，已经过 mask
  export function lastStepsOf(events: readonly BaseEvent[], limit: number): RunStep[];   // Task 8 复用
  export function writtenFilesOf(events: readonly BaseEvent[], limit: number): string[]; // Task 8 复用
  // Delivery 新增
  takeFailureHandoff(tenantId: string, taskId: string): Promise<string | null>; // 取最近一份还没带过的，并标记为已带过
  ```

- [ ] **Step 1：写失败测试。** `failure-handoff.test.ts`：
  - **输入：** 构造 7 次工具调用，其中最后一次失败、一次 `computer_write_file`，错误为 `SEGMENT_LIMIT_MESSAGE`，进度为「表格做了一半」。
  - **断言：**
    - `stoppedAt` 为「被停下了：步数到顶」；
    - `steps` 是最后 5 次，最后一次 `ok:false`；
    - `files` 含写过的那个路径；
    - `renderFailureHandoff` 的输出含「先看上面的进度和文件，从断点接着做，别从头再来」，且长度不超过 1500。
  - **超长：** 10 个超长参数的输出也不超过 1500。
  - **脱敏（Review Focus 5）：** 错误文字含 `sk-` 开头的 32 位密钥时，渲染结果里不出现该密钥。
  - `delivery-store.integration.test.ts`：
    - 失败的 `runEnded` 写出 `run_failed` 和 `failure_handoff` 两条事件；
    - 被接替的轮不写；
    - `takeFailureHandoff` 第一次返回内容，第二次返回 null。
  - `delivery-checker.integration.test.ts`：失败之后，催办的开头消息以失败交接开头；换人的 `handoverText` 里含失败交接。
- [ ] **Step 2：运行，确认失败。**
  运行：`cd xiongbao/server && bun test tests/failure-handoff.test.ts`
- [ ] **Step 3：实现。**
  - `runEnded` 失败分支：从这一轮的运行事件（`threadRunEvents`）生成失败交接，在同一事务里写入。
  - `stoppedAt` 的取法：
    - 停下类：「被停下了：」加 `runStopText`；
    - 其他错误：「出错了：」加错误首句，最多 80 字。
  - 开新一轮的三个入口在拼开头消息前，先调用 `takeFailureHandoff`，有内容就放在最前面，用空行分隔。
- [ ] **Step 4：运行，确认通过。** 运行 Step 2 的命令，再加两个 integration 测试。
- [ ] **Step 5：截图并提交。** 卡片历史的失败交接截一张。提交说明为 `看板卡失败自动写交接并带入下一轮`。

### Task 8：子代理没做完时交回进度

**Files:**
- Modify：`xiongbao/server/src/agents/subagent.ts:343-351`（error 分支）
- Modify：`xiongbao/shared/subagent.ts:130-170`（`SubagentResult` 的 error 形状加可选 `progress`）
- Test：`xiongbao/server/tests/subagent-progress.test.ts`（新建）

**Interfaces:**
- Consumes：Task 7 的 `lastStepsOf`、`writtenFilesOf`、`FAILURE_HANDOFF_CHARS`，以及 `mask`。
- Produces：`{ error: string; progress?: { steps: RunStep[]; files: string[] }; threadId; steps; ms }`

- [ ] **Step 1：写失败测试。**
  - 子代理线程里有 6 次工具调用后抛出 `SEGMENT_LIMIT_MESSAGE`：结果的 `progress.steps` 长度为 5，`files` 含写过的文件，`readSubagentResult` 能读回。
  - 父运行中止时照旧抛出，不返回结果。
- [ ] **Step 2：运行，确认失败。**
  运行：`cd xiongbao/server && bun test tests/subagent-progress.test.ts`
- [ ] **Step 3：实现。** 在 error 分支读子代理线程的运行事件，生成 progress。序列化后（JSON 文本长度）超过 1500 字符时，先去掉 files，再截短 steps。
- [ ] **Step 4：运行，确认通过。**
- [ ] **Step 5：提交。** 提交说明为 `子代理没做完时交回最后几步与写过的文件`。

---

## PR 5：交付时复跑核对命令

### Task 9：共享判定函数（说法、改动类命令、数字比对）

**Files:**
- Create：`xiongbao/shared/rerun.ts`
- Test：`xiongbao/shared/rerun.test.ts`

**Interfaces:**
- Produces：
  ```ts
  export const RERUN_MAX = 3;
  export const RERUN_TIMEOUT_MS = 120_000;
  export const RERUN_DRIFT = 0.1;
  export const NO_RERUN_PREFIX = "无法复跑：";
  export const TESTED_CLAIM_WORDS: readonly string[]; // 测试、测过、跑过、运行过、跑通、通过、校验过、验证过、passed、tests pass、pytest、jest、vitest
  export function claimsTested(texts: readonly string[]): boolean;
  export function isRerunnable(command: string): { ok: true } | { ok: false; why: string }; // 要求符合 VERIFYING_COMMAND，且不含改动类片段
  export function numbersOf(output: string): number[]; // 已去掉时间类数字
  export function outputsAgree(before: { exitCode: number; output: string }, after: { exitCode: number; output: string }): { agree: true } | { agree: false; why: string };
  ```
  `VERIFYING_COMMAND` 与 `IN_PLACE_COMMAND` 从 `shared/verify.ts` 导出后复用，不要复制一份。

- [ ] **Step 1：写失败测试。**
  ```ts
  expect(claimsTested(["跑过 bun test，全部通过"])).toBe(true);
  expect(claimsTested(["这份测试报告的格式已统一"])).toBe(false); // Review Focus 1
  expect(claimsTested(["表格已按要求排版"])).toBe(false);
  expect(isRerunnable("bun test tests/a.test.ts").ok).toBe(true);
  expect(isRerunnable("pytest -q").ok).toBe(true);
  for (const bad of ["bun test > out.txt", "make install", "make deploy", "git commit -am x && bun test",
    "rm -rf dist && bun run build", "curl -X POST https://x/test", "curl -d a=1 https://x/check",
    "npm publish", "docker push x", "kubectl apply -f k.yaml", "sed -i s/a/b/ f && bun test", "bun test | tee log"])
    expect(isRerunnable(bad).ok).toBe(false);
  expect(isRerunnable("ls -la").ok).toBe(false); // 不是核对类命令
  expect(numbersOf("Ran 12 tests in 0.53s\n12 passed in 1.20s at 2026-11-25 10:31:07")).toEqual([12, 12]); // Review Focus 3
  expect(outputsAgree({ exitCode: 0, output: "rows: 100" }, { exitCode: 0, output: "rows: 105" })).toEqual({ agree: true });
  expect(outputsAgree({ exitCode: 0, output: "rows: 100" }, { exitCode: 0, output: "rows: 111" }).agree).toBe(false);
  expect(outputsAgree({ exitCode: 0, output: "ok" }, { exitCode: 1, output: "ok" }).agree).toBe(false);
  expect(outputsAgree({ exitCode: 0, output: "a 1 b 2" }, { exitCode: 0, output: "a 1" }).agree).toBe(false); // 数字个数不同
  ```
- [ ] **Step 2：运行，确认失败。**
  运行：`cd xiongbao && bun test shared/rerun.test.ts`
- [ ] **Step 3：实现。**
  - 相对偏差：`|a−b| > RERUN_DRIFT × max(|a|,|b|)` 算不一致；两边都为 0 算一致。
  - 截断：基准被截断时（调用方传入截断后的文字），只比较两边都有的前若干个数字。为此给 `outputsAgree` 加可选参数 `beforeTruncated?: boolean`。
  - 数字正则：`-?\d+(\.\d+)?`。
  - 先去掉三类时间数字：
    - 紧跟单位 `ms|s|sec|秒|分|min|h` 的数字；
    - 日期 `\d{4}-\d{2}-\d{2}`；
    - 时刻 `\d{1,2}:\d{2}(:\d{2})?`。
- [ ] **Step 4：运行，确认通过。**
- [ ] **Step 5：提交。** 提交说明为 `复跑核对的共享判定：说法、改动类命令、数字比对`。

### Task 10：deliver_task 的复跑声明、说法门与复跑执行

**Files:**
- Create：`xiongbao/server/src/tasks/rerun-gate.ts`
- Modify：`xiongbao/server/src/tasks/delivery-tools.ts`（`deliverSchema`:155 加 `rerun`；工具说明:404 加一句；接在现有交付门之后，约 :435-520）
- Modify：`xiongbao/server/src/approvals/service.ts`，新增一个无副作用的预判方法
- Modify：`xiongbao/server/src/tasks/projector.ts:151`（`DeliverableRef` 加 `reruns`）
- Test：`xiongbao/server/tests/rerun-gate.test.ts`（新建）、`delivery-tools.integration.test.ts`（追加）

**Interfaces:**
- Consumes：Task 9 的全部导出；`shared/verify.ts` 的 `ranCheckCommand`；`ComputerGateway.runCommand(seat, actor, { command, timeoutMs }, signal)` 返回 `RunCommandResult { exitCode, stdout, stderr, truncated, timedOut }`（`computer/schema.ts:344`）。
- Produces：
  ```ts
  // approvals/service.ts
  wouldAllow(candidate: ApprovalCandidate): Promise<boolean>;
  // 判定逻辑与 gate() 相同（同一套 decideAction 输入），但只读：
  // 不写请求、不提问、不调审查模型（需要审查的一律返回 false），只有直接放行才返回 true。
  // tasks/rerun-gate.ts
  export const RERUN_BOUNCE_KEY = "rerunBounce";
  export const CLAIM_BOUNCE_KEY = "rerunClaimBounce";
  export function deliveryRerunOn(env?): boolean;      // XIONGBAO_DELIVERY_RERUN
  export function rerunClaimGateOn(env?): boolean;     // XIONGBAO_DELIVERY_RERUN_CLAIM_GATE
  export type RerunOutcome = { command: string; result: "passed" | "mismatch" | "unverified"; why?: string };
  export type CardCommandRun = { command: string; exitCode: number; output: string; truncated: boolean; approved: boolean; at: number };
  export function cardCommandRuns(events: readonly BaseEvent[]): CardCommandRun[]; // 从这张卡各轮的运行事件里读出 computer_run_command 调用及结果
  export function claimBounce(input: { rerun: string[]; checks: string[]; notes: string[]; alreadyBounced: boolean }): string | null;
  export async function rerunChecks(input: { commands: string[]; runs: CardCommandRun[]; canExecute: boolean; wouldAllow: (command: string) => Promise<boolean>; run: (command: string) => Promise<RunCommandResult>; }): Promise<{ bounce: string | null; outcomes: RerunOutcome[] }>;
  ```

- [ ] **Step 1：写失败测试。** `rerun-gate.test.ts`，全部用桩函数：
  - **说法门：**
    - `claimBounce({ rerun: [], checks: ["跑过 bun test，全部通过"], notes: [], alreadyBounced: false })` 返回挡回文字，内容含 `rerun` 和「无法复跑：」；
    - `alreadyBounced: true` 时返回 null；
    - `checks` 里有「无法复跑：本机没有测试环境」时返回 null；
    - `rerun` 非空时返回 null。
  - **复跑：**
    - 命令在 runs 里最近一次退出码为 0，复跑输出一致：结果为 `passed`。
    - 最近一次失败、更早一次成功：`bounce` 含「这条命令最近一次没有成功」（Review Focus 2）。
    - runs 里没有这条命令：结果为 `unverified`，原因是「这张卡里没跑过这条命令」，不挡回。
    - 基准为 `approved: true`：结果为 `unverified`，并且 `run` 一次都没被调用。
    - `wouldAllow` 返回 false：结果为 `unverified`，`run` 没被调用。
    - `canExecute: false`：全部为 `unverified`。
    - 改动类命令：结果为 `unverified`，原因取 `isRerunnable` 给的 why。
    - 复跑退出码变成 1：`bounce` 里含命令、两次退出码、两边输出末尾。
  - **`delivery-tools.integration.test.ts`：**
    - 同一张卡复跑不一致被挡回 2 次后，第 3 次交付成功，卡片交付记录里 `reruns` 带「复核不一致」标记；
    - `XIONGBAO_DELIVERY_RERUN=off` 时不复跑；
    - 外部员工的交付不经过这两道门。
- [ ] **Step 2：运行，确认失败。**
  运行：`cd xiongbao/server && bun test tests/rerun-gate.test.ts`
- [ ] **Step 3：实现。**
  - `deliverSchema` 加 `rerun: z.array(z.string().max(500)).max(RERUN_MAX).default([])`。工具说明末尾加一句原文：「rerun 原样写你这张卡里跑过、能证明结果的核对命令（测试、校验脚本、统计数），服务器会在你的电脑上再跑一次核对；没有能复跑的，在 checks 里写一条『无法复跑：原因』。」
  - 交付门接线顺序：现有交付门 → 说法门 → 复跑。被挡回的写 `bounced` 事件，返回值形状与现有交付门一致，并带上对应的 key，供「每轮只挡一次」和「累计 2 次」的判断使用。
  - 累计次数从卡片的 `bounced` 事件里数 `RERUN_BOUNCE_KEY`。
  - `canExecute` 取 false 的情况：配对的个人电脑、设备模式、电脑不在线。判断方式与 `file-evidence.ts` 的 unverified 判定一致。
  - 复跑走员工自己的座位和身份。用 `runCommand` 执行，`timeoutMs` 设为 `RERUN_TIMEOUT_MS`，跟随本次工具调用的 `signal`。
  - `approved` 的判定：这次调用的结果是由审批 resume 执行产生的。去审批存储里找 action digest 对得上、且已执行的请求。在测试里固定。
- [ ] **Step 4：运行，确认通过。** 运行 Step 2 的命令，再加 integration 测试。
- [ ] **Step 5：提交。** 提交说明为 `交付时复跑员工声明的核对命令，声称测过却没声明的挡回一次`。

### Task 11：卡片交付详情显示复核结果

**Files:**
- Modify：`xiongbao/app/src/lib/tasks/delivery.ts` 及卡片交付详情组件。组件用 `git grep -n "checks" -- xiongbao/app/src/components` 找自查显示处，复核结果显示在它旁边。
- Test：`xiongbao/app/tests/delivery-rerun.test.tsx`（新建）

**Interfaces:**
- Consumes：Task 10 写进 `DeliverableRef.reruns` 的 `RerunOutcome[]`，以及「复核不一致」标记。

- [ ] **Step 1：写失败测试。** 三条结果分别显示为：
  - 「复核通过：<命令>」
  - 「复核不一致：<命令>」，带 warn 样式
  - 「未复核：<命令>（<原因>）」

  带「复核不一致」标记的卡片，交付详情顶部有一行警告：「复跑结果和员工说的不一致，验收时请留意」。
- [ ] **Step 2：运行，确认失败。**
  运行：`cd xiongbao/app && bun test tests/delivery-rerun.test.tsx`
- [ ] **Step 3：实现。**
- [ ] **Step 4：运行，确认通过。**
- [ ] **Step 5：截图并提交。** 截图存进台账目录。提交说明为 `卡片交付详情显示复核结果`。

---

## 收尾

- 每个 PR 合入前，全部 CI 检查为绿。界面有变化的 PR 要等用户确认截图后，再转为可合并。
- 五个 PR 全部合入后，在 `docs/acceptance/STORIES.md` 追加三条故事（纠正、失败交接、复跑），附上对应 PR 的链接。
