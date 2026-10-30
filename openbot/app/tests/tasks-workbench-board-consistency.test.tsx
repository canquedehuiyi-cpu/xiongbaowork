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
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { agentKeys } from "@/lib/agents/queries";
import { wakerGroupKeys } from "@/lib/waker-groups/queries";
import { laneOf, Route as TasksRoute } from "@/routes/_authed/_app/tasks";
import { settleReactWork } from "./settle-react-work";

/**
 * A2 asks one thing of the board: the two shapes must be two shapes of THE SAME READ, not two
 * answers. This file drives the real file route through the real router with a controlled fetch,
 * switches list to lanes by pressing the control a person presses, and compares what is on screen
 * before and after -- task identities, the status each card says it has, and the five axes nobody
 * touched. useSearch, useNavigate and boardSearch are not mocked and the tasks cache is not
 * pre-seeded: a test that did either would prove the wiring was never exercised.
 *
 * Two honesty notes live next to the assertions they qualify:
 *  - the polling case reads the interval react-query actually received. It does NOT observe a
 *    real 5 s / 30 s refire, and nothing here sleeps that long or touches the global budget.
 *  - one card is rendered twice on this screen on purpose (the attention region and the result
 *    set), so every count below happens on result rows outside section[aria-label=需要关注].
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
  /* the stub goes back whether the test passed or threw */
  globalThis.fetch = originalFetch;
});

