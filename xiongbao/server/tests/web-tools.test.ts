import { afterEach, describe, expect, test } from "bun:test";
import {
  WEB_CRAWL_TOOL,
  WEB_FETCH_TOOL,
  WEB_SEARCH_TOOL,
} from "../../shared/web-tools";
import { createCrawlArchive } from "../src/web/archive";
import { pathMatches } from "../src/web/crawl";
import {
  type CrawlService,
  crawl4aiService,
  resolveCrawlService,
} from "../src/web/crawl4ai";
import { extractReadable } from "../src/web/extract";
import { CRAWLER_USER_AGENT, checkFetchUrl } from "../src/web/fetch-page";
import {
  createHostPacer,
  type HostPacer,
  parseRobots,
} from "../src/web/robots";
import {
  resolveSearchProvider,
  type SearchProvider,
  searxngProvider,
} from "../src/web/search";
import { type WebToolOptions, webTools } from "../src/web/tools";

/*
 * 期五 B：员工自带的联网工具。web_search 默认走部署自带的 SearXNG（可换提供方），web_fetch 读一页（SSRF
 * 每一跳都校验），web_crawl 爬多页（有 Crawl4AI 交给它，没有就进程内简易爬取；robots.txt、限速、上限）。
 *
 * SearXNG 和 Crawl4AI 是本机起的假服务（运维配置的地址，本来就在内网）；公开网站是注入的 fetch 和 DNS，
 * 因为 web_fetch 不许碰 127.0.0.1，这正是要测的。
 */

const servers: { stop(force?: boolean): unknown }[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

function serve(handler: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

const results = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    url: `https://example.com/${index + 1}`,
    title: `结果 ${index + 1}`,
    content: `第 ${index + 1} 条的摘要`,
    engine: "bing",
  }));

/** 公开网站：地址到回答的表，注入成 fetch；所有名字都解析到一个公网地址。 */
function site(pages: Record<string, () => Response>) {
  const requested: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    requested.push(url);
    const page = pages[url];
    return page ? page() : new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return {
    requested,
    policy: {
      fetchImpl,
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      viaProxy: () => false,
    },
  };
}

const html =
  (body: string, headers: Record<string, string> = {}) =>
  () =>
    new Response(body, {
      headers: { "content-type": "text/html; charset=utf-8", ...headers },
    });

const noPacer: HostPacer = { wait: async () => undefined };

function tools(options: Partial<WebToolOptions> = {}) {
  const [search, fetch, crawl] = webTools({
    search: options.search ?? { problem: "没有配置。" },
    scope: options.scope ?? "owner:bot",
    pacer: noPacer,
    ...options,
  });
  if (!search || !fetch || !crawl) throw new Error("Expected three tools.");
  return { search, fetch, crawl };
}

const parsed = (text: string) => JSON.parse(text) as Record<string, unknown>;

