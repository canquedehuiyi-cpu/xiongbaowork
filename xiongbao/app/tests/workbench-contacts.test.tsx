import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
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
import { employeeNumber } from "@/components/summon/summon-card-flip";
import { authKeys } from "@/lib/auth/queries";
import type { ChannelSummary } from "@/lib/channels/queries";
import { railForPath } from "@/lib/navigation";
import { queryClient } from "@/query-client";
import { clearSkin } from "@/skins/store";
import { ContactsPage } from "@/skins/xiongbao/contacts";
import { firstSentence, joinedDay } from "@/skins/xiongbao/employee-card";
import { WorkbenchFrame } from "@/skins/xiongbao/frame";
import { settleReactWork } from "./settle-react-work";

/*
 * 通讯录与员工名片（聊天工作台 Task 7）：列表栏顶上的人才市场（带待召唤人数）和我的群组，主区按部门分组
 * 的组织架构，点员工卡打开右侧的员工名片。API 是个假的，按产品接口的形状回答；外壳、页面和路由都是真的。
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

const member = {
  id: "alice",
  name: "Alice Park",
  email: "alice@example.com",
  role: "user" as const,
  onboarding: null,
};

/** 本地时间的某一天中午，离今天差 `daysAgo` 天。 */
function localNoon(daysAgo: number): string {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() - daysAgo);
  return date.toISOString();
}

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
    department: null,
    ...overrides,
  };
}

const AGENTS = [
  agent({
    id: "a1",
    name: "代码熊",
    title: "全栈工程师",
    department: "研发部",
    createdAt: localNoon(3),
    modelRef: "m1",
    persona: {
      tone: "说话直接、先给结论。改动最小可验证。",
      principles: "",
      habits: "",
    },
  }),
  agent({ id: "a2", name: "阿木", title: "后端工程师", department: "研发部" }),
  agent({
    id: "a3",
    name: "小熊会计",
    title: "财务专员",
    department: "财务部",
    createdAt: localNoon(0),
  }),
  agent({ id: "a4", name: "熊大厨", title: "行政主厨", department: null }),
  // 不在组织架构里的：藏起来的、预设原件（召唤过）、待召唤的预设和分身。
  agent({ id: "a5", name: "藏起来的", department: "研发部", hidden: true }),
  agent({
    id: "preset-held",
    name: "已召唤过的预设",
    summonKind: "preset",
    summoned: true,
    department: "研发部",
  }),
  agent({
    id: "preset-pm",
    name: "许清楚",
    title: "产品经理",
    summonKind: "preset",
    summoned: false,
    department: "产品部",
  }),
  agent({
    id: "avatar-alice",
    name: "Alice 的分身",
    title: "我的分身",
    summonKind: "avatar",
    summoned: false,
  }),
];

function channel(overrides: Partial<ChannelSummary>): ChannelSummary {
  return {
    id: "c1",
    name: "代码熊",
    agentIds: ["a1"],
    threadId: "t1",
    active: true,
    lastMessageAt: "2026-11-14T08:00:00.000Z",
    summary: "登录改版",
    lastMessage: "改好了",
    lastMessageAgentId: "a1",
    createdAt: "2026-11-13T08:00:00.000Z",
    pinned: false,
    lastReadAt: "2026-11-14T09:00:00.000Z",
    ...overrides,
  };
}

