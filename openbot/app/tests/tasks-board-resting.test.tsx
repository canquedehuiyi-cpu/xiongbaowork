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
import { agentKeys } from "@/lib/agents/queries";
import { deviceKeys } from "@/lib/devices/queries";
import {
  boardEmptySentence,
  Route as TasksRoute,
} from "@/routes/_authed/_app/tasks";
import { settleReactWork } from "./settle-react-work";

/**
 * Spec F5: an address whose ?machineId= names no device this person has registered says the Wakers
 * are resting, rather than calling a machine that does not exist "idle in this window". The device
 * list is the one the board already reads for its machine chips (GET /api/devices); while that read
 * is pending or has failed the board must not claim anyone is resting.
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

const RESTING = "正在休息";
const IDLE =
  "这台机器在当前时间范围内没有待办——其他机器在 /tasks 有各自的看板。";

const DEVICE = {
  id: "row-1",
  deviceId: "d-1",
  name: "dev-laptop",
  platform: "windows",
  lastSeenAt: new Date().toISOString(),
  online: true,
};

type DevicesAnswer = "ok" | "pending" | "error";

function controlFetch(devices: DevicesAnswer) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.startsWith("/api/devices")) {
      if (devices === "pending") return new Promise<Response>(() => {});
      if (devices === "error") {
        return new Response(JSON.stringify({ error: "boom" }), {
          headers: { "content-type": "application/json" },
          status: 500,
        });
      }
    }
    const body = path.startsWith("/api/tasks")
      ? { tasks: [] }
      : path.startsWith("/api/devices")
        ? { devices: [DEVICE] }
        : { agents: [] };
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
      status: 200,
    });
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

const routeTree = root.addChildren([
  authed.addChildren([app.addChildren([tasksRoute])]),
]);

function draw(initialEntry: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(agentKeys.list(false), []);
  const router = createRouter({
    context: {},
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
    routeTree,
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { view, queryClient };
}

test("the sentence: an unregistered machine rests, a registered one is idle, an unknown answer claims nothing", () => {
  const base = { crew: "", status: "", q: "" };
  const resting = boardEmptySentence({
    ...base,
    machineId: "ghost",
    machineRegistered: false,
  });
  expect(resting).toContain("Waker 们正在休息");
  // A filter cannot bring work back from a machine that is not there; resting still wins.
  expect(
    boardEmptySentence({
      ...base,
      status: "failed",
      machineId: "ghost",
      machineRegistered: false,
    }),
  ).toBe(resting);
  expect(
    boardEmptySentence({ ...base, machineId: "d-1", machineRegistered: true }),
  ).toBe(IDLE);
  expect(boardEmptySentence({ ...base, machineId: "d-1" })).toBe(IDLE);
  // No machine in the address: whatever the list said, nobody is called resting.
  expect(
    boardEmptySentence({ ...base, machineId: "", machineRegistered: false }),
  ).not.toContain(RESTING);
});

test("an address naming no registered device says the Wakers are resting", async () => {
  controlFetch("ok");
  const { view } = draw("/tasks?machineId=ghost-9");
  const sentence = await view.findByText(/Waker 们正在休息/);
  expect(sentence.textContent).toContain(RESTING);
  expect(view.queryByText(IDLE)).toBeNull();
});

test("a registered device with no tasks keeps the idle sentence", async () => {
  controlFetch("ok");
  const { view } = draw("/tasks?machineId=d-1");
  await view.findByText(IDLE);
  // The chip for the registered machine is drawn, so the list has answered before the check.
  await view.findByRole("button", { name: /dev-laptop/ });
  expect(view.queryByText(new RegExp(RESTING))).toBeNull();
});

test("while the device list is still loading, nobody is said to be resting", async () => {
  controlFetch("pending");
  const { view, queryClient } = draw("/tasks?machineId=ghost-9");
  await view.findByText(IDLE);
  expect(queryClient.getQueryState(deviceKeys.list())?.status).toBe("pending");
  expect(view.queryByText(new RegExp(RESTING))).toBeNull();
});

test("when the device list failed, nobody is said to be resting", async () => {
  controlFetch("error");
  const { view, queryClient } = draw("/tasks?machineId=ghost-9");
  await waitFor(() =>
    expect(queryClient.getQueryState(deviceKeys.list())?.status).toBe("error"),
  );
  await view.findByText(IDLE);
  expect(view.queryByText(new RegExp(RESTING))).toBeNull();
});

test("each machine on the board says whether it is online (spec F4)", async () => {
  controlFetch("ok");
  const { view } = draw("/tasks");
  const chip = await view.findByRole("button", { name: /dev-laptop/ });
  // Said when it is there, not only when it is away.
  expect(chip.textContent).toBe("dev-laptop · 在线");
});
