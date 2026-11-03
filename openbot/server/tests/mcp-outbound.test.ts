import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MCPMock } from "@copilotkit/aimock/mcp";
import type { OutboundLookup } from "../src/net/outbound-guard";
import { callTool, listTools, McpServerError } from "../src/plugins/mcp";

/**
 * A custom MCP server is a URL an administrator typed, and every request to it carries a token.
 *
 * `customUrlRefusal` reads the string when it is stored: https, no literal address, no localhost. It
 * cannot read where the NAME points, and the SDK's default `fetch` follows a redirect with the
 * Authorization header still on it. So a connection marked as tenant-chosen goes out through the
 * outbound guard: every answer the name resolves to must be public, and a redirect is refused rather
 * than followed. A connection without that mark — a catalogue-pinned vendor — dials as it always did,
 * which `mcp-protocol.test.ts` keeps proving against a local mock.
 */

function fakeLookup(table: Record<string, string[]>): OutboundLookup {
  return async (hostname) => {
    const addresses = table[hostname];
    if (!addresses) throw new Error(`ENOTFOUND ${hostname}`);
    return addresses.map((address) => ({
      address,
      family: address.includes(":") ? 6 : 4,
    }));
  };
}

/** A fetch that records every request it is handed, and what Authorization each carried. */
function recorder(answer: (url: string) => Response) {
  const calls: { url: string; authorization: string | null }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    calls.push({
      url,
      authorization: new Headers(init?.headers).get("authorization"),
    });
    return answer(url);
  }) as unknown as typeof fetch;
  return { calls, impl };
}

describe("a custom server whose name resolves inside the deployment", () => {
  for (const inside of ["10.0.0.5", "127.0.0.1"]) {
    test(`is refused before any request (${inside})`, async () => {
      const { calls, impl } = recorder(() => new Response("{}"));
      const connection = {
        url: "https://mcp.vendor.example/mcp",
        token: "tenant-token",
        outbound: {
          lookup: fakeLookup({ "mcp.vendor.example": [inside] }),
          fetchImpl: impl,
        },
      };

      const listing = listTools(connection);
      await expect(listing).rejects.toBeInstanceOf(McpServerError);
      await expect(listing).rejects.toThrow(/inside this deployment's network/);
      await expect(callTool(connection, "anything", {})).rejects.toThrow(
        /inside this deployment's network/,
      );
      expect(calls).toHaveLength(0);
    });
  }
});

describe("a custom server that answers with a redirect", () => {
  test("is not followed, and the token is not sent onward", async () => {
    const { calls, impl } = recorder((url) =>
      url.startsWith("https://mcp.vendor.example/")
        ? new Response(null, {
            status: 302,
            headers: { location: "https://collector.example.net/steal" },
          })
        : new Response("{}"),
    );
    const connection = {
      url: "https://mcp.vendor.example/mcp",
      token: "tenant-token",
      outbound: {
        lookup: fakeLookup({
          "mcp.vendor.example": ["93.184.216.34"],
          "collector.example.net": ["93.184.216.35"],
        }),
        fetchImpl: impl,
      },
    };

    await expect(listTools(connection)).rejects.toThrow(/redirect/i);

    // Only ever the address that was registered; the Location was never requested, so the header
    // never left for it.
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(new URL(call.url).hostname).toBe("mcp.vendor.example");
    }
    expect(
      calls.some((call) => call.url.includes("collector.example.net")),
    ).toBe(false);
  });
});

/**
 * The guard sits under the SDK through its `fetch` option, so a guarded connection to a real MCP
 * server has to still be a working MCP connection. Against the local mock that takes the development
 * opt-in, which is exactly the case the guard exists to make explicit.
 */
describe("a guarded connection that is allowed through", () => {
  const mock = new MCPMock();
  let url = "";

  beforeAll(async () => {
    mock.addTool({
      name: "ping",
      description: "Answers.",
      inputSchema: { type: "object", properties: {} },
    });
    url = await mock.start();
  });

  afterAll(async () => {
    await mock.stop?.();
  });

  test("still speaks MCP through the guarded fetch", async () => {
    const tools = await listTools({
      url,
      outbound: { allowPrivateHosts: true },
    });
    expect(tools.map((tool) => tool.name)).toContain("ping");
  });

  test("is refused when the same local server is not opted into", async () => {
    await expect(listTools({ url, outbound: {} })).rejects.toBeInstanceOf(
      McpServerError,
    );
  });
});
