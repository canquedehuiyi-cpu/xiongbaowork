import { describe, expect, test } from "bun:test";
import { PLAN_LIMITS, type PlanItem } from "../../shared/plan";
import { validateRoleProfile } from "../../shared/role-profile";
import {
  approvesPlan,
  createPlanApproval,
  declaredFor,
  declaresPlanApproval,
  holdMessage,
  onlyDeclared,
  PLAN_APPROVAL_MARKER,
  PLAN_APPROVAL_MIN_STEPS,
  PLAN_NOT_APPROVED,
  PLAN_NOT_PUT,
  PLAN_SENT_BACK,
  planDigest,
  planQuestion,
  rememberedFor,
  storable,
  withPlanApproval,
} from "../src/agents/plan-approval";
import { UPDATE_PLAN_REF, updatePlanTools } from "../src/agents/update-plan";
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
    // The threshold is not told to the model.
    expect(PILOT_HANDBOOK).not.toMatch(/4 步|四步/);
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

type Row = {
  key?: string;
  digest: string;
  decision?: "approved" | "revised";
  failed?: true;
};

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
  const held: { actorId: string; threadId: string; digest: string }[] = [];
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
    hold: async (input) => {
      held.push(input);
    },
  });
  return { planApproval, asked, held };
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

  test("any long plan is, while none is approved: a short first one that grew to five too", async () => {
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
      await inConversation(() => planApproval.afterPlan(items(3)), earlier),
    ).toBeUndefined();
    expect(
      await inConversation(
        () => planApproval.afterPlan(items(5)),
        earlier,
        "call-2",
      ),
    ).toContain("请主人批准");
    expect(asked).toHaveLength(1);
  });

  test("the row is keyed in a namespace of its own, by conversation and plan", async () => {
    const { planApproval, asked } = approval();
    await inConversation(() => planApproval.afterPlan(items(4)));
    await inConversation(() => planApproval.afterPlan(items(5)));
    const [first, second] = asked.map((input) => input.key);
    expect(first).toStartWith("plan-approval:");
    expect(second).toStartWith("plan-approval:");
    expect(first).not.toBe(second);
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
    ).toBe(PLAN_SENT_BACK);
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

  test("a plan that could not be put holds changes, is logged, and says so", async () => {
    const held: unknown[] = [];
    const planApproval = createPlanApproval({
      actorId: "owner",
      botId: "bot",
      initiator: undefined,
      declared: async () => true,
      latest: async () => undefined,
      ask: async () => ({ refusal: "没有对话" }),
      hold: async (input) => {
        held.push(input);
      },
    });
    const logged: string[] = [];
    const warn = console.warn;
    console.warn = (line: string) => logged.push(line);
    try {
      expect(await inConversation(() => planApproval.afterPlan(items(4)))).toBe(
        PLAN_NOT_PUT,
      );
    } finally {
      console.warn = warn;
    }
    expect(logged.join("\n")).toContain("plan-approval-not-put");
    expect(held).toEqual([
      { actorId: "owner", threadId: "thread-1", digest: planDigest(items(4)) },
    ]);
  });

  test("after a plan that could not be put, the next one is tried again, however short", async () => {
    const { planApproval, asked } = approval({
      latest: { digest: "x", failed: true },
    });
    expect(
      await inConversation(() => planApproval.afterPlan(items(2))),
    ).toContain("请主人批准");
    expect(asked).toHaveLength(1);
  });
});

describe("words the database would refuse", () => {
  test("control characters and unpaired surrogates are dropped, ordinary text is kept", () => {
    expect(storable("第 1 步\u0000\u0007完成\tok\n")).toBe("第 1 步完成\tok\n");
    expect(storable("坏\ud800字")).toBe("坏\ufffd字");
    expect(
      planQuestion(
        items(4).map((item) => ({ ...item, text: `${item.text}\u0000` })),
      ).question,
    ).not.toContain("\u0000");
  });
});

describe("the key of a plan's row", () => {
  test("follows the row before it, so the same plan put again after others is a new row", async () => {
    const first = approval({
      latest: { key: "k1", digest: "other", decision: "revised" },
    });
    const second = approval({
      latest: { key: "k2", digest: "other", decision: "revised" },
    });
    await inConversation(() => first.planApproval.afterPlan(items(4)));
    await inConversation(() => second.planApproval.afterPlan(items(4)));
    expect(first.asked[0]?.key).not.toBe(second.asked[0]?.key);
  });
});

describe("what a held change is answered with", () => {
  test("waiting, sent back, not put, and nothing once approved", () => {
    expect(holdMessage(undefined)).toBeUndefined();
    expect(holdMessage({ digest: "d", decision: "approved" })).toBeUndefined();
    expect(holdMessage({ digest: "d" })).toBe(PLAN_NOT_APPROVED);
    expect(holdMessage({ digest: "d", decision: "revised" })).toBe(
      PLAN_SENT_BACK,
    );
    expect(holdMessage({ digest: "d", failed: true })).toBe(PLAN_NOT_PUT);
    expect(PLAN_SENT_BACK).not.toContain("等主人回复");
  });
});

