import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  type AnyRoute,
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
import { Channel } from "@/components/app-sidebar/channel";
import {
  GroupSettingsButton,
  GroupSettingsPanel,
} from "@/components/channels/group-settings";
import { SidebarProvider } from "@/components/ui/sidebar";
import { Route as GroupRoute } from "@/routes/_authed/_app/group/$channelId";
import { settleReactWork } from "./settle-react-work";

/**
 * THE GROUP'S SETTINGS, FROM THE CHAT'S OWN TOP BAR.
 *
 * Everything above `fetch` is real: the drawer, the panel, the group route with its address
 * parameter, the composer's `@` menu and the sidebar row's menu. `fetch` is a small server that
 * records every write that left the browser.
 */

const NativeResponse = globalThis.Response;
let originalFetch: typeof fetch;
let originalRect: typeof Range.prototype.getBoundingClientRect;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  const caret = { x: 8, y: 8, top: 8, left: 8, width: 1, height: 16 };
  originalRect = Range.prototype.getBoundingClientRect;
  Range.prototype.getBoundingClientRect = () =>
    ({ ...caret, right: 9, bottom: 24, toJSON: () => caret }) as DOMRect;
  originalFetch = globalThis.fetch;
});

afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  Range.prototype.getBoundingClientRect = originalRect;
  GlobalRegistrator.unregister();
});

const agent = (id: string, name: string) => ({
  id,
  name,
  title: "后端开发",
  roleDescription: "Role",
  avatarSeed: id,
  visibility: "private",
  endpoint: null,
  builtIn: true,
  hasAuth: false,
  modelRef: null,
  persona: null,
  hasCallbackToken: false,
  hidden: false,
  pinned: false,
  systemOwned: false,
  canManage: true,
  mine: true,
  isolated: false,
  isolationActive: false,
  isolationOffReason: null,
});
const ROSTER = ["a", "b", "c", "d"].map((id) =>
  agent(`agent-${id}`, `员工${id}`),
);

const crew = (patch: Record<string, unknown> = {}) => ({
  id: "g-1",
  name: "周报群",
  description: "每周写周报",
  members: [
    { agentId: "agent-a", position: 0 },
    { agentId: "agent-b", position: 1 },
    { agentId: "agent-c", position: 2 },
  ],
  channelId: "ch-1",
  chatStatus: "chat",
  ...patch,
});

type World = {
  /** What `POST /api/waker-groups/for-channel/ch-1` answers. */
  forChannel: { status: number; body: Record<string, unknown> };
  crews: Record<string, unknown>[];
  templates: Record<string, unknown>[];
  /** What `PUT …/members` answers; defaults to echoing the roster. */
  putMembers?: { status: number; body: Record<string, unknown> };
  /** How long the templates read takes, for the count that is still loading. */
  templatesDelay?: Promise<void>;
};
let world: World;
let sent: { method: string; path: string; body: unknown }[] = [];

function reset(patch: Partial<World> = {}) {
  sent = [];
  world = {
    forChannel: { status: 200, body: { group: crew() } },
    crews: [crew()],
    templates: [
      {
        id: "t-1",
        groupId: "g-1",
        name: "周报",
        createdAt: "2026-11-01T00:00:00Z",
        steps: [
          { id: "s1", agentId: "agent-a", instruction: "收集" },
          { id: "s2", agentId: "agent-b", instruction: "汇总" },
        ],
      },
    ],
    ...patch,
  };
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
      "http://localhost",
    );
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (method !== "GET")
      sent.push({ method, path: url.pathname + url.search, body });
    const path = url.pathname;
    if (path === "/api/me")
      return NativeResponse.json({
        user: { id: "me", role: "user", email: "me@example.test" },
      });
    if (path === "/api/agents") return NativeResponse.json({ agents: ROSTER });
    if (path === "/api/waker-groups" && method === "GET")
      return NativeResponse.json({ groups: world.crews });
    if (path === "/api/waker-groups/for-channel/ch-1")
      return NativeResponse.json(world.forChannel.body, {
        status: world.forChannel.status,
      });
    if (path === "/api/waker-groups/g-1/members" && method === "PUT") {
      if (world.putMembers)
        return NativeResponse.json(world.putMembers.body, {
          status: world.putMembers.status,
        });
      const ids = (body as { agentIds: string[] }).agentIds;
      return NativeResponse.json({
        group: crew({
          members: ids.map((agentId, position) => ({ agentId, position })),
        }),
      });
    }
    if (path === "/api/waker-groups/g-1" && method === "PATCH")
      return NativeResponse.json({
        group: crew({ ...(body as Record<string, unknown>) }),
      });
    if (path === "/api/waker-groups/g-1" && method === "DELETE")
      return NativeResponse.json({ ok: true });
    if (path === "/api/group-pipelines/templates") {
      await world.templatesDelay;
      const only = url.searchParams.get("groupId");
      return NativeResponse.json({
        templates: world.templates.filter((t) => !only || t.groupId === only),
      });
    }
    if (path === "/api/channels/ch-1")
      return NativeResponse.json({
        channel: {
          id: "ch-1",
          name: "周报群",
          agentIds: ["agent-a", "agent-b", "agent-c"],
          threadId: "th",
          active: true,
          lastMessageAt: null,
        },
      });
    if (path === "/api/groups/ch-1")
      return NativeResponse.json({
        bots: ROSTER.slice(0, 3).map(({ id, name }) => ({ id, name })),
        people: [
          { userId: "me", email: "me@example.test", name: null, creator: true },
        ],
        messages: [],
      });
    if (path === "/api/groups/ch-1/members/me" && method === "DELETE")
      return NativeResponse.json({ ok: true });
    return NativeResponse.json({ error: "Not here." }, { status: 404 });
  }) as typeof fetch;
}

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

