/**
 * web_crawl 爬下来的全文，先存在这里，只把引用和摘要交给模型，免得几十页正文一下撑满上下文。
 *
 * 引用形如 `crawl://<编号>/<第几页>`，交给 web_fetch 就能读回那一页的全文。按「人 + 员工」隔开：别人的员工
 * 拿着同一个引用也读不到。存在本进程内存里，两小时后过期，总量有上限，满了先丢最早的；服务器重启或换了副本
 * 就读不到了，web_fetch 会照实说，并给出原网址让它重读。
 */
import { randomBytes } from "node:crypto";

export type ArchivedPage = { url: string; title: string; markdown: string };

export const CRAWL_REF_PREFIX = "crawl://";

export type CrawlArchive = {
  /** 存下一次爬取，返回编号。 */
  put(scope: string, pages: readonly ArchivedPage[]): string;
  /** 读回一页；过期、不存在或不是这个人的都返回空。 */
  get(scope: string, ref: string): ArchivedPage | undefined;
};

export function crawlRef(id: string, index: number): string {
  return `${CRAWL_REF_PREFIX}${id}/${index + 1}`;
}

export function isCrawlRef(value: string): boolean {
  return value.trim().toLowerCase().startsWith(CRAWL_REF_PREFIX);
}

export function createCrawlArchive(
  options: { ttlMs?: number; maxChars?: number; now?: () => number } = {},
): CrawlArchive {
  const ttl = options.ttlMs ?? 2 * 60 * 60 * 1000;
  const maxChars = options.maxChars ?? 32 * 1024 * 1024;
  const now = options.now ?? Date.now;
  const entries = new Map<
    string,
    { scope: string; pages: ArchivedPage[]; at: number; size: number }
  >();
  let total = 0;

  const drop = (id: string) => {
    const entry = entries.get(id);
    if (!entry) return;
    total -= entry.size;
    entries.delete(id);
  };
  const sweep = () => {
    for (const [id, entry] of entries) if (entry.at + ttl < now()) drop(id);
    // Oldest first: a Map iterates in insertion order.
    for (const id of entries.keys()) {
      if (total <= maxChars) break;
      drop(id);
    }
  };

  return {
    put(scope, pages) {
      const id = randomBytes(6).toString("hex");
      const kept = pages.map((page) => ({ ...page }));
      const size = kept.reduce((sum, page) => sum + page.markdown.length, 0);
      entries.set(id, { scope, pages: kept, at: now(), size });
      total += size;
      sweep();
      return id;
    },
    get(scope, ref) {
      sweep();
      const match = /^crawl:\/\/([0-9a-f]+)\/(\d+)$/i.exec(ref.trim());
      if (!match) return undefined;
      const entry = entries.get((match[1] ?? "").toLowerCase());
      if (!entry || entry.scope !== scope) return undefined;
      return entry.pages[Number(match[2]) - 1];
    },
  };
}

/** 进程里共用的一份。 */
export const sharedCrawlArchive: CrawlArchive = createCrawlArchive();
