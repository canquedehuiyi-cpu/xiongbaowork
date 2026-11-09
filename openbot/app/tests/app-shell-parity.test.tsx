/*
 * The app shell against the reference screenshots (docs/acceptance/qoderwake-reference/*.png, plus
 * the conversation and settings screens described in the parity brief): two labelled nav groups, an
 * employee / group roster under underline tabs, the conversation workspace column, the account
 * footer and its upward menu, the floating 小管家, and settings inside the same shell.
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
import { SettingsNav } from "@/components/settings/settings-sidebar";
import { agentKeys } from "@/lib/agents/queries";
import { authKeys } from "@/lib/auth/queries";
import { botLifecycleKeys } from "@/lib/bot-lifecycle/queries";
import { type ChannelSummary, channelKeys } from "@/lib/channels/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { quotaKeys } from "@/lib/quota/queries";
import { userPreferencesQueryOptions } from "@/lib/settings/message-list";
import { wakerGroupKeys } from "@/lib/waker-groups/queries";

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
  groups?: unknown[] | "error";
  attention?: unknown[];
  plan?: string | null;
  secondary?: "settings";
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
    skin: "openbot",
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
  if (options.groups !== "error") {
    queryClient.setQueryData(wakerGroupKeys.list(), options.groups ?? []);
  }
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
        secondary={options.secondary === "settings" ? <SettingsNav /> : null}
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
      leaf("/wakers"),
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

test("the five entries sit under two labelled groups, in the reference order", async () => {
  const { view } = renderShell("/tasks");
  const nav = await view.findByRole("navigation", { name: "主导航" });
  const work = within(nav).getByRole("group", { name: "工作管理" });
  const people = within(nav).getByRole("group", { name: "员工资源" });
  expect(
    within(work)
      .getAllByRole("link")
      .map((link) => [textOf(link), hrefOf(link)]),
  ).toEqual([
    ["任务看板", "/tasks"],
    ["@Waker", "/reachability"],
    ["自主工作", "/autonomous"],
  ]);
  expect(
    within(people)
      .getAllByRole("link")
      .map((link) => [textOf(link), hrefOf(link)]),
  ).toEqual([
    ["员工管理", "/wakers"],
    ["能力与资源", "/resources"],
  ]);
  // Labels are drawn before their rows: 工作管理, its three, 员工资源, its two.
  expect(textOf(nav)).toBe(
    "工作管理任务看板@Waker自主工作员工资源员工管理能力与资源",
  );
  // The 员工 / 群组 tabs follow the two groups directly, as in the reference; 更多 (ours, not the
  // reference's) sits at the foot after the roster so it cannot push the roster down.
  const more = view.getByRole("button", { name: "更多" });
  const tabs = view.getByRole("tablist", { name: "员工与群组" });
  expect(
    nav.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    tabs.compareDocumentPosition(more) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});

test("the open entry is drawn with the active row and nothing else is", async () => {
  const { view } = renderShell("/tasks");
  const nav = await view.findByRole("navigation", { name: "主导航" });
  const current = [...nav.querySelectorAll('[aria-current="page"]')];
  expect(current.map(textOf)).toEqual(["任务看板"]);
});

/* ------------------------------------------------------------------------------------------------ */
/* 员工 tab                                                                                          */
/* ------------------------------------------------------------------------------------------------ */

test("the 员工 tab lists the roster with counts, minus hidden employees nobody pinned", async () => {
  const { view } = renderShell("/tasks", {
    groups: [{ id: "g1", name: "周报群", description: null, members: [] }],
  });
  const tabs = await view.findByRole("tablist", { name: "员工与群组" });
  expect(
    within(tabs)
      .getAllByRole("tab")
      .map((tab) => [textOf(tab), tab.getAttribute("aria-selected")]),
  ).toEqual([
    ["员工 (3)", "true"],
    ["群组 (1)", "false"],
  ]);
  const list = view.getByRole("list", { name: "员工" });
  const rows = within(list).getAllByRole("link");
  expect(rows.map((row) => textOf(row))).toEqual([
    "分析师整理周报与指标",
    "写手文案",
    "置顶隐身",
  ]);
  expect(view.queryByText("隐身员工")).toBeNull();
  expect(hrefOf(view.getByRole("link", { name: "新建员工" }))).toBe(
    "/wakers?new=true",
  );
});

