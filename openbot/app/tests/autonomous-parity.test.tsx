import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
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
import { responsibilityKeys } from "@/lib/responsibilities";
import { routineKeys } from "@/lib/routines/queries";
import { Route as AutonomousRoute } from "@/routes/_authed/_app/autonomous";
import { settleReactWork } from "./settle-react-work";

/**
 * Parity plan, 自主工作 (`/autonomous-work` in the reference): the header's primary action, the one
 * panel of four metrics, the toolbar's search and 执行者 / 触发类型 / 自动任务状态 / 排序 (mirrored into the
 * URL), one list over every kind of unattended work, and its switches writing through the existing
 * endpoints. Reads are seeded; what is asserted is what the page computes and what it writes.
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
const drawnClients: QueryClient[] = [];
const calls: { method: string; path: string; body: unknown }[] = [];
const writes = () => calls.filter((entry) => entry.method !== "GET");

afterEach(async () => {
  cleanup();
  try {
    await Promise.all(drawnClients.map((client) => client.cancelQueries()));
  } finally {
    for (const client of drawnClients) client.clear();
    drawnClients.length = 0;
    calls.length = 0;
    globalThis.fetch = originalFetch;
  }
});

/** Every request is recorded; writes answer `ok`, and reads answer whatever the case asks. */
function serve(read: (path: string) => Response = readFixtures) {
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const method = init?.method ?? "GET";
    const path = String(input);
    calls.push({
      method,
      path,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (method === "GET") return read(path);
    return Response.json({ ok: true });
  }) as typeof fetch;
}

/** Reads after a write answer the fixtures again, in the shape each endpoint sends. */
function readFixtures(path: string): Response {
  if (path === "/api/agents/autonomous/all")
    return Response.json({ autonomous: OVERVIEW });
  if (path.startsWith("/api/agents/") && path.endsWith("/autonomous"))
    return Response.json({ autonomous: OVERVIEW[0] });
  if (path === "/api/automations")
    return Response.json({ automations: AUTOMATIONS });
  if (path === "/api/responsibilities")
    return Response.json({ responsibilities: [] });
  return Response.json({});
}

const agent = (over: Partial<AgentProfile>): AgentProfile => ({
  id: "agent-night",
  name: "Night Librarian",
  title: "Watches the stacks",
  roleDescription: "Summarises arrivals.",
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
  ...over,
});

const AGENTS = [
  agent({}),
  agent({ id: "agent-day", name: "Day Clerk", avatarSeed: "dc" }),
];

const HOUR = 3_600_000;
const at = (offset: number) => new Date(Date.now() + offset).toISOString();

const OVERVIEW: AutonomousSummary[] = [
  {
    agentId: "agent-night",
    routines: [
      {
        id: "routine-1",
        instruction: "Summarise arrivals",
        enabled: true,
        nextRunAt: at(HOUR),
        channelId: "channel-1",
        lastRun: { status: "succeeded", at: at(-24 * HOUR) },
      },
    ],
    responsibilities: [
      {
        id: "goal-1",
        title: "Watch finance inbox",
        status: "active",
        channelId: "channel-1",
        lastRun: { status: "running", at: at(-600_000) },
      },
    ],
    proactive: [
      {
        id: "proactive-1",
        focus: "Unfinished work",
        enabled: false,
        intervalMinutes: 240,
        nextRunAt: at(HOUR / 2),
        lastRunAt: at(-2 * HOUR),
        lastStatus: "failed",
      },
    ],
    lastActivityAt: at(-600_000),
  },
  {
    agentId: "agent-day",
    routines: [
      {
        id: "routine-2",
        instruction: "Post standup",
        enabled: false,
        nextRunAt: at(2 * HOUR),
        channelId: "channel-2",
        lastRun: { status: "failed", at: at(-3 * HOUR) },
      },
    ],
    responsibilities: [],
    proactive: [],
    lastActivityAt: at(-3 * HOUR),
  },
];

