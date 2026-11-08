import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
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
import { AutomationsSection } from "@/components/automations/automations-section";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import {
  type Automation,
  type AutomationTrigger,
  automationHookPath,
  automationKeys,
  automationState,
} from "@/lib/automations/queries";
import { autonomousKeys } from "@/lib/autonomous/queries";
import { Route as AutonomousRoute } from "@/routes/_authed/_app/autonomous";
import { settleReactWork } from "./settle-react-work";

/**
 * D06 AUT1/AUT2/AUT4 and C1 on the 自主工作 page: the automations list with each one's triggers,
 * runs used against its cap and where it stands, pause / resume / delete through the management API,
 * and a Hook / API secret that is shown once and never again.
 */
let registeredHere = false;
beforeAll(() => {
  if (!("document" in globalThis)) {
    GlobalRegistrator.register();
    registeredHere = true;
  }
});
afterEach(async () => {
  cleanup();
  for (const client of clients) {
    await client.cancelQueries();
    client.clear();
  }
  clients.length = 0;
  calls.length = 0;
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  if (!registeredHere) return;
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = globalThis.fetch;
const clients: QueryClient[] = [];
const calls: { method: string; path: string; body: unknown }[] = [];
const writes = () => calls.filter((entry) => entry.method !== "GET");

const bear: AgentProfile = {
  id: "agent-bear",
  name: "熊宝",
  title: "",
  roleDescription: "",
  avatarSeed: "bear",
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

const HOUR = 3_600_000;
const later = (hours: number) =>
  new Date(Date.now() + hours * HOUR).toISOString();

function automation(over: Partial<Automation> & { id: string }): Automation {
  return {
    name: `任务 ${over.id}`,
    target: { kind: "waker", agentId: "agent-bear" },
    enabled: true,
    maxRuns: null,
    endDate: null,
    runCount: 0,
    createdAt: new Date().toISOString(),
    breakerTripped: false,
    ...over,
  };
}

function trigger(
  automationId: string,
  id: string,
  config: AutomationTrigger["config"],
  over: Partial<AutomationTrigger> = {},
): AutomationTrigger {
  return {
    id,
    automationId,
    config,
    enabled: true,
    nextRunAt: config.kind === "webhook" ? null : later(2),
    hasSecret: config.kind === "webhook",
    lastError: null,
    ...over,
  };
}

const running = automation({
  id: "a-running",
  name: "每日简报",
  maxRuns: 10,
  runCount: 3,
  endDate: later(24 * 30),
});
const paused = automation({ id: "a-paused", name: "手动暂停", enabled: false });
const expired = automation({
  id: "a-expired",
  name: "过期任务",
  enabled: false,
  endDate: new Date(Date.now() - HOUR).toISOString(),
  runCount: 2,
});
const capped = automation({
  id: "a-capped",
  name: "跑满任务",
  enabled: false,
  maxRuns: 5,
  runCount: 5,
});
const tripped = automation({
  id: "a-tripped",
  name: "熔断任务",
  enabled: false,
  breakerTripped: true,
  runCount: 10,
});

const TRIGGERS: Record<string, AutomationTrigger[]> = {
  "a-running": [
    trigger("a-running", "t-schedule", {
      kind: "schedule",
      cron: "0 9 * * 1-5",
      timezone: "Asia/Shanghai",
    }),
    trigger("a-running", "t-once", { kind: "once", at: later(48) }),
    trigger("a-running", "t-hook", { kind: "webhook" }),
  ],
  // A one-off the server switched off because its moment was missed: it says why.
  "a-paused": [
    trigger(
      "a-paused",
      "t-missed",
      { kind: "once", at: new Date(Date.now() - HOUR).toISOString() },
      {
        enabled: false,
        nextRunAt: null,
        lastError: "一次性触发错过了预定时间，没有执行。",
      },
    ),
  ],
  // Still switched on with a next time on record, but its automation is off: nothing will fire.
  "a-tripped": [
    trigger("a-tripped", "t-tripped", {
      kind: "schedule",
      cron: "*/30 * * * *",
      timezone: "Asia/Shanghai",
    }),
  ],
};

type Answer = (method: string, path: string, body: unknown) => Response | null;

function serve(list: Automation[], answer: Answer = () => null) {
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const method = init?.method ?? "GET";
    const path = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, path, body });
    const answered = answer(method, path, body);
    if (answered) return answered;
    if (method === "GET" && path === "/api/automations") {
      return Response.json({ automations: list });
    }
    const detail = /^\/api\/automations\/([^/]+)$/.exec(path);
    if (method === "GET" && detail?.[1]) {
      const id = decodeURIComponent(detail[1]);
      const found = list.find((item) => item.id === id);
      return found
        ? Response.json({ automation: found, triggers: TRIGGERS[id] ?? [] })
        : Response.json({ error: "找不到这个自动任务。" }, { status: 404 });
    }
    if (method === "GET" && path === "/api/capabilities") {
      return Response.json({});
    }
    return Response.json(
      { error: `unexpected ${method} ${path}` },
      { status: 500 },
    );
  }) as typeof fetch;
}

