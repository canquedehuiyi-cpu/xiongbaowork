# X 系列服务端接口说明（给前端对接）

fork 全量对齐上游 OpenBot 时，之前排除的上游服务端功能分 6 块并入（X1–X6）。本文收录各块实现报告全文，前端对接看各节「接口（给前端会话）」，以及后面「评审修复」里的接口变化。

| 块 | 内容 | PR |
|---|---|---|
| X1 | 账号模型：共享账号、多账号、账号模式 | #423 #424 #425 #427 |
| X2 | 应用访问审批并入申请收件箱 | #431 #433 |
| X3 | 主人授权与共享使用 | #436 #437 |
| X4 | 个人默认与聊天卡片一键连接（上游 #1277） | #439 #440 |
| X5 | Arcade 连接器 | #429 #432 #434 #435 |
| X6 | Entra 代表用户调用（上游 #931） | #426 #430 |

---

## X1 报告：账号模型（共享账号 / 多账号 / 账号模式）

## PR（依次叠加，均为草稿）

| PR | 分支 | base | head | 内容 |
| --- | --- | --- | --- | --- |
| #423 | feat/align-x1-accounts-1 | main | 7fb8b9ef | 迁移 0180、`shared-accounts.ts`、`account-argument.ts` |
| #424 | feat/align-x1-accounts-2 | -1 | 9e06b558 | 迁移 0181、审批按账号区分 |
| #425 | feat/align-x1-accounts-3 | -2 | bbc8d428 | 多账号（账号簿、调用选账号、账号路由、再连一个账号） |
| #427 | feat/align-x1-accounts-4 | -3 | 56d8fe6f | 共享账号、账号模式切换、共享闸门、#950 合拢 |

每个 PR 非测试文件 ≤ 12（PR4 为 7 个 + 分片清单）。

## 迁移（overlay `recovery-20261018-v1/sql`）

- `0180_brokered_accounts`：`mcp_servers.account_mode`（默认 `personal`，CHECK personal/shared/NULL）、`shared_vendor_user_id`、团队账号连接状态五列（`shared_connected_at`、`shared_connected_by`、`shared_verified`、`shared_verified_at`、`shared_probe_action`），CHECK `mcp_servers_shared_account_check`（Shared 必有团队身份；非 Shared 不得有团队身份或连接）；新表 `brokered_accounts`（tenant_id、ENABLE + FORCE RLS、四条 tenant_isolation、GRANT openbot_app，provider 只收 `composio`）。
- `0181_approval_rule_account`：`approval_rules.account text`。
- journal `when` 取当时毫秒（1794318601977、1794318911781），大于 overlay 原最大值。0182–0185 未用。
- main 上 overlay 当时到 0174，无冲突。注意：M5 若随后在 0180 之前插入 0175–0179，其 `when` 必须大于 0181 的，否则已跑过 0181 的库会跳过它们（overlay journal 测试会抓到乱序）。

## 接口（给前端会话）

### 多账号（#425）
- `GET /api/plugins/servers/:id/accounts` → `{ accounts: [{ id, identity, label, isDefault, connectedAt }], canAddAnother }`。每次按 vendor 当前列表重建。`id` 对浏览器不透明（不是 vendor id）。`label` = identity，或「账号 N」。Shared 应用 → `{ accounts: [], canAddAnother: false }`。
- `POST /api/plugins/servers/:id/accounts/:accountId/default` → `{ ok: true }`；不是本人的 → 404。
- `DELETE /api/plugins/servers/:id/accounts/:accountId` → `{ remaining }`；最后一个账号时整个连接断开，返回 `{ vendorRevocationRequested }`；不是本人的 → 404。
- `POST /api/plugins/servers/:id/connect?another=1` → `{ authorizationUrl }`，只对同意屏幕类应用、且已有连接时生效；不带参数的 Connect 照旧 409。
- 审批卡片 / 审批记录：`action.account`（仅多账号时），卡片地点读作「Gmail 账号 dana@work.example」。

### 共享账号与账号模式（#427）
- `GET /api/plugins/servers/:id/account-mode?mode=shared|personal`（管理员）→ `{ mode, current, wouldRevoke: { holder: "person"|"deployment", count } }`。
- `PUT /api/plugins/servers/:id/account-mode` body `{ mode, confirm }`（管理员）→ 200 `{ changed: true, revoked }` ｜ 200 `{ changed: false, preview }`（confirm 不为 true）｜ 409 `{ changed: false, failures: [{ account, error }] }`（vendor 撤销失败，模式未变）｜ 400 `{ error }`（非 broker / 不需要账号 / 部署无 id）。
- `GET /api/plugins` 的 broker 服务器多出：`accountMode`、`sharedOnly`（上游 #950 字段，= adminConnectOnly 的判断）、`sharedAccount: { connected, connectedAt, connectedBy, verified } | null`；`canConnect` 对 Shared 应用只给管理员。团队身份不下发。
- Shared 应用的 `POST /servers/:id/connect`（同意屏幕 / 填写字段）、`POST .../connection/confirm`、`POST .../connection/recheck`、`DELETE .../connection`：只限管理员（成员 403），作用在团队账号；已连接再连 409。字段连接返回 `{ connected: true, verified: false }`。

## 安全规则（都有测试）

- 账号只按名字选，只在「调用所开账号的主人」自己的账号里查；查不到在策略 / 审批 / vendor 之前拒绝并审计 `unknown_account`。
- 审批按账号：点名账号的规则只管那个账号；不点名账号的本人 / 员工主人的 allow 规则不再放行点名账号的调用（只会更严）；团队规则不论账号。
- 谁能连接团队账号：只有管理员（路由检查 + store 写团队行需要管理员能力）。
- 谁能驾驶团队账号：X3 之前固定上游最严一档 `owner`——员工主人与管理员；发起者必须可识别（无发起者 / deployment / 无起点转交拒绝）；check-in 拒绝；职责运行在没有来源信息时按外部输入拒绝。
- Team Bot 队友：Shared 应用拒绝（非主人非管理员）；Personal 应用不能点名账号（只拿主人的默认账号），模型也不会被告知主人的账号。
- 切换：vendor 全部撤销成功才改模式；先立「写之前先问」规则再改成 Shared；跨租户撤销走 `removeServer` 的同一道 platform 门，之前 `requireServerWriter`。

## 与上游的差异与原因

1. 团队账号状态记在 `mcp_servers` 行上而不是 `brokered_connections(holder=deployment)`：应用行已是 `team` 标记，任何人可读、管理员能力可写；新共享表需要新的 `team_*` 策略，而 `rls-write-scope` 固定了共享表集合（测试不能改）。个人连接仍在 `composio_connections`。
2. `account_mode` 默认 `personal`（上游 NULL + 回填）：fork 既有行为即个人账号；既有测试直接插入 broker 行不带模式。显式 NULL 仍按上游拒绝（ambiguous）。
3. `approval_rules.account` 不在 `db/schema/approvals.ts` 声明：该文件被 AP2/AP4 恢复测试按字节冻结。现由 `approvals/rule-account.ts` 以 SQL 片段读写（#424 第二个提交修复了 server-test 5）。M5a 合入后按协调要求并进它的 `approvals/extra-columns.ts`（`ruleAccount`、`ruleColumns` 加 account、`saveRuleExtras`），删掉 rule-account.ts。
4. adapter 的 `accountsOf` 不放进 broker 字面量（`composio-adapter.test` 的接缝表固定方法集），由 `brokerWithAccounts` 并到部署用的 broker。
5. 再连一个账号要显式 `?another=1` 且只对同意屏幕类应用：既有测试固定了「第二次 Connect 409」与「密钥应用 409」。
6. Team Bot 队友不能点名主人的账号、不告知模型（上游允许在主人账号里挑）——保底线。告知判断用 `teamBots.unaskedOwnAccount`，不花一次性同意。
7. 共享使用批准（people/team 受众、申请、exposure）在 X3；X1 固定 `owner`，切换不写批准，预览无员工列表。
8. 团队账号用密钥连接时只记「已连接、未检查」，不做试调用与失败撤回。
9. Personal 模式下管理员仍可以个人名义连接 S2S 应用（fork 既有行为与测试）；上游 S2S 只能 Shared。新增 `sharedOnly` 字段，`adminConnectOnly` 保留。
10. 模式切换审计用 `configuration.changed`（`change: account_mode`），不改 `audit.ts`；团队账号连接用既有 `mcp.account_connected`（payload `holder: deployment`）。
11. 没带上游：Arcade（X5）、单用户 `brokered_identities`、账号消失时自动删账号行（下一次列出时同步）、responsibility 来源接线（`responsibilitySources` 选项已留，未接，闭合方向）。

## 测试

- 新增：`shared-accounts.test.ts`、`account-argument.test.ts`、`brokered-accounts-schema.integration.test.ts`、`approvals-account.integration.test.ts`、`brokered-multiple-accounts.integration.test.ts`、`shared-brokered-accounts.integration.test.ts`；上游测试按 fork 接口改写，先红后绿（多账号 11 红 → 12 绿，审批 4 红 → 5 绿）。
- 原有测试一行未改。
- 本地回归：插件 / composio / 审批 / 主动提醒 / 团队员工 / 租户与 RLS 相关 155 个文件 3061 pass；3 个本地失败在 main 代码上同样失败（库残留 `team:routines`、check-in 时钟、缺 TEST_DATABASE_ADMIN_URL）。
- `bunx tsc --noEmit` 干净；`typecheck-tests` 只报本地缺 @xterm；`biome lint` 干净。

## 后续（M5a 合入后）

- merge main 进各分支（不 rebase 别人的分支），把 `rule-account.ts` 并进 `approvals/extra-columns.ts`；接上 M5 占位：`approval_conversation_grants.account`（conversationGrant 按账号）、`rule-backtest.ts` 按账号回放、`tools.ts` 的账号参数位置、`app.ts` 的 `AccountModeSwitch` 类型导入。

## 评审后修复（x1-review.md）

新 head：#423 a96fab59、#424 9108f940、#425 3869e4ab、#427 608d83e9（按 PR 归属改对应分支，上层分支 merge 上来，未 force-push）。四个分支 CI 全绿。

### 已修
- **C1（#427）**：共享闸门改为与上游 `createSharedUseGate` 一致——没有共享使用批准就拒绝。上游在没有批准行时对任何人都拒绝，**管理员本人也不例外**（有批准行时 `admits` 才放行管理员与主人）；fork 照此。批准表在 X3，所以在那之前团队账号对每一次调用都拒绝，审计 `shared_account_not_approved`。删除 `STRICTEST_APPROVAL`，`admits` 留给 X3。测试：主人、管理员、经转交的主人、成员给自己的私人员工授权后调用、Team Bot 队友，全部被拒且不触达 vendor。团队账号的连接、断开、模式切换照常可用。
- **I1（#427）**：`confirmSharedConnection`、`connectSharedWithFields`、`disconnectShared` 在任何 vendor 动作之前 `requireServerWriter()`；写团队行用 `.returning()` 校验，一行未写到就报错。连接路由在把团队身份交给 vendor（铸授权链接）之前调 `requireTeamAccountWriter()`（管理员能力，重新读过角色）。测试：会话里仍是 admin、数据库里已无管理员角色的人，连接 / 确认 / 断开都 403，vendor 未被问；store 方法在无能力帧里直接拒绝。
- **I2（#427）**：切回 Personal 与移除应用时，只要有团队身份就撤销（不再只看 `shared_connected_at`）；撤销失败则不改模式、不清团队身份。测试：同意屏幕授权了未确认 → 切回时撤销；撤销失败模式与身份不变；移除应用时撤销。
- **M2（#423）**：`brokered_accounts` 加与 0153 相同的「必须是个人租户」CHECK，两个唯一索引以 tenant_id 开头（同步的 ON CONFLICT 目标随之加 tenant_id，#425）。0180 未进 main，直接修改。
- **M3（#423）**：`account_mode` NOT NULL；`shared_account_check` 要求 Personal 应用的团队账号各列全空、Shared 应用已连接必有连接人。
- **M4（#427）**：先检查部署 id，再撤销任何人的账号。测试：部署 id 为空时切换被拒、没有撤销任何人。
- **M5（#425）**：调用开的是别人的账号（Team Bot 队友用主人的账号）时不挑账号，不读主人的账号行——主人的账号名不进队友的审批卡与审计，不再只靠行级安全。测试：在读得到主人账号行的帧里调用，审批候选无 account，审计不含主人邮箱。
- **M6（#427）**：移除应用的审计对团队账号记 `holder: deployment`，不记 vendor 身份。测试覆盖。

### 未改（核实后）
- **M7 同意卡**：`teamBots.credentialActorFor` 只在提问者自己在该应用上有个人连接时才弹「用你自己的账号」卡；切到 Shared 时每个人的个人连接都已撤销并删除，Shared 应用的 Connect 也只连团队账号，所以 Shared 应用上不会弹出这张卡。未改 team-bots。

### 留到 M5a 合入后
- **M1**：账号名按位置生成（「账号 N」）导致保存的规则在账号增删后漂移；上游同样写法。打算让审批 / 规则按稳定的行 id 绑定、label 只用于展示，与把 `approval_rules.account` 并进 `approvals/extra-columns.ts` 一起做。
- **M7 responsibilitySources**：`index.ts` 未传，职责开始的运行在 Shared 应用上按外部输入拒绝（闭合方向）；X3 接批准时一起接。
- **M7 drizzle schema**：`approval_rules.account` 不在 drizzle 声明，并进 `extra-columns.ts` 时在冻结说明里写明，防止 `drizzle-kit generate` 生成 DROP COLUMN。

### 测试
- 新增 / 修改的只有本 PR 的测试文件：`brokered-accounts-schema`（+5）、`brokered-multiple-accounts`（+1，M5）、`shared-brokered-accounts`（17 条，新增 7 条在修复前为红）。原有测试一行未改。
- 本地回归 155 个文件 3070 pass；剩 3 个失败在 main 代码上同样失败（本地库残留与环境变量）。tsc、typecheck-tests（只报本地缺 @xterm）、biome lint 干净。

### 复核后修复（x1-rereview.md）
新 head：#423 a96fab59、#424 9108f940、#425 995b82ca、#427 bfec22fa，四个分支 CI 全绿。
- **N1（#425，合进 #427）**：Team Bot 队友用主人账号时，调用在主人的帧里只读主人默认账号的 id 钉上（没有默认取最早的），不再落到 Composio 自己挑的账号；名字不读，M5 不回退。M5 测试改为断言钉到默认账号，并新增「主人两个邮箱、改默认后队友跟着走、队友点名被拒」测试（修复前为红）。
- **N3（#427）**：共享闸门注释与测试文件头改为「没有批准就拒绝」的现行说法。
- **N4（#427）**：新增填写字段类应用（API_KEY）的能力检查测试：无能力帧调用 `connectSharedWithFields` 被 `ServerWriteRefusedError` 拒绝且不触达 vendor，同一调用在持有能力的帧里成功；去掉 `requireServerWriter` 时这条会红（已实测）。
- **N2（记录，不改）**：部署去掉 Composio 密钥后，有团队身份的 Shared 应用切不回 Personal（`disconnectShared` 抛 BrokerUnconfigured，返回 failures、模式不变）。方向是失败关闭：Shared 应用的调用本就全部被拒。与 `removeServer` 无 broker 时照常继续的处理不一致，待 X3 接批准时统一（无 broker 时记 `vendorRevocationRequested: false` 放行，或给出明确提示）。

---

## X2 报告：应用访问审批（app-access）与 fork 申请访问收件箱合成一套

## PR（依次叠加，均为草稿）

| PR | 分支 | base | head | 内容 |
| --- | --- | --- | --- | --- |
| #431 | feat/align-x2-app-access-1 | feat/align-x1-accounts-4 | a8e188e7 | 迁移 0187、状态规则、事实读取、新路由、收件箱补齐 |
| #433 | feat/align-x2-app-access-2 | feat/align-x2-app-access-1 | e587be1b | 每位员工都持有 `show_app_access` |

非测试文件：PR1 改了 8 个（journal、0187、schema、app-access.ts、app-access-store.ts、app-access-routes.ts、routes.ts、store.ts），另有分片清单；PR2 改了 2 个（show-app-access-tool.ts、index.ts），另有分片清单。

## 迁移

