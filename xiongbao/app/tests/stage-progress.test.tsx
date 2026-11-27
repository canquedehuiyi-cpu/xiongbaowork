import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { EventType, type Message } from "@ag-ui/core";
import { CopilotKitProvider as ChatRuntimeProvider } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import type { VisibleChatItem } from "@/components/channels/chat-messages";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import {
  ToolActivity,
  type ToolGroup,
} from "@/components/channels/tool-activity";
import {
  createRunStageTracker,
  type RunStage,
  type RunStageTracker,
  stageWords,
} from "@/lib/channels/run-stage";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * 一轮走到哪一段，转录里有一行浅灰小字跟着说（段是从这一轮本来就有的事件里推出来的）。
 *
 * 这一组断言钉三件事：事件推得出段、同一段只在一处说话、推不出段时那一格不空着。
 * 「推不出」是常态而不是异常：这一轮之前存的对话、没走这条流的通道都推不出段，那时
 * 对话底下那一格必须还是它一直说的「思考中」/「<员工名> 正在输入」。
 *
 * 一段事件喂进来的方式与线上一致：实时的一轮、`connect` 重放的历史、半路接上的流都喂同一种
 * AG-UI 事件（`RUN_STARTED`／`TOOL_CALL_START`／`TOOL_CALL_RESULT`／`TEXT_MESSAGE_START`／
 * `RUN_FINISHED`），这里不另造一种只有测试才认识的事件。
 *
 * 两段话各说各的地方：「正在执行工具」由正在跑的那一行自己说（`ToolActivity`），
 * 「调用模型」沿用既有那一句，「正在输出回答」顶掉那一句——都不新添一行，所以一段里
 * 不会出现两句同样的话，也不会出现空着的一格。
 */

const originalFetch = globalThis.fetch;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  // 每一行都问「这个调用在主人在不在」，这里一条也不在。
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(String(input), "http://localhost/");
      if (url.pathname === "/api/approvals")
        return Response.json({
          enabled: false,
          requests: [],
          rules: [],
          teamRules: [],
          questions: [],
        });
      return Response.json({ error: "not served" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});

afterEach(() => {
  cleanup();
  queryClient.clear();
});

afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

/** 阶段带认得出的记号：画在哪儿都行，只此一处。 */
const BAND = "[data-run-stage]";

/* 追踪器：事件到段落的推导，画不画由它定的这一个值说了算。 */

/** 推段读的就是这两样（与 `run-stage.ts` 的 `StageEvent` 同一个口径，测试不引它的私有类型）。 */
type Fed = { type?: unknown; toolCallId?: unknown };

/** 造一条这一轮的事件：推段只认类型名和工具调用的号，别的字段一概不需要。 */
function event(type: EventType, toolCallId?: string): Fed {
  return toolCallId === undefined ? { type } : { type, toolCallId };
}

/** 把一串事件当一轮喂进来——实时、重放、半路接上都是这一个喂法。 */
function turn(tracker: RunStageTracker, events: Fed[]) {
  for (const one of events) tracker.feed(one);
}

test("a stage seen before the run begins is claimed when it does", () => {
  const tracker = createRunStageTracker();
  // 半路接上的流：先看到工具在跑，还没听到这一轮的开头，那一段先搁着，不冒充已经在跑。
  tracker.feed(event(EventType.TOOL_CALL_START, "s1"));
  expect(tracker.stage()).toBeNull();
  tracker.feed(event(EventType.RUN_STARTED));
  expect(tracker.stage()).toBe("tool");
  // 认领的那一段算这一轮的第一句，不是第二句。
  expect(tracker.seq()).toBe(1);
});

