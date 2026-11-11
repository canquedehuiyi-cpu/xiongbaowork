import type { AgentProfile } from "./queries";

/**
 * The sections of the Bots roster, from the visible list (`agentListQueryOptions()`).
 *
 * A Bot appears in exactly one section. A Bot with something waiting on the person — a question, an
 * approval, a stalled hand-off — comes first, under Needs you: that is where the sidebar's badge
 * leads. Then Pinned, where a Team Bot an administrator assigned to the person also sits: it used to
 * be in their sidebar where they could not hide it, and the top of the roster is where that promise
 * now lives. The rest split on `mine`, never on `canManage`, which is true for an administrator on
 * everybody's Bots.
 *
 * 熊宝：个人分身（`avatarId`，`GET /api/me/avatar/sources` 的 `agentId`）固定是「你的」第一位，置顶与否都
 * 不挪走它——它是这个人自己，不是又一位可以排来排去的员工。它在等这个人时照样进「需要你」。
 */
export function groupRoster(
  agents: readonly AgentProfile[],
  /** How many things this Bot has waiting on the person. */
  waiting: (agentId: string) => number = () => 0,
  /** 这个人的个人分身，固定在「你的」第一行。 */
  avatarId?: string | null,
): {
  needsYou: AgentProfile[];
  pinned: AgentProfile[];
  yours: AgentProfile[];
  shared: AgentProfile[];
} {
  const needsYou = agents.filter((agent) => waiting(agent.id) > 0);
  const quiet = agents.filter((agent) => waiting(agent.id) === 0);
  const isAvatar = (agent: AgentProfile) =>
    avatarId != null && agent.id === avatarId;
  const isPinned = (agent: AgentProfile) =>
    !isAvatar(agent) && (agent.pinned || agent.assignedToMe === true);
  const rest = quiet.filter((agent) => !isPinned(agent));
  return {
    needsYou,
    pinned: quiet.filter(isPinned),
    yours: [
      ...rest.filter(isAvatar),
      ...rest.filter((agent) => agent.mine && !isAvatar(agent)),
    ],
    shared: rest.filter((agent) => !agent.mine && !isAvatar(agent)),
  };
}
