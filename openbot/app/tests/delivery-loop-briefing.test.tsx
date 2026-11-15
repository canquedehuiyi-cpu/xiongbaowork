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
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkHoursSection } from "@/components/settings/work-hours";
import { agentKeys } from "@/lib/agents/queries";
import { authKeys } from "@/lib/auth/queries";
import { browserTimeZone } from "@/lib/routines/form";
import { userPreferencesQueryOptions } from "@/lib/settings/message-list";
import { briefingKindAt, hourIn } from "@/lib/tasks/delivery";
import { Route as BriefingRoute } from "@/routes/_authed/_app/briefing";
import { Route as TasksRoute } from "@/routes/_authed/_app/tasks";
import { Route as TaskDetailRoute } from "@/routes/_authed/_app/tasks.$taskId";
import { setSkin } from "@/skins/store";
import { GoalBody } from "@/skins/xiongbao/conversation-sidebar/goal";
import type { SidebarGoal } from "../../shared/conversation-sidebar";
import { settleReactWork } from "./settle-react-work";

/**
 * 交付闭环第三期 Task 10（规格第 10、12 节，设计稿 4、5、6）：「我」→ 通知里的作息能保存、回显，第一次打开时
 * 把浏览器的时区告诉服务器；清点页的数字和 `/api/me/briefing` 一致，没有清点时说清楚；开工还是收工清点按
 * 作息的时区选；看板清点条的「逐件看」到清点页；逾期卡详情在手机宽度下是设计稿 5 的四个按钮和「服务器替你
 * 盯着」的经过；侧栏「目标」的四段进度按 `stage` 着色。走真的文件路由，只换掉 fetch。
 */
let registeredHere = false;
const originalFetch = globalThis.fetch;
const originalWidth = globalThis.innerWidth;

beforeAll(() => {
  if (!("document" in globalThis)) {
    GlobalRegistrator.register();
    registeredHere = true;
  }
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: originalWidth,
  });
  setSkin("xiongbao");
});

afterAll(async () => {
  if (!registeredHere) return;
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const MINUTE = 60_000;
const NOW = Date.now();
const ago = (minutes: number) => new Date(NOW - minutes * MINUTE).toISOString();
const later = (minutes: number) =>
  new Date(NOW + minutes * MINUTE).toISOString();

const XIAOZHOU = { id: "agent-zhou", name: "小周", avatarSeed: "zhou" };

type Call = { method: string; path: string; body: unknown };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });

const workHours = (over: Record<string, unknown> = {}) => ({
  start: "09:00",
  end: "18:00",
  timeZone: "Asia/Shanghai",
  weekends: false,
  ...over,
});

const preferences = (hours: Record<string, unknown>) => ({
  messageListEmphasis: "thread",
  selfHostBannerDismissed: false,
  narration: null,
  skin: "xiongbao",
  proactive: "on",
  workHours: hours,
});

// ---------------------------------------------------------------- 作息

test("作息：第一次打开把浏览器时区告诉服务器，改了保存后回显服务器存下的", async () => {
  const calls: Call[] = [];
  let stored = workHours();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: String(input), body });
    if (method === "PATCH") {
      // 服务器只在没存过时区时收下浏览器的；这里已存过，所以只合并作息。
      if (body.workHours) stored = { ...stored, ...body.workHours };
      return json({ preferences: preferences(stored) });
    }
    return json({ preferences: preferences(stored) });
  }) as typeof fetch;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(authKeys.currentUser(), { id: "user-hours-1" });
  queryClient.setQueryData(
    userPreferencesQueryOptions("user-hours-1").queryKey,
    preferences(stored) as never,
  );
  const view = render(
    <QueryClientProvider client={queryClient}>
      <WorkHoursSection />
    </QueryClientProvider>,
  );

  await waitFor(() =>
    expect(calls.filter((call) => call.method === "PATCH")).toEqual([
      {
        method: "PATCH",
        path: "/api/settings/preferences",
        body: { browserTimeZone: browserTimeZone() },
      },
    ]),
  );
  expect(view.getByTestId("work-hours-now").textContent).toBe(
    "现在：工作日 09:00–18:00，按 Asia/Shanghai 的时间。",
  );
  const save = view.getByRole("button", { name: "保存作息" });
  // 什么都没改时不能保存。
  expect((save as HTMLButtonElement).disabled).toBe(true);

  // 收工早于开工：先拦住，不发请求。
  fireEvent.change(view.getByLabelText("开工时间"), {
    target: { value: "19:00" },
  });
  await userEvent.click(save);
  expect(view.getByRole("alert").textContent).toBe(
    "开工时间要早于收工时间（同一天内）。",
  );
  expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(1);

  fireEvent.change(view.getByLabelText("开工时间"), {
    target: { value: "08:30" },
  });
  fireEvent.change(view.getByLabelText("收工时间"), {
    target: { value: "17:30" },
  });
  await userEvent.click(view.getByRole("switch", { name: "周末也发" }));
  await userEvent.click(view.getByRole("button", { name: "保存作息" }));

  await waitFor(() =>
    expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(2),
  );
  expect(calls.filter((call) => call.method === "PATCH")[1]?.body).toEqual({
    workHours: { start: "08:30", end: "17:30", weekends: true },
  });
  // 回显的是服务器回来的那份。
  await waitFor(() =>
    expect(view.getByTestId("work-hours-now").textContent).toBe(
      "现在：每天 08:30–17:30，按 Asia/Shanghai 的时间。",
    ),
  );
  expect(view.getByRole("status").textContent).toBe("已保存。");
  expect((view.getByLabelText("开工时间") as HTMLInputElement).value).toBe(
    "08:30",
  );
});

