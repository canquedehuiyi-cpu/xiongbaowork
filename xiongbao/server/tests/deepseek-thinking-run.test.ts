import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AbstractAgent, BaseEvent, Message } from "@ag-ui/client";
import { type ChatCompletionRequest, LLMock } from "@copilotkit/aimock";
import { generateText } from "ai";
import { z } from "zod";
import { REASONING_EVENTS } from "../../shared/thinking";
import { createActorAgentResolver } from "../src/agents/agent-resolver";
import {
  deepSeekDeploymentModel,
  type RegisteredAgent,
  type RuntimeModel,
} from "../src/copilot";
import {
  deepSeekRequestBody,
  deepSeekThinkingOff,
  speaksDeepSeek,
} from "../src/models/deepseek-thinking";
import { languageModelFor } from "../src/models/runtime-resolver";
import type { GrantedTool } from "../src/plugins/tools";

/*
 * 期三「看得见的思考」(spec 2026-11-19-codex-grade-employee §2): on DeepSeek a Bot thinks before it
 * answers, its thinking streams as AG-UI reasoning events, and the thinking DeepSeek wants back is
 * sent back, so a tool loop in thinking mode is never refused.
 *
 * Driven the way `update-plan.test.ts` drives a run: the Bot built by the actor resolver, its tools
 * executed by the AI SDK. The model is a fake DeepSeek: requests leave for api.deepseek.com, as they
 * do in production, and are answered by aimock, which refuses a tool loop that dropped a turn's
 * thinking with DeepSeek's own 400.
 */

const DEEPSEEK = "https://api.deepseek.com/v1";
const REFUSAL =
  "The `reasoning_content` in the thinking mode must be passed back to the API.";

type Body = Record<string, unknown> & {
  messages: (Record<string, unknown> & { role: string })[];
  thinking?: { type?: string };
  tools?: unknown[];
};

let llm: LLMock;
let base: string;
const saved: Record<string, string | undefined> = {};
const realFetch = globalThis.fetch;
/** Every request body sent to DeepSeek, in order, as it left this process. */
let sent: Body[];
let lookups: string[];

beforeEach(async () => {
  llm = new LLMock();
  base = await llm.start();
  sent = [];
  lookups = [];
  for (const key of ["OPENAI_BASE_URL", "DEEPSEEK_THINKING"])
    saved[key] = process.env[key];
  process.env.OPENAI_BASE_URL = DEEPSEEK;
  delete process.env.DEEPSEEK_THINKING;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith(DEEPSEEK)) return realFetch(input, init);
    sent.push(JSON.parse(String(init?.body)) as Body);
    return realFetch(url.replace(DEEPSEEK, base), init);
  }) as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await llm.stop();
});

/** What the fake DeepSeek says on a request: words or tool calls, and what it thought first. */
type Answer =
  | { content: string; reasoning?: string }
  | {
      toolCalls: { name: string; arguments: string; id?: string }[];
      reasoning?: string;
    };

/** Whether DeepSeek would refuse this body: tools, thinking on, and a tool turn without its thinking. */
function refused(body: Body): boolean {
  return (
    (body.tools?.length ?? 0) > 0 &&
    body.thinking?.type !== "disabled" &&
    body.messages.some(
      (message) =>
        message.role === "assistant" &&
        Array.isArray(message.tool_calls) &&
        message.tool_calls.length > 0 &&
        typeof message.reasoning_content !== "string",
    )
  );
}

/** The fake answers with these, in order; it thinks only when thinking is on, as DeepSeek does. */
function deepSeekSays(script: Answer[]) {
  let index = 0;
  llm.on({ predicate: () => true }, (_request: ChatCompletionRequest) => {
    const body = sent.at(-1) as Body;
    if (refused(body))
      return {
        error: { message: REFUSAL, type: "invalid_request_error" },
        status: 400,
      };
    const answer = script[index++] ?? { content: "?" };
    if (body.thinking?.type === "disabled") {
      const { reasoning: _none, ...plain } = answer;
      return plain;
    }
    return answer;
  });
}

const lookup: GrantedTool = {
  name: "lookup_issue",
  description: "Look up one issue by its id.",
  parameters: z.object({ id: z.string() }),
  ref: "linear/lookup_issue",
  execute: async (args) => {
    const { id } = args as { id: string };
    lookups.push(id);
    return JSON.stringify({ id, title: `Issue ${id}`, state: "Todo" });
  },
};

const deepSeek: RuntimeModel = {
  provider: "openai",
  defaultModel: "deepseek-v4-flash",
};
const thinker = {
  id: "thinker",
  name: "Thinker",
  type: "built_in" as const,
  systemPrompt: "Look things up.",
};

