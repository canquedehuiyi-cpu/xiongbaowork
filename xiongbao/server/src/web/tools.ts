/**
 * 员工自带的三个联网工具：`web_search`、`web_fetch`、`web_crawl`。
 *
 * 每位员工默认都有（`index.ts` 的 `loadGrantedToolsForActor`），工具权限里关掉 `bot/web_search`、
 * `bot/web_fetch` 或 `bot/web_crawl` 就不给，与 `update_plan` 一样。
 *
 * 出错一律答话，从不抛：没配置、上游出错、超时、地址被拒，模型都拿到一句中文，接着换办法。只有运行本身被
 * 停下（abort）才让错误往外走。
 *
 * 结果都是外部内容，套上不可信内容的说明（`untrusted-content.ts`）再交给模型。
 */
import { z } from "zod";
import {
  WEB_CRAWL_TOOL,
  WEB_FETCH_LIMITS,
  WEB_FETCH_TOOL,
  WEB_SEARCH_LIMITS,
  WEB_SEARCH_TOOL,
} from "../../../shared/web-tools";
import {
  assertResolvesPublic,
  OutboundRefusedError,
} from "../net/outbound-guard";
import type { GrantedTool } from "../plugins/tools";
import { type OutputSink, spill } from "../tool-output";
import { withUntrustedNotice } from "../untrusted-content";
import {
  type CrawlArchive,
  crawlRef,
  isCrawlRef,
  sharedCrawlArchive,
} from "./archive";
import {
  CRAWL_LIMITS,
  CRAWL_TIMEOUT_MS,
  crawlSite,
  PATTERN_LIMITS,
} from "./crawl";
import { type CrawlService, CrawlServiceError } from "./crawl4ai";
import { extractReadable } from "./extract";
import {
  checkFetchUrl,
  decodeBody,
  type FetchedPage,
  fetchPublicPage,
  pageKind,
  type WebFetchPolicy,
  WebFetchRefusedError,
} from "./fetch-page";
import type { HostPacer } from "./robots";
import type { SearchProvider } from "./search";

type ToolExecution = Parameters<GrantedTool["execute"]>[1];

/** 关掉它们的写法，与别的工具一样。 */
export const WEB_SEARCH_REF = `bot/${WEB_SEARCH_TOOL}`;
export const WEB_FETCH_REF = `bot/${WEB_FETCH_TOOL}`;
export const WEB_CRAWL_REF = `bot/${WEB_CRAWL_TOOL}`;

/** web_crawl 每页交给模型的摘要长度。 */
export const CRAWL_SUMMARY_CHARS = 600;

export type WebToolOptions = {
  /** `resolveSearchProvider()` 的结果：有提供方，或者一句为什么没有。 */
  search: { provider?: SearchProvider; problem?: string };
  /** `resolveCrawlService()` 的结果。 */
  crawl?: { service?: CrawlService; problem?: string };
  fetchPolicy?: WebFetchPolicy;
  pacer?: HostPacer;
  archive?: CrawlArchive;
  /** 存档按谁隔开：同一个人的同一位员工才读得到。 */
  scope: string;
  crawlTimeoutMs?: number;
  crawlMaxBytes?: number;
  /**
   * 期七：把超长的网页正文存进这位员工的工作区，回传里只给头尾和路径（`tool-output.ts`）。没给，或者员工没有电脑
   * （回答空），就截断到阈值并说明已截断。
   */
  saveOutput?: OutputSink;
};

const searchParameters = z.object({
  query: z.string().describe("要搜的关键词，只放问题需要的几个词"),
  max_results: z
    .number()
    .int()
    .optional()
    .describe(
      `要几条结果，默认 ${WEB_SEARCH_LIMITS.default}，最多 ${WEB_SEARCH_LIMITS.most}`,
    ),
  language: z
    .string()
    .optional()
    .describe("搜索语言，默认 zh-CN；查英文资料用 en"),
});

const fetchParameters = z.object({
  url: z
    .string()
    .describe(
      "要读的网页地址（http 或 https），或者 web_crawl 返回的 ref（crawl://…）",
    ),
  max_chars: z
    .number()
    .int()
    .optional()
    .describe(
      `最多返回多少字正文，默认 ${WEB_FETCH_LIMITS.default}，最多 ${WEB_FETCH_LIMITS.most}`,
    ),
  render_js: z
    .boolean()
    .optional()
    .describe(
      "页面内容靠脚本加载、普通读取读不到时设为 true，用浏览器渲染后再读",
    ),
});

