import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import { avatarSourceKeys } from "@/lib/avatar/sources";
import {
  type BotAttention,
  botLifecycleKeys,
} from "@/lib/bot-lifecycle/queries";
import { deviceKeys } from "@/lib/devices/queries";
import {
  type MonthTaskRow,
  monthTaskStatsQueryOptions,
  runningTasksQueryOptions,
  type WakerGroup,
  wakerGroupKeys,
} from "@/lib/waker-groups/queries";
import {
  wakersBackLink,
  wakersReturnSearch,
} from "@/components/wakers/wakers-search";
import { Route as BotsRoute } from "@/routes/_authed/_app/bots.index";
import { seedQuietNeedsYou } from "./quiet-needs-you";
import { settleReactWork } from "./settle-react-work";

/**
 * M5b：员工墙并进了上游的员工页（`/bots`），卡片画在上游的分区里（你的员工、共享给你的……），排序在每个分区
 * 里面排；下面的断言跟着新地址和分区走。
 *
 * Parity plan F2, 员工管理 (`/management` in the reference, `/bots` here): the header's new
 * action, the 员工 / 群组 tabs mirrored to `?tab=groups`, the name/role search, the 运行状态 / 角色 /
 * 环境 / 排序 filters with a count, the card grid ending in a dashed create card, and the groups tab's
 * real empty state. Every filter lives in the address, so the detail page's back link lands on the
 * same narrowed wall.
 */
let registeredHere = false;
beforeAll(() => {
  if (!("document" in globalThis)) {
    GlobalRegistrator.register();
    registeredHere = true;
  }
});
afterAll(async () => {
  if (!registeredHere) return;
  await settleReactWork();
  GlobalRegistrator.unregister();
});
const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

const base: AgentProfile = {
  isolated: false,
  isolationActive: false,
  isolationOffReason: null,
  id: "agent-1",
  name: "Backend Engineer",
  title: "后端开发",
  roleDescription: "Owns schema changes.",
  avatarSeed: "a1",
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
};
const reviewer: AgentProfile = {
  ...base,
  id: "agent-2",
  name: "Code Reviewer",
  title: "代码评审",
  mine: false,
};
const analyst: AgentProfile = {
  ...base,
  id: "agent-3",
  name: "Atlas Analyst",
  title: "数据分析",
  mine: false,
};

const attentionRow = (agentId: string): BotAttention => ({
  agentId,
  name: agentId,
  questions: 0,
  approvals: 0,
  handoffs: 0,
  unread: 0,
  paused: true,
  notify: "all",
  items: 0,
  tasks: { needsInput: 0, ready: 0, failed: 0 },
});

const minutesAgo = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();

/** A month of board rows: Backend has 1 (an hour ago), Reviewer 3 (latest 5 min ago), Atlas none. */
const monthRows = [
  {
    id: "t1",
    executorAgentId: "agent-1",
    status: "done",
    updatedAt: minutesAgo(60),
  },
  {
    id: "t2",
    executorAgentId: "agent-2",
    status: "done",
    updatedAt: minutesAgo(5),
  },
  {
    id: "t3",
    executorAgentId: "agent-2",
    status: "failed",
    updatedAt: minutesAgo(600),
  },
  {
    id: "t4",
    executorAgentId: "agent-2",
    status: "done",
    updatedAt: minutesAgo(900),
  },
];

let client = new QueryClient();

function seed({
  agents = [base, reviewer, analyst],
  crews = [] as WakerGroup[],
  running = ["agent-1"],
  paused = ["agent-2"],
  tasks = monthRows as MonthTaskRow[] | null,
} = {}) {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(agentKeys.list(false), agents);
  client.setQueryData(agentKeys.list(true), []);
  client.setQueryData(wakerGroupKeys.list(), crews);
  // `GET /api/bots/attention` answers `{ bots, lastPingId }`; the cache holds the whole body.
  client.setQueryData(botLifecycleKeys.attention, {
    bots: paused.map(attentionRow),
    lastPingId: null,
  });
  client.setQueryData(
    runningTasksQueryOptions().queryKey,
    running.map((id) => ({
      id: `run-${id}`,
      executorAgentId: id,
      status: "running",
      deviceId: "d-1",
    })),
  );
  client.setQueryData(deviceKeys.list(), [
    {
      id: "row-d-1",
      deviceId: "d-1",
      name: "studio",
      platform: "macos",
      lastSeenAt: new Date().toISOString(),
      online: true,
    },
  ]);
  if (tasks) client.setQueryData(monthTaskStatsQueryOptions().queryKey, tasks);
  seedQuietNeedsYou(client);
}