// ---------------------------------------------------------------- 路由

const root = createRootRoute({ component: Outlet });
const authed = createRoute({
  id: "/_authed",
  getParentRoute: () => root,
  component: Outlet,
});
const app = createRoute({
  id: "/_app",
  getParentRoute: () => authed,
  component: Outlet,
});

type Wiring<R extends { update: (options: never) => unknown }> = Parameters<
  R["update"]
>[0] & { id: string; path: string; getParentRoute: () => unknown };

const briefingRoute = BriefingRoute.update({
  id: "/briefing",
  path: "/briefing",
  getParentRoute: () => app,
} as Wiring<typeof BriefingRoute>);
const tasksRoute = TasksRoute.update({
  id: "/tasks",
  path: "/tasks",
  getParentRoute: () => app,
} as Wiring<typeof TasksRoute>);
const detailRoute = TaskDetailRoute.update({
  id: "/$taskId",
  path: "$taskId",
  getParentRoute: () => tasksRoute,
} as Wiring<typeof TaskDetailRoute>);
const settingsRoute = createRoute({
  path: "/settings/notifications",
  getParentRoute: () => root,
  component: () => <p>通知设置</p>,
});

const routeTree = root.addChildren([
  authed.addChildren([
    app.addChildren([briefingRoute, tasksRoute.addChildren([detailRoute])]),
  ]),
  settingsRoute,
]);

function draw(initialEntry: string, userId = "user-1") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(agentKeys.list(false), [XIAOZHOU]);
  queryClient.setQueryData(authKeys.currentUser(), { id: userId });
  const router = createRouter({
    context: {},
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
    routeTree,
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { queryClient, router, view };
}

const BRIEFING = {
  reviewed: 5,
  awaitingReview: [
    {
      taskId: "t-review-1",
      title: "客户回访名单",
      agentName: "小助",
      deliveredAt: ago(90),
    },
    {
      taskId: "t-review-2",
      title: "竞品价格表更新",
      agentName: "小周",
      deliveredAt: ago(30),
    },
  ],
  inProgress: [
    {
      taskId: "t-doing-1",
      title: "核对上月发票",
      agentName: "小财",
      dueAt: later(60),
    },
    {
      taskId: "t-doing-2",
      title: "补签采购合同",
      agentName: "小助",
      dueAt: null,
    },
  ],
  overdue: [
    { taskId: "t-late", title: "投放素材替换", minutes: 40, nudges: 1 },
  ],
  deferred: ["『投放素材替换』已逾期 40 分钟（小周，催过 1 次）"],
};

/** 清点页用到的几个接口：作息在 `zone`，清点按请求的 kind 回。 */
function briefingFetch(
  calls: Call[],
  zone: string,
  briefing: unknown = BRIEFING,
) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, path, body: undefined });
    if (path === "/api/settings/preferences")
      return json({ preferences: preferences(workHours({ timeZone: zone })) });
    const kind = path.match(/^\/api\/me\/briefing\?kind=(start|end)$/)?.[1];
    if (kind) return json({ kind, briefing });
    if (path.startsWith("/api/tasks")) return json({ tasks: [] });
    if (path === "/api/approvals")
      return json({
        enabled: true,
        requests: [],
        rules: [],
        teamRules: [],
        questions: [],
      });
    if (path.startsWith("/api/devices")) return json({ devices: [] });
    return json({ agents: [] });
  }) as typeof fetch;
}

