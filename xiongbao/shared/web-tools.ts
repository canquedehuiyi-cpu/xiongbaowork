/**
 * 员工自带的联网工具：`web_search` 搜公开网页，`web_fetch` 读一个网页的正文，`web_crawl` 爬一个网站的多页。
 *
 * 服务器执行它们（`server/src/web/`），对话按这些名字给步骤起中文名（`tool-name.ts`）。名字都不带
 * `mcp__` 前缀，所以和插件里同名的搜索工具（`mcp__parallel__web_search`）不会混在一起。
 */

/** 搜索公开网页。 */
export const WEB_SEARCH_TOOL = "web_search";

/** 读取一个网页的正文。 */
export const WEB_FETCH_TOOL = "web_fetch";

/** 爬一个网站的多页。 */
export const WEB_CRAWL_TOOL = "web_crawl";

/** 搜索结果条数：默认与上限。 */
export const WEB_SEARCH_LIMITS = { default: 8, most: 20 } as const;

/** 读网页返回的正文字数：默认与上限。 */
export const WEB_FETCH_LIMITS = { default: 20_000, most: 100_000 } as const;

/**
 * 读网页返回的正文里，最多直接放进对话的字节数（UTF-8）。超过的存进员工的工作区，对话里只留头尾、路径和读法；
 * 没有电脑可存时截到这么多并说明。比命令输出的 16KB 小一半：网页常是一次性读完就用不上的背景，不该每一步都再发一遍。
 */
export const WEB_FETCH_INLINE_BYTES = 8 * 1024;
