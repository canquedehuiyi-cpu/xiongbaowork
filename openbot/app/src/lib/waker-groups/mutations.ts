import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { wakerGroupKeys } from "./queries";

/**
 * Crews are written by name and by roster, and by nothing else.
 *
 * There is no rename: the name is what a person says out loud (`@编程小组`), so the honest way to
 * change one is to retire the crew and make a new one while watching who is in it — an in-place
 * rename would silently point an old habit at a different set of coworkers.
 */
export function createCrewMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: { name: string; description?: string }) =>
      client("/api/waker-groups", "group", {
        method: "POST",
        body: input,
        fallback: "That group could not be created.",
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: wakerGroupKeys.all }),
  });
}

/** Replace the roster in one write: a crew is edited as a set, and a half-applied edit is wrong. */
export function setCrewMembersMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: { groupId: string; agentIds: string[] }) =>
      client(`/api/waker-groups/${input.groupId}/members`, "group", {
        method: "PUT",
        body: { agentIds: input.agentIds },
        fallback: "That group's members could not be changed.",
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: wakerGroupKeys.all }),
  });
}

export function retireCrewMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (groupId: string) =>
      client(`/api/waker-groups/${groupId}`, "ok", {
        method: "DELETE",
        fallback: "That group could not be retired.",
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: wakerGroupKeys.all }),
  });
}
