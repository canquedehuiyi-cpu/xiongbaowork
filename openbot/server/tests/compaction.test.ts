import { describe, expect, test } from "bun:test";
import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type Message,
  type RunAgentInput,
} from "@ag-ui/client";
import { Observable } from "rxjs";
import {
  applyCompaction,
  COMPACTION_DONE_EVENT,
  COMPACTION_INSTRUCTION,
  COMPACTION_KEEP_LAST,
  COMPACTION_SUMMARY_MESSAGE_ID,
  CompactionMiddleware,
  compactionCut,
  shouldAutoCompact,
  summaryAsContext,
} from "../src/threads/compaction";
import {
  COMPACTION_SUMMARY_CONTEXT,
  promptShares,
  runContextSections,
} from "../src/threads/context-usage";

/*
 * 压缩会话的纯逻辑：摘要怎样替换较早的消息、什么时候自动压缩、摘要怎样送到内置员工的模型面前（系统行在
 * 内置员工那里会被丢掉，所以改放进 context）、分类统计把摘要算作消息，以及运行流里的提示事件。
 * 读写数据库与真跑一轮的部分在 compaction.integration.test.ts。
 */

const say = (index: number): Message =>
  index % 2 === 0
    ? { id: `m${index}`, role: "user", content: `第 ${index} 条：用户说的话` }
    : {
        id: `m${index}`,
        role: "assistant",
        content: `第 ${index} 条：员工的回答`,
      };

const history = (count: number) =>
  Array.from({ length: count }, (_, index) => say(index));

describe("applyCompaction", () => {
  test("replaces everything up to the covered message with one system message", () => {
    const messages = history(20);
    const applied = applyCompaction(messages, {
      uptoMessageId: "m9",
      summary: "用户决定用方案 B。",
    });
    expect(applied).toHaveLength(11);
    expect(applied[0]).toEqual({
      id: COMPACTION_SUMMARY_MESSAGE_ID,
      role: "system",
      content: "早前对话摘要：用户决定用方案 B。",
    });
    expect(applied.slice(1).map((message) => message.id)).toEqual(
      messages.slice(10).map((message) => message.id),
    );
    // 原数组不动：线程里的消息照常留着。
    expect(messages).toHaveLength(20);
  });

  test("no record, or a record whose message is not in this history, changes nothing", () => {
    const messages = history(5);
    expect(applyCompaction(messages, null)).toBe(messages);
    expect(
      applyCompaction(messages, { uptoMessageId: "elsewhere", summary: "x" }),
    ).toBe(messages);
  });
});

describe("compactionCut", () => {
  test(`keeps the last ${COMPACTION_KEEP_LAST} and never starts the kept part with a tool result`, () => {
    const messages = history(25);
    expect(compactionCut(messages)).toBe(15);
    expect(compactionCut(history(COMPACTION_KEEP_LAST))).toBe(0);
    // 第 15 条是工具结果：它的调用在第 14 条，两条一起留下。
    const withTool: Message[] = history(25).map((message, index) =>
      index === 14
        ? {
            id: message.id,
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "call-1",
                type: "function",
                function: { name: "lookup", arguments: "{}" },
              },
            ],
          }
        : index === 15
          ? {
              id: message.id,
              role: "tool",
              toolCallId: "call-1",
              content: "结果",
            }
          : message,
    );
    expect(compactionCut(withTool)).toBe(14);
  });
});

describe("shouldAutoCompact", () => {
  test("used >= limit - reserve (10%) and a known limit", () => {
    expect(shouldAutoCompact({ used: 90_000, limit: 100_000 })).toBe(true);
    expect(shouldAutoCompact({ used: 89_999, limit: 100_000 })).toBe(false);
    expect(shouldAutoCompact({ used: 120_000, limit: 100_000 })).toBe(true);
  });

  test("no limit or no usage → never", () => {
    expect(shouldAutoCompact({ used: 10_000_000, limit: null })).toBe(false);
    expect(shouldAutoCompact({ used: null, limit: 100_000 })).toBe(false);
  });
});

