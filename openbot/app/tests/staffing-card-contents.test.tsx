import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  mock,
  test,
} from "bun:test";
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
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { ServerToolLine } from "@/components/channels/chat-transcript";
import { ConversationProvider } from "@/lib/copilot/conversation";
import { writeStaffingProposalAnswer } from "../../shared/staffing-proposal";
import { settleReactWork } from "./settle-react-work";

/**
 * 卡片上看得到确认之后会做的每一件事：新员工公开给全团队要醒目，工作手册整段给出；改员工时新加的定时任务
 * 给出整段指令，应用给出动作；单独的工作指令只出现在个人起步员工身上。部分完成、失败的步骤重试不成的提议
 * 可以作废，作废之后仍看得到做成了什么。
 *
 * 和 `staffing-proposal-card.test.tsx` 一样在 `fetch` 上按路径作答，读 mock 的调用记录看卡片发了什么。
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;

type Answer = (init: RequestInit | undefined) => Response;

let answers: Record<string, Answer> = {};

const fetchMock = mock(
  async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const answer = answers[`${method} ${String(input)}`];
    return answer ? answer(init) : new Response(null, { status: 404 });
  },
);

beforeEach(() => {
  fetchMock.mockClear();
  answers = {};
  global.fetch = Object.assign(fetchMock, {
    preconnect: originalFetch.preconnect,
  }) as unknown as typeof fetch;
});
afterEach(() => {
  global.fetch = originalFetch;
});

function proposalCalls() {
  return fetchMock.mock.calls
    .map(([input, init]) => ({
      method: init?.method ?? "GET",
      path: String(input),
    }))
    .filter((call) => call.path.startsWith("/api/proposals/"));
}

const BIBLE = [
  "一、选题：每天早上先看热榜，挑三个和我们产品有关的题。",
  "二、写作：标题不超过二十字，正文分三段，最后一段放行动号召。",
  "三、发布前：把稿子发给主人过目，主人没回复就不要发。",
].join("\n");

const EMPLOYEE_DRAFT = {
  name: "小红",
  title: "小红书运营",
  roleDescription: "每天写两篇小红书笔记，先列选题再写正文。",
  bible: BIBLE,
  skills: [],
  apps: [],
  routines: [],
  visibility: "private",
  staffingTools: false,
};

function proposal(
  kind: string,
  draft: unknown,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: "p1",
    ownerId: "u1",
    proposedByAgentId: "butler",
    threadId: "t1",
    kind,
    draft,
    baseVersion: null,
    status: "pending",
    result: null,
    createdAt: "2026-11-11T08:00:00.000Z",
    updatedAt: "2026-11-11T08:00:00.000Z",
    expiresAt: "2026-11-18T08:00:00.000Z",
    ...overrides,
  };
}

function serving(kind: string, draft: unknown, overrides = {}) {
  answers["GET /api/proposals/p1"] = () =>
    Response.json({ proposal: proposal(kind, draft, overrides), canAct: true });
}

function answerFor(kind: string, title: string) {
  return writeStaffingProposalAnswer(
    { proposalId: "p1", kind: kind as "employee", title },
    "已起草，等用户确认。",
  );
}

function routed(node: ReactNode) {
  const rootRoute = createRootRoute({ component: Outlet });
  const leaf = (path: string) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path,
      component: () => null,
    });
  const routeTree = rootRoute.addChildren([
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => node,
    }),
    leaf("/bots/$agentId"),
    leaf("/group/$channelId"),
    leaf("/settings/plans"),
    leaf("/connections/$key"),
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ConversationProvider ask={() => {}}>
        <RouterProvider router={router as never} />
      </ConversationProvider>
    </QueryClientProvider>,
  );
}

const line = (kind: string, title: string) => (
  <ServerToolLine
    args="{}"
    name={`mcp__staffing__propose_${kind}`}
    result={answerFor(kind, title)}
  />
);

/** 改员工卡片读的「改前」：员工此刻的资料。`instructions` 只有个人起步员工有。 */
function agent(extra: Record<string, unknown> = {}) {
  answers["GET /api/agents/a1"] = () =>
    Response.json({
      agent: {
        id: "a1",
        name: "小红",
        title: "运营",
        roleDescription: "回答问题。",
        visibility: "private",
        persona: null,
        bible: null,
        modelRef: null,
        platformModelRef: null,
        ...extra,
      },
    });
}

