import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { WakerFlowInput, WakerFlowPlan } from "../../shared/wakerflows";
import { createDatabase } from "../src/db/client";
import {
  agents,
  groupTaskRuns,
  groupTaskTemplates,
  tasks,
  wakerFlowRequests,
  wakerFlows,
  wakerGroups,
} from "../src/db/schema";
import { createPipelineStore } from "../src/pipeline/store";
import { createTaskProjector } from "../src/tasks/projector";
import { runAsTenant } from "../src/tenant/context";
import {
  automationFlowInputs,
  flowInputs,
  wakerFlowPlanSchema,
} from "../src/wakerflows/plan";
import {
  createWakerFlowStore,
  WakerFlowValidationError,
} from "../src/wakerflows/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * WF8-1: typed Flow inputs. The pure half pins `wakerFlowPlanSchema` and `flowInputs` per type; the
 * database half pins that a typed plan saves and runs through the real store and pipeline (with a
 * stand-in step runner: no model is reached), refusing a bad value with a 400 before any run exists
 * and writing defaults into `group_task_runs.inputs`.
 */

function planWith(...inputs: WakerFlowInput[]): WakerFlowPlan {
  return {
    name: "周报",
    description: "",
    members: [{ agentId: "agent-1", role: "撰写" }],
    inputs,
    steps: [
      {
        id: "write",
        agentId: "agent-1",
        instruction: "写周报",
        inputKeys: inputs.map((input) => input.key),
        outputKey: "report",
      },
    ],
  };
}

const parsePlan = (plan: WakerFlowPlan) => wakerFlowPlanSchema.parse(plan);
const refusal = (plan: WakerFlowPlan) => {
  const result = wakerFlowPlanSchema.safeParse(plan);
  return result.success ? null : (result.error.issues[0]?.message ?? "");
};

describe("plans written before WF8", () => {
  test("a plan without types parses unchanged and runs its inputs exactly as before", () => {
    const legacy = planWith(
      { key: "topic", label: "主题", required: true },
      { key: "notes", label: "备注", required: false },
    );
    const parsed = parsePlan(legacy);
    expect(parsed).toEqual(legacy);
    expect(flowInputs(parsed, { topic: "发布", notes: "" })).toEqual({
      topic: "发布",
      notes: "",
    });
    expect(flowInputs(parsed, { topic: "发布" })).toEqual({ topic: "发布" });
    expect(() => flowInputs(parsed, { topic: "  " })).toThrow("请填写 主题。");
    expect(() => flowInputs(parsed, { topic: "a", other: "b" })).toThrow(
      "流程没有声明输入 other。",
    );
  });
});

describe("each input type", () => {
  const number = parsePlan(
    planWith({ key: "count", label: "人数", required: true, type: "number" }),
  );
  test("number accepts finite numbers and refuses anything else", () => {
    for (const value of ["3", "-2.5", "1e3", " 42 "])
      expect(flowInputs(number, { count: value })).toEqual({ count: value });
    for (const value of ["abc", "NaN", "Infinity", "1,000"])
      expect(() => flowInputs(number, { count: value })).toThrow(
        "人数 需要填写数字。",
      );
  });

  const toggle = parsePlan(
    planWith({ key: "urgent", label: "加急", required: true, type: "boolean" }),
  );
  test("boolean accepts only true and false", () => {
    for (const value of ["true", "false"])
      expect(flowInputs(toggle, { urgent: value })).toEqual({ urgent: value });
    expect(
      flowInputs(
        parsePlan(
          planWith({
            key: "urgent",
            label: "加急",
            required: false,
            type: "boolean",
            default: "false",
          }),
        ),
        {},
      ),
    ).toEqual({ urgent: "false" });
    for (const value of ["yes", "1", "TRUE", "是"])
      expect(() => flowInputs(toggle, { urgent: value })).toThrow("加急");
  });

  const choice = parsePlan(
    planWith({
      key: "tone",
      label: "语气",
      required: true,
      type: "select",
      options: ["正式", "轻松", "简洁"],
    }),
  );
  test("select accepts only one of its options", () => {
    for (const value of ["正式", "轻松", "简洁"])
      expect(flowInputs(choice, { tone: value })).toEqual({ tone: value });
    for (const value of ["随意", "正式 ", "ZHENGSHI"])
      expect(() => flowInputs(choice, { tone: value })).toThrow(
        "语气 需要从选项中选择。",
      );
  });

  const prose = parsePlan(
    planWith(
      { key: "summary", label: "摘要", required: true, type: "textarea" },
      { key: "title", label: "标题", required: false, type: "text" },
    ),
  );
  test("text and textarea take any string within the limits", () => {
    for (const value of ["一行", "多行\n内容\n第三行", "<b>x</b>"])
      expect(flowInputs(prose, { summary: value })).toEqual({ summary: value });
    expect(() => flowInputs(prose, { summary: "" })).toThrow("请填写 摘要。");
    expect(() => flowInputs(prose, { summary: "a".repeat(10001) })).toThrow();
    expect(() =>
      flowInputs(prose, {
        summary: "a".repeat(10000),
        title: "b".repeat(10001),
      }),
    ).toThrow();
  });

  test("an empty optional number or choice is no value at all", () => {
    const plan = parsePlan(
      planWith(
        { key: "count", label: "人数", required: false, type: "number" },
        {
          key: "tone",
          label: "语气",
          required: false,
          type: "select",
          options: ["正式"],
        },
      ),
    );
    expect(flowInputs(plan, { count: "", tone: " " })).toEqual({});
  });
});

