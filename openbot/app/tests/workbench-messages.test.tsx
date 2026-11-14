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
import type { ChannelSummary } from "@/lib/channels/queries";
import { queryClient } from "@/query-client";
import { MessageList } from "@/skins/xiongbao/message-list";
import { settleReactWork } from "./settle-react-work";

/*
 * 聊天工作台的「消息」列表：单聊和群聊合成一列，按最后消息时间倒序；筛选「全部 / 未读 / 待我确认 / 群聊」；
 * 右上「＋」收着「新对话」「新建群组」。API 是假的，按产品接口的形状回答；列表和路由是真的。
 */

const originalFetch = globalThis.fetch;
let answers: Map<string, unknown>;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
});
beforeEach(() => {
  answers = new Map();
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).split("?")[0] ?? "";
      const answer = answers.get(`${init?.method ?? "GET"} ${path}`);
      if (answer !== undefined) return Response.json(answer);
      return Response.json({ error: "not served" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
  answers.set("GET /api/agents", { agents: [] });
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
    summary: "登录改版",
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

/** 列表里每一行的名字，从上到下。 */
function rowNames(view: ReturnType<typeof render>): string[] {
  return list(view)
    .queryAllByRole("link")
    .map(
      (row) =>
        row.querySelector("[data-message-name]")?.textContent?.trim() ?? "",
    );
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
  test("单聊和群聊在同一列表里，按最后消息时间倒序", async () => {
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

  test("每行第二行是最后一条消息", async () => {
    serveChannels(MIXED);
    const { view } = renderList();
    expect(await (await listed(view)).findByText("测试跑完了")).toBeTruthy();
    expect(list(view).getByText("报销核对完了")).toBeTruthy();
  });

  test("群聊头像是最多 4 格的成员拼图", async () => {
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

  test("筛选标签：全部 / 未读 / 待我确认 / 群聊，默认全部", async () => {
    serveChannels(MIXED);
    const { view } = renderList();
    await (await listed(view)).findByText("产品研发群");
    const filters = within(view.getByRole("group", { name: "筛选" }));
    expect(
      filters.getAllByRole("button").map((button) => button.textContent),
    ).toEqual(["全部", "未读", "待我确认", "群聊"]);
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

  test("「待我确认」只留员工有待确认事项的一对一会话，群聊不出现", async () => {
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

  test("「群聊」只留群聊", async () => {
    serveChannels(MIXED);
    const { view, user } = renderList();
    await (await listed(view)).findByText("产品研发群");
    await user.click(view.getByRole("button", { name: "群聊" }));
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
    await user.click(view.getByRole("button", { name: "群聊" }));
    expect(await view.findByText("还没有群组")).toBeTruthy();
    await user.click(view.getByRole("button", { name: "未读" }));
    expect(await view.findByText("没有未读的消息")).toBeTruthy();
    await user.click(view.getByRole("button", { name: "待我确认" }));
    expect(await view.findByText("没有等你确认的事")).toBeTruthy();
  });
});
