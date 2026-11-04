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
import { PlanEditor } from "@/components/wakerflow/plan-editor";
import type { AgentProfile } from "@/lib/agents/queries";
import {
  laterRunReading,
  runInputProblems,
  type WakerFlow,
  type WakerFlowPlan,
  type WakerFlowRun,
} from "@/lib/wakerflows";
import { cardLinkOf } from "@/routes/_authed/_app/tasks";
import { WakerFlowDetail } from "@/routes/_authed/_app/wakerflows.$flowId";
import { Route as WakerFlowsIndexRoute } from "@/routes/_authed/_app/wakerflows.index";
import { Route as WakerFlowsNewRoute } from "@/routes/_authed/_app/wakerflows.new";
import { settleReactWork } from "./settle-react-work";

/**
 * Stories WF4 and WF5 at the screen a person uses (spec D10): a saved Flow read back, run from a form
 * built from its own inputs, its runs listed with each step's state and output, 停止 sent once, and a
 * stopped run that a late poll cannot bring back to "running". The server's suites prove what the API
 * and the pipeline do with a request id and an abort; this proves the screen asks them the right way.
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

type Call = { method: string; path: string; body: unknown };
const originalFetch = globalThis.fetch;
const calls: Call[] = [];
const runPosts = () =>
  calls.filter(
    (entry) => entry.method === "POST" && entry.path.endsWith("/runs"),
  );
const abortPosts = () =>
  calls.filter(
    (entry) => entry.method === "POST" && entry.path.endsWith("/abort"),
  );

afterEach(() => {
  cleanup();
  calls.length = 0;
  globalThis.fetch = originalFetch;
});

const coworker: AgentProfile = {
  id: "agent-a",
  name: "阿记",
  title: "会议秘书",
  roleDescription: "整理会议。",
  avatarSeed: "a",
  visibility: "private",
  endpoint: null,
  builtIn: true,
  hasAuth: false,
  hasCallbackToken: false,
  modelRef: null,
  persona: null,
  hidden: false,
  pinned: false,
  systemOwned: false,
  canManage: true,
  mine: true,
};

const FLOW_ID = "11111111-1111-4111-8111-111111111111";
const COPY_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "33333333-3333-4333-8333-333333333333";
const PARENT_TASK_ID = "44444444-4444-4444-8444-444444444444";

const plan: WakerFlowPlan = {
  name: "周会准备",
  description: "生成议程和会前清单",
  members: [{ agentId: "agent-a", role: "会议秘书" }],
  inputs: [
    { key: "topic", label: "会议主题", required: true },
    { key: "notes", label: "补充说明", required: false },
  ],
  steps: [
    {
      id: "step_1",
      agentId: "agent-a",
      instruction: "根据主题写出议程",
      inputKeys: ["topic"],
      outputKey: "agenda",
    },
    {
      id: "step_2",
      agentId: "agent-a",
      instruction: "根据议程写会前清单",
      inputKeys: ["agenda"],
      outputKey: "checklist",
    },
  ],
};

function flow(overrides: Partial<WakerFlow> = {}): WakerFlow {
  return {
    id: FLOW_ID,
    name: "周会准备",
    description: "",
    idea: "帮我准备周会",
    modelRef: null,
    plan,
    status: "ready",
    revision: 3,
    groupId: "55555555-5555-4555-8555-555555555555",
    templateId: "66666666-6666-4666-8666-666666666666",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function run(
  status: WakerFlowRun["status"],
  overrides: Partial<WakerFlowRun> = {},
): WakerFlowRun {
  return {
    id: RUN_ID,
    flowId: FLOW_ID,
    status,
    cursor: 1,
    parentTaskId: PARENT_TASK_ID,
    inputs: { topic: "季度复盘" },
    steps: [
      {
        ...plan.steps[0]!,
        state: "done",
        output: "1. 回顾 2. 计划",
      },
      {
        ...plan.steps[1]!,
        state: status === "aborted" ? "aborted" : "running",
      },
    ],
    ...overrides,
  };
}

const summary = (status: string) => ({
  id: RUN_ID,
  status,
  templateId: null,
  parentTaskId: PARENT_TASK_ID,
  createdAt: new Date().toISOString(),
});

const startAnswer = (requestId: string) => ({
  request: {
    id: "row-1",
    requestId,
    flowId: FLOW_ID,
    kind: "run",
    status: "completed",
    runId: RUN_ID,
    taskId: PARENT_TASK_ID,
    error: null,
    result: null,
  },
});

type Handler = (call: Call) => Response | Promise<Response> | undefined;

function serve(handle: Handler = () => undefined) {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? "GET",
      path: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    };
    calls.push(call);
    const answered = await handle(call);
    if (answered) return answered;
    if (call.path.startsWith("/api/agents"))
      return Response.json({ agents: [coworker] });
    if (call.path === "/api/wakerflows/model-choices")
      return Response.json({
        models: [{ id: "model-1", name: "openai/gpt-x", label: "规划模型 X" }],
      });
    if (call.path === "/api/wakerflows" && call.method === "GET")
      return Response.json({ flows: [flow()] });
    if (call.path === `/api/wakerflows/${FLOW_ID}` && call.method === "GET")
      return Response.json({ flow: flow() });
    if (
      call.path === `/api/wakerflows/${FLOW_ID}/runs` &&
      call.method === "GET"
    )
      return Response.json({ runs: [] });
    return Response.json({ error: "unexpected" }, { status: 500 });
  }) as typeof fetch;
}

function draw(entry: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const root = createRootRoute({ component: () => <Outlet /> });
  const router = createRouter({
    context: {},
    history: createMemoryHistory({ initialEntries: [entry] }),
    routeTree: root.addChildren([
      WakerFlowsIndexRoute.update({
        getParentRoute: () => root,
        path: "/wakerflows/",
      } as never),
      WakerFlowsNewRoute.update({
        getParentRoute: () => root,
        path: "/wakerflows/new",
      } as never),
      createRoute({
        getParentRoute: () => root,
        path: "/wakerflows/$flowId",
        // A short poll, so the stale-answer race below happens in milliseconds rather than seconds.
        component: () => (
          <WakerFlowDetail flowId={FLOW_ID} pollIntervalMs={20} />
        ),
      } as never),
      createRoute({
        getParentRoute: () => root,
        path: "/tasks",
        component: () => <p>任务看板</p>,
      } as never),
      createRoute({
        getParentRoute: () => root,
        path: "/resources",
        component: () => null,
      } as never),
    ]),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return {
    view,
    router,
    user: userEvent.setup({ document: view.container.ownerDocument }),
  };
}

const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

test("the list opens a Flow's own page, and the page reads the saved plan back", async () => {
  serve();
  const { view, user, router } = draw("/wakerflows");

  await user.click(await view.findByText("查看"));
  await waitFor(() =>
    expect(router.state.location.pathname).toBe(`/wakerflows/${FLOW_ID}`),
  );
  expect(await view.findByText("根据主题写出议程")).toBeDefined();
  expect(view.getByText(/会议主题（topic）/)).toBeDefined();
  expect(view.getByText(/读取：topic · 产出：agenda/)).toBeDefined();
  expect(await view.findByText("还没有运行记录。")).toBeDefined();
});

test("the run form refuses a missing required input before anything is sent", async () => {
  serve();
  const { view, user } = draw(`/wakerflows/${FLOW_ID}`);

  const topic = await view.findByLabelText("会议主题（必填）");
  expect(view.getByLabelText("补充说明（选填）")).toBeDefined();
  await user.type(view.getByLabelText("补充说明（选填）"), "只谈 Q3");
  await user.click(view.getByRole("button", { name: "运行" }));

  expect(await view.findByText("请填写 会议主题。")).toBeDefined();
  expect(topic.getAttribute("aria-invalid")).toBe("true");
  expect(runPosts()).toEqual([]);

  // Whitespace is not an answer either.
  await user.type(topic, "   ");
  await user.click(view.getByRole("button", { name: "运行" }));
  expect(view.getByText("请填写 会议主题。")).toBeDefined();
  expect(runPosts()).toEqual([]);
});

test("one press is one request id, and a retry after a lost answer reuses it", async () => {
  let attempts = 0;
  let started = false;
  serve((call) => {
    if (call.path === `/api/wakerflows/${FLOW_ID}/runs`) {
      if (call.method === "POST") {
        attempts += 1;
        // The first answer is lost on the wire; the second is the server's settled outcome.
        if (attempts === 1) throw new TypeError("Failed to fetch");
        started = true;
        return Response.json(
          startAnswer((call.body as { requestId: string }).requestId),
        );
      }
      return Response.json({ runs: started ? [summary("running")] : [] });
    }
    if (call.path === `/api/wakerflows/${FLOW_ID}/runs/${RUN_ID}`)
      return Response.json({ run: run("running") });
    return undefined;
  });
  const { view, user } = draw(`/wakerflows/${FLOW_ID}`);

  await user.type(await view.findByLabelText("会议主题（必填）"), "季度复盘");
  await user.click(view.getByRole("button", { name: "运行" }));
  expect(await view.findByText(/同一次请求不会重复运行/)).toBeDefined();
  await user.click(view.getByRole("button", { name: "运行" }));

  // The run opens with its steps, each with its state and what it produced.
  expect(
    await view.findByText("1. 回顾 2. 计划", { exact: false }),
  ).toBeDefined();
  const posts = runPosts();
  expect(posts).toHaveLength(2);
  const [first, second] = posts.map(
    (entry) =>
      entry.body as {
        requestId: string;
        revision: number;
        inputs: Record<string, string>;
      },
  );
  expect(second!.requestId).toBe(first!.requestId);
  expect(first!.revision).toBe(3);
  // Only what was filled, and only declared names.
  expect(first!.inputs).toEqual({ topic: "季度复盘" });

  // Each run links to the board, where its parent card is reviewed (查收).
  const board = await view.findByText("到任务看板查收");
  expect(board.getAttribute("href")).toContain("/tasks");
  expect(decodeURIComponent(board.getAttribute("href") ?? "")).toContain(
    "周会准备",
  );
});

test("a 5xx on start is not a refusal: the retry keeps the request id", async () => {
  let attempts = 0;
  let started = false;
  serve((call) => {
    if (call.path === `/api/wakerflows/${FLOW_ID}/runs`) {
      if (call.method === "POST") {
        attempts += 1;
        // A gateway in front of the server answered; whether the claim landed is unknown.
        if (attempts === 1)
          return Response.json({ error: "Bad Gateway" }, { status: 502 });
        started = true;
        return Response.json(
          startAnswer((call.body as { requestId: string }).requestId),
        );
      }
      return Response.json({ runs: started ? [summary("running")] : [] });
    }
    if (call.path === `/api/wakerflows/${FLOW_ID}/runs/${RUN_ID}`)
      return Response.json({ run: run("running") });
    return undefined;
  });
  const { view, user } = draw(`/wakerflows/${FLOW_ID}`);

  await user.type(await view.findByLabelText("会议主题（必填）"), "季度复盘");
  await user.click(view.getByRole("button", { name: "运行" }));
  expect(await view.findByText(/同一次请求不会重复运行/)).toBeDefined();
  await user.click(view.getByRole("button", { name: "运行" }));
  expect(
    await view.findByText("1. 回顾 2. 计划", { exact: false }),
  ).toBeDefined();

  const ids = runPosts().map(
    (entry) => (entry.body as { requestId: string }).requestId,
  );
  expect(ids).toHaveLength(2);
  expect(ids[1]).toBe(ids[0]!);
});

test("停止 is sent once, and a stale 'running' poll cannot undo the stop", async () => {
  let reads = 0;
  let releaseStale: ((response: Response) => void) | null = null;
  serve((call) => {
    if (
      call.method === "GET" &&
      call.path === `/api/wakerflows/${FLOW_ID}/runs`
    )
      // The list lags too: it keeps saying "running" after the stop.
      return Response.json({ runs: [summary("running")] });
    if (call.path === `/api/wakerflows/${FLOW_ID}/runs/${RUN_ID}`) {
      reads += 1;
      if (reads === 2)
        // A poll sent before 停止 that answers after it.
        return new Promise<Response>((resolve) => {
          releaseStale = resolve;
        });
      return Response.json({ run: run("running") });
    }
    if (call.path.endsWith(`/runs/${RUN_ID}/abort`))
      return Response.json({
        status: "aborted",
        cursor: 2,
        steps: run("aborted").steps,
      });
    return undefined;
  });
  const { view, user } = draw(`/wakerflows/${FLOW_ID}`);

  await user.click(await view.findByRole("button", { name: /运行中/ }));
  const stop = await view.findByRole("button", { name: "停止" });
  // Wait until the second poll is in flight and held.
  await waitFor(() => expect(releaseStale).not.toBeNull());

  await user.click(stop);
  await waitFor(() =>
    expect(view.getByTestId("run-detail-status").textContent).toBe("已停止"),
  );
  expect(stop.hasAttribute("disabled")).toBe(true);

  // The held poll now answers with the state from before the stop.
  (releaseStale as unknown as (response: Response) => void)(
    Response.json({ run: run("running") }),
  );
  await wait(120);

  expect(view.getByTestId("run-detail-status").textContent).toBe("已停止");
  expect(
    view.getByRole("button", { name: "停止" }).hasAttribute("disabled"),
  ).toBe(true);
  // The list row agrees with the detail rather than with the lagging list answer.
  expect(view.queryByRole("button", { name: /运行中/ })).toBeNull();
  await user.click(view.getByRole("button", { name: "停止" }));
  expect(abortPosts()).toHaveLength(1);
  expect(abortPosts()[0]!.path).toBe(
    `/api/wakerflows/${FLOW_ID}/runs/${RUN_ID}/abort`,
  );
});

test("删除 refused because a run is going stays disabled with the server's reason", async () => {
  const reason = "这个 WakerFlow 仍有进行中的规划或运行，结束后才能删除。";
  serve((call) => {
    if (call.method === "DELETE")
      return Response.json({ error: reason }, { status: 409 });
    return undefined;
  });
  const { view, user } = draw(`/wakerflows/${FLOW_ID}`);

  await user.click(await view.findByRole("button", { name: "删除" }));
  await user.click(await view.findByRole("button", { name: "确认删除" }));

  expect(await view.findByText(`暂时不能删除：${reason}`)).toBeDefined();
  const remove = await view.findByRole("button", { name: "删除" });
  expect(remove.hasAttribute("disabled")).toBe(true);
  const deletes = calls.filter((entry) => entry.method === "DELETE");
  expect(deletes).toHaveLength(1);
  // Fenced by the revision the page was showing.
  expect(deletes[0]!.path).toBe(`/api/wakerflows/${FLOW_ID}?revision=3`);
});

test("删除 refused by a going run is offered again once that run has ended", async () => {
  const reason = "这个 WakerFlow 仍有进行中的规划或运行，结束后才能删除。";
  let status = "running";
  serve((call) => {
    if (call.method === "DELETE")
      return Response.json({ error: reason }, { status: 409 });
    if (
      call.method === "GET" &&
      call.path === `/api/wakerflows/${FLOW_ID}/runs`
    )
      return Response.json({ runs: [summary(status)] });
    return undefined;
  });
  const { view, user } = draw(`/wakerflows/${FLOW_ID}`);

  expect(await view.findByRole("button", { name: /运行中/ })).toBeDefined();
  await user.click(view.getByRole("button", { name: "删除" }));
  await user.click(await view.findByRole("button", { name: "确认删除" }));
  expect(await view.findByText(`暂时不能删除：${reason}`)).toBeDefined();
  expect(
    view.getByRole("button", { name: "删除" }).hasAttribute("disabled"),
  ).toBe(true);

  // The run ends; the panel's next poll says so, and 删除 may be asked again.
  status = "done";
  await waitFor(() =>
    expect(
      view.getByRole("button", { name: "删除" }).hasAttribute("disabled"),
    ).toBe(false),
  );
  expect(view.queryByText(`暂时不能删除：${reason}`)).toBeNull();
});

test("复用 makes a new draft and opens the editor on a copy of the plan", async () => {
  serve((call) => {
    if (call.method === "POST" && call.path === "/api/wakerflows")
      return Response.json(
        {
          flow: flow({
            id: COPY_ID,
            name: "周会准备（副本）",
            plan: null,
            status: "draft",
            revision: 0,
            groupId: null,
            templateId: null,
          }),
        },
        { status: 201 },
      );
    if (call.method === "GET" && call.path === `/api/wakerflows/${COPY_ID}`)
      return Response.json({
        flow: flow({
          id: COPY_ID,
          name: "周会准备（副本）",
          plan: null,
          status: "draft",
          revision: 0,
        }),
      });
    return undefined;
  });
  const { view, user, router } = draw(`/wakerflows/${FLOW_ID}`);

  await user.click(await view.findByRole("button", { name: "复用" }));

  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/wakerflows/new"),
  );
  expect(router.state.location.search).toEqual({ flow: COPY_ID });
  const created = calls.find(
    (entry) => entry.method === "POST" && entry.path === "/api/wakerflows",
  );
  expect(created?.body).toMatchObject({
    idea: "帮我准备周会",
    name: "周会准备（副本）",
  });
  await waitFor(async () =>
    expect(
      ((await view.findByLabelText("流程名称")) as HTMLInputElement).value,
    ).toBe("周会准备（副本）"),
  );
  // Nothing was saved over the original, and the copy is not compiled until the person saves it.
  expect(calls.filter((entry) => entry.method === "PUT")).toEqual([]);
});

test("a board card of a Flow's run opens the Flow", () => {
  expect(
    cardLinkOf({
      open: { kind: "wakerflow", id: FLOW_ID },
      channelRef: null,
    }),
  ).toEqual({ to: "/wakerflows/$flowId", params: { flowId: FLOW_ID } });
  expect(
    cardLinkOf({ open: { kind: "pipeline", id: RUN_ID }, channelRef: null }),
  ).toEqual({ to: "/pipelines", search: { run: RUN_ID } });
});

test("an ended run is never moved back to running by a later reading", () => {
  const aborted = run("aborted");
  expect(laterRunReading(aborted, run("running"))).toBe(aborted);
  expect(laterRunReading(run("failed"), run("awaiting_action"))?.status).toBe(
    "failed",
  );
  expect(laterRunReading(run("running"), run("done"))?.status).toBe("done");
  expect(laterRunReading(null, run("running"))?.status).toBe("running");
  expect(runInputProblems(plan, { topic: "", notes: "x" })).toEqual({
    topic: "请填写 会议主题。",
  });
  expect(runInputProblems(plan, { topic: "复盘" })).toEqual({});
});

/*
 * WF8: typed Flow inputs. The editor declares a type, a default and a select's options; the run
 * panel enters each type its own way and sends strings.
 */
