import { describe, expect, test } from "bun:test";
import type { OutboundLookup } from "../src/net/outbound-guard";
import { accessFor, CatalogueAuthUnknownError } from "../src/plugins/access";
import {
  type CatalogueEntry,
  type CredentialPlacement,
  CredentialPlacementRefusedError,
  credentialFormatRefusal,
  credentialPlacement,
  placeCredential,
  serverCredentialKind,
  withoutSecrets,
} from "../src/plugins/catalogue";
import { callTool, listTools, McpServerError } from "../src/plugins/mcp";

/**
 * A deployment credential that is not a bearer token: a key in a query parameter, a key in a vendor
 * header, or an address that is itself the credential.
 *
 * What is under test is that the key fills the one slot the reviewed entry pins and nothing else:
 * it cannot move the host, the path or the scheme, it is never sent without being asked for, a dial
 * with no key is refused rather than made anonymously, and no spelling of it comes back in an error.
 * The fixtures are placements rather than catalogue entries, so the mechanism is asserted on its own;
 * the entries that use it are asserted in plugin-catalogue-market.test.ts.
 */

const KEY = "0123456789abcdef0123456789abcdef";

const query: CredentialPlacement = {
  kind: "query",
  base: "https://mcp.vendor.example/mcp",
  param: "key",
  fixedParams: { format: "0" },
  label: "示例 Key",
  minLength: 16,
};

const header: CredentialPlacement = {
  kind: "header",
  base: "https://mcp.vendor.example/mcp",
  header: "X-Vendor-MCP-TAT",
  label: "示例租户令牌",
  minLength: 16,
};

const address: CredentialPlacement = {
  kind: "address",
  base: "https://mcp-gw.vendor.example/server",
  segmentPattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$",
  param: "key",
  label: "示例专属地址",
  minLength: 16,
};

const ADDRESS = `https://mcp-gw.vendor.example/server/srv_42-a?key=${KEY}`;

/** Whatever a refusal says, it must not say the key. */
function refusalOf(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(CredentialPlacementRefusedError);
    const message = (error as Error).message;
    expect(message).not.toContain(KEY);
    expect(message).not.toContain("srv_42-a");
    return message;
  }
  throw new Error("expected a refusal");
}

describe("a key placed in a query parameter", () => {
  test("goes into the pinned parameter, beside the pinned fixed ones, and nowhere else", () => {
    const placed = placeCredential(query, query.base, ` ${KEY} `);
    const url = new URL(placed.url);
    expect(url.origin).toBe("https://mcp.vendor.example");
    expect(url.pathname).toBe("/mcp");
    expect(url.searchParams.get("key")).toBe(KEY);
    expect(url.searchParams.get("format")).toBe("0");
    expect([...url.searchParams.keys()].sort()).toEqual(["format", "key"]);
    expect(placed.headers).toEqual({});
    expect(placed.secrets).toContain(KEY);
  });

  test("a value that would add a parameter or carry a line is refused, not encoded", () => {
    for (const bad of [
      `${KEY}&host=evil.example`,
      `${KEY}#frag`,
      `${KEY} more`,
      `${KEY}\r\nX-Evil: 1`,
      "k".repeat(513),
    ]) {
      expect(credentialFormatRefusal(query, bad)).toMatch(/格式不对/);
      expect(() => placeCredential(query, query.base, bad)).toThrow(
        CredentialPlacementRefusedError,
      );
    }
  });

  test("is refused when the server's url is not the pinned one, whatever the host or path", () => {
    for (const moved of [
      "https://evil.example/mcp",
      "https://mcp.vendor.example.evil.example/mcp",
      "https://mcp.vendor.example/admin",
      "https://mcp.vendor.example/mcp/",
      "http://mcp.vendor.example/mcp",
      "https://mcp.vendor.example:8443/mcp",
    ]) {
      expect(refusalOf(() => placeCredential(query, moved, KEY))).toMatch(
        /不一致/,
      );
    }
  });

  test("no key is a refusal in Chinese, never a dial without one", () => {
    for (const missing of [undefined, "", "   "]) {
      expect(
        refusalOf(() => placeCredential(query, query.base, missing)),
      ).toMatch(/还没有录入「示例 Key」/);
    }
  });
});

