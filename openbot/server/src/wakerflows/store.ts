import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  WAKERFLOW_CONFLICT_MESSAGE,
  WAKERFLOW_PLAN_FORMAT_MESSAGE,
  WAKERFLOW_SUGGESTIONS,
  type WakerFlow,
  type WakerFlowCandidate,
  type WakerFlowGenerationResult,
  type WakerFlowPlan,
  type WakerFlowRequestStatus,
  type WakerFlowSaveInput,
} from "../../../shared/wakerflows";
import type { Database } from "../db/client";
import {
  flowConfirmations,
  flowRunEvents,
  flowRunRetries,
  groupTaskRuns,
  groupTaskTemplates,
  wakerFlowRequests,
  wakerFlows,
  wakerFlowVersions,
  wakerGroupMembers,
  wakerGroups,
} from "../db/schema";
import {
  type PipelineEventWriter,
  PipelineNotFoundError,
  type PipelineRunTransition,
  PipelineStepForbiddenError,
  type PipelineStore,
  PipelineValidationError,
  type StepRecord,
} from "../pipeline/store";
import { stepBudget } from "../pipeline/decision";
import { QuotaExceeded, type QuotaService } from "../quota/limits";
import type { TaskProjector } from "../tasks/projector";
import { runAsTenant } from "../tenant/context";
import {
  FlowGenerationCancelledError,
  FlowGenerationRefusedError,
  type FlowGenerator,
  FlowPlanFormatError,
} from "./generator";
import type { FlowModelResolver } from "./model";
import { compiledSteps, flowInputs, wakerFlowPlanSchema } from "./plan";

/**
 * The WakerFlow store (spec D10, stories WF1/WF3/WF4).
 *
 * A Flow is an editable plan, and Save is what turns it into something the pipeline can run: a hidden
 * crew holding exactly the plan's members, and a NEW template whose steps are exactly the plan's steps.
 * A new template per Save rather than an edit of the old one, because a run snapshots the template it
 * started from and the person reviewing an old run must see the plan that run was given.
 *
 * Only `json-plan-v1` rows are this store's business. The JS-source mode and every `flow_source_*`
 * table belong to the activation contract (FLOW-ACTIVATION-CONTRACT.md), which this file neither reads
 * nor writes: a row in that mode is simply not here.
 *
 * The tenant is always the caller's own, passed in from the authenticated actor and entered with
 * `runAsTenant`; nothing in a request body can name one.
 */

const DEFINITION_MODE = "json-plan-v1";

/** Every refusal carries the HTTP answer it means, so the routes do not re-derive it from wording. */
export class WakerFlowError extends Error {
  readonly status: 400 | 404 | 409 | 501;
  constructor(status: 400 | 404 | 409 | 501, message: string) {
    super(message);
    this.name = "WakerFlowError";
    this.status = status;
  }
}

/** Another workspace's Flow, a deleted one, and a missing one all read the same. */
export class WakerFlowNotFoundError extends WakerFlowError {
  constructor() {
    super(404, "这个工作区里没有这个 WakerFlow。");
    this.name = "WakerFlowNotFoundError";
  }
}

export class WakerFlowValidationError extends WakerFlowError {
  constructor(message: string) {
    super(400, message);
    this.name = "WakerFlowValidationError";
  }
}

/** Save lost the revision race: the editor reloads rather than overwriting someone else's edit. */
export class WakerFlowConflictError extends WakerFlowError {
  constructor() {
    super(409, WAKERFLOW_CONFLICT_MESSAGE);
    this.name = "WakerFlowConflictError";
  }
}

/** A Flow with planning or a run in flight cannot be deleted out from under it. */
export class WakerFlowBusyError extends WakerFlowError {
  constructor() {
    super(409, "这个 WakerFlow 仍有进行中的规划或运行，结束后才能删除。");
    this.name = "WakerFlowBusyError";
  }
}

/** A run that is not this Flow's, or not this workspace's, reads the same as one that never existed. */
export class WakerFlowRunNotFoundError extends WakerFlowError {
  constructor() {
    super(404, "这里没有这次运行。");
    this.name = "WakerFlowRunNotFoundError";
  }
}

/** A run is started from the plan the person was looking at; a newer or unsaved plan is refused. */
export class WakerFlowNotRunnableError extends WakerFlowError {
  constructor(message: string) {
    super(409, message);
    this.name = "WakerFlowNotRunnableError";
  }
}

/** A capability whose wiring this deployment does not have (no planning model configured). */
export class WakerFlowUnavailableError extends WakerFlowError {
  constructor() {
    super(501, "这个 WakerFlow 功能尚未开放。");
    this.name = "WakerFlowUnavailableError";
  }
}

export type WakerFlowCreateInput = {
  idea: string;
  name?: string;
  description?: string;
  modelRef?: string | null;
};

/**
 * One planning request. `members` are the coworkers the person offers the model (their own usable
 * coworkers); `scenario` is one of {@link WAKERFLOW_SUGGESTIONS} when the person started from one.
 */
export type WakerFlowGenerateInput = {
  requestId: string;
  modelRef: string;
  idea: string;
  members: WakerFlowCandidate[];
  scenario?: string;
};

export type WakerFlowStartInput = {
  requestId: string;
  revision: number;
  inputs: Record<string, string>;
};

