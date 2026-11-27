/*
 * 外部员工招进来以后（外部员工 Task 11）：通讯录卡片、员工名片、对话顶栏上的「外部员工 · Codex」标记；名片上
 * 在哪台电脑、本机智能体「不会请求许可」的警示，「配置」去招聘设置的编辑态；顶栏副标题「状态 · 此刻 · 在
 * <电脑名> 上」和「看它的屏幕」；消息列表顶上的离线提示条；例行任务、长期职责这些入口对它不显示。
 *
 * 页面、路由、查询都是真的，接口由下面的假 fetch 按产品接口的形状回答。
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { CopilotKitProvider as ChatRuntimeProvider } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
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
import type { ReactNode } from "react";
import { AgentDialog } from "@/components/agents/agent-dialog";
import { HireSettings } from "@/components/agents/external/hire-settings";
import { AutomationForm } from "@/components/automations/automation-form";
import { AssembleSections } from "@/components/bot-profile/assemble";
import { BotSettingsRows } from "@/components/bot-profile/settings-rows";
import { SetupSections } from "@/components/bot-profile/setup";
import { routineTarget } from "@/components/channels/channel-chat";
import { ConversationHeaderCard } from "@/components/channels/conversation-header-card";
import { externalSubtitle, takesUnattendedWork } from "@/lib/agents/external";
import { type Presence, usePresence } from "@/lib/agents/presence";
import type { AgentProfile, ExternalRun } from "@/lib/agents/queries";
import { authKeys } from "@/lib/auth/queries";
import {
  type AgentChannel,
  type ChannelSummary,
  channelKeys,
} from "@/lib/channels/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { queryClient } from "@/query-client";
import { Route as ChannelRoute } from "@/routes/_authed/_app/channel/$channelId";
import { ComputerPane } from "@/skins/opendots/computer-pane";
import { ContactsPage } from "@/skins/xiongbao/contacts";
import { EmployeeCardContext } from "@/skins/xiongbao/employee-card";
import { MessageList } from "@/skins/xiongbao/message-list";
import { settleReactWork } from "./settle-react-work";

type Sent = { url: string; method: string; body: unknown };
const sent: Sent[] = [];
const originalFetch = globalThis.fetch;
let answers: Map<string, unknown>;
let presence: Presence[];

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
});
beforeEach(() => {
  sent.length = 0;
  answers = new Map();
  presence = [
    {
      agentId: "ext-codex",
      status: "working",
      doing: "修登录接口的 401",
    },
    { agentId: "ext-custom", status: "resting", doing: null },
    { agentId: "a1", status: "resting", doing: null },
  ];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost/");
      const method = init?.method ?? "GET";
      sent.push({
        url: url.pathname,
        method,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      });
      const key = `${method} ${url.pathname}`;
      if (key === "GET /api/agents/presence") {
        const ids = (url.searchParams.get("ids") ?? "").split(",");
        return Response.json({
          items: presence.filter((item) => ids.includes(item.agentId)),
        });
      }
      const answer = answers.get(key);
      if (typeof answer === "function") return answer(init);
      if (answer !== undefined) return Response.json(answer);
      return Response.json({ error: "not served" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
  queryClient.setQueryData(authKeys.currentUser(), {
    id: "me",
    name: "何总",
    email: "me@example.com",
    role: "user",
    onboarding: null,
  });
  queryClient.setQueryData(deploymentKeys.capabilities(), { edition: "team" });
  answers.set("GET /api/agents", { agents: AGENTS });
  answers.set("GET /api/devices", { devices: [MAC] });
  answers.set("GET /api/waker-groups", { groups: [] });
  answers.set("GET /api/bots/attention", { bots: [], lastPingId: null });
  answers.set("GET /api/approvals", {
    enabled: true,
    requests: [],
    rules: [],
    teamRules: [],
    questions: [],
  });
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

const MAC = {
  id: "row-mac",
  deviceId: "dev-mac",
  name: "何总的 MacBook Pro",
  platform: "macos",
  lastSeenAt: "2026-11-15T08:00:00.000Z",
  online: true,
  pairedByUserId: "me",
  roots: [
    { ref: "fld_shop", name: "xiongbao-shop" },
    { ref: "fld_docs", name: "产品文档" },
  ],
  apps: [{ ref: "app_gemini", name: "Gemini CLI" }],
};

const RULES = {
  editInside: "direct",
  touchOutside: "ask",
  runCommand: "dangerous",
  network: "ask",
  push: "ask",
} as const;

function agent(overrides: Partial<AgentProfile>): AgentProfile {
  return {
    id: "x",
    name: "x",
    title: "",
    roleDescription: "",
    avatarSeed: "seed",
    visibility: "private",
    endpoint: null,
    builtIn: false,
    hasAuth: false,
    modelRef: null,
    platformModelRef: null,
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
    summonKind: null,
    summoned: true,
    department: "研发部",
    ...overrides,
  };
}

const CODEX_RUN: ExternalRun = {
  harness: "codex",
  deviceId: "dev-mac",
  workdirRef: "fld_shop",
  rules: { ...RULES },
};
const CODEX = agent({
  id: "ext-codex",
  name: "代码熊",
  // What the hire writes as its title: the badge says it, so the title is not said twice.
  title: "外部员工 · Codex",
  external: {
    harness: "codex",
    deviceId: "dev-mac",
    workdirRef: "fld_shop",
    rules: { ...RULES },
  },
});
const CUSTOM = agent({
  id: "ext-custom",
  name: "双子",
  title: "外部员工 · Gemini CLI",
  external: {
    harness: "custom",
    deviceId: "dev-mac",
    workdirRef: "fld_docs",
    appRef: "app_gemini",
    rules: { ...RULES },
    noPermissionAcknowledged: true,
  },
});
const BUILT_IN = agent({
  id: "a1",
  name: "小熊会计",
  title: "财务专员",
  builtIn: true,
});
const AGENTS = [CODEX, CUSTOM, BUILT_IN];

function renderAt(path: string, page: () => ReactNode) {
  const root = createRootRoute({
    component: () => (
      <>
        {page()}
        <Outlet />
      </>
    ),
  });
  const blank = (at: string) =>
    createRoute({
      path: at,
      getParentRoute: () => root,
      component: () => null,
    });
  const router = createRouter({
    routeTree: root.addChildren([
      blank("/"),
      blank("/contacts"),
      blank("/bots"),
      blank("/bots/$agentId/setup"),
      blank("/bots/$agentId/responsibilities"),
      blank("/bots/$agentId/reach"),
      blank("/bots/$agentId/memory"),
      blank("/bots/$agentId/approvals"),
      blank("/bots/$agentId/routines"),
      blank("/bots/$agentId/access"),
      blank("/bots/$agentId/sharing"),
      blank("/channel/new"),
      blank("/channel/$channelId"),
      blank("/group/new"),
      blank("/group/$channelId"),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, router, user: userEvent.setup({ document }) };
}

describe("通讯录与名片", () => {
  test("contacts card shows 外部员工 · Codex", async () => {
    const { view } = renderAt("/contacts", () => <ContactsPage />);
    const card = await view.findByRole("button", { name: /代码熊/ });
    await waitFor(() =>
      expect(card.querySelector("[data-external-mark]")?.textContent).toBe(
        "外部员工 · Codex",
      ),
    );
    // The hire's title is the same words: written once, as the badge.
    expect(within(card).getAllByText("外部员工 · Codex")).toHaveLength(1);
    // An agent of the person's own goes by the name it was registered under on that computer.
    const custom = await view.findByRole("button", { name: /双子/ });
    await waitFor(() =>
      expect(custom.querySelector("[data-external-mark]")?.textContent).toBe(
        "外部员工 · Gemini CLI",
      ),
    );
    // Any other employee has no badge and keeps its title.
    const builtIn = await view.findByRole("button", { name: /小熊会计/ });
    expect(builtIn.querySelector("[data-external-mark]")).toBeNull();
    expect(within(builtIn).getByText("财务专员")).toBeTruthy();
    // 「招一位新同事」 says both ways in.
    expect(view.getByText("人才市场 · 从我的电脑招")).toBeTruthy();
  });

  test("the card says which computer and folder, and 配置 opens the hire settings to edit", async () => {
    answers.set("GET /api/channels", { channels: [], nextCursor: null });
    answers.set("GET /api/plugins/for/ext-codex", { tools: [], skills: [] });
    const { view, user, router } = renderAt("/contacts", () => (
      <ContactsPage />
    ));
    await user.click(await view.findByRole("button", { name: /代码熊/ }));
    const drawer = within(
      await view.findByRole("dialog", { name: "员工名片" }),
    );
    await waitFor(() =>
      expect(drawer.getByText("何总的 MacBook Pro")).toBeTruthy(),
    );
    expect(drawer.getByText("xiongbao-shop")).toBeTruthy();
    expect(drawer.getByText("外部员工 · Codex")).toBeTruthy();
    expect(drawer.getByText("用它自己的模型和订阅")).toBeTruthy();
    // Codex asks before it acts: no warning.
    expect(drawer.queryByText(/不会请求许可/)).toBeNull();
    await user.click(drawer.getByRole("link", { name: "配置" }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/bots/ext-codex/setup"),
    );
    expect(router.state.location.search).toEqual({ edit: "run" });
  });

  test("custom agent card shows the no-permission warning", async () => {
    answers.set("GET /api/channels", { channels: [], nextCursor: null });
    answers.set("GET /api/plugins/for/ext-custom", { tools: [], skills: [] });
    const { view, user } = renderAt("/contacts", () => <ContactsPage />);
    await user.click(await view.findByRole("button", { name: /双子/ }));
    const drawer = await view.findByRole("dialog", { name: "员工名片" });
    const warning = await waitFor(() => {
      const found = drawer.querySelector("[data-no-permission-warning]");
      if (!found) throw new Error("no warning yet");
      return found;
    });
    expect(warning.textContent).toBe(
      "这个智能体不会请求许可，熊宝拦不住它的动作。",
    );
    await waitFor(() =>
      expect(within(drawer).getByText("外部员工 · Gemini CLI")).toBeTruthy(),
    );
  });

  test("an offline employee's card reads 离线 · N 件排队中", async () => {
    presence = [
      { agentId: "ext-codex", status: "offline", doing: null, queued: 2 },
    ];
    answers.set("GET /api/channels", { channels: [], nextCursor: null });
    answers.set("GET /api/plugins/for/ext-codex", { tools: [], skills: [] });
    const { view, user } = renderAt("/contacts", () => <ContactsPage />);
    await user.click(await view.findByRole("button", { name: /代码熊/ }));
    const drawer = await view.findByRole("dialog", { name: "员工名片" });
    await waitFor(() =>
      expect(drawer.querySelector("[data-presence-summary]")?.textContent).toBe(
        "离线 · 2 件排队中",
      ),
    );
    expect(
      within(drawer).getByRole("img", { name: "离线" }).getAttribute("class"),
    ).toContain("var(--wb-paused");
  });
});

describe("对话顶栏", () => {
  function Header({ profile }: { profile: AgentProfile }) {
    const now = usePresence([profile.id]).get(profile.id);
    return <ConversationHeaderCard agent={profile} presence={now} />;
  }

  function line(view: ReturnType<typeof render>) {
    return waitFor(() => {
      const found = view.container.querySelector("[data-presence]");
      if (!found?.textContent?.includes("在 ")) throw new Error("not yet");
      return found;
    });
  }

  test("header subtitle reads 忙碌 · <此刻> · 在 何总的 MacBook Pro 上", async () => {
    const view = render(
      <QueryClientProvider client={queryClient}>
        <Header profile={CODEX} />
      </QueryClientProvider>,
    );
    expect((await line(view)).textContent?.trim()).toBe(
      "忙碌 · 修登录接口的 401 · 在 何总的 MacBook Pro 上",
    );
    expect(
      view.container.querySelector("[data-external-mark]")?.textContent,
    ).toBe("外部员工 · Codex");
    // The badge says what the title would have: not twice.
    expect(view.getAllByText("外部员工 · Codex")).toHaveLength(1);
  });

  test("offline reads 离线 · N 件排队中 · 在 <电脑名> 上, and no part leaves a stray dot", async () => {
    presence = [
      { agentId: "ext-codex", status: "offline", doing: null, queued: 2 },
    ];
    const view = render(
      <QueryClientProvider client={queryClient}>
        <Header profile={CODEX} />
      </QueryClientProvider>,
    );
    const found = await line(view);
    expect(found.textContent?.trim()).toBe(
      "离线 · 2 件排队中 · 在 何总的 MacBook Pro 上",
    );
    expect(found.querySelector('[data-status-dot="offline"]')).toBeTruthy();
    // No 此刻: the part goes, and so does its dot.
    expect(externalSubtitle("忙碌", "何总的 MacBook Pro")).toBe(
      "忙碌 · 在 何总的 MacBook Pro 上",
    );
    expect(externalSubtitle("空闲", undefined)).toBe("空闲");
    expect(externalSubtitle("", "何总的 MacBook Pro")).toBe(
      "在 何总的 MacBook Pro 上",
    );
  });

  /** The conversation's real route, under the workbench frame's card drawer. */
  function openConversation(chat: AgentChannel, entry = `/channel/${chat.id}`) {
    queryClient.setQueryData(channelKeys.detail(chat.id), chat);
    const rootRoute = createRootRoute({ component: Outlet });
    const authed = createRoute({
      id: "/_authed",
      getParentRoute: () => rootRoute,
      component: Outlet,
    });
    const app = createRoute({
      id: "/_app",
      getParentRoute: () => authed,
      component: Outlet,
    });
    const conversation = ChannelRoute.update({
      id: "/channel/$channelId",
      path: "/channel/$channelId",
      getParentRoute: () => app,
    } as Parameters<typeof ChannelRoute.update>[0] & {
      id: string;
      path: string;
      getParentRoute: () => typeof app;
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([
        authed.addChildren([app.addChildren([conversation])]),
      ]),
      history: createMemoryHistory({ initialEntries: [entry] }),
    });
    const opened: string[] = [];
    const view = render(
      <QueryClientProvider client={queryClient}>
        <ChatRuntimeProvider runtimeUrl="http://localhost/api/runtime">
          <EmployeeCardContext.Provider
            value={{ openEmployeeCard: (id) => opened.push(id) }}
          >
            <RouterProvider router={router as never} />
          </EmployeeCardContext.Provider>
        </ChatRuntimeProvider>
      </QueryClientProvider>,
    );
    return { view, router, opened, user: userEvent.setup({ document }) };
  }

  const chatWith = (agentId: string, id: string): AgentChannel => ({
    id,
    name: agentId,
    agentIds: [agentId],
    threadId: `t-${id}`,
    active: true,
    lastMessageAt: "2026-11-15T08:00:00.000Z",
  });

  /*
   * 「看它的屏幕」 is held back until the device can show one (round 1 ruling): the live screen
   * viewer locates a computer by the Bot's id, and on a cloud deployment that starts a cloud
   * computer for an employee that never works on one.
   */
  test("看它的屏幕 is not offered until the device can show its screen, and no computer is opened for it", async () => {
    const { view, router, opened, user } = openConversation(
      chatWith("ext-codex", "c-ext"),
      "/channel/c-ext?watch=true",
    );
    const card = await view.findByRole("button", { name: "名片" });
    await waitFor(() =>
      expect(
        view.container.querySelector("[data-external-mark]")?.textContent,
      ).toBe("外部员工 · Codex"),
    );
    expect(view.queryByRole("button", { name: "看它的屏幕" })).toBeNull();
    // No computer of ours: neither its controls nor, from a stale `?watch`, its viewer.
    expect(view.queryByRole("button", { name: "打开电脑" })).toBeNull();
    expect(view.queryByRole("button", { name: "接管" })).toBeNull();
    expect(view.queryByRole("region", { name: "电脑侧栏" })).toBeNull();
    // Past the composer's handover poll (once a second for any other employee): nothing asked of a
    // computer for it.
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect(
      sent.some((request) =>
        request.url.startsWith("/api/computers/ext-codex"),
      ),
    ).toBe(false);
    // 名片 is the button the header already had: it opens this employee's card.
    await user.click(card);
    expect(opened).toEqual(["ext-codex"]);
    expect(router.state.location.pathname).toBe("/channel/c-ext");
  });

  test("an external employee's chat has no routine clock; any other employee's has", () => {
    const chat = { id: "c-ext", active: true };
    // The composer draws 「设一条定时任务」 exactly when this says where it points.
    expect(routineTarget(chat, "ext-codex", CODEX)).toBeUndefined();
    expect(routineTarget(chat, "a1", BUILT_IN)).toEqual({
      agentId: "a1",
      channelId: "c-ext",
    });
    // An ended conversation has none either way.
    expect(
      routineTarget({ ...chat, active: false }, "a1", BUILT_IN),
    ).toBeUndefined();
  });
});

