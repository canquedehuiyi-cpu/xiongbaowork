import { describe, expect, test } from "bun:test";
import { checkOutboundUrl } from "../src/net/outbound-guard";
import {
  CATALOGUE,
  type CatalogueAuth,
  CredentialPlacementRefusedError,
  catalogueEntry,
  classifyTool,
  credentialFormatRefusal,
  credentialPlacement,
  customUrlRefusal,
  ownerAssemblySource,
  placeCredential,
  resolveServerUrl,
  reviewedRead,
  serverCredentialKind,
} from "../src/plugins/catalogue";
import {
  authorizationUrlFor,
  redeemAuthorizationCode,
} from "../src/plugins/oauth";
import { exchangeRefreshTokenOverHttp } from "../src/plugins/store";

/**
 * The MCP market's first batch: nine vendor-hosted servers entered on one day's evidence.
 *
 * What is pinned here is what review decided about each of them — the key, whose credential reaches
 * it, and that the address it resolves to is one this deployment would accept even if an
 * administrator had typed it. A catalogue entry is dialled without the outbound guard's per-request
 * checks (those are for tenant-chosen URLs), so the static half of that guard is asserted here,
 * against the resolved URL, for every new entry.
 */

const BATCH: readonly {
  key: string;
  auth: CatalogueAuth["kind"];
  url: string;
}[] = [
  { key: "context7", auth: "none", url: "https://mcp.context7.com/mcp" },
  { key: "deepwiki", auth: "none", url: "https://mcp.deepwiki.com/mcp" },
  {
    key: "microsoft-learn",
    auth: "none",
    url: "https://learn.microsoft.com/api/mcp",
  },
  {
    key: "aws-knowledge",
    auth: "none",
    url: "https://knowledge-mcp.global.api.aws",
  },
  {
    key: "cloudflare-docs",
    auth: "none",
    url: "https://docs.mcp.cloudflare.com/mcp",
  },
  { key: "exa", auth: "none", url: "https://mcp.exa.ai/mcp" },
  {
    key: "firecrawl-keyless",
    auth: "none",
    url: "https://mcp.firecrawl.dev/v2/mcp",
  },
  {
    key: "bailian-websearch",
    auth: "deployment-bearer",
    url: "https://dashscope.aliyuncs.com/api/v1/mcps/WebSearch/mcp",
  },
  {
    key: "bailian-enhanced-search",
    auth: "deployment-bearer",
    url: "https://dashscope.aliyuncs.com/api/v1/mcps/EnhancedSearch/mcp",
  },
];

