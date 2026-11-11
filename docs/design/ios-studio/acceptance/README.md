# 黑白红全站改版 · 验收记录

依据：[`../IMPLEMENTATION.zh-CN.md`](../IMPLEMENTATION.zh-CN.md) 与同目录五张效果图。实现位于 `openbot/app`。

## 1. 基线与范围

| 项 | 内容 |
| --- | --- |
| 施工分支 | `claude/beautiful-allen-j697a8`（从 `origin/main` 新建） |
| 起点提交 | `12c959df`（main，Merge pull request #360） |
| 设计材料 | 取自 `origin/codex/ui-design-studio-reference` 的 `docs/design/ios-studio/`（`df1c848e`） |
| 运行时 | 仓库声明 `bun@1.3.14`；本机执行用 bun 1.4.4（依赖按锁文件 `--frozen-lockfile` 安装，无变更） |
| 改动范围 | 仅 `openbot/app`（前端呈现与交互组织）与本目录文档。后端协议、数据模型、迁移、设备端、模型调用、计费、凭据与生产配置均未改动。 |

改造前基线（同一环境）：`typecheck` 通过；`build` 通过；`bun test`（app）1800 通过 / 7 失败。7 个失败都在 `tests/serve.test.ts`（websocket、语音、听写代理超时与 NUL 路径用例），属于本机网络环境，改造前后同名同数。

### 提交

| 提交 | 内容 |
| --- | --- |
| `69a33325` | 黑白红主题令牌与工作台壳（侧栏、面包屑栏、开放式页头、公共控件、令牌测试） |
| `220ed133` | 共享件：基础组件圆角、后台与设置导航、登录页、输入区焦点、统一错误页、截图路由扩展 |
| `b928cb61` | @Waker；PageShell `crumb` 与 Hook 顺序修正 |
| `2ef2ee6f` | 任务看板、自主工作、员工管理、能力与资源 |
| `2ea973bf` | 截图工具：分区示例数据、`--path` |
| `89971021` | 员工详情与团队、流程与审批、设置与管理后台 |
| `71bd25f9` | 登录、引导、首页与对话 |
| （本提交） | 交互走查脚本、验收截图与本记录 |

## 2. 构建与测试（改造后，实际命令与结果）

在 `openbot/` 下执行：

| 命令 | 结果 |
| --- | --- |
| `bun run --cwd app typecheck` | 通过（0 错误） |
| `bun run --cwd app build` | 通过（Vite 仅有既有的 chunk 体积提示） |
| `bunx biome lint --error-on-warnings --diagnostic-level=warn .` | 通过（1921 个文件，无告警） |
| `cd app && bun test` | **1806 通过 / 7 失败**；失败的 7 项与改造前完全相同（`tests/serve.test.ts`，环境性） |
| `bunx biome format .` | 4 个未改动的文件（`approvals/inbox.tsx`、`bot-profile/permissions.tsx`、`lib/approvals.ts`、`lib/client.ts`）在起点提交上就有格式差异，与本次无关，未处理 |

相关回归（侧栏、路由、任务、员工、IM、自主工作、资源、审批、设置、后台、对话）在各阶段分区运行并全部通过，例如：员工与后台相关 250 项、流程与审批相关 258 项、对话相关 560 项、任务相关 182 项。测试只随视觉结构更新断言（每处注释写明依据 `docs/design/ios-studio`），没有跳过、删除或弱化行为断言；新增了任务状态分布（含总数为零）、触发方式三种真实类型、页框面包屑与小管家入口等测试。

## 3. 截图

生成方式：Vite 开发服务器（隔离端口 3910/3911）+ `openbot/app/tests/parity/capture.ts`，所有 `/api` 读取由示例数据应答（`tests/parity/fixtures.ts` 与 `tests/parity/extra/*.ts`），时钟固定，减少动态效果。**均为示例数据截图**。

- `core/<视图>/`：五个核心页面及其视图（列表/泳道、按员工、群组、资源各页签），每个视图含
  `data-dark-1440x900`、`empty-dark-1440x900`、`data-light-1440x900`、`data-dark-1280x800`、`data-dark-1024x768`、`data-dark-390x844`。