/** The routes the settings panel links to or leaves for. */
function stubs(root: AnyRoute) {
  const stub = (path: string) =>
    createRoute({
      getParentRoute: () => root,
      path,
      component: () => <p>stub {path}</p>,
    } as never);
  return [stub("/"), stub("/pipelines"), stub("/tasks")] as never[];
}

function client() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
}

/** The drawer on its own, held open by the test. */
function drawer(open = true) {
  const root = createRootRoute({
    component: () => (
      <GroupSettingsButton
        channelId="ch-1"
        onOpenChange={() => {}}
        open={open}
      />
    ),
  });
  const router = createRouter({
    routeTree: root.addChildren(stubs(root)),
    history: createMemoryHistory({ initialEntries: ["/x"] }),
  });
  const view = render(
    <QueryClientProvider client={client()}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, router };
}

/** The panel's own root, so a drawer's close button does not count as one of its buttons. */
const panelOf = async (view: ReturnType<typeof render>) =>
  within(
    await waitFor(() => {
      const found = view.baseElement.querySelector(
        '[data-slot="group-settings-panel"]',
      );
      if (!found) throw new Error("no panel yet");
      return found as HTMLElement;
    }),
  );

const hrefOf = (panel: ReturnType<typeof within>, name: string) =>
  panel.getByRole("link", { name }).getAttribute("href");

test("the creator sees every section, and saving sends the new order", async () => {
  reset();
  const { view } = drawer();
  const panel = await panelOf(view);
  for (const heading of [
    "名称与用途",
    "员工与顺序",
    "头像",
    "组团流程",
    "危险区",
  ])
    expect(await panel.findByText(heading)).toBeTruthy();
  expect(await panel.findByText("周报群")).toBeTruthy();
  expect(await panel.findByText("周报")).toBeTruthy();
  expect(hrefOf(panel, "管理流程")).toBe("/pipelines?group=g-1");
  expect(hrefOf(panel, "在看板上看")).toBe(
    "/tasks?crew=agent-a%2Cagent-b%2Cagent-c",
  );

  fireEvent.click(await panel.findByRole("button", { name: "上移 员工b" }));
  fireEvent.click(panel.getByRole("button", { name: "保存员工与顺序" }));
  await waitFor(() =>
    expect(sent).toContainEqual({
      method: "PUT",
      path: "/api/waker-groups/g-1/members",
      body: { agentIds: ["agent-b", "agent-a", "agent-c"] },
    }),
  );
});

test("renaming the group sends the new name", async () => {
  reset();
  const { view } = drawer();
  const panel = await panelOf(view);
  fireEvent.click(await panel.findByRole("button", { name: "修改名称与用途" }));
  const name = panel.getByRole("textbox", { name: "群组名称" });
  await userEvent.setup({ document }).clear(name);
  await userEvent.setup({ document }).type(name, "新周报群");
  fireEvent.click(panel.getByRole("button", { name: "保存名称与用途" }));
  await waitFor(() =>
    expect(sent).toContainEqual({
      method: "PATCH",
      path: "/api/waker-groups/g-1",
      body: { name: "新周报群" },
    }),
  );
});