test("each new stage replaces the current one, and the end of the run clears it", () => {
  const tracker = createRunStageTracker();
  tracker.feed(event(EventType.RUN_STARTED));
  expect(tracker.stage()).toBe("model");
  tracker.feed(event(EventType.TOOL_CALL_START, "s1"));
  expect(tracker.stage()).toBe("tool");
  tracker.feed(event(EventType.TOOL_CALL_RESULT, "s1"));
  expect(tracker.stage()).toBe("model");
  tracker.feed(event(EventType.TEXT_MESSAGE_START));
  expect(tracker.stage()).toBe("answer");
  expect(tracker.seq()).toBe(4);
  // 一轮收尾：不许把这一轮的「正在执行工具」带给下一轮。
  tracker.feed(event(EventType.RUN_FINISHED));
  expect(tracker.stage()).toBeNull();
  expect(tracker.seq()).toBe(0);
  tracker.feed(event(EventType.RUN_STARTED));
  expect(tracker.stage()).toBe("model");
  expect(tracker.seq()).toBe(1);
});

test("an errored run clears the stage and does not carry its unfinished call over", () => {
  const tracker = createRunStageTracker();
  turn(tracker, [
    event(EventType.RUN_STARTED),
    event(EventType.TOOL_CALL_START, "s1"),
    event(EventType.RUN_ERROR),
  ]);
  expect(tracker.stage()).toBeNull();
  // 下一轮自己开的调用答完就交回模型：上一轮那个没答完的 s1 不许还算在飞，把这一轮扣在工具段里。
  turn(tracker, [
    event(EventType.RUN_STARTED),
    event(EventType.TOOL_CALL_START, "s2"),
    event(EventType.TOOL_CALL_RESULT, "s2"),
  ]);
  expect(tracker.stage()).toBe("model");
  // 新的轮次从第一条段数起，不接着上一轮往上涨。
  expect(tracker.seq()).toBe(3);
});

test("nothing else about the stream moves the stage", () => {
  const tracker = createRunStageTracker();
  tracker.feed(event(EventType.RUN_STARTED));
  tracker.feed(event(EventType.TOOL_CALL_START, "s1"));
  // 工具参数与结束、消息内容、状态事件、别家的 CUSTOM、认不出的类型：都改不了这一段。
  turn(tracker, [
    event(EventType.TOOL_CALL_ARGS, "s1"),
    event(EventType.TOOL_CALL_END, "s1"),
    event(EventType.TEXT_MESSAGE_CONTENT),
    event(EventType.TEXT_MESSAGE_END),
    event(EventType.STATE_DELTA),
    event(EventType.CUSTOM),
    { type: "TOOL_CALL_STARTED" },
    { toolCallId: "s1" },
    {},
  ]);
  expect(tracker.stage()).toBe("tool");
  expect(tracker.seq()).toBe(2);
});

test("only a real change of stage tells the transcript to draw again", () => {
  const tracker = createRunStageTracker();
  let heard = 0;
  const stop = tracker.listen(() => {
    heard += 1;
  });
  tracker.feed(event(EventType.RUN_STARTED));
  tracker.feed(event(EventType.TOOL_CALL_START, "s1"));
  // 同一段里再开一个工具调用不是新事实：一次重画都不许多。
  tracker.feed(event(EventType.TOOL_CALL_START, "s2"));
  // 还有一个调用在飞：这一步答完不算交回模型，那一格不许改口。
  tracker.feed(event(EventType.TOOL_CALL_RESULT, "s1"));
  expect(heard).toBe(2);
  tracker.feed(event(EventType.TOOL_CALL_RESULT, "s2"));
  expect(heard).toBe(3);
  expect(tracker.seq()).toBe(3);
  stop();
  tracker.feed(event(EventType.TEXT_MESSAGE_START));
  expect(heard).toBe(3);
});

test("a turn replayed from the thread lands where that turn really is", () => {
  // 存档里一轮是一次跑完的：喂到收尾，那一格整个撤掉，不留一行说它还在做。
  const done = createRunStageTracker();
  turn(done, [
    event(EventType.RUN_STARTED),
    event(EventType.TEXT_MESSAGE_START),
    event(EventType.TEXT_MESSAGE_CONTENT),
    event(EventType.TEXT_MESSAGE_END),
    event(EventType.TOOL_CALL_START, "s1"),
    event(EventType.TOOL_CALL_ARGS, "s1"),
    event(EventType.TOOL_CALL_END, "s1"),
    event(EventType.TOOL_CALL_RESULT, "s1"),
    event(EventType.TEXT_MESSAGE_START),
    event(EventType.RUN_FINISHED),
  ]);
  expect(done.stage()).toBeNull();
  // 只重放到当下：最后一条事件说的是什么段，那一格就说什么。
  const now = createRunStageTracker();
  turn(now, [
    event(EventType.RUN_STARTED),
    event(EventType.TOOL_CALL_START, "s1"),
    event(EventType.TOOL_CALL_RESULT, "s1"),
    event(EventType.TOOL_CALL_START, "s2"),
  ]);
  expect(now.stage()).toBe("tool");
  // 重放到这里说过四条段：等模型、执行工具、又等模型、又执行工具。
  expect(now.seq()).toBe(4);
});

