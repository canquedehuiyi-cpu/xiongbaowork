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
  matchByMark,
  matchToFlow,
  placeDeliveryEvent,
  readDeliveryEvent,
  sameJson,
} from "@/lib/tasks/delivery-chat";
import { useDeliveryChatEvents } from "@/lib/tasks/use-delivery-chat-events";
import { setSkin } from "@/skins/store";
import { DeliveryChatCard } from "@/skins/xiongbao/delivery-chat";
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
  events?: { id?: string; kind: string; createdAt: string; detail?: unknown }[];
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
/** 流水里的一行，和服务器记的一样（`server/src/tasks/delivery.ts`）。 */
let flowId = 0;
const flow = (
  kind: string,
  createdAt: string,
  detail: Record<string, unknown> = {},
) => ({
  id: `flow-${++flowId}`,
  actor: "agent:agent-zhou",
  kind,
  createdAt,
  detail,
});
/** jsonb 存进库会重排键：流水里的交付物，键的顺序和事件里的不一样。 */
const stored = (deliverable: unknown) =>
  JSON.parse(
    JSON.stringify(deliverable, (_key, value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).reverse())
        : value,
    ),
  );
const delivery = (event: ChatDeliveryEvent) =>
  event.kind === "delivered" ? event.deliverable : null;

test("事件认得出四种卡，字段不全的不画", () => {
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
});

test("卡按内容对回流水：交付物（不管键的顺序）、延期时间、预计时间；对不上为 -1", () => {
  const other = {
    kind: "deliverable",
    notes: ["补上了 C 家"],
    checks: ["核对过"],
  };
  const history = [
    flow("accepted", todayAt(9, 40), { dueAt: todayAt(10, 30) }),
    flow("delivered", todayAt(10, 40), { deliverable: stored(other) }),
    flow("returned", todayAt(10, 45), { reason: "缺 B 家" }),
    flow("delivered", todayAt(11, 10), {
      deliverable: stored(delivery(delivered)),
    }),
  ];
  expect(sameJson(stored(delivery(delivered)), delivery(delivered))).toBe(true);
  expect(matchToFlow(history, delivered)).toBe(3);
  expect(
    matchToFlow(history, {
      kind: "delivered",
      taskId: TASK,
      deliverable: other,
    }),
  ).toBe(1);
  expect(matchToFlow(history, accepted)).toBe(0);
  // 流水里没有这条申请（比如是别的活的）：对不上，不给按钮。
  expect(matchToFlow(history, extension)).toBe(-1);
  // 群回复上的标记按种类、预计时间和时刻对。
  expect(
    matchByMark(history, {
      kind: "delivered",
      taskId: TASK,
      at: new Date(Date.parse(todayAt(11, 10)) + 800).toISOString(),
      agentId: XIAOZHOU.id,
    }),
  ).toBe(3);
  expect(
    matchByMark(history, {
      kind: "delivered",
      taskId: TASK,
      at: todayAt(12, 30),
      agentId: XIAOZHOU.id,
    }),
  ).toBe(-1);
});

/*
 * Codex 审查（#641）P2：卡认流水那一行靠服务器带来的 `eventId`，不按内容、不按预计时间。
 */
test("接活前你改过预计时间：回执上的时间和流水「接下」记的不同，按 eventId 照样对上，给按钮", async () => {
  // 员工报 10:30（流水里记的），你接活前改成 11:00（回执事件带的是卡上生效的 11:00）。
  serve({
    card: card({ dueAt: todayAt(11, 0) }),
    events: [
      {
        id: "line-accepted",
        kind: "accepted",
        createdAt: todayAt(9, 40),
        detail: { dueAt: todayAt(10, 30) },
      },
    ],
  });
  const view = withQueries(
    <DeliveryChatCard
      agentName="小周"
      event={{ ...accepted, dueAt: todayAt(11, 0), eventId: "line-accepted" }}
    />,
  );
  const receipt = await view.findByRole("group", { name: "接活回执" });
  expect(
    await within(receipt).findByRole("button", { name: "改预计时间" }),
  ).toBeTruthy();
  // 没有 id 的老事件：也不再比预计时间，取最后一行「接下」。
  expect(
    matchToFlow(
      [flow("accepted", todayAt(9, 40), { dueAt: todayAt(10, 30) })],
      { ...accepted, dueAt: todayAt(11, 0) },
    ),
  ).toBe(0);
});

