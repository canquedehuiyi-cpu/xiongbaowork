# F1 "我的分身"信息来源引导设计规格

- 日期：2026-11-02
- 状态：**草案，含待决策项**。需要产品拍板后再动工；本文不含代码。
- 故事：`docs/acceptance/STORIES.md` F1（D11），原文见 `docs/specs/2026-10-06-qoderwake-replica.md:126`：首次登录进入"我的分身"引导，选择信息来源（本地文件夹或知识源声明），保存后生成特殊的 built-in Waker"我的分身"，并把所选来源注入它的角色描述。
- 相关：J1（注册即开通租户，包含"我的分身"）、F2/F3（runner）、RES1（知识库，现状为"缺失（只有表）"）、RES2（本地目录项目，标为 v1.0 后）。

---

## 1. 现状（基线：`claude/magical-archimedes-8a6ljj`）

### 1.1 分身在注册时就已创建

- `server/src/tenant/provisioning.ts` 中的 `provisionTenant()` 由 Better Auth 的 user-create 钩子调用，在 `runAsTenant(user.id)` 内完成写入：
  - `agents` 表：id 为 `avatarAgentId(tenantId)`，即 `avatar-<tenantId>`，`name: "我的分身"`，`type: "built_in"`，`configuration.systemPrompt` 是一段固定中文提示词。
  - `agent_profiles` 表：`roleDescription` 写死为 **"选择你的信息来源，为个人分身完成输入配置。"**（第 69 行），`visibility: "private"`。
- `server/src/quota/limits.ts:168` 按 `avatarAgentId` 把分身排除在员工配额之外。现有测试只检查这一行是否存在：`server/tests/quota.test.ts`、`quota-concurrency.integration.test.ts`、`email-signup.test.ts`。
- **占位句去了哪里**：分身是 `built_in`，`server/src/copilot.ts:249` 的 `registeredAgentFromRow()` 只把 `configuration.systemPrompt` 交给它，`standingRoleMessage()`（`copilot.ts:154`）只用于远程员工，所以 `roleDescription` **不会**进入分身自己的提示词（`agents/profile-store.ts` 约第 572 行的注释也写明了这一点）。但这句占位文本会出现在员工列表和详情页上，并且作为分身的 `for:` 进入路由分类提示词（`server/src/routing/classify.ts:95` 的 `routingPrompt()`，候选来自 `routing/routes.ts:183`），相当于告诉路由器"这个员工是用来配置信息来源的"。
- 另外，`profile-store.ts` 更新 `built_in` 员工时会把新的 `roleDescription` 同时写进 `configuration.systemPrompt`（约第 590 行）。用户一旦编辑分身的角色描述，provisioning 写入的固定提示词就被覆盖。

### 1.2 引导向导里没有"信息来源"这一步

- `app/src/routes/_authed.tsx` 用 `needsOnboarding(user)` 把未完成引导的用户重定向到 `/onboarding`。
- `app/src/routes/_authed/onboarding.tsx` 只有三步：`WelcomeStep`、`ComputerUseStep`、`RosterStep`。当前步骤存在浏览器内存里（第 170 行注释："not persisted while the wizard is being designed"），完成时调用 `completeOnboardingMutationOptions`。
- 服务端其实能保存进度：`server/src/app.ts:649` 的 `POST /api/me/onboarding` 接受 `{step}` 或 `{completed}`，写入 `users.onboarding_step` 和 `onboarding_completed_at`（`db/schema/core.ts:90`）。前端有 `advanceOnboardingMutationOptions`，但向导没有调用它。

### 1.3 现有的"知识源"都没有被用起来

- `server/src/tenant-package.ts:235` 的 `knowledgeSources`（google-drive / microsoft-onedrive 加 roots）只在**包级别**声明，注释写明 "Parsed and validated, and currently read by nothing"。原先读取它的连接器用服务账号同步，回答时所有人都以部署身份出现，因此被删除。**不能复用这个字段**。
- `server/src/db/schema/knowledge-foundations.ts` 的 `knowledge_notebooks`、`knowledge_directories`、`knowledge_sources` 三张表注释为 "Historical 0121 structure only"，没有读写方。RLS 要求 `owner_user_id = tenant_id`；`kind ∈ text|markdown|file|url|document`；`raw_content` 最多 65536 个字符，文档字节最多 2MB（2097152）。
- 另外两条可以注入提示词的通道：`server/src/user-instructions.ts`（每人一份常驻指令，追加到提示词，不涉及任何授权）和 `server/src/memory/`（store、ingestion、tools）。

### 1.4 runner 能读的只有它自己的工作区

