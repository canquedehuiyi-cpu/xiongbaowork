/*
 * 外部员工在对话里的卡片（外部员工 Task 12，设计稿第 3 屏）和手机审批页（第 5 屏）。
 *
 * 进度、改动、中断三张卡：事件按服务器发的形状（`server/src/agents/acp/translate.ts`、`agent.ts`）喂进代理
 * 订阅者（`createAcpCardTracker` 的 `subscriber`，对话页就是这样订阅的），再画进真的对话转录。请求许可卡：
 * 真的转录 + 审批收件箱，审批的形状照 `server/src/agents/acp/permissions.ts` 的 `AcpApprovalCard`。
 * 手机审批页：真的 `/approvals?id=` 路由，窗口按 390 宽的手机回答。
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import type { Message } from "@ag-ui/core";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
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
import { AcpPermissionCard } from "@/components/channels/acp-cards";
import {
  ChatTranscript,
  type TranscriptAcpCards,
} from "@/components/channels/chat-transcript";
import {
  type AcpCard,
  type AcpCardTracker,
  createAcpCardTracker,
} from "@/lib/channels/acp-events";
import { queryClient } from "@/query-client";
import { Route as ApprovalsRoute } from "@/routes/_authed/_app/approvals";
import { settleReactWork } from "./settle-react-work";

type Sent = { url: string; method: string; body: unknown };
const sent: Sent[] = [];
const originalFetch = globalThis.fetch;
let originalMatchMedia: typeof window.matchMedia;
let inbox: unknown[] = [];
let single: Map<string, unknown>;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  originalMatchMedia = window.matchMedia;
});

beforeEach(() => {
  sent.length = 0;
  inbox = [];
  single = new Map();
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost/");
      const method = init?.method ?? "GET";
      sent.push({
        url: url.pathname,
        method,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      });
      if (method === "GET" && url.pathname === "/api/approvals")
        return Response.json({
          enabled: true,
          requests: inbox,
          rules: [],
          teamRules: [],
          questions: [],
        });
      if (method === "GET" && url.pathname === "/api/agents")
        return Response.json({ agents: [CODEX] });
      if (method === "POST" && url.pathname.endsWith("/decision"))
        return Response.json({ ok: true });
      if (method === "GET" && single.has(url.pathname))
        return Response.json(single.get(url.pathname));
      return Response.json({ error: "not served" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  window.matchMedia = originalMatchMedia;
});

afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

const CODEX = {
  id: "ext-codex",
  name: "代码熊",
  avatarSeed: "ext-codex",
  external: { harness: "codex" },
};

/** 设备上那一步的工具调用，在对话里的 id（`<runId>:<智能体的 id>`）。 */
const PUSH_CALL = "run-1:call-push";

/** 派活、它说了一句、读了文件、要推送代码（还没有结果）。 */
const conversation: Message[] = [
  {
    id: "u1",
    role: "user",
    content: "登录接口偶尔报 401，帮我查一下修好，改完推到 fix/login 分支。",
  },
  {
    id: "run-1-message-1",
    role: "assistant",
    content: "我先看看登录相关的代码。",
  },
  {
    id: "run-1-message-2",
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id: PUSH_CALL,
        type: "function",
        function: {
          name: "acp/execute",
          arguments: JSON.stringify({
            title: "git push origin fix/login",
            kind: "execute",
          }),
        },
      },
    ],
  },
];

/** 按对话页的方式把事件喂给订阅者：先 RUN_STARTED，每个 CUSTOM 带着那一刻的消息。 */
function feed(
  tracker: AcpCardTracker,
  runId: string,
  events: { name: string; value: unknown; upto: number }[],
) {
  const subscriber = tracker.subscriber as {
    onRunStartedEvent: (params: unknown) => void;
    onCustomEvent: (params: unknown) => void;
  };
  subscriber.onRunStartedEvent({
    event: { type: "RUN_STARTED", threadId: "t-1", runId },
  });
  for (const event of events)
    subscriber.onCustomEvent({
      event: { type: "CUSTOM", name: event.name, value: event.value },
      messages: conversation.slice(0, event.upto),
    });
}

function drawTranscript(acp?: TranscriptAcpCards, messages = conversation) {
  return render(
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider>
        <ChatTranscript
          acp={acp}
          busy={false}
          messages={messages}
          restoring={false}
          threadId="t-1"
        />
      </CopilotKitProvider>
    </QueryClientProvider>,
  );
}

