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
import { groupFlowOptions } from "@/components/tasks/dispatch-to-group";
import type { AgentProfile } from "@/lib/agents/queries";
import type { PipelineTemplate } from "@/lib/pipelines/queries";
import type { WakerGroup } from "@/lib/waker-groups/queries";
import { Route as TasksRoute } from "@/routes/_authed/_app/tasks";
import { settleReactWork } from "./settle-react-work";

/**
 * Spec I2 from the board: 派给群组 in the board's header hands a crew's flow a task through the same
 * start-run call the template page uses. Success refreshes the board's reads and points at the run on
 * /pipelines; a 403 from the pre-dispatch check (spec I6) lists the refused step numbers and starts
 * nothing. Data comes from a recording fetch stub -- no network, no real model.
 */
let registeredHere = false;
const originalFetch = globalThis.fetch;

beforeAll(() => {
  if (!("document" in globalThis)) {
    GlobalRegistrator.register();
    registeredHere = true;
  }
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

afterAll(async () => {
  if (!registeredHere) return;
  await settleReactWork();
  GlobalRegistrator.unregister();
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
const writer: AgentProfile = { ...developer, id: "agent-writer", name: "阿写" };

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

type Call = { method: string; path: string; body: unknown };

/** Every read the board and the dialog make, plus the one write under test, answered by `onRun`. */
function serve(calls: Call[], onRun: () => Response) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    calls.push({
      method,
      path,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    if (method === "POST" && path.endsWith("/runs")) return onRun();
    const body = path.startsWith("/api/tasks")
      ? { tasks: [] }
      : path.startsWith("/api/devices")
        ? { devices: [] }
        : path.startsWith("/api/group-pipelines/templates")
          ? { templates: [template] }
          : path.startsWith("/api/waker-groups")
            ? { groups: [crew] }
            : { agents: [developer, reviewer, writer] };
    return Response.json(body);
  }) as typeof fetch;
}

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

type TestFileRouteWiring = Parameters<typeof TasksRoute.update>[0] & {
  id: string;
  path: string;
  getParentRoute: () => typeof app;
};

const tasksRoute = TasksRoute.update({
  id: "/tasks",
  path: "/tasks",
  getParentRoute: () => app,
} as TestFileRouteWiring);

/** A stand-in for the run page: the test asks where the link lands, not what the page draws. */
const pipelinesRoute = createRoute({
  path: "/pipelines",
  getParentRoute: () => app,
  component: () => <p>流程页</p>,
});

const routeTree = root.addChildren([
  authed.addChildren([app.addChildren([tasksRoute, pipelinesRoute])]),
]);

function draw() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createRouter({
    context: {},
    history: createMemoryHistory({ initialEntries: ["/tasks"] }),
    routeTree,
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, view };
}

const taskReads = (calls: Call[]) =>
  calls.filter(
    (call) => call.method === "GET" && call.path.startsWith("/api/tasks"),
  ).length;

async function openDialog(view: ReturnType<typeof render>) {
  const user = userEvent.setup({ document });
  await user.click(await view.findByRole("button", { name: "派给群组" }));
  const dialog = await within(document.body).findByRole("dialog");
  // The crew's flow arrives from its own read; the picker names the crew and its step count.
  const picker = (await within(dialog).findByLabelText(
    "群组流程",
  )) as HTMLSelectElement;
  return { user, dialog, picker };
}

test("派给群组 starts the crew's flow, refreshes the board and links to the run", async () => {
  const calls: Call[] = [];
  serve(calls, () =>
    Response.json(
      { run: { runId: "run-9", parentTaskId: "task-parent" } },
      { status: 201 },
    ),
  );
  const { router, view } = draw();
  await view.findByText("任务看板");
  await waitFor(() => expect(taskReads(calls)).toBeGreaterThanOrEqual(2));

  const { user, dialog, picker } = await openDialog(view);
  expect(picker.value).toBe("tpl-1");
  expect([...picker.options].map((option) => option.textContent)).toEqual([
    "编程群组（3 步）",
  ]);
  const send = within(dialog).getByRole("button", { name: "派出去" });
  // Nothing to send until there is a task to send.
  expect((send as HTMLButtonElement).disabled).toBe(true);

  await user.type(
    within(dialog).getByLabelText("任务内容"),
    "  给导入加一个进度列 ",
  );
  const sent = calls.length;
  await user.click(send);

  expect((await within(dialog).findByRole("status")).textContent).toContain(
    "已派给「编程群组」",
  );
  const posts = calls.filter((call) => call.method === "POST");
  expect(posts).toEqual([
    {
      method: "POST",
      path: "/api/group-pipelines/templates/tpl-1/runs",
      body: { task: "给导入加一个进度列" },
    },
  ]);
  // The new parent card belongs on the board now. The list and the bar are two reads (same address
  // on an unfiltered board, separate cache keys), and the press asks both again -- one each.
  await waitFor(() => expect(taskReads(calls.slice(sent))).toBe(2));

  const link = within(dialog).getByRole("link", { name: "查看这次运行" });
  expect(link.getAttribute("href")).toBe("/pipelines?run=run-9");
  await user.click(link);
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/pipelines"),
  );
  expect(router.state.location.searchStr).toBe("?run=run-9");
});

test("a 403 from the pre-dispatch check lists the refused step numbers and starts nothing", async () => {
  const calls: Call[] = [];
  serve(calls, () =>
    Response.json(
      {
        error: "第 2、3 步的员工你没有使用权，这次没有派出去。",
        refused: [
          { index: 1, stepId: "s2", agentId: "agent-review" },
          { index: 2, stepId: "s3", agentId: "agent-writer" },
        ],
      },
      { status: 403 },
    ),
  );
  const { router, view } = draw();
  await view.findByText("任务看板");

  const { user, dialog } = await openDialog(view);
  const box = within(dialog).getByLabelText("任务内容") as HTMLTextAreaElement;
  await user.type(box, "给导入加一个进度列");
  await user.click(within(dialog).getByRole("button", { name: "派出去" }));

  const list = await within(dialog).findByRole("list", {
    name: "没有派出去的步骤",
  });
  expect(
    within(list)
      .getAllByRole("listitem")
      .map((item) => item.textContent),
  ).toEqual(["第 2 步：阿审", "第 3 步：阿写"]);
  // Nothing was started: no run link, no success line, and the task stays for the next press.
  expect(
    within(dialog).queryByRole("link", { name: "查看这次运行" }),
  ).toBeNull();
  expect(within(dialog).queryByRole("status")).toBeNull();
  expect(box.value).toBe("给导入加一个进度列");
  expect(router.state.location.pathname).toBe("/tasks");
});

test("any other refusal shows the server's sentence without a step list", async () => {
  const calls: Call[] = [];
  serve(calls, () =>
    Response.json({ error: "这里没有这条模板。" }, { status: 404 }),
  );
  const { view } = draw();
  await view.findByText("任务看板");

  const { user, dialog } = await openDialog(view);
  await user.type(within(dialog).getByLabelText("任务内容"), "x");
  await user.click(within(dialog).getByRole("button", { name: "派出去" }));

  expect((await within(dialog).findByRole("alert")).textContent).toBe(
    "这里没有这条模板。",
  );
  expect(
    within(dialog).queryByRole("list", { name: "没有派出去的步骤" }),
  ).toBeNull();
});

test("the picker names a crew's flows apart only when it has more than one, and hides unknown crews", () => {
  const second: PipelineTemplate = { ...template, id: "tpl-2", name: "修缺陷" };
  const stranger: PipelineTemplate = {
    ...template,
    id: "tpl-3",
    groupId: "crew-elsewhere",
  };
  const solo: WakerGroup = { ...crew, id: "crew-2", name: "写作群组" };
  const soloFlow: PipelineTemplate = {
    ...template,
    id: "tpl-4",
    groupId: "crew-2",
    steps: [template.steps[0]],
  };

  expect(
    groupFlowOptions([template, second, stranger, soloFlow], [crew, solo]),
  ).toEqual([
    { templateId: "tpl-1", label: "编程群组 · 编程任务", steps: 3 },
    { templateId: "tpl-2", label: "编程群组 · 修缺陷", steps: 3 },
    { templateId: "tpl-4", label: "写作群组", steps: 1 },
  ]);
});