const automation = (over: Partial<Automation>): Automation => ({
  id: "auto-1",
  name: "Weekly report",
  target: { kind: "waker", agentId: "agent-day" },
  enabled: true,
  maxRuns: null,
  endDate: null,
  runCount: 2,
  createdAt: at(-48 * HOUR),
  ...over,
});

const AUTOMATIONS = [
  automation({}),
  automation({
    id: "auto-2",
    name: "Deploy hook",
    target: {
      kind: "wakerflow",
      flowId: "11111111-1111-4111-8111-111111111111",
    },
  }),
];

const TRIGGERS: Record<string, AutomationTrigger[]> = {
  "auto-1": [
    {
      id: "trigger-1",
      automationId: "auto-1",
      config: {
        kind: "schedule",
        cron: "0 9 * * 1",
        timezone: "Asia/Shanghai",
      },
      enabled: true,
      nextRunAt: at(3 * HOUR),
      hasSecret: false,
      lastError: null,
    },
  ],
  "auto-2": [
    {
      id: "trigger-2",
      automationId: "auto-2",
      config: { kind: "webhook" },
      enabled: true,
      nextRunAt: null,
      hasSecret: true,
      lastError: null,
    },
  ],
};

function draw(
  options: {
    url?: string;
    overview?: AutonomousSummary[];
    automations?: Automation[];
    /** Leave the automation list unread, so the page asks the server for it. */
    unreadAutomations?: boolean;
    /** Pre-fill each automation's detail; off to see what the page reads by itself. */
    seedDetails?: boolean;
  } = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  drawnClients.push(queryClient);
  const automations = options.automations ?? AUTOMATIONS;
  queryClient.setQueryData(agentKeys.list(false), AGENTS);
  queryClient.setQueryData(autonomousOverviewKey, options.overview ?? OVERVIEW);
  if (!options.unreadAutomations)
    queryClient.setQueryData(automationKeys.list(), automations);
  for (const entry of options.seedDetails === false ? [] : automations) {
    queryClient.setQueryData(automationKeys.detail(entry.id), {
      automation: entry,
      triggers: TRIGGERS[entry.id] ?? [],
    });
  }
  queryClient.setQueryData(automationKeys.flows(), [
    {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Release flow",
      inputs: [],
    },
  ]);
  queryClient.setQueryData(automationKeys.capabilities(), { wakerflow: false });
  queryClient.setQueryData(routineKeys.list(), {
    routines: [
      {
        id: "routine-1",
        agentId: "agent-night",
        schedule: "每天 09:00",
        timezone: "Asia/Shanghai",
        instruction: "Summarise arrivals",
        channel: { id: "channel-1", name: "Night", gone: false },
        enabled: true,
        nextRunAt: at(HOUR),
        lastRun: null,
      },
    ],
    sweep: { lastSweptAt: null, working: true },
  });
  queryClient.setQueryData(responsibilityKeys.all, [
    {
      id: "goal-1",
      agentId: "agent-night",
      channelId: "channel-1",
      threadId: "thread-1",
      title: "Watch finance inbox",
      instruction: "",
      successCriteria: "",
      status: "active",
      progress: "",
      lastResult: null,
      subscriptions: [{ source: "github", eventType: "issues.opened" }],
      updatedAt: at(-HOUR),
    },
  ]);
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
      createRoute({
        getParentRoute: () => root,
        path: "/responsibilities",
        component: () => null,
      } as never),
      createRoute({
        getParentRoute: () => root,
        path: "/resources",
        component: () => null,
      } as never),
    ]),
  });
  const user = userEvent.setup({ document });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, user, router, queryClient };
}

/** The names of the listed automations, top to bottom. */
const listed = (view: ReturnType<typeof draw>["view"]) =>
  within(view.getByRole("list", { name: "自动任务列表" }))
    .getAllByRole("listitem")
    // The rows only: each row's trigger chips are list items of their own list.
    .filter((item) => item.hasAttribute("data-name"))
    .map((item) => item.getAttribute("data-name"));