describe("defaults", () => {
  const plan = parsePlan(
    planWith(
      {
        key: "count",
        label: "人数",
        required: true,
        type: "number",
        default: "5",
        description: "参会人数",
      },
      {
        key: "tone",
        label: "语气",
        required: false,
        type: "select",
        options: ["正式", "轻松"],
        default: "轻松",
      },
    ),
  );
  test("an empty input takes its default; a filled one keeps its value", () => {
    expect(flowInputs(plan, {})).toEqual({ count: "5", tone: "轻松" });
    expect(flowInputs(plan, { count: "", tone: "正式" })).toEqual({
      count: "5",
      tone: "正式",
    });
  });
  test("an automation's saved inputs are not filled in from a default for a required input", () => {
    expect(() => automationFlowInputs(plan, {})).toThrow("请填写 人数。");
    expect(automationFlowInputs(plan, { count: "8" })).toEqual({ count: "8" });
  });
});

describe("declarations the plan refuses", () => {
  test("a select without options, with too many, or with duplicates", () => {
    expect(
      refusal(
        planWith({
          key: "tone",
          label: "语气",
          required: true,
          type: "select",
        }),
      ),
    ).toBe("下拉输入「语气」至少需要一个选项。");
    expect(
      refusal(
        planWith({
          key: "tone",
          label: "语气",
          required: true,
          type: "select",
          options: Array.from({ length: 21 }, (_, index) => `选项${index}`),
        }),
      ),
    ).toBe("下拉输入「语气」最多 20 个选项。");
    expect(
      refusal(
        planWith({
          key: "tone",
          label: "语气",
          required: true,
          type: "select",
          options: ["正式", "轻松", "正式"],
        }),
      ),
    ).toBe("下拉输入「语气」的选项重复。");
    expect(
      refusal(
        planWith({
          key: "tone",
          label: "语气",
          required: true,
          type: "select",
          options: ["a".repeat(81)],
        }),
      ),
    ).toBe("每个下拉选项不能超过 80 字。");
  });

  test("options on a type that is not a select, a default its type refuses, an unknown type, a long description", () => {
    expect(
      refusal(
        planWith({
          key: "topic",
          label: "主题",
          required: true,
          options: ["a"],
        }),
      ),
    ).toBe("只有下拉输入可以设置选项（「主题」）。");
    expect(
      refusal(
        planWith({
          key: "count",
          label: "人数",
          required: true,
          type: "number",
          default: "很多",
        }),
      ),
    ).toBe("「人数」的默认值无效：人数 需要填写数字。");
    expect(
      refusal(
        planWith({
          key: "tone",
          label: "语气",
          required: true,
          type: "select",
          options: ["正式"],
          default: "轻松",
        }),
      ),
    ).toBe("「语气」的默认值无效：语气 需要从选项中选择。");
    expect(
      refusal({
        ...planWith({ key: "x", label: "X", required: true }),
        inputs: [
          { key: "x", label: "X", required: true, type: "date" as "text" },
        ],
      }),
    ).not.toBeNull();
    expect(
      refusal(
        planWith({
          key: "topic",
          label: "主题",
          required: true,
          description: "说".repeat(201),
        }),
      ),
    ).toBe("输入说明不能超过 200 字。");
  });
});