function draw() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  clients.push(queryClient);
  queryClient.setQueryData(agentKeys.list(false), [bear]);
  const user = userEvent.setup({ document });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <AutomationsSection />
    </QueryClientProvider>,
  );
  return { view, user, queryClient };
}

/** The list item a name belongs to. */
async function rowOf(view: ReturnType<typeof render>, name: string) {
  const title = await view.findByText(name);
  const row = title.closest('[data-slot="item"]') as HTMLElement | null;
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

test("C1/AUT4: every automation shows its state, its runs against the cap and its trigger chips", async () => {
  serve([running, paused, expired, capped, tripped]);
  const { view } = draw();

  const live = await rowOf(view, "每日简报");
  expect(within(live).getByText("运行中")).toBeTruthy();
  expect(within(live).getByText(/Waker：熊宝 · 已运行 3\/10/)).toBeTruthy();
  expect(within(live).getByText(/截止/)).toBeTruthy();
  const chips = await within(live).findAllByRole("listitem");
  expect(chips.map((chip) => chip.textContent)).toEqual([
    expect.stringMatching(/^定期 · 0 9 \* \* 1-5（Asia\/Shanghai） · 下次 /),
    expect.stringMatching(/^一次性 · .+ · 下次 /),
    "Hook / API · 外部调用",
  ]);
  // AUT2: the hook's public entry, never its secret.
  expect(
    within(live).getByText(`POST ${automationHookPath("t-hook")}`),
  ).toBeTruthy();
  expect(automationHookPath("t-hook")).toBe("/api/automations/hooks/t-hook");

  expect(
    within(await rowOf(view, "手动暂停")).getByText("已暂停"),
  ).toBeTruthy();
  expect(
    within(await rowOf(view, "手动暂停")).getByText(/已运行 0\/不限/),
  ).toBeTruthy();
  expect(
    within(await rowOf(view, "过期任务")).getByText("已到期停止"),
  ).toBeTruthy();
  expect(
    within(await rowOf(view, "跑满任务")).getByText("已达上限"),
  ).toBeTruthy();
  expect(
    within(await rowOf(view, "跑满任务")).getByText(/已运行 5\/5/),
  ).toBeTruthy();
  expect(
    within(await rowOf(view, "熔断任务")).getByText("已熔断"),
  ).toBeTruthy();
  // C1: a stopped automation shows its trigger but no next time, since nothing will fire.
  const trippedChips = await within(
    await rowOf(view, "熔断任务"),
  ).findAllByRole("listitem");
  expect(trippedChips.map((chip) => chip.textContent)).toEqual([
    "定期 · */30 * * * *（Asia/Shanghai）",
  ]);
  // Off is 恢复, on is 暂停.
  expect(within(live).getByRole("button", { name: "暂停" })).toBeTruthy();
  expect(
    within(await rowOf(view, "熔断任务")).getByRole("button", { name: "恢复" }),
  ).toBeTruthy();
});

test("a trigger the server switched off says why", async () => {
  serve([paused]);
  const { view } = draw();
  const chips = await within(await rowOf(view, "手动暂停")).findAllByRole(
    "listitem",
  );
  expect(chips.map((chip) => chip.textContent)).toEqual([
    expect.stringMatching(
      /^一次性 · .+ · 已停用 · 一次性触发错过了预定时间，没有执行。$/,
    ),
  ]);
});

test("the state rule: breaker before limits, limits before on/off", () => {
  const now = new Date("2030-01-01T00:00:00Z");
  const base = {
    enabled: true,
    maxRuns: null,
    runCount: 0,
    endDate: null,
    breakerTripped: false,
  };
  expect(automationState(base, now)).toBe("running");
  expect(automationState({ ...base, enabled: false }, now)).toBe("paused");
  expect(
    automationState({ ...base, enabled: false, breakerTripped: true }, now),
  ).toBe("breaker");
  // Switched back on after a trip, it is running again.
  expect(automationState({ ...base, breakerTripped: true }, now)).toBe(
    "running",
  );
  expect(
    automationState({ ...base, enabled: false, maxRuns: 3, runCount: 3 }, now),
  ).toBe("max_runs");
  expect(
    automationState(
      { ...base, enabled: false, endDate: "2030-01-01T00:00:00Z" },
      now,
    ),
  ).toBe("expired");
});

test("pause and delete go through the management API; a refused resume is shown verbatim", async () => {
  const refusal = "已达到最大运行次数，请先调高上限再启用。";
  serve([running, capped], (method, path) => {
    if (method === "PUT" && path === "/api/automations/a-running/enabled") {
      return Response.json({ automation: { ...running, enabled: false } });
    }
    if (method === "PUT" && path === "/api/automations/a-capped/enabled") {
      return Response.json({ error: refusal }, { status: 422 });
    }
    if (method === "DELETE" && path === "/api/automations/a-running") {
      return new Response(null, { status: 204 });
    }
    return null;
  });
  const { view, user } = draw();

  const live = await rowOf(view, "每日简报");
  await user.click(within(live).getByRole("button", { name: "暂停" }));
  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(writes()[0]).toEqual({
    method: "PUT",
    path: "/api/automations/a-running/enabled",
    body: { enabled: false },
  });

  const spent = await rowOf(view, "跑满任务");
  await user.click(within(spent).getByRole("button", { name: "恢复" }));
  expect((await within(spent).findByRole("alert")).textContent).toBe(refusal);

  await user.click(within(live).getByRole("button", { name: "删除" }));
  await waitFor(() =>
    expect(writes().map((call) => `${call.method} ${call.path}`)).toContain(
      "DELETE /api/automations/a-running",
    ),
  );
});

test("AUT2: a new Hook / API trigger's secret is shown once with its URL, then gone", async () => {
  const made = automation({ id: "a-new", name: "接收工单" });
  let list: Automation[] = [];
  serve([], (method, path) => {
    if (method === "GET" && path === "/api/automations") {
      return Response.json({ automations: list });
    }
    if (method === "GET" && path === "/api/automations/a-new") {
      return Response.json({
        automation: made,
        triggers: [trigger("a-new", "t-new-hook", { kind: "webhook" })],
      });
    }
    if (method === "POST" && path === "/api/automations") {
      list = [made];
      return Response.json({ automation: made }, { status: 201 });
    }
    if (method === "POST" && path === "/api/automations/a-new/triggers") {
      return Response.json(
        {
          trigger: trigger("a-new", "t-new-hook", { kind: "webhook" }),
          secret: "only-once-secret",
        },
        { status: 201 },
      );
    }
    return null;
  });
  const { view, user } = draw();

  expect(await view.findByText(/还没有自动任务/)).toBeTruthy();
  await user.click(view.getByRole("button", { name: "新建自动任务" }));
  await user.type(view.getByLabelText("要做的事"), "接收工单");
  fireEvent.change(view.getByLabelText("触发方式 1"), {
    target: { value: "webhook" },
  });
  await user.click(view.getByRole("button", { name: "建立自动任务" }));

  const secret = await view.findByLabelText("Hook 密钥");
  expect(secret.textContent).toBe("only-once-secret");
  expect(view.getByText(/只显示这一次/)).toBeTruthy();
  expect(
    view.getAllByText(`POST ${automationHookPath("t-new-hook")}`).length,
  ).toBeGreaterThan(0);
  // The form folded away once made.
  expect(view.queryByRole("button", { name: "建立自动任务" })).toBeNull();

  await user.click(view.getByRole("button", { name: "我已保存" }));
  await waitFor(() => expect(view.queryByLabelText("Hook 密钥")).toBeNull());
  // The list row still shows where to call, and nothing on the page holds the secret any more.
  expect(
    await view.findByText(`POST ${automationHookPath("t-new-hook")}`),
  ).toBeTruthy();
  expect(document.body.textContent).not.toContain("only-once-secret");
});

test("AUT2: replacing a hook's secret shows the new one once", async () => {
  serve([running], (method, path) =>
    method === "POST" &&
    path === "/api/automations/a-running/triggers/t-hook/secret"
      ? Response.json({ secret: "rotated-secret" })
      : null,
  );
  const { view, user } = draw();
  const live = await rowOf(view, "每日简报");
  await user.click(
    await within(live).findByRole("button", { name: "重新生成密钥" }),
  );
  expect((await within(live).findByLabelText("Hook 密钥")).textContent).toBe(
    "rotated-secret",
  );
  await user.click(within(live).getByRole("button", { name: "我已保存" }));
  await waitFor(() =>
    expect(document.body.textContent).not.toContain("rotated-secret"),
  );
});

test("a failed list read says so and offers a retry instead of an empty list", async () => {
  let fail = true;
  serve([running], (method, path) =>
    fail && method === "GET" && path === "/api/automations"
      ? Response.json({ error: "服务暂时不可用。" }, { status: 500 })
      : null,
  );
  const { view, user } = draw();
  expect((await view.findByRole("alert")).textContent).toContain(
    "自动任务加载失败：服务暂时不可用。",
  );
  expect(view.queryByText(/还没有自动任务/)).toBeNull();
  fail = false;
  await user.click(view.getByRole("button", { name: "重试" }));
  expect(await view.findByText("每日简报")).toBeTruthy();
  expect(automationKeys.list()).toEqual(["automations", "list"]);
});

test("C1: on 自主工作, 全部员工 shows the automations beside every coworker's schedules", async () => {
  serve([running], (method, path) =>
    method === "GET" && path === "/api/agents/autonomous/all"
      ? Response.json({ autonomous: [] })
      : null,
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  clients.push(queryClient);
  queryClient.setQueryData(agentKeys.list(false), [bear]);
  queryClient.setQueryData(autonomousKeys.forAgent(bear.id), {
    agentId: bear.id,
    routines: [],
    responsibilities: [],
    proactive: [],
    lastActivityAt: null,
  });
  const root = createRootRoute({ component: () => <Outlet /> });
  const router = createRouter({
    context: {},
    history: createMemoryHistory({
      initialEntries: ["/autonomous?view=agents"],
    }),
    routeTree: root.addChildren([
      AutonomousRoute.update({
        getParentRoute: () => root,
        path: "/autonomous",
      } as never),
    ]),
  });
  const user = userEvent.setup({ document });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );

  // One coworker's view asks nothing about automations: they are not one coworker's.
  await view.findByText(/还没有安排任何定时任务/);
  expect(view.queryByText("自动任务")).toBeNull();
  expect(calls.some((call) => call.path === "/api/automations")).toBe(false);

  await user.click(view.getByRole("button", { name: "全部员工" }));
  expect(await view.findByText("自动任务")).toBeTruthy();
  expect(await view.findByText("每日简报")).toBeTruthy();
});

/*
 * A server whose list carries each automation's triggers (`GET /api/automations` → triggers) needs no
 * per-row detail read: the 按员工 view's rows draw their chips from the list, as the unified list
 * does, and only an older server's list without them sends each row to `GET /api/automations/:id`.
 */
test("when the list carries triggers, the rows draw their chips without reading any detail", async () => {
  serve(
    [running, tripped].map((entry) => ({
      ...entry,
      triggers: TRIGGERS[entry.id] ?? [],
    })),
  );
  const { view } = draw();
  const live = await rowOf(view, "每日简报");
  const chips = await within(live).findAllByRole("listitem");
  expect(chips.map((chip) => chip.textContent)).toContain(
    "Hook / API · 外部调用",
  );
  expect(
    calls.filter((call) => /^\/api\/automations\/[^/]+$/.test(call.path)),
  ).toEqual([]);
});
