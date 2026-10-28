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
import { Route as TasksRoute } from "@/routes/_authed/_app/tasks";
import { settleReactWork } from "./settle-react-work";

/**
 * A1 says the address is the filter state, so this file asks the router and the wire rather than the
 * parser: a link pasted from chat must rebuild the same board, one control must move one axis and
 * leave the rest, and the two reads of the screen must differ in the one way the spec allows.
 *
 * useSearch, useNavigate and boardSearch are not mocked -- a test that stubs them would prove the
 * wiring was never exercised. The real file route goes through the real _authed / _app chain, the
 * shape channel-new-error-state.test.tsx already uses. Data comes from a controlled fetch that
 * records every request, so there is no live network and no business write here.
 *
 * Three things v1 got wrong and this file fixes: a window assertion that mixed the pre-click
 * request into the post-click one (so it could only fail), a fetch stub restored only on the happy
 * path (so one failure leaked the stub into every later test), and a rebuild case that left two
 * boards mounted at once. Each is fixed where it was wrong, not by loosening an assertion.
 *
 * A fourth thing, found by the cloud run rather than by reading: v2 counted lanes and buttons right
 * after settleReactWork(), which drains the queue React has posted but does not wait for a fetch
 * promise to come back through react-query, so the DOM was read while the screen still said
 * 正在加载任务…. Every assertion about rendered content now follows a findByText or waitFor on the
 * state that has to be there, bounded by testing-library's own defaults -- no fixed sleep, no
 * raised test timeout.
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
  /* The stub goes back whether the test passed or threw -- a leaked stub would quietly rewrite
   * every later case in this file into a test of the fixture. */
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
  device: "d-1",
  updatedAt: new Date().toISOString(),
});

const TASKS = [
  row("running", "running"),
  row("failed", "failed"),
  row("done", "done"),
  row("review", "awaiting_review"),
];

const DEVICE = {
  id: "row-1",
  deviceId: "d-1",
  name: "dev-laptop",
  platform: "windows",
  lastSeenAt: new Date().toISOString(),
  online: true,
};

function controlFetch(requests: string[]) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    requests.push(`${init?.method ?? "GET"} ${path}`);
    const body = path.startsWith("/api/tasks")
      ? { tasks: TASKS }
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

/**
 * The one type assertion in this file, and it sits only at the wiring seam: a generated file route
 * takes its parents from routeTree.gen.ts, which a test tree replaces by hand. The seam is the one
 * channel-new-error-state.test.tsx:88-108 uses -- module-level root / authed / app routes, and the
 * assertion types its parent as `() => typeof app`, the concrete local chain, not a generic
 * createRoute return. That is what makes the two types overlap without a second cast through
 * unknown, and nothing in product code is loosened by it.
 */
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

