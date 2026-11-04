# RES2 项目资源：本地目录或 Git 仓库、按设备共享、任务上下文可选、员工专属范围 设计规格

- 日期：2026-11-04
- 状态：**已定稿**（2026-11-04）。第 4 节的待决策项已全部决定，均采纳建议；本文不含代码。
- 故事：`docs/acceptance/STORIES.md` RES2（D08）：公开项目支持名称、简介、本地目录或 Git 仓库和分支，当前设备下共享给全部 Waker，并在任务上下文中可选；员工专属项目具备独立范围。11-02 的 MVP 决定曾把它移到 v1.0 后，现在拉回范围。
- 原文出处：`docs/specs/2026-10-06-qoderwake-replica.md` 没有 RES2 的逐条描述，F 组（设备执行面，第 124 行起）定义了它依赖的 runner。F1 规格（`docs/specs/2026-11-02-f1-avatar-info-sources.md` 开头的"相关"一行）把它记为"本地目录项目"。
- **依赖**：F1 阶段 2（runner 只读根目录，`root_ref`）。另一个代理正在做这一阶段（分支 `feat/f1-local-folder-runner`，截至本文还没有提交）。RES2 的"本地目录"**复用这套根目录机制**，不另造一套；RES2 的 runner 阶段必须等它合入后再开始。
- 相关：F2（runner 打包）、F3（网关下发）、SEC1（危险命令与敏感路径，项目目录可写时必须生效）、`server/src/net/outbound-guard.ts`（服务端出站守卫）。与 WakerFlow 系列、ROLE1 都不共用文件，可以并行。

---

## 1. 现状（基线：`claude/magical-archimedes-8a6ljj`，`bcdc46f`）

### 1.1 休眠的项目表

`server/src/db/schema/resource-project-foundations.ts`（迁移 `0104_resource_project_foundations_closed.sql`），没有代码读写：

- `resource_projects`（`:10`）：`id`（uuid，**没有默认值**，由调用方给出）、`device_id`（uuid，外键 `registered_devices.id`，级联删除）、`scope`、`agent_id`（外键 `agents.id`）、`name`（1–80）、`description`（≤500）、`source` jsonb（必填，**没有任何 CHECK**）、`revision`（>0）。`resource_projects_scope_check`：`public` 时 `agent_id` 为空，`agent` 时 `agent_id` 不为空。
- `project_context_bindings`（`:38`）：主键 `(tenant_id, device_id, agent_id)`，指向 `project_id`。即"某位员工在某台设备上当前选中的项目"，每个组合只有一个。
- RLS：本租户可读；写入时要求设备属于本租户，`agent` 范围要求员工也属于本租户且 `owner_user_id = tenant_id`；绑定写入时要求项目与绑定是同一台设备，并且项目是 `public` 或属于这位员工。`0122_team_tenant.sql:405-450` 已经为 Team Bot 补了对应的策略（员工在 `team` 租户、所有者是本人）。
- 已开 RLS，但**没有 FORCE**，也没有 `platform` 分支（模板库里查得 `relforcerowsecurity = false`）。应用角色经 `drizzle/0054_app_role.sql:21-22` 的默认权限拥有增删改查权限。
- **这个 schema 文件按字节锁定**：`server/tests/recovery-knowledge-write-foundations.test.ts:2083` 和 `recovery-plugin-assembly-foundations.test.ts:1829` 记录了它的长度和 sha256，`recovery-resource-project-foundations.test.ts` 锁定元数据。所以**一个字节都不能改**，包括注释。

### 1.2 runner 只能碰自己的工作区

- `runner/src/index.ts:38-46`：一切都在 `<dataDir>` 下，文件和 shell 工具只能到达 `<dataDir>/runner-workspace/`。
- `runner/src/execute.ts:107` 的 `exec` 在工作区里运行命令；`:124`、`:131`、`:136` 的 `files.list/read/write` 受 `agent-computer/src/workspace.ts` 的三层路径约束（拒绝绝对路径、拒绝 `..`、拒绝符号链接逃逸）。没有"另一个根目录"的概念。
- runner 不会运行 `git`。

### 1.3 F1 阶段 2 将要提供的东西（按 F1 规格 §4、§8）