afterAll(async () => {
  if (!registeredHere) return;
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const row = (id: string, status: string) => ({
  id,
  title: id + " card",
  executorAgentId: null,
  source: "chat",
  status,
  channelRef: null,
  open: null,
  deliverableRef: null,
  model: null,
  device: "d-1",
  updatedAt: new Date().toISOString(),
});

/** One of every status the server writes, plus one it does not: the unknown row is the boundary. */
const KNOWN_BATCH = [
  row("running", "running"),
  row("needs", "needs_action"),
  row("review", "awaiting_review"),
  row("failed", "failed"),
  row("done", "done"),
];
const UNKNOWN_ROW = row("odd", "scheduling");
const ALL_ROWS = [...KNOWN_BATCH, UNKNOWN_ROW];
const ALL_TITLES = ALL_ROWS.map((task) => task.title);

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
  tasks: { id: string; status: string }[],
) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    requests.push((init?.method ?? "GET") + " " + path);
    const body = path.startsWith("/api/tasks")
      ? { tasks }
      : path.startsWith("/api/devices")
        ? { devices: [DEVICE] }
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

function draw(
  initialEntry: string,
  _requests: string[],
  _tasks: { id: string; status: string }[],
  catalogs?: { agents: { id: string; name: string }[]; readAgents?: boolean; groups: { id: string; name: string; description: null; members: { agentId: string; position: number }[] }[] },
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  if (!catalogs?.readAgents) queryClient.setQueryData(agentKeys.list(false), catalogs?.agents ?? []);
  if (catalogs) queryClient.setQueryData(wakerGroupKeys.list(), catalogs.groups);
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
  return { queryClient, router, view };
}

const ATTENTION_SELECTOR = 'section[aria-label="需要关注"]';

/**
 * Result rows are the board's own list or lanes. The attention region repeats some of the same
 * cards by design, so it is excluded before anything is counted: counting it would let a card
 * that only shows in that region pass as a result.
 */
const resultRows = (view: ReturnType<typeof render>) => {
  const aside = view.container.querySelector(ATTENTION_SELECTOR);
  return [...view.container.querySelectorAll("li")].filter(
    (li) => !aside?.contains(li),
  );
};

const titlesIn = (rows: Element[], titles: string[]) =>
  titles.filter((title) => rows.some((li) => (li.textContent ?? "").includes(title)));

/** The status a card says it has, read off the badge rather than inferred from its colour. */
const badgeOf = (view: ReturnType<typeof render>, title: string) => {
  const hits = resultRows(view).filter((li) =>
    (li.textContent ?? "").includes(title),
  );
  if (hits.length !== 1) {
    throw new Error(`expected one result row titled ${title}, found ${hits.length}`);
  }
  const badge = hits[0].querySelector("[data-status]");
  if (!badge) {
    throw new Error(`the result row titled ${title} carries no status attribute`);
  }
  return badge;
};

const statusSaidBy = (view: ReturnType<typeof render>, title: string) =>
  badgeOf(view, title).getAttribute("data-status") ?? "MISSING";

/** A stat card renders a value and its label and nothing else, so the pair is addressable. */
const statValue = (view: ReturnType<typeof render>, label: string) => {
  const wanted = new RegExp("^\\d+\\+?" + label + "$");
  const hit = [...view.container.querySelectorAll("button")]
    .map((node) => (node.textContent ?? "").trim())
    .find((text) => wanted.test(text));
  if (hit === undefined) {
    throw new Error(`no stat card labelled ${label}`);
  }
  return hit.slice(0, hit.length - label.length);
};

const laneTitles = (view: ReturnType<typeof render>, laneLabel: string) => {
  const group = [...view.container.querySelectorAll("[role=group]")].find(
    (node) => node.getAttribute("aria-label") === `${laneLabel}泳道`,
  );
  if (!group) {
    throw new Error(`no lane named ${laneLabel}`);
  }
  return titlesIn([...group.querySelectorAll("li")], ALL_TITLES);
};

async function clickControl(view: ReturnType<typeof render>, text: string) {
  const hits = [...view.container.querySelectorAll("button")].filter(
    (node) => (node.textContent ?? "").trim() === text,
  );
  if (hits.length !== 1) {
    throw new Error(`expected one control named ${text}, found ${hits.length}`);
  }
  await userEvent.click(hits[0]);
  await settleReactWork();
}

const resultsShouldShow = (view: ReturnType<typeof render>, title: string) =>
  waitFor(() => {
    /* without exactly one region present, excluding it above would prove nothing */
    expect(view.container.querySelectorAll(ATTENTION_SELECTOR).length).toBe(1);
    expect(
      resultRows(view).filter((li) => (li.textContent ?? "").includes(title)).length,
    ).toBe(1);
  });

/**
 * QueryOptions does not publicly type the interval the observer was handed, so the value is read
 * through a narrowing that fails closed: no refetchInterval key on the real options object yields
 * undefined here, which makes the assertions below fail rather than pass on a made-up number.
 */
const configuredRefetchInterval = (options: object | undefined) => {
  if (options === undefined || !("refetchInterval" in options)) {
    return undefined;
  }
  return options["refetchInterval"];
};

test("the two shapes show the same rows, the same statuses and the other five axes", async () => {
  const requests: string[] = [];
  controlFetch(requests, ALL_ROWS);
  const { router, view } = draw(
    "/tasks?machineId=d-1&crew=c-1&status=ended&q=weekly&period=all&view=list",
    requests,
    ALL_ROWS,
  );
  await resultsShouldShow(view, "done card");
  const endedSet = ["done card", "failed card", "review card"];
  const shownBefore = titlesIn(resultRows(view), ALL_TITLES).sort();
  expect(shownBefore).toEqual(endedSet);
  expect(statusSaidBy(view, "failed card")).toBe("failed");
  const readsBefore = taskRequests(requests).length;
  await clickControl(view, "泳道");
  const href = router.state.location.href;
  for (const axis of [
    "view=lanes",
    "machineId=d-1",
    "crew=c-1",
    "status=ended",
    "q=weekly",
    "period=all",
  ]) {
    expect(href).toInclude(axis);
  }
  await waitFor(() => {
    expect(titlesIn(resultRows(view), ALL_TITLES).sort()).toEqual(shownBefore);
  });
  expect(statusSaidBy(view, "review card")).toBe("awaiting_review");
  expect(statusSaidBy(view, "done card")).toBe("done");
  /* the shape is presentation: switching it must not open a second read of the same window */
  expect(taskRequests(requests).length).toBe(readsBefore);
});

test("the bar's own read is asked without the status and without the words", async () => {
  const requests: string[] = [];
  controlFetch(requests, ALL_ROWS);
  const { view } = draw(
    "/tasks?machineId=d-1&crew=c-1&status=failed&q=weekly&period=week&view=list",
    requests,
    ALL_ROWS,
  );
  await resultsShouldShow(view, "failed card");
  const urls = taskRequests(requests);
  const filtered = urls.filter(
    (url) => url.includes("status=failed") && url.includes("q=weekly"),
  );
  expect(filtered.length).toBeGreaterThan(0);
  const window = urls.filter(
    (url) => !url.includes("status=") && !url.includes("q="),
  );
  expect(window.length).toBeGreaterThan(0);
  expect(window.every((url) => url.includes("period=week"))).toBe(true);
  expect(
    window.every(
      (url) => url.includes("deviceId=d-1") && url.includes("executors=c-1"),
    ),
  ).toBe(true);
});

test("a full window says 200+ while the running count stays exact", async () => {
  const requests: string[] = [];
  const many = [
    ...Array.from({ length: 199 }, (_unused, index) => row("t" + index, "running")),
    row("full", "failed"),
  ];
  controlFetch(requests, many);
  const { view } = draw("/tasks?period=all&view=list", requests, many);
  await resultsShouldShow(view, "full card");
  expect(statValue(view, "任务总数")).toBe("200+");
  expect(statValue(view, "进行中")).toBe("199");
  expect(statValue(view, "需要操作")).toBe("0");
  expect(statValue(view, "已结束")).toBe("1");
});

test("the bar partitions the batch the way the board defines it", async () => {
  const requests: string[] = [];
  controlFetch(requests, ALL_ROWS);
  const { view } = draw("/tasks?period=all&view=list", requests, ALL_ROWS);
  await resultsShouldShow(view, "needs card");
  expect(statValue(view, "任务总数")).toBe("6");
  expect(statValue(view, "进行中")).toBe("1");
  expect(statValue(view, "需要操作")).toBe("1");
  expect(statValue(view, "已结束")).toBe("3");
  expect((badgeOf(view, "odd card").textContent ?? "").trim()).toBe("scheduling");
});

test("the lanes hold exactly what their own columns claim", async () => {
  const requests: string[] = [];
  controlFetch(requests, ALL_ROWS);
  const { view } = draw("/tasks?period=all&view=lanes", requests, ALL_ROWS);
  await resultsShouldShow(view, "done card");
  expect(laneTitles(view, "进行中")).toEqual(["running card"]);
  expect(laneTitles(view, "需要关注").sort()).toEqual([
    "failed card",
    "needs card",
    "review card",
  ]);
  expect(laneTitles(view, "已结束")).toEqual(["done card"]);
  /* the three attention statuses are not finished work, and finished work is not them */
  for (const title of ["failed card", "needs card", "review card"]) {
    expect(laneTitles(view, "已结束").includes(title)).toBe(false);
  }
  expect(laneTitles(view, "进行中").includes("done card")).toBe(false);
});

test("an unknown status keeps its own value and belongs to no column", async () => {
  const listReads: string[] = [];
  controlFetch(listReads, ALL_ROWS);
  const first = draw("/tasks?period=all&view=list", listReads, ALL_ROWS);
  await resultsShouldShow(first.view, "odd card");
  expect(statusSaidBy(first.view, "odd card")).toBe("scheduling");
  expect((badgeOf(first.view, "odd card").textContent ?? "").trim()).toBe("scheduling");
  expect(titlesIn(resultRows(first.view), ALL_TITLES).length).toBe(6);
  /* one tree at a time: the list shape is released before the lane shape mounts */
  first.view.unmount();
  const laneReads: string[] = [];
  controlFetch(laneReads, ALL_ROWS);
  const second = draw("/tasks?period=all&view=lanes", laneReads, ALL_ROWS);
  await resultsShouldShow(second.view, "done card");
  const inLanes = [
    ...laneTitles(second.view, "进行中"),
    ...laneTitles(second.view, "需要关注"),
    ...laneTitles(second.view, "已结束"),
  ];
  expect(inLanes.includes("odd card")).toBe(false);
  expect(titlesIn(resultRows(second.view), ALL_TITLES).length).toBe(5);
  second.view.unmount();
  /* the same boundary, stated by the exported rule the columns are built from */
  expect(laneOf("scheduling")).toEqual([]);
  expect(laneOf("failed")).toEqual(["attention"]);
  expect(laneOf("done")).toEqual(["finished"]);
});

test("both reads carry their own polling contract, read from the live cache", async () => {
  const requests: string[] = [];
  controlFetch(requests, ALL_ROWS);
  const { queryClient, view } = draw(
    "/tasks?machineId=d-1&crew=c-1&status=failed&q=weekly&period=week&view=list",
    requests,
    ALL_ROWS,
  );
  await resultsShouldShow(view, "failed card");
  const cache = queryClient.getQueryCache();
  const tasksQuery = cache.find({
    queryKey: ["tasks", "week", "failed", "weekly", "d-1", "c-1"],
  });
  const summaryQuery = cache.find({
    queryKey: ["tasks-summary", "week", "d-1", "c-1"],
  });
  expect(tasksQuery?.queryKey).toEqual([
    "tasks",
    "week",
    "failed",
    "weekly",
    "d-1",
    "c-1",
  ]);
  expect(summaryQuery?.queryKey).toEqual(["tasks-summary", "week", "d-1", "c-1"]);
  /* these are the intervals react-query was configured with, not an observed refire */
  expect(configuredRefetchInterval(tasksQuery?.options)).toBe(5000);
  expect(configuredRefetchInterval(summaryQuery?.options)).toBe(30000);
});

test("A4 dropdowns preserve independent axes and the selected values survive refresh", async () => {
  const requests: string[] = [];
  controlFetch(requests, ALL_ROWS);
  const catalogs = {
    agents: [{ id: "a", name: "Alpha" }, { id: "b", name: "Beta" }],
    groups: [{ id: "g", name: "Group", description: null,
      members: [{ agentId: "a", position: 0 }, { agentId: "b", position: 1 }] }],
  };
  const first = draw("/tasks?machineId=d-1&crew=a,b&executor=a&groupId=g&source=routine&status=failed&q=weekly&period=week&view=list",
    requests, ALL_ROWS, catalogs);
  await resultsShouldShow(first.view, "failed card");
  expect((first.view.getByLabelText("Waker 员工") as HTMLSelectElement).value).toBe("a");
  expect((first.view.getByLabelText("Group 小组") as HTMLSelectElement).value).toBe("g");
  expect((first.view.getByLabelText("触发方式") as HTMLSelectElement).value).toBe("routine");
  expect((first.view.getByLabelText("任务状态") as HTMLSelectElement).value).toBe("failed");
  expect((first.view.getByLabelText("数据周期") as HTMLSelectElement).value).toBe("week");
  const filtered = taskRequests(requests).filter((url) => url.includes("q=weekly"));
  expect(filtered.some((url) => url.includes("executor=a") && url.includes("executors=a,b") && url.includes("source=routine"))).toBe(true);
  await userEvent.selectOptions(first.view.getByLabelText("触发方式"), "chat");
  await settleReactWork();
  const changed = new URL(first.router.state.location.href, "https://example.invalid");
  expect(changed.searchParams.get("source")).toBe("chat");
  for (const [key, value] of Object.entries({
    machineId: "d-1", crew: "a,b", executor: "a", groupId: "g",
    status: "failed", q: "weekly", period: "week", view: "list",
  })) expect(changed.searchParams.get(key)).toBe(value);
  const reload = first.router.state.location.href;
  first.view.unmount();
  const second = draw(reload, requests, ALL_ROWS, catalogs);
  await resultsShouldShow(second.view, "failed card");
  expect((second.view.getByLabelText("触发方式") as HTMLSelectElement).value).toBe("chat");
  await userEvent.selectOptions(second.view.getByLabelText("Group 小组"), "");
  await settleReactWork();
  const cleared = new URL(second.router.state.location.href, "https://example.invalid");
  expect(cleared.searchParams.get("groupId") ?? "").toBe("");
  expect(cleared.searchParams.get("executor")).toBe("a");
  expect(cleared.searchParams.get("crew")).toBe("a,b");
  expect(cleared.searchParams.get("source")).toBe("chat");
});

test("A4 changed group members refetch the new intersection and an invalid group hides cached rows", async () => {
  const requests: string[] = [];
  controlFetch(requests, ALL_ROWS);
  const catalogs = {
    agents: [{ id: "a", name: "Alpha" }, { id: "b", name: "Beta" }],
    groups: [{ id: "g", name: "Group", description: null, members: [{ agentId: "a", position: 0 }] }],
  };
  const { queryClient, view } = draw("/tasks?groupId=g&period=all", requests, ALL_ROWS, catalogs);
  await resultsShouldShow(view, "done card");
  expect(taskRequests(requests).some((url) => url.includes("executors=a"))).toBe(true);
  queryClient.setQueryData(wakerGroupKeys.list(), [{ ...catalogs.groups[0], members: [{ agentId: "b", position: 0 }] }]);
  await waitFor(() => expect(taskRequests(requests).some((url) => url.includes("executors=b"))).toBe(true));
  queryClient.setQueryData(wakerGroupKeys.list(), []);
  await waitFor(() => {
    expect(view.getByText(/所选小组或其成员已失效或不可见/)).toBeTruthy();
    expect(resultRows(view)).toHaveLength(0);
    expect(view.container.querySelector(ATTENTION_SELECTOR)).toBeNull();
    expect(view.queryByRole("button", { name: /任务总数/ })).toBeNull();
  });
  await userEvent.selectOptions(view.getByLabelText("Group 小组"), "");
  await resultsShouldShow(view, "done card");
});

test("A4 empty groups send one explicit empty executors parameter and unknown source does not read tasks", async () => {
  const requests: string[] = [];
  controlFetch(requests, []);
  const catalogs = {
    agents: [],
    groups: [{ id: "g", name: "Empty", description: null, members: [] }],
  };
  const first = draw("/tasks?groupId=g", requests, [], catalogs);
  await waitFor(() => expect(taskRequests(requests).length).toBeGreaterThan(0));
  for (const path of taskRequests(requests)) {
    const params = new URL(path, "https://example.invalid").searchParams;
    expect(params.getAll("executors")).toEqual([""]);
  }
  first.view.unmount();
  requests.length = 0;
  const second = draw("/tasks?source=timer", requests, [], catalogs);
  await waitFor(() => expect(second.view.getByText(/未知触发方式，请清除此筛选。/)).toBeTruthy());
  expect(taskRequests(requests)).toEqual([]);
  await userEvent.selectOptions(second.view.getByLabelText("触发方式"), "");
  await waitFor(() => expect(taskRequests(requests).length).toBeGreaterThan(0));
});

test("A4 failed selected catalog never fetches tasks or presents cached full-scope cards", async () => {
  const requests: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    requests.push((init?.method ?? "GET") + " " + path);
    if (path.startsWith("/api/waker-groups")) return new Response("unavailable", { status: 503 });
    if (path.startsWith("/api/devices")) return Response.json({ devices: [] });
    if (path.startsWith("/api/agents")) return Response.json({ agents: [] });
    if (path.startsWith("/api/tasks")) return Response.json({ tasks: ALL_ROWS });
    return new Response("unexpected test request", { status: 500 });
  }) as typeof fetch;
  const { view } = draw("/tasks?groupId=missing", requests, ALL_ROWS);
  await waitFor(() => expect(view.getByText(/无法读取员工或小组/)).toBeTruthy());
  expect(taskRequests(requests)).toEqual([]);
  expect(resultRows(view)).toHaveLength(0);
  expect(view.container.querySelector(ATTENTION_SELECTOR)).toBeNull();
});

