# 召唤员工 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新用户会话列表从空开始；员工资源 › 员工页改为「人才市场」，分「待召唤 / 已召唤」，是唯一召唤入口（Task 10；Task 6 最初做在侧栏员工列表，后由 Task 10 移走），召唤预设员工时给本人复制一份自己的员工、建一对一会话并播翻卡动画；预设员工配熊宝头像；召唤来的员工带着预设的技能直接可用（不带应用插件）；会话页顶部员工卡固定。

**Architecture:** 服务端在 `agent_profiles` 上加 `summoned_from`、`preset_portrait` 两列，包同步写预设头像，新加 `POST /api/agents/:agentId/summon`（复用 `duplicate` 与 `ChannelStore.direct`），员工列表接口带出 `summonKind` / `summoned` / `presetPortrait`；去掉自动建分身会话。前端在员工列表按这两个字段分栏，召唤走新接口并配翻卡动画组件；会话页固定标题栏换成紧凑员工卡；技能页显示安装数。

**Tech Stack:** Bun、Hono、Drizzle + PostgreSQL（迁移在 `server/recovery/recovery-20261018-v1/`）、React + TanStack Router/Query、Tailwind、happy-dom + Testing Library。

**Spec:** `docs/specs/2026-11-14-summon-employees.md`（用户 2026-11-14 确认，含同日修订「召唤 = 复制一份自己的员工」）。

## Global Constraints

- 界面文案原样使用：「已召唤」「待召唤」「召唤」「进入会话」「召唤成功」「已装到你的 N 个员工」「未安装」。
- 召唤幂等：同一主人 + 同一预设、未删除的员工最多一份，由数据库唯一约束兜底。
- 召唤和复制员工一样占套餐名额，名额满时返回与 `POST /api/agents/:agentId/duplicate` 相同的拒绝响应。
- 复制出来的员工带上预设自身的全部 `kind = "skill"` 授予（`granted_by` = 本人），不带任何 `kind = "mcp"` 授予；可见范围 `private`。（2026-11-14 用户补充「召唤它直接就可以使用」）
- 不收回、不修改任何已有会话、聊天记录、`plugin_grants`；包同步对共用预设员工的技能授予逻辑不改。
- 不改单机试用模式（`singleUser`）的包频道按人副本逻辑。
- 动画不引入新的动画依赖（只用 CSS / 现有依赖）；时长约 2 秒，可点击跳过；`prefers-reduced-motion: reduce` 时不播动画。
- 品牌棘轮：新增代码、文件名、标识符、文案里不得出现 `openbot` / `OpenBot`（`scripts/brand` 预算只减不增）。
- 迁移只追加：新文件 `0213_*`，journal `idx` 213，不改已提交的迁移。
- 服务端测试需 PostgreSQL；单文件运行：`cd openbot/server && bun test tests/<file>`；前端：`cd openbot/app && bun test tests/<file>`。

## Review Focus

1. 连点两次「召唤」（两个请求并发）→ 只复制出一份员工，两个请求都拿到同一个 `agent.id` 和 `channelId`。（Task 3 的并发用例）
2. 套餐名额已满时召唤 → 返回名额拒绝，不建员工、不建会话；前端卡片退回待召唤并提示。（Task 3、Task 6 用例）
3. 召唤出来的员工删掉后再召唤同一预设 → 能再召唤出新的一份（唯一约束只管未删除的）。（Task 1、Task 3 用例）
4. 召唤请求慢于动画 → 动画停在蓄力阶段等结果，不提前跳进空页面；请求失败 → 不显示「召唤成功」。（Task 6 用例）
5. 老用户已和共用预设员工有会话 → 那个会话照旧在会话列表里能打开，预设仍在「待召唤」，召唤后得到自己的一份和新会话。（Task 4 用例）

---

### Task 1: `agent_profiles` 加 `summoned_from`、`preset_portrait`，资料 DTO 带出

