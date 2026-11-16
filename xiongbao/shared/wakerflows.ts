/**
 * How a Flow input is entered (WF8). Every value is still a string on the wire and in the run; the
 * type only says how it is entered and what `flowInputs` accepts. A plan without a type is `text`.
 */
export const WAKERFLOW_INPUT_TYPES = [
  "text",
  "textarea",
  "number",
  "select",
  "boolean",
] as const;
export type WakerFlowInputType = (typeof WAKERFLOW_INPUT_TYPES)[number];

export type WakerFlowInput = {
  key: string;
  label: string;
  required: boolean;
  /** Absent means `text`, so plans saved before WF8 read exactly as they did. */
  type?: WakerFlowInputType;
  description?: string;
  /** Used when the input is left empty. Must itself be a valid value of the type. */
  default?: string;
  /** Only for `select`: the values a person may choose from (1–20, each at most 80 characters). */
  options?: string[];
};

/**
 * WF7: the kinds of node a plan step can be. A step without a `kind` is a `worker`, so every plan
 * saved before WF7 reads exactly as it did.
 */
export const WAKERFLOW_STEP_KINDS = [
  "worker",
  "decision",
  "flow",
  "action",
  "confirm",
] as const;
export type WakerFlowStepKind = (typeof WAKERFLOW_STEP_KINDS)[number];

/** How many steps one plan may hold (D4: raised from 10 to 20). */
export const WAKERFLOW_MAX_STEPS = 20;
/** How many branches one decision may have, besides its `otherwise`. */
export const WAKERFLOW_MAX_BRANCHES = 8;
/** How deep Flows may nest inside each other at run time (D10). */
export const WAKERFLOW_MAX_NESTING = 3;
/**
 * The jump target that ends the run instead of naming a step. Not a valid step id (step ids start
 * with a lowercase letter), so it can never collide with one.
 */
export const WAKERFLOW_END = "__end__";

/** One member of a plan: a coworker, its role, and what it is told about its part (D2). */
export type WakerFlowMember = {
  agentId: string;
  role: string;
  /** WF7: what this coworker is responsible for in this Flow and how; prefixed to each of its steps. */
  prompt?: string;
};

/**
 * Fields every step shares. `next` jumps forward to a later step (or {@link WAKERFLOW_END}) after
 * this one ends; absent means the next step in order. A jump never points backwards (P-A), so every
 * run ends.
 */
type WakerFlowStepBase = { id: string; next?: string };

/** A coworker's turn: the only kind a plan had before WF7. */
export type WakerFlowWorkerStep = WakerFlowStepBase & {
  kind?: "worker";
  agentId: string;
  instruction: string;
  inputKeys: string[];
  outputKey: string;
};

/** One branch of a decision: taken when `when` (a CEL expression) is true. */
export type WakerFlowBranch = { label: string; when: string; next: string };

/**
 * A condition the orchestrator evaluates itself, with no coworker and no model: the first branch
 * whose `when` is true is taken, else `otherwise`.
 */
export type WakerFlowDecisionStep = WakerFlowStepBase & {
  kind: "decision";
  inputKeys: string[];
  branches: WakerFlowBranch[];
  otherwise: string;
};

/** Another Flow run as one step, at the revision recorded when this plan was saved (D5). */
export type WakerFlowFlowStep = WakerFlowStepBase & {
  kind: "flow";
  targetFlowId: string;
  targetRevision: number;
  /** Child input name → the parent key (input or earlier output) it is filled from. */
  inputMap: Record<string, string>;
  outputKey: string;
  /** Which of the child's outputs becomes this step's output; absent is its last finished step's. */
  resultKey?: string;
};

/** One fixed MCP tool call made as a coworker, with no model turn (D6 = A-1, D7). */
export type WakerFlowActionStep = WakerFlowStepBase & {
  kind: "action";
  agentId: string;
  /** `<serverId>/<toolName>`. */
  tool: string;
  /** Argument name → template; `{{key}}` is replaced by that input or earlier output, as text. */
  args: Record<string, string>;
  inputKeys: string[];
  outputKey: string;
};

/** The longest a confirmation's question may be as written (before `{{key}}` is filled). */
export const WAKERFLOW_MAX_QUESTION = 2000;

/**
 * A question the run asks a person, with no coworker and no model (WF8 §3.3's 确认节点): the run
 * parks on it, the answer becomes this step's output, and a skip leaves the output missing.
 * `{{key}}` in the question is replaced by that input or earlier output, as text only.
 */
export type WakerFlowConfirmStep = WakerFlowStepBase & {
  kind: "confirm";
  question: string;
  inputKeys: string[];
  outputKey: string;
};