const metric = (view: ReturnType<typeof draw>["view"], label: string) =>
  within(view.getByRole("region", { name: "自主工作概览" }))
    .getByText(label)
    .closest("[data-metric]")
    ?.getAttribute("data-value");

test("the header carries the title and the primary 新建自动任务 action, which opens the creation flow", async () => {
  serve();
  const { view, user } = draw();

  const header = (
    await view.findByRole("heading", { name: "自主工作" })
  ).closest("header") as HTMLElement;
  const action = within(header).getByRole("button", { name: "新建自动任务" });
  expect(action.getAttribute("aria-expanded")).toBe("false");
  await user.click(action);
  expect(action.getAttribute("aria-expanded")).toBe("true");
  expect(view.getByRole("form", { name: "新建自动任务" })).toBeTruthy();

  // API preselects the Hook / API trigger of the existing automation form.
  await user.click(view.getByRole("tab", { name: "API" }));
  const kind = view.getByLabelText("触发方式 1") as HTMLSelectElement;
  expect(kind.value).toBe("webhook");

  // 事件 has no automation trigger kind: the flow says so and points at 长期职责.
  await user.click(view.getByRole("tab", { name: "事件" }));
  expect(view.queryByRole("form", { name: "新建自动任务" })).toBeNull();
  expect(view.getByText(/自动任务暂不支持按内部事件触发/)).toBeTruthy();
  expect(
    view.getByRole("link", { name: "去长期职责新建" }).getAttribute("href"),
  ).toBe("/responsibilities");
});

test("the four metrics are computed from every kind of unattended work", async () => {
  serve();
  const { view } = draw();

  await view.findByText("Summarise arrivals");
  expect(metric(view, "自动任务总数")).toBe("6");
  expect(metric(view, "已启用")).toBe("4");
  expect(metric(view, "员工执行")).toBe("5");
  expect(metric(view, "WakerFlow 执行")).toBe("1");
  // 运行中 and 需要关注 left the panel (the reference has neither); the status filter counts them.
  const status = view.getByLabelText("自动任务状态") as HTMLSelectElement;
  expect(
    Array.from(status.options).map((option) => option.textContent),
  ).toContain("运行中 · 1");
  expect(
    Array.from(status.options).map((option) => option.textContent),
  ).toContain("需要关注 · 2");
});

test("each row names its executor and its trigger with the detail", async () => {
  serve();
  const { view } = draw();

  const row = (name: string) =>
    view.getByRole("listitem", { name }) as HTMLElement;
  await view.findByText("Weekly report");
  expect(
    within(row("Weekly report")).getByText(/员工 · Day Clerk/),
  ).toBeTruthy();
  expect(within(row("Weekly report")).getByText(/0 9 \* \* 1/)).toBeTruthy();
  expect(
    within(row("Deploy hook")).getByText(/Flow · Release flow/),
  ).toBeTruthy();
  expect(within(row("Deploy hook")).getByText(/Hook \/ API/)).toBeTruthy();
  expect(
    within(row("Summarise arrivals")).getByText(/每天 09:00/),
  ).toBeTruthy();
  expect(
    within(row("Watch finance inbox")).getByText(/GitHub · issues\.opened/),
  ).toBeTruthy();
  expect(
    within(row("Unfinished work")).getByText(/每隔 240 分钟/),
  ).toBeTruthy();
  // Background research is edited in 能力与资源 › 信息源与记忆, which `/memory` was archived into.
  expect(
    within(row("Unfinished work"))
      .getByRole("link", { name: "编辑" })
      .getAttribute("href"),
  ).toBe("/resources?tab=sources");
});

