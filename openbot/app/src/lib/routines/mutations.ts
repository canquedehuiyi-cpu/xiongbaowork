import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { routineKeys } from "./queries";

/**
 * Writes against a person's own standing instructions.
 *
 * Create is here since decision D-2 (spec C4: "在此页新建/暂停/删除 routine"). It is not a second way
 * to make one with its own rules: `POST /api/routines` goes through the same routine store a Bot's
 * mid-chat tool uses, so the fifteen-minute floor and the twenty-routine ceiling are the store's, and
 * their refusals come back as the store's sentences. There is still no edit; changing a standing
 * instruction stays conversational.
 */

const FALLBACK = "这条定时任务没能修改。";

function invalidateRoutines(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: routineKeys.all });
}

/**
 * Make a routine for one coworker: what to do, and when, in the person's own time zone.
 *
 * The contract is `server/docs/contracts/routines-create.md`: `{ agentId, instruction, cron,
 * timezone, channelId? }`, 201 on success, the store's refusal as `{ error }` otherwise, with the
 * status saying what kind of refusal it is (400 the form, 404 the coworker, 409 the ceiling). Without
 * `channelId` the server picks the one conversation this person shares with the coworker, and refuses
 * when there is more than one.
 */
export function createRoutineMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: {
      agentId: string;
      instruction: string;
      cron: string;
      timezone: string;
      channelId?: string;
    }) =>
      client("/api/routines", {
        method: "POST",
        body: variables,
        fallback: "这条定时任务没能建立。",
      }),
    onSuccess: () => invalidateRoutines(queryClient),
  });
}

/** Switch one routine on or off. Immediate; there is no save. */
export function setRoutineEnabledMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: { id: string; enabled: boolean }) =>
      client(`/api/routines/${encodeURIComponent(variables.id)}/enabled`, {
        method: "PUT",
        body: { enabled: variables.enabled },
        fallback: FALLBACK,
      }),
    onSuccess: () => invalidateRoutines(queryClient),
  });
}

export function deleteRoutineMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (id: string) =>
      client(`/api/routines/${encodeURIComponent(id)}`, {
        method: "DELETE",
        fallback: FALLBACK,
      }),
    onSuccess: () => invalidateRoutines(queryClient),
  });
}

/**
 * Run now — the Test button. This DOES REAL WORK: the Bot carries out the instruction in the
 * routine's channel exactly as a scheduled firing would. Refused for a paused routine.
 */
export function runRoutineNowMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (id: string) =>
      client(`/api/routines/${encodeURIComponent(id)}/run`, {
        method: "POST",
        fallback: "这条定时任务没能开始运行。",
      }),
    onSuccess: () => invalidateRoutines(queryClient),
  });
}
