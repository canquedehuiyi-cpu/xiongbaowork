/*
 * The workbench shell (docs/plans/2026-11-07-qoderwake-cn-frontend-parity.md, F1): the five primary
 * entries in the reference product's order at the top of the sidebar, an employee / group roster
 * under 员工 and 群组, conversations in the workspace column beside an open one, and every route
 * this product had before still one click away under 更多. The finer reference measurements are in
 * app-shell-parity.test.tsx.
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
import { act, cleanup, render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppSidebar, channelTab } from "@/components/app-sidebar/app-sidebar";
import { ConversationWorkspace } from "@/components/app-sidebar/conversation-workspace";
import { SidebarProvider } from "@/components/ui/sidebar";
import { agentKeys } from "@/lib/agents/queries";
import { authKeys } from "@/lib/auth/queries";
import { botLifecycleKeys } from "@/lib/bot-lifecycle/queries";
import { type ChannelSummary, channelKeys } from "@/lib/channels/queries";
import { userPreferencesQueryOptions } from "@/lib/settings/message-list";
import { wakerGroupKeys } from "@/lib/waker-groups/queries";

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

function channel(id: string, agentIds: string[] = []): ChannelSummary {
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
  };
}

function renderSidebar(
  path = "/",
  rows: ChannelSummary[] = [channel("Recent conversation")],
  {
    nextCursor = null,
    agents = [],
  }: { nextCursor?: string | null; agents?: unknown[] } = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  clients.push(queryClient);
  queryClient.setQueryData(userPreferencesQueryOptions("user").queryKey, {
    messageListEmphasis: "thread",
    selfHostBannerDismissed: false,
  });
  queryClient.setQueryData(authKeys.currentUser(), {
    id: "user",
    email: "user@example.com",
    role: "user",
    onboarding: null,
  });
  queryClient.setQueryData(agentKeys.list(false), agents);
  // The sidebar's attention list polls on its own schedule; this test counts channel requests only.
  queryClient.setQueryDefaults(botLifecycleKeys.attention, {
    staleTime: Number.POSITIVE_INFINITY,
    refetchInterval: false,
  });
  queryClient.setQueryData(botLifecycleKeys.attention, []);
  queryClient.setQueryData(wakerGroupKeys.list(), []);
  queryClient.setQueryData(channelKeys.list(), {
    pages: [{ channels: rows, nextCursor }],
    pageParams: [""],
  });
  const routeTree = createRootRoute({
    component: () => (
      <SidebarProvider>
        <AppSidebar />
        <ConversationWorkspace />
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

test("the primary navigation lists the five workbench entries in the reference order", async () => {
  const view = renderSidebar();
  const nav = await view.findByRole("navigation", { name: "主导航" });
  const links = [...nav.querySelectorAll("a")];
  expect(links.map((link) => link.textContent?.trim())).toEqual([
    "任务看板",
    "@Waker",
    "自主工作",
    "员工管理",
    "能力与资源",
  ]);
  expect(links.map(hrefOf)).toEqual([
    "/tasks",
    "/reachability",
    "/autonomous",
    "/wakers",
    "/resources",
  ]);
});

test("the entry for the open page is marked current", async () => {
  const view = renderSidebar("/wakers");
  const nav = await view.findByRole("navigation", { name: "主导航" });
  const current = nav.querySelector('[aria-current="page"]');
  expect(current?.textContent?.trim()).toBe("员工管理");
});

test("更多 holds only what no workbench page covers; duplicates are archived", async () => {
  const view = renderSidebar();
  const more = await view.findByRole("button", { name: "更多" });
  expect(more.getAttribute("aria-expanded")).toBe("false");
  await userEvent.click(more);
  expect(more.getAttribute("aria-expanded")).toBe("true");
  const region = view.getByRole("navigation", { name: "更多入口" });
  expect([...region.querySelectorAll("a")].map(hrefOf)).toEqual([
    "/pipelines",
    "/team-bots",
    "/approvals",
  ]);
  // Each of these is now a tab or a view of one of the five pages.
  for (const href of [
    "/agents",
    "/bots",
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
  ["/responsibilities", "自主工作"],
  ["/bots/agent-1", "员工管理"],
  ["/assemble/agent-1", "员工管理"],
  ["/wakers/agent-1", "员工管理"],
  ["/wakerflows", "能力与资源"],
  ["/wakerflows/flow-1", "能力与资源"],
])(
  "on %s the entry that owns it, %s, is marked current",
  async (path, label) => {
    const view = renderSidebar(path);
    const nav = await view.findByRole("navigation", { name: "主导航" });
    const current = [...nav.querySelectorAll('[aria-current="page"]')].map(
      (node) => node.textContent?.trim(),
    );
    expect(current).toEqual([label]);
  },
);

test("a conversation with two or more coworkers is a group; everything else belongs to 员工", () => {
  expect(channelTab(channel("solo", ["a"]))).toBe("wakers");
  expect(channelTab(channel("empty"))).toBe("wakers");
  expect(channelTab(channel("crew", ["a", "b"]))).toBe("groups");
});

test("the 员工 and 群组 tabs switch between the roster and the groups, and retarget the new button", async () => {
  const view = renderSidebar("/", [channel("和客服小熊的会话", ["a"])], {
    agents: [{ id: "a", name: "客服小熊", hidden: false, pinned: false }],
  });
  const employees = await view.findByRole("list", { name: "员工" });
  expect(employees.textContent).toContain("客服小熊");
  // Conversations are not listed in the sidebar any more: they live beside an open conversation.
  expect(view.queryByText("和客服小熊的会话")).toBeNull();
  expect(hrefOf(view.getByRole("link", { name: "新建员工" }))).toBe(
    "/wakers?new=true",
  );

  await userEvent.click(view.getByRole("tab", { name: "群组 (0)" }));
  expect(view.queryByRole("list", { name: "员工" })).toBeNull();
  expect(await view.findByText("还没有群组")).toBeTruthy();
  expect(hrefOf(view.getByRole("link", { name: "新建群组" }))).toBe(
    "/wakers?tab=groups",
  );
});

test("the footer carries the account, usage and the settings menu; 小管家 floats on the page instead", async () => {
  const view = renderSidebar();
  const footer = await view.findByRole("region", { name: "账户" });
  expect(footer.textContent).toContain("user@example.com");
  expect(hrefOf(view.getByRole("link", { name: "套餐与用量" }))).toBe("/plans");
  await userEvent.click(view.getByRole("button", { name: "设置" }));
  expect(hrefOf(await view.findByRole("menuitem", { name: "设置" }))).toBe(
    "/settings",
  );
  expect(view.getByRole("menuitem", { name: "退出登录" })).toBeTruthy();
  expect(view.queryByRole("link", { name: "小管家" })).toBeNull();
});

test("an employee with nothing among the loaded pages says so, offers more, and does not page on its own", async () => {
  const view = renderSidebar(
    "/channel/new?agent=b",
    [channel("和客服小熊的会话", ["a"])],
    {
      nextCursor: "older/page",
      agents: [
        { id: "a", name: "客服小熊", hidden: false, pinned: false },
        { id: "b", name: "周报员", hidden: false, pinned: false },
      ],
    },
  );
  const column = await view.findByRole("complementary", {
    name: "周报员的对话",
  });
  expect(column.textContent).toContain("已加载的会话里没有和周报员的对话");
  expect(view.queryByText("还没有和周报员的对话")).toBeNull();
  expect(view.queryByText("和客服小熊的会话")).toBeNull();
  expect(view.getByRole("button", { name: "加载更早的会话" })).toBeTruthy();
  // Filtering by employee must not walk the whole history by itself: no observer is armed.
  act(() => {
    for (const observer of ScrollObserver.active) observer.intersect();
  });
  expect(requests).toEqual([]);
});

test("Team Bots an administrator assigned to this person stay visible with 更多 folded", async () => {
  const view = renderSidebar("/", undefined, {
    agents: [
      {
        id: "bot-legal",
        name: "法务助手",
        assignedToMe: true,
        hidden: false,
        pinned: false,
      },
    ],
  });
  const more = await view.findByRole("button", { name: "更多" });
  expect(more.getAttribute("aria-expanded")).toBe("false");
  // On the employee roster, which is never folded; with no conversation yet it starts one.
  const roster = view.getByRole("list", { name: "员工" });
  const link = within(roster).getByRole("link", { name: /法务助手/ });
  expect(link.getAttribute("href")).toBe("/channel/new?agent=bot-legal");
});

test("on a page that lives under 更多, the section opens and marks it current", async () => {
  const view = renderSidebar("/approvals");
  const more = await view.findByRole("button", { name: "更多" });
  expect(more.getAttribute("aria-expanded")).toBe("true");
  const region = view.getByRole("navigation", { name: "更多入口" });
  expect(
    region.querySelector('[aria-current="page"]')?.textContent?.trim(),
  ).toBe("审批");
});
