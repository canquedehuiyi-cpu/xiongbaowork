# ROLE1 角色模板与员工实例分离（智能生成 / Markdown / 手工编写 Identity、Persona、Bible）设计规格

- 日期：2026-11-04
- 状态：**已定稿**（2026-11-04）。第 4 节的待决策项已全部决定，均采纳建议；本文不含代码。
- 故事：`docs/acceptance/STORIES.md` ROLE1（D07）：角色模板和员工实例分离，智能生成/Markdown/手工 Identity Persona Bible。11-02 的 MVP 决定曾把它移到 v1.0 后，现在拉回范围。
- 原文出处：`docs/specs/2026-10-06-qoderwake-replica.md:114` 的 D6（人设与角色描述分开维护，"人设可另存为模板复用给新员工"）和 `:110` 的 D2（新建 Waker）；完整要求见 `docs/plans/2026-10-10-完整仿制接手.md:58` 的 C4："角色模板与实例分离，Markdown/手工 Identity/Persona/Bible"。
- 相关：D2、D6、D7（员工装配页）、H1（模型库，智能生成用）、F1（分身是 `built_in`，见 §1.4）。与 WakerFlow 系列、RES2 都不共用文件，可以并行。

---

## 1. 现状（基线：`claude/magical-archimedes-8a6ljj`，`bcdc46f`）

### 1.1 员工实例：身份和人设已经有了，"Bible"没有

- `agent_profiles`（`server/src/db/schema/coworker.ts:37`）就是员工实例：`title`、`roleDescription`（职责）、`avatarSeed`、`visibility`、`modelRef`/`platformModelRef`、`persona` jsonb、`configuredAt` 等。`server/tests/schema.test.ts:225` 逐列锁定了这张表的结构（F1 加 `configured_at` 时同步更新过，`:331`）。
- 人设 `shared/persona.ts:9` 是三段：`tone`（性格语气）、`principles`（工作守则）、`habits`（口头约束），与 replica D6 的三项一一对应。`personaGuidance()`（同文件）把它变成提示词的一段。
- 注入位置：内置员工在 `server/src/copilot.ts:482` 取人设，`:498-501` 按"系统提示词 → 人设 → 本人常驻指令 → 分身来源"的顺序拼接；远程员工在 `copilot.ts:176` 的 `standingRoleMessage()` 里拼（`:187`）。
- 没有"Bible"：没有放长篇背景知识、工作手册或术语表的地方。`roleDescription` 是短句，并且会被路由器读取（`routing/classify.ts`，见 F1 规格 §1.1），不适合放长文。

### 1.2 模板：只有"人设模板"，并且只是一份拷贝

- `persona_templates`（`coworker.ts:197`）：`tenant_id`、`name`、`persona`，按 `(tenant_id, name)` 唯一。`server/src/personas/store.ts` 按名字 upsert，`/api/personas` 挂在 `server/src/index.ts:4248`。
- 前端 `app/src/components/agents/agent-dialog.tsx` 的"人设"分区（`:127`、`:771` 起）可以"另存为模板"和"从模板套用"。注释写明"套用的是拷贝，不是引用"（`:774`）。所以套用之后，员工**不知道**自己来自哪个模板，模板改了也无从提示。
- 模板只覆盖人设，不含身份（头衔、职责）。新建员工（`app/src/components/agents/create-agent-dialog.tsx`）不能从模板开始。
- 租户包 `examples/qoderwake/agents.yaml` 里的种子角色卡（后端工程师、代码审核员等）是直接写好的员工，不是可复用的模板。

### 1.3 休眠的角色表（迁移 `0082`，已 FORCE，没有代码读写）

`server/src/db/schema/roles.ts`，被 `server/tests/recovery-role-foundations.test.ts` 按元数据锁定：

