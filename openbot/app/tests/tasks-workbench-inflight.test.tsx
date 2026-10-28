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
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { agentKeys } from "@/lib/agents/queries";
import { Route as TasksRoute } from "@/routes/_authed/_app/tasks";
import { settleReactWork } from "./settle-react-work";

/**
 * A6 asks a narrower question than A5 did. A5 proved the board can tell a refusal from a success; A6 has
 * to prove the board stops *itself* from writing twice while a write is still in the air -- and that it
 * stops only that card. The route now keeps a per-task gate in a ref, checked and written inside one
 * synchronous handler, with a state copy for the screen. So the only way to test that honestly is a
 * transport that can stay open: every POST this file makes is held until the case resolves it, which is
 * what lets a case observe "in flight" instead of guessing it from a count.
 *
 * What each case proves, and what none of them proves:
 *  - a second click on the SAME card does not reach the network -- proven through the drop path, which
 *    no `disabled` attribute covers, so the assertion tests the gate rather than the button style;
 *  - a DIFFERENT card still gets its own POST, which is the only way to show the gate is not the
 *    page-wide `act.isPending` the first draft proposed;
 *  - out-of-order completions release only their own card, which is what the third `onSettled` argument
 *    is for;
 *  - pending ends when the write settles, even while the refetch it triggered is still open.
 *  - none of this proves the server rejects a duplicate, dedupes across pages, or that an unclear write
 *    landed -- those claims stay outside the package, and no case here asserts them.
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

/** `failed` carries 归档, `review` carries 查收; a second failed row gives the drop path its target. */
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

/** How a held POST should be answered when the case settles it. */
type Outcome = { status: number; error?: string; rawBody?: string; transportFail?: boolean };

/**
 * The transport this file needs: reads answer (or deliberately stop answering), and every POST is held
 * open until the case settles it. Holding is the point -- a case that could not keep a write in the air
 * could only count requests after the fact, which says nothing about a gate that lives and dies inside
 * one render. `hangReads` makes "the write settled, the refetch it triggered has not" an observable
 * state rather than a race a case would otherwise hope to lose.
 */
function installStub() {
  const requests: string[] = [];
  const held: { path: string; settle: (o: Outcome) => void }[] = [];
  let readsHang = false;
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
                json ? JSON.stringify(o.error === undefined ? {} : { error: o.error }) : o.rawBody,
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
    if (readsHang) return new Promise<Response>(() => {});
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
    hangReads: () => {
      readsHang = true;
    },
  };
}

const writes = (requests: string[]) => requests.filter((line) => !line.startsWith("GET "));
const boardGetCount = (requests: string[]) =>
  requests.filter((line) => line.startsWith("GET /api/tasks?") && line.includes("q=card")).length;
const summaryGetCount = (requests: string[]) =>
  requests.filter((line) => line.startsWith("GET /api/tasks?") && !line.includes("q=")).length;

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

/**
 * Every row that carries this card's title. A card is printed in more than one place on purpose (the
 * 需要关注 region and the board itself), so "how many rows show this card" is never hardcoded -- a case
 * asks the screen, and cross-view consistency is then the same count of busy rows, not a wish.
 */
const cardRows = (view: ReturnType<typeof render>, title: string) =>
  [...view.container.querySelectorAll("li")].filter((li) => (li.textContent ?? "").includes(title));

const cardButtons = (view: ReturnType<typeof render>, title: string) =>
  cardRows(view, title).flatMap((li) => [...li.querySelectorAll("button")]);

const busyButtons = (view: ReturnType<typeof render>, title: string) =>
  cardButtons(view, title).filter((b) => b.getAttribute("aria-busy") === "true");

const blockedButtons = (view: ReturnType<typeof render>, title: string) =>
  cardButtons(view, title).filter((b) => b.disabled);

/** The only archiving drop target is 已结束 (archivesOnDrop), and a drop is a gesture `disabled` cannot
 *  cover -- which is what makes it the honest way to prove the gate is in the handler, not in the CSS. */
const dropOnFinished = (view: ReturnType<typeof render>, taskId: string) => {
  const lane = [...view.container.querySelectorAll('[role="group"]')].find(
    (n) => n.getAttribute("aria-label") === "已结束泳道",
  );
  expect(lane).toBeDefined();
  fireEvent.drop(lane as Element, { dataTransfer: { getData: () => taskId } });
};

