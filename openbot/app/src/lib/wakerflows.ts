import { queryOptions } from "@tanstack/react-query";
import { client, RequestError } from "@/lib/client";
import {
  type FlowModelChoice,
  stepAgentId,
  stepKind,
  stepOutputKey,
  stepReads,
  stepTargets,
  WAKERFLOW_END,
  WAKERFLOW_MAX_BRANCHES,
  WAKERFLOW_MAX_STEPS,
  type WakerFlow,
  type WakerFlowBranch,
  type WakerFlowCandidate,
  type WakerFlowGenerationResult,
  type WakerFlowInput,
  type WakerFlowInputType,
  type WakerFlowPlan,
  type WakerFlowRequestStatus,
  type WakerFlowSaveInput,
  type WakerFlowStep,
  type WakerFlowStepKind,
} from "../../../shared/wakerflows";

export type {
  FlowModelChoice,
  WakerFlow,
  WakerFlowBranch,
  WakerFlowCandidate,
  WakerFlowGenerationResult,
  WakerFlowInput,
  WakerFlowInputType,
  WakerFlowPlan,
  WakerFlowRequestStatus,
  WakerFlowSaveInput,
  WakerFlowStep,
  WakerFlowStepKind,
};
export {
  isWorkerStep,
  stepAgentId,
  stepKind,
  stepOutputKey,
  stepReads,
  stepTargets,
  WAKERFLOW_CONFLICT_MESSAGE,
  WAKERFLOW_END,
  WAKERFLOW_INPUT_TYPES,
  WAKERFLOW_MAX_BRANCHES,
  WAKERFLOW_STEP_KINDS,
  WAKERFLOW_SUGGESTIONS,
} from "../../../shared/wakerflows";

/** How each step kind is named in the editor and the flowchart (WF7). */
export const STEP_KIND_LABEL: Record<WakerFlowStepKind, string> = {
  worker: "员工步骤",
  decision: "条件判断",
  flow: "子流程",
  action: "动作",
};

/** How each input type is named in the editor. */
export const INPUT_TYPE_LABEL: Record<WakerFlowInputType, string> = {
  text: "单行文本",
  textarea: "多行文本",
  number: "数字",
  select: "下拉选择",
  boolean: "开关",
};

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
  /** WF7: empty for a decision or a nested Flow, which run as no coworker of their own. */
  agentId?: string;
  /** What the step is called on the run's view (a decision's or nested Flow's is generated). */
  instruction?: string;
  inputKeys?: string[];
  outputKey?: string;
  /** WF7: absent is a coworker's turn. */
  kind?: WakerFlowStepKind;
  next?: string;
  branches?: WakerFlowBranch[];
  otherwise?: string;
  /** WF7: `branch` is a step no taken path reached; `person` a person's skip. */
  skipReason?: "branch" | "person";
  /** WF7: the branch a finished decision took (`index` -1 is `otherwise`). */
  branch?: { label: string; index: number };
  /** WF7: a nested Flow's child, and the Flow and version it runs. */
  targetFlowId?: string;
  targetRevision?: number;
  childRunId?: string;
  /** WF7: an action's MCP tool. */
  tool?: string;
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
  /** Set while the step waits on an approval: the approvals page is where it is answered (D5). */
  approvalId?: string;
  /** Set while the step waits on a question it asked (WF8). */
  question?: string;
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
 * Why a filled value is not a value of the input's type, or null. The same rules and the same words
 * as the server's `flowInputs` (`server/src/wakerflows/plan.ts`), which stays the authority.
 */
export function inputValueProblem(
  input: WakerFlowInput,
  value: string,
): string | null {
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

/**
 * What a form for these inputs starts with: each input's default, and a required switch starts at
 * "否" so that leaving it alone is an answer. Everything else starts empty.
 */
export function initialInputValues(
  inputs: WakerFlowInput[],
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const input of inputs) {
    if (input.default !== undefined && input.default !== "")
      values[input.key] = input.default;
    else if (input.type === "boolean" && input.required)
      values[input.key] = "false";
  }
  return values;
}

/** Only declared inputs, and only what was filled: the server refuses a name it did not declare. */
export function filledInputValues(
  inputs: WakerFlowInput[],
  values: Record<string, string>,
): Record<string, string> {
  const filled: Record<string, string> = {};
  for (const input of inputs) {
    const value = values[input.key] ?? "";
    if (value.trim()) filled[input.key] = value;
  }
  return filled;
}

