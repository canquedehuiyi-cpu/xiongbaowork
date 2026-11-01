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
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentProfile } from "@/lib/agents/queries";
import { agentKeys } from "@/lib/agents/queries";
import {
  type AutonomousSummary,
  autonomousKeys,
} from "@/lib/autonomous/queries";
import { routineKeys } from "@/lib/routines/queries";
import { Route as AutonomousRoute } from "@/routes/_authed/_app/autonomous";
import { settleReactWork } from "./settle-react-work";

/**
 * Ticket 020 acceptance at the screen that answers "what has it been doing" (spec C1).
 *
 * The reads are seeded because what is worth asserting is the writes: a pause, and since decision D-2
 * (spec C4) a new routine made from this page -- through the same store a Bot's tool uses, so the
 * floor and the ceiling are the server's, and its refusal is shown as it was said.
 */
/**
 * Registered only if a previous file in the same process left it registered.
 *
 * Happy-DOM is one global per process and bun runs a suite's files in it, so a second
 * `register()` throws — and the throw lands in `beforeAll`, which takes every test in the file with
 * it. The suite's count then drops without any test visibly failing, which is the worst way to lose
 * coverage.
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
  // Drain React before the document goes away, for the reason recorded in `settle-react-work.ts`.
  await settleReactWork();
  GlobalRegistrator.unregister();
});
afterEach(async () => {
  cleanup();
  try {
    await Promise.all(drawnClients.map(client => client.cancelQueries()));
  } finally {
    for (const client of drawnClients) client.clear();
    drawnClients.length = 0;
    calls.length = 0;
    globalThis.fetch = originalFetch;
  }
});

const originalFetch = globalThis.fetch;
const drawnClients: QueryClient[] = [];
const calls: { method: string; path: string; body: unknown }[] = [];
const writes = () => calls.filter((entry) => entry.method !== "GET");

const librarian: AgentProfile = {
  id: "agent-night",
  name: "Night Librarian",
  title: "Watches the stacks",
  roleDescription: "Summarises arrivals.",
  avatarSeed: "nl",
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

const summary: AutonomousSummary = {
  agentId: "agent-night",
  routines: [
    {
      id: "routine-1",
      instruction: "Summarise the day's arrivals.",
      enabled: true,
      nextRunAt: new Date(Date.now() + 3_600_000).toISOString(),
      channelId: "channel-1",
      lastRun: {
        status: "succeeded",
        at: new Date(Date.now() - 86_400_000).toISOString(),
      },
    },
  ],
  responsibilities: [
    {
      id: "goal-1",
      title: "Watch the finance inbox",
      status: "active",
      channelId: "channel-1",
      lastRun: null,
    },
  ],
  proactive: [
    {
      id: "proactive-1",
      focus: "Anything the day left unfinished.",
      enabled: false,
      intervalMinutes: 240,
      nextRunAt: new Date(Date.now() + 600_000).toISOString(),
      lastRunAt: null,
      lastStatus: "idle",
    },
  ],
  lastActivityAt: new Date(Date.now() - 86_400_000).toISOString(),
};

function draw(over: Partial<AutonomousSummary> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  drawnClients.push(queryClient);
  queryClient.setQueryData(agentKeys.list(false), [librarian]);
  queryClient.setQueryData(autonomousKeys.forAgent("agent-night"), {
    ...summary,
    ...over,
  });
  queryClient.setQueryData(routineKeys.list(), []);
  const root = createRootRoute({ component: () => <Outlet /> });
  const router = createRouter({
    context: {},
    history: createMemoryHistory({ initialEntries: ["/autonomous"] }),
    routeTree: root.addChildren([
      AutonomousRoute.update({
        getParentRoute: () => root,
        path: "/autonomous",
      } as never),
      createRoute({
        getParentRoute: () => root,
        path: "/responsibilities",
        component: () => null,
      } as never),
    ]),
  });
  return Object.assign(render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  ), { queryClient });
}

test("the schedules, the goals and the check-ins read as this coworker's own", async () => {
  const screen = draw();

  expect(await screen.findByText("Summarise the day's arrivals.")).toBeTruthy();
  // Next firing and last outcome on the same line, which is the one question the page is opened for.
  expect(screen.getByText(/上一次成功/)).toBeTruthy();
  expect(screen.getByText(/已开启/)).toBeTruthy();
  expect(screen.getByText("Watch the finance inbox")).toBeTruthy();
  expect(screen.getByText(/从未运行过/)).toBeTruthy();
  // Matched loosely on purpose: relative time is `Intl`-formatted and answers "yesterday" rather
  // than "1 day ago" depending on locale, and this assertion is about the line existing, not ICU.
  expect(screen.getByText(/最近一次无人值守的工作在/)).toBeTruthy();
});

test("pausing writes through the routine store's own endpoint", async () => {
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    calls.push({
      method: init?.method ?? "GET",
      path: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if ((init?.method ?? "GET") === "GET") {
      return Response.json({ routines: [], autonomous: summary });
    }
    return Response.json({ ok: true });
  }) as typeof fetch;

  const screen = draw();
  await screen.findByText("Summarise the day's arrivals.");
  await userEvent.click(screen.getByRole("button", { name: "暂停" }));

  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(writes()[0]?.path).toBe("/api/routines/routine-1/enabled");
  expect(writes()[0]?.body).toEqual({ enabled: false });
});

test("with nothing scheduled the page offers both ways to make one", async () => {
  const screen = draw({ routines: [], responsibilities: [], proactive: [] });

  expect(await screen.findByText(/还没有安排任何定时任务/)).toBeTruthy();
  // The old sentence said the opposite -- "not on this page" -- and has to be gone with the form here.
  expect(screen.queryByText(/不在这个页面上/)).toBeNull();
  expect(screen.getByRole("button", { name: "新建定时任务" })).toBeTruthy();
});

/**
 * The conversations the night librarian is in: one with it alone and one group. Two, so leaving the
 * picker on "自动" is exactly the case the server refuses, and one stopped conversation it must not
 * offer.
 */
