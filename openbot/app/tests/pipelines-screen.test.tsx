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
 * Ticket 021 at the screen where a person writes a crew's plan and presses it (spec D10 / I1-I4).
 *
 * The server's own suite proves the sequence; this proves what a person can actually do with it: read
 * the order the crew will work in, hand it a task, and see where the run got to. The step states are
 * asserted as words rather than as codes, because the words are the product — "等你处理" is the thing
 * that tells somebody to go answer an approval.
 */
let registeredHere = false;
beforeAll(() => {
  // One happy-dom global per process: registering twice throws in `beforeAll`, which silently deletes
  // this file's tests from the run — and not unregistering deletes the next file's.
  if (!("document" in globalThis)) {
    GlobalRegistrator.register();
    registeredHere = true;
  }
});
afterAll(async () => {
  if (!registeredHere) return;
  // Drain React before the document goes away, for the reason recorded in `settle-react-work.ts`.
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = globalThis.fetch;
const calls: { method: string; path: string; body: unknown }[] = [];
/** Only the writes: a successful one invalidates a query, and counting the reads it reissues would
 * test the cache instead of the screen. */
const writes = () => calls.filter((entry) => entry.method !== "GET");

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
  roleDescription: "Reads the diff.",
};

/** In the workspace, but not in this crew — the one a step may not be given to. */
const outsider: AgentProfile = {
  ...reviewer,
  id: "agent-outsider",
  name: "组外人",
};

const crew: WakerGroup = {
  id: "crew-1",
  name: "编程小组",
  description: null,
  members: [
    { agentId: "agent-dev", position: 0 },
    { agentId: "agent-review", position: 1 },
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
  ],
};

const run = {
  status: "awaiting_action",
  cursor: 1,
  parentTaskId: "task-parent",
  steps: [
    { ...template.steps[0]!, state: "done", output: "改好了" },
    { ...template.steps[1]!, state: "awaiting_action" },
  ],
};

function seed() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(agentKeys.list(false), [
    developer,
    reviewer,
    outsider,
  ]);
  queryClient.setQueryData(wakerGroupKeys.list(), [crew]);
  queryClient.setQueryData(pipelineKeys.templates("crew-1"), [template]);
  return queryClient;
}

function draw(queryClient: QueryClient, entry = "/pipelines") {
  const root = createRootRoute({ component: () => <Outlet /> });
  const router = createRouter({
    context: {},
    history: createMemoryHistory({ initialEntries: [entry] }),
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

/** The endpoint stub. Reads are answered from the fixtures above; writes echo what was sent. */
function serve() {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    calls.push({
      method,
      path,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    /*
     * The press answers with the run's ids and the panel reads its state, and these are two different
     * bodies at two different paths — a stub that conflated them would pass while the screen sat on an
     * undefined run id and showed nothing.
     */
    if (method === "POST" && path.endsWith("/runs")) {
      return Response.json({
        run: { runId: "run-9", parentTaskId: "task-parent" },
      });
    }
    if (path.includes("/api/group-pipelines/runs/")) {
      return Response.json({ run });
    }
    return Response.json({ templates: [template], group: crew, agents: [] });
  }) as typeof fetch;
}

test("the plan reads in the order the crew will work in", async () => {
  serve();
  const view = draw(seed());
  // The names, not the ids: a person recognises 阿开 and 阿审, and a uuid means nothing on a card.
  const row = await view.findByText("编程任务");
  expect(row).toBeDefined();
  expect(await view.findByText("阿开：写出实现 → 阿审：审差异")).toBeDefined();
});

/**
 * Pressing 运行 hands the crew the task and then shows where it got to.
 *
 * The two halves are one assertion chain on purpose: the press answers before the work is done, so a
 * screen that only posted and stopped would leave the person staring at a plan they just started. The
 * parked step's own word is the point of the second half — that is what tells them the run is theirs
 * to answer.
 */
test("pressing run posts the task, and the run panel says which step is waiting", async () => {
  serve();
  const view = draw(seed());

  const box = await view.findByLabelText("交给编程任务的任务");
  await userEvent.type(box, "给导入加一个进度列");
  await userEvent.click(await view.findByRole("button", { name: "运行" }));

  await waitFor(() => {
    const started = writes().find((entry) => entry.path.endsWith("/runs"));
    expect(started?.body).toEqual({ task: "给导入加一个进度列" });
  });

  // The first step is over, the second is stopped on a person.
  expect(await view.findByText(/第 2 步 · 阿审/)).toBeDefined();
  expect(await view.findByText(/等你处理/)).toBeDefined();
  expect(await view.findByText(/第 1 步 · 阿开/)).toBeDefined();
  expect(await view.findByText(/做完了 · 改好了/)).toBeDefined();
  // And the plan is still going, so stopping it is offered.
  expect(
    await view.findByRole("button", { name: "中止这次运行" }),
  ).toBeDefined();
});

/**
 * A plan with nothing in it cannot be saved.
 *
 * The server refuses an empty template, and a screen that let the press happen would show a refusal
 * as though the person had done something wrong. The button is simply not available until the plan is
 * one: a name, at least one step, and something for that step to do.
 */
test("an empty plan cannot be saved", async () => {
  serve();
  const view = draw(seed());

  const save = await view.findByRole("button", { name: "保存流程" });
  expect(save.hasAttribute("disabled")).toBe(true);

  await userEvent.type(await view.findByLabelText("流程名称"), "汇总每周进度");
  await userEvent.click(await view.findByRole("button", { name: "加一步" }));
  expect(save.hasAttribute("disabled")).toBe(true);

  await userEvent.type(
    await view.findByLabelText("第 1 步要做什么"),
    "把本周的任务数汇总成一段",
  );
  expect(
    (await view.findByRole("button", { name: "保存流程" })).hasAttribute(
      "disabled",
    ),
  ).toBe(false);
  expect(writes()).toEqual([]);
});

test("a step can only be given to somebody the crew actually has", async () => {
  serve();
  const view = draw(seed());

  // Which crew is chosen is in the accessibility tree, not only in its colour.
  const chosen = await view.findByRole("button", { name: "编程小组" });
  expect(chosen.getAttribute("aria-pressed")).toBe("true");

  await userEvent.click(await view.findByRole("button", { name: "加一步" }));
  const picker = (await view.findByLabelText(
    "第 1 步的员工",
  )) as HTMLSelectElement;
  // This workspace has a third coworker who is not in the crew, and the plan is not offered to them —
  // the screen's own sentence is 流程的步骤只能交给组里的员工, and the server refuses what it takes.
  expect([...picker.options].map((option) => option.textContent)).toEqual([
    "阿开",
    "阿审",
  ]);
});

/**
 * The board's 打开 on a crew's card, and the group chat's 查看这次运行, both land here with `?run=`
 * (audit N1). Arriving that way has to show the run itself, not the plan list with the panel closed --
 * a link that lands on the right page and the wrong state is still a link that did not go anywhere.
 */
test("arriving with ?run= opens that run, without pressing anything", async () => {
  serve();
  const view = draw(seed(), "/pipelines?run=run-9");

  expect(await view.findByText(/第 2 步 · 阿审/)).toBeDefined();
  expect(await view.findByText(/等你处理/)).toBeDefined();
  // It read the run it was sent to, and wrote nothing on the way in.
  expect(calls.some((entry) => entry.path.endsWith("/runs/run-9"))).toBe(true);
  expect(writes()).toEqual([]);
});
