/*
 * The workbench shell (docs/plans/2026-11-07-qoderwake-cn-frontend-parity.md, F1): the five primary
 * entries in the reference product's order at the top of the sidebar, conversations split into
 * 员工 and 群组, and every route this product had before still one click away under 更多.
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
import { act, cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppSidebar, channelTab } from "@/components/app-sidebar/app-sidebar";
import { SidebarProvider } from "@/components/ui/sidebar";
import { agentKeys } from "@/lib/agents/queries";
import { authKeys } from "@/lib/auth/queries";
import { botLifecycleKeys } from "@/lib/bot-lifecycle/queries";
import { type ChannelSummary, channelKeys } from "@/lib/channels/queries";
import { userPreferencesQueryOptions } from "@/lib/settings/message-list";

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

test("the primary navigation lists the five workbench entries in the reference order", async () => {
  const view = renderSidebar();
  const nav = await view.findByRole("navigation", { name: "主导航" });
  const links = [...nav.querySelectorAll("a")];
  expect(links.map((link) => link.textContent?.trim())).toEqual([
    "任务看板",
    "@Waker",
    "自主工作",
    "Waker 管理",
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
  expect(current?.textContent?.trim()).toBe("Waker 管理");
});

test("routes outside the five entries stay reachable under 更多", async () => {
  const view = renderSidebar();
  const more = await view.findByRole("button", { name: "更多" });
  expect(more.getAttribute("aria-expanded")).toBe("false");
  await userEvent.click(more);
  expect(more.getAttribute("aria-expanded")).toBe("true");
  const region = view.getByRole("navigation", { name: "更多入口" });
  const hrefs = [...region.querySelectorAll("a")].map(hrefOf);
  for (const href of [
    "/pipelines",
    "/bots",
    "/skills",
    "/agents",
    "/team-bots",
    "/responsibilities",
    "/memory",
    "/knowledge",
    "/approvals",
  ]) {
    expect(hrefs).toContain(href);
  }
});

test("a conversation with two or more coworkers is a group; everything else belongs to 员工", () => {
  expect(channelTab(channel("solo", ["a"]))).toBe("wakers");
  expect(channelTab(channel("empty"))).toBe("wakers");
  expect(channelTab(channel("crew", ["a", "b"]))).toBe("groups");
});

test("the 员工 and 群组 tabs split the conversations and retarget the new-conversation button", async () => {
  const view = renderSidebar("/", [
    channel("和客服小熊的会话", ["a"]),
    channel("周报群组", ["a", "b"]),
  ]);
  expect(await view.findByText("和客服小熊的会话")).toBeTruthy();
  expect(view.queryByText("周报群组")).toBeNull();
  expect(hrefOf(view.getByRole("link", { name: "新建会话" }))).toBe(
    "/channel/new",
  );

  await userEvent.click(view.getByRole("tab", { name: "群组" }));
  expect(await view.findByText("周报群组")).toBeTruthy();
  expect(view.queryByText("和客服小熊的会话")).toBeNull();
  expect(hrefOf(view.getByRole("link", { name: "新建群聊" }))).toBe(
    "/group/new",
  );
});

test("the footer carries the 小管家 entry, settings and the account menu", async () => {
  const view = renderSidebar();
  expect(hrefOf(await view.findByRole("link", { name: "小管家" }))).toBe(
    "/bot",
  );
  expect(hrefOf(view.getByRole("link", { name: "设置" }))).toBe("/settings");
  expect(view.getByRole("button", { name: /user@example\.com/ })).toBeTruthy();
});

test("a 群组 tab with nothing among the loaded pages says so, offers more, and does not page on its own", async () => {
  const view = renderSidebar("/", [channel("和客服小熊的会话", ["a"])], {
    nextCursor: "older/page",
  });
  await view.findByText("和客服小熊的会话");
  await userEvent.click(view.getByRole("tab", { name: "群组" }));
  expect(await view.findByText("已加载的会话里没有群组会话")).toBeTruthy();
  expect(view.queryByText("还没有群组会话")).toBeNull();
  expect(view.getByRole("button", { name: "加载更早的会话" })).toBeTruthy();
  // Filtering by tab must not walk the whole history by itself: no observer is armed.
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
  const link = view.getByRole("link", { name: /法务助手/ });
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
