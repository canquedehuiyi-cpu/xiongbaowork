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
import { agentKeys } from "@/lib/agents/queries";
import { Route as TasksRoute } from "@/routes/_authed/_app/tasks";
import { Route as TaskDetailRoute } from "@/routes/_authed/_app/tasks.$taskId";
import { setSkin } from "@/skins/store";
import { settleReactWork } from "./settle-react-work";

/**
 * 交付闭环第三期 Task 8（规格 `docs/specs/2026-11-15-delivery-loop.md` 第 3、7 节，设计稿 1、2）：看板上
 * 在跟的卡分进四列，逾期卡写明逾期多久、催了几次，退回必须写原因，卡片详情的流水按时间正序，不在跟的卡
 * 照旧在原来的列里。走真的文件路由和真的路由器，只换掉 fetch。
 */
let registeredHere = false;
const originalFetch = globalThis.fetch;

beforeAll(() => {
  if (!("document" in globalThis)) {
    GlobalRegistrator.register();
    registeredHere = true;
  }
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
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

/** 今天本地时间的某一刻（流水的时刻）。 */
const todayAt = (hours: number, minutes: number) => {
  const at = new Date(NOW);
  at.setHours(hours, minutes, 0, 0);
  return at.toISOString();
};

const XIAOZHU = { id: "agent-xz", name: "小助", avatarSeed: "xz" };
const XIAOZHOU = { id: "agent-zhou", name: "小周", avatarSeed: "zhou" };

const card = (
  id: string,
  title: string,
  over: Record<string, unknown> = {},
) => ({
  id,
  title,
  executorAgentId: XIAOZHU.id,
  source: "chat",
  status: "running",
  channelRef: null,
  open: null,
  deliverableRef: null,
  model: null,
  deviceId: null,
  tracked: true,
  stage: "accepted",
  acceptedAt: ago(30),
  dueAt: later(60),
  originalDueAt: later(60),
  dueReported: true,
  criteria: null,
  overdueAt: null,
  lastError: null,
  nudges: 0,
  returns: 0,
  createdAt: ago(40),
  updatedAt: ago(1),
  ...over,
});

const PENDING = card(
  "11111111-1111-4111-8111-111111111111",
  "核对上月发票和报销单",
  {
    stage: "pending_accept",
    acceptedAt: null,
    dueAt: null,
    originalDueAt: null,
    dueReported: false,
  },
);
const PENDING_NEEDS = card(
  "22222222-2222-4222-8222-222222222222",
  "补签采购合同",
  {
    status: "needs_action",
    stage: "pending_accept",
    acceptedAt: null,
    dueAt: null,
    originalDueAt: null,
  },
);
const ACCEPTED = card("33333333-3333-4333-8333-333333333333", "整理本周周报");
const OVERDUE = card("44444444-4444-4444-8444-444444444444", "竞品价格表更新", {
  executorAgentId: XIAOZHOU.id,
  acceptedAt: ago(120),
  dueAt: ago(40),
  originalDueAt: ago(40),
  overdueAt: ago(5),
  nudges: 1,
});
const DELIVERED = card("55555555-5555-4555-8555-555555555555", "客户回访名单", {
  status: "awaiting_review",
  stage: "delivered",
  deliverableRef: {
    kind: "deliverable",
    attachments: ["att-1"],
    checks: ["抽查 5 条电话，都能打通", "去掉了 3 条已注销客户"],
  },
  criteria: "只要近 90 天下过单的客户，带电话和最近一次订单。",
});
const REVIEWED = card("66666666-6666-4666-8666-666666666666", "会议纪要", {
  status: "done",
  stage: "reviewed",
});
const CANCELLED = card("77777777-7777-4777-8777-777777777777", "旧版海报", {
  status: "cancelled",
  stage: "accepted",
});
/** 不在跟的两张：照原来的列走。 */
const PATROL = card("88888888-8888-4888-8888-888888888888", "日常巡检", {
  tracked: false,
  stage: null,
  source: "routine",
  acceptedAt: null,
  dueAt: null,
});
const DRAFT = card("99999999-9999-4999-8999-999999999999", "查收周报草稿", {
  tracked: false,
  stage: null,
  status: "awaiting_review",
  acceptedAt: null,
  dueAt: null,
});

const BOARD = [
  PENDING,
  PENDING_NEEDS,
  ACCEPTED,
  OVERDUE,
  DELIVERED,
  REVIEWED,
  CANCELLED,
  PATROL,
  DRAFT,
];

/** 客户回访名单的流水，故意打乱了先后：详情要按时间正序排。 */
const DELIVERED_EVENTS = [
  {
    id: "e5",
    kind: "delivered",
    actor: `agent:${XIAOZHU.id}`,
    detail: {
      deliverable: {
        kind: "deliverable",
        attachments: ["att-1"],
        checks: ["抽查 5 条电话，都能打通", "去掉了 3 条已注销客户"],
      },
    },
    createdAt: todayAt(10, 41),
  },
  {
    id: "e2",
    kind: "accepted",
    actor: `agent:${XIAOZHU.id}`,
    detail: { dueAt: todayAt(11, 0) },
    createdAt: todayAt(9, 11),
  },
  {
    id: "e4",
    kind: "bounced",
    actor: `agent:${XIAOZHU.id}`,
    detail: { reason: "没附交付物" },
    createdAt: todayAt(10, 38),
  },
  {
    id: "e1",
    kind: "dispatched",
    actor: "user:me",
    detail: {},
    createdAt: todayAt(9, 10),
  },
  {
    id: "e3",
    kind: "progress",
    actor: `agent:${XIAOZHU.id}`,
    detail: { text: "已拉出 89 条，正在去重" },
    createdAt: todayAt(9, 40),
  },
  {
    id: "e6",
    kind: "run_ended",
    actor: "system",
    detail: {},
    createdAt: todayAt(10, 42),
  },
];

type Call = { method: string; path: string; body: unknown };

function controlFetch(calls: Call[]) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    calls.push({
      method,
      path,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    if (method !== "GET") return json({ ok: true });
    const one = path.match(/^\/api\/tasks\/([^/?]+)(\/events)?$/);
    if (one) {
      if (one[2])
        return json({
          events: one[1] === DELIVERED.id ? DELIVERED_EVENTS : [],
        });
      return json({ task: BOARD.find((entry) => entry.id === one[1]) });
    }
    if (path.startsWith("/api/tasks")) return json({ tasks: BOARD });
    if (path.startsWith("/api/me/briefing"))
      return json({ kind: "start", briefing: null });
    if (path.startsWith("/api/devices")) return json({ devices: [] });
    return json({ agents: [] });
  }) as typeof fetch;
}

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

const routeTree = root.addChildren([
  authed.addChildren([
    app.addChildren([tasksRoute.addChildren([detailRoute])]),
  ]),
]);

function draw(initialEntry: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(agentKeys.list(false), [XIAOZHU, XIAOZHOU]);
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

const lane = (container: HTMLElement, label: string): HTMLElement => {
  const found = container.querySelector<HTMLElement>(
    `section[aria-label="${label}"]`,
  );
  if (!found) throw new Error(`没有「${label}」这一列`);
  return found;
};

/** 一列里直接摆着的卡（折叠起来的取消卡不算）。 */
const cardsIn = (section: HTMLElement): string[] =>
  [...section.querySelectorAll("article")]
    .filter((article) => !article.closest("details"))
    .map((article) => article.querySelector("h3")?.textContent ?? "");

const articleOf = (container: HTMLElement, title: string): HTMLElement => {
  const hit = [...container.querySelectorAll<HTMLElement>("article")].find(
    (article) => article.querySelector("h3")?.textContent === title,
  );
  if (!hit) throw new Error(`没有「${title}」这张卡`);
  return hit;
};

test("四列归类：在跟卡按阶段进四列，未接下的 needs_action 卡在待接下列带「等你操作」，取消的折叠在已验收下", async () => {
  const calls: Call[] = [];
  controlFetch(calls);
  const { view } = draw("/tasks");
  const board = await view.findByRole("region", { name: "三步收货" });

  expect(cardsIn(lane(board, "派出 · 待接下"))).toEqual([
    "核对上月发票和报销单",
    "补签采购合同",
  ]);
  expect(cardsIn(lane(board, "已接下 · 在做")).sort()).toEqual(
    ["整理本周周报", "竞品价格表更新"].sort(),
  );
  expect(cardsIn(lane(board, "已交成果 · 等你验收"))).toEqual(["客户回访名单"]);
  expect(cardsIn(lane(board, "已验收"))).toEqual(["会议纪要"]);

  const waiting = articleOf(board, "补签采购合同");
  expect(within(waiting).getByText("等你操作")).toBeTruthy();
  expect(
    within(articleOf(board, "核对上月发票和报销单")).queryByText("等你操作"),
  ).toBeNull();

  const folded = lane(board, "已验收").querySelector("details");
  expect(folded).not.toBeNull();
  expect(folded?.querySelector("summary")?.textContent ?? "").toBe(
    "已取消 1 件",
  );
  expect(folded?.textContent ?? "").toContain("旧版海报");

  // 不在跟的卡不进四列。
  expect(board.textContent ?? "").not.toContain("日常巡检");
  expect(board.textContent ?? "").not.toContain("查收周报草稿");
});

test("逾期卡：红框，写「逾期 40 分钟 · 已催 1 次」，带「催一下」「准许延期」，「只看逾期」只留它", async () => {
  const calls: Call[] = [];
  controlFetch(calls);
  const { view } = draw("/tasks");
  const board = await view.findByRole("region", { name: "三步收货" });
  const late = articleOf(board, "竞品价格表更新");

  expect(late.getAttribute("data-overdue")).toBe("true");
  expect(within(late).getByText("逾期 40 分钟 · 已催 1 次")).toBeTruthy();
  expect(late.textContent ?? "").toContain("小周");
  expect(within(late).getByRole("button", { name: "催一下" })).toBeTruthy();
  expect(within(late).getByRole("button", { name: "准许延期" })).toBeTruthy();
  // 没逾期的在做卡没有这两个按钮，也没有红框。
  const onTime = articleOf(board, "整理本周周报");
  expect(onTime.getAttribute("data-overdue")).toBeNull();
  expect(within(onTime).queryByRole("button", { name: "催一下" })).toBeNull();

  const user = userEvent.setup({ document: window.document });
  await user.click(within(late).getByRole("button", { name: "催一下" }));
  await waitFor(() =>
    expect(
      calls.some(
        (call) =>
          call.method === "POST" &&
          call.path === `/api/tasks/${OVERDUE.id}/nudge`,
      ),
    ).toBe(true),
  );

  const filter = within(board).getByRole("button", { name: "只看逾期" });
  expect(filter.getAttribute("aria-pressed")).toBe("false");
  await user.click(filter);
  expect(filter.getAttribute("aria-pressed")).toBe("true");
  const shown = DELIVERED_LANES_LABELS.flatMap((label) =>
    cardsIn(lane(board, label)),
  );
  expect(shown).toEqual(["竞品价格表更新"]);
});

const DELIVERED_LANES_LABELS = [
  "派出 · 待接下",
  "已接下 · 在做",
  "已交成果 · 等你验收",
  "已验收",
];

test("退回必须写原因才能提交：空的、只有空格都提交不了，写了原因才发出去", async () => {
  const calls: Call[] = [];
  controlFetch(calls);
  const { view } = draw("/tasks");
  const board = await view.findByRole("region", { name: "三步收货" });
  const user = userEvent.setup({ document: window.document });
  await user.click(
    within(articleOf(board, "客户回访名单")).getByRole("button", {
      name: "退回",
    }),
  );
  const dialog = await view.findByRole("dialog");
  expect(within(dialog).getByText("退回「客户回访名单」")).toBeTruthy();
  const send = within(dialog).getByRole("button", { name: "退回给员工" });
  const reason = within(dialog).getByRole("textbox", { name: "退回原因" });

  expect(send.hasAttribute("disabled")).toBe(true);
  await user.type(reason, "   ");
  expect(send.hasAttribute("disabled")).toBe(true);
  await user.click(send);
  const returns = () =>
    calls.filter(
      (call) =>
        call.method === "POST" &&
        call.path === `/api/tasks/${DELIVERED.id}/return`,
    );
  expect(returns()).toHaveLength(0);

  await user.clear(reason);
  await user.type(reason, "缺了 C 家的电话");
  expect(send.hasAttribute("disabled")).toBe(false);
  await user.click(send);
  await waitFor(() => expect(returns()).toHaveLength(1));
  expect(returns()[0]?.body).toEqual({ reason: "缺了 C 家的电话" });
});

test("卡片详情的流水按时间正序，只念说得出口的行", async () => {
  const calls: Call[] = [];
  controlFetch(calls);
  const { view } = draw(`/tasks/${DELIVERED.id}`);
  const timeline = await view.findByRole("region", { name: "流水" });
  await waitFor(() =>
    expect(timeline.querySelectorAll("li").length).toBeGreaterThan(0),
  );
  const rows = [...timeline.querySelectorAll("li")].map((li) => ({
    time: li.querySelector("time")?.textContent ?? "",
    text: (li.textContent ?? "").slice(
      (li.querySelector("time")?.textContent ?? "").length,
    ),
  }));
  expect(rows).toEqual([
    { time: "09:10", text: "你派出：「客户回访名单」" },
    { time: "09:11", text: "小助接下，预计 11:00 交" },
    { time: "09:40", text: "小助：已拉出 89 条，正在去重" },
    { time: "10:38", text: "小助想交付，被挡回：没附交付物" },
    { time: "10:41", text: "小助交付：附件 1 + 2 条自查" },
  ]);

  // 详情里的交付物与证据、验收标准，和设计稿 2 一样。
  const evidence = view.getByRole("region", { name: "交付物与证据" });
  expect(evidence.textContent ?? "").toContain("抽查 5 条电话，都能打通");
  expect(evidence.textContent ?? "").toContain("员工自查");
  expect(evidence.textContent ?? "").toContain(
    "验收标准（派活时写下的）：只要近 90 天下过单的客户，带电话和最近一次订单。",
  );
  expect(view.getByRole("button", { name: "退回，写原因" })).toBeTruthy();
});

test("不在跟的卡照旧列：原来的泳道只放不在跟的卡，在跟的卡不再重复出现", async () => {
  const calls: Call[] = [];
  controlFetch(calls);
  const { view } = draw("/tasks?view=lanes");
  await view.findByRole("region", { name: "三步收货" });
  const oldLane = (label: string) => {
    const group = view.container.querySelector<HTMLElement>(
      `[role=group][aria-label="${label}泳道"]`,
    );
    if (!group) throw new Error(`没有「${label}」泳道`);
    return group.textContent ?? "";
  };
  await waitFor(() => expect(oldLane("进行中")).toContain("日常巡检"));
  expect(oldLane("需要操作")).toContain("查收周报草稿");
  for (const title of [
    "整理本周周报",
    "客户回访名单",
    "会议纪要",
    "补签采购合同",
  ]) {
    expect(oldLane("进行中")).not.toContain(title);
    expect(oldLane("需要操作")).not.toContain(title);
    expect(oldLane("已结束")).not.toContain(title);
  }
  const attention = view.container.querySelector<HTMLElement>(
    'section[aria-label="需要关注"]',
  );
  if (!attention) throw new Error("没有「需要关注」");
  expect(attention.textContent).toContain("需要操作");
  expect(attention.textContent).not.toContain("补签采购合同");
});

test("别的皮肤不画四列：在跟的卡照原来的列走", async () => {
  setSkin("classic");
  const calls: Call[] = [];
  controlFetch(calls);
  const { view } = draw("/tasks?view=lanes");
  await waitFor(() =>
    expect(
      view.container.querySelector('[role=group][aria-label="需要操作泳道"]')
        ?.textContent ?? "",
    ).toContain("客户回访名单"),
  );
  expect(view.queryByRole("region", { name: "三步收货" })).toBeNull();
});
