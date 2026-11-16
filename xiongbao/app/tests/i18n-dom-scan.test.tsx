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
import {
  type RouteReport,
  report,
  scanRoute,
} from "../../scripts/acceptance/i18n-scan";
import { Route as Approvals } from "@/routes/_authed/_app/approvals";
import { Route as CapabilitiesPlugins } from "@/routes/_authed/_app/capabilities.plugins";
import { Route as Plans } from "@/routes/_authed/settings/plans";
import { Route as Tasks } from "@/routes/_authed/_app/tasks";
import { Route as TeamBots } from "@/routes/_authed/_app/team-bots";
import { Route as Workbench } from "@/routes/_authed/_app/workbench";
import { settleReactWork } from "./settle-react-work";

/**
 * DoD-7：主路径路由的 DOM 扫描，纯英文文字行 = 0。
 *
 * 判据在 `scripts/acceptance/i18n-scan.ts`，这里只负责把路由画出来。画的时候有四件事值得写下来：
 *
 * 1. **每条路由是真的**。挂的是 `routes/` 下的真文件路由，用 `.update()` 重新挂到本文件的根上（和
 *    `capabilities-router.tsx` 一个办法），不是替身组件。所以扫到的是应用真会画出来的那棵树。
 * 2. **地址是应用真的会落到的那一个**。`/capabilities` 自己会 `redirect` 到 `/capabilities/plugins`，
 *    `/routines` 到 `/autonomous`；扫的是落地页，不是那个只负责跳转的壳。
 * 3. **两种状态各扫一遍**。「还在读」画的是页头、页签、按钮和骨架；「读完了」在此基础上多出空状态，以及
 *    只有拿到数据才写出来的句子（`/settings/plans` 的「N 位同事 · 每月 N 个任务」就是后者）。只扫一种，
 *    另一种里的英文就看不见。
 * 4. **画不出来就说画不出来**。一条路渲染出的文字行少于 `FLOOR` 行时，这条记为「没扫到」并让测试红，而不
 *    是在零违规里安静地过——`server-tests.list.txt` 那种「文件存在但从不运行」的坑，这里同样会有。
 *
 * 数出来的账记在 `i18n-dom-budget.json`，本文件只允许它**变小**。这正是 DoD-7 现在的状态：口径要的是 0，
 * 而清文案是 WP-2.5 的活；在那之前，这份账是「还剩几行、分别在哪一页」的可复现证据，也是一道不许回头的
 * 棘轮。
 */

/** 一条路由渲染出的、少于这么多文字行，就认为它没画出来。 */
const FLOOR = 10;

/** 等多久让按计时器揭示的内容出现。见 `linesOf` 末尾的说明。 */
const REVEAL_MS = 400;

/**
 * 主路径：应用外壳自己能带你去的那些页面。地址取自 `lib/navigation.ts` 的 `NAVIGATION` 与 `RAIL_PREFIXES`，
 * 取的是落地页。
 */
const MAIN_PATH: readonly { readonly at: string }[] = [
  { at: "/workbench" },
  { at: "/tasks" },
  { at: "/capabilities/plugins" },
  { at: "/approvals" },
  { at: "/team-bots" },
  { at: "/settings/plans" },
];

const ROUTES = new Map<string, unknown>([
  ["/workbench", Workbench],
  ["/tasks", Tasks],
  ["/capabilities/plugins", CapabilitiesPlugins],
  ["/approvals", Approvals],
  ["/team-bots", TeamBots],
  ["/settings/plans", Plans],
]);

/**
 * 页面读数据时的两种状态。`pending` 是永远不回答，`loaded` 是回答一个空壳。
 */
const STATES = ["pending", "loaded"] as const;
type State = (typeof STATES)[number];

const LABEL: Record<State, string> = { pending: "加载中", loaded: "读完了" };

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

/** 一条路画一遍，返回它渲染出来的文字行。 */
async function linesOf(at: string, state: State): Promise<string[]> {
  if (state === "pending") answerNothing();
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
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
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

/** 一条路由的一种状态扫一遍。 */
async function scanOne(at: string, state: State): Promise<RouteReport> {
  cleanup();
  const lines = await linesOf(at, state);
  if (lines.includes(ROUTER_FALLBACK))
    throw new Error(
      `${at} · ${LABEL[state]} 渲染崩了（错误组件顶上来），这一条没扫到`,
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
    if (scans.length !== MAIN_PATH.length * STATES.length) return;
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

  for (const { at } of MAIN_PATH) {
    for (const state of STATES) {
      test(`${at} · ${LABEL[state]}`, async () => {
        const one = await scanOne(at, state);
        scans.push(one);
        if (one.lines < FLOOR)
          throw new Error(
            `${one.at} 只画出了 ${one.lines} 行文字，少于 ${FLOOR}，这条没扫到`,
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
});
