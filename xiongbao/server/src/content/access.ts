import type { BotAccessCheck } from "../agents/profile-policy";
import type { AgentActor } from "../agents/profile-types";
import {
  type ArtifactAccessDeps,
  type ArtifactScope,
  resolveArtifactAppAccess,
  resolveArtifactDirAccess,
} from "../computer/artifact-access";
import { type ComputerSeat, computerKeyText } from "../computer/computer-key";
import { isPersonTenant, runAsTenant } from "../tenant/context";
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
  /**
   * The seat to forward to a running program from, or null: the same rules as a folder, with a
   * delivery that lists the program (its port) standing in for a delivery that lists the folder.
   */
  authorizeApp(
    actor: AgentActor,
    input: { botId: string; port: number; scope: ArtifactScope | null },
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

  const authorizeApp: ContentAccess["authorizeApp"] = async (actor, input) => {
    if (input.scope) {
      return resolveArtifactAppAccess(
        {
          actor,
          botId: input.botId,
          port: input.port,
          scope: input.scope,
        },
        deps.artifact,
      );
    }
    if (!(await deps.canUseBot(actor, input.botId))) return null;
    return { seat: await deps.seatFor(input.botId, actor.id) };
  };

  async function stillAllowedAsPerson(grant: ContentGrant): Promise<boolean> {
    const role = await deps.roleOf(grant.person);
    if (role === null) return false;
    const scope: ArtifactScope | null =
      grant.channel !== undefined ||
      grant.run !== undefined ||
      grant.task !== undefined
        ? {
            ...(grant.channel !== undefined ? { channel: grant.channel } : {}),
            ...(grant.run !== undefined ? { run: grant.run } : {}),
            ...(grant.task !== undefined ? { task: grant.task } : {}),
          }
        : null;
    const found =
      grant.target.kind === "dir"
        ? await authorize(
            { id: grant.person, role },
            { botId: grant.bot, dir: grant.target.path, scope },
          )
        : await authorizeApp(
            { id: grant.person, role },
            { botId: grant.bot, port: grant.target.port, scope },
          );
    // The seat is part of the grant: if the employee now runs somewhere else, this grant is over.
    return found !== null && computerKeyText(found.seat.key) === grant.seat;
  }

  return {
    authorize,
    authorizeApp,
    /*
     * Asked from the content server, whose requests come in on a listener of their own, outside the
     * app's per-request frame, and again from a timer for an open socket. Every question below reads
     * the database (the person's role, the employee's profile, the run's events), and a read outside a
     * frame is refused, so the answer is worked out in the frame of the person the grant names: its
     * `person` is the user id the server signed it for, which is that person's tenant. A grant that
     * names nobody who can be acted as (an empty, shared or platform id) is not a grant to honour.
     */
    stillAllowed: (grant) =>
      isPersonTenant(grant.person)
        ? runAsTenant(grant.person, () => stillAllowedAsPerson(grant))
        : Promise.resolve(false),
  };
}