test("A4 each new dropdown changes its own URL axis and both reads share the selected scope", async () => {
  const requests: string[] = [];
  controlFetch(requests, KNOWN_BATCH);
  const catalogs = {
    agents: [{ id: "a", name: "Alpha" }, { id: "b", name: "Beta" }],
    groups: [{ id: "g", name: "Group", description: null,
      members: [{ agentId: "a", position: 0 }, { agentId: "b", position: 1 }] }],
  };
  const { router, view } = draw("/tasks?machineId=d-1&crew=a,b&q=weekly&view=list",
    requests, KNOWN_BATCH, catalogs);
  await resultsShouldShow(view, "done card");
  const selections = [
    ["Waker 员工", "a", "executor"],
    ["Group 小组", "g", "groupId"],
    ["触发方式", "routine", "source"],
    ["任务状态", "failed", "status"],
    ["数据周期", "week", "period"],
  ] as const;
  for (const [label, value, axis] of selections) {
    const before = new URL(router.state.location.href, "https://example.invalid").searchParams;
    await userEvent.selectOptions(view.getByLabelText(label), value);
    await settleReactWork();
    const after = new URL(router.state.location.href, "https://example.invalid").searchParams;
    expect(after.get(axis)).toBe(value);
    for (const [key, previous] of before)
      if (key !== axis) expect(after.get(key)).toBe(previous);
    expect(after.get("machineId")).toBe("d-1");
    expect(after.get("crew")).toBe("a,b");
    expect(after.get("q")).toBe("weekly");
  }
  await waitFor(() => {
    const urls = taskRequests(requests).map((path) => new URL(path, "https://example.invalid"));
    const common = (params: URLSearchParams) => params.get("period") === "week" &&
      params.get("deviceId") === "d-1" && params.get("executor") === "a" &&
      params.get("executors") === "a,b" && params.get("source") === "routine";
    expect(urls.some(({ searchParams }) => common(searchParams) &&
      searchParams.get("status") === "failed" && searchParams.get("q") === "weekly")).toBe(true);
    expect(urls.some(({ searchParams }) => common(searchParams) &&
      !searchParams.has("status") && !searchParams.has("q"))).toBe(true);
  });
  await resultsShouldShow(view, "done card");
  const shown = titlesIn(resultRows(view), ALL_TITLES).sort();
  const attention = view.container.querySelector(ATTENTION_SELECTOR);
  expect(attention).not.toBeNull();
  const attentionTitles = titlesIn([...attention!.querySelectorAll("li")], ALL_TITLES).sort();
  expect(attentionTitles).toEqual(["failed card", "needs card"]);
  const reads = taskRequests(requests).length;
  await clickControl(view, "泳道");
  await waitFor(() => expect(titlesIn(resultRows(view), ALL_TITLES).sort()).toEqual(shown));
  const nextAttention = view.container.querySelector(ATTENTION_SELECTOR);
  expect(nextAttention).not.toBeNull();
  expect(titlesIn([...nextAttention!.querySelectorAll("li")], ALL_TITLES).sort()).toEqual(attentionTitles);
  expect(taskRequests(requests).length).toBe(reads);
  const final = new URL(router.state.location.href, "https://example.invalid").searchParams;
  expect(final.get("view")).toBe("lanes");
  for (const [_label, value, axis] of selections) expect(final.get(axis)).toBe(value);
});

