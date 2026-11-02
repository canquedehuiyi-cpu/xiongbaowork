/**
 * Restart recovery: closing what a dead process left "in progress" (audit defect #10).
 *
 * A server that stops mid-turn leaves three kinds of rows that nothing else will ever write again:
 *
 * - a routine firing's `routine_runs` row with no status;
 * - a crew's `group_task_runs` row at `running` (its owner bumps `updated_at` while alive);
 * - the routine/responsibility task cards those runs opened, at `running`.
 *
 * Each already had a reaper (`routines/store.ts`, `pipeline/reap.ts`, `tasks/projector.ts`), but the
 * only caller was the routines CronJob, which the chart leaves off by default. So on a default
 * deployment the board kept those cards "in progress" for ever. This module is the one sweep both the
 * API server (every replica, on a timer) and the CronJob call.
 *
 * NOTHING IS REPLAYED. Every phase closes a row as failed/skipped and says why; a step or firing that
 * died may already have spent quota or written to the world, so re-running it is the duplicate this
 * sweep must never cause. What a person does after reading the card is start again.
 *
 * MULTI-REPLICA. Every phase is already safe to run twice at once: each is a conditional UPDATE (or a
 * revision-fenced one) whose age test reads the database clock, so a second runner affects 0 rows.
 * On top of that, one replica per time bucket does the work, through the shared work queue's lease
 * (`for update skip locked`, lease on the database clock, renewed before every phase). The bucket is
 * taken from the process clock; skew can only cause an extra, harmless pass.
 *
 * TENANCY (G01). Rows are selected in the platform frame and every write keeps the row's own
 * `tenant_id`: the routine and card passes are single platform-frame UPDATEs that never set
 * `tenant_id`, and the crew pass writes each run and its cards inside that run's own tenant frame.
 * Nothing here writes under `system`. The lease item itself is the platform's row, not a tenant's.
 *
 * WHAT THIS DOES NOT DO: resume approved actions. `approval.resume` stays blocked
 * (`ApprovalRecoveryBlockedError`) until Root's release verifier attests the local recovery target —
 * see `APPROVAL_RESUME_GATED_REASON` and `docs/restart-recovery.md`.
 */
import { ABANDONED_RUN_MS } from "../routines/sweep";
import { runAsTenant } from "../tenant/context";
import type { WorkQueue } from "../work/queue";

/** The work-queue kind whose items are the per-bucket sweep lease. */
export const RECOVERY_SWEEP_KIND = "recovery.abandoned";

/** One sweep per bucket across the whole fleet. */
export const RECOVERY_BUCKET_MS = 5 * 60_000;

/**
 * The lease one phase may run under before it is renewed: a whole bucket, so a slow phase (the crew
 * pass awaits a card write per run) does not lose it to the next 60s tick of another replica. Mutual
 * exclusion is still an optimisation; every phase is idempotent, which is the actual guarantee.
 */
export const RECOVERY_LEASE_MS = RECOVERY_BUCKET_MS;

/** How long finished lease items are kept before `purge` drops them. */
export const RECOVERY_PURGE_AFTER_MS = 24 * 60 * 60_000;

/** What a reaped routine firing records as its error. */
export const REAPED_ROUTINE_RUN =
  "the server never finished this run; it may have restarted mid-turn, or the run may never have been dispatched";

/**
 * Why `approval.resume` is refused after a restart, in the server's own logs.
 *
 * Not a fault this sweep can mend: the local continuation recovery port is composed only from a
 * Root-verified release attestation (`approvals/local-recovery-composition.ts`), and the server never
 * fabricates one.
 */
export const APPROVAL_RESUME_GATED_REASON = "root_release_not_attested";

export type RecoveryPhaseName = "routineRuns" | "pipelineRuns" | "cards";

/** The three reapers, in the order they must run. Each returns how many rows it closed. */
export type RecoveryPhases = Record<
  RecoveryPhaseName,
  (olderThanMs: number) => Promise<number>
>;

export type AbandonedWorkOptions = {
  queue: Pick<WorkQueue, "offer" | "claim" | "renew" | "finish" | "release">;
  owner: string;
  phases: RecoveryPhases;
  olderThanMs?: number;
  /** The process clock, for the bucket only. */
  now?: () => number;
  /** Overrides the bucket key; tests use it so reruns against one database do not collide. */
  key?: string;
};