**Files:**
- Create: `openbot/server/recovery/recovery-20261018-v1/sql/0213_agent_summon_columns.sql`
- Modify: `openbot/server/recovery/recovery-20261018-v1/meta/_journal.json`（追加 idx 213）
- Modify: `openbot/server/src/db/schema/coworker.ts`（`agentProfiles` 加两列与唯一索引）
- Modify: `openbot/server/src/agents/profile-types.ts`、`profile-store.ts` 的资料读取（DTO 加字段）
- Modify: `openbot/app/src/lib/agents/queries.ts`（`AgentProfile` 加字段）
- Test: `openbot/server/tests/agent-summon-columns.integration.test.ts`

**Interfaces:**
- Produces: 列 `agent_profiles.summoned_from text null`（引用 `agents.id`，`on delete set null`）、`agent_profiles.preset_portrait text null`；部分唯一索引 `agent_profiles_owner_summoned_from_unique on (owner_user_id, summoned_from) where summoned_from is not null and deleted_at is null`。
- Produces: `AgentProfile` 新字段 `summonedFrom: string | null`、`presetPortrait: PortraitPreset | null`（服务端与 app 同名同类型；app 侧 `PortraitPreset` 取自 `lib/portraits/queries.ts`）。

- [ ] **Step 1: 写失败测试** `agent-summon-columns.integration.test.ts`：
  - 「同一主人对同一预设插两行未删除资料 → 第二行违反唯一约束（23505）」
  - 「第一行 `deleted_at` 置值后，再插一行成功」
  - 「`preset_portrait` 写 `test-engineer`，`findAccessibleProfile` 读出的资料 `presetPortrait === "test-engineer"`，`summonedFrom` 为写入值」
- [ ] **Step 2: 运行确认失败**：`cd openbot/server && bun test tests/agent-summon-columns.integration.test.ts`，预期因列不存在失败。
- [ ] **Step 3: 写迁移与 schema**，照 `0212_*` 的注释风格写中文说明；`preset_portrait` 加 check，取值与 `0204_bao_role_presets.sql` 里 `portraits_preset` 的 50 个键相同；按现有迁移给 `openbot_app` 的列权限惯例补授权（参照 0211/0212）。资料读取处带出两字段。
- [ ] **Step 4: 运行确认通过**，并跑 `bun test tests/agent-routes*.test.ts tests/channel-routes.test.ts` 确认 DTO 变化没打坏现有用例（只允许新增字段带来的快照更新，现有断言不改）。
- [ ] **Step 5: 提交** `feat(agents): 资料表加 summoned_from、preset_portrait（召唤员工 Task 1）`

### Task 2: 包里的 `portrait:` 字段 → 预设员工的 `preset_portrait`，并给 28 个预设员工配头像

**Files:**
- Modify: `openbot/server/src/tenant-package.ts`（`TenantAgent` 加 `portrait?: PortraitPreset`；`parseAgents` 约 601 行解析并按 `PORTRAIT_PRESETS` 校验；约 1845 行写 `agentProfiles` 时写 `presetPortrait`）
- Modify: `openbot/examples/xiongbao/agents.yaml` 与 `openbot/examples/xiongbao/agents/*.yaml`（28 个员工各加 `portrait:`）
- Test: `openbot/server/tests/tenant-package.test.ts`（新增用例）、`openbot/server/tests/xiongbao-package.test.ts`（新增用例）

**Interfaces:**
- Consumes: Task 1 的 `agent_profiles.preset_portrait`；`PORTRAIT_PRESETS` / `PortraitPreset`（`server/src/portraits/store.ts:15`）。