describe("消息列表", () => {
  function channel(overrides: Partial<ChannelSummary>): ChannelSummary {
    return {
      id: "c1",
      name: "代码熊",
      agentIds: ["ext-codex"],
      threadId: "t1",
      active: true,
      lastMessageAt: "2026-11-15T08:00:00.000Z",
      summary: null,
      lastMessage: "改好了",
      lastMessageAgentId: "ext-codex",
      createdAt: "2026-11-14T08:00:00.000Z",
      pinned: false,
      lastReadAt: "2026-11-15T09:00:00.000Z",
      ...overrides,
    };
  }

  const CHANNELS = [
    channel({ id: "c-ext", name: "代码熊", agentIds: ["ext-codex"] }),
    channel({
      id: "c-a1",
      name: "小熊会计",
      agentIds: ["a1"],
      lastMessage: "报表好了",
      lastMessageAgentId: "a1",
      lastMessageAt: "2026-11-15T07:00:00.000Z",
    }),
  ];

  test("message list shows the offline banner with the queued count when any external employee is offline", async () => {
    presence = [
      { agentId: "ext-codex", status: "offline", doing: null, queued: 2 },
      { agentId: "ext-custom", status: "resting", doing: null },
      { agentId: "a1", status: "resting", doing: null },
    ];
    answers.set("GET /api/channels", { channels: CHANNELS, nextCursor: null });
    const { view } = renderAt("/", () => <MessageList />);
    const banner = await view.findByRole("region", { name: "电脑离线" });
    await waitFor(() =>
      expect(
        within(banner).getByText("何总的 MacBook Pro 已离线"),
      ).toBeTruthy(),
    );
    expect(
      within(banner).getByText(
        "代码熊有 2 件活在排队，电脑开机后自动继续。你现在派的活也会排进去。",
      ),
    ).toBeTruthy();
    expect(
      within(banner).getByText(
        "下一步上线云端后，可以设成「电脑关机时转到云端继续」。",
      ),
    ).toBeTruthy();
    // Only the offline one: 双子 is on the same computer but its presence reads 空闲.
    expect(within(banner).queryByText(/双子/)).toBeNull();
    // Its row says it too, in place of the last message, with the gray dot.
    const row = view.container.querySelector<HTMLElement>('a[href$="/c-ext"]');
    expect(
      row?.querySelector("[data-message-second]")?.textContent?.trim(),
    ).toBe("离线 · 2 件排队中");
    expect(row?.querySelector('[data-status-dot="offline"]')).toBeTruthy();
    // One presence batch for the rows and the external employees together.
    const asks = sent.filter(
      (request) => request.url === "/api/agents/presence",
    );
    expect(asks.length).toBeGreaterThan(0);
  });

  test("no external employee offline, no banner", async () => {
    answers.set("GET /api/channels", { channels: CHANNELS, nextCursor: null });
    const { view } = renderAt("/", () => <MessageList />);
    const row = await waitFor(() => {
      const found =
        view.container.querySelector<HTMLElement>('a[href$="/c-ext"]');
      if (!found?.querySelector("[data-status-dot]"))
        throw new Error("no presence yet");
      return found;
    });
    expect(row.querySelector("[data-message-second]")?.textContent).toBe(
      "改好了",
    );
    expect(view.queryByRole("region", { name: "电脑离线" })).toBeNull();
  });

  test("two offline on one computer: one banner, each with its own count", async () => {
    presence = [
      { agentId: "ext-codex", status: "offline", doing: null, queued: 2 },
      { agentId: "ext-custom", status: "offline", doing: null, queued: 1 },
    ];
    answers.set("GET /api/channels", { channels: CHANNELS, nextCursor: null });
    const { view } = renderAt("/", () => <MessageList />);
    await view.findByText(
      "代码熊有 2 件、双子有 1 件活在排队，电脑开机后自动继续。你现在派的活也会排进去。",
    );
    expect(view.getAllByRole("region", { name: "电脑离线" })).toHaveLength(1);
  });

  test("offline with nothing queued says its work will queue", async () => {
    presence = [{ agentId: "ext-codex", status: "offline", doing: null }];
    answers.set("GET /api/channels", { channels: CHANNELS, nextCursor: null });
    const { view } = renderAt("/", () => <MessageList />);
    const banner = await view.findByRole("region", { name: "电脑离线" });
    expect(
      await within(banner).findByText(
        "派给代码熊的活会排队，电脑开机后自动继续。",
      ),
    ).toBeTruthy();
  });
});

