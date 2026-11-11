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
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentCard } from "@/components/agents/agent-card";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import {
  type BotAttention,
  botLifecycleKeys,
} from "@/lib/bot-lifecycle/queries";
import { deviceKeys } from "@/lib/devices/queries";
import {
  runningTasksQueryOptions,
  wakerGroupKeys,
} from "@/lib/waker-groups/queries";
import { Route as AgentsRoute } from "@/routes/_authed/_app/agents/index";
import { Route as AutonomousRoute } from "@/routes/_authed/_app/autonomous";
import { Route as BotsIndexRoute } from "@/routes/_authed/_app/bots.index";
import { Route as RoutinesRoute } from "@/routes/_authed/_app/routines";
import { Route as WakersRoute } from "@/routes/_authed/_app/wakers";
import { seedQuietNeedsYou } from "./quiet-needs-you";
import { settleReactWork } from "./settle-react-work";

/**
 * 「所有重复的都归档」: the pages that duplicated a workbench page are archived into it.
 *
 * - `/agents` (员工列表) → `/wakers` (员工管理): its create dialog (`?new=true`) and its edit dialog
 *   (`?agent=<id>`) now open on `/wakers` under the same parameters, and the old address redirects
 *   with those parameters carried over.
 * - `/bots` (Bot 会话) → `/wakers`: what each employee needs from the person is on its card, and the
 *   card opens the employee's one detail page (`/bots/$agentId` redirects there too).
 * - `/routines` (定时任务) → `/autonomous?trigger=schedule`: the unified list narrowed to schedules,
 *   with the "nothing is firing" warning the old page carried.
 *
 * Every old address is exercised through the real exported route, so the redirect under test is the
 * one the app ships, and lands on the real workbench page.
 *
 * M5b：员工管理（`/wakers`）本身又并进了上游的员工页（`/bots`），所以 `/agents`、`/wakers` 都落到 `/bots`；
 * `/agents?agent=<id>` 现在去那位员工自己的页面（`/bots/<id>`，和上游一样），编辑框改由每张卡上的「编辑」在
 * `/bots?agent=<id>` 打开。
 */
let registeredHere = false;
beforeAll(() => {
  if (!("document" in globalThis)) {
    GlobalRegistrator.register();
    registeredHere = true;
  }
});
afterAll(async () => {
  if (!registeredHere) return;
  await settleReactWork();
  GlobalRegistrator.unregister();
});
const originalFetch = globalThis.fetch;
const drawn: QueryClient[] = [];
afterEach(async () => {
  cleanup();
  await Promise.all(drawn.map((client) => client.cancelQueries()));
  for (const client of drawn) client.clear();
  drawn.length = 0;
  globalThis.fetch = originalFetch;
});

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
  isolated: false,
  isolationActive: false,
  isolationOffReason: null,
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
  title: "Reviews",
};

const attention = (
  agentId: string,
  over: Partial<BotAttention> = {},
): BotAttention => ({
  agentId,
  name: agentId,
  questions: 0,
  approvals: 0,
  handoffs: 0,
  unread: 0,
  paused: false,
  notify: "all",
  items: 0,
  tasks: { needsInput: 0, ready: 0, failed: 0 },
  ...over,
});

type Sweep = { lastSweptAt: string | null; working: boolean };

/** Every read answers in its own envelope; anything unlisted answers an empty object. */
function serve(routines: { routines: unknown[]; sweep: Sweep }) {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = String(input);
    if (path === "/api/agents/autonomous/all")
      return Response.json({ autonomous: [] });
    if (path === "/api/automations") return Response.json({ automations: [] });
    if (path === "/api/responsibilities")
      return Response.json({ responsibilities: [] });
    if (path === "/api/routines") return Response.json(routines);
    return Response.json({});
  }) as typeof fetch;
}

function seed({
  agents = [base, reviewer],
  rows = [] as BotAttention[],
}: {
  agents?: AgentProfile[];
  rows?: BotAttention[];
} = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  drawn.push(client);
  client.setQueryData(
    agentKeys.list(false),
    agents.filter((agent) => !agent.hidden),
  );
  client.setQueryData(
    agentKeys.list(true),
    agents.filter((agent) => agent.hidden),
  );
  for (const agent of agents)
    client.setQueryData(agentKeys.detail(agent.id), agent);
  client.setQueryData(wakerGroupKeys.list(), []);
  client.setQueryData(botLifecycleKeys.attention, {
    bots: rows,
    lastPingId: null,
  });
  client.setQueryData(runningTasksQueryOptions().queryKey, []);
  client.setQueryData(deviceKeys.list(), []);
  seedQuietNeedsYou(client);
  return client;
}

