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
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import { channelKeys } from "@/lib/channels/queries";
import { deliveryKey, type Reachability } from "@/lib/delivery";
import { modelKeys } from "@/lib/models/queries";
import { Route as ReachabilityRoute } from "@/routes/_authed/_app/reachability";
import { settleReactWork } from "./settle-react-work";

/**
 * Parity plan, @Waker row (`/at-waker` → our `/reachability`).
 *
 * Seeded reads, because the page's job here is layout and state: the hero with its four entries and
 * the drawn scene, the 已接入聊天 table/cards over the real delivery bindings, its search and three
 * filters mirrored into the URL, the empty state's way in, and an entry with no backend contract
 * saying so rather than pretending.
 */
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
const drawnClients: QueryClient[] = [];
afterEach(async () => {
  cleanup();
  try {
    await Promise.all(drawnClients.map((client) => client.cancelQueries()));
  } finally {
    for (const client of drawnClients) client.clear();
    drawnClients.length = 0;
    globalThis.fetch = originalFetch;
    try {
      sessionStorage.clear();
    } catch {
      /* nothing kept */
    }
  }
});

function agent(over: Partial<AgentProfile>): AgentProfile {
  return {
    id: "agent",
    name: "Agent",
    title: "",
    roleDescription: "",
    avatarSeed: "seed",
    visibility: "private",
    endpoint: null,
    builtIn: true,
    hasAuth: false,
    modelRef: null,
    persona: null,
    hasCallbackToken: false,
    hidden: false,
    pinned: false,
    systemOwned: false,
    canManage: true,
    mine: true,
    ...over,
  } as AgentProfile;
}

const AGENTS = [
  agent({ id: "a1", name: "客服小熊", modelRef: "m1" }),
  agent({ id: "a2", name: "周报助手", modelRef: null }),
];

const CHANNELS = [
  {
    id: "c1",
    name: "客服小熊",
    agentIds: ["a1"],
    threadId: "t1",
    active: true,
    lastMessageAt: null,
    summary: "退货咨询",
    lastMessage: null,
    lastMessageAgentId: null,
    createdAt: "2026-11-01T00:00:00.000Z",
    pinned: false,
    lastReadAt: null,
  },
  {
    id: "c2",
    name: "周报助手",
    agentIds: ["a2"],
    threadId: "t2",
    active: true,
    lastMessageAt: null,
    summary: "本周周报",
    lastMessage: null,
    lastMessageAgentId: null,
    createdAt: "2026-11-02T00:00:00.000Z",
    pinned: false,
    lastReadAt: null,
  },
];

const LIBRARY = {
  models: [
    {
      id: "m1",
      provider: "openai",
      baseUrl: null,
      modelName: "gpt-x",
      label: null,
      enabled: true,
      updatedAt: "2026-11-01T00:00:00.000Z",
      coworkers: 1,
    },
  ],
  templates: [],
  pool: [],
  customModels: true,
};

const REACH: Reachability = {
  bindings: [
    {
      id: "b1",
      transport: "slack",
      channelId: "c1",
      agentId: "a1",
      address: "U01",
      enabled: true,
    },
    {
      id: "b2",
      transport: "sms",
      channelId: "c2",
      agentId: "a2",
      address: "+15551234567",
      enabled: true,
      optedOutAt: null,
    },
    {
      id: "b3",
      transport: "teams",
      channelId: "c2",
      agentId: "a2",
      address: "29:abc",
      enabled: true,
    },
    // Disconnected: the server keeps the row with `enabled: false`; it is not a connected chat.
    {
      id: "b4",
      transport: "slack",
      channelId: "c2",
      agentId: "a2",
      address: "U02",
      enabled: false,
    },
  ],
  devices: [],
  deliveries: [
    {
      id: "d1",
      transport: "teams",
      kind: "reply",
      state: "failed",
      error: "令牌过期",
      createdAt: "2026-11-06T10:00:00.000Z",
      bindingId: "b3",
    },
    {
      id: "d2",
      transport: "slack",
      kind: "question",
      state: "delivered",
      error: null,
      createdAt: "2026-11-06T09:00:00.000Z",
      bindingId: "b1",
    },
  ],
  available: { slack: true, teams: true, sms: true, push: false },
};