- runner 本机登记"用户授权的只读根目录"（本地命令或托盘菜单），生成不透明的 `root_ref`；**绝对路径只存在 runner 本机**。
- `files.list/read` 增加 `root` 参数；只读根目录上的写操作一律拒绝。
- 服务端只存 `device_id`、`root_ref` 和用户填写的 label（`avatar_sources`，迁移 `0130`）。

### 1.4 动作怎样到达设备

- 网关 `server/src/computer/gateway.ts:343` 用 `resolveDevice(botId)`（`index.ts:932` 的 `deviceForBot`，背后是 `server/src/devices/selection.ts:47` 的 `createDeviceSelector`，有 `forTask` 和 `forBot`）把动作改投到 runner；`:656` 起先做策略判定、写审计，再过审批闸门（`:726`），最后执行。
- 下发由 `server/src/devices/channel.ts` 负责，帧里的字段由服务端填写。

### 1.5 出站守卫

`server/src/net/outbound-guard.ts`：`checkOutboundUrl()`（`:271`，不联网的静态检查）、`assertResolvesPublic()`（`:340`，DNS 检查）、`guardedFetch()`（`:384`，拒绝一切重定向）。它只管服务端进程自己用 `fetch` 发出的请求；**`git` 子进程有自己的网络栈，守卫管不到**：会跟随 HTTP 重定向、支持 `file://`、`ext::` 等传输方式、会去拉子模块，并且 DNS 检查与真正连接之间有重绑定窗口（守卫注释"KNOWN LIMIT — DNS REBINDING"）。

---

## 2. 差距

| # | 故事要求 | 差距 |
| --- | --- | --- |
| G1 | 项目：名称、简介、来源 | 表在，没有 API、没有界面；`source` 没有约束 |
| G2 | 本地目录 | runner 没有根目录（等 F1 阶段 2）；项目可能需要写入 |
| G3 | Git 仓库和分支 | 没有任何 clone/fetch |
| G4 | 当前设备下共享给全部 Waker | 没有按设备的列表和可见性判定 |
| G5 | 在任务上下文中可选 | 没有选择入口；动作不知道该在哪个目录里执行 |
| G6 | 员工专属项目的独立范围 | 没有执行侧检查 |
| G7 | 测试 | 没有 |

---

## 3. 方案

### 3.1 存储：原样启用休眠表

- **R-A（推荐）：原样启用 `resource_projects` 和 `project_context_bindings`。** 结构与故事完全对应（按设备、`public`/`agent` 两种范围、每位员工每台设备一个当前项目），Team Bot 的策略也已经补过。迁移 **0136** 只追加：
  1. 两张表 `FORCE ROW LEVEL SECURITY`；
  2. 新的 `platform` 分支 SELECT 策略（与兄弟表一致，只读）；
  3. `resource_projects_source_check`：`source` 必须是下面两种形状之一（CHECK 只写在 SQL 里，Drizzle 文件不动）。
- R-B：新建一张表。可以避开字节锁定，但会出现第二份"项目"结构，休眠表永远是死代码。**不推荐**。
- 不论选哪个，都是"把历史结构变成活表"的有意变更，已签字（决策 D1，2026-11-04）。

`source` 的两种形状：

```
{ kind: "local", rootRef, label, writable: boolean }
{ kind: "git",   url, branch, rootRef | null, writable: boolean, syncedAt | null, commit | null }
```

`rootRef` 是 runner 生成的不透明 id；服务端**从不**保存绝对路径。`url` 不能带用户名或密码（`https://user:token@…` 被拒），所以服务端从不保存 Git 凭据。

### 3.2 本地目录：复用 F1 的根目录

- 人在设备上把一个文件夹登记成根目录（F1 阶段 2 的本地命令或托盘菜单），runner 把 `{ rootRef, label }` 上报给服务端；在"新建项目"里选择这台设备的某个根目录，就得到一个 `kind: "local"` 的项目。
- F1 的根目录只读。项目往往需要写（例如后端工程师改代码），所以 runner 的根目录登记增加一个属性 `mode ∈ read|write`。分身的根目录永远是 `read`；项目的根目录由人在设备上登记时选择，服务端的 `writable` 只能比设备上的 `mode` 更严，不能更宽（决策 D3，已决定）。
- 如果 F1 阶段 2 最终没有"设备上报根目录清单"这一条消息，RES2-2 补上，**使用同一个消息类型和同一份 runner 登记文件**，不另起一套。