let calls = 0;
const lookupCall = (id: string, reasoning?: string): Answer => ({
  toolCalls: [
    {
      name: lookup.name,
      arguments: JSON.stringify({ id }),
      id: `call_${++calls}`,
    },
  ],
  ...(reasoning ? { reasoning } : {}),
});

async function chat(
  text: string,
  options: {
    history?: Message[];
    bot?: RegisteredAgent;
    model?: RuntimeModel;
  } = {},
): Promise<{ messages: Message[]; events: BaseEvent[] }> {
  const bot = options.bot ?? thinker;
  const agent = await createActorAgentResolver({
    loadAgents: async () => [bot],
    model: options.model ?? deepSeek,
    resolveModelApiKey: async () => "synthetic-key",
    loadToolsForActor: () => async () => [lookup],
  }).resolveAgentForActor({ id: "owner", role: "user" }, bot.id);
  const run = agent.clone() as AbstractAgent;
  run.threadId = "thread-thinking";
  run.setMessages([
    ...(options.history ?? []),
    { id: `ask-${++calls}`, role: "user", content: text },
  ]);
  const events: BaseEvent[] = [];
  await run.runAgent(
    {},
    {
      onEvent: ({ event }) => {
        events.push(event);
      },
    },
  );
  return { messages: run.messages, events };
}

const types = (events: BaseEvent[]): string[] =>
  events.map((event) => event.type);
const thought = (events: BaseEvent[]) =>
  events
    .filter((event) => event.type === "REASONING_MESSAGE_CONTENT")
    .map((event) => (event as BaseEvent & { delta: string }).delta)
    .join("");
const toolTurns = (body: Body | undefined) =>
  (body?.messages ?? []).filter(
    (message) =>
      message.role === "assistant" &&
      Array.isArray(message.tool_calls) &&
      message.tool_calls.length > 0,
  );
const wordTurns = (body: Body | undefined) =>
  (body?.messages ?? []).filter(
    (message) =>
      message.role === "assistant" &&
      !(Array.isArray(message.tool_calls) && message.tool_calls.length > 0),
  );

describe("the fake DeepSeek", () => {
  test("refuses a tool loop in thinking mode that dropped a turn's thinking, as DeepSeek does", () => {
    const loop: Body = {
      messages: [
        { role: "user", content: "查 ENG-1" },
        { role: "assistant", content: null, tool_calls: [{ id: "c" }] },
        { role: "tool", tool_call_id: "c", content: "{}" },
      ],
      tools: [{}],
      thinking: { type: "enabled" },
    };
    expect(refused(loop)).toBe(true);
    expect(refused(deepSeekRequestBody(loop) as Body)).toBe(false);
  });
});