test("the subscriber handlers derive the stage from the events they are handed", () => {
  const { subscriber, stage } = createRunStageTracker();
  // 对话页把这些回调交给 `agent.subscribe`，事件由 AG-UI 递过来：这里照同一个形状喂，推法只有一条。
  subscriber.onRunStartedEvent?.({ event: event(EventType.RUN_STARTED) });
  expect(stage()).toBe("model");
  subscriber.onToolCallStartEvent?.({
    event: event(EventType.TOOL_CALL_START, "s1"),
  });
  expect(stage()).toBe("tool");
  subscriber.onToolCallResultEvent?.({
    event: event(EventType.TOOL_CALL_RESULT, "s1"),
  });
  subscriber.onTextMessageStartEvent?.({
    event: event(EventType.TEXT_MESSAGE_START),
  });
  expect(stage()).toBe("answer");
  // 出错收尾与正常收尾同一条路：那一格跟着撤掉。
  subscriber.onRunErrorEvent?.({ event: event(EventType.RUN_ERROR) });
  expect(stage()).toBeNull();
});

test("a tool event without a call id is never counted as still running", () => {
  const tracker = createRunStageTracker();
  // 光有开头，一步没走：等到模型手上，那一句还是「思考中」，这里不猜它在干什么。
  tracker.feed(event(EventType.RUN_STARTED));
  expect(tracker.stage()).toBe("model");
  expect(stageWords(tracker.stage())).toBeUndefined();
  // 工具事件没给调用号：这一格照样说「正在执行工具」，但不计在飞的那一步。
  tracker.feed(event(EventType.TOOL_CALL_START));
  expect(tracker.stage()).toBe("tool");
  // 于是它的答案按「没有在飞的调用」交回模型——读不出来的号不许把这一轮扣在工具段里。
  tracker.feed(event(EventType.TOOL_CALL_RESULT));
  expect(tracker.stage()).toBe("model");
});

test("the stage waiting on the model keeps the words it always had", () => {
  // 「调用模型」这一件事实，那一格一直用「思考中」说着：这里不给新话。
  expect(stageWords("model")).toBeUndefined();
  expect(stageWords("tool")).toBe("正在执行工具");
  expect(stageWords("answer")).toBe("正在输出回答");
  expect(stageWords(null)).toBeUndefined();
  expect(stageWords(undefined)).toBeUndefined();
});

/* `ToolActivity`：工具段说在正在跑的那一行上面。 */

type ToolItem = Extract<VisibleChatItem, { kind: "tool" }>;

function call(id: string, name: string, result?: string): ToolItem {
  return {
    kind: "tool",
    id,
    toolCall: {
      id,
      type: "function",
      function: { name, arguments: JSON.stringify({ page: 1 }) },
    },
    ...(result === undefined ? {} : { result }),
  };
}

/** 一次跑完的、一次还挂着的：正在跑的那一行要有的样子。 */
const STEPS: ToolItem[] = [
  call("s1", "mcp__composio-gmail__GMAIL_FETCH_EMAILS", '{"messages":[]}'),
  call("s2", "mcp__composio-gmail__GMAIL_FETCH_MESSAGE_BY_THREAD_ID"),
];

function activity(active: boolean, stage?: RunStage | null) {
  const group: ToolGroup = { id: "g", kind: "tools", steps: STEPS };
  return render(
    <QueryClientProvider client={queryClient}>
      <ToolActivity active={active} group={group} stage={stage} />
    </QueryClientProvider>,
  );
}

