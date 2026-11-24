import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/** 能写批注的事项：审批箱里的一条提问（计划也是提问），或一条等你批准的请求。 */
export type NoteItemKind = "question" | "approval";

export type InboxNote = {
  id: string;
  text: string;
  /** 引用的那一段原文，和它在事项文字里的起止位置。 */
  quote?: { text: string; start: number; end: number };
  at: string;
};

/** 引导式评审的一章：标题、一句说明，和归在这章的文件。 */
export type ReviewChapter = {
  id: "core" | "impact" | "glue";
  title: string;
  summary: string;
  files: string[];
};

export type InboxNotesData = {
  notes: InboxNote[];
  /** 改动是代码时按文件路径分的三章；不是代码改动为 null。 */
  review: ReviewChapter[] | null;
};

export const inboxNotesKeys = {
  all: ["inbox-notes"] as const,
  item: (kind: NoteItemKind, id: string) => ["inbox-notes", kind, id] as const,
};

export const itemNotesPath = (kind: NoteItemKind, id: string) =>
  `/api/approvals/items/${kind}/${encodeURIComponent(id)}/notes`;

export function inboxNotesQueryOptions(kind: NoteItemKind, id: string) {
  return queryOptions({
    queryKey: inboxNotesKeys.item(kind, id),
    queryFn: async ({ signal }): Promise<InboxNotesData> =>
      (
        await client(itemNotesPath(kind, id), {
          signal,
          fallback: "读不到这条事项的批注。",
        })
      ).json(),
  });
}
