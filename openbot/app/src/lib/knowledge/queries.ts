import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { client, RequestError } from "@/lib/client";

/**
 * A person's own knowledge bases (D08 RES1), as `/api/knowledge` answers for them: the reads, and
 * further down the writes.
 *
 * Everything here is the signed-in person's: the server scopes every read to the caller's own
 * workspace and their own notebooks, so the browser never filters by owner itself.
 */

/** The cap the server enforces on one source, in characters (code points) — the "64K" a person sees. */
export const KNOWLEDGE_SOURCE_MAX_CHARS = 65_536;

export type KnowledgeSourceKind = "text" | "markdown";

export type KnowledgeNotebook = {
  id: string;
  title: string;
  /** Optimistic-concurrency token: every write sends the one it read, and a stale one is a 409. */
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type KnowledgeSourceSummary = {
  id: string;
  notebookId: string;
  title: string;
  kind: string;
  digest: string | null;
  chars: number;
  revision: number;
  updatedAt: string;
};

export type KnowledgeSource = KnowledgeSourceSummary & { content: string };

export type KnowledgeBinding = {
  agentId: string;
  notebookId: string;
  accessMode: string;
  updatedAt: string;
};

export type KnowledgeNotebookDetail = {
  notebook: KnowledgeNotebook;
  sources: KnowledgeSourceSummary[];
  bindings: KnowledgeBinding[];
};

/** A notebook one Waker may read, as `GET /api/knowledge/for/:agentId` lists it. */
export type KnowledgeAgentNotebook = {
  notebookId: string;
  title: string;
  accessMode: string;
};

export const knowledgeKeys = {
  all: ["knowledge"] as const,
  notebooks: () => ["knowledge", "notebooks"] as const,
  notebook: (notebookId: string) =>
    ["knowledge", "notebook", notebookId] as const,
  source: (notebookId: string, sourceId: string) =>
    ["knowledge", "source", notebookId, sourceId] as const,
  forAgent: (agentId: string) => ["knowledge", "for", agentId] as const,
};

/** Characters as the server counts them: code points, so an emoji is one, not two. */
export function knowledgeChars(value: string): number {
  return [...value].length;
}

export function knowledgeNotebooksQueryOptions() {
  return queryOptions({
    queryKey: knowledgeKeys.notebooks(),
    queryFn: async (): Promise<KnowledgeNotebook[]> =>
      // An answer without the list is treated as an empty one rather than as undefined data, which
      // TanStack Query refuses outright.
      (await client<KnowledgeNotebook[] | undefined>(
        "/api/knowledge/notebooks",
        "notebooks",
        { fallback: "读不到知识库列表。" },
      )) ?? [],
  });
}

export function knowledgeNotebookQueryOptions(notebookId: string) {
  return queryOptions({
    queryKey: knowledgeKeys.notebook(notebookId),
    queryFn: async (): Promise<KnowledgeNotebookDetail> => {
      const response = await client(
        `/api/knowledge/notebooks/${encodeURIComponent(notebookId)}`,
        { fallback: "读不到这个知识库。" },
      );
      const body = (await response
        .json()
        .catch(() => null)) as Partial<KnowledgeNotebookDetail> | null;
      if (!body?.notebook) throw new Error("读不到这个知识库。");
      return {
        notebook: body.notebook,
        sources: body.sources ?? [],
        bindings: body.bindings ?? [],
      };
    },
  });
}

export function knowledgeSourceQueryOptions(
  notebookId: string,
  sourceId: string,
) {
  return queryOptions({
    queryKey: knowledgeKeys.source(notebookId, sourceId),
    queryFn: async (): Promise<KnowledgeSource> => {
      const source = await client<KnowledgeSource | undefined>(
        `/api/knowledge/notebooks/${encodeURIComponent(notebookId)}/sources/${encodeURIComponent(sourceId)}`,
        "source",
        { fallback: "读不到这份资料。" },
      );
      if (!source) throw new Error("读不到这份资料。");
      return source;
    },
  });
}

/**
 * The notebooks one of the person's own Wakers may read.
 *
 * Only asked about a Waker the person owns: the server answers 403 for anybody else's, and a
 * Waker that is not theirs cannot hold a binding to their notebooks in the first place.
 */
export function knowledgeForAgentQueryOptions(agentId: string) {
  return queryOptions({
    queryKey: knowledgeKeys.forAgent(agentId),
    queryFn: async (): Promise<KnowledgeAgentNotebook[]> =>
      (await client<KnowledgeAgentNotebook[] | undefined>(
        `/api/knowledge/for/${encodeURIComponent(agentId)}`,
        "notebooks",
        { fallback: "读不到这位员工能读的知识库。" },
      )) ?? [],
  });
}

/**
 * Writes against a person's own knowledge bases (D08 RES1).
 *
 * Every write that edits something already there carries the `revision` it was drawn from. The
 * server answers 409 when somebody else wrote in between, and the screen answers that by re-reading
 * rather than by retrying — see {@link isKnowledgeConflict}.
 *
 * Every write refetches on `onSettled`, not `onSuccess`: a refusal is still a reason to re-read,
 * and a 409 is precisely the case where the copy on screen is the wrong one.
 */

/** What a person reads when another tab or device changed the same thing first. */
export const KNOWLEDGE_CONFLICT_MESSAGE = "别人刚改过，已刷新";

const FALLBACK = "知识库没能保存。";

/** Whether a write was refused because what it was based on is no longer current. */
export function isKnowledgeConflict(error: unknown): boolean {
  return error instanceof RequestError && error.status === 409;
}

function notebookPath(notebookId: string) {
  return `/api/knowledge/notebooks/${encodeURIComponent(notebookId)}`;
}

function sourcePath(notebookId: string, sourceId: string) {
  return `${notebookPath(notebookId)}/sources/${encodeURIComponent(sourceId)}`;
}

/** Re-read everything the knowledge screens and the assembly page's knowledge zone draw. */
export function invalidateKnowledge(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: knowledgeKeys.all });
}

