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
 * A5 changes one thing about this board: a write reports back. Before it, the route fired a bare
 * `fetch` and treated ANY return as success, so a 404 (the task is gone) and a 409 (its status refuses
 * the move) looked exactly like a landed archive -- the board refetched, the card came back where it
 * was, and the only evidence a person got was their own confusion.
 *
 * So this file pins the seam: the route now goes through the existing `taskAction` / `client`, which
 * throws a `RequestError` carrying the status, and the screen answers per status.
 *  - 200: one POST, the list read refetched, the summary read left alone (frozen by 51666086).
 *  - 404 / 409: a visible refusal quoting the server's own sentence, and no read refetched at all.
 *  - 5xx, or a request that never got an answer: 结果未确认 -- we may not claim the write did not
 *    happen, and nothing here may replay it, so the POST count stays at exactly one.
 *  - 刷新任务 only reads: both GET counts move, the POST count does not.
 *
 * What this file does NOT claim: it cannot show a focus ring, cannot prove the server's real 409 copy
 * (each case supplies its own `error` body and asserts THAT sentence reaches the screen), and does not
 * test double-submit suppression -- this package deliberately adds none (51666086 evaluates it
 * separately), so no case here asserts a disabled button, and none asserts the summary bar refreshes.
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

const ALL_ROWS = [
  row("running", "running"),
  row("needs", "needs_action"),
  row("review", "awaiting_review"),
  row("failed", "failed"),
  row("done", "done"),
  row("odd", "scheduling"),
];

const DEVICE = {
  id: "row-1",
  deviceId: "d-1",
  name: "dev-laptop",
  platform: "windows",
  lastSeenAt: new Date().toISOString(),
  online: true,
};

/** How the single POST of a case should come back. */
type ActionResult = {
  status: number;
  error?: string;
  transportFail?: boolean;
  /** A body that is not JSON, so `client.ts` has to answer with its own fallback sentence. */
  rawBody?: string;
};

/**
 * Reads always answer with the fixture. The one POST a case performs answers however that case needs,
 * and every request is recorded WITH its method, so "exactly one POST" is a count rather than an
 * absence. `transportFail` reproduces the shape `client.ts` cannot see: a fetch that rejects before any
 * status exists -- which is exactly why the screen may not claim the write failed.
 */
function installStub(action: ActionResult, rows: { id: string; status: string }[] = ALL_ROWS) {
  const requests: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    requests.push(method + " " + path);
    if (method === "POST") {
      if (action.transportFail) throw new Error("transport down");
      if (action.rawBody !== undefined)
        return new Response(action.rawBody, {
          headers: { "content-type": "text/html" },
          status: action.status,
        });
      const payload = action.error === undefined ? {} : { error: action.error };
      return new Response(JSON.stringify(payload), {
        headers: { "content-type": "application/json" },
        status: action.status,
      });
    }
    const body = path.startsWith("/api/tasks?")
      ? { tasks: rows }
      : path.startsWith("/api/devices")
        ? { devices: [DEVICE] }
        : { agents: [] };
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
      status: 200,
    });
  }) as typeof fetch;
  return requests;
}

const boardGetCount = (requests: string[]) =>
  requests.filter((line) => line.startsWith("GET /api/tasks?") && line.includes("q=card")).length;

const summaryGetCount = (requests: string[]) =>
  requests.filter((line) => line.startsWith("GET /api/tasks?") && !line.includes("q=")).length;

const countReads = (requests: string[]) =>
  requests.filter((line) => line.startsWith("GET /api/tasks?")).length;

const writes = (requests: string[]) => requests.filter((line) => !line.startsWith("GET "));

/**
 * Two reads, one address: at `?period=all` the board read and the summary read ask for the same URL, so
 * "+1 read" would not say which one moved (51666002). `q=card` is a board-only axis -- the read carrying
 * it is the list, the one never carrying it is the summary bar. Classification by URL only: no reach
 * into react-query internals, no forged queryKey, no direct call of the route's mutationFn.
 */
const root = createRootRoute({ component: Outlet });
const authed = createRoute({ id: "/_authed", getParentRoute: () => root, component: Outlet });
const app = createRoute({ id: "/_app", getParentRoute: () => authed, component: Outlet });

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

const routeTree = root.addChildren([authed.addChildren([app.addChildren([tasksRoute])])]);

/** Real route, real router, real QueryClient, real taskAction and client. Only HTTP is ours. */
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
  return { view };
}

const ATTENTION_SELECTOR = 'section[aria-label="需要关注"]';

const resultRows = (view: ReturnType<typeof render>) => {
  const aside = view.container.querySelector(ATTENTION_SELECTOR);
  return [...view.container.querySelectorAll("li")].filter(
    (li) => !aside || !aside.contains(li),
  );
};

