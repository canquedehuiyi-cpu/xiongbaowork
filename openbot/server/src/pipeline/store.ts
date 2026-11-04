import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  groupTaskRuns,
  groupTaskTemplates,
  tasks,
  wakerFlows,
  wakerGroupMembers,
} from "../db/schema";
import {
  type PipelineStepRow,
  type PipelineStepStateRow,
  stepIsSettled,
} from "../db/schema/pipeline";
import {
  WAKERFLOW_MAX_NESTING,
  WAKERFLOW_MAX_STEPS,
} from "../../../shared/wakerflows";
import type { QuotaService } from "../quota/limits";
import type { TaskProjector } from "../tasks/projector";
import { runAsTenant } from "../tenant/context";
import type { ActionStepRunner } from "./action-step";
import { decide, routeAfter, stepBudget } from "./decision";
import { reapAbandonedPipelineRuns } from "./reap";

/**
 * The crew pipeline (ticket 021, spec D10 / I1-I6, ADR-0001 = A).
 *
 * A run is a cursor over a template's steps, and every step that executes becomes a task card under the
 * run's parent card. There is no per-step table on purpose: the card IS the record that a step happened
 * — the same row the person sees on the board — so a second copy would only be a second thing to keep
 * in step with it. The run row snapshots the steps it started with, which is also what makes a resumed
 * run immune to the template being edited in between: the person asked for the plan that existed then.
 *
 * Execution is handed to `executeStep` rather than done here. In production that is the deployment's own
 * unattended turn channel — the same runner, thread lock, transcript and governance gates a routine
 * firing uses — and this file's job is only the sequence: whose turn it is, what it is told, what came
 * back, and whether the run continues.
 */

/**
 * The step shapes are the columns' shapes, aliased rather than restated: the row and the in-memory
 * record are the same object going through a jsonb column, and two declarations of one shape is where
 * they start to disagree.
 */
export type PipelineStep = PipelineStepRow;
/**
 * WF8: a step parked on a question (no approval row) also keeps the question it asked, so the
 * WakerFlow layer can show it and record the person's answer (`flow_confirmations`).
 */
export type StepRecord = PipelineStepStateRow & { question?: string };

export type RunOutcome = {
  status: "running" | "awaiting_action" | "done" | "failed" | "aborted";
  cursor: number;
  steps: StepRecord[];
};

/**
 * What one step's turn produced. `awaiting_action` parks the whole run (spec I3), and the cursor stays
 * put so the call after the person handles the approval re-runs THIS step rather than skipping it.
 *
 * `approvalId` is the row the coworker is waiting on, and it is optional because the pipeline is not the
 * only thing that can park a step: a question, or a headless suspension on a durable request id, has no
 * approval row at all (see `routines/runner.ts`, which refuses to use `needs_action` for exactly that
 * reason). Without a row there is nothing for the board's lane to hold, and the store says so by parking
 * only what it can.
 */
export type StepResult =
  | { status: "done"; output: string }
  | {
      status: "awaiting_action";
      approvalId?: string;
      /** What the coworker asked, when it stopped on a question rather than an approval (WF8). */
      question?: string;
    }
  | { status: "failed"; error: string };

/**
 * How the orchestrator asks for one coworker's turn, named so the production channel
 * (`pipeline/turn-channel.ts`) is checked against this contract instead of against a copy that can drift.
 */
export type PipelineStepRunner = (input: {
  tenantId: string;
  agentId: string;
  instruction: string;
  signal?: AbortSignal;
  /** What earlier steps produced, so step 3 is not answering out of thin air (spec I2). */
  prior: string[];
  initiatedBy: string;
  runId: string;
  /**
   * The id this step's card is keyed by, and the id the turn must run under.
   *
   * Not a convenience: the approval machinery parks a board card by the run id the approval was opened
   * with (`approvals/store.ts` -> `board.needsAction({runRef})`), so a step that ran its turn under some
   * other id would park a card that does not exist and leave this one `running` while its own work is
   * waiting on a person. Handing the card's id down is what makes the gate's park land on the card the
   * person is looking at.
   */
  stepRunRef: string;
}) => Promise<StepResult>;

/**
 * A template or run that is not in this workspace.
 *
 * Its own class because the HTTP answer is a 404 and not a 400: spec D15's rule is that another
 * tenant's ids are never confirmed to a caller, and a string comparison in the route layer is how that
 * turns into a 200 with an error in the body the moment somebody rewords the sentence.
 */
export class PipelineNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PipelineNotFoundError";
  }
}

/** A template or a step that cannot be run as written — the person can fix this one. */
export class PipelineValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PipelineValidationError";
  }
}

/**
 * Another template in the same crew already has this name.
 *
 * Its own class because it is a 409, not a 400: the plan is fine as written, it collides with one that
 * exists, and the person's fix is to rename one of the two. The database's unique index is what
 * decides it, because two saves racing each other would both pass a read-then-write check.
 */
export class PipelineNameTakenError extends Error {
  constructor() {
    super("这个小组里已经有一条同名的流程了，换个名字再保存。");
    this.name = "PipelineNameTakenError";
  }
}

/**
 * Turn the unique index's refusal into `PipelineNameTakenError`; anything else is rethrown as is.
 *
 * The state code arrives on the server's error, which drizzle wraps, and Bun reports it as `errno` —
 * the same lookup `waker-groups/store.ts` makes for a crew's name.
 */
function nameTaken(error: unknown): never {
  const violation = error as {
    errno?: unknown;
    code?: unknown;
    cause?: { errno?: unknown; code?: unknown };
  } | null;
  const states = [
    violation?.errno,
    violation?.code,
    violation?.cause?.errno,
    violation?.cause?.code,
  ];
  if (states.some((state) => String(state) === "23505")) {
    throw new PipelineNameTakenError();
  }
  throw error;
}

/**
 * The person who pressed run may not use one or more of the template's coworkers (spec I6).
 *
 * Thrown by `start` before anything is written: no quota is asked, no parent card opens and no run row
 * exists, because a plan whose middle the person cannot run is not a plan they can start. `refused`
 * names every step that stopped it, not just the first, so one answer tells the person everything they
 * have to fix — `index` is the step's position in the template (0-based), `stepId` its id and
 * `agentId` the coworker the person has no use of.
 */
export class PipelineStepForbiddenError extends Error {
  readonly refused: { index: number; stepId: string; agentId: string }[];
  constructor(refused: { index: number; stepId: string; agentId: string }[]) {
    super(
      `第 ${refused.map((step) => step.index + 1).join("、")} 步的员工（${[
        ...new Set(refused.map((step) => step.agentId)),
      ].join(
        "、",
      )}）你没有使用权，这次没有派出去。先给这些员工开通使用权，或把模板里的这几步换成你能用的员工，再运行。`,
    );
    this.name = "PipelineStepForbiddenError";
    this.refused = refused;
  }
}

/** How many steps one template may hold. A pipeline is a machine for spending turns, so the number that
 * bounds it has to live somewhere other than the person's patience. */
const MAX_STEPS = 10;
/**
 * How many steps a run may hold. A WakerFlow's compiled template may hold up to 20 (WF7 D4), and it
 * is written by the WakerFlow store, not by `createTemplate`; a crew's own templates stay at
 * {@link MAX_STEPS}, which is checked when they are written.
 */
const MAX_RUN_STEPS = WAKERFLOW_MAX_STEPS;

/**
 * Mark the steps a jump passes over as skipped by the branch (WF7): a step no taken path reached is
 * not missing work, and is recorded so the run says what it did not do and why.
 */
function passOver(records: StepRecord[], from: number, to: number) {
  for (let index = from + 1; index < to && index < records.length; index += 1) {
    const record = records[index];
    if (record && record.state === "pending")
      records[index] = { ...record, state: "skipped", skipReason: "branch" };
  }
}

/** The kinds this orchestrator runs; any other is failed closed rather than guessed at. */
const RUNNABLE_KINDS = new Set(["worker", "decision", "flow", "action"]);

/** How deep runs may nest (D10): a run at this depth may not start another. */
const MAX_NESTING = WAKERFLOW_MAX_NESTING;

/**
 * WF7 (spec §3.4): starting the child run of a `flow` step, which only the WakerFlow layer can do
 * (it holds the pinned versions and the Flow's input rules). Attached by `createWakerFlowStore`;
 * without it a `flow` step fails closed.
 */
export type NestedFlowRunner = {
  /**
   * Start the child of this parent step, or answer the one it already has. A refusal the person can
   * act on is thrown as {@link NestedFlowRefusal}, and nothing is created.
   */
  start(input: {
    tenantId: string;
    parentRunId: string;
    parentStepId: string;
    /** The parent step's card, which the child's own card is filed under. */
    parentTaskId?: string;
    targetFlowId: string;
    targetRevision: number;
    /** The child's inputs, read from the parent's inputs and outputs through `inputMap`. */
    inputs: Record<string, string>;
    initiatedBy: string;
  }): Promise<{ runId: string }>;
  /** Drive a run without holding the caller (the WakerFlow store's own `drive`). */
  drive(run: { tenantId: string; runId: string }): void;
};

/** Why a nested Flow did not start, in the person's language. */
export class NestedFlowRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NestedFlowRefusal";
  }
}