function draw(path = "/reachability", reach: Reachability = REACH) {
  globalThis.fetch = (async () =>
    Response.json({}, { status: 500 })) as unknown as typeof fetch;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  drawnClients.push(queryClient);
  queryClient.setQueryData(deliveryKey, reach);
  queryClient.setQueryData(agentKeys.list(false), AGENTS);
  queryClient.setQueryData(modelKeys.library(), LIBRARY);
  queryClient.setQueryData(channelKeys.list(), {
    pages: [{ channels: CHANNELS, nextCursor: null }],
    pageParams: [""],
  });
  const root = createRootRoute({ component: () => <Outlet /> });
  const router = createRouter({
    context: {},
    history: createMemoryHistory({ initialEntries: [path] }),
    routeTree: root.addChildren([
      ReachabilityRoute.update({
        getParentRoute: () => root,
        path: "/reachability",
      } as never),
      createRoute({
        getParentRoute: () => root,
        path: "/channel/$channelId",
        component: () => null,
      } as never),
      createRoute({
        getParentRoute: () => root,
        path: "/settings/connected-accounts",
        component: () => null,
      } as never),
    ]),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return Object.assign(view, { router });
}

const search = (router: { state: { location: { search: unknown } } }) =>
  router.state.location.search as Record<string, unknown>;

/** The data rows of the table view, header excluded. */
function tableRows(view: ReturnType<typeof draw>) {
  const table = view.getByRole("table", { name: "已接入聊天" });
  return within(table).getAllByRole("row").slice(1);
}

test("the hero carries the @Waker title, four entries and a drawn scene", async () => {
  const view = draw();
  expect(
    await view.findByRole("heading", { level: 1, name: "@Waker" }),
  ).toBeTruthy();
  for (const name of ["接入 IM 聊天", "机器人与账号", "自动接入", "接入申请"]) {
    expect(view.getByRole("button", { name: new RegExp(name) })).toBeTruthy();
  }
  const scene = view.getByRole("img", { name: /IM/ });
  expect(scene.tagName.toLowerCase()).toBe("svg");
});

test("接入 IM 聊天 opens the existing link flow with every field it had", async () => {
  const view = draw();
  await userEvent.click(
    await view.findByRole("button", { name: /接入 IM 聊天/ }),
  );
  const dialog = await view.findByRole("dialog");
  const inDialog = within(dialog);
  expect(inDialog.getByRole("combobox", { name: "会话" })).toBeTruthy();
  expect(inDialog.getByRole("combobox", { name: "员工" })).toBeTruthy();
  const phone = inDialog.getByLabelText("手机号") as HTMLInputElement;
  expect(phone.getAttribute("pattern")).toBe("\\+[1-9][0-9]{7,14}");
  expect(inDialog.getByRole("button", { name: "关联 Slack" })).toBeTruthy();
  expect(
    inDialog.getByRole("button", { name: "关联 Microsoft Teams" }),
  ).toBeTruthy();
  // Nothing chosen yet, so nothing can be sent.
  expect(
    (inDialog.getByRole("button", { name: "发送验证码" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  // Picking a conversation offers only its own coworkers.
  fireEvent.change(inDialog.getByRole("combobox", { name: "会话" }), {
    target: { value: "c1" },
  });
  const employees = inDialog.getByRole("combobox", { name: "员工" });
  expect(
    within(employees).getByRole("option", { name: "客服小熊" }),
  ).toBeTruthy();
  expect(
    within(employees).queryByRole("option", { name: "周报助手" }),
  ).toBeNull();
});

test("a phone waiting for its code keeps the code box across a reload", async () => {
  sessionStorage.setItem("openbot.reachability.pendingSms", "challenge-1");
  const view = draw();
  // The entry says so, because the dialog is closed when the person comes back.
  expect(
    await view.findByRole("button", { name: /接入 IM 聊天.*待输入验证码/ }),
  ).toBeTruthy();
  await userEvent.click(view.getByRole("button", { name: /接入 IM 聊天/ }));
  const dialog = await view.findByRole("dialog");
  const code = within(dialog).getByLabelText("验证码");
  expect(code.getAttribute("autocomplete")).toBe("one-time-code");
  expect(
    within(dialog).getByRole("button", { name: "确认手机号" }),
  ).toBeTruthy();
});

test("the connected chats switch between table and cards through the URL", async () => {
  const view = draw();
  await view.findByRole("table", { name: "已接入聊天" });
  // Disconnected bindings are not connected chats.
  expect(tableRows(view)).toHaveLength(3);
  await userEvent.click(view.getByRole("tab", { name: "卡片" }));
  await waitFor(() => expect(search(view.router).view).toBe("cards"));
  const list = view.getByRole("list", { name: "已接入聊天" });
  expect(within(list).getAllByRole("listitem")).toHaveLength(3);
  expect(view.queryByRole("table", { name: "已接入聊天" })).toBeNull();
  cleanup();

  const deep = draw("/reachability?view=cards");
  expect(await deep.findByRole("list", { name: "已接入聊天" })).toBeTruthy();
  expect(
    deep.getByRole("tab", { name: "卡片" }).getAttribute("aria-selected"),
  ).toBe("true");
});

test("search and the three filters narrow the rows and land in the URL", async () => {
  const view = draw();
  await view.findByRole("table", { name: "已接入聊天" });

  await userEvent.type(
    view.getByRole("searchbox", { name: "搜索已接入聊天" }),
    "退货",
  );
  await waitFor(() => expect(search(view.router).q).toBe("退货"));
  expect(tableRows(view)).toHaveLength(1);
  expect(
    within(tableRows(view)[0] as HTMLElement).getByText("Slack"),
  ).toBeTruthy();
  fireEvent.change(view.getByRole("searchbox", { name: "搜索已接入聊天" }), {
    target: { value: "" },
  });
  await waitFor(() => expect(search(view.router).q).toBeUndefined());

  fireEvent.change(view.getByRole("combobox", { name: "聊天类型" }), {
    target: { value: "sms" },
  });
  await waitFor(() => expect(search(view.router).type).toBe("sms"));
  expect(tableRows(view)).toHaveLength(1);
  expect(
    within(tableRows(view)[0] as HTMLElement).getByText(/\+15551234567/),
  ).toBeTruthy();
  fireEvent.change(view.getByRole("combobox", { name: "聊天类型" }), {
    target: { value: "" },
  });

  fireEvent.change(view.getByRole("combobox", { name: "模型" }), {
    target: { value: "lib:m1" },
  });
  await waitFor(() => expect(search(view.router).model).toBe("lib:m1"));
  expect(tableRows(view)).toHaveLength(1);
  expect(
    within(tableRows(view)[0] as HTMLElement).getByText("gpt-x · OpenAI"),
  ).toBeTruthy();
  fireEvent.change(view.getByRole("combobox", { name: "模型" }), {
    target: { value: "" },
  });

  fireEvent.change(view.getByRole("combobox", { name: "状态" }), {
    target: { value: "failed" },
  });
  await waitFor(() => expect(search(view.router).status).toBe("failed"));
  expect(tableRows(view)).toHaveLength(1);
  expect(
    within(tableRows(view)[0] as HTMLElement).getByText("Microsoft Teams"),
  ).toBeTruthy();

  // A filter that matches nothing says so and offers the way back.
  await userEvent.type(
    view.getByRole("searchbox", { name: "搜索已接入聊天" }),
    "不存在",
  );
  expect(await view.findByText("没有符合条件的聊天")).toBeTruthy();
  await userEvent.click(view.getByRole("button", { name: "清除筛选" }));
  await waitFor(() => expect(tableRows(view)).toHaveLength(3));
  expect(search(view.router).status).toBeUndefined();
});

test("a deep link restores search and filters", async () => {
  const view = draw("/reachability?type=teams&status=failed");
  await view.findByRole("table", { name: "已接入聊天" });
  expect(tableRows(view)).toHaveLength(1);
  expect(
    (view.getByRole("combobox", { name: "聊天类型" }) as HTMLSelectElement)
      .value,
  ).toBe("teams");
});

test("with nothing connected the empty state leads into 接入 IM 聊天", async () => {
  const view = draw("/reachability", {
    ...REACH,
    bindings: [],
    devices: [],
    deliveries: [],
  });
  expect(await view.findByText("还没有接入任何聊天")).toBeTruthy();
  const cta = view.getAllByRole("button", { name: /接入 IM 聊天/ });
  // The hero tile and the empty state's own button.
  expect(cta.length).toBe(2);
  await userEvent.click(cta[1] as HTMLElement);
  const dialog = await view.findByRole("dialog");
  expect(within(dialog).getByLabelText("手机号")).toBeTruthy();
});

test("an entry without a backend contract explains itself and stays disabled", async () => {
  const view = draw();
  await userEvent.click(await view.findByRole("button", { name: /自动接入/ }));
  const dialog = await view.findByRole("dialog");
  expect(within(dialog).getByText(/暂不可用/)).toBeTruthy();
  const action = within(dialog).getByRole("button", { name: "开启自动接入" });
  expect((action as HTMLButtonElement).disabled).toBe(true);
});

test("recent deliveries stay on the page, failures with their reason", async () => {
  const view = draw();
  const section = await view.findByRole("region", { name: "最近送达" });
  expect(within(section).getByText("令牌过期")).toBeTruthy();
  expect(
    within(section).getAllByText(/送达失败|已送达/).length,
  ).toBeGreaterThan(0);
});

test("a row's actions open its conversation and disconnect through the existing endpoint", async () => {
  const view = draw("/reachability?type=slack");
  await view.findByRole("table", { name: "已接入聊天" });
  const calls: { method: string; path: string }[] = [];
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    calls.push({ method: init?.method ?? "GET", path: String(input) });
    return (init?.method ?? "GET") === "GET"
      ? Response.json(REACH)
      : new Response(null, { status: 204 });
  }) as typeof fetch;
  const row = tableRows(view)[0] as HTMLElement;
  expect(
    within(row).getByRole("link", { name: "打开对话" }).getAttribute("href"),
  ).toBe("/channel/c1");
  await userEvent.click(within(row).getByRole("button", { name: "断开连接" }));
  await waitFor(() =>
    expect(calls.some((call) => call.method === "DELETE")).toBe(true),
  );
  expect(calls.find((call) => call.method === "DELETE")?.path).toBe(
    "/api/delivery/bindings/b1",
  );
});

test("a failed background refresh keeps the last connected chats on screen", async () => {
  const view = draw();
  await view.findByRole("table", { name: "已接入聊天" });
  globalThis.fetch = (async () =>
    Response.json(
      { error: "服务暂时不可用" },
      { status: 503 },
    )) as unknown as typeof fetch;
  await drawnClients[0]?.refetchQueries({ queryKey: ["delivery"] });
  expect(await view.findByText(/刷新失败，下面是上次读取的结果/)).toBeTruthy();
  expect(tableRows(view)).toHaveLength(3);
});