test("an employee row opens its most recent one-to-one conversation, or a new one", async () => {
  const { view } = renderShell("/tasks");
  const list = await view.findByRole("list", { name: "员工" });
  expect(hrefOf(within(list).getByRole("link", { name: /分析师/ }))).toBe(
    "/channel/c-analyst-new",
  );
  expect(hrefOf(within(list).getByRole("link", { name: /写手/ }))).toBe(
    "/channel/new?agent=agent-writer",
  );
});

test("the employee in the open conversation is the selected row", async () => {
  const { view } = renderShell("/channel/c-analyst-old");
  const list = await view.findByRole("list", { name: "员工" });
  const selected = within(list)
    .getAllByRole("link")
    .filter((row) => row.getAttribute("aria-current") === "true");
  expect(selected.map((row) => textOf(row)?.slice(0, 3))).toEqual(["分析师"]);
});

test("the search button reveals a filter over the employee list", async () => {
  const { view } = renderShell("/tasks");
  await view.findByRole("list", { name: "员工" });
  expect(view.queryByRole("searchbox", { name: "按名字搜索员工" })).toBeNull();
  await userEvent.click(view.getByRole("button", { name: "搜索员工" }));
  await userEvent.type(
    view.getByRole("searchbox", { name: "按名字搜索员工" }),
    "写",
  );
  const list = view.getByRole("list", { name: "员工" });
  expect(within(list).getAllByRole("link").map(textOf)).toEqual(["写手文案"]);
  await userEvent.type(
    view.getByRole("searchbox", { name: "按名字搜索员工" }),
    "不存在",
  );
  expect(view.getByText("没有匹配的员工")).toBeTruthy();
});

test("what an employee needs from you rides on its row: a count badge and a paused marker", async () => {
  respond = async (url) => {
    if (url.endsWith("/resume")) return Response.json({ lifecycle: {} });
    throw new Error(`Unexpected request ${url}`);
  };
  const { view } = renderShell("/tasks", {
    attention: [
      {
        agentId: "agent-analyst",
        name: "分析师",
        questions: 2,
        approvals: 1,
        handoffs: 0,
        unread: 0,
        paused: false,
        notify: "all",
        items: 0,
        tasks: { needsInput: 0, ready: 0, failed: 0 },
      },
      {
        agentId: "agent-writer",
        name: "写手",
        questions: 0,
        approvals: 0,
        handoffs: 0,
        unread: 0,
        paused: true,
        notify: "all",
        items: 0,
        tasks: { needsInput: 0, ready: 0, failed: 0 },
      },
    ],
  });
  const list = await view.findByRole("list", { name: "员工" });
  const badge = within(list).getByTitle("2 个提问、1 个审批");
  expect(textOf(badge)).toBe("3");
  expect(within(list).getByText("已暂停")).toBeTruthy();
  // The separate attention list is gone: the employee appears once.
  expect(within(list).getAllByRole("link", { name: /写手/ })).toHaveLength(1);
  await userEvent.click(view.getByRole("button", { name: "恢复 写手" }));
  await waitFor(() =>
    expect(requests).toContain("/api/bots/agent-writer/resume"),
  );
});

/* ------------------------------------------------------------------------------------------------ */
/* 群组 tab                                                                                          */
/* ------------------------------------------------------------------------------------------------ */

