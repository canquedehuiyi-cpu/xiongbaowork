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

下列"计划条目"逐字取自计划的页面对照表，实施后由 F2–F4 回填。

| 参考页 | 我方路径 | 计划条目 | 数据状态 | 状态 |
| --- | --- | --- | --- | --- |
| 任务看板 `/work-management` | `/tasks` | 工作记录横幅、数据周期、四卡、关注区（需要操作/查收结果）、列表/泳道、搜索与员工/群组·触发·状态·周期筛选、详情/审批/查收 | data / empty / 筛选无结果 / 加载 / 失败重试 | 见 F2 回填 |
| @Waker `/at-waker` | `/reachability` | 左侧标题和四个接入入口、右侧自绘示意、已接入聊天表格/卡片、搜索、聊天类型/模型/状态筛选、空态、行操作；接入 IM 聊天/机器人与账号/自动接入/接入申请逐项核对 | data / empty | 见 F3 回填 |
| 自主工作 `/autonomous-work` | `/autonomous` | 标题与右侧主按钮、四指标单面板、搜索与执行者/触发类型/状态/排序、新建/编辑/详情/启停；定时/事件/API 三触发，员工/Flow 两执行者 | data / empty（参考所见为空态） | 见 F3 回填 |
| Waker 管理 `/management`、`?tab=groups` | `/wakers`、`/wakers?tab=groups` | 页头与新建、唤醒者/群组、名称角色搜索、运行状态/角色/环境/排序、计数、卡片网格与创建卡、卡片字段、群组空态/新建/管理/详情/进对话、键盘与反向导航 | data / empty（参考群组为空态） | 见 F2 回填 |
| 能力与资源 `/resources/plugins` | `/resources`（`?tab=`） | 插件、技能、连接器、知识库、WakerFlow、公开项目六入口；插件市场/我的插件、分类侧栏、卡片、分页、详情；六页签默认/空/失败/筛选/安装或授权；模型库等独有入口纳入同一壳 | data / empty / 失败 | 见 F4 回填 |

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
