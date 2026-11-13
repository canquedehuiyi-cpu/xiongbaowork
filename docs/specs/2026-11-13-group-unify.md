# 群组与群聊合一设计稿（做法 A：先挂接再收口）

状态：待用户审阅（第 11 节 4 个问题待定；第 9 节 34 条已有断言的改动待逐条批准）
日期：2026-11-13
依据：用户决定（2026-11-13，原话选项）：
1. 做法 A「先挂接再收口」：每个群聊背后挂一个 `waker_groups` 记录（`channels` 加 `waker_group_id`）。成员、顺序、头像、组团流程、看板继续用现有那套；界面上只剩一个概念，设置都放在它上面；旧接口尽量不动。
2. 现有群组「自动转成群聊」：每个有 2 位以上员工的群组，升级时自动生成一个同名的、可以聊天的群组，成员、顺序、头像、流程都带过去；不足 2 位的先保留，标「待补成员」。
3. 界面统一叫「群组」：保留「群组」这个词，群组里可以直接聊天；侧边栏只剩「群组」一节（原来的「群聊」并进来）；新建入口统一为「新建群组」。

前序：只读调查报告（基于 `origin/main` = `ac2e245e`，下称「报告」）。本稿的盘点基线相同：分支 `docs/group-unify-spec`，基于 `ac2e245e`。路径简写：S = `openbot/server/src`，A = `openbot/app/src`；仓库根的文件写作 `<根>/…`。

---

## 0. 一句话

数据上保持两张表各管各的：消息、人员、回答顺序仍然由群聊（`channels` 一族，上游原生）负责；名字、头像、组团流程、看板过滤仍然由群组（`waker_groups`，熊宝自加）负责。两边用一列 `channels.waker_group_id` 一对一挂上。**群聊一侧是真相，群组一侧是镜像**：所有改员工、改顺序、改名的写入口，写完群聊都会立即把镜像改写一遍；另有开机巡检和打开设置时的自愈，兜住镜像偏差。界面只剩「群组」：侧边栏一节、员工页一个页签、一个「新建群组」表单、群组聊天页顶栏一个设置面板。

---

## 1. 已定决定一览

| # | 问题 | 决定 | 章节 |
|---|---|---|---|
| D1 | `waker_group_id` 列 | `uuid`，可空，外键指向 `waker_groups(id)`，`ON DELETE SET NULL`；「未删除的频道」范围内唯一（部分唯一索引）；不写进 Drizzle 的 `core.ts`，按 `approvals/extra-columns.ts` 的做法用 `sql` 片段读写 | 3.1 |
| D2 | 迁移放哪 | 恢复叠加目录 `openbot/server/recovery/recovery-20261018-v1/sql/`，编号 **0206**（挂接）与 **0207**（移交，3.1.1），PR3 的台账表用 **0210**（0208、0209 已被 main 占用，见 3.2）；`drizzle/` 不动 | 3.2 |
| D3 | RLS 与守卫 | 不新增 RLS 策略（列跟着 `channels` 现有策略走）；改写 `openbot_team_channel_guard`，让它认得新列；新增一个挂接校验触发器；台账表照 `0072` 的形状建四条策略 | 3.3 |
| D4 | 顺序谁是真相 | 群聊一侧：`channel_agents` 定成员，`group_bot_threads` 的最早时间戳定顺序（上游 `order()`）。`waker_group_members.position` 是镜像 | 4.1 |
| D5 | 成员同步方向 | 写入只走群聊一侧，写完立即改写镜像。旧接口 `PUT /api/waker-groups/:id/members` 遇到已挂接的群组时，翻译成群聊的加人、移人、重排 | 4.2 |
| D6 | 新建时挂接 | **建群即挂**：所有建群聊的路径（`POST /api/groups`、「新对话」多选、`propose_group`、新表单）建完立即建一条群组并挂上 | 4.3 |
| D7 | 现有群聊补群组 | **升级时一并补**（开机任务第二阶段），并保留「打开设置时补建」作为自愈兜底 | 5.4 |
| D8 | 现有群组转群聊 | 开机任务第一阶段，创建者 = `users.id = waker_groups.tenant_id`；可用员工 2–20 位才转；其余情况保留并标状态；不自动去重 | 5.1–5.3 |
| D9 | 名字谁是真相 | 群聊的 `channels.title`；群组 `name` 跟着改，撞名时保留原名并记日志 | 4.4 |
| D10 | 接口 | 新增 3 个路由、扩展 3 个；`/api/groups`、`/api/channels`、`/api/portraits`、`/api/group-pipelines`、`/api/tasks` 不改 | 6 |
| D11 | 员工页「群组」页签 | **保留**，内容改为「我建的群组」卡片：已挂接的可以打开聊天，待补成员的可以补人，未开始聊天的可以开始聊天 | 7.2 |
| D12 | 新建群组 | 一张表单（名称 + 按先后勾选员工，2–20 位），放在 `/group/new` 页和员工页对话框两处，一次调用 `POST /api/waker-groups` 建好。新建的群组不允许少于 2 位 | 7.3 |
| D13 | 解散 | 只有创建者能解散：群聊软删（隐藏，不清消息），群组硬删（级联删流程模板和运行记录，与现在解散群组的效果一致），头像一并删，看板上的任务卡保留（被移交过的群组，卡已在接手人名下）；有流程正在运行时拒绝。待用户确认，见 Q1 | 7.5 |
| D14 | 看板链接 | 保持 `crew=<成员列表>`，与 `CONTEXT.md` 的口径一致，不改成 `group=` | 7.4 |
| D15 | 术语 | 界面、服务端返回给人看的文字、给模型看的工具描述，一律把「群聊」改为「群组」；IM 接入（`reachability`）里的「群聊或私聊」指的是第三方 IM 的群，不在此列 | 8 |
| D16 | 创建者退群或被停用 | 群组归最早加入、仍在群里、账号未停用的人（平手按邮箱），头像、视频、流程模板、运行记录、看板任务卡全部跟走；最后一人离开时软删聊天、群组留给他；流程运行时创建者不能退群 | 3.1.1 |

---

## 2. 现状要点与对报告的更正

报告的主体结论经核对成立。下面列出报告有误或漏掉、并且影响设计的地方，**以代码为准**：

1. **群聊员工数上下限的位置**：报告写 `group.ts:104-107`，实际在 `S/channels/group.ts:125-128`（`MIN_GROUP_BOTS = 2`、`MAX_GROUP_BOTS = 20` 和两句拒绝文案）。
2. **漏了 `channels.created_by`**：迁移 `0122_team_tenant.sql:40-42` 给 `channels` 加了 `created_by text`，默认值取写入帧（`current_setting('app.tenant_id')`），**没有写进 Drizzle schema**。数据库层判断「谁是共享群的创建者」用的是这一列（`openbot_team_channel_creator`），不是应用层 `creatorOnly` 用的 `people(channel)[0]`（`group.ts:1592-1597`）。0122 之前已有的行这一列为 NULL。
3. **漏了「以后加的列一律冻住」**：`0128_team_group_bots.sql:204-250` 的 `openbot_team_channel_guard`（现行版本是 `0179_team_channel_guard_title_opening.sql`）规定：在 `platform` 帧以外，共享群（`tenant_id='team'`）的 `channels` 行只有活动列能改，名字类列只有创建者能改，**其余列（包括以后新加的列）谁也不能改**。0128 的注释还写明：以后的数据迁移要改共享群的行，必须在 `platform` 帧里做，迁移器的空帧也会被拒（超级用户同样拒，因为触发器不是 RLS）。所以新列必须同时改写这个守卫，否则创建者也写不进 `waker_group_id`，外键的 `SET NULL` 也会被拒。
4. **迁移编号**：恢复目录现在最大是 `0204_bao_role_presets.sql`；日志 `meta/_journal.json` 共 185 条，中间有空号；快照只到 `0107_snapshot.json`，0108 以后的迁移不配快照。（合入 main 时 0205 已被 `0205_skill_assets` 占用，本稿的迁移从 0206 起，见 3.2。）`drizzle/` 停在 0080，被叠加层测试按字节冻结（`openbot/server/scripts/migrate.ts:29-37` 的注释）。
5. **线程 id 不能在 SQL 里生成**：`group_bot_threads.thread_id` 和 `intelligence_channel_mappings.thread_id` 由 `threadIdentity.mint()` 生成（`S/channels/thread-identity.ts`），里面带部署名的摘要。所以「群组转群聊」**只能在服务端 TypeScript 里做**，不能写成 SQL 数据迁移。这一点决定了第 5 节采用开机任务。
6. **`system` 租户的群组只是理论上存在**：全仓库写 `waker_groups` 的只有 `S/waker-groups/store.ts:135` 和 WakerFlow（`S/wakerflows/store.ts:1336`），都在本人帧里写，没有任何种子或目录会写 `system` 群组。
7. **路径**：报告里的 `development-environment-xiongbao.md` 实为 `openbot/docs/development-environment-xiongbao.md`；`scripts/ci/…` 实为 `openbot/scripts/ci/…`；`CONTEXT.md` 在仓库根。
8. **租户和用户的关系**：`S/db/schema/tenant.ts:4-8` 和 `<根>/CONTEXT.md` 都写明「一个人即一个租户」，`tenant_id` 等于 `users.id`。单用户安装下那个人是 `dev-local-user`（`0200_single_user_identity.sql` 的注释）。`team` 只是共享行的戳，不是帧：没有人以 `team` 身份执行，`users.id` 也被约束为不能取 `system`、`platform`、`team`（0122:34）。因此**群组永远属于某个个人租户，群聊（共享群）永远戳 `team`、`created_by` 是创建者**。两者一挂接就跨了戳，这是 3.3 节守卫设计的出发点。

---

## 3. 数据

### 3.1 新列 `channels.waker_group_id`

| 属性 | 决定 | 理由 |
|---|---|---|
| 类型 | `uuid` | 与 `waker_groups.id` 一致 |
| 可空 | 可空，无默认值 | 单聊永远为 NULL；群聊在挂上之前的极短窗口内为 NULL；外键 `SET NULL` 之后也是 NULL |
| 外键 | `REFERENCES waker_groups(id) ON DELETE SET NULL` | 不用 `CASCADE`：删群组不能连带硬删频道（频道只做软删）。不用 `RESTRICT`：现有的 `DELETE /api/waker-groups/:id` 必须继续能删 |
| 唯一 | 部分唯一索引：`waker_group_id IS NOT NULL AND deleted_at IS NULL` | 一个群组同一时刻只对应一个未删除的群聊；已软删的频道保留原值，之后可以给同一个群组重新开一个聊天（7.2「开始聊天」） |
| 普通索引 | 部分索引：`waker_group_id IS NOT NULL` | 外键 `SET NULL` 动作和反查需要（包括已软删的行） |
| Drizzle | **不写进** `S/db/schema/core.ts`（上游文件）。照 `S/approvals/extra-columns.ts` 的写法，在新文件 `S/waker-groups/channel-link.ts` 里声明 `sql` 读写片段，文件头登记「列、类型、迁移号」 | 与 `created_by` 的处理一致，同步上游零冲突。代价是 `drizzle-kit push` 会把它当多余的列删掉，部署库本来就禁止 push |

挂接的**归属规则**（全文统一叫「所有者」）：

- 共享群（`tenant_id = 'team'`）：所有者 = `created_by`；`created_by` 为 NULL 的共享群没有所有者，不挂接（0128 注释说 P11 之前没有代码写共享群，这类行应为零，开机任务会计数）。
- 个人的多员工频道（P11 之前的旧行，`tenant_id` = 某个用户）：所有者 = `tenant_id`。
- 被挂的群组必须满足：`waker_groups.tenant_id = 所有者`，并且不是 WakerFlow 内部群组（`waker_flows.group_id` 没有指向它）。
- `created_by` 会随 3.1.1 改变，只经 0207 的移交函数改（对外的 `xiongbao_team_channel_hand_over` 与内部的 `openbot_team_channel_hand_over_*`）。

### 3.1.1 创建者退群后的归属

> 依据：用户 2026-11-13 的决定「创建者退群后群组归群里最早的成员」，以及同日对待定点的裁定（第 11 节 Q5–Q8）：流程正在运行时创建者不能退群；最后一个人退群时软删聊天、群组仍归他；移交时全部跟走；被管理员停用的创建者算作退群、立即移交，「最早的成员」排除已停用的账号，账号恢复后不还；停用的人一并移出他所在的所有共享群（恢复后须重新邀请）；0207 上线时对已停用的账号补做一次；只剩停用成员的边角情况退群照常成功、暂不移交、由自愈补上；绕过服务的退群（直接删成员行、运维 SQL、删账号时的外键级联）按方案 A 处理：不当场移交，靠自愈点补上。
>
> 调查基线：`feat/gu-data` 的 `00311419`（源码行号以它为准，测试行号已对到合入 main 之后的 `4c66c17b`）。本节路径简写另加：T = `openbot/server/tests`，R = `openbot/server/recovery/recovery-20261018-v1/sql`。

**一句话**：共享群的创建者退群或被停用时，在同一个事务里把 `channels.created_by` 改成「群里最早加入、仍在群里、账号未停用的人」。挂接的群组连同它的一切一起搬到这个人的租户：头像、视频、组团流程模板、运行记录、看板任务卡。群里最后一个人离开时，聊天软删，群组留给他，状态变成「未开始聊天」。

#### 1. 规则

