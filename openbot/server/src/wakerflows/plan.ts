import { parse as parseCel } from "cel-js";
import { z } from "zod";
import {
  stepAgentId,
  stepKind,
  stepOutputKey,
  stepReads,
  stepTargets,
  WAKERFLOW_END,
  WAKERFLOW_INPUT_TYPES,
  WAKERFLOW_MAX_BRANCHES,
  WAKERFLOW_MAX_STEPS,
  type WakerFlowInput,
  type WakerFlowPlan,
  type WakerFlowStep,
  type WakerFlowStepKind,
} from "../../../shared/wakerflows";
import type { PipelineStepRow } from "../db/schema/pipeline";

const KEY_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
const key = z
  .string()
  .regex(KEY_PATTERN, "名称需以小写字母开头，只包含字母、数字和下划线。");
/** Where a step may jump: a step id (checked against the plan below), or the end of the run. */
const target = z
  .string()
  .refine(
    (value) => value === WAKERFLOW_END || KEY_PATTERN.test(value),
    "跳转目标无效。",
  );
const agentId = z.string().min(1).max(200);
const inputKeys = z.array(key).max(30);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const wakerFlowMembersSchema = z
  .array(
    z
      .object({
        agentId,
        role: z.string().trim().min(1).max(160),
        // WF7 (D2): what this coworker does in this Flow; written ahead of each of its steps.
        prompt: z
          .string()
          .trim()
          .max(4000, "员工提示词不能超过 4000 字。")
          .optional(),
      })
      .strict(),
  )
  .min(1)
  .max(10);

/** A coworker's turn, the only step a plan had before WF7: a step without `kind` is one. */
const workerStepSchema = z
  .object({
    id: key,
    kind: z.literal("worker").optional(),
    agentId,
    instruction: z.string().trim().min(1).max(8000),
    inputKeys,
    outputKey: key,
    next: target.optional(),
  })
  .strict();

const decisionStepSchema = z
  .object({
    id: key,
    kind: z.literal("decision"),
    inputKeys,
    branches: z
      .array(
        z
          .object({
            label: z
              .string()
              .trim()
              .min(1, "请填写分支名称。")
              .max(40, "分支名称不能超过 40 字。"),
            when: z
              .string()
              .trim()
              .min(1, "请填写分支条件。")
              .max(500, "分支条件不能超过 500 字。"),
            next: target,
          })
          .strict(),
      )
      .min(1, "判断至少需要一个分支。")
      .max(
        WAKERFLOW_MAX_BRANCHES,
        `一个判断最多 ${WAKERFLOW_MAX_BRANCHES} 个分支。`,
      ),
    otherwise: target,
  })
  .strict();

const flowStepSchema = z
  .object({
    id: key,
    kind: z.literal("flow"),
    targetFlowId: z.string().regex(UUID_PATTERN, "请选择要嵌套的子流程。"),
    targetRevision: z.number().int().min(1, "子流程版本无效。"),
    inputMap: z.record(key, key),
    outputKey: key,
    resultKey: key.optional(),
    next: target.optional(),
  })
  .strict();

const ARG_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const actionStepSchema = z
  .object({
    id: key,
    kind: z.literal("action"),
    agentId,
    tool: z
      .string()
      .max(200)
      .regex(/^[^/\s]+\/\S+$/, "请选择要调用的工具。"),
    args: z.record(
      z.string().regex(ARG_NAME_PATTERN, "参数名称无效。"),
      // Filled from earlier outputs, which a model may have written: bounded, and only ever text.
      z.string().max(10000, "单个参数不能超过 10000 字。"),
    ),
    inputKeys,
    outputKey: key,
    next: target.optional(),
  })
  .strict();

const stepSchema = z.discriminatedUnion(
  "kind",
  [workerStepSchema, decisionStepSchema, flowStepSchema, actionStepSchema],
  { error: "未知的步骤类型。" },
);

/**
 * The kinds of step the server can run today. A kind the orchestrator cannot execute yet is refused
 * on Save rather than saved and failed at run time; each WF7 stage widens this list as it lands.
 */
