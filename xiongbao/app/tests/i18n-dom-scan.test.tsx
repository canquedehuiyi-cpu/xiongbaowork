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
import { Route as Approvals } from "@/routes/_authed/_app/approvals";
import { Route as Autonomous } from "@/routes/_authed/_app/autonomous";
import { Route as Bots } from "@/routes/_authed/_app/bots.index";
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
import { Route as Connections } from "@/routes/_authed/_app/connections.index";
import { Route as Pipelines } from "@/routes/_authed/_app/pipelines";
import { Route as Tasks } from "@/routes/_authed/_app/tasks";
import { Route as TeamBots } from "@/routes/_authed/_app/team-bots";
import { Route as WakerflowsNew } from "@/routes/_authed/_app/wakerflows.new";
import { Route as Workbench } from "@/routes/_authed/_app/workbench";
import { Route as AdminBoundariesNew } from "@/routes/_authed/admin/boundaries_.new";
import { Route as AdminComputers } from "@/routes/_authed/admin/computers";
import { Route as AdminCredentialsNew } from "@/routes/_authed/admin/credentials_.new";
import { Route as Admin } from "@/routes/_authed/admin/index";
import { Route as AdminPlugins } from "@/routes/_authed/admin/plugins/index";
import { Route as AdminSkillsNew } from "@/routes/_authed/admin/skills_.new";
import { Route as SettingsComputer } from "@/routes/_authed/settings/_personal/computer";
import { Route as SettingsCredentialsNew } from "@/routes/_authed/settings/_personal/credentials_.new";
import { Route as SettingsSkillsNew } from "@/routes/_authed/settings/_personal/skills_.new";
import { Route as SettingsApprovals } from "@/routes/_authed/settings/approvals";
import { Route as Settings } from "@/routes/_authed/settings/index";
import { Route as SettingsNotifications } from "@/routes/_authed/settings/notifications";
import { Route as SettingsPlans } from "@/routes/_authed/settings/plans";
import {
  type RouteReport,
  report,
  scanRoute,
} from "../../scripts/acceptance/i18n-scan";
import { SCANNED } from "./i18n-route-table";
import { settleReactWork } from "./settle-react-work";