| 项 | 决定 | 依据 |
|---|---|---|
| 接手人 | 仍在群里、账号未停用的人类成员中，`channel_memberships.created_at` 最早的那位 | 用户原话；「排除已停用」是用户的裁定 |
| 已停用 | 他的 `lower(users.email)` 在 `revoked_access` 里。这张表是三条停用路径共用的拒绝名单（第 3 条） | `S/db/schema/core.ts:243-260` |
| 平手 | 再按 `users.email` 升序。邮箱非空且唯一（`core.ts:67`），是全序 | 与上游 `people()` 的排序完全相同（`S/channels/group.ts:695-706`）。上游界面和 `creatorOnly` 认的「发起人」就是 `people()[0]`（`group.ts:1592-1597`、`:1941`） |
| 员工不算 | 不用额外排除。`channel_memberships.user_id` 外键指向 `users`（`core.ts:390-412`），员工在 `channel_agents`；`users` 只由登录写入（`S/auth/organization-store.ts:19`、`S/auth/dev-actor.ts:57`） | — |
| 重新加入的人 | 按这次加入的时间算（退群会删掉成员行） | 「仍在群里」 |
| 账号恢复后 | 不还。恢复只是删掉 `revoked_access` 那一行，不触发任何移交；他也不会自动回到群里（第 3 条 #4） | 用户裁定 |
| 个人频道、`created_by` 为 NULL 的共享群 | 不适用 | 3.1 |

现状更正：上游的「发起人」（`people()[0]`）会在创建者退群后自动落到下一位成员身上，但数据库层的创建者权力全看 `created_by`：
- 改 title：`R/0179`、`R/0206:50-51, 69-71`；
- 移走员工：`R/0128_team_group_bots.sql:201-202`；
- 把人移出群：`R/0122_team_tenant.sql:331-333`；
- 软删群：`R/0122:150-156`。

所以现在新「发起人」在界面上看得到这些按钮，点了却会被拒。移交让两边重新一致。为了保持一致，停用的人必须**离开**共享群（第 3 条 #4），否则 `people()[0]` 会落在一个停用的人身上，接手人反而会被上游 `creatorOnly` 当成非发起人。

#### 2. 现状：创建者能不能退群

- 上游服务禁止：`removeMember`（`group.ts:1693-1707`）在 `userId === creator && people.length > 1` 时抛 `GroupRefusedError("The person who started this group cannot leave while others are in it.")`，路由回 400。只剩他一人时允许退。
- 前端不给按钮：`A/components/channels/group-people.tsx:79` 的 `removable = self ? !person.creator : iCreated`。
- 决定：放开。写在熊宝的装饰器 `withWakerGroupLink` 里，覆盖 `removeMember` 的「创建者本人退群」这一支，上游 `group.ts` 不改。生产路由和 staffing 执行器拿到的都是装饰后的对象（`S/index.ts:4226-4228`、`S/app.ts:2245`）。未装饰的上游服务照旧拒绝，所以 `T/group-conversations.integration.test.ts:1294-1298` 不受影响。

#### 3. 触发路径

| # | 路径 | 生产里有没有 | 处理 |
|---|---|---|---|
| 1 | 创建者在人员面板点「退出」→ `DELETE /api/groups/:id/members/:self` | 有（放开后） | **立即**：装饰器在一个事务里退群并移交（4.2）。流程正在运行时回 400 |
| 2 | 创建者只剩自己时退群 | 有 | **立即**：同一个事务；没有接手人，聊天软删，群组留给他（第 6 条）。流程正在运行时同样回 400：「流程正在运行时创建者不能退群」一律适用，有没有接手人都一样（只剩停用成员时也是） |
| 3 | 创建者被停用：<br>① SCIM 停用：`reconcileDirectoryState`，`active = false`，向 `revoked_access` 插一行，`revoked_by = 'scim:directory'`（`S/auth/scim.ts:64-117`，插入在 `:82-87`）；<br>② 管理员移除：`POST /api/admin/people/:userId/access {revoked:true}` → `peopleStore.revoke`，事务里插 `revoked_access` 并删会话（`S/app.ts:1509-1590`、`S/people/store.ts:318-333`）；<br>③ 平台运营停用租户：`POST /tenants/:id/suspend` → `suspendTenant`，在 `platform` 帧插 `revoked_access`（`S/platform/routes.ts:85-106`、`S/platform/store.ts:57-82`） | 三条都有 | **立即**：三条唯一的共同点是 `INSERT INTO revoked_access`，所以在这张表上建 `AFTER INSERT` 触发器（4.3）。移交与插入在同一个事务里，三个 TS 文件都不用改 |
| 4 | 停用的人如果不是创建者 | — | 同一个触发器让他离开他所在的所有共享群（删成员行），这就是「算作退群」。否则上游 `people()[0]` 可能落在停用的人身上，接手人在上游就成了非发起人 |
| 5 | 创建者在自己的帧里直接删自己的成员行 | 生产代码只有 `store.removeMember`，而且只经上游服务调用 | 方案 A：不当场移交，靠自愈点（4.4） |
| 6 | 删除账号时 `channel_memberships.user_id` 外键级联（`core.ts:396-398`） | 应用里没有删 `users` 行的入口（better-auth 没开 `deleteUser`；SCIM 删除只删 `scim_*` 行），只有运维 SQL | 方案 A |
| 7 | `platform` 帧或运维 SQL 直接删成员行 | 只有运维 | 方案 A |
| 8 | 别人把创建者移出群 | 不可能：上游只许发起人移别人，RLS 只许本人或 `created_by` 删成员行 | — |

SCIM 停用之后还有一个 `setTimeout(…, 0)` 的善后（`scim.ts:88-112`：吊销凭据、停电脑、写审计），但移交不放在那里：它不在事务里，失败只记日志。插入 `revoked_access` 才是停用生效的那一刻。

恢复路径（SCIM `active = true` 删掉 `scim:` 开头的拒绝行，`scim.ts:119-136`；`peopleStore.restore`，`people/store.ts:352-363`；`restoreTenant`，`platform/store.ts:84-100`）只删 `revoked_access` 行，没有触发器，不还群组，也不把人加回群。

#### 4. 怎么做

**4.1 迁移 0207 `0207_team_channel_hand_over.sql`**（四个函数加一个触发器，外加三个按人查的索引，守卫一行不改）

| 函数 | 属性 | 谁能调 | 作用 |
|---|---|---|---|
| `openbot_team_channel_hand_over_write(p_channel_id, p_from, p_heir, p_group_id)` | `SECURITY DEFINER`，`SET search_path`，**`SET app.tenant_id = 'platform'`** | 不授权给应用（只有同一属主的函数能调） | 真正改数据（第 5 条）。`p_heir` 为 NULL 时改为软删聊天 |
| `openbot_team_channel_hand_over_core(p_channel_id, p_leaving DEFAULT true)` | `SECURITY DEFINER` | 不授权 | 锁频道、判定、调写入函数。返回调用后的所有者。`p_leaving` 为真（退群，对外函数传它）时有流程在运行一律 55006；为假（停用）时只在有人接手时 55006 |
| `xiongbao_team_channel_hand_over(p_channel_id)` | `SECURITY DEFINER` | `GRANT EXECUTE TO openbot_app` | 先校验身份，再调 core |
| `openbot_team_person_leaves_groups(p_user_id)` | `SECURITY DEFINER` | 不授权 | 停用时用：先 `FOR UPDATE` 锁他创建的 `team` 频道行（按 id），再删他在所有 `team` 频道的成员行；对锁到的频道逐个以 `p_leaving = false` 调 core，每个群各在一个子事务里：55006 跳过，其他错误只回滚那一个群并记 WARNING（不能让停用失败） |
| `openbot_team_revoked_leaves()`（触发器函数） | `SECURITY DEFINER`，`RETURNS trigger` | 不授权 | 按 `NEW.email` 找到 `users.id`（`lower(email)` 比较），在子事务里调上一个函数，整体失败只记 WARNING；找不到人就什么都不做 |

触发器：`CREATE TRIGGER openbot_team_revoked_leaves AFTER INSERT ON public.revoked_access FOR EACH ROW EXECUTE FUNCTION public.openbot_team_revoked_leaves();`。三条停用路径都用 `onConflictDoNothing`，同一个人第二次停用不会再插入，触发器只在第一次生效。

core 的判定顺序：
1. `FOR UPDATE` 读频道。不是 `team` 或 `created_by` 为 NULL：返回 NULL。
   - 频道已软删：原样返回 `created_by`，什么都不改。同一个群组可能已经挂着一个新开的聊天（部分唯一索引只管未删的频道），旧聊天的成员不能把群组从新聊天的所有者手里带走；不加这一条，创建者被停用时停用函数会对新旧两个聊天各调一次，群组可能落到旧聊天的成员名下，不再属于它活着的聊天的所有者。应用路径不受影响：退群只认未删的频道，`for-channel` 读不到已删的频道。
2. `created_by` 是成员并且未停用：返回 `created_by`，什么都不改（幂等）。
3. 接手人 = 第 1 条规则选出的人（成员、未停用，`ORDER BY created_at, email`）。
4. 频道挂着群组，并且有接手人或这是退群（`p_leaving`）：先 `FOR UPDATE` 锁群组行，再查群组有没有 `running` 或 `awaiting_action` 的运行，有就报 55006 `a crew run is still going`。
   - 这一步放在「没有接手人」之前：用户裁定 Q7「流程正在运行时创建者不能退群」一律适用，最后一人退群、只剩停用成员时退群都回 400，聊天和群组原样不动。
   - 停用（`p_leaving = false`）维持原样：有人接手时只推迟移交；没有接手人时不查运行，最后一人被停用照样软删聊天（这时什么都不搬，运行留在原主名下）。
   - 先锁后查，与解散相同（`S/waker-groups/linked-actions.ts` 的 `dissolve`）：插入运行时外键对群组行持有 KEY SHARE 锁，先插入的运行一定在锁到之后被看见，不会被当成已结束的运行搬走。加锁顺序仍是先频道后群组。
   - 残余窗口（接受）：启动方在移交前读了模板、移交提交后才插入运行，外键照样通过，这条运行落在原主租户、指向已归接手人的群组。它只在「流程启动」与「创建者退群或被停用」落在同一瞬间时出现；要关掉得在启动运行时校验群组归属：**已登记后续任务**（台账停放任务①）。
5. 没有接手人：
   - 一个成员都没有了：软删聊天，返回 NULL；
   - 还剩成员，但全是停用的（只有停用后又被重新拉进群才会出现）：什么都不改，返回 `created_by`。
6. 调写入函数，返回接手人。

公开函数的身份校验：当前帧必须是 `platform`、`created_by` 本人，或现任成员；否则报 42501，频道不存在时报同一个错。校验之前不加锁。

**加锁顺序**：频道行 → 成员行 → 群组行。退群（`leave`：`FOR UPDATE` 频道行，删自己的成员行，再由写入函数改群组行）、镜像自愈（`for share` 频道行再写镜像，第 8 条）、上游 `lockedBots` 都先锁频道行。停用也照这个顺序：先锁他创建的频道行，再删他的成员行。反过来（先删成员行再锁频道行）会和同一个人正在进行的退群互相等待，死锁时被回滚的可能是停用。

解散也照这个顺序（最终审查 M1 修复，`S/waker-groups/linked-actions.ts` 的 `dissolve`）：上游软删频道的事务提交之后，在一个事务里先按 id `FOR UPDATE` 锁挂着这个群组、调用者读得到的频道行（含已软删的，删群组时外键 `SET NULL` 要改的就是它们），再锁群组行，再查运行、删头像和群组。用例 `dissolving locks the chat's row before the crew's, the order every other path takes` 锁定这一顺序。剩下的边角：owner-gone 状态下（创建者已绕过服务离开）调用者读不到那条活着的频道行，锁不到它，这时解散与 `for-channel` 移交、停用触发器、镜像自愈仍可能互相等待成环。PostgreSQL 的死锁检测会打断其中一方（40P01）：解散或 `for-channel` 回 500，再试一次即可；停用由逐群子事务捕获，只记 WARNING。不写坏数据。

**停用时的错误处理**（原则：停用本身不能因为移交失败而失败）：
- 每个群的移交各在一个子事务里。55006 跳过；其他任何错误（比如接手人名下已有同一群组同名的模板，`group_task_templates_group_name_idx` 报 23505；子事务里的死锁）只回滚那一个群，记一条 `WARNING`（服务器日志），停用照常提交。频道的 `created_by` 仍是停用的人，属于第 8 条的 owner-gone 情形，由自愈点补上；不另设标记，`created_by` 不在籍或已停用本身就是待自愈的标记。
- 「离开共享群」这一步（锁频道行、删成员行）整体也在子事务里，失败（比如调用方设了 `lock_timeout`，等不到成员行）同样只记 `WARNING`，停用照常提交。这时停用的人暂时还留在群里：他已被拒之门外，所建的群照样由自愈点移交（core 把停用的创建者当作已离开）；成员行要由属主再执行一次补做语句（`openbot_team_person_leaves_groups`，幂等）才会删掉。
- 保留会失败的情况：PL/pgSQL 的 `WHEN OTHERS` 按设计不捕获取消（57014：`statement_timeout`、`pg_cancel_backend`）和 `assert_failure`，它们照旧让整条 `INSERT INTO revoked_access` 失败。那是调用方或运维在叫停这次停用，不是移交失败，重试即可。插入语句本身的错误也照常失败。
- 存量补做直接调 `openbot_team_person_leaves_groups`，逐群的错误照样只记 `WARNING`；「离开共享群」这一步失败会让迁移失败（迁移可以重跑，比悄悄留下停用的人更好查）。

