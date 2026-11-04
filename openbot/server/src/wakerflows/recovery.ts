import { and, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  flowRunRetries,
  groupTaskRuns,
  tasks,
  wakerFlowRequests,
} from "../db/schema";
import {
  type PipelineStepStateRow,
  stepIsSettled,
} from "../db/schema/pipeline";
import { runAsTenant } from "../tenant/context";
import {
  flowRunEventWriter,
  PLANNING_KINDS,
  RUN,
  RUN_UNCERTAIN_MESSAGE,
  UNCERTAIN_MESSAGE,
} from "./store";

/**
 * Restart recovery for WakerFlow runs (spec D10, WF-F).
 *
 * A Flow run is a pipeline run (`group_task_runs.flow_id` set) driven by `advance` inside the process
 * that started it. If that process stops mid-step, nothing will ever write the run again: the step
 * stays `running`, the run stays `running`, and its cards stay "in progress" on the board.
 *
 * The semantics are the ones `responsibilities/store.ts` gives `beginRun(runId, { recovered: true })`:
 * a run found `running` by recovery is closed as failed, never replayed. The step may already have
 * spent quota or written to the world, so running it again is the duplicate this must not cause. A
 * person reads the run and decides whether to start the Flow again.
 *
 * How a dead run is told from a live one: `advance` heartbeats `updated_at` every 30 seconds while it
 * holds the run, so a `running` row older than the recovery horizon (`ABANDONED_RUN_MS`, read on the
 * database clock) has no live driver on any replica. A run parked at `awaiting_action` waits on a
 * person and is never touched.
 *
 * This is one phase of the restart sweep in `recovery/abandoned-work.ts`, run just before the generic
 * crew reaper (`pipeline/reap.ts`), so a Flow run is closed with the Flow's own sentence. The generic
 * reaper would close it too if this phase failed; either way it ends failed and is not re-run.
 *
 * Idempotent: each run is closed by one transaction whose UPDATE is fenced on `status = 'running'`
 * and the revision that was read, so a second pass, a second replica or a second restart finds nothing.
 *
 * Tenancy: runs are found in the platform frame; every write happens under the tenant recorded on the
 * run's own row, never `system` and never a caller's.
 *
 * A run request (`waker_flow_requests`, kind `run`) the crash left `pending` is settled too: claimed
 * but never marked, it would block deleting the Flow for good and answer "pending" to every repeat.
 * It is never re-driven; it is pointed at its run if the pipeline had registered one, and otherwise
 * recorded as uncertain, exactly as `start` records a pipeline failure it cannot classify.
 *
 * A planning request (kind `generate`) the crash left `pending` blocks deleting the Flow the same way.
 * Its model call died with the process, but the provider may already have done and charged the work,
 * so it is settled `unknown` with the sentence `generate` itself stores for a call whose outcome
 * nobody saw. It is never re-driven and no model is called; the Flow is not written (the plan only
 * reaches the Flow in the transaction that also marks the request `completed`, and the Flow has no
 * planning status of its own). A new request id is how a person plans again. A customization turn
 * (kind `customize`, WF9) is the same planning call and is settled the same way.
 */

/** What the step that was running says about itself after a restart. */
export const FLOW_STEP_INTERRUPTED =
  "服务在这一步执行期间重启了。这一步可能已经产生了效果，系统没有重新执行它。";

/** What a step that had not started yet says: the run ended before it. */
export const FLOW_STEP_NOT_STARTED =
  "服务在这一步开始前重启了，运行已停止，这一步没有执行。";

/** The board's projection, for the live update only; the cards themselves are written here. */
export type FlowRecoveryBoard = {
  finished: (input: {
    tenantId: string;
    runRef: string;
    failed?: boolean;
    onlyUnsettled?: boolean;
  }) => Promise<void>;
};

