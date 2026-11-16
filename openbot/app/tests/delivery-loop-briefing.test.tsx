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
import type { ReactElement } from "react";
import { WorkHoursSection } from "@/components/settings/work-hours";
import { agentKeys } from "@/lib/agents/queries";
import { authKeys } from "@/lib/auth/queries";
import { userPreferencesQueryOptions } from "@/lib/settings/message-list";
import { BrowserTimeZoneSync } from "@/lib/settings/work-hours";
import {
  briefingKindAt,
  clockText,
  dueText,
  hourIn,
} from "@/lib/tasks/delivery";
import { Route as BriefingRoute } from "@/routes/_authed/_app/briefing";
import { Route as TasksRoute } from "@/routes/_authed/_app/tasks";
import { Route as TaskDetailRoute } from "@/routes/_authed/_app/tasks.$taskId";
import { setSkin } from "@/skins/store";
import { BriefingPage } from "@/skins/xiongbao/briefing-page";
import { GoalBody } from "@/skins/xiongbao/conversation-sidebar/goal";
import { ExtendDialog } from "@/skins/xiongbao/delivery-actions";
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

/** 设置时区的环境变量（happy-dom 和 Intl 都跟着它），用完放回去。 */
async function inBrowserZone<T>(zone: string, run: () => Promise<T>) {
  const before = process.env.TZ;
  process.env.TZ = zone;
  try {
    return await run();
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
}

type Deferred = { resolve: () => void };

/**
 * 一个记着作息的假服务器，按服务器的规矩合并（`server/src/user-preferences.ts`）：浏览器时区只在没存过时
 * 记下，存过的不改；`workHours` 照写。`hold` 为真时，浏览器时区那个请求的回包先压着，等测试放行。
 */
function preferencesServer(options: {
  stored: Record<string, unknown>;
  zoneSaved: boolean;
  hold?: boolean;
}) {
  const calls: Call[] = [];
  const held: Deferred[] = [];
  let stored = options.stored;
  let zoneSaved = options.zoneSaved;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: String(input), body });
    if (method === "PATCH") {
      if (body.browserTimeZone && !zoneSaved) {
        stored = { ...stored, timeZone: body.browserTimeZone };
        zoneSaved = true;
      }
      if (body.workHours) {
        stored = { ...stored, ...body.workHours };
        if (body.workHours.timeZone) zoneSaved = true;
      }
      const reply = json({ preferences: preferences(stored) });
      if (body.browserTimeZone && options.hold)
        await new Promise<void>((resolve) => held.push({ resolve }));
      return reply;
    }
    return json({ preferences: preferences(stored) });
  }) as typeof fetch;
  return {
    calls,
    patches: () => calls.filter((call) => call.method === "PATCH"),
    release: () => {
      for (const one of held.splice(0)) one.resolve();
    },
  };
}

function preferencesClient(userId: string, hours: Record<string, unknown>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(authKeys.currentUser(), { id: userId });
  queryClient.setQueryData(
    userPreferencesQueryOptions(userId).queryKey,
    preferences(hours) as never,
  );
  return queryClient;
}

const cachedZone = (queryClient: QueryClient, userId: string) =>
  (
    queryClient.getQueryData(
      userPreferencesQueryOptions(userId).queryKey,
    ) as unknown as { workHours: { timeZone: string } }
  ).workHours.timeZone;

test("登录后（没打开过设置）就把浏览器时区告诉服务器，每次加载只发一次", async () => {
  await inBrowserZone("America/Chicago", async () => {
    const server = preferencesServer({
      stored: workHours(),
      zoneSaved: false,
    });
    const queryClient = preferencesClient("user-shell-1", workHours());
    const view = render(
      <QueryClientProvider client={queryClient}>
        <BrowserTimeZoneSync />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(server.patches()).toEqual([
        {
          method: "PATCH",
          path: "/api/settings/preferences",
          body: { browserTimeZone: "America/Chicago" },
        },
      ]),
    );
    // 服务器记下了：缓存里的作息时区跟着换成芝加哥。
    await waitFor(() =>
      expect(cachedZone(queryClient, "user-shell-1")).toBe("America/Chicago"),
    );
    // 同一次加载里再挂一次（换页面、外壳重挂）不再发。
    view.unmount();
    render(
      <QueryClientProvider client={queryClient}>
        <BrowserTimeZoneSync />
      </QueryClientProvider>,
    );
    await settleReactWork();
    expect(server.patches()).toHaveLength(1);
  });
});

