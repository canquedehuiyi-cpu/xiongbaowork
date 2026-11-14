/*
 * 侧栏的「会话 · 员工 · 群组」：上游的全部会话列表照旧（默认），熊宝 v0.2.7 的员工 / 群组名册找回来——单聊从
 * 员工进，群聊和群组合成「群组」一节——顶部「新对话」旁边有「新建群组」。
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
import { AppSidebar } from "@/components/app-sidebar/app-sidebar";
import { PRESET_IMAGES } from "@/components/portraits/preset-images";
import { SidebarProvider } from "@/components/ui/sidebar";
import { agentKeys } from "@/lib/agents/queries";
import { authKeys } from "@/lib/auth/queries";
import { avatarSourceKeys } from "@/lib/avatar/sources";
import { botLifecycleKeys } from "@/lib/bot-lifecycle/queries";
import { browserKeys } from "@/lib/browser/queries";
import { type ChannelSummary, channelKeys } from "@/lib/channels/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { portraitKeys } from "@/lib/portraits/queries";
import { quotaKeys } from "@/lib/quota/queries";
import { userPreferencesQueryOptions } from "@/lib/settings/message-list";
import { wakerGroupKeys } from "@/lib/waker-groups/queries";
import { settleReactWork } from "./settle-react-work";

class OfflineWebSocket extends EventTarget {
  readyState = 0;
  close() {}
  send() {}
}

let originalFetch: typeof fetch;
let originalWebSocket: typeof WebSocket;
type Sent = { url: string; method: string };
const sent: Sent[] = [];
let respond: (request: Sent) => Promise<Response>;
const clients: QueryClient[] = [];

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost:3010" });
  originalFetch = globalThis.fetch;
  originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = OfflineWebSocket as unknown as typeof WebSocket;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = { url: String(input), method: init?.method ?? "GET" };
      sent.push(request);
      return respond(request);
    },
    { preconnect: originalFetch.preconnect },
  );
});
beforeEach(() => {
  window.localStorage.clear();
  sent.length = 0;
  respond = async (request) => {
    throw new Error(`Unexpected request ${request.method} ${request.url}`);
  };
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

function agent(id: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name,
    title: "",
    roleDescription: "",
    avatarSeed: id,
    hidden: false,
    pinned: false,
    mine: true,
    ...extra,
  };
}

const AGENTS = [
  agent("agent-analyst", "分析师", { roleDescription: "整理周报与指标" }),
  agent("agent-writer", "写手", { title: "文案" }),
  agent("agent-ghost", "隐身员工", { hidden: true }),
];

function channel(
  id: string,
  agentIds: string[],
  extra: Partial<ChannelSummary> = {},
): ChannelSummary {
  return {
    id,
    name: id,
    agentIds,
    threadId: id,
    active: true,
    lastMessageAt: null,
    summary: null,
    lastMessage: null,
    lastMessageAgentId: null,
    createdAt: "2026-11-01T00:00:00Z",
    pinned: false,
    lastReadAt: null,
    ...extra,
  };
}

const CHANNELS = [
  channel("c-analyst-new", ["agent-analyst"], {
    summary: "本周周报",
    lastMessageAt: "2026-11-07T01:00:00Z",
  }),
  channel("c-crew", ["agent-analyst", "agent-writer"], {
    summary: "联合复盘",
    lastMessageAt: "2026-11-06T09:00:00Z",
  }),
  channel("c-analyst-old", ["agent-analyst"], {
    summary: "上周指标",
    lastMessageAt: "2026-11-05T09:00:00Z",
  }),
];

function attention(agentId: string, extra: Record<string, unknown> = {}) {
  return {
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
    ...extra,
  };
}

function renderSidebar(
  path = "/bots",
  {
    channels = CHANNELS,
    nextCursor = null,
    bots = [],
    groups,
    details = [],
    portraits = [],
    agents = AGENTS,
  }: {
    channels?: ChannelSummary[];
    nextCursor?: string | null;
    bots?: unknown[];
    /** The 群组, or undefined for a server that has not answered. */
    groups?: unknown[];
    /** Channels read on their own (`GET /api/channels/:id`), for one not among the loaded pages. */
    details?: { id: string; agentIds: string[] }[];
    portraits?: unknown[];
    agents?: unknown[];
  } = {},
) {
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
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    selfHostBanner: false,
    localEvaluation: false,
    edition: "team",
  });
  queryClient.setQueryData(quotaKeys.usage(), {
    plan: { id: "pro", name: "专业版" },
    limits: { wakers: 10, tasksPerMonth: 100, devices: 3 },
    usage: { wakers: 2, tasks: 4, devices: 1 },
    tokens: null,
  });
  queryClient.setQueryData(avatarSourceKeys.state(), {
    agentId: "avatar-user",
    configuredAt: null,
    sources: [],
  });
  queryClient.setQueryData(authKeys.currentUser(), {
    id: "user",
    email: "user@example.com",
    name: "熊宝用户",
    role: "user",
    onboarding: null,
  });
  queryClient.setQueryData(agentKeys.list(false), agents);
  queryClient.setQueryDefaults(botLifecycleKeys.attention, {
    staleTime: Number.POSITIVE_INFINITY,
    refetchInterval: false,
  });
  queryClient.setQueryData(botLifecycleKeys.attention, {
    bots,
    lastPingId: null,
  });
  queryClient.setQueryData(browserKeys.state, {
    available: false,
    computerId: "",
    open: false,
    tabs: [],
  });
  queryClient.setQueryData(portraitKeys.all, portraits);
  if (groups) queryClient.setQueryData(wakerGroupKeys.list(), groups);
  for (const detail of details) {
    queryClient.setQueryData(channelKeys.detail(detail.id), {
      ...detail,
      name: detail.id,
      threadId: detail.id,
      active: true,
      lastMessageAt: null,
    });
  }
  queryClient.setQueryData(channelKeys.list(), {
    pages: [{ channels, nextCursor }],
    pageParams: [""],
  });
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
  const leaf = (route: string) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path: route,
      component: () => null,
    });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      leaf("/bots"),
      leaf("/channel/new"),
      leaf("/channel/$channelId"),
      leaf("/group/new"),
      leaf("/group/$channelId"),
    ]),
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