test("the row that is running says the tool stage", () => {
  const view = activity(true, "tool");
  const band = view.getByText("正在执行工具");
  // 是进度不是打断：读屏的人跟着听见这一行，和「思考中」那一格一样。
  expect(band.getAttribute("role")).toBe("status");
  // 折起来的那一行没被换掉，只是上面多了一行。
  expect(view.container.querySelector(".tool-line")).toBeTruthy();
});

test("no stage, another stage, or a row that stopped: no band", () => {
  for (const stage of [undefined, null, "model", "answer"] as const) {
    const view = activity(true, stage);
    expect(view.container.querySelector(BAND)).toBeNull();
    expect(view.queryByText("正在执行工具")).toBeNull();
    expect(view.container.querySelector(".tool-line")).toBeTruthy();
  }
  // 这一行不再是正在跑的那一行：即使阶段还留着「工具」也不再喊。
  const done = activity(false, "tool");
  expect(done.container.querySelector(BAND)).toBeNull();
});

/* 对话转录：那一段的话说在哪儿，推不出段时又说什么。 */

const EMAILS = '{"messages":[{"subject":"Quarterly numbers"}]}';

/** 一次 Gmail 调用，`result` 不给就是还挂着。 */
function step(n: number, tool: string, result?: string): Message[] {
  const id = `call-${n}`;
  return [
    {
      id: `a-${n}`,
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id,
          type: "function",
          function: {
            name: `mcp__composio-gmail__${tool}`,
            arguments: JSON.stringify({ page: n }),
          },
        },
      ],
    },
    ...(result === undefined
      ? []
      : [
          {
            id: `t-${n}`,
            role: "tool" as const,
            toolCallId: id,
            content: result,
          },
        ]),
  ];
}

/** 一次读了四封信、最后一次读 thread：answered 与否跟着 `lastAnswered`。 */
function run(lastAnswered: boolean): Message[] {
  return [
    { id: "u1", role: "user", content: "Summarize my recent unread emails." },
    ...step(1, "GMAIL_FETCH_EMAILS", EMAILS),
    ...step(
      2,
      "GMAIL_FETCH_MESSAGE_BY_THREAD_ID",
      lastAnswered ? EMAILS : undefined,
    ),
  ];
}

function transcript(messages: Message[], busy: boolean, stage?: RunStage) {
  return (
    <QueryClientProvider client={queryClient}>
      <ChatRuntimeProvider>
        <ChatTranscript
          busy={busy}
          messages={messages}
          restoring={false}
          stage={stage}
        />
      </ChatRuntimeProvider>
    </QueryClientProvider>
  );
}

test("a step still running says the tool stage, and that one slot stays quiet", async () => {
  const view = render(transcript(run(false), true, "tool"));
  expect(await view.findByText("正在执行工具")).toBeTruthy();
  // 工具段说在正在跑的那一行上，底下那一格不跟着再说一遍「思考中」。
  expect(view.queryByText("思考中")).toBeNull();

  // 每一步都答完了、模型在读它们：那一格回到它一直说的那句。
  view.rerender(transcript(run(true), true, "model"));
  expect(view.queryByText("正在执行工具")).toBeNull();
  expect(view.getByText("思考中")).toBeTruthy();
});

test("the answer stage replaces the words of that one slot", () => {
  const view = render(transcript(run(true), true, "answer"));
  expect(view.getByText("正在输出回答")).toBeTruthy();
  expect(view.queryByText("思考中")).toBeNull();
  // 一轮结束：这一格整个撤掉，不留一行说它还在做。
  view.rerender(transcript(run(true), false));
  expect(view.queryByText("正在输出回答")).toBeNull();
  expect(view.queryByText("思考中")).toBeNull();
});

test("a turn with no stage events reads exactly as it did before", () => {
  const view = render(transcript(run(true), true));
  // 回落的就是既有那一句：没有空出的一格，也没有新添的一行。
  expect(view.getByText("思考中").getAttribute("role")).toBe("status");
  expect(view.container.querySelector(BAND)).toBeNull();
});