test("the editor sets a type, options and a default, and a select without options cannot be saved", async () => {
  const puts: unknown[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (init?.method === "PUT") {
      puts.push(body);
      return Response.json({ flow: flow({ plan: body.plan, revision: 4 }) });
    }
    return Response.json(
      { error: `unexpected ${String(input)}` },
      { status: 500 },
    );
  }) as typeof fetch;
  const saved: WakerFlow[] = [];
  const view = render(
    <PlanEditor
      coworkers={[{ id: "agent-a", name: "阿记" }]}
      flowId={FLOW_ID}
      onReload={() => {}}
      onSaved={(next) => saved.push(next)}
      plan={plan}
      revision={3}
    />,
  );
  const user = userEvent.setup({ document: view.container.ownerDocument });
  const type = view.getByLabelText("第 2 个输入的类型") as HTMLSelectElement;
  expect(Array.from(type.options).map((option) => option.textContent)).toEqual([
    "单行文本",
    "多行文本",
    "数字",
    "下拉选择",
    "开关",
  ]);
  fireEvent.change(type, { target: { value: "select" } });
  await user.click(view.getByRole("button", { name: "保存计划" }));
  expect(
    await view.findByText("下拉输入「补充说明」至少需要一个选项。"),
  ).toBeDefined();
  expect(puts).toEqual([]);

  await user.type(view.getByLabelText("第 2 个输入的选项"), "简短{Enter}详细");
  fireEvent.change(view.getByLabelText("第 2 个输入的默认值"), {
    target: { value: "详细" },
  });
  await user.type(view.getByLabelText("第 2 个输入的说明"), "篇幅");
  // A number's default must be a number.
  fireEvent.change(view.getByLabelText("第 1 个输入的类型"), {
    target: { value: "number" },
  });
  await user.type(view.getByLabelText("第 1 个输入的默认值"), "很多");
  await user.click(view.getByRole("button", { name: "保存计划" }));
  expect(
    await view.findByText("「会议主题」的默认值无效：会议主题 需要填写数字。"),
  ).toBeDefined();
  expect(puts).toEqual([]);

  const fallback = view.getByLabelText("第 1 个输入的默认值");
  await user.clear(fallback);
  await user.type(fallback, "3");
  await user.click(view.getByRole("button", { name: "保存计划" }));
  await waitFor(() => expect(puts).toHaveLength(1));
  expect((puts[0] as { plan: WakerFlowPlan }).plan.inputs).toEqual([
    {
      key: "topic",
      label: "会议主题",
      required: true,
      type: "number",
      default: "3",
    },
    {
      key: "notes",
      label: "补充说明",
      required: false,
      type: "select",
      description: "篇幅",
      default: "详细",
      options: ["简短", "详细"],
    },
  ]);
  expect(saved).toHaveLength(1);
});