const CHANNELS = [
  {
    id: "channel-1",
    name: "Night Librarian",
    agentIds: ["agent-night"],
    active: true,
  },
  {
    id: "channel-group",
    name: "值班组",
    agentIds: ["agent-night", "agent-day"],
    active: true,
  },
  {
    id: "channel-old",
    name: "旧对话",
    agentIds: ["agent-night"],
    active: false,
  },
  {
    id: "channel-other",
    name: "别人的",
    agentIds: ["agent-day"],
    active: true,
  },
];

/** The stub for the create path: reads answer the fixtures, the POST answers whatever the case asks. */
function serveCreate(answer: () => Response) {
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    calls.push({
      method: init?.method ?? "GET",
      path: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if ((init?.method ?? "GET") === "GET") {
      if (String(input).startsWith("/api/channels")) {
        return Response.json({ channels: CHANNELS, nextCursor: null });
      }
      return Response.json({ routines: [], autonomous: summary });
    }
    return answer();
  }) as typeof fetch;
}

test("a routine made here is posted to the store as who, what and a cron in this person's time zone", async () => {
  serveCreate(() =>
    Response.json({ routine: { id: "routine-2" } }, { status: 201 }),
  );
  const screen = draw({ routines: [] });

  await userEvent.click(
    await screen.findByRole("button", { name: "新建定时任务" }),
  );
  const submit = screen.getByRole("button", { name: "建立定时任务" });
  // Nothing to do yet, so nothing to press.
  expect(submit.hasAttribute("disabled")).toBe(true);

  await userEvent.type(screen.getByLabelText("执行指令"), "汇总昨天的新工单");
  fireEvent.change(screen.getByLabelText("频率"), {
    target: { value: "weekly" },
  });
  fireEvent.change(await screen.findByLabelText("星期"), {
    target: { value: "3" },
  });
  await userEvent.click(screen.getByRole("button", { name: "建立定时任务" }));

  await waitFor(() => expect(writes()).toHaveLength(1));
  const sent = writes()[0];
  expect(sent?.path).toBe("/api/routines");
  expect(sent?.body).toMatchObject({
    agentId: "agent-night",
    instruction: "汇总昨天的新工单",
    cron: "0 9 * * 3",
  });
  const body = (sent?.body ?? {}) as { timezone?: unknown };
  expect(typeof body.timezone).toBe("string");
  // Made, so the form folds away and the press is not offered twice.
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "建立定时任务" })).toBeNull(),
  );
});