/*
 * The run path, against the real database: a typed plan saves, a refused value is a 400 with the
 * Chinese reason and leaves no request or run, and a default lands in the run's inputs.
 */
describe("a typed plan through the real store", () => {
  const database = createDatabase(testDatabaseUrl(), TEST_POOL);
  const tenantId = `flowinputs-${randomUUID()}`;
  const member = `${tenantId}-worker`;

  afterAll(async () => {
    await runAsTenant(tenantId, async () => {
      await database.delete(tasks).where(eq(tasks.tenantId, tenantId));
      await database
        .delete(groupTaskRuns)
        .where(eq(groupTaskRuns.tenantId, tenantId));
      await database
        .delete(groupTaskTemplates)
        .where(eq(groupTaskTemplates.tenantId, tenantId));
      await database
        .delete(wakerFlowRequests)
        .where(eq(wakerFlowRequests.tenantId, tenantId));
      await database
        .delete(wakerFlows)
        .where(eq(wakerFlows.tenantId, tenantId));
      await database
        .delete(wakerGroups)
        .where(eq(wakerGroups.tenantId, tenantId));
      await database.delete(agents).where(eq(agents.tenantId, tenantId));
    });
    await database.$client.close();
  });

  test("a bad number is a 400 with the reason, and an empty input runs with its default", async () => {
    await runAsTenant(tenantId, () =>
      database.insert(agents).values({
        id: member,
        tenantId,
        name: "小记",
        type: "built_in",
        configuration: {},
      }),
    );
    const canUse = async (actor: string, agentId: string) =>
      actor === tenantId && agentId === member;
    const board = createTaskProjector(database);
    const pipeline = createPipelineStore({
      database,
      board,
      canUse,
      executeStep: async () => ({ status: "done", output: "好了" }),
    });
    const drives: Promise<unknown>[] = [];
    const store = createWakerFlowStore({
      database,
      pipeline,
      board,
      canUse,
      drive: (run) => drives.push(pipeline.advance(run)),
    });
    const typed = planWith(
      { key: "count", label: "人数", required: true, type: "number" },
      {
        key: "tone",
        label: "语气",
        required: false,
        type: "select",
        options: ["正式", "轻松"],
        default: "正式",
      },
    );
    const plan: WakerFlowPlan = {
      ...typed,
      members: [{ agentId: member, role: "撰写" }],
      steps: typed.steps.map((step) => ({ ...step, agentId: member })),
    };
    const created = await store.create(tenantId, { idea: "周报" });
    const flow = await store.save(tenantId, tenantId, created.id, {
      revision: 0,
      plan,
    });
    expect(flow.plan?.inputs).toEqual(plan.inputs);

    const refused = await store
      .start(tenantId, tenantId, flow.id, {
        requestId: randomUUID(),
        revision: flow.revision,
        inputs: { count: "abc" },
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(refused).toBeInstanceOf(WakerFlowValidationError);
    expect((refused as WakerFlowValidationError).status).toBe(400);
    expect((refused as Error).message).toBe("人数 需要填写数字。");
    expect(await store.runs(tenantId, flow.id)).toEqual([]);

    const started = await store.start(tenantId, tenantId, flow.id, {
      requestId: randomUUID(),
      revision: flow.revision,
      inputs: { count: "12" },
    });
    expect(started.status).toBe("completed");
    await Promise.all(drives);
    const [run] = await runAsTenant(tenantId, () =>
      database
        .select({ inputs: groupTaskRuns.inputs, status: groupTaskRuns.status })
        .from(groupTaskRuns)
        .where(eq(groupTaskRuns.id, started.runId ?? "")),
    );
    expect(run).toEqual({
      inputs: { count: "12", tone: "正式" },
      status: "done",
    });
  });
});
