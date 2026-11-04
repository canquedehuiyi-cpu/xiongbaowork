# 拉回范围的 5 个故事：总览与排期

- 日期：2026-11-04
- 状态：**草案**。各故事的待决策项见各自的规格；本文只讲顺序、PR 数量和并行关系。
- 故事：WF7、WF8、WF9（D10）、ROLE1（D07）、RES2（D08）。11-02 的 MVP 决定曾把它们移到 v1.0 后（`docs/acceptance/STORIES.md:26`），现在拉回范围。
- 规格：
  - `docs/specs/2026-11-04-wf8-flow-inputs-confirm-events-versions.md`（含 AUT3 的 Flow 输入缺口）
  - `docs/specs/2026-11-04-wf7-flow-graph-nodes.md`
  - `docs/specs/2026-11-04-wf9-flow-sessions-sharing.md`
  - `docs/specs/2026-11-04-role1-role-templates.md`
  - `docs/specs/2026-11-04-res2-resource-projects.md`

## 1. 依赖顺序

- **WakerFlow 三个故事串行：WF8 → WF7 → WF9。** 三者都改 `server/src/wakerflows/*` 和 `app/src/lib/wakerflows.ts`。
  - WF8 先做：它补的是已经上线功能的缺口（AUT3 自动任务不传 Flow 输入），并提供后两个故事要用的基础设施，包括运行事件（WF7 的 `branch_taken`）和版本表（WF7 的嵌套 Flow 要固定版本）。
  - WF7 其次：它改变计划结构。
  - WF9 最后：会话生成的是 WF7 形状的计划，分享包也要包含 WF7 的节点类型。
- **ROLE1 独立**：只碰员工档案、人设和角色模板。
- **RES2 独立**，但它的 runner 阶段 RES2-2 **依赖 F1 阶段 2**（runner 只读根目录，`root_ref`）。另一个代理正在做 F1 阶段 2；RES2 复用这套机制，不另造一套。RES2-1、RES2-4 不依赖 F1。
- 共同规则：休眠表只"原样启用"。不改它们的 Drizzle 结构；`resource-project-foundations.ts` 按字节锁定，一个字节都不能改。启用迁移只追加 FORCE、`platform` 策略、CHECK 或触发器。每个故事都把"启用休眠表"列为一项待决策，需要签字。

## 2. PR 数量

共 **24 个 PR**，每个最多 8 个文件（`server-tests.list.txt` 和 `routeTree.gen.ts` 不计）：

| 故事 | PR | 其中迁移 |
| --- | --- | --- |
| WF8 | 7（WF8-1 … WF8-7） | 2 |
| WF7 | 5（WF7-1 … WF7-5） | 1 |
| WF9 | 4（WF9-1 … WF9-4） | 2 |
| ROLE1 | 4（ROLE1-1 … ROLE1-4） | 1 |
| RES2 | 4（RES2-1 … RES2-4） | 1 |

## 3. 迁移编号

编号从 **0134** 开始（0132、0133 可能被同时工作的其他代理占用）。编号**必须按合入顺序递增**：`scripts/migrate.ts` 用 drizzle 的迁移器，它会跳过 `when` 不晚于最后一次已执行迁移的条目，所以晚合入的迁移如果编号或 `when` 更小，在已经升级过的库上会被**静默跳过**。下面的号码按计划的合入顺序预留；同一波次里的几个迁移按实际合入先后取号，推送前检查 origin，号码被占用就顺延，并把 `when` 设为晚于最后一条。

| 预留 | PR | 内容 | 波次 |
| --- | --- | --- | --- |
| 0134 | WF8-3 | `waker_flow_versions` | 1 |
| 0135 | ROLE1-1 | `agent_profiles` 的 Bible 和模板来源列；人设模板复制进 `role_templates` | 1 |
| 0136 | RES2-1 | 启用 `resource_projects`、`project_context_bindings` | 1 |
| 0137 | WF8-5 | 启用 `flow_confirmations`、`flow_run_events`、`flow_run_retries` | 2 |
| 0138 | WF7-3 | `group_task_runs.parent_run_id/parent_step_id` | 6 |
| 0139 | WF9-1 | 启用 `flow_customization_*` | 8 |
| 0140 | WF9-3 | 启用 `flow_share_*`，加更新守卫 | 9 |

## 4. 并行波次

同一波次内的 PR 互不改同一个文件，唯一的例外是 `server/recovery/recovery-20261018-v1/meta/_journal.json`：它只追加，按 §3 的规则处理。`server/src/index.ts`、`server/src/copilot.ts` 是跨故事的热点，排期保证同一时间只有一个打开的 PR 改它们。后一波次以前一波次中它依赖的 PR 已合入为前提。

| 波次 | PR | 会改动的热点文件 |
| --- | --- | --- |
| 1 | WF8-1、WF8-3、ROLE1-1、RES2-1 | `index.ts`：RES2-1 |
| 2 | WF8-2、WF8-5、RES2-4 | `index.ts`：WF8-5 |
| 3 | WF8-4、WF8-6、ROLE1-2 | `index.ts`、`copilot.ts`：ROLE1-2 |
| 4 | WF8-7、WF7-1、RES2-3 | `index.ts`、`copilot.ts`、`computer/gateway.ts`：RES2-3 |
| 5 | WF7-2、ROLE1-3 | `index.ts`：ROLE1-3 |
| 6 | WF7-3、ROLE1-4 | `index.ts`：WF7-3 |
| 7 | WF7-4 | `index.ts`：WF7-4 |
| 8 | WF7-5、WF9-1 | 无 |
| 9 | WF9-2、WF9-3 | `index.ts`、`tenant-invariants.test.ts`：WF9-3 |
| 10 | WF9-4 | 无 |
| 浮动 | RES2-2（F1 阶段 2 合入后即可开始，计划在波次 2 或 3，必须早于 RES2-3） | `devices/channel.ts`、runner；不碰 `index.ts` |

说明：

- WakerFlow 系列内部：服务端链 WF8-1 / WF8-3 → WF8-5 → WF8-6 → WF7-1 → WF7-2 → WF7-3 → WF7-4 → WF9-1 → WF9-3 是严格串行的（共用 `wakerflows/store.ts`、`routes.ts`、`pipeline/store.ts`），只有 WF8-1 与 WF8-3 的文件不相交，可以同时进行。前端链 WF8-2 → WF8-4 → WF8-7 → WF7-5 → WF9-2 → WF9-4 共用 `app/src/lib/wakerflows.ts`，也是串行的；但每个前端 PR 只碰 `app/`，所以可以与下一个服务端 PR 同时进行。
- ROLE1 与 RES2 之间唯一的共享文件是 `copilot.ts`（ROLE1-2 注入 Bible，RES2-3 注入"当前项目"），已经错开在波次 3 和 4。
- 如果 F1 阶段 2 延期，RES2-2 和依赖它的 RES2-3 一起后移；RES2-3 后移时要避开当时改 `index.ts` 的那个 PR。
- 其他代理正在做的 SEC1 后续阶段也会改 `computer/gateway.ts` 和 `copilot.ts`；RES2-3 开工前先确认它们已经合入，或者与它们错开。
