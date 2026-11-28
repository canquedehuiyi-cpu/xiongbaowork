import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { readFileSync } from "node:fs";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render } from "@testing-library/react";
import { ThemeProvider } from "@/components/theme-provider";
import { CopilotProvider } from "@/lib/copilot/provider";
import { Route as Approvals } from "@/routes/_authed/_app/approvals";
import { Route as Autonomous } from "@/routes/_authed/_app/autonomous";
import { Route as Bot } from "@/routes/_authed/_app/bot";
/*
 * 第四轮加进来的：地址带参数的那 33 个文件。它们与上面那批没有区别，都是从 `routes/` 里 import 的
 * 真文件路由；区别只在挂载——`update({ path })` 传的是**带 `$` 的模板**（`/bots/$agentId`），
 * 而 `initialEntries` 传替换后的具体地址，于是 `useParams()` 有真值。见 `fillParams`。
 */
import { Route as BotAccess } from "@/routes/_authed/_app/bots.$agentId.access";
import { Route as BotActivity } from "@/routes/_authed/_app/bots.$agentId.activity";
import { Route as BotApprovals } from "@/routes/_authed/_app/bots.$agentId.approvals";
import { Route as BotDetail } from "@/routes/_authed/_app/bots.$agentId.index";
import { Route as BotMemory } from "@/routes/_authed/_app/bots.$agentId.memory";
import { Route as BotReach } from "@/routes/_authed/_app/bots.$agentId.reach";
import { Route as BotResponsibilities } from "@/routes/_authed/_app/bots.$agentId.responsibilities";
import { Route as BotRoutines } from "@/routes/_authed/_app/bots.$agentId.routines";
import { Route as BotSetup } from "@/routes/_authed/_app/bots.$agentId.setup";
import { Route as BotSharing } from "@/routes/_authed/_app/bots.$agentId.sharing";
import { Route as Bots } from "@/routes/_authed/_app/bots.index";
import { Route as Briefing } from "@/routes/_authed/_app/briefing";
import { Route as CapabilitiesComponents } from "@/routes/_authed/_app/capabilities.components";
import { Route as CapabilitiesKnowledge } from "@/routes/_authed/_app/capabilities.knowledge";
import { Route as CapabilitiesMemory } from "@/routes/_authed/_app/capabilities.memory";
import { Route as CapabilitiesMine } from "@/routes/_authed/_app/capabilities.mine";
import { Route as CapabilitiesModels } from "@/routes/_authed/_app/capabilities.models";
import { Route as CapabilitiesPlugins } from "@/routes/_authed/_app/capabilities.plugins";
import { Route as CapabilitiesProjects } from "@/routes/_authed/_app/capabilities.projects";
import { Route as CapabilitiesRoles } from "@/routes/_authed/_app/capabilities.roles";
import { Route as CapabilitiesSkills } from "@/routes/_authed/_app/capabilities.skills";
import { Route as CapabilitiesWakerflows } from "@/routes/_authed/_app/capabilities.wakerflows";
import { Route as ChannelDetail } from "@/routes/_authed/_app/channel/$channelId";
import { Route as ChannelNew } from "@/routes/_authed/_app/channel/new";
import { Route as ConnectionDetail } from "@/routes/_authed/_app/connections.$key";
import { Route as Connections } from "@/routes/_authed/_app/connections.index";
import { Route as Contacts } from "@/routes/_authed/_app/contacts";
import { Route as GroupDetail } from "@/routes/_authed/_app/group/$channelId";
import { Route as GroupNew } from "@/routes/_authed/_app/group/new";
import { Route as Pipelines } from "@/routes/_authed/_app/pipelines";
import { Route as Tasks } from "@/routes/_authed/_app/tasks";
import { Route as TaskDetail } from "@/routes/_authed/_app/tasks.$taskId";
import { Route as TeamBots } from "@/routes/_authed/_app/team-bots";
import { Route as WakerflowDetail } from "@/routes/_authed/_app/wakerflows.$flowId";
import { Route as WakerflowImport } from "@/routes/_authed/_app/wakerflows.import.$token";
import { Route as WakerflowsIndex } from "@/routes/_authed/_app/wakerflows.index";
import { Route as WakerflowsNew } from "@/routes/_authed/_app/wakerflows.new";
import { Route as Workbench } from "@/routes/_authed/_app/workbench";
import { Route as AdminApprovals } from "@/routes/_authed/admin/approvals";
import { Route as AdminApprovalsDescribe } from "@/routes/_authed/admin/approvals_.describe";
import { Route as AdminApprovalsGuidance } from "@/routes/_authed/admin/approvals_.guidance";
import { Route as AdminBoundaries } from "@/routes/_authed/admin/boundaries";
import { Route as AdminBoundaryDetail } from "@/routes/_authed/admin/boundaries_.$index";
import { Route as AdminBoundariesNew } from "@/routes/_authed/admin/boundaries_.new";
import { Route as AdminComponentDetail } from "@/routes/_authed/admin/components/$name";
import { Route as AdminComponents } from "@/routes/_authed/admin/components/index";
import { Route as AdminCredentials } from "@/routes/_authed/admin/credentials";
import { Route as AdminCredentialsNew } from "@/routes/_authed/admin/credentials_.new";
import { Route as AdminIdentityProviders } from "@/routes/_authed/admin/identity-providers";
import { Route as Admin } from "@/routes/_authed/admin/index";
import { Route as AdminPermissions } from "@/routes/_authed/admin/permissions";
import { Route as AdminPermissionsDescribe } from "@/routes/_authed/admin/permissions_.describe";
import { Route as AdminPlatform } from "@/routes/_authed/admin/platform";
import { Route as AdminPlayground } from "@/routes/_authed/admin/playground";
import { Route as AdminPluginDetail } from "@/routes/_authed/admin/plugins/$key";
import { Route as AdminPluginBots } from "@/routes/_authed/admin/plugins/$key_.bots.$agentId";
import { Route as AdminPluginTools } from "@/routes/_authed/admin/plugins/$key_.tools.$tool";
import { Route as AdminPluginsComposio } from "@/routes/_authed/admin/plugins/composio";
import { Route as AdminPlugins } from "@/routes/_authed/admin/plugins/index";
import { Route as AdminProviders } from "@/routes/_authed/admin/providers";
import { Route as AdminSkills } from "@/routes/_authed/admin/skills";
import { Route as AdminSkillDetail } from "@/routes/_authed/admin/skills_.$slug";
import { Route as AdminSkillsNew } from "@/routes/_authed/admin/skills_.new";
import { Route as SettingsCredentials } from "@/routes/_authed/settings/_personal/credentials";
import { Route as SettingsCredentialsNew } from "@/routes/_authed/settings/_personal/credentials_.new";
import { Route as SettingsSkills } from "@/routes/_authed/settings/_personal/skills";
import { Route as SettingsSkillDetail } from "@/routes/_authed/settings/_personal/skills_.$slug";
import { Route as SettingsSkillsNew } from "@/routes/_authed/settings/_personal/skills_.new";
import { Route as SettingsApprovals } from "@/routes/_authed/settings/approvals";
import { Route as GalleryDetail } from "@/routes/_authed/settings/components-gallery/$name";
import { Route as SettingsComponentsGallery } from "@/routes/_authed/settings/components-gallery/index";
import { Route as SettingsDevices } from "@/routes/_authed/settings/devices";
import { Route as Settings } from "@/routes/_authed/settings/index";
import { Route as SettingsNotifications } from "@/routes/_authed/settings/notifications";
import { Route as SettingsPasswords } from "@/routes/_authed/settings/passwords";
import { Route as SettingsPlans } from "@/routes/_authed/settings/plans";
import { Route as SignInDetail } from "@/routes/_authed/sign-in/$requestId";
import {
  type RouteReport,
  report,
  scanRoute,
} from "../../scripts/acceptance/i18n-scan";
import { addressOf, SCANNED } from "./i18n-route-table";
import { settleReactWork } from "./settle-react-work";