const briefingKinds = (calls: Call[]) =>
  calls.flatMap((call) => {
    const kind = call.path.match(/^\/api\/me\/briefing\?kind=(\w+)$/)?.[1];
    return kind ? [kind] : [];
  });

test("清点页的数字和逐件列表都取自 /api/me/briefing，点一件打开它的卡片详情", async () => {
  const calls: Call[] = [];
  briefingFetch(calls, "Asia/Shanghai");
  const { router, view } = draw("/briefing");
  const tiles = await view.findByRole("list", { name: "清点数字" });
  const tileText = [...tiles.children].map((tile) => tile.textContent);
  expect(tileText).toEqual([
    `${BRIEFING.reviewed}已验收`,
    `${BRIEFING.awaitingReview.length}等你验收`,
    `${BRIEFING.inProgress.length}还在做`,
    `${BRIEFING.overdue.length}逾期`,
  ]);

  const review = view.getByRole("region", { name: "等你验收" });
  expect(
    within(review)
      .getAllByRole("link")
      .map((link) => link.textContent?.replace(/ · .*$/, "")),
  ).toEqual(["已交成果客户回访名单小助", "已交成果竞品价格表更新小周"]);
  const doing = view.getByRole("region", { name: "还在做" });
  const doingRows = within(doing).getAllByRole("link");
  expect(doingRows).toHaveLength(2);
  expect(doingRows[0]?.textContent).toContain("已接下核对上月发票");
  expect(doingRows[0]?.textContent).toContain("到期");
  expect(doingRows[1]?.textContent).toBe("待接下补签采购合同小助 · 等它接下");
  const late = view.getByRole("region", { name: "逾期" });
  expect(within(late).getByRole("link").textContent).toBe(
    "逾期投放素材替换逾期 40 分钟 · 已催 1 次",
  );
  // 作息外攒下的提醒只在开工清点里有。
  const kind = briefingKinds(calls)[0];
  expect(
    Boolean(view.queryByRole("region", { name: "作息外攒下的提醒" })),
  ).toBe(kind === "start");
  // 有逾期时先看逾期那件。
  expect(view.getByRole("link", { name: "逐件看" }).getAttribute("href")).toBe(
    "/tasks/t-late",
  );

  await userEvent.click(within(review).getAllByRole("link")[1] as HTMLElement);
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/tasks/t-review-2"),
  );
});

test("没有在跟的活时清点页说为什么是空的，不画数字", async () => {
  const calls: Call[] = [];
  briefingFetch(calls, "Asia/Shanghai", null);
  const { view } = draw("/briefing");
  const empty = await view.findByRole("region", { name: "没有清点" });
  expect(empty.textContent).toContain("现在没有在跟的活");
  expect(empty.textContent).toContain("没有在跟的活就不发清点");
  expect(view.queryByRole("list", { name: "清点数字" })).toBeNull();
  expect(view.getByRole("link", { name: "去看板" }).getAttribute("href")).toBe(
    "/tasks",
  );
});

test("开工还是收工清点按作息的时区选，不按浏览器的钟", async () => {
  // 两个相差正好 12 小时、都不过夏令时的时区：此刻一个在上午、一个在下午，选到的清点一定不同。
  const zones = ["Asia/Shanghai", "America/Santo_Domingo"] as const;
  const seen: string[] = [];
  for (const [index, zone] of zones.entries()) {
    const calls: Call[] = [];
    briefingFetch(calls, zone);
    const { view } = draw("/briefing", `user-zone-${index}`);
    await view.findByRole("list", { name: "清点数字" });
    const expected = hourIn(new Date(), zone) < 12 ? "start" : "end";
    // 先读作息再读清点，只读一份，就是作息时区里该看的那份。
    expect(briefingKinds(calls)).toEqual([expected]);
    expect(view.getByRole("heading", { level: 1 }).textContent).toStartWith(
      expected === "start" ? "开工清点 · " : "收工清点 · ",
    );
    seen.push(expected);
    cleanup();
  }
  expect(new Set(seen).size).toBe(2);
});

test("briefingKindAt：同一刻在不同时区里分开工、收工", () => {
  // 2026-11-15 02:00 UTC：上海 10:00（上午），芝加哥前一天 20:00（晚上）。
  const instant = new Date("2026-11-15T02:00:00Z");
  expect(hourIn(instant, "Asia/Shanghai")).toBe(10);
  expect(briefingKindAt(instant, "Asia/Shanghai")).toBe("start");
  expect(hourIn(instant, "America/Chicago")).toBe(20);
  expect(briefingKindAt(instant, "America/Chicago")).toBe("end");
  // 认不出的时区按浏览器的钟。
  expect(hourIn(instant, "Mars/Olympus")).toBe(instant.getHours());
});

