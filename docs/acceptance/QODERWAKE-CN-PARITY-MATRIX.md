# QoderWake CN 前端复刻：参考清单与页面状态矩阵

执行合同为 [`docs/plans/2026-11-07-qoderwake-cn-frontend-parity.md`](../plans/2026-11-07-qoderwake-cn-frontend-parity.md)。本表是计划 F0 要求的"可重放的页面/状态矩阵"，也是 F5 差异表的底稿。

## 证据口径

| 项 | 取值 |
| --- | --- |
| 起点 | `main` `18eb0eb`，计划提交 `ad28294`；实施分支 `claude/beautiful-allen-j697a8` |
| 浏览器 | 仓库自带 `playwright-core 1.62.1` 驱动的 Chromium（`/opt/pw-browsers/chromium`），DPR 1 |
| 视口 | 1696×783（参考观察窗口）、1440×900、1280×800、1024×768（折叠/溢出规则） |
| 主题 | 深色（参考站所见）；浅色仅做我方回归，参考浅色未实测 |
| 数据 | `openbot/app/tests/parity/fixtures.ts` 的合成数据：`data`（有数据）与 `empty`（空态）两套，固定时间与 id；不含真实账号、机器名、聊天或令牌 |
| 我方截图 | `bun tests/parity/capture.ts`（见 `openbot/app/tests/parity/README.md`），每张图配同名 `.json` 测量（盒模型、字号、颜色、横向溢出、控制台错误、未覆盖接口） |
| 参考截图 | **全部待补证**。参考实例在用户本机 `http://127.0.0.1:19830/management`，云端会话无法访问。补证方法见文末 |

状态取值：

- **已实现**：我方页面已按计划正文列出的结构实现，并有自动化断言。
- **部分**：结构已有，但其中某项缺后端契约或数据，按"能力缺口"记录。
- **待补证**：缺参考侧同视口截图或测量，不能下 1:1 结论。本轮所有"1:1"判定都处于此状态。
- **缺口**：参考可见、我方缺契约，保留真实禁用或失败语义。

## 我方证据截图

`docs/acceptance/qoderwake-parity-shots/`：五个一级入口（含 `/wakers?tab=groups`）在 1440×900、深色、DPR 1 下的 `data-*.png` 与 `empty-*.png`，以及该轮采集的 `summary-1440x900.md`（0 页面异常、0 未覆盖接口、无横向溢出）。全部四个视口与下游页面用 `bun tests/parity/capture.ts --scenario all` 本地重放，同页重拍像素差为 0%。

## 公共壳（F1）

| 参考 | 我方 | 交互/状态 | 我方证据 | 参考证据 | 状态 |
| --- | --- | --- | --- | --- | --- |
| 左栏约 240px | `SidebarShell width="240px"`（`routes/_authed/_app.tsx`） | 展开、`Ctrl/Cmd+B` 折叠、刷新后保持 | `tests/sidebar-*.test.ts*`；截图测量 `sidebar.w` | 待补证 | 已实现 / 待补证 |
| 两段主导航 | 第一段：任务看板、@Waker、自主工作、Waker 管理、能力与资源；第二段：「更多」收纳我方独有入口 | 选中项 `aria-current`、键盘可达、「更多」展开状态记忆 | `tests/app-sidebar-shell.test.tsx` | 待补证（第二段参考内容未知） | 已实现 / 待补证 |
| 员工/群组标签、搜索、新建、会话条目 | 侧栏会话区 `SegmentedTabs` + 搜索 + 新建（随页签指向 `/channel/new` 或 `/group/new`） | 页签方向键切换、空态、搜索无结果 | `tests/app-sidebar-shell.test.tsx`、`tests/channel-*.test.ts*` | 待补证 | 已实现 / 待补证 |
| 底部账户、用量、设置、小管家 | `UsagePanel`、小管家→`/bot`、账户菜单（管理/账户设置/退出）、设置图标 | 菜单向上展开、管理员才见"管理" | `tests/app-sidebar-shell.test.tsx` | 待补证（小管家为映射） | 已实现 / 待补证 |
| 主区起点约 x=280 | `PageShell width="workbench"`：全宽、40px 内边距、20px 标题 | 主区独立滚动 | `tests/page-shell-workbench.test.tsx`；截图测量 `h1.x` | 待补证 | 已实现 / 待补证 |
| 深色、灰阶、细描边、淡绿主操作 | `styles.css` 令牌 | 浅色主题仍可切换 | `tests/workbench-tokens.test.ts`（色相与 WCAG AA 对比度） | 待补证（色值为估计） | 已实现 / 待补证 |

