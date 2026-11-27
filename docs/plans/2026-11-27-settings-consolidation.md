# 设置整理与首次交办体验 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把散在设置、管理后台、企业管控、能力、连接里的设置收成七个话题页（一个设置一个控制、一个名字），旧地址全部接住；并在话题页和发送区说清「这位员工现在能不能干、卡在哪、找谁」，缩短第一次交办的路。

**Architecture:** 前端先立三块骨架：受众判断（`lib/settings/audience.ts`）、旧地址表（`lib/settings/moves.ts`，所有重定向和测试都读它）、带 `data-setting-key` 的节组件和「只渲染一处」测试；然后按设计稿第九节逐 PR 把页面 `git mv` 到 `/settings/*` 下，旧路由改成读旧地址表的重定向。服务器只有三处窄例外（设计稿第十四节）：只读 `GET /api/agents/:agentId/readiness`（复用 `governRun` 的同一判定）、模型最近一次测试结果落库、员工画的 `askApproval` 卡不再计入审批数。

**Tech Stack:** React 19 + TanStack Router（文件路由）+ TanStack Query、Bun 测试（happy-dom + Testing Library）、Hono + Drizzle（服务器）、Playwright（`app/tests/parity/capture.ts` 截图）。

**Spec:** `docs/specs/2026-11-27-settings-consolidation-design.md`（用户 2026-11-27 批准，「设计稿没问题」）。第十四节用户答复、第十五、十六节控制方判断与正文冲突处以它们为准。下文「§」指该设计稿的节，「A04」「U51」「X12」等指设计稿表格里的行号；执行者必须同时打开设计稿。

下文路径：`app/src/...`、`server/...`、`shared/...` 都相对 `xiongbao/`；`docs/...` 相对仓库根。

## Global Constraints

