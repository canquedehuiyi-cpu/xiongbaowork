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
import { agentKeys } from "@/lib/agents/queries";
import {
  boardQuery,
  boardSearch,
  Route as TasksRoute,
} from "@/routes/_authed/_app/tasks";
import { settleReactWork } from "./settle-react-work";

/**
 * 任务看板 against the reference screenshot (docs/acceptance/qoderwake-reference/tasks.png): the
 * 工作记录 banner HOLDS the four cards, its own 数据周期 and 设备 filters and the status line; the
 * attention area is underline tabs over a bordered panel; 全部任务 has a 16px bold heading (measured), an icon view
 * switch and a labelled toolbar with a second 数据周期 that narrows only the list (`listPeriod`).
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

const row = (id: string, status: string) => ({
  id,
  title: `${id} card`,
  executorAgentId: null,
  source: "chat",
  status,
  channelRef: null,
  open: null,
  deliverableRef: null,
  model: null,
  deviceId: null,
  updatedAt: new Date().toISOString(),
});

const DEVICE = {
  id: "row-1",
  deviceId: "d-1",
  name: "dev-laptop",
  platform: "windows",
  lastSeenAt: new Date().toISOString(),
  online: true,
};

function controlFetch(
  requests: string[],
  options: { tasks?: unknown[]; devices?: unknown[] } = {},
) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    requests.push(`${init?.method ?? "GET"} ${path}`);
    const body = path.startsWith("/api/tasks")
      ? { tasks: options.tasks ?? [] }
      : path.startsWith("/api/devices")
        ? { devices: options.devices ?? [] }
        : path.startsWith("/api/waker-groups")
          ? { groups: [] }
          : { agents: [] };
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
      status: 200,
    });
  }) as typeof fetch;
}

const taskReads = (requests: string[]) =>
  requests
    .filter((line) => line.includes("/api/tasks?"))
    .map(
      (line) =>
        new URLSearchParams(decodeURIComponent(line.split("?")[1] ?? "")),
    );

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

const ready = (view: ReturnType<typeof render>) =>
  waitFor(() => {
    expect(
      within(region(view, "工作记录")).getByRole("region", {
        name: "任务统计",
      }),
    ).toBeTruthy();
    expect(region(view, "需要关注")).toBeTruthy();
  });

test("the header says where the board starts from: the work itself", async () => {
  controlFetch([]);
  const { view } = draw("/tasks");
  await ready(view);
  expect(
    view.getByText("从「事」出发：查看员工做了什么，完成必要操作并查收结果。"),
  ).toBeTruthy();
  // The header action stays.
  expect(view.getByRole("button", { name: /派给群组/ })).toBeTruthy();
});

test("the 工作记录 banner holds its title, its period filter, the four cards and the status line", async () => {
  controlFetch([]);
  const { view } = draw("/tasks");
  await ready(view);
  const banner = region(view, "工作记录");
  expect(within(banner).getByText("工作记录").tagName).toBe("H2");
  const period = within(banner).getByLabelText("数据周期") as HTMLSelectElement;
  expect(period.value).toBe("month");
  expect([...period.options].map((option) => option.textContent)).toEqual([
    "一周",
    "一个月",
    "全部",
  ]);
  // The banner is the green record panel the reference draws, not a plain line.
  expect(banner.getAttribute("data-slot")).toBe("work-record-banner");
  const cards = within(
    within(banner).getByRole("region", { name: "任务统计" }),
  ).getAllByRole("button");
  expect(cards.map((card) => card.textContent?.replace(/\d+/g, ""))).toEqual([
    "任务总数",
    "进行中任务",
    "需要操作",
    "已结束任务",
  ]);
  // The selected card is the filtering one, marked by the primary border.
  expect(cards[0]?.getAttribute("aria-pressed")).toBe("true");
  expect(cards[0]?.className).toContain("border-primary");
  expect(cards[1]?.className).not.toContain("border-primary");
  // Nothing running in the window: the status line says the coworkers are resting.
  expect(within(banner).getByText(/员工们正在休息/)).toBeTruthy();
  // No separate scope row is left above the banner.
  expect(view.queryByRole("group", { name: "看板范围" })).toBeNull();
});

test("the status line says work is running when the window holds running tasks", async () => {
  controlFetch([], { tasks: [row("a", "running"), row("b", "running")] });
  const { view } = draw("/tasks");
  await ready(view);
  const banner = region(view, "工作记录");
  await waitFor(() =>
    expect(within(banner).getByText(/2 个任务进行中/)).toBeTruthy(),
  );
  expect(within(banner).queryByText(/正在休息/)).toBeNull();
});

test("the machines fold into a 设备 filter in the banner, beside 数据周期", async () => {
  const requests: string[] = [];
  controlFetch(requests, { devices: [DEVICE] });
  const { router, view } = draw("/tasks");
  await ready(view);
  const banner = region(view, "工作记录");
  const device = (await within(banner).findByLabelText(
    "设备",
  )) as HTMLSelectElement;
  expect(device.value).toBe("");
  expect([...device.options].map((option) => option.textContent)).toEqual([
    "全部",
    "dev-laptop · 在线",
  ]);
  fireEvent.change(device, { target: { value: "d-1" } });
  await settleReactWork();
  await waitFor(() =>
    expect(router.state.location.href).toInclude("machineId=d-1"),
  );
  await waitFor(() =>
    expect(
      taskReads(requests).some((read) => read.get("deviceId") === "d-1"),
    ).toBe(true),
  );
  // Device presence is also said on the status line.
  expect(within(banner).getByText(/设备 1\/1 在线/)).toBeTruthy();
});

test("the attention area is underline tabs over a bordered panel with a two-line empty state", async () => {
  controlFetch([]);
  const { view } = draw("/tasks");
  await ready(view);
  const attention = region(view, "需要关注");
  const tabs = within(attention).getByRole("tablist", { name: "关注分类" });
  expect(tabs.getAttribute("data-variant")).toBe("underline");
  expect(
    within(tabs)
      .getByRole("tab", { name: "需要操作 (0)" })
      .getAttribute("aria-selected"),
  ).toBe("true");
  expect(within(attention).getByText("暂无需要操作的任务")).toBeTruthy();
  expect(
    within(attention).getByText(
      "需要你确认、回答或补充信息的任务会显示在这里。",
    ),
  ).toBeTruthy();
  fireEvent.click(within(tabs).getByRole("tab", { name: "查收结果 (0)" }));
  await settleReactWork();
  await waitFor(() =>
    expect(within(attention).getByText("暂无待查收的结果")).toBeTruthy(),
  );
});

test("全部任务: 16px heading, icon view switch, labelled toolbar and the empty panel", async () => {
  controlFetch([]);
  const { view } = draw("/tasks");
  await ready(view);
  const all = region(view, "全部任务");
  const heading = within(all).getByRole("heading", { name: "全部任务" });
  expect(heading.className).toContain("text-[16px]");
  const switcher = within(all).getByRole("tablist", { name: "视图" });
  for (const name of ["列表", "泳道"]) {
    const tab = within(switcher).getByRole("tab", { name });
    // An icon, with the name kept for assistive technology only.
    expect(tab.querySelector("svg")).not.toBeNull();
    expect(tab.querySelector(".sr-only")?.textContent).toBe(name);
  }
  const search = within(all).getByRole("searchbox", { name: "搜索任务" });
  expect(search.getAttribute("placeholder")).toBe("搜索任务、员工或群组");
  const labels = [...all.querySelectorAll("[data-slot=labeled-select]")].map(
    (box) => box.querySelector("span")?.textContent,
  );
  expect(labels).toEqual(["员工 / 群组", "触发方式", "任务状态", "数据周期"]);
  const selectIn = (label: string) =>
    within(all).getByLabelText(label) as HTMLSelectElement;
  expect(selectIn("员工 / 群组").selectedOptions[0]?.textContent).toBe("全部");
  expect(selectIn("触发方式").selectedOptions[0]?.textContent).toBe("全部");
  expect(selectIn("任务状态").selectedOptions[0]?.textContent).toBe("全部");
  expect(selectIn("数据周期").selectedOptions[0]?.textContent).toBe("一个月");
  // The empty list is the mascot's empty state inside the bordered results panel.
  const empty = await within(all).findByText("暂无任务");
  expect(empty.closest("[data-slot=task-results]")).not.toBeNull();
  expect(within(all).getByRole("img", { name: "熊宝" })).toBeTruthy();
});

test("a narrowed empty list says the filter left nothing to show", async () => {
  controlFetch([]);
  const { view } = draw("/tasks?status=running");
  await ready(view);
  expect(
    await within(region(view, "全部任务")).findByText(
      "当前筛选条件下没有可展示的任务。",
    ),
  ).toBeTruthy();
});

test("the list's own 数据周期 narrows the list alone and survives a reload", async () => {
  const requests: string[] = [];
  controlFetch(requests);
  const { router, view } = draw("/tasks");
  await ready(view);
  const all = region(view, "全部任务");
  const listPeriod = within(all).getByLabelText(
    "数据周期",
  ) as HTMLSelectElement;
  const mark = requests.length;
  fireEvent.change(listPeriod, { target: { value: "week" } });
  await settleReactWork();
  await waitFor(() =>
    expect(router.state.location.href).toInclude("listPeriod=week"),
  );
  await waitFor(() => {
    const reads = taskReads(requests.slice(mark));
    // The list asks for the week...
    expect(reads.some((read) => read.get("period") === "week")).toBe(true);
  });
  // ...and the banner's read never moved off the month.
  for (const read of taskReads(requests.slice(mark))) {
    if (read.get("period") !== "week") expect(read.get("period")).toBe("month");
  }
  const bannerPeriod = within(region(view, "工作记录")).getByLabelText(
    "数据周期",
  ) as HTMLSelectElement;
  expect(bannerPeriod.value).toBe("month");
  const href = router.state.location.href;
  cleanup();

  const again = draw(href);
  await ready(again.view);
  expect(
    (
      within(region(again.view, "全部任务")).getByLabelText(
        "数据周期",
      ) as HTMLSelectElement
    ).value,
  ).toBe("week");
});

test("without listPeriod the list follows the banner's period", () => {
  const address = boardSearch({ period: "week" });
  expect(address.listPeriod).toBeUndefined();
  expect(boardQuery(address).list).toStartWith("period=week");
  const split = boardSearch({ period: "week", listPeriod: "all" });
  expect(boardQuery(split).list).toStartWith("period=all");
  expect(boardQuery(split).scope).toStartWith("period=week");
  // A stale value is no list period at all, not an error.
  expect(boardSearch({ listPeriod: "year" }).listPeriod).toBeUndefined();
});
