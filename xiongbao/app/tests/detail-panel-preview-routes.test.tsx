/*
 * 预览面板在两条真路由上的接线：单聊、群聊（默认皮肤的聊天工作台）的 `?preview` 开面板，坏值不崩不开，
 * 预览压过看电脑，自动看电脑不抢预览，群设置抽屉不抹掉 `preview`。页面、路由、地址参数都是真的。
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { CopilotKitProvider as ChatRuntimeProvider } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  type AnyRoute,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, render, waitFor, within } from "@testing-library/react";
import { SidebarProvider } from "@/components/ui/sidebar";
import { authKeys } from "@/lib/auth/queries";
import { type AgentChannel, channelKeys } from "@/lib/channels/queries";
import { encodePreview } from "@/lib/computers/preview";
import { reportComputerActivity } from "@/lib/copilot/computer-activity";
import { deploymentKeys } from "@/lib/deployment/queries";
import { queryClient } from "@/query-client";
import { Route as ChannelRoute } from "@/routes/_authed/_app/channel/$channelId";
import { Route as GroupRoute } from "@/routes/_authed/_app/group/$channelId";
import { setSkin } from "@/skins/store";
import { settleReactWork } from "./settle-react-work";

const originalFetch = globalThis.fetch;
const ui = () => within(document.body);

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
});
beforeEach(() => {
  setSkin("xiongbao");
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost/");
      if (url.pathname === "/api/channels/g-1")
        return Response.json({
          channel: {
            id: "g-1",
            name: "周报群",
            agentIds: ["a1", "a2"],
            threadId: "th",
            active: true,
            lastMessageAt: null,
          },
        });
      if (url.pathname === "/api/groups/g-1")
        return Response.json({
          bots: [],
          people: [
            {
              userId: "me",
              email: "me@example.test",
              name: null,
              creator: true,
            },
          ],
          messages: [],
        });
      if (url.pathname === "/api/waker-groups")
        return Response.json({ groups: [] });
      if (url.pathname.startsWith("/api/waker-groups/for-channel/"))
        return Response.json({ error: "none" }, { status: 404 });
      return Response.json({ error: "not served" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
  queryClient.setQueryData(authKeys.currentUser(), {
    id: "me",
    name: "我",
    email: "me@example.com",
    role: "user",
    onboarding: null,
  });
  queryClient.setQueryData(deploymentKeys.capabilities(), { edition: "team" });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const TARGET = {
  botId: "a1",
  path: "out/报告.pdf",
  scope: { channel: "c-1", run: "r1" },
};
const GOOD = encodePreview(TARGET);
const panel = () => document.querySelector("[data-artifact-preview]");
const dialogs = () => ui().queryByRole("dialog", { name: "预览" });

function mount(
  entry: string,
  place: (parent: AnyRoute) => AnyRoute,
  where: "channel" | "group",
) {
  const root = createRootRoute({
    component: () => (
      <SidebarProvider>
        <Outlet />
      </SidebarProvider>
    ),
  });
  const authed = createRoute({
    id: "_authed",
    getParentRoute: () => root,
    component: Outlet,
  } as never);
  const app = createRoute({
    id: "_app",
    getParentRoute: () => authed,
    component: Outlet,
  } as never);
  const page = place(app);
  const router = createRouter({
    routeTree: root.addChildren([
      authed.addChildren([app.addChildren([page])]) as never,
    ]),
    history: createMemoryHistory({ initialEntries: [entry] }),
  });
  void where;
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ChatRuntimeProvider runtimeUrl="http://localhost/api/runtime">
        <RouterProvider router={router as never} />
      </ChatRuntimeProvider>
    </QueryClientProvider>,
  );
  return { view, router };
}

const chatRoute = (parent: AnyRoute) =>
  createRoute({
    path: "channel/$channelId",
    getParentRoute: () => parent,
    component: ChannelRoute.options.component,
    validateSearch: ChannelRoute.options.validateSearch,
  } as never) as AnyRoute;
const groupRoute = (parent: AnyRoute) =>
  createRoute({
    path: "group/$channelId",
    getParentRoute: () => parent,
    component: GroupRoute.options.component,
    validateSearch: GroupRoute.options.validateSearch,
  } as never) as AnyRoute;

function single(search: string) {
  const chat: AgentChannel = {
    id: "c-1",
    name: "小熊",
    agentIds: ["a1"],
    threadId: "t-c-1",
    active: true,
    lastMessageAt: "2026-11-15T08:00:00.000Z",
  };
  queryClient.setQueryData(channelKeys.detail("c-1"), chat);
  return mount(`/channel/c-1${search}`, chatRoute, "channel");
}

const searchOf = (router: { state: { location: { search: unknown } } }) =>
  router.state.location.search as Record<string, unknown>;

test("single chat: ?preview opens the pane titled 预览", async () => {
  single(`?preview=${GOOD}`);
  await waitFor(() => expect(panel()).not.toBeNull());
  expect(dialogs()).toBeTruthy();
});

test("single chat: ?preview=123, true, empty or garbage neither crashes nor opens", async () => {
  for (const bad of ["123", "true", "null", "", "%20"]) {
    const { view } = single(`?preview=${bad}`);
    // 对话页的壳（顶栏上的会话名）画出来了，没有进错误页。
    await waitFor(() => expect(ui().getByText("小熊")).toBeTruthy());
    expect(panel()).toBeNull();
    expect(ui().queryByRole("dialog", { name: "预览" })).toBeNull();
    view.unmount();
    cleanup();
  }
});

test("single chat: with ?watch and ?preview together, the preview wins", async () => {
  single(`?watch=true&preview=${GOOD}`);
  await waitFor(() => expect(panel()).not.toBeNull());
  expect(dialogs()).toBeTruthy();
  expect(ui().queryByRole("region", { name: "电脑侧栏" })).toBeNull();
});

test("single chat: browser activity does not take the pane from an open preview", async () => {
  const { router } = single(`?preview=${GOOD}`);
  await waitFor(() => expect(panel()).not.toBeNull());
  await act(async () => {
    reportComputerActivity("a1");
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(searchOf(router).watch).toBeUndefined();
  expect(searchOf(router).preview).toBe(GOOD);
  expect(panel()).not.toBeNull();
});

test("group: ?preview opens the pane; a bad value does not; settings keeps it", async () => {
  const { view, router } = mount(
    `/group/g-1?preview=${GOOD}`,
    groupRoute,
    "group",
  );
  await waitFor(() => expect(panel()).not.toBeNull());
  expect(dialogs()).toBeTruthy();
  // 群设置抽屉开着再关上，不抹掉 preview。
  await act(async () => {
    (
      await view.findByRole("button", { name: "群组设置", hidden: true })
    ).click();
  });
  await waitFor(() => expect(searchOf(router).settings).toBe(1));
  expect(searchOf(router).preview).toBe(GOOD);
  cleanup();

  mount("/group/g-1?preview=123", groupRoute, "group");
  await waitFor(() => expect(ui().getByText("周报群")).toBeTruthy());
  expect(panel()).toBeNull();
});

test("single chat: the pane's close button closes the preview and clears ?preview; only one close button", async () => {
  const { router } = single(`?preview=${GOOD}`);
  await waitFor(() => expect(panel()).not.toBeNull());
  expect(
    ui()
      .getAllByRole("button", { name: /^关闭/ })
      .filter((button) =>
        button.closest("[role=dialog], [data-slot=detail-pane]"),
      ),
  ).toHaveLength(1);
  await act(async () => {
    ui().getByRole("button", { name: /^关闭/ }).click();
  });
  await waitFor(() => expect(searchOf(router).preview).toBeUndefined());
  await waitFor(() => expect(panel()).toBeNull());
});

test("group: the pane's close button closes the preview and clears ?preview", async () => {
  const { router } = mount(`/group/g-1?preview=${GOOD}`, groupRoute, "group");
  await waitFor(() => expect(panel()).not.toBeNull());
  await act(async () => {
    ui().getByRole("button", { name: /^关闭/ }).click();
  });
  await waitFor(() => expect(searchOf(router).preview).toBeUndefined());
  await waitFor(() => expect(panel()).toBeNull());
});
