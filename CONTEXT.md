# 术语表（CONTEXT）

本项目的语言必须与代码里的名字一致：一个词如果在库里另有拼法，以库为准并改这里。命名漂移的代价不是难看，是两个人对着同一个功能说不同的事。

| 中文 | 代码里的名字 | 是什么 | 不是什么 |
| --- | --- | --- | --- |
| 租户 | `tenant_id`，等于 `users.id` | 一个人即一个租户（决策 D12）；业务表都带这列，RLS 按它切（**例外**：`deployment_packages` 豁免，见迁移 `0062`） | 不是"组织/团队"。团队版留作未来一层间接，现在没有 tenants 管理面 |
| 平台作用域 | `runAsTenant("platform")`、`tenant_id = 'system'` | 目录与内置内容的写入口；策略里"读得到 `system` 行"是给所有人的目录 | 不是"超管租户"。**读与写自迁移 `0072` 起是两条策略**：`FOR SELECT` 允许 `system`（人人看得懂目录），`FOR INSERT/UPDATE/DELETE` 只认"本租户，或当前处于 `platform` 作用域"——所以"能看见不等于能改"由**数据库**守，应用层比对 `currentTenant()` 是副防线（`waker-groups/store.ts` 仍留着，理由见工单 026）。`deployment_packages` 是唯一豁免表（`0062`） |
| 员工 / Waker | `agents` + `agent_profiles` | 有名字、角色、人设、模型绑定与授权的数字同事 | 不是 Bot 的口语别名混用：代码与接口里它叫 Bot/agent，界面上叫员工 |
| 分身 | `avatarAgentId(tenantId)` = `avatar-<tenant>` | 注册时自动配给每个人的"我自己那位"同事 | **不计入座位配额**：它是本人的声音，不是买的一个席位 |
| 小组 | `waker_groups` + `waker_group_members` | 一组员工排好顺序之后的名字 | 不是 `users.groups`（那是人的组织成员关系，员工不是人）；组**不持有权限**，也不是可被授权的对象 |
| 装配 | `agent_profiles`（模型绑定 `modelRef`、人设 `persona`、技能/连接器授权） | 给某个员工挑它能用什么 | 不是安装：平台控制目录，租户控制装配（D11） |
| 授权 | grants（技能/连接器/交接 `mayAddress`） | 一道一次一行、每次读都算的闸 | 不是一次性的开关；也不因入组而扩权 |
| 任务卡 | `tasks`，唯一写入口 `src/tasks/projector.ts` | 看板上的那一行；只有投影器写它，所以它能被重放 | 不是工作队列（`work_items`）；不是运行记录（`thread_runs` / `routine_runs`） |
| 来源 | `tasks.source`：`chat / routine / responsibility / handoff / group_run` | 这张卡"谁起的" | 不是 `initiator_kind`（表里没有这列；无人值守过滤现在用 `source` 派生） |
| 投影 | `board.opened / needsAction / resumed / finished` | 事件→任务状态机；按 `runRef` 找卡 | 不是通知（`notify` 只推看板刷新） |
| 无人值守 | routine 触发、responsibility 事件、proactive 巡检 | 没有人在屏幕前的那一轮 | 与"离线"不同：离线说的是**设备** |
| 设备 | `registered_devices` + `runner.action/<tenant>/<device>` | 租户自己机器上的执行面；动作出站 WSS | 不是部署容器；容器模式叫 cloud |
| 在线/休息/暂停 | 派生：`tasks.status` 有 running、`agents.hidden` | 卡片状态行三个词的数据来源 | 不是存的状态列；也没有"活动 run"那列（spec D4 原话与本实现的差异是**已知偏离**，见 `tickets/023`） |
| 档位 | `plans` + `subscriptions` + `usage_counters` | 完整套餐体系，**不接支付** | 不是付费墙：`/plans` 的动词是"切换" |
| 配对 | `device_pair_codes`（一次一用） | 设备接入的短码 | 不是一次性令牌可复用：配额不足时 402 **不吃码** |
| 品牌包 | `TENANT_PACKAGE_DIR` + `examples/qoderwake` | 品牌/员工/技能/渠道/主题的声明式租户初始内容，按 checksum 同步 | 不是数据库迁移；也不是 i18n 框架（024 明确不引入） |
| 需要关注 | 看板上方区域 `AttentionRegion`（`tasks.tsx`），两个 Tab：`需要操作 (n)` / `查收结果 (n)` | spec A7 那块固定区：**问人的**都在这儿——`needs_action` 与 C3 的 `failed`；`awaiting_review` 归"查收结果" | 不是泳道（泳道是看板的分区渲染，见 `LANES`/`laneOf`，一个状态恰好落一条）；也不是"未读"计数 |
| 封禁 | `revoked_access`（按规范化邮箱）+ `isAccessRevoked()` | 管理员收回访问：会话进不来，**且无人值守的活也停**——设备令牌被拒 ⇒ 队列领不动，routine/responsibility 触发记 `skipped`（J5） | 不是删号，也不是停用单个员工（那是 `agents.hidden`）；`skipped` 不是 `failed`：解封后同一条 routine 直接续跑，不需要先修一个失败 |
| 跨租户默认 404 | 例：`cardIsHere()` 先问存在性，再判泳道（D15） | 别人的 id 进来看不到＝不存在，因此回 404；形状不合法的 id 也回 404 | 不是 403，也不是 409——那两种都在**确认这个 id 存在**；也不是"抛异常说没找到" |

## 两个必须一起记住的口径

- **两个名字别混**：浏览器地址上是 `/tasks?crew=a,b`（`tasks.tsx` 的 search 参数），打到服务端是 **`/api/tasks?executors=a,b`**。带的是**成员列表**而不是组 id，所以改名不会让已打开的链接失效，看板上看到的与逐个员工查到的是同一批卡。`executors=` 给了空值表示"组里没人"＝没有卡，而不是"没过滤"。
- **交接（handoff）的执行入口外部进不来**：`HandoffDesk.send()` 要求一次真实 run 签发的断言。组团流水线因此不能按 spec D10 字面复用 `message_bot`；决定与被否的方案见 `docs/decisions/0001-组团流水线的执行通道.md`。

## 判回归的口径（不是术语，但同属"共同语言"）

**比失败测试名字的多重集，不比总数。** 有一族参数化用例每次超时的条数会漂（同一批名字，总数 45↔58）。方法在 `docs/deployment-qoderwake.md` §5。
