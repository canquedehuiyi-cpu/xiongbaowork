import { guardedFetch, type OutboundPolicy } from "../net/outbound-guard";

/**
 * 把一段文字变成向量（期 2 · Task 2.3）：部署配置的、兼容 OpenAI 接口的向量服务（`POST {base}/embeddings`）。
 *
 *   XIONGBAO_EMBEDDING_BASE_URL  XIONGBAO_EMBEDDING_API_KEY  XIONGBAO_EMBEDDING_MODEL
 *
 * 三个都填了才算配置好；没配就是没有向量，`embedText` 返回 null，记忆按词的相关程度排序（`rank.ts`），和
 * 没有这个功能时一样。任何一步出错（连不上、超时、返回的东西读不成向量）也是 null，只在日志里记一行：向量只是
 * 让排序更准，不是这一轮能不能进行的条件。出站走和模型地址同一道校验（`net/outbound-guard.ts`）。
 */

export type EmbeddingConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
};

/** 读环境变量；三个缺一个就是没配置。 */
export function embeddingConfigOf(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): EmbeddingConfig | undefined {
  const read = (name: string) => environment[name]?.trim() || undefined;
  const baseUrl = read("XIONGBAO_EMBEDDING_BASE_URL");
  const apiKey = read("XIONGBAO_EMBEDDING_API_KEY");
  const model = read("XIONGBAO_EMBEDDING_MODEL");
  return baseUrl && apiKey && model
    ? { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey, model }
    : undefined;
}

/** 一段文字最多送多少字符去算向量：更长的只取开头，记忆本来就不长。 */
const MAX_INPUT_CHARS = 2000;
const TIMEOUT_MS = 4000;
/** 一次请求最多带多少段文字。 */
const MAX_BATCH = 64;

export type EmbedOptions = {
  config?: EmbeddingConfig | undefined;
  outbound?: OutboundPolicy;
  /** 测试替身：发请求的函数。缺省走出站校验。 */
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  log?: (line: string) => void;
};

let said = false;

/**
 * 一批文字的向量，和 `texts` 一一对应；没配置、出错、或返回的和请求对不上，整批返回 null。
 * 空串不送（返回空向量会让后面的余弦算出 NaN），整批当作没有向量。
 */
export async function embedTexts(
  texts: readonly string[],
  options: EmbedOptions = {},
): Promise<number[][] | null> {
  const config = "config" in options ? options.config : embeddingConfigOf();
  if (!config || texts.length === 0 || texts.length > MAX_BATCH) return null;
  const input = texts.map((text) => text.slice(0, MAX_INPUT_CHARS));
  if (input.some((text) => !text.trim())) return null;
  try {
    const init: RequestInit = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({ model: config.model, input }),
    };
    const url = `${config.baseUrl}/embeddings`;
    const response = options.fetchImpl
      ? await options.fetchImpl(url, {
          ...init,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        })
      : await guardedFetch(url, init, {
          ...(options.outbound ?? {}),
          timeoutMs: TIMEOUT_MS,
        });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as {
      data?: { index?: unknown; embedding?: unknown }[];
    };
    const rows = body.data;
    if (!Array.isArray(rows) || rows.length !== input.length)
      throw new Error("unexpected shape");
    const ordered = [...rows].sort(
      (a, b) => Number(a.index ?? 0) - Number(b.index ?? 0),
    );
    const vectors = ordered.map((row) => row.embedding);
    if (
      !vectors.every(
        (vector): vector is number[] =>
          Array.isArray(vector) &&
          vector.length > 0 &&
          vector.every((n) => typeof n === "number" && Number.isFinite(n)),
      )
    )
      throw new Error("unexpected vector");
    const dims = vectors[0]?.length;
    if (!vectors.every((vector) => vector.length === dims))
      throw new Error("mixed dimensions");
    return vectors;
  } catch (error) {
    // 只记一次类型，不记内容：服务的错误里可能带着送去的文字。
    if (!said) {
      said = true;
      (options.log ?? console.error)(
        JSON.stringify({
          type: "memory-embedding-unavailable",
          error: error instanceof Error ? error.name : "UnknownError",
          note: "Memory is ranked by word overlap until the embedding service answers.",
        }),
      );
    }
    return null;
  }
}

/** 一段文字的向量；没配置或出错是 null，调用方退回按词排序。 */
export async function embedText(
  text: string,
  options: EmbedOptions = {},
): Promise<number[] | null> {
  return (await embedTexts([text], options))?.[0] ?? null;
}

/** 两个向量的余弦相似度，-1 到 1。长度不同、有一个是零向量时是 0。 */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let index = 0; index < a.length; index += 1) {
    const x = a[index] ?? 0;
    const y = b[index] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}
