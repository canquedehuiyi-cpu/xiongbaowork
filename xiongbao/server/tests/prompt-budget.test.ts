import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AbstractAgent } from "@ag-ui/client";
import { type ChatCompletionRequest, LLMock } from "@copilotkit/aimock";
import { z } from "zod";
import { computerGuidance } from "../../shared/bot-prompt";
import { SUBAGENT_TOOL } from "../../shared/subagent";
import { createActorAgentResolver } from "../src/agents/agent-resolver";
import { escalationTool } from "../src/agents/escalation";
import {
  DEFERRED_TOOLS,
  HIDDEN_TOOLS,
  promptSlimOn,
  TOOL_BRIEFS,
} from "../src/agents/prompt-slim";
import { slimComputerGuidance } from "../src/agents/slim-guidance";
import { createSubagents } from "../src/agents/subagent";
import { updatePlanTools } from "../src/agents/update-plan";
import { gitTools } from "../src/computer/git-tools";
import { createHeadlessComputerTools } from "../src/computer/headless-tools";
import type { GrantedTool } from "../src/plugins/tools";
import { deliveryTools } from "../src/tasks/delivery-tools";
import { webTools } from "../src/web/tools";

/*
 * 提示词体积守卫（期 1 补充 · 1.6）。
 *
 * 熊宝每一步都要把系统提示和工具定义整份发给模型，一道题 17 到 33 步，固定部分乘步数是输入 token 的大头。
 * 这里搭一轮「看板轮」：真的工具工厂（计划、联网、交付、提问、子代理）、真的电脑工具定义、真的提示词，
 * 其余偶尔才用的工具用同名的桩（它们排在检索后面，首步只出现名字）。把首步发出去的请求体读出来，
 * 数「系统提示 + 工具定义」的字符数。以后谁加一段提示词、一个常驻工具，超过上限这条测试就失败：
 * 先想想是不是该排在 search_tools 后面（`DEFERRED_TOOLS`），或者把话说短。
 */

/** 看板轮首步「系统提示 + 工具定义」的字符数上限。用户 2026-11-20 批准从 24K 收紧到 20K；本机实测约 19.8K。 */
const BUDGET_CHARS = 20_000;

let llm: LLMock;
let requests: {
  tools: { function?: { name?: string; description?: string } }[];
  system: string;
  bytes: number;
}[];
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  llm = new LLMock({ host: "127.0.0.1", port: 0 });
  requests = [];
  llm.on({ predicate: () => true }, (request: ChatCompletionRequest) => {
    const body = request as unknown as {
      tools?: { function?: { name?: string; description?: string } }[];
      messages: { role: string; content?: unknown }[];
    };
    const system = body.messages
      .filter((message) => ["system", "developer"].includes(message.role))
      .map((message) => String(message.content))
      .join("\n");
    requests.push({
      tools: body.tools ?? [],
      system,
      bytes: system.length + JSON.stringify(body.tools ?? []).length,
    });
    return { content: "好了。" };
  });
  for (const key of ["OPENAI_BASE_URL", "XIONGBAO_PROMPT_SLIM"])
    saved[key] = process.env[key];
  process.env.OPENAI_BASE_URL = `${await llm.start()}/v1`;
});

