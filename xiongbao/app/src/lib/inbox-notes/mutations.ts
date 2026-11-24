import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import {
  type InboxNote,
  inboxNotesKeys,
  itemNotesPath,
  type NoteItemKind,
} from "./queries";

export type NoteInput = {
  text: string;
  quote?: { text: string; start: number; end: number };
};

type Target = { kind: NoteItemKind; id: string };

const refresh = (queryClient: QueryClient, { kind, id }: Target) =>
  queryClient.invalidateQueries({ queryKey: inboxNotesKeys.item(kind, id) });

export function addNoteMutationOptions(
  queryClient: QueryClient,
  target: Target,
) {
  return mutationOptions({
    mutationFn: (input: NoteInput): Promise<InboxNote> =>
      client(itemNotesPath(target.kind, target.id), "note", {
        method: "POST",
        body: input,
        fallback: "这条批注没能保存。",
      }),
    onSuccess: () => refresh(queryClient, target),
  });
}

export function removeNoteMutationOptions(
  queryClient: QueryClient,
  target: Target,
) {
  return mutationOptions({
    mutationFn: async (noteId: string): Promise<void> => {
      await client(
        `${itemNotesPath(target.kind, target.id)}/${encodeURIComponent(noteId)}`,
        { method: "DELETE", fallback: "这条批注没能删掉。" },
      );
    },
    onSuccess: () => refresh(queryClient, target),
  });
}

/** 把这条事项上所有批注合成一条消息，发回发起它的会话。 */
export function sendNotesMutationOptions(
  queryClient: QueryClient,
  target: Target,
) {
  return mutationOptions({
    mutationFn: (): Promise<number> =>
      client(`${itemNotesPath(target.kind, target.id)}/send`, "sent", {
        method: "POST",
        fallback: "批注没能发送。",
      }),
    onSuccess: () => refresh(queryClient, target),
  });
}