test("fewer than two or more than twenty cannot be saved", async () => {
  reset();
  const { view } = drawer();
  const panel = await panelOf(view);
  fireEvent.click(await panel.findByRole("button", { name: "移除 员工b" }));
  fireEvent.click(panel.getByRole("button", { name: "移除 员工c" }));
  expect(panel.getByText("一个群组要有 2 到 20 位员工。")).toBeTruthy();
  expect(
    (
      panel.getByRole("button", {
        name: "保存员工与顺序",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});

test("more than twenty cannot be saved either", async () => {
  const many = Array.from({ length: 21 }, (_, i) => ({
    agentId: `agent-${i}`,
    position: i,
  }));
  reset({
    forChannel: { status: 200, body: { group: crew({ members: many }) } },
  });
  const { view } = drawer();
  const panel = await panelOf(view);
  expect(await panel.findByText("一个群组要有 2 到 20 位员工。")).toBeTruthy();
  fireEvent.click(await panel.findByRole("button", { name: "移除 agent-20" }));
  await waitFor(() =>
    expect(
      (
        panel.getByRole("button", {
          name: "保存员工与顺序",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
});

test("removing a step owner warns but does not block", async () => {
  reset();
  const { view } = drawer();
  const panel = await panelOf(view);
  fireEvent.click(await panel.findByRole("button", { name: "移除 员工b" }));
  expect(
    await panel.findByText(/这位员工负责流程「周报」的第 2 步/),
  ).toBeTruthy();
  const save = panel.getByRole("button", {
    name: "保存员工与顺序",
  }) as HTMLButtonElement;
  expect(save.disabled).toBe(false);
  fireEvent.click(save);
  await waitFor(() =>
    expect(sent).toContainEqual({
      method: "PUT",
      path: "/api/waker-groups/g-1/members",
      body: { agentIds: ["agent-a", "agent-c"] },
    }),
  );
});

test("only coworkers the person can use are offered to add", async () => {
  reset();
  const { view } = drawer();
  const panel = await panelOf(view);
  fireEvent.click(await panel.findByRole("button", { name: "添加员工" }));
  fireEvent.click(await panel.findByRole("button", { name: "添加 员工d" }));
  fireEvent.click(panel.getByRole("button", { name: "保存员工与顺序" }));
  await waitFor(() =>
    expect(sent).toContainEqual({
      method: "PUT",
      path: "/api/waker-groups/g-1/members",
      body: { agentIds: ["agent-a", "agent-b", "agent-c", "agent-d"] },
    }),
  );
});

test("a 409 from saving shows the server's words", async () => {
  reset({
    putMembers: {
      status: 409,
      body: { error: "有组团流程正在运行，先停下再改员工。" },
    },
  });
  const { view } = drawer();
  const panel = await panelOf(view);
  fireEvent.click(await panel.findByRole("button", { name: "上移 员工b" }));
  fireEvent.click(panel.getByRole("button", { name: "保存员工与顺序" }));
  expect((await panel.findByRole("alert")).textContent).toContain(
    "有组团流程正在运行，先停下再改员工。",
  );
});

test("a saved roster whose chat did not start says why", async () => {
  reset({
    putMembers: {
      status: 200,
      body: {
        group: crew(),
        chatError: "聊天没能开始，请稍后再试。",
      },
    },
  });
  const { view } = drawer();
  const panel = await panelOf(view);
  fireEvent.click(await panel.findByRole("button", { name: "上移 员工b" }));
  fireEvent.click(panel.getByRole("button", { name: "保存员工与顺序" }));
  expect((await panel.findByRole("alert")).textContent).toContain(
    "聊天没能开始，请稍后再试。",
  );
});

test("a member sees the roster read-only", async () => {
  reset({
    forChannel: { status: 403, body: { error: "Only the creator." } },
  });
  const { view } = drawer();
  const panel = await panelOf(view);
  expect(await panel.findByText("只有发起人能调整")).toBeTruthy();
  expect(await panel.findByText("员工a")).toBeTruthy();
  expect(panel.getByText("员工b")).toBeTruthy();
  expect(panel.queryAllByRole("button")).toHaveLength(0);
  expect(panel.queryAllByRole("link")).toHaveLength(0);
});

test("an owner-gone 409 is read-only and says what the server said", async () => {
  reset({
    forChannel: {
      status: 409,
      body: {
        error: "这个群组的发起人已经不在聊天里了。",
        code: "waker-group-owner-gone",
      },
    },
  });
  const { view } = drawer();
  const panel = await panelOf(view);
  expect(
    await panel.findByText("这个群组的发起人已经不在聊天里了。"),
  ).toBeTruthy();
  expect(await panel.findByText("员工a")).toBeTruthy();
  expect(panel.queryAllByRole("button")).toHaveLength(0);
});

test("dissolving says what goes with it, and leaves for the home page", async () => {
  reset();
  const { view, router } = drawer();
  const panel = await panelOf(view);
  fireEvent.click(await panel.findByRole("button", { name: "解散群组" }));
  // The count is read first: nothing to confirm until it is known.
  expect(
    (
      await within(document.body).findByText(
        /解散「周报群」：聊天记录不再显示；它的 1 条组团流程和运行记录会一并删除；看板上已有的任务卡保留。/,
      )
    ).textContent,
  ).toBeTruthy();
  fireEvent.click(
    await within(document.body).findByRole("button", {
      name: "确认解散「周报群」",
    }),
  );
  await waitFor(() =>
    expect(sent).toContainEqual({
      method: "DELETE",
      path: "/api/waker-groups/g-1",
      body: undefined,
    }),
  );
  await waitFor(() => expect(router.state.location.pathname).toBe("/"));
});

test("dissolving waits for the count while it is loading", async () => {
  let release = () => {};
  reset({ templatesDelay: new Promise<void>((done) => (release = done)) });
  const { view } = drawer();
  const panel = await panelOf(view);
  // The panel's own flows read is the same URL, held open too: use the cache the dialog shares.
  fireEvent.click(await panel.findByRole("button", { name: "解散群组" }));
  expect(await within(document.body).findByText("正在统计…")).toBeTruthy();
  expect(
    (
      within(document.body).getByRole("button", {
        name: "确认解散「周报群」",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  release();
  await within(document.body).findByText(/它的 1 条组团流程/);
});

test("?settings=1 opens the drawer, closing it clears the parameter", async () => {
  reset();
  const root = createRootRoute({
    component: () => (
      <SidebarProvider>
        <Outlet />
      </SidebarProvider>
    ),
  });
  const group = createRoute({
    path: "group/$channelId",
    getParentRoute: () => root,
    component: GroupRoute.options.component,
    validateSearch: GroupRoute.options.validateSearch,
  } as never);
  const router = createRouter({
    routeTree: root.addChildren([group, ...stubs(root)]),
    history: createMemoryHistory({
      initialEntries: ["/group/ch-1?settings=1"],
    }),
  });
  const view = render(
    <QueryClientProvider client={client()}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  const panel = await panelOf(view);
  expect(await panel.findByText("员工与顺序")).toBeTruthy();
  fireEvent.keyDown(document.body, { key: "Escape" });
  await waitFor(() =>
    expect(
      document.querySelector('[data-slot="group-settings-panel"]'),
    ).toBeNull(),
  );
  expect(router.state.location.search).toEqual({});
  // And the bar's button opens it again, writing the parameter back.
  fireEvent.click(await view.findByRole("button", { name: "群组设置" }));
  await panelOf(view);
  expect(router.state.location.search).toEqual({ settings: 1 });
});

test("the top bar names the group and falls back to 群组", async () => {
  reset();
  const root = createRootRoute({
    component: () => (
      <SidebarProvider>
        <Outlet />
      </SidebarProvider>
    ),
  });
  const group = createRoute({
    path: "group/$channelId",
    getParentRoute: () => root,
    component: GroupRoute.options.component,
    validateSearch: GroupRoute.options.validateSearch,
  } as never);
  const router = createRouter({
    routeTree: root.addChildren([group, ...stubs(root)]),
    history: createMemoryHistory({ initialEntries: ["/group/nope"] }),
  });
  const view = render(
    <QueryClientProvider client={client()}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  const header = await waitFor(() => {
    const found = view.container.querySelector(
      '[data-slot="conversation-header"]',
    );
    if (!found) throw new Error("no header");
    return found;
  });
  expect(header.textContent).toContain("群组");
  expect(header.textContent).not.toContain("群聊");
});

test("@ lists the current crew's flows first", async () => {
  reset({
    crews: [
      crew({ id: "g-2", name: "排在前面的别组", channelId: "ch-9" }),
      crew(),
    ],
    templates: [
      {
        id: "t-other",
        groupId: "g-2",
        name: "别的流程",
        createdAt: "2026-11-01T00:00:00Z",
        steps: [{ id: "s1", agentId: "agent-a", instruction: "x" }],
      },
      {
        id: "t-mine",
        groupId: "g-1",
        name: "周报",
        createdAt: "2026-11-02T00:00:00Z",
        steps: [{ id: "s1", agentId: "agent-a", instruction: "x" }],
      },
    ],
  });
  const { GroupChat } = await import("@/components/channels/group-chat");
  const root = createRootRoute({
    component: () => <GroupChat channelId="ch-1" />,
  });
  const router = createRouter({
    routeTree: root.addChildren(stubs(root)),
    history: createMemoryHistory({ initialEntries: ["/x"] }),
  });
  const view = render(
    <QueryClientProvider client={client()}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  const editor = await view.findByRole("textbox", {
    hidden: true,
    name: "消息",
  });
  const user = userEvent.setup({ document });
  await user.click(editor);
  await waitFor(async () => {
    await user.keyboard("@");
    const menu = view.getByRole("listbox", {
      hidden: true,
      name: "@ suggestions",
    });
    const flows = [...menu.querySelectorAll('[role="option"]')]
      .map((option) => option.textContent ?? "")
      .filter((text) => text.includes("启动流程"));
    expect(flows).toHaveLength(2);
    expect(flows[0]).toContain("周报群");
    expect(flows[1]).toContain("排在前面的别组");
  });
});

function row(props: {
  groupId?: string;
  canRename: boolean;
  people: string[];
}) {
  reset();
  const root = createRootRoute({
    component: () => (
      <SidebarProvider>
        <Channel
          canRename={props.canRename}
          channelId="ch-1"
          busy={false}
          emphasis="agent"
          groupId={props.groupId}
          name="周报群"
          participantIds={props.people}
          pinned={false}
          unread={false}
        />
      </SidebarProvider>
    ),
  });
  const group = createRoute({
    path: "group/$channelId",
    getParentRoute: () => root,
    component: () => <p>group</p>,
  } as never);
  const channel = createRoute({
    path: "channel/$channelId",
    getParentRoute: () => root,
    component: () => <p>channel</p>,
  } as never);
  const router = createRouter({
    routeTree: root.addChildren([group, channel, ...stubs(root)]),
    history: createMemoryHistory({ initialEntries: ["/x"] }),
  });
  return render(
    <QueryClientProvider client={client()}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

async function menuOf(view: ReturnType<typeof render>) {
  fireEvent.contextMenu(await view.findByRole("link"));
  await within(document.body).findByRole("menuitem", { name: /置顶会话/ });
  return within(document.body);
}

test("a linked chat's row menu offers 解散群组 to its creator and 退出群组 to others", async () => {
  const mine = row({
    groupId: "g-1",
    canRename: true,
    people: ["agent-a", "agent-b"],
  });
  let menu = await menuOf(mine);
  expect(menu.getByRole("menuitem", { name: /解散群组…/ })).toBeTruthy();
  expect(menu.queryByRole("menuitem", { name: /退出群组…/ })).toBeNull();
  expect(menu.queryByRole("menuitem", { name: /删除会话…/ })).toBeNull();
  fireEvent.click(menu.getByRole("menuitem", { name: /解散群组…/ }));
  // The same confirmation, in the same words, as the settings drawer's.
  expect(
    await within(document.body).findByText(
      /解散「周报群」：聊天记录不再显示；它的 1 条组团流程和运行记录会一并删除；看板上已有的任务卡保留。/,
    ),
  ).toBeTruthy();
  fireEvent.click(
    await within(document.body).findByRole("button", {
      name: "确认解散「周报群」",
    }),
  );
  await waitFor(() =>
    expect(sent).toContainEqual({
      method: "DELETE",
      path: "/api/waker-groups/g-1",
      body: undefined,
    }),
  );
  cleanup();

  const theirs = row({ canRename: false, people: ["agent-a", "agent-b"] });
  menu = await menuOf(theirs);
  expect(menu.queryByRole("menuitem", { name: /解散群组…/ })).toBeNull();
  expect(menu.queryByRole("menuitem", { name: /删除会话…/ })).toBeNull();
  fireEvent.click(menu.getByRole("menuitem", { name: /退出群组…/ }));
  fireEvent.click(
    await within(document.body).findByRole("button", { name: "确认退出" }),
  );
  await waitFor(() =>
    expect(sent).toContainEqual({
      method: "DELETE",
      path: "/api/groups/ch-1/members/me",
      body: undefined,
    }),
  );
  cleanup();

  const single = row({ canRename: true, people: ["agent-a"] });
  menu = await menuOf(single);
  expect(menu.getByRole("menuitem", { name: /删除会话…/ })).toBeTruthy();
  expect(menu.queryByRole("menuitem", { name: /退出群组…/ })).toBeNull();
  expect(menu.queryByRole("menuitem", { name: /解散群组…/ })).toBeNull();
});

test("the panel can be drawn on its own", async () => {
  reset();
  const root = createRootRoute({
    component: () => <GroupSettingsPanel channelId="ch-1" />,
  });
  const router = createRouter({
    routeTree: root.addChildren(stubs(root)),
    history: createMemoryHistory({ initialEntries: ["/x"] }),
  });
  const view = render(
    <QueryClientProvider client={client()}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  expect(await view.findByText("员工与顺序")).toBeTruthy();
});