test("executor, trigger type and status narrow the list, and each is written into the URL", async () => {
  serve();
  const { view, router } = draw();
  await view.findByText("Weekly report");

  fireEvent.change(view.getByLabelText("执行者"), {
    target: { value: "flow" },
  });
  await waitFor(() => expect(listed(view)).toEqual(["Deploy hook"]));
  expect(router.state.location.search).toMatchObject({ executor: "flow" });

  fireEvent.change(view.getByLabelText("执行者"), { target: { value: "" } });
  fireEvent.change(view.getByLabelText("触发类型"), {
    target: { value: "event" },
  });
  await waitFor(() =>
    expect(listed(view)?.sort()).toEqual([
      "Deploy hook",
      "Watch finance inbox",
    ]),
  );
  expect(router.state.location.search).toMatchObject({ trigger: "event" });
  expect(router.state.location.search).not.toHaveProperty("executor");

  fireEvent.change(view.getByLabelText("触发类型"), {
    target: { value: "schedule" },
  });
  fireEvent.change(view.getByLabelText("自动任务状态"), {
    target: { value: "paused" },
  });
  await waitFor(() =>
    expect(listed(view)?.sort()).toEqual(["Post standup", "Unfinished work"]),
  );
  expect(router.state.location.search).toMatchObject({
    trigger: "schedule",
    status: "paused",
  });

  fireEvent.change(view.getByLabelText("搜索自动任务"), {
    target: { value: "standup" },
  });
  await waitFor(() => expect(listed(view)).toEqual(["Post standup"]));
  expect(router.state.location.search).toMatchObject({ q: "standup" });

  fireEvent.change(view.getByLabelText("搜索自动任务"), {
    target: { value: "nothing like this" },
  });
  expect(await view.findByText("没有符合条件的自动任务。")).toBeTruthy();
  await userEvent.click(view.getByRole("button", { name: "清除筛选" }));
  await waitFor(() => expect(listed(view)).toHaveLength(6));
  expect(router.state.location.search).toEqual({});
});

test("a deep link restores the filters it carries", async () => {
  serve();
  const { view } = draw({ url: "/autonomous?trigger=api&sort=name" });

  await waitFor(() => expect(listed(view)).toEqual(["Deploy hook"]));
  expect((view.getByLabelText("触发类型") as HTMLSelectElement).value).toBe(
    "api",
  );
  expect((view.getByLabelText("排序") as HTMLSelectElement).value).toBe("name");
});

test("sorting orders by next run, last run or name", async () => {
  serve();
  const { view, router } = draw();
  await view.findByText("Weekly report");

  // 下次运行 (no longer the default — 最近创建 is): the next firing first; nothing scheduled
  // (paused, event-driven) after, by name.
  fireEvent.change(view.getByLabelText("排序"), { target: { value: "next" } });
  await waitFor(() =>
    expect(router.state.location.search).toMatchObject({ sort: "next" }),
  );
  expect(listed(view)).toEqual([
    "Summarise arrivals",
    "Weekly report",
    "Deploy hook",
    "Post standup",
    "Unfinished work",
    "Watch finance inbox",
  ]);

  fireEvent.change(view.getByLabelText("排序"), { target: { value: "last" } });
  await waitFor(() =>
    expect(listed(view)).toEqual([
      "Watch finance inbox",
      "Unfinished work",
      "Post standup",
      "Summarise arrivals",
      "Deploy hook",
      "Weekly report",
    ]),
  );
  expect(router.state.location.search).toMatchObject({ sort: "last" });

  fireEvent.change(view.getByLabelText("排序"), { target: { value: "name" } });
  await waitFor(() =>
    expect(listed(view)).toEqual([
      "Deploy hook",
      "Post standup",
      "Summarise arrivals",
      "Unfinished work",
      "Watch finance inbox",
      "Weekly report",
    ]),
  );
});

test("a row's switch writes through that kind's existing endpoint", async () => {
  serve();
  const { view, user } = draw();

  await user.click(
    await view.findByRole("switch", { name: "启停：Summarise arrivals" }),
  );
  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(writes()[0]).toEqual({
    method: "PUT",
    path: "/api/routines/routine-1/enabled",
    body: { enabled: false },
  });

  await user.click(view.getByRole("switch", { name: "启停：Weekly report" }));
  await waitFor(() => expect(writes()).toHaveLength(2));
  expect(writes()[1]).toEqual({
    method: "PUT",
    path: "/api/automations/auto-1/enabled",
    body: { enabled: false },
  });

  await user.click(
    view.getByRole("switch", { name: "启停：Watch finance inbox" }),
  );
  await waitFor(() => expect(writes()).toHaveLength(3));
  expect(writes()[2]?.path).toBe("/api/responsibilities/goal-1/pause");
  await settleReactWork();
});

