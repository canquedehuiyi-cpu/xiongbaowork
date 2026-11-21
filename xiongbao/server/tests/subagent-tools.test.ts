import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AbstractAgent } from "@ag-ui/client";
import { type ChatCompletionRequest, LLMock } from "@copilotkit/aimock";
import { z } from "zod";
import { OFFER_CHECK_IN_TOOL } from "../../shared/check-in-offer";
import { SHOW_APP_ACCESS_TOOL } from "../../shared/connect-prompt";
import { SUBAGENT_TOOL, SUBAGENT_WITHOUT_TOOLS } from "../../shared/subagent";
import { createActorAgentResolver } from "../src/agents/agent-resolver";
import type { GrantedTool } from "../src/plugins/tools";
import {
  ACCEPT_TASK,
  DELIVER_TASK,
  deliveryProtocolGuidance,
  REQUEST_EXTENSION,
} from "../src/tasks/delivery-tools";

/*
 * 子代理是同一位员工再跑一遍，只干一件事。它每一步都要把工具定义重发一遍，所以不带只属于「那段对话」的工具
 * （接活、交付、延期、跟进、签到邀请、应用权限卡），提示里「交付四条规矩」也跟着工具不再出现。其余照旧。
 */

let llm: LLMock;
const saved: Record<string, string | undefined> = {};
/** 每次模型请求收到的工具名和系统提示。 */
let requests: { tools: string[]; held: string[]; system: string }[];

beforeEach(async () => {
  llm = new LLMock({ host: "127.0.0.1", port: 0 });
  requests = [];
  llm.on({ predicate: () => true }, (request: ChatCompletionRequest) => {
    const body = request as unknown as {
      tools?: { function?: { name?: string; description?: string } }[];
      messages: { role: string; content?: unknown }[];
    };
    const tools = (body.tools ?? []).map((tool) => tool.function?.name ?? "");
    // 瘦身开着时（默认），偶尔才用的工具排在 search_tools 后面，描述里用一行说有哪几类（不再逐个列名字）：
    // 员工「持有」它们，只是首步没把定义发出去。持有的 = 发出去的 + 描述里有它那一类的。
    const categories = (
      (body.tools ?? []).find((tool) => tool.function?.name === "search_tools")
        ?.function?.description ?? ""
    )
      .split("Load unlisted tools:")[1]
      ?.split(". Say")[0]
      ?.split(",")
      .map((label) => label.trim());
    const waiting = Object.entries(CATEGORY_OF)
      .filter(
        ([name, label]) =>
          !tools.includes(name) && categories?.includes(label) === true,
      )
      .map(([name]) => name);
    requests.push({
      tools,
      held: [...tools, ...(waiting ?? [])],
      system: body.messages
        .filter((message) => ["system", "developer"].includes(message.role))
        .map((message) => String(message.content))
        .join("\n"),
    });
    return { content: "好了。" };
  });
  saved.OPENAI_BASE_URL = process.env.OPENAI_BASE_URL;
  saved.XIONGBAO_PROMPT_SLIM = process.env.XIONGBAO_PROMPT_SLIM;
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

/** 这个测试里用到的、排在 search_tools 后面的工具各属于描述里的哪一类。 */
const CATEGORY_OF: Record<string, string> = {
  request_extension: "extension",
  schedule_follow_up: "reminders",
  list_follow_ups: "reminders",
  cancel_follow_up: "reminders",
  offer_check_in: "reminders",
  show_app_access: "access card",
  request_app_access: "app access",
  recall_personal_memory: "memory",
};

/** 只在员工持有 `accept_task` 时才说的那几条交付规矩里的一句。 */
const protocolLine = (deliveryProtocolGuidance([ACCEPT_TASK]) ?? "")
  .split("\n")
  .find((line) => line.trim().length > 20);

const conversationTools = [
  ACCEPT_TASK,
  DELIVER_TASK,
  REQUEST_EXTENSION,
  "schedule_follow_up",
  "list_follow_ups",
  "cancel_follow_up",
  OFFER_CHECK_IN_TOOL,
  SHOW_APP_ACCESS_TOOL,
];
const workTools = [
  "web_fetch",
  "update_plan",
  "recall_personal_memory",
  "request_app_access",
];

/** 这位员工的一次运行：模型收到了什么工具、什么系统提示。 */
async function modelSaw(options: { subagent: boolean }, slim = "on") {
  process.env.XIONGBAO_PROMPT_SLIM = slim;
  const resolver = createActorAgentResolver({
    loadAgents: async () => [
      { id: "bot", name: "员工", type: "built_in", systemPrompt: "做事。" },
    ],
    model: { provider: "openai", defaultModel: "gpt-5.5" },
    resolveModelApiKey: async () => "test-key",
    loadToolsForActor: () => async () =>
      [...conversationTools, ...workTools].map(stub),
    handoffForActor: () => async () => [stub(SUBAGENT_TOOL)],
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
  run.setMessages([{ id: "ask", role: "user", content: "做这一件事。" }]);
  await run.runAgent({}, { onEvent: () => undefined });
  const seen = requests.at(-1);
  if (!seen) throw new Error("the model was never asked");
  return seen;
}

describe("子代理带的工具", () => {
  test("清单里的名字就是服务器真正给员工的那几个", () => {
    expect(new Set(SUBAGENT_WITHOUT_TOOLS)).toEqual(new Set(conversationTools));
  });

  // 用户 2026-11-20 批准：瘦身默认开。「带着」改成「持有」：发出去的加上排在 search_tools 后面的；
  // 关着（off）时两者相同，原断言的意图不变。
  test.each(["on", "off"])(
    "员工自己的一轮带全套：接活交付、跟进、签到邀请、应用权限卡都在，交付规矩也在（瘦身 %s）",
    async (slim) => {
      const seen = await modelSaw({ subagent: false }, slim);
      for (const name of [...conversationTools, ...workTools])
        expect(seen.held).toContain(name);
      expect(seen.tools).toContain(SUBAGENT_TOOL);
      expect(protocolLine).toBeTruthy();
      expect(seen.system).toContain(protocolLine as string);
    },
  );

  test.each(["on", "off"])(
    "子代理不带只属于那段对话的工具，干活要用的都在，提示里持有接活才说的交付规矩也没有了（瘦身 %s）",
    async (slim) => {
      const seen = await modelSaw({ subagent: true }, slim);
      for (const name of conversationTools)
        expect(seen.held).not.toContain(name);
      for (const name of workTools) expect(seen.held).toContain(name);
      expect(seen.tools).not.toContain(SUBAGENT_TOOL);
      expect(seen.system).not.toContain(protocolLine as string);
      expect(seen.system).not.toContain(ACCEPT_TASK);
    },
  );
});
