import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
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
afterEach(() => cleanup());

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
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
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
});
