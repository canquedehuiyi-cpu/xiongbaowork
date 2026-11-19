/*
 * 应用外壳的版式（M5b 第二阶段：页面结构改成上游 main，用户拍板）：侧栏从上到下是品牌和「新对话」、
 * 搜索、全部对话的列表、主导航、「更多」、账户菜单；没有中间栏；设置页保留应用侧栏，设置导航作为
 * 第二栏。原来照 QoderWake 参考图钉的两组导航、员工 / 群组名册和中间栏已经去掉（docs/plans/
 * 2026-11-07-qoderwake-cn-frontend-parity.md 的结构被上游信息架构取代）。
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
import { AppShell } from "@/components/app-sidebar/app-shell";
import { ConversationWorkspace } from "@/components/app-sidebar/conversation-workspace";
import { SettingsNav } from "@/components/settings/settings-sidebar";
import { agentKeys } from "@/lib/agents/queries";
import { authKeys } from "@/lib/auth/queries";
import { avatarSourceKeys } from "@/lib/avatar/sources";
import { botLifecycleKeys } from "@/lib/bot-lifecycle/queries";
import { type ChannelSummary, channelKeys } from "@/lib/channels/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { quotaKeys } from "@/lib/quota/queries";
import { userPreferencesQueryOptions } from "@/lib/settings/message-list";

class OfflineWebSocket extends EventTarget implements WebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  binaryType: BinaryType = "blob";
  bufferedAmount = 0;
  extensions = "";
  protocol = "";
  readyState = 0;
  onclose: WebSocket["onclose"] = null;
  onerror: WebSocket["onerror"] = null;
  onmessage: WebSocket["onmessage"] = null;
  onopen: WebSocket["onopen"] = null;
  readonly url: string;
  constructor(url: string | URL) {
    super();
    this.url = String(url);
  }
  close() {}
  send() {}
}

let originalFetch: typeof fetch;
let originalWebSocket: typeof WebSocket;
let respond: (url: string) => Promise<Response>;
const requests: string[] = [];
const clients: QueryClient[] = [];

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost:3010" });
  originalFetch = globalThis.fetch;
  originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = OfflineWebSocket;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return respond(String(input));
    },
    { preconnect: originalFetch.preconnect },
  );
});
beforeEach(() => {
  window.localStorage.clear();
  requests.length = 0;
  respond = async (url) => {
    throw new Error(`Unexpected request ${url}`);
  };
});
afterEach(() => {
  cleanup();
  for (const client of clients) client.clear();
  clients.length = 0;
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWebSocket;
  GlobalRegistrator.unregister();
});

function agent(
  id: string,
  name: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
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
  agent("agent-pinned", "置顶隐身", { hidden: true, pinned: true }),
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
    lastMessageAgentId: "agent-analyst",
  }),
];

type Options = {
  role?: "user" | "admin";
  agents?: unknown[];
  channels?: ChannelSummary[];
  nextCursor?: string | null;
  attention?: unknown[];
  plan?: string | null;
  /** The column between the sidebar and the page: settings' navigation, or the conversation workspace `_app.tsx` passes. */
  secondary?: "settings" | "workspace";
};

