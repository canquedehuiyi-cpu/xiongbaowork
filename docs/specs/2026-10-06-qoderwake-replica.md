# QoderWake 工作台复刻规格说明书

- 日期：2026-10-06（v2 多租户修订）
- 状态：**v2 待用户确认后进入 to-tickets 拆分**（v1 的单租户本地假设已被多租户决策推翻：个人用户即租户 / 共享库 RLS / 租户设备执行 / 完整套餐体系）
- 底座：`openbot/`（CopilotKit/OpenBot v0.1.0，MIT，commit 63f99cf）
- 范围约束：全部开发仅在 `d:\AI编程库\项目库\进行中的项目\xiongbaoshuziyuangong` 内执行，禁止写入 C 盘

---

## 1. 问题陈述

QoderWake CN 是"数字员工工作台"：用户雇佣具名 AI 员工（Waker），通过对话 @ 派活或让它自主工作，员工产出经"需要操作→查收结果"的人工闭环后交付。底座 OpenBot 已覆盖约 70% 形态（AI 同事花名册、审批收件箱、routines、技能/MCP 授权、每员工一台电脑、CEL 策略网关+审计），但存在四个结构性缺口：

1. **没有"任务"一等实体**——OpenBot 的世界观是 channel+run+approval，QoderWake 的世界观是"事"（看板：进行中/需要操作/已结束，按执行者/触发方式/状态过滤）。这是最大差距。
2. **Group 编组空转**——`users.groups`/`channels.allowed_groups` 已声明未启用（源码注释自认 #82），QoderWake 的 Waker/Group 双 Tab 无法落地。
3. **无设备绑定**——OpenBot 无 machineId 概念；最接近的是 host-access broker 桌面租约 + pushDevices 表。
4. **@ 派活未闭环**——群聊 `mentionedPeers` 已能解析 @ 指派，但 composer 的 `draft.agentId` 路由未接通，且 @ 之后只落群消息、不生成任务。
5. **模型全局绑死**——底座全部署只有一个模型（租户包 `model.yaml` 单 provider + `BOT_MODEL` 环境变量，解析于 `server/src/copilot.ts:181/205/403`），无法做到"每个员工自选系统内接入的任意模型"（如开发用 GPT-6、审核用 GLM-5.3）。
6. **组团协作无编排**——有群聊和 Bot 交接（`message_bot`），但没有"团队任务模板"：一个编程任务按步骤派给不同模型/角色的员工并串成流水线（开发→审核→交付）。
7. **底座是单租户架构**——OpenBot 的世界观是"一个部署 = 一个组织"（一次 `copilotkit login` 一个项目 key，`OPENBOT_SINGLE_USER` 本地模式）。产品要求**多租户 SaaS 部署：个人用户即租户**，注册开通、数据硬隔离、自带模型 key、套餐配额，且 Waker 动作在**租户自己的设备**上执行（这正是 QoderWake 用 machineId 绑定的原因：云端是编排面，本机是执行面）。

## 2. 方案概述

在 `openbot/` 仓库内以** fork 改造**方式开发（不另起项目），分四层推进：

```
                    ┌─────────────────────────── 云端控制面（多租户 SaaS）───────────────────────────┐
┌─ L5 产品层：平台目录（模型模板/技能/连接器上架）+ examples/qoderwake 品牌包 + 改名换肤
├─ L4 视图层：app 新增 注册登录/用量面板/任务看板(/tasks)/@Waker(/at-waker)/自主工作(/autonomous)
│            /能力与资源(/resources)/Waker 管理+Group Tab
├─ L3 租户层：全部业务表加 tenant_id + PostgreSQL RLS；plans/subscriptions 套餐与用量计数器
├─ L2 模型层：新表 tasks(任务状态机) + waker_groups + model_registry + registered_devices
│            + threads/thread_messages/run_events 本地化（替换 CopilotKit Intelligence 托管）
├─ L1 执行面：runner 桌面客户端 = agent-computer 打包，出站连控制面，按 machineId 路由动作
└─ L0 底座层：治理内核原样复用（策略网关/CEL/审计/routines/approvals/skills/plugins/handoff）
                    └──────────── 每个租户自己的电脑 = 数据面（浏览器/shell/文件/登录态全在本机）────────────┘
```

