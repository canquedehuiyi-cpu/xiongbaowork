import { z } from "zod";
import type { WakerFlowPlan } from "../../../shared/wakerflows";

const key = z
  .string()
  .regex(
    /^[a-z][a-z0-9_]{0,39}$/,
    "名称需以小写字母开头，只包含字母、数字和下划线。",
  );
export const wakerFlowMembersSchema = z
  .array(
    z
      .object({
        agentId: z.string().min(1).max(200),
        role: z.string().trim().min(1).max(160),
      })
      .strict(),
  )
  .min(1)
  .max(10);

/** The editable plan is also the execution contract; no hidden steps are added after Save. */
export const wakerFlowPlanSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().max(4000),
    members: wakerFlowMembersSchema,
    inputs: z
      .array(
        z
          .object({
            key,
            label: z.string().trim().min(1).max(160),
            required: z.boolean(),
          })
          .strict(),
      )
      .max(20),
    steps: z
      .array(
        z
          .object({
            id: key,
            agentId: z.string().min(1).max(200),
            instruction: z.string().trim().min(1).max(8000),
            inputKeys: z.array(key).max(30),
            outputKey: key,
          })
          .strict(),
      )
      .min(1)
      .max(10),
  })
  .strict()
  .superRefine((plan, context) => {
    const fail = (path: (string | number)[], message: string) =>
      context.addIssue({ code: "custom", path, message });
    const members = new Set<string>();
    plan.members.forEach((member, index) => {
      if (members.has(member.agentId))
        fail(["members", index, "agentId"], "同一位员工不能重复加入计划。");
      members.add(member.agentId);
    });
    const available = new Set<string>();
    plan.inputs.forEach((input, index) => {
      if (available.has(input.key))
        fail(["inputs", index, "key"], "流程输入名称重复。");
      available.add(input.key);
    });
    const steps = new Set<string>();
    plan.steps.forEach((step, index) => {
      if (steps.has(step.id)) fail(["steps", index, "id"], "步骤编号重复。");
      steps.add(step.id);
      if (!members.has(step.agentId))
        fail(["steps", index, "agentId"], "步骤只能交给计划中的员工。");
      if (new Set(step.inputKeys).size !== step.inputKeys.length)
        fail(["steps", index, "inputKeys"], "步骤输入名称重复。");
      for (const input of step.inputKeys) {
        if (!available.has(input))
          fail(
            ["steps", index, "inputKeys"],
            `输入 ${input} 尚未产生；只能读取流程输入或前面步骤的输出。`,
          );
      }
      if (available.has(step.outputKey))
        fail(["steps", index, "outputKey"], "步骤输出不能覆盖已有输入或输出。");
      available.add(step.outputKey);
    });
  });

/** Form input is bounded before dispatch, and missing required input is a validation error. */
export function flowInputs(
  plan: WakerFlowPlan,
  values: unknown,
): Record<string, string> {
  const parsed = z.record(z.string(), z.string().max(10000)).parse(values);
  const declared = new Set(plan.inputs.map((input) => input.key));
  for (const name of Object.keys(parsed)) {
    if (!declared.has(name)) throw new Error(`流程没有声明输入 ${name}。`);
  }
  for (const input of plan.inputs) {
    if (input.required && !parsed[input.key]?.trim())
      throw new Error(`请填写 ${input.label}。`);
  }
  if (Object.values(parsed).join("").length > 20000)
    throw new Error("流程输入合计不能超过 20000 字。");
  return parsed;
}
