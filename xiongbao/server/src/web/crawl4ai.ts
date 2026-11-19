/**
 * 部署里自带的爬虫服务：Crawl4AI（unclecode/crawl4ai，Apache-2.0）。能渲染 JS，能按深度爬整站。
 *
 * 用到它的两个端点（v0.9.5 的 REST API，见 deploy/docker/README.md）：
 *  - `POST /crawl`，`urls` 只放一个地址：渲染一页，取渲染后的 `html`（web_fetch 的 `render_js`）。
 *  - `POST /crawl`，`crawler_config.params.deep_crawl_strategy` 用 `BFSDeepCrawlStrategy`：按广度爬整站
 *    （web_crawl）。服务端要开 `CRAWL4AI_ALLOW_DEEP_CRAWL=true`，页数和深度它自己还会再夹一次。
 * 鉴权是 `Authorization: Bearer <CRAWL4AI_API_TOKEN>`：它绑非回环地址时必须有令牌，没有就不启动。
 *
 * 只把校验过的公网地址交给它（调用方在交之前过 `checkFetchUrl` 和 DNS 校验）；爬取中途发现的链接由它自己去
 * 请求，它自带出站校验（`CRAWL4AI_ALLOW_INTERNAL_URLS` 默认 false，非公网地址一律拦），compose 里它也只在
 * 一个单独的网络上。它交回来的每一页，调用方再按地址校验一遍，内网的丢掉。
 *
 * 出错抛 {@link CrawlServiceError}，`message` 是中文，调用方据此退回进程内的抓取。
 */
import { CRAWLER_USER_AGENT } from "./fetch-page";

export class CrawlServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CrawlServiceError";
  }
}

export type RenderedPage = {
  /** 最后一跳的地址（跟过重定向之后）。 */
  url: string;
  html: string;
  status?: number;
};

export type ServicePage = {
  url: string;
  title: string;
  markdown: string;
  html?: string;
  depth?: number;
};

export type DeepCrawlRequest = {
  url: string;
  maxPages: number;
  maxDepth: number;
  sameDomain: boolean;
  include: readonly string[];
  exclude: readonly string[];
  timeoutMs: number;
};

export interface CrawlService {
  readonly source: string;
  render(url: string, signal?: AbortSignal): Promise<RenderedPage>;
  deepCrawl(
    request: DeepCrawlRequest,
    signal?: AbortSignal,
  ): Promise<ServicePage[]>;
}

/** 渲染一页最多等多久。 */
const RENDER_TIMEOUT_MS = 45_000;

const BROWSER_CONFIG = {
  type: "BrowserConfig",
  params: { headless: true, text_mode: true, user_agent: CRAWLER_USER_AGENT },
};

