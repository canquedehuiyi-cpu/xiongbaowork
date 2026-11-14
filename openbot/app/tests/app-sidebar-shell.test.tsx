/*
 * 熊宝侧栏，按上游 main 的结构（M5b 第二阶段，用户拍板）：顶部品牌和「新对话」，搜索，全部对话的列表
 * （群聊就是列表里的一行，头像叠放），底部是 lib/navigation.ts 的主导航——员工、任务看板、自主工作、
 * @Waker、能力、连接——和「更多」里的组团流程，最下面是账户菜单。旧的员工 / 群组名册和中间栏去掉了。
 * 更细的版式在 app-shell-parity.test.tsx。
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
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import {
  act,
  cleanup,
  fireEvent,
  render,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  AppSidebar,
  conversationStamp,
} from "@/components/app-sidebar/app-sidebar";
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
import { type WakerGroup, wakerGroupKeys } from "@/lib/waker-groups/queries";

// Keep the sidebar's live-update socket offline; these tests exercise HTTP pagination.
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

class ScrollObserver implements IntersectionObserver {
  static active = new Set<ScrollObserver>();
  readonly root;
  readonly rootMargin;
  readonly thresholds = [0];
  private targets = new Set<Element>();
  constructor(
    private callback: IntersectionObserverCallback,
    options: IntersectionObserverInit = {},
  ) {
    this.root = options.root ?? null;
    this.rootMargin = options.rootMargin ?? "0px";
    ScrollObserver.active.add(this);
  }
  observe(target: Element) {
    this.targets.add(target);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  disconnect() {
    this.targets.clear();
    ScrollObserver.active.delete(this);
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  intersect(isIntersecting = true) {
    this.callback(
      [...this.targets].map((target) => ({
        target,
        isIntersecting,
        intersectionRatio: isIntersecting ? 1 : 0,
        boundingClientRect: target.getBoundingClientRect(),
        intersectionRect: target.getBoundingClientRect(),
        rootBounds: null,
        time: 0,
      })),
      this,
    );
  }
}

let originalFetch: typeof fetch;
let originalWebSocket: typeof WebSocket;
let originalObserver: typeof IntersectionObserver;
let respond: () => Promise<Response>;
const requests: string[] = [];
const clients: QueryClient[] = [];

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost:3010" });
  originalFetch = globalThis.fetch;
  originalWebSocket = globalThis.WebSocket;
  originalObserver = globalThis.IntersectionObserver;
  globalThis.WebSocket = OfflineWebSocket;
  globalThis.IntersectionObserver = ScrollObserver;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return respond();
    },
    { preconnect: originalFetch.preconnect },
  );
});
beforeEach(() => {
  window.localStorage.clear();
  requests.length = 0;
  respond = async () => {
    throw new Error("Unexpected request");
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
  globalThis.IntersectionObserver = originalObserver;
  GlobalRegistrator.unregister();
});

function channel(
  id: string,
  agentIds: string[] = [],
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
    createdAt: "2026-09-15T00:00:00Z",
    pinned: false,
    lastReadAt: null,
    ...extra,
  };
}

function renderSidebar(
  path = "/",
  rows: ChannelSummary[] = [channel("Recent conversation")],
  {
    nextCursor = null,
    agents = [],
    role = "user",
    avatar = "avatar-user",
    signIn = true,
    groups = [],
  }: {
    nextCursor?: string | null;
    agents?: unknown[];
    role?: "user" | "admin";
    /** The 分身's agent id, or null when the server has none to give. */
    avatar?: string | null;
    /** Whether there is a sign-in to end (false on a single-person install). */
    signIn?: boolean;
    /** The groups the person made, as `/api/waker-groups` lists them. */
    groups?: WakerGroup[] | null;
  } = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  clients.push(queryClient);
  queryClient.setQueryData(userPreferencesQueryOptions("user").queryKey, {
    messageListEmphasis: "thread",
    selfHostBannerDismissed: false,
    narration: null,
    skin: "xiongbao",
    proactive: "on",
  });
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    selfHostBanner: false,
    localEvaluation: !signIn,
    edition: "team",
  });
  // The account menu reads the plan once on its own; these tests count channel requests only.
  queryClient.setQueryData(quotaKeys.usage(), {
    plan: { id: "pro", name: "专业版" },
    limits: { wakers: 10, tasksPerMonth: 100, devices: 3 },
    usage: { wakers: 2, tasks: 4, devices: 1 },
    tokens: null,
  });
  if (avatar) {
    queryClient.setQueryData(avatarSourceKeys.state(), {
      agentId: avatar,
      configuredAt: null,
      sources: [],
    });
  }
  queryClient.setQueryData(authKeys.currentUser(), {
    id: "user",
    email: "user@example.com",
    name: "熊宝用户",
    role,
    onboarding: null,
  });
  queryClient.setQueryData(agentKeys.list(false), agents);
  // The 员工 badge polls on its own schedule; this test counts channel requests only.
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
  // Nobody has chosen a 头像 here; seeded so the faces draw without a read the test did not plan.
  queryClient.setQueryData(portraitKeys.all, []);
  if (groups) queryClient.setQueryData(wakerGroupKeys.list(), groups);
  queryClient.setQueryData(channelKeys.list(), {
    pages: [{ channels: rows, nextCursor }],
    pageParams: [""],
  });
  const routeTree = createRootRoute({
    component: () => (
      <SidebarProvider>
        <AppSidebar />
      </SidebarProvider>
    ),
  });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function hrefOf(link: Element | null): string | null {
  return link?.getAttribute("href") ?? null;
}

