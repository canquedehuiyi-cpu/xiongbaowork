import type { AgentProfile } from "@/lib/agents/queries";
import type { ChannelSummary } from "@/lib/channels/queries";

/**
 * The conversation list, narrowed to what the person typed.
 *
 * Matches the channel's name, its summary, its opening and the last message, because those are the
 * things the row can actually show — searching against something invisible returns results a person
 * cannot account for. The opening and the last message are included because one of them is what the
 * second line draws until the conversation has been named. Message history beyond that line is not
 * here to search: it lives in the thread store, and reaching for it is a server endpoint rather than
 * a filter.
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
    [channel.name, channel.summary, channel.opening, channel.lastMessage].some(
      (field) => field?.toLowerCase().includes(needle),
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

/**
 * 会话行上的时间，像聊天软件那样短：今天的写「14:05」，今年的写「10月6日」，更早的写「2025/10/6」。
 * 按这个浏览器的时区。上游的 `relativeTimeShort` 写的是英文缩写（"5m"、"2d"），熊宝的侧栏不用它。
 */
export function conversationStamp(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  if (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  ) {
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  if (date.getFullYear() === now.getFullYear()) {
    return `${date.getMonth() + 1}月${date.getDate()}日`;
  }
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

/** Two or more employees in one conversation is a 群聊; it opens at `/group/$channelId`. */
export function isGroupChannel(channel: ChannelSummary): boolean {
  return channel.agentIds.length > 1;
}

/**
 * One employee's conversations: every loaded channel it takes part in, a 群聊 it is in among them —
 * what the 员工 row's unread and busy marks are about.
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
 * Where clicking an employee in the 员工 list goes: its most recent 单聊 among the loaded pages.
 *
 * One-to-one only. A 群聊 the employee happens to be in is not "talking to it", and landing in a
 * shared transcript from a click on one name would be a surprise. Undefined means there is none
 * loaded, and the caller starts a new conversation addressed to it instead.
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

/**
 * The employees the 员工 list shows: everyone on the roster except those switched out of the list,
 * unless the person pinned one or an administrator assigned it to them — those stay in reach.
 */
export function listedEmployees(
  agents: readonly AgentProfile[] | undefined,
): AgentProfile[] {
  return (agents ?? []).filter(
    (agent) => !agent.hidden || agent.pinned || agent.assignedToMe === true,
  );
}

/** The conversation routes, read off the path: which conversation is open, if any. */
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
