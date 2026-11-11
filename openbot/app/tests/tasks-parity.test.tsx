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
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { agentKeys } from "@/lib/agents/queries";
import { Route as TasksRoute } from "@/routes/_authed/_app/tasks";
import { settleReactWork } from "./settle-react-work";

/**
 * F2 任务看板 parity (docs/plans/2026-11-07-qoderwake-cn-frontend-parity.md, 任务看板 row): the page
 * reads top to bottom as 工作记录横幅（数据周期 + 四张统计卡 + 状态行）→ 关注区（需要操作 / 查收结果）→
 * 全部任务（列表/泳道、搜索、员工/群组 · 触发 · 状态 · 数据周期筛选）, and every switch and filter lives
 * in the address. The reference screenshot puts the cards and the period INSIDE the banner. Real route, real router, controlled fetch — the harness tasks-workbench-navigation uses.
 *
 * Since the black/white/red redesign (docs/design/ios-studio/01-任务看板.png) the attention tabs read
 * 「需要操作 N / 查收结果 N」 without brackets and the list's own window is labelled 周期; what each
 * control does and where it sits is asserted exactly as before.
 */
let registeredHere = false;
const originalFetch = globalThis.fetch;

beforeAll(() => {
  if (!("document" in globalThis)) {
    GlobalRegistrator.register();
    registeredHere = true;
  }
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

afterAll(async () => {
  if (!registeredHere) return;
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const row = (
  id: string,
  status: string,
  source = "chat",
  executorAgentId: string | null = null,
) => ({
  id,
  title: `${id} card`,
  executorAgentId,
  source,
  status,
  channelRef: null,
  open: null,
  deliverableRef: null,
  model: null,
  deviceId: null,
  updatedAt: new Date().toISOString(),
});

const TASKS = [
  row("running", "running", "chat", "agent-a"),
  row("asks", "needs_action", "routine", "agent-b"),
  row("done", "done", "handoff", "agent-a"),
  row("review", "awaiting_review", "chat", null),
];

function controlFetch(requests: string[]) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    requests.push(`${init?.method ?? "GET"} ${path}`);
    const body = path.startsWith("/api/tasks")
      ? { tasks: TASKS }
      : path.startsWith("/api/devices")
        ? { devices: [] }
        : path.startsWith("/api/waker-groups")
          ? { groups: [] }
          : { agents: [] };
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
      status: 200,
    });
  }) as typeof fetch;
}

const taskRequests = (requests: string[]) =>
  requests
    .filter((line) => line.includes("/api/tasks"))
    .map((line) => decodeURIComponent(line.split(" ")[1]));

const root = createRootRoute({ component: Outlet });
const authed = createRoute({
  id: "/_authed",
  getParentRoute: () => root,
  component: Outlet,
});
const app = createRoute({
  id: "/_app",
  getParentRoute: () => authed,
  component: Outlet,
});

type TestFileRouteWiring = Parameters<typeof TasksRoute.update>[0] & {
  id: string;
  path: string;
  getParentRoute: () => typeof app;
};

const tasksRoute = TasksRoute.update({
  id: "/tasks",
  path: "/tasks",
  getParentRoute: () => app,
} as TestFileRouteWiring);

const routeTree = root.addChildren([
  authed.addChildren([app.addChildren([tasksRoute])]),
]);

