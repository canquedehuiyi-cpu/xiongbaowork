# WF9 WakerFlow 持久自定义会话与历史、分享与导入（有效期与次数约束）设计规格

- 日期：2026-11-04
- 状态：**已定稿**（2026-11-04）。第 4 节的待决策项已全部决定，均采纳建议；本文不含代码。
- 故事：`docs/acceptance/STORIES.md` WF9（D10）：持久自定义会话和历史、工作流分享/导入及有效期/次数约束。11-02 的 MVP 决定曾把它移到 v1.0 后，现在拉回范围。
- 原文出处：`docs/specs/2026-10-06-qoderwake-replica.md` 没有 WF9 的逐条描述。功能清单来自 `docs/plans/2026-10-10-完整仿制接手.md:62-64` 对原版客户端契约的只读审计："持久自定义会话、历史与 activate"、"分享链接的期限/次数、导入包和失效"。原版后台语义**没有经过实测**。
- **与已定决策的冲突**：同一份 replica 规格的 J3（第 137 行）写"本期无跨租户共享/协作"，§6（第 205 行）写"跨租户协作/员工共享市场"明确不做。跨租户的分享与导入是对这两条的**有意例外**，已由产品确认（决策 D1，2026-11-04）。
- 前置：WF8、WF7 先做（导入包要包含 WF7 的节点类型）。

---

## 1. 现状（基线：`claude/magical-archimedes-8a6ljj`，`bcdc46f`）

### 1.1 生成是一次性的，没有会话

- `server/src/wakerflows/routes.ts:128` 的 `POST /:id/generate` 接收 `{ requestId, modelRef, idea, members, scenario? }`，`server/src/wakerflows/store.ts:750` 的 `generate()` 发起一次规划调用，结果写进 `waker_flow_requests.result`（`db/schema/wakerflows.ts:49`）。只有当草稿从未编译过时，结果才会写进 Flow（`store.ts:746` 的注释；已保存的 Flow 不会在模板背后被改写，`applied: false` 时由编辑器应用）。
- 规划提示词 `server/src/wakerflows/generator.ts:82` 的 `flowPlanningPrompt()` 只有"用户的想法、参考场景、候选员工"，**不包含**当前计划，也不包含之前的对话。想在现有计划上改一点（"把第二步改成先审核"），只能重新生成整份计划。
- 请求按 `requestId` 幂等，有取消（`routes.ts:151`）和重启恢复（`wakerflows/recovery.ts`）。
- 休眠表（迁移 `0091`、`0093`，没有代码读写，RLS 已开但**没有 FORCE**）：
  - `flow_customization_sessions`（`db/schema/flow-customization-foundations.ts:18`）：`flow_id`、`request_id`（唯一）、`title`、`creation_fingerprint`、`description`、`revision`、`deleted_at`。
  - `flow_customization_heads`（同文件 `:81`）：`(tenant_id, flow_id)` 唯一，指向 `session_id`，即"当前激活的会话"。
  - `flow_customization_turns`（`db/schema/flow-customization-turns.ts:19`）：`session_id`、`request_id`（唯一）、`fingerprint`、`prompt`、`context`、`model_ref`、`members`。没有结果列，结果放在同一 `request_id` 的 `waker_flow_requests` 行里。

### 1.2 没有分享和导入

- 计划里的 `members[].agentId` 是本租户的员工 id（`shared/wakerflows.ts:4`），换一个租户就没有意义，所以计划不能原样搬过去。
- 休眠表（迁移 `0096`，没有代码读写，**没有 FORCE**）：
  - `flow_share_links`（`db/schema/flow-sharing-foundations.ts:20`）：`id`（uuid，**没有默认值**，由调用方给出，可用于幂等创建）、`flow_id`、`token_hash`（唯一）、`creation_fingerprint`、`package_snapshot` jsonb、`digest`、`expires_at`（**必填**）、`max_uses`（可空，>0）、`uses`（≥0 且 ≤ `max_uses`）、`revoked_at`。
  - RLS：SELECT 和 UPDATE 允许 `tenant_id = app.tenant_id` **或** `token_hash = app.flow_share_token`；INSERT 和 DELETE 只允许本租户。也就是说，原设计打算让持有令牌的另一个租户，在设置了会话变量 `app.flow_share_token` 后读取并更新这一行。
  - **隐患**：UPDATE 的 `WITH CHECK` 同样只看"令牌匹配"，持有令牌的人在数据库层面可以改这一行的**任何**列（例如延长 `expires_at`、把 `uses` 清零）。现在只有应用代码能发 UPDATE，但这道防线需要补上（见 §3.3）。
  - `flow_share_imports`（同文件 `:89`）：`(tenant_id, request_id)` 唯一，`fingerprint`、`flow_id`、`result`，用于导入幂等。
