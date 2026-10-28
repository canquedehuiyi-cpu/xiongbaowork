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
 * A7 asks two questions the first 45 cases cannot answer, and both are about *attribution* rather than
 * about counting.
 *
 *  1. Which alert region is on screen, and when? The route draws one role=alert block for a failed write
 *     (with a 刷新任务 button) and QueryError draws another for a failed read (with a 重试 button). Two
 *     same-named nodes means a bare `querySelectorAll` length cannot say which failure the person is
 *     being told about, and matching on prose is no better -- a read error's own sentence can contain
 *     服务端 or 结果未确认. So every case below anchors on the button inside the block, which is the only
 *     handle the two regions own separately.
 *  2. Which read did a successful write actually re-run? At the all-window address the board read and
 *     the summary read go to byte-identical URLs, so the request log cannot attribute a refetch at all.
 *     The witnesses here come from the query cache instead: per-key subscription to the public
 *     fetchStatus, unsubscribed in finally, never dataUpdatedAt (two refetches in one millisecond
 *     compare equal) and never a private field of the SDK.
 *
 * Both files in this package are definitions. Nothing here was executed: 0 run, and the behaviour it
 * will judge belongs to the real 5.102.2 that only the cloud can exercise.
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
  row("second", "failed"),
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

/**
 * The read-side sentence is chosen to be hostile to a loose message match: it says 结果未确认 and 服务端
 * the way the write-side region does, so any locator built on that vocabulary finds both blocks. The
 * fixture body carries a private marker so leakage onto the screen is detectable.
 */
const READ_FAIL_SENTENCE = "结果未确认，服务端 0 号夹具读侧句";
const RAW_FIXTURE_MARKER = "fixture-internal-detail";

type Outcome = { status: number; error?: string; rawBody?: string; transportFail?: boolean };

/**
 * Reads answer (or are told to fail) and every POST is held open until the case settles it -- the shape
 * A6 already needed, because "this write has not come back yet" is the state C1 must observe rather than
 * infer afterwards. failReads only ever answers /api/tasks?: the devices read stays healthy, so a failed
 * read cannot smuggle the third region (设备加载失败) onto the screen by accident.
 */
function installStub() {
  const requests: string[] = [];
  const held: { path: string; settle: (o: Outcome) => void }[] = [];
  let readOutcome: Outcome | null = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    requests.push(method + " " + path);
    if (method === "POST") {
      return new Promise<Response>((resolve, reject) => {
        held.push({
          path,
          settle: (o) => {
            if (o.transportFail) {
              reject(new Error("transport down"));
              return;
            }
            const json = o.rawBody === undefined;
            resolve(
              new Response(
                json
                  ? JSON.stringify(o.error === undefined ? {} : { error: o.error })
                  : o.rawBody,
                {
                  headers: { "content-type": json ? "application/json" : "text/html" },
                  status: o.status,
                },
              ),
            );
          },
        });
      });
    }
    if (path.startsWith("/api/tasks?") && readOutcome !== null) {
      const o = readOutcome;
      const json = o.rawBody === undefined;
      return new Response(
        json ? JSON.stringify({ error: o.error }) : o.rawBody,
        {
          headers: { "content-type": json ? "application/json" : "text/html" },
          status: o.status,
        },
      );
    }
    const body = path.startsWith("/api/tasks?")
      ? { tasks: ALL_ROWS }
      : path.startsWith("/api/devices")
        ? { devices: [DEVICE] }
        : { agents: [] };
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
      status: 200,
    });
  }) as typeof fetch;
  return {
    requests,
    held,
    settle: (i: number, o: Outcome) => held[i].settle(o),
    failReads: (o: Outcome) => {
      readOutcome = o;
    },
  };
}

const writes = (requests: string[]) => requests.filter((line) => !line.startsWith("GET "));
const taskReads = (requests: string[]) =>
  requests.filter((line) => line.startsWith("GET /api/tasks?"));

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

/** Real route, real router, real QueryClient, real taskAction and client. Only HTTP is held open. */
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
  return { queryClient, view };
}

const buttonsNamed = (view: ReturnType<typeof render>, text: string) =>
  [...view.container.querySelectorAll("button")].filter(
    (node) => (node.textContent ?? "").trim() === text,
  );

