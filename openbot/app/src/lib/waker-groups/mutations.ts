import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { type AgentChannel, channelKeys } from "@/lib/channels/queries";
import { client } from "@/lib/client";
import {
  CrewRequestError,
  type MemberStep,
  OWNER_GONE,
  type WakerGroup,
  wakerGroupKeys,
} from "./queries";

export { CrewRequestError, type MemberStep, OWNER_GONE };

/**
 * Crews are written by name and by roster. A group is a chat, so the chat's title is the truth:
 * 改名走 PATCH，频道名是真相 (the title and the group's name change together).
 */

/** A group write changes the group and its chat's mirror, so both families are read again. */
function invalidateGroups(queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: wakerGroupKeys.all }),
    queryClient.invalidateQueries({ queryKey: channelKeys.all }),
  ]);
}

/**
 * The group endpoints' request: the JSON body on success, a `CrewRequestError` on a refusal, with
 * the `code` and `done` the shared client would drop.
 */
async function crewRequest<T>(
  path: string,
  options: { method: string; body?: unknown; fallback: string },
): Promise<T> {
  const response = await fetch(path, {
    method: options.method,
    credentials: "include",
    headers:
      options.body === undefined
        ? undefined
        : { "content-type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => undefined);
    const record =
      body !== null && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : {};
    throw new CrewRequestError(
      typeof record.error === "string" ? record.error : options.fallback,
      response.status,
      {
        code: typeof record.code === "string" ? record.code : undefined,
        done: Array.isArray(record.done)
          ? (record.done as MemberStep[])
          : undefined,
      },
    );
  }
  const body = (await response.json().catch(() => null)) as T | null;
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new Error(options.fallback);
  return body;
}

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

/** Make a group and its chat in one request. */
export function createGroupWithChatMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: {
      name: string;
      description?: string;
      agentIds: string[];
    }) =>
      crewRequest<{ group: WakerGroup; channel: AgentChannel }>(
        "/api/waker-groups",
        {
          method: "POST",
          body: input,
          fallback: "群组没能建好，请再试一次。",
        },
      ),
    onSuccess: () => invalidateGroups(queryClient),
  });
}

/**
 * Replace the roster in one write: a crew is edited as a set, and a half-applied edit is wrong.
 *
 * A 200 can still carry `chatError`: the roster is saved but the chat did not start, so the caller
 * must show it. A 409 with `done` stopped part-way; the chat's truth is already mirrored, so the
 * lists are read again whether or not the write finished.
 */
export function setCrewMembersMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: { groupId: string; agentIds: string[] }) =>
      crewRequest<{ group: WakerGroup; chatError?: string }>(
        `/api/waker-groups/${input.groupId}/members`,
        {
          method: "PUT",
          body: { agentIds: input.agentIds },
          fallback: "That group's members could not be changed.",
        },
      ),
    onSuccess: () => invalidateGroups(queryClient),
    onError: (error) => {
      if (error instanceof CrewRequestError && error.done !== undefined)
        return invalidateGroups(queryClient);
    },
  });
}

/** Rename or re-describe a group; a 403 means the person no longer started its chat. */
export function renameCrewMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: {
      groupId: string;
      name?: string;
      description?: string;
    }) => {
      const { groupId, ...body } = input;
      return crewRequest<{ group: WakerGroup }>(
        `/api/waker-groups/${groupId}`,
        { method: "PATCH", body, fallback: "没能保存群组的名称。" },
      );
    },
    onSuccess: () => invalidateGroups(queryClient),
  });
}

/** Start the chat of a group that has its roster but no chat yet. */
export function startCrewChatMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (groupId: string) =>
      crewRequest<{ group: WakerGroup; channel: AgentChannel }>(
        `/api/waker-groups/${groupId}/chat`,
        { method: "POST", fallback: "聊天没能开始，请稍后再试。" },
      ),
    onSuccess: () => invalidateGroups(queryClient),
  });
}

/** The group behind a group chat; 404 for a chat that is not one, or that cannot be read. */
export function crewForChannelMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (channelId: string) =>
      crewRequest<{ group: WakerGroup }>(
        `/api/waker-groups/for-channel/${encodeURIComponent(channelId)}`,
        { method: "POST", fallback: "读不到这个群组的设置。" },
      ),
    onSuccess: () => invalidateGroups(queryClient),
  });
}

export function retireCrewMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (groupId: string) =>
      client(`/api/waker-groups/${groupId}`, "ok", {
        method: "DELETE",
        fallback: "That group could not be retired.",
      }),
    onSuccess: () => invalidateGroups(queryClient),
  });
}