test("服务器已经存过时区：发了也不覆盖，缓存留着存下的那个", async () => {
  await inBrowserZone("America/Chicago", async () => {
    const saved = workHours({ timeZone: "Europe/London" });
    const server = preferencesServer({ stored: saved, zoneSaved: true });
    const queryClient = preferencesClient("user-shell-2", saved);
    render(
      <QueryClientProvider client={queryClient}>
        <BrowserTimeZoneSync />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(server.patches()).toHaveLength(1));
    await settleReactWork();
    expect(cachedZone(queryClient, "user-shell-2")).toBe("Europe/London");
  });
});

test("作息：改了保存后回显服务器存下的；开工晚于收工先拦住；设置页自己不再发浏览器时区", async () => {
  const server = preferencesServer({ stored: workHours(), zoneSaved: true });
  const queryClient = preferencesClient("user-hours-1", workHours());
  const view = render(
    <QueryClientProvider client={queryClient}>
      <WorkHoursSection />
    </QueryClientProvider>,
  );
  expect(view.getByTestId("work-hours-now").textContent).toBe(
    "现在：工作日 09:00–18:00，按中国标准时间。",
  );
  await settleReactWork();
  expect(server.patches()).toHaveLength(0);
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
  expect(server.patches()).toHaveLength(0);

  fireEvent.change(view.getByLabelText("开工时间"), {
    target: { value: "08:30" },
  });
  fireEvent.change(view.getByLabelText("收工时间"), {
    target: { value: "17:30" },
  });
  await userEvent.click(view.getByRole("switch", { name: "周末也发" }));
  await userEvent.click(view.getByRole("button", { name: "保存作息" }));

  await waitFor(() => expect(server.patches()).toHaveLength(1));
  expect(server.patches()[0]?.body).toEqual({
    workHours: { start: "08:30", end: "17:30", weekends: true },
  });
  // 回显的是服务器回来的那份。
  await waitFor(() =>
    expect(view.getByTestId("work-hours-now").textContent).toBe(
      "现在：每天 08:30–17:30，按中国标准时间。",
    ),
  );
  expect(view.getByRole("status").textContent).toBe("已保存。");
  expect((view.getByLabelText("开工时间") as HTMLInputElement).value).toBe(
    "08:30",
  );
});

