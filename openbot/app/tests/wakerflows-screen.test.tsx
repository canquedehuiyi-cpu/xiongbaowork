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
import {
  WAKERFLOW_CONFLICT_MESSAGE,
  WAKERFLOW_SUGGESTIONS,
  type WakerFlow,
  type WakerFlowPlan,
} from "@/lib/wakerflows";
import { Route as WakerFlowsIndexRoute } from "@/routes/_authed/_app/wakerflows.index";
import { Route as WakerFlowsNewRoute } from "@/routes/_authed/_app/wakerflows.new";
import { settleReactWork } from "./settle-react-work";

/**
 * Stories WF1-WF3 at the screens a person uses (spec D10): the list and its empty state, writing a
 * Flow from a sentence with a chosen model, and editing the plan it became.
 *
 * The server's suite proves what the API does with a request id, a revision and a plan; this proves
 * the screen asks it the right way — one request id per question, kept when the answer was lost so a
 * retry can never start a second generation, a plan that reads an input nobody declared never sent,
 * and a lost revision race answered by reloading rather than overwriting.
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
const writes = () => calls.filter((entry) => entry.method !== "GET");
const generatePosts = () =>
  calls.filter(
    (entry) => entry.method === "POST" && entry.path.endsWith("/generate"),
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
  isolated: false,
  isolationActive: false,
  isolationOffReason: null,
};

const FLOW_ID = "11111111-1111-4111-8111-111111111111";

const plan: WakerFlowPlan = {
  name: "周会准备",
  description: "生成议程和会前清单",
  members: [{ agentId: "agent-a", role: "会议秘书" }],
  inputs: [{ key: "topic", label: "会议主题", required: true }],
  steps: [
    {
      id: "step_1",
      agentId: "agent-a",
      instruction: "根据主题写出议程",
      inputKeys: ["topic"],
      outputKey: "agenda",
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
    plan: null,
    status: "draft",
    revision: 1,
    groupId: null,
    templateId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

type Handler = (call: Call) => Response | Promise<Response> | undefined;

/**
 * The endpoint stub: `handle` answers what a test cares about, and the shared reads (the roster, the
 * model picker, the list) answer from fixtures unless the test overrides them.
 */
function serve(
  handle: Handler = () => undefined,
  models = [{ id: "model-1", name: "openai/gpt-x", label: "规划模型 X" }],
) {
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
      return Response.json({ models });
    if (call.path === "/api/wakerflows" && call.method === "GET")
      return Response.json({ flows: [] });
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
    user: userEvent.setup({ document: view.container.ownerDocument }),
  };
}

test("an empty workspace says so, and 新建 opens the new-flow screen", async () => {
  serve();
  const { view, user } = draw("/wakerflows");

  expect(await view.findByText("还没有 WakerFlow")).toBeDefined();
  await user.click(await view.findByText("新建"));

  expect(await view.findByLabelText("描述你想要的流程")).toBeDefined();
  expect(await view.findByText("新建 WakerFlow")).toBeDefined();
  expect(writes()).toEqual([]);
});

test("a scenario chip fills the idea", async () => {
  serve();
  const { view, user } = draw("/wakerflows/new");
  const suggestion = WAKERFLOW_SUGGESTIONS[1];

  const chip = await view.findByRole("button", { name: suggestion });
  await user.click(chip);

  const idea = (await view.findByLabelText(
    "描述你想要的流程",
  )) as HTMLTextAreaElement;
  expect(idea.value).toBe(suggestion);
  expect(chip.getAttribute("aria-pressed")).toBe("true");
});

test("with no planning model there is no implicit default, and the reason is shown", async () => {
  serve(undefined, []);
  const { view, user } = draw("/wakerflows/new");

  expect(await view.findByText(/还没有可用于规划的模型/)).toBeDefined();
  expect(view.queryByLabelText("规划模型")).toBeNull();
  await user.click(
    await view.findByRole("button", { name: WAKERFLOW_SUGGESTIONS[0] }),
  );
  await user.click(await view.findByLabelText("阿记"));
  const generate = await view.findByRole("button", { name: "生成计划" });
  expect(generate.hasAttribute("disabled")).toBe(true);
  expect(generatePosts()).toEqual([]);
});