export type AbandonedWorkReport = {
  /** True only for the replica that held this bucket's lease and ran the phases. */
  won: boolean;
  key: string;
  routineRuns: number;
  pipelineRuns: number;
  cards: number;
  failed: { phase: RecoveryPhaseName; reason: string }[];
  /** True when a renewal said the lease had gone to somebody else; later phases did not run. */
  leaseLost: boolean;
};

/**
 * Order matters: runs first, so the cards they opened are no longer held open by a live-looking
 * ledger row when the card pass reads it, and close in the same sweep.
 */
const ORDER: RecoveryPhaseName[] = ["routineRuns", "pipelineRuns", "cards"];

export function recoveryBucketKey(nowMs: number): string {
  const start = Math.floor(nowMs / RECOVERY_BUCKET_MS) * RECOVERY_BUCKET_MS;
  return new Date(start).toISOString();
}

export async function sweepAbandonedWork(
  options: AbandonedWorkOptions,
): Promise<AbandonedWorkReport> {
  const olderThanMs = options.olderThanMs ?? ABANDONED_RUN_MS;
  const key = options.key ?? recoveryBucketKey((options.now ?? Date.now)());
  const report: AbandonedWorkReport = {
    won: false,
    key,
    routineRuns: 0,
    pipelineRuns: 0,
    cards: 0,
    failed: [],
    leaseLost: false,
  };
  const lease = { kind: RECOVERY_SWEEP_KIND, owner: options.owner };

  // The platform's own row: the lease is not any tenant's work.
  await runAsTenant("platform", () =>
    options.queue.offer({ kind: RECOVERY_SWEEP_KIND, key }),
  );
  const claimed = await options.queue.claim({
    ...lease,
    leaseMs: RECOVERY_LEASE_MS,
    limit: 10,
  });
  /*
   * Anything else claimed is another bucket. An OLDER one (ISO keys sort by time) is a window whose
   * holder died or that nobody claimed in time: retire it, it is not a reason to run. A NEWER one was
   * offered by a replica whose clock runs ahead of ours and is not ours to close: hand it straight
   * back so that replica can claim it.
   */
  for (const item of claimed) {
    if (item.key === key) report.won = true;
    else if (item.key < key)
      await options.queue.finish({ ...lease, key: item.key });
    else await options.queue.release({ ...lease, key: item.key, delayMs: 0 });
  }
  if (!report.won) return report;

  for (const [index, phase] of ORDER.entries()) {
    if (
      index > 0 &&
      !(await options.queue.renew({
        ...lease,
        key,
        leaseMs: RECOVERY_LEASE_MS,
      }))
    ) {
      // Somebody else holds this bucket now; leave the rest, and the item, to them.
      report.leaseLost = true;
      return report;
    }
    try {
      report[phase] = await options.phases[phase](olderThanMs);
    } catch (error) {
      // One reaper failing must not keep the others from closing what they can.
      report.failed.push({
        phase,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  // A lease that lapsed during the last phase was taken over; say so rather than claim the window.
  if (!(await options.queue.finish({ ...lease, key }))) report.leaseLost = true;
  return report;
}

/**
 * The production phases, built from the real stores.
 *
 * Structural parameter types rather than the stores' own, so the CronJob script can build these
 * without importing the runtime behind the pipeline store.
 */
export function abandonedWorkPhases(input: {
  routineStore: {
    reapAbandonedRuns: (olderThanMs: number, error: string) => Promise<number>;
  };
  reapPipelineRuns: (input: { olderThanMs: number }) => Promise<number>;
  board: {
    reclaimAbandoned: (input: { olderThanMs: number }) => Promise<number>;
  };
}): RecoveryPhases {
  return {
    routineRuns: (olderThanMs) =>
      input.routineStore.reapAbandonedRuns(olderThanMs, REAPED_ROUTINE_RUN),
    pipelineRuns: (olderThanMs) => input.reapPipelineRuns({ olderThanMs }),
    cards: (olderThanMs) => input.board.reclaimAbandoned({ olderThanMs }),
  };
}