## 五个一级入口

计划条目逐字取自计划的页面对照表。"我方证据"列的测试文件均在 `openbot/app/tests/`；截图为 `data`/`empty` × 四视口 × 深色。

| 参考页 | 我方路径与深链 | 已实现（计划条目） | 部分/缺口 | 我方证据 | 状态 |
| --- | --- | --- | --- | --- | --- |
| 任务看板 `/work-management` | `/tasks`（`period` `view` `attention` `q` `executor`/`group`/`crew` `source` `status`） | 工作记录横幅；数据周期；任务总数/进行中/需要操作/已结束四卡；关注区 需要操作/查收结果 页签；全部任务 列表/泳道 页签、搜索、员工/群组·触发方式·状态筛选；详情/审批/回答/查收/归档沿用原动作 | 数据周期与周期筛选合为一个 `period` 控件（后端只有一个周期参数） | `tasks-parity.test.tsx` 及既有 `tasks-*.test.ts*`；截图 `tasks` | 已实现 / 待补证 |
| @Waker `/at-waker` | `/reachability`（`view` `q` `type` `model` `status`） | 标题与四个接入入口；自绘场景示意（内联 SVG）；接入 IM 聊天弹窗（原 Slack/Teams/短信/设备关联流程原样迁入）；机器人与账号；已接入聊天 表格/卡片、搜索、聊天类型/模型/状态筛选、空态、行操作（打开对话、断开连接、移除设备）；最近送达 | 自动接入、接入申请：缺口；"待确认"状态无读取接口；模型由员工绑定推导 | `reachability-parity.test.tsx`；截图 `reachability` | 部分 / 待补证 |
| 自主工作 `/autonomous-work` | `/autonomous`（`q` `executor` `trigger` `status` `sort` `detail` `view`；原按员工页面在 `?view=agents`） | 标题与右侧主按钮；四指标单面板（全部/已启用/运行中/需要关注）；搜索与执行者/触发类型/状态/排序；统一列表合并自动任务、定时任务、长期职责、主动巡检；启停、编辑、详情；新建（定时、API） | 事件触发的自动任务、非自动任务的 Flow 执行者、自动任务运行记录、定时任务编辑：缺口 | `autonomous-parity.test.tsx` 及既有 `autonomous-*`、`automation*`；截图 `autonomous`、`autonomous-agents` | 部分 / 待补证 |
| Waker 管理 `/management`、`?tab=groups` | `/wakers`、`/wakers?tab=groups`（`q` `status` `role` `env` `sort`） | 页头与新建入口；唤醒者/群组 页签与深链；名称角色搜索；运行状态/角色/环境/排序；计数；卡片网格与创建卡；卡片 状态·环境·头像·名称·角色·任务数·最近运行；进对话/装配/暂停恢复；群组空态、新建、管理成员、解散；详情返回保留页签与筛选 | 群组详情、群组进对话：缺口；任务数在月度 200 行上限时显示"≥N"；环境只分 设备/未绑定设备 | `wakers-parity.test.tsx`、`wakers-screen.test.tsx`；截图 `wakers`、`wakers-groups` | 部分 / 待补证 |
| 能力与资源 `/resources/plugins` | `/resources`（`tab` `view` `category` `page` `q`；`?tab=models` 等） | 插件·技能·连接器·知识库·WakerFlow·公开项目 六入口，分隔线后为 模型库·组件·信息源与记忆；插件市场/我的插件；分类侧栏；卡片；每页 12 张分页；详情侧栏；各页签加载/失败重试/空/无匹配；只加载当前页签 | 市场内一键安装、卡片内授权：以链接跳到既有管理/授权页；插件无分类字段，按接入方式推导 | `resources-parity.test.tsx`、`resources-aggregate.test.tsx`；截图 `resources`、`resources-skills`、`resources-wakerflows` | 部分 / 待补证 |

