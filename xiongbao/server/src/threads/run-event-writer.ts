import type { BaseEvent } from "@ag-ui/client";
import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { threadRunEvents, threadRuns, threads } from "../db/schema";
import { runAsTenant } from "../tenant/context";
import { createRunEventCompactor } from "./run-event-compaction";

/**
 * A turn's events, written to PostgreSQL while the turn is still running (期九·二).
 *
 * They used to be written once, when the turn ended, so a process that stopped half way through a
 * twenty-five minute turn left nothing of it. The writer is fed every event of the turn in order and
 * writes what has settled each time it is asked to {@link RunEventWriter.flush}; {@link RunEventWriter.finish}
 * writes what is left. Together they store exactly what one write of the whole turn stored: the same
 * rows, the same `seq` for each, because the joining of consecutive deltas
 * (`run-event-compaction.ts`) is done by one compactor that only ever holds back the delta still being
 * joined.
 *
 * Rows are inserted with `ON CONFLICT DO NOTHING` on (thread, run, seq), so a write that is repeated
 * adds nothing, and one that failed is simply tried again with the next flush: the rows it did not
 * land stay queued, with the same `seq` they were given.
 */

/** Rows of one run's events per INSERT: four parameters each, well inside the driver's 65534. */
export const EVENT_INSERT_BATCH = 2000;

/** A turn is written once this many of its events have come in since the last write... */
export const FLUSH_EVERY_EVENTS = 200;
/** ...or this long after the last write, whichever comes first. It is also the turn's heartbeat. */
export const FLUSH_EVERY_MS = 5_000;

export type RunWriteTarget = {
  tenant: string;
  threadId: string;
  runId: string;
  agentId: string;
  startedAt: number;
};

export class RunEventWriter {
  private readonly compactor = createRunEventCompactor();
  /** Settled rows taken from the compactor and not yet in the database, with the `seq` they get. */
  private queued: BaseEvent[] = [];
  /** How many rows are in the database, which is the next row's `seq`. */
  private written = 0;
  private headed = false;
  private pushed = 0;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly database: Database,
    private readonly target: RunWriteTarget,
  ) {}

  /** Events fed in since the last write was asked for: what the count trigger reads. */
  get pending(): number {
    return this.pushed;
  }

  /** Whether anything of the turn is in the database. */
  get started(): boolean {
    return this.headed;
  }

  push(event: BaseEvent): void {
    this.compactor.push(event);
    this.pushed += 1;
  }

  private flushing = false;

  /** {@link flush}, unless a write is still in flight: a slow database is not given a queue of them. */
  flushSoon(): void {
    if (this.flushing) return;
    this.flushing = true;
    void this.flush().finally(() => {
      this.flushing = false;
    });
  }

  /** Write what has settled, and stamp the turn as alive. Never rejects; a failure is logged and retried. */
  flush(): Promise<void> {
    this.pushed = 0;
    return this.enqueue(false, undefined);
  }

  /**
   * Write the rest, and mark the turn finished. `snapshot` is the thread's messages as of the turn's
   * end; it is written first, as it always was.
   */
  finish(snapshot?: unknown[]): Promise<void> {
    this.pushed = 0;
    return this.enqueue(true, snapshot);
  }

  private enqueue(final: boolean, snapshot: unknown[] | undefined) {
    // The settled rows are taken in call order, and written in the same order.
    this.queued.push(...(final ? this.compactor.end() : this.compactor.take()));
    const next = this.chain.then(() => this.write(final, snapshot));
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async write(
    final: boolean,
    snapshot: unknown[] | undefined,
  ): Promise<void> {
    const { tenant, threadId, runId, agentId, startedAt } = this.target;
    // The macrotask that lands this write has no async-local-storage frame of the request that
    // produced it, so the tenant is re-entered here by hand. Without it the connection runs as
    // `system`, row-level security filters the row out of its own UPDATE, and nothing is written.
    await runAsTenant(tenant, async () => {
      try {
        if (!this.headed || final) {
          await this.database
            .insert(threads)
            .values({
              id: threadId,
              tenantId: tenant,
              agentId,
              createdAt: new Date(startedAt),
            })
            .onConflictDoNothing();
        }
        if (final && snapshot)
          await this.database
            .update(threads)
            .set({ messagesSnapshot: snapshot, updatedAt: new Date() })
            .where(eq(threads.id, threadId));
        if (!this.headed) {
          await this.database
            .insert(threadRuns)
            .values({
              id: runId,
              threadId,
              agentId,
              eventCount: 0,
              status: final ? "finished" : "running",
              heartbeatAt: new Date(),
            })
            .onConflictDoNothing();
          this.headed = true;
        }
        /*
         * Taken before anything is awaited: rows queued while this write is in flight belong to the next
         * one, and a failed write puts these back in front of them with the `seq` they were given.
         */
        const first = this.written;
        const rows = this.queued;
        this.queued = [];
        try {
          /*
           * One INSERT binds four parameters a row and the driver takes 65534, so a run past 16383
           * events lost every one of them at once, and a thinking run is made of one event per token.
           * Written in batches, inside one transaction with the count: they all land or none do.
           */
          await this.database.transaction(async (transaction) => {
            for (let at = 0; at < rows.length; at += EVENT_INSERT_BATCH)
              await transaction
                .insert(threadRunEvents)
                .values(
                  rows
                    .slice(at, at + EVENT_INSERT_BATCH)
                    .map((event, offset) => ({
                      threadId,
                      runId,
                      seq: first + at + offset,
                      event,
                    })),
                )
                .onConflictDoNothing();
            await transaction
              .update(threadRuns)
              .set({
                eventCount: first + rows.length,
                heartbeatAt: new Date(),
                ...(final ? { status: "finished" } : {}),
              })
              .where(
                and(
                  eq(threadRuns.id, runId),
                  // A turn the sweep already called interrupted is not moved back to running.
                  ...(final ? [] : [eq(threadRuns.status, "running")]),
                ),
              );
          });
          this.written = first + rows.length;
        } catch (error) {
          this.queued = [...rows, ...this.queued];
          throw error;
        }
      } catch (error) {
        console.error("thread persistence failed", threadId, error);
      }
    });
  }
}
