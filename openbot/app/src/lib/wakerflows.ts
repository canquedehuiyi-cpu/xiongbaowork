import { queryOptions } from "@tanstack/react-query";
import { client, RequestError } from "@/lib/client";
import type {
  FlowModelChoice,
  WakerFlowBranch,
  WakerFlowCandidate,
  WakerFlowInput,
  WakerFlowInputType,
  WakerFlowRequestStatus,
  WakerFlowSaveInput,
  WakerFlowStepKind,
  WakerFlow as StoredWakerFlow,
  WakerFlowGenerationResult as StoredWakerFlowGenerationResult,
  WakerFlowPlan as StoredWakerFlowPlan,
  WakerFlowWorkerStep,
} from "../../../shared/wakerflows";

export type {
  FlowModelChoice,
  WakerFlowCandidate,
  WakerFlowInput,
  WakerFlowInputType,
  WakerFlowRequestStatus,
  WakerFlowSaveInput,
};

/**
 * The plan as these screens edit and show it: coworker steps only.
 *
 * WF7 adds decisions, nested Flows and tool calls to the stored plan (`shared/wakerflows.ts`), and the
 * server refuses every kind it cannot run yet on Save, so until the flowchart editor lands a saved
 * plan holds worker steps only and this is what it is.
 */
export type WakerFlowPlan = Omit<StoredWakerFlowPlan, "steps"> & {
  steps: WakerFlowWorkerStep[];
};
export type WakerFlow = Omit<StoredWakerFlow, "plan"> & {
  plan: WakerFlowPlan | null;
};
export type WakerFlowGenerationResult = Omit<
  StoredWakerFlowGenerationResult,
  "plan"
> & { plan: WakerFlowPlan };
export {
  WAKERFLOW_CONFLICT_MESSAGE,
  WAKERFLOW_INPUT_TYPES,
  WAKERFLOW_SUGGESTIONS,
} from "../../../shared/wakerflows";

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
  agentId: string;
  instruction: string;
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
  sessions: (id: string) => ["wakerflows", "sessions", id] as const,
  turns: (id: string, sessionId: string) =>
    ["wakerflows", "sessions", id, sessionId, "turns"] as const,
  shares: (id: string) => ["wakerflows", "shares", id] as const,
  sharePreview: (token: string) =>
    ["wakerflows", "share-preview", token] as const,
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
        : `${stepName}等待回答`;
    case "step_answered":
      return `${stepName}已回答`;
    case "step_skipped":
      return `${stepName}已跳过`;
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

