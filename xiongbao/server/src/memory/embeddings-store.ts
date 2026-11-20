import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "../db/client";
import { memoryEmbeddings } from "../db/schema";
import { currentTenant } from "../tenant/context";

/** 一条记忆存着的向量：用哪个模型算的、算它时正文的摘要。 */
export type StoredEmbedding = {
  vector: number[];
  model: string;
  digest: string;
};

/**
 * 记忆向量的存取（`memory_embeddings`，迁移 0235）。在本人的帧里调用：行级安全只让本人读写自己的行。
 * 只管存取，算和比对是 `vectors.ts` 的事。
 */
export function createEmbeddingStore(database: Database) {
  return {
    /** 这些记忆已经存着的向量，按记忆编号。 */
    async load(ids: readonly string[]): Promise<Map<string, StoredEmbedding>> {
      if (ids.length === 0) return new Map();
      const rows = await database
        .select({
          id: memoryEmbeddings.memoryId,
          vector: memoryEmbeddings.embedding,
          model: memoryEmbeddings.model,
          digest: memoryEmbeddings.contentDigest,
        })
        .from(memoryEmbeddings)
        .where(
          and(
            eq(memoryEmbeddings.tenantId, currentTenant()),
            inArray(memoryEmbeddings.memoryId, [...ids]),
          ),
        );
      return new Map(
        rows.map((row) => [
          row.id,
          { vector: row.vector, model: row.model, digest: row.digest },
        ]),
      );
    },
    /** 存（或换掉）一批向量。记忆已经被删了的，外键拒绝那一行，不影响别的：逐行写。 */
    async save(
      rows: readonly {
        memoryId: string;
        model: string;
        digest: string;
        vector: readonly number[];
      }[],
    ): Promise<void> {
      for (const row of rows) {
        try {
          await database
            .insert(memoryEmbeddings)
            .values({
              memoryId: row.memoryId,
              tenantId: currentTenant(),
              model: row.model,
              dims: row.vector.length,
              embedding: [...row.vector],
              contentDigest: row.digest,
            })
            .onConflictDoUpdate({
              target: memoryEmbeddings.memoryId,
              set: {
                model: row.model,
                dims: row.vector.length,
                embedding: [...row.vector],
                contentDigest: row.digest,
              },
            });
        } catch {
          // Deleted while it was being embedded, or not a row of this table's parent: nothing to keep.
        }
      }
    },
  };
}

export type EmbeddingStore = ReturnType<typeof createEmbeddingStore>;