核心思路两条：①**任务看板是投影，不是引擎**——tasks 表由既有事实流（channel 消息、routine fire、审批、交接）派生写入，执行仍走 OpenBot 原有链路；②**云端只做编排与治理，执行面在租户设备**——策略网关/审批/审计留在服务端（这是多租户的安全边界），实际浏览器与命令动作下发到 machineId 对应的 runner 执行（这是 QoderWake 用 machineId 的原因，也让租户间执行面天然隔离）。

术语映射（全文档统一）：

| QoderWake | OpenBot 实体 |
|---|---|
| Waker | coworker（`agents` + `agent_profiles`） |
| 任务 | 新实体 `tasks` |
| 需要操作 | `approval_requests` (pending) + task 状态 `needs_action` |
| 查收结果 | task 状态 `awaiting_review` + deliverableRef |
| 自主工作 | routines / responsibilities / proactive / triggers |
| 能力与资源 | skills + plugins(MCP) + knowledge 源 |
| 我的分身 | 特殊 built-in coworker + memory 信息源配置 |
| machineId | 新实体 `registered_devices.device_id` |
| 模型库 | 新实体 `model_registry`（provider+credential+model 多条目） |
| 员工人设 | `agent_profiles.roleDescription` 扩展（性格/口头禅/工作守则，注入 bot-prompt） |
| 组团任务 | 新实体 `group_tasks`（步骤模板）+ 复用 `message_bot` 交接执行 |
| 租户 | `tenants`（与 users 1:1，个人即租户）+ 全表 `tenant_id` + RLS 策略 |
| 套餐 | `plans`（档位定义）+ `subscriptions`（租户当前档）+ 用量计数器 |
| 设备客户端 | 新组件 **runner**（agent-computer 桌面打包）+ `registered_devices` |

## 3. 用户故事（编号，可独立验证）

### A. 任务看板（QoderWake 首页等价物）

- **A1** 作为用户，我在侧边栏看到"工作管理 > 任务看板"，进入后看到统计条：任务总数 / 进行中 / 需要操作 / 已结束（默认数据周期=一个月，可切 一周/一月/全部）。
- **A2** 我可以点统计条任一数字过滤下方任务列表（按下态高亮）。
- **A3** 任务列表含列：任务名、执行者（Waker 头像+名，可点进员工详情）、来源（对话触发/自主工作/交接）、状态（进行中/需要操作/已结束-已完成/已结束-失败）、最近更新（相对时间）。
- **A4** 我可以用搜索框按任务名过滤，用下拉按 Waker/Group、触发方式、状态、数据周期组合过滤。
- **A5** 我可以切换"列表/泳道"两个视图；泳道视图按状态分三列（进行中/需要操作/已结束），卡片可拖拽仅进入"已结束"（归档语义），其余方向拖拽无效。
- **A6** 我点任务行"查看详情"，进入该任务关联的执行会话（channel 或 routineRun 详情），看到完整过程。
- **A7** "需要关注"区固定在看板上方，含两个 Tab：需要操作(n)/查收结果(n)；空态文案"暂无需要操作的任务——需要你确认、回答或补充信息的任务会显示在这里"。
- **A8** 当我在"需要操作"里批准/拒绝某审批，对应任务状态自动流转（批准→进行中；拒绝→已结束-失败），无需刷新。
- **A9** 当某任务产出附件/文件/组件结果，任务进入"查收结果"；我点"查收"后任务转"已结束-已完成"。

### B. @Waker 派活

- **B1** 我在任意频道 composer 输入 @ 出现 Waker 选择列表（仅我可见的员工，含 Group 展开后的成员）。
- **B2** @ 某 Waker 发送后：创建一条 task（来源=对话触发，执行者=被 @ 的 Waker），消息路由到该 Waker 并驱动其运行（接通 `draft.agentId` 路由）。
- **B3** 被 @ 的 Waker 的回复同时出现在频道与任务详情中；任务状态随 run 生命周期流转。
- **B4** 群聊中 Bot 交接（`message_bot`）产生的后续工作自动登记为子任务（来源=交接），在看板执行者列显示接手方。