test("群里的标记带 eventId：派活人按它对回流水，不比预计时间", () => {
  const history = [
    flow("accepted", todayAt(9, 40), { dueAt: todayAt(10, 30) }),
    flow("delivered", todayAt(10, 40), { deliverable: {} }),
  ];
  const line = history[0]?.id as string;
  expect(
    matchByMark(history, {
      kind: "accepted",
      taskId: TASK,
      // 标记记的是卡上生效的（你改过的）时间，记录时刻也差了好几分钟。
      dueAt: todayAt(11, 0),
      at: todayAt(9, 50),
      agentId: XIAOZHOU.id,
      eventId: line,
    }),
  ).toBe(0);
  // 老标记没有 id：只按种类和时刻，同样不比预计时间。
  expect(
    matchByMark(history, {
      kind: "accepted",
      taskId: TASK,
      dueAt: todayAt(11, 0),
      at: todayAt(9, 41),
      agentId: XIAOZHOU.id,
    }),
  ).toBe(0);
});

test("退回后原样再交一次：两张卡各对各的流水行，只有新的一张给按钮", async () => {
  const same = { ...delivered };
  const first = { ...same, eventId: "line-first" };
  const second = { ...same, eventId: "line-second" };
  // 回放时同一张卡来两次只记一次；内容相同、id 不同的两次交付是两张卡。
  const placed = placeDeliveryEvent(
    placeDeliveryEvent(placeDeliveryEvent([], "a1", first), "a1", first),
    "a2",
    second,
  );
  expect(placed.map((entry) => entry.event)).toEqual([first, second]);

  const events = [
    {
      id: "line-first",
      kind: "delivered",
      createdAt: todayAt(10, 40),
      detail: { deliverable: stored(delivery(delivered)) },
    },
    {
      id: "line-returned",
      kind: "returned",
      createdAt: todayAt(10, 45),
      detail: { reason: "缺 B 家" },
    },
    {
      id: "line-second",
      kind: "delivered",
      createdAt: todayAt(11, 10),
      detail: { deliverable: stored(delivery(delivered)) },
    },
  ];
  serve({
    card: card({ status: "awaiting_review", stage: "delivered" }),
    events,
  });
  const view = withQueries(
    <>
      <DeliveryChatCard agentName="小周" event={first} />
      <DeliveryChatCard agentName="小周" event={second} />
    </>,
  );
  await waitFor(() =>
    expect(view.getAllByRole("group", { name: "交付卡" })).toHaveLength(2),
  );
  const [old, latest] = view.getAllByRole("group", { name: "交付卡" });
  if (!old || !latest) throw new Error("两张交付卡没画出来");
  await within(latest).findByRole("button", { name: "验收" });
  // 旧的那张是被退回的那次：写结果，不给按钮。
  await within(old).findByText(/退回了/);
  expect(within(old).queryAllByRole("button")).toHaveLength(0);
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

test("挡回原因念给你听：不带字段名和工具名，员工叫「它」，引号里的名字照原样", () => {
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
    bounceText("附件「你的报告.xlsx」不是你在这件活里做出来的文件，交不了。"),
  ).toBe("附件「你的报告.xlsx」不是它在这件活里做出来的文件，交不了");
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

test("接活回执：预计时间、验收标准；「改验收标准」发 PATCH，「改预计时间」按改预计时间说并发 PATCH", async () => {
  const calls = serve({
    events: [flow("accepted", todayAt(9, 40), { dueAt: todayAt(10, 30) })],
  });
  const view = withQueries(
    <DeliveryChatCard agentName="小周" event={accepted} />,
  );
  const receipt = await view.findByRole("group", { name: "接活回执" });
  await within(receipt).findByRole("button", { name: "改预计时间" });
  expect(receipt.textContent).toContain("竞品价格表更新 · 预计 10:30 交");
  expect(receipt.textContent).toContain(
    "验收标准：三家全部在售款，带本周和上周价格，降价的标红。",
  );
  await userEvent.click(
    within(receipt).getByRole("button", { name: "改验收标准" }),
  );
  let dialog = await view.findByRole("dialog");
  await userEvent.type(
    within(dialog).getByRole("textbox", { name: "验收标准" }),
    "必需：A、B、C",
  );
  await userEvent.click(
    within(dialog).getByRole("button", { name: "改验收标准" }),
  );
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());

  await userEvent.click(
    within(receipt).getByRole("button", { name: "改预计时间" }),
  );
  dialog = await view.findByRole("dialog");
  expect(
    within(dialog).getByRole("heading", {
      name: "改「竞品价格表更新」的预计时间",
    }),
  ).toBeTruthy();
  const field = await within(dialog).findByRole("textbox", {
    name: "改到几点",
  });
  await userEvent.type(field, "16:00");
  await userEvent.click(
    await within(dialog).findByRole("button", { name: "改预计时间" }),
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
      { method: "PATCH", path: `/api/tasks/${TASK}`, body: { dueAt: "16:00" } },
    ]),
  );
});