test("editing an automation patches its name, cap and end date through the management API", async () => {
  serve();
  const { view, user } = draw();
  const row = (await view.findByRole("listitem", {
    name: "Weekly report",
  })) as HTMLElement;

  await user.click(within(row).getByRole("button", { name: "编辑" }));
  const form = view.getByRole("form", { name: "编辑自动任务：Weekly report" });
  const name = within(form).getByLabelText("名称") as HTMLInputElement;
  await user.clear(name);
  await user.type(name, "Monday report");
  await user.type(within(form).getByLabelText("最大运行次数"), "10");
  await user.click(within(form).getByRole("button", { name: "保存" }));

  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(writes()[0]).toEqual({
    method: "PATCH",
    path: "/api/automations/auto-1",
    // The end date nobody touched is not sent, so an expired one cannot refuse a rename.
    body: { name: "Monday report", maxRuns: 10 },
  });

  // A routine has no edit contract: the action is there, disabled, with the reason.
  const routine = view.getByRole("listitem", {
    name: "Summarise arrivals",
  }) as HTMLElement;
  const edit = within(routine).getByRole("button", { name: "编辑" });
  expect(edit.hasAttribute("disabled")).toBe(true);
  expect(edit.getAttribute("title")).toContain("对话");
});

test("details open under the row and keep the existing run-now action reachable", async () => {
  serve();
  const { view, user, router } = draw();
  const row = (await view.findByRole("listitem", {
    name: "Summarise arrivals",
  })) as HTMLElement;

  await user.click(within(row).getByRole("button", { name: /^详情/ }));
  expect(within(row).getByRole("button", { name: "立即运行" })).toBeTruthy();
  expect(router.state.location.search).toMatchObject({
    detail: "routine:routine-1",
  });
});

test("with nothing unattended anywhere the page says so, and the metrics read zero", async () => {
  serve();
  const { view } = draw({ overview: [], automations: [] });

  expect(await view.findByText(/还没有自动任务/)).toBeTruthy();
  expect(metric(view, "自动任务总数")).toBe("0");
  expect(metric(view, "WakerFlow 执行")).toBe("0");
  expect(view.queryByRole("list", { name: "自动任务列表" })).toBeNull();
});

test("the per-employee view stays one link away, in the URL", async () => {
  serve();
  const { view, user, router } = draw();
  await view.findByText("Weekly report");

  await user.click(view.getByRole("link", { name: "按员工查看" }));
  expect(router.state.location.search).toMatchObject({ view: "agents" });
  expect(await view.findByRole("button", { name: "全部员工" })).toBeTruthy();
});

test("a failed automation read says so with a retry, and the other rows stay", async () => {
  let failing = true;
  serve((path) =>
    path === "/api/automations"
      ? failing
        ? Response.json({ error: "服务暂时不可用" }, { status: 500 })
        : Response.json({ automations: AUTOMATIONS })
      : readFixtures(path),
  );
  const { view, user } = draw({ unreadAutomations: true });

  const alert = await view.findByRole("alert");
  expect(alert.textContent).toContain("自动任务加载失败");
  expect(view.getByText("Summarise arrivals")).toBeTruthy();
  expect(view.queryByText(/还没有自动任务/)).toBeNull();

  failing = false;
  await user.click(within(alert).getByRole("button", { name: "重试" }));
  expect(await view.findByText("Weekly report")).toBeTruthy();
  await waitFor(() => expect(view.queryByRole("alert")).toBeNull());
});

/*
 * Request volume (deferred review finding, PR #296). The list endpoint carries no triggers, so the
 * unified list reads each automation's detail once. It must not then poll every detail every five
 * minutes, nor poll 长期职责 every ten seconds the way the /responsibilities page does: a detail is
 * read again only when the list shows that automation changed.
 */