- `recovery-20261018-v1/sql/0187_app_access_upstream.sql`，journal `when` = 1794323193638，比 overlay 原最大值（0181 的 1794318911781）大。编号 0188–0191 没用；X5 从 0192 起。
- 这是对 0153 的差异迁移，没有另建表：
  - `server_id` 改为可空；
  - 新增 `app_key`、`app_title`；
  - 新增 CHECK `app_access_requests_app_named`：有行，或者键和名字都有；
  - 新增 CHECK `app_access_requests_app_key_length`：两者都不超过 200；
  - 去重索引 `app_access_requests_pending_idx` 改为 `(tenant_id, requester_user_id, bot_id, coalesce(server_id, app_key), kind) WHERE status='pending'`。
- 租户、RLS（ENABLE + FORCE、四条 tenant_isolation 策略）、GRANT 都沿用 0153，没动。
- 已有的申请不用回填：有行的申请，键和名字在读的时候从 `mcp_servers` 取。
- `kind` 仍只收 `enable` / `grant`。

## 逐项对照（fork 原有 vs 上游）

| 项 | fork 原有（0153） | 上游（0060） | 合并后 |
| --- | --- | --- | --- |
| 表 | `server_id` 外键（必填）、`bot_id` 必填、uuid、`note`、`decided_by`（邮箱）/`decided_at`、按人分租户 + RLS | `app_key`/`app_title`（可以是还没有行的应用）、`agent_id` 可空、`resolved_*`，没有 RLS | fork 的表加上 `app_key`/`app_title`，`server_id` 可空；`bot_id` 仍必填 |
| kind | enable（上架）/ grant | enable（打开应用）/ grant / connect_shared | enable / grant（connect_shared 不收，原因见下面的差异 1） |
| 状态 | 没有 | 8 种 AppAccessState | 移植全部 8 种；账号判定用 X1 的 `accountFor` |
| 工具 | `request_app_access`（在对话里替对方建申请） | `show_app_access`（只读卡片） | 两个并存（PR2） |
| 路由 | `/access-requests/mine`、`GET/DELETE /access-requests/:id`、`GET /access-requests`、`approve`、`dismiss` | 同名路由，加上 `/for/:agentId/apps[/:app]`、`POST /access-requests`、一按批准、`/give`、`/giveable`、`/owner-grants` | fork 的路由保留，响应按上游形状补齐；新增 4 条；`/give`、`/giveable`、`/owner-grants` 留给 X3 |
| 审计 | `configuration.changed`（change: `app_access_*`） | `app_access.requested/cancelled/approved/dismissed/refused` | 两套并存：fork 的行不变，同时写上游的 `app_access.*`（audit.ts 和 audit-words 里已有这些词，现在第一次真正写入） |
| 文案 | 中文 | 英文 | 新路由和工具都是中文；工具描述（给模型看的 description）沿用上游英文，和 fork 其他工具一致 |

## 接口（给前端会话）

所有路径都在 `/api/plugins` 下。

### 申请记录 `AppAccessRequestRecord`（所有返回申请的接口都用这个形状）
- fork 字段：`id, tenantId, serverId, appKey, appTitle, botId, botName, requesterUserId, requesterName, requesterEmail, kind, status, note, decidedBy, decidedAt, createdAt`
- 上游字段名（别名）：`agentId`（= botId）、`requestedBy`（= requesterUserId）、`resolvedAt`（= decidedAt）、`resolvedBy`（= decidedBy）
- 两点要注意：
  - `resolvedBy` 是处理人的邮箱，不是用户 id（fork 原来就记邮箱）。
  - 申请的应用还没有行时，`serverId` 是空串 `""`（fork 既有测试把这个字段的类型钉成了 `string`），判断是哪个应用请看 `appKey`。

### `AppAccess`（单个应用的状态）
和上游前端 `app/src/lib/app-access/queries.ts` 的类型完全一致：
`key, displayName, logo, provider("composio"|"catalogue"|"custom"), account, connect, authScheme, accountMode, state, unavailable, accountHolder, asksFirst, granted, ownerGrants, givenByOwner, needsConnect, connectedAt, requestKind, request`。
- `key` 是授予 ref 的前缀，取 `coalesce(catalogue_key, id)`；broker 应用取回答它的那一行的 id，比如 `composio-gmail`。
- `requestKind` 只会是 `"enable"`、`"grant"` 或 null，fork 不会给出 `"connect_shared"`。
- X2 里 `givenByOwner`、`needsConnect` 恒为 false，`ownerGrants` 只给按账号算出的默认值，`owner_grantable` 不会出现。这些由 X3 接上。

### 路由
- `GET /for/:agentId/apps` → `{ apps: AppAccess[] }`，按 `displayName` 排序。这个人不能用这位员工时返回 404 `{ error: "没有这位员工。" }`。
- `GET /for/:agentId/apps/:app`（`app` 可以是键、行 id、slug 或应用名）→ `{ app: AppAccess }`。叫不出这个应用、或名字超过 200 字符时返回 404。
- `POST /access-requests`，body `{ agentId, app, note? }`（`note` ≤ 500 字）
  - 新建 → 201 `{ request, created: true }`；已有同一条待处理的 → 200 `{ request, created: false }`。
  - 400：缺字段、名字过长、理由过长。
  - 404：员工不能用，或没有这个应用、这个应用没有东西作证。
  - 409：状态里没什么可请管理员做的；或这是本人自己添加的应用。
  - 429：已有 20 条在等。
  - 每一种拒绝都写一行 `app_access.refused`（`reason` 取 `no_such_bot`、`no_such_app`、`own_app`、`nothing_to_request:<state>` 或 `too_many_pending`）。
- `POST /for/:agentId/apps/:app/approve`（管理员在卡片上一按，需要持有能力）
  - 返回的形状和收件箱的批准相同；会以管理员本人的名义建一条申请，然后马上批准。
  - 没能做成时，这次新建的申请会被撤回，并写一行 `app_access.cancelled` `{direct: true}`。
  - 成员调用返回 403。
- `GET /access-requests`（管理员）→ `{ requests, counts: { total, byApp } }`，支持 `?app=<key>` 只看一个应用。
- `POST /access-requests/:id/approve`（管理员），body 可带 `{ refs?: string[] }`
  - 成功 → 200 `{ request, granted: string[], enabled: boolean }`。
  - 400：`refs` 不是字符串数组，或其中有不属于这个应用的动作。
  - 409：缺管理员才能填的东西（密钥、OAuth 客户端、实例地址），或 Composio 应用还没打开；申请保持待处理。
  - 409 `{ applied: true, granted }`：改动已经生效，但申请在这期间被撤回或驳回（fork 原有行为）。
  - 503：没有 COMPOSIO_API_KEY。
- `POST /access-requests/:id/dismiss`、`DELETE /access-requests/:id`、`GET /access-requests/mine`、`GET /access-requests/:id`：形状不变，另外补写 `app_access.*` 审计行。

### 工具（PR2）
- `show_app_access`，ref `app-access/show_app_access`，参数 `{ app }`。
- 返回 `[connect-app]{serverId,title,agentId,reason:"access",blocked} <给模型的中文句子>`。
- 应用叫不出来时返回一句中文，不带卡片。

## 安全规则（都有测试，见 `app-access-upstream.integration.test.ts`）
- 谁能申请：只能为自己能用的员工申请（`canUseBot`，否则 404，不透露员工存不存在）。只有行、目录条目或 broker 目录能作证的应用能申请；随手写的 `composio-` 键按「没有这个应用」处理。申请的类型由服务端决定，本人自己能解决的状态不建申请。本人自己添加的应用不建申请。每人最多 20 条待处理。
- 谁能批准：持有能力的管理员（`decisionRefusal`）；被收回角色的管理员拿不到能力。一按批准也一样。
- 批准授予什么：不带 `refs` 时只给只读、非破坏性的动作。带 `refs` 时只能是这个应用的动作，并且每一个都要过 `enablementDecision`（和 POST /grants 是同一道门）。`enable` 只上架、不授予。
- 队友能不能借 Team Bot 拿到别人的应用：
  - Shared 应用：和 X1 的共享闸门给同一个答案。X1 评审（C1）之后，闸门是「没有共享使用批准就拒绝，管理员也不例外」，而批准表要到 X3 才有，所以已连接、已授予的 Shared 应用对谁都是 `shared_not_approved`，也没有可申请的。X3 接上批准后，这里改为调用 `admits`。
  - Personal 应用：和 `credentialActorFor` 同一条规则——主人连接了，就用主人的账号；否则用队友自己的账号，并且在没有长期同意时 `asksFirst`。
- 帧：管理员看别人的私有员工时，员工持有什么要经 `asBotOwner`（已有的门）在主人的帧里读；没有新开 platform 门，`tenant-invariants` 的门计数不变。

## 与上游的差异和原因
1. **不建 `connect_shared` 申请**：fork 的 0153 测试「a kind outside enable and grant is refused, connect_shared included」被钉住，按 brief 保 fork 测试。所以 `shared_not_connected` 的 `requestKind` 是 null，卡片只能说「等管理员连接」。如果要把上游这部分也对齐，需要用户同意改那条测试的语义（可以放在 X3 和共享使用一起做）。
2. **批准仍是「先改、后关单」**：fork 的竞态测试钉住了 `applied: true` 的 409，所以没有采用上游「先认领再改」的做法。
3. **`enable` 只上架（D08），不授予**：fork 测试「上架不授予」被钉住。还没有行的目录条目先 `addServer` 再上架；Composio 目录里还没打开的应用（需要选认证方式），请管理员先在插件页启用，申请保持待处理。上游在批准时会直接 `enableComposioApp`；fork 的启用逻辑写在 POST /composio/apps 路由里，没有抽出来复用。
4. **共享使用审批的受众、主人自己给应用（owner grants）**：留给 X3。`mayGiveOwn` 恒为 false，`/give`、`/giveable`、`PUT /servers/:id/owner-grants` 都没有带过来。
5. **账号模式没人决定（NULL）的 broker 应用**：读作 `disabled` / `scheme_unreadable`，和调用时 `accountFor` 的 ambiguous 一致（不猜）。上游会把它当成个人账号。
6. **`serverId` 为空串、`resolvedBy` 是邮箱**：见上面「接口」一节。
7. **上游 `toolsComeWithSignIn`（个人版先打开再登录拿工具）**：没带过来，归 X4（personal-defaults）。
8. **工具测试的后半段（`addressedTo` 给拒绝署上员工、应用显示名）在 `plugins/tools.ts`**：这是 M5 留给 X 系列的位置，等 M5 合入后再做。
9. **审计两套并存**：`configuration.changed` 是 fork 原有的、要保留；`app_access.*` 供上游的审计页读。

## 测试
- CI：#431（a8e188e7）、#433（e587be1b）都通过。
- 新增 3 个测试文件，都是上游测试按 fork 接口改写的：
  - `app-access-state.test.ts`：19 个，先红（模块不存在）后绿；
  - `app-access-upstream.integration.test.ts`：27 个，不挂路由时 25 红，挂上后 27 绿；
  - `app-access-tool.test.ts`：19 个，先红后绿。
- 原有测试一行未改；`app-access-requests`、`app-access-routes`、`tenant-invariants`、`recovery-overlay-journal`、`built-in-tool-labels`、`copilot` 都通过。
- 本地回归：插件 / composio / 审批 / 主动提醒 / 目录 / 租户 / 审计 / 账号相关共 185 个文件，3231 个通过。剩下的失败都和本改动无关：
  - `proactive-connected-reads`：并行跑时端口冲突，单独跑全部通过；
  - `proactive-store` 的时钟用例：本地缺 `TEST_DATABASE_ADMIN_URL`；
  - `plugin-store` 的 `list_triggers`：库里残留 `team:routines`，X1 报告里已经记过。
- `bunx tsc --noEmit` 无错误；`typecheck-tests` 只报本地缺 @xterm；`biome lint --error-on-warnings` 无问题。

## 和 X1 评审修正的合并
- X1-4 在评审后又改了（0180 收紧约束；共享闸门改为没有批准就拒绝；队友不读主人的账号名）。已经把 `origin/feat/align-x1-accounts-4`（608d83e9）merge 进 X2-1，再把 X2-1 merge 进 X2-2，没有改写历史。
- 唯一的冲突在 store.ts 的 import 上，X1 删掉了 `admits` / `STRICTEST_APPROVAL`。状态读取和工具文案都跟着改成了「管理员还没有批准」。
- 0180 的 SQL 改过，本地 `openbot_x2` 需要从 `openbot_p9` 重建后再跑迁移。

## 后续和顾虑
- M5a 合入 main 之后：把 main merge 进 X2 分支（不 rebase），再在 `tools.ts` 的 M5 位置接上 `addressedTo`、应用显示名、按 waiting/later/个人版分开说的提示，并补上上游工具测试的后半段。
- 并行冲突：`store.ts` 只加了一行 import 和一行展开，`routes.ts` 只改了收件箱那一段（fork 独有的区域），和 X5 的冲突面很小。
- `connect_shared` 的取舍需要用户拍板（差异 1）。

## 安全评审修正（x2-review.md 的 I1、M1–M5）

提交：
- `-1` 上依次是：
  - df02637a：修正；
  - df5cb729：用例和注释改成写行为和原因。注释门禁 `comments-say-the-reason` 不收 `review fixes` 这种评审历史，所以 describe 按行为命名，注释里的评审编号也删掉了；
  - 77387fa9：merge `origin/feat/align-x1-accounts-4`，带上 X1 的复核修正 N1（Team Bot 队友调用钉到主人的默认账号）。
- 每一步之后都把 `-1` merge 进 `-2`，`-2` 的 head 是 e7908281。
- 全程只追加提交，没有 rebase，也没有强推。合并冲突只在 `index.ts`：`-1` 给 `request_app_access` 传了 Composio 配置，`-2` 在旁边加了 `show_app_access`，两边都保留了。

每一条都先写测试，确认是红的，再修。测试统一追加在 `app-access-upstream.integration.test.ts` 末尾的 `describe("review fixes")` 里，自带数据，原有测试一行没改。`-1` 的非测试文件改动现在是 11 个，没有超过 12 个的上限。

- **I1（查重键）**
  - `fileAppAccessRequest` 的 `samePending` 改成和 0187 索引同一个表达式：`coalesce(server_id, app_key) = coalesce(:serverId, :appKey)`。插入冲突后回读用的也是这个键。
  - 现在，broker 应用在没有行时被申请过，打开后再申请，会答已有那条：浏览器入口返回 200 `created:false`，工具返回卡片 `existing`。不再出现 500。
  - 测试：先插入一条无行的申请，再建行，然后分别从路由、store、工具各申请一次。
- **M1（一按批准 try/finally）**
  - `POST /for/:agentId/apps/:app/approve` 改成 try/finally。只要是这次新建的申请（`created`），并且 `carryOut` 抛出异常或者答复不是 200，就撤回这条申请，并写带 `direct: true` 的 `app_access.cancelled`。
  - 撤回本身失败时只记日志，不会盖住原来的答复或异常。
  - 测试：用 `Object.create(store)` 让 `listServers` 抛错，确认按下后管理员没有留下待处理申请、有撤回审计、也没有写入授予。
- **M2（主人连接的细节）**
  - `describe` 里，`accountHolder === "owner"` 时 `connectedAt` 一律是 null。给队友的只有「是谁的账号」和「能不能用」，主人连接的时间不给。
  - 注释里写明了：在队友的帧里，主人的连接行受行安全保护，本来就读不到，这一支在现有调用处不会走到。这里是防御。
  - 测试有两条：
    - 队友帧里（真实路由）看不到主人的连接，`accountHolder` 是 `you`，列表和单个应用里都没有主人的 `connectedAt`；
    - 在 platform 帧里调用 `inspectApp`（能读到主人连接），结果是 `accountHolder: "owner"`、`connectedAt: null`。
- **M4（旧工具按状态定类型）**
  - 新增 `requestPlanFor(inspection)`（`app-access-store.ts`），浏览器入口（`requestable`）和 `request_app_access` 都从同一次 `inspectApp` 走它。它负责判断：
    - 没有这个应用；
    - 自己添加的应用；
    - 状态没有可请管理员做的事（`REQUEST_KIND_FOR` 为 null，比如 ready、not_connected、reconnect、shared_*）；
    - 否则给出 `enable` 或 `grant`，以及这个人已经在等的那一条。
  - 两个入口遇到「已经在等的那一条」都直接答它，不再新建。这条包括工具对有行的应用提的上架申请，卡片本来就把它算作申请。这样同一个人、员工、应用不会再同时挂着工具建的 `enable` 和浏览器建的 `grant` 两条。
  - 和浏览器入口仍有一处差异：fork 0153 的测试钉住了「有行、没给这位员工、还没上架 → 申请上架（`enable`）」，所以工具在 `not_granted` 且没有上架时仍然提 `enable`（D08：批准后由主人自己装）。浏览器入口照上游提 `grant`。
  - 工具新增可选参数 `composioConfigured`、`directory`，`index.ts` 传入的值和 `show_app_access` 相同。
  - 已经没有调用的 `store.findAppForRequest` 删掉了。
  - 「无需申请」那句话（`nothingToRequest`）从路由移到 `app-access.ts`，两个入口共用。