function renderShell(path: string, options: Options = {}) {
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
    role: options.role ?? "user",
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
  queryClient.setQueryData(agentKeys.list(false), options.agents ?? AGENTS);
  queryClient.setQueryDefaults(botLifecycleKeys.attention, {
    staleTime: Number.POSITIVE_INFINITY,
    refetchInterval: false,
  });
  queryClient.setQueryData(botLifecycleKeys.attention, {
    bots: options.attention ?? [],
    lastPingId: null,
  });
  if (options.plan !== null) {
    queryClient.setQueryData(quotaKeys.usage(), {
      plan: { id: "pro", name: options.plan ?? "专业版" },
      limits: { wakers: 10, tasksPerMonth: 100, devices: 3 },
      usage: { wakers: 2, tasks: 4, devices: 1 },
      tokens: null,
    });
  }
  queryClient.setQueryData(channelKeys.list(), {
    pages: [
      {
        channels: options.channels ?? CHANNELS,
        nextCursor: options.nextCursor ?? null,
      },
    ],
    pageParams: [""],
  });
  const rootRoute = createRootRoute({
    component: () => (
      <AppShell
        secondary={
          options.secondary === "settings" ? (
            <SettingsNav />
          ) : options.secondary === "workspace" ? (
            <ConversationWorkspace />
          ) : null
        }
      >
        <Outlet />
      </AppShell>
    ),
  });
  const leaf = (path: string) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path,
      component: () => null,
    });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      leaf("/tasks"),
      leaf("/bots"),
      leaf("/bot"),
      leaf("/settings"),
      leaf("/settings/passwords"),
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
  return { view, router, queryClient };
}

const hrefOf = (node: Element | null) => node?.getAttribute("href") ?? null;
const textOf = (node: Element | null | undefined) =>
  node?.textContent?.replace(/\s+/g, " ").trim();
const follows = (first: Element, second: Element) =>
  Boolean(
    first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING,
  );

async function openAccountMenu(view: ReturnType<typeof renderShell>["view"]) {
  await userEvent.click(
    await view.findByRole("button", { name: "账户：熊宝用户" }),
  );
  return view.findByRole("menu");
}

/* ------------------------------------------------------------------------------------------------ */
/* Header and navigation                                                                             */
/* ------------------------------------------------------------------------------------------------ */

test("the header carries the product name and a collapse button that hides the sidebar", async () => {
  const { view } = renderShell("/tasks");
  const collapse = await view.findByRole("button", { name: "隐藏侧栏" });
  const sidebar = view.container.querySelector('[data-slot="sidebar"]');
  expect(sidebar?.getAttribute("data-state")).toBe("expanded");
  await userEvent.click(collapse);
  expect(sidebar?.getAttribute("data-state")).toBe("collapsed");
});

test("top to bottom: 新对话, the search, the conversations, the destinations, 更多, the account", async () => {
  const { view } = renderShell("/tasks");
  const nav = await view.findByRole("navigation", { name: "主导航" });
  const start = view.getByRole("button", { name: "新对话" });
  const search = view.getByRole("searchbox", { name: "搜索会话" });
  const list = view.getByRole("navigation", { name: "会话" });
  const more = view.getByRole("button", { name: "更多" });
  const account = view.getByRole("button", { name: "账户：熊宝用户" });
  expect(follows(start, search)).toBe(true);
  expect(follows(search, list)).toBe(true);
  expect(follows(list, nav)).toBe(true);
  expect(follows(nav, more)).toBe(true);
  expect(follows(more, account)).toBe(true);
  // 用户决定找回 #452 去掉的熊宝分组标题「工作管理」「员工资源」，六项按组排。
  expect(textOf(nav)).toBe(
    "工作管理任务看板自主工作@Waker员工资源人才市场能力连接",
  );
});

test("the open entry is drawn with the active row and nothing else is", async () => {
  const { view } = renderShell("/tasks");
  const nav = await view.findByRole("navigation", { name: "主导航" });
  const current = [...nav.querySelectorAll('[aria-current="page"]')];
  expect(current.map(textOf)).toEqual(["任务看板"]);
  expect(current[0]?.getAttribute("data-status")).toBe("active");
});

/* ------------------------------------------------------------------------------------------------ */
/* The conversation list                                                                             */
/* ------------------------------------------------------------------------------------------------ */

test("the list holds every conversation, newest first, a 群聊 among them", async () => {
  const { view } = renderShell("/tasks");
  const list = await view.findByRole("navigation", { name: "会话" });
  const rows = within(list).getAllByRole("link");
  expect(rows.map((row) => [textOf(row), hrefOf(row)])).toEqual([
    [expect.stringContaining("本周周报"), "/channel/c-analyst-new"],
    [expect.stringContaining("联合复盘"), "/group/c-crew"],
    [expect.stringContaining("上周指标"), "/channel/c-analyst-old"],
  ]);
});