function draw(
  entry: string,
  client = seed(),
  routines: { routines: unknown[]; sweep: Sweep } = {
    routines: [],
    sweep: { lastSweptAt: null, working: true },
  },
) {
  serve(routines);
  const root = createRootRoute({ component: () => <Outlet /> });
  const stub = (path: string) =>
    createRoute({
      getParentRoute: () => root,
      path,
      component: () => <p>stub {path}</p>,
    } as never);
  const at = <T,>(route: T, path: string): T =>
    (route as { update: (options: unknown) => T }).update({
      getParentRoute: () => root,
      path,
    });
  const router = createRouter({
    context: {},
    history: createMemoryHistory({ initialEntries: [entry] }),
    routeTree: root.addChildren([
      at(AgentsRoute, "/agents"),
      at(BotsIndexRoute, "/bots"),
      at(RoutinesRoute, "/routines"),
      at(WakersRoute, "/wakers"),
      at(AutonomousRoute, "/autonomous"),
      stub("/wakers/$agentId"),
      stub("/bots/$agentId"),
      stub("/bots/$agentId/setup"),
      stub("/channel/new"),
      stub("/channel/$channelId"),
      stub("/capabilities/roles"),
      stub("/pipelines"),
      stub("/responsibilities"),
      stub("/memory"),
    ]),
  });
  const screen = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { screen, router, user: userEvent.setup({ document }) };
}

const cardOf = (screen: ReturnType<typeof render>, name: string) =>
  screen
    .getAllByTestId("waker-card")
    .find(
      (card) => card.querySelector("[data-card-name]")?.textContent === name,
    ) as HTMLElement;

/* /agents → /bots ------------------------------------------------------------------------------- */

test("/agents?new=true lands on /bots?new=true with the create dialog open over the roster", async () => {
  const { screen, router } = draw("/agents?new=true");

  await waitFor(() => expect(router.state.location.pathname).toBe("/bots"));
  expect(router.state.location.search).toEqual({ new: true });
  expect(
    await within(document.body).findByRole("dialog", { name: "新建员工" }),
  ).toBeTruthy();
  // The roster is behind it (inert while the modal is open), not a blank page holding a dialog.
  expect(
    screen.getByRole("heading", { hidden: true, name: "员工" }),
  ).toBeTruthy();
  expect(cardOf(screen, "Backend Engineer")).toBeTruthy();
});

test("/agents?agent=<id> lands on that employee's own page", async () => {
  const { screen, router } = draw("/agents?agent=agent-2");

  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/bots/agent-2"),
  );
  expect(await screen.findByText("stub /bots/$agentId")).toBeTruthy();
});

test("/wakers?agent=<id> lands on that employee's own page too", async () => {
  const { router } = draw("/wakers?agent=agent-2");
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/bots/agent-2"),
  );
});

test("a bare /agents lands on the unfiltered /bots roster with no dialog", async () => {
  const { screen, router } = draw("/agents");

  await waitFor(() => expect(router.state.location.pathname).toBe("/bots"));
  expect(router.state.location.search).toEqual({});
  expect(await screen.findByText("Backend Engineer")).toBeTruthy();
  expect(within(document.body).queryByRole("dialog")).toBeNull();
});

test("the redirect replaces /agents in history, so Back does not bounce through it again", async () => {
  const { router } = draw("/agents?new=true");
  await waitFor(() => expect(router.state.location.pathname).toBe("/bots"));
  expect(router.history.length).toBe(1);
});

test("/wakers carries its filters and groups tab onto /bots, replacing itself in history", async () => {
  const { screen, router } = draw("/wakers?tab=groups&q=Backend");
  await waitFor(() => expect(router.state.location.pathname).toBe("/bots"));
  expect(router.state.location.search).toEqual({ tab: "groups", q: "Backend" });
  expect(router.history.length).toBe(1);
  expect(
    (await screen.findByRole("tab", { name: /^群组/ })).getAttribute(
      "aria-selected",
    ),
  ).toBe("true");
});