/** Separate real query URLs feed distinct mock partitions; no paused ID is placed in active data. */
function rosterFetch(requests: string[], failPaused = false, failActive = false) {
  const active = [{ id: "a", name: "Active", hidden: false }];
  const paused = [{ id: "p", name: "Paused", hidden: true }];
  const rows = [
    { ...row("running", "running"), executorAgentId: "a" },
    { ...row("failed", "failed"), executorAgentId: "p" },
  ];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const url = new URL(path, "https://example.invalid");
    requests.push((init?.method ?? "GET") + " " + path);
    if (url.pathname === "/api/agents") {
      const hidden = url.searchParams.get("hidden") === "true";
      if (hidden ? failPaused : failActive) return new Response("unavailable", { status: 503 });
      return Response.json({ agents: hidden ? paused : active });
    }
    if (url.pathname === "/api/tasks") {
      const executor = url.searchParams.get("executor");
      const executors = url.searchParams.get("executors")?.split(",");
      return Response.json({ tasks: rows.filter((task) =>
        (!executor || task.executorAgentId === executor) &&
        (executors === undefined || executors.includes(task.executorAgentId))) });
    }
    if (url.pathname === "/api/devices") return Response.json({ devices: [] });
    return new Response("unexpected test request", { status: 500 });
  }) as typeof fetch;
}

