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
 * folder's opaque reference, which the 分身 may read file by file through that machine. Or (stage 3)
 * one of the person's own 知识库 notebooks, which the 分身 may search, or one of their own connected
 * accounts, whose read tools the 分身 is given under the same approval rules as any tool.
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
    }
  | {
      id: string;
      kind: "notebook";
      label: string;
      note: string;
      /** One of the person's own notebooks on the 知识库 screen, which the 分身 may search. */
      notebookId: string;
      /** The notebook's title as it is now. */
      title: string;
      createdAt: string;
    }
  | {
      id: string;
      kind: "connector";
      label: string;
      note: string;
      /** A connector the person connected with their own account. */
      serverId: string;
      title: string;
      createdAt: string;
    };

/**
 * What a save sends. An empty name on a folder, a notebook or a connector means its own name: the
 * one the machine reports, the notebook's title, the connector's title.
 */
export type AvatarSourceInput =
  | { kind?: "declaration"; label: string; note: string }
  | {
      kind: "local_folder";
      deviceId: string;
      rootRef: string;
      label: string;
      note: string;
    }
  | { kind: "notebook"; notebookId: string; label: string; note: string }
  | { kind: "connector"; serverId: string; label: string; note: string };

/**
 * One connector the person connected with their own account, as
 * `GET /api/me/avatar/sources/connectors` lists it: whether it can be given to the 分身, and the
 * server's sentence for why not (not listed for people by an administrator, or nothing to read with).
 */
export type AvatarConnectorOption = {
  serverId: string;
  title: string;
  attached: boolean;
  attachable: boolean;
  reason: string | null;
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
  connectors: () => ["avatar-sources", "connectors"] as const,
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

/** The person's own connected accounts that a 分身 could be given (S4). */
export function avatarConnectorsQueryOptions() {
  return queryOptions({
    queryKey: avatarSourceKeys.connectors(),
    queryFn: async (): Promise<AvatarConnectorOption[]> =>
      (await client<AvatarConnectorOption[] | undefined>(
        "/api/me/avatar/sources/connectors",
        "connectors",
        { fallback: "读不到你已连接的账号。" },
      )) ?? [],
  });
}

/*
 * `refetchType: "all"`, as onboarding's own writes do: the wizard and the roster may not be observing
 * this query at the moment it changes, and the next screen must not show 待配置 from a stale cache.
 */
const refresh = (queryClient: QueryClient) =>
  Promise.all([
    queryClient.invalidateQueries({
      queryKey: avatarSourceKeys.all,
      refetchType: "all",
    }),
    // A notebook source is a RES1 binding too, which the 知识库 screen shows.
    queryClient.invalidateQueries({ queryKey: ["knowledge"] }),
  ]);

/** The body a save sends: exactly the fields of its kind. */
function bodyOf(input: AvatarSourceInput) {
  switch (input.kind) {
    case "local_folder":
      return {
        kind: "local_folder",
        deviceId: input.deviceId,
        rootRef: input.rootRef,
        label: input.label,
        note: input.note,
      };
    case "notebook":
      return {
        kind: "notebook",
        notebookId: input.notebookId,
        label: input.label,
        note: input.note,
      };
    case "connector":
      return {
        kind: "connector",
        serverId: input.serverId,
        label: input.label,
        note: input.note,
      };
    default:
      return { kind: "declaration", label: input.label, note: input.note };
  }
}

export function addAvatarSourceMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (input: AvatarSourceInput) =>
      client<AvatarSource>("/api/me/avatar/sources", "source", {
        method: "POST",
        body: bodyOf(input),
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