test("the store's refusal is shown in its own words, and the form stays open to fix it", async () => {
  serveCreate(() =>
    Response.json({ error: "定时任务之间至少要隔 15 分钟。" }, { status: 400 }),
  );
  const screen = draw({ routines: [] });

  await userEvent.click(
    await screen.findByRole("button", { name: "新建定时任务" }),
  );
  await userEvent.type(screen.getByLabelText("执行指令"), "盯着收件箱");
  fireEvent.change(screen.getByLabelText("频率"), {
    target: { value: "cron" },
  });
  await userEvent.type(
    await screen.findByLabelText("cron 表达式"),
    "*/5 * * * *",
  );
  await userEvent.click(screen.getByRole("button", { name: "建立定时任务" }));

  expect((await screen.findByRole("alert")).textContent).toBe(
    "定时任务之间至少要隔 15 分钟。",
  );
  expect(screen.getByRole("button", { name: "建立定时任务" })).toBeTruthy();
});

test("a routine can be pointed at one of the coworker's conversations, a group included", async () => {
  serveCreate(() =>
    Response.json({ routine: { id: "routine-3" } }, { status: 201 }),
  );
  const screen = draw({ routines: [] });

  await userEvent.click(
    await screen.findByRole("button", { name: "新建定时任务" }),
  );
  const picker = screen.getByLabelText("汇报到哪段对话") as HTMLSelectElement;
  // Its live conversations only: not a stopped one, and not one it is not in.
  await waitFor(() =>
    expect(Array.from(picker.options).map((option) => option.value)).toEqual([
      "",
      "channel-1",
      "channel-group",
    ]),
  );
  fireEvent.change(picker, { target: { value: "channel-group" } });
  await userEvent.type(screen.getByLabelText("执行指令"), "每天早上汇报");
  await userEvent.click(screen.getByRole("button", { name: "建立定时任务" }));

  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(writes()[0]?.body).toMatchObject({ channelId: "channel-group" });
});

test("left on automatic, the request carries no conversation for the server to second-guess", async () => {
  serveCreate(() =>
    Response.json({ routine: { id: "routine-4" } }, { status: 201 }),
  );
  const screen = draw({ routines: [] });

  await userEvent.click(
    await screen.findByRole("button", { name: "新建定时任务" }),
  );
  await userEvent.type(screen.getByLabelText("执行指令"), "每天早上汇报");
  await userEvent.click(screen.getByRole("button", { name: "建立定时任务" }));

  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(writes()[0]?.body).not.toHaveProperty("channelId");
});

test("a full allowance says to switch one off, and keeps the server's own words", async () => {
  serveCreate(() =>
    Response.json(
      { error: "You already have 20 routines switched on." },
      { status: 409 },
    ),
  );
  const screen = draw({ routines: [] });

  await userEvent.click(
    await screen.findByRole("button", { name: "新建定时任务" }),
  );
  await userEvent.type(screen.getByLabelText("执行指令"), "每天早上汇报");
  await userEvent.click(screen.getByRole("button", { name: "建立定时任务" }));

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("先关掉一条再建");
  expect(alert.textContent).toContain(
    "You already have 20 routines switched on.",
  );
  // Nothing in the form is wrong, so nothing in it is drawn as an error.
  expect(alert.querySelector(".text-destructive")).toBeNull();
});

