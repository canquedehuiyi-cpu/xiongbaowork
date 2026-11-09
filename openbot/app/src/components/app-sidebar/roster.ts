import type { AgentProfile } from "@/lib/agents/queries";
import type { ChannelSummary } from "@/lib/channels/queries";

/**
 * The conversation list, narrowed to what the person typed.
 *
 * Matches the channel's name, its summary, and the last message, because those are the things the
 * row can actually show — searching against something invisible returns results a person cannot
 * account for. The last message is included because it is still what the row draws until the
 * conversation has been named. Message history beyond that line is not here to search: it lives in
 * the thread store, and reaching for it is a server endpoint rather than a filter.
 *
 * An empty query returns the input array unchanged rather than a copy, so typing and clearing does
 * not hand `AnimatePresence` a new array identity and restage the whole list.
 */
export function matchingChannels(
  channels: ChannelSummary[] | undefined,
  query: string,
): ChannelSummary[] {
  if (!channels) {
    return [];
  }
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return channels;
  }
  return channels.filter((channel) =>
    [channel.name, channel.summary, channel.lastMessage].some((field) =>
      field?.toLowerCase().includes(needle),
    ),
  );
}

/**
 * Pinned channels first, everything else after, newest activity first within each group.
 *
 * The mirror of a server rule, not the rule itself: the roster query orders pinned-first and its
 * cursor carries the pin, so a pinned channel arrives on page one however long ago it was last
 * spoken in. Sorting here as well is for what happens between refetches — the socket patches a pin
 * onto a loaded row without moving it, and re-sorts a page by recency alone — which is the same
 * reason `byRecency` in use-channel-events.ts mirrors the recency rule. A stable partition, so the
 * recency order inside each group is whatever arrived.
 */
export function pinnedFirst(channels: ChannelSummary[]): ChannelSummary[] {
  return [...channels].sort((a, b) => Number(b.pinned) - Number(a.pinned));
}

/**
 * Whether a Bot has said something this member has not had on screen yet.
 *
 * A Bot's message, and only a Bot's: your own message carries a null agent id and reading your own
 * words needs no marker. ISO-8601 strings compare correctly as strings, which is the same bet the
 * server's recency sort already makes.
 */
export function hasUnseenActivity(channel: ChannelSummary): boolean {
  if (channel.lastMessageAgentId === null || channel.lastMessageAt === null) {
    return false;
  }
  return (
    channel.lastReadAt === null || channel.lastMessageAt > channel.lastReadAt
  );
}

/** Unseen activity somewhere you are not looking. The open channel never shows the dot. */
export function isUnread(
  channel: ChannelSummary,
  openChannelId: string | undefined,
): boolean {
  return channel.id !== openChannelId && hasUnseenActivity(channel);
}

export type ConversationTab = "wakers" | "groups";

/** Which side a conversation belongs to: two or more coworkers is a group conversation. */
export function channelTab(channel: ChannelSummary): ConversationTab {
  return channel.agentIds.length > 1 ? "groups" : "wakers";
}

/**
 * One employee's conversations: every loaded channel it takes part in.
 *
 * A group conversation belongs to each of its members, so it shows under every one of them rather
 * than under nobody — the workspace column is "what this employee is in", and a group it is in is
 * part of that.
 */
export function channelsOf(
  channels: ChannelSummary[] | undefined,
  agentId: string,
): ChannelSummary[] {
  return (channels ?? []).filter((channel) =>
    channel.agentIds.includes(agentId),
  );
}

/** When a channel last moved: its last message, or its creation for one nobody spoke in. */
function lastActivity(channel: ChannelSummary): string {
  return channel.lastMessageAt ?? channel.createdAt;
}

/**
 * Where clicking an employee goes: its most recent one-to-one conversation among the loaded pages.
 *
 * One-to-one only. A group conversation the employee happens to be in is not "talking to it", and
 * landing in a shared transcript from a click on one name would be a surprise. Undefined means
 * there is none loaded, and the caller starts a new conversation addressed to it instead.
 */
export function latestDirectChannel(
  channels: ChannelSummary[] | undefined,
  agentId: string,
): ChannelSummary | undefined {
  let latest: ChannelSummary | undefined;
  for (const channel of channels ?? []) {
    if (channel.agentIds.length !== 1 || channel.agentIds[0] !== agentId)
      continue;
    if (!latest || lastActivity(channel) > lastActivity(latest))
      latest = channel;
  }
  return latest;
}

/** A group's members in the order a person put them in: the order they answer in a group chat. */
export function crewChatAgentIds(crew: {
  members: readonly { agentId: string; position: number }[];
}): string[] {
  return [...crew.members]
    .sort((left, right) => left.position - right.position)
    .map((member) => member.agentId);
}

/**
 * Where clicking a group goes: the most recent group conversation among the loaded pages whose
 * coworkers are exactly this group's members, so clicking the same group twice lands in the same
 * transcript instead of piling up empty ones.
 *
 * Exactly the members, not "at least": a conversation that also has someone else, or lacks one of
 * them, is a different group of coworkers. After the group's roster changes the old transcript no
 * longer matches, and the caller starts a new one with the roster as it is now. Inactive channels
 * (a coworker deleted since) are skipped, because nothing more can be said in them.
 */
export function latestCrewChannel(
  channels: readonly ChannelSummary[] | undefined,
  agentIds: readonly string[],
): ChannelSummary | undefined {
  if (agentIds.length < 2) return undefined;
  const wanted = new Set(agentIds);
  let latest: ChannelSummary | undefined;
  for (const channel of channels ?? []) {
    if (!channel.active) continue;
    if (channel.agentIds.length !== wanted.size) continue;
    if (!channel.agentIds.every((id) => wanted.has(id))) continue;
    if (!latest || lastActivity(channel) > lastActivity(latest))
      latest = channel;
  }
  return latest;
}

/**
 * The employees the sidebar lists: everyone on the roster except those switched out of the list,
 * unless the person pinned one or an administrator assigned it to them — those stay in reach.
 */
export function listedEmployees(
  agents: readonly AgentProfile[] | undefined,
): AgentProfile[] {
  return (agents ?? []).filter(
    (agent) => !agent.hidden || agent.pinned || agent.assignedToMe === true,
  );
}

/** `10月6日 00:56`, the reference's stamp on a conversation row, in this browser's time zone. */
export function conversationStamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The conversation routes the workspace column sits beside, read off the path. */
export type ConversationRoute =
  | { kind: "new" }
  | { kind: "channel" | "group"; channelId: string };

export function conversationRoute(pathname: string): ConversationRoute | null {
  if (pathname === "/channel/new") return { kind: "new" };
  const match = /^\/(channel|group)\/([^/]+)\/?$/.exec(pathname);
  if (!match?.[1] || !match[2] || match[2] === "new") return null;
  return {
    kind: match[1] as "channel" | "group",
    channelId: decodeURIComponent(match[2]),
  };
}
