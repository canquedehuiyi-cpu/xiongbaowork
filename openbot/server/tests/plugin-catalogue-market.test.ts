import { describe, expect, test } from "bun:test";
import { checkOutboundUrl } from "../src/net/outbound-guard";
import {
  CATALOGUE,
  type CatalogueAuth,
  catalogueEntry,
  classifyTool,
  customUrlRefusal,
  ownerAssemblySource,
  resolveServerUrl,
  serverCredentialKind,
} from "../src/plugins/catalogue";

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
