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
import { cleanup, render, waitFor } from "@testing-library/react";
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
 * Spec C1's 启停开关 on 自主工作 for responsibilities and proactive check-ins.
 *
 * The real page, router, query cache, mutations and client; only `fetch` is a fixture. What is
 * asserted is the write each switch makes (the stores' existing pause/resume and PATCH), that it moves
 * before the server answers, that a refusal puts it back and shows the server's sentence as it was
 * said, and that someone who cannot manage the coworker cannot move it at all.
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
afterEach(async () => {
  cleanup();
  try {
    await Promise.all(drawn.map((client) => client.cancelQueries()));
  } finally {
    for (const client of drawn) client.clear();
    drawn.length = 0;
    calls.length = 0;
    globalThis.fetch = originalFetch;
  }
});

const originalFetch = globalThis.fetch;
const drawn: QueryClient[] = [];
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
  routines: [],
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
  lastActivityAt: null,
};

const GOAL_SWITCH = "长期职责开关：Watch the finance inbox";
const CHECK_SWITCH = "主动巡检开关：Anything the day left unfinished.";

type Answer = (method: string, path: string) => Promise<Response> | Response;

/** Every request is recorded; the case decides each answer. */
function serve(answer: Answer) {
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const method = init?.method ?? "GET";
    const path = String(input);
    calls.push({
      method,
      path,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return answer(method, path);
  }) as typeof fetch;
}

function draw(
  options: {
    agent?: Partial<AgentProfile>;
    over?: Partial<AutonomousSummary>;
  } = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  drawn.push(queryClient);
  queryClient.setQueryData(agentKeys.list(false), [
    { ...librarian, ...options.agent },
  ]);
  queryClient.setQueryData(autonomousKeys.forAgent("agent-night"), {
    ...summary,
    ...options.over,
  });
  queryClient.setQueryData(routineKeys.list(), []);
  const root = createRootRoute({ component: () => <Outlet /> });
  const router = createRouter({
    context: {},
    history: createMemoryHistory({ initialEntries: ["/autonomous?view=agents"] }),
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
  const user = userEvent.setup({ document });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, user, queryClient };
}

const checked = (element: HTMLElement) => element.getAttribute("aria-checked");
const isDisabled = (element: HTMLElement) =>
  element.hasAttribute("data-disabled") ||
  element.getAttribute("aria-disabled") === "true" ||
  element.hasAttribute("disabled");

test("switching a responsibility off pauses it through its own endpoint, moving before the server answers", async () => {
  const release = Promise.withResolvers<void>();
  serve(async (method, path) => {
    if (method === "POST") {
      await release.promise;
      return Response.json({ responsibility: { id: "goal-1" } });
    }
    expect(path).toBe("/api/agents/agent-night/autonomous");
    return Response.json({
      autonomous: {
        ...summary,
        responsibilities: [
          { ...summary.responsibilities[0]!, status: "paused" },
        ],
      },
    });
  });
  const { view, user, queryClient } = draw();
  try {
    const toggle = await view.findByRole("switch", { name: GOAL_SWITCH });
    expect(checked(toggle)).toBe("true");
    await user.click(toggle);

    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({
      method: "POST",
      path: "/api/responsibilities/goal-1/pause",
      body: null,
    });
    // Optimistic: off already, while the server still holds its answer, and not pressable twice.
    await waitFor(() => expect(checked(toggle)).toBe("false"));
    expect(isDisabled(toggle)).toBe(true);
    expect(view.getByText(/已暂停/)).toBeTruthy();

    release.resolve();
    // Settled: the summary is asked again rather than trusted from the guess.
    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.method === "GET" &&
            call.path === "/api/agents/agent-night/autonomous",
        ),
      ).toBe(true),
    );
    await waitFor(() => expect(isDisabled(toggle)).toBe(false));
    expect(checked(toggle)).toBe("false");
    expect(view.queryByRole("alert")).toBeNull();
    expect(writes()).toHaveLength(1);
    expect(
      queryClient.getQueryData<AutonomousSummary>(
        autonomousKeys.forAgent("agent-night"),
      )?.responsibilities[0]?.status,
    ).toBe("paused");
  } finally {
    release.resolve();
    await settleReactWork();
  }
});