test("浏览器时区的回包晚到：不冲掉正在填的开工时间，也不盖掉刚保存的时区", async () => {
  await inBrowserZone("America/Chicago", async () => {
    // 先：回包到的时候，表单正在改，没改的那一项（时区）跟着换，改了的（开工）留着。
    const server = preferencesServer({
      stored: workHours(),
      zoneSaved: false,
      hold: true,
    });
    const queryClient = preferencesClient("user-race-1", workHours());
    const view = render(
      <QueryClientProvider client={queryClient}>
        <BrowserTimeZoneSync />
        <WorkHoursSection />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(server.patches()).toHaveLength(1));
    fireEvent.change(view.getByLabelText("开工时间"), {
      target: { value: "07:45" },
    });
    server.release();
    await waitFor(() =>
      expect(view.getByTestId("work-hours-now").textContent).toBe(
        "现在：工作日 09:00–18:00，按北美中部标准时间。",
      ),
    );
    expect((view.getByLabelText("开工时间") as HTMLInputElement).value).toBe(
      "07:45",
    );
    expect((view.getByLabelText("时区") as HTMLSelectElement).value).toBe(
      "America/Chicago",
    );
    cleanup();

    // 再：浏览器时区的请求先发、回包压着；这期间你选了伦敦并保存，之后旧回包到了也不盖回去。
    const second = preferencesServer({
      stored: workHours(),
      zoneSaved: false,
      hold: true,
    });
    const client2 = preferencesClient("user-race-2", workHours());
    const again = render(
      <QueryClientProvider client={client2}>
        <BrowserTimeZoneSync />
        <WorkHoursSection />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(second.patches()).toHaveLength(1));
    fireEvent.change(again.getByLabelText("时区"), {
      target: { value: "Europe/London" },
    });
    await userEvent.click(again.getByRole("button", { name: "保存作息" }));
    await waitFor(() =>
      expect(cachedZone(client2, "user-race-2")).toBe("Europe/London"),
    );
    second.release();
    await settleReactWork();
    expect(cachedZone(client2, "user-race-2")).toBe("Europe/London");
  });
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
/** 清点页挂在固定的「此刻」上（`fixedNow`），好把开工、收工两支都测到。 */
let fixedNow = new Date();
const fixedBriefingRoute = createRoute({
  path: "/briefing-fixed",
  getParentRoute: () => app,
  component: () => <BriefingPage now={fixedNow} />,
});
const settingsRoute = createRoute({
  path: "/settings/notifications",
  getParentRoute: () => root,
  component: () => <p>通知设置</p>,
});

const routeTree = root.addChildren([
  authed.addChildren([
    app.addChildren([
      briefingRoute,
      fixedBriefingRoute,
      tasksRoute.addChildren([detailRoute]),
    ]),
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

test("dueText / clockText：到期时间说成今天、明早、明天、昨天，日界按作息时区", () => {
  // 上海 11 月 16 日 10:00（芝加哥还是 15 日 20:00）。
  const now = new Date("2026-11-16T02:00:00Z");
  const zone = "Asia/Shanghai";
  expect(dueText("2026-11-16T08:00:00Z", now, zone)).toBe("今天 16:00");
  expect(dueText("2026-11-17T02:00:00Z", now, zone)).toBe("明早 10:00");
  expect(dueText("2026-11-17T07:00:00Z", now, zone)).toBe("明天 15:00");
  expect(dueText("2026-11-15T10:00:00Z", now, zone)).toBe("昨天 18:00");
  expect(dueText("2026-11-18T02:00:00Z", now, zone)).toBe("11月18日 10:00");
  // 同一刻在芝加哥的日历上是「明天」：日界跟着时区走。
  expect(dueText("2026-11-16T08:00:00Z", now, "America/Chicago")).toBe(
    "明早 02:00",
  );
  expect(clockText("2026-11-16T01:30:00Z", now, zone)).toBe("09:30");
  expect(clockText("2026-11-15T01:30:00Z", now, zone)).toBe("11月15日 09:30");
});

/** 一份按上海作息写的清点：服务器写的提醒也是上海的钟。 */
const ZONED_BRIEFING = {
  reviewed: 1,
  awaitingReview: [
    {
      taskId: "z-review",
      title: "客户回访名单",
      agentName: "小助",
      deliveredAt: "2026-11-16T01:30:00Z",
    },
  ],
  inProgress: [
    {
      taskId: "z-doing-1",
      title: "核对上月发票",
      agentName: "小周",
      dueAt: "2026-11-16T03:00:00Z",
    },
    {
      taskId: "z-doing-2",
      title: "合同条款比对",
      agentName: "小周",
      dueAt: "2026-11-17T01:00:00Z",
    },
  ],
  overdue: [],
  deferred: ["『核对上月发票』预计 11:00 交，还在做（小周）"],
};

test("芝加哥的浏览器、上海的作息：清点页标题日期、每件的时刻、服务器写的提醒都按上海的钟，顶上写明", async () => {
  await inBrowserZone("America/Chicago", async () => {
    // 开工那一支：上海 11 月 16 日 10:00（芝加哥 15 日 20:00）。
    fixedNow = new Date("2026-11-16T02:00:00Z");
    const calls: Call[] = [];
    briefingFetch(calls, "Asia/Shanghai", ZONED_BRIEFING);
    const { view } = draw("/briefing-fixed", "user-zone-start");
    await view.findByRole("list", { name: "清点数字" });
    expect(briefingKinds(calls)).toEqual(["start"]);
    expect(view.getByRole("heading", { level: 1 }).textContent).toBe(
      "开工清点 · 11 月 16 日",
    );
    expect(view.container.querySelector("[data-zone-note]")?.textContent).toBe(
      "时间按你的作息时区（中国标准时间）显示",
    );
    const review = view.getByRole("region", { name: "等你验收" });
    expect(within(review).getByRole("link").textContent).toBe(
      "已交成果客户回访名单小助 · 09:30",
    );
    const doing = within(view.getByRole("region", { name: "还在做" }))
      .getAllByRole("link")
      .map((link) => link.textContent);
    expect(doing).toEqual([
      "已接下核对上月发票小周 · 今天 11:00 到期",
      "已接下合同条款比对小周 · 明早 09:00 到期",
    ]);
    // 服务器写的提醒说「11:00」，同一件活的行也说「11:00」。
    const held = view.getByRole("region", { name: "作息外攒下的提醒" });
    expect(held.textContent).toContain("预计 11:00 交");
    cleanup();

    // 收工那一支：上海 19:00（芝加哥 05:00）。收工清点不列作息外的提醒。
    fixedNow = new Date("2026-11-16T11:00:00Z");
    const endCalls: Call[] = [];
    briefingFetch(endCalls, "Asia/Shanghai", ZONED_BRIEFING);
    const end = draw("/briefing-fixed", "user-zone-end").view;
    await end.findByRole("list", { name: "清点数字" });
    expect(briefingKinds(endCalls)).toEqual(["end"]);
    expect(end.getByRole("heading", { level: 1 }).textContent).toBe(
      "收工清点 · 11 月 16 日",
    );
    expect(end.queryByRole("region", { name: "作息外攒下的提醒" })).toBeNull();
  });
});

test("作息时区和设备一样时不写那行说明", async () => {
  await inBrowserZone("Asia/Shanghai", async () => {
    fixedNow = new Date("2026-11-16T02:00:00Z");
    briefingFetch([], "Asia/Shanghai", ZONED_BRIEFING);
    const { view } = draw("/briefing-fixed", "user-zone-same");
    await view.findByRole("list", { name: "清点数字" });
    expect(view.container.querySelector("[data-zone-note]")).toBeNull();
  });
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
  // 你自己点的「再催」：算一次（上面写「已催 2 次」），但不列在服务器替你盯的经过里。
  {
    id: "o2",
    kind: "nudged",
    actor: "user:me",
    detail: { text: "先交做完的部分" },
    createdAt: ago(38),
  },
  {
    id: "o3",
    kind: "nudged",
    actor: "system",
    detail: { text: "到点了，进度怎么样？" },
    createdAt: ago(35),
  },
  {
    id: "o4",
    kind: "overdue",
    actor: "system",
    detail: { dueAt: ago(40), at: ago(5) },
    createdAt: ago(5),
  },
  {
    id: "o5",
    kind: "notified",
    actor: "system",
    detail: { kind: "overdue", text: "…", result: "sent" },
    createdAt: ago(5),
  },
];

/** 逾期卡详情用到的接口；作息在上海。 */
function overdueFetch() {
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
  return calls;
}

test("逾期卡详情：服务器替你盯过的经过，和设计稿 5 的四个处理按钮（一列、44px 高）", async () => {
  const calls = overdueFetch();
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
      "叫醒小周，问进度（第 2 次）",
      "还没交 → 记为逾期，进看板「只看逾期」",
      "通知你",
    ]),
  );
  expect(watch.textContent).not.toContain("你催了");
  // 「第 2 次」和上面的「已催 2 次」同一个口径。
  expect(within(dialog).getByText(/^逾期 .* · 已催 2 次$/)).toBeTruthy();

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
  // 一个一列、占满宽度，44px 高（设计稿 5；不看屏幕宽度，逾期卡就是这样排）。
  expect(
    within(block).getAllByRole("button")[0]?.parentElement?.className,
  ).not.toContain("sm:flex-row");
  for (const name of buttons) {
    const classes = within(block)
      .getByRole("button", { name: name ?? "" })
      .className.split(/\s+/);
    expect(classes).toContain("w-full");
    expect(classes).toContain("h-11");
  }

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

test("芝加哥的浏览器、上海的作息：卡片详情顶上写明，流水和经过的时刻按上海的钟", async () => {
  await inBrowserZone("America/Chicago", async () => {
    overdueFetch();
    const { view } = draw(`/tasks/${OVERDUE_CARD.id}`, "user-zone-detail");
    const dialog = await view.findByRole("dialog");
    await waitFor(() =>
      expect(dialog.querySelector("[data-zone-note]")?.textContent).toBe(
        "时间按你的作息时区（中国标准时间）显示",
      ),
    );
    const watch = await within(dialog).findByRole("region", {
      name: "服务器替你盯着",
    });
    const now = new Date();
    await waitFor(() =>
      expect(
        within(watch)
          .getAllByRole("listitem")
          .map((item) => item.querySelector("time")?.textContent),
      ).toEqual([
        clockText(ago(35), now, "Asia/Shanghai"),
        clockText(ago(5), now, "Asia/Shanghai"),
        clockText(ago(5), now, "Asia/Shanghai"),
      ]),
    );
    // 上海和芝加哥差 14 小时，按浏览器的钟念出来的是另一个时刻。
    expect(clockText(ago(35), now, "Asia/Shanghai")).not.toBe(
      clockText(ago(35), now),
    );
  });
});

/** 上海的「明天 10:30」那一刻（作息时区在上海）。 */
function shanghaiTomorrowAt(hour: number, minute: number): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(new Date());
  const of = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value);
  return new Date(
    Date.UTC(of("year"), of("month") - 1, of("day") + 1, hour - 8, minute),
  ).toISOString();
}

/** 员工申请延到上海明天 10:30、还没答复的一张卡，弹层用到的接口。`answered` 为真时那条申请已在别处准了。 */
function extensionFetch(
  asked: string,
  state: { answered?: boolean; none?: boolean } = {},
) {
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
      return json({
        events: state.none
          ? []
          : [
              {
                id: "x1",
                kind: "extension_requested",
                actor: `agent:${XIAOZHOU.id}`,
                detail: { dueAt: asked, reason: "C 家明早才回" },
                createdAt: ago(3),
              },
              ...(state.answered
                ? [
                    {
                      id: "x2",
                      kind: "extension_granted",
                      actor: "user:me",
                      detail: { dueAt: asked },
                      createdAt: ago(1),
                    },
                  ]
                : []),
            ],
      });
    if (path === "/api/settings/preferences")
      return json({ preferences: preferences(workHours()) });
    return json({ agents: [] });
  }) as typeof fetch;
  return calls;
}

test("延期弹层：申请是明天 10:30 时，输入框写「明早 10:30」，没改就提交那条申请的原时间并点名它", async () => {
  const asked = shanghaiTomorrowAt(10, 30);
  for (const mode of ["extend", "edit"] as const) {
    const calls = extensionFetch(asked);
    const queryClient = preferencesClient(`user-extend-${mode}`, workHours());
    const view = render(
      <QueryClientProvider client={queryClient}>
        <ExtendDialog card={OVERDUE_CARD} mode={mode} onClose={() => {}} />
      </QueryClientProvider>,
    );
    const input = (await view.findByRole("textbox", {
      name: mode === "edit" ? "改到几点" : "延到几点",
    })) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("明早 10:30"));
    await userEvent.click(
      view.getByRole("button", {
        name: mode === "edit" ? "按这个时间准许" : "准许延期",
      }),
    );
    // 送的是 ISO（服务器 `readDueTime` 直接认），不是「明早 10:30」这段字；申请的时间也一起带上。
    await waitFor(() =>
      expect(
        calls.filter((call) => call.method === "POST").map((call) => call.body),
      ).toEqual([{ decision: "grant", dueAt: asked, requestedDueAt: asked }]),
    );
    expect(Number.isNaN(Date.parse(asked))).toBe(false);
    cleanup();
  }

  // 改了输入框：送你写的话，仍点名答复的是这条申请；「不批」也点名它。
  const calls = extensionFetch(asked);
  const queryClient = preferencesClient("user-extend-typed", workHours());
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ExtendDialog card={OVERDUE_CARD} onClose={() => {}} />
    </QueryClientProvider>,
  );
  const input = (await view.findByRole("textbox", {
    name: "延到几点",
  })) as HTMLInputElement;
  await waitFor(() => expect(input.value).toBe("明早 10:30"));
  fireEvent.change(input, { target: { value: "明天下午三点" } });
  await userEvent.click(view.getByRole("button", { name: "准许延期" }));
  await waitFor(() =>
    expect(
      calls.filter((call) => call.method === "POST").map((call) => call.body),
    ).toEqual([
      { decision: "grant", dueAt: "明天下午三点", requestedDueAt: asked },
    ]),
  );
  cleanup();
  const denyCalls = extensionFetch(asked);
  const denyView = render(
    <QueryClientProvider
      client={preferencesClient("user-extend-deny", workHours())}
    >
      <ExtendDialog card={OVERDUE_CARD} onClose={() => {}} />
    </QueryClientProvider>,
  );
  await userEvent.click(
    await denyView.findByRole("button", { name: "不批，按原时间交" }),
  );
  await waitFor(() =>
    expect(
      denyCalls
        .filter((call) => call.method === "POST")
        .map((call) => call.body),
    ).toEqual([{ decision: "deny", requestedDueAt: asked }]),
  );
});

