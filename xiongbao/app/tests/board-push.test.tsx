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
import {
  boardPollMs,
  isBoardPushConnected,
  setBoardPushConnected,
} from "@/lib/tasks/board-push";
import { Route as TasksRoute } from "@/routes/_authed/_app/tasks";
import { settleReactWork } from "./settle-react-work";

/**
 * 看板实时推送（试点，开关 XIONGBAO_PILOT_BOARD_PUSH）：开关关时看板与原来一模一样（5 秒轮询），
 * 开着且推送连着时放慢轮询，推送一断就回到 5 秒；收到 STATE_DELTA 就重读看板。
 * 轮询一栏读的是 react-query 拿到的配置值，不是真等 5 秒或 30 秒。
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
  setBoardPushConnected(false);
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWebSocket;
});
afterAll(async () => {
  if (!registeredHere) return;
  await settleReactWork();
  GlobalRegistrator.unregister();
});

test("boardPollMs：开关关时无论推送连没连都是 5 秒；开着且连着才放慢", () => {
  expect(boardPollMs({ boardPush: false, connected: true })).toBe(5000);
  expect(boardPollMs({ boardPush: undefined, connected: true })).toBe(5000);
  expect(boardPollMs({ boardPush: true, connected: false })).toBe(5000);
  expect(boardPollMs({ boardPush: true, connected: true })).toBe(30000);
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

test("开关关：看板仍是 5 秒轮询，推送连着也不变（与 main 一致）", async () => {
  serve({ boardPush: false });
  setBoardPushConnected(true);
  const queryClient = drawBoard();
  await waitFor(() => expect(intervalOf(queryClient, "tasks")).toBe(5000));
  expect(intervalOf(queryClient, "tasks-summary")).toBe(30000);
});

test("服务器没说开关（老服务器）：看板仍是 5 秒轮询", async () => {
  serve(null);
  setBoardPushConnected(true);
  const queryClient = drawBoard();
  await waitFor(() => expect(intervalOf(queryClient, "tasks")).toBe(5000));
});

test("开关开且推送连着：放慢到 30 秒；推送断开，回落 5 秒", async () => {
  serve({ boardPush: true });
  setBoardPushConnected(true);
  const queryClient = drawBoard();
  await waitFor(() => expect(intervalOf(queryClient, "tasks")).toBe(30000));
  await act(async () => setBoardPushConnected(false));
  await waitFor(() => expect(intervalOf(queryClient, "tasks")).toBe(5000));
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

test("连接状态跟着频道推送的连接走；收到 STATE_DELTA 就重读看板和看板统计", async () => {
  FakeSocket.all = [];
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  serve({ boardPush: true });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(["tasks", "week"], { tasks: [] });
  queryClient.setQueryData(["tasks-summary", "week"], { tasks: [] });
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
  expect(isBoardPushConnected()).toBe(false);

  await act(async () => socket.onopen?.());
  expect(isBoardPushConnected()).toBe(true);
  const stale = (key: string[]) =>
    queryClient.getQueryState(key)?.isInvalidated ?? false;
  // 重连时会重读频道名单，看板不在其中。
  expect(stale(["tasks", "week"])).toBe(false);

  await act(async () =>
    socket.onmessage?.({
      data: JSON.stringify({
        type: "STATE_DELTA",
        delta: [{ op: "replace", path: "/tasks/c1/status", value: "done" }],
      }),
    }),
  );
  expect(stale(["tasks", "week"])).toBe(true);
  expect(stale(["tasks-summary", "week"])).toBe(true);

  await act(async () => socket.onclose?.());
  expect(isBoardPushConnected()).toBe(false);
});