describe("a failure anywhere after the declaration", () => {
  const failing = (where: "latest" | "ask" | "answer") => {
    const held: unknown[] = [];
    const planApproval = createPlanApproval({
      actorId: "owner",
      botId: "bot",
      initiator: undefined,
      declared: async () => true,
      latest: async () => {
        if (where === "latest") throw new Error("down");
        return undefined;
      },
      ask: async () => {
        if (where === "ask") throw new Error("invalid input");
        return { refusal: "nobody" };
      },
      hold: async (input) => {
        held.push(input);
      },
    });
    return { planApproval, held };
  };

  for (const where of ["latest", "ask", "answer"] as const)
    test(`${where} failing holds changes and says the plan was not put`, async () => {
      const { planApproval, held } = failing(where);
      const warn = console.warn;
      console.warn = () => undefined;
      try {
        expect(
          await inConversation(() => planApproval.afterPlan(items(4))),
        ).toBe(PLAN_NOT_PUT);
      } finally {
        console.warn = warn;
      }
      expect(held).toHaveLength(1);
    });

  test("a hold that cannot be written does not turn the answer into an error", async () => {
    const planApproval = createPlanApproval({
      actorId: "owner",
      botId: "bot",
      initiator: undefined,
      declared: async () => true,
      latest: async () => {
        throw new Error("down");
      },
      ask: async () => ({ refusal: "x" }),
      hold: async () => {
        throw new Error("down too");
      },
    });
    const [warn, error] = [console.warn, console.error];
    console.warn = console.error = () => undefined;
    try {
      expect(await inConversation(() => planApproval.afterPlan(items(4)))).toBe(
        PLAN_NOT_PUT,
      );
    } finally {
      [console.warn, console.error] = [warn, error];
    }
  });
});

describe("whose employee declares the pilot", () => {
  const declared = `${PLAN_APPROVAL_MARKER}\n手册`;
  test("only the owner's own, with the line", () => {
    expect(
      declaredFor("alice", { ownerUserId: "alice", bible: declared }),
    ).toBe(true);
    // A team's employee, talked to by somebody else.
    expect(declaredFor("bob", { ownerUserId: "alice", bible: declared })).toBe(
      false,
    );
    // A deployment's employee has no owner.
    expect(declaredFor("alice", { ownerUserId: null, bible: declared })).toBe(
      false,
    );
    expect(declaredFor("alice", { ownerUserId: "alice", bible: "手册" })).toBe(
      false,
    );
    expect(declaredFor("alice", null)).toBe(false);
  });

  test("is remembered for a while, then read again", async () => {
    let reads = 0;
    let clock = 0;
    const remembered = rememberedFor(
      async () => {
        reads += 1;
        return true;
      },
      1000,
      () => clock,
    );
    await remembered("a", "b");
    await remembered("a", "b");
    expect(reads).toBe(1);
    clock = 1500;
    await remembered("a", "b");
    expect(reads).toBe(2);
  });
});

describe("an employee that did not declare the pilot, with the switch on", () => {
  test("keeps its plan tool as it was, the very same list", async () => {
    const tools = updatePlanTools();
    const swapped = await withPlanApproval(tools, {
      planRef: UPDATE_PLAN_REF,
      declared: false,
      pilotTool: () => {
        throw new Error("should not be built");
      },
    });
    expect(swapped).toBe(tools);
    expect(swapped[0]?.concurrent).toBe(true);
  });

  test("an employee that did gets the pilot's, not started beside the next action", async () => {
    const pilot = updatePlanTools({
      approval: { afterPlan: async () => undefined },
    })[0];
    const swapped = await withPlanApproval(updatePlanTools(), {
      planRef: UPDATE_PLAN_REF,
      declared: true,
      pilotTool: () => pilot,
    });
    expect(swapped[0]).toBe(pilot);
    expect(Boolean(swapped[0]?.concurrent)).toBe(false);
  });

  test("asks nothing of the database for a check, and answers as there were no hold", async () => {
    let asked = 0;
    const check = onlyDeclared<[string], string | undefined>(
      async () => false,
      undefined,
      async () => {
        asked += 1;
        return "held";
      },
    );
    expect(await check("alice", "bot", "thread")).toBeUndefined();
    expect(asked).toBe(0);
    const declaredCheck = onlyDeclared<[string], string | undefined>(
      async () => true,
      undefined,
      async () => "held",
    );
    expect(await declaredCheck("alice", "bot", "thread")).toBe("held");
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
