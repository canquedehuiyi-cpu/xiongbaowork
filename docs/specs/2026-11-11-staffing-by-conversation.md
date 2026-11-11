# 规格：在对话里招员工、改员工、组群聊

- 日期：2026-11-11
- 状态：用户已于 2026-11-11 同意
- 用户决定（2026-11-11）：
  - 先做「对话建员工」，并「通过对话组建新的群组，按需求把已创建的员工拉进群」。
  - 谁能用：小管家默认有，其他员工默认没有、可在员工设置里打开。
  - 组群缺角色时：只用现有员工；缺的角色告诉用户并问要不要先去招，招人和建群是两份提议。
  - 新员工草稿：全套一次到位（资料、模型、技能、应用、定时任务）。
  - 顺带做：对话改已有员工、对话调整已有群、用角色模板招人。
  - 实现：方案一（草稿工具 + 确认卡片 + 用户点确认才执行）。
  - 旧版 `save_bot`：并入新设计（2026-11-11，见 3.4）。
- 实施中的修订（2026-11-11，已写入下文对应各节，用户文档见 `openbot/docs/staffing.md`）：
  - 起草时剔除的项（无效的模型、本人给不了的技能和应用、不合规的定时任务）由小管家在卡片上方那句话里说明，卡片本身不列。
  - 应用的状态标签（已转申请 / 需要先连接 / ✓ / 失败）只出现在确认后的结果里，草稿卡片上没有。
  - 只有提出需求的人能确认；同一工作区里看得到这段对话的其他人只看到一行摘要。重试只按草稿内容重做失败的步骤。
  - 小管家默认有这组工具，其他员工要本人按员工打开；本人从小管家收回后不再自动加回。限制：同一人在同一段对话里 10 分钟内最多新起草 5 份；每人待确认最多 20 份；草稿 7 天过期。

## 1. 背景

上游 OpenBot 的服务端工具里没有创建员工或组群聊的工具。熊宝前端有一个简化版：持有 `bot-creator` 技能的员工在网页对话里可以调用前端工具 `save_bot`（`app/src/lib/copilot/bot-tools.tsx`），弹出 `ProposedBotCard`（`app/src/components/agents/proposed-bot.tsx`），用户保存后以本人身份建员工并装技能。它只有名字、头衔、角色描述、技能四项，只在网页对话开着时有效（群聊、IM 渠道、后台运行时用不了），草稿不保存、不过期、无审计。新建员工的其余入口是「新建员工」向导（`POST /api/agents`）和角色模板，建群是「新建群聊」页和新对话页多选。

现有可复用的基础：

| 能力 | 现有实现 |
|---|---|
| 建员工（含套餐名额、角色模板关联） | `server/src/agents/routes.ts` 的 `POST /`，`store.create(actor, input, quota.assertCapacityWithin)` |
| 员工的内置工具服务、按员工授予 | `server/src/plugins/builtin-routines.ts`（定时任务、触发器工具），授予走插件的员工级授予 |
| 授予应用动作（主人可授予 / 只有管理员 / 共享使用） | X3、X4 的授予接口与 `decisionRefusal` |
| 应用访问申请 | X2 的 `app_access_requests` |
| 建群聊并按挑选顺序定员工顺序 | `POST /api/groups`（`group.ts` 的 `create` + `GroupStore.seedOrder`）；改群名用 `ChannelStore.rename`。**缺口**：已有群里加员工、移员工、改员工顺序没有服务方法，本期补上（3.3） |
| 员工模型 | `store.update` 写 `modelRef` / `platformModelRef`；**`store.create` 不写模型**，执行器建好后再更新一次 |
| 对话里的卡片 | `shared/connect-prompt.ts` 的标记 + 前端卡片解析 |
| 管理员能力每次重读 | #455、#456 的 `decisionRefusal` 与门 |

## 2. 目标与非目标

**目标**
1. 用户在对话里说需求，小管家（或被打开该能力的员工）拟出草稿，用户在对话里看到可编辑的卡片，点「确认」后生效。覆盖六件事：新员工、基于角色模板的新员工、改已有员工、新群聊、调整已有群聊、查提议状态。
2. 执行结果与手动操作完全一致：同样的权限、套餐名额、审批底线、审计。
3. 员工自己无法执行任何创建或修改。

