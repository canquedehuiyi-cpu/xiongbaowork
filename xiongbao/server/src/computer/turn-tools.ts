import type { HeadlessTool } from "../../../toolkit/src/headless-tools";
import { canUseComputer } from "../agents/computer-access";
import type { AgentActor, AgentProfile } from "../agents/profile-types";
import type { AuditInitiator, AuditStore } from "../audit";
import type { ComputerGateway } from "./gateway";
import {
  createHeadlessComputerTools,
  type HeadlessSignInRequester,
} from "./headless-tools";

/** What a turn that runs the computer on the server asks for its tools: whose turn, for which Bot. */
export type ComputerToolsRequest = {
  ownerUserId: string;
  agentId: string;
  initiator: AuditInitiator;
};

export type ComputerToolsForTurn = (
  input: ComputerToolsRequest,
) => Promise<HeadlessTool[]>;

/**
 * The computer tools one server-run turn holds, in one place.
 *
 * A group conversation's turn and a chat the server carries on for the browser ask for exactly the
 * same list, so there is exactly one way to build it. The Bot must be one this owner may use; a Team
 * Bot's teammate uses the Bot and not its owner's signed-in computer, so gets none; a tool an
 * employee-level permission switched off is left out of the list, and local apps are offered only on
 * the owner's own paired machine. A deployment with no computer holds none at all.
 */
export function createComputerToolsForTurn(deps: {
  gateway: ComputerGateway | undefined;
  actorFor: (ownerUserId: string) => Promise<AgentActor>;
  profileOf: (
    actor: AgentActor,
    agentId: string,
  ) => Promise<AgentProfile | null>;
  auditStore: AuditStore;
  signIn?: HeadlessSignInRequester;
  machine: "workspace" | "device";
  usesDeviceApps: (agentId: string, actorId: string) => Promise<boolean>;
  disabledTools: (
    actorId: string,
    agentId: string,
  ) => Promise<(toolRef: string) => boolean>;
}): ComputerToolsForTurn {
  return async ({ ownerUserId, agentId, initiator }) => {
    const { gateway } = deps;
    if (!gateway) return [];
    const actor = await deps.actorFor(ownerUserId);
    const profile = await deps.profileOf(actor, agentId);
    if (!profile) throw new Error("That Bot is not available to this owner.");
    // A Team Bot's teammate uses the Bot, not its owner's signed-in computer.
    if (!canUseComputer(profile, actor)) return [];
    return createHeadlessComputerTools({
      gateway,
      seat: await gateway.seatFor(agentId, actor.id),
      actor: { id: actor.id, userId: actor.id, initiator },
      auditStore: deps.auditStore,
      ...(deps.signIn ? { signIn: deps.signIn } : {}),
      machine: deps.machine,
      apps: await deps.usesDeviceApps(agentId, actor.id),
      disabled: await deps.disabledTools(actor.id, agentId),
    });
  };
}