test("on /bots the header's 新建员工 and the create card open the create dialog in place", async () => {
  const { screen, router, user } = draw("/bots");
  await screen.findByText("Backend Engineer");

  // The header's (the create card says 新建员工 too).
  const header = within(screen.getByTestId("wakers-header-actions"))
    .getByText("新建员工")
    .closest("a") as HTMLElement;
  expect(header.getAttribute("href")).toBe("/bots?new=true");
  expect(screen.getByTestId("waker-create-card").getAttribute("href")).toBe(
    "/bots?new=true",
  );

  await user.click(header);
  const dialog = await within(document.body).findByRole("dialog", {
    name: "新建员工",
  });
  expect(router.state.location.pathname).toBe("/bots");
  expect(router.state.location.search).toEqual({ new: true });

  // The wizard's own 取消 on its first step closes it and drops the parameter.
  await user.click(within(dialog).getByRole("button", { name: "取消" }));
  await waitFor(() => expect(router.state.location.search).toEqual({}));
});

test("a coworker made in the wizard opens on its own page, and Back returns to the roster", async () => {
  const { screen, router, user } = draw("/bots");
  await screen.findByText("Backend Engineer");
  const answer = globalThis.fetch;
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    if (String(input) === "/api/agents" && init?.method === "POST")
      return Response.json(
        { agent: { ...base, id: "agent-new", name: "报销专员" } },
        { status: 201 },
      );
    if (String(input) === "/api/agents/capabilities")
      return Response.json({ capabilities: { builtInAvailable: true } });
    return answer(input, init);
  }) as typeof fetch;

  await user.click(
    within(screen.getByTestId("wakers-header-actions"))
      .getByText("新建员工")
      .closest("a") as HTMLElement,
  );
  const dialog = await within(document.body).findByRole("dialog", {
    name: "新建员工",
  });
  await user.type(within(dialog).getByLabelText("名字"), "报销专员");
  await user.type(within(dialog).getByLabelText("头衔"), "财务运营");
  await user.type(within(dialog).getByLabelText("角色"), "审核票据。");
  await user.click(within(dialog).getByRole("button", { name: "下一步" }));
  await within(dialog).findByText("第 2 步，共 3 步");
  await user.click(within(dialog).getByRole("button", { name: "下一步" }));
  await within(dialog).findByText("第 3 步，共 3 步");
  await user.click(
    dialog.ownerDocument.querySelector('input[value="builtin"]') as HTMLElement,
  );
  await user.click(within(dialog).getByRole("button", { name: "创建员工" }));

  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/bots/agent-new"),
  );
  // The `?new` entry was replaced, so Back lands on the roster rather than an empty wizard.
  router.history.back();
  await waitFor(() => expect(router.state.location.pathname).toBe("/bots"));
  expect(router.state.location.search).toEqual({});
});

test("each card's 编辑 opens that employee's edit dialog on /bots, keeping the roster's filters", async () => {
  const { screen, router, user } = draw("/bots?q=Backend");
  await screen.findByText("Backend Engineer");

  const edit = within(cardOf(screen, "Backend Engineer")).getByRole("link", {
    name: "编辑 Backend Engineer",
  });
  expect(edit.getAttribute("href")).toBe("/bots?q=Backend&agent=agent-1");

  await user.click(edit);
  expect(
    await within(document.body).findByRole("dialog", {
      name: "Backend Engineer",
    }),
  ).toBeTruthy();
  expect(router.state.location.search).toEqual({
    q: "Backend",
    agent: "agent-1",
  });

  // Closing it goes back to the same narrowed wall.
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(router.state.location.search).toEqual({ q: "Backend" }),
  );
  expect(within(document.body).queryByRole("dialog")).toBeNull();
});