const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;
let answers: Map<string, unknown>;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  globalThis.WebSocket = OfflineWebSocket as unknown as typeof WebSocket;
});
beforeEach(() => {
  answers = new Map<string, unknown>([
    ["GET /api/agents", { agents: AGENTS }],
    [
      "GET /api/channels",
      {
        channels: [
          channel({ id: "c-direct", agentIds: ["a1"] }),
          // 群聊不算「和他说话」。
          channel({ id: "c-group", agentIds: ["a4", "a1"] }),
        ],
        nextCursor: null,
      },
    ],
    ["GET /api/bots/attention", { bots: [], lastPingId: null }],
    [
      "GET /api/models",
      {
        models: [
          {
            id: "m1",
            provider: "deepseek",
            baseUrl: null,
            modelName: "deepseek-chat",
            label: "DeepSeek V3",
            enabled: true,
            updatedAt: "2026-11-01T00:00:00.000Z",
            coworkers: 1,
          },
        ],
        templates: [],
        pool: [],
        customModels: true,
      },
    ],
    [
      "GET /api/plugins/for/a1",
      {
        tools: [],
        skills: [
          { slug: "review", title: "代码审查", summary: "", instructions: "" },
          { slug: "tests", title: "自动化测试", summary: "", instructions: "" },
        ],
      },
    ],
    ["GET /api/plugins/for/a4", { tools: [], skills: [] }],
  ]);
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "http://localhost/").pathname;
      const answer = answers.get(`${init?.method ?? "GET"} ${path}`);
      if (answer !== undefined) return Response.json(answer);
      return Response.json({ error: "not served" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  clearSkin();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  globalThis.WebSocket = originalWebSocket;
  GlobalRegistrator.unregister();
});

/** 外壳包着通讯录页和几个占位页面，像 `_app` 布局包着路由页面那样；`framed: false` 是别的皮肤。 */
function renderApp(path: string, { framed = true } = {}) {
  queryClient.setQueryData(authKeys.currentUser(), member);
  const root = createRootRoute({
    component: () =>
      framed ? (
        <WorkbenchFrame>
          <Outlet />
        </WorkbenchFrame>
      ) : (
        <Outlet />
      ),
  });
  const page = (at: string, text: string) =>
    createRoute({
      path: at,
      getParentRoute: () => root,
      component: () => <p>{text}</p>,
    });
  const router = createRouter({
    routeTree: root.addChildren([
      page("/", "首页内容"),
      createRoute({
        path: "/contacts",
        getParentRoute: () => root,
        component: ContactsPage,
      }),
      page("/bots", "人才市场页内容"),
      page("/bots/$agentId/setup", "配置页内容"),
      page("/tasks", "任务看板内容"),
      page("/group/new", "新建群组内容"),
      page("/channel/$channelId", "对话页内容"),
      page("/channel/new", "新对话内容"),
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

async function listColumn(view: ReturnType<typeof render>) {
  return within(await view.findByRole("complementary", { name: "列表栏" }));
}

/** 通讯录页本身（外壳里它在主区，别的皮肤里它就是页面）。 */
async function orgChart(view: ReturnType<typeof render>) {
  const page = await waitFor(() => {
    const found = view.container.querySelector<HTMLElement>("[data-contacts]");
    if (!found) throw new Error("the contacts page is not drawn yet");
    return found;
  });
  return within(page);
}

async function openCard(view: ReturnType<typeof render>, name: RegExp) {
  const user = userEvent.setup({ document });
  const card = await (await orgChart(view)).findByRole("button", { name });
  await user.click(card);
  return within(await view.findByRole("dialog", { name: "员工名片" }));
}

describe("通讯录列表栏", () => {
  test("顶上是人才市场（带待召唤人数，链 /bots）和我的群组", async () => {
    const { view } = renderApp("/contacts");
    const list = await listColumn(view);
    const market = await list.findByRole("link", { name: /^人才市场/ });
    expect(market.getAttribute("href")).toBe("/bots");
    // 待召唤的预设和分身各一位；召唤过的预设、本来就在名册上的都不算。
    expect(await within(market).findByText("2 位待召唤")).toBeTruthy();
    expect(list.getByRole("link", { name: "我的群组" })).toBeTruthy();
    // 组织架构是通讯录里的当前页。
    expect(
      list.getByRole("link", { name: "组织架构" }).getAttribute("aria-current"),
    ).toBe("page");
  });

  test("没有待召唤的员工时人才市场不写人数", async () => {
    answers.set("GET /api/agents", {
      agents: AGENTS.filter((row) => row.summoned !== false),
    });
    const { view } = renderApp("/contacts");
    await (await orgChart(view)).findByRole("button", { name: /代码熊/ });
    const market = (await listColumn(view)).getByRole("link", {
      name: /^人才市场/,
    });
    expect(market.textContent).toBe("人才市场");
  });

  test("点入口栏的「通讯录」落到组织架构", async () => {
    const { view, router, user } = renderApp("/");
    await view.findByText("首页内容");
    const rail = within(view.getByRole("navigation", { name: "入口" }));
    await user.click(rail.getByRole("button", { name: "通讯录" }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/contacts"),
    );
    expect(
      await (await orgChart(view)).findByRole("heading", { name: "组织架构" }),
    ).toBeTruthy();
  });

  test("/contacts 归「通讯录」", () => {
    expect(railForPath("/contacts")).toBe("contacts");
  });
});

describe("组织架构", () => {
  test("按部门分组，组内按名字，没有部门的归「未分组」排在最后", async () => {
    const { view } = renderApp("/contacts");
    const main = await orgChart(view);
    await main.findByRole("button", { name: /代码熊/ });
    const groups = main.getAllByRole("region");
    expect(
      groups.map((group) => group.getAttribute("aria-label") ?? ""),
    ).toEqual(["研发部", "财务部", "未分组"]);
    const names = (group: HTMLElement) =>
      within(group)
        .getAllByRole("button")
        .map((button) => button.getAttribute("data-employee"));
    expect(names(groups[0] as HTMLElement)).toEqual(["a2", "a1"]);
    expect(names(groups[1] as HTMLElement)).toEqual(["a3"]);
    expect(names(groups[2] as HTMLElement)).toEqual(["a4"]);
    expect(within(groups[0] as HTMLElement).getByText("2 人")).toBeTruthy();
    // 员工卡写名字和职务。
    expect(
      within(groups[0] as HTMLElement).getByText("全栈工程师"),
    ).toBeTruthy();
  });

  test("手机宽度也不横向溢出：页面一列是 minmax(0,1fr)，两边留白", async () => {
    const { view } = renderApp("/contacts");
    const main = await orgChart(view);
    const heading = await main.findByRole("heading", {
      level: 1,
      name: "组织架构",
    });
    const page = heading.closest("header")?.parentElement as HTMLElement;
    expect(page.className).toContain("grid-cols-[minmax(0,1fr)]");
    expect(page.className).toContain("px-[13px]");
  });

  test("研发部末尾有「招一位新同事」卡，链 /bots", async () => {
    const { view } = renderApp("/contacts");
    const main = await orgChart(view);
    await main.findByRole("button", { name: /代码熊/ });
    const research = main.getByRole("region", { name: "研发部" });
    const recruit = within(research).getByRole("link", {
      name: /招一位新同事/,
    });
    expect(recruit.getAttribute("href")).toBe("/bots");
    const items = within(research).getAllByRole("listitem");
    expect(items.at(-1)?.contains(recruit)).toBe(true);
    // 别的部门没有这张卡。
    expect(main.getAllByRole("link", { name: /招一位新同事/ })).toHaveLength(1);
  });

  test("「招一位新同事」卡上写待召唤预设的名字，不写职务，也不写本人的分身", async () => {
    const { view } = renderApp("/contacts");
    const main = await orgChart(view);
    await main.findByRole("button", { name: /代码熊/ });
    const recruit = main.getByRole("link", { name: /招一位新同事/ });
    expect(recruit.textContent).toContain("许清楚");
    expect(recruit.textContent).not.toContain("产品经理");
    expect(recruit.textContent).not.toContain("分身");
  });

  test("没有研发部时「招一位新同事」放在最后一组末尾", async () => {
    answers.set("GET /api/agents", {
      agents: AGENTS.filter((row) => row.department !== "研发部"),
    });
    const { view } = renderApp("/contacts");
    const main = await orgChart(view);
    await main.findByRole("button", { name: /小熊会计/ });
    const last = main.getByRole("region", { name: "未分组" });
    expect(
      within(last).getByRole("link", { name: /招一位新同事/ }),
    ).toBeTruthy();
  });
});

describe("员工名片", () => {
  test("工号、部门、入职第几天、性格、模型、擅长的技能", async () => {
    const { view } = renderApp("/contacts");
    const card = await openCard(view, /代码熊/);
    expect(card.getByRole("heading", { name: "代码熊" })).toBeTruthy();
    expect(card.getByText(`工号 ${employeeNumber("a1")}`)).toBeTruthy();
    expect(employeeNumber("a1")).toMatch(/^XB-\d{4}$/);
    expect(card.getByText("研发部")).toBeTruthy();
    // 三天前入职：今天是第 4 天。
    expect(card.getByText("入职第 4 天")).toBeTruthy();
    // 性格是人设「怎么说话」的第一句。
    expect(card.getByText("说话直接、先给结论。")).toBeTruthy();
    expect(card.queryByText(/改动最小可验证/)).toBeNull();
    expect(await card.findByText("DeepSeek V3 · DeepSeek")).toBeTruthy();
    const skills = within(
      await card.findByRole("list", { name: "擅长的技能" }),
    );
    expect(skills.getAllByRole("listitem").map((li) => li.textContent)).toEqual(
      ["代码审查", "自动化测试"],
    );
  });

  test("名片的内容一列是 minmax(0,1fr)，长的「此刻」和模型名不把它撑出屏幕", async () => {
    const { view } = renderApp("/contacts");
    const card = await openCard(view, /代码熊/);
    const body = card.getByRole("heading", { name: "代码熊" })
      .parentElement as HTMLElement;
    expect(body.className).toContain("grid-cols-[minmax(0,1fr)]");
    const facts = (await card.findByText("模型")).parentElement as HTMLElement;
    expect(facts.className).toContain("grid-cols-[70px_minmax(0,1fr)]");
  });

  test("四个按钮：发消息（最近的单聊）、配置、交给他一个任务、拉进群", async () => {
    const { view } = renderApp("/contacts");
    const card = await openCard(view, /代码熊/);
    const href = (name: string) =>
      card.getByRole("link", { name }).getAttribute("href");
    await waitFor(() => expect(href("发消息")).toBe("/channel/c-direct"));
    expect(href("配置")).toBe("/bots/a1/setup");
    // 任务在对话里交代：和「发消息」去同一段对话（到了输入框就有光标）。
    expect(href("交给他一个任务")).toBe("/channel/c-direct");
    // 拉进群：新建群组页预先勾上他。
    expect(href("拉进群")).toBe("/group/new?agent=a1");
  });

  test("没有单聊时「发消息」开一段发给他的新对话；读不到的不写", async () => {
    const { view } = renderApp("/contacts");
    const card = await openCard(view, /熊大厨/);
    expect(
      card.getByRole("link", { name: "发消息" }).getAttribute("href"),
    ).toBe("/channel/new?agent=a4");
    expect(
      card.getByRole("link", { name: "交给他一个任务" }).getAttribute("href"),
    ).toBe("/channel/new?agent=a4");
    expect(card.getByText("未分组")).toBeTruthy();
    // 没有人设、没有创建时间、没有技能：这几行都不出现。
    expect(card.queryByText("性格")).toBeNull();
    expect(card.queryByText(/入职第/)).toBeNull();
    // 没绑模型、跑在这里：部署自带的模型。
    expect(card.getByText("部署自带的模型")).toBeTruthy();
    await waitFor(() =>
      expect(card.queryByRole("list", { name: "擅长的技能" })).toBeNull(),
    );
  });

  test("今天入职是第 1 天", async () => {
    const { view } = renderApp("/contacts");
    const card = await openCard(view, /小熊会计/);
    expect(card.getByText("入职第 1 天")).toBeTruthy();
  });

  test("绑的模型读不到名字时不写模型", async () => {
    answers.set("GET /api/models", {
      models: [],
      templates: [],
      pool: [],
      customModels: true,
    });
    const { view } = renderApp("/contacts");
    const card = await openCard(view, /代码熊/);
    await card.findByText("入职第 4 天");
    await settleReactWork();
    expect(card.queryByText("模型")).toBeNull();
    expect(card.queryByText("部署自带的模型")).toBeNull();
  });

  test("名片挂在外壳上（不在主区里），关闭按钮和 Esc 都能关上", async () => {
    const { view, user } = renderApp("/contacts");
    let card = await openCard(view, /代码熊/);
    const dialog = view.getByRole("dialog", { name: "员工名片" });
    expect(view.getByRole("main").contains(dialog)).toBe(false);
    expect(dialog.closest("[data-workbench-frame]")).toBeTruthy();
    await user.click(card.getByRole("button", { name: "关闭" }));
    expect(view.queryByRole("dialog", { name: "员工名片" })).toBeNull();

    card = await openCard(view, /阿木/);
    expect(card.getByRole("heading", { name: "阿木" })).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(view.queryByRole("dialog", { name: "员工名片" })).toBeNull();
  });

  test("别处已经处理过的 Esc、或者焦点不在名片里时按的 Esc，不关名片", async () => {
    const { view, user } = renderApp("/contacts");
    const card = await openCard(view, /代码熊/);
    // 名片里的焦点上，一个已被处理（preventDefault）的 Esc：不是给名片的。
    const handled = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    handled.preventDefault();
    card.getByRole("button", { name: "关闭" }).dispatchEvent(handled);
    expect(view.getByRole("dialog", { name: "员工名片" })).toBeTruthy();

    // 焦点挪到主区里的东西上，再按 Esc：也不关。
    const tile = (await orgChart(view)).getByRole("button", { name: /阿木/ });
    tile.focus();
    await user.keyboard("{Escape}");
    expect(view.getByRole("dialog", { name: "员工名片" })).toBeTruthy();
  });

  test("从 A 的名片直接换到 B 的，关上 B 后焦点回到 B 的员工卡", async () => {
    const { view, user } = renderApp("/contacts");
    const main = await orgChart(view);
    await openCard(view, /代码熊/);
    const tileB = main.getByRole("button", { name: /阿木/ });
    await user.click(tileB);
    const card = within(
      await waitFor(() => {
        const dialog = view.getByRole("dialog", { name: "员工名片" });
        if (dialog.getAttribute("data-employee-card") !== "a2")
          throw new Error("still on the first card");
        return dialog;
      }),
    );
    expect(document.activeElement).toBe(
      card.getByRole("button", { name: "关闭" }),
    );
    await user.click(card.getByRole("button", { name: "关闭" }));
    expect(view.queryByRole("dialog", { name: "员工名片" })).toBeNull();
    expect(document.activeElement).toBe(tileB);
  });

  test("点名片里的「配置」去配置页，名片收起", async () => {
    const { view, router, user } = renderApp("/contacts");
    const card = await openCard(view, /代码熊/);
    await user.click(card.getByRole("link", { name: "配置" }));
    await view.findByText("配置页内容");
    expect(router.state.location.pathname).toBe("/bots/a1/setup");
    expect(view.queryByRole("dialog", { name: "员工名片" })).toBeNull();
  });

  test("别的皮肤里（没有工作台外壳）通讯录页自己打开名片", async () => {
    const { view } = renderApp("/contacts", { framed: false });
    const card = await openCard(view, /代码熊/);
    expect(card.getByText(`工号 ${employeeNumber("a1")}`)).toBeTruthy();
  });
});

describe("名片上的小算法", () => {
  test("firstSentence 取第一句，没有句号时取整段", () => {
    expect(firstSentence("务实、克制。先说结论。")).toBe("务实、克制。");
    expect(firstSentence("Calm! Then more.")).toBe("Calm!");
    expect(firstSentence("第一行\n第二行")).toBe("第一行");
    expect(firstSentence("  没有句号  ")).toBe("没有句号");
    expect(firstSentence("   ")).toBe("");
  });

  test("joinedDay 按本地日历算：今天第 1 天，昨天入职第 2 天", () => {
    const now = new Date(2026, 10, 14, 0, 30);
    expect(joinedDay(new Date(2026, 10, 14, 0, 5).toISOString(), now)).toBe(1);
    expect(joinedDay(new Date(2026, 10, 13, 23, 59).toISOString(), now)).toBe(
      2,
    );
    expect(joinedDay(new Date(2026, 9, 15, 12).toISOString(), now)).toBe(31);
    // 时钟比创建时间慢、或者读不懂：不写。
    expect(joinedDay(new Date(2026, 10, 15).toISOString(), now)).toBeNull();
    expect(joinedDay("not a date", now)).toBeNull();
  });
});
