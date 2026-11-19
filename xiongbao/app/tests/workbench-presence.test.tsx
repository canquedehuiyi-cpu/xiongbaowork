import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { readFileSync } from "node:fs";
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
import { StatusDot } from "@/components/agents/status-dot";
import { ConversationHeaderCard } from "@/components/channels/conversation-header-card";
import {
  type Presence,
  presenceSummary,
  usePresence,
} from "@/lib/agents/presence";
import { authKeys } from "@/lib/auth/queries";
import type { ChannelSummary } from "@/lib/channels/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { queryClient } from "@/query-client";
import { ContactsPage } from "@/skins/xiongbao/contacts";
import { MessageList } from "@/skins/xiongbao/message-list";
import { settleReactWork } from "./settle-react-work";

/*
 * 员工此刻（聊天工作台 Task 8）：状态点（忙碌橙 / 空闲绿 / 已暂停灰）和「此刻在做什么」，在消息列表、通讯录
 * 卡片和员工名片、对话顶栏上。状态从 `GET /api/agents/presence?ids=…` 一批读出来；读不到、`unknown` 时不画
 * 状态点、不写「此刻」，不编。API 是假的，按产品接口的形状回答；列表、页面和路由是真的。
 */

const originalFetch = globalThis.fetch;
let answers: Map<string, unknown>;
/** 这些请求回 500。 */
let failing: Set<string>;
/** 每次问 presence 时带的 id，按请求的先后（回 500 的也算）。 */
let presenceAsks: string[][];
let presence: Presence[];

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
});
beforeEach(() => {
  answers = new Map();
  failing = new Set();
  presenceAsks = [];
  presence = [
    { agentId: "a1", status: "working", doing: "跑登录页的测试" },
    { agentId: "a2", status: "resting", doing: null },
    { agentId: "a3", status: "paused", doing: null },
    { agentId: "a4", status: "unknown", doing: null },
  ];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost/");
      const key = `${init?.method ?? "GET"} ${url.pathname}`;
      const ids = (url.searchParams.get("ids") ?? "").split(",");
      if (key === "GET /api/agents/presence") presenceAsks.push(ids);
      if (failing.has(key)) {
        return Response.json({ error: "服务器出错了" }, { status: 500 });
      }
      if (key === "GET /api/agents/presence") {
        return Response.json({
          items: presence.filter((item) => ids.includes(item.agentId)),
        });
      }
      const answer = answers.get(key);
      if (answer !== undefined) return Response.json(answer);
      return Response.json({ error: "not served" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
  queryClient.setQueryData(authKeys.currentUser(), {
    id: "alice",
    name: "Alice Park",
    email: "alice@example.com",
    role: "user",
    onboarding: null,
  });
  queryClient.setQueryData(deploymentKeys.capabilities(), { edition: "team" });
  answers.set("GET /api/agents", { agents: AGENTS });
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

function agent(overrides: Record<string, unknown>) {
  return {
    id: "x",
    name: "x",
    title: "",
    roleDescription: "",
    avatarSeed: "seed",
    visibility: "private",
    endpoint: null,
    builtIn: true,
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

const AGENTS = [
  agent({ id: "a1", name: "代码熊", title: "全栈工程师" }),
  agent({ id: "a2", name: "小熊会计", title: "财务专员" }),
  agent({ id: "a3", name: "暖心医生", title: "健康顾问" }),
  agent({ id: "a4", name: "熊大厨", title: "行政主厨" }),
];

function channel(overrides: Partial<ChannelSummary>): ChannelSummary {
  return {
    id: "c1",
    name: "代码熊",
    agentIds: ["a1"],
    threadId: "t1",
    active: true,
    lastMessageAt: "2026-11-14T08:00:00.000Z",
    summary: null,
    lastMessage: "改好了",
    lastMessageAgentId: "a1",
    createdAt: "2026-11-13T08:00:00.000Z",
    pinned: false,
    lastReadAt: "2026-11-14T09:00:00.000Z",
    ...overrides,
  };
}

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
  return { view, user: userEvent.setup({ document }) };
}

describe("StatusDot", () => {
  test("忙碌 / 空闲 / 已暂停各有读得出的词和自己的颜色令牌", () => {
    const view = render(
      <>
        <StatusDot status="working" />
        <StatusDot status="resting" />
        <StatusDot status="paused" />
      </>,
    );
    const colour = (name: string) =>
      view.getByRole("img", { name }).getAttribute("class") ?? "";
    expect(colour("忙碌")).toContain("var(--wb-busy");
    expect(colour("空闲")).toContain("var(--wb-idle");
    expect(colour("已暂停")).toContain("var(--wb-paused");
  });

  test("别的皮肤里没有 --wb-* 时，后备是应用的主题令牌，不写死颜色", () => {
    const view = render(
      <>
        <StatusDot status="working" />
        <StatusDot status="resting" />
        <StatusDot status="paused" />
      </>,
    );
    const colour = (name: string) =>
      view.getByRole("img", { name }).getAttribute("class") ?? "";
    expect(colour("忙碌")).toContain("var(--wb-busy,var(--signal))");
    expect(colour("空闲")).toContain("var(--wb-idle,var(--success))");
    expect(colour("已暂停")).toContain(
      "var(--wb-paused,var(--muted-foreground))",
    );
    for (const name of ["忙碌", "空闲", "已暂停"]) {
      expect(colour(name)).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|oklch\(/i);
    }
    // 这三个令牌应用的浅色、深色两套里都有（`styles.css` 的 `:root` 和 `.dark`）。
    const theme = readFileSync(
      new URL("../src/styles.css", import.meta.url),
      "utf8",
    );
    for (const token of ["--signal:", "--success:", "--muted-foreground:"]) {
      expect(theme.split(token).length - 1).toBeGreaterThanOrEqual(2);
    }
  });

  test("offline dot is gray and reads 离线 · 2 件排队中", () => {
    const offline: Presence = {
      agentId: "x1",
      status: "offline",
      doing: null,
      queued: 2,
    };
    const view = render(
      <StatusDot status="offline" title={presenceSummary(offline)} />,
    );
    const dot = view.getByRole("img", { name: "离线" });
    // The paused gray, with the app's theme token behind it in other skins.
    expect(dot.getAttribute("class")).toContain(
      "var(--wb-paused,var(--muted-foreground))",
    );
    expect(dot.getAttribute("title")).toBe("离线 · 2 件排队中");
    // Nothing waiting, or a group member who is not told the count: just the word.
    expect(presenceSummary({ ...offline, queued: 0 })).toBe("离线");
    expect(presenceSummary({ ...offline, queued: undefined })).toBe("离线");
    // The count belongs to offline only; working still reads its task.
    expect(
      presenceSummary({
        agentId: "x1",
        status: "working",
        doing: "跑测试",
        queued: 3,
      }),
    ).toBe("忙碌 · 跑测试");
    cleanup();
    // The conversation header says it too.
    const header = render(
      <QueryClientProvider client={queryClient}>
        <ConversationHeaderCard
          agent={
            {
              id: "x1",
              name: "小码",
              title: "外部员工 · Codex",
              avatarSeed: "x1",
              visibility: "private",
            } as never
          }
          presence={offline}
        />
      </QueryClientProvider>,
    );
    const line = header.container.querySelector("[data-presence]");
    expect(line?.textContent?.trim()).toBe("离线 · 2 件排队中");
    expect(line?.querySelector('[data-status-dot="offline"]')).toBeTruthy();
  });

  test("unknown 和没拿到的不画", () => {
    const view = render(
      <>
        <StatusDot status="unknown" />
        <StatusDot status={undefined} />
      </>,
    );
    expect(view.container.querySelector("[data-status-dot]")).toBeNull();
  });
});

describe("消息列表", () => {
  const CHANNELS = [
    channel({ id: "c-a1", name: "代码熊", agentIds: ["a1"] }),
    channel({
      id: "c-a2",
      name: "小熊会计",
      agentIds: ["a2"],
      lastMessageAt: "2026-11-14T07:00:00.000Z",
    }),
    channel({
      id: "c-a4",
      name: "熊大厨",
      agentIds: ["a4"],
      lastMessageAt: "2026-11-14T06:00:00.000Z",
    }),
    channel({
      id: "g1",
      name: "产品研发群",
      agentIds: ["a1", "a3"],
      lastMessageAt: "2026-11-14T05:00:00.000Z",
    }),
  ];

  function row(view: ReturnType<typeof render>, channelId: string) {
    const link = view.container.querySelector<HTMLElement>(
      `a[href$="/${channelId}"]`,
    );
    if (!link) throw new Error(`no row for ${channelId}`);
    return link;
  }

  test("单聊行有状态点，群组和 unknown 的没有；整个列表只问一次", async () => {
    answers.set("GET /api/channels", { channels: CHANNELS, nextCursor: null });
    const { view } = renderAt("/", () => <MessageList />);
    await waitFor(() =>
      expect(
        within(row(view, "c-a1")).getByRole("img", { name: "忙碌" }),
      ).toBeTruthy(),
    );
    expect(
      within(row(view, "c-a1"))
        .getByRole("img", { name: "忙碌" })
        .getAttribute("title"),
    ).toBe("忙碌 · 跑登录页的测试");
    expect(
      within(row(view, "c-a2")).getByRole("img", { name: "空闲" }),
    ).toBeTruthy();
    expect(row(view, "c-a4").querySelector("[data-status-dot]")).toBeNull();
    expect(row(view, "g1").querySelector("[data-status-dot]")).toBeNull();
    // 一批：三个单聊员工，群组成员（a3）不在里面。
    expect(presenceAsks).toEqual([["a1", "a2", "a4"]]);
  });

  test("换筛选、搜索不换这一批，不重新问", async () => {
    answers.set("GET /api/channels", { channels: CHANNELS, nextCursor: null });
    const { view, user } = renderAt("/", () => <MessageList />);
    await waitFor(() =>
      expect(
        within(row(view, "c-a1")).getByRole("img", { name: "忙碌" }),
      ).toBeTruthy(),
    );
    await user.type(view.getByRole("searchbox", { name: "搜索会话" }), "会计");
    await waitFor(() =>
      expect(view.container.querySelector('a[href$="/c-a1"]')).toBeNull(),
    );
    await user.click(view.getByRole("button", { name: "群组" }));
    await settleReactWork();
    // 一批，取全部载入的单聊员工：筛掉的那几位也在里面。
    expect(presenceAsks).toEqual([["a1", "a2", "a4"]]);
  });

  test("读不到时不画状态点", async () => {
    answers.set("GET /api/channels", { channels: CHANNELS, nextCursor: null });
    failing.add("GET /api/agents/presence");
    const { view } = renderAt("/", () => <MessageList />);
    await waitFor(() => expect(row(view, "c-a1")).toBeTruthy());
    await waitFor(() => expect(presenceAsks.length).toBeGreaterThan(0));
    await settleReactWork();
    expect(view.container.querySelector("[data-status-dot]")).toBeNull();
  });
});

describe("通讯录与员工名片", () => {
  async function card(view: ReturnType<typeof render>, name: RegExp) {
    return view.findByRole("button", { name });
  }

  test("卡上有状态点；忙碌的写「此刻：任务标题」，别的不写", async () => {
    const { view } = renderAt("/contacts", () => <ContactsPage />);
    const busy = await card(view, /代码熊/);
    await waitFor(() =>
      expect(within(busy).getByRole("img", { name: "忙碌" })).toBeTruthy(),
    );
    expect(busy.querySelector("[data-now-doing]")?.textContent?.trim()).toBe(
      "此刻：跑登录页的测试",
    );

    const idle = await card(view, /小熊会计/);
    expect(within(idle).getByRole("img", { name: "空闲" })).toBeTruthy();
    expect(idle.querySelector("[data-now-doing]")).toBeNull();

    const paused = await card(view, /暖心医生/);
    expect(within(paused).getByRole("img", { name: "已暂停" })).toBeTruthy();
    expect(paused.querySelector("[data-now-doing]")).toBeNull();

    const unknown = await card(view, /熊大厨/);
    expect(unknown.querySelector("[data-status-dot]")).toBeNull();
    expect(unknown.querySelector("[data-now-doing]")).toBeNull();
    // 整张组织架构一次。
    expect(presenceAsks).toEqual([["a1", "a2", "a3", "a4"]]);
  });

  test("员工名片上有状态点和「此刻」", async () => {
    answers.set("GET /api/channels", { channels: [], nextCursor: null });
    answers.set("GET /api/plugins/for/a1", { tools: [], skills: [] });
    const { view, user } = renderAt("/contacts", () => <ContactsPage />);
    await user.click(await card(view, /代码熊/));
    const drawer = within(
      await view.findByRole("dialog", { name: "员工名片" }),
    );
    await waitFor(() =>
      expect(drawer.getByRole("img", { name: "忙碌" })).toBeTruthy(),
    );
    expect(drawer.getByText("跑登录页的测试")).toBeTruthy();
    expect(drawer.getByText("此刻：")).toBeTruthy();
  });

  test("读不到时卡上和名片上都没有状态点和「此刻」", async () => {
    failing.add("GET /api/agents/presence");
    answers.set("GET /api/channels", { channels: [], nextCursor: null });
    answers.set("GET /api/plugins/for/a1", { tools: [], skills: [] });
    const { view, user } = renderAt("/contacts", () => <ContactsPage />);
    await user.click(await card(view, /代码熊/));
    await view.findByRole("dialog", { name: "员工名片" });
    await waitFor(() => expect(presenceAsks.length).toBeGreaterThan(1));
    await settleReactWork();
    expect(view.container.querySelector("[data-status-dot]")).toBeNull();
    expect(view.container.querySelector("[data-now-doing]")).toBeNull();
    expect(view.queryByText(/此刻/)).toBeNull();
  });
});

describe("对话顶栏", () => {
  const profile = {
    id: "a1",
    name: "代码熊",
    title: "全栈工程师",
    avatarSeed: "seed-1",
    visibility: "private" as const,
  };

  /** 和对话页顶栏同一个接法：一次读这一位员工此刻的状态，交给员工卡。 */
  function Header() {
    const now = usePresence([profile.id]).get(profile.id);
    return <ConversationHeaderCard agent={profile as never} presence={now} />;
  }

  test("忙碌时第二行写「忙碌 · 任务标题」，带状态点", async () => {
    const view = render(
      <QueryClientProvider client={queryClient}>
        <Header />
      </QueryClientProvider>,
    );
    const line = await waitFor(() => {
      const found = view.container.querySelector("[data-presence]");
      if (!found) throw new Error("no presence line yet");
      return found;
    });
    expect(line.textContent?.trim()).toBe("忙碌 · 跑登录页的测试");
    expect(line.querySelector('[data-status-dot="working"]')).toBeTruthy();
    // 职务挪到名字旁边，还在。
    expect(view.getByText("全栈工程师")).toBeTruthy();
  });

  test("空闲、已暂停只写那个词", () => {
    const view = render(
      <QueryClientProvider client={queryClient}>
        <ConversationHeaderCard
          agent={profile as never}
          presence={{ agentId: "a1", status: "paused", doing: null }}
        />
      </QueryClientProvider>,
    );
    expect(
      view.container.querySelector("[data-presence]")?.textContent?.trim(),
    ).toBe("已暂停");
  });

  test("unknown 或读不到时没有状态点和状态字，照旧写职务", async () => {
    const view = render(
      <QueryClientProvider client={queryClient}>
        <ConversationHeaderCard
          agent={profile as never}
          presence={{ agentId: "a1", status: "unknown", doing: "不该出现" }}
        />
      </QueryClientProvider>,
    );
    expect(view.container.querySelector("[data-status-dot]")).toBeNull();
    expect(view.container.querySelector("[data-presence]")).toBeNull();
    expect(view.queryByText(/不该出现|忙碌|空闲/)).toBeNull();
    expect(view.getByText("全栈工程师")).toBeTruthy();
    cleanup();

    failing.add("GET /api/agents/presence");
    const failed = render(
      <QueryClientProvider client={queryClient}>
        <Header />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(presenceAsks.length).toBeGreaterThan(0));
    await settleReactWork();
    expect(failed.container.querySelector("[data-status-dot]")).toBeNull();
    expect(failed.getByText("全栈工程师")).toBeTruthy();
  });

  test("读到过以后再读失败，不留着旧的状态", async () => {
    const view = render(
      <QueryClientProvider client={queryClient}>
        <Header />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(view.container.querySelector("[data-presence]")).toBeTruthy(),
    );
    failing.add("GET /api/agents/presence");
    void queryClient.refetchQueries({ queryKey: ["agents", "presence"] });
    // 失败的读取重试一次才算失败。
    await waitFor(
      () => expect(view.container.querySelector("[data-presence]")).toBeNull(),
      { timeout: 5_000 },
    );
    expect(view.container.querySelector("[data-status-dot]")).toBeNull();
    expect(view.getByText("全栈工程师")).toBeTruthy();
  });
});