const buttonsNamed = (view: ReturnType<typeof render>, text: string) =>
  [...view.container.querySelectorAll("button")].filter(
    (node) => (node.textContent ?? "").trim() === text,
  );

/** Both reads landed and nothing is refusing yet -- the baseline every case below snapshots after. */
async function readyBoard(stub: ReturnType<typeof installStub>, view: ReturnType<typeof render>) {
  /* 51668496 P2-1: a count of 1 is not a screen -- the row and its
     button must exist before a case snapshots a baseline. */
  await waitFor(() => {
    expect(cardRows(view, "failed card").length).toBeGreaterThan(0);
    expect(buttonsNamed(view, "归档").length).toBeGreaterThan(0);
    expect(view.container.querySelectorAll('[role="alert"]').length).toBe(0);
    expect(boardGetCount(stub.requests)).toBe(1);
    expect(summaryGetCount(stub.requests)).toBe(1);
  });
  return { board: boardGetCount(stub.requests), summary: summaryGetCount(stub.requests) };
}

test("a submitting card refuses a second write, and the drop path cannot walk around the gate", async () => {
  const stub = installStub();
  const { view } = draw("/tasks?period=all&q=card&view=lanes");
  await readyBoard(stub, view);
  const before = cardButtons(view, "failed card").length;
  expect(before).toBeGreaterThan(0);
  await userEvent.click(cardButtons(view, "failed card")[0]);
  /*
   * The write is in the air, so every row that prints this card must say so -- the region's copy and the
   * lane's copy read the same Set, which is why the count is taken from the screen rather than fixed
   * here. Then the same card is dropped onto 已结束: a gesture no `disabled` attribute covers, so what
   * stops it is the gate inside the handler.
   */
  await waitFor(() => {
    expect(stub.requests.filter((l) => l.startsWith("POST"))).toEqual(["POST /api/tasks/failed/archive"]);
    expect(busyButtons(view, "failed card").length).toBe(before);
    expect(blockedButtons(view, "failed card").length).toBe(before);
    expect(cardButtons(view, "failed card").every((n) => (n.textContent ?? "").trim() === "归档中…")).toBe(true);
  });
  dropOnFinished(view, "failed");
  expect(writes(stub.requests).length).toBe(1);
  expect(busyButtons(view, "second card").length).toBe(0);
  stub.settle(0, { status: 200 });
  await waitFor(() => {
    expect(busyButtons(view, "failed card").length).toBe(0);
    expect(boardGetCount(stub.requests)).toBe(2);
  });
  view.unmount();
});

test("review and archive share one gate per card, so a cross-action second attempt never posts", async () => {
  const stub = installStub();
  const { view } = draw("/tasks?period=all&q=card&view=lanes");
  await readyBoard(stub, view);
  await userEvent.click(cardButtons(view, "review card")[0]);
  await waitFor(() => {
    expect(writes(stub.requests)).toEqual(["POST /api/tasks/review/review"]);
    expect(busyButtons(view, "review card").length).toBeGreaterThan(0);
  });
  /*
   * `awaiting_review` is archivable by drop (archivesOnDrop), so this is the same card reached through
   * the OTHER verb -- the combination the frozen contract says must share one gate.
   */
  dropOnFinished(view, "review");
  expect(writes(stub.requests)).toEqual(["POST /api/tasks/review/review"]);
  stub.settle(0, { status: 200 });
  await waitFor(() => {
    expect(busyButtons(view, "review card").length).toBe(0);
  });
  view.unmount();
});

test("two different cards in flight at once each get their own write", async () => {
  const stub = installStub();
  const { view } = draw("/tasks?period=all&q=card&view=lanes");
  await readyBoard(stub, view);
  await userEvent.click(cardButtons(view, "failed card")[0]);
  /* The page-wide lock the first draft reached for would fail exactly here. */
  await waitFor(() => {
    expect(writes(stub.requests)).toEqual(["POST /api/tasks/failed/archive"]);
    expect(blockedButtons(view, "second card").length).toBe(0);
  });
  await userEvent.click(cardButtons(view, "second card")[0]);
  await waitFor(() => {
    expect(writes(stub.requests).sort()).toEqual([
      "POST /api/tasks/failed/archive",
      "POST /api/tasks/second/archive",
    ]);
    expect(busyButtons(view, "failed card").length).toBeGreaterThan(0);
    expect(busyButtons(view, "second card").length).toBeGreaterThan(0);
  });
  stub.settle(0, { status: 200 });
  stub.settle(1, { status: 200 });
  await waitFor(() => {
    expect(busyButtons(view, "failed card").length).toBe(0);
    expect(busyButtons(view, "second card").length).toBe(0);
  });
  view.unmount();
});