function draw(entry = "/bots") {
  const root = createRootRoute({ component: () => <Outlet /> });
  const stub = (path: string) =>
    createRoute({
      getParentRoute: () => root,
      path,
      component: () => <p>stub {path}</p>,
    } as never);
  const router = createRouter({
    context: {},
    history: createMemoryHistory({ initialEntries: [entry] }),
    routeTree: root.addChildren([
      BotsRoute.update({
        getParentRoute: () => root,
        path: "/bots",
      } as never),
      stub("/bots/$agentId"),
      stub("/bots/$agentId/setup"),
      stub("/channel/new"),
      stub("/capabilities/roles"),
      stub("/tasks"),
      stub("/pipelines"),
      stub("/routines"),
      stub("/responsibilities"),
    ]),
  });
  const screen = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { screen, router };
}

/** The names on the wall, in the order the cards are drawn. */
const cardNames = (screen: ReturnType<typeof render>) =>
  screen
    .getAllByTestId("waker-card")
    .map((card) => card.querySelector("[data-card-name]")?.textContent);

/** The names in one section's grid (`yours`, `shared` …), in the order drawn. */
const sectionNames = (screen: ReturnType<typeof render>, section: string) =>
  [
    ...screen.container.querySelectorAll(
      `[data-testid=waker-grid][data-section=${section}] [data-testid=waker-card]`,
    ),
  ].map((card) => card.querySelector("[data-card-name]")?.textContent);

/** One section's grid. */
const gridOf = (screen: ReturnType<typeof render>, section: string) =>
  screen.container.querySelector(
    `[data-testid=waker-grid][data-section=${section}]`,
  ) as HTMLElement;

/** Choose an option in one of the toolbar's labelled native selects (「运行状态 全部 ▾」). */
async function pick(
  screen: ReturnType<typeof render>,
  label: string,
  option: string,
) {
  const user = userEvent.setup({ document });
  await user.selectOptions(
    screen.getByRole("combobox", { name: label }),
    option,
  );
}

test("the header names the page, and 员工 / 群组 is one tablist mirrored to ?tab=groups", async () => {
  seed();
  const { screen, router } = draw();
  await waitFor(() =>
    expect(screen.getByText("Backend Engineer")).toBeTruthy(),
  );

  expect(screen.getByRole("heading", { name: "员工" })).toBeTruthy();
  const tablist = screen.getByRole("tablist", { name: "员工与群组" });
  const tabs = within(tablist).getAllByRole("tab");
  // docs/design/ios-studio/04-员工管理.png: each side of the pill carries its count after the word.
  expect(tabs.map((tab) => tab.textContent?.replace(/\d+$/, ""))).toEqual([
    "员工",
    "群组",
  ]);
  expect(tabs[0]?.textContent).toBe("员工3");
  expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
  // The employees tab is the default, so it carries no parameter.
  expect(router.state.location.search).toEqual({});
  // On the employees tab the header's primary action creates an employee.
  const create = within(screen.getByTestId("wakers-header-actions"))
    .getByText("新建员工")
    .closest("a");
  expect(create?.getAttribute("href")).toBe("/bots?new=true");

  const user = userEvent.setup({ document });
  await user.click(tabs[1] as HTMLElement);
  await waitFor(() =>
    expect(router.state.location.search).toEqual({ tab: "groups" }),
  );
  // And on the groups tab it creates a group (the empty state offers the same button).
  expect(
    screen.getAllByRole("button", { name: "新建群组" }).length,
  ).toBeGreaterThanOrEqual(1);
  expect(screen.queryByText("新建员工")).toBeNull();

  // Keyboard: Left moves back to 员工 and drops the parameter.
  (screen.getByRole("tab", { name: /^群组/ }) as HTMLElement).focus();
  await user.keyboard("{ArrowLeft}");
  await waitFor(() => expect(router.state.location.search).toEqual({}));
  expect(
    screen.getByRole("tab", { name: /^员工/ }).getAttribute("aria-selected"),
  ).toBe("true");
});