**索引**：停用与补做按人查 `channel_memberships.user_id`、`channels.created_by`（共享群）、`lower(users.email)`，原来都没有索引（只有 `channel_memberships (channel_id, user_id)` 主键、`users.email` 唯一索引、`revoked_access.email` 主键），每停用一个人要顺序扫三张表。0207 补三个最小的：`channel_memberships_user_idx (user_id)`、`channels_team_created_by_idx (created_by) WHERE tenant_id = 'team'`、`users_lower_email_idx (lower(email))`，都用 `IF NOT EXISTS`。`group_task_runs` 按 `group_id` 查运行也没有索引，但只在真正移交的那几个群上查一次，与解散的检查相同，不加。

**为什么在写入函数里切到 `platform` 帧**：`created_by` 被两道守卫冻住，只放行 `platform` 帧：`openbot_team_row_guard('created_by')`（`R/0122:162-163`，函数体在 `R/0125_team_bots.sql:69-113`），以及 `openbot_team_channel_guard`（`R/0206:63-68`）。0128 的注释要求改共享群的行必须在 `platform` 帧里做（`R/0128:217-222`）。函数级的 `SET` 在函数退出或出错时由 PostgreSQL 自动还原。落地前要先确认这个写法可用，不可用就退回 `R/0114_delivery_binding_owner_tenant.sql:23-35` 的保存再还原写法。

**存量补做**：0207 末尾在 `platform` 帧对 `revoked_access` 现有的每一行执行一次 `openbot_team_person_leaves_groups`，把「已经停用的创建者」也立即移交，并让停用的人离开共享群。之后 `set_config` 还原为空串，同 0128 的写法。

不授权给应用的内部函数都以 `openbot_team_` 开头，所以 `T/tenant-invariants.test.ts:470-529` 的 (f) 会自动检查它们：非触发器必须是 definer、固定 search_path、PUBLIC 不可执行。应用调用的那一个用新名 `xiongbao_team_channel_hand_over`（应用代码里不写旧品牌名，品牌预算不涨），在 (f) 里照 0206 两个函数的做法显式登记，并断言它是 definer、只授权给 `openbot_app`。同文件 `:572-628` 枚举 `openbot_team_%` 触发器时，只核对触发器参数是否都指向存在的列；新触发器没有参数，自然通过。

**4.2 应用层：退群（装饰器）**

`withWakerGroupLink.removeMember(owner, channel, userId)`：
- `userId !== owner`、频道不是 `team`、或 `created_by !== owner`：交给上游。
- 否则在 owner 帧开一个事务：
  1. 对频道行 `select … for update`，和上游 `lockedBots` 用的是同一把锁；
  2. 删自己的成员行和映射；
  3. `select xiongbao_team_channel_hand_over($1)`。
- 函数报 55006 时整个事务回滚，抛 `GroupRefusedError("有组团流程正在运行，先停下再退群。")`，路由回 400。最后一人退群、只剩停用成员时退群也一样（core 第 4 步）。
- 提交后如果有接手人并且已挂接，在接手人帧调一次 `reconcile`，失败只记日志。

**4.3 应用层：停用**

不改 TS。三条停用路径插入 `revoked_access` 时由触发器完成。

**4.4 自愈点（方案 A 的 #5–#7，以及被推迟的移交）**

- `POST /api/waker-groups/for-channel/:channelId`：读权限校验通过后，如果 `created_by` 不是调用者，先在调用者帧调一次 `xiongbao_team_channel_hand_over`，再用返回值判断。55006 时记 `waker-group-hand-over-deferred`，照旧回 403。
- PR3 开机任务：第二、三阶段之前，在 `platform` 帧对涉及的共享群各调一次（Task 14 的追加）。
- `reconcile`、`syncName`、`linkChannel` 不做移交。这样 Task 3 和 Task 4 锁定绕过服务路径的两条已有用例保持不变。

#### 5. 数据怎么改：全部跟走

写入函数在一个事务里改下表各行（条件里的「原主」= `p_from`，「群组」= `p_group_id`）：

| 数据 | 改法 | 说明 |
|---|---|---|
| `channels.created_by` | 改为接手人 | 共享群的所有者（3.1） |
| `waker_groups` | `tenant_id` 改为接手人；`name` 按 4.4 以**聊天的 title** 为准（没有 title 用 `channels.name`；去首尾空白，截 80 字），撞名再依次加「（2）」…「（99）」，再撞加 id 前 6 位，后缀计入 80 字；循环里捕获 `unique_violation`。80 字按码点计，与应用侧 `pickGroupName` 一致（含 emoji 的名字两边判断相同）。镜像内置库是 SQL_ASCII（initdb 不带区域设置），那里 `left()`、`length()`、`btrim()` 按字节计、`\u` 转义无法转换：0207 不写 Unicode 转义，全角空格按整个序列裁，SQL_ASCII 库里按整个 UTF-8 序列截断，两种编码结果相同（`tests/waker-group-hand-over-sql-ascii.integration.test.ts`） | 0206 的挂接触发器要求群组属于所有者，两者同一事务改。以 title 而不是群组现在的名字为底：群组名本来就带「（2）」时不会变成「…（2）（2）」，接手人帧的自愈算出的名字与移交时相同，不会再改名或记 `name-taken`（最终审查 M13 修复） |
| `waker_group_members` | 不动，随父行 | 没有 `tenant_id`，RLS 看父行（`openbot/server/drizzle/0072_rls_command_scopes.sql:39-50`） |
| `portraits`、`portrait_media`（`subject_kind='group'`） | `tenant_id` 改为接手人；先删接手人名下同键的残行 | 主键含 `tenant_id`（`R/0144`、`R/0203`） |
| `group_task_templates`（`group_id`=群组，`tenant_id`=原主） | `tenant_id` 改为接手人 | 0075 |
| **`group_task_runs`**（`group_id`=群组，`tenant_id`=原主） | `tenant_id` 改为接手人 | `S/db/schema/pipeline.ts:169-240`。此时没有未结束的运行（core 第 4 步），所以不会打断正在跑的驱动或回收（`S/pipeline/reap.ts`、`S/recovery/abandoned-work.ts` 只看未结束的运行） |
| **`tasks`**（看板任务卡） | `tenant_id` 改为接手人，范围是：<br>① 父卡：`id IN (这些运行的 parent_task_id)`；<br>② 步骤卡：`parent_task_id IN (①)`，或 `id IN (这些运行 steps[].taskId)`；<br>都只改 `tenant_id = 原主` 的 | `parent_task_id` 没有外键（`pipeline.ts:186-194`），步骤卡由 `steps[].taskId` 和 `runRef` 指回（`pipeline.ts:213-220`）。看板的 `?group=` 过滤靠运行的 `parent_task_id` 找卡（`S/tasks/routes.ts:398-405`），卡不跟着搬的话，接手人的看板就看不到 |
| `task_archives` | `task_id IN (上面搬的卡)` 的行，`tenant_id` 改为接手人 | `S/db/schema/task-archives.ts:22-32`，`tenant_id` 必须与卡一致 |
| `group_pipeline_start_receipts` | `run_id IN (这些运行)` 的行，`tenant_id` 改为接手人 | `R/0090`；`S/` 里目前没有代码读写它，但它按 `tenant_id` 隔离，`run_id` 指向运行 |
| `flow_confirmations`、`flow_run_events`、`flow_run_retries` | `run_id`（重试表是 `source_run_id`、`new_run_id`）指向这些运行的行，`tenant_id` 改为接手人 | `S/db/schema/flow-run-coordination.ts:22, 93, 160`。只有 WakerFlow 的运行会写，而 WakerFlow 内部群组从不挂接（3.3），所以预期为零行，搬它只是为了不留下跨租户的悬挂 |
| `group_bot_threads`（回答顺序的排序行） | 不动 | 戳 `team`，按成员读 |
| **不搬**：`usage_counters`（任务配额） | 不动 | 已经消耗的额度记在当时发起的人名下（`S/quota/limits.ts:313-330`），搬了等于给他退额度、让接手人背账 |
| **不搬**：审批记录、`audit_events` | 不动 | 审批是当事人的决定记录，审计只追加、不改写。没有未结束的运行，也就没有挂在卡上的待批审批 |
| `waker_group_upgrades`（PR3 台账） | Task 12 的 0210 改写写入函数，多搬这一行 | — |

**留痕**（最终审查 M4 修复）：审计只追加、不改写，移交也不往 `audit_events` 里写（那里的事件类型由应用登记、按人归档，停用路径没有发起移交的人）。改为两处日志，内容相同：频道 id、原主、接手人、群组 id、搬走的运行数。
- 写入函数每次移交成功 `RAISE LOG` 一行（服务器日志，`xiongbao_team_channel_hand_over: channel … handed over from … to …, crew …, N run(s) moved`），退群、`for-channel`、停用触发器、存量补做四条路径都有。
- 同样的内容以事务级设置 `xiongbao.hand_over`（JSON）留在本事务里。应用的 `leave`、`handOver` 在事务里读回它，提交后记一行 `{"type":"waker-group-handed-over","channelId","from","to","groupId","runs"}`，与其余 `waker-group-*` 日志在同一处。停用路径没有应用代码参与，只有服务器日志那一行。

已知的小缺口（接受）：步骤卡上的会话链接指向步骤当时运行的线程，在原主租户里，接手人打不开那段对话记录。步骤的产出已经存在运行的 `steps[].output` 里，跟着搬了。

**对 Task 15 回滚手册的影响：第 2 步没有，第 1 步要加一个排除条件。**
- 手册第 2 步「补建群组没有模板、没有头像、也没有任何 `group_task_runs`」是在 `platform` 帧里按 `group_id` 或 `subject_id` 查，不看 `tenant_id`。移交只改 `tenant_id`，不改 `group_id`，也不新建运行记录，所以判断结果不变。
- 第 1 步的边角：转换出来的群组如果在还没有任何消息时就被移交了（例如创建者拉人进群后被停用），按「频道没有消息」它会被当成未被使用的转换回滚：聊天被软删，群组却留在接手人租户里；0210 又把台账的 `tenant_id` 一起搬走，原主再也找不回这个群组。所以第 1 步排除**已经被移交过的转换群组**：群组当前的 `tenant_id` 不等于台账上的原所有者（0210 的 `original_owner` 列，写入后不随移交改）。这些行不回滚，只由手册开头的查询列出来记录（5.6）。
- 被移交过的群组，台账行由 0210 跟着搬（`tenant_id` 改为接手人，`original_owner` 不变），手册清空台账时照样清掉。

#### 6. 最后一人离开

- **现状**：上游允许最后一人退群，但只删成员行，频道不软删（`group.ts:707-739`）。这个聊天从此谁也读不到，却还占着唯一活频道索引，群组开不了新聊天（Task 4 回 409 owner-gone，`T/waker-group-channel-link.integration.test.ts:1858-1896`），也解散不了。
- **决定**：软删聊天，群组仍归他，状态变成「未开始聊天」，可以重开或解散。最后一人被停用时也一样（触发器删掉他的成员行以后，群里一个人都不剩）。
- 流程正在运行时，最后一人退群回 400，聊天和群组原样不动（Q7 一律适用）；最后一人被停用则照样软删（停用不被流程阻止，这时不搬任何东西）。

#### 7. 安全与 RLS

- **谁能触发**：移交只在 `created_by` 已不是成员、或已停用时生效。前者只有本人或运维能造成；后者只有三条停用路径（都要管理员或平台权限）能造成。现任成员调公开函数，只能让已经发生的离开按规则落地，抢不走所有权。
- **接手人由数据库选**：调用方只传频道 id。
- **陌生人**：报 42501，与频道不存在时报同一个错；校验前不加锁。
- **写入函数、core、停用函数都不授权给应用**。直接 `UPDATE channels SET created_by` 仍被两道守卫拒绝。
- **`revoked_access` 没有 RLS**（没有 `tenant_id`，不在 0072 的循环里）。应用本来就能以任何帧写它，而写进去就等于把这个人拒之门外，这是现有的信任边界。触发器没有扩大这个边界：它的结果是确定的规则（停用的人离开共享群，群组交给最早的在籍成员），不接受调用方给的任何参数。
- **跨租户搬运**：表都按 0072 的四条策略隔离，旧主写不出 `WITH CHECK`，新主够不到 `USING`，只能由 definer 函数（迁移角色属主，BYPASSRLS）在 `platform` 帧里搬。`flow_*` 三张表只有本帧策略、没有 `platform` 分支，靠属主的 BYPASSRLS 读写。
- **Q2 的限制不变**：非所有者的成员仍然看不到所有者租户里的头像和流程。

#### 8. 与 Task 3 临时做法 `owner-gone` 的关系