async function chooseView(
  view: ReturnType<typeof renderSidebar>["view"],
  name: RegExp,
) {
  const switcher = await view.findByRole("group", { name: "侧栏列表" });
  await userEvent.click(within(switcher).getByRole("button", { name }));
}

test("「新建群组」 sits beside 「新对话」 at the top and opens the 新建群组 page", async () => {
  const { view, router } = renderSidebar();
  const start = await view.findByRole("button", { name: "新对话" });
  const group = view.getByRole("button", { name: "新建群组" });
  expect(hrefOf(group)).toBe("/group/new");
  expect(start.parentElement).toBe(group.parentElement);
  await userEvent.click(group);
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/group/new"),
  );
});

test("the switch opens on 会话, upstream's whole list, with 员工 and 群组 beside it", async () => {
  const { view } = renderSidebar("/bots", { groups: [] });
  const switcher = await view.findByRole("group", { name: "侧栏列表" });
  expect(
    within(switcher)
      .getAllByRole("button")
      .map((button) => [textOf(button), button.getAttribute("aria-pressed")]),
  ).toEqual([
    ["会话", "true"],
    // Two employees listed, the hidden one left out; the 群组 count is the server's empty answer.
    ["员工2", "false"],
    ["群组0", "false"],
  ]);
  const list = view.getByRole("navigation", { name: "会话" });
  expect(within(list).getAllByRole("link").map(hrefOf)).toEqual([
    "/channel/c-analyst-new",
    "/group/c-crew",
    "/channel/c-analyst-old",
  ]);
  // The roster lists are not drawn, and cost nothing, until they are opened.
  expect(view.queryByRole("list", { name: "员工" })).toBeNull();
  expect(sent).toEqual([]);
});

test("员工 lists each employee once; a row opens its latest 单聊, or a new one addressed to it", async () => {
  const { view, router } = renderSidebar();
  await chooseView(view, /^员工/);
  const list = await view.findByRole("list", { name: "员工" });
  const rows = within(list).getAllByRole("link");
  expect(rows.map((row) => [textOf(row), hrefOf(row)])).toEqual([
    ["分析师整理周报与指标", "/channel/c-analyst-new"],
    ["写手文案", "/channel/new?agent=agent-writer"],
  ]);
  // The 会话 list and its search give way to the roster.
  expect(view.queryByRole("navigation", { name: "会话" })).toBeNull();
  expect(view.queryByRole("searchbox", { name: "搜索会话" })).toBeNull();
  await userEvent.click(rows[0] as HTMLElement);
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/channel/c-analyst-new"),
  );
  // The employee whose 单聊 is open is the one marked.
  await waitFor(() =>
    expect(
      within(list)
        .getAllByRole("link")
        .filter((row) => row.hasAttribute("aria-current"))
        .map(textOf),
    ).toEqual(["分析师整理周报与指标"]),
  );
});

