import type { BotAccessCheck } from "../agents/profile-policy";
import type { AgentActor } from "../agents/profile-types";
import {
  type ArtifactAccessDeps,
  type ArtifactScope,
  resolveArtifactDirAccess,
} from "../computer/artifact-access";
import { type ComputerSeat, computerKeyText } from "../computer/computer-key";
import type { ContentGrant } from "./token";

/**
 * Who may open which folder of an employee's workspace as a web page, asked the same way every time:
 * when the person asks for the link, and again whenever a grant they were given is about to be renewed.
 *
 * A request that names where its files were announced (a conversation and a run, or a delivery card)
 * is decided by the download rules alone (`resolveArtifactDirAccess`), and never by whether the
 * person may drive the employee. A request that names nothing is the person's own employee on their
 * own computer: `canUseBot`, then the seat the gateway works out for the pair.
 */
export type ContentAccess = {
  /** The seat to read the folder from, or null. Null says nothing about why. */
  authorize(
    actor: AgentActor,
    input: { botId: string; dir: string; scope: ArtifactScope | null },
  ): Promise<{ seat: ComputerSeat } | null>;
  /** Whether a grant made earlier still holds: the same question, for the same seat, asked again. */
  stillAllowed(grant: ContentGrant): Promise<boolean>;
};

export function createContentAccess(deps: {
  canUseBot: BotAccessCheck;
  seatFor(botId: string, personId: string): Promise<ComputerSeat>;
  artifact: ArtifactAccessDeps;
  /** The person's role, or null when they are gone. Roles are read fresh, never taken from a grant. */
  roleOf(personId: string): Promise<AgentActor["role"] | null>;
}): ContentAccess {
  const authorize: ContentAccess["authorize"] = async (actor, input) => {
    if (input.scope) {
      return resolveArtifactDirAccess(
        {
          actor,
          botId: input.botId,
          dir: input.dir,
          scope: input.scope,
        },
        deps.artifact,
      );
    }
    if (!(await deps.canUseBot(actor, input.botId))) return null;
    return { seat: await deps.seatFor(input.botId, actor.id) };
  };

  return {
    authorize,
    async stillAllowed(grant) {
      if (grant.target.kind !== "dir") return false;
      const role = await deps.roleOf(grant.person);
      if (role === null) return false;
      const scope: ArtifactScope | null =
        grant.channel !== undefined ||
        grant.run !== undefined ||
        grant.task !== undefined
          ? {
              ...(grant.channel !== undefined
                ? { channel: grant.channel }
                : {}),
              ...(grant.run !== undefined ? { run: grant.run } : {}),
              ...(grant.task !== undefined ? { task: grant.task } : {}),
            }
          : null;
      const found = await authorize(
        { id: grant.person, role },
        { botId: grant.bot, dir: grant.target.path, scope },
      );
      // The seat is part of the grant: if the employee now runs somewhere else, this grant is over.
      return found !== null && computerKeyText(found.seat.key) === grant.seat;
    },
  };
}
