# 熊宝聊天工作台 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把熊宝默认外观改成微信 / 钉钉 / 飞书式聊天工作台：四个入口（消息、通讯录、工作台、我）、拟人化员工（状态点、此刻在做什么、名片）、设置收起，旧外观保留为「经典」皮肤。

**Architecture:** 在皮肤系统里给默认皮肤 `xiongbao` 加 `Frame`（`WorkbenchFrame`），由它画图标栏 + 列表栏 + 主区 + 名片抽屉；路由页面照常渲染在主区。现外观另存为 `classic` 皮肤（无 `Frame`）。后端只加两样：`agent_profiles.department` 和一个批量「员工此刻」读取接口。

**Tech Stack:** React + TanStack Router/Query、Tailwind v4 + 主题变量、Bun 测试（happy-dom + Testing Library）；服务端 Hono + Drizzle + PostgreSQL（迁移在 `server/recovery/recovery-20261018-v1/`）。

**Spec:** `docs/specs/2026-11-14-chat-workbench.md`（用户 2026-11-14 确认）；视觉依据 `docs/specs/assets/2026-11-14-chat-workbench-mock.html`。

**基线：** 在召唤员工 PR（`feat/summon`，#607）合入 main 之后，从 main 开新分支 `feat/workbench` 实现（依赖 `employeeNumber`、人才市场、`summonKind/summoned`、`summonedFrom`）。

## Global Constraints

- 四个入口原文：「消息」「通讯录」「工作台」「我」；消息筛选「全部」「未读」「待我确认」「群聊」；状态文案「空闲」「忙碌」「已暂停」。
- 状态映射：`working`→忙碌（橙）、`resting`→空闲（绿）、`paused`→已暂停（灰）、`unknown`/`null`→不显示状态点。拿不到的数据不显示，不编造。
- 管理区仅 `role === "admin"`（沿用 `navigationFor(role, edition)`），个人版不显示。
- 旧路由一律保留可直达；每个旧导航项都有新位置（规格「旧入口 → 新位置」表）。
- 新增数据只有：`agent_profiles.department`（可选文本）与批量「员工此刻」读取。
- 用户选择的主题（`xiongbao-theme`）照旧生效，不得出现白色界面替换暗色；颜色只走主题变量。
- 其他皮肤（opendots / openduet / openmuse）行为不变；新增 `classic` 皮肤 = 现在的外观。
- 「今日」按浏览器本地时区；「今晚」= 现在到次日 06:00。
- 品牌棘轮：新增代码、文件名、标识符、文案不得出现 `openbot` / `OpenBot`；产品名走品牌出口。
- 迁移只追加（下一个编号以合入时 journal 为准）。
- 既有测试断言只在本计划写明处改动，并在 PR 里逐条列出。
- **每期（下方 P1–P5）结束：在真实系统里截图（暗色主题）交用户确认后才推送。**

## Review Focus

1. 用户选了别的皮肤或「经典」→ 外观与现在完全一致，不出现新外壳。（Task 2 用例）
2. 普通成员 → 工作台看不到「管理」区和任何管理员入口。（Task 3、Task 10 用例）
3. 员工状态拿不到（接口失败 / `unknown`）→ 不显示状态点和「此刻」，也不显示占位假文案。（Task 8 用例）
4. 直接打开旧链接（如 `/capabilities/skills`、`/settings/plans`、`/bots/:id/setup`）→ 主区正常显示，图标栏高亮正确入口。（Task 1、Task 3 用例）
5. 暗色用户刷新 → 新外壳仍是暗色；浅色同理。（Task 3 用例）

---

## P1 外壳与四个入口

### Task 1: 导航表加入口归属 `rail`

**Files:**
- Modify: `app/src/lib/navigation.ts`（`NavigationItem` 加 `rail`；新增 `railForPath`）
- Test: `app/tests/navigation-rail.test.ts`

**Interfaces:**
- Produces: `type Rail = "msg" | "contacts" | "work" | "me"`；`NavigationItem.rail: Rail`；`railForPath(pathname: string): Rail`。

- [ ] **Step 1: 写失败测试**：每个 `NAVIGATION` 项都有 `rail`；`railForPath` 对下表全对——`/`→`msg`，`/channel/x`、`/group/x`、`/channel/new`→`msg`；`/bots`、`/bots/a/setup`、`/assemble/a`→`contacts`；`/tasks`、`/autonomous`、`/reachability`、`/capabilities/skills`、`/connections`、`/browser`、`/pipelines`、`/team-bots`、`/approvals`、`/admin/audit`、`/workbench`→`work`；`/settings`、`/settings/plans`、`/me`→`me`。
- [ ] **Step 2: 运行确认失败**：`cd openbot/app && bun test tests/navigation-rail.test.ts`。
- [ ] **Step 3: 实现**：按规格「路由归属」给每项填 `rail`，`railForPath` 先查 `navigationOwns` 再按前缀表回落；未知路径 → `msg`。
- [ ] **Step 4: 运行确认通过**，并跑 `bun test tests/app-navigation.test.tsx`。
- [ ] **Step 5: 提交** `feat(app): 导航项加入口归属（聊天工作台 Task 1）`