test("员工 says what waits on the person, in words, and offers to resume a paused employee", async () => {
  respond = async (request) =>
    request.url === "/api/bots/agent-writer/resume"
      ? Response.json({ paused: false })
      : Promise.reject(new Error(`Unexpected request ${request.url}`));
  const { view } = renderSidebar("/bots", {
    bots: [
      attention("agent-analyst", { questions: 2, approvals: 1 }),
      attention("agent-writer", { paused: true }),
    ],
  });
  await chooseView(view, /^员工/);
  const list = await view.findByRole("list", { name: "员工" });
  const badge = within(list).getByRole("img", { name: "2 个提问、1 个审批" });
  expect(badge.textContent).toBe("3");
  expect(within(list).getByText("已暂停")).toBeTruthy();
  await userEvent.click(
    within(list).getByRole("button", { name: "恢复 写手" }),
  );
  await waitFor(() =>
    expect(sent.filter((request) => request.method === "POST")).toEqual([
      { url: "/api/bots/agent-writer/resume", method: "POST" },
    ]),
  );
});

test("员工 has 新建员工 and a search by name", async () => {
  const { view } = renderSidebar();
  await chooseView(view, /^员工/);
  const create = await view.findByRole("link", { name: "新建员工" });
  expect(hrefOf(create)).toBe("/bots?new=true");
  await userEvent.click(view.getByRole("button", { name: "搜索员工" }));
  await userEvent.type(
    view.getByRole("searchbox", { name: "按名字搜索员工" }),
    "写",
  );
  const list = view.getByRole("list", { name: "员工" });
  expect(within(list).getAllByRole("link").map(textOf)).toEqual(["写手文案"]);
});

test("群组 holds the 群组 apart from the 单聊, chats first, then the crews not chatting yet with their faces stacked", async () => {
  const { view, router } = renderSidebar("/bots", {
    groups: [
      {
        id: "crew-1",
        name: "周报小队",
        description: null,
        members: [
          { agentId: "agent-writer", position: 1 },
          { agentId: "agent-analyst", position: 0 },
        ],
      },
    ],
  });
  await chooseView(view, /^群组/);
  const chats = await view.findByRole("list", { name: "群组" });
  const chatRows = within(chats).getAllByRole("link");
  expect(chatRows.map(hrefOf)).toEqual(["/group/c-crew", "/bots?tab=groups"]);
  expect(textOf(chatRows[0])).toContain("联合复盘");
  const crew = within(chats).getByRole("link", { name: /周报小队/ });
  expect(hrefOf(crew)).toBe("/bots?tab=groups");
  expect(textOf(crew)).toContain("周报小队");
  expect(textOf(crew)).toContain("2 名员工");
  // One name for the stack, in the order the members answer.
  expect(
    within(crew).getByRole("img", { name: "成员：分析师、写手" }),
  ).toBeTruthy();
  expect(hrefOf(view.getByRole("link", { name: "新建群组" }))).toBe(
    "/group/new",
  );
  await userEvent.click(chatRows[0] as HTMLElement);
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/group/c-crew"),
  );
});

test("群组 offers 新建群组, and says how to start when there is no 群组 yet", async () => {
  const { view, router } = renderSidebar("/bots", {
    channels: [CHANNELS[0] as ChannelSummary],
    groups: [],
  });
  await chooseView(view, /^群组/);
  expect(
    await view.findByText("还没有群组。点「新建群组」，选两位以上员工开始。"),
  ).toBeTruthy();
  // The 群组 toolbar's own entry, besides the one at the top of the sidebar.
  const create = view.getByRole("link", { name: "新建群组" });
  expect(hrefOf(create)).toBe("/group/new");
  await userEvent.click(create);
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/group/new"),
  );
});

test("the 群组 search narrows chats and crews together", async () => {
  const { view } = renderSidebar("/bots", {
    channels: [
      ...CHANNELS,
      channel("c-ops", ["agent-writer", "agent-analyst"], {
        summary: "运维值班",
      }),
    ],
    groups: [{ id: "crew-1", name: "复盘组", description: null, members: [] }],
  });
  await chooseView(view, /^群组/);
  await userEvent.click(await view.findByRole("button", { name: "搜索群组" }));
  await userEvent.type(
    view.getByRole("searchbox", { name: "按名字搜索群组" }),
    "复盘",
  );
  const list = view.getByRole("list", { name: "群组" });
  expect(within(list).getAllByRole("link").map(hrefOf)).toEqual([
    "/group/c-crew",
    "/bots?tab=groups",
  ]);
  expect(within(list).getAllByRole("link").map(textOf)).toEqual([
    expect.stringContaining("联合复盘"),
    expect.stringContaining("复盘组"),
  ]);
});