function draw(initialEntry: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(agentKeys.list(false), []);
  const router = createRouter({
    context: {},
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
    routeTree,
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, view };
}

const region = (view: ReturnType<typeof render>, name: string) =>
  view.getByRole("region", { name });

/** Waits until both reads have answered: the banner counts and the attention area is drawn. */
const ready = (view: ReturnType<typeof render>) =>
  waitFor(() => {
    expect(
      within(region(view, "任务统计")).getAllByRole("button")[0]?.textContent,
    ).toBe("4任务总数");
    expect(region(view, "需要关注")).toBeTruthy();
    expect(region(view, "全部任务").textContent).toContain("running card");
  });

const laneGroups = (view: ReturnType<typeof render>) =>
  [...view.container.querySelectorAll("[role=group]")].filter((node) =>
    (node.getAttribute("aria-label") ?? "").endsWith("泳道"),
  );

test("the page reads banner (period, then four cards), attention, then all tasks", async () => {
  controlFetch([]);
  const { view } = draw("/tasks");
  await ready(view);

  // Inside the banner: its period filter comes before the four cards.
  const banner = region(view, "工作记录");
  const period = within(banner).getByLabelText("数据周期");
  const cards = within(banner).getByRole("region", { name: "任务统计" });
  expect(
    period.compareDocumentPosition(cards) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();

  const order = [banner, region(view, "需要关注"), region(view, "全部任务")];
  for (let index = 1; index < order.length; index += 1) {
    const before = order[index - 1] as HTMLElement;
    const after = order[index] as HTMLElement;
    expect(
      before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // Siblings, not nested: each area is its own block on the page.
    expect(before.contains(after)).toBe(false);
  }
});

test("the 工作记录 banner summarises the chosen period from the tasks already read", async () => {
  controlFetch([]);
  const { view } = draw("/tasks");
  await ready(view);
  const banner = region(view, "工作记录");
  // The chosen period by its own word, the window's count, and who and how the work started.
  expect(
    (within(banner).getByLabelText("数据周期") as HTMLSelectElement)
      .selectedOptions[0]?.textContent,
  ).toBe("一个月");
  expect(
    within(
      within(banner).getByRole("region", { name: "任务统计" }),
    ).getAllByRole("button")[0]?.textContent,
  ).toBe("4任务总数");
  expect(banner.textContent).toContain("2 位员工");
  expect(banner.textContent).toContain("对话触发 2");
  expect(banner.textContent).toContain("自主工作 1");
  expect(banner.textContent).toContain("交接 1");
});

test("the four cards are one row: 任务总数, 进行中任务, 需要操作, 已结束任务", async () => {
  controlFetch([]);
  const { view } = draw("/tasks");
  await ready(view);
  const cards = within(region(view, "任务统计")).getAllByRole("button");
  expect(cards.map((card) => card.textContent?.replace(/\d+/g, ""))).toEqual([
    "任务总数",
    "进行中任务",
    "需要操作",
    "已结束任务",
  ]);
  expect(cards.map((card) => card.textContent?.replace(/\D+/g, ""))).toEqual([
    "4",
    "1",
    "1",
    "2",
  ]);
});

test("the period control sits in the banner and the list filters in the all-tasks area, all 32px tall", async () => {
  controlFetch([]);
  const { view } = draw("/tasks");
  await ready(view);
  const period = within(region(view, "工作记录")).getByLabelText("数据周期");
  const all = region(view, "全部任务");
  const controls = [
    period,
    within(all).getByLabelText("搜索任务"),
    within(all).getByLabelText("员工 / 群组"),
    within(all).getByLabelText("触发方式"),
    within(all).getByLabelText("任务状态"),
    // The list's own window, named 周期 as docs/design/ios-studio/01-任务看板.png names it.
    within(all).getByLabelText("周期"),
  ];
  for (const control of controls) {
    // The 32px box is the shared control's frame around the native field.
    const frame = control.closest("[data-slot]") as HTMLElement;
    expect(frame.className).toContain("h-[32px]");
  }
});

test("the view switch is a tablist: 泳道 draws lanes and lands in the address", async () => {
  controlFetch([]);
  const { router, view } = draw("/tasks");
  await ready(view);
  const switcher = within(region(view, "全部任务")).getByRole("tablist", {
    name: "视图",
  });
  const listTab = within(switcher).getByRole("tab", { name: "列表" });
  const lanesTab = within(switcher).getByRole("tab", { name: "泳道" });
  expect(listTab.getAttribute("aria-selected")).toBe("true");
  expect(laneGroups(view).length).toBe(0);

  await userEvent.click(lanesTab);
  await settleReactWork();
  await waitFor(() => expect(laneGroups(view).length).toBe(3));
  expect(router.state.location.href).toInclude("view=lanes");
  expect(
    within(switcher)
      .getByRole("tab", { name: "泳道" })
      .getAttribute("aria-selected"),
  ).toBe("true");

  // Keyboard: Left from 泳道 goes back to 列表 and the address follows.
  fireEvent.keyDown(within(switcher).getByRole("tab", { name: "泳道" }), {
    key: "ArrowLeft",
  });
  await settleReactWork();
  await waitFor(() => expect(laneGroups(view).length).toBe(0));
  expect(router.state.location.href).toInclude("view=list");
});

test("the attention switch is a tablist whose choice survives a reload", async () => {
  controlFetch([]);
  const { router, view } = draw("/tasks");
  await ready(view);
  const attention = region(view, "需要关注");
  const tabs = within(attention).getByRole("tablist", { name: "关注分类" });
  expect(
    within(tabs)
      .getByRole("tab", { name: "需要操作 1" })
      .getAttribute("aria-selected"),
  ).toBe("true");
  await userEvent.click(within(tabs).getByRole("tab", { name: "查收结果 1" }));
  await settleReactWork();
  expect(router.state.location.href).toInclude("attention=review");
  expect(within(attention).getByText("review card")).toBeTruthy();
  const href = router.state.location.href;
  cleanup();

  const again = draw(href);
  await ready(again.view);
  const reloaded = within(region(again.view, "需要关注")).getByRole("tab", {
    name: "查收结果 1",
  });
  expect(reloaded.getAttribute("aria-selected")).toBe("true");
});

test("a filter written by its control persists through the address into a fresh board", async () => {
  const requests: string[] = [];
  controlFetch(requests);
  const { router, view } = draw("/tasks");
  await ready(view);
  const all = region(view, "全部任务");
  fireEvent.change(within(all).getByLabelText("触发方式"), {
    target: { value: "autonomous" },
  });
  await settleReactWork();
  await waitFor(() =>
    expect(router.state.location.href).toInclude("source=autonomous"),
  );
  const href = router.state.location.href;
  cleanup();

  const fresh: string[] = [];
  controlFetch(fresh);
  const again = draw(href);
  await ready(again.view);
  const select = within(region(again.view, "全部任务")).getByLabelText(
    "触发方式",
  ) as HTMLSelectElement;
  expect(select.value).toBe("autonomous");
  expect(
    taskRequests(fresh).some((url) =>
      url.includes("source=routine,responsibility"),
    ),
  ).toBe(true);
});
