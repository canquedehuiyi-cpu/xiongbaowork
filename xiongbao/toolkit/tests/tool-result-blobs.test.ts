import { describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/client";
import type { BuiltInAgentConfiguration } from "@copilotkit/runtime/v2";
import { BuiltInAgentWithSaneHistory } from "../src/runtime/agents";
import type { Prompt } from "../src/runtime/last-step";
import {
  BLOB_CHARS_PER_TOKEN,
  BLOB_MIN_CHARS,
  blobChars,
  blobNote,
  isBlob,
  screenshotNote,
  withoutBlobs,
  withoutToolBlobs,
} from "../src/tool-result-blobs";

/*
 * 工具结果里的二进制数据（截图的 base64）：发给模型之前换成说明，存起来的对话不动。
 */

/** 近似压缩过的图片编出来的 base64：六十四种字符都出现，顺序打乱，但每次一样。 */
function pngBase64(chars: number): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let state = 12345;
  let out = "iVBORw0KGgo";
  while (out.length < chars) {
    state = (state * 1103515245 + 12345) % 2147483648;
    out += alphabet[(state >>> 16) % 64];
  }
  return `${out.slice(0, chars - 1)}=`;
}

const screenshot = (chars = 400_000) =>
  JSON.stringify({
    ok: true,
    base64: pngBase64(chars),
    width: 1280,
    height: 800,
    capturedAt: "2026-11-20T00:00:00.000Z",
    url: "http://127.0.0.1/page",
  });

const tool = (id: string, content: string): Message => ({
  id: `result-${id}`,
  role: "tool",
  toolCallId: id,
  content,
});

describe("识别二进制数据", () => {
  test("够长、字符五花八门的 base64 算；短的不算", () => {
    expect(blobChars(screenshot())).toBeGreaterThan(399_000);
    // 4095 个 base64 字符加一个填充的 `=`：差一个字符到线，不算。
    expect(blobChars(`{"hash":"${pngBase64(BLOB_MIN_CHARS)}"}`)).toBe(0);
    expect(blobChars(pngBase64(BLOB_MIN_CHARS + 1))).toBe(BLOB_MIN_CHARS + 1);
  });

  test("一长串重复的字不算：分隔线、xxxx、0000 是普通文字", () => {
    for (const filler of ["x", "0", "A", "+", "ab"]) {
      const text = `前文${filler.repeat(50_000)}后文`;
      expect(blobChars(text)).toBe(0);
      expect(withoutBlobs(text)).toBe(text);
    }
    expect(isBlob("x".repeat(BLOB_MIN_CHARS))).toBe(false);
  });

  test("普通文字、中文、JSON 都不算", () => {
    const prose = "The quarterly report lists revenue and margin. ".repeat(500);
    expect(blobChars(prose)).toBe(0);
    expect(blobChars("你好，世界。".repeat(5_000))).toBe(0);
    expect(blobChars(JSON.stringify({ ok: true, stdout: prose }))).toBe(0);
  });

  test("估算：二进制数据的字符每 1.5 个一个 token", () => {
    expect(BLOB_CHARS_PER_TOKEN).toBe(1.5);
  });
});

describe("withoutBlobs", () => {
  test("二进制数据换成一句说明，别的字原样；没有二进制数据是同一个字符串", () => {
    const text = `前文${pngBase64(10_000)}后文`;
    expect(withoutBlobs(text)).toBe(`前文${blobNote(10_000)}后文`);
    const plain = "没有二进制数据";
    expect(withoutBlobs(plain)).toBe(plain);
  });
});

