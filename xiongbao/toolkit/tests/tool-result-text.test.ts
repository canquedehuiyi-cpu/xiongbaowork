import { describe, expect, test } from "bun:test";
import type { BaseEvent, Message } from "@ag-ui/client";
import type {
  BuiltInAgent,
  BuiltInAgentConfiguration,
} from "@copilotkit/runtime/v2";
import { parametersFor } from "../src/granted-tool";
import { BuiltInAgentWithSaneHistory } from "../src/runtime/agents";
import { plainToolResult, plainToolResults } from "../src/tool-result-text";

/**
 * A tool that answers with a plain string used to reach the thread as that string encoded as JSON
 * again, so the next turn replayed `"\"已更新计划…\""` where the turn that ran the tool had used
 * `已更新计划…`: every token after it missed the prompt cache, and the model read the escapes.
 */

const PLAN = "已更新计划：3 项待办，1 项进行中";

const usage = {
  inputTokens: {
    total: 1,
    noCache: 1,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

type Prompt = { role: string; content: unknown }[];

/** A model that calls `plan` once when it has no tool result yet, and answers once it has. */
function planner(prompts: Prompt[]) {
  return {
    specificationVersion: "v3" as const,
    provider: "fake",
    modelId: "fake",
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error("Only streamed here.");
    },
    doStream: async (options: { prompt: Prompt }) => {
      prompts.push(options.prompt);
      const answered = options.prompt.some(
        (message) => message.role === "tool",
      );
      const asked = options.prompt.filter((m) => m.role === "user").length;
      const parts =
        answered && asked === 1
          ? [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "text" },
              { type: "text-delta", id: "text", delta: "Done." },
              { type: "text-end", id: "text" },
              {
                type: "finish",
                finishReason: { unified: "stop", raw: "stop" },
                usage,
              },
            ]
          : asked > 1
            ? [
                { type: "stream-start", warnings: [] },
                { type: "text-start", id: "text" },
                { type: "text-delta", id: "text", delta: "Again." },
                { type: "text-end", id: "text" },
                {
                  type: "finish",
                  finishReason: { unified: "stop", raw: "stop" },
                  usage,
                },
              ]
            : [
                { type: "stream-start", warnings: [] },
                {
                  type: "tool-call",
                  toolCallId: "call-1",
                  toolName: "plan",
                  input: "{}",
                },
                {
                  type: "finish",
                  finishReason: { unified: "tool-calls", raw: "tool_calls" },
                  usage,
                },
              ];
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

function configuration(
  prompts: Prompt[],
  result: unknown,
): BuiltInAgentConfiguration {
  return {
    model: planner(prompts) as never,
    prompt: "Plan.",
    maxSteps: 4,
    tools: [
      {
        name: "plan",
        description: "Update the plan.",
        parameters: parametersFor({ type: "object", properties: {} } as never),
        execute: async () => result,
      },
    ],
  } as BuiltInAgentConfiguration;
}

async function run(
  agent: BuiltInAgent,
  messages: Message[],
): Promise<{ events: BaseEvent[]; messages: Message[] }> {
  agent.threadId = "thread";
  agent.setMessages(messages);
  const events: BaseEvent[] = [];
  await agent.runAgent(
    {},
    {
      onEvent: ({ event }: { event: BaseEvent }) => {
        events.push(event);
      },
    },
  );
  return { events, messages: agent.messages };
}

function resultsIn(events: BaseEvent[]): string[] {
  return events
    .filter((event) => event.type === "TOOL_CALL_RESULT")
    .map((event) => (event as BaseEvent & { content: string }).content);
}

/** The text the model was handed for the tool result in a prompt. */
function toolTextIn(prompt: Prompt): unknown[] {
  return prompt
    .filter((message) => message.role === "tool")
    .flatMap((message) => message.content as { output: { value: unknown } }[])
    .map((part) => part.output.value);
}

const ASK: Message = { id: "ask", role: "user", content: "Plan it." };

describe("plain string tool results", () => {
  test("the decoder undoes exactly what a string result went through", () => {
    expect(plainToolResult(JSON.stringify(PLAN))).toBe(PLAN);
    expect(plainToolResult(JSON.stringify('say "hi"\nnow'))).toBe(
      'say "hi"\nnow',
    );
    expect(plainToolResult(JSON.stringify(""))).toBe("");
    // Not a string once decoded, or not an encoded string at all: left alone.
    for (const same of [
      PLAN,
      '{"ok":true}',
      "[1,2]",
      "42",
      "null",
      '"unterminated',
      '"a" and "b"',
      '"',
      "",
    ])
      expect(plainToolResult(same)).toBe(same);
  });

  test("a conversation is decoded, and what needs nothing is the same object", () => {
    const clean: Message[] = [
      ASK,
      { id: "r", role: "tool", toolCallId: "c", content: PLAN },
    ];
    expect(plainToolResults(clean)).toBe(clean);
    const old: Message[] = [
      ASK,
      { id: "r", role: "tool", toolCallId: "c", content: JSON.stringify(PLAN) },
    ];
    expect((plainToolResults(old)[1] as { content: string }).content).toBe(
      PLAN,
    );
    expect(plainToolResults(old)[0]).toBe(ASK);
  });

  test("live, the stream carries the runtime's quoted form and the model is handed the string itself", async () => {
    const prompts: Prompt[] = [];
    const ours = await run(
      new BuiltInAgentWithSaneHistory(configuration(prompts, PLAN), {
        observe: (stream) => stream,
      }),
      [ASK],
    );
    // The event stays as the runtime wrote it: what draws a tool result reads that form.
    expect(resultsIn(ours.events)).toEqual([JSON.stringify(PLAN)]);
    // Inside the turn, the model's next step is sent the tool's own string.
    expect(toolTextIn(prompts[1] ?? [])).toEqual([PLAN]);
  });

  test("stored and replayed, the next turn's model is handed the same bytes the live one had", async () => {
    const live: Prompt[] = [];
    const first = await run(
      new BuiltInAgentWithSaneHistory(configuration(live, PLAN), {
        observe: (stream) => stream,
      }),
      [ASK],
    );
    // Through storage: the thread's messages are JSON.
    const stored = JSON.parse(JSON.stringify(first.messages)) as Message[];
    const replayed: Prompt[] = [];
    await run(
      new BuiltInAgentWithSaneHistory(configuration(replayed, PLAN), {
        observe: (stream) => stream,
      }),
      [...stored, { id: "ask-2", role: "user", content: "And now?" }],
    );
    const seen = toolTextIn(replayed[0] ?? []);
    // The same text, byte for byte, as the model had in the turn that ran the tool.
    expect(seen).toEqual([PLAN]);
    expect(seen[0]).toBe(toolTextIn(live[1] ?? [])[0]);
    expect(JSON.stringify(seen)).toBe(
      JSON.stringify(toolTextIn(live[1] ?? [])),
    );
  });

  test("a conversation stored with the string encoded twice is read back as the string", async () => {
    const legacy: Message[] = [
      ASK,
      {
        id: "a",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "plan", arguments: "{}" },
          },
        ],
      },
      {
        id: "r",
        role: "tool",
        toolCallId: "call-1",
        content: JSON.stringify(PLAN),
      },
      { id: "ask-2", role: "user", content: "And now?" },
    ];
    const prompts: Prompt[] = [];
    await run(
      new BuiltInAgentWithSaneHistory(configuration(prompts, PLAN), {
        observe: (stream) => stream,
      }),
      legacy,
    );
    expect(toolTextIn(prompts[0] ?? [])).toEqual([PLAN]);
  });
});
