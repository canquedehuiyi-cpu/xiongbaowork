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
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
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
afterEach(() => {
  cleanup();
  calls.length = 0;
  globalThis.fetch = originalFetch;
});

const originalFetch = globalThis.fetch;
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
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
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