test("the run form renders each type its own way and sends strings", async () => {
  const typed: WakerFlowPlan = {
    ...plan,
    inputs: [
      { key: "topic", label: "会议主题", required: true, type: "textarea" },
      { key: "count", label: "人数", required: true, type: "number" },
      {
        key: "tone",
        label: "语气",
        required: false,
        type: "select",
        options: ["正式", "轻松"],
        default: "轻松",
      },
      {
        key: "urgent",
        label: "加急",
        required: true,
        type: "boolean",
        description: "加急会跳过复核",
      },
    ],
  };
  serve((call) => {
    if (call.path === `/api/wakerflows/${FLOW_ID}` && call.method === "GET")
      return Response.json({ flow: flow({ plan: typed }) });
    if (
      call.path === `/api/wakerflows/${FLOW_ID}/runs` &&
      call.method === "POST"
    )
      return Response.json(
        startAnswer((call.body as { requestId: string }).requestId),
      );
    if (call.path === `/api/wakerflows/${FLOW_ID}/runs/${RUN_ID}`)
      return Response.json({ run: run("running") });
    return undefined;
  });
  const { view, user } = draw(`/wakerflows/${FLOW_ID}`);

  const topic = await view.findByLabelText("会议主题（必填）");
  expect(topic.tagName).toBe("TEXTAREA");
  const count = view.getByLabelText("人数（必填）") as HTMLInputElement;
  expect(count.getAttribute("type")).toBe("number");
  const tone = view.getByLabelText("语气（选填）") as HTMLSelectElement;
  expect(tone.tagName).toBe("SELECT");
  expect(Array.from(tone.options).map((option) => option.value)).toEqual([
    "",
    "正式",
    "轻松",
  ]);
  expect(tone.value).toBe("轻松");
  const urgent = view.getByLabelText("加急（必填）") as HTMLInputElement;
  expect(urgent.getAttribute("role")).toBe("switch");
  expect(urgent.checked).toBe(false);
  expect(view.getByText("加急会跳过复核")).toBeDefined();

  await user.click(view.getByRole("button", { name: "运行" }));
  expect(await view.findByText("请填写 人数。")).toBeDefined();
  expect(runPosts()).toEqual([]);

  await user.type(topic, "季度复盘{Enter}只谈 Q3");
  await user.type(count, "12");
  await user.click(urgent);
  await user.click(view.getByRole("button", { name: "运行" }));
  await waitFor(() => expect(runPosts()).toHaveLength(1));
  expect((runPosts()[0]?.body as { inputs: unknown }).inputs).toEqual({
    topic: "季度复盘\n只谈 Q3",
    count: "12",
    tone: "轻松",
    urgent: "true",
  });
});

test("runInputProblems checks each type and a default stands in for an empty required input", () => {
  const typed: WakerFlowPlan = {
    ...plan,
    inputs: [
      { key: "count", label: "人数", required: true, type: "number" },
      {
        key: "tone",
        label: "语气",
        required: true,
        type: "select",
        options: ["正式"],
        default: "正式",
      },
    ],
  };
  expect(runInputProblems(typed, { count: "abc" })).toEqual({
    count: "人数 需要填写数字。",
  });
  expect(runInputProblems(typed, { count: "3", tone: "随意" })).toEqual({
    tone: "语气 需要从选项中选择。",
  });
  expect(runInputProblems(typed, { count: "3" })).toEqual({});
  // The automation form's rule: no default stands in for a required value.
  expect(runInputProblems(typed, { count: "3" }, { defaults: false })).toEqual({
    tone: "请填写 语气。",
  });
});
