/**
 * 记忆按和这条消息的相关程度取，而不是整包注入（期 1·1.2）。
 *
 * 为什么：每一轮都把能取到的记忆全部放进上下文，一个攒了几十条记忆的人，每一步都要多发约两万多字符，
 * 其中绝大多数和眼前这件事无关。现在设一个字符预算（`XIONGBAO_MEMORY_INJECT_CHARS`，默认 4000），
 * 按和用户最新一条消息的词重叠相似度排序，从最相关的取起，放不下的不放；员工要别的记忆，用
 * `recall_personal_memory` 按需取，那个工具不受这个预算限制。
 *
 * 相似度默认只看词：英文数字按词（去掉复数的 s），中日韩文字按相邻两字（中文没有空格，整词切分要词典）。
 * 部署配了向量服务（`XIONGBAO_EMBEDDING_*`，期 2）并且这一批记忆和消息的向量都有时，改按余弦相似度排；
 * 没有向量（没配、服务出错）就是上面的词重叠，一点没变。预算和取法两种打分共用。
 */
import { tokensOf } from "../text-tokens";
import { cosine } from "./embed";

/** 注入的记忆合计最多这么多字符（含每条的来源和包装）。 */
export const DEFAULT_MEMORY_INJECT_CHARS = 4000;
/** 预算最小值：比这更小放不下一条完整的记忆，当作配错，退回默认。 */
const MIN_MEMORY_INJECT_CHARS = 500;
/** 一条记忆最多放进多少字符。 */
export const MEMORY_RECORD_MAX_CHARS = 6000;
/** 每条记忆除正文和来源外，包装（id、字段名、引号）大约占多少字符。 */
const RECORD_OVERHEAD_CHARS = 100;

/** 部署配置的预算：`XIONGBAO_MEMORY_INJECT_CHARS`，不是不小于 500 的整数就用默认值。 */
export function memoryInjectBudget(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.XIONGBAO_MEMORY_INJECT_CHARS?.trim();
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_MEMORY_INJECT_CHARS;
  const value = Number(raw);
  return value >= MIN_MEMORY_INJECT_CHARS ? value : DEFAULT_MEMORY_INJECT_CHARS;
}

type Rankable = { id?: string; content: string; provenance: string };

/** 这一批记忆和消息的向量（`vectors.ts`）。记忆按编号对；缺一条就不能用。 */
export type RankVectors = {
  query: readonly number[];
  byId: ReadonlyMap<string, readonly number[]>;
};

/** 一条记忆放进去要占的字符数。 */
export const recordCost = (memory: Rankable): number =>
  Math.min(memory.content.length, MEMORY_RECORD_MAX_CHARS) +
  memory.provenance.length +
  RECORD_OVERHEAD_CHARS;

/** 向量能用：有消息的向量，而且每一条记忆都有编号、都有同样长的向量。 */
function usableVectors<T extends Rankable>(
  memories: readonly T[],
  vectors: RankVectors | null | undefined,
): vectors is RankVectors {
  if (!vectors || vectors.query.length === 0) return false;
  return memories.every(
    (memory) =>
      memory.id !== undefined &&
      vectors.byId.get(memory.id)?.length === vectors.query.length,
  );
}

/** 按向量：和消息的余弦相似度。 */
function semanticScores<T extends Rankable>(
  memories: readonly T[],
  vectors: RankVectors,
) {
  return memories.map((memory, index) => ({
    memory,
    index,
    score: cosine(vectors.query, vectors.byId.get(memory.id ?? "") ?? []),
  }));
}

/** 按词：共有的词的权重之和（见 {@link rankMemories}）。 */
function lexicalScores<T extends Rankable>(
  query: string,
  memories: readonly T[],
) {
  const wanted = tokensOf(query);
  const sets = memories.map((memory) => tokensOf(memory.content));
  const weight = (token: string) => {
    const holders = sets.filter((set) => set.has(token)).length;
    return Math.log(1 + memories.length / (1 + holders));
  };
  const weights = new Map([...wanted].map((token) => [token, weight(token)]));
  return memories.map((memory, index) => {
    const set = sets[index] ?? new Set<string>();
    let score = 0;
    for (const token of wanted)
      if (set.has(token)) score += weights.get(token) ?? 0;
    return { memory, index, score: score / Math.sqrt(set.size + 1) };
  });
}

/**
 * 按和 `query` 的相关程度排序，从最相关的取起，合计不超过 `budgetChars` 个字符。
 *
 * 分数是共有的词的权重之和：在越少的记忆里出现的词权重越大（常见的词不值钱），再除以记忆本身词数的平方根，
 * 免得长记忆靠词多占便宜。没有共有的词（或消息是空的）时保持传入的顺序，调用方传的是最近更新的在前。
 * 第一条（最相关的）比整个预算还长也要给，由引用时截断；之后放不下整条的就跳过，接着试更短的。
 * 不改传入的数组。
 */
export function rankMemories<T extends Rankable>(
  query: string,
  memories: readonly T[],
  budgetChars: number,
  vectors?: RankVectors | null,
): T[] {
  const scored = usableVectors(memories, vectors)
    ? semanticScores(memories, vectors)
    : lexicalScores(query, memories);
  scored.sort((a, b) => b.score - a.score || a.index - b.index);

  const picked: T[] = [];
  let remaining = budgetChars;
  for (const { memory } of scored) {
    const cost = recordCost(memory);
    if (cost <= remaining) {
      picked.push(memory);
      remaining -= cost;
    } else if (
      picked.length === 0 &&
      remaining > memory.provenance.length + RECORD_OVERHEAD_CHARS
    ) {
      picked.push(memory);
      remaining = 0;
    }
    if (remaining < RECORD_OVERHEAD_CHARS) break;
  }
  return picked;
}
