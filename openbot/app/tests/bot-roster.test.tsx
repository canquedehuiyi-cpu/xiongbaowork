import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { BotRoster } from "@/components/bots/bot-roster";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { settleReactWork } from "./settle-react-work";

/**
 * The Bots roster: one list of every Bot a person can reach, replacing the Bots, Agents and Team
 * Bots screens. 熊宝（M5b）：中文分区名，名单默认画成员工墙的卡片；这里多数用例画列表（`view: "list"`），
 * 和上游一样一行一位员工。 The harness is this repository's: `GlobalRegistrator` around the file, `cleanup`
 * after each test, a `QueryClient` per test with `retry: false`, and `fetch` stubbed per test.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

function bot(overrides: Partial<AgentProfile> & { id: string }): AgentProfile {
  return {
    name: overrides.id,
    title: "Title",
    roleDescription: "Role",
    avatarSeed: "seed",
    visibility: "private",
    endpoint: null,
    builtIn: true,
    hasAuth: false,
    hasCallbackToken: false,
    modelRef: null,
    persona: null,
    isolated: false,
    isolationActive: false,
    isolationOffReason: null,
    hidden: false,
    pinned: false,
    systemOwned: false,
    canManage: true,
    mine: true,
    ...overrides,
  };
}

/**
 * Serves the visible roster, the hidden roster, and an empty attention list, with nothing found by
 * check-ins and no tasks.
 */
function serving(
  visible: AgentProfile[],
  hidden: AgentProfile[],
  attention: Record<string, unknown>[] = [],
) {
  global.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/bots/attention"))
      return Response.json({ bots: attention, lastPingId: null });
    if (url === "/api/proactive/suggestions")
      return Response.json({ suggestions: [] });
    if (url === "/api/tasks") return Response.json({ tasks: [] });
    // 熊宝的任务读取在 `/api/bot-tasks`（上游是 `/api/tasks`，熊宝那里是任务看板）。
    if (url === "/api/bot-tasks") return Response.json({ tasks: [] });
    if (url.startsWith("/api/channels"))
      return Response.json({ channels: [], nextCursor: null });
    return Response.json({
      agents: url.includes("hidden=true") ? hidden : visible,
    });
  }) as unknown as typeof fetch;
}

let queryClient: QueryClient;
beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
});

function draw(view: "list" | "cards" = "list") {
  const rootRoute = createRootRoute();
  const routeTree = rootRoute.addChildren([
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => (
        <BotRoster search={view === "list" ? { view: "list" } : {}} />
      ),
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/bots",
      component: () => null,
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/bots/$agentId",
      component: () => null,
    }),
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("sections read Pinned, Yours, Shared with you, and each Bot appears once", async () => {
  serving(
    [
      bot({ id: "favourite", name: "Favourite", pinned: true }),
      bot({ id: "mine", name: "Mine" }),
      bot({ id: "theirs", name: "Theirs", mine: false, canManage: false }),
    ],
    [],
  );
  const view = draw();
  expect(await view.findByText("Theirs")).toBeTruthy();
  const headings = [...view.container.querySelectorAll("h2")].map(
    (heading) => heading.textContent,
  );
  expect(headings).toEqual(["已置顶", "已召唤", "共享给你的"]);
  expect(view.getAllByText("Favourite")).toHaveLength(1);
});

test("a row opens the Bot's own page", async () => {
  serving([bot({ id: "mine", name: "Mine" })], []);
  const view = draw();
  const row = (await view.findByText("Mine")).closest("a");
  expect(row?.getAttribute("href")).toBe("/bots/mine");
});

test("with every Bot of yours pinned, Yours says so instead of claiming none", async () => {
  serving([bot({ id: "favourite", name: "Favourite", pinned: true })], []);
  const view = draw();
  expect(await view.findByText("你的员工都已置顶在上面。")).toBeTruthy();
  expect(view.queryByText("你新建的员工会出现在这里。")).toBeNull();
});

test("a hidden Bot is under Hidden, folded until asked for, and its row opens its page", async () => {
  serving(
    [bot({ id: "mine", name: "Mine" })],
    [bot({ id: "tucked", name: "Tucked", hidden: true })],
  );
  const view = draw();
  expect(await view.findByText("已隐藏")).toBeTruthy();
  expect(view.queryByText("Tucked")).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "显示" }));
  const row = view.getByText("Tucked").closest("a");
  expect(row?.getAttribute("href")).toBe("/bots/tucked");
});

