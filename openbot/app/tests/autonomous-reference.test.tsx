import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import {
  type Automation,
  type AutomationTrigger,
  automationKeys,
} from "@/lib/automations/queries";
import {
  type AutonomousSummary,
  autonomousOverviewKey,
} from "@/lib/autonomous/queries";
import {
  autonomousSearch,
  buildEntries,
  metricsOf,
  sortEntries,
} from "@/lib/autonomous/unified";
import { responsibilityKeys } from "@/lib/responsibilities";
import { type RoutineRecord, routineKeys } from "@/lib/routines/queries";
import { Route as AutonomousRoute } from "@/routes/_authed/_app/autonomous";
import { settleReactWork } from "./settle-react-work";

/**
 * 自主工作 against the reference screenshot (docs/acceptance/qoderwake-reference/autonomous.png):
 * the subtitle, one panel of four metrics (总数 / 已启用 / 员工执行 / WakerFlow 执行), a toolbar of
 * search + four labelled filters whose sort defaults to 最近创建, the per-employee view reached from
 * a text link instead of a header switch, and a text-only empty state.
 */
let registeredHere = false;
beforeAll(() => {
  if (!("document" in globalThis)) {
    GlobalRegistrator.register();
    registeredHere = true;
  }
});
afterAll(async () => {
  if (!registeredHere) return;
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = globalThis.fetch;
const clients: QueryClient[] = [];
afterEach(async () => {
  cleanup();
  try {
    await Promise.all(clients.map((client) => client.cancelQueries()));
  } finally {
    for (const client of clients) client.clear();
    clients.length = 0;
    globalThis.fetch = originalFetch;
  }
});

const HOUR = 3_600_000;
const NOW = Date.parse("2026-11-07T02:00:00Z");
const at = (offset: number) => new Date(NOW + offset).toISOString();

const AGENT: AgentProfile = {
  id: "agent-night",
  name: "Night Librarian",
  title: "",
  roleDescription: "",
  avatarSeed: "nl",
  visibility: "private",
  endpoint: null,
  builtIn: true,
  hasAuth: false,
  modelRef: null,
  persona: null,
  hasCallbackToken: false,
  hidden: false,
  pinned: false,
  systemOwned: false,
  canManage: true,
  mine: true,
  isolated: false,
  isolationActive: false,
  isolationOffReason: null,
};

const OVERVIEW: AutonomousSummary[] = [
  {
    agentId: "agent-night",
    routines: [
      {
        id: "routine-old",
        instruction: "Archive mail",
        enabled: true,
        nextRunAt: at(HOUR),
        channelId: "c",
        lastRun: { status: "failed", at: at(-HOUR) },
      },
      {
        id: "routine-new",
        instruction: "Post standup",
        enabled: false,
        nextRunAt: at(2 * HOUR),
        channelId: "c",
        lastRun: null,
      },
    ],
    responsibilities: [
      {
        id: "goal-1",
        title: "Watch inbox",
        status: "active",
        channelId: "c",
        lastRun: { status: "running", at: at(-60_000) },
      },
    ],
    proactive: [
      {
        id: "proactive-1",
        focus: "Background research",
        enabled: true,
        intervalMinutes: 60,
        nextRunAt: at(HOUR / 2),
        lastRunAt: null,
        lastStatus: "succeeded",
      },
    ],
    lastActivityAt: null,
  },
];

const automation = (over: Partial<Automation>): Automation => ({
  id: "auto-old",
  name: "Zeta weekly report",
  target: { kind: "waker", agentId: "agent-night" },
  enabled: true,
  maxRuns: null,
  endDate: null,
  runCount: 0,
  createdAt: at(-72 * HOUR),
  ...over,
});

const AUTOMATIONS: Automation[] = [
  automation({}),
  automation({
    id: "auto-new",
    name: "Alpha deploy hook",
    target: {
      kind: "wakerflow",
      flowId: "11111111-1111-4111-8111-111111111111",
    },
    createdAt: at(-HOUR),
  }),
];

const TRIGGERS: Record<string, AutomationTrigger[]> = {
  "auto-old": [
    {
      id: "t-1",
      automationId: "auto-old",
      config: { kind: "schedule", cron: "0 9 * * 1", timezone: "UTC" },
      enabled: true,
      nextRunAt: at(3 * HOUR),
      hasSecret: false,
      lastError: null,
    },
  ],
  "auto-new": [
    {
      id: "t-2",
      automationId: "auto-new",
      config: { kind: "webhook" },
      enabled: true,
      nextRunAt: null,
      hasSecret: true,
      lastError: null,
    },
  ],
};

/** `/api/routines` answers newest-created first (`orderBy(desc(routines.createdAt))`). */
const ROUTINE_RECORDS: RoutineRecord[] = [
  {
    id: "routine-new",
    agentId: "agent-night",
    schedule: "每天 09:00",
    timezone: "UTC",
    instruction: "Post standup",
    title: null,
    channel: { id: "c", name: "c", title: "c", gone: false },
    enabled: false,
    nextRunAt: at(2 * HOUR),
    lastRun: null,
  },
  {
    id: "routine-old",
    agentId: "agent-night",
    schedule: "每天 18:00",
    timezone: "UTC",
    instruction: "Archive mail",
    title: null,
    channel: { id: "c", name: "c", title: "c", gone: false },
    enabled: true,
    nextRunAt: at(HOUR),
    lastRun: { status: "failed", at: at(-HOUR) },
  },
];

function entries() {
  return buildEntries({
    overview: OVERVIEW,
    automations: AUTOMATIONS,
    triggersOf: (id) => TRIGGERS[id],
    routines: ROUTINE_RECORDS,
    responsibilities: [],
    agentName: () => "Night Librarian",
    flowName: () => "Release flow",
    now: new Date(NOW),
  });
}

test("the four reference metrics count everything, split by who carries it out", () => {
  expect(metricsOf(entries())).toMatchObject({
    total: 6,
    enabled: 5,
    employee: 5,
    flow: 1,
    // No longer panel cells, still counted for the status filter's options.
    running: 1,
    attention: 1,
  });
});

test("最近创建 is the default sort: dated automations newest first, then a fixed fallback", () => {
  const names = sortEntries(entries()).map((entry) => entry.name);
  expect(names).toEqual([
    // Automations carry `createdAt`: newest first.
    "Alpha deploy hook",
    "Zeta weekly report",
    // Routines have no timestamp here, but `/api/routines` lists them newest-created first.
    "Post standup",
    "Archive mail",
    // Then responsibilities, then check-ins, each by name.
    "Watch inbox",
    "Background research",
  ]);
  expect(sortEntries(entries(), "created").map((entry) => entry.name)).toEqual(
    names,
  );
});

test("the address keeps 最近创建 implicit and the older sorts explicit", () => {
  expect(autonomousSearch({ sort: "created" })).toEqual({});
  expect(autonomousSearch({ sort: "next" })).toEqual({ sort: "next" });
  expect(autonomousSearch({ sort: "last" })).toEqual({ sort: "last" });
  expect(autonomousSearch({ sort: "name" })).toEqual({ sort: "name" });
});

function draw(
  options: {
    url?: string;
    overview?: AutonomousSummary[];
    automations?: Automation[];
  } = {},
) {
  globalThis.fetch = (async () => Response.json({})) as unknown as typeof fetch;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  clients.push(queryClient);
  const list = options.automations ?? AUTOMATIONS;
  queryClient.setQueryData(agentKeys.list(false), [AGENT]);
  queryClient.setQueryData(autonomousOverviewKey, options.overview ?? OVERVIEW);
  queryClient.setQueryData(automationKeys.list(), list);
  for (const entry of list)
    queryClient.setQueryData(automationKeys.detail(entry.id), {
      automation: entry,
      triggers: TRIGGERS[entry.id] ?? [],
    });
  queryClient.setQueryData(automationKeys.flows(), [
    { id: "11111111-1111-4111-8111-111111111111", name: "Release flow" },
  ]);
  queryClient.setQueryData(automationKeys.capabilities(), { wakerflow: false });
  queryClient.setQueryData(routineKeys.list(), {
    routines: options.overview ? [] : ROUTINE_RECORDS,
    sweep: { lastSweptAt: null, working: true },
  });
  queryClient.setQueryData(responsibilityKeys.all, []);
  const root = createRootRoute({ component: () => <Outlet /> });
  const router = createRouter({
    context: {},
    history: createMemoryHistory({
      initialEntries: [options.url ?? "/autonomous"],
    }),
    routeTree: root.addChildren([
      AutonomousRoute.update({
        getParentRoute: () => root,
        path: "/autonomous",
      } as never),
    ]),
  });
  const user = userEvent.setup({ document });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, user, router };
}

test("the header reads as the reference: subtitle, + 新建自动任务, and no view switch", async () => {
  const { view } = draw();
  const header = (
    await view.findByRole("heading", { name: "自主工作" })
  ).closest("header") as HTMLElement;
  expect(
    within(header).getByText(
      "通过定时、事件或 API 自动开工，并由员工或 WakerFlow 响应。",
    ),
  ).toBeTruthy();
  expect(
    within(header).getByRole("button", { name: "新建自动任务" }),
  ).toBeTruthy();
  expect(view.queryByRole("tablist", { name: "自主工作视图" })).toBeNull();
});

test("one panel, four cells: number, bold label, grey caption", async () => {
  const { view } = draw();
  await view.findByText("Alpha deploy hook");
  const panel = view.getByRole("region", { name: "自主工作概览" });
  const cells = Array.from(panel.querySelectorAll("[data-metric]"));
  expect(
    cells.map((cell) => [
      cell.getAttribute("data-value"),
      ...Array.from(cell.children).map((child) => child.textContent),
    ]),
  ).toEqual([
    ["6", "6", "自动任务总数", "全部自动任务"],
    ["5", "5", "已启用", "当前已启用的自动任务"],
    ["5", "5", "员工执行", "由员工执行的自动任务"],
    ["1", "1", "WakerFlow 执行", "由 WakerFlow 执行的自动任务"],
  ]);
});

test("the toolbar is search + 执行者 / 触发类型 / 自动任务状态 / 排序, sorted by 最近创建", async () => {
  const { view } = draw();
  await view.findByText("Alpha deploy hook");
  const search = view.getByLabelText("搜索自动任务") as HTMLInputElement;
  expect(search.placeholder).toBe("搜索任务名称...");

  const options = (label: string) =>
    Array.from((view.getByLabelText(label) as HTMLSelectElement).options).map(
      (option) => option.textContent,
    );
  expect(options("执行者")).toEqual(["全部执行者", "员工", "WakerFlow"]);
  expect(options("触发类型")).toEqual(["全部类型", "定时", "事件", "API"]);
  // 运行中 and 需要关注 left the panel; their counts ride on the status options instead.
  expect(options("自动任务状态")).toEqual([
    "全部状态",
    "已启用",
    "已停用",
    "运行中 · 1",
    "需要关注 · 1",
  ]);
  expect(options("排序")).toEqual(["最近创建", "下次运行", "最近运行", "名称"]);
  expect((view.getByLabelText("排序") as HTMLSelectElement).value).toBe(
    "created",
  );
  const rows = within(view.getByRole("list", { name: "自动任务列表" }))
    .getAllByRole("listitem")
    .filter((item) => item.hasAttribute("data-name"))
    .map((item) => item.getAttribute("data-name"));
  expect(rows.slice(0, 2)).toEqual(["Alpha deploy hook", "Zeta weekly report"]);
});

test("按员工查看 is a text link at the toolbar's end and round-trips through ?view=agents", async () => {
  const { view, user, router } = draw();
  await view.findByText("Alpha deploy hook");
  const link = view.getByRole("link", { name: "按员工查看" });
  await user.click(link);
  await waitFor(() =>
    expect(router.state.location.search).toEqual({ view: "agents" }),
  );
  expect(await view.findByRole("button", { name: "全部员工" })).toBeTruthy();
  await user.click(view.getByRole("link", { name: "返回任务列表" }));
  await waitFor(() => expect(router.state.location.search).toEqual({}));
  expect(await view.findByRole("link", { name: "按员工查看" })).toBeTruthy();
});

test("with nothing unattended the empty state is text only, with the reference's copy", async () => {
  const { view } = draw({ overview: [], automations: [] });
  const title = await view.findByText("还没有自动任务");
  const empty = title.closest("[data-empty]") as HTMLElement;
  expect(empty).toBeTruthy();
  expect(
    within(empty).getByText(
      "创建自动任务，按定时、事件或 API 自动唤起员工 / WakerFlow。",
    ),
  ).toBeTruthy();
  expect(empty.querySelector("svg")).toBeNull();
});
