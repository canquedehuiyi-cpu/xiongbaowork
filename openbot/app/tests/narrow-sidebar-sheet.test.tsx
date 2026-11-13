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
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppSidebar } from "@/components/app-sidebar/app-sidebar";
import { SidebarToggle } from "@/components/layout/sidebar-toggle";
import { SidebarProvider } from "@/components/ui/sidebar";
import { agentKeys } from "@/lib/agents/queries";
import { authKeys } from "@/lib/auth/queries";
import { botLifecycleKeys } from "@/lib/bot-lifecycle/queries";
import { browserKeys } from "@/lib/browser/queries";
import { type ChannelSummary, channelKeys } from "@/lib/channels/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { userPreferencesQueryOptions } from "@/lib/settings/message-list";
import { settleReactWork } from "./settle-react-work";

/*
 * In a narrow window (under 768px) the sidebar is a sheet over the page. Picking a conversation in
 * it opened that conversation behind the sheet, and the sheet stayed open until the person clicked
 * outside it, so it looked as if nothing had happened. Every way out of the sheet to a page closes
 * it; typing in its search box and opening its menus does not.
 *
 * 熊宝：侧栏已按上游的结构（对话列表、底部主导航、更多、账户菜单）；个人版和账户菜单里的
 * OpenBot for Business 有意不收，所以这里用团队版，测熊宝主导航和「更多」里的入口。
 */

class OfflineWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = 0;
  onclose = null;
  onerror = null;
  onmessage = null;
  onopen = null;
  close() {}
  send() {}
}

const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;
const clients: QueryClient[] = [];