export const RUNNABLE_STEP_KINDS: readonly WakerFlowStepKind[] = [
  "worker",
  "decision",
  "flow",
];
/** Whether the orchestrator follows `next` jumps yet; until it does, a jump is refused on Save. */
export const RUNNABLE_JUMPS = true;

/** `{{key}}` in an action's argument template. */
const TEMPLATE_PATTERN = /\{\{\s*([^{}\s]*)\s*\}\}/g;
/** `inputs.key`, `outputs.key`, `inputs["key"]` and `outputs['key']` in a condition. */
const CONDITION_REFERENCE_PATTERN =
  /\b(inputs|outputs)\s*(?:\.\s*([A-Za-z_][A-Za-z0-9_]*)|\[\s*(?:"([^"]*)"|'([^']*)')\s*\])/g;

/** The keys a condition reads, each with the namespace it reads it from. */
export function conditionReferences(
  expression: string,
): { scope: "inputs" | "outputs"; key: string }[] {
  return Array.from(
    expression.matchAll(CONDITION_REFERENCE_PATTERN),
    (match) => ({
      scope: match[1] as "inputs" | "outputs",
      key: match[2] ?? match[3] ?? match[4] ?? "",
    }),
  );
}

/** The keys an action's argument template reads. */
export function templateReferences(template: string): string[] {
  return Array.from(
    template.matchAll(TEMPLATE_PATTERN),
    (match) => match[1] ?? "",
  );
}

type Fail = (path: (string | number)[], message: string) => void;

/**
 * The control-flow checks of P-A (spec §3.1): every jump goes forward to a step that exists (or to
 * the end), every step is reachable, and a step reads only what is produced on EVERY path to it.
 *
 * Because every edge points forward, the graph is acyclic and the steps are already in topological
 * order, so one pass in array order computes, for each step, the keys that are certainly available
 * (the intersection over its predecessors) and the keys that may be (the union): a key in the second
 * set but not the first was produced on some branch only, which gets its own message.
 */
function graphProblems(plan: WakerFlowPlan, fail: Fail) {
  const steps = plan.steps;
  const count = steps.length;
  const position = new Map(steps.map((step, index) => [step.id, index]));
  const successors = steps.map((step, index) => {
    const out = new Set<number>();
    const paths: (string | number)[][] =
      step.kind === "decision"
        ? [
            ...step.branches.map((_, branch) => ["branches", branch, "next"]),
            ["otherwise"],
          ]
        : [["next"]];
    stepTargets(step).forEach((jump, at) => {
      const path = ["steps", index, ...(paths[at] ?? ["next"])];
      if (jump === undefined) out.add(index + 1);
      else if (jump === WAKERFLOW_END) out.add(count);
      else {
        const to = position.get(jump);
        if (to === undefined) fail(path, `跳转目标 ${jump} 不存在。`);
        else if (to <= index)
          fail(path, `只能跳到后面的步骤；${jump} 不在这一步之后。`);
        else out.add(to);
      }
    });
    return out;
  });

  const inputs = plan.inputs.map((input) => input.key);
  const must: (Set<string> | null)[] = steps.map(() => null);
  const may: Set<string>[] = steps.map(() => new Set());
  if (count > 0) {
    must[0] = new Set(inputs);
    may[0] = new Set(inputs);
  }
  steps.forEach((step, index) => {
    const certain = must[index];
    if (!certain) {
      fail(["steps", index], `没有任何路径会走到步骤 ${step.id}。`);
      return;
    }
    const field = step.kind === "flow" ? "inputMap" : "inputKeys";
    for (const read of stepReads(step)) {
      if (certain.has(read)) continue;
      fail(
        ["steps", index, field],
        may[index]?.has(read)
          ? `输入 ${read} 只在部分分支中产生；走到这一步的其他路径上没有它。`
          : `输入 ${read} 尚未产生；只能读取流程输入或前面步骤的输出。`,
      );
    }
    const produced = stepOutputKey(step);
    for (const next of successors[index] ?? []) {
      if (next >= count) continue;
      const exitCertain = new Set(certain);
      const exitMaybe = new Set(may[index]);
      if (produced) {
        exitCertain.add(produced);
        exitMaybe.add(produced);
      }
      const before = must[next];
      must[next] = before
        ? new Set([...before].filter((name) => exitCertain.has(name)))
        : exitCertain;
      for (const name of exitMaybe) may[next]?.add(name);
    }
  });
}

/** What one step's own fields allow, beyond their shapes: CEL, references, templates. */
function stepProblems(
  plan: WakerFlowPlan,
  step: WakerFlowStep,
  index: number,
  fail: Fail,
) {
  const inputs = new Set(plan.inputs.map((input) => input.key));
  if (step.kind === "decision") {
    const declared = new Set(step.inputKeys);
    const labels = new Set<string>();
    step.branches.forEach((branch, at) => {
      const path = ["steps", index, "branches", at];
      if (labels.has(branch.label))
        fail([...path, "label"], "同一个判断里的分支名称不能重复。");
      labels.add(branch.label);
      if (!parseCel(branch.when).isSuccess) {
        fail(
          [...path, "when"],
          `分支「${branch.label}」的条件不是有效的 CEL 表达式。`,
        );
        return;
      }
      for (const reference of conditionReferences(branch.when)) {
        const name = `${reference.scope}.${reference.key}`;
        if (!declared.has(reference.key))
          fail(
            [...path, "when"],
            `分支「${branch.label}」读取了 ${name}，但这一步没有声明读取 ${reference.key}。`,
          );
        else if ((reference.scope === "inputs") !== inputs.has(reference.key))
          fail(
            [...path, "when"],
            reference.scope === "inputs"
              ? `${reference.key} 不是流程输入，请写成 outputs.${reference.key}。`
              : `${reference.key} 是流程输入，请写成 inputs.${reference.key}。`,
          );
      }
    });
  }
  if (step.kind === "flow" && Object.keys(step.inputMap).length > 20)
    fail(["steps", index, "inputMap"], "子流程最多传入 20 项输入。");
  if (step.kind === "action") {
    const names = Object.keys(step.args);
    if (names.length > 30)
      fail(["steps", index, "args"], "一个动作最多 30 个参数。");
    const declared = new Set(step.inputKeys);
    for (const name of names) {
      for (const read of templateReferences(step.args[name] ?? "")) {
        if (!declared.has(read))
          fail(
            ["steps", index, "args", name],
            `参数 ${name} 引用了 {{${read}}}，但这一步没有声明读取它。`,
          );
      }
    }
  }
}

/**
 * The plan schema, for the step kinds (and jumps) given. The live schema is
 * {@link wakerFlowPlanSchema}; a test can ask about kinds the server does not run yet.
 */
export function createWakerFlowPlanSchema(
  options: { kinds?: readonly WakerFlowStepKind[]; jumps?: boolean } = {},
) {
  const kinds = new Set(options.kinds ?? RUNNABLE_STEP_KINDS);
  const jumps = options.jumps ?? RUNNABLE_JUMPS;
  return z
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
        .array(stepSchema)
        .min(1)
        // D4: raised from 10 to 20; the quota counts the steps that run, not the steps written.
        .max(WAKERFLOW_MAX_STEPS, `计划里最多 ${WAKERFLOW_MAX_STEPS} 个步骤。`),
    })
    .strict()
    .superRefine((parsed, context) => {
      const plan = parsed as WakerFlowPlan;
      const fail: Fail = (path, message) =>
        context.addIssue({ code: "custom", path, message });
      const members = new Set<string>();
      plan.members.forEach((member, index) => {
        if (members.has(member.agentId))
          fail(["members", index, "agentId"], "同一位员工不能重复加入计划。");
        members.add(member.agentId);
      });
      const names = new Set<string>();
      plan.inputs.forEach((input, index) => {
        if (names.has(input.key))
          fail(["inputs", index, "key"], "流程输入名称重复。");
        names.add(input.key);
        const problem = inputDeclarationProblem(input);
        if (problem) fail(["inputs", index], problem);
      });
      const ids = new Set<string>();
      plan.steps.forEach((step, index) => {
        if (!kinds.has(stepKind(step)))
          fail(["steps", index, "kind"], "这种步骤暂时还不能运行。");
        if (!jumps && step.kind !== "decision" && step.next !== undefined)
          fail(["steps", index, "next"], "步骤跳转暂时还不能运行。");
        if (ids.has(step.id)) fail(["steps", index, "id"], "步骤编号重复。");
        ids.add(step.id);
        const agent = stepAgentId(step);
        if (agent !== undefined && !members.has(agent))
          fail(["steps", index, "agentId"], "步骤只能交给计划中的员工。");
        const reads = stepReads(step);
        if (step.kind !== "flow" && new Set(reads).size !== reads.length)
          fail(["steps", index, "inputKeys"], "步骤输入名称重复。");
        const produced = stepOutputKey(step);
        if (produced !== undefined) {
          if (names.has(produced))
            fail(
              ["steps", index, "outputKey"],
              "步骤输出不能覆盖已有输入或输出。",
            );
          names.add(produced);
        }
        stepProblems(plan, step, index, fail);
      });
      graphProblems(plan, fail);
    });
}