- **M5（refused 审计）**
  - 申请人一侧的 `app_access.refused` 改走 `store.recordAppAccessRefusal`：
    - 在 10 分钟的窗口内，同一个人、员工、应用、原因只记第一次；
    - 每个人在窗口内最多记 30 行；
    - 记在进程内存里，键超过 1 万个时清掉过期的。
  - 答复不受影响，每次请求照样拿到自己的答复。管理员处理申请时的拒绝（`approvalRefused`）不限频，照旧逐条写。
  - `DELETE /access-requests/:id` 的 id 不是 uuid 时，直接答 404，不读库、不写审计。**和任务要求的 400 不同**：fork 原有测试 `app-access-routes.integration.test.ts`「an id that is not a request at all is answered as none」钉住了 `not-a-uuid` → 404，按「原有测试一行不改」保留 404。
  - 测试有三条：
    - 2000 字符的 id 答 404，不写审计；
    - 同一个拒绝按三次，只记一行；
    - 60 个不同的应用名，最多记 30 行，60 次都答 404。
- **M3（不改行为）**
  - 收件箱和批准不区分申请人是员工主人还是 Team Bot 队友。队友对 Team Bot 申请个人账号类应用的 `grant`，批准后授予会落在整个 Team Bot 上。
  - 这是上游的设计：上游的 `canUseBot` 允许队友申请，`carryOut` 授予给员工。fork 的 0153 工具从一开始就能这样做，所以不是 X2 引入的。X2 只是多了浏览器入口。
  - 这次没有改。如果要加「批准将授予整个 Team Bot」的提示，或者让主人确认，可以和 X3（共享使用批准、主人给应用）一起做。

### 验证
- `app-access-upstream`、`app-access-requests`、`app-access-routes` 共 77 个通过（新增 11 个，修之前 10 个红，M2 的「队友帧」那条是固定现状的）。`-2` 的 `app-access-tool`、`app-access-state` 共 38 个通过。
- 插件 / Composio / 审批 / 主动提醒 / 目录 / 租户 / Team Bot 相关 121 个文件：2716 个通过，7 个失败、5 个错误。这些失败和错误在改动前的基线上原样复现，都是本地缺 `TEST_DATABASE_ADMIN_URL`，以及 `plugin-store` 的 `list_triggers` 残留数据。
- `bunx tsc --noEmit` 无错误；`typecheck-tests` 只报本地缺 @xterm；改动文件 `biome lint --error-on-warnings` 无问题。`index.ts`、`routes.ts`、`store.ts` 原本就有 organizeImports 提示，这次没有新增。
- CI：
  - #431 的 head 是 77387fa9，28 项通过。Windows `desktop tests` 第一次因为已知的 `window.event` 偶发问题失败，重跑一次后通过。
  - #433 的 head 是 e7908281，28 项全部通过。

---

## X3 报告：主人授权（owner grants）与共享使用（shared-use）并入 fork 服务端

## PR（依次叠加，均为草稿）

| PR | 分支 | base | head | 内容 |
| --- | --- | --- | --- | --- |
| #436 | feat/align-x3-owner-shared-1 | feat/align-x2-app-access-2 | 1fe5d0e7 | 迁移 0196、共享使用批准、闸门、批准与申请路由、事件名 |
| #437 | feat/align-x3-owner-shared-2 | feat/align-x3-owner-shared-1 | d7eef43d | 迁移 0197、主人给员工应用、Team Bot 不用主人账号、主人设下的共享受众；X2 评审 M3（申请记录说明批准对整个 Team Bot 生效） |

每个 PR 的非测试文件数（不含分片清单）：

- PR1 共 12 个：0196、journal、`db/schema/shared-use.ts`、`shared-use.ts`、`shared-use-store.ts`、`shared-use-routes.ts`、`store.ts`、`routes.ts`、`index.ts`、`app.ts`、`audit.ts`、`shared/audit-words.ts`。
- PR2 共 11 个：0197、journal、`db/schema/plugins.ts`、`owner-grants.ts`、`store.ts`、`shared-use-store.ts`、`app-access-store.ts`、`app-access-routes.ts`、`routes.ts`、`index.ts`、`team-bots.ts`。

X2-2 的新提交（评审修正）以 merge 的方式合进了 X3-1，再由 X3-1 合进 X3-2，没有 rebase。合并中有两处冲突：

- `store.ts`：X2 新增的 `ownersAccountId` 与 X3 的 `sharedAppId` 都保留；
- `app-access-store.ts`：X2 只改了注释，已跟上。

## 迁移（overlay `recovery-20261018-v1/sql`）

开工前已确认 0196、0197 未被占用。main 上的 overlay 到 0174，X5 用到 0192。journal 的 `when` 都取当时毫秒，大于 overlay 原最大值（0187 的 1794323193638）和 X5 的 0192（1794324710665）。0198、0199 没有用。

- **`0196_shared_use`**（when 1794327148835）
  - 三张表：`shared_use_approvals`、`shared_use_approval_members`、`shared_use_requests`。
  - 写法照 0153：`tenant_id`（默认取帧）、ENABLE + FORCE RLS、四条 tenant_isolation 策略、GRANT openbot_app、`*_tenant_person` CHECK（不能是 system/platform/team）。
  - 与上游的差异：主键改为 `(tenant_id, agent_id, server_id)`；名单表的外键带上 tenant_id；待处理申请的唯一索引改为 `(tenant_id, agent_id, server_id) WHERE pending`；申请 id 用 uuid。
  - 上游 0065 的 `approved_as` 直接建在表里。
- **`0197_owner_app_grants`**（PR2 提交时的毫秒）
  - `mcp_servers.owner_grants`：取值 any/admin，NULL 表示默认。
  - `plugin_grants.granted_as`：取值 admin/owner，NULL 读作管理员。
  - 两列各有 CHECK，没有回填。

注意：brief 说 fork 里已有一个未接线的 `server/src/db/schema/shared-use.ts`。实际查过本分支、main、M5、X1 各分支，**都没有这个文件**。所以这里是照上游 schema 新写的，按 fork 租户模型改了。

## 帧与行安全的设计（安全敏感，请重点评审）

- **批准、名单、申请的行都属于员工的主人**（个人租户）。
  - 没有建 `team` 标记的共享表：`rls-write-scope` 固定了共享表集合，测试不能改。
  - 没有新增任何策略，只有 0153 式的四条。
- **闸门**（`createSharedAudience().gate`）：
  - 先经 `agents/bot-owner.ts` 的 `ownerTenantOfBot` 得到主人 id。这是已有的 platform 读，只有 id 离开。
  - 然后 `runAsTenant(owner)`，只读批准和员工的开放范围。做法与 SEC1 `approvals/store.ts` 的 `employee` 读员工安全底线相同。
  - 提问人的事实（群组、管理员角色）在提问人自己的帧里读。
  - 在别人的帧里一个字都不写：只有调用本身就在主人帧里时（主人自己、主人的例行任务与职责），被拒的调用才建一条申请。队友被拒时只告诉他「请员工的主人向管理员申请」。
- **写批准**（`setApproval`、`fileRequest`、`decide`、`approveOwnerGrant`）之前，都确认当前帧就是员工的主人（`SharedUseFrameError`）。
  - 管理员在自己的帧里替别人的员工写，会被拒。
  - 没有主人的员工也会被拒。
- **管理员的批准和驳回**：经已有的 `asBotOwner`（`adminActAsOwner`）进主人的帧，轨迹落在主人名下。
- **管理员收件箱**：把 `GET /access-requests` 原来那次 `asAdminPlatform` 读改成一个闭包 `pendingForAdmin`，一次读出应用访问申请和共享使用申请，两个收件箱路由共用。`routes.ts` 里 `asAdminPlatform` 的调用点数不变，`tenant-invariants` 的 `SRC_DOORS` 不变。在 platform 帧里读批准时会限定在申请所在租户，所以别人租户里伪造的行读不到。
- **跨主人删除**用 X1 已有的 `reachEveryPersonOn`，之前先过 `requireServerWriter`。用在两处：
  - 账号模式切换（两个方向都删）；
  - 管理员把 `owner_grants` 改离 `any` 时，撤回主人设下的受众。
- **伪造行**：任何人都能在自己租户里写一行「某员工、某应用」的批准（行安全允许本人写本人的行），但闸门只在员工真正主人的帧里读，所以这种行永远不会被读到。有测试覆盖。

## 共享使用规则（按上游逐条移植，都有测试）

- **没有批准就拒绝**：员工的主人和管理员也不例外（`shared_account_not_approved`）。有批准时按 `admits` 判：
  - 主人和管理员总在受众里；
  - `owner`：只有他们；
  - `people`：按批准时的名单（人按 id、群组按名字），之后加进发布名单的人会被拒（`shared_audience`）；
  - `team`：任何人。
- **外部输入**：运行由外部输入驱动时，需要批准里 `outsideInput` 为真，主人也一样。
- **发起方**：
  - check-in：一律拒绝（fork 原有）；
  - 没有发起者、`deployment`、没有起点的转交、认不出的类型：拒绝（X1 的 `steeringOf`）；
  - 转交：按起点判；
  - 职责：按它的触发器与订阅来源判，有任何来源不是 manual/schedule 就是外部输入。
- **`responsibilitySources` 已接上**（`sharedUseStore.sourcesOf`）。帧里读不到的职责答 `["unknown"]`，按外部输入处理。这一点比上游更严：上游读不到时答空，会被读成由人驾驶。
- **Team Bot 队友能不能拿到团队账号**：由主人名下的批准决定（受众 people/team 时可以）。vendor 处用的是部署的团队身份，不是任何人自己的账号。
- **申请**：提议永远是服务端按员工当前开放范围（`exposureOf`）算的。浏览器送来的提议会被忽略，同一提议不会重复建。
- **批准的写入**：批准会覆盖它已经盖住的待处理申请；同一条申请只能决定一次（409）。
- **切换账号模式**：两个方向都结束这个应用的全部批准，包括同一地址上的重复行。

## 主人给应用的规则（都有测试）

- **能给谁、给什么**：
  - 只能给自己拥有的员工（`agentOwner`）。
  - 只能给管理员已经打开、并对主人开放的应用（`ownerGrantsOf` 为 `any`）。默认是个人账号应用和内置的例行任务；管理员留给自己的、或没打开的，都给不了。
  - 还要通过 `ownerApps` 能力检查。
- **给出什么**：只读、非破坏性的动作（内置例行任务例外），标为 `granted_as = owner`。
  - 主人的授予不覆盖管理员的：冲突时什么都不写，也不进轨迹。
  - 管理员在主人的那条上再授予，就成了管理员的。
- **收回**：只收回主人自己做的授予，管理员的那条留着；收回需要是员工的主人。
- **Team Bot**：主人给的应用永远用提问人自己的账号。提问人没有长期同意时先问，没连接就用他自己的（会被拒），从不用主人的。check-in 不读它。管理员做的授予照旧用主人的账号。
- **Shared 应用**：只有管理员明确设为 `any` 时，主人的授予才设下受众。
  - 受众是此刻能用这位员工的人（私人员工只有主人；Team Bot 是它发布给的人），不含外部输入，也不覆盖已有批准。
  - 主人收回应用时撤回。
  - 管理员改回 admin 或默认值时，跨主人全部撤回。
  - 规则不是 `any` 时，留下的受众也不读。
- **改规则**：只有持有能力的管理员能写 `owner_grants`。被收回管理员角色、会话里仍显示 admin 的人会被拒（403）。

## 接口（给前端会话）

### 共享使用（PR1）

路径都在 `/api/plugins` 下。上游是 `/api/approvals/shared-use`，前端要换前缀。

**`SharedUseRequestRow` 的形状**（与上游一致）：

- 字段：`id, botId, botName, ownerUserId, serverId, title, proposed, current, reason, requestedBy, status, createdAt`。
- `proposed` 和 `current` 的形状是 `{ audience: "owner"|"people"|"team", outsideInput: boolean, members: {kind:"user"|"group", value}[] }`；没有批准时 `current` 为 null。
- `reason` 取 `refused_call | publish | trigger | grant`。

**路由**：

- `GET /shared-use`（持有能力的管理员）→ `{ requests: SharedUseRequestRow[] }`，只列待处理的。没有能力时 403。
- `POST /shared-use/:id/approve` 和 `POST /shared-use/:id/decline`（持有能力的管理员）
  - 成功：200 `{ request }`；
  - 已经处理过或不存在：409 `{ error: "这条申请已经处理过了。" }`；
  - 其他人：403。
- `POST /shared-use`，body `{ botId, serverId, reason: "trigger"|"publish" }`。只有员工的主人或持有能力的管理员能调。
  - 成功：200 `{ id, created }`；
  - 缺字段，或员工没有用这个共享应用：400；
  - 其他人：403；
  - 没有主人的员工：409。
- `GET /shared-use/bot/:botId`（主人或持有能力的管理员）→ `{ apps: [{ serverId, title, approval, needed, covered }], pending: SharedUseRequestRow[] }`。其他人 403。
- `GET /access-requests`（应用访问收件箱）的形状不变。

**调用被拒时**，审计 `mcp.call_rejected` 的 `refusal` 取：

- `shared_account_not_approved`：没有批准，或发起方说不清；
- `shared_audience`：受众或外部输入不符；
- `shared_no_owner`：员工没有主人。

模型看到的文字是：「X 用的是一个共享的团队账号，<原因>，所以没有调用。」

### 主人给应用（PR2）

**`AppAccess` 的变化**：

- `ownerGrants`：读应用行，没选时用默认值。
- `givenByOwner`：员工在这个应用上的每一条授予都是主人做的。
- `needsConnect`：状态为 `owner_grantable`、是个人账号、且看的人自己还没连上。
- `state` 为 `shared_not_approved` 还是 `ready`，现在按真实批准判断。

**`owner_grantable` 只在 `GET /for/:agentId/apps(/:app)?view=owner` 时出现**（员工页「给」的开关用这个视角读）。不带参数时，主人看自己员工上没授予的应用仍是 `not_granted`，并且可以申请。这是 X2 的行为，有 X2 测试钉住。

**路由**：

- `POST /for/:agentId/apps/:app/give`
  - 成功：200 `{ granted: string[] }`。员工已经持有这个应用时 `granted` 为空数组（这时会补设主人的共享受众）。
  - 403 `{ error }`：不是主人、应用没对主人开放、没打开、`ownerApps` 关闭。会写一行 `app_access.refused`，`reason` 为 `owner_grant_refused`。
  - 404：这个人不能用这位员工，或叫不出这个应用。
  - 409：应用没有工具（`no_tools`），或没有只读动作（`no_read_only_tools`）。
  - 成功时写一行 `app_access.owner_granted`，payload `{ app, bot, refs }`。
- `DELETE /for/:agentId/apps/:app/give`
  - 成功：200 `{ revoked: string[] }`，写一行 `app_access.owner_revoked`。
  - 不是员工的主人：403。
- `GET /giveable` → `{ apps: [{ key, displayName, logo, account }] }`，`ownerApps` 关闭时为空数组。
- `GET /servers/:id/owner-grants` → `{ ownerGrants: "any"|"admin", chosen: "any"|"admin"|null }`，没有这个应用时 404。
- `PUT /servers/:id/owner-grants`，body `{ ownerGrants: "any"|"admin"|null }`（持有能力的管理员）
  - 成功：200 `{ ok: true, withdrawn: botId[] }`；
  - 值不对：400；
  - 不是管理员，或能力确认不了：403；
  - 没有这个应用：404。
  - 轨迹：`configuration.changed`（`change: owner_grants_changed`），被撤回的每位员工另有一行 `shared_use.owner_withdrawn`。

### 申请访问记录的新字段（X2 评审 M3，PR2）

`AppAccessRequestRecord` 是所有返回申请的接口共用的形状：收件箱 `GET /access-requests` 的条目、`POST /access-requests/:id/approve` 响应里的 `request`、`GET /access-requests/mine`、`GET /access-requests/:id`、一按批准。这次在 X2 的字段之后多了三个：