test("R3 paused employees are selectable from their own endpoint and mixed groups keep every ID", async () => {
  const requests: string[] = [];
  rosterFetch(requests);
  const catalogs = {
    agents: [], readAgents: true,
    groups: [{ id: "g", name: "Mixed", description: null,
      members: [{ agentId: "a", position: 0 }, { agentId: "p", position: 1 }] }],
  };
  const { view } = draw("/tasks?period=all", requests, ALL_ROWS, catalogs);
  await resultsShouldShow(view, "failed card");
  expect(requests.some((path) => path.includes("/api/agents?hidden=true"))).toBe(false);
  await userEvent.click(view.getByLabelText("Waker 员工"));
  await waitFor(() => expect(view.getByRole("option", { name: "Paused · 已暂停" })).toBeTruthy());
  expect(requests.some((path) => path.includes("/api/agents?hidden=true"))).toBe(true);
  expect(requests.some((path) => path.endsWith("/api/agents"))).toBe(true);
  await userEvent.selectOptions(view.getByLabelText("Waker 员工"), "p");
  await waitFor(() => expect(taskRequests(requests).some((path) =>
    new URL(path, "https://example.invalid").searchParams.get("executor") === "p")).toBe(true));
  await userEvent.selectOptions(view.getByLabelText("Group 小组"), "g");
  await waitFor(() => expect(taskRequests(requests).some((path) => {
    const params = new URL(path, "https://example.invalid").searchParams;
    return params.get("executor") === "p" && params.get("executors") === "a,p";
  })).toBe(true));
  await resultsShouldShow(view, "failed card");
  expect(titlesIn(resultRows(view), ALL_TITLES)).toEqual(["failed card"]);
  await userEvent.selectOptions(view.getByLabelText("Waker 员工"), "");
  await waitFor(() => expect(titlesIn(resultRows(view), ALL_TITLES).sort())
    .toEqual(["failed card", "running card"]));
  expect((view.getByLabelText("Group 小组") as HTMLSelectElement).value).toBe("g");
});

