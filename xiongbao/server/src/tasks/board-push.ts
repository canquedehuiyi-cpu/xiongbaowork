import { and, asc, desc, eq, gt, gte, or, sql } from "drizzle-orm";
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

/**
 * Cards in one message. A NOTIFY payload is capped near 8 kB. A read that fills it has more behind
 * it than one message can name, so it says "the board changed" and names no card (see `WHOLE_BOARD`).
 */
export const MAX_CARDS_PER_PUSH = 40;

/**
 * How far back a read also looks for cards that committed late. The rows stamp themselves with
 * their writer's clock, and two writers can commit out of that order, so a card stamped a moment
 * before the newest one announced may only now be visible. Cards already announced are remembered
 * and skipped, so this never reads the same ones back.
 */
const OVERLAP_MS = 2_000;

/** Late-commit reads are bounded too: past this many rows in the window, only the sweep is trusted. */
const LATE_READ_LIMIT = 200;

/** Where a tenant's first read starts: the change that caused it was a moment ago. */
const FIRST_READ_MS = 10_000;

/** People whose position is held. Past this the map is dropped and every read starts afresh. */
const MAX_TENANTS_HELD = 5_000;

/** Sorts before every card id: where a tenant's first read starts within its first millisecond. */
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/** The one operation that names no card: the whole board is to be read again. */
export const WHOLE_BOARD: StateDeltaOperation = {
  op: "replace",
  path: "/tasks",
  value: null,
};

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

/** Where a tenant's last read ended: the newest (stamp, id) announced, and what was announced near it. */
type Position = { at: Date; id: string; recent: Map<string, number> };

/**
 * Stamps compared to the millisecond. The rows keep microseconds and a JavaScript Date does not, so
 * a stamp read back and compared with the column would differ by the lost fraction and the same row
 * would be read again for ever.
 */
const stamp = sql<Date>`date_trunc('milliseconds', ${tasks.updatedAt})`;

export function createBoardPush(
  database: Database,
  options: { enabled: boolean; now?: () => Date },
): BoardPush {
  const now = options.now ?? (() => new Date());
  const positions = new Map<string, Position>();

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

  const columns = {
    id: tasks.id,
    status: tasks.status,
    createdAt: tasks.createdAt,
    updatedAt: tasks.updatedAt,
  };

  return {
    async announce(tenantId) {
      if (!options.enabled) return;
      try {
        await runAsTenant(tenantId, async () => {
          const position = positions.get(tenantId) ?? {
            at: new Date(now().getTime() - FIRST_READ_MS),
            id: NIL_UUID,
            recent: new Map<string, number>(),
          };
          const after = or(
            gt(stamp, position.at),
            and(eq(stamp, position.at), gt(tasks.id, position.id)),
          );
          // The tenant's own, twice over: the frame's row-level security, and the column asked of.
          const swept = await database
            .select(columns)
            .from(tasks)
            .where(and(eq(tasks.tenantId, tenantId), after))
            .orderBy(asc(stamp), asc(tasks.id))
            .limit(MAX_CARDS_PER_PUSH);
          const full = swept.length >= MAX_CARDS_PER_PUSH;

          // Cards that committed late, stamped before the position: not announced yet, if not remembered.
          let late: CardRow[] = [];
          if (!full) {
            const window = new Date(position.at.getTime() - OVERLAP_MS);
            const behind = await database
              .select(columns)
              .from(tasks)
              .where(
                and(
                  eq(tasks.tenantId, tenantId),
                  gte(stamp, window),
                  sql`not (${after})`,
                ),
              )
              .orderBy(desc(stamp), asc(tasks.id))
              .limit(LATE_READ_LIMIT);
            late = behind
              .filter(
                (row) =>
                  position.recent.get(row.id) !== row.updatedAt.getTime(),
              )
              .slice(0, MAX_CARDS_PER_PUSH - swept.length);
          }

          const moved = [...swept, ...late];
          const newest = swept.at(-1);
          if (newest) {
            if (positions.size >= MAX_TENANTS_HELD) positions.clear();
            const recent = position.recent;
            for (const row of moved)
              recent.set(row.id, row.updatedAt.getTime());
            const floor = newest.updatedAt.getTime() - OVERLAP_MS;
            for (const [id, at] of recent) if (at < floor) recent.delete(id);
            positions.set(tenantId, {
              at: newest.updatedAt,
              id: newest.id,
              recent: recent.size > LATE_READ_LIMIT ? new Map() : recent,
            });
          } else if (late.length > 0) {
            for (const row of late)
              position.recent.set(row.id, row.updatedAt.getTime());
          }
          if (moved.length === 0) return;
          const event = {
            channelId: "",
            memberIds: [tenantId],
            lastMessage: null,
            lastMessageAt: null,
            lastMessageAgentId: null,
            stateDelta: full
              ? [WHOLE_BOARD]
              : boardStateDelta(moved, position.at),
          } satisfies ChannelActivityEvent;
          await notifyChannelActivity(database, event);
        });
      } catch (error) {
        failed(tenantId, error);
      }
    },
  };
}