- `appliesTo: "team_bot" | "bot"`：员工是不是已发布的 Team Bot（有 `team` 标记的发布行）。
- `requesterRole: "owner" | "teammate" | "other"`：
  - `owner`：申请人是员工的主人；
  - `teammate`：申请人用的是别人发布的 Team Bot；
  - `other`：其余情况，比如没有主人的公开员工，或读不到员工资料。
- `scopeNote: string | null`：只在 `team_bot` 时有值，给管理员看。内容为「批准将对整个 Team Bot 生效：授予写在员工身上，每一个能用这位员工的人都会拿到它，不只是申请人。」，后面再接一句「申请人是这位员工的主人。」或「申请人是使用这位员工的队友，不是它的主人。」。

行为不变：批准仍然把授予写在员工身上，这是上游的设计。测试见 `app-access-team-bot-scope.integration.test.ts`（4 个，不带实现时为红），覆盖队友申请、管理员收件箱、批准响应、授予确实落在 Team Bot 上、主人自己的申请、私人员工没有提示。

**新事件**（中文词已加进 `shared/audit-words.ts`）：`shared_use.requested`、`approved`、`declined`、`owner_approved`、`owner_withdrawn`，`app_access.owner_granted`、`owner_revoked`。名字与 M5 预留的位置（`app_access.owner_granted` / `owner_revoked`）一致。

## 与上游的差异和原因

1. **租户模型**：行归员工主人所有，闸门进主人帧只读，管理员经 `asBotOwner` 写（见上一节）。上游的表没有租户。
2. **队友被拒不写申请**：上游的闸门对任何被拒的调用都替员工建申请。fork 不在别人的帧里写，所以队友被拒时只提示「请员工的主人申请」。主人自己的调用、`POST /shared-use`，以及管理员看员工页，都能建申请。
3. **没有主人的员工一律拒绝**：fork 没有可以记批准的租户。上游允许管理员为公开的目录员工批准。
4. **路由前缀**：用 `/api/plugins/shared-use`，不是 `/api/approvals/shared-use`。收件箱与应用访问收件箱共用同一道门。
5. **读不到的职责按外部输入处理**（上游会读成由人驾驶），更严。
6. **`owner_grantable` 只在 `?view=owner` 时出现**：X2 的测试钉住了「主人对自己员工未授予的应用仍是 `not_granted`、可以申请」。`POST /access-requests` 对这种情况仍然建申请；上游是 409。
7. **没有改 `POST /grants` 的主人路径**：上游的主人可以经 `POST /grants` 逐个加动作。fork 的这条路由由自助安装（D08）、listings 和原有测试决定，不动；主人只能用 `/give` 给只读动作，会写的动作仍由管理员给。fork 的自助安装授予也照旧不标 `owner`，仍按管理员授予处理（Team Bot 上主人连了就用主人的账号，与原有行为一致）。
8. **服务器列表不加 `ownerGrants` / `ownerGrantsChosen`**，避免改动原有列表测试的形状；改由 `GET /servers/:id/owner-grants` 给出。
9. **规则提示文案**：`ownerGrantRefusal` 用中文，不复用英文的 `capabilityRefusal`。
10. **没带过来的部分**（留待后续，见「顾虑」）：
    - 上游 `exposure-change.ts`：发布、指派、加触发器时自动 reapprove 或预先建申请。fork 现在靠闸门在下一次调用时拦下，主人的调用会自动建申请，管理员也可以从员工页批准。
    - 账号模式切换时在预览里列出员工、随切换写批准（上游 `account-mode.ts` 的 `approvals`）。fork 切换只结束批准，不写新批准。
11. **`shared-use-arcade-urls.test.ts` 没有移植**：本分支没有 Arcade（X5 还在做），留到合并后处理。`shared-use-store.ts` 的应用地址目前只认 `composio://`，X5 合入后要改用它的 `BROKERED_PROFILE` / `toolkitOfFor`。
12. **`connect_shared` 申请**：保持现状，不支持，fork 拒绝它的测试一行未改。「请管理员连接团队账号」仍只能由管理员在插件页直接连接。如果要支持，需要独立的入口和类型，留给用户决定。

## 测试

**新增测试**（上游测试按 fork 接口改写，先红后绿）：

- `shared-use.test.ts`：上游原样移植，18 个。先红，因为 `exposureOf` 等函数不存在。
- `shared-use-store.integration.test.ts`：21 个。覆盖闸门、伪造行、帧、名单、切换模式、决定、收件箱、职责来源、经 store 的端到端调用。
- `shared-use-routes.integration.test.ts`：9 个。不挂路由时 9 个全红。
- `owner-app-grants.integration.test.ts`：14 个。不带实现时为红。
- `app-access-team-bot-scope.integration.test.ts`：4 个（X2 评审 M3）。不带实现时为红。

**原有测试一行未改**。`shared-brokered-accounts`（X1 的「没有批准就拒绝」）、`app-access-*`（X2）、`tenant-invariants`、`rls-write-scope`、`recovery-overlay-journal`、`audit-words`、`team-bots`、`plugin-self-install` 都通过。

**本地回归**：插件、composio、审批、主动提醒、目录、Team Bot、应用访问、共享、租户、RLS、审计、账号、技能、群组、记忆相关共 168 个文件，3091 个通过。失败的用例都是环境原因：

- 缺 `TEST_DATABASE_ADMIN_URL`；
- 审批恢复类测试要求的模板库 `openbot_continuation_template`；
- check-in 时钟用例。

补上管理库地址后，`team-bots`、`team-bot-owner`、`proactive-store` 都通过。

**静态检查**：`bunx tsc --noEmit` 干净；`typecheck-tests` 只报本地缺 @xterm；改动文件 `biome lint --error-on-warnings` 干净。

**CI**：见文末。

## 顾虑与后续

- **评审重点**：闸门在别人的调用里经 `runAsTenant(owner)` 只读主人名下的批准。这与 SEC1 读员工安全底线是同一种做法，但这是第一次用在插件调用路径上，请重点看。
- **收件箱的门**：现在一次读两类申请。`asAdminPlatform` 的调用点数没变，但这道门的读取范围变大了（多读共享使用申请）。
- **X1 继续修复时**：会改 `store.ts` 的同一段调用路径。这次合并已经处理过一次冲突，后续 merge 还要留意。
- **X5 合入后**：
  - `shared-use-store.ts` 的 `composio://` 地址改为按 provider 解析；
  - 移植 `shared-use-arcade-urls.test.ts`；
  - 迁移 0196 里 `brokered` 相关字段不受影响。
- **M5a 合入后**：
  - 在 `plugins/routes.ts` 批量授权（#1396）的 M5 位置接上 `sharedGrantApproval` / `approveOwnersSharedUse`；
  - `admin/capability-changes.ts` 已按 `app_access.owner_granted` 查询，事件名一致。
- **暂缓的上游功能**：`exposure-change`（发布或指派时 reapprove / 预先申请）和账号模式切换时写批准，都是体验上的补充，安全上由闸门兜底。需要的话可以开 X3-3。
- **`?view=owner` 与申请流程的取舍**（差异 6、7）需要用户拍板：要完全按上游，就得改 X2 那几条测试的员工归属（上游自己也是这样改的测试）。

## CI

- #436，head 1fe5d0e7：28 项检查全部通过。
- #437，head d7eef43d：28 项检查全部通过。
  - 之前的 head cb16fe48 跑过一次。「desktop tests (windows-latest)」那一次失败，日志是 `ECONNREFUSED 127.0.0.1:3010` 和「Infrastructure/import failure」，属于偶发的基础设施问题，与本改动无关；重跑一次后通过。
- X2-2 的最新 head e7908281（已包含 X1-4 的最新提交）已经 merge 进 X3-1 和 X3-2，没有 rebase。


## 安全评审修复（x3-review.md：Critical 0、Important 3、Minor 7）

### 提交位置
- **X3-1**：`6b021bfa`。修了 M1、M2、M3（批准写入与切换模式这一半）、M4（`botFacts`）、M5、M6（撤销入口）、M7（待处理申请）。
- **X3-1 合进 X3-2**：`f59fbbeb`，用 merge。
- **X3-2**：`14935111`。修了 I1、I2、I3、M3（改规则这一半）、M4（`approveOwnerGrant`）、M6（离开或关掉能力即失效）。

这几条只能放在 X3-2：`owner_grants`、`granted_as` 两列，`/give`，`approveOwnerGrant`，`setOwnerGrants` 都是 X3-2 才有的，X3-1 上没有它们可改。两个分支都只追加提交，没有 rebase，也没有强推。

### Important
- **I1（自助安装也记为主人的授予）**
  - D08 自助安装（`store.grant` 带 `selfService`）新写的行记为 `granted_as = owner`。
  - 已有的行不改「谁做的」：管理员的仍是管理员的；`/give` 之后再自助安装，也不会把主人的标记改回管理员。`grantedBy` 照旧更新，D08 判断「是不是自己装的」靠的是它。
  - 轨迹 payload 没变，原有测试钉住了它的确切形状。
  - 结果：Team Bot 队友在读得到主人连接的帧里，`credentialActorFor` 也答他自己，不会是主人。
  - 测试：`owner-grants-hardening` 的 3 条。
- **I2（升级回填为 admin）**
  - 0197 在本事务里以 `platform` 帧，把升级前已有的应用回填为 `owner_grants = 'admin'`，写法照 0125。升级后仍然只有管理员能给，主人要等管理员放开。
  - 之后新添加的应用为 NULL，按上游默认值：个人账号应用和内置例行任务是 `any`，其余是 `admin`。
  - 这是与上游的差异（上游不回填）。测试会检查迁移里有这条回填。
  - 给前端（管理员应用设置里的「主人可授予」开关）：
    - 读：`GET /api/plugins/servers/:id/owner-grants` → `{ ownerGrants: "any"|"admin", chosen: "any"|"admin"|null }`。升级前就有的应用读到 `{ ownerGrants: "admin", chosen: "admin" }`。
    - 放开：`PUT /api/plugins/servers/:id/owner-grants`，body `{ ownerGrants: "any" }`。需要持有能力的管理员。
      - 成功：`{ ok: true, withdrawn: [] }`；
      - 值不对：400；
      - 无能力：403；
      - 没有这个应用：404。
    - 收回：body `{ ownerGrants: "admin" }`，响应里的 `withdrawn` 是被撤回主人受众的员工 id。
    - 回到默认：body `{ ownerGrants: null }`。
    - 文案建议：「管理员需在应用设置里放开『主人可授予』，员工的主人才能把这个应用给自己的员工。」
- **I3（切换账号模式时清掉 `owner_grants`）**
  - `setAccountModeColumns` 在改模式的同一次更新里把 `owner_grants` 清为 NULL。
  - 原来不是 NULL 时，写一行 `configuration.changed`，payload `{ change: "owner_grants_changed", server, from, to: null, reason: "account_mode_switched" }`。
  - 测试：Personal 下设为 `any`，切到 Shared 后，主人的授予设不下受众。

### Minor
- **M1（0196 的约束与键）**：迁移还没合，直接改了 0196。
  - 申请表加 `shared_use_requests_decided`（只有待处理的申请没有决定时刻）。作废申请也写决定时刻。
  - 申请表主键改为 `(tenant_id, id)`；`shared_use_requests_status_idx` 改为 `(tenant_id, status, created_at)`，`shared_use_approvals_server_idx` 改为 `(tenant_id, server_id)`。三张表的每个键和索引都以 tenant_id 开头，有目录测试检查。
  - 本地库是重建后跑的迁移。
- **M2（收件箱的 current）**：在申请所在的、员工主人的帧里只读，不被别人同地址、id 更小的私有行带偏。
- **M3（共用一把锁）**：
  - 每个应用有一把 advisory 锁，键是 `sharedUseAppLockKey`（按工具包）。写批准拿共享锁；改规则（`setOwnerGrants`）和切换模式（`setAccountModeColumns`）拿排他锁。
  - 改规则、切模式都先提交新的规则或模式，再在排他锁下删。写批准在锁内会重读：应用不是 Shared 时抛 `SharedUseNotSharedError`，批准路由答 409；主人写受众还要重读 `ownersDecide`。
  - 所以一次写入要么在删除之前提交、被删掉，要么在删除之后开始、看到新状态而不写。
- **M4（读不到员工资料时失败闭合）**：`botFacts` 只读未删除的资料；读不到时按没有主人、`private` 处理。`approveOwnerGrant` 遇到读不到资料直接返回 null，不写。
- **M5（空提问人）**：闸门先拒绝空的 `actorId`，拒绝码是 `shared_account_not_approved`。
- **M6（撤销与离开）**
  - 新路由 `DELETE /api/plugins/shared-use/bot/:botId/:serverId`，只给持有能力的管理员，经 `asBotOwner` 在员工主人的帧里删除。
    - 成功：200 `{ revoked: boolean }`，同时写事件 `shared_use.revoked`，payload `{ bot, server }`，轨迹落在主人名下；
    - 非管理员：403；
    - 没有主人的员工：409。
  - 主人离开（`revoked_access` 里有他的邮箱）或被关掉 `ownerApps` 之后，下面两样在调用时就失效，不需要先清理：
    - 主人设下的受众：`approvalFor` 读作没有批准；
    - 主人做的授予：`callTool` 拒绝，拒绝码 `owner_grant_lapsed`。
  - 管理员的授予和批准不受影响。
- **M7（待处理申请）**：切换账号模式时，这个应用的待处理申请标为作废（superseded，并写决定时刻）。
  - 还没做的部分：`composio://` 写死的两处（`shared-use-store.ts` 的规范地址和锁键，`store.ts` 结束批准时的 `like 'composio://%'`），留到 X5（Arcade）合入后改为按 provider 解析。
- **M2 之外的显示问题**：没有别的遗留。

### 测试
- 新增 `shared-use-hardening.integration.test.ts`，8 条，在 X3-1 上。修之前 8 条全红，修之后全绿。
- 新增 `owner-grants-hardening.integration.test.ts`，10 条，在 X3-2 上。修之前 9 条红；剩下那条只测辅助函数本身，函数一加上就是绿的。修之后全绿。
- 原有测试一行未改，包括 D08 的 `plugin-self-install`（它钉住了轨迹的确切形状）。
- 本地回归：171 个文件，3126 个通过。剩下 4 个失败都是缺审批恢复测试要的模板库或 `TEST_DATABASE_BYPASS_URL`，属于环境问题。
- tsc 干净；biome lint 干净。

### 修复后的 CI
- X3-1 head `6b021bfa`：28 项检查全部通过。
- X3-2 head `14935111`：28 项检查全部通过。

## 复核后的第二轮修复（x3-rereview.md）

### 提交
- X3-1：`40f9f110`；
- X3-1 用 merge 合进 X3-2；
- X3-2：`4031fee9`。

### 1. 切换模式会冲掉 I2 的回填（I3 修法的回退）
- **问题**：上一轮切换账号模式时把 `owner_grants` 清成了 NULL。Personal 模式下 NULL 读作 `any`，所以 Personal→Shared→Personal 往返一次，升级时回填的「只有管理员」就变成了主人可给。
- **改法**：`setAccountModeColumns` 改为写 `owner_grants = 'admin'`，范围是应用地址上的每一行，和 `setOwnerGrants` 一致。
- **轨迹**：只要原值不是 `admin`（包括 NULL），每次切换都写一行 `configuration.changed`，payload 为 `{ change: "owner_grants_changed", server, from, to: "admin", reason: "account_mode_switched" }`。
- **测试**：
  - 新增往返测试：回填为 `admin` 的个人账号应用，经 Personal→Shared→Personal 后仍是 `{ ownerGrants: "admin", chosen: "admin" }`，`/give` 用的 `ownerGrantRefusal` 拒绝，第二次切换也留下了轨迹。先红后绿。
  - 改了一处断言：`owner-grants-hardening` 里上一轮写的「切换后为 NULL」改成「切换后为 `admin`」，`to` 也从 null 改成 `"admin"`。这个测试是本轮修复自己新增的，行为变了，断言随之改。
- **前端**：管理员要在新模式下重新放开「主人可授予」：`PUT /servers/:id/owner-grants { ownerGrants: "any" }`。

