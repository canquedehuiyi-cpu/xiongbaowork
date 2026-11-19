import { useQuery } from "@tanstack/react-query";
import { wakerGroupsQueryOptions } from "./queries";

/** The group each group chat belongs to, by the chat's id: the groups the person made that have one. */
export function useGroupOfChannel(): Map<string, string> {
  const groups = useQuery(wakerGroupsQueryOptions());
  return new Map(
    (groups.data ?? []).flatMap((group) =>
      group.channelId ? [[group.channelId, group.id] as const] : [],
    ),
  );
}
