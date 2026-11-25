import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AbstractAgent } from "@ag-ui/client";
import { type ChatCompletionRequest, LLMock } from "@copilotkit/aimock";
import { computerGuidance } from "../../shared/bot-prompt";
import {
  WEB_CRAWL_TOOL,
  WEB_FETCH_TOOL,
  WEB_SEARCH_TOOL,
} from "../../shared/web-tools";
import { createActorAgentResolver } from "../src/agents/agent-resolver";
import { updatePlanTools } from "../src/agents/update-plan";
import { toolDisabled } from "../src/approvals/policy";
import { builtInAgentConfiguration, type RuntimeModel } from "../src/copilot";
import type { GrantedTool } from "../src/plugins/tools";
import { resolveSearchProvider } from "../src/web/search";
import {
  WEB_CRAWL_REF,
  WEB_FETCH_REF,
  WEB_SEARCH_REF,
  webTools,
} from "../src/web/tools";

/*
 * 期五 B：联网工具每位员工默认都有，工具权限可以逐个关掉；持有时提示词告诉它先搜、再读原文、附出处，
 * 不再说「不能搜、只能凭记忆答」；不持有时提示词一个字不变。最后用 aimock 走一遍全路径：模型先
 * web_search，再 web_fetch，最后带着出处作答。
 */

const BAIDU = "https://www.baidu.com/s?wd=";
const BROWSER = ["computer_navigate", "computer_read"];

/** 这三个工具，搜索指向不存在的地址（这里只看名字和提示词，不调用）。 */
const held = () =>
  webTools({
    search: resolveSearchProvider({
      XIONGBAO_SEARCH_URL: "http://searxng:8080",
    }),
    scope: "owner:bot",
  });

describe("who holds the web tools", () => {
  test("every Bot is granted them with the tools it needs to be itself", () => {
    const index = readFileSync(
      join(import.meta.dir, "..", "src", "index.ts"),
      "utf8",
    );
    const granted = index.slice(
      index.indexOf("const loadGrantedToolsForActor = async ("),
    );
    const body = granted.slice(0, granted.indexOf("\n  ];\n"));
    expect(body).toContain("...webTools({");
    expect(held().map((tool) => tool.name)).toEqual([
      WEB_SEARCH_TOOL,
      WEB_FETCH_TOOL,
      WEB_CRAWL_TOOL,
    ]);
  });

  test("a deny rule switches each off for that Bot alone", () => {
    const deny = (toolRef: string) => ({
      id: `rule-${toolRef}`,
      botId: "researcher",
      toolRef,
      effect: "*",
      scope: "*",
      behaviour: "deny" as const,
    });
    const offered = (botId: string, refs: string[]) =>
      held()
        .filter(
          (tool) =>
            !toolDisabled({ botId, toolRef: tool.ref }, [refs.map(deny)]),
        )
        .map((tool) => tool.name);
    expect(offered("researcher", [])).toEqual([
      WEB_SEARCH_TOOL,
      WEB_FETCH_TOOL,
      WEB_CRAWL_TOOL,
    ]);
    expect(offered("researcher", [WEB_SEARCH_REF])).toEqual([
      WEB_FETCH_TOOL,
      WEB_CRAWL_TOOL,
    ]);
    expect(offered("researcher", [WEB_FETCH_REF, WEB_CRAWL_REF])).toEqual([
      WEB_SEARCH_TOOL,
    ]);
    expect(
      offered("someone-else", [WEB_SEARCH_REF, WEB_FETCH_REF, WEB_CRAWL_REF]),
    ).toEqual([WEB_SEARCH_TOOL, WEB_FETCH_TOOL, WEB_CRAWL_TOOL]);
  });
});