test("the unified list reads automation details without polling them, and responsibilities slowly", async () => {
  serve();
  const { view, queryClient } = draw();
  await view.findByRole("heading", { level: 1, name: "自主工作" });
  for (const automation of AUTOMATIONS) {
    const query = queryClient
      .getQueryCache()
      .find({ queryKey: automationKeys.detail(automation.id) });
    const intervals = query?.observers.map(
      (observer) => observer.options.refetchInterval,
    );
    expect(intervals?.length).toBeGreaterThan(0);
    expect(intervals?.every((interval) => interval === false)).toBe(true);
  }
  const duties = queryClient
    .getQueryCache()
    .find({ queryKey: responsibilityKeys.all });
  expect(
    duties?.observers.map((observer) => observer.options.refetchInterval),
  ).toEqual([60_000]);
});

test("an automation's detail is read again when the list shows it ran, and only that one", async () => {
  serve();
  const { view, queryClient } = draw();
  await view.findByRole("heading", { level: 1, name: "自主工作" });
  const [first, second] = AUTOMATIONS;
  if (!first || !second) throw new Error("fixture needs two automations");
  calls.length = 0;
  act(() => {
    queryClient.setQueryData(
      automationKeys.list(),
      AUTOMATIONS.map((entry) =>
        entry.id === first.id
          ? { ...entry, runCount: entry.runCount + 1 }
          : entry,
      ),
    );
  });
  await waitFor(() =>
    expect(calls.map((call) => call.path)).toContain(
      `/api/automations/${first.id}`,
    ),
  );
  expect(calls.map((call) => call.path)).not.toContain(
    `/api/automations/${second.id}`,
  );
});

test("each row's 详情 button names its automation, so a screen reader can tell them apart", async () => {
  serve();
  const { view } = draw();
  await view.findByRole("heading", { level: 1, name: "自主工作" });
  const names = view
    .getAllByRole("button", { name: /^详情/ })
    .map((button) => button.textContent?.trim());
  expect(names.length).toBeGreaterThan(1);
  expect(new Set(names).size).toBe(names.length);
  expect(names).toContain("详情：Deploy hook");
});

test("the row switches are drawn small but hit 44×44", async () => {
  serve();
  const { view } = draw();
  await view.findByRole("heading", { level: 1, name: "自主工作" });
  const switches = view.getAllByRole("switch");
  expect(switches.length).toBeGreaterThan(0);
  for (const control of switches) {
    // 24 + 2×10 wide, 14 + 2×15 tall: the touch target a finger needs, the look unchanged.
    expect(control.className).toContain("after:-inset-x-[10px]");
    expect(control.className).toContain("after:-inset-y-[15px]");
  }
});

/*
 * A server whose list carries each automation's triggers (`GET /api/automations` → triggers) needs
 * no per-automation detail read at all: the rows draw from the list, and the detail cache is seeded
 * from it so opening 详情 has the triggers at once.
 */
test("when the list carries triggers, no automation detail is requested", async () => {
  serve();
  const withTriggers = AUTOMATIONS.map((entry) => ({
    ...entry,
    triggers: TRIGGERS[entry.id] ?? [],
  }));
  const { view, queryClient } = draw({
    automations: withTriggers,
    seedDetails: false,
  });
  await view.findByRole("heading", { level: 1, name: "自主工作" });
  await waitFor(() =>
    expect(view.getAllByText(/Hook \/ API/).length).toBeGreaterThan(0),
  );
  expect(
    calls.filter((call) => /^\/api\/automations\/[^/]+$/.test(call.path)),
  ).toEqual([]);
  const seeded = queryClient.getQueryData(
    automationKeys.detail(withTriggers[1]!.id),
  ) as { triggers: unknown[] } | undefined;
  expect(seeded?.triggers).toEqual(TRIGGERS[withTriggers[1]!.id] ?? []);
});