describe("没人在场的活", () => {
  test("routine/duty entries are hidden for an external employee", async () => {
    answers.set("GET /api/routines", { routines: [] });
    answers.set("GET /api/responsibilities", { responsibilities: [] });
    const { view } = renderAt("/", () => <BotSettingsRows agent={CODEX} />);
    await view.findByText("这位员工的设置");
    expect(view.queryByRole("link", { name: /长期职责/ })).toBeNull();
    expect(view.queryByRole("link", { name: /定时任务/ })).toBeNull();
    // What it can still be set up with stays.
    expect(view.getByRole("link", { name: /设置/ })).toBeTruthy();
    expect(view.getByRole("link", { name: /审批与权限/ })).toBeTruthy();
    cleanup();
    // Any other employee keeps both.
    const other = renderAt("/", () => <BotSettingsRows agent={BUILT_IN} />);
    await other.view.findByText("这位员工的设置");
    expect(other.view.getByRole("link", { name: /长期职责/ })).toBeTruthy();
    expect(other.view.getByRole("link", { name: /定时任务/ })).toBeTruthy();
    // The pickers that hand out such work leave it out by the same rule.
    expect(AGENTS.filter(takesUnattendedWork).map((a) => a.id)).toEqual(["a1"]);
  });
});

describe("别处的入口", () => {
  test("the employee dialog has no 定时任务 tab for an external employee", async () => {
    answers.set("GET /api/agents/ext-codex", { agent: CODEX });
    answers.set("GET /api/agents/a1", { agent: BUILT_IN });
    renderAt("/", () => (
      <AgentDialog agentId="ext-codex" onClose={() => {}} open />
    ));
    const body = within(document.body);
    await body.findAllByText("管理");
    expect(body.getAllByText("交接").length).toBeGreaterThan(0);
    expect(body.queryAllByText("定时任务")).toHaveLength(0);
    cleanup();
    renderAt("/", () => <AgentDialog agentId="a1" onClose={() => {}} open />);
    await body.findAllByText("管理");
    expect(body.getAllByText("定时任务").length).toBeGreaterThan(0);
  });

  test("the opendots computer pane never shows an external employee's computer", async () => {
    // Asked for the external employee, first in the list: the pane falls back to another employee.
    answers.set("GET /api/agents", { agents: [CODEX, CUSTOM, BUILT_IN] });
    const { view } = renderAt("/", () => (
      <ComputerPane defaultBotId="ext-codex" onClose={() => {}} />
    ));
    const pane = await view.findByTestId("opendots-computer-pane");
    await waitFor(() =>
      expect(within(pane).getByText("小熊会计的电脑")).toBeTruthy(),
    );
    expect(within(pane).queryByText(/代码熊|双子/)).toBeNull();
    await settleReactWork();
    expect(
      sent.some((request) => /^\/api\/computers\/ext-/.test(request.url)),
    ).toBe(false);
  });

  test("a new automation cannot pick an external employee, not even by default", async () => {
    // The external employees come first in the list: the default would have been one of them.
    answers.set("GET /api/agents", { agents: [CODEX, CUSTOM, BUILT_IN] });
    answers.set("GET /api/automations/capabilities", { wakerflow: false });
    const view = render(
      <QueryClientProvider client={queryClient}>
        <AutomationForm onCreated={() => {}} />
      </QueryClientProvider>,
    );
    const picker = (await waitFor(() => {
      const found = view.getByLabelText("选择 Waker") as HTMLSelectElement;
      if (found.options.length === 0) throw new Error("no roster yet");
      return found;
    })) as HTMLSelectElement;
    expect([...picker.options].map((option) => option.value)).toEqual(["a1"]);
    expect(picker.value).toBe("a1");
  });

  test("someone other than its hirer sees which agent it is, and nothing to change", async () => {
    // What an administrator reads: only which agent it is.
    const seen = agent({
      id: "ext-codex",
      name: "代码熊",
      title: "外部员工 · Codex",
      mine: false,
      canManage: true,
      external: { harness: "codex" },
    });
    const { view } = renderAt("/", () => <SetupSections agent={seen} />);
    const run = await view.findByText("运行方式");
    const section = run.closest("section") as HTMLElement;
    expect(
      section.querySelector('[data-external-run="智能体"]')?.textContent,
    ).toBe("外部员工 · Codex · 用它自己的模型和订阅");
    expect(section.querySelector('[data-external-run="电脑"]')).toBeNull();
    expect(section.querySelector('[data-external-run="先问你"]')).toBeNull();
    expect(within(section).queryByText("改电脑、文件夹和规则")).toBeNull();
    // No computer list is read for it.
    expect(sent.some((request) => request.url === "/api/devices")).toBe(false);
    cleanup();
    // Its hirer, with the devices list not read yet: says so, not that the folder went away.
    answers.delete("GET /api/devices");
    const hirer = renderAt("/", () => <SetupSections agent={CODEX} />);
    const own = (await hirer.view.findByText("运行方式")).closest(
      "section",
    ) as HTMLElement;
    await waitFor(() =>
      expect(
        own.querySelector('[data-external-run="工作文件夹"]')?.textContent,
      ).toBe("读不到这台电脑"),
    );
    expect(
      within(own).getByRole("button", { name: "改电脑、文件夹和规则" }),
    ).toBeTruthy();
  });
});