### 2. 升级前已有的主人授予（I1 存量）
- **0197 回填 `plugin_grants.granted_as = 'owner'`**，在 platform 帧里做，写法照 0125。四个条件都要满足：
  - 是 MCP 授予，`granted_as` 为 NULL；
  - `granted_by` 与员工主人的邮箱相同（不分大小写，去掉首尾空格）；
  - 主人不是管理员；
  - 行的租户与员工的盖章一致：私人员工盖主人的租户，团队员工盖 `team`。主人取私人员工 `agents` 的租户，或团队员工资料上的 `owner_user_id`。
- **身为管理员的主人自己装的授予保持 NULL**：迁移分不清这条是以管理员身份还是以主人身份做的。
- **运行时兜底**（`plugins/owner-grants.ts`：`isOwnersGrant` / `grantedByOwner` / `ownerIdentityOf`）：
  - `granted_as` 为 NULL、授予人（邮箱或 id）就是员工主人的，一律按主人的授予处理，不另外排除管理员；
  - 主人读不出来时也按主人的授予处理（失败闭合）。
  - 用在三处：
    - `teamBots.credentialActorFor` 和 `unaskedOwnAccount`：Team Bot 队友不走主人的账号；
    - 应用卡片的 `givenByOwner`；
    - 调用时的 `owner_grant_lapsed` 失效检查。
- **测试**（新文件 `owner-grants-legacy.integration.test.ts`，4 条，先红后绿）：
  - 在事务里执行 0197 的回填语句，然后回滚，所以不影响别的测试的数据。断言三点：主人自己装的回填为 `owner`；管理员的授予保持 NULL；身为管理员的主人自己装的也保持 NULL。
  - 运行时：`grantedByOwner` 对三种标记各给出正确的判断；队友在能读到主人连接的帧里拿到的是他自己的账号，管理员授予的仍用主人的账号；应用卡片显示「主人给的」。
- **对 D08 行为的影响**（复核里提到的副作用，写进 PR 说明）：D08 自助安装和分身来源写下的授予现在都算主人的授予，所以也受 `owner_grant_lapsed` 约束——主人离开，或被关掉 `ownerApps` 之后，这些动作在调用时被拒绝。这是收紧，但改变了 D08 原来的行为。另外，安装那一步本身不检查 `ownerApps`。

### 3. 顺手修的小问题
- 切到 Shared 之前，先在应用的排他锁下结束一次批准和待处理申请（X3-1）。这样上一次切换若在「改模式」和「结束批准」之间中断，留下的批准就不会在这次切换的窗口里被读到。
  - 附带的测试只是回归测试：这个窗口只在并发时出现，单线程测不出先红。
- `/give` 在主人授予和设受众之间，如果应用被并发切走了模式，现在不设受众、照常答复，不再报 500。
- `SharedUseFrameError` 的注释回到它自己头上。

### 本轮测试
- `owner-grants-hardening` 11 条、`owner-grants-legacy` 4 条、`shared-use-hardening` 9 条，全部通过。
- 本地回归 177 个文件，3162 个通过。剩下 6 个失败都是环境原因：缺模板库、缺 BYPASS URL、本地缺 `@xterm`。
- tsc、biome lint、测试类型门禁（只报本地缺 @xterm）都干净。

### 第二轮修复后的 CI
- X3-1 `40f9f110`：28 项检查全部通过。
- X3-2 `4031fee9`：28 项检查全部通过。「desktop tests (windows-latest)」第一次因 `ECONNREFUSED 127.0.0.1:3010`（Infrastructure/import failure）失败，与本改动无关，重跑一次后通过。

---

## X4 报告：个人版的默认（personal-defaults）与对话卡片一键连接（上游 #1277 核心）并入 fork 服务端

## PR（依次叠加，都是草稿）

| PR | 分支 | base | head | 内容 |
| --- | --- | --- | --- | --- |
| #439 | feat/align-x4-personal-defaults-1 | feat/align-x3-owner-shared-2 | 8a9b28aa | personal-defaults 模块、store 的 grantTools 与个人版 botsReachableFrom、路由拒绝、#1273 技能归属、index 接线 |
| #440 | feat/align-x4-personal-defaults-2 | feat/align-x4-personal-defaults-1 | 60c1cfca | #1277 核心：批准在没有工具时先向应用要工具；个人版里随登录才列工具的应用只打开、不授予 |

非测试文件数（分片清单不计）：

- PR1：5 个，即 `plugins/personal-defaults.ts`（新）、`plugins/store.ts`、`plugins/routes.ts`、`plugins/app-access-routes.ts`、`index.ts`。
- PR2：1 个，即 `plugins/routes.ts`。

## 迁移

**这次没有新迁移，0200–0203 都没有用。**

- 上游 `0055_default_opt_outs.sql`（memory_source / proactive_research 的 opt-out）早已在 fork overlay 里，就是 `0157_default_opt_outs.sql`。它带 `tenant_id`、RLS、四条策略，schema 在 `db/schema/defaults.ts`。我核对过列、主键、CHECK、外键，都和上游 0055 一致，所以不需要重写。
- personal-defaults 自己的两项记录沿用上游做法，写在已有的部署级表 `enterprise_settings` 里，不建新表：
  - 打开过的默认应用：`personal_default_apps`；
  - 每位员工已经给过一次技能：`personal_skills_given:<agentId>`。
- 自动学习用已有的 `learning_settings`。
- 开工前确认过 main、M5、X5、X6 各分支的 overlay 里都没有 02xx 号迁移。

## 与上游的差异和原因

1. **团队版里 Routines 不常开。** 上游在每个版本里都在启动时添加 Routines，并把全部工具给每位员工，关不掉、也收不回。fork 的 Routines 在团队版里是管理员要逐个授予的能力（`catalogue.ts` 的 routines 条目），brief 也要求团队版行为不变。所以 fork 的处理是：
   - `ensureAlwaysOnApp` 和三个包装在团队版里什么也不做；
   - `alwaysOnHere(ref)` 只在个人版里为真；
   - `isAlwaysOn(ref)` 保持上游的纯函数，按名字判断。
2. **租户帧。**
   - 授予写在个人版那一个人（`DEV_ACTOR`）自己的帧里（`personalDefaultsDeps(database, DEV_ACTOR.id)` 的 `asPerson`），落成他的行。
   - 员工、授予、技能都只在他的帧里读。`listForAgent` 的包装对他看不见的员工什么也不给；上游给传进来的任何员工。
   - 服务器级的写（添加 Parallel、Routines，刷新工具）在平台帧里做，并且并进了启动时刷新自带应用清单的那一个 `runAsTenant("platform")`，`tenant-invariants` 的门计数不变。
3. **`grantTools` 用 `onConflictDoNothing`。** 上游用 upsert 改成管理员授予。fork 改成不覆盖已有的主人授予（X3 `granted_as=owner`）和平台的 `system` 行，轨迹里只列真正写下的那些。
4. **`skillExists` 只看这一帧自己的行。** fork 的技能 slug 按租户唯一，这个人写的新技能和自带技能同名时仍算新技能，会给每位员工。
5. **`ensurePersonalSkillsOwned` 限定 `tenant_id = 本人`**，在本人的帧里改。
6. **拒绝文案是中文。** 常量名和上游一致。
7. **#1277 的「打开」在 fork 是两步。** 上游批准一次就打开并授予。fork 的 `enable` 只上架，不授予（D08，X2 测试钉住），所以：
   - 还没有行的应用：卡片一按走 `enable`，加行并上架；
   - 已经有行、没授予的应用：走 `grant`，这次改的就是这一支。
   - 个人版里登录之后，由 `withPersonalDefaults` 把工具给每位员工，结果和上游一样。
8. **刷新失败只记日志，不抛出。** 失败时写 `app-access-tools-refresh-failed`，之后按「没有工具」处理。原因是 fork 的 `refreshTools` 遇到部署自身的故障会抛出，而一按的撤回逻辑在 `finally` 里。
9. **没有移植 `tests/support/personal-plugin-routes.ts`。** 它只给上游前端测试 `app-access-card-connect-before-tools.test.tsx` 用，前端不在 X4 范围。服务端的同一组断言放在 `app-access-connect-before-tools.integration.test.ts` 里。
10. **`admin/controls.ts` 的 M5 位置还没接。** M5a（#428）还没合入，本分支上没有那一行。合入后应接成 `builtIn = alwaysOnHere(server)`，不要用 `isAlwaysOn`：团队版里 Routines 不常开，所以不能从应用白名单里豁免。个人版里 `mcpAllowlist` 本来就是关的，所以接不接都不会改变现在的行为。
11. **`agents/tool-search.ts` 自己的 `isAlwaysOn` 副本没动。** 那里按名字判断，只用来挑工具。
12. **`index.ts` 里 M3 留下的两行注释已改为指向 X4 的接线。**

## 接口（给前端会话）

所有路径都在 `/api/plugins` 下。**没有新路由**，只有已有路由在个人版里的新答复。

- `DELETE /grants?kind=&ref=&agentId=`（只在个人版）：
  - `kind=mcp`、`ref` 是 `routines/...`：403 `{ error: "例行任务一直开着，每位员工都能用。" }`；
  - `kind=mcp`、其他应用：403 `{ error: "OpenBot 个人版里，你连上的每个应用每位员工都能用。要让所有员工都不用它，请把这个应用关掉。" }`；
  - `kind=bot`：403 `{ error: "OpenBot 个人版里，每位员工都可以请你的其他员工帮忙。" }`；
  - `kind=skill`：照旧，技能可以为单个员工关掉。
  - 团队版不变。
  - 前端：个人版里应用和员工的开关应只读，或者只提供「关掉这个应用」。
- `DELETE /servers/routines` 或 `DELETE /servers/team:routines`（只在个人版）：403 `{ error: "例行任务一直开着，每位员工都能用。" }`。
- `POST /skills` 带 `global: true`：个人版里技能归本人（`ownerUserId = actor.id`），团队版仍是部署的。
- `POST /for/:agentId/apps/:app/approve`（卡片上的「连接」或一按）和 `POST /access-requests/:id/approve`，在 `grant` 申请、应用还没有保存工具时：
  - 先以按下的人的身份刷新一次工具；拿到工具后照常 200 `{ request, granted: string[], enabled: false }`。
  - **个人版**里，如果是个人账号、靠 OAuth 或同意页连接、本人还没连上的应用：200 `{ request: {status:"approved"}, granted: [], enabled: false }`。前端拿到 `granted` 为空数组时，接着打开这个应用的登录（`/connect` 流程），和连接页的「连接」一样；登录后每位员工自动拿到全部工具。
  - 仍然没有工具时：409 `{ error: "「X」还没有可以授予的工具。请在插件页|连接页打开它的页面看看原因，然后再试一次|再批准这条申请。" }`，轨迹原因记 `no_tools`。一按没做成时，那条申请撤回。
- 员工之间的转交（`botsReachableFrom`）：个人版里每位员工都能找到其余每一位员工，前端可以不显示「允许问另一位员工」的开关。

## 安全面（PR 里也写了）

- **只在个人版生效。** 团队版的包装原样放行，不多读库；启动步骤不写任何东西；一按仍拒绝什么都不给的批准。
- **授予只改「员工持有什么」，调用时的门不变。**（下面这条在 X4 安全评审后修正过，见文末。） 下面这些在调用那一刻照旧判断：
  - 审批底线（`approvals/policy.ts`：交给本人、只给允许一次、外发必审、中文按钮）；
  - X3 共享使用闸门和主人授权；
  - X1 账号规则；
  - check-in 只认可靠读。

  个人版把写工具也给每位员工，这是上游语义。底线只管交给本人、删除、外发、分享、发布，不管普通写。个人版里卡片一按会经过个人默认的刷新，所以给出的不只是只读动作（团队版仍只给只读）。普通写由「改动之前先问」挡住：个人默认在给出第一个工具之前，替还没做过选择的人把它打开。
- **会尊重 opt-out。** 关掉的默认应用不会再打开；为某位员工关掉的技能不会再给；`default_opt_outs`（0157）没动。
- **一按的门槛不变。** 仍只给持有能力的管理员。刷新在按下的人自己的帧里，只改应用的工具行。
- **不依赖 `owner_grants` 的默认值。** X4 的代码一处都没有读 `owner_grants`。

## 测试

新增 3 个文件，都是先红后绿：

- `personal-plugin-defaults.test.ts`：20 个。上游单元测试按 fork 规则改写（团队版不加 Routines；只给能看见的员工；每位员工每个应用一行轨迹）。没有实现时，模块不存在，整个文件是红的。
- `personal-defaults.integration.test.ts`：24 个。合并改写了上游 `personal-default-apps`、`personal-skills`、`personal-learning`、`personal-skill-owner`，并补上路由拒绝、`botsReachableFrom`、轨迹的发起者和行租户。去掉路由改动时有 4 个红。
- `app-access-connect-before-tools.integration.test.ts`：5 个。覆盖上游 #1277 新增的两条，加上个人版三条。没有实现时 5 个全红。

原有测试一行未改。`tenant-invariants`、`assertion-shape`、`comments-say-the-reason` 都通过。

本地回归：插件、composio、审批、主动、目录、应用访问、共享、主人、技能、例行任务、学习、Team Bot、租户、RLS 共 217 个文件，3931 个通过。剩下的 5 个失败和 4 个错误都在基线（wt-x3 代码、同一个库）上原样复现，和本改动无关：

- `learning-langgraph`：要真实模型提供方；
- Mastra：缺 `@mastra/core`；
- `plugin-store` 的 `list_triggers`：库里残留 `team:routines`，X2 已记过；
- `team-tenant-rls` 的 `approval_team_rules` RLS；
- 环境变量 `TEST_DATABASE_TEMPLATE` / `BYPASS` 没配。

静态检查：`bunx tsc --noEmit` 干净；`typecheck-tests` 只报本地缺 @xterm；改动文件 `biome lint --error-on-warnings` 干净。

## 顾虑与后续

- **M5a 合入之后：**
  - 在 `admin/controls.ts` 的 M5 位置接上 `builtIn = alwaysOnHere(server)`；
  - 上游批量授权路由 `/for/:agentId/apps/:app/grants`（#1396）如果并进来，它的撤销部分也要先问 `personalRevokeRefusal`。
- **个人版会把写工具给每位员工（上游语义）。** 安全靠调用时的审批底线。如果用户希望个人版也只默认给只读工具，改 `grantEveryTool` 的过滤就行，需要拍板。
- **前端：** 卡片在 `granted` 为空数组时要接着打开登录；个人版里应用和员工的开关要按新的 403 做成只读（M5 会话负责）。

## 和 X3 评审修复的合并

- X3-2 的评审修复（head 14935111）已经 merge 进 X4-1，得到 68a2e253；再把 X4-1 merge 进 X4-2，得到 6fe38d06。两次都没有 rebase，也没有强推。
- 唯一的冲突在 `store.ts` 的 import 行上：X4 加了 `ne`，X3 加了 `ownerTenantOfBot`，两边都保留了。
- 0196、0197 的 SQL 这次改了，所以 `openbot_x4` 已经从 `openbot_p9` 重建，再跑了一遍迁移。
- 合并后在 X4-2 上重跑回归，共 220 个文件：3955 个通过。失败的仍是上面列的那几个基线问题。X3 新增的 `owner-grants-hardening`、`shared-use-hardening` 都通过。
- X4 没有任何地方读 `owner_grants`，所以已有应用回填成 `'admin'` 不影响个人默认和一键连接。

## CI

- #439，head 68a2e253：28 项全部 success。
- #440，head 6fe38d06：28 项全部 success。
- 两个都不用重跑，没有偶发失败。

## X4 安全评审的修正（x4-review.md）

两个分支上都是追加提交，`-1` 用 merge 合进 `-2`，没有强推。每一条都先写了测试，并确认它是红的。

- **I1：「每位员工」的范围**
  - 只算本人能看见的、内置的普通员工，分身（`avatar-`）和远端员工（`remote_*`）不算。理由：
    - 分身的连接器来源只写只读工具，移除来源就收回；
    - 远端员工是本人不控制的外部端点。
  - 个人版里 `DELETE /for/:agentId/apps/:app/give` 先过 `personalRevokeRefusal`，答 403，不会答「已收回」然后悄悄还原。
- **I2：保持上游语义，改个人版的默认**（按协调方裁定）
  - 个人默认在给出第一个工具之前，用 `onConflictDoNothing` 替还没做过选择的人写下 `approval_preferences.enabled = true`，并记一行由部署发起的 `approval.settings_changed`（`change: ask_before_changes_personal_default`）。
  - 选过的人保留原值；团队版不写。
  - 没有改 `PERSONAL_PREFERENCES` 这个常量，原因是原有测试 `approvals-edition-defaults` 钉住了「没做过选择的人在个人版里默认不问」。所以用「个人默认第一次给工具时写下这一行」来达到同样的默认效果，那条原有测试仍然成立。
  - 注释、本报告和 PR 正文里「一按只给只读」的说法已经改正。