test("out-of-order completions release only the card that finished", async () => {
  const stub = installStub();
  const { view } = draw("/tasks?period=all&q=card&view=lanes");
  await readyBoard(stub, view);
  await userEvent.click(cardButtons(view, "failed card")[0]);
  await waitFor(() => {
    expect(writes(stub.requests).length).toBe(1);
  });
  await userEvent.click(cardButtons(view, "second card")[0]);
  await waitFor(() => {
    expect(writes(stub.requests).length).toBe(2);
  });
  /*
   * The SECOND call answers first. Each settlement reads its own variables, so finishing `second` must
   * leave `failed` -- the earlier call that is still open -- still gated. This is the case that would
   * break if the lock were keyed on `act.variables`, which names only the latest call.
   */
  stub.settle(1, { status: 200 });
  await waitFor(() => {
    expect(busyButtons(view, "second card").length).toBe(0);
    expect(busyButtons(view, "failed card").length).toBeGreaterThan(0);
    expect(blockedButtons(view, "failed card").length).toBeGreaterThan(0);
  });
  stub.settle(0, { status: 200 });
  await waitFor(() => {
    expect(busyButtons(view, "failed card").length).toBe(0);
  });
  view.unmount();
});

test("a refused write releases the card, twice over: 404 then 409 on the same task", async () => {
  const stub = installStub();
  const { view } = draw("/tasks?period=all&q=card&view=lanes");
  await readyBoard(stub, view);
  await userEvent.click(cardButtons(view, "failed card")[0]);
  stub.settle(0, { status: 404, error: "任务已经不存在了。" });
  /*
   * Refusal is a settled state. The card must become usable again with the refusal still on screen --
   * a gate that only opened on success would strand the person behind a disabled button for a task they
   * can no longer change.
   */
  await waitFor(() => {
    expect(view.container.querySelectorAll('[role="alert"]').length).toBe(1);
    expect((view.container.querySelector('[role="alert"]')?.textContent ?? "").replace(/\s+/g, " ")).toContain("服务端拒绝（404）");
    expect(busyButtons(view, "failed card").length).toBe(0);
    expect(blockedButtons(view, "failed card").length).toBe(0);
  });
  await userEvent.click(cardButtons(view, "failed card")[0]);
  await waitFor(() => {
    expect(writes(stub.requests)).toEqual([
      "POST /api/tasks/failed/archive",
      "POST /api/tasks/failed/archive",
    ]);
  });
  stub.settle(1, { status: 409, error: "这个状态不能归档。" });
  await waitFor(() => {
    expect((view.container.querySelector('[role="alert"]')?.textContent ?? "").replace(/\s+/g, " ")).toContain("服务端拒绝（409）");
    expect(busyButtons(view, "failed card").length).toBe(0);
  });
  view.unmount();
});

test("clearing a refusal by hand does not unlock another card that is still writing", async () => {
  const stub = installStub();
  const { view } = draw("/tasks?period=all&q=card&view=lanes");
  await readyBoard(stub, view);
  await userEvent.click(cardButtons(view, "failed card")[0]);
  await waitFor(() => {
    expect(writes(stub.requests).length).toBe(1);
  });
  await userEvent.click(cardButtons(view, "second card")[0]);
  await waitFor(() => {
    expect(writes(stub.requests).length).toBe(2);
  });
  stub.settle(1, { status: 409, error: "这个状态不能归档。" });
  /* 51668496 P2-2: the observer follows the most recent call, so the refusal this case can show is
     `second`'s. Failing the earlier call and still expecting the alert to name it would only pass by
     bending production logic. */
  await waitFor(() => {
    expect(view.container.querySelectorAll('[role="alert"]').length).toBe(1);
    expect((view.container.querySelector('[role="alert"]')?.textContent ?? "").replace(/\s+/g, " ")).toContain("这个状态不能归档。");
    expect(busyButtons(view, "second card").length).toBe(0);
    expect(busyButtons(view, "failed card").length).toBeGreaterThan(0);
  });
  const base = busyButtons(view, "failed card").length;
  expect(base).toBeGreaterThan(0);
  /*
   * 刷新任务 calls act.reset() plus two refetches. Reset clears the displayed refusal; it must NOT
   * reach into the gate of the card that is still in the air -- that lock is owned by the settlement,
   * which has not happened yet. Reads move, writes do not.
   */
  const before = writes(stub.requests).length;
  await userEvent.click(buttonsNamed(view, "刷新任务")[0]);
  await waitFor(() => {
    expect(view.container.querySelectorAll('[role="alert"]').length).toBe(0);
    expect(boardGetCount(stub.requests)).toBeGreaterThan(1);
    expect(summaryGetCount(stub.requests)).toBeGreaterThan(1);
  });
  expect(writes(stub.requests).length).toBe(before);
  expect(busyButtons(view, "failed card").length).toBe(base);
  expect(blockedButtons(view, "failed card").length).toBe(base);
  /* The older write settles last and only its own settlement clears its gate. */
  stub.settle(0, { status: 200 });
  await waitFor(() => {
    expect(busyButtons(view, "failed card").length).toBe(0);
  });
  view.unmount();
});