export type WakerFlowRequestOutcome = {
  id: string;
  requestId: string;
  flowId: string;
  kind: string;
  status: WakerFlowRequestStatus;
  runId: string | null;
  taskId: string | null;
  /** Always this product's own words; a provider's error text is never stored or shown. */
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

/** One saved version of a Flow, as the version list shows it: no plan, only what tells them apart. */
export type WakerFlowVersionSummary = {
  revision: number;
  name: string;
  stepCount: number;
  modelRef: string | null;
  templateId: string | null;
  createdBy: string | null;
  createdAt: string;
};

/** One saved version with the whole plan it was saved with. */
export type WakerFlowVersion = WakerFlowVersionSummary & {
  plan: WakerFlowPlan;
};

/** A revision this Flow never had, or one of a Flow this workspace cannot see. */
export class WakerFlowVersionNotFoundError extends WakerFlowError {
  constructor() {
    super(404, "这个 WakerFlow 没有这个版本。");
    this.name = "WakerFlowVersionNotFoundError";
  }
}

/** One recorded state change of a run (WF8, spec §3.4). The payload never holds a step's output (D10). */
export type WakerFlowRunEvent = {
  sequence: number;
  type: string;
  correlationId: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

/** A step that stopped on a question, and what became of it (WF8, spec §3.3). */
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

/** A question this run never asked, or one of a run this workspace cannot see. */
export class WakerFlowConfirmationNotFoundError extends WakerFlowError {
  constructor() {
    super(404, "这里没有这个提问。");
    this.name = "WakerFlowConfirmationNotFoundError";
  }
}

/** The question was already answered or skipped, by this request with other content or by another. */
export class WakerFlowConfirmationSettledError extends WakerFlowError {
  constructor() {
    super(409, "这个提问已经处理过了，请刷新后查看。");
    this.name = "WakerFlowConfirmationSettledError";
  }
}

const MAX_ANSWER = 10000;
const MAX_EVENT_PAGE = 100;
/** What a step parked without a question of its own is shown as. */
const DEFAULT_QUESTION = "这一步在等你的回答。";

/** A failure's reason as an event keeps it: the first line, bounded, never the step's output. */
function errorSummary(error: string | undefined): string | undefined {
  if (!error) return undefined;
  const line = Array.from(error.split("\n")[0] ?? "");
  return line.length > 200 ? `${line.slice(0, 199).join("")}…` : line.join("");
}

/** What a step read when it stopped: its declared inputs, from the run's inputs or earlier outputs. */
function stepInputs(
  steps: StepRecord[],
  index: number,
  inputs: Record<string, string>,
): Record<string, string> {
  const step = steps[index];
  if (!step?.inputKeys) return {};
  return Object.fromEntries(
    step.inputKeys.map((key) => [
      key,
      inputs[key] ??
        steps.slice(0, index).find((earlier) => earlier.outputKey === key)
          ?.output ??
        "（此输入未产生）",
    ]),
  );
}

const STEP_EVENT: Partial<Record<StepRecord["state"], string>> = {
  running: "step_started",
  done: "step_done",
  awaiting_action: "step_parked",
  skipped: "step_skipped",
  failed: "step_failed",
};
const RUN_EVENT: Record<string, string> = {
  done: "run_done",
  failed: "run_failed",
  aborted: "run_aborted",
};

/**
 * The events one run transition means, in order: each step whose state moved, then the run's own end.
 *
 * `correlation_id` is unique per run (0088's index): the step's card reference (the run id for the
 * run's own events), then the event type and the run revision the change produced, so a step that
 * starts and finishes, or parks twice, is two distinct facts, and the same change is never recorded
 * twice. The payload is the state, an error's summary and lengths, never a step's output (D10).
 */
export function flowRunEventsOf(transition: PipelineRunTransition): {
  type: string;
  correlationId: string;
  payload: Record<string, unknown>;
}[] {
  const { runId, revision, before, after } = transition;
  if (!before)
    return [
      {
        type: "run_started",
        correlationId: `${runId}:run_started:${revision}`,
        payload: {
          status: after.status,
          stepCount: after.steps.length,
          // Where it starts: 0, or the failed step a retry starts from.
          cursor: after.cursor,
        },
      },
    ];
  const out: ReturnType<typeof flowRunEventsOf> = [];
  after.steps.forEach((step, index) => {
    const from = before.steps[index]?.state;
    if (from === step.state) return;
    let type = STEP_EVENT[step.state];
    if (!type) return;
    // A parked step that is now done was answered: by the person, or by the approval it waited on.
    if (type === "step_done" && from === "awaiting_action")
      type = "step_answered";
    const payload: Record<string, unknown> = {
      stepId: step.id,
      index,
      state: step.state,
      from: from ?? null,
    };
    if (step.state === "done" && step.kind !== "decision")
      payload.outputLength = (step.output ?? "").length;
    if (step.state === "skipped" && step.skipReason)
      payload.skipReason = step.skipReason;
    if (step.state === "failed") payload.error = errorSummary(step.error);
    if (step.state === "awaiting_action") {
      payload.waitingOn = step.approvalId ? "approval" : "question";
      if (step.approvalId) payload.approvalId = step.approvalId;
    }
    out.push({
      type,
      correlationId: `${step.runRef ?? `${runId}/${step.id}`}:${type}:${revision}`,
      payload,
    });
    // WF7 (spec §3.3): which branch a decision took — its label and the branch's position (-1 is
    // `otherwise`). Never the values it read.
    if (step.kind === "decision" && step.state === "done" && step.branch)
      out.push({
        type: "branch_taken",
        correlationId: `${runId}/${step.id}:branch_taken:${revision}`,
        payload: {
          stepId: step.id,
          index,
          label: step.branch.label,
          branch: step.branch.index,
        },
      });
  });
  const ended = RUN_EVENT[after.status];
  if (ended && before.status !== after.status)
    out.push({
      type: ended,
      correlationId: `${runId}:${ended}:${revision}`,
      payload: { status: after.status, cursor: after.cursor },
    });
  return out;
}

/**
 * WF8: the pipeline's event writer for WakerFlow runs (spec §3.4 E-A and §3.3).
 *
 * Inside the transaction of the change it records: every event the change means goes into
 * `flow_run_events`, and a step that stopped on a question (parked with no approval row, and with the
 * question its step runner reported) becomes one `pending` row of `flow_confirmations` with the
 * question and the inputs it was reading. A park on an approval writes no confirmation: the approval
 * inbox is the one place to answer it (D5).
 */
export const flowRunEventWriter: PipelineEventWriter = async (
  tx,
  transition,
) => {
  const events = flowRunEventsOf(transition);
  if (events.length === 0) return;
  await tx.insert(flowRunEvents).values(
    events.map((event) => ({
      tenantId: transition.tenantId,
      flowId: transition.flowId,
      runId: transition.runId,
      correlationId: event.correlationId,
      type: event.type,
      payload: event.payload,
    })),
  );
  // Only a park that says it is a question: a step waiting on a device or a sign-in is not one, and
  // an answer typed for it would stand in for work that never happened.
  const asks = transition.after.steps.flatMap((step, index) =>
    step.state === "awaiting_action" &&
    !step.approvalId &&
    step.question &&
    transition.before?.steps[index]?.state !== "awaiting_action"
      ? [{ step, index }]
      : [],
  );
  if (asks.length === 0) return;
  await tx.insert(flowConfirmations).values(
    asks.map(({ step, index }) => ({
      id: randomUUID(),
      tenantId: transition.tenantId,
      flowId: transition.flowId,
      runId: transition.runId,
      nodeId: step.id,
      question: { text: step.question ?? DEFAULT_QUESTION },
      inputs: stepInputs(transition.after.steps, index, transition.inputs),
    })),
  );
};

const confirmationColumns = {
  id: flowConfirmations.id,
  runId: flowConfirmations.runId,
  nodeId: flowConfirmations.nodeId,
  question: flowConfirmations.question,
  inputs: flowConfirmations.inputs,
  status: flowConfirmations.status,
  answer: flowConfirmations.answer,
  requestId: flowConfirmations.requestId,
  createdAt: flowConfirmations.createdAt,
  updatedAt: flowConfirmations.updatedAt,
};

type ConfirmationRow = {
  id: string;
  runId: string;
  nodeId: string;
  question: unknown;
  inputs: unknown;
  status: string;
  answer: string | null;
  requestId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function confirmation(row: ConfirmationRow): WakerFlowConfirmation {
  const question = row.question as { text?: unknown } | null;
  return {
    id: row.id,
    runId: row.runId,
    nodeId: row.nodeId,
    question:
      typeof question?.text === "string" ? question.text : DEFAULT_QUESTION,
    inputs: (row.inputs ?? {}) as Record<string, string>,
    status: (["pending", "answered", "skipped"].includes(row.status)
      ? row.status
      : "pending") as WakerFlowConfirmation["status"],
    answer: row.answer,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** A retry of a failed run from its failed step, as the retry ledger records it (WF8, spec §3.5). */
export type WakerFlowRetry = {
  id: string;
  requestId: string;
  sourceRunId: string;
  newRunId: string;
  /** The step the new run starts at: the one that failed. */
  nodeId: string;
  /** `prepared` until the new run is driven, then `ready`; `unknown` when a restart came between. */
  status: "prepared" | "ready" | "unknown" | "cancelled";
};

/** The request kind the retry ledger's fingerprints are made with. */
export const RETRY = "retry";
const RETRY_NOT_FAILED_MESSAGE = "只有失败的运行可以从失败的步骤重试。";
const RETRY_TAKEN_MESSAGE = "这次运行已经重试过了，请查看重试产生的运行。";
const RETRY_DEFINITION_GONE_MESSAGE =
  "这次运行使用的流程定义已不存在，无法从失败的步骤重试，请重新运行。";

function retryOutcome(row: {
  id: string;
  requestId: string;
  sourceRunId: string;
  newRunId: string;
  nodeId: string;
  status: string;
}): WakerFlowRetry {
  return {
    id: row.id,
    requestId: row.requestId,
    sourceRunId: row.sourceRunId,
    newRunId: row.newRunId,
    nodeId: row.nodeId,
    status: (["prepared", "ready", "unknown", "cancelled"].includes(row.status)
      ? row.status
      : "unknown") as WakerFlowRetry["status"],
  };
}

const retryColumns = {
  id: flowRunRetries.id,
  requestId: flowRunRetries.requestId,
  sourceRunId: flowRunRetries.sourceRunId,
  newRunId: flowRunRetries.newRunId,
  nodeId: flowRunRetries.nodeId,
  status: flowRunRetries.status,
  fingerprint: flowRunRetries.fingerprint,
};

function uniqueViolation(error: unknown): boolean {
  for (let at: unknown = error; at; at = (at as { cause?: unknown }).cause) {
    const state = at as { errno?: unknown; code?: unknown };
    if (String(state.errno) === "23505" || String(state.code) === "23505")
      return true;
  }
  return false;
}

export type WakerFlowStore = ReturnType<typeof createWakerFlowStore>;

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

const columns = {
  id: wakerFlows.id,
  name: wakerFlows.name,
  description: wakerFlows.description,
  idea: wakerFlows.idea,
  modelRef: wakerFlows.modelRef,
  plan: wakerFlows.plan,
  revision: wakerFlows.revision,
  groupId: wakerFlows.groupId,
  templateId: wakerFlows.templateId,
  createdAt: wakerFlows.createdAt,
  updatedAt: wakerFlows.updatedAt,
};

type FlowRow = {
  id: string;
  name: string;
  description: string;
  idea: string;
  modelRef: string | null;
  plan: WakerFlowPlan | null;
  revision: number;
  groupId: string | null;
  templateId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * `waker_flows` has no status column on purpose: "ready" is a fact about the row, not a flag that can
 * disagree with it. A Flow is runnable exactly when Save has compiled it.
 */
function shape(row: FlowRow): WakerFlow {
  const ready =
    row.plan !== null && row.groupId !== null && row.templateId !== null;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    idea: row.idea,
    modelRef: row.modelRef,
    plan: row.plan,
    status: ready ? "ready" : "draft",
    revision: row.revision,
    groupId: row.groupId,
    templateId: row.templateId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function ownFlow(tenantId: string, id: string) {
  return and(
    eq(wakerFlows.id, id),
    eq(wakerFlows.tenantId, tenantId),
    eq(wakerFlows.definitionMode, DEFINITION_MODE),
    isNull(wakerFlows.deletedAt),
  );
}

function validModelRef(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (!isUuid(value)) throw new WakerFlowValidationError("请选择可用的模型。");
  return value;
}

/** A request id reused for different arguments: the second intent is refused, never merged. */
export class WakerFlowRequestConflictError extends WakerFlowError {
  constructor() {
    super(409, "这个请求编号已用于另一项操作，请刷新后重新发起。");
    this.name = "WakerFlowRequestConflictError";
  }
}

/** The request kind for planning; restart recovery (`recovery.ts`) settles the ones a crash left pending. */
export const GENERATE = "generate";
/** The request kind for a run; restart recovery (`recovery.ts`) settles the ones a crash left pending. */
export const RUN = "run";
const NOT_SAVED_MESSAGE = "这个 WakerFlow 还没有保存为可运行的计划，请先保存。";
const STALE_REVISION_MESSAGE = "这个 WakerFlow 已更新，请刷新后再运行。";
export const RUN_UNCERTAIN_MESSAGE =
  "无法确认这次运行是否已经开始，请到运行记录中查看，或发起新的运行。";
const QUOTA_MESSAGE = "本月任务额度不足，这次运行没有开始。";
const CANCELLED_MESSAGE = "已取消生成。";
/** A planning call whose outcome nobody saw: a timeout, an unclassified error, or a restart mid-call. */
export const UNCERTAIN_MESSAGE =
  "无法确认模型是否完成了这次生成，请发起新的生成。";
const SAVE_FAILED_MESSAGE = "生成的计划未能保存，请重新生成。";

const candidatesSchema = z
  .array(
    z.object({
      agentId: z.string().min(1).max(200),
      name: z.string().trim().max(160).default(""),
      role: z.string().trim().min(1).max(160),
    }),
  )
  .min(1)
  .max(50);

/** Keys sorted at every depth, so the same arguments always hash the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((name) => record[name] !== undefined)
      .sort()
      .map((name) => `${JSON.stringify(name)}:${canonical(record[name])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const requestColumns = {
  id: wakerFlowRequests.id,
  requestId: wakerFlowRequests.requestId,
  flowId: wakerFlowRequests.flowId,
  kind: wakerFlowRequests.kind,
  fingerprint: wakerFlowRequests.fingerprint,
  status: wakerFlowRequests.status,
  runId: wakerFlowRequests.runId,
  taskId: wakerFlowRequests.taskId,
  error: wakerFlowRequests.error,
  result: wakerFlowRequests.result,
};

type RequestRow = {
  id: string;
  requestId: string;
  flowId: string;
  kind: string;
  fingerprint: string;
  status: string;
  runId: string | null;
  taskId: string | null;
  error: string | null;
  result: unknown;
};

const STATUSES: readonly WakerFlowRequestStatus[] = [
  "pending",
  "completed",
  "failed",
  "cancelled",
  "unknown",
];

/** The column has no CHECK; the statuses are this file's convention, and anything else reads as unknown. */
function outcome(row: RequestRow): WakerFlowRequestOutcome {
  const status = (STATUSES as readonly string[]).includes(row.status)
    ? (row.status as WakerFlowRequestStatus)
    : "unknown";
  return {
    id: row.id,
    requestId: row.requestId,
    flowId: row.flowId,
    kind: row.kind,
    status,
    runId: row.runId,
    taskId: row.taskId,
    error: row.error,
    result:
      status === "completed" && row.result
        ? (row.result as WakerFlowGenerationResult)
        : null,
  };
}

const versionSummaryColumns = {
  revision: wakerFlowVersions.revision,
  name: sql<string>`coalesce(${wakerFlowVersions.plan}->>'name', '')`,
  stepCount: sql<number>`coalesce(jsonb_array_length(${wakerFlowVersions.plan}->'steps'), 0)::int`,
  modelRef: wakerFlowVersions.modelRef,
  templateId: wakerFlowVersions.templateId,
  createdBy: wakerFlowVersions.createdBy,
  createdAt: wakerFlowVersions.createdAt,
};

function versionSummary(row: {
  revision: number;
  name: string;
  stepCount: number;
  modelRef: string | null;
  templateId: string | null;
  createdBy: string | null;
  createdAt: Date;
}): WakerFlowVersionSummary {
  return {
    revision: row.revision,
    name: row.name,
    stepCount: Number(row.stepCount),
    modelRef: row.modelRef,
    templateId: row.templateId,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

export function createWakerFlowStore(options: {
  database: Database;
  /** WF-C: a run is the existing pipeline's run of the compiled template, driven by its `advance`. */
  pipeline: PipelineStore;
  /** Kept for the board projections the pipeline itself writes. */
  board: TaskProjector;
  /** Spec I6: may THIS actor use THIS coworker? Asked for every member on every Save. */
  canUse: (actor: string, agentId: string) => Promise<boolean>;
  /** WF-B: the planning model picker. Without it (and `generator`) generation answers 501. */
  models?: FlowModelResolver;
  generator?: Pick<FlowGenerator, "plan">;
  /** A planning call is model spend, so it is asked against the monthly ceiling first. */
  quota?: Pick<QuotaService, "assertCapacity">;
  /**
   * WF-C: drive a started run without holding the request open. The default is the pipeline routes'
   * own shape — `advance`, not awaited, a failure logged — and tests hand in one they can await.
   */
  drive?: (run: { tenantId: string; runId: string }) => void;
}) {
  const { database, canUse } = options;
  const drive =
    options.drive ??
    ((run: { tenantId: string; runId: string }) => {
      void options.pipeline.advance(run).catch((error: unknown) =>
        console.error(
          JSON.stringify({
            type: "wakerflow-drive-failed",
            runId: run.runId,
            reason: error instanceof Error ? error.message : String(error),
          }),
        ),
      );
    });

  /** The caller's own, live, json-plan-v1 Flow, or null. */
  const visibleFlow = async (tenantId: string, id: string) => {
    if (!isUuid(id)) return null;
    const [row] = await runAsTenant(tenantId, async () =>
      database
        .select(columns)
        .from(wakerFlows)
        .where(ownFlow(tenantId, id))
        .limit(1),
    );
    return row ?? null;
  };

  /** A run of THIS Flow in THIS tenant; anything else reads as not here. */
  const ownRun = async (tenantId: string, flowId: string, runId: string) => {
    if (!isUuid(runId) || !(await visibleFlow(tenantId, flowId)))
      throw new WakerFlowRunNotFoundError();
    const [row] = await runAsTenant(tenantId, async () =>
      database
        .select({ id: groupTaskRuns.id })
        .from(groupTaskRuns)
        .where(
          and(
            eq(groupTaskRuns.tenantId, tenantId),
            eq(groupTaskRuns.id, runId),
            eq(groupTaskRuns.flowId, flowId),
          ),
        )
        .limit(1),
    );
    if (!row) throw new WakerFlowRunNotFoundError();
  };
  /** Calls running in THIS process, so Cancel can stop the socket and not only the row. */
  const inflight = new Map<
    string,
    { flowId: string; controller: AbortController }
  >();
  const inflightKey = (tenantId: string, requestId: string) =>
    `${tenantId}\u0000${requestId}`;

  const readRequest = async (tenantId: string, requestId: string) => {
    const [row] = await runAsTenant(tenantId, async () =>
      database
        .select(requestColumns)
        .from(wakerFlowRequests)
        .where(
          and(
            eq(wakerFlowRequests.tenantId, tenantId),
            eq(wakerFlowRequests.requestId, requestId),
          ),
        )
        .limit(1),
    );
    return row ?? null;
  };

  /** A terminal write that loses to Cancel (or to another terminal write) changes nothing. */
  const finish = async (
    tenantId: string,
    claimId: string,
    status: Exclude<WakerFlowRequestStatus, "pending" | "completed">,
    error: string,
  ) => {
    await runAsTenant(tenantId, async () =>
      database
        .update(wakerFlowRequests)
        .set({ status, error, updatedAt: new Date() })
        .where(
          and(
            eq(wakerFlowRequests.id, claimId),
            eq(wakerFlowRequests.tenantId, tenantId),
            eq(wakerFlowRequests.status, "pending"),
          ),
        ),
    );
  };

  /**
   * Answer or skip one pending question, once. The row moves off `pending` under a condition, so of
   * two submissions (a double press, two people) exactly one wins; a repeat of the winning request
   * reads back the same outcome, and anything else is a 409. Only then is the run moved, and only if
   * it is still parked on that very step, so a repeat cannot answer a later question with this one.
   */
  async function settle(
    tenantId: string,
    id: string,
    runId: string,
    confirmationId: string,
    outcome: {
      status: "answered" | "skipped";
      requestId: string;
      answer: string | null;
    },
  ): Promise<WakerFlowConfirmation> {
    await ownRun(tenantId, id, runId);
    if (!isUuid(confirmationId)) throw new WakerFlowConfirmationNotFoundError();
    const mine = and(
      eq(flowConfirmations.tenantId, tenantId),
      eq(flowConfirmations.id, confirmationId),
      eq(flowConfirmations.runId, runId),
      eq(flowConfirmations.flowId, id),
    );
    const [won] = await runAsTenant(tenantId, async () =>
      database
        .update(flowConfirmations)
        .set({
          status: outcome.status,
          answer: outcome.answer,
          requestId: outcome.requestId,
          updatedAt: new Date(),
        })
        .where(and(mine, eq(flowConfirmations.status, "pending")))
        .returning(confirmationColumns),
    );
    let row: ConfirmationRow | undefined = won;
    if (!row) {
      const [existing] = await runAsTenant(tenantId, async () =>
        database
          .select(confirmationColumns)
          .from(flowConfirmations)
          .where(mine),
      );
      if (!existing) throw new WakerFlowConfirmationNotFoundError();
      const repeat =
        existing.requestId === outcome.requestId &&
        existing.status === outcome.status &&
        existing.answer === outcome.answer;
      if (!repeat) throw new WakerFlowConfirmationSettledError();
      row = existing;
    }
    const settled = row;
    const run = await options.pipeline.inspect({ tenantId, runId });
    const parked =
      run?.status === "awaiting_action" &&
      (run.steps as StepRecord[])[run.cursor]?.id === settled.nodeId;
    if (parked) {
      if (outcome.status === "answered")
        await options.pipeline.resume({
          tenantId,
          runId,
          output: outcome.answer ?? "",
          drive: false,
        });
      else
        await options.pipeline.skip({
          tenantId,
          runId,
          stepId: settled.nodeId,
        });
      drive({ tenantId, runId });
    }
    return confirmation(settled);
  }

  const store = {
    async create(tenantId: string, input: WakerFlowCreateInput) {
      const idea = typeof input.idea === "string" ? input.idea.trim() : "";
      if (idea.length > 4000)
        throw new WakerFlowValidationError("流程描述不能超过 4000 字。");
      const name =
        (typeof input.name === "string" ? input.name.trim() : "") ||
        idea.slice(0, 40) ||
        "未命名 WakerFlow";
      if (name.length > 160)
        throw new WakerFlowValidationError("流程名称不能超过 160 字。");
      const description =
        typeof input.description === "string" ? input.description.trim() : "";
      if (description.length > 4000)
        throw new WakerFlowValidationError("流程简介不能超过 4000 字。");
      const modelRef = validModelRef(input.modelRef) ?? null;
      const [row] = await runAsTenant(tenantId, async () =>
        database
          .insert(wakerFlows)
          .values({
            tenantId,
            name,
            description,
            idea,
            modelRef,
            definitionMode: DEFINITION_MODE,
          })
          .returning(columns),
      );
      // biome-ignore lint/style/noNonNullAssertion: an INSERT with RETURNING answers with the row it wrote
      return shape(row!);
    },

    async list(tenantId: string): Promise<WakerFlow[]> {
      const rows = await runAsTenant(tenantId, async () =>
        database
          .select(columns)
          .from(wakerFlows)
          .where(
            and(
              eq(wakerFlows.tenantId, tenantId),
              eq(wakerFlows.definitionMode, DEFINITION_MODE),
              isNull(wakerFlows.deletedAt),
            ),
          )
          .orderBy(desc(wakerFlows.updatedAt)),
      );
      return rows.map(shape);
    },

    async inspect(tenantId: string, id: string): Promise<WakerFlow | null> {
      if (!isUuid(id)) return null;
      const [row] = await runAsTenant(tenantId, async () =>
        database
          .select(columns)
          .from(wakerFlows)
          .where(ownFlow(tenantId, id))
          .limit(1),
      );
      return row ? shape(row) : null;
    },

    /**
     * Save the edited plan and compile it: fence on the revision, refresh the hidden crew, and add a
     * new template version. All of it happens in one transaction, so a refused member, a lost race or
     * a crash leaves the previous version exactly as it was.
     */
    async save(
      tenantId: string,
      actor: string,
      id: string,
      input: WakerFlowSaveInput,
    ): Promise<WakerFlow> {
      if (!isUuid(id)) throw new WakerFlowNotFoundError();
      if (!Number.isInteger(input.revision) || input.revision < 0)
        throw new WakerFlowValidationError(
          "缺少有效的版本号，请刷新后再保存。",
        );
      const parsed = wakerFlowPlanSchema.safeParse(input.plan);
      if (!parsed.success) {
        throw new WakerFlowValidationError(
          parsed.error.issues[0]?.message ?? "计划格式不正确。",
        );
      }
      const plan: WakerFlowPlan = parsed.data;
      const modelRef = validModelRef(input.modelRef);
      // A Flow this tenant cannot see answers 404 before anything is asked about its members: a
      // stranger learns nothing from which coworkers would have been refused.
      const [visible] = await runAsTenant(tenantId, () =>
        database
          .select({ id: wakerFlows.id })
          .from(wakerFlows)
          .where(ownFlow(tenantId, id))
          .limit(1),
      );
      if (!visible) throw new WakerFlowNotFoundError();
      for (const member of plan.members) {
        const allowed = await canUse(actor, member.agentId).catch(() => false);
        if (!allowed) {
          throw new WakerFlowValidationError(
            `计划中的员工「${member.role}」当前不可用，请换一位员工后再保存。`,
          );
        }
      }
      // WF7: each member's role and prompt goes ahead of that coworker's steps (D2).
      const steps = compiledSteps(plan);

      const row = await runAsTenant(tenantId, () =>
        database.transaction(async (tx) => {
          // The fence and the row lock in one statement: only the editor holding the current revision
          // gets past here, and anyone arriving after waits for this transaction and then misses.
          const [fenced] = await tx
            .update(wakerFlows)
            .set({
              revision: sql`${wakerFlows.revision} + 1`,
              updatedAt: new Date(),
            })
            .where(
              and(
                ownFlow(tenantId, id),
                eq(wakerFlows.revision, input.revision),
              ),
            )
            .returning({
              groupId: wakerFlows.groupId,
              revision: wakerFlows.revision,
            });
          if (!fenced) {
            const [exists] = await tx
              .select({ id: wakerFlows.id })
              .from(wakerFlows)
              .where(ownFlow(tenantId, id))
              .limit(1);
            if (!exists) throw new WakerFlowNotFoundError();
            throw new WakerFlowConflictError();
          }

          let groupId: string | null = null;
          if (fenced.groupId) {
            const [kept] = await tx
              .update(wakerGroups)
              .set({ description: plan.name, updatedAt: new Date() })
              .where(
                and(
                  eq(wakerGroups.id, fenced.groupId),
                  eq(wakerGroups.tenantId, tenantId),
                ),
              )
              .returning({ id: wakerGroups.id });
            groupId = kept?.id ?? null;
          }
          if (!groupId) {
            // Crew names are unique per workspace and the generic crew API accepts any name, so a crew
            // a person already called `wakerflow-<id>` must not make this Flow unsaveable: the name is
            // only a label, and a taken one falls back to a random suffix.
            const insertCrew = (name: string) =>
              tx
                .insert(wakerGroups)
                .values({ tenantId, name, description: plan.name })
                .onConflictDoNothing()
                .returning({ id: wakerGroups.id });
            const [created] = await insertCrew(`wakerflow-${id}`);
            const [crewRow] = created
              ? [created]
              : await insertCrew(`wakerflow-${id}-${randomUUID()}`);
            // biome-ignore lint/style/noNonNullAssertion: a fresh random name cannot conflict, so RETURNING answers with the row
            groupId = crewRow!.id;
          }
          const crew = groupId;
          await tx
            .delete(wakerGroupMembers)
            .where(eq(wakerGroupMembers.groupId, crew));
          await tx.insert(wakerGroupMembers).values(
            plan.members.map((member, position) => ({
              groupId: crew,
              agentId: member.agentId,
              position: String(position),
            })),
          );
          // The revision makes each version's name unique inside the crew, which the template table's
          // (tenant, group, name) index requires.
          const [template] = await tx
            .insert(groupTaskTemplates)
            .values({
              tenantId,
              groupId: crew,
              name: `${plan.name} · 第 ${fenced.revision} 版`,
              steps,
              createdBy: actor,
            })
            .returning({ id: groupTaskTemplates.id });
          const [saved] = await tx
            .update(wakerFlows)
            .set({
              name: plan.name,
              description: plan.description,
              plan,
              groupId: crew,
              // biome-ignore lint/style/noNonNullAssertion: an INSERT with RETURNING answers with the row it wrote
              templateId: template!.id,
              ...(modelRef === undefined ? {} : { modelRef }),
              updatedAt: new Date(),
            })
            .where(
              and(eq(wakerFlows.id, id), eq(wakerFlows.tenantId, tenantId)),
            )
            .returning(columns);
          // WF8: the whole definition this Save made, kept for the version list and for a rollback.
          // In the same transaction, so a version exists exactly when its revision does.
          if (saved)
            await tx.insert(wakerFlowVersions).values({
              tenantId,
              flowId: id,
              revision: saved.revision,
              plan,
              modelRef: saved.modelRef,
              templateId: saved.templateId,
              createdBy: actor,
            });
          return saved;
        }),
      );
      if (!row) throw new WakerFlowNotFoundError();
      return shape(row);
    },

    /** WF8: the saved versions of this Flow, newest first, without their plans. */
    async versions(
      tenantId: string,
      id: string,
    ): Promise<WakerFlowVersionSummary[]> {
      if (!(await visibleFlow(tenantId, id)))
        throw new WakerFlowNotFoundError();
      const rows = await runAsTenant(tenantId, async () =>
        database
          .select(versionSummaryColumns)
          .from(wakerFlowVersions)
          .where(
            and(
              eq(wakerFlowVersions.tenantId, tenantId),
              eq(wakerFlowVersions.flowId, id),
            ),
          )
          .orderBy(desc(wakerFlowVersions.revision)),
      );
      return rows.map(versionSummary);
    },

    /** WF8: one saved version of this Flow, with its whole plan. */
    async version(
      tenantId: string,
      id: string,
      revision: number,
    ): Promise<WakerFlowVersion> {
      if (!(await visibleFlow(tenantId, id)))
        throw new WakerFlowNotFoundError();
      if (!Number.isInteger(revision) || revision < 1)
        throw new WakerFlowVersionNotFoundError();
      const [row] = await runAsTenant(tenantId, async () =>
        database
          .select({ ...versionSummaryColumns, plan: wakerFlowVersions.plan })
          .from(wakerFlowVersions)
          .where(
            and(
              eq(wakerFlowVersions.tenantId, tenantId),
              eq(wakerFlowVersions.flowId, id),
              eq(wakerFlowVersions.revision, revision),
            ),
          )
          .limit(1),
      );
      if (!row) throw new WakerFlowVersionNotFoundError();
      return { ...versionSummary(row), plan: row.plan };
    },

    /**
     * WF8: roll back to a saved version, which is saving that version's plan (and model) again. It
     * goes through the whole of `save`: fenced on the revision the person was looking at, every
     * member asked again (I6), a new template, the next revision. History is never rewritten, so
     * the restore is itself a new version, and a run already going keeps the template it started on.
     */
    async restore(
      tenantId: string,
      actor: string,
      id: string,
      revision: number,
      input: { revision: number },
    ): Promise<WakerFlow> {
      const version = await store.version(tenantId, id, revision);
      return store.save(tenantId, actor, id, {
        revision: input.revision,
        plan: version.plan,
        modelRef: version.modelRef,
      });
    },

    /**
     * Soft-delete. Refused while planning is pending or a run of this Flow is still going, because
     * both would otherwise finish into a Flow the person can no longer open.
     */
    async remove(
      tenantId: string,
      id: string,
      revision?: number,
    ): Promise<boolean> {
      if (!isUuid(id)) return false;
      return runAsTenant(tenantId, () =>
        database.transaction(async (tx) => {
          const [row] = await tx
            .select({ id: wakerFlows.id, revision: wakerFlows.revision })
            .from(wakerFlows)
            .where(ownFlow(tenantId, id))
            .for("update");
          if (!row) return false;
          if (revision !== undefined && row.revision !== revision)
            throw new WakerFlowConflictError();
          const [planning] = await tx
            .select({ id: wakerFlowRequests.id })
            .from(wakerFlowRequests)
            .where(
              and(
                eq(wakerFlowRequests.tenantId, tenantId),
                eq(wakerFlowRequests.flowId, id),
                // Planning, or a run request that has claimed its row and not yet registered its run.
                eq(wakerFlowRequests.status, "pending"),
              ),
            )
            .limit(1);
          const [running] = await tx
            .select({ id: groupTaskRuns.id })
            .from(groupTaskRuns)
            .where(
              and(
                eq(groupTaskRuns.tenantId, tenantId),
                eq(groupTaskRuns.flowId, id),
                inArray(groupTaskRuns.status, ["running", "awaiting_action"]),
              ),
            )
            .limit(1);
          if (planning || running) throw new WakerFlowBusyError();
          const [removed] = await tx
            .update(wakerFlows)
            .set({
              deletedAt: new Date(),
              updatedAt: new Date(),
              revision: sql`${wakerFlows.revision} + 1`,
            })
            .where(ownFlow(tenantId, id))
            .returning({ id: wakerFlows.id });
          return Boolean(removed);
        }),
      );
    },

    /**
     * Natural-language planning (story WF3), once per request id.
     *
     * The order is the contract. A repeat of a request already claimed answers from the stored row and
     * never calls the model again — not even a request whose outcome is `unknown`, because the provider
     * may have done that work. A new request is refused for a Flow that is not the caller's, a model
     * that is not usable, or a coworker the actor may not use before any row is written or any call is
     * made; then the quota; then the claim, which a concurrent twin loses on the unique key; then the
     * one call. A plan that arrives is written into a draft that was never compiled — a saved Flow is
     * not changed behind its template, the editor applies the result itself — and only if nobody
     * cancelled the request meanwhile.
     */
    async generate(
      tenantId: string,
      actor: string,
      id: string,
      input: WakerFlowGenerateInput,
    ): Promise<WakerFlowRequestOutcome> {
      if (!isUuid(id)) throw new WakerFlowNotFoundError();
      if (!isUuid(input.requestId))
        throw new WakerFlowValidationError(
          "缺少有效的请求编号，请刷新后重试。",
        );
      const idea = typeof input.idea === "string" ? input.idea.trim() : "";
      if (!idea) throw new WakerFlowValidationError("请先描述你想创建的流程。");
      if (idea.length > 4000)
        throw new WakerFlowValidationError("流程描述不能超过 4000 字。");
      if (typeof input.modelRef !== "string" || !input.modelRef)
        throw new WakerFlowValidationError("请选择可用的模型。");
      const scenario = input.scenario ?? undefined;
      if (
        scenario !== undefined &&
        !(WAKERFLOW_SUGGESTIONS as readonly string[]).includes(scenario)
      )
        throw new WakerFlowValidationError("请选择列表中的场景建议。");
      const parsedMembers = candidatesSchema.safeParse(input.members);
      if (!parsedMembers.success)
        throw new WakerFlowValidationError("请至少选择一位可用的员工。");
      const members: WakerFlowCandidate[] = parsedMembers.data;
      if (
        new Set(members.map((member) => member.agentId)).size !== members.length
      )
        throw new WakerFlowValidationError("同一位员工不能重复加入计划。");
      const fingerprint = createHash("sha256")
        .update(
          canonical({
            kind: GENERATE,
            flowId: id,
            modelRef: input.modelRef,
            idea,
            members,
            scenario: scenario ?? null,
          }),
        )
        .digest("hex");

      const answer = (row: RequestRow) => {
        if (row.fingerprint !== fingerprint)
          throw new WakerFlowRequestConflictError();
        return outcome(row);
      };
      const existing = await readRequest(tenantId, input.requestId);
      if (existing) return answer(existing);

      const { models, generator } = options;
      if (!models || !generator) throw new WakerFlowUnavailableError();
      const [flow] = await runAsTenant(tenantId, async () =>
        database
          .select({ id: wakerFlows.id })
          .from(wakerFlows)
          .where(ownFlow(tenantId, id))
          .limit(1),
      );
      // The request row references the Flow, and a foreign key does not look through row-level
      // security: without this read another tenant's Flow id would be accepted as a reference.
      if (!flow) throw new WakerFlowNotFoundError();
      const resolved = await models.resolve(tenantId, input.modelRef);
      for (const member of members) {
        const allowed = await canUse(actor, member.agentId).catch(() => false);
        if (!allowed)
          throw new WakerFlowValidationError(
            `你无权使用员工「${member.name || member.role}」，请换一位员工后再生成。`,
          );
      }
      await options.quota?.assertCapacity(tenantId, "tasksPerMonth");

      const [claimed] = await runAsTenant(tenantId, async () =>
        database
          .insert(wakerFlowRequests)
          .values({
            tenantId,
            requestId: input.requestId,
            flowId: id,
            kind: GENERATE,
            fingerprint,
          })
          .onConflictDoNothing({
            target: [wakerFlowRequests.tenantId, wakerFlowRequests.requestId],
          })
          .returning(requestColumns),
      );
      if (!claimed) {
        // A twin claimed it first; its row is the answer, whatever state it is in.
        const twin = await readRequest(tenantId, input.requestId);
        if (!twin) throw new WakerFlowNotFoundError();
        return answer(twin);
      }

      const key = inflightKey(tenantId, input.requestId);
      const controller = new AbortController();
      inflight.set(key, { flowId: id, controller });
      let generated: WakerFlowPlan | null = null;
      try {
        generated = await generator.plan({
          model: resolved.model,
          idea,
          members,
          scenario,
          signal: controller.signal,
        });
      } catch (error) {
        if (error instanceof FlowPlanFormatError)
          await finish(
            tenantId,
            claimed.id,
            "failed",
            WAKERFLOW_PLAN_FORMAT_MESSAGE,
          );
        else if (error instanceof FlowGenerationRefusedError)
          await finish(tenantId, claimed.id, "failed", error.message);
        else if (error instanceof FlowGenerationCancelledError)
          await finish(tenantId, claimed.id, "cancelled", CANCELLED_MESSAGE);
        // Everything else — a timeout, a dropped line, an error nobody classified — may have been
        // done and charged by the provider, so it is recorded as such and never replayed.
        else await finish(tenantId, claimed.id, "unknown", UNCERTAIN_MESSAGE);
        const settled = await readRequest(tenantId, input.requestId);
        return outcome(settled ?? claimed);
      } finally {
        inflight.delete(key);
      }
      const plan = generated;
      // Unreachable: the call either answered with a plan or the catch above returned.
      if (!plan) return outcome(claimed);

      try {
        await runAsTenant(tenantId, () =>
          database.transaction(async (tx) => {
            // Locked so Cancel either lands first (and the plan is not written) or waits and misses.
            const [pending] = await tx
              .select({ id: wakerFlowRequests.id })
              .from(wakerFlowRequests)
              .where(
                and(
                  eq(wakerFlowRequests.id, claimed.id),
                  eq(wakerFlowRequests.tenantId, tenantId),
                  eq(wakerFlowRequests.status, "pending"),
                ),
              )
              .for("update");
            if (!pending) return;
            const [written] = await tx
              .update(wakerFlows)
              .set({
                plan,
                name: plan.name,
                description: plan.description,
                idea,
                ...(isUuid(resolved.modelRef)
                  ? { modelRef: resolved.modelRef }
                  : {}),
                revision: sql`${wakerFlows.revision} + 1`,
                updatedAt: new Date(),
              })
              .where(and(ownFlow(tenantId, id), isNull(wakerFlows.templateId)))
              .returning({ revision: wakerFlows.revision });
            const result: WakerFlowGenerationResult = {
              plan,
              modelRef: resolved.modelRef,
              revision: written?.revision ?? null,
              applied: Boolean(written),
            };
            await tx
              .update(wakerFlowRequests)
              .set({
                status: "completed",
                error: null,
                result,
                updatedAt: new Date(),
              })
              .where(eq(wakerFlowRequests.id, claimed.id));
          }),
        );
      } catch (error) {
        // The answer arrived but could not be stored: settle the row so it does not stay pending (and
        // block deleting the Flow) forever. A new request id is the way to try again.
        await finish(tenantId, claimed.id, "failed", SAVE_FAILED_MESSAGE).catch(
          () => undefined,
        );
        throw error;
      }
      const settled = await readRequest(tenantId, input.requestId);
      return outcome(settled ?? claimed);
    },

    /**
     * Stop a planning request. The row is marked first, with a condition on `pending`, so a request
     * that already finished keeps its outcome; then the call is aborted if it runs in this process.
     * Another process's call finishes into a cancelled row and writes nothing.
     */
    async cancel(
      tenantId: string,
      flowId: string,
      requestId: string,
    ): Promise<WakerFlowRequestOutcome | null> {
      if (!isUuid(flowId) || !isUuid(requestId)) return null;
      await runAsTenant(tenantId, async () =>
        database
          .update(wakerFlowRequests)
          .set({
            status: "cancelled",
            error: CANCELLED_MESSAGE,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(wakerFlowRequests.tenantId, tenantId),
              eq(wakerFlowRequests.requestId, requestId),
              eq(wakerFlowRequests.flowId, flowId),
              eq(wakerFlowRequests.kind, GENERATE),
              eq(wakerFlowRequests.status, "pending"),
            ),
          ),
      );
      const running = inflight.get(inflightKey(tenantId, requestId));
      if (running && running.flowId === flowId) running.controller.abort();
      const row = await readRequest(tenantId, requestId);
      return row && row.flowId === flowId ? outcome(row) : null;
    },

    /** One request of the caller's own tenant, or null. */
    async getRequest(
      tenantId: string,
      requestId: string,
    ): Promise<WakerFlowRequestOutcome | null> {
      if (!isUuid(requestId)) return null;
      const row = await readRequest(tenantId, requestId);
      return row ? outcome(row) : null;
    },

    /**
     * Start a run of the saved plan (stories WF4/WF5/WF6), once per request id.
     *
     * The order is the contract. A repeat of a claimed request answers from its row and never starts a
     * second run — not even one whose outcome is `unknown`, because the pipeline may have opened its
     * card. A new request is refused for a Flow that is not the caller's (404), one that is not saved
     * or not at the revision the person was looking at (409), and inputs the plan does not declare or
     * leaves missing (400) — all before any row or card exists. Then the claim, taken under a share
     * lock on the Flow so a concurrent delete either lands first (and this is a 404) or waits and then
     * sees the pending request; the run id is fixed in that row before the pipeline is asked, so a
     * crash between the two cannot mint a second id. Then the pipeline's own start, and the drive.
     */
    async start(
      tenantId: string,
      actor: string,
      id: string,
      input: WakerFlowStartInput,
    ): Promise<WakerFlowRequestOutcome> {
      if (!isUuid(id)) throw new WakerFlowNotFoundError();
      if (!isUuid(input.requestId))
        throw new WakerFlowValidationError(
          "缺少有效的请求编号，请刷新后重试。",
        );
      if (!Number.isInteger(input.revision) || input.revision < 0)
        throw new WakerFlowValidationError(
          "缺少有效的版本号，请刷新后再运行。",
        );
      const fingerprint = createHash("sha256")
        .update(
          canonical({
            kind: RUN,
            flowId: id,
            revision: input.revision,
            inputs: input.inputs ?? {},
          }),
        )
        .digest("hex");
      const answer = (row: RequestRow) => {
        if (row.fingerprint !== fingerprint)
          throw new WakerFlowRequestConflictError();
        return outcome(row);
      };
      const existing = await readRequest(tenantId, input.requestId);
      if (existing) return answer(existing);

      const flow = await visibleFlow(tenantId, id);
      if (!flow) throw new WakerFlowNotFoundError();
      const { plan, templateId } = flow;
      // The same fact `shape` calls "ready": Save has compiled the plan into a crew and a template.
      if (!plan || !templateId || !flow.groupId)
        throw new WakerFlowNotRunnableError(NOT_SAVED_MESSAGE);
      if (flow.revision !== input.revision)
        throw new WakerFlowNotRunnableError(STALE_REVISION_MESSAGE);
      let inputs: Record<string, string>;
      try {
        inputs = flowInputs(plan, input.inputs ?? {});
      } catch (error) {
        throw new WakerFlowValidationError(
          error instanceof z.ZodError
            ? "流程输入格式不正确。"
            : error instanceof Error
              ? error.message
              : "流程输入格式不正确。",
        );
      }
      // Refused before the claim, so a workspace at its ceiling is left with no row to explain.
      // WF7 D4: counted by the steps that can run on the longest path, not the steps written.
      await options.quota?.assertCapacity(
        tenantId,
        "tasksPerMonth",
        stepBudget(plan.steps) + 1,
      );

      const claimed = await runAsTenant(tenantId, () =>
        database.transaction(async (tx) => {
          const [locked] = await tx
            .select({
              revision: wakerFlows.revision,
              templateId: wakerFlows.templateId,
            })
            .from(wakerFlows)
            .where(ownFlow(tenantId, id))
            .for("share");
          if (!locked) throw new WakerFlowNotFoundError();
          if (
            locked.revision !== input.revision ||
            locked.templateId !== templateId
          )
            throw new WakerFlowNotRunnableError(STALE_REVISION_MESSAGE);
          const [row] = await tx
            .insert(wakerFlowRequests)
            .values({
              tenantId,
              requestId: input.requestId,
              flowId: id,
              kind: RUN,
              fingerprint,
              runId: randomUUID(),
            })
            .onConflictDoNothing({
              target: [wakerFlowRequests.tenantId, wakerFlowRequests.requestId],
            })
            .returning({
              ...requestColumns,
              tenantId: wakerFlowRequests.tenantId,
            });
          return row ?? null;
        }),
      );
      const runId = claimed?.runId;
      if (!claimed || !runId) {
        // A twin claimed it first; its row is the answer, whatever state it is in.
        const twin = await readRequest(tenantId, input.requestId);
        if (!twin) throw new WakerFlowNotFoundError();
        return answer(twin);
      }

      // From here on the tenant is the claimed row's, never a value carried in from elsewhere.
      const owner = claimed.tenantId;
      let started: { runId: string; parentTaskId: string };
      try {
        started = await options.pipeline.start({
          tenantId: owner,
          templateId,
          flowId: id,
          inputs,
          task: flow.name,
          initiatedBy: actor,
          runId,
        });
      } catch (error) {
        // These are raised before the pipeline opens a card or writes a run: nothing happened.
        if (error instanceof QuotaExceeded) {
          await finish(owner, claimed.id, "failed", QUOTA_MESSAGE);
          throw error;
        }
        if (
          error instanceof PipelineNotFoundError ||
          error instanceof PipelineValidationError
        ) {
          await finish(owner, claimed.id, "failed", error.message);
          throw error;
        }
        // Anything else may have left a card behind: recorded as such and never replayed.
        await finish(owner, claimed.id, "unknown", RUN_UNCERTAIN_MESSAGE).catch(
          () => undefined,
        );
        const settled = await readRequest(owner, input.requestId);
        return outcome(settled ?? claimed);
      }
      const registered = started;
      drive({ tenantId: owner, runId: registered.runId });
      await runAsTenant(owner, async () =>
        database
          .update(wakerFlowRequests)
          .set({
            status: "completed",
            error: null,
            runId: registered.runId,
            taskId: registered.parentTaskId,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(wakerFlowRequests.id, claimed.id),
              eq(wakerFlowRequests.tenantId, owner),
              eq(wakerFlowRequests.status, "pending"),
            ),
          ),
      );
      const settled = await readRequest(owner, input.requestId);
      return outcome(settled ?? claimed);
    },

    /** The runs of this Flow, newest first. */
    async runs(tenantId: string, id: string): Promise<WakerFlowRunSummary[]> {
      if (!(await visibleFlow(tenantId, id)))
        throw new WakerFlowNotFoundError();
      const rows = await runAsTenant(tenantId, async () =>
        database
          .select({
            id: groupTaskRuns.id,
            status: groupTaskRuns.status,
            templateId: groupTaskRuns.templateId,
            parentTaskId: groupTaskRuns.parentTaskId,
            createdAt: groupTaskRuns.createdAt,
          })
          .from(groupTaskRuns)
          .where(
            and(
              eq(groupTaskRuns.tenantId, tenantId),
              eq(groupTaskRuns.flowId, id),
            ),
          )
          .orderBy(desc(groupTaskRuns.createdAt)),
      );
      return rows.map((row) => ({
        id: row.id,
        status: row.status,
        templateId: row.templateId,
        parentTaskId: row.parentTaskId,
        createdAt: row.createdAt.toISOString(),
      }));
    },

    /** One run of this Flow, as the pipeline reads it. */
    async run(tenantId: string, id: string, runId: string) {
      await ownRun(tenantId, id, runId);
      const run = await options.pipeline.inspect({ tenantId, runId });
      if (!run) throw new WakerFlowRunNotFoundError();
      return { id: runId, flowId: id, ...run };
    },

    /** Stop a run of this Flow; the pipeline's abort is what fences late step results. */
    async abortRun(tenantId: string, id: string, runId: string) {
      await ownRun(tenantId, id, runId);
      return options.pipeline.abort({ tenantId, runId });
    },

    /**
     * WF8: the recorded state changes of a run of this Flow, oldest first, `limit` (at most 100,
     * default 50) after the `after` sequence. `next` is the sequence to ask after for the next page,
     * or null when this page reached the end.
     */
    async events(
      tenantId: string,
      id: string,
      runId: string,
      page: { after?: number; limit?: number } = {},
    ): Promise<{ events: WakerFlowRunEvent[]; next: number | null }> {
      await ownRun(tenantId, id, runId);
      const after =
        Number.isSafeInteger(page.after) && (page.after ?? 0) > 0
          ? (page.after as number)
          : 0;
      const limit =
        Number.isSafeInteger(page.limit) && (page.limit ?? 0) > 0
          ? Math.min(page.limit as number, MAX_EVENT_PAGE)
          : 50;
      const rows = await runAsTenant(tenantId, async () =>
        database
          .select({
            sequence: flowRunEvents.sequence,
            type: flowRunEvents.type,
            correlationId: flowRunEvents.correlationId,
            payload: flowRunEvents.payload,
            createdAt: flowRunEvents.createdAt,
          })
          .from(flowRunEvents)
          .where(
            and(
              eq(flowRunEvents.tenantId, tenantId),
              eq(flowRunEvents.runId, runId),
              eq(flowRunEvents.flowId, id),
              gt(flowRunEvents.sequence, BigInt(after)),
            ),
          )
          .orderBy(asc(flowRunEvents.sequence))
          .limit(limit + 1),
      );
      const shown = rows.slice(0, limit).map((row) => ({
        sequence: Number(row.sequence),
        type: row.type,
        correlationId: row.correlationId,
        payload: (row.payload ?? {}) as Record<string, unknown>,
        createdAt: row.createdAt.toISOString(),
      }));
      return {
        events: shown,
        next:
          rows.length > limit
            ? (shown[shown.length - 1]?.sequence ?? null)
            : null,
      };
    },

    /**
     * WF8: retry a failed run from the step that failed (spec §3.5, D6, D7), once per request id.
     *
     * The new run uses the SOURCE run's template, not the Flow's current one, so its definition is the
     * one that failed (D7; a newer plan is a new run). The steps before the failed one are carried over
     * with their outputs and never run again; the failed step runs again from the start, which may
     * repeat whatever it did to the world before it failed (D6: the page asks first). Only the steps
     * from there on are counted against the month and asked about (I6); a coworker the person can no
     * longer use refuses the retry, naming the steps.
     *
     * The ledger row is written in the transaction that registers the new run, `prepared`, and becomes
     * `ready` once the run is driven; a restart in between leaves it `prepared`, and recovery settles it
     * `unknown` without driving anything (`recovery.ts`). A repeat of the request id answers from the
     * row; the same id for another run is a 409, and so is a second retry of the same run.
     */
    async retry(
      tenantId: string,
      actor: string,
      id: string,
      runId: string,
      input: { requestId: string },
    ): Promise<WakerFlowRetry> {
      if (!isUuid(input.requestId))
        throw new WakerFlowValidationError(
          "缺少有效的请求编号，请刷新后重试。",
        );
      const fingerprint = createHash("sha256")
        .update(canonical({ kind: RETRY, flowId: id, sourceRunId: runId }))
        .digest("hex");
      const readRetry = async (
        where: ReturnType<typeof and>,
      ): Promise<(WakerFlowRetry & { fingerprint: string }) | null> => {
        const [row] = await runAsTenant(tenantId, async () =>
          database
            .select(retryColumns)
            .from(flowRunRetries)
            .where(where)
            .limit(1),
        );
        return row
          ? { ...retryOutcome(row), fingerprint: row.fingerprint }
          : null;
      };
      const byRequest = () =>
        readRetry(
          and(
            eq(flowRunRetries.tenantId, tenantId),
            eq(flowRunRetries.requestId, input.requestId),
          ),
        );
      const answer = (row: WakerFlowRetry & { fingerprint: string }) => {
        if (row.fingerprint !== fingerprint)
          throw new WakerFlowRequestConflictError();
        const { fingerprint: _, ...outcome } = row;
        return outcome;
      };
      const repeated = await byRequest();
      if (repeated) return answer(repeated);

      await ownRun(tenantId, id, runId);
      const flow = await visibleFlow(tenantId, id);
      if (!flow) throw new WakerFlowNotFoundError();
      const [source] = await runAsTenant(tenantId, async () =>
        database
          .select({
            status: groupTaskRuns.status,
            cursor: groupTaskRuns.cursor,
            steps: groupTaskRuns.steps,
            templateId: groupTaskRuns.templateId,
            inputs: groupTaskRuns.inputs,
          })
          .from(groupTaskRuns)
          .where(
            and(
              eq(groupTaskRuns.tenantId, tenantId),
              eq(groupTaskRuns.id, runId),
            ),
          )
          .limit(1),
      );
      if (!source) throw new WakerFlowRunNotFoundError();
      if (source.status !== "failed")
        throw new WakerFlowValidationError(RETRY_NOT_FAILED_MESSAGE);
      const steps = (
        Array.isArray(source.steps) ? source.steps : []
      ) as StepRecord[];
      const failedAt = steps.findIndex((step) => step.state === "failed");
      const from =
        failedAt >= 0 ? failedAt : Math.min(source.cursor, steps.length - 1);
      const failedStep = steps[from];
      if (!failedStep)
        throw new WakerFlowValidationError(RETRY_NOT_FAILED_MESSAGE);
      if (!source.templateId)
        throw new WakerFlowNotRunnableError(RETRY_DEFINITION_GONE_MESSAGE);
      const templateId = source.templateId;
      const earlier = await readRetry(
        and(
          eq(flowRunRetries.tenantId, tenantId),
          eq(flowRunRetries.sourceRunId, runId),
        ),
      );
      if (earlier) throw new WakerFlowNotRunnableError(RETRY_TAKEN_MESSAGE);
      const carried = steps.slice(0, from).map((step) => ({
        state: step.state,
        ...(step.output === undefined ? {} : { output: step.output }),
        // WF7: why a carried step was skipped, and which branch a carried decision took.
        ...(step.skipReason === undefined
          ? {}
          : { skipReason: step.skipReason }),
        ...(step.branch === undefined ? {} : { branch: step.branch }),
      }));
      if (
        carried.some(
          (step) => step.state !== "done" && step.state !== "skipped",
        )
      )
        throw new WakerFlowValidationError(RETRY_NOT_FAILED_MESSAGE);
      // The Flow's revision when the source run started: the version that compiled its template.
      const [version] = await runAsTenant(tenantId, async () =>
        database
          .select({ revision: wakerFlowVersions.revision })
          .from(wakerFlowVersions)
          .where(
            and(
              eq(wakerFlowVersions.tenantId, tenantId),
              eq(wakerFlowVersions.flowId, id),
              eq(wakerFlowVersions.templateId, templateId),
            ),
          )
          .limit(1),
      );
      const definitionRevision = Math.max(
        1,
        version?.revision ?? flow.revision,
      );
      const remaining = stepBudget(steps, from);
      // Refused before anything is registered: only the steps that will run are counted.
      await options.quota?.assertCapacity(
        tenantId,
        "tasksPerMonth",
        remaining + 1,
      );

      const newRunId = randomUUID();
      try {
        await options.pipeline.start({
          tenantId,
          templateId,
          flowId: id,
          inputs: source.inputs ?? {},
          task: flow.name,
          initiatedBy: actor,
          runId: newRunId,
          seed: { cursor: from, records: carried },
          register: async (tx, registered) => {
            await tx.insert(flowRunRetries).values({
              tenantId,
              requestId: input.requestId,
              flowId: id,
              sourceRunId: runId,
              sourceRevision: flow.revision,
              definitionRevision,
              correlationId: `${runId}:retry`,
              nodeId: failedStep.id,
              newRunId: registered,
              fingerprint,
            });
            await tx.insert(flowRunEvents).values({
              tenantId,
              flowId: id,
              runId,
              correlationId: `${runId}:run_retried:${registered}`,
              type: "run_retried",
              payload: {
                newRunId: registered,
                fromStep: failedStep.id,
                index: from,
              },
            });
          },
        });
      } catch (error) {
        if (uniqueViolation(error)) {
          // A twin registered first: the card this attempt opened stands for nothing, and is closed.
          await options.board
            .finished({ tenantId, runRef: newRunId, failed: true })
            .catch(() => undefined);
          const twin = await byRequest();
          if (twin) return answer(twin);
          throw new WakerFlowNotRunnableError(RETRY_TAKEN_MESSAGE);
        }
        if (error instanceof PipelineStepForbiddenError)
          throw new WakerFlowValidationError(error.message);
        if (error instanceof PipelineNotFoundError)
          throw new WakerFlowNotRunnableError(RETRY_DEFINITION_GONE_MESSAGE);
        if (error instanceof PipelineValidationError)
          throw new WakerFlowValidationError(error.message);
        throw error;
      }
      drive({ tenantId, runId: newRunId });
      await runAsTenant(tenantId, async () =>
        database
          .update(flowRunRetries)
          .set({ status: "ready" })
          .where(
            and(
              eq(flowRunRetries.tenantId, tenantId),
              eq(flowRunRetries.requestId, input.requestId),
              eq(flowRunRetries.status, "prepared"),
            ),
          ),
      );
      const settled = await byRequest();
      if (!settled) throw new WakerFlowRunNotFoundError();
      return answer(settled);
    },

    /** WF8: the questions a run of this Flow stopped on, oldest first, with what became of each. */
    async confirmations(
      tenantId: string,
      id: string,
      runId: string,
    ): Promise<WakerFlowConfirmation[]> {
      await ownRun(tenantId, id, runId);
      const rows = await runAsTenant(tenantId, async () =>
        database
          .select(confirmationColumns)
          .from(flowConfirmations)
          .where(
            and(
              eq(flowConfirmations.tenantId, tenantId),
              eq(flowConfirmations.runId, runId),
              eq(flowConfirmations.flowId, id),
            ),
          )
          .orderBy(asc(flowConfirmations.createdAt)),
      );
      return rows.map(confirmation);
    },

    /**
     * WF8: answer a question a step stopped on (spec §3.3). The answer becomes that step's output, the
     * steps after it read it as usual, and the run is driven on in the background.
     */
    async answer(
      tenantId: string,
      id: string,
      runId: string,
      confirmationId: string,
      input: { requestId: string; answer: string },
    ): Promise<WakerFlowConfirmation> {
      if (!isUuid(input.requestId))
        throw new WakerFlowValidationError(
          "缺少有效的请求编号，请刷新后重试。",
        );
      const answer = typeof input.answer === "string" ? input.answer : "";
      if (!answer.trim()) throw new WakerFlowValidationError("请填写回答。");
      if (answer.length > MAX_ANSWER)
        throw new WakerFlowValidationError(`回答不能超过 ${MAX_ANSWER} 字。`);
      return settle(tenantId, id, runId, confirmationId, {
        status: "answered",
        requestId: input.requestId,
        answer,
      });
    },

    /**
     * WF8: skip a question a step stopped on. The step is recorded as skipped (never cleared), later
     * steps that read its output see 「（此输入未产生）」, and the run is driven on in the background.
     */
    async skipConfirmation(
      tenantId: string,
      id: string,
      runId: string,
      confirmationId: string,
      input: { requestId: string },
    ): Promise<WakerFlowConfirmation> {
      if (!isUuid(input.requestId))
        throw new WakerFlowValidationError(
          "缺少有效的请求编号，请刷新后重试。",
        );
      return settle(tenantId, id, runId, confirmationId, {
        status: "skipped",
        requestId: input.requestId,
        answer: null,
      });
    },

    /** The planning model picker; 501 without a resolver. */
    async modelChoices(tenantId: string) {
      if (!options.models) throw new WakerFlowUnavailableError();
      return options.models.choices(tenantId);
    },
  };
  return store;
}
