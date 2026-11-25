import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AbstractAgent, Message } from "@ag-ui/client";
import { type ChatCompletionRequest, LLMock } from "@copilotkit/aimock";
import { createTurnRunner } from "@xiongbao/toolkit/run-turn";
import {
  MOST_NUDGES,
  UNATTENDED_STEPS,
} from "@xiongbao/toolkit/runtime/last-step";
import { Observable } from "rxjs";
import { z } from "zod";
import {
  PLAN_GUIDANCE,
  type PlanItem,
  UPDATE_PLAN_TOOL,
} from "../../shared/plan";
import { createActorAgentResolver } from "../src/agents/agent-resolver";
import { UPDATE_PLAN_REF, updatePlanTools } from "../src/agents/update-plan";
import { toolDisabled } from "../src/approvals/policy";
import type { RuntimeModel } from "../src/copilot";
import type { GrantedTool } from "../src/plugins/tools";

/*
 * 期二「先计划、逐项推进」(spec 2026-11-19-codex-grade-employee §2): every Bot holds `update_plan`,
 * a checklist it writes before a job of several steps and ticks off as it goes; a run that stops with
 * an item of its own plan not done is sent back to work, as a run that ends on a promise is.
 *
 * Driven the way `runs-that-finish.test.ts` drives a run: the Bot built by the actor resolver, its
 * tools executed by the AI SDK, the model a real OpenAI-compatible HTTP server (aimock).
 */

const [planTool] = updatePlanTools();
if (!planTool) throw new Error("Expected the plan tool.");

const plan = (...items: [string, PlanItem["status"]][]) => ({
  items: items.map(([text, status]) => ({ text, status })),
});

describe("the plan tool", () => {
  test("takes a whole list and says so briefly", async () => {
    expect(planTool.name).toBe(UPDATE_PLAN_TOOL);
    expect(planTool.ref).toBe("bot/update_plan");
    expect(
      await planTool.execute(
        plan(
          ["读需求", "done"],
          ["写代码", "in_progress"],
          ["跑测试", "pending"],
        ),
      ),
    ).toBe("已更新计划：3 项，完成 1 项");
    // As a stored call carries it, too.
    expect(
      await planTool.execute(JSON.stringify(plan(["读需求", "pending"]))),
    ).toBe("已更新计划：1 项，完成 0 项");
  });

  test("a list of twenty is a plan, of twenty-one is answered in words", async () => {
    const items = (n: number) =>
      Array.from({ length: n }, (_, index) => ({
        text: `第 ${index + 1} 步`,
        status: "pending" as const,
      }));
    expect(await planTool.execute({ items: items(20) })).toBe(
      "已更新计划：20 项，完成 0 项",
    );
    const answer = await planTool.execute({ items: items(21) });
    expect(answer).toContain("计划没有更新");
    expect(answer).toContain("最多 20 项");
    expect(answer).toContain("21");
  });

  test("an empty list, or an item with no words, is answered in words", async () => {
    expect(await planTool.execute({ items: [] })).toContain("至少要有 1 项");
    const blank = await planTool.execute(
      plan(["读需求", "done"], ["   ", "pending"]),
    );
    expect(blank).toContain("计划没有更新");
    expect(blank).toContain("第 2 项");
    expect(blank).toContain("空");
    expect(
      await planTool.execute(plan(["长".repeat(200), "pending"])),
    ).toStartWith("已更新计划");
    expect(
      await planTool.execute(plan(["长".repeat(201), "pending"])),
    ).toContain("超过 200 字");
  });

  test("two items in progress at once are answered in words", async () => {
    const answer = await planTool.execute(
      plan(["读需求", "in_progress"], ["写代码", "in_progress"]),
    );
    expect(answer).toContain("计划没有更新");
    expect(answer).toContain("最多 1 项 in_progress");
  });

  test("arguments that are no list at all are answered, never thrown", async () => {
    for (const args of [undefined, null, "not json", {}, { items: "x" }])
      expect(await planTool.execute(args)).toContain("计划没有更新");
    expect(
      await planTool.execute({
        items: [{ text: "读需求", status: "started" }],
      }),
    ).toContain("status 只能是");
  });
});