- [ ] **Step 1: 写失败测试**：
  - `tenant-package.test.ts`：「agent 的 `portrait: doctor` 被解析进 `TenantAgent.portrait`」「`portrait: not-a-preset` 时 `validateTenantPackage` 抛错，错误信息含该员工 id」「同步后该预设员工资料 `presetPortrait === "doctor"`」「去掉 `portrait:` 再同步 → `presetPortrait` 变回 null」
  - `xiongbao-package.test.ts`：「熊宝包的每个预设员工都有 `portrait`，且都在 `PORTRAIT_PRESETS` 里」
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现解析与写入**；按职业给 28 个员工挑头像（如 `qa`/`software-qa-engineer` → `test-engineer`，`software-product-manager` → `product-manager`，`gstack-security-officer` → `security-officer`，`通用助手` → `founder-assistant`，开发类 → `programmer`/`tech-engineer`，设计类 → `designer`/`creative-designer`），把对应表写进 PR 描述供用户过目。
- [ ] **Step 4: 运行确认通过**，并跑 `bun test tests/tenant-package*.test.ts`。
- [ ] **Step 5: 提交** `feat(package): 预设员工的 portrait 字段与熊宝头像对应（召唤员工 Task 2）`

### Task 3: 召唤接口 `POST /api/agents/:agentId/summon`

**Files:**
- Create: `openbot/server/src/agents/summon.ts`
- Modify: `openbot/server/src/agents/profile-store.ts`（`duplicate` 接受可选 `summonedFrom`，写入新列；复制时把 `presetPortrait` 原样带上）
- Modify: `openbot/server/src/agents/routes.ts`（新路由，紧挨 `/:agentId/duplicate`，复用它的名额检查与审计记录，事件名 `bot.summoned`）
- Modify: `openbot/server/src/index.ts`（接线：把 `ChannelStore.direct`、`PortraitStore` 传给召唤）
- Test: `openbot/server/tests/agent-summon.integration.test.ts`

**Interfaces:**
- Consumes: `ProfileStore.duplicate(actor, id, admit?)`（`profile-store.ts:109`）、`ChannelStore.direct(actor, agentId): Promise<AgentChannel>`（`channels/routes.ts:234`）、`PortraitStore.set(kind, id, {preset}, updatedBy)`（`portraits/store.ts`）、`avatarAgentId(userId)`（`tenant/provisioning.ts:20`）。
- Produces: `summonAgent(deps: SummonDeps, actor: AgentActor, agentId: string): Promise<{ agent: AgentProfile; channelId: string; created: boolean }>`；路由返回 200 `{ agent, channelId, created }`。
  - 预设员工（资料 `owner_user_id` 为 null 且员工有 `package_id`）：查本人 `summoned_from = agentId` 且未删除的那份；有则 `created:false`，没有则 `duplicate` 并写 `summonedFrom`、在本人名下写一行 `portraits`（`coworker`、新 id、`presetPortrait`，`presetPortrait` 为 null 时不写），`created:true`。
  - 分身（`agentId === avatarAgentId(actor.id)`）或本人自己的员工：不复制，`created:false`。
  - 其他（看不到的、别人的私有员工）：404，同 `duplicate` 的找不到响应。
  - 最后都 `direct(actor, 那份员工 id)` 拿 `channelId`。
  - 并发：在事务里先取 `pg_advisory_xact_lock` 键 `agent:summon:<actor.id>:<agentId>`，再查再复制；唯一约束冲突时回读已有那份当作 `created:false`。

- [ ] **Step 1: 写失败测试** `agent-summon.integration.test.ts`：
  - 「召唤预设 → 返回的 `agent.id` 不等于预设 id，`summonedFrom === 预设 id`，`visibility === "private"`，主人是本人，`created === true`」
  - 「复制出的员工带着预设的技能授予（`kind = 'skill'`，记作本人安装），没有任何 `mcp` 授予」（2026-11-14 用户补充「召唤直接可用」后改）
  - 「本人名下有 `portraits` 行，`preset` 等于预设的 `presetPortrait`」
  - 「再召唤一次 → 同一个 `agent.id`、同一个 `channelId`、`created === false`」
  - 「两个请求并发召唤同一预设 → 只有一份员工，两个响应 `agent.id` 相同」
  - 「召唤分身 → `agent.id === avatarAgentId(本人)`，员工数不变，返回 `channelId`」
  - 「召唤别人的私有员工 → 404」
  - 「套餐名额已满 → 返回与 duplicate 相同的拒绝状态码和正文，员工数与会话数不变」
  - 「召唤后删掉那份员工，再召唤 → 得到新的一份，`created === true`」
  - 「召唤后软删一对一会话，再召唤 → `created === false`，返回一个新的 `channelId`」