### C. 自主工作

- **C1** 我在"自主工作"页看到所有 Waker 的 routines/responsibilities/proactive 任务清单：下次触发时间、启停开关、最近 N 次运行结果。
- **C2** 每次自主触发（routine fire / responsibility trigger）自动创建 task（来源=自主工作），initiator 沿用 OpenBot 的 `initiator_kind`（routine/responsibility/handoff），看板"无人值守"可过滤。
- **C3** 连续失败熔断（10 次）发生时，对应任务标"已结束-失败"并出现在"需要关注"区。
- **C4** 我可以在此页新建/暂停/删除 routine（复用现有 `/api/routines`，15 分钟下限与 20 条上限护栏保留）。

### H. 每员工模型选择（本次新增核心需求）

- **H1** 租户在"能力与资源 > 模型库"**自助接入**任意多个模型：从平台 provider 模板（OpenAI 兼容/Anthropic/Google/OpenRouter/国内兼容端点/自定义 base URL）选类型 + 填**自己的** API key（入租户加密 vault，沿用 `credentials` 机制）+ 模型名；形成该租户的"已接入模型列表"。Free 档可用平台提供的共享体验模型池，Pro 档解锁自定义 key（K1）。
- **H2** 我创建/编辑 Waker 时，可为其从模型库**单选**一个默认模型（存 `agent_profiles` 扩展字段）；未选则回落部署默认（现 `BOT_MODEL` 行为，向后兼容）。
- **H3** 一次运行（对话触发/@派活/routine 触发/交接接手）以**执行者员工的绑定模型**起跑——即"开发 GPT-6、审核 GLM-5.3"在同一任务里同时成立。
- **H4** 我可以在任务详情/员工详情看到该次运行实际使用的模型；审计行记录模型标识（沿用 `modelUsage` 表扩展）。
- **H5** 模型库条目被员工引用时不可删除，提示"3 位 Waker 正在使用"（引用计数保护）。
- **H6** 远程 AG-UI Bot（自带端点的员工）不受 H2 约束（模型在它自己端点），UI 明示"外部托管模型"。

### I. 组团协作（团队任务流水线）

- **I1** 我可以创建 Group（如"编程小组"）并为它定义**任务模板**：有序步骤，每步绑定成员 Waker+指令，例如 步骤1 开发（GPT-6 员工）→ 步骤2 审核（GLM-5.3 员工）→ 步骤3 汇总（分身）。
- **I2** 我给 Group 派一个任务（看板"@Group"或模板页"运行"）：系统按模板逐步执行，每步产出作为下一步输入上下文，各步骤在看板登记为父任务下的子任务（来源=交接），执行者显示对应员工。
- **I3** 任一步骤触发"需要操作"（审批/提问）时，父任务挂起进"需要关注"区；我处理后流水线从该步继续。
- **I4** 我可以中止流水线（剩余步骤标"已结束-失败"）或跳过某步（该步标跳过，继续下一步）。
- **I5** 步骤间执行复用底座**无人值守 run 通道**（`routines/run-turn.ts` 的 `createTurnRunner`：本地 runner + 平台线程锁 + 同一条 transcript），不新造执行通道；治理与真人发起的那一轮走同一道闸——每步都过 `guardBotTurn`（暂停）与 `headlessTurnRefusal`（Use Bots、模型白名单）并留审计。模板只是把"一次无人值守 run"编排成"N 步计划"。
  （2026-10-07 按 `docs/decisions/0001-组团流水线的执行通道.md` 改写原句"复用 `message_bot` 交接链路"：那句**按字面做不到**——`HandoffDesk.send()` 要求一次真实在跑的 run 签发的断言，而编排器不是 run，硬造断言等于同时绕过 grant、深度上限与审计，那正是选这条链路的全部理由。）
- **I6（编排态授权）** 谁能对一个 Group 派活＝对该 Group 有权限的人；**派活时逐位校验"这个人能不能用这一步的员工"**，不因"它在组里"而扩权。组里某位员工不为发起人所用时，这一步**拒绝开跑并给出可行动的失败原因**——不是悄悄换成别人，也不是拿平台身份替人跑（D11"平台控制目录、租户控制装配"在流水线上的落点就是这里）。