const textOf = (node: Element | null | undefined) =>
  node?.textContent?.replace(/\s+/g, " ").trim();

test("the primary navigation lists 熊宝's destinations in the order the user chose", async () => {
  const view = renderSidebar();
  const nav = await view.findByRole("navigation", { name: "主导航" });
  const links = [...nav.querySelectorAll("a")];
  /*
   * 用户决定找回 #452 去掉的熊宝分组标题：「工作管理」下是任务看板、自主工作、@Waker，「员工资源」下是员工、
   * 能力、连接（v0.2.7 的两组），所以主导航按组排，六项都在。
   */
  expect(links.map((link) => [textOf(link), hrefOf(link)])).toEqual([
    ["任务看板", "/tasks"],
    ["自主工作", "/autonomous"],
    ["@Waker", "/reachability"],
    ["人才市场", "/bots"],
    ["能力", "/capabilities"],
    ["连接", "/connections"],
  ]);
  const group = (name: string) =>
    [...within(nav).getByRole("list", { name }).querySelectorAll("a")].map(
      (link) => textOf(link),
    );
  expect(group("工作管理")).toEqual(["任务看板", "自主工作", "@Waker"]);
  expect(group("员工资源")).toEqual(["人才市场", "能力", "连接"]);
});

test("the entry for the open page is marked current", async () => {
  const view = renderSidebar("/bots");
  const nav = await view.findByRole("navigation", { name: "主导航" });
  const current = [...nav.querySelectorAll('[aria-current="page"]')];
  expect(current.map(textOf)).toEqual(["人才市场"]);
});

test("更多 holds 组团流程; the old pages are not linked from the sidebar", async () => {
  const view = renderSidebar();
  const more = await view.findByRole("button", { name: "更多" });
  expect(more.getAttribute("aria-expanded")).toBe("false");
  await userEvent.click(more);
  expect(more.getAttribute("aria-expanded")).toBe("true");
  const region = view.getByRole("navigation", { name: "更多入口" });
  expect(
    [...region.querySelectorAll("a")].map((link) => [
      textOf(link),
      hrefOf(link),
    ]),
  ).toEqual([
    ["组团流程", "/pipelines"],
    /*
     * 用户决定找回 #452 去掉的熊宝直达入口：团队 Bot 和审批收件箱回到「更多」，两页也恢复成页面，所以不再在
     * 下面「只重定向、不该被链接」的清单里。
     */
    ["团队 Bot", "/team-bots"],
    ["审批", "/approvals"],
  ]);
  // Each of these redirects to its new place now; the sidebar links the new places only.
  for (const href of [
    "/wakers",
    "/resources",
    "/plans",
    "/agents",
    "/skills",
    "/knowledge",
    "/memory",
    "/responsibilities",
    "/routines",
  ]) {
    expect(view.container.querySelector(`a[href="${href}"]`)).toBeNull();
  }
});

