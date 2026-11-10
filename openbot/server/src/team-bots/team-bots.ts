/**
 * Team Bots: one Bot, published by its owner, used by teammates in chats of their own.
 *
 * WHO SEES IT. `teamBotAccess` is the one rule, added to the same SQL gate that already admits public
 * Bots and a person's own (`profile-store.ts` `accessFilter`, `runtime-agents.ts`), so the roster, the
 * runtime, handoffs and groups all see a Team Bot exactly where its publication says. No publication
 * row, no access: unpublishing is one delete.
 *
 * PRIVATE CHATS. A teammate's conversation is an ordinary channel of their own, and channels are
 * membership-scoped, so the owner cannot read it and it cannot read theirs. Nothing here changes that.
 *
 * WHOSE ACCOUNTS. A Team Bot reaches a connected app as its OWNER when the owner has connected it,
 * the same for everyone. A teammate's OWN account on a server the owner has not connected is used
 * only with their consent: Allow once, Always allow for this Bot, or Skip. Everything else about the
 * call (grant, policy, approvals, audit) is still decided as the teammate who is asking.
 *
 * WHERE THE ROWS LIVE (G01-E P9). A published Bot lives in the shared `team` tenant, moved there by
 * its owner (`moveToTeam`), and its publication, audience and assignment rows are stamped `team` too:
 * row security shows them to a teammate only where `openbot_team_bot_visible` admits the Bot. The
 * owner writes the publication and audience in their own frame; an administrator assigns with the
 * capability, and unpublishes another person's Bot in that OWNER's frame (`adminActAsOwner`, opened
 * by the route), so the Bot goes back to its owner exactly as if the owner had unpublished it.
 * Migration 0126 refuses a roster row stamped anything but `team` outside `platform`: the three
 * tables are keyed by agent id, and a row a stranger stamped with their own tenant would otherwise
 * hold the key and block the owner's publish.
 */
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { capabilityRefusal } from "../admin/capabilities";
import { enterpriseControls } from "../admin/controls";
import {
  moveToOwner,
  moveToTeam,
  OwnerlessBotPrivateError,
} from "../agents/profile-store";
import type { AgentActor } from "../agents/profile-types";
import type { Database } from "../db/client";
import { agents, users } from "../db/schema/core";
import { agentProfiles } from "../db/schema/coworker";
import {
  teamBotAssignments,
  teamBotAudience,
  teamBotConsentDefaults,
  teamBotConsents,
  teamBotPublications,
} from "../db/schema/team-bots";
import { PLATFORM_TENANT, TEAM_TENANT } from "../db/schema/tenant";
import { PluginRefusedError } from "../plugins/store";
import { capabilityFor, currentTenant } from "../tenant/context";
import {
  assignedCondition,
  describedForTeam,
  PLACEHOLDER_BOT_NAMES,
  teamBotAccess,
} from "./access";

export { teamBotAccess } from "./access";

/** Prefix a consent refusal carries, so a chat can draw the card instead of the sentence. */
export const TEAM_BOT_CONSENT_MARKER = "[team-bot-consent]";

export class TeamBotRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TeamBotRefusedError";
  }
}
/** The person may not publish Team Bots at all: an administrator turned the switch off. */
export class TeamBotForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TeamBotForbiddenError";
  }
}

export class TeamBotNotFoundError extends Error {
  constructor() {
    super("That Team Bot was not found.");
    this.name = "TeamBotNotFoundError";
  }
}

export type TeamBotSummary = {
  id: string;
  name: string;
  title: string;
  roleDescription: string;
  ownerUserId: string | null;
  audience: "team" | "people";
  publishedAt: string;
  assigned: boolean;
};

export type TeamBotConsentDecision =
  | "allow_once"
  | "allow_always"
  | "allow_all_team_bots"
  | "skip";

/** One consent card a run raised: which Team Bot, which of the person's own accounts, and why. */
export type TeamBotConsentAsk = {
  botId: string;
  serverId: string;
  message: string;
};

/** Which servers a person has connected an account on, as the plugin store records it. */
export type ConnectionReader = (userId: string) => Promise<Set<string>>;