test("the 群组 tab lists groups with their members and links to the group wall", async () => {
  const { view } = renderShell("/tasks", {
    groups: [
      {
        id: "g1",
        name: "周报群",
        description: null,
        members: [
          { agentId: "agent-analyst", position: 0 },
          { agentId: "agent-writer", position: 1 },
        ],
      },
    ],
  });
  await userEvent.click(await view.findByRole("tab", { name: "群组 (1)" }));
  expect(hrefOf(view.getByRole("link", { name: "新建群组" }))).toBe(
    "/wakers?tab=groups",
  );
  const list = view.getByRole("list", { name: "群组" });
  const row = within(list).getByRole("link", { name: /周报群/ });
  expect(hrefOf(row)).toBe("/wakers?tab=groups");
  expect(within(row).getByText("2 名员工")).toBeTruthy();
  // The stacked avatars are named once, as a group, not one name per face.
  expect(
    within(row).getByRole("img", { name: "成员：分析师、写手" }),
  ).toBeTruthy();
});

test("the 群组 tab says so when there are none", async () => {
  const { view } = renderShell("/tasks", { groups: [] });
  await userEvent.click(await view.findByRole("tab", { name: "群组 (0)" }));
  expect(view.getByText("还没有群组")).toBeTruthy();
});

test("a failed group read says so and retries on request", async () => {
  let fail = true;
  respond = async (url) => {
    if (url === "/api/waker-groups") {
      return fail
        ? Response.json({ error: "down" }, { status: 503 })
        : Response.json({
            groups: [
              { id: "g2", name: "复盘群", description: null, members: [] },
            ],
          });
    }
    throw new Error(`Unexpected request ${url}`);
  };
  const { view } = renderShell("/tasks", { groups: "error" });
  await userEvent.click(await view.findByRole("tab", { name: "群组" }));
  expect(await view.findByText("群组加载失败。")).toBeTruthy();
  fail = false;
  await userEvent.click(view.getByRole("button", { name: "重试" }));
  expect(await view.findByText("复盘群")).toBeTruthy();
  expect(view.getByRole("tab", { name: "群组 (1)" })).toBeTruthy();
});

/* ------------------------------------------------------------------------------------------------ */
/* The conversation workspace column                                                                 */
/* ------------------------------------------------------------------------------------------------ */

test("no workspace column on a workbench page", async () => {
  const { view } = renderShell("/tasks");
  await view.findByRole("navigation", { name: "主导航" });
  expect(view.queryByRole("complementary", { name: /的对话/ })).toBeNull();
});

test("on a conversation the workspace column lists that employee's conversations", async () => {
  const { view } = renderShell("/channel/c-analyst-new");
  const column = await view.findByRole("complementary", {
    name: "分析师的对话",
  });
  const scope = within(column);
  expect(hrefOf(scope.getByRole("link", { name: "管理" }))).toBe(
    "/wakers/agent-analyst",
  );
  expect(
    scope
      .getAllByRole("tab")
      .map((tab) => [textOf(tab), tab.getAttribute("aria-selected")]),
  ).toEqual([
    ["对话任务", "true"],
    ["自动任务", "false"],
  ]);
  expect(scope.getByText("共3个任务")).toBeTruthy();
  expect(hrefOf(scope.getByRole("link", { name: "新建" }))).toBe(
    "/channel/new?agent=agent-analyst",
  );
  const rows = scope.getAllByRole("link", { name: /聊天|群聊/ });
  expect(rows.map((row) => [textOf(row), hrefOf(row)])).toEqual([
    [expect.stringContaining("本周周报"), "/channel/c-analyst-new"],
    [expect.stringContaining("联合复盘"), "/group/c-crew"],
    [expect.stringContaining("上周指标"), "/channel/c-analyst-old"],
  ]);
  expect(textOf(rows[0])).toContain("聊天 |");
  expect(textOf(rows[1])).toContain("群聊 |");
  // The open conversation is selected; another with an unseen reply carries the unread mark.
  expect(rows[0]?.getAttribute("aria-current")).toBe("page");
  expect(within(rows[2] as HTMLElement).getByText("未读")).toBeTruthy();
  expect(within(rows[0] as HTMLElement).queryByText("未读")).toBeNull();
});

test("a new conversation addressed to an employee shows that employee, with nothing yet", async () => {
  const { view } = renderShell("/channel/new?agent=agent-writer", {
    channels: [CHANNELS[0] as ChannelSummary],
  });
  const column = await view.findByRole("complementary", {
    name: "写手的对话",
  });
  expect(within(column).getByText("共0个任务")).toBeTruthy();
  expect(within(column).getByText("还没有和写手的对话")).toBeTruthy();
});