- 开工时间：v0.2.17 发版之后。每个 PR 从最新的 `origin/main` 开分支（`git fetch origin && git switch -c <分支> origin/main`），分支名 `feat/settings-pr<N>-<短名>`。
- 所有面向用户的文字用中文；文案照 `xiongbao/.claude/skills/xiongbao-copy` 和 `CONTEXT.md`（界面叫「员工」；管理员页以外不出现凭据、令牌、部署、OAuth、Composio）。
- 布局照 `xiongbao/.claude/skills/xiongbao-screen-layout`：`PageShell` → `PageSection` → `PageRows` → `Item size="sm"`；开关行即时生效；多值行「摘要 + 箭头」开对话框；从列表进的详情页用 `backButton`；一页一种 `Item variant`；宽度只用默认 prose（审计记录表格是唯一 wide）。
- `server/src`、`app/src` 里不写品牌名字面量，一律用品牌导出（前端 `app/src/lib/brand.ts` 的 `productName()` 等，服务器 `server/src/brand.ts`）。
- 格式化只对改动的文件：`bunx biome check --write <改动的文件…>`，从不对目录跑。
- 每个 PR 推送前，在 `xiongbao/` 下全部通过：`bunx biome lint --error-on-warnings --diagnostic-level=warn .`、`bun run typecheck`、`bun run typecheck:tests`。
- 新增 server 或 app 的测试文件后，在 `xiongbao/` 下跑 `bun run test:shards`，把生成的分片清单一起提交。
- 提交信息用中文，结尾两行固定：
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01MJUqVcFToyopKbNJ4sEoWY
  ```
- 每个动界面的 PR：推送前交截图（`deviceScaleFactor` 2，桌面 1440×900 + 手机 390×844，见 §10.7 的截图集），用户确认后才推送。
- 不改任何设置的含义或默认值；不删数据；服务器把关（`server/src/admin/gate.ts` `GATED_ROUTES`）不改。
- 读不到版本时按团队版（今天的回退，`lib/edition-guard.ts` `editionOf`）。
- 3.2 表里的外部地址（`/plans`、`/connections*`、`/admin/plugins/$key`、`/settings/connected-accounts*`、`/approvals?id=`、动作推演五个 `/admin/*`、部署清单四个地址）永远接得住，查询参数不丢。
- 服务器英文文案、服务器发来的地址不改（三处例外和 §12 的四句旧位置字符串除外）。
- 迁移写在基线之后：`server/drizzle/000N_<名字>.sql`，`meta/_journal.json` 追加一条，`when` 大于前一条，头注释带 `回滚：` 块（R4 Task 26 定的约定，见 `xiongbao/docs/development.md`「Migrations」）。不改 `0000_baseline.sql` 和 `meta/0000_baseline_structure.json`。

## Review Focus

1. 成员（非管理员）打开指向团队锚点的旧地址（如 `/admin/approvals` → `/settings/approvals#team-approvals`）：落在话题页顶部，不报错、不空白、不滚到不存在的节。测试在 Task 2。
2. 授权回跳带着表外的未知参数，或应用 key 含编码字符（`%2F`、中文）：参数全部原样带上，key 只解码一次、不被二次编码。测试在 Task 22。
3. 管理员在会话中途被降级、或版本接口读失败：受众受限的节在重新读取后消失、读取失败按团队版，期间不闪出管理员节。测试在 Task 1。
4. 员工绑定的模型库条目被停用或其密钥被吊销：运行回落到部署默认模型，readiness 必须报回落后的模型和来源「部署默认模型」，不能报「可以派活 · 原模型」。测试在 Task 17。
5. 合法的业务确认卡（「给这笔订单退款吗」）在别的对话里有待处理系统审批时照常画出；同一条助手消息里另一个工具调用正在等系统审批时不画。测试在 Task 14。

---

## 文件结构（新增与搬动的主干）

| 文件 | 职责 | 产生于 |
|---|---|---|
| `app/src/lib/settings/audience.ts` | 受众：版本、管理员、能否打开部署设置、是否读完；节的显示规则；子页守卫 | Task 1 |
| `app/src/lib/settings/moves.ts` | `SETTINGS_MOVES` 旧地址表与解析、重定向 `beforeLoad`、服务器旧地址换新 | Task 2 |
| `app/src/routes/_authed/admin/$.tsx`、`app/src/routes/_authed/settings/$.tsx` | 按前缀的兜底重定向路由（读 `SETTINGS_MOVES`） | Task 2 |
| `app/src/components/settings/settings-section.tsx` | `SettingsSection`：带受众、锚点、团队节固定首句 | Task 3 |
| `app/src/lib/settings/setting-keys.ts` | `SETTING_KEYS`：全部可写控制的键（与 §5.4「留下」列一致） | Task 3，后续逐 PR 增补 |
| `app/tests/settings-audience-kit.tsx` | 测试夹具：五种受众、按 parity 夹具应答、渲染真实路由树 | Task 3 |
| `app/src/components/settings/team/*.tsx` | 从 `routes/_authed/admin/enterprise.tsx` 抽出的各节 | Task 6、10、21、27 |
| `app/src/lib/settings/status-words.ts` | 有效状态的原因词与下一步（模型、应用共用；发送区也读） | Task 18 |
| `server/src/agents/readiness.ts` | readiness 判定与只读路由 | Task 17 |
| `server/drizzle/<000N>_model_last_test.sql` | 模型最近一次测试结果的四列 | Task 16 |

新话题页与子页的路由文件（每个 Task 的 Files 再列一次）：

```
routes/_authed/settings/index.tsx                  账户与外观（已有）
routes/_authed/settings/models/index.tsx           员工与模型
routes/_authed/settings/models/components/index.tsx, $name.tsx, models/playground.tsx
routes/_authed/settings/approvals/index.tsx        审批与安全（由 approvals.tsx git mv）
routes/_authed/settings/approvals/{audit,guidance,describe,what-if}.tsx
routes/_authed/settings/approvals/boundaries/{index,new,$index}.tsx
routes/_authed/settings/connections/index.tsx      连接与技能
routes/_authed/settings/connections/apps/{index,$key,$key_.tools.$tool,$key_.bots.$agentId,browse.composio,browse.arcade}.tsx
routes/_authed/settings/connections/skills/{index,new,$slug}.tsx
routes/_authed/settings/connections/{logins}.tsx, connections/keys/{index,new}.tsx
routes/_authed/settings/devices.tsx                电脑与设备（已有）
routes/_authed/settings/notifications.tsx          主动与通知（已有）
routes/_authed/settings/team/{index,people,platform,permissions.describe}.tsx  团队管理
```

注意：`settings/approvals.tsx` 有了 `approvals/` 子路由后会变成布局路由，所以必须 `git mv` 成 `approvals/index.tsx`；`$key` 的子页用 `$key_.` 前缀免得嵌套（沿用今天 `connections.$key_.tools.$tool.tsx` 的写法）。

---

# PR 1 骨架 + 账户与外观 + 电脑与设备

分支 `feat/settings-pr1-skeleton`。依赖：无。

### Task 1: 受众判断 `audience.ts`

**Files:**
- Create: `app/src/lib/settings/audience.ts`
- Test: `app/tests/settings-audience.test.ts`

**Interfaces:**
- Consumes: `deploymentCapabilitiesQueryOptions()`（`lib/deployment/queries.ts`）、`currentUserQueryOptions()`（`lib/auth/queries.ts`）、`mayOpenSetup`（`lib/setup/queries.ts`）、`editionOf`（`lib/edition-guard.ts`）。
- Produces:
  ```ts
  export type SettingsAudience = {
    edition: "team" | "personal";
    isAdmin: boolean;
    maySetUp: boolean;
    /** 用户与版本两个读取都已结束（成功或失败）。之前受众受限的节一律不画。 */
    ready: boolean;
  };
  export type SectionAudience = {
    who: "everyone" | "team-admin";
    edition: "both" | "team" | "personal";
  };
  export function audienceOf(
    user: { role?: string } | null | undefined,
    capabilities: { edition?: string; localEvaluation?: boolean } | undefined,
    settled: { user: boolean; capabilities: boolean },
  ): SettingsAudience;
  export function useSettingsAudience(): SettingsAudience;
  /** 受众受限的节在 ready 之前返回 false；who/edition 都满足才 true。team-admin 隐含 edition team。 */
  export function shows(section: SectionAudience, audience: SettingsAudience): boolean;
  /** 子页守卫：rule 不满足时送回 fallback；team-admin 的页在个人版一律送回 "/settings"。读不到版本按团队版。 */
  export function guardSubpage(
    rule: "team-admin" | "personal",
    fallback: string,
  ): (opts: { context: { queryClient: QueryClient } }) => Promise<void>;
  ```

- [ ] **Step 1: 写失败的测试**

```ts
test("读不到版本按团队版，管理员看得到团队节", () => {
  const a = audienceOf({ role: "admin" }, undefined, { user: true, capabilities: true });
  expect(a).toEqual({ edition: "team", isAdmin: true, maySetUp: true, ready: true });
  expect(shows({ who: "team-admin", edition: "team" }, a)).toBe(true);
});
test("ready 之前受众受限的节不画，所有人的节照画", () => {
  const a = audienceOf({ role: "admin" }, { edition: "team" }, { user: true, capabilities: false });
  expect(a.ready).toBe(false);
  expect(shows({ who: "team-admin", edition: "team" }, a)).toBe(false);
  expect(shows({ who: "everyone", edition: "personal" }, a)).toBe(false);
  expect(shows({ who: "everyone", edition: "both" }, a)).toBe(true);
});
test("个人版没有团队节；团队版成员没有管理员节也没有个人版节", () => {
  const personal = audienceOf({ role: "admin" }, { edition: "personal" }, { user: true, capabilities: true });
  expect(shows({ who: "team-admin", edition: "team" }, personal)).toBe(false);
  expect(shows({ who: "everyone", edition: "personal" }, personal)).toBe(true);
  const member = audienceOf({ role: "user" }, { edition: "team", localEvaluation: true }, { user: true, capabilities: true });
  expect(member.maySetUp).toBe(true);
  expect(shows({ who: "team-admin", edition: "team" }, member)).toBe(false);
  expect(shows({ who: "everyone", edition: "personal" }, member)).toBe(false);
});
test("管理员被降级后重新读取，团队节随之消失", () => {
  const before = audienceOf({ role: "admin" }, { edition: "team" }, { user: true, capabilities: true });
  const after = audienceOf({ role: "user" }, { edition: "team" }, { user: true, capabilities: true });
  expect(shows({ who: "team-admin", edition: "team" }, before)).toBe(true);
  expect(shows({ who: "team-admin", edition: "team" }, after)).toBe(false);
});
test("guardSubpage：成员打开团队管理员子页被送回所在话题页，个人版送回 /settings", async () => {
  // 用 QueryClient 预置 currentUser / capabilities，断言抛出的 redirect 的 to
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd xiongbao/app && bun test tests/settings-audience.test.ts`
Expected: FAIL，`Cannot find module '@/lib/settings/audience'`

- [ ] **Step 3: 实现 `app/src/lib/settings/audience.ts`**

`useSettingsAudience` 用两个 `useQuery` 的 `isFetched || isError` 算 `settled`；`maySetUp` 直接调 `mayOpenSetup`；`guardSubpage` 读用户和 `editionOf(queryClient)`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd xiongbao/app && bun test tests/settings-audience.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add app/src/lib/settings/audience.ts app/tests/settings-audience.test.ts
git commit -m "设置整理：集中受众判断（版本、管理员、部署设置、读完之前不画）"
```

### Task 2: 旧地址表 `moves.ts` 与重定向框架

**Files:**
- Create: `app/src/lib/settings/moves.ts`
- Create: `app/src/routes/_authed/admin/$.tsx`、`app/src/routes/_authed/settings/$.tsx`（兜底：`beforeLoad: redirectIfMoved`，未命中 `throw notFound()`）
- Modify: `app/src/routes/_authed/admin/route.tsx`（`beforeLoad` 第一步先 `redirectIfMoved`，命中就走，不再看版本和角色；未命中保留今天的 `personalAdminRedirect` 与非管理员送回 `/`，到 Task 28 再删）
- Modify: `app/src/components/what-if/what-if-result.tsx`（`PAGE_WORDS` 的 key 不变，`Link` 改用 `movedHref(layer.page)` 的结果）、`app/src/components/setup/setup-checklist.tsx:264`（`href={movedHref(target.path)}`）
- Modify: `app/src/routes/_authed/_app/plans.tsx`（改读 `redirectIfMoved`，U01）
- Test: `app/tests/settings-moves.test.tsx`、`app/tests/settings-moves-links.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type SettingsMove = {
    /** §7 的行号，如 "U51" */
    id: string;
    /** 旧地址模式：`$name` 匹配一段；结尾 `/$` 匹配余下全部（可为空） */
    from: string;
    /** 新地址模式，引用 from 里同名参数；`$` 引用余下部分 */
    to: string;
    hash?: string;
    /** "all" 原样带全部查询参数；数组只带这些；省略不带 */
    search?: "all" | readonly string[];
    /** 只在满足时转（U41：带 focus） */
    only?: (search: Record<string, unknown>) => boolean;
    /** §3.2 外部依赖的地址 */
    kept?: true;
  };
  /** 先写的先匹配：具体地址必须排在同前缀的参数地址前面（U14/U15 在 U10 前，`/settings/plugins/composio` 在 `/settings/plugins/$` 前） */
  export const SETTINGS_MOVES: readonly SettingsMove[];
  /** 命中返回完整 href（路径 + ?查询 + #锚点），未命中 null。参数值解码一次再编码一次。 */
  export function resolveMove(pathname: string, search: Record<string, unknown>): string | null;
  /** 服务器发来的旧地址换成新地址；没有对应就原样返回 */
  export function movedHref(href: string): string;
  /** 路由 beforeLoad 用：命中时 throw redirect({ href, replace: true }) */
  export function redirectIfMoved(opts: {
    location: { pathname: string; search: Record<string, unknown> };
  }): void;
  ```
- 这个 Task 只放本 PR 落地的行：U01、U51、U52。后续每个 PR 往表里加自己那批行，并给本测试文件加对应用例；加行的 Task 在其 Files 里写明行号。
- 锚点滚动：新增 `app/src/lib/settings/use-anchor-scroll.ts`，`useAnchorScroll(ready: boolean): void`，话题页在内容渲染完（`ready`）后按 `location.hash` 找 `id`，找不到就什么也不做（Review Focus 1）。

- [ ] **Step 1: 写失败的测试**

`settings-moves.test.tsx` 照 `app/tests/archive-duplicate-pages.test.tsx` 的写法，经真实导出的路由（`routeTree.gen` 建内存路由）走一遍：

```ts
for (const move of SETTINGS_MOVES) {
  test(`${move.id} ${move.from} 落到 ${move.to}${move.hash ? `#${move.hash}` : ""}`, async () => {
    const { finalHref } = await renderAt(sample(move), "team-admin");
    expect(finalHref()).toBe(expected(move));
  });
}
test("表里具体地址排在同前缀参数地址前面", () => {
  // 对每一对 (i<j)：若 j 的 from 是具体地址且被 i 的参数模式匹配，则失败
});
test("U52 /settings/computer 去 /settings/devices#this-computer（部署清单链接）", async () => { ... });
test("U51 /admin/computers 对成员也先转走，由目标页决定画什么", async () => {
  const { finalHref, container } = await renderAt("/admin/computers", "team-member");
  expect(finalHref()).toBe("/settings/devices#team-computers");
  expect(container.querySelector("#team-computers")).toBeNull(); // 落在页顶，不报错
  expect(container.textContent).toContain("电脑与设备");
});
test("U01 /plans 仍去 /settings/plans", async () => { ... });
test("movedHref 换服务器发来的旧地址，保留查询和锚点；未知地址原样返回", () => {
  expect(movedHref("/admin/computers")).toBe("/settings/devices#team-computers");
  expect(movedHref("/settings/notifications")).toBe("/settings/notifications");
});
```

`settings-moves-links.test.ts`（静态扫描，§10.1 第三条）：

```ts
test("app/src 里没有链接指向 SETTINGS_MOVES 的旧地址", () => {
  // 扫 app/src 下 .ts/.tsx 的 to="..."、to: "..."、linkOptions({ to: "..." })、href="/..."
  // 去掉 moves.ts 自身和 routes/ 下旧地址的重定向文件；命中任何一条 move.from 的模式即记一处
  expect(offenders).toEqual([]);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd xiongbao/app && bun test tests/settings-moves.test.tsx tests/settings-moves-links.test.ts`
Expected: FAIL，找不到 `@/lib/settings/moves`

- [ ] **Step 3: 实现 `moves.ts`、两个兜底路由、`admin/route.tsx` 前置判断、两处 `movedHref`、`useAnchorScroll`**

TanStack splat 的写法、`/admin` 本身能否被 `admin/$.tsx` 接住由实施者核对（§12）；测试必须含 `/admin/computers` 和后续 PR 的 `/admin` 用例。改完跑一次 `bun run generate:app-config` 之后 vite 会重新生成 `routeTree.gen.ts`，一起提交。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd xiongbao/app && bun test tests/settings-moves.test.tsx tests/settings-moves-links.test.ts tests/what-if.test.tsx tests/setup-checklist.test.tsx`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add app/src/lib/settings/moves.ts app/src/lib/settings/use-anchor-scroll.ts app/src/routes/_authed/admin/\$.tsx app/src/routes/_authed/settings/\$.tsx app/src/routes/_authed/admin/route.tsx app/src/routes/_authed/_app/plans.tsx app/src/components/what-if/what-if-result.tsx app/src/components/setup/setup-checklist.tsx app/src/routeTree.gen.ts app/tests/settings-moves.test.tsx app/tests/settings-moves-links.test.ts
git commit -m "设置整理：旧地址集中成一张表，重定向和服务器发来的旧地址都读它"
```

### Task 3: 节组件、设置键清单与测试夹具（「只渲染一处」框架）

**Files:**
- Create: `app/src/components/settings/settings-section.tsx`
- Create: `app/src/lib/settings/setting-keys.ts`
- Create: `app/tests/settings-audience-kit.tsx`
- Test: `app/tests/settings-render-once.test.tsx`、`app/tests/settings-single-writer.test.ts`、`app/tests/settings-names.test.ts`、`app/tests/settings-gating.test.tsx`

**Interfaces:**
- Consumes: Task 1 的 `SectionAudience`、`useSettingsAudience`、`shows`。
- Produces:
  ```tsx
  /** 受众不满足时返回 null。who 为 team-admin 时 description 前面固定加「只有管理员看得到。改动对所有成员生效。」 */
  export function SettingsSection(props: {
    id: string;              // 锚点，如 "team-approvals"
    title: string;
    description?: React.ReactNode;
    audience?: SectionAudience; // 省略 = { who: "everyone", edition: "both" }
    children: React.ReactNode;
  }): React.ReactElement | null;
  ```
  ```ts
  /** 每个键恰好对应一个可写控制；控制上写 data-setting-key={key}。只读行不带。 */
  export const SETTING_KEYS: readonly string[];
  ```
  ```ts
  // app/tests/settings-audience-kit.tsx
  export type AudienceName =
    | "team-admin" | "team-member" | "team-member-local" | "personal" | "unknown-edition";
  export const AUDIENCES: readonly AudienceName[];
  /** fetch 桩：其余请求交给 parity 的 resolveFixture；/api/me 的 role、能力接口的 edition 与 localEvaluation 按受众改写；unknown-edition = 管理员 + 能力接口 500 */
  export function stubFetchFor(audience: AudienceName): void;
  export function renderAt(href: string, audience: AudienceName): Promise<{
    container: HTMLElement;
    finalHref: () => string;
  }>;
  export function settingKeysIn(container: Element): string[];
  ```
- 本 PR 的 `SETTING_KEYS`：`account.name`、`account.instructions`、`appearance.theme`、`appearance.skin`、`appearance.messageList`、`devices.pair`、`enterprise.network`、`enterprise.inactiveComputerDays`。键名规则：写哪份数据就叫什么（审批偏好 `approvals.*`、团队审批 `approvals.team.*`、能力开关 `capability.<id>`、企业设置 `enterprise.<EnterpriseSettings 的键>`）。

- [ ] **Step 1: 写失败的测试**

```ts
// settings-render-once.test.tsx
const PAGES = ["/settings", "/settings/devices"]; // 后续 PR 往这里加自己的话题页和子页
for (const audience of AUDIENCES) {
  test(`${audience}：每个设置键在全部话题页里恰好出现一次`, async () => {
    const seen: string[] = [];
    for (const page of PAGES) seen.push(...settingKeysIn((await renderAt(page, audience)).container));
    const visible = SETTING_KEYS.filter((key) => keyVisibleFor(key, audience));
    expect(seen.sort()).toEqual([...visible].sort());
  });
}
// settings-single-writer.test.ts
test("写设置的 mutation 只被一个组件文件引用", () => {
  // 对 setApprovalPreferences、setApprovalEnabled、teamApprovalSettingsMutationOptions、
  // setCapabilityMutationOptions、setEnterpriseSettingMutationOptions（按 key 字面量分）
  // 统计 app/src/components 与 app/src/routes 下引用它们的文件；每个（mutation, key）≤ 1 个文件
});
// settings-names.test.ts
const RETIRED: readonly string[] = ["偏好设置", "我的设备", "我的电脑"]; // 后续 PR 追加 §5.8 左列
test("§5.8 左列的旧名不再出现在 app/src 的界面字符串里（注释除外）", () => { ... });
// settings-gating.test.tsx（§10.2 的骨架，本 PR 只断言两页）
test("个人版的电脑与设备有「你的员工的浏览器」，没有「团队的电脑」", async () => { ... });
test("ready 之前不出现「团队的电脑」", async () => { ... });
```

`keyVisibleFor(key, audience)` 写在夹具里：按键前缀查一张受众表（`enterprise.*`、`capability.*`、`approvals.team.*` 只有团队版管理员），后续 PR 增补。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd xiongbao/app && bun test tests/settings-render-once.test.tsx tests/settings-single-writer.test.ts tests/settings-names.test.ts tests/settings-gating.test.tsx`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `SettingsSection`、`SETTING_KEYS`、夹具**

`SettingsSection` 包今天的 `PageSection`，`id` 落到外层元素上供锚点。

- [ ] **Step 4: 跑测试确认通过**

这一步只有 `/settings`、`/settings/devices` 两页，它们在 Task 5、6 才带键；本 Task 先把 `PAGES` 设为 `[]`，`SETTING_KEYS` 设为 `[]`，确认框架能跑。
Run: 同 Step 2
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add app/src/components/settings/settings-section.tsx app/src/lib/settings/setting-keys.ts app/tests/settings-audience-kit.tsx app/tests/settings-render-once.test.tsx app/tests/settings-single-writer.test.ts app/tests/settings-names.test.ts app/tests/settings-gating.test.tsx
git commit -m "设置整理：节组件、设置键清单和「每个设置只渲染一处」的测试框架"
```

### Task 4: 设置侧栏重写（七个话题 + `owns`）

**Files:**
- Modify: `app/src/components/settings/settings-sidebar.tsx`（重写）
- Test: `app/tests/settings-sidebar.test.ts`（重写）

**Interfaces:**
- Consumes: Task 1 `useSettingsAudience`。
- Produces:
  ```ts
  export type SettingsTopic = {
    id: "account" | "models" | "approvals" | "connections" | "devices" | "notifications" | "team";
    title: string;
    icon: React.ComponentType<{ className?: string }>;
    linkOptions: LinkOptions;
    /** 除自己地址外还归它亮的地址前缀（同 NAVIGATION.owns）；account 的 "/settings" 精确匹配 */
    owns?: readonly string[];
    audience?: SectionAudience;
    /** 部署设置待办数挂在这一项上 */
    setupBadge?: boolean;
  };
  export function settingsTopics(audience: SettingsAudience): SettingsTopic[];
  /** 打开 pathname 时亮哪一项 */
  export function activeTopic(topics: SettingsTopic[], pathname: string): SettingsTopic["id"] | null;
  ```
- 标题与地址按 §5.2 侧栏图。`owns`：account 认领 `/settings/plans`、`/settings/about`，个人版和 `maySetUp` 的非管理员还认领 `/settings/setup`；团队版管理员的 `/settings/setup` 归 team。待办数：团队版管理员挂 team，其余 `maySetUp` 的人挂 account。
- 过渡（§9「未完成的话题暂时仍指旧页」）：models 暂指 `/capabilities/models`，approvals 指 `/settings/approvals`，connections 暂指 `/connections`，team 暂指 `/admin`。旧侧栏里还没搬走的项留在侧栏末尾一个「过渡」分组 `LEGACY_TAIL`：学习、密码 / 已保存的登录、组件展示，个人版另有密钥、技能、活动；每个 PR 搬走一项就删一项（Task 11 删活动、Task 20 删组件展示、Task 24 删技能、Task 25 删其余）。套餐与用量、关于、部署设置、电脑本 PR 就离开侧栏（A39、A42、A45、A48）。

- [ ] **Step 1: 写失败的测试**

```ts
test("团队版管理员依次是 账户与外观、员工与模型、审批与安全、连接与技能、电脑与设备、主动与通知、团队管理", () => {
  expect(settingsTopics(admin).map((t) => t.title)).toEqual([
    "账户与外观", "员工与模型", "审批与安全", "连接与技能", "电脑与设备", "主动与通知", "团队管理",
  ]);
});
test("成员和个人版没有团队管理", () => { ... });
test("/settings/plans、/settings/about 亮账户与外观；/settings 只在精确匹配时亮", () => {
  expect(activeTopic(settingsTopics(admin), "/settings/plans")).toBe("account");
  expect(activeTopic(settingsTopics(admin), "/settings/devices")).toBe("devices");
});
test("团队版管理员的 /settings/setup 亮团队管理，成员（localEvaluation）的亮账户与外观", () => { ... });
test("待办数：团队版管理员挂团队管理，个人版挂账户与外观", () => { ... });
test("套餐与用量、关于、部署设置、电脑不再是侧栏项", () => { ... });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd xiongbao/app && bun test tests/settings-sidebar.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**；删 `PERSONAL_SETTINGS_SIDEBAR_ITEMS`、`settingsSidebarItems`（§8 片段删除），`SettingsNav` 改读 `settingsTopics` + `activeTopic` 自己算 `data-status`，不再靠 `Link` 的前缀匹配。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd xiongbao/app && bun test tests/settings-sidebar.test.ts tests/personal-settings.test.tsx`
Expected: PASS（`personal-settings.test.tsx` 里断言旧侧栏的用例改成新标题）

- [ ] **Step 5: 提交**

```bash
git add app/src/components/settings/settings-sidebar.tsx app/tests/settings-sidebar.test.ts app/tests/personal-settings.test.tsx
git commit -m "设置整理：设置侧栏改成七个话题，按归属亮灯，待办数挂到对应话题"
```

### Task 5: 账户与外观 `/settings`

**Files:**
- Modify: `app/src/routes/_authed/settings/index.tsx`
- Modify: `app/src/components/quota/plans-page.tsx:51`（标题「套餐与用量」，`backButton` 回 `/settings`）、`app/src/routes/_authed/settings/about.tsx`（`backButton`）、`app/src/routes/_authed/settings/setup.tsx`（`backButton` 按受众回 `/settings` 或 `/settings/team`）
- Modify: `app/src/lib/settings/setting-keys.ts`、`app/tests/settings-render-once.test.tsx`（`PAGES` 加 `/settings`）
- Test: `app/tests/general-settings.test.tsx`、`app/tests/settings-about.test.tsx`

**Interfaces:**
- Consumes: `SettingsSection`、`useSettingsAudience`、`useAnchorScroll`。
- 节与锚点按 §5.3.1：`#about-you`、`#appearance`、`#hotkeys`、`#plan`、`#about`。行为对应 B01–B10、E01、H01、H02、K01。

- [ ] **Step 1: 写失败的测试**

```ts
test("页标题是账户与外观，没有「我的设备搬到了」的附注", ...);           // B01、B08
test("套餐与用量一行：摘要「<套餐名> · 本月 N 个任务」，箭头进 /settings/plans", ...); // B09
test("关于：版本只读；开源软件声明进 /settings/about", ...);             // B10
test("部署设置一行只在个人版或 maySetUp 的成员显示，摘要是待办数；团队版管理员没有", ...);
test("名字、长期指令、深色主题、皮肤、消息列表突出显示各带一个 data-setting-key", ...);
test("/settings/plans 标题是套餐与用量，有返回按钮回账户与外观", ...);   // E01
```

- [ ] **Step 2: 跑测试确认失败** — Run: `cd xiongbao/app && bun test tests/general-settings.test.tsx tests/settings-about.test.tsx` Expected: FAIL
- [ ] **Step 3: 实现**（各节换成 `SettingsSection`；控制上加 `data-setting-key`）
- [ ] **Step 4: 跑测试确认通过** — Run: 同上加 `tests/settings-render-once.test.tsx tests/settings-setup.test.tsx` Expected: PASS
- [ ] **Step 5: 提交** — `git commit -m "设置整理：账户与外观收进套餐与用量、关于、部署设置入口"`

### Task 6: 电脑与设备 `/settings/devices`

**Files:**
- Modify: `app/src/routes/_authed/settings/devices.tsx`
- Create: `app/src/components/settings/team/network-section.tsx`（`NetworkSection`，从 `routes/_authed/admin/enterprise.tsx` 的「网络」节和 `NetworkDialog` 搬来，O07、O08）、`app/src/components/settings/team/idle-computers-section.tsx`（`IdleComputersSection`，「电脑」节 + `DaysDialog` + `SweepNow`，O17、O18）
- Modify: `app/src/routes/_authed/admin/enterprise.tsx`（删掉这两节）
- Modify: `app/src/components/manage/computers-page.tsx`（拆出 `ThisComputerSections`（◆两节）和 `TeamComputersSection`（★）两个导出，供话题页内嵌；逐行对照 fork 的 `routes/_authed/admin/computers.tsx`，fork 独有的行为补进上游组件，拿不准的写进 PR 说明，§11）
- Modify: `app/src/lib/manage-paths.ts`（`computers()` 两个版本都指 `/settings/devices`，锚点由 `movedHref` 规则一致：团队 `#team-computers`、个人 `#this-computer`）
- Modify: `app/src/lib/settings/moves.ts`（加 U51、U52）
- Delete: X01 `app/src/components/admin/controls/computer-sections.tsx`、X02 `app/src/components/admin/controls/network-describe.tsx`、X07 `app/tests/admin-network-describe.test.tsx`、X12 `app/src/routes/_authed/admin/computers.tsx`；`app/src/routes/_authed/settings/_personal/computer.tsx`（由 `settings/$.tsx` 接住 U52）
- Modify: `app/src/components/resources/projects-section.tsx`（「在「我的设备」里配对」→「在「电脑与设备」里配对」，P06）
- Server（§12 只改字符串的独立提交）: `server/src/devices/queue.ts:71`、`server/src/devices/channel.ts:453`「设置 › 我的设备」→「设置 › 电脑与设备」
- Test: `app/tests/devices-settings.test.tsx`、`app/tests/settings-gating.test.tsx`

**Interfaces:**
- 节按 §5.3.5：`#my-devices`、◆ `#this-computer`（+ 文件夹节）、★ `#team-computers`、★ `#network`、★ `#idle`。
- 新键：`devices.pair`、`enterprise.network`、`enterprise.inactiveComputerDays`（加进 `SETTING_KEYS`）。

- [ ] **Step 1: 写失败的测试**

```ts
test("页标题电脑与设备，第一节「我的设备」", ...);                         // F01–F04
test("个人版有「你的员工的浏览器」「这台电脑上的文件夹」，没有团队三节", ...);
test("团队版管理员有「团队的电脑」「网络」「闲置电脑」，描述首句是「只有管理员看得到。改动对所有成员生效。」", ...);
test("团队版成员只有「我的设备」", ...);
test("企业管控页不再有网络和电脑两节", ...);
```

- [ ] **Step 2: 跑测试确认失败** — Run: `cd xiongbao/app && bun test tests/devices-settings.test.tsx tests/settings-gating.test.tsx` Expected: FAIL
- [ ] **Step 3: 实现**（`settings-render-once` 的 `PAGES` 加 `/settings/devices`；`settings-names` 的 `RETIRED` 加「我的设备」页标题用法——注意节名「我的设备」保留，测试只查页标题与入口，按 §5.8 那一行的写法列例外）
- [ ] **Step 4: 跑测试确认通过** — Run: `cd xiongbao/app && bun test tests/devices-settings.test.tsx tests/settings-gating.test.tsx tests/settings-render-once.test.tsx tests/settings-moves.test.tsx tests/manage-paths.test.ts` Expected: PASS
- [ ] **Step 5: 提交**（两次）

```bash
git commit -m "设置整理：电脑与设备并入个人版电脑、团队的电脑、网络和闲置电脑，删除重复实现"
git add server/src/devices/queue.ts server/src/devices/channel.ts
git commit -m "服务器文案：设备配对的提示改指「设置 › 电脑与设备」"
```

### Task 7: 「我」菜单与入口栏

**Files:**
- Modify: `app/src/skins/xiongbao/me-page.tsx`
- Modify: `app/src/lib/navigation.ts`（`railForPath`：`/settings` 前缀先于 `NAVIGATION` 认领判断，归「我」）
- Test: `app/tests/workbench-me.test.tsx`、`app/tests/navigation-rail.test.ts`

**Interfaces:** 菜单行按 §5.2「我」图与 A19–A28：个人资料 → `/settings#about-you`；我的电脑改「电脑与设备」（摘要「已配对 N 台」）；通知改「主动与通知」；外观 → `/settings#appearance`；设置摘要「全部设置」。「管理」行在 Task 28 删（管理后台此时仍在）。

- [ ] **Step 1: 写失败的测试**

```ts
test("我 菜单依次是 个人资料、我的分身、电脑与设备、主动与通知、套餐与用量、外观、设置", ...);
test("个人资料和外观带锚点", () => { /* to + hash */ });
test("railForPath('/settings/connections/apps') 是 me", () => {
  expect(railForPath("/settings/connections/apps")).toBe("me");
});
```

- [ ] **Step 2: 失败** — Run: `cd xiongbao/app && bun test tests/workbench-me.test.tsx tests/navigation-rail.test.ts`
- [ ] **Step 3: 实现**
- [ ] **Step 4: 通过** — 同上
- [ ] **Step 5: 提交** — `git commit -m "设置整理：我 菜单改名、加锚点，设置下的地址一律归「我」"`

### Task 8: 截图工具：缩放与三种受众

**Files:**
- Modify: `app/tests/parity/capture.ts`（`--scale <n>`，默认 1，传给 `newContext({ deviceScaleFactor })`；`--audience admin|member|personal|all`，默认 admin）
- Modify: `app/tests/parity/fixtures.ts`（`resolveFixture` 增加可选参数 `audience: "admin" | "member" | "personal" = "admin"`：`member` 改 `/api/me` 的 `role` 为 `"user"`，`personal` 改能力接口的 `edition` 为 `"personal"`）
- Modify: `app/tests/parity/capture.ts` 的 `ROUTES`、`app/tests/i18n-route-table.ts`：加 `/settings/devices`，删 `/admin/computers`、`/settings/computer`
- Modify: `app/tests/parity/README.md`（写清新参数）
- Test: `app/tests/parity-fixture-audience.test.ts`

- [ ] **Step 1: 写失败的测试**

```ts
test("member 夹具的 /api/me 是普通成员，personal 夹具的能力接口是个人版", () => {
  expect(resolveFixture("GET", "/api/me", "data", undefined, "member")?.body).toMatchObject({ role: "user" });
  expect(body(resolveFixture("GET", CAPABILITIES_PATH, "data", undefined, "personal"))).toMatchObject({ edition: "personal" });
});
```

- [ ] **Step 2: 失败** — Run: `cd xiongbao/app && bun test tests/parity-fixture-audience.test.ts tests/i18n-route-coverage.test.ts`
- [ ] **Step 3: 实现**
- [ ] **Step 4: 通过** — 同上
- [ ] **Step 5: 提交** — `git commit -m "截图工具：支持 2 倍像素和团队版成员、个人版两套夹具"`

### PR 1 收尾

- [ ] 在 `xiongbao/` 下：`bunx biome lint --error-on-warnings --diagnostic-level=warn .`、`bun run typecheck`、`bun run typecheck:tests`、`bun run test:shards`（新测试文件进分片清单并提交），全部通过。
- [ ] 截图（§10.7）：`bun tests/parity/capture.ts --scale 2 --viewport 1440x900 --theme light --audience all --only settings`，再 `--viewport 390x844` 一遍、`--theme dark` 一遍；内容：`/settings`、`/settings/plans`、`/settings/about`、`/settings/devices`，设置侧栏、我 菜单、工作台列表栏三种受众各一张。交给用户，确认后推送并开 PR。

---

# PR 2 审批与安全 + 待审批 + 审批卡区分

分支 `feat/settings-pr2-approvals`。依赖：PR 1 已合并。

### Task 9: 审批与安全 · 本人的节

**Files:**
- Move: `git mv app/src/routes/_authed/settings/approvals.tsx app/src/routes/_authed/settings/approvals/index.tsx`
- Modify: `app/src/components/approvals/settings.tsx`（`ApprovalSettings`：节名「你的设置」`#my-approvals`；开关名取 `ASK_FIRST_TITLE`；「自动审核」→「自动审查」；规则 `#my-rules`、其他员工 `#other-rules`）
- Modify: `app/src/components/approvals/ask-first-copy.ts:23`：`export const ASK_FIRST_TITLE = "改动前先问我";`
- Modify: `app/src/components/settings/team-bot-consents.tsx`（▲ `#shared-consents`）
- Modify: `app/src/components/approvals/bot-rules.tsx:53`（「设置 › 审批」→「设置 › 审批与安全」，链接 `/settings/approvals#my-rules`，S07）
- Modify: `app/src/components/manage/plugin-page.tsx`（引用 `ASK_FIRST_TITLE` 那句随常量变）
- Modify: `app/src/lib/settings/moves.ts`（U41：`from: "/settings/approvals"`，`only: (s) => typeof s.focus === "string"`，`to: "/approvals"`，`search: ["focus"]`）
- Test: `app/tests/approvals-rules.test.tsx`、`app/tests/approval-words.test.tsx`、`app/tests/settings-gating.test.tsx`

**Interfaces:** 节按 §5.3.3 前五项（D01、D03–D11）。新键：`approvals.enabled`、`approvals.autoReview`、`approvals.hostCommands`、`approvals.rules`、`approvals.sharedConsents`。

- [ ] **Step 1: 写失败的测试**

```ts
test("页标题审批与安全；第一节「你的设置」里第一个开关叫「改动前先问我」", ...);
test("没有「等你处理」，也没有「团队设置……在 管理 → 审批」的提示", ...);   // D02、D03
test("/settings/approvals?focus=r1 转到 /approvals?focus=r1；不带 focus 不转", ...); // U41
test("审计记录一行：个人版所有人看得到；团队版只有管理员看得到", ...);     // D11
test("ASK_FIRST_TITLE 是「改动前先问我」，引导欢迎步用同一个常量", ...);    // R10
```

- [ ] **Step 2: 失败** — Run: `cd xiongbao/app && bun test tests/approvals-rules.test.tsx tests/approval-words.test.tsx tests/settings-gating.test.tsx`
- [ ] **Step 3: 实现**（`settings-names` 的 `RETIRED` 加「做任何改动前都先问我」「员工动手之前」「自动审核」「在你电脑上执行命令」；`settings-render-once` 的 `PAGES` 加 `/settings/approvals`）
- [ ] **Step 4: 通过** — 同上加 `tests/settings-names.test.ts tests/settings-render-once.test.tsx tests/settings-moves.test.tsx`
- [ ] **Step 5: 提交** — `git commit -m "设置整理：审批与安全的本人设置，「改动前先问我」只剩一个名字"`

### Task 10: 审批与安全 · 团队的节

**Files:**
- Modify: `app/src/routes/_authed/settings/approvals/index.tsx`
- Modify: `app/src/components/approvals/team-settings.tsx`（`TeamApprovalSettings` 拆成 `TeamApprovalSection`（`#team-approvals`）、`AlwaysAskSection`（`#always-ask`）、`DesktopWordsSection`（`#desktop-words`）、`TeamRulesSection`（`#team-rules`）四个导出；改名 N09「成员的个人规则可以放宽审批」、N11「成员电脑上运行命令的上限」；N09 描述点名「团队管理 › 权限 › 成员可以保存个人规则」）
- Create: `app/src/components/settings/team/records-section.tsx`（`RecordsSection`，从 `enterprise.tsx` 搬「记录与导出」与 `RecordedActions`，O14–O16）
- Modify: `app/src/routes/_authed/admin/enterprise.tsx`（删记录与导出一节）
- Delete: X03 `app/src/components/admin/controls/recording-section.tsx`、X06 `app/src/components/passwords/passwords-page.tsx`
- Test: `app/tests/approval-team-settings.test.tsx`

**Interfaces:** 全部 `audience: { who: "team-admin", edition: "team" }`。新键：`approvals.team.enforceAutoReview`、`approvals.team.customRulesEnabled`、`approvals.team.enforceDangerousCommands`、`approvals.team.hostCommandsCap`、`approvals.team.actionKinds`、`approvals.team.desktopActionWords`、`approvals.team.rules`、`enterprise.actionRecording`。动作推演、边界规则、指引、描述四行指向 Task 11 的子页地址。

- [ ] **Step 1: 写失败的测试**

```ts
test("团队版管理员在你的设置之后看到 团队的审批设置、总要先问的操作、桌面逐次审批、团队规则、边界规则、记录与导出、动作推演", ...);
test("「成员的个人规则可以放宽审批」写的是 customRulesEnabled", ...);
test("成员和个人版看不到任何团队节", ...);
test("企业管控不再有记录与导出", ...);
```

- [ ] **Step 2–4:** Run: `cd xiongbao/app && bun test tests/approval-team-settings.test.tsx tests/settings-render-once.test.tsx tests/settings-single-writer.test.ts`，先 FAIL 后 PASS
- [ ] **Step 5: 提交** — `git commit -m "设置整理：团队的审批设置、规则、记录与导出并入审批与安全"`

### Task 11: 审批与安全的子页（边界规则、指引、描述、审计记录、动作推演）

**Files:**
- Move（`git mv`，内容只改 `createFileRoute` 路径、`backButton` 目标和标题）:
  - `routes/_authed/admin/boundaries.tsx` → `routes/_authed/settings/approvals/boundaries/index.tsx`（N04）
  - `routes/_authed/admin/boundaries_.new.tsx` → `settings/approvals/boundaries/new.tsx`（N05）
  - `routes/_authed/admin/boundaries_.$index.tsx` → `settings/approvals/boundaries/$index.tsx`（N06）
  - `routes/_authed/admin/approvals_.guidance.tsx` → `settings/approvals/guidance.tsx`（N17，标题「自动审查的指引」）
  - `routes/_authed/admin/approvals_.describe.tsx` → `settings/approvals/describe.tsx`（N18）
  - `routes/_authed/admin/what-if.tsx` → `settings/approvals/what-if.tsx`（N45）
  - `routes/_authed/admin/audit.tsx` → `settings/approvals/audit.tsx`（N44；同一页按受众：个人版看自己的，团队版管理员看所有人的；成员被 `guardSubpage` 送回 `/settings/approvals`）
- Delete: `routes/_authed/settings/_personal/activity.tsx`（L08，由 U49 接住）
- Modify: 每个搬来的页 `beforeLoad: guardSubpage("team-admin", "/settings/approvals")`（审计记录除外，它用自己的规则）
- Modify: `app/src/lib/manage-paths.ts`（`auditLabel` 两个版本都是「审计记录」，`audit()` 指 `/settings/approvals/audit`）
- Modify: `app/src/lib/settings/moves.ts`（U42–U50）
- Modify: `app/src/components/settings/settings-sidebar.tsx`（`LEGACY_TAIL` 删「活动」）
- Modify: `app/tests/parity/capture.ts` `ROUTES`、`app/tests/i18n-route-table.ts`（新地址）
- Test: `app/tests/settings-moves.test.tsx`（U42–U50 各一条；动作推演三个页 U42、U45 必在）、`app/tests/what-if.test.tsx`、`app/tests/audit-approval-outcomes.test.tsx`

- [ ] **Step 1: 写失败的测试**

```ts
test("U45 /admin/boundaries 去 /settings/approvals/boundaries，返回按钮回审批与安全", ...);
test("U49 /settings/activity 与 U48 /admin/audit 都去 /settings/approvals/audit，标题审计记录", ...);
test("团队版成员打开 /settings/approvals/boundaries 被送回 /settings/approvals", ...);
test("个人版打开 /admin/boundaries：U45 → /settings/approvals/boundaries → 送回 /settings", ...);
```

- [ ] **Step 2–4:** Run: `cd xiongbao/app && bun test tests/settings-moves.test.tsx tests/what-if.test.tsx tests/audit-approval-outcomes.test.tsx tests/i18n-route-coverage.test.ts tests/manage-paths.test.ts`，先 FAIL 后 PASS
- [ ] **Step 5: 提交** — `git commit -m "设置整理：边界规则、指引、描述、审计记录、动作推演搬到审批与安全下"`

### Task 12: `/approvals` 只剩待办，改名「待审批」

**Files:**
- Modify: `app/src/components/approvals/inbox.tsx`（删「你的设置」「规则」「团队设置」三节和只为它们服务的 mutation，§8；R03–R05）
- Modify: `app/src/routes/_authed/_app/approvals.tsx:33`（标题「待审批」；管理员下面加 N16 团队账号使用申请——组件 `components/approvals/shared-use-requests.tsx` 从 `routes/_authed/admin/approvals.tsx` 搬来；N15 访问申请已有）
- Delete: `app/src/routes/_authed/admin/approvals.tsx`（U42 接住）
- Modify: `app/src/components/app-sidebar/app-sidebar.tsx:239`（`MORE_SIDEBAR_ONLY` 审批 → 待审批，A08）、`app/src/skins/xiongbao/workbench-home.tsx`（`MORE_TILES` 审批 → 待审批，A15）
- Modify: `app/src/lib/agents/legacy-routes.ts`（删 `LEGACY_PAGES` 里 `/approvals`、`/team-bots`、`/group/new` 三条，§7 末）
- Test: `app/tests/approvals-focus-row.test.tsx`、`app/tests/legacy-agent-routes.test.ts`、`app/tests/workbench-home.test.tsx`

- [ ] **Step 1: 写失败的测试**

```ts
test("/approvals 标题待审批，没有改动前先问我、规则、团队设置", ...);
test("/approvals?id=<id> 仍打开手机审批详情", ...);                         // R07、3.2
test("管理员在 /approvals 看得到访问申请和团队账号使用申请", ...);
test("工作台更多和首页磁贴都叫待审批", ...);
test("LEGACY_PAGES 不再含 /approvals、/team-bots、/group/new", ...);
```

- [ ] **Step 2–4:** Run: `cd xiongbao/app && bun test tests/approvals-focus-row.test.tsx tests/legacy-agent-routes.test.ts tests/workbench-home.test.tsx tests/settings-single-writer.test.ts`，先 FAIL 后 PASS
- [ ] **Step 5: 提交** — `git commit -m "待审批：/approvals 只剩要处理的事，设置都在审批与安全"`

### Task 13（服务器例外 3）: 员工画的确认卡不计入审批数

**Files:**
- Modify: `shared/decision-tools.ts`（`askApproval: "question"`；注释改写：员工的确认卡是员工提问，系统审批只来自审批收件箱）
- Modify: `server/src/approvals/decision-waits.ts`（`APPROVAL_CARDS` 删除，注释说明决定卡一律算提问）
- Modify: `server/src/activity/activity.ts:519`、`:705`（不再判断 `APPROVAL_CARDS`：决定卡一律 `kind: "question"`、计入 `questions`）
- Test: `server/tests/decision-waits.integration.test.ts`（改写第 330 行那条）

**Interfaces:** `AttentionCounts.approvals` 此后只数系统审批（审批收件箱），`questions` 含员工提问与员工确认卡。前端「待审批」读 `approvals`，「等你处理」= `approvals + questions`（Task 33）。

- [ ] **Step 1: 改写失败的测试**

```ts
test("员工的 askApproval 卡算员工提问，不算审批；走运行器的启动入口也一样", async () => {
  // 同原用例的造数：runner.runWithStartupBoundary 结束时留下一个 askApproval 调用
  expect(await botRow(owner)).toMatchObject({ questions: 1, approvals: 0 });
  // 回答后清零
  expect((await botRow(owner))?.questions ?? 0).toBe(0);
});
test("员工动态里这张卡的 kind 是 question", async () => { ... });
```

- [ ] **Step 2: 失败** — Run: `cd xiongbao/server && bun test tests/decision-waits.integration.test.ts`（需要 `TEST_DATABASE_URL`，见 `server/tests/support/database.ts`）Expected: FAIL，`approvals: 1`
- [ ] **Step 3: 实现**
- [ ] **Step 4: 通过** — 同上加 `bun test tests/tasks.integration.test.ts` Expected: PASS
- [ ] **Step 5: 提交** — `git commit -m "员工画的确认卡计入员工提问，待审批只数系统审批"`

### Task 14: 员工确认卡：说明、门控、按钮词与外观

**Files:**
- Modify: `app/src/components/gallery/decisions.tsx`（`ApprovalCard` 与 `GALLERY[0]`）
- Modify: `app/src/lib/approvals.ts`（新增判定函数）
- Modify: `app/src/lib/copilot/gallery-tools.tsx`（`useDecisionTool` 的 `handler`：`spec.name === "askApproval"` 时先判定，命中不挂起，直接 resolve 固定结果）
- Test: `app/tests/approval-card-distinction.test.tsx`、`app/tests/decision-card.test.tsx`、`app/tests/decision-registration.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  /** 同一个动作已有待处理的系统审批：同一 threadId，且 action.toolCallId 是这张卡所在助手消息里的某个工具调用（含它自己）。不看 runId（§14 问题 4）。 */
  export function systemApprovalHolding(
    inbox: ApprovalInboxData | undefined,
    threadId: string,
    toolCallIds: readonly string[],
  ): ApprovalInboxData["requests"][number] | undefined;
  export const HELD_BY_SYSTEM_APPROVAL = "这一步由系统审批，已经在等本人处理，不要重复请求。";
  /** 冒充系统的按钮词换成默认词 */
  export function safeDecisionLabel(label: string | undefined, fallback: "同意" | "不同意"): string;
  ```
- 固定文案（§5.6、§5.8、§14 问题 4）：`GALLERY[0].title = "向你确认"`；默认按钮「同意」「不同意」；被替换的词：「批准」「允许」「允许一次」「同意执行」（去空白后全等或以这些词开头）；卡顶「<员工名>在问你」（无盾牌）；卡底小字「这是员工的提问，不是系统审批。受保护的动作由系统另行审批。」；外框普通卡片样式。`description` 照 §5.6 第 1 条写三句：只用于只有本人能做的业务决定（如「给这笔订单退款吗」）；「不要用它请求写文件、运行命令、改动应用或网站：这些由系统审批，系统会自己问」；「被系统拦下时不要再画这张卡，等系统审批的结果」。`command` 参数和活动里的「被拒的命令」保留（§14），门控不因 `command` 有值而拦（见文末「自定」）。
- 助手消息里兄弟调用的 id 从运行时 agent 的消息里取（`context.toolCall.id` 所在的那条 assistant 消息的 `toolCalls`）；取不到时只用 `[context.toolCall.id]`。

- [ ] **Step 1: 写失败的测试**

```ts
test("approveLabel 传「批准」「允许一次」时画出的是「同意」", () => {
  render(<ApprovalCard status="executing" args={{ title: "t", approveLabel: "批准" }} respond={noop} />);
  expect(screen.getByRole("button", { name: "同意" })).toBeTruthy();
  expect(screen.queryByText("批准")).toBeNull();
});
test("合法的「退款」按钮词保留", ...);
test("卡顶写「<员工名>在问你」，卡底写「这是员工的提问，不是系统审批。受保护的动作由系统另行审批。」，没有「系统审批」标签", ...);
test("同一条消息里兄弟调用在等系统审批：不画卡，工具结果是固定那句话", async () => {
  // inbox 有 { status: "pending", action: { threadId: "t1", toolCallId: "call-sibling" } }
  expect(await handler({ title: "x" }, ctx("t1", "call-card", ["call-card", "call-sibling"]))).toBe(HELD_BY_SYSTEM_APPROVAL);
});
test("别的对话里有待处理系统审批：照常画卡并等回答", ...);            // Review Focus 5
test("工具说明含「不要用它请求写文件、运行命令、改动应用或网站」", ...);
```

- [ ] **Step 2: 失败** — Run: `cd xiongbao/app && bun test tests/approval-card-distinction.test.tsx tests/decision-card.test.tsx tests/decision-registration.test.tsx`
- [ ] **Step 3: 实现**
- [ ] **Step 4: 通过** — 同上加 `tests/gallery-components.test.tsx tests/components-gallery-words.test.tsx`
- [ ] **Step 5: 提交** — `git commit -m "员工确认卡：改名向你确认，按钮词不能冒充系统，同一动作已有系统审批时不画"`

### Task 15: 系统审批卡加「系统审批」标签

**Files:**
- Modify: `app/src/components/approvals/inline-approval.tsx`（`InlineApproval` 顶部固定一条「系统审批」+ `IconShieldCheck`；外框用审批强调色——在 `app/src/styles.css` / `theme.css` 加令牌 `--approval-accent`，浅深两套）
- Test: `app/tests/approval-card-internals.test.tsx`

- [ ] **Step 1: 写失败的测试**

```ts
test("系统审批卡顶部有「系统审批」标签，按钮只有「允许一次」「拒绝」（规则允许时另有范围选项）", ...);
test("生成式组件注册表里没有能画「系统审批」标签的组件", () => {
  // 遍历 GALLERY 的 preview 渲染，断言 queryByText("系统审批") 为 null
});
```

- [ ] **Step 2–4:** Run: `cd xiongbao/app && bun test tests/approval-card-internals.test.tsx tests/approval-card-distinction.test.tsx`，先 FAIL 后 PASS
- [ ] **Step 5: 提交** — `git commit -m "系统审批卡加「系统审批」标签和专用外框，与员工确认卡一眼分开"`

### PR 2 收尾

- [ ] 全量检查同 PR 1 收尾。
- [ ] 截图：`/settings/approvals` 及五个子页、`/approvals`（三种受众 × 桌面浅色，每页手机一张、深色一张），加两种审批卡各一张（系统审批卡用 `/channel/<id>` 夹具对话，员工确认卡用此时仍在的 `/settings/components-gallery/askApproval`），进视觉回归目录。用户确认后推送。

---

# PR 3 员工与模型 + 模型有效状态

分支 `feat/settings-pr3-models`。依赖：PR 1 已合并。服务器两个 Task 先做。

### Task 16（服务器例外 2）: 模型最近一次测试结果落库

**Files:**
- Create: `server/drizzle/<000N>_model_last_test.sql`
- Modify: `server/drizzle/meta/_journal.json`（追加一条：`idx` = N，`tag` = 文件名去 `.sql`，`when` 大于上一条且不晚于提交时刻，`version: "7"`，`breakpoints: true`）
- Modify: `server/src/db/schema/model.ts`（`modelRegistry` 加四列）
- Modify: `server/src/models/routes.ts`（`probe` 返回加 `status?: number`；`POST /:id/test` 写回四列；`GET /` 的 select 带出四列，响应字段 `lastTest`）
- Modify: `app/src/lib/models/queries.ts`（`ConnectedModel.lastTest?: ModelLastTest | null`）
- Test: `server/tests/model-library-routes.test.ts`、`server/tests/model-probe.test.ts`

**编号：** 迁移在 R4 Task 26 合成了基线 `0000_baseline`，基线之后的第一条是 `0001_memory_corrections`（原恢复层 0242）。实施时 `ls server/drizzle/*.sql | tail -3` 取下一个空号（预计 `0002`）；合并前 rebase 到最新 main 再查一次，撞号就顺延，并同步改日志条目（`idx`、`tag`、`when` 仍要大于前一条）和文件名。

**Interfaces:**
- SQL（文件头照 `server/drizzle/0001_memory_corrections.sql` 的写法写目的、列、已有数据、授权；回滚写成 `回滚：` 一行、下面每条语句缩进两格，`tests/migration-baseline.test.ts` 会倒序执行它们并要求回到基线结构）：
  ```sql
  ALTER TABLE "public"."model_registry" ADD COLUMN "last_test_at" timestamp with time zone;
  ALTER TABLE "public"."model_registry" ADD COLUMN "last_test_ok" boolean;
  ALTER TABLE "public"."model_registry" ADD COLUMN "last_test_status" integer;
  ALTER TABLE "public"."model_registry" ADD COLUMN "last_test_reason" text;
  ALTER TABLE "public"."model_registry" ADD CONSTRAINT "model_registry_last_test_reason_short" CHECK (char_length("last_test_reason") <= 200);
  GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."model_registry" TO xiongbao_app;
  ```
  每条语句之间 `--> statement-breakpoint`。不回填。
- 类型：
  ```ts
  export type ModelLastTest = { at: string; ok: boolean; status: number | null; reason: string | null };
  ```
- 写入规则：通过 → `ok true, status <HTTP 状态>, reason null`；失败 → `ok false, status <HTTP 状态或 null>, reason <probe 的 error 一行，截到 200 字>`；密钥已吊销 → `ok false, status null, reason "密钥已被吊销。"`；出站被拒（`refused`）→ `ok false, status null, reason <error>`。从不存响应正文或密钥。打开页面不自动探测。

- [ ] **Step 1: 写失败的测试**

```ts
test("测试一次后，模型库列出最近一次测试：时间、失败、401、一句话原因", async () => {
  // fetchImpl 回 401
  await post(`/api/models/${id}/test`);
  const model = (await getJson("/api/models")).models.find((m) => m.id === id);
  expect(model.lastTest).toMatchObject({ ok: false, status: 401, reason: "HTTP 401" });
  expect(typeof model.lastTest.at).toBe("string");
});
test("没测过的模型 lastTest 为 null", ...);
test("测试结果不含响应正文和密钥", async () => {
  // fetchImpl 回 503，正文里放 "sk-secret-body"
  expect(JSON.stringify(row)).not.toContain("sk-secret-body");
});
// model-probe.test.ts
test("probe 把 HTTP 状态一起返回", async () => {
  expect(await probe("openai", null, "m", "k", { fetchImpl: answer(503) })).toMatchObject({ ok: false, status: 503 });
});
```

- [ ] **Step 2: 失败** — Run: `cd xiongbao/server && bun test tests/model-library-routes.test.ts tests/model-probe.test.ts`
- [ ] **Step 3: 实现**（迁移、日志、schema、路由）
- [ ] **Step 4: 通过** — 同上加 `bun test tests/migration-journal.test.ts tests/migration-reach.test.ts tests/migration-baseline.test.ts tests/new-tables-grants.integration.test.ts`
- [ ] **Step 5: 提交** — `git commit -m "模型库记下每个模型最近一次测试的结果（时间、通过与否、HTTP 状态、一句话原因）"`

### Task 17（服务器例外 1）: 只读 `GET /api/agents/:agentId/readiness`

**Files:**
- Modify: `server/src/admin/gate.ts`（把 `governRun` 里「这次运行用哪个模型、白名单允不允许」抽成导出的 `judgeRunModel`，`governRun` 改调它，记录与拒绝行为一字不变）
- Create: `server/src/agents/readiness.ts`
- Modify: `server/src/app.ts`（在 `app.route("/api/agents", createAgentRoutes(...))` 之前挂 `app.route("/api/agents", createReadinessRoutes(...))`）
- Test: `server/tests/agent-readiness.integration.test.ts`；回归：`server/tests/enterprise-controls.integration.test.ts`、`server/tests/enterprise-allowlist-always-on.test.ts`

**Interfaces:**
- `gate.ts`:
  ```ts
  export type RunModelJudgment = {
    builtIn: boolean;
    /** 内置员工这次会用的模型（provider/model）；远程员工 undefined */
    model: string | undefined;
    source: "bound" | "configured";
    allowed: boolean;
  };
  export async function judgeRunModel(
    controls: NonNullable<ReturnType<typeof enterpriseControls>>,
    actorId: string,
    agentId: string,
    threadId: string | null,
  ): Promise<RunModelJudgment>;
  ```
- `readiness.ts`:
  ```ts
  export type ReadinessModelSource =
    | "deployment_default" | "model_library" | "platform_pool" | "conversation" | "remote";
  export type ReadinessReason =
    | "no_model" | "key_rejected" | "provider_unavailable" | "not_allowed"
    | "plan_locked" | "device_offline" | "capability_off" | "remote_offline";
  export type AgentReadiness = {
    agentId: string;
    kind: "built_in" | "remote";
    model: string | null;                  // 远程为 null
    source: ReadinessModelSource;
    deploymentDefault: string | null;
    lastTest: { at: string; ok: boolean; status: number | null; reason: string | null } | null; // 只对模型库条目
    verdict: "ready" | "untested" | "blocked" | "remote";
    reason: ReadinessReason | null;        // verdict 为 blocked 时必有
  };
  export async function judgeReadiness(deps: ReadinessDeps, actor: AgentActor, agentId: string): Promise<AgentReadiness | null>;
  export function createReadinessRoutes(deps: ReadinessDeps, requireUser: MiddlewareHandler<{ Variables: AppVariables }>): Hono<...>;
  ```
  `ReadinessDeps`：`agentProfileStore`（`store.get(actor, id)` 读不到 → 404，与 `canRunAgent` 同一规则，不泄露别人的私有员工）、`database`、`quota: QuotaService`、设备在线读取（`server/src/devices/store.ts` 里 `online` 的同一来源）、`enterpriseControls()`。
- 判定顺序（§5.5「先看有没有，再看连不连得上，再看准不准用，最后看在哪儿跑」，与运行入口一致）：
  1. `controls.capabilityFor(actor.id, "useBots")` 为假 → `blocked / capability_off`。
  2. 远程员工（`type !== "built_in"`）：`source: "remote"`，`verdict: "remote"`；`device_acp` 的电脑离线 → `blocked / remote_offline`。不声称模型可派发（§16.1）。
  3. 内置员工：`judgeRunModel(controls, actor.id, agentId, null)`；`bindingRefsFor` 决定来源：library → `model_library`，pool → `platform_pool`，null 且员工未绑定 → `conversation`（显示「随对话里选的模型；没选时用部署默认」，白名单按部署默认判），绑定已失效回落 → `deployment_default`。没有可用模型 → `blocked / no_model`。
  4. `allowed` 为假 → `blocked / not_allowed`。
  5. 来源是 `model_library` 且套餐 `limits.customModels` 为假 → `blocked / plan_locked`。
  6. 来源是 `model_library`：读 Task 16 的 `lastTest`；最近一次失败且 `status === 401 || 403` → `blocked / key_rejected`；失败且 `status` 为 503、429 或 null → `blocked / provider_unavailable`；没测过 → `untested`；通过 → `ready`。其余来源 → `ready`。
  - 没有 `enterpriseControls()`（单测、脚本）时跳过 1、4，与 `governRun` 放行一致。
  - 只读：不写用量行、不写审计、不探测服务商。

- [ ] **Step 1: 写失败的测试**

```ts
test("绑定的模型库条目最近一次测试 401：blocked / key_rejected", ...);
test("最近一次 503：blocked / provider_unavailable", ...);
test("白名单开着且模型不在名单：blocked / not_allowed，与真实运行的 403 同一判定", async () => {
  expect((await readiness(agent)).reason).toBe("not_allowed");
  expect((await runViaGate(agent)).status).toBe(403);
});
test("套餐不支持自带模型：blocked / plan_locked", ...);
test("没测过但其余条件都满足：untested", ...);
test("内置员工没绑定：来源 conversation，按部署默认判白名单", ...);
test("绑定的模型被停用或密钥被吊销：报回落后的部署默认模型，来源 deployment_default", ...); // Review Focus 4
test("远程员工：verdict remote，不报模型；外部员工电脑离线：remote_offline", ...);
test("别人的私有员工 404；未登录 401", ...);
test("读 readiness 不写 model_usage、不写审计", ...);
```

- [ ] **Step 2: 失败** — Run: `cd xiongbao/server && bun test tests/agent-readiness.integration.test.ts`
- [ ] **Step 3: 实现**
- [ ] **Step 4: 通过** — 同上加 `bun test tests/enterprise-controls.integration.test.ts tests/enterprise-allowlist-always-on.test.ts tests/agent-model-binding.test.ts`
- [ ] **Step 5: 提交** — `git commit -m "新增只读 readiness 接口：与运行入口同一判定，说清员工现在能不能派活"`

### Task 18: 前端 readiness 与原因词

**Files:**
- Create: `app/src/lib/agents/readiness.ts`
- Create: `app/src/lib/settings/status-words.ts`
- Test: `app/tests/status-words.test.ts`

**Interfaces:**
- Consumes: Task 17 的 `AgentReadiness`（前端复写同形类型）。
- Produces:
  ```ts
  export function agentReadinessQueryOptions(agentId: string): UseQueryOptions<AgentReadiness>;
  export type StatusLine = {
    tone: "ok" | "warn" | "blocked" | "unknown";
    text: string;                         // 显示
    next: { label: string; to?: LinkOptions; action?: "retest" } | null;
  };
  export function modelStatusLine(r: AgentReadiness, ctx: { isAdmin: boolean; modelLabel: string; sourceLabel: string }): StatusLine;
  export type AppStatusInput =
    | { kind: "not_connected"; app: string; canConnect: boolean }
    | { kind: "not_granted"; app: string; bot: string }
    | { kind: "granted"; app: string; writes: boolean }
    | { kind: "needs_device" }
    | { kind: "blocked_by_rule" }
    | { kind: "unreadable"; reason: string };
  export function appStatusLine(input: AppStatusInput, ctx: { isAdmin: boolean }): StatusLine;
  export const MODEL_SOURCE_LABEL: Record<ReadinessModelSource, string>;
  ```
- 文字逐字取自 §5.5 两张表的「显示」「下一步」列；来源五种：部署默认模型 / 我的模型库 / 平台体验模型 / 随对话里选的模型；没选时用部署默认（当前：<名字>）/ 由对方自己选择，运行时才知道（§16.1）；`untested` 显示「可以派活 · <模型> · 来自<来源> · 未测」，下一步「测试」；「改选获准环境」一律写「去员工设置改执行位置」（§16.2）；`not_granted` 写成「<员工名>还不能用<应用>」（按员工，不写总数）；`unreadable` 显示「读不到」。

- [ ] **Step 1: 写失败的测试**（§10.5：两张表每行一条）

```ts
test.each([
  ["key_rejected", "模型服务商不认这把密钥", "改密钥"],
  ["provider_unavailable", "模型服务商暂时没回应", "再测一次"],
  ["not_allowed", "管理员没有允许这个模型", "去允许"],
  ["plan_locked", "当前套餐只能用部署自带的模型", "查看套餐"],
  ["device_offline", "它要用的电脑现在不在线", "查看设备"],
  ["no_model", "这位员工还没选模型", "选模型"],
])("模型 %s → %s / %s（管理员）", (reason, text, next) => { ... });
test("非管理员 key_rejected 的下一步是「告诉管理员」，not_allowed 是「换一个允许的模型」", ...);
test("ready 写「可以派活 · <模型> · 来自<来源>」，没有下一步", ...);
test.each([...])("应用 %s", ...); // 未连接 / 未授予 / 已授予只读 / 已授予会改动 / 需要在线设备 / 规则阻止 / 读不到
```

- [ ] **Step 2–4:** Run: `cd xiongbao/app && bun test tests/status-words.test.ts`，先 FAIL 后 PASS
- [ ] **Step 5: 提交** — `git commit -m "有效状态的原因词与下一步集中一处，模型和应用共用"`

### Task 19: 员工与模型 `/settings/models`

**Files:**
- Create: `app/src/routes/_authed/settings/models/index.tsx`
- Create: `app/src/components/settings/model-status-section.tsx`（`ModelStatusSection`，`#model-status`：每位本人员工一行，`modelStatusLine` 的结果；点行去 `/bots/$id/setup`；末行只读「部署默认模型：<名字>」）
- Move: `components/resources/model-zones.tsx` 的 `ModelsTab` 改名 `ModelLibrarySection`（`#model-library`），测试结果显示读 `lastTest`（未测显示「未测」+「测试」按钮），连通测试结果用 `status-words` 的词
- Delete: `app/src/routes/_authed/_app/capabilities.models.tsx`；`app/src/routes/_authed/admin/providers.tsx`
- Create: `app/src/routes/_authed/_app/capabilities.$.tsx`（兜底：`beforeLoad: redirectIfMoved`，未命中 `throw notFound()`；接住 U33 以及后续 U17、U29、U37）
- Modify: `app/src/components/resources/resource-tabs.tsx`（删「模型库」格，A54）
- Modify: `app/src/routes/_authed/admin/enterprise.tsx`（删「模型」「允许的模型」两节与 `ModelUsage`，O11–O13）
- Modify: `app/src/components/settings/settings-sidebar.tsx`（models 话题改指 `/settings/models`）
- Modify: `app/src/lib/settings/moves.ts`（U33、U34）
- Test: `app/tests/settings-models.test.tsx`、`app/tests/admin-providers.test.tsx`（改地址）、`app/tests/resources-parity.test.tsx`

**Interfaces:** ★ `#team-models` 内嵌 `ProviderSection`（节名「提供方」）、`ModelChoiceSection`、`ModelAllowlistSection`（唯一白名单开关「只用允许的模型」）、`AllowedModelsDialog`、`ModelUsageSection`。新键：`enterprise.modelAllowlist`、`enterprise.modelSelection`、`models.library`。

- [ ] **Step 1: 写失败的测试**

```ts
test("员工能不能跑：每位员工一行，写模型、来源和状态；不能派活的写原因和下一步", ...);
test("模型库从能力页搬来：平台体验模型只读，模型可接入、测试、停用、移除、改上下文长度", ...);
test("没测过的模型显示「未测」和「测试」按钮；打开页面不发测试请求", ...);
test("团队版管理员看到团队的模型：提供方、对话中可选的模型、只用允许的模型、用量", ...);
test("企业管控不再有模型白名单；enterprise.modelAllowlist 只渲染一处", ...);
test("能力页签没有模型库", ...);
```

- [ ] **Step 2–4:** Run: `cd xiongbao/app && bun test tests/settings-models.test.tsx tests/admin-providers.test.tsx tests/resources-parity.test.tsx tests/settings-render-once.test.tsx tests/settings-moves.test.tsx`，先 FAIL 后 PASS
- [ ] **Step 5: 提交** — `git commit -m "设置整理：员工与模型——员工能不能跑、模型库、团队的模型，白名单只剩一个开关"`

### Task 20: 界面组件三合一与试验台

**Files:**
- Move: `git mv app/src/routes/_authed/admin/components/index.tsx app/src/routes/_authed/settings/models/components/index.tsx`；`admin/components/$name.tsx` → `settings/models/components/$name.tsx`；`admin/playground.tsx` → `settings/models/playground.tsx`
- Modify: 两个组件页：所有人看列表和详情；`$name` 的「配置」节与列表页「试验台」按钮只给团队版管理员（`SettingsSection` / `shows`）；试验台 `guardSubpage("team-admin", "/settings/models")`
- Delete: X14 `app/src/routes/_authed/settings/components-gallery/index.tsx`、X15 `.../components-gallery/$name.tsx`、`app/src/routes/_authed/_app/capabilities.components.tsx`、`components/resources/source-tabs.tsx` 的 `ComponentsTab`
- Modify: `resource-tabs.tsx`（`MORE_CAPABILITY_TABS` 删「组件」，A56）；侧栏 `LEGACY_TAIL` 删「组件展示」
- Modify: `app/src/lib/settings/moves.ts`（U35–U40）
- Modify: `app/tests/components-gallery-words.test.tsx`、`app/tests/i18n-route-table.ts`、`app/tests/parity/capture.ts`
- Test: `app/tests/settings-components.test.tsx`

- [ ] **Step 1: 写失败的测试**

```ts
test("成员打开 /settings/models/components/askApproval 看得到详情，没有「配置」", ...);
test("管理员在列表页有「试验台」，进 /settings/models/playground", ...);
test("U35–U40 六个旧地址都落到界面组件或试验台", ...);
```

- [ ] **Step 2–4:** Run: `cd xiongbao/app && bun test tests/settings-components.test.tsx tests/components-gallery-words.test.tsx tests/settings-moves.test.tsx tests/i18n-route-coverage.test.ts`，先 FAIL 后 PASS
- [ ] **Step 5: 提交** — `git commit -m "设置整理：界面组件三份合一，试验台归员工与模型"`

### PR 3 收尾

- [ ] 全量检查同 PR 1。新增服务器测试文件也要进 `bun run test:shards`。
- [ ] 截图：`/settings/models`（三种受众）、组件列表与详情、试验台；每种模型有效状态各一张（401、503、白名单拦、套餐锁、设备离线、未测）。用户确认后推送。

---

# PR 4 连接与技能 + 能力有效状态

体量最大，按 §9 拆成 4a（应用：Task 21–23）和 4b（技能、登录、密钥、学习：Task 24–25），两个分支 `feat/settings-pr4a-apps`、`feat/settings-pr4b-skills`，4b 在 4a 合并后从最新 main 开。依赖：PR 1。

### Task 21: 连接与技能话题页 + 连接子页（格子、团队的应用、MCP）

**Files:**
- Create: `app/src/routes/_authed/settings/connections/index.tsx`（节按 §5.3.4：`#apps` 一行「连接 · 已连接 N 个应用」→ 子页；`#app-status` 由 Task 23 填；`#skills`、`#learning`、`#logins`、`#keys` 在 4b 落地前先不画）
- Move: `git mv app/src/routes/_authed/_app/connections.index.tsx app/src/routes/_authed/settings/connections/apps/index.tsx`（标题「连接」，`backButton` 回 `/settings/connections`；删 Q05「登录信息和密钥」两行）
- Modify: 连接子页内嵌 ★「团队的应用」（`routes/_authed/admin/plugins/index.tsx` 的内容抽成 `components/settings/team/team-apps-section.tsx` 的 `TeamAppsSection`，节内「已连接」改「已为团队打开」、「发现插件 / 浏览插件」改「发现应用」，N21–N23）和 ★「只用已批准的 MCP 服务器」（从 `enterprise.tsx` 抽成 `components/settings/team/mcp-servers-section.tsx` 的 `McpServersSection`，O09、O10）
- Delete: `app/src/routes/_authed/admin/plugins/index.tsx`、X04 `app/src/components/admin/controls/mcp-allowlist-section.tsx`
- Create: `app/src/routes/_authed/_app/connections.index.tsx`（新的薄重定向，`beforeLoad: redirectIfMoved`，U04）、`app/src/routes/_authed/_app/connections.$.tsx`（兜底，接住 Task 22 的 U05–U09）
- Modify: `app/src/lib/navigation.ts`（`connections` 项 `to: "/settings/connections/apps"`，加 `shortcut: true`：不参与 `navigationOwns`，入口栏和亮灯归「我」）；`app/src/skins/xiongbao/workbench-home.tsx`（连接磁贴改指新地址，A13）
- Modify: `app/src/components/settings/settings-sidebar.tsx`（connections 话题改指 `/settings/connections`）
- Modify: `app/src/lib/edition-guard.ts`（`personalOnly` 的参数类型改 `"/settings/connections/apps" | "/settings"`）
- Modify: `app/src/lib/settings/moves.ts`（U04、U11、U17）
- Server（§12 只改字符串的独立提交）: `server/src/avatar-sources.ts:603`、`server/src/plugins/baidu-netdisk-rest.ts:137-138`「设置 › 已连接的账号」→「设置 › 连接与技能 › 连接」
- Test: `app/tests/personal-connections.test.tsx`、`app/tests/settings-connections.test.tsx`、`app/tests/app-navigation.test.tsx`

- [ ] **Step 1: 写失败的测试**

```ts
test("U04 /connections?error=x&foo=1 去 /settings/connections/apps，参数全部带上", ...);
test("连接子页：搜索、格子、显示 N 个需要先设置的应用、浏览应用；没有登录信息和密钥两行", ...);
test("团队版管理员在连接子页看到团队的应用（已为团队打开、发现应用）和只用已批准的 MCP 服务器", ...);
test("工作台「连接」打开 /settings/connections/apps，入口栏亮「我」", ...);
test("企业管控不再有 MCP 服务器", ...);
```

- [ ] **Step 2–4:** Run: `cd xiongbao/app && bun test tests/settings-connections.test.tsx tests/personal-connections.test.tsx tests/app-navigation.test.tsx tests/settings-moves.test.tsx tests/settings-render-once.test.tsx`，先 FAIL 后 PASS
- [ ] **Step 5: 提交**（两次：前端；服务器字符串 `git commit -m "服务器文案：网盘与分身信息源的提示改指「设置 › 连接与技能 › 连接」"`）

### Task 22: 应用页合并与目录页、工具页、员工页

**Files:**
- Move: `git mv app/src/routes/_authed/_app/connections.$key.tsx app/src/routes/_authed/settings/connections/apps/$key.tsx`；加 ★「团队设置」节 `#team-app` = `components/manage/plugin-page.tsx` `PluginPage` 的管理员部分（N24；照个人版今天合在一页的形态，§11）
- Move: `routes/_authed/admin/plugins/$key_.tools.$tool.tsx` → `settings/connections/apps/$key_.tools.$tool.tsx`（团队版管理员画工具页，否则送回应用页，U06）；`admin/plugins/$key_.bots.$agentId.tsx` → `.../$key_.bots.$agentId.tsx`（同上，U07）；`_app/connections.browse.composio.tsx`、`admin/plugins/composio.tsx` 合成 `settings/connections/apps/browse.composio.tsx`；arcade 同（N27、Q07）
- Delete: `routes/_authed/admin/plugins/$key.tsx`、`admin/plugins/arcade.tsx`、`admin/plugins/composio.tsx`、`_app/connections.$key_.tools.$tool.tsx`、`_app/connections.$key_.bots.$agentId.tsx`、`_app/connections.browse.*.tsx`、`routes/_authed/settings/_personal/plugins.$.tsx`（U16 改由 `settings/$.tsx` 接住）、`_app/capabilities.plugins.tsx`、X13 `components/resources/plugins-tab.tsx`（及只被它用的 `lib/plugins/market.ts`，先 `rg "plugins/market"` 确认无别处引用）
- Modify: `resource-tabs.tsx`（删「插件」格，A52）；`app/src/lib/manage-paths.ts`（`plugins / plugin / pluginTool / pluginBot / brokerDirectory` 两个版本都指 `/settings/connections/apps…`，`pluginsLabel` 两个版本都是「连接」；`personalAppsAddress` 改前缀 `/settings/connections/apps`）
- Modify: `routes/_authed/settings/connected-accounts/index.tsx`、`connected-accounts/$key.tsx` 改用 `redirectIfMoved`（M02）；删 `app/src/lib/agents/legacy-routes.ts` 末尾的 `legacyConnectedAccountsTarget`、`legacyConnectedAccountTarget` 和 `legacy-agent-routes.test.ts` 里对应用例（改由 `settings-moves.test.tsx` 的 U02、U03 锁）
- Modify: `app/src/lib/settings/moves.ts`（U02、U03、U05–U10、U12–U16；U14、U15 排在 U10 前）
- Test: `app/tests/settings-moves.test.tsx`、`app/tests/legacy-agent-routes.test.ts`、`app/tests/admin-plugin-crew-grant.test.tsx`、`app/tests/admin-brokered-row-provider.test.tsx`、`app/tests/manage-paths.test.ts`

- [ ] **Step 1: 写失败的测试**

```ts
test("U02 /settings/connected-accounts?connected=github&authorized=1&linked=x 去 /settings/connections/apps，三个参数逐个都在", ...);
test("U03 /settings/connected-accounts/notion?linked=1&action=a&connect=1 去 /settings/connections/apps/notion，带 linked、action、connect", ...);
test("U05 /connections/notion?connected=1 带全部参数", ...);
test("U10 /admin/plugins/notion?code=c&state=s 去 /settings/connections/apps/notion?code=c&state=s#team-app", ...);
test("U14 /admin/plugins/composio 去目录页，不被当成 key=composio 的应用", ...);
test("key 含编码字符（%2F、中文）且带表外参数：key 只解码一次，参数原样带上", ...); // Review Focus 2
test("成员打开 /settings/connections/apps/notion/tools/x 被送回应用页", ...);
test("应用页：你的账号、团队账号、访问权限；团队版管理员多一节「团队设置」", ...);
```

- [ ] **Step 2–4:** Run: `cd xiongbao/app && bun test tests/settings-moves.test.tsx tests/legacy-agent-routes.test.ts tests/admin-plugin-crew-grant.test.tsx tests/admin-brokered-row-provider.test.tsx tests/manage-paths.test.ts tests/settings-moves-links.test.ts`，先 FAIL 后 PASS
- [ ] **Step 5: 提交** — `git commit -m "设置整理：应用页与管理员插件页合成一页，授权回跳的参数一个不丢"`

### Task 23: 应用有效状态（话题页 + 员工「技能与应用」页）

**Files:**
- Create: `app/src/components/settings/app-status-section.tsx`（`AppStatusSection`，`#app-status`）
- Create: `app/src/components/settings/status-diagnostics.tsx`（`StatusDiagnostics`：可展开「诊断详情」，工具名、过滤原因码、请求 ID，可复制、已脱敏；只给团队版管理员和个人版）
- Create: `app/src/lib/connections/shared-use.ts`（`readSharedUse(botId): Promise<{ kind: "none" } | { kind: "identity_mismatch" } | { kind: "error"; reason: string } | { kind: "ok"; grants: … }>`：区分确实没有记录、身份不符、接口出错，§5.5）
- Modify: `app/src/routes/_authed/_app/bots.$agentId.access.tsx`（加同样的状态行，S04）
- Test: `app/tests/app-status.test.tsx`

**Interfaces:**
- Consumes: Task 18 `appStatusLine`、`connectionsQueryOptions`、员工资料里的授权、设备在线、能力开关。行标「据当前设置判断」（应用侧没有服务器统一判定，§5.5）。
- 实施者先核对 `/api/plugins/shared-use/bot/<id>` 为什么 404（§5.5 末），在 PR 说明里写结论；404 正文是 `404 Not Found`（非 JSON）时算 `error`，不算「未授予」。

- [ ] **Step 1: 写失败的测试**

```ts
test("百度网盘已连接、只授予了别的员工：写「测试-Gemini 还不能用百度网盘」，下一步「查看可用员工」或「申请管理员授权」", ...);
test("未连接 / 已授予只读 / 已授予会改动 / 需要在线设备 / 规则阻止 各一条", ...);
test("shared-use 404（正文 404 Not Found）显示「读不到」，不显示「未授予」；诊断详情里有原因", ...);
test("诊断详情只对团队版管理员和个人版可见", ...);
test("员工的技能与应用页出现同样的状态行", ...);
```

- [ ] **Step 2–4:** Run: `cd xiongbao/app && bun test tests/app-status.test.tsx tests/bot-settings-rows.test.tsx`，先 FAIL 后 PASS
- [ ] **Step 5: 提交** — `git commit -m "连接与技能：按员工写清应用能不能用、卡在哪、下一步找谁"`

### Task 24（4b）: 技能子页

**Files:**
- Move: `git mv app/src/routes/_authed/_app/capabilities.skills.tsx app/src/routes/_authed/settings/connections/skills/index.tsx`（`SkillsScreen`，`?new`、`?edit`、`?view`、`?q` 照旧），加 ★「团队的技能」`#team-skills`（`routes/_authed/admin/skills.tsx` 的内容抽成 `components/settings/team/team-skills-section.tsx`；按钮「写一个团队技能」→ `/settings/connections/skills/new`，N32）；个人版这一节叫「技能管理」（`components/manage/skills-page.tsx` 的行为照旧）
- Move: `admin/skills_.new.tsx` → `settings/connections/skills/new.tsx`；`admin/skills_.$slug.tsx` → `settings/connections/skills/$slug.tsx`（N33、L04、L05）
- Delete: `routes/_authed/settings/_personal/skills*.tsx` 三个、`routes/_authed/admin/skills*.tsx` 三个
- Modify: `resource-tabs.tsx`（删「技能」格，A53；`/capabilities` 默认页签在 Task 29 改）；`components/resources/mine-screen.tsx` 技能链接（P13）；`routes/_authed/_app/bots.index.tsx` 个人版「你的员工会什么 › 技能」（S10）；`routes/_authed/_app/skills.tsx` 改用 `redirectIfMoved`（U30），`legacySkillsTarget` 只剩 `/resources?tab=skills` 使用时改指新地址，否则删除；`manage-paths.ts` `skills / newSkill / skill`
- Modify: 连接与技能话题页加 `#skills` 一行「你写的 N 个 · 团队的 M 个」；侧栏 `LEGACY_TAIL` 删「技能」
- Modify: `app/src/lib/settings/moves.ts`（U23–U30）
- Test: `app/tests/admin-skills-pages.test.tsx`、`app/tests/admin-skill-crew-grant.test.tsx`、`app/tests/settings-moves.test.tsx`

- [ ] **Step 1: 写失败的测试**

```ts
test("U29 /capabilities/skills?edit=s1&q=x 去 /settings/connections/skills，带 edit 和 q", ...);
test("团队版管理员看到你的技能和团队的技能（已安装、上架开关、写一个团队技能）", ...);
test("个人版这一节叫技能管理", ...);
test("成员的团队技能只读", ...);
```

- [ ] **Step 2–4:** Run: `cd xiongbao/app && bun test tests/admin-skills-pages.test.tsx tests/admin-skill-crew-grant.test.tsx tests/settings-moves.test.tsx tests/legacy-agent-routes.test.ts`，先 FAIL 后 PASS
- [ ] **Step 5: 提交** — `git commit -m "设置整理：技能搬到连接与技能，你写的和团队的在同一页"`

### Task 25（4b）: 从对话中学习、已保存的登录、密钥

**Files:**
- Modify: 连接与技能话题页加 `#learning`（`LocalLearningSection` 内嵌，G01–G04）、`#logins` 一行「已保存的登录 · N 条」、`#keys`（◆「你的密钥」/ ★「团队的密钥」，一行进子页）
- Move: `git mv app/src/routes/_authed/settings/passwords.tsx app/src/routes/_authed/settings/connections/logins.tsx`（I01–I03）
- Move: `routes/_authed/admin/credentials_.new.tsx` → `settings/connections/keys/new.tsx`；新建 `settings/connections/keys/index.tsx` 渲染上游 `components/manage/credentials-page.tsx`（N02、N03、L01、L02；标题与按钮「密钥」「添加密钥」「已保存的密钥」）
- Delete: `routes/_authed/settings/learning.tsx`、`routes/_authed/settings/_personal/credentials*.tsx`、此时已空的 `routes/_authed/settings/_personal.tsx` 与 `_personal/` 目录、X11 `routes/_authed/admin/credentials.tsx`（逐行对照 fork 版，独有行为补进上游 `credentials-page.tsx`，拿不准的写进 PR 说明）
- Modify: `manage-paths.ts`（`credentialsLabel` 两个版本都是「密钥」，`credentials()`、`newCredential()` 指新地址）；侧栏 `LEGACY_TAIL` 删掉剩余各项并删除 `LEGACY_TAIL` 本身
- Modify: `app/src/lib/settings/moves.ts`（U19–U22、U31、U32）
- Test: `app/tests/settings-connections.test.tsx`、`app/tests/settings-moves.test.tsx`、`app/tests/setup-checklist-editions.test.tsx`

**Interfaces:** 新键：`learning.enabled`、`logins`（删除动作不算设置，不带键）。§10.1 部署清单四个地址（U19、U21、U51、U52）此时全部有用例。

- [ ] **Step 1: 写失败的测试**

```ts
test("U31 /settings/learning 去 /settings/connections#learning", ...);
test("U19 /admin/credentials、U21 /settings/credentials 都去 /settings/connections/keys（部署清单链接）", ...);
test("个人版的节叫你的密钥，团队版管理员的叫团队的密钥，成员没有", ...);
test("工作区关了密码保存时，已保存的登录子页的空态不变", ...);
test("设置侧栏只剩七个话题", ...);
```

- [ ] **Step 2–4:** Run: `cd xiongbao/app && bun test tests/settings-connections.test.tsx tests/settings-moves.test.tsx tests/setup-checklist-editions.test.tsx tests/settings-sidebar.test.ts tests/settings-names.test.ts`，先 FAIL 后 PASS（`RETIRED` 加 §5.8 的「密码」「凭据」「添加凭据」「已配置的凭据」「已保存的凭据」「全部连接」「插件市场」「发现插件」「浏览插件」「写一个技能」）
- [ ] **Step 5: 提交** — `git commit -m "设置整理：从对话中学习、已保存的登录、密钥并入连接与技能"`

### PR 4 收尾（4a、4b 各一次）

- [ ] 全量检查同 PR 1。
- [ ] 截图：4a 交 `/settings/connections`、`/settings/connections/apps`、一个应用页（三种受众）和每种应用有效状态；4b 交技能子页、登录、密钥。用户确认后推送。

---

# PR 5 主动与通知 + 团队管理 + 收尾

分支 `feat/settings-pr5-team`。依赖：PR 2、3、4 都已合并。

### Task 26: 主动与通知

**Files:**
- Modify: `app/src/routes/_authed/settings/notifications.tsx`（标题「主动与通知」，C01；`#check-ins` 加一行「各位员工的巡检」→ `/autonomous`，C05；★ `#team-check-ins`：行「主动巡检」只读「已开 / 已关」+「在 团队管理 › 权限 里改」→ `/settings/team#permissions`（N34），每日上限对话框（N35），动态（N36））
- Create: `app/src/components/settings/team/team-check-ins-section.tsx`（从 `routes/_authed/admin/proactive.tsx` 搬 `CheckInSettings` 去掉开关、`Activity`、`BotRow`、`BotDialog`、`DailyLimitDialog`）
- Delete: `app/src/routes/_authed/admin/proactive.tsx`
- Modify: `app/src/components/memory/memory-screen.tsx`（删「主动巡检」全员列表一节，P11）
- Modify: `app/src/lib/settings/moves.ts`（U53）
- Test: `app/tests/check-ins-settings.test.tsx`、`app/tests/check-ins-admin.test.tsx`、`app/tests/memory-settings.test.tsx`

**Interfaces:** 新键：`enterprise.proactiveDailyRuns`。`capability.proactive` 不在这页（它在 Task 27 的权限里，§5.4）。

- [ ] **Step 1: 写失败的测试**

```ts
test("团队的主动巡检里「主动巡检」是只读状态加链接，没有开关", ...);
test("capability.proactive 在全部话题页只出现一次，在团队管理", ...);
test("记忆与信息源不再有主动巡检全员列表", ...);
```

- [ ] **Step 2–4:** Run: `cd xiongbao/app && bun test tests/check-ins-settings.test.tsx tests/check-ins-admin.test.tsx tests/memory-settings.test.tsx tests/settings-render-once.test.tsx`，先 FAIL 后 PASS
- [ ] **Step 5: 提交** — `git commit -m "设置整理：主动与通知收进团队的主动巡检，组织开关只留在权限"`

### Task 27: 团队管理 `/settings/team`

**Files:**
- Create: `app/src/routes/_authed/settings/team/index.tsx`（`guardSubpage("team-admin", "/settings")`；节按 §5.3.7：`#people`、`#permissions`、`#sign-in`、`#identity-providers`、`#platform`、`#setup`）
- Move: `admin/people.tsx` → `settings/team/people.tsx`（N39）；`admin/platform.tsx` → `settings/team/platform.tsx`（N46，标题「平台管理」）；`admin/permissions_.describe.tsx` → `settings/team/permissions.describe.tsx`（N42）
- Modify: `routes/_authed/_app/platform.tsx`（U60 改读 `redirectIfMoved`）
- Create: `app/src/lib/settings/capability-names.ts`：
  ```ts
  export const CAPABILITY_NAMES: Record<CapabilityKey, { title: string; description: string }>;
  ```
  标题逐字取 §5.8：使用员工、员工电脑上的浏览器、员工电脑联网、员工电脑、访问本人的电脑、成员可以保存个人规则、保存登录信息、把员工加进 Slack 和 Teams、发布团队 Bot、把自己连接的应用给自己的员工、独立运行、主动巡检；描述由实施者照 `xiongbao-copy` 写（customRules 的描述点名「审批与安全 › 成员的个人规则可以放宽审批」）
- Modify: `app/src/components/admin/controls/capabilities-section.tsx`（标题和描述改读 `CAPABILITY_NAMES`，不再显示服务器 `title`；「按角色和分组覆盖」统一「按角色和用户组例外设置」）
- Create: `app/src/components/settings/team/sign-in-section.tsx`（`SignInSection`，从 `enterprise.tsx` 搬「登录」节，O02–O04）；身份提供方 `routes/_authed/admin/identity-providers.tsx` 的列表与对话框抽成 `components/settings/team/identity-providers-section.tsx` 内联（N43）
- Delete: `routes/_authed/admin/people.tsx`、`permissions.tsx`、`permissions_.describe.tsx`、`identity-providers.tsx`、`platform.tsx`
- Modify: 设置侧栏 team 话题改指 `/settings/team`
- Modify: `app/src/lib/settings/moves.ts`（U18、U54–U60）
- Test: `app/tests/team-settings.test.tsx`、`app/tests/settings-moves.test.tsx`

**Interfaces:** 新键：`capability.<12 个 id>`、`capability.overrides`、`enterprise.ssoRequired`、`identityProviders`。

- [ ] **Step 1: 写失败的测试**

```ts
test("权限里 12 个开关按 §5.8 的中文名，页面上没有 Use Bots 等英文名", ...);
test("成员打开 /settings/team 被送回 /settings；个人版也送回 /settings", ...);
test("U57 /admin/enterprise 去 /settings/team#sign-in", ...);
test("U60 /platform 去 /settings/team/platform，标题平台管理", ...);
test("部署设置一行摘要是待办数，进 /settings/setup", ...);
```

- [ ] **Step 2–4:** Run: `cd xiongbao/app && bun test tests/team-settings.test.tsx tests/settings-moves.test.tsx tests/settings-render-once.test.tsx tests/settings-single-writer.test.ts`，先 FAIL 后 PASS
- [ ] **Step 5: 提交** — `git commit -m "设置整理：团队管理收进成员、权限、登录、身份提供方、平台管理和部署设置"`

### Task 28: 解散管理后台和企业管控

**Files:**
- Delete: X05 `components/admin/controls/sign-in-section.tsx`、X08 `routes/_authed/admin/enterprise.tsx`（此时只剩能力两节 O05、O06，与权限同数据）、X09 `routes/_authed/admin/index.tsx`、X10 `components/admin/admin-sidebar.tsx`；`routes/_authed/admin/` 下其余全部子路由（应已在前面各 Task 搬空，`ls` 确认只剩 `route.tsx`、`$.tsx`）
- Modify: `routes/_authed/admin/route.tsx`（只剩 `beforeLoad: redirectIfMoved`，未命中送 `/settings/team`；删 `AdminNav`、`SidebarShell` 外壳）
- Modify: `app/src/lib/manage-paths.ts`（删 `personalAdminRedirect`、`MOVED`；`managePaths` 两个版本已无 `/admin`，收成一个 `managePaths(edition)` 里只保留确有差别的 `deploymentName`、`edition`）
- Modify: `app/src/lib/navigation.ts`（删 `admin` 项与 `id`/`to` 联合里的 `"admin"`、`"/admin"`；`RAIL_PREFIXES` 删 `/admin`；`navigationFor` 去掉 admin 分支）
- Modify: `app/src/skins/xiongbao/list-column.tsx`（删「管理」标题和行，A09）、`app/src/skins/xiongbao/me-page.tsx`（删「管理」行，A27）、`app/src/skins/xiongbao/workbench-home.tsx`（`ADMIN_TILES`：模型与套餐 → 「员工与模型」`/settings/models#team-models`，审计记录 → `/settings/approvals/audit`，平台设置 → 「平台管理」`/settings/team/platform`（A16–A18）；`useAdminSection` 改读 `useSettingsAudience`；删管理区标题，§8）、`app/src/skins/classic/` 账户菜单删「管理」（A32）、`components/bot-profile/permissions.tsx:120`（「团队权限在 设置 › 团队管理」→ `/settings/team#permissions`，S06）
- Test: `app/tests/app-navigation.test.tsx`、`app/tests/workbench-home.test.tsx`、`app/tests/workbench-me.test.tsx`、`app/tests/manage-paths.test.ts`、`app/tests/settings-moves.test.tsx`、`app/tests/navigation-rail.test.ts`

- [ ] **Step 1: 写失败的测试**

```ts
test("U18 /admin 管理员去 /settings/team；成员再被送回 /settings", ...);
test("个人版打开 /admin/people：U54 → /settings/team/people → /settings（与今天结果一样）", ...);
test("§7 表外的 /admin/whatever 送 /settings/team，不是空页", ...);
test("工作台列表、我 菜单、经典账户菜单都没有「管理」", ...);
test("首页管理磁贴：员工与模型、审计记录、平台管理，指新地址", ...);
test("NAVIGATION 里没有 admin", ...);
```

- [ ] **Step 2–4:** Run: `cd xiongbao/app && bun test tests/app-navigation.test.tsx tests/workbench-home.test.tsx tests/workbench-me.test.tsx tests/manage-paths.test.ts tests/settings-moves.test.tsx tests/navigation-rail.test.ts tests/settings-moves-links.test.ts`，先 FAIL 后 PASS（`settings-names` 的 `RETIRED` 加「管理」作为菜单项、「企业管控」「模型与套餐」「平台设置」「按角色和分组覆盖」「模型白名单」「模型提供方」）
- [ ] **Step 5: 提交** — `git commit -m "设置整理：管理后台和企业管控解散，旧地址都落到对应话题"`

### Task 29: 版本隐藏与门控矩阵补齐

**Files:**
- Modify: `app/src/lib/navigation.ts`（`navigationFor`：个人版去掉 `capabilities`，A04）、`app/src/components/app-sidebar/app-sidebar.tsx`（`MORE_SIDEBAR_ONLY` 的团队 Bot 个人版不出，A07）、`app/src/skins/xiongbao/workbench-home.tsx`（个人版不显示能力、团队 Bot 磁贴，A12、A14）
- Modify: `app/src/routes/_authed/_app/team-bots.tsx`（`beforeLoad`：个人版送 `/bots`，U63、R08）
- Modify: `app/src/routes/_authed/_app/capabilities.index.tsx`（默认 `/capabilities/knowledge`，U61、P01）、`app/src/lib/agents/legacy-routes.ts` `LEGACY_RESOURCE_TABS`（U62）
- Test: `app/tests/settings-gating.test.tsx`（补齐 §10.2 全矩阵）、`app/tests/legacy-agent-routes.test.ts`、`app/tests/personal-capabilities.test.tsx`

- [ ] **Step 1: 写失败的测试**

```ts
for (const audience of AUDIENCES) {
  test(`${audience}：侧栏、我 菜单、工作台列表、首页磁贴`, ...);
  test(`${audience}：七个话题页各有哪些节（按 §5.3 ★◆▲）`, ...);
  test(`${audience}：每个子页打开或被送回哪里`, ...);
}
test("unknown-edition 等同团队版管理员", ...);
test("个人版 /team-bots 去 /bots；/capabilities 去知识库", ...);
test("/resources?tab=models 去 /settings/models#model-library；tab=components 去界面组件", ...);
```

- [ ] **Step 2–4:** Run: `cd xiongbao/app && bun test tests/settings-gating.test.tsx tests/legacy-agent-routes.test.ts tests/personal-capabilities.test.tsx`，先 FAIL 后 PASS
- [ ] **Step 5: 提交** — `git commit -m "个人版隐藏能力和团队 Bot，门控按五种受众全部锁住"`

### PR 5 收尾

- [ ] 全量检查同 PR 1。
- [ ] 截图：`/settings/notifications`、`/settings/team` 及子页（三种受众）、工作台首页与列表栏、我 菜单、经典皮肤账户菜单。用户确认后推送。

---

# PR 6 首次交办：首页起点 + 建员工

分支 `feat/settings-pr6-first-task`。依赖：PR 3 已合并（读 readiness）。

### Task 30: 首页示例起点

**Files:**
- Create: `app/src/components/home/starter-prompts.tsx`（`StarterPrompts`）
- Create: `app/src/lib/home/starters.ts`
- Modify: `app/src/routes/_authed/_app/index.tsx`（「开始新对话」下方）
- Test: `app/tests/home-starters.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  export type Starter = { id: "attachment" | "workspace-list" | "netdisk"; label: string; draft: string };
  export const STARTERS: readonly Starter[]; // label 逐字：整理这份附件 / 在工作区生成清单 / 列出我能读取的网盘资料
  /** 推荐员工：readiness 为 ready 或 untested 的第一位，且技能或授权匹配这个示例；没有则 null */
  export function recommendBot(starter: Starter, bots: readonly { id: string; readiness: AgentReadiness; apps: readonly string[] }[]): string | null;
  /** 当前环境走得通的示例：没连网盘去掉 netdisk */
  export function availableStarters(ctx: { netdiskConnected: boolean }): Starter[];
  ```
- 草稿开头四项「员工、资料、预期产物、验收条件」（§5.7.1），草稿就是消息正文；点示例只填草稿和推荐员工，不发送。没有可派发员工时不画示例，改为一行「先给员工选一个能用的模型」→ `/settings/models#model-status`。

- [ ] **Step 1: 写失败的测试**

```ts
test("有可派发员工时显示三张示例；没连网盘不显示第三张", ...);
test("没有可派发员工：不显示示例，显示「先给员工选一个能用的模型」并链到 /settings/models#model-status", ...);
test("点「整理这份附件」：草稿开头是员工、资料、预期产物、验收条件四项，收件人是推荐员工，没有发送", ...);
```

- [ ] **Step 2–4:** Run: `cd xiongbao/app && bun test tests/home-starters.test.tsx`，先 FAIL 后 PASS
- [ ] **Step 5: 提交** — `git commit -m "首页给三张可编辑的交办起点，只显示当前走得通的"`

### Task 31: 建员工对话框

**Files:**
- Modify: `app/src/components/agents/create-agent-dialog.tsx`
- Test: `app/tests/create-agent-dialog.test.tsx`

**Interfaces:** 按 §5.7.2：模板预填角色说明（不再报「角色说明为必填项」）；名称和可见范围在最上；运行位置选项文字「自己的云端工作区」「连接的电脑」；产品规则仍是建好后选模型，所以成功页主按钮「选模型并开始对话」→ `/bots/$id/setup`，分开两行「已选模型」「运行检查」（后者 `modelStatusLine(readiness, { isAdmin, modelLabel, sourceLabel })`，读 `agentReadinessQueryOptions(newId)`）。

- [ ] **Step 1: 写失败的测试**

```ts
test("选了模板，角色说明已预填，直接提交不报必填", ...);
test("运行位置写「自己的云端工作区」「连接的电脑」", ...);
test("成功页主按钮「选模型并开始对话」，有「已选模型」和「运行检查」两行", ...);
```

- [ ] **Step 2–4:** Run: `cd xiongbao/app && bun test tests/create-agent-dialog.test.tsx tests/bot-setup.test.tsx`，先 FAIL 后 PASS
- [ ] **Step 5: 提交** — `git commit -m "建员工：模板预填角色、任务语言写运行位置、成功页给选模型的主按钮"`

### PR 6 收尾

- [ ] 全量检查同 PR 1；截图首页（有 / 无可派发员工）、建员工三步与成功页，加 §10.6 旅程 1 的关键帧。用户确认后推送。

---

# PR 7 发送区 + 工作台首页 + 状态显示

分支 `feat/settings-pr7-composer`。依赖：PR 2、3、4 已合并。

### Task 32: 发送区状态行与回到原对话

**Files:**
- Create: `app/src/components/channels/composer/status-line.tsx`（`ComposerStatusLine`）
- Modify: `app/src/components/channels/composer/composer.tsx`（输入框上方挂状态行；运行中时发送按钮旁写「本轮完成后发送」或「补充本轮」）
- Modify: `app/src/components/channels/composer/draft.ts`（`saveReturnPoint(channelId)` / `takeReturnPoint(): { channelId: string } | null`：点「去连接」「申请授权」前存，草稿和附件留在草稿里）
- Modify: `app/src/routes/_authed/settings/connections/apps/index.tsx`、`apps/$key.tsx`（顶部有返回点时显示「回到原来的对话」）
- Test: `app/tests/composer-status-line.test.tsx`、`app/src/components/channels/composer/draft.test.ts`

**Interfaces:**
- 状态行：收件员工 · 执行环境（「员工云端工作区」「已配对电脑」「仅对话」，只读，后跟「去员工设置改」→ `/bots/$id/setup`，§16.2）· 相关能力的状态点（`appStatusLine` / `modelStatusLine` 的词）。选中能力后才展开数据范围和权限。
- 「本轮完成后发送」为默认（复用 `queue.ts`）；「补充本轮」只在运行器支持时出现，补充到达当前运行才标已送达。实施者先查运行器是否支持，不支持就不画该选项，在 PR 说明里写明。

- [ ] **Step 1: 写失败的测试**

```ts
test("状态行写收件员工、执行环境（只读）和「去员工设置改」链接", ...);
test("相关应用未授予时，状态点写「<员工名>还不能用<应用>」", ...);
test("点「去连接」后，连接页顶部有「回到原来的对话」，回来后草稿和附件都在", ...);
test("运行中发送按钮旁写「本轮完成后发送」", ...);
test("390 宽时状态行折行，不出横向滚动", ...);
```

- [ ] **Step 2–4:** Run: `cd xiongbao/app && bun test tests/composer-status-line.test.tsx src/components/channels/composer/draft.test.ts src/components/channels/composer/queue.test.ts`，先 FAIL 后 PASS
- [ ] **Step 5: 提交** — `git commit -m "发送区一行写清收件员工、执行环境和相关能力，去授权后能回到原对话"`

### Task 33: 工作台首页三格

**Files:**
- Modify: `app/src/lib/workbench/today.ts`（新函数）
- Modify: `app/src/skins/xiongbao/workbench-home.tsx`（今日数据前三格「等你处理」「可验收」「正在运行」，其余保留，A10）
- Test: `app/tests/workbench-today.test.ts`、`app/tests/workbench-home.test.tsx`

**Interfaces:**
  ```ts
  /** 等你处理 = 系统审批（审批收件箱 pending）+ 员工提问（含员工确认卡，Task 13 后都在 questions）；可验收 = 已提交待验收的交付；正在运行 = 正在跑的任务 */
  export function headlineCounts(input: {
    inbox: ApprovalInboxData | undefined;
    attention: readonly { approvals: number; questions: number }[] | undefined;
    deliveries: readonly { status: string }[] | undefined;
    running: readonly unknown[] | undefined;
  }): { waiting: number | null; toAccept: number | null; running: number | null };
  ```
  读不到的来源给 null，页面画「—」（沿用今天的规则）。点开定位：审批 → `/approvals?focus=<id>`；提问和交付 → 对应会话并滚到那张卡。数字与各入口用同一批查询（处理后一起变）。

- [ ] **Step 1: 写失败的测试**

```ts
test("等你处理 = 待审批 + 员工提问；员工确认卡只算一次，不进待审批", ...);
test("前三格依次是 等你处理、可验收、正在运行", ...);
test("点等你处理里的一条审批去 /approvals?focus=<id>", ...);
```

- [ ] **Step 2–4:** Run: `cd xiongbao/app && bun test tests/workbench-today.test.ts tests/workbench-home.test.tsx`，先 FAIL 后 PASS
- [ ] **Step 5: 提交** — `git commit -m "工作台首页先摆等你处理、可验收、正在运行，点开直达那张卡"`

### Task 34: 会话里的状态词核对与补显示

**Files:**
- 先核对（不改代码）：会话和卡片里能否显示「已提交，待验收」「本轮结束，任务受阻」（含最后成功的一步）、「已批准，正在执行」；查 `app/src/skins/xiongbao/delivery-chat.tsx`、`delivery-actions.tsx`、`components/approvals/inline-approval.tsx` 与读到的事件。
- Modify: 缺哪个补哪个，只读已有事件，不改事件（§5.7.5）
- Test: `app/tests/conversation-status-words.test.tsx`

- [ ] **Step 1: 写失败的测试**（只为核对后缺的那几个写；三个都已有就写三条回归用例锁住现状）

```ts
test("交付已提交时卡片写「已提交，待验收」", ...);
test("运行结束且任务受阻时写「本轮结束，任务受阻」并列出最后成功的一步", ...);
test("审批通过后到续跑结束前写「已批准，正在执行」", ...);
```

- [ ] **Step 2–4:** Run: `cd xiongbao/app && bun test tests/conversation-status-words.test.tsx`，先 FAIL（或核对后为回归用例直接 PASS，在 PR 说明里写明哪些本来就有）后 PASS
- [ ] **Step 5: 提交** — `git commit -m "会话补齐「已提交，待验收」「本轮结束，任务受阻」的显示"`

### PR 7 收尾（含 §10.6 页面级验收）

- [ ] 全量检查同 PR 1。
- [ ] §10.6 四条旅程（新用户第一次交办、已接网盘但找错员工、正在跑时补充要求、下班前处理待办），键盘和短屏（390×844）各完成一遍；真模型、真浏览器各跑一遍，录像或截图交给用户。旅程 1 的「选员工和工作位置」按 §16.2 改为「选员工，看到它在哪儿执行」。
- [ ] 截图：发送区（有 / 无状态问题、运行中）、工作台首页，加四条旅程关键帧。用户确认后推送。

---

## 本计划自行决定的事项（供审阅）

- 员工确认卡「单独计」做成归入 `questions`（员工提问），不新增第三个计数字段：`AttentionCounts` 形状不变，「等你处理」= 待审批 + 员工提问正好对上 §5.7.4。
- §5.6 第 2 条「参数里出现命令就不画」没有做：§14 要求保留 `command` 字段（在本人电脑上运行命令前的合法确认），按命令拦会误伤；门控只看「同一动作已有待处理系统审批」（§14 问题 4）。
- 「同一个动作」落成：同一 `threadId`，且系统审批的 `action.toolCallId` 是这张卡所在助手消息里的某个工具调用。
- X11（fork 的 `/admin/credentials`）从 §9 的 PR 2 挪到 PR 4（Task 25）：PR 2 时新密钥页还不存在，U19 没有落点。
- 能力页签「模型库」「组件」随 PR 3 拿掉、「插件」「技能」随 PR 4 拿掉（§9 写在 PR 4），否则搬走后页签指向空页。
- 「我」菜单删「管理」放在 PR 5（Task 28），与管理后台一起删；PR 1 只改名和加锚点。
- 工作台「连接」导航项加 `shortcut: true`，不参与 `navigationOwns`，免得 `/settings/connections/apps` 被判给工作台入口（§5.2 要求 `/settings/*` 归「我」）。
- PR 1–4 期间设置侧栏保留一个逐 PR 变短的「过渡」分组，保证还没搬的页（学习、密码、组件展示、个人版密钥、技能、活动）有入口；PR 4b 删完。
- 模型测试结果存成 `model_registry` 上的四列（不另建表）；readiness 只有模型库条目读它，平台体验模型和部署默认模型不测、不标「未测」。
- 12 个能力开关的中文描述设计稿只给了标题，由实施者照 `xiongbao-copy` 写。
- 截图工具加 `--scale`、`--audience` 两个参数满足「deviceScaleFactor 2」和三种受众夹具。