test("what the /agents roster said is on the /bots cards: pinned first and tagged, shared tagged", async () => {
  const shared: AgentProfile = {
    ...base,
    id: "agent-3",
    name: "Shared Helper",
    mine: false,
    visibility: "public",
  };
  const favourite: AgentProfile = {
    ...base,
    id: "agent-4",
    name: "Favourite",
    pinned: true,
  };
  const { screen } = draw("/bots", seed({ agents: [base, shared, favourite] }));
  await screen.findByText("Backend Engineer");

  // Default order: pinned employees first, as /agents put its 已置顶 section on top.
  const names = screen
    .getAllByTestId("waker-card")
    .map((card) => card.querySelector("[data-card-name]")?.textContent);
  expect(names).toEqual(["Favourite", "Backend Engineer", "Shared Helper"]);

  // The tag on the card (the section above it carries the same word as its heading).
  const pinnedTags = [
    ...screen.container.querySelectorAll("[data-pinned=true]"),
  ];
  expect(pinnedTags).toHaveLength(1);
  expect(cardOf(screen, "Favourite").contains(pinnedTags[0] as Node)).toBe(
    true,
  );
  const sharedTags = screen.getAllByText("共享给你");
  expect(sharedTags).toHaveLength(1);
  expect(cardOf(screen, "Shared Helper").contains(sharedTags[0] as Node)).toBe(
    true,
  );
});

// M5b：员工墙并进 /bots，`/wakers?agent=<id>` 也改去那位员工自己的页面，所以卡片的「详情」直接链到 /bots/$agentId。
test("the roster's card links (home carousel) open that employee's own page, not /agents", async () => {
  const root = createRootRoute({
    component: () => <AgentCard agent={base} />,
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: "/bots/$agentId",
        component: () => null,
      } as never),
    ]),
  });
  const screen = render(<RouterProvider router={router as never} />);
  const link = await screen.findByLabelText("查看 Backend Engineer 的详情");
  expect(link.getAttribute("href")).toBe("/bots/agent-1");
});

/* /bots ------------------------------------------------------------------------------------------ */

test("/bots is the roster itself, no longer a redirect", async () => {
  const { screen, router } = draw("/bots");

  expect(await screen.findByText("Backend Engineer")).toBeTruthy();
  expect(router.state.location.pathname).toBe("/bots");
  expect(router.state.location.search).toEqual({});
});

test("what each employee needs from the person is on its card, which links to its /bots profile", async () => {
  const { screen } = draw(
    "/bots",
    seed({
      rows: [
        attention("agent-1", { questions: 2, approvals: 1, unread: 3 }),
        attention("agent-2"),
      ],
    }),
  );
  await screen.findByText("Backend Engineer");

  const backend = cardOf(screen, "Backend Engineer");
  const line = backend.querySelector("[data-attention]");
  expect(line?.textContent).toContain("2 个提问、1 个审批、3 条未读");
  expect(line?.getAttribute("data-attention")).toBe("3");
  // Nothing waiting: no line at all rather than an empty one.
  expect(
    cardOf(screen, "Code Reviewer").querySelector("[data-attention]"),
  ).toBeNull();

  for (const [name, id] of [
    ["Backend Engineer", "agent-1"],
    ["Code Reviewer", "agent-2"],
  ] as const) {
    // The old /bots profile is part of the one detail page now: the card opens it, and there is
    // no second link to a separate profile.
    const card = cardOf(screen, name);
    expect(
      within(card).queryByRole("link", { name: `${name} 的动态` }),
    ).toBeNull();
    expect(card.querySelector(`a[href="/bots/${id}"]`)).not.toBeNull();
  }
});

/* /routines → /autonomous ------------------------------------------------------------------------ */

test("/routines lands on /autonomous narrowed to the schedule trigger", async () => {
  const { screen, router } = draw("/routines");

  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/autonomous"),
  );
  expect(router.state.location.search).toEqual({ trigger: "schedule" });
  await waitFor(() =>
    expect((screen.getByLabelText("触发类型") as HTMLSelectElement).value).toBe(
      "schedule",
    ),
  );
});

test("the unified list keeps /routines' warning when no runner is executing schedules", async () => {
  const routine = {
    id: "routine-1",
    agentId: "agent-1",
    schedule: "0 9 * * *",
    timezone: "UTC",
    instruction: "post the standup",
    channel: { id: "channel-1", name: "standup", gone: false },
    enabled: true,
    nextRunAt: new Date(Date.now() + 3_600_000).toISOString(),
    lastRun: null,
  };
  const { screen } = draw("/routines", seed(), {
    routines: [routine],
    sweep: { lastSweptAt: null, working: false },
  });

  expect(await screen.findByText("没有在执行这些定时任务")).toBeTruthy();
});
