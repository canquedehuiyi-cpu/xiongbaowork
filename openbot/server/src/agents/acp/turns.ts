import { and, asc, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { Database } from "../../db/client";
import { type AcpTurnStatus, acpTurns } from "../../db/schema";
import { runAsTenant } from "../../tenant/context";

/**
 * The turns of external employees (Codex, Claude Code, Hermes on the owner's computer), one row
 * each, from the server queueing a turn to the device ending it.
 *
 * A TURN WAITS IN ITS LANE. A lane is one employee in one conversation thread: the device keeps
 * each `(agentId, threadId)` apart (its own ACP session), so two threads, or two employees in one
 * group thread, run side by side on one computer, while the turns of one lane go one after another
 * in the order they were queued. Not the computer-action queue (devices/queue.ts), which runs one
 * action per device and pauses the whole device on an unknown outcome; a turn waiting hours for a
 * permission answer holds only its own lane.
 *
 * `queued`: not on the device yet. `sent`: written to the device, not acknowledged. `running` /
 * `awaiting` (a permission answer): the device has it. `done`, `interrupted` (the adapter's process
 * went away, or the device no longer knows the turn), `cancelled`: over, and FINAL: nothing changes
 * a final row again, so a replayed end or a late cancel cannot reopen or re-end a turn.
 */

/** The device has the turn (or was just given it): its lane is busy. */
export const ACTIVE_ACP_TURN_STATUSES = [
  "sent",
  "running",
  "awaiting",
] as const satisfies readonly AcpTurnStatus[];

/** Over. A row in one of these is never changed again. */
export const FINAL_ACP_TURN_STATUSES = [
  "done",
  "interrupted",
  "cancelled",
] as const satisfies readonly AcpTurnStatus[];

export function isFinalAcpTurnStatus(status: string): boolean {
  return (FINAL_ACP_TURN_STATUSES as readonly string[]).includes(status);
}

export type AcpTurnRow = typeof acpTurns.$inferSelect;

export type AcpTurnStore = {
  /** Queue a turn. A `turnId` already stored is left as it is. */
  enqueue(turn: {
    tenantId: string;
    agentId: string;
    threadId: string;
    deviceId: string;
    turnId: string;
    prompt: unknown;
  }): Promise<void>;
  /**
   * The lane's next turn: its oldest `queued` one, or null when none is queued or one of the lane's
   * turns is still active (`sent`, `running`, `awaiting`).
   */
  nextForThread(
    tenantId: string,
    threadId: string,
    agentId: string,
  ): Promise<AcpTurnRow | null>;
  /** Every `queued` turn for this device, oldest first. */
  queuedForDevice(tenantId: string, deviceId: string): Promise<AcpTurnRow[]>;
  /**
   * Moves a turn to `status` (and `lastSeq` up to `lastSeq`), in the caller's tenant frame. False when
   * the turn is not there for that tenant or is already final.
   */
  setStatus(
    turnId: string,
    status: AcpTurnStatus,
    lastSeq?: number,
  ): Promise<boolean>;
  /** The employee's turns the device has not taken yet (`queued` and `sent`). */
  countQueued(tenantId: string, agentId: string): Promise<number>;
  get(tenantId: string, turnId: string): Promise<AcpTurnRow | null>;
  /** This device's `sent`, `running` and `awaiting` turns, oldest first. */
  activeForDevice(tenantId: string, deviceId: string): Promise<AcpTurnRow[]>;
  /**
   * The lane's turns on this device that are not over, oldest first; null when this device never
   * had a turn of that lane (its frames are not this tenant's to take in).
   */
  openInLane(
    tenantId: string,
    deviceId: string,
    agentId: string,
    threadId: string,
  ): Promise<AcpTurnRow[] | null>;
  /** `queued` → `sent`, once: the row when this call took it, null otherwise. */
  claim(tenantId: string, turnId: string): Promise<AcpTurnRow | null>;
  /** `sent` → `queued`, for a claimed turn that could not be started. */
  unclaim(tenantId: string, turnId: string): Promise<void>;
  /** Raises `lastSeq` (never lowers it), whatever the status. */
  recordSeq(tenantId: string, turnId: string, lastSeq: number): Promise<void>;
};

export function createAcpTurnStore(database: Database): AcpTurnStore {
  const inLane = (tenantId: string, threadId: string, agentId: string) =>
    and(
      eq(acpTurns.tenantId, tenantId),
      eq(acpTurns.threadId, threadId),
      eq(acpTurns.agentId, agentId),
    );
  const oldestFirst = [asc(acpTurns.createdAt), asc(acpTurns.id)] as const;
  const raise = (lastSeq: number) =>
    sql`greatest(${acpTurns.lastSeq}, ${lastSeq})`;

  return {
    async enqueue(turn) {
      await runAsTenant(turn.tenantId, () =>
        database
          .insert(acpTurns)
          .values({
            tenantId: turn.tenantId,
            agentId: turn.agentId,
            threadId: turn.threadId,
            deviceId: turn.deviceId,
            turnId: turn.turnId,
            status: "queued",
            prompt: turn.prompt,
          })
          .onConflictDoNothing({ target: acpTurns.turnId }),
      );
    },

    async nextForThread(tenantId, threadId, agentId) {
      return runAsTenant(tenantId, async () => {
        const [busy] = await database
          .select({ id: acpTurns.id })
          .from(acpTurns)
          .where(
            and(
              inLane(tenantId, threadId, agentId),
              inArray(acpTurns.status, [...ACTIVE_ACP_TURN_STATUSES]),
            ),
          )
          .limit(1);
        if (busy) return null;
        const [next] = await database
          .select()
          .from(acpTurns)
          .where(
            and(
              inLane(tenantId, threadId, agentId),
              eq(acpTurns.status, "queued"),
            ),
          )
          .orderBy(...oldestFirst)
          .limit(1);
        return next ?? null;
      });
    },

    async queuedForDevice(tenantId, deviceId) {
      return runAsTenant(tenantId, () =>
        database
          .select()
          .from(acpTurns)
          .where(
            and(
              eq(acpTurns.tenantId, tenantId),
              eq(acpTurns.deviceId, deviceId),
              eq(acpTurns.status, "queued"),
            ),
          )
          .orderBy(...oldestFirst),
      );
    },

    async setStatus(turnId, status, lastSeq) {
      const rows = await database
        .update(acpTurns)
        .set({
          status,
          updatedAt: sql`now()`,
          ...(lastSeq === undefined ? {} : { lastSeq: raise(lastSeq) }),
        })
        .where(
          and(
            eq(acpTurns.turnId, turnId),
            notInArray(acpTurns.status, [...FINAL_ACP_TURN_STATUSES]),
          ),
        )
        .returning({ id: acpTurns.id });
      return rows.length > 0;
    },

    async countQueued(tenantId, agentId) {
      const [row] = await runAsTenant(tenantId, () =>
        database
          .select({ count: sql<number>`count(*)::int` })
          .from(acpTurns)
          .where(
            and(
              eq(acpTurns.tenantId, tenantId),
              eq(acpTurns.agentId, agentId),
              inArray(acpTurns.status, ["queued", "sent"]),
            ),
          ),
      );
      return row?.count ?? 0;
    },

    async get(tenantId, turnId) {
      const [row] = await runAsTenant(tenantId, () =>
        database
          .select()
          .from(acpTurns)
          .where(
            and(eq(acpTurns.tenantId, tenantId), eq(acpTurns.turnId, turnId)),
          )
          .limit(1),
      );
      return row ?? null;
    },

    async activeForDevice(tenantId, deviceId) {
      return runAsTenant(tenantId, () =>
        database
          .select()
          .from(acpTurns)
          .where(
            and(
              eq(acpTurns.tenantId, tenantId),
              eq(acpTurns.deviceId, deviceId),
              inArray(acpTurns.status, [...ACTIVE_ACP_TURN_STATUSES]),
            ),
          )
          .orderBy(...oldestFirst),
      );
    },

    async openInLane(tenantId, deviceId, agentId, threadId) {
      return runAsTenant(tenantId, async () => {
        const lane = and(
          inLane(tenantId, threadId, agentId),
          eq(acpTurns.deviceId, deviceId),
        );
        const open = await database
          .select()
          .from(acpTurns)
          .where(
            and(
              lane,
              notInArray(acpTurns.status, [...FINAL_ACP_TURN_STATUSES]),
            ),
          )
          .orderBy(...oldestFirst);
        if (open.length > 0) return open;
        const [any] = await database
          .select({ id: acpTurns.id })
          .from(acpTurns)
          .where(lane)
          .limit(1);
        return any ? [] : null;
      });
    },

    async claim(tenantId, turnId) {
      const [row] = await runAsTenant(tenantId, () =>
        database
          .update(acpTurns)
          .set({ status: "sent", updatedAt: sql`now()` })
          .where(
            and(
              eq(acpTurns.tenantId, tenantId),
              eq(acpTurns.turnId, turnId),
              eq(acpTurns.status, "queued"),
            ),
          )
          .returning(),
      );
      return row ?? null;
    },

    async unclaim(tenantId, turnId) {
      await runAsTenant(tenantId, () =>
        database
          .update(acpTurns)
          .set({ status: "queued", updatedAt: sql`now()` })
          .where(
            and(
              eq(acpTurns.tenantId, tenantId),
              eq(acpTurns.turnId, turnId),
              eq(acpTurns.status, "sent"),
            ),
          ),
      );
    },

    async recordSeq(tenantId, turnId, lastSeq) {
      await runAsTenant(tenantId, () =>
        database
          .update(acpTurns)
          .set({ lastSeq: raise(lastSeq) })
          .where(
            and(eq(acpTurns.tenantId, tenantId), eq(acpTurns.turnId, turnId)),
          ),
      );
    },
  };
}