describe("设置页", () => {
  test("an external employee's settings keep its persona and drop what it never uses", async () => {
    const { view } = renderAt("/", () => <AssembleSections profile={CODEX} />);
    expect(await view.findByRole("heading", { name: "人设" })).toBeTruthy();
    // Its turns carry no model of ours, no tools and no MCP servers (see AssembleSections).
    const unused = ["模型", "技能", "可自助安装的工具", "连接器", "知识库"];
    for (const name of unused)
      expect(view.queryByRole("heading", { name })).toBeNull();
    cleanup();
    const other = renderAt("/", () => <AssembleSections profile={BUILT_IN} />);
    await other.view.findByRole("heading", { name: "人设" });
    for (const name of unused)
      expect(other.view.getByRole("heading", { name })).toBeTruthy();
  });
});

describe("招聘设置的编辑态", () => {
  test("opens with what it has now and saves only what changed", async () => {
    answers.set("PATCH /api/agents/external/ext-codex", {
      agent: { id: "ext-codex", name: "代码熊", type: "device_acp" },
    });
    let saved = "";
    const { view, user } = renderAt("/", () => (
      <HireSettings
        deviceId="dev-mac"
        editing={{
          agentId: "ext-codex",
          name: "代码熊",
          department: "研发部",
          external: CODEX_RUN,
        }}
        harness="codex"
        onHired={(id) => {
          saved = id;
        }}
      />
    ));
    const form = await view.findByRole("form", { name: "改 代码熊 的配置" });
    expect(within(form).getByLabelText("名字")).toHaveProperty(
      "value",
      "代码熊",
    );
    expect(
      within(form).getByLabelText("工作文件夹（它只在这里面干活）"),
    ).toHaveProperty("value", "fld_shop");
    expect(within(form).getByLabelText("运行命令")).toHaveProperty(
      "value",
      "dangerous",
    );
    // Editing never asks the computer: changing rules does not need it online.
    expect(
      sent.some((request) =>
        /^\/api\/devices\/[^/]+\/agents$/.test(request.url),
      ),
    ).toBe(false);
    await user.selectOptions(
      within(form).getByLabelText("提交并推送代码"),
      "direct",
    );
    await user.click(within(form).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(saved).toBe("ext-codex"));
    const patch = sent.find((request) => request.method === "PATCH");
    expect(patch?.url).toBe("/api/agents/external/ext-codex");
    expect(patch?.body).toEqual({
      name: "代码熊",
      department: "研发部",
      rules: {
        editInside: "direct",
        touchOutside: "ask",
        runCommand: "dangerous",
        network: "ask",
        push: "direct",
      },
    });
  });
});
