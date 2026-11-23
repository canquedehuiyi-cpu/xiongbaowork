import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AbstractAgent, BaseEvent, Message } from "@ag-ui/client";
import { type ChatCompletionRequest, LLMock } from "@copilotkit/aimock";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { APICallError, generateText, jsonSchema } from "ai";
import { Observable } from "rxjs";
import { HeadlessToolsMiddleware } from "../../toolkit/src/headless-tools";
import { createActorAgentResolver } from "../src/agents/agent-resolver";
import { sayingProviderRefusals } from "../src/agents/provider-refusal";
import type { RegisteredAgent, RuntimeModel } from "../src/copilot";
import {
  installDeepSeekThinkingOff,
  withReasoningGuarded,
} from "../src/models/deepseek-thinking";
import { languageModelFor } from "../src/models/runtime-resolver";
import { createGuardedFetch } from "../src/net/outbound-guard";

/*
 * DeepSeek 思考模式下，带 tool_calls 的 assistant 消息缺 `reasoning_content` 会被 400 拒绝（没调工具的缺了不拒，
 * 有 "" 就行）。这里用 aimock 按这条真实规则做假 DeepSeek：
 * - 出口兜底：不管请求体是哪条路径拼的（直接调 fetch、不带转换的 SDK 客户端、`createGuardedFetch`），
 *   发往 api.deepseek.com 之前都补上；别的主机、思考关着的、已有 `reasoning_content` 的不动。
 * - 诊断：400 的日志行带请求体的形状（只有数字），不带任何消息内容。
 * - 回放：员工没有自己授予的工具、工具全靠 `input.tools` 的服务器执行单聊，多段续跑发的是真实思考，不是 ""。
 */

const DEEPSEEK = "https://api.deepseek.com";
const CHAT = `${DEEPSEEK}/v1/chat/completions`;
const REFUSAL =
  "The `reasoning_content` in the thinking mode must be passed back to the API.";

type Msg = Record<string, unknown> & { role: string };
type Body = Record<string, unknown> & {
  messages: Msg[];
  thinking?: { type?: string };
  tools?: unknown[];
};

let llm: LLMock;
let base: string;
const realFetch = globalThis.fetch;
/** Every request body that reached the (fake) wire for DeepSeek, as it left this process. */
let sent: Body[];
let refusals: number;
const saved: Record<string, string | undefined> = {};

/** 真实规则：思考没关、带 tools，带 tool_calls 的 assistant 消息 reasoning_content 不是字符串，就 400。 */
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

type Answer =
  | { content: string; reasoning?: string }
  | {
      toolCalls: { name: string; arguments: string; id?: string }[];
      reasoning?: string;
    };

function deepSeekSays(script: Answer[]) {
  let index = 0;
  llm.on({ predicate: () => true }, (_request: ChatCompletionRequest) => {
    const body = sent.at(-1) as Body;
    if (refused(body)) {
      refusals += 1;
      return {
        error: { message: REFUSAL, type: "invalid_request_error" },
        status: 400,
      };
    }
    return script[index++] ?? { content: "?" };
  });
}

beforeEach(async () => {
  llm = new LLMock();
  base = await llm.start();
  sent = [];
  refusals = 0;
  for (const key of ["OPENAI_BASE_URL", "DEEPSEEK_THINKING"])
    saved[key] = process.env[key];
  process.env.OPENAI_BASE_URL = DEEPSEEK;
  delete process.env.DEEPSEEK_THINKING;
  /** 线上的 fetch：记下发往 DeepSeek 的正文，改道到假服务。兜底的全局包装装在它外面。 */
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith(DEEPSEEK)) return realFetch(input, init);
    sent.push(JSON.parse(String(init?.body)) as Body);
    return realFetch(`${base}/v1/chat/completions`, init);
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

const toolTurn = (reasoning?: unknown): Msg => ({
  role: "assistant",
  content: null,
  tool_calls: [
    {
      id: "call_1",
      type: "function",
      function: { name: "lookup_issue", arguments: '{"id":"A"}' },
    },
  ],
  ...(reasoning === undefined ? {} : { reasoning_content: reasoning }),
});

/** 缺字段的请求体：一条没调工具的回答、一条调了工具却没有 reasoning_content 的消息。 */
const broken = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    model: "deepseek-flash",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "ENG-1?" },
      toolTurn(),
      { role: "tool", tool_call_id: "call_1", content: "{}" },
    ],
    tools: [{ type: "function", function: { name: "lookup_issue" } }],
    ...extra,
  });