/**
 * DoD-7：主路径路由的 DOM 扫描，纯英文文字行 = 0。
 *
 * 判据在 `scripts/acceptance/i18n-scan.ts`，这里只负责把路由画出来。画的时候有五件事值得写下来：
 *
 * 1. **每条路由是真的**。挂的是 `routes/` 下的真文件路由，用 `.update()` 重新挂到本文件的根上（和
 *    `capabilities-router.tsx` 一个办法），不是替身组件。所以扫到的是应用真会画出来的那棵树。
 * 2. **地址是应用真的会落到的那一个**。`/capabilities` 的 index 子路由 `redirect` 到
 *    `/capabilities/plugins`（`capabilities.tsx` 自己只是个 `Outlet` 布局），`/routines` 到 `/autonomous`；
 *    扫的是落地页，不是那个只负责跳转的壳。
 * 3. **三种状态各扫一遍**。「还在读」画的是页头、页签、按钮和骨架；「读完了」在此基础上多出空状态，以及
 *    只有拿到数据才写出来的句子（`/settings/plans` 的「N 位同事 · 每月 N 个任务」就是后者）；「请求
 *    失败」画的是 `lib/` 里那些 `fallback:` 兜底句。第三种是 2026-11-16 补的：前两种的空答案全是
 *    200，「请求失败」那一屏从来没被量过，而用户最可能截图来问的恰恰是那一屏——一轮补它，扫出六行
 *    纯英文，都出自 `lib/`（`Could not load reachability` 之类），随之把 `app/src` 里 68 条英文兜底
 *    一起翻了，并在 `chinese-ui-copy.test.ts` 立了守卫。少数页面在某一态一个字都不画（`/bot`、
 *    `/channel/new` 的「还在读」连骨架都没有），台账用 `states` 排掉那一态，而不是把 0 行记成通过。
 * 4. **画不出来就说画不出来**。一条路渲染出的文字行少于它的下限（默认 `FLOOR`）时，这条记为「没扫到」
 *    并让测试红，而不是在零违规里安静地过。同理，渲染崩到路由错误边界、或者跳到一个没挂进这棵树的地址
 *    （屏幕上只剩库的 `Not Found`），也一律记为「没扫到」——那两种情形下的英文都不是产品文案。
 *    下限可以是单个数字，也可以**按状态各配一个**：后者是这一轮把 25 个天生很小的页面收进扫表的办法。
 *    共用下限只能取三态里最小的那个数，那等于「读完了」退化成两行也算过。
 * 5. **扫哪些，由台账说了算**。`i18n-route-table.ts` 的 `SCANNED` 是唯一的名单，`i18n-route-coverage.test.ts`
 *    拿它跟 `routes/` 下的文件对账。所以「主路径」不会因为某个页面没人记得加而悄悄缩小——
 *    `server-tests.list.txt` 那种「文件存在但从不运行」的坑，在 DOM 扫描这一侧有了对应的守卫。
 *
 * 数出来的账记在 `i18n-dom-budget.json`，本文件只允许它**变小**。它现在是空数组：58 条路由、173 次
 * 取样、0 行纯英文，外加一条量具自检（失败态必须真的画出兜底句）。剩下的英文只在口径豁免里（品牌名
 * `WakerFlow` / `Waker` / `XiongBao Work`、缩写 `API`、技术名词 `JavaScript`、键名 `Shift`、装饰字形
 * `N` 与 `z`），逐条列在报告末尾，可查。
 *
 * 一处取样口径：**代码编辑框里预填的源码不算文字行**（`spellCheck={false}` 的 `textarea`）。
 * `/admin/playground` 的 HTML / CSS / JS / JSON 四个模板就是这一类——十七行 `<div class="card">`、
 * `.card { font: 14px }`、`"type": "object"`，翻成中文模板就废了。这是「不该翻」，不是「还没翻」。
 * 普通备注、回答框没有这个属性，仍照常量。
 */

/** 一条路由渲染出的、少于这么多文字行，就认为它没画出来。 */
const FLOOR = 10;

/** 等多久让按计时器揭示的内容出现。见 `linesOf` 末尾的说明。 */
const REVEAL_MS = 400;

/**
 * 主路径：外壳能带你到的页面。名单在 `i18n-route-table.ts` 的 `SCANNED` 里，那里同时记着「哪个文件」，
 * 「盖到没有」由 `i18n-route-coverage.test.ts` 算账；这里只负责把它们画出来。
 */