export function crawl4aiService(options: {
  baseUrl: string;
  token?: string;
  fetchImpl?: typeof fetch;
}): CrawlService {
  const base = options.baseUrl.replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;

  async function crawl(
    body: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>[]> {
    let response: Response;
    try {
      response = await fetchImpl(`${base}/crawl`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...(options.token
            ? { authorization: `Bearer ${options.token}` }
            : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.any(
          [AbortSignal.timeout(timeoutMs), signal].filter(
            (value): value is AbortSignal => value !== undefined,
          ),
        ),
      });
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError")
      )
        throw new CrawlServiceError(
          `爬虫服务 ${Math.round(timeoutMs / 1000)} 秒内没有完成。`,
        );
      throw new CrawlServiceError("连不上爬虫服务。");
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined);
      throw new CrawlServiceError(
        "爬虫服务拒绝了请求：XIONGBAO_CRAWL_TOKEN 与 Crawl4AI 的 CRAWL4AI_API_TOKEN 不一致。",
      );
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new CrawlServiceError(
        `爬虫服务返回的不是 JSON（HTTP ${response.status}）。`,
      );
    }
    if (!response.ok) {
      const detail =
        json && typeof json === "object"
          ? (json as { detail?: unknown }).detail
          : undefined;
      throw new CrawlServiceError(
        `爬虫服务出错了（HTTP ${response.status}${typeof detail === "string" ? `：${detail.slice(0, 200)}` : ""}）。`,
      );
    }
    const results =
      json && typeof json === "object"
        ? (json as { results?: unknown }).results
        : undefined;
    if (!Array.isArray(results))
      throw new CrawlServiceError("爬虫服务没有返回结果。");
    return results.filter(
      (entry): entry is Record<string, unknown> =>
        Boolean(entry) && typeof entry === "object",
    );
  }

  return {
    source: "Crawl4AI（本部署自建的爬虫服务）",
    async render(url, signal) {
      const [result] = await crawl(
        {
          urls: [url],
          browser_config: BROWSER_CONFIG,
          crawler_config: {
            type: "CrawlerRunConfig",
            params: {
              cache_mode: "bypass",
              page_timeout: 30_000,
              user_agent: CRAWLER_USER_AGENT,
            },
          },
        },
        RENDER_TIMEOUT_MS,
        signal,
      );
      if (
        !result ||
        result.success === false ||
        typeof result.html !== "string"
      )
        throw new CrawlServiceError(
          `爬虫服务没能渲染这一页${typeof result?.error_message === "string" ? `：${result.error_message.slice(0, 200)}` : ""}。`,
        );
      const finalUrl =
        typeof result.redirected_url === "string" && result.redirected_url
          ? result.redirected_url
          : typeof result.url === "string"
            ? result.url
            : url;
      return {
        url: finalUrl,
        html: result.html,
        ...(typeof result.status_code === "number"
          ? { status: result.status_code }
          : {}),
      };
    },
    async deepCrawl(request, signal) {
      const host = new URL(request.url).hostname;
      const filters = [
        ...(request.sameDomain
          ? [{ type: "DomainFilter", params: { allowed_domains: [host] } }]
          : []),
        ...(request.include.length > 0
          ? [
              {
                type: "URLPatternFilter",
                params: { patterns: [...request.include] },
              },
            ]
          : []),
        ...(request.exclude.length > 0
          ? [
              {
                type: "URLPatternFilter",
                params: { patterns: [...request.exclude], reverse: true },
              },
            ]
          : []),
      ];
      const results = await crawl(
        {
          urls: [request.url],
          browser_config: BROWSER_CONFIG,
          crawler_config: {
            type: "CrawlerRunConfig",
            params: {
              cache_mode: "bypass",
              check_robots_txt: true,
              page_timeout: 30_000,
              mean_delay: 1.0,
              user_agent: CRAWLER_USER_AGENT,
              deep_crawl_strategy: {
                type: "BFSDeepCrawlStrategy",
                params: {
                  max_depth: request.maxDepth,
                  max_pages: request.maxPages,
                  include_external: !request.sameDomain,
                  ...(filters.length > 0
                    ? {
                        filter_chain: {
                          type: "FilterChain",
                          params: { filters },
                        },
                      }
                    : {}),
                },
              },
            },
          },
        },
        request.timeoutMs,
        signal,
      );
      return results
        .filter((result) => result.success !== false)
        .map((result): ServicePage | null => {
          const url =
            typeof result.redirected_url === "string" && result.redirected_url
              ? result.redirected_url
              : typeof result.url === "string"
                ? result.url
                : "";
          if (!url) return null;
          const metadata =
            result.metadata && typeof result.metadata === "object"
              ? (result.metadata as Record<string, unknown>)
              : {};
          return {
            url,
            title: typeof metadata.title === "string" ? metadata.title : "",
            markdown: markdownOf(result.markdown),
            ...(typeof result.html === "string" ? { html: result.html } : {}),
            ...(typeof metadata.depth === "number"
              ? { depth: metadata.depth }
              : {}),
          };
        })
        .filter((page): page is ServicePage => page !== null);
    },
  };
}

/** 结果里的 markdown：老版本是字符串，新版本是 `{ raw_markdown, fit_markdown, … }`。 */
function markdownOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const { fit_markdown, raw_markdown } = value as Record<string, unknown>;
  if (typeof fit_markdown === "string" && fit_markdown.trim())
    return fit_markdown;
  return typeof raw_markdown === "string" ? raw_markdown : "";
}

/**
 * 这个部署的爬虫服务，读自环境变量：`XIONGBAO_CRAWL_URL`（Crawl4AI 地址）和 `XIONGBAO_CRAWL_TOKEN`（它的
 * `CRAWL4AI_API_TOKEN`）。没配地址时 `service` 为空：web_fetch 的 render_js 退回普通抓取，web_crawl 退回进程内
 * 的简易爬取。
 */
export function resolveCrawlService(
  env: Readonly<Record<string, string | undefined>> = process.env,
  options: { fetchImpl?: typeof fetch } = {},
):
  | { service: CrawlService; problem?: undefined }
  | {
      service?: undefined;
      problem: string;
    } {
  const baseUrl = (env.XIONGBAO_CRAWL_URL ?? "").trim();
  if (baseUrl === "") return { problem: CRAWL_NOT_CONFIGURED };
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      throw new Error("scheme");
  } catch {
    return {
      problem:
        "本部署配置的爬虫服务地址 XIONGBAO_CRAWL_URL 不是有效的 http 或 https 地址。",
    };
  }
  const token = (env.XIONGBAO_CRAWL_TOKEN ?? "").trim();
  return {
    service: crawl4aiService({
      baseUrl,
      ...(token ? { token } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    }),
  };
}

export const CRAWL_NOT_CONFIGURED =
  "本部署没有配置爬虫服务（Crawl4AI，XIONGBAO_CRAWL_URL）。";