- `role_templates`（`:53`）：`id`、`owner_user_id`、`name`（1–80）、`profile` jsonb（必须是对象）、`version`（>0）、`updated_at`；`(tenant_id, owner_user_id, name)` 唯一。
- `employee_role_snapshots`（`:85`）：主键 `agent_id`，`profile`、`version`、`source_template_id` 与 `source_template_version`（两者同时为空或同时有值）。
- `role_generation_requests`（`:115`）：`request_id`、`fingerprint`、`model_ref`（uuid，必填）、`state ∈ pending|completed|failed|unknown`（`completed` 当且仅当 `profile` 非空）、`lease_expires_at`（默认 now()+60 秒）、`dispatch_started_at`。
- `role_write_receipts`（`:151`）：写操作幂等回执。
- 四张表共用的 RLS（`:21-22`）：`tenant_id = app.tenant_id AND owner_user_id = tenant_id AND tenant_id NOT IN ('system','platform')`。也就是只有个人租户本人能读写，`platform` 框架**写不进去**。

### 1.4 一个需要绕开的耦合

`server/src/agents/profile-store.ts:898`：更新 `built_in` 员工时，新的 `roleDescription` 会同时写进 `configuration.systemPrompt`。对内置员工（包括"我的分身"）套用模板，会把它的系统提示词整个替换掉。

### 1.5 智能生成可以复用的部件

`server/src/wakerflows/model.ts` 的 `createFlowModelResolver()` 已经实现了"从本人模型库选一个模型，拿不到就拒绝、绝不换成部署模型"，并且接了出站守卫；`wakerflows/generator.ts` 示范了"提示词 → 取第一个 JSON 对象 → zod 校验"的写法；规划调用之前先 `assertCapacity(tenantId, "tasksPerMonth")`（`wakerflows/store.ts:822`）。

---

## 2. 差距

| # | 故事要求 | 差距 |
| --- | --- | --- |
| G1 | Identity / Persona / Bible 三部分 | 没有 Bible |
| G2 | 角色模板 | 只有人设模板，不含身份和 Bible，没有版本 |
| G3 | 模板与实例分离 | 套用后不记录来源和版本，模板更新无从提示 |
| G4 | 从模板新建员工 | 新建向导不能选模板 |
| G5 | 智能生成 | 没有 |
| G6 | Markdown 导入导出 | 没有 |
| G7 | 测试 | 没有 |

---

## 3. 方案

### 3.1 统一的角色档案

```
RoleProfile = {
  identity: { title: string(≤80), roleDescription: string(≤500) },
  persona:  { tone, principles, habits },     // 沿用 shared/persona.ts
  bible:    string(≤8000)                      // Markdown 正文
}
```

放在新文件 `shared/role-profile.ts`，同时提供 zod 校验、Markdown 解析和 Markdown 生成。员工名字、头像、模型、技能**不属于**角色档案，它们是实例自己的。

### 3.2 模板和实例放在哪里

- **方案 A：全部启用休眠表。** 模板放 `role_templates`，实例放 `employee_role_snapshots`，`agent_profiles` 的 `title/roleDescription/persona` 由写入方同步。问题是实例有了两份：运行时、路由、Team Bot 读的都是 `agent_profiles`，两份迟早会不一致；而且快照表的策略要求 `owner_user_id = tenant_id`，Team Bot 的行（`tenant_id = 'team'`）根本写不进去。
- **方案 B：只扩展现有表。** `persona_templates` 加 `identity`、`bible`、`version`；`agent_profiles` 加 `bible`。不碰休眠表，但模板版本、生成请求的租约和幂等都要自己重做一遍，等于重写一份 `roles.ts` 里已有的结构。
- **方案 C（推荐）：模板用休眠表，实例留在 `agent_profiles`。**
  - 模板：原样启用 `role_templates`（`profile` 存 `RoleProfile`），每次修改 `version + 1`。
  - 实例：`agent_profiles` 新增三列：`bible text`（可空）、`role_template_id uuid`（可空）、`role_template_version integer`（可空，与前者同时为空或同时有值）。运行时只有这一个来源。
  - 智能生成：原样启用 `role_generation_requests`。
  - `employee_role_snapshots` 和 `role_write_receipts` 继续休眠，原因写进迁移注释：实例的唯一来源是 `agent_profiles`；写操作的幂等由 `role_templates` 的唯一名和 `version` 条件更新保证。
- 休眠表的启用规则与 WF8 §3.7 相同：不改 `roles.ts` 的结构，迁移只追加内容（这四张表已经 FORCE，`platform` 不加，因为模板不需要平台框架读写）。