describe("who holds it", () => {
  test("every Bot is granted it with the tools it needs to be itself", () => {
    const index = readFileSync(
      join(import.meta.dir, "..", "src", "index.ts"),
      "utf8",
    );
    const granted = index.slice(
      index.indexOf("const loadGrantedToolsForActor = async ("),
    );
    const body = granted.slice(0, granted.indexOf("\n  ];\n"));
    expect(body).toContain("...updatePlanTools(),");
  });

  test("a rule that switches it off for one Bot leaves it out of what that Bot is offered", () => {
    const deny = {
      id: "rule-plan",
      botId: "planner",
      toolRef: UPDATE_PLAN_REF,
      effect: "*",
      scope: "*",
      behaviour: "deny" as const,
    };
    const offered = (botId: string) =>
      updatePlanTools()
        .filter((tool) => !toolDisabled({ botId, toolRef: tool.ref }, [[deny]]))
        .map((tool) => tool.name);
    expect(offered("planner")).toEqual([]);
    expect(offered("someone-else")).toEqual([UPDATE_PLAN_TOOL]);
  });
});

const model: RuntimeModel = {
  provider: "openai",
  defaultModel: "gpt-5.6-terra",
};
const bot = {
  id: "planner",
  name: "Planner",
  type: "built_in" as const,
  systemPrompt: "Plan the cycle.",
};

let llm: LLMock;
let originalBase: string | undefined;
/** Every request the model was sent, in order, as the provider received it. */
let asked: ChatCompletionRequest[];
let lookups: string[];

beforeEach(async () => {
  llm = new LLMock();
  asked = [];
  lookups = [];
  originalBase = process.env.OPENAI_BASE_URL;
  process.env.OPENAI_BASE_URL = await llm.start();
});

afterEach(async () => {
  if (originalBase === undefined) delete process.env.OPENAI_BASE_URL;
  else process.env.OPENAI_BASE_URL = originalBase;
  await llm.stop();
});

type Answer =
  | { content: string }
  | { toolCalls: { name: string; arguments: string; id?: string }[] };

function modelAnswers(
  answer: (request: ChatCompletionRequest, index: number) => Answer,
) {
  llm.on({ predicate: () => true }, (request) => {
    asked.push(request);
    return answer(request, asked.length - 1);
  });
}

/** The model answering with these, in order, and "?" after them. */
function modelSays(script: Answer[]) {
  modelAnswers((_request, index) => script[index] ?? { content: "?" });
}

const lookup: GrantedTool = {
  name: "lookup_issue",
  description: "Look up one issue by its id.",
  parameters: z.object({ id: z.string() }),
  ref: "linear/lookup_issue",
  execute: async (args) => {
    const { id } = args as { id: string };
    lookups.push(id);
    return JSON.stringify({ id, title: `Issue ${id}`, state: "Todo" });
  },
};

function resolver(disabled: (ref: string) => boolean = () => false) {
  return createActorAgentResolver({
    loadAgents: async () => [bot],
    model,
    resolveModelApiKey: async () => "synthetic-key",
    loadToolsForActor: () => async () =>
      [lookup, ...updatePlanTools()].filter((tool) => !disabled(tool.ref)),
  });
}

async function chat(
  text: string,
  options: { history?: Message[]; disabled?: (ref: string) => boolean } = {},
): Promise<Message[]> {
  const agent = await resolver(options.disabled).resolveAgentForActor(
    { id: "owner", role: "user" },
    bot.id,
  );
  const run = agent.clone() as AbstractAgent;
  run.threadId = "thread-chat";
  run.setMessages([
    ...(options.history ?? []),
    { id: "ask", role: "user", content: text },
  ]);
  await run.runAgent({});
  return run.messages;
}

