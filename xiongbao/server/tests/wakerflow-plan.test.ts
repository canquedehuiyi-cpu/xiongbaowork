import { expect, test } from "bun:test";
import { flowInputs, wakerFlowPlanSchema } from "../src/wakerflows/plan";

const plan = {
  name: "周报",
  description: "先汇总再审核",
  members: [
    { agentId: "writer", role: "汇总" },
    { agentId: "reviewer", role: "审核" },
  ],
  inputs: [{ key: "notes", label: "工作记录", required: true }],
  steps: [
    {
      id: "draft",
      agentId: "writer",
      instruction: "汇总工作记录",
      inputKeys: ["notes"],
      outputKey: "report",
    },
    {
      id: "review",
      agentId: "reviewer",
      instruction: "审核报告",
      inputKeys: ["report"],
      outputKey: "reviewed_report",
    },
  ],
};

test("the saved plan declares who runs each step and where its inputs come from", () => {
  expect(wakerFlowPlanSchema.parse(plan)).toEqual(plan);
});
test("a forward reference cannot be saved as an executable plan", () => {
  expect(
    wakerFlowPlanSchema.safeParse({
      ...plan,
      steps: [
        { ...plan.steps[0], inputKeys: ["reviewed_report"] },
        plan.steps[1],
      ],
    }).success,
  ).toBe(false);
});
test("an undeclared employee, duplicate output or duplicate step is refused", () => {
  for (const change of [
    { agentId: "outsider" },
    { outputKey: "notes" },
    { id: "review" },
  ]) {
    expect(
      wakerFlowPlanSchema.safeParse({
        ...plan,
        steps: [{ ...plan.steps[0], ...change }, plan.steps[1]],
      }).success,
    ).toBe(false);
  }
});
test("unexpected plan fields cannot hide actions outside the visible steps", () => {
  expect(
    wakerFlowPlanSchema.safeParse({ ...plan, runCommand: "hidden action" })
      .success,
  ).toBe(false);
});
test("the run requires declared inputs and rejects undeclared or oversized input", () => {
  const parsed = wakerFlowPlanSchema.parse(plan);
  expect(flowInputs(parsed, { notes: "本周已完成内容" })).toEqual({
    notes: "本周已完成内容",
  });
  expect(() => flowInputs(parsed, {})).toThrow("工作记录");
  expect(() =>
    flowInputs(parsed, { notes: "记录", secret: "undeclared" }),
  ).toThrow("没有声明输入");
  expect(() => flowInputs(parsed, { notes: "a".repeat(10001) })).toThrow();
});
