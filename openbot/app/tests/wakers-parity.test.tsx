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
import { Route as WakersRoute } from "@/routes/_authed/_app/wakers";
import { Route as WakerDetailRoute } from "@/routes/_authed/_app/wakers_.$agentId";
import { settleReactWork } from "./settle-react-work";

/**
 * Parity plan F2, 员工管理 (`/management` in the reference, `/wakers` here): the header's new
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
}

function draw(entry = "/wakers") {
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
      WakersRoute.update({
        getParentRoute: () => root,
        path: "/wakers",
      } as never),
      WakerDetailRoute.update({
        getParentRoute: () => root,
        path: "/wakers/$agentId",
      } as never),
      stub("/bots/$agentId"),
      stub("/assemble/$agentId"),
      stub("/channel/new"),
      stub("/role-templates"),
      stub("/tasks"),
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

  expect(screen.getByRole("heading", { name: "员工管理" })).toBeTruthy();
  const tablist = screen.getByRole("tablist", { name: "员工与群组" });
  const tabs = within(tablist).getAllByRole("tab");
  expect(tabs.map((tab) => tab.textContent)).toEqual(["员工", "群组"]);
  expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
  // The employees tab is the default, so it carries no parameter.
  expect(router.state.location.search).toEqual({});
  // On the employees tab the header's primary action creates an employee.
  const create = within(screen.getByTestId("wakers-header-actions"))
    .getByText("新建员工")
    .closest("a");
  expect(create?.getAttribute("href")).toBe("/wakers?new=true");

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
  (screen.getByRole("tab", { name: "群组" }) as HTMLElement).focus();
  await user.keyboard("{ArrowLeft}");
  await waitFor(() => expect(router.state.location.search).toEqual({}));
  expect(
    screen.getByRole("tab", { name: "员工" }).getAttribute("aria-selected"),
  ).toBe("true");
});

test("a deep link to ?tab=groups opens the groups tab, whose empty state offers to create one", async () => {
  seed();
  const { screen } = draw("/wakers?tab=groups");
  await waitFor(() =>
    expect(
      screen.getByRole("tab", { name: "群组" }).getAttribute("aria-selected"),
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
  const { screen } = draw("/wakers?tab=groups");
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
  const card = (name: string) =>
    within(
      screen
        .getAllByTestId("waker-card")
        .find((node) => node.textContent?.includes(name)) as HTMLElement,
    );

  const backend = card("Backend Engineer");
  expect(backend.getByRole("img", { name: "Backend Engineer" })).toBeTruthy();
  expect(backend.getByText("在线")).toBeTruthy();
  expect(backend.getByText("后端开发")).toBeTruthy();
  expect(backend.getByText("设备：studio · 在线")).toBeTruthy();
  expect(backend.getByText("任务数 1")).toBeTruthy();
  expect(backend.getByText(/^最近运行 /).textContent).toContain("1小时");

  const reviewerCard = card("Code Reviewer");
  expect(reviewerCard.getByText("暂停")).toBeTruthy();
  // Somebody else's coworker, nothing running on a machine: not on one of this person's devices.
  expect(reviewerCard.getByText("未绑定设备")).toBeTruthy();
  expect(reviewerCard.getByText("任务数 3")).toBeTruthy();
  expect(reviewerCard.getByText(/^最近运行 /).textContent).toContain("5分钟");

  // No board row this month: zero tasks, and no last run rather than a made-up one.
  const atlas = card("Atlas Analyst");
  expect(atlas.getByText("任务数 0")).toBeTruthy();
  expect(atlas.getByText("最近运行 —")).toBeTruthy();

  // The name opens the detail page; 进对话 and 装配 stay one tap away; the card link is focusable.
  const open = backend.getByRole("link", { name: "Backend Engineer" });
  expect(open.getAttribute("href")).toBe("/wakers/agent-1");
  expect(open.className).toContain("focus-visible");
  expect(
    backend.getByRole("link", { name: "进对话" }).getAttribute("href"),
  ).toBe("/channel/new?agent=agent-1");
  expect(backend.getByRole("link", { name: "装配" }).getAttribute("href")).toBe(
    "/assemble/agent-1",
  );
  expect(
    backend.getByRole("button", { name: "暂停 Backend Engineer" }),
  ).toBeTruthy();
});

// The reference puts the create card FIRST (docs/acceptance/qoderwake-reference/wakers.png).
test("the first cell is a dashed create card wired to the new-employee flow", async () => {
  seed();
  const { screen } = draw();
  await waitFor(() =>
    expect(screen.getByText("Backend Engineer")).toBeTruthy(),
  );
  const grid = screen.getByTestId("waker-grid");
  const first = grid.firstElementChild as HTMLElement;
  expect(first.getAttribute("data-testid")).toBe("waker-create-card");
  expect(first.getAttribute("href")).toBe("/wakers?new=true");
  expect(first.className).toContain("border-dashed");
  expect(grid.querySelectorAll("[data-testid=waker-create-card]")).toHaveLength(
    1,
  );
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
  const { screen, router } = draw("/wakers?env=unbound&status=resting");
  await waitFor(() => expect(cardNames(screen)).toEqual(["Atlas Analyst"]));
  await userEvent.click(
    screen.getAllByRole("button", { name: "清除筛选" })[0] as HTMLElement,
  );
  await waitFor(() => expect(router.state.location.search).toEqual({}));
  expect(cardNames(screen)).toHaveLength(3);
});

test("排序 orders the wall by name, by last run, or by task count", async () => {
  seed();
  const { screen, router } = draw();
  await waitFor(() =>
    expect(screen.getByText("Backend Engineer")).toBeTruthy(),
  );
  // Default: the order the roster came in.
  expect(cardNames(screen)).toEqual([
    "Backend Engineer",
    "Code Reviewer",
    "Atlas Analyst",
  ]);

  await pick(screen, "排序字段", "按名称");
  await waitFor(() =>
    expect(cardNames(screen)).toEqual([
      "Atlas Analyst",
      "Backend Engineer",
      "Code Reviewer",
    ]),
  );
  expect(router.state.location.search).toEqual({ sort: "name" });

  await pick(screen, "排序字段", "按最近运行");
  await waitFor(() =>
    expect(cardNames(screen)).toEqual([
      "Code Reviewer",
      "Backend Engineer",
      "Atlas Analyst",
    ]),
  );

  await pick(screen, "排序字段", "按任务数");
  await waitFor(() =>
    expect(cardNames(screen)).toEqual([
      "Code Reviewer",
      "Backend Engineer",
      "Atlas Analyst",
    ]),
  );
  expect(router.state.location.search).toEqual({ sort: "tasks" });
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
  expect(screen.getAllByText("任务数 —")).toHaveLength(3);
  expect(screen.getAllByText("最近运行 —")).toHaveLength(3);
  expect(screen.getByRole("button", { name: "重新读取" })).toBeTruthy();
});

test("the detail page's back link returns to the same filtered wall", async () => {
  seed();
  client.setQueryData(agentKeys.detail("agent-2"), reviewer);
  globalThis.fetch = (async () =>
    Response.json(
      { error: "not faked" },
      { status: 404 },
    )) as unknown as typeof fetch;
  const { screen, router } = draw("/wakers?q=%E8%AF%84%E5%AE%A1&sort=tasks");
  await waitFor(() => expect(cardNames(screen)).toEqual(["Code Reviewer"]));

  await userEvent.click(screen.getByRole("link", { name: "Code Reviewer" }));
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/wakers/agent-2"),
  );
  // PageShell's back control, drawn as an anchor.
  const back = (await screen.findByText("员工管理")).closest("a");
  expect(back?.getAttribute("href")).toBe(
    "/wakers?q=%E8%AF%84%E5%AE%A1&sort=tasks",
  );
  await userEvent.click(back as HTMLElement);
  await waitFor(() => expect(router.state.location.pathname).toBe("/wakers"));
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
