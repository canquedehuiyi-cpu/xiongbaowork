import { and, count, eq, lt, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { groupTaskRuns, tasks } from "../db/schema";
import { taskArchives } from "../db/schema/task-archives";
import type { QuotaService } from "../quota/limits";
import { runAsTenant } from "../tenant/context";
import { staleUnattendedCards } from "./reclaim";

/**
 * The board's projector: every fact the run machinery already emits gets one
 * narrow function here that turns it into task state. Nothing else writes
 * `tasks`, so the board can be rebuilt from scratch by replaying these calls,
 * and no execution path reads the result.
 *
 * Callers pass the tenant explicitly rather than trusting ambient scope,
 * because a routine fires outside any person's request -- the same reason the
 * audit rows carry their own initiator.
 */
export type TaskProjector = {
  opened(input: {
    tenantId: string;
    title: string;
    /** See `tasks.executor_agent_id`: omit it when the card is a whole group's ask. */
    executorAgentId?: string | null;
    source: "chat" | "routine" | "responsibility" | "handoff" | "group_run";
    /**
     * Which autonomous trigger set the card in motion, finer than `source` (story C2): `proactive`
     * is a Bot's background research, filed under the `routine` lane the board already counts as
     * unattended work. Omitted, the column stays null, which every existing card already reads as.
     */
    triggerSource?: "proactive" | null;
    channelRef?: string;
    runRef?: string;
    parentTaskId?: string;
    /** Reserve parent + children before a pipeline can execute its first step. */
    quotaUnits?: number;
    /**
     * The parent's card, named by the RUN that asked rather than by a card id.
     *
     * Only a handoff passes it: the hop knows its parent's run id from the queue (`work.runId`) and
     * never has the parent's card id, which lives in a row the hop's own code has no business reading.
     * Resolving it here keeps that lookup on the one path that already owns the task rows, instead of
     * threading a new pipe through the delivery to carry a value the board can find in one select.
     *
     * A miss is a card with no parent, not a failed hop: the parent may have been reviewed, archived or
     * reaped while this hop waited on the queue, and the work the person asked for still happened.
     */
    parentRunRef?: string;
    /** The machine the coworker's actions will be carried out on, when there is one. */
    deviceId?: string | null;
  }): Promise<string>;
  needsAction(input: {
    tenantId: string;
    runRef: string;
    approvalId: string;
    pipelineRunId?: string;
  }): Promise<void>;
  resumed(input: {
    tenantId: string;
    approvalId: string;
    failed: boolean;
  }): Promise<void>;
  finished(input: {
    tenantId: string;
    runRef: string;
    deliverableRef?: unknown;
    failed?: boolean;
    pipelineRunId?: string;
    onlyUnsettled?: boolean;
  }): Promise<void>;
  reviewed(input: { tenantId: string; taskId: string }): Promise<boolean>;
  /**
   * File a card away (spec A5/A7). A card awaiting review becomes `done`; a failed card STAYS
   * `failed` and gains an archive stamp, so 已结束-失败 is never rewritten as a success. Anything
   * else -- running, needs_action, done, an already-archived failure, another tenant's card -- is
   * refused with `false`.
   */
  archived(input: {
    tenantId: string;
    taskId: string;
    /** Who filed it, when a person did. */
    archivedBy?: string | null;
  }): Promise<boolean>;
  /**
   * Close unattended cards whose run stopped existing, and say how many.
   *
   * A person's chat run is left alone: its thread is still there, and a card that outlived a closed
   * browser is the board remembering a conversation, not a job abandoned. Unattended cards are the
   * opposite — nobody is watching, so a card stuck in `running` after a restart is not a delay but
   * a permanent answer, and `running` is exactly what the board's "in progress" count and the
   * coworker screen's status line read.
   *
   * Cross-tenant by design, which is why it takes no tenant: it is called from the sweep, and it
   * runs in the platform scope the provisioning path already uses.
   */
  reclaimAbandoned(input: { olderThanMs: number }): Promise<number>;
};

export function createTaskProjector(
  database: Database,
  notify?: (tenantId: string) => void,
  /** The tenant's monthly task ceiling, when this deployment counts one (ticket 022). */
  quota?: QuotaService,
): TaskProjector {
  const announce = (tenantId: string) => {
    try {
      notify?.(tenantId);
    } catch (error) {
      console.error("task board notify failed", error);
    }
  };
  return {
    async opened(input) {
      const id = await runAsTenant(input.tenantId, () =>
        database.transaction(async (transaction) => {
          await transaction.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${`task:${input.tenantId}`}, 0))`,
          );
          if (input.runRef) {
            const [existing] = await transaction
              .select({ id: tasks.id })
              .from(tasks)
              .where(
                and(
                  eq(tasks.tenantId, input.tenantId),
                  eq(tasks.runRef, input.runRef),
                ),
              )
              .limit(1);
            if (existing) return existing.id;
          }
          /*
           * The tally moves with the row, and nothing else.
           *
           * The ceiling itself is asked at the point work starts — before a turn runs, before a routine
           * fires — because refusing a card after the model has already answered would charge for work
           * that happened. What is counted here is the month's use, which filing a card away does not
           * refund: the plans screen says so in those words.
           */
          /*
           * A parent named by its run is looked up here, in the tenant frame this write is already
           * inside. Only a handoff arrives with a run rather than a card id -- see the input.
           */
          let parentTaskId = input.parentTaskId ?? null;
          if (!parentTaskId && input.parentRunRef) {
            const [parent] = await transaction
              .select({ id: tasks.id })
              .from(tasks)
              .where(
                and(
                  eq(tasks.tenantId, input.tenantId),
                  eq(tasks.runRef, input.parentRunRef),
                ),
              )
              .limit(1);
            parentTaskId = parent?.id ?? null;
          }

          let units = input.quotaUnits ?? 1;
          if (!Number.isSafeInteger(units) || units < 1)
            throw new TypeError("Task quota units must be a positive integer");
          if (input.source === "group_run" && parentTaskId) {
            const [parent] = await transaction
              .select({ quotaUnits: tasks.quotaUnits, source: tasks.source })
              .from(tasks)
              .where(
                and(
                  eq(tasks.tenantId, input.tenantId),
                  eq(tasks.id, parentTaskId),
                ),
              )
              .limit(1);
            if (parent?.source === "group_run" && parent.quotaUnits > 1) {
              const [children] = await transaction
                .select({ value: count() })
                .from(tasks)
                .where(
                  and(
                    eq(tasks.tenantId, input.tenantId),
                    eq(tasks.parentTaskId, parentTaskId),
                  ),
                );
              if ((children?.value ?? 0) >= parent.quotaUnits - 1)
                throw new Error(
                  "Pipeline has exhausted its reserved task slots",
                );
              units = 0;
            }
          }
          if (units > 0)
            await quota?.assertCapacityWithin(
              transaction,
              input.tenantId,
              "tasksPerMonth",
              units,
            );
          const [row] = await transaction
            .insert(tasks)
            .values({
              tenantId: input.tenantId,
              title: input.title.slice(0, 200),
              executorAgentId: input.executorAgentId ?? null,
              source: input.source,
              triggerSource: input.triggerSource ?? null,
              channelRef: input.channelRef,
              deviceId: input.deviceId ?? null,
              runRef: input.runRef,
              parentTaskId,
              quotaUnits: units,
            })
            .returning({ id: tasks.id });
          if (units > 0)
            await quota?.recordTaskWithin(transaction, input.tenantId, units);
          return row.id;
        }),
      );
      announce(input.tenantId);
      return id;
    },

    async needsAction(input) {
      return runAsTenant(input.tenantId, async () => {
        // A run that parks on an approval parks its task; the run id is the
        // join because that is what the approval row already carries.
        await database
          .update(tasks)
          .set({
            status: "needs_action",
            pendingApprovalId: input.approvalId,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(tasks.tenantId, input.tenantId),
              eq(tasks.runRef, input.runRef),
              ...(input.pipelineRunId
                ? [
                    sql`exists (select 1 from ${groupTaskRuns} where ${groupTaskRuns.id} = ${input.pipelineRunId} and ${groupTaskRuns.tenantId} = ${input.tenantId} and ${groupTaskRuns.status} = 'awaiting_action')`,
                  ]
                : []),
            ),
          );
        announce(input.tenantId);
      });
    },

    async resumed(input) {
      return runAsTenant(input.tenantId, async () => {
        await database
          .update(tasks)
          .set({
            status: input.failed ? "failed" : "running",
            pendingApprovalId: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(tasks.tenantId, input.tenantId),
              eq(tasks.pendingApprovalId, input.approvalId),
            ),
          );
        announce(input.tenantId);
      });
    },

    async finished(input) {
      return runAsTenant(input.tenantId, async () => {
        await database
          .update(tasks)
          .set({
            status: input.failed ? "failed" : "awaiting_review",
            deliverableRef: input.deliverableRef ?? null,
            pendingApprovalId: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(tasks.tenantId, input.tenantId),
              eq(tasks.runRef, input.runRef),
              ...(input.onlyUnsettled
                ? [sql`${tasks.status} in ('running', 'needs_action')`]
                : []),
              ...(input.pipelineRunId
                ? [
                    sql`exists (select 1 from ${groupTaskRuns} where ${groupTaskRuns.id} = ${input.pipelineRunId} and ${groupTaskRuns.tenantId} = ${input.tenantId} and ${groupTaskRuns.status} not in ('aborted', 'failed'))`,
                  ]
                : []),
            ),
          );
        announce(input.tenantId);
      });
    },

    async reviewed(input) {
      return runAsTenant(input.tenantId, async () => {
        const rows = await database
          .update(tasks)
          .set({ status: "done", updatedAt: new Date() })
          .where(
            and(
              eq(tasks.tenantId, input.tenantId),
              eq(tasks.id, input.taskId),
              eq(tasks.status, "awaiting_review"),
            ),
          )
          .returning({ id: tasks.id });
        announce(input.tenantId);
        return rows.length > 0;
      });
    },

    async archived(input) {
      const ok = await runAsTenant(input.tenantId, () =>
        database.transaction(async (transaction) => {
          // Archiving is the one human-authored transition, and it only moves
          // sideways into the finished lane -- never back into running.
          const reviewed = await transaction
            .update(tasks)
            .set({ status: "done", updatedAt: new Date() })
            .where(
              and(
                eq(tasks.tenantId, input.tenantId),
                eq(tasks.id, input.taskId),
                eq(tasks.status, "awaiting_review"),
              ),
            )
            .returning({ id: tasks.id });
          if (reviewed.length > 0) return true;

          /*
           * A failure keeps its status: what is archived is that a person saw it, not that it
           * worked. The stamp's tenant is copied from the claimed row rather than from the
           * caller or the session default, and the row lock keeps a concurrent status change
           * from slipping between the read and the stamp.
           */
          const [claimed] = await transaction
            .select({
              tenantId: tasks.tenantId,
              id: tasks.id,
              updatedAt: tasks.updatedAt,
            })
            .from(tasks)
            .where(
              and(
                eq(tasks.tenantId, input.tenantId),
                eq(tasks.id, input.taskId),
                eq(tasks.status, "failed"),
              ),
            )
            .limit(1)
            .for("update");
          if (!claimed) return false;
          /*
           * A stamp speaks for the failure it was written against and no later one. The card and its
           * stamp share one instant, and every later transition moves `updatedAt` past it -- which is
           * how the board (`GET /`) tells "this failure was filed away" from "a stamp is left over
           * from an earlier one". So a stamp older than the card's last change is replaced, and only
           * a current one makes a second archive a refusal.
           */
          const at = new Date();
          const stamped = await transaction
            .insert(taskArchives)
            .values({
              tenantId: claimed.tenantId,
              taskId: claimed.id,
              archivedBy: input.archivedBy ?? null,
              archivedAt: at,
            })
            .onConflictDoUpdate({
              target: taskArchives.taskId,
              set: {
                tenantId: claimed.tenantId,
                archivedBy: input.archivedBy ?? null,
                archivedAt: at,
              },
              setWhere: lt(taskArchives.archivedAt, claimed.updatedAt),
            })
            .returning({ taskId: taskArchives.taskId });
          // Already archived: a second archive is a refusal, not a silent success.
          if (stamped.length === 0) return false;
          await transaction
            .update(tasks)
            .set({ updatedAt: at })
            .where(
              and(
                eq(tasks.tenantId, claimed.tenantId),
                eq(tasks.id, claimed.id),
              ),
            );
          return true;
        }),
      );
      announce(input.tenantId);
      return ok;
    },

    async reclaimAbandoned(input) {
      return runAsTenant("platform", async () => {
        /*
         * One statement, not a read-then-write per card: this pass runs on every replica, and a
         * second replica taking the same row would count work it did not do. Postgres evaluates the
         * predicate and the update under one row lock, so `rows.length` is what this pass moved.
         */
        const rows = await database
          .update(tasks)
          .set({
            status: "failed",
            // Whatever it was parked on went with the run, so the card must not stay answerable to
            // a decision nobody can still make.
            pendingApprovalId: null,
            updatedAt: new Date(),
          })
          /*
           * The predicate lives in `reclaim.ts` rather than here because its subject is the two run
           * ledgers, not the board: which cards may be closed is decided by whether the work behind
           * them is still recorded as in flight. Note that `group_run` is no longer in this pass — a
           * crew's cards are reconciled by `pipeline/reap.ts`, which knows the parent and its parked
           * step apart.
           */
          .where(staleUnattendedCards(input.olderThanMs))
          .returning({ id: tasks.id });
        // Not announced: `announce` takes one tenant and this spans them all. A restart is not the
        // moment anybody is watching the board, and it refetches on its own interval.
        return rows.length;
      });
    },
  };
}