- `routes/`：其余路由 1440×900 深色有数据；`routes-empty/`：同尺寸空态。
- `conversations/`：登录、引导、会话与群聊（需要特定会话 id 或未登录态，单独拍摄）。
- `walkthrough/`：交互走查每一步结束时的画面与 `report.txt`。

自动检查（136 张）：页面错误 0，横向溢出 0（含 390px），缺示例数据的读取 0。控制台仅有 2 类 404：员工详情与流程详情在**空态场景**读不到对象，属预期的「找不到」状态。

## 4. 交互走查（示例数据模拟交互）

`bun tests/parity/walkthrough.ts`：在真实页面上点击与输入，记录 URL 变化与页面发出的写请求。19/19 通过，摘要：

| # | 交互 | 结果 |
| --- | --- | --- |
| 1 | 侧栏导航五个核心页面 | 选中项与 URL 一致 |
| 2 | 任务看板点选「需要操作」指标再取消 | `status=needs_action`，`aria-pressed=true`；再点清空 |
| 3 | 列表 ↔ 泳道 | `view=lanes` / `view=list` |
| 4 | 任务状态筛选与清空 | `status=running` → 清空 |
| 5 | 需要操作 ↔ 查收结果 | `attention=review` |
| 6 | 批准待批准任务 | 发出 `POST /api/approvals/approval-01/decision {"decision":"allow_once"}` |
| 7 | 查看任务详情 | 进入对应会话 `/channel/channel-support` |
| 8 | 员工/群组页签、角色模板 | `tab=groups`；进入 `/role-templates` |
| 9 | 新建员工 | `?new=true`，对话框打开 |
| 10 | 员工详情 | `/wakers/agent-analyst`，面包屑「员工管理 › 数据分析员」 |
| 11 | 接入 IM 聊天弹层 | 打开、Esc 关闭、焦点回到触发按钮 |
| 12 | @Waker 列表 ↔ 卡片 | `view=cards` |
| 13 | 新建自动任务 | 创建面板打开（8 个表单控件） |
| 14 | 自动任务启停 | 发出 `PUT /api/automations/automation-03/enabled {"enabled":false}` |
| 15 | 触发类型筛选、按员工查看 | `trigger=schedule`；`view=agents` |
| 16 | 资源入口切换与插件详情 | `tab=skills`；插件详情抽屉显示安装/授权状态，Esc 关闭 |
| 17 | 插件分类与我的插件 | `category=personal`；`view=mine` |
| 18 | 设置中切换主题 | `dark` 类 true → false |
| 19 | 键盘：分段控件方向键 | 焦点移到「群组」，URL 同步；可见红色焦点环 |

写入只验证到「页面发出了正确的请求」；示例数据对未定义的写入回 404。**未与真实后端联调**（见第 7 节）。

## 5. 逐路由清单（`openbot/app/src/routes`，62 个文件）

壳层：app = 应用侧栏 + 工作台；admin = 管理后台侧栏；settings = 应用侧栏 + 设置导航；— = 无壳层。截图路径相对本目录。

### 五个核心页面（效果图 01–05）

