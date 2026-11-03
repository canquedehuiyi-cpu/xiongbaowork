# 77 故事验收表

规则不变：**一个故事只有在 `main` 上有对应测试通过，才算"已验收"。** 本表没有任何一行是"已验收"。集成分支 `claude/magical-archimedes-8a6ljj` 还没有合进 `main`（走 canquedehuiyi-cpu/xiongbaowork#1 → canquedehuiyi-cpu/xiongbaowork#2），所以已经做完的故事一律写 `integrated (pending main)`。

数据截至 2026-11-03，集成分支 `96a5b41`。状态是读集成分支上的代码和测试得出的，不是照抄 PR 标题：每行的"证据"列只列集成分支上确实存在的测试文件，"备注"写读代码时看到的缺口。PR 编号的出处是 GitHub 上已合并 PR 的 head 是否已在集成分支里（逐个用 `git merge-base --is-ancestor` 核对过）。

## 取值

| 列 | 取值 |
| --- | --- |
| 集成分支状态 | `implemented`：故事要求的行为在集成分支上有代码和测试；`partial`：有一部分，缺口写在备注里；`not started`：没有对应代码 |
| 交付 PR | 交付该故事的已合并 PR。"基线（main 上已有）"表示代码在 `main` 的基线提交里就有，本轮没有 PR 改它；`open PR #N` 表示剩余部分还在未合并的 PR 里 |
| 门 | 覆盖该故事的最终门（见下方门表）。G3 指全套自动测试 |
| 验收状态 | `integrated (pending main)`：已在集成分支、等合进 `main` 后由 `main` 上的 CI 证成；`partly integrated (pending main)`：同上，但故事只做了一部分 |

## 计数

| 集成分支状态 | 故事数 |
| --- | --- |
| implemented | 62 |
| partial | 10 |
| not started | 5 |
| 合计 | 77 |

- partial：A4、C1、F1、F2、F4、F6、J5、K4、AUT3、SEC1。
- not started：RES2、ROLE1、WF7、WF8、WF9。这 5 个都按 11-02 的 MVP 决定移到 v1.0 后。

仍未合并、与故事有关的 PR（截至 `96a5b41`）：

| PR | 内容 | 涉及故事 |
| --- | --- | --- |
| canquedehuiyi-cpu/xiongbaowork#70 | 职责和主动巡检的启停开关 | C1 |
| canquedehuiyi-cpu/xiongbaowork#161 | #58 自动任务运行时的评审修复 | C2、AUT1–AUT4 |
| canquedehuiyi-cpu/xiongbaowork#54 | 支付 provider 接口 | K3；按"只手动"决定**不合并** |

## 故事