export async function recoverInterruptedFlowRuns(
  database: Database,
  board: FlowRecoveryBoard,
  input: { olderThanMs: number },
): Promise<number> {
  const stranded = await runAsTenant("platform", async () => {
    return await database
      .select({
        id: groupTaskRuns.id,
        tenantId: groupTaskRuns.tenantId,
        parentTaskId: groupTaskRuns.parentTaskId,
        steps: groupTaskRuns.steps,
        revision: groupTaskRuns.revision,
        flowId: groupTaskRuns.flowId,
        cursor: groupTaskRuns.cursor,
      })
      .from(groupTaskRuns)
      .where(
        and(
          isNotNull(groupTaskRuns.flowId),
          eq(groupTaskRuns.status, "running"),
          sql`${groupTaskRuns.updatedAt} < now() - (${input.olderThanMs} * interval '1 millisecond')`,
        ),
      );
  });

  let recovered = 0;
  for (const row of stranded) {
    // From here on the tenant is the claimed row's own.
    const owner = row.tenantId;
    const records: PipelineStepStateRow[] = Array.isArray(row.steps)
      ? row.steps
      : [];
    const closedSteps = records.map<PipelineStepStateRow>((record) => {
      if (stepIsSettled(record.state)) return record;
      return {
        ...record,
        state: "failed",
        error:
          record.state === "running" || record.state === "awaiting_action"
            ? FLOW_STEP_INTERRUPTED
            : FLOW_STEP_NOT_STARTED,
      };
    });
    // The cards still open: every unsettled step that had opened one, and the parent.
    const runRefs = [
      ...records
        .filter((record) => !stepIsSettled(record.state) && record.runRef)
        .map((record) => record.runRef as string),
      ...(row.parentTaskId ? [row.id] : []),
    ];
    /*
     * And any card still open under the parent: `advance` opens a step's card before it writes the
     * step's run reference, so a crash between the two leaves a card no step record names.
     */
    const openCards = [
      ...(runRefs.length > 0 ? [inArray(tasks.runRef, runRefs)] : []),
      ...(row.parentTaskId ? [eq(tasks.parentTaskId, row.parentTaskId)] : []),
    ];

    const closed = await runAsTenant(owner, () =>
      database.transaction(async (tx) => {
        const [run] = await tx
          .update(groupTaskRuns)
          .set({
            status: "failed",
            advanceOwner: null,
            revision: sql`${groupTaskRuns.revision} + 1`,
            steps: closedSteps,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(groupTaskRuns.tenantId, owner),
              eq(groupTaskRuns.id, row.id),
              eq(groupTaskRuns.status, "running"),
              eq(groupTaskRuns.revision, row.revision),
              sql`${groupTaskRuns.updatedAt} < now() - (${input.olderThanMs} * interval '1 millisecond')`,
            ),
          )
          .returning({
            id: groupTaskRuns.id,
            revision: groupTaskRuns.revision,
          });
        if (!run) return false;
        // WF8: the closing is recorded with it, like every other change of a Flow's run: each step it
        // closed as failed, then `run_failed`.
        if (row.flowId)
          await flowRunEventWriter(tx, {
            tenantId: owner,
            runId: row.id,
            flowId: row.flowId,
            revision: run.revision,
            inputs: {},
            before: { status: "running", steps: records },
            after: { status: "failed", cursor: row.cursor, steps: closedSteps },
          });
        /*
         * In the same transaction as the run, so a run reported failed never leaves its cards saying
         * "running": the reaper does not look at a failed run again, so a card left open here would be
         * open for good. Only cards still open move; one a person already settled keeps its state.
         */
        if (openCards.length > 0)
          await tx
            .update(tasks)
            .set({
              status: "failed",
              pendingApprovalId: null,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(tasks.tenantId, owner),
                or(...openCards),
                sql`${tasks.status} in ('running', 'needs_action')`,
              ),
            );
        return true;
      }),
    );
    if (!closed) continue;
    recovered++;
    /*
     * The board's own write, after the commit, for its live update: the cards are already failed, so
     * this matches nothing it would change and only tells open boards to refresh.
     */
    for (const runRef of runRefs)
      await board
        .finished({
          tenantId: owner,
          runRef,
          failed: true,
          onlyUnsettled: true,
        })
        .catch(() => undefined);
  }
  return (
    recovered +
    (await settleStrandedRunRequests(database, input)) +
    (await settleStrandedGenerateRequests(database, input)) +
    (await settleStrandedRetries(database, input))
  );
}

/**
 * WF8: retries a crash left `prepared`, registered and never driven (spec §3.5 step 5). The ledger row
 * is written with the new run, and moves to `ready` once that run is handed to its driver, so a
 * `prepared` row older than the horizon belongs to a process that died in between. It is settled
 * `unknown` and nothing is replayed: the new run itself, `running` with no live driver, is closed as
 * failed by this sweep's first phase like any other interrupted run, and a person decides what next.
 * Fenced on `prepared` and age in the UPDATE, so a live retry and a second pass are left alone.
 */
async function settleStrandedRetries(
  database: Database,
  input: { olderThanMs: number },
): Promise<number> {
  const stale = sql`${flowRunRetries.createdAt} < now() - (${input.olderThanMs} * interval '1 millisecond')`;
  const stranded = await runAsTenant("platform", async () => {
    return await database
      .select({ id: flowRunRetries.id, tenantId: flowRunRetries.tenantId })
      .from(flowRunRetries)
      .where(and(eq(flowRunRetries.status, "prepared"), stale));
  });
  let settled = 0;
  for (const retry of stranded) {
    // From here on the tenant is the ledger row's own.
    const owner = retry.tenantId;
    const marked = await runAsTenant(owner, async () => {
      return await database
        .update(flowRunRetries)
        .set({ status: "unknown" })
        .where(
          and(
            eq(flowRunRetries.tenantId, owner),
            eq(flowRunRetries.id, retry.id),
            eq(flowRunRetries.status, "prepared"),
            stale,
          ),
        )
        .returning({ id: flowRunRetries.id });
    });
    if (marked.length > 0) settled++;
  }
  return settled;
}

