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
) {
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
    (li) => !aside || !aside.contains(li),
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
