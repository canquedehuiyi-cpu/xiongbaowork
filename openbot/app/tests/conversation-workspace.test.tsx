/*
 * 对话页旁边的中间栏（熊宝 v0.2.7，#452 去掉后找回）：当前员工的头像、名字和「管理」，「对话任务 / 自动任务」
 * 两个页签，「+ 新建」，以及这位员工的会话或它自己在做的自动任务。外壳由 `_app.tsx` 把它作为 secondary 传进来，
 * 这里照那样装配；不在对话页时不画。
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
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppShell } from "@/components/app-sidebar/app-shell";
import { ConversationWorkspace } from "@/components/app-sidebar/conversation-workspace";
import { agentKeys } from "@/lib/agents/queries";
import { authKeys } from "@/lib/auth/queries";
import { automationKeys } from "@/lib/automations/queries";
import { autonomousKeys } from "@/lib/autonomous/queries";
import { avatarSourceKeys } from "@/lib/avatar/sources";
import { botLifecycleKeys } from "@/lib/bot-lifecycle/queries";
import { browserKeys } from "@/lib/browser/queries";
import { type ChannelSummary, channelKeys } from "@/lib/channels/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { portraitKeys } from "@/lib/portraits/queries";
import { quotaKeys } from "@/lib/quota/queries";
import { userPreferencesQueryOptions } from "@/lib/settings/message-list";
import { type WakerGroup, wakerGroupKeys } from "@/lib/waker-groups/queries";
import { settleReactWork } from "./settle-react-work";

class OfflineWebSocket extends EventTarget {
  readyState = 0;
  close() {}
  send() {}
}

/** Pages on sight, as the browser's observer does: armed observers are kept so a test can see them. */
class ScrollObserver {
  static armed = new Set<ScrollObserver>();
  readonly root: Element | null;
  constructor(
    private callback: IntersectionObserverCallback,
    options: IntersectionObserverInit = {},
  ) {
    this.root = (options.root as Element | null) ?? null;
  }
  observe() {
    ScrollObserver.armed.add(this);
  }
  unobserve() {}
  disconnect() {
    ScrollObserver.armed.delete(this);
  }
  takeRecords() {
    return [];
  }
  /** The observers watching a list inside `within`, e.g. the column rather than the sidebar. */
  static armedIn(within: Element) {
    return [...ScrollObserver.armed].filter(
      (observer) => observer.root !== null && within.contains(observer.root),
    );
  }
  /** Every sentinel armed inside `within` comes into view. */
  static scrollIntoView(within: Element) {
    for (const observer of ScrollObserver.armedIn(within))
      observer.callback(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        observer as unknown as IntersectionObserver,
      );
  }
}

