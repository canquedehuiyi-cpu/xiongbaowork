import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  QueryClient,
  QueryClientProvider,
  useQueryClient,
} from "@tanstack/react-query";
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
import {
  planDifferences,
  type WakerFlow,
  type WakerFlowPlan,
  type WakerFlowSession,
  type WakerFlowSessionTurn,
  wakerFlowKeys,
} from "@/lib/wakerflows";
import { WakerFlowDetail } from "@/routes/_authed/_app/wakerflows.$flowId";
import { settleReactWork } from "./settle-react-work";

/**
 * WF9-2: the session panel on a Flow's page against a stubbed `/api/wakerflows`. What is asserted is
 * what goes over the wire — which session is activated, the turn's request and its cancel under the
 * same request id — and what the page shows: the history, the active session, each candidate's
 * differences from the current plan, and 应用 opening the editor on the candidate without saving.
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
afterEach(() => {
  cleanup();
  calls.length = 0;
  globalThis.fetch = originalFetch;
});

const FLOW_ID = "11111111-1111-4111-8111-111111111111";
const MODEL_ID = "22222222-2222-4222-8222-222222222222";
const ONE = "33333333-3333-4333-8333-333333333333";
const TWO = "44444444-4444-4444-8444-444444444444";
const BASE = `/api/wakerflows/${FLOW_ID}`;

const current: WakerFlowPlan = {
  name: "会议纪要",
  description: "",
  members: [
    { agentId: "agent-a", role: "记录员" },
    { agentId: "agent-b", role: "复核员" },
  ],
  inputs: [{ key: "notes", label: "会议内容", required: true }],
  steps: [
    {
      id: "draft",
      agentId: "agent-a",
      instruction: "整理纪要",
      inputKeys: ["notes"],
      outputKey: "summary",
    },
    {
      id: "review",
      agentId: "agent-b",
      instruction: "复核纪要",
      inputKeys: ["summary"],
      outputKey: "result",
    },
  ],
};
const [draftStep, reviewStep] = current.steps as [
  WakerFlowPlan["steps"][number],
  WakerFlowPlan["steps"][number],
];

const reordered: WakerFlowPlan = {
  ...current,
  steps: [
    { ...reviewStep, inputKeys: ["notes"], outputKey: "checked" },
    {
      ...draftStep,
      instruction: "根据复核意见整理纪要",
      inputKeys: ["checked"],
    },
  ],
};

const flow: WakerFlow = {
  id: FLOW_ID,
  name: current.name,
  description: "",
  idea: "整理会议",
  modelRef: MODEL_ID,
  plan: current,
  status: "ready",
  revision: 3,
  groupId: "55555555-5555-4555-8555-555555555555",
  templateId: "66666666-6666-4666-8666-666666666666",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const session = (
  id: string,
  title: string,
  active: boolean,
  turnCount: number,
): WakerFlowSession => ({
  id,
  requestId: id,
  title,
  description: "",
  revision: 0,
  turnCount,
  active,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

const turn = (
  prompt: string,
  plan: WakerFlowPlan | null,
  extra: Partial<WakerFlowSessionTurn> = {},
): WakerFlowSessionTurn => ({
  id: `turn-${prompt}`,
  requestId: `request-${prompt}`,
  prompt,
  modelRef: MODEL_ID,
  status: plan ? "completed" : "failed",
  error: plan ? null : "计划格式无效，请重试。",
  plan,
  applied: false,
  createdAt: new Date().toISOString(),
  ...extra,
});

type Handler = (call: Call) => Response | Promise<Response> | undefined;

function serve(handle: Handler) {
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
      return Response.json({ agents: [] });
    if (call.path === BASE && call.method === "GET")
      return Response.json({ flow });
    if (call.path === `${BASE}/runs`) return Response.json({ runs: [] });
    if (call.path === `${BASE}/versions`)
      return Response.json({ versions: [] });
    if (call.path === "/api/wakerflows/model-choices")
      return Response.json({
        models: [{ id: MODEL_ID, name: "custom/planner", label: "规划模型" }],
      });
    if (call.path === "/api/wakerflows") return Response.json({ flows: [] });
    return Response.json({ error: "unexpected" }, { status: 500 });
  }) as typeof fetch;
}

/** What the editor stub saw in the cache when it opened. */
let editorSaw: WakerFlow | undefined;
function EditorStub() {
  const queryClient = useQueryClient();
  editorSaw ??= queryClient.getQueryData<WakerFlow>(
    wakerFlowKeys.detail(FLOW_ID),
  );
  return <p>编辑器：{editorSaw?.plan?.steps[0]?.instruction}</p>;
}

