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
import { overdueMinutes } from "@/lib/tasks/delivery";
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
    // 一位已经不在名单里的员工：卡上叫「员工」，不露 id。
    executorAgentId: "agent-gone-0000",
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
    pendingApprovalId: "ap-sign",
  },
);
const ACCEPTED = card("33333333-3333-4333-8333-333333333333", "整理本周周报", {
  lastError: "模型服务超时，没拿到回复",
});
const OVERDUE = card("44444444-4444-4444-8444-444444444444", "竞品价格表更新", {
  executorAgentId: XIAOZHOU.id,
  acceptedAt: ago(120),
  dueAt: ago(40),
  originalDueAt: ago(40),
  overdueAt: ago(5),
  nudges: 1,
});
/** 逾期以后员工发起了审批：在等你处理，服务器不让催。 */
const OVERDUE_ASKING = card(
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "核对报价单",
  {
    executorAgentId: XIAOZHOU.id,
    status: "needs_action",
    acceptedAt: ago(120),
    dueAt: ago(50),
    originalDueAt: ago(50),
    overdueAt: ago(10),
    nudges: 2,
    pendingApprovalId: "ap-quote",
  },
);
/** 逾期过、后来准许延期到一个半小时以后：此刻不算逾期。 */
const EXTENDED = card("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "投放素材替换", {
  acceptedAt: ago(180),
  dueAt: later(90),
  originalDueAt: ago(60),
  overdueAt: ago(20),
  nudges: 1,
  lastError: "ETIMEDOUT: upstream gateway timeout after 30000ms",
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
  OVERDUE_ASKING,
  EXTENDED,
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

/** 整理本周周报：员工申请延期，还没答复。 */
const ACCEPTED_EVENTS = [
  {
    id: "a1",
    kind: "accepted",
    actor: `agent:${XIAOZHU.id}`,
    detail: { dueAt: later(60) },
    createdAt: ago(30),
  },
  {
    id: "a2",
    kind: "extension_requested",
    actor: `agent:${XIAOZHU.id}`,
    detail: { dueAt: later(120), reason: "数据还没出" },
    createdAt: ago(5),
  },
];

/** 投放素材替换：到点没交记了逾期，半小时后你准许延期。 */
const EXTENDED_EVENTS = [
  {
    id: "x1",
    kind: "overdue",
    actor: "system",
    detail: { dueAt: ago(60), at: ago(20) },
    createdAt: ago(20),
  },
  {
    id: "x2",
    kind: "extension_granted",
    actor: "user:me",
    detail: { dueAt: later(90) },
    createdAt: ago(10),
  },
];

const EVENTS: Record<string, unknown[]> = {
  [DELIVERED.id]: DELIVERED_EVENTS,
  [ACCEPTED.id]: ACCEPTED_EVENTS,
  [EXTENDED.id]: EXTENDED_EVENTS,
};

/** 待审批的请求，形状同 `/api/approvals` 的 `requests`。 */
const pendingRequest = (id: string) => ({
  id,
  status: "pending",
  createdAt: new Date(NOW).toISOString(),
  action: {
    botId: "bot",
    toolRef: "computer_write_file",
    effect: "write",
    scope: "project",
    threadId: "thread",
    args: {},
    target: {},
    policy: { behaviour: "ask", source: "rule", reason: "先问" },
  },
});

type Call = { method: string; path: string; body: unknown };

/** 某个请求要服务器拒：`"POST /api/tasks/…/review"` → 状态码和回的话。 */
type Refusals = Record<string, { status: number; body: unknown }>;

function controlFetch(calls: Call[], refusals: Refusals = {}) {
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
    const refused = refusals[`${method} ${path}`];
    if (refused)
      return new Response(JSON.stringify(refused.body), {
        headers: { "content-type": "application/json" },
        status: refused.status,
      });
    if (method !== "GET") return json({ ok: true });
    const one = path.match(/^\/api\/tasks\/([^/?]+)(\/events)?$/);
    if (one) {
      if (one[2]) return json({ events: EVENTS[one[1] ?? ""] ?? [] });
      return json({ task: BOARD.find((entry) => entry.id === one[1]) });
    }
    if (path.startsWith("/api/tasks")) return json({ tasks: BOARD });
    if (path === "/api/approvals")
      return json({
        enabled: true,
        requests: ["ap-sign", "ap-quote"].map(pendingRequest),
        rules: [],
        teamRules: [],
        questions: [],
      });
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

const LANE_LABELS = [
  "派出 · 待接下",
  "已接下 · 在做",
  "已交成果 · 等你验收",
  "已验收",
];

const user = () => userEvent.setup({ document: window.document });

const posted = (calls: Call[], method: string, path: string) =>
  calls.filter((call) => call.method === method && call.path === path);

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
    ["整理本周周报", "竞品价格表更新", "核对报价单", "投放素材替换"].sort(),
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

  // 名单里没有的员工叫「员工」，不露 id 片段。
  const gone = articleOf(board, "核对上月发票和报销单");
  expect(gone.textContent).toContain("员工 · ");
  expect(gone.textContent).not.toContain("agent-go");
});