const buttonsNamed = (view: ReturnType<typeof render>, text: string) =>
  [...view.container.querySelectorAll("button")].filter(
    (node) => (node.textContent ?? "").trim() === text,
  );

/** The refusal is the answer this package produces, so it is read from the alert region, not from a class. */
const alertText = (view: ReturnType<typeof render>) =>
  [...view.container.querySelectorAll('[role="alert"]')]
    .map((node) => (node.textContent ?? "").replace(/\s+/g, " ").trim())
    .join(" | ");

const alertCount = (view: ReturnType<typeof render>) =>
  view.container.querySelectorAll('[role="alert"]').length;

/**
 * Both reads really arrived before any baseline is taken. Rows on screen prove the DOM settled; the two
 * URL identities each at 1 prove the reads landed. Snapshotting earlier would let a case read its own
 * first list request as the refetch it is supposed to be proving.
 */
async function readyBoard(view: ReturnType<typeof render>, requests: string[]) {
  await waitFor(() => {
    expect(resultRows(view).length).toBe(ALL_ROWS.length);
    expect(alertCount(view)).toBe(0);
  });
  await waitFor(() => {
    expect(boardGetCount(requests)).toBe(1);
    expect(summaryGetCount(requests)).toBe(1);
  });
  return {
    reads: countReads(requests),
    board: boardGetCount(requests),
    summary: summaryGetCount(requests),
  };
}

test("a landed archive refetches the list read and leaves the summary bar alone", async () => {
  const requests = installStub({ status: 200 });
  const { view } = draw("/tasks?period=all&q=card&view=list");
  const base = await readyBoard(view, requests);
  const archive = buttonsNamed(view, "归档")[0];
  expect(archive).toBeDefined();
  await userEvent.click(archive as HTMLElement);
  /*
   * One POST, list read +1, summary read +0, and no alert. 51666086 froze the summary specifically:
   * invalidating `["tasks"]` does not match `["tasks-summary"]`, and this case is where that stays true
   * in behaviour instead of only being promised in a comment.
   */
  await waitFor(() => {
    expect(writes(requests)).toEqual(["POST /api/tasks/failed/archive"]);
    expect(countReads(requests)).toBe(base.reads + 1);
    expect(boardGetCount(requests)).toBe(base.board + 1);
    expect(summaryGetCount(requests)).toBe(base.summary);
    expect(alertCount(view)).toBe(0);
  });
  view.unmount();
});

test("a landed review travels the same seam, with the verb last in the path", async () => {
  const requests = installStub({ status: 200 });
  const { view } = draw("/tasks?period=all&q=card&view=list");
  const base = await readyBoard(view, requests);
  const review = buttonsNamed(view, "查收")[0];
  expect(review).toBeDefined();
  await userEvent.click(review as HTMLElement);
  /* The fixture row is literally id "review", so the path reads review twice: id first, verb second. */
  await waitFor(() => {
    expect(writes(requests)).toEqual(["POST /api/tasks/review/review"]);
    expect(countReads(requests)).toBe(base.reads + 1);
    expect(boardGetCount(requests)).toBe(base.board + 1);
    expect(summaryGetCount(requests)).toBe(base.summary);
    expect(alertCount(view)).toBe(0);
  });
  view.unmount();
});

test("a 404 is shown as the server's own refusal and refetches nothing", async () => {
  const requests = installStub({ status: 404, error: "任务已经不存在了。" });
  const { view } = draw("/tasks?period=all&q=card&view=list");
  const base = await readyBoard(view, requests);
  await userEvent.click(buttonsNamed(view, "归档")[0] as HTMLElement);
  /*
   * This is the defect A5 removes. The old route awaited a bare fetch and ignored the return value, so
   * a 404 resolved like any success: onSuccess invalidated, the board refetched to the same row, and a
   * person watched their click do nothing with no way to be told why. Now the refusal reaches the
   * screen, the list read does NOT move (success is the only path that invalidates), and the row is
   * still on the board because nothing was applied optimistically.
   */
  await waitFor(() => {
    expect(alertCount(view)).toBe(1);
    expect(alertText(view)).toContain("这个任务已经不在那里了");
    expect(alertText(view)).toContain("任务已经不存在了。");
    expect(alertText(view)).toContain("服务端拒绝（404）");
  });
  expect(writes(requests)).toEqual(["POST /api/tasks/failed/archive"]);
  expect(countReads(requests)).toBe(base.reads);
  expect(boardGetCount(requests)).toBe(base.board);
  expect(summaryGetCount(requests)).toBe(base.summary);
  expect(resultRows(view).length).toBe(ALL_ROWS.length);
  view.unmount();
});