describe("web_search", () => {
  test("is named and switched off like every other tool", () => {
    const { search, fetch, crawl } = tools();
    expect([search.name, fetch.name, crawl.name]).toEqual([
      WEB_SEARCH_TOOL,
      WEB_FETCH_TOOL,
      WEB_CRAWL_TOOL,
    ]);
    expect([search.ref, fetch.ref, crawl.ref]).toEqual([
      "bot/web_search",
      "bot/web_fetch",
      "bot/web_crawl",
    ]);
  });

  test("asks SearXNG for JSON and answers title, url and snippet with its source", async () => {
    const asked: URL[] = [];
    const base = serve((request) => {
      asked.push(new URL(request.url));
      return Response.json({ results: results(3) });
    });
    const { search } = tools({
      search: resolveSearchProvider({ XIONGBAO_SEARCH_URL: base }),
    });
    const answer = parsed(await search.execute({ query: "熊宝 数字员工" }));
    expect(asked[0]?.pathname).toBe("/search");
    expect(asked[0]?.searchParams.get("q")).toBe("熊宝 数字员工");
    expect(asked[0]?.searchParams.get("format")).toBe("json");
    expect(asked[0]?.searchParams.get("language")).toBe("zh-CN");
    expect(answer.source).toContain("SearXNG");
    expect(answer.untrusted).toContain("untrusted data");
    expect(answer.results).toEqual([
      {
        title: "结果 1",
        url: "https://example.com/1",
        snippet: "第 1 条的摘要",
      },
      {
        title: "结果 2",
        url: "https://example.com/2",
        snippet: "第 2 条的摘要",
      },
      {
        title: "结果 3",
        url: "https://example.com/3",
        snippet: "第 3 条的摘要",
      },
    ]);
    expect(String(answer.note)).toContain("web_fetch");
  });

  test("keeps eight by default, as many as asked up to twenty, and the language asked for", async () => {
    let language = "";
    const base = serve((request) => {
      language = new URL(request.url).searchParams.get("language") ?? "";
      return Response.json({ results: results(30) });
    });
    const { search } = tools({
      search: resolveSearchProvider({ XIONGBAO_SEARCH_URL: base }),
    });
    const count = async (args: unknown) =>
      (parsed(await search.execute(args)).results as unknown[]).length;
    expect(await count({ query: "a" })).toBe(8);
    expect(await count({ query: "a", max_results: 3 })).toBe(3);
    expect(await count({ query: "a", max_results: 50 })).toBe(20);
    expect(await count(JSON.stringify({ query: "a", language: "en" }))).toBe(8);
    expect(language).toBe("en");
  });

  test("not configured: says so in Chinese and throws nothing", async () => {
    const setup = resolveSearchProvider({});
    expect(setup.provider).toBeUndefined();
    const { search } = tools({ search: setup });
    const answer = await search.execute({ query: "天气" });
    expect(answer).toContain("未配置搜索");
    expect(answer).toContain("XIONGBAO_SEARCH_URL");
    expect(
      await tools({
        search: resolveSearchProvider({
          XIONGBAO_SEARCH_PROVIDER: "google",
          XIONGBAO_SEARCH_URL: "http://searxng:8080",
        }),
      }).search.execute({ query: "天气" }),
    ).toContain("XIONGBAO_SEARCH_PROVIDER=google");
    expect(await search.execute({ query: "  " })).toContain("不能为空");
  });

  test("upstream 500, a refused JSON format and a timeout are answered, never thrown", async () => {
    const failing = serve(() => new Response("boom", { status: 500 }));
    expect(
      await tools({
        search: resolveSearchProvider({ XIONGBAO_SEARCH_URL: failing }),
      }).search.execute({ query: "a" }),
    ).toContain("HTTP 500");

    const forbidden = serve(() => new Response("no", { status: 403 }));
    expect(
      await tools({
        search: resolveSearchProvider({ XIONGBAO_SEARCH_URL: forbidden }),
      }).search.execute({ query: "a" }),
    ).toContain("search.formats");

    const slow = serve(
      () =>
        new Promise<Response>((resolve) =>
          setTimeout(() => resolve(Response.json({ results: [] })), 2000),
        ),
    );
    const answer = await tools({
      search: { provider: searxngProvider({ baseUrl: slow, timeoutMs: 100 }) },
    }).search.execute({ query: "a" });
    expect(answer).toContain("搜索没有完成");
    expect(answer).toContain("没有响应");

    const nobody = await tools({
      search: resolveSearchProvider({
        XIONGBAO_SEARCH_URL: "http://127.0.0.1:9",
      }),
    }).search.execute({ query: "a" });
    expect(nobody).toContain("连不上搜索服务");
  });

  test("searches wait their turn: at most two a second across the deployment", async () => {
    const waits: [string, number][] = [];
    const base = serve(() => Response.json({ results: results(1) }));
    const { search } = tools({
      search: resolveSearchProvider(
        { XIONGBAO_SEARCH_URL: base },
        {
          pacer: {
            async wait(key, minimum = 0) {
              waits.push([key, minimum]);
            },
          },
        },
      ),
    });
    await search.execute({ query: "a" });
    await search.execute({ query: "b" });
    expect(waits).toEqual([
      ["search", 0],
      ["search", 0],
    ]);
    // The shared pacer's interval, on a fake clock: the second, third and fourth search each wait.
    let clock = 0;
    const slept: number[] = [];
    const pacer = createHostPacer({
      intervalMs: 500,
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
    });
    for (let index = 0; index < 4; index++) await pacer.wait("search");
    expect(slept).toEqual([500, 500, 500]);
  });

  test("the provider is replaceable: any SearchProvider serves the same tool", async () => {
    const seen: string[] = [];
    const other: SearchProvider = {
      name: "other",
      source: "另一个提供方",
      async search({ query, maxResults }) {
        seen.push(`${query}:${maxResults}`);
        return [{ title: "T", url: "https://other.example/", snippet: "S" }];
      },
    };
    const answer = parsed(
      await tools({ search: { provider: other } }).search.execute({
        query: "q",
        max_results: 2,
      }),
    );
    expect(seen).toEqual(["q:2"]);
    expect(answer.source).toBe("另一个提供方");
    expect(answer.results).toEqual([
      { title: "T", url: "https://other.example/", snippet: "S" },
    ]);
  });
});