test("延期弹层开着时那条申请在别处答复了：不再让提交，也不悄悄改成直接改预计时间", async () => {
  const asked = shanghaiTomorrowAt(10, 30);
  const state: { answered?: boolean; none?: boolean } = {};
  const calls = extensionFetch(asked, state);
  const queryClient = preferencesClient("user-extend-moved", workHours());
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ExtendDialog card={OVERDUE_CARD} onClose={() => {}} />
    </QueryClientProvider>,
  );
  const input = (await view.findByRole("textbox", {
    name: "延到几点",
  })) as HTMLInputElement;
  await waitFor(() => expect(input.value).toBe("明早 10:30"));
  fireEvent.change(input, { target: { value: "明天下午三点" } });

  // 另一台设备上准了这条申请；流水重读回来，这条申请已经结了。
  state.answered = true;
  await queryClient.invalidateQueries({ queryKey: ["tasks"] });
  expect((await view.findByRole("alert")).textContent).toBe(
    "这条延期申请已经在别处处理了，关掉弹层看看现在的预计时间。",
  );
  const submit = view.getByRole("button", { name: "准许延期" });
  expect(submit.hasAttribute("disabled")).toBe(true);
  expect(
    view
      .getByRole("button", { name: "不批，按原时间交" })
      .hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.submit(input.closest("form") as HTMLFormElement);
  await settleReactWork();
  expect(calls.filter((call) => call.method !== "GET")).toEqual([]);
  cleanup();

  // 反过来：打开时没有申请（直接改预计时间），开着时员工申请了，也先停下，让人重新打开去答复它。
  const later: { answered?: boolean; none?: boolean } = { none: true };
  const quiet = extensionFetch(asked, later);
  const client2 = preferencesClient("user-extend-appeared", workHours());
  const again = render(
    <QueryClientProvider client={client2}>
      <ExtendDialog card={OVERDUE_CARD} onClose={() => {}} />
    </QueryClientProvider>,
  );
  const field = (await again.findByRole("textbox", {
    name: "延到几点",
  })) as HTMLInputElement;
  await waitFor(() =>
    expect(
      again.getByRole("button", { name: "准许延期" }).hasAttribute("disabled"),
    ).toBe(true),
  );
  fireEvent.change(field, { target: { value: "16:00" } });
  later.none = false;
  await client2.invalidateQueries({ queryKey: ["tasks"] });
  expect((await again.findByRole("alert")).textContent).toBe(
    "员工刚申请了延期，关掉弹层再打开，答复那条申请。",
  );
  fireEvent.submit(field.closest("form") as HTMLFormElement);
  await settleReactWork();
  expect(quiet.filter((call) => call.method !== "GET")).toEqual([]);
});