/**
 * The run form's checks before anything is sent: each required input filled, each filled value one
 * its type accepts, nothing over the server's bounds. Keyed by input key; empty means the run may
 * start. The server stays the authority (`server/src/wakerflows/plan.ts` `flowInputs`).
 *
 * `defaults: false` is the automation form's rule: a required input must carry its own value there,
 * because a Flow changed later is reported rather than filled in from a default.
 */
export function runInputProblems(
  plan: Pick<WakerFlowPlan, "inputs">,
  values: Record<string, string>,
  options: { defaults?: boolean } = {},
): Record<string, string> {
  const fillDefaults = options.defaults ?? true;
  const problems: Record<string, string> = {};
  let total = 0;
  for (const input of plan.inputs) {
    const value = values[input.key] ?? "";
    total += value.length;
    const hasDefault =
      fillDefaults && input.default !== undefined && input.default !== "";
    if (!value.trim()) {
      if (input.required && !hasDefault)
        problems[input.key] = `请填写 ${input.label}。`;
      continue;
    }
    if (value.length > 10000) {
      problems[input.key] = `${input.label} 不能超过 10000 字。`;
      continue;
    }
    const problem = inputValueProblem(input, value);
    if (problem) problems[input.key] = problem;
  }
  if (total > 20000 && plan.inputs[0])
    problems[plan.inputs[0].key] ??= "流程输入合计不能超过 20000 字。";
  return problems;
}

/**
 * The plan as Save sends it. The editor keeps a select's options as the lines being typed, so a new
 * empty line can be started; here they are trimmed and the empty ones dropped, an empty description
 * or default is left out, and options are kept only on a select.
 */
export function planForSave(plan: WakerFlowPlan): WakerFlowPlan {
  return {
    ...plan,
    // WF7: an empty member prompt is no prompt.
    members: plan.members.map(({ prompt, ...member }) =>
      prompt?.trim() ? { ...member, prompt } : member,
    ),
    inputs: plan.inputs.map((input) => {
      const { description, default: fallback, options, ...rest } = input;
      const cleaned: WakerFlowInput = { ...rest };
      if (description?.trim()) cleaned.description = description.trim();
      if (fallback !== undefined && fallback !== "") cleaned.default = fallback;
      if (input.type === "select")
        cleaned.options = (options ?? [])
          .map((option) => option.trim())
          .filter(Boolean);
      return cleaned;
    }),
  };
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
  versions: (id: string) => ["wakerflows", "versions", id] as const,
  confirmations: (id: string, runId: string) =>
    ["wakerflows", "confirmations", id, runId] as const,
};