describe("web_fetch: the SSRF door", () => {
  test("refuses loopback, private, metadata and localhost addresses without sending anything", async () => {
    const { requested, policy } = site({});
    const { fetch } = tools({ fetchPolicy: policy });
    for (const url of [
      "http://127.0.0.1:5432/",
      "http://10.1.2.3/",
      "http://169.254.169.254/latest/meta-data/",
      "http://localhost:3001/health",
      "http://admin.localhost/",
      "http://[::1]/",
      "http://2130706433/",
      "http://192.168.1.1/",
      "http://metadata.google.internal/",
    ]) {
      const answer = await fetch.execute({ url });
      expect(answer).toStartWith("没有读这个网页：");
    }
    expect(requested).toEqual([]);
  });

  test("refuses a name that resolves inside the deployment", async () => {
    const { requested, policy } = site({});
    const { fetch } = tools({
      fetchPolicy: {
        ...policy,
        lookup: async () => [{ address: "10.0.0.7", family: 4 }],
      },
    });
    expect(await fetch.execute({ url: "https://intranet.example/" })).toContain(
      "内部网络",
    );
    expect(requested).toEqual([]);
  });

  test("follows a redirect to a public page, and refuses one into the deployment", async () => {
    const { requested, policy } = site({
      "https://a.example/old": () =>
        new Response(null, {
          status: 301,
          headers: { location: "https://a.example/new" },
        }),
      "https://a.example/new": html("<title>新页</title><p>到了</p>"),
      "https://a.example/sneaky": () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://10.0.0.5/admin" },
        }),
      "https://a.example/meta": () =>
        new Response(null, {
          status: 307,
          headers: { location: "http://169.254.169.254/" },
        }),
    });
    const { fetch } = tools({ fetchPolicy: policy });
    const moved = parsed(await fetch.execute({ url: "https://a.example/old" }));
    expect(moved.url).toBe("https://a.example/new");
    expect(moved.content).toContain("到了");
    expect(await fetch.execute({ url: "https://a.example/sneaky" })).toContain(
      "重定向到了不能读的地址",
    );
    expect(await fetch.execute({ url: "https://a.example/meta" })).toContain(
      "重定向到了不能读的地址",
    );
    expect(requested).not.toContain("http://10.0.0.5/admin");
    expect(requested).not.toContain("http://169.254.169.254/");
  });

  test("only http and https", async () => {
    const { fetch } = tools();
    for (const url of [
      "ftp://example.com/file",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "gopher://example.com/",
      "data:text/html,hi",
    ])
      expect(await fetch.execute({ url })).toContain("只能读 http 或 https");
    expect(checkFetchUrl("https://user:pw@example.com/").allowed).toBeFalse();
  });
});