const crawlParameters = z.object({
  url: z.string().describe("从哪个网址开始爬（http 或 https）"),
  max_pages: z
    .number()
    .int()
    .optional()
    .describe(
      `最多爬几页，默认 ${CRAWL_LIMITS.pages.default}，最多 ${CRAWL_LIMITS.pages.most}`,
    ),
  max_depth: z
    .number()
    .int()
    .optional()
    .describe(
      `从起始页往下跟几层链接，默认 ${CRAWL_LIMITS.depth.default}，最多 ${CRAWL_LIMITS.depth.most}`,
    ),
  same_domain: z
    .boolean()
    .optional()
    .describe("只爬同一个网站的页面，默认 true"),
  include: z
    .array(z.string())
    .optional()
    .describe('只爬路径对得上的页面，例如 ["/docs/*"]；* 表示任意字符'),
  exclude: z
    .array(z.string())
    .optional()
    .describe('不爬路径对得上的页面，例如 ["*/login*", "*.pdf"]'),
});

/** 一次调用的参数：存下的调用可能是 JSON 字符串。 */
function argumentsOf(args: unknown): Record<string, unknown> | null {
  let value = args;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 整数参数，夹在上下限之间；没给或给错了用默认值。 */
function bounded(
  value: unknown,
  fallback: number,
  least: number,
  most: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(most, Math.max(least, Math.floor(value)));
}

function patterns(value: unknown): string[] | string {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return "include 和 exclude 要是路径模式的列表。";
  const list = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  if (list.length > PATTERN_LIMITS.count)
    return `include 和 exclude 各最多 ${PATTERN_LIMITS.count} 条。`;
  for (const item of list) {
    if (item.length > PATTERN_LIMITS.length)
      return `路径模式最长 ${PATTERN_LIMITS.length} 个字符。`;
    if (!item.startsWith("/") && !item.startsWith("*"))
      return `路径模式要以 / 或 * 开头，例如 /docs/* 或 *.pdf，「${item}」不行。`;
  }
  return list;
}

/** 运行被停下就往外抛，别的错误交给调用方说成中文。 */
function rethrowIfStopped(execution: ToolExecution | undefined) {
  if (execution?.signal?.aborted) throw execution.signal.reason;
}

function cut(text: string, max: number): { text: string; truncated: boolean } {
  return text.length > max
    ? { text: text.slice(0, max), truncated: true }
    : { text, truncated: false };
}

export function webTools(options: WebToolOptions): GrantedTool[] {
  const archive = options.archive ?? sharedCrawlArchive;
  const policy = options.fetchPolicy ?? {};

  const webSearch: GrantedTool = {
    name: WEB_SEARCH_TOOL,
    ref: WEB_SEARCH_REF,
    concurrent: true,
    description:
      "搜索公开网页，返回标题、网址和摘要。需要事实、最新信息或出处时先用它搜，再用 web_fetch 读最相关的一到三个结果核对原文；回答里附上来源链接。只放问题需要的几个关键词，不要放对话全文或私人信息。",
    parameters: searchParameters,
    async execute(args, execution) {
      const input = argumentsOf(args);
      const query = typeof input?.query === "string" ? input.query.trim() : "";
      if (!query) return "搜索没有进行：query 不能为空，请给出要搜的关键词。";
      if (query.length > 500)
        return "搜索没有进行：关键词太长了（最多 500 字），只放问题需要的几个词。";
      const provider = options.search.provider;
      if (!provider)
        return `搜索没有进行：${options.search.problem ?? "本部署没有配置搜索服务。"}`;
      const maxResults = bounded(
        input?.max_results,
        WEB_SEARCH_LIMITS.default,
        1,
        WEB_SEARCH_LIMITS.most,
      );
      const language =
        typeof input?.language === "string" &&
        /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$|^all$|^auto$/.test(
          input.language.trim(),
        )
          ? input.language.trim()
          : "zh-CN";
      try {
        const results = await provider.search({
          query,
          maxResults,
          language,
          ...(execution?.signal ? { signal: execution.signal } : {}),
        });
        if (results.length === 0)
          return `没有搜到「${query}」的结果（来源：${provider.source}）。可以换几个关键词，或者换一种语言再搜。`;
        return JSON.stringify(
          withUntrustedNotice(
            {
              source: provider.source,
              query,
              results: results.slice(0, maxResults),
              note: "这些是搜索引擎给的标题和摘要。要引用或核实，先用 web_fetch 读原文；回答里附上你读过的来源链接。",
            },
            "web search result",
            ["results"],
          ),
        );
      } catch (error) {
        rethrowIfStopped(execution);
        return `搜索没有完成：${error instanceof Error && /[一-鿿]/.test(error.message) ? error.message : "搜索服务出错了。"}可以稍后再试，或者换一种办法。`;
      }
    },
  };

  const webFetch: GrantedTool = {
    name: WEB_FETCH_TOOL,
    ref: WEB_FETCH_REF,
    concurrent: true,
    description:
      "读取一个公开网页的正文，转成 Markdown（标题、链接、列表、表格保留）。只能读 http 或 https 的公开网址，内网地址会被拒绝。页面靠脚本加载时设 render_js 为 true。web_crawl 返回的 ref（crawl://…）也可以交给它读全文。",
    parameters: fetchParameters,
    async execute(args, execution) {
      const input = argumentsOf(args);
      const url = typeof input?.url === "string" ? input.url.trim() : "";
      if (!url) return "没有读网页：url 不能为空。";
      const maxChars = bounded(
        input?.max_chars,
        WEB_FETCH_LIMITS.default,
        200,
        WEB_FETCH_LIMITS.most,
      );
      if (isCrawlRef(url)) {
        const page = archive.get(options.scope, url);
        if (!page)
          return `没有读到 ${url}：这份爬取结果已经过期，或者不在这台服务器上。请用 web_fetch 直接读原网址，或者重新爬取。`;
        const body = await shapeBody(
          page.markdown,
          maxChars,
          execution?.toolCallId ?? crypto.randomUUID(),
          options.saveOutput,
        );
        return JSON.stringify(
          withUntrustedNotice(
            {
              source: "web_crawl 存下的全文",
              ref: url,
              url: page.url,
              title: page.title,
              content: body.content,
              ...(body.truncated ? { truncated: body.truncated } : {}),
              ...(body.savedTo ? { saved_to: body.savedTo } : {}),
            },
            "web page",
            ["title", "content"],
          ),
        );
      }

      const notes: string[] = [];
      try {
        let fetched:
          | FetchedPage
          | { url: string; html: string; status?: number };
        if (input?.render_js === true && options.crawl?.service) {
          try {
            fetched = await renderWithService(
              url,
              options.crawl.service,
              policy,
              execution?.signal,
            );
          } catch (error) {
            if (error instanceof WebFetchRefusedError) throw error;
            rethrowIfStopped(execution);
            notes.push(
              `${error instanceof CrawlServiceError ? error.message : "渲染服务出错了。"}这次按普通方式读取，靠脚本加载的内容可能缺失。`,
            );
            fetched = await fetchPublicPage(url, policy, execution?.signal);
          }
        } else {
          if (input?.render_js === true)
            notes.push(
              `${options.crawl?.problem ?? "本部署没有配置网页渲染服务（Crawl4AI）。"}这次按普通方式读取，靠脚本加载的内容可能缺失。`,
            );
          fetched = await fetchPublicPage(url, policy, execution?.signal);
        }
        return await describePage(
          fetched,
          maxChars,
          notes,
          execution?.toolCallId ?? crypto.randomUUID(),
          options.saveOutput,
        );
      } catch (error) {
        rethrowIfStopped(execution);
        if (error instanceof WebFetchRefusedError)
          return `没有读这个网页：${error.message}`;
        if (
          error instanceof Error &&
          (error.name === "TimeoutError" || error.name === "AbortError")
        )
          return "没有读到这个网页：网站在 20 秒内没有响应完。可以稍后再试，或者换一个来源。";
        return "没有读到这个网页：连不上这个网站。可以检查网址，或者换一个来源。";
      }
    },
  };

  const webCrawl: GrantedTool = {
    name: WEB_CRAWL_TOOL,
    ref: WEB_CRAWL_REF,
    description:
      "从一个网址开始爬同一网站的多页（整站、文档目录、多篇文章），返回每页的网址、标题和开头摘要；全文存下来，用 web_fetch 读返回的 ref 就能看全文。只读一页用 web_fetch。遵守网站的 robots.txt，同一网站每秒最多一个请求。",
    parameters: crawlParameters,
    async execute(args, execution) {
      const input = argumentsOf(args);
      const url = typeof input?.url === "string" ? input.url.trim() : "";
      if (!url) return "没有爬取：url 不能为空。";
      const include = patterns(input?.include);
      if (typeof include === "string") return `没有爬取：${include}`;
      const exclude = patterns(input?.exclude);
      if (typeof exclude === "string") return `没有爬取：${exclude}`;
      const request = {
        url,
        maxPages: bounded(
          input?.max_pages,
          CRAWL_LIMITS.pages.default,
          1,
          CRAWL_LIMITS.pages.most,
        ),
        maxDepth: bounded(
          input?.max_depth,
          CRAWL_LIMITS.depth.default,
          0,
          CRAWL_LIMITS.depth.most,
        ),
        sameDomain: input?.same_domain !== false,
        include,
        exclude,
      };
      try {
        const outcome = await crawlSite(request, {
          ...(options.crawl?.service ? { service: options.crawl.service } : {}),
          policy,
          ...(options.pacer ? { pacer: options.pacer } : {}),
          timeoutMs: options.crawlTimeoutMs ?? CRAWL_TIMEOUT_MS,
          ...(options.crawlMaxBytes ? { maxBytes: options.crawlMaxBytes } : {}),
          ...(execution?.signal ? { signal: execution.signal } : {}),
        });
        if (outcome.pages.length === 0)
          return [
            "没有爬到任何页面。",
            ...outcome.notes,
            outcome.skipped.robots > 0
              ? `网站的 robots.txt 不许爬（${outcome.skipped.robots} 页）。`
              : "",
            outcome.skipped.refused > 0
              ? `${outcome.skipped.refused} 个地址指向内网或不能读，被拒绝了。`
              : "",
          ]
            .filter(Boolean)
            .join("");
        const id = archive.put(options.scope, outcome.pages);
        const stopped =
          outcome.stoppedBy === "max_pages"
            ? `已到 ${request.maxPages} 页的上限，后面的页面没有爬。`
            : outcome.stoppedBy === "time"
              ? `已到 ${Math.round((options.crawlTimeoutMs ?? CRAWL_TIMEOUT_MS) / 1000)} 秒的总时长上限，后面的页面没有爬。`
              : outcome.stoppedBy === "bytes"
                ? "已到这次爬取的总下载量上限，后面的页面没有爬。"
                : undefined;
        return JSON.stringify(
          withUntrustedNotice(
            {
              source:
                outcome.via === "crawl4ai"
                  ? (options.crawl?.service?.source ?? "Crawl4AI")
                  : "进程内的简易爬取（只抓静态 HTML）",
              start_url: url,
              crawl_id: id,
              pages: outcome.pages.map((page, index) => ({
                ref: crawlRef(id, index),
                url: page.url,
                title: page.title,
                summary: cut(
                  page.markdown.replace(/\s+/g, " ").trim(),
                  CRAWL_SUMMARY_CHARS,
                ).text,
                chars: page.markdown.length,
              })),
              skipped: outcome.skipped,
              ...(stopped ? { stopped } : {}),
              ...(outcome.notes.length > 0 ? { notes: outcome.notes } : {}),
              note: `每页只给了开头的摘要。全文已存下，两小时内有效：把 ref 交给 web_fetch（url 参数填 ref）读全文。回答里附上你引用的页面网址。`,
            },
            "crawled web page",
            ["pages"],
          ),
        );
      } catch (error) {
        rethrowIfStopped(execution);
        if (error instanceof WebFetchRefusedError)
          return `没有爬取这个网站：${error.message}`;
        return "没有爬完这个网站：爬取出错了。可以稍后再试，或者用 web_fetch 读单页。";
      }
    },
  };

  return [webSearch, webFetch, webCrawl];
}

/** 交给 Crawl4AI 渲染之前和之后都校验地址：只交公网地址，它跟到内网的结果不要。 */
async function renderWithService(
  url: string,
  service: CrawlService,
  policy: WebFetchPolicy,
  signal: AbortSignal | undefined,
): Promise<{ url: string; html: string; status?: number }> {
  const verdict = checkFetchUrl(url);
  if (!verdict.allowed) throw new WebFetchRefusedError(verdict.reason);
  try {
    await assertResolvesPublic(verdict.url.href, {
      ...(policy.lookup ? { lookup: policy.lookup } : {}),
      ...(policy.viaProxy ? { viaProxy: policy.viaProxy } : {}),
    });
  } catch (error) {
    if (error instanceof OutboundRefusedError)
      throw new WebFetchRefusedError(
        error.kind === "unresolved"
          ? `找不到 ${verdict.url.hostname} 这个网站（域名解析失败）。`
          : "这个网址指向本部署的内部网络，不会去读。只能读公开网页。",
      );
    throw error;
  }
  const rendered = await service.render(verdict.url.href, signal);
  const landed = checkFetchUrl(rendered.url);
  if (!landed.allowed)
    throw new WebFetchRefusedError(
      `网页重定向到了不能读的地址：${landed.reason}`,
    );
  return rendered;
}

/** 没有电脑时的存盘：什么也不存，交给截断。 */
const noOutputSink: OutputSink = async () => undefined;

/**
 * 正文交给模型的样子：不超过阈值（`tool-output.ts`）就按 `max_chars` 截；超过就存进工作区，回传头尾和路径，
 * 存不了（这位员工没有电脑、写不进去）就截断到阈值并说明。存的是全文，不是按 `max_chars` 截过的那份。
 */
async function shapeBody(
  markdown: string,
  maxChars: number,
  callId: string,
  save: OutputSink | undefined,
): Promise<{ content: string; truncated?: string; savedTo?: string }> {
  const { text, truncated } = cut(markdown, maxChars);
  /*
   * 存不了盘（部署里没有电脑，或这位员工用不了电脑）时一律走下面的截断：超过 16KB 就截到 16KB 并说明
   * （用户 2026-11-19 同意没有电脑的部署也降到 16KB）。
   */
  const spilled = await spill({
    tool: WEB_FETCH_TOOL,
    id: callId,
    full: markdown,
    measured: text,
    keep: "head",
    sink: save ?? noOutputSink,
  });
  if (!spilled)
    return {
      content: text,
      ...(truncated
        ? { truncated: `正文超过 ${maxChars} 字，只返回了前 ${maxChars} 字。` }
        : {}),
    };
  return {
    // 存了盘：头尾取自全文；没存成：取按 max_chars 截过的前面一段。
    content: spilled.show(spilled.savedTo ? markdown : text),
    truncated: spilled.note,
    ...(spilled.savedTo ? { savedTo: spilled.savedTo } : {}),
  };
}

/** 读到的东西交给模型：HTML 转 Markdown，文本照给，二进制只说明。 */
async function describePage(
  page: FetchedPage | { url: string; html: string; status?: number },
  maxChars: number,
  notes: string[],
  callId: string,
  save: OutputSink | undefined,
): Promise<string> {
  const rendered = "html" in page;
  const status = page.status ?? 200;
  if (status >= 400)
    return `没有读到这个网页：网站返回了 HTTP ${status}。${notes.join("")}`;
  let kind: "html" | "text" | "binary";
  let text = "";
  let contentType = "text/html";
  let bodyTruncated = false;
  if (rendered) {
    kind = "html";
    text = page.html;
  } else {
    contentType = page.contentType;
    kind = pageKind(page.contentType, page.body);
    bodyTruncated = page.truncated;
    if (kind === "binary") {
      const size =
        page.declaredLength !== undefined
          ? `，约 ${formatBytes(page.declaredLength)}`
          : "";
      return `这个网址是一个二进制文件（${page.contentType || "未知类型"}${size}），web_fetch 不返回二进制内容。${notes.join("")}`;
    }
    text = decodeBody(page.body, page.contentType, kind === "html");
  }
  const { title, markdown } =
    kind === "html"
      ? extractReadable(text, page.url)
      : { title: "", markdown: text };
  const body = await shapeBody(markdown, maxChars, callId, save);
  const truncation = [
    ...(body.truncated ? [body.truncated] : []),
    ...(bodyTruncated ? ["网页太大，只读了开头的一部分。"] : []),
  ];
  return JSON.stringify(
    withUntrustedNotice(
      {
        url: page.url,
        title,
        content_type: contentType,
        content: body.content,
        ...(truncation.length > 0 ? { truncated: truncation.join("") } : {}),
        ...(body.savedTo ? { saved_to: body.savedTo } : {}),
        ...(rendered ? { rendered: "经爬虫服务渲染后读取" } : {}),
        ...(notes.length > 0 ? { notes } : {}),
      },
      "web page",
      ["title", "content"],
    ),
  );
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} 字节`;
}