test("a group conversation shows the workspace of its first member", async () => {
  const { view } = renderShell("/group/c-crew");
  const column = await view.findByRole("complementary", {
    name: "分析师的对话",
  });
  const row = within(column).getByRole("link", { name: /联合复盘/ });
  expect(row.getAttribute("aria-current")).toBe("page");
});

test("the workspace searches what it has loaded", async () => {
  const { view } = renderShell("/channel/c-analyst-new");
  const column = await view.findByRole("complementary", {
    name: "分析师的对话",
  });
  await userEvent.click(
    within(column).getByRole("button", { name: "搜索对话" }),
  );
  await userEvent.type(
    within(column).getByRole("searchbox", { name: "搜索会话" }),
    "复盘",
  );
  // Rows that stop matching leave; their exit fade is the only thing a filter animates.
  await waitFor(() =>
    expect(
      within(column)
        .getAllByRole("link", { name: /聊天|群聊/ })
        .map((row) => textOf(row)?.slice(0, 4)),
    ).toEqual(["联合复盘"]),
  );
});

test("自动任务 lists the employee's automations, routines and responsibilities with links into 自主工作", async () => {
  respond = async (url) => {
    if (url === "/api/agents/agent-analyst/autonomous") {
      return Response.json({
        autonomous: {
          agentId: "agent-analyst",
          routines: [
            {
              id: "r1",
              instruction: "每天汇总指标",
              enabled: true,
              nextRunAt: "2026-11-08T01:00:00Z",
              channelId: "c-analyst-new",
              lastRun: null,
            },
          ],
          responsibilities: [
            {
              id: "p1",
              title: "盯住转化率",
              status: "active",
              channelId: "c-analyst-new",
              lastRun: null,
            },
          ],
          proactive: [],
          lastActivityAt: null,
        },
      });
    }
    if (url === "/api/automations") {
      return Response.json({
        automations: [
          {
            id: "a1",
            name: "周一出周报",
            target: { kind: "waker", agentId: "agent-analyst" },
            enabled: true,
            maxRuns: null,
            endDate: null,
            runCount: 0,
            createdAt: "2026-11-01T00:00:00Z",
          },
          {
            id: "a2",
            name: "别人的自动任务",
            target: { kind: "waker", agentId: "agent-writer" },
            enabled: true,
            maxRuns: null,
            endDate: null,
            runCount: 0,
            createdAt: "2026-11-01T00:00:00Z",
          },
        ],
      });
    }
    throw new Error(`Unexpected request ${url}`);
  };
  const { view } = renderShell("/channel/c-analyst-new");
  const column = await view.findByRole("complementary", {
    name: "分析师的对话",
  });
  await userEvent.click(within(column).getByRole("tab", { name: "自动任务" }));
  expect(await within(column).findByText("共3个任务")).toBeTruthy();
  const links = within(column)
    .getAllByRole("link")
    .filter((link) => hrefOf(link)?.startsWith("/autonomous?detail="));
  expect(links.map((link) => [textOf(link), hrefOf(link)])).toEqual([
    [
      expect.stringContaining("周一出周报"),
      "/autonomous?detail=automation%3Aa1",
    ],
    [
      expect.stringContaining("每天汇总指标"),
      "/autonomous?detail=routine%3Ar1",
    ],
    [
      expect.stringContaining("盯住转化率"),
      "/autonomous?detail=responsibility%3Ap1",
    ],
  ]);
  expect(within(column).queryByText("别人的自动任务")).toBeNull();
});

/* ------------------------------------------------------------------------------------------------ */
/* Footer, account menu, 小管家                                                                       */
/* ------------------------------------------------------------------------------------------------ */