describe("web_fetch: reading a page", () => {
  test("turns HTML into Markdown: headings, links, lists and tables kept, scripts gone", async () => {
    const { policy } = site({
      "https://news.example/a/story":
        html(`<!doctype html><html><head><title>一篇报道 - 新闻网</title>
        <script>window.secret = "不该出现的脚本";</script><style>.x{color:red}</style></head>
        <body><nav><a href="/">首页</a></nav><article><h1>大标题</h1>
        <p>${"这是正文的一句话。".repeat(30)}详见<a href="/doc?id=1">说明文档</a>。</p>
        <h2>要点</h2><ul><li>第一点</li><li>第二点</li></ul>
        <table><tr><th>城市</th><th>人口</th></tr><tr><td>北京</td><td>2185 万</td></tr></table>
        <p>${"第二段正文。".repeat(40)}</p></article><footer>版权所有</footer></body></html>`),
    });
    const page = parsed(
      await tools({ fetchPolicy: policy }).fetch.execute({
        url: "https://news.example/a/story",
      }),
    );
    const content = String(page.content);
    expect(page.title).toBe("一篇报道 - 新闻网");
    expect(content).toContain("## 大标题");
    expect(content).toContain("[说明文档](https://news.example/doc?id=1)");
    expect(content).toContain("-   第一点");
    expect(content).toContain("| 城市 | 人口 |");
    expect(content).toContain("| --- | --- |");
    expect(content).toContain("| 北京 | 2185 万 |");
    expect(content).not.toContain("不该出现的脚本");
    expect(content).not.toContain("color:red");
    expect(String(page.untrusted)).toContain("untrusted data");
  });

  test("decodes a GBK page", async () => {
    const gbk = new Uint8Array([0xc4, 0xe3, 0xba, 0xc3]); // 你好
    const { policy } = site({
      "https://old.example/": () =>
        new Response(gbk, {
          headers: { "content-type": "text/plain; charset=gbk" },
        }),
    });
    const page = parsed(
      await tools({ fetchPolicy: policy }).fetch.execute({
        url: "https://old.example/",
      }),
    );
    expect(page.content).toBe("你好");
  });

  test("text is returned as it is; a binary file is described, not returned", async () => {
    const { policy } = site({
      "https://api.example/data.json": () => Response.json({ a: 1 }),
      "https://img.example/cat.png": () =>
        new Response(new Uint8Array([137, 80, 78, 71]), {
          headers: { "content-type": "image/png", "content-length": "2048" },
        }),
    });
    const { fetch } = tools({ fetchPolicy: policy });
    const json = parsed(
      await fetch.execute({ url: "https://api.example/data.json" }),
    );
    expect(json.content).toBe('{"a":1}');
    const binary = await fetch.execute({ url: "https://img.example/cat.png" });
    expect(binary).toContain("二进制文件");
    expect(binary).toContain("image/png");
    expect(binary).toContain("2 KB");
  });

  test("a big page is cut to max_chars, and the body read stops at the byte limit", async () => {
    const { policy } = site({
      "https://big.example/": () =>
        new Response("字".repeat(300_000), {
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
    });
    const small = parsed(
      await tools({ fetchPolicy: policy }).fetch.execute({
        url: "https://big.example/",
        max_chars: 500,
      }),
    );
    expect(String(small.content).length).toBe(500);
    expect(small.truncated).toContain("前 500 字");

    const capped = parsed(
      await tools({ fetchPolicy: { ...policy, maxBytes: 3000 } }).fetch.execute(
        {
          url: "https://big.example/",
          max_chars: 999_999,
        },
      ),
    );
    expect(String(capped.content).length).toBe(1000);
    expect(capped.truncated).toContain("只读了开头");

    const defaults = parsed(
      await tools({ fetchPolicy: policy }).fetch.execute({
        url: "https://big.example/",
      }),
    );
    // 没有电脑可存盘时，默认截到 16KB（用户 2026-11-19 同意）：「字」占 3 字节，16384 / 3 取整是 5461 字。
    expect(String(defaults.content).length).toBe(5_461);
  });

  test("a site that does not answer in time is answered, never thrown", async () => {
    const hanging = ((_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason),
        );
      })) as unknown as typeof fetch;
    const answer = await tools({
      fetchPolicy: {
        ...site({}).policy,
        fetchImpl: hanging,
        timeoutMs: 100,
      },
    }).fetch.execute({ url: "https://slow.example/" });
    expect(answer).toContain("没有响应完");
  });
});

/** 假 Crawl4AI：记下收到的请求，按 `answer` 回。 */
function fakeCrawl4ai(
  answer: (body: Record<string, unknown>) => Response | Promise<Response>,
) {
  const received: { body: Record<string, unknown>; authorization: string }[] =
    [];
  const base = serve(async (request) => {
    const body = (await request.json()) as Record<string, unknown>;
    received.push({
      body,
      authorization: request.headers.get("authorization") ?? "",
    });
    return answer(body);
  });
  return { base, received };
}