`runner/src/execute.ts` 支持 `files.list` 和 `files.read`，但工作区是固定的 `runner-workspace`（`runner/src/index.ts:35`），并且受 `agent-computer/src/workspace.ts` 的三层路径约束：拒绝绝对路径、拒绝 `..`、拒绝符号链接逃逸。**用户自己选择的文件夹目前根本读不到**。

---

## 2. 差距

| # | 故事要求 | 差距 |
| --- | --- | --- |
| G1 | 引导里有"选择信息来源"这一步 | 向导没有这一步 |
| G2 | 保存选择 | 没有按人保存来源的 API 或表 |
| G3 | 把来源注入角色描述 | 没有任何注入；占位句只是被路由器和界面当作职责（分身自己的提示词里没有它） |
| G4 | "保存后生成"分身 | 分身在注册时就已生成 |
| G5 | 本地文件夹 | runner 没有"用户授权的只读根目录"这一概念 |
| G6 | 测试 | 没有覆盖"选择 → 保存 → 注入"的测试 |

---

## 3. 来源类型的选项

| 代号 | 来源 | 实现 | 依赖 | 成本 |
| --- | --- | --- | --- | --- |
| S1 | **声明**（纯文字，例如"我的周报在飞书 / 工作 / 周报"） | 只把文字注入提示词，不授予任何访问权 | 无 | S |
| S2 | **本地文件夹（通过 runner）** | 在已配对设备上登记一个只读根目录，分身用 `files.list/read` 加上 `root` 参数按需读取 | F2 打包、F3 网关下发；runner 需新增只读根目录（复用 `createWorkspace` 的约束，另加只读限制） | L |
| S3 | **知识源（上传 / 粘贴 / URL）** | 启用 `knowledge_*` 表，每个分身一个 notebook；运行时检索或摘要后注入 | 与 RES1 重叠，需要写入方、解析和配额 | L |
| S4 | **云盘连接器**（按人 OAuth） | 走现有连接器授权体系（ADR 0002 的按租户行），给分身装配 Drive 等 MCP | 平台目录里要先上架；不走包级 `knowledgeSources` | M |

## 4. 存储位置的选项

- **T1 新表 `avatar_sources`（推荐）**：字段 `tenant_id, id uuid, agent_id, kind ('declaration'|'local_folder'|'notebook'|'connector'), label text(≤60), note text(≤500), device_id null, root_ref null, created_at, revoked_at`。RLS 与 `agent_profiles` 的所有者一致，`agent_id` 只能是 `avatar-<tenant>`。
- T2 写进 `agents.configuration.sources`（jsonb）：不用迁移，但没有约束，也无法单独审计或撤销；而且 `registeredAgentFromRow()` 解析 configuration 失败时会让员工整个失效，风险集中。
- T3 拼成文字写进 `user_instructions`：最省事，但它对**所有**员工生效，不只是分身，语义不对。

**本地路径的隐私设计**（S2 适用）：服务端只保存 `device_id`、`root_ref`（runner 端生成的不透明 id）和用户自填的 `label`。**绝对路径只存在 runner 本机的配置里**，因为目录名本身可能含有姓名、客户名等个人信息。

---

## 5. 注入方式

- **运行时注入，而不是改写 `roleDescription` 或 `systemPrompt`**：分身是 `built_in`，正确的接缝是 `copilot.ts:346` 的 `builtInAgentConfiguration()`，与 `standingInstructionsGuidance()`（`copilot.ts:334`）并列追加一段"信息来源"块；来源按运行读取，做法照搬 `index.ts:1388` 的 `loadInstructionsForActor`（每次运行读一次，不在启动时缓存），经 `buildAgents()`（`copilot.ts:484`）传入。这样来源增删立即生效。`standingRoleMessage()` 只服务远程员工，不要改它。
- 改写 `roleDescription` 不可取，还有一个原因：按上文，对 `built_in` 员工编辑 `roleDescription` 会连带覆盖 `systemPrompt`。
- 来源的 label 和 note 是用户输入，视为不可信内容，用 `server/src/untrusted-content.ts:60` 的 `withUntrustedNotice(value, source)` 包起来（它接收对象，例如 `{ sources: [...] }`），防止有人借 note 写入指令。
- 只注入来源的**清单与用法说明**（例如"需要时用 files.read 读取'工作资料'里的文件"），**不**把文件内容塞进提示词。
- 同时，把 `provisioning.ts` 里的占位 `roleDescription` 改为一段中性的职责描述，让路由器和界面不再把"配置信息来源"当作分身的用途。

---

## 6. 隐私与租户