**非目标**
- 员工自主（不经确认）建员工或建群。
- 组群时顺带新招员工（用户选了「只用现有员工」）。
- 删除员工、解散群聊（风险高，本期不做；仍走现有页面）。
- 跨租户、给别人建员工。

## 3. 总体结构

```
用户 ──说需求──▶ 小管家 ──调用 propose_* ──▶ 提议存储（草稿，什么都不执行）
                                         │
                       对话里出现卡片 ◀──┘ （工具结果带卡片标记）
用户 ──在卡片上改 / 点确认──▶ 执行接口（以用户本人身份）
                                         │
                       依次调用现有服务：建员工 → 授予应用（无权的转申请）→ 建定时任务
                                        或：建群 → 拉人 → 定顺序 / 改群
                                         │
                       卡片显示逐项结果 ◀──┘   小管家用 proposal_status 读到结果，接着说
```

### 3.1 内置工具服务「招聘与组群」

与「定时任务」内置服务并列（新文件 `server/src/plugins/builtin-staffing.ts`，形状照 `builtin-routines.ts`：`listTools`、`callTool`，主人取 `connection.actorId`、员工取 `connection.botId`、会话取 `connection.threadId`，不取自参数）。注册方式同 routines：`plugins/transport.ts` 加 `TransportKind` `"builtin-staffing"`，`plugins/catalogue.ts` 加目录条目 `key:"staffing"`、`host:"builtin://staffing"`、`auth:{kind:"builtin"}`，在条目的 `readTools` 里列出 `list_staff`、`proposal_status` 与四个 `propose_*`（它们只写草稿，不改业务数据，因此不按写动作走「改动之前先问」）。给模型的名字形如 `mcp__staffing__propose_employee`。

| 工具 | 读 / 写 | 做什么 |
|---|---|---|
| `list_staff` | 读 | 列出当前用户能用的员工（名字、简介、角色模板）、他发起的群聊（成员与顺序）、可用的角色模板、可用的模型与技能名单、能授予的应用 |
| `propose_employee` | 草稿 | 提议新员工；可带 `roleTemplate` |
| `propose_employee_change` | 草稿 | 提议修改一位已有员工 |
| `propose_group` | 草稿 | 提议新群聊（成员只能是已有员工，带回答顺序） |
| `propose_group_change` | 草稿 | 提议调整已有群聊（加人、移人、改顺序、改名） |
| `proposal_status` | 读 | 读一份提议的状态与执行结果 |

`propose_*` 只写提议表，归入「读 / 低风险」一类：不触发「改动之前先问」，也不能绕过它，因为它们不改动任何业务数据。

**谁能用**：小管家就是本人的分身员工 `avatar-<userId>`（部署选了 `picked-harness` 时是它）。分身默认被授予这组工具（`plugin_grants` 行，授予人记为 `openbot:staffing-default`）：新开通的分身在开通时授予，已有的分身在本人下一次运行它时补授一次（每位分身只补一次，本人收回后不再加回）；其他员工默认不授予，在员工设置「技能与应用」里像授予其他应用一样打开（自助授予规则与 routines 相同）。不另造开关；SEC1 的员工级关闭照常生效。

### 3.4 与旧版 `save_bot` 的关系

`bot-creator` 技能与前端工具 `save_bot` 并入新设计：
- S2 合入后，`bot-creator` 技能的说明改为使用 `mcp__staffing__propose_employee`，前端不再向员工提供 `save_bot`（`app/src/lib/copilot/bot-tools.tsx`、`bot-offer.ts`）。
- 新的员工卡片复用 `ProposedBotCard` 的布局与交互，补上新字段。
- 在新工具与卡片合入之前，旧的 `save_bot` 照常可用，不出现「两个都没有」的中间状态：S2、S3 在同一个版本里发布，旧工具的下线放在 S3。

### 3.2 提议存储

