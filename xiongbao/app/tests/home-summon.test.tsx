/*
 * 召唤员工 on the home page (Ruling 8, Task 10): a new person is sent to 人才市场 to summon their first
 * employee, and 「发现员工」 lists only the presets they have not summoned, each card a link to that
 * employee's card on 人才市场 — the one place summoning happens. Nothing is summoned from here.
 */
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
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { agentKeys } from "@/lib/agents/queries";
import { authKeys } from "@/lib/auth/queries";
import { type ChannelSummary, channelKeys } from "@/lib/channels/queries";
import { wakerGroupKeys } from "@/lib/waker-groups/queries";
import { Route as HomeRoute } from "@/routes/_authed/_app/index";
import { settleReactWork } from "./settle-react-work";

type Sent = { url: string; method: string };
const sent: Sent[] = [];
let respond: (request: Sent) => Promise<Response> | undefined;
let originalFetch: typeof fetch;
const clients: QueryClient[] = [];
/** `/` mounts the rich-text composer as well, so a find there needs more than the default second. */
const SLOW = { timeout: 5000 };

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost:3010" });
  originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = { url: String(input), method: init?.method ?? "GET" };
      sent.push(request);
      return (
        (await respond(request)) ??
        Response.json({ error: "not served" }, { status: 404 })
      );
    },
    { preconnect: originalFetch.preconnect },
  );
});
beforeEach(() => {
  window.localStorage.clear();
  sent.length = 0;
  respond = () => undefined;
});
afterEach(() => {
  cleanup();
  for (const client of clients) client.clear();
  clients.length = 0;
});
afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

function agent(id: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name,
    title: "",
    roleDescription: "",
    avatarSeed: id,
    visibility: "private",
    hidden: false,
    pinned: false,
    mine: true,
    summonKind: null,
    summoned: true,
    ...extra,
  };
}

const preset = (id: string, name: string, summoned: boolean) =>
  agent(id, name, {
    mine: false,
    visibility: "public",
    summonKind: "preset",
    summoned,
    roleDescription: `${name}的职责`,
  });

const AGENTS = [
  agent("avatar-user", "我的分身", { summonKind: "avatar", summoned: false }),
  preset("preset-doctor", "暖心医生", false),
  preset("preset-lawyer", "专业律师", true),
  agent("copy-lawyer", "专业律师", { summonedFrom: "preset-lawyer" }),
  // A colleague's own coworker they made public: not a preset, so not 召唤-able from here.
  agent("colleague-bot", "同事的助手", { mine: false, visibility: "public" }),
];

function renderHome({
  agents = AGENTS,
  channels = [],
}: {
  agents?: unknown[];
  channels?: ChannelSummary[];
} = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  clients.push(queryClient);
  queryClient.setQueryData(authKeys.currentUser(), {
    id: "user",
    email: "user@example.com",
    name: "熊宝用户",
    role: "user",
    onboarding: null,
  });
  queryClient.setQueryData(agentKeys.list(false), agents);
  queryClient.setQueryData(wakerGroupKeys.list(), []);
  queryClient.setQueryData(channelKeys.list(), {
    pages: [{ channels, nextCursor: null }],
    pageParams: [""],
  });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const home = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: HomeRoute.options.component,
  });
  const conversation = createRoute({
    getParentRoute: () => rootRoute,
    path: "/channel/$channelId",
    component: () => null,
  });
  const market = createRoute({
    getParentRoute: () => rootRoute,
    path: "/bots",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([home, conversation, market]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, router };
}

async function discover(view: ReturnType<typeof renderHome>["view"]) {
  return within(await view.findByRole("region", { name: "发现员工" }, SLOW));
}

test("发现员工 lists only the presets the person has not summoned, each a link to its 人才市场 card", async () => {
  const { view } = renderHome();
  const section = await discover(view);
  expect(
    section
      .getAllByRole("link")
      .filter((link) => link.getAttribute("href")?.startsWith("/bots#"))
      .map((card) => [card.textContent, card.getAttribute("href")]),
  ).toEqual([["暖心医生暖心医生的职责", "/bots#summon-preset-doctor"]]);
  expect(section.queryByText("专业律师")).toBeNull();
  expect(section.queryByText("同事的助手")).toBeNull();
  expect(section.queryByText("我的分身")).toBeNull();
});

test("a 发现员工 card summons nothing from the home page", async () => {
  const { view, router } = renderHome();
  const section = await discover(view);
  await userEvent.click(section.getByRole("link", { name: /暖心医生/ }));
  await waitFor(() => expect(router.state.location.pathname).toBe("/bots"));
  expect(router.state.location.hash).toBe("summon-preset-doctor");
  expect(sent.filter((request) => request.method === "POST")).toEqual([]);
  expect(view.queryByRole("dialog", { name: "召唤员工" })).toBeNull();
});

test("with every preset summoned, 发现员工 says so instead of listing anybody", async () => {
  const { view } = renderHome({
    agents: AGENTS.filter((profile) => profile.id !== "preset-doctor"),
  });
  const section = await discover(view);
  expect(section.getByText("没有待召唤的员工了。")).toBeTruthy();
  expect(section.queryAllByRole("button")).toHaveLength(0);
});

test("a person with no conversation yet is sent to 人才市场 to summon one", async () => {
  const { view } = renderHome();
  expect(
    await view.findByText(
      "先去「人才市场」召唤一位员工，再和它对话。",
      {},
      SLOW,
    ),
  ).toBeTruthy();
  const links = view
    .getAllByRole("link", { name: "去人才市场" })
    .map((link) => link.getAttribute("href"));
  expect(links).toContain("/bots");
});

test("once there is a conversation, the home page no longer says how to start", async () => {
  const { view } = renderHome({
    channels: [
      {
        id: "c-1",
        name: "c-1",
        agentIds: ["copy-lawyer"],
        threadId: "c-1",
        active: true,
        lastMessageAt: null,
        summary: null,
        lastMessage: null,
        lastMessageAgentId: null,
        createdAt: "2026-11-01T00:00:00Z",
        pinned: false,
        lastReadAt: null,
      },
    ],
  });
  await discover(view);
  expect(
    view.queryByText("先去「人才市场」召唤一位员工，再和它对话。"),
  ).toBeNull();
});
