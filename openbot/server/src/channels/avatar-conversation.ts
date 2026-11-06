import { and, asc, eq, inArray, isNull, notExists, sql } from "drizzle-orm";
import type { AgentActor } from "../agents/profile-types";
import type { Database } from "../db/client";
import {
  agentProfiles,
  agents,
  channelAgents,
  channelMemberships,
  channels,
} from "../db/schema";
import { currentTenant, isTenantFramed } from "../tenant/context";
import { avatarAgentId } from "../tenant/provisioning";

/**
 * Every person's conversation with their own 分身, made the first time they open the app.
 *
 * WHY. With `TENANT_RUNTIME=device` a Bot's computer actions run on the paired machine of the Bot's
 * OWNER (`devices/selection.ts`), and the only Bot a person owns from the start is their 分身
 * (`avatar-<person>`, `tenant/provisioning.ts`). On a deployment with sign-in nothing gave them a
 * conversation with it: the brand package's conversations are written per person only in single-user
 * mode, so the first conversation a person had was whatever the home composer picked, which was the
 * first catalogue Bot -- in the 熊宝 package one that was also called 我的分身 and belongs to nobody,
 * so it could never use their machine. Found on a real deployment on 2026-11-06.
 *
 * WHEN. On the person's own channel list read, in their own frame, because that is the first thing the
 * app does for a signed-in person and it covers both a new sign-up and somebody who signed up before
 * this existed, without a start-up sweep over every workspace. Once per person per process: after
 * that it is one Set lookup.
 *
 * ONCE EVER, NOT ONCE PER START. A 分身 conversation the person deleted counts as one they had, so it
 * is not handed back to them after the next restart.
 *
 * AND THE NAME THAT COLLIDED. A conversation's name is a snapshot of its Bots' names when it was made.
 * One made with the catalogue Bot while that Bot was called 我的分身 still says 我的分身 after the
 * Bot is renamed, next to the real one. Any conversation of this person's that carries their 分身's
 * name without having their 分身 in it is renamed from its Bots' current names, the way it would be
 * named if it were made today. Only the person's own rows, and only that collision: a name they chose
 * that says something else is left alone.
 */
export async function ensureAvatarConversation(
  deps: {
    database: Database;
    /** The store's find-or-make for a one-Bot conversation; it holds the per-pair lock. */
    direct: (actor: AgentActor, agentId: string) => Promise<unknown>;
    /** How the store names a conversation from its Bots' names, so a rename matches a fresh one. */
    channelName: (names: string[]) => string;
  },
  actor: AgentActor,
): Promise<void> {
  // Only in the person's own frame: anywhere else the rows below would carry the wrong stamp.
  if (!isTenantFramed() || currentTenant() !== actor.id) return;
  const { database } = deps;
  const avatarId = avatarAgentId(actor.id);

  const [avatar] = await database
    .select({ name: agents.name, deletedAt: agentProfiles.deletedAt })
    .from(agents)
    .innerJoin(agentProfiles, eq(agentProfiles.agentId, agents.id))
    .where(eq(agents.id, avatarId))
    .limit(1);
  // No 分身, or one the person retired: nothing to talk to, and nothing to make.
  if (!avatar || avatar.deletedAt !== null) return;

  const [had] = await database
    .select({ id: channels.id })
    .from(channels)
    .innerJoin(
      channelMemberships,
      and(
        eq(channelMemberships.channelId, channels.id),
        eq(channelMemberships.userId, actor.id),
      ),
    )
    .innerJoin(
      channelAgents,
      and(
        eq(channelAgents.channelId, channels.id),
        eq(channelAgents.agentId, avatarId),
      ),
    )
    // Deleted ones included on purpose; see "once ever" above.
    .where(
      sql`(select count(*) from ${channelAgents} where ${channelAgents.channelId} = ${channels.id}) = 1`,
    )
    .limit(1);
  if (!had) await deps.direct(actor, avatarId);

  const colliding = await database
    .select({ id: channels.id, name: channels.name })
    .from(channels)
    .innerJoin(
      channelMemberships,
      and(
        eq(channelMemberships.channelId, channels.id),
        eq(channelMemberships.userId, actor.id),
      ),
    )
    .where(
      and(
        eq(channels.tenantId, actor.id),
        // A package's conversation is named by its package, on every start.
        isNull(channels.packageId),
        isNull(channels.deletedAt),
        notExists(
          database
            .select({ one: sql`1` })
            .from(channelAgents)
            .where(
              and(
                eq(channelAgents.channelId, channels.id),
                eq(channelAgents.agentId, avatarId),
              ),
            ),
        ),
      ),
    );
  const stale = colliding.filter((row) =>
    row.name
      .replace(/…$/u, "")
      .split(", ")
      .some((segment) => segment === avatar.name),
  );
  if (stale.length === 0) return;

  const bots = await database
    .select({ channelId: channelAgents.channelId, name: agents.name })
    .from(channelAgents)
    .innerJoin(agents, eq(agents.id, channelAgents.agentId))
    .where(
      inArray(
        channelAgents.channelId,
        stale.map((row) => row.id),
      ),
    )
    // The order a conversation is named in: its Bots by id, as `parseChannelInput` sorts them.
    .orderBy(asc(channelAgents.channelId), asc(channelAgents.agentId));
  for (const row of stale) {
    const names = bots
      .filter((bot) => bot.channelId === row.id)
      .map((bot) => bot.name);
    if (names.length === 0) continue;
    const renamed = deps.channelName(names);
    // Still the same name means its Bot still carries the 分身's name; renaming would change nothing.
    if (renamed === row.name) continue;
    await database
      .update(channels)
      .set({ name: renamed, updatedAt: new Date() })
      .where(and(eq(channels.id, row.id), eq(channels.tenantId, actor.id)));
  }
}