新表 `staffing_proposals`（迁移放在恢复叠加目录，编号取当时下一个，journal `when` 递增）：

| 列 | 说明 |
|---|---|
| `id` | uuid |
| `tenant_id` | 租户；ENABLE + FORCE RLS，四条 `tenant_isolation` 策略，GRANT `openbot_app` |
| `owner_id` | 提议的主人：当前说话的人（群聊或 Team Bot 队友里，是发消息的那个人） |
| `proposed_by_agent_id` | 起草的员工 |
| `channel_id` | 起草所在的对话 |
| `kind` | `employee` / `employee_change` / `group` / `group_change` |
| `draft` | jsonb，草稿内容（见第 4 节） |
| `base_version` | 改动类提议：起草时目标员工或群的版本戳，用于执行前比对 |
| `status` | `pending` / `applying` / `applied` / `partially_applied` / `discarded` / `expired` |
| `result` | jsonb，逐项执行结果 |
| `created_at`、`updated_at`、`expires_at` | `expires_at` = 创建后 7 天 |

### 3.3 执行接口（以用户本人身份）

| 接口 | 说明 |
|---|---|
| `GET /api/proposals/:id` | 主人看到完整草稿与按钮；同租户其他能看到该对话的人只得到只读摘要 |
| `PATCH /api/proposals/:id` | 主人编辑草稿（仅 `pending`），服务端重新校验 |
| `POST /api/proposals/:id/apply` | 主人确认执行 |
| `POST /api/proposals/:id/discard` | 主人作废 |
| `POST /api/proposals/:id/retry` | 主人重试 `partially_applied` 中失败的项 |

全部 `requireUser`，并核对 `actor.id === owner_id`；员工运行的身份（机器凭证）调不到这些接口。

`apply` 的步骤：
1. 原子地把 `pending` 改为 `applying`（条件更新），连点两次只执行一次；已过期答 410。
2. 改动类提议比对 `base_version`，不一致则不执行，答 409「内容已变化」。
3. 按提议种类调用现有服务（不复制业务逻辑）：
   - `employee`：`agents` 的创建（带 `quota.assertCapacityWithin` 与角色模板）→ 逐个应用授予（无权授予的转成访问申请，未连接的记为「需要先连接」）→ 建定时任务。员工默认 `private`，默认不授予「招聘与组群」，除非用户在卡片上勾选。
   - `employee_change`：员工更新接口；授予与定时任务的增删分别走各自接口。
   - `group`：`POST /api/groups` 的服务（`create` + `seedOrder`），按草稿顺序定成员。
   - `group_change`：群名用 `ChannelStore.rename`；加员工、移员工、改员工顺序用本期新增的 `GroupConversations.addBots(owner, channelId, agentIds)`、`removeBots(owner, channelId, agentIds)`、`reorder(owner, channelId, agentIds)`（写 `channel_agents` 与 `group_bot_threads`，加的员工同样要求 `canRunAgent`，群至少保留 2 位员工）；只限群的发起人（`people[0]`）。这三个方法同时开放为 `POST/DELETE /api/groups/:id/bots` 与 `PUT /api/groups/:id/order`，供群聊页以后使用。
   - 新员工的模型：`store.create` 不写模型，建好后用 `store.update` 写 `modelRef` 或 `platformModelRef`。
4. 每一步各自成败，写入 `result`；全部成功为 `applied`，部分失败为 `partially_applied`。已建好的员工不回滚。
5. 每一步沿用现有审计事件，并带 `proposalId`。

## 4. 草稿内容

### 4.1 新员工（`propose_employee`）

| 字段 | 规则 |
|---|---|
字段与限长沿用 `CreateAgentInput`（`server/src/agents/profile-types.ts`）与现有校验，草稿不另设更宽的上限：

