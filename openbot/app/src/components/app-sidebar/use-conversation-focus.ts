import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { defaultAgentId } from "@/lib/agents/default-agent";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  channelListQueryOptions,
  channelQueryOptions,
} from "@/lib/channels/queries";
import { conversationRoute } from "./roster";

export type ConversationFocus = {
  /** Whether the open screen is a conversation at all (`/channel/*`, `/group/$channelId`). */
  active: boolean;
  /** The open conversation, when there is one. */
  channelId?: string;
  /**
   * The employee the open conversation is about: the one a new conversation is addressed to
   * (`?agent=`, or whoever an unaddressed one goes to), or the first member of the open one.
   * Undefined when neither says — a conversation with no employee in it.
   */
  agentId?: string;
};

/**
 * Which conversation is open and whose it is, for the employee the sidebar's 员工 list marks as
 * selected. Read off the address and the caches the conversation screens already fill, so it costs a
 * request only when the open channel is not among the loaded roster pages (the screen asks for the
 * same detail, so the two share one).
 */
export function useConversationFocus(): ConversationFocus {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const searchAgent = useRouterState({
    select: (state) => {
      const agent = (state.location.search as Record<string, unknown>).agent;
      return typeof agent === "string" && agent ? agent : undefined;
    },
  });
  const route = conversationRoute(pathname);
  const channelId = route && route.kind !== "new" ? route.channelId : undefined;
  const roster = useInfiniteQuery(channelListQueryOptions());
  // The same roster the sidebar lists, so this is a cache read.
  const agents = useQuery(agentListQueryOptions());
  const listed = channelId
    ? roster.data?.find((channel) => channel.id === channelId)
    : undefined;
  const detail = useQuery({
    ...channelQueryOptions(channelId ?? ""),
    enabled: channelId !== undefined && listed === undefined,
  });
  if (!route) return { active: false };
  if (route.kind === "new") {
    return {
      active: true,
      agentId: searchAgent ?? defaultAgentId(agents.data),
    };
  }
  const agentIds = listed?.agentIds ?? detail.data?.agentIds;
  return { active: true, channelId, agentId: agentIds?.[0] };
}