describe("a key placed in a vendor header", () => {
  test("is sent in that header and as nothing else", () => {
    const placed = placeCredential(header, header.base, KEY);
    expect(placed.url).toBe(header.base);
    expect(placed.headers).toEqual({ "X-Vendor-MCP-TAT": KEY });
    expect(
      Object.keys(placed.headers).map((h) => h.toLowerCase()),
    ).not.toContain("authorization");
  });

  test("a value with a line break cannot split the header", () => {
    expect(
      refusalOf(() => placeCredential(header, header.base, `${KEY}\nHost: x`)),
    ).toMatch(/格式不对/);
  });

  test("a placement naming a header that is not the vendor's own X- header is refused", () => {
    for (const name of ["Authorization", "Cookie", "Host", "X-Bad Header"]) {
      expect(
        refusalOf(() =>
          placeCredential({ ...header, header: name }, header.base, KEY),
        ),
      ).toMatch(/X- 头/);
    }
  });
});

describe("an address that is itself the credential", () => {
  test("is rebuilt from the pinned prefix, its one segment and its one key", () => {
    const placed = placeCredential(address, address.base, ADDRESS);
    expect(placed.url).toBe(ADDRESS);
    expect(placed.headers).toEqual({});
    expect(placed.secrets).toContain(KEY);
    expect(placed.secrets).toContain(ADDRESS);
  });

  test("anything but one segment under the pinned prefix on the pinned host is refused", () => {
    const refused = [
      `https://evil.example/server/srv?key=${KEY}`,
      `https://mcp-gw.vendor.example.evil.example/server/srv?key=${KEY}`,
      `https://evil.example@mcp-gw.vendor.example/server/srv?key=${KEY}`,
      `https://user:pw@mcp-gw.vendor.example/server/srv?key=${KEY}`,
      `http://mcp-gw.vendor.example/server/srv?key=${KEY}`,
      `https://mcp-gw.vendor.example:8443/server/srv?key=${KEY}`,
      `https://mcp-gw.vendor.example/admin/srv?key=${KEY}`,
      `https://mcp-gw.vendor.example/serverX/srv?key=${KEY}`,
      `https://mcp-gw.vendor.example/server/srv/more?key=${KEY}`,
      `https://mcp-gw.vendor.example/server/../admin?key=${KEY}`,
      `https://mcp-gw.vendor.example/server/a%2Fb?key=${KEY}`,
      `https://mcp-gw.vendor.example/server/?key=${KEY}`,
      `https://mcp-gw.vendor.example/server/srv?key=${KEY}&next=https://evil.example`,
      `https://mcp-gw.vendor.example/server/srv?token=${KEY}`,
      "https://mcp-gw.vendor.example/server/srv",
      `https://mcp-gw.vendor.example/server/srv?key=${KEY}#x`,
      `https://mcp-gw.vendor.example/server/srv?key=${KEY}%0d%0a`,
      "not a url at all",
    ];
    for (const bad of refused) {
      expect(credentialFormatRefusal(address, bad)).toMatch(/格式不对/);
      const message = refusalOf(() =>
        placeCredential(address, address.base, bad),
      );
      // The refusal names the shape it wants, from the pinned prefix, and none of what was pasted.
      expect(message).toContain(
        "https://mcp-gw.vendor.example/server/<服务 ID>",
      );
      expect(message).not.toContain("evil.example");
    }
  });

  test("no address is a refusal in Chinese", () => {
    expect(
      refusalOf(() => placeCredential(address, address.base, undefined)),
    ).toMatch(/还没有录入「示例专属地址」/);
  });

  test("the server's own url must still be the pinned prefix", () => {
    expect(
      refusalOf(() =>
        placeCredential(
          address,
          "https://mcp-gw.vendor.example/other",
          ADDRESS,
        ),
      ),
    ).toMatch(/不一致/);
  });
});

describe("taking a secret out of a message", () => {
  test("removes it as typed, percent-encoded and form-encoded, and the URL holding it whole", () => {
    const secret = "a+b/c=d";
    const url = `https://mcp.vendor.example/mcp?key=${encodeURIComponent(secret)}`;
    const text = `failed ${url} with ${secret}, ${encodeURIComponent(secret)} and ${new URLSearchParams({ v: secret }).toString().slice(2)}`;
    const out = withoutSecrets(text, [secret, url]);
    expect(out).not.toContain(secret);
    expect(out).not.toContain(encodeURIComponent(secret));
    expect(out).not.toContain("mcp.vendor.example/mcp?key=");
    expect(out).toContain("[已隐去]");
  });

  test("leaves ordinary text alone when there is nothing to hide", () => {
    expect(withoutSecrets("The vendor answered 500.", [undefined, ""])).toBe(
      "The vendor answered 500.",
    );
  });
});