### Task 2: 「经典」皮肤保留现外观

**Files:**
- Modify: `shared/user-preferences.ts`（`SKIN_IDS` 加 `"classic"`）、`app/src/skins/registry.ts`（`classic` 条目：无 `Frame`、`botLook: "orb"`、名称「经典」、说明「原来的侧栏外观。」）
- Test: `app/tests/skins-classic.test.tsx`

**Interfaces:**
- Produces: 皮肤 id `"classic"`。

- [ ] **Step 1: 写失败测试**：`SKINS.classic.Frame === undefined`；皮肤选择器列出「经典」；活动皮肤为 `classic` 时 `_app` 布局渲染 `AppShell`（现侧栏有 `aria-label="主导航"`）。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**；`normalizeSkinId` 接受 `classic`；`skins.test.ts` 的暗色变量约束对 `classic`（无覆盖）自然通过。
- [ ] **Step 4: 运行确认通过**，并跑 `bun test tests/skins*.test.ts*`。
- [ ] **Step 5: 提交** `feat(app): 新增「经典」皮肤保留原外观（聊天工作台 Task 2）`

### Task 3: `WorkbenchFrame` 外壳（图标栏 + 列表栏 + 主区）与主题

**Files:**
- Create: `app/src/skins/xiongbao/frame.tsx`、`app/src/skins/xiongbao/rail.tsx`、`app/src/skins/xiongbao/list-column.tsx`、`app/src/skins/xiongbao/skin.css`
- Modify: `app/src/skins/registry.ts`（`xiongbao.Frame = WorkbenchFrame`）、`app/src/skins/skins.css`（引入 `xiongbao/skin.css`）
- Test: `app/tests/workbench-frame.test.tsx`

**Interfaces:**
- Consumes: Task 1 `railForPath`、`useNavigationItems()`。
- Produces: `WorkbenchFrame({ children })`；`ListColumn({ rail }: { rail: Rail })`（本任务里 `msg`/`contacts`/`work`/`me` 先渲染现有内容：消息=现会话列表，通讯录=现侧栏员工列表，工作台=按 `rail === "work"` 的导航项列表，我=账户菜单项）；CSS 变量前缀 `--wb-*`，数值取自设计稿源文件 `:root` 与浅色块，挂在 `:root[data-skin="xiongbao"]` 与其 `.dark`。

- [ ] **Step 1: 写失败测试**：图标栏有四个按钮「消息」「通讯录」「工作台」「我」；在 `/capabilities/skills` 时「工作台」`aria-pressed="true"`；点「通讯录」进入 `/bots` 系列列表栏；普通成员的工作台列表栏不含 `admin` 项，管理员含；`<html class="dark">` 时根元素用暗色变量（读取计算后的 `--wb-bg` 与设计稿暗色值一致）；主区渲染 `children`。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**：布局 `grid-template-columns: 68px 300px minmax(0,1fr)`，高度 `h-svh`；保留 `UpdateBanner`/`SelfHostBanner` 在主区顶部；图标栏底部「我」显示用户首字；「消息」角标 = 未读会话数（复用 `isUnread`）。
- [ ] **Step 4: 运行确认通过**，并跑全量 `bun test`（现有 `app-shell-parity`、`app-sidebar-shell` 等应在 `classic` 皮肤下仍成立；若它们默认皮肤断言失效，改为显式设置 `classic` 皮肤，逐条列入 PR）。
- [ ] **Step 5: 提交** `feat(app): 聊天工作台外壳（聊天工作台 Task 3）`

### Task 4: 「消息」列表

**Files:**
- Create: `app/src/skins/xiongbao/message-list.tsx`
- Test: `app/tests/workbench-messages.test.tsx`

**Interfaces:**
- Consumes: `channelListQueryOptions()`、群组列表查询（`sidebar-roster.tsx` 的 `GroupList` 数据源）、`useWaitingByBot`、`isUnread`。
- Produces: `MessageList()`；筛选键 `type MessageFilter = "all" | "unread" | "needsMe" | "groups"`。

- [ ] **Step 1: 写失败测试**：单聊与群聊在同一列表按最后消息时间倒序；群聊显示最多 4 格成员拼图头像；「未读」只留 `isUnread`；「待我确认」只留其员工有待确认事项的一对一会话（群聊不出现）；「群聊」只留群；右上「＋」菜单有「新对话」（`/channel/new`）和「新建群组」（`/group/new`）。
- [ ] **Step 2–4：** 运行失败 → 实现 → 通过。
- [ ] **Step 5: 提交** `feat(app): 消息列表合并会话与群聊（聊天工作台 Task 4）`

