import type { AgentProfile } from "./queries";

export const PICKED_HARNESS_AGENT_ID = "picked-harness";

/**
 * The person's own 分身: `avatar-<their id>`, made for them at sign-up (`server/src/tenant/provisioning.ts`).
 *
 * Told apart by its id together with `mine`, so a shared coworker can never pass for it.
 */
export function isOwnAvatar(agent: AgentProfile): boolean {
  return agent.mine && agent.id.startsWith("avatar-");
}

/**
 * Who a conversation goes to when nobody was named.
 *
 * The person's own 分身 comes before the route's fallback (the first shared coworker): it is theirs,
 * and with `TENANT_RUNTIME=device` it is the one coworker that can use their paired machine. A shared
 * coworker answering by default is how a first conversation went to a Bot that belongs to nobody.
 * The server's `/api/route` default makes the same choice, so the composer's promise and the actual
 * recipient agree.
 */
export function defaultAgentProfile(
  agents: readonly AgentProfile[] | undefined,
  fallback?: AgentProfile,
): AgentProfile | undefined {
  return (
    agents?.find((candidate) => candidate.id === PICKED_HARNESS_AGENT_ID) ??
    agents?.find(isOwnAvatar) ??
    fallback ??
    agents?.[0]
  );
}

export function defaultAgentId(
  agents: readonly AgentProfile[] | undefined,
): string | undefined {
  return defaultAgentProfile(agents)?.id;
}