| 路由 | 壳层 | 主要组件 | 状态与交互 | 截图 | 结论 |
| --- | --- | --- | --- | --- | --- |
| `/tasks` | app | `tasks.tsx`、`WorkRecordBanner`、`WorkRecordStatus`、待关注/全部任务列表、泳道 | 遥测面板四指标（点选筛选）、状态分布（同一查询计算，总数为零显示空条）、设备/周期筛选、需要操作/查收结果、列表/泳道、批准/拒绝/查收/归档/拖拽归档；加载占位、空态、读取失败重试 | `core/tasks/`、`core/tasks-lanes/` | 已实现，已验证（示例数据） |
| `/reachability` | app | `reachability.tsx`、`ChatStage`、`ConnectedChats`、`RecentDeliveries` | 四个接入入口、悬浮聊天示意（装饰）、列表/卡片、筛选、行操作、送达记录、接入流程弹层；空/无匹配/错误 | `core/reachability/` | 已实现，已验证 |
| `/autonomous` | app | `autonomous.tsx`、`SignalArt`、概览面板、`UnifiedList`、`TriggerKinds`、`AutomationsSection` | 新建、查看、编辑、筛选、启停、立即运行、删除；三种真实触发类型；按员工视图；空态闪电图标 | `core/autonomous/`、`core/autonomous-agents/` | 已实现，已验证 |
| `/wakers` | app | `wakers.tsx`、`CoworkerCard`、`Crews`、`card-chrome` | 员工/群组页签（`?tab=`）、角色模板、新建、角色档案卡、运行状态、环境、筛选、最近运行；个人分身红色强调；暂停/恢复、对话、装配、编辑 | `core/wakers/`、`core/wakers-groups/` | 已实现，已验证 |
| `/resources` | app | `resources.tsx`、`ResourceTabs`、`resource-kit`、`PluginsTab`、能力/来源/项目/模型页签 | 六入口连续面板（红线标当前）、插件市场/我的插件、分类、详情抽屉、权限门槛、中文翻译显示；其余页签同卡面 | `core/resources*/` | 已实现，已验证 |

### 其余路由

| 路由 | 壳层 | 主要组件 / 改动 | 截图 | 结论 |
| --- | --- | --- | --- | --- |
| `__root` | — | 根布局；统一错误页 `RouteError`（重试 / 回到工作台）接入路由默认错误组件 | — | 已实现；错误页未单独截图（需人为抛错） |
| `_authed`（守卫） | — | 未登录重定向到 `/sign`（3 处重定向） | — | 未改，行为保留 |
| `_authed/_app` | app | `AppShell`：226px 侧栏、导航红条、员工/群组分段、名单、账户区；小管家改入面包屑栏 | 全部 app 截图 | 已实现 |
| `/sign` | — | 品牌 logo、红线英文眉线、登录/注册分段、卡面、错误红色浅底 | `conversations/sign-*.webp`（以 `/api/me` 返回 401 的专用脚本拍摄） | 已实现 |
| `/sign-in/$requestId` | prose | 复查无需改 | `conversations/sign-in-signin-crm.webp` | 已复查 |
| `/onboarding` | — | 上游向导框架套黑白红：品牌 logo 与中英文名、`0N ONBOARDING` 眉线、开放式大标题、红色当前步骤标记（步骤菜单、手机进度条、演示圆点）、石墨演示面板、熊宝红白光球；资料来源步骤右侧补熊宝示意图；**重定向**：已完成引导或部署不跟踪引导时回到 `/` | `conversations/onboarding-{welcome,sources,name}-{dark,light}-1440x900.webp`、`…-dark-390x844.webp`（`bun tests/parity/onboarding-shots.ts` 以需引导的用户拍摄） | 已实现 |
| `/` | app | 欢迎区熊宝 + 开放式标题、共享员工空态 | `routes/home.webp` | 已实现 |
| `/bot` | app | 页头员工信息、聊天组件中文化、气泡样式 | `routes/bot.webp` | 已实现 |
| `/channel/new` | app | 收件人行、空对话欢迎 | `routes/channel-new*.webp` | 已实现 |
| `/channel/$channelId` | app | 消息气泡、执行状态卡、附件卡、审批卡红色浅底、输入区 | `conversations/channel-channel-*.webp`（含 390px） | 已实现 |
| `/group/new` | app | 员工列表面板、「第 N 个回答」 | `routes/group-new.webp` | 已实现 |
| `/group/$channelId` | app | 群聊气泡、需要你处理、成员行 | `conversations/group-channel-team.webp` | 已实现 |
| `/wakers/$agentId` | app | 工作台框架 + 角色档案卡、两栏分组面板 | `routes/wakers-agent-analyst.webp` | 已实现 |
| `/assemble/$agentId` | app | 档案条 + 两栏、模型选择框加宽 | `routes/assemble-agent-analyst.webp` | 已实现 |
| `/role-templates` | app | 列表 + 编辑面板、补加载态与删除失败提示 | `routes/role-templates.webp` | 已实现 |
| `/team-bots` | app | 网格卡、发布/取消/清除偏好的进行中与错误反馈 | `routes/team-bots.webp` | 已实现 |
| `/agents`、`/bots`、`/bots/$agentId` | — | **重定向** → `/wakers`、`/wakers/$agentId` | — | 已核对 |
| `/skills`、`/knowledge`、`/memory` | — | **重定向** → `/resources?tab=skills/knowledge/sources` | — | 已核对 |
| `/routines` | — | **重定向** → `/autonomous?trigger=schedule` | — | 已核对 |
| `/responsibilities` | app | 双栏、中文状态徽标 | `routes/responsibilities.webp` | 已实现 |
| `/approvals` | app | 等你处理置顶（红色浅底）、规则表横向滚动 | `routes/approvals.webp` | 已实现 |
| `/pipelines` | app | 卡面、失败/待处理步骤红色细线、空态 | `routes/pipelines.webp` | 已实现 |
| `/wakerflows` | app | 卡片网格与状态徽标 | `routes/wakerflows.webp` | 已实现 |
| `/wakerflows/$flowId` | app | 中性流程图 + 红色信号节点、运行/版本/分享卡面 | `routes/wakerflows-flow-weekly.webp` | 已实现 |
| `/wakerflows/new` | app | 生成三项合一卡、员工胶囊 | `routes/wakerflows-new.webp` | 已实现 |
| `/wakerflows/import/$token` | app | 角色行分隔 | 未纳入本目录（`--path` 可复拍） | 已实现 |
| `/plans` | app | 用量条（≥80% 变红并写明）、当前套餐标记 | `routes/plans.webp` | 已实现 |
| `/platform` | app | 表格面板、状态徽标、空态；**新增暂停前二次确认**（见第 6 节） | `routes/platform.webp` | 已实现，待决定 |
| `/settings` 及 `passwords`、`connected-accounts(/$key)`、`components-gallery(/$name)` | settings | 设置导航红条、卡片列表、补加载态 | `routes/settings*.webp` | 已实现 |
| `/admin`（含 `route.tsx` 守卫重定向） | admin | 后台导航红条；`main` 加 `min-w-0` 修 390px 撑宽 | `routes/admin.webp` | 已实现 |
| `/admin/people`、`credentials`、`audit`、`boundaries`、`enterprise`、`components` | admin | 表格面板、中文状态徽标、destructive 危险操作 | `routes/admin-*.webp` | 已实现 |
| `/admin/plugins(/$key…)`、`skills`、`computers`、`identity-providers`、`playground`、`components/$name` | admin | 复查，随公共样式统一 | `routes/admin-*.webp` | 已复查 |

