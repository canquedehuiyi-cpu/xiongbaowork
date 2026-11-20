import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AbstractAgent } from "@ag-ui/client";
import { type ChatCompletionRequest, LLMock } from "@copilotkit/aimock";
import { HeadlessToolsMiddleware } from "@openbot/toolkit/headless-tools";
import { z } from "zod";
import { createActorAgentResolver } from "../src/agents/agent-resolver";
import { deepSeekLanguageModel } from "../src/models/deepseek-thinking";
import type { GrantedTool } from "../src/plugins/tools";

/*
 * 无头的一轮（看板派活）被切成很多次运行：模型要一个电脑工具，服务器执行，再从历史接着跑。收尾提醒以前只看
 * 「这一次运行」里写的计划、改的文件，于是模型在计划没做完、改完没验的时候一句话收尾，就真的收尾了，评测脚本要替人
 * 追「继续」。这里用 DeepSeek 的模型（规格 v3，收尾提醒生效的那一类）和真实的运行器，把整条链跑一遍：
 * 开关开着，提醒在同一轮里就收到，不用追；关掉两个开关，原样收尾。
 */

const realFetch = globalThis.fetch;
let llm: LLMock;
let base: string;
/** 每次模型请求：末尾那条消息的角色和文字、已有几个工具结果。 */
let seen: { role: string; text: string; results: number }[];
const saved: Record<string, string | undefined> = {};
const SWITCHES = ["XIONGBAO_NUDGE_WHOLE_TURN", "XIONGBAO_VERIFY_NUDGE"];

beforeEach(async () => {
  for (const name of SWITCHES) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  seen = [];
  llm = new LLMock({ host: "127.0.0.1", port: 0 });
  llm.on({ predicate: () => true }, (request: ChatCompletionRequest) => {
    const messages = (
      request as unknown as { messages: { role: string; content?: unknown }[] }
    ).messages;
    const last = messages.at(-1);
    const results = messages.filter(
      (message) => message.role === "tool",
    ).length;
    const text = typeof last?.content === "string" ? last.content : "";
    seen.push({ role: last?.role ?? "", text, results });
    const fresh =
      last?.role === "user" &&
      messages.filter((m) => m.role === "user").length > 1;
    const call = (name: string, args: unknown, id: string) => ({
      name,
      arguments: JSON.stringify(args),
      id,
    });
    if (results === 0)
      return {
        toolCalls: [
          call(
            "update_plan",
            {
              items: [
                { text: "新建 money.ts", status: "in_progress" },
                { text: "跑测试", status: "pending" },
              ],
            },
            "c_plan",
          ),
          call("computer_run_command", { command: "ls src" }, "c_ls"),
        ],
      };
    if (results === 2)
      return {
        toolCalls: [
          call(
            "computer_write_file",
            { path: "src/money.ts", contents: "x" },
            "c_write",
          ),
        ],
      };
    if (results === 3)
      return fresh
        ? {
            toolCalls: [
              call("computer_run_command", { command: "bun test" }, "c_test"),
            ],
          }
        : { content: "改好了。" };
    if (results === 4)
      return {
        toolCalls: [
          call(
            "update_plan",
            {
              items: [
                { text: "新建 money.ts", status: "done" },
                { text: "跑测试", status: "done" },
              ],
            },
            "c_done",
          ),
        ],
      };
    return { content: "全部做完，测试通过。" };
  });
  base = await llm.start();
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  await llm.stop();
  for (const name of SWITCHES)
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
});

const updatePlan: GrantedTool = {
  name: "update_plan",
  ref: "bot/update_plan",
  description: "Write the plan.",
  parameters: z.object({
    items: z.array(z.object({ text: z.string(), status: z.string() })),
  }),
  execute: async () => "已更新计划",
};

async function carriedOut() {
  const resolver = createActorAgentResolver({
    loadAgents: async () => [
      { id: "bot", name: "员工", type: "built_in", systemPrompt: "做事。" },
    ],
    model: { provider: "openai", defaultModel: "unused" },
    resolveModelApiKey: async () => "test-key",
    resolveAgentModel: async () =>
      deepSeekLanguageModel({
        baseURL: `${base}/v1`,
        apiKey: "test-key",
        modelName: "deepseek-chat",
      }),
    loadToolsForActor: () => async () => [updatePlan],
  });
  const agent = (await resolver.resolveAgentForActor(
    { id: "owner", role: "user" },
    "bot",
    { initiator: { kind: "person" } },
  )) as AbstractAgent;
  const run = agent.clone();
  const executed: string[] = [];
  const headless = (name: string) => ({
    definition: {
      name,
      description: name,
      parameters: { type: "object", properties: {} },
    },
    execute: async (args: unknown) => {
      executed.push(`${name}:${JSON.stringify(args)}`);
      return { ok: true };
    },
  });
  run.use(
    new HeadlessToolsMiddleware([
      headless("computer_run_command"),
      headless("computer_write_file"),
    ]),
  );
  run.threadId = "thread-nudges";
  run.setMessages([{ id: "ask", role: "user", content: "把重构做完。" }]);
  await run.runAgent({}, { onEvent: () => undefined });
  return executed;
}

describe("无头的一轮：收尾提醒看整轮", () => {
  test("默认：计划没做完、改完没验，一句话收尾会被提醒，在同一轮里把活做完", async () => {
    const executed = await carriedOut();
    // 收尾那一步之后多了一次请求：带着一条新的提醒，同时点出计划和没验。
    const nudged = seen.filter(
      (request) => request.role === "user" && request.results === 3,
    );
    expect(nudged).toHaveLength(1);
    expect(nudged[0]?.text).toContain("计划里还有 2 项没做完");
    expect(nudged[0]?.text).toContain("src/money.ts");
    expect(
      executed.some(
        (item) =>
          item.startsWith("computer_run_command:") && item.includes("bun test"),
      ),
    ).toBe(true);
    expect(seen.at(-1)?.results).toBe(5);
  });

  test("两个开关都关：一句话收尾就收尾，没有提醒，也没跑测试", async () => {
    process.env.XIONGBAO_NUDGE_WHOLE_TURN = "off";
    process.env.XIONGBAO_VERIFY_NUDGE = "off";
    const executed = await carriedOut();
    expect(
      seen.filter(
        (request) => request.role === "user" && request.results === 3,
      ),
    ).toHaveLength(0);
    expect(executed.some((item) => item.includes("bun test"))).toBe(false);
    expect(seen).toHaveLength(3);
  });

  test("只关改完必验：计划提醒仍在", async () => {
    process.env.XIONGBAO_VERIFY_NUDGE = "off";
    await carriedOut();
    const nudged = seen.filter(
      (request) => request.role === "user" && request.results === 3,
    );
    expect(nudged).toHaveLength(1);
    expect(nudged[0]?.text).toContain("计划里还有");
    expect(nudged[0]?.text).not.toContain("没有跑任何测试");
  });
});