function draw(initialEntry: string, _requests: string[]) {
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

const laneGroups = (view: ReturnType<typeof render>) =>
  [...view.container.querySelectorAll("[role=group]")].filter((node) =>
    (node.getAttribute("aria-label") ?? "").endsWith("泳道"),
  );

/**
 * THE BOARD SHOWS ONE TASK TWICE, SO A TEST HAS TO SAY WHICH COPY IT MEANS.
 *
 * AttentionRegion (tasks.tsx:488-520) renders `<li>` cards for needs_action / awaiting_review /
 * failed inside `section[aria-label="需要关注"]`, and the very same task is also a row of the main
 * result set -- that duplication is the feature, not a defect. A bare text query on a failed card
 * therefore matches two nodes, which is the single cause behind all five NAV3 reds. Readiness and
 * counting happen on the main result set: task rows outside that section.
 */
const ATTENTION_SELECTOR = 'section[aria-label="需要关注"]';

const boardCardsOutsideAttention = (view: ReturnType<typeof render>) => {
  const aside = view.container.querySelector(ATTENTION_SELECTOR);
  return [...view.container.querySelectorAll("li")].filter(
    (li) => !aside?.contains(li),
  );
};

const mainResultShouldHoldExactlyOne = (
  view: ReturnType<typeof render>,
  title: string,
) =>
  waitFor(() => {
    /* without exactly one region, excluding it below would prove nothing */
    expect(view.container.querySelectorAll(ATTENTION_SELECTOR).length).toBe(1);
    const hits = boardCardsOutsideAttention(view).filter((li) =>
      (li.textContent ?? "").includes(title),
    );
    expect(hits.length).toBe(1);
  });

/**
 * Counted on document.body rather than inside a view: a tree left mounted outside the current
 * container is exactly what a scoped query would hide, so this is the negative control that makes
 * the copy case mean single mounting.
 */
const boardHeadingCount = () =>
  [...document.body.querySelectorAll("h1")].filter(
    (node) => (node.textContent ?? "").trim() === "任务看板",
  ).length;
/**
 * Buttons are found by their own text inside one view and only when that text is unique there. A
 * label matching twice throws here rather than clicking whichever node the DOM handed over, which
 * is the difference between a test that means something and one that happens to pass.
 */
async function clickButtonByText(
  view: ReturnType<typeof render>,
  text: string,
) {
  const matches = [...view.container.querySelectorAll("button")].filter(
    (node) => (node.textContent ?? "").trim() === text,
  );
  if (matches.length !== 1) {
    throw new Error(
      `expected one button named ${text}, found ${matches.length}`,
    );
  }
  await userEvent.click(matches[0]);
  await settleReactWork();
}

test("a full six-axis link renders the lanes it names and asks for them on the wire", async () => {
  const requests: string[] = [];
  controlFetch(requests);
  const { router, view } = draw(
    "/tasks?machineId=d-1&crew=c-1&status=failed&q=weekly&period=week&view=lanes",
    requests,
  );
  /* v2 waited on settleReactWork(), which drains React's queue but does not wait for a fetch
   * promise: the lanes were counted while the screen still read 正在加载任务…. findByText is
   * the repo's own settle signal (tasks-open-link.test.tsx:127). */
  await mainResultShouldHoldExactlyOne(view, "failed card");
  const href = router.state.location.href;
  for (const axis of [
    "machineId=d-1",
    "crew=c-1",
    "status=failed",
    "q=weekly",
    "period=week",
    "view=lanes",
  ]) {
    expect(href).toInclude(axis);
  }
  /* view is not just a token in the address: the lane columns are what answers it. */
  expect(laneGroups(view).length).toBe(3);
  const list = taskRequests(requests).find((url) => url.includes("status="));
  expect(list).toBeDefined();
  expect(list).toInclude("deviceId=d-1");
  expect(list).toInclude("executors=c-1");
  expect(list).toInclude("period=week");
  expect(list).toInclude("q=weekly");
});

test("a bare address asks for the month, names no other axis and draws one list", async () => {
  const requests: string[] = [];
  controlFetch(requests);
  const { view } = draw("/tasks", requests);
  await mainResultShouldHoldExactlyOne(view, "running card");
  const list = taskRequests(requests);
  expect(list.length).toBeGreaterThan(0);
  expect(list.some((url) => url.includes("period=month"))).toBe(true);
  expect(list.some((url) => url.includes("status="))).toBe(false);
  expect(list.some((url) => url.includes("deviceId="))).toBe(false);
  expect(list.some((url) => url.includes("executors="))).toBe(false);
  expect(list.some((url) => url.includes("q="))).toBe(false);
  expect(laneGroups(view).length).toBe(0);
});

test("a crew-only link from wakers leaves the machine axis absent", async () => {
  const requests: string[] = [];
  controlFetch(requests);
  const { view } = draw("/tasks?crew=growth", requests);
  await mainResultShouldHoldExactlyOne(view, "running card");
  const list = taskRequests(requests);
  expect(list.some((url) => url.includes("executors=growth"))).toBe(true);
  expect(list.some((url) => url.includes("deviceId="))).toBe(false);
});

test("moving the window keeps every other axis; only post-click requests are judged", async () => {
  const requests: string[] = [];
  controlFetch(requests);
  const { router, view } = draw(
    "/tasks?machineId=d-1&crew=c-1&status=failed&q=weekly&period=week",
    requests,
  );
  await mainResultShouldHoldExactlyOne(view, "failed card");
  /* v1 asserted period=month over every narrowed request, which mixed the pre-click week read in
   * and could only fail once that read really happened. The window is cut at the click instead. */
  const initial = taskRequests(requests);
  expect(
    initial.some(
      (url) => url.includes("status=failed") && url.includes("period=week"),
    ),
  ).toBe(true);
  const before = taskRequests(requests).length;
  await clickButtonByText(view, "一月");
  await waitFor(() => {
    expect(taskRequests(requests).length).toBeGreaterThan(before);
  });
  const href = router.state.location.href;
  for (const axis of [
    "period=month",
    "machineId=d-1",
    "crew=c-1",
    "status=failed",
    "q=weekly",
  ]) {
    expect(href).toInclude(axis);
  }
  const after = taskRequests(requests).slice(before);
  const narrowed = after.filter((url) => url.includes("status=failed"));
  expect(narrowed.length).toBeGreaterThan(0);
  expect(narrowed.every((url) => url.includes("period=month"))).toBe(true);
  const summary = after.filter(
    (url) => !url.includes("status=") && !url.includes("q="),
  );
  expect(summary.length).toBeGreaterThan(0);
  expect(summary.every((url) => url.includes("period=month"))).toBe(true);
});

test("an address copy opens the same board, with one view mounted at a time", async () => {
  const first: string[] = [];
  controlFetch(first);
  const round1 = draw("/tasks?status=failed&period=all&view=lanes", first);
  await mainResultShouldHoldExactlyOne(round1.view, "failed card");
  expect(boardHeadingCount()).toBe(1);
  const href = round1.router.state.location.href;
  const lanes1 = laneGroups(round1.view).length;
  const asked1 = taskRequests(first).filter((url) =>
    url.includes("status=failed"),
  );
  /* The first board is released before the second one mounts: two live trees on the same route
   * would let the second read be answered by the first, which is what this case has to rule out.
   * v1 left both mounted and proved nothing. */
  round1.view.unmount();
  const second: string[] = [];
  controlFetch(second);
  const round2 = draw(href, second);
  await mainResultShouldHoldExactlyOne(round2.view, "failed card");
  /* one heading in the whole document is what proves the first tree really went away */
  expect(boardHeadingCount()).toBe(1);
  expect(lanes1).toBe(3);
  expect(laneGroups(round2.view).length).toBe(lanes1);
  const asked2 = taskRequests(second).filter((url) =>
    url.includes("status=failed"),
  );
  expect(asked2.length).toBeGreaterThan(0);
  expect(asked2[0]).toBe(asked1[0]);
  round2.view.unmount();
});

test("ended is narrowed here and never asked of the endpoint", async () => {
  const requests: string[] = [];
  controlFetch(requests);
  const { view } = draw("/tasks?status=ended", requests);
  await mainResultShouldHoldExactlyOne(view, "failed card");
  const all = taskRequests(requests);
  expect(all.length).toBeGreaterThan(0);
  expect(all.some((url) => url.includes("status=ended"))).toBe(false);
  /* The narrowing has to be visible: the endpoint cannot be asked for three statuses at once, so
   * the screen applies it to what came back. */
  /* 需要关注 holds the same failed and review rows on purpose, so the board's own result set is
   * what has to carry these titles: a card that only shows in the attention section must not pass
   * as a main-list result, and the container-level controls stay as extra checks. */
  const mainTexts = boardCardsOutsideAttention(view).map(
    (li) => li.textContent ?? "",
  );
  for (const title of ["failed card", "done card", "review card"]) {
    expect(
      mainTexts.filter((nodeText) => nodeText.includes(title)).length,
    ).toBe(1);
  }
  expect(
    mainTexts.filter((nodeText) => nodeText.includes("running card")).length,
  ).toBe(0);
  const text = view.container.textContent ?? "";
  expect(text).toInclude("failed card");
  expect(text).toInclude("done card");
  expect(text).toInclude("review card");
  expect(text).not.toInclude("running card");
});

test("clearing the machine leaves the crew and the rest of the filter in place", async () => {
  const requests: string[] = [];
  controlFetch(requests);
  const { router, view } = draw(
    "/tasks?machineId=d-1&crew=growth&status=failed",
    requests,
  );
  await mainResultShouldHoldExactlyOne(view, "failed card");
  await view.findByText("全部设备");
  const before = taskRequests(requests).length;
  await clickButtonByText(view, "全部设备");
  await waitFor(() => {
    expect(taskRequests(requests).length).toBeGreaterThan(before);
  });
  const href = router.state.location.href;
  expect(href).not.toInclude("machineId=d-1");
  expect(href).toInclude("crew=growth");
  expect(href).toInclude("status=failed");
  const list = taskRequests(requests);
  expect(list.some((url) => url.includes("deviceId=d-1"))).toBe(true);
  expect(list[list.length - 1]).not.toInclude("deviceId=");
  expect(list[list.length - 1]).toInclude("executors=growth");
});