const ROUTES = new Map<string, unknown>([
  ["/admin", Admin],
  ["/admin/approvals", AdminApprovals],
  ["/admin/approvals/describe", AdminApprovalsDescribe],
  ["/admin/approvals/guidance", AdminApprovalsGuidance],
  ["/admin/boundaries", AdminBoundaries],
  ["/admin/boundaries/new", AdminBoundariesNew],
  ["/admin/components", AdminComponents],
  ["/admin/credentials", AdminCredentials],
  ["/admin/credentials/new", AdminCredentialsNew],
  ["/admin/identity-providers", AdminIdentityProviders],
  ["/admin/permissions", AdminPermissions],
  ["/admin/permissions/describe", AdminPermissionsDescribe],
  ["/admin/playground", AdminPlayground],
  ["/admin/platform", AdminPlatform],
  ["/admin/plugins", AdminPlugins],
  ["/admin/plugins/composio", AdminPluginsComposio],
  ["/admin/providers", AdminProviders],
  ["/admin/skills", AdminSkills],
  ["/admin/skills/new", AdminSkillsNew],
  ["/approvals", Approvals],
  ["/autonomous", Autonomous],
  ["/bot", Bot],
  ["/bots", Bots],
  ["/briefing", Briefing],
  ["/capabilities/components", CapabilitiesComponents],
  ["/capabilities/knowledge", CapabilitiesKnowledge],
  ["/capabilities/memory", CapabilitiesMemory],
  ["/capabilities/mine", CapabilitiesMine],
  ["/capabilities/models", CapabilitiesModels],
  ["/capabilities/plugins", CapabilitiesPlugins],
  ["/capabilities/projects", CapabilitiesProjects],
  ["/capabilities/roles", CapabilitiesRoles],
  ["/capabilities/skills", CapabilitiesSkills],
  ["/capabilities/wakerflows", CapabilitiesWakerflows],
  ["/channel/new", ChannelNew],
  ["/connections", Connections],
  ["/contacts", Contacts],
  ["/group/new", GroupNew],
  ["/pipelines", Pipelines],
  ["/settings", Settings],
  ["/settings/approvals", SettingsApprovals],
  ["/settings/components-gallery", SettingsComponentsGallery],
  ["/settings/credentials", SettingsCredentials],
  ["/settings/credentials/new", SettingsCredentialsNew],
  ["/settings/devices", SettingsDevices],
  ["/settings/notifications", SettingsNotifications],
  ["/settings/passwords", SettingsPasswords],
  ["/settings/plans", SettingsPlans],
  ["/settings/skills", SettingsSkills],
  ["/settings/skills/new", SettingsSkillsNew],
  ["/tasks", Tasks],
  ["/team-bots", TeamBots],
  ["/wakerflows", WakerflowsIndex],
  ["/wakerflows/new", WakerflowsNew],
  ["/workbench", Workbench],
  /*
   * 参数路由：key 是**地址模板**，与 `SCANNED.at` 同一串。挂载时 `path` 就传它，
   * 所以 TanStack 拿 `/bots/$agentId` 去配 `/bots/agt-scan`，`useParams()` 拿到 `{ agentId }`。
   */
  ["/bots/$agentId", BotDetail],
  ["/bots/$agentId/access", BotAccess],
  ["/bots/$agentId/activity", BotActivity],
  ["/bots/$agentId/approvals", BotApprovals],
  ["/bots/$agentId/memory", BotMemory],
  ["/bots/$agentId/reach", BotReach],
  ["/bots/$agentId/responsibilities", BotResponsibilities],
  ["/bots/$agentId/routines", BotRoutines],
  ["/bots/$agentId/setup", BotSetup],
  ["/bots/$agentId/sharing", BotSharing],
  ["/channel/$channelId", ChannelDetail],
  ["/connections/$key", ConnectionDetail],
  ["/group/$channelId", GroupDetail],
  ["/tasks/$taskId", TaskDetail],
  ["/wakerflows/$flowId", WakerflowDetail],
  ["/wakerflows/import/$token", WakerflowImport],
  ["/admin/boundaries/$index", AdminBoundaryDetail],
  ["/admin/components/$name", AdminComponentDetail],
  ["/admin/plugins/$key", AdminPluginDetail],
  ["/admin/plugins/$key/bots/$agentId", AdminPluginBots],
  ["/admin/plugins/$key/tools/$tool", AdminPluginTools],
  ["/admin/skills/$slug", AdminSkillDetail],
  ["/settings/skills/$slug", SettingsSkillDetail],
  ["/settings/components-gallery/$name", GalleryDetail],
  ["/sign-in/$requestId", SignInDetail],
]);

/* 扫表说扫哪些，这里就必须挂着哪些：挂少了下面画不出来，挂多了会扫一台不存在的页面。 */
const MAIN_PATH = SCANNED.map((one) => ({
  at: one.at,
  file: one.file,
  params: one.params,
  states: one.states,
  minLines: one.minLines,
}));

/*
 * 两个方向都要钉住。少挂一条，`linesOf` 会抛「没有登记路由文件」，能看见；反过来多挂一条却没人管——
 * 那是一条登记了路由、扫表里却没有的地址，永远扫不到，而且不报错。这里一次说清。
 */
if (ROUTES.size !== SCANNED.length)
  throw new Error(
    `ROUTES 有 ${ROUTES.size} 条，扫表有 ${SCANNED.length} 条，两边对不上`,
  );
for (const one of SCANNED)
  if (!ROUTES.has(one.at)) throw new Error(`扫表里的 ${one.at} 没有挂路由文件`);

/**
 * 页面读数据时的三种状态。
 *
 * `pending` 是永远不回答（页面停在加载中），`loaded` 是回答一个空壳（页面画出空状态），`failed` 是
 * 服务器说「我坏了，而且一句话都没说」——屏幕上这时画的是 `lib/` 里那个 `fallback:` 句子。
 *
 * 第三种是 2026-11-16 补的，理由是前两种量不到它：空答案一律 200，于是「请求失败」那一屏从来没被
 * 扫过。而用户最可能截图来问的恰恰是那一屏。`client()` 的取值顺序是「服务端的话 → `options.fallback`
 * → 库里的 "That request failed."」，所以要量产品自己的兜底，就得让服务端**什么都不说**：500 且
 * body 不是 JSON。服务端一旦带上 `{"error":"…"}`，量到的就是服务端那句，产品兜底整个被跳过。
 */