test("switching a paused responsibility on resumes it", async () => {
  serve((method) =>
    method === "POST"
      ? Response.json({ responsibility: { id: "goal-1" } })
      : Response.json({ autonomous: summary }),
  );
  const { view, user } = draw({
    over: {
      responsibilities: [{ ...summary.responsibilities[0]!, status: "paused" }],
    },
  });
  const toggle = await view.findByRole("switch", { name: GOAL_SWITCH });
  expect(checked(toggle)).toBe("false");
  await user.click(toggle);

  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(writes()[0]?.path).toBe("/api/responsibilities/goal-1/resume");
  expect(writes()[0]?.method).toBe("POST");
  await settleReactWork();
});

test("switching a check-in on patches the setting's enabled flag and refreshes every summary", async () => {
  serve((method) =>
    method === "PATCH"
      ? Response.json({ setting: { id: "proactive-1", enabled: true } })
      : Response.json({
          autonomous: {
            ...summary,
            proactive: [{ ...summary.proactive[0]!, enabled: true }],
          },
        }),
  );
  const { view, user, queryClient } = draw();
  // Another coworker's summary nobody is looking at: refreshed too, since the overview shows it.
  const otherKey = autonomousKeys.forAgent("agent-other");
  queryClient.setQueryData(otherKey, { ...summary, agentId: "agent-other" });

  const toggle = await view.findByRole("switch", { name: CHECK_SWITCH });
  expect(checked(toggle)).toBe("false");
  await user.click(toggle);

  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(writes()[0]).toEqual({
    method: "PATCH",
    path: "/api/proactive/settings/proactive-1",
    body: { enabled: true },
  });
  await waitFor(() => expect(checked(toggle)).toBe("true"));
  await waitFor(() =>
    expect(queryClient.getQueryState(otherKey)?.isInvalidated).toBe(true),
  );
  await settleReactWork();
});

test("a refused switch moves back and shows the server's sentence as it was said", async () => {
  const sentence = "Background research is already set up for this Bot.";
  // The refresh after the refusal never answers, so what is drawn is the rollback, not a refetch.
  const never = new Promise<Response>(() => {});
  serve((method) =>
    method === "PATCH"
      ? Response.json({ error: sentence }, { status: 400 })
      : never,
  );
  const { view, user, queryClient } = draw();
  const toggle = await view.findByRole("switch", { name: CHECK_SWITCH });
  await user.click(toggle);

  expect((await view.findByRole("alert")).textContent).toBe(sentence);
  expect(checked(toggle)).toBe("false");
  expect(
    queryClient.getQueryData<AutonomousSummary>(
      autonomousKeys.forAgent("agent-night"),
    )?.proactive[0]?.enabled,
  ).toBe(false);
  expect(view.getByText(/已关闭/)).toBeTruthy();
  expect(writes()).toHaveLength(1);
  await waitFor(() => expect(isDisabled(toggle)).toBe(false));
});

test("a refused pause puts the responsibility back on, with the server's words", async () => {
  const sentence = "No such responsibility.";
  const never = new Promise<Response>(() => {});
  serve((method) =>
    method === "POST"
      ? Response.json({ error: sentence }, { status: 404 })
      : never,
  );
  const { view, user } = draw();
  const toggle = await view.findByRole("switch", { name: GOAL_SWITCH });
  await user.click(toggle);

  expect((await view.findByRole("alert")).textContent).toBe(sentence);
  expect(checked(toggle)).toBe("true");
  expect(view.getByText(/进行中/)).toBeTruthy();
});

