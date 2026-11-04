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
import {
  rememberShareImport,
  takeShareImport,
  type WakerFlow,
  type WakerFlowPlan,
  type WakerFlowShare,
} from "@/lib/wakerflows";
import { WakerFlowDetail } from "@/routes/_authed/_app/wakerflows.$flowId";
import { WakerFlowImport } from "@/routes/_authed/_app/wakerflows.import.$token";
import { settleReactWork } from "./settle-react-work";

/**
 * WF9-4: sharing a Flow by link and importing one, against a stubbed API. What is asserted is what
 * goes over the wire — the link's limits, the revoke, the import's coworker for every role — and
 * what the person is shown: the link once with the warning that it cannot be seen again, the import
 * button held until every role has a coworker, and the editor of the new draft afterwards.
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
const SHARE_ID = "77777777-7777-4777-8777-777777777777";
const NEW_FLOW = "88888888-8888-4888-8888-888888888888";
const TOKEN = "T".repeat(40) + "abc";
const BASE = `/api/wakerflows/${FLOW_ID}`;

const plan: WakerFlowPlan = {
  name: "会议纪要",
  description: "",
  members: [{ agentId: "agent-a", role: "记录员" }],
  inputs: [],
  steps: [
    {
      id: "draft",
      agentId: "agent-a",
      instruction: "整理纪要",
      inputKeys: [],
      outputKey: "summary",
    },
  ],
};

const flow = (status: "ready" | "draft"): WakerFlow => ({
  id: FLOW_ID,
  name: plan.name,
  description: "",
  idea: "整理会议",
  modelRef: null,
  plan,
  status,
  revision: 2,
  groupId: status === "ready" ? "55555555-5555-4555-8555-555555555555" : null,
  templateId:
    status === "ready" ? "66666666-6666-4666-8666-666666666666" : null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

const shareRow = (status: WakerFlowShare["status"]): WakerFlowShare => ({
  id: SHARE_ID,
  flowId: FLOW_ID,
  status,
  expiresAt: new Date("2026-11-11T08:00:00Z").toISOString(),
  maxUses: 10,
  uses: 0,
  remainingUses: 10,
  revokedAt: status === "revoked" ? new Date().toISOString() : null,
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
      return Response.json({
        agents: [
          { id: "mine-1", name: "小记", title: "", roleDescription: "" },
          { id: "mine-2", name: "小审", title: "", roleDescription: "" },
        ],
      });
    if (call.path === `${BASE}/runs`) return Response.json({ runs: [] });
    if (call.path === `${BASE}/versions`)
      return Response.json({ versions: [] });
    if (call.path === `${BASE}/sessions`)
      return Response.json({ sessions: [], activeSessionId: null });
    if (call.path === "/api/wakerflows/model-choices")
      return Response.json({ models: [] });
    if (call.path === "/api/wakerflows") return Response.json({ flows: [] });
    return Response.json({ error: "unexpected" }, { status: 500 });
  }) as typeof fetch;
}

function draw(path: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const root = createRootRoute({ component: () => <Outlet /> });
  const router = createRouter({
    context: {},
    history: createMemoryHistory({ initialEntries: [path] }),
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: "/wakerflows/import/$token",
        component: () => <WakerFlowImport token={TOKEN} />,
      } as never),
      createRoute({
        getParentRoute: () => root,
        path: "/wakerflows/$flowId",
        component: () => <WakerFlowDetail flowId={FLOW_ID} />,
      } as never),
      createRoute({
        getParentRoute: () => root,
        path: "/wakerflows/new",
        component: () => <p>编辑器</p>,
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
    user: userEvent.setup({ document: view.container.ownerDocument }),
  };
}

test("a link is made with its limits, shown once with the warning, listed without its token, and revoked", async () => {
  let made = false;
  let revoked = false;
  serve((call) => {
    if (call.path === BASE && call.method === "GET")
      return Response.json({ flow: flow("ready") });
    if (call.path === `${BASE}/shares` && call.method === "GET")
      return Response.json({
        shares: made ? [shareRow(revoked ? "revoked" : "active")] : [],
      });
    if (call.path === `${BASE}/shares`) {
      made = true;
      return Response.json(
        { share: shareRow("active"), token: TOKEN },
        { status: 201 },
      );
    }
    if (call.path === `${BASE}/shares/${SHARE_ID}/revoke`) {
      revoked = true;
      return Response.json({ share: shareRow("revoked") });
    }
    return undefined;
  });
  const { view, user } = draw(`/wakerflows/${FLOW_ID}`);

  await user.click(await view.findByRole("button", { name: "分享" }));
  const dialog = await view.findByRole("dialog");
  expect(within(dialog).getByText("还没有分享链接。")).toBeDefined();
  const days = within(dialog).getByRole("textbox", { name: /有效期/ });
  const uses = within(dialog).getByRole("textbox", { name: /可导入次数/ });
  expect((days as HTMLInputElement).value).toBe("7");
  expect((uses as HTMLInputElement).value).toBe("10");
  // Out of bounds: nothing can be made.
  await user.clear(days);
  await user.type(days, "31");
  expect(
    within(dialog)
      .getByRole("button", { name: "创建链接" })
      .hasAttribute("disabled"),
  ).toBe(true);
  await user.clear(days);
  await user.type(days, "3");
  await user.clear(uses);
  await user.type(uses, "2");
  await user.click(within(dialog).getByRole("button", { name: "创建链接" }));

  expect(
    await within(dialog).findByText("现在就复制这个链接。关闭后无法再次查看。"),
  ).toBeDefined();
  const link = `${window.location.origin}/wakerflows/import/${TOKEN}`;
  expect(within(dialog).getByText(link)).toBeDefined();
  const created = calls.find(
    (c) => c.method === "POST" && c.path === `${BASE}/shares`,
  );
  expect(created?.body).toEqual({
    id: expect.any(String),
    expiresInDays: 3,
    maxUses: 2,
  });
  const list = await within(dialog).findByRole("list", { name: "分享链接" });
  expect(list.textContent).toContain("可用 · 已导入 0/10 次 · 剩余 10 次");
  expect(list.textContent).not.toContain(TOKEN);

  // Closed and opened again, the link is gone for good.
  // The footer's 关闭 (the corner's ✕ is named 关闭 too).
  const closers = within(dialog).getAllByRole("button", { name: "关闭" });
  await user.click(closers[closers.length - 1] as HTMLElement);
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
  await user.click(view.getByRole("button", { name: "分享" }));
  const again = await view.findByRole("dialog");
  expect(within(again).queryByText(link)).toBeNull();
  expect(within(again).getByRole("button", { name: "创建链接" })).toBeDefined();

  await user.click(await within(again).findByRole("button", { name: "撤销" }));
  await waitFor(() =>
    expect(
      within(again).getByRole("list", { name: "分享链接" }).textContent,
    ).toContain("已撤销"),
  );
  expect(within(again).queryByRole("button", { name: "撤销" })).toBeNull();
  expect(
    calls.filter((c) => c.path.endsWith("/revoke")).map((c) => c.method),
  ).toEqual(["POST"]);
});

test("a draft has no 分享", async () => {
  serve((call) =>
    call.path === BASE && call.method === "GET"
      ? Response.json({ flow: flow("draft") })
      : undefined,
  );
  const { view } = draw(`/wakerflows/${FLOW_ID}`);
  expect(await view.findByRole("button", { name: "编辑" })).toBeDefined();
  expect(view.queryByRole("button", { name: "分享" })).toBeNull();
});

test("the import page holds 导入 until every role has a coworker of one's own, then opens the new draft in the editor", async () => {
  serve((call) => {
    if (call.path === `/api/wakerflow-shares/${TOKEN}`)
      return Response.json({
        share: {
          name: "会议纪要",
          description: "整理与复核",
          slots: [
            { slot: "s1", role: "记录员", prompt: "你负责记录。" },
            { slot: "s2", role: "复核员" },
          ],
          inputCount: 1,
          stepCount: 2,
          expiresAt: new Date("2026-11-11T08:00:00Z").toISOString(),
          remainingUses: 3,
        },
      });
    if (call.path === `/api/wakerflow-shares/${TOKEN}/import`)
      return Response.json({
        imported: { flowId: NEW_FLOW, name: "会议纪要" },
      });
    return undefined;
  });
  const { view, user, router } = draw(`/wakerflows/import/${TOKEN}`);

  expect(await view.findByText("导入「会议纪要」")).toBeDefined();
  expect(view.getByText(/共 2 个步骤、1 项输入/)).toBeDefined();
  expect(view.getByText(/还可以导入 3 次/)).toBeDefined();
  expect(view.getByText("你负责记录。")).toBeDefined();
  const submit = view.getByRole("button", { name: "导入为草稿" });
  expect(submit.hasAttribute("disabled")).toBe(true);

  const first = view.getByRole("combobox", { name: "「记录员」由谁担任" });
  const second = view.getByRole("combobox", { name: "「复核员」由谁担任" });
  await waitFor(() =>
    expect(within(first).getAllByRole("option")).toHaveLength(3),
  );
  await user.selectOptions(first, "mine-1");
  expect(submit.hasAttribute("disabled")).toBe(true);
  // The same coworker for two roles is held back too.
  await user.selectOptions(second, "mine-1");
  expect(view.getByText("每个角色需要选择不同的员工。")).toBeDefined();
  expect(submit.hasAttribute("disabled")).toBe(true);
  await user.selectOptions(second, "mine-2");
  expect(submit.hasAttribute("disabled")).toBe(false);
  expect(calls.filter((c) => c.path.endsWith("/import"))).toEqual([]);

  await user.click(submit);
  expect(await view.findByText("编辑器")).toBeDefined();
  expect(router.state.location.pathname).toBe("/wakerflows/new");
  expect(router.state.location.search).toEqual({ flow: NEW_FLOW });
  const imported = calls.filter((c) => c.path.endsWith("/import"));
  expect(imported).toHaveLength(1);
  expect(imported[0]?.body).toEqual({
    requestId: expect.any(String),
    members: { s1: "mine-1", s2: "mine-2" },
  });
});

test("a link that cannot be used says why, and offers nothing to import", async () => {
  serve((call) =>
    call.path === `/api/wakerflow-shares/${TOKEN}`
      ? Response.json({ error: "这个分享链接已过期。" }, { status: 410 })
      : undefined,
  );
  const { view } = draw(`/wakerflows/import/${TOKEN}`);
  expect(await view.findByText("这个分享链接已过期。")).toBeDefined();
  expect(view.queryByRole("button", { name: "导入为草稿" })).toBeNull();
});

test("only a share link's own path is held for after sign-in, and it is taken once", () => {
  sessionStorage.clear();
  rememberShareImport("/settings/passwords");
  expect(takeShareImport()).toBeNull();
  rememberShareImport("/wakerflows/import/not-a-token");
  expect(takeShareImport()).toBeNull();
  rememberShareImport(`/wakerflows/import/${TOKEN}`);
  expect(takeShareImport()).toBe(TOKEN);
  expect(takeShareImport()).toBeNull();
});