const cardRows = (view: ReturnType<typeof render>, title: string) =>
  [...view.container.querySelectorAll("li")].filter((li) => (li.textContent ?? "").includes(title));

const cardButtons = (view: ReturnType<typeof render>, title: string) =>
  cardRows(view, title).flatMap((li) => [...li.querySelectorAll("button")]);

const busyButtons = (view: ReturnType<typeof render>, title: string) =>
  cardButtons(view, title).filter((b) => b.getAttribute("aria-busy") === "true");

const blockText = (node: Element) => (node.textContent ?? "").replace(/\s+/g, " ").trim();

const alertBlocks = (view: ReturnType<typeof render>) => [
  ...view.container.querySelectorAll('[role="alert"]'),
];

/**
 * The write-side region owns exactly one handle nobody else owns: a 刷新任务 button inside it. Anchoring
 * on that (not on a bare count, not on words like 服务端 or 结果未确认) is what makes the two regions
 * attributable -- the read side can say those same words, and 51677801 requires it be proved, not hoped.
 */
const writeAlerts = (view: ReturnType<typeof render>) =>
  alertBlocks(view).filter((n) => buttonsNamed2(n, "刷新任务").length > 0);

/** The read-side region owns the other handle, which reads 正在重试… while a retry is still in the air. */
const readAlerts = (view: ReturnType<typeof render>) =>
  alertBlocks(view).filter(
    (n) => buttonsNamed2(n, "重试").length + buttonsNamed2(n, "正在重试…").length > 0,
  );

function buttonsNamed2(node: Element, text: string) {
  return [...node.querySelectorAll("button")].filter(
    (b) => (b.textContent ?? "").trim() === text,
  );
}

/** Both reads, byte for byte, the same request line -- the reason C3 cannot use the log to attribute. */
const TASKS_READ_KEY = ["tasks", "all", "", "", "", ""];
const SUMMARY_READ_KEY = ["tasks-summary", "all", "", ""];

const sameKey = (a: readonly unknown[], b: readonly string[]) =>
  a.length === b.length && a.every((value, index) => value === b[index]);

function requireQuery(queryClient: QueryClient, queryKey: string[]) {
  const found = queryClient.getQueryCache().find({ queryKey });
  if (found === undefined) {
    throw new Error("no query mounted for key " + JSON.stringify(queryKey));
  }
  return found;
}

/**
 * Public-surface witness: the cache subscription's events carry the query, whose state exposes
 * fetchStatus. Counting edges (idle -> fetching) means one refetch contributes exactly one, and the
 * key comparison is what makes "which read moved" a fact rather than a guess. Nothing here reads a
 * private field, and nothing compares dataUpdatedAt.
 */
function watchKeyFetches(queryClient: QueryClient, queryKey: string[]) {
  const query = requireQuery(queryClient, queryKey);
  let started = 0;
  let finished = 0;
  let matched = 0;
  let wasFetching = query.state.fetchStatus === "fetching";
  const stop = queryClient.getQueryCache().subscribe((event) => {
    if (!sameKey(event.query.queryKey, queryKey)) return;
    matched += 1;
    const fetching = event.query.state.fetchStatus === "fetching";
    if (fetching && !wasFetching) started += 1;
    if (!fetching && wasFetching) finished += 1;
    wasFetching = fetching;
  });
  return {
    query,
    started: () => started,
    finished: () => finished,
    matched: () => matched,
    stop,
  };
}

async function readyBoard(stub: ReturnType<typeof installStub>, view: ReturnType<typeof render>) {
  /* A count of reads is not a screen: the row, its button, and an empty alert region all have to hold
     before a case is allowed to snapshot anything. */
  await waitFor(() => {
    expect(cardRows(view, "failed card").length).toBeGreaterThan(0);
    expect(buttonsNamed(view, "归档").length).toBeGreaterThan(0);
    expect(alertBlocks(view).length).toBe(0);
    expect(taskReads(stub.requests).length).toBeGreaterThan(0);
  });
  return { reads: taskReads(stub.requests).length };
}