const post = (body: string, url = CHAT) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });

describe("出口兜底：全局 fetch 包装", () => {
  test("没装兜底时，缺字段的请求被假服务按真实规则拒（对照）", async () => {
    deepSeekSays([{ content: "ok" }]);
    const response = await post(broken({ thinking: { type: "enabled" } }));
    expect(response.status).toBe(400);
    expect(refusals).toBe(1);
  });

  test("绕过 deepSeekRequestBody 拼出的请求，出门前补上 reasoning_content，200", async () => {
    deepSeekSays([{ content: "ok" }]);
    installDeepSeekThinkingOff({});
    const response = await post(broken({ thinking: { type: "enabled" } }));
    expect(response.status).toBe(200);
    expect(refusals).toBe(0);
    const [body] = sent;
    expect(body?.messages[3]?.reasoning_content).toBe("");
    // 只补这一个字段：其余消息和字段原样
    expect(body?.messages[1]).toEqual({ role: "assistant", content: "hello" });
    expect(body?.model).toBe("deepseek-flash");
    expect(body?.thinking).toEqual({ type: "enabled" });
  });

  test("没写 thinking 且辅助请求被关思考时，补 disabled，不补 reasoning_content", async () => {
    deepSeekSays([{ content: "ok" }]);
    installDeepSeekThinkingOff({});
    const response = await post(broken());
    expect(response.status).toBe(200);
    expect(sent[0]?.thinking).toEqual({ type: "disabled" });
    expect("reasoning_content" in (sent[0]?.messages[3] ?? {})).toBe(false);
  });

  test("DEEPSEEK_THINKING=enabled：没写 thinking 的请求不补 disabled，但带工具调用的消息照样被兜住", async () => {
    deepSeekSays([{ content: "ok" }]);
    expect(installDeepSeekThinkingOff({ DEEPSEEK_THINKING: "enabled" })).toBe(
      false,
    );
    const response = await post(broken());
    expect(response.status).toBe(200);
    expect(sent[0]?.thinking).toBeUndefined();
    expect(sent[0]?.messages[3]?.reasoning_content).toBe("");
  });

  test("没有 /v1 的路径、末尾斜杠、字符串和 URL 对象的地址都命中", async () => {
    installDeepSeekThinkingOff({});
    for (const url of [
      `${DEEPSEEK}/chat/completions`,
      `${DEEPSEEK}/v1/chat/completions/`,
    ]) {
      deepSeekSays([{ content: "ok" }]);
      expect(
        (await post(broken({ thinking: { type: "enabled" } }), url)).status,
      ).toBe(200);
    }
    deepSeekSays([{ content: "ok" }]);
    const response = await fetch(new URL(CHAT), {
      method: "POST",
      body: broken({ thinking: { type: "enabled" } }),
    });
    expect(response.status).toBe(200);
    expect(sent.map((body) => body.messages[3]?.reasoning_content)).toEqual([
      "",
      "",
      "",
    ]);
  });

  test("不带转换的 openai-compatible 客户端（没经过 deepSeekRequestBody）也被兜住", async () => {
    deepSeekSays([{ content: "done" }]);
    installDeepSeekThinkingOff({ DEEPSEEK_THINKING: "enabled" });
    const model = createOpenAICompatible({
      name: "deepseek",
      baseURL: `${DEEPSEEK}/v1`,
      apiKey: "k",
    }).chatModel("deepseek-flash");
    const result = await generateText({
      model,
      tools: {
        lookup_issue: {
          description: "Look up one issue.",
          inputSchema: jsonSchema({ type: "object" }),
        },
      },
      messages: [
        { role: "user", content: "ENG-1?" },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call_1",
              toolName: "lookup_issue",
              input: { id: "A" },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call_1",
              toolName: "lookup_issue",
              output: { type: "text", value: "{}" },
            },
          ],
        },
      ],
    });
    expect(result.text).toBe("done");
    expect(refusals).toBe(0);
    expect(sent[0]?.messages.find((m) => m.tool_calls)?.reasoning_content).toBe(
      "",
    );
  });

  test("别的主机的同样请求不被改写", async () => {
    installDeepSeekThinkingOff({ DEEPSEEK_THINKING: "enabled" });
    const seen: string[] = [];
    llm.on({ predicate: () => true }, (request: ChatCompletionRequest) => {
      seen.push(JSON.stringify(request));
      return { content: "ok" };
    });
    const original = broken({ thinking: { type: "enabled" } });
    const init = { method: "POST", body: original };
    // 判定函数：别的主机、别的接口都原样返回同一个 init
    expect(
      withReasoningGuarded(
        "https://api.openai.com/v1/chat/completions",
        init,
        false,
      ),
    ).toBe(init);
    expect(
      withReasoningGuarded(
        "https://deepseek.example.com/v1/chat/completions",
        init,
        false,
      ),
    ).toBe(init);
    expect(withReasoningGuarded(`${DEEPSEEK}/v1/embeddings`, init, false)).toBe(
      init,
    );
    // 真发出去：到假服务（非 DeepSeek 主机）的正文一字不改
    const response = await realFetchVia(
      `${base}/v1/chat/completions`,
      original,
    );
    expect(response.status).toBe(200);
    const echoed = JSON.parse(seen[0] ?? "{}") as Body;
    expect("reasoning_content" in (echoed.messages[3] ?? {})).toBe(false);
  });

  test("thinking 为 disabled 的请求不被改写", () => {
    const init = {
      method: "POST",
      body: broken({ thinking: { type: "disabled" } }),
    };
    expect(withReasoningGuarded(CHAT, init, false)).toBe(init);
    expect(withReasoningGuarded(CHAT, init, true)).toBe(init);
  });

  test("已有 reasoning_content 的不被覆盖，也不重编码", () => {
    const body = JSON.stringify({
      thinking: { type: "enabled" },
      messages: [toolTurn("真实思考"), toolTurn("")],
    });
    const init = { method: "POST", body };
    expect(withReasoningGuarded(CHAT, init, false)).toBe(init);
    const mixed = {
      method: "POST",
      body: JSON.stringify({
        thinking: { type: "enabled" },
        messages: [toolTurn("真实思考"), toolTurn()],
      }),
    };
    const guarded = withReasoningGuarded(CHAT, mixed, false);
    const messages = JSON.parse(String(guarded?.body)).messages as Msg[];
    expect(messages.map((m) => m.reasoning_content)).toEqual(["真实思考", ""]);
  });

  test("不是 JSON、不是 POST、正文不是字符串的请求原样返回", () => {
    const notJson = { method: "POST", body: "not json" };
    expect(withReasoningGuarded(CHAT, notJson, false)).toBe(notJson);
    const get = { method: "GET", body: broken() };
    expect(withReasoningGuarded(CHAT, get, false)).toBe(get);
    expect(withReasoningGuarded(CHAT, undefined, false)).toBeUndefined();
    const array = { method: "POST", body: "[]" };
    expect(withReasoningGuarded(CHAT, array, false)).toBe(array);
  });
});

