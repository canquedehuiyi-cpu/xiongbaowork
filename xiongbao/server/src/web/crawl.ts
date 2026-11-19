/**
 * 爬一个网站的多页：有 Crawl4AI 就交给它深度爬取，没有（或它出错）就在进程里做一个简易的广度优先爬取，
 * 只抓静态 HTML。两条路受同样的上限：页数、深度、总时长、总字节。
 *
 * 规矩（两条路都守）：
 *  - robots.txt 默认遵守。进程内由 `robots.ts` 读；Crawl4AI 由它的 `check_robots_txt` 读。
 *  - 同一个网站每秒最多一个请求（进程内 `sharedHostPacer`，Crawl4AI 由 `mean_delay` 和它自己的按域名限速）。
 *  - User-Agent 固定为 {@link CRAWLER_USER_AGENT}，不带任何用户信息。
 *  - 每一跳都过 SSRF 出站校验：起始地址交出去之前、发现的每个链接入队之前（静态判定），以及真正请求的
 *    每一跳（`fetchPublicPage`，含 DNS 和重定向）。Crawl4AI 交回来的页面也逐个按地址再判一遍。
 */
import { parseHTML } from "linkedom";
import {
  assertResolvesPublic,
  OutboundRefusedError,
  untilAborted,
} from "../net/outbound-guard";
import type { CrawlService } from "./crawl4ai";
import { extractReadable } from "./extract";
import {
  checkFetchUrl,
  decodeBody,
  fetchPublicPage,
  pageKind,
  type WebFetchPolicy,
  WebFetchRefusedError,
} from "./fetch-page";
import { createRobotsReader, type HostPacer, sharedHostPacer } from "./robots";

/** web_crawl 的页数和深度：默认与上限。 */
export const CRAWL_LIMITS = {
  pages: { default: 10, most: 50 },
  depth: { default: 2, most: 3 },
} as const;
/** 一次爬取的总时长。 */
export const CRAWL_TIMEOUT_MS = 120_000;
/** 一次爬取最多下载多少字节（进程内爬取按实际读到的算）。 */
export const CRAWL_MAX_BYTES = 20 * 1024 * 1024;
/** 进程内爬取单页最多读多少字节。 */
const PAGE_MAX_BYTES = 2 * 1024 * 1024;
/** include / exclude 最多几条、每条多长。 */
export const PATTERN_LIMITS = { count: 20, length: 200 } as const;

export type CrawlRequest = {
  url: string;
  maxPages: number;
  maxDepth: number;
  sameDomain: boolean;
  include: readonly string[];
  exclude: readonly string[];
};

export type CrawledPage = { url: string; title: string; markdown: string };

export type CrawlOutcome = {
  pages: CrawledPage[];
  via: "crawl4ai" | "builtin";
  /** 没爬的：robots.txt 不许、指向内网被拒、请求失败。 */
  skipped: { robots: number; refused: number; failed: number };
  /** 因为什么停下：页数到了、时间到了、字节到了；自然爬完为空。 */
  stoppedBy?: "max_pages" | "time" | "bytes";
  /** 给模型看的说明，例如 Crawl4AI 出错、退回了进程内爬取。 */
  notes: string[];
};

export type CrawlDependencies = {
  service?: CrawlService;
  policy?: WebFetchPolicy;
  pacer?: HostPacer;
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
};

