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
 * 员工管理 against the reference screenshot (docs/acceptance/qoderwake-reference/wakers.png): the
 * subtitle under the title, the boxed 员工 | 群组 pill at the reference's 218×33, a toolbar of a
 * search box and four labelled filters with the count at the far right, and a grid of fixed 330px
 * cards that STARTS with the create card. Each employee card is centred: avatar on top, status and
 * environment at the top right, name with a role tag, one description line, and a 任务数 | 最近运行
 * footer — its actions kept reachable in a row that hover or keyboard focus reveals.
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
  client.setQueryData(botLifecycleKeys.attention, [
    attentionRow("agent-avatar", { questions: 2 }),
  ]);
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

test("the header carries the subtitle, 角色模板 beside the primary 新建员工, and the pill tabs at the reference's size", async () => {
  seed();
  const { screen } = draw();
  await screen.findByText("Code Reviewer");

  expect(screen.getByRole("heading", { name: "员工管理" })).toBeTruthy();
  expect(
    screen.getByText("选择员工开始任务，或者新建一个开始工作。"),
  ).toBeTruthy();
  const header = screen.getByTestId("wakers-header-actions");
  // Real anchors (the shared Button draws them with role="button").
  const links = [...header.querySelectorAll("a")];
  expect(links.map((link) => link.textContent)).toEqual([
    "角色模板",
    "新建员工",
  ]);
  expect(links[1]?.getAttribute("href")).toBe("/wakers?new=true");
  expect(links[0]?.getAttribute("href")).toBe("/role-templates");
  // The primary action draws its plus sign as an icon, not as text.
  expect(links[1]?.querySelector("svg")).not.toBeNull();

  const tablist = screen.getByRole("tablist", { name: "员工与群组" });
  expect(tablist.getAttribute("data-variant")).toBe("pill");
  expect(tablist.className).toContain("w-[218px]");
  expect(tablist.className).toContain("h-[33px]");
});

test("the toolbar is a search box, four labelled filters and the count at the far right", async () => {
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
    ["排序字段", "默认排序"],
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

test("the grid is fixed 330px cards, and the create card comes FIRST with its own illustration", async () => {
  seed();
  const { screen } = draw();
  await screen.findByText("Code Reviewer");

  const grid = screen.getByTestId("waker-grid");
  expect(grid.className).toContain("330px");
  const first = grid.firstElementChild as HTMLElement;
  expect(first.getAttribute("data-testid")).toBe("waker-create-card");
  expect(first.getAttribute("href")).toBe("/wakers?new=true");
  expect(first.textContent).toContain("新建员工");
  expect(first.querySelector("[data-create-illustration]")).not.toBeNull();
  // Then the employees, in the roster's order.
  expect(
    [...grid.children]
      .slice(1)
      .map((card) => card.querySelector("[data-card-name]")?.textContent),
  ).toEqual(["我的分身", "Code Reviewer"]);
});

test("an employee card is centred: avatar, status + environment, name + role tag, one line, and a 任务数 | 最近运行 footer", async () => {
  seed();
  const { screen } = draw();
  await screen.findByText("Code Reviewer");

  const avatar = cardOf(screen, "我的分身");
  const own = within(avatar);
  expect(own.getByRole("img", { name: "我的分身" }).style.width).toBe("48px");
  expect(own.getByText("在线").getAttribute("data-status")).toBe("working");
  const env = avatar.querySelector("[data-env-tag]");
  expect(env?.textContent).toBe("本地");
  expect(env?.getAttribute("data-env-tag")).toBe("device");
  // The person's own 分身 wears 个人分身, not its title.
  expect(own.getByText("个人分身").hasAttribute("data-role-tag")).toBe(true);
  expect(
    own.getByText("选择你的信息来源，为个人分身完成输入配置。"),
  ).toBeTruthy();
  const footer = avatar.querySelector("[data-card-footer]") as HTMLElement;
  expect(within(footer).getByText("任务数 1")).toBeTruthy();
  expect(within(footer).getByText(/^最近运行 /).textContent).toContain("1小时");

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
  expect(other.getByText("任务数 0")).toBeTruthy();
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

test("the groups tab uses the same grid: create card first, then centred group cards with member avatars", async () => {
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
  expect(grid.className).toContain("330px");
  expect(grid.firstElementChild?.getAttribute("data-testid")).toBe(
    "crew-create-card",
  );
  expect(
    within(grid.firstElementChild as HTMLElement).getByText("新建群组"),
  ).toBeTruthy();
  expect(within(card).getAllByRole("img")).toHaveLength(2);
  expect(within(card).getByText("编程群组")).toBeTruthy();
  expect(
    within(card).getByText("2 名员工").closest("[data-card-footer]"),
  ).not.toBeNull();
});