let originalFetch: typeof fetch;
let originalWebSocket: typeof WebSocket;
let originalObserver: typeof IntersectionObserver;
/** How the server answers a read; unanswered reads are a 404. */
let answer: (url: string) => Promise<Response> | undefined;
const clients: QueryClient[] = [];

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost:3010" });
  originalFetch = globalThis.fetch;
  originalWebSocket = globalThis.WebSocket;
  originalObserver = globalThis.IntersectionObserver;
  globalThis.WebSocket = OfflineWebSocket as unknown as typeof WebSocket;
  globalThis.IntersectionObserver =
    ScrollObserver as unknown as typeof IntersectionObserver;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) =>
      (await answer(String(input))) ??
      Response.json({ error: "not served" }, { status: 404 }),
    { preconnect: originalFetch.preconnect },
  );
});
beforeEach(() => {
  window.localStorage.clear();
  answer = () => undefined;
  ScrollObserver.armed.clear();
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
  globalThis.IntersectionObserver = originalObserver;
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
  channel("c-writer", ["agent-writer"], {
    summary: "改文案",
    lastMessageAt: "2026-11-06T12:00:00Z",
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

function renderApp(
  path: string,
  {
    channels = CHANNELS,
    nextCursor = null,
    groups = [],
  }: {
    channels?: ChannelSummary[];
    nextCursor?: string | null;
    groups?: WakerGroup[];
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
  queryClient.setQueryData(authKeys.currentUser(), {
    id: "user",
    email: "user@example.com",
    name: "熊宝用户",
    role: "user",
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
  queryClient.setQueryData(agentKeys.list(false), [
    agent("agent-analyst", "分析师"),
    agent("agent-writer", "写手"),
  ]);
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
  queryClient.setQueryData(automationKeys.list(), [
    {
      id: "auto-1",
      name: "每周一汇总销售",
      target: { kind: "waker", agentId: "agent-analyst" },
      enabled: true,
      maxRuns: null,
      endDate: null,
      runCount: 3,
      createdAt: "2026-11-01T00:00:00Z",
    },
    {
      id: "auto-2",
      name: "写手的早报",
      target: { kind: "waker", agentId: "agent-writer" },
      enabled: true,
      maxRuns: null,
      endDate: null,
      runCount: 0,
      createdAt: "2026-11-01T00:00:00Z",
    },
  ]);
  queryClient.setQueryData(autonomousKeys.forAgent("agent-analyst"), {
    agentId: "agent-analyst",
    routines: [
      {
        id: "r-1",
        instruction: "每天九点看库存",
        enabled: false,
        nextRunAt: "2026-11-08T01:00:00Z",
        channelId: "c-analyst-new",
        lastRun: null,
      },
    ],
    responsibilities: [
      {
        id: "resp-1",
        title: "盯住退货率",
        status: "active",
        channelId: "c-analyst-new",
        lastRun: null,
      },
    ],
    proactive: [
      {
        id: "p-1",
        focus: "库存告急",
        enabled: true,
        intervalMinutes: 60,
        nextRunAt: "2026-11-08T01:00:00Z",
        lastRunAt: null,
        lastStatus: "ok",
      },
    ],
    lastActivityAt: null,
  });
  queryClient.setQueryData(wakerGroupKeys.list(), groups);
  queryClient.setQueryData(channelKeys.list(), {
    pages: [{ channels, nextCursor }],
    pageParams: [""],
  });
  const rootRoute = createRootRoute({
    component: () => (
      <AppShell secondary={<ConversationWorkspace />}>
        <Outlet />
      </AppShell>
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
      leaf("/tasks"),
      leaf("/autonomous"),
      leaf("/bots/$agentId"),
      leaf("/channel/new"),
      leaf("/channel/$channelId"),
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

test("beside a 单聊, the column is about its employee: name, 管理, 新建 and its conversations", async () => {
  const { view } = renderApp("/channel/c-analyst-new");
  const column = await view.findByRole("complementary", {
    name: "分析师的对话",
  });
  expect(hrefOf(within(column).getByRole("link", { name: "管理" }))).toBe(
    "/bots/agent-analyst",
  );
  expect(hrefOf(within(column).getByRole("link", { name: "新建" }))).toBe(
    "/channel/new?agent=agent-analyst",
  );
  expect(within(column).getByText("共3个任务")).toBeTruthy();
  const list = column.querySelector('[data-slot="workspace-list"]');
  // Its 单聊 and the 群聊 it is in, newest first; not another employee's.
  expect(
    [...(list?.querySelectorAll("a") ?? [])].map((row) => hrefOf(row)),
  ).toEqual([
    "/channel/c-analyst-new",
    "/group/c-crew",
    "/channel/c-analyst-old",
  ]);
  // The open one is marked.
  expect(
    list?.querySelector('a[aria-current="page"]')?.getAttribute("href"),
  ).toBe("/channel/c-analyst-new");
});

test("对话任务 / 自动任务: the second lists what it does on its own, each opening its row on 自主工作", async () => {
  const { view } = renderApp("/channel/c-analyst-new");
  const column = await view.findByRole("complementary", {
    name: "分析师的对话",
  });
  const tabs = within(column).getByRole("tablist", { name: "任务类型" });
  expect(within(tabs).getAllByRole("tab").map(textOf)).toEqual([
    "对话任务",
    "自动任务",
  ]);
  await userEvent.click(within(tabs).getByRole("tab", { name: "自动任务" }));
  // Four of its own (one automation, one routine, one responsibility, one check-in), where its
  // conversations were three: the count is the automations'.
  await waitFor(() =>
    expect(within(column).getByText("共4个任务")).toBeTruthy(),
  );
  const rows = within(column)
    .getAllByRole("link")
    .filter((link) => hrefOf(link)?.startsWith("/autonomous?detail="));
  expect(rows.map((row) => [textOf(row), hrefOf(row)])).toEqual([
    ["每周一汇总销售自动任务", "/autonomous?detail=automation%3Aauto-1"],
    ["每天九点看库存定时任务 · 已停用", "/autonomous?detail=routine%3Ar-1"],
    ["盯住退货率长期职责", "/autonomous?detail=responsibility%3Aresp-1"],
    ["库存告急主动巡检", "/autonomous?detail=proactive%3Ap-1"],
  ]);
  // The tabs name the panel they switch, and the panel is labelled by the open one.
  const panel = within(column).getByRole("tabpanel");
  expect(
    within(tabs)
      .getAllByRole("tab")
      .map((tab) => tab.getAttribute("aria-controls")),
  ).toEqual([panel.id, panel.id]);
  expect(panel.getAttribute("aria-labelledby")).toBe(
    within(tabs).getByRole("tab", { name: "自动任务" }).id,
  );
  expect(hrefOf(within(column).getByRole("link", { name: "新建" }))).toBe(
    "/autonomous",
  );
});

test("beside a 群聊, the column is about its first member", async () => {
  const { view } = renderApp("/group/c-crew");
  expect(
    await view.findByRole("complementary", { name: "分析师的对话" }),
  ).toBeTruthy();
});

test("a new conversation addressed to an employee shows that employee's column", async () => {
  const { view } = renderApp("/channel/new?agent=agent-writer");
  const column = await view.findByRole("complementary", {
    name: "写手的对话",
  });
  const list = column.querySelector('[data-slot="workspace-list"]');
  expect(
    [...(list?.querySelectorAll("a") ?? [])].map((row) => hrefOf(row)),
  ).toEqual(["/channel/c-writer", "/group/c-crew"]);
});

test("the column searches this employee's conversations only", async () => {
  const { view } = renderApp("/channel/c-analyst-new");
  const column = await view.findByRole("complementary", {
    name: "分析师的对话",
  });
  await userEvent.click(
    within(column).getByRole("button", { name: "搜索对话" }),
  );
  await userEvent.type(
    within(column).getByRole("searchbox", { name: "搜索会话" }),
    "指标",
  );
  const list = column.querySelector('[data-slot="workspace-list"]');
  await waitFor(() =>
    expect(
      [...(list?.querySelectorAll("a") ?? [])].map((row) => hrefOf(row)),
    ).toEqual(["/channel/c-analyst-old"]),
  );
});

test("off the conversation pages there is no column", async () => {
  const { view } = renderApp("/tasks");
  await view.findByRole("navigation", { name: "主导航" });
  expect(view.queryByRole("complementary")).toBeNull();
});

test("one employee's few conversations do not page through everybody's history on sight", async () => {
  const older = Promise.withResolvers<Response>();
  answer = (url) =>
    url === "/api/channels?cursor=older" ? older.promise : undefined;
  const { view } = renderApp("/channel/c-writer", { nextCursor: "older" });
  const column = await view.findByRole("complementary", {
    name: "写手的对话",
  });
  const button = await within(column).findByRole("button", {
    name: "加载更早的会话",
  });
  // Nothing armed in the column: the sentinel in view of a short list loads nothing by itself.
  ScrollObserver.scrollIntoView(column);
  expect(ScrollObserver.armedIn(column)).toEqual([]);
  // Asked for, the next page loads.
  await userEvent.click(button);
  older.resolve(
    Response.json({
      channels: [
        channel("c-writer-old", ["agent-writer"], { summary: "旧稿" }),
      ],
      nextCursor: null,
    }),
  );
  expect(await within(column).findByText("旧稿")).toBeTruthy();
});

test("with older pages unloaded the count says what is loaded, and the whole only once it is", async () => {
  const first = renderApp("/channel/c-analyst-new", { nextCursor: "older" });
  const column = await first.view.findByRole("complementary", {
    name: "分析师的对话",
  });
  expect(within(column).getByText("已加载3个")).toBeTruthy();
  expect(within(column).queryByText("共3个任务")).toBeNull();
  cleanup();
  const whole = renderApp("/channel/c-analyst-new");
  const all = await whole.view.findByRole("complementary", {
    name: "分析师的对话",
  });
  expect(within(all).getByText("共3个任务")).toBeTruthy();
});

test("while whose conversation it is is still being read, the column waits instead of listing every one", async () => {
  const pending = Promise.withResolvers<Response>();
  answer = (url) =>
    url === "/api/channels/c-elsewhere" ? pending.promise : undefined;
  const { view } = renderApp("/group/c-elsewhere");
  const waiting = await view.findByRole("complementary", {
    name: "正在读取对话",
  });
  expect(waiting.getAttribute("aria-busy")).toBe("true");
  expect(view.queryByRole("complementary", { name: "全部对话" })).toBeNull();
  expect(within(waiting).queryAllByRole("link")).toEqual([]);
  pending.resolve(
    Response.json({
      channel: {
        id: "c-elsewhere",
        name: "c-elsewhere",
        agentIds: ["agent-writer", "agent-analyst"],
        threadId: "c-elsewhere",
        active: true,
        lastMessageAt: null,
      },
    }),
  );
  expect(
    await view.findByRole("complementary", { name: "写手的对话" }),
  ).toBeTruthy();
});

test("an employee the roster does not list is named from its own record", async () => {
  answer = (url) =>
    url === "/api/agents/agent-ghost"
      ? Promise.resolve(
          Response.json({ agent: agent("agent-ghost", "隐身员工") }),
        )
      : undefined;
  const { view } = renderApp("/channel/c-ghost", {
    channels: [channel("c-ghost", ["agent-ghost"], { summary: "悄悄话" })],
  });
  expect(
    await view.findByRole("complementary", { name: "隐身员工的对话" }),
  ).toBeTruthy();
});

test("a linked chat the person made offers 解散群组… in the employee's list", async () => {
  const { view } = renderApp("/channel/c-analyst-new", {
    channels: CHANNELS.map((row) =>
      row.id === "c-crew" ? { ...row, canRename: true } : row,
    ),
    groups: [
      {
        id: "wg-1",
        name: "复盘群",
        description: null,
        members: [],
        channelId: "c-crew",
      },
    ],
  });
  const column = await view.findByRole("complementary", {
    name: "分析师的对话",
  });
  fireEvent.contextMenu(within(column).getByRole("link", { name: /联合复盘/ }));
  expect(
    await within(document.body).findByRole("menuitem", { name: /解散群组…/ }),
  ).toBeTruthy();
});

test("with no conversation yet, the column sends a new person to 员工 to summon one, and its button opens that list", async () => {
  const { view } = renderApp("/channel/new", { channels: [] });
  // A new conversation is addressed to the default employee, so the column is about it.
  const column = await view.findByRole("complementary", {
    name: "分析师的对话",
  });
  expect(within(column).getByText("还没有和分析师的对话")).toBeTruthy();
  expect(
    within(column).getByText(
      "先在「员工」列表里召唤一位员工，和它的对话会出现在这里。",
    ),
  ).toBeTruthy();
  expect(within(column).queryByText(/点「新建」开始第一段对话/)).toBeNull();
  const switcher = view.getByRole("group", { name: "侧栏列表" });
  await userEvent.click(
    within(column).getByRole("button", { name: "去员工列表" }),
  );
  expect(
    within(switcher)
      .getByRole("button", { name: /^员工/ })
      .getAttribute("aria-pressed"),
  ).toBe("true");
});

test("once the person has a conversation, an employee without one still says 「新建」 starts it", async () => {
  const { view } = renderApp("/channel/new?agent=agent-writer", {
    channels: [CHANNELS[0] as ChannelSummary],
  });
  const column = await view.findByRole("complementary", {
    name: "写手的对话",
  });
  expect(
    within(column).getByText("点「新建」开始第一段对话，它就会出现在这里。"),
  ).toBeTruthy();
  expect(
    within(column).queryByRole("button", { name: "去员工列表" }),
  ).toBeNull();
});