describe("web_fetch render_js", () => {
  test("with Crawl4AI configured, reads the page it rendered", async () => {
    const { base, received } = fakeCrawl4ai(() =>
      Response.json({
        success: true,
        results: [
          {
            url: "https://spa.example/app",
            success: true,
            status_code: 200,
            html: "<html><head><title>渲染后</title></head><body><h1>脚本加载的内容</h1><p>只有渲染后才看得到。</p></body></html>",
          },
        ],
      }),
    );
    const { requested, policy } = site({});
    const page = parsed(
      await tools({
        fetchPolicy: policy,
        crawl: resolveCrawlService({
          XIONGBAO_CRAWL_URL: base,
          XIONGBAO_CRAWL_TOKEN: "crawl-token",
        }),
      }).fetch.execute({ url: "https://spa.example/app", render_js: true }),
    );
    expect(page.title).toBe("渲染后");
    expect(page.content).toContain("脚本加载的内容");
    expect(page.rendered).toBeDefined();
    expect(received[0]?.authorization).toBe("Bearer crawl-token");
    expect(received[0]?.body.urls).toEqual(["https://spa.example/app"]);
    expect(requested).toEqual([]);
  });

  test("an internal address is never handed to Crawl4AI, and a render that landed inside is refused", async () => {
    const { base, received } = fakeCrawl4ai(() =>
      Response.json({
        success: true,
        results: [
          {
            url: "https://spa.example/app",
            redirected_url: "http://10.0.0.9/",
            success: true,
            html: "<p>secret</p>",
          },
        ],
      }),
    );
    const { fetch } = tools({
      fetchPolicy: site({}).policy,
      crawl: resolveCrawlService({ XIONGBAO_CRAWL_URL: base }),
    });
    expect(
      await fetch.execute({ url: "http://127.0.0.1:8080/", render_js: true }),
    ).toContain("内部网络");
    expect(received).toEqual([]);
    const landed = await fetch.execute({
      url: "https://spa.example/app",
      render_js: true,
    });
    expect(landed).toContain("重定向到了不能读的地址");
    expect(landed).not.toContain("secret");
  });

  test("without Crawl4AI, says so in Chinese and reads the page the ordinary way", async () => {
    const { policy } = site({
      "https://spa.example/app": html("<title>普通</title><p>静态内容</p>"),
    });
    const page = parsed(
      await tools({
        fetchPolicy: policy,
        crawl: resolveCrawlService({}),
      }).fetch.execute({ url: "https://spa.example/app", render_js: true }),
    );
    expect(page.content).toContain("静态内容");
    expect(String((page.notes as string[])[0])).toContain("没有配置爬虫服务");
    expect(String((page.notes as string[])[0])).toContain("按普通方式读取");
  });

  test("a Crawl4AI that fails falls back to the ordinary read", async () => {
    const { base } = fakeCrawl4ai(() =>
      Response.json({ detail: "boom" }, { status: 500 }),
    );
    const { policy } = site({
      "https://spa.example/app": html("<p>静态内容</p>"),
    });
    const page = parsed(
      await tools({
        fetchPolicy: policy,
        crawl: resolveCrawlService({ XIONGBAO_CRAWL_URL: base }),
      }).fetch.execute({ url: "https://spa.example/app", render_js: true }),
    );
    expect(page.content).toContain("静态内容");
    expect(String((page.notes as string[])[0])).toContain("HTTP 500");
  });
});