- `server/tests/tenant-invariants.test.ts` 统计所有"离开本人租户框架"的入口（`DOORS`，`:56` 起，包括 `asPlatform`、`asAdminPlatform` 等）。设置 `app.flow_share_token` 是一个新的跨租户读取入口，要登记进去。

---

## 2. 差距

| # | 故事要求 | 差距 |
| --- | --- | --- |
| G1 | 持久的自定义会话 | 没有会话；生成不带当前计划和之前的对话 |
| G2 | 会话历史与激活 | 没有历史列表，也没有"当前会话" |
| G3 | 分享链接 | 没有创建、撤销和列表 |
| G4 | 有效期与次数约束 | 没有执行方；数据库更新策略过宽 |
| G5 | 导入 | 没有导入包格式、成员映射、幂等导入 |
| G6 | 测试 | 都没有 |

---

## 3. 方案

### 3.1 自定义会话（G1、G2）

- **S-A（推荐）：原样启用三张休眠表，生成请求复用 `waker_flow_requests`。**
  - 新建会话：`POST /api/wakerflows/:id/sessions`（`{ requestId, title }`），写入 `flow_customization_sessions`，并把 `flow_customization_heads` 指向它（新会话自动激活）。
  - 在会话里说一句：`POST …/sessions/:sessionId/turns`（`{ requestId, modelRef, prompt }`）。同一事务里写一行 turn（`prompt`、`context`、`model_ref`、`members` 快照）和一行 `waker_flow_requests`（`kind = "customize"`，同一个 `request_id`），然后走与 `generate()` 相同的规划路径：选择模型、检查额度、取消、重启恢复、幂等全部沿用。
  - `context` 是服务端拼出来的，不由客户端提交：当前已保存的计划（JSON）加上本会话最近 N 轮（决策 D3：6 轮）的 prompt 和结果摘要，总长不超过 20000 字。`flowPlanningPrompt()` 增加"当前计划"和"之前的修改要求"两段；之前几轮的模型输出作为不可信内容，用 `server/src/untrusted-content.ts` 的 `withUntrustedNotice()` 包起来。
  - 结果的处理与现在一样：草稿从未编译过时写进 Flow；已保存的 Flow 只返回候选计划，由编辑器展示差异，人点"应用"后再保存（保存走 `save()`，I6 照常检查）。
  - 历史：`GET …/sessions`（标题、轮数、更新时间、是否当前）、`GET …/sessions/:sessionId/turns`（每轮的 prompt、状态、候选计划、是否已应用）。
  - 激活：`POST …/sessions/:sessionId/activate` 只改 heads。打开 Flow 页面时默认打开当前会话。
  - 重命名和删除：按 `revision` 做乐观并发；删除是软删除（`deleted_at`），删除当前会话时 heads 置空。
- S-B：新建一张"对话消息"表，把会话做成通用聊天线程（`threads` 体系）。能复用聊天界面，但规划调用不是员工轮次，硬塞进线程会让线程里出现没有员工的"助手消息"，审计口径也会混淆。**不推荐**。

### 3.2 导入包格式（G5）

- 包是 Flow 定义的**副本**，与源 Flow 之间没有任何实时关联：

```
{ format: "wakerflow-share-v1",
  name, description,
  slots:  [{ slot: "s1", role, prompt }],          // 原来的成员，去掉 agentId
  inputs: [...],                                    // 与计划相同（含 WF8 的类型）
  steps:  [... 每一步的 agentId 换成 slot ...] }
```

- **不包含**：员工 id、模型、运行记录、步骤输出、任务卡、知识来源、凭据。`digest` 为规范化 JSON 的 sha256，导入时校验。包大小不超过 64KB。
- WF7 的节点：`decision` 原样保留；`action` 保留工具引用，但导入方要在映射时确认自己有这个工具，否则导入后必须改掉才能保存；`flow`（嵌套）引用的是源租户的另一个 Flow，**v1.0 不允许分享含嵌套节点的 Flow**（决策 D6，已决定）。

### 3.3 分享链接与约束（G3、G4）