// ---------------------------------------------------------------- 当作一件活来跟

/** 一张不在跟、员工还在做的卡（普通问答出来的）。 */
const UNTRACKED_CARD = {
  ...OVERDUE_CARD,
  id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  title: "查一下竞品价格",
  tracked: false,
  stage: null,
  acceptedAt: null,
  dueAt: null,
  originalDueAt: null,
  dueReported: false,
  overdueAt: null,
  nudges: 0,
};

/**
 * 跟进接口：`refuse` 给了就按它回 409；否则成功，之后这张卡读出来是在跟、派出 · 待接下。
 */
function trackFetch(refuse?: string) {
  const calls: Call[] = [];
  let tracked = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, path, body: undefined });
    const card = tracked
      ? { ...UNTRACKED_CARD, tracked: true, stage: "pending_accept" }
      : UNTRACKED_CARD;
    if (method === "POST" && path === `/api/tasks/${UNTRACKED_CARD.id}/track`) {
      if (refuse) return json({ error: refuse }, 409);
      tracked = true;
      return json({ ok: true, stage: "pending_accept" });
    }
    if (path === `/api/tasks/${UNTRACKED_CARD.id}/events`)
      return json({ events: [] });
    if (path === `/api/tasks/${UNTRACKED_CARD.id}`) return json({ task: card });
    if (path.startsWith("/api/tasks")) return json({ tasks: [card] });
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
  return calls;
}

