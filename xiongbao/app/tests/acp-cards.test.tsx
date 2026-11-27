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
import { CopilotKitProvider as ChatRuntimeProvider } from "@copilotkit/react-core/v2";
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
import { act, cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ACP_PHONE_NOTE,
  acpNotes,
  type TranscriptAcpCards,
} from "@/components/channels/acp-cards";
import {
  ChatTranscript,
  ServerToolLine,
} from "@/components/channels/chat-transcript";
import { GroupChat } from "@/components/channels/group-chat";
import { GONE_BOT } from "@/lib/agents/bot-names";
import { carryingOnAfterApproval } from "@/lib/approvals";
import {
  type AcpCard,
  type AcpCardTracker,
  createAcpCardTracker,
} from "@/lib/channels/acp-events";
import { type GroupMessage, groupRefetchInterval } from "@/lib/groups";
import { placeDeliveryEvent } from "@/lib/tasks/delivery-chat";
import { queryClient } from "@/query-client";
import { Route as ApprovalsRoute } from "@/routes/_authed/_app/approvals";
import { speakerOf } from "@/skins/xiongbao/message-list";
import { settleReactWork } from "./settle-react-work";

type Sent = { url: string; method: string; body: unknown };
const sent: Sent[] = [];
const originalFetch = globalThis.fetch;
let originalMatchMedia: typeof window.matchMedia;
let inbox: unknown[] = [];
let single: Map<string, unknown>;
/** 别处已经决定过了：决定接口照服务器的样子回 400。 */
let decided = false;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  originalMatchMedia = window.matchMedia;
});

beforeEach(() => {
  sent.length = 0;
  inbox = [];
  single = new Map();
  decided = false;
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
        return decided
          ? Response.json(
              { error: "This request was already decided." },
              { status: 400 },
            )
          : Response.json({ ok: true });
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
      <ChatRuntimeProvider>
        <ChatTranscript
          {...(acp ? { acpApprovals: true, notes: acpNotes(acp) } : {})}
          busy={false}
          messages={messages}
          restoring={false}
          threadId="t-1"
        />
      </ChatRuntimeProvider>
    </QueryClientProvider>,
  );
}

const PLAN = [
  { content: "读了 auth.ts、session.ts 和登录的测试", status: "completed" },
  { content: "找到原因：令牌过期判断用的是本机时间", status: "completed" },
  { content: "推送到 fix/login，等你确认", status: "in_progress" },
  { content: "在群里汇报", status: "pending" },
];