/**
 * The editable plan is also the execution contract; no hidden steps are added after Save.
 *
 * WF7 (P-A): a step may be a coworker's turn (`worker`, the default), a condition (`decision`), a
 * nested Flow (`flow`) or a fixed tool call (`action`), and may jump forward. Only the kinds the
 * server runs today are accepted ({@link RUNNABLE_STEP_KINDS}).
 */
export const wakerFlowPlanSchema = createWakerFlowPlanSchema();

/**
 * The template steps a saved plan compiles to (WF7: `rolePrompt` is the member's role and prompt,
 * written ahead of each of that coworker's steps). A worker step of a plan saved before WF7 compiles
 * exactly as it did.
 */
export function compiledSteps(
  plan: WakerFlowPlan,
  /** For each `flow` step, by step id: the pinned revision's template and the child's name. */
  children: ReadonlyMap<
    string,
    { templateId: string; name: string }
  > = new Map(),
): PipelineStepRow[] {
  const members = new Map(
    plan.members.map((member) => [member.agentId, member]),
  );
  return plan.steps.map((step): PipelineStepRow => {
    if (step.kind === "flow") {
      const child = children.get(step.id);
      if (!child) throw new Error(`子流程 ${step.id} 没有可运行的版本。`);
      return {
        id: step.id,
        kind: "flow",
        agentId: "",
        instruction: `子流程「${child.name}」`,
        targetFlowId: step.targetFlowId,
        targetRevision: step.targetRevision,
        targetTemplateId: child.templateId,
        inputMap: { ...step.inputMap },
        outputKey: step.outputKey,
        ...(step.resultKey === undefined ? {} : { resultKey: step.resultKey }),
        ...(step.next === undefined ? {} : { next: step.next }),
      };
    }
    if (step.kind === "decision")
      // No coworker of its own; `instruction` is what the run view calls it.
      return {
        id: step.id,
        kind: "decision",
        agentId: "",
        instruction: `条件判断：${step.branches.map((branch) => branch.label).join(" / ")}`,
        inputKeys: [...step.inputKeys],
        branches: step.branches.map((branch) => ({ ...branch })),
        otherwise: step.otherwise,
      };
    if (step.kind !== undefined && step.kind !== "worker")
      throw new Error(`这种步骤暂时还不能运行（${step.kind}）。`);
    const member = members.get(step.agentId);
    const prompt = member?.prompt?.trim();
    return {
      id: step.id,
      agentId: step.agentId,
      instruction: step.instruction,
      inputKeys: [...step.inputKeys],
      outputKey: step.outputKey,
      ...(prompt && member ? { rolePrompt: `${member.role}\n${prompt}` } : {}),
      ...(step.next === undefined ? {} : { next: step.next }),
    };
  });
}

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