test("看板清点条的「逐件看」打开清点页", async () => {
  const calls: Call[] = [];
  briefingFetch(calls, "Asia/Shanghai");
  // 看板上要有在跟卡才画「三步收货」。
  const fetchBriefing = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (
      String(input).startsWith("/api/tasks?") ||
      String(input) === "/api/tasks"
    )
      return json({ tasks: [OVERDUE_CARD] });
    return fetchBriefing(input, init);
  }) as typeof fetch;
  const { router, view } = draw("/tasks");
  const strip = await view.findByRole("region", { name: /清点提示$/ });
  await userEvent.click(within(strip).getByRole("button", { name: "逐件看" }));
  await waitFor(() => expect(router.state.location.pathname).toBe("/briefing"));
});

// ---------------------------------------------------------------- 逾期卡详情

const OVERDUE_CARD = {
  id: "44444444-4444-4444-8444-444444444444",
  title: "竞品价格表更新",
  executorAgentId: XIAOZHOU.id,
  source: "chat",
  status: "running",
  channelRef: null,
  open: null,
  deliverableRef: null,
  model: null,
  deviceId: null,
  tracked: true,
  stage: "accepted",
  acceptedAt: ago(120),
  dueAt: ago(40),
  originalDueAt: ago(40),
  dueReported: true,
  criteria: null,
  overdueAt: ago(5),
  lastError: null,
  nudges: 2,
  returns: 0,
  createdAt: ago(130),
  updatedAt: ago(1),
};

const OVERDUE_EVENTS = [
  {
    id: "o1",
    kind: "accepted",
    actor: `agent:${XIAOZHOU.id}`,
    detail: { dueAt: ago(40) },
    createdAt: ago(120),
  },
  {
    id: "o2",
    kind: "nudged",
    actor: "system",
    detail: { text: "到点了，进度怎么样？" },
    createdAt: ago(35),
  },
  {
    id: "o3",
    kind: "overdue",
    actor: "system",
    detail: { dueAt: ago(40), at: ago(5) },
    createdAt: ago(5),
  },
  {
    id: "o4",
    kind: "notified",
    actor: "system",
    detail: { kind: "overdue", text: "…", result: "sent" },
    createdAt: ago(5),
  },
  // 你自己点的「再催」：在流水里，不算服务器替你盯的。
  {
    id: "o5",
    kind: "nudged",
    actor: "user:me",
    detail: { text: "先交做完的部分" },
    createdAt: ago(2),
  },
];

test("手机上逾期卡详情：服务器替你盯过的经过，和设计稿 5 的四个处理按钮", async () => {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 390,
  });
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    calls.push({
      method,
      path,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    if (method !== "GET") return json({ ok: true });
    if (path === `/api/tasks/${OVERDUE_CARD.id}/events`)
      return json({ events: OVERDUE_EVENTS });
    if (path === `/api/tasks/${OVERDUE_CARD.id}`)
      return json({ task: OVERDUE_CARD });
    if (path.startsWith("/api/tasks")) return json({ tasks: [OVERDUE_CARD] });
    if (path.startsWith("/api/me/briefing"))
      return json({ kind: "start", briefing: null });
    if (path === "/api/settings/preferences")
      return json({ preferences: preferences(workHours()) });
    if (path === "/api/approvals")
      return json({
        enabled: true,
        requests: [],
        rules: [],
        teamRules: [],
        questions: [],
      });
    if (path.startsWith("/api/devices")) return json({ devices: [] });
    return json({ agents: [] });
  }) as typeof fetch;
  const { view } = draw(`/tasks/${OVERDUE_CARD.id}`);
  const dialog = await view.findByRole("dialog");
  const block = await within(dialog).findByRole("region", {
    name: "逾期了，怎么办？",
  });
  const watch = within(block).getByRole("region", { name: "服务器替你盯着" });
  await waitFor(() =>
    expect(
      within(watch)
        .getAllByRole("listitem")
        .map((item) => item.querySelector("span")?.textContent),
    ).toEqual([
      "叫醒小周，问进度（第 1 次）",
      "还没交 → 记为逾期，进看板「只看逾期」",
      "通知你",
    ]),
  );
  expect(watch.textContent).not.toContain("你催了");

  const buttons = within(block)
    .getAllByRole("button")
    .map((button) => button.textContent);
  expect(buttons).toEqual([
    "再催一次，让它先交做完的部分",
    "准许延期到……",
    "换个员工接手",
    "取消这件活",
  ]);
  // 四个按钮都在这一段里，下面不再画第二遍。
  expect(
    within(dialog).getAllByRole("button", { name: "换个员工接手" }),
  ).toHaveLength(1);
  // 一个一列、占满宽度，44px 高（设计稿 5）。
  for (const name of buttons)
    expect(
      within(block).getByRole("button", { name: name ?? "" }).className,
    ).toContain("w-full");

  await userEvent.click(
    within(block).getByRole("button", {
      name: "再催一次，让它先交做完的部分",
    }),
  );
  await waitFor(() =>
    expect(
      calls.some(
        (call) =>
          call.method === "POST" &&
          call.path === `/api/tasks/${OVERDUE_CARD.id}/nudge`,
      ),
    ).toBe(true),
  );
});

