# 熊宝员工四项能力深度优化 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal：** 把员工的常规办公和编码、常驻和主动、记忆和自我改进、token 消耗四项能力补到对标水平。每一期都用 DeepSeek 评测数字验收。

**Architecture：** 五期，每期一个独立 PR，CI 全绿后合入 main，合入后从 main 触发评测核对数字。全部复用现有机制，不另造执行器：
- 评测：`xiongbao/scripts/e2e/employee-eval/`
- 记忆：`server/src/memory/`
- 技能：`server/src/skills/`、`local-learning/`
- 主动：`proactive/`、`routines/`、`work/queue.ts`
- token：`toolkit/src/copilotkit/turn-folding.ts`、`server/src/tool-output.ts`、`server/src/web/tools.ts`、`server/src/threads/compaction.ts`

**Tech Stack：** Bun、TypeScript、Hono、drizzle（Postgres 17 + pgvector）、AG-UI、Playwright 评测。

**Spec：** `docs/specs/2026-11-20-employee-depth-optimization.md`（用户 2026-11-20「方案通过」；技能生效方式选 C）

## Global Constraints

- main 上已有的断言不改，只有两处例外，都已获批：
  - `server/tests/web-tools.test.ts` 的 web_fetch 内联上限断言，跟随 16KB 改为 8KB；
  - 个人版记忆开关相关断言。