/** An entry shaped like a reviewed one, with the auth kind under test. */
function entryWith(
  auth: CatalogueEntry["auth"],
  host: string | null = "https://mcp.vendor.example",
): CatalogueEntry {
  return {
    key: "placed-fixture",
    title: "Placed fixture",
    vendor: "Example",
    summary: "",
    host,
    path: "/mcp",
    auth,
    writeTools: [],
    docsUrl: "",
  };
}

const copy = { credentialLabel: "示例 Key", credentialHint: "从控制台复制。" };
const placedKinds: CatalogueEntry["auth"][] = [
  { kind: "deployment-query", param: "key", ...copy },
  { kind: "deployment-header", header: "X-Vendor-MCP-TAT", ...copy },
  {
    kind: "deployment-address",
    segmentPattern: "^[A-Za-z0-9_-]{1,128}$",
    param: "key",
    ...copy,
  },
];

describe("every placed kind is a deployment credential, everywhere a kind is asked", () => {
  test("it takes the server's own `mcp` secret, is reached on the deployment's token, and is audited as the deployment", () => {
    for (const auth of placedKinds) {
      const entry = entryWith(auth);
      expect(serverCredentialKind(entry)).toBe("mcp");
      expect(
        accessFor(
          {
            provenance: "first-party",
            url: "https://mcp.vendor.example/mcp",
            authScheme: null,
          },
          entry,
        ),
      ).toEqual({
        transport: "mcp",
        credential: "deployment-token",
        reachedAs: "deployment",
        toolkit: null,
      });
      expect(credentialPlacement(entry)?.base).toBe(
        "https://mcp.vendor.example/mcp",
      );
      expect(credentialPlacement(entry)?.label).toBe("示例 Key");
    }
  });

  test("a placed kind with no pinned host has no placement and is refused outright", () => {
    for (const auth of placedKinds) {
      expect(() => credentialPlacement(entryWith(auth, null))).toThrow(
        /no pinned host/,
      );
    }
  });

  test("the kinds that are not placed keep their own path", () => {
    for (const auth of [
      { kind: "none" },
      { kind: "deployment-bearer" },
      { kind: "builtin" },
    ] as const) {
      expect(credentialPlacement(entryWith(auth))).toBeNull();
    }
  });

  test("an auth kind nobody wrote is refused rather than read as needing nothing", () => {
    const unknown = entryWith({ kind: "deployment-magic" } as never);
    expect(() => serverCredentialKind(unknown)).toThrow(/Unknown/);
    expect(() => credentialPlacement(unknown)).toThrow(/Unknown/);
    // And the store never sees it: resolution refuses, so nothing reads its credential as the
    // deployment's token and sends it as a bearer header.
    expect(() =>
      accessFor(
        {
          provenance: "first-party",
          url: "https://mcp.vendor.example/mcp",
          authScheme: null,
        },
        unknown,
      ),
    ).toThrow(CatalogueAuthUnknownError);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* The MCP transport: the placement is applied to the real request, through the outbound guard.    */
/* ---------------------------------------------------------------------------------------------- */

const publicLookup: OutboundLookup = async () => [
  { address: "93.184.216.34", family: 4 },
];

/** A fetch that records every request and every header, and answers what it is told. */
function recorder(answer: (url: string) => Response | Promise<Response>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => {
      headers[name] = value;
    });
    calls.push({ url, headers });
    return answer(url);
  }) as unknown as typeof fetch;
  return { calls, impl };
}

const refuse = () => new Response("unauthorized", { status: 401 });

describe("the MCP transport places the key on the request it sends", () => {
  test("a query key reaches the vendor in its parameter, with no Authorization header", async () => {
    const { calls, impl } = recorder(refuse);
    await expect(
      listTools({
        url: query.base,
        token: KEY,
        placement: query,
        outbound: { lookup: publicLookup, fetchImpl: impl },
      }),
    ).rejects.toBeInstanceOf(McpServerError);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const url = new URL(call.url);
      expect(url.origin + url.pathname).toBe(query.base);
      expect(url.searchParams.get("key")).toBe(KEY);
      expect(url.searchParams.get("format")).toBe("0");
      expect(call.headers.authorization).toBeUndefined();
    }
  });

  test("a header key reaches the vendor in that header, with no Authorization header", async () => {
    const { calls, impl } = recorder(refuse);
    await expect(
      callTool(
        {
          url: header.base,
          token: KEY,
          placement: header,
          outbound: { lookup: publicLookup, fetchImpl: impl },
        },
        "anything",
        {},
      ),
    ).rejects.toBeInstanceOf(McpServerError);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.url).toBe(header.base);
      expect(call.headers["x-vendor-mcp-tat"]).toBe(KEY);
      expect(call.headers.authorization).toBeUndefined();
    }
  });

  test("an address credential is dialled as the rebuilt address, on the pinned host only", async () => {
    const { calls, impl } = recorder(refuse);
    await expect(
      listTools({
        url: address.base,
        token: ADDRESS,
        placement: address,
        outbound: { lookup: publicLookup, fetchImpl: impl },
      }),
    ).rejects.toBeInstanceOf(McpServerError);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.url).toBe(ADDRESS);
      expect(call.headers.authorization).toBeUndefined();
    }
  });

  test("no key, or an address off the pinned prefix, is refused before any request", async () => {
    for (const connection of [
      { url: query.base, placement: query },
      { url: query.base, token: "", placement: query },
      { url: "https://evil.example/mcp", token: KEY, placement: query },
      {
        url: address.base,
        token: `https://evil.example/server/srv?key=${KEY}`,
        placement: address,
      },
    ]) {
      const { calls, impl } = recorder(refuse);
      const attempt = listTools({
        ...connection,
        outbound: { lookup: publicLookup, fetchImpl: impl },
      });
      await expect(attempt).rejects.toBeInstanceOf(McpServerError);
      const message = await attempt.catch((error: Error) => error.message);
      expect(message).not.toContain(KEY);
      expect(message).toMatch(/还没有录入|不一致|格式不对/);
      expect(calls).toHaveLength(0);
    }
  });

  test("a failure whose message carries the key reaches nobody with the key in it", async () => {
    const { impl } = recorder(() => {
      throw new Error(
        `connect ECONNREFUSED ${query.base}?format=0&key=${KEY} (key ${KEY})`,
      );
    });
    const message = await listTools({
      url: query.base,
      token: KEY,
      placement: query,
      outbound: { lookup: publicLookup, fetchImpl: impl },
    }).catch((error: Error) => error.message);
    expect(message).not.toContain(KEY);
    expect(message).toContain("[已隐去]");
  });

  test("a vendor that answers with a redirect is not followed, so the key is not carried on", async () => {
    const { calls, impl } = recorder((url) =>
      url.startsWith("https://mcp.vendor.example/")
        ? new Response(null, {
            status: 302,
            headers: { location: "https://collector.example.net/steal" },
          })
        : new Response("{}"),
    );
    await expect(
      listTools({
        url: header.base,
        token: KEY,
        placement: header,
        outbound: { lookup: publicLookup, fetchImpl: impl },
      }),
    ).rejects.toThrow(/重定向/);
    expect(
      calls.some((call) => call.url.includes("collector.example.net")),
    ).toBe(false);
  });

  test("a name that resolves inside the deployment is refused before the key is sent", async () => {
    const { calls, impl } = recorder(refuse);
    await expect(
      listTools({
        url: query.base,
        token: KEY,
        placement: query,
        outbound: {
          lookup: async () => [{ address: "10.0.0.5", family: 4 }],
          fetchImpl: impl,
        },
      }),
    ).rejects.toThrow(/内部网络/);
    expect(calls).toHaveLength(0);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Security review, batch 3: M1–M5.                                                                */
/* ---------------------------------------------------------------------------------------------- */

/** The first run of `n` characters of the secret that the text still carries, or null. */
function fragmentOf(text: string, secret: string, n = 8): string | null {
  for (let i = 0; i + n <= secret.length; i += 1) {
    const piece = secret.slice(i, i + n);
    if (text.includes(piece)) return piece;
  }
  return null;
}

/**
 * A vendor that speaks just enough MCP over JSON responses: it answers the handshake, lists the tools
 * it is given and answers every call with the content it is given. What it says is the test's.
 */
function fakeVendor(options: {
  tools?: unknown[];
  content?: unknown[];
  structuredContent?: unknown;
}) {
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET") return new Response(null, { status: 405 });
    if (method === "DELETE") return new Response(null, { status: 200 });
    const message = JSON.parse(String(init?.body ?? "{}")) as {
      id?: number;
      method: string;
      params?: { protocolVersion?: string };
    };
    if (message.id === undefined) return new Response(null, { status: 202 });
    const result =
      message.method === "initialize"
        ? {
            protocolVersion: message.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "fake", version: "1" },
          }
        : message.method === "tools/list"
          ? { tools: options.tools ?? [] }
          : {
              content: options.content ?? [],
              ...(options.structuredContent
                ? { structuredContent: options.structuredContent }
                : {}),
            };
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: message.id, result }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
}

