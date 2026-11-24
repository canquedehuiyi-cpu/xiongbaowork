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
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { agentKeys } from "@/lib/agents/queries";
import {
  parseChannelSocketMessage,
  useChannelEvents,
} from "@/lib/channels/use-channel-events";
import { deploymentKeys } from "@/lib/deployment/queries";
import { Route as TasksRoute } from "@/routes/_authed/_app/tasks";
import { settleReactWork } from "./settle-react-work";

/**
 * 看板实时推送（试点，开关 XIONGBAO_PILOT_BOARD_PUSH）：开关开不开，看板轮询都是 5 秒；
 * 收到 STATE_DELTA 只当「有变化」的信号去重读，不用其中的卡片 id。
 * 轮询一栏读的是 react-query 拿到的配置值，不是真等 5 秒。
 */
let registeredHere = false;
const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;

beforeAll(() => {
  if (!("document" in globalThis)) {
    GlobalRegistrator.register({ url: "http://localhost/" });
    registeredHere = true;
  }
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWebSocket;
});
afterAll(async () => {
  if (!registeredHere) return;
  await settleReactWork();
  GlobalRegistrator.unregister();
});

test("STATE_DELTA 能被识别，缺 delta 或不是数组的丢掉", () => {
  const delta = [{ op: "replace", path: "/tasks/c1/status", value: "done" }];
  expect(
    parseChannelSocketMessage(JSON.stringify({ type: "STATE_DELTA", delta })),
  ).toEqual({ type: "STATE_DELTA", delta });
  expect(
    parseChannelSocketMessage(JSON.stringify({ type: "STATE_DELTA" })),
  ).toBeNull();
  expect(
    parseChannelSocketMessage(
      JSON.stringify({ type: "STATE_DELTA", delta: "x" }),
    ),
  ).toBeNull();
});

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

function serve(capabilities: object | null, requests: string[] = []) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    requests.push(path);
    const body = path.startsWith("/api/capabilities")
      ? (capabilities ?? { agents: [] })
      : path.startsWith("/api/tasks")
        ? { tasks: [] }
        : path.startsWith("/api/waker-groups")
          ? { groups: [] }
          : path.startsWith("/api/devices")
            ? { devices: [] }
            : { agents: [] };
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
      status: 200,
    });
  }) as typeof fetch;
}

function drawBoard() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(agentKeys.list(false), []);
  const router = createRouter({
    context: {},
    history: createMemoryHistory({ initialEntries: ["/tasks"] }),
    routeTree,
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return queryClient;
}

const intervalOf = (queryClient: QueryClient, key: string) => {
  const query = queryClient.getQueryCache().findAll({ queryKey: [key] })[0];
  const options = query?.options;
  if (!options || !("refetchInterval" in options)) return undefined;
  return options["refetchInterval"];
};

test("开关关：看板仍是 5 秒轮询，统计 30 秒", async () => {
  serve({ boardPush: false });
  const queryClient = drawBoard();
  await waitFor(() => expect(intervalOf(queryClient, "tasks")).toBe(5000));
  expect(intervalOf(queryClient, "tasks-summary")).toBe(30000);
});

test("开关开着：看板轮询也不放慢，仍是 5 秒（直接写 tasks 的地方不推送）", async () => {
  serve({ boardPush: true });
  const queryClient = drawBoard();
  await waitFor(() => expect(intervalOf(queryClient, "tasks")).toBe(5000));
  expect(intervalOf(queryClient, "tasks-summary")).toBe(30000);
});

class FakeSocket extends EventTarget {
  static all: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((message: { data: unknown }) => void) | null = null;
  constructor() {
    super();
    FakeSocket.all.push(this);
  }
  close() {
    this.onclose?.();
  }
}

function Listener() {
  useChannelEvents();
  return null;
}

/** 挂上频道事件 hook，预置一份看板与统计的缓存，返回假 socket 与「哪些读被标为过期」。 */
async function listen(capabilities?: object) {
  FakeSocket.all = [];
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  serve(capabilities ?? { agents: [] });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(["tasks", "week"], { tasks: [] });
  queryClient.setQueryData(["tasks-summary", "week"], { tasks: [] });
  if (capabilities)
    queryClient.setQueryData(deploymentKeys.capabilities(), capabilities);
  const router = createRouter({
    context: {},
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({ component: Listener }).addChildren([]),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(FakeSocket.all).toHaveLength(1));
  const socket = FakeSocket.all[0] as FakeSocket;
  await act(async () => socket.onopen?.());
  const stale = (key: string[]) =>
    queryClient.getQueryState(key)?.isInvalidated ?? false;
  const send = (message: unknown) =>
    act(async () => socket.onmessage?.({ data: JSON.stringify(message) }));
  return { stale, send };
}

const CARD_DELTA = {
  type: "STATE_DELTA",
  delta: [{ op: "replace", path: "/tasks/c1/status", value: "done" }],
};
const WHOLE_BOARD_DELTA = {
  type: "STATE_DELTA",
  delta: [{ op: "replace", path: "/tasks", value: null }],
};

test("推送带着具体的卡：只重读看板统计，列表留给 taskUpdated（一次变化不读两遍列表）", async () => {
  const { stale, send } = await listen();
  expect(stale(["tasks", "week"])).toBe(false);
  await send(CARD_DELTA);
  expect(stale(["tasks-summary", "week"])).toBe(true);
  expect(stale(["tasks", "week"])).toBe(false);
});

test("整板失效（不带具体卡）：列表和统计都重读", async () => {
  const { stale, send } = await listen();
  await send(WHOLE_BOARD_DELTA);
  expect(stale(["tasks", "week"])).toBe(true);
  expect(stale(["tasks-summary", "week"])).toBe(true);
});

test("开关关（服务器没说）：resync 只重读频道，看板与统计不动", async () => {
  const { stale, send } = await listen({ boardPush: undefined });
  await send({ resync: true });
  expect(stale(["tasks", "week"])).toBe(false);
  expect(stale(["tasks-summary", "week"])).toBe(false);
});

test("开关开：resync 把看板和统计也重读（断开期间丢掉的推送由此补上）", async () => {
  const { stale, send } = await listen({ boardPush: true });
  await send({ resync: true });
  expect(stale(["tasks", "week"])).toBe(true);
  expect(stale(["tasks-summary", "week"])).toBe(true);
});