### D. Waker 管理

- **D1** "Waker 管理"页含 Waker/Group 双 Tab 与员工卡片墙；卡片显示头像、名字、角色（如 Backend Engineer）、运行状态（在线/休息/暂停）。
- **D2** 我可以"新建 Waker"：名字、头衔、角色描述、头像种子（boring-avatars）、可见性（私有/公开），复用 `/api/agents` + `agent_profiles`。
- **D3** 我可以创建 Group：命名+勾选成员 Waker；看板过滤器与 @ 列表中出现 Group 选项（激活 `users.groups` 空转字段 → 新建 `waker_groups` + `waker_group_members` 关系表）。
- **D4** 我可以按"运行状态"筛选卡片（在线 = 有活动 run；休息 = 空闲；暂停 = bot_lifecycle paused）。
- **D5** 我点员工卡片进入员工详情：它的职责、进行中任务、技能授权、最近审计流水（读现有 audit 数据）。
- **D6** 我可以为每个 Waker 编辑**人设**：性格语气、工作守则、口头约束（结构化字段注入 `shared/bot-prompt.ts` 组装的系统提示），与角色描述分开维护；人设可另存为模板复用给新员工。
- **D7** 每个 Waker 有独立的"员工装配页"：一屏管理它的 模型绑定(H2)/技能/插件连接器/人设/职责(routines)，即"单独授权安装"的落地入口；授权范围仅限我拥有或对我公开的员工。

### E. 能力与资源

- **E1** "能力与资源"页是统一聚合视图：技能（personal+deployment）、MCP/连接器（含授权状态）、知识/信息源、组件，四区一屏。仅前端聚合，复用现有 `/api/plugins`、`/api/skills`、knowledge 端点，**不动后端**。
- **E2** 我可以把某技能/连接器授权给指定 Waker 或整个 Group（授权对象从"仅 Bot"扩展到"Group 展开为成员批量授权"）。
- **E3** "安装"语义：目录内的技能/连接器/MCP 由管理员上架（保留现有治理边界），员工所有者在装配页给自己的员工**自助勾选安装/卸载**，无需管理员逐次审批；每次安装写审计行。
- **E4** 模型库作为"能力与资源"第五区（对应 H1）。

### F. 设备执行面（runner，多租户核心改造）

- **F1** 首次登录进入"我的分身"引导：选择信息来源（本地文件夹/知识源声明），保存后生成特殊 built-in Waker"我的分身"，其角色描述注入所选来源。
- **F2** **runner 桌面客户端**：将 `agent-computer`（Chromium + workspace + shell + 录屏）打包为 Tauri 客户端，安装后**出站** WebSocket 连接中心 server（设备发起，无需公网 IP/端口映射），注册 `device_id`（machineId，UUID 持久化在本机配置）；一租户可注册多台设备并命名。
- **F3** Waker 的浏览器/shell/文件动作由服务端策略网关决策后，按任务绑定的 device_id **下发到对应 runner 执行**；CEL 策略、审批、审计、密钥脱敏全部仍在服务端，runner 只是受治的执行臂。
- **F4** 设备在线/离线：员工卡片与看板显示设备状态；设备离线时新任务进入等待队列（复用 `work_items` 租约机制），设备回线自动续跑；离线超过阈值任务标"需要操作"提醒用户上线。
- **F5** Web 端 URL 支持 `?machineId=` 过滤"只看待本机执行的任务"（与 QoderWake 行为一致）；无匹配设备时显示"Waker 们正在休息"空态。
- **F6** 服务端 Docker 电脑（底座 supervisor 链路）**降级为开发/演示回退**：`TENANT_RUNTIME=cloud` 时 Waker 跑在服务端容器（本地无 runner 也能全流程联调），生产租户默认 `TENANT_RUNTIME=device`。

### J. 多租户账号与隔离（个人用户即租户）