export type WakerFlowStep =
  | WakerFlowWorkerStep
  | WakerFlowDecisionStep
  | WakerFlowFlowStep
  | WakerFlowActionStep
  | WakerFlowConfirmStep;

/** The kind of a step, reading an absent `kind` as `worker`. */
export function stepKind(step: { kind?: string }): WakerFlowStepKind {
  return (step.kind ?? "worker") as WakerFlowStepKind;
}

export function isWorkerStep(step: WakerFlowStep): step is WakerFlowWorkerStep {
  return step.kind === undefined || step.kind === "worker";
}

/** The output a step produces, if any (a decision produces none). */
export function stepOutputKey(step: WakerFlowStep): string | undefined {
  return step.kind === "decision" ? undefined : step.outputKey;
}

/** The plan keys a step reads: its inputs, or for a nested Flow the parent keys it maps in. */
export function stepReads(step: WakerFlowStep): string[] {
  return step.kind === "flow" ? Object.values(step.inputMap) : step.inputKeys;
}

/**
 * The coworker a step runs as, if any (a decision, a nested Flow and a confirmation have none of
 * their own).
 */
export function stepAgentId(step: WakerFlowStep): string | undefined {
  return step.kind === "decision" ||
    step.kind === "flow" ||
    step.kind === "confirm"
    ? undefined
    : step.agentId;
}

/** Where a step may go next: every target it can jump to, in order (`undefined` is the next step). */
export function stepTargets(step: WakerFlowStep): (string | undefined)[] {
  return step.kind === "decision"
    ? [...step.branches.map((branch) => branch.next), step.otherwise]
    : [step.next];
}

export type WakerFlowPlan = {
  name: string;
  description: string;
  members: WakerFlowMember[];
  inputs: WakerFlowInput[];
  steps: WakerFlowStep[];
};

export type WakerFlow = {
  id: string;
  name: string;
  description: string;
  idea: string;
  modelRef: string | null;
  plan: WakerFlowPlan | null;
  status: "draft" | "ready";
  revision: number;
  groupId: string | null;
  templateId: string | null;
  createdAt: string;
  updatedAt: string;
};

export const WAKERFLOW_SUGGESTIONS = [
  "帮我创建周会准备流程，生成一套通用议程和会前清单",
  "帮我创建会议纪要流程，整理结论、待办和负责人",
  "帮我创建工作周报流程，汇总进展、风险和下周计划",
] as const;

/** What the editor sends on Save: the plan it edited, fenced by the revision it was editing. */
export type WakerFlowSaveInput = {
  revision: number;
  plan: WakerFlowPlan;
  /** Omitted keeps the stored model; `null` clears it. */
  modelRef?: string | null;
};

/** Shown when a Save lost the race to another tab or person; the editor reloads instead of overwriting. */
export const WAKERFLOW_CONFLICT_MESSAGE =
  "这个 WakerFlow 已在另一处修改，请刷新后再保存。";

/**
 * The model choice that means "the deployment's own model" rather than a row of the tenant's model
 * library. Whether a person may pick it is a product decision still open, so the server ships it
 * switched off: it is neither listed nor accepted until the resolver is told otherwise.
 */
export const PLATFORM_FLOW_MODEL_ID = "platform";

/** One entry of the planning model picker. */
export type FlowModelChoice = {
  /** A `model_registry` id, or {@link PLATFORM_FLOW_MODEL_ID}. */
  id: string;
  /** `provider/model`, the shape the usage record and the allowlist use. */
  name: string;
  label: string;
};

/**
 * Where a generation or start request stands. `unknown` means the provider may or may not have done
 * the work (the line dropped, the clock ran out): such a request is never replayed, a new request id
 * is the way to try again.
 */
export type WakerFlowRequestStatus =
  | "pending"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";

/** A coworker the person may put into a generated plan. */
export type WakerFlowCandidate = {
  agentId: string;
  name: string;
  role: string;
};

/** What a completed generation answers with, and what a repeat of the same request reads back. */
export type WakerFlowGenerationResult = {
  plan: WakerFlowPlan;
  modelRef: string;
  /** The draft's revision after the plan was written into it; null when it was not written. */
  revision: number | null;
  /**
   * False when the Flow had been saved (or deleted) by the time the plan arrived: a compiled Flow is
   * never overwritten behind its template, so the editor applies the plan and saves it itself.
   */
  applied: boolean;
};

/** Shown when a planning answer could not be read as a plan. Retrying is safe. */
export const WAKERFLOW_PLAN_FORMAT_MESSAGE = "计划格式无效，请重试。";