const tracks = (calls: Call[]) =>
  calls.filter(
    (call) =>
      call.method === "POST" &&
      call.path === `/api/tasks/${UNTRACKED_CARD.id}/track`,
  );

test("卡片详情：不在跟的卡点「当作一件活来跟」，发 POST /track，卡进三步", async () => {
  const calls = trackFetch();
  const { view } = draw(`/tasks/${UNTRACKED_CARD.id}`);
  const dialog = await view.findByRole("dialog");
  await userEvent.click(
    await within(dialog).findByRole("button", { name: "当作一件活来跟" }),
  );
  await waitFor(() => expect(tracks(calls)).toHaveLength(1));
  // 重读回来是在跟的卡：四步进度出来了，按钮没了。
  await within(dialog).findByRole("list", { name: "进度" });
  expect(
    within(dialog).queryByRole("button", { name: "当作一件活来跟" }),
  ).toBeNull();
});

test("当作一件活来跟被拒（接活功能关着）：说人话，不露工具名", async () => {
  trackFetch("这位员工的接活工具（accept_task）已关闭，不能当作一件活来跟。");
  const { view } = draw(`/tasks/${UNTRACKED_CARD.id}`);
  const dialog = await view.findByRole("dialog");
  await userEvent.click(
    await within(dialog).findByRole("button", { name: "当作一件活来跟" }),
  );
  expect((await within(dialog).findByRole("alert")).textContent).toBe(
    "这位员工的接活功能已关闭，不能当作一件活来跟。",
  );
  // 服务器给的不是中文原话时，按动作写好的中文。
  cleanup();
  trackFetch("Already followed.");
  const again = draw(`/tasks/${UNTRACKED_CARD.id}`).view;
  const second = await again.findByRole("dialog");
  await userEvent.click(
    await within(second).findByRole("button", { name: "当作一件活来跟" }),
  );
  expect((await within(second).findByRole("alert")).textContent).toBe(
    "这件活现在不能当作一件活来跟：已经在跟、已经结束，或这位员工不接活。",
  );
});

