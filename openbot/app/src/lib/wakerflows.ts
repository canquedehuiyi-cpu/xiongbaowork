import { queryOptions } from "@tanstack/react-query";
import { client, RequestError } from "@/lib/client";
import type {
  FlowModelChoice,
  WakerFlow,
  WakerFlowCandidate,
  WakerFlowGenerationResult,
  WakerFlowPlan,
  WakerFlowRequestStatus,
  WakerFlowSaveInput,
} from "../../../shared/wakerflows";

export type {
  FlowModelChoice,
  WakerFlow,
  WakerFlowCandidate,
  WakerFlowGenerationResult,
  WakerFlowPlan,
  WakerFlowRequestStatus,
  WakerFlowSaveInput,
};
export {
  WAKERFLOW_CONFLICT_MESSAGE,
  WAKERFLOW_SUGGESTIONS,
} from "../../../shared/wakerflows";

/**
 * The browser's side of the WakerFlow API (spec D10, stories WF1-WF3; server routes in
 * `server/src/wakerflows/routes.ts`).
 *
 * Transport only. Which workspace is asking is the session's, never a field sent from here, and every
 * sentence a person reads on a refusal is the server's own fixed Chinese wording — a provider's error
 * text never reaches this client, so nothing here needs to filter it.
 */

const BASE = "/api/wakerflows";
const at = (id: string) => `${BASE}/${encodeURIComponent(id)}`;

/** One planning or start request as the server recorded it. */
export type WakerFlowRequest = {
  id: string;
  requestId: string;
  flowId: string;
  kind: string;
  status: WakerFlowRequestStatus;
  runId: string | null;
  taskId: string | null;
  /** Always the product's own words. */
  error: string | null;
  result: WakerFlowGenerationResult | null;
};

export type WakerFlowRunSummary = {
  id: string;
  status: string;
  templateId: string | null;
  parentTaskId: string | null;
  createdAt: string;
};

/** Where a run of a Flow stands, as the pipeline records it. */
export type WakerFlowRunStatus =
  | "running"
  | "awaiting_action"
  | "done"
  | "failed"
  | "aborted";

/** One step of a run: the plan's step, plus where it got to and what it produced. */
export type WakerFlowRunStep = {
  id: string;
  agentId: string;
  instruction: string;
  inputKeys?: string[];
  outputKey?: string;
  state:
    | "pending"
    | "running"
    | "awaiting_action"
    | "done"
    | "failed"
    | "skipped"
    | "aborted";
  taskId?: string;
  output?: string;
  error?: string;
};

/** One run of a Flow, as `GET /api/wakerflows/:id/runs/:runId` answers it. */
export type WakerFlowRun = {
  id: string;
  flowId: string;
  status: WakerFlowRunStatus;
  cursor: number;
  steps: WakerFlowRunStep[];
  parentTaskId: string | null;
  inputs: Record<string, string>;
};

/** What the abort endpoint answers: the run as it stands once stopped (or as it had already ended). */
export type WakerFlowAbortOutcome = {
  status: WakerFlowRunStatus;
  cursor: number;
  steps: WakerFlowRunStep[];
};

/** A run in one of these states has ended and never runs again (spec D10, story WF5). */
export function isTerminalRunStatus(status: string): boolean {
  return status === "done" || status === "failed" || status === "aborted";
}

/**
 * The run a screen shows when two answers about it arrived out of order (story WF5).
 *
 * Polling and 停止 race: a poll sent before the stop can answer after it, still saying `running`.
 * Once a run has been seen ended, an answer that says otherwise is the stale one, so the ended
 * reading is kept. Between two non-terminal readings the newer one wins.
 */
export function laterRunReading<T extends { status: string }>(
  known: T | null | undefined,
  incoming: T | null | undefined,
): T | null {
  if (!known) return incoming ?? null;
  if (!incoming) return known;
  if (
    isTerminalRunStatus(known.status) &&
    !isTerminalRunStatus(incoming.status)
  )
    return known;
  return incoming;
}

/**
 * The run form's checks before anything is sent: each required input filled, nothing over the
 * server's bounds. Keyed by input key; empty means the run may start. The server stays the authority
 * (`server/src/wakerflows/plan.ts` `flowInputs`).
 */
export function runInputProblems(
  plan: WakerFlowPlan,
  values: Record<string, string>,
): Record<string, string> {
  const problems: Record<string, string> = {};
  let total = 0;
  for (const input of plan.inputs) {
    const value = values[input.key] ?? "";
    total += value.length;
    if (input.required && !value.trim())
      problems[input.key] = `请填写 ${input.label}。`;
    else if (value.length > 10000)
      problems[input.key] = `${input.label} 不能超过 10000 字。`;
  }
  if (total > 20000 && plan.inputs[0])
    problems[plan.inputs[0].key] ??= "流程输入合计不能超过 20000 字。";
  return problems;
}