describe("和交付卡同一套附注", () => {
  test("cards under one row follow the order they first came in", async () => {
    // 事件流里先是接活（交付卡），再是计划（外部员工的卡），两样都跟在同一条消息下面。
    const placed = placeDeliveryEvent([], "run-1-message-1", {
      kind: "accepted",
      taskId: "task-1",
      dueAt: null,
      criteria: null,
    });
    const tracker = createAcpCardTracker();
    feed(tracker, "run-1", [{ name: "acp.plan", value: PLAN, upto: 2 }]);
    const [plan] = tracker.cards();
    expect(plan?.anchor).toBe("run-1-message-1");
    expect((placed[0]?.order ?? 0) < (plan?.order ?? 0)).toBe(true);

    const view = render(
      <QueryClientProvider client={queryClient}>
        <ChatRuntimeProvider>
          <ChatTranscript
            busy={false}
            messages={conversation}
            // 给的先后故意反过来：外部员工的卡在前（对话页就是这样拼的）。
            notes={[
              ...acpNotes({ cards: tracker.cards() }),
              {
                key: placed[0]?.key ?? "",
                anchor: placed[0]?.anchor ?? null,
                order: placed[0]?.order,
                node: <p data-delivery-note="">已接下</p>,
              },
            ]}
            restoring={false}
            threadId="t-1"
          />
        </ChatRuntimeProvider>
      </QueryClientProvider>,
    );
    const card = await view.findByRole("region", { name: "正在做" });
    const notes = card.closest("[data-transcript-notes]");
    expect(notes).toBeTruthy();
    const drawn = [...(notes?.children ?? [])].map((child) =>
      child.hasAttribute("data-delivery-note")
        ? "delivery"
        : child.getAttribute("data-acp-card"),
    );
    expect(drawn).toEqual(["delivery", "plan"]);
  });
});

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
          status: "in_progress",
        },
        upto: 2,
      },
      {
        name: "acp.diff",
        value: {
          toolCallId: "run-1:edit-1",
          files: [{ path: "server/auth.ts", added: 6, removed: 2 }],
          status: "completed",
        },
        upto: 2,
      },
      // 另一个调用又改了同一个文件、加了一个新文件：按文件加总。它先报改动、结束时再补一条只带状态的。
      {
        name: "acp.diff",
        value: {
          toolCallId: "run-1:edit-2",
          files: [
            { path: "server/auth.ts", added: 3, removed: 1 },
            { path: "server/auth.test.ts", added: 3, removed: 0 },
          ],
          status: "in_progress",
        },
        upto: 3,
      },
      {
        name: "acp.diff",
        value: { toolCallId: "run-1:edit-2", files: [], status: "completed" },
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

  test("a failed edit is not counted on the diff card", async () => {
    const tracker = createAcpCardTracker();
    feed(tracker, "run-1", [
      {
        name: "acp.diff",
        value: {
          toolCallId: "run-1:edit-1",
          files: [{ path: "server/auth.ts", added: 6, removed: 2 }],
          status: "completed",
        },
        upto: 2,
      },
      // 这个调用报了它想写的改动，最后失败了（服务器补一条文件为空、`failed` 的）：什么也没写。
      {
        name: "acp.diff",
        value: {
          toolCallId: "run-1:edit-2",
          files: [
            { path: "server/auth.ts", added: 40, removed: 10 },
            { path: "server/session.ts", added: 5, removed: 0 },
          ],
          status: "in_progress",
        },
        upto: 3,
      },
      {
        name: "acp.diff",
        value: { toolCallId: "run-1:edit-2", files: [], status: "failed" },
        upto: 3,
      },
    ]);
    const cards = tracker.cards();
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      kind: "diff",
      anchor: "run-1-message-1",
      files: [{ path: "server/auth.ts", added: 6, removed: 2 }],
    });
    const view = drawTranscript({ cards });
    const card = await view.findByRole("region", { name: "改动" });
    expect(card.textContent).toContain("改了 1 个文件");
    expect(card.textContent).toContain("+6");
    expect(card.textContent).not.toContain("+46");
  });

  test("a turn whose only edit failed has no diff card", () => {
    const tracker = createAcpCardTracker();
    feed(tracker, "run-1", [
      {
        name: "acp.diff",
        value: {
          toolCallId: "run-1:edit-1",
          files: [{ path: "server/auth.ts", added: 6, removed: 2 }],
          status: "pending",
        },
        upto: 2,
      },
    ]);
    // 还没做完的调用不算改动：和看板一样，等它 `completed` 才算。
    expect(tracker.cards()).toEqual([]);
    tracker.take({
      runId: "run-1",
      name: "acp.diff",
      value: { toolCallId: "run-1:edit-1", files: [], status: "failed" },
      anchor: "run-1-message-2",
    });
    expect(tracker.cards()).toEqual([]);
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
    // 手机推送不说死：分不出这个人有没有可用的手机通道。
    expect(card.getByText(ACP_PHONE_NOTE)).toBeTruthy();
    expect(ACP_PHONE_NOTE).toBe("也会推到你的手机（如果开了通知）");
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
    expect(card.getByText("电脑开机后可以重新派。")).toBeTruthy();
    // 「电脑关机，这件活中断了。」是服务器那句话，卡上不再说一遍。
    expect(card.queryByText(/电脑关机/)).toBeNull();
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

  test("without the original words there is no card: the server's sentence says it all", async () => {
    const tracker = createAcpCardTracker();
    feed(tracker, "run-1", [
      { name: "acp.interrupted", value: { turnId: "turn-1" }, upto: 3 },
    ]);
    const view = drawTranscript({
      cards: tracker.cards(),
      onResend: () => undefined,
    });
    await view.findByText("我先看看登录相关的代码。");
    expect(view.queryByRole("region", { name: "这件活中断了" })).toBeNull();
    expect(view.queryByRole("button", { name: "重新派" })).toBeNull();
  });
});

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
      initialEntries: [id ? `/approvals?id=${id}` : "/approvals"],
    }),
  });
  return Object.assign(
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router as never} />
      </QueryClientProvider>,
    ),
    { router },
  );
}

