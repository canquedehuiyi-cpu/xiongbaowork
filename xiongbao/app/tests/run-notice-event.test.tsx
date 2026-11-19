import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  type InfiniteData,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { type ChannelPage, channelKeys } from "@/lib/channels/queries";
import { useChannelEvents } from "@/lib/channels/use-channel-events";
import { refreshNotificationPermission } from "@/lib/notifications/permission";
import { forgetReplies } from "@/lib/notifications/reply-notice";
import { settleReactWork } from "./settle-react-work";

/*
 * 员工一轮跑完、你不在这段对话的页面上：服务器在花名册 socket 上发一条只带通知的事件（空的 channelId）。
 * 页面不在视线内时弹系统通知，在视线内时不弹；不管弹不弹，这条事件都不能当成频道事件处理（不改花名册、
 * 不去重查名单、不碰任务看板）。
 */

class ServerSocket extends EventTarget implements WebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static opened: ServerSocket[] = [];
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  binaryType: BinaryType = "blob";
  bufferedAmount = 0;
  extensions = "";
  protocol = "";
  readyState = 1;
  onclose: WebSocket["onclose"] = null;
  onerror: WebSocket["onerror"] = null;
  onmessage: WebSocket["onmessage"] = null;
  onopen: WebSocket["onopen"] = null;
  readonly url: string;
  constructor(url: string | URL) {
    super();
    this.url = String(url);
    ServerSocket.opened.push(this);
  }
  close() {}
  send() {}
  say(event: unknown) {
    this.onmessage?.(
      new MessageEvent("message", { data: JSON.stringify(event) }),
    );
  }
}

type Shown = {
  title: string;
  options: NotificationOptions & { extra?: { path: string } };
  onclick: (() => void) | null;
};
const shown: Shown[] = [];
class BrowserNotification {
  static permission: NotificationPermission = "granted";
  static requestPermission = async () => BrowserNotification.permission;
  onclick: (() => void) | null = null;
  constructor(title: string, options: NotificationOptions = {}) {
    const record: Shown = { title, options, onclick: null };
    shown.push(record);
    Object.defineProperty(this, "onclick", {
      set: (handler) => {
        record.onclick = handler;
      },
      get: () => record.onclick,
    });
  }
  close() {}
}

type Globals = { Notification?: unknown; WebSocket: typeof WebSocket };
const globals = globalThis as unknown as Globals;
const originalNotification = globals.Notification;
let originalWebSocket: typeof WebSocket;
let originalFocus: typeof window.focus;
const originalFetch = globalThis.fetch;
const requested: string[] = [];
let visibility: DocumentVisibilityState = "hidden";
let focused = false;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://127.0.0.1:3010" });
  originalWebSocket = globals.WebSocket;
  globals.WebSocket = ServerSocket;
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
  document.hasFocus = () => focused;
  originalFocus = window.focus;
  window.focus = () => {};
});
beforeEach(() => {
  forgetReplies();
  requested.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requested.push(String(input));
    return Response.json({});
  }) as unknown as typeof fetch;
  shown.length = 0;
  ServerSocket.opened.length = 0;
  visibility = "hidden";
  focused = false;
  globals.Notification = BrowserNotification;
  BrowserNotification.permission = "granted";
  refreshNotificationPermission();
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  globals.Notification = originalNotification;
  refreshNotificationPermission();
});
afterAll(async () => {
  await settleReactWork();
  globals.WebSocket = originalWebSocket;
  window.focus = originalFocus;
  GlobalRegistrator.unregister();
});

const ROW = {
  id: "march-receipts",
  name: "三月的报销",
  agentIds: ["expenses"],
  threadId: "t1",
  active: true,
  lastMessage: "旧的一句",
  lastMessageAt: "2026-11-08T10:00:00.000Z",
  createdAt: "2026-11-08T09:00:00.000Z",
};

async function openPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const page = { channels: [ROW], nextCursor: null } as unknown as ChannelPage;
  const cache: InfiniteData<ChannelPage> = {
    pages: [page],
    pageParams: [null],
  };
  queryClient.setQueryData(channelKeys.list(), cache);
  function Page() {
    useChannelEvents();
    return null;
  }
  const router = createRouter({
    routeTree: createRootRoute({ component: Page }),
    history: createMemoryHistory({ initialEntries: ["/bots"] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(ServerSocket.opened).toHaveLength(1));
  return {
    socket: ServerSocket.opened[0] as ServerSocket,
    router,
    queryClient,
  };
}

/** 服务器的 `announceRunNotice`：空 channelId，只有收件人和这条通知。 */
const runNoticeEvent = {
  channelId: "",
  memberIds: ["user"],
  lastMessage: null,
  lastMessageAt: null,
  lastMessageAgentId: null,
  runNotice: {
    channelId: "march-receipts",
    title: "研究员",
    body: "竞品对比报告已写好，存在 report.md（用时 18 分钟）",
    tag: "xiongbao-march-receipts",
    path: "/channel/march-receipts",
  },
};

async function settle() {
  await act(settleReactWork);
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
}

test("页面不在视线内：弹一条系统通知，点一下打开那段对话", async () => {
  const { socket, router } = await openPage();

  act(() => socket.say(runNoticeEvent));

  await waitFor(() => expect(shown).toHaveLength(1));
  expect({ title: shown[0]?.title, ...shown[0]?.options }).toEqual({
    title: "研究员",
    body: "竞品对比报告已写好，存在 report.md（用时 18 分钟）",
    tag: "xiongbao-march-receipts",
    extra: { path: "/channel/march-receipts" },
  });
  act(() => shown[0]?.onclick?.());
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/channel/march-receipts"),
  );
});

test("页面在视线内：不弹", async () => {
  visibility = "visible";
  focused = true;
  const { socket } = await openPage();

  act(() => socket.say(runNoticeEvent));
  await settle();

  expect(shown).toEqual([]);
});

test("浏览器没授权通知：不弹", async () => {
  BrowserNotification.permission = "denied";
  refreshNotificationPermission();
  const { socket } = await openPage();

  act(() => socket.say(runNoticeEvent));
  await settle();

  expect(shown).toEqual([]);
});

test("不管弹不弹，它都不是频道事件：不改花名册、不重查名单、不动任务看板", async () => {
  const { socket, queryClient } = await openPage();
  // 页面打开时的那次重取已经发过；从这里数起。
  await settle();
  requested.length = 0;
  const before = JSON.stringify(queryClient.getQueryData(channelKeys.list()));
  const invalidated: unknown[] = [];
  const original = queryClient.invalidateQueries.bind(queryClient);
  queryClient.invalidateQueries = ((filters: unknown) => {
    invalidated.push(filters);
    return original(filters as never);
  }) as typeof queryClient.invalidateQueries;

  for (const seeing of [false, true]) {
    visibility = seeing ? "visible" : "hidden";
    focused = seeing;
    act(() => socket.say(runNoticeEvent));
    // 一条带 taskUpdated 的也一样：通知先于它，其余的都不看。
    act(() => socket.say({ ...runNoticeEvent, taskUpdated: true, busy: true }));
    await settle();
  }

  expect(invalidated).toEqual([]);
  expect(requested).toEqual([]);
  expect(JSON.stringify(queryClient.getQueryData(channelKeys.list()))).toBe(
    before,
  );
});
