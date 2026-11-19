import { describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/client";
import { answersOnLastStep, startRun } from "../src/copilotkit/last-step";
import {
  reasoningByToolCall,
  withReplayedReasoning,
} from "../src/copilotkit/replayed-reasoning";

/*
 * 期三：DeepSeek 的思考模式要求调过工具的那一步的思考，之后每一轮都原样带回。运行时把对话发给模型时会丢掉
 * `reasoning` 消息，所以按工具调用 id 记下来、每一步放回 prompt。
 */

const call = (id: string) => ({
  id,
  type: "function" as const,
  function: { name: "lookup", arguments: "{}" },
});

const history = [
  { id: "u1", role: "user", content: "查 ENG-1" },
  { id: "r1", role: "reasoning", content: "先查" },
  { id: "r1b", role: "reasoning", content: " ENG-1。" },
  { id: "a1", role: "assistant", content: "", toolCalls: [call("c1")] },
  { id: "t1", role: "tool", toolCallId: "c1", content: "{}" },
  { id: "r2", role: "reasoning", content: "查到了。" },
  { id: "a2", role: "assistant", content: "在 Todo。" },
  { id: "u2", role: "user", content: "ENG-2 呢" },
  // Thinking cut off from its call by something else said is not that call's.
  { id: "r3", role: "reasoning", content: "不相干" },
  { id: "u3", role: "user", content: "算了" },
  { id: "a3", role: "assistant", content: "", toolCalls: [call("c3")] },
] as Message[];

describe("reasoningByToolCall", () => {
  test("keeps the thinking right before each step that called a tool, by its calls' ids", () => {
    expect([...reasoningByToolCall(history)]).toEqual([["c1", "先查 ENG-1。"]]);
  });

  test("a conversation with no thinking in it gives nothing", () => {
    expect(
      reasoningByToolCall(history.filter((m) => m.role !== "reasoning")).size,
    ).toBe(0);
  });
});

type Prompt = Parameters<typeof withReplayedReasoning>[0];

const prompt: Prompt = [
  { role: "user", content: [{ type: "text", text: "查 ENG-1" }] },
  {
    role: "assistant",
    content: [
      { type: "tool-call", toolCallId: "c1", toolName: "lookup", input: {} },
    ],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "c1",
        toolName: "lookup",
        output: { type: "text", value: "{}" },
      },
    ],
  },
  { role: "assistant", content: [{ type: "text", text: "在 Todo。" }] },
];

describe("withReplayedReasoning", () => {
  test("puts the thinking back first in the turn that made the call, and nowhere else", () => {
    const out = withReplayedReasoning(
      prompt,
      new Map([["c1", "先查 ENG-1。"]]),
    );
    expect(out[1]?.content).toEqual([
      { type: "reasoning", text: "先查 ENG-1。" },
      { type: "tool-call", toolCallId: "c1", toolName: "lookup", input: {} },
    ]);
    expect(out[3]).toBe(prompt[3]);
  });

  test("a turn that already carries its thinking, or one with nothing kept, is left as it is", () => {
    const carried: Prompt = [
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "这一轮自己的" },
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "lookup",
            input: {},
          },
        ],
      },
    ];
    expect(withReplayedReasoning(carried, new Map([["c1", "旧的"]]))).toBe(
      carried,
    );
    expect(withReplayedReasoning(prompt, new Map([["c9", "别处的"]]))).toBe(
      prompt,
    );
  });
});

describe("every step of a run is sent the thinking it kept", () => {
  test("through the same wrapper that decides the last step", async () => {
    const seen: Prompt[] = [];
    const model = {
      specificationVersion: "v3" as const,
      provider: "fake",
      modelId: "fake",
      supportedUrls: {},
      doGenerate: async (options: { prompt: Prompt }) => {
        seen.push(options.prompt);
        return {
          content: [{ type: "text" as const, text: "好" }],
          finishReason: { unified: "stop" as const, raw: undefined },
          usage: {
            inputTokens: {
              total: 1,
              noCache: 1,
              cacheRead: undefined,
              cacheWrite: undefined,
            },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
          },
          warnings: [],
        };
      },
      doStream: async () => {
        throw new Error("not streamed here");
      },
    };
    const steps = {};
    const configuration = answersOnLastStep(
      {
        model: model as never,
        maxSteps: 4,
        tools: [
          {
            name: "lookup",
            description: "Look up.",
            parameters: {} as never,
          },
        ],
      } as never,
      steps,
    );
    startRun(steps, [], reasoningByToolCall(history));
    const wrapped = (configuration as unknown as { model: typeof model }).model;
    await wrapped.doGenerate({ prompt });
    expect(seen[0]?.[1]?.content[0]).toEqual({
      type: "reasoning",
      text: "先查 ENG-1。",
    });

    // A run started without any (every provider but DeepSeek) is sent the prompt as it came.
    startRun(steps);
    await wrapped.doGenerate({ prompt });
    expect(seen[1]?.[1]).toBe(prompt[1]);
  });
});
