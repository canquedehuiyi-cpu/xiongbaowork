import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type RunAgentInput,
} from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import {
  act,
  cleanup,
  render,
  renderHook,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { Observable } from "rxjs";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { GroupChat } from "@/components/channels/group-chat";
import {
  bounceText,
  type ChatDeliveryEvent,
  lastMessageIdAfter,
  placeDeliveryEvent,
  positionsFromEnd,
  readDeliveryEvent,
} from "@/lib/tasks/delivery-chat";
import { useDeliveryChatEvents } from "@/lib/tasks/use-delivery-chat-events";
import { setSkin } from "@/skins/store";
import {
  DeliveryChatCard,
  deliveryNotes,
} from "@/skins/xiongbao/delivery-chat";
import { settleReactWork } from "./settle-react-work";

/**
 * 交付闭环第三期 Task 9（规格第 4、6 节，设计稿 3）：对话里的接活回执、延期申请、交付卡和被挡回的一行灰字。
 * 卡上的按钮调第 8 项的接口；只有派活的人看得到按钮；卡片此刻已经结束的只写结果，不给按钮、不发请求。
 * 只换掉 fetch。
 */
let registeredHere = false;
const originalFetch = globalThis.fetch;

beforeAll(() => {
  if (!("document" in globalThis)) {
    GlobalRegistrator.register({ url: "http://localhost/" });
    registeredHere = true;
  }
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  setSkin("xiongbao");
});

afterAll(async () => {
  if (!registeredHere) return;
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const NOW = new Date();
/** 今天本地时间的某一刻。 */
const todayAt = (hours: number, minutes: number) => {
  const at = new Date(NOW);
  at.setHours(hours, minutes, 0, 0);
  return at.toISOString();
};

const ME = { id: "user-me", email: "me@example.test", name: "我" };
const TEAMMATE = { id: "user-mate", email: "mate@example.test", name: "同事" };
const TASK = "11111111-1111-4111-8111-111111111111";
const XIAOZHOU = { id: "agent-zhou", name: "小周", avatarSeed: "zhou" };

const card = (over: Record<string, unknown> = {}) => ({
  id: TASK,
  tenantId: ME.id,
  title: "竞品价格表更新",
  executorAgentId: XIAOZHOU.id,
  source: "chat",
  status: "running",
  tracked: true,
  stage: "accepted",
  acceptedAt: todayAt(9, 40),
  dueAt: todayAt(10, 30),
  originalDueAt: todayAt(10, 30),
  dueReported: true,
  criteria: "三家全部在售款，带本周和上周价格，降价的标红。",
  overdueAt: null,
  lastError: null,
  nudges: 0,
  returns: 0,
  deliverableRef: null,
  createdAt: todayAt(9, 38),
  updatedAt: todayAt(9, 40),
  ...over,
});

type Call = { method: string; path: string; body: unknown };

function serve(routes: {
  me?: typeof ME;
  card?: Record<string, unknown> | null;
  events?: { kind: string; createdAt: string; detail?: unknown }[];
  group?: unknown;
}): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, "");
    const method = init?.method ?? "GET";
    calls.push({
      method,
      path,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
        status,
      });
    if (path === "/api/me") return json({ user: routes.me ?? ME });
    if (method === "GET" && path === `/api/tasks/${TASK}`)
      return routes.card === null
        ? json({ error: "not found" }, 404)
        : json({ task: routes.card ?? card() });
    if (method === "GET" && path === `/api/tasks/${TASK}/events`)
      return json({
        events: (routes.events ?? []).map((event, index) => ({
          id: `e${index}`,
          actor: "user:user-me",
          detail: null,
          ...event,
        })),
      });
    if (method !== "GET") return json({ ok: true });
    if (path.startsWith("/api/groups/")) return json(routes.group);
    if (path.startsWith("/api/agents")) return json({ agents: [XIAOZHOU] });
    if (path.startsWith("/api/approvals"))
      return json({ requests: [], questions: [], approvals: [] });
    if (path.startsWith("/api/waker-groups")) return json({ groups: [] });
    if (path.startsWith("/api/group-pipelines")) return json({ templates: [] });
    return json({});
  }) as typeof fetch;
  return calls;
}

