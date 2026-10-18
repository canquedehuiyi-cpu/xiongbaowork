import { asc, eq, inArray } from "drizzle-orm";
import type { Database } from "../db/client";
import { agents, wakerGroupMembers, wakerGroups } from "../db/schema";
import { currentTenant } from "../tenant/context";

/**
 * The tenant's crews (ticket 023, spec D4).
 *
 * A crew is a name over an ordered set of coworkers, and that is all it is allowed to be: it holds no
 * credential, grants no capability, and decides nothing on its own. What it buys is the ability to say
 * `@编程小组` instead of typing three names, and to point a board filter at the same three.
 */
export type WakerGroupMember = { agentId: string; position: number };

export type WakerGroup = {
  id: string;
  name: string;
  description: string | null;
  members: WakerGroupMember[];
};

export type WakerGroupStore = {
  list: () => Promise<WakerGroup[]>;
  create: (input: {
    name: string;
    description?: string | null;
  }) => Promise<WakerGroup>;
  /** Replace the roster wholesale: a crew is edited as a set, not member by member. */
  setMembers: (
    groupId: string,
    agentIds: string[],
  ) => Promise<WakerGroup | null>;
  remove: (groupId: string) => Promise<boolean>;
};

export class WakerGroupNameError extends Error {
  constructor() {
    super("Give the group a name between 1 and 80 characters.");
    this.name = "WakerGroupNameError";
  }
}

/** A roster may only name coworkers this workspace can see; see `setMembers`. */
export class WakerGroupMemberError extends Error {
  constructor() {
    super("Every coworker in a crew has to be one this workspace can use.");
    this.name = "WakerGroupMemberError";
  }
}

export class WakerGroupNameTakenError extends Error {
  constructor() {
    super("This workspace already has a group by that name.");
    this.name = "WakerGroupNameTakenError";
  }
}

const shape = (
  row: { id: string; name: string; description: string | null },
  members: { agentId: string; position: string }[],
): WakerGroup => ({
  id: row.id,
  name: row.name,
  description: row.description,
  members: members
    .map((member) => ({
      agentId: member.agentId,
      position: Number(member.position) || 0,
    }))
    .sort(
      (a, b) => a.position - b.position || a.agentId.localeCompare(b.agentId),
    ),
});

export function createWakerGroupStore(database: Database): WakerGroupStore {
  return {
    async list() {
      const rows = await database
        .select()
        .from(wakerGroups)
        .orderBy(asc(wakerGroups.name));
      if (rows.length === 0) return [];
      // One extra read rather than one read per group: a workspace with thirty crews would
      // otherwise ask thirty-two times for a screen that is meant to be glanced at.
      const memberships = await database
        .select()
        .from(wakerGroupMembers)
        .where(
          inArray(
            wakerGroupMembers.groupId,
            rows.map((row) => row.id),
          ),
        );
      return rows.map((row) =>
        shape(
          row,
          memberships.filter((entry) => entry.groupId === row.id),
        ),
      );
    },

    async create(input) {
      const name = input.name.trim().slice(0, 80);
      if (name.length === 0) throw new WakerGroupNameError();
      const description =
        typeof input.description === "string" && input.description.trim()
          ? input.description.trim().slice(0, 500)
          : null;
      try {
        const [row] = await database
          .insert(wakerGroups)
          .values({ name, description })
          .returning();
        return shape(row, []);
      } catch (error) {
        // Uniqueness is per tenant, so the database is the only place that can tell a reused name
        // from a name another workspace already uses — and a reused name is a different mistake:
        // silently folding two crews together loses whoever was already in one.
        //
        // The state code arrives on the server's error, which drizzle wraps, and Bun reports it as
        // `errno` while `code` carries its own label — so the check looks one level down and at the
        // field the driver actually fills.
        const violation = error as {
          errno?: string | number;
          cause?: { errno?: string | number };
        };
        const state = String(violation.errno ?? violation.cause?.errno ?? "");
        if (state === "23505") throw new WakerGroupNameTakenError();
        throw error;
      }
    },

    async setMembers(groupId, agentIds) {
      const unique = [...new Set(agentIds)];
      const [group] = await database
        .select()
        .from(wakerGroups)
        .where(eq(wakerGroups.id, groupId))
        .limit(1);
      // Under the tenant's own scope a foreign group id simply is not there, so this is also the
      // check that stops one workspace rewriting another's roster.
      if (!group) return null;
      /*
       * Visible is not the same as theirs.
       *
       * The row-level policy lets a tenant read `system`-owned rows on purpose — a crew the platform
       * ships should show up — and the same policy's WITH CHECK admits `system` because the platform
       * scope writes through it. So a group id can name a row this workspace may look at and must not
       * rewrite. Without this guard, `PUT /api/waker-groups/{systemId}/members` would succeed and
       * edit a crew every other workspace lists.
       */
      if (group.tenantId !== currentTenant()) return null;
      /*
       * A crew is a name over coworkers, so the only thing it can hold is coworkers this workspace
       * can point at. `waker_group_members.agent_id` is plain text with no foreign key, so until now a
       * roster could be written with any string — including another workspace's coworker id, which the
       * screen would then list as one of "our people" and the pipeline step picker would offer as a
       * step owner. Asking which of the names are visible is the same scoping the picker's own list is
       * built under (row-level security), so what can be named is exactly what can be seen.
       */
      const visible =
        unique.length === 0
          ? []
          : await database
              .select({ id: agents.id })
              .from(agents)
              .where(inArray(agents.id, unique));
      if (visible.length !== unique.length) throw new WakerGroupMemberError();
      await database.transaction(async (tx) => {
        await tx
          .delete(wakerGroupMembers)
          .where(eq(wakerGroupMembers.groupId, groupId));
        if (unique.length > 0) {
          await tx.insert(wakerGroupMembers).values(
            unique.map((agentId, position) => ({
              groupId,
              agentId,
              position: String(position),
            })),
          );
        }
        await tx
          .update(wakerGroups)
          .set({ updatedAt: new Date() })
          .where(eq(wakerGroups.id, groupId));
      });
      const memberships = await database
        .select()
        .from(wakerGroupMembers)
        .where(eq(wakerGroupMembers.groupId, groupId));
      return shape(group, memberships);
    },

    async remove(groupId) {
      // The same read-before-write as `setMembers`: retiring a platform-owned crew is not a
      // workspace's call, however visible the row is to it.
      const [target] = await database
        .select({ tenantId: wakerGroups.tenantId })
        .from(wakerGroups)
        .where(eq(wakerGroups.id, groupId))
        .limit(1);
      if (!target || target.tenantId !== currentTenant()) return false;
      const [removed] = await database
        .delete(wakerGroups)
        .where(eq(wakerGroups.id, groupId))
        .returning({ id: wakerGroups.id });
      return Boolean(removed);
    },
  };
}