/** The value one declared key reads: the run's input, an earlier step's output, or the gap. */
function readKey(
  key: string,
  inputs: Record<string, string>,
  earlier: StepRecord[],
): string {
  return (
    inputs[key] ??
    earlier.find((step) => step.outputKey === key)?.output ??
    "（此输入未产生）"
  );
}

/**
 * What one coworker is told for one step: its role in this Flow (WF7 D2, first, so it frames the
 * rest), the step's own instruction, the task, what it reads, and which earlier steps produced
 * nothing. Pure, so the order is pinned by a test rather than by reading a template literal.
 */
export function stepInstruction(input: {
  record: StepRecord;
  task: string;
  inputs: Record<string, string>;
  /** The run's steps before this one. */
  earlier: StepRecord[];
  /** Outputs of earlier steps, in order (read when the step declares no inputs). */
  prior: string[];
  /** Ids of the earlier steps that were skipped or failed. */
  missing: string[];
}): string {
  const { record } = input;
  const role = record.rolePrompt?.trim()
    ? `本流程中你的角色：${record.rolePrompt.trim()}\n\n`
    : "";
  return `${role}${record.instruction}\n\n任务：${input.task}${
    record.inputKeys
      ? `\n\n此步骤的输入：\n${JSON.stringify(Object.fromEntries(record.inputKeys.map((key) => [key, readKey(key, input.inputs, input.earlier)])))}`
      : input.prior.length > 0
        ? `\n\n前面步骤的产出：\n${input.prior
            .map((line, index) => `${index + 1}. ${line}`)
            .join("\n")}`
        : ""
  }${
    input.missing.length > 0
      ? `\n\n注意：${input.missing.join("、")} 这几步没有产出（被跳过或已失败），下面的结论里不要假装它们发生过。`
      : ""
  }`;
}

/** `groupTaskTemplates.group_id` is a uuid, and Postgres answers a malformed one with a 22P02 that
 * reaches the person as a 500. Ask about the shape before the database does. */
function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}

/**
 * The WakerFlow that compiled this template's crew, if any (spec D10).
 *
 * A Flow's crew and templates are its compiled form, not a crew a person arranged: the generic
 * pipeline API must not list them, add steps to them, or start them behind the Flow's back.
 */
const owningFlow = () =>
  /*
   * Spelled out, not interpolated: used as a select field, drizzle writes a column without its table,
   * which turned this into `"group_id" = "group_id"` inside the subquery (the Flow's own column on both
   * sides), so any Flow of the workspace "owned" every template, a plain crew's template could not be
   * started, and of two Flows only one could run.
   */
  sql<
    string | null
  >`(select owned_flow.id from ${wakerFlows} as owned_flow where owned_flow.group_id = "group_task_templates"."group_id" limit 1)`;

type RunRow = {
  id: string;
  parentTaskId: string | null;
  parentRunRef: string | null;
  cursor: number;
  status: string;
  steps: StepRecord[];
  initiatedBy: string | null;
  instruction: string;
  revision: number;
  advanceOwner: string | null;
  inputs: Record<string, string>;
  flowId: string | null;
  /** WF7: the run and step that started this one, when it is a nested Flow's run. */
  parentRunId: string | null;
  parentStepId: string | null;
  /** What this process last wrote, so the next change is compared with it and not with the read. */
  written?: { status: string; steps: StepRecord[] };
};

/** The transaction a {@link PipelineEventWriter} is handed; its writes commit or roll back with the run's. */
export type PipelineTransaction = Parameters<
  Parameters<Database["transaction"]>[0]
>[0];

/**
 * One state change of a WakerFlow's run (WF8, spec §3.4 E-A), as `writeRun` (or `start`) made it.
 * `before` is null for the run's first row. `revision` is the run's revision after the change, so
 * one change is named once however often it is reported.
 */
export type PipelineRunTransition = {
  tenantId: string;
  runId: string;
  flowId: string;
  revision: number;
  inputs: Record<string, string>;
  before: { status: string; steps: StepRecord[] } | null;
  after: { status: string; cursor: number; steps: StepRecord[] };
};

/**
 * Records a run's state change inside the transaction that made it, so a change that lost its
 * revision race (and so did not happen) leaves nothing behind, and a record that cannot be written
 * undoes the change. Asked only for runs a WakerFlow started; a crew's own runs are not recorded.
 */
export type PipelineEventWriter = (
  tx: PipelineTransaction,
  transition: PipelineRunTransition,
) => Promise<void>;