function withQueries(node: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>,
  );
}

const writes = (calls: Call[]) => calls.filter((call) => call.method !== "GET");

const accepted: ChatDeliveryEvent = {
  kind: "accepted",
  taskId: TASK,
  dueAt: todayAt(10, 30),
  criteria: "三家全部在售款，带本周和上周价格，降价的标红。",
};
const extension: ChatDeliveryEvent = {
  kind: "extension_requested",
  taskId: TASK,
  dueAt: todayAt(11, 30),
  reason: "C 家官网改版了，抓不到旧价格",
};
const delivered: ChatDeliveryEvent = {
  kind: "delivered",
  taskId: TASK,
  deliverable: {
    kind: "deliverable",
    links: [
      {
        url: "https://docs.example.test/price-46",
        title: "竞品价格表-第46周.xlsx",
      },
    ],
    checks: ["三家 142 款都在", "降价 9 款已标红"],
  },
};

test("事件认得出四种卡，字段不全的不画；同类卡按倒数第几张对回流水", () => {
  expect(
    readDeliveryEvent("delivery.accepted", {
      taskId: TASK,
      dueAt: "2026-11-15T02:30:00.000Z",
      criteria: "三家",
    }),
  ).toEqual({
    kind: "accepted",
    taskId: TASK,
    dueAt: "2026-11-15T02:30:00.000Z",
    criteria: "三家",
  });
  expect(readDeliveryEvent("delivery.delivered", {})).toBeNull();
  expect(
    readDeliveryEvent("delivery.extension_decided", { taskId: TASK }),
  ).toBeNull();
  expect(readDeliveryEvent("xiongbao.compaction.done", {})).toBeNull();
  expect(
    readDeliveryEvent("delivery.extension_requested", {
      taskId: TASK,
      dueAt: "不是时间",
      reason: "x",
    }),
  ).toBeNull();
  // 交付、退回、再交付：前一张交付卡是倒数第 1 张，后一张是 0；接活回执自己数。
  expect(positionsFromEnd([accepted, delivered, delivered])).toEqual([0, 1, 0]);
});

test("卡画在它出现时最后那条消息下面；回放重复的只记一次", () => {
  let last: string | null = null;
  for (const event of [
    { type: "RUN_STARTED", input: { messages: [{ id: "u1" }] } },
    { type: "TEXT_MESSAGE_START", messageId: "a1" },
    { type: "TOOL_CALL_START", toolCallId: "t1", parentMessageId: "a1" },
    { type: "TOOL_CALL_ARGS", toolCallId: "t1", delta: "{}" },
  ])
    last = lastMessageIdAfter(last, event);
  expect(last).toBe("a1");
  // 外部员工的回执在一轮开头，还没有回复：画在你刚说的那句话下面。
  expect(
    lastMessageIdAfter("a0", {
      type: "RUN_STARTED",
      input: { messages: [{ id: "u2" }] },
    }),
  ).toBe("u2");
  const once = placeDeliveryEvent([], "a1", accepted);
  expect(placeDeliveryEvent(once, "u1", accepted)).toBe(once);
  expect(once).toHaveLength(1);
  expect(once[0]?.anchor).toBe("a1");
});

