/*
 * #452 去掉、用户要回来的熊宝直达入口与几处小行为：
 * - 侧栏「更多」里的团队 Bot 和审批（两页恢复成页面，审批页上管理员能直接改团队设置和团队规则）；
 * - 主导航的「工作管理 / 员工资源」两个分组标题；
 * - 账户行写着现在的套餐，旁边一个直达「套餐与用量」的图标；
 * - 小管家在 @Waker 也出现；
 * - 员工页「对你」里的「重置」，以及「消息发到哪里」（按人保存，对所有员工生效）。
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
import type { ReactNode } from "react";
import { AppSidebar } from "@/components/app-sidebar/app-sidebar";
import { BotControls, BotProfile } from "@/components/bot-profile/profile";
import { PageShell } from "@/components/layout/page-shell";
import { SidebarProvider } from "@/components/ui/sidebar";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import { authKeys } from "@/lib/auth/queries";
import { avatarSourceKeys } from "@/lib/avatar/sources";
import { botLifecycleKeys } from "@/lib/bot-lifecycle/queries";
import { browserKeys } from "@/lib/browser/queries";
import { channelKeys } from "@/lib/channels/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { portraitKeys } from "@/lib/portraits/queries";
import { quotaKeys } from "@/lib/quota/queries";
import { userPreferencesQueryOptions } from "@/lib/settings/message-list";
import { teamBotKeys } from "@/lib/team-bots";
import { Route as ApprovalsRoute } from "@/routes/_authed/_app/approvals";
import { Route as TeamBotsRoute } from "@/routes/_authed/_app/team-bots";
import { settleReactWork } from "./settle-react-work";

class OfflineWebSocket extends EventTarget {
  readyState = 0;
  close() {}
  send() {}
}

let originalFetch: typeof fetch;
let originalWebSocket: typeof WebSocket;
let answer: (url: string, method: string) => Response | undefined;
/** The writes the page sent, in order: what a test checks the page asked the server to change. */
const writes: { url: string; method: string; body: unknown }[] = [];
const clients: QueryClient[] = [];

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost:3010" });
  originalFetch = globalThis.fetch;
  originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = OfflineWebSocket as unknown as typeof WebSocket;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method !== "GET")
        writes.push({
          url: String(input),
          method,
          body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
        });
      return (
        answer(String(input), method) ??
        Response.json({ error: "not served" }, { status: 404 })
      );
    },
    { preconnect: originalFetch.preconnect },
  );
});
beforeEach(() => {
  window.localStorage.clear();
  answer = () => undefined;
  writes.length = 0;
});
afterEach(() => {
  cleanup();
  for (const client of clients) client.clear();
  clients.length = 0;
});
afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWebSocket;
  GlobalRegistrator.unregister();
});

function agent(id: string, name: string): AgentProfile {
  return {
    id,
    name,
    title: "",
    roleDescription: "",
    avatarSeed: id,
    builtIn: true,
    canManage: true,
    endpoint: null,
    modelRef: null,
    persona: null,
    hasAuth: false,
    hasCallbackToken: false,
    isolated: false,
    isolationActive: false,
    isolationOffReason: null,
    hidden: false,
    pinned: false,
    mine: true,
    systemOwned: false,
    visibility: "private",
  };
}

function client(role: "user" | "admin" = "user") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  clients.push(queryClient);
  queryClient.setQueryData(userPreferencesQueryOptions("user").queryKey, {
    messageListEmphasis: "thread",
    selfHostBannerDismissed: true,
    narration: null,
    skin: "xiongbao",
    proactive: "on",
  });
  queryClient.setQueryData(authKeys.currentUser(), {
    id: "user",
    email: "user@example.com",
    name: "熊宝用户",
    role,
    onboarding: null,
  });
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    selfHostBanner: false,
    localEvaluation: false,
    edition: "team",
  });
  queryClient.setQueryData(avatarSourceKeys.state(), {
    agentId: "avatar-user",
    configuredAt: null,
    sources: [],
  });
  queryClient.setQueryData(quotaKeys.usage(), {
    plan: { id: "pro", name: "专业版" },
    limits: { wakers: 10, tasksPerMonth: 100, devices: 3 },
    usage: { wakers: 2, tasks: 4, devices: 1 },
    tokens: null,
  });
  queryClient.setQueryData(agentKeys.list(false), [agent("a-1", "分析师")]);
  queryClient.setQueryDefaults(botLifecycleKeys.attention, {
    staleTime: Number.POSITIVE_INFINITY,
    refetchInterval: false,
  });
  queryClient.setQueryData(botLifecycleKeys.attention, {
    bots: [],
    lastPingId: null,
  });
  queryClient.setQueryData(browserKeys.state, {
    available: false,
    computerId: "",
    open: false,
    tabs: [],
  });
  queryClient.setQueryData(portraitKeys.all, []);
  queryClient.setQueryData(channelKeys.list(), {
    pages: [{ channels: [], nextCursor: null }],
    pageParams: [""],
  });
  return queryClient;
}