test("the footer shows the account and its plan, a usage link and the settings menu", async () => {
  const { view } = renderShell("/tasks");
  const footer = await view.findByRole("region", { name: "账户" });
  expect(within(footer).getByText("熊宝用户")).toBeTruthy();
  expect(within(footer).getByText("专业版")).toBeTruthy();
  expect(hrefOf(within(footer).getByRole("link", { name: "套餐与用量" }))).toBe(
    "/plans",
  );
  await userEvent.click(within(footer).getByRole("button", { name: "设置" }));
  const menu = await view.findByRole("menu");
  expect(within(menu).getAllByRole("menuitem").map(textOf)).toEqual([
    "设置",
    "主题",
    "语言",
    "退出登录",
  ]);
  expect(hrefOf(within(menu).getByRole("menuitem", { name: "设置" }))).toBe(
    "/settings",
  );
  // The menu ends with who is signed in and on what plan.
  expect(textOf(menu)).toMatch(/熊宝用户.*专业版$/);
});

test("an administrator's menu also offers 管理", async () => {
  const { view } = renderShell("/tasks", { role: "admin" });
  const footer = await view.findByRole("region", { name: "账户" });
  await userEvent.click(within(footer).getByRole("button", { name: "设置" }));
  const menu = await view.findByRole("menu");
  expect(within(menu).getAllByRole("menuitem").map(textOf)).toEqual([
    "设置",
    "主题",
    "语言",
    "管理",
    "退出登录",
  ]);
});

test("the 小管家 floats over the five workbench pages and nowhere else", async () => {
  const workbench = renderShell("/tasks");
  const butler = await workbench.view.findByRole("link", { name: "小管家" });
  expect(hrefOf(butler)).toBe("/bot");
  expect(within(butler).getByRole("img", { name: "熊宝" })).toBeTruthy();
  cleanup();
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
  const settings = view.getByRole("navigation", { name: "设置导航" });
  expect(hrefOf(within(settings).getByRole("link", { name: "返回" }))).toBe(
    "/",
  );
  const entries = within(settings)
    .getAllByRole("link")
    .filter((link) => textOf(link) !== "返回");
  expect(entries.map((link) => [textOf(link), hrefOf(link)])).toEqual([
    ["通用", "/settings"],
    ["已连接的账号", "/settings/connected-accounts"],
    ["浏览器", "/settings/browsers"],
    ["学习", "/settings/learning"],
    ["密码", "/settings/passwords"],
    ["组件展示", "/settings/components-gallery"],
  ]);
  expect(
    entries
      .filter((link) => link.getAttribute("aria-current") === "page")
      .map(textOf),
  ).toEqual(["密码"]);
  // No conversation column here: the settings column takes its place.
  expect(view.queryByRole("complementary", { name: /的对话/ })).toBeNull();
});

/*
 * An employee's name is already written on its row, in the workspace header and on the group row,
 * so the avatar beside it is decoration. Labelling it with the name again made screen readers say
 * every name twice and made `getByLabel("<name>")` in the G4 browser run match the sidebar as well
 * as the WakerFlow form's member checkbox.
 */
test("no element in the shell is labelled with an employee's bare name", async () => {
  const { view } = renderShell("/channel/c-analyst-new", {
    groups: [
      {
        id: "g1",
        name: "周报群",
        description: null,
        members: [
          { agentId: "agent-analyst", position: 0 },
          { agentId: "agent-writer", position: 1 },
        ],
      },
    ],
  });
  await view.findByRole("complementary", { name: "分析师的对话" });
  const labelled = () =>
    ["分析师", "写手"].flatMap((name) => [
      ...[...view.container.querySelectorAll(`[aria-label="${name}"]`)].map(
        (node) => `${node.tagName.toLowerCase()}[aria-label=${name}]`,
      ),
    ]);
  expect(labelled()).toEqual([]);
  await userEvent.click(await view.findByRole("tab", { name: "群组 (1)" }));
  expect(labelled()).toEqual([]);
});

test("the footer reads the plan once on its own, so its name shows before /plans was ever opened", async () => {
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
  const footer = await view.findByRole("region", { name: "账户" });
  expect(await within(footer).findByText("专业版")).toBeTruthy();
  // One read, and no polling: the plans screen is where the numbers are kept fresh.
  expect(quotaRequests()).toHaveLength(1);
});