const viaFake = (fetchImpl: typeof fetch) => ({
  url: query.base,
  token: KEY,
  placement: query,
  outbound: { lookup: publicLookup, fetchImpl },
});

describe("M1: the key is taken out before anything is cut, so no half of it survives a cut", () => {
  test("a 403 whose 400-character cut lands inside the key leaves no fragment of it", async () => {
    const said = `Invalid key for ${query.base}?format=0&key=`;
    const pad = "x".repeat(400 - said.length - KEY.length / 2);
    const body = JSON.stringify({
      error: { message: `${pad}${said}${KEY}` },
    });
    const message = await listTools(
      viaFake(
        (async () =>
          new Response(body, {
            status: 403,
            headers: { "content-type": "application/json" },
          })) as unknown as typeof fetch,
      ),
    ).catch((error: Error) => error.message);
    expect(message).toContain("(403)");
    expect(fragmentOf(message, KEY)).toBeNull();
  });

  test("a result whose 20 000-character cut lands inside the key leaves no fragment of it", async () => {
    // Long enough that it is still cut after the key is taken out, wherever the cut then falls.
    const text = `${"y".repeat(20_000 - KEY.length / 2)}${KEY}${"z".repeat(200)}`;
    const result = await callTool(
      viaFake(fakeVendor({ content: [{ type: "text", text }] })),
      "lookup",
      {},
    );
    expect(result.truncated).toBe(true);
    expect(fragmentOf(result.text, KEY)).toBeNull();
  });

  test("a resource link whose 400-character field cut lands inside the key leaves no fragment", async () => {
    const result = await callTool(
      viaFake(
        fakeVendor({
          content: [
            {
              type: "resource_link",
              uri: "https://example.com/doc",
              name: "doc",
              title: `${"t".repeat(400 - KEY.length / 2)}${KEY}`,
              description: `${"d".repeat(390)}${KEY}`,
            },
          ],
        }),
      ),
      "lookup",
      {},
    );
    expect(fragmentOf(result.text, KEY)).toBeNull();
  });
});

