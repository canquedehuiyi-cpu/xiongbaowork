import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { channelKeys } from "@/lib/channels/queries";
import { client } from "@/lib/client";
import { NEW_CONVERSATION } from "./form";
import { routineKeys } from "./queries";

/**
 * Writes against a person's own standing instructions.
 *
<<<<<<< e3fb3519d1f6fe6b7f19b13cdfab1ee99530d1c9
 * Create is here since decision D-2 (spec C4: "在此页新建/暂停/删除 routine"). It is not a second way
 * to make one with its own rules: `POST /api/routines` goes through the same routine store a Bot's
 * mid-chat tool uses, so the fifteen-minute floor and the twenty-routine ceiling are the store's, and
 * their refusals come back as the store's sentences. There is still no edit; changing a standing
 * instruction stays conversational.
=======
 * Create is here, through the same store call a Bot's `create_routine` makes; there is no edit.
 * Changing a routine is conversational, through the `RoutineTools` a Bot calls mid-chat. See
 * `server/src/routines/routes.ts` for the full reasoning.
>>>>>>> 776dcffce8776bcc9c2d17de3c5132451d0d868d
 */

const FALLBACK = "这条定时任务没能修改。";

function invalidateRoutines(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: routineKeys.all });
}

<<<<<<< e3fb3519d1f6fe6b7f19b13cdfab1ee99530d1c9
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
=======
/** What `POST /api/routines` accepts. The owner is whoever is signed in, never a field. */
export type RoutineInput = {
  agentId: string;
  instruction: string;
  title?: string;
  /** Five cron fields, built by `cronFrom` in `form.ts`. */
  cron: string;
  timezone: string;
  /** A conversation the person and the Bot share, or `NEW_CONVERSATION` to start one for it. */
  channelId: string;
};

/**
 * New routine.
 *
 * With `NEW_CONVERSATION`, the conversation it posts in is started first, as the person and the
 * Bot, and named after the routine so the sidebar says what it is for. A routine the server then
 * refuses takes that conversation back with it: an empty conversation nobody asked for is not
 * what a refused form should leave behind.
 */
export function createRoutineMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: RoutineInput): Promise<{ id: string }> => {
      let started: string | null = null;
      if (input.channelId === NEW_CONVERSATION) {
        const response = await client("/api/channels", {
          method: "POST",
          body: { agentIds: [input.agentId] },
          fallback: "Couldn't start a conversation for this routine.",
        });
        started = ((await response.json()) as { channel: { id: string } })
          .channel.id;
        const name = input.title?.trim() || input.instruction.trim();
        // Best effort: a conversation that keeps its default name still works.
        await client(`/api/channels/${started}/title`, {
          method: "PUT",
          body: { title: Array.from(name).slice(0, 60).join("") },
          fallback: "Couldn't name the conversation.",
        }).catch(() => undefined);
      }
      try {
        return await client<{ id: string }>("/api/routines", "routine", {
          method: "POST",
          body: { ...input, channelId: started ?? input.channelId },
          fallback: "Couldn't set up that routine. Try again.",
        });
      } catch (error) {
        if (started) {
          await client(`/api/channels/${started}`, {
            method: "DELETE",
            fallback: "Couldn't remove the conversation.",
          }).catch(() => undefined);
        }
        throw error;
      }
    },
    onSuccess: () =>
      Promise.all([
        invalidateRoutines(queryClient),
        queryClient.invalidateQueries({ queryKey: channelKeys.all }),
      ]),
>>>>>>> 776dcffce8776bcc9c2d17de3c5132451d0d868d
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