test("a refusal puts back only its own switch, and nothing is refetched while another switch still waits", async () => {
  const sentence = "No such responsibility.";
  const refuseGoal = Promise.withResolvers<void>();
  const answerCheck = Promise.withResolvers<void>();
  const never = new Promise<Response>(() => {});
  serve(async (method) => {
    if (method === "POST") {
      await refuseGoal.promise;
      return Response.json({ error: sentence }, { status: 404 });
    }
    if (method === "PATCH") {
      await answerCheck.promise;
      return Response.json({ setting: { id: "proactive-1", enabled: true } });
    }
    return never;
  });
  const { view, user } = draw();
  try {
    const goal = await view.findByRole("switch", { name: GOAL_SWITCH });
    const check = view.getByRole("switch", { name: CHECK_SWITCH });
    // The pause goes out first and waits; the check-in is switched on while it waits.
    await user.click(goal);
    await waitFor(() => expect(writes()).toHaveLength(1));
    await user.click(check);
    await waitFor(() => expect(writes()).toHaveLength(2));
    await waitFor(() => expect(checked(check)).toBe("true"));

    refuseGoal.resolve();
    expect((await view.findByRole("alert")).textContent).toBe(sentence);
    expect(checked(goal)).toBe("true");
    // The waiting check-in keeps its new position: the pause's refusal is not a snapshot of the page.
    expect(checked(check)).toBe("true");
    expect(isDisabled(check)).toBe(true);
    expect(calls.filter((call) => call.method === "GET")).toHaveLength(0);

    answerCheck.resolve();
    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.method === "GET" &&
            call.path === "/api/agents/agent-night/autonomous",
        ),
      ).toBe(true),
    );
    expect(checked(check)).toBe("true");
  } finally {
    refuseGoal.resolve();
    answerCheck.resolve();
    await settleReactWork();
  }
});

test("someone who cannot manage the coworker sees both switches but cannot move them", async () => {
  serve(() => {
    throw new Error("no request is expected");
  });
  const { view, user } = draw({ agent: { canManage: false, mine: false } });
  const goal = await view.findByRole("switch", { name: GOAL_SWITCH });
  const check = view.getByRole("switch", { name: CHECK_SWITCH });
  for (const toggle of [goal, check]) {
    expect(isDisabled(toggle)).toBe(true);
    await user.click(toggle);
  }
  expect(checked(goal)).toBe("true");
  expect(checked(check)).toBe("false");
  expect(calls).toHaveLength(0);
});

test("a completed responsibility has nothing to switch on", async () => {
  serve(() => {
    throw new Error("no request is expected");
  });
  const { view, user } = draw({
    over: {
      responsibilities: [
        { ...summary.responsibilities[0]!, status: "completed" },
      ],
    },
  });
  const toggle = await view.findByRole("switch", { name: GOAL_SWITCH });
  expect(checked(toggle)).toBe("false");
  expect(isDisabled(toggle)).toBe(true);
  await user.click(toggle);
  expect(calls).toHaveLength(0);
  // The check-in beside it is still this person's to switch.
  expect(isDisabled(view.getByRole("switch", { name: CHECK_SWITCH }))).toBe(
    false,
  );
});

test("on 全部员工 the same switches work, and another person's coworker is not switchable", async () => {
  const stranger = {
    ...summary,
    agentId: "agent-day",
    responsibilities: [
      { ...summary.responsibilities[0]!, id: "goal-day", title: "Day watch" },
    ],
    proactive: [],
  };
  let switched = false;
  serve((method, path) => {
    if (method === "PATCH") {
      switched = true;
      return Response.json({ setting: { id: "proactive-1" } });
    }
    if (path === "/api/agents/autonomous/all")
      return Response.json({
        autonomous: [
          {
            ...summary,
            proactive: [{ ...summary.proactive[0]!, enabled: switched }],
          },
          stranger,
        ],
      });
    if (path === "/api/automations") return Response.json({ automations: [] });
    return Response.json({ autonomous: summary });
  });
  const { view, user, queryClient } = draw();
  queryClient.setQueryData(agentKeys.list(false), [
    librarian,
    {
      ...librarian,
      id: "agent-day",
      name: "Day Clerk",
      canManage: false,
      mine: false,
    },
  ]);
  await user.click(await view.findByRole("button", { name: "全部员工" }));

  const dayGoal = await view.findByRole("switch", {
    name: "长期职责开关：Day watch",
  });
  expect(isDisabled(dayGoal)).toBe(true);
  const check = view.getByRole("switch", { name: CHECK_SWITCH });
  expect(isDisabled(check)).toBe(false);
  await user.click(check);

  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(writes()[0]).toEqual({
    method: "PATCH",
    path: "/api/proactive/settings/proactive-1",
    body: { enabled: true },
  });
  await waitFor(() => expect(checked(check)).toBe("true"));
  await settleReactWork();
});