/** 不经任何兜底，直接用真 fetch 发。 */
function realFetchVia(url: string, body: string) {
  return realFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

describe("出口兜底：createGuardedFetch（员工绑定模型的出站守卫）", () => {
  test("不经全局包装（给了自己的 fetchImpl）也补上字段", async () => {
    deepSeekSays([{ content: "ok" }]);
    const guarded = createGuardedFetch({
      lookup: async () => [{ address: "8.8.8.8", family: 4 }],
      viaProxy: () => false,
      fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        sent.push(JSON.parse(String(init?.body)) as Body);
        return realFetch(`${base}/v1/chat/completions`, init);
      }) as typeof fetch,
    });
    const response = await guarded(CHAT, {
      method: "POST",
      body: broken({ thinking: { type: "enabled" } }),
    });
    expect(response.status).toBe(200);
    expect(sent[0]?.messages[3]?.reasoning_content).toBe("");
  });

  test("员工绑定的 deepseek 模型（模型库 / 池）发出的请求带 thinking，每条带工具调用的消息都有字段", async () => {
    deepSeekSays([{ content: "done" }]);
    const model = languageModelFor("deepseek", null, "deepseek-flash", "k");
    await (
      model as unknown as { doGenerate: (o: unknown) => Promise<unknown> }
    ).doGenerate({
      prompt: [
        { role: "user", content: [{ type: "text", text: "ENG-1?" }] },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call_1",
              toolName: "lookup_issue",
              input: { id: "A" },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call_1",
              toolName: "lookup_issue",
              output: { type: "text", value: "{}" },
            },
          ],
        },
      ],
      tools: [
        {
          type: "function",
          name: "lookup_issue",
          description: "x",
          inputSchema: { type: "object" },
        },
      ],
    });
    expect(refusals).toBe(0);
    expect(sent[0]?.thinking).toEqual({ type: "enabled" });
    expect(sent[0]?.messages.find((m) => m.tool_calls)?.reasoning_content).toBe(
      "",
    );
  });
});

