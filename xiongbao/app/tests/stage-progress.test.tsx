import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
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
  type RunStage,
  createRunStageTracker,
  stageWords,
} from "@/lib/channels/run-stage";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * 一轮走到哪一段，转录里有一行浅灰小字跟着说（`run.stage`）。
 *
 * 这一组断言钉三件事：阶段事件认得出、同一段只在一处说话、收不到事件时那一格不空着。
 * 「收不到」是常态而不是异常：阶段标记之前存的对话、没走这条流的通道都读不到它，那时
 * 对话底下那一格必须还是它一直说的「思考中」/「<员工名> 正在输入」。
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

/* 追踪器：事件到段落的翻译，画不画由它定的这一个值说了算。 */

test("a mark that arrives before any run is claimed by the next run", () => {
  const tracker = createRunStageTracker();
  // 服务器把「调用模型」标在 RUN_STARTED 之后，所以这条一般是半路接上的流才见得到：先搁着，不冒充哪一段。
  tracker.take("run.stage", { seq: 1, stage: "model" });
  expect(tracker.stage()).toBeNull();
  tracker.started();
  expect(tracker.stage()).toBe("model");
});

test("each new mark replaces the stage, and the end of the run clears it", () => {
  const tracker = createRunStageTracker();
  tracker.started();
  tracker.take("run.stage", { seq: 2, stage: "tool" });
  expect(tracker.stage()).toBe("tool");
  tracker.take("run.stage", { seq: 3, stage: "answer" });
  expect(tracker.stage()).toBe("answer");
  // 一轮收尾：不许把这一轮的「正在执行工具」带给下一轮。
  tracker.ended();
  expect(tracker.stage()).toBeNull();
  tracker.started();
  expect(tracker.stage()).toBeNull();
});

test("nothing else about the stream moves the stage", () => {
  const tracker = createRunStageTracker();
  tracker.started();
  tracker.take("run.stage", { seq: 2, stage: "tool" });
  // 别的 CUSTOM 事件、枚举里没有的段、不是对象的值：都改不了这一段。
  tracker.take("acp.plan", { stage: "answer" });
  tracker.take("run.stage", { stage: "thinking-hard" });
  tracker.take("run.stage", "tool");
  tracker.take("run.stage", undefined);
  expect(tracker.stage()).toBe("tool");
});

test("only a real change of stage tells the transcript to draw again", () => {
  const tracker = createRunStageTracker();
  let heard = 0;
  const stop = tracker.listen(() => {
    heard += 1;
  });
  tracker.started();
  tracker.take("run.stage", { seq: 2, stage: "tool" });
  // 同一段再报一次（seq 变了）不是新事实：一次重画都不许多。
  tracker.take("run.stage", { seq: 3, stage: "tool" });
  expect(heard).toBe(1);
  stop();
  tracker.take("run.stage", { seq: 4, stage: "answer" });
  expect(heard).toBe(1);
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

/* 对话转录：那一段的话说在哪儿，收不到事件时又说什么。 */

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
      <CopilotKitProvider>
        <ChatTranscript
          busy={busy}
          messages={messages}
          restoring={false}
          stage={stage}
        />
      </CopilotKitProvider>
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