- **M1**：启动时清掉已删除员工的「技能已给过」键。没有挂到删除员工的路径上，因为那要改员工存储，超出文件数上限。PR 里写明了这张表是部署级、没有 RLS 的，以及为什么可以接受。
- **M2**：批准里的刷新带 `reRegister: false`。PR 里写明团队版的批准会先刷新一次。
- **M3**：
  - 「打开但不授予」带 `opened: true`；
  - OpenBot 自己的技能授予记为部署发起（`grant` 遇到 `openbot:` 开头的 `by` 时）；
  - 运行时把员工带回自动学习也写轨迹（`withPersonalDefaults` 的第三个参数）。
  - 刷新时授予记录里的 `actor` 是按下的人的 id，不是邮箱。这和上游一致：列工具要用这个 id 去选凭据，所以没改。
- **M4**：
  - `listForAgent` 的补齐失败只记警告，运行照常；
  - 学习设置先不加锁地查一遍，只在确实有被排除的员工时才 `UPDATE ... FOR UPDATE`。
- **M5**：Parallel 是境外第三方搜索，并且 X4 之前就手动删掉过 Parallel 的部署，升级后会再加回一次。这两点已写进 PR，没有改代码。
- **M6**：工具只取那一行列出的；授予前缀改用 `split_part` 精确匹配。
- **M7**：团队版启动时，如果还留着 `granted_by` 以 `openbot:` 开头的授予，就提醒运维核对（`personalGrantsLeftInTeam`）。只提醒，不删除。
- **M8**：并入 I1。
- **M9**：留作跟踪项。M5a 合入后，`admin/controls.ts` 接成 `builtIn = alwaysOnHere(server)`。
- **X3 后续修复**：4031fee9 已经 merge 进 `-1`。0197 改过，所以 `openbot_x4` 已重建。

新增或扩展的测试：

| 文件 | 用例数 | 说明 |
| --- | --- | --- |
| `personal-defaults-boundaries.integration.test.ts` | 12 | 新增，不带实现时 10 个红 |
| `personal-plugin-defaults.test.ts` | +1 | 补齐失败不影响运行 |
| `app-access-connect-before-tools.integration.test.ts` | +2 | `reRegister:false` 与 `opened` |

回归：229 个文件，4015 个通过。其余失败都是基线上就有的环境问题。



## 复核（x4-rereview.md）后的修正

- **R1**：收回按员工判断。`personalRevokeRefusal(kind, ref, bot?)` 只对个人默认管着的员工（内置、非分身，`coveredByPersonalDefaults`）拒绝。
  - 两个收回路由经 `personalRevokeRefusalFor` 读出员工类型后再判断；store 新增 `agentType`。
  - 分身和远端员工在个人版里也能单独收回，收回后不会被补回。
  - 个人版的 `botsReachableFrom` 也只在这个范围内互相可达。
- **R2**：`app-access-routes.ts` 文件头和一按路由的注释写明「团队版」，并补一句个人版的情况。
- **R3**：
  - 个人版启动时无条件写一次（`ensurePersonalAskBeforeChanges`）。
  - `withPersonalDefaults` 包装了 `grant`：任何一条给员工应用动作的路径都先写下「改动之前先问」，写不进去就抛出、不授予，失败闭合。
  - 包导入只授予技能，不经过这里。
  - 测试覆盖管理员手动授予、主人给、写入失败三种情况。
- **R4**：`forgetDepartedBots` 不再清包里带来的员工（`agents.package_id` 非空），导入复活后本人关掉的技能不会回来。有测试。
- **R5**：偏好表没有按字段记录「是否设置过」，所以列为已知边界，写在 PR 正文里。
- 新测试 `personal-defaults-scope.integration.test.ts` 共 12 个，不带实现时 10 个红。为了不改 X4 第一版的测试，`personalRevokeRefusal` 的员工参数是可选的。
- 回归：230 个文件，4027 个通过。其余失败都是基线上就有的环境问题。

最终 head：#439 8a9b28aa，#440 60c1cfca。

---

## X5 报告：Arcade 连接器（第二个连接应用提供商）

## PR（依次叠加，均为草稿）

| PR | 分支 | base | 内容 |
| --- | --- | --- | --- |
| #429 | feat/align-x5-arcade-1 | feat/align-x1-accounts-4 | 传输层 `arcade.ts`、提供商选择 `provider-wiring.ts`、config、access/transport 注册 |
| #432 | feat/align-x5-arcade-2 | -1 | `arcade-adapter.ts`（SDK）、`ArcadeBroker` 类型、桥接 `asComposioBroker`、`vendor-deadline.ts`、依赖 |
| #434 | feat/align-x5-arcade-3 | -2 | 迁移 0192、`arcade-attempts.ts`、store 按提供商参数化、vendor_name |
| #435 | feat/align-x5-arcade-4 | -3 | `arcade-routes.ts`（连接 / 回程验证 / 取消 / 断开级联）、routes/index/app/account-mode 接线 |

每个 PR 非测试文件 ≤ 12（-1：9；-2：7；-3：8；-4：7）。-3、-4 通过 merge 跟上前一层（没有 force push）。

**不设 `OPENBOT_BROKER_PROVIDER` 时行为不变**：只配 `COMPOSIO_API_KEY` 时构造的仍是以前那个 Composio 客户端；配置对象里不出现 `arcadeApiKey` / `brokerProvider`；store 不给 `brokerProvider` 时命名与写入语句与以前一样。新增的唯一启动动作是 `assertActivatable` 计数（放进 `refreshOwnListings` 原有的平台帧里，不新增平台入口）。

## 迁移

- **0192_arcade_provider**（overlay `recovery-20261018-v1/sql`，journal `when` 1794324710665，大于 0181 的 1794318911781；0182–0191 未占用，未与 M5 0176–0179、X6 0186、X2 0187 冲突）：
  - 新表 `pending_authorizations`（上游 0057）：tenant_id、ENABLE + FORCE RLS、四条 tenant_isolation、GRANT openbot_app；上游四条 CHECK 原样；外键 actor_id → users、server_id → mcp_servers，均 CASCADE。
  - `mcp_tools.vendor_name text`（可空，NULL = 同 name，不回填）。
  - `composio_connections.provider text NOT NULL DEFAULT 'composio'` + CHECK composio/arcade。
  - `brokered_accounts_provider_check` 放宽为 composio/arcade。

## 接口（给前端会话）

- `POST /api/plugins/servers/:id/connect`（Arcade 应用，个人或团队账号）→ `{ authorizationUrl }`。同一人同时只有一次进行中的授权（409）；Arcade 下 `?another=1` → 409（中文，暂不支持第二个账号）。
- `GET /api/plugins/arcade/verify?flow_id=…`（Arcade 项目的自定义用户验证地址；浏览器跳转，不是 API）：
  - 没登录 → 303 `${appUrl}/sign?flow_id=…`（前端 `app/src/lib/auth/resume.ts` 已会送回）。
  - 成功 → 303 `${appUrl}/settings/connected-accounts/<serverId>`。
  - 失败 → 303 `${appUrl}/settings/connected-accounts?authorized=<原因>`；原因：`no-broker`、`missing-handle`、`no-attempt`、`vendor-unavailable`、`not-your-authorization`、`not-finished`、`authorization-failed`、`not-permitted`、`cancelled-left-live`、`not-recorded`。前端需要把这些原因换成中文提示。
  - 会话被认出但被拒（非 401）→ 403 `{ error }`（中文）。
- `DELETE /api/plugins/servers/:id/authorize` → `{ cancelled: boolean }`；已经完成的 → 409 `{ error }`。
- `DELETE /api/plugins/servers/:id/connection`（Arcade）→ `{ vendorRevocationRequested, siblings: string[] }`（`siblings`：同一认证提供商下厂商也已结束、本地行一并结束的应用；只在 Arcade 时出现）。
- `PUT /api/plugins/composio/clients/:slug` 在 Arcade 时 → 409（中文：部署 OAuth 客户端只适用于 Composio，#950）。
- 其他已有接口（`GET /plugins`、`/composio/apps` 目录与启用、`/connections`、账号模式、确认 / 重查）对 Arcade 应用照常工作：应用 id 为 `arcade-<Toolkit>`（大小写保留），url `arcade://<Toolkit>`，provenance / vendor 为 arcade / Arcade。

## 环境变量

- `ARCADE_API_KEY`；`OPENBOT_BROKER_PROVIDER=composio|arcade`（其它值拒绝启动）。指明了却没 key、或两个 key 都配了却没指明 → 拒绝启动（只说变量名）。另一边仍持有连接时拒绝启用（`assertActivatable`）。
- Arcade 时验证地址为 `${OPENBOT_PUBLIC_URL 或 BETTER_AUTH_URL}/api/plugins/arcade/verify`；单用户安装每次授权前把项目验证地址指向自己，要登录的部署只检查、启动时打印需要管理员设置的地址。

## 安全规则（都有测试）

- 验证地址不能被冒用：只完成回来的会话自己的尝试；厂商确认 flow 属于尝试账号（`confirmUser`，不符答 mismatch）、确认回来的授权 id = 尝试绑定的 mint id、状态 completed、完成用户 = 尝试账号，缺一不记（`arcade-verify.integration.test.ts`）。
- 回调绑定发起人：别人的会话、没会话、取消后、重放都记不下；完成在事务里只成功一次，审计写不进则连接也不写（`arcade-completion-transaction`）。没有 mint id 的尝试永远完成不了；迟到 / 重复的 mint 不能改绑（`arcade-attempt-store`）。
- 断开级联：同一认证提供商、厂商也说已结束的兄弟应用一并结束本地行（经 `disconnectBrokered`，各自审计）；别的提供商不动；问不到的留着。
- 厂商错误不外带：SDK `APIError` 不出 adapter（`ArcadeFailureError` 丢掉厂商原话）；调用结果只取 `output.value`，带授权信封的回答按拒绝处理；回程只带原因词；回程日志不带厂商回答（测试塞入链接与令牌验证）。
- 调用：没有连接行的人在厂商之前被拒（`arcade-store-call`）；执行时发 `vendor_name`，模型只看到合法名字。
- 成员看到的句子不点名 Arcade（`NAMES_THE_BROKER` 扩为 composio|arcade，#1223）。
- `arcade-` 名字空间对按地址添加的服务器保留。
- `pending_authorizations` 行安全：别人读不到（测试）。
- 审批底线（policy.ts 等）、check-in 只认可靠读、凭据入保险箱均未改动；Arcade 调用走 fork 原有的同一条 `callTool` 闸门与审批。

## 与上游的差异与原因

1. **依赖**：brief 说 fork 已有 `@arcadeai/arcadejs@2.4.1` 依赖、`config.ts` 解析、`checklist.ts` 的 `BROKER.arcade`、`shared/tool-name.ts` 的 `arcade-` 前缀、`test:live-arcade` 等残留——在 main、M5、X1 上都**不存在**（`shared/tool-name.ts` 只在 M5 上，且 `BROKER_PREFIXES` 只有 composio-）。按上游同版本加入 SDK（零传递依赖），`bun.lock` 只多两行（workspace 依赖 + 包条目，沿用 npmmirror 地址），根 package.json 加 `test:live-arcade`。这违背了「不加依赖 / 不改 lockfile」的字面，但不加就得自写厂商客户端、上游 adapter 测试（打 SDK 原型）无法带过来。如不接受，可改为自写客户端。M5 合入后需在 `shared/tool-name.ts` 的 `BROKER_PREFIXES` 加 `"arcade-"`、`setup/checklist.ts` 加 Arcade（X5 未改这两处，因为基线上没有这些文件 / 条目）。
2. 连接存储：个人连接仍在 fork 的 `composio_connections`（新增 provider 列），团队账号在 X1 的应用行 `shared_*` 列，而不是上游的 `brokered_connections`。主键不变：同一时间只有一个提供商写入（启动检查保证）。
3. 上游的 `ConnectedAppBroker` 在 fork 叫 `ArcadeBroker`（用 X1 的 `AccountRef`），由 `asComposioBroker` 桥接到 fork store / 路由的 `{ userId }` 形状；桥接的 `authorize` 不交出 mint id，Arcade 的连接只能走带发起人绑定的尝试。
4. 「上下文变了」（应用切共享、团队身份换了、不再是管理员）与「取消后才完成」**不在厂商那边撤销**，只结束为未对账 / 审计 `mcp.cancelled_grant_left_live` 并告诉人。上游会在能判断不连带其他应用时撤销；fork 没有上游那层兄弟应用解析，撤销 Google 授权会连带同一提供商的其他应用，故保守处理。
5. 未带：单个动作授权 `POST /servers/:id/authorize`、授权清单 `GET /servers/:id/grants`、一个人的第二个 Arcade 账号（`<id>~<suffix>`，fork 调用按 Composio account id 钉账号，Arcade 需另接）、单用户部署的独立厂商身份（#927 / `brokered_identities`：对 Composio 生效会改变默认行为）、`actionNotAllowed` 的「重新连接」卡片（目前只作为失败文字给模型）、Arcade 下移除应用时的兄弟级联、M5 的 relist 对 Arcade。
6. 文案：成员会看到的句子为中文；transport（`arcade.ts`）的句子译为中文；adapter 给运维 / 管理员的句子与 fork 的 Composio adapter 一样保留英文（路由层不点名提供商）。
7. 上游 `provider-undecided` 第三组（无 broker 时路由按存储的提供商读行）未带：fork 路由在没有 broker 时按 Composio 解析。

## 测试

- 上游 48 个 arcade 相关测试中带过来并按 fork 接口改写：transport 层 6 个、provider 2 个（`provider-undecided` 前两组）、adapter 层 21 个（含 `arcade-live`，按上游条件无 key 跳过）、存储层 4 个（attempt-constraints、attempt-store、completion-transaction、provider-check）。新增 `arcade-config`、`arcade-composio-bridge`、`arcade-store-call`、`arcade-verify`（覆盖上游 verify / authorize-cancel / disconnect-cascade / disconnect-route 的要点）。
- 未带：`arcade-verify.test.ts`（2150 行，依赖上游 app 全量接线，要点已在 `arcade-verify.integration` 重写）、`arcade-authorize-route`、`arcade-grants-route`、`arcade-journey`、`arcade-single-user-identity`、`arcade-verifier-address`、`arcade-multiple-accounts`、`arcade-siblings`、`arcade-sibling-collateral`、`routes-arcade-urls`、`arcade-disconnect-cascade` / `-route`（逐字版本，依赖上游 store / 表），`shared-use-arcade-urls`（留给 X3）。
- 改动的原有测试：只有 X1 的两条（未合入 main，X1 当时注明「X5 放宽」）：`shared-accounts.test.ts` 里 arcade 有账号、`brokered-accounts-schema` 里改用不认识的提供商。main 上的原有测试一行未改。
- 本地：Arcade / provider 测试 556 pass、12 skip；插件 / composio / 审批 / 主动提醒 / 迁移 / RLS / 团队 Bot / tenant 相关 209 个文件 3782 pass，0 失败（另 4 个是本地缺一次性库模板的环境错误，与改动无关）。`tsc` 干净；测试类型门禁只报本地缺 @xterm；改动文件 biome lint（--error-on-warnings）与 format 干净。CI：#432 首次 server-test(1) 因 assertion-shape 门禁失败，已按 fork 断言形状改写三处（b8a3605c）并合并到 -3、-4；最终四个 PR 的 CI 全部通过（-1 f5b7b577、-2 b8a3605c、-3 29f325fd、-4 9a97b879）。

---

## 评审修复（x5-review.md：Critical 0，Important 3，Minor 5）

head：-1 `0b27278b`，-2 `5788d89e`，-3 `683a3d1d`，-4 `c6293335`。仍是 merge，没有 rebase，也没有强推。

### I3 基线过时（先做）
- 把最新的 `origin/feat/align-x1-accounts-4`（bfec22fa，X1 评审修复 C1、I1、I2、M2–M6、N1）合进 -1，再逐层合到 -2、-3、-4。合并没有文本冲突，只有 `server-tests.list.txt` 要重新生成。
- 评审提到 store.ts 里过时的 `STRICTEST_APPROVAL` 注释，合并后已经不存在：X1 的版本已改为团队账号调用一律拒绝。
- Arcade 的连接和调用都走 X1 的 `requireTeamAccountWriter` 与 `callTool` 共享账号闸门，合并后同样生效。
- 合并后 `brokered-multiple-accounts`、`shared-brokered-accounts`、`brokered-accounts-schema` 和全部 arcade 测试都通过。