beforeAll(() => {
  // The width of the Windows window this was found in.
  GlobalRegistrator.register({
    url: "http://localhost/",
    width: 520,
    height: 840,
  });
  globalThis.WebSocket = OfflineWebSocket as unknown as typeof WebSocket;
});
beforeEach(() => {
  globalThis.fetch = Object.assign(
    async () => Response.json({ error: "not served" }, { status: 404 }),
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  cleanup();
  for (const client of clients) client.clear();
  clients.length = 0;
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  globalThis.WebSocket = originalWebSocket;
  GlobalRegistrator.unregister();
});

function conversation(
  id: string,
  summary: string,
  lastMessageAt = "2026-11-08T14:00:00Z",
): ChannelSummary {
  return {
    id,
    name: "Personal Assistant",
    agentIds: ["assistant"],
    threadId: id,
    active: true,
    lastMessageAt,
    summary,
    lastMessage: null,
    lastMessageAgentId: null,
    createdAt: "2026-11-08T13:00:00Z",
    pinned: false,
    lastReadAt: "2026-11-08T14:00:00Z",
  };
}

function renderNarrowApp(start = "/channel/models") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  clients.push(queryClient);
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: false,
    edition: "team",
  });
  queryClient.setQueryData(authKeys.currentUser(), {
    id: "dana",
    name: "Dana Fresh",
    email: "dana@example.com",
    role: "admin",
    onboarding: null,
  });
  queryClient.setQueryData(userPreferencesQueryOptions("dana").queryKey, {
    messageListEmphasis: "thread",
    selfHostBannerDismissed: true,
    narration: null,
    skin: "xiongbao",
    proactive: "on",
  });
  queryClient.setQueryData(agentKeys.list(false), [
    {
      id: "assistant",
      name: "Personal Assistant",
      title: "",
      roleDescription: "",
      avatarSeed: "assistant",
      visibility: "public",
      endpoint: null,
      builtIn: true,
      hasAuth: false,
    },
  ]);
  queryClient.setQueryDefaults(botLifecycleKeys.attention, {
    staleTime: Number.POSITIVE_INFINITY,
    refetchInterval: false,
  });
  queryClient.setQueryData(botLifecycleKeys.attention, {
    bots: [],
    lastPingId: null,
  });
  // OpenBot can run a browser here, so 教员工做事 is in the sidebar, after the main destinations.
  queryClient.setQueryDefaults(browserKeys.state, { refetchInterval: false });
  queryClient.setQueryData(browserKeys.state, {
    available: true,
    computerId: "",
    open: false,
    tabs: [],
  });
  queryClient.setQueryData(channelKeys.list(), {
    pages: [
      {
        channels: [
          conversation("models", "AI Model and Agent Framework"),
          conversation("hn", "Hacker News Top Stories", "2026-11-08T15:00:00Z"),
        ],
        nextCursor: null,
      },
    ],
    pageParams: [""],
  });
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <SidebarProvider>
          <AppSidebar />
          {/* The page's own Show sidebar button, which is how a narrow window opens the sheet. */}
          <SidebarToggle />
        </SidebarProvider>
      ),
    }),
    history: createMemoryHistory({ initialEntries: [start] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  const user = userEvent.setup({ document });
  return {
    view,
    user,
    router,
    /** Opens the sheet as a person does, and answers with it. */
    async openSheet() {
      await user.click(await view.findByRole("button", { name: "显示侧栏" }));
      return view.findByRole("dialog", { name: "侧栏" });
    },
    async sheetCloses() {
      // `hidden`, because a dialog opened over the sheet hides it from the accessibility tree
      // without closing it.
      await waitFor(() =>
        expect(
          view.queryByRole("dialog", { name: "侧栏", hidden: true }),
        ).toBeNull(),
      );
    },
  };
}

test.each([
  ["a conversation", "link", /Hacker News Top Stories/, "/channel/hn"],
  [
    "the conversation already open",
    "link",
    /AI Model and Agent Framework/,
    "/channel/models",
  ],
  ["员工", "link", /^员工/, "/bots"],
  ["任务看板", "link", /^任务看板/, "/tasks"],
  ["连接", "link", /^连接/, "/connections"],
  ["教员工做事", "link", /^教员工做事/, "/browser"],
  // A link drawn as a button: it still goes somewhere.
  ["新对话", "button", /^新对话$/, "/channel/new"],
] as const)(
  "picking %s in the narrow sheet closes it and opens the page",
  async (_label, role, name, path) => {
    const app = renderNarrowApp();
    const sheet = await app.openSheet();
    await app.user.click(await within(sheet).findByRole(role, { name }));
    await app.sheetCloses();
    expect(app.router.state.location.pathname).toBe(path);
  },
);

test("opening 更多 keeps the sheet open, and 组团流程 under it closes the sheet and opens the page", async () => {
  const app = renderNarrowApp();
  const sheet = await app.openSheet();
  await app.user.click(within(sheet).getByRole("button", { name: /^更多/ }));
  expect(app.view.getByRole("dialog", { name: "侧栏" })).toBeTruthy();
  await app.user.click(
    await within(sheet).findByRole("link", { name: /^组团流程/ }),
  );
  await app.sheetCloses();
  expect(app.router.state.location.pathname).toBe("/pipelines");
});

test("设置 in the account menu closes the sheet and opens Settings", async () => {
  const app = renderNarrowApp();
  const sheet = await app.openSheet();
  await app.user.click(
    within(sheet).getByRole("button", { name: /Dana Fresh/ }),
  );
  // The menu opens over the sheet; opening it leaves the sheet where it is.
  const menu = await app.view.findByRole("menu");
  expect(app.view.getByRole("dialog", { name: "侧栏" })).toBeTruthy();
  await app.user.click(within(menu).getByRole("menuitem", { name: "设置" }));
  await app.sheetCloses();
  expect(app.router.state.location.pathname).toBe("/settings");
});

test("searching the sheet keeps it open", async () => {
  const app = renderNarrowApp();
  const sheet = await app.openSheet();
  await app.user.type(
    within(sheet).getByRole("searchbox", { name: "搜索会话" }),
    "hacker",
  );
  expect(app.view.getByRole("dialog", { name: "侧栏" })).toBeTruthy();
  expect(
    within(sheet).getByRole("searchbox", { name: "搜索会话" }),
  ).toHaveProperty("value", "hacker");
  expect(app.router.state.location.pathname).toBe("/channel/models");
});
