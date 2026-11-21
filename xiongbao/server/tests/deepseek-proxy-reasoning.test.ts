import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateText, type ModelMessage } from "ai";
import {
  isDeepSeekModelName,
  withToolTurnReasoning,
} from "../src/models/deepseek-thinking";
import { languageModelFor } from "../src/models/runtime-resolver";

/*
 * 经代理、OpenAI 兼容转发接的 DeepSeek 模型（评测的计量代理就是这样）：调过工具的那步没带
 * `reasoning_content`，DeepSeek 回 400，这一轮出错、被人追「继续」。这里管：名字是 DeepSeek 的模型，不在官方
 * 地址上也补上这个字段；别的模型的请求不动。
 */

type Body = { messages?: Record<string, unknown>[]; thinking?: unknown };

const received: Body[] = [];
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      received.push((await request.json()) as Body);
      return Response.json({
        id: "c1",
        object: "chat.completion",
        created: 0,
        model: "m",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "好。" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  });
});

afterAll(() => {
  server.stop(true);
});

/** 一段调过工具的历史：assistant 发了一个工具调用、没带思考，工具回了结果。 */
const history: ModelMessage[] = [
  { role: "user", content: "看下目录" },
  {
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "computer_run_command",
        input: { command: "ls" },
      },
    ],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "call_1",
        toolName: "computer_run_command",
        output: { type: "text", value: "a.txt" },
      },
    ],
  },
];

async function sentFor(modelName: string): Promise<Body> {
  received.length = 0;
  const model = languageModelFor(
    "custom",
    `http://127.0.0.1:${server.port}/v1`,
    modelName,
    "k",
    { allowPrivateHosts: true },
  );
  await generateText({ model, messages: history });
  const body = received[0];
  if (!body) throw new Error("nothing was sent");
  return body;
}

const toolTurn = (body: Body) =>
  body.messages?.find(
    (message) =>
      message.role === "assistant" && Array.isArray(message.tool_calls),
  );

describe("a DeepSeek model behind a proxy", () => {
  test("a tool turn without its thinking is sent with reasoning_content, and no thinking field is written", async () => {
    const body = await sentFor("deepseek-v4-flash");
    expect(toolTurn(body)?.reasoning_content).toBe("");
    expect("thinking" in body).toBe(false);
  });

  test("another model's tool turn is sent as it was", async () => {
    const body = await sentFor("gpt-4o-mini");
    expect(toolTurn(body)).toBeDefined();
    expect("reasoning_content" in (toolTurn(body) ?? {})).toBe(false);
  });
});

describe("withToolTurnReasoning", () => {
  test("fills only tool turns that carry no thinking; keeps what is there", () => {
    const body = {
      model: "deepseek-v4-flash",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "answer" },
        { role: "assistant", tool_calls: [{ id: "a" }] },
        {
          role: "assistant",
          tool_calls: [{ id: "b" }],
          reasoning_content: "想过",
        },
      ],
    };
    const next = withToolTurnReasoning(body) as typeof body;
    expect(next.messages[1]).toEqual({ role: "assistant", content: "answer" });
    expect(next.messages[2]).toEqual({
      role: "assistant",
      tool_calls: [{ id: "a" }],
      reasoning_content: "",
    });
    expect(next.messages[3]?.reasoning_content).toBe("想过");
  });

  test("a body with nothing to fill is returned as it is", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    expect(withToolTurnReasoning(body)).toBe(body);
  });

  test("model names", () => {
    expect(isDeepSeekModelName("deepseek-v4-flash")).toBe(true);
    expect(isDeepSeekModelName("deepseek-ai/DeepSeek-V3")).toBe(true);
    expect(isDeepSeekModelName("kimi-k2")).toBe(false);
  });
});