test("the open conversation is selected; another with an unseen reply carries the unread mark", async () => {
  const { view } = renderShell("/channel/c-analyst-new");
  const list = await view.findByRole("navigation", { name: "会话" });
  const rows = within(list).getAllByRole("link");
  expect(rows[0]?.getAttribute("aria-current")).toBe("page");
  expect(within(rows[2] as HTMLElement).getByText("未读")).toBeTruthy();
  expect(within(rows[0] as HTMLElement).queryByText("未读")).toBeNull();
});

test("a pinned conversation comes first and says so", async () => {
  const { view } = renderShell("/tasks", {
    channels: [
      CHANNELS[0] as ChannelSummary,
      { ...(CHANNELS[2] as ChannelSummary), pinned: true },
    ],
  });
  const list = await view.findByRole("navigation", { name: "会话" });
  const rows = within(list).getAllByRole("link");
  expect(hrefOf(rows[0] ?? null)).toBe("/channel/c-analyst-old");
  expect(within(rows[0] as HTMLElement).getByLabelText("已置顶")).toBeTruthy();
});

test("the search narrows the list to what it has loaded", async () => {
  const { view } = renderShell("/tasks");
  await userEvent.type(
    await view.findByRole("searchbox", { name: "搜索会话" }),
    "复盘",
  );
  const list = view.getByRole("navigation", { name: "会话" });
  // Rows that stop matching leave; their exit fade is the only thing a filter animates.
  await waitFor(() =>
    expect(within(list).getAllByRole("link").map(hrefOf)).toEqual([
      "/group/c-crew",
    ]),
  );
});

/*
 * 经用户同意修改：用户决定找回 #452 去掉的熊宝中间栏，所以这一条从「对话旁边没有中间栏」改成锁定找回后的样子——
 * 外壳照 `_app.tsx` 那样带上中间栏时，对话旁边有一栏讲这位员工、带「对话任务 / 自动任务」页签；侧栏里仍然没有
 * 页签；窄屏不画这一栏；离开对话页就没有它。
 */
test("beside a conversation, a column about its employee sits between the sidebar and the chat, and a narrow screen does not draw it", async () => {
  const { view } = renderShell("/channel/c-analyst-new", {
    secondary: "workspace",
  });
  const column = await view.findByRole("complementary", {
    name: "分析师的对话",
  });
  const sidebar = view.container.querySelector('[data-slot="sidebar"]');
  expect(sidebar).not.toBeNull();
  expect(follows(sidebar as Element, column)).toBe(true);
  expect(follows(column, view.container.querySelector("main") as Element)).toBe(
    true,
  );
  // The tabs are the column's own; the sidebar still has none.
  expect(within(sidebar as HTMLElement).queryByRole("tablist")).toBeNull();
  expect(
    view.getAllByRole("tablist").map((tabs) => tabs.getAttribute("aria-label")),
  ).toEqual(["任务类型"]);
  expect(column.contains(view.getByRole("tablist"))).toBe(true);
  // Under the md breakpoint the column is not drawn; the sidebar's 员工 list reaches the same conversations.
  expect(column.className.split(/\s+/)).toEqual(
    expect.arrayContaining(["hidden", "md:flex"]),
  );
  cleanup();
  const elsewhere = renderShell("/tasks", { secondary: "workspace" });
  await elsewhere.view.findByRole("navigation", { name: "主导航" });
  expect(elsewhere.view.queryByRole("complementary")).toBeNull();
});

/* ------------------------------------------------------------------------------------------------ */
/* Account menu, 小管家                                                                               */
/* ------------------------------------------------------------------------------------------------ */

