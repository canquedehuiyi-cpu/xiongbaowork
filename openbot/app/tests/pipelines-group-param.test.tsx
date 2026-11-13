import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { agentKeys } from "@/lib/agents/queries";
import { type PipelineTemplate, pipelineKeys } from "@/lib/pipelines/queries";
import { type WakerGroup, wakerGroupKeys } from "@/lib/waker-groups/queries";
import { Route as PipelinesRoute } from "@/routes/_authed/_app/pipelines";
import { settleReactWork } from "./settle-react-work";

/** `/pipelines?group=<id>`: the page opens on that group's section (员工页卡片的「组团流程」). */
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

const crew = (id: string, name: string): WakerGroup => ({
  id,
  name,
  description: null,
  members: [{ agentId: "agent-a", position: 0 }],
});
const template = (groupId: string): PipelineTemplate => ({
  id: `tpl-${groupId}`,
  groupId,
  name: `流程-${groupId}`,
  createdAt: new Date().toISOString(),
  steps: [{ id: "s1", agentId: "agent-a", instruction: "做事" }],
});

function draw(entry: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(agentKeys.list(false), []);
  client.setQueryData(wakerGroupKeys.list(), [
    crew("crew-1", "第一组"),
    crew("crew-2", "第二组"),
  ]);
  client.setQueryData(pipelineKeys.templates("crew-1"), [template("crew-1")]);
  client.setQueryData(pipelineKeys.templates("crew-2"), [template("crew-2")]);
  const root = createRootRoute({ component: () => <Outlet /> });
  const router = createRouter({
    context: {},
    history: createMemoryHistory({ initialEntries: [entry] }),
    routeTree: root.addChildren([
      PipelinesRoute.update({
        getParentRoute: () => root,
        path: "/pipelines",
      } as never),
    ]),
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return Object.assign(view, { router });
}

test("?group=crew-2 opens that crew's section", async () => {
  const view = draw("/pipelines?group=crew-2");
  expect(await view.findByText("流程-crew-2")).toBeTruthy();
  expect(view.queryByText("流程-crew-1")).toBeNull();
  expect(
    view.getByRole("button", { name: "第二组" }).getAttribute("aria-pressed"),
  ).toBe("true");
  expect(
    view.container.querySelector("section[data-group=crew-2]"),
  ).toBeTruthy();
});

test("?group= pointing at nothing leaves the page as usual", async () => {
  const view = draw("/pipelines?group=crew-missing");
  await waitFor(() => expect(view.getByText("流程-crew-1")).toBeTruthy());
  expect(
    view.getByRole("button", { name: "第一组" }).getAttribute("aria-pressed"),
  ).toBe("true");
  expect(
    view.getByRole("button", { name: "第二组" }).getAttribute("aria-pressed"),
  ).toBe("false");
  expect(
    view.container.querySelector("section[data-group=crew-1]"),
  ).toBeTruthy();
  expect(view.queryByRole("alert")).toBeNull();
});

function stubScroll() {
  return spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(
    () => {},
  );
}

test("arriving by ?group= scrolls to the section once, and choosing groups by hand does not scroll again", async () => {
  const scroll = stubScroll();
  const view = draw("/pipelines?group=crew-2");
  await view.findByText("流程-crew-2");
  await waitFor(() => expect(scroll).toHaveBeenCalledTimes(1));
  await userEvent.click(view.getByRole("button", { name: "第一组" }));
  await view.findByText("流程-crew-1");
  await userEvent.click(view.getByRole("button", { name: "第二组" }));
  await view.findByText("流程-crew-2");
  expect(scroll).toHaveBeenCalledTimes(1);
  scroll.mockRestore();
});

test("starting a run keeps the group the page was opened on", async () => {
  const scroll = stubScroll();
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === "POST" && path.endsWith("/runs"))
      return Response.json({
        run: { runId: "run-9", parentTaskId: "task-parent" },
      });
    if (path.includes("/api/group-pipelines/runs/"))
      return Response.json({
        run: { status: "running", cursor: 0, parentTaskId: "p", steps: [] },
      });
    return Response.json([]);
  }) as typeof fetch;
  const view = draw("/pipelines?group=crew-2");
  await userEvent.type(
    await view.findByLabelText("交给流程-crew-2的任务"),
    "做点事",
  );
  await userEvent.click(await view.findByRole("button", { name: "运行" }));
  await waitFor(() =>
    expect(view.router.state.location.search).toEqual({
      group: "crew-2",
      run: "run-9",
    }),
  );
  expect(
    view.getByRole("button", { name: "第二组" }).getAttribute("aria-pressed"),
  ).toBe("true");
  scroll.mockRestore();
});