export function createTeamBots(options: {
  database: Database;
  /** Every server this person has their own account connected on (OAuth or brokered). */
  connectedServers: ConnectionReader;
}) {
  const { database, connectedServers } = options;
  /**
   * Cards raised while a server-run turn was listening for them, keyed by person and Bot. A browser
   * chat draws the card from the tool result itself; a group turn has no browser, so it collects
   * them here and puts the card in the shared transcript.
   */
  const listening = new Map<string, TeamBotConsentAsk[]>();

  async function publication(botId: string) {
    const [row] = await database
      .select({
        agentId: teamBotPublications.agentId,
        audience: teamBotPublications.audience,
        ownerUserId: agentProfiles.ownerUserId,
      })
      .from(teamBotPublications)
      .innerJoin(
        agentProfiles,
        eq(agentProfiles.agentId, teamBotPublications.agentId),
      )
      .where(
        and(
          eq(teamBotPublications.agentId, botId),
          eq(teamBotPublications.tenantId, TEAM_TENANT),
          isNull(agentProfiles.deletedAt),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * The Bot as its owner, for owner-only acts; administrators may unpublish and assign.
   *
   * Read in the frame the caller runs in: the owner's own, or, for an administrator, the one the
   * route opened (`adminActAsOwner` for another person's Bot, `asAdminPlatform` for one nobody owns).
   */
  async function owned(actor: AgentActor, botId: string, allowAdmin: boolean) {
    const [row] = await database
      .select({
        id: agents.id,
        name: agents.name,
        roleDescription: agentProfiles.roleDescription,
        ownerUserId: agentProfiles.ownerUserId,
        stamp: agentProfiles.tenantId,
        visibility: agentProfiles.visibility,
      })
      .from(agents)
      .innerJoin(agentProfiles, eq(agentProfiles.agentId, agents.id))
      .where(and(eq(agents.id, botId), isNull(agentProfiles.deletedAt)))
      .limit(1);
    if (!row) throw new TeamBotNotFoundError();
    if (row.ownerUserId !== actor.id && !(allowAdmin && actor.role === "admin"))
      throw new TeamBotNotFoundError();
    return row;
  }

  /**
   * An administrator's assignment writes hold the capability (I10): as `platform`, opened by the
   * route's admin door after it re-read the role, or in their own frame holding it. A session that
   * still says admin after the role was taken away holds neither, and is told so instead of meeting
   * a raw row-security failure or a delete that silently matches nothing (I9).
   */
  function requireAssignCapability(actor: AgentActor) {
    const frame = currentTenant();
    if (frame === PLATFORM_TENANT) return;
    if (frame === actor.id && capabilityFor(actor.id) === "admin") return;
    throw new TeamBotForbiddenError(
      "Your administrator role could not be confirmed. Sign in again, or ask an administrator.",
    );
  }

  return {
    teamBotAccess,

    /**
     * Who owns this live Bot: their id, null when nobody does any more, undefined when this frame
     * finds no such Bot. The route asks it as `platform` to decide where an administrator's
     * unpublish runs.
     */
    async ownerOf(botId: string): Promise<string | null | undefined> {
      const [row] = await database
        .select({ ownerUserId: agentProfiles.ownerUserId })
        .from(agentProfiles)
        .where(
          and(
            eq(agentProfiles.agentId, botId),
            isNull(agentProfiles.deletedAt),
          ),
        )
        .limit(1);
      return row ? row.ownerUserId : undefined;
    },

    /**
     * Whose account a Team Bot's call to `ref` goes out on, for the person asking.
     *
     * The asker, for anything that is not a Team Bot or is theirs, and for a server nobody has a
     * personal account on (a shared credential reaches the same place whoever asks). The owner, where
     * the owner connected it. The asker's own account only with a standing or one-time consent;
     * without one the call is refused with the card's marker, and nothing is sent.
     *
     * M3: upstream also leaves the owner's account out for an action the owner granted the Bot
     * themselves (owner app grants, `plugin_grants.granted_as`); that is not adopted here.
     */
    credentialActorFor(actorId: string, botId: string) {
      return async (ref: string): Promise<string> => {
        const published = await publication(botId);
        const owner = published?.ownerUserId;
        if (!owner || owner === actorId) return actorId;
        const serverId = ref.split("/")[0] ?? "";
        if ((await connectedServers(owner)).has(serverId)) return owner;
        if (!(await connectedServers(actorId)).has(serverId)) return actorId;
        const [consent] = await database
          .select({ decision: teamBotConsents.decision })
          .from(teamBotConsents)
          .where(
            and(
              eq(teamBotConsents.userId, actorId),
              eq(teamBotConsents.agentId, botId),
              eq(teamBotConsents.serverId, serverId),
            ),
          )
          .limit(1);
        if (consent?.decision === "always") return actorId;
        const [everyBot] = await database
          .select({ serverId: teamBotConsentDefaults.serverId })
          .from(teamBotConsentDefaults)
          .where(
            and(
              eq(teamBotConsentDefaults.userId, actorId),
              eq(teamBotConsentDefaults.serverId, serverId),
            ),
          )
          .limit(1);
        if (everyBot) return actorId;
        if (consent?.decision === "once") {
          // Spent by exactly one call: whichever call deletes it is the one that may go.
          const spent = await database
            .delete(teamBotConsents)
            .where(
              and(
                eq(teamBotConsents.userId, actorId),
                eq(teamBotConsents.agentId, botId),
                eq(teamBotConsents.serverId, serverId),
                eq(teamBotConsents.decision, "once"),
              ),
            )
            .returning({ serverId: teamBotConsents.serverId });
          if (spent.length) return actorId;
        }
        const message = `This Team Bot wants to use your own ${serverId} account. Choose Allow once, Always allow, or Skip, then ask again.`;
        listening
          .get(`${actorId}\n${botId}`)
          ?.push({ botId, serverId, message });
        throw new PluginRefusedError(
          `${TEAM_BOT_CONSENT_MARKER}${JSON.stringify({ botId, serverId })} ${message}`,
          null,
        );
      };
    },

    /**
     * For a check-in, which nobody is watching: which of this Bot's tools go out on the asker's OWN
     * account without asking them anything. Null when the Bot is theirs or nobody's Team Bot, where
     * every call already does.
     *
     * {@link credentialActorFor}'s answer, read without acting on it. That one spends a one-time
     * consent and raises a card, and both need a person present. So here the owner's account is no
     * (it is not what the asker connected), a one-time consent is no (it was for one call they made),
     * no consent is no, and a standing consent, for this Bot or every Bot, is yes.
     */
    async unaskedOwnAccount(
      actorId: string,
      botId: string,
    ): Promise<((ref: string) => Promise<boolean>) | null> {
      const owner = (await publication(botId))?.ownerUserId;
      if (!owner || owner === actorId) return null;
      return async (ref) => {
        const serverId = ref.split("/")[0] ?? "";
        if ((await connectedServers(owner)).has(serverId)) return false;
        const [consent] = await database
          .select({ decision: teamBotConsents.decision })
          .from(teamBotConsents)
          .where(
            and(
              eq(teamBotConsents.userId, actorId),
              eq(teamBotConsents.agentId, botId),
              eq(teamBotConsents.serverId, serverId),
            ),
          )
          .limit(1);
        if (consent?.decision === "always") return true;
        const [everyBot] = await database
          .select({ serverId: teamBotConsentDefaults.serverId })
          .from(teamBotConsentDefaults)
          .where(
            and(
              eq(teamBotConsentDefaults.userId, actorId),
              eq(teamBotConsentDefaults.serverId, serverId),
            ),
          )
          .limit(1);
        return everyBot !== undefined;
      };
    },

    /**
     * Listen for consent cards this person's turns with this Bot raise, until the returned function
     * is called; it returns them once each.
     */
    listenForConsent(
      actorId: string,
      botId: string,
    ): () => TeamBotConsentAsk[] {
      const key = `${actorId}\n${botId}`;
      const asks: TeamBotConsentAsk[] = [];
      listening.set(key, asks);
      return () => {
        if (listening.get(key) === asks) listening.delete(key);
        return asks.filter(
          (ask, index) =>
            asks.findIndex((other) => other.serverId === ask.serverId) ===
            index,
        );
      };
    },

    /** Record a teammate's answer to a consent card. Skip clears any earlier answer. */
    async consent(
      actor: AgentActor,
      botId: string,
      serverId: string,
      decision: TeamBotConsentDecision,
    ) {
      const scope = and(
        eq(teamBotConsents.userId, actor.id),
        eq(teamBotConsents.agentId, botId),
        eq(teamBotConsents.serverId, serverId),
      );
      if (decision === "skip") {
        await database.delete(teamBotConsents).where(scope);
        return;
      }
      if (!(await publication(botId))) throw new TeamBotNotFoundError();
      if (decision === "allow_all_team_bots") {
        await database
          .insert(teamBotConsentDefaults)
          .values({ userId: actor.id, serverId })
          .onConflictDoNothing();
        return;
      }
      const value = decision === "allow_always" ? "always" : "once";
      await database
        .insert(teamBotConsents)
        .values({ userId: actor.id, agentId: botId, serverId, decision: value })
        .onConflictDoUpdate({
          target: [
            teamBotConsents.userId,
            teamBotConsents.agentId,
            teamBotConsents.serverId,
          ],
          set: { decision: value, updatedAt: new Date() },
        });
    },

    /** Settings: forget every consent this person has given any Team Bot. */
    async clearConsents(actor: AgentActor) {
      await database
        .delete(teamBotConsents)
        .where(eq(teamBotConsents.userId, actor.id));
      await database
        .delete(teamBotConsentDefaults)
        .where(eq(teamBotConsentDefaults.userId, actor.id));
    },

    async publish(
      actor: AgentActor,
      botId: string,
      input: {
        audience: "team" | "people";
        emails: string[];
        groups: string[];
      },
    ) {
      // The "Team Bots" switch, here rather than only at the HTTP gate, so every caller meets it.
      // Fails closed when the controls cannot be read.
      const controls = enterpriseControls();
      if (controls) {
        const allowed = await controls
          .capabilityFor(actor.id, "teamBots")
          .catch(() => false);
        if (!allowed)
          throw new TeamBotForbiddenError(capabilityRefusal("teamBots"));
      }
      const bot = await owned(actor, botId, false);
      // Only a Bot kept under the owner's own account (or already in `team`) moves to `team`. One
      // still stamped `system` from before G01-E is the deployment's row, which the owner's frame
      // can read but never move.
      if (bot.stamp !== TEAM_TENANT && bot.stamp !== actor.id)
        throw new TeamBotRefusedError(
          "This Bot is stored with the deployment's own Bots, not under your account, so it cannot be published. Duplicate it and publish the copy.",
        );
      // A teammate cannot tell an undescribed Bot from any other, so it is not published.
      if (
        !bot.roleDescription.trim() ||
        (PLACEHOLDER_BOT_NAMES as readonly string[]).includes(
          bot.name.trim().toLowerCase(),
        )
      )
        throw new TeamBotRefusedError(
          "Give this Bot a name and a description before publishing it to your team.",
        );
      const emails = [
        ...new Set(input.emails.map((email) => email.trim().toLowerCase())),
      ].filter(Boolean);
      const people = emails.length
        ? await database
            .select({ id: users.id, email: users.email })
            .from(users)
            .where(inArray(sql`lower(${users.email})`, emails))
        : [];
      const missing = emails.filter(
        (email) => !people.some((row) => row.email.toLowerCase() === email),
      );
      if (missing.length)
        throw new TeamBotRefusedError(
          `Nobody has signed in here as ${missing.join(", ")}.`,
        );
      const groups = [
        ...new Set(input.groups.map((group) => group.trim())),
      ].filter(Boolean);
      if (input.audience === "people" && !people.length && !groups.length)
        throw new TeamBotRefusedError(
          "Name at least one person or group, or publish to the whole team.",
        );
      await database.transaction(async (tx) => {
        // The Bot itself first: its audience reads it through `team`, and the publication's own
        // write policy asks that the profile be the caller's `team` profile.
        if (bot.stamp !== TEAM_TENANT) await moveToTeam(tx, botId);
        const published = await tx
          .insert(teamBotPublications)
          .values({
            agentId: botId,
            publishedBy: actor.id,
            audience: input.audience,
            tenantId: TEAM_TENANT,
          })
          .onConflictDoUpdate({
            target: teamBotPublications.agentId,
            // `published_by` is a fixed link (0122 row guard); only the owner publishes anyway.
            set: { audience: input.audience },
          })
          .returning({ agentId: teamBotPublications.agentId });
        if (published.length !== 1) throw new TeamBotNotFoundError();
        await tx
          .delete(teamBotAudience)
          .where(eq(teamBotAudience.agentId, botId));
        const rows = [
          ...people.map((person) => ({
            agentId: botId,
            kind: "user" as const,
            value: person.id,
            tenantId: TEAM_TENANT,
          })),
          ...groups.map((group) => ({
            agentId: botId,
            kind: "group" as const,
            value: group,
            tenantId: TEAM_TENANT,
          })),
        ];
        if (input.audience === "people" && rows.length)
          await tx.insert(teamBotAudience).values(rows);
      });
    },

    /**
     * Teammates lose access until it is published again. Assignments wait, inert.
     *
     * Runs in the OWNER's frame (the owner, or an administrator through `adminActAsOwner`), which is
     * the only person frame the team policies let delete the rows; a private Bot then goes back to its
     * owner (`moveToOwner`), as if it had never been published. A Bot nobody owns is unpublished as
     * `platform` (`asAdminPlatform`), and only while it stays public: private and unpublished, nobody
     * could reach it again ({@link OwnerlessBotPrivateError}); deleting it is the administrator's way
     * to take it down.
     *
     * A Bot with no publication is answered as not found, from every frame and before the ownerless
     * refusal: there is nothing to take back (I9), and nothing to refuse.
     *
     * OPERATOR NOTE. No app path deletes a person's account, but an operator can, directly in the
     * database. That cascades their publications away (`published_by` ON DELETE CASCADE) and sets the
     * owner of their Bots null. A Bot they had published while it was private is left stamped `team`,
     * with no owner, private and unpublished: `openbot_team_bot_visible` admits nobody, it is on nobody's
     * Team Bots page, and unpublishing it answers 404 because no publication is left. It is not lost:
     * an administrator finds it on the admin agents pages (`platform`, with the capability) and
     * deletes it there, or makes it public. Better, unpublish or hand over a person's Bots before
     * deleting their account.
     */
    async unpublish(actor: AgentActor, botId: string) {
      const bot = await owned(actor, botId, true);
      const frame = currentTenant();
      // Anywhere else every delete below would match nothing and report success (I9).
      if (frame !== bot.ownerUserId && frame !== PLATFORM_TENANT)
        throw new TeamBotNotFoundError();
      const ownerUserId = bot.ownerUserId;
      await database.transaction(async (tx) => {
        const removed = await tx
          .delete(teamBotPublications)
          .where(eq(teamBotPublications.agentId, botId))
          .returning({ agentId: teamBotPublications.agentId });
        if (!removed.length) throw new TeamBotNotFoundError();
        // Thrown inside the transaction, so the delete above is rolled back.
        if (!ownerUserId && bot.visibility !== "public")
          throw new OwnerlessBotPrivateError(botId);
        await tx
          .delete(teamBotAudience)
          .where(eq(teamBotAudience.agentId, botId));
        if (
          ownerUserId &&
          bot.stamp === TEAM_TENANT &&
          bot.visibility !== "public"
        )
          await moveToOwner(tx, botId, ownerUserId);
      });
    },

    async assign(actor: AgentActor, botId: string, groupName: string) {
      if (actor.role !== "admin")
        throw new TeamBotRefusedError("Only an admin can assign Team Bots.");
      if (!(await publication(botId)))
        throw new TeamBotRefusedError("Publish this Bot before assigning it.");
      // Asked after the publication, so a Bot this frame cannot see is still "publish it first".
      requireAssignCapability(actor);
      const group = groupName.trim();
      if (!group) throw new TeamBotRefusedError("Name a group, or * for all.");
      await database
        .insert(teamBotAssignments)
        .values({
          agentId: botId,
          groupName: group,
          assignedBy: actor.id,
          tenantId: TEAM_TENANT,
        })
        .onConflictDoNothing();
    },

    async unassign(actor: AgentActor, botId: string, groupName: string) {
      if (actor.role !== "admin")
        throw new TeamBotRefusedError(
          "Only an administrator can assign Team Bots.",
        );
      requireAssignCapability(actor);
      const removed = await database
        .delete(teamBotAssignments)
        .where(
          and(
            eq(teamBotAssignments.agentId, botId),
            eq(teamBotAssignments.groupName, groupName),
          ),
        )
        .returning({ agentId: teamBotAssignments.agentId });
      // No such assignment, or none this frame may remove: never a silent success (I9).
      if (!removed.length) throw new TeamBotNotFoundError();
    },

    /** Whether this is a Team Bot somebody else published, where this person's accounts need their consent. */
    async publishedByAnother(actorId: string, botId: string): Promise<boolean> {
      const owner = (await publication(botId))?.ownerUserId;
      return Boolean(owner) && owner !== actorId;
    },

    /** Whether this Bot is in this person's sidebar by assignment, which they cannot hide. */
    async isAssignedTo(actorId: string, botId: string): Promise<boolean> {
      const [row] = await database
        .select({ agentId: teamBotPublications.agentId })
        .from(teamBotPublications)
        .where(
          and(
            eq(teamBotPublications.agentId, botId),
            assignedCondition(actorId),
          ),
        )
        .limit(1);
      return Boolean(row);
    },

    /** The Team Bots this person may use, their own publications, and each one's settings. */
    async list(actor: AgentActor) {
      const rows = await database
        .select({
          id: agents.id,
          name: agents.name,
          title: agentProfiles.title,
          roleDescription: agentProfiles.roleDescription,
          ownerUserId: agentProfiles.ownerUserId,
          audience: teamBotPublications.audience,
          publishedAt: teamBotPublications.publishedAt,
          assigned: sql<boolean>`${assignedCondition(actor.id)}`,
          described: sql<boolean>`${describedForTeam}`,
        })
        .from(teamBotPublications)
        .innerJoin(agents, eq(agents.id, teamBotPublications.agentId))
        .innerJoin(agentProfiles, eq(agentProfiles.agentId, agents.id))
        .where(
          and(
            isNull(agentProfiles.deletedAt),
            eq(teamBotPublications.tenantId, TEAM_TENANT),
            actor.role === "admin"
              ? undefined
              : or(
                  eq(agentProfiles.ownerUserId, actor.id),
                  teamBotAccess(actor.id, teamBotPublications.agentId),
                ),
          ),
        )
        .orderBy(agents.name);
      const ids = rows.map((row) => row.id);
      const [audience, assignments] = ids.length
        ? await Promise.all([
            database
              .select({
                agentId: teamBotAudience.agentId,
                kind: teamBotAudience.kind,
                value: teamBotAudience.value,
                email: users.email,
              })
              .from(teamBotAudience)
              .leftJoin(
                users,
                and(
                  eq(teamBotAudience.kind, "user"),
                  eq(users.id, teamBotAudience.value),
                ),
              )
              .where(inArray(teamBotAudience.agentId, ids)),
            database
              .select()
              .from(teamBotAssignments)
              .where(inArray(teamBotAssignments.agentId, ids)),
          ])
        : [[], []];
      return rows.map((row) => {
        const manages = row.ownerUserId === actor.id || actor.role === "admin";
        return {
          id: row.id,
          name: row.name,
          title: row.title,
          roleDescription: row.roleDescription,
          mine: row.ownerUserId === actor.id,
          audience: row.audience,
          publishedAt: row.publishedAt.toISOString(),
          assigned: Boolean(row.assigned),
          /** False while its name or description would leave teammates unable to tell it apart. */
          visibleToTeam: Boolean(row.described),
          // Who it reaches is the owner's and administrators' business, not every teammate's.
          ...(manages
            ? {
                people: audience
                  .filter((a) => a.agentId === row.id && a.kind === "user")
                  .map((a) => a.email ?? a.value),
                groups: audience
                  .filter((a) => a.agentId === row.id && a.kind === "group")
                  .map((a) => a.value),
                assignments: assignments
                  .filter((a) => a.agentId === row.id)
                  .map((a) => a.groupName),
              }
            : {}),
        };
      });
    },

    /**
     * The owner's own Bots that could be published, for the publish list: kept under their own
     * account or already in `team`, the only stamps `publish` moves or keeps. A Bot still stamped
     * `system` from before G01-E is left off; `publish` refuses it.
     */
    async publishable(actor: AgentActor) {
      return database
        .select({
          id: agents.id,
          name: agents.name,
          title: agentProfiles.title,
        })
        .from(agents)
        .innerJoin(agentProfiles, eq(agentProfiles.agentId, agents.id))
        .leftJoin(
          teamBotPublications,
          eq(teamBotPublications.agentId, agents.id),
        )
        .where(
          and(
            eq(agentProfiles.ownerUserId, actor.id),
            inArray(agentProfiles.tenantId, [actor.id, TEAM_TENANT]),
            isNull(agentProfiles.deletedAt),
            isNull(teamBotPublications.agentId),
          ),
        )
        .orderBy(agents.name);
    },
  };
}
export type TeamBots = ReturnType<typeof createTeamBots>;