describe("web_crawl through Crawl4AI", () => {
  const deepAnswer = (count: number, extra: object[] = []) =>
    Response.json({
      success: true,
      results: [
        ...Array.from({ length: count }, (_, index) => ({
          url: `https://docs.example/p${index}`,
          success: true,
          markdown: {
            raw_markdown: `# 第 ${index} 页\n\n${"正文".repeat(500)}`,
            fit_markdown: "",
          },
          metadata: { title: `第 ${index} 页`, depth: index === 0 ? 0 : 1 },
        })),
        ...extra,
      ],
    });

  test("asks for a BFS deep crawl within the limits, with robots.txt on, and keeps only references and summaries", async () => {
    const { base, received } = fakeCrawl4ai(() => deepAnswer(3));
    const archive = createCrawlArchive();
    const { crawl, fetch } = tools({
      fetchPolicy: site({}).policy,
      crawl: resolveCrawlService({ XIONGBAO_CRAWL_URL: base }),
      archive,
    });
    const answer = parsed(
      await crawl.execute({
        url: "https://docs.example/p0",
        max_pages: 99,
        max_depth: 9,
        include: ["/p*"],
        exclude: ["*.pdf"],
      }),
    );
    const sent = received[0]?.body.crawler_config as
      | { params: Record<string, unknown> }
      | undefined;
    const params = sent?.params ?? {};
    expect(received[0]?.body.urls).toEqual(["https://docs.example/p0"]);
    expect(params.check_robots_txt).toBeTrue();
    expect(params.user_agent).toBe(CRAWLER_USER_AGENT);
    const strategy = params.deep_crawl_strategy as {
      type: string;
      params: Record<string, unknown>;
    };
    expect(strategy.type).toBe("BFSDeepCrawlStrategy");
    expect(strategy.params.max_pages).toBe(50);
    expect(strategy.params.max_depth).toBe(3);
    expect(strategy.params.include_external).toBeFalse();
    expect(JSON.stringify(strategy.params.filter_chain)).toContain(
      '"allowed_domains":["docs.example"]',
    );
    expect(JSON.stringify(strategy.params.filter_chain)).toContain(
      '"reverse":true',
    );

    expect(answer.source).toContain("Crawl4AI");
    const pages = answer.pages as {
      ref: string;
      url: string;
      title: string;
      summary: string;
      chars: number;
    }[];
    expect(pages.map((page) => page.url)).toEqual([
      "https://docs.example/p0",
      "https://docs.example/p1",
      "https://docs.example/p2",
    ]);
    expect(pages[0]?.summary.length).toBeLessThanOrEqual(600);
    expect(pages[0]?.chars).toBeGreaterThan(600);
    // The whole page is kept, and web_fetch reads it back by its reference, for this person only.
    const full = parsed(await fetch.execute({ url: pages[1]?.ref }));
    expect(String(full.content)).toContain("# 第 1 页");
    expect(String(full.content).length).toBeGreaterThan(900);
    const someoneElse = tools({ archive, scope: "other:bot" }).fetch;
    expect(await someoneElse.execute({ url: pages[1]?.ref })).toContain(
      "已经过期",
    );
  });

  test("cuts to max_pages, and drops a page Crawl4AI says it reached inside the deployment", async () => {
    const { base } = fakeCrawl4ai(() =>
      deepAnswer(8, [
        {
          url: "http://192.168.0.10/admin",
          success: true,
          markdown: "secret",
          metadata: { title: "admin" },
        },
      ]),
    );
    const answer = parsed(
      await tools({
        fetchPolicy: site({}).policy,
        crawl: resolveCrawlService({ XIONGBAO_CRAWL_URL: base }),
      }).crawl.execute({ url: "https://docs.example/p0", max_pages: 5 }),
    );
    expect((answer.pages as unknown[]).length).toBe(5);
    expect(answer.stopped).toContain("5 页");
    expect(JSON.stringify(answer)).not.toContain("secret");
    expect((answer.skipped as { refused: number }).refused).toBe(1);
  });

  test("an internal start address is never handed to Crawl4AI", async () => {
    const { base, received } = fakeCrawl4ai(() => deepAnswer(1));
    const { crawl } = tools({
      fetchPolicy: site({}).policy,
      crawl: resolveCrawlService({ XIONGBAO_CRAWL_URL: base }),
    });
    expect(await crawl.execute({ url: "http://10.0.0.1/" })).toContain(
      "没有爬取这个网站",
    );
    expect(await crawl.execute({ url: "http://localhost:11235/" })).toContain(
      "没有爬取这个网站",
    );
    expect(received).toEqual([]);
  });
});