/** 员工这一轮：说一句、调接活、服务器放回执卡、工具答复、再说一句。连上对话时原样回放。 */
class Employee extends AbstractAgent {
  constructor() {
    super({ agentId: "zhou", threadId: "thread-1" });
  }
  private turn(input: RunAgentInput): BaseEvent[] {
    const ids = { threadId: input.threadId, runId: "run-1" };
    return [
      {
        type: EventType.RUN_STARTED,
        ...ids,
        input: {
          ...input,
          messages: [{ id: "u1", role: "user", content: "整理价格表" }],
        },
      },
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "a1",
        role: "assistant",
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "a1",
        delta: "好的，我接下了。",
      },
      { type: EventType.TEXT_MESSAGE_END, messageId: "a1" },
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "t1",
        toolCallName: "accept_task",
        parentMessageId: "a1",
      },
      { type: EventType.TOOL_CALL_ARGS, toolCallId: "t1", delta: "{}" },
      { type: EventType.TOOL_CALL_END, toolCallId: "t1" },
      {
        type: EventType.CUSTOM,
        name: "delivery.accepted",
        value: { taskId: TASK, dueAt: todayAt(10, 30), criteria: "三家" },
      },
      {
        type: EventType.TOOL_CALL_RESULT,
        toolCallId: "t1",
        messageId: "r1",
        content: "{}",
      },
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "a2",
        role: "assistant",
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "a2",
        delta: "10:30 前交。",
      },
      { type: EventType.TEXT_MESSAGE_END, messageId: "a2" },
      { type: EventType.RUN_FINISHED, ...ids },
    ] as BaseEvent[];
  }
  run(input: RunAgentInput): Observable<BaseEvent> {
    const events = this.turn(input);
    return new Observable<BaseEvent>((subscriber) => {
      for (const event of events) subscriber.next(event);
      subscriber.complete();
    });
  }
  protected override connect(input: RunAgentInput): Observable<BaseEvent> {
    return this.run(input);
  }
}

test("这一轮里的回执卡画在调接活的那条回复下面；连上对话时回放的同一张卡不重复", async () => {
  const agent = new Employee();
  const { result } = renderHook(() => useDeliveryChatEvents(agent, "thread-1"));
  await act(async () => {
    await agent.runAgent();
  });
  expect(
    result.current.map(({ anchor, event }) => ({ anchor, event })),
  ).toEqual([
    {
      anchor: "a1",
      event: {
        kind: "accepted",
        taskId: TASK,
        dueAt: todayAt(10, 30),
        criteria: "三家",
      },
    },
  ]);
  // 回放真的又送来了这张卡。
  let replayed = 0;
  const counting = agent.subscribe({
    onCustomEvent: () => {
      replayed += 1;
    },
  });
  await act(async () => {
    await agent.connectAgent();
  });
  counting.unsubscribe();
  expect(replayed).toBe(1);
  expect(result.current).toHaveLength(1);
  expect(result.current[0]?.anchor).toBe("a1");
});

test("挡回原因念给你听：不带字段名和工具名，员工叫「它」", () => {
  expect(
    bounceText(
      "只有文字结论时，至少写一条你怎么查过的（checks），比如核对了哪些数据、跑了什么测试。",
    ),
  ).toBe(
    "只有文字结论时，至少写一条它怎么查过的，比如核对了哪些数据、跑了什么测试",
  );
  expect(
    bounceText(
      "验收标准里的必需项没对上：缺 C 家。在交付物标题或自查里逐一写到再交。",
    ),
  ).toBe("验收标准里的必需项没对上：缺 C 家");
  expect(
    bounceText("附件「report.xlsx」不是你在这件活里做出来的文件，交不了。"),
  ).toBe("附件「report.xlsx」不是它在这件活里做出来的文件，交不了");
  expect(bounceText("items[0].ref is not a valid attachment_id")).toBe(
    "交的东西没过核对",
  );
});

test("转录把卡画在锚定那一行下面，没有锚点的画在最后", () => {
  const messages = [
    { id: "u1", role: "user", content: "把竞品价格整理成表" },
    { id: "a1", role: "assistant", content: "好的，我接下了。" },
    { id: "u2", role: "user", content: "C 家也要" },
    { id: "a2", role: "assistant", content: "收到。" },
  ] as Message[];
  const view = render(
    <ChatTranscript
      messages={messages}
      notes={[
        { key: "n1", anchor: "a1", node: <p>卡一</p> },
        { key: "n2", anchor: null, node: <p>卡二</p> },
      ]}
      restoring={false}
    />,
  );
  const text = view.container.textContent ?? "";
  expect(text.indexOf("好的，我接下了。")).toBeLessThan(text.indexOf("卡一"));
  expect(text.indexOf("卡一")).toBeLessThan(text.indexOf("C 家也要"));
  expect(text.indexOf("收到。")).toBeLessThan(text.indexOf("卡二"));
});