test("逾期卡：红框，写「逾期 40 分钟 · 已催 1 次」，带「催一下」「准许延期」；「只看逾期」写进地址只留逾期的", async () => {
  const calls: Call[] = [];
  controlFetch(calls);
  const { view, router } = draw("/tasks");
  const board = await view.findByRole("region", { name: "三步收货" });
  const late = articleOf(board, "竞品价格表更新");

  expect(late.getAttribute("data-overdue")).toBe("true");
  expect(within(late).getByText("逾期 40 分钟 · 已催 1 次")).toBeTruthy();
  expect(late.textContent).toContain("小周");
  expect(within(late).getByRole("button", { name: "催一下" })).toBeTruthy();
  expect(within(late).getByRole("button", { name: "准许延期" })).toBeTruthy();
  // 没逾期的在做卡没有这两个按钮，也没有红框。
  const onTime = articleOf(board, "整理本周周报");
  expect(onTime.getAttribute("data-overdue")).toBeNull();
  expect(within(onTime).queryByRole("button", { name: "催一下" })).toBeNull();
  // 顶上的数只算此刻逾期的（延期到将来的那张不算）。
  expect(board.querySelector("header")?.textContent ?? "").toContain(
    "2 件逾期",
  );

  await user().click(within(late).getByRole("button", { name: "催一下" }));
  await waitFor(() =>
    expect(
      posted(calls, "POST", `/api/tasks/${OVERDUE.id}/nudge`),
    ).toHaveLength(1),
  );

  const filter = within(board).getByRole("button", { name: "只看逾期" });
  expect(filter.getAttribute("aria-pressed")).toBe("false");
  await user().click(filter);
  await waitFor(() => expect(filter.getAttribute("aria-pressed")).toBe("true"));
  expect(router.state.location.search).toMatchObject({ overdue: 1 });
  expect(router.state.location.href).toContain("overdue=1");
  expect(router.state.location.href).not.toContain("%22");
  const shown = LANE_LABELS.flatMap((label) => cardsIn(lane(board, label)));
  expect(shown.sort()).toEqual(["核对报价单", "竞品价格表更新"].sort());
});

test("「只看逾期」从地址打开：overdue=1 的链接直接只显示逾期的卡", async () => {
  const calls: Call[] = [];
  controlFetch(calls);
  const { view } = draw("/tasks?overdue=1");
  const board = await view.findByRole("region", { name: "三步收货" });
  const filter = within(board).getByRole("button", { name: "只看逾期" });
  expect(filter.getAttribute("aria-pressed")).toBe("true");
  const shown = LANE_LABELS.flatMap((label) => cardsIn(lane(board, label)));
  expect(shown.sort()).toEqual(["核对报价单", "竞品价格表更新"].sort());
});