| 字段 | 规则 |
|---|---|
| `name` | 必填，≤80 字，去掉控制字符 |
| `title` | 头衔，≤120 字 |
| `avatar` | 头像预设 `naughty` / `cute` / `cool` / `happy` / `sweet` 之一（写入 `portraits`），或只给 `avatarSeed` |
| `roleDescription` | 必填，1–1000 字（员工的角色描述，内置员工据此运行） |
| `instructions` | 工作指令，≤1000 字 |
| `persona` | 人设与说话风格（`Persona` 结构），`bible` 长篇设定 ≤8000 字 |
| `roleTemplate` | 可选，`{id, version}`；有则建好后保持与模板关联 |
| `model` | 模型库 id（`modelRef`）或平台池 id（`platformModelRef`）二选一，须为部署允许的模型；缺省用默认模型 |
| `skills` | 本租户存在的技能 slug；按现有规则，非管理员只能装自己的技能或已上架的部署技能 |
| `apps` | `[{ app, actions[] }]`；每项起草时用 `inspectApp` 算出状态：`grantable` / `needs-connection` / `needs-admin` |
| `routines` | `[{ title?, instruction, cron, timezone? }]`；`instruction` ≤2000 字、`title` ≤100 字，`cron` 用 `nextOccurrence` 校验（5 个字段、间隔 ≥15 分钟），每人启用中的定时任务 ≤20 |
| `visibility` | 缺省 `private` |
| `staffingTools` | 新员工是否也得到「招聘与组群」，缺省 `false` |

起草时无效的模型、技能、应用、定时任务直接剔除；剔除了什么、为什么写进工具回答里给模型的那句话，由小管家在卡片上方说明，卡片本身不列（实施中的修订）。

### 4.2 改员工（`propose_employee_change`）

`agentId` + 只含要改的字段（同 4.1 的字段与规则），外加 `appsRemove`、`routinesRemove`。只能改当前用户有权修改的员工。

### 4.3 新群聊（`propose_group`）

`name`、`members`（员工 id 的有序列表，至少 2 位，都是当前用户能用的员工）。需求里有对不上的角色时，工具结果另附 `missingRoles`，小管家据此问用户要不要先招。

### 4.4 改群聊（`propose_group_change`）

`channelId` + `add`、`remove`、`order`、`name` 任意组合；只限群的发起人。

## 5. 各种情况

| 情况 | 处理 |
|---|---|
| 套餐名额已满 | 起草时卡片提示「员工名额已满」并给升级入口，「确认」不可点；执行时再查一次 |
| 无权授予某应用 | 建好后自动发访问申请，不授予；结果里标「已转申请」（草稿卡片不标，按确认那一刻的权限决定） |
| 应用未连接 | 结果里标「需要先连接」，带连接按钮 |
| 执行到一半失败 | 不回滚已建好的；卡片逐项显示成败，失败项可「重试」 |
| 起草后员工或群被改过 | 不执行，提示「内容已变化」，请小管家重新起草 |
| 连点两次 | 只执行一次 |
| 7 天未确认 | 过期，不执行 |
| 非主人 | 只读摘要，没有按钮；接口答 403 |
| 降权的前管理员 | 执行时按其当前能力判断（`decisionRefusal`），管理员专属的授予被拒并转申请 |
| 每人待确认的提议超过 20 份 | 新的 `propose_*` 被拒，提示先处理已有的 |

## 6. 前端卡片

卡片标记照 `shared/app-access-request.ts` 的做法：工具名常量 + 标记前缀 + `write…Answer(card, sentence)` / `read…Answer(text)` 两个函数，服务端和前端读写同一份声明（新文件 `shared/staffing-proposal.ts`），JSON 里只带提议 id 与种类；卡片打开时向 `GET /api/proposals/:id` 读最新状态并据此绘制。前端在 `chat-transcript.tsx` 的 `ServerToolLine` 加一个分支渲染新卡片。

- **新员工卡片**：
  - 顶部：头像、名字、「基于模板：××」。
  - 中部可折叠、可编辑的几块：人设与风格、工作指令、模型与技能（模型只读）、应用（只列名字，状态标签在确认后的结果里）、定时任务、「也给它招聘与组群能力」勾选框。
  - 底部：名额提示（「这是你的第 3 / 3 个员工」）、「确认创建」「作废」。