test("接活回执：预计时间、验收标准，「改验收标准」发 PATCH", async () => {
  const calls = serve({});
  const view = withQueries(
    <DeliveryChatCard agentName="小周" event={accepted} fromEnd={0} />,
  );
  const receipt = await view.findByRole("group", { name: "接活回执" });
  await within(receipt).findByText(/竞品价格表更新/);
  expect(receipt.textContent).toContain("已接下");
  expect(receipt.textContent).toContain("预计 10:30 交");
  expect(receipt.textContent).toContain(
    "验收标准：三家全部在售款，带本周和上周价格，降价的标红。",
  );
  within(receipt).getByRole("button", { name: "改预计时间" });
  await userEvent.click(
    within(receipt).getByRole("button", { name: "改验收标准" }),
  );
  const dialog = await view.findByRole("dialog");
  const field = within(dialog).getByRole("textbox", { name: "验收标准" });
  await userEvent.type(field, "必需：A、B、C");
  await userEvent.click(
    within(dialog).getByRole("button", { name: "改验收标准" }),
  );
  await waitFor(() =>
    expect(writes(calls)).toEqual([
      {
        method: "PATCH",
        path: `/api/tasks/${TASK}`,
        body: {
          criteria:
            "三家全部在售款，带本周和上周价格，降价的标红。必需：A、B、C",
        },
      },
    ]),
  );
});

test("延期申请：「准许」照员工要的时间准，「不准」维持原时间", async () => {
  const events = [
    { kind: "accepted", createdAt: todayAt(9, 40) },
    {
      kind: "extension_requested",
      createdAt: todayAt(10, 20),
      detail: { dueAt: todayAt(11, 30) },
    },
  ];
  const calls = serve({ events });
  const view = withQueries(
    <DeliveryChatCard agentName="小周" event={extension} fromEnd={0} />,
  );
  const ask = await view.findByRole("group", { name: "延期申请" });
  await within(ask).findByRole("button", { name: "准许" });
  expect(ask.textContent).toContain("申请延期 · 10:30 → 11:30");
  expect(ask.textContent).toContain("原因：C 家官网改版了，抓不到旧价格");
  expect(ask.textContent).toContain("原来的预计时间还算数，你准了才改。");
  await userEvent.click(within(ask).getByRole("button", { name: "准许" }));
  await userEvent.click(within(ask).getByRole("button", { name: "不准" }));
  await waitFor(() =>
    expect(writes(calls)).toEqual([
      {
        method: "POST",
        path: `/api/tasks/${TASK}/extension`,
        body: { decision: "grant" },
      },
      {
        method: "POST",
        path: `/api/tasks/${TASK}/extension`,
        body: { decision: "deny" },
      },
    ]),
  );
});

test("已经答复过的延期申请只写结果，不给按钮", async () => {
  const calls = serve({
    card: card({ dueAt: todayAt(11, 30) }),
    events: [
      {
        kind: "extension_requested",
        createdAt: todayAt(10, 20),
        detail: { dueAt: todayAt(11, 30) },
      },
      {
        kind: "extension_granted",
        createdAt: todayAt(10, 22),
        detail: { dueAt: todayAt(11, 30) },
      },
    ],
  });
  const view = withQueries(
    <DeliveryChatCard agentName="小周" event={extension} fromEnd={0} />,
  );
  const ask = await view.findByRole("group", { name: "延期申请" });
  await within(ask).findByText("你 10:22 准许了，延到 11:30");
  expect(within(ask).queryAllByRole("button")).toHaveLength(0);
  expect(writes(calls)).toEqual([]);
});