// These definitions retain the real page, router, query cache, mutations and client.
test("delete waits for 204 and a fresh summary, invalidates routine caches and blocks duplicate clicks", async () => {
  const id = "routine/delete ?#";
  const row = { ...summary.routines[0]!, id };
  const releaseDelete = Promise.withResolvers<void>();
  const releaseSummary = Promise.withResolvers<void>();
  const deleting = Promise.withResolvers<void>();
  const refreshing = Promise.withResolvers<void>();
  let parses = 0;
  const noContent = new Response(null, { status: 204 });
  noContent.json = async () => { parses++; throw new Error("204 must not be parsed"); };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input), method = init?.method ?? "GET";
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null });
    expect(init?.credentials).toBe("include");
    if (method === "DELETE") {
      expect(path).toBe(`/api/routines/${encodeURIComponent(id)}`);
      deleting.resolve(); await releaseDelete.promise; return noContent;
    }
    if (method === "GET" && path === "/api/agents/agent-night/autonomous") {
      refreshing.resolve(); await releaseSummary.promise;
      return Response.json({ autonomous: { ...summary, routines: [] } });
    }
    throw new Error("Unexpected delete fixture request; never forward");
  }) as typeof fetch;
  const screen = draw({ routines: [row] });
  screen.queryClient.setQueryData(routineKeys.runs(id), []);
  const inactiveKey = autonomousKeys.forAgent("agent-other-inactive");
  const inactiveSummary = { ...summary, agentId: "agent-other-inactive" };
  screen.queryClient.setQueryData(inactiveKey, inactiveSummary);
  expect(screen.queryClient.getQueryState(inactiveKey)?.isInvalidated).toBe(false);
  expect(screen.queryClient.getQueryCache().find({ queryKey: inactiveKey, exact: true })?.getObserversCount()).toBe(0);
  try {
    const button = await screen.findByRole("button", { name: "删除" });
    act(() => { fireEvent.click(button); fireEvent.click(button); });
    await deleting.promise;
    // Try the same control while the DELETE Response is still held back.
    await userEvent.click(button);
    expect(writes()).toHaveLength(1);
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(row.instruction)).toBeTruthy();
    releaseDelete.resolve();
    await refreshing.promise;
    expect(screen.queryClient.getQueryState(routineKeys.list())?.isInvalidated).toBe(true);
    expect(screen.queryClient.getQueryState(routineKeys.runs(id))?.isInvalidated).toBe(true);
    // An inactive second agent proves family invalidation, not just this view.
    expect(screen.queryClient.getQueryState(inactiveKey)?.isInvalidated).toBe(true);
    expect(screen.queryClient.getQueryData(inactiveKey)).toEqual(inactiveSummary);
    // DELETE has acknowledged, but the summary still has not answered.
    await userEvent.click(button);
    expect(writes()).toHaveLength(1);
    expect(parses).toBe(0);
    // Even after DELETE ACK, no optimistic removal before the real summary GET.
    expect(screen.getByText(row.instruction)).toBeTruthy();
    expect(button.hasAttribute("disabled")).toBe(true);
    releaseSummary.resolve();
    await waitFor(() => expect(screen.queryByText(row.instruction)).toBeNull());
    expect(await screen.findByText(/还没有安排任何定时任务/)).toBeTruthy();
    expect(writes()).toHaveLength(1);
    expect(calls.filter(call => call.method === "GET")).toHaveLength(1);
    expect(parses).toBe(0);
  } finally {
    releaseDelete.resolve(); releaseSummary.resolve();
    await settleReactWork();
  }
});

