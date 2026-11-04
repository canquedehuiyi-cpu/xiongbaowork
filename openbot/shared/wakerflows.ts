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

export type WakerFlowPlan = {
  name: string;
  description: string;
  members: { agentId: string; role: string }[];
  inputs: WakerFlowInput[];
  steps: {
    id: string;
    agentId: string;
    instruction: string;
    inputKeys: string[];
    outputKey: string;
  }[];
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