test("交付卡：交付物和自查，「验收」发验收，「退回」要写原因", async () => {
  const calls = serve({
    card: card({ status: "awaiting_review", stage: "delivered" }),
    events: [{ kind: "delivered", createdAt: todayAt(11, 20) }],
  });
  const view = withQueries(
    <DeliveryChatCard agentName="小周" event={delivered} fromEnd={0} />,
  );
  const handIn = await view.findByRole("group", { name: "交付卡" });
  await within(handIn).findByRole("button", { name: "验收" });
  expect(handIn.textContent).toContain("已交成果 · 等你验收");
  expect(
    within(handIn)
      .getByRole("link", { name: "竞品价格表-第46周.xlsx" })
      .getAttribute("href"),
  ).toBe("https://docs.example.test/price-46");
  expect(handIn.textContent).toContain(
    "自查：三家 142 款都在；降价 9 款已标红",
  );

  await userEvent.click(within(handIn).getByRole("button", { name: "退回" }));
  const dialog = await view.findByRole("dialog");
  const submit = within(dialog).getByRole("button", { name: "退回给员工" });
  expect(submit.hasAttribute("disabled")).toBe(true);
  await userEvent.type(
    within(dialog).getByRole("textbox", { name: "退回原因" }),
    "B 家漏了两款新品，补上再交。",
  );
  expect(submit.hasAttribute("disabled")).toBe(false);
  await userEvent.click(submit);
  await waitFor(() =>
    expect(writes(calls)).toEqual([
      {
        method: "POST",
        path: `/api/tasks/${TASK}/return`,
        body: { reason: "B 家漏了两款新品，补上再交。" },
      },
    ]),
  );

  await userEvent.click(within(handIn).getByRole("button", { name: "验收" }));
  await waitFor(() =>
    expect(writes(calls).at(-1)).toEqual({
      method: "POST",
      path: `/api/tasks/${TASK}/review`,
      body: undefined,
    }),
  );
});

test("已验收的交付卡写「你 10:52 验收了」，不给按钮，也不发请求", async () => {
  const calls = serve({
    card: card({ status: "done", stage: "reviewed" }),
    events: [
      { kind: "delivered", createdAt: todayAt(10, 40) },
      { kind: "reviewed", createdAt: todayAt(10, 52) },
    ],
  });
  const view = withQueries(
    <DeliveryChatCard agentName="小周" event={delivered} fromEnd={0} />,
  );
  const handIn = await view.findByRole("group", { name: "交付卡" });
  await within(handIn).findByText("你 10:52 验收了");
  expect(handIn.textContent).not.toContain("等你验收");
  expect(within(handIn).queryAllByRole("button")).toHaveLength(0);
  expect(writes(calls)).toEqual([]);
});

test("退回后又交了一次：前一张交付卡写退回的结果，按钮只在最新那张上", async () => {
  serve({
    card: card({ status: "awaiting_review", stage: "delivered", returns: 1 }),
    events: [
      { kind: "delivered", createdAt: todayAt(10, 40) },
      {
        kind: "returned",
        createdAt: todayAt(10, 45),
        detail: { reason: "B 家漏了两款新品" },
      },
      { kind: "delivered", createdAt: todayAt(11, 10) },
    ],
  });
  const notes = deliveryNotes(
    [
      { key: "d1", anchor: "a1", event: delivered },
      {
        key: "d2",
        anchor: "a2",
        event: {
          ...delivered,
          deliverable: {
            kind: "deliverable",
            notes: ["补上了"],
            checks: ["核对过"],
          },
        },
      },
    ],
    "小周",
  );
  const view = withQueries(
    <div>
      {notes.map((note) => (
        <div key={note.key}>{note.node}</div>
      ))}
    </div>,
  );
  const [older, newer] = await view.findAllByRole("group", { name: "交付卡" });
  if (!older || !newer) throw new Error("两张交付卡都该在");
  await within(older).findByText("你 10:45 退回了：B 家漏了两款新品");
  expect(within(older).queryAllByRole("button")).toHaveLength(0);
  await within(newer).findByRole("button", { name: "验收" });
  within(newer).getByRole("button", { name: "退回" });
});