- **J1** 注册/登录：邮箱+密码（Better Auth 自有凭据路径）+ 可选 Google/GitHub OAuth；注册成功即开通租户（初始化：Free 档订阅、"我的分身"、空模型库引导页）。
- **J2** 全部业务表加 `tenant_id` 并启用 PostgreSQL **Row-Level Security**：连接会话注入 `app.tenant_id`，策略强制过滤；API 层同时带租户上下文做双保险。跨租户访问一律 404（不暴露资源存在性）。
- **J3** 我的 Waker、任务、审批、技能、连接器授权、模型 key、设备仅我可见；本期无跨租户共享/协作。
- **J4** 模型凭据、连接器 token 按租户入加密 vault；底座"管理员上架目录"升级为**平台级目录**（provider 模板、官方技能/连接器），租户在目录内自助开通到自己的账户。
- **J5** 平台运营后台（原 admin 页面收敛为平台工具）：租户列表/封禁恢复/封禁即冻结其任务队列与 runner 连接、按租户查用量与审计。
- **J6** 原 `OPENBOT_SINGLE_USER` 仅保留为开发模式；产品默认注册制，公网部署强制登录。

### K. 套餐与用量（Free/Pro）

- **K1** 套餐定义（seed 数据，可配置）：Free = 2 Wakers / 50 任务·月 / 1 设备 / 平台目录基础模型；Pro = 10 Wakers / 1000 任务·月 / 5 设备 / 自定义模型接入。配额在**服务端写路径强制拦截**（非仅 UI 灰置）。
- **K2** 用量面板（对应 QoderWake 左下角"用量"）：当前档位、本周期 Waker 数/任务数/模型 token 估算（聚合自 `model_usage` + runner 上报）。
- **K3** 升级入口：档位对比页 + 手动/种子切换订阅；**不接支付渠道**（预留 provider 接口）。
- **K4** 超额返回结构化错误码（含"已用/上限/升级链接"），前端统一引导升级或清理。

### G. 品牌与本地化

- **G1** 通过租户包 `examples/qoderwake`（brand.yaml/theme.css/agents.yaml/skills.yaml/knowledge.yaml）替换默认 fintech：产品名"熊宝数字员工"、中文界面文案、种子员工（含 Backend Engineer 等角色卡）。
- **G2** 开发模式保留 `OPENBOT_SINGLE_USER=true` 一键起全栈（联调用），生产为注册制多租户（见 J6）；开发期 runner 与 server 可同机部署。

## 4. 已定决策