/**
 * DoD-7：主路径路由的 DOM 扫描，纯英文文字行 = 0。
 *
 * 判据在 `scripts/acceptance/i18n-scan.ts`，这里只负责把路由画出来。画的时候有五件事值得写下来：
 *
 * 1. **每条路由是真的**。挂的是 `routes/` 下的真文件路由，用 `.update()` 重新挂到本文件的根上（和
 *    `capabilities-router.tsx` 一个办法），不是替身组件。所以扫到的是应用真会画出来的那棵树。
 * 2. **地址是应用真的会落到的那一个**。`/capabilities` 自己会 `redirect` 到 `/capabilities/plugins`，
 *    `/routines` 到 `/autonomous`；扫的是落地页，不是那个只负责跳转的壳。
 * 3. **三种状态各扫一遍**。「还在读」画的是页头、页签、按钮和骨架；「读完了」在此基础上多出空状态，以及
 *    只有拿到数据才写出来的句子（`/settings/plans` 的「N 位同事 · 每月 N 个任务」就是后者）；「请求
 *    失败」画的是 `lib/` 里那些 `fallback:` 兜底句。第三种是 2026-11-16 补的：前两种的空答案全是
 *    200，「请求失败」那一屏从来没被量过，而用户最可能截图来问的恰恰是那一屏——一轮补它，扫出六行
 *    纯英文，都出自 `lib/`（`Could not load reachability` 之类），随之把 `app/src` 里 68 条英文兜底
 *    一起翻了，并在 `chinese-ui-copy.test.ts` 立了守卫。
 * 4. **画不出来就说画不出来**。一条路渲染出的文字行少于它的下限（默认 `FLOOR`）时，这条记为「没扫到」
 *    并让测试红，而不是在零违规里安静地过。同理，渲染崩到路由错误边界、或者跳到一个没挂进这棵树的地址
 *    （屏幕上只剩库的 `Not Found`），也一律记为「没扫到」——那两种情形下的英文都不是产品文案。
 * 5. **扫哪些，由台账说了算**。`i18n-route-table.ts` 的 `SCANNED` 是唯一的名单，`i18n-route-coverage.test.ts`
 *    拿它跟 `routes/` 下的文件对账。所以「主路径」不会因为某个页面没人记得加而悄悄缩小——
 *    `server-tests.list.txt` 那种「文件存在但从不运行」的坑，在 DOM 扫描这一侧有了对应的守卫。
 *
 * 数出来的账记在 `i18n-dom-budget.json`，本文件只允许它**变小**。它现在是空数组：94 条断言、0 行纯英文，
 * 外加一条量具自检（失败态必须真的画出兜底句）。剩下的英文只在口径豁免里（品牌名 `WakerFlow` / `Waker`、
 * 缩写 `API`、键名 `Shift`、装饰字形 `N` 与 `z`），逐条列在报告末尾，可查。
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
  ["/admin/boundaries/new", AdminBoundariesNew],
  ["/admin/computers", AdminComputers],
  ["/admin/credentials/new", AdminCredentialsNew],
  ["/admin/plugins", AdminPlugins],
  ["/admin/skills/new", AdminSkillsNew],
  ["/approvals", Approvals],
  ["/autonomous", Autonomous],
  ["/bots", Bots],
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
  ["/connections", Connections],
  ["/pipelines", Pipelines],
  ["/settings", Settings],
  ["/settings/approvals", SettingsApprovals],
  ["/settings/computer", SettingsComputer],
  ["/settings/credentials/new", SettingsCredentialsNew],
  ["/settings/notifications", SettingsNotifications],
  ["/settings/plans", SettingsPlans],
  ["/settings/skills/new", SettingsSkillsNew],
  ["/tasks", Tasks],
  ["/team-bots", TeamBots],
  ["/wakerflows/new", WakerflowsNew],
  ["/workbench", Workbench],
]);

/* 扫表说扫哪些，这里就必须挂着哪些：挂少了下面画不出来，挂多了会扫一台不存在的页面。 */
const MAIN_PATH = SCANNED.map((one) => ({
  at: one.at,
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
  ["/api/plugins", '{"catalogue":[],"servers":[],"plugins":[],"total":0}'],
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
      const body = EMPTY_ANSWER.find(([key]) => key === path)?.[1] ?? "{}";
      return new Response(body, {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    },
    { preconnect: originalFetch.preconnect },
  ) as typeof fetch;
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

/** 一条路画一遍，返回它渲染出来的文字行。 */
async function linesOf(at: string, state: State): Promise<string[]> {
  if (state === "pending") answerNothing();
  else if (state === "failed") answerFailing();
  else answerEmpty();
  const route = ROUTES.get(at);
  if (!route) throw new Error(`${at} 没有登记路由文件`);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  const root = createRootRoute({ component: () => <Outlet /> });
  const router = createRouter({
    context: { queryClient: client },
    history: createMemoryHistory({ initialEntries: [at] }),
    routeTree: root.addChildren([
      (route as { update: (options: unknown) => never }).update({
        getParentRoute: () => root,
        id: at,
        path: at,
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
async function scanOne(at: string, state: State): Promise<RouteReport> {
  cleanup();
  const lines = await linesOf(at, state);
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
  return scanRoute({ at: `${at} · ${LABEL[state]}`, lines });
}

const WAS = new Map(BUDGET.map((row) => [row.at, row.english]));

describe("主路径没有纯英文文字行", () => {
  const scans: RouteReport[] = [];

  afterAll(() => {
    console.log(`\n${report(scans)}\n`);
    /*
     * 棘轮，拿**这一遍真扫出来的账**比，不重新渲染一遍。
     *
     * 双向比的，和 `brand-budget.test.ts` 一样：涨了是新增英文（失败），少了则要求把这个文件改小
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

  for (const { at, states, minLines } of MAIN_PATH) {
    for (const state of states ?? STATES) {
      test(`${at} · ${LABEL[state]}`, async () => {
        const one = await scanOne(at, state);
        scans.push(one);
        // 逐路由可下调（`Scanned.minLines`），理由写在台账那一条上。
        const floor = minLines ?? FLOOR;
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