test("被挡回是一行灰字，说清缺什么，不出现字段名", () => {
  serve({});
  const view = withQueries(
    <DeliveryChatCard
      agentName="小周"
      event={{
        kind: "bounced",
        taskId: TASK,
        reason:
          "只有文字结论时，至少写一条你怎么查过的（checks），比如核对了哪些数据、跑了什么测试。",
      }}
      fromEnd={0}
    />,
  );
  const line = view.getByRole("note");
  expect(line.textContent).toBe(
    "小周想交付 · 被挡回：只有文字结论时，至少写一条它怎么查过的，比如核对了哪些数据、跑了什么测试，已让它补齐",
  );
  expect(line.textContent).not.toContain("checks");
});

function groupConversation() {
  return {
    bots: [{ id: XIAOZHOU.id, name: XIAOZHOU.name }],
    people: [
      { userId: ME.id, email: ME.email, name: ME.name },
      { userId: TEAMMATE.id, email: TEAMMATE.email, name: TEAMMATE.name },
    ],
    messages: [
      {
        id: "m1",
        channelId: "chan-1",
        ownerUserId: ME.id,
        agentId: null,
        text: "@小周 把竞品价格整理成表",
        status: "completed",
        createdAt: todayAt(9, 38),
      },
      {
        id: "m2",
        channelId: "chan-1",
        ownerUserId: ME.id,
        agentId: XIAOZHOU.id,
        text: "好的，接下了。",
        status: "completed",
        createdAt: todayAt(9, 40),
        delivery: [
          {
            name: "delivery.accepted",
            value: {
              taskId: TASK,
              dueAt: todayAt(10, 30),
              criteria: "三家全部在售款。",
            },
          },
        ],
      },
      {
        id: "m3",
        channelId: "chan-1",
        ownerUserId: ME.id,
        agentId: XIAOZHOU.id,
        text: "做好了，请验收。",
        status: "completed",
        createdAt: todayAt(11, 20),
        delivery: [
          {
            name: "delivery.bounced",
            value: {
              taskId: TASK,
              reason: "验收标准里的必需项没对上：缺 C 家。",
            },
          },
          { name: "delivery.delivered", value: delivered },
        ],
      },
    ],
  };
}

function renderGroup() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rootRoute = createRootRoute({
    component: () => <GroupChat channelId="chan-1" />,
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

test("群聊里派活的人看到卡和按钮", async () => {
  serve({
    me: ME,
    card: card({ status: "awaiting_review", stage: "delivered" }),
    events: [{ kind: "delivered", createdAt: todayAt(11, 20) }],
    group: groupConversation(),
  });
  const view = renderGroup();
  const handIn = await view.findByRole("group", { name: "交付卡" });
  await within(handIn).findByRole("button", { name: "验收" });
  within(handIn).getByRole("button", { name: "退回" });
  const receipt = view.getByRole("group", { name: "接活回执" });
  expect(receipt.textContent).toContain("预计 10:30 交");
  expect(view.getByRole("note").textContent).toContain(
    "小周想交付 · 被挡回：验收标准里的必需项没对上：缺 C 家，已让它补齐",
  );
});

test("群聊里不是派活的人看得到卡，没有按钮，也不去读这张卡", async () => {
  const calls = serve({
    me: TEAMMATE,
    group: groupConversation(),
  });
  const view = renderGroup();
  const handIn = await view.findByRole("group", { name: "交付卡" });
  expect(handIn.textContent).toContain("竞品价格表-第46周.xlsx");
  expect(handIn.textContent).toContain(
    "自查：三家 142 款都在；降价 9 款已标红",
  );
  const receipt = view.getByRole("group", { name: "接活回执" });
  expect(receipt.textContent).toContain("验收标准：三家全部在售款。");
  await settleReactWork();
  expect(within(handIn).queryAllByRole("button")).toHaveLength(0);
  expect(within(receipt).queryAllByRole("button")).toHaveLength(0);
  expect(calls.some((call) => call.path.startsWith("/api/tasks/"))).toBe(false);
});