export type WakerFlowGenerateInput = {
  requestId: string;
  modelRef: string;
  idea: string;
  members: WakerFlowCandidate[];
  scenario?: string;
};

export const wakerFlowKeys = {
  all: ["wakerflows"] as const,
  list: () => ["wakerflows", "list"] as const,
  detail: (id: string) => ["wakerflows", "detail", id] as const,
  modelChoices: () => ["wakerflows", "model-choices"] as const,
  runs: (id: string) => ["wakerflows", "runs", id] as const,
  run: (id: string, runId: string) =>
    ["wakerflows", "runs", id, runId] as const,
};

export function listWakerFlows() {
  return client<WakerFlow[]>(BASE, "flows", {
    fallback: "WakerFlow 列表没能加载。",
  });
}

export function getWakerFlow(id: string) {
  return client<WakerFlow>(at(id), "flow", {
    fallback: "这个 WakerFlow 没能加载。",
  });
}

export function listFlowModelChoices() {
  return client<FlowModelChoice[]>(`${BASE}/model-choices`, "models", {
    fallback: "可用于规划的模型没能加载。",
  });
}

export function createWakerFlow(input: {
  idea: string;
  name?: string;
  description?: string;
  modelRef?: string | null;
}) {
  return client<WakerFlow>(BASE, "flow", {
    method: "POST",
    body: input,
    fallback: "WakerFlow 没能创建。",
  });
}

/** A 409 here is a lost revision race: the caller reloads rather than overwriting. */
export function saveWakerFlow(id: string, input: WakerFlowSaveInput) {
  return client<WakerFlow>(at(id), "flow", {
    method: "PUT",
    body: input,
    fallback: "这个 WakerFlow 没能保存。",
  });
}

export function deleteWakerFlow(id: string, revision?: number) {
  return client<boolean>(
    revision === undefined ? at(id) : `${at(id)}?revision=${revision}`,
    "deleted",
    { method: "DELETE", fallback: "这个 WakerFlow 没能删除。" },
  );
}

export function generateWakerFlowPlan(
  id: string,
  input: WakerFlowGenerateInput,
) {
  return client<WakerFlowRequest>(`${at(id)}/generate`, "request", {
    method: "POST",
    body: input,
    fallback: "计划没能生成，请重试。",
  });
}

export function cancelWakerFlowGeneration(id: string, requestId: string) {
  return client<WakerFlowRequest>(`${at(id)}/generate/cancel`, "request", {
    method: "POST",
    body: { requestId },
    fallback: "没能取消这次生成。",
  });
}

/** Null when the server has no row for this id: the request never got as far as being claimed. */
export async function getWakerFlowRequest(
  id: string,
  requestId: string,
): Promise<WakerFlowRequest | null> {
  try {
    return await client<WakerFlowRequest>(
      `${at(id)}/requests/${encodeURIComponent(requestId)}`,
      "request",
      { fallback: "没能读到这次生成的状态。" },
    );
  } catch (error) {
    if (error instanceof RequestError && error.status === 404) return null;
    throw error;
  }
}

export function startWakerFlowRun(
  id: string,
  input: {
    requestId: string;
    revision: number;
    inputs: Record<string, string>;
  },
) {
  return client<WakerFlowRequest>(`${at(id)}/runs`, "request", {
    method: "POST",
    body: input,
    fallback: "这次运行没能开始。",
  });
}

export function listWakerFlowRuns(id: string) {
  return client<WakerFlowRunSummary[]>(`${at(id)}/runs`, "runs", {
    fallback: "运行记录没能加载。",
  });
}

export function getWakerFlowRun(id: string, runId: string) {
  return client<WakerFlowRun>(
    `${at(id)}/runs/${encodeURIComponent(runId)}`,
    "run",
    { fallback: "这次运行没能加载。" },
  );
}

/** The answer is not enveloped: the pipeline's own outcome, or null when it could not be read. */
export async function abortWakerFlowRun(
  id: string,
  runId: string,
): Promise<WakerFlowAbortOutcome | null> {
  const response = await client(
    `${at(id)}/runs/${encodeURIComponent(runId)}/abort`,
    { method: "POST", fallback: "这次运行没能中止。" },
  );
  const body = (await response.json().catch(() => null)) as unknown;
  return body !== null &&
    typeof body === "object" &&
    typeof (body as { status?: unknown }).status === "string"
    ? (body as WakerFlowAbortOutcome)
    : null;
}