- **L-A（推荐）：启用 `flow_share_links` 原有的令牌设计，并补一道更新守卫。**
  - 创建：`POST /api/wakerflows/:id/shares`（`{ id: <客户端生成的 uuid>, expiresInDays, maxUses }`）。只有已保存的 Flow 能分享。服务端生成 32 字节随机令牌，库里只存 `sha256` 后的 `token_hash`，**令牌明文只在这一次响应里出现**，链接形如 `/wakerflows/import/<token>`。用客户端给的 `id` 做幂等。
  - 约束：`expires_at` 必填，默认 7 天，最长 30 天；`max_uses` 默认 10，最大 100（决策 D4、D5，已决定）。
  - 撤销：`POST …/shares/:shareId/revoke` 写 `revoked_at`。删除 Flow 时撤销它的全部链接。
  - 列表：`GET …/shares`（剩余次数、到期时间、状态），不返回令牌。
  - **兑现（导入方，在导入方自己的租户框架内）**：在一个事务里，以 `SET LOCAL app.flow_share_token = <hash>` 读出这一行；校验未撤销、未过期（按数据库时钟）、`uses < max_uses`；然后 `UPDATE … SET uses = uses + 1 WHERE id = … AND uses = <读到的值>`，影响 0 行就按"已用完"处理。会话变量只在事务内有效，事务结束即失效。
  - **更新守卫**（迁移里新增，只追加）：一个 `BEFORE UPDATE` 触发器。当前框架不是行的所有者租户、也不是 `platform` 时，只允许 `uses` 恰好加 1，其他列一律不准改，从而补上 §1.2 的隐患。触发器函数固定 `search_path`，并从 PUBLIC 回收权限，与 `0122` 的 `openbot_team_*` 函数保持同一写法（`tenant-invariants.test.ts` (f) 检查这一点）。
  - 预览：`GET /api/wakerflow-shares/:token`（需要登录）返回名称、说明、角色列表、步骤数、到期时间、剩余次数，**不消耗次数**。过期、撤销、用完分别给出明确提示；令牌不存在一律 404。
- L-B：不用令牌会话变量，改用 `asAdminPlatform` 读写。实现更简单，但每次兑现都要打开平台框架，`DOORS` 里会多出一个平台入口，权限比需要的大得多。**不推荐**。
- L-C：只允许同一租户内分享。避开了跨租户问题，但个人即租户，同租户分享几乎没有用处。只有在 D1 被否决时才采用。

### 3.4 导入（G5）

- 导入对话框：预览 → 为每个角色槽位选择**导入方自己**能使用的员工（候选来自 `canUse`）→ `POST /api/wakerflow-shares/:token/import`（`{ requestId, members: { s1: agentId, … } }`）。
- 服务端：兑现一次次数（§3.3）→ 校验 `digest` → 把槽位换回导入方的员工 id → 用 `wakerFlowPlanSchema` 校验 → 以**草稿**创建一个新 Flow（`plan` 写入，不编译）。人检查后自己保存，保存时 I6 照常检查。
- 幂等：`flow_share_imports` 的 `(tenant_id, request_id)` 唯一。同一个请求重复提交返回同一个 Flow，不重复消耗次数；兑现与写入导入记录在同一个事务里。
- 导入方看不到源 Flow、源租户和源员工的任何信息，只看到包里的内容。

---

## 4. 待决策（已全部决定，2026-11-04）

| 编号 | 问题 | 决定 |
| --- | --- | --- |
| D1 | 是否同意跨租户分享与导入，作为 J3 和 §6"不做跨租户协作"的例外 | 已决定（2026-11-04）：同意，但仅限"定义的一次性副本"：不含员工、模型、数据，导入后与源头再无关联 |
| D2 | 是否同意原样启用 `flow_customization_*` 和 `flow_share_*` 休眠表（只追加 FORCE、`platform` 策略和更新守卫） | 已决定（2026-11-04）：同意 |
| D3 | 会话上下文带最近几轮 | 已决定（2026-11-04）：6 轮，总长 20000 字以内 |
| D4 | 链接有效期的默认值和上限 | 已决定（2026-11-04）：默认 7 天，最长 30 天，必须设置 |
| D5 | 次数的默认值、上限，能否不限次数 | 已决定（2026-11-04）：默认 10，最多 100，不提供"不限" |
| D6 | 含嵌套 Flow 节点的 Flow 能否分享 | 已决定（2026-11-04）：v1.0 不能，分享时提示先去掉嵌套节点 |
| D7 | 兑现用令牌会话变量（L-A）还是平台框架（L-B） | 已决定（2026-11-04）：L-A，并补更新守卫 |
| D8 | 导入后的 Flow 是否自动保存为可运行 | 已决定（2026-11-04）：不自动保存，以草稿导入，由人检查后保存 |
| D9 | 分享链接本身是否需要登录才能预览 | 已决定（2026-11-04）：需要登录；未登录时先跳到登录页再回来 |

---

## 5. 分阶段计划

前置：WF8、WF7 已合入。迁移编号按总览预留，本故事用 **0139**、**0140**。新增服务端测试后运行 `bun scripts/ci/server-shards.mjs --write`。

