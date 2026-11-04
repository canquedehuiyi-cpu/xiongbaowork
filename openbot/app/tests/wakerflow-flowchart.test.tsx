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
import type { ReactNode } from "react";
import { Flowchart } from "@/components/wakerflow/flowchart";
import { PlanEditor } from "@/components/wakerflow/plan-editor";
import type { WakerFlow, WakerFlowPlan } from "@/lib/wakerflows";
import { WakerFlowDetail } from "@/routes/_authed/_app/wakerflows.$flowId";
import { settleReactWork } from "./settle-react-work";

/**
 * WF7-5 (spec 2026-11-04-wf7 §3.6, §5 WF7-5): the flowchart and the node editing. Diamonds and branch
 * lines with their labels; a jump that can only point forward because the editor offers nothing
 * else; a run's branch-skipped steps told apart from a person's skip; and a nested Flow's node that
 * opens the child and says when it has a newer version.
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

const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

const FLOW_ID = "22222222-2222-4222-8222-222222222222";
const CHILD_ID = "33333333-3333-4333-8333-333333333333";

const branching: WakerFlowPlan = {
  name: "分级处理",
  description: "",
  members: [{ agentId: "agent-a", role: "处理人" }],
  inputs: [{ key: "level", label: "级别", required: true }],
  steps: [
    {
      id: "route",
      kind: "decision",
      inputKeys: ["level"],
      branches: [
        { label: "紧急", when: 'inputs.level == "高"', next: "urgent" },
      ],
      otherwise: "normal",
    },
    {
      id: "urgent",
      agentId: "agent-a",
      instruction: "立即处理",
      inputKeys: ["level"],
      outputKey: "urgent_out",
      next: "wrap",
    },
    {
      id: "normal",
      agentId: "agent-a",
      instruction: "排队处理",
      inputKeys: ["level"],
      outputKey: "normal_out",
    },
    {
      id: "wrap",
      agentId: "agent-a",
      instruction: "汇总",
      inputKeys: ["level"],
      outputKey: "final",
    },
  ],
};

const title = (node: { id: string }) => node.id;

function withQueries(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

test("a decision is drawn as a diamond, and each branch line and its label are shown", () => {
  const view = render(
    <Flowchart label="图" steps={branching.steps} title={title} />,
  );
  const decision = view.container.querySelector('[data-step="route"]');
  expect(decision?.getAttribute("data-kind")).toBe("decision");
  expect(decision?.querySelector('[data-shape="diamond"]')).not.toBeNull();
  for (const id of ["urgent", "normal", "wrap"])
    expect(
      view.container
        .querySelector(`[data-step="${id}"]`)
        ?.querySelector('[data-shape="box"]'),
    ).not.toBeNull();
  // The branches, by label and target, beside the diamond.
  const branches = within(view.getByLabelText("第 1 步的分支"));
  expect(branches.getByText("紧急 → 第 2 步")).toBeDefined();
  expect(branches.getByText("否则 → 第 3 步")).toBeDefined();
  // The jumps are lines: 否则 skips step 2, and step 2 jumps past step 3 to the summary.
  const edges = [...view.container.querySelectorAll("path[data-edge]")].map(
    (path) => [path.getAttribute("data-edge"), path.getAttribute("data-label")],
  );
  expect(edges).toContainEqual(["0->2", "否则"]);
  expect(edges).toContainEqual(["1->3", ""]);
  // 紧急 goes to the very next step: a short arrow, not a lane line.
  expect(edges.some(([edge]) => edge === "0->1")).toBe(false);
  expect(view.getByText("结束")).toBeDefined();
});

test("a run shows a branch-skipped step and a person-skipped step differently, with words for each", () => {
  const view = render(
    <Flowchart
      states={{
        route: { state: "done" },
        urgent: { state: "skipped", skipReason: "branch" },
        normal: { state: "skipped", skipReason: "person" },
        wrap: { state: "failed" },
      }}
      steps={branching.steps}
      title={title}
    />,
  );
  const node = (id: string) =>
    view.container.querySelector(`[data-step="${id}"]`) as HTMLElement;
  expect(node("urgent").getAttribute("data-state")).toBe("skipped-branch");
  expect(node("normal").getAttribute("data-state")).toBe("skipped-person");
  expect(within(node("urgent")).getByText(/分支未选中/)).toBeDefined();
  expect(within(node("normal")).getByText(/已跳过/)).toBeDefined();
  expect(within(node("urgent")).queryByText(/已跳过/)).toBeNull();
  // The two looks are not the same look.
  const look = (id: string) =>
    (node(id).querySelector('[data-shape="box"]') as HTMLElement).className;
  expect(look("urgent")).not.toBe(look("normal"));
  expect(node("wrap").getAttribute("data-state")).toBe("failed");
  expect(within(node("wrap")).getByText(/失败/)).toBeDefined();
});

test("the editor never offers a jump to an earlier step", async () => {
  const view = render(
    withQueries(
      <PlanEditor
        coworkers={[{ id: "agent-a", name: "阿处" }]}
        flowId={FLOW_ID}
        onReload={() => undefined}
        onSaved={() => undefined}
        plan={branching}
        revision={1}
      />,
    ),
  );
  const options = (label: string) =>
    [...(view.getByLabelText(label) as HTMLSelectElement).options].map(
      (option) => option.value,
    );
  // Step 3 may go on in order, to step 4, or end; never to step 1 or 2.
  expect(options("第 3 步完成后")).toEqual(["", "wrap", "__end__"]);
  expect(options("第 4 步完成后")).toEqual(["", "__end__"]);
  // A decision's branches and its otherwise only ever name later steps or the end.
  expect(options("第 1 步第 1 个分支跳到")).toEqual([
    "urgent",
    "normal",
    "wrap",
    "__end__",
  ]);
  expect(options("第 1 步都不满足时")).not.toContain("route");
  // Choosing a node in the chart marks that step's form.
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.click(view.getByRole("button", { name: "第 3 步：排队处理" }));
  await waitFor(() =>
    expect(
      view.container
        .querySelector("#step-form-normal")
        ?.getAttribute("data-selected"),
    ).toBe("true"),
  );
});

test("the editor saves a member's prompt and an edited branch as the plan's own fields", async () => {
  const saved: unknown[] = [];
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    if (init?.method === "PUT") {
      saved.push(JSON.parse(String(init.body)));
      return Response.json({
        flow: { id: FLOW_ID, revision: 2, plan: branching },
      });
    }
    return Response.json({ flows: [] });
  }) as typeof fetch;
  const view = render(
    withQueries(
      <PlanEditor
        coworkers={[{ id: "agent-a", name: "阿处" }]}
        flowId={FLOW_ID}
        onReload={() => undefined}
        onSaved={() => undefined}
        plan={branching}
        revision={1}
      />,
    ),
  );
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(
    view.getByLabelText("第 1 位员工的提示词"),
    "只处理工单，不回复客户。",
  );
  await user.clear(view.getByLabelText("第 1 步第 1 个分支的名称"));
  await user.type(view.getByLabelText("第 1 步第 1 个分支的名称"), "加急");
  await user.click(view.getByRole("button", { name: "保存计划" }));
  await waitFor(() => expect(saved).toHaveLength(1));
  const body = saved[0] as { plan: WakerFlowPlan };
  expect(body.plan.members[0]?.prompt).toBe("只处理工单，不回复客户。");
  expect(body.plan.steps[0]).toMatchObject({
    kind: "decision",
    branches: [{ label: "加急", next: "urgent" }],
    otherwise: "normal",
  });
});

test("a branch-only output read after the branches join is refused before Save", async () => {
  let puts = 0;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    if (init?.method === "PUT") puts += 1;
    return Response.json({ flows: [] });
  }) as typeof fetch;
  const plan: WakerFlowPlan = {
    ...branching,
    steps: branching.steps.map((step) =>
      step.id === "wrap" ? { ...step, inputKeys: ["urgent_out"] } : step,
    ),
  };
  const view = render(
    withQueries(
      <PlanEditor
        coworkers={[{ id: "agent-a", name: "阿处" }]}
        flowId={FLOW_ID}
        onReload={() => undefined}
        onSaved={() => undefined}
        plan={plan}
        revision={1}
      />,
    ),
  );
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.click(view.getByRole("button", { name: "保存计划" }));
  expect(
    await view.findByText(/输入 urgent_out 只在部分分支中产生/),
  ).toBeDefined();
  expect(puts).toBe(0);
});

function flowOf(overrides: Partial<WakerFlow>): WakerFlow {
  return {
    id: FLOW_ID,
    name: "父流程",
    description: "",
    idea: "",
    modelRef: null,
    plan: null,
    status: "ready",
    revision: 3,
    groupId: null,
    templateId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

const child = flowOf({
  id: CHILD_ID,
  name: "资料整理",
  revision: 5,
  plan: {
    name: "资料整理",
    description: "",
    members: [{ agentId: "agent-a", role: "整理" }],
    inputs: [{ key: "notes", label: "材料", required: true }],
    steps: [
      {
        id: "tidy",
        agentId: "agent-a",
        instruction: "整理",
        inputKeys: ["notes"],
        outputKey: "summary",
      },
    ],
  },
});
const nesting: WakerFlowPlan = {
  name: "父流程",
  description: "",
  members: [{ agentId: "agent-a", role: "撰写" }],
  inputs: [{ key: "topic", label: "主题", required: true }],
  steps: [
    {
      id: "nest",
      kind: "flow",
      targetFlowId: CHILD_ID,
      targetRevision: 2,
      inputMap: { notes: "topic" },
      outputKey: "child_out",
      resultKey: "summary",
    },
  ],
};

function serveFlows() {
  globalThis.fetch = (async (input: unknown) => {
    const path = String(input);
    if (path.startsWith("/api/agents")) return Response.json({ agents: [] });
    if (path === "/api/wakerflows")
      return Response.json({ flows: [flowOf({ plan: nesting }), child] });
    if (path === `/api/wakerflows/${FLOW_ID}`)
      return Response.json({ flow: flowOf({ plan: nesting }) });
    if (path === `/api/wakerflows/${FLOW_ID}/runs`)
      return Response.json({ runs: [] });
    if (path === `/api/wakerflows/${FLOW_ID}/versions`)
      return Response.json({ versions: [] });
    return Response.json({ error: "unexpected" }, { status: 500 });
  }) as typeof fetch;
}

test("a nested Flow's node opens the child Flow, and says when the child has a newer version", async () => {
  serveFlows();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const root = createRootRoute({ component: () => <Outlet /> });
  const router = createRouter({
    context: {},
    history: createMemoryHistory({
      initialEntries: [`/wakerflows/${FLOW_ID}`],
    }),
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: "/wakerflows/$flowId",
        component: () => <WakerFlowDetail flowId={FLOW_ID} />,
      } as never),
      createRoute({
        getParentRoute: () => root,
        path: "/wakerflows/",
        component: () => null,
      } as never),
      createRoute({
        getParentRoute: () => root,
        path: "/wakerflows/new",
        component: () => null,
      } as never),
    ]),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  const link = await view.findByRole("link", {
    name: /打开子流程「资料整理」/,
  });
  expect(link.getAttribute("href")).toBe(`/wakerflows/${CHILD_ID}`);
  expect(await view.findByText(/子流程有新版本（第 5 版）/)).toBeDefined();
  cleanup();

  // In the editor too, where a person may move the step to the newer version.
  serveFlows();
  const editor = render(
    withQueries(
      <PlanEditor
        coworkers={[{ id: "agent-a", name: "阿撰" }]}
        flowId={FLOW_ID}
        onReload={() => undefined}
        onSaved={() => undefined}
        plan={nesting}
        revision={3}
      />,
    ),
  );
  expect(await editor.findByText(/子流程有新版本（第 5 版）/)).toBeDefined();
  expect(
    editor.getByRole("link", { name: "打开子流程" }).getAttribute("href"),
  ).toBe(`/wakerflows/${CHILD_ID}`);
  const user = userEvent.setup({ document: editor.container.ownerDocument });
  await user.click(editor.getByRole("button", { name: "更新到第 5 版" }));
  expect(editor.getByText("固定在第 5 版")).toBeDefined();
  expect(editor.queryByText(/子流程有新版本/)).toBeNull();
});

test("the run detail keeps its own step list first, each step's status in plain words beside the chart", async () => {
  const RUN_ID = "44444444-4444-4444-8444-444444444444";
  const linear: WakerFlowPlan = {
    ...branching,
    steps: branching.steps,
  };
  globalThis.fetch = (async (input: unknown) => {
    const path = String(input);
    if (path.startsWith("/api/agents")) return Response.json({ agents: [] });
    if (path === "/api/wakerflows")
      return Response.json({ flows: [flowOf({ plan: linear })] });
    if (path === `/api/wakerflows/${FLOW_ID}`)
      return Response.json({ flow: flowOf({ plan: linear }) });
    if (path === `/api/wakerflows/${FLOW_ID}/runs`)
      return Response.json({
        runs: [
          {
            id: RUN_ID,
            status: "done",
            templateId: null,
            parentTaskId: null,
            createdAt: new Date().toISOString(),
          },
        ],
      });
    if (path === `/api/wakerflows/${FLOW_ID}/runs/${RUN_ID}`)
      return Response.json({
        run: {
          id: RUN_ID,
          flowId: FLOW_ID,
          status: "done",
          cursor: 4,
          parentTaskId: null,
          inputs: { level: "高" },
          steps: [
            {
              id: "route",
              kind: "decision",
              agentId: "",
              instruction: "条件判断：紧急",
              inputKeys: ["level"],
              branches:
                linear.steps[0]?.kind === "decision"
                  ? linear.steps[0].branches
                  : [],
              otherwise: "normal",
              state: "done",
              branch: { label: "紧急", index: 0 },
            },
            { ...linear.steps[1], state: "done", output: "已处理" },
            { ...linear.steps[2], state: "skipped", skipReason: "branch" },
            { ...linear.steps[3], state: "done", output: "汇总好了" },
          ],
        },
      });
    if (path.includes("/events?"))
      return Response.json({ events: [], next: null });
    if (path.endsWith("/confirmations"))
      return Response.json({ confirmations: [] });
    if (path.endsWith("/versions")) return Response.json({ versions: [] });
    return Response.json({ error: "unexpected" }, { status: 500 });
  }) as typeof fetch;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const root = createRootRoute({ component: () => <Outlet /> });
  const router = createRouter({
    context: {},
    history: createMemoryHistory({
      initialEntries: [`/wakerflows/${FLOW_ID}`],
    }),
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: "/wakerflows/$flowId",
        component: () => <WakerFlowDetail flowId={FLOW_ID} />,
      } as never),
      createRoute({
        getParentRoute: () => root,
        path: "/approvals",
        component: () => null,
      } as never),
    ]),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.click(await view.findByRole("button", { name: /已完成/ }));
  const status = await view.findByTestId("run-detail-status");
  // The G4 e2e reads a step's status here: two levels up from the run's status, the first `ol > li`.
  const detail = status.parentElement?.parentElement as HTMLElement;
  const items = [...detail.querySelectorAll("ol > li")] as HTMLElement[];
  expect(items).toHaveLength(4);
  expect(
    within(items[0] as HTMLElement).getByText("已完成", { exact: true }),
  ).toBeDefined();
  expect(within(items[0] as HTMLElement).getByText(/第 1 步/)).toBeDefined();
  expect(
    within(items[2] as HTMLElement).getByText("分支未选中", { exact: true }),
  ).toBeDefined();
  // And the chart beside it, coloured by the same states.
  expect(
    detail
      .querySelector('[aria-label="运行流程图"] [data-step="normal"]')
      ?.getAttribute("data-state"),
  ).toBe("skipped-branch");
});

test("an action step added in the editor saves with its tool, arguments and reads", async () => {
  const saved: { plan: WakerFlowPlan }[] = [];
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    if (init?.method === "PUT") {
      saved.push(JSON.parse(String(init.body)));
      return Response.json({ flow: flowOf({ plan: branching }) });
    }
    return Response.json({ flows: [] });
  }) as typeof fetch;
  const view = render(
    withQueries(
      <PlanEditor
        coworkers={[{ id: "agent-a", name: "阿处" }]}
        flowId={FLOW_ID}
        onReload={() => undefined}
        onSaved={() => undefined}
        plan={branching}
        revision={1}
      />,
    ),
  );
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.selectOptions(view.getByLabelText("新步骤的类型"), "action");
  await user.click(view.getByRole("button", { name: "添加步骤" }));
  await user.type(view.getByLabelText("第 5 步调用的工具"), "crm/create_note");
  await user.click(view.getByLabelText("第 5 步读取 final"));
  await user.click(view.getByRole("button", { name: "添加参数" }));
  await user.clear(view.getByLabelText("第 5 步第 1 个参数名"));
  await user.type(view.getByLabelText("第 5 步第 1 个参数名"), "text");
  await user.type(
    view.getByLabelText("第 5 步参数 text 的值"),
    "结论：{{{{final}}",
  );
  await user.type(view.getByLabelText("第 5 步的输出名称"), "note");
  await user.click(view.getByRole("button", { name: "保存计划" }));
  await waitFor(() => expect(saved).toHaveLength(1));
  expect(saved[0]?.plan.steps[4]).toEqual({
    id: "step_5",
    kind: "action",
    agentId: "agent-a",
    tool: "crm/create_note",
    args: { text: "结论：{{final}}" },
    inputKeys: ["final"],
    outputKey: "note",
  });
});