- 其他断言要改时，先停下回报 NEEDS_CONTEXT。
- 已有 schema 文件不改，新表、新列走新迁移，编号从 0234 起，先查 main 上最新编号再定。
- 新环境变量只用 `XIONGBAO_*` 前缀，并写进 `.env.example` 和 CHANGELOG 的 `## Unreleased`。
- 注释和代码里不写上游目录名或包名（`copilotkit`、`openbot`）；toolkit 不新增 `@openbot/*` 引用。提交后在 app 下跑：`BRAND_BASE=origin/main BRAND_HEAD=HEAD bun test tests/brand-new-lines.test.ts tests/brand-budget.test.ts tests/brand-leak.test.ts`。
- 测试里不写 `expect(x?.y).toBeUndefined()`，用 `not.toHaveProperty`；新 server 测试文件用 `bun scripts/ci/server-shards.mjs --write` 登记。
- 技能生效方式 C：员工自己生效的技能自动启用；共享给其他员工或团队要本人批准。
- 主动行为必须遵守安静时段（标了紧急的触发器除外），且受现有每日次数上限约束。
- 省 token 不能让评测通过率下降。
- 提交末尾两行：
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01MJUqVcFToyopKbNJ4sEoWY
  ```
- 只有界面改动先截图给用户确认再推送，其余改动 CI 全绿即推。

## Review Focus

1. **员工自写的技能里混进密钥、个人隐私或越权步骤。** 保存前必须脱敏拦截。测试归 Task 2.4。
2. **记忆自动抽取把一次性闲聊或错误信息存成「事实」。** 抽出的记忆一律标「待确认」，不进跨员工共享。测试归 Task 2.2。
3. **心跳在安静时段打扰人，或者没事也开空轮。** 静默结束不产生对话和通知。测试归 Task 3.1。
4. **看板自主认领时两个员工抢同一张卡。** 认领必须原子，用 `for update skip locked`。测试归 Task 3.3。
5. **网页抓取全文落盘后，没有电脑的员工读不回来。** 没有落盘目的地时退回内联截断，并说明。测试归 Task 1.1。

---

## 期 0：评测扩充（PR：feat/eval-hard-suite）

### Task 0.1：难题与电脑操作题

**Files：**
- Create：`scripts/e2e/employee-eval/fixtures/{refactor,terminal,webform,repeat}/`
- Create：`check-{refactor,terminal,webform,repeat}.ts` 及各自的 `*.test.ts`
- Modify：`checkers.ts`、`config.ts`（加入 `hard` 组）

**Interfaces：**
- Produces：每个 checker 都是 `CHECKERS[task](dir) => Promise<TaskResult>`，和现有 checker 同形；`EVAL_TASKS=hard` 时跑 `compare,refactor,terminal,webform`。
- `repeat`：同一题在同一位员工身上连做两次，记录里分别写 `firstRun` 和 `secondRun` 两组指标，给期 2 用。

- [ ] 写判分测试：
  - 拿金标答案能全过；
  - 拿空目录或错误答案会失败。
- [ ] 实现夹具和判分：
  - `refactor`：跨 3 个以上文件改名、抽函数，用隐藏测试判分；
  - `terminal`：依赖缺失加构建错误，修好后测试变绿；
  - `webform`：本地起一个夹具网站，填表提交后，判分读服务端收到的数据；
  - `repeat`：复用 office 题。
- [ ] 跑评测目录全部测试，确认通过后提交。

### Task 0.2：三方对照与提示词体积计量

**Files：**
- Modify：`run-xiongbao.ts`、`report.ts`、`metrics.ts`、`.github/workflows/model-e2e.yml`

**Interfaces：**
- workflow 新增输入 `xiongbao_model`，默认空，表示和 `model` 一样。填了以后，只有熊宝侧用这个模型，Codex 侧仍用 `model`。
- 记录新增 `promptChars`，按段统计：系统提示各段、工具定义、历史；`report.ts` 加一张「提示词体积」表。

- [ ] 写单测：
  - 模型选择函数：`xiongbaoModel(inputs)`；
  - 提示词分段计量函数：`promptBreakdown(requestBody)`。
- [ ] 实现模型选择、分段计量和报告表。
- [ ] workflow 测试（`server/tests/model-e2e-workflow.test.ts`）只新增断言。
- [ ] 提交。

**期 0 验收：** CI 全绿合入后，从 main 触发 `tasks=hard`、`paths=board,chat`，结果作为后续各期的基线写进 `docs/acceptance/`。

---

## 期 1：token 消耗（PR：perf/token-depth）

验收：在期 0 基线上，五道题合计输入 token ≤ Codex 的 1.2 倍，且通过率不降。

### Task 1.1：网页抓取改为落盘加片段读取
- Modify：`server/src/web/tools.ts`、`shared/web-tools.ts`（`WEB_FETCH_LIMITS`）、`server/tests/web-tools.test.ts`（获批的那一处断言）
- 全文写入员工工作区的 `web-pages/`，内联正文最多 8KB，回传摘要、`saved_to` 和读法。
- 没有落盘目的地时，退回截断加说明（Review Focus 5）。

### Task 1.2：记忆按相关程度注入
- Modify：`server/src/memory/tools.ts`（`PersonalMemoryMiddleware`）、`memory/ingestion.ts`（`quoteMemoryContext`）
- Produces：`rankMemories(query, memories, budgetChars) => Memory[]`。
  - 依赖期 2 的向量列时，先按全文相似度排序；
  - 默认预算 `XIONGBAO_MEMORY_INJECT_CHARS=4000`。

### Task 1.3：技能挑选结果缓存
- Modify：`server/src/routing/model.ts`（`createSkillChooser`）
- 同一线程里，消息与上次挑选时的相似度不低于阈值就复用结果，不再调用模型。
- 测试断言：第二条同主题消息不产生挑选调用。

### Task 1.4：轮次之间自动压缩默认打开
- Modify：`server/src/config.ts`（`SIDEBAR_AUTO_COMPACTION` 默认值）、`threads/compaction.ts`
- 新增 `XIONGBAO_AUTO_COMPACTION=off` 作为回退开关。
- 已有「默认关」的断言属于获批范围外，要改时先回报 NEEDS_CONTEXT。

### Task 1.5：轻量轮可配便宜模型
- Modify：`toolkit/src/limits.ts` 周边、员工设置 `shared/hard-model.ts` 同级
- Produces：员工设置新增 `lightModel`，巡检和跟进轮使用它，不设时回退到默认模型。

---

## 期 2：记忆和自我改进（PR：feat/memory-learning）

验收：
- `repeat` 题第二次的步数和 token 比第一次下降 30% 以上；
- 个人版员工能存取记忆。

### Task 2.1：个人版开记忆
- Modify：`server/src/edition.ts:95`（`editionHasMemory`）、相关测试（获批）
- 新增 `XIONGBAO_PERSONAL_MEMORY=off` 作为回退开关。

### Task 2.2：每轮自动抽取记忆
- Create：`server/src/memory/extract.ts`
- Produces：`extractMemories(turnTranscript, model) => ObservedMemory[]`，挂在轮次结束处。
- 用员工的轻量模型；抽出的记忆存为 `save_observed_memory`，状态为待确认（Review Focus 2）。
- 每轮最多 3 条；和已有记忆去重。

### Task 2.3：记忆向量召回
- Create：迁移 `personal_memories.embedding vector(…)`
- Create：`server/src/memory/embed.ts`
- Produces：`embedText(text) => number[] | null`。不可用时返回 null，退回全文检索。
- 供 Task 1.2 的 `rankMemories` 使用。

### Task 2.4：做完复盘与员工自写技能
- Create：`server/src/learning/retrospect.ts`、`server/src/skills/save-tool.ts`
- Produces：
  - 工具 `save_skill({name, when, steps, pitfalls, verify, scope: "self"|"shared"})`；
  - 工具 `refine_skill({id, change})`；
  - `retrospect(turn) => SkillDraft | null`，在步数 ≥ `XIONGBAO_RETRO_MIN_STEPS`（默认 15）或看板卡验收通过后触发。
- 生效规则 C：
  - `scope:self` 直接授予该员工；
  - `scope:shared` 进 `local_skill_candidates` 等本人批准。
- 保存前脱敏：拒绝密钥、令牌、邮箱和手机号等（Review Focus 1）。
- 每位员工上限 `XIONGBAO_SKILLS_PER_EMPLOYEE=50`；最近 30 天没用过的技能，在挑选时降权。
- `local-learning` 改为也读工具轨迹和成败。
- 新增工具在 `shared/tool-name.ts` 里加中文名；提示词只对持有这两个工具的员工追加一段。

---

## 期 3：常驻和主动（PR：feat/heartbeat-autonomy）

验收：心跳、安静时段、自主认领的集成测试全绿；评测新增「主动场景」冒烟：
- 预置一张卡，员工自己认领并完成；
- 安静时段内不发通知。

### Task 3.1：心跳
- Create：`server/src/heartbeat/{schedule,runner}.ts`，复用 `work_items` 队列和巡检的轻量轮。
- Produces：员工设置 `heartbeat: { enabled, intervalMinutes ≥ 15, checklist: string }`；没有事可做时静默结束，不产生对话和通知（Review Focus 3）。
- 工具 `update_heartbeat_checklist` 让员工自己维护清单。

### Task 3.2：安静时段
- Modify：`server/src/user-preferences.ts`（作息）、通知投递与主动开轮的入口
- Produces：`inQuietHours(user, now) => boolean`；触发器带 `urgent:true` 时不受限。

### Task 3.3：看板自主认领
- Modify：`server/src/tasks/runner.ts`
- Produces：`claimNextCard(employeeId) => Card | null`，用 `for update skip locked`（Review Focus 4）。
- 每位员工并行上限 `XIONGBAO_MAX_PARALLEL_CARDS=2`；只认领派给自己岗位、且还没人领的卡。

### Task 3.4：界面（先截图给用户确认）
- 员工设置页新增「心跳」和「安静时段」，看板卡上显示「员工已认领」。

---

## 期 4：办公和编码（PR：feat/work-quality）

验收：期 0 难题通过率不低于 Codex；墙钟不超过 Codex 的 1.2 倍。具体项依期 0 结果增删。

### Task 4.1：改完必验
- Modify：提示词 `<verify>` 段和完成判定。改文件后没有校验动作的轮次，不能直接收尾，要先提醒一次。
- 评测「改完验证」一项要求每题为「是」。

### Task 4.2：Git 工作流工具
- Create：`server/src/computer/git-tools.ts`
- Produces：`git_branch`、`git_commit`、`git_diff_summary`、`open_pull_request`，后者要求员工已有对应连接器。

### Task 4.3：重活分流
- 识别大型编码任务（跨文件数、预计步数），建议转交固定员工 Codex 或 Claude Code，或使用员工的「难任务模型」。
