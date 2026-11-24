import { describe, expect, test } from "bun:test";
import { PLAN_LIMITS, type PlanItem } from "../../shared/plan";
import { validateRoleProfile } from "../../shared/role-profile";
import {
  approvesPlan,
  createPlanApproval,
  declaresPlanApproval,
  earlierPlanCalls,
  PLAN_APPROVAL_MARKER,
  PLAN_APPROVAL_MIN_STEPS,
  planDigest,
  planQuestion,
} from "../src/agents/plan-approval";
import { updatePlanTools } from "../src/agents/update-plan";
import {
  isReadOnlyThread,
  restrictToReads,
} from "../src/approvals/read-only-threads";
import { withApprovalContext } from "../src/approvals/types";
import { loadConfig } from "../src/config";
import {
  PILOT_HANDBOOK,
  PILOT_TEMPLATE_ID,
  pilotRoleTemplate,
} from "../src/roles/pilot-handbook";
import { officialTemplatesFrom } from "../src/roles/store";
import { testEnvironment } from "./support/environment";

/** 计划须批准的试点：开关、手册声明、触发规则这些不碰库的部分。 */

const NAME = "XIONGBAO_PILOT_PLAN_APPROVAL";
const configWith = (value?: string) =>
  loadConfig(testEnvironment(value === undefined ? {} : { [NAME]: value }));

describe("XIONGBAO_PILOT_PLAN_APPROVAL", () => {
  test("is off when it is not set, and when it is empty", () => {
    expect(configWith().pilotPlanApproval).toBe(false);
    expect(configWith("").pilotPlanApproval).toBe(false);
  });

  test("is on only for `on`, and off for `off`", () => {
    expect(configWith("on").pilotPlanApproval).toBe(true);
    expect(configWith("ON").pilotPlanApproval).toBe(true);
    expect(configWith("off").pilotPlanApproval).toBe(false);
  });

  test("refuses anything else rather than staying off without saying so", () => {
    expect(() => configWith("true")).toThrow(NAME);
    expect(() => configWith("1")).toThrow(NAME);
    expect(() => configWith("yes")).toThrow(NAME);
  });
});

const items = (count: number, status: PlanItem["status"] = "pending") =>
  Array.from({ length: count }, (_, index) => ({
    text: `第 ${index + 1} 步`,
    status,
  }));

describe("what the plan tool is when the pilot is off", () => {
  test("is the same tool, with or without the option, and answers as before", async () => {
    const [plain] = updatePlanTools();
    const [bare] = updatePlanTools({});
    if (!plain || !bare) throw new Error("Expected the plan tool.");
    expect(bare.name).toBe(plain.name);
    expect(bare.ref).toBe(plain.ref);
    expect(bare.description).toBe(plain.description);
    expect(bare.concurrent).toBe(plain.concurrent);
    for (const count of [1, 3, 4, 9])
      expect(await bare.execute({ items: items(count) })).toBe(
        `已更新计划：${count} 项，完成 0 项`,
      );
  });

  test("the pilot's official template is not in the list the package alone makes", () => {
    const templates = officialTemplatesFrom([
      {
        id: "a",
        name: "A",
        title: "t",
        roleDescription: "r",
        type: "built_in",
        configuration: {},
      },
    ]);
    expect(templates.map((template) => template.id)).toEqual(["official:a"]);
    expect(
      templates.some((template) => template.id === PILOT_TEMPLATE_ID),
    ).toBe(false);
  });
});

describe("what the plan tool does under the pilot", () => {
  test("is not started beside the next action, and adds the owner's wait to its answer", async () => {
    const [plain] = updatePlanTools();
    const [tool] = updatePlanTools({
      approval: { afterPlan: async () => "计划已请主人批准。" },
    });
    if (!plain || !tool) throw new Error("Expected the plan tool.");
    // Concurrent by default; the pilot's tool is ordered ahead of the actions of its step.
    expect(plain.concurrent).toBe(true);
    expect(tool.concurrent).toBeUndefined();
    expect(await tool.execute({ items: items(4) })).toBe(
      "已更新计划：4 项，完成 0 项。计划已请主人批准。",
    );
  });

  test("a list it cannot take is answered before the owner is asked anything", async () => {
    let asked = 0;
    const [tool] = updatePlanTools({
      approval: {
        afterPlan: async () => {
          asked += 1;
          return undefined;
        },
      },
    });
    if (!tool) throw new Error("Expected the plan tool.");
    expect(await tool.execute({ items: [] })).toContain("清单是空的");
    expect(
      await tool.execute({ items: items(PLAN_LIMITS.items + 1) }),
    ).toContain("最多");
    expect(asked).toBe(0);
  });

  test("a failure to put the plan is logged, and the plan is still taken", async () => {
    const [tool] = updatePlanTools({
      approval: {
        afterPlan: async () => {
          throw new Error("down");
        },
      },
    });
    if (!tool) throw new Error("Expected the plan tool.");
    const logged = console.error;
    console.error = () => undefined;
    try {
      expect(await tool.execute({ items: items(4) })).toBe(
        "已更新计划：4 项，完成 0 项",
      );
    } finally {
      console.error = logged;
    }
  });
});