function draw() {
  editorSaw = undefined;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const root = createRootRoute({ component: () => <Outlet /> });
  const history = createMemoryHistory({
    initialEntries: [`/wakerflows/${FLOW_ID}`],
  });
  const router = createRouter({
    context: {},
    history,
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: "/wakerflows/$flowId",
        component: () => <WakerFlowDetail flowId={FLOW_ID} />,
      } as never),
      createRoute({
        getParentRoute: () => root,
        path: "/wakerflows/new",
        component: EditorStub,
      } as never),
      createRoute({
        getParentRoute: () => root,
        path: "/wakerflows",
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
    queryClient,
    user: userEvent.setup({ document: view.container.ownerDocument }),
  };
}

test("the panel opens on the active session, shows each candidate's differences, and switching a session activates it", async () => {
  let active = ONE;
  serve((call) => {
    if (call.path === `${BASE}/sessions`)
      return Response.json({
        sessions: [
          session(ONE, "调整顺序", active === ONE, 2),
          session(TWO, "精简步骤", active === TWO, 1),
        ],
        activeSessionId: active,
      });
    if (call.path === `${BASE}/sessions/${ONE}/turns`)
      return Response.json({
        turns: [turn("把复核放到第一步", reordered), turn("再试一次", null)],
      });
    if (call.path === `${BASE}/sessions/${TWO}/turns`)
      return Response.json({
        turns: [turn("保持不变", current, { applied: true })],
      });
    if (call.path === `${BASE}/sessions/${TWO}/activate`) {
      active = TWO;
      return Response.json({ session: session(TWO, "精简步骤", true, 1) });
    }
    return undefined;
  });
  const { view, user } = draw();

  const panel = await view.findByRole("complementary", { name: "修改会话" });
  const history = await within(panel).findByRole("list", { name: "历史会话" });
  expect(within(history).getAllByRole("listitem")).toHaveLength(2);
  expect(
    within(history)
      .getByRole("button", { name: /调整顺序/ })
      .getAttribute("aria-current"),
  ).toBe("true");
  // The active session's turns, with what the candidate changes against the current plan.
  expect(await within(panel).findByText("把复核放到第一步")).toBeDefined();
  const changes = within(panel).getByRole("list", {
    name: "与当前计划的差异",
  });
  expect(
    within(changes)
      .getAllByRole("listitem")
      .map((item) => item.textContent),
  ).toEqual([
    "修改步骤「draft」：根据复核意见整理纪要",
    "步骤顺序：draft → review 改为 review → draft",
  ]);
  expect(within(panel).getByText("失败：计划格式无效，请重试。")).toBeDefined();
  expect(within(panel).getAllByRole("button", { name: "应用" })).toHaveLength(
    1,
  );

  await user.click(within(history).getByRole("button", { name: /精简步骤/ }));
  expect(await within(panel).findByText("保持不变")).toBeDefined();
  expect(within(panel).getByText("与当前计划相同。")).toBeDefined();
  expect(within(panel).getByText("已应用")).toBeDefined();
  expect(within(panel).queryByRole("button", { name: "应用" })).toBeNull();
  const activations = calls.filter((c) => c.path.endsWith("/activate"));
  expect(activations.map((c) => [c.method, c.path])).toEqual([
    ["POST", `${BASE}/sessions/${TWO}/activate`],
  ]);
});

test("a turn can be cancelled while it is generating, under the same request id", async () => {
  let release: (() => void) | undefined;
  let cancelled = false;
  serve((call) => {
    if (call.path === `${BASE}/sessions`)
      return Response.json({
        sessions: [session(ONE, "调整顺序", true, 0)],
        activeSessionId: ONE,
      });
    if (call.path === `${BASE}/sessions/${ONE}/turns` && call.method === "GET")
      return Response.json({
        turns: cancelled
          ? [
              turn("把复核放到第一步", null, {
                status: "cancelled",
                error: "已取消生成。",
              }),
            ]
          : [],
      });
    if (call.path === `${BASE}/sessions/${ONE}/turns`) {
      const body = call.body as { requestId: string };
      return new Promise<Response>((resolve) => {
        release = () =>
          resolve(
            Response.json({
              request: {
                id: "row",
                requestId: body.requestId,
                flowId: FLOW_ID,
                kind: "customize",
                status: "cancelled",
                runId: null,
                taskId: null,
                error: "已取消生成。",
                result: null,
              },
            }),
          );
      });
    }
    if (call.path === `${BASE}/generate/cancel`) {
      cancelled = true;
      release?.();
      return Response.json({ request: { status: "cancelled" } });
    }
    return undefined;
  });
  const { view, user } = draw();
  const panel = await view.findByRole("complementary", { name: "修改会话" });
  const send = await within(panel).findByRole("button", { name: "发送" });
  expect(send.hasAttribute("disabled")).toBe(true);
  await user.type(
    within(panel).getByRole("textbox", { name: "修改要求" }),
    "把复核放到第一步",
  );
  await waitFor(() => expect(send.hasAttribute("disabled")).toBe(false));
  await user.click(send);

  expect(await within(panel).findByText("正在生成…")).toBeDefined();
  const sent = calls.find(
    (c) => c.method === "POST" && c.path === `${BASE}/sessions/${ONE}/turns`,
  );
  expect(sent?.body).toEqual({
    requestId: expect.any(String),
    modelRef: MODEL_ID,
    prompt: "把复核放到第一步",
  });
  await user.click(within(panel).getByRole("button", { name: "取消" }));
  const cancel = calls.find((c) => c.path === `${BASE}/generate/cancel`);
  expect(cancel?.body).toEqual({
    requestId: (sent?.body as { requestId?: string } | undefined)?.requestId,
  });
  expect(await within(panel).findAllByText("已取消生成。")).not.toHaveLength(0);
  expect(within(panel).queryByRole("button", { name: "取消" })).toBeNull();
});

test("应用 opens the editor on the candidate, and nothing is saved until the person saves", async () => {
  serve((call) => {
    if (call.path === `${BASE}/sessions`)
      return Response.json({
        sessions: [session(ONE, "调整顺序", true, 1)],
        activeSessionId: ONE,
      });
    if (call.path === `${BASE}/sessions/${ONE}/turns`)
      return Response.json({ turns: [turn("把复核放到第一步", reordered)] });
    return undefined;
  });
  const { view, user, router, queryClient } = draw();
  const panel = await view.findByRole("complementary", { name: "修改会话" });
  await user.click(await within(panel).findByRole("button", { name: "应用" }));

  expect(await view.findByText("编辑器：复核纪要")).toBeDefined();
  expect(router.state.location.pathname).toBe("/wakerflows/new");
  expect(router.state.location.search).toEqual({ flow: FLOW_ID });
  // The editor opened on the candidate at the revision it was looking at.
  expect(editorSaw?.plan).toEqual(reordered);
  expect(editorSaw?.revision).toBe(3);
  // The cache is stale at once, so the next read of the Flow is the server's.
  expect(
    queryClient.getQueryState(wakerFlowKeys.detail(FLOW_ID))?.isInvalidated,
  ).toBe(true);
  expect(calls.filter((c) => c.method === "PUT")).toEqual([]);
});

test("a new session is created with a request id and becomes the one the panel shows", async () => {
  let made = false;
  serve((call) => {
    if (call.path === `${BASE}/sessions` && call.method === "GET")
      return Response.json(
        made
          ? {
              sessions: [
                session(TWO, "新的修改会话", true, 0),
                session(ONE, "调整顺序", false, 1),
              ],
              activeSessionId: TWO,
            }
          : { sessions: [], activeSessionId: null },
      );
    if (call.path === `${BASE}/sessions`) {
      made = true;
      return Response.json(
        { session: session(TWO, "新的修改会话", true, 0) },
        { status: 201 },
      );
    }
    if (call.path.endsWith("/turns")) return Response.json({ turns: [] });
    return undefined;
  });
  const { view, user } = draw();
  const panel = await view.findByRole("complementary", { name: "修改会话" });
  expect(await within(panel).findByText(/还没有修改会话/)).toBeDefined();
  await user.click(within(panel).getByRole("button", { name: "新建会话" }));
  expect(
    await within(panel).findByRole("heading", { name: "新的修改会话" }),
  ).toBeDefined();
  const created = calls.find(
    (c) => c.method === "POST" && c.path === `${BASE}/sessions`,
  );
  expect(created?.body).toEqual({ requestId: expect.any(String) });
});

test("planDifferences names what a candidate adds, removes and changes", () => {
  expect(planDifferences(current, current)).toEqual([]);
  expect(planDifferences(null, current)).toEqual([
    "当前还没有计划，应用后会使用这份候选计划。",
  ]);
  const candidate: WakerFlowPlan = {
    name: "会议纪要（精简）",
    description: "",
    members: [{ agentId: "agent-a", role: "整理员" }],
    inputs: [{ key: "topic", label: "主题", required: false }],
    steps: [
      { ...draftStep, inputKeys: ["topic"] },
      {
        id: "send",
        agentId: "agent-a",
        instruction: "发出纪要",
        inputKeys: ["summary"],
        outputKey: "sent",
      },
    ],
  };
  expect(planDifferences(current, candidate)).toEqual([
    "名称：「会议纪要」改为「会议纪要（精简）」",
    "员工职责：「记录员」改为「整理员」",
    "移除员工：复核员",
    "新增输入：主题（topic）",
    "移除输入：会议内容（notes）",
    "新增第 2 步「send」：发出纪要",
    "删除步骤「review」",
  ]);
});
