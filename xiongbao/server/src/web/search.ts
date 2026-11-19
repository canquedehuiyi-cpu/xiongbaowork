/**
 * 员工的联网搜索从哪里来：一个可以换的提供方。
 *
 * 默认是部署里自带的 SearXNG（自建的元搜索，免费，不要 key；2026-11-19 用户选定「免费的渠道」）。以后接别的
 * 提供方，只要再实现一个 {@link SearchProvider}，在 {@link resolveSearchProvider} 里按名字认出它。
 *
 * 地址由运维配置（`XIONGBAO_SEARCH_URL`），模型改不了，所以这里不走 web_fetch 那道 SSRF 校验：compose 里
 * SearXNG 就在内网（`http://searxng:8080`），那正是运维要它去的地方。
 *
 * 出错从不抛给运行：没配置、提供方不认识、上游 500、超时，都变成一句中文说明交给模型（见 `tools.ts`）。
 */

import { createHostPacer, type HostPacer } from "./robots";

/** 一条搜索结果，交给模型的样子。 */
export type SearchResult = { title: string; url: string; snippet: string };

export type SearchRequest = {
  query: string;
  /** 最多要几条，已经按上限截过。 */
  maxResults: number;
  /** 搜索语言，例如 `zh-CN`。 */
  language: string;
  signal?: AbortSignal;
};

/** 一个搜索提供方。失败时抛 {@link SearchFailedError}，或任何错误，由工具统一说成中文。 */
export interface SearchProvider {
  /** 配置里的名字，例如 `searxng`。 */
  readonly name: string;
  /** 给模型看的来源说明，例如「SearXNG（本部署自建的元搜索）」。 */
  readonly source: string;
  search(request: SearchRequest): Promise<SearchResult[]>;
}

/** 提供方没能给出结果，`message` 是给模型看的中文原因。 */
export class SearchFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchFailedError";
  }
}

/** 一次搜索最多等多久。SearXNG 自己对每个引擎有 3 到 10 秒的超时，这里再留一些余量。 */
export const SEARCH_TIMEOUT_MS = 15_000;

/**
 * 全部署的搜索频率：两次搜索之间至少隔 500 毫秒（每秒最多两次）。SearXNG 再转给各家搜索引擎，搜得太密
 * 会被它们限流或弹验证码，整个部署一起搜不了。
 */
export const searchPacer: HostPacer = createHostPacer({ intervalMs: 500 });

/** 单条摘要的最长字数：搜索引擎偶尔把整段正文塞进摘要。 */
const SNIPPET_MAX = 500;

/**
 * SearXNG：`GET <地址>/search?q=…&format=json`。
 *
 * 要求实例打开 json 格式（`search.formats` 里有 `json`，见 `docker/searxng/settings.yml`）；没打开时
 * SearXNG 回 403，这里说清是哪个设置。
 */
export function searxngProvider(options: {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  pacer?: HostPacer;
}): SearchProvider {
  const base = options.baseUrl.replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? SEARCH_TIMEOUT_MS;
  const pacer = options.pacer ?? searchPacer;
  return {
    name: "searxng",
    source: "SearXNG（本部署自建的元搜索）",
    async search({ query, maxResults, language, signal }) {
      await pacer.wait("search", 0, signal);
      const url = new URL(`${base}/search`);
      url.searchParams.set("q", query);
      url.searchParams.set("format", "json");
      url.searchParams.set("language", language);
      url.searchParams.set("safesearch", "1");
      const signals = [AbortSignal.timeout(timeoutMs), signal].filter(
        (value): value is AbortSignal => value !== undefined,
      );
      let response: Response;
      try {
        response = await fetchImpl(url, {
          headers: { accept: "application/json" },
          signal: AbortSignal.any(signals),
        });
      } catch (error) {
        if (isTimeout(error))
          throw new SearchFailedError(
            `搜索服务 ${timeoutMs / 1000} 秒内没有响应。`,
          );
        throw new SearchFailedError("连不上搜索服务。");
      }
      if (response.status === 403) {
        await response.body?.cancel().catch(() => undefined);
        throw new SearchFailedError(
          "搜索服务拒绝了 JSON 格式的请求（HTTP 403）：SearXNG 的 settings.yml 里 search.formats 要包含 json。",
        );
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new SearchFailedError(
          `搜索服务出错了（HTTP ${response.status}）。`,
        );
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch (error) {
        if (isTimeout(error))
          throw new SearchFailedError(
            `搜索服务 ${timeoutMs / 1000} 秒内没有响应。`,
          );
        throw new SearchFailedError("搜索服务返回的不是 JSON。");
      }
      return readSearxngResults(body).slice(0, maxResults);
    },
  };
}

/** SearXNG 的 `results` 读成 {@link SearchResult}：没有地址的丢掉，同一地址只留一条。 */
function readSearxngResults(body: unknown): SearchResult[] {
  const raw =
    body && typeof body === "object"
      ? (body as { results?: unknown }).results
      : undefined;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const results: SearchResult[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const { url, title, content } = entry as Record<string, unknown>;
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    results.push({
      title: oneLine(typeof title === "string" ? title : "") || url,
      url,
      snippet: oneLine(typeof content === "string" ? content : "").slice(
        0,
        SNIPPET_MAX,
      ),
    });
  }
  return results;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

/**
 * 这个部署的搜索提供方，读自环境变量。
 *
 * - `XIONGBAO_SEARCH_PROVIDER`：提供方的名字，默认 `searxng`。
 * - `XIONGBAO_SEARCH_URL`：SearXNG 的地址。compose 部署默认指向自带的 `searxng` 服务；单镜像部署默认没有。
 *
 * 新变量只认 `XIONGBAO_` 名字（逐步重写的规矩）。没配好时 `provider` 为空，`problem` 是交给模型的中文说明。
 */
export function resolveSearchProvider(
  env: Readonly<Record<string, string | undefined>> = process.env,
  options: { fetchImpl?: typeof fetch; pacer?: HostPacer } = {},
):
  | { provider: SearchProvider; problem?: undefined }
  | {
      provider?: undefined;
      problem: string;
    } {
  const name = (env.XIONGBAO_SEARCH_PROVIDER ?? "").trim().toLowerCase();
  if (name !== "" && name !== "searxng")
    return {
      problem: `本部署的搜索提供方 XIONGBAO_SEARCH_PROVIDER=${name} 不认识（目前支持 searxng），所以联网搜索用不了。`,
    };
  const baseUrl = (env.XIONGBAO_SEARCH_URL ?? "").trim();
  if (baseUrl === "") return { problem: SEARCH_NOT_CONFIGURED };
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      throw new Error("scheme");
  } catch {
    return {
      problem:
        "本部署配置的搜索服务地址 XIONGBAO_SEARCH_URL 不是有效的 http 或 https 地址，所以联网搜索用不了。",
    };
  }
  return {
    provider: searxngProvider({
      baseUrl,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.pacer ? { pacer: options.pacer } : {}),
    }),
  };
}

/** 没配搜索服务时交给模型的话。单镜像部署默认就是这样。 */
export const SEARCH_NOT_CONFIGURED =
  "本部署没有配置搜索服务（未配置搜索），所以联网搜索用不了。管理员可以部署 SearXNG 并设置 XIONGBAO_SEARCH_URL 打开它。";
