import { z } from "zod";
import {
  WAKERFLOW_INPUT_TYPES,
  type WakerFlowInput,
  type WakerFlowPlan,
} from "../../../shared/wakerflows";

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
            type: z.enum(WAKERFLOW_INPUT_TYPES).optional(),
            description: z
              .string()
              .trim()
              .max(200, "输入说明不能超过 200 字。")
              .optional(),
            default: z
              .string()
              .max(10000, "默认值不能超过 10000 字。")
              .optional(),
            options: z
              .array(
                z
                  .string()
                  .trim()
                  .min(1, "下拉选项不能为空。")
                  .max(80, "每个下拉选项不能超过 80 字。"),
              )
              .optional(),
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
      const problem = inputDeclarationProblem(input);
      if (problem) fail(["inputs", index], problem);
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

/** Why one input's own declaration is unusable, or null. Shared by the plan schema and nothing else. */
function inputDeclarationProblem(input: WakerFlowInput): string | null {
  const type = input.type ?? "text";
  if (type === "select") {
    const options = input.options ?? [];
    if (options.length === 0)
      return `下拉输入「${input.label}」至少需要一个选项。`;
    if (options.length > 20)
      return `下拉输入「${input.label}」最多 20 个选项。`;
    if (new Set(options).size !== options.length)
      return `下拉输入「${input.label}」的选项重复。`;
  } else if (input.options !== undefined) {
    return `只有下拉输入可以设置选项（「${input.label}」）。`;
  }
  if (input.default !== undefined && input.default.trim() !== "") {
    const problem = valueProblem(input, input.default);
    if (problem) return `「${input.label}」的默认值无效：${problem}`;
  }
  return null;
}

/** Why a filled value is not a value of the input's type, or null. The value itself is never changed. */
function valueProblem(input: WakerFlowInput, value: string): string | null {
  switch (input.type ?? "text") {
    case "number": {
      const trimmed = value.trim();
      return trimmed !== "" && Number.isFinite(Number(trimmed))
        ? null
        : `${input.label} 需要填写数字。`;
    }
    case "boolean":
      return value === "true" || value === "false"
        ? null
        : `${input.label} 只能是 true（是）或 false（否）。`;
    case "select":
      return (input.options ?? []).includes(value)
        ? null
        : `${input.label} 需要从选项中选择。`;
    default:
      return null;
  }
}

export type FlowInputsOptions = {
  /**
   * Whether an empty input takes its declared default (default true, as the run panel does). An
   * automation's saved inputs are checked with `false` for required inputs (`automationFlowInputs`):
   * a value it never had is not filled in for it behind its back.
   */
  defaults?: boolean;
};

/**
 * Form input is bounded before dispatch, and missing required input is a validation error.
 *
 * WF8: each filled value must be a value of its input's type (`number`, `boolean`, `select`); an
 * empty one takes the input's default when it has one. A plan without types (every plan saved before
 * WF8) reads exactly as it did: text values, empty ones kept as sent.
 */
export function flowInputs(
  plan: WakerFlowPlan,
  values: unknown,
  options: FlowInputsOptions = {},
): Record<string, string> {
  const parsed = z.record(z.string(), z.string().max(10000)).parse(values);
  const declared = new Set(plan.inputs.map((input) => input.key));
  for (const name of Object.keys(parsed)) {
    if (!declared.has(name)) throw new Error(`流程没有声明输入 ${name}。`);
  }
  const fillDefaults = options.defaults ?? true;
  const result: Record<string, string> = {};
  for (const input of plan.inputs) {
    const raw = parsed[input.key];
    const filled = raw !== undefined && raw.trim() !== "";
    if (!filled) {
      if (fillDefaults && input.default !== undefined && input.default !== "") {
        result[input.key] = input.default;
        continue;
      }
      if (input.required) throw new Error(`请填写 ${input.label}。`);
      const type = input.type ?? "text";
      // A text input sent empty stays as sent, as before WF8; an empty number or choice is no value.
      if (raw !== undefined && (type === "text" || type === "textarea"))
        result[input.key] = raw;
      continue;
    }
    const problem = valueProblem(input, raw);
    if (problem) throw new Error(problem);
    result[input.key] = raw;
  }
  if (Object.values(result).join("").length > 20000)
    throw new Error("流程输入合计不能超过 20000 字。");
  return result;
}

/**
 * AUT3: the inputs an automation saved for its Flow, checked against the Flow's plan as it is now.
 * Asked when the automation is saved and again when it fires; a required input it does not carry is
 * refused even if the plan now gives it a default, so a changed Flow is reported, not papered over.
 */
export function automationFlowInputs(
  plan: WakerFlowPlan,
  values: unknown,
): Record<string, string> {
  return flowInputs(plan, values, { defaults: false });
}