describe("the MCP market's first batch", () => {
  test("every key is an entry, once", () => {
    const keys = CATALOGUE.map((entry) => entry.key);
    for (const { key } of BATCH) {
      expect(catalogueEntry(key)).not.toBeNull();
      expect(keys.filter((held) => held === key)).toHaveLength(1);
    }
    // Keys are unique across the whole catalogue, not just this batch: a key prefixes every tool name.
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("each says whose credential reaches it, and the anonymous ones take none from a caller", () => {
    for (const { key, auth } of BATCH) {
      const entry = catalogueEntry(key);
      if (!entry) throw new Error(`Missing catalogue entry ${key}.`);
      expect(entry.auth.kind).toBe(auth);
      expect(serverCredentialKind(entry)).toBe(
        auth === "deployment-bearer" ? "mcp" : null,
      );
    }
  });

  test("each resolves to the vendor's published endpoint, and a caller cannot move it", () => {
    for (const { key, url } of BATCH) {
      const entry = catalogueEntry(key);
      if (!entry) throw new Error(`Missing catalogue entry ${key}.`);
      expect(entry.transport).toBeUndefined();
      expect(entry.hostPattern).toBeUndefined();
      // An instance host offered for a pinned vendor is ignored, never honoured.
      expect(resolveServerUrl(key, "https://evil.test")?.url).toBe(url);
    }
  });

  test("each host is a bare https origin and passes the static outbound checks", () => {
    for (const { key } of BATCH) {
      const entry = catalogueEntry(key);
      if (!entry?.host) throw new Error(`Missing pinned host for ${key}.`);
      // Origin only: the path lives in `path`, and nothing about the host carries a credential.
      const host = new URL(entry.host);
      expect(host.protocol).toBe("https:");
      expect(host.origin).toBe(entry.host);
      expect(entry.path.startsWith("/")).toBe(true);
      expect(entry.path).not.toContain("?");
      expect(entry.path).not.toContain("#");

      const resolved = resolveServerUrl(key);
      if (!resolved) throw new Error(`${key} did not resolve.`);
      // The rule an administrator's typed URL must pass, and the outbound guard's credential check
      // under its strict default policy (no private hosts, https only).
      expect(customUrlRefusal(resolved.url)).toBeNull();
      expect(checkOutboundUrl(resolved.url)).toEqual({
        allowed: true,
        url: new URL(resolved.url).toString(),
      });
    }
  });

  test("reviewed as lookups only, so advertised tools read and unadvertised ones still write", () => {
    for (const { key } of BATCH) {
      const entry = catalogueEntry(key);
      if (!entry) throw new Error(`Missing catalogue entry ${key}.`);
      expect(entry.writeTools).toEqual([]);
      expect(Object.isFrozen(entry.writeTools)).toBe(true);
    }
    // An advertised lookup reads; a name the server never listed is still a write; a vendor-recorded
    // write still narrows. The empty list widens nothing classifyTool did not already allow.
    const exa = catalogueEntry("exa");
    expect(classifyTool(exa, "web_search_exa", true)).toBe("read");
    expect(classifyTool(exa, "web_search_exa", false)).toBe("write");
    expect(classifyTool(exa, "web_search_exa", true, "write")).toBe("write");
    const aws = catalogueEntry("aws-knowledge");
    expect(classifyTool(aws, "aws___read_documentation", true)).toBe("read");
  });

  test("none of them opts into owner assembly", () => {
    for (const { key } of BATCH) {
      const entry = catalogueEntry(key);
      expect(entry?.ownerAssembly).toBeUndefined();
      expect(ownerAssemblySource(entry)).toBe(false);
    }
  });
});

/**
 * 经过审查、确认只读的工具名单（`readTools`，上游 #929 中的读写模型）。
 *
 * 名单是条目注释里记录的 2026-11-09 实测 `tools/list` 结果，一个不多一个不少。条目一旦列出只读名单，
 * 它就列全了：服务器以后新增的名字在有人审查并列进来之前都是写。没有名单的条目和以前完全一样。
 */
const MEASURED_READS: Readonly<Record<string, readonly string[]>> = {
  context7: ["resolve-library-id", "query-docs"],
  deepwiki: ["ask_wiki_question", "read_wiki_contents", "read_wiki_structure"],
  "microsoft-learn": [
    "microsoft_docs_search",
    "microsoft_code_sample_search",
    "microsoft_docs_fetch",
  ],
  "aws-knowledge": [
    "aws___read_documentation",
    "aws___search_documentation",
    "aws___list_regions",
    "aws___get_regional_availability",
    "aws___retrieve_skill",
  ],
  "cloudflare-docs": [
    "search_cloudflare_documentation",
    "migrate_pages_to_workers_guide",
  ],
};

describe("reviewed read lists", () => {
  test("each documentation entry names exactly the reads it was measured offering", () => {
    for (const [key, reads] of Object.entries(MEASURED_READS)) {
      const entry = catalogueEntry(key);
      if (!entry) throw new Error(`Missing catalogue entry ${key}.`);
      expect([...(entry.readTools ?? [])].sort()).toEqual([...reads].sort());
      expect(Object.isFrozen(entry.readTools)).toBe(true);
      // A name on both lists would be a contradiction review has to settle, not this code.
      for (const name of reads) expect(entry.writeTools).not.toContain(name);
    }
  });

  test("a listed read is a reviewed read, and still reads for chat", () => {
    for (const [key, reads] of Object.entries(MEASURED_READS)) {
      const entry = catalogueEntry(key);
      for (const name of reads) {
        expect(reviewedRead(entry, name, { destructive: false })).toBe(true);
        expect(classifyTool(entry, name, true)).toBe("read");
      }
    }
  });

  test("a name the server adds later is a write until somebody lists it", () => {
    const context7 = catalogueEntry("context7");
    expect(
      reviewedRead(context7, "delete-library", { destructive: false }),
    ).toBe(false);
    expect(classifyTool(context7, "delete-library", true)).toBe("write");
  });

  test("nothing a list says can widen: destructive, unadvertised and recorded writes still win", () => {
    const aws = catalogueEntry("aws-knowledge");
    expect(
      reviewedRead(aws, "aws___read_documentation", { destructive: true }),
    ).toBe(false);
    expect(classifyTool(aws, "aws___read_documentation", false)).toBe("write");
    expect(classifyTool(aws, "aws___read_documentation", true, "write")).toBe(
      "write",
    );
    const entry = catalogueEntry("context7");
    if (!entry) throw new Error("Missing catalogue entry context7.");
    // A name on the reviewed write list is a write whatever the read list says.
    const both = { ...entry, writeTools: ["query-docs"] };
    expect(reviewedRead(both, "query-docs", { destructive: false })).toBe(
      false,
    );
    expect(classifyTool(both, "query-docs", true)).toBe("write");
  });

  test("an entry with no read list behaves exactly as it did", () => {
    const exa = catalogueEntry("exa");
    expect(exa?.readTools).toBeUndefined();
    // Nothing was reviewed as a read, so nothing is a reviewed read...
    expect(reviewedRead(exa, "web_search_exa", { destructive: false })).toBe(
      false,
    );
    expect(reviewedRead(null, "anything", { destructive: false })).toBe(false);
    // ...and chat answers as before: an advertised name off the write list reads.
    expect(classifyTool(exa, "some_new_tool", true)).toBe("read");
    expect(
      classifyTool(catalogueEntry("linear"), "linear-new-thing", true),
    ).toBe("read");
    expect(classifyTool(null, "anything", true)).toBe("write");
  });
});

/**
 * The MCP market's second batch: ten vendor-hosted servers reached as the person asking.
 *
 * Nobody logged in to any of them when they were entered, so what is pinned here is the part review
 * could check: the address, whose credential reaches it, the OAuth addresses copied from each
 * vendor's published metadata, and which client shape the vendor allows — self-registered where the
 * metadata publishes a registration endpoint, administrator-registered where it does not.
 */
const SECOND_BATCH: readonly {
  key: string;
  url: string;
  dynamic: boolean;
}[] = [
  {
    key: "github",
    url: "https://api.githubcopilot.com/mcp/readonly",
    dynamic: false,
  },
  { key: "linear", url: "https://mcp.linear.app/mcp", dynamic: true },
  { key: "atlassian", url: "https://mcp.atlassian.com/v1/mcp", dynamic: true },
  { key: "sentry", url: "https://mcp.sentry.dev/mcp", dynamic: true },
  { key: "stripe", url: "https://mcp.stripe.com", dynamic: true },
  { key: "slack", url: "https://mcp.slack.com/mcp", dynamic: false },
  { key: "hubspot", url: "https://mcp.hubspot.com", dynamic: false },
  { key: "asana", url: "https://mcp.asana.com/v2/mcp", dynamic: false },
  {
    key: "cloudflare-api",
    url: "https://mcp.cloudflare.com/mcp",
    dynamic: true,
  },
  { key: "figma", url: "https://mcp.figma.com/mcp", dynamic: true },
];

type UserOAuth = Extract<CatalogueAuth, { kind: "user-oauth" }>;

function userOAuth(key: string): UserOAuth {
  const entry = catalogueEntry(key);
  if (!entry) throw new Error(`Missing catalogue entry ${key}.`);
  if (entry.auth.kind !== "user-oauth") {
    throw new Error(`${key} is not reached as the person asking.`);
  }
  return entry.auth;
}

/** True when `raw` is an https URL with no userinfo, query or fragment. */
function pinnedHttps(raw: string): boolean {
  const url = new URL(raw);
  return (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash
  );
}

describe("the MCP market's second batch", () => {
  test("every key is an entry, once, and Zapier is deliberately not one", () => {
    const keys = CATALOGUE.map((entry) => entry.key);
    for (const { key } of SECOND_BATCH) {
      expect(catalogueEntry(key)).not.toBeNull();
      expect(keys.filter((held) => held === key)).toHaveLength(1);
    }
    expect(new Set(keys).size).toBe(keys.length);
    // Its tools are each person's own Zapier actions, named at runtime: no reviewed list can name
    // them as writes, so the catalogue cannot express it safely.
    expect(catalogueEntry("zapier")).toBeNull();
    expect(resolveServerUrl("zapier")).toBeNull();
  });

  test("each is reached as the person asking, so no deployment credential is taken", () => {
    for (const { key } of SECOND_BATCH) {
      const entry = catalogueEntry(key);
      if (!entry) throw new Error(`Missing catalogue entry ${key}.`);
      expect(entry.auth.kind).toBe("user-oauth");
      expect(serverCredentialKind(entry)).toBeNull();
    }
  });

  test("each pins its OAuth addresses over https, with no query, fragment or userinfo", () => {
    for (const { key } of SECOND_BATCH) {
      const auth = userOAuth(key);
      expect(pinnedHttps(auth.authorizationUrl)).toBe(true);
      expect(pinnedHttps(auth.tokenUrl)).toBe(true);
      if (auth.revokeUrl !== undefined) {
        expect(pinnedHttps(auth.revokeUrl)).toBe(true);
      }
      if (auth.registrationUrl !== undefined) {
        expect(pinnedHttps(auth.registrationUrl)).toBe(true);
      }
      // The shared flow sets these itself; no entry here sends extra consent parameters.
      expect(auth.authorizationParams).toBeUndefined();
      expect(Object.isFrozen(auth.scopes)).toBe(true);
    }
  });

  test("a self-registering vendor names its registration endpoint, and an admin-registered one has none", () => {
    for (const { key, dynamic } of SECOND_BATCH) {
      const auth = userOAuth(key);
      if (dynamic) {
        expect(auth.clientRegistration).toBe("dynamic");
        expect(auth.registrationUrl).toBeString();
      } else {
        // An administrator pastes the client id and secret, as for Baidu.
        expect(auth.clientRegistration).toBeUndefined();
        expect(auth.registrationUrl).toBeUndefined();
      }
    }
  });

  test("the addresses are the ones the vendors' metadata publishes", () => {
    expect(userOAuth("github")).toMatchObject({
      authorizationUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      scopes: [],
    });
    expect(userOAuth("github").revokeUrl).toBeUndefined();
    expect(userOAuth("stripe")).toMatchObject({
      authorizationUrl: "https://access.stripe.com/mcp/oauth2/authorize",
      tokenUrl: "https://access.stripe.com/mcp/oauth2/token",
      revokeUrl: "https://access.stripe.com/mcp/oauth2/revoke",
      registrationUrl: "https://access.stripe.com/mcp/oauth2/register",
      scopes: ["mcp"],
    });
    expect(userOAuth("slack")).toMatchObject({
      authorizationUrl: "https://slack.com/oauth/v2_user/authorize",
      tokenUrl: "https://slack.com/api/oauth.v2.user.access",
    });
    expect(userOAuth("figma")).toMatchObject({
      authorizationUrl: "https://www.figma.com/oauth/mcp",
      tokenUrl: "https://api.figma.com/v1/oauth/token",
      registrationUrl: "https://api.figma.com/v1/oauth/mcp/register",
      scopes: ["mcp:connect"],
    });
    expect(userOAuth("asana").scopes).toEqual(["default"]);
    // Read scopes only where the vendor offers them.
    expect(userOAuth("linear").scopes).toEqual(["read"]);
    expect(userOAuth("sentry").scopes).toEqual(["org:read"]);
    for (const scope of [
      ...userOAuth("slack").scopes,
      ...userOAuth("cloudflare-api").scopes,
    ]) {
      expect(scope).not.toContain("write");
    }
  });

  test("each resolves to the vendor's endpoint, a caller cannot move it, and it passes the static outbound checks", () => {
    for (const { key, url } of SECOND_BATCH) {
      const entry = catalogueEntry(key);
      if (!entry?.host) throw new Error(`Missing pinned host for ${key}.`);
      expect(entry.transport).toBeUndefined();
      expect(entry.hostPattern).toBeUndefined();
      expect(new URL(entry.host).origin).toBe(entry.host);
      expect(resolveServerUrl(key, "https://evil.test")?.url).toBe(url);

      const resolved = resolveServerUrl(key);
      if (!resolved) throw new Error(`${key} did not resolve.`);
      expect(customUrlRefusal(resolved.url)).toBeNull();
      expect(checkOutboundUrl(resolved.url)).toEqual({
        allowed: true,
        url: new URL(resolved.url).toString(),
      });
      // The OAuth addresses are dialled by this deployment too, so they meet the same floor.
      const auth = userOAuth(key);
      for (const address of [
        auth.authorizationUrl,
        auth.tokenUrl,
        auth.revokeUrl,
        auth.registrationUrl,
      ]) {
        if (address === undefined) continue;
        expect(customUrlRefusal(address)).toBeNull();
        expect(checkOutboundUrl(address).allowed).toBe(true);
      }
    }
  });

  test("each consent URL carries S256 PKCE and exactly the entry's own scopes", () => {
    for (const { key } of SECOND_BATCH) {
      const auth = userOAuth(key);
      const consent = new URL(
        authorizationUrlFor({
          auth,
          clientId: "client-1",
          redirectUri: "https://openbot.example/api/plugins/oauth/callback",
          state: "sealed",
          codeChallenge: "challenge",
        }),
      );
      expect(consent.origin + consent.pathname).toBe(auth.authorizationUrl);
      expect(consent.searchParams.get("code_challenge_method")).toBe("S256");
      expect(consent.searchParams.get("scope")).toBe(
        auth.scopes.length > 0 ? auth.scopes.join(" ") : null,
      );
    }
  });

  test("every write list is non-empty, frozen and duplicate-free, and names the money-moving Stripe calls", () => {
    for (const { key } of SECOND_BATCH) {
      const entry = catalogueEntry(key);
      if (!entry) throw new Error(`Missing catalogue entry ${key}.`);
      expect(entry.writeTools.length).toBeGreaterThan(0);
      expect(Object.isFrozen(entry.writeTools)).toBe(true);
      expect(new Set(entry.writeTools).size).toBe(entry.writeTools.length);
    }
    const stripe = catalogueEntry("stripe");
    for (const name of [
      "create_payment_link",
      "create_invoice",
      "finalize_invoice",
      "create_refund",
      "cancel_subscription",
      "update_subscription",
      "update_dispute",
      "create_payment_intent",
      "create_payout",
    ]) {
      expect(stripe?.writeTools).toContain(name);
      // A listed write stays a write even if the vendor records the action as a read.
      expect(classifyTool(stripe, name, true, "read")).toBe("write");
    }
    expect(
      classifyTool(catalogueEntry("cloudflare-api"), "execute", true),
    ).toBe("write");
    expect(
      classifyTool(catalogueEntry("slack"), "slack_send_message", true),
    ).toBe("write");
    // An unadvertised name is a write whatever the list says.
    expect(classifyTool(stripe, "list_customers", false)).toBe("write");
  });

  test("none of them opts into owner assembly", () => {
    for (const { key } of SECOND_BATCH) {
      const entry = catalogueEntry(key);
      expect(entry?.ownerAssembly).toBeUndefined();
      expect(ownerAssemblySource(entry)).toBe(false);
    }
  });
});

/**
 * GitHub's token endpoint answers form-encoded unless the request asks for JSON, which the shared
 * flow would read as no token at all. Both requests that reach a token endpoint ask.
 */
describe("token requests ask for JSON", () => {
  test("the code redemption and the renewal both send Accept: application/json", async () => {
    const accepts: (string | null)[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      accepts.push(new Headers(init?.headers).get("accept"));
      return new Response(
        JSON.stringify({
          access_token: "at-1",
          refresh_token: "rt-1",
          expires_in: 3600,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    try {
      const grant = await redeemAuthorizationCode({
        tokenUrl: "https://github.com/login/oauth/access_token",
        clientId: "c-1",
        clientSecret: "s-1",
        code: "code-1",
        redirectUri: "https://openbot.example/api/plugins/oauth/callback",
        verifier: "verifier-1",
      });
      expect(grant?.refreshToken).toBe("rt-1");
      const token = await exchangeRefreshTokenOverHttp({
        tokenUrl: "https://github.com/login/oauth/access_token",
        client: { clientId: "c-1", clientSecret: "s-1" },
        refreshToken: "rt-1",
      });
      expect(token.accessToken).toBe("at-1");
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(accepts).toEqual(["application/json", "application/json"]);
  });
});

/**
 * The third batch: five mainland servers, each reached with one deployment credential placed where
 * the vendor wants it rather than in a bearer header.
 *
 * Pinned here: which slot each key goes into, that the pinned address is still one an administrator
 * could have typed (the key is not part of it), that the placed request stays on the pinned host and
 * path, that DingTalk's per-customer address cannot leave its prefix, and that nothing in an entry is
 * a credential. The mechanism itself is asserted in plugin-credential-placement.test.ts.
 */
const THIRD_BATCH: readonly {
  key: string;
  auth: "deployment-query" | "deployment-address";
  base: string;
  param: string;
  fixed?: Record<string, string>;
}[] = [
  {
    key: "amap",
    auth: "deployment-query",
    base: "https://mcp.amap.com/mcp",
    param: "key",
  },
  {
    key: "baidu-map",
    auth: "deployment-query",
    base: "https://mcp.map.baidu.com/mcp",
    param: "ak",
  },
  {
    key: "tencent-map",
    auth: "deployment-query",
    base: "https://mcp.map.qq.com/mcp",
    param: "key",
    fixed: { format: "0" },
  },
  {
    key: "kuaidi100",
    auth: "deployment-query",
    base: "https://api.kuaidi100.com/mcp/streamable",
    param: "key",
  },
  {
    key: "dingtalk",
    auth: "deployment-address",
    base: "https://mcp-gw.dingtalk.com/server",
    param: "key",
  },
];

const SAMPLE_KEY = "0123456789abcdef0123456789abcdef";

function entryOf(key: string) {
  const entry = catalogueEntry(key);
  if (!entry) throw new Error(`${key} is not in the catalogue`);
  return entry;
}

function placementOf(key: string) {
  const placement = credentialPlacement(entryOf(key));
  if (!placement) throw new Error(`${key} has no placement`);
  return placement;
}

describe("the MCP market's third batch", () => {
  test("every key is entered once, and Feishu is not entered at all", () => {
    for (const { key } of THIRD_BATCH) {
      expect(CATALOGUE.filter((entry) => entry.key === key)).toHaveLength(1);
    }
    // Its tokens expire within hours; see the batch comment in catalogue.ts.
    for (const absent of ["feishu", "lark"]) {
      expect(catalogueEntry(absent)).toBeNull();
    }
  });

  test("each is a deployment credential in its pinned slot, with Chinese words to ask for it", () => {
    for (const { key, auth, param, fixed } of THIRD_BATCH) {
      const entry = entryOf(key);
      expect(entry.auth.kind).toBe(auth);
      expect(serverCredentialKind(entry)).toBe("mcp");
      expect(ownerAssemblySource(entry)).toBe(false);
      expect(entry.ownerAssembly).toBeUndefined();
      expect(entry.transport).toBeUndefined();
      if (
        entry.auth.kind !== "deployment-query" &&
        entry.auth.kind !== "deployment-address"
      ) {
        throw new Error(`${key} has the wrong auth kind`);
      }
      expect(entry.auth.param).toBe(param);
      if (entry.auth.kind === "deployment-query") {
        expect(entry.auth.fixedParams ?? {}).toEqual(fixed ?? {});
        // A fixed parameter can never be the credential's own slot.
        expect(Object.keys(entry.auth.fixedParams ?? {})).not.toContain(param);
      }
      expect(entry.auth.credentialLabel).toMatch(/[一-鿿]/);
      expect(entry.auth.credentialHint).toMatch(/[一-鿿]/);
      expect(entry.title).toMatch(/[一-鿿]/);
      expect(entry.summary).toMatch(/[一-鿿]/);
    }
    expect(placementOf("amap").label).toBe("高德 Web 服务 Key");
    expect(placementOf("dingtalk").label).toBe("钉钉 MCP 专属地址");
    // Sixteen characters unless the vendor's own format is shorter; Kuaidi100's key is twelve.
    for (const { key } of THIRD_BATCH) {
      expect(placementOf(key).minLength).toBe(key === "kuaidi100" ? 12 : 16);
    }
    expect(
      credentialFormatRefusal(placementOf("kuaidi100"), "ABCDefgh1234"),
    ).toBeNull();
    expect(
      credentialFormatRefusal(placementOf("amap"), "ABCDefgh1234"),
    ).toMatch(/格式不对/);
  });

  test("no entry carries anything that could be a credential", () => {
    for (const { key } of THIRD_BATCH) {
      // Everything but the tool names, which are long camelCase words rather than secrets.
      const { writeTools: _tools, ...rest } = entryOf(key);
      const text = JSON.stringify(rest);
      // A long unbroken run of letters with digits in it is what every one of these vendors' keys is.
      expect(text).not.toMatch(/(?=[A-Za-z0-9]*[0-9])[A-Za-z0-9]{20,}/);
      // DingTalk's hint shows the address's shape, with a placeholder and never a value.
      expect(text).not.toMatch(/[?&](key|ak)=(?!<)/);
    }
  });

  test("the pinned address is a bare https origin and path, and passes the outbound refusals", () => {
    for (const { key, base, fixed } of THIRD_BATCH) {
      const entry = entryOf(key);
      expect(entry.host).not.toBeNull();
      const origin = new URL(entry.host as string);
      expect(origin.protocol).toBe("https:");
      expect(`${origin.origin}`).toBe(entry.host as string);
      // An instance host offered by a caller changes nothing.
      expect(resolveServerUrl(key, "https://evil.example")?.url).toBe(base);
      expect(placementOf(key).base).toBe(base);
      // The address as an administrator would see it, fixed parameters included and no key: the same
      // static refusals a typed URL meets, and the outbound guard's check.
      const shown = new URL(base);
      for (const [name, value] of Object.entries(fixed ?? {})) {
        shown.searchParams.set(name, value);
      }
      expect(customUrlRefusal(shown.href)).toBeNull();
      expect(checkOutboundUrl(shown.href).allowed).toBe(true);
    }
  });

  test("the placed request stays on the pinned host and path, and passes the outbound guard", () => {
    for (const { key, base, param, fixed, auth } of THIRD_BATCH) {
      const placement = placementOf(key);
      const secret =
        auth === "deployment-address"
          ? `${base}/srv-01?key=${SAMPLE_KEY}`
          : SAMPLE_KEY;
      const placed = placeCredential(placement, base, secret);
      const url = new URL(placed.url);
      expect(url.origin).toBe(new URL(base).origin);
      expect(
        auth === "deployment-address"
          ? url.pathname
          : `${url.origin}${url.pathname}`,
      ).toBe(auth === "deployment-address" ? "/server/srv-01" : base);
      expect(url.searchParams.get(param)).toBe(SAMPLE_KEY);
      for (const [name, value] of Object.entries(fixed ?? {})) {
        expect(url.searchParams.get(name)).toBe(value);
      }
      expect(placed.headers).toEqual({});
      expect(checkOutboundUrl(placed.url).allowed).toBe(true);
      // Pointed anywhere else, the key does not go.
      expect(() =>
        placeCredential(placement, "https://evil.example/mcp", secret),
      ).toThrow(CredentialPlacementRefusedError);
    }
  });

  test("without a credential, each refuses in Chinese rather than dialling anonymously", () => {
    for (const { key, base } of THIRD_BATCH) {
      expect(() => placeCredential(placementOf(key), base, undefined)).toThrow(
        /还没有录入「/,
      );
    }
  });

  test("a DingTalk address off its host or prefix is refused, and the refusal does not repeat it", () => {
    const placement = placementOf("dingtalk");
    for (const bad of [
      `https://mcp-gw.dingtalk.com.evil.example/server/srv?key=${SAMPLE_KEY}`,
      `https://evil.example/server/srv?key=${SAMPLE_KEY}`,
      `https://mcp.dingtalk.com/server/srv?key=${SAMPLE_KEY}`,
      `https://mcp-gw.dingtalk.com/admin/srv?key=${SAMPLE_KEY}`,
      `https://mcp-gw.dingtalk.com/server/srv/extra?key=${SAMPLE_KEY}`,
      `https://mcp-gw.dingtalk.com/server/../oapi?key=${SAMPLE_KEY}`,
      `https://mcp-gw.dingtalk.com:444/server/srv?key=${SAMPLE_KEY}`,
      `http://mcp-gw.dingtalk.com/server/srv?key=${SAMPLE_KEY}`,
      `https://mcp-gw.dingtalk.com/server/srv?key=${SAMPLE_KEY}&url=https://evil.example`,
      SAMPLE_KEY,
    ]) {
      const refusal = credentialFormatRefusal(placement, bad);
      expect(refusal).toMatch(/格式不对/);
      expect(refusal).not.toContain(SAMPLE_KEY);
      expect(refusal).not.toContain("evil.example");
      expect(refusal).toContain(
        "https://mcp-gw.dingtalk.com/server/<服务 ID>?key=<密钥>",
      );
    }
    expect(
      credentialFormatRefusal(
        placement,
        `https://mcp-gw.dingtalk.com/server/srv_01-a?key=${SAMPLE_KEY}`,
      ),
    ).toBeNull();
  });

  test("write lists are frozen, unduplicated, and win over whatever a listing records", () => {
    for (const { key } of THIRD_BATCH) {
      const entry = entryOf(key);
      expect(Object.isFrozen(entry.writeTools)).toBe(true);
      expect(new Set(entry.writeTools).size).toBe(entry.writeTools.length);
      for (const tool of entry.writeTools) {
        expect(classifyTool(entry, tool, true, "read")).toBe("write");
      }
    }
    // The lookups each vendor documents stay reads once advertised.
    expect(classifyTool(entryOf("amap"), "maps_geo", true)).toBe("read");
    expect(classifyTool(entryOf("kuaidi100"), "query_trace", true)).toBe(
      "read",
    );
    // Opening ride-hailing, and every DingTalk send, change and recall, are writes.
    expect(entryOf("amap").writeTools).toContain("maps_schema_take_taxi");
    const dingtalk = entryOf("dingtalk").writeTools;
    for (const tool of [
      "sendMessageToGroupByRobot",
      "batchSendMessageToUsersByRobot",
      "sendDINGMessageByRobot",
      "sendNotice",
      "createEvent",
      "updateEvent",
      "deleteEvent",
      "createTask",
      "insertNotableRecords",
      "createReport",
    ]) {
      expect(dingtalk).toContain(tool);
    }
    // And anything never advertised is a write whatever it is called.
    expect(classifyTool(entryOf("baidu-map"), "map_geocode", false)).toBe(
      "write",
    );
  });
});

describe("every placed entry in the catalogue", () => {
  test("pins a host, uses MCP, and names a vendor X- header where it names one", () => {
    for (const entry of CATALOGUE) {
      const placement = credentialPlacement(entry);
      if (!placement) continue;
      expect(entry.host).not.toBeNull();
      expect(entry.transport).toBeUndefined();
      if (placement.kind === "header") {
        expect(placement.header).toMatch(/^X-[A-Za-z0-9-]+$/);
      }
    }
  });
});