/** A routine's firing, through the headless turn runner, as the routine runner calls it. */
async function fire(instruction: string) {
  const runTurn = createTurnRunner({
    admission: async () => new AbortController().signal,
    intelligence: {
      getOrCreateThread: async () => undefined,
      getThreadMessages: async () => ({ messages: [] }),
      ɵacquireThreadLock: async () => undefined,
      ɵrenewThreadLock: async () => undefined,
      ɵcleanupThreadLock: async () => undefined,
    },
    runner: {
      run: ({ agent, input }) =>
        new Observable((subscriber) => {
          agent
            .runAgent(input, {
              onEvent: ({ event }) => subscriber.next(event),
            })
            .then(
              () => subscriber.complete(),
              (error) => subscriber.error(error),
            );
        }),
      stop: async () => true,
    },
    buildAgentFor: ({ ownerUserId, agentId, initiator }) =>
      resolver().resolveAgentForActor(
        { id: ownerUserId, role: "user" },
        agentId,
        { initiator },
      ),
  });
  return runTurn({
    ownerUserId: "owner",
    routineId: "routine-cycle",
    agentId: bot.id,
    threadId: "thread-routine",
    instruction,
    initiator: { kind: "routine", id: "routine-cycle" },
  });
}

let calls = 0;
const call = (name: string, args: unknown): Answer => ({
  toolCalls: [{ name, arguments: JSON.stringify(args), id: `call_${++calls}` }],
});
const planCall = (...items: [string, PlanItem["status"]][]) =>
  call(UPDATE_PLAN_TOOL, plan(...items));
const lookupCall = (id: string) => call(lookup.name, { id });

const lastMessage = (request: ChatCompletionRequest | undefined) =>
  JSON.stringify(request?.messages.at(-1) ?? null);
const nudged = () =>
  asked.filter((request) => lastMessage(request).includes("计划里还有"));
const offersTools = (request: ChatCompletionRequest) =>
  request.tool_choice !== "none";
const toolNames = (request: ChatCompletionRequest | undefined) =>
  (request?.tools ?? []).map((tool) => tool.function.name);