test("接活回执：成果已交或已验收时不给「改预计时间」「改验收标准」", async () => {
  for (const [status, said] of [
    ["awaiting_review", "成果已经交了，等你验收"],
    ["done", "这件活已经验收了"],
  ] as const) {
    serve({
      card: card({ status }),
      events: [flow("accepted", todayAt(9, 40), { dueAt: todayAt(10, 30) })],
    });
    const view = withQueries(
      <DeliveryChatCard agentName="小周" event={accepted} />,
    );
    const receipt = await view.findByRole("group", { name: "接活回执" });
    await within(receipt).findByText(said);
    expect(within(receipt).queryAllByRole("button")).toHaveLength(0);
    cleanup();
  }
});

test("验收了、取消了的卡不再隔一会儿重读；还在做的照常重读", async () => {
  for (const [status, polls] of [
    ["running", true],
    ["done", false],
    ["cancelled", false],
  ] as const) {
    serve({
      card: card({ status }),
      events: [flow("accepted", todayAt(9, 40), { dueAt: todayAt(10, 30) })],
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const view = render(
      <QueryClientProvider client={queryClient}>
        <DeliveryChatCard agentName="小周" event={accepted} />
      </QueryClientProvider>,
    );
    await view.findByRole("group", { name: "接活回执" });
    await waitFor(() =>
      expect(
        queryClient.getQueryData(["tasks", "card", TASK, "events"]),
      ).toBeDefined(),
    );
    // 卡片和流水两个查询，各自的观察者此刻要不要定时重读。
    for (const key of [
      ["tasks", "card", TASK],
      ["tasks", "card", TASK, "events"],
    ]) {
      const query = queryClient
        .getQueryCache()
        .find({ queryKey: key, exact: true });
      const observer = query?.observers[0];
      expect(observer).toBeDefined();
      const interval = observer?.options.refetchInterval;
      const value =
        typeof interval === "function" ? interval(query as never) : interval;
      expect(Boolean(value)).toBe(polls);
    }
    cleanup();
  }
});

test("延期申请：「准许」带上卡上写的时间，「不准」维持原时间；答复后按钮收起", async () => {
  const calls = serve({
    events: [
      flow("accepted", todayAt(9, 40), { dueAt: todayAt(10, 30) }),
      flow("extension_requested", todayAt(10, 20), {
        dueAt: todayAt(11, 30),
        reason: "C 家官网改版了，抓不到旧价格",
      }),
    ],
  });
  const view = withQueries(
    <DeliveryChatCard agentName="小周" event={extension} />,
  );
  const ask = await view.findByRole("group", { name: "延期申请" });
  await within(ask).findByRole("button", { name: "准许" });
  expect(ask.textContent).toContain("申请延期 · 10:30 → 11:30");
  expect(ask.textContent).toContain("原因：C 家官网改版了，抓不到旧价格");
  expect(ask.textContent).toContain("原来的预计时间还算数，你准了才改。");
  await userEvent.click(within(ask).getByRole("button", { name: "准许" }));
  await within(ask).findByText("已答复");
  // 流水还没重读回来，按钮已经收起，不会连点出第二个请求。
  expect(within(ask).queryAllByRole("button")).toHaveLength(0);
  expect(writes(calls)).toEqual([
    {
      method: "POST",
      path: `/api/tasks/${TASK}/extension`,
      body: {
        decision: "grant",
        dueAt: todayAt(11, 30),
        requestedDueAt: todayAt(11, 30),
      },
    },
  ]);
});

test("延期申请：「不准」发 deny", async () => {
  const calls = serve({
    events: [
      flow("extension_requested", todayAt(10, 20), {
        dueAt: todayAt(11, 30),
        reason: "C 家官网改版了，抓不到旧价格",
      }),
    ],
  });
  const view = withQueries(
    <DeliveryChatCard agentName="小周" event={extension} />,
  );
  const ask = await view.findByRole("group", { name: "延期申请" });
  await userEvent.click(
    await within(ask).findByRole("button", { name: "不准" }),
  );
  await waitFor(() =>
    expect(writes(calls)).toEqual([
      {
        method: "POST",
        path: `/api/tasks/${TASK}/extension`,
        body: { decision: "deny", requestedDueAt: todayAt(11, 30) },
      },
    ]),
  );
});

test("两张延期卡：旧卡（准过了）不给按钮，只有新卡能准，准的是新卡上的时间", async () => {
  const later: ChatDeliveryEvent = {
    kind: "extension_requested",
    taskId: TASK,
    dueAt: todayAt(14, 0),
    reason: "B 家也改版了",
  };
  const calls = serve({
    card: card({ dueAt: todayAt(11, 30) }),
    events: [
      flow("extension_requested", todayAt(10, 20), {
        dueAt: todayAt(11, 30),
        reason:
          extension.kind === "extension_requested" ? extension.reason : "",
      }),
      flow("extension_granted", todayAt(10, 22), { dueAt: todayAt(11, 30) }),
      flow("extension_requested", todayAt(11, 20), {
        dueAt: todayAt(14, 0),
        reason: "B 家也改版了",
      }),
    ],
  });
  // 转录只回放到第一张（回放被截断）：它不会冒充最新那条申请。
  const only = withQueries(
    <DeliveryChatCard agentName="小周" event={extension} />,
  );
  const first = await only.findByRole("group", { name: "延期申请" });
  await within(first).findByText("你 10:22 准许了，延到 11:30");
  expect(within(first).queryAllByRole("button")).toHaveLength(0);
  cleanup();

  const both = withQueries(
    <div>
      <DeliveryChatCard agentName="小周" event={extension} />
      <DeliveryChatCard agentName="小周" event={later} />
    </div>,
  );
  const [older, newer] = await both.findAllByRole("group", {
    name: "延期申请",
  });
  if (!older || !newer) throw new Error("两张延期卡都该在");
  await userEvent.click(
    await within(newer).findByRole("button", { name: "准许" }),
  );
  expect(within(older).queryAllByRole("button")).toHaveLength(0);
  await waitFor(() =>
    expect(writes(calls)).toEqual([
      {
        method: "POST",
        path: `/api/tasks/${TASK}/extension`,
        body: {
          decision: "grant",
          dueAt: todayAt(14, 0),
          requestedDueAt: todayAt(14, 0),
        },
      },
    ]),
  );
});

test("员工后来又申请了一次：服务器 409，卡上说这条申请已经不是最新的了", async () => {
  serve({
    events: [
      flow("extension_requested", todayAt(10, 20), {
        dueAt: todayAt(11, 30),
        reason: "C 家官网改版了，抓不到旧价格",
      }),
    ],
  });
  const served = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
    init?.method === "POST"
      ? new Response(
          JSON.stringify({
            error:
              "员工后来又申请了一次延期，这条申请已经不是最新的了，刷新看看。",
            code: "stale_request",
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        )
      : served(input, init)) as typeof fetch;
  const view = withQueries(
    <DeliveryChatCard agentName="小周" event={extension} />,
  );
  const ask = await view.findByRole("group", { name: "延期申请" });
  await userEvent.click(
    await within(ask).findByRole("button", { name: "准许" }),
  );
  expect((await within(ask).findByRole("alert")).textContent).toBe(
    "这条延期申请已经不是最新的了：员工后来又申请了一次，刷新看看。",
  );
});

test("延期申请：成果已经交了时先不用答复，不给按钮", async () => {
  serve({
    card: card({ status: "awaiting_review", stage: "delivered" }),
    events: [
      flow("extension_requested", todayAt(10, 20), {
        dueAt: todayAt(11, 30),
        reason: "C 家官网改版了，抓不到旧价格",
      }),
      flow("delivered", todayAt(10, 50), {
        deliverable: stored(delivery(delivered)),
      }),
    ],
  });
  const view = withQueries(
    <DeliveryChatCard agentName="小周" event={extension} />,
  );
  const ask = await view.findByRole("group", { name: "延期申请" });
  await within(ask).findByText("成果已经交了，这条申请先不用答复");
  expect(within(ask).queryAllByRole("button")).toHaveLength(0);
});

test("交付卡：交付物和自查，「验收」发验收，「退回」要写原因", async () => {
  const calls = serve({
    card: card({ status: "awaiting_review", stage: "delivered" }),
    events: [
      flow("delivered", todayAt(11, 20), {
        deliverable: stored(delivery(delivered)),
      }),
    ],
  });
  const view = withQueries(
    <DeliveryChatCard agentName="小周" event={delivered} />,
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
    expect(writes(calls).at(-1)).toMatchObject({
      method: "POST",
      path: `/api/tasks/${TASK}/review`,
    }),
  );
});

test("已验收的交付卡写「你 10:52 验收了」，不给按钮，也不发请求", async () => {
  const calls = serve({
    card: card({ status: "done", stage: "reviewed" }),
    events: [
      flow("delivered", todayAt(10, 40), {
        deliverable: stored(delivery(delivered)),
      }),
      flow("reviewed", todayAt(10, 52)),
    ],
  });
  const view = withQueries(
    <DeliveryChatCard agentName="小周" event={delivered} />,
  );
  const handIn = await view.findByRole("group", { name: "交付卡" });
  await within(handIn).findByText("你 10:52 验收了");
  expect(handIn.textContent).not.toContain("等你验收");
  expect(within(handIn).queryAllByRole("button")).toHaveLength(0);
  expect(writes(calls)).toEqual([]);
});

test("退回后又交了一次：旧交付卡写退回的结果，按钮只在新的那张上；只回放到旧卡时也不给按钮", async () => {
  const second: ChatDeliveryEvent = {
    kind: "delivered",
    taskId: TASK,
    deliverable: { kind: "deliverable", notes: ["补上了"], checks: ["核对过"] },
  };
  serve({
    card: card({ status: "awaiting_review", stage: "delivered", returns: 1 }),
    events: [
      flow("delivered", todayAt(10, 40), {
        deliverable: stored(delivery(delivered)),
      }),
      flow("returned", todayAt(10, 45), { reason: "B 家漏了两款新品" }),
      flow("delivered", todayAt(11, 10), {
        deliverable: stored(delivery(second)),
      }),
    ],
  });
  const only = withQueries(
    <DeliveryChatCard agentName="小周" event={delivered} />,
  );
  const lone = await only.findByRole("group", { name: "交付卡" });
  await within(lone).findByText("你 10:45 退回了：B 家漏了两款新品");
  expect(within(lone).queryAllByRole("button")).toHaveLength(0);
  cleanup();

  const view = withQueries(
    <div>
      <DeliveryChatCard agentName="小周" event={delivered} />
      <DeliveryChatCard agentName="小周" event={second} />
    </div>,
  );
  const [older, newer] = await view.findAllByRole("group", { name: "交付卡" });
  if (!older || !newer) throw new Error("两张交付卡都该在");
  await within(older).findByText("你 10:45 退回了：B 家漏了两款新品");
  expect(within(older).queryAllByRole("button")).toHaveLength(0);
  await within(newer).findByRole("button", { name: "验收" });
  within(newer).getByRole("button", { name: "退回" });
});

test("流水里对不上的交付卡不给按钮", async () => {
  serve({
    card: card({ status: "awaiting_review", stage: "delivered" }),
    events: [
      flow("delivered", todayAt(11, 10), {
        deliverable: { kind: "deliverable", notes: ["别的东西"] },
      }),
    ],
  });
  const view = withQueries(
    <DeliveryChatCard agentName="小周" event={delivered} />,
  );
  const handIn = await view.findByRole("group", { name: "交付卡" });
  await settleReactWork();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(handIn.textContent).toContain("竞品价格表-第46周.xlsx");
  expect(within(handIn).queryAllByRole("button")).toHaveLength(0);
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
    />,
  );
  const line = view.getByRole("note");
  expect(line.textContent).toBe(
    "小周想交付 · 被挡回：只有文字结论时，至少写一条它怎么查过的，比如核对了哪些数据、跑了什么测试，已让它补齐",
  );
  expect(line.textContent).not.toContain("checks");
});

/** 群回复上的标记（`server/src/channels/group.ts`）：只有状态，没有内容。 */
const MARK_AT = {
  accepted: todayAt(9, 40),
  bounced: todayAt(11, 18),
  delivered: todayAt(11, 20),
};

function groupConversation() {
  const reply = (
    id: string,
    text: string,
    createdAt: string,
    delivery: Record<string, unknown>[],
  ) => ({
    id,
    channelId: "chan-1",
    ownerUserId: ME.id,
    agentId: XIAOZHOU.id,
    text,
    status: "completed",
    createdAt,
    delivery,
  });
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
      reply("m2", "好的，接下了。", MARK_AT.accepted, [
        {
          kind: "accepted",
          taskId: TASK,
          at: MARK_AT.accepted,
          agentId: XIAOZHOU.id,
          dueAt: todayAt(10, 30),
        },
      ]),
      reply("m3", "做好了，请验收。", MARK_AT.delivered, [
        {
          kind: "bounced",
          taskId: TASK,
          at: MARK_AT.bounced,
          agentId: XIAOZHOU.id,
        },
        {
          kind: "delivered",
          taskId: TASK,
          at: MARK_AT.delivered,
          agentId: XIAOZHOU.id,
        },
      ]),
    ],
  };
}

