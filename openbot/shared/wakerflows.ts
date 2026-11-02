export type WakerFlowPlan = {
  name: string;
  description: string;
  members: { agentId: string; role: string }[];
  inputs: { key: string; label: string; required: boolean }[];
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
