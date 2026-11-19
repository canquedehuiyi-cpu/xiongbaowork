import { afterEach, describe, expect, test } from "bun:test";
import {
  deepSeekThinkingOff,
  installDeepSeekThinkingOff,
  withThinkingDisabled,
} from "../src/models/deepseek-thinking";

/**
 * DeepSeek 的思考模式默认开着。请求带 `tools` 时，它要求把之前每一轮的 `reasoning_content` 原样传回，
 * 否则返回 400：「The `reasoning_content` in the thinking mode must be passed back to the API」。
 * 员工的对话历史不存思考内容，所以群聊、审批后继续、任何有前文的带工具对话都会失败。
 *
 * 修法：发往 api.deepseek.com 的 chat/completions 请求显式带上 `thinking: { type: "disabled" }`。
 */

const URL_CHAT = "https://api.deepseek.com/v1/chat/completions";
const body = (value: unknown) => JSON.stringify(value);
const parsed = (init: RequestInit | undefined) =>
  JSON.parse(String(init?.body));

describe("withThinkingDisabled", () => {
  test("发往 DeepSeek 的 chat/completions 请求加上 thinking disabled", () => {
    const init = withThinkingDisabled(URL_CHAT, {
      method: "POST",
      body: body({ model: "deepseek-flash", messages: [], tools: [] }),
    });
    expect(parsed(init)).toEqual({
      model: "deepseek-flash",
      messages: [],
      tools: [],
      thinking: { type: "disabled" },
    });
  });

  test("不带 /v1 的地址、Request 对象和 URL 对象一样处理", () => {
    for (const target of [
      "https://api.deepseek.com/chat/completions",
      new URL(URL_CHAT),
      new Request(URL_CHAT, { method: "POST" }),
    ]) {
      const init = withThinkingDisabled(target, {
        method: "POST",
        body: body({ model: "deepseek-flash" }),
      });
      expect(parsed(init).thinking).toEqual({ type: "disabled" });
    }
  });

  test("请求里已经写了 thinking，就照写的发，不改", () => {
    const init = withThinkingDisabled(URL_CHAT, {
      method: "POST",
      body: body({ model: "deepseek-flash", thinking: { type: "enabled" } }),
    });
    expect(parsed(init).thinking).toEqual({ type: "enabled" });
  });

  test("别的主机、别的路径、GET、非 JSON 正文都不碰", () => {
    const untouched: [string, RequestInit][] = [
      [
        "https://api.openai.com/v1/chat/completions",
        { method: "POST", body: body({ model: "gpt" }) },
      ],
      [
        "https://api.deepseek.com.evil.example/v1/chat/completions",
        { method: "POST", body: body({ model: "x" }) },
      ],
      ["https://api.deepseek.com/v1/models", { method: "GET" }],
      [
        "https://api.deepseek.com/v1/embeddings",
        { method: "POST", body: body({ input: "x" }) },
      ],
      [URL_CHAT, { method: "POST", body: "not json" }],
      [URL_CHAT, { method: "POST", body: body([1, 2]) }],
    ];
    for (const [url, init] of untouched) {
      expect(withThinkingDisabled(url, init)).toBe(init);
    }
  });
});

describe("deepSeekThinkingOff", () => {
  test("默认关闭思考；DEEPSEEK_THINKING=enabled 时保留 DeepSeek 自己的默认", () => {
    expect(deepSeekThinkingOff({})).toBe(true);
    expect(deepSeekThinkingOff({ DEEPSEEK_THINKING: "disabled" })).toBe(true);
    expect(deepSeekThinkingOff({ DEEPSEEK_THINKING: " Enabled " })).toBe(false);
  });
});

describe("installDeepSeekThinkingOff", () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });

  test("装上以后，经全局 fetch 发往 DeepSeek 的请求带上 thinking disabled，其余请求原样发出", async () => {
    const seen: { url: string; body: unknown }[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      seen.push({
        url: String(input instanceof Request ? input.url : input),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return new Response("{}");
    }) as typeof fetch;

    expect(installDeepSeekThinkingOff({})).toBe(true);
    await fetch(URL_CHAT, { method: "POST", body: body({ model: "m" }) });
    await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      body: body({ model: "m" }),
    });
    expect(seen).toEqual([
      { url: URL_CHAT, body: { model: "m", thinking: { type: "disabled" } } },
      {
        url: "https://api.openai.com/v1/chat/completions",
        body: { model: "m" },
      },
    ]);
  });

  test("DEEPSEEK_THINKING=enabled 时什么都不装", () => {
    const before = globalThis.fetch;
    expect(installDeepSeekThinkingOff({ DEEPSEEK_THINKING: "enabled" })).toBe(
      false,
    );
    expect(globalThis.fetch).toBe(before);
  });
});

describe("真实的 AI SDK 客户端也经过这一层", () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });

  /** 内置员工（CopilotKit 按 `openai/<模型>` 建的 chat 模型）和员工绑定的模型（openai-compatible）两条路。 */
  test("openai chat 模型与 openai-compatible 模型发往 DeepSeek 的请求都带上 thinking disabled", async () => {
    const { createOpenAI } = await import("@ai-sdk/openai");
    const { createOpenAICompatible } = await import(
      "@ai-sdk/openai-compatible"
    );
    const { generateText } = await import("ai");
    const bodies: unknown[] = [];
    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({
          id: "x",
          object: "chat.completion",
          created: 0,
          model: "deepseek-flash",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "好" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    installDeepSeekThinkingOff({});

    const builtIn = createOpenAI({
      apiKey: "k",
      baseURL: "https://api.deepseek.com/v1",
    }).chat("deepseek-flash");
    const bound = createOpenAICompatible({
      name: "deepseek",
      apiKey: "k",
      baseURL: "https://api.deepseek.com/v1",
    }).chatModel("deepseek-flash");
    for (const model of [builtIn, bound]) {
      await generateText({ model, prompt: "你好" });
    }
    expect(bodies).toHaveLength(2);
    for (const sent of bodies) {
      expect((sent as { thinking?: unknown }).thinking).toEqual({
        type: "disabled",
      });
    }
  });
});
