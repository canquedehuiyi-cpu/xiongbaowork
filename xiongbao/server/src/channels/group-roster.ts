import type { AgentActor } from "../agents/profile-types";
import type { GroupBot } from "./group";

/**
 * The Bots of a group one member may use (`createGroupConversations`' `roster`).
 *
 * Every Bot the member can see, as the profile store answers in their own frame; and, besides, an
 * external employee (`device_acp`) its hirer put in this group while the hirer is still in it (spec
 * §1, §6): every member can see it there and `@` it, and it works in its hirer's queue. Its profile
 * stays its hirer's alone everywhere else; only its id, name, hirer and which agent it is (`harness`)
 * reach this roster.
 */
export function createGroupRoster(deps: {
  actorFor: (userId: string) => Promise<AgentActor>;
  /** The group as this member reads it, or null when they are not in it. */
  channel: (
    actor: AgentActor,
    channelId: string,
  ) => Promise<{ agentIds: string[] } | null>;
  profile: (
    actor: AgentActor,
    agentId: string,
  ) => Promise<{ name: string } | null>;
  /** Which of these Bots are external employees, with their hirer and name. */
  externalEmployees: (agentIds: readonly string[]) => Promise<
    Map<
      string,
      {
        hirer: string;
        name: string;
        harness?: "codex" | "claude-code" | "hermes" | "custom";
      }
    >
  >;
  /** The people in the group. */
  members: (channelId: string) => Promise<string[]>;
}): (ownerUserId: string, channelId: string) => Promise<GroupBot[] | null> {
  return async (ownerUserId, channelId) => {
    const actor = await deps.actorFor(ownerUserId);
    const channel = await deps.channel(actor, channelId);
    if (!channel || channel.agentIds.length < 2) return null;
    const external = await deps.externalEmployees(channel.agentIds);
    const people = new Set(
      external.size > 0 ? await deps.members(channelId) : [],
    );
    const bots: GroupBot[] = [];
    for (const agentId of channel.agentIds) {
      const hired = external.get(agentId);
      if (hired) {
        if (hired.hirer === ownerUserId || people.has(hired.hirer))
          bots.push({
            id: agentId,
            name: hired.name,
            hiredBy: hired.hirer,
            // Which agent it is, for its 「外部员工 · Codex」 mark: never its computer or rules.
            ...(hired.harness ? { harness: hired.harness } : {}),
          });
        continue;
      }
      const profile = await deps.profile(actor, agentId);
      if (profile) bots.push({ id: agentId, name: profile.name });
    }
    return bots;
  };
}
