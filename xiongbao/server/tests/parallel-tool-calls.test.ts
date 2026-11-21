import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AbstractAgent } from "@ag-ui/client";
import { type ChatCompletionRequest, LLMock } from "@copilotkit/aimock";
import { HeadlessToolsMiddleware } from "@openbot/toolkit/headless-tools";
import { createActorAgentResolver } from "../src/agents/agent-resolver";
import {
  PARALLEL_TOOLS_ENV,
  SLIM_HOW_TO_WORK,
  SLIM_HOW_TO_WORK_SERIAL,
  slimWorkingGuidance,
} from "../src/agents/slim-guidance";
import { createHeadlessComputerTools } from "../src/computer/headless-tools";
import { languageModelFor } from "../src/models/runtime-resolver";

/*
 * 步数是输入 token 的乘数：员工每一步都把整段历史再发一遍，而 Codex 一次动作常常带多条命令。一步里发出
 * 好几个互不依赖的读取、搜索、命令，是最直接的省法。这个文件钉三件事：
 *  1. OpenAI 兼容的接口（DeepSeek 走的就是这条）一步多个工具调用，运行器在同一段里把它们都执行，结果一起带回；
 *  2. 系统提示 how_to_work 里明说「互不依赖的读取、搜索、命令放在同一步里一次发出」，开关 XIONGBAO_PARALLEL_TOOLS=off 换回原文；
 *  3. 只读的电脑工具（读文件、搜索、找文件、列目录）在同一步里并行执行，写和命令仍然一个接一个。
 */

const COMPAT = "https://api.openai.com/v1";
const realFetch = globalThis.fetch;
let llm: LLMock;
let requests: { tools: number; calls: number }[];
const saved = process.env[PARALLEL_TOOLS_ENV];

beforeEach(async () => {
  llm = new LLMock({ host: "127.0.0.1", port: 0 });
  requests = [];
  llm.on({ predicate: () => true }, (request: ChatCompletionRequest) => {
    const messages = (request as unknown as { messages: { role: string }[] })
      .messages;
    const tools = messages.filter((message) => message.role === "tool").length;
    requests.push({ tools, calls: requests.length });
    if (tools > 0) return { content: "三个都读完了。" };
    return {
      toolCalls: [1, 2, 3].map((n) => ({
        name: "probe",
        arguments: JSON.stringify({ n }),
        id: `call_${n}`,
      })),
    };
  });
  const base = await llm.start();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    return realFetch(
      url.startsWith(COMPAT) ? url.replace(COMPAT, `${base}/v1`) : input,
      init,
    );
  }) as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  await llm.stop();
  if (saved === undefined) delete process.env[PARALLEL_TOOLS_ENV];
  else process.env[PARALLEL_TOOLS_ENV] = saved;
});

describe("OpenAI 兼容的接口，一步多个工具调用", () => {
  test("三个调用在同一段里都执行，下一次请求带着三个结果，模型只被调用两次", async () => {
    const resolver = createActorAgentResolver({
      loadAgents: async () => [
        { id: "bot", name: "员工", type: "built_in", systemPrompt: "读。" },
      ],
      model: { provider: "openai", defaultModel: "unused" },
      resolveModelApiKey: async () => "test-key",
      resolveAgentModel: async () =>
        languageModelFor("custom", null, "compat-model", "test-key"),
      loadToolsForActor: () => async () => [],
    });
    const agent = (await resolver.resolveAgentForActor(
      { id: "owner", role: "user" },
      "bot",
      { initiator: { kind: "person" } },
    )) as AbstractAgent;
    const run = agent.clone();
    const executed: number[] = [];
    run.use(
      new HeadlessToolsMiddleware([
        {
          definition: {
            name: "probe",
            description: "Look.",
            parameters: {
              type: "object",
              properties: { n: { type: "number" } },
            },
          },
          execute: async (args) => {
            executed.push((args as { n: number }).n);
            return { ok: true };
          },
        },
      ]),
    );
    run.threadId = "thread-parallel";
    run.setMessages([{ id: "ask", role: "user", content: "读三个。" }]);
    await run.runAgent({}, { onEvent: () => undefined });
    expect(executed).toEqual([1, 2, 3]);
    expect(requests.map((request) => request.tools)).toEqual([0, 3]);
  });
});

describe("系统提示鼓励一步多个调用", () => {
  const section = () =>
    slimWorkingGuidance({ untrusted: "u", asking: "a" })[1] ?? "";

  test("默认的 how_to_work 明说：互不依赖的读取、搜索、命令放在同一步里一次发出", () => {
    delete process.env[PARALLEL_TOOLS_ENV];
    const text = slimWorkingGuidance({ untrusted: "u", asking: "a" }).join("");
    expect(text).toContain(SLIM_HOW_TO_WORK);
    expect(SLIM_HOW_TO_WORK).toContain("one reply");
    expect(SLIM_HOW_TO_WORK).toContain("commands");
    expect(SLIM_HOW_TO_WORK).toContain("not one per reply");
    expect(SLIM_HOW_TO_WORK.length).toBeGreaterThan(
      SLIM_HOW_TO_WORK_SERIAL.length,
    );
    // 依赖前一步结果的仍在后面；互不相关的修改可以同一步一起发（用户 2026-11-21 批准，和编辑指引一致）。
    expect(SLIM_HOW_TO_WORK).toContain("a step needing a result waits");
    expect(SLIM_HOW_TO_WORK).toContain("Independent edits may share a reply");
    expect(section()).toBeString();
  });

  test("XIONGBAO_PARALLEL_TOOLS=off：换回原来的写法", () => {
    process.env[PARALLEL_TOOLS_ENV] = "off";
    const text = slimWorkingGuidance({ untrusted: "u", asking: "a" }).join("");
    expect(text).toContain(SLIM_HOW_TO_WORK_SERIAL);
    expect(text).not.toContain(SLIM_HOW_TO_WORK);
  });
});

describe("只读的电脑工具并行执行", () => {
  const names = (concurrent: boolean) =>
    createHeadlessComputerTools({
      gateway: {} as never,
      seat: { botId: "probe-bot" } as never,
      actor: {} as never,
    })
      .filter((tool) => (tool.concurrent === true) === concurrent)
      .map((tool) => tool.definition.name);

  test("读文件、搜索、找文件、列目录可以和同一步的其他调用一起跑", () => {
    delete process.env[PARALLEL_TOOLS_ENV];
    const parallel = names(true);
    for (const name of [
      "computer_read_file",
      "computer_grep",
      "computer_glob",
      "computer_list_files",
    ])
      expect(parallel).toContain(name);
  });

  test("写文件、改文件、命令、浏览器动作仍然一个接一个", () => {
    delete process.env[PARALLEL_TOOLS_ENV];
    const serial = names(false);
    for (const name of [
      "computer_write_file",
      "computer_edit_file",
      "computer_run_command",
      "computer_click",
    ])
      expect(serial).toContain(name);
  });

  test("XIONGBAO_PARALLEL_TOOLS=off：全都不并行", () => {
    process.env[PARALLEL_TOOLS_ENV] = "off";
    expect(names(true)).toEqual([]);
  });
});