test.each([
  ["/bots/agent-1", "人才市场"],
  ["/bots/agent-1/setup", "人才市场"],
  ["/responsibilities", "自主工作"],
  ["/routines", "自主工作"],
  ["/capabilities/plugins", "能力"],
  ["/wakerflows", "能力"],
  ["/wakerflows/flow-1", "能力"],
  ["/connections/github", "连接"],
])(
  "on %s the entry that owns it, %s, is marked current",
  async (path, label) => {
    const view = renderSidebar(path);
    const nav = await view.findByRole("navigation", { name: "主导航" });
    const current = [...nav.querySelectorAll('[aria-current="page"]')].map(
      textOf,
    );
    expect(current).toEqual([label]);
  },
);

test("the top carries the brand, 新对话 and a search over the conversations", async () => {
  const view = renderSidebar();
  expect(hrefOf(await view.findByRole("button", { name: "新对话" }))).toBe(
    "/channel/new",
  );
  expect(view.getByRole("searchbox", { name: "搜索会话" })).toBeTruthy();
  expect(view.getByRole("button", { name: "隐藏侧栏" })).toBeTruthy();
});

test("every conversation is in the list, a 群聊 among them as a row with its faces stacked", async () => {
  const view = renderSidebar("/", [
    channel("solo", ["a"], { summary: "退货流程" }),
    channel("crew", ["a", "b"], { summary: "联合复盘" }),
  ]);
  const list = await view.findByRole("navigation", { name: "会话" });
  const rows = within(list).getAllByRole("link");
  expect(rows.map((row) => hrefOf(row))).toEqual([
    "/channel/solo",
    "/group/crew",
  ]);
  expect(textOf(rows[0])).toContain("退货流程");
  expect(textOf(rows[1])).toContain("联合复盘");
  // One face for a one-to-one conversation; the group's faces stack in one avatar.
  expect(rows[0]?.querySelectorAll("svg").length).toBe(1);
  expect(rows[1]?.querySelectorAll("svg").length).toBeGreaterThan(1);
});

test("an empty list says how to start, and a search that matches nothing says so", async () => {
  const empty = renderSidebar("/", []);
  expect(await empty.findByText("还没有会话")).toBeTruthy();
  cleanup();
  const view = renderSidebar("/", [channel("周报", ["a"])]);
  await userEvent.type(
    await view.findByRole("searchbox", { name: "搜索会话" }),
    "不存在",
  );
  expect(await view.findByText("没有匹配的会话")).toBeTruthy();
  expect(view.queryByText("还没有会话")).toBeNull();
});

test("a search with older pages unloaded offers more, and does not page on its own", async () => {
  const view = renderSidebar("/", [channel("周报", ["a"])], {
    nextCursor: "older/page",
  });
  await userEvent.type(
    await view.findByRole("searchbox", { name: "搜索会话" }),
    "复盘",
  );
  expect(await view.findByText("已加载的会话里没有匹配的")).toBeTruthy();
  expect(view.getByRole("button", { name: "加载更早的会话" })).toBeTruthy();
  // Searching must not walk the whole history by itself: no observer is armed.
  act(() => {
    for (const observer of ScrollObserver.active) observer.intersect();
  });
  expect(requests).toEqual([]);
});

test("the account menu: 我的分身, 套餐与用量 with the plan, 设置, 主题, 语言 and 退出登录", async () => {
  const view = renderSidebar();
  await userEvent.click(
    await view.findByRole("button", { name: "账户：熊宝用户" }),
  );
  const menu = await view.findByRole("menu");
  expect(within(menu).getAllByRole("menuitem").map(textOf)).toEqual([
    "我的分身",
    "套餐与用量专业版",
    "设置",
    "主题",
    "语言",
    "退出登录",
  ]);
  expect(hrefOf(within(menu).getByRole("menuitem", { name: "我的分身" }))).toBe(
    "/bots/avatar-user",
  );
  expect(
    hrefOf(within(menu).getByRole("menuitem", { name: /^套餐与用量/ })),
  ).toBe("/settings/plans");
  expect(hrefOf(within(menu).getByRole("menuitem", { name: "设置" }))).toBe(
    "/settings",
  );
  // 小管家 is in a workbench page's breadcrumb bar, not in the sidebar.
  expect(view.queryByRole("link", { name: "小管家" })).toBeNull();
});

test("an administrator's menu also offers 管理, after 设置", async () => {
  const view = renderSidebar("/", undefined, { role: "admin" });
  await userEvent.click(
    await view.findByRole("button", { name: "账户：熊宝用户" }),
  );
  const menu = await view.findByRole("menu");
  expect(within(menu).getAllByRole("menuitem").map(textOf)).toEqual([
    "我的分身",
    "套餐与用量专业版",
    "设置",
    "管理",
    "主题",
    "语言",
    "退出登录",
  ]);
  expect(hrefOf(within(menu).getByRole("menuitem", { name: "管理" }))).toBe(
    "/admin",
  );
});

