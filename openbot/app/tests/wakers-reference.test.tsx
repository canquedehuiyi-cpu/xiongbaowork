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
import { Route as WakersRoute } from "@/routes/_authed/_app/wakers";
import { settleReactWork } from "./settle-react-work";

/**
 * 员工管理 against docs/design/ios-studio/04-员工管理.png (numbers from its theme.css): the
 * `04 DIGITAL TEAM` eyebrow and the subtitle under the title, 角色模板 beside the primary 新建员工,
 * the 员工 N | 群组 N pill with the 「N 名员工」 badge at the far right of its row, a toolbar of a
 * search box and four labelled filters, and a three-column grid of 「角色档案」 cards — a mono
 * `PROFILE / 01` index, a status badge (「● 在线 · 本地」), a 44px face beside the name and one line
 * of role, one description line and a 任务数 · 最近运行 footer — with the dashed create card after
 * the last profile. The person's own 分身 wears the page's one local red. Each card's actions stay
 * reachable in a row that hover or keyboard focus reveals.
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
afterEach(() => cleanup());

const base: AgentProfile = {
  isolated: false,
  isolationActive: false,
  isolationOffReason: null,
  id: "agent-avatar",
  name: "我的分身",
  title: "助理",
  roleDescription: "选择你的信息来源，为个人分身完成输入配置。",
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
  roleDescription: "",
  mine: false,
};

const attentionRow = (
  agentId: string,
  over: Partial<BotAttention> = {},
): BotAttention => ({
  agentId,
  name: agentId,
  questions: 0,
  approvals: 0,
  handoffs: 0,
  unread: 0,
  paused: false,
  notify: "all",
  items: 0,
  tasks: { needsInput: 0, ready: 0, failed: 0 },
  ...over,
});

let client = new QueryClient();

function seed({ crews = [] as WakerGroup[] } = {}) {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(agentKeys.list(false), [base, reviewer]);
  client.setQueryData(agentKeys.list(true), []);
  client.setQueryData(wakerGroupKeys.list(), crews);
  // `GET /api/bots/attention` answers `{ bots, lastPingId }`; the cache holds the whole body.
  client.setQueryData(botLifecycleKeys.attention, {
    bots: [attentionRow("agent-avatar", { questions: 2 })],
    lastPingId: null,
  });
  client.setQueryData(runningTasksQueryOptions().queryKey, [
    {
      id: "run-1",
      executorAgentId: "agent-avatar",
      status: "running",
      deviceId: "d-1",
    },
  ]);
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
  client.setQueryData(monthTaskStatsQueryOptions().queryKey, [
    {
      id: "t1",
      executorAgentId: "agent-avatar",
      status: "done",
      updatedAt: new Date(Date.now() - 3_600_000).toISOString(),
    },
  ] as MonthTaskRow[]);
  client.setQueryData(avatarSourceKeys.state(), {
    agentId: "agent-avatar",
    configuredAt: "2026-11-01T00:00:00.000Z",
    sources: [],
  });
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
      stub("/wakers/$agentId"),
      stub("/assemble/$agentId"),
      stub("/channel/new"),
      stub("/role-templates"),
      stub("/tasks"),
    ]),
  });
  const screen = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { screen, router };
}

const cardOf = (screen: ReturnType<typeof render>, name: string) =>
  screen
    .getAllByTestId("waker-card")
    .find(
      (card) => card.querySelector("[data-card-name]")?.textContent === name,
    ) as HTMLElement;

test("the header carries the eyebrow and subtitle, 角色模板 beside the primary 新建员工, and the pill tabs with their counts", async () => {
  seed();
  const { screen } = draw();
  await screen.findByText("Code Reviewer");

  expect(screen.getByRole("heading", { name: "员工管理" })).toBeTruthy();
  expect(
    screen.getByText("选择合适的员工开始任务，或为团队新建一位员工。"),
  ).toBeTruthy();
  expect(
    screen.container.querySelector("[data-slot=eyebrow]")?.textContent,
  ).toBe("04DIGITAL TEAM");
  const header = screen.getByTestId("wakers-header-actions");
  // Real anchors (the shared Button draws them with role="button").
  const links = [...header.querySelectorAll("a")];
  expect(links.map((link) => link.textContent)).toEqual([
    "角色模板",
    "新建员工",
  ]);
  expect(links[1]?.getAttribute("href")).toBe("/wakers?new=true");
  expect(links[0]?.getAttribute("href")).toBe("/role-templates");
  // Both draw their glyph as an icon, not as text: layers for 角色模板, a plus for 新建员工.
  expect(links[0]?.querySelector("svg")).not.toBeNull();
  expect(links[1]?.querySelector("svg")).not.toBeNull();

  const tablist = screen.getByRole("tablist", { name: "员工与群组" });
  expect(tablist.getAttribute("data-variant")).toBe("pill");
  // 「员工 2」「群组 0」: each side says how many it holds once its read answered.
  expect(
    within(tablist)
      .getAllByRole("tab")
      .map((tab) => tab.textContent),
  ).toEqual(["员工2", "群组0"]);
  // The 「N 名员工」 badge sits on the pill's row, at its far right.
  expect(screen.getByTestId("waker-count").parentElement).toBe(
    tablist.parentElement,
  );
});

test("the toolbar is a search box and four labelled filters, with the count on the pill's row", async () => {
  seed();
  const { screen, router } = draw();
  await screen.findByText("Code Reviewer");

  const search = screen.getByRole("searchbox", { name: "搜索名称或角色" });
  expect(search.getAttribute("placeholder")).toBe("搜索名称或角色...");
  expect(search.closest("[data-slot=search-box]")).not.toBeNull();

  const filters = [
    ...screen.container.querySelectorAll("[data-slot=labeled-select]"),
  ];
  expect(
    filters.map((filter) => {
      const select = filter.querySelector("select") as HTMLSelectElement;
      return [
        filter.querySelector("span")?.textContent,
        select.selectedOptions[0]?.textContent,
      ];
    }),
  ).toEqual([
    ["运行状态", "全部"],
    ["角色", "全部角色"],
    ["环境", "全部环境"],
    ["排序", "默认排序"],
  ]);
  expect(screen.getByTestId("waker-count").textContent).toBe("2 名员工");

  // The native select still writes the address.
  const user = userEvent.setup({ document });
  await user.selectOptions(
    screen.getByRole("combobox", { name: "环境" }),
    "本地",
  );
  await waitFor(() =>
    expect(router.state.location.search).toEqual({ env: "device" }),
  );
});

test("the grid is three columns (two at 1150px, one at 440px) of numbered profiles, then the create card", async () => {
  seed();
  const { screen } = draw();
  await screen.findByText("Code Reviewer");

  const grid = screen.getByTestId("waker-grid");
  // theme.css `.staff-grid` and its two breakpoints.
  expect(grid.className).toContain("min-[1151px]:grid-cols-3");
  expect(grid.className).toContain("min-[441px]:grid-cols-2");
  expect(grid.className).toContain("grid-cols-1");
  // The employees in the roster's order, numbered as drawn.
  const cards = [...grid.children].slice(0, -1);
  expect(
    cards.map((card) => card.querySelector("[data-card-name]")?.textContent),
  ).toEqual(["我的分身", "Code Reviewer"]);
  expect(
    cards.map((card) => card.querySelector("[data-card-index]")?.textContent),
  ).toEqual(["Profile / 01", "Profile / 02"]);
  // The index is wayfinding, not something a screen reader should read out.
  expect(
    cards[0]?.querySelector("[data-card-index]")?.getAttribute("aria-hidden"),
  ).toBe("true");
  // Then the dashed create card, laid out as one more profile.
  const last = grid.lastElementChild as HTMLElement;
  expect(last.getAttribute("data-testid")).toBe("waker-create-card");
  expect(last.getAttribute("href")).toBe("/wakers?new=true");
  expect(last.className).toContain("border-dashed");
  expect(last.textContent).toContain("新建员工");
});

test("an employee card is a profile: status · environment badge, 44px face beside name and role, one line, and a 任务数 · 最近运行 footer", async () => {
  seed();
  const { screen } = draw();
  await screen.findByText("Code Reviewer");

  const avatar = cardOf(screen, "我的分身");
  const own = within(avatar);
  expect(own.getByRole("img", { name: "我的分身" }).style.width).toBe("44px");
  expect(own.getByText("在线").getAttribute("data-status")).toBe("working");
  const env = avatar.querySelector("[data-env-tag]");
  expect(env?.textContent).toBe("本地");
  expect(env?.getAttribute("data-env-tag")).toBe("device");
  // The person's own 分身 wears 个人分身, not its title.
  expect(own.getByText("个人分身").hasAttribute("data-role-tag")).toBe(true);
  expect(
    own.getByText("选择你的信息来源，为个人分身完成输入配置。"),
  ).toBeTruthy();
  // The status and the environment share one badge: 「● 在线 · 本地」.
  expect(env?.parentElement).toBe(
    own.getByText("在线").parentElement as HTMLElement,
  );
  // The person's own 分身 is the card that wears the local red (theme.css `.staff-card.personal`).
  expect(avatar.hasAttribute("data-personal")).toBe(true);
  expect(avatar.className).toContain("border-signal/25");
  // Each footer value is bold after its label, so the fact is read whole.
  const footer = avatar.querySelector("[data-card-footer]") as HTMLElement;
  expect(footer.querySelector("[data-task-count]")?.textContent).toBe(
    "任务数 1",
  );
  expect(footer.querySelector("[data-task-count] b")?.textContent).toBe("1");
  expect(footer.querySelector("[data-last-run]")?.textContent).toContain(
    "1小时",
  );

  const other = within(cardOf(screen, "Code Reviewer"));
  expect(other.getByText("代码评审").hasAttribute("data-role-tag")).toBe(true);
  expect(
    cardOf(screen, "Code Reviewer")
      .querySelector("[data-env-tag]")
      ?.getAttribute("data-env-tag"),
  ).toBe("unbound");
  expect(
    cardOf(screen, "Code Reviewer").querySelector("[data-env-tag]")
      ?.textContent,
  ).toBe("未绑定");
  expect(
    cardOf(screen, "Code Reviewer").querySelector("[data-task-count]")
      ?.textContent,
  ).toBe("任务数 0");
  // Everyone else's card is plain graphite.
  expect(cardOf(screen, "Code Reviewer").hasAttribute("data-personal")).toBe(
    false,
  );
});

test("a card's actions and attention line sit in a row revealed on hover or keyboard focus", async () => {
  seed();
  const { screen } = draw();
  await screen.findByText("Code Reviewer");
  const card = cardOf(screen, "我的分身");

  const row = card.querySelector("[data-card-actions]") as HTMLElement;
  expect(row).not.toBeNull();
  // Hidden until the card is hovered or anything in it has focus, so the face stays clean.
  expect(row.className).toContain("opacity-0");
  expect(row.className).toContain("group-hover/card:opacity-100");
  expect(row.className).toContain("group-focus-within/card:opacity-100");
  const actions = within(row);
  expect(actions.getByRole("button", { name: "暂停 我的分身" })).toBeTruthy();
  expect(actions.getByRole("link", { name: "进对话" })).toBeTruthy();
  expect(actions.getByRole("link", { name: "装配" })).toBeTruthy();
  expect(actions.getByRole("link", { name: "编辑 我的分身" })).toBeTruthy();
  expect(row.querySelector("[data-attention]")?.textContent).toContain(
    "2 个提问",
  );
  // The card face still flags that something waits, without the sentence.
  expect(
    card.querySelector("[data-attention-dot]")?.getAttribute("aria-hidden"),
  ).toBe("true");

  // Tabbing from the card's link lands in the revealed row.
  const user = userEvent.setup({ document });
  (card.querySelector("[data-card-name]") as HTMLElement).focus();
  await user.tab();
  expect(row.contains(document.activeElement)).toBe(true);
});

test("the groups tab uses the same grid and card: GROUP / 01 profiles with member faces, then the create card", async () => {
  seed({
    crews: [
      {
        id: "crew-1",
        name: "编程群组",
        description: "写代码和评审",
        members: [
          { agentId: "agent-avatar", position: 0 },
          { agentId: "agent-2", position: 1 },
        ],
      },
    ],
  });
  const { screen } = draw("/wakers?tab=groups");
  const card = await screen.findByTestId("crew-card");
  const grid = card.parentElement as HTMLElement;
  expect(grid.className).toContain("min-[1151px]:grid-cols-3");
  expect(grid.lastElementChild?.getAttribute("data-testid")).toBe(
    "crew-create-card",
  );
  expect(
    within(grid.lastElementChild as HTMLElement).getByText("新建群组"),
  ).toBeTruthy();
  expect(card.querySelector("[data-card-index]")?.textContent).toBe(
    "Group / 01",
  );
  expect(within(card).getAllByRole("img")).toHaveLength(2);
  expect(within(card).getByText("编程群组")).toBeTruthy();
  expect(
    within(card).getByText("2 名员工").closest("[data-card-footer]"),
  ).not.toBeNull();
});

test("the 员工 / 群组 tabs control a labelled panel; arrows replace history, a click pushes it", async () => {
  const { screen, router } = draw();
  const tabs = await screen.findByRole("tablist", { name: "员工与群组" });
  const user = userEvent.setup({ document });
  // Each tab's name is its word and then its count (「员工 2」), as the design's pill draws it.
  const coworkers = within(tabs).getByRole("tab", { name: /^员工/ });
  expect(coworkers.getAttribute("aria-controls")).toBe("wakers-wall");
  expect(screen.getByRole("tabpanel", { name: /^员工/ })).toBeTruthy();

  const before = router.history.length;
  coworkers.focus();
  await user.keyboard("{ArrowRight}");
  await waitFor(() =>
    expect(router.state.location.search).toEqual({ tab: "groups" }),
  );
  expect(router.history.length).toBe(before);
  expect(screen.getByRole("tabpanel", { name: /^群组/ })).toBeTruthy();

  await user.click(within(tabs).getByRole("tab", { name: /^员工/ }));
  await waitFor(() => expect(router.state.location.search).toEqual({}));
  expect(router.history.length).toBe(before + 1);
});

test("an empty roster is the workbench empty state with its own way to create one, not a bare grid", async () => {
  seed();
  client.setQueryData(agentKeys.list(false), []);
  const { screen } = draw();
  const empty = await screen.findByTestId("wakers-empty");
  // docs/design/ios-studio `.empty`: the mascot, a bold title, one line, and the action.
  expect(within(empty).getByText("这里还没有员工")).toBeTruthy();
  const create = within(empty).getByRole("button", { name: "新建员工" });
  expect(create.getAttribute("href")).toBe("/wakers?new=true");
  expect(screen.queryByTestId("waker-grid")).toBeNull();
  // An answered roster of none is a count of none.
  expect(screen.getByTestId("waker-count").textContent).toBe("0 名员工");
});
