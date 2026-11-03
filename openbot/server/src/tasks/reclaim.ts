import { and, eq, inArray, or, sql } from "drizzle-orm";
import {
  responsibilityRuns,
  routineRuns,
  tasks,
  workItems,
} from "../db/schema";

/**
 * The work-queue kind of an `@` dispatch from a 1:1 conversation (`channels/dispatch.ts`).
 *
 * Declared here, and re-exported there, because this is the file that reads it as a ledger: the
 * CronJob builds the sweep from this module and must not have to import the dispatch route to do it.
 */
export const DISPATCH_LEDGER_KIND = "channel.dispatch";

/**
 * Which unattended cards this pass may close, and why age alone is not the answer.
 *
 * A card left at `running` by a process that never came back is a real fault: `running` is what the
 * board counts as in progress and what a coworker's status line reads as "answering right now", so an
 * abandoned firing sits on somebody's board for ever. Closing those cards is what `reclaimAbandoned`
 * does. Closing the WRONG ones is worse than leaving them — a card that says "failed" while its run is
 * still executing tells the person the work is dead, and they move on while it writes to their world.
 *
 * So the age test is necessary and not sufficient. The horizon (`ABANDONED_RUN_MS`, ten minutes) is a
 * bound on how long a card may be unexplained, while the ledger below is the statement about whether it
 * still is explained: device-mode work can queue while a laptop is offline, and one legitimate slow
 * turn can outlive any timeout an author guesses. A card whose run row is still open is not a wreck,
 * however old its `updated_at` says it is.
 *
 * TWO LEDGERS, because the two engines keep two books and their "open" are not the same set:
 * `routine_runs.status` is left NULL while a firing is in flight and only written when it settles,
 * while `responsibility_runs.status` starts at `queued` and has a `running` value of its own. Reading
 * one table's vocabulary onto the other is exactly the mistake this file exists to prevent: as
 * `queued`, a responsibility run would look terminal to a routine-shaped test, and the sweep would
 * close cards for work about to happen.
 *
 * WHAT IS DELIBERATELY NOT HERE.
 *
 * - `source = 'group_run'`. A crew's cards are reconciled by `pipeline/reap.ts`, which reads the run
 *   row and its steps and closes the parent and the parked step together. A generic pass cannot see
 *   that a step's `runRef` is the step's own turn rather than the crew's run, so it would either miss
 *   the parent or close a step the crew is about to resume.
 * - `source = 'chat'`, with ONE exception. A card that outlives a closed browser tab is the board
 *   remembering a conversation, not a job somebody abandoned. The exception is a chat card filed by an
 *   `@` dispatch (spec B2): that turn runs on the server with nobody's browser behind it, exactly like a
 *   routine firing, and it keeps a ledger of its own — its `channel.dispatch` work item, keyed by the
 *   card's `run_ref`. A dispatch card is closed when that row says the turn is no longer in flight:
 *   finished, or handed out (the queue hands a dispatch out once) and no longer leased. A row still
 *   waiting to be claimed is a backlog, not a wreck. A chat card with no such row is never touched.
 * - `status = 'needs_action'`. Those cards are held against an approval row, which is a person's claim
 *   to answer, not a crashed process's leftover: deciding it — either way — moves the card through
 *   `board.resumed`. Reaping by age would silently retire a decision somebody is coming back to make,
 *   and leave the approval row pointing at a card nobody was told about.
 */
export function staleUnattendedCards(olderThanMs: number) {
  return and(
    or(
      inArray(tasks.source, ["routine", "responsibility"]),
      and(
        eq(tasks.source, "chat"),
        sql`exists (
          select 1 from ${workItems}
          where ${workItems.kind} = ${DISPATCH_LEDGER_KIND}
            and ${workItems.key} = ${tasks.runRef}
        )`,
      ),
    ),
    eq(tasks.status, "running"),
    sql`${tasks.updatedAt} < now() - (${olderThanMs} * interval '1 millisecond')`,
    /*
     * Not open in EITHER ledger, so each card is asked of the book its own source keeps. The `source`
     * guard on each half is what makes that true: without it a routine card would be kept alive by
     * somebody else's queued responsibility run that happened to share its id, and the ids are uuids,
     * so the collision is not possible — but a predicate that only works because of a fact about the
     * ids is a predicate nobody can re-derive in six months.
     */
    sql`not (
      ${tasks.source} = 'routine'
      and exists (
        select 1 from ${routineRuns}
        where ${routineRuns.id} = ${tasks.runRef}
          and (${routineRuns.status} is null or ${routineRuns.status} = 'waiting')
      )
    )`,
    sql`not (
      ${tasks.source} = 'responsibility'
      and exists (
        select 1 from ${responsibilityRuns}
        where ${responsibilityRuns.id} = ${tasks.runRef}
          and ${responsibilityRuns.status} in ('queued', 'running', 'waiting')
      )
    )`,
    sql`not (
      ${tasks.source} = 'chat'
      and exists (
        select 1 from ${workItems}
        where ${workItems.kind} = ${DISPATCH_LEDGER_KIND}
          and ${workItems.key} = ${tasks.runRef}
          and ${workItems.finishedAt} is null
          and (${workItems.attempts} = 0 or ${workItems.leaseUntil} > now())
      )
    )`,
  );
}
