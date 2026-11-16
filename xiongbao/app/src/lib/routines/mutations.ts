import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { channelKeys } from "@/lib/channels/queries";
import { client } from "@/lib/client";
import { AUTO_CONVERSATION, NEW_CONVERSATION } from "./form";
import { routineKeys } from "./queries";

/**
 * Writes against a person's own standing instructions.
 *
 * Create is here since decision D-2 (spec C4: "在此页新建/暂停/删除 routine"), through the same store
 * call a Bot's `create_routine` makes: `POST /api/routines` goes through the same routine store a
 * Bot's mid-chat tool uses, so the fifteen-minute floor and the twenty-routine ceiling are the
 * store's, and their refusals come back as the store's sentences. There is no edit; changing a
 * routine is conversational, through the `RoutineTools` a Bot calls mid-chat. See
 * `server/src/routines/routes.ts` for the full reasoning.
 */

const FALLBACK = "这条定时任务没能修改。";

function invalidateRoutines(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: routineKeys.all });
}

/**
 * What `POST /api/routines` accepts. The owner is whoever is signed in, never a field.
 *
 * The contract is `server/docs/contracts/routines-create.md`: 201 on success, the store's refusal as
 * `{ error }` otherwise, with the status saying what kind of refusal it is (400 the form, 404 the
 * coworker, 409 the ceiling).
 */
export type RoutineInput = {
  agentId: string;
  instruction: string;
  title?: string;
  /** Five cron fields, built by `cronFrom` in `form.ts` or `cronFor` in `frequency.ts`. */
  cron: string;
  timezone: string;
  /**
   * A conversation the person and the Bot share, or `NEW_CONVERSATION` to start one for it.
   * Absent (or `AUTO_CONVERSATION`, the form's 「自动」 choice) lets the server choose.
   *
   * Optional, unlike upstream (#1406 made it required): 熊宝 lets a routine be made without naming
   * a conversation, and the server then picks the one this person shares with the coworker, and
   * refuses when there is more than one.
   */
  channelId?: string;
};

/**
 * New routine: what to do, and when, in the person's own time zone.
 *
 * With `NEW_CONVERSATION`, the conversation it posts in is started first, as the person and the
 * Bot, and named after the routine so the sidebar says what it is for. A routine the server then
 * refuses takes that conversation back with it: an empty conversation nobody asked for is not
 * what a refused form should leave behind. Without a `channelId` the server chooses (see above).
 */
export function createRoutineMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: RoutineInput): Promise<{ id: string }> => {
      let started: string | null = null;
      if (input.channelId === NEW_CONVERSATION) {
        const response = await client("/api/channels", {
          method: "POST",
          body: { agentIds: [input.agentId] },
          fallback: "没能为这条定时任务新建对话。",
        });
        started = ((await response.json()) as { channel: { id: string } })
          .channel.id;
        const name = input.title?.trim() || input.instruction.trim();
        // Best effort: a conversation that keeps its default name still works.
        await client(`/api/channels/${started}/title`, {
          method: "PUT",
          body: { title: Array.from(name).slice(0, 60).join("") },
          fallback: "没能给这个对话命名。",
        }).catch(() => undefined);
      }
      const { channelId: chosen, ...rest } = input;
      const channelId =
        started ?? (chosen === AUTO_CONVERSATION ? undefined : chosen);
      try {
        return await client<{ id: string }>("/api/routines", "routine", {
          method: "POST",
          body: { ...rest, ...(channelId ? { channelId } : {}) },
          fallback: "这条定时任务没能建立。",
        });
      } catch (error) {
        if (started) {
          await client(`/api/channels/${started}`, {
            method: "DELETE",
            fallback: "没能删除这个对话。",
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