test("延期到将来以后不再标红、不进「只看逾期」；详情写「曾逾期」，出错原文折叠在技术细节里", async () => {
  const calls: Call[] = [];
  controlFetch(calls);
  const { view } = draw("/tasks");
  const board = await view.findByRole("region", { name: "三步收货" });
  const extended = articleOf(board, "投放素材替换");
  expect(extended.getAttribute("data-overdue")).toBeNull();
  expect(extended.textContent).not.toContain("逾期");
  expect(within(extended).queryByRole("button", { name: "催一下" })).toBeNull();
  // 英文原文不直接上卡：说「上一轮出错了」，原文在「技术细节」里。
  expect(extended.textContent).toContain("上一轮出错了");
  const details = extended.querySelector("details");
  if (!details) throw new Error("没有技术细节");
  expect(details.querySelector("summary")?.textContent ?? "").toBe("技术细节");
  expect(details.textContent).toContain("ETIMEDOUT");
  // 通俗中文的出错原因照写。
  expect(articleOf(board, "整理本周周报").textContent).toContain(
    "上一轮出错：模型服务超时，没拿到回复",
  );

  cleanup();
  const sheet = await draw(`/tasks/${EXTENDED.id}`).view.findByRole("dialog");
  // 原定 1 小时前交，10 分钟前准许延期：逾期了 50 分钟。
  await waitFor(() => expect(sheet.textContent).toContain("曾逾期 50 分钟"));
  expect(sheet.textContent).not.toContain("逾期 0 分钟");
  expect(
    within(sheet).queryByRole("button", {
      name: "再催一次，让它先交做完的部分",
    }),
  ).toBeNull();
  expect(within(sheet).getByRole("button", { name: "催一下" })).toBeTruthy();
});

