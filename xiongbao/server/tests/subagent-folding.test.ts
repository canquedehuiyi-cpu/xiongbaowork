import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AbstractAgent } from "@ag-ui/client";
import { type ChatCompletionRequest, LLMock } from "@copilotkit/aimock";
import { z } from "zod";
import {
  FOLD_BUDGET_ENV,
  FOLDED_PREFIX,
} from "../../toolkit/src/runtime/turn-folding";
import { createActorAgentResolver } from "../src/agents/agent-resolver";
import { languageModelFor } from "../src/models/runtime-resolver";
import type { GrantedTool } from "../src/plugins/tools";

/*
 * 一轮之内的折叠（`turn-folding.ts`）只看发给模型的那一份提示，员工的一轮和子代理的一轮建出来是同一个员工，
 * 所以两边一样。折叠以前只认 v3 规格的模型；除了 DeepSeek 官方地址，OpenAI 兼容的提供方（自定义地址、Moonshot、
 * 智谱、OpenRouter）建出来的是 v2 规格，它们的运行一直没折过。这里用真的 v2 模型（`languageModelFor`）跑员工和子代理。
 */

const COMPAT = "https://api.openai.com/v1";
const realFetch = globalThis.fetch;
let llm: LLMock;
let base: string;
const saved: Record<string, string | undefined> = {};
/** 每次模型请求里，工具结果消息的文字，按请求排。 */
let toolTexts: string[][];

const STEPS = 9;
const PAGE = "word ".repeat(2_400);

beforeEach(async () => {
  llm = new LLMock({ host: "127.0.0.1", port: 0 });
  toolTexts = [];
  llm.on({ predicate: () => true }, (request: ChatCompletionRequest) => {
    const messages = (
      request as unknown as { messages: { role: string; content?: unknown }[] }
    ).messages;
    const results = messages
      .filter((message) => message.role === "tool")
      .map((message) => String(message.content));
    toolTexts.push(results);
    if (results.length >= STEPS) return { content: "读完了。" };
    return {
      toolCalls: [
        {
          name: "read_page",
          arguments: JSON.stringify({ n: results.length }),
          id: `call_${results.length}`,
        },
      ],
    };
  });
  base = await llm.start();
  // 请求照常发往提供方的地址，由这里转给假模型。
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    return realFetch(
      url.startsWith(COMPAT) ? url.replace(COMPAT, `${base}/v1`) : input,
      init,
    );
  }) as typeof fetch;
  saved[FOLD_BUDGET_ENV] = process.env[FOLD_BUDGET_ENV];
  // 一页约 3 千 token：预算 1 万，读到第四五页就越线。
  process.env[FOLD_BUDGET_ENV] = "10000";
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  await llm.stop();
  if (saved[FOLD_BUDGET_ENV] === undefined) delete process.env[FOLD_BUDGET_ENV];
  else process.env[FOLD_BUDGET_ENV] = saved[FOLD_BUDGET_ENV];
});

const readPage: GrantedTool = {
  name: "read_page",
  ref: "bot/read_page",
  description: "Read page n.",
  parameters: z.object({ n: z.number() }),
  execute: async (args) => `第 ${(args as { n: number }).n} 页：${PAGE}`,
};

/** 这位员工读完 {@link STEPS} 页：作为员工自己的一轮，或作为子代理。 */
async function readThePages(options: { subagent: boolean }) {
  const resolver = createActorAgentResolver({
    loadAgents: async () => [
      { id: "bot", name: "员工", type: "built_in", systemPrompt: "读页。" },
    ],
    model: { provider: "openai", defaultModel: "unused" },
    resolveModelApiKey: async () => "test-key",
    // 规格 v2 的聊天模型，和自定义地址、Moonshot、智谱这些提供方一样。
    resolveAgentModel: async () =>
      languageModelFor("custom", null, "compat-model", "test-key"),
    loadToolsForActor: () => async () => [readPage],
  });
  const agent = (await resolver.resolveAgentForActor(
    { id: "owner", role: "user" },
    "bot",
    {
      initiator: { kind: "person" },
      ...(options.subagent ? { subagent: true } : {}),
    },
  )) as AbstractAgent;
  const run = agent.clone();
  run.threadId = options.subagent ? "thread-sub" : "thread-main";
  run.setMessages([{ id: "ask", role: "user", content: "把每一页都读一遍。" }]);
  await run.runAgent({}, { onEvent: () => undefined });
  return toolTexts;
}

describe("规格 v2 的模型，员工和子代理的一轮都折叠", () => {
  for (const subagent of [false, true])
    test(subagent ? "子代理" : "员工自己的一轮", async () => {
      const requests = await readThePages({ subagent });
      expect(requests).toHaveLength(STEPS + 1);
      const last = requests.at(-1) as string[];
      expect(last).toHaveLength(STEPS);
      const folded = last.filter((text) => text.startsWith(FOLDED_PREFIX));
      // 较早的页折成了摘要，最近几页原样不动。
      expect(folded.length).toBeGreaterThan(0);
      expect(
        last.slice(-4).some((text) => text.startsWith(FOLDED_PREFIX)),
      ).toBe(false);
      expect(last.at(-1)).toContain(PAGE);
      // 第一次越线之前，一页都没折。
      expect(
        (requests[1] as string[]).some((text) =>
          text.startsWith(FOLDED_PREFIX),
        ),
      ).toBe(false);
    });

  test("预算设 0 关掉绝对预算：窗口按 128K 算，读这几页不越线，一页都不折", async () => {
    process.env[FOLD_BUDGET_ENV] = "0";
    const requests = await readThePages({ subagent: true });
    const last = requests.at(-1) as string[];
    expect(last).toHaveLength(STEPS);
    expect(last.some((text) => text.startsWith(FOLDED_PREFIX))).toBe(false);
  });
});
