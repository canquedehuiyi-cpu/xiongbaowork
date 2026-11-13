# 群组与群聊合一（做法 A：先挂接再收口）实施计划

> **给执行代理：** 必须配合以下子技能之一使用：superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans。按任务逐个实施，步骤用复选框（`- [ ]`）跟踪。

**目标**：每个群聊背后挂一个 `waker_groups` 记录（`channels.waker_group_id`），界面上只剩「群组」一个概念：侧边栏一节、员工页一个页签、一个「新建群组」表单、聊天页顶栏一个设置面板；已有群组升级时自动转成可聊天的群组，已有群聊自动补挂群组。

**架构**：
- 两张表各管各的：消息、人员、回答顺序归群聊（`channels` 一族，上游）；名字、头像、组团流程、看板过滤归群组（`waker_groups`，熊宝自加）。一列 `channels.waker_group_id` 一对一挂上。
- **群聊一侧是真相，群组一侧是镜像**：写入只走群聊；写完立即按运行时顺序 `runtimeOrder(order(), bots())` 改写 `waker_group_members`（全部 `bots()`：有排序行的按 `order()` 在前，没有排序行的按 id 追加，同 `S/channels/group.ts:1118-1130` 的 `orderedRoster`）；另有开机巡检和打开设置时的自愈。
- 上游 `S/channels/group.ts` 不改逻辑：在 `S/index.ts` 用两个熊宝装饰器包住 `groupConversations` 与 `channelStore.rename`；新列不进 Drizzle，用 `sql` 片段读写（同 `S/approvals/extra-columns.ts`）。
- 数据库层：改写 `openbot_team_channel_guard` 认得新列，新增挂接校验触发器，故意借当前帧 RLS 判断「是不是你的群组」。
- 现有数据的转换放在开机任务里（线程 id 只能由服务端生成），在所有者帧里沿用上游建群路径。

**技术栈**：Bun + TypeScript（server、app）、Hono、Drizzle（只用 `sql` 片段碰新列）、PostgreSQL（RLS、plpgsql 触发器）、React + TanStack Router/Query、bun test + happy-dom。

**设计文档**：`docs/specs/2026-11-13-group-unify.md`（分支 `docs/group-unify-spec`，用户 2026-11-13 已批准；「用户裁定」一节为 Q1–Q4 的最终答案；第 9 节 34 条断言修改已全部批准）。路径简写同设计稿：S = `openbot/server/src`，A = `openbot/app/src`。

## 全局约束