describe("a person's run with a plan", () => {
  test("is offered update_plan, unless a rule switched it off for this Bot", async () => {
    modelSays([{ content: "ENG-1 在 Todo。" }]);
    await chat("查一下 ENG-1。");
    expect(toolNames(asked[0])).toContain(UPDATE_PLAN_TOOL);

    asked = [];
    await chat("查一下 ENG-1。", {
      disabled: (ref) =>
        toolDisabled({ botId: bot.id, toolRef: ref }, [
          [
            {
              id: "rule-plan",
              botId: bot.id,
              toolRef: UPDATE_PLAN_REF,
              effect: "*",
              scope: "*",
              behaviour: "deny",
            },
          ],
        ]),
    });
    expect(toolNames(asked[0])).toContain(lookup.name);
    expect(toolNames(asked[0])).not.toContain(UPDATE_PLAN_TOOL);
  });

  test("is told how to plan while it holds update_plan, and not once a rule switched it off", async () => {
    modelSays([{ content: "ENG-1 在 Todo。" }, { content: "ENG-1 在 Todo。" }]);
    await chat("查一下 ENG-1。");
    const held = JSON.stringify(asked[0]?.messages ?? []);
    expect(held).toContain(`<plan>\\n${PLAN_GUIDANCE}\\n</plan>`);
    expect(held).toContain(
      "遇到需要多步才能完成的任务，先用 update_plan 列出计划。",
    );
    expect(held).toContain("开始做哪一项，就把它标成 in_progress");
    expect(held).toContain("做完一项，立刻标 done");
    expect(held).toContain("全部 done 后再给出总结");
    expect(held).toContain("一两步就能完成的简单问题，不用列计划");

    asked = [];
    await chat("查一下 ENG-1。", {
      disabled: (ref) => ref === UPDATE_PLAN_REF,
    });
    const switchedOff = JSON.stringify(asked[0]?.messages ?? []);
    expect(switchedOff).not.toContain("<plan>");
    expect(switchedOff).not.toContain(UPDATE_PLAN_TOOL);
    expect(switchedOff).not.toContain("列出计划");
  });

  test("that stops with an item not done is sent back, finishes it, and ends", async () => {
    modelSays([
      planCall(["查 ENG-1", "in_progress"], ["查 ENG-2", "pending"]),
      lookupCall("ENG-1"),
      planCall(["查 ENG-1", "done"], ["查 ENG-2", "in_progress"]),
      { content: "ENG-1 在 Todo。" },
      // Sent back: the plan still has 查 ENG-2.
      lookupCall("ENG-2"),
      planCall(["查 ENG-1", "done"], ["查 ENG-2", "done"]),
      { content: "两个都在 Todo：ENG-1 和 ENG-2。" },
    ]);

    const messages = await chat("查一下 ENG-1 和 ENG-2。");

    expect(asked).toHaveLength(7);
    expect(lookups).toEqual(["ENG-1", "ENG-2"]);
    // One nudge, naming what is left and the two ways out, in the person's language.
    expect(nudged()).toHaveLength(1);
    expect(asked.indexOf(nudged()[0] as ChatCompletionRequest)).toBe(4);
    expect(lastMessage(asked[4])).toContain(
      "计划里还有 1 项没做完：查 ENG-2，继续做，或者用 update_plan 说明为什么不做",
    );
    // The nudge was the model's alone; the conversation holds what the Bot said and did.
    expect(JSON.stringify(messages)).not.toContain("计划里还有");
    expect(messages.at(-1)).toMatchObject({
      role: "assistant",
      content: expect.stringContaining("两个都在 Todo"),
    });
  });

  test("keeps every plan it wrote in the conversation, as the chat reads it", async () => {
    modelSays([
      planCall(["查 ENG-1", "in_progress"]),
      lookupCall("ENG-1"),
      planCall(["查 ENG-1", "done"]),
      { content: "ENG-1 在 Todo。" },
    ]);

    const messages = await chat("查一下 ENG-1。");

    const plans = messages.flatMap((message) =>
      message.role === "assistant"
        ? (message.toolCalls ?? []).filter(
            (toolCall) => toolCall.function.name === UPDATE_PLAN_TOOL,
          )
        : [],
    );
    expect(
      plans.map((toolCall) => JSON.parse(toolCall.function.arguments)),
    ).toEqual([plan(["查 ENG-1", "in_progress"]), plan(["查 ENG-1", "done"])]);
    // And the tool's own answers, short.
    const answers = messages.filter(
      (message) =>
        message.role === "tool" &&
        plans.some((toolCall) => toolCall.id === message.toolCallId),
    );
    // The runtime keeps a tool's answer as the JSON of what it returned.
    expect(
      answers.map((message) => JSON.parse(String(message.content))),
    ).toEqual(["已更新计划：1 项，完成 0 项", "已更新计划：1 项，完成 1 项"]);
  });

  test("whose items are all done ends as it is", async () => {
    modelSays([
      planCall(["查 ENG-1", "in_progress"], ["查 ENG-2", "pending"]),
      lookupCall("ENG-1"),
      lookupCall("ENG-2"),
      planCall(["查 ENG-1", "done"], ["查 ENG-2", "done"]),
      { content: "两个都在 Todo。" },
    ]);

    await chat("查一下 ENG-1 和 ENG-2。");

    expect(asked).toHaveLength(5);
    expect(nudged()).toEqual([]);
  });

  test("is sent back at most MOST_NUDGES times in a row, then the run ends", async () => {
    modelAnswers((_request, index) =>
      index === 0
        ? planCall(["查 ENG-1", "in_progress"], ["查 ENG-2", "pending"])
        : { content: "目前就这些。" },
    );

    await chat("查一下 ENG-1 和 ENG-2。");

    expect(MOST_NUDGES).toBe(4);
    expect(asked).toHaveLength(2 + MOST_NUDGES);
    expect(nudged()).toHaveLength(MOST_NUDGES);
    expect(lastMessage(asked[2])).toContain(
      "计划里还有 2 项没做完：查 ENG-1；查 ENG-2",
    );
  });

  test("a list the tool turned down is no plan: the one before it stands", async () => {
    modelSays([
      planCall(["查 ENG-1", "in_progress"], ["查 ENG-2", "pending"]),
      // Two in progress: answered in words, and the plan stays as it was.
      planCall(
        ["查 ENG-1", "done"],
        ["查 ENG-2", "in_progress"],
        ["汇总", "in_progress"],
      ),
      { content: "目前就这些。" },
      planCall(["查 ENG-1", "done"], ["查 ENG-2", "done"]),
      { content: "完成。" },
    ]);

    const messages = await chat("查一下 ENG-1 和 ENG-2。");

    expect(asked).toHaveLength(5);
    expect(lastMessage(asked[2])).toContain("最多 1 项 in_progress");
    expect(nudged()).toHaveLength(1);
    expect(lastMessage(asked[3])).toContain(
      "计划里还有 2 项没做完：查 ENG-1；查 ENG-2",
    );
    expect(messages.at(-1)).toMatchObject({ content: "完成。" });
  });

  test("a plan an earlier run left open is history, not this run's promise", async () => {
    modelSays([{ content: "ENG-3 在 Done。" }]);

    await chat("顺便问一下，ENG-3 是什么状态？", {
      history: [
        { id: "earlier-ask", role: "user", content: "查一下 ENG-1 和 ENG-2。" },
        {
          id: "earlier-plan",
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call_earlier",
              type: "function",
              function: {
                name: UPDATE_PLAN_TOOL,
                arguments: JSON.stringify(
                  plan(["查 ENG-1", "in_progress"], ["查 ENG-2", "pending"]),
                ),
              },
            },
          ],
        },
        {
          id: "earlier-result",
          role: "tool",
          toolCallId: "call_earlier",
          content: "已更新计划：2 项，完成 0 项",
        },
        { id: "earlier-answer", role: "assistant", content: "先停在这里。" },
      ],
    });

    expect(asked).toHaveLength(1);
    expect(nudged()).toEqual([]);
  });
});

