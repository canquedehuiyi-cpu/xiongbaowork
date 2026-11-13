/*
 * 手机宽度下侧栏是盖在页面上的一层：「会话 · 员工 · 群组」的切换、「新建群组」和名册里的行都在这层里能用，
 * 切换不关这层，点进一位员工或一段群聊就关上并打开那一页。
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
import { portraitKeys } from "@/lib/portraits/queries";
import { userPreferencesQueryOptions } from "@/lib/settings/message-list";
import { wakerGroupKeys } from "@/lib/waker-groups/queries";
import { settleReactWork } from "./settle-react-work";

class OfflineWebSocket extends EventTarget {
  readyState = 0;
  close() {}
  send() {}
}

const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;
const clients: QueryClient[] = [];

beforeAll(() => {
  // A phone held upright.
  GlobalRegistrator.register({
    url: "http://localhost/",
    width: 390,
    height: 844,
  });
  globalThis.WebSocket = OfflineWebSocket as unknown as typeof WebSocket;
});
beforeEach(() => {
  window.localStorage.clear();
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

function conversation(id: string, agentIds: string[]): ChannelSummary {
  return {
    id,
    name: id,
    agentIds,
    threadId: id,
    active: true,
    lastMessageAt: "2026-11-08T14:00:00Z",
    summary: id,
    lastMessage: null,
    lastMessageAgentId: null,
    createdAt: "2026-11-08T13:00:00Z",
    pinned: false,
    lastReadAt: "2026-11-08T14:00:00Z",
  };
}

function renderPhone() {
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
    name: "Dana",
    email: "dana@example.com",
    role: "user",
    onboarding: null,
  });
  queryClient.setQueryData(userPreferencesQueryOptions("dana").queryKey, {
    messageListEmphasis: "thread",
    selfHostBannerDismissed: true,
    narration: null,
    skin: "openbot",
    proactive: "on",
  });
  queryClient.setQueryData(agentKeys.list(false), [
    {
      id: "analyst",
      name: "分析师",
      title: "数据",
      roleDescription: "",
      avatarSeed: "analyst",
      hidden: false,
      pinned: false,
      mine: true,
    },
    {
      id: "writer",
      name: "写手",
      title: "文案",
      roleDescription: "",
      avatarSeed: "writer",
      hidden: false,
      pinned: false,
      mine: true,
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
  queryClient.setQueryData(browserKeys.state, {
    available: false,
    computerId: "",
    open: false,
    tabs: [],
  });
  queryClient.setQueryData(portraitKeys.all, []);
  queryClient.setQueryData(wakerGroupKeys.list(), []);
  queryClient.setQueryData(channelKeys.list(), {
    pages: [
      {
        channels: [
          conversation("solo", ["analyst"]),
          conversation("crew", ["analyst", "writer"]),
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
          <SidebarToggle />
        </SidebarProvider>
      ),
    }),
    history: createMemoryHistory({ initialEntries: ["/bots"] }),
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
    async openSheet() {
      await user.click(await view.findByRole("button", { name: "显示侧栏" }));
      return view.findByRole("dialog", { name: "侧栏" });
    },
    async sheetCloses() {
      await waitFor(() =>
        expect(
          view.queryByRole("dialog", { name: "侧栏", hidden: true }),
        ).toBeNull(),
      );
    },
  };
}

test("switching to 员工 keeps the sheet open; an employee closes it and opens its 单聊", async () => {
  const app = renderPhone();
  const sheet = await app.openSheet();
  await app.user.click(within(sheet).getByRole("button", { name: /^员工/ }));
  expect(app.view.getByRole("dialog", { name: "侧栏" })).toBeTruthy();
  const list = await within(sheet).findByRole("list", { name: "员工" });
  await app.user.click(within(list).getByRole("link", { name: /^分析师/ }));
  await app.sheetCloses();
  expect(app.router.state.location.pathname).toBe("/channel/solo");
});

test("a 群组 under 群组 closes the sheet and opens it", async () => {
  const app = renderPhone();
  const sheet = await app.openSheet();
  await app.user.click(within(sheet).getByRole("button", { name: /^群组/ }));
  const chats = await within(sheet).findByRole("list", { name: "群组" });
  expect(within(chats).getAllByRole("link")).toHaveLength(1);
  await app.user.click(within(chats).getByRole("link"));
  await app.sheetCloses();
  expect(app.router.state.location.pathname).toBe("/group/crew");
});

test("「新建群组」 at the top of the sheet closes it and opens the 新建群组 page", async () => {
  const app = renderPhone();
  const sheet = await app.openSheet();
  await app.user.click(within(sheet).getByRole("button", { name: "新建群组" }));
  await app.sheetCloses();
  expect(app.router.state.location.pathname).toBe("/group/new");
});