test("看板上不在三步里、还没结束的卡也有「当作一件活来跟」，跟了以后移进三步收货", async () => {
  const calls = trackFetch();
  const { view } = draw("/tasks");
  const button = await view.findByRole("button", { name: "当作一件活来跟" });
  await userEvent.click(button);
  await waitFor(() => expect(tracks(calls)).toHaveLength(1));

  // 跟了以后它从原来的列表移到上面「三步收货」里，原来那一行的按钮没了。
  await waitFor(() =>
    expect(view.queryByRole("button", { name: "当作一件活来跟" })).toBeNull(),
  );
});

test("侧栏目标：不在跟、还没结束的卡给「当作一件活来跟」，在跟的、结束的不给", async () => {
  const calls = trackFetch();
  const view = renderGoal(
    <GoalBody
      goal={goal({ taskId: UNTRACKED_CARD.id, stage: null, status: "running" })}
      pending={null}
    />,
  );
  await userEvent.click(view.getByRole("button", { name: "当作一件活来跟" }));
  await waitFor(() => expect(tracks(calls)).toHaveLength(1));
  cleanup();
  for (const shown of [
    goal({ taskId: UNTRACKED_CARD.id, stage: "accepted" }),
    goal({ taskId: UNTRACKED_CARD.id, stage: null, status: "done" }),
    goal({ stage: null, status: "running" }),
  ]) {
    const other = renderGoal(<GoalBody goal={shown} pending={null} />);
    expect(other.queryByRole("button", { name: "当作一件活来跟" })).toBeNull();
    cleanup();
  }
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

/** 侧栏目标读作息时区（「预计 … 交」），要有查询客户端；作息是上海。 */
function renderGoal(ui: ReactElement) {
  const queryClient = preferencesClient("user-goal", workHours());
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

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
  const delivered = renderGoal(
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

  const late = renderGoal(
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

  const pendingAccept = renderGoal(
    <GoalBody goal={goal({ stage: "pending_accept" })} pending={null} />,
  );
  expect(segmentsOf(pendingAccept)?.states).toEqual([
    "current",
    "todo",
    "todo",
    "todo",
  ]);
  cleanup();

  const reviewed = renderGoal(
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

  const cancelled = renderGoal(
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
  const untracked = renderGoal(
    <GoalBody goal={goal({ stage: null, lastCheck: "在做" })} pending={null} />,
  );
  expect(segmentsOf(untracked)).toBeNull();
  expect(untracked.getByText("第 4 轮 · 上次检查：在做")).toBeTruthy();
});
