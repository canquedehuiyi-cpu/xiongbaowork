import { and, asc, eq, gte } from "drizzle-orm";
import {
  type ChannelActivityEvent,
  notifyChannelActivity,
  type StateDeltaOperation,
} from "../channels/events";
import type { Database } from "../db/client";
import { tasks } from "../db/schema/tasks";
import { runAsTenant } from "../tenant/context";

/**
 * Pilot: tell a person's open board which of their cards moved, as the JSON Patch of an AG-UI
 * `STATE_DELTA`, over the channel socket that already carries `taskUpdated`.
 *
 * The page treats it as "read these cards again", so a lost or late one costs nothing the next poll
 * does not repair. What it carries is a card's id and its status, never its title or anything the
 * card holds: the delta is a hint about where to look, and the read that follows is what shows a
 * person the card, under their own frame.
 *
 * Who may hear it is decided here, by the writer, the way every announcement on this rail is. The
 * cards are read in the tenant's own frame, where row-level security answers "can this person see
 * it"; a card that has moved to somebody else, or is gone, is not returned and so is not announced.
 */

/** Cards in one message. A NOTIFY payload is capped near 8 kB, and a board past this is read afresh. */
const MAX_CARDS_PER_PUSH = 40;

/**
 * How far back a read reaches beyond the last card it announced. The rows' own clock stamps them
 * and two writers can commit out of that order, so a card stamped a moment before the newest one
 * announced may only now be visible. Announcing it twice is harmless.
 */
const OVERLAP_MS = 2_000;

/** Where a tenant's first read starts: the change that caused it was a moment ago. */
const FIRST_READ_MS = 10_000;

/** People whose watermark is held. Past this the map is dropped and every read starts afresh. */
const MAX_TENANTS_HELD = 5_000;

type CardRow = {
  id: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * The cards that moved, as patch operations. A card made after `since` (the newest card the last
 * push named) is added with its status; one that was already there has its status replaced.
 */
export function boardStateDelta(
  rows: readonly CardRow[],
  since: Date,
): StateDeltaOperation[] {
  return rows.map((row) =>
    row.createdAt > since
      ? { op: "add", path: `/tasks/${row.id}`, value: { status: row.status } }
      : {
          op: "replace",
          path: `/tasks/${row.id}/status`,
          value: row.status,
        },
  );
}

export type BoardPush = {
  /** Announce a tenant's moved cards. Never rejects; a lost push leaves the page to its next poll. */
  announce(tenantId: string): Promise<void>;
};

export function createBoardPush(
  database: Database,
  options: { enabled: boolean; now?: () => Date },
): BoardPush {
  const now = options.now ?? (() => new Date());
  const announced = new Map<string, Date>();

  const failed = (tenantId: string, error: unknown) => {
    const code =
      typeof error === "object" &&
      error !== null &&
      typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code
        : undefined;
    console.error(
      JSON.stringify({
        type: "board-push-failed",
        tenantId,
        error: error instanceof Error ? error.name : typeof error,
        ...(code === undefined ? {} : { code }),
      }),
    );
  };

  return {
    async announce(tenantId) {
      if (!options.enabled) return;
      try {
        await runAsTenant(tenantId, async () => {
          const lastSeen =
            announced.get(tenantId) ??
            new Date(now().getTime() - FIRST_READ_MS);
          const since = new Date(lastSeen.getTime() - OVERLAP_MS);
          // The tenant's own, twice over: the frame's row-level security, and the column asked of.
          const rows = await database
            .select({
              id: tasks.id,
              status: tasks.status,
              createdAt: tasks.createdAt,
              updatedAt: tasks.updatedAt,
            })
            .from(tasks)
            .where(
              and(eq(tasks.tenantId, tenantId), gte(tasks.updatedAt, since)),
            )
            .orderBy(asc(tasks.updatedAt))
            .limit(MAX_CARDS_PER_PUSH);
          const newest = rows.at(-1);
          if (!newest) return;
          if (announced.size >= MAX_TENANTS_HELD) announced.clear();
          announced.set(tenantId, newest.updatedAt);
          const event = {
            channelId: "",
            memberIds: [tenantId],
            lastMessage: null,
            lastMessageAt: null,
            lastMessageAgentId: null,
            stateDelta: boardStateDelta(rows, lastSeen),
          } satisfies ChannelActivityEvent;
          await notifyChannelActivity(database, event);
        });
      } catch (error) {
        failed(tenantId, error);
      }
    },
  };
}
