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
import { type PipelineTemplate, pipelineKeys } from "@/lib/pipelines/queries";
import { type WakerGroup, wakerGroupKeys } from "@/lib/waker-groups/queries";
import { Route as PipelinesRoute } from "@/routes/_authed/_app/pipelines";
import { settleReactWork } from "./settle-react-work";

/**
 * Spec I1 at the screen: a saved plan can be opened in the editor, changed and saved in place, or
 * deleted after one confirmation. The edit is sent without a crew (the crew a plan was written for is
 * fixed server-side), and a refusal — a name the crew already uses — reads as the server's sentence with
 * the editor still open, so the person renames rather than retypes.
 */
let registeredHere = false;
beforeAll(() => {
  // One happy-dom global per process: see `pipelines-screen.test.tsx` for why this is guarded.
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
const calls: { method: string; path: string; body: unknown }[] = [];

afterEach(() => {
  cleanup();
  calls.length = 0;
  globalThis.fetch = originalFetch;
});

const developer: AgentProfile = {
  id: "agent-dev",
  name: "阿开",
  title: "Backend Engineer",
  roleDescription: "Writes the code.",
  avatarSeed: "dev",
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
const reviewer: AgentProfile = {
  ...developer,
  id: "agent-review",
  name: "阿审",
};
const writer: AgentProfile = {
  ...developer,
  id: "agent-writer",
  name: "阿写",
};

const crew: WakerGroup = {
  id: "crew-1",
  name: "编程小组",
  description: null,
  members: [
    { agentId: "agent-dev", position: 0 },
    { agentId: "agent-review", position: 1 },
    { agentId: "agent-writer", position: 2 },
  ],
};

const template: PipelineTemplate = {
  id: "tpl-1",
  groupId: "crew-1",
  name: "编程任务",
  createdAt: new Date().toISOString(),
  steps: [
    { id: "s1", agentId: "agent-dev", instruction: "写出实现" },
    { id: "s2", agentId: "agent-review", instruction: "审差异" },
    { id: "s3", agentId: "agent-writer", instruction: "汇总" },
  ],
};

function seed() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(agentKeys.list(false), [
    developer,
    reviewer,
    writer,
  ]);
  queryClient.setQueryData(wakerGroupKeys.list(), [crew]);
  queryClient.setQueryData(pipelineKeys.templates("crew-1"), [template]);
  return queryClient;
}

function draw(queryClient: QueryClient) {
  const root = createRootRoute({ component: () => <Outlet /> });
  const router = createRouter({
    context: {},
    history: createMemoryHistory({ initialEntries: ["/pipelines"] }),
    routeTree: root.addChildren([
      PipelinesRoute.update({
        getParentRoute: () => root,
        path: "/pipelines",
      } as never),
      createRoute({
        getParentRoute: () => root,
        path: "/wakers",
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

/**
 * The server as the screen meets it: writes answer with the template id, or with `refusal` when one is
 * set; every read answers with the crew's one template.
 */
function serve(refusal?: { status: number; error: string }) {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    calls.push({
      method,
      path,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    if (method === "PUT" || method === "DELETE") {
      return refusal
        ? Response.json({ error: refusal.error }, { status: refusal.status })
        : Response.json({ templateId: "tpl-1" });
    }
    return Response.json({ templates: [template], group: crew, agents: [] });
  }) as typeof fetch;
}

const writes = () => calls.filter((entry) => entry.method !== "GET");

test("编辑 opens the saved plan in the editor and 保存修改 rewrites it in place", async () => {
  serve();
  const view = draw(seed());

  await userEvent.click(await view.findByRole("button", { name: "编辑" }));

  // The editor now holds the saved plan, not a blank one.
  expect(await view.findByText("编辑流程：编程任务")).toBeDefined();
  expect((view.getByLabelText("流程名称") as HTMLInputElement).value).toBe(
    "编程任务",
  );
  const second = view.getByLabelText("第 2 步要做什么") as HTMLInputElement;
  expect(second.value).toBe("审差异");
  expect(
    (view.getByLabelText("第 2 步的员工") as HTMLSelectElement).value,
  ).toBe("agent-review");
  expect(view.getByText(/已经开跑的会按开跑时的步骤跑完/)).toBeDefined();

  // A session bound to this document: the direct `userEvent.clear(el)` ignores the element and uses the
  // global document as it was when user-event was imported, which is before happy-dom is registered.
  const user = userEvent.setup({ document });
  await user.clear(second);
  await user.type(second, "逐行审差异");
  await userEvent.click(view.getByRole("button", { name: "保存修改" }));

  await waitFor(() => expect(writes()).toHaveLength(1));
  const [write] = writes();
  expect(write?.method).toBe("PUT");
  expect(write?.path).toBe("/api/group-pipelines/templates/tpl-1");
  // Name and steps only: the crew is not the edit's to change.
  expect(write?.body).toEqual({
    name: "编程任务",
    steps: [
      { id: "s1", agentId: "agent-dev", instruction: "写出实现" },
      { id: "s2", agentId: "agent-review", instruction: "逐行审差异" },
      { id: "s3", agentId: "agent-writer", instruction: "汇总" },
    ],
  });
  // Saved: the editor goes back to writing a new plan.
  expect(await view.findByText("新建一条流程")).toBeDefined();
  expect(view.queryByRole("button", { name: "保存修改" })).toBeNull();
});

test("a name the crew already uses is refused in the server's words and the edit stays open", async () => {
  serve({
    status: 409,
    error: "这个小组里已经有一条同名的流程了，换个名字再保存。",
  });
  const view = draw(seed());

  await userEvent.click(await view.findByRole("button", { name: "编辑" }));
  await userEvent.click(await view.findByRole("button", { name: "保存修改" }));

  expect((await view.findByRole("alert")).textContent).toBe(
    "这个小组里已经有一条同名的流程了，换个名字再保存。",
  );
  expect(view.getByText("编辑流程：编程任务")).toBeDefined();
  expect((view.getByLabelText("流程名称") as HTMLInputElement).value).toBe(
    "编程任务",
  );

  // 取消编辑 drops the draft without writing anything more.
  await userEvent.click(view.getByRole("button", { name: "取消编辑" }));
  expect(await view.findByText("新建一条流程")).toBeDefined();
  expect(writes()).toHaveLength(1);
});

test("删除 asks once, says runs already started are kept, and only then deletes", async () => {
  serve();
  const view = draw(seed());

  await userEvent.click(await view.findByRole("button", { name: "删除" }));
  expect(
    await view.findByText(/确定删除「编程任务」？已经开跑的运行会照常跑完/),
  ).toBeDefined();
  // Asking is not deleting.
  expect(writes()).toEqual([]);

  await userEvent.click(view.getByRole("button", { name: "取消" }));
  expect(view.queryByRole("button", { name: "确定删除" })).toBeNull();
  expect(writes()).toEqual([]);

  await userEvent.click(view.getByRole("button", { name: "删除" }));
  await userEvent.click(await view.findByRole("button", { name: "确定删除" }));

  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(writes()[0]).toMatchObject({
    method: "DELETE",
    path: "/api/group-pipelines/templates/tpl-1",
  });
  await waitFor(() =>
    expect(view.queryByRole("button", { name: "确定删除" })).toBeNull(),
  );
});