test("a refused delete keeps its row, shows the server error and leaves caches intact", async () => {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, path: String(input), body: null });
    expect(method).toBe("DELETE");
    expect(String(input)).toBe("/api/routines/routine-1");
    return Response.json({ error: "这条定时任务不存在，或者你不能删除它。" }, { status: 404 });
  }) as typeof fetch;
  const screen = draw();
  await userEvent.click(await screen.findByRole("button", { name: "删除" }));
  expect((await screen.findByRole("alert")).textContent).toContain("这条定时任务不存在，或者你不能删除它。");
  expect(screen.getByText("Summarise the day's arrivals.")).toBeTruthy();
  await waitFor(() => expect(screen.getByRole("button", { name: "删除" }).hasAttribute("disabled")).toBe(false));
  expect(writes()).toHaveLength(1);
  expect(calls.some(call => call.method === "GET")).toBe(false);
  expect(screen.queryClient.getQueryState(routineKeys.list())?.isInvalidated).toBe(false);
  expect(screen.queryClient.getQueryState(autonomousKeys.forAgent("agent-night"))?.isInvalidated).toBe(false);
});

test("enabled proactive work shows the server's next plan, including an expired plan, without claiming a firing", async () => {
  for (const nextRunAt of ["2099-01-02T03:04:05.000Z", "2001-01-02T03:04:05.000Z"]) {
    const screen = draw({ proactive: [{ ...summary.proactive[0]!, enabled: true, nextRunAt }] });
    const time = await screen.findByLabelText("主动巡检下次计划");
    expect(time.getAttribute("datetime")).toBe(nextRunAt);
    expect(time.getAttribute("title")).toBe(nextRunAt);
    expect(screen.getByText(/仅为计划/)).toBeTruthy();
    expect(screen.getByText(/从未运行过/)).toBeTruthy();
    screen.unmount();
  }
  const disabled = draw();
  await disabled.findByText("Anything the day left unfinished.");
  expect(disabled.queryByLabelText("主动巡检下次计划")).toBeNull();
});

test("the real screen distinguishes open routines, never-fired work and unknown outcomes", async () => {
  const at = "2026-10-31T11:00:00.000Z";
  const row = summary.routines[0]!;
  const goal = summary.responsibilities[0]!;
  const screen = draw({
    routines: [
      { ...row, id: "open-null", instruction: "Open legacy outcome", lastRun: { status: null, at } },
      { ...row, id: "open-running", instruction: "Open projected outcome", lastRun: { status: "running", at } },
      { ...row, id: "never", instruction: "Never fired", lastRun: null },
      { ...row, id: "future", instruction: "Future outcome", lastRun: { status: "future_status", at } },
      { ...row, id: "empty-start", instruction: "Missing start", lastRun: { status: null, at: "" } },
      { ...row, id: "bad-start", instruction: "Invalid start", lastRun: { status: null, at: "not-a-date" } },
    ],
    responsibilities: [
      { ...goal, id: "unknown-at", status: "paused", lastRun: { status: null, at } },
      { ...goal, id: "unknown-no-start", status: "paused", lastRun: { status: null, at: null } },
    ],
  });
  await screen.findByText("Open legacy outcome");
  expect(screen.getAllByText(/正在进行（开始于/)).toHaveLength(2);
  expect(screen.getByText(/从未触发过/)).toBeTruthy();
  expect(screen.getByText(/上一次future_status/)).toBeTruthy();
  expect(screen.getAllByText(/上一次结果未知/)).toHaveLength(2);
  expect(screen.getAllByText(/结果未知（无开始时间）/)).toHaveLength(2);
  expect(screen.queryByText(/上一次成功/)).toBeNull();
});

test("a create 404 retains both its existing explanation and the server's words", async () => {
  serveCreate(() => Response.json({ error: "Fixture coworker unavailable" }, { status: 404 }));
  const screen = draw({ routines: [] });
  await userEvent.click(await screen.findByRole("button", { name: "新建定时任务" }));
  await userEvent.type(screen.getByLabelText("执行指令"), "每天早上汇报");
  await userEvent.click(screen.getByRole("button", { name: "建立定时任务" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("没有这位员工，或者你用不了它。");
  expect(alert.textContent).toContain("Fixture coworker unavailable");
  expect(screen.getByRole("button", { name: "建立定时任务" })).toBeTruthy();
});