describe("the summary reaches a built-in model as context, counted as messages", () => {
  test("summaryAsContext moves the summary row into context and replaces an older one", () => {
    const input = {
      threadId: "t",
      runId: "r",
      state: {},
      tools: [],
      forwardedProps: {},
      messages: applyCompaction(history(20), {
        uptoMessageId: "m9",
        summary: "用户决定用方案 B。",
      }),
      context: [
        { description: "page", value: "首页" },
        { description: COMPACTION_SUMMARY_CONTEXT, value: "旧摘要" },
      ],
    } satisfies RunAgentInput;
    const moved = summaryAsContext(input);
    expect(moved.messages.map((message) => message.id)).toEqual(
      history(20)
        .slice(10)
        .map((message) => message.id),
    );
    expect(moved.context).toHaveLength(2);
    expect(moved.context[0]).toEqual({ description: "page", value: "首页" });
    expect(moved.context[1]?.description).toBe(COMPACTION_SUMMARY_CONTEXT);
    expect(moved.context[1]?.value).toContain(
      "早前对话摘要：用户决定用方案 B。",
    );
    // 没有摘要行时原样返回（审批续跑带着上次的摘要 context，不能丢）。
    const plain = { ...input, messages: history(3) };
    expect(summaryAsContext(plain)).toBe(plain);
  });

  test("the breakdown recorder counts the summary under messages", () => {
    const summary = "早前对话摘要：".padEnd(400, "要");
    const sections = runContextSections({
      configuration: { prompt: "你是助理。" },
      input: {
        messages: [{ id: "u", role: "user", content: "你好" }],
        context: [{ description: COMPACTION_SUMMARY_CONTEXT, value: summary }],
        state: {},
        tools: [],
      },
    });
    const shares = promptShares(sections);
    const messageChars = sections
      .filter((section) => section.key === "messages")
      .reduce((acc, section) => acc + section.chars, 0);
    expect(messageChars).toBe(summary.length + 2);
    expect(shares.messages).toBeGreaterThan(0.9);
    expect(shares.system).toBeLessThan(0.1);
  });
});

test("the summary instruction keeps decisions, open work, facts and names; drops chatter, repeats and reversals", () => {
  for (const kept of ["决定", "约定", "未完成", "事实", "数字", "文件", "链接"])
    expect(COMPACTION_INSTRUCTION).toContain(kept);
  for (const dropped of ["寒暄", "重复", "推翻"])
    expect(COMPACTION_INSTRUCTION).toContain(dropped);
});

/** 一个只回放给定事件的 agent。 */
class Scripted extends AbstractAgent {
  seen: RunAgentInput | undefined;
  constructor(private readonly events: BaseEvent[]) {
    super({ agentId: "scripted" });
  }
  run(input: RunAgentInput): Observable<BaseEvent> {
    this.seen = input;
    return new Observable((subscriber) => {
      for (const event of this.events) subscriber.next(event);
      subscriber.complete();
    });
  }
}

const runEvents = (threadId: string, runId: string): BaseEvent[] => [
  { type: EventType.RUN_STARTED, threadId, runId } as BaseEvent,
  {
    type: EventType.TEXT_MESSAGE_START,
    messageId: "a",
    role: "assistant",
  } as BaseEvent,
  {
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId: "a",
    delta: "好",
  } as BaseEvent,
  { type: EventType.TEXT_MESSAGE_END, messageId: "a" } as BaseEvent,
  { type: EventType.RUN_FINISHED, threadId, runId } as BaseEvent,
];

describe("CompactionMiddleware", () => {
  test("a notice goes out once, right after RUN_STARTED, and the prepared input is what runs", async () => {
    const agent = new Scripted(runEvents("t", "r"));
    agent.use(
      new CompactionMiddleware("bot", async (_agentId, input) => ({
        input: { ...input, messages: input.messages.slice(-1) },
        notice: {
          type: EventType.CUSTOM,
          name: COMPACTION_DONE_EVENT,
          value: { auto: true, compactionId: "c1" },
        } as BaseEvent,
      })),
    );
    agent.addMessage({ id: "u1", role: "user", content: "一" });
    agent.addMessage({ id: "u2", role: "user", content: "二" });
    const events: BaseEvent[] = [];
    await agent.runAgent(
      { runId: "r" },
      { onEvent: ({ event }) => void events.push(event) },
    );
    const types = events.map((event) => event.type);
    expect(types[0]).toBe(EventType.RUN_STARTED);
    expect(types[1]).toBe(EventType.CUSTOM);
    expect(types.filter((type) => type === EventType.CUSTOM)).toHaveLength(1);
    expect(events[1]).toMatchObject({
      name: COMPACTION_DONE_EVENT,
      value: { auto: true, compactionId: "c1" },
    });
    expect(agent.seen?.messages.map((message) => message.id)).toEqual(["u2"]);
  });

  test("a preparation that throws runs the turn as it came", async () => {
    const agent = new Scripted(runEvents("t", "r"));
    agent.use(
      new CompactionMiddleware("bot", async () => {
        throw new Error("boom");
      }),
    );
    agent.addMessage({ id: "u1", role: "user", content: "一" });
    const events: BaseEvent[] = [];
    const errors = console.error;
    console.error = () => {};
    try {
      await agent.runAgent(
        { runId: "r" },
        { onEvent: ({ event }) => void events.push(event) },
      );
    } finally {
      console.error = errors;
    }
    expect(agent.seen?.messages.map((message) => message.id)).toEqual(["u1"]);
    expect(events.map((event) => event.type)).toContain(EventType.RUN_FINISHED);
    expect(events.map((event) => event.type)).not.toContain(EventType.CUSTOM);
  });
});