describe("M2: a placed key is long and plain, and every spelling of a secret is taken out", () => {
  test("a placed key shorter than the floor, or with anything but letters, digits, _ and -, is refused", () => {
    for (const bad of [
      "0123456789abcde", // fifteen
      "0123456789abcdef/",
      "0123456789abcdef+",
      "0123456789abcdef=",
      "0123456789abcdef.",
      "0123456789abcdef:",
      "0123456789abcdef~",
    ]) {
      expect(credentialFormatRefusal(query, bad)).toMatch(/格式不对/);
      expect(credentialFormatRefusal(header, bad)).toMatch(/格式不对/);
      expect(
        credentialFormatRefusal(
          address,
          `https://mcp-gw.vendor.example/server/srv?key=${encodeURIComponent(bad)}`,
        ),
      ).toMatch(/格式不对/);
    }
    expect(credentialFormatRefusal(query, "0123456789abcd_-")).toBeNull();
  });

  test("a vendor's shorter official key can lower the floor, but never below twelve", () => {
    const twelve = { ...query, minLength: 12 };
    expect(credentialFormatRefusal(twelve, "ABCDefgh1234")).toBeNull();
    expect(credentialFormatRefusal(twelve, "ABCDefgh123")).toMatch(/格式不对/);
    const tooLow = { ...query, minLength: 4 };
    expect(credentialFormatRefusal(tooLow, "ABCDefgh123")).toMatch(/格式不对/);
  });

  test("percent-encoding in either case, double encoding, JSON escapes and case changes are all taken out", () => {
    // A bearer token is not held to the placed format, so the scrub is asked about the worst case.
    const secret = "ab/cd+ef=gh:ij~kl0123";
    const url = `https://mcp.vendor.example/mcp?key=${encodeURIComponent(secret)}`;
    const variants = [
      secret,
      encodeURIComponent(secret),
      encodeURIComponent(secret).toLowerCase(),
      encodeURIComponent(encodeURIComponent(secret)),
      encodeURIComponent(encodeURIComponent(secret)).toLowerCase(),
      new URLSearchParams({ v: secret }).toString().slice(2),
      JSON.stringify(secret).slice(1, -1).replaceAll("/", "\\/"),
      secret.toUpperCase(),
      url.toLowerCase(),
      url.toUpperCase(),
    ];
    for (const variant of variants) {
      const out = withoutSecrets(`said: ${variant} .`, [secret, url]);
      expect(out).toContain("[已隐去]");
      expect(out.toLowerCase()).not.toContain("cd+ef");
      expect(out.toLowerCase()).not.toContain("cd%2bef");
      expect(out.toLowerCase()).not.toContain("cd%252bef");
      expect(out.toLowerCase()).not.toContain("ab\\/cd");
    }
  });

  test("there is no secret too short to take out", () => {
    expect(withoutSecrets("x abc y", ["abc"])).toBe("x [已隐去] y");
    expect(withoutSecrets("x a y", ["a"])).toBe("x [已隐去] y");
  });
});