/**
 * Run requests a crash left between the claim and the "completed" mark. Fenced on `pending` and age,
 * so a live `start` (which marks its row within moments) and a second pass are both left alone.
 */
async function settleStrandedRunRequests(
  database: Database,
  input: { olderThanMs: number },
): Promise<number> {
  const stale = sql`${wakerFlowRequests.updatedAt} < now() - (${input.olderThanMs} * interval '1 millisecond')`;
  const stranded = await runAsTenant("platform", async () => {
    return await database
      .select({
        id: wakerFlowRequests.id,
        tenantId: wakerFlowRequests.tenantId,
        runId: wakerFlowRequests.runId,
      })
      .from(wakerFlowRequests)
      .where(
        and(
          eq(wakerFlowRequests.kind, RUN),
          eq(wakerFlowRequests.status, "pending"),
          stale,
        ),
      );
  });

  let settled = 0;
  for (const request of stranded) {
    // From here on the tenant is the claimed row's own.
    const owner = request.tenantId;
    const runId = request.runId;
    const done = await runAsTenant(owner, () =>
      database.transaction(async (tx) => {
        const [run] = runId
          ? await tx
              .select({
                id: groupTaskRuns.id,
                parentTaskId: groupTaskRuns.parentTaskId,
              })
              .from(groupTaskRuns)
              .where(
                and(
                  eq(groupTaskRuns.tenantId, owner),
                  eq(groupTaskRuns.id, runId),
                ),
              )
              .limit(1)
          : [];
        const [marked] = await tx
          .update(wakerFlowRequests)
          .set(
            run
              ? {
                  status: "completed",
                  error: null,
                  runId: run.id,
                  taskId: run.parentTaskId,
                  updatedAt: new Date(),
                }
              : {
                  status: "unknown",
                  error: RUN_UNCERTAIN_MESSAGE,
                  updatedAt: new Date(),
                },
          )
          .where(
            and(
              eq(wakerFlowRequests.tenantId, owner),
              eq(wakerFlowRequests.id, request.id),
              eq(wakerFlowRequests.status, "pending"),
              stale,
            ),
          )
          .returning({ id: wakerFlowRequests.id });
        if (!marked) return false;
        /*
         * No run row: the pipeline may still have opened the parent card (its run reference is the
         * request's run id) before it stopped. That card would say "running" for good.
         */
        if (!run && runId)
          await tx
            .update(tasks)
            .set({
              status: "failed",
              pendingApprovalId: null,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(tasks.tenantId, owner),
                eq(tasks.runRef, runId),
                sql`${tasks.status} in ('running', 'needs_action')`,
              ),
            );
        return true;
      }),
    );
    if (done) settled++;
  }
  return settled;
}

/**
 * Planning requests a crash left between the claim and the outcome. `generate` holds no heartbeat, but
 * its model call is bounded by the generator's timeout (two minutes), far inside the recovery horizon,
 * so a `pending` row older than the horizon has no live call on any replica. Fenced on kind, `pending`
 * and age in the UPDATE itself, so a live call, a Cancel that landed first, a second pass and a second
 * replica are all left alone; a late answer from a call that somehow survived finds the row no longer
 * `pending` and writes nothing, exactly as after a Cancel.
 */
async function settleStrandedGenerateRequests(
  database: Database,
  input: { olderThanMs: number },
): Promise<number> {
  const stale = sql`${wakerFlowRequests.updatedAt} < now() - (${input.olderThanMs} * interval '1 millisecond')`;
  const stranded = await runAsTenant("platform", async () => {
    return await database
      .select({
        id: wakerFlowRequests.id,
        tenantId: wakerFlowRequests.tenantId,
      })
      .from(wakerFlowRequests)
      .where(
        and(
          inArray(wakerFlowRequests.kind, PLANNING_KINDS),
          eq(wakerFlowRequests.status, "pending"),
          stale,
        ),
      );
  });

  let settled = 0;
  for (const request of stranded) {
    // From here on the tenant is the claimed row's own.
    const owner = request.tenantId;
    const marked = await runAsTenant(owner, async () => {
      return await database
        .update(wakerFlowRequests)
        .set({
          status: "unknown",
          error: UNCERTAIN_MESSAGE,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(wakerFlowRequests.tenantId, owner),
            eq(wakerFlowRequests.id, request.id),
            inArray(wakerFlowRequests.kind, PLANNING_KINDS),
            eq(wakerFlowRequests.status, "pending"),
            stale,
          ),
        )
        .returning({ id: wakerFlowRequests.id });
    });
    if (marked.length > 0) settled++;
  }
  return settled;
}
