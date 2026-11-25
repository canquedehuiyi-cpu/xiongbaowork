import { describe, expect, test } from "bun:test";
import type { BaseEvent } from "@ag-ui/client";
import {
  BuiltInAgent,
  type BuiltInAgentConfiguration,
} from "@copilotkit/runtime/v2";
import {
  STEP_LIMIT_EVENT,
  type StepLimitPayload,
} from "@xiongbao/shared/step-limit";
import { parametersFor } from "../src/granted-tool";
import { BuiltInAgentWithSaneHistory } from "../src/runtime/agents";
import { answersOnLastStep, MOST_NUDGES } from "../src/runtime/last-step";

/**
 * A run stops after `maxSteps` model steps. A Bot that searched once per step spent all of them on
 * searches and its run ended on the last search's results with nothing said: a subtask that "did not
 * finish", then its Bot did the same. The last step is now sent with no tool to choose.
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

type Call = { toolChoice?: { type: string }; turns: number };

/** A model that searches on every step it is allowed to, and answers only when it may not. */
function searchingForever(calls: Call[]) {
  return {
    specificationVersion: "v3" as const,
    provider: "fake",
    modelId: "fake",
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error("Only streamed here.");
    },
    doStream: async (options: {
      toolChoice?: { type: string };
      prompt: { role: string }[];
    }) => {
      calls.push({
        ...(options.toolChoice ? { toolChoice: options.toolChoice } : {}),
        turns: options.prompt.filter((message) => message.role === "assistant")
          .length,
      });
      const parts =
        options.toolChoice?.type === "none"
          ? [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "text" },
              {
                type: "text-delta",
                id: "text",
                delta: "Here is what I found.",
              },
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
                toolCallId: `call-${calls.length}`,
                toolName: "search",
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

function configuration(calls: Call[]): BuiltInAgentConfiguration {
  return {
    model: searchingForever(calls) as never,
    prompt: "Find things.",
    maxSteps: 3,
    tools: [
      {
        name: "search",
        description: "Search the web.",
        parameters: parametersFor({ type: "object", properties: {} } as never),
        execute: async () => "A result.",
      },
    ],
  } as BuiltInAgentConfiguration;
}

async function said(agent: BuiltInAgent): Promise<string> {
  agent.threadId = "thread";
  agent.setMessages([{ id: "ask", role: "user", content: "Find five." }]);
  let text = "";
  await agent.runAgent(
    {},
    {
      onEvent: ({ event }: { event: BaseEvent }) => {
        if (event.type === "TEXT_MESSAGE_CONTENT")
          text += (event as BaseEvent & { delta: string }).delta;
      },
    },
  );
  return text;
}

describe("a run's last step", () => {
  test("a Bot that would search forever answers on the last step it is allowed", async () => {
    const calls: Call[] = [];
    const agent = new BuiltInAgentWithSaneHistory(configuration(calls), {
      observe: (run) => run,
    });
    expect(await said(agent)).toBe("Here is what I found.");
    expect(calls.map((call) => call.toolChoice?.type)).toEqual([
      "auto",
      "auto",
      "none",
    ]);
  });

  test("without it, the same run ends on a search with nothing said", async () => {
    const calls: Call[] = [];
    expect(await said(new BuiltInAgent(configuration(calls)))).toBe("");
    expect(calls).toHaveLength(3);
  });

  test("a step sent again with the same prompt is the same step, so a retry does not use one up", async () => {
    const calls: Call[] = [];
    const wrapped = answersOnLastStep(configuration(calls), {});
    if ("factory" in wrapped) throw new Error("Expected a model.");
    const model = wrapped.model as ReturnType<typeof searchingForever>;
    const prompt = [{ role: "user" }];
    await model.doStream({ prompt });
    await model.doStream({ prompt });
    await model.doStream({ prompt: [...prompt, { role: "assistant" }] });
    expect(calls.map((call) => call.toolChoice?.type)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    await model.doStream({
      prompt: [...prompt, { role: "assistant" }, { role: "assistant" }],
    });
    expect(calls.at(-1)?.toolChoice?.type).toBe("none");
  });

  test("a run counts from where it starts, not from the conversation before it", async () => {
    const calls: Call[] = [];
    const agent = new BuiltInAgentWithSaneHistory(configuration(calls), {
      observe: (run) => run,
    });
    agent.threadId = "thread";
    // A long conversation already: four earlier turns that each used a tool.
    agent.setMessages([
      ...[1, 2, 3, 4].flatMap((n) => [
        {
          id: `call-message-${n}`,
          role: "assistant" as const,
          content: "",
          toolCalls: [
            {
              id: `earlier-${n}`,
              type: "function" as const,
              function: { name: "search", arguments: "{}" },
            },
          ],
        },
        {
          id: `result-${n}`,
          role: "tool" as const,
          toolCallId: `earlier-${n}`,
          content: "A result.",
        },
      ]),
      { id: "ask", role: "user", content: "Find five." },
    ]);
    await agent.runAgent({}, {});
    expect(calls.map((call) => call.toolChoice?.type)).toEqual([
      "auto",
      "auto",
      "none",
    ]);
  });

  test("the runtime still names where the model is hosted", () => {
    const named = { ...configuration([]), model: "openai/gpt-5.6-terra" };
    const agent = new BuiltInAgentWithSaneHistory(
      { ...named, apiKey: "test" } as BuiltInAgentConfiguration,
      { observe: (run) => run },
    );
    expect(agent.modelHostClass).toBe(
      new BuiltInAgent(named as BuiltInAgentConfiguration).modelHostClass,
    );
  });
});

/** Every event a run sends, in order. */
async function eventsOf(agent: BuiltInAgent): Promise<BaseEvent[]> {
  agent.threadId = "thread";
  agent.setMessages([{ id: "ask", role: "user", content: "Find five." }]);
  const events: BaseEvent[] = [];
  await agent.runAgent({}, { onEvent: ({ event }) => void events.push(event) });
  return events;
}

const stepLimits = (events: BaseEvent[]) =>
  events.filter(
    (event) =>
      event.type === "CUSTOM" &&
      (event as BaseEvent & { name?: string }).name === STEP_LIMIT_EVENT,
  ) as (BaseEvent & { value: StepLimitPayload })[];

/** A model that calls a tool on the first `working` steps it is offered tools, then answers. */
function workingFor(calls: Call[], working: number) {
  const model = searchingForever(calls);
  return {
    ...model,
    doStream: async (options: {
      toolChoice?: { type: string };
      prompt: { role: string }[];
    }) =>
      model.doStream(
        calls.length >= working
          ? { ...options, toolChoice: { type: "none" } }
          : options,
      ),
  };
}

describe("a person's run still at work on its last step", () => {
  test("is given one more budget of steps, and only then answers without tools", async () => {
    const calls: Call[] = [];
    const agent = new BuiltInAgentWithSaneHistory(configuration(calls), {
      observe: (run) => run,
      extension: 3,
    });
    const events = await eventsOf(agent);
    expect(calls.map((call) => call.toolChoice?.type)).toEqual([
      "auto",
      "auto",
      "auto",
      "auto",
      "auto",
      "none",
    ]);
    // Said once, in the run, before it finishes: how many steps the run used.
    const limits = stepLimits(events);
    expect(limits).toHaveLength(1);
    expect(limits[0]?.value).toEqual({ steps: 6 });
    const at = events.indexOf(limits[0] as BaseEvent);
    expect(events.slice(at + 1).map((event) => String(event.type))).toEqual([
      "RUN_FINISHED",
    ]);
  });

  test("a run that stops calling tools by its last step ends there, unextended and unflagged", async () => {
    const calls: Call[] = [];
    const agent = new BuiltInAgentWithSaneHistory(
      { ...configuration(calls), model: workingFor(calls, 2) as never },
      { observe: (run) => run, extension: 3 },
    );
    const events = await eventsOf(agent);
    expect(calls).toHaveLength(3);
    expect(stepLimits(events)).toEqual([]);
  });

  test("the extension is given once, counted again for every run", async () => {
    const calls: Call[] = [];
    const agent = new BuiltInAgentWithSaneHistory(configuration(calls), {
      observe: (run) => run,
      extension: 3,
    });
    await eventsOf(agent);
    const second = agent.clone();
    calls.length = 0;
    const events = await eventsOf(second);
    expect(calls).toHaveLength(6);
    expect(calls.at(-1)?.toolChoice?.type).toBe("none");
    expect(stepLimits(events)).toHaveLength(1);
  });

  test("an unattended run keeps its own budget, with no extension and no event", async () => {
    const calls: Call[] = [];
    const agent = new BuiltInAgentWithSaneHistory(configuration(calls), {
      observe: (run) => run,
      unattended: true,
      extension: 3,
    });
    const events = await eventsOf(agent);
    expect(calls.map((call) => call.toolChoice?.type)).toEqual([
      "auto",
      "auto",
      "none",
    ]);
    expect(stepLimits(events)).toEqual([]);
  });

  test("a run with no extension says nothing when it is cut off", async () => {
    const calls: Call[] = [];
    const agent = new BuiltInAgentWithSaneHistory(configuration(calls), {
      observe: (run) => run,
    });
    expect(stepLimits(await eventsOf(agent))).toEqual([]);
  });
});

describe("the nudges a run gets in a row", () => {
  test("are four", () => {
    expect(MOST_NUDGES).toBe(4);
  });
});