test("R3 a hidden catalog failure cannot freeze an already known active employee", async () => {
  const requests: string[] = [];
  rosterFetch(requests, true);
  const { view } = draw("/tasks?executor=a", requests, ALL_ROWS, {
    agents: [{ id: "a", name: "Active" }], groups: [],
  });
  await resultsShouldShow(view, "running card");
  await userEvent.click(view.getByLabelText("Waker 员工"));
  await waitFor(() => expect(view.getByText("员工或小组加载失败")).toBeTruthy());
  expect(titlesIn(resultRows(view), ALL_TITLES)).toEqual(["running card"]);
  expect(view.queryByText("筛选范围不可用")).toBeNull();
  for (const path of taskRequests(requests))
    expect(new URL(path, "https://example.invalid").searchParams.get("executor")).toBe("a");
});

test("R3 missing members wait for the related partition and fail closed when that read fails", async () => {
  const requests: string[] = [];
  rosterFetch(requests, true);
  const { view } = draw("/tasks?groupId=g", requests, ALL_ROWS, {
    agents: [{ id: "a", name: "Active" }],
    groups: [{ id: "g", name: "Mixed", description: null,
      members: [{ agentId: "a", position: 0 }, { agentId: "p", position: 1 }] }],
  });
  await waitFor(() => expect(view.getByText(/无法读取员工或小组，请重试或清除此筛选。/)).toBeTruthy());
  expect(taskRequests(requests)).toEqual([]);
  expect(resultRows(view)).toHaveLength(0);
  await userEvent.selectOptions(view.getByLabelText("Group 小组"), "");
  await resultsShouldShow(view, "failed card");
});