### WF9-1：自定义会话（服务端，迁移 0139，7 个文件）
- 文件：`sql/0139_flow_customization_active.sql`（三张表加 FORCE 和 `platform` 策略）、`meta/_journal.json`、`server/src/wakerflows/sessions.ts`（新增：会话、轮次、激活）、`server/src/wakerflows/store.ts`（`customize` 请求走规划路径）、`server/src/wakerflows/generator.ts`（提示词增加当前计划和之前的要求）、`server/src/wakerflows/routes.ts`、`server/tests/wakerflow-sessions.integration.test.ts`（新增）。
- 验收：
  1. 新建会话后 heads 指向它；连说两轮，第二轮的提示词里包含第一轮的要求和当前计划（用测试替身模型断言收到的提示词）。
  2. 已保存的 Flow：一轮结束后 Flow 的 `plan` 和 `template_id` 不变，返回的候选计划 `applied = false`。
  3. 同一个 `requestId` 发两次只调用一次模型；指纹不同返回 409。
  4. 进程在轮次进行中退出：重启后该请求为 `unknown`，不重放（沿用 `recovery.ts`）。
  5. 删除当前会话后 heads 为空；租户 B 访问租户 A 的会话返回 404。

### WF9-2：会话界面（前端，4 个文件）
- 文件：`app/src/components/wakerflow/session-panel.tsx`（新增）、`app/src/routes/_authed/_app/wakerflows.$flowId.tsx`、`app/src/lib/wakerflows.ts`、`app/tests/wakerflow-sessions.test.tsx`（新增）。
- 验收：Flow 页面右侧是会话面板，可以切换历史会话；候选计划显示与当前计划的差异，点"应用"后进入编辑器，保存才生效；生成中可以取消。

### WF9-3：分享与导入（服务端，迁移 0140，7 个文件）
- 文件：`sql/0140_flow_sharing_active.sql`（两张表加 FORCE、`platform` 策略和更新守卫触发器）、`meta/_journal.json`、`server/src/wakerflows/sharing.ts`（新增：打包、创建、撤销、预览、兑现、导入）、`server/src/wakerflows/routes.ts`（所有者的分享路由）、`server/src/index.ts`（挂载 `/api/wakerflow-shares`）、`server/tests/wakerflow-sharing.integration.test.ts`（新增）、`server/tests/tenant-invariants.test.ts`（登记令牌会话变量这一入口）。
- 验收：
  1. 租户 A 创建链接（`max_uses = 2`），租户 B、C 各导入一次成功，租户 D 导入时提示"已用完"；A 看到的 `uses = 2`。
  2. B 用同一个 `requestId` 重复导入，返回同一个 Flow，`uses` 不变。
  3. 链接过期（把数据库时间推过 `expires_at`）或被撤销后，预览和导入都被拒。
  4. 在 B 的框架内、设置了令牌变量时，直接 `UPDATE flow_share_links SET expires_at = …` 被触发器拒绝；只有 `uses + 1` 能成功。
  5. 导入的 Flow 是草稿，成员是 B 自己的员工；包里没有出现 A 的员工 id、模型 id 或任何运行输出（对快照做字段级断言）。
  6. 含嵌套节点的 Flow 创建链接被拒；`digest` 不符的快照导入被拒。
  7. 预览不改变 `uses`；令牌不存在返回 404。

### WF9-4：分享与导入界面（前端，5 个文件）
- 文件：`app/src/components/wakerflow/share-dialog.tsx`（新增：创建、复制链接、列表、撤销）、`app/src/routes/_authed/_app/wakerflows.import.$token.tsx`（新增：预览、映射成员、导入；`routeTree.gen.ts` 不计数）、`app/src/routes/_authed/_app/wakerflows.$flowId.tsx`、`app/src/lib/wakerflows.ts`、`app/tests/wakerflow-share.test.tsx`（新增）。
- 验收：创建后链接只显示一次，并提示"关闭后无法再次查看"；导入页每个角色槽位都选了员工之后才能提交；导入成功后跳转到新 Flow 的编辑器。

---

## 6. 验收测试

1. `server/tests/wakerflow-sessions.integration.test.ts`：见 WF9-1 验收 1–5。
2. `server/tests/wakerflow-sharing.integration.test.ts`：见 WF9-3 验收 1–7。跨租户场景至少用 3 个真实注册的租户，全部经过 `runAsTenant`。
3. `server/tests/tenant-invariants.test.ts`：新入口被登记，触发器函数满足 (f) 的写法要求。
4. 回归：`wakerflow-generation-requests.integration.test.ts`、`wakerflow-restart-recovery.integration.test.ts`、`recovery-flow-customization-*.test.ts`、`recovery-flow-sharing-foundations.test.ts` 保持通过。
5. 前端：`app/tests/wakerflow-sessions.test.tsx`、`wakerflow-share.test.tsx`。