export function createNotebookMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (input: { title: string }) =>
      client<KnowledgeNotebook>("/api/knowledge/notebooks", "notebook", {
        method: "POST",
        body: { title: input.title },
        fallback: "知识库没能创建。",
      }),
    onSettled: () => invalidateKnowledge(queryClient),
  });
}

export function renameNotebookMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (input: {
      notebookId: string;
      title: string;
      revision: number;
    }) =>
      client<KnowledgeNotebook>(notebookPath(input.notebookId), "notebook", {
        method: "PATCH",
        body: { title: input.title, revision: input.revision },
        fallback: FALLBACK,
      }),
    onSettled: () => invalidateKnowledge(queryClient),
  });
}

export function deleteNotebookMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: { notebookId: string; revision: number }) => {
      await client(notebookPath(input.notebookId), {
        method: "DELETE",
        body: { revision: input.revision },
        fallback: "知识库没能删除。",
      });
    },
    // Drop it from the list at once, so the screen moves off it before the refetch: otherwise its
    // open panel re-reads a notebook that is gone and flashes a 404 until the list catches up.
    onSuccess: (_result, input) => {
      queryClient.setQueryData<KnowledgeNotebook[]>(
        knowledgeKeys.notebooks(),
        (notebooks) =>
          notebooks?.filter((notebook) => notebook.id !== input.notebookId),
      );
    },
    onSettled: () => invalidateKnowledge(queryClient),
  });
}

export function addSourceMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (input: {
      notebookId: string;
      title: string;
      kind: KnowledgeSourceKind;
      content: string;
    }) =>
      client<KnowledgeSource>(
        `${notebookPath(input.notebookId)}/sources`,
        "source",
        {
          method: "POST",
          body: {
            title: input.title,
            kind: input.kind,
            content: input.content,
          },
          fallback: "资料没能添加。",
        },
      ),
    onSettled: () => invalidateKnowledge(queryClient),
  });
}

export function updateSourceMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (input: {
      notebookId: string;
      sourceId: string;
      title: string;
      content: string;
      revision: number;
    }) =>
      client<KnowledgeSource>(
        sourcePath(input.notebookId, input.sourceId),
        "source",
        {
          method: "PATCH",
          body: {
            title: input.title,
            content: input.content,
            revision: input.revision,
          },
          fallback: "资料没能保存。",
        },
      ),
    onSettled: () => invalidateKnowledge(queryClient),
  });
}

export function removeSourceMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: { notebookId: string; sourceId: string }) => {
      await client(sourcePath(input.notebookId, input.sourceId), {
        method: "DELETE",
        fallback: "资料没能删除。",
      });
    },
    onSettled: () => invalidateKnowledge(queryClient),
  });
}

/**
 * Let one of the person's own Wakers read a notebook, or take that back.
 *
 * Only `read_only` exists on the server; it is sent explicitly so a later mode cannot be granted by
 * a client that never asked for it.
 */
export function setKnowledgeBindingMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: {
      notebookId: string;
      agentId: string;
      granted: boolean;
    }): Promise<KnowledgeBinding | null> => {
      const path = `${notebookPath(input.notebookId)}/bindings/${encodeURIComponent(input.agentId)}`;
      if (input.granted) {
        return client<KnowledgeBinding>(path, "binding", {
          method: "PUT",
          body: { accessMode: "read_only" },
          fallback: "授权没有成功。",
        });
      }
      await client(path, { method: "DELETE", fallback: "收回授权没有成功。" });
      return null;
    },
    onSettled: () => invalidateKnowledge(queryClient),
  });
}