describe("a run nobody is watching", () => {
  test("is held to its plan the same way", async () => {
    modelSays([
      planCall(["查 ENG-1", "in_progress"], ["汇总", "pending"]),
      lookupCall("ENG-1"),
      { content: "ENG-1 在 Todo。" },
      planCall(["查 ENG-1", "done"], ["汇总", "done"]),
      { content: "汇总：ENG-1 在 Todo。" },
    ]);

    const { replyText } = await fire("查一下 ENG-1 并汇总。");

    expect(toolNames(asked[0])).toContain(UPDATE_PLAN_TOOL);
    expect(asked).toHaveLength(5);
    expect(nudged()).toHaveLength(1);
    expect(asked.indexOf(nudged()[0] as ChatCompletionRequest)).toBe(3);
    expect(lastMessage(asked[3])).toContain("计划里还有 2 项没做完");
    expect(replyText).toContain("汇总：ENG-1 在 Todo。");
  });

  test("is not sent back on its last step, which has no tools to finish with", async () => {
    modelAnswers((request, index) =>
      index === 0
        ? planCall(["查 ENG-1", "in_progress"], ["查其余的", "pending"])
        : offersTools(request)
          ? lookupCall(`ENG-${index}`)
          : { content: "查到 ENG-1 到 ENG-22。其余的没来得及查：步数用完了。" },
    );

    const { replyText } = await fire("查一下这个周期的每一个 issue。");

    expect(asked).toHaveLength(UNATTENDED_STEPS.base);
    expect(asked.at(-1)?.tool_choice).toBe("none");
    expect(nudged()).toEqual([]);
    expect(replyText).toContain("步数用完了");
  });
});