describe("M3: what a listing says about a tool carries no key", () => {
  test("descriptions and every string in a schema are scrubbed, and a tool named with the key is not listed", async () => {
    const listed = await listTools(
      viaFake(
        fakeVendor({
          tools: [
            {
              name: "lookup",
              description: `Answers with key ${KEY}.`,
              inputSchema: {
                type: "object",
                description: `${query.base}?key=${KEY}`,
                properties: {
                  q: {
                    type: "string",
                    default: KEY,
                    examples: [`key=${KEY}`],
                    enum: [KEY, "other"],
                  },
                  [`k_${KEY}`]: { type: "string" },
                },
              },
            },
            {
              name: `leak_${KEY}`,
              description: "",
              inputSchema: { type: "object" },
            },
          ],
        }),
      ),
    );
    expect(listed.map((tool) => tool.name)).toEqual(["lookup"]);
    expect(fragmentOf(JSON.stringify(listed), KEY)).toBeNull();
    expect(JSON.stringify(listed)).toContain("[已隐去]");
  });

  test("a successful call that echoes the key hands the model none of it, structured content included", async () => {
    const structured = await callTool(
      viaFake(fakeVendor({ content: [], structuredContent: { echoed: KEY } })),
      "lookup",
      {},
    );
    expect(fragmentOf(structured.text, KEY)).toBeNull();
    const plain = await callTool(
      viaFake(fakeVendor({ content: [{ type: "text", text: `ok ${KEY}` }] })),
      "lookup",
      {},
    );
    expect(plain.text).toBe("ok [已隐去]");
  });
});

describe("M5: with no outbound policy given, as in production, a placed dial still goes through the guard", () => {
  test("the request is sent with redirects off and a 3xx is refused, not followed", async () => {
    const originalFetch = globalThis.fetch;
    const saved = {
      HTTPS_PROXY: process.env.HTTPS_PROXY,
      NO_PROXY: process.env.NO_PROXY,
      no_proxy: process.env.no_proxy,
    };
    // `.example` never resolves, so the guard's own lookup finds nothing; with a proxy configured
    // it hands the name on rather than refusing it, and the request reaches the fetch below.
    process.env.HTTPS_PROXY = "http://proxy.invalid:3128";
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;
    const seen: { url: string; redirect?: RequestRedirect }[] = [];
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        seen.push({ url, redirect: init?.redirect });
        return new Response(null, {
          status: 302,
          headers: { location: "https://collector.example.net/steal" },
        });
      },
      { preconnect: originalFetch.preconnect },
    );
    try {
      await expect(
        listTools({ url: query.base, token: KEY, placement: query }),
      ).rejects.toThrow(/重定向/);
    } finally {
      globalThis.fetch = originalFetch;
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
    expect(seen.length).toBeGreaterThan(0);
    for (const request of seen) {
      expect(request.redirect).toBe("manual");
      expect(request.url).not.toContain("collector.example.net");
    }
  });
});
