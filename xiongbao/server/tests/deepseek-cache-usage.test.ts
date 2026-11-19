import { describe, expect, test } from "bun:test";
import type { LanguageModel } from "ai";
import { deepSeekLanguageModel } from "../src/models/deepseek-thinking";
import { normalizeUsage } from "../src/models/token-metering";

/**
 * DeepSeek reports prompt-cache use as `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` in `usage`,
 * and the client library reads only `prompt_tokens_details.cached_tokens`, so the metered cached input
 * of every DeepSeek call was zero. The model built for employees maps the two fields across.
 */

const prompt = [{ role: "user", content: [{ type: "text", text: "hi" }] }];

type Model = {
  doGenerate(options: unknown): Promise<{ usage: unknown }>;
  doStream(options: unknown): Promise<{
    stream: ReadableStream<{ type: string; usage?: unknown }>;
  }>;
};

function modelAnswering(
  respond: () => Response,
  requests: unknown[] = [],
): Model {
  return deepSeekLanguageModel({
    baseURL: "https://api.deepseek.com",
    apiKey: "test-key",
    modelName: "deepseek-chat",
    fetch: (async (_url: unknown, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      return respond();
    }) as unknown as typeof fetch,
  }) as unknown as Model;
}

const usageBlock = {
  prompt_tokens: 1200,
  completion_tokens: 30,
  total_tokens: 1230,
  prompt_cache_hit_tokens: 1024,
  prompt_cache_miss_tokens: 176,
};

function streamed(...chunks: unknown[]): Response {
  const body = `${chunks
    .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
    .join("")}data: [DONE]\n\n`;
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  });
}

async function finishOf(model: Model, options: object = {}) {
  const { stream } = await model.doStream({ prompt, ...options });
  const parts: { type: string; usage?: unknown }[] = [];
  const reader = stream.getReader();
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    parts.push(next.value);
  }
  return parts;
}

describe("DeepSeek prompt cache in the metered usage", () => {
  test("a non-streaming answer's cache hit is the cached input", async () => {
    const model = modelAnswering(() =>
      Response.json({
        id: "c1",
        model: "deepseek-chat",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "hello" },
            finish_reason: "stop",
          },
        ],
        usage: usageBlock,
      }),
    );
    const { usage } = await model.doGenerate({ prompt });
    expect(usage).toMatchObject({
      inputTokens: { total: 1200, cacheRead: 1024, noCache: 176 },
    });
    expect(normalizeUsage(usage)).toMatchObject({
      inputTokens: 1200,
      cachedInputTokens: 1024,
    });
  });

  test("a streamed answer's cache hit is the cached input, and raw chunks are not leaked to a caller that did not ask", async () => {
    const requests: unknown[] = [];
    const model = modelAnswering(
      () =>
        streamed(
          {
            id: "c1",
            model: "deepseek-chat",
            choices: [{ index: 0, delta: { content: "hel" } }],
          },
          {
            id: "c1",
            model: "deepseek-chat",
            choices: [
              { index: 0, delta: { content: "lo" }, finish_reason: "stop" },
            ],
            usage: usageBlock,
          },
        ),
      requests,
    );
    const parts = await finishOf(model);
    const finish = parts.find((part) => part.type === "finish");
    expect(normalizeUsage(finish?.usage)).toMatchObject({
      inputTokens: 1200,
      outputTokens: 30,
      cachedInputTokens: 1024,
    });
    expect(parts.some((part) => part.type === "raw")).toBe(false);
    expect(
      parts
        .filter((part) => part.type === "text-delta")
        .map((part) => (part as unknown as { delta: string }).delta)
        .join(""),
    ).toBe("hello");
    // The usage chunk is only sent when it is asked for; asking for raw chunks does not change that.
    expect(requests[0]).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  test("a caller that asks for raw chunks still gets them", async () => {
    const model = modelAnswering(() =>
      streamed({
        id: "c1",
        model: "deepseek-chat",
        choices: [{ index: 0, delta: { content: "x" }, finish_reason: "stop" }],
        usage: usageBlock,
      }),
    );
    const parts = await finishOf(model, { includeRawChunks: true });
    expect(parts.some((part) => part.type === "raw")).toBe(true);
  });

  test("an answer that reports no DeepSeek cache fields keeps what the library read", async () => {
    const model = modelAnswering(() =>
      streamed({
        id: "c1",
        model: "deepseek-chat",
        choices: [{ index: 0, delta: { content: "x" }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 50,
          completion_tokens: 2,
          total_tokens: 52,
          prompt_tokens_details: { cached_tokens: 32 },
        },
      }),
    );
    const finish = (await finishOf(model)).find(
      (part) => part.type === "finish",
    );
    expect(normalizeUsage(finish?.usage)).toMatchObject({
      inputTokens: 50,
      cachedInputTokens: 32,
    });
  });

  test("the model is still the one the runtime recognises", () => {
    const model: LanguageModel = deepSeekLanguageModel({
      baseURL: "https://api.deepseek.com",
      apiKey: "k",
      modelName: "deepseek-chat",
    });
    expect((model as { provider: string }).provider).toBe("deepseek.chat");
  });
});
