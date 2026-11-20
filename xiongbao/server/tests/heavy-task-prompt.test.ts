import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AbstractAgent } from "@ag-ui/client";
import { type ChatCompletionRequest, LLMock } from "@copilotkit/aimock";
import { createActorAgentResolver } from "../src/agents/agent-resolver";
import {
  configureHeavyTaskFacts,
  type HeavyTaskFacts,
} from "../src/agents/heavy-task";
import { createSubagents } from "../src/agents/subagent";

/*
 * 期 4 · Task 4.3：大型编码任务的建议确实进了这一轮的系统提示，并且只在该进的时候进。
 * 真的员工解析和真的运行，模型是本机的假服务。
 */

let llm: LLMock;
let systems: string[];
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  llm = new LLMock({ host: "127.0.0.1", port: 0 });
  systems = [];
  llm.on({ predicate: () => true }, (request: ChatCompletionRequest) => {
    const body = request as unknown as {
      messages: { role: string; content?: unknown }[];
    };
    systems.push(
      body.messages
        .filter((message) => ["system", "developer"].includes(message.role))
        .map((message) => String(message.content))
        .join("\n"),
    );
    return { content: "好了。" };
  });
  for (const key of ["OPENAI_BASE_URL", "XIONGBAO_HEAVY_TASK_ROUTING"])
    saved[key] = process.env[key];
  delete process.env.XIONGBAO_HEAVY_TASK_ROUTING;
  process.env.OPENAI_BASE_URL = `${await llm.start()}/v1`;
});

afterEach(async () => {
  configureHeavyTaskFacts(undefined);
  await llm.stop();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function systemFor(text: string, withSubagent = true): Promise<string> {
  const subagents = createSubagents({
    turn: {} as never,
    buildAgentFor: (async () => ({})) as never,
    withdrawApprovals: async () => undefined,
  });
  const resolver = createActorAgentResolver({
    loadAgents: async () => [
      { id: "bot", name: "评测员工", type: "built_in", systemPrompt: "做事。" },
    ],
    model: { provider: "openai", defaultModel: "gpt-5.5" },
    resolveModelApiKey: async () => "test-key",
    loadToolsForActor: () => async () => [],
    handoffForActor: () => async () =>
      withSubagent
        ? [
            subagents.toolForRun({
              actorId: "owner",
              botId: "bot",
              threadId: "t",
              initiator: { kind: "person" },
            } as never),
          ]
        : [],
  });
  const agent = (await resolver.resolveAgentForActor(
    { id: "owner", role: "user" },
    "bot",
    { initiator: { kind: "person" } },
  )) as AbstractAgent;
  const run = agent.clone();
  run.threadId = "thread-heavy";
  run.setMessages([{ id: "ask", role: "user", content: text }]);
  await run.runAgent({});
  const system = systems[0];
  if (!system) throw new Error("the model was never asked");
  return system;
}

const heavy = "把整个项目重构成 TypeScript，涉及 40 个文件";
const facts = (over: Partial<HeavyTaskFacts> = {}): HeavyTaskFacts => ({
  externalCoders: [],
  ...over,
});

describe("大型编码任务的建议进系统提示", () => {
  test("设了难任务模型：建议交给 run_subagent 的 hard", async () => {
    configureHeavyTaskFacts(async () =>
      facts({ hardModel: "deepseek-reasoner" }),
    );
    const system = await systemFor(heavy);
    expect(system).toContain("大型编码任务");
    expect(system).toContain("deepseek-reasoner");
  });

  test("没有难任务模型、有固定的 Codex：建议请本人转交", async () => {
    configureHeavyTaskFacts(async () =>
      facts({ externalCoders: [{ name: "小码", harness: "codex" }] }),
    );
    expect(await systemFor(heavy)).toContain("Codex「小码」");
  });

  test("都没有、不是大型任务、这一轮派不了子代理、开关关着：什么都不加", async () => {
    configureHeavyTaskFacts(async () => facts());
    expect(await systemFor(heavy)).not.toContain("大型编码任务");
    systems.length = 0;
    configureHeavyTaskFacts(async () => facts({ hardModel: "m" }));
    expect(await systemFor("修一下登录页面的 bug")).not.toContain(
      "大型编码任务",
    );
    systems.length = 0;
    expect(await systemFor(heavy, false)).not.toContain("大型编码任务");
    systems.length = 0;
    process.env.XIONGBAO_HEAVY_TASK_ROUTING = "off";
    expect(await systemFor(heavy)).not.toContain("大型编码任务");
  });
});