export function wakerFlowsQueryOptions() {
  return queryOptions({
    queryKey: wakerFlowKeys.list(),
    queryFn: listWakerFlows,
  });
}

export function wakerFlowQueryOptions(id: string) {
  return queryOptions({
    queryKey: wakerFlowKeys.detail(id),
    queryFn: () => getWakerFlow(id),
  });
}

export function flowModelChoicesQueryOptions() {
  return queryOptions({
    queryKey: wakerFlowKeys.modelChoices(),
    queryFn: listFlowModelChoices,
    retry: false,
  });
}

/** The same rule the server applies to input, step and output names. */
export const PLAN_KEY_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
const KEY_MESSAGE = "名称需以小写字母开头，只包含字母、数字和下划线。";

/**
 * The plan checks the server makes on Save (`server/src/wakerflows/plan.ts`), made here first so a
 * person sees which field is wrong before anything is sent. Keyed by the field's path, e.g.
 * `steps.0.inputKeys`; empty means the plan may be saved. The server stays the authority.
 */
export function planProblems(plan: WakerFlowPlan): Record<string, string> {
  const problems: Record<string, string> = {};
  const fail = (path: string, message: string) => {
    if (!(path in problems)) problems[path] = message;
  };
  const name = plan.name.trim();
  if (!name) fail("name", "请填写流程名称。");
  else if (name.length > 160) fail("name", "流程名称不能超过 160 字。");
  if (plan.description.trim().length > 4000)
    fail("description", "流程说明不能超过 4000 字。");

  if (plan.members.length === 0) fail("members", "计划里至少要有一位员工。");
  if (plan.members.length > 10) fail("members", "计划里最多 10 位员工。");
  const members = new Set<string>();
  plan.members.forEach((member, index) => {
    if (!member.agentId) fail(`members.${index}.agentId`, "请选择员工。");
    else if (members.has(member.agentId))
      fail(`members.${index}.agentId`, "同一位员工不能重复加入计划。");
    members.add(member.agentId);
    const role = member.role.trim();
    if (!role) fail(`members.${index}.role`, "请填写这位员工在流程中的角色。");
    else if (role.length > 160)
      fail(`members.${index}.role`, "角色不能超过 160 字。");
  });

  if (plan.inputs.length > 20) fail("inputs", "流程输入最多 20 个。");
  const available = new Set<string>();
  plan.inputs.forEach((input, index) => {
    if (!PLAN_KEY_PATTERN.test(input.key))
      fail(`inputs.${index}.key`, KEY_MESSAGE);
    else if (available.has(input.key))
      fail(`inputs.${index}.key`, "流程输入名称重复。");
    available.add(input.key);
    const label = input.label.trim();
    if (!label) fail(`inputs.${index}.label`, "请填写输入的显示名称。");
    else if (label.length > 160)
      fail(`inputs.${index}.label`, "显示名称不能超过 160 字。");
  });

  if (plan.steps.length === 0) fail("steps", "计划里至少要有一个步骤。");
  if (plan.steps.length > 10) fail("steps", "计划里最多 10 个步骤。");
  const steps = new Set<string>();
  plan.steps.forEach((step, index) => {
    if (!PLAN_KEY_PATTERN.test(step.id))
      fail(`steps.${index}.id`, "步骤编号无效。");
    else if (steps.has(step.id)) fail(`steps.${index}.id`, "步骤编号重复。");
    steps.add(step.id);
    if (!members.has(step.agentId))
      fail(`steps.${index}.agentId`, "步骤只能交给计划中的员工。");
    const instruction = step.instruction.trim();
    if (!instruction)
      fail(`steps.${index}.instruction`, "请写明这一步要做什么。");
    else if (instruction.length > 8000)
      fail(`steps.${index}.instruction`, "步骤说明不能超过 8000 字。");
    if (step.inputKeys.length > 30)
      fail(`steps.${index}.inputKeys`, "一个步骤最多读取 30 项输入。");
    if (new Set(step.inputKeys).size !== step.inputKeys.length)
      fail(`steps.${index}.inputKeys`, "步骤输入名称重复。");
    for (const input of step.inputKeys) {
      if (!available.has(input))
        fail(
          `steps.${index}.inputKeys`,
          `输入 ${input} 尚未产生；只能读取流程输入或前面步骤的输出。`,
        );
    }
    if (!PLAN_KEY_PATTERN.test(step.outputKey))
      fail(`steps.${index}.outputKey`, KEY_MESSAGE);
    else if (available.has(step.outputKey))
      fail(`steps.${index}.outputKey`, "步骤输出不能覆盖已有输入或输出。");
    available.add(step.outputKey);
  });
  return problems;
}