移交上线后，`waker-group-owner-gone` 只在下面几种情况出现：
1. 创建者的成员行被**绕过服务**删掉（第 3 条 #5–#7：本人帧直接删行、运维删账号的级联、`platform` 帧删行），还没经过自愈点。
2. 移交因为流程正在运行被推迟。这包括停用触发器遇到 55006 时跳过的那几个群：停用的人已经离开，但群组要等运行结束、下一次自愈时才移交。停用时移交因为别的错误被回滚（第 4.1 条「停用时的错误处理」）也一样，等下一次自愈。
3. 只剩停用的成员、没有人能接手（第 4.1 条 core 第 5 步的第二种情况）。
4. 创建者和最早的成员**同时离开**（创建者经 `leave`，最早的成员走上游 `store.removeMember`，后者不锁频道行），或者两个互为成员的人**同时被停用**（SCIM 批量下线）：创建者一边的 core 在 READ COMMITTED 下看不到另一边尚未提交的删除，选了那个人当接手人。两边提交后 `created_by` 指向一个已不在群里（或已停用）的人，群组连同运行和看板卡都搬到了他名下，直到下一个成员打开设置（自愈点）才再移交给真正最早的在籍成员。接受这个竞态：不在选接手人时加 `FOR SHARE` 锁成员行，因为两人同时被停用时那会制造新的死锁。用例 `the creator and the earliest member leaving at once leave the crew with the one who left, until a heal` 锁定这一行为。

Task 4 的 `WakerGroupOwnerGoneError`（`S/waker-groups/linked-actions.ts:56-67`）的注释相应改写，断言不动。

**Task 3 的窄窗口一并消除**：
- `reconcile` 读名单仍走注入的 `groupStore`（`T/waker-group-channel-link.integration.test.ts` 的 `a 23505 with the channel still unlinked is thrown as it came` 依赖注入的名单）。
- 写镜像的事务里，先在 owner 帧执行 `select … for share` 重读频道行，再写镜像：读不到，或者锁到的那一行 `created_by` 已不是这一轮的所有者，就让整个事务回滚；读到了就持有共享锁到提交，之后来的退群事务的 `FOR UPDATE` 要等它提交。
  - 先锁后写：退群事务先锁频道行（`FOR UPDATE`），再由写入函数改群组行。镜像事务若先写镜像（锁群组行）再锁频道行，两边顺序相反，并发时会死锁。
  - 比对 `created_by`：退群正在进行时 `for share` 会等它提交，重新检查行时 RLS 里的成员判断仍用语句开始时的快照，可能放行；锁到的行是提交后的版本，看它的 `created_by` 才知道是否已经移交。
  - 名单在事务之前读：读的时候所有者已经离开，`for share` 那条语句的新快照就读不到这一行，窗口照样关上。
- 重读读不到时，先重新读一次所有者：换人了就在新所有者帧重做一次；没换才记一行 `owner-gone`。一次调用最多记一行。
- `linkChannel` 和 `adopt` 用带 RLS 的条件 `UPDATE channels` 完成挂接，本来就关着这个窗口。

#### 9. 已有断言

**本设计不改任何已有断言。** 停用触发器也查过了，没有碰到已有断言：
- 写 `revoked_access` 的测试（`T/device-safety.integration.test.ts:522`、`T/demoted-admin-platform-writes.integration.test.ts`、`T/people-last-sign-in.integration.test.ts`、`T/entra-obo-servers.integration.test.ts`、`T/enterprise-frames.integration.test.ts`）里的人都没有共享群成员行，触发器对他们什么也不做；
- 枚举触发器的断言（`T/rls-write-scope.test.ts:334-347` 只看 `openbot_team_row_guard`；`T/tenant-invariants.test.ts:572-628` 只核对参数）都能通过。

下面这些必须原样通过：

| 文件:行 | 为什么不受影响 |
|---|---|
| `T/group-conversations.integration.test.ts:1294-1298` | 放开写在装饰器里，未装饰的服务照旧拒绝 |
| `T/waker-group-channel-link.integration.test.ts:1169-1222` | 绕过服务删行不当场移交；一次调用最多一行 `owner-gone` |
| `T/waker-group-channel-link.integration.test.ts:1858-1896` | 同上。`:1885-1887` 的 `TODO(Task 5A)` 只改注释 |
| `T/waker-group-channel-link.integration.test.ts:2512-2539`（Task 5 加的「离开后改成员」） | 同上，同样是绕过服务删行。`:2531` 的 `TODO(Task 5A)` 只改注释 |
| `T/tenant-invariants.test.ts:470-529`、`:572-628` | 新函数自动纳入并满足要求；新触发器没有参数 |
| `T/tenant-invariants.test.ts` 的 `SRC_DOORS` | 不新开 `asPlatform(` 或 `runAsTenant("platform"` |
| `T/team-group-bots-migration.integration.test.ts`、`T/team-tenant-rls.integration.test.ts`、`T/rls-write-scope.test.ts` | 守卫、策略都不改 |
| `openbot/app/tests/group-people.test.tsx` | 没有锁「创建者没有退出按钮」 |

#### 10. 迁移编号（已决定）

**本任务用 0207（`0207_team_channel_hand_over.sql`），Task 12 的台账表顺延为 0208（后又顺延为 0210，见 3.2）。** 起草时本节用 0206、台账表用 0207；合入 main 时 0205 已被 `0205_skill_assets` 占用，Task 1 的迁移随之改名为 `0206_waker_group_channel_link`，后面两个依次顺延。理由：
- 日志要求 `when` 随 `idx` 严格递增（`T/recovery-overlay-journal.test.ts:39-42`、`T/migration-journal.test.ts:493-496`），后写的 0207 放不到已有的 0208 前面；
- 已经跑过 0208 的库会被 `src/db/migration-reach` 拒绝（`scripts/migrate.ts:90-97`）。

计划和设计稿里所有指 PR3 台账表的编号都改为 0208；PR3 动工时 0208、0209 又已被 main 占用，现为 0210（3.2）。

#### 11. 界面（PR2，追加给 Task 10）

- 人员面板：创建者也有「退出」。确认框：
  - 有接手人：「退出后，这个群组和它的头像、组团流程、运行记录、看板任务卡都归「{接手人}」。」
  - 只剩自己：「你是最后一个人。退出后这个聊天会删除，群组留在你的「群组」里，可以重新开始聊天。」
- 接手人取人员列表第二位。停用的人已经被移出群，所以列表里不会有停用的人。
- 服务端 400「有组团流程正在运行，先停下再退群。」原样提示。
- 「发起了这个群组」改为「管理这个群组」（随 Task 11）。

### 3.2 迁移放在哪里、怎么编号

- **放在** `openbot/server/recovery/recovery-20261018-v1/sql/`。原因：`drizzle/` 被测试冻结，叠加层「只能追加」（`scripts/migrate.ts:29-37, 57-63`）；0081 以后的迁移全部在这里。
- **编号**：PR1 用 `0206_waker_group_channel_link.sql`、`0207_team_channel_hand_over.sql`，PR3 用 **`0210_waker_group_upgrades.sql`** 与 **`0211_waker_group_upgrades_original_owner.sql`**（后者是 Task 12 评审后补的列级权限，0210 已提交不再改；原定的 0205 已被 main 的 `0205_skill_assets` 占用，依次顺延；PR3 动工时 main 又已有 `0208_skill_runnable`、`0209_channel_kind`，控制方 2026-11-13 裁定改为 0210，日志 `idx` 210、`when` 晚于 0209）。合入前如果别的 PR 先占了号，就再顺延，并同步改日志。
- **三件套**：SQL 文件；`meta/_journal.json` 追加一条，`idx` 与文件编号相同（206、207、210、211），`tag` 带四位数字前缀，`when` 取真实当前时间且晚于前一条（0205 为 `1794527335046`）；0108 以后不配快照（与 0108–0204 一致）。
- **执行身份**：要替换守卫函数、建触发器，必须用 owner 或 BYPASSRLS 身份跑，与 0122/0128 一样，文件开头照 0122:27-31 加角色自检。所有部署路径（镜像、Helm Job、compose、CI、`db:migrate`）都已经走 `scripts/migrate.ts` 的 owner 串，不需要改流程。

### 3.3 RLS、租户与守卫

1. **列本身不加新策略**：`channels` 已有 0072 的四条 `tenant_isolation*` 和 0122 的 `team_*` 策略，读写新列都受它们约束。
2. **改写 `openbot_team_channel_guard`**（`CREATE OR REPLACE`，以 0179 版为底，其余规则一字不动）。对 `waker_group_id` 增加两条放行，除此之外仍按「其余列谁也不能改」：
   - (a) **补挂**：旧值为 NULL、新值非 NULL，并且当前帧 = `created_by`。用于建群后立即挂接、开机任务、打开设置时自愈，这三条路径都在创建者帧里执行。
   - (b) **解挂**：新值为 NULL，并且旧值指向的群组已经不存在。这就是外键 `SET NULL` 的级联更新：它会触发 BEFORE UPDATE 触发器，帧是删除者。这条放行仿照 0122 对 `agent_profiles.owner_user_id` 的特例。
   - 把已挂的群组改指到另一个群组，在 `platform` 帧以外一律拒绝。
3. **新增触发器 `openbot_channel_waker_group_link`**（BEFORE INSERT OR UPDATE OF `waker_group_id`，对所有频道生效，`platform` 帧放行）：新值非 NULL 时，要求在**当前帧的 RLS 下**能读到这一行群组，且它的 `tenant_id` 等于 3.1 节的所有者，且没有 `waker_flows` 指向它。函数**不用** SECURITY DEFINER：故意借当前帧的 RLS，读不到就等于不是你的。这条挡住两种情况：外键检查绕过 RLS，可以拿别人的群组 id 去挂；也可以把 WakerFlow 内部群组挂进聊天。
4. **群组一侧不改**：`waker_groups` 和 `waker_group_members` 的策略（0070、0072）保持原样。
5. **台账表 `waker_group_upgrades`**（0210，见 5.5）带 `tenant_id`，照 0072 建 `ENABLE` + `FORCE` 和四条策略，`GRANT` 给 `openbot_app`。写法照抄 `0203_portrait_media.sql:38-50`。
6. **已知限制（接受）**：被创建者拉进共享群的**其他人**读不到创建者租户里的 `waker_groups`、`portraits` 和流程模板。他们看到的仍是叠放的员工头像，设置面板对他们只读（显示员工与顺序，数据取自群聊）。要让其他人也看到自定义头像，需要把头像改成 `team` 戳，本期不做（Q2）。
7. **移交函数与停用触发器**（0207，3.1.1 第 7 条）：移交只在 `created_by` 已不是成员或已停用时生效，接手人由数据库按规则选，调用方只传频道 id；陌生人与频道不存在报同一个 42501，校验前不加锁；写入、判定、停用三个函数不授权给应用，只有 `xiongbao_team_channel_hand_over` 授权；直接 `UPDATE channels SET created_by` 仍被两道守卫拒绝；`revoked_access` 上的触发器只执行确定的规则，不接受调用方参数，没有扩大现有的信任边界。

---

## 4. 两边怎么同步

### 4.1 顺序与成员的真相

- **群聊一侧是真相**。运行时回答顺序由上游 `order()` 决定（`group.ts:531-546`：每位员工取 `group_bot_threads` 最早一行的时间戳排序）；成员是 `channel_agents`。这两处是上游代码，不改。
- **`waker_group_members` 是镜像**，按真相的顺序整体改写，`position` 写成 `"0"`、`"1"`…，复用 `store.setMembers` 的写法。镜像给三处读：组团流程的「步骤负责人必须在组里」校验（`S/pipeline/store.ts:785-800`）、看板 `group=` 过滤（`S/tasks/routes.ts:395-420`）、`@群组` 展开和授权拆分（前端读 `/api/waker-groups`）。
- 为什么不反过来让群组当真相：那样要改上游 `order()` 和 `writeOrder`，每次同步上游都会冲突；而且回答顺序必须以真正在跑的那份为准，界面上显示的顺序才不会骗人。

### 4.2 写入口与同步时机

实现方式：在 S/index.ts 装配 `groupConversations` 的地方（`S/index.ts:4130`）包一层熊宝自己的装饰器 `withWakerGroupLink(…)`（新文件 `S/waker-groups/channel-link.ts`）。路由（`app.ts:2245` 的 `coworker.groups`）、staffing 执行器（`index.ts:4247` 的 `deps.groups`）拿到的都是同一个对象，所以**上游的 `group.ts` 一行都不用改**（只改一句文案，见第 8 节）。

| 写入口 | 谁调用 | 同步动作 |
|---|---|---|
| `create`（`POST /api/groups`，「新对话」多选，`propose_group`） | 前端、staffing 执行器 | 上游建完频道后，在创建者帧里开**一个事务**：建群组（名字按 4.4 节规则）、写镜像、挂接。返回的 `channel` 多带一个 `wakerGroupId` 字段（上游路由原样 `json` 返回，`group.ts:2132-2140`）。这一步失败只记日志 `waker-group-link-failed`，不让建群失败，留给自愈处理 |
| `addBots` / `removeBots` / `reorder`（`POST/DELETE /api/groups/:id/bots`、`PUT /:id/order`，`propose_group_change`） | 目前只有 staffing 执行器调用；PR2 之后设置面板也走统一接口 | 上游事务提交后，按运行时顺序（全部 `bots()`，有排序行的按 `order()` 在前，没有的按 id 追加，同 `orderedRoster`）整体改写镜像。频道没有挂接时什么也不做 |
| `PUT /api/waker-groups/:id/members`（旧接口） | 员工页卡片「管理成员」、设置面板 | **已挂接**：校验 2–20 位、不重复，跟现有成员比较得出要加的和要移的，按「先加后移、超过 20 位就分批：先加到 20，再移，再加剩下的」调用上游 `addBots`、`removeBots`，最后 `reorder(目标顺序)`，再改写镜像。只有创建者能做（沿用上游 `creatorOnly`）。**未挂接**：照旧 `setMembers`；如果结果是 2–20 位，紧接着自动开聊天并挂接（与 5.1 节同一个函数） |
| 员工被删除（`channel_agents` 外键级联） | 数据库 | 镜像不会立即跟着变，靠自愈（4.5） |
| WakerFlow 保存（`S/wakerflows/store.ts:1316-1360`） | WakerFlow | 不涉及：内部群组永远不会被挂接（3.3 节第 3 条），开机任务和列表接口都把它排除 |