test("generate sends one request id, and a retry after a lost answer reuses it", async () => {
  let generateAttempts = 0;
  serve((call) => {
    if (call.method === "POST" && call.path === "/api/wakerflows")
      return Response.json({ flow: flow() }, { status: 201 });
    if (call.method === "POST" && call.path.endsWith("/generate")) {
      generateAttempts += 1;
      // The first answer is lost on the wire; the second is the server's settled outcome.
      if (generateAttempts === 1) throw new TypeError("Failed to fetch");
      const body = call.body as { requestId: string };
      return Response.json({
        request: {
          id: "row-1",
          requestId: body.requestId,
          flowId: FLOW_ID,
          kind: "generate",
          status: "completed",
          runId: null,
          taskId: null,
          error: null,
          result: { plan, modelRef: "model-1", revision: 2, applied: true },
        },
      });
    }
    // Asked where the lost request stands: the server never claimed it.
    if (call.path.includes("/requests/"))
      return Response.json({ error: "这里没有这个请求。" }, { status: 404 });
    return undefined;
  });
  const { view, user } = draw("/wakerflows/new");

  await user.click(
    await view.findByRole("button", { name: WAKERFLOW_SUGGESTIONS[0] }),
  );
  await user.click(await view.findByLabelText("阿记"));
  // A model is on offer, but none is picked for the person: generating waits for their choice.
  const picker = (await view.findByLabelText("规划模型")) as HTMLSelectElement;
  expect(picker.value).toBe("");
  expect(
    (await view.findByRole("button", { name: "生成计划" })).hasAttribute(
      "disabled",
    ),
  ).toBe(true);
  await user.selectOptions(picker, "model-1");
  await user.click(await view.findByRole("button", { name: "生成计划" }));

  expect(await view.findByText(/网络连接中断/)).toBeDefined();
  expect(generatePosts()).toHaveLength(1);
  const first = generatePosts()[0]!.body as Record<string, unknown>;
  expect(first.requestId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  expect(first).toMatchObject({
    modelRef: "model-1",
    idea: WAKERFLOW_SUGGESTIONS[0],
    scenario: WAKERFLOW_SUGGESTIONS[0],
    members: [{ agentId: "agent-a", name: "阿记", role: "会议秘书" }],
  });
  // The idea survives the failure, so retrying costs nothing to retype.
  expect(
    ((await view.findByLabelText("描述你想要的流程")) as HTMLTextAreaElement)
      .value,
  ).toBe(WAKERFLOW_SUGGESTIONS[0]);

  await user.click(await view.findByRole("button", { name: "生成计划" }));

  expect(
    ((await view.findByLabelText("流程名称")) as HTMLInputElement).value,
  ).toBe("周会准备");
  const posts = generatePosts();
  expect(posts).toHaveLength(2);
  expect((posts[1]!.body as Record<string, unknown>).requestId).toBe(
    first.requestId,
  );
  // The Flow was created once, not once per press.
  expect(
    writes().filter(
      (entry) => entry.method === "POST" && entry.path === "/api/wakerflows",
    ),
  ).toHaveLength(1);
});

test("cancel stops the generation with the same request id and keeps the idea", async () => {
  let answer: ((response: Response) => void) | null = null;
  serve((call) => {
    if (call.method === "POST" && call.path === "/api/wakerflows")
      return Response.json({ flow: flow() }, { status: 201 });
    if (call.method === "POST" && call.path.endsWith("/generate"))
      return new Promise<Response>((resolve) => {
        answer = resolve;
      });
    if (call.path.endsWith("/generate/cancel")) {
      const body = call.body as { requestId: string };
      return Response.json({
        request: {
          id: "row-1",
          requestId: body.requestId,
          flowId: FLOW_ID,
          kind: "generate",
          status: "cancelled",
          runId: null,
          taskId: null,
          error: "已取消生成。",
          result: null,
        },
      });
    }
    return undefined;
  });
  const { view, user } = draw("/wakerflows/new");

  await user.type(await view.findByLabelText("描述你想要的流程"), "整理周报");
  await user.selectOptions(await view.findByLabelText("规划模型"), "model-1");
  await user.click(await view.findByLabelText("阿记"));
  await user.click(await view.findByRole("button", { name: "生成计划" }));
  await waitFor(() => expect(generatePosts()).toHaveLength(1));

  const stop = await view.findByRole("button", { name: "取消生成" });
  // Offered once the request id exists, which is what a cancel has to name.
  await waitFor(() => expect(stop.hasAttribute("disabled")).toBe(false));
  await user.click(stop);
  expect(await view.findByText("已取消生成。")).toBeDefined();
  const cancel = calls.find((entry) => entry.path.endsWith("/generate/cancel"));
  expect((cancel!.body as { requestId: string }).requestId).toBe(
    (generatePosts()[0]!.body as { requestId: string }).requestId,
  );
  expect(
    ((await view.findByLabelText("描述你想要的流程")) as HTMLTextAreaElement)
      .value,
  ).toBe("整理周报");

  // The abandoned answer arriving late changes nothing on the screen.
  (answer as ((response: Response) => void) | null)?.(
    Response.json({ error: "已取消生成。" }, { status: 400 }),
  );
  await settleReactWork();
  expect(view.queryByLabelText("流程名称")).toBeNull();
});

test("save is blocked while a step reads an input the plan no longer declares", async () => {
  serve((call) => {
    if (call.method === "GET" && call.path === `/api/wakerflows/${FLOW_ID}`)
      return Response.json({ flow: flow({ plan, status: "ready" }) });
    return undefined;
  });
  const { view, user } = draw(`/wakerflows/new?flow=${FLOW_ID}`);

  await user.click(await view.findByRole("button", { name: "删除输入 topic" }));
  // The reference stays visible so it can be unticked; it is not silently dropped.
  expect(
    ((await view.findByLabelText("第 1 步读取 topic")) as HTMLInputElement)
      .checked,
  ).toBe(true);
  await user.click(await view.findByRole("button", { name: "保存计划" }));

  expect(await view.findByText(/输入 topic 尚未产生/)).toBeDefined();
  expect(writes()).toEqual([]);
});

test("a decision added in the editor is drawn as a diamond, and Save sends it with forward-only targets", async () => {
  serve((call) => {
    if (call.method === "GET" && call.path === `/api/wakerflows/${FLOW_ID}`)
      return Response.json({ flow: flow({ plan, status: "ready" }) });
    if (call.method === "PUT" && call.path === `/api/wakerflows/${FLOW_ID}`)
      return Response.json({
        flow: flow({ plan, status: "ready", revision: 2 }),
      });
    return undefined;
  });
  const { view, user } = draw(`/wakerflows/new?flow=${FLOW_ID}`);

  const chart = await view.findByRole("figure", { name: "计划流程图" });
  expect(chart.querySelector('[data-shape="diamond"]')).toBeNull();
  await user.selectOptions(view.getByLabelText("新步骤的类型"), "decision");
  await user.click(view.getByRole("button", { name: "添加步骤" }));
  await waitFor(() =>
    expect(chart.querySelector('[data-shape="diamond"]')).not.toBeNull(),
  );
  // The new decision is last, so its branches can only end the run.
  expect(
    [
      ...(view.getByLabelText("第 2 步第 1 个分支跳到") as HTMLSelectElement)
        .options,
    ].map((option) => option.value),
  ).toEqual(["__end__"]);
  await user.click(view.getByRole("button", { name: "保存计划" }));
  await waitFor(() => expect(writes()).toHaveLength(1));
  const sent = writes()[0]?.body as { plan: WakerFlowPlan };
  expect(sent.plan.steps[1]).toEqual({
    id: "step_2",
    kind: "decision",
    inputKeys: [],
    branches: [{ label: "是", when: "true", next: "__end__" }],
    otherwise: "__end__",
  });
});

test("a lost revision race offers to reload instead of overwriting", async () => {
  let reads = 0;
  serve((call) => {
    if (call.method === "GET" && call.path === `/api/wakerflows/${FLOW_ID}`) {
      reads += 1;
      return Response.json({
        flow:
          reads === 1
            ? flow({ plan, status: "ready", revision: 3 })
            : flow({
                plan: { ...plan, name: "周会准备（同事改过）" },
                status: "ready",
                revision: 4,
              }),
      });
    }
    if (call.method === "PUT")
      return Response.json(
        { error: WAKERFLOW_CONFLICT_MESSAGE },
        { status: 409 },
      );
    return undefined;
  });
  const { view, user } = draw(`/wakerflows/new?flow=${FLOW_ID}`);

  await user.type(await view.findByLabelText("流程名称"), "（我改的）");
  await user.click(await view.findByRole("button", { name: "保存计划" }));

  expect(await view.findByText(/另一处修改/)).toBeDefined();
  const put = writes().find((entry) => entry.method === "PUT");
  expect(put?.path).toBe(`/api/wakerflows/${FLOW_ID}`);
  expect((put!.body as { revision: number }).revision).toBe(3);

  await user.click(await view.findByRole("button", { name: "重新加载" }));
  await waitFor(async () =>
    expect(
      ((await view.findByLabelText("流程名称")) as HTMLInputElement).value,
    ).toBe("周会准备（同事改过）"),
  );
  expect(view.queryByText(/另一处修改/)).toBeNull();
  expect(writes().filter((entry) => entry.method === "PUT")).toHaveLength(1);
});

test("a cancel that reaches the server before the request is claimed asks again with the same id", async () => {
  let answer: ((response: Response) => void) | null = null;
  let cancels = 0;
  serve((call) => {
    if (call.method === "POST" && call.path === "/api/wakerflows")
      return Response.json({ flow: flow() }, { status: 201 });
    if (call.method === "POST" && call.path.endsWith("/generate"))
      return new Promise<Response>((resolve) => {
        answer = resolve;
      });
    if (call.path.endsWith("/generate/cancel")) {
      cancels += 1;
      // Not claimed yet on the first ask; claimed, and now cancelled, on the next.
      if (cancels === 1)
        return Response.json({ error: "这里没有这个请求。" }, { status: 404 });
      const body = call.body as { requestId: string };
      return Response.json({
        request: {
          id: "row-1",
          requestId: body.requestId,
          flowId: FLOW_ID,
          kind: "generate",
          status: "cancelled",
          runId: null,
          taskId: null,
          error: "已取消生成。",
          result: null,
        },
      });
    }
    return undefined;
  });
  const { view, user } = draw("/wakerflows/new");

  await user.type(await view.findByLabelText("描述你想要的流程"), "整理周报");
  await user.selectOptions(await view.findByLabelText("规划模型"), "model-1");
  await user.click(await view.findByLabelText("阿记"));
  await user.click(await view.findByRole("button", { name: "生成计划" }));
  await waitFor(() => expect(generatePosts()).toHaveLength(1));
  const stop = await view.findByRole("button", { name: "取消生成" });
  await waitFor(() => expect(stop.hasAttribute("disabled")).toBe(false));
  await user.click(stop);

  expect(await view.findByText("已取消生成。")).toBeDefined();
  const asked = calls.filter((entry) =>
    entry.path.endsWith("/generate/cancel"),
  );
  expect(asked).toHaveLength(2);
  const requestId = (generatePosts()[0]!.body as { requestId: string })
    .requestId;
  for (const entry of asked)
    expect((entry.body as { requestId: string }).requestId).toBe(requestId);
  expect(view.queryByText("这里没有这个请求。")).toBeNull();

  (answer as ((response: Response) => void) | null)?.(
    Response.json({ error: "已取消生成。" }, { status: 400 }),
  );
  await settleReactWork();
  expect(view.queryByLabelText("流程名称")).toBeNull();
});

test("planning switched off on the server is a refusal, not a lost answer to chase", async () => {
  serve((call) => {
    if (call.method === "POST" && call.path === "/api/wakerflows")
      return Response.json({ flow: flow() }, { status: 201 });
    if (call.method === "POST" && call.path.endsWith("/generate"))
      return Response.json(
        { error: "这个 WakerFlow 功能尚未开放。" },
        { status: 501 },
      );
    return undefined;
  });
  const { view, user } = draw("/wakerflows/new");

  await user.type(await view.findByLabelText("描述你想要的流程"), "整理周报");
  await user.selectOptions(await view.findByLabelText("规划模型"), "model-1");
  await user.click(await view.findByLabelText("阿记"));
  await user.click(await view.findByRole("button", { name: "生成计划" }));

  expect(await view.findByText("这个 WakerFlow 功能尚未开放。")).toBeDefined();
  expect(view.queryByText(/网络连接中断/)).toBeNull();
  expect(calls.filter((entry) => entry.path.includes("/requests/"))).toEqual(
    [],
  );
  expect(
    ((await view.findByLabelText("描述你想要的流程")) as HTMLTextAreaElement)
      .value,
  ).toBe("整理周报");
});

test("the way back from WakerFlow returns to its own tab of 能力与资源, not the first one", async () => {
  serve();
  const { view } = draw("/wakerflows");
  const back = await view.findByText("能力与资源");
  expect(back.closest("a")?.getAttribute("href")).toBe(
    "/resources?tab=wakerflows",
  );
});