const STATES = ["pending", "loaded", "failed"] as const;
type State = (typeof STATES)[number];

const LABEL: Record<State, string> = {
  pending: "加载中",
  loaded: "读完了",
  failed: "请求失败",
};

/** `i18n-dom-budget.json` 的一行：一个路由的一种状态，还剩几行纯英文。 */
type BudgetRow = { readonly at: string; readonly english: number };
const BUDGET: readonly BudgetRow[] = JSON.parse(
  readFileSync(new URL("./i18n-dom-budget.json", import.meta.url), "utf8"),
);

const originalFetch = globalThis.fetch;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

/**
 * 一个回答所有读的 API。
 *
 * 默认答 `{}`：查询函数大多写成 `data?.agents ?? []`，空对象正好让页面画出它的空状态。
 *
 * 少数端点不行——查询函数会去解信封里的键（`client<Row[]>("/api/tasks", "tasks")`），拿到 `undefined`
 * 之后 React Query 抛错，页面画出来的是**量具自己的句子**（`["tasks","month",…] data is undefined`），
 * 那就会被当成英文文案记进账里。这类端点在这里补一条真形状的空答案：交付一个空列表，而不是空对象。
 */
const EMPTY_ANSWER: readonly (readonly [string, string])[] = [
  // `monthTaskStatsQueryOptions`：`client<MonthTaskRow[]>("/api/tasks?period=month", "tasks")`。
  ["/api/tasks", '{"tasks":[]}'],
  // `approvalInboxOptions`：把整个 body 当 `ApprovalInboxData`，四个数组缺一个就读到 `undefined`。
  [
    "/api/approvals",
    '{"requests":[],"rules":[],"teamRules":[],"questions":[]}',
  ],
  // `accessRequestInboxQueryOptions`：body 直接就是 `AppAccessRequest[]`。
  ["/api/plugins/access-requests", "[]"],
  // `pluginsPageQueryOptions`：整页 `PluginsPage`，`marketCards` 直接 `.map` 它的 `catalogue`。
  //
  // `skills` 是第四轮补的：`/settings/skills/$slug` 与 `/admin/skills/$slug` 都用这一条查询，
  // 而且读的是 `plugins.data.skills.find(…)`——可选链挂在 `data` 上，`skills` 缺了就在 `undefined`
  // 上取 `.find`，整页崩成路由错误组件。`botsMayCallBack` / `redirectUri` 同理，都是 `PluginsPage`
  // 的必填字段。
  [
    "/api/plugins",
    '{"catalogue":[],"servers":[],"plugins":[],"skills":[],"total":0,"botsMayCallBack":false,"redirectUri":null,"teams":[]}',
  ],
  // 设备列表：`client("/api/devices", "devices")`，不解信封页面上就会写「设备加载失败：…」。
  ["/api/devices", '{"devices":[]}'],
  /*
   * 下面这一批是扩表时补的。共同点是同一个毛病：查询函数解信封、拿到 `undefined`，React Query 就把
   * 它自己的英文诊断画到屏幕上（`["agents","list",…] data is undefined`）。那不是产品文案，是量具
   * 在说话——但它会一字不差地被记进「纯英文行」，所以每一条都得给出真形状的空答案。
   */
  // `agentListQueryOptions`：`client("/api/agents", "agents")`，`?hidden=true` 走同一个 pathname。
  ["/api/agents", '{"agents":[]}'],
  // `autonomousOverviewQueryOptions`：`client<AutonomousSummary[]>("/api/agents/autonomous/all", "autonomous")`。
  ["/api/agents/autonomous/all", '{"autonomous":[]}'],
  // `wakerGroupsQueryOptions`：`client<WakerGroup[]>("/api/waker-groups", "groups")`。
  ["/api/waker-groups", '{"groups":[]}'],
  // `memoriesQueryOptions` / `memorySourcesQueryOptions`：各自解 `memories`、`sources`。
  ["/api/memory", '{"memories":[]}'],
  ["/api/memory/sources", '{"sources":[]}'],
  // `proactiveSuggestionsQueryOptions`：解 `suggestions`。
  ["/api/proactive/suggestions", '{"suggestions":[]}'],
  // `wakerflowsQueryOptions`：`client<unknown>("/api/wakerflows", "flows")`。
  ["/api/wakerflows", '{"flows":[]}'],
  /*
   * `/api/delivery` 是唯一一个「空对象会崩」的：`reaching-you.tsx` 写的是 `reach.data?.bindings.filter(…)`
   * ——可选链只挂在 `data` 上，`bindings` 缺了就在 `undefined` 上取 `.filter`，页面直接崩到路由错误边界。
   * 所以这里必须把四个键都交出来，`available` 还要是对象（有人写 `available[transport]`）。
   */
  [
    "/api/delivery",
    '{"bindings":[],"devices":[],"deliveries":[],"available":{"slack":false,"teams":false,"sms":false,"push":false}}',
  ],
  /*
   * 第二轮扩表（26 条「不足下限」进扫表）又暴露两条同类的，都只在「读完了」那一态画出来：
   * `["reviewer-guidance","saved"] data is undefined` 与 `["computers","policy"] data is undefined`。
   * 两条都是解信封拿到 `undefined`——不是因为兜底句没翻，是因为空答案的形状不对。
   *
   * 注意这两条都不能答 `{}`：`guidance` 的合法值是 `string | null`，页面上「还没有指引」是要靠
   * **明确的 null** 画出来的；`policy` 是 `{mode, deny, allow}`，`mode` 缺了页面就没法选当前模式。
   * 所以给出各自最小的真形状，而不是空对象。
   */
  // `reviewerGuidanceQueryOptions`：`client("/api/approvals/team/guidance", "guidance")`。
  ["/api/approvals/team/guidance", '{"guidance":null}'],
  // `actionPolicyQueryOptions`：`client("/api/computers/policy", "policy")`。
  [
    "/api/computers/policy",
    '{"policy":{"mode":"dry-run","deny":[],"allow":[]}}',
  ],
  /*
   * 第四轮（参数路由造假夹具）补的答案。共同点是路径里带夹具值，所以键写成带 `*` 的形状。
   *
   * `/sign-in/$requestId`：私有登录表单自己解的 body 就是 `SignInRequest`。`savedLogins` 是数组、
   * `outcome` 是 `string | null`——缺了任一个，表单在 `data.savedLogins.length` 上崩，画出来的是
   * 路由错误组件，不是这一页。`passwordManager: true` 让「使用已保存的登录」那一段有机会出现。
   */
  [
    "/api/sign-in-requests/*",
    '{"id":"req-scan","botId":"agt-scan","origin":"github.com","reason":"要拉取私有仓库的代码","status":"pending","method":null,"outcome":null,"toolCallId":null,"controlRequestId":null,"createdAt":"2026-11-16T00:00:00.000Z","expiresAt":"2026-11-17T00:00:00.000Z","resolvedAt":null,"passwordManager":true,"savedLogins":[]}',
  ],
  /*
   * `/api/channels` 是**无限查询**，而且 `select` 写的是 `data.pages.flatMap((page) => page.channels)`。
   * 空对象答下来 `page.channels` 是 `undefined`，`flatMap` 于是交出一个 `[undefined]`，下游
   * `roster.data.find((row) => row.id === channelId)` 就在 `row.id` 上崩（`lib/channels/mark-read.ts`）。
   * 必须给真的分页信封：一个空列表。
   */
  ["/api/channels", '{"channels":[],"nextCursor":null}'],
  // 单个会话：`client("/api/channels/:id", "channel")`，解信封后整页都用它。
  [
    "/api/channels/*",
    '{"channel":{"id":"chn-scan","name":"审计夹具会话","agentIds":["agt-scan"],"threadId":"thr-scan","active":true,"lastMessageAt":null}}',
  ],
  // 群组会话：`GroupConversation` 就是 body 本身，三个数组都会被 `.length` 摸一遍。
  ["/api/groups/*", '{"bots":[],"people":[],"messages":[]}'],
  /*
   * 会话页右侧的侧栏（`sidebarQueryOptions` 读 `${conversationPath(source)}/sidebar`，body 原样当
   * `ConversationSidebar`）。`environment` 必须交给它：侧栏第一行写的是
   * `data?.environment.members`——可选链只挂在 `data` 上，`environment` 缺了整页崩成错误组件。
   * `goal` 与 `context` 都按「没有」给：页面读它们的地方都是 `data?.goal?.…` 这种逐层可选链。
   */
  /*
   * 会话页的侧栏其实挂在**线程**上（`conversationPath` 对有 `threadId` 的来源返回 `/api/threads/<id>`），
   * 不是频道地址。频道那条通配加 `/sidebar` 的写法也留着：群组之外还有一种只给频道的来源，两条都写
   * 不冲突（见 `answerBody` 的「取最长」）。
   */
  [
    "/api/threads/*/sidebar",
    '{"environment":{"kind":"cloud","model":null,"members":[]},"goal":null,"context":{"lastCompaction":null},"outputs":{"items":[],"total":0}}',
  ],
  /*
   * 群组页的侧栏走的是**频道**地址（`conversationPath` 对 group 来源返回 `/api/channels/<id>`），
   * 所以这一条与线程那条都要留着：两种来源，同一个 body 形状。
   */
  [
    "/api/channels/*/sidebar",
    '{"environment":{"kind":"cloud","model":null,"members":[]},"goal":null,"context":{"lastCompaction":null},"outputs":{"items":[],"total":0}}',
  ],
  /*
   * `/api/me`：解信封 `{ user, version }`，`currentUser()` 把 `user` 摊平后交给 `AuthenticatedUser`。
   * `email` 是必填——会话页的语音通话组件写的是 `user?.email.slice(…)`，可选链只到 `user`，
   * `email` 缺了就在 `undefined.slice` 上崩。
   */
  /*
   * 这位员工的权限（`employeePermissionsOptions`，body 即 `EmployeePermissions`）。
   * `disabledToolRefs` 直接 `for (const mode of permissions.modes)`——`modes` 缺了不是空列表，是崩。
   * 会话页拿它决定浏览器自己的工具要不要藏起来，所以每条会话路由都会读。
   */
  /*
   * 这两条是 `/api/me` 给了真 user 之后才被请求的：偏好设置那条 `enabled: Boolean(userId)`，
   * 以前 `/api/me` 答空对象、`userId` 是 `undefined`，查询根本没发，所以从没暴露过「解信封拿到
   * `undefined`」这件事——React Query 会把它自己的诊断行（`["settings","preferences",…] data is
   * undefined`）画到屏幕上，然后被记成一行纯英文。
   */
  ["/api/settings/preferences", '{"preferences":{}}'],
  ["/api/settings/instructions", '{"instructions":""}'],
  /*
   * 任务卡详情（`followedCardQueryOptions`）：解信封 `task` 与 `events`。答空对象时解出 `undefined`，
   * React Query 把自己的诊断画上屏（`["tasks","card","tsk-scan"] data is undefined`），那行英文不是
   * 产品文案，但会被一字不差地记进账。
   */
  /*
   * `task` 给 `null` 而不是空对象：解信封时 `undefined` 会让 React Query 把诊断画上屏，`null` 则是
   * 一个合法的「没有这张卡」，页面走它自己的「打不开这张任务卡」分支——那是产品文案，中文，能扫。
   */
  ["/api/tasks/*", '{"task":null}'],
  ["/api/tasks/*/events", '{"events":[]}'],
  /*
   * 一条 WakerFlow（`client(at(id), "flow")`）与它的分享预览（`client(shareAt(token), "share")`）。
   * 都走「解信封给 null、让页面自己走空分支」这条路：`null` 是合法答案，页面画它自己那句中文；
   * `undefined` 不是，React Query 会把自己的诊断写上屏，而诊断是英文。
   */
  ["/api/wakerflows/*", '{"flow":null}'],
  ["/api/wakerflow-shares/*", '{"share":null}'],
  // GitHub 事件来源（`githubBindingsQueryOptions`）：连接页要按它列出已绑定的仓库。
  ["/api/responsibilities/sources/github", '{"bindings":[]}'],
  // 团队 Bot 列表：员工页的「发布到团队」那一行读 `teamBots.data.teamBots.find(…)`。
  ["/api/team-bots", '{"teamBots":[]}'],
  [
    "/api/approvals/employees/*",
    '{"botId":"agt-scan","editable":false,"ownedByAnother":false,"modes":[],"teamRules":[],"security":{"dangerousCommands":"ask","sensitivePaths":"ask","extraSensitivePaths":[],"disabledDefaultPaths":[]},"defaultSensitivePaths":[],"enforceDangerousCommands":false,"customRulesEnabled":false}',
  ],
  [
    "/api/me",
    '{"user":{"id":"usr-scan","email":"scan@example.com","name":"审计夹具","role":"user","onboarding":null},"version":null}',
  ],
  [
    "/api/groups/*/sidebar",
    '{"environment":{"kind":"cloud","model":null,"members":[]},"goal":null,"context":{"lastCompaction":null},"outputs":{"items":[],"total":0}}',
  ],
];