多步写（旧接口翻译成加、移、重排）**不是原子的**：每一步都是上游各自的事务。中途失败时，返回 409 和已做的步骤，镜像按真相改写。这样界面看到的永远是实际状态。可接受的理由：每一步本身都有效，不会留下违反 2–20 约束的中间态。

### 4.3 新建时就挂接（D6）

所有建群聊的路径都会立即挂上群组，这是用户选项 1 原话「每个群聊背后挂一个」的直接落实。好处是 `/api/waker-groups` 就是「我建的群组」的完整清单（不分页），员工页、`@群组`、流程页、看板都只读这一份。

**一个例外**：`POST /api/channels` 建出的多员工个人频道（上游频道路由，`tenant_id` 是创建者本人）不在建频道时挂接。它不经过群聊服务的 `create`，也就不经过装饰器；前端已经不用这条路径建多员工会话。它靠两处兜底挂上：创建者打开设置时由 `POST /api/waker-groups/for-channel/:channelId` 懒挂接（5.4 的兜底），或者由 PR3 开机任务第二阶段补建。不为它在上游频道路由上再包一层装饰（Task 3 裁定）。

唯一的副作用：「新对话」多选建群后，如果第一条消息发失败，前端会把刚建的频道删掉（`A/lib/channels/start.ts:67-73` 的 `discard`）。删掉频道会留下一个孤立的群组。处理办法：`discard` 改调 `DELETE /api/waker-groups/:wakerGroupId`（解散：软删频道并删群组）；返回里没有 `wakerGroupId` 时（服务端旧版本），照旧删频道。

### 4.4 名字

- **真相是 `channels.title`**（没有 title 时用 `channels.name`，也就是员工名拼起来的名字）。
- 群组的 `name` 在租户内唯一（`waker_groups_tenant_name_idx`），新建或补建时按以下规则取名：先取 title，再取 `channels.name`，截到 80 字；如果撞名，依次加「（2）」「（3）」…「（99）」，还撞就加 id 的前 6 位。
- **改名**：在 S/index.ts 构造 `channelStore` 处，同样用装饰器包住 `rename`。任何路径给已挂接的频道改名（会话的改名对话框 `PUT /api/channels/:id/title`、`propose_group_change` 的改名步骤 `executor.ts:1101-1106`、新接口 `PATCH`），都会顺手把群组的 `name` 改成同样的名字。新名字在租户内已被别的群组占用时，群组保留原名，记日志 `waker-group-name-taken`，界面以 title 为准。`PATCH /api/waker-groups/:id` 会先查重，撞名就直接返回 409，所以从设置面板改名不会走到这条分支。

### 4.5 自愈

镜像可能出现偏差，来源有三种：装饰器的后半步失败、员工被删除、绕过装饰器的写入。在三个时机按真相改写镜像（成员、顺序、名字）：

1. 开机任务第三阶段：遍历所有已挂接的群组。
2. `POST /api/waker-groups/for-channel/:channelId`：打开设置面板时调用，见第 6 节。
3. 每次经统一接口写入之后。

打开设置和开机巡检时，先对创建者已离开或已停用的共享群做移交（3.1.1 第 4.4 条），再改写镜像。

`GET /api/waker-groups` **保持只读**，不在读接口里写库。

已修复（原台账停放任务②）：两次改写镜像并发时（比如 staffing 的增删与打开设置同时发生，或设置抽屉同时发两次 `for-channel`），镜像是「先删全部成员行、再插入」，后到的插入曾撞主键报 23505。现在 `writeMirror` 在事务开头先 `SELECT … FOR UPDATE` 锁群组行，写镜像的事务排队执行；各调用方都已先持有（或刚改过）频道行，加锁顺序仍是先频道后群组，不新增死锁。设置抽屉也只发一次 `for-channel`（`GroupSettingsPanel` 的 effect 按频道 id 只触发一次，StrictMode 的双次挂载不再重复请求）。用例 `reconcile calls at once all succeed and leave the mirror as the chat's order` 锁定。

---

## 5. 数据迁移（升级时自动转换）

### 5.1 现有群组转成群聊（开机任务第一阶段）

**为什么用开机任务而不是 SQL**：线程 id 必须由服务端生成（第 2 节第 5 条），而且要沿用上游的建群路径，权限检查、`team` 戳、成员行和线程行的写入才会和平时建群一模一样。任务在 `platform` 帧里枚举数据，在**所有者帧**（`runAsTenant(owner)`）里建群。

规则（逐条可执行）：

| # | 条件 | 处理 | 台账 `outcome` |
|---|---|---|---|
| 1 | 是 WakerFlow 内部群组 | 跳过，不记台账 | — |
| 2 | 已有未删除的频道挂着它 | 跳过 | — |
| 3 | `tenant_id` 是 `system`、`platform` 或 `team`，或者 `users` 里没有这个 id（人已删除） | 保留为群组，不转 | `no_owner` |
| 4 | 按 `position` 排序后，筛掉所有者用不了的员工（判断方式与 `canUseBot` 相同，`index.ts:4206-4209`：所有者帧下 `agentProfileStore.get` 读得到），剩下的不足 2 位 | 保留，界面标「待补成员」；**不改动它的成员数据** | `pending_members` |
| 5 | 筛完超过 20 位 | 保留，界面标「待调整成员（超过 20 位）」；不截断（Q3） | `too_many` |
| 6 | 筛完 2–20 位 | 转换：① 写台账 `started`（被筛掉的员工 id 此时记进 `dropped_agent_ids`，供孤儿匹配）；② 所有者帧下调上游 `create(owner, {agentIds})`（顺序即 `position` 顺序，上游 `seedOrder` 会写进时间戳）；③ 台账写入 `channel_id`；④ 一个事务里挂接、把 title 改成群组名、改写镜像；⑤ 台账改为 `converted` | `converted` |

- **创建者**：取 `users.id = waker_groups.tenant_id`。单人和多人部署相同（单用户安装下就是 `dev-local-user`）。新群聊的人员只有所有者自己，之后可以在群里邀请别人。
- **团队租户与个人租户**：群组只存在于个人租户；转出来的群聊按上游规则戳 `team`、`created_by = 所有者`。没有「团队租户的群组」这种情况，真有的话（`tenant_id = 'team'`）按规则 3 处理。
- **头像、流程、看板**：群组 id 不变，`portraits`（`subject_kind='group'`）、`group_task_templates`、`group_task_runs`、`/api/tasks?group=` 都以群组 id 为键，挂接之后自然沿用，**不需要搬数据**。
- **同名**：群组名租户内唯一，转出来的群聊 title = 群组名。如果所有者之前已有一个 title 相同的群聊，两者都保留，**不自动合并**（避免把成员不同的两个群误合），第二阶段给那个旧群聊补群组时，按 4.4 节规则加「（2）」。
- **已有同成员群聊不复用**：同上，不去重。升级说明里告诉用户可以自行解散其中一个。

### 5.2 0–1 位成员

保留为群组，不生成聊天。侧边栏和员工页标「待补成员」。补到 2 位以上（员工页「管理成员」或设置对话框）时，`PUT …/members` 会自动开聊天并挂接（4.2 节）。

### 5.3 幂等与崩溃恢复

- 每次开机都跑，一个副本跑：用 `pg_try_advisory_lock` 抢锁，抢不到就跳过。任务挂在 `startup.acquireSync` 后台执行，不阻塞健康检查。
- 已挂接的群组按规则 2 跳过；台账为 `pending_members`、`too_many`、`no_owner` 的不再重试（终态），用户补人走 4.2 节的路径。
- 崩溃窗口：在步骤 ②（建频道）和 ③（记 `channel_id`）之间崩溃，会留下一个未挂接的新频道。重跑时，遇到台账为 `started` 且没有 `channel_id` 的行，先按以下条件找「孤儿」：`created_by` = 所有者、`waker_group_id` 为 NULL、`created_at ≥ started_at`、员工集合与要转的完全相同、未删除。找到就收养（继续 ④），找不到才重建。第一阶段排在第二阶段之前，所以孤儿不会被第二阶段先补上一个新群组。
- 每一项单独处理，单项失败记 `waker-group-upgrade-item-failed`（附群组 id 和原因），不影响其余项；结束打一行汇总日志 `{"type":"waker-group-upgrade","converted":n,"pending":n,"tooMany":n,"noOwner":n,"backfilled":n,"reconciled":n}`。
- **开关**：环境变量 `XIONGBAO_GROUP_UPGRADE=off` 跳过整个开机任务（默认开），登记进 `.env.example` 和部署文档。

### 5.4 反向：现有群聊补群组（开机任务第二阶段，D7）

**决定：升级时一并补，并保留「打开设置时补建」作为兜底。** 不采用纯惰性补建，理由有三：
1. 用户选项 1 的原话是「每个群聊背后挂一个」，一并补才能让 `/api/waker-groups` 成为完整清单，员工页、`@群组`、流程页才不会漏掉没打开过设置的老群聊。
2. 补建只写熊宝自己的两张表和一列，可以放在**一个事务里**（建群组、写镜像、挂接），没有半截状态，比第一阶段简单。
3. 撞名改「（2）」这类一次性的处理，集中在升级时做、集中记日志，比散落在用户每次点开设置时发生更可控。

规则：对每个未删除、`channel_agents` 不少于 2 位、`waker_group_id` 为 NULL、能定出所有者（3.1 节）的频道，在所有者帧里建群组（名字按 4.4 节，成员和顺序取运行时顺序，见 4.2），挂接，台账记 `backfilled`。定不出所有者的计数后跳过（预期为 0）。被未完成的转换占用的频道（台账 `started` 已记的 `channel_id`，或 5.3 的孤儿条件命中的频道）跳过，留给下一次第一阶段续做；打开设置时的兜底遇到这类频道，改为把原群组挂上。

兜底：`POST /api/waker-groups/for-channel/:channelId` 由创建者调用时，如果还没挂接，就当场补建（同一个函数）。

### 5.5 台账表 `waker_group_upgrades`（0210，随 PR3）

| 列 | 说明 |
|---|---|
| `group_id uuid` | 主键，外键指向 `waker_groups`，级联删除 |
| `tenant_id text` | 所有者，0072 四条策略；移交时由 0210 改写的写入函数跟着改为接手人 |
| `original_owner text` | 写台账时的所有者，之后不改，移交也不搬。回滚手册用它认出「已经被移交过」的转换群组（3.1.1 第 5 条）。「不改」由数据库保证：0211 收回整表 UPDATE，按列重新授给 `openbot_app`，唯独不含这一列 |
| `channel_id text` | 可空；转出来的或补挂的频道 |
| `outcome text` | `started`、`converted`、`backfilled`、`pending_members`、`too_many`、`no_owner`（CHECK 约束） |
| `dropped_agent_ids text[]` | 转换时被筛掉的员工，默认空数组 |
| `started_at`、`updated_at` | 时间戳 |

这张表有三个用途：崩溃恢复、回滚、给运维看升级到底做了什么。

### 5.6 回滚

- **代码回滚**（换回上一版镜像 digest）：0206、0207、0210 都是新增，旧代码不读新列、新表、新函数；守卫函数的新版本只多了针对新列的放行，旧代码不碰新列，所以这部分行为不变。`scripts/migrate.ts` 的迁移守卫只拒绝「要跳过一个比库里戳更早的迁移」，旧镜像的迁移全部已经执行过，不会被拒。
  - **例外：0207 的停用触发器换回旧镜像后仍然有效。** `revoked_access` 上的 `openbot_team_revoked_leaves` 是数据库对象，不随代码回退：停用照样会把人移出他所在的所有共享群，照样把他创建的群（连同群组、头像、流程、运行记录、看板卡）移交给最早的在籍成员，旧代码对此一无所知。移交没有数据回滚手段（不记原主，不会还回去）。要在回滚期间停掉这一行为，执行回滚手册里单独的「停用触发器」一步（见下）。
- **停用 0207 的触发器**（回滚手册单独一步，与下面的数据回滚无关，换回旧镜像时就做）：用迁移属主账号（应用账号没有权限）执行 `ALTER TABLE public.revoked_access DISABLE TRIGGER openbot_team_revoked_leaves;`。停用期间，被停用的人不再离开共享群，他创建的群也不移交，回到 0207 之前的行为。之后再升级到含 0207 的版本时，迁移不会重跑，要由属主手动 `ALTER TABLE public.revoked_access ENABLE TRIGGER openbot_team_revoked_leaves;`，再执行一次 0207 末尾的补做语句（对每个已停用的人调 `openbot_team_person_leaves_groups`，幂等），把停用期间停用的人补做。
- **数据回滚**：写成运维手册（放进 `openbot/docs/deployment-xiongbao.md` 第 6 节），在 `platform` 帧里执行三步：
  1. 台账为 `converted`、对应频道至今没有任何 `group_messages`、**并且群组当前的 `tenant_id` 仍等于台账的 `original_owner`** 的：软删频道，按 `dropped_agent_ids` 把成员补回镜像。已经被移交过的转换群组（`tenant_id` 不等于 `original_owner`）不回滚，只由手册开头的一条查询列出来记录（群组 id、原所有者、现所有者、频道 id），理由见 3.1.1 第 5 条。
  2. 台账为 `backfilled`、并且该群组没有模板、没有头像、也没有任何运行记录的：删除群组（外键自动解挂）。删模板会保留运行，删群组却会级联删运行，所以要单独查运行。
  3. 清空台账。

  有消息或已经被用户用过的不回滚，手册里写明原因。手册里的 SQL 由 PR3 的集成测试执行一遍，证明可用。