## 能力缺口（缺后端契约，保留真实禁用或失败语义）

| 入口 | 缺失契约 | 证据 | 剩余工作 |
| --- | --- | --- | --- |
| @Waker · 自动接入 | 无自动绑定新会话的接口 | `openbot/server/src/delivery/routes.ts` 只有逐段对话的一次性挑战 | 策略存储、开关、匹配规则的服务端契约 |
| @Waker · 接入申请 | 无申请记录与审批接口 | 同上；server 无 join/access request | 申请列表、批准、拒绝接口 |
| @Waker · 待确认状态 | 挑战已存储但无读取接口 | 同上 | 读取待确认挑战的 GET |
| 自主工作 · 事件触发自动任务 | 自动任务触发只支持 `schedule \| once \| webhook` | `openbot/server/src/automations/types.ts` | 内部事件源（消息、任务状态）触发 |
| 自主工作 · Flow 执行者 | 定时任务、职责、巡检只能由员工执行 | `routines`、`responsibilities` 契约 | 视需要扩展 |
| 自主工作 · 自动任务运行记录 | 列表与详情不返回触发记录 | `openbot/server/src/automations/routes.ts` | firings 读取接口 |
| 自主工作 · 定时任务编辑 | 无 PATCH | `routes/_authed/_app/routines.tsx` 注释 | 编辑接口 |
| Waker 管理 · 群组详情、群组进对话 | 无单个 `waker_group` 详情；无小组到会话的转换 | `src/lib/waker-groups/queries.ts`；`/group/new` 无预选参数 | 详情读取、`/group/new?groupId=` |
| Waker 管理 · 精确任务数 | `/api/tasks` 上限 200 行，无按执行者计数 | `openbot/server/src/tasks/routes.ts` | 按执行者聚合计数接口 |
| Waker 管理 · 云端/设备环境 | `AgentProfile` 无运行环境字段 | `src/lib/agents/queries.ts` | 员工运行环境字段 |
| 能力与资源 · 市场一键安装/卡片授权 | 安装需令牌、授权配置或 Composio 启用；授权流程在账户设置 | `src/lib/plugins/mutations.ts`、`routes/_authed/admin/plugins/*` | 维持跳转，或新增一步安装契约 |
| 能力与资源 · 插件分类 | `CatalogueItem`/`PluginServer` 无分类字段 | `src/lib/plugins/queries.ts` | 目录分类字段 |

## 下游页面（本轮未实查参考）

| 参考 | 我方 | 本轮处理 | 状态 |
| --- | --- | --- | --- |
| 对话 | `/bot`、`/channel/*`、`/group/*` | 继承 F1 外壳与令牌，消息区/输入区结构不改 | 待补证 |
| 员工详情 | `/wakers/$agentId`、`/assemble/$agentId`、`/bots/*` | 继承外壳；Waker 管理卡片进入详情与返回由 F2 断言 | 待补证 |
| WakerFlow 列表与编辑 | `/wakerflows/*` | 继承外壳；能力与资源 WakerFlow 页签链接到此 | 待补证 |
| 账户与设置 | `/settings/*` | 继承令牌 | 待补证 |
| 登录 | `/sign` | 继承令牌 | 待补证 |
| 管理后台 | `/admin/*` | 继承令牌 | 待补证 |

## 如何补参考证据

在打开参考实例的浏览器中，按同一视口（开发者工具设备模式设为 1696×783、1440×900、1280×800、1024×768，DPR 1，深色）逐页截图，并在控制台运行 `openbot/app/tests/parity/reference-measure.js` 的内容，它输出与我方测量 `.json` 同结构的盒模型、字号与颜色。截图前去除账号名、机器名、真实聊天、令牌和本机标识。文件放在 `<out>/reference/<theme>/<宽>x<高>/<路由 slug>.png|.json` 后，`bun tests/parity/diff.ts` 按每通道 8/255 阈值给出差异像素比例和差异图。只有同条件复测差异不超过计划门槛（约定区域内差异像素 ≤1%，关键锚点偏差 ≤2 CSS px），对应行才从"待补证"改为 1:1。