test("a deep link to ?tab=groups opens the groups tab, whose empty state offers to create one", async () => {
  seed();
  const { screen } = draw("/bots?tab=groups");
  await waitFor(() =>
    expect(
      screen.getByRole("tab", { name: /^群组/ }).getAttribute("aria-selected"),
    ).toBe("true"),
  );
  const empty = screen.getByTestId("crews-empty");
  expect(within(empty).getByText("还没有群组")).toBeTruthy();
  expect(within(empty).getByText(/不授予任何权限/)).toBeTruthy();
  await userEvent.click(
    within(empty).getByRole("button", { name: "新建群组" }),
  );
  const dialog = await within(document.body).findByRole("dialog");
  expect(within(dialog).getByPlaceholderText("群组名称")).toBeTruthy();
});

test("groups are cards with their members, ending in a create card", async () => {
  seed({
    crews: [
      {
        id: "crew-1",
        name: "编程群组",
        description: "写代码和评审",
        members: [
          { agentId: "agent-1", position: 0 },
          { agentId: "agent-2", position: 1 },
        ],
      },
    ],
  });
  const { screen } = draw("/bots?tab=groups");
  const card = await screen.findByTestId("crew-card");
  expect(within(card).getByText("编程群组")).toBeTruthy();
  expect(within(card).getByText("写代码和评审")).toBeTruthy();
  expect(within(card).getByText("2 名员工")).toBeTruthy();
  expect(
    within(card).getByText("顺序：Backend Engineer → Code Reviewer"),
  ).toBeTruthy();
  const create = screen.getByTestId("crew-create-card");
  await userEvent.click(create);
  expect(await within(document.body).findByRole("dialog")).toBeTruthy();
});

test("every employee card shows status, environment, avatar, name, role, task count and last run", async () => {
  seed();
  const { screen } = draw();
  await waitFor(() =>
    expect(screen.getByText("Backend Engineer")).toBeTruthy(),
  );
  const cardNode = (name: string) =>
    screen
      .getAllByTestId("waker-card")
      .find((node) => node.textContent?.includes(name)) as HTMLElement;
  const card = (name: string) => within(cardNode(name));
  /*
   * docs/design/ios-studio/04-员工管理.png bolds each footer value, so 「任务数 1」 is a label and a
   * <b>: read the fact's whole text rather than one text node.
   */
  const fact = (name: string, key: "task-count" | "last-run") =>
    cardNode(name).querySelector(`[data-${key}]`)?.textContent ?? "";

  const backend = card("Backend Engineer");
  expect(backend.getByRole("img", { name: "Backend Engineer" })).toBeTruthy();
  expect(backend.getByText("在线")).toBeTruthy();
  expect(backend.getByText("后端开发")).toBeTruthy();
  expect(backend.getByText("设备：studio · 在线")).toBeTruthy();
  expect(fact("Backend Engineer", "task-count")).toBe("任务数 1");
  expect(fact("Backend Engineer", "last-run")).toStartWith("最近运行 ");
  expect(fact("Backend Engineer", "last-run")).toContain("1小时");

  const reviewerCard = card("Code Reviewer");
  expect(reviewerCard.getByText("暂停")).toBeTruthy();
  // Somebody else's coworker, nothing running on a machine: not on one of this person's devices.
  expect(reviewerCard.getByText("未绑定设备")).toBeTruthy();
  expect(fact("Code Reviewer", "task-count")).toBe("任务数 3");
  expect(fact("Code Reviewer", "last-run")).toContain("5分钟");

  // No board row this month: zero tasks, and no last run rather than a made-up one.
  expect(fact("Atlas Analyst", "task-count")).toBe("任务数 0");
  expect(fact("Atlas Analyst", "last-run")).toBe("最近运行 —");

  // The name opens the detail page; 进对话 and 装配 stay one tap away; the card link is focusable.
  const open = backend.getByRole("link", { name: "Backend Engineer" });
  expect(open.getAttribute("href")).toBe("/bots/agent-1");
  expect(open.className).toContain("focus-visible");
  expect(
    backend.getByRole("link", { name: "进对话" }).getAttribute("href"),
  ).toBe("/channel/new?agent=agent-1");
  expect(backend.getByRole("link", { name: "装配" }).getAttribute("href")).toBe(
    "/bots/agent-1/setup",
  );
  expect(
    backend.getByRole("button", { name: "暂停 Backend Engineer" }),
  ).toBeTruthy();
});