**项目约束**
- biome：`cd openbot && npx --no-install biome check <改动的文件>`。
- server 类型检查：`cd openbot/server && NODE_OPTIONS=--max-old-space-size=8192 npx --no-install tsc --noEmit`；app：`cd openbot/app && npx --no-install tsc --noEmit`。
- 服务端集成测试：先迁移测试库 `cd openbot/server && DATABASE_URL=postgres://openbot:openbot@127.0.0.1:5433/openbot_test bun scripts/migrate.ts`，再跑 `cd openbot/server && DATABASE_URL=postgres://openbot_app:openbot@127.0.0.1:5433/openbot_test TEST_DATABASE_URL=postgres://openbot_app:openbot@127.0.0.1:5433/openbot_test bun test tests/<文件>`。下文写作「服务端测试 `<文件>`」。不要整树 `bun test`（`openbot/docs/development-environment-xiongbao.md` §5）。
- 前端测试：`cd openbot/app && bun test tests/<文件>`。
- **新增服务器测试文件必须登记**：`cd openbot && bun scripts/ci/server-shards.mjs --write`，提交 `openbot/scripts/ci/server-tests.list.txt`。用数据库的测试在 `afterAll` 里 `await database.$client.close()`。
- 每个提交信息末尾带两行：
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01MJUqVcFToyopKbNJ4sEoWY
  ```

**迁移**（设计稿 3.2）
- 目录：`openbot/server/recovery/recovery-20261018-v1/sql/`。`openbot/server/drizzle/` 一字不动。
- PR1：`0206_waker_group_channel_link.sql`（Task 1）、`0207_team_channel_hand_over.sql`（Task 5A）；PR3：`0208_waker_group_upgrades.sql`。原定的 0205 合入 main 时已被 `0205_skill_assets` 占用，依次顺延。合入前再被别的 PR 占号就再顺延，并同步改日志与本计划引用。
- 日志 `openbot/server/recovery/recovery-20261018-v1/meta/_journal.json` 追加：`idx` 206 / 207 / 208，`version` `"7"`，`tag` 带四位前缀（`0206_waker_group_channel_link`、`0207_team_channel_hand_over`、`0208_waker_group_upgrades`），`when` 取真实当前毫秒且依次递增：0206 晚于 0205 的 `1794527335046`（已写 `1794537806196`），0207 晚于 0206，0208 晚于 0207，`breakpoints: true`。0108 以后不配快照。
- 文件开头照 `0122_team_tenant.sql:27-31` 加角色自检（`rolsuper OR rolbypassrls`，报错文字写本迁移号）。语句之间用 `--> statement-breakpoint`。
- 守卫改写以 `0179_team_channel_guard_title_opening.sql` 为底，**原有规则一字不动**，只加针对 `waker_group_id` 的两条放行（3.3）。
- 必须保持绿：`tests/migration-journal.test.ts`、`tests/recovery-overlay-journal.test.ts`、`tests/team-group-bots-migration.integration.test.ts`、`tests/team-tenant-rls.integration.test.ts`。

**数值与命名**
- 人数：一个可聊天的群组 2–20 位员工（`S/channels/group.ts:125-126` 的 `MIN_GROUP_BOTS`/`MAX_GROUP_BOTS`）。不满足时文案统一为「一个群组要有 2 到 20 位员工。」。
- 名称：1–80 字，租户内唯一；撞名后缀「（2）」…「（99）」，再撞加群组 id 前 6 位；后缀计入 80 字（先截本体再加后缀）。
- 界面、服务端给人看的文字、给模型看的工具描述一律叫「**群组**」；`reachability` 里指第三方 IM 群的「群聊」不改。
- 日志 `type`：`waker-group-link-failed`、`waker-group-name-taken`、`waker-group-upgrade-item-failed`、`waker-group-upgrade`（汇总）。
- 开关：`XIONGBAO_GROUP_UPGRADE=off` 跳过开机任务，默认开。

**已有测试**
- 只改设计稿第 9 节批准的 34 条断言，以及同节「断言不变、但步骤或夹具要动的」三项（员工页两个测试勾两位员工、`group-new-page.test.tsx:183-195`/`:246-258` 夹具返回 `{ group, channel }`、测试标题里的「群聊」）。每条分配到下面的任务里，按「设计稿 #N」引用。
- 第 9 节行号以 `ac2e245e` 为准，核对时发现三处偏移：#11 实际在 `sidebar-roster.test.tsx:469-473`，#26 实际在 `group-new-page.test.tsx:205-211`，#31 实际在 `wakers-parity.test.tsx:704`（文件只有 708 行）。按断言原文定位，改法以第 9 节为准，不得顺手改相邻断言。
- 第 9 节「明确不用改的」一律不碰。CI 暴露出表外的失败：**停下**，把「文件:行、现断言、建议改法、原因」报给用户批准，不自行改。

**租户隔离**
- 新接口全部在调用者帧里读写；别人的群组 id 一律 404（不暴露存在与否）。`for-channel` 对能读到频道的非创建者 403，读不到 404。
- 挂接校验触发器不用 SECURITY DEFINER，借当前帧 RLS；守卫放行 (b) 判断「群组已不存在」必须绕过 RLS（见 Task 1）。
- 开机任务：`platform` 帧只用来枚举和写台账，建群、挂接、改镜像都在 `runAsTenant(所有者)` 里。
- 台账表照 0072 建 `ENABLE` + `FORCE` 与四条策略，写法抄 `0203_portrait_media.sql:37-49`，`GRANT` 给 `openbot_app`。
- 新增集成测试至少两个租户（A 建，B 试图读写），并含共享群的「成员但非创建者」。

**执行档位**
- 建议执行模型：haiku = 取值都给全，照做；sonnet = 默认；opus = 安全、租户、迁移。
- 评审方式：「无需单独评审」= 文案与文档；「sonnet 一轮」= 中风险；「完整评审」= 安全、租户、迁移，逐行比对 0179 守卫与 RLS。

## 审查重点

1. **共享群里的其他人只读，守卫不能被成员绕过**：成员（非创建者）不能挂、不能改指、也不能把 `waker_group_id` 置空（群组还在，只是他读不到）；`for-channel` 给他 403，设置面板对他只读。→ Task 1「a member who is not the creator cannot link or unlink」；Task 4「for-channel answers 403 …」；Task 10「a member sees the roster read-only」。
2. **人数边界**：0、1、2、20、21 位；20 位全部换成另外 20 位（分批不能踩 2 位下限）。→ Task 4「POST with 1 or 21 agentIds answers 400」；Task 5「swaps all 20 for 20 others」「refuses 1 or 21 with 409」；Task 13 规则 4、5；Task 7「2–20 拦截」。
3. **同名与重复执行**：撞名加「（2）」直到「（99）」再加 id 前 6 位；改名撞名时群组保留原名；迁移和开机任务重复执行不重复建、`started` 孤儿被收养、两个副本并发只有一个干活。→ Task 2「pickGroupName …」；Task 3「a taken name keeps the old one」；Task 13「the second run changes nothing」「a started orphan is adopted」；Task 14「two runs at once」。
4. **解散时有流程在运行**：`running` 或 `awaiting_action` 的运行存在时 409，而且频道、群组、头像都没动。→ Task 5「DELETE refuses while a run is running or awaiting_action, and changes nothing」。
5. **绕过统一入口的路径**：`propose_group`（staffing 执行器）建的群也挂上并按草稿改名；`propose_group_change` 改名同步群组名；「新对话」多选首条消息失败时解散而不是留孤儿；WakerFlow 内部群组在挂接、列表、升级三处都被排除。→ Task 3「a staffing group proposal ends linked and named as the draft」；Task 6「a group whose first message failed is dissolved」；Task 1「a WakerFlow's internal crew cannot be linked」；Task 2「the list … WakerFlow crew still hidden」；Task 13 规则 1。

---

## 文件结构

| 文件 | 职责 | 建立于 |
|---|---|---|
| `openbot/server/recovery/recovery-20261018-v1/sql/0206_waker_group_channel_link.sql` | 新列、两条索引、守卫改写、挂接校验触发器 | Task 1 |
| `openbot/server/recovery/recovery-20261018-v1/sql/0207_team_channel_hand_over.sql` | 移交函数、停用触发器、存量补做 | Task 5A |
| `S/waker-groups/channel-link.ts` | 列片段、所有者规则、取名、`WakerGroupLink`（挂接、收养、自愈、名字同步、退群、移交）、两个装饰器 | Task 2、3、5A |
| `S/waker-groups/linked-actions.ts` | 统一接口背后的动作：建群组并开聊天、翻译成员、改名、开聊天、`for-channel`（含移交）、解散 | Task 4、5、5A |
| `S/waker-groups/routes.ts`（已有） | 第三参数 `actions?` 启用新路由与扩展 | Task 4、5 |
| `S/waker-groups/store.ts`（已有） | `list()` 带 `channelId` | Task 2 |
| `openbot/server/recovery/recovery-20261018-v1/sql/0208_waker_group_upgrades.sql` | 台账表；改写移交写入函数多搬台账行 | Task 12 |
| `S/waker-groups/upgrade.ts` | 开机任务三阶段、咨询锁、汇总日志、开关 | Task 13、14 |
| `A/components/wakers/create-group-form.tsx` | `CreateGroupForm` | Task 7 |
| `A/components/channels/group-settings.tsx` | 设置抽屉（创建者 / 其他人两种视图） | Task 10 |
| `A/lib/waker-groups/mutations.ts`、`queries.ts`（已有） | 新类型、四个新变更、`retireCrew` 补失效键 | Task 6 |

## 任务一览

| Task | 内容 | PR | 前置 | 建议执行模型 | 评审方式 |
|---|---|---|---|---|---|
| 1 | 迁移 0206：新列、索引、守卫改写、挂接触发器 | PR1 | — | opus | 完整评审 |
| 2 | `channel-link.ts` 核心：列片段、所有者、取名、挂接、收养、自愈；列表带 `channelId` | PR1 | 1 | opus | 完整评审 |
| 3 | 两个装饰器与 `S/index.ts` 装配：建群即挂、增删排序改写镜像、改名同步 | PR1 | 2 | opus | 完整评审 |
| 4 | 接口一：`POST` 带 `agentIds`、`PATCH`、`POST /:id/chat`、`POST /for-channel/:channelId`、路由第三参数装配 | PR1 | 3 | opus | 完整评审 |
| 5 | 接口二：`PUT members` 翻译与分批、`DELETE` 解散；`assert-tenants.mjs` 两条 | PR1 | 4 | opus | 完整评审 |
| 5A | 创建者退群或停用后的移交：迁移 0207、装饰器放开退群、停用触发器、for-channel 移交、镜像自愈窗口 | PR1 | 5 | opus | 完整评审 |
| 6 | 前端数据层：类型、四个新变更、`discard` 改走解散 | PR2 | PR1 合入 | sonnet | sonnet 一轮 |
| 7 | `CreateGroupForm`：`/group/new` 与员工页对话框（设计稿 #19–#30） | PR2 | 6 | sonnet | sonnet 一轮 |
| 8 | 侧边栏合一、顶部按钮、皮肤入口（设计稿 #1–#16、#18） | PR2 | 6 | sonnet | sonnet 一轮 |
| 9 | 员工页群组卡片三种状态、流程页 `?group=`（设计稿 #31） | PR2 | 6 | sonnet | sonnet 一轮 |
| 10 | 聊天页顶栏、设置抽屉、会话行菜单、`@群组` 排序（设计稿 #17） | PR2 | 6 | sonnet | sonnet 一轮 |
| 11 | 文案全量、「不说群聊」用例、`CONTEXT.md`、staffing 规格；手动走查（设计稿 #32–#34） | PR2 | 7、8、9、10 | haiku | 无需单独评审 |
| 12 | 迁移 0208：台账表与 RLS | PR3 | PR1 合入 | opus | 完整评审 |
| 13 | 开机任务第一阶段：群组转群聊、孤儿收养 | PR3 | 12 | opus | 完整评审 |
| 14 | 第二、三阶段、咨询锁、开关、汇总日志、装配 | PR3 | 13 | opus | 完整评审 |
| 15 | 升级须知、回滚手册与其 SQL 测试、`.env.example`、`CHANGELOG.md` | PR3 | 14 | opus | 完整评审 |

依赖：1 → 2 → 3 → 4 → 5 → 5A（PR1，串行；1–5 在同一个测试文件逐步追加，5A 另建测试文件）。PR1 合入后，PR2 与 PR3 可以并行开发：6 → {7, 8, 9, 10 并行} → 11；12 → 13 → 14 → 15。PR2、PR3 建议进同一个正式版本（设计稿第 10 节）。

设计稿章节与任务的对应：第 2 节更正 → 全局约束与 Task 1、2；3.1 → 1、2；3.1.1 → 5A、10、12、14；3.2 → 全局约束、1、12；3.3 → 1、12；4.1 → 2；4.2 → 3、5；4.3 → 3、6；4.4 → 2、3、4；4.5 → 2、4、14；5.1–5.3 → 13、14；5.4 → 14、4（`for-channel` 兜底）；5.5 → 12；5.6 → 15；6.1 → 3（`wakerGroupId`）、其余不改；6.2–6.3 → 2、4、5；6.4 → 5、11；7.1 → 8；7.2 → 9；7.3 → 7、11（「新对话」文案）；7.4 → 10；7.5 → 5、9、10；8.1 → 11（各任务里各自页面的文案随任务改）；8.2 → 3、4、10、11；第 9 节 → 7–11；第 10 节 → 本表；第 11 节与用户裁定 → Task 5（Q1）、10（Q2）、13（Q3）、15（Q4）、5A（Q5–Q8）；第 12 节 → 15。

---

## PR1：数据与服务端（界面无变化）

### Task 1：迁移 0206

（原编号 0205；合入 main 时 0205 已被 `0205_skill_assets` 占用，改名为 0206。下文已同步，提交信息保留原样。）

**建议执行模型**：opus　**评审方式**：完整评审

**文件：**
- 新建：`openbot/server/recovery/recovery-20261018-v1/sql/0206_waker_group_channel_link.sql`
- 修改：`openbot/server/recovery/recovery-20261018-v1/meta/_journal.json`（追加 idx 206）
- 测试（新建）：`openbot/server/tests/waker-group-channel-link-migration.integration.test.ts`；登记 `openbot/scripts/ci/server-tests.list.txt`

**接口（SQL，按顺序）：**
1. 角色自检（照 0122:27-31）。
2. `ALTER TABLE public.channels ADD COLUMN waker_group_id uuid REFERENCES public.waker_groups(id) ON DELETE SET NULL;`（可空，无默认值）
3. `CREATE UNIQUE INDEX channels_waker_group_live_idx ON public.channels (waker_group_id) WHERE waker_group_id IS NOT NULL AND deleted_at IS NULL;`
4. `CREATE INDEX channels_waker_group_idx ON public.channels (waker_group_id) WHERE waker_group_id IS NOT NULL;`
5. `CREATE FUNCTION public.openbot_waker_group_absent(p_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$ SELECT NOT EXISTS (SELECT 1 FROM public.waker_groups WHERE id = p_id) $$;` `REVOKE ALL … FROM PUBLIC`，`GRANT EXECUTE … TO openbot_app`（写法照 0122 的 `openbot_team_channel_member`）。理由：守卫不是 SECURITY DEFINER，在成员帧里直接查 `waker_groups` 会因 RLS 读不到创建者的群组而误判「已不存在」。
6. `CREATE OR REPLACE FUNCTION public.openbot_team_channel_guard()`：0179 原文，在 `before := …` 之前插入：
   - `IF OLD.waker_group_id IS DISTINCT FROM NEW.waker_group_id THEN`
     - 放行 (a)：`OLD.waker_group_id IS NULL AND (to_jsonb(OLD)->>'created_by') = frame`；
     - 放行 (b)：`NEW.waker_group_id IS NULL AND pg_trigger_depth() > 1 AND public.openbot_waker_group_absent(OLD.waker_group_id)`（仿照 0122 对 `agent_profiles.owner_user_id` 的特例）；
     - 否则 `RAISE EXCEPTION 'only the creator links a shared group to its crew' USING ERRCODE = '42501'`。
   - 之后 `before`/`after` 两处都再减去 `'waker_group_id'`，其余判断原样。`platform` 帧与非 `team` 行照旧在开头直接放行。
7. `CREATE FUNCTION public.openbot_channel_waker_group_link() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public`（**不是** SECURITY DEFINER）：`platform` 帧放行；`NEW.waker_group_id IS NULL` 放行；`TG_OP = 'UPDATE' AND OLD.waker_group_id IS NOT DISTINCT FROM NEW.waker_group_id` 放行；否则 `owner := CASE WHEN NEW.tenant_id = 'team' THEN to_jsonb(NEW)->>'created_by' ELSE NEW.tenant_id END`，要求 `owner IS NOT NULL`、`EXISTS (SELECT 1 FROM public.waker_groups g WHERE g.id = NEW.waker_group_id AND g.tenant_id = owner)`（当前帧 RLS 下）、`NOT EXISTS (SELECT 1 FROM public.waker_flows f WHERE f.group_id = NEW.waker_group_id)`；不满足 `RAISE EXCEPTION 'a conversation links only to a crew of its owner' USING ERRCODE = '42501'`。`REVOKE ALL … FROM PUBLIC`。
8. `CREATE TRIGGER openbot_channel_waker_group_link BEFORE INSERT OR UPDATE OF waker_group_id ON public.channels FOR EACH ROW EXECUTE FUNCTION public.openbot_channel_waker_group_link();`

- [ ] **Step 1：写失败测试** `waker-group-channel-link-migration.integration.test.ts`。夹具照 `tests/group-bots-change.integration.test.ts`：`createChannelStore(...).create(actor, agentIds, { shared: true })` 在 alice 帧建共享群，`users`/`agents`/`waker_groups` 行在各自帧写，`platform` 帧清理。设一个 `linkAs(frame, channelId, groupId|null)`，在 `runAsTenant(frame)` 里执行 `UPDATE channels SET waker_group_id = … WHERE id = …`。用例：
  - `the journal registers 0206 after 0205`：日志有 `idx: 206, tag: "0206_waker_group_channel_link"`，其 `when > 1794527335046`（0205_skill_assets）。
  - `the creator links an unlinked shared group to a crew of their own`：alice 帧挂 alice 的群组，成功，读回等于群组 id。
  - `the creator cannot point a linked group at another crew`：再改指 alice 的另一个群组 → 抛错，`errno`/`cause.errno` 为 `42501`。
  - `a member who is not the creator cannot link or unlink`：bob 被加进共享群（`group.addMember` 或直接写 `channel_memberships`，照夹具）；bob 帧挂 bob 的群组 → 42501；alice 先挂好，bob 帧置 NULL → 42501，读回仍是原 id。
  - `a crew of another tenant cannot be linked`：alice 帧把自己的共享群挂到 bob 的群组 id → 42501（外键本身会放行，所以这条证明触发器在起作用）。
  - `a WakerFlow's internal crew cannot be linked`：给 alice 的群组写一条 `waker_flows`（`group_id` 指向它，照 `tests/wakerflow-versions.integration.test.ts` 的夹具）→ 挂接 42501。
  - `a personal multi-Bot channel links only to its own tenant's crew`：`platform` 帧插一条 `tenant_id = alice`、两位员工的频道；alice 帧挂 alice 群组成功，挂 bob 群组 42501。
  - `deleting the crew unlinks the channel, soft-deleted shared groups included`：两个共享群（一个 `deleted_at` 已设）分别挂两个群组，alice 帧 `DELETE FROM waker_groups` → 两个频道的 `waker_group_id` 都为 NULL，`deleted_at` 不变。
  - `one live channel per crew; a soft-deleted one does not count`：第二个未删频道挂同一群组 → `23505`；把第一个软删后再挂 → 成功。
  - `the platform frame may relink`：`platform` 帧改指 → 成功。
  - `the guard's other rules are unchanged`：bob（成员）改 `name` → 报 `only the creator renames or describes a shared group`；bob 改 `last_message_at` → 成功；alice 改 `allowed_groups`（既不是活动列也不是名字列）→ 报 `only the activity columns of a shared group change`。
- [ ] **Step 2：运行** 服务端测试 `tests/waker-group-channel-link-migration.integration.test.ts`，预期失败（列不存在）。
- [ ] **Step 3：实现** SQL 与日志。逐行 diff 新守卫与 0179，差异只能是上面第 6 点。
- [ ] **Step 4：运行** 迁移测试库，再跑上面的文件与 `tests/migration-journal.test.ts`、`tests/recovery-overlay-journal.test.ts`、`tests/team-group-bots-migration.integration.test.ts`、`tests/team-tenant-rls.integration.test.ts`、`tests/group-conversations.integration.test.ts`，全部通过。再跑一遍迁移命令确认可重复执行（迁移器跳过已执行项，无报错）。
- [ ] **Step 5：登记**测试清单，提交 `迁移 0205：channels.waker_group_id、共享群守卫认得挂接列、挂接校验触发器`。

### Task 2：`channel-link.ts` 核心

**建议执行模型**：opus　**评审方式**：完整评审

**文件：**
- 新建：`S/waker-groups/channel-link.ts`
- 修改：`S/waker-groups/store.ts`（`list()` 带 `channelId`）
- 测试（新建）：`openbot/server/tests/waker-group-channel-link.integration.test.ts`（本任务建文件，Task 3–5 追加）；登记清单

**接口（Produces）：**
```ts
// channel-link.ts 文件头登记：channels.waker_group_id  uuid，可空，FK waker_groups ON DELETE SET NULL  0206
//                              channels.created_by      text，可空（0122 加，未进 Drizzle），只读
export const channelWakerGroupId: SQL<string | null>;   // sql`${channels}."waker_group_id"`
export const channelCreatedBy: SQL<string | null>;      // sql`${channels}."created_by"`
type Executor = { execute: (query: SQL) => PromiseLike<unknown> };
export function setChannelWakerGroup(executor: Executor, channelId: string, groupId: string | null): Promise<void>;
/** 3.1 归属规则：team → created_by（为 NULL 则无所有者）；否则 tenant_id。 */
export function channelOwner(row: { tenantId: string; createdBy: string | null }): string | null;
/** 4.4 取名：wanted 截 80 字；撞名依次「（2）」…「（99）」，再撞加 id 前 6 位；except 为自身 id（改名时不与自己撞）。 */
export function pickGroupName(executor: Executor, wanted: string, options?: { except?: string; idForSuffix?: string }): Promise<string>;
/** 运行时回答顺序（与 group.ts 的 orderedRoster 同一规则）：取全部 bots；在 order 里的按其位置在前，不在的排在后面，同名次按 id localeCompare。order 里已不在 bots 的 id 丢弃。 */
export function runtimeOrder(order: string[], bots: string[]): string[];
export type WakerGroupLink = {
  /** 未挂接时：所有者帧里一个事务建群组（名字 = title ?? name，经 pickGroupName）、写镜像、挂接；已挂接返回原 id；无所有者返回 null。 */
  linkChannel(channelId: string): Promise<string | null>;
  /** 把已有群组挂到频道：一个事务里挂接、title 改成群组名、改写镜像。 */
  adopt(groupId: string, channelId: string): Promise<void>;
  /** 4.5：按 runtimeOrder(order(), bots()) 改写镜像，title ?? name 与群组名不同时改名（撞名保留原名并记日志）；未挂接返回 false。 */
  reconcile(channelId: string): Promise<boolean>;
  /** 频道改名后同步群组名；撞名保留原名，记 {"type":"waker-group-name-taken","channelId","groupId","name"}。 */
  syncName(channelId: string): Promise<void>;
  linkedGroupOf(channelId: string): Promise<string | null>;
  /** 挂着它的未删除频道，调用者帧下读得到才返回。 */
  liveChannelOf(groupId: string): Promise<string | null>;
};
export function createWakerGroupLink(deps: {
  database: Database;
  groupStore: Pick<GroupStore, "order" | "bots">;
  log?: (line: Record<string, unknown>) => void; // 默认 console.error(JSON.stringify(...))
}): WakerGroupLink;
```
- 所有方法自己定帧：在 `platform` 帧读频道的 `tenant_id`、`created_by`、`title`、`name`、`waker_group_id`，用 `channelOwner` 定所有者，写入在 `runAsTenant(所有者)` 里。
- 镜像 = `runtimeOrder(order(), bots())`，**不是交集**：旧多员工频道里可能有员工在 `channel_agents` 却没有 `group_bot_threads` 排序行（`createChannelStore.create` 不建），运行时把它们按 id 追加在后，镜像也要包含；`position` 写 `"0"`、`"1"`…；整体 delete + insert，并更新 `waker_groups.updated_at`（复用 `store.setMembers` 的写法，但不走它的「员工可见」校验：真相已经由上游校验过）。
- `store.ts`：`export type ListedWakerGroup = WakerGroup & { channelId: string | null }`；`list(): Promise<ListedWakerGroup[]>`，多一次读 `select id, waker_group_id from channels where waker_group_id in (...) and deleted_at is null`（调用者帧）。`create`、`setMembers` 返回值不变。

- [ ] **Step 1：写失败测试**（追加到新文件，`describe("link core")`）：
  - `channelOwner follows the owner rule`：`{tenantId:"team",createdBy:"u1"}` → `"u1"`；`{tenantId:"team",createdBy:null}` → `null`；`{tenantId:"u2",createdBy:null}` → `"u2"`。
  - `pickGroupName adds （2） up to （99）, then the id prefix, within 80 characters`：已有「复盘」→ 得「复盘（2）」；预置「复盘」「复盘（2）」…「复盘（99）」→ 得 `复盘${id.slice(0,6)}`；81 字的名字 → 结果长度 ≤ 80；`except` 为自身 id 时同名不算撞。
  - `linkChannel makes the crew, mirrors the order and links, once`：共享群员工按 `[b2, b1]` 建 → 群组 `name` 等于频道 `name`，镜像 `[{b2,"0"},{b1,"1"}]`，频道 `waker_group_id` 等于返回值；再调一次返回同一 id，`waker_groups` 行数不变。
  - `linkChannel on a shared group with no creator makes nothing`：`platform` 帧把 `created_by` 置 NULL → 返回 `null`，没有新群组。
  - `runtimeOrder puts unordered Bots after the ordered ones, by id`：`runtimeOrder(["b","x","a"], ["d","a","c","b"])` 等于 `["b","a","c","d"]`。
  - `the mirror keeps a Bot that has no order row`：`platform` 帧插一个 `tenant_id = alice` 的三员工频道，只给其中两位写 `group_bot_threads`（`seedOrder`）→ `linkChannel` 后镜像 3 行，无排序行的那位排最后；`reconcile` 后不变。
  - `adopt links an existing crew, renames the channel to it and mirrors the chat`：title 变成群组名，镜像等于频道顺序。
  - `reconcile rewrites the mirror after a Bot is deleted`：`platform` 帧删一位员工（`channel_agents` 级联），`reconcile` 返回 `true`，镜像少了这位。
  - `reconcile keeps the crew's name when the title is taken, and says so`：另建同租户群组占用新 title；频道改 title 后 `reconcile` → 群组名不变，`log` 收到 `type: "waker-group-name-taken"`。
  - `the list carries channelId for a live linked channel only, and still hides a WakerFlow crew`：挂接后 `store.list()` 该项 `channelId` 为频道 id；软删频道后为 `null`；WakerFlow 内部群组不在列表里。
  - `another tenant's list sees no channelId of ours`：bob 帧 `list()` 不含 alice 的群组。
- [ ] **Step 2：运行** 服务端测试 `tests/waker-group-channel-link.integration.test.ts`，预期失败。
- [ ] **Step 3：实现。**
- [ ] **Step 4：运行** 同文件与 `tests/waker-groups.test.ts`、`tests/wakerflows-store.integration.test.ts`、`tests/portraits.test.ts`，全部通过；server tsc、biome。
- [ ] **Step 5：登记**清单，提交 `群组挂接：channel-link 列片段、取名规则、挂接与镜像自愈`。

### Task 3：装饰器与装配（建群即挂、改名同步）

**建议执行模型**：opus　**评审方式**：完整评审

**文件：**
- 修改：`S/waker-groups/channel-link.ts`（加两个装饰器）
- 修改：`S/index.ts`：
  - `:947` `threadIdentity` 之后建 `const wakerGroupLink = createWakerGroupLink({ database, groupStore: createGroupStore(database, () => threadIdentity.mint()) })`；
  - `:959` `channelStore` 构造处用 `withChannelRenameLink(…, wakerGroupLink)` 包住；
  - `:4130` 改为 `const baseGroupConversations = createGroupConversations({…})`，紧接 `const groupConversations = withWakerGroupLink(baseGroupConversations, wakerGroupLink)`；其余引用 `groupConversations` 的地方（`:3659`、`:4220`、`:4247`、`:4370`、`:4920`、`:4935`）不动，自然拿到装饰后的对象。
- 测试：追加到 `waker-group-channel-link.integration.test.ts`（`describe("decorators")`）

**接口：**
```ts
type LinkedGroupWrites = Pick<GroupConversations, "create" | "addBots" | "removeBots" | "reorder">;
/** create：上游建完后 linkChannel，失败只记 {"type":"waker-group-link-failed","channelId","error"}；返回 { ...channel, wakerGroupId?: string }。
 *  addBots/removeBots/reorder：上游成功后 reconcile(channel)；reconcile 失败只记日志。其余成员原样透传。 */
export function withWakerGroupLink<T extends LinkedGroupWrites>(groups: T, link: WakerGroupLink): T & {
  create(owner: string, input: unknown): Promise<Awaited<ReturnType<T["create"]>> & { wakerGroupId?: string }>;
};
/** rename：上游成功后 link.syncName(channelId)；失败只记日志。 */
export function withChannelRenameLink(store: ChannelStore, link: WakerGroupLink): ChannelStore;
```
- `/api/groups` 的 `POST /` 原样 `json` 返回 `channel`，所以新字段自动出现在返回里（设计稿 6.1）。`S/channels/routes.ts` 的 `channelDto` 不加字段。

- [ ] **Step 1：写失败测试**：
  - `a group made through POST /api/groups comes back linked`：用 `createGroupRoutes(withWakerGroupLink(base, link), requireUser)` 发请求 → 201，`channel.wakerGroupId` 是 uuid；`store.list()` 含该群组且 `channelId === channel.id`。
  - `a staffing group proposal ends linked and named as the draft`：照 `tests/staffing-executor.integration.test.ts` 建 `createStaffingExecutor`，`groups` 传装饰后的对象、`channels` 传 `withChannelRenameLink(...)`；执行一条 `group` 提议（草稿名「周报群组」）→ 频道已挂接，群组 `name === "周报群组"`。
  - `adding, removing and reordering Bots rewrites the mirror`：经装饰后的 `addBots`、`removeBots`、`reorder` 各一次，每次之后镜像等于 `runtimeOrder(order(), bots())`。
  - `renaming a linked channel renames its crew; a taken name keeps the old one`：`channelStore.rename(actor, id, "新名")` → 群组名「新名」；改成已被别的群组占用的名字 → 群组名不变，日志 `waker-group-name-taken`，频道 title 是新名字。
  - `a failed link does not fail the create`：传一个 `linkChannel` 抛错的假 link → `create` 正常返回，无 `wakerGroupId`，日志 `waker-group-link-failed`。
  - `Bot changes on an unlinked channel touch no crew`：未挂接频道 `addBots` 后 `waker_groups` 行数不变。
- [ ] **Step 2：运行**，预期失败。
- [ ] **Step 3：实现**装饰器与 `S/index.ts` 装配（`S/index.ts` 是上游文件：只加上面三处，不改别的行）。
- [ ] **Step 4：运行** 同文件与 `tests/group-conversations.test.ts`、`tests/group-conversations.integration.test.ts`、`tests/group-bots-change.integration.test.ts`、`tests/staffing-executor.integration.test.ts`、`tests/staffing-routes.integration.test.ts`，全部通过；server tsc。
- [ ] **Step 5：提交** `群组挂接：建群即挂，增删排序与改名同步到群组`。

### Task 4：接口一（建群组并开聊天、改名、开聊天、打开设置）

**建议执行模型**：opus　**评审方式**：完整评审

**文件：**
- 新建：`S/waker-groups/linked-actions.ts`
- 修改：`S/waker-groups/routes.ts`、`S/index.ts`（`:5218` 路由挂载处传第三参数）
- 测试：追加到 `waker-group-channel-link.integration.test.ts`（`describe("routes")`）

**接口：**
```ts
export class WakerGroupSizeError extends Error {}      // message「一个群组要有 2 到 20 位员工。」
export class WakerGroupLinkedError extends Error {}    // message「这个群组已经可以聊天了。」（chat 对已挂接群组）
export class WakerGroupForbiddenError extends Error {} // message「只有发起人能调整这个群组。」
export type WakerGroupActions = {
  createWithChat(owner: string, input: { name: string; description: string | null; agentIds: string[] }): Promise<{ group: ListedWakerGroup; channel: AgentChannel & { wakerGroupId: string } }>;
  rename(owner: string, groupId: string, patch: { name?: string; description?: string | null }): Promise<ListedWakerGroup | null>;
  startChat(owner: string, groupId: string): Promise<{ group: ListedWakerGroup; channel: AgentChannel & { wakerGroupId: string } } | null>;
  forChannel(owner: string, channelId: string): Promise<ListedWakerGroup | null>; // 非创建者抛 WakerGroupForbiddenError
  list(owner: string): Promise<StatusedWakerGroup[]>;
  // Task 5 追加：setMembers、dissolve
};
/** 未完成的升级转换占用的频道（Task 14 用 createConversionClaims 实现；PR1 不传）。claimedBy 返回占用它的群组 id；finish 在所有者帧 adopt 并把台账改 converted。 */
export type ConversionClaims = { claimedBy(channelId: string): Promise<string | null>; finish(groupId: string, channelId: string): Promise<void> };
export type ChatStatus = "chat" | "pending_members" | "too_many" | "not_started";
export type StatusedWakerGroup = ListedWakerGroup & { usableMemberCount: number; chatStatus: ChatStatus };
export function createWakerGroupActions(deps: {
  database: Database;
  store: WakerGroupStore;
  link: WakerGroupLink;
  groups: Pick<GroupConversations, "create" | "addBots" | "removeBots" | "reorder">; // 未装饰的 baseGroupConversations
  channels: Pick<ChannelStore, "get" | "rename" | "softDelete">;                   // 装饰后的 channelStore
  actorFor(userId: string): Promise<AgentActor>;
  portraits: Pick<PortraitStore, "remove" | "removeMedia">;
  canUse(ownerUserId: string, agentId: string): Promise<boolean>; // 与 canUseBot 同一判断（S/index.ts:4206-4209）
  conversions?: ConversionClaims; // Task 14 装配
}): WakerGroupActions;
export function createWakerGroupRoutes(store: WakerGroupStore, requireUser: MiddlewareHandler<Ctx>, actions?: WakerGroupActions): Hono<Ctx>;
```
- 路由（只在传了 `actions` 时挂；不传时与现在完全一样）：
  - `POST /`：带 `agentIds`（字符串数组）时走 `createWithChat`：去重后不足 2 或超过 20 → 400 `WakerGroupSizeError`；名字 400/409 同旧；顺序：建群组 → `groups.create(owner, { agentIds })`（未装饰，避免再建一个群组）→ `link.adopt`；建频道失败：`store.remove(group.id)` 再抛；频道已建成但 `link.adopt` 失败：先 `channels.softDelete(actor, channel.id)`（创建者帧，0122 守卫允许），再 `store.remove(group.id)`，再抛原错误，不留下未挂接的空群聊。返回 201 `{ group, channel }`。不带 `agentIds` 走旧逻辑。
  - `PATCH /:id`：`{ name?, description? }`。名字 1–80 字（400），撞名 409（`WakerGroupNameTakenError`，`pickGroupName` 不用于用户改名）。已挂接：`channels.rename(actor, channelId, name)`（装饰器把群组名改过来），`description` 直接写群组；未挂接：只改群组。别人的 id 404。
  - `POST /:id/chat`：已挂接 409（`WakerGroupLinkedError`）；`chatStatus` 不是 `not_started` → 409（`WakerGroupSizeError`）；否则用可用员工（按 `position`）`groups.create` + `adopt`，201 `{ group, channel }`；`adopt` 失败时 `channels.softDelete` 刚建的频道再抛，群组保持未挂接。
  - `GET /`（传了 `actions` 时改走 `actions.list`）：每项在 `ListedWakerGroup` 之上多 `usableMemberCount`（成员里 `canUse(owner, id)` 为真的个数）与 `chatStatus`：`channelId` 非空 → `chat`；否则 `usableMemberCount < 2` → `pending_members`；`> 20` → `too_many`；其余 `not_started`。升级转换记成 `pending_members` 的群组保留了全部成员行，只看 `members.length` 会误判，所以状态由服务端给。
  - `POST /for-channel/:channelId`：`channels.get(actor, id)` 读不到 → 404；`created_by`（个人旧频道用 `tenant_id`）不是调用者 → 403 `{ error: "只有发起人能调整这个群组。" }`；否则：传了 `conversions` 且 `claimedBy(channelId)` 非空 → `finish(那个群组, channelId)`；不然 `linkChannel`（没挂就补）；之后 `reconcile`，200 `{ group }`。
  - 注册顺序：`/for-channel/:channelId` 先于 `/:id/chat`，避免 `POST /for-channel/chat` 被后者截走。
- `S/index.ts:5218`：`createWakerGroupRoutes(createWakerGroupStore(database), requireUser…, createWakerGroupActions({ database, store, link: wakerGroupLink, groups: baseGroupConversations, channels: channelStore, actorFor, portraits: createPortraitStore(database), canUse: <与 canUseBot 同一 lambda> }))`。

- [ ] **Step 1：写失败测试**（`requireUser` 照 `tests/waker-groups.test.ts:40-52`，按测试切换 alice/bob）：
  - `POST with agentIds makes the crew and its chat in one call`：201；`channel.title === group.name`；`group.channelId === channel.id`；`order(channel.id)` 等于提交顺序；镜像同序。
  - `POST with a taken name answers 409 and makes no channel`：频道数不变。
  - `POST with 1 or 21 agentIds answers 400 and makes nothing`：`error === "一个群组要有 2 到 20 位员工。"`，`waker_groups` 行数不变。
  - `POST whose chat cannot be made removes the crew it just made`：`agentIds` 含一位 alice 用不了的员工 → 非 2xx，同名群组不存在。
  - `POST whose adopt fails after the chat was made hides that chat and removes the crew`：传一个 `adopt` 抛错的 link 包装 → 非 2xx；刚建的频道 `deleted_at` 非空；同名群组不存在。
  - `POST chat whose adopt fails hides the chat it made and keeps the crew unlinked`：同样注入 → 频道已软删，群组仍在且 `channelId === null`。
  - `the list states chatStatus from usable members, not the row count`：`platform` 帧给 alice 的群组写 3 行成员，其中 2 位是 bob 的私有员工 → `usableMemberCount: 1`、`chatStatus: "pending_members"`、`members.length === 3`；另造 `chat`、`too_many`（21 位可用）、`not_started`（2 位可用、无频道）各一例。
  - `POST without agentIds is the old behaviour`：201，`members` 为 `[]`，列表里 `channelId === null`。
  - `PATCH renames both sides and refuses a taken name`：已挂接群组改名 → 频道 title 与群组名都变；改成已占用名字 → 409，两边都不变；未挂接群组改名只改群组。
  - `POST chat opens a chat for a crew of 2–20 that has none, and refuses otherwise`：2 位未挂接 → 201；再调 → 409；1 位 → 409。
  - `for-channel links an unlinked channel for its creator, and a second call changes nothing`：`platform` 帧把某频道 `waker_group_id` 置 NULL（模拟旧群聊）→ 第一次返回新群组，第二次返回同一 id，`waker_groups` 行数不变。
  - `for-channel answers 403 to a member who is not the creator and 404 to a stranger`：bob 是成员 → 403；carol 不是成员 → 404。
  - `another tenant gets 404 from PATCH and chat`：bob 对 alice 的群组 id → 404，alice 的群组不变。
- [ ] **Step 2：运行**，预期失败。
- [ ] **Step 3：实现。**
- [ ] **Step 4：运行** 同文件与 `tests/waker-groups.test.ts`（未改一行，必须原样通过）、`tests/spa-business-routes.integration.test.ts`；server tsc。
- [ ] **Step 5：提交** `群组接口：建群组即开聊天、改名、开始聊天、打开设置时补挂`。

### Task 5：接口二（成员翻译、解散）与跨租户断言

**建议执行模型**：opus　**评审方式**：完整评审

**文件：**
- 修改：`S/waker-groups/linked-actions.ts`、`S/waker-groups/routes.ts`
- 修改：`openbot/scripts/ci/assert-tenants.mjs`（新增两条断言）
- 测试：追加到 `waker-group-channel-link.integration.test.ts`（`describe("members and dissolve")`）

**接口：**
```ts
export type MemberStep = { op: "add" | "remove" | "reorder"; agentIds: string[] };
export class WakerGroupStepsError extends Error { done: MemberStep[] } // 409 { error, done }
export class WakerGroupRunningError extends Error {}                    // message「有组团流程正在运行，先停下再解散。」
// WakerGroupActions 追加：
setMembers(owner: string, groupId: string, agentIds: string[]): Promise<ListedWakerGroup | null>;
dissolve(owner: string, groupId: string): Promise<boolean>; // false = 不存在或不是你的（404）
```
- `PUT /:id/members`（传了 `actions` 时改走 `actions.setMembers`）：
  - **已挂接**：去重后不在 2–20 → 409 `WakerGroupSizeError`。`current = runtimeOrder(order(), bots())`，`toAdd = 目标 − current`（按目标顺序），`toRemove = current − 目标`。循环直到两者都空：先 `addBots`（取 `min(toAdd, 20 − 当前数)` 个），再 `removeBots`（取 `min(toRemove, 当前数 − 2)` 个）；一轮两步都没进展就抛错。这是设计稿「先加到 20，再移，再加剩下的」在 20 位全换时不踩 2 位下限的写法。最后 `reorder(目标)`，`reconcile`。任一步抛错：`reconcile` 后抛 `WakerGroupStepsError`，`done` 为已成功的步骤。调用未装饰的 `groups`（上游 `creatorOnly` 照常生效）。
  - **未挂接**：`store.setMembers` 照旧；结果的 `chatStatus` 为 `not_started`（可用员工 2–20 位）就 `startChat`，返回的 `group.channelId` 非空。
- `DELETE /:id`（传了 `actions` 时改走 `actions.dissolve`）：
  1. 群组有未结束的运行 → `WakerGroupRunningError`（409）。「未结束」= `group_task_runs.status IN ('running','awaiting_action')`：设计稿 7.5 写的 `queued` 在代码里不存在（`S/pipeline/store.ts:55` 的状态只有 running / awaiting_action / done / failed / aborted），`awaiting_action` 是唯一另一个未结束状态。
  2. 已挂接：`channels.softDelete(actor, channelId)`。
  3. `store.remove(groupId)`（模板、运行记录按 0075 外键级联；频道挂接由外键 `SET NULL` 清空，走守卫放行 b）。
  4. `portraits.remove("group", id)`、`portraits.removeMedia("group", id)`。未挂接的群组同样执行 3、4。
  看板任务卡不删。
- `assert-tenants.mjs`：在 `businessPaths` 循环之后，A `POST /api/waker-groups { name }` 建一个群组；B 对它 `PATCH`（`{ name: "被他人改名" }`）、`DELETE` 各一次，`check(status === 404, "B renaming A group returns 404")`、`check(status === 404, "B dissolving A group returns 404")`；之后 A 的列表里该群组仍在、名字不变。

- [ ] **Step 1：写失败测试**：
  - `PUT members on a linked crew adds, removes and reorders the chat`：`[a,b,c]` → `[c,d,a]`：`runtimeOrder(order(), bots())` 等于 `[c,d,a]`，镜像同序。
  - `PUT members swaps all 20 for 20 others`：20 位全换成另 20 位 → 200，最终顺序等于目标。
  - `PUT members on a linked crew refuses 1 or 21 with 409`：`error === "一个群组要有 2 到 20 位员工。"`，频道成员不变。
  - `a step that fails part-way answers 409 with what was done, and the mirror matches the chat`：目标含一位 alice 用不了的员工 → 409，`done` 只含已成功步骤，镜像等于 `runtimeOrder(order(), bots())`。
  - `PUT members on an unlinked crew that reaches two opens its chat`：0 位 → 2 位，返回 `group.channelId` 非空；0 → 1 位不开聊天。
  - `DELETE dissolves: chat hidden, crew gone with its flows, portrait gone, board cards kept`：挂接群组有一条模板、一条 `done` 运行、一条头像、一张看板任务卡 → 200；频道 `deleted_at` 非空；`waker_groups`、模板、运行、`portraits`、`portrait_media` 行都没了；任务卡仍在。
  - `DELETE refuses while a run is running or awaiting_action, and changes nothing`：两种状态各测一次 → 409「有组团流程正在运行，先停下再解散。」，频道未删、群组和头像都在。
  - `DELETE on an unlinked crew also removes its portrait`。
  - `another tenant gets 404 from PUT members and DELETE`：bob → 404，alice 的群组、频道不变。
- [ ] **Step 2：运行**，预期失败。
- [ ] **Step 3：实现**；改 `assert-tenants.mjs`。
- [ ] **Step 4：运行** 同文件、`tests/waker-groups.test.ts`、`tests/portraits.test.ts`、`tests/portrait-media.test.ts`、`tests/pipeline-*.test.ts`（以 `ls tests | grep '^pipeline-'` 列出的为准）、`tests/staffing-*.test.ts`；`cd openbot && node --check scripts/ci/assert-tenants.mjs`；server tsc、biome。推送后看 CI：`server-test` 各分片、`static`、`e2e-wakerflow`（G4）全绿；`assert-tenants` 所在的交付断言 job 全绿。
- [ ] **Step 5：提交** `群组接口：管理成员翻译成群聊增删排序，解散一并删除流程与头像；跨租户断言加两条`。（PR 说明附 PR1 验收清单挪到 Task 5A。）

### Task 5A：创建者退群或被停用后的移交

设计依据：设计稿 3.1.1 与第 11 节 Q5–Q8（用户 2026-11-13 裁定）。本任务承接 Task 5 原 Step 5 的「PR 说明附 PR1 验收清单」。

**建议执行模型**：opus　**评审方式**：完整评审，逐行核对：
- 0207 不 `CREATE OR REPLACE` 任何已有函数；
- 只有 `openbot_team_channel_hand_over` 授权给应用；
- 陌生人拿不到信息；
- 停用触发器不会让停用失败；
- 搬运范围与设计稿 3.1.1 第 5 条一致。

**文件：**
- 新建：`openbot/server/recovery/recovery-20261018-v1/sql/0207_team_channel_hand_over.sql`
- 修改：`openbot/server/recovery/recovery-20261018-v1/meta/_journal.json`（idx 207，`when` 取真实当前毫秒且 > `1794537806196`）
- 修改：`S/waker-groups/channel-link.ts`
  - `WakerGroupLink` 加 `leave`、`handOver`；
  - `reconcile` 改为写镜像后在同一事务里重读频道；
  - `withWakerGroupLink` 覆盖 `removeMember`。
- 修改：`S/waker-groups/linked-actions.ts`：`forChannel` 先移交再判断所有者；`WakerGroupOwnerGoneError` 只改注释。
- 修改（只改注释）：`openbot/server/tests/waker-group-channel-link.integration.test.ts:1885-1887` 的 `TODO(Task 5A)`（Task 5 在 `:2531` 加的同类注释一并照改），改写为：「这里锁的是绕过服务的退群（直接删成员行），按设计稿 3.1.1 方案 A 不当场移交，仍回 409」。**断言一字不动。**
- 测试（新建）：`openbot/server/tests/waker-group-hand-over.integration.test.ts`；登记 `openbot/scripts/ci/server-tests.list.txt`
- **不改**：
  - `S/channels/group.ts`、`S/index.ts`；
  - 三条停用路径的 TS（`S/auth/scim.ts`、`S/people/store.ts`、`S/platform/store.ts`）；
  - 任何守卫或策略；
  - 任何已有断言。

**接口（SQL，按顺序）：**
1. 角色自检（照 `0206:23-27`，报错写 `0207`）。
2. `openbot_team_channel_hand_over_write(p_channel_id text, p_from text, p_heir text, p_group_id uuid) RETURNS void`
   - 属性：`LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public SET app.tenant_id = 'platform'`；只 `REVOKE ALL … FROM PUBLIC`，不授权。
   - `p_heir IS NULL`：`UPDATE channels SET deleted_at = now() WHERE id = p_channel_id AND deleted_at IS NULL`，然后返回。
   - 否则 `UPDATE channels SET created_by = p_heir WHERE id = p_channel_id`。`p_group_id` 为空，或 `waker_groups.tenant_id <> p_from`，到此返回。
   - 群组：循环改 `tenant_id = p_heir, name = 候选名, updated_at = now()`。候选名依次为：原名；`left(原名, 80 - 后缀长度) || '（n）'`（n = 2…99）；`left(原名, 74) || left(p_group_id::text, 6)`。每次 `EXCEPTION WHEN unique_violation` 就试下一个，最后一个也撞就 `RAISE`。
   - 头像：`DELETE FROM portraits WHERE tenant_id = p_heir AND subject_kind = 'group' AND subject_id = p_group_id::text`，再把 `tenant_id = p_from` 的同键行改为 `p_heir`。`portrait_media` 照做。
   - 模板：`group_task_templates`（`group_id = p_group_id AND tenant_id = p_from`）的 `tenant_id` 改为 `p_heir`。
   - 运行与附属行：先建临时集合 `runs := SELECT id, parent_task_id, steps FROM group_task_runs WHERE group_id = p_group_id AND tenant_id = p_from`（用 CTE 或临时数组），再依次：
     - `group_task_runs`：`id IN runs` → `tenant_id = p_heir`；
     - `tasks`：`tenant_id = p_from` 且（`id IN (runs.parent_task_id)` 或 `parent_task_id IN (runs.parent_task_id)` 或 `id IN (SELECT (s->>'taskId')::uuid FROM runs, jsonb_array_elements(runs.steps) s WHERE s ? 'taskId')`）→ `tenant_id = p_heir`，并记下这些卡的 id；
     - `task_archives`：`task_id IN (上一步的卡)` → `tenant_id = p_heir`；
     - `group_pipeline_start_receipts`：`run_id IN runs AND tenant_id = p_from` → `p_heir`；
     - `flow_confirmations`、`flow_run_events`（`run_id IN runs`）以及 `flow_run_retries`（`source_run_id IN runs OR new_run_id IN runs`），都限 `tenant_id = p_from` → `p_heir`。
   - **不动**：`usage_counters`、审批、`audit_events`、`group_bot_threads`、`waker_group_members`。
3. `openbot_team_channel_hand_over_core(p_channel_id text) RETURNS text`
   - 属性：`SECURITY DEFINER`，固定 `search_path`；`REVOKE ALL FROM PUBLIC`，不授权。
   - 函数体：
     1. `SELECT tenant_id, created_by, waker_group_id INTO c FROM channels WHERE id = p_channel_id FOR UPDATE`。没找到、`tenant_id IS DISTINCT FROM 'team'`、或 `created_by IS NULL`，返回 NULL。频道已软删（`deleted_at IS NOT NULL`）：返回 `c.created_by`，什么都不改（设计稿 3.1.1 第 4.1 条）。
     2. 定义「在籍」：`EXISTS (SELECT 1 FROM channel_memberships m WHERE m.channel_id = c.id AND m.tenant_id = 'team' AND m.user_id = X) AND NOT EXISTS (SELECT 1 FROM users u JOIN revoked_access r ON r.email = lower(u.email) WHERE u.id = X)`。`created_by` 在籍时返回 `c.created_by`。
     3. `heir := SELECT m.user_id FROM channel_memberships m JOIN users u ON u.id = m.user_id WHERE m.channel_id = c.id AND m.tenant_id = 'team' AND NOT EXISTS (SELECT 1 FROM revoked_access r WHERE r.email = lower(u.email)) ORDER BY m.created_at, u.email LIMIT 1`。不加 `COLLATE`。
     4. `heir IS NULL`：
        - 一个成员都没有：`PERFORM hand_over_write(c.id, c.created_by, NULL, NULL)`，返回 NULL；
        - 否则返回 `c.created_by`，不改。
     5. `c.waker_group_id` 非空，并且存在 `group_task_runs WHERE group_id = c.waker_group_id AND status IN ('running','awaiting_action')`：`RAISE EXCEPTION 'a crew run is still going' USING ERRCODE = '55006'`。
     6. `PERFORM hand_over_write(c.id, c.created_by, heir, c.waker_group_id)`，返回 heir。
4. `openbot_team_channel_hand_over(p_channel_id text) RETURNS text`
   - 属性：`SECURITY DEFINER`，固定 `search_path`；`REVOKE ALL FROM PUBLIC`；`GRANT EXECUTE TO openbot_app`。
   - 函数体：
     - `frame IN ('system','team','')` → 42501；
     - 不加锁读 `created_by`。`frame <> 'platform'` 且（行不存在，或 `frame` 既不是 `created_by`、`openbot_team_channel_member(p_channel_id)` 也为假）→ `RAISE EXCEPTION 'only a member hands a shared group over' USING ERRCODE = '42501'`；
     - 通过后 `RETURN openbot_team_channel_hand_over_core(p_channel_id)`。
5. `openbot_team_person_leaves_groups(p_user_id text) RETURNS void`
   - 属性：`SECURITY DEFINER`，固定 `search_path`；`REVOKE ALL FROM PUBLIC`，不授权。
   - 先 `owned := ARRAY(SELECT id FROM channels WHERE tenant_id = 'team' AND created_by = p_user_id ORDER BY id)`；
   - 再 `DELETE FROM channel_memberships WHERE user_id = p_user_id AND tenant_id = 'team'`（不删映射：同「被别人移出」）；
   - 对 `owned` 逐个 `BEGIN PERFORM openbot_team_channel_hand_over_core(id); EXCEPTION WHEN SQLSTATE '55006' THEN NULL; END;`。其他异常照常抛出。
6. `openbot_team_revoked_leaves() RETURNS trigger`
   - 属性：`SECURITY DEFINER`，固定 `search_path`；`REVOKE ALL FROM PUBLIC`。
   - 函数体：`FOR uid IN SELECT id FROM users WHERE lower(email) = NEW.email LOOP PERFORM openbot_team_person_leaves_groups(uid); END LOOP; RETURN NULL;`
   - `CREATE TRIGGER openbot_team_revoked_leaves AFTER INSERT ON public.revoked_access FOR EACH ROW EXECUTE FUNCTION public.openbot_team_revoked_leaves();`
7. 存量补做（放在文件最后）：
   ```sql
   DO $$ DECLARE previous text := current_setting('app.tenant_id', true); uid text; BEGIN
     PERFORM set_config('app.tenant_id', 'platform', true);
     FOR uid IN SELECT u.id FROM users u JOIN revoked_access r ON r.email = lower(u.email) LOOP
       PERFORM public.openbot_team_person_leaves_groups(uid);
     END LOOP;
     PERFORM set_config('app.tenant_id', coalesce(previous, ''), true);
   END $$;
   ```
8. 文件头注释写明：
   - 为什么不改守卫（`0122:116-160` / `0125:69-113`、`0206:44-73` 只放行 `platform`）；
   - 为什么用函数级 `SET app.tenant_id`；
   - 为什么只有一个函数授权给应用；
   - 接手人规则与 `people()` 一致；
   - 为什么挂在 `revoked_access` 上：三条停用路径的唯一交汇点；它没有 RLS，属于现有的信任边界；
   - 搬什么、不搬什么（设计稿 3.1.1 第 5 条）；
   - 存量补做。

**接口（TS）：**
```ts
// channel-link.ts
export type WakerGroupLink = {
  // …原有方法不变…
  /**
   * 创建者本人退群（3.1.1 第 4.2 条）：owner 帧一个事务：
   * `select … from channels where id = $1 and deleted_at is null for update`（要求 tenant_id = 'team'、created_by = owner）
   * → 删自己的成员行与 intelligence_channel_mappings → select openbot_team_channel_hand_over($1)。
   * 读不到、不是 team、或不是创建者时返回 null（交给上游）。55006 时整体回滚，抛 GroupRefusedError("有组团流程正在运行，先停下再退群。")。
   */
  leave(owner: string, channelId: string): Promise<{ heir: string | null } | null>;
  /** 在当前帧调 openbot_team_channel_hand_over；55006 时记 {"type":"waker-group-hand-over-deferred","channelId"}，返回 deferred。 */
  handOver(channelId: string): Promise<{ owner: string | null; deferred: boolean }>;
};
```
- `reconcile`（签名不变）：
  - `truth()` 照旧在事务外经注入的 `groupStore` 读；
  - 事务里先 `select tenant_id, created_by from channels where id = $1 for share`（owner 帧），再 `writeMirror`。读不到，或锁到的行按 `channelOwner` 已不是这一轮的所有者，就抛内部标记，让事务回滚（先锁后写与退群的加锁顺序一致，免得死锁；比对 `created_by` 见设计稿 3.1.1 第 8 条）；
  - 回滚后重读 `facts`：所有者变了，就在新所有者帧重做一次；没变，就记**一行** `waker-group-owner-gone`，返回 false；
  - 开头的 `ownerSees` 读不到时同样先重读所有者；
  - 一次调用最多一行 `owner-gone`。
- `withWakerGroupLink`：`LinkedGroupWrites` 加 `"removeMember"`：
  ```ts
  async removeMember(owner, channel, userId) {
    if (userId !== owner) return groups.removeMember(owner, channel, userId);
    const left = await link.leave(owner, channel);
    if (left === null) return groups.removeMember(owner, channel, userId);
    if (left.heir) { try { await link.reconcile(channel); } catch (error) { log({ type: "waker-group-reconcile-failed", channelId: channel, error: messageOf(error) }); } }
  }
  ```
- `linked-actions.ts` 的 `forChannel`：`isGroupConversation` 之后，如果 `row.tenant_id === 'team' && row.created_by !== owner`，就 `const { owner: now } = await link.handOver(channelId)`，用 `now` 判断所有者。其余不变。

- [ ] **Step 0：验证前提**。在测试库执行：
  ```sql
  CREATE FUNCTION pg_temp.t() RETURNS text LANGUAGE sql SET app.tenant_id = 'platform' AS $$ SELECT current_setting('app.tenant_id') $$;
  SELECT pg_temp.t(), current_setting('app.tenant_id', true);
  ```
  第一列应为 `platform`，第二列应为调用前的值。不支持的话，写入函数改用 `0114:23-35` 的保存再还原写法，并在报告里写明。
- [ ] **Step 1：写失败测试** `waker-group-hand-over.integration.test.ts`。
  - 夹具照 `tests/waker-group-channel-link.integration.test.ts:63-259`（`person`、`bot`、`crew`、`sharedGroup`、`linkCore`、`channelRow`、`crewRow`、`mirror`、`conversations()`）。
  - 另写 `runWithCards(owner, groupId, status)`：在所有者帧插一条模板、一张父卡（`source: 'group_run'`）、两张步骤卡（`parent_task_id` = 父卡），以及一条运行（`parent_task_id` = 父卡，`steps[i].taskId` = 步骤卡），再给父卡插一条 `task_archives`。
  - 停用夹具直接调三条真实路径：
    - `reconcileDirectoryState({ database, initialAdminEmails: [] }, { userId, active: false })`（`S/auth/scim.ts:64`）；
    - `createPeopleStore(…).revoke(userId, adminId)`（`S/people/store.ts:174, 318`）；
    - `suspendTenant(database, userId, operator)`。
  - `afterEach` 在 `platform` 帧清理 `revoked_access`（按本文件的邮箱前缀）、`portraits`、`portrait_media`、`task_archives`、`tasks`、`group_task_runs`、`group_task_templates`。

  `describe("hand-over function (0207)")`：
  - `the journal registers 0207 after 0206`：`idx: 207, tag: "0207_team_channel_hand_over"`，`when > 1794537806196`。
  - `a creator who leaves hands the group to the earliest member still in it`：
    - 准备：alice 建群，分两次加 bob、carol；
    - 操作：alice 帧的事务里删自己的成员行，然后调函数；
    - 断言：返回 bob；`created_by === bob`；bob 帧下 `groupStore.people(channel)[0].userId === bob`。
  - `members who joined at the same moment are ordered by email`：
    - 准备：`platform` 帧插两条 `created_at` 相同的成员行，先插邮箱大的；
    - 断言：接手人是邮箱小的那位，并且等于他帧下读到的 `people()[0]`。
  - `everything moves to the heir: crew, portrait, video, templates, runs, their cards and archive stamps`：
    - 准备：挂接群组，带头像、视频，加 `runWithCards(alice, g, "done")`；
    - 断言：`waker_groups`、`portraits`、`portrait_media`、`group_task_templates`、`group_task_runs`、三张卡、`task_archives` 的 `tenant_id` 全部是 bob；镜像行数和顺序不变；
    - bob 帧：`crewStore.list()` 含该群组且 `channelId === channel.id`；`GET /api/tasks?group=<g>` 返回父卡与两张步骤卡；
    - alice 帧：两者都不含；
    - `usage_counters` 中 alice 的计数不变。
  - `the run's coordination rows move too`：`platform` 帧给这条运行插一行 `group_pipeline_start_receipts` 和一行 `flow_run_events`（`tenant_id = alice`）→ 移交后都是 bob。
  - `cards of another tenant or another crew stay put`：alice 另有一条不属于这个群组的运行和卡，bob 自己也有卡 → 都不变。
  - `a name the heir already uses gets （2）, and the chat keeps its title`。
  - `nothing moves while a crew run is still going`：`running` 和 `awaiting_action` 各一次 → 报 `55006`；事务回滚后 alice 仍是成员，`created_by === alice`，运行、卡、模板仍是 alice。
  - `while the creator is in and active, a member's call changes nothing`：群组有一条 `running` 运行时 bob 帧调用 → 返回 alice（不报 55006），什么都没变，群组 `updated_at` 不变。
  - `a stranger is refused the same way whether or not the group exists`：carol 对这个群和一个随机 id 各调一次 → 都报 `42501`，报错文字相同。
  - `the last one out leaves the chat deleted and the crew with them`：
    - 准备：alice 独自一人，删自己的成员行后调函数；
    - 断言：返回 `null`；`deleted_at` 非空；`waker_group_id` 不变；群组、运行、卡仍是 alice；alice 帧 `crewStore.list()` 中该项 `channelId === null`。
  - `with only deactivated members left, nothing moves and the chat stays`：
    - 准备：bob 已停用后，又被 `platform` 帧重新插回成员行；alice 删自己的成员行后调函数；
    - 断言：返回 alice；`deleted_at` 为空；群组仍是 alice。
  - `a personal channel and a shared group with no creator are left alone`。
  - `platform can hand over a group whose creator was removed past the service`。
  - `the guards still refuse a direct created_by change, and only the outer function is the app's`：
    - bob 帧和 alice 帧 `update channels set created_by` 都报 `42501`；
    - 应用连接直接调 `_write`、`_core`、`openbot_team_person_leaves_groups` 都报 `42501`（permission denied）。
  - `the functions are definer, pin search_path, and only one is granted`：
    - 查目录：五个函数 `prosecdef` 为真；都有 `search_path=`；`_write` 的 `proconfig` 含 `app.tenant_id=platform`；
    - `has_function_privilege('openbot_app', …)`：只有 `openbot_team_channel_hand_over` 为真；
    - PUBLIC 全为假；
    - `pg_trigger` 里有 `openbot_team_revoked_leaves`，挂在 `revoked_access` 上，`AFTER INSERT ROW`，已启用。

  `describe("deactivation (0207 trigger)")`：
  - `a SCIM deactivation hands the creator's group to the earliest active member in the same write`：
    - 准备：alice 创建者，bob、carol 成员；
    - 操作：`reconcileDirectoryState(alice, active=false)`；
    - 断言：返回后**不等定时器**，立即读：`created_by === bob`；alice 已不在 `channel_memberships`；群组、运行、卡都是 bob。
  - `an administrator's removal does the same, inside its transaction`：`peopleStore.revoke(alice)` → 同上。另测一次：让同一事务在插入之后失败（在 `database.transaction` 里先插 `revoked_access`，再抛错）→ `created_by` 仍是 alice，alice 仍是成员。
  - `an operator's tenant suspension does the same`：`suspendTenant(database, alice, operator)` → 同上。
  - `the earliest member who is deactivated is skipped, and leaves the group`：
    - 准备：bob（最早）先被停用 → bob 离开群，`created_by` 仍是 alice；
    - 操作：再让 alice 退群；
    - 断言：接手人是 carol；bob 帧下 `people()` 为空（读不到）。
  - `a deactivated member who did not start the group just leaves it`：停用 carol → carol 不在成员里；`created_by`、群组都不变。
  - `a deactivated creator alone leaves the chat deleted and keeps the crew`：alice 独自一人被停用 → 频道软删，群组仍是 alice，状态 `not_started`（用 `actions.list`）。
  - `a chat already deleted is not handed over, so the crew stays with whoever owns its new chat`：旧聊天经旧路径软删、群组开了新聊天（只有 alice）后停用 alice → 旧聊天 `created_by` 仍是 alice、群组仍是 alice，新聊天软删。
  - `a running flow does not block a deactivation; the hand-over waits for a heal`：
    - 准备：alice 的群组有一条 `running` 运行，停用 alice；
    - 断言：停用成功（拒绝名单有她）；alice 已离开；`created_by` 仍是 alice；
    - 把运行改成 `done` 后，bob `POST /for-channel/:id` → 200，群组归 bob。
  - `restoring the account gives nothing back`：停用 alice 之后，依次用三条恢复路径（`reconcileDirectoryState(active=true)`、`peopleStore.restore`、`restoreTenant`）恢复 → `created_by` 仍是 bob；alice 不在成员里；群组仍是 bob。
  - `a second deactivation of the same person does nothing more`：同一邮箱再停用一次（冲突忽略），行数和归属都不变。
  - `an address with no account is deny-listed and nothing else happens`。
  - `0207 hands over for people deactivated before it`：
    - 准备：`platform` 帧先插 `revoked_access`，并用 `ALTER TABLE … DISABLE TRIGGER` 模拟迁移前的状态，事务内执行；
    - 操作：再执行 0207 的补做 `DO` 块（从 SQL 文件里取最后一个语句块）；
    - 断言：已停用的创建者离开、群组移交；
    - 整段放在事务里，最后回滚，照 `tests/team-group-bots-migration.integration.test.ts` 的 `Rollback` 写法。

  `describe("leaving through the service")`（路由 `createGroupRoutes(withWakerGroupLink(conversations(), link, log), requireUser)`）：
  - `the creator leaves through DELETE /members/:self and the earliest member takes over`：
    - 准备：三人、三位员工的群；
    - 操作：alice 删自己 → 204；
    - 断言：bob 帧 `list()` 的 `people[0]` 为 `{ userId: bob, creator: true }`；bob 改名成功，群组名跟着改；bob `removeBots` 一位成功，镜像等于 `runtimeOrder(order(), bots())`；alice `GET /api/groups/:id` → 404。
  - `the upstream service on its own still refuses a creator who leaves while others are in`。
  - `a creator cannot leave while a crew run is going, and stays in`：路由回 400，`error === "有组团流程正在运行，先停下再退群。"`；alice 仍是成员，`created_by === alice`。
  - `the last person out deletes the chat, and the crew can open a new one`：
    - 断言：204；频道 `deleted_at` 非空；`createWakerGroupActions(…).startChat(alice, g)` 返回非 null，新频道 `waker_group_id === g`。
  - `a member who is not the creator leaves the upstream way`。
  - `a hand-over and an addBots at once end consistent`：
    - 操作：`Promise.all([alice 退群, alice addBots(linus)])`；
    - 断言：`addBots` 要么成功，要么被拒（`GroupNotFoundError`，或退群落在上游 `roster` 与 `creatorOnly` 之间时的 `GroupRefusedError`）；最终群组归 bob，镜像等于 bob 帧的 `runtimeOrder(order(), bots())`。
  - `a reconcile that read the roster before the hand-over follows the new owner and logs no owner-gone`：
    - 准备：注入的 `groupStore.order()` 先等一个闸门，`reconcile` 停在闸门上；
    - 操作：alice 退群（提交），放开闸门；
    - 断言：返回 `true`；镜像正确；没有 `owner-gone`。
  - `the Task 3 window: a creator who leaves between the check and the write leaves the mirror as it was`：
    - 准备：同上的闸门，但 alice 独自一人；
    - 操作：alice 退群后放开闸门；
    - 断言：返回 `false`；镜像与之前相同（不是空的）；恰好一行 `owner-gone`。

  `describe("for-channel hand-over")`：
  - `the earliest member who opens settings takes over a group whose creator left past the service`。
  - `a later member still gets 403, and the earliest one becomes the owner`。
  - `a hand-over put off by a running flow is logged and answers 403`。
- [ ] **Step 2：运行** 服务端测试 `tests/waker-group-hand-over.integration.test.ts`，预期失败（函数不存在）。
- [ ] **Step 3：实现。** 逐行确认：
  - 0207 没有 `CREATE OR REPLACE`；
  - 除 `openbot_team_channel_hand_over` 外没有 `GRANT`；
  - 写入函数的每条 `UPDATE` 都带 `tenant_id = p_from`（`channels` 除外）；
  - `channel-link.ts` 没有新增 `asPlatform(` 或 `runAsTenant("platform"`。
- [ ] **Step 4：运行。**
  - 迁移测试库两次，第二次无报错（补做 `DO` 块幂等：已停用的人已不在群里）。
  - 跑同文件，以及：
    - `tests/waker-group-channel-link.integration.test.ts`（**断言一行不改，原样通过**，特别是 `:1169-1222`、`:1858-1896`、`:2512-2539`）；
    - `tests/group-conversations.integration.test.ts`（`:1294-1298` 原样）；
    - `tests/waker-group-channel-link-migration.integration.test.ts`、`tests/team-group-bots-migration.integration.test.ts`、`tests/team-tenant-rls.integration.test.ts`、`tests/rls-write-scope.test.ts`、`tests/tenant-invariants.test.ts`；
    - `tests/migration-journal.test.ts`、`tests/recovery-overlay-journal.test.ts`；
    - `tests/waker-groups.test.ts`、`tests/portraits.test.ts`、`tests/portrait-media.test.ts`、`tests/pipeline-*.test.ts`；
    - 写 `revoked_access` 的现有测试：`tests/device-safety.integration.test.ts`、`tests/demoted-admin-platform-writes.integration.test.ts`、`tests/people-last-sign-in.integration.test.ts`、`tests/entra-obo-servers.integration.test.ts`、`tests/enterprise-frames.integration.test.ts`；
    - 以 `ls tests | grep -i 'scim\|people\|platform'` 列出的其余测试。
  - server tsc、biome。
  - **变异验证**（每次只改一处，跑完恢复）：
    - 去掉 `u.email` 次序 → 「same moment」失败；
    - 去掉「排除已停用」→ 「deactivated is skipped」失败；
    - 去掉 core 第 2 步 → 「a member's call changes nothing」失败（这条用例同时有流程运行中，并断言群组 `updated_at` 不变：去掉第 2 步后接手人就是创建者自己，只有这两处看得出）；
    - 去掉「已软删不移交」→ 「a chat already deleted is not handed over」失败；
    - 去掉 55006 检查 → 两条「run is still going」失败；
    - 写入函数不搬 `tasks` → 「everything moves」的看板断言失败；
    - 去掉触发器 → 三条停用用例失败；
    - 停用函数不吞 55006 → 「running flow does not block a deactivation」失败；
    - `reconcile` 去掉事务内重读 → 「Task 3 window」失败；
    - `forChannel` 去掉 `handOver` → 「earliest member who opens settings」失败。
  - 推送后看 CI：`server-test` 各分片、`static`、`e2e-wakerflow`（G4）全绿。
- [ ] **Step 5：登记**测试清单，提交 `群组移交：创建者退群或被停用后群组连同流程与看板归最早的在籍成员；最后一人离开软删聊天；镜像自愈的可见性检查并入写镜像事务`。PR 说明附设计稿第 10 节 PR1 验收清单逐项勾选（含本任务）。

用户 2026-11-13 补充拍板：停用的创建者「一并移出」所有共享群（恢复后须重新邀请）；0207 上线时对已停用账号「补做」一次（离开共享群并移交）。只剩停用成员的边角情况按上文处理（退群成功、暂不移交、自愈补）。

---

## PR2：界面合一与文案

### Task 6：前端数据层

**建议执行模型**：sonnet　**评审方式**：sonnet 一轮

**文件：**
- 修改：`A/lib/waker-groups/queries.ts`、`A/lib/waker-groups/mutations.ts`、`A/lib/groups.ts`、`A/lib/channels/start.ts`
- 测试（新建）：`openbot/app/tests/waker-group-mutations.test.ts`、`openbot/app/tests/group-start-discard.test.ts`

**接口：**
```ts
// queries.ts
export type WakerGroup = { id: string; name: string; description: string | null; members: CrewMember[]; channelId: string | null; usableMemberCount?: number; chatStatus?: CrewStatus };
export type CrewStatus = "chat" | "pending_members" | "too_many" | "not_started";
/** 有 chatStatus（服务端给，Task 4）就直接用它；没有时（旧服务端、旧夹具）才退回：channelId 非空 → chat；否则 members <2 → pending_members；>20 → too_many；其余 not_started；channelId 缺省按 null。 */
export function crewStatus(group: Pick<WakerGroup, "members"> & { channelId?: string | null; chatStatus?: CrewStatus }): CrewStatus;
export const CREW_STATUS_WORDS: Record<Exclude<CrewStatus, "chat">, string>; // 「待补成员」「待调整成员（超过 20 位）」「未开始聊天」
// mutations.ts（都在 onSuccess 里 invalidate wakerGroupKeys.all 与 channelKeys.all）
export function createGroupWithChatMutationOptions(queryClient: QueryClient); // POST /api/waker-groups { name, description, agentIds } → { group, channel }
export function renameCrewMutationOptions(queryClient: QueryClient);          // PATCH /api/waker-groups/:id { name?, description? } → { group }
export function startCrewChatMutationOptions(queryClient: QueryClient);       // POST /api/waker-groups/:id/chat → { group, channel }
export function crewForChannelMutationOptions(queryClient: QueryClient);      // POST /api/waker-groups/for-channel/:channelId → { group }
export function retireCrewMutationOptions(queryClient: QueryClient);          // 已有，invalidate 增加 channelKeys.all
// lib/groups.ts：createGroupMutationOptions 的返回类型加 wakerGroupId?: string
// start.ts
export async function startGroupWith(input: {
  agentIds: string[]; text: string;
  create: (agentIds: string[]) => Promise<{ id: string; wakerGroupId?: string }>;
  send: (channelId: string, text: string) => Promise<void>;
  discard: (group: { id: string; wakerGroupId?: string }) => Promise<void>;
  open: (channelId: string) => Promise<void>;
}): Promise<void>;
```
- `useStartChannel` 的 `discard`：有 `wakerGroupId` 时 `retireCrew.mutateAsync(wakerGroupId)`；没有时照旧 `deleteChannel.mutateAsync(id)`。删掉 `A/lib/waker-groups/mutations.ts:5-11`「没有改名」的注释，改写为「改名走 PATCH，频道名是真相」。

- [ ] **Step 1：写失败测试**：
  - `waker-group-mutations.test.ts`：`crewStatus` 五种输入（`channelId:"c"`、0 位、1 位、21 位、2 位无 `channelId` 字段）分别得 `chat`、`pending_members`、`pending_members`、`too_many`、`not_started`；`crewStatus trusts the server's chatStatus`：3 位成员、`channelId: null`、`chatStatus: "pending_members"` → `pending_members`；四个新变更各自发出的 `method`、`url`、`body` 精确等于上面的值（照 `app/tests/wakers-screen.test.tsx` 的 fetch 桩）。
  - `group-start-discard.test.ts`：`a group whose first message failed is dissolved`：`create` 返回 `{ id: "c-1", wakerGroupId: "g-1" }`、`send` 抛错 → `discard` 收到 `{ id: "c-1", wakerGroupId: "g-1" }`，`open` 未调用，原错误抛出；`useStartChannel` 层面（渲染 hook）断言发出 `DELETE /api/waker-groups/g-1`；`create` 不带 `wakerGroupId` 时发出 `DELETE /api/channels/c-1`。
- [ ] **Step 2：运行** `cd openbot/app && bun test tests/waker-group-mutations.test.ts tests/group-start-discard.test.ts`，预期失败。
- [ ] **Step 3：实现。**
- [ ] **Step 4：运行** 上面两个与 `tests/start-model.test.ts`、`tests/wakers-screen.test.tsx`、`tests/wakers-parity.test.tsx`，全部通过（后两者此时断言不变）；app tsc。
- [ ] **Step 5：提交** `前端：群组类型带 channelId，新增建群组、改名、开始聊天、打开设置四个请求，首条消息失败改为解散`。

### Task 7：新建群组表单

**建议执行模型**：sonnet　**评审方式**：sonnet 一轮

**文件：**
- 新建：`A/components/wakers/create-group-form.tsx`
- 修改：`A/routes/_authed/_app/group/new.tsx`、`A/components/wakers/crews.tsx`（`:50` 的 `CreateCrewDialog` 内部改用表单）
- 修改测试：`openbot/app/tests/group-new-page.test.tsx`、`openbot/app/tests/wakers-screen.test.tsx`
- 测试（新建）：`openbot/app/tests/create-group-form.test.tsx`

**接口：**
```ts
export function CreateGroupForm(props: {
  variant: "page" | "dialog";      // 按钮：page「创建群组」，dialog「创建」
  onCreated(result: { group: WakerGroup; channel: { id: string } }): void;
  onCancel?: () => void;
}): JSX.Element;
```
- 字段：名称（占位「群组名称」，必填，默认 = 已选员工名用「、」连接，手动改过之后不再跟着变）；用途（可选，空时提交 `""`）；员工勾选（沿用 `group/new.tsx` 现有列表与「第 N 个回答」提示），2–20 位。
- 提示：「已选 N 位，至少还要 M 位」「已选 20 位，一个群组最多 20 位」；失败「群组没能建好，请再试一次。」；409 显示服务端文案。
- 一次请求 `createGroupWithChatMutationOptions`。`onCreated` 在页面上：`queryClient.setQueryData(channelKeys.detail(channel.id), channel)` 后 `navigate({ to: "/group/$channelId", params, replace: true })`；对话框里同样跳转。
- 页面标题与对话框标题都是「新建群组」；页面里「还没有员工可以拉进群聊。」改「还没有员工可以拉进群组。」。

**已批准断言（设计稿第 9 节）：**
- #19 `group-new-page.test.tsx:155` → `findByText("新建群组")`
- #20–#25 `:159`、`:176`、`:201`、`:224`、`:263`、`:293` → `getByRole("button", { name: "创建群组" })`
- #26 `:205-211`（设计稿记 `:203-209`）→ `[{ url: "/api/waker-groups", method: "POST", body: { name: "审稿、分析师", description: "", agentIds: ["checker", "analyst"] } }]`；`:212-215` 缓存断言不变
- #27、#28 `:277`、`:281` → `"已选 20 位，一个群组最多 20 位"`
- #29 `:295-297` → `"群组没能建好，请再试一次。"`
- #30 `wakers-screen.test.tsx:602` → `{ name: "值班群组", description: "", agentIds: [<夹具里勾选的两位员工 id，按勾选顺序>] }`
- 步骤与夹具（已批准）：`wakers-screen.test.tsx` 的「a new crew is created by name…」（`:565-603`）与「a name the workspace already used…」（`:605-633`）在点「创建」前勾选两位员工，夹具 `seed(...)` 提供两位员工；`group-new-page.test.tsx:183-195`、`:246-258` 的 `respond` 返回 `{ group: {…, channelId: "g-1"}, channel: {…} }`；测试标题里的「群聊」改「群组」。

- [ ] **Step 1：写失败测试** `create-group-form.test.tsx`：
  - `the page form posts name, purpose and the picked order once, then opens the chat`：勾「审稿」「分析师」→ 名称框值为「审稿、分析师」；点「创建群组」→ 唯一一条 `POST /api/waker-groups`，地址变成 `/group/<channel.id>`。
  - `a typed name is not overwritten by later picks`。
  - `fewer than two or more than twenty cannot be submitted`：1 位时按钮禁用并显示「已选 1 位，至少还要 1 位」；第 21 位勾不上。
  - `a taken name shows the server's words`：409 `{ error: "This workspace already has a group by that name." }` → `role="alert"` 文字等于它。
  - `the dialog variant says 创建 and closes on success`。
- [ ] **Step 2：** 按上面逐条改 `group-new-page.test.tsx`、`wakers-screen.test.tsx`（只改列出的行与夹具）。
- [ ] **Step 3：运行** `cd openbot/app && bun test tests/create-group-form.test.tsx tests/group-new-page.test.tsx tests/wakers-screen.test.tsx`，预期失败。
- [ ] **Step 4：实现。**
- [ ] **Step 5：运行** 同三个文件与 `tests/wakers-parity.test.tsx`（`:290`、`:312-315`、`:336-338` 不变，必须通过）、`tests/wakers-reference.test.tsx`、`tests/archive-duplicate-pages.test.tsx`；app tsc、biome。
- [ ] **Step 6：提交** `前端：新建群组统一成一张表单（页面与员工页对话框）`。

### Task 8：侧边栏合一与入口

**建议执行模型**：sonnet　**评审方式**：sonnet 一轮

**文件：**
- 修改：`A/components/app-sidebar/sidebar-roster.tsx`（`GroupList`，`:460`）、`A/components/app-sidebar/app-sidebar.tsx`（`:343-358`）、`A/skins/openmuse/menu-sheet.tsx`（`:94-99`）
- 修改测试：`openbot/app/tests/sidebar-roster.test.tsx`、`openbot/app/tests/sidebar-roster-narrow.test.tsx`、`openbot/app/tests/skins-openmuse.test.tsx`

**实现要点：**
- 一节，标题「群组」，一个 `<ul aria-label="群组">`。先 `pinnedFirst(matchingChannels(多员工频道))`；再按名字排的「我建的、`channelId` 为空」的群组（`crewStatus` 非 `chat`），链接 `/bots?tab=groups`，第二行「N 名员工 · 待补成员 / 待调整成员（超过 20 位）/ 未开始聊天」，保留 `MemberStack`。
- 已挂接且是我建的频道行（群组列表里 `channelId === channel.id`）：头像用 `usePortraitSrc("group", group.id)`，没有头像时仍是叠放员工头像。
- 工具栏只留「新建群组」→ `/group/new`；`fieldLabel`「按名字搜索群组」，`searchLabel`「搜索群组」。
- 空列表：「还没有群组。点「新建群组」，选两位以上员工开始。」；有下一页时：「已加载的会话里还没有群组。」；加载中「正在加载群组…」，失败「群组加载失败。」，搜索无果「已加载的群组里没有匹配的」。删除原「群组」节和它的空状态句。
- 分页组件 `ChannelPagination` 放在列表之后，未开聊天的群组行始终在频道行之后。
- `app-sidebar.tsx`：「新建群聊」→「新建群组」，仍指 `/group/new`，注释同步。`menu-sheet.tsx`：「新建群组」改指 `/group/new`。

**已批准断言（设计稿第 9 节）：**
- #1 `sidebar-roster.test.tsx:291` → `{ name: "新建群组" }`（`:292` href 不变）
- #2 `:406` → `findByRole("list", { name: "群组" })`
- #3 `:408` → `toEqual(["/group/c-crew", "/bots?tab=groups"])`
- #4 `:411` → 同一列表里 `getByRole("link", { name: /周报小队/ })`（`:412-418` 不变）
- #5 `:419-420` → `"/group/new"`
- #6 `:435` → `"还没有群组。点「新建群组」，选两位以上员工开始。"`
- #7 `:438` → `{ name: "新建群组" }`
- #8 `:458` → `{ name: "搜索群组" }`
- #9 `:461` → `{ name: "按名字搜索群组" }`
- #10 `:465-468` → `list "群组"` 的 href `toEqual(["/group/c-crew", "/bots?tab=groups"])`
- #11 `:469-473`（设计稿记 `:470-474`）→ 同一列表文字 `toEqual([expect.stringContaining("联合复盘"), expect.stringContaining("复盘组")])`
- #12 `:490` → `"已加载的会话里还没有群组。"`
- #13 `:493` → `{ name: "群组" }`
- #14 `:504-506` → `findByRole("list", { name: "群组" })`
- #15 `sidebar-roster-narrow.test.tsx:217` → `{ name: "群组" }`
- #16 同上 `:227` → `{ name: "新建群组" }`（`:229` 不变）
- #18 `skins-openmuse.test.tsx:768` → `[/^新建群组$/, "/group/new"]`
- 测试标题里的「群聊」（如 `sidebar-roster.test.tsx:288, 391, 428, 446, 476`）改「群组」。

- [ ] **Step 1：写失败测试**（新用例追加到 `sidebar-roster.test.tsx`）：
  - `a crew short of members reads 待补成员 and opens 员工 › 群组`：夹具群组 1 位、无 `channelId` → 行文字含「1 名员工 · 待补成员」，href `/bots?tab=groups`。
  - `a crew without a chat reads 未开始聊天, after every chat row`：2 位无 `channelId`，排在所有频道行之后；加载第二页频道后仍在最后。
  - `a linked chat I started shows the crew's portrait`：群组 `channelId: "c-crew"` 且有头像 → 该频道行里的头像 `src` 指向 `/api/portraits/group/<id>`（以 `usePortraitSrc` 的实际地址为准）。
- [ ] **Step 2：** 按上表改已有断言。
- [ ] **Step 3：运行** `cd openbot/app && bun test tests/sidebar-roster.test.tsx tests/sidebar-roster-narrow.test.tsx tests/skins-openmuse.test.tsx`，预期失败。
- [ ] **Step 4：实现。**
- [ ] **Step 5：运行** 同上与 `tests/legacy-agent-routes.test.ts`（不变）；app tsc、biome。
- [ ] **Step 6：提交** `前端：侧边栏群聊与群组并成一节，入口统一为「新建群组」`。

### Task 9：员工页群组卡片与流程页定位

**建议执行模型**：sonnet　**评审方式**：sonnet 一轮

**文件：**
- 修改：`A/components/wakers/crews.tsx`、`A/routes/_authed/_app/pipelines.tsx`
- 修改测试：`openbot/app/tests/wakers-parity.test.tsx`
- 测试（新建）：`openbot/app/tests/crew-card-states.test.tsx`、`openbot/app/tests/pipelines-group-param.test.tsx`

**实现要点：**
- 卡片按 `crewStatus`：`chat` → 「打开」（`/group/$channelId`）、「设置」（`/group/$channelId?settings=1`）；`pending_members`、`too_many` → 徽标「待补成员」/「待调整成员（超过 20 位）」；`not_started` → 「开始聊天」按钮（`startCrewChatMutationOptions`，成功后跳 `/group/$channelId`）。原有「管理成员」「更换头像」「解散」「组团流程」「在看板上看」保留。
- 「组团流程」链接 → `to="/pipelines" search={{ group: crew.id }}`，删掉 `crews.tsx:453` 附近「不带参数」的注释。
- 「解散」确认文案：「解散「X」：聊天记录不再显示；它的 N 条组团流程和运行记录会一并删除；看板上已有的任务卡保留。」，N 取 `pipelineTemplatesQueryOptions` 里 `groupId === crew.id` 的条数；409 时显示服务端文案。
- `pipelines.tsx` `validateSearch` 返回 `{ run?: string; group?: string }`；有 `group` 时初始 `selected = group`，该群组一节 `scrollIntoView` 并展开。

**已批准断言**：#31 `wakers-parity.test.tsx:704`（设计稿记 `:713`）→ `"/pipelines?group=crew-1"`。`:290`、`:312-315`、`:336-338`、`:717` 所在的页签、对话框、占位文字、`crew=` 断言不变。

- [ ] **Step 1：写失败测试**：
  - `crew-card-states.test.tsx`：`a chat crew offers 打开 and 设置`（href 精确）；`a crew short of members wears 待补成员`；`a converted crew kept as pending_members shows 待补成员, not 开始聊天`（夹具 3 位成员、`channelId: null`、`chatStatus: "pending_members"` → 有徽标「待补成员」，没有「开始聊天」按钮）；`a crew over twenty wears 待调整成员（超过 20 位）`；`a crew without a chat starts one`（点「开始聊天」→ `POST /api/waker-groups/crew-1/chat`，地址变 `/group/<返回的 channel.id>`）；`dissolving names what goes with it`（确认框文字含「它的 2 条组团流程和运行记录会一并删除」与「看板上已有的任务卡保留」）。
  - `pipelines-group-param.test.tsx`：`?group=crew-2 opens that crew's section`：该节处于展开状态；`?group=` 指向不存在的 id 时页面照常。
- [ ] **Step 2：** 改 #31。
- [ ] **Step 3：运行** `cd openbot/app && bun test tests/crew-card-states.test.tsx tests/pipelines-group-param.test.tsx tests/wakers-parity.test.tsx tests/wakers-screen.test.tsx`，预期失败。
- [ ] **Step 4：实现。**
- [ ] **Step 5：运行** 同上与 `tests/wakers-reference.test.tsx`；app tsc、biome。
- [ ] **Step 6：提交** `前端：员工页群组卡片区分可聊天、待补成员、未开始聊天，组团流程按群组定位`。

### Task 10：聊天页顶栏、设置抽屉、会话行菜单、`@群组`

**建议执行模型**：sonnet　**评审方式**：sonnet 一轮

**文件：**
- 新建：`A/components/channels/group-settings.tsx`
- 修改：`A/routes/_authed/_app/group/$channelId.tsx`、`A/components/channels/group-chat.tsx`（`:75-101`）、`A/components/app-sidebar/channel.tsx`（`:117-142` 菜单）
- 修改：`A/components/channels/group-people.tsx`（`:79` 创建者也能退出，见下）
- 修改测试：`openbot/app/tests/skin-slots.test.tsx`
- 测试（新建）：`openbot/app/tests/group-settings.test.tsx`；追加 `openbot/app/tests/group-people.test.tsx`

**接口：**
```ts
export function GroupSettingsButton(props: { channelId: string; open: boolean; onOpenChange(open: boolean): void }): JSX.Element; // 图标按钮 aria-label「群组设置」+ 右侧抽屉
export function GroupSettingsPanel(props: { channelId: string }): JSX.Element;
```
- 路由：`validateSearch` → `{ settings?: 1 }`；抽屉开关与地址参数同步（`navigate({ search, replace: true })`）。顶栏回退文案 `channel.data?.name ?? "群组"`（`:32`）。顶栏头像：已挂接且是我建的用群组头像，否则 `ChannelAvatar`。
- 面板打开时调 `crewForChannelMutationOptions`：
  - 200（创建者）：分节「名称与用途」（行内编辑 → `renameCrew`）；「员工与顺序」（上移、下移、移除、「添加员工」只列 `agentListQueryOptions` 里我能用的；少于 2 或多于 20 禁用保存并提示「一个群组要有 2 到 20 位员工。」；移除的员工负责某个模板步骤时提示「这位员工负责流程「X」的第 N 步」，不拦；保存 → `PUT …/members`，409 显示服务端文案）；「头像」`PortraitPicker kind="group" id={group.id}`；「组团流程」该群组模板列表 + 「管理流程」`/pipelines?group=<id>`；「在看板上看」`/tasks?crew=<成员 id 逗号连接>`；危险区「解散群组」（确认文案同 Task 9，成功后跳 `/`）。
  - 403（其他人）：只读「员工与顺序」（数据取 `groupQueryOptions(channelId)` 的 `bots`）+ 一句「只有发起人能调整」。
- `@群组`：选项构造不变，当前频道挂接的群组的模板排在最前（从 `wakerGroupsQueryOptions` 找 `channelId === 当前频道`）。
- 人员面板（设计稿 3.1.1 第 11 条）：`A/components/channels/group-people.tsx:79` 改为 `const removable = self || iCreated;`。创建者点「退出」先弹确认：
  - 有接手人：「退出后，这个群组和它的头像、组团流程、运行记录、看板任务卡都归「{people[1]}」。」；
  - 只剩自己：「你是最后一个人。退出后这个聊天会删除，群组留在你的「群组」里，可以重新开始聊天。」；
  - 服务端 400「有组团流程正在运行，先停下再退群。」原样显示。
- 会话行菜单：频道已挂接且是我建的 → 「解散群组…」（同一确认框与 `retireCrew`）；多员工频道且不是我建的 → 「退出群组…」（`DELETE /api/groups/:id/members/<我>`，复用 `A/lib/groups.ts` 的 `removeGroupMemberMutationOptions`）；单聊仍是「删除会话…」。

**已批准断言**：#17 `skin-slots.test.tsx:267` → `["a group conversation", "/group/g-1", "群组"]`。

- [ ] **Step 1：写失败测试** `group-settings.test.tsx`：
  - `the creator sees every section, and saving sends the new order`：`for-channel` 返回 200；上移第二位后保存 → `PUT /api/waker-groups/g-1/members` 的 `body.agentIds` 等于新顺序。
  - `fewer than two or more than twenty cannot be saved`：移到 1 位时保存禁用且显示「一个群组要有 2 到 20 位员工。」。
  - `removing a step owner warns but does not block`：显示「这位员工负责流程「周报」的第 2 步」，保存仍可点。
  - `a member sees the roster read-only`：`for-channel` 403 → 只有员工列表与「只有发起人能调整」，没有任何按钮。
  - `dissolving says what goes with it`：确认文字同 Task 9 的格式。
  - `?settings=1 opens the drawer, closing it clears the parameter`。
  - `@ lists the current crew's flows first`。
  - `a linked chat's row menu offers 解散群组 to its creator and 退出群组 to others`。
  - `group-people.test.tsx` 追加：`the creator can leave, and is told who takes the group`；`the last person is told the chat goes and the group stays`。
- [ ] **Step 2：** 改 #17。
- [ ] **Step 3：运行** `cd openbot/app && bun test tests/group-settings.test.tsx tests/skin-slots.test.tsx`，预期失败。
- [ ] **Step 4：实现。**
- [ ] **Step 5：运行** 同上与 `tests/group-chat*.test.tsx`（以 `ls tests | grep group-chat` 为准）、`tests/group-people.test.tsx`、`tests/sidebar-roster.test.tsx`；app tsc、biome。
- [ ] **Step 6：提交** `前端：群组聊天页加设置面板，创建者可改名、调员工与顺序、换头像、解散；其他人只读`。

### Task 11：文案、术语用例、文档与手动走查

**建议执行模型**：haiku　**评审方式**：无需单独评审

**文件：**
- 修改（前端，`群聊` → `群组`，值照下）：`A/components/staffing/group-proposal.tsx:63,122`（「组建群组「…」」「新群组」「调整群组「…」」「群组」）；`A/components/staffing/staffing-proposal-card.tsx:170-171,179,186-187`（「组建群组」「调整群组」「组建群组「…」」「一个新群组」「一份群组调整」）；`A/components/staffing/proposal-result.tsx:138`（「打开群组」）；`A/components/channels/group-people.tsx:70,92,99`（「群组成员」「发起了这个群组」「退出这个群组」）；`A/lib/groups.ts:54,109`（「读不到这个群组。」「群组没能建好。」）；`A/routes/_authed/_app/channel/new.tsx:219,301,400,408`（「群组没能建好。」「再加一位员工，建个群组…」「跟…建个群组」「…选两位以上就是一个群组。」）；以及 `grep -rn 群聊 openbot/app/src` 剩下的非注释行（不含 `reachability` 三个文件）。注释里的「群聊」顺手改。
- 修改（服务端）：`S/channels/group.ts:1596`「只有发起这个群组的人才能调整群里的员工。」；`S/channels/dispatch.ts:323`「多人对话里请直接在群组中 @ 员工。」；`S/staffing/executor.ts`、`S/staffing/draft.ts`、`S/staffing/routes.ts:276-277`（「组建群组」「调整群组」）、`S/plugins/catalogue.ts:1739`、`S/plugins/builtin-staffing.ts`（`:115, 210, 298, 326-335, 418-419, 494, 920-961`，`list_staff` 的「你发起的群聊：」→「你发起的群组：」）里的「群聊」全部改「群组」。
- 修改测试：`openbot/app/tests/staffing-proposal-card.test.tsx`、`openbot/server/tests/group-bots-change.integration.test.ts`、`openbot/server/tests/channel-dispatch.test.ts`、`openbot/app/tests/glossary-terms.test.ts`（只**新增**用例）
- 修改文档：`<根>/CONTEXT.md:11-12`、`docs/specs/2026-11-11-staffing-by-conversation.md`

**已批准断言（设计稿第 9 节）：**
- #32 `staffing-proposal-card.test.tsx:419` → `getByRole("link", { name: "打开群组" })`
- #33 `group-bots-change.integration.test.ts:389` → `toBe("只有发起这个群组的人才能调整群里的员工。")`
- #34 `channel-dispatch.test.ts:245` → `rejects.toThrow("群组")`
- staffing 卡片测试里服务端回显的夹具句子（如 `staffing-card-contents.test.tsx:299`）不改。

**新增用例**（`glossary-terms.test.ts`）：
```ts
const IM_CHATS = ["app/src/routes/_authed/_app/reachability.tsx", "app/src/components/reachability/"];
test("the app and the server say 群组, never 群聊 (IM chats aside)", () => {
  // 跳过注释行：去掉首空白后以 //、/*、* 开头的行
  expect(linesMatching((line) => line.includes("群聊") && !/^\s*(\/\/|\/\*|\*)/.test(line))
    .filter((where) => !IM_CHATS.some((path) => where.includes(path)))).toEqual([]);
});
```
- `CONTEXT.md`：第 11、12 行合成一行「群组」：`waker_groups` + 挂接的群聊（`channels.waker_group_id`）；界面入口侧边栏「群组」、员工页「群组」页签、「新建群组」（`/group/new`）、聊天页「群组设置」；2–20 位员工；群组**不持有权限**；「群聊」「小组」为已停用的旧称。
- staffing 规格：把「群聊」与「群组」混用处统一为「群组」，第 6 行的不一致随之消除。

- [ ] **Step 1：写失败测试**：新增上面的用例；改 #32–#34。
- [ ] **Step 2：运行** `cd openbot/app && bun test tests/glossary-terms.test.ts tests/staffing-proposal-card.test.tsx`；服务端测试 `tests/group-bots-change.integration.test.ts tests/channel-dispatch.test.ts`，预期失败。
- [ ] **Step 3：实现**文案与文档。
- [ ] **Step 4：运行** 同上，再跑全量 app 测试 `cd openbot/app && bun test`，与 `origin/main` 的失败名字多重集比较（`<根>/CONTEXT.md`「判回归的口径」），新增失败为零；表外失败按全局约束停下报批。服务端 `tests/staffing-*.test.ts`、`tests/builtin-staffing.integration.test.ts` 通过。
- [ ] **Step 5：手动走查**（skill `run` 起应用）：新建群组 → 聊天 → 设置里调顺序 → 换头像 → 建一条流程 → 看板 `crew=` → 有运行时解散被拒 → 停掉后解散；另用第二个账号进同一共享群，确认设置面板只读。结果写进 PR 说明。
- [ ] **Step 6：提交** `文案：群聊统一叫群组（含 staffing 工具描述），术语测试守住，CONTEXT 合并两行`。PR 说明列出第 9 节 34 条的落点（任务号）。

---

## PR3：升级任务（自动转换与补挂）

### Task 12：迁移 0208 台账表

**建议执行模型**：opus　**评审方式**：完整评审

**文件：**
- 新建：`openbot/server/recovery/recovery-20261018-v1/sql/0208_waker_group_upgrades.sql`
- 修改：`openbot/server/recovery/recovery-20261018-v1/meta/_journal.json`（idx 208，`when` 晚于 0207）
- 测试（新建）：`openbot/server/tests/waker-group-upgrade.integration.test.ts`（本任务建文件，Task 13–15 追加）；登记清单

**接口（SQL）：**
```sql
CREATE TABLE public.waker_group_upgrades (
  group_id uuid PRIMARY KEY REFERENCES public.waker_groups(id) ON DELETE CASCADE,
  tenant_id text NOT NULL,
  channel_id text,
  outcome text NOT NULL CONSTRAINT waker_group_upgrades_outcome
    CHECK (outcome IN ('started','converted','backfilled','pending_members','too_many','no_owner')),
  dropped_agent_ids text[] NOT NULL DEFAULT '{}',
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
```
其后 `ENABLE` + `FORCE ROW LEVEL SECURITY`、四条 `tenant_isolation*` 策略、`GRANT SELECT, INSERT, UPDATE, DELETE … TO openbot_app`，逐字照 `0203_portrait_media.sql:37-49` 换表名。文件开头角色自检。表不进 Drizzle schema，`upgrade.ts` 用 `sql` 读写。

末尾 `CREATE OR REPLACE FUNCTION public.openbot_team_channel_hand_over_write(...)`（设计稿 3.1.1 第 5 条）：在 0207 的函数体上多一句 `UPDATE waker_group_upgrades SET tenant_id = p_heir WHERE group_id = p_group_id AND tenant_id = p_from`，其余逐字不变，`REVOKE` 照旧。

- [ ] **Step 1：写失败测试**（`describe("ledger")`）：
  - `the journal registers 0208 after 0207`。
  - `a tenant reads and writes only its own ledger rows; platform reads all`：alice 帧插 `tenant_id = alice` 成功、插 `tenant_id = bob` 被拒；bob 帧读不到 alice 的行；`platform` 帧两行都读到。
  - `an unknown outcome is refused`：`outcome = 'done'` → `23514`。
  - `deleting the crew deletes its ledger row`。
  - `a hand-over moves the crew's ledger row too`。
- [ ] **Step 2：运行**，预期失败。
- [ ] **Step 3：实现。**
- [ ] **Step 4：运行** 迁移测试库（两次，第二次无报错），再跑同文件与 `tests/migration-journal.test.ts`、`tests/recovery-overlay-journal.test.ts`。
- [ ] **Step 5：登记**清单，提交 `迁移 0208：群组升级台账表`。

### Task 13：开机任务第一阶段（群组转群聊）

**建议执行模型**：opus　**评审方式**：完整评审

**文件：**
- 新建：`S/waker-groups/upgrade.ts`
- 测试：追加到 `waker-group-upgrade.integration.test.ts`（`describe("phase 1")`）

**接口：**
```ts
export type GroupUpgradeDeps = {
  database: Database;
  groups: Pick<GroupConversations, "create">;   // 未装饰的 baseGroupConversations
  link: WakerGroupLink;
  canUse(ownerUserId: string, agentId: string): Promise<boolean>; // 与 canUseBot 同一判断（S/index.ts:4206-4209）
  log?: (line: Record<string, unknown>) => void;
};
export type PhaseOneCounts = { converted: number; pending: number; tooMany: number; noOwner: number };
export async function convertGroups(deps: GroupUpgradeDeps): Promise<PhaseOneCounts>;
```
- 在 `platform` 帧枚举 `waker_groups`，逐项按设计稿 5.1 表格：
  1. `waker_flows.group_id` 指向它 → 跳过，不记台账。
  2. 有未删除频道挂着它 → 跳过。
  3. `tenant_id IN ('system','platform','team')` 或 `users` 无此 id → 台账 `no_owner`。
  4. 按 `position` 排序，筛掉 `canUse(owner, id)` 为假的员工，剩下 < 2 → `pending_members`，**不改成员数据**。
  5. 剩下 > 20 → `too_many`，不截断（用户裁定 Q3）。
  6. 2–20 → ① 台账 `started`（`platform` 帧，`started_at = now()`，被筛掉的 id 此时就写进 `dropped_agent_ids`，供孤儿匹配用）；② `runAsTenant(owner, () => groups.create(owner, { agentIds }))`；③ 台账写 `channel_id`；④ `link.adopt(groupId, channelId)`（挂接、title = 群组名、镜像）；⑤ 台账 `converted`。
- 台账已是 `pending_members`、`too_many`、`no_owner`、`converted`、`backfilled` 的跳过（终态）。台账 `started` 且 `channel_id` 为 NULL：先找孤儿（`created_by = owner`、`waker_group_id IS NULL`、`created_at >= started_at`、`deleted_at IS NULL`、`channel_agents` 集合等于该群组成员减去台账 `dropped_agent_ids`），找到就从 ③ 继续，找不到就从 ② 重建。台账 `started` 且有 `channel_id`：从 ④ 继续。
- 单项异常：记 `{"type":"waker-group-upgrade-item-failed","groupId","error"}`，继续下一项。

- [ ] **Step 1：写失败测试**（夹具：两个用户 alice、bob 和若干员工；`canUse` 用真实 `agentProfileStore.get` 判断，照 `S/index.ts:4206-4209`）：
  - `rule 1: a WakerFlow crew is left alone and not recorded`。
  - `rule 2: a crew already linked is skipped`。
  - `rule 3: a crew whose owner is gone or reserved is kept as no_owner`：`platform` 帧插 `tenant_id = 'system'` 的群组 → 台账 `no_owner`，没有新频道。
  - `rule 4: fewer than two usable coworkers keeps the crew as pending_members, members untouched`：3 位里 2 位 alice 用不了 → `pending_members`，`waker_group_members` 仍 3 行。
  - `rule 5: more than twenty is too_many and nothing is cut`：21 位 → `too_many`，成员 21 行。
  - `rule 6: two to twenty becomes a chat with the same name, order, portrait and flows`：3 位（1 位用不了）→ `converted`；新频道 `tenant_id = 'team'`、`created_by = alice`、title = 群组名、`order()` 等于 position 顺序去掉用不了的；`dropped_agent_ids` 为那 1 位；群组 id 不变，原有头像与模板仍以它为键。
  - `the single-user owner dev-local-user is converted the same way`：`users.id = 'dev-local-user'`（夹具若已存在则复用）。
  - `the second run changes nothing`：再跑 `convertGroups` → 计数全 0，频道数、群组数不变。
  - `a started orphan is adopted, not rebuilt`：手工造台账 `started`（无 `channel_id`）+ 一个符合孤儿条件的频道 → 跑后台账 `converted`、`channel_id` 为那个频道，频道总数不变。
  - `a started row with no orphan is rebuilt`。
  - `a crew whose chat cannot be made is logged and the rest go on`：让 `groups.create` 对某一项抛错 → 日志 `waker-group-upgrade-item-failed`，其余项 `converted`。
  - `a same-titled old chat is left alone`：alice 已有 title「复盘」的群聊，同名群组转换后两个频道都在，不合并。
- [ ] **Step 2：运行**，预期失败。
- [ ] **Step 3：实现。**
- [ ] **Step 4：运行** 同文件；server tsc、biome。
- [ ] **Step 5：提交** `升级：已有群组转成可聊天的群组（第一阶段，含孤儿收养）`。

### Task 14：第二、三阶段、锁、开关、装配

**建议执行模型**：opus　**评审方式**：完整评审

**文件：**
- 修改：`S/waker-groups/upgrade.ts`、`S/index.ts`（`:4216` 群聊 sweep 的 `startup.acquireSync` 之后注册）
- 测试：追加到 `waker-group-upgrade.integration.test.ts`（`describe("phases 2 and 3")`）

**接口：**
```ts
export async function backfillChannels(deps: GroupUpgradeDeps): Promise<{ backfilled: number; ownerless: number }>;
export async function reconcileLinked(deps: GroupUpgradeDeps): Promise<{ reconciled: number }>;
export type GroupUpgradeSummary = { type: "waker-group-upgrade"; converted: number; pending: number; tooMany: number; noOwner: number; backfilled: number; reconciled: number };
export const GROUP_UPGRADE_LOCK = 20261113;
export async function runGroupUpgrade(deps: GroupUpgradeDeps & { databaseUrl: string }, env?: Record<string, string | undefined>): Promise<GroupUpgradeSummary | { skipped: "off" | "locked" }>;
export function startGroupUpgrade(deps: GroupUpgradeDeps & { databaseUrl: string }): { done: Promise<unknown>; stop(): Promise<void> };
```
- 未完成转换占用的频道：`export function createConversionClaims(deps: { database: Database; link: WakerGroupLink }): ConversionClaims`（类型见 Task 4）。`claimedBy` 返回占用该频道的群组 id：台账 `started` 且 `channel_id` = 该频道；或台账 `started`、`channel_id` 为 NULL，且该频道满足 Task 13 的孤儿条件（孤儿恢复窗口）。`finish` 在所有者帧 `link.adopt` 后把台账改 `converted`、写 `channel_id`（台账 `tenant_id` = 所有者，本人帧可写）。
- 第二阶段：`platform` 帧枚举未删除、`channel_agents` ≥ 2、`waker_group_id IS NULL` 的频道；`claimedBy` 非空的**跳过**（留给下一次第一阶段续做，不补建新群组，否则原群组再也挂不上：守卫拒绝改已有挂接）；`channelOwner` 为 NULL 的计入 `ownerless` 跳过；否则 `link.linkChannel(channelId)`，台账写 `{ group_id, tenant_id: owner, channel_id, outcome: 'backfilled' }`。撞名按 `pickGroupName` 加「（2）」。
- 第三阶段：遍历所有已挂接、未删除的频道，`link.reconcile`，返回 `true` 的计数。
- 移交（设计稿 3.1.1 第 4.4 条）：第二阶段对每个候选的 `team` 频道、第三阶段对每个已挂接的 `team` 频道，在 `linkChannel` / `reconcile` 之前先 `link.handOver(channelId)`（`platform` 帧）。汇总日志加 `handedOver`。
- `runGroupUpgrade`：`env.XIONGBAO_GROUP_UPGRADE === "off"` → `{ skipped: "off" }`，不连库。否则用独立连接 `postgres(databaseUrl, { max: 1 })` 执行 `select pg_try_advisory_lock(${GROUP_UPGRADE_LOCK})`（写法照 `S/audit-retention.ts:70-76`），没抢到 → `{ skipped: "locked" }`；抢到则依次第一、二、三阶段，`finally` 里 `pg_advisory_unlock` 并关连接；结束打一行 `console.error(JSON.stringify(summary))`（`pending` = 第一阶段 `pending`）。
- `for-channel` 兜底同样不补建被占用的频道：`S/index.ts:5218` 给 `createWakerGroupActions` 补传 `conversions: createConversionClaims({ database, link: wakerGroupLink })`（Task 4 已写好分支）。
- `startGroupUpgrade`：立即返回，后台跑 `runGroupUpgrade`，异常记日志不抛；`stop()` 等它结束（阶段之间、项之间检查停止标记）。
- `S/index.ts`：`startup.acquireSync(() => startGroupUpgrade({ database, databaseUrl: config.databaseUrl, groups: baseGroupConversations, link: wakerGroupLink, canUse: <与 canUseBot 同一 lambda> }), (task) => task.stop())`。

- [ ] **Step 1：写失败测试**：
  - `phase 2 links every unlinked chat of two or more, once`：两个旧群聊（一个共享群、一个 P11 前的个人多员工频道 `tenant_id = alice`）→ 各得一个群组，台账 `backfilled`，镜像等于频道顺序；再跑 → `backfilled: 0`。
  - `phase 2 adds （2） when the name is taken`：alice 已有群组「复盘」，旧群聊 title「复盘」→ 新群组名「复盘（2）」。
  - `a conversion whose adopt failed keeps its chat out of phase 2, and the next run finishes it`：注入第一次 `adopt` 抛错 → 台账 `started` 且有 `channel_id`；跑 `backfillChannels` → `backfilled: 0`、该频道仍未挂接、群组数不变；再跑 `runGroupUpgrade`（`adopt` 正常）→ 台账 `converted`，频道挂的是原群组，群组数不变。
  - `a chat in the orphan window is not backfilled`：台账 `started`、无 `channel_id`，另有一个满足孤儿条件的频道 → `backfillChannels` 跳过它。
  - `for-channel on a chat claimed by an unfinished conversion finishes it with the original crew`：同上夹具，创建者调 `POST /api/waker-groups/for-channel/:channelId` → 返回原群组 id，台账 `converted`，没有新群组。
  - `phase 2 skips a shared chat with no creator`：`created_by` NULL → `ownerless: 1`，没有新群组。
  - `phase 3 rewrites a drifted mirror`：`platform` 帧删一位员工后 `reconcileLinked` → `reconciled: 1`，镜像对上。
  - `phase 3 hands over a group whose creator left past the service, then rewrites its mirror`。
  - `phase 3 finishes a hand-over a running flow had put off`。
  - `phase 1 runs before phase 2, so an orphan is not backfilled first`：造 `started` 台账 + 孤儿频道，`runGroupUpgrade` 后该频道挂的是原群组，没有额外群组。
  - `two runs at once: one works, the other is skipped`：`Promise.all` 两次 `runGroupUpgrade` → 恰一个返回 `{ skipped: "locked" }`，频道与群组数等于跑一次的结果。
  - `XIONGBAO_GROUP_UPGRADE=off does nothing`：返回 `{ skipped: "off" }`，台账无新行。
  - `the summary line carries all six counts`：捕获 `console.error`，JSON `type === "waker-group-upgrade"`，含 `converted`、`pending`、`tooMany`、`noOwner`、`backfilled`、`reconciled`。
- [ ] **Step 2：运行**，预期失败。
- [ ] **Step 3：实现**与装配（`S/index.ts` 只加这一处注册）。
- [ ] **Step 4：运行** 同文件、`tests/waker-group-channel-link.integration.test.ts`、`tests/group-conversations.integration.test.ts`；server tsc；推送后 CI `server-test`、`e2e-wakerflow` 全绿。
- [ ] **Step 5：提交** `升级：已有群聊补挂群组、开机巡检镜像，咨询锁与 XIONGBAO_GROUP_UPGRADE 开关`。

### Task 15：升级须知、回滚手册、开关登记、更新记录

**建议执行模型**：opus　**评审方式**：完整评审

**文件：**
- 修改：`openbot/docs/deployment-xiongbao.md`（§4 末尾加「0206、0207、0208 随镜像迁移」一句；§6 加「群组合一升级须知」与「回滚手册」）
- 修改：`openbot/.env.example`（加 `# XIONGBAO_GROUP_UPGRADE=off  # 跳过群组合一的开机转换（默认开）`，带一行中文说明）
- 修改：`openbot/CHANGELOG.md`（`## Unreleased` 下一条）
- 测试：追加到 `waker-group-upgrade.integration.test.ts`（`describe("rollback runbook")`）

**内容：**
- 升级须知照设计稿第 12 节 1–6 条，写明 Q4：转出来的空群组会出现在会话列表顶部；同名老群聊与转出来的群组同时存在，可自行解散一个；推迟转换用 `XIONGBAO_GROUP_UPGRADE=off`。
- 回滚手册：一段 ```` ```sql ```` 代码块，前后用 `<!-- group-upgrade-rollback:start -->` / `<!-- group-upgrade-rollback:end -->` 标出，开头 `SELECT set_config('app.tenant_id', 'platform', true);`，在一个事务里三步（设计稿 5.6）：
  1. 台账 `converted` 且频道没有任何 `group_messages`：`UPDATE channels SET deleted_at = now()`；按 `dropped_agent_ids` 把员工追加回 `waker_group_members`（`position` 接在现有最大值之后）。
  2. 台账 `backfilled` 且该群组没有 `group_task_templates`、没有 `portraits`（`subject_kind = 'group'`）、**也没有任何 `group_task_runs`**（`deleteTemplate` 让运行的 `template_id` 置空而保留运行，`group_task_runs.group_id` 却随群组级联删除，所以「没有模板」不等于「没用过」）：`DELETE FROM waker_groups`（外键自动解挂）。
  3. `DELETE FROM waker_group_upgrades`。
  手册写明：有消息或已被用过的不回滚；全量回退仍是恢复备份；被移交过的群组照常按这三条判断（三步都在 `platform` 帧按 `group_id`、`subject_id`、`channel_id` 判断，不看 `tenant_id`，设计稿 3.1.1 第 5 条）。
- CHANGELOG：「群组与群聊合一：侧边栏只剩「群组」，群组里可以直接聊天；升级时自动转换，见部署文档 §6」。

- [ ] **Step 1：写失败测试**：
  - `the runbook SQL undoes an untouched conversion and backfill`：读 `openbot/docs/deployment-xiongbao.md`，取两个标记之间的 SQL；造一次 `converted`（有 1 位被筛掉、无消息）、一次 `backfilled`（无模板无头像）、一次 `converted` 但有消息、一次 `backfilled` 但模板已删而运行保留（`template_id` 为 NULL 的 `group_task_runs` 一行）；在 `platform` 帧事务里执行后断言：第一个频道已软删、镜像补回那 1 位；第二个群组已删、频道 `waker_group_id` 为 NULL；有消息的那个不动；保留运行的那个群组和它的运行都还在；台账为空。事务最后回滚（照 `tests/team-group-bots-migration.integration.test.ts` 的 `Rollback` 写法）。
  - `the runbook is marked once`：两个标记各出现一次。
- [ ] **Step 2：运行**，预期失败。
- [ ] **Step 3：实现**文档、`.env.example`、CHANGELOG。
- [ ] **Step 4：运行** 同文件；`cd openbot && node scripts/ci/manual-blocks.test.mjs` 若覆盖部署文档则一并通过；推送后 CI 全绿。
- [ ] **Step 5：提交** `文档：群组合一升级须知与回滚手册，登记 XIONGBAO_GROUP_UPGRADE`。PR 说明附设计稿第 10 节 PR3 验收清单逐项勾选。

---

## 自检

**设计稿覆盖**：第 0–1 节由架构与各任务落实（D1 → 1、2；D2 → 全局约束；D3 → 1、12；D4 → 2；D5 → 3、5；D6 → 3、6；D7 → 14、4；D8 → 13；D9 → 2、3、4；D10 → 3、4、5；D11 → 9；D12 → 7；D13 → 5、9、10；D14 → 10；D15 → 11；D16 → 5A、10、12、14）；其余各节见「任务一览」后的对应表。

**接口一致性**：`WakerGroupLink`、`createWakerGroupLink`、`channelOwner`、`pickGroupName`、`channelWakerGroupId`、`channelCreatedBy`、`setChannelWakerGroup` 定义于 Task 2；`withWakerGroupLink`、`withChannelRenameLink` 定义于 Task 3；`WakerGroupLink.leave`、`handOver` 由 Task 5A 追加；`WakerGroupActions`、`createWakerGroupActions`、`WakerGroupSizeError`、`WakerGroupLinkedError`、`WakerGroupForbiddenError` 定义于 Task 4，`MemberStep`、`WakerGroupStepsError`、`WakerGroupRunningError` 与 `setMembers`、`dissolve` 由 Task 5 追加；`ListedWakerGroup`、`runtimeOrder` 定义于 Task 2；`ChatStatus`、`StatusedWakerGroup`、`list` 定义于 Task 4；`ConversionClaims` 类型定义于 Task 4，实现 `createConversionClaims` 定义于 Task 14 并在 Task 14 装配；`baseGroupConversations` 由 Task 3 引入，Task 4、14 使用；`GroupUpgradeDeps`、`convertGroups` 定义于 Task 13，`backfillChannels`、`reconcileLinked`、`runGroupUpgrade`、`startGroupUpgrade`、`GROUP_UPGRADE_LOCK` 定义于 Task 14；前端 `crewStatus`、`CREW_STATUS_WORDS` 与四个新变更定义于 Task 6，Task 7–10 使用；`CreateGroupForm` 定义于 Task 7；`GroupSettingsButton`、`GroupSettingsPanel` 定义于 Task 10。

**断言分配**：#1–#16、#18 → Task 8；#17 → Task 10；#19–#30 → Task 7；#31 → Task 9；#32–#34 → Task 11。共 34 条，无重复、无遗漏。

**与设计稿的两处细化**（写在对应任务里）：解散的「运行中」按代码实有状态取 `running`、`awaiting_action`（设计稿写的 `queued` 不存在）；成员翻译的分批写成循环，使 20 位全换时不踩 2 位下限。守卫放行 (b) 的「群组已不存在」用 SECURITY DEFINER 小函数判断，避免成员帧因 RLS 读不到而被误放行。