- 全量回退仍然是「恢复备份」，与部署文档第 6 节的现有口径一致。

---

## 6. 接口

### 6.1 保持不变

| 接口 | 说明 |
|---|---|
| `/api/groups/*`（上游） | 路径、请求体、校验都不变。`POST /` 的返回里 `channel` 多一个可选字段 `wakerGroupId`，旧前端忽略它 |
| `/api/channels/*`（上游） | 不变。`channelDto`（`S/channels/routes.ts:1877`）**不加** `wakerGroupId`：上游文件不碰，前端通过群组列表的 `channelId` 反查 |
| `/api/portraits/group/:id` | 仍以群组 id 为键；`groupExists`（`S/portraits/store.ts:343`）不改 |
| `/api/group-pipelines/*` | 仍以 `groupId`（群组 uuid）为键；模板校验读镜像 |
| `/api/tasks?group=`、`?executors=` | 不变 |

### 6.2 扩展

| 接口 | 改动 |
|---|---|
| `GET /api/waker-groups` | 每项多 `usableMemberCount` 与服务端算好的 `chatStatus`（`chat`、`pending_members`、`too_many`、`not_started`，按可用员工数判断，前端据此显示，不用 `members.length`），以及 `channelId: string \| null`：挂接中、未删除、当前用户读得到的频道。列表仍排除 WakerFlow 内部群组；顺序不变。前端据此分出三种状态：`channelId` 非空为「可聊天」；空且员工少于 2 位为「待补成员」；空且员工 2–20 位为「未开始聊天」（频道被旧路径删掉，或升级时转换失败） |
| `POST /api/waker-groups` | 请求体可以带 `agentIds`（2–20 位）：先查重（409），再建群组、建频道、挂接、改写 title 和镜像，返回 `{ group, channel }`（201）。建频道失败时删掉刚建的群组；频道已建成但挂接失败时，先软删这个频道再删群组。**不带 `agentIds` 时完全是旧行为**（建一个「待补成员」的群组），旧客户端和现有测试不受影响 |
| `PUT /api/waker-groups/:id/members` | 返回 `{ group }`（200），或下面几种。<br>**已挂接**：按 4.2 节同步群聊，施加 2–20 位的限制（不满足 409，文案「一个群组要有 2 到 20 位员工。」）；只有创建者能改。分步翻译中途失败回 **409 `{ error, done }`**：`done` 是已经生效的步骤 `{ op: "add" \| "remove" \| "reorder", agentIds: string[] }[]`，按执行顺序，一步都没做时为 `[]`；镜像已按聊天的真相改写，前端重读列表即可；`error` 在上游拒绝（员工不可用、人数）时是上游的原话，否则是「群组成员只改了一部分，请刷新后再试。」或「群组成员没有做任何改动，请刷新后再试。」。翻译做完但调用者已读不到聊天（他刚离开）时回 409 带 `code: "waker-group-owner-gone"`。<br>**未挂接**：照旧写名单；可用员工在 2–20 位就自动开聊天。开聊天失败时**仍回 200 `{ group, chatError }`**：名单已保存，聊天没开成，`chatError` 是给人看的原因（上游拒绝的原话，或「成员已保存，但群聊没能开始，请稍后点「开始聊天」再试。」），群组状态是「未开始聊天」，可以再点「开始聊天」。聊天刚被另一个请求开了回 409「这个群组已经可以聊天了。」；群组挂着一个调用者已不在里面的聊天时回 409 带 `code: "waker-group-owner-gone"`，名单还原。<br>别人的、平台的或 WakerFlow 的群组 404；员工 id 里有调用者看不到的 400 |
| `DELETE /api/waker-groups/:id` | 已挂接时按 7.5 节解散：有流程在运行就返回 409「有组团流程正在运行，先停下再解散。」；先软删频道（并照上游 `DELETE /api/channels/:id` 写一条 `channel.deleted` 审计），再在一个事务里锁频道行、锁群组行、重查运行、删头像和视频、删群组。未挂接时照旧删群组，并顺手删头像（现在会留下孤立的头像行）。只有创建者能做；别人的群组 404。返回 `{ ok: true }` |

### 6.3 新增

| 接口 | 作用 |
|---|---|
| `PATCH /api/waker-groups/:id` | `{ name?, description? }`，返回 `{ group }`。名字 1–80 字（400）；改名先查重（409），再给挂接的频道改 title（经装饰器同步群组名），没挂接就只改群组。上游拒绝改聊天的 title（调用者已不是这个聊天的发起人，`ChannelNotOwnerError`）时回 **403**「只有发起人能调整这个群组。」，两边都不改。别人的群组 404。补上 `A/lib/waker-groups/mutations.ts:7-12` 明说不做的改名 |
| `POST /api/waker-groups/:id/chat` | 给「未开始聊天」的群组开聊天：要求未挂接且可用员工在 2–20 位之间，否则返回 409（「这个群组已经可以聊天了。」或「一个群组要有 2 到 20 位员工。」）；群组挂着一个调用者已不在里面的聊天时回 409 带 `code: "waker-group-owner-gone"`；上游拒绝（员工不可用）回 400；返回 `{ group, channel }`（201） |
| `POST /api/waker-groups/for-channel/:channelId` | 打开设置面板时调用：频道的创建者调用时，确保已挂接（没挂就补建），按真相做一次自愈，返回 `{ group }`；共享群的创建者已离开时先移交（3.1.1 第 4.4 条），最早的在籍成员调用时就成了所有者。非创建者返回 403 和只读提示（移交被运行中的流程推迟时也是 403）；读不到这个频道返回 404，**单聊和任务会话也返回 404**（不是群聊，与读不到同一个回答，防止探测会话类型）。所有者帧读不到聊天、又没有人接手时回 409 带 `code: "waker-group-owner-gone"`。幂等 |
| `DELETE /api/groups/:channelId/members/:self`（上游路由，装饰器接管） | 共享群的创建者本人退群：在一个事务里退群并把群组移交给最早的在籍成员（3.1.1），204。群组有流程在运行（`running`、`awaiting_action`）时回 **400**「有组团流程正在运行，先停下再退群。」，什么都不改；最后一人退群、只剩停用成员时也一样 |

409 的 `code`：只有 owner-gone 这一种 409 带 `code: "waker-group-owner-gone"`（`for-channel`、`POST /:id/chat`、`PUT /:id/members` 三处），前端以 `code` 区分它，不靠文案；文案是「这个群组的聊天你已经不在里面了，暂时不能调整。」。其余 409 只有 `error`，分步失败另带 `done`。

路由由 `createWakerGroupRoutes(store, requireUser, link?)` 的**可选第三参数**启用。现有测试 `server/tests/waker-groups.test.ts` 只传两个参数，行为与现在完全一样。

### 6.4 其他跟着改的

- `openbot/scripts/ci/assert-tenants.mjs`：新增两条断言（属于新增，不是修改）：B 对 A 的群组 `PATCH`、`DELETE` 都返回 404。
- staffing 的 `list_staff`（`S/plugins/builtin-staffing.ts:494`）仍然列「你发起的群组」及其 `channelId`；草稿和执行器的结构不变。

---

## 7. 前端

### 7.1 侧边栏（`A/components/app-sidebar/sidebar-roster.tsx` 的 `GroupList`，`:460`）

- 切换项仍是「会话 · 员工 · 群组」。「群组」下**只有一节、一个列表**（`aria-label="群组"`），标题为「群组」。
- 列表内容分两部分：
  - 先列所有多员工频道（`isGroupChannel`，`A/components/app-sidebar/roster.ts:95`），包括别人拉我进去的，置顶的在前，与现在相同。已挂接并且是我建的，显示群组头像（`usePortraitSrc("group", wakerGroupId)`），没有头像时仍显示叠放的员工头像。
  - 再按名字列我建的、`channelId` 为空的群组：第二行写「N 名员工 · 待补成员」或「N 名员工 · 未开始聊天」，点击去 `/bots?tab=groups`。
- 工具栏只留一个入口「新建群组」，指向 `/group/new`（原来的「新建群聊」和指向 `/bots?tab=groups` 的「新建群组」合成这一个）。搜索框的说明改为「搜索群组」「按名字搜索群组」。
- 空列表：「还没有群组。点「新建群组」，选两位以上员工开始。」；已加载的页里还没有：「已加载的会话里还没有群组。」
- `A/components/app-sidebar/app-sidebar.tsx:343-358`「新对话」旁边的按钮改为「新建群组」，仍指向 `/group/new`。
- 皮肤 `A/skins/openmuse/menu-sheet.tsx:94-99`「新建群组」从 `/channel/new` 改指 `/group/new`。

### 7.2 员工页「群组」页签（D11，`A/components/bots/bots-page.tsx`、`A/components/wakers/crews.tsx`）

**决定：保留页签**，`/bots?tab=groups` 原样可用。理由：流程页的报错文案（`S/pipeline/store.ts:766, 795`「员工管理 › 群组」）、`CONTEXT.md`、旧链接 `/wakers?tab=groups`（`A/lib/agents/legacy-routes.ts`）都指向这里；这里也是「待补成员」群组唯一的落脚点。

- 内容来自 `/api/waker-groups`，也就是「我建的群组」（不分页）。别人拉我进去的群组只出现在侧边栏，因为我管不了它们。
- 卡片保留现有布局和操作（「管理成员」「更换头像」「解散」「组团流程」「在看板上看」）；**新增**三项：
  - 可聊天的群组：「打开」，链到 `/group/$channelId`；「设置」，链到 `/group/$channelId?settings=1`。
  - 待补成员：徽标「待补成员」。
  - 未开始聊天：「开始聊天」按钮（`POST …/chat`）。
- 「组团流程」链接带上群组：`/pipelines?group=<id>`；流程页新增可选地址参数 `group`，打开后滚动到该群组那一节并展开。
- 「解散」走 7.5 节的语义，确认文案补一句后果（见 7.5）。
- 页头和空状态的「新建群组」按钮、网格末尾的新建卡片，都打开统一的新建对话框（7.3 节）。

### 7.3 新建群组（D12）

- 抽出一个表单组件 `CreateGroupForm`（新文件 `A/components/wakers/create-group-form.tsx`），两处使用：
  - `/group/new` 页（`A/routes/_authed/_app/group/new.tsx`）：标题「新建群组」。
  - 员工页对话框（取代 `crews.tsx:50` 的 `CreateCrewDialog`）：标题「新建群组」。
- 表单字段：
  - 名称：占位「群组名称」，必填，默认填已选员工名用「、」连起来，可以改。
  - 用途：可选，沿用现有的描述字段。
  - 员工：按勾选先后决定回答顺序，沿用 `/group/new` 现有的勾选列表和「第 N 个回答」提示，2–20 位。
- 按钮：页面上叫「创建群组」，对话框沿用「创建」。一次请求 `POST /api/waker-groups { name, description, agentIds }`。成功后用返回的 `channel` 预填缓存，然后 `replace` 跳转到 `/group/$channelId`。
- 文案：「已选 N 位，至少还要 M 位」「已选 20 位，一个群组最多 20 位」「群组没能建好，请再试一次。」；撞名时显示服务端的 409 文案。
- 「新对话」页（`A/routes/_authed/_app/channel/new.tsx`）的「发给」多选**保留**：选两位以上会建一个以员工名命名的群组，文案里的「群聊」改「群组」（如「选两位以上就是一个群组」）。

### 7.4 群组聊天页顶栏与设置面板

- 路由 `A/routes/_authed/_app/group/$channelId.tsx` 增加地址参数 `settings?: 1`。顶栏在 `GroupPeopleButton` 旁边加一个「群组设置」图标按钮，点击打开右侧抽屉，开关状态同步到地址参数。名字缺省时的回退文案从「群聊」（`:32`）改为「群组」。
- 打开抽屉时调用 `POST /api/waker-groups/for-channel/:channelId`。按调用者区分两种视图：
  - **创建者**（`group.people[0]` 是我；服务端用 `created_by` 复核）看到完整面板，分节如下：
    1. **名称与用途**：行内编辑，调 `PATCH`。
    2. **员工与顺序**：列表可以上下移动、移除，「添加员工」打开员工选择器（只列我能用的员工），保存时调 `PUT …/members`。前端同样拦住少于 2 位、多于 20 位。移除的员工如果负责某个流程步骤，提示「这位员工负责流程「X」的第 N 步」，但不拦。
    3. **头像**：复用 `PortraitPicker kind="group" id={wakerGroupId}`。
    4. **组团流程**：列出这个群组的模板（从 `pipelineTemplatesQueryOptions` 按 `groupId` 过滤），附「管理流程」链接 `/pipelines?group=<id>`。
    5. **在看板上看**：`/tasks?crew=<成员 id 逗号连接>`（D14）。
    6. **解散群组**：放在危险区，见 7.5。
  - **其他人**：只读的「员工与顺序」（数据取自 `/api/groups/:id` 的 `bots`），加一句「只有发起人能调整」。退出群组仍在人员面板里操作。
