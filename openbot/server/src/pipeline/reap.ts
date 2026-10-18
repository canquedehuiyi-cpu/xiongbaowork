import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { groupTaskRuns } from "../db/schema";
import {
  type PipelineStepStateRow,
  stepIsSettled,
} from "../db/schema/pipeline";
import type { TaskProjector } from "../tasks/projector";
import { runAsTenant } from "../tenant/context";

/**
 * Closing the crew runs no process is coming back for (ticket 021, design test #7).
 *
 * A pipeline advances inside a request, so the server that was running a step is the only thing that
 * will ever write its next state. Restart mid-turn and the run row stays `running` while nothing is
 * running: the board's in-progress count reads that row, the crew screen's status line reads it, and
 * the person has no way to tell a stopped crew from a slow one.
 *
 * It is not replayed. Every step is a coworker turn that spent the month's quota and may have written
 * to the world, so the duplicate delivery this ticket's design names as its biggest risk is exactly
 * what an eager retry would produce. What a person does after reading the card is start a new run.
 *
 * Only `running` is looked at. A run parked in `awaiting_action` is waiting on a person, and a person
 * can take a weekend — aging that out would answer a question nobody asked.
 *
 * A free function in its own file rather than a method on the store, because the process that sweeps is
 * not the process that runs crews: the routines CronJob calls this, and it must not drag the turn
 * channel and everything behind it into a script whose whole job is to notice what stopped. It is
 * cross-tenant by design, like the card reaper it works beside, so it runs in the platform frame
 * provisioning uses and takes no tenant to stay inside one.
 */

/** What a reaped step says about itself, in the words the person reads on the card. */
export const REAPED =
  "服务在这一步没有跑完（进程重启或中断），流水线按失败结束，不会自动重跑。";

export async function reapAbandonedPipelineRuns(
  database: Database,
  board: TaskProjector,
  input: { olderThanMs: number },
): Promise<number> {
  const stranded = await runAsTenant("platform", async () =>
    database
      .select({
        id: groupTaskRuns.id,
        tenantId: groupTaskRuns.tenantId,
        parentTaskId: groupTaskRuns.parentTaskId,
        steps: groupTaskRuns.steps,
        revision: groupTaskRuns.revision,
      })
      .from(groupTaskRuns)
      .where(
        and(
          eq(groupTaskRuns.status, "running"),
          sql`${groupTaskRuns.updatedAt} < now() - (${input.olderThanMs} * interval '1 millisecond')`,
        ),
      ),
  );

  let reaped = 0;
  for (const row of stranded) {
    const records = Array.isArray(row.steps) ? row.steps : [];
    const open = records.filter((record) => !stepIsSettled(record.state));
    /*
     * A step that never started is reported the same way as one that stopped halfway.
     *
     * Both are "did not happen", and the run is over. Leaving them `pending` would have a closed run
     * claim a future that is not coming, which is the shape `advance` deliberately keeps for a middle
     * step that refused — that one is about *why* the crew stopped; this one is about the crew not
     * being able to stop again.
     */
    const [closed] = await runAsTenant(row.tenantId, async () => {
      return await database
        .update(groupTaskRuns)
        .set({
          status: "failed",
          advanceOwner: null,
          revision: sql`${groupTaskRuns.revision} + 1`,
          steps: records.map<PipelineStepStateRow>((record) =>
            stepIsSettled(record.state)
              ? record
              : { ...record, state: "failed", error: REAPED },
          ),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(groupTaskRuns.id, row.id),
            eq(groupTaskRuns.status, "running"),
            eq(groupTaskRuns.revision, row.revision),
            sql`${groupTaskRuns.updatedAt} < now() - (${input.olderThanMs} * interval '1 millisecond')`,
          ),
        )
        .returning({ id: groupTaskRuns.id });
    });
    if (!closed) continue;
    reaped++;
    /*
     * Every card still open goes closed with it, including the parent.
     *
     * Awaited rather than fired off: a run reported as over whose cards still say "running" is the
     * half-answer ticket 032 was written against, and the board is what the person reads. The parent
     * card is keyed by the run id itself (see `store.ts`'s `start`), which is why no lookup is needed
     * to close it.
     */
    for (const record of open) {
      if (!record.runRef) continue;
      await board
        .finished({
          tenantId: row.tenantId,
          runRef: record.runRef,
          failed: true,
        })
        .catch(() => undefined);
    }
    if (row.parentTaskId) {
      await board
        .finished({ tenantId: row.tenantId, runRef: row.id, failed: true })
        .catch(() => undefined);
    }
  }
  return reaped;
}