// docs/design/ios-studio/04-员工管理.png numbers the profiles from the first cell (PROFILE / 01), so
// the create card is the dashed slot AFTER the last profile — of 你的员工, the section new ones join.
test("the cell after the last profile is a dashed create card wired to the new-employee flow", async () => {
  seed();
  const { screen } = draw();
  await waitFor(() =>
    expect(screen.getByText("Backend Engineer")).toBeTruthy(),
  );
  const grid = gridOf(screen, "yours");
  const last = grid.lastElementChild as HTMLElement;
  expect(last.getAttribute("data-testid")).toBe("waker-create-card");
  expect(last.getAttribute("href")).toBe("/bots?new=true");
  expect(last.className).toContain("border-dashed");
  // One on the whole page.
  expect(
    screen.container.querySelectorAll("[data-testid=waker-create-card]"),
  ).toHaveLength(1);
});

test("the search narrows by name or role, and the count says how many of how many", async () => {
  seed();
  const { screen, router } = draw();
  await waitFor(() =>
    expect(screen.getByText("Backend Engineer")).toBeTruthy(),
  );
  expect(screen.getByTestId("waker-count").textContent).toBe("3 名员工");

  const user = userEvent.setup({ document });
  const box = screen.getByRole("searchbox", { name: "搜索名称或角色" });
  await user.type(box, "评审");
  await waitFor(() => expect(cardNames(screen)).toEqual(["Code Reviewer"]));
  expect(screen.getByTestId("waker-count").textContent).toBe("1 / 3 名员工");
  expect(router.state.location.search).toEqual({ q: "评审" });

  await user.clear(box);
  await user.type(box, "atlas");
  await waitFor(() => expect(cardNames(screen)).toEqual(["Atlas Analyst"]));

  await user.clear(box);
  await user.type(box, "没有这个人");
  await waitFor(() =>
    expect(screen.getByText("没有符合这个筛选条件的员工。")).toBeTruthy(),
  );
  // No match still offers the way out (in the toolbar and in the empty state), and no create card.
  expect(screen.getAllByRole("button", { name: "清除筛选" })).toHaveLength(2);
  expect(screen.queryByTestId("waker-create-card")).toBeNull();
});

test("运行状态, 角色 and 环境 narrow the wall and write themselves into the address", async () => {
  seed();
  const { screen, router } = draw();
  await waitFor(() =>
    expect(screen.getByText("Backend Engineer")).toBeTruthy(),
  );

  await pick(screen, "运行状态", "暂停 (1)");
  await waitFor(() => expect(cardNames(screen)).toEqual(["Code Reviewer"]));
  expect(router.state.location.search).toEqual({ status: "paused" });
  expect(screen.getByTestId("waker-count").textContent).toBe("1 / 3 名员工");

  await pick(screen, "运行状态", "全部");
  await pick(screen, "角色", "数据分析");
  await waitFor(() => expect(cardNames(screen)).toEqual(["Atlas Analyst"]));
  expect(router.state.location.search).toEqual({ role: "数据分析" });

  await pick(screen, "角色", "全部角色");
  await pick(screen, "环境", "本地");
  await waitFor(() => expect(cardNames(screen)).toEqual(["Backend Engineer"]));
  expect(router.state.location.search).toEqual({ env: "device" });
});

test("a deep link carries the filters, and 清除筛选 drops them", async () => {
  seed();
  const { screen, router } = draw("/bots?env=unbound&status=resting");
  await waitFor(() => expect(cardNames(screen)).toEqual(["Atlas Analyst"]));
  await userEvent.click(
    screen.getAllByRole("button", { name: "清除筛选" })[0] as HTMLElement,
  );
  await waitFor(() => expect(router.state.location.search).toEqual({}));
  expect(cardNames(screen)).toHaveLength(3);
});

/*
 * M5b：卡片分在上游的分区里，排序在每个分区里面排（你的员工永远在共享给你的前面，见下一条）。这里三位员工都放进
 * 「共享给你的」一节来比，排序本身的断言和员工墙时一样。
 */