/** WF9: one customization session of a Flow, as the history list shows it. */
export type WakerFlowSession = {
  id: string;
  requestId: string;
  title: string;
  description: string;
  revision: number;
  turnCount: number;
  /** Whether the Flow's page opens on this session. */
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

/** WF9: one change request of a session, with the candidate plan it produced. */
export type WakerFlowSessionTurn = {
  id: string;
  requestId: string;
  prompt: string;
  modelRef: string;
  status: WakerFlowRequestStatus;
  error: string | null;
  plan: WakerFlowPlan | null;
  /** Written into the draft when it arrived, or the Flow's plan is this candidate now. */
  applied: boolean;
  createdAt: string;
};

const sessionAt = (id: string, sessionId: string) =>
  `${at(id)}/sessions/${encodeURIComponent(sessionId)}`;

export async function listWakerFlowSessions(
  id: string,
): Promise<{ sessions: WakerFlowSession[]; activeSessionId: string | null }> {
  const response = await client(`${at(id)}/sessions`, {
    fallback: "修改会话没能加载。",
  });
  const body = (await response.json().catch(() => null)) as {
    sessions?: WakerFlowSession[];
    activeSessionId?: string | null;
  } | null;
  return {
    sessions: Array.isArray(body?.sessions) ? body.sessions : [],
    activeSessionId: body?.activeSessionId ?? null,
  };
}

/** A new session becomes the one the page opens on. The request id makes a repeat safe. */
export function createWakerFlowSession(
  id: string,
  input: { requestId: string; title?: string },
) {
  return client<WakerFlowSession>(`${at(id)}/sessions`, "session", {
    method: "POST",
    body: input,
    fallback: "没能新建修改会话。",
  });
}

export function activateWakerFlowSession(id: string, sessionId: string) {
  return client<WakerFlowSession>(
    `${sessionAt(id, sessionId)}/activate`,
    "session",
    { method: "POST", fallback: "没能切换到这个会话。" },
  );
}

export function deleteWakerFlowSession(
  id: string,
  sessionId: string,
  revision: number,
) {
  return client<boolean>(
    `${sessionAt(id, sessionId)}?revision=${revision}`,
    "deleted",
    { method: "DELETE", fallback: "没能删除这个会话。" },
  );
}

export function listWakerFlowSessionTurns(id: string, sessionId: string) {
  return client<WakerFlowSessionTurn[]>(
    `${sessionAt(id, sessionId)}/turns`,
    "turns",
    { fallback: "修改记录没能加载。" },
  );
}

/**
 * One change request. It answers when the model does; Cancel is the planning cancel
 * ({@link cancelWakerFlowGeneration}) with the same request id. Without `members` the server offers
 * the current plan's own coworkers.
 */
export function sendWakerFlowSessionTurn(
  id: string,
  sessionId: string,
  input: { requestId: string; modelRef: string; prompt: string },
) {
  return client<WakerFlowRequest>(
    `${sessionAt(id, sessionId)}/turns`,
    "request",
    {
      method: "POST",
      body: input,
      fallback: "这次修改没能生成，请重试。",
    },
  );
}

/**
 * What a candidate plan changes against the current one, one sentence each, for the session panel.
 * Steps are matched by their name (`id`); an empty list means the two plans do the same thing.
 */
export function planDifferences(
  current: WakerFlowPlan | null,
  candidate: WakerFlowPlan,
): string[] {
  if (!current) return ["当前还没有计划，应用后会使用这份候选计划。"];
  const out: string[] = [];
  if (current.name !== candidate.name)
    out.push(`名称：「${current.name}」改为「${candidate.name}」`);
  const roleOf = (plan: WakerFlowPlan, agentId: string) =>
    plan.members.find((member) => member.agentId === agentId)?.role ?? agentId;
  for (const member of candidate.members) {
    const before = current.members.find((m) => m.agentId === member.agentId);
    if (!before) out.push(`新增员工：${member.role}`);
    else if (before.role !== member.role)
      out.push(`员工职责：「${before.role}」改为「${member.role}」`);
  }
  for (const member of current.members)
    if (!candidate.members.some((m) => m.agentId === member.agentId))
      out.push(`移除员工：${member.role}`);
  for (const input of candidate.inputs)
    if (!current.inputs.some((i) => i.key === input.key))
      out.push(`新增输入：${input.label}（${input.key}）`);
  for (const input of current.inputs)
    if (!candidate.inputs.some((i) => i.key === input.key))
      out.push(`移除输入：${input.label}（${input.key}）`);
  for (const [index, step] of candidate.steps.entries()) {
    const before = current.steps.find((s) => s.id === step.id);
    if (!before) {
      out.push(`新增第 ${index + 1} 步「${step.id}」：${step.instruction}`);
      continue;
    }
    if (before.instruction !== step.instruction)
      out.push(`修改步骤「${step.id}」：${step.instruction}`);
    if (before.agentId !== step.agentId)
      out.push(
        `步骤「${step.id}」改由「${roleOf(candidate, step.agentId)}」执行`,
      );
  }
  for (const step of current.steps)
    if (!candidate.steps.some((s) => s.id === step.id))
      out.push(`删除步骤「${step.id}」`);
  const kept = (plan: WakerFlowPlan, other: WakerFlowPlan) =>
    plan.steps
      .map((step) => step.id)
      .filter((id) => other.steps.some((step) => step.id === id));
  const before = kept(current, candidate);
  const after = kept(candidate, current);
  if (before.join("\u0000") !== after.join("\u0000"))
    out.push(`步骤顺序：${before.join(" → ")} 改为 ${after.join(" → ")}`);
  return out;
}

/** WF9: where a share link stands, as its owner's list shows it. */
export type WakerFlowShareStatus =
  | "active"
  | "expired"
  | "revoked"
  | "exhausted";

export const SHARE_STATUS_LABEL: Record<WakerFlowShareStatus, string> = {
  active: "可用",
  expired: "已过期",
  revoked: "已撤销",
  exhausted: "次数已用完",
};

/** WF9: one share link of a Flow. Its token is never part of it. */
export type WakerFlowShare = {
  id: string;
  flowId: string;
  status: WakerFlowShareStatus;
  expiresAt: string;
  maxUses: number;
  uses: number;
  remainingUses: number;
  revokedAt: string | null;
  createdAt: string;
};

/** WF9: what a link holds, as the import page shows it before anything is imported. */
export type WakerFlowSharePreview = {
  name: string;
  description: string;
  slots: { slot: string; role: string; prompt?: string }[];
  inputCount: number;
  stepCount: number;
  expiresAt: string;
  remainingUses: number;
};

/** D4/D5: what a new link offers, and how far each may go. */
export const SHARE_DEFAULT_DAYS = 7;
export const SHARE_MAX_DAYS = 30;
export const SHARE_DEFAULT_USES = 10;
export const SHARE_MAX_USES = 100;

/** The page a share link opens, in this app. */
export const shareImportPath = (token: string) =>
  `/wakerflows/import/${encodeURIComponent(token)}`;

export function listWakerFlowShares(id: string) {
  return client<WakerFlowShare[]>(`${at(id)}/shares`, "shares", {
    fallback: "分享链接没能加载。",
  });
}

/**
 * Make a link. The token is in this answer only: the server keeps its hash, so a repeat of the
 * same id answers with `token: null`.
 */
export async function createWakerFlowShare(
  id: string,
  input: { id: string; expiresInDays: number; maxUses: number },
): Promise<{ share: WakerFlowShare; token: string | null }> {
  const response = await client(`${at(id)}/shares`, {
    method: "POST",
    body: input,
    fallback: "没能创建分享链接。",
  });
  const body = (await response.json().catch(() => null)) as {
    share?: WakerFlowShare;
    token?: string | null;
  } | null;
  if (!body?.share) throw new Error("没能创建分享链接。");
  return { share: body.share, token: body.token ?? null };
}

export function revokeWakerFlowShare(id: string, shareId: string) {
  return client<WakerFlowShare>(
    `${at(id)}/shares/${encodeURIComponent(shareId)}/revoke`,
    "share",
    { method: "POST", fallback: "没能撤销这个分享链接。" },
  );
}

const shareAt = (token: string) =>
  `/api/wakerflow-shares/${encodeURIComponent(token)}`;

export function getWakerFlowSharePreview(token: string) {
  return client<WakerFlowSharePreview>(shareAt(token), "share", {
    fallback: "这个分享链接没能打开。",
  });
}

/** Import as a draft of the person's own; a repeat of the request id answers with the same draft. */
export function importWakerFlowShare(
  token: string,
  input: { requestId: string; members: Record<string, string> },
) {
  return client<{ flowId: string; name: string }>(
    `${shareAt(token)}/import`,
    "imported",
    { method: "POST", body: input, fallback: "没能导入这个 WakerFlow。" },
  );
}

/*
 * D9: a share link needs a signed-in person. Somebody who opens one signed out is sent to sign in,
 * and comes back to the link afterwards: the token is held for this tab only (sessionStorage, which
 * survives a provider's redirect and back) and taken once. Only a token of the link's own shape is
 * ever held, so nothing else can be sent back to.
 */
const RETURN_KEY = "openbot.wakerflow-share-return";
const SHARE_PATH = /^\/wakerflows\/import\/([A-Za-z0-9_-]{43})$/;

export function rememberShareImport(pathname: string) {
  const token = SHARE_PATH.exec(pathname)?.[1];
  if (!token) return;
  try {
    sessionStorage.setItem(RETURN_KEY, token);
  } catch {
    // Storage may be unavailable (a private window); the person opens the link again instead.
  }
}

export function takeShareImport(): string | null {
  try {
    const token = sessionStorage.getItem(RETURN_KEY);
    sessionStorage.removeItem(RETURN_KEY);
    return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
  } catch {
    return null;
  }
}