describe("诊断：含 reasoning_content 的 400 在日志里带请求体形状", () => {
  const SECRET = "机密正文-不能进日志";

  async function logged(error: unknown, bodyless = false): Promise<unknown> {
    const lines: string[] = [];
    const original = console.error;
    console.error = (line: unknown) => {
      lines.push(String(line));
    };
    try {
      await new Promise<void>((resolve) => {
        sayingProviderRefusals(
          new Observable<BaseEvent>((subscriber) => {
            if (bodyless)
              subscriber.next({
                type: "RUN_ERROR",
                message: `Error code: 400 - ${REFUSAL}`,
              } as BaseEvent);
            else subscriber.error(error);
            subscriber.complete();
          }),
          { id: "bot" },
          { provider: "DeepSeek", signIn: false },
        ).subscribe({ complete: resolve, error: () => resolve() });
      });
    } finally {
      console.error = original;
    }
    const line = lines.find((entry) =>
      entry.includes("model-provider-refused"),
    );
    expect(line).toBeDefined();
    expect(line).not.toContain(SECRET);
    return JSON.parse(line as string);
  }

  const apiError = (requestBodyValues: unknown) =>
    new APICallError({
      message: REFUSAL,
      url: CHAT,
      requestBodyValues,
      statusCode: 400,
      responseBody: JSON.stringify({ error: { message: REFUSAL } }),
    });

  test("数出带 tool_calls 缺字段的条数和下标，不带内容", async () => {
    const entry = (await logged(
      apiError({
        model: "deepseek-flash",
        thinking: { type: "enabled" },
        messages: [
          { role: "system", content: SECRET },
          { role: "user", content: SECRET },
          { role: "assistant", content: SECRET },
          toolTurn(SECRET),
          { role: "tool", content: SECRET },
          { ...toolTurn(), content: SECRET },
          { role: "assistant", content: SECRET },
          toolTurn(),
        ],
      }),
    )) as { reasoningDiagnosis: unknown; status: number };
    expect(entry.status).toBe(400);
    expect(entry.reasoningDiagnosis).toEqual({
      thinking: "enabled",
      assistantMessages: 5,
      withToolCalls: 3,
      toolCallsMissingReasoning: 2,
      toolCallsMissingReasoningAt: [5, 7],
    });
  });

  test("请求没写 thinking 记为 absent；有字段的不算缺", async () => {
    const entry = (await logged(apiError({ messages: [toolTurn("")] }))) as {
      reasoningDiagnosis: unknown;
    };
    expect(entry.reasoningDiagnosis).toEqual({
      thinking: "absent",
      assistantMessages: 1,
      withToolCalls: 1,
      toolCallsMissingReasoning: 0,
      toolCallsMissingReasoningAt: [],
    });
  });

  test("拿不到请求体（被截断的字符串、只有文字的 RUN_ERROR）写 bodyUnavailable", async () => {
    const truncated = (await logged(
      apiError('{"messages":[{"role":"assi'),
    )) as {
      reasoningDiagnosis: unknown;
    };
    expect(truncated.reasoningDiagnosis).toEqual({ bodyUnavailable: true });
    const text = (await logged(undefined, true)) as {
      reasoningDiagnosis: unknown;
    };
    expect(text.reasoningDiagnosis).toEqual({ bodyUnavailable: true });
  });

  test("不含 reasoning_content 的 400 不加诊断", async () => {
    const entry = (await logged(
      new APICallError({
        message: "bad request",
        url: CHAT,
        requestBodyValues: { messages: [] },
        statusCode: 400,
        responseBody: '{"error":{"message":"bad request"}}',
      }),
    )) as Record<string, unknown>;
    expect("reasoningDiagnosis" in entry).toBe(false);
  });
});