test("with no 分身 to open and no sign-in to end, the menu leaves both out", async () => {
  const view = renderSidebar("/", undefined, { avatar: null, signIn: false });
  respond = async () => Response.json({ error: "没有分身" }, { status: 404 });
  await userEvent.click(
    await view.findByRole("button", { name: "账户：熊宝用户" }),
  );
  const menu = await view.findByRole("menu");
  expect(within(menu).getAllByRole("menuitem").map(textOf)).toEqual([
    "套餐与用量专业版",
    "设置",
    "主题",
    "语言",
  ]);
});

test("on a page that lives under 更多, the section opens and marks it current", async () => {
  const view = renderSidebar("/pipelines");
  const more = await view.findByRole("button", { name: "更多" });
  expect(more.getAttribute("aria-expanded")).toBe("true");
  const region = view.getByRole("navigation", { name: "更多入口" });
  expect(
    region.querySelector('[aria-current="page"]')?.textContent?.trim(),
  ).toBe("组团流程");
});

test("a conversation's time is short and in Chinese: today's as a clock, this year's as a date", () => {
  const now = new Date(2026, 10, 11, 18, 0);
  expect(
    conversationStamp(new Date(2026, 10, 11, 9, 5).toISOString(), now),
  ).toBe("09:05");
  expect(
    conversationStamp(new Date(2026, 9, 6, 0, 56).toISOString(), now),
  ).toBe("10月6日");
  expect(conversationStamp(new Date(2025, 9, 6).toISOString(), now)).toBe(
    "2025/10/6",
  );
  expect(conversationStamp("not a date", now)).toBe("");
});

test("a linked chat the person made offers 解散群组… in the list", async () => {
  const view = renderSidebar(
    "/",
    [
      channel("solo", ["a"], { summary: "退货流程" }),
      channel("crew", ["a", "b"], { summary: "联合复盘", canRename: true }),
    ],
    {
      groups: [
        {
          id: "wg-1",
          name: "复盘群",
          description: null,
          members: [],
          channelId: "crew",
        },
      ],
    },
  );
  const list = await view.findByRole("navigation", { name: "会话" });
  fireEvent.contextMenu(within(list).getByRole("link", { name: /联合复盘/ }));
  expect(
    await within(document.body).findByRole("menuitem", { name: /解散群组…/ }),
  ).toBeTruthy();
  expect(
    within(document.body).queryByRole("menuitem", { name: /删除会话…/ }),
  ).toBeNull();
});

test("a package's multi-employee channel has no group, so its menu never offers 解散群组…", async () => {
  const view = renderSidebar(
    "/",
    [channel("pkg", ["a", "b"], { summary: "工程团队", canRename: true })],
    { groups: [] },
  );
  const list = await view.findByRole("navigation", { name: "会话" });
  fireEvent.contextMenu(within(list).getByRole("link", { name: /工程团队/ }));
  expect(
    await within(document.body).findByRole("menuitem", { name: /删除会话…/ }),
  ).toBeTruthy();
  expect(
    within(document.body).queryByRole("menuitem", { name: /解散群组…/ }),
  ).toBeNull();
});

test("the groups are asked for only when a row's menu opens, and a disabled placeholder stands in until they arrive", async () => {
  const view = renderSidebar(
    "/",
    [channel("crew", ["a", "b"], { summary: "联合复盘", canRename: true })],
    { groups: null },
  );
  respond = () => new Promise<Response>(() => {});
  const list = await view.findByRole("navigation", { name: "会话" });
  expect(requests.filter((url) => url.includes("waker-groups"))).toEqual([]);
  fireEvent.contextMenu(within(list).getByRole("link", { name: /联合复盘/ }));
  const waiting = await within(document.body).findByRole("menuitem", {
    name: /正在读取…/,
  });
  expect(waiting.getAttribute("aria-disabled")).toBe("true");
  expect(
    within(document.body).queryByRole("menuitem", { name: /删除会话…/ }),
  ).toBeNull();
  expect(requests.filter((url) => url.includes("waker-groups"))).toHaveLength(
    1,
  );
});