const PLAN = [
  { content: "读了 auth.ts、session.ts 和登录的测试", status: "completed" },
  { content: "找到原因：令牌过期判断用的是本机时间", status: "completed" },
  { content: "推送到 fix/login，等你确认", status: "in_progress" },
  { content: "在群里汇报", status: "pending" },
];

describe("进度卡与改动卡", () => {
  test("plan card ticks done steps and dots the running one", async () => {
    const tracker = createAcpCardTracker();
    feed(tracker, "run-1", [
      // 第一份计划只有一步，后来的整份换掉它：同一轮只有一张进度卡。
      {
        name: "acp.plan",
        value: [{ content: "读代码", status: "in_progress" }],
        upto: 2,
      },
      { name: "acp.plan", value: PLAN, upto: 3 },
    ]);
    const cards = tracker.cards();
    expect(cards).toHaveLength(1);
    // 位置跟着第一次出现：那时最后一条消息是它说的那句话。
    expect(cards[0]?.anchor).toBe("run-1-message-1");

    const view = drawTranscript({ cards });
    const card = await view.findByRole("region", { name: "正在做" });
    expect(within(card).getByText("2 / 4 步")).toBeTruthy();
    const steps = within(card).getAllByRole("listitem");
    expect(steps.map((step) => step.getAttribute("data-step"))).toEqual([
      "completed",
      "completed",
      "in_progress",
      "pending",
    ]);
    // 做完的打勾，正在做的一个圆点，还没开始的空心圈。
    expect(steps[0]?.textContent).toContain("✓");
    expect(steps[1]?.textContent).toContain("✓");
    expect(steps[2]?.textContent).toContain("●");
    expect(steps[2]?.textContent).toContain("推送到 fix/login，等你确认");
    expect(steps[3]?.textContent).toContain("○");
    expect(steps[3]?.textContent).not.toContain("✓");
    // 画在它跟着的那句话下面：卡在那一行里，不在推送那一步的行里。
    const row = view.container.querySelector(
      '[data-message-id="run-1-message-1"]',
    );
    expect(row?.querySelector('[data-acp-card="plan"]')).toBe(card);

    // 计划全做完时卡片说「做完了」。
    const done = createAcpCardTracker();
    feed(done, "run-2", [
      {
        name: "acp.plan",
        value: PLAN.map((step) => ({ ...step, status: "completed" })),
        upto: 2,
      },
    ]);
    cleanup();
    const finished = drawTranscript({ cards: done.cards() });
    const doneCard = await finished.findByRole("region", { name: "做完了" });
    expect(within(doneCard).getByText("4 / 4 步")).toBeTruthy();
  });

  test("diff card lists files with +/- and expands", async () => {
    const tracker = createAcpCardTracker();
    feed(tracker, "run-1", [
      // 同一个调用往前走时再报一次：只算最新那份。
      {
        name: "acp.diff",
        value: {
          toolCallId: "run-1:edit-1",
          files: [{ path: "server/auth.ts", added: 2, removed: 1 }],
        },
        upto: 2,
      },
      {
        name: "acp.diff",
        value: {
          toolCallId: "run-1:edit-1",
          files: [{ path: "server/auth.ts", added: 6, removed: 2 }],
        },
        upto: 2,
      },
      // 另一个调用又改了同一个文件、加了一个新文件：按文件加总。
      {
        name: "acp.diff",
        value: {
          toolCallId: "run-1:edit-2",
          files: [
            { path: "server/auth.ts", added: 3, removed: 1 },
            { path: "server/auth.test.ts", added: 3, removed: 0 },
          ],
        },
        upto: 3,
      },
    ]);
    const cards = tracker.cards();
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      kind: "diff",
      files: [
        { path: "server/auth.ts", added: 9, removed: 3 },
        { path: "server/auth.test.ts", added: 3, removed: 0 },
      ],
    });

    const view = drawTranscript({ cards });
    const card = await view.findByRole("region", { name: "改动" });
    expect(card.textContent).toContain("改了 2 个文件");
    expect(card.textContent).toContain("+12");
    expect(card.textContent).toContain("−3");
    // 收着的时候不列文件。
    expect(within(card).queryByRole("list", { name: "改动的文件" })).toBeNull();
    const toggle = within(card).getByRole("button", { name: "看改动" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    const user = userEvent.setup({ document });
    await user.click(toggle);
    const list = within(card).getByRole("list", { name: "改动的文件" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      "server/auth.ts+9−3",
      "server/auth.test.ts+3",
    ]);
    expect(
      within(card)
        .getByRole("button", { name: "收起" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
  });
});

/** 一条外部员工的「等你确认」，形状照服务器的审批记录。 */
function acpApproval(
  id: string,
  card: Partial<{
    offerConversation: boolean;
    hit: string;
    reason: string;
    toolCallId: string;
  }> = {},
) {
  return {
    id,
    status: "pending",
    createdAt: "2026-11-15T08:00:00.000Z",
    action: {
      botId: "ext-codex",
      toolRef: "acp/execute",
      effect: "write",
      scope: "push+runCommand:git push origin fix/login",
      threadId: "t-1",
      // 审批以设备的请求命名，不是对话里那一步的 id。
      toolCallId: `acp:dev-mac:req-${id}`,
      args: { command: "git push origin fix/login" },
      target: {
        acp: {
          employee: "代码熊",
          computer: "何总的 MacBook Pro",
          action: "代码熊想要运行命令：git push origin fix/login",
          hit: card.hit ?? "「提交并推送代码」设成了先问你",
          reason:
            card.reason ??
            "把这次的 2 个文件改动推送到远端仓库的 fix/login 分支。",
          summary: "这一轮已完成：读了 auth.ts；跑了测试，24 项全部通过",
          files: ["server/auth.ts", "server/auth.test.ts"],
          offerConversation: card.offerConversation ?? true,
          deviceId: "dev-mac",
          requestId: `req-${id}`,
          turnId: "turn-1",
          toolCallId: card.toolCallId ?? PUSH_CALL,
          options: [
            { optionId: "o1", kind: "allow_once", name: "Allow" },
            { optionId: "o2", kind: "allow_always", name: "Always" },
            { optionId: "o3", kind: "reject_once", name: "Reject" },
          ],
        },
      },
      policy: {
        behaviour: "ask",
        source: "default",
        reason: "「提交并推送代码」设成了先问你。",
      },
    },
  };
}

describe("请求许可卡", () => {
  test("permission card offers three choices, two when offerConversation is false", async () => {
    inbox = [acpApproval("ap-1")];
    const view = drawTranscript();
    const card = within(await view.findByRole("region", { name: "请求许可" }));
    expect(card.getByText("代码熊请求许可")).toBeTruthy();
    expect(card.getByText("「提交并推送代码」设成了先问你")).toBeTruthy();
    // 命令原文。
    expect(card.getByText("git push origin fix/login")).toBeTruthy();
    expect(
      card.getByText("把这次的 2 个文件改动推送到远端仓库的 fix/login 分支。"),
    ).toBeTruthy();
    expect(card.getByText("已同时推到你的手机")).toBeTruthy();
    expect(
      card.getAllByRole("button").map((button) => button.textContent),
    ).toEqual(["批准", "拒绝", "这次对话里都允许"]);

    // 「这次对话里都允许」是 allow_conversation（服务器回给智能体 allow_always）。
    const user = userEvent.setup({ document });
    await user.click(card.getByRole("button", { name: "这次对话里都允许" }));
    await waitFor(() =>
      expect(sent.find((request) => request.method === "POST")).toMatchObject({
        url: "/api/approvals/ap-1/decision",
        body: { decision: "allow_conversation" },
      }),
    );
    expect(
      await card.findByText("已允许，这次对话里同样的事不再问你。"),
    ).toBeTruthy();

    // 底线（删除）：只有批准和拒绝。
    cleanup();
    queryClient.clear();
    sent.length = 0;
    inbox = [
      acpApproval("ap-2", {
        offerConversation: false,
        hit: "底线：删除",
        reason: "删除一律问你，只给批准这一次。",
      }),
    ];
    const floor = drawTranscript();
    const floorCard = within(
      await floor.findByRole("region", { name: "请求许可" }),
    );
    expect(floorCard.getByText("底线：删除")).toBeTruthy();
    expect(
      floorCard.getAllByRole("button").map((button) => button.textContent),
    ).toEqual(["批准", "拒绝"]);
    await user.click(floorCard.getByRole("button", { name: "批准" }));
    await waitFor(() =>
      expect(sent.find((request) => request.method === "POST")).toMatchObject({
        url: "/api/approvals/ap-2/decision",
        body: { decision: "allow_once" },
      }),
    );
  });

  test("a request whose step is not in the conversation still gets its card at the end", async () => {
    inbox = [acpApproval("ap-3", { toolCallId: "run-1:not-drawn" })];
    const view = drawTranscript({ cards: [] });
    const card = await view.findByRole("region", { name: "请求许可" });
    expect(card.closest("[data-acp-unplaced]")).toBeTruthy();
    // 另一段对话的请求不画在这里。
    cleanup();
    queryClient.clear();
    const elsewhere = acpApproval("ap-4", { toolCallId: "run-1:not-drawn" });
    inbox = [
      { ...elsewhere, action: { ...elsewhere.action, threadId: "t-other" } },
    ];
    const other = drawTranscript({ cards: [] });
    await settleReactWork();
    await waitFor(() =>
      expect(sent.some((request) => request.url === "/api/approvals")).toBe(
        true,
      ),
    );
    expect(other.queryByRole("region", { name: "请求许可" })).toBeNull();
  });

  test("non-hirer sees 等 X 确认 and no buttons", () => {
    const decided: string[] = [];
    const view = render(
      <AcpPermissionCard
        card={{
          employee: "代码熊",
          computer: "何总的 MacBook Pro",
          action: "代码熊想要运行命令：git push origin fix/login",
          hit: "「提交并推送代码」设成了先问你",
          reason: "把这次的 2 个文件改动推送到远端仓库的 fix/login 分支。",
          summary: "",
          files: [],
          offerConversation: true,
        }}
        onDecide={(choice) => decided.push(choice)}
        raw="git push origin fix/login"
        waitingFor="何总"
      />,
    );
    const card = within(view.getByRole("region", { name: "请求许可" }));
    expect(card.getByRole("status").textContent).toBe("等 何总 确认");
    expect(card.queryAllByRole("button")).toHaveLength(0);
    // 推到手机的是招聘人的手机，别人看不到这一行。
    expect(card.queryByText("已同时推到你的手机")).toBeNull();
    // 看得到它要做什么。
    expect(card.getByText("git push origin fix/login")).toBeTruthy();
    expect(decided).toEqual([]);
  });
});

describe("中断卡", () => {
  test("interrupted card re-sends the original prompt as a new turn on 重新派", async () => {
    const tracker = createAcpCardTracker();
    const prompt =
      "登录接口偶尔报 401，帮我查一下修好，改完推到 fix/login 分支。";
    feed(tracker, "run-1", [
      { name: "acp.interrupted", value: { turnId: "turn-1", prompt }, upto: 3 },
    ]);
    const resent: AcpCard[] = [];
    let resolve: () => void = () => {};
    const view = drawTranscript({
      cards: tracker.cards(),
      onResend: (card) => {
        resent.push(card);
        // 新的一轮要等它做完才回来：按钮这时不能再按。
        return new Promise<void>((done) => {
          resolve = done;
        });
      },
    });
    const card = within(
      await view.findByRole("region", { name: "这件活中断了" }),
    );
    expect(card.getByText("电脑关机，这件活中断了，重新派？")).toBeTruthy();
    const user = userEvent.setup({ document });
    await user.click(card.getByRole("button", { name: "重新派" }));
    expect(resent).toHaveLength(1);
    expect(resent[0]).toMatchObject({ kind: "interrupted", prompt });
    expect(
      (card.getByRole("button", { name: "正在派…" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    resolve();
    const done = await card.findByRole("button", { name: "已重新派" });
    expect((done as HTMLButtonElement).disabled).toBe(true);
    await user.click(done);
    expect(resent).toHaveLength(1);
  });

  test("a resend that could not go out says why and can be tried again", async () => {
    const tracker = createAcpCardTracker();
    feed(tracker, "run-1", [
      {
        name: "acp.interrupted",
        value: { turnId: "turn-1", prompt: "修 401" },
        upto: 3,
      },
    ]);
    let attempts = 0;
    const view = drawTranscript({
      cards: tracker.cards(),
      onResend: async () => {
        attempts += 1;
        throw new Error("这位员工还在忙。等它做完，或者先让它停下。");
      },
    });
    const card = within(
      await view.findByRole("region", { name: "这件活中断了" }),
    );
    const user = userEvent.setup({ document });
    await user.click(card.getByRole("button", { name: "重新派" }));
    expect((await card.findByRole("alert")).textContent).toBe(
      "这位员工还在忙。等它做完，或者先让它停下。",
    );
    await user.click(card.getByRole("button", { name: "重新派" }));
    expect(attempts).toBe(2);
  });

  test("without the original words the card only says it was interrupted", async () => {
    const tracker = createAcpCardTracker();
    feed(tracker, "run-1", [
      { name: "acp.interrupted", value: { turnId: "turn-1" }, upto: 3 },
    ]);
    const view = drawTranscript({
      cards: tracker.cards(),
      onResend: () => undefined,
    });
    const card = within(
      await view.findByRole("region", { name: "这件活中断了" }),
    );
    expect(card.getByText("电脑关机，这件活中断了。")).toBeTruthy();
    expect(card.queryByRole("button")).toBeNull();
  });
});

describe("手机审批页", () => {
  /** 窗口按 390 宽的手机回答 `useIsMobile` 问的那条媒体查询。 */
  function asPhone() {
    window.matchMedia = ((query: string) => ({
      matches: query.includes("max-width"),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 390,
    });
  }

  function openApproval(id: string) {
    const rootRoute = createRootRoute({ component: Outlet });
    const authed = createRoute({
      id: "/_authed",
      getParentRoute: () => rootRoute,
      component: Outlet,
    });
    const app = createRoute({
      id: "/_app",
      getParentRoute: () => authed,
      component: Outlet,
    });
    const approvals = ApprovalsRoute.update({
      id: "/approvals",
      path: "/approvals",
      getParentRoute: () => app,
    } as Parameters<typeof ApprovalsRoute.update>[0] & {
      id: string;
      path: string;
      getParentRoute: () => typeof app;
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([
        authed.addChildren([app.addChildren([approvals])]),
      ]),
      history: createMemoryHistory({
        initialEntries: [`/approvals?id=${id}`],
      }),
    });
    return render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router as never} />
      </QueryClientProvider>,
    );
  }

  test("phone approval page has a fixed bottom 批准 button at 390px", async () => {
    asPhone();
    single.set("/api/approvals/ap-1", acpApproval("ap-1"));
    const view = openApproval("ap-1");
    const approve = await view.findByRole("button", { name: "批准" });
    // 按钮在贴着屏幕底部的那一栏里。
    const bar = approve.closest('[data-slot="approval-actions"]');
    expect(bar).toBeTruthy();
    const classes = bar?.className.split(/\s+/) ?? [];
    expect(classes).toContain("fixed");
    expect(classes).toContain("bottom-0");
    expect(classes).toContain("inset-x-0");
    // 大按钮：一整行，至少 48 高。
    expect(approve.className).toContain("w-full");
    expect(approve.className).toContain("min-h-12");
    expect(
      within(bar as HTMLElement)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["批准", "拒绝", "这次对话里都允许"]);
    // 设计稿里的「看它的屏幕」不做。
    expect(view.queryByText("看它的屏幕")).toBeNull();

    expect(view.getByRole("heading", { name: "等你确认" })).toBeTruthy();
    expect(
      view.getByText("代码熊想要运行命令：git push origin fix/login"),
    ).toBeTruthy();
    expect(
      await view.findByText("外部员工 · Codex · 何总的 MacBook Pro"),
    ).toBeTruthy();
    expect(view.getByText("git push origin fix/login")).toBeTruthy();
    const files = view.getByRole("list", { name: "改过的文件" });
    expect(
      within(files)
        .getAllByRole("listitem")
        .map((row) => row.textContent),
    ).toEqual(["server/auth.ts", "server/auth.test.ts"]);
    expect(
      view.getByText("这一轮已完成：读了 auth.ts；跑了测试，24 项全部通过"),
    ).toBeTruthy();

    const user = userEvent.setup({ document });
    await user.click(approve);
    await waitFor(() =>
      expect(sent.find((request) => request.method === "POST")).toMatchObject({
        url: "/api/approvals/ap-1/decision",
        body: { decision: "allow_once" },
      }),
    );
    expect(await view.findByText("已批准，只执行这一次。")).toBeTruthy();
    expect(view.queryByRole("button", { name: "批准" })).toBeNull();
  });

  test("a floor on the phone page offers only 批准 and 拒绝", async () => {
    asPhone();
    single.set(
      "/api/approvals/ap-2",
      acpApproval("ap-2", { offerConversation: false, hit: "底线：删除" }),
    );
    const view = openApproval("ap-2");
    await view.findByRole("button", { name: "批准" });
    const bar = view.container.querySelector(
      '[data-slot="approval-actions"]',
    ) as HTMLElement;
    expect(
      within(bar)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["批准", "拒绝"]);
  });

  test("an approval that is not yours says so and offers nothing", async () => {
    asPhone();
    // 不在 `single` 里：服务器回 404，和群里其他成员读别人的审批一样。
    const view = openApproval("ap-9");
    expect(
      await view.findByText("这条请求不在你这里，或者已经没有了。"),
    ).toBeTruthy();
    expect(view.queryByRole("button", { name: "批准" })).toBeNull();
  });
});
