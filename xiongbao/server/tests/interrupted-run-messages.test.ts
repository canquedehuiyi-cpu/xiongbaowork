import { expect, test } from "bun:test";
import {
  AbstractAgent,
  type BaseEvent,
  defaultApplyEvents,
  EventType,
  type Message,
} from "@ag-ui/client";
import { EMPTY, from } from "rxjs";
import { messagesAfter } from "../src/recovery/interrupted-runs";

/*
 * A turn the process died in leaves the thread's messages rebuilt from its stored events. The client
 * has a reducer for that, and it is too slow to run over a long turn (it clones the messages on every
 * event), so the sweep has its own, one pass. Here they are held to the same answer.
 */

class Idle extends AbstractAgent {
  run() {
    return EMPTY;
  }
}

async function clients(prior: Message[], events: BaseEvent[]) {
  const agent = new Idle({ initialMessages: structuredClone(prior) });
  const input = {
    threadId: "t",
    runId: "r",
    messages: structuredClone(prior),
    state: {},
    tools: [],
    context: [],
    forwardedProps: {},
  };
  let messages: Message[] = prior;
  await new Promise<void>((resolve, reject) =>
    defaultApplyEvents(input, from(events), agent, []).subscribe({
      next: (change) => {
        if (change.messages) messages = change.messages;
      },
      complete: () => resolve(),
      error: reject,
    }),
  );
  return messages;
}

const e = (event: Record<string, unknown>) => event as unknown as BaseEvent;

test("the messages of a turn are what the client's own reducer makes of its events", async () => {
  const prior = [
    { id: "u0", role: "user", content: "hi" },
    { id: "a0", role: "assistant", content: "hello" },
  ] as Message[];
  const events = [
    e({
      type: EventType.RUN_STARTED,
      threadId: "t",
      runId: "r",
      input: {
        threadId: "t",
        runId: "r",
        messages: [
          { id: "u0", role: "user", content: "hi" },
          { id: "u1", role: "user", content: "do it" },
        ],
        state: {},
        tools: [],
        context: [],
        forwardedProps: {},
      },
    }),
    e({ type: EventType.REASONING_START, messageId: "think" }),
    e({
      type: EventType.REASONING_MESSAGE_START,
      messageId: "think",
      role: "reasoning",
    }),
    e({
      type: EventType.REASONING_MESSAGE_CONTENT,
      messageId: "think",
      delta: "let me ",
    }),
    e({
      type: EventType.REASONING_MESSAGE_CONTENT,
      messageId: "think",
      delta: "see",
    }),
    e({ type: EventType.REASONING_MESSAGE_END, messageId: "think" }),
    e({ type: EventType.REASONING_END, messageId: "think" }),
    e({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "m1",
      role: "assistant",
    }),
    e({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "Run" }),
    e({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "ning" }),
    e({ type: EventType.TEXT_MESSAGE_END, messageId: "m1" }),
    e({
      type: EventType.TOOL_CALL_START,
      toolCallId: "c1",
      toolCallName: "computer_run_command",
      parentMessageId: "m1",
    }),
    e({ type: EventType.TOOL_CALL_ARGS, toolCallId: "c1", delta: '{"co' }),
    e({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "c1",
      delta: 'mmand":"ls"}',
    }),
    e({ type: EventType.TOOL_CALL_END, toolCallId: "c1" }),
    e({
      type: EventType.TOOL_CALL_RESULT,
      messageId: "r1",
      toolCallId: "c1",
      role: "tool",
      content: '{"ok":true}',
    }),
    e({
      type: EventType.TOOL_CALL_START,
      toolCallId: "c2",
      toolCallName: "computer_read",
    }),
    e({ type: EventType.TOOL_CALL_ARGS, toolCallId: "c2", delta: "{}" }),
    e({ type: EventType.TOOL_CALL_END, toolCallId: "c2" }),
    e({
      type: EventType.TOOL_CALL_RESULT,
      messageId: "r2",
      toolCallId: "c2",
      role: "tool",
      content: "interrupted",
    }),
    e({ type: EventType.RUN_FINISHED, threadId: "t", runId: "r" }),
  ];
  expect(messagesAfter(prior, events)).toEqual(await clients(prior, events));
});

test("a turn of twenty thousand events is read in a moment", () => {
  const events: BaseEvent[] = [];
  for (let n = 0; n < 5000; n += 1)
    events.push(
      e({
        type: EventType.TOOL_CALL_START,
        toolCallId: `c${n}`,
        toolCallName: "computer_run_command",
      }),
      e({ type: EventType.TOOL_CALL_ARGS, toolCallId: `c${n}`, delta: "{}" }),
      e({ type: EventType.TOOL_CALL_END, toolCallId: `c${n}` }),
      e({
        type: EventType.TOOL_CALL_RESULT,
        messageId: `r${n}`,
        toolCallId: `c${n}`,
        role: "tool",
        content: "ok",
      }),
    );
  const started = Date.now();
  const messages = messagesAfter([], events);
  expect(messages).toHaveLength(10_000);
  expect(Date.now() - started).toBeLessThan(2_000);
});