test("a new employee's card shows its whole 工作手册 and that it stays private", async () => {
  serving("employee", EMPLOYEE_DRAFT);
  const view = routed(line("employee", "小红"));

  const manual = (await view.findByLabelText(
    "工作手册",
  )) as HTMLTextAreaElement;
  expect(manual.value).toBe(BIBLE);
  expect(view.getByText("只有你能用")).toBeTruthy();
  expect(view.queryByText("公开给全团队")).toBeNull();
});

test("a new employee going public says so in the signal colour", async () => {
  serving("employee", { ...EMPLOYEE_DRAFT, visibility: "public" });
  const view = routed(line("employee", "小红"));

  const shown = await view.findByText("公开给全团队");
  expect(shown.className).toContain("text-signal");
  expect(
    view.getByText("确认之后，团队里的每个人都能看到并使用它。"),
  ).toBeTruthy();
});

test("a new employee's card has no separate instructions field", async () => {
  serving("employee", { ...EMPLOYEE_DRAFT, instructions: "旧草稿里的指令。" });
  const view = routed(line("employee", "小红"));

  await view.findByLabelText("工作手册");
  expect(view.queryByLabelText("补充指令")).toBeNull();
  expect(view.queryByDisplayValue("旧草稿里的指令。")).toBeNull();
});

test("a change card shows each new routine's whole instruction and each app's actions", async () => {
  agent();
  const instruction =
    "每周一早上九点，把上周的笔记数据整理成表，标出点赞最多的三篇，并写一段下周的建议。";
  serving("employee_change", {
    agentId: "a1",
    set: {
      routines: [{ title: "周报", instruction, cron: "0 9 * * 1" }],
      apps: [
        { app: "notion", actions: ["search", "read_page"] },
        { app: "calendar", actions: [] },
      ],
    },
    appsRemove: [{ app: "mail", actions: ["send"] }],
    routinesRemove: [],
  });
  const view = routed(line("employee_change", "调整「小红」"));

  expect(await view.findByText(instruction)).toBeTruthy();
  expect(view.getByText("周报（0 9 * * 1）")).toBeTruthy();
  expect(view.getByText("notion：search、read_page")).toBeTruthy();
  expect(view.getByText("calendar：能直接给的只读动作")).toBeTruthy();
  expect(view.getByText("mail：send")).toBeTruthy();
});

test("a change that makes an employee public says so in the signal colour", async () => {
  agent();
  serving("employee_change", {
    agentId: "a1",
    set: { visibility: "public" },
    appsRemove: [],
    routinesRemove: [],
  });
  const view = routed(line("employee_change", "调整「小红」"));

  const shown = await view.findByText("公开给全团队");
  expect(shown.className).toContain("text-signal");
});

test("instructions are shown only for a personal starter", async () => {
  agent();
  serving("employee_change", {
    agentId: "a1",
    set: { title: "主管", instructions: "先看日程。" },
    appsRemove: [],
    routinesRemove: [],
  });
  const ordinary = routed(line("employee_change", "调整「小红」"));
  await ordinary.findByText("主管");
  expect(ordinary.queryByText("先看日程。")).toBeNull();
  cleanup();

  agent({ instructions: "先看邮件。" });
  const starter = routed(line("employee_change", "调整「小红」"));
  expect(await starter.findByText("先看日程。")).toBeTruthy();
  expect(starter.getByText("先看邮件。")).toBeTruthy();
});

test("a partly failed proposal can be discarded and still shows what was done", async () => {
  const result = [
    {
      step: "rename",
      target: "新名字",
      outcome: "failed",
      message: "找不到这个群聊。",
    },
  ];
  serving(
    "group_change",
    { channelId: "c1", name: "新名字", add: [], remove: [] },
    { status: "partially_applied", result },
  );
  answers["POST /api/proposals/p1/discard"] = () =>
    Response.json({
      proposal: proposal(
        "group_change",
        { channelId: "c1", name: "新名字", add: [], remove: [] },
        { status: "discarded", result },
      ),
    });
  const view = routed(line("group_change", "调整群聊"));

  fireEvent.click(await view.findByRole("button", { name: "作废" }));

  expect(
    await view.findByText("已作废：做成的几步保留，失败的不再重试。"),
  ).toBeTruthy();
  expect(view.getByText("找不到这个群聊。")).toBeTruthy();
  expect(view.queryByRole("button", { name: "重试失败的步骤" })).toBeNull();
  await waitFor(() =>
    expect(
      proposalCalls().map((call) => `${call.method} ${call.path}`),
    ).toEqual(["GET /api/proposals/p1", "POST /api/proposals/p1/discard"]),
  );
});