### 3.3 模板与实例的关系

- **从模板新建员工**：新建向导的第一步可以"从模板开始"；身份和人设预填，Bible 复制；保存时记录 `role_template_id` 和 `role_template_version`。
- **套用到已有员工**：员工详情的"角色"分区里选一个模板，先显示与当前内容的差异，确认后覆盖身份、人设和 Bible，并记录来源。名字、头像、模型、技能、职责计划都不变。
- **模板更新后**：实例**不自动跟随**。员工详情显示"模板「后端工程师」有新版本（v3，当前 v2）"，点"按模板更新"走与套用相同的差异确认流程。
- **实例改过之后**：仍然保留来源记录，但标注"已在模板基础上修改"（比较实例与该版本模板内容是否一致即可，不需要额外存储）。
- **删除模板**：实例保留内容，来源记录置空（应用层处理，不加外键，因为 `agent_profiles` 和 `role_templates` 的 RLS 范围不同）。
- **分身**（`avatar-<本人 id>`）：不允许套用模板（决策 D4）。分身代表本人，运行所用的系统提示词有意不同于它的职责描述，模板会把它替换掉。Bible 可以手工编辑，且只追加到提示词，不写入 `systemPrompt`。
- **其他内置员工**（`agents.type = built_in`，分身除外）：可以套用模板（D4 于 2026-11-04 改为只挡分身）。单容器部署里人自己建的员工都是 `built_in`，原规则等于关掉了整个功能。套用时与手工改职责描述一样（§1.4）：模板的职责描述同时写进 `configuration.systemPrompt`；职责描述不变时提示词也不变。从模板新建的 `built_in` 员工同样记录来源。

### 3.4 Bible 进入提示词

- 位置：人设之后、常驻指令之前（`copilot.ts:501` 之后；远程员工在 `standingRoleMessage()` 的人设之后）。标题为"你的工作手册（由你的所有者编写）"，后面附一句：手册是参考资料，与本人当前的明确要求冲突时，以本人要求为准。
- 长度：最多 8000 字，**整段注入**，不做检索（决策 D3，已决定）。超长时在编辑器里提示，不允许保存。
- 与人设一样，视为所有者编写的内容，不加不可信声明。但智能生成和 Markdown 导入的内容在**保存之前**必须由人确认，系统不会代为保存（§3.5、§3.6）。

### 3.5 智能生成

- 入口：模板编辑器和新建向导里的"智能生成"。输入一句话描述（≤500 字），选择一个模型。
- 模型：复用 `createFlowModelResolver()`。只能选本人模型库里的模型（`role_generation_requests.model_ref` 是 uuid，平台模型本来就写不进去）。
- 请求：`POST /api/role-templates/generate`（`{ requestId, modelRef, description }`）。写一行 `pending`，租约 60 秒；同一个 `requestId` 直接返回已有结果，不再调用模型；指纹不同返回 409；租约过期仍是 `pending` 的请求，在下一次读取时判为 `unknown`，不重放（与 WakerFlow 的请求语义一致）。
- 结果：模型输出按 `RoleProfile` 校验，失败给出"生成的格式无效，请重试"。结果**只填进编辑器**，不自动保存成模板或写进员工。
- 额度：调用之前 `assertCapacity(tenantId, "tasksPerMonth")`，与 WakerFlow 规划相同。

### 3.6 Markdown 导入与导出

固定格式，中英文标题都认：

```
# 身份            （或 # Identity）
头衔：Backend Engineer
## 职责
按需求写实现、跑测试……
# 人设            （或 # Persona）
## 性格语气
## 工作守则
## 口头约束
# 手册            （或 # Bible）
……任意 Markdown……
```

- 导入：解析成 `RoleProfile` 后填进编辑器，由人确认后保存。出现未知的一级标题、缺少必填项或超长时，报错并指出是哪一段，**不静默丢弃**内容。只在浏览器里解析粘贴的文本或选择的 `.md` 文件，不上传文件。
- 导出：模板和员工都可以导出为 `.md`。导出再导入，得到的档案与原来完全相同（往返测试锁定）。

### 3.7 旧的人设模板