/** The sidebar and one page, at `path`, as the app frames them. */
function renderApp(
  path: string,
  queryClient: QueryClient,
  pages: Record<string, () => ReactNode> = {},
) {
  const rootRoute = createRootRoute({
    component: () => (
      <SidebarProvider>
        <AppSidebar />
        <main>
          <Outlet />
        </main>
      </SidebarProvider>
    ),
  });
  const leaves = [
    "/tasks",
    "/approvals",
    "/team-bots",
    "/settings/plans",
    "/reachability",
    "/bot",
    ...Object.keys(pages),
  ]
    .filter((route, index, all) => all.indexOf(route) === index)
    .map((route) =>
      createRoute({
        getParentRoute: () => rootRoute,
        path: route,
        component: pages[route] ?? (() => null),
      }),
    );
  const router = createRouter({
    routeTree: rootRoute.addChildren(leaves),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { view, router };
}

const hrefOf = (node: Element | null | undefined) =>
  node?.getAttribute("href") ?? null;
const textOf = (node: Element | null | undefined) =>
  node?.textContent?.replace(/\s+/g, " ").trim();

test("更多 carries 团队 Bot and 审批 after 组团流程, and each opens its page", async () => {
  const { view, router } = renderApp("/tasks", client());
  await userEvent.click(await view.findByRole("button", { name: "更多" }));
  const more = view.getByRole("navigation", { name: "更多入口" });
  expect(
    within(more)
      .getAllByRole("link")
      .map((link) => [textOf(link), hrefOf(link)]),
  ).toEqual([
    ["组团流程", "/pipelines"],
    ["团队 Bot", "/team-bots"],
    ["审批", "/approvals"],
  ]);
  await userEvent.click(within(more).getByRole("link", { name: "审批" }));
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/approvals"),
  );
  expect(
    within(more)
      .getByRole("link", { name: "审批" })
      .getAttribute("aria-current"),
  ).toBe("page");
});

test("on 审批 or 团队 Bot, 更多 is open with that entry marked", async () => {
  const { view } = renderApp("/team-bots", client());
  const more = await view.findByRole("navigation", { name: "更多入口" });
  expect(
    within(more)
      .getAllByRole("link")
      .filter((link) => link.getAttribute("aria-current") === "page")
      .map(textOf),
  ).toEqual(["团队 Bot"]);
});

test("the main destinations sit under 工作管理 and 员工资源", async () => {
  const { view } = renderApp("/tasks", client());
  const nav = await view.findByRole("navigation", { name: "主导航" });
  const group = (name: string) =>
    within(within(nav).getByRole("list", { name }))
      .getAllByRole("link")
      .map(textOf);
  expect(group("工作管理")).toEqual(["任务看板", "自主工作", "@Waker"]);
  expect(group("员工资源")).toEqual(["员工", "能力", "连接"]);
});

test("the account row says which plan this is, and a gauge beside it opens 套餐与用量", async () => {
  const { view, router } = renderApp("/tasks", client());
  const account = await view.findByRole("button", { name: "账户：熊宝用户" });
  expect(textOf(account)).toContain("专业版");
  const gauge = view.getByRole("link", { name: "套餐与用量" });
  // `/plans` redirects to 设置 › 套餐; the icon goes straight to where it lands.
  expect(hrefOf(gauge)).toBe("/settings/plans");
  await userEvent.click(gauge);
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/settings/plans"),
  );
});

test("小管家 is in the bar on @Waker again", async () => {
  const { view } = renderApp("/reachability", client(), {
    "/reachability": () => (
      <PageShell title="@Waker" width="workbench">
        <p>正文</p>
      </PageShell>
    ),
  });
  const dock = await view.findByRole("link", { name: "小管家" });
  expect(hrefOf(dock)).toBe("/bot");
});

/* ------------------------------------------------------------------------------------------------ */
/* The two pages, back                                                                               */
/* ------------------------------------------------------------------------------------------------ */

const INBOX = {
  enabled: true,
  requests: [],
  rules: [],
  teamRules: [],
  preferences: { enabled: true, autoReview: false, hostCommands: "ask" },
  team: {
    enforceAutoReview: false,
    customRulesEnabled: true,
    hostCommandsCap: "ask",
    enforceDangerousCommands: false,
  },
  hostCommands: "ask",
  questions: [],
};