test("a held archive keeps the unconfirmed region off the screen while the write is in the air", async () => {
  const stub = installStub();
  const { view } = draw("/tasks?period=all&q=card&view=list");
  const base = await readyBoard(stub, view);
  const rows = cardButtons(view, "failed card").length;
  expect(rows).toBeGreaterThan(0);
  await userEvent.click(buttonsNamed(view, "归档")[0] as HTMLElement);
  await waitFor(() => {
    expect(stub.held.length).toBe(1);
    expect(writes(stub.requests)).toEqual(["POST /api/tasks/failed/archive"]);
    expect(busyButtons(view, "failed card").length).toBe(rows);
    expect(
      cardButtons(view, "failed card").every(
        (n) => (n.textContent ?? "").trim() === "归档中…",
      ),
    ).toBe(true);
  });
  /* The claim C1 exists for: nothing has been decided yet, so nothing may be said. */
  expect(writeAlerts(view).length).toBe(0);
  expect(readAlerts(view).length).toBe(0);
  expect(alertBlocks(view).length).toBe(0);
  expect(taskReads(stub.requests).length).toBe(base.reads);
  view.unmount();
});

test("settling that held write with a non-JSON 500 puts one unconfirmed region on screen, and only one", async () => {
  const stub = installStub();
  const { view } = draw("/tasks?period=all&q=card&view=list");
  const base = await readyBoard(stub, view);
  const _rows = cardButtons(view, "failed card").length;
  await userEvent.click(buttonsNamed(view, "归档")[0] as HTMLElement);
  await waitFor(() => {
    expect(stub.held.length).toBe(1);
    expect(writeAlerts(view).length).toBe(0);
  });
  /* Non-2xx with a body that is not JSON: this is the branch that must not borrow the retry-flavoured
     fallback, and the fixture's private marker must never reach the screen. */
  stub.settle(0, { status: 500, rawBody: "<html>" + RAW_FIXTURE_MARKER + "</html>" });
  await waitFor(() => {
    expect(writeAlerts(view).length).toBe(1);
    expect(readAlerts(view).length).toBe(0);
    expect(busyButtons(view, "failed card").length).toBe(0);
  });
  const [only] = writeAlerts(view);
  if (only === undefined) throw new Error("write-side region disappeared between assertions");
  const said = blockText(only);
  expect(said).toContain("结果未确认，请刷新任务后核对");
  expect(said).toContain("服务端返回 500");
  expect(said).not.toContain("稍后重试");
  expect(said).not.toContain(RAW_FIXTURE_MARKER);
  expect(alertBlocks(view).length).toBe(1);
  expect(writes(stub.requests)).toEqual(["POST /api/tasks/failed/archive"]);
  expect(taskReads(stub.requests).length).toBe(base.reads);
  view.unmount();
});

test("a read refusal and a write refusal sit on screen as two regions, each told by its own button", async () => {
  const stub = installStub();
  const { view } = draw("/tasks?period=all&q=card&view=list");
  await readyBoard(stub, view);
  await userEvent.click(buttonsNamed(view, "归档")[0] as HTMLElement);
  await waitFor(() => expect(stub.held.length).toBe(1));
  /* Fail every later read, then let this write succeed: onSuccess invalidates, the refetch that
     follows answers 500, and the read side now owns a region of its own. */
  stub.failReads({ status: 500, error: READ_FAIL_SENTENCE });
  stub.settle(0, { status: 200 });
  await waitFor(() => {
    expect(readAlerts(view).length).toBe(1);
    expect(writeAlerts(view).length).toBe(0);
  });
  await userEvent.click(cardButtons(view, "second card")[0] as HTMLElement);
  await waitFor(() => expect(stub.held.length).toBe(2));
  stub.settle(1, { status: 409, error: "这个状态不能归档。" });
  await waitFor(() => {
    expect(writeAlerts(view).length).toBe(1);
    expect(readAlerts(view).length).toBe(1);
  });
  const [writeBlock] = writeAlerts(view);
  const [readBlock] = readAlerts(view);
  if (writeBlock === undefined || readBlock === undefined) {
    throw new Error("one of the two regions vanished");
  }
  const saidWrite = blockText(writeBlock);
  const saidRead = blockText(readBlock);
  expect(saidWrite).toContain("服务端拒绝（409）");
  expect(saidWrite).toContain("这个状态不能归档。");
  expect(saidRead).toContain("任务加载失败");
  expect(saidRead).toContain(READ_FAIL_SENTENCE);
  /* Neither region may leak the other's handle, and neither may say 稍后重试. */
  expect(saidWrite).not.toContain("任务加载失败");
  expect(saidRead).not.toContain("刷新任务");
  expect(saidWrite).not.toContain("稍后重试");
  expect(saidRead).not.toContain("稍后重试");
  /* The witness for why button anchoring is required: a vocabulary match claims both blocks, and a
     bare count cannot say which failure a person was told about. */
  expect(alertBlocks(view).length).toBe(2);
  const loose = alertBlocks(view).filter((n) => /服务端|结果未确认/.test(blockText(n)));
  expect(loose.length).toBe(2);
  expect(writes(stub.requests)).toEqual([
    "POST /api/tasks/failed/archive",
    "POST /api/tasks/second/archive",
  ]);
  view.unmount();
});

