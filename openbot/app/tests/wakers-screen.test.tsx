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
import type { AgentProfile } from "@/lib/agents/queries";
import { agentKeys } from "@/lib/agents/queries";
import {
  runningTasksQueryOptions,
  type WakerGroup,
  wakerGroupKeys,
} from "@/lib/waker-groups/queries";
import { Route as WakersRoute } from "@/routes/_authed/_app/wakers";
import { settleReactWork } from "./settle-react-work";

/**
 * Ticket 023 acceptance at the screen where a person names a crew (spec D1-D5).
 *
 * The reads are seeded, because the two facts worth asserting are on different sides of the wiring:
 * that the status line says what the board and the roster actually say, and that tapping a coworker's
 * chip sends the whole roster rather than a delta.
 */
let registeredHere = false;
beforeAll(() => {
  // One happy-dom global per process: registering twice throws in `beforeAll`, which silently deletes
  // this file's tests from the run — and not unregistering deletes the next file's.
  if (!("document" in globalThis)) {
    GlobalRegistrator.register();
    registeredHere = true;
  }
});
afterAll(async () => {
  if (!registeredHere) return;
  // Drain React before the document goes away, for the reason recorded in `settle-react-work.ts`.
  await settleReactWork();
  GlobalRegistrator.unregister();
});
afterEach(() => {
  cleanup();
  calls.length = 0;
  globalThis.fetch = originalFetch;
});

const originalFetch = globalThis.fetch;
const calls: { method: string; path: string; body: unknown }[] = [];
/**
 * Only the writes, because a successful one invalidates the list and the screen refetches it — those
 * reads are the cache doing its job, and counting them would test the round trips instead.
 */
const writes = () => calls.filter((entry) => entry.method !== "GET");

const base: AgentProfile = {
  id: "agent-1",
  name: "Backend Engineer",
  title: "Writes the migration",
  roleDescription: "Owns schema changes.",
  avatarSeed: "a1",
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
};

const reviewer: AgentProfile = {
  ...base,
  id: "agent-2",
  name: "Code Reviewer",
};
const qa: AgentProfile = { ...base, id: "agent-3", name: "QA Engineer" };
const parked: AgentProfile = {
  ...base,
  id: "agent-4",
  name: "Night Auditor",
  hidden: true,
};

const crew: WakerGroup = {
  id: "crew-1",
  name: "编程小组",
  description: null,
  members: [
    { agentId: "agent-1", position: 0 },
    { agentId: "agent-2", position: 1 },
  ],
};

let queryClientForDraw = new QueryClient();

function seed(
  agents: AgentProfile[],
  crews: WakerGroup[],
  runningIds: string[],
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  /*
   * Split the way the server splits them: `GET /api/agents` answers the active roster and
   * `?hidden=true` answers ONLY the switched-off coworkers. Seeding every coworker into the first list
   * is how this file once passed while the real page could never show a single 暂停 card.
   */
  queryClient.setQueryData(
    agentKeys.list(false),
    agents.filter((agent) => !agent.hidden),
  );
  queryClient.setQueryData(
    agentKeys.list(true),
    agents.filter((agent) => agent.hidden),
  );
  queryClient.setQueryData(wakerGroupKeys.list(), crews);
  queryClient.setQueryData(
    runningTasksQueryOptions().queryKey,
    runningIds.map((id) => ({
      id: `task-${id}`,
      executorAgentId: id,
      status: "running",
    })),
  );
  return queryClient;
}