export function createPipelineStore(options: {
  database: Database;
  board: TaskProjector;
  /**
   * Run one coworker's turn on the deployment's existing unattended channel.
   *
   * Injectable because the pipeline is the first caller that asks for a turn from outside a run, and the
   * whole point of ADR-0001's option A is that it goes through the gates rather than around them: the
   * sequence is tested here, the channel's own suites test the governance.
   */
  executeStep: PipelineStepRunner;
  /**
   * Spec I6: may THIS person use THIS coworker? Never substituted, never run as the platform.
   *
   * Asked with the run's initiator — the person who pressed run, as recorded on the run row — and not
   * with the workspace id: "who may dispatch" is a question about a person, and a workspace default is
   * how it quietly becomes "anyone in here may". Asked for every step before the run opens anything,
   * and again for each step as it is reached, because a use can be revoked while a run is in flight.
   */
  canUse: (initiatedBy: string, agentId: string) => Promise<boolean>;
  /**
   * The monthly ceiling, asked before the run opens anything (spec 022's rule: refuse before the work,
   * not after). Optional because a deployment without plans still runs pipelines.
   */
  quota?: QuotaService;
  newRunId?: () => string;
  /** WF8: the WakerFlow run-event writer (`wakerflows/store.ts` `flowRunEventWriter`). */
  events?: PipelineEventWriter;
  /**
   * WF7: how an action step's fixed MCP call is made (`pipeline/action-step.ts`, ADR-0001's
   * 2026-11-04 exception). Without it an action step fails closed.
   */
  actions?: ActionStepRunner;
}) {
  const { database, board, executeStep, canUse } = options;
  const newRunId = options.newRunId ?? (() => randomUUID());

  const selectRun = (tenantId: string, runId: string) =>
    database
      .select({
        id: groupTaskRuns.id,
        parentTaskId: groupTaskRuns.parentTaskId,
        cursor: groupTaskRuns.cursor,
        status: groupTaskRuns.status,
        steps: groupTaskRuns.steps,
        initiatedBy: groupTaskRuns.initiatedBy,
        revision: groupTaskRuns.revision,
        advanceOwner: groupTaskRuns.advanceOwner,
        inputs: groupTaskRuns.inputs,
        flowId: groupTaskRuns.flowId,
        parentRunId: groupTaskRuns.parentRunId,
        parentStepId: groupTaskRuns.parentStepId,
      })
      .from(groupTaskRuns)
      .where(
        and(eq(groupTaskRuns.tenantId, tenantId), eq(groupTaskRuns.id, runId)),
      )
      .limit(1);

  async function readRun(
    tenantId: string,
    runId: string,
  ): Promise<RunRow | null> {
    const [row] = await runAsTenant(tenantId, async () =>
      selectRun(tenantId, runId),
    );
    if (!row) return null;
    const steps = Array.isArray(row.steps) ? (row.steps as StepRecord[]) : [];
    /*
     * The task text lives on the parent card, which is where the person reads it: a second copy on the
     * run row is one more thing that can disagree with the board. The parent's run reference is the run
     * id itself (see `start`), so it needs no lookup at all.
     */
    const [card] = row.parentTaskId
      ? await runAsTenant(tenantId, async () =>
          database
            .select({ title: tasks.title })
            .from(tasks)
            .where(eq(tasks.id, row.parentTaskId as string))
            .limit(1),
        )
      : [];
    return {
      id: row.id,
      parentTaskId: row.parentTaskId ?? null,
      parentRunRef: row.parentTaskId ? row.id : null,
      cursor: row.cursor,
      status: row.status,
      steps,
      initiatedBy: row.initiatedBy ?? null,
      instruction: card?.title ?? "",
      revision: row.revision,
      advanceOwner: row.advanceOwner,
      inputs: row.inputs,
      flowId: row.flowId ?? null,
      parentRunId: row.parentRunId ?? null,
      parentStepId: row.parentStepId ?? null,
    };
  }

  async function writeRun(
    tenantId: string,
    runId: string,
    patch: Partial<{
      cursor: number;
      status: string;
      steps: StepRecord[];
    }>,
    expected: RunRow,
    owner?: string,
  ) {
    const before = {
      status: expected.status,
      steps: expected.written?.steps ?? expected.steps,
    };
    const update = (db: Database | PipelineTransaction) =>
      db
        .update(groupTaskRuns)
        .set({
          ...patch,
          ...(owner ? {} : { advanceOwner: null }),
          revision: sql`${groupTaskRuns.revision} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(groupTaskRuns.tenantId, tenantId),
            eq(groupTaskRuns.id, runId),
            eq(groupTaskRuns.revision, expected.revision),
            sql`${groupTaskRuns.status} not in ('done', 'failed', 'aborted')`,
            ...(owner ? [eq(groupTaskRuns.advanceOwner, owner)] : []),
          ),
        )
        .returning({ revision: groupTaskRuns.revision });
    const { events } = options;
    const flowId = expected.flowId;
    const changes = patch.status !== undefined || patch.steps !== undefined;
    const [updated] = await runAsTenant(tenantId, async () => {
      // WF8: a WakerFlow run's change and its record commit together, or neither does.
      if (!events || !flowId || !changes) return await update(database);
      return await database.transaction(async (tx) => {
        const rows = await update(tx);
        const [row] = rows;
        if (row)
          await events(tx, {
            tenantId,
            runId,
            flowId,
            revision: row.revision,
            inputs: expected.inputs,
            before,
            after: {
              status: patch.status ?? before.status,
              cursor: patch.cursor ?? expected.cursor,
              steps: patch.steps ?? before.steps,
            },
          });
        return rows;
      });
    });
    if (!updated) return false;
    expected.revision = updated.revision;
    if (patch.status !== undefined) expected.status = patch.status;
    expected.written = {
      status: expected.status,
      steps: [...(patch.steps ?? before.steps)],
    };
    // WF7: a nested Flow's run that has just ended hands its outcome to the step waiting on it.
    if (
      expected.parentRunId &&
      patch.status !== undefined &&
      ["done", "failed", "aborted"].includes(patch.status)
    )
      await settleChild(tenantId, runId).catch((error: unknown) =>
        console.error(
          JSON.stringify({
            type: "nested-flow-settle-failed",
            runId,
            reason: error instanceof Error ? error.message : String(error),
          }),
        ),
      );
    return true;
  }

  let nested: NestedFlowRunner | undefined;

  /** How deep this run sits: 1 for a run nobody started, 2 for its child, and so on. */
  async function depthOf(tenantId: string, run: RunRow): Promise<number> {
    let depth = 1;
    let parent = run.parentRunId;
    while (parent && depth <= MAX_NESTING) {
      const [row] = await runAsTenant(tenantId, async () =>
        database
          .select({ parentRunId: groupTaskRuns.parentRunId })
          .from(groupTaskRuns)
          .where(
            and(
              eq(groupTaskRuns.tenantId, tenantId),
              eq(groupTaskRuns.id, parent as string),
            ),
          )
          .limit(1),
      );
      depth += 1;
      parent = row?.parentRunId ?? null;
    }
    return depth;
  }

  /**
   * WF7 (spec §3.4 step 3): if this run is a child that has ended, and its parent is still parked on
   * the step that started it, give that step the child's outcome and carry the parent on. `done`
   * answers with the child's `resultKey` output (or its last finished step's); `failed` or `aborted`
   * fails the parent step. Conditional on the parent's park, so a second delivery (the sweep after a
   * restart, a replay) finds nothing to do and answers false.
   */
  async function settleChild(tenantId: string, childRunId: string) {
    const child = await readRun(tenantId, childRunId);
    if (!child?.parentRunId || !child.parentStepId) return false;
    if (!["done", "failed", "aborted"].includes(child.status)) return false;
    const parent = await readRun(tenantId, child.parentRunId);
    if (!parent) return false;
    const parked = parent.steps[parent.cursor];
    if (
      parent.status !== "awaiting_action" ||
      parked?.id !== child.parentStepId ||
      parked.childRunId !== childRunId
    )
      return false;
    const name = parked.instruction;
    let outcome: { output: string } | { error: string };
    if (child.status === "done") {
      const finished = child.steps.filter(
        (step) =>
          step.state === "done" &&
          step.kind !== "decision" &&
          typeof step.output === "string",
      );
      const result = parked.resultKey
        ? finished.find((step) => step.outputKey === parked.resultKey)
        : finished[finished.length - 1];
      outcome =
        typeof result?.output === "string"
          ? { output: result.output }
          : {
              error: parked.resultKey
                ? `${name}已完成，但没有产出 ${parked.resultKey}。`
                : `${name}已完成，但没有任何产出。`,
            };
    } else if (child.status === "aborted") {
      outcome = { error: `${name}已被中止，这一步没有结果。` };
    } else {
      const failed = child.steps.find((step) => step.state === "failed");
      outcome = {
        error: `${name}运行失败${
          failed
            ? `（第 ${child.steps.indexOf(failed) + 1} 步 ${failed.id}${failed.error ? `：${failed.error.split("\n")[0]}` : ""}）`
            : ""
        }。`,
      };
    }
    const resumed = await store.resume({
      tenantId,
      runId: parent.id,
      ...outcome,
      drive: false,
      parked: { stepId: parked.id, childRunId },
    });
    if (resumed.status === "running") {
      if (nested) nested.drive({ tenantId, runId: parent.id });
      else void store.advance({ tenantId, runId: parent.id }).catch(() => {});
    }
    return true;
  }

  const outcome = (run: RunRow): RunOutcome => ({
    status: run.status as RunOutcome["status"],
    cursor: run.cursor,
    steps: run.steps,
  });
  const terminal = (run: RunRow) =>
    ["done", "failed", "aborted"].includes(run.status);
  async function currentOutcome(tenantId: string, runId: string) {
    const run = await readRun(tenantId, runId);
    if (!run) throw new PipelineNotFoundError("这个工作区里没有这次运行。");
    return outcome(run);
  }

  async function closeCard(
    tenantId: string,
    runRef: string,
    failed: boolean,
    pipelineRunId?: string,
  ) {
    if (!runRef) return;
    await board
      .finished({
        tenantId,
        runRef,
        failed,
        ...(pipelineRunId ? { pipelineRunId } : {}),
      })
      .catch(() => undefined);
  }

  /** The card the whole run hangs under: done with the crew's work, or failed with it. */
  async function closeParent(run: RunRow, tenantId: string, failed: boolean) {
    if (run.parentRunRef)
      await closeCard(
        tenantId,
        run.parentRunRef,
        failed,
        failed ? undefined : run.id,
      );
  }

  /**
   * Whether a template may be saved as written, for a create and an edit alike — one set of rules,
   * because an edit that skipped one of them would be the way around it. Answers the name to store.
   */
  async function validateTemplate(input: {
    tenantId: string;
    groupId: string;
    name: string;
    steps: PipelineStep[];
  }): Promise<string> {
    if (input.steps.length === 0) {
      throw new PipelineValidationError("没有步骤的流水线跑不了任何东西。");
    }
    if (input.steps.length > MAX_STEPS) {
      throw new PipelineValidationError(
        `一条流水线最多 ${MAX_STEPS} 步，这条写了 ${input.steps.length} 步。`,
      );
    }
    for (const step of input.steps) {
      if (!step.id || !step.agentId || !step.instruction.trim()) {
        throw new PipelineValidationError(
          "每一步都要有编号、一位员工，和它要做的事。",
        );
      }
    }
    if (
      new Set(input.steps.map((step) => step.id)).size !== input.steps.length
    ) {
      throw new PipelineValidationError(
        "两个步骤用了同一个编号，跳过和恢复就分不清是哪一步了。",
      );
    }
    const name = input.name.trim();
    if (!name) {
      throw new PipelineValidationError("给这条流程起个名字。");
    }
    if (!isUuid(input.groupId)) {
      throw new PipelineValidationError(
        "流程要写给一个小组，得先从「员工 › 小组」里挑一个。",
      );
    }
    const [flowOwned] = await runAsTenant(input.tenantId, async () =>
      database
        .select({ id: wakerFlows.id })
        .from(wakerFlows)
        .where(eq(wakerFlows.groupId, input.groupId))
        .limit(1),
    );
    if (flowOwned) {
      throw new PipelineValidationError(
        "这个小组属于 WakerFlow 内部，只能在 WakerFlow 里编辑它的流程。",
      );
    }
    /*
     * Every step goes to somebody IN this crew — the promise the pipeline screen makes in its own
     * description, so it is checked here rather than left to the picker. Reading the roster under the
     * caller's tenant scope means a crew that is not theirs comes back empty, which is the same answer
     * as a crew with no members and the right one for both.
     */
    const roster = await runAsTenant(input.tenantId, async () =>
      database
        .select({ agentId: wakerGroupMembers.agentId })
        .from(wakerGroupMembers)
        .where(eq(wakerGroupMembers.groupId, input.groupId)),
    );
    if (roster.length === 0) {
      throw new PipelineValidationError(
        "这个小组里还没有员工。先到「员工 › 小组」把人加进去，再来排流程。",
      );
    }
    if (
      input.steps.some(
        (step) => !roster.some((row) => row.agentId === step.agentId),
      )
    ) {
      throw new PipelineValidationError(
        "流程里有步骤交给了组外的员工。每一步的员工都得在这个小组里。",
      );
    }
    return name;
  }

  /**
   * One template of this workspace, or null — a malformed id is "not here", not a cast error. A
   * WakerFlow's compiled template is not here either (spec D10): it is edited only through its Flow.
   */
  async function readTemplate(tenantId: string, templateId: string) {
    if (!isUuid(templateId)) return null;
    const [row] = await runAsTenant(tenantId, async () =>
      database
        .select({
          id: groupTaskTemplates.id,
          groupId: groupTaskTemplates.groupId,
        })
        .from(groupTaskTemplates)
        .where(
          and(
            eq(groupTaskTemplates.tenantId, tenantId),
            eq(groupTaskTemplates.id, templateId),
            isNull(owningFlow()),
          ),
        )
        .limit(1),
    );
    return row ?? null;
  }

  /*
   * Named rather than returned inline, because `resume` has to reach the same driving loop `advance`
   * is — and a resumed crew is exactly the case where two copies of that loop would drift into running
   * one step twice.
   */
  const store = {
    async createTemplate(input: {
      tenantId: string;
      groupId: string;
      name: string;
      steps: PipelineStep[];
      createdBy?: string;
    }): Promise<string> {
      const name = await validateTemplate(input);
      const [row] = await runAsTenant(input.tenantId, async () =>
        database
          .insert(groupTaskTemplates)
          .values({
            tenantId: input.tenantId,
            groupId: input.groupId,
            name,
            steps: input.steps,
            createdBy: input.createdBy ?? null,
          })
          .returning({ id: groupTaskTemplates.id }),
      ).catch(nameTaken);
      // biome-ignore lint/style/noNonNullAssertion: an INSERT with RETURNING answers with the row it wrote
      return row!.id;
    },

    /**
     * Rewrite a template's name and steps (spec I1: the plan is the person's to change).
     *
     * The crew is NOT editable: it is read from the stored row, never from the request, because a
     * template's steps were validated against that crew's roster and moving it would be a second way to
     * hand a step to somebody outside it. The same checks `createTemplate` makes are made here, against
     * the same crew, so an edit cannot save a plan a create would have refused.
     *
     * Runs already started are untouched by design: each one snapshotted its steps when it started
     * (`start`), so a person who reworded step 2 has changed the next press, not last hour's work. And
     * the edit grants nothing — whoever presses run next is asked spec I6's question about every step of
     * the edited plan at `start`, and again per step as the run reaches it.
     */
    async updateTemplate(input: {
      tenantId: string;
      templateId: string;
      name: string;
      steps: PipelineStep[];
    }): Promise<void> {
      const current = await readTemplate(input.tenantId, input.templateId);
      if (!current) {
        throw new PipelineNotFoundError("这个工作区里没有这条模板。");
      }
      const name = await validateTemplate({
        tenantId: input.tenantId,
        groupId: current.groupId,
        name: input.name,
        steps: input.steps,
      });
      const [row] = await runAsTenant(input.tenantId, async () =>
        database
          .update(groupTaskTemplates)
          .set({ name, steps: input.steps, updatedAt: new Date() })
          .where(
            and(
              eq(groupTaskTemplates.tenantId, input.tenantId),
              eq(groupTaskTemplates.id, input.templateId),
            ),
          )
          .returning({ id: groupTaskTemplates.id }),
      ).catch(nameTaken);
      // Deleted between the read and the write: the same answer as never having been here.
      if (!row) throw new PipelineNotFoundError("这个工作区里没有这条模板。");
    },

    /**
     * Throw a template away. The runs it started are kept, and one still in flight keeps going.
     *
     * Nothing here touches `group_task_runs`: the column is `ON DELETE SET NULL` (migration 0076), and
     * a run never reads its template after `start` — it advances from the steps it snapshotted. So a
     * delete in the middle of a run only forgets which recipe the run came from, which is the point of
     * tidying a recipe away.
     */
    async deleteTemplate(input: {
      tenantId: string;
      templateId: string;
    }): Promise<void> {
      if (!isUuid(input.templateId)) {
        throw new PipelineNotFoundError("这个工作区里没有这条模板。");
      }
      const [row] = await runAsTenant(input.tenantId, async () =>
        database
          .delete(groupTaskTemplates)
          .where(
            and(
              eq(groupTaskTemplates.tenantId, input.tenantId),
              eq(groupTaskTemplates.id, input.templateId),
              // A WakerFlow's compiled template goes away with its Flow, never on its own (spec D10).
              isNull(owningFlow()),
            ),
          )
          .returning({ id: groupTaskTemplates.id }),
      );
      if (!row) throw new PipelineNotFoundError("这个工作区里没有这条模板。");
    },

    /**
     * The templates this workspace can run, newest first.
     *
     * Read per group because the crew page is where a person picks one: "编程小组 有三个流程" is the
     * question, and a deployment-wide list would answer a different one.
     */
    async listTemplates(input: { tenantId: string; groupId?: string }): Promise<
      {
        id: string;
        groupId: string;
        name: string;
        steps: PipelineStep[];
        createdAt: Date;
      }[]
    > {
      return runAsTenant(input.tenantId, async () =>
        database
          .select({
            id: groupTaskTemplates.id,
            groupId: groupTaskTemplates.groupId,
            name: groupTaskTemplates.name,
            steps: groupTaskTemplates.steps,
            createdAt: groupTaskTemplates.createdAt,
          })
          .from(groupTaskTemplates)
          .where(
            and(
              eq(groupTaskTemplates.tenantId, input.tenantId),
              input.groupId
                ? eq(groupTaskTemplates.groupId, input.groupId)
                : undefined,
              isNull(owningFlow()),
            ),
          )
          .orderBy(desc(groupTaskTemplates.createdAt)),
      );
    },

    /**
     * Put a task in front of the crew and get the card that owns it.
     *
     * Every step's coworker is checked against the person who pressed run before anything is written
     * (spec I6): a refusal is answered to that person right away, as `PipelineStepForbiddenError`
     * naming the steps, rather than as a card that opens and fails — the answer is not silent, it is
     * the response to the press. Once the check passes, the parent card opens before any step runs, so
     * a coworker revoked mid-run still leaves the run's failure on the board (the silent-failure shape
     * ticket 030 closed for chat).
     */
    async start(input: {
      tenantId: string;
      templateId: string;
      task: string;
      initiatedBy: string;
      inputs?: Record<string, string>;
      flowId?: string;
      runId?: string;
      /**
       * WF8 retry: the steps before `cursor` start as these records (each `done` or `skipped`, with
       * the output it already produced) and are never run again; the run starts at `cursor`. Only
       * the steps from there on are asked about (I6) and counted against the month.
       */
      seed?: {
        cursor: number;
        records: Pick<
          StepRecord,
          "state" | "output" | "skipReason" | "branch"
        >[];
      };
      /**
       * Written in the same transaction as the run's first row, so whatever it records exists exactly
       * when the run does (the retry ledger, whose row names this run).
       */
      register?: (tx: PipelineTransaction, runId: string) => Promise<void>;
      /**
       * WF7: this run is the child of a parent run's `flow` step. Its card is filed under that step's
       * card when one is given, and the parent finds it again through the run row.
       */
      parent?: { runId: string; stepId: string; taskId?: string };
    }): Promise<{ runId: string; parentTaskId: string }> {
      // A malformed id is "not here" (spec D15), the same answer edit and delete give, not a cast error.
      if (!isUuid(input.templateId)) {
        throw new PipelineNotFoundError("这个工作区里没有这条模板。");
      }
      const template = await runAsTenant(input.tenantId, async () => {
        const [row] = await database
          .select({
            steps: groupTaskTemplates.steps,
            groupId: groupTaskTemplates.groupId,
            flowId: owningFlow(),
          })
          .from(groupTaskTemplates)
          .where(
            and(
              eq(groupTaskTemplates.tenantId, input.tenantId),
              eq(groupTaskTemplates.id, input.templateId),
            ),
          )
          .limit(1);
        return row ?? null;
      });
      // A Flow's template runs only as that Flow's run; to everyone else it is not here.
      if (!template || (template.flowId && template.flowId !== input.flowId)) {
        throw new PipelineNotFoundError("这个工作区里没有这条模板。");
      }
      const declared = Array.isArray(template.steps)
        ? (template.steps as PipelineStep[])
        : [];
      if (declared.length > MAX_RUN_STEPS) {
        throw new PipelineValidationError(
          `一条流水线最多 ${MAX_RUN_STEPS} 步，这条有 ${declared.length} 步。`,
        );
      }
      /*
       * Spec I6, asked for the whole plan before any of it is dispatched: may the person who pressed run
       * use EVERY coworker the template names? Being in the crew grants nothing. A refusal here writes
       * nothing at all — no quota spent, no parent card, no run row — and names every step that stopped
       * it, because a run that opened and then failed on step 2 would have run step 1 for a plan the
       * person could never finish. A check that errors counts as a refusal: failing open is how a
       * flaky lookup becomes "the platform ran it anyway".
       */
      const seed = input.seed;
      if (
        seed &&
        (!Number.isInteger(seed.cursor) ||
          seed.cursor < 0 ||
          seed.cursor >= declared.length ||
          seed.records.length !== seed.cursor ||
          seed.records.some(
            (record) => record.state !== "done" && record.state !== "skipped",
          ))
      ) {
        throw new PipelineValidationError("重试的起点与这条流程的步骤对不上。");
      }
      const from = seed?.cursor ?? 0;
      // WF7 D4: what can still open a card, over the longest path; a decision opens none.
      const remaining = stepBudget(declared, from);
      const refused: { index: number; stepId: string; agentId: string }[] = [];
      for (const [index, step] of declared.entries()) {
        // Steps a retry carries over already ran; only what will run is asked about.
        if (index < from) continue;
        // A decision runs as nobody: the orchestrator evaluates it, no coworker is asked. A nested
        // Flow's own steps are asked when its child run starts, by that run's own `start`.
        if (step.kind === "decision" || step.kind === "flow") continue;
        const allowed = await canUse(input.initiatedBy, step.agentId).catch(
          () => false,
        );
        if (!allowed) {
          refused.push({ index, stepId: step.id, agentId: step.agentId });
        }
      }
      if (refused.length > 0) throw new PipelineStepForbiddenError(refused);
      /*
       * The ceiling is asked before anything is opened or run, because a pipeline is a machine for
       * spending: one press starts N turns. A refusal after the first card would charge for work that
       * happened (ticket 022's rule, restated in `tasks/projector.ts`), and a template of a hundred
       * steps is a hundred cards a month nobody agreed to.
       */
      await options.quota?.assertCapacity(input.tenantId, "tasksPerMonth");
      await options.quota?.assertCapacity(
        input.tenantId,
        "tasksPerMonth",
        remaining + 1,
      );
      /*
       * The run id IS the parent card's run reference. The parent stands for this run rather than for
       * any turn, so borrowing one of the steps' ids would be wrong and minting a second one makes
       * "is this run already on the board" a question with two answers -- the design doc's phrasing, and
       * the reason a re-run of the same id cannot open a second parent card.
       */
      const runId = input.runId ?? newRunId();
      const parentTaskId = await board.opened({
        tenantId: input.tenantId,
        title: input.task,
        // No executor on the parent, on purpose. Each step's card names its own coworker, and the
        // ask above them belongs to the group as a whole — which is not a coworker. The group's id
        // used to go in this column, and the board then drew that uuid as an employee's name and
        // filtered the card out of every `executors=` view.
        source: "group_run",
        runRef: runId,
        quotaUnits: remaining + 1,
        ...(input.parent?.taskId ? { parentTaskId: input.parent.taskId } : {}),
      });

      const steps = declared.map<StepRecord>((step, index) => {
        const carried = seed?.records[index];
        return carried
          ? {
              ...step,
              state: carried.state,
              ...(carried.output === undefined
                ? {}
                : { output: carried.output }),
              ...(carried.skipReason === undefined
                ? {}
                : { skipReason: carried.skipReason }),
              ...(carried.branch === undefined
                ? {}
                : { branch: carried.branch }),
            }
          : { ...step, state: "pending" };
      });
      const row = {
        id: runId,
        tenantId: input.tenantId,
        templateId: input.templateId,
        groupId: template.groupId,
        parentTaskId,
        status: "running",
        cursor: from,
        steps,
        initiatedBy: input.initiatedBy,
        inputs: input.inputs ?? {},
        flowId: input.flowId ?? null,
        parentRunId: input.parent?.runId ?? null,
        parentStepId: input.parent?.stepId ?? null,
      };
      const { events } = options;
      const flowId = input.flowId;
      const { register } = input;
      await runAsTenant(input.tenantId, async () => {
        if ((!events || !flowId) && !register) {
          await database.insert(groupTaskRuns).values(row);
          return;
        }
        // WF8: the run's first row, its `run_started` and whatever `register` records commit together.
        await database.transaction(async (tx) => {
          const [inserted] = await tx
            .insert(groupTaskRuns)
            .values(row)
            .returning({ revision: groupTaskRuns.revision });
          if (events && flowId)
            await events(tx, {
              tenantId: input.tenantId,
              runId,
              flowId,
              revision: inserted?.revision ?? 0,
              inputs: row.inputs,
              before: null,
              after: { status: "running", cursor: from, steps },
            });
          await register?.(tx, runId);
        });
      });
      return { runId, parentTaskId };
    },

    /**
     * Run steps from the cursor until the run stops, and report where it stopped.
     *
     * One step's failure ends the run rather than being stepped over: a review of a deliverable that
     * was never produced is worse than no review, and every later instruction was written against the
     * output the failed step did not give it. Skipping is a separate, deliberate act (spec I4).
     */
    async advance(input: {
      tenantId: string;
      runId: string;
    }): Promise<RunOutcome> {
      const run = await readRun(input.tenantId, input.runId);
      if (!run) throw new PipelineNotFoundError("这个工作区里没有这次运行。");
      const records = [...run.steps];
      /*
       * A run that has stopped stays stopped. `advance` is called by whoever holds the request or the
       * resume, and two arriving for one run must not produce two sets of step cards or close a reviewed
       * parent a second time. The terminal check handles later retries; the database claim below
       * handles competing drivers while execution is still in flight.
       */
      if (
        run.status === "done" ||
        run.status === "failed" ||
        run.status === "aborted"
      ) {
        return {
          status: run.status as RunOutcome["status"],
          cursor: run.cursor,
          steps: records,
        };
      }
      let cursor = run.cursor;
      /*
       * Whose authority each step runs under: the person recorded on the run row when it started, never
       * the workspace or the caller of this method. A run with no initiator on record cannot answer
       * spec I6's question, so its next step is refused rather than run on somebody's default.
       */
      const initiator = run.initiatedBy;
      /*
       * A run parked on a person stays parked until that person's answer is delivered.
       *
       * `advance` is not the door for it: the step that stopped is in the middle of a turn the approval
       * machinery is resuming, so driving it again from here would ask the coworker a second time — a
       * second model spend, a second card answer, and a duplicate of anything the first turn already
       * wrote to the world. `resume` is the door, and it carries what that resumed turn produced.
       */
      if (run.status === "awaiting_action") {
        return {
          status: "awaiting_action",
          cursor: run.cursor,
          steps: records,
        };
      }
      const owner = randomUUID();
      const [claimed] = await runAsTenant(input.tenantId, async () =>
        database
          .update(groupTaskRuns)
          .set({
            advanceOwner: owner,
            revision: sql`${groupTaskRuns.revision} + 1`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(groupTaskRuns.tenantId, input.tenantId),
              eq(groupTaskRuns.id, input.runId),
              eq(groupTaskRuns.status, "running"),
              eq(groupTaskRuns.revision, run.revision),
              isNull(groupTaskRuns.advanceOwner),
            ),
          )
          .returning({ revision: groupTaskRuns.revision }),
      );
      if (!claimed) return currentOutcome(input.tenantId, input.runId);
      run.revision = claimed.revision;
      const controller = new AbortController();
      let lastHeartbeatAt = Date.now();
      let releaseOwner = true;
      let heartbeatWork: Promise<unknown> | undefined;
      const heartbeat = setInterval(() => {
        if (heartbeatWork) return;
        heartbeatWork = runAsTenant(input.tenantId, async () => {
          const [current] = await database
            .select({
              owner: groupTaskRuns.advanceOwner,
              status: groupTaskRuns.status,
            })
            .from(groupTaskRuns)
            .where(
              and(
                eq(groupTaskRuns.tenantId, input.tenantId),
                eq(groupTaskRuns.id, input.runId),
              ),
            )
            .limit(1);
          if (
            !current ||
            current.owner !== owner ||
            current.status !== "running"
          ) {
            controller.abort();
            return;
          }
          if (Date.now() - lastHeartbeatAt < 30_000) return;
          lastHeartbeatAt = Date.now();
          await database
            .update(groupTaskRuns)
            .set({ updatedAt: new Date() })
            .where(
              and(
                eq(groupTaskRuns.tenantId, input.tenantId),
                eq(groupTaskRuns.id, input.runId),
                eq(groupTaskRuns.advanceOwner, owner),
                eq(groupTaskRuns.status, "running"),
              ),
            );
        })
          .catch(() => undefined)
          .finally(() => {
            heartbeatWork = undefined;
          });
      }, 500);
      try {
        const prior: string[] = records
          .map((record) => record.output)
          .filter((output): output is string => typeof output === "string");
        /*
         * Which steps did not produce what they were asked to. A later instruction has to say so rather
         * than omit the gap: a summary that quietly ignores a skipped review will report on a deliverable
         * nobody reviewed, and the person reading it has no way to tell (spec I4's skip is a deliberate
         * act, not an erasure).
         */
        const missing = records
          .filter(
            (record) =>
              // WF7: a step no taken branch reached is not missing work (spec §3.3).
              (record.state === "skipped" && record.skipReason !== "branch") ||
              record.state === "failed",
          )
          .map((record) => record.id);

        while (cursor < records.length) {
          // A control request may have won while the previous card projection was settling.
          if (!(await writeRun(input.tenantId, input.runId, {}, run, owner))) {
            return currentOutcome(input.tenantId, input.runId);
          }
          // biome-ignore lint/style/noNonNullAssertion: the loop condition is this array's own length
          const record = records[cursor]!;
          // A step a person skipped ahead of time is passed over, along its own route.
          if (record.state === "skipped") {
            const to = routeAfter(records, cursor);
            passOver(records, cursor, to);
            cursor = to;
            continue;
          }
          const kind = record.kind ?? "worker";
          if (!RUNNABLE_KINDS.has(kind)) {
            // Save refuses a kind this orchestrator cannot run; a template that holds one anyway
            // fails here, closed, rather than being handed to a coworker as if it were a turn.
            records[cursor] = {
              ...record,
              state: "failed",
              error: `第 ${cursor + 1} 步是暂时还不能运行的步骤类型，没有执行。`,
            };
            if (
              !(await writeRun(
                input.tenantId,
                input.runId,
                { cursor, status: "failed", steps: records },
                run,
                owner,
              ))
            )
              return currentOutcome(input.tenantId, input.runId);
            await closeParent(run, input.tenantId, true);
            return { status: "failed", cursor, steps: records };
          }
          if (kind === "decision") {
            /*
             * WF7 (spec §3.3): a condition is the orchestrator's, not a coworker's. No card, no turn,
             * no model, no I6 question: nobody is dispatched. An expression that cannot be evaluated
             * fails the step and the run (fail closed), never falls through to `otherwise`.
             */
            const decided = decide(
              record,
              run.inputs,
              records.slice(0, cursor),
            );
            if (!decided.ok) {
              records[cursor] = {
                ...record,
                state: "failed",
                error: decided.error,
              };
              if (
                !(await writeRun(
                  input.tenantId,
                  input.runId,
                  { cursor, status: "failed", steps: records },
                  run,
                  owner,
                ))
              )
                return currentOutcome(input.tenantId, input.runId);
              await closeParent(run, input.tenantId, true);
              return { status: "failed", cursor, steps: records };
            }
            records[cursor] = {
              ...record,
              state: "done",
              branch: { label: decided.label, index: decided.index },
            };
            const to = routeAfter(records, cursor, decided.next);
            passOver(records, cursor, to);
            cursor = to;
            if (
              !(await writeRun(
                input.tenantId,
                input.runId,
                {
                  cursor,
                  steps: records,
                  status: cursor >= records.length ? "done" : "running",
                },
                run,
                owner,
              ))
            )
              return currentOutcome(input.tenantId, input.runId);
            continue;
          }
          if (kind === "flow") {
            /*
             * WF7 (spec §3.4): another Flow's run, started as the person who started this one, at the
             * revision pinned on Save. This step parks (no approval row) holding the child's id, and
             * the child hands its outcome back when it ends (`settleChild`).
             */
            const failStep = async (error: string, runRef?: string) => {
              records[cursor] = {
                // biome-ignore lint/style/noNonNullAssertion: the loop condition is this array's own length
                ...records[cursor]!,
                state: "failed",
                error,
              };
              if (
                !(await writeRun(
                  input.tenantId,
                  input.runId,
                  { cursor, status: "failed", steps: records },
                  run,
                  owner,
                ))
              )
                return currentOutcome(input.tenantId, input.runId);
              if (runRef) await closeCard(input.tenantId, runRef, true);
              await closeParent(run, input.tenantId, true);
              return { status: "failed" as const, cursor, steps: records };
            };
            // `return await`, not `return`: the `finally` below releases the claim, and must not run
            // before the failure is written under it.
            const depth = await depthOf(input.tenantId, run);
            if (!nested || initiator === null)
              return await failStep(
                !nested
                  ? `第 ${cursor + 1} 步是子流程，但这里不能运行子流程，没有执行。`
                  : `这次运行没有记录发起人，第 ${cursor + 1} 步的子流程没有启动。`,
              );
            if (depth >= MAX_NESTING)
              return await failStep(
                `子流程最多嵌套 ${MAX_NESTING} 层；第 ${cursor + 1} 步会嵌套到第 ${depth + 1} 层，没有执行。`,
              );
            const runRef = record.runRef ?? newRunId();
            const taskId =
              record.taskId ??
              (await board.opened({
                tenantId: input.tenantId,
                title: record.instruction,
                source: "group_run",
                runRef,
                parentTaskId: run.parentTaskId ?? undefined,
              }));
            records[cursor] = { ...record, state: "running", runRef, taskId };
            if (
              !(await writeRun(
                input.tenantId,
                input.runId,
                { cursor, status: "running", steps: records },
                run,
                owner,
              ))
            ) {
              await closeCard(input.tenantId, runRef, true);
              return currentOutcome(input.tenantId, input.runId);
            }
            const earlier = records.slice(0, cursor);
            const childInputs: Record<string, string> = {};
            for (const [name, key] of Object.entries(record.inputMap ?? {})) {
              const value =
                run.inputs[key] ??
                earlier.find((step) => step.outputKey === key)?.output;
              if (value !== undefined) childInputs[name] = value;
            }
            let child: { runId: string };
            try {
              child = await nested.start({
                tenantId: input.tenantId,
                parentRunId: input.runId,
                parentStepId: record.id,
                parentTaskId: taskId,
                targetFlowId: record.targetFlowId ?? "",
                targetRevision: record.targetRevision ?? 0,
                inputs: childInputs,
                initiatedBy: initiator,
              });
            } catch (error) {
              return await failStep(
                error instanceof NestedFlowRefusal
                  ? error.message
                  : `${record.instruction}没有启动：${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
                runRef,
              );
            }
            records[cursor] = {
              // biome-ignore lint/style/noNonNullAssertion: the loop condition is this array's own length
              ...records[cursor]!,
              state: "awaiting_action",
              childRunId: child.runId,
            };
            if (
              !(await writeRun(
                input.tenantId,
                input.runId,
                { cursor, status: "awaiting_action", steps: records },
                run,
                owner,
              ))
            )
              return currentOutcome(input.tenantId, input.runId);
            // A child that already ended (this step driven again) answers now; otherwise it is driven.
            if (!(await settleChild(input.tenantId, child.runId)))
              nested.drive({ tenantId: input.tenantId, runId: child.runId });
            return currentOutcome(input.tenantId, input.runId);
          }
          const allowed =
            initiator !== null &&
            (await canUse(initiator, record.agentId).catch(() => false));
          if (initiator === null || !allowed) {
            /*
             * Spec I6, and the shape of the answer is the point: the run stops naming the coworker it
             * stopped on. Choosing another member of the crew, or running as the deployment's own Bot, is
             * how "this person may not use this coworker" quietly becomes "the platform ran it anyway" —
             * the boundary D11 was drawn to hold.
             */
            records[cursor] = {
              ...record,
              state: "failed",
              /*
               * In the person's language, and naming the coworker it stopped on.
               *
               * This sentence is stored on the step and read on the run's own view, so it is content
               * rather than protocol. The id stays because the person's next action is to go grant that
               * one coworker — "无权限" alone would be a dead end.
               */
              error:
                initiator === null
                  ? `这次运行没有记录发起人，无法核对谁能用 ${record.agentId}，所以第 ${cursor + 1} 步没有执行。`
                  : `${record.agentId} 你没有使用权，所以第 ${cursor + 1} 步没有执行。`,
            };
            if (
              !(await writeRun(
                input.tenantId,
                input.runId,
                {
                  cursor,
                  status: "failed",
                  steps: records,
                },
                run,
                owner,
              ))
            ) {
              return currentOutcome(input.tenantId, input.runId);
            }
            await closeParent(run, input.tenantId, true);
            return { status: "failed", cursor, steps: records };
          }

          /*
           * A step that parked keeps its card, because the resume is the SAME turn finishing, not a new
           * one: the channel replays the approved action inside the run that asked (that is what
           * `approval.resume` does), so minting a second run reference here would leave the first card on
           * the board still asking a question that has been answered, next to a twin doing the work.
           */
          const runRef = record.runRef ?? newRunId();
          const taskId =
            record.taskId ??
            (await board.opened({
              tenantId: input.tenantId,
              title: record.instruction,
              executorAgentId: record.agentId,
              source: "group_run",
              runRef,
              parentTaskId: run.parentTaskId ?? undefined,
            }));
          records[cursor] = {
            ...record,
            state: "running",
            runRef,
            taskId,
            // The park is over — whether the person approved or the queue is simply driving the step again.
            // Leaving it would make the run claim to be waiting on a decision that has been made.
            approvalId: undefined,
            question: undefined,
          };
          if (
            !(await writeRun(
              input.tenantId,
              input.runId,
              {
                cursor,
                status: "running",
                steps: records,
              },
              run,
              owner,
            ))
          ) {
            // Abort can win while the card is opening. Close that late card and never invoke the step.
            await closeCard(input.tenantId, runRef, true);
            return currentOutcome(input.tenantId, input.runId);
          }

          const earlier = records.slice(0, cursor);
          /*
           * ADR-0001 = A: a worker step is a coworker's turn, and only `executeStep` (the unattended
           * turn channel) runs it. An action step (WF7, the ADR's 2026-11-04 exception) is a fixed
           * MCP call through `actions`, which passes the same gates and never opens a turn.
           */
          const { actions } = options;
          const result =
            kind === "action"
              ? actions
                ? // In the run's own tenant frame: the grant, the policy and the approval gate are
                  // the run's initiator's, read under row security as a turn reads them.
                  await runAsTenant(input.tenantId, () =>
                    actions({
                      tenantId: input.tenantId,
                      runId: input.runId,
                      stepRunRef: runRef,
                      stepId: record.id,
                      agentId: record.agentId,
                      tool: record.tool ?? "",
                      args: record.args ?? {},
                      values: Object.fromEntries(
                        (record.inputKeys ?? []).map((key) => [
                          key,
                          run.inputs[key] ??
                            earlier.find((step) => step.outputKey === key)
                              ?.output,
                        ]),
                      ),
                      initiatedBy: initiator,
                    }),
                  )
                : {
                    status: "failed" as const,
                    error: `第 ${cursor + 1} 步是动作，但这里不能运行动作，没有执行。`,
                  }
              : await executeStep({
                  tenantId: input.tenantId,
                  agentId: record.agentId,
                  instruction: stepInstruction({
                    record,
                    task: run.instruction,
                    inputs: run.inputs,
                    earlier,
                    prior,
                    missing,
                  }),
                  prior: record.inputKeys
                    ? record.inputKeys.map((key) =>
                        readKey(key, run.inputs, earlier),
                      )
                    : prior,
                  initiatedBy: initiator,
                  runId: input.runId,
                  stepRunRef: runRef,
                  signal: controller.signal,
                });

          if (result.status === "done") {
            records[cursor] = {
              // biome-ignore lint/style/noNonNullAssertion: the loop condition is this array's own length
              ...records[cursor]!,
              state: "done",
              output: result.output,
            };
            prior.push(result.output);
            // WF7: on along the step's own route; the steps a jump passes over are branch-skipped.
            const to = routeAfter(records, cursor);
            passOver(records, cursor, to);
            cursor = to;
            if (
              !(await writeRun(
                input.tenantId,
                input.runId,
                {
                  cursor,
                  steps: records,
                  status: cursor >= records.length ? "done" : "running",
                },
                run,
                owner,
              ))
            ) {
              return currentOutcome(input.tenantId, input.runId);
            }
            await closeCard(input.tenantId, runRef, false, input.runId);
            continue;
          }

          if (result.status === "awaiting_action") {
            const approvalId = result.approvalId;
            const question = approvalId ? undefined : result.question?.trim();
            records[cursor] = {
              // biome-ignore lint/style/noNonNullAssertion: the loop condition is this array's own length
              ...records[cursor]!,
              state: "awaiting_action",
              ...(approvalId ? { approvalId } : {}),
              ...(question ? { question } : {}),
            };
            if (
              !(await writeRun(
                input.tenantId,
                input.runId,
                {
                  cursor,
                  status: "awaiting_action",
                  steps: records,
                },
                run,
                owner,
              ))
            ) {
              return currentOutcome(input.tenantId, input.runId);
            }
            /*
             * Spec I3: the parent hangs in the attention region while a step waits.
             *
             * The step's own card is parked by the gate that opened the approval, which keys on the turn's
             * run id — that is why `executeStep` is handed `stepRunRef`. The parent has no turn of its own
             * to be parked against, so this is the one place the run itself says "nobody is working, this
             * is waiting on you". Both cards carry the same approval row, and `resumed` matches on that row
             * rather than on a run id, so the person's single answer moves both back at once.
             *
             * With no approval row there is nothing to hold a card against, and `needs_action` would be a
             * lane promising a decision that cannot be made — the mistake `routines/runner.ts` names for a
             * headless suspension. The run row still carries the parked cursor either way.
             */
            if (approvalId) {
              if (run.parentRunRef) {
                await board
                  .needsAction({
                    tenantId: input.tenantId,
                    runRef: run.parentRunRef,
                    approvalId,
                    pipelineRunId: input.runId,
                  })
                  .catch(() => undefined);
              }
              await board
                .needsAction({
                  tenantId: input.tenantId,
                  runRef,
                  approvalId,
                  pipelineRunId: input.runId,
                })
                .catch(() => undefined);
            }
            return currentOutcome(input.tenantId, input.runId);
          }

          records[cursor] = {
            // biome-ignore lint/style/noNonNullAssertion: the loop condition is this array's own length
            ...records[cursor]!,
            state: "failed",
            error: result.error,
          };
          if (
            !(await writeRun(
              input.tenantId,
              input.runId,
              {
                cursor,
                status: "failed",
                steps: records,
              },
              run,
              owner,
            ))
          ) {
            return currentOutcome(input.tenantId, input.runId);
          }
          await closeCard(input.tenantId, runRef, true);
          await closeParent(run, input.tenantId, true);
          return { status: "failed", cursor, steps: records };
        }

        if (
          run.status !== "done" &&
          !(await writeRun(
            input.tenantId,
            input.runId,
            {
              status: "done",
              steps: records,
            },
            run,
            owner,
          ))
        ) {
          return currentOutcome(input.tenantId, input.runId);
        }
        await closeParent(run, input.tenantId, false);
        return { status: "done", cursor, steps: records };
      } catch (error) {
        if (controller.signal.aborted)
          return currentOutcome(input.tenantId, input.runId);
        // Execution may already have written to the world. Keep the claim for the reaper instead of
        // letting a retry repeat a turn whose outcome is unknown.
        releaseOwner = false;
        throw error;
      } finally {
        clearInterval(heartbeat);
        await heartbeatWork;
        if (releaseOwner) {
          await runAsTenant(input.tenantId, async () => {
            await database
              .update(groupTaskRuns)
              .set({ advanceOwner: null })
              .where(
                and(
                  eq(groupTaskRuns.tenantId, input.tenantId),
                  eq(groupTaskRuns.id, input.runId),
                  eq(groupTaskRuns.advanceOwner, owner),
                ),
              );
          });
        }
      }
    },

    /**
     * Move past a step without running it (spec I4), recorded as skipped rather than cleared so the run
     * says afterwards what it did not do. Skipping the step the cursor is on is what unblocks a park.
     */
    async skip(input: {
      tenantId: string;
      runId: string;
      stepId?: string;
    }): Promise<RunOutcome> {
      const run = await readRun(input.tenantId, input.runId);
      if (!run) throw new PipelineNotFoundError("这个工作区里没有这次运行。");
      if (terminal(run)) return outcome(run);
      const records = [...run.steps];
      const at = input.stepId
        ? records.findIndex((record) => record.id === input.stepId)
        : run.cursor;
      if (at < 0 || at >= records.length) {
        throw new PipelineValidationError("这次运行里没有这一步。");
      }
      // biome-ignore lint/style/noNonNullAssertion: the loop condition is this array's own length
      const closed = records[at]!;
      if (run.advanceOwner && at !== run.cursor) {
        throw new PipelineValidationError(
          "运行中的流程只能跳过当前步骤。请等它停下再编辑后续步骤。",
        );
      }
      // WF7: a decision runs no coworker and is evaluated when it is reached; skipping it would
      // leave the run with no way to know which branch the person meant.
      if (closed.kind === "decision") {
        throw new PipelineValidationError(
          "条件判断步骤不能跳过；运行到它时会自动判断走哪个分支。",
        );
      }
      records[at] = { ...closed, state: "skipped", skipReason: "person" };
      let cursor = run.cursor;
      if (at === run.cursor) {
        // On along the skipped step's own route, as if it had finished.
        cursor = routeAfter(records, at);
        passOver(records, at, cursor);
      }
      const done = cursor >= records.length;
      if (
        !(await writeRun(
          input.tenantId,
          input.runId,
          {
            cursor,
            steps: records,
            status: done ? "done" : at === run.cursor ? "running" : run.status,
          },
          run,
        ))
      ) {
        return currentOutcome(input.tenantId, input.runId);
      }
      if (closed.runRef && closed.state !== "done") {
        await closeCard(input.tenantId, closed.runRef, false, input.runId);
      }
      if (done) await closeParent(run, input.tenantId, false);
      return {
        status: done
          ? "done"
          : at === run.cursor
            ? "running"
            : (run.status as RunOutcome["status"]),
        cursor,
        steps: records,
      };
    },

    /**
     * Stop the run and say so on the board: everything still open is closed as failed rather than left
     * `running` for a sweep to find (spec I4, and the same stranding ticket 032 fixed for hops).
     */
    async abort(input: {
      tenantId: string;
      runId: string;
    }): Promise<RunOutcome> {
      const run = await readRun(input.tenantId, input.runId);
      if (!run) throw new PipelineNotFoundError("这个工作区里没有这次运行。");
      if (terminal(run)) return outcome(run);
      const records = run.steps.map((record) =>
        stepIsSettled(record.state)
          ? record
          : { ...record, state: "aborted" as const },
      );
      /*
       * Anything still open is closed, and "still open" includes the step parked on an approval: the
       * person has just said the run is over, so a card asking them to decide something they have
       * cancelled is the stranding ticket 032 removed from hops, in a new place. Awaiting each close
       * rather than firing it off, because "aborted" that leaves a card asking is only half reported.
       */
      if (
        !(await writeRun(
          input.tenantId,
          input.runId,
          {
            cursor: records.length,
            status: "aborted",
            steps: records,
          },
          run,
        ))
      ) {
        return store.abort(input);
      }
      // WF7: a nested Flow still running under this run is stopped with it (spec §3.4 step 4).
      for (const record of run.steps) {
        if (record.childRunId && !stepIsSettled(record.state))
          await store
            .abort({ tenantId: input.tenantId, runId: record.childRunId })
            .catch(() => undefined);
      }
      for (const record of run.steps) {
        if (record.runRef) {
          await board
            .finished({
              tenantId: input.tenantId,
              runRef: record.runRef,
              failed: true,
              onlyUnsettled: true,
            })
            .catch(() => undefined);
        }
      }
      await closeParent(run, input.tenantId, true);
      return { status: "aborted", cursor: records.length, steps: records };
    },

    async inspect(input: { tenantId: string; runId: string }) {
      const run = await readRun(input.tenantId, input.runId);
      if (!run) return null;
      return {
        status: run.status,
        cursor: run.cursor,
        steps: run.steps,
        parentTaskId: run.parentTaskId,
        inputs: run.inputs,
      };
    },

    /**
     * Deliver the answer a parked step was waiting on, and carry the run on from there.
     *
     * This is spec I3's second half. The approval machinery resumes the coworker's own turn — the
     * person's decision belongs to that turn, not to the crew — so what reaches the pipeline is what
     * that resumed turn finally said, and the run's job is to record it and take the next step.
     *
     * Not a re-run: the step's card keeps its reference and its output comes from here, which is what
     * makes design test #2's assertion ("the parked step is not run again") true rather than merely
     * likely. It is also the only shape that cannot spend a second turn and write to the world twice
     * for one question.
     */
    async resume(input: {
      tenantId: string;
      runId: string;
      /** What the resumed turn finally answered. Absent with `error` when the person said no. */
      output?: string;
      /** Why the step did not produce one: declined, or the replayed turn failed. */
      error?: string;
      /**
       * WF8: false records the answer and returns, leaving the rest of the plan to the caller's own
       * driver, so a person's answer is not held open while the crew works through what follows.
       */
      drive?: boolean;
      /** WF7: answer only if the run is still parked on this step, waiting on this child. */
      parked?: { stepId: string; childRunId: string };
    }): Promise<RunOutcome> {
      const run = await readRun(input.tenantId, input.runId);
      if (!run) throw new PipelineNotFoundError("这个工作区里没有这次运行。");
      const records = [...run.steps];
      const cursor = run.cursor;
      const parked = records[cursor];
      if (
        input.parked &&
        (parked?.id !== input.parked.stepId ||
          parked.childRunId !== input.parked.childRunId)
      )
        return outcome(run);
      /*
       * A run that is not parked answers nothing.
       *
       * The approval queue retries, and an answer can be delivered twice; the second one arriving after
       * the crew already moved on must not file a second card for the step or overwrite the output the
       * next one produced.
       */
      if (run.status !== "awaiting_action" || !parked) {
        return {
          status: run.status as RunOutcome["status"],
          cursor,
          steps: records,
        };
      }

      if (input.error) {
        records[cursor] = {
          ...parked,
          state: "failed",
          error: input.error,
          approvalId: undefined,
          question: undefined,
        };
        if (
          !(await writeRun(
            input.tenantId,
            input.runId,
            {
              cursor,
              status: "failed",
              steps: records,
            },
            run,
          ))
        ) {
          return currentOutcome(input.tenantId, input.runId);
        }
        if (parked.runRef) {
          await closeCard(input.tenantId, parked.runRef, true);
        }
        await closeParent(run, input.tenantId, true);
        return { status: "failed", cursor, steps: records };
      }

      const output = input.output ?? "";
      records[cursor] = {
        ...parked,
        state: "done",
        output,
        approvalId: undefined,
        question: undefined,
      };
      // WF7: on along the parked step's own route, as `advance` would have gone.
      const next = routeAfter(records, cursor);
      passOver(records, cursor, next);
      if (
        !(await writeRun(
          input.tenantId,
          input.runId,
          {
            cursor: next,
            steps: records,
            status: next >= records.length ? "done" : "running",
          },
          run,
        ))
      ) {
        return currentOutcome(input.tenantId, input.runId);
      }
      if (parked.runRef)
        await closeCard(input.tenantId, parked.runRef, false, input.runId);
      /*
       * Then the rest of the plan, through the same door the first press used.
       *
       * The guard at the top of `advance` now lets this one through: the run's status was just moved
       * off `awaiting_action`, which is the fact that says a person is no longer being asked.
       */
      if (next < records.length) {
        if (input.drive === false)
          return { status: "running", cursor: next, steps: records };
        return store.advance({
          tenantId: input.tenantId,
          runId: input.runId,
        });
      }
      await closeParent(run, input.tenantId, false);
      return { status: "done", cursor: next, steps: records };
    },

    /**
     * WF7: which run, if any, has an action step waiting on this approval. Read in the platform frame
     * like {@link runHoldingApproval}; the caller asserts the run's owner and resumes in that frame.
     */
    async actionHoldingApproval(input: { approvalId: string }) {
      return store.runHoldingApproval({ ...input, kind: "action" });
    },

    /**
     * WF7: carry on an action step parked on this approval, after the person decided it.
     *
     * The step is driven again with the same identity it asked with (its card reference, its thread
     * and its step id), so the approval gate inside `callTool` finds the same request: approved, it
     * is consumed and the call carried out once; denied, the step fails; already carried out, its
     * saved result is replayed. Answers false when the run is not parked on an action holding this
     * approval, so the caller handles the approval the usual way.
     */
    async resumeAction(input: {
      tenantId: string;
      runId: string;
      approvalId: string;
    }): Promise<boolean> {
      const run = await readRun(input.tenantId, input.runId);
      if (!run) return false;
      const parked = run.steps[run.cursor];
      if (
        run.status !== "awaiting_action" ||
        parked?.kind !== "action" ||
        parked.approvalId !== input.approvalId
      )
        return false;
      if (
        !(await writeRun(
          input.tenantId,
          input.runId,
          { status: "running" },
          run,
        ))
      )
        return false;
      await store.advance({ tenantId: input.tenantId, runId: input.runId });
      return true;
    },

    /**
     * Which run, if any, is waiting on this approval.
     *
     * Asked by the approval machinery's resume path rather than by the screen: a person answers in the
     * approvals region, nothing there knows a crew is running, and a step that stayed parked because
     * nobody could tell the run it belonged to is spec I3's "处理后流水线从该步继续" left half-done —
     * the coworker's turn resumes, and the sequence after it does not.
     *
     * Read in the platform frame because that is the frame the resume runs in, and a sweep that can
     * only see its own tenant's rows would find nothing and say so confidently.
     */
    async runHoldingApproval(input: {
      approvalId: string;
      /** WF7: only a run whose step holding the approval is of this kind (an action step). */
      kind?: "action";
    }): Promise<{ tenantId: string; runId: string } | null> {
      const kind = input.kind;
      const [row] = await runAsTenant("platform", async () =>
        database
          .select({ id: groupTaskRuns.id, tenantId: groupTaskRuns.tenantId })
          .from(groupTaskRuns)
          .where(
            and(
              eq(groupTaskRuns.status, "awaiting_action"),
              /*
               * "Some step of this run recorded this approval", asked of the array's elements.
               *
               * Not the shorter-looking `steps @> ($1::jsonb)`: the driver sends a string parameter, and
               * by the time it reaches Postgres the value has been encoded as a JSON scalar rather than
               * the array the operator wants, so the containment answers false on rows that plainly
               * match. Measured, not guessed -- and the same double-encoding the shared `db/schema/json`
               * helper exists to avoid, arriving from the other side.
               */
              kind
                ? sql`exists (select 1 from jsonb_array_elements(${groupTaskRuns.steps}) as step where step->>'approvalId' = ${input.approvalId} and step->>'kind' = ${kind})`
                : sql`exists (select 1 from jsonb_array_elements(${groupTaskRuns.steps}) as step where step->>'approvalId' = ${input.approvalId})`,
            ),
          )
          .limit(1),
      );
      return row ? { tenantId: row.tenantId, runId: row.id } : null;
    },

    /**
     * Close the runs no process is coming back for, and say how many.
     *
     * Kept on the store so a caller holding one object can drive and clean up a crew run, and
     * implemented in `pipeline/reap.ts` so the CronJob that only cleans up does not have to build a
     * step runner it will never call. What it does and why — no replay, `awaiting_action` left alone,
     * open cards closed with the run — is written down there.
     */
    async reapAbandoned(input: { olderThanMs: number }): Promise<number> {
      const reaped = await reapAbandonedPipelineRuns(database, board, input);
      // WF7: this phase of the restart sweep is also where a parent left waiting on a child that
      // has already ended is carried on (spec §3.4, 重启). Nothing is replayed.
      const resumed = await store.resumeParentsOfEndedChildren();
      return reaped + resumed;
    },

    /**
     * WF7: attach the WakerFlow layer's way of starting a nested Flow's child run. Called once, by
     * `createWakerFlowStore`, which is built after this store and on top of it.
     */
    attachNestedFlows(runner: NestedFlowRunner) {
      nested = runner;
    },

    /** WF7: hand an ended child run's outcome to the parent step waiting on it; false if none was. */
    async settleChild(input: { tenantId: string; runId: string }) {
      return settleChild(input.tenantId, input.runId);
    },

    /**
     * WF7 (spec §3.4, 重启): parents still parked on a `flow` step whose child has already ended —
     * the process died between the child's last write and the parent's resume. Each is settled in
     * the tenant on its own row, exactly as the live path would have; the child is never re-run, and
     * the resume is conditional on the park, so a second sweep or replica finds nothing.
     */
    async resumeParentsOfEndedChildren(): Promise<number> {
      const rows = await runAsTenant("platform", async () =>
        database
          .select({ id: groupTaskRuns.id, tenantId: groupTaskRuns.tenantId })
          .from(groupTaskRuns)
          .where(
            and(
              sql`${groupTaskRuns.parentRunId} is not null`,
              sql`${groupTaskRuns.status} in ('done', 'failed', 'aborted')`,
              // Spelled out, like `owningFlow`: the subquery must name the outer row's columns.
              sql`exists (select 1 from "group_task_runs" as waiting_parent where waiting_parent.id = "group_task_runs"."parent_run_id" and waiting_parent.tenant_id = "group_task_runs"."tenant_id" and waiting_parent.status = 'awaiting_action')`,
            ),
          )
          .limit(100),
      );
      let resumed = 0;
      for (const row of rows) {
        const settled = await runAsTenant(row.tenantId, () =>
          settleChild(row.tenantId, row.id),
        ).catch(() => false);
        if (settled) resumed += 1;
      }
      return resumed;
    },
  };

  return store;
}

/**
 * The store's own shape, named once.
 *
 * The routes and the deployment's mount both take this rather than a hand-written list of methods, so
 * adding one operation cannot leave a caller's type still claiming the old set.
 */
export type PipelineStore = ReturnType<typeof createPipelineStore>;