test("R3 an ID absent from both successful catalogs is unavailable rather than all coworkers", async () => {
  const requests: string[] = [];
  rosterFetch(requests);
  const { view } = draw("/tasks?executor=missing", requests, ALL_ROWS, {
    agents: [], readAgents: true, groups: [],
  });
  await waitFor(() => expect(view.getByText(/所选员工已失效或不可见，请清除此筛选。/)).toBeTruthy());
  expect(requests.some((path) => path.endsWith("/api/agents"))).toBe(true);
  expect(requests.some((path) => path.includes("/api/agents?hidden=true"))).toBe(true);
  expect(taskRequests(requests)).toEqual([]);
  await userEvent.selectOptions(view.getByLabelText("Waker 员工"), "");
  await resultsShouldShow(view, "failed card");
});

test("R3 a successful paused partition still permits its ID when active catalog reading fails", async () => {
  const requests: string[] = [];
  rosterFetch(requests, false, true);
  const { view } = draw("/tasks?executor=p", requests, ALL_ROWS, {
    agents: [], readAgents: true, groups: [],
  });
  await resultsShouldShow(view, "failed card");
  expect(titlesIn(resultRows(view), ALL_TITLES)).toEqual(["failed card"]);
  expect(view.queryByText("筛选范围不可用")).toBeNull();
});