test("排序 orders each section by name, by last run, or by task count", async () => {
  seed({ agents: [{ ...base, mine: false }, reviewer, analyst] });
  const { screen, router } = draw();
  await waitFor(() =>
    expect(screen.getByText("Backend Engineer")).toBeTruthy(),
  );
  // Default: the order the roster came in.
  expect(sectionNames(screen, "shared")).toEqual([
    "Backend Engineer",
    "Code Reviewer",
    "Atlas Analyst",
  ]);

  await pick(screen, "排序", "按名称");
  await waitFor(() =>
    expect(sectionNames(screen, "shared")).toEqual([
      "Atlas Analyst",
      "Backend Engineer",
      "Code Reviewer",
    ]),
  );
  expect(router.state.location.search).toEqual({ sort: "name" });

  await pick(screen, "排序", "按最近运行");
  await waitFor(() =>
    expect(sectionNames(screen, "shared")).toEqual([
      "Code Reviewer",
      "Backend Engineer",
      "Atlas Analyst",
    ]),
  );

  await pick(screen, "排序", "按任务数");
  await waitFor(() =>
    expect(sectionNames(screen, "shared")).toEqual([
      "Code Reviewer",
      "Backend Engineer",
      "Atlas Analyst",
    ]),
  );
  expect(router.state.location.search).toEqual({ sort: "tasks" });
});

test("sorting never moves a coworker out of its section: 你的员工 stay ahead of 共享给你的", async () => {
  seed();
  const { screen } = draw("/bots?sort=name");
  await waitFor(() =>
    expect(sectionNames(screen, "shared")).toEqual([
      "Atlas Analyst",
      "Code Reviewer",
    ]),
  );
  expect(cardNames(screen)).toEqual([
    "Backend Engineer",
    "Atlas Analyst",
    "Code Reviewer",
  ]);
});

test("a month read that fails says so once and shows — instead of counts", async () => {
  seed({ tasks: null });
  globalThis.fetch = (async () =>
    Response.json(
      { error: "nope" },
      { status: 500 },
    )) as unknown as typeof fetch;
  const { screen } = draw();
  await waitFor(() =>
    expect(screen.getByText(/任务数和最近运行读不到/)).toBeTruthy(),
  );
  // Each footer value is a <b> after its label (docs/design/ios-studio), so read the whole fact.
  const facts = (key: string) =>
    [...screen.container.querySelectorAll(`[data-${key}]`)].map(
      (node) => node.textContent,
    );
  expect(facts("task-count")).toEqual(["任务数 —", "任务数 —", "任务数 —"]);
  expect(facts("last-run")).toEqual(["最近运行 —", "最近运行 —", "最近运行 —"]);
  expect(screen.getByRole("button", { name: "重新读取" })).toBeTruthy();
});

/*
 * M5b：员工详情页（`/bots/$agentId`）由员工详情那一组重做，这里只钉住返回链接本身：它带着员工页上一次的地址
 * （筛选与排序），回到同一个筛好的名单。原用例经由旧的 `/wakers/$agentId` 页面点返回，那个地址现在只是重定向。
 */
test("the detail page's back link returns to the same filtered roster", async () => {
  seed();
  const { screen, router } = draw("/bots?q=%E8%AF%84%E5%AE%A1&sort=tasks");
  await waitFor(() => expect(cardNames(screen)).toEqual(["Code Reviewer"]));
  expect(wakersReturnSearch()).toEqual({ q: "评审", sort: "tasks" });

  await userEvent.click(screen.getByRole("link", { name: "Code Reviewer" }));
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/bots/agent-2"),
  );
  // What PageShell's back control on the detail page links to.
  const back = wakersBackLink();
  expect(back.to).toBe("/bots");
  expect(back.search).toEqual({ q: "评审", sort: "tasks" });
  await router.navigate(back as never);
  await waitFor(() => expect(router.state.location.pathname).toBe("/bots"));
  expect(router.state.location.search).toEqual({ q: "评审", sort: "tasks" });
  await waitFor(() => expect(cardNames(screen)).toEqual(["Code Reviewer"]));
  expect(
    (
      screen.getByRole("searchbox", {
        name: "搜索名称或角色",
      }) as HTMLInputElement
    ).value,
  ).toBe("评审");
});

/* M5b：上游名单里新加的东西 ------------------------------------------------------------------------- */

