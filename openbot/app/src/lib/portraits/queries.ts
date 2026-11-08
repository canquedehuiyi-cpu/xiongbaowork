import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { client } from "@/lib/client";

/**
 * 头像: the picture a person chose for a coworker (员工) or a group (群组), in place of the abstract
 * one drawn from its seed. Either one of 熊宝's five expressions or a picture they uploaded.
 *
 * Called a portrait in code because "avatar" in this codebase already means a person's 分身.
 *
 * Read as one list for the whole workspace (`GET /api/portraits`) rather than as a field on every
 * coworker and group response: rosters, cards, sidebars and member stacks all draw faces, and one
 * cached map serves all of them without touching any of the reads that list the things themselves.
 */
export type PortraitKind = "coworker" | "group";

/** 调皮 · 可爱 · 帅气 · 开心 · 卖萌 — the character sheet's expressions, offered as ready-made faces. */
export const PORTRAIT_PRESETS = [
  { value: "naughty", label: "调皮" },
  { value: "cute", label: "可爱" },
  { value: "cool", label: "帅气" },
  { value: "happy", label: "开心" },
  { value: "sweet", label: "卖萌" },
] as const;

export type PortraitPreset = (typeof PORTRAIT_PRESETS)[number]["value"];

export type Portrait = {
  kind: PortraitKind;
  id: string;
  /** One of 熊宝's expressions, or null when the portrait is an uploaded picture. */
  preset: PortraitPreset | null;
  /** Where the uploaded picture is served, versioned so a replaced one is fetched again. */
  imageUrl: string | null;
  updatedAt: string;
};

export const portraitKeys = {
  all: ["portraits"] as const,
};

export function portraitsQueryOptions() {
  return queryOptions({
    queryKey: portraitKeys.all,
    queryFn: () =>
      client<Portrait[]>("/api/portraits", "portraits", {
        fallback: "读不到自定义头像。",
      }),
    // Faces change when somebody changes one, and that write invalidates this; no polling.
    staleTime: 5 * 60_000,
  });
}

/** `${kind}:${id}` → portrait, for the components that draw one face at a time. */
export function portraitIndex(
  portraits: readonly Portrait[] | undefined,
): Map<string, Portrait> {
  return new Map(
    (portraits ?? []).map((portrait) => [
      `${portrait.kind}:${portrait.id}`,
      portrait,
    ]),
  );
}

export type PortraitChoice =
  | { preset: PortraitPreset }
  /** The picture, already squared and re-encoded in the browser, as base64. */
  | { image: string };

export function setPortraitMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: ({
      kind,
      id,
      choice,
    }: {
      kind: PortraitKind;
      id: string;
      choice: PortraitChoice;
    }) =>
      client<Portrait>(
        `/api/portraits/${kind}/${encodeURIComponent(id)}`,
        "portrait",
        { method: "PUT", body: choice, fallback: "头像没有保存成功。" },
      ),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: portraitKeys.all }),
  });
}

export function resetPortraitMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: ({ kind, id }: { kind: PortraitKind; id: string }) =>
      client(`/api/portraits/${kind}/${encodeURIComponent(id)}`, {
        method: "DELETE",
        fallback: "没能恢复默认头像。",
      }),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: portraitKeys.all }),
  });
}

/** A Blob as the base64 the server's JSON body carries. */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}
