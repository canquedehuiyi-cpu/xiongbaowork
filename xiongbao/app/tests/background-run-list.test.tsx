import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  setSystemTime,
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
import { authKeys } from "@/lib/auth/queries";
import type { ChannelSummary, ChannelWork } from "@/lib/channels/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { queryClient } from "@/query-client";
import { MessageList } from "@/skins/xiongbao/message-list";
import { settleReactWork } from "./settle-react-work";

/**
 * 侧栏里这段对话的第二行：一轮在服务器上跑着时写「后台进行中 · 已跑 X 分钟」（期九·四），盖过最后一条消息。
 * 起点是服务器说的，所以关掉页面再打开、换台设备都一样；部署没开这项时和以前完全一样。
 */

const MINUTE = 60_000;
const NOW = new Date("2026-11-19T10:00:00.000Z").getTime();
const originalFetch = globalThis.fetch;
let answers: Map<string, unknown>;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
});
beforeEach(() => {
  setSystemTime(new Date(NOW));
  answers = new Map();
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).split("?")[0] ?? "";
      const answer = answers.get(`${init?.method ?? "GET"} ${path}`);
      return answer !== undefined
        ? Response.json(answer)
        : Response.json({ error: "not served" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
  answers.set("GET /api/agents", {
    agents: [
      { id: "a1", name: "研究员" },
      { id: "a2", name: "小熊会计" },
    ],
  });
  answers.set("GET /api/waker-groups", { groups: [] });
  answers.set("GET /api/approvals", {
    enabled: true,
    requests: [],
    rules: [],
    teamRules: [],
    questions: [],
  });
  queryClient.setQueryData(authKeys.currentUser(), {
    id: "alice",
    name: "Alice Park",
    email: "alice@example.com",
    role: "user",
    onboarding: null,
  });
  answers.set("GET /api/settings/preferences", {
    preferences: {
      messageListEmphasis: "thread",
      selfHostBannerDismissed: true,
      narration: null,
      skin: null,
      proactive: "on",
    },
  });
});
afterEach(() => {
  cleanup();
  setSystemTime();
  queryClient.clear();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function capability(on: boolean) {
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: false,
    selfHostBanner: false,
    localEvaluation: false,
    edition: "team",
    chatServerComputerTools: on,
  });
}

const turn = (minutesAgo: number): ChannelWork => ({
  kind: "turn",
  key: "run-1",
  botId: "a1",
  botName: "研究员",
  since: new Date(NOW - minutesAgo * MINUTE).toISOString(),
});

function channel(overrides: Partial<ChannelSummary>): ChannelSummary {
  return {
    id: "c1",
    name: "研究员",
    agentIds: ["a1"],
    threadId: "t1",
    active: true,
    lastMessageAt: "2026-11-19T09:00:00.000Z",
    summary: "写竞品对比报告",
    lastMessage: "好的，我开始整理资料",
    lastMessageAgentId: "a1",
    createdAt: "2026-11-18T08:00:00.000Z",
    pinned: false,
    lastReadAt: "2026-11-19T09:30:00.000Z",
    ...overrides,
  };
}

async function drawn(channels: ChannelSummary[]) {
  answers.set("GET /api/channels", { channels, nextCursor: null });
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
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  const list = within(await view.findByRole("navigation", { name: "会话" }));
  await waitFor(() =>
    expect(list.queryAllByRole("link").length).toBeGreaterThan(0),
  );
  return { view, list };
}

const second = (row: HTMLElement) =>
  row.querySelector("[data-message-second]")?.textContent?.trim();

test("a conversation with a turn running on the server says so on its second line, from the time it began", async () => {
  capability(true);
  const { list } = await drawn([
    channel({ work: [turn(12)] }),
    channel({
      id: "c2",
      name: "小熊会计",
      agentIds: ["a2"],
      threadId: "t2",
      summary: "报销核对",
      lastMessage: "核对完了",
      lastMessageAgentId: "a2",
    }),
  ]);
  const [running, idle] = list.getAllByRole("link");
  expect(second(running as HTMLElement)).toBe("后台进行中 · 已跑 12 分钟");
  expect(
    (running as HTMLElement).querySelector("[data-background-run]"),
  ).not.toBeNull();
  // The one with nothing running reads as it always did.
  expect(second(idle as HTMLElement)).toContain("核对完了");
  expect(
    (idle as HTMLElement).querySelector("[data-background-run]"),
  ).toBeNull();
});

test("where the deployment does not run chat turns on the server the row is as it always was", async () => {
  capability(false);
  const { list } = await drawn([channel({ work: [turn(12)] })]);
  const [row] = list.getAllByRole("link");
  expect(second(row as HTMLElement)).toContain("好的，我开始整理资料");
  expect(
    (row as HTMLElement).querySelector("[data-background-run]"),
  ).toBeNull();
});

test("a conversation waiting on another Bot is not a running turn", async () => {
  capability(true);
  const { list } = await drawn([
    channel({
      work: [
        {
          kind: "handoff",
          key: "hop-1",
          botId: "a2",
          botName: "小熊会计",
          since: new Date(NOW - 3 * MINUTE).toISOString(),
        },
      ],
    }),
  ]);
  const [row] = list.getAllByRole("link");
  expect(second(row as HTMLElement)).toContain("好的，我开始整理资料");
});