test("卡片 / 列表 is one segmented choice written to ?view=list; a row keeps status, environment and counts", async () => {
  seed();
  const { screen, router } = draw();
  await waitFor(() =>
    expect(screen.getByText("Backend Engineer")).toBeTruthy(),
  );
  const views = screen.getByRole("tablist", { name: "显示方式" });
  expect(
    within(views)
      .getAllByRole("tab")
      .map((tab) => tab.textContent),
  ).toEqual(["卡片", "列表"]);

  const user = userEvent.setup({ document });
  await user.click(within(views).getByRole("tab", { name: "列表" }));
  await waitFor(() =>
    expect(router.state.location.search).toEqual({ view: "list" }),
  );
  expect(screen.queryAllByTestId("waker-card")).toHaveLength(0);
  const rows = screen.getAllByTestId("waker-row");
  expect(rows.map((row) => row.getAttribute("href"))).toEqual([
    "/bots/agent-1",
    "/bots/agent-2",
    "/bots/agent-3",
  ]);
  // The same facts the card carries, in one line.
  expect(rows[0]?.textContent).toContain("在线 · 本地 · 任务数 1 · 最近运行");
  expect(rows[1]?.textContent).toContain("暂停 · 未绑定 · 任务数 3");
  // The toolbar narrows the rows the same way.
  await pick(screen, "运行状态", "暂停 (1)");
  await waitFor(() =>
    expect(
      screen.getAllByTestId("waker-row").map((row) => row.textContent),
    ).toEqual([expect.stringContaining("Code Reviewer")]),
  );
  expect(router.state.location.search).toEqual({
    view: "list",
    status: "paused",
  });
});

test("the person's 分身 leads 你的员工, pinned or not, wearing 个人分身", async () => {
  seed({
    agents: [
      base,
      { ...base, id: "avatar-1", name: "我的分身", pinned: true },
      reviewer,
    ],
  });
  client.setQueryData(avatarSourceKeys.state(), {
    agentId: "avatar-1",
    configuredAt: "2026-11-01T00:00:00.000Z",
    sources: [],
  });
  const { screen } = draw();
  await waitFor(() => expect(screen.getByText("我的分身")).toBeTruthy());
  expect(sectionNames(screen, "yours")).toEqual([
    "我的分身",
    "Backend Engineer",
  ]);
  // Not under 已置顶: the 分身 is the person, not one more coworker to arrange.
  expect(screen.queryByRole("heading", { name: "已置顶" })).toBeNull();
  const card = screen
    .getAllByTestId("waker-card")
    .find((node) => node.textContent?.includes("我的分身")) as HTMLElement;
  expect(within(card).getByText("个人分身")).toBeTruthy();
});

test("a coworker shared with the person sits under 共享给你的, copies its link, and an assigned one says so", async () => {
  seed({ agents: [base, { ...reviewer, assignedToMe: true }, analyst] });
  const { screen } = draw();
  await waitFor(() => expect(screen.getByText("Atlas Analyst")).toBeTruthy());
  // What the archived 团队 Bot page said about every shared conversation.
  expect(screen.getByText(/你和它的每段对话只属于你/)).toBeTruthy();
  expect(sectionNames(screen, "shared")).toEqual(["Atlas Analyst"]);
  // An administrator assigned it: pinned, and tagged as such.
  expect(sectionNames(screen, "pinned")).toEqual(["Code Reviewer"]);
  const assigned = screen
    .getAllByTestId("waker-card")
    .find((node) => node.textContent?.includes("Code Reviewer")) as HTMLElement;
  expect(assigned.querySelector("[data-assigned]")?.textContent).toBe(
    "已分配给你",
  );
  // Shared ones copy the link a teammate opens to start their own chat; your own do not.
  expect(
    screen.getByRole("button", { name: "复制 Atlas Analyst 的链接" }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "复制 Backend Engineer 的链接" }),
  ).toBeNull();
});

test("a group card opens its board and 组团流程", async () => {
  seed({
    crews: [
      {
        id: "crew-1",
        name: "编程群组",
        description: null,
        members: [{ agentId: "agent-1", position: 0 }],
      },
    ],
  });
  const { screen } = draw("/bots?tab=groups");
  const card = await screen.findByTestId("crew-card");
  expect(
    within(card).getByRole("link", { name: "组团流程" }).getAttribute("href"),
  ).toBe("/pipelines");
  expect(
    within(card).getByRole("link", { name: "在看板上看" }).getAttribute("href"),
  ).toBe("/tasks?crew=agent-1");
});