/** 一个永远不回答的 API。页面停在「加载中」。 */
function answerNothing(): void {
  globalThis.fetch = Object.assign(() => new Promise<Response>(() => {}), {
    preconnect: originalFetch.preconnect,
  }) as typeof fetch;
}

/** 一个回答所有读的 API，形状见上。 */
function answerEmpty(): void {
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const path = new URL(String(input), "http://localhost/").pathname;
      // 补 `EMPTY_ANSWER` 时用得着：`I18N_SCAN_LOG=1` 打出每条路由读了哪些端点。
      if (process.env.I18N_SCAN_LOG === "1") console.error(`[fetch] ${path}`);
      const body = answerBody(path);
      return new Response(body, {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    },
    { preconnect: originalFetch.preconnect },
  ) as typeof fetch;
}

/**
 * 按路径取一条假答案。先精确匹配，再按 `*` 通配；**通配取最长的那条**。
 *
 * 通配是参数路由带进来的：`/api/sign-in-requests/req-scan` 里的 `req-scan` 是夹具值，而形状与
 * `/api/sign-in-requests/<任何 id>` 一样。一种形状写一行，不在答案表里给每个夹具值各抄一份——
 * 抄两份就会有一份先过期。
 *
 * 为什么是「最长」而不是「表里靠前的第一条」：群组那条通配（`/api/groups/` 加星号）与它下面
 * 更长的「……加星号再加 `/sidebar`」都命中同一个地址，而后者才是这个地址的真形状。靠顺序决定，
 * 等于让答案表的行序变成一条隐含规则——加一行就可能悄悄改变另一条路由的答案，且失败信息完全
 * 看不出来。
 */