- 顶栏头像：已挂接并且是我建的，显示群组头像；否则仍是 `ChannelAvatar` 叠放。
- **`@群组`**（`A/components/channels/group-chat.tsx:75-101`）：行为不变，仍然是一条模板一个选项；当前群组自己的模板排在最前面。单聊里的 `@群组` 展开成员（`channel-chat.tsx:432`）不变，已挂接的群组自然也在其中。
- 会话列表里，已挂接群组那一行的「删除」菜单，创建者看到的是「解散群组」（走 7.5 节的流程）；其他人看到「退出群组」。

### 7.5 解散（D13）

- **只有创建者能解散**，入口在设置面板的危险区、员工页卡片和会话行菜单。
- 确认对话框写明后果：「解散「X」：聊天记录不再显示；它的 N 条组团流程和运行记录会一并删除；看板上已有的任务卡保留。」
- 服务端顺序：
  1. 有 `running` 或 `queued` 的流程运行时，返回 409「有组团流程正在运行，先停下再解散。」。
  2. 软删频道（上游 `softDelete`，创建者帧，0122 守卫允许），并照上游 `DELETE /api/channels/:id`（`S/channels/routes.ts` 的 `recordChannelDeleted`，同一个函数）写一条 `channel.deleted` 审计：谁删了这个会话。软删没有改动（已经删过）时不写。
  3. 一个事务里：先锁挂着这个群组、调用者读得到的频道行，再锁群组行（3.1.1 第 4.1 条的加锁顺序），重查运行（有就 409）；删除 `portraits`、`portrait_media` 里这个群组的行；删除群组：模板和运行记录按 0075 的外键级联删除，频道的挂接由外键 `SET NULL` 清空（3.3 节放行 b）。
  4. 第 3 步失败时，聊天已经隐藏，群组完整保留（「未开始聊天」），记 `waker-group-dissolve-incomplete`，再解散一次即可（上游软删自开事务，不能并进第 3 步）。
- 这与「风险」一节的张力：群聊删除是软删，群组删除是硬删，两边的语义不同。本稿选择**沿用现在各自的语义**：聊天能恢复的那部分（软删）照旧，群组那部分（含流程历史）和现在「解散群组」一样硬删。要不要改成保留流程历史，见 Q1。
- 通过旧路径 `DELETE /api/channels/:id` 删掉一个已挂接的频道（旧客户端、脚本），群组会保留下来，变成「未开始聊天」状态，可以重新开聊天或解散。不在上游的删除路由里加隐式的级联硬删。

---

## 8. 文案与术语

### 8.1 改动范围

- **界面**：`A/` 里「群聊」作为本概念的出现处一律改「群组」。代码类行共 38 行，分布在 20 个文件（统计命令：`grep -rn 群聊 openbot/app/src --include=*.ts --include=*.tsx`，去掉注释行）。主要文件：`sidebar-roster.tsx`、`app-sidebar.tsx`、`group/new.tsx`、`group/$channelId.tsx`、`group-people.tsx`（「群组成员」「发起了这个群组」「退出这个群组」）、`lib/groups.ts`、`channel/new.tsx`、staffing 卡片三件（`group-proposal.tsx`、`staffing-proposal-card.tsx`、`proposal-result.tsx` 的「打开群组」）。
- **服务端返回给人看的文字**：`S/` 里代码类行共 30 行，分布在 9 个文件。包括 staffing 执行器（`executor.ts:305, 310, 1075-1124`）、草稿校验（`draft.ts:327-341`）、`routes.ts:276-277`（「组建群组」「调整群组」）、上游文件里熊宝加的两句中文：`group.ts:1596`「只有发起这个群组的人才能调整群里的员工。」和 `dispatch.ts:323`「多人对话里请直接在群组中 @ 员工。」。
- **给模型看的工具描述**：`builtin-staffing.ts:115, 210, 298, 326-335, 418-419, 494, 920-961` 一并改「群组」。模型会原样复述给用户，两个词混用正是这次要消除的问题。
- **不改**：`reachability`（`A/routes/_authed/_app/reachability.tsx:61`、`components/reachability/*`）里的「群聊」指第三方 IM 的群，保留；测试夹具里服务端回显的句子可以不改。
- **`glossary-terms.test.ts` 不受影响**：它只锁「小组」和员工的同义词（`openbot/app/tests/glossary-terms.test.ts:43-62`），没有锁「群聊」。PR2 在同一个文件里**新增**一条用例：「界面和服务端不说群聊（IM 接入除外）」，例外清单列出上面那几处 `reachability` 文件。
- **文档**：`<根>/CONTEXT.md` 的「群组」「群组会话」两行合成一行（群组 = `waker_groups` + 挂接的群聊；入口；不持有权限；「群聊」为已停用的旧称）；`docs/specs/2026-11-11-staffing-by-conversation.md` 里「群聊」与「群组」混用的地方统一，原来第 6 行的不一致就此消除。

### 8.2 涉及上游文件的改动（同步上游时的冲突面）

只有五处：`S/index.ts` 的装配（包两层装饰器、挂路由第三参数、注册开机任务）；`S/channels/routes.ts` 把删除路由写 `channel.deleted` 审计的闭包提成导出函数 `recordChannelDeleted`（内容不变，解散复用它）；`S/channels/group.ts:1596`、`S/channels/dispatch.ts:323` 各一句熊宝自己的中文；`A/` 下 `group-chat.tsx`、`$channelId.tsx` 顶栏的少量改动。其余都在熊宝自己的文件里。

---

## 9. 已有测试断言的改动（待用户逐条批准）

按项目约定，改已有测试的断言要用户逐条批准。下表是预计要改的 **34 条**（文件路径相对 `openbot/`，行号以 `ac2e245e` 为准）。实现时如果 CI 暴露出表外的，再补报批准，不自行改。

| # | 文件:行 | 现断言 | 要改成 | 原因 |
|---|---|---|---|---|
| 1 | `app/tests/sidebar-roster.test.tsx:291` | `getByRole("button", { name: "新建群聊" })` | `{ name: "新建群组" }`（`:292` 的 href `/group/new` 不变） | 7.1 顶部按钮改名 |
| 2 | 同上 `:406` | `findByRole("list", { name: "群聊" })` | `{ name: "群组" }` | 两节合成一节 |
| 3 | 同上 `:408` | `chatRows.map(hrefOf)` 等于 `["/group/c-crew"]` | 等于 `["/group/c-crew", "/bots?tab=groups"]` | 未挂接的「周报小队」并进同一列表，排在最后 |
| 4 | 同上 `:411` | `getByRole("list", { name: "群组" })` 后 `within(crews).getByRole("link")` | 同一列表里 `getByRole("link", { name: /周报小队/ })`（`:412-418` 的 href、文字、头像断言不变） | 列表里不止一个链接 |
| 5 | 同上 `:419-420` | 「新建群组」链接的 href 是 `"/bots?tab=groups"` | `"/group/new"` | 入口统一 |
| 6 | 同上 `:435` | `"还没有群聊。点「新建群聊」，选两位以上员工开始。"` | `"还没有群组。点「新建群组」，选两位以上员工开始。"` | 文案 |
| 7 | 同上 `:438` | `getByRole("link", { name: "新建群聊" })` | `{ name: "新建群组" }`（href 不变） | 入口统一 |
| 8 | 同上 `:458` | `{ name: "搜索群聊和群组" }` | `{ name: "搜索群组" }` | 文案 |
| 9 | 同上 `:461` | `{ name: "按名字搜索群聊和群组" }` | `{ name: "按名字搜索群组" }` | 文案 |
| 10 | 同上 `:465-468` | `list "群聊"` 的 href 等于 `["/group/c-crew"]` | `list "群组"` 的 href 等于 `["/group/c-crew", "/bots?tab=groups"]` | 搜索「复盘」同时命中群聊和空群组「复盘组」 |
| 11 | 同上 `:470-474` | `list "群组"` 的链接文字等于 `[含「复盘组」]` | 同一列表的文字等于 `[含「联合复盘」, 含「复盘组」]` | 两节合一 |
| 12 | 同上 `:490` | `"已加载的会话里还没有群聊。"` | `"已加载的会话里还没有群组。"` | 文案 |
| 13 | 同上 `:493` | `findByRole("list", { name: "群聊" })` | `{ name: "群组" }` | 两节合一 |
| 14 | 同上 `:504-506` | `findByText("在员工的「群组」里把几位员工编成一组，它就会出现在这里。")` | `findByRole("list", { name: "群组" })` | 那句空状态文案随原「群组」节一起删除；默认夹具里有群聊，列表不为空 |
| 15 | `app/tests/sidebar-roster-narrow.test.tsx:217` | `findByRole("list", { name: "群聊" })` | `{ name: "群组" }` | 两节合一 |
| 16 | 同上 `:227` | `getByRole("button", { name: "新建群聊" })` | `{ name: "新建群组" }`（`:229` 路径不变） | 入口统一 |
| 17 | `app/tests/skin-slots.test.tsx:267` | `["a group conversation", "/group/g-1", "群聊"]` | 第三项改为 `"群组"` | 顶栏回退文案 |
| 18 | `app/tests/skins-openmuse.test.tsx:768` | `[/^新建群组$/, "/channel/new"]` | `[/^新建群组$/, "/group/new"]` | 7.1 皮肤入口改指 |
| 19 | `app/tests/group-new-page.test.tsx:155` | `findByText("新建群聊")` | `findByText("新建群组")` | 页标题 |
| 20 | 同上 `:159` | `getByRole("button", { name: "开始群聊" })` | `{ name: "创建群组" }` | 按钮名 |
| 21 | 同上 `:176` | 同上 | 同上 | 同上 |
| 22 | 同上 `:201` | 同上 | 同上 | 同上 |
| 23 | 同上 `:224` | 同上 | 同上 | 同上 |
| 24 | 同上 `:263` | 同上 | 同上 | 同上 |
| 25 | 同上 `:293` | 同上 | 同上 | 同上 |
| 26 | 同上 `:203-209` | POST 请求等于 `[{ url: "/api/groups", method: "POST", body: { agentIds: ["checker", "analyst"] } }]` | 等于 `[{ url: "/api/waker-groups", method: "POST", body: { name: "审稿、分析师", description: "", agentIds: ["checker", "analyst"] } }]`（`:210-213` 的缓存断言不变） | 7.3 一次调用建好 |
| 27 | 同上 `:277` | `"已选 20 位，一个群聊最多 20 位"` | `"已选 20 位，一个群组最多 20 位"` | 文案 |
| 28 | 同上 `:281` | 同上 | 同上 | 同上 |
| 29 | 同上 `:295-297` | `"群聊没能开始，请再试一次。"` | `"群组没能建好，请再试一次。"` | 文案 |
| 30 | `app/tests/wakers-screen.test.tsx:602` | `writes()[0]?.body` 等于 `{ name: "值班群组", description: "" }` | 等于 `{ name: "值班群组", description: "", agentIds: [<勾选的两位>] }` | 新建必须至少 2 位员工 |
| 31 | `app/tests/wakers-parity.test.tsx:713` | 「组团流程」链接的 href 是 `"/pipelines"` | `"/pipelines?group=crew-1"` | 7.2 带上群组 |
| 32 | `app/tests/staffing-proposal-card.test.tsx:419` | `getByRole("link", { name: "打开群聊" })` | `{ name: "打开群组" }` | 文案 |
| 33 | `server/tests/group-bots-change.integration.test.ts:389` | `toBe("只有发起这个群聊的人才能调整群里的员工。")` | `toBe("只有发起这个群组的人才能调整群里的员工。")` | 服务端文案 |
| 34 | `server/tests/channel-dispatch.test.ts:245` | `rejects.toThrow("群聊")` | `rejects.toThrow("群组")` | 服务端文案 |
| 35 | `server/tests/waker-group-channel-link.integration.test.ts:2759` | `"成员已保存，但群聊没能开始，请稍后点「开始聊天」再试。"` | `"成员已保存，但群组没能开始，请稍后点「开始聊天」再试。"` | 服务端文案（Task 11 引出；用户 2026-11-13 批准） |
| 36 | `scripts/e2e/staffing-lifecycle.ts:848,850` | `getByRole("link", { name: "打开群聊" })` 与对应说明 | `{ name: "打开群组" }` | 与 #32 同一处文案的端到端层（用户 2026-11-13 批准） |

**断言不变、但步骤或夹具要动的**（一并请批准）：
- `wakers-screen.test.tsx` 的「a new crew is created by name…」（`:565-603`）和「a name the workspace already used…」（`:605-633`）：点「创建」之前要先勾选两位员工，夹具要提供两位员工。
- `group-new-page.test.tsx` 中 `:183-195` 和 `:246-258` 两处 `respond` 夹具：返回体改为 `{ group, channel }`。
- 测试标题里的「群聊」字样（如 `sidebar-roster.test.tsx:288, 391, 428, 446, 476`）随文案一起改，不影响断言。

**明确不用改的**：
- `glossary-terms.test.ts`。
- `legacy-agent-routes.test.ts`：`LEGACY_PAGES` 整张表和 `?tab=groups` 都不变。
- `wakers-parity.test.tsx:290, 312-315, 336-338, 717`：页签、对话框、占位文字和 `crew=` 都保留。
- `wakers-screen.test.tsx:547-562`：看板链接仍是 `crew=`；「管理成员」仍是整份名单 `PUT`。
- `wakers-reference.test.tsx`、`archive-duplicate-pages.test.tsx`。
- `server/tests/waker-groups.test.ts`：只按字段断言，返回体新增 `channelId` 不影响；路由第三参数可选。
- staffing 卡片测试里服务端回显的夹具句子（如 `staffing-card-contents.test.tsx:299`）。