- [ ] **Step 2: 运行确认失败**：`cd openbot/server && bun test tests/agent-summon.integration.test.ts`。
- [ ] **Step 3: 实现** `summon.ts` 与路由接线。
- [ ] **Step 4: 运行确认通过**，并跑 `bun test tests/agent-duplicate*.test.ts tests/channel-routes.test.ts`（文件名以仓库实际为准，`grep -l duplicate tests/*.test.ts`）。
- [ ] **Step 5: 提交** `feat(agents): 召唤接口——预设复制一份本人的员工并建一对一会话（召唤员工 Task 3）`

### Task 4: 员工列表接口带 `summonKind` / `summoned`；不再自动建分身会话；个人版只有默认技能跳过召唤来的员工

**Files:**
- Modify: `openbot/server/src/agents/routes.ts`（`GET /api/agents` 每项加两字段）、`profile-types.ts`
- Modify: `openbot/server/src/channels/routes.ts`（删掉约 1720 行对 `ensureAvatarConversation` 的调用及只为它存在的 `avatarConversationsEnsured`；`avatar-conversation.ts` 若再无调用方则删除并删其专属测试中断言「自动建」的用例——**删用例需在 PR 里写明原因**，其余断言不改）
- Modify: `openbot/server/src/plugins/personal-defaults.ts`（召唤来的员工即 `summonedFrom !== null` 的，只跳过「每个技能给一次」`giveEverySkillOnce` 和新技能广播——它带着预设的技能；常开应用、默认工具授予 `grantEveryTool`、`refreshTools` 的广播和互相请教（`botsReachableFrom`）都和本人自建的员工一样给，`deps.bots()` 不排除它们（2026-11-14 终审 Ruling 9 改：最初写的是一律排除，用户改为「召唤直接可用、完整专家能力」后撤回））
- Modify: `openbot/app/src/lib/agents/queries.ts`（两字段）
- Test: `openbot/server/tests/agent-summon-list.integration.test.ts`、`openbot/server/tests/personal-defaults.integration.test.ts`（新增用例）

**Interfaces:**
- Produces: `AgentProfile.summonKind: "preset" | "avatar" | null`、`AgentProfile.summoned: boolean`（对当前请求人计算）。
  - `preset`：预设员工；`summoned` = 本人有未删除的 `summoned_from = 该 id` 的员工。
  - `avatar`：本人的分身；`summoned` = 本人有未删除的、成员只有分身的一对一会话。
  - 其他员工 `summonKind: null`、`summoned: true`。

- [ ] **Step 1: 写失败测试**：
  - 「新开通的用户 `GET /api/channels` → `channels` 为空，数据库里该用户没有任何一对一会话」
  - 「`GET /api/agents`：预设员工 `summonKind === "preset"`、`summoned === false`；召唤后（调 Task 3）该预设 `summoned === true`，复制出的员工 `summonKind === null`」
  - 「分身在没有一对一会话时 `summonKind === "avatar"`、`summoned === false`；召唤分身后 `summoned === true`」
  - 「老用户已有和共用预设的一对一会话 → 该会话仍在 `GET /api/channels` 结果里，预设 `summoned === false`」
  - `personal-defaults.integration.test.ts`：「个人版下召唤来的员工（`summonedFrom` 非空）在列出/运行后仍没有任何技能授予；普通员工照旧被授予」
  - `personal-defaults.integration.test.ts`：「个人版、已连接应用时，召唤来的员工运行一次（走 `listForAgent`）以及 `refreshTools` 之后，和普通员工一样拿到全部工具；收回应用、Routines、另一位员工都被拒绝；能请其他员工帮忙，也能被请」（Ruling 9）
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**；`summoned` 用一次批量查询算出，不对每个员工单独查。
- [ ] **Step 4: 运行确认通过**，并跑 `bun test tests/avatar-conversation*.test.ts tests/personal-defaults*.test.ts tests/channel-routes.test.ts`。
- [ ] **Step 5: 提交** `feat: 会话列表从空开始，员工列表带召唤状态（召唤员工 Task 4）`