function answerBody(path: string): string {
  let bestKey = "";
  let bestBody: string | null = null;
  for (const [key, body] of EMPTY_ANSWER) {
    if (key === path) return body;
    const star = key.indexOf("*");
    if (star < 0) continue;
    // 假的答案表里的通配只有「开头*结尾」一种形状，所以前后缀比对就够，不必动用正则。
    const head = key.slice(0, star);
    const tail = key.slice(star + 1);
    if (!path.startsWith(head) || !path.endsWith(tail)) continue;
    if (path.length < head.length + tail.length) continue;
    if (bestBody === null || key.length > bestKey.length) {
      bestKey = key;
      bestBody = body;
    }
  }
  return bestBody ?? "{}";
}

/**
 * 一个「服务器坏了、而且什么都没说」的 API。
 *
 * 500 + 空 body（`text/plain`，不是 JSON），于是 `client()` 里 `response.json()` 解不出东西、
 * `record?.error` 是 `undefined`，屏幕上落到的就是调用点自己写的 `fallback:`。换成 `{"error":"…"}`
 * 就没有这一层可量了——那正是这第三种状态要避开的东西。
 */
function answerFailing(): void {
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const path = new URL(String(input), "http://localhost/").pathname;
      if (process.env.I18N_SCAN_LOG === "1")
        console.error(`[fetch:500] ${path}`);
      return new Response("", {
        headers: { "content-type": "text/plain" },
        status: 500,
      });
    },
    { preconnect: originalFetch.preconnect },
  ) as typeof fetch;
}

/**
 * 把 `at` 里的 `$` 占位符换成夹具值。`/bots/$agentId` + `{ agentId: "agt-scan" }` → `/bots/agt-scan`。
 *
 * 两件事值得说明：
 *
 * 1. **配置的地址是模板，进 history 的是具体地址。** 挂路由时传模板（`path: at`），因为 TanStack 要
 *    靠它认参数名；进 history 时传具体值，因为要「真的访问这一页」。两边用同一份 `at`，只有替换与
 *    不替换的差别，所以不会出现「扫的其实是另一页」。
 * 2. **缺一个键就报错，不静默补空。** 少写一个 `params` 会得到 `/bots/`——有的路由会把它当成
 *    「列表页」，于是量具安静地扫了另一页并且全绿。那种绿比红更坏，所以这里直接抛。
 *
 * splat 路由（`/settings/plugins/$`）的占位符没有名字，约定键名 `_splat`。
 */
function fillParams(
  at: string,
  params?: Readonly<Record<string, string>>,
): string {
  const splat = at.endsWith("/$") ? params?._splat : undefined;
  const head = splat === undefined ? at : `${at.slice(0, -1)}${splat}`;
  const filled = head.replace(/\$(\w+)/g, (_, name: string) => {
    const value = params?.[name];
    if (!value) throw new Error(`${at} 的 ${name} 没有夹具值`);
    return value;
  });
  if (filled.includes("$")) throw new Error(`${at} 的 splat 没有夹具值`);
  return filled;
}