describe("a person's run on DeepSeek, thinking on (the default)", () => {
  test("streams its thinking, sends each step's thinking back in the tool loop, and is not refused", async () => {
    deepSeekSays([
      lookupCall("ENG-1", "先查 ENG-1 的状态。"),
      { content: "ENG-1 在 Todo。", reasoning: "查到了，可以作答。" },
    ]);

    const { messages, events } = await chat("ENG-1 是什么状态？");

    expect(sent).toHaveLength(2);
    expect(lookups).toEqual(["ENG-1"]);
    for (const body of sent) expect(body.thinking).toEqual({ type: "enabled" });
    // The second step carries the first step's thinking, as DeepSeek received it.
    expect(toolTurns(sent[1])).toHaveLength(1);
    expect(toolTurns(sent[1])[0]?.reasoning_content).toBe(
      "先查 ENG-1 的状态。",
    );
    expect(types(events)).not.toContain("RUN_ERROR");
    // Both steps' thinking streamed, as AG-UI reasoning events, ahead of what each step did.
    for (const type of REASONING_EVENTS) expect(types(events)).toContain(type);
    expect(thought(events)).toBe("先查 ENG-1 的状态。查到了，可以作答。");
    expect(types(events).indexOf("REASONING_START")).toBeLessThan(
      types(events).indexOf("TOOL_CALL_START"),
    );
    expect(messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "ENG-1 在 Todo。",
    });
    // And the conversation keeps it, as messages of their own.
    expect(
      messages
        .filter((message) => (message.role as string) === "reasoning")
        .map((message) => message.content),
    ).toEqual(["先查 ENG-1 的状态。", "查到了，可以作答。"]);
  });

  test("each piece of thinking says when it started and when it ended, so a replay can say how long it took", async () => {
    deepSeekSays([
      lookupCall("ENG-1", "先查 ENG-1 的状态。"),
      { content: "ENG-1 在 Todo。", reasoning: "查到了，可以作答。" },
    ]);
    const before = Date.now();
    const { events } = await chat("ENG-1 是什么状态？");
    const after = Date.now();
    const stamped = (type: string) =>
      events
        .filter((event) => event.type === type)
        .map(
          (event) => (event as BaseEvent & { timestamp?: unknown }).timestamp,
        );
    const starts = stamped("REASONING_MESSAGE_START");
    const ends = stamped("REASONING_MESSAGE_END");
    expect(starts).toHaveLength(2);
    expect(ends).toHaveLength(2);
    for (const moment of [...starts, ...ends]) {
      expect(typeof moment).toBe("number");
      expect(moment as number).toBeGreaterThanOrEqual(before);
      expect(moment as number).toBeLessThanOrEqual(after);
    }
    for (const [index, start] of starts.entries())
      expect(ends[index] as number).toBeGreaterThanOrEqual(start as number);
  });

  test("on the next turn, sends back the thinking of the turn that called a tool and drops the rest", async () => {
    deepSeekSays([
      lookupCall("ENG-1", "先查 ENG-1 的状态。"),
      { content: "ENG-1 在 Todo。", reasoning: "查到了，可以作答。" },
      lookupCall("ENG-2", "再查 ENG-2。"),
      { content: "ENG-2 也在 Todo。", reasoning: "同样作答。" },
    ]);
    const first = await chat("ENG-1 是什么状态？");
    sent = [];

    const { events } = await chat("ENG-2 呢？", { history: first.messages });

    expect(types(events)).not.toContain("RUN_ERROR");
    expect(sent).toHaveLength(2);
    // The earlier turn's tool call, with the thinking that led to it, word for word.
    const earlier = toolTurns(sent[0]);
    expect(earlier).toHaveLength(1);
    expect(earlier[0]?.reasoning_content).toBe("先查 ENG-1 的状态。");
    // Its answer called no tool: across turns its thinking is not sent.
    expect(wordTurns(sent[0]).map((message) => message.content)).toEqual([
      "ENG-1 在 Todo。",
    ]);
    expect(
      wordTurns(sent[0]).some((message) => "reasoning_content" in message),
    ).toBe(false);
    // This turn's own loop carries its own step's thinking too.
    expect(toolTurns(sent[1]).map((m) => m.reasoning_content)).toEqual([
      "先查 ENG-1 的状态。",
      "再查 ENG-2。",
    ]);
    expect(lookups).toEqual(["ENG-1", "ENG-2"]);
  });

  test("a history that kept no thinking (a group chat, an approval's continuation) is not refused", async () => {
    deepSeekSays([
      lookupCall("ENG-2", "再查 ENG-2。"),
      { content: "ENG-2 也在 Todo。" },
    ]);

    const { events } = await chat("ENG-2 呢？", {
      history: [
        { id: "earlier-ask", role: "user", content: "ENG-1 是什么状态？" },
        {
          id: "earlier-call",
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call_earlier",
              type: "function",
              function: {
                name: lookup.name,
                arguments: JSON.stringify({ id: "ENG-1" }),
              },
            },
          ],
        },
        {
          id: "earlier-result",
          role: "tool",
          toolCallId: "call_earlier",
          content: '{"state":"Todo"}',
        },
        { id: "earlier-answer", role: "assistant", content: "ENG-1 在 Todo。" },
      ],
    });

    expect(types(events)).not.toContain("RUN_ERROR");
    expect(sent).toHaveLength(2);
    // DeepSeek checks that the field is there; with nothing kept it is empty.
    expect(toolTurns(sent[0]).map((m) => m.reasoning_content)).toEqual([""]);
    expect(thought(events)).toBe("再查 ENG-2。");
  });

  test("the person's effort still reaches DeepSeek", async () => {
    deepSeekSays([{ content: "好。", reasoning: "想一下。" }]);
    await chat("你好", { model: { ...deepSeek, effort: "high" } });
    expect(sent[0]?.reasoning_effort).toBe("high");
  });
});

