import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
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
import { Route as AutonomousRoute } from "@/routes/_authed/_app/autonomous";
import { Route as PipelinesRoute } from "@/routes/_authed/_app/pipelines";
import { Route as TasksRoute } from "@/routes/_authed/_app/tasks";
import { settleReactWork } from "./settle-react-work";

// Exercise the real route queries: a 404/500 is a failed read, and Retry must issue a new read.
beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());
const originalFetch = globalThis.fetch;
const routes = [TasksRoute, PipelinesRoute, AutonomousRoute];
let snapshots: PropertyDescriptorMap[];
let queryClient: QueryClient;
beforeEach(() => {
  snapshots = routes.map((route) => ({
    ...Object.getOwnPropertyDescriptors(route),
    options: {
      ...Object.getOwnPropertyDescriptor(route, "options"),
      value: { ...route.options },
    },
  }));
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
});
afterEach(async () => {
  cleanup();
  await queryClient.cancelQueries();
  queryClient.clear();
  await settleReactWork();
  globalThis.fetch = originalFetch;
  routes.forEach((route, index) => {
    for (const key of Reflect.ownKeys(route)) {
      if (!(key in snapshots[index])) Reflect.deleteProperty(route, key);
    }
    Object.defineProperties(route, snapshots[index]);
  });
});

function draw(route: (typeof routes)[number], path: string) {
  const root = createRootRoute({ component: Outlet });
  const authed = createRoute({
    id: "/_authed",
    getParentRoute: () => root,
    component: Outlet,
  });
  const app = createRoute({
    id: "/_app",
    getParentRoute: () => authed,
    component: Outlet,
  });
  const wired = route.update({ getParentRoute: () => app, path } as never);
  const router = createRouter({
    routeTree: root.addChildren([
      authed.addChildren([app.addChildren([wired])]),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

const agent = {
  id: "business-agent",
  name: "业务员工",
  title: "测试",
  roleDescription: "只读验证",
  avatarSeed: "business",
  visibility: "private",
  builtIn: true,
  hidden: false,
  pinned: false,
  systemOwned: false,
  canManage: true,
  mine: true,
};
const crew = {
  id: "business-crew",
  name: "业务小组",
  members: [],
  description: null,
};
const summary = {
  agentId: agent.id,
  routines: [],
  responsibilities: [],
  proactive: [],
  lastActivityAt: null,
};
function serve(failPath: string, status = 404) {
  let failing = true;
  let reads = 0;
  globalThis.fetch = (async (input: unknown) => {
    const path = String(input).split("?")[0];
    if (path === failPath) {
      reads++;
      if (failing) return new Response("Not found", { status });
    }
    return Response.json({
      tasks: [],
      devices: [],
      agents: [agent],
      groups: [crew],
      templates: [],
      autonomous: summary,
    });
  }) as typeof fetch;
  return {
    recover: () => {
      failing = false;
    },
    reads: () => reads,
  };
}

test("task failures do not draw an empty board or zero totals, and retry recovers", async () => {
  const api = serve("/api/tasks");
  const view = draw(TasksRoute, "/tasks");
  expect((await view.findByRole("alert")).textContent).toContain(
    "任务加载失败",
  );
  expect(view.queryByText(/看板上还没有任务/)).toBeNull();
  expect(view.queryByText(/四个数按所选周期统计/)).toBeNull();
  const reads = api.reads();
  api.recover();
  await userEvent.click(view.getByRole("button", { name: "重试" }));
  expect(await view.findByText(/看板上还没有任务/)).toBeTruthy();
  await waitFor(() => expect(view.queryByRole("alert")).toBeNull());
  expect(api.reads()).toBeGreaterThan(reads);
});

test("a failed group read says it failed instead of claiming there are no groups", async () => {
  const api = serve("/api/waker-groups", 500);
  const view = draw(PipelinesRoute, "/pipelines");
  expect((await view.findByRole("alert")).textContent).toContain(
    "小组加载失败",
  );
  expect(view.queryByText("还没有小组")).toBeNull();
  api.recover();
  await userEvent.click(view.getByRole("button", { name: "重试" }));
  expect(await view.findByRole("button", { name: "业务小组" })).toBeTruthy();
  await waitFor(() => expect(view.queryByRole("alert")).toBeNull());
});

test("a failed template read offers retry without claiming the group has zero flows", async () => {
  const api = serve("/api/group-pipelines/templates");
  const view = draw(PipelinesRoute, "/pipelines");
  expect((await view.findByRole("alert")).textContent).toContain(
    "流程加载失败",
  );
  expect(view.queryByText("0 条流程")).toBeNull();
  api.recover();
  await userEvent.click(view.getByRole("button", { name: "重试" }));
  expect(await view.findByText("0 条流程")).toBeTruthy();
  await waitFor(() => expect(view.queryByRole("alert")).toBeNull());
});

test("an autonomous read failure has an error and retry instead of a blank page", async () => {
  const api = serve(`/api/agents/${agent.id}/autonomous`);
  const view = draw(AutonomousRoute, "/autonomous");
  expect((await view.findByRole("alert")).textContent).toContain(
    "自主工作加载失败",
  );
  expect(view.queryByRole("button", { name: "新建定时任务" })).toBeNull();
  api.recover();
  await userEvent.click(view.getByRole("button", { name: "重试" }));
  expect(
    await view.findByRole("button", { name: "新建定时任务" }),
  ).toBeTruthy();
  await waitFor(() => expect(view.queryByRole("alert")).toBeNull());
});

test("a failed employee read on autonomous work offers retry without a false empty state", async () => {
  const api = serve("/api/agents", 500);
  const view = draw(AutonomousRoute, "/autonomous");
  expect((await view.findByRole("alert")).textContent).toContain(
    "员工加载失败",
  );
  expect(view.queryByText(/还没有可用员工/)).toBeNull();
  api.recover();
  await userEvent.click(view.getByRole("button", { name: "重试" }));
  expect(
    await view.findByRole("button", { name: "新建定时任务" }),
  ).toBeTruthy();
  await waitFor(() => expect(view.queryByRole("alert")).toBeNull());
});