/**
 * 一条路由在**真树**里的 id，从文件名机械推出来：`_authed/_app/bots.$agentId.index.tsx` →
 * `/_authed/_app/bots/$agentId/`（尾部斜杠是 TanStack 的 index 写法）。
 *
 * 为什么要单独推 id，而不是拿地址当 id：`routeTree.gen.ts` 里 id 与 path 是两件事，
 * `_authed/settings/_personal/skills_.$slug.tsx` 的 id 是 `…/skills_/$slug`、地址是
 * `/settings/skills/$slug`——多一个 `_`，因为 `skills_` 逃出了 `_personal` 布局。页面里那句
 * `useParams({ from: "/_authed/_app/connections/$key" })` 写死的是 **id**，id 错了就
 * `Invariant failed: Could not find an active match`。生成器怎么拼，这里就怎么拼。
 */
function routeIdOf(file: string): string {
  const path = `/${file.replace(/\.tsx$/, "").replace(/\./g, "/")}`;
  return path.endsWith("/index") ? path.slice(0, -"index".length) : path;
}

/** 一条路画一遍，返回它渲染出来的文字行。 */
async function linesOf(
  at: string,
  state: State,
  params?: Readonly<Record<string, string>>,
  file?: string,
): Promise<string[]> {
  if (state === "pending") answerNothing();
  else if (state === "failed") answerFailing();
  else answerEmpty();
  const route = ROUTES.get(at);
  if (!route) throw new Error(`${at} 没有登记路由文件`);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  /*
   * 伪装根 = `_authed` 那一层：真树里 `routes/_authed.tsx` 把 `<Outlet/>` 包在 `CopilotProvider` 里，
   * 会话页读运行时库的上下文（缺了外层 Provider 会直接抛错）。不包这一层，
   * 频道/群组两页在「读完了」态崩成路由错误组件——那不是产品的问题，是伪装根比真根浅了一层。
   */
  const root = createRootRoute({
    component: () => (
      <CopilotProvider>
        <Outlet />
      </CopilotProvider>
    ),
  });
  const router = createRouter({
    context: { queryClient: client },
    history: createMemoryHistory({ initialEntries: [fillParams(at, params)] }),
    routeTree: root.addChildren([
      /*
       * 参数路由要**分别**给 id 与 path，非参数路由沿用地址当两者。
       *
       * 之前的写法是 `id: at, path: at`，对不调 `useParams()` 的页面没有影响，所以五十九页一直是
       * 对的。参数路由进来才炸：页面里 `useParams({ from: "/_authed/_app/connections/$key" })`
       * 写死的是**路由 id**，而 `id: at` 给的是地址（`/connections/$key`），少了 `_authed/_app`
       * 两层布局——`Invariant failed: Could not find an active match`，三态全崩。
       *
       * `routeTree.gen.ts` 里这两件事本来就是分开的（见 `routeIdOf`），这里照抄它的做法，仍然只
       * 换父路由、不建布局链：伪装根 + 绝对 id + 干净 path 足够让页面画出内容。
       */
      (route as { update: (options: unknown) => never }).update({
        getParentRoute: () => root,
        ...(params && file
          ? { id: routeIdOf(file), path: addressOf(file) }
          : { id: at, path: at }),
      } as never),
    ]),
  });
  /*
   * `ThemeProvider` 是从真实根里搬来的：`routes/__root.tsx` 的 `RootComponent` 把 `<Outlet/>` 包在
   * `ThemeProvider` → `TooltipProvider` 里，而这里另起了一个根，那一层就没了。扩表加进 `/settings`
   * 之后才暴露出来——设置页读 `useTheme()`，没有 provider 直接抛，整页崩成路由错误边界。
   * 伪装根离真根越近，扫到的就越真的是应用会画的东西。
   */
  render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <RouterProvider router={router as never} />
      </ThemeProvider>
    </QueryClientProvider>,
  );
  /*
   * 等页面真的停下来，而不是「这一圈刚好没在取」。
   *
   * 看过一眼 `isFetching() === 0` 就返回是不够的：`/capabilities/plugins` 的某几块要等另一条查询
   * 解析完才挂上、才去取自己的东西，于是「安静」会先出现一次再被打断。那一版的账在这页上是
   * 25 到 29 行之间抖的——抖的是**扫没扫到**，不是文案，而一个偶尔少扫四行的量具给出的 0 不能算数。
   *
   * 所以要求连续 `QUIET_TURNS` 圈都安静才收工。`act` 每转一圈就把这一圈新排上的活干完，所以圈数是
   * 「还有没有活」的判据；上限只是兜底，`pending` 那种永远不回答的路由靠它停下。
   */
  const QUIET_TURNS = 4;
  let quiet = 0;
  for (let turn = 0; turn < 60 && quiet < QUIET_TURNS; turn += 1) {
    await settleReactWork();
    quiet =
      client.isFetching() === 0 && client.isMutating() === 0 ? quiet + 1 : 0;
  }
  /*
   * 再让真实时间走一段。`/capabilities/plugins` 有一块内容是**按计时器**揭示的（不是按查询），
   * `act` 转圈不会推进计时器，于是那一块有时在、有时不在：同一页的总行数在 25 与 29 之间抖。
   * 抖的是「扫没扫到」，不是文案——一个偶尔少扫四行的量具报出的 0 不能算数。所以给它一段固定
   * 可以盖住这个揭示的等待，再做最后一次 settle。
   */
  await new Promise((resolve) => setTimeout(resolve, REVEAL_MS));
  await settleReactWork();
  return textLines(document.body);
}

/** 每个文本节点是一段文字；按换行切开，去掉空白。 */
function textLines(root: Element): string[] {
  const lines: string[] = [];
  const walker = document.createTreeWalker(root, 4);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const owner = node.parentElement;
    if (!owner) continue;
    if (owner.closest("script,style")) continue;
    /*
     * 代码/命令编辑框里预填的是**用户要编辑的源码**，不是页面文案。
     *
     * `/admin/playground` 就是这一类：HTML / CSS / JS / JSON 四个模板原样画在编辑框里，
     * `<div class="card">`、`.card { font: 14px }`、`"type": "object"` 十七行全被判成纯英文。
     * 把它们翻成中文，模板就没法用了——这是一个「不该翻」的口径，不是「还没翻」的欠账。
     *
     * 判据用 `spellcheck="false"`：拼写检查对代码没有意义，写下这个属性的输入框本身就在声明
     * 「别当自然语言看」。普通备注、回答框没有这个属性，仍照常量——所以不能一刀切跳过所有
     * `textarea`，那会把真文案一起放过。
     */
    const box = owner.closest("textarea");
    if (box?.getAttribute("spellcheck") === "false") continue;
    for (const raw of (node.textContent ?? "").split("\n")) {
      const line = raw.trim();
      if (line) lines.push(line);
    }
  }
  return lines;
}

