import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  researchRoleOf,
  researchRoleOfToolName,
} from "@openbot/shared/research";
import { parse } from "yaml";
import { listTools } from "../src/plugins/mcp";
import { selectTools } from "../src/plugins/selection";

const RESEARCH_TOOLS: Record<string, [string, string]> = {
  parallel: ["web_search", "web_fetch"],
  "parallel-authenticated": ["web_search", "web_fetch"],
  exa: ["web_search_exa", "web_fetch_exa"],
  "exa-authenticated": ["web_search_exa", "web_fetch_exa"],
  firecrawl: ["firecrawl_search", "firecrawl_scrape"],
  "firecrawl-authenticated": ["firecrawl_search", "firecrawl_scrape"],
};

describe("whether a Bot holds a search tool", () => {
  test("any provider's search tool counts, from its ref or the name a model sees", () => {
    // M3: the fork's plugins/tools.ts has no `holdsWebSearch` yet (planned with phase 4's search), so
    // only the shared name reading is asserted here.
    for (const [server, [search, fetch]] of Object.entries(RESEARCH_TOOLS)) {
      expect(researchRoleOfToolName(`mcp__${server}__${search}`)).toBe(
        "search",
      );
      expect(researchRoleOfToolName(`mcp__${server}__${fetch}`)).toBe("fetch");
    }
    expect(researchRoleOfToolName("web_search")).toBeNull();
    expect(
      researchRoleOfToolName("mcp__google-drive__search_files"),
    ).toBeNull();
  });

  // M3: "the search apps a Bot without one offers" is not adopted: the fork's catalogue has no Exa
  // or Firecrawl entries (plugins session).
});

// M3: upstream's research providers in the catalogue (Exa, Firecrawl, their read lists and
// credentials) are not in the fork's plugins/catalogue; the plugins session owns porting them.

// M3: upstream's research guidance in grantedToolGuidance ("For public-web research you can
// use:") is not in the fork's plugins/tools; it waits for phase 4's search (plugins session).

describe("a skill declaring research by role", () => {
  const others = Array.from({ length: 12 }, (_, index) => ({
    ref: `slack/tool_${index}`,
  }));
  const research = {
    slug: "research",
    title: "Research",
    summary: "Research the public web.",
    tools: ["@research/search", "@research/fetch"],
  };
  const slack = {
    slug: "slack",
    title: "Slack",
    summary: "Slack.",
    tools: others.map((entry) => entry.ref),
  };
  const choose = (slug: string) => async () =>
    JSON.stringify({ skills: [slug] });

  test("brings whichever provider's tools the Bot holds", async () => {
    const tools = [
      ...others,
      { ref: "exa/web_search_exa" },
      { ref: "exa/web_fetch_exa" },
      { ref: "exa/web_search_advanced_exa" },
    ];
    const selection = await selectTools({
      tools,
      skills: [research, slack],
      text: "find recent coverage of this",
      choose: choose("research"),
    });
    const offered = selection.offered.map((entry) => entry.ref);
    expect(offered).toContain("exa/web_search_exa");
    expect(offered).toContain("exa/web_fetch_exa");
    expect(offered).not.toContain("slack/tool_0");
    // Not a research role, and no skill declares it, so it is offered as any undeclared tool is.
    expect(offered).toContain("exa/web_search_advanced_exa");
  });

  test("never offers a provider the Bot was not granted", async () => {
    const selection = await selectTools({
      tools: [...others, { ref: "firecrawl/firecrawl_search" }],
      skills: [research, slack],
      text: "find recent coverage of this",
      choose: choose("research"),
    });
    const offered = selection.offered.map((entry) => entry.ref);
    expect(offered).toEqual(["firecrawl/firecrawl_search"]);
  });

  test("a role ref is only ever the two roles", () => {
    expect(researchRoleOf("@research/search")).toBe("search");
    expect(researchRoleOf("@research/fetch")).toBe("fetch");
    expect(researchRoleOf("@research/delete")).toBeNull();
    expect(researchRoleOf("@research/search/more")).toBeNull();
    expect(researchRoleOf("research/search")).toBeNull();
  });

  test("the shipped Research Desk skill declares roles, not one provider", () => {
    const skills = parse(
      readFileSync(
        new URL("../../examples/fintech/skills.yaml", import.meta.url),
        "utf8",
      ),
    ).skills;
    const skill = skills.find(
      (item: { slug: string }) => item.slug === "research-public-web",
    );
    expect(skill.tools).toEqual(["@research/search", "@research/fetch"]);
    const desk = parse(
      readFileSync(
        new URL(
          "../../examples/fintech/catalog/research-desk.yaml",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    expect(desk.skills).toContain("research-public-web");
  });
});

describe("the header a deployment token is sent in", () => {
  let server: ReturnType<typeof Bun.serve>;
  let seen: Headers | undefined;
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(request) {
        seen ??= request.headers;
        return new Response("no", { status: 401 });
      },
    });
  });
  afterAll(() => server.stop(true));

  const listed = async (connection: {
    token: string;
    tokenHeader?: string;
  }) => {
    seen = undefined;
    await listTools({
      url: `http://127.0.0.1:${server.port}/mcp`,
      ...connection,
    }).catch(() => undefined);
    return seen;
  };

  test("is Authorization as a Bearer token by default", async () => {
    const headers = await listed({ token: "secret" });
    expect(headers?.get("authorization")).toBe("Bearer secret");
  });

  // M3: "the vendor's own header" is not adopted: the fork's MCP transport and catalogue name no
  // token header of an entry's own (no tokenHeaderFor; plugins session).
});