describe("thinking off", () => {
  test("for one Bot its owner switched off: DeepSeek is told so, and nothing is streamed as thinking", async () => {
    deepSeekSays([
      lookupCall("ENG-1", "先查 ENG-1 的状态。"),
      { content: "ENG-1 在 Todo。", reasoning: "查到了。" },
    ]);

    const { events } = await chat("ENG-1 是什么状态？", {
      bot: { ...thinker, thinking: false },
      history: [
        { id: "old-ask", role: "user", content: "早上好" },
        { id: "old-thought", role: "reasoning", content: "打个招呼。" },
        { id: "old-answer", role: "assistant", content: "早上好！" },
      ] as Message[],
    });

    expect(sent).toHaveLength(2);
    for (const body of sent) {
      expect(body.thinking).toEqual({ type: "disabled" });
      expect(
        body.messages.some((message) => "reasoning_content" in message),
      ).toBe(false);
    }
    expect(types(events)).not.toContain("RUN_ERROR");
    for (const type of REASONING_EVENTS)
      expect(types(events)).not.toContain(type);
    expect(lookups).toEqual(["ENG-1"]);
  });

  test("for every Bot, with DEEPSEEK_THINKING=disabled", async () => {
    process.env.DEEPSEEK_THINKING = "disabled";
    expect(deepSeekThinkingOff()).toBe(true);
    deepSeekSays([
      lookupCall("ENG-1", "先查。"),
      { content: "ENG-1 在 Todo。", reasoning: "查到了。" },
    ]);

    const { events } = await chat("ENG-1 是什么状态？");

    expect(sent).toHaveLength(2);
    for (const body of sent)
      expect(body.thinking).toEqual({ type: "disabled" });
    for (const type of REASONING_EVENTS)
      expect(types(events)).not.toContain(type);
    expect(types(events)).not.toContain("RUN_ERROR");
  });
});

describe("other models are left as they were", () => {
  test("a deployment on another OpenAI-compatible endpoint is sent no thinking field", async () => {
    process.env.OPENAI_BASE_URL = base;
    const asked: ChatCompletionRequest[] = [];
    llm.on({ predicate: () => true }, (request) => {
      asked.push(request);
      return { content: "好。", reasoning: "想一下。" };
    });
    expect(deepSeekDeploymentModel(deepSeek, "k")).toBeUndefined();

    await chat("你好", { bot: { ...thinker, thinking: false } });

    expect(sent).toEqual([]);
    expect(asked).toHaveLength(1);
    expect("thinking" in (asked[0] as object)).toBe(false);
  });

  test("a coworker's own model reaches DeepSeek through the same client only on DeepSeek's host", async () => {
    const official = languageModelFor("deepseek", null, "deepseek-v4-pro", "k");
    expect(speaksDeepSeek(official)).toBe(true);
    expect(
      speaksDeepSeek(
        languageModelFor(
          "openai",
          "https://api.deepseek.com/v1",
          "deepseek-v4-pro",
          "k",
        ),
      ),
    ).toBe(true);
    for (const other of [
      languageModelFor("moonshot", null, "kimi", "k"),
      languageModelFor("deepseek", "https://proxy.example.test/v1", "x", "k"),
    ])
      expect(speaksDeepSeek(other)).toBe(false);

    deepSeekSays([{ content: "好。", reasoning: "想一下。" }]);
    const result = await generateText({ model: official, prompt: "你好" });
    expect(result.reasoningText).toBe("想一下。");
    expect(result.text).toBe("好。");
    expect(sent[0]?.thinking).toEqual({ type: "enabled" });
  });
});

describe("deepSeekRequestBody", () => {
  const call = (id: string) => [
    { id, type: "function", function: { name: "f", arguments: "{}" } },
  ];
  const body = (): Body => ({
    model: "deepseek-v4-flash",
    tools: [{}],
    messages: [
      { role: "user", content: "一" },
      { role: "assistant", content: null, tool_calls: call("a") },
      { role: "tool", tool_call_id: "a", content: "{}" },
      { role: "assistant", content: "答一", reasoning_content: "想答一" },
      { role: "user", content: "二" },
      {
        role: "assistant",
        content: null,
        tool_calls: call("b"),
        reasoning_content: "想二",
      },
      { role: "tool", tool_call_id: "b", content: "{}" },
    ],
  });

  test("thinking on: every tool turn carries its thinking, an earlier answer's is dropped", () => {
    const out = deepSeekRequestBody(body()) as Body;
    expect(out.thinking).toEqual({ type: "enabled" });
    expect(out.messages.map((message) => message.reasoning_content)).toEqual([
      undefined,
      "",
      undefined,
      undefined,
      undefined,
      "想二",
      undefined,
    ]);
    expect("reasoning_content" in (out.messages[3] as object)).toBe(false);
  });

  test("an answer after the last thing the person said keeps what it carries", () => {
    const input = body();
    input.messages.push({
      role: "assistant",
      content: "答二",
      reasoning_content: "想答二",
    });
    const out = deepSeekRequestBody(input) as Body;
    expect(out.messages.at(-1)?.reasoning_content).toBe("想答二");
  });

  test("thinking off, by the Bot or the deployment: told so, and no thinking is sent at all", () => {
    for (const out of [
      deepSeekRequestBody({ ...body(), thinking: { type: "disabled" } }),
      deepSeekRequestBody(body(), true),
    ] as Body[]) {
      expect(out.thinking).toEqual({ type: "disabled" });
      expect(
        out.messages.some((message) => "reasoning_content" in message),
      ).toBe(false);
    }
  });
});