describe("回放：员工没有自己授予的工具，服务器执行路径多段续跑", () => {
  let calls = 0;
  const lookups: string[] = [];
  const server = {
    definition: {
      name: "srv_lookup",
      description: "lookup",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    },
    execute: async (args: { id: string }) => {
      lookups.push(args.id);
      return JSON.stringify({ id: args.id, ok: true });
    },
  };
  const srvCall = (id: string, reasoning: string): Answer => ({
    toolCalls: [
      {
        name: "srv_lookup",
        arguments: JSON.stringify({ id }),
        id: `call_${++calls}`,
      },
    ],
    reasoning,
  });
  const thinker: RegisteredAgent = {
    id: "thinker",
    name: "Thinker",
    type: "built_in",
    systemPrompt: "Look things up.",
  };
  const deepSeek: RuntimeModel = {
    provider: "openai",
    defaultModel: "deepseek-v4-flash",
  };

  async function serverChat(text: string, history: Message[] = []) {
    const agent = await createActorAgentResolver({
      loadAgents: async () => [thinker],
      model: deepSeek,
      resolveModelApiKey: async () => "synthetic-key",
      loadToolsForActor: () => async () => [],
    }).resolveAgentForActor({ id: "owner", role: "user" }, thinker.id);
    const run = agent.clone() as AbstractAgent;
    run.use(new HeadlessToolsMiddleware([server as never]));
    run.threadId = "thread-replay";
    run.setMessages([
      ...history,
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

  const reasoningOfToolTurns = (body: Body | undefined) =>
    (body?.messages ?? [])
      .filter(
        (m) =>
          m.role === "assistant" &&
          Array.isArray(m.tool_calls) &&
          m.tool_calls.length > 0,
      )
      .map((m) => m.reasoning_content);

  test("第二、三段请求里上一步的 reasoning_content 是真实思考，不是空串", async () => {
    calls = 0;
    deepSeekSays([
      srvCall("A", "想一想-1"),
      srvCall("B", "想一想-2"),
      { content: "好了", reasoning: "想一想-3" },
    ]);
    const { events } = await serverChat("go");
    expect(events.some((event) => event.type === "RUN_ERROR")).toBe(false);
    expect(refusals).toBe(0);
    expect(sent).toHaveLength(3);
    expect(reasoningOfToolTurns(sent[1])).toEqual(["想一想-1"]);
    expect(reasoningOfToolTurns(sent[2])).toEqual(["想一想-1", "想一想-2"]);
  });

  test("下一轮对话带着存下的历史，续跑发的仍是原来的思考", async () => {
    calls = 0;
    deepSeekSays([
      srvCall("A", "第一轮的思考"),
      { content: "ok", reasoning: "x" },
    ]);
    const first = await serverChat("go");
    sent = [];
    deepSeekSays([{ content: "ok2", reasoning: "y" }]);
    await serverChat("再来", first.messages as Message[]);
    expect(reasoningOfToolTurns(sent[0])).toEqual(["第一轮的思考"]);
  });
});