test("the account row names who is signed in and opens the account menu upward", async () => {
  const { view } = renderShell("/tasks");
  const menu = await openAccountMenu(view);
  expect(within(menu).getAllByRole("menuitem").map(textOf)).toEqual([
    "我的分身",
    "套餐与用量专业版",
    "设置",
    "主题",
    "语言",
    "退出登录",
  ]);
  expect(hrefOf(within(menu).getByRole("menuitem", { name: "设置" }))).toBe(
    "/settings",
  );
});

test("an administrator's menu also offers 管理", async () => {
  const { view } = renderShell("/tasks", { role: "admin" });
  const menu = await openAccountMenu(view);
  expect(within(menu).getAllByRole("menuitem").map(textOf)).toEqual([
    "我的分身",
    "套餐与用量专业版",
    "设置",
    "管理",
    "主题",
    "语言",
    "退出登录",
  ]);
});

test("the shell floats no 小管家 over the page: it lives in a workbench page's breadcrumb bar", async () => {
  // Covered where it is drawn now: tests/page-shell-workbench.test.tsx.
  const chat = renderShell("/channel/c-analyst-new");
  await chat.view.findByRole("navigation", { name: "主导航" });
  expect(chat.view.queryByRole("link", { name: "小管家" })).toBeNull();
});

/* ------------------------------------------------------------------------------------------------ */
/* Settings inside the shell                                                                         */
/* ------------------------------------------------------------------------------------------------ */

test("settings keep the app sidebar and add their own column with a way back", async () => {
  const { view } = renderShell("/settings/passwords", {
    secondary: "settings",
  });
  expect(await view.findByRole("navigation", { name: "主导航" })).toBeTruthy();
  expect(view.getByRole("navigation", { name: "会话" })).toBeTruthy();
  const settings = view.getByRole("navigation", { name: "设置导航" });
  expect(hrefOf(within(settings).getByRole("link", { name: "返回" }))).toBe(
    "/",
  );
  // Which entries settings lists is settings' own (tests/settings-sidebar.test.ts); here, only that
  // the column is there, after the sidebar, with the open page marked.
  const entries = within(settings)
    .getAllByRole("link")
    .filter((link) => textOf(link) !== "返回");
  expect(entries.map(hrefOf)).toContain("/settings/passwords");
  expect(
    entries
      .filter((link) => link.getAttribute("aria-current") === "page")
      .map(textOf),
  ).toEqual(["密码"]);
  expect(
    follows(view.getByRole("navigation", { name: "主导航" }), settings),
  ).toBe(true);
});

/*
 * An employee's name is already written on its conversation row, so the face beside it is
 * decoration. Labelling it with the name again made screen readers say every name twice and made
 * `getByLabel("<name>")` in the G4 browser run match the sidebar as well as the WakerFlow form's
 * member checkbox.
 */
test("no element in the shell is labelled with an employee's bare name", async () => {
  const { view } = renderShell("/channel/c-analyst-new");
  await view.findByRole("navigation", { name: "会话" });
  const labelled = ["分析师", "写手"].flatMap((name) => [
    ...[...view.container.querySelectorAll(`[aria-label="${name}"]`)].map(
      (node) => `${node.tagName.toLowerCase()}[aria-label=${name}]`,
    ),
  ]);
  expect(labelled).toEqual([]);
});

test("the account menu reads the plan once on its own, so its name shows before the plans page was ever opened", async () => {
  const quotaRequests = () => requests.filter((url) => url === "/api/quota");
  respond = async (url) =>
    url === "/api/quota"
      ? Response.json({
          plan: { id: "pro", name: "专业版" },
          limits: { wakers: 10, tasksPerMonth: 100, devices: 3 },
          usage: { wakers: 2, tasks: 4, devices: 1 },
          tokens: null,
        })
      : Response.json({});
  const { view } = renderShell("/tasks", { plan: null });
  await waitFor(() => expect(quotaRequests()).toHaveLength(1));
  const menu = await openAccountMenu(view);
  expect(await within(menu).findByText("专业版")).toBeTruthy();
  // One read, and no polling: the plans screen is where the numbers are kept fresh.
  expect(quotaRequests()).toHaveLength(1);
});
