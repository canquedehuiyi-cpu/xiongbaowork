import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { client } from "@/lib/client";

/**
 * The information sources a person declared for their 分身 (story F1, stage 1).
 *
 * Read and written through `/api/me/avatar/sources`, which only ever answers the signed-in person's
 * own 分身. A source is a declaration: a name and a note in the person's words, which the 分身 is
 * told on every run and which grants access to nothing. Or a local folder (stage 2): one of the
 * read-only folders the person's own paired machine reports, named by the machine's id and the
 * folder's opaque reference, which the 分身 may read file by file through that machine.
 */
export type AvatarSource =
  | {
      id: string;
      kind: "declaration";
      label: string;
      note: string;
      createdAt: string;
    }
  | {
      id: string;
      kind: "local_folder";
      label: string;
      note: string;
      /** The machine's own id, as `/api/devices` lists it in `deviceId`. */
      deviceId: string;
      /** The folder's reference on that machine. Never a path. */
      rootRef: string;
      createdAt: string;
    };

/** What a save sends. A local folder's empty name means the name the machine reports. */
export type AvatarSourceInput =
  | { kind?: "declaration"; label: string; note: string }
  | {
      kind: "local_folder";
      deviceId: string;
      rootRef: string;
      label: string;
      note: string;
    };

export type AvatarSourceState = {
  /** The 分身's agent id, so a roster card or a detail page can tell it is the one. */
  agentId: string;
  /** When the person first saved a source. Null is 待配置. */
  configuredAt: string | null;
  sources: AvatarSource[];
};

/** The server's limits, repeated here so a form can say them before a save is refused. */
export const AVATAR_SOURCE_LIMIT = 10;
export const AVATAR_SOURCE_LABEL_LIMIT = 60;
export const AVATAR_SOURCE_NOTE_LIMIT = 500;

/** Characters as the server counts them (code points), so the counter and the refusal agree. */
export const sourceLength = (value: string) => [...value].length;

export const avatarSourceKeys = {
  all: ["avatar-sources"] as const,
  state: () => ["avatar-sources", "state"] as const,
};

export function avatarSourcesQueryOptions() {
  return queryOptions({
    queryKey: avatarSourceKeys.state(),
    queryFn: async (): Promise<AvatarSourceState> => {
      const response = await client("/api/me/avatar/sources", {
        fallback: "信息来源加载失败。",
      });
      return (await response.json()) as AvatarSourceState;
    },
  });
}

/*
 * `refetchType: "all"`, as onboarding's own writes do: the wizard and the roster may not be observing
 * this query at the moment it changes, and the next screen must not show 待配置 from a stale cache.
 */
const refresh = (queryClient: QueryClient) =>
  queryClient.invalidateQueries({
    queryKey: avatarSourceKeys.all,
    refetchType: "all",
  });

export function addAvatarSourceMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (input: AvatarSourceInput) =>
      client<AvatarSource>("/api/me/avatar/sources", "source", {
        method: "POST",
        body:
          input.kind === "local_folder"
            ? {
                kind: "local_folder",
                deviceId: input.deviceId,
                rootRef: input.rootRef,
                label: input.label,
                note: input.note,
              }
            : { kind: "declaration", label: input.label, note: input.note },
        fallback: "信息来源没有保存成功。",
      }),
    onSuccess: () => refresh(queryClient),
  });
}

export function removeAvatarSourceMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (id: string) => {
      await client(`/api/me/avatar/sources/${encodeURIComponent(id)}`, {
        method: "DELETE",
        fallback: "信息来源没有删除成功。",
      });
    },
    onSuccess: () => refresh(queryClient),
  });
}