| 故事 | 包 | 原始需求（摘要） | 集成分支状态 | 交付 PR | 门 | 证据（集成分支上的测试） | 验收状态 | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A1 | D05 | 作为用户，我在侧边栏看到"工作管理 > 任务看板"，进入后看到统计条：任务总数 / 进行中 / 需要操作 / 已结束（默认数据周期=一个月，… | implemented | 基线（main 上已有）<br>canquedehuiyi-cpu/xiongbaowork#48 | G3 | `app/tests/tasks-stat-bar.test.tsx`<br>`app/tests/tasks-workbench-filters.test.ts`<br>`server/tests/tasks-routes-filters.integration.test.ts` | integrated (pending main) | 侧边栏「工作管理」标题与统计条联动来自 #48 |
| A2 | D05 | 我可以点统计条任一数字过滤下方任务列表（按下态高亮）。 | implemented | 基线（main 上已有） | G3 | `app/tests/tasks-stat-bar.test.tsx`<br>`app/tests/tasks-workbench-board-consistency.test.tsx` | integrated (pending main) | 统计数字是按钮，`aria-pressed` 表示按下态 |
| A3 | D05 | 任务列表含列：任务名、执行者（Waker 头像+名，可点进员工详情）、来源（对话触发/自主工作/交接）、状态（进行中/需要操作/已结束-已完… | implemented | canquedehuiyi-cpu/xiongbaowork#26<br>canquedehuiyi-cpu/xiongbaowork#48 | G3 | `app/tests/tasks-workbench-filters.test.ts`<br>`app/tests/tasks-workbench-board-consistency.test.tsx` | integrated (pending main) |  |
| A4 | D05 | 我可以用搜索框按任务名过滤，用下拉按 Waker/Group、触发方式、状态、数据周期组合过滤。 | partial | canquedehuiyi-cpu/xiongbaowork#48 | G3 | `app/tests/tasks-workbench-filters.test.ts`<br>`app/tests/tasks-workbench-board-consistency.test.tsx`<br>`server/tests/tasks-routes-filters.integration.test.ts` | partly integrated (pending main) | 四个条件都能组合过滤；但只有 Waker/Group 和触发方式是下拉框（`tasks.tsx` 的 `<select>`），状态和数据周期仍是按钮组，与故事写的「下拉」不同 |
| A5 | D05 | 我可以切换"列表/泳道"两个视图；泳道视图按状态分三列（进行中/需要操作/已结束），卡片可拖拽仅进入"已结束"（归档语义），其余方向拖拽无效… | implemented | 基线（main 上已有）<br>canquedehuiyi-cpu/xiongbaowork#26<br>canquedehuiyi-cpu/xiongbaowork#48 | G3 | `app/tests/tasks-attention-lane.test.ts`<br>`app/tests/tasks-workbench-mutations.test.tsx` | integrated (pending main) | 只有「已结束」泳道接受拖放（`onDragOver` 只对 `finished` 放行） |
| A6 | D05 | 我点任务行"查看详情"，进入该任务关联的执行会话（channel 或 routineRun 详情），看到完整过程。 | implemented | 基线（main 上已有）<br>canquedehuiyi-cpu/xiongbaowork#92 | G3 | `app/tests/tasks-open-link.test.tsx`<br>`server/tests/tasks-open-target.integration.test.ts` | integrated (pending main) |  |
| A7 | D05 | "需要关注"区固定在看板上方，含两个 Tab：需要操作(n)/查收结果(n)；空态文案"暂无需要操作的任务——需要你确认、回答或补充信息的任… | implemented | 基线（main 上已有）<br>canquedehuiyi-cpu/xiongbaowork#26<br>canquedehuiyi-cpu/xiongbaowork#42 | G3 | `app/tests/tasks-attention-region.test.tsx`<br>`app/tests/tasks-attention-lane.test.ts` | integrated (pending main) | 空态文案原样在 `tasks.tsx`，并有测试断言 |
| A8 | D05 | 当我在"需要操作"里批准/拒绝某审批，对应任务状态自动流转（批准→进行中；拒绝→已结束-失败），无需刷新。 | implemented | canquedehuiyi-cpu/xiongbaowork#37<br>canquedehuiyi-cpu/xiongbaowork#60<br>canquedehuiyi-cpu/xiongbaowork#156 | G3 | `app/tests/tasks-approval-actions.test.tsx`<br>`server/tests/tasks-approval-decision.integration.test.ts`<br>`server/tests/approvals-question-board.test.ts` | integrated (pending main) |  |
| A9 | D05 | 当某任务产出附件/文件/组件结果，任务进入"查收结果"；我点"查收"后任务转"已结束-已完成"。 | implemented | canquedehuiyi-cpu/xiongbaowork#59 | G3 | `server/tests/task-deliverable.test.ts`<br>`app/tests/tasks-deliverable.test.tsx` | integrated (pending main) |  |
| B1 | D05 | 我在任意频道 composer 输入 @ 出现 Waker 选择列表（仅我可见的员工，含 Group 展开后的成员）。 | implemented | canquedehuiyi-cpu/xiongbaowork#28<br>canquedehuiyi-cpu/xiongbaowork#39 | G3 | `app/tests/channel-dispatch-composer.test.tsx`<br>`app/tests/composer-mention-affordance.test.ts` | integrated (pending main) |  |
| B2 | D05 | @ 某 Waker 发送后：创建一条 task（来源=对话触发，执行者=被 @ 的 Waker），消息路由到该 Waker 并驱动其运行（接… | implemented | canquedehuiyi-cpu/xiongbaowork#28 | G3 | `server/tests/channel-dispatch.test.ts`<br>`server/tests/channel-dispatch.integration.test.ts` | integrated (pending main) |  |
| B3 | D05 | 被 @ 的 Waker 的回复同时出现在频道与任务详情中；任务状态随 run 生命周期流转。 | implemented | canquedehuiyi-cpu/xiongbaowork#28 | G3 | `server/tests/channel-dispatch.integration.test.ts` | integrated (pending main) |  |
| B4 | D05 | 群聊中 Bot 交接（`message_bot`）产生的后续工作自动登记为子任务（来源=交接），在看板执行者列显示接手方。 | implemented | 基线（main 上已有）<br>canquedehuiyi-cpu/xiongbaowork#48 | G3 | `server/tests/handoff-child-card.test.ts`<br>`server/tests/agent-handoff-delivery.test.ts` | integrated (pending main) | 交接卡片 `source: "handoff"`、执行者为接手方（`agents/handoff-delivery.ts`）；看板标签来自 #48 |
| C1 | D06 | 我在"自主工作"页看到所有 Waker 的 routines/responsibilities/proactive 任务清单：下次触发时间、… | partial | canquedehuiyi-cpu/xiongbaowork#42<br>canquedehuiyi-cpu/xiongbaowork#64<br>open PR #70 | G3 | `app/tests/autonomous-screen.test.tsx`<br>`server/tests/autonomous-summary.test.ts`<br>`app/tests/automations-section.test.tsx` | partly integrated (pending main) | routines、职责、主动巡检、自动任务的清单和下次触发时间已在（自动任务区来自 #64）；职责和主动巡检的启停开关在 open PR #70 |
| C2 | D06 | 每次自主触发（routine fire / responsibility trigger）自动创建 task（来源=自主工作），initia… | implemented | canquedehuiyi-cpu/xiongbaowork#41<br>canquedehuiyi-cpu/xiongbaowork#58<br>canquedehuiyi-cpu/xiongbaowork#67 | G3 | `server/tests/proactive.test.ts`<br>`server/tests/unattended-single-card.integration.test.ts`<br>`server/tests/routine-runner.test.ts`<br>`server/tests/automation-waker-executor.test.ts` | integrated (pending main) | open PR #161 修 #58 评审意见（交付物留在卡上、熔断 payload） |
| C3 | D06 | 连续失败熔断（10 次）发生时，对应任务标"已结束-失败"并出现在"需要关注"区。 | implemented | canquedehuiyi-cpu/xiongbaowork#42<br>canquedehuiyi-cpu/xiongbaowork#58 | G3 | `server/tests/routine-runner.test.ts`<br>`app/tests/tasks-attention-region.test.tsx`<br>`server/tests/automation-waker-executor.test.ts` | integrated (pending main) |  |
| C4 | D06 | 我可以在此页新建/暂停/删除 routine（复用现有 `/api/routines`，15 分钟下限与 20 条上限护栏保留）。 | implemented | 基线（main 上已有） | G3 | `app/tests/autonomous-screen.test.tsx`<br>`server/tests/routine-create.integration.test.ts` | integrated (pending main) | 15 分钟下限有断言（`Routines may run at most every 15 minutes.`） |
| H1 | D09 | 租户在"能力与资源 > 模型库"**自助接入**任意多个模型：从平台 provider 模板（OpenAI 兼容/Anthropic/Goo… | implemented | 基线（main 上已有）<br>canquedehuiyi-cpu/xiongbaowork#51<br>canquedehuiyi-cpu/xiongbaowork#55<br>canquedehuiyi-cpu/xiongbaowork#57 | G3 | `server/tests/model-library-routes.test.ts`<br>`server/tests/platform-model-pool.integration.test.ts`<br>`server/tests/platform-model-pool-routes.test.ts`<br>`app/tests/platform-model-pool.test.tsx` | integrated (pending main) |  |
| H2 | D09 | 我创建/编辑 Waker 时，可为其从模型库**单选**一个默认模型（存 `agent_profiles` 扩展字段）；未选则回落部署默认（… | implemented | 基线（main 上已有）<br>canquedehuiyi-cpu/xiongbaowork#55<br>canquedehuiyi-cpu/xiongbaowork#57 | G3 | `server/tests/platform-model-pool-routes.test.ts`<br>`app/tests/agent-dialog-built-in-edit.test.tsx`<br>`app/tests/platform-model-pool.test.tsx` | integrated (pending main) | 同时绑两个模型被拒（`parseAgentInput`） |
| H3 | D09 | 一次运行（对话触发/@派活/routine 触发/交接接手）以**执行者员工的绑定模型**起跑——即"开发 GPT-6、审核 GLM-5.3… | implemented | 基线（main 上已有）<br>canquedehuiyi-cpu/xiongbaowork#147 | G3、G6 | `server/tests/copilot.test.ts`<br>`server/tests/deployment-model-metering.test.ts`<br>`server/tests/team-bot-owner.integration.test.ts` | integrated (pending main) | 按员工 `model_ref` 起跑在 `models/runtime-resolver.ts`；真实模型调用要靠门 6 |
| H4 | D09 | 我可以在任务详情/员工详情看到该次运行实际使用的模型；审计行记录模型标识（沿用 `modelUsage` 表扩展）。 | implemented | canquedehuiyi-cpu/xiongbaowork#93<br>canquedehuiyi-cpu/xiongbaowork#97 | G3、G6 | `server/tests/headless-model-usage.integration.test.ts`<br>`server/tests/headless-model-usage-callers.integration.test.ts`<br>`app/tests/tasks-model-chip.test.tsx` | integrated (pending main) | 模型显示在任务卡上；员工详情页（`wakers_.$agentId.tsx`）不显示模型 |
| H5 | D09 | 模型库条目被员工引用时不可删除，提示"3 位 Waker 正在使用"（引用计数保护）。 | implemented | canquedehuiyi-cpu/xiongbaowork#5 | G3 | `server/tests/model-library-routes.test.ts` | integrated (pending main) | 服务端 409 + 引用数；前端 `/api/models/:id/references` 列出员工名 |
| H6 | D09 | 远程 AG-UI Bot（自带端点的员工）不受 H2 约束（模型在它自己端点），UI 明示"外部托管模型"。 | implemented | canquedehuiyi-cpu/xiongbaowork#57 | G3 | `app/tests/platform-model-pool.test.tsx`<br>`app/tests/tasks-model-chip.test.tsx` | integrated (pending main) |  |
| I1 | D05 | 我可以创建 Group（如"编程小组"）并为它定义**任务模板**：有序步骤，每步绑定成员 Waker+指令，例如 步骤1 开发（GPT-6… | implemented | canquedehuiyi-cpu/xiongbaowork#38 | G3 | `server/tests/pipeline-template-edit.test.ts`<br>`server/tests/pipeline-routes.test.ts`<br>`app/tests/pipelines-template-edit.test.tsx` | integrated (pending main) |  |
| I2 | D05 | 我给 Group 派一个任务（看板"@Group"或模板页"运行"）：系统按模板逐步执行，每步产出作为下一步输入上下文，各步骤在看板登记为父… | implemented | canquedehuiyi-cpu/xiongbaowork#27<br>canquedehuiyi-cpu/xiongbaowork#65 | G3 | `server/tests/pipeline-run.test.ts`<br>`app/tests/tasks-dispatch-group.test.tsx` | integrated (pending main) | 看板「派给小组」来自 #65 |
| I3 | D05 | 任一步骤触发"需要操作"（审批/提问）时，父任务挂起进"需要关注"区；我处理后流水线从该步继续。 | implemented | 基线（main 上已有）<br>canquedehuiyi-cpu/xiongbaowork#60 | G3 | `server/tests/pipeline-run.test.ts`<br>`server/tests/approvals-question-board.test.ts` | integrated (pending main) |  |
| I4 | D05 | 我可以中止流水线（剩余步骤标"已结束-失败"）或跳过某步（该步标跳过，继续下一步）。 | implemented | 基线（main 上已有） | G3 | `server/tests/pipeline-run.test.ts`<br>`server/tests/pipeline-control.integration.test.ts` | integrated (pending main) | 页面按钮「跳过这步」「中止这次运行」在 `pipelines.tsx` |
| I5 | D05 | 步骤间执行复用底座**无人值守 run 通道**（`routines/run-turn.ts` 的 `createTurnRunner`：本… | implemented | 基线（main 上已有） | G3 | `server/tests/pipeline-turn-channel.test.ts` | integrated (pending main) | `pipeline/turn-channel.ts` 走 `createTurnRunner` |
| I6 | D05 | 谁能对一个 Group 派活＝对该 Group 有权限的人；**派活时逐位校验"这个人能不能用这一步的员工"**，不因"它在组里"而扩权。组… | implemented | canquedehuiyi-cpu/xiongbaowork#27<br>canquedehuiyi-cpu/xiongbaowork#38 | G3 | `server/tests/pipeline-run.test.ts`<br>`server/tests/pipeline-routes.test.ts`<br>`app/tests/pipelines-dispatch-refusal.test.tsx` | integrated (pending main) |  |
| D1 | D07 | "Waker 管理"页含 Waker/Group 双 Tab 与员工卡片墙；卡片显示头像、名字、角色（如 Backend Engineer）… | implemented | canquedehuiyi-cpu/xiongbaowork#29 | G3 | `app/tests/wakers-screen.test.tsx` | integrated (pending main) |  |
| D2 | D07 | 我可以"新建 Waker"：名字、头衔、角色描述、头像种子（boring-avatars）、可见性（私有/公开），复用 `/api/agen… | implemented | canquedehuiyi-cpu/xiongbaowork#29<br>canquedehuiyi-cpu/xiongbaowork#30 | G3 | `app/tests/create-agent-avatar.test.tsx`<br>`server/tests/agent-profile-store.integration.test.ts`<br>`server/tests/agent-routes.test.ts` | integrated (pending main) |  |
| D3 | D07 | 我可以创建 Group：命名+勾选成员 Waker；看板过滤器与 @ 列表中出现 Group 选项（激活 `users.groups` 空转… | implemented | 基线（main 上已有）<br>canquedehuiyi-cpu/xiongbaowork#39<br>canquedehuiyi-cpu/xiongbaowork#48 | G3 | `app/tests/wakers-screen.test.tsx`<br>`server/tests/waker-groups.test.ts`<br>`app/tests/composer-mention-affordance.test.ts`<br>`app/tests/tasks-workbench-board-consistency.test.tsx` | integrated (pending main) | 建组在 Waker 页「小组」Tab；看板 Waker/Group 下拉来自 #48 |
| D4 | D07 | 我可以按"运行状态"筛选卡片（在线 = 有活动 run；休息 = 空闲；暂停 = bot_lifecycle paused）。 | implemented | canquedehuiyi-cpu/xiongbaowork#29 | G3 | `app/tests/wakers-screen.test.tsx` | integrated (pending main) | 暂停 = `bot_lifecycle` 暂停 |
| D5 | D07 | 我点员工卡片进入员工详情：它的职责、进行中任务、技能授权、最近审计流水（读现有 audit 数据）。 | implemented | canquedehuiyi-cpu/xiongbaowork#25<br>canquedehuiyi-cpu/xiongbaowork#43<br>canquedehuiyi-cpu/xiongbaowork#160 | G3 | `server/tests/agent-audit-trail.integration.test.ts`<br>`server/tests/bot-lifecycle-routes.test.ts`<br>`app/tests/waker-detail.test.tsx` | integrated (pending main) | 主人只看到记在自己租户里的审计行，同事对共享员工的操作只有管理员看得到（见待决事项） |
| D6 | D07 | 我可以为每个 Waker 编辑**人设**：性格语气、工作守则、口头约束（结构化字段注入 `shared/bot-prompt.ts` 组装… | implemented | 基线（main 上已有）<br>canquedehuiyi-cpu/xiongbaowork#31 | G3 | `server/tests/persona.test.ts`<br>`app/tests/assemble-screen.test.tsx` | integrated (pending main) |  |
| D7 | D07 | 每个 Waker 有独立的"员工装配页"：一屏管理它的 模型绑定(H2)/技能/插件连接器/人设/职责(routines)，即"单独授权安装… | implemented | 基线（main 上已有）<br>canquedehuiyi-cpu/xiongbaowork#29<br>canquedehuiyi-cpu/xiongbaowork#31 | G3 | `app/tests/assemble-screen.test.tsx`<br>`app/tests/assemble-self-install.test.tsx`<br>`app/tests/assemble-knowledge.test.tsx` | integrated (pending main) |  |
| E1 | D08 | "能力与资源"页是统一聚合视图：技能（personal+deployment）、MCP/连接器（含授权状态）、知识/信息源、组件，四区一屏。… | implemented | canquedehuiyi-cpu/xiongbaowork#69 | G3 | `app/tests/resources-aggregate.test.tsx` | integrated (pending main) | 实际是五区（加上 E4 的模型区） |
| E2 | D08 | 我可以把某技能/连接器授权给指定 Waker 或整个 Group（授权对象从"仅 Bot"扩展到"Group 展开为成员批量授权"）。 | implemented | canquedehuiyi-cpu/xiongbaowork#32 | G3 | `app/tests/crew-grant.test.ts`<br>`app/tests/admin-skill-crew-grant.test.tsx`<br>`app/tests/admin-plugin-crew-grant.test.tsx` | integrated (pending main) |  |
| E3 | D08 | "安装"语义：目录内的技能/连接器/MCP 由管理员上架（保留现有治理边界），员工所有者在装配页给自己的员工**自助勾选安装/卸载**，无需… | implemented | canquedehuiyi-cpu/xiongbaowork#44<br>canquedehuiyi-cpu/xiongbaowork#66 | G3 | `server/tests/plugin-self-install.integration.test.ts`<br>`app/tests/admin-install-listing.test.tsx`<br>`app/tests/assemble-self-install.test.tsx` | integrated (pending main) |  |
| E4 | D08 | 模型库作为"能力与资源"第五区（对应 H1）。 | implemented | canquedehuiyi-cpu/xiongbaowork#57<br>canquedehuiyi-cpu/xiongbaowork#69 | G3 | `app/tests/platform-model-pool.test.tsx`<br>`app/tests/resources-aggregate.test.tsx` | integrated (pending main) |  |
| F1 | D11 | 首次登录进入"我的分身"引导：选择信息来源（本地文件夹/知识源声明），保存后生成特殊 built-in Waker"我的分身"，其角色描述注… | partial | 基线（main 上已有） | G3、G5 | `server/tests/dev-actor.integration.test.ts` | partly integrated (pending main) | 注册时 `tenant/provisioning.ts` 会建「我的分身」；选择信息来源的引导没有做，规格 `docs/specs/2026-11-02-f1-avatar-info-sources.md` 是含待决项的草案 |
| F2 | D11 | **runner 桌面客户端**：将 `agent-computer`（Chromium + workspace + shell + 录屏）… | partial | 基线（main 上已有） | G5、G7 | `server/tests/runner-channel.test.ts`<br>`server/tests/runner-dispatch.test.ts`<br>`server/tests/runner-browser.test.ts` | partly integrated (pending main) | `openbot/runner` 是 Bun 命令行（配对、出站长连、执行）；打包成桌面客户端没开始，`desktop/` 与 runner 无集成；规格 `docs/specs/2026-11-02-f2-runner-desktop-client.md` 是草案 |
| F3 | D11 | Waker 的浏览器/shell/文件动作由服务端策略网关决策后，按任务绑定的 device_id **下发到对应 runner 执行**；… | implemented | canquedehuiyi-cpu/xiongbaowork#19 | G3、G5 | `server/tests/device-selection.test.ts`<br>`server/tests/device-safety.integration.test.ts` | integrated (pending main) | 缺陷 #12；真实设备动作要靠门 5 |
| F4 | D11 | 设备在线/离线：员工卡片与看板显示设备状态；设备离线时新任务进入等待队列（复用 `work_items` 租约机制），设备回线自动续跑；离线… | partial | canquedehuiyi-cpu/xiongbaowork#19 | G3、G5 | `server/tests/device-safety.integration.test.ts`<br>`server/tests/devices.test.ts` | partly integrated (pending main) | 离线排队、回线续跑已有；员工卡片和看板上没有设备在线状态 |
| F5 | D11 | Web 端 URL 支持 `?machineId=` 过滤"只看待本机执行的任务"（与 QoderWake 行为一致）；无匹配设备时显示"W… | implemented | 基线（main 上已有）<br>canquedehuiyi-cpu/xiongbaowork#92 | G3 | `app/tests/tasks-board-resting.test.tsx` | integrated (pending main) |  |
| F6 | D11 | 服务端 Docker 电脑（底座 supervisor 链路）**降级为开发/演示回退**：`TENANT_RUNTIME=cloud` 时… | partial | 基线（main 上已有） | G3 | `server/tests/config.test.ts` | partly integrated (pending main) | `TENANT_RUNTIME` 有 cloud/device 两值，但不设时默认 `cloud`（`config.ts` 的 `tenantRuntime`），故事要求生产默认 `device` |
| J1 | D04 | 注册/登录：邮箱+密码（Better Auth 自有凭据路径）+ 可选 Google/GitHub OAuth；注册成功即开通租户（初始化：… | implemented | 基线（main 上已有）<br>canquedehuiyi-cpu/xiongbaowork#4<br>canquedehuiyi-cpu/xiongbaowork#94 | G2、G3 | `server/tests/email-signup.test.ts`<br>`server/tests/github-oauth-signup.test.ts` | integrated (pending main) |  |
| J2 | D03 | 全部业务表加 `tenant_id` 并启用 PostgreSQL **Row-Level Security**：连接会话注入 `app.t… | implemented | canquedehuiyi-cpu/xiongbaowork#10<br>canquedehuiyi-cpu/xiongbaowork#53<br>G01：#8、#11、#14、#17、#22、#24、#68、#71，测试 #72–#87<br>G01-E：#101–#146 | G2、G3 | `server/tests/rls-role.test.ts`<br>`server/tests/rls-write-scope.test.ts`<br>`server/tests/team-tenant-rls.integration.test.ts`<br>`server/tests/tenant-invariants.test.ts` | integrated (pending main) |  |
| J3 | D03 | 我的 Waker、任务、审批、技能、连接器授权、模型 key、设备仅我可见；本期无跨租户共享/协作。 | implemented | 同 J2 | G2、G3 | `server/tests/team-tenant-rls.integration.test.ts`<br>`server/tests/tenant-invariants.test.ts` | integrated (pending main) | G01-E 起，发布的 Team Bot、多人群组、连接器等记为 `team` 行，在同一部署内跨人共享（见待决事项） |
| J4 | D03 | 模型凭据、连接器 token 按租户入加密 vault；底座"管理员上架目录"升级为**平台级目录**（provider 模板、官方技能/连… | implemented | canquedehuiyi-cpu/xiongbaowork#9<br>canquedehuiyi-cpu/xiongbaowork#12<br>canquedehuiyi-cpu/xiongbaowork#15<br>G01-E P10：#120–#124 | G2、G3 | `server/tests/credentials.test.ts`<br>`server/tests/credential-rotation-leak.integration.test.ts`<br>`server/tests/skill-tenant-slugs.integration.test.ts` | integrated (pending main) |  |
| J5 | D04 | 平台运营后台（原 admin 页面收敛为平台工具）：租户列表/封禁恢复/封禁即冻结其任务队列与 runner 连接、按租户查用量与审计。 | partial | 基线（main 上已有） | G2、G3 | `server/tests/ban-freezes-execution.test.ts`<br>`server/tests/platform-store.test.ts` | partly integrated (pending main) | 租户列表、暂停/恢复、暂停即冻结任务队列和 runner 已有；平台页（`platform.tsx`）只列员工数和定时任务数，没有按租户查用量（token）和审计 |
| J6 | D04 | 原 `OPENBOT_SINGLE_USER` 仅保留为开发模式；产品默认注册制，公网部署强制登录。 | implemented | 基线（main 上已有） | G2、G3 | `server/tests/single-user.test.ts` | integrated (pending main) | `OPENBOT_SINGLE_USER` 遇到公网地址时拒绝启动 |
| K1 | D09 | 套餐定义（seed 数据，可配置）：Free = 2 Wakers / 50 任务·月 / 1 设备 / 平台目录基础模型；Pro = 10… | implemented | canquedehuiyi-cpu/xiongbaowork#5<br>canquedehuiyi-cpu/xiongbaowork#51<br>canquedehuiyi-cpu/xiongbaowork#55<br>canquedehuiyi-cpu/xiongbaowork#57<br>canquedehuiyi-cpu/xiongbaowork#148 | G3 | `server/tests/quota.test.ts`<br>`server/tests/platform-model-pool.integration.test.ts` | integrated (pending main) | Free 2/50/1、无自定义模型，写路径拦截；平台池没有种子行，Free 档放哪些模型由部署配置（池行的 `apiKeyEnv`）决定 |
| K2 | D09 | 用量面板（对应 QoderWake 左下角"用量"）：当前档位、本周期 Waker 数/任务数/模型 token 估算（聚合自 `model… | implemented | canquedehuiyi-cpu/xiongbaowork#18<br>canquedehuiyi-cpu/xiongbaowork#49<br>canquedehuiyi-cpu/xiongbaowork#147 | G3、G6 | `server/tests/model-token-metering.test.ts`<br>`server/tests/quota-token-usage.integration.test.ts`<br>`app/tests/quota-panel.test.tsx` | integrated (pending main) | 缺陷 #11 |
| K3 | D09 | 升级入口：档位对比页 + 手动/种子切换订阅；**不接支付渠道**（预留 provider 接口）。 | implemented | canquedehuiyi-cpu/xiongbaowork#3<br>canquedehuiyi-cpu/xiongbaowork#89 | G3 | `server/tests/quota.test.ts`<br>`server/tests/plan-change-audit.integration.test.ts`<br>`app/tests/quota-panel.test.tsx` | integrated (pending main) | 按「只手动切换」决定交付：档位页 `/plans` + 管理员切换 + 审计；支付 provider 接口（#54）按决定不合并 |
| K4 | D09 | 超额返回结构化错误码（含"已用/上限/升级链接"），前端统一引导升级或清理。 | partial | canquedehuiyi-cpu/xiongbaowork#50 | G3 | `app/tests/quota-guidance.test.tsx`<br>`app/tests/query-client.test.ts`<br>`server/tests/quota-error-contract.test.ts` | partly integrated (pending main) | 结构化错误码和引导只接在 react-query 请求上（`query-client.ts`）；对话轮次超额不走引导（#50 自述的 K4b） |
| G1 | D12 | 通过租户包 `examples/qoderwake`（brand.yaml/theme.css/agents.yaml/skills.yam… | implemented | canquedehuiyi-cpu/xiongbaowork#21<br>canquedehuiyi-cpu/xiongbaowork#95<br>canquedehuiyi-cpu/xiongbaowork#96<br>canquedehuiyi-cpu/xiongbaowork#98<br>canquedehuiyi-cpu/xiongbaowork#154<br>canquedehuiyi-cpu/xiongbaowork#158<br>canquedehuiyi-cpu/xiongbaowork#159 | G1、G3、G7 | `server/tests/qoderwake-package.test.ts`<br>`app/tests/chinese-ui-copy.test.ts` | integrated (pending main) | 默认 `TENANT_PACKAGE_DIR=../examples/qoderwake`；缺陷 #14 |
| G2 | D04 | 开发模式保留 `OPENBOT_SINGLE_USER=true` 一键起全栈（联调用），生产为注册制多租户（见 J6）；开发期 runne… | implemented | 基线（main 上已有） | G3、G7 | `server/tests/single-user.test.ts` | integrated (pending main) | `bun run dev` 起 app + server |
| WF1 | D10 | 能力与资源中独立 WakerFlow 管理，列表空态与新建入口 | implemented | canquedehuiyi-cpu/xiongbaowork#33<br>canquedehuiyi-cpu/xiongbaowork#45<br>canquedehuiyi-cpu/xiongbaowork#47 | G3、G4 | `server/tests/wakerflows-store.integration.test.ts`<br>`server/tests/wakerflow-routes.test.ts`<br>`app/tests/wakerflows-screen.test.tsx` | integrated (pending main) | 入口在「能力与资源」的 WakerFlow 区 |
| WF2 | D10 | 新建 WakerFlow：自然语言输入、模型选择、场景建议 | implemented | canquedehuiyi-cpu/xiongbaowork#35<br>canquedehuiyi-cpu/xiongbaowork#47 | G3、G4 | `server/tests/wakerflow-generator.test.ts`<br>`server/tests/wakerflow-generation-requests.integration.test.ts` | integrated (pending main) |  |
| WF3 | D10 | 自然语言生成可编辑、可保存的可执行计划，错误和取消可恢复 | implemented | canquedehuiyi-cpu/xiongbaowork#33<br>canquedehuiyi-cpu/xiongbaowork#35<br>canquedehuiyi-cpu/xiongbaowork#45<br>canquedehuiyi-cpu/xiongbaowork#47 | G3、G4 | `server/tests/wakerflow-generation-requests.integration.test.ts`<br>`server/tests/wakerflow-routes.test.ts`<br>`app/tests/wakerflows-screen.test.tsx` | integrated (pending main) |  |
| WF4 | D10 | 流程编辑、复用、运行记录和任务看板查收闭环 | implemented | canquedehuiyi-cpu/xiongbaowork#45<br>canquedehuiyi-cpu/xiongbaowork#62<br>canquedehuiyi-cpu/xiongbaowork#157 | G3、G4 | `server/tests/wakerflow-run.integration.test.ts`<br>`server/tests/wakerflow-task-open.integration.test.ts`<br>`app/tests/wakerflow-runs.test.tsx` | integrated (pending main) | CI 有 G4 浏览器端到端 job（模拟模型） |
| WF5 | D10 | 运行中止后状态不可被旧回调覆盖，后续步骤不得启动 | implemented | canquedehuiyi-cpu/xiongbaowork#45<br>canquedehuiyi-cpu/xiongbaowork#62<br>canquedehuiyi-cpu/xiongbaowork#90 | G3、G4 | `server/tests/wakerflow-run.integration.test.ts`<br>`app/tests/wakerflow-runs.test.tsx`<br>`server/tests/wakerflow-restart-recovery.integration.test.ts` | integrated (pending main) |  |
| WF6 | D10 | 同一运行并发推进只有一个执行者，避免重复执行和重复计费 | implemented | canquedehuiyi-cpu/xiongbaowork#45 | G3、G4 | `server/tests/wakerflow-run.integration.test.ts` | integrated (pending main) |  |
| AUT1 | D06 | 定期与一次性调度，多个触发条件（原版显示上限5） | implemented | canquedehuiyi-cpu/xiongbaowork#40<br>canquedehuiyi-cpu/xiongbaowork#58<br>canquedehuiyi-cpu/xiongbaowork#64 | G3 | `server/tests/automations-store.integration.test.ts`<br>`server/tests/automation-sweep.integration.test.ts`<br>`server/tests/automation-routes.test.ts`<br>`app/tests/automation-form.test.tsx` | integrated (pending main) | open PR #161 修 #58 评审意见 |
| AUT2 | D06 | 事件 Hook/API 入口及触发行为 | implemented | canquedehuiyi-cpu/xiongbaowork#63<br>canquedehuiyi-cpu/xiongbaowork#64 | G3 | `server/tests/automation-ingress.test.ts`<br>`server/tests/automation-ingress.integration.test.ts`<br>`app/tests/automations-section.test.tsx` | integrated (pending main) |  |
| AUT3 | D06 | 执行对象可选 Waker 或已创建 WakerFlow | partial | canquedehuiyi-cpu/xiongbaowork#40<br>canquedehuiyi-cpu/xiongbaowork#58<br>canquedehuiyi-cpu/xiongbaowork#64 | G3 | `server/tests/automation-waker-executor.test.ts`<br>`server/tests/automation-routes.test.ts`<br>`app/tests/automation-form.test.tsx` | partly integrated (pending main) | 只有 Waker 目标能跑：没有注册 `wakerflow` 执行器，WakerFlow 目标保存时被拒（`automations/types.ts`）；表单要 `/api/capabilities` 返回 `wakerflowAutomations: true` 才给选 WakerFlow，服务端目前不返回这个字段 |
| AUT4 | D06 | 自动任务最大运行次数、截止日期、到期停止 | implemented | canquedehuiyi-cpu/xiongbaowork#40<br>canquedehuiyi-cpu/xiongbaowork#58<br>canquedehuiyi-cpu/xiongbaowork#64 | G3 | `server/tests/automation-sweep.integration.test.ts`<br>`server/tests/automations-store.integration.test.ts`<br>`app/tests/automations-section.test.tsx` | integrated (pending main) |  |
| RES1 | D08 | 独立知识库创建与后续知识维护/授权 | implemented | canquedehuiyi-cpu/xiongbaowork#46<br>canquedehuiyi-cpu/xiongbaowork#61 | G3 | `server/tests/knowledge-base.integration.test.ts`<br>`server/tests/knowledge-tools.test.ts`<br>`app/tests/knowledge-screen.test.tsx` | integrated (pending main) |  |
| RES2 | D08 | 公开项目支持名称、简介、本地目录或Git仓库和分支，当前设备下共享给全部Waker，并在任务上下文中可选；员工专属项目具备独立范围 | not started | — | — | — | — | v1.0 后。只有休眠的 `resource_projects` 表（`db/schema/resource-project-foundations.ts`），没有代码读写 |
| ROLE1 | D07 | 角色模板和员工实例分离，智能生成/Markdown/手工Identity Persona Bible | not started | — | — | — | — | v1.0 后 |
| WF7 | D10 | 流程图worker提示词、decision条件分支、嵌套Flow和动作实现的编辑与执行 | not started | — | — | — | — | v1.0 后 |
| WF8 | D10 | 输入参数、确认回答与跳过、运行事件及错误恢复、版本定义与回滚 | not started | — | — | — | — | v1.0 后 |
| WF9 | D10 | 持久自定义会话和历史、工作流分享/导入及有效期/次数约束 | not started | — | — | — | — | v1.0 后 |
| SEC1 | D11 | 员工级危险命令审批、敏感文件路径审批、每工具直接/询问/禁用三态及企业模式入口；执行侧遵循配置，拒绝/待审批无副作用 | partial | 基线（main 上已有） | G2、G5 | `server/tests/approvals-policy.test.ts`<br>`server/tests/approvals-policy.integration.test.ts` | partly integrated (pending main) | 审批规则和策略网关已有，「拒绝/待审批无副作用」在结构上成立；员工级配置、每工具三态（含禁用）、危险命令和敏感路径审批、企业模式入口都没做。规格 `docs/specs/2026-11-02-sec1-employee-tool-permissions.md` 是草案 |
| WIN1 | D16 | 原生Windows设备CLI可以实际执行命令，启动错误可见；中止取消整棵子进程树并清理 | implemented | canquedehuiyi-cpu/xiongbaowork#13<br>canquedehuiyi-cpu/xiongbaowork#152<br>canquedehuiyi-cpu/xiongbaowork#155 | G3、G7 | `scripts/ci/windows-runner-probe.ts` | integrated (pending main) | CI job `WIN1 device CLI probe (windows-latest)` |
| DEV1 | D11 | 设备动作结果不明时持久暂停后续自动写入；新工具编号/跨实例/重启均不能绕过，所有者能核查详情并明确恢复 | implemented | 基线（main 上已有） | G3、G5 | `server/tests/device-safety.integration.test.ts`<br>`server/tests/devices.test.ts`<br>`app/tests/my-devices.test.tsx` | integrated (pending main) | 持久暂停在 `devices/queue.ts`（`outcome_unknown`） |

测试路径都相对于 `openbot/`。

## 7 道最终门

| 门 | 要求 | CI 里已自动化的部分 | 仍需人工的部分 | 状态 |
| --- | --- | --- | --- | --- |
| G1 | 同一最终 SHA 的正式镜像：8 个页面 GET 200，未知 API 404 | `ci.yml` 的 `image` job：构建镜像、启动容器、跑 smoke 断言。`release.yml`（canquedehuiyi-cpu/xiongbaowork#34）：打 tag 后构建一次、只按 digest 推 GHCR，对拉回来的同一 digest 跑门 1 断言，然后才打可读 tag、发 GitHub Release | 有人推版本 tag；把 GHCR 包设为公开（否则 G7 的匿名拉取失败） | 部分：PR 构建上自动；正式 tag 还没发过 |
| G2 | 未登录拒绝、跨租户私有资源 404、无越权，被拒后不调用上游 | server-test 分片里的租户与权限套件：`tenant-invariants`、`team-tenant-rls.integration`、`rls-role`、`rls-write-scope`、`outbound-guard`（SSRF，#6、#7、#153）、`approvals-policy` 等 | 没有针对正式镜像的端到端越权探针；结论只来自测试套件 | 部分：自动测试在；对正式镜像未单独证成 |
| G3 | 前后端全套测试无 fail、无 Unhandled error，锁文件安装下严格 CI | `static`、`chart`、`server-test (1)–(6)`、`app-test`、`workspace tests`（agent-computer、supervisor、shared、worker，#13）、`WIN1 device CLI probe (windows-latest)`、`desktop tests (windows-latest)`（#13、#23、#152、#155） | 无 | 自动；以合进 `main` 后 `main` 上的运行为准 |
| G4 | WakerFlow 生成-编辑-保存-执行-中止-查收及重启恢复 | `e2e-wakerflow` job「G4 WakerFlow lifecycle (browser, mocked model)」（#157）；重启恢复有 `wakerflow-restart-recovery.integration`（#90） | 用真实模型走一遍（CI 里是模拟模型） | 部分：模拟模型下自动 |
| G5 | 用户设备上浏览器真实动作、离线重连、授权审批闭环 | server-test 分片里 runner 协议与下发的测试（`runner-channel`、`runner-dispatch`、`runner-browser`、`devices`、`device-safety.integration`）。浏览器探针脚本 `scripts/ci/runner-browser-probe*.ts` 在仓库里，但 CI 不跑 | **需要一台真实设备**：安装 runner、配对、执行浏览器/命令/文件动作、断网重连、审批 | 未证成 |
| G6 | 真实模型最小授权运行与正确计费 | `model-e2e.yml`（#52）：一次真实绑定模型调用，与它写的 `model_token_calls` 行对账 | **需要人手动触发**：只能从 `main`、只在 GitHub Environment `model-e2e` 里跑（密钥只存在该 Environment） | 未证成：还没在 `main` 上跑过 |
| G7 | Windows/Linux 干净客户部署证据 | Linux：`clean-deploy.yml`（#36，被 `release.yml` 调用），在空目录按 README 原样安装已发布版本，内置库和外部库两种，校验运行的是发布记录里的 digest 并跑门 1 断言 | **Windows 需要一台 Windows 机器**按 README 的「Windows Docker Desktop 快速上手」（`<!-- g7:windows -->` 段）人工跑一遍；CI 只检查该段不含源码构建步骤 | 未证成：Linux 半边要等首个正式版本；Windows 半边待人工 |

## 14 个阻断缺陷

| 缺陷 | 内容 | 修复 PR | 状态 |
| --- | --- | --- | --- |
| #1 | CI 跑不起来（基线 SHA 不存在、测试清单少文件） | canquedehuiyi-cpu/xiongbaowork#1（`fix/ci-runnable`）、canquedehuiyi-cpu/xiongbaowork#2（集成分支本身） | 已修，在集成分支；#1、#2 本身就是进 `main` 的那一步，仍 open |
| #2 | `migrate.ts` 不跑 recovery 叠加迁移，首轮 CI 红 | canquedehuiyi-cpu/xiongbaowork#2 | 已修，在集成分支；过程见 `BASELINE-FAILURES.md` |
| #3 | 抢注即成平台管理员 | canquedehuiyi-cpu/xiongbaowork#3、canquedehuiyi-cpu/xiongbaowork#4 | 已修，在集成分支 |
| #4 | 后台路径没有可信租户 | G01：#8、#11、#14、#17、#22、#24、#68、#71，测试 #72–#87，前置 canquedehuiyi-cpu/xiongbaowork#53；G01-E：#101–#146 | 已修，在集成分支。`currentTenant()` 在帧外抛错，不再回落到 `system` |
| #5 | 任意用户可自升 Pro | canquedehuiyi-cpu/xiongbaowork#3；审计 canquedehuiyi-cpu/xiongbaowork#89 | 已修，在集成分支 |
| #6 | 模型探测 SSRF | canquedehuiyi-cpu/xiongbaowork#6、canquedehuiyi-cpu/xiongbaowork#7、canquedehuiyi-cpu/xiongbaowork#153 | 已修，在集成分支 |
| #7 | 没有订阅就不限额 | canquedehuiyi-cpu/xiongbaowork#5；每租户一条订阅 canquedehuiyi-cpu/xiongbaowork#148 | 已修，在集成分支 |
| #8 | RLS 强制默认只告警；app 角色有 CREATE | canquedehuiyi-cpu/xiongbaowork#10 | 已修，在集成分支 |
| #9 | 唯一键不按租户；vault 不绑定 AAD | canquedehuiyi-cpu/xiongbaowork#9、canquedehuiyi-cpu/xiongbaowork#12、canquedehuiyi-cpu/xiongbaowork#15；team 密钥 G01-E P10（#120–#124） | 已修，在集成分支 |
| #10 | 重启后无人回收遗弃的运行 | canquedehuiyi-cpu/xiongbaowork#16；WakerFlow 重启恢复 canquedehuiyi-cpu/xiongbaowork#90 | 已修，在集成分支 |
| #11 | 没有 token 计量 | canquedehuiyi-cpu/xiongbaowork#18、canquedehuiyi-cpu/xiongbaowork#49、canquedehuiyi-cpu/xiongbaowork#147（默认模型也计量）；对账工作流 canquedehuiyi-cpu/xiongbaowork#52 | 代码已修，在集成分支；真实调用对账待门 6 |
| #12 | 设备模式没有网关 | canquedehuiyi-cpu/xiongbaowork#19 | 代码已修，在集成分支；真实设备待门 5 |
| #13 | 服务端删除模型不检查引用 | canquedehuiyi-cpu/xiongbaowork#5 | 已修，在集成分支 |
| #14 | 品牌（桌面端、服务端报错、默认租户包） | canquedehuiyi-cpu/xiongbaowork#20、canquedehuiyi-cpu/xiongbaowork#21、canquedehuiyi-cpu/xiongbaowork#154；中文文案 #95、#96、#98、#158、#159 | 已修，在集成分支 |

14 个缺陷的代码修复都已在集成分支；#11 和 #12 还差真实环境证据（门 6、门 5）。全部要等集成分支合进 `main` 才算关闭。

## 待决事项与代码里的缺口

下面每条都是读集成分支代码看到的，不是推测。

需要产品决定的：

1. **J3 与 `team` 共享。** J3 写"本期无跨租户共享/协作"。G01-E（决定 2 "team-tenant"）把发布的 Team Bot、多人群组、连接器/MCP、审批团队设置、沙箱组件记为 `team` 行，在同一部署内跨人共享。代码按决定实现；故事原文需要跟着改，或者重新决定。
2. **D5 主人能看到的审计范围。** 每行审计记在操作者自己的租户里。主人在自己的帧里读，看到的是记在自己租户的行；同事对共享员工做的操作只有持管理员能力的人（`asAdminPlatform`）看得到。是否让主人也看到同事的操作，需要决定，且要改 RLS 策略。
3. **F6 生产默认运行位置。** 故事要求生产默认 `TENANT_RUNTIME=device`；`config.ts` 不设时取 `cloud`，`.env.example` 里 `device` 是注释掉的。
4. **F1、F2、SEC1 的规格都是含待决项的草案**（`docs/specs/2026-11-02-*.md`），动工前需要拍板。F2 另有一项硬约束：`desktop/signing/azure-federation.json` 指向上游仓库的签名身份，本仓库拿不到。
5. **K1 平台池放哪些模型。** 平台池没有种子行，每行用 `apiKeyEnv` 指向一个部署环境变量；Free 档实际能用哪些模型、预算多少，由运维配置决定。
6. **K3 只手动。** 按决定交付手动切换和审计，支付 provider 接口（#54）不合并。故事原文里的"预留 provider 接口"相应不做。

代码缺口（已知、尚未排 PR 的）：

7. **AUT3**：没有注册 `wakerflow` 自动任务执行器，WakerFlow 目标保存时就被拒；只有 Waker 目标能跑。表单等 `/api/capabilities` 的 `wakerflowAutomations`，服务端目前不返回它，所以界面也不提供 WakerFlow 选项。
8. **K4**：超额引导只接在 react-query 请求上，对话轮次的超额错误不走引导（K4b）。
9. **J5**：平台页没有按租户查 token 用量和审计。
10. **F4**：员工卡片和看板上没有设备在线状态。
11. **H4**：员工详情页不显示模型（任务卡上有）。
12. **A4**：状态和数据周期是按钮组，不是故事写的下拉框。
13. **canquedehuiyi-cpu/xiongbaowork#88**（G01-D：在 `requireUser` 打开的租户帧里治理运行）在它的 base 分支已经合并之后才合进去，它的 head 不在集成分支上。同一意图现在由 G01-E 覆盖：`auth/guards.ts` 的 `createRequireUser` 让每个请求跑在 `runAsTenant(session.user.id)` 里。这里只作记录，不需要再合。