### Task 5: 翻卡召唤动画组件 `SummonCardFlip`

**Files:**
- Create: `openbot/app/src/components/summon/summon-card-flip.tsx`、同目录 `summon-card-flip.css`（或 Tailwind 内联关键帧，按 app 现有做法）
- Test: `openbot/app/tests/summon-card-flip.test.tsx`

**Interfaces:**
- Produces: `SummonCardFlip(props: { name: string; title: string; portrait: string /* 图片地址 */; result: Promise<unknown>; onDone: () => void; onFail: (error: unknown) => void }): JSX.Element`
  - 阶段：`charging`（卡背、光效聚拢、轻颤）→ 等 `result` 兑现 → `reveal`（翻面露出头像/名字/职务、光芒粒子、「召唤成功」）→ 约 2 秒后 `onDone()`。
  - `result` 拒绝：不进入 `reveal`、不出现「召唤成功」，调 `onFail(error)`。
  - 点击任意处：已兑现则立刻 `onDone()`；未兑现则只跳过特效，兑现后立刻 `onDone()`。
  - `matchMedia("(prefers-reduced-motion: reduce)")` 为真：不播动画，直接显示结果卡，兑现后 `onDone()`。
  - 卡背用 `app/src/assets/brand/xiongbao-logo-256.png`。

- [ ] **Step 1: 写失败测试**（用假计时器）：「`result` 未兑现时不出现『召唤成功』」「兑现后出现『召唤成功』，约 2 秒后 `onDone` 被调用一次」「`result` 拒绝 → 不出现『召唤成功』，`onFail` 被调用、`onDone` 不被调用」「兑现后点击 → `onDone` 立刻被调用一次」「reduced-motion 下兑现后立刻 `onDone`」
- [ ] **Step 2: 运行确认失败**：`cd openbot/app && bun test tests/summon-card-flip.test.tsx`。
- [ ] **Step 3: 实现**：CSS 3D `rotateY` 翻转 + 径向渐变光效 + 若干绝对定位粒子的关键帧；整屏半透明遮罩居中显示。
- [ ] **Step 4: 运行确认通过**。
- [ ] **Step 5: 提交** `feat(app): 翻卡召唤动画（召唤员工 Task 5）`

### Task 6: 员工列表分「已召唤 / 待召唤」并接上召唤

> 2026-11-14 用户改定后由 Task 10 取代：召唤与「待召唤」移到人才市场（`/bots`），侧栏「员工」只列本人的员工。下面是当时的做法，留作记录。

**Files:**
- Modify: `openbot/app/src/components/app-sidebar/sidebar-roster.tsx`（`EmployeeList` 约 310 行、`EmployeeRow` 约 200 行）、`openbot/app/src/components/app-sidebar/roster.ts`（`listedEmployees` 约 142 行）
- Modify: `openbot/app/src/lib/agents/queries.ts`（`summonAgentMutation`：`POST /api/agents/:agentId/summon`，成功后失效 `["agents","list"]` 与会话列表查询）
- Modify: 头像取图处（`usePortraitSrc` / `AbstractAvatar` 所在，`lib/portraits/queries.ts`）：员工没有 `portraits` 行时用 `presetPortrait` 对应的 `PRESET_IMAGES` 图
- Test: `openbot/app/tests/sidebar-roster.test.tsx`（新增用例，现有断言不改）

**Interfaces:**
- Consumes: Task 4 的 `summonKind` / `summoned`、Task 1 的 `presetPortrait`、Task 5 的 `SummonCardFlip`。