test("older 群组 load when asked, never by scrolling through 单聊 history", async () => {
  respond = async (request) =>
    request.url === "/api/channels?cursor=older"
      ? Response.json({
          channels: [channel("c-old-crew", ["agent-writer", "agent-analyst"])],
          nextCursor: null,
        })
      : Promise.reject(new Error(`Unexpected request ${request.url}`));
  const { view } = renderSidebar("/bots", {
    channels: [CHANNELS[0] as ChannelSummary],
    nextCursor: "older",
    groups: [],
  });
  await chooseView(view, /^群组/);
  expect(await view.findByText("已加载的会话里还没有群组。")).toBeTruthy();
  expect(sent).toEqual([]);
  await userEvent.click(view.getByRole("button", { name: "加载更早的会话" }));
  const chats = await view.findByRole("list", { name: "群组" });
  expect(within(chats).getAllByRole("link").map(hrefOf)).toEqual([
    "/group/c-old-crew",
  ]);
});

test("the list chosen is remembered for the next visit", async () => {
  const first = renderSidebar("/bots", { groups: [] });
  await chooseView(first.view, /^群组/);
  // The 群组 view is drawn before the sidebar goes away, so the choice was made, not just clicked.
  expect(await first.view.findByRole("list", { name: "群组" })).toBeTruthy();
  cleanup();
  const { view } = renderSidebar("/bots", { groups: [] });
  const switcher = await view.findByRole("group", { name: "侧栏列表" });
  expect(
    within(switcher)
      .getByRole("button", { name: /^群组/ })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  expect(view.queryByRole("navigation", { name: "会话" })).toBeNull();
});

test("a resume that fails says so under the row, by name, with the server's reason", async () => {
  respond = async (request) =>
    request.url === "/api/bots/agent-writer/resume"
      ? Response.json({ error: "这位员工的设备离线。" }, { status: 503 })
      : Promise.reject(new Error(`Unexpected request ${request.url}`));
  const { view } = renderSidebar("/bots", {
    bots: [attention("agent-writer", { paused: true })],
  });
  await chooseView(view, /^员工/);
  const list = await view.findByRole("list", { name: "员工" });
  await userEvent.click(
    within(list).getByRole("button", { name: "恢复 写手" }),
  );
  const alert = await within(list).findByRole("alert");
  expect(alert.textContent).toBe("没能恢复「写手」：这位员工的设备离线。");
  // Still paused, and the button can be pressed again.
  expect(within(list).getByText("已暂停")).toBeTruthy();
  expect(
    within(list).getByRole("button", { name: "恢复 写手" }),
  ).toHaveProperty("disabled", false);
});

test("an employee whose conversation is answering, or has an unseen reply, says so on its row", async () => {
  const { view } = renderSidebar("/bots", {
    channels: [
      channel("c-busy", ["agent-analyst"], {
        busy: true,
        lastMessageAt: "2026-11-07T01:00:00Z",
      }),
      channel("c-unread", ["agent-writer"], {
        lastMessageAt: "2026-11-07T02:00:00Z",
        lastMessageAgentId: "agent-writer",
        lastReadAt: "2026-11-07T00:00:00Z",
      }),
    ],
  });
  await chooseView(view, /^员工/);
  const list = await view.findByRole("list", { name: "员工" });
  const rowOf = (name: RegExp) =>
    within(list).getByRole("link", { name }).closest("li") as HTMLElement;
  expect(
    within(rowOf(/^分析师/)).getByRole("img", { name: "处理中" }),
  ).toBeTruthy();
  expect(
    within(rowOf(/^分析师/)).queryByRole("img", { name: "有未读消息" }),
  ).toBeNull();
  expect(
    within(rowOf(/^写手/)).getByRole("img", { name: "有未读消息" }),
  ).toBeTruthy();
  expect(
    within(rowOf(/^写手/)).queryByRole("img", { name: "处理中" }),
  ).toBeNull();
});

test("an open 群聊 lights no employee, even one older than the loaded pages", async () => {
  const { view } = renderSidebar("/group/c-old-crew", {
    details: [
      { id: "c-old-crew", agentIds: ["agent-analyst", "agent-writer"] },
    ],
  });
  await chooseView(view, /^员工/);
  const list = await view.findByRole("list", { name: "员工" });
  expect(
    within(list)
      .getAllByRole("link")
      .filter((row) => row.hasAttribute("aria-current")),
  ).toEqual([]);
  // Beside the 单聊 it would have been the first member that lit up.
  cleanup();
  const single = renderSidebar("/channel/c-analyst-old");
  await chooseView(single.view, /^员工/);
  const rows = await single.view.findByRole("list", { name: "员工" });
  expect(
    within(rows)
      .getAllByRole("link")
      .filter((row) => row.getAttribute("aria-current") === "true")
      .map(textOf),
  ).toEqual(["分析师整理周报与指标"]);
});

test("the switch names each count with what it counts", async () => {
  const { view } = renderSidebar("/bots", { groups: [] });
  const switcher = await view.findByRole("group", { name: "侧栏列表" });
  expect(
    within(switcher)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label")),
  ).toEqual(["会话", "员工，2 位", "群组，0 个"]);
});

test("a crew short of members reads 待补成员 and opens 员工 › 群组", async () => {
  const { view } = renderSidebar("/bots", {
    channels: [CHANNELS[0] as ChannelSummary],
    groups: [
      {
        id: "crew-short",
        name: "单人组",
        description: null,
        members: [{ agentId: "agent-writer", position: 0 }],
      },
    ],
  });
  await chooseView(view, /^群组/);
  const list = await view.findByRole("list", { name: "群组" });
  const row = within(list).getByRole("link", { name: /单人组/ });
  expect(textOf(row)).toContain("1 名员工 · 待补成员");
  expect(hrefOf(row)).toBe("/bots?tab=groups");
});

test("a crew without a chat reads 未开始聊天, after every chat row", async () => {
  respond = async (request) =>
    request.url === "/api/channels?cursor=older"
      ? Response.json({
          channels: [channel("c-old-crew", ["agent-writer", "agent-analyst"])],
          nextCursor: null,
        })
      : Promise.reject(new Error(`Unexpected request ${request.url}`));
  const { view } = renderSidebar("/bots", {
    nextCursor: "older",
    groups: [
      {
        id: "crew-idle",
        name: "待命组",
        description: null,
        members: [
          { agentId: "agent-analyst", position: 0 },
          { agentId: "agent-writer", position: 1 },
        ],
      },
    ],
  });
  await chooseView(view, /^群组/);
  const list = await view.findByRole("list", { name: "群组" });
  expect(within(list).getAllByRole("link").map(hrefOf)).toEqual([
    "/group/c-crew",
    "/bots?tab=groups",
  ]);
  expect(textOf(within(list).getByRole("link", { name: /待命组/ }))).toContain(
    "2 名员工 · 未开始聊天",
  );
  await userEvent.click(view.getByRole("button", { name: "加载更早的会话" }));
  await waitFor(() =>
    expect(within(list).getAllByRole("link").map(hrefOf)).toEqual([
      "/group/c-crew",
      "/group/c-old-crew",
      "/bots?tab=groups",
    ]),
  );
});

test("a linked chat I started shows the crew's portrait", async () => {
  const { view } = renderSidebar("/bots", {
    groups: [
      {
        id: "crew-linked",
        name: "周报小队",
        description: null,
        channelId: "c-crew",
        members: [
          { agentId: "agent-analyst", position: 0 },
          { agentId: "agent-writer", position: 1 },
        ],
      },
    ],
    portraits: [
      {
        kind: "group",
        id: "crew-linked",
        preset: null,
        imageUrl: "/api/portraits/group/crew-linked/image",
        videoUrl: null,
      },
    ],
  });
  await chooseView(view, /^群组/);
  const list = await view.findByRole("list", { name: "群组" });
  const row = within(list)
    .getAllByRole("link")
    .find((link) => hrefOf(link) === "/group/c-crew") as HTMLElement;
  expect(row.querySelector("img")?.getAttribute("src")).toBe(
    "/api/portraits/group/crew-linked/image",
  );
  // A linked crew is its chat's row, not a second 未开始聊天 row.
  expect(within(list).getAllByRole("link")).toHaveLength(1);
});

/* 召唤员工：员工列表分「已召唤 / 待召唤」。 */
const SUMMON_AGENTS = [
  agent("agent-analyst", "分析师", { roleDescription: "整理周报与指标" }),
  agent("avatar-user", "我的分身", {
    summonKind: "avatar",
    summoned: false,
  }),
  agent("preset-doctor", "暖心医生", {
    title: "医生",
    summonKind: "preset",
    summoned: false,
    presetPortrait: "doctor",
  }),
  agent("preset-lawyer", "专业律师", {
    summonKind: "preset",
    summoned: true,
    presetPortrait: "lawyer",
  }),
  agent("copy-lawyer", "专业律师", {
    summonedFrom: "preset-lawyer",
    summonKind: null,
    summoned: true,
    presetPortrait: "lawyer",
  }),
];

/*
 * 召唤员工 Task 10: summoning happens only on 人才市场 (/bots). 员工 here lists the person's own
 * employees — a summoned copy, the 分身 once summoned, the ones they made — and nothing to summon.
 */
test("员工 lists only the person's own employees; what waits to be summoned is on 人才市场, not here", async () => {
  const { view } = renderSidebar("/bots", { agents: SUMMON_AGENTS });
  await chooseView(view, /^员工/);
  const done = await view.findByRole("list", { name: "员工" });
  expect(
    within(done)
      .getAllByRole("link")
      .map((row) => [textOf(row), hrefOf(row)]),
  ).toEqual([
    ["分析师整理周报与指标", "/channel/c-analyst-new"],
    ["专业律师", "/channel/new?agent=copy-lawyer"],
  ]);
  expect(view.queryByRole("list", { name: "待召唤" })).toBeNull();
  expect(view.queryAllByRole("button", { name: /^召唤/ })).toHaveLength(0);
  expect(view.queryByText("暖心医生")).toBeNull();
  expect(view.queryByText("我的分身")).toBeNull();
  expect(hrefOf(view.getByRole("link", { name: "去人才市场召唤员工" }))).toBe(
    "/bots",
  );
});

test("a summoned employee without a portrait row draws its presetPortrait's picture", async () => {
  const { view } = renderSidebar("/bots", { agents: SUMMON_AGENTS });
  await chooseView(view, /^员工/);
  const list = await view.findByRole("list", { name: "员工" });
  const row = within(list)
    .getAllByRole("link")
    .find((link) => hrefOf(link) === "/channel/new?agent=copy-lawyer");
  expect(row?.querySelector("img")?.getAttribute("src")).toBe(
    PRESET_IMAGES.lawyer,
  );
});

test("with nobody summoned yet, 员工 says to go to 人才市场", async () => {
  const { view } = renderSidebar("/bots", {
    // Nothing of the person's own: only the 分身 and the presets, which wait on 人才市场.
    agents: SUMMON_AGENTS.filter(
      (profile) => !["agent-analyst", "copy-lawyer"].includes(profile.id),
    ),
  });
  await chooseView(view, /^员工/);
  expect(await view.findByText(/还没有员工/)).toBeTruthy();
  expect(hrefOf(view.getByRole("link", { name: "去人才市场" }))).toBe("/bots");
});

test("after a preset is summoned its older conversations stay in 会话 while 员工 lists only the copy", async () => {
  const { view } = renderSidebar("/bots", {
    agents: SUMMON_AGENTS,
    channels: [
      channel("c-old-lawyer", ["preset-lawyer"], {
        summary: "旧的法务会话",
        lastMessageAt: "2026-11-07T01:00:00Z",
      }),
    ],
  });
  const list = await view.findByRole("navigation", { name: "会话" });
  expect(within(list).getAllByRole("link").map(hrefOf)).toEqual([
    "/channel/c-old-lawyer",
  ]);
  await chooseView(view, /^员工/);
  const roster = await view.findByRole("list", { name: "员工" });
  expect(
    within(roster)
      .getAllByRole("link")
      .map((row) => hrefOf(row)),
  ).not.toContain("/channel/c-old-lawyer");
});

test("the 员工 count counts the employees on the person's roster, not the ones still 待召唤", async () => {
  const { view } = renderSidebar("/bots", {
    agents: SUMMON_AGENTS,
    groups: [],
  });
  const switcher = await view.findByRole("group", { name: "侧栏列表" });
  // 分析师 and the copy of 专业律师; 我的分身 and 暖心医生 wait to be summoned.
  expect(
    within(switcher)
      .getByRole("button", { name: /^员工/ })
      .getAttribute("aria-label"),
  ).toBe("员工，2 位");
});
