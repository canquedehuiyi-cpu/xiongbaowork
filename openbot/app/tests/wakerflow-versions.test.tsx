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
import type {
  WakerFlow,
  WakerFlowPlan,
  WakerFlowVersionSummary,
} from "@/lib/wakerflows";
import { WakerFlowDetail } from "@/routes/_authed/_app/wakerflows.$flowId";
import { settleReactWork } from "./settle-react-work";

/**
 * WF8-4: the 版本 section of a Flow's page against a stubbed `/api/wakerflows`. What is asserted is
 * what goes over the wire — nothing until the second press, then one restore fenced by the revision
 * on screen — and what the page says afterwards: the new version number, or a refresh offer when the
 * restore lost the race.
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
const restores = () =>
  calls.filter(
    (entry) => entry.method === "POST" && entry.path.endsWith("/restore"),
  );

afterEach(() => {
  cleanup();
  calls.length = 0;
  globalThis.fetch = originalFetch;
});

const FLOW_ID = "11111111-1111-4111-8111-111111111111";

const planNamed = (name: string, instruction: string): WakerFlowPlan => ({
  name,
  description: "",
  members: [{ agentId: "agent-a", role: "撰写" }],
  inputs: [],
  steps: [
    {
      id: "step_1",
      agentId: "agent-a",
      instruction,
      inputKeys: [],
      outputKey: "report",
    },
  ],
});

function flow(revision: number, plan: WakerFlowPlan): WakerFlow {
  return {
    id: FLOW_ID,
    name: plan.name,
    description: "",
    idea: "周报",
    modelRef: null,
    plan,
    status: "ready",
    revision,
    groupId: "55555555-5555-4555-8555-555555555555",
    templateId: `66666666-6666-4666-8666-66666666666${revision}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

const version = (revision: number, name: string): WakerFlowVersionSummary => ({
  revision,
  name,
  stepCount: 1,
  modelRef: null,
  templateId: null,
  createdBy: "me",
  createdAt: new Date("2026-11-04T08:00:00Z").toISOString(),
});

type Handler = (call: Call) => Response | undefined;

function serve(handle: Handler) {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? "GET",
      path: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    };
    calls.push(call);
    const answered = handle(call);
    if (answered) return answered;
    if (call.path.startsWith("/api/agents"))
      return Response.json({ agents: [] });
    if (call.path === `/api/wakerflows/${FLOW_ID}/runs`)
      return Response.json({ runs: [] });
    if (call.path === "/api/wakerflows") return Response.json({ flows: [] });
    return Response.json({ error: "unexpected" }, { status: 500 });
  }) as typeof fetch;
}

function draw() {
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
        path: "/wakerflows/new",
        component: () => null,
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
    user: userEvent.setup({ document: view.container.ownerDocument }),
  };
}

const first = planNamed("周报 一", "写第一版周报");
const third = planNamed("周报 三", "写第三版周报");

test("the 版本 section lists every version, and 恢复此版本 asks once more before anything is sent", async () => {
  let restored = false;
  serve((call) => {
    if (call.path === `/api/wakerflows/${FLOW_ID}` && call.method === "GET")
      return Response.json({
        flow: restored ? flow(4, first) : flow(3, third),
      });
    if (call.path === `/api/wakerflows/${FLOW_ID}/versions`)
      return Response.json({
        versions: [
          ...(restored ? [version(4, "周报 一")] : []),
          version(3, "周报 三"),
          version(2, "周报 二"),
          version(1, "周报 一"),
        ],
      });
    if (call.path === `/api/wakerflows/${FLOW_ID}/versions/1/restore`) {
      restored = true;
      return Response.json({ flow: flow(4, first) });
    }
    return undefined;
  });
  const { view, user } = draw();

  expect(await view.findByText("当前版本：第 3 版")).toBeDefined();
  const list = await view.findByRole("list", { name: "版本记录" });
  await waitFor(() => expect(list.querySelectorAll("li")).toHaveLength(3));
  expect(view.getByText("当前")).toBeDefined();
  // The current version cannot be restored onto itself.
  expect(view.queryByRole("button", { name: "恢复第 3 版" })).toBeNull();

  await user.click(view.getByRole("button", { name: "恢复第 1 版" }));
  expect(
    view.getByText("恢复后会保存为第 4 版，正在进行的运行不受影响。"),
  ).toBeDefined();
  expect(restores()).toEqual([]);
  await user.click(view.getByRole("button", { name: "取消" }));
  expect(view.queryByRole("button", { name: "确认恢复" })).toBeNull();
  expect(restores()).toEqual([]);

  await user.click(view.getByRole("button", { name: "恢复第 1 版" }));
  await user.click(view.getByRole("button", { name: "确认恢复" }));
  await waitFor(() => expect(restores()).toHaveLength(1));
  expect(restores()[0]?.body).toEqual({ revision: 3 });

  // The page now shows the new version number and the restored plan.
  expect(await view.findByText("当前版本：第 4 版")).toBeDefined();
  expect(view.getByText("已恢复第 1 版的计划，保存为第 4 版。")).toBeDefined();
  expect(await view.findByText("写第一版周报")).toBeDefined();
  await waitFor(() =>
    expect(
      view.getByRole("list", { name: "版本记录" }).querySelectorAll("li"),
    ).toHaveLength(4),
  );
});

test("a restore that lost the revision race offers a refresh, and the refresh reads the Flow again", async () => {
  let newer = false;
  serve((call) => {
    if (call.path === `/api/wakerflows/${FLOW_ID}` && call.method === "GET")
      return Response.json({ flow: newer ? flow(5, third) : flow(3, third) });
    if (call.path === `/api/wakerflows/${FLOW_ID}/versions`)
      return Response.json({
        versions: [version(3, "周报 三"), version(2, "周报 二")],
      });
    if (call.path === `/api/wakerflows/${FLOW_ID}/versions/2/restore`) {
      newer = true;
      return Response.json(
        { error: "这个 WakerFlow 已在另一处修改，请刷新后再保存。" },
        { status: 409 },
      );
    }
    return undefined;
  });
  const { view, user } = draw();

  await user.click(await view.findByRole("button", { name: "恢复第 2 版" }));
  await user.click(view.getByRole("button", { name: "确认恢复" }));
  expect(
    await view.findByText("这个 WakerFlow 已在另一处修改，请刷新后再保存。"),
  ).toBeDefined();
  // While the page is stale, nothing else can be restored from it.
  expect(
    view.getByRole("button", { name: "恢复第 2 版" }).hasAttribute("disabled"),
  ).toBe(true);
  expect(restores()).toHaveLength(1);

  await user.click(view.getByRole("button", { name: "刷新" }));
  expect(await view.findByText("当前版本：第 5 版")).toBeDefined();
  expect(
    view.queryByText("这个 WakerFlow 已在另一处修改，请刷新后再保存。"),
  ).toBeNull();
  expect(restores()).toHaveLength(1);
});