test("with nothing hidden there is no Hidden section", async () => {
  serving([bot({ id: "mine", name: "Mine" })], []);
  const view = draw();
  expect(await view.findByText("Mine")).toBeTruthy();
  await waitFor(() =>
    expect(queryClient.getQueryState(agentKeys.list(true))?.status).toBe(
      "success",
    ),
  );
  expect(view.queryByText("已隐藏")).toBeNull();
});

test("a roster that never loaded says so, not that you have no Bots", async () => {
  global.fetch = (async () =>
    new Response(null, { status: 500 })) as unknown as typeof fetch;
  const view = draw();
  expect(await view.findByText(/读不到员工/)).toBeTruthy();
  expect(view.getByText(/读不到员工/).closest("[role=alert]")).not.toBeNull();
  expect(view.queryByText("你新建的员工会出现在这里。")).toBeNull();
});

test("a failed refetch keeps the roster it already had, not the error", async () => {
  queryClient.setQueryData(agentKeys.list(false), [
    bot({ id: "mine", name: "Mine" }),
  ]);
  global.fetch = (async () =>
    new Response(null, { status: 500 })) as unknown as typeof fetch;
  const view = draw();
  await waitFor(() =>
    expect(queryClient.getQueryState(agentKeys.list(false))?.status).toBe(
      "error",
    ),
  );
  expect(view.getByText("Mine")).toBeTruthy();
  expect(view.queryByText(/读不到员工/)).toBeNull();
});

test("a Bot with something waiting stays in its own section, with its count", async () => {
  serving(
    [
      bot({ id: "mine", name: "Mine" }),
      bot({ id: "waiting", name: "Waiting", mine: false }),
    ],
    [],
    [
      {
        agentId: "waiting",
        name: "Waiting",
        questions: 1,
        approvals: 1,
        handoffs: 0,
        unread: 0,
        paused: false,
        notify: "all",
        items: 0,
        tasks: { needsInput: 0, ready: 0, failed: 0 },
      },
    ],
  );
  const view = draw();
  expect(await view.findByText("2")).toBeTruthy();
  const headings = [...view.container.querySelectorAll("h2")].map(
    (heading) => heading.textContent,
  );
  // What it waits on is on the Needs you board, by name; the Bot itself stays where it is.
  expect(headings).toEqual(["已召唤", "共享给你的"]);
  expect(view.getAllByText("Waiting")).toHaveLength(1);
});

test("a Bot's check-in items are counted in the words the badge and Needs you use", async () => {
  serving(
    [bot({ id: "scout", name: "Scout", mine: false })],
    [],
    [
      {
        agentId: "scout",
        name: "Scout",
        questions: 0,
        approvals: 0,
        handoffs: 0,
        unread: 0,
        paused: false,
        notify: "all",
        items: 2,
        tasks: { needsInput: 0, ready: 0, failed: 0 },
      },
    ],
  );
  const view = draw();
  expect(await view.findByText("2 件事需要你")).toBeTruthy();
  expect(view.container.textContent).not.toContain("建议");
});

test("personal edition labels starter Bots as included with OpenBot", async () => {
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    edition: "personal",
  });
  serving(
    [bot({ id: "starter", name: "Starter", mine: false, systemOwned: true })],
    [],
  );
  const view = draw();
  await view.findByText("Starter");
  expect(view.getByRole("heading", { name: "熊宝自带的员工" })).toBeTruthy();
  expect(view.queryByText("共享给你的")).toBeNull();
});