- 迁移里把 `persona_templates` 的行逐个租户复制进 `role_templates`（身份留空、Bible 为空，`version = 1`）。因为 `role_templates` 的策略禁止 `platform` 框架写入，迁移用一个 `DO` 块按租户逐个设置事务内的 `app.tenant_id`，并跳过 `system`、`platform`、`team`；按唯一名 `ON CONFLICT DO NOTHING`，重复执行不产生重复行。
- `/api/personas` 在 ROLE1-2 改为读写 `role_templates` 里的人设部分，旧界面在 ROLE1-4 替换之前照常可用。ROLE1-1 合入之后、ROLE1-2 合入之前新存的人设模板仍在旧表里，所以兼容层的列表同时读两张表（同名时以 `role_templates` 为准），不会丢失；`persona_templates` 表保留不删，留到以后单独清理（决策 D6，已决定）。

---

## 4. 待决策（已全部决定，2026-11-04）

| 编号 | 问题 | 决定 |
| --- | --- | --- |
| D1 | 存储选方案 A、B 还是 C | 已决定（2026-11-04）：C：模板用休眠的 `role_templates`，实例留在 `agent_profiles` |
| D2 | 模板更新后实例是否自动跟随 | 已决定（2026-11-04）：不自动跟随，提示有新版本，由人点"按模板更新" |
| D3 | Bible 的长度上限，是否整段注入 | 已决定（2026-11-04）：8000 字，整段注入；更长的资料以后走知识库（RES1） |
| D4 | 内置员工（含分身）能否套用模板 | 已决定（2026-11-04）：最初为 v1.0 内置员工都不能；2026-11-04 用户改为只挡分身，其他内置员工可以套用（套用时职责描述同步写入 `systemPrompt`）。Bible 都可以手工编辑 |
| D5 | 租户包里的种子角色卡是否作为"官方模板"提供 | 已决定（2026-11-04）：提供，从 `agents.yaml` 派生为只读模板，不写入数据库 |
| D6 | 旧的人设模板怎么处理 | 已决定（2026-11-04）：迁移时复制进 `role_templates`，`/api/personas` 改为兼容层，旧表以后再删 |
| D7 | 智能生成能否用平台体验模型 | 已决定（2026-11-04）：不能，只用本人模型库里的模型 |
| D8 | 模板能否在租户之间分享 | 已决定（2026-11-04）：不能（J3）；需要时用 Markdown 导出再导入 |

---

## 5. 分阶段计划

迁移编号按总览预留，本故事用 **0135**；它与 WakerFlow 系列并行，推送前检查 origin，如果号码被占用就顺延。新增服务端测试后运行 `bun scripts/ci/server-shards.mjs --write`。

### ROLE1-1：实例的新列（服务端，迁移 0135，8 个文件）
- 文件：`sql/0135_role_profiles.sql`（`agent_profiles` 三列、CHECK、启用 `role_templates` 与 `role_generation_requests` 的说明注释、人设模板复制）、`meta/_journal.json`、`server/src/db/schema/coworker.ts`、`server/src/agents/profile-types.ts`、`server/src/agents/profile-store.ts`、`server/src/agents/routes.ts`、`server/tests/schema.test.ts`（更新 `agent_profiles` 的列清单；这是契约变更，不是放宽断言）、`server/tests/agent-role-bible.integration.test.ts`（新增）。
- 验收：
  1. `PATCH /api/agents/:id` 可以写 `bible`；超过 8000 字返回 400；不带 `bible` 的更新不改变它。
  2. `role_template_id` 与 `role_template_version` 一个为空一个不为空时，数据库拒绝。
  3. 对 `built_in` 员工写 `bible`，`configuration.systemPrompt` 不变。
  4. 迁移在一个有两条人设模板的租户上运行后，`role_templates` 里有两条同名行；再执行一次复制语句，行数不变。