### I1 团队账号的遗留授权
- **团队账号**，以下两种情况都在厂商那边撤销：
  - 取消之后同意才完成；
  - 回程判定「不再允许」（应用改了账号模式、团队身份换了、没有管理员能力了）。
  - 撤销后尝试结束为 `withdrawn`。撤销失败才落回「未对账」加审计。
  - 原因：团队身份每个应用、每次切换都随机铸一个，撤销不会连带别的应用。
- **个人账号**：维持只留痕。撤销会连带本人在同一认证提供商下的其他应用。
- **取消的写法改了**：已经拿到链接的尝试，取消时结束为 `withdrawn`，不再删除行。这样回程（`withdrawnAttemptFor`，15 分钟内）还能认出「取消后才完成」的同意：
  - 团队账号：撤销，回程原因为 `cancelled`。
  - 个人账号：留痕（`mcp.cancelled_grant_left_live`），回程原因为 `cancelled-left-live`。
  - 没拿到链接的尝试仍然直接删除。`DELETE /servers/:id/authorize` 的响应不变。
- **Arcade 下的「确认 / 重新检查」只刷新已有连接，不新建**：
  - `confirmBrokeredConnection` 在没有连接行时答 `{ connected: false }`，不写任何东西。
  - `confirmSharedConnection` 在团队账号还没连接时同样答 `{ connected: false }`。团队账号的重新检查走的也是它。
  - 新的连接只能经 `/arcade/verify` 记下。Composio 不受影响。
- 测试：`arcade-team-account.integration.test.ts`，先写，5 条全红，修复后转绿。

### I2 单用户安装
- 在 #927 并入之前，`selectProviderWiring` 遇到单用户安装（含个人版）加 Arcade 时拒绝启动，并给出中文说明（建议改用 Composio，或以需要登录的方式部署）。
- 因为根本不构造客户端，验证地址也就不会被改写。Composio 的单用户安装不受影响。
- 测试：`arcade-single-user.test.ts`，先红后绿。
- 没有只为 Arcade 移植 `ensureSingleUserIdentity`，原因：
  - 那需要新表 `brokered_identities`（又一处迁移和 RLS）、启动时铸名，还要让 vendor id 在桥接层、传输层的 `execute` 和授权尝试三处统一替换。
  - 改动面和风险都明显大于直接拒绝。
  - 单用户 Arcade 用户等 #927 一起并入更稳妥。

### Minor
- **M1（已修）**：0192 加 `CONSTRAINT pending_authorizations_tenant_is_actor_check CHECK (tenant_id = actor_id)`，drizzle schema 同步。
  - 这比 0153 的 `NOT IN ('system','platform','team')` 更严，也让只以 `actor_id` 为主键成为安全的选择。
  - 约束测试新增一条。原有的 store 测试改为在发起人的帧里认领尝试，与请求守卫的行为一致。
  - 迁移编号和 journal `when` 都没变：0192 还没有合入任何库。
- **M2（已修）**：回程判断团队账号写入改用 `store.requireTeamAccountWriter()`（管理员能力），不再看会话里的角色。降权的管理员在回程被拒，团队授权被撤销。由「降权后完成」那条测试覆盖。
- **M3（未修）**：个人的遗留授权让本人再按「连接」时得到 503，提示「你的账号已经允许…」。可选的两种修法都不合适：
  - 按评审建议用 `held` 经「确认」记下：会重新打开 I1 刚关上的「不经回程验证就记下」的路径。
  - 在厂商那边撤销：会连带本人同一认证提供商下的其他应用。
  - 授权是本人自己的，不算越权。留到上游兄弟应用解析那一层并入时，再一起做「在厂商那边撤销」的入口。
- **M4（已修）**：`mcp.ts` 里 `actionNotAllowed` 的注释改为如实说明：store 尚未接上，只当作失败处理。
- **M5（就地小修）**：授权铸造结果不明（`arcade-mint-outcome-unknown`）和团队授权撤销失败时，日志只记错误类名，不记 message。
  - `vendorCall` 本身没改：它对 SDK 错误已经转成本部署自己的句子；对非 SDK 错误改写会影响上游 adapter 测试锁定的行为。

### 依赖
`@arcadeai/arcadejs` 2.4.1 已由协调方裁定接受：与上游同版本，integrity 相同，没有传递依赖，符合用户「与上游一次性对齐」的标准。偏离 brief 的原因见上文「与上游的差异」第 1 条。

### 测试（修复后，-4）
- Arcade 与 provider 测试：601 通过，12 跳过（`arcade-live` 没有 key）。
- 插件、审批、主动提醒、迁移、RLS、团队 Bot、tenant、assertion-shape 相关 212 个文件：3817 通过，0 个用例失败。另有 4 个是本地缺一次性库模板的环境错误，与改动无关。
- `tsc` 干净；测试类型门禁只报本地缺 @xterm；改动文件的 biome lint 与 format 干净。

### CI（修复后）
四个分支全部通过。-3（683a3d1d）第一次跑时 `desktop tests (windows-latest)` 连不上 127.0.0.1:3010，这个作业测的是桌面端，本次没有改桌面代码；重跑一次后通过。-4 包含相同改动，一次就通过。

---

## 复核修复（x5-rereview.md）

改动都在 `arcade-routes.ts` 和它的测试里，这两样只存在于 -4，所以只提交到 -4（`dabcaa88`）。-1、-2、-3 不变（`0b27278b` / `5788d89e` / `683a3d1d`，CI 已全绿）。没有 rebase，也没有强推。

1. **撤销答 false 不再算撤回**：竞争路径上 `leftoverGrant` 现在只认 `revoke` 答 `true`。
   - 答 `false`（没找到可撤的连接）和抛错一样，都如实留痕：日志写 `arcade-team-grant-not-withdrawn`，审计写 `mcp.cancelled_grant_left_live`，回程原因为 `cancelled-left-live`。
   - 测试：「撤销抛错」「撤销答 false」先写。答 false 那条是红的；抛错那条修之前就是绿的，原本的实现已经正确。另补一条「撤销成功」。
2. **文件头注释**：按现在的行为改写。团队账号撤销，个人账号只留痕，原因都写明了。
3. **回程先判「已取消 / 不再允许」，再调 `confirmUser`**（复核建议，已做）：
   - 在自定义验证地址模式下，正是 `confirmUser` 让同意生效。所以现在这两种情况一次都不确认，遗留授权根本不会出现，团队账号和个人都一样。
   - 「不再允许」的尝试结束为 `withdrawn`，日志写 `arcade-completion-not-permitted`。
   - 原来那段 `not-permitted` 分支里的撤销代码删掉了，那里已经没有可撤的东西。
   - 遗留授权只剩一种来源：回程进行中尝试被取消的竞争。它走第 1 条的撤销加留痕。
   - **改到的测试只有 X5 自己写的 4 条用例**（`arcade-verify.integration` 2 条、`arcade-team-account.integration` 2 条），都是在 X5 期间按旧顺序写的期望。现在它们改为断言：不调用厂商确认、不撤销、尝试结束为 `withdrawn`，原因分别是 `cancelled` 和 `not-permitted`。main 和 X1 的原有测试一行没动。
   - 我把指令里的「原有测试」理解为 main/X1 上本来就有的测试，所以做了。如果「X5 自己的用例也算」，可以回退这一条：顺序改回去，第 1、2 条照样成立。
4. **M3 的情形大幅缩小**：取消后才完成、降权后完成，都不再产生个人遗留授权。只剩竞争那一种，仍然只留痕。

测试：Arcade 相关、插件、审批、账号、tenant、assertion-shape 共 172 个文件 3221 通过，0 个用例失败。另有 4 个本地环境错误：缺一次性库模板，与改动无关。`tsc` 干净，测试类型门禁只报本地缺 @xterm，biome 干净。

CI：-4（dabcaa88）通过；-1、-2、-3 的 head 未变，CI 均为通过。

---

## X6 报告：Entra 代表用户调用（上游 #931，Microsoft OBO）

- PR：#426（草稿，base `main`），分支 `feat/align-x6-entra-obo-1`，只有一个 PR，没有拆分。
- 迁移：**0186_entra_scope**（overlay `openbot/server/recovery/recovery-20261018-v1/sql/`）。动手前 main 上 overlay 的最大编号是 0174；M5a 占 0175–0178，X1 占 0180–0185，没有冲突。journal 里 `when` 用的是写入时的毫秒数（1794320400721），大于 overlay 现有的最大值。只加一列，不建新表，所以不需要新的 RLS 或 GRANT（这一列跟着 `mcp_servers` 现有的 tenant_id 和策略走）。
- 本地 worktree 在 `.../scratchpad/wt-x6`（node_modules 软链到 wt-p9），库是 `openbot_x6`（用 main 的迁移新建）。

## 现状对比：fork 原本已经有什么
上游同步会话当初已经把 #931 的**登录这一半**完整搬了过来，和 `upstream/main` 逐字节相同：
- `server/src/auth/entra.ts`、`server/src/auth/entra-refusal.ts`
- `config.ts`：`apiScope`、`allowedClients`（`MICROSOFT_OAUTH_API_SCOPE` / `MICROSOFT_OAUTH_ALLOWED_CLIENTS`），配置测试也在
- `auth/index.ts`：`vouchesForMicrosoftToken` / `verifyIdToken`
- `index.ts`：`createEntra` + `withEntraBearer`（外层再包了一层 asPlatform 帧）
- `server/package.json` 里已经有 `"jose": "^6.2.10"`，lockfile 不用改
- `.env.example` 和 `docs/configuration.md` 里已经有这两个配置项和整节说明

**登录流程没有改。** 本 PR 只补插件存储这一半（之前标着 `M3: ... not adopted`）。

## 新接口形状（给前端会话对接）

### `POST /api/plugins/servers/custom`（管理员）
请求体：
```json
{ "id": "hr", "title": "HR", "url": "https://hr.example.com/mcp", "credentialId": "可选", "entraScope": "api://hr-api/.default" }
```
- `entraScope`：
  - 字符串：标记为「以登录人身份访问」
  - 不传：保留现有标记（应用里「按 URL 添加」的请求不发这个字段，重新添加时不会把标记清掉）
  - `null`：取消标记，改回用部署凭据
- 400 `{ "error": "Entra scope 必须是非空字符串；传 null 表示不再以登录人的身份访问这个服务器。" }`：`entraScope` 是其他类型或空串
- 400 `{ "error": <中文> }`，存储层拒绝时：
  - 没配置 Microsoft 登录：`还没有配置 Microsoft 登录，所以不能把服务器设为以登录人的身份访问。请先设置 MICROSOFT_OAUTH_CLIENT_ID 和 MICROSOFT_OAUTH_CLIENT_SECRET。`
  - 同时带了 scope 和 token：`以登录人的身份访问的服务器使用本人的 Microsoft 登录，不收令牌。`
  - 已标记的服务器只带 token 重新添加：`<id> 以登录人的身份访问，不收令牌。要改用令牌访问，请同时把 entraScope 设为 null。`
  - scope 带空白或超过 256 字符：`请只填一个 Entra scope，例如 api://hr-api/.default。`
  - 已标记的服务器换地址：`<id> 以登录人的身份访问，已经在另一个地址。要换地址，请先移除再重新添加。`
- 200 `{ "server": ServerRecord }`

### `ServerRecord` 新字段（`GET /api/plugins/servers` 等所有返回服务器的地方）
- `entraScope: string | null`。类型上标的是可选，这样已有测试里手写的 ServerRecord 字面量不用改；`listServers` 实际总会返回这个字段。前端可以照上游的做法，在服务器页面上用「以登录人身份访问 + scope」替换「访问令牌」那一行（上游 `app/src/routes/_authed/admin/plugins/$key.tsx`，前端由同步会话负责）。

### 工具调用失败时本人看到的文字（`Refused. ` + 句子）
| 情况 | 句子 |
|---|---|
| not-admitted | 你已经不能使用 OpenBot，所以没有使用「X」。 |
| no-sign-in | 「X」要用你的 Microsoft 账号，但 OpenBot 还没有你的 Microsoft 登录。请先在浏览器里用 Microsoft 登录 OpenBot 一次，再重新提问。 |
| sign-in-expired | 你的 Microsoft 登录已过期，所以没有使用「X」。请重新用 Microsoft 登录后再提问。 |
| no-consent | 管理员还没有在 Microsoft Entra 里授权 OpenBot 访问「X」。请联系管理员授权。 |
| no-api-consent | OpenBot 在 Microsoft Entra 里还没有获得对它自己 API 的授权，所以无法以你的身份访问「X」。请联系管理员授权。 |
| no-api | OpenBot 在 Microsoft Entra 里还没有设置好，无法以你的身份访问「X」。请管理员在那里公开 OpenBot 的 API。 |
| refused | Microsoft 不允许 OpenBot 以你的身份访问「X」。请稍后再试；如果一直这样，请联系管理员。 |
| 这次运行没有归属到任何人 | 「X」以提问人的身份访问，而这次运行没有归属到任何人。 |
| 部署没配 Microsoft 登录，库里却有已标记的服务器 | 「X」需要 Microsoft 登录，但这里还没有配置。请联系管理员配置。 |

### 入站 Bearer（fork 已有，未改）
任意 API 或 agent 请求都可以带 `Authorization: Bearer <Entra access token>`，校验规则见 PR 正文。

## 改动的文件（11 个非测试文件，不超过 12）
`CHANGELOG.md`、`docs/configuration.md`、`scripts/ci/server-tests.list.txt`、overlay 的 journal 和 `0186_entra_scope.sql`、`db/schema/plugins.ts`、`index.ts`、`plugins/access.ts`、`plugins/entra-access.ts`（新增）、`plugins/routes.ts`、`plugins/store.ts`。
测试：新增 `tests/entra-access.test.ts`、`tests/entra-obo-servers.integration.test.ts`。

## 与上游的差异和原因
1. **结构**：上游把插件存储拆成了 `plugin-store/{context,model,servers}.ts` 和 `route-groups/servers.ts`，fork 还是单个 `store.ts` 和 `routes.ts`。规则和中文说明都放进新文件 `plugins/entra-access.ts`，`store.ts` 只做接线，减少和 M5a、X1 的冲突。
2. **中文**：上游的英文原句全部改成中文（见上表），意思逐条对应。
3. **已标记的服务器不能换地址**（fork 新增，守安全底线）：fork 已经有「凭据只在交给它的地址上用」这条规矩。标记后每次调用带的是本人在该系统里的 token，如果改了 URL，就是把每个人的 token 送到新地址。所以要先移除，再重新添加。
4. **`accessFor` 只对 custom 行认 `entraScope`**：上游只要有值就生效。fork 收紧到 custom 行，避免目录条目或 broker 行上的残留值把已审过的 vendor 或共享密钥改成别人的 Entra token。
5. **`ServerAccess` 没有 `ownCredential`**（fork 本来就没有这个字段），所以 `person-entra` 也没加。
6. **`ServerRecord.entraScope` 在类型上是可选**：为了不改已有测试（`plugin-routes.test.ts` 里有手写的字面量）。
7. **上游测试的改写**：fork 的 `entra-obo.integration.test.ts` 已经带了上游的前半部分，按「原有测试一行不改」的要求，后半部分写进了新文件 `entra-obo-servers.integration.test.ts`。新文件复制了替身 Entra 和 MCP 的测试脚手架，端口改成 7485/7486，并按 fork 的接口做了调整：
   - 例行任务的调用在本人的帧里执行
   - 插件存储拿到的 entra 是包了 asPlatform 帧的版本（和 index.ts 一样）
   - 系统 Bot 的授权写在 `system` 帧
   - 部署凭据用 v2 信封封在 `team`
   - 注入 `outboundLookup`，让 SSRF/DNS 校验留在调用路径上

   另外补了几条用例：审计里没有 token、URL 改动被拒、scope 不合法被拒、没归属的运行不会去问 Entra、没配 Entra 的部署对已标记服务器的调用会被拒。
8. **没改** `entra-obo.integration.test.ts` 末尾那段过时的 M3 注释（「这些用例没保留」）。它属于原有测试文件，留给以后清理。