- [ ] **Step 1: 写失败测试**：
  - 「`summonKind` 非空且 `summoned === false` 的员工出现在『待召唤』分组，行内有『召唤』按钮；`summonKind === "preset"` 且 `summoned === true` 的共用预设原件两组都不出现（只显示本人那份副本）；其余员工在『已召唤』分组，点击行为与现在相同（有一对一会话就打开，没有就去 `/channel/new`）」
  - 「召唤某预设后（列表数据里该原件 `summoned === true`、多出一份 `summonedFrom === 原件 id` 的副本），员工列表只出现副本、不出现原件；原件已有的旧会话仍在会话列表里」
  - 「点『召唤』→ 发 `POST /api/agents/<id>/summon`，显示 `SummonCardFlip`，完成后跳到返回的 `/channel/<channelId>`」
  - 「接口返回名额拒绝 → 不跳转，显示接口给的提示，员工仍在『待召唤』」
  - 「分身排在『待召唤』第一位」
  - 「没有 `portraits` 行但 `presetPortrait === "doctor"` 的员工，头像图片地址等于 `PRESET_IMAGES.doctor`」
- [ ] **Step 2: 运行确认失败**：`cd openbot/app && bun test tests/sidebar-roster.test.tsx`。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 运行确认通过**，并跑 `bun test tests/agent-roster-error.test.tsx tests/conversation-intro.test.tsx`。
- [ ] **Step 5: 提交** `feat(app): 员工列表召唤（召唤员工 Task 6）`

### Task 7: 会话页顶部紧凑员工卡固定

**Files:**
- Modify: `openbot/app/src/routes/_authed/_app/channel/$channelId.tsx`（`data-slot="conversation-header"` 约 126 行）
- Create: `openbot/app/src/components/channels/conversation-header-card.tsx`
- Test: `openbot/app/tests/conversation-header-card.test.tsx`

**Interfaces:**
- Produces: `ConversationHeaderCard(props: { agent: AgentProfile }): JSX.Element`——头像（40px，取图规则同 Task 6）、名字、职务（`title`，单行截断）、可见范围标签（规则与 `conversation-intro.tsx:71` 相同：`visibility === "public"` 为「公开」否则「仅自己」，个人版不显示）。
- Consumes: `agentListQueryOptions()` 里按 `channel.data.agentIds[0]` 找到的资料（与 `channel-chat.tsx:433-437` 同法）。

- [ ] **Step 1: 写失败测试**：「渲染名字、职务、『仅自己』」「个人版不渲染可见范围标签」「标题栏元素带 `sticky` 与 `top-0` 类，紧凑卡在其中」
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**；保留标题栏原有的侧栏开关、电脑控制、设置按钮；资料未加载时显示原来的会话名。
- [ ] **Step 4: 运行确认通过**。
- [ ] **Step 5: 提交** `feat(app): 会话页顶部员工卡固定（召唤员工 Task 7）`

### Task 8: 技能页显示「已装到你的 N 个员工 / 未安装」

**Files:**
- Modify: `openbot/app/src/components/skills/skills-screen.tsx`（约 115 行 `grantedSentence`）
- Test: `openbot/app/tests/skills-screen-installed.test.tsx`

**Interfaces:**
- Consumes: `skill.grantedTo`（现有）与 `agentListQueryOptions()` 里 `mine === true` 的员工 id 集合。

- [ ] **Step 1: 写失败测试**：「技能授予给本人 2 个员工 → 卡片显示『已装到你的 2 个员工』」「只授予给共用预设员工或别人的员工 → 显示『未安装』」
- [ ] **Step 2: 运行确认失败**：`cd openbot/app && bun test tests/skills-screen-installed.test.tsx`。
- [ ] **Step 3: 实现**：计数 = `grantedTo` 与本人员工 id 的交集大小。
- [ ] **Step 4: 运行确认通过**，并跑 `bun test tests/skills-read-failure.test.tsx`。
- [ ] **Step 5: 提交** `feat(app): 技能页显示安装到本人员工的数量（召唤员工 Task 8）`

