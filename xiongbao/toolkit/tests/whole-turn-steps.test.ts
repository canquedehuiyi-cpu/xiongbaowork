import { describe, expect, test } from "bun:test";
import type { BaseEvent } from "@ag-ui/client";
import type { BuiltInAgentConfiguration } from "@copilotkit/runtime/v2";
import { BuiltInAgentWithSaneHistory } from "../src/copilotkit/agents";
import { parametersFor } from "../src/granted-tool";
import { HeadlessToolsMiddleware } from "../src/headless-tools";

/*
 * A turn the host carries on between runs is several runs: the Bot asks for a tool the host runs,
 * and is started again with the result. Each of those runs used to count its steps from where it
 * started, so a budget of N steps was spent afresh every round and a Bot that kept asking was never
 * made to answer. With `wholeTurn` the steps are counted from the person's message.
 */

const usage = {
  inputTokens: {
    total: 1,
    noCache: 1,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

/** A model that asks for `probe` on every step it may, and answers only when tools are off. */
function askingForever(choices: (string | undefined)[]) {
  return {
    specificationVersion: "v3" as const,
    provider: "fake",
    modelId: "fake",
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error("Only streamed here.");
    },
    doStream: async (options: { toolChoice?: { type: string } }) => {
      choices.push(options.toolChoice?.type);
      const parts =
        options.toolChoice?.type === "none"
          ? [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "text" },
              { type: "text-delta", id: "text", delta: "Out of steps." },
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
                toolCallId: `call-${choices.length}`,
                toolName: "probe",
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

function turn(wholeTurn: boolean, maxSegments: number) {
  const choices: (string | undefined)[] = [];
  const configuration = {
    model: askingForever(choices) as never,
    prompt: "Work.",
    maxSteps: 3,
    tools: [
      {
        name: "note",
        description: "Write a note.",
        parameters: parametersFor({ type: "object", properties: {} } as never),
        execute: async () => "Noted.",
      },
    ],
  } as BuiltInAgentConfiguration;
  const agent = new BuiltInAgentWithSaneHistory(configuration, {
    observe: (run) => run,
    ...(wholeTurn ? { wholeTurn: () => true } : {}),
  });
  let executed = 0;
  agent.use(
    new HeadlessToolsMiddleware(
      [
        {
          definition: {
            name: "probe",
            description: "Look.",
            parameters: { type: "object", properties: {} },
          },
          execute: async () => {
            executed += 1;
            return { ok: true };
          },
        },
      ],
      undefined,
      { maxSegments },
    ),
  );
  agent.threadId = "thread";
  agent.setMessages([{ id: "ask", role: "user", content: "Keep looking." }]);
  return { agent, choices, executed: () => executed };
}

async function run(agent: BuiltInAgentWithSaneHistory) {
  const types: string[] = [];
  let text = "";
  await agent.runAgent(
    {},
    {
      onEvent: ({ event }: { event: BaseEvent }) => {
        types.push(event.type);
        if (event.type === "TEXT_MESSAGE_CONTENT")
          text += (event as BaseEvent & { delta: string }).delta;
      },
    },
  );
  return { types, text };
}

describe("a turn's steps across the rounds the host runs between", () => {
  test("are one budget: the last step of the turn is sent without tools", async () => {
    const { agent, choices, executed } = turn(true, 10);
    const { text } = await run(agent);
    expect(choices).toEqual(["auto", "auto", "none"]);
    expect(executed()).toBe(2);
    expect(text).toBe("Out of steps.");
  });

  test("without it each round starts counting again, and only the rounds cap stops the turn", async () => {
    const { agent, choices, executed } = turn(false, 4);
    const { types } = await run(agent);
    expect(choices.every((choice) => choice === "auto")).toBe(true);
    expect(choices).toHaveLength(5);
    expect(executed()).toBe(4);
    expect(types).toContain("RUN_ERROR");
  });
});