afterEach(async () => {
  await llm.stop();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const stub = (name: string): GrantedTool => ({
  name,
  ref: `bot/${name}`,
  description: `The ${name} tool, as the deployment words it for the model.`,
  parameters: z.object({ text: z.string().optional() }),
  execute: async () => "ok",
});

/** 真的电脑工具定义：看板轮上服务器给员工的那一批。 */
const computerDefinitions = createHeadlessComputerTools({
  gateway: {} as never,
  seat: { botId: "bot" } as never,
  actor: {
    id: "owner",
    userId: "owner",
    initiator: { kind: "person" },
  } as never,
  signIn: {} as never,
}).map((tool) => tool.definition);

/** 用真工厂造的那几个，加上其余同名的桩：员工默认手上的整套。 */
function grantedForBoardTurn(): GrantedTool[] {
  const real = [
    ...updatePlanTools(),
    // 期 4：Git 工作流四个工具，排在检索后面。
    ...gitTools({
      computer: async () => undefined,
      connectorTools: async () => [],
    }),
    ...webTools({ search: { problem: "x" }, scope: "owner:bot" }),
    ...deliveryTools({
      delivery: {} as never,
      gate: {} as never,
      board: {} as never,
      ownerUserId: "owner",
      agentId: "bot",
    }),
    escalationTool({
      from: {} as never,
      route: (async () => ({})) as never,
    }),
  ];
  const have = new Set(real.map((tool) => tool.name));
  const others = [
    "generate_image",
    "generate_video",
    "check_video",
    "schedule_follow_up",
    "list_follow_ups",
    "cancel_follow_up",
    "offer_check_in",
    "save_observed_memory",
    "remember_personal_fact",
    "recall_personal_memory",
    "forget_personal_memory",
    "request_app_access",
    "show_app_access",
    "host_list_folders",
    "save_learned_skill",
    "refine_skill",
    // token 第五轮（用户 2026-11-20 批准）：这两个也排在检索后面，夹具里补上同名的桩。
    "report_refusal",
    "update_heartbeat_checklist",
  ].filter((name) => !have.has(name));
  return [...real, ...others.map(stub)];
}

async function firstStep(
  extraTools: { name: string; description: string; parameters: unknown }[] = [],
) {
  const subagents = createSubagents({
    turn: {} as never,
    buildAgentFor: (async () => ({})) as never,
    withdrawApprovals: async () => undefined,
  });
  const resolver = createActorAgentResolver({
    loadAgents: async () => [
      {
        id: "bot",
        name: "评测员工",
        type: "built_in",
        systemPrompt: "把交代的工作一次做完。",
      },
    ],
    model: { provider: "openai", defaultModel: "gpt-5.5" },
    resolveModelApiKey: async () => "test-key",
    loadToolsForActor: () => async () => grantedForBoardTurn(),
    handoffForActor: () => async () => [
      subagents.toolForRun({
        actorId: "owner",
        botId: "bot",
        threadId: "t",
        initiator: { kind: "person" },
      } as never),
    ],
    computerGuidance: (holding) =>
      promptSlimOn()
        ? slimComputerGuidance(holding)
        : computerGuidance(holding),
  });
  const agent = (await resolver.resolveAgentForActor(
    { id: "owner", role: "user" },
    "bot",
    { initiator: { kind: "person" } },
  )) as AbstractAgent;
  const run = agent.clone();
  run.threadId = "thread-budget";
  run.setMessages([{ id: "ask", role: "user", content: "做这一件事。" }]);
  await run.runAgent({
    tools: [...computerDefinitions, ...extraTools] as never,
  });
  const first = requests[0];
  if (!first) throw new Error("the model was never asked");
  return first;
}

describe("看板轮首步的提示词体积", () => {
  test("瘦身开着（默认）：系统提示加工具定义不超过上限，核心工具常驻，其余排在 search_tools 后面", async () => {
    delete process.env.XIONGBAO_PROMPT_SLIM;
    const first = await firstStep();
    expect(first.bytes).toBeLessThanOrEqual(BUDGET_CHARS);

    const sent = first.tools.map((tool) => tool.function?.name ?? "");
    expect(sent).toContain("search_tools");
    // 干活的核心：命令、读写改文件、检索、联网、计划、交付、子代理、提问。
    for (const name of [
      "computer_run_command",
      "computer_read_file",
      "computer_write_file",
      "computer_edit_file",
      "computer_grep",
      "computer_glob",
      "computer_list_files",
      "web_search",
      "web_fetch",
      "update_plan",
      "accept_task",
      "deliver_task",
      "request_extension",
      SUBAGENT_TOOL,
      "ask_person",
    ])
      expect(sent).toContain(name);
    // 排在后面的不在首步的定义里，但名字都写在 search_tools 的描述里，模型凭名字就能取。
    const listing =
      first.tools.find((tool) => tool.function?.name === "search_tools")
        ?.function?.description ?? "";
    for (const name of Object.keys(DEFERRED_TOOLS)) {
      expect(sent).not.toContain(name);
    }
    for (const name of [
      "computer_navigate",
      "computer_snapshot",
      "generate_image",
      "schedule_follow_up",
      "recall_personal_memory",
      "save_learned_skill",
      "refine_skill",
    ])
      expect(listing).toContain(name);
    // 运行时的状态工具模型用不到。
    for (const name of HIDDEN_TOOLS) expect(sent).not.toContain(name);
  });

  test("看板无人值守的交付轮没有「回答格式」段；运行带了组件工具的轮（有人看）仍有，顺序照旧（用户 2026-11-20 批准）", async () => {
    delete process.env.XIONGBAO_PROMPT_SLIM;
    const board = await firstStep();
    expect(board.system).not.toContain("<answer_format>");
    expect(board.system).toContain("<sources>");
    expect(board.system).toContain("<subagents>");
    requests.length = 0;
    const watched = await firstStep([
      {
        name: "render_chart",
        description: "Draw a chart.",
        parameters: { type: "object", properties: {} },
      },
    ]);
    const order = [...watched.system.matchAll(/^<([a-z_]+)>$/gm)].map(
      (match) => match[1],
    );
    expect(order.indexOf("answer_format")).toBe(order.indexOf("sources") + 1);
    expect(order.indexOf("subagents")).toBe(order.indexOf("answer_format") + 1);
    expect(watched.system.split("<answer_format>")).toHaveLength(2);
    // 回退：XIONGBAO_HEADLESS_ANSWER_FORMAT=on 时看板轮也放。
    const saved = process.env.XIONGBAO_HEADLESS_ANSWER_FORMAT;
    process.env.XIONGBAO_HEADLESS_ANSWER_FORMAT = "on";
    requests.length = 0;
    try {
      expect((await firstStep()).system).toContain("<answer_format>");
    } finally {
      if (saved === undefined)
        delete process.env.XIONGBAO_HEADLESS_ANSWER_FORMAT;
      else process.env.XIONGBAO_HEADLESS_ANSWER_FORMAT = saved;
    }
  });

  test("关着瘦身（off）：和原来一样，整套工具首步都发，没有 search_tools，提示词是原文", async () => {
    process.env.XIONGBAO_PROMPT_SLIM = "off";
    const first = await firstStep();
    const sent = first.tools.map((tool) => tool.function?.name ?? "");
    expect(sent).not.toContain("search_tools");
    for (const name of [
      ...Object.keys(DEFERRED_TOOLS),
      "computer_run_command",
      "deliver_task",
      ...HIDDEN_TOOLS,
    ])
      expect(sent).toContain(name);
    // 共享的原文：provenance 段的头一句。
    expect(first.system).toContain(
      "Say where an answer came from. When you read it with one of your tools",
    );
    expect(first.bytes).toBeGreaterThan(BUDGET_CHARS);
  });

  test("每条短描述都对得上一个真实的工具，并且确实更短", async () => {
    delete process.env.XIONGBAO_PROMPT_SLIM;
    process.env.XIONGBAO_PROMPT_SLIM = "off";
    const full = await firstStep();
    const original = new Map(
      full.tools.map((tool) => [
        tool.function?.name ?? "",
        tool.function?.description ?? "",
      ]),
    );
    for (const [name, brief] of Object.entries(TOOL_BRIEFS)) {
      expect(original.has(name)).toBe(true);
      expect(brief.description.length).toBeLessThan(
        (original.get(name) ?? "").length,
      );
    }
  });
});