/** 派活人读到的流水：内容都在这里。 */
const GROUP_FLOW = [
  flow("accepted", MARK_AT.accepted, {
    dueAt: todayAt(10, 30),
    criteria: "三家全部在售款。",
  }),
  flow("bounced", MARK_AT.bounced, {
    reason: "验收标准里的必需项没对上：缺 C 家。",
  }),
  flow("delivered", MARK_AT.delivered, {
    deliverable: stored(delivery(delivered)),
  }),
];

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

test("群聊里派活的人按标记读卡片和流水，看到完整的卡和按钮", async () => {
  serve({
    me: ME,
    card: card({ status: "awaiting_review", stage: "delivered" }),
    events: GROUP_FLOW,
    group: groupConversation(),
  });
  const view = renderGroup();
  const handIn = await view.findByRole("group", { name: "交付卡" });
  await within(handIn).findByRole("button", { name: "验收" });
  within(handIn).getByRole("button", { name: "退回" });
  expect(handIn.textContent).toContain("竞品价格表-第46周.xlsx");
  expect(handIn.textContent).toContain(
    "自查：三家 142 款都在；降价 9 款已标红",
  );
  const receipt = view.getByRole("group", { name: "接活回执" });
  expect(receipt.textContent).toContain("预计 10:30 交");
  // 验收标准以卡上此刻的为准（派活人可能改过）。
  expect(receipt.textContent).toContain(
    "验收标准：三家全部在售款，带本周和上周价格，降价的标红。",
  );
  expect(view.getByRole("note").textContent).toContain(
    "小周想交付 · 被挡回：验收标准里的必需项没对上：缺 C 家，已让它补齐",
  );
});