### Task 9: 预设员工的完整人设（`persona:`）

**Files:**
- Modify: `openbot/server/src/tenant-package.ts`（`TenantAgent` 加 `persona?: string`；`parseAgents` 解析，非字符串或超过 `agent_profiles` 人设长度上限时抛错并带员工 id；同步写 `agentProfiles.persona`，去掉字段后再同步恢复为空值，与 Task 2 写 `presetPortrait` 同法）
- Modify: `openbot/examples/xiongbao/agents.yaml` 与 `agents/*.yaml`（28 个员工各写 `persona:`）
- Test: `openbot/server/tests/tenant-package.test.ts`、`openbot/server/tests/xiongbao-package.test.ts`、`openbot/server/tests/agent-summon.integration.test.ts`（各新增用例）

**Interfaces:**
- Consumes: `agent_profiles.persona`（已有列，`duplicate` 已复制它）；Task 3 的 `summonAgent`。

- [ ] **Step 1: 写失败测试**：「`persona:` 被解析进 `TenantAgent.persona` 并同步到预设员工资料」「去掉 `persona:` 再同步 → 恢复为空」「熊宝包每个预设员工都有非空 `persona`」「召唤后副本的人设与预设相同」
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现解析与写入；为 28 个员工写人设**：中文，每个 150–400 字，包含身份、性格、说话风格、擅长领域、工作方式；内容从该员工 `system_prompt` 与其 `persona-*` 技能（`skills.yaml`）里整理，不编造原规范没有的能力；不出现 `openbot`/`OpenBot`。
- [ ] **Step 4: 运行确认通过**，并跑 `bun test tests/tenant-package*.test.ts tests/xiongbao-package.test.ts tests/agent-summon.integration.test.ts`。
- [ ] **Step 5: 提交** `feat(package): 预设员工完整人设（召唤员工 Task 9）`


### Task 10: 员工资源 › 员工页改成「人才市场」，作为唯一召唤入口（用户 2026-11-14：「召唤只在员工页面，把那个页面改成人才市场，只有在人才市场召唤后才会在会话列表出现」「就是员工资源下面那个员工页」）

**Files:**
- Modify: `/bots` 路由页（`app/src/routes/_authed/_app/bots*.tsx`）、员工墙 `app/src/components/bots/bot-roster.tsx`、卡片 `app/src/components/wakers/coworker-card.tsx`、侧栏「员工资源」导航项文案、`app/src/components/app-sidebar/sidebar-roster.tsx`（去掉待召唤/召唤）、`app/src/components/conversation/conversation-workspace.tsx` 与首页 `routes/_authed/_app/index.tsx` 的引导与「发现员工」、`bot-profile/profile.tsx` / `agents/agent-profile.tsx` / `agents/agent-dialog.tsx` 的召唤入口
- Test: 对应 app 测试（新增或更新）

**要求：**
- 侧栏「员工资源 › 员工」改名「人才市场」，页面标题与面包屑「人才市场」。页面上半部分「待召唤」：所有 `summonKind != null && summoned === false` 的员工（预设 + 分身）用熊宝头像卡片展示，卡片主按钮「召唤」（`useSummon`，播入职动画，完成后进会话）；下半部分「已召唤」：本人已有的员工（召唤来的副本、分身、自建员工），按钮「进入会话」。共用预设原件已召唤的不再出现。
- 召唤只在人才市场发生：侧栏「员工」分组去掉「待召唤」分组与召唤按钮，只列已召唤/本人员工；首页「发现员工」、员工资料页、聊天里的员工资料面板、员工对话框、会话空状态与首页的引导，凡原来能召唤或打开预设原件的地方，改为「去人才市场」按钮（链到 `/bots`，必要时带锚点定位到该员工卡）。
- 会话列表照旧：只有召唤后才出现该员工的会话。
- 现有 `/bots` 的筛选/搜索等能力保留；卡片上原「进对话」对本人员工保持不变。
- 改动的既有断言逐条列在报告里（会进 PR 描述）。