describe("the declaration in the handbook", () => {
  test("is the marker alone on a line", () => {
    expect(declaresPlanApproval(`${PLAN_APPROVAL_MARKER}\n\n其余`)).toBe(true);
    expect(declaresPlanApproval(`前言\n  ${PLAN_APPROVAL_MARKER}  \n`)).toBe(
      true,
    );
    expect(declaresPlanApproval(`说明：${PLAN_APPROVAL_MARKER}`)).toBe(false);
    expect(declaresPlanApproval("")).toBe(false);
    expect(declaresPlanApproval(null)).toBe(false);
    expect(declaresPlanApproval(undefined)).toBe(false);
  });

  test("the pilot's template declares it and holds the four procedures", () => {
    const template = pilotRoleTemplate();
    expect(template.official).toBe(true);
    expect(template.id).toBe(PILOT_TEMPLATE_ID);
    expect(declaresPlanApproval(template.profile.bible)).toBe(true);
    for (const flow of [
      "计划 → 实现 → 验证 → 评审 → 交付",
      "来源清单 → 交叉核对 → 结论带出处",
      "确认意图 → 起草 → 发送前过审批",
      "数据来源 → 口径确认 → 校验合计 → 交付文件",
    ])
      expect(PILOT_HANDBOOK).toContain(flow);
    // The role editor accepts it as written.
    expect(validateRoleProfile(template.profile).ok).toBe(true);
  });
});

describe("what counts as a yes", () => {
  test("only the approving words, whatever the spacing and closing mark", () => {
    for (const word of ["批准", " 批准。", "同意", "Approve", "approved!"])
      expect(approvesPlan(word)).toBe(true);
    for (const word of ["不批准", "批准，但第三步不要删文件", "再想想", "ok"])
      expect(approvesPlan(word)).toBe(false);
  });
});

describe("the plan as the owner reads it", () => {
  test("lists every step, says how to answer, and stays inside the question's limit", () => {
    const { question, why } = planQuestion(items(5));
    expect(question).toContain("共 5 步");
    expect(question).toContain("1. 第 1 步");
    expect(question).toContain("5. 第 5 步");
    expect(why).toContain("批准");
    expect(
      [
        ...planQuestion(
          items(20).map((item) => ({ ...item, text: "字".repeat(400) })),
        ).question,
      ].length,
    ).toBeLessThanOrEqual(6000);
  });

  test("ticking items does not make a different plan; rewording one does", () => {
    const before = items(4);
    const ticked = before.map((item, index) => ({
      ...item,
      status: index === 0 ? ("done" as const) : item.status,
    }));
    expect(planDigest(ticked)).toBe(planDigest(before));
    expect(
      planDigest([
        ...before.slice(0, 3),
        { text: "换一步", status: "pending" },
      ]),
    ).not.toBe(planDigest(before));
  });

  test("earlier plan calls are those in the conversation but not the one being answered", () => {
    const call = (id: string, name: string) => ({
      id,
      type: "function",
      function: { name, arguments: "{}" },
    });
    const messages = [
      { id: "1", role: "user", content: "做个东西" },
      { id: "2", role: "assistant", toolCalls: [call("a", "update_plan")] },
      { id: "3", role: "assistant", toolCalls: [call("b", "web_search")] },
      { id: "4", role: "assistant", toolCalls: [call("c", "update_plan")] },
    ];
    expect(earlierPlanCalls(messages, "c")).toBe(1);
    expect(earlierPlanCalls(messages, "a")).toBe(1);
    expect(earlierPlanCalls(messages.slice(0, 1), "a")).toBe(0);
    expect(earlierPlanCalls(undefined, "a")).toBe(0);
  });
});

/** The context a tool call runs in, as the approval gate and the tools read it. */
const inConversation = <T>(
  body: () => Promise<T>,
  messages: unknown[] = [],
  callId = "call-1",
) =>
  withApprovalContext(
    {
      runId: "run-1",
      threadId: "thread-1",
      toolCallId: callId,
      toolName: "update_plan",
      args: {},
      messages: messages as never,
      state: {},
      context: [],
      forwardedProps: {},
    },
    body,
  );

type Row = { digest: string; decision?: "approved" | "revised" };

function approval(
  options: {
    declared?: boolean;
    latest?: Row;
    initiator?: Parameters<typeof createPlanApproval>[0]["initiator"];
  } = {},
) {
  const asked: Parameters<
    Parameters<typeof createPlanApproval>[0]["ask"]
  >[0][] = [];
  const planApproval = createPlanApproval({
    actorId: "owner",
    botId: "bot",
    initiator: options.initiator,
    declared: async () => options.declared ?? true,
    latest: async () => options.latest,
    ask: async (input) => {
      asked.push(input);
      return { reached: "the person" };
    },
  });
  return { planApproval, asked };
}