test("a 409 refuses visibly and is not folded into either success or a silent retry", async () => {
  const requests = installStub({ status: 409, error: "这个状态不能归档。" });
  const { view } = draw("/tasks?period=all&q=card&view=list");
  const base = await readyBoard(view, requests);
  await userEvent.click(buttonsNamed(view, "归档")[0] as HTMLElement);
  /*
   * 409 and 404 share "the server said no" but not the meaning, so the status is named on screen. The
   * distinction can only come from RequestError.status, which is exactly what the old raw fetch threw
   * away -- one assertion per status, neither borrowed from the other.
   */
  await waitFor(() => {
    expect(alertCount(view)).toBe(1);
    expect(alertText(view)).toContain("这个任务当前状态不接受这个操作");
    expect(alertText(view)).toContain("这个状态不能归档。");
    expect(alertText(view)).toContain("服务端拒绝（409）");
  });
  expect(writes(requests)).toEqual(["POST /api/tasks/failed/archive"]);
  expect(countReads(requests)).toBe(base.reads);
  expect(boardGetCount(requests)).toBe(base.board);
  expect(summaryGetCount(requests)).toBe(base.summary);
  view.unmount();
});

test("a 500 says the outcome is unconfirmed and the POST is never replayed", async () => {
  const requests = installStub({ status: 500, rawBody: "<html>fixture internal detail</html>" });
  const { view } = draw("/tasks?period=all&q=card&view=list");
  const base = await readyBoard(view, requests);
  await userEvent.click(buttonsNamed(view, "归档")[0] as HTMLElement);
  /*
   * Two claims in one case. A 500 is not a refusal of the action, so it must not read like 404/409 --
   * the screen says 未确认. And because an unclear response may still have landed, the request count is
   * the load-bearing assertion: `retry: false` means ONE POST here, where a retried archive would
   * quietly double the write. Reads do not move either, since only success invalidates.
   */
  await waitFor(() => {
    expect(alertCount(view)).toBe(1);
    expect(alertText(view)).toContain("结果未确认，请刷新任务后核对");
    expect(alertText(view)).toContain("服务端返回 500");
  });
  expect(alertText(view)).not.toContain("稍后重试");
  expect(alertText(view)).not.toContain("internal detail");
  expect(writes(requests)).toEqual(["POST /api/tasks/failed/archive"]);
  expect(countReads(requests)).toBe(base.reads);
  expect(boardGetCount(requests)).toBe(base.board);
  expect(summaryGetCount(requests)).toBe(base.summary);
  view.unmount();
});

test("a request that never got an answer is unconfirmed too, and is never read as not submitted", async () => {
  const requests = installStub({ status: 0, transportFail: true });
  const { view } = draw("/tasks?period=all&q=card&view=list");
  const base = await readyBoard(view, requests);
  await userEvent.click(buttonsNamed(view, "归档")[0] as HTMLElement);
  /*
   * No status exists at all here, so `RequestError` never happens and the branch has to fall through to
   * the unconfirmed copy with 请求没有收到回应. The negative half matters as much: this screen may not
   * tell a person the archive did not go through, because it cannot know that.
   */
  await waitFor(() => {
    expect(alertCount(view)).toBe(1);
    expect(alertText(view)).toContain("结果未确认，请刷新任务后核对");
    expect(alertText(view)).toContain("请求没有收到回应");
  });
  expect(alertText(view)).not.toContain("没有提交");
  expect(alertText(view)).not.toContain("稍后重试");
  expect(alertText(view)).not.toContain("服务端拒绝");
  expect(writes(requests)).toEqual(["POST /api/tasks/failed/archive"]);
  expect(countReads(requests)).toBe(base.reads);
  view.unmount();
});

test("the 刷新任务 control moves both reads and leaves the write exactly where it was", async () => {
  const requests = installStub({ status: 404, error: "任务已经不存在了。" });
  const { view } = draw("/tasks?period=all&q=card&view=list");
  await readyBoard(view, requests);
  await userEvent.click(buttonsNamed(view, "归档")[0] as HTMLElement);
  await waitFor(() => {
    expect(alertCount(view)).toBe(1);
  });
  const afterFail = {
    board: boardGetCount(requests),
    summary: summaryGetCount(requests),
    writes: writes(requests).length,
  };
  const refresh = buttonsNamed(view, "刷新任务")[0];
  expect(refresh).toBeDefined();
  /*
   * The button is named for what its handler does, and this is the proof rather than the promise: both
   * reads move, the alert goes away through act.reset(), and the POST count is the same number it was
   * before the click. A control labelled 刷新任务 that re-archived the task would show up here as a
   * second write, not as a comment saying it does not happen.
   */
  await userEvent.click(refresh as HTMLElement);
  await waitFor(() => {
    expect(boardGetCount(requests)).toBe(afterFail.board + 1);
    expect(summaryGetCount(requests)).toBe(afterFail.summary + 1);
    expect(alertCount(view)).toBe(0);
  });
  expect(writes(requests).length).toBe(afterFail.writes);
  expect(resultRows(view).length).toBe(ALL_ROWS.length);
  view.unmount();
});