test("pending ends when the write settles, even while the refetch it started is still open", async () => {
  const stub = installStub();
  const { view } = draw("/tasks?period=all&q=card&view=lanes");
  await readyBoard(stub, view);
  await userEvent.click(cardButtons(view, "failed card")[0]);
  await waitFor(() => {
    expect(writes(stub.requests)).toEqual(["POST /api/tasks/failed/archive"]);
  });
  /*
   * From here the server answers no read at all, so the invalidate the success triggers can never
   * complete. If pending were tied to the query, the card would stay dark forever; tied to the
   * settlement, it lifts the moment the write settles.
   */
  stub.hangReads();
  const reads = boardGetCount(stub.requests);
  stub.settle(0, { status: 200 });
  /* 51668496 P2-3: the void invalidate really does start a list refetch, so "reads must not move" was
     the wrong ask. The split to show: the list GET starts and stays unanswered while pending is over. */
  await waitFor(() => {
    expect(boardGetCount(stub.requests)).toBe(reads + 1);
    expect(busyButtons(view, "failed card").length).toBe(0);
    expect(blockedButtons(view, "failed card").length).toBe(0);
  });
  expect(summaryGetCount(stub.requests)).toBe(1);
  expect(writes(stub.requests)).toEqual(["POST /api/tasks/failed/archive"]);
  view.unmount();
});

test("one card entered twice inside a single outer act leaves one mutation object and one write", async () => {
  const stub = installStub();
  const { queryClient, view } = draw("/tasks?period=all&q=card&view=lanes");
  await readyBoard(stub, view);
  /*
   * 51670957's r3 shape. Both entries are dispatched inside ONE outer `await act(async () => ...)`,
   * and inside it before any await -- so no render can commit between them. The witness is object
   * identity in the mutation cache the Provider actually uses: the second entry must not add another
   * mutation, and the first must still BE there -- a swap-out/swap-in could keep a count at 1 and
   * still be wrong. No fabricated observer, no mocked hook or counter: the cache the library owns is
   * the measurement, and nothing in this window resets, unmounts, clears or subscribes.
   */
  const cache = queryClient.getMutationCache();
  const seen = new Set(cache.getAll());
  const addedOf = () => cache.getAll().filter((mutation) => !seen.has(mutation));
  let firstMutation: ReturnType<typeof cache.getAll>[number] | null = null;
  const expectSameSingle = () => {
    const live = addedOf();
    expect(live.length).toBe(1);
    expect(live[0]).toBe(firstMutation);
  };
  await act(async () => {
    fireEvent.click(cardButtons(view, "failed card")[0]);
    const added = addedOf();
    expect(added.length).toBe(1);
    firstMutation = added[0];
    dropOnFinished(view, "failed");
    expectSameSingle();
  });
  await waitFor(() => {
    expect(writes(stub.requests)).toEqual(["POST /api/tasks/failed/archive"]);
    expect(stub.held.length).toBe(1);
  });
  expectSameSingle();
  stub.settle(0, { status: 200 });
  await waitFor(() => {
    expect(busyButtons(view, "failed card").length).toBe(0);
  });
  expectSameSingle();
  expect(writes(stub.requests)).toEqual(["POST /api/tasks/failed/archive"]);
  view.unmount();
});