1. 所有新表都带 `tenant_id`，并在 `runAsTenant` 内读写；分身的 `visibility` 保持 `private`，其他成员看不到它的来源。
2. S2 选择设备时只列出 `devices/store.ts` 中本租户的设备；配对令牌和设备归属沿用现有的租户隔离测试（`server/tests/devices.test.ts`）。
3. 文件内容只在分身执行 `files.read` 时经过网关，也就是会进入审计和 SEC1 的敏感路径判定；服务端不做镜像、不做索引。
4. 文件片段会发送给租户配置的模型提供方（H1 模型库），这一点在引导页上**明确告知**（**待决策 D6**：文案和是否需要勾选同意）。
5. 删除来源会写入 `revoked_at`，下一次运行就不再注入；S2 需要同时通知 runner 注销该根目录。
6. 包级 `knowledgeSources` 继续保持无人读取，不承担任何用户数据。

---

## 7. 待决策

| 编号 | 问题 | 建议 |
| --- | --- | --- |
| D1 | **待决策**：v1.0 支持哪些来源 | S1 加 S2；S3 跟 RES1 一起做；S4 等连接器目录 |
| D2 | **待决策**：分身改成"保存后才生成"，还是保持注册即生成，只加一个"已配置"状态 | 保持注册即生成（配额与现有测试都依赖 `avatarAgentId`），新增 `configured_at`，未配置时在员工列表显示"待配置" |
| D3 | **待决策**：这一步能否跳过 | 可以跳过，之后在分身详情页补配 |
| D4 | **待决策**：用户还没配对设备时，S2 怎么处理 | 显示配对引导（链接到 My Devices）并允许先保存其他来源 |
| D5 | **待决策**：存储选 T1、T2 还是 T3 | T1 |
| D6 | **待决策**：模型外发的告知方式 | 页面说明加一次勾选 |
| D7 | **待决策**：每个分身最多几个来源，单个本地根目录有无大小上限 | 最多 10 个；本地根目录不设上限，但单次读取沿用现有的上限 |
| D8 | **待决策**：向导步骤是否改为服务端持久化（接入 `advanceOnboardingMutationOptions`） | 是；这一步完成后调用 advance |

---

## 8. 推荐的分阶段计划

### 阶段 1：S1 声明，加上存储、注入和引导页（不依赖 runner）
- 迁移 `avatar_sources`（写进 `server/recovery/recovery-20261018-v1/sql/` overlay，`server/drizzle/` 停在 0080 且冻结）；新增 `GET/POST/DELETE /api/me/avatar/sources`；引导向导新增 `SourcesStep`，放在 `WelcomeStep` 之后，并接入服务端持久化；在 `copilot.ts` 中注入来源块；改掉占位的 `roleDescription`。

### 阶段 2：S2 本地文件夹（依赖 F2 阶段 0–1 和 F3）
- runner 新增只读根目录登记（一个新的本地命令或托盘菜单项，生成 `root_ref`），`files.list/read` 增加 `root` 参数；只读根目录上的写操作一律拒绝。

### 阶段 3：S3 和 S4（与 RES1 和连接器目录合并排期）

---

## 9. 验收测试

1. `server/tests/avatar-sources.test.ts`（新增，真库，使用 `runAsTenant`；新增后运行 `bun scripts/ci/server-shards.mjs --write`）：
   - 保存两条声明后，GET 按创建顺序返回这两条。
   - 租户 B 读不到租户 A 的来源；写入时 `agent_id` 不是本租户分身则被拒。
   - 删除后 `revoked_at` 被写入，列表里不再返回。
2. `server/tests/copilot-avatar-sources.test.ts`（或扩展现有 copilot 测试）：
   - 分身在有来源时，`builtInAgentConfiguration()` 产出的提示词里包含来源块，并带有不可信内容声明。
   - 非分身员工不注入来源块。
   - 来源全部删除后，不再注入。
   - 新注册租户的分身 `roleDescription` 不再是占位句，`routingPrompt()` 的输出里不出现"选择你的信息来源……"。
3. `quota.test.ts`、`email-signup.test.ts`：保持通过（`avatarAgentId` 仍在注册时生成，按 D2 的建议）。
4. `app/tests/onboarding-sources.test.tsx`（新增）：
   - 向导中出现"信息来源"这一步；选择"声明"并输入文字后点保存，会调用来源 API 和 advance。
   - 点跳过不写来源，但仍能完成引导。
   - 刷新页面后回到已保存的步骤（服务端持久化）。
5. 阶段 2 追加（`runner-dispatch.test.ts` 或新的 runner 包测试）：
   - 只读根目录上的 `files.read` 成功，`files.write` 被拒，并且磁盘上没有任何改动。
   - 服务端记录里只有 `root_ref` 和 label，查不到绝对路径。
   - 使用其他租户设备的 `root_ref` 时被拒。