test("群聊里不是派活的人只看到状态行：没有内容、没有按钮，也不去读这张卡", async () => {
  const calls = serve({
    me: TEAMMATE,
    group: groupConversation(),
  });
  const view = renderGroup();
  await view.findByText("小周已交成果，等我验收");
  const lines = view.getAllByRole("note").map((line) => line.textContent);
  expect(lines).toEqual([
    "小周已接下，预计 10:30 交",
    "小周的交付被挡回了",
    "小周已交成果，等我验收",
  ]);
  await settleReactWork();
  expect(view.queryAllByRole("group")).toHaveLength(0);
  const page = view.container.textContent ?? "";
  for (const secret of ["竞品价格表", "自查", "验收标准", "缺 C 家"])
    expect(page).not.toContain(secret);
  expect(calls.some((call) => call.path.startsWith("/api/tasks/"))).toBe(false);
});

test("群里看不到的员工（别人私有的）叫「一位员工」，不说它不在群里", async () => {
  serve({
    me: TEAMMATE,
    group: { ...groupConversation(), bots: [] },
  });
  const view = renderGroup();
  await view.findByText("一位员工已接下，预计 10:30 交");
  expect(view.container.textContent).not.toContain("不在本群");
  expect(view.getAllByText("一位员工").length).toBeGreaterThan(0);
});