### 3.3 Git 仓库：在设备上 clone，服务端不联网

- **G-A（推荐）：clone 和 fetch 都在设备上，由 runner 执行。** 理由：
  1. 项目就是给设备上的 shell 和文件工具用的，代码本来就要在设备上；
  2. 私有仓库的凭据（SSH 密钥、凭据助手）是用户本机的，服务端永远拿不到，也不需要保存；
  3. 服务端进程不运行 `git`，§1.5 里守卫管不到的那些问题在服务端都不存在。
- runner 的做法：
  - 位置：`<dataDir>/runner-projects/<rootRef>/`，与 `runner-workspace` 并列，不在它里面。clone 完成后登记为一个根目录（`mode` 默认 `write`，因为这是一份独立副本，不是用户自己的工作目录）。
  - 命令：`git -c protocol.file.allow=never -c core.hooksPath= clone --branch <branch> --single-branch --depth 50 -- <url> <dir>`，环境变量 `GIT_TERMINAL_PROMPT=0`、`GIT_ALLOW_PROTOCOL=https:ssh`；不拉子模块（决策 D5，已决定）；参数以数组传给子进程，不经过 shell 拼接。
  - 同步：人点"同步"时执行 `fetch origin <branch>` 加 `checkout`，回报 `commit` 和 `syncedAt`。v1.0 不在任务开始前自动拉取（决策 D6，已决定）。
  - 列出分支：在设备上执行 `git ls-remote --heads`，结果回给界面。
  - 用户局域网里的 Git 服务器（例如公司内网 GitLab）是合法来源：这是用户自己的机器在访问用户自己的网络，所以 runner **不**套用服务端的私网拒绝规则，只限制协议。
- **服务端只做静态校验，从不连接仓库**：`url` 必须是 `https://…` 或 `ssh://…`/`git@host:path`，不带凭据，长度不超过 500；`branch` 按 `git check-ref-format` 的规则做子集校验。这里**不能**直接用 `checkOutboundUrl()`，因为它会拒绝私网主机，而私网 Git 服务器在设备侧是合法的；但服务端也确实不会去拨这个地址。
- G-B：服务端 clone 后同步到设备。需要服务端存储、需要保存凭据，而且 `git` 子进程绕过出站守卫。**不推荐**。如果以后一定要在服务端侧取代码，只能在租户自己的电脑容器（F6 的云模式）里做，不能在服务端进程里做；并且必须先过 `checkOutboundUrl()` 和 `assertResolvesPublic()`，再以 `http.followRedirects=false`、`GIT_ALLOW_PROTOCOL=https`、不拉子模块的方式执行，接受 DNS 重绑定的已知限制。v1.0 云模式不支持 Git 项目（决策 D7，已决定）。

### 3.4 可见范围（G4、G6）

- **公开项目**（`scope = public`）：这台设备上本租户的全部员工都能选用，包括本人可以使用的 Team Bot。
- **员工专属项目**（`scope = agent`）：只有这位员工能选用。别的员工即使知道 `projectId`，选用也被拒绝；它在别的员工的选择器里不出现。
- 项目只属于一台设备。员工的任务被派到另一台设备时，这个项目不可用（选择器里显示为灰色，并注明"在另一台设备上"）。
- 只有人能创建和修改项目，员工没有创建项目的工具（决策 D8，已决定）。

### 3.5 任务上下文中选择（G5）