describe("what a Bot holding them is told", () => {
  const agent = {
    id: "researcher",
    name: "Researcher",
    type: "built_in" as const,
    systemPrompt: "Find things out.",
  };
  const model = { provider: "openai" as const, defaultModel: "gpt-5.6-terra" };
  const now = new Date("2026-11-19T08:00:00Z");
  const prompt = (tools: GrantedTool[], runToolNames?: string[]) =>
    (
      builtInAgentConfiguration(
        agent,
        model,
        "synthetic-key",
        tools,
        computerGuidance,
        [],
        null,
        undefined,
        undefined,
        now,
        undefined,
        undefined,
        undefined,
        runToolNames,
      ) as { prompt?: string }
    ).prompt ?? "";
  const NO_SEARCH = [
    "Never drive your browser to a search engine",
    "none of your tools searches the web, answer from what you",
    "cannot search",
    "不许搜",
  ];

  test("holding web_search: search first, read the source, cite it; never told it cannot search", () => {
    for (const names of [undefined, BROWSER]) {
      const text = prompt(held(), names);
      expect(text).toContain("<web_research>");
      expect(text).toContain("先用 web_search 搜，再用 web_fetch");
      expect(text).toContain("附上来源链接");
      expect(text).toContain(
        "要读整个网站、一个文档目录或很多页时用 web_crawl",
      );
      expect(text).toContain("robots.txt");
      for (const phrase of NO_SEARCH) expect(text).not.toContain(phrase);
    }
  });

  test("with a browser too, the browser is only the fallback when the search tool cannot answer", () => {
    const text = prompt(held(), BROWSER);
    const section = text.slice(
      text.indexOf("<web_research>"),
      text.indexOf("</web_research>"),
    );
    expect(section).toContain(
      "回报没有配置搜索或搜索出错时，才退而用浏览器搜索",
    );
    expect(section).toContain(BAIDU);
    // The Baidu-first guidance (`browserSearchGuidance`) is not given beside it.
    expect(text).not.toContain(
      "Searching the public web with your browser: when a question needs public information",
    );
    expect(text.indexOf("<web_research>")).toBeLessThan(
      text.indexOf("<computer>"),
    );
    // Without a browser, no browser fallback is offered.
    expect(prompt(held())).not.toContain(BAIDU);
  });

  test("each tool switched off is left out of the section", () => {
    const [search, fetch, crawl] = held() as [
      GrantedTool,
      GrantedTool,
      GrantedTool,
    ];
    const onlyFetch = prompt([fetch]);
    expect(onlyFetch).toContain("<web_research>");
    expect(onlyFetch).not.toContain(WEB_SEARCH_TOOL);
    expect(onlyFetch).not.toContain(WEB_CRAWL_TOOL);
    const noCrawl = prompt([search, fetch]);
    expect(noCrawl).not.toContain(WEB_CRAWL_TOOL);
    expect(prompt([crawl])).not.toContain(`${WEB_FETCH_TOOL} 读`);
  });

  test("holding none of them: the prompt is exactly what it was", () => {
    const plan = updatePlanTools();
    for (const names of [undefined, BROWSER, []]) {
      const before = prompt(plan, names);
      expect(before).not.toContain("<web_research>");
      // Built twice from the same input, the same prompt: nothing about the web tools leaks in.
      expect(prompt(plan, names)).toBe(before);
    }
    // Without the web tools a browser still gets the Baidu guidance it always had, and a run with
    // neither is still told it cannot search.
    expect(prompt(plan, BROWSER)).toContain(BAIDU);
    expect(prompt(plan)).toContain(
      "Never drive your browser to a search engine",
    );
  });
});

const model: RuntimeModel = {
  provider: "openai",
  defaultModel: "gpt-5.6-terra",
};
const bot = {
  id: "researcher",
  name: "Researcher",
  type: "built_in" as const,
  systemPrompt: "Find things out.",
};

let llm: LLMock;
let originalBase: string | undefined;
let asked: ChatCompletionRequest[];
let searxng: ReturnType<typeof Bun.serve> | undefined;

beforeEach(async () => {
  llm = new LLMock();
  asked = [];
  originalBase = process.env.OPENAI_BASE_URL;
  process.env.OPENAI_BASE_URL = await llm.start();
});