/** One recorded state change of a run (WF8). The payload never carries a step's output. */
export type WakerFlowRunEvent = {
  sequence: number;
  type: string;
  correlationId: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

/** A question a step stopped on, and what became of it (WF8). */
export type WakerFlowConfirmation = {
  id: string;
  runId: string;
  nodeId: string;
  question: string;
  inputs: Record<string, string>;
  status: "pending" | "answered" | "skipped";
  answer: string | null;
  createdAt: string;
  updatedAt: string;
};

/** A retry of a failed run from its failed step (WF8). */
export type WakerFlowRetry = {
  id: string;
  requestId: string;
  sourceRunId: string;
  newRunId: string;
  nodeId: string;
  status: "prepared" | "ready" | "unknown" | "cancelled";
};

const runAt = (id: string, runId: string) =>
  `${at(id)}/runs/${encodeURIComponent(runId)}`;

/** One page of a run's events, oldest first, after `after`; `next` is null on the last page. */
export async function listWakerFlowRunEvents(
  id: string,
  runId: string,
  page: { after: number; limit: number },
): Promise<{ events: WakerFlowRunEvent[]; next: number | null }> {
  const response = await client(
    `${runAt(id, runId)}/events?after=${page.after}&limit=${page.limit}`,
    { fallback: "运行记录没能加载。" },
  );
  const body = (await response.json().catch(() => null)) as {
    events?: unknown;
    next?: unknown;
  } | null;
  return {
    events: Array.isArray(body?.events)
      ? (body.events as WakerFlowRunEvent[])
      : [],
    next: typeof body?.next === "number" ? body.next : null,
  };
}

export function listWakerFlowConfirmations(id: string, runId: string) {
  return client<WakerFlowConfirmation[]>(
    `${runAt(id, runId)}/confirmations`,
    "confirmations",
    { fallback: "这一步的提问没能加载。" },
  );
}

export function answerWakerFlowConfirmation(
  id: string,
  runId: string,
  confirmationId: string,
  input: { requestId: string; answer: string },
) {
  return client<WakerFlowConfirmation>(
    `${runAt(id, runId)}/confirmations/${encodeURIComponent(confirmationId)}/answer`,
    "confirmation",
    { method: "POST", body: input, fallback: "回答没能提交。" },
  );
}

export function skipWakerFlowConfirmation(
  id: string,
  runId: string,
  confirmationId: string,
  input: { requestId: string },
) {
  return client<WakerFlowConfirmation>(
    `${runAt(id, runId)}/confirmations/${encodeURIComponent(confirmationId)}/skip`,
    "confirmation",
    { method: "POST", body: input, fallback: "没能跳过这一步。" },
  );
}

/** Retry a failed run from the step that failed; the request id makes a repeat safe. */
export function retryWakerFlowRun(
  id: string,
  runId: string,
  input: { requestId: string },
) {
  return client<WakerFlowRetry>(`${runAt(id, runId)}/retry`, "retry", {
    method: "POST",
    body: input,
    fallback: "没能从失败的步骤重试。",
  });
}

/** How the timeline names one event, in the person's words. */
export function runEventLabel(event: WakerFlowRunEvent): string {
  const payload = event.payload;
  const index = typeof payload.index === "number" ? payload.index + 1 : null;
  const stepName = index === null ? "这一步" : `第 ${index} 步`;
  switch (event.type) {
    case "run_started":
      return typeof payload.cursor === "number" && payload.cursor > 0
        ? `从第 ${payload.cursor + 1} 步开始运行`
        : "开始运行";
    case "step_started":
      return `${stepName}开始`;
    case "step_done":
      return `${stepName}完成`;
    case "step_parked":
      return payload.waitingOn === "approval"
        ? `${stepName}等待审批`
        : payload.waitingOn === "child_flow"
          ? `${stepName}等待子流程`
          : `${stepName}等待回答`;
    case "step_answered":
      return `${stepName}已回答`;
    case "step_skipped":
      return payload.skipReason === "branch"
        ? `${stepName}分支未选中`
        : `${stepName}已跳过`;
    case "branch_taken":
      return typeof payload.label === "string"
        ? `${stepName}走「${payload.label}」分支`
        : `${stepName}选定分支`;
    case "step_failed":
      return typeof payload.error === "string" && payload.error
        ? `${stepName}失败：${payload.error}`
        : `${stepName}失败`;
    case "run_done":
      return "运行完成";
    case "run_failed":
      return "运行失败";
    case "run_aborted":
      return "运行已停止";
    case "run_retried":
      return typeof payload.index === "number"
        ? `已从第 ${payload.index + 1} 步重试`
        : "已重试";
    default:
      return event.type;
  }
}

/** One saved version of a Flow, as `GET /api/wakerflows/:id/versions` lists it (WF8). */
export type WakerFlowVersionSummary = {
  /** The Flow's revision after that Save: what the page calls 第 N 版. */
  revision: number;
  name: string;
  stepCount: number;
  modelRef: string | null;
  templateId: string | null;
  createdBy: string | null;
  createdAt: string;
};

export function listWakerFlowVersions(id: string) {
  return client<WakerFlowVersionSummary[]>(`${at(id)}/versions`, "versions", {
    fallback: "版本记录没能加载。",
  });
}

/**
 * Roll back to a saved version: the server saves that version's plan again as a new revision. A
 * 409 means the page was not looking at the newest revision; the caller offers to refresh.
 */
export function restoreWakerFlowVersion(
  id: string,
  revision: number,
  input: { revision: number },
) {
  return client<WakerFlow>(
    `${at(id)}/versions/${encodeURIComponent(String(revision))}/restore`,
    "flow",
    { method: "POST", body: input, fallback: "没能恢复这个版本。" },
  );
}

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
    if ((input.description ?? "").trim().length > 200)
      fail(`inputs.${index}.description`, "输入说明不能超过 200 字。");
    const shown = input.label.trim() || input.key;
    if (input.type === "select") {
      const options = input.options ?? [];
      if (options.length === 0)
        fail(
          `inputs.${index}.options`,
          `下拉输入「${shown}」至少需要一个选项。`,
        );
      else if (options.length > 20)
        fail(`inputs.${index}.options`, `下拉输入「${shown}」最多 20 个选项。`);
      else if (options.some((option) => option.length > 80))
        fail(`inputs.${index}.options`, "每个下拉选项不能超过 80 字。");
      else if (new Set(options).size !== options.length)
        fail(`inputs.${index}.options`, `下拉输入「${shown}」的选项重复。`);
    }
    if (input.default !== undefined && input.default.trim() !== "") {
      const problem = inputValueProblem(
        { ...input, label: shown },
        input.default,
      );
      if (problem)
        fail(`inputs.${index}.default`, `「${shown}」的默认值无效：${problem}`);
    }
  });

  if (plan.steps.length === 0) fail("steps", "计划里至少要有一个步骤。");
  if (plan.steps.length > WAKERFLOW_MAX_STEPS)
    fail("steps", `计划里最多 ${WAKERFLOW_MAX_STEPS} 个步骤。`);
  const steps = new Set<string>();
  plan.steps.forEach((step, index) => {
    if (!PLAN_KEY_PATTERN.test(step.id))
      fail(`steps.${index}.id`, "步骤编号无效。");
    else if (steps.has(step.id)) fail(`steps.${index}.id`, "步骤编号重复。");
    steps.add(step.id);
    const agent = stepAgentId(step);
    if (agent !== undefined && !members.has(agent))
      fail(`steps.${index}.agentId`, "步骤只能交给计划中的员工。");
    if (step.kind === undefined || step.kind === "worker") {
      const instruction = step.instruction.trim();
      if (!instruction)
        fail(`steps.${index}.instruction`, "请写明这一步要做什么。");
      else if (instruction.length > 8000)
        fail(`steps.${index}.instruction`, "步骤说明不能超过 8000 字。");
    }
    if (step.kind === "decision") {
      if (step.branches.length === 0)
        fail(`steps.${index}.branches`, "判断至少需要一个分支。");
      if (step.branches.length > WAKERFLOW_MAX_BRANCHES)
        fail(
          `steps.${index}.branches`,
          `一个判断最多 ${WAKERFLOW_MAX_BRANCHES} 个分支。`,
        );
      const labels = new Set<string>();
      step.branches.forEach((branch, at) => {
        const label = branch.label.trim();
        if (!label)
          fail(`steps.${index}.branches.${at}.label`, "请填写分支名称。");
        else if (label.length > 40)
          fail(
            `steps.${index}.branches.${at}.label`,
            "分支名称不能超过 40 字。",
          );
        else if (labels.has(label))
          fail(
            `steps.${index}.branches.${at}.label`,
            "同一个判断里的分支名称不能重复。",
          );
        labels.add(label);
        const when = branch.when.trim();
        if (!when)
          fail(`steps.${index}.branches.${at}.when`, "请填写分支条件。");
        else if (when.length > 500)
          fail(
            `steps.${index}.branches.${at}.when`,
            "分支条件不能超过 500 字。",
          );
      });
    }
    if (step.kind === "flow" && !step.targetFlowId)
      fail(`steps.${index}.targetFlowId`, "请选择要嵌套的子流程。");
    if (step.kind === "action") {
      if (!/^[^/\s]+\/\S+$/.test(step.tool))
        fail(`steps.${index}.tool`, "请填写要调用的工具（服务/工具名）。");
      for (const [name, value] of Object.entries(step.args)) {
        if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name))
          fail(`steps.${index}.args`, "参数名称无效。");
        if (value.length > 10000)
          fail(`steps.${index}.args`, "单个参数不能超过 10000 字。");
      }
    }
    const reads = stepReads(step);
    if (reads.length > 30)
      fail(`steps.${index}.inputKeys`, "一个步骤最多读取 30 项输入。");
    if (step.kind !== "flow" && new Set(reads).size !== reads.length)
      fail(`steps.${index}.inputKeys`, "步骤输入名称重复。");
    const produced = stepOutputKey(step);
    if (produced !== undefined) {
      if (!PLAN_KEY_PATTERN.test(produced))
        fail(`steps.${index}.outputKey`, KEY_MESSAGE);
      else if (available.has(produced))
        fail(`steps.${index}.outputKey`, "步骤输出不能覆盖已有输入或输出。");
      available.add(produced);
    }
  });
  routeProblems(plan, fail);
  return problems;
}