function draw() {
  const root = createRootRoute({ component: () => <Outlet /> });
  const router = createRouter({
    context: {},
    history: createMemoryHistory({ initialEntries: ["/wakers"] }),
    routeTree: root.addChildren([
      WakersRoute.update({
        getParentRoute: () => root,
        path: "/wakers",
      } as never),
      // The card's "Open" is a deep link into the roster's editor, and a Link needs its address to
      // resolve. The generator's options are wider than this literal; the tree only needs the path.
      createRoute({
        getParentRoute: () => root,
        path: "/agents",
        component: () => null,
      } as never),
    ]),
  });
  return render(
    <QueryClientProvider client={queryClientForDraw}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

test("the status line says what the board says, and the roster's own switch for the rest", async () => {
  queryClientForDraw = seed([base, reviewer, parked], [crew], ["agent-1"]);
  const screen = draw();

  await waitFor(() =>
    expect(screen.getByText("Backend Engineer")).toBeTruthy(),
  );
  // Working because a task card is running now, not because a status column said so.
  expect(screen.getByText("正在处理一个任务。 · 编程小组")).toBeTruthy();
  // The crew it belongs to is named on the card, which is what makes a group filter worth having.
  expect(screen.getByText("当前没有运行中的任务。 · 编程小组")).toBeTruthy();
  // Paused is the roster's hidden flag — the only pause this deployment has.
  expect(screen.getByText("在花名册里已停用。")).toBeTruthy();
  // Spec D1/D4: one vocabulary on the card and on the filter -- 在线 / 休息 / 暂停 (CONTEXT.md).
  expect(screen.getByRole("button", { name: "在线 (1)" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "暂停 (1)" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "休息 (1)" })).toBeTruthy();
  // And each card wears its own word, not only a sentence a person has to read to the end of.
  expect(screen.getByText("在线")).toBeTruthy();
  expect(screen.getByText("休息")).toBeTruthy();
  expect(screen.getByText("暂停")).toBeTruthy();
});

test("the groups tab edits a crew by sending the whole roster", async () => {
  queryClientForDraw = seed([base, reviewer, qa], [crew], []);
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    calls.push({
      method: init?.method ?? "GET",
      path: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    // A successful write invalidates both reads, so each has to keep answering — a screen that
    // refetches into a malformed envelope would fail for the wrong reason.
    if ((init?.method ?? "GET") === "GET")
      return Response.json(
        String(input).includes("/api/tasks")
          ? { tasks: [] }
          : { groups: [crew] },
      );
    return Response.json({ group: { ...crew, members: [] } });
  }) as typeof fetch;

  const screen = draw();
  await waitFor(() => expect(screen.getByText("小组")).toBeTruthy());
  await userEvent.click(screen.getByRole("button", { name: "小组" }));

  expect(await screen.findByText("编程小组")).toBeTruthy();
  // The order a person put them in is shown, because a pipeline crew reads as a sequence.
  expect(
    screen.getByText("顺序：Backend Engineer → Code Reviewer"),
  ).toBeTruthy();
  // The crew is a way to read the board, not only a way to name people. The URL carries the roster
  // under `crew`; the server's own parameter is a different name and nobody above the transport
  // should have to know which one a screen used.
  const href = screen
    .getByRole("link", { name: "在看板上看" })
    .getAttribute("href");
  expect(href).toContain("crew=");
  expect(href).toContain("agent-1");
  expect(href).toContain("agent-2");

  await userEvent.click(screen.getByRole("button", { name: "QA Engineer" }));
  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(writes()[0]?.method).toBe("PUT");
  expect(writes()[0]?.path).toBe("/api/waker-groups/crew-1/members");
  // The whole roster, in order, with the newcomer last — not an add-one delta the server would have
  // to interpret.
  expect(writes()[0]?.body).toEqual({
    agentIds: ["agent-1", "agent-2", "agent-3"],
  });
});

test("a new crew is created by name, and its purpose is optional", async () => {
  queryClientForDraw = seed([base], [], []);
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    calls.push({
      method: init?.method ?? "GET",
      path: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if ((init?.method ?? "GET") === "GET")
      return Response.json(
        String(input).includes("/api/tasks") ? { tasks: [] } : { groups: [] },
      );
    return Response.json({
      group: { id: "crew-2", name: "值班小组", members: [] },
    });
  }) as typeof fetch;

  const screen = draw();
  await waitFor(() => expect(screen.getByText("小组")).toBeTruthy());
  await userEvent.click(screen.getByRole("button", { name: "小组" }));
  expect(screen.getByText(/还没有小组/)).toBeTruthy();

  await userEvent.type(screen.getByPlaceholderText("小组名称"), "值班小组");
  await userEvent.click(screen.getByRole("button", { name: "新建小组" }));

  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(writes()[0]?.method).toBe("POST");
  expect(writes()[0]?.path).toBe("/api/waker-groups");
  expect(writes()[0]?.body).toEqual({ name: "值班小组", description: "" });
});

test("a name the workspace already used comes back as the server's own sentence", async () => {
  queryClientForDraw = seed([base], [crew], []);
  globalThis.fetch = (async (
    _input: string | URL | Request,
    _init?: RequestInit,
  ): Promise<Response> =>
    Response.json(
      { error: "This workspace already has a group by that name." },
      { status: 409 },
    )) as typeof fetch;

  const screen = draw();
  await waitFor(() => expect(screen.getByText("小组")).toBeTruthy());
  await userEvent.click(screen.getByRole("button", { name: "小组" }));
  await userEvent.type(screen.getByPlaceholderText("小组名称"), "编程小组");
  await userEvent.click(screen.getByRole("button", { name: "新建小组" }));

  expect(
    await screen.findByText("This workspace already has a group by that name."),
  ).toBeTruthy();
});

/**
 * The branch `cce3115` added, which shipped without an assertion.
 *
 * The other tests in this file seed the running-tasks key, so they never reach the read at all.
 * Here it is left unseeded and the endpoint answers 500: the screen must say the status is not
 * known, rather than fall back to the confident "nothing running" that a failed read used to
 * produce for every coworker at once.
 */
test("a board that cannot be read is said as unknown, not as idle", async () => {
  globalThis.fetch = (async (
    _input: string | URL | Request,
    _init?: RequestInit,
  ): Promise<Response> =>
    new Response(JSON.stringify({ error: "nope" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(agentKeys.list(false), [base, reviewer]);
  queryClient.setQueryData(agentKeys.list(true), [parked]);
  queryClient.setQueryData(wakerGroupKeys.list(), [crew]);
  queryClientForDraw = queryClient;

  const screen = draw();
  await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
  // The page-level line, named by its own words now that the cards say it too.
  expect(screen.getByText(/所以下面显示的状态无法确认/)).toBeTruthy();
  /*
   * The banner alone was never the answer, and this is why: a page-wide line explains the screen,
   * while the cards go on claiming "当前没有运行中的任务。" for every coworker — a statement the
   * screen had just admitted it could not see. So the cards themselves have to say they do not know,
   * and none of them may keep asserting the one thing the failed read removed. A switched-off
   * coworker is excluded on purpose: that answer comes from the roster, not from the board.
   */
  expect(
    screen.getAllByText(/现在有没有在跑不确定/).length,
  ).toBeGreaterThanOrEqual(2);
  expect(screen.queryByText(/当前没有运行中的任务/)).toBeNull();
  // The badge says the same: unknown, never dressed up as 休息. The paused one keeps its own word.
  expect(screen.getAllByText("状态未知").length).toBeGreaterThanOrEqual(2);
  expect(screen.queryByText("休息")).toBeNull();
  expect(screen.getByText("暂停")).toBeTruthy();
  // The roster still renders: not knowing who is busy is not the same as showing nothing.
  expect(screen.getByText("Backend Engineer")).toBeTruthy();
  expect(screen.getByText("Night Auditor")).toBeTruthy();
});