---

## 10. 分包

三个 PR，按顺序合入，每个都能单独合入。**PR1 不单独发版：PR1 合入 main 之后、PR2（界面）合入之前，不得打发版标签。** PR1 至少与 PR2 的 Task 6 进同一个正式版本；建议 PR2 和 PR3 也进同一个正式版本。原因见下面 PR1 的「风险」：PR1 不改界面，但旧界面下的几处行为会变。

### PR1 数据与服务端（界面不改，不单独发版）

- **范围**：
  - 迁移 0206（新列、两条索引、改写 `openbot_team_channel_guard`、挂接校验触发器）。
  - 迁移 0207（移交函数、停用触发器、存量补做）、装饰器放开创建者退群、`for-channel` 移交（3.1.1）。
  - `S/waker-groups/channel-link.ts`（列片段、建群组并挂接、镜像改写、自愈、取名规则）。
  - `withWakerGroupLink` 装饰器和 `channelStore.rename` 装饰器。
  - 第 6 节全部接口（路由第三参数）。
  - `S/index.ts` 装配。
  - `assert-tenants.mjs` 新增两条断言。
- **验收**：
  - 新增 `server/tests/waker-group-channel-link-migration.integration.test.ts`：守卫的放行 a 和 b；改指被拒；成员和别的租户都写不进；挂不了 WakerFlow 内部群组；挂不了别人的群组；删群组会自动解挂（含软删的共享群）；部分唯一索引生效。
  - 新增 `server/tests/waker-group-channel-link.integration.test.ts`：建群即挂（staffing 路径也挂）；加、移、重排后镜像一致；旧 `PUT members` 的翻译与分批（含 20 位换人）；2–20 的 409；`PATCH` 改两边并查重；解散的四步，以及有运行时拒绝；`POST` 带 `agentIds`；补够人自动开聊天；`for-channel` 的补建与 403/404；列表的 `channelId`；跨租户 404。
  - 新增 `server/tests/waker-group-hand-over.integration.test.ts`（Task 5A）：最早成员接手、平手按邮箱、全部跟走、流程运行时拒绝、最后一人离开、三条停用路径、恢复不还、存量补做、经服务退群、`for-channel` 移交。
  - 三个文件都登记进 `openbot/scripts/ci/server-tests.list.txt`。
  - CI 的 `server-test`（各分片）、`static`、`e2e-wakerflow`（G4，确认 WakerFlow 内部群组不受影响）全绿。必须保持原样通过：`waker-groups.test.ts`、`group-conversations*.test.ts`、`group-bots-change.integration.test.ts`、`team-group-bots-migration.integration.test.ts`（守卫的回归）、`portraits.test.ts`、`pipeline-*.test.ts`、`staffing-*.test.ts`、`migration-journal` 相关测试。
- **风险**：
  - 改写的是安全相关的守卫函数：要逐行比对 0179 版，并让 0128 的全部守卫测试保持绿。
  - 装饰器的后半步失败会留下没挂接的频道，有自愈兜底。
  - 多步翻译不是原子的（4.2）。
  - PR1 上线后、PR3 上线前新建的群聊已经会挂接，这正是想要的；旧数据要等 PR3。
  - 停用会让人离开他所在的所有共享群（恢复后要重新被邀请）。
  - **PR1 单独上线、旧前端不动时，旧界面的行为会变**（所以不单独发版，见本节开头）：
    - 每个新建的群聊都会自动多出一个群组，出现在员工页「群组」页签、`@群组`、流程页里；
    - 「新对话」首条消息失败时，旧的 `discard` 走 `DELETE /api/channels/:id`，会留下一个孤儿群组（修法在 PR2 的 Task 6，4.3）；
    - 从旧侧边栏删群聊，同样留下孤儿群组（7.5 末条）；
    - 员工页「退役群组」现在会顺带隐藏它的聊天；
    - 员工页「管理成员」对已挂接的群组改为翻译成群聊的增删排序，多了 2–20 位的 409 限制；未挂接的群组补够 2 位时会自动开聊天。

### PR2 界面合一与文案

- **范围**：
  - 第 7 节全部：侧边栏、员工页页签、`CreateGroupForm`、设置面板、`?settings=1`、`/pipelines?group=`、`discard` 改走解散、会话行菜单、`@群组` 排序、皮肤入口。
  - 第 8 节文案（前后端，含 staffing 工具描述）、新增的「不说群聊」用例、`CONTEXT.md`。
  - 第 9 节的 34 条断言和步骤改动（**先拿到逐条批准再动**）。
- **验收**：
  - CI `app-test` 全量零失败（按 `<根>/CONTEXT.md`「判回归的口径」比较失败名字的多重集）；`server-test` 中第 9 节的 2 条服务端断言随文案改。
  - 新增前端测试：`group-settings.test.tsx`（创建者和非创建者两种视图、保存顺序、2–20 拦截、解散确认文案）；`create-group-form.test.tsx`（页面和对话框两种用法）；侧边栏「待补成员」「未开始聊天」两种行。
  - 手动在 `run` 起的应用里走一遍：新建、聊天、改顺序、换头像、建流程、看板、解散。
- **风险**：
  - 文案面广，测试会连锁变红。按表逐条改，表外的失败先停下补报。
  - 侧边栏数据源从两份并成一份，注意分页时「待补成员」行的位置固定在末尾。

### PR3 升级任务（自动转换与补挂）

- **范围**：
  - 迁移 0210（台账表）。
  - `S/waker-groups/upgrade.ts`（三个阶段、咨询锁、汇总日志、开关 `XIONGBAO_GROUP_UPGRADE`）及装配。
  - `.env.example` 登记开关。
  - `openbot/docs/deployment-xiongbao.md` 写升级须知和回滚手册。
  - `openbot/CHANGELOG.md`。
- **验收**：
  - 新增 `server/tests/waker-group-upgrade.integration.test.ts`，覆盖 5.1 节表格的六条规则逐条；单用户 `dev-local-user`；重复执行幂等；`started` 孤儿被收养；第二阶段撞名加「（2）」；P11 前的个人频道；`created_by` 为 NULL 时跳过；两个并发执行只有一个真正干活；开关关闭时什么也不做；回滚手册的 SQL 能执行并恢复镜像。
  - 测试登记进清单；CI `server-test`、`e2e-wakerflow` 全绿。
- **风险**：
  - 升级后，转出来的空群组会一次性出现在「会话」列表顶部（Q4）。
  - 大租户的转换时长：逐项执行，每项几次写入，千级群组在分钟以内，并且在后台执行，不阻塞健康检查。
  - 外接库部署要先跑迁移再起服务，与现有流程一致。

---

## 11. 需要用户决定的问题（附建议）

1. **Q1 解散时，流程模板和运行记录要不要一并删掉？**
   现状：解散群组本来就级联硬删这两样（0075 外键）；群聊的删除是软删。
   建议：**一并删**，与现在解散群组的效果一致。确认对话框写明条数，有流程在运行就拒绝解散，看板上的任务卡保留。如果要保留历史，就得给 `waker_groups` 加「已解散」状态列，并改造流程页、看板、`@` 列表的过滤，工作量明显变大。

2. **Q2 被拉进共享群组的其他人看不到自定义头像和流程，本期是否接受？**
   现状：头像和流程都存在创建者的个人租户里，RLS 不让别人读。
   建议：**本期接受**。其他人看到叠放的员工头像，设置面板对他们只读。以后要做，单独立项，把群组头像改成 `team` 戳。

3. **Q3 超过 20 位员工的旧群组怎么处理？**
   现状：群组没有人数上限，群聊最多 20 位。
   建议：**不截断**。保留为群组，标「待调整成员（超过 20 位）」，用户减到 20 位以内后会自动开聊天。截断等于替用户决定谁出局。

4. **Q4 升级后转出来的空群组会出现在「会话」列表顶部，是否接受？**
   现状：会话列表按时间排序，新建的频道排在前面。
   建议：**接受**，并在升级说明里写明。伪造创建时间会让「最近」失真；也不建议专门为它们改会话列表的排序规则（那是上游文件）。

5. **Q5 被管理员停用的创建者算不算退群？**
   - 用户裁定（2026-11-13）：「被管理员停用的创建者（SCIM 停用，账号没有删除）算作退群，立即移交」；「最早的成员」排除已停用的账号；账号恢复后不还。
   - 落实：SCIM 停用、管理员移除、平台停用租户三条路径都会插入 `revoked_access`，由这张表上的触发器在同一事务里让停用的人离开所有共享群，并移交他创建的群。0207 对已经停用的人补做一次。
6. **Q6 最后一人离开时怎么办？**
   - 用户裁定（2026-11-13）：「最后一个人退群时，软删这个聊天，群组仍归他，状态变成『未开始聊天』」。
7. **Q7 流程正在运行时能不能退群？**
   - 用户裁定（2026-11-13）：「流程正在运行时，创建者不能退群」，回 400「有组团流程正在运行，先停下再退群。」
   - 一律适用：最后一人退群、只剩停用成员时退群，有流程在运行也回 400（3.1.1 第 4.1 条 core 第 4 步）。
   - 停用不能被拒，所以停用时移交推迟到自愈点。
8. **Q8 移交时什么跟着走？**
   - 用户裁定（2026-11-13）：「全部跟走」：群组、头像、视频、流程模板、运行记录、看板任务卡，以及运行的附属行。已消耗的配额、审批记录、审计日志不搬（第 5 条）。

---

### 用户裁定（2026-11-13）

- 问题 1 解散：一并删除组团流程模板与运行记录；确认框写明删几条；有流程正在运行时不让解散；看板任务卡保留。
- 问题 2 他人可见：接受，本期其他成员看到员工头像叠放、设置面板只读；共享头像与流程以后单独立项。
- 问题 3 超过 20 位：不截断，保留为群组并标「待调整成员（超过 20 位）」，减到 20 位以内后自动开启聊天。
- 问题 4 会话列表顶部：接受，在升级须知里写明。
- 问题 5–8（创建者退群与停用后的移交）：见上面 Q5–Q8 与 3.1.1；补充：停用的创建者一并移出所有共享群（恢复后须重新邀请），0207 上线时对已停用的账号补做一次，只剩停用成员时退群照常成功、暂不移交、由自愈补上。
- 设计稿通过；第 9 节 34 条已有断言修改（含员工页两个测试与两处建群夹具的步骤调整）全部批准。

## 12. 升级须知（京东云等已部署实例）

1. **迁移自动执行**：京东云是单容器内嵌库（`docs/acceptance/HUMAN-STEPS.md:20` 的部署记录），每次启动都会自动跑 `scripts/migrate.ts`，0206、0207、0210 随新镜像自动应用。外接库部署照 `openbot/docs/deployment-xiongbao.md` 第 4 节，先用新 digest 跑迁移，再重建 API 容器。
2. **升级前**按部署文档第 6 节备份。升级后首次启动，日志里会出现一行 `waker-group-upgrade` 汇总，记下转换和补挂的数量。如果要推迟转换，在 env 文件里设 `XIONGBAO_GROUP_UPGRADE=off`，之后去掉这个开关再重启即可。
3. **用户能看到的变化**：
   - 侧边栏「群组」里原来的群聊和群组合成一个列表。
   - 原来有 2 位以上员工的群组变成可以聊天的群组，名字、员工、顺序、头像、流程都不变；会话列表里会多出这些空群组。
   - 不足 2 位的标「待补成员」。
   - 同名的老群聊和转出来的群组会同时存在，可以自行解散其中一个。
   - 已经停用的人会离开他所在的共享群组，他创建的群组交给群里最早的在籍成员。
   - 0207 新建三个索引（`channel_memberships (user_id)`、`channels (created_by)`（共享群）、`users (lower(email))`），建索引期间这三张表的写入短暂等待。表很大的外接库部署，可以在升级前先用 `CREATE INDEX CONCURRENTLY IF NOT EXISTS` 以同样的名字建好，0207 会跳过。
4. **旧链接**：
   - `/bots?tab=groups`：页签保留，**不需要跳转**，打开的就是「我建的群组」。
   - `/wakers?tab=groups`：仍由 `legacyWakersTarget` 带到 `/bots?tab=groups`。
   - `/group/new`：打开「新建群组」。
   - `/group/<id>`：不变。
   - `/pipelines`、`/tasks?crew=…`、`/tasks?group=…`：不变。
5. **回滚**：换回上一版 digest 即可让代码回退，新列和新表留着无害。**但 0207 的停用触发器换回旧镜像后仍然有效**：停用照样会把人移出共享群，照样把他创建的群组连同流程、运行记录、看板卡移交给最早的在籍成员，而且移交没有数据回滚手段。回滚期间要停掉它，按回滚手册单独的一步用迁移属主账号执行 `ALTER TABLE public.revoked_access DISABLE TRIGGER openbot_team_revoked_leaves;`；重新升级后再 `ENABLE` 并补做（5.6）。需要撤销自动转换的，按回滚手册执行（5.6，已被移交过的转换群组不回滚、只记录），或者恢复备份。
6. **设备端**：不涉及，设备端不读写群组。
