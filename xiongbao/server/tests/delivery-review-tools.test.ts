import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AbstractAgent } from "@ag-ui/client";
import { type ChatCompletionRequest, LLMock } from "@copilotkit/aimock";
import { z } from "zod";
import { createActorAgentResolver } from "../src/agents/agent-resolver";
import type { GrantedTool } from "../src/plugins/tools";

/**
 * 评审子代理的工具集：只读那一档不带员工被授予的任何工具（写记忆、发文件、派活都没有），
 * 普通子代理照旧带。电脑上的读写由闸门另外拦（plan-approval.integration.test.ts 的只读线程）。
 */
let llm: LLMock;
let seenTools: string[];
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  llm = new LLMock({ host: "127.0.0.1", port: 0 });
  seenTools = [];
  llm.on({ predicate: () => true }, (request: ChatCompletionRequest) => {
    const body = request as unknown as {
      tools?: { function?: { name?: string } }[];
    };
    seenTools = (body.tools ?? []).map((tool) => tool.function?.name ?? "");
    return { content: "好了。" };
  });
  saved.OPENAI_BASE_URL = process.env.OPENAI_BASE_URL;
  // Every definition is sent, none left behind search_tools, so the list is the whole list.
  saved.XIONGBAO_PROMPT_SLIM = process.env.XIONGBAO_PROMPT_SLIM;
  process.env.XIONGBAO_PROMPT_SLIM = "off";
  process.env.OPENAI_BASE_URL = `${await llm.start()}/v1`;
});

afterEach(async () => {
  await llm.stop();
  if (saved.XIONGBAO_PROMPT_SLIM === undefined)
    delete process.env.XIONGBAO_PROMPT_SLIM;
  else process.env.XIONGBAO_PROMPT_SLIM = saved.XIONGBAO_PROMPT_SLIM;
  if (saved.OPENAI_BASE_URL === undefined) delete process.env.OPENAI_BASE_URL;
  else process.env.OPENAI_BASE_URL = saved.OPENAI_BASE_URL;
});

const stub = (name: string): GrantedTool => ({
  name,
  ref: `bot/${name}`,
  description: `The ${name} tool.`,
  parameters: z.object({}),
  execute: async () => "ok",
});

const granted = ["web_fetch", "recall_personal_memory", "generate_image"];

async function toolsOf(context: { subagent?: boolean; readOnly?: boolean }) {
  const resolver = createActorAgentResolver({
    loadAgents: async () => [
      { id: "bot", name: "员工", type: "built_in", systemPrompt: "做事。" },
    ],
    model: { provider: "openai", defaultModel: "gpt-5.5" },
    resolveModelApiKey: async () => "test-key",
    loadToolsForActor: () => async () => granted.map(stub),
  });
  const agent = (await resolver.resolveAgentForActor(
    { id: "owner", role: "user" },
    "bot",
    { initiator: { kind: "person" }, ...context },
  )) as AbstractAgent;
  const run = agent.clone();
  run.threadId = "thread-review";
  run.setMessages([{ id: "ask", role: "user", content: "评审一下。" }]);
  await run.runAgent({}, { onEvent: () => undefined });
  return seenTools;
}

describe("the tools of a subagent run", () => {
  test("an ordinary subagent holds what its employee was granted", async () => {
    const tools = await toolsOf({ subagent: true });
    for (const name of granted) expect(tools).toContain(name);
  });

  test("the reviewer holds none of it", async () => {
    const tools = await toolsOf({ subagent: true, readOnly: true });
    for (const name of granted) expect(tools).not.toContain(name);
  });
});