describe("web_crawl in process (no Crawl4AI)", () => {
  const pages = {
    "https://shop.example/robots.txt": () =>
      new Response("User-agent: *\nDisallow: /private/\n", {
        headers: { "content-type": "text/plain" },
      }),
    "https://shop.example/": html(`<title>首页</title><h1>店铺</h1>
      <a href="/a">A</a> <a href="/b#top">B</a> <a href="/private/x">私密</a>
      <a href="http://10.0.0.8/admin">内网</a> <a href="http://localhost:5432/">本机</a>
      <a href="https://elsewhere.example/">外站</a> <a href="mailto:x@shop.example">邮件</a>`),
    "https://shop.example/a": html(
      `<title>A</title><p>页面 A</p><a href="/a/deep">更深</a>`,
    ),
    "https://shop.example/b": html(`<title>B</title><p>页面 B</p>`),
    "https://shop.example/a/deep": html(
      `<title>深</title><p>第二层</p><a href="/a/deeper">再深</a>`,
    ),
    "https://shop.example/a/deeper": html(`<title>更深</title><p>第三层</p>`),
  };

  test("crawls breadth first, keeps to the site, obeys robots.txt and refuses links into the deployment", async () => {
    const { requested, policy } = site(pages);
    const answer = parsed(
      await tools({
        fetchPolicy: policy,
        crawl: resolveCrawlService({}),
      }).crawl.execute({ url: "https://shop.example/" }),
    );
    expect(answer.source).toContain("进程内");
    const urls = (answer.pages as { url: string }[]).map((page) => page.url);
    expect(urls).toEqual([
      "https://shop.example/",
      "https://shop.example/a",
      "https://shop.example/b",
      "https://shop.example/a/deep",
    ]);
    const skipped = answer.skipped as { robots: number; refused: number };
    expect(skipped.robots).toBe(1);
    expect(skipped.refused).toBe(2);
    expect(requested).not.toContain("https://shop.example/private/x");
    expect(requested).not.toContain("http://10.0.0.8/admin");
    expect(requested).not.toContain("http://localhost:5432/");
    expect(requested).not.toContain("https://elsewhere.example/");
    // Depth 2 by default: the page three links down is not fetched.
    expect(requested).not.toContain("https://shop.example/a/deeper");
  });

  test("with same_domain off it follows other sites, and still never a link into the deployment", async () => {
    const { requested, policy } = site({
      ...pages,
      "https://elsewhere.example/": html("<title>外站</title><p>外站页面</p>"),
    });
    const answer = parsed(
      await tools({ fetchPolicy: policy }).crawl.execute({
        url: "https://shop.example/",
        same_domain: false,
        max_depth: 1,
      }),
    );
    expect(
      (answer.pages as { url: string }[]).map((page) => page.url),
    ).toContain("https://elsewhere.example/");
    expect((answer.skipped as { refused: number }).refused).toBe(2);
    expect(requested).not.toContain("http://10.0.0.8/admin");
    expect(requested).not.toContain("http://localhost:5432/");
  });

  test("stops at max_pages and max_depth", async () => {
    const { policy } = site(pages);
    const { crawl } = tools({
      fetchPolicy: policy,
      crawl: resolveCrawlService({}),
    });
    const two = parsed(
      await crawl.execute({ url: "https://shop.example/", max_pages: 2 }),
    );
    expect((two.pages as unknown[]).length).toBe(2);
    expect(two.stopped).toContain("2 页");
    const flat = parsed(
      await crawl.execute({ url: "https://shop.example/", max_depth: 0 }),
    );
    expect((flat.pages as unknown[]).length).toBe(1);
  });

  test("a site whose robots.txt disallows everything is not crawled", async () => {
    const { requested, policy } = site({
      "https://closed.example/robots.txt": () =>
        new Response("User-agent: XiongbaoBot\nDisallow: /\n"),
      "https://closed.example/": html("<p>不该被读</p>"),
    });
    const answer = await tools({
      fetchPolicy: policy,
      crawl: resolveCrawlService({}),
    }).crawl.execute({ url: "https://closed.example/" });
    expect(answer).toContain("robots.txt 不许爬");
    expect(requested).toEqual(["https://closed.example/robots.txt"]);
  });

  test("waits its turn for every request to the same site", async () => {
    const waits: string[] = [];
    const recording: HostPacer = {
      async wait(host) {
        waits.push(host);
      },
    };
    const { policy } = site(pages);
    await tools({
      fetchPolicy: policy,
      crawl: resolveCrawlService({}),
      pacer: recording,
    }).crawl.execute({ url: "https://shop.example/", max_pages: 3 });
    // robots.txt, then three pages: every request waited for its turn on that host.
    expect(waits).toEqual(Array(4).fill("shop.example"));
  });

  test("Crawl4AI failing falls back to the in-process crawl and says so", async () => {
    const { base } = fakeCrawl4ai(() =>
      Response.json({ detail: "Deep crawling is disabled" }, { status: 400 }),
    );
    const { policy } = site(pages);
    const answer = parsed(
      await tools({
        fetchPolicy: policy,
        crawl: resolveCrawlService({ XIONGBAO_CRAWL_URL: base }),
      }).crawl.execute({ url: "https://shop.example/", max_pages: 1 }),
    );
    expect(answer.source).toContain("进程内");
    expect(String((answer.notes as string[])[0])).toContain("HTTP 400");
    expect(String((answer.notes as string[])[0])).toContain("退回进程内");
  });

  test("an include or exclude pattern that is not a path is refused before anything is fetched", async () => {
    const { requested, policy } = site(pages);
    const { crawl } = tools({ fetchPolicy: policy });
    expect(
      await crawl.execute({ url: "https://shop.example/", include: ["docs"] }),
    ).toContain("要以 / 或 * 开头");
    expect(requested).toEqual([]);
  });
});

