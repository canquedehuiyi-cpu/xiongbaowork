import { and, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { agentProfiles, agents, pluginGrants, portraits } from "../db/schema";
import { avatarAgentId } from "../tenant/provisioning";
import {
  type AgentProfileStore,
  AgentNotFoundError,
  type ProfileTransaction,
} from "./profile-store";
import type { AgentActor, AgentProfile } from "./profile-types";

/**
 * 召唤员工（spec `docs/specs/2026-11-14-summon-employees.md`）。
 *
 * A shared preset is one row everybody sees and only an administrator may change, so summoning one
 * gives the person a copy of their own (a `duplicate` that remembers its preset in
 * `summoned_from`), with the preset's face and the preset's skills, and the 1:1 conversation with
 * that copy. Their own 分身 and their own coworkers are already theirs: summoning one only finds or
 * makes the conversation. Anything else is answered as `duplicate` answers a Bot it cannot find.
 */
export type SummonDeps = {
  /** Runs in the person's tenant frame: the reads, the lock and the copy's rows are theirs. */
  database: Database;
  profiles: Pick<AgentProfileStore, "get" | "duplicate">;
  /** `ChannelStore.direct`: find or make this person's 1:1 conversation with one coworker. */
  direct: (actor: AgentActor, agentId: string) => Promise<{ id: string }>;
  /**
   * The plan's admission for one more coworker, on the copy's own transaction. Only a new copy is
   * admitted: finding the copy already summoned, or the 分身, takes no seat. Absent, no ceiling.
   */
  admit?: (transaction: ProfileTransaction) => Promise<void>;
  /**
   * Told once a new copy has committed, before the conversation is looked for: the trail row for the
   * copy must not depend on a later step that can fail, since a retry finds the copy and makes none.
   */
  onCreated?: (copy: AgentProfile) => Promise<void>;
};

/** What a deployment wires in once (`index.ts`); the route adds the store, admission and trail. */
export type SummonServices = Pick<SummonDeps, "database" | "direct">;

export type Summoned = {
  agent: AgentProfile;
  channelId: string;
  /** Whether this call made the copy; false when it found one, or for the 分身 and one's own. */
  created: boolean;
};

const SUMMONED_UNIQUE = "agent_profiles_owner_summoned_from_unique";

/** Thrown from inside the copy's transaction to abandon it: this person already holds that copy. */
class AlreadySummoned extends Error {
  constructor(readonly agentId: string) {
    super(`Already summoned as ${agentId}.`);
    this.name = "AlreadySummoned";
  }
}

export async function summonAgent(
  deps: SummonDeps,
  actor: AgentActor,
  agentId: string,
): Promise<Summoned> {
  const { agent, created } = await coworkerFor(deps, actor, agentId);
  if (created) await deps.onCreated?.(agent);
  const channel = await deps.direct(actor, agent.id);
  return { agent, channelId: channel.id, created };
}

async function coworkerFor(
  deps: SummonDeps,
  actor: AgentActor,
  agentId: string,
): Promise<{ agent: AgentProfile; created: boolean }> {
  const profile = await deps.profiles.get(actor, agentId);
  if (!profile) throw new AgentNotFoundError(agentId);
  if (agentId === avatarAgentId(actor.id) || profile.ownerUserId === actor.id)
    return { agent: profile, created: false };
  if (profile.ownerUserId !== null || !(await isPackaged(deps, agentId)))
    throw new AgentNotFoundError(agentId);

  /*
   * Twice at most: the copy found under the lock can be deleted before it is read back outside it,
   * and the answer then is a fresh copy rather than "not found" for a preset that is plainly there.
   */
  for (let attempt = 0; attempt < 2; attempt++) {
    const held = await heldCopy(deps.database, actor, agentId);
    if (held) {
      const agent = await deps.profiles.get(actor, held);
      if (agent) return { agent, created: false };
    }
    const copy = await copyPreset(deps, actor, agentId);
    if (copy.created) return copy;
    if (copy.agent) return { agent: copy.agent, created: false };
  }
  throw new AgentNotFoundError(agentId);
}

/** A preset is a package's coworker: `agents.package_id` set (its profile has no owner). */
async function isPackaged(deps: SummonDeps, agentId: string) {
  const [row] = await deps.database
    .select({ packageId: agents.packageId })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  return Boolean(row?.packageId);
}

/** The live copy this person summoned from that preset, if any. */
async function heldCopy(
  executor: Pick<Database, "select"> | Pick<ProfileTransaction, "select">,
  actor: AgentActor,
  presetId: string,
): Promise<string | null> {
  const [row] = await executor
    .select({ agentId: agentProfiles.agentId })
    .from(agentProfiles)
    .where(
      and(
        eq(agentProfiles.ownerUserId, actor.id),
        eq(agentProfiles.summonedFrom, presetId),
        isNull(agentProfiles.deletedAt),
      ),
    )
    .limit(1);
  return row?.agentId ?? null;
}

/**
 * Copy the preset as this person's, or report the copy somebody else's request made first.
 *
 * ONE PER PERSON AND PRESET. Two clicks, two tabs: both requests saw no copy and both made one. The
 * lock is taken first on the copy's own transaction, so the second waits for the first to commit and
 * then finds its copy; the unique index (`agent_profiles_owner_summoned_from_unique`) is the floor
 * under that, and a conflict on it is read back as the copy already there.
 */
async function copyPreset(
  deps: SummonDeps,
  actor: AgentActor,
  presetId: string,
): Promise<
  | { agent: AgentProfile; created: true }
  | { agent: AgentProfile | null; created: false }
> {
  try {
    const agent = await deps.profiles.duplicate(
      actor,
      presetId,
      async (transaction) => {
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`agent:summon:${actor.id}:${presetId}`}))`,
        );
        const held = await heldCopy(transaction, actor, presetId);
        if (held) throw new AlreadySummoned(held);
        // After the look, so finding the copy already there never asks for a seat.
        await deps.admit?.(transaction);
      },
      {
        summonedFrom: presetId,
        // The copy, its skills and its face commit together or not at all: a retry finds the copy
        // and makes nothing, so anything left for after the commit would be missing for good.
        alongside: async (transaction, copy) => {
          await giveSkills(transaction, actor, presetId, copy.id);
          await givePortrait(transaction, actor, copy);
        },
      },
    );
    return { agent, created: true };
  } catch (error) {
    if (error instanceof AlreadySummoned)
      return {
        agent: await deps.profiles.get(actor, error.agentId),
        created: false,
      };
    if (!isSummonedConflict(error)) throw error;
    const held = await heldCopy(deps.database, actor, presetId);
    return {
      agent: held ? await deps.profiles.get(actor, held) : null,
      created: false,
    };
  }
}

/**
 * The preset's skills, given to the copy as its owner would give them (requirement change from the
 * controller, 2026-11-14: a summoned expert is usable at once, with its whole expertise — its
 * `persona-*` skill and the package's other skills for it).
 *
 * Skills only. An app grant (`mcp`) reaches a person's own accounts, which is the person's decision
 * to make on their own copy, not one a preset makes for them.
 */
async function giveSkills(
  transaction: ProfileTransaction,
  actor: AgentActor,
  presetId: string,
  copyId: string,
) {
  const skills = await transaction
    .select({ ref: pluginGrants.ref })
    .from(pluginGrants)
    .where(
      and(eq(pluginGrants.agentId, presetId), eq(pluginGrants.kind, "skill")),
    );
  if (skills.length === 0) return;
  await transaction
    .insert(pluginGrants)
    .values(
      skills.map(({ ref }) => ({
        kind: "skill",
        ref,
        agentId: copyId,
        grantedBy: actor.id,
        grantedAs: "owner" as const,
      })),
    )
    .onConflictDoNothing();
}

/**
 * The preset's face, as a `portraits` row of this person's own (stamped by their frame, never the
 * platform's). None when the preset has none. A plain insert: the copy's id is new, so no row exists.
 */
async function givePortrait(
  transaction: ProfileTransaction,
  actor: AgentActor,
  copy: AgentProfile,
) {
  const preset = copy.presetPortrait ?? null;
  if (!preset) return;
  await transaction.insert(portraits).values({
    subjectKind: "coworker",
    subjectId: copy.id,
    preset,
    updatedBy: actor.id,
  });
}

/** A unique violation on the one-copy-per-preset index. Bun puts the SQLSTATE in `errno`, under `cause`. */
function isSummonedConflict(error: unknown): boolean {
  type Driver = { errno?: unknown; constraint?: unknown };
  for (const candidate of [
    error as Driver | null | undefined,
    (error as { cause?: Driver } | null | undefined)?.cause,
  ]) {
    if (
      candidate?.errno === "23505" &&
      candidate.constraint === SUMMONED_UNIQUE
    )
      return true;
  }
  return false;
}