/**
 * 渲染崩了的时候，TanStack Router 会拿它自己的默认错误组件顶上，那是一句库里的英文
 * （`Something went wrong!` / `Hide Error`），不是这个应用的文案。看到它就说明这一条**没画出来**：
 * 要报错，而不是把库的字记进账里、也不是把它当成应用的缺陷。
 */
const ROUTER_FALLBACK = "Something went wrong!";

/**
 * 路由跳走了、但跳去的地址不在这个伪装树里时，TanStack 画它自己的 `Not Found`。
 *
 * 这一行特别容易被当成「一处没翻的英文」记进账里，实际它连应用的 DOM 都不是：真应用里
 * `routes/__root.tsx` 把 `notFoundComponent` 设成了 `<Navigate to="/" />`，用户根本看不到这个词。
 * 所以它和 `ROUTER_FALLBACK` 一个待遇——看到就说这一条没扫到。
 *
 * 旧地址那批路由（`/wakers`、`/resources`…）就是这样：`beforeLoad` 里 `throw redirect`，跳去的地址
 * 没挂在这棵伪装树里，于是只剩这两行。
 */
const NOT_FOUND = "Not Found";

/** 一条路由的一种状态扫一遍。 */
async function scanOne(
  at: string,
  state: State,
  params?: Readonly<Record<string, string>>,
  file?: string,
): Promise<RouteReport> {
  cleanup();
  const lines = await linesOf(at, state, params, file);
  if (lines.includes(ROUTER_FALLBACK))
    throw new Error(
      `${at} · ${LABEL[state]} 渲染崩了（错误组件顶上来），这一条没扫到`,
    );
  if (lines.includes(NOT_FOUND))
    throw new Error(
      `${at} · ${LABEL[state]} 跳到了没挂进这棵树里的地址（只剩 Not Found），这一条没扫到`,
    );
  // `I18N_SCAN_LINES=1` 打出每条路由的每一行：量具自己抖的时候，得先看清抖的是哪几行。
  if (process.env.I18N_SCAN_LINES === "1")
    console.error(`[lines] ${at} · ${LABEL[state]}\n${lines.join("\n")}`);
  return scanRoute({
    at: `${at} · ${LABEL[state]}`,
    lines,
    identifiers: params ? Object.values(params) : undefined,
  });
}

const WAS = new Map(BUDGET.map((row) => [row.at, row.english]));

describe("主路径没有纯英文文字行", () => {
  const scans: RouteReport[] = [];

  afterAll(() => {
    console.log(`\n${report(scans)}\n`);
    /*
     * 棘轮，拿**这一遍真扫出来的账**比，不重新渲染一遍。
     *
     * 双向比的：涨了是新增英文（失败），少了则要求把这个文件改小
     * （也失败），免得账本慢慢和现实脱钩、变成一句没人再读的数字。不重渲染还有个实际原因：两次渲染
     * 同一页会有细微差别（见 `linesOf` 末尾），比的对象必须是同一个。
     */
    // 一条路由可能只扫一种状态（见 `Scanned.states`），所以「全扫完了没有」要按每条自己的账算。
    const expected = MAIN_PATH.reduce(
      (sum, one) => sum + (one.states ?? STATES).length,
      0,
    );
    if (scans.length !== expected) return;
    const actual: BudgetRow[] = scans
      .filter((one) => one.violations.length > 0)
      .map((one) => ({ at: one.at, english: one.violations.length }))
      .sort((a, b) => a.at.localeCompare(b.at));
    const was: BudgetRow[] = [...BUDGET].sort((a, b) =>
      a.at.localeCompare(b.at),
    );
    const problems: string[] = [];
    for (const row of actual) {
      const before = was.find((one) => one.at === row.at)?.english ?? 0;
      if (row.english > before)
        problems.push(`${row.at}：${before} -> ${row.english}，比账本多`);
    }
    for (const row of was) {
      const now = actual.find((one) => one.at === row.at)?.english ?? 0;
      if (now < row.english)
        problems.push(`把 i18n-dom-budget.json 里 ${row.at} 改成 ${now}`);
    }
    expect(problems).toEqual([]);
  });

  for (const { at, file, params, states, minLines } of MAIN_PATH) {
    for (const state of states ?? STATES) {
      test(`${at} · ${LABEL[state]}`, async () => {
        const one = await scanOne(at, state, params, file);
        scans.push(one);
        // 逐路由可下调（`Scanned.minLines`），理由写在台账那一条上。可以按状态各配一个。
        const floor =
          typeof minLines === "number"
            ? minLines
            : (minLines?.[state] ?? FLOOR);
        if (one.lines < floor)
          throw new Error(
            `${one.at} 只画出了 ${one.lines} 行文字，少于 ${floor}，这条没扫到`,
          );
        // 不许比账本多一行。账本是 0 的那一页，就是一行都不许有。
        const before = WAS.get(one.at) ?? 0;
        expect(
          one.violations.length <= before
            ? []
            : one.violations.map((f) => f.line),
        ).toEqual([]);
      });
    }
  }

  /**
   * 量具自检：`failed` 那一路真的画出了兜底句，而不是又画了一遍空状态。
   *
   * 上面 94 条断言的绿，只有在「请求失败」确实被量到时才算数。而这条最容易被掏空：`answerFailing()`
   * 改成返回 200、或者服务端改成带 `{"error":"…"}` 的 500，页面就照常画空状态或画服务端那句，兜底句
   * 永远不出现——94 条全绿，第三种状态名存实亡。所以钉一条：`/settings/plans` 失败时屏幕上必须有它
   * 自己的兜底句。钉的是「兜底句能不能被看见」，不是这句话的措辞好坏。
   */
  test("量具自检：失败态画的是兜底句，不是空状态", async () => {
    cleanup();
    const lines = await linesOf("/settings/plans", "failed");
    expect(lines).toContain("读不到你的套餐与用量。");
  });
});