/** `/docs/*`、`*.pdf` 这样的路径模式（以 / 或 * 开头）；`*` 是任意字符，整条路径（含查询）要对上。 */
export function pathMatches(pattern: string, url: URL): boolean {
  const target = `${url.pathname}${url.search}`;
  const regex = new RegExp(
    `^${pattern
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
  );
  return regex.test(target);
}

const sameSite = (a: string, b: string) =>
  a.replace(/^www\./, "") === b.replace(/^www\./, "");

function wanted(
  url: URL,
  start: URL,
  request: CrawlRequest,
  isStart: boolean,
): boolean {
  if (request.sameDomain && !sameSite(url.hostname, start.hostname))
    return false;
  if (isStart) return true;
  if (
    request.include.length > 0 &&
    !request.include.some((pattern) => pathMatches(pattern, url))
  )
    return false;
  return !request.exclude.some((pattern) => pathMatches(pattern, url));
}

function withoutHash(url: URL): string {
  const copy = new URL(url.href);
  copy.hash = "";
  return copy.href;
}

/** 一页 HTML 里的链接，补成完整地址。 */
export function pageLinks(html: string, base: string): URL[] {
  const { document } = parseHTML(
    /<html[\s>]/i.test(html) ? html : `<html><body>${html}</body></html>`,
  ) as unknown as { document: Document };
  const links: URL[] = [];
  for (const anchor of Array.from(document.querySelectorAll("a[href]"))) {
    try {
      const url = new URL(anchor.getAttribute("href") ?? "", base);
      if (url.protocol === "http:" || url.protocol === "https:")
        links.push(url);
    } catch {}
  }
  return links;
}

/**
 * 爬。起始地址被 SSRF 校验拒掉时抛 {@link WebFetchRefusedError}；其他问题都记在结果里。
 */
export async function crawlSite(
  request: CrawlRequest,
  deps: CrawlDependencies = {},
): Promise<CrawlOutcome> {
  const policy = deps.policy ?? {};
  const timeoutMs = deps.timeoutMs ?? CRAWL_TIMEOUT_MS;
  const signal = AbortSignal.any(
    [AbortSignal.timeout(timeoutMs), deps.signal].filter(
      (value): value is AbortSignal => value !== undefined,
    ),
  );

  // The start address is checked here, before anything is handed to anybody, Crawl4AI included.
  const verdict = checkFetchUrl(request.url);
  if (!verdict.allowed) throw new WebFetchRefusedError(verdict.reason);
  const start = verdict.url;
  try {
    await untilAborted(
      assertResolvesPublic(start.href, {
        ...(policy.lookup ? { lookup: policy.lookup } : {}),
        ...(policy.viaProxy ? { viaProxy: policy.viaProxy } : {}),
      }),
      signal,
    );
  } catch (error) {
    if (error instanceof OutboundRefusedError)
      throw new WebFetchRefusedError(
        error.kind === "unresolved"
          ? `找不到 ${start.hostname} 这个网站（域名解析失败）。`
          : "这个网址指向本部署的内部网络，不会去爬。只能爬公开网站。",
      );
    throw error;
  }

  const notes: string[] = [];
  if (deps.service) {
    try {
      const pages = await deps.service.deepCrawl(
        {
          url: start.href,
          maxPages: request.maxPages,
          maxDepth: request.maxDepth,
          sameDomain: request.sameDomain,
          include: request.include,
          exclude: request.exclude,
          timeoutMs,
        },
        signal,
      );
      let refused = 0;
      const seen = new Set<string>();
      const kept: CrawledPage[] = [];
      for (const page of pages) {
        const checked = checkFetchUrl(page.url);
        if (!checked.allowed) {
          refused += 1;
          continue;
        }
        const key = withoutHash(checked.url);
        if (seen.has(key)) continue;
        if (!wanted(checked.url, start, request, key === withoutHash(start)))
          continue;
        seen.add(key);
        const markdown =
          page.markdown.trim() ||
          (page.html ? extractReadable(page.html, page.url).markdown : "");
        const title =
          page.title ||
          (page.html ? extractReadable(page.html, page.url).title : "");
        kept.push({ url: page.url, title, markdown });
      }
      const truncated = kept.length > request.maxPages;
      return {
        pages: kept.slice(0, request.maxPages),
        via: "crawl4ai",
        skipped: { robots: 0, refused, failed: 0 },
        ...(truncated ? { stoppedBy: "max_pages" as const } : {}),
        notes,
      };
    } catch (error) {
      if (signal.aborted) throw error;
      notes.push(
        `${error instanceof Error ? error.message : "爬虫服务出错了。"}已退回进程内的简易爬取（只抓静态 HTML）。`,
      );
    }
  }
  return {
    ...(await crawlInProcess(request, start, { ...deps, policy }, signal)),
    notes,
  };
}

async function crawlInProcess(
  request: CrawlRequest,
  start: URL,
  deps: CrawlDependencies & { policy: WebFetchPolicy },
  signal: AbortSignal,
): Promise<Omit<CrawlOutcome, "notes">> {
  const pacer = deps.pacer ?? sharedHostPacer;
  const maxBytes = deps.maxBytes ?? CRAWL_MAX_BYTES;
  const robots = createRobotsReader(deps.policy, (url) =>
    pacer.wait(url.hostname, 0, signal),
  );
  const skipped = { robots: 0, refused: 0, failed: 0 };
  const pages: CrawledPage[] = [];
  const queue: { url: URL; depth: number }[] = [{ url: start, depth: 0 }];
  const seen = new Set<string>([withoutHash(start)]);
  let bytes = 0;
  let stoppedBy: CrawlOutcome["stoppedBy"];

  while (queue.length > 0) {
    if (pages.length >= request.maxPages) {
      stoppedBy = "max_pages";
      break;
    }
    if (signal.aborted) {
      stoppedBy = "time";
      break;
    }
    if (bytes >= maxBytes) {
      stoppedBy = "bytes";
      break;
    }
    const { url, depth } = queue.shift() as { url: URL; depth: number };
    try {
      const rules = await robots(url, signal);
      if (!rules.allows(`${url.pathname}${url.search}`)) {
        skipped.robots += 1;
        continue;
      }
      await pacer.wait(url.hostname, rules.crawlDelayMs ?? 0, signal);
      const page = await fetchPublicPage(
        url.href,
        {
          ...deps.policy,
          maxBytes: Math.max(1, Math.min(PAGE_MAX_BYTES, maxBytes - bytes)),
        },
        signal,
      );
      bytes += page.body.byteLength;
      if (page.status >= 400) {
        skipped.failed += 1;
        continue;
      }
      const kind = pageKind(page.contentType, page.body);
      if (kind === "binary") continue;
      const text = decodeBody(page.body, page.contentType, kind === "html");
      if (kind === "text") {
        pages.push({ url: page.url, title: "", markdown: text });
        continue;
      }
      const { title, markdown } = extractReadable(text, page.url);
      pages.push({ url: page.url, title, markdown });
      if (depth >= request.maxDepth) continue;
      for (const link of pageLinks(text, page.url)) {
        const key = withoutHash(link);
        if (seen.has(key)) continue;
        seen.add(key);
        // A link that points inside the deployment is refused before it is ever queued.
        if (!checkFetchUrl(link.href).allowed) {
          skipped.refused += 1;
          continue;
        }
        if (!wanted(link, start, request, false)) continue;
        queue.push({ url: new URL(key), depth: depth + 1 });
      }
    } catch (error) {
      if (signal.aborted) {
        stoppedBy = "time";
        break;
      }
      if (error instanceof WebFetchRefusedError) skipped.refused += 1;
      else skipped.failed += 1;
    }
  }
  return {
    pages,
    via: "builtin",
    skipped,
    ...(stoppedBy ? { stoppedBy } : {}),
  };
}
