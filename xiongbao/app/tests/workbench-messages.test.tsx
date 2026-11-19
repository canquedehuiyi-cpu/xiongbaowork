import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
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
import type { ApprovalInboxData } from "@/lib/approvals";
import { authKeys } from "@/lib/auth/queries";
import type { ChannelSummary } from "@/lib/channels/queries";
import { queryClient } from "@/query-client";
import { MessageList } from "@/skins/xiongbao/message-list";
import { settleReactWork } from "./settle-react-work";

/*
 * 聊天工作台的「消息」列表：单聊和群组合成一列，按最后消息时间倒序；筛选「全部 / 未读 / 待我确认 / 群组」；
 * 右上「＋」收着「新对话」「新建群组」；每行的两行字跟着「消息列表突出显示」设置。API 是假的，按产品接口的
 * 形状回答；列表和路由是真的。
 */

const originalFetch = globalThis.fetch;
let answers: Map<string, unknown>;
/** 这些请求回 500。 */
let failing: Set<string>;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
});
beforeEach(() => {
  answers = new Map();
  failing = new Set();
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).split("?")[0] ?? "";
      const key = `${init?.method ?? "GET"} ${path}`;
      if (failing.has(key)) {
        return Response.json({ error: "服务器出错了" }, { status: 500 });
      }
      const answer = answers.get(key);
      if (answer !== undefined) return Response.json(answer);
      return Response.json({ error: "not served" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
  answers.set("GET /api/agents", {
    agents: [
      { id: "a1", name: "代码熊" },
      { id: "a2", name: "小熊会计" },
      { id: "a3", name: "暖心医生" },
      { id: "a4", name: "熊大厨" },
      { id: "a5", name: "熊宝小管家" },
    ],
  });
  answers.set("GET /api/waker-groups", { groups: [] });
  answers.set("GET /api/approvals", inbox({}));
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function channel(overrides: Partial<ChannelSummary>): ChannelSummary {
  return {
    id: "c1",
    name: "代码熊",
    agentIds: ["a1"],
    threadId: "t1",
    active: true,
    lastMessageAt: "2026-11-14T08:00:00.000Z",
    // 还没起标题：第一行是名字。
    summary: null,
    lastMessage: "改好了",
    lastMessageAgentId: "a1",
    createdAt: "2026-11-13T08:00:00.000Z",
    pinned: false,
    // 读过了。
    lastReadAt: "2026-11-14T09:00:00.000Z",
    ...overrides,
  };
}

function inbox(overrides: Partial<ApprovalInboxData>): ApprovalInboxData {
  return {
    enabled: true,
    requests: [],
    rules: [],
    teamRules: [],
    questions: [],
    ...overrides,
  };
}

function request(
  id: string,
  botId: string,
  status: string,
): ApprovalInboxData["requests"][number] {
  return {
    id,
    status,
    createdAt: "2026-11-14T08:00:00.000Z",
    action: {
      botId,
      toolRef: "shell.run",
      effect: "write",
      scope: "once",
      threadId: "t1",
      args: {},
      target: null,
    },
  };
}

function serveChannels(channels: ChannelSummary[]) {
  answers.set("GET /api/channels", { channels, nextCursor: null });
}

function renderList(path = "/") {
  const root = createRootRoute({
    component: () => (
      <>
        <MessageList />
        <Outlet />
      </>
    ),
  });
  const page = (at: string) =>
    createRoute({
      path: at,
      getParentRoute: () => root,
      component: () => null,
    });
  const router = createRouter({
    routeTree: root.addChildren([
      page("/"),
      page("/channel/new"),
      page("/channel/$channelId"),
      page("/group/new"),
      page("/group/$channelId"),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, router, user: userEvent.setup({ document }) };
}

function list(view: ReturnType<typeof render>) {
  return within(view.getByRole("navigation", { name: "会话" }));
}

/** 路由画完、列表出来以后的 `list`。 */
async function listed(view: ReturnType<typeof render>) {
  return within(await view.findByRole("navigation", { name: "会话" }));
}

/** 列表里每一行的第一行字（没起标题的会话就是名字），从上到下。 */
function rowNames(view: ReturnType<typeof render>): string[] {
  return lines(view).map(([first]) => first);
}

/** 每一行的两行字，从上到下。 */
function lines(view: ReturnType<typeof render>): [string, string][] {
  return list(view)
    .queryAllByRole("link")
    .map((row) => [
      row.querySelector("[data-message-first]")?.textContent?.trim() ?? "",
      row.querySelector("[data-message-second]")?.textContent?.trim() ?? "",
    ]);
}

function signIn(emphasis: "agent" | "thread") {
  queryClient.setQueryData(authKeys.currentUser(), {
    id: "alice",
    name: "Alice Park",
    email: "alice@example.com",
    role: "user",
    onboarding: null,
  });
  answers.set("GET /api/settings/preferences", {
    preferences: {
      messageListEmphasis: emphasis,
      selfHostBannerDismissed: true,
      narration: null,
      skin: null,
      proactive: "on",
    },
  });
}

const MIXED = [
  channel({
    id: "old",
    name: "小熊会计",
    agentIds: ["a2"],
    lastMessageAt: "2026-11-14T06:00:00.000Z",
    lastMessage: "报销核对完了",
    lastMessageAgentId: "a2",
  }),
  channel({
    id: "g1",
    name: "产品研发群",
    agentIds: ["a1", "a2", "a3", "a4", "a5"],
    lastMessageAt: "2026-11-14T07:00:00.000Z",
    lastMessage: "评审意见已汇总",
    // 没读过，有员工说了话：未读。
    lastReadAt: null,
  }),
  channel({
    id: "fresh",
    name: "代码熊",
    agentIds: ["a1"],
    lastMessageAt: "2026-11-14T08:00:00.000Z",
    lastMessage: "测试跑完了",
    lastReadAt: "2026-11-14T07:30:00.000Z",
  }),
];

describe("MessageList", () => {
  test("单聊和群组在同一列表里，按最后消息时间倒序", async () => {
    serveChannels(MIXED);
    const { view } = renderList();
    await (await listed(view)).findByText("产品研发群");
    expect(rowNames(view)).toEqual(["代码熊", "产品研发群", "小熊会计"]);
    const group = (await (await listed(view)).findByText("产品研发群")).closest(
      "a",
    );
    expect(group?.getAttribute("href")).toBe("/group/g1");
    const direct = list(view).getByText("代码熊").closest("a");
    expect(direct?.getAttribute("href")).toBe("/channel/fresh");
  });

  test("每行第二行是最后一条消息，群组里写是谁说的", async () => {
    serveChannels(MIXED);
    const { view } = renderList();
    await (await listed(view)).findByText("测试跑完了");
    await waitFor(() =>
      expect(lines(view)).toEqual([
        ["代码熊", "测试跑完了"],
        ["产品研发群", "代码熊：评审意见已汇总"],
        ["小熊会计", "报销核对完了"],
      ]),
    );
  });

  test("群组头像是最多 4 格的成员拼图", async () => {
    serveChannels(MIXED);
    const { view } = renderList();
    const group = (await (await listed(view)).findByText("产品研发群")).closest(
      "a",
    );
    if (!group) throw new Error("no group row");
    const mosaic = within(group).getByTestId("group-mosaic");
    expect(mosaic.querySelectorAll("[data-mosaic-cell]").length).toBe(4);
    // 一对一会话不是拼图。
    const direct = list(view).getByText("代码熊").closest("a");
    if (!direct) throw new Error("no direct row");
    expect(within(direct).queryByTestId("group-mosaic")).toBeNull();
  });

  test("筛选标签：全部 / 未读 / 待我确认 / 群组，默认全部", async () => {
    serveChannels(MIXED);
    const { view } = renderList();
    await (await listed(view)).findByText("产品研发群");
    const filters = within(view.getByRole("group", { name: "筛选" }));
    expect(
      filters.getAllByRole("button").map((button) => button.textContent),
    ).toEqual(["全部", "未读", "待我确认", "群组"]);
    expect(
      filters
        .getByRole("button", { name: "全部" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  test("「未读」只留未读的会话", async () => {
    serveChannels(MIXED);
    const { view, user } = renderList();
    await (await listed(view)).findByText("产品研发群");
    await user.click(view.getByRole("button", { name: "未读" }));
    await waitFor(() =>
      expect(rowNames(view)).toEqual(["代码熊", "产品研发群"]),
    );
    expect(
      view.getByRole("button", { name: "未读" }).getAttribute("aria-pressed"),
    ).toBe("true");
  });

  test("「未读」不算打开着的那段", async () => {
    serveChannels(MIXED);
    const { view, user } = renderList("/channel/fresh");
    await (await listed(view)).findByText("产品研发群");
    await user.click(view.getByRole("button", { name: "未读" }));
    await waitFor(() => expect(rowNames(view)).toEqual(["产品研发群"]));
  });

  test("「待我确认」只留员工有待确认事项的一对一会话，群组不出现", async () => {
    serveChannels([
      ...MIXED,
      channel({
        id: "doc",
        name: "暖心医生",
        agentIds: ["a3"],
        lastMessageAt: "2026-11-14T05:00:00.000Z",
      }),
      channel({
        id: "chef",
        name: "熊大厨",
        agentIds: ["a4"],
        lastMessageAt: "2026-11-14T04:00:00.000Z",
      }),
    ]);
    answers.set(
      "GET /api/approvals",
      inbox({
        // a2 问了一个问题；a3 有一条在等的审批；a4 的审批已经批过了，不算。
        questions: [
          {
            id: "q1",
            botId: "a2",
            threadId: "t2",
            question: "发送频率设为 60 秒一次？",
            createdAt: "2026-11-14T08:00:00.000Z",
          },
        ],
        requests: [
          request("r1", "a3", "pending"),
          request("r2", "a4", "approved"),
        ],
      }),
    );
    const { view, user } = renderList();
    await (await listed(view)).findByText("产品研发群");
    await user.click(view.getByRole("button", { name: "待我确认" }));
    await waitFor(() =>
      expect(rowNames(view)).toEqual(["小熊会计", "暖心医生"]),
    );
  });

  test("等你确认的员工，一对一会话的预览前标「待你确认」", async () => {
    serveChannels(MIXED);
    answers.set(
      "GET /api/approvals",
      inbox({ requests: [request("r1", "a2", "pending")] }),
    );
    const { view } = renderList();
    const row = (await (await listed(view)).findByText("小熊会计")).closest(
      "a",
    );
    if (!row) throw new Error("no row");
    await waitFor(() =>
      expect(within(row).getByText("[待你确认]")).toBeTruthy(),
    );
    const group = list(view).getByText("产品研发群").closest("a");
    if (!group) throw new Error("no group row");
    expect(within(group).queryByText("[待你确认]")).toBeNull();
  });

  test("「群组」只留群组", async () => {
    serveChannels(MIXED);
    const { view, user } = renderList();
    await (await listed(view)).findByText("产品研发群");
    await user.click(view.getByRole("button", { name: "群组" }));
    await waitFor(() => expect(rowNames(view)).toEqual(["产品研发群"]));
  });

  test("未读的行有未读标记，读过的没有", async () => {
    serveChannels(MIXED);
    const { view } = renderList();
    const group = (await (await listed(view)).findByText("产品研发群")).closest(
      "a",
    );
    const read = list(view).getByText("小熊会计").closest("a");
    if (!group || !read) throw new Error("no rows");
    expect(within(group).getByText("未读")).toBeTruthy();
    expect(within(read).queryByText("未读")).toBeNull();
  });

  test("右上「＋」菜单有「新对话」和「新建群组」", async () => {
    serveChannels(MIXED);
    const { view, user } = renderList();
    await (await listed(view)).findByText("产品研发群");
    await user.click(view.getByRole("button", { name: "新对话 / 新建群组" }));
    const menu = within(document.body);
    expect(
      (await menu.findByRole("menuitem", { name: "新对话" })).getAttribute(
        "href",
      ),
    ).toBe("/channel/new");
    expect(
      menu.getByRole("menuitem", { name: "新建群组" }).getAttribute("href"),
    ).toBe("/group/new");
  });

  test("一段会话也没有时说怎么开始", async () => {
    serveChannels([]);
    const { view } = renderList();
    expect(await view.findByText("还没有会话")).toBeTruthy();
  });

  test("筛到没有时说清楚", async () => {
    serveChannels(MIXED.filter((row) => row.id === "old"));
    const { view, user } = renderList();
    await (await listed(view)).findByText("小熊会计");
    await user.click(view.getByRole("button", { name: "群组" }));
    expect(await view.findByText("还没有群组")).toBeTruthy();
    await user.click(view.getByRole("button", { name: "未读" }));
    expect(await view.findByText("没有未读的消息")).toBeTruthy();
    await user.click(view.getByRole("button", { name: "待我确认" }));
    expect(await view.findByText("没有等你确认的事")).toBeTruthy();
  });
  test("待确认事项读不出来时，「待我确认」不说「没有」，可以重试", async () => {
    serveChannels(MIXED);
    failing.add("GET /api/approvals");
    const { view, user } = renderList();
    await (await listed(view)).findByText("产品研发群");
    await user.click(view.getByRole("button", { name: "待我确认" }));
    expect(
      await view.findByText("待确认事项加载失败", undefined, { timeout: 5000 }),
    ).toBeTruthy();
    expect(view.queryByText("没有等你确认的事")).toBeNull();
    expect(rowNames(view)).toEqual([]);
    expect(view.queryByText("[待你确认]")).toBeNull();
    // 好了以后点「重试」，就照常筛。
    failing.clear();
    answers.set(
      "GET /api/approvals",
      inbox({ requests: [request("r1", "a2", "pending")] }),
    );
    await user.click(view.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(rowNames(view)).toEqual(["小熊会计"]));
    expect(view.queryByText("待确认事项加载失败")).toBeNull();
  });

  test("待确认事项还在加载时，「待我确认」不说「没有」", async () => {
    serveChannels(MIXED);
    // 收件箱一直不回。
    const slow = globalThis.fetch;
    globalThis.fetch = Object.assign(
      (input: RequestInfo | URL, init?: RequestInit) =>
        String(input).startsWith("/api/approvals")
          ? new Promise<Response>(() => {})
          : slow(input, init),
      { preconnect: originalFetch.preconnect },
    );
    const { view, user } = renderList();
    await (await listed(view)).findByText("产品研发群");
    await user.click(view.getByRole("button", { name: "待我确认" }));
    await waitFor(() => expect(rowNames(view)).toEqual([]));
    expect(view.queryByText("没有等你确认的事")).toBeNull();
    expect(view.queryByText("待确认事项加载失败")).toBeNull();
  });

  test("突出对话标题（默认）：第一行是会话标题，第二行「谁：最后一条消息」", async () => {
    serveChannels([
      // 改过名的会话。
      channel({
        id: "renamed",
        name: "代码熊",
        summary: "短信验证码登录",
        lastMessage: "测试跑完了",
        lastMessageAt: "2026-11-14T08:00:00.000Z",
      }),
      // 最后一句是自己说的。
      channel({
        id: "mine",
        name: "小熊会计",
        agentIds: ["a2"],
        summary: "本月报销",
        lastMessage: "附上明细",
        lastMessageAgentId: null,
        lastMessageAt: "2026-11-14T07:00:00.000Z",
      }),
      channel({
        id: "g1",
        name: "产品研发群",
        agentIds: ["a1", "a2"],
        summary: "评审会",
        lastMessage: "评审意见已汇总",
        lastMessageAgentId: "a2",
        lastMessageAt: "2026-11-14T06:00:00.000Z",
      }),
      // 还没有标题：第一行用名字。
      channel({
        id: "plain",
        name: "暖心医生",
        agentIds: ["a3"],
        lastMessage: "早点休息",
        lastMessageAgentId: "a3",
        lastMessageAt: "2026-11-14T05:00:00.000Z",
      }),
    ]);
    signIn("thread");
    const { view } = renderList();
    await (await listed(view)).findByText("短信验证码登录");
    await waitFor(() =>
      expect(lines(view)).toEqual([
        ["短信验证码登录", "代码熊：测试跑完了"],
        ["本月报销", "我：附上明细"],
        ["评审会", "小熊会计：评审意见已汇总"],
        ["暖心医生", "早点休息"],
      ]),
    );
  });

  test("突出员工名字：第一行是员工或群组的名字，第二行最后一条消息", async () => {
    serveChannels([
      channel({
        id: "renamed",
        name: "代码熊",
        summary: "短信验证码登录",
        lastMessage: "测试跑完了",
        lastMessageAt: "2026-11-14T08:00:00.000Z",
      }),
      channel({
        id: "g1",
        name: "产品研发群",
        agentIds: ["a1", "a2"],
        summary: "评审会",
        lastMessage: "评审意见已汇总",
        lastMessageAgentId: "a2",
        lastMessageAt: "2026-11-14T06:00:00.000Z",
      }),
    ]);
    signIn("agent");
    const { view } = renderList();
    await (await listed(view)).findByText("产品研发群");
    await waitFor(() =>
      expect(lines(view)).toEqual([
        ["代码熊", "测试跑完了"],
        ["产品研发群", "小熊会计：评审意见已汇总"],
      ]),
    );
  });

  test("员工在干活时，单聊和群组的头像都有正在处理的小标", async () => {
    serveChannels([
      channel({ id: "busy", name: "代码熊", busy: true }),
      channel({
        id: "g1",
        name: "产品研发群",
        agentIds: ["a1", "a2"],
        busy: true,
        lastMessageAt: "2026-11-14T07:00:00.000Z",
      }),
      channel({
        id: "idle",
        name: "小熊会计",
        agentIds: ["a2"],
        lastMessageAt: "2026-11-14T06:00:00.000Z",
      }),
    ]);
    const { view } = renderList();
    const row = async (name: string) => {
      const found = (await (await listed(view)).findByText(name)).closest("a");
      if (!found) throw new Error(`no row for ${name}`);
      return within(found);
    };
    expect((await row("代码熊")).getByText("处理中…")).toBeTruthy();
    expect((await row("产品研发群")).getByText("处理中…")).toBeTruthy();
    expect((await row("小熊会计")).queryByText("处理中…")).toBeNull();
  });
});