function renderRoute(
  route: typeof ApprovalsRoute | typeof TeamBotsRoute,
  path: string,
  queryClient: QueryClient,
) {
  const rootRoute = createRootRoute({
    component: () => (
      <SidebarProvider>
        <Outlet />
      </SidebarProvider>
    ),
  });
  const page = (route as typeof ApprovalsRoute).update({
    id: path,
    path,
    getParentRoute: () => rootRoute,
  } as Parameters<typeof ApprovalsRoute.update>[0]);
  const router = createRouter({
    routeTree: rootRoute.addChildren([page]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { view, router };
}

test("审批 is a page again; an administrator changes the team's settings and rules on it", async () => {
  answer = (url) =>
    url === "/api/approvals" ? Response.json(INBOX) : undefined;
  const { view, router } = renderRoute(
    ApprovalsRoute,
    "/approvals",
    client("admin"),
  );
  expect(
    await view.findByRole("heading", { level: 1, name: "审批" }),
  ).toBeTruthy();
  expect(await view.findByRole("heading", { name: "团队设置" })).toBeTruthy();
  expect(view.getByRole("heading", { name: "等你处理" })).toBeTruthy();
  expect(router.state.location.pathname).toBe("/approvals");
});

test("a member's 审批 page has no team settings to change", async () => {
  answer = (url) =>
    url === "/api/approvals" ? Response.json(INBOX) : undefined;
  const { view } = renderRoute(ApprovalsRoute, "/approvals", client("user"));
  expect(await view.findByRole("heading", { name: "等你处理" })).toBeTruthy();
  expect(view.queryByRole("heading", { name: "团队设置" })).toBeNull();
});

test("团队 Bot is a page again, listing what teammates published", async () => {
  const queryClient = client();
  queryClient.setQueryData(teamBotKeys.all, {
    teamBots: [
      {
        id: "tb-1",
        name: "报销助手",
        title: "财务",
        roleDescription: "帮你填报销单",
        mine: false,
        audience: "team",
        publishedAt: "2026-11-01T00:00:00Z",
        assigned: false,
        visibleToTeam: true,
      },
    ],
    publishable: [],
  });
  const { view, router } = renderRoute(
    TeamBotsRoute,
    "/team-bots",
    queryClient,
  );
  expect(
    await view.findByRole("heading", { level: 1, name: "团队 Bot" }),
  ).toBeTruthy();
  expect(view.getByText("报销助手")).toBeTruthy();
  expect(router.state.location.pathname).toBe("/team-bots");
});

/* ------------------------------------------------------------------------------------------------ */
/* The employee's own page                                                                           */
/* ------------------------------------------------------------------------------------------------ */

function renderInRouter(node: ReactNode, queryClient: QueryClient) {
  const rootRoute = createRootRoute({ component: () => <>{node}</> });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/bots/a-1"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

test("对你 has 重置 again, opening the same confirmation as 管理", async () => {
  answer = (url) =>
    url === "/api/bots/a-1/reset"
      ? Response.json({
          plan: {
            conversations: 3,
            sharedConversationsKept: 0,
            memorySources: 0,
            memories: 0,
            routines: 1,
            responsibilities: 0,
            followUps: 0,
            formedMemories: 0,
            backgroundResearch: 0,
            standingApprovals: 0,
          },
        })
      : undefined;
  const queryClient = client();
  queryClient.setQueryData(botLifecycleKeys.lifecycle("a-1"), {
    agentId: "a-1",
    paused: false,
    pausedAt: null,
    notify: "all",
  });
  const view = renderInRouter(
    <BotControls agent={agent("a-1", "分析师")} />,
    queryClient,
  );
  await userEvent.click(await view.findByRole("button", { name: /^重置/ }));
  const dialog = await view.findByRole("dialog");
  expect(within(dialog).getByText("重置 分析师？")).toBeTruthy();
  // What it would delete, counted before anything is.
  expect(await within(dialog).findByText("3 段对话")).toBeTruthy();
  expect(within(dialog).getByText("1 个定时任务")).toBeTruthy();
  expect(
    within(dialog).getByRole("button", { name: "删除并重置" }),
  ).toHaveProperty("disabled", false);
  await userEvent.click(within(dialog).getByRole("button", { name: "取消" }));
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
  expect(writes).toEqual([]);
});

test("the employee's page says where updates go, right after 对你, for all employees", async () => {
  answer = (url) =>
    url === "/api/bots/routing"
      ? Response.json({
          routing: {
            progress: "all",
            decision: "all",
            question: "all",
            attention: "all",
          },
        })
      : undefined;
  const queryClient = client();
  queryClient.setQueryData(botLifecycleKeys.lifecycle("a-1"), {
    agentId: "a-1",
    paused: false,
    pausedAt: null,
    notify: "all",
  });
  const view = renderInRouter(
    <BotProfile agent={agent("a-1", "分析师")} />,
    queryClient,
  );
  const routing = await view.findByRole("heading", { name: "消息发到哪里" });
  const mine = view.getByRole("heading", { name: "对你" });
  expect(
    mine.compareDocumentPosition(routing) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});

const ROUTING_ALL = {
  routing: {
    progress: "all",
    decision: "all",
    question: "all",
    attention: "all",
  },
};

function renderProfile(queryClient: QueryClient) {
  queryClient.setQueryData(botLifecycleKeys.lifecycle("a-1"), {
    agentId: "a-1",
    paused: false,
    pausedAt: null,
    notify: "all",
  });
  return renderInRouter(
    <BotProfile agent={agent("a-1", "分析师")} />,
    queryClient,
  );
}

test("turning a channel off on the employee's page saves the person's routing without it", async () => {
  answer = (url, method) =>
    url === "/api/bots/routing" && method === "GET"
      ? Response.json(ROUTING_ALL)
      : url.startsWith("/api/bots/routing/") && method === "PUT"
        ? Response.json({ routing: ROUTING_ALL.routing })
        : undefined;
  const view = renderProfile(client());
  await userEvent.click(
    await view.findByRole("switch", { name: "进展：短信" }),
  );
  await waitFor(() =>
    expect(writes).toEqual([
      {
        url: "/api/bots/routing/progress",
        method: "PUT",
        body: { transports: ["push", "slack", "teams"] },
      },
    ]),
  );
});

test("routing that cannot be read says so on the employee's page", async () => {
  answer = (url) =>
    url === "/api/bots/routing"
      ? Response.json({ error: "boom" }, { status: 500 })
      : undefined;
  const view = renderProfile(client());
  const section = (
    await view.findByRole("heading", { name: "消息发到哪里" })
  ).closest("section") as HTMLElement;
  expect((await within(section).findByRole("alert")).textContent).toBe(
    "读不到你的消息去向设置，请刷新页面。",
  );
});

test("a member's 审批 page has no access requests either", async () => {
  answer = (url) =>
    url === "/api/approvals" ? Response.json(INBOX) : undefined;
  const { view } = renderRoute(ApprovalsRoute, "/approvals", client("user"));
  expect(await view.findByRole("heading", { name: "等你处理" })).toBeTruthy();
  expect(view.queryByRole("heading", { name: "访问申请" })).toBeNull();
});

test("an administrator's switch on 审批 changes the team's settings", async () => {
  answer = (url, method) =>
    url === "/api/approvals"
      ? Response.json(INBOX)
      : url === "/api/approvals/team" && method === "PATCH"
        ? Response.json({ ok: true })
        : url === "/api/plugins/access-requests"
          ? Response.json({ requests: [] })
          : undefined;
  const { view } = renderRoute(ApprovalsRoute, "/approvals", client("admin"));
  expect(await view.findByRole("heading", { name: "访问申请" })).toBeTruthy();
  await userEvent.click(
    await view.findByRole("switch", { name: "要求所有人开启自动审查" }),
  );
  await waitFor(() =>
    expect(writes).toEqual([
      {
        url: "/api/approvals/team",
        method: "PATCH",
        body: { enforceAutoReview: true },
      },
    ]),
  );
});

test("an administrator can start a chat only with what is published to them; the rest is listed apart", async () => {
  const queryClient = client("admin");
  const published = (
    id: string,
    name: string,
    extra: Partial<Record<string, unknown>>,
  ) => ({
    id,
    name,
    title: "",
    roleDescription: "",
    mine: false,
    audience: "team",
    publishedAt: "2026-11-01T00:00:00Z",
    assigned: false,
    visibleToTeam: true,
    ...extra,
  });
  queryClient.setQueryData(teamBotKeys.all, {
    teamBots: [
      published("tb-team", "全员助手", {}),
      published("tb-me", "点名给我", {
        audience: "people",
        people: ["user@example.com"],
      }),
      published("tb-other", "别人的助手", {
        audience: "people",
        people: ["someone@example.com"],
      }),
    ],
    publishable: [],
  });
  const { view } = renderRoute(TeamBotsRoute, "/team-bots", queryClient);
  const usable = (
    await view.findByRole("heading", { name: "你可以用的" })
  ).closest("section") as HTMLElement;
  expect(within(usable).getByText("2 位")).toBeTruthy();
  expect(
    within(usable).getAllByRole("button", { name: "开始私聊" }),
  ).toHaveLength(2);
  expect(within(usable).queryByText("别人的助手")).toBeNull();
  const apart = view
    .getByRole("heading", { name: "全部发布（管理员）" })
    .closest("section") as HTMLElement;
  expect(within(apart).getByText("别人的助手")).toBeTruthy();
  expect(within(apart).queryByRole("button", { name: "开始私聊" })).toBeNull();
});