describe("withoutToolBlobs：发给模型的那一份", () => {
  test("截图结果里的 base64 换成说明，其余字段原样，仍是合法的 JSON", () => {
    const sent = withoutToolBlobs([tool("shot", screenshot())]);
    const content = (sent[0] as { content: string }).content;
    expect(content.length).toBeLessThan(500);
    const parsed = JSON.parse(content) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      ok: true,
      width: 1280,
      height: 800,
      url: "http://127.0.0.1/page",
    });
    expect(parsed.base64).toBe(screenshotNote(blobChars(screenshot())));
    // 说明里写明了图在哪、要看内容用什么。
    expect(String(parsed.base64)).toContain("computer_read");
    expect(String(parsed.base64)).toContain("computer_snapshot");
  });

  test("嵌在里面的截图（桌面窗口的 image.base64）一样换", () => {
    const nested = JSON.stringify({
      ok: true,
      image: { base64: pngBase64(50_000), width: 800, height: 600 },
      elements: [],
    });
    const content = (
      withoutToolBlobs([tool("win", nested)])[0] as {
        content: string;
      }
    ).content;
    expect(content).toContain("computer_read");
    expect(content.length).toBeLessThan(600);
    expect(JSON.parse(content).image.width).toBe(800);
  });

  test("别的二进制数据（网页里内嵌的 data URI、命令输出里的一大段）说「已省略」", () => {
    const page = `<img src="data:image/png;base64,${pngBase64(20_000)}"> 正文`;
    const content = (
      withoutToolBlobs([tool("page", page)])[0] as {
        content: string;
      }
    ).content;
    expect(content).toBe(
      `<img src="data:image/png;base64,${blobNote(20_000)}"> 正文`,
    );
  });

  test("存起来的那一份不动：输入的消息对象和数组一个字都没变", () => {
    const stored = [tool("shot", screenshot())];
    const before = JSON.stringify(stored);
    const sent = withoutToolBlobs(stored);
    expect(sent).not.toBe(stored);
    expect(sent[0]).not.toBe(stored[0]);
    expect(JSON.stringify(stored)).toBe(before);
  });

  test("没有二进制数据：返回同一个数组，每条消息还是同一个对象", () => {
    const messages: Message[] = [
      { id: "ask", role: "user", content: "查一下" },
      tool("a", JSON.stringify({ ok: true, stdout: "x".repeat(20_000) })),
      tool("b", "x".repeat(50_000)),
      { id: "say", role: "assistant", content: "好了。" },
    ];
    expect(withoutToolBlobs(messages)).toBe(messages);
  });

  test("只动工具结果；用户和助手消息里的长串不碰", () => {
    const blob = pngBase64(10_000);
    const messages: Message[] = [
      { id: "ask", role: "user", content: blob },
      { id: "say", role: "assistant", content: blob },
      tool("shot", screenshot(10_000)),
    ];
    const sent = withoutToolBlobs(messages);
    expect(sent[0]).toBe(messages[0] as Message);
    expect(sent[1]).toBe(messages[1] as Message);
    expect(sent[2]).not.toBe(messages[2] as Message);
  });

  test("重放确定：同一份历史每次换出同一个结果，新的一步只在末尾添加", () => {
    const history = [tool("1", screenshot()), tool("2", "ok")];
    const first = JSON.stringify(withoutToolBlobs(history));
    expect(JSON.stringify(withoutToolBlobs(history))).toBe(first);
    const longer = JSON.stringify(
      withoutToolBlobs([...history, tool("3", screenshot(90_000))]),
    );
    expect(longer.startsWith(first.slice(0, -1))).toBe(true);
  });
});

describe("接在员工的运行里", () => {
  function listening(seen: Prompt[]) {
    return {
      specificationVersion: "v3" as const,
      provider: "fake.chat",
      modelId: "fake-model",
      supportedUrls: {},
      doGenerate: async () => {
        throw new Error("Only streamed here.");
      },
      doStream: async (options: { prompt: Prompt }) => {
        seen.push(options.prompt);
        const parts = [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: "好了。" },
          { type: "text-end", id: "t" },
          {
            type: "finish",
            finishReason: { unified: "stop", raw: "stop" },
            usage: {
              inputTokens: {
                total: 1,
                noCache: 1,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: { total: 1, text: 1, reasoning: undefined },
            },
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

  const stored = () => [
    { id: "ask", role: "user" as const, content: "打开网页，截个图" },
    {
      id: "call-message",
      role: "assistant" as const,
      content: "",
      toolCalls: [
        {
          id: "call-1",
          type: "function" as const,
          function: { name: "computer_screenshot", arguments: "{}" },
        },
      ],
    },
    {
      id: "result-1",
      role: "tool" as const,
      toolCallId: "call-1",
      content: screenshot(),
    },
  ];

  async function run(hooks: Record<string, unknown> = {}) {
    const seen: Prompt[] = [];
    const agent = new BuiltInAgentWithSaneHistory(
      {
        model: listening(seen) as never,
        prompt: "查资料。",
        maxSteps: 3,
      } as BuiltInAgentConfiguration,
      { observe: (events: unknown) => events, ...hooks } as never,
    );
    agent.threadId = "thread";
    agent.setMessages(stored());
    await agent.runAgent({}, {});
    const prompt = seen[0];
    if (!prompt) throw new Error("The model was never asked.");
    return { sent: JSON.stringify(prompt), agent };
  }

  test("模型收到的提示里没有截图的 base64，只有说明；存起来的对话里还在", async () => {
    const { sent, agent } = await run();
    expect(sent).not.toMatch(/[A-Za-z0-9+/]{4096,}/);
    expect(sent).toContain("computer_read");
    expect(sent.length).toBeLessThan(5_000);
    const kept = agent.messages.find((message) => message.role === "tool");
    expect((kept as { content: string }).content).toBe(screenshot());
  });
});