## 6. 待你决定

1. **平台页「暂停租户」二次确认**：改版时新增，原为直接执行。任务书要求保留现有业务行为；如不需要，删除 `platform.tsx` 中该对话框即可。
2. **文案与效果图不一致处（均保留现有文案）**：@Waker 标题保留「将员工接入群聊或私聊，在 IM 中持续承接团队工作」，口号含义写入说明句；能力与资源副标题保留「释放你的员工潜能，解锁更多可能」；任务看板副标题保留原文。效果图中的「数字员工」按项目术语规则统一写作「员工」（`tests/glossary-terms.test.ts`）。
3. **角色名**：设定图署名「勇小熊 / YONG XIAOXIONG」，应用内一直称「熊宝」，未改。

## 7. 已实现 / 已验证 / 待验证 / 受阻

- **已实现并验证（示例数据）**：主题与壳层、五个核心页面、其余全部前端路由的样式与状态呈现；深浅主题；1440/1280/1024/390 宽度布局；键盘焦点与分段控件方向键；弹层开关与焦点回归；第 4 节 19 项交互。
- **待验证**：与真实后端联调（写入后的数据刷新、权限拒绝、租户与设备边界）——本会话的云端环境未配置可用的模型凭据与设备端，按任务书「上线前核验在独立本地环境与测试数据下完成」，留待你在本地环境用可丢弃测试数据复核；统一错误页的浏览器复核；Windows 浏览器路径（本环境为 Linux Chromium）。
- **受阻**：无。
- **已知且非本次引入**：`tests/serve.test.ts` 7 项环境性失败；4 个文件的既有格式差异。