| # | 决策 | 理由 |
|---|---|---|
| D1 | 在 `openbot/` 内 fork 改造，不复制出第二仓库 | 保持可 `git pull` 跟进上游（上游周更），改造集中在新增文件+少量挂点 |
| D2 | tasks 是**派生投影表**，执行引擎不变 | 避免与 channel/run 双轨；审批/审计/routine 全部复用 |
| D3 | ~~MVP 保留 CopilotKit Intelligence~~ **v2 推翻：线程/消息/运行事件持久化本地化到 PostgreSQL**（新表 `threads`/`thread_messages`/`run_events`，照底座 `group_messages` 已验证的 PG 模式） | 多租户下托管 Intelligence 是单项目 key 的全局瓶颈 + 数据驻留风险，与租户隔离目标直接冲突；本地化从"二期"提前为 P0 |
| D4 | Group 用新关系表实现，不复用空转的 `users.groups` | 后者语义是 IdP 组，源码明示等 SSO 填充；混用会污染权限判定 |
| D5 | machineId = runner 设备注册 ID；**执行面默认在租户设备**，服务端 Docker 电脑降级为开发回退（F6） | 用户拍板"租户自己的设备"；云端零执行面使租户间隔离天然成立 |
| D6 | "查收结果"实现为任务状态 `awaiting_review` + deliverableRef（指向 attachment/workspace 文件/组件），不新建审批类型 | approval 语义是"放行动作"，查收是"验收产出"，两码事 |
| D7 | 泳道拖拽仅允许"→已结束"单向 | 任务状态由事实流驱动，人工只允许归档，防止状态机逆行 |
| D8 | 开发环境：Windows 宿主 + Docker Desktop（WSL2 后端）+ Bun 1.3.14；代码与数据卷全部落 D 盘 | OpenBot 脚本为 bash+Docker；用户禁止 C 盘执行，Docker Desktop 数据目录需指到 D 盘 |
| D9 | 模型库 = 新表 `model_registry`（provider/base_url/credential_ref/model_name/enabled），员工绑定存 `agent_profiles.model_ref`；运行起点在 `copilot.ts` 的 `RuntimeModel` 解析处按执行者覆盖（该类型已贯穿全部 run 入口，改造收敛） | 现状模型全局唯一（model.yaml+BOT_MODEL），`RuntimeModel` 是现成的注入接缝；凭据复用加密 vault，不新建密钥链路 |
| D10 | 组团协作 = `group_task_templates`（有序步骤：成员+指令+输入映射）+ 一次运行实例；每步执行**复用底座既有的无人值守 run 通道**（暂停闸、Use Bots/模型白名单、线程锁、审计口径原样生效），不新造通道；每步投影为父任务下子任务（ADR-0001＝A，见 `docs/decisions/0001-组团流水线的执行通道.md`） | 底座交接台的入口需要一次真实 run 签发的断言，编排器拿不到它；无人值守通道是同一仓库里已经为"没有人在看"的工作打通的那条路 |
| D11 | "单独授权安装"边界：**平台控制目录**（哪些 provider 模板/技能/连接器可用），租户控制**装配**（给自己的员工勾选）；每次安装/卸载写审计 | 保留底座"grant 是门"的治理模型，目录/装配两层恰好映射平台/租户 |
| D12 | 租户 = users 1:1（`tenant_id` 初始等于 user_id），全表加列 + RLS；**不引入独立 tenants 管理面**直到团队版 | 迁移最简单，且为"个人升级团队"（未来）留一层间接 |
| D13 | runner 协议 = 设备**出站** WSS 长连 + 动作 RPC over 该连接 + 心跳；复用 host-access broker 的租约/审批/审计模型扩展 deviceId 路由 | 免公网 IP、免入站穿透，Windows 防火墙友好；底座已有同型机制 |
| D14 | 套餐 = seed 配置 + 服务端写路径配额拦截 + 用量计数器表；升级入口不做支付 | 用户拍板"完整套餐体系"；支付渠道明确不做（见 §6） |
| D15 | 跨租户默认 404 而非 403；RLS 为主防线、应用层租户上下文为副防线，两层独立生效 | 防资源探测；任一层失守另一层兜底 |

## 5. 测试决策

**最高接缝 = REST API（`/api/tasks`、`/api/waker-groups`、`/api/devices`）+ 任务投影写入器（事件→task 状态机）**。功能验证优先打这两层，UI 只做冒烟。

- 沿用底座既有接缝：策略网关（`computer/gateway` 测试套件）、routines（sweep/熔断）、approvals 均有现成测试，改造后必须全绿。
- 新增测试：
  1. **投影器单测**（`bun test server/tests/tasks`）：给定 channel 消息/routine fire/审批流转/交接事件，断言 tasks 行状态与字段——这是复刻的核心正确性。
  2. **API 集成测试**：过滤组合（执行者×触发方式×状态×周期）、泳道归档、@派活端到端建任务。
  3. **租户包同步测试**：qoderwake 包 checksum upsert 幂等。
  4. **设备注册测试**：device_id 上报→host-access 校验拒绝陌生设备。
  5. **模型解析测试**：给定员工绑定 GPT-6/GLM-5.3 两条 registry 记录，断言各自 run 拿到的 `RuntimeModel` 正确、未绑定回落默认、被引用条目删除被拒（H5）。
  6. **组团流水线测试**：模板三步运行→子任务按序创建、步骤间上下文传递、审批挂起恢复、中止/跳过语义（I2-I4）；断言每步走的是**既有无人值守 run 通道**（同一线程锁、同一 transcript、同一套暂停/白名单闸）而非新通道，并断言 I6：发起人用不了的员工 ⇒ 该步拒绝开跑且**不会换成别人代跑**。
  7. **RLS 跨租户测试**：双租户互查全部业务端点+直查 SQL 双路径，断言不可见且返回 404；封禁租户后队列冻结。
  8. **配额强制测试**：Free 档建第 3 个 Waker / 第 51 个月度任务 / 第 2 台设备被服务端拦截，错误码含已用/上限。
  9. **runner 协议测试**：设备注册→动作下发→离线任务排队→回线续跑；断言动作不经服务端容器（device 模式）。
  10. **线程本地化测试**：会话跨 server 重启可恢复、run 事件可重放，全程无外部 Intelligence 调用。
