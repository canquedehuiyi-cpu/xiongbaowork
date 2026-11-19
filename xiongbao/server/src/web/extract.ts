/**
 * 一页 HTML 变成模型读得懂的 Markdown：正文用 Readability 抽出来，再用 turndown 转成 Markdown。
 *
 * - `@mozilla/readability`（Apache-2.0）：Firefox 阅读模式的正文抽取，去掉导航、页脚、广告这类边角。
 * - `turndown`（MIT）：HTML 转 Markdown，标题、链接、列表、代码块照原样保留；表格它本身不转，这里加了一条
 *   规则把表格写成 Markdown 表格。
 * - `linkedom`（ISC）：给 Readability 一个服务器上的 DOM。它只解析，不跑脚本、不发请求。
 *
 * Readability 判断不出正文的页面（目录页、搜索结果页、整页就是一张表），或者抽出来的正文只剩全页一小部分，
 * 就退回整页转换：`script`、`style` 这些照样去掉，但不再挑正文。
 *
 * 链接在交给 Readability 之前就补成完整地址；`javascript:` 这类只留文字。
 */
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";

export type PageText = { title: string; markdown: string };

/** 解析的元素上限：再大的页面 Readability 会拒绝，退回整页转换。 */
const MAX_ELEMENTS = 60_000;

/** 不论哪条路都不要的标签。 */
const DROPPED = [
  "script",
  "style",
  "noscript",
  "template",
  "iframe",
  "svg",
  "canvas",
  "object",
  "embed",
  "select",
  "button",
  "form",
  "link",
  "meta",
] as const;
const DROPPED_NAMES: ReadonlySet<string> = new Set(DROPPED);
const dropped = (node: { nodeName: string }) =>
  DROPPED_NAMES.has(node.nodeName.toLowerCase());

type DomNode = {
  nodeName: string;
  childNodes: ArrayLike<DomNode>;
  innerHTML?: string;
};

/** 表格里的一行行：跨过 thead/tbody/tfoot，不进嵌套的表格。 */
function tableRows(table: DomNode): DomNode[] {
  const rows: DomNode[] = [];
  const walk = (node: DomNode) => {
    for (const child of Array.from(node.childNodes)) {
      const name = child.nodeName.toUpperCase();
      if (name === "TR") rows.push(child);
      else if (name === "THEAD" || name === "TBODY" || name === "TFOOT")
        walk(child);
    }
  };
  walk(table);
  return rows;
}

function turndownService(): TurndownService {
  const service = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "*",
    linkStyle: "inlined",
  });
  service.remove(dropped);
  // 图片只留说明文字：模型看不到图，地址也只是噪音。
  service.addRule("image", {
    filter: "img",
    replacement: (_content, node) => {
      const alt = (
        node as unknown as { getAttribute(name: string): string | null }
      )
        .getAttribute("alt")
        ?.replace(/\s+/g, " ")
        .trim();
      return alt ? `[图片：${alt}]` : "";
    },
  });
  const cells = new TurndownService({ linkStyle: "inlined" });
  cells.remove(dropped);
  service.addRule("table", {
    filter: "table",
    replacement: (_content, node) => {
      const rows = tableRows(node as unknown as DomNode)
        .map((row) =>
          Array.from(row.childNodes)
            .filter((cell) => /^(TD|TH)$/i.test(cell.nodeName))
            .map((cell) =>
              cells
                .turndown(cell.innerHTML ?? "")
                .replace(/\s+/g, " ")
                .trim()
                .replace(/\|/g, "\\|"),
            ),
        )
        .filter((row) => row.some((cell) => cell !== ""));
      if (rows.length === 0) return "";
      const width = Math.max(...rows.map((row) => row.length));
      const line = (row: string[]) =>
        `| ${[...row, ...Array<string>(width - row.length).fill("")].join(" | ")} |`;
      const [head, ...body] = rows as [string[], ...string[][]];
      return `\n\n${[line(head), line(Array<string>(width).fill("---")), ...body.map(line)].join("\n")}\n\n`;
    },
  });
  return service;
}

/** 链接补成完整的 http(s) 地址；别的协议和写坏的地址去掉 href，只留文字。 */
function absoluteLinks(document: Document, baseUrl: string | undefined) {
  const declared = document.querySelector("base[href]")?.getAttribute("href");
  let base = baseUrl;
  try {
    if (declared) base = new URL(declared, baseUrl).href;
  } catch {}
  for (const anchor of Array.from(document.querySelectorAll("a[href]"))) {
    const href = anchor.getAttribute("href")?.trim() ?? "";
    let resolved: URL | undefined;
    try {
      resolved = base ? new URL(href, base) : new URL(href);
    } catch {}
    if (
      href.startsWith("#") ||
      !resolved ||
      (resolved.protocol !== "http:" && resolved.protocol !== "https:")
    )
      anchor.removeAttribute("href");
    else anchor.setAttribute("href", resolved.href);
  }
}

function textLength(text: string | null | undefined): number {
  return (text ?? "").replace(/\s+/g, "").length;
}

/** 解析一页 HTML，链接已经补全。 */
function parse(html: string, baseUrl: string | undefined): Document {
  // linkedom wants a whole document; a fragment is wrapped so it still has a body.
  const source = /<html[\s>]/i.test(html)
    ? html
    : `<!doctype html><html><head></head><body>${html}</body></html>`;
  const { document } = parseHTML(source) as unknown as { document: Document };
  absoluteLinks(document, baseUrl);
  return document;
}

/**
 * HTML 读成 `{ title, markdown }`。`baseUrl` 用来补全相对链接。
 */
export function extractReadable(html: string, baseUrl?: string): PageText {
  const service = turndownService();
  const page = parse(html, baseUrl);
  const pageTitle = (page.title ?? "").replace(/\s+/g, " ").trim();
  for (const name of DROPPED)
    for (const element of Array.from(page.querySelectorAll(name)))
      element.remove();
  const body = page.body ?? page.documentElement;
  const bodyText = textLength(body?.textContent);

  let article: ReturnType<Readability["parse"]> = null;
  try {
    // Readability changes the document it reads, so it gets its own copy.
    article = new Readability(parse(html, baseUrl), {
      maxElemsToParse: MAX_ELEMENTS,
    }).parse();
  } catch {
    article = null;
  }
  const articleText = textLength(article?.textContent);
  const useArticle =
    article?.content && articleText >= 200 && articleText >= bodyText * 0.25;
  const markdown = service
    .turndown(useArticle ? (article?.content ?? "") : (body?.innerHTML ?? ""))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const title =
    (useArticle ? article?.title?.replace(/\s+/g, " ").trim() : "") ||
    pageTitle;
  return { title, markdown };
}
