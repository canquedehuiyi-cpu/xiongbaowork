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
import { cleanup, render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentProfile } from "@/lib/agents/queries";
import { agentKeys } from "@/lib/agents/queries";
import { type PipelineTemplate, pipelineKeys } from "@/lib/pipelines/queries";
import { type WakerGroup, wakerGroupKeys } from "@/lib/waker-groups/queries";
import { Route as PipelinesRoute } from "@/routes/_authed/_app/pipelines";
import { settleReactWork } from "./settle-react-work";

/**
 * Spec I6 at the press: 运行 on a template naming coworkers the person may not use is refused whole by
 * the server (403 with the refused steps), and the screen lists those step numbers with the coworkers'
 * names — the person's next move is per step, so a bare "no" would leave them guessing which to fix.
 * Nothing opens: no run panel appears, because no run was started.
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
const calls: { method: string; path: string }[] = [];

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
  isolated: false,
  isolationActive: false,
  isolationOffReason: null,
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
  name: "编程群组",
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

/** The press is refused the way the server refuses it: 403, a sentence, and the refused steps. */
function serveRefusal() {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, path });
    if (method === "POST" && path.endsWith("/runs")) {
      return Response.json(
        {
          error:
            "第 2、3 步的员工（agent-review、agent-writer）你没有使用权，这次没有派出去。",
          refused: [
            { index: 1, stepId: "s2", agentId: "agent-review" },
            { index: 2, stepId: "s3", agentId: "agent-writer" },
          ],
        },
        { status: 403 },
      );
    }
    return Response.json({ templates: [template], group: crew, agents: [] });
  }) as typeof fetch;
}

test("运行 on a template with coworkers the person may not use lists the refused step numbers", async () => {
  serveRefusal();
  const view = draw(seed());

  await userEvent.type(
    await view.findByLabelText("交给编程任务的任务"),
    "给导入加一个进度列",
  );
  await userEvent.click(await view.findByRole("button", { name: "运行" }));

  const list = await view.findByRole("list", { name: "没有派出去的步骤" });
  const items = within(list)
    .getAllByRole("listitem")
    .map((item) => item.textContent);
  // The step numbers are 1-based as the person reads them, and the names are the coworkers' own.
  expect(items).toEqual(["第 2 步：阿审", "第 3 步：阿写"]);
  // Step 1's coworker is usable, so it is not listed as something to fix.
  expect(items.some((item) => item?.includes("第 1 步"))).toBe(false);
  expect(
    (await view.findByRole("alert")).textContent?.includes("没有派出去"),
  ).toBe(true);
  // No run was started, so nothing asks for one and no panel opens.
  expect(calls.some((entry) => entry.path.includes("/runs/"))).toBe(false);
  expect(view.queryByText("这次运行")).toBeNull();
  // The task stays in the box: the person fixes access and presses again, not retypes.
  expect(
    (view.getByLabelText("交给编程任务的任务") as HTMLInputElement).value,
  ).toBe("给导入加一个进度列");
});

/**
 * Any other refusal still reads as the server's own sentence, without a step list: a 403 that names no
 * steps is not this case, and inventing a list for it would point the person at the wrong fix.
 */
test("a refusal that names no steps shows the server's sentence and no step list", async () => {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, path });
    if (method === "POST" && path.endsWith("/runs")) {
      return Response.json({ error: "这里没有这条模板。" }, { status: 404 });
    }
    return Response.json({ templates: [template], group: crew, agents: [] });
  }) as typeof fetch;
  const view = draw(seed());

  await userEvent.type(await view.findByLabelText("交给编程任务的任务"), "x");
  await userEvent.click(await view.findByRole("button", { name: "运行" }));

  expect((await view.findByRole("alert")).textContent).toBe(
    "这里没有这条模板。",
  );
  expect(view.queryByRole("list", { name: "没有派出去的步骤" })).toBeNull();
});
