import { describe, expect, test } from "bun:test";
import { type BaseEvent, EventType } from "@ag-ui/client";
import type { BuiltInAgentConfiguration } from "@copilotkit/runtime/v2";
import { BuiltInAgentWithSaneHistory } from "@openbot/toolkit/copilotkit/agents";
import { parametersFor } from "@openbot/toolkit/granted-tool";
import {
  HeadlessToolsMiddleware,
  RUN_ENDED_EARLY,
} from "@openbot/toolkit/headless-tools";
import {
  acceptedDeliveryIndex,
  runErrorAfterDelivery,
  turnFailedByStream,
} from "../src/tasks/delivery-stream";

/**
 * 交付被接受之后才出现的运行错误不算这一轮失败（`tasks/delivery-stream.ts`，`postgres-runner` 的 `carriedFailure`
 * 用它）。前半是事件序列的判定，后半用 toolkit 真实的 headless 流形状：交付结果之后收尾段被停掉、交付之后模型报错。
 */

const DELIVERED = JSON.stringify({ delivered: true, taskId: "t1" });
const BOUNCED = JSON.stringify({ delivered: false, bounced: true });

const start = (id: string, name = "deliver_task") =>
  ({
    type: EventType.TOOL_CALL_START,
    toolCallId: id,
    toolCallName: name,
  }) as BaseEvent;
const result = (id: string, content: string) =>
  ({ type: EventType.TOOL_CALL_RESULT, toolCallId: id, content }) as BaseEvent;
const error = (message = "x") =>
  ({ type: EventType.RUN_ERROR, message, code: "C" }) as BaseEvent;
const text = () =>
  ({
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId: "m",
    delta: "hi",
  }) as BaseEvent;
const finished = () => ({ type: EventType.RUN_FINISHED }) as BaseEvent;

describe("turnFailedByStream: the sequences", () => {
  test("no error: not failed", () => {
    expect(turnFailedByStream([start("a"), result("a", DELIVERED)])).toBe(
      false,
    );
  });
  test("an error before any delivery: failed", () => {
    expect(
      turnFailedByStream([error(), start("a"), result("a", DELIVERED)]),
    ).toBe(true);
  });
  test("an error after a bounced delivery: failed", () => {
    expect(
      turnFailedByStream([start("a"), result("a", BOUNCED), error()]),
    ).toBe(true);
  });
  test("an error with no delivery at all: failed", () => {
    expect(turnFailedByStream([text(), error()])).toBe(true);
  });
  test("an accepted delivery, then the error: not failed", () => {
    const events = [start("a"), result("a", DELIVERED), error()];
    expect(turnFailedByStream(events)).toBe(false);
    expect(runErrorAfterDelivery(events)).toBe(true);
    expect(turnFailedByStream([...events, finished()])).toBe(false);
  });
  test("an accepted delivery, the error, then more model output or tool calls: still failed", () => {
    const delivered = [start("a"), result("a", DELIVERED), error()];
    expect(turnFailedByStream([...delivered, text()])).toBe(true);
    expect(turnFailedByStream([...delivered, start("b", "read")])).toBe(true);
  });
  test("the tool name comes from the start event, paired by call id", () => {
    // 同一个答复挂在别的工具名下不是交付；两个调用交错时按 id 配对。
    expect(
      acceptedDeliveryIndex([start("a", "read"), result("a", DELIVERED)]),
    ).toBe(-1);
    expect(
      acceptedDeliveryIndex([
        start("a"),
        start("b", "read"),
        result("b", DELIVERED),
        result("a", DELIVERED),
      ]),
    ).toBe(3);
  });
});