### Task 5: 「我」页面

**Files:**
- Create: `app/src/routes/_authed/_app/me.tsx`、`app/src/skins/xiongbao/me-page.tsx`
- Test: `app/tests/workbench-me.test.tsx`

**Interfaces:**
- Produces: 路由 `/me`。

- [ ] **Step 1: 写失败测试**：显示名字、套餐徽标（来自现套餐查询）、「已召唤 N 位员工」（本人员工数）；菜单项与链接：个人资料→`/settings`、我的电脑→`/settings/devices`、通知→`/settings/notifications`、套餐与用量→`/settings/plans`、外观→`/settings`（含皮肤选择）、设置→`/settings`、退出登录（调用现有登出）；管理员额外显示「管理」→`/admin`，成员不显示。
- [ ] **Step 2–4：** 失败 → 实现 → 通过。
- [ ] **Step 5: 提交** `feat(app): 「我」页面（聊天工作台 Task 5）`

**P1 检查点：** 控制者在真实系统暗色截图（四个入口各一张 + 一个旧链接直达）交用户确认，确认后推送并开 PR。

---

## P2 通讯录与名片

### Task 6: 员工部门字段

**Files:**
- Create: 迁移 `server/recovery/recovery-20261018-v1/sql/<下一个编号>_agent_department.sql` 与 journal
- Modify: `server/src/db/schema/coworker.ts`（`department text`，长度 ≤ 32 的 check）、资料读写与 DTO（`department: string | null`，无值时回退到 `summoned_from` 来源预设的部门）、`server/src/tenant-package.ts`（包字段 `department:`，非字符串或超长抛错带员工 id，同步写入，缺省为 null）、召唤复制带上、员工资料编辑接口接受 `department`（仅主人）；`examples/xiongbao/agents.yaml` 与 `agents/*.yaml` 填部门（研发部 / 产品部 / 设计部 / 测试部 / 运营部 / 行政部 / 总经办）；`tools/port-capabilities/assemble-package.ts` 的保留字段加 `department`；`app/src/lib/agents/queries.ts` 加字段；员工设置页加「部门」输入
- Test: `server/tests/agent-department.integration.test.ts`、`server/tests/tenant-package.test.ts`（新增）、`app/tests/bot-setup-department.test.tsx`

- [ ] **Step 1: 写失败测试**：包同步写入部门；去掉后再同步为 null；召唤副本带部门；副本无部门时 DTO 回退来源预设部门；非主人改部门 403；`port:assemble` 重跑保留 `department`；设置页可编辑保存。
- [ ] **Step 2–4：** 失败 → 实现 → 通过（服务端用 `sum-env.sh` 同类测试库环境）。
- [ ] **Step 5: 提交** `feat: 员工部门字段（聊天工作台 Task 6）`

### Task 7: 通讯录与员工名片

**Files:**
- Create: `app/src/skins/xiongbao/contacts.tsx`、`app/src/skins/xiongbao/employee-card.tsx`
- Modify: `app/src/skins/xiongbao/list-column.tsx`（通讯录列表）、`frame.tsx`（名片抽屉挂点）
- Test: `app/tests/workbench-contacts.test.tsx`

**Interfaces:**
- Consumes: Task 6 `department`；`employeeNumber(agentId)`；`listedEmployees`/`employeeGroups`；人才市场待召唤数（`summonKind && summoned === false` 的数量）。
- Produces: `EmployeeCard({ agentId, onClose })`；`openEmployeeCard(agentId)`（frame 级 context）。

- [ ] **Step 1: 写失败测试**：列表顶部「人才市场」带「N 位待召唤」并链 `/bots`、「我的群组」；主区按部门分组（无部门→「未分组」，组内按名字），每组末尾在研发部后有「招一位新同事」卡链 `/bots`；名片显示工号 `XB-xxxx`、部门、「入职第 N 天」（按创建时间与本地今天）、性格（人设 `tone` 第一句）、模型、已装技能；按钮「发消息」（打开或建一对一会话）、「配置」（`/bots/:id/setup`）、「交给他一个任务」（`/tasks?assignee=<id>`）、「拉进群」（`/group/new?agent=<id>`）。
- [ ] **Step 2–4：** 失败 → 实现 → 通过。
- [ ] **Step 5: 提交** `feat(app): 通讯录与员工名片（聊天工作台 Task 7）`

**P2 检查点：** 截图（通讯录、名片）交用户确认后推送。

---

## P3 拟人化

### Task 8: 员工此刻（批量读取）与状态点