- "完成"定义：`bun run typecheck && bun run lint && bun run test` 全绿 + `bash scripts/start.sh` 在本机跑通 G2 单用户模式 + 手工过 A1-A9/B1-B4/C1-C2/D1-D3 主路径。

## 6. 明确不做

- ❌ Qoder SaaS 账号体系（Free 档位、用量计费、云端个人头像服务）——本地单用户替代
- ❌ 拟人化动画形象/桌面宠物
- ❌ mobile/ Expo 端改造（现有客户端连我们的 server 即可）
- ❌ 替换/本地化 CopilotKit Intelligence（二期，见 D3）
- ❌ 多租户 SSO/SAML/SCIM 定制（底座有，不为其开发）
- ❌ gVisor/runsc、SPIRE mTLS（Windows 宿主不支持/不需要）
- ❌ Slack/Teams/短信触达通道（reachability）
- ❌ 修改上游 OpenBot 的既有行为语义（网关、CEL、熔断、审计）——只新增、不颠覆
- ❌ 按任务内容自动选模型（智能路由）——本期只做人工绑定，模型由人决定
- ❌ 员工间并行发散协作（同一步多员工竞争产出）——组团模板本期只支持串行步骤
- ❌ 支付渠道对接（Stripe/微信/支付宝）——套餐只到"升级入口+手动切换"
- ❌ 跨租户协作/员工共享市场——个人即租户，租户间零可见
- ❌ deployment-per-tenant 强隔离形态——已拍板共享库 RLS
- ❌ 团队版（一租户多成员）——D12 留了间接层，本期不实现

## 7. 补充说明

- **上游风险**：OpenBot 周更且 README 自称 Alpha；D1 决策（fork+新增文件为主）就是为此买的保险。每次同步上游后跑 `bun run test:smoke`。
- **关键源码坐标**（分析已定位）：任务投影写入挂点 `server/src/app.ts` 路由层 + `shared/work-owner.ts`；@路由缺口 `app/.../channel-chat.tsx:1002`（draft.agentId 未路由）；交接 `mentionedPeers`（group.ts:467）+ `agents/handoff*.ts`；审批收件箱 `approvals.ts:73`；设备改造 `server/src/host-access/broker.ts` + `desktop/src-tauri/`；**模型注入接缝 `server/src/copilot.ts:181/205/403`（`RuntimeModel` 贯穿所有 run 入口）+ `credentials.ts:259 resolveModelApiKey` + 现状全局配置 `examples/fintech/model.yaml`/`.env BOT_MODEL`**；人设注入 `shared/bot-prompt.ts`；前端加页 = `app/src/routes/_authed/_app/` 文件路由 + TanStack Query。
- **环境前置**：本机需 Docker Desktop（数据目录迁 D 盘）、Bun 1.3.14+、Node 24、每个租户自备模型 API Key（BYOK，见 H1）；runner 构建需 Rust/Tauri 工具链（cargo 目标目录指 D 盘）；Intelligence 本地化后不再需要 `copilotkit login`。
- **交付节奏建议**（供 to-tickets 参考）：**M0 租户地基**（J 组 + D3' Intelligence 本地化 + 全表 tenant_id/RLS 迁移 + 注册开通流）→ M1 任务模型+看板（A 组）→ M2 模型库+人设+自助装配（H/D6-D7/E 组）→ M3 runner 设备执行面（F 组，含开发回退模式）→ M4 @派活+自主工作+组团流水线（B/C/I 组）→ M5 套餐用量（K）+ Waker/Group 管理页（D1-D5）+ 品牌（G）。M0 结束即可多用户注册试用；M2 结束即可体验"开发 GPT-6、审核 GLM-5.3"；M3 是执行面真正落地的节点。