test("with both reads on one identical URL, the archive refetch belongs to the tasks key alone", async () => {
  const stub = installStub();
  const { queryClient, view } = draw("/tasks?period=all");
  await readyBoard(stub, view);
  const readLines = taskReads(stub.requests);
  const [firstLine] = readLines;
  if (firstLine === undefined) throw new Error("no task read was issued");
  /* The precondition this whole case exists for: log-based attribution is impossible here. */
  expect(readLines.length).toBe(2);
  expect(readLines.every((line) => line === firstLine)).toBe(true);
  await waitFor(() => {
    expect(requireQuery(queryClient, TASKS_READ_KEY).state.status).toBe("success");
    expect(requireQuery(queryClient, TASKS_READ_KEY).state.fetchStatus).toBe("idle");
    expect(requireQuery(queryClient, SUMMARY_READ_KEY).state.status).toBe("success");
    expect(requireQuery(queryClient, SUMMARY_READ_KEY).state.fetchStatus).toBe("idle");
  });
  const board = watchKeyFetches(queryClient, TASKS_READ_KEY);
  const summary = watchKeyFetches(queryClient, SUMMARY_READ_KEY);
  try {
    expect(board.matched()).toBe(0);
    await userEvent.click(buttonsNamed(view, "归档")[0] as HTMLElement);
    await waitFor(() => expect(stub.held.length).toBe(1));
    stub.settle(0, { status: 200 });
    await waitFor(() => {
      expect(board.started()).toBe(1);
      expect(board.finished()).toBe(1);
      expect(summary.started()).toBe(0);
      expect(summary.finished()).toBe(0);
    });
    expect(writes(stub.requests)).toEqual(["POST /api/tasks/failed/archive"]);
    expect(taskReads(stub.requests).length).toBe(3);
    expect(writeAlerts(view).length).toBe(0);
  } finally {
    board.stop();
    summary.stop();
  }
  view.unmount();
});

test("the counters follow the key that was refetched, which is what makes the case above load-bearing", async () => {
  const stub = installStub();
  const { queryClient, view } = draw("/tasks?period=all");
  await readyBoard(stub, view);
  await waitFor(() => {
    expect(requireQuery(queryClient, TASKS_READ_KEY).state.fetchStatus).toBe("idle");
    expect(requireQuery(queryClient, SUMMARY_READ_KEY).state.fetchStatus).toBe("idle");
  });
  const board = watchKeyFetches(queryClient, TASKS_READ_KEY);
  const summary = watchKeyFetches(queryClient, SUMMARY_READ_KEY);
  try {
    /* Same-URL world, public API only: whichever key is refetched, only that key's counter moves. A
       summary-only invalidation, or none at all, would therefore fail the previous case rather than
       pass it quietly -- that is the discrimination Root asked for, not a rephrased count. */
    await queryClient.refetchQueries({ queryKey: SUMMARY_READ_KEY, exact: true });
    expect(summary.started()).toBe(1);
    expect(summary.finished()).toBe(1);
    expect(board.started()).toBe(0);
    await queryClient.refetchQueries({ queryKey: TASKS_READ_KEY, exact: true });
    expect(board.started()).toBe(1);
    expect(board.finished()).toBe(1);
    expect(summary.started()).toBe(1);
  } finally {
    board.stop();
    summary.stop();
  }
  view.unmount();
});