/** A scripted model: one step per entry; a step that is `"throw"` fails the model call. */
type Step = { calls: string[] } | "throw";
const usage = {
  inputTokens: {
    total: 1,
    noCache: 1,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
function model(steps: Step[]) {
  let index = 0;
  return {
    specificationVersion: "v3" as const,
    provider: "fake",
    modelId: "fake",
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error("stream only");
    },
    doStream: async () => {
      const step = steps[index++] ?? { calls: [] };
      if (step === "throw") throw new Error("provider 529 overloaded");
      const parts: unknown[] = [{ type: "stream-start", warnings: [] }];
      for (const [at, name] of step.calls.entries())
        parts.push({
          type: "tool-call",
          toolCallId: `c${index}-${at}`,
          toolName: name,
          input: "{}",
        });
      parts.push({
        type: "finish",
        finishReason: step.calls.length
          ? { unified: "tool-calls", raw: "tool_calls" }
          : { unified: "stop", raw: "stop" },
        usage,
      });
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
  };
}

async function stream(options: {
  steps: Step[];
  /** What `deliver_task` answers. */
  deliver: string;
  /** Deliver ends the turn (the server's `endsTurnAfter`) -- off, the model is asked once more. */
  endsTurn?: boolean;
  /** Stop the run (`abortRun`) when this many tool results have gone out. */
  abortAfterResults?: number;
}): Promise<BaseEvent[]> {
  const agent = new BuiltInAgentWithSaneHistory(
    {
      model: model(options.steps) as never,
      prompt: "Work.",
      maxSteps: 40,
      tools: [
        {
          name: "note",
          description: "n",
          parameters: parametersFor({
            type: "object",
            properties: {},
          } as never),
          execute: async () => "ok",
        },
      ],
    } as BuiltInAgentConfiguration,
    {
      observe: (r: never) => r,
      ...(options.endsTurn
        ? {
            endsTurnAfter: (name: string, answer: string) =>
              name === "deliver_task" && answer.includes('"delivered":true'),
          }
        : {}),
    } as never,
  );
  agent.use(
    new HeadlessToolsMiddleware(
      ["read", "deliver_task"].map((name) => ({
        definition: {
          name,
          description: name,
          parameters: { type: "object", properties: {} },
        } as never,
        execute: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return name === "deliver_task" ? options.deliver : { ok: true };
        },
      })),
      undefined,
      { maxSegments: 80 },
    ),
  );
  agent.threadId = "t";
  agent.setMessages([{ id: "a", role: "user", content: "go" }]);
  const events: BaseEvent[] = [];
  let results = 0;
  await agent
    .runAgent(
      {},
      {
        onEvent: ({ event }: { event: BaseEvent }) => {
          events.push(event);
          if (
            options.abortAfterResults &&
            event.type === EventType.TOOL_CALL_RESULT &&
            ++results === options.abortAfterResults
          )
            setTimeout(() => agent.abortRun(), 0);
        },
      },
    )
    .catch(() => undefined);
  return events;
}

describe("turnFailedByStream: the real headless stream", () => {
  test("stopped right after the delivery result: the error is the wrap-up's, not a failure", async () => {
    const events = await stream({
      steps: [{ calls: ["read"] }, { calls: ["deliver_task"] }],
      deliver: DELIVERED,
      endsTurn: true,
      abortAfterResults: 2,
    });
    const found = events.find((event) => event.type === EventType.RUN_ERROR) as
      | (BaseEvent & { message?: string })
      | undefined;
    expect(found?.message).toBe(RUN_ENDED_EARLY);
    expect(runErrorAfterDelivery(events)).toBe(true);
    expect(turnFailedByStream(events)).toBe(false);
  });

  test("the model fails on the call after an accepted delivery: not a failure", async () => {
    const events = await stream({
      steps: [{ calls: ["deliver_task"] }, "throw"],
      deliver: DELIVERED,
    });
    const found = events.find((event) => event.type === EventType.RUN_ERROR) as
      | (BaseEvent & { message?: string })
      | undefined;
    expect(found?.message).toBe("provider 529 overloaded");
    expect(turnFailedByStream(events)).toBe(false);
  });

  test("the model fails after a bounced delivery: a failure", async () => {
    const events = await stream({
      steps: [{ calls: ["deliver_task"] }, "throw"],
      deliver: BOUNCED,
    });
    expect(events.some((event) => event.type === EventType.RUN_ERROR)).toBe(
      true,
    );
    expect(turnFailedByStream(events)).toBe(true);
  });

  test("the model fails before any delivery: a failure", async () => {
    const events = await stream({
      steps: [{ calls: ["read"] }, "throw"],
      deliver: DELIVERED,
    });
    expect(turnFailedByStream(events)).toBe(true);
  });
});