### ROLE1-2：模板库、套用、Markdown 与 Bible 注入（服务端，8 个文件）
- 文件：`shared/role-profile.ts`（新增：类型、zod、Markdown 解析与生成）、`server/src/roles/store.ts`（新增：模板增删改查、版本条件更新、套用到员工）、`server/src/roles/routes.ts`（新增：`/api/role-templates`）、`server/src/personas/store.ts`（改为兼容层）、`server/src/copilot.ts`（Bible 注入两处）、`server/src/index.ts`（挂载）、`server/tests/role-templates.integration.test.ts`（新增）、`server/tests/role-profile-markdown.test.ts`（新增，纯函数）。
- 验收：
  1. 修改模板时用旧的 `version` 提交返回 409；成功修改后 `version + 1`。
  2. 套用模板后，员工的 `title/roleDescription/persona/bible` 等于模板内容，并记录了来源和版本；名字、头像、模型不变。
  3. 模板更新到 v2 之后，员工详情接口返回"有新版本"；员工内容不变。
  4. 对分身套用模板返回 400，内容不变；对分身以外的 `built_in` 员工套用模板成功，`configuration.systemPrompt` 变为模板的职责描述（D4，2026-11-04 修订）。
  5. 有 Bible 的员工，其提示词里人设之后出现手册段落；没有 Bible 时不出现这一段（内置和远程两条路径都测）。
  6. Markdown 往返：导出再解析与原档案深度相等；未知一级标题报错并指出标题文字。
  7. 租户 B 读写租户 A 的模板返回 404；`/api/personas` 的现有测试保持通过。

### ROLE1-3：智能生成（服务端，5 个文件）
- 文件：`server/src/roles/generator.ts`（新增：提示词、解析、校验）、`server/src/roles/store.ts`（`generate()`：请求行、租约、幂等）、`server/src/roles/routes.ts`、`server/src/index.ts`（接线模型解析器和额度）、`server/tests/role-generation.integration.test.ts`（新增，测试替身模型）。
- 验收：
  1. 同一个 `requestId` 请求两次，模型只被调用一次，两次返回相同的档案。
  2. 模型返回无效 JSON 时状态为 `failed`，提示可以重试；不写入任何模板或员工。
  3. 选择不属于本人或已停用的模型返回 400，没有任何模型调用。
  4. 租约过期仍为 `pending` 的请求，读取时变为 `unknown`。
  5. 月度额度已满时直接拒绝，不写请求行。

### ROLE1-4：界面（前端，7 个文件）
- 文件：`app/src/routes/_authed/_app/role-templates.tsx`（新增"角色模板"页，从"Waker 管理"进入）、`app/src/components/roles/role-editor.tsx`（新增：身份、人设、手册三个标签页，Markdown 导入导出，智能生成）、`app/src/lib/roles/queries.ts`（新增）、`app/src/components/agents/create-agent-dialog.tsx`（从模板开始）、`app/src/components/agents/agent-dialog.tsx`（"人设"分区改为"角色"：Bible、来源与新版本提示、按模板更新）、`app/tests/role-templates.test.tsx`（新增）、`app/tests/create-agent-from-template.test.tsx`（新增）。
- 验收：
  1. 粘贴一段 Markdown 后三个标签页都被填好；格式错误时就地显示是哪一段。
  2. 智能生成的结果出现在编辑器里，未保存时离开页面有提示。
  3. 从模板新建的员工，详情页显示"来自模板「…」v1"。
  4. 模板升级后员工详情出现提示，点"按模板更新"先看差异再确认。
  5. 分身的"角色"分区没有"套用模板"按钮；其他员工（包括内置员工）有（D4，2026-11-04 修订；由服务端的 `acceptsRoleTemplate` 决定）。
  6. `app/tests/agent-dialog-built-in-edit.test.tsx`、`create-agent-avatar.test.tsx` 保持通过。

---

## 6. 验收测试

1. `server/tests/role-profile-markdown.test.ts`（纯函数）：中英文标题、缺段、超长、未知标题、往返，正反例各至少 8 条。
2. `server/tests/agent-role-bible.integration.test.ts`、`role-templates.integration.test.ts`、`role-generation.integration.test.ts`：见各阶段验收。全部真库、`runAsTenant`，模型用测试替身。
3. 回归：`schema.test.ts`（只增加新列）、`recovery-role-foundations.test.ts`（`roles.ts` 的结构不变，必须原样通过）、现有的人设与员工测试、`copilot` 相关测试。
4. 前端：`app/tests/role-templates.test.tsx`、`create-agent-from-template.test.tsx`。
