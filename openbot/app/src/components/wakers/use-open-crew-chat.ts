import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import {
  crewChatAgentIds,
  latestCrewChannel,
} from "@/components/app-sidebar/roster";
import { channelKeys, channelListQueryOptions } from "@/lib/channels/queries";
import { createGroupMutationOptions } from "@/lib/groups";
import type { WakerGroup } from "@/lib/waker-groups/queries";

/** Why a group cannot be talked to yet, said on the button that would have opened it. */
export const CREW_CHAT_NEEDS_TWO = "至少要有两位员工才能群聊";

/**
 * Talk to a group: open its group conversation, or start one with its members in their order.
 *
 * A group (`waker_groups`) is a named, ordered roster and holds no transcript of its own; the
 * conversation is an ordinary channel with those coworkers in it (`POST /api/groups`), the same one
 * 新建群聊 makes. This is the bridge between the two that the group wall and the sidebar both use,
 * so clicking a group always lands somewhere a person can type.
 *
 * Reuses the most recent conversation with exactly these coworkers among the loaded pages (the
 * sidebar's own list, read from cache when it is there) so a second click is the same chat rather
 * than a second empty one, and starts a new one otherwise. The server still refuses any coworker
 * this person cannot see, and that sentence comes back as `problem`.
 */
export function useOpenCrewChat() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const create = useMutation(createGroupMutationOptions(queryClient));
  const [problem, setProblem] = useState<string | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);

  const open = async (crew: WakerGroup) => {
    const agentIds = crewChatAgentIds(crew);
    if (agentIds.length < 2) {
      setProblem(CREW_CHAT_NEEDS_TWO);
      return;
    }
    setProblem(null);
    setOpeningId(crew.id);
    try {
      const pages = await queryClient
        .ensureInfiniteQueryData(channelListQueryOptions())
        .catch(() => undefined);
      const existing = latestCrewChannel(
        pages?.pages.flatMap((page) => page.channels),
        agentIds,
      );
      let channelId = existing?.id;
      if (!channelId) {
        const channel = await create.mutateAsync(agentIds);
        queryClient.setQueryData(channelKeys.detail(channel.id), channel);
        channelId = channel.id;
      }
      await navigate({ to: "/group/$channelId", params: { channelId } });
    } catch (thrown) {
      setProblem(
        thrown instanceof Error ? thrown.message : "没能打开这个群组的群聊。",
      );
    } finally {
      setOpeningId(null);
    }
  };

  return { open, problem, openingId, clearProblem: () => setProblem(null) };
}