## 测试摘要
- 新增 41 个用例，全部通过。先红后绿：实现前集成测试 21 个里有 14 个失败。
- 本地跑了 plugin / composio / approval / proactive / catalogue / entra / config / team-bot / mcp / recovery-overlay 等 127 个文件，2790 个通过、4 个失败。另外 RLS / tenant / recovery / memory / g01 共 39 个文件、520 个全部通过。那 4 个失败都是 approval-*-transaction 一类测试需要一次性模板库（`TEST_DATABASE_TEMPLATE`/`TEST_DATABASE_BYPASS_URL`），本地没有，和本改动无关。
- `bunx tsc --noEmit` 干净；`typecheck-tests` 只报本地缺 `@xterm`；改动文件 `biome check` 干净。
- CI 结果见文末。

## 顾虑
- **check-in 不读已标记的服务器**：fork 的 check-in 只读本人自己连接过的应用，标记的服务器没有连接行。docs 里写明了。如果希望 check-in 也能读，需要在 `ownConnections` 里算上 person-entra 服务器，这件事要另外评估。
- **Team Bot**：对已标记的服务器，`credentialActorFor` 返回提问人本人，不会弹「使用你自己的账号」的同意卡（和上游一致）。系统看到的是提问人，只能拿到提问人有权限的内容，没有削弱底线，但和 fork 对个人 OAuth 连接的做法不同，产品上可能需要确认。
- **多副本**：OBO token 缓存在各进程的内存里（上游设计，fork 已有）。两个副本可能同时轮换 refresh token，后写入的那个生效；Entra 的旧 refresh token 在过期前仍然有效，所以不会把人锁在外面。
- **合并顺序**：M5a 合入后需要把本分支合上 main（merge）。冲突点可能在 `store.ts` 的 import 区、`routes.ts` 的 `/servers/custom`、`index.ts` 的 `createPluginStore` 参数，都是小块接线。X1 也改 `db/schema/plugins.ts`（在 catalogueKey 之后加列），和本 PR 加列的位置不同。

## CI
- 第一轮（da73f484）有两个失败：
  - server shard 1：`assertion-shape` 守卫的 (c) 规则抓到 `entra-access.test.ts` 里 3 处 `toEqual` 期望值写了 `undefined`。已改成把「没写明」「没有 scope」读成词再比较，提交 049c11b4。
  - desktop windows：日志判定为 Infrastructure/import failure，和本 PR 无关（没改 desktop），这个任务在其他分支上都是绿的。
- 第二轮（049c11b4）**全绿**。
- 交付时 M5a 还没合进 main（origin/main 仍是 7ab12de0），所以没有需要合并的内容。M5a 合入后要把本分支 merge 上 main 再推。

## 评审后修复（对应 x6-review.md）

提交在 `feat/align-x6-entra-obo-1` 上（d47a5bcb），没有 force-push。修完后非测试文件到了 12 个的上限，所以文档拆到叠加的 **#430**（`feat/align-x6-entra-obo-2`，base 是 `-1`，head c10d7725）：`docs/configuration.md` 补充了绑定规则和 fork 差异，`.env.example` 加了 `MICROSOFT_OAUTH_OBO_RESOURCES`。#426 里的 `docs/configuration.md` 已退回 main 的版本。

### I-1 Team Bot 同意卡（已修）
- 改动在 `team-bots/team-bots.ts`。新增 `reachedOnOwnSignIn(serverId)`，判断条件是 `mcp_servers` 里 custom 行且 `entra_scope` 非空。
- `credentialActorFor`：标记的服务器跳过「Bot 主人连接过就用主人的账号」这一步，因为主人从没连接过它，只是登录了而已。也跳过「提问人没连接过就直接用提问人」这一步。结果是一律要先查 `teamBotConsents` / `teamBotConsentDefaults`，没有同意就抛 `TEAM_BOT_CONSENT_MARKER` 卡片。
- `unaskedOwnAccount`（check-in）：标记的服务器同样不当作主人的账号，只有本人长期同意时才返回 true。check-in 本来就不读这类服务器，因为它们没有连接行。
- 新测试 `team-bot-entra-consent.integration.test.ts`（5 个），修复前其中 4 个是红的。覆盖：
  - 没有同意就弹卡；一次性同意只管一次；长期同意和跳过；对所有 Team Bot 同意。
  - 即使主人的连接里列了这个服务器，也不按主人身份访问。
  - Bot 主人用自己的 Bot、以及未标记的服务器，行为不变。
  - check-in 的判断。
- 没有覆盖的入口：`POST /api/plugins/call` 不经过 `credentialActorFor`。这个路由仓库里没有调用方，是本人直接点名调用工具，中间没有 Bot 指令，所以这里不弹卡，和 fork 对个人 OAuth 连接的现状一致。

### I-2 scope 的限制和对应关系（已修）
规则写在 `plugins/entra-access.ts`，测试见 `entra-access.test.ts`、`entra-obo-config.test.ts`、`entra-obo-servers.integration.test.ts`。

1. **资源登记**：新设置 `MICROSOFT_OAUTH_OBO_RESOURCES`，由能改部署配置的运维填写，格式是 `<资源>=<主机>`，多项用逗号隔开，例如 `api://hr-api=hr.example.com`。资源和主机都转成小写，资源去掉末尾的 `/`。没有设置时任何服务器都不能标记（失败闭合）。
2. **scope 的资源**：从 scope 去掉最后一段得到，例如 `api://hr-api/.default` 的资源是 `api://hr-api`。只写权限名的（`User.Read`，Entra 会解析成 Graph）、或者没有权限段的，一律拒绝。
3. **对应关系**：scope 的资源必须在登记表里，并且服务器 URL 的 hostname 必须和登记的主机**完全相等**，子域不算。标记时检查一次；每次调用前在 `entraTokenFor` 里再检查一次，对不上就拒绝，不会去问 Entra。登记被撤回后立即生效。
4. **永远拒绝**（scope 和登记都适用，登记里出现就启动报错）：
   - OpenBot 自己的 API：client id、`api://<client id>`，以及它们下面的任何子路径，还有 `MICROSOFT_OAUTH_API_SCOPE` 的资源。
   - Microsoft 第一方资源：形如 `0000000x-0000-0000-c000-…` 或 `0000000x-0000-0ff1-ce00-…` 的 app id（Graph、AAD Graph、SharePoint、Exchange、Dynamics、Power BI 等）；ARM、Key Vault、Azure Storage 的 app id；host 在 microsoft.com、microsoftonline.*、windows.net、office.com/net、office365.*、outlook.com、live.com、sharepoint.*、azure.*、chinacloudapi.cn、dynamics.com、powerbi.com、microsoft.us 及其子域下的 URI。
5. **`MICROSOFT_OAUTH_ALLOWED_CLIENTS` 不能包含 OpenBot 自己的 client id**，否则启动报错。这样评审里的路径 B（把 OBO token 重放回 OpenBot）从根上断掉。
6. 接线：`index.ts` 把 `resources`（登记表）和 `own`（`openBotResources(clientId, apiScope)`）交给插件存储。`EntraOnBehalf` 类型里这两项是可选的，缺了就按空处理，也就是任何 scope 都拒绝。之所以做成可选，是因为原有的 `entra-obo.integration.test.ts` 只传了 `createEntra` 实例。
7. **新接口和设置（给前端会话对接）**：
   - 新设置 `MICROSOFT_OAUTH_OBO_RESOURCES`。
   - `POST /api/plugins/servers/custom` 可能新返回这些 400 文案：
     - 「…没有写明资源…」
     - 「不能用 OpenBot 自己的 API 作为 Entra scope…」
     - 「不能用 Microsoft 的第一方资源…」
     - 「<资源> 没有登记在部署设置 MICROSOFT_OAUTH_OBO_RESOURCES 里…」
     - 「<资源> 登记的服务器主机是 X，和这个服务器的地址（Y）不一致…」
     - 「这个服务器刚被别人改过地址或访问方式…」（M-1）
   - 调用时可能新出现的拒绝文案：「「X」的 Entra scope 已经不在部署登记的范围里，所以没有发出。请联系管理员。」
   - 前端标记服务器时应该提示：只能选已登记的资源，主机要对得上。

### M-1 原子化（已修）
`addCustomServer` 的 `onConflictDoUpdate` 加了 `setWhere`：`url = excluded.url`，或者（库里当前没有 `entra_scope`、没有 `credential_id`，且这次写入也不带 scope 和凭据）。条件不成立时什么都不写，`.returning()` 为空，返回 `CustomServerRefusedError(MOVED_WHILE_ADDING)`。这一步同时覆盖了 fork 原有「凭据换地址」规则的同一个并发窗口。并发测试跑 6 轮 Promise.all，去掉 `setWhere` 会变红，加上后是绿的。

### M-2（部分修，说明理由）
- 花凭据的那一步改成了必填并且失败闭合：`connectionTokenFor` 的行参数里 `entraScope: string | null`（还有 `url`）是必填类型；运行时如果遇到没有目录条目、又没有带这一列的行，直接抛 `PluginInvariantError`，不会继续用部署凭据。所有花凭据的调用方（refreshTools、callTool）都是 `select()` 全列读的。
- `accessFor` 的参数和 `ServerRecord.entraScope` 仍然是可选，原因是改成必填就要改原有测试：`composio-access.test.ts:85` 用一个没带这一列的 custom 行断言结果是 `deployment-token`；`google-drive-rest.test.ts:125`、`plugin-store.integration.test.ts`、`composio-connections.test.ts` 传的行也没带这一列；`plugin-routes.test.ts` 里手写的 `ServerRecord` 字面量也没有它。按「原有测试一行不改」，这一项留给以后单独的 PR。`memory/ingestion.ts` 只用 `accessFor` 做分类判断，不花凭据，真正调用时会重新按全列解析。

### M-3（不改，按协调者安排）
0186 的 `when`（1794320400721）比 X1 的 0180/0181 大。合并顺序由协调者处理：X1 先合，必要时调整 0186 的 `when`。0186 是 `ADD COLUMN IF NOT EXISTS`，重新打时间戳没有影响。

### M-4（已修）
已标记的服务器换地址时，提示仍是「…以登录人的身份访问，已经在另一个地址…」；未标记的服务器在换地址的同时被标记，提示改成「<id> 已经在另一个地址。换地址时不能同时设为以登录人的身份访问，请先移除再重新添加。」

### M-5（已说明，未迁移）
- `entra-access.ts` 的头注释、CHANGELOG、#430 的文档都写明了：OBO access token 只在进程内存里；用来换取的 Microsoft refresh token 存在 Better Auth 的 `account` 表里，由 Better Auth 加密（`encryptOAuthTokens`，密钥跟着 `BETTER_AUTH_SECRET`），轮换后的值也按同样方式写回；它**不在** fork 凭据库的 v2 信封里，也不跟着 `KEY_ENCRYPTION_KEY` 轮换。
- 没有改成 fork 凭据库，原因是：这一行就是 Better Auth 的登录记录，它自己的登录、账号关联、`getAccessToken` 流程都直接读写这一列。迁走等于替换 Better Auth 的存储层，或者在两处各存一份再保持同步，成本和风险都不可控。

### 评审后的测试摘要
- 新增和改写的用例：
  - `entra-access.test.ts`：27 个
  - `entra-obo-servers.integration.test.ts`：27 个
  - `team-bot-entra-consent.integration.test.ts`：5 个
  - `entra-obo-config.test.ts`：6 个
  - 共 65 个，全部通过。
- 本地回归跑了 188 个文件：3605 个通过，5 个跳过，1 个失败。这个失败是 `approval-continuation-store` 需要一次性模板库，本地没配，起不来；CI 环境有这个配置。
- `tsc` 干净；`typecheck-tests` 只报本地缺 `@xterm`；`biome` 干净；`assertion-shape` 通过。
- 测试改动的准确说法：main 上已有的测试一行没动。本 PR 新增的 `entra-access.test.ts` 为配合 I-2（`decideEntraScope` 第三个参数从布尔值改成 `EntraBinding`）和 M-4（新文案）改过 13 行：11 行参数或换行、1 行夹具补 `url`、1 处期望值换成 M-4 的新拒绝句。没有删断言，也没有放宽。

## 复核后加固（对应 x6-rereview.md 的 N-1、N-2、N-3）

提交顺序：先在 `feat/align-x6-entra-obo-1` 上提交 **03d0d0a9**，再把 -1 合并（merge，非 force）进 `feat/align-x6-entra-obo-2`，在 -2 上补文档，得到 **2cc49209**。

### N-2：只发往 https（已加固）
- `scopeBindingRefusal` 要求服务器地址是 `https:`，否则返回「以登录人的身份访问的服务器必须用 https 地址，否则本人的 token 会被明文发出。请把地址改成 https 后重新添加。」。
- 加标记、沿用标记的重新添加（`decideEntraScope`）、每次调用前（`entraTokenFor`）用的都是这个函数。换地址本来就会被拒。
- 实测发现：fork 按 URL 添加服务器本来就只收 https（`catalogue.ts` 的 `customUrlRefusal`，提示「An MCP server must be reached over https.」，这句先于 scope 规则触发）。所以这一层主要防的是手工写入或旧数据里「已标记 + http」的行：这种行在调用时会被拒，也不会去问 Entra。测试：`entra-obo-servers` 里两条（http 添加被拒、库里已有的 http 行在调用时被拒），`entra-access` 里两条（http、ws 和非法 URL 都被拒，调用不会发出）。

### N-1：同意判断和发 token 用同一行（已加固）
- `callTool` 在 `person-entra` 分支里，用的是**发 token 的同一行**解析出来的 `access`。在 `connectionTokenFor` 之前先做两件事：
  1. `credentialActorId` 存在且不等于提问人时，一律拒绝：「「X」只以提问人自己的身份访问，不能借用别人的身份，所以没有发出。」。这样 Team Bot 规则在服务器被标记之前选中 owner 的情况也被堵住。
  2. 调用新的 store 选项 `entraConsent({ actorId, botId, serverId })`，也就是 `teamBots.ownSignInConsent`：Bot 是别人发布的 Team Bot 时，询问提问人是否同意，一次性同意在这里花掉，没有同意就抛同意卡。
- `credentialActorFor` 遇到已标记的服务器时只检查同意、不再花掉一次性同意（同意逻辑抽成了 `consentOrCard`），花掉统一放在发出那一步。这样即使管理员在两次读之间加了标记，发出时也一定会问。
- `index.ts` 负责接线。`teamBots` 在后面才创建，这里用闭包引用，只在请求运行时才会被调用。
- 测试：
  - `team-bot-entra-consent` 新增「判断之后才标记」的窗口用例：`credentialActorFor` 先返回队友本人，管理员随后加标记，`ownSignInConsent` 弹卡。
  - 原来的 allow_once 用例改成：`credentialActorFor` 放行，`ownSignInConsent` 花掉一次性同意，之后两者都拒绝。这个文件是本 PR 新增的，改了约 4 行。
  - `entra-obo-servers` 新增两条：非提问人身份被拒；发出前询问同意，被拒时 Entra 和下游都没有被请求。
  - 去掉加固后，上面这三条加上 http 那条都会变红。

### N-3：重复登记直接拒绝（已加固）
- `parseOboResources` 把资源归一（小写、去掉末尾斜杠）后，同一个资源出现第二次就在启动时报错：「MICROSOFT_OAUTH_OBO_RESOURCES 里 <资源> 写了不止一次。一个资源只能登记一个主机，请只留一项。」。
- 测试：`entra-access` 一条（两个主机不同的写法、以及大小写和末尾斜杠不同的写法都被拒），`entra-obo-config` 一条（经 `loadConfig` 验证）。

### 文档
#430 的 `docs/configuration.md` 补充了三点：https 要求；重复登记会让服务启动失败；发出时会再问一次同意，并且只以提问人本人的身份发出。

### 文件数
-1 的非测试文件仍是 12 个，这次没有新增文件。-2 只改 `docs/configuration.md` 和 `.env.example`。

### 测试摘要（加固后）
- 本地回归：187 个文件，3614 个通过，5 个跳过，0 个失败。需要一次性模板库的 4 个 approval 文件本地没有环境，没跑，由 CI 覆盖。
- `tsc` 干净；`typecheck-tests` 只报本地缺 `@xterm`；`biome` 干净。

### CI（加固后）
- `feat/align-x6-entra-obo-1`（#426）的 head 是 03d0d0a971c19c3d4d60e0f3acce3cb5a25c1345，run 42854286447 全绿。
- `feat/align-x6-entra-obo-2`（#430，base 是 -1）的 head 是 2cc492091a791a38daebe4243473d49ac05a41d4，run 42853749610 全绿。