- **当前项目**就是 `project_context_bindings` 的那一行：(设备, 员工) 到项目。在对话输入框旁和员工详情里都有项目选择器，选择即写入绑定。派活时显示将要使用的项目。
- **执行侧**：网关在把文件和 shell 动作投到设备之前，按"这次动作的员工 + 解析出的设备"读取绑定，把 `root: <rootRef>` 和 `writable` 写进下发的帧。这是**服务端的事实**，模型提交的参数里不能指定根目录（帧里来自调用方的 `root` 一律丢弃）。项目被删除、设备不一致、范围不允许时，动作被拒绝并写审计行，不会退回工作区悄悄执行（决策 D9，已决定）。
- runner：`exec` 的工作目录、`files.*` 的根目录都改为这个根目录；`writable = false` 时写操作一律拒绝。
- **提示词**：有当前项目时，员工的提示词里加一段"当前项目"：名称、简介（用 `server/src/untrusted-content.ts` 的 `withUntrustedNotice()` 包起来）、来源类型、Git 的分支和最近同步的 commit，以及"文件和命令默认在项目根目录中执行"。**不包含路径**。
- SEC1 的危险命令和敏感路径判定照常生效；项目可写时，写文件仍然按员工的审批规则走。

---

## 4. 待决策（已全部决定，2026-11-04）

| 编号 | 问题 | 决定 |
| --- | --- | --- |
| D1 | 是否同意原样启用 `resource_projects` 和 `project_context_bindings`（只追加 FORCE、`platform` 只读策略和 `source` 的 CHECK） | 已决定（2026-11-04）：同意（R-A） |
| D2 | 本地目录是否完全复用 F1 的根目录机制 | 已决定（2026-11-04）：是；如有缺口在同一机制上补，不另起一套 |
| D3 | 本地目录项目能否写入 | 已决定（2026-11-04）：能，但由人在设备上登记时选择读写；服务端只能更严 |
| D4 | Git 在哪里 clone 和 fetch | 已决定（2026-11-04）：只在设备上（G-A），服务端不连接仓库 |
| D5 | 是否拉取子模块 | 已决定（2026-11-04）：v1.0 不拉 |
| D6 | 任务开始前是否自动拉取最新代码 | 已决定（2026-11-04）：不自动，人点"同步" |
| D7 | 云模式（F6，服务端容器）是否支持 Git 项目 | 已决定（2026-11-04）：v1.0 不支持 |
| D8 | 员工能否自己创建或切换项目 | 已决定（2026-11-04）：不能，只有人能 |
| D9 | 当前项目失效时（删除、换设备）动作怎么办 | 已决定（2026-11-04）：拒绝并说明原因，不退回工作区 |
| D10 | 每台设备最多几个项目 | 已决定（2026-11-04）：50 个；单个项目不设大小上限，单次读取沿用现有上限 |

---

## 5. 分阶段计划

迁移编号按总览预留，本故事用 **0136**；它与 WakerFlow 系列并行，推送前检查 origin，如果号码被占用就顺延。新增服务端测试后运行 `bun scripts/ci/server-shards.mjs --write`。

### RES2-1：项目的数据与 API（服务端，迁移 0136，不依赖 F1，7 个文件）
- 文件：`sql/0136_resource_projects_active.sql`、`meta/_journal.json`、`shared/projects.ts`（新增：`source` 的类型与校验，含 Git 地址和分支的静态校验）、`server/src/projects/store.ts`（新增：增删改查、按 `revision` 条件更新、绑定读写）、`server/src/projects/routes.ts`（新增：`/api/projects`，按设备列出、创建、修改、删除、设置当前项目）、`server/src/index.ts`（挂载）、`server/tests/resource-projects.integration.test.ts`（新增）。
- 本阶段的 `local` 项目只能引用设备已上报的 `rootRef`；在 F1 阶段 2 合入之前，测试直接插入已上报的根目录记录。
- 验收：
  1. 公开项目对本租户所有员工的选择器可见；员工专属项目只对那位员工可见。
  2. 把员工 Y 的绑定指向员工 X 的专属项目：数据库策略拒绝。
  3. 绑定的设备与项目的设备不同：拒绝。
  4. 租户 B 用租户 A 的 `device_id` 创建项目：拒绝；读 A 的项目：404。
  5. `https://user:pass@…`、`file://…`、`ext::…`、非法分支名：保存被拒；数据库的 `source` CHECK 也拒绝直接插入的非法形状。
  6. 删除设备后，它的项目和绑定被级联删除。
  7. 现有的 `recovery-resource-project-foundations.test.ts` 和两条字节锁定测试原样通过（证明 schema 文件没有被动过）。