// ---------------------------------------------------------------- 侧栏目标

const goal = (over: Partial<NonNullable<SidebarGoal>>): SidebarGoal => ({
  title: "竞品价格表更新",
  status: "running",
  stage: "accepted",
  dueAt: null,
  overdue: false,
  returns: 0,
  rounds: 4,
  lastCheck: "已交成果，等你验收",
  pendingApprovalId: null,
  ...over,
});

function segmentsOf(view: ReturnType<typeof render>) {
  const bar = view.container.querySelector<HTMLElement>("[data-goal-stages]");
  if (!bar) return null;
  return {
    label: bar.getAttribute("aria-label"),
    states: [...bar.children].map((span) => span.getAttribute("data-segment")),
    classes: [...bar.children].map((span) => span.className),
  };
}

test("侧栏目标的四段进度按 stage 着色：做过的绿、走到的蓝、逾期的红、没到的灰", () => {
  const delivered = render(
    <GoalBody
      goal={goal({ status: "awaiting_review", stage: "delivered", returns: 1 })}
      pending={null}
    />,
  );
  const shown = segmentsOf(delivered);
  expect(shown?.label).toBe("进度：已交成果，等你验收");
  expect(shown?.states).toEqual(["done", "done", "current", "todo"]);
  expect(shown?.classes.map((name) => name.match(/bg-\S+/)?.[0])).toEqual([
    "bg-(--wb-green)",
    "bg-(--wb-green)",
    "bg-(--wb-blue)",
    "bg-(--wb-ctx-track)",
  ]);
  // 「已交成果」那一段的名字加粗标蓝，退回过几次写在下面。
  const current = delivered.getByText("已交成果", { selector: "b" });
  expect(current.className).toContain("text-(--wb-blue-text)");
  expect(delivered.getByText("退回过 1 次")).toBeTruthy();
  cleanup();

  const late = render(
    <GoalBody
      goal={goal({ stage: "accepted", overdue: true, dueAt: ago(40) })}
      pending={null}
    />,
  );
  expect(segmentsOf(late)?.states).toEqual(["done", "overdue", "todo", "todo"]);
  expect(segmentsOf(late)?.classes[1]).toContain("bg-(--wb-danger-fg)");
  expect(segmentsOf(late)?.label).toBe("进度：已接下，在做，已逾期");
  expect(late.getByText(/^预计 .* 交 · 已逾期$/)).toBeTruthy();
  cleanup();

  const pendingAccept = render(
    <GoalBody goal={goal({ stage: "pending_accept" })} pending={null} />,
  );
  expect(segmentsOf(pendingAccept)?.states).toEqual([
    "current",
    "todo",
    "todo",
    "todo",
  ]);
  cleanup();

  const reviewed = render(
    <GoalBody
      goal={goal({ status: "done", stage: "reviewed" })}
      pending={null}
    />,
  );
  expect(segmentsOf(reviewed)?.states).toEqual([
    "done",
    "done",
    "done",
    "done",
  ]);
  expect(segmentsOf(reviewed)?.label).toBe("进度：你已验收");
  cleanup();

  const cancelled = render(
    <GoalBody
      goal={goal({ status: "cancelled", stage: "accepted" })}
      pending={null}
    />,
  );
  expect(segmentsOf(cancelled)?.states).toEqual([
    "cancelled",
    "cancelled",
    "cancelled",
    "cancelled",
  ]);
  expect(segmentsOf(cancelled)?.label).toBe("进度：这件活已取消");
  cleanup();

  // 不在跟的卡没有四段进度，照原来的「第 N 轮 · 上次检查」。
  const untracked = render(
    <GoalBody goal={goal({ stage: null, lastCheck: "在做" })} pending={null} />,
  );
  expect(segmentsOf(untracked)).toBeNull();
  expect(untracked.getByText("第 4 轮 · 上次检查：在做")).toBeTruthy();
});