- **改员工卡片**：只列要改的字段，每项「改前 → 改后」，旧值带删除线。
- **建群 / 改群卡片**：群名；成员头像按回答顺序排成一行，用每位成员的「上移」「下移」按钮调整顺序（键盘可用，未做拖动）；缺的角色列在下面，带「先去招」按钮（等于对小管家说「先帮我招一个××」）。
- **执行后**：卡片变成逐项结果（✓ / 已转申请 / 需要先连接 / 失败可重试；重试只按草稿内容重做失败的步骤），附「打开员工」「打开群聊」。
- **非主人**：一行只读摘要，例如「张三的小管家拟了一个新员工：小红书运营（待张三确认）」。
- **作废 / 过期**：卡片变灰，不可操作。
- 风格照 `docs/design/ios-studio`（黑白红），中文，手机宽度可用。

## 7. 小管家怎么说话

工具说明（给模型看）写明：
- 先用 `list_staff` 看现有员工、群、角色模板，有合适的模板就基于模板起草，并告诉用户。
- 缺关键信息最多追问一轮，其余用合理默认值。
- 一次只出一份提议；用户口头要求改草稿时，作废旧的、出新的。
- 卡片出现后用一两句话说明为什么这么拟；用户确认后用 `proposal_status` 读结果再接着说。
- 永远不说「已经建好了」，除非 `proposal_status` 答 `applied`。

## 8. 安全底线

1. 员工只能起草，执行只认登录的真人且必须是提议主人。
2. 执行时重新校验全部规则（名额、授予能力、模型、技能、群成员、群发起人），不信任草稿。
3. 不放大权限：新员工的授予不超过用户本人能授予的；默认 `private`；默认不带「招聘与组群」。
4. 提议表按租户隔离（RLS），不新增平台入口（`tenant-invariants` 的门数不变）。
5. 防滥用：每人待确认上限 20 份；同一人在同一会话里 10 分钟内最多新建 5 份提议；名字与长文本限长、去控制字符；卡片完整显示人设与指令全文。
6. `approvals/policy.ts` 的审批底线、签到只读门、凭据只进 vault，一概不动。

## 9. 审计

- 新事件：`staffing.proposal_created`、`staffing.proposal_edited`、`staffing.proposal_applied`、`staffing.proposal_partially_applied`、`staffing.proposal_discarded`、`staffing.proposal_expired`；加入 `audit.ts` 的 `auditEventTypes`，并在 `shared/audit-words.ts` 的 `AUDIT_EVENT_WORDS` 加中文说法。审计 payload 不用会被脱敏的键名（如 `prompt`、`content`）存要保留的内容。
- 执行产生的建员工、授予、申请、定时任务、建群、拉人沿用现有事件，附 `proposalId`。

## 10. 测试

- **服务端**：
  - 每个工具一组测试。
  - 执行接口的身份矩阵：主人、同租户他人、普通成员、降权的管理员、别的租户。
  - 名额已满、`base_version` 不一致、连点两次、部分失败与重试、过期。
  - 提议表的 RLS 测试；`tenant-invariants` 通过且门数不变。
- **前端**：每种卡片的绘制、编辑、确认、结果、非主人只读、作废与过期。
- **端到端**：仿 G4 新增一条浏览器流程（模拟模型），覆盖两条：
  - 说需求 → 出卡片 → 改一处 → 确认 → 员工真的建好 → 小管家接着说；
  - 建群同样走一遍。
- **原有测试一行不改。**

## 11. 交付拆分

| PR | 内容 |
|---|---|
| S1 | 提议表与迁移、提议存储、群聊加 / 移员工与改顺序的服务方法、执行接口（apply / discard / retry / PATCH / GET）、审计 |
| S2 | 「招聘与组群」内置工具服务、分身默认授予与升级补授、员工设置里可打开、`bot-creator` 技能说明改用新工具 |
| S3 | 前端四种卡片与卡片标记，复用 `ProposedBotCard`；下线前端 `save_bot` |
| S4 | 端到端流程、用户文档、CHANGELOG |

每个 PR：独立只读审查 → 修复 → CI 全绿 → Codex → 合入。