describe("the rules a crawl keeps", () => {
  test("robots.txt: the group naming us wins over *, longest match wins, Allow wins a tie", () => {
    const rules = parseRobots(
      [
        "User-agent: *",
        "Disallow: /",
        "",
        "User-agent: XiongbaoBot",
        "Disallow: /private/",
        "Allow: /private/open",
        "Disallow: /*.pdf$",
        "Crawl-delay: 2",
      ].join("\n"),
    );
    expect(rules.allows("/")).toBeTrue();
    expect(rules.allows("/private/secret")).toBeFalse();
    expect(rules.allows("/private/open/page")).toBeTrue();
    expect(rules.allows("/files/report.pdf")).toBeFalse();
    expect(rules.allows("/files/report.pdf?x=1")).toBeTrue();
    expect(rules.crawlDelayMs).toBe(2000);
    expect(
      parseRobots("User-agent: *\nDisallow: /\n").allows("/a"),
    ).toBeFalse();
    expect(parseRobots("User-agent: *\nDisallow:\n").allows("/a")).toBeTrue();
    expect(parseRobots("").allows("/anything")).toBeTrue();
  });

  test("one request a second per site: the second and third wait their turn, another site does not", async () => {
    let clock = 0;
    const slept: number[] = [];
    const pacer = createHostPacer({
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    await pacer.wait("a.example");
    await pacer.wait("a.example");
    await pacer.wait("A.example");
    await pacer.wait("b.example");
    expect(slept).toEqual([1000, 2000]);
    // Once the queue has drained, the next request goes at once; a Crawl-delay holds the one after it.
    clock = 5000;
    await pacer.wait("a.example", 3000);
    expect(slept).toEqual([1000, 2000]);
    await pacer.wait("a.example");
    expect(slept).toEqual([1000, 2000, 3000]);
  });

  test("path patterns", () => {
    const url = (path: string) => new URL(`https://x.example${path}`);
    expect(pathMatches("/docs/*", url("/docs/a/b"))).toBeTrue();
    expect(pathMatches("/docs/*", url("/blog/a"))).toBeFalse();
    expect(pathMatches("*.pdf", url("/a/b.pdf"))).toBeTrue();
    expect(pathMatches("*/login*", url("/user/login?next=/"))).toBeTrue();
  });
});

describe("Readability and turndown", () => {
  test("a page with no article is converted whole, links made absolute, scripts gone", () => {
    const page = extractReadable(
      `<html><head><title>目录</title></head><body><h2>文档</h2>
       <ol><li><a href="guide">指南</a></li><li><a href="javascript:void(0)">坏链接</a></li></ol>
       <script>bad()</script><img src="x.png" alt="示意图"></body></html>`,
      "https://docs.example/zh/",
    );
    expect(page.title).toBe("目录");
    expect(page.markdown).toContain("## 文档");
    expect(page.markdown).toContain("[指南](https://docs.example/zh/guide)");
    expect(page.markdown).toContain("坏链接");
    expect(page.markdown).not.toContain("javascript:");
    expect(page.markdown).not.toContain("bad()");
    expect(page.markdown).toContain("[图片：示意图]");
  });

  test("a table without a header row still becomes a Markdown table, pipes escaped", () => {
    const page = extractReadable(
      "<table><tbody><tr><td>a|b</td><td>c</td></tr><tr><td>d</td></tr></tbody></table>",
    );
    expect(page.markdown).toBe("| a\\|b | c |\n| --- | --- |\n| d |  |");
  });

  test("the Crawl4AI client reads both markdown shapes", async () => {
    const { base } = fakeCrawl4ai(() =>
      Response.json({
        success: true,
        results: [
          { url: "https://x.example/1", success: true, markdown: "plain" },
          {
            url: "https://x.example/2",
            success: true,
            markdown: { raw_markdown: "raw", fit_markdown: "fit" },
          },
          { url: "https://x.example/3", success: false, error_message: "x" },
        ],
      }),
    );
    const service: CrawlService = crawl4aiService({ baseUrl: base });
    const pages = await service.deepCrawl({
      url: "https://x.example/1",
      maxPages: 5,
      maxDepth: 1,
      sameDomain: true,
      include: [],
      exclude: [],
      timeoutMs: 5000,
    });
    expect(pages.map((page) => page.markdown)).toEqual(["plain", "fit"]);
  });
});