describe("手机审批页", () => {
  test("going straight from one approval to another shows the second as it is", async () => {
    asPhone();
    single.set("/api/approvals/ap-a", acpApproval("ap-a"));
    single.set("/api/approvals/ap-b", acpApproval("ap-b"));
    const view = openApproval("ap-a");
    const user = userEvent.setup({ document });
    await user.click(await view.findByRole("button", { name: "批准" }));
    expect(await view.findByText("已批准，只执行这一次。")).toBeTruthy();

    // 同一个页面，换一个 id：B 还在等，按钮要回来，不能带着 A 的「已批准」。
    await act(async () => {
      await view.router.navigate({
        to: "/approvals",
        search: { id: "ap-b" },
      } as never);
    });
    expect(await view.findByRole("button", { name: "批准" })).toBeTruthy();
    expect(view.queryByText("已批准，只执行这一次。")).toBeNull();
  });

  // happy-dom 不排版：这里断言的是贴底的那一栏和按钮的样式类，内容会不会被挡住靠 390 宽的截图验证。
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

describe("群里的许可状态行", () => {
  const HIRER = "user-he";
  const MEMBER = "user-li";
  const GROUP_THREAD = "t-group-codex";

  /** 服务器给每个成员的那一行：只有谁在等谁确认、结果如何。 */
  const statusLine = (
    status: "waiting" | "approved" | "denied" | "expired",
  ): GroupMessage => ({
    id: "acp-permission:0f3c",
    channelId: "g-1",
    ownerUserId: HIRER,
    agentId: "ext-codex",
    threadId: GROUP_THREAD,
    text: "",
    status: "completed",
    createdAt: "2026-11-15T08:01:00.000Z",
    acpPermission: {
      kind: "acp.permission",
      agentId: "ext-codex",
      hirerUserId: HIRER,
      hirerName: "何总",
      status,
    },
  });

  function openGroup(reader: string, line: GroupMessage) {
    single.set("/api/me", {
      user: { id: reader, role: "user", email: `${reader}@example.test` },
    });
    single.set("/api/groups/g-1", {
      bots: [
        { id: "ext-codex", name: "代码熊", hiredBy: HIRER, harness: "codex" },
        { id: "a1", name: "产品官" },
      ],
      people: [
        {
          userId: HIRER,
          email: "he@example.test",
          name: "何总",
          creator: true,
        },
        {
          userId: MEMBER,
          email: "li@example.test",
          name: "小李",
          creator: false,
        },
      ],
      messages: [
        {
          id: "m1",
          channelId: "g-1",
          ownerUserId: MEMBER,
          agentId: null,
          text: "@代码熊 登录接口偶尔报 401，你看一下。",
          status: "completed",
          createdAt: "2026-11-15T08:00:00.000Z",
        },
        line,
      ],
    });
    const root = createRootRoute({ component: Outlet });
    const page = createRoute({
      getParentRoute: () => root,
      path: "/",
      component: () => <GroupChat channelId="g-1" />,
    });
    const approvals = createRoute({
      getParentRoute: () => root,
      path: "/approvals",
      component: () => null,
    });
    const router = createRouter({
      routeTree: root.addChildren([page, approvals]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    return render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router as never} />
      </QueryClientProvider>,
    );
  }

  test("non-hirer sees 等 X 确认 and no buttons", async () => {
    // 招聘人的审批在他自己那里；成员的收件箱里没有。
    inbox = [];
    const view = openGroup(MEMBER, statusLine("waiting"));
    const line = await view.findByText("代码熊在等 何总 确认一个操作");
    const row = line.closest("[data-acp-group-line]") as HTMLElement;
    expect(within(row).queryAllByRole("button")).toHaveLength(0);
    expect(within(row).queryByRole("link", { name: "去确认" })).toBeNull();
    expect(within(row).queryByRole("region", { name: "请求许可" })).toBeNull();
    // 不去审批接口试探：成员读别人的审批一律 404。
    expect(
      sent.some((request) => request.url.startsWith("/api/approvals/")),
    ).toBe(false);
  });

  test("the hirer sees the same line with 去确认 and decides from their own approval", async () => {
    // 收件箱里没有它（比如已经挤出最新 100 条）：卡片照样按这一行带的审批 id 读到。
    inbox = [];
    single.set("/api/approvals/ap-g", {
      ...acpApproval("ap-g"),
      action: { ...acpApproval("ap-g").action, threadId: GROUP_THREAD },
    });
    const view = openGroup(HIRER, {
      ...statusLine("waiting"),
      approvalId: "ap-g",
    });
    await view.findByText("代码熊在等你确认一个操作");
    const go = await view.findByRole("link", { name: "去确认" });
    await waitFor(() =>
      expect(go.getAttribute("href")).toBe("/approvals?id=ap-g"),
    );
    // 卡片内容来自他自己的审批：命令原文和三个按钮。
    const card = within(await view.findByRole("region", { name: "请求许可" }));
    expect(card.getByText("git push origin fix/login")).toBeTruthy();
    const user = userEvent.setup({ document });
    await user.click(card.getByRole("button", { name: "批准" }));
    await waitFor(() =>
      expect(sent.find((request) => request.method === "POST")).toMatchObject({
        url: "/api/approvals/ap-g/decision",
        body: { decision: "allow_once" },
      }),
    );
  });

  /** 外部员工的回答停在招聘人的「分享到群」检查上（服务器只给状态和 waitKind）。 */
  const shareWait: GroupMessage = {
    id: "handoff:abc",
    channelId: "g-1",
    ownerUserId: HIRER,
    agentId: "ext-codex",
    threadId: GROUP_THREAD,
    text: "",
    status: "waiting",
    createdAt: "2026-11-15T08:02:00.000Z",
    reason:
      "Waiting for permission to share private information with this group conversation. Nothing was sent.",
    waitKind: "share",
    answeredBy: "ext-codex",
  };

  test("a member is told whose word the answer waits on, in Chinese, with nothing to do", async () => {
    inbox = [];
    const view = openGroup(MEMBER, shareWait);
    const line = await view.findByText(
      "代码熊的回答要等 何总 确认能不能发到群里",
    );
    expect(line.closest("[data-waiting-other]")).toBeTruthy();
    expect(view.queryByText("需要你处理")).toBeNull();
    expect(view.queryByRole("link", { name: "去审批" })).toBeNull();
    expect(view.container.textContent).not.toContain("Waiting for permission");
    // Its own answer, not one somebody else gave for it; and its mark beside its name.
    expect(view.container.textContent).not.toContain("代答");
    expect(
      view.container.querySelector("[data-external-mark]")?.textContent,
    ).toBe("外部员工 · Codex");
  });

  test("the hirer is asked to decide whether the answer may reach the group", async () => {
    inbox = [];
    const view = openGroup(HIRER, shareWait);
    expect(await view.findByText("需要你处理")).toBeTruthy();
    expect(
      view.getByText(
        "代码熊的回答要等你确认能不能发到群里，确认前群里看不到。",
      ),
    ).toBeTruthy();
    expect(view.getByRole("link", { name: "去审批" })).toBeTruthy();
    expect(view.container.textContent).not.toContain("Waiting for permission");
  });

  test("once decided the line says how it ended, for everyone", async () => {
    inbox = [];
    const approved = openGroup(MEMBER, statusLine("approved"));
    expect(
      await approved.findByText("何总批准了代码熊的一个操作"),
    ).toBeTruthy();
    cleanup();
    queryClient.clear();
    const expired = openGroup(MEMBER, statusLine("expired"));
    expect(
      await expired.findByText("代码熊等确认的一个操作已作废"),
    ).toBeTruthy();
    cleanup();
    queryClient.clear();
    const mine = openGroup(HIRER, statusLine("denied"));
    expect(await mine.findByText("你拒绝了代码熊的一个操作")).toBeTruthy();
    expect(mine.queryByRole("link", { name: "去确认" })).toBeNull();
  });

  test("an open group keeps reading while a line waits on its hirer, backing off with its age", () => {
    // 假时钟：这一行在 T 写下，问的是 T 之后各个时刻的轮询间隔。
    const T = Date.parse("2026-11-15T08:01:00.000Z");
    const conversation = (line: GroupMessage, extra: GroupMessage[] = []) => ({
      bots: [],
      people: [],
      messages: [
        {
          id: "m1",
          channelId: "g-1",
          ownerUserId: MEMBER,
          agentId: null,
          text: "@代码熊 看一下",
          status: "completed" as const,
          // 很久以前的：不是「刚发的话还没人接」那种轮询。
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        ...extra,
        line,
      ],
    });
    const waiting = conversation(statusLine("waiting"));
    const at = (ms: number) => groupRefetchInterval(waiting, T + ms);
    expect(at(0)).toBe(1_500);
    expect(at(29_999)).toBe(1_500);
    expect(at(30_000)).toBe(5_000);
    expect(at(5 * 60_000 - 1)).toBe(5_000);
    expect(at(5 * 60_000)).toBe(10_000);
    expect(at(60 * 60_000 - 1)).toBe(10_000);
    // 一小时还在等：多半是崩溃留下的，不再轮询。
    expect(at(60 * 60_000)).toBe(false);
    expect(at(3 * 60 * 60_000)).toBe(false);
    // 结束的行不轮询。
    expect(groupRefetchInterval(conversation(statusLine("approved")), T)).toBe(
      false,
    );
    // 有员工在跑：照旧 1.5 秒，不管等待行多老。
    const running: GroupMessage = {
      id: "r1",
      channelId: "g-1",
      ownerUserId: MEMBER,
      agentId: "a1",
      text: "",
      status: "running",
      createdAt: "2026-11-15T08:00:30.000Z",
    };
    expect(
      groupRefetchInterval(
        conversation(statusLine("waiting"), [running]),
        T + 3 * 60 * 60_000,
      ),
    ).toBe(1_500);
  });
});

describe("第 1 轮修复", () => {
  test("only the last turn's interrupted card can be sent again, on a replay too", async () => {
    const tracker = createAcpCardTracker();
    feed(tracker, "run-1", [
      {
        name: "acp.interrupted",
        value: { turnId: "turn-1", prompt: "修 401" },
        upto: 3,
      },
    ]);
    // 那之后又开始过一轮（重新派过，或者说了别的）：重放历史也是这个顺序。
    tracker.started("run-2");
    const [card] = tracker.cards();
    expect(card).toMatchObject({ kind: "interrupted", superseded: true });
    const view = drawTranscript({
      cards: tracker.cards(),
      onResend: () => undefined,
    });
    const shown = within(
      await view.findByRole("region", { name: "这件活中断了" }),
    );
    expect(shown.getByText("这件活已有后续。")).toBeTruthy();
    expect(shown.queryByRole("button")).toBeNull();

    // 最后一轮的中断卡照旧能重新派。
    cleanup();
    const last = createAcpCardTracker();
    last.started("run-1");
    feed(last, "run-2", [
      {
        name: "acp.interrupted",
        value: { turnId: "turn-2", prompt: "修 401" },
        upto: 3,
      },
    ]);
    expect(last.cards()[0]).toMatchObject({ superseded: false });
    const again = drawTranscript({
      cards: last.cards(),
      onResend: () => undefined,
    });
    expect(await again.findByRole("button", { name: "重新派" })).toBeTruthy();
  });

  test("deciding what was already decided elsewhere says so in Chinese", async () => {
    single.set("/api/approvals/ap-1", acpApproval("ap-1"));
    decided = true;
    const view = openApproval("ap-1");
    const user = userEvent.setup({ document });
    await user.click(await view.findByRole("button", { name: "批准" }));
    expect((await view.findByRole("alert")).textContent).toBe(
      "这条请求已经处理过了。",
    );
    expect(view.queryByText(/already decided/)).toBeNull();
  });

  test("the phone page does not decide other kinds of request", async () => {
    single.set("/api/approvals/ap-x", {
      ...acpApproval("ap-x"),
      action: {
        ...acpApproval("ap-x").action,
        toolRef: "computer_run_command",
        target: {},
        policy: { behaviour: "hand_off", source: "safety", reason: "交给你。" },
      },
    });
    const view = openApproval("ap-x");
    expect(await view.findByText(/这条请求请到审批列表里处理/)).toBeTruthy();
    expect(view.queryByRole("button")).toBeNull();
    expect(view.queryByText(/"command"/)).toBeNull();
  });
});

describe("审批列表页", () => {
  test("an external employee's request in the approvals list has its own three choices, not 在这里总是允许", async () => {
    single.set("/api/me", {
      user: { id: "user-he", role: "user", email: "he@example.test" },
    });
    inbox = [
      acpApproval("ap-list"),
      acpApproval("ap-floor", {
        offerConversation: false,
        hit: "底线：删除",
      }),
    ];
    const view = openApproval("");
    const rows = await waitFor(() => {
      const found = view.container.querySelectorAll("[data-acp-inbox-row]");
      expect(found).toHaveLength(2);
      return [...found] as HTMLElement[];
    });
    const [first, floor] = rows as [HTMLElement, HTMLElement];
    expect(
      within(first)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["批准", "拒绝", "这次对话里都允许"]);
    expect(
      within(floor)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["批准", "拒绝"]);
    expect(view.queryByRole("button", { name: "在这里总是允许" })).toBeNull();
    // 一句话加原文，没有原始的字段名。
    expect(within(first).getByText("git push origin fix/login")).toBeTruthy();
    expect(view.container.textContent).not.toContain('"command"');
    expect(
      within(first).getByRole("link", { name: "看详情" }).getAttribute("href"),
    ).toBe("/approvals?id=ap-list");

    const user = userEvent.setup({ document });
    await user.click(
      within(first).getByRole("button", { name: "这次对话里都允许" }),
    );
    await waitFor(() =>
      expect(sent.find((request) => request.method === "POST")).toMatchObject({
        url: "/api/approvals/ap-list/decision",
        body: { decision: "allow_conversation" },
      }),
    );
  });
});

describe("批准之后", () => {
  test("an approved external employee's permission does not hold the conversation as the server carrying on", () => {
    // 外部员工的许可答复给电脑上的智能体，它这一轮在对话已经跟着的事件流里接着跑；审批不会被标成 completed。
    const now = Date.parse("2026-11-15T08:01:00.000Z");
    const decided = (toolRef: string) => ({
      enabled: true,
      rules: [],
      teamRules: [],
      questions: [],
      requests: [
        {
          ...acpApproval("ap-done"),
          status: "approved",
          decidedAt: "2026-11-15T08:00:30.000Z",
          action: { ...acpApproval("ap-done").action, toolRef },
        },
      ],
    });
    expect(
      carryingOnAfterApproval(decided("acp/execute") as never, "t-1", now),
    ).toBe(false);
    // 别的审批照旧：服务器在没有浏览器跟着的一轮里接着做。
    expect(
      carryingOnAfterApproval(
        decided("computer_navigate") as never,
        "t-1",
        now,
      ),
    ).toBe(true);
  });
});

describe("外部员工的工具步骤", () => {
  test("an external employee's step reads in words, with its own title, never as acp/execute", async () => {
    const view = render(
      <QueryClientProvider client={queryClient}>
        <ServerToolLine
          args={JSON.stringify({
            title: "git push origin fix/login",
            kind: "execute",
          })}
          name="acp/execute"
          result="完成。"
        />
      </QueryClientProvider>,
    );
    expect(await view.findByText("运行了命令")).toBeTruthy();
    expect(view.getByText("git push origin fix/login")).toBeTruthy();
    expect(view.container.textContent).not.toMatch(/acp/i);
  });
});

describe("分享到群的审批", () => {
  test("the approvals list says in a sentence where the answer would go, and offers 批准 and 拒绝 only", async () => {
    single.set("/api/me", {
      user: { id: "user-he", role: "user", email: "he@example.test" },
    });
    single.set("/api/channels/g-1", {
      channel: { id: "g-1", name: "产品研发组", agentIds: ["ext-codex", "a1"] },
    });
    inbox = [
      {
        id: "share-1",
        status: "pending",
        createdAt: "2026-11-15T08:02:00.000Z",
        action: {
          botId: "ext-codex",
          // The check's own name, as the server stores it: never shown.
          toolRef: ["xiongbao", "share_private_information"].join("/"),
          effect: "share_private",
          scope: "group:g-1:members:abc",
          threadId: "t-group-codex",
          toolCallId: "group-post:handoff:abc",
          args: {
            audience: "this group conversation",
            recipients: 2,
            contentDigest: "e7ce2fd2",
            preview: "修好了，已推送到 fix/build。",
          },
          target: { kind: "group", id: "g-1" },
        },
      },
    ];
    const view = openApproval("");
    const card = within(await view.findByRole("region", { name: "分享到群" }));
    expect(
      await card.findByText(
        "代码熊想把回答发到群「产品研发组」，里面可能有你的私人信息",
      ),
    ).toBeTruthy();
    expect(card.getByText("修好了，已推送到 fix/build。")).toBeTruthy();
    expect(
      card.getAllByRole("button").map((button) => button.textContent),
    ).toEqual(["批准", "拒绝"]);
    const text = view.container.textContent ?? "";
    for (const internal of [
      "share_private",
      "share private",
      "xiongbao/",
      "contentDigest",
      "{",
    ])
      expect(text).not.toContain(internal);
    const user = userEvent.setup({ document });
    await user.click(card.getByRole("button", { name: "批准" }));
    await waitFor(() =>
      expect(sent.find((request) => request.method === "POST")).toMatchObject({
        url: "/api/approvals/share-1/decision",
        body: { decision: "allow_once" },
      }),
    );
  });
});

describe("会话列表里群的最后发言人", () => {
  test("an external employee another member hired is named by the server, not called gone", () => {
    const group = {
      id: "g-1",
      name: "产品研发组",
      agentIds: ["ext-codex", "a1"],
      lastMessageAgentId: "ext-codex",
      lastMessageAgentName: "代码熊",
    } as never;
    // Not in the reader's own roster.
    expect(speakerOf(group, () => GONE_BOT)).toBe("代码熊");
    // In it: the roster's name wins.
    expect(speakerOf(group, () => "小码")).toBe("小码");
  });
});