afterEach(async () => {
  if (originalBase === undefined) delete process.env.OPENAI_BASE_URL;
  else process.env.OPENAI_BASE_URL = originalBase;
  await llm.stop();
  searxng?.stop(true);
  searxng = undefined;
});

describe("a person's question that needs the web", () => {
  test("is answered by searching, reading the source, and citing it", async () => {
    searxng = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        Response.json({
          results: [
            {
              url: "https://stats.example/2026/population",
              title: "2026 年人口统计公报",
              content: "全市常住人口……",
            },
          ],
        }),
    });
    const pageFetches: string[] = [];
    const tools = webTools({
      search: resolveSearchProvider({
        XIONGBAO_SEARCH_URL: `http://127.0.0.1:${searxng.port}`,
      }),
      scope: "owner:researcher",
      fetchPolicy: {
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
        viaProxy: () => false,
        fetchImpl: (async (input: string | URL | Request) => {
          pageFetches.push(String(input));
          return new Response(
            `<html><head><title>2026 年人口统计公报</title></head><body><article><h1>人口统计公报</h1><p>${"统计说明。".repeat(60)}年末全市常住人口为 2185.8 万人。</p></article></body></html>`,
            { headers: { "content-type": "text/html; charset=utf-8" } },
          );
        }) as unknown as typeof fetch,
      },
    });
    const script = [
      {
        toolCalls: [
          {
            id: "call_search",
            name: WEB_SEARCH_TOOL,
            arguments: JSON.stringify({ query: "2026 年 常住人口 统计公报" }),
          },
        ],
      },
      {
        toolCalls: [
          {
            id: "call_fetch",
            name: WEB_FETCH_TOOL,
            arguments: JSON.stringify({
              url: "https://stats.example/2026/population",
            }),
          },
        ],
      },
      {
        content:
          "年末常住人口为 2185.8 万人。来源：https://stats.example/2026/population（2026-11-19 查询）",
      },
    ];
    llm.on({ predicate: () => true }, (request) => {
      asked.push(request);
      return script[asked.length - 1] ?? { content: "?" };
    });

    const resolver = createActorAgentResolver({
      loadAgents: async () => [bot],
      model,
      resolveModelApiKey: async () => "synthetic-key",
      loadToolsForActor: () => async () => tools,
    });
    const agent = await resolver.resolveAgentForActor(
      { id: "owner", role: "user" },
      bot.id,
    );
    const run = agent.clone() as AbstractAgent;
    run.threadId = "thread-web";
    run.setMessages([
      { id: "ask", role: "user", content: "今年常住人口是多少？给出处。" },
    ]);
    await run.runAgent({});

    expect(asked).toHaveLength(3);
    const offered = (asked[0]?.tools ?? []).map((tool) => tool.function.name);
    // 用户 2026-11-20 批准：瘦身默认开，web_crawl 排到 search_tools 后面（偶尔才用），不在首步的定义里；
    // 搜索、读网页仍常驻，原断言要的「搜→读来源→引用」这条路不变。
    expect(offered).toEqual(
      expect.arrayContaining([WEB_SEARCH_TOOL, WEB_FETCH_TOOL, "search_tools"]),
    );
    expect(offered).not.toContain(WEB_CRAWL_TOOL);
    expect(JSON.stringify(asked[0]?.messages)).toContain("<web_research>");
    // The search result reached the model, then the page it chose to read.
    expect(JSON.stringify(asked[1]?.messages.at(-1))).toContain(
      "https://stats.example/2026/population",
    );
    expect(pageFetches).toEqual(["https://stats.example/2026/population"]);
    expect(JSON.stringify(asked[2]?.messages.at(-1))).toContain("2185.8 万人");
    const answer = run.messages.at(-1);
    expect(answer?.role).toBe("assistant");
    expect(String(answer?.content)).toContain(
      "https://stats.example/2026/population",
    );
  });
});