describe("when a plan is put to its owner", () => {
  test("a plan of four steps is, and says what happens next", async () => {
    expect(PLAN_APPROVAL_MIN_STEPS).toBe(4);
    const { planApproval, asked } = approval();
    const note = await inConversation(() => planApproval.afterPlan(items(4)));
    expect(note).toContain("请主人批准");
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      actorId: "owner",
      botId: "bot",
      threadId: "thread-1",
      runId: "run-1",
      planApproval: { steps: 4, digest: planDigest(items(4)) },
    });
    expect(asked[0]?.question).toContain("4. 第 4 步");
  });

  test("a plan of three steps is not", async () => {
    const { planApproval, asked } = approval();
    expect(
      await inConversation(() => planApproval.afterPlan(items(3))),
    ).toBeUndefined();
    expect(asked).toHaveLength(0);
  });

  test("an employee that did not declare the pilot is never asked about", async () => {
    const { planApproval, asked } = approval({ declared: false });
    expect(
      await inConversation(() => planApproval.afterPlan(items(8))),
    ).toBeUndefined();
    expect(asked).toHaveLength(0);
  });

  test("a call outside any conversation is not", async () => {
    const { planApproval, asked } = approval();
    expect(await planApproval.afterPlan(items(8))).toBeUndefined();
    expect(asked).toHaveLength(0);
  });

  test("a routine's, a goal's or a hand-off's plan is not: nobody is there to answer", async () => {
    for (const initiator of [
      { kind: "routine" as const, id: "r1" },
      { kind: "responsibility" as const, id: "g1" },
      { kind: "handoff" as const, id: "h1" },
    ]) {
      const { planApproval, asked } = approval({ initiator });
      expect(
        await inConversation(() => planApproval.afterPlan(items(8))),
      ).toBeUndefined();
      expect(asked).toHaveLength(0);
    }
  });

  test("only the first plan of the conversation is: a later one that grew to four is not", async () => {
    const { planApproval, asked } = approval();
    const earlier = [
      {
        id: "old",
        role: "assistant",
        toolCalls: [
          { id: "old", type: "function", function: { name: "update_plan" } },
        ],
      },
    ];
    expect(
      await inConversation(
        () => planApproval.afterPlan(items(4)),
        earlier,
        "call-2",
      ),
    ).toBeUndefined();
    expect(asked).toHaveLength(0);
  });

  test("a plan already with the owner is not put twice", async () => {
    const { planApproval, asked } = approval({
      latest: { digest: planDigest(items(4)) },
    });
    const note = await inConversation(() => planApproval.afterPlan(items(4)));
    expect(note).toContain("还在等主人批准");
    expect(asked).toHaveLength(0);
  });

  test("an approved plan is left alone, however its items are ticked", async () => {
    const { planApproval, asked } = approval({
      latest: { digest: planDigest(items(4)), decision: "approved" },
    });
    expect(
      await inConversation(() => planApproval.afterPlan(items(4, "done"))),
    ).toBeUndefined();
    expect(asked).toHaveLength(0);
  });

  test("a plan the owner sent back is put again only once it has changed", async () => {
    const sentBack: Row = { digest: planDigest(items(4)), decision: "revised" };
    const same = approval({ latest: sentBack });
    expect(
      await inConversation(() => same.planApproval.afterPlan(items(4))),
    ).toContain("没获批准");
    expect(same.asked).toHaveLength(0);
    // A rewritten plan goes back to the owner, even one that got shorter.
    const changed = approval({ latest: sentBack });
    const reworded = [
      ...items(2),
      { text: "改过的一步", status: "pending" as const },
    ];
    expect(
      await inConversation(() => changed.planApproval.afterPlan(reworded)),
    ).toContain("请主人批准");
    expect(changed.asked).toHaveLength(1);
  });

  test("a plan that could not be put is logged, and the model is told nothing", async () => {
    const planApproval = createPlanApproval({
      actorId: "owner",
      botId: "bot",
      initiator: undefined,
      declared: async () => true,
      latest: async () => undefined,
      ask: async () => ({ refusal: "没有对话" }),
    });
    const logged: string[] = [];
    const warn = console.warn;
    console.warn = (line: string) => logged.push(line);
    try {
      expect(
        await inConversation(() => planApproval.afterPlan(items(4))),
      ).toBeUndefined();
    } finally {
      console.warn = warn;
    }
    expect(logged.join("\n")).toContain("plan-approval-not-put");
  });
});

describe("threads held to reads", () => {
  test("a thread is held until its holder lets go, and holds count", () => {
    expect(isReadOnlyThread("t")).toBe(false);
    const first = restrictToReads("t");
    const second = restrictToReads("t");
    expect(isReadOnlyThread("t")).toBe(true);
    first();
    expect(isReadOnlyThread("t")).toBe(true);
    second();
    expect(isReadOnlyThread("t")).toBe(false);
  });
});