/**
 * The route checks of P-A, the server's own (`server/src/wakerflows/plan.ts`): every jump goes to a
 * later step or the end, every step is reachable, and a step reads only what every path to it
 * produced. The steps are in topological order (every edge points forward), so one pass suffices.
 */
function routeProblems(
  plan: WakerFlowPlan,
  fail: (path: string, message: string) => void,
) {
  const count = plan.steps.length;
  const position = new Map(plan.steps.map((step, index) => [step.id, index]));
  const inputs = plan.inputs.map((input) => input.key);
  const must: (Set<string> | null)[] = plan.steps.map(() => null);
  const may: Set<string>[] = plan.steps.map(() => new Set());
  if (count > 0) {
    must[0] = new Set(inputs);
    may[0] = new Set(inputs);
  }
  plan.steps.forEach((step, index) => {
    const paths =
      step.kind === "decision"
        ? [
            ...step.branches.map(
              (_, at) => `steps.${index}.branches.${at}.next`,
            ),
            `steps.${index}.otherwise`,
          ]
        : [`steps.${index}.next`];
    const successors: number[] = [];
    stepTargets(step).forEach((jump, at) => {
      const path = paths[at] ?? `steps.${index}.next`;
      if (jump === undefined) successors.push(index + 1);
      else if (jump === WAKERFLOW_END) successors.push(count);
      else {
        const to = position.get(jump);
        if (to === undefined) fail(path, `跳转目标 ${jump} 不存在。`);
        else if (to <= index)
          fail(path, `只能跳到后面的步骤；${jump} 不在这一步之后。`);
        else successors.push(to);
      }
    });
    const certain = must[index];
    if (!certain) {
      fail(`steps.${index}`, `没有任何路径会走到步骤 ${step.id}。`);
      return;
    }
    const field = step.kind === "flow" ? "inputMap" : "inputKeys";
    for (const read of stepReads(step)) {
      if (certain.has(read)) continue;
      fail(
        `steps.${index}.${field}`,
        may[index]?.has(read)
          ? `输入 ${read} 只在部分分支中产生；走到这一步的其他路径上没有它。`
          : `输入 ${read} 尚未产生；只能读取流程输入或前面步骤的输出。`,
      );
    }
    const produced = stepOutputKey(step);
    for (const next of successors) {
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

/**
 * Where the step at `index` may jump (P-A, D8): only the steps after it, and the end. The editor
 * offers exactly these, so a backward jump cannot be chosen at all.
 */
export function jumpChoices(
  steps: WakerFlowStep[],
  index: number,
): { value: string; label: string }[] {
  return [
    ...steps.slice(index + 1).map((step, offset) => ({
      value: step.id,
      label: `第 ${index + offset + 2} 步（${step.id}）`,
    })),
    { value: WAKERFLOW_END, label: "结束流程" },
  ];
}

/** A fresh step of `kind`, keeping the id (and the coworker, where the kind has one). */
export function stepOfKind(
  kind: WakerFlowStepKind,
  id: string,
  agentId: string,
  nextId: string | undefined,
): WakerFlowStep {
  switch (kind) {
    case "decision":
      return {
        id,
        kind: "decision",
        inputKeys: [],
        branches: [
          { label: "是", when: "true", next: nextId ?? WAKERFLOW_END },
        ],
        otherwise: nextId ?? WAKERFLOW_END,
      };
    case "flow":
      return {
        id,
        kind: "flow",
        targetFlowId: "",
        targetRevision: 1,
        inputMap: {},
        outputKey: "",
      };
    case "action":
      return {
        id,
        kind: "action",
        agentId,
        tool: "",
        args: {},
        inputKeys: [],
        outputKey: "",
      };
    default:
      return { id, agentId, instruction: "", inputKeys: [], outputKey: "" };
  }
}

/** The kind of a step as the editor names it. */
export function stepKindLabel(step: { kind?: string }): string {
  return STEP_KIND_LABEL[stepKind(step)];
}
