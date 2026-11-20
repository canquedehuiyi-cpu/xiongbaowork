import { createHash } from "node:crypto";
import {
  type EmbedOptions,
  type EmbeddingConfig,
  embeddingConfigOf,
  embedTexts,
} from "./embed";
import type { EmbeddingStore } from "./embeddings-store";

/**
 * 这一次要挑的记忆的向量，和用户最新一条消息的向量（期 2 · Task 2.3）。给 `rankMemories` 用：有了向量就按
 * 语义相关程度排，没有就返回 null，`rankMemories` 退回按词的相关程度排。
 *
 * 全有或全无：候选里只要有一条算不出向量（向量服务出错、没配置），整次返回 null。一半按向量、一半按词的分数
 * 不在一个尺度上，混着排比两种都不如。
 *
 * 记忆的向量第一次要用到时才算，存起来（`embeddings-store.ts`）：正文没变、模型没换就一直用，所以稳定
 * 状态下一次挑选只花一次请求（算消息的向量）。只存本人名下的记忆；后端里只有的记忆（`formedBy: "intelligence"`，
 * 没有对应的行）每次现算、不存。
 */

export type VectorizableMemory = {
  id: string;
  content: string;
  formedBy?: string;
};

export type MemoryVectors = {
  query: readonly number[];
  byId: ReadonlyMap<string, readonly number[]>;
};

/**
 * 一次最多给几条记忆算新向量。候选最多 200 条，第一次全是新的：一次算完要多个请求，把这一轮拖慢。所以一次
 * 只算这么多、存起来，这一次的排序退回按词，后面几轮把剩下的补齐，补齐了才按语义排。
 */
export const MAX_NEW_PER_CALL = 48;

const digestOf = (content: string) =>
  createHash("sha256").update(content).digest("hex");

export function createMemoryVectors(deps: {
  store: EmbeddingStore;
  /** 向量服务的配置；缺省读环境变量，每次问一遍（改了配置不用重启）。 */
  config?: () => EmbeddingConfig | undefined;
  embed?: EmbedOptions;
}) {
  const configOf = deps.config ?? (() => embeddingConfigOf());
  return {
    /** 在本人的帧里调用。没有向量服务、或有一条算不出，返回 null。 */
    async vectorsFor(
      memories: readonly VectorizableMemory[],
      query: string,
    ): Promise<MemoryVectors | null> {
      const config = configOf();
      if (!config || memories.length === 0 || !query.trim()) return null;
      const stored = await deps.store.load(
        memories.filter((m) => m.formedBy !== "intelligence").map((m) => m.id),
      );
      const byId = new Map<string, readonly number[]>();
      const missing: VectorizableMemory[] = [];
      for (const memory of memories) {
        const held = stored.get(memory.id);
        if (
          held &&
          held.model === config.model &&
          held.digest === digestOf(memory.content)
        )
          byId.set(memory.id, held.vector);
        else missing.push(memory);
      }
      // 消息的向量和缺的记忆的向量一次请求。
      const batch = missing.slice(0, MAX_NEW_PER_CALL);
      const vectors = await embedTexts(
        [query, ...batch.map((memory) => memory.content)],
        { ...deps.embed, config },
      );
      if (!vectors) return null;
      const [queryVector, ...fresh] = vectors;
      if (!queryVector) return null;
      const toSave: {
        memoryId: string;
        model: string;
        digest: string;
        vector: number[];
      }[] = [];
      batch.forEach((memory, index) => {
        const vector = fresh[index];
        if (!vector) return;
        byId.set(memory.id, vector);
        if (memory.formedBy !== "intelligence")
          toSave.push({
            memoryId: memory.id,
            model: config.model,
            digest: digestOf(memory.content),
            vector,
          });
      });
      // 存不进去不影响这一次：下一次再算。
      await deps.store.save(toSave).catch(() => undefined);
      if (byId.size !== memories.length) return null;
      return { query: queryVector, byId };
    },
  };
}

export type MemoryVectorsService = ReturnType<typeof createMemoryVectors>;