**Files:**
- Modify: `server/src/agents/routes.ts`（`GET /api/agents/presence?ids=a,b,c` → `{ items: { agentId: string; status: "working" | "resting" | "paused" | "unknown"; doing: string | null }[] }`，一次查询运行中任务标题与暂停状态，只返回请求人看得到的员工，`ids` 最多 100 个）
- Create: `app/src/lib/agents/presence.ts`（`usePresence(ids: string[])`，10 秒轮询，失败返回空）、`app/src/components/agents/status-dot.tsx`（`StatusDot({ status })`）
- Modify: 消息列表、通讯录卡片、对话顶栏用上状态点与「此刻」
- Test: `server/tests/agent-presence.integration.test.ts`、`app/tests/workbench-presence.test.tsx`

- [ ] **Step 1: 写失败测试**：服务端——有运行中任务→`working` + 任务标题；暂停→`paused`；都没有→`resting`；看不到的员工不返回；超过 100 个 400。前端——三种状态对应 `aria-label`「忙碌」「空闲」「已暂停」和颜色变量；`unknown` 或请求失败→无状态点、无「此刻」文字；对话顶栏显示「忙碌 · <任务标题>」。
- [ ] **Step 2–4：** 失败 → 实现 → 通过。
- [ ] **Step 5: 提交** `feat: 员工状态点与此刻在做什么（聊天工作台 Task 8）`

### Task 9: 对话样式统一

**Files:**
- Modify: 对话顶栏（`routes/_authed/_app/channel/$channelId.tsx` 的员工卡）、消息气泡、正在输入指示、任务进度卡与确认卡在 `xiongbao` 皮肤下的样式（只改 `skin.css` 与少量 class，不改行为）
- Test: `app/tests/workbench-chat-style.test.tsx`

- [ ] **Step 1: 写失败测试**：在 `xiongbao` 皮肤下自己的气泡带 `data-mine` 并使用 `--wb-me` 渐变变量；正在输入时显示「<员工名> 正在输入」；顶栏有「名片」按钮打开 Task 7 名片；`classic` 皮肤下这些 class 不出现。
- [ ] **Step 2–4：** 失败 → 实现 → 通过。
- [ ] **Step 5: 提交** `feat(app): 聊天工作台对话样式（聊天工作台 Task 9）`

**P3 检查点：** 截图（对话、列表状态）交用户确认后推送。

---

## P4 工作台首页

### Task 10: 工作台首页 `/workbench`

**Files:**
- Create: `app/src/routes/_authed/_app/workbench.tsx`、`app/src/skins/xiongbao/workbench-home.tsx`、`app/src/lib/workbench/today.ts`
- Test: `app/tests/workbench-home.test.tsx`、`app/tests/workbench-today.test.ts`

**Interfaces:**
- Produces: `todayStats(input: { tasks: Task[]; waiting: number; autonomous: UnifiedItem[]; employees: number; now: Date }): { onDuty: number; doneToday: number; waitingOnYou: number; tonight: number }`；`todayFeed(tasks, now)`。

- [ ] **Step 1: 写失败测试**：`today.ts`——本地时区今天 0 点后完成的任务计入 `doneToday`（用状态为完成且更新时间在今天）；`nextRunAt` 在现在到次日 06:00 之间计入 `tonight`；跨零点边界各一例。页面——问候按本地时间「早上好 / 下午好 / 晚上好，<名字>」；四个数字；今日动态按时间倒序最多 10 条；应用格子「任务看板」「自主工作」「Waker」「人才市场」「能力」「连接」「教员工做事」（仅当可用）「组团流程」「团队 Bot」「审批」；「管理」区（模型与套餐、审计记录、平台设置）仅管理员可见；不出现「整理今日日报」。
- [ ] **Step 2–4：** 失败 → 实现 → 通过。图标栏「工作台」默认落到 `/workbench`。
- [ ] **Step 5: 提交** `feat(app): 工作台首页（聊天工作台 Task 10）`

**P4 检查点：** 截图交用户确认后推送。

---

## P5 手机布局与打磨

### Task 11: 手机布局

**Files:**
- Modify: `app/src/skins/xiongbao/frame.tsx`、`rail.tsx`、`list-column.tsx`
- Test: `app/tests/workbench-mobile.test.tsx`

- [ ] **Step 1: 写失败测试**（`matchMedia(max-width: 767px)` 为真）：图标栏变为底部标签栏；在 `/channel/x` 时只显示对话、隐藏标签栏、顶部有「返回」回到消息列表；在入口根路径（如 `/workbench`）显示列表/页面与标签栏；名片以全屏页显示。
- [ ] **Step 2–4：** 失败 → 实现 → 通过。
- [ ] **Step 5: 提交** `feat(app): 聊天工作台手机布局（聊天工作台 Task 11）`

**P5 检查点：** 桌面 + 手机宽度截图交用户确认；随后整体终审，再推送合入。