test("退回必须写原因才能提交：空的、只有空格都提交不了，写了原因才发出去", async () => {
  const calls: Call[] = [];
  controlFetch(calls);
  const { view } = draw("/tasks");
  const board = await view.findByRole("region", { name: "三步收货" });
  await user().click(
    within(articleOf(board, "客户回访名单")).getByRole("button", {
      name: "退回",
    }),
  );
  const dialog = await view.findByRole("dialog");
  expect(within(dialog).getByText("退回「客户回访名单」")).toBeTruthy();
  const send = within(dialog).getByRole("button", { name: "退回给员工" });
  const reason = within(dialog).getByRole("textbox", { name: "退回原因" });

  expect(send.hasAttribute("disabled")).toBe(true);
  await user().type(reason, "   ");
  expect(send.hasAttribute("disabled")).toBe(true);
  await user().click(send);
  const returns = () =>
    calls.filter(
      (call) =>
        call.method === "POST" &&
        call.path === `/api/tasks/${DELIVERED.id}/return`,
    );
  expect(returns()).toHaveLength(0);

  await user().clear(reason);
  await user().type(reason, "缺了 C 家的电话");
  expect(send.hasAttribute("disabled")).toBe(false);
  await user().click(send);
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

test("不在跟的卡照旧列；在跟的卡等审批时，四列里那张卡上照样能批准、拒绝", async () => {
  const calls: Call[] = [];
  controlFetch(calls);
  const { view } = draw("/tasks?view=lanes");
  const board = await view.findByRole("region", { name: "三步收货" });
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

  // 原来在「需要关注」里的批准 / 拒绝，现在在四列里那张卡上。
  const waiting = articleOf(board, "补签采购合同");
  const approve = await within(waiting).findByRole("button", { name: "批准" });
  expect(within(waiting).getByRole("button", { name: "拒绝" })).toBeTruthy();
  await user().click(approve);
  await waitFor(() =>
    expect(
      posted(calls, "POST", "/api/approvals/ap-sign/decision").map(
        (call) => call.body,
      ),
    ).toEqual([{ decision: "allow_once" }]),
  );
});

test("等你处理的逾期卡：看板上没有「催一下」，有批准 / 拒绝和「准许延期」；详情里不能催、不能换人", async () => {
  const calls: Call[] = [];
  controlFetch(calls);
  const { view } = draw("/tasks");
  const board = await view.findByRole("region", { name: "三步收货" });
  const asking = articleOf(board, "核对报价单");
  expect(asking.getAttribute("data-overdue")).toBe("true");
  expect(within(asking).queryByRole("button", { name: "催一下" })).toBeNull();
  expect(within(asking).getByRole("button", { name: "准许延期" })).toBeTruthy();
  expect(
    await within(asking).findByRole("button", { name: "拒绝" }),
  ).toBeTruthy();

  cleanup();
  const sheet = await draw(`/tasks/${OVERDUE_ASKING.id}`).view.findByRole(
    "dialog",
  );
  const detail = within(sheet);
  await detail.findByRole("region", { name: "流水" });
  expect(await detail.findByRole("button", { name: "批准" })).toBeTruthy();
  expect(detail.getByRole("button", { name: "准许延期到……" })).toBeTruthy();
  expect(detail.getByRole("button", { name: "取消这件活" })).toBeTruthy();
  expect(
    detail.queryByRole("button", { name: "再催一次，让它先交做完的部分" }),
  ).toBeNull();
  expect(detail.queryByRole("button", { name: "催一下" })).toBeNull();
  expect(detail.queryByRole("button", { name: "换个员工接手" })).toBeNull();
});

test("验收发 /review；服务器英文的 409 换成中文", async () => {
  const calls: Call[] = [];
  controlFetch(calls, {
    [`POST /api/tasks/${DELIVERED.id}/review`]: {
      status: 409,
      body: { error: "Not awaiting review." },
    },
  });
  const { view } = draw("/tasks");
  const board = await view.findByRole("region", { name: "三步收货" });
  await user().click(
    within(articleOf(board, "客户回访名单")).getByRole("button", {
      name: "验收",
    }),
  );
  await waitFor(() =>
    expect(
      posted(calls, "POST", `/api/tasks/${DELIVERED.id}/review`),
    ).toHaveLength(1),
  );
  const alert = await within(board).findByRole("alert");
  expect(alert.textContent).toContain("这件活已经不在等你验收了");
  expect(alert.textContent).not.toContain("Not awaiting");
});

test("取消要点两次：第一次只问一句，第二次才发出去", async () => {
  const calls: Call[] = [];
  controlFetch(calls);
  const { view } = draw(`/tasks/${OVERDUE.id}`);
  const cancel = await view.findByRole("button", { name: "取消这件活" });
  await user().click(cancel);
  expect(posted(calls, "POST", `/api/tasks/${OVERDUE.id}/cancel`)).toHaveLength(
    0,
  );
  await user().click(view.getByRole("button", { name: "确定取消？再点一下" }));
  await waitFor(() =>
    expect(
      posted(calls, "POST", `/api/tasks/${OVERDUE.id}/cancel`),
    ).toHaveLength(1),
  );
});

test("准许延期：没申请过就改预计时间（PATCH）", async () => {
  const calls: Call[] = [];
  controlFetch(calls);
  const { view } = draw("/tasks");
  const board = await view.findByRole("region", { name: "三步收货" });
  await user().click(
    within(articleOf(board, "竞品价格表更新")).getByRole("button", {
      name: "准许延期",
    }),
  );
  const dialog = await view.findByRole("dialog");
  // 没有待答复的申请，就没有「不批」。
  expect(
    within(dialog).queryByRole("button", { name: "不批，按原时间交" }),
  ).toBeNull();
  await user().type(
    within(dialog).getByRole("textbox", { name: "延到几点" }),
    "16:00",
  );
  const send = within(dialog).getByRole("button", { name: "准许延期" });
  await waitFor(() => expect(send.hasAttribute("disabled")).toBe(false));
  await user().click(send);
  await waitFor(() =>
    expect(
      posted(calls, "PATCH", `/api/tasks/${OVERDUE.id}`).map(
        (call) => call.body,
      ),
    ).toEqual([{ dueAt: "16:00" }]),
  );
  expect(posted(calls, "POST", `/api/tasks/${OVERDUE.id}/extension`)).toEqual(
    [],
  );
});

test("准许延期：员工申请过就答复那条申请（照准 grant，或「不批，按原时间交」deny）", async () => {
  const calls: Call[] = [];
  controlFetch(calls);
  const first = draw(`/tasks/${ACCEPTED.id}`).view;
  await user().click(
    await first.findByRole("button", { name: "准许延期到……" }),
  );
  let dialog = await first.findByRole("dialog", {
    name: "准许「整理本周周报」延期到……",
  });
  const requested = within(dialog).getByRole<HTMLInputElement>("textbox", {
    name: "延到几点",
  });
  // 输入框里是给人看的说法；没改就提交时，送的是那条申请的原时间（ISO），并点名答复的是它。
  const asked = ACCEPTED_EVENTS[1]?.detail.dueAt as string;
  await waitFor(() =>
    expect(requested.value).toMatch(/^(今天|明早|明天) \d\d:\d\d$/),
  );
  await user().click(within(dialog).getByRole("button", { name: "准许延期" }));
  const extension = `/api/tasks/${ACCEPTED.id}/extension`;
  await waitFor(() =>
    expect(posted(calls, "POST", extension).map((call) => call.body)).toEqual([
      { decision: "grant", dueAt: asked, requestedDueAt: asked },
    ]),
  );
  expect(posted(calls, "PATCH", `/api/tasks/${ACCEPTED.id}`)).toEqual([]);

  cleanup();
  const second = draw(`/tasks/${ACCEPTED.id}`).view;
  await user().click(
    await second.findByRole("button", { name: "准许延期到……" }),
  );
  dialog = await second.findByRole("dialog", {
    name: "准许「整理本周周报」延期到……",
  });
  await user().click(
    await within(dialog).findByRole("button", { name: "不批，按原时间交" }),
  );
  await waitFor(() =>
    expect(
      posted(calls, "POST", extension)
        .slice(1)
        .map((call) => call.body),
    ).toEqual([{ decision: "deny", requestedDueAt: asked }]),
  );
});

test("读不到流水时不能提交延期，并说明原因", async () => {
  const calls: Call[] = [];
  controlFetch(calls, {
    [`GET /api/tasks/${OVERDUE.id}/events`]: {
      status: 500,
      body: { error: "boom" },
    },
  });
  const { view } = draw("/tasks");
  const board = await view.findByRole("region", { name: "三步收货" });
  await user().click(
    within(articleOf(board, "竞品价格表更新")).getByRole("button", {
      name: "准许延期",
    }),
  );
  const dialog = await view.findByRole("dialog");
  expect(
    await within(dialog).findByText(
      "读不到这件活的延期申请，先别改，稍后再试。",
    ),
  ).toBeTruthy();
  await user().type(
    within(dialog).getByRole("textbox", { name: "延到几点" }),
    "16:00",
  );
  const send = within(dialog).getByRole("button", { name: "准许延期" });
  expect(send.hasAttribute("disabled")).toBe(true);
  await user().click(send);
  expect(posted(calls, "PATCH", `/api/tasks/${OVERDUE.id}`)).toEqual([]);
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

  // 深链在别的皮肤里打开详情：根上接了兜底令牌，不是透明的。
  cleanup();
  const sheet = await draw(`/tasks/${DELIVERED.id}`).view.findByRole("dialog");
  expect(sheet.style.getPropertyValue("--wb-list")).toBe("var(--popover)");
  expect(sheet.style.getPropertyValue("--wb-fg")).toBe("var(--foreground)");
});

test("延期后的逾期沿用核对器的 35 分钟宽限：新时间过了 10 分钟不算逾期，过了 36 分钟算", () => {
  const now = new Date(NOW);
  const moved = (minutesPast: number) => ({
    tracked: true,
    status: "running",
    acceptedAt: ago(240),
    dueAt: ago(minutesPast),
    overdueAt: ago(180),
  });
  expect(overdueMinutes(moved(10), now)).toBeNull();
  expect(overdueMinutes(moved(36), now)).toBe(36);
});