### RES2-2：runner 侧的项目根目录与 Git（依赖 F1 阶段 2，6 个文件）
- 文件：F1 阶段 2 新增的 runner 根目录登记文件（加 `mode` 和来源属性）、`runner/src/execute.ts`（`exec` 的工作目录，`writable` 判定）、`runner/src/git.ts`（新增：clone、fetch、ls-remote）、`runner/src/index.ts`（项目同步命令的处理）、`server/src/devices/channel.ts`（项目同步帧）、`runner/tests/project-roots.test.ts`（新增）。
- 验收：
  1. 在可写的项目根目录里 `files.write` 成功，在只读根目录里被拒并且磁盘没有变化。
  2. `exec` 的工作目录是项目根目录；`cd ..` 之后用文件工具访问根目录外的路径仍然被拒。
  3. clone 指定分支成功，回报的 `commit` 正确：测试在临时目录建一个裸仓库，执行 `git update-server-info` 后用 `Bun.serve` 在 `127.0.0.1` 上以哑 HTTP 协议提供，并通过只在测试里注入的协议白名单放行 `http`（生产白名单固定为 `https:ssh`，不可配置）。另一条测试断言 `file://` 地址被拒。
  4. clone 的参数不经过 shell：分支名里带 `;rm -rf` 时被校验拒绝，没有任何命令被执行。
  5. 服务端记录里查不到任何绝对路径。

### RES2-3：网关与提示词（服务端，6 个文件）
- 文件：`server/src/computer/gateway.ts`（按绑定写入 `root` 和 `writable`，丢弃调用方给的 `root`）、`server/src/projects/context.ts`（新增：读取当前项目、生成提示词段落）、`server/src/copilot.ts`（注入"当前项目"段落）、`server/src/index.ts`（接线）、`server/tests/project-context.integration.test.ts`（新增）、`server/tests/device-safety.integration.test.ts`（扩展）。
- 验收：
  1. 员工 X 绑定了项目 P：它的文件动作到达 runner 时带着 P 的 `rootRef`；模型在参数里伪造 `root` 无效。
  2. 员工 Y 没有绑定：动作仍在工作区执行，与现在一样。
  3. 绑定的项目已删除或在另一台设备上：动作被拒，审计行写明原因，runner 一帧都收不到。
  4. 提示词里有项目名称和简介，带不可信内容声明，没有路径。
  5. SEC1 的危险命令审批在项目根目录里照常触发。

### RES2-4：界面（前端，6 个文件）
- 文件：`app/src/components/resources/projects-section.tsx`（新增，"能力与资源"页的"项目"区）、`app/src/routes/_authed/_app/resources.tsx`、`app/src/components/projects/project-picker.tsx`（新增，对话输入框旁和员工详情共用）、`app/src/lib/projects/queries.ts`（新增）、`app/tests/projects-section.test.tsx`（新增）、`app/tests/project-picker.test.tsx`（新增）。
- 验收：
  1. 先选设备，再看到这台设备上的项目；新建时可以选"本地目录"（列出设备已登记的根目录）或"Git 仓库"（地址、分支、列出分支）。
  2. 范围选"员工专属"时必须选一位员工。
  3. 设备离线时，Git 的"同步"和"列出分支"不可用，并说明原因。
  4. 选择器里不属于当前设备或当前员工的项目不出现或显示为灰色。
  5. 界面文案全部为中文。

---

## 6. 验收测试

1. `server/tests/resource-projects.integration.test.ts`：见 RES2-1 验收 1–7，全部真库、`runAsTenant`，至少两个租户加一个 Team Bot 场景。
2. `runner/tests/project-roots.test.ts`：见 RES2-2 验收 1–5；用临时目录和本地裸仓库，不访问外网。
3. `server/tests/project-context.integration.test.ts`、`device-safety.integration.test.ts`：见 RES2-3 验收 1–5。
4. 回归：`recovery-resource-project-foundations.test.ts`、`recovery-knowledge-write-foundations.test.ts`、`recovery-plugin-assembly-foundations.test.ts`（字节锁定）、`team-tenant-rls.integration.test.ts`、`runner-dispatch.test.ts`、F1 阶段 2 的测试。
5. 前端：`app/tests/projects-section.test.tsx`、`project-picker.test.tsx`、`resources-aggregate.test.tsx`。
