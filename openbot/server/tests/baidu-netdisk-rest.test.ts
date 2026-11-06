import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { accessFor } from "../src/plugins/access";
import { callTool, listTools } from "../src/plugins/baidu-netdisk-rest";
import {
  catalogueEntry,
  classifyTool,
  resolveServerUrl,
} from "../src/plugins/catalogue";
import { MAX_RESULT_CHARS } from "../src/plugins/mcp";
import {
  authorizationUrlFor,
  redeemAuthorizationCode,
  redirectUriFor,
} from "../src/plugins/oauth";
import { exchangeRefreshTokenOverHttp } from "../src/plugins/store";
import { transportFor } from "../src/plugins/transport";

/**
 * The Baidu Netdisk connector, asserted against a local fake of Baidu rather than Baidu.
 *
 * A real `Bun.serve` on 127.0.0.1 stands in for `pan.baidu.com`, `openapi.baidu.com` and the `dlink`
 * download host, so what is under test is what actually crosses the wire: the token in the query,
 * the `User-Agent` Baidu insists on, the redirect from a `dlink` to its CDN, and the shapes of
 * Baidu's answers, including the HTTP 200 that carries a refusal in `errno`.
 *
 * Anything that tries to leave for a host other than the fake is recorded and refused, and the
 * ledger is asserted empty after every test, as the Drive suite does.
 */

const TOKEN = "baidu-test-token";
/** Above 2^53, so a `JSON.parse` that rounded it would send Baidu a different file's id. */
const BIG_ID = "9007199254740993";

type Seen = {
  path: string;
  query: URLSearchParams;
  userAgent: string | null;
  method: string;
  body: string;
};

let seen: Seen[] = [];
let server: ReturnType<typeof Bun.serve>;
let origin = "";
let api = "";
/** What `filemetas` answers next, set per test. */
let metas: Record<string, unknown> = { errno: 0, list: [] };
/** What the CDN serves for `/cdn/file`, set per test. */
let cdnBody = "";
/** What `/file/dl` redirects to, set per test. Null serves the file directly. */
let dlinkRedirect: string | null = "/cdn/file?sign=abc";
/** What the token endpoint answers, set per test. */
let tokenAnswer: { status: number; body: unknown } = {
  status: 200,
  body: {},
};

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      seen.push({
        path: url.pathname,
        query: url.searchParams,
        userAgent: request.headers.get("user-agent"),
        method: request.method,
        body: request.method === "POST" ? await request.text() : "",
      });
      const json = (body: unknown, status = 200) =>
        new Response(typeof body === "string" ? body : JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });

      if (url.pathname === "/oauth/2.0/token") {
        return json(tokenAnswer.body, tokenAnswer.status);
      }
      if (url.pathname === "/rest/2.0/xpan/nas") {
        return json({
          errno: 0,
          baidu_name: "熊宝测试",
          netdisk_name: "xiongbao_pan",
          vip_type: 2,
          uk: 1234,
        });
      }
      if (url.pathname === "/rest/2.0/xpan/file") {
        const method = url.searchParams.get("method");
        if (url.searchParams.get("key") === "errno") {
          return json({ errno: -6, request_id: 1 });
        }
        if (url.searchParams.get("key") === "boom") {
          return json("<html>oops</html>", 500);
        }
        if (url.searchParams.get("key") === "nothing") {
          return json({ errno: 0, list: [], has_more: 0 });
        }
        // The raw digits, as Baidu sends an fs_id: an unquoted integer.
        const list = `[{"fs_id":${BIG_ID},"path":"/工作/周报.md","server_filename":"周报.md","size":120,"server_mtime":1700000000,"isdir":0,"category":4},{"fs_id":42,"path":"/工作/资料","server_filename":"资料","size":0,"server_mtime":1700000100,"isdir":1,"category":6}]`;
        return json(
          `{"errno":0,"method":"${method}","list":${list},"has_more":0}`,
        );
      }
      if (url.pathname === "/rest/2.0/xpan/multimedia") {
        return json(metas);
      }
      if (url.pathname === "/file/dl") {
        if (dlinkRedirect === null) return new Response(cdnBody);
        return new Response(null, {
          status: 302,
          headers: { location: dlinkRedirect },
        });
      }
      if (url.pathname === "/cdn/file") {
        // Baidu's CDN refuses a download without its agent.
        if (request.headers.get("user-agent") !== "pan.baidu.com") {
          return new Response("forbidden", { status: 403 });
        }
        return new Response(cdnBody, {
          headers: { "content-type": "application/octet-stream" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
  api = `${origin}/rest/2.0/xpan`;
});

afterAll(() => {
  server.stop(true);
});

const realFetch = globalThis.fetch;
let escaped: string[] = [];

beforeEach(() => {
  seen = [];
  escaped = [];
  metas = { errno: 0, list: [] };
  cdnBody = "";
  dlinkRedirect = "/cdn/file?sign=abc";
  tokenAnswer = { status: 200, body: {} };
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const target = new URL(
      input instanceof Request ? input.url : String(input),
    );
    // Only the fake, on loopback; anything else would be Baidu itself.
    if (target.hostname !== "127.0.0.1") {
      escaped.push(target.origin);
      throw new Error(`escaped to ${target.origin}`);
    }
    return realFetch(input, init);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  expect(escaped).toEqual([]);
});

const connection = () => ({ url: api, token: TOKEN });

describe("the catalogue entry", () => {
  const entry = catalogueEntry("baidu-netdisk");

  test("is Baidu's xpan API, reached as the person asking", () => {
    expect(entry).not.toBeNull();
    expect(entry?.title).toBe("百度网盘");
    expect(entry?.vendor).toBe("百度");
    expect(entry?.transport).toBe("baidu-netdisk-rest");
    expect(resolveServerUrl("baidu-netdisk")?.url).toBe(
      "https://pan.baidu.com/rest/2.0/xpan",
    );
    // A pinned host: a caller-supplied instance host changes nothing.
    expect(resolveServerUrl("baidu-netdisk", "https://evil.test")?.url).toBe(
      "https://pan.baidu.com/rest/2.0/xpan",
    );
  });

  test("pins Baidu's OAuth endpoints and the documented scope", () => {
    expect(entry?.auth).toMatchObject({
      kind: "user-oauth",
      authorizationUrl: "https://openapi.baidu.com/oauth/2.0/authorize",
      tokenUrl: "https://openapi.baidu.com/oauth/2.0/token",
      scopes: ["basic,netdisk"],
    });
    if (entry?.auth.kind !== "user-oauth") throw new Error("not user-oauth");
    expect(entry.auth.revokeUrl.startsWith("https://openapi.baidu.com/")).toBe(
      true,
    );
    // An administrator pastes the AppKey and SecretKey; nothing registers itself.
    expect(entry.auth.clientRegistration).toBeUndefined();
    // Google's parameters are Google's.
    expect(entry.auth.authorizationParams).not.toHaveProperty("access_type");
    expect(entry.auth.authorizationParams).not.toHaveProperty("prompt");
  });

  test("resolves to this adapter, and every tool it offers reads", async () => {
    expect(
      transportFor(
        accessFor(
          { provenance: "first-party", url: "https://pan.baidu.com" },
          entry,
        ).transport,
      ).callTool,
    ).toBe(callTool);
    const tools = await listTools({ url: api });
    expect(tools.map((tool) => tool.name)).toEqual([
      "search_files",
      "list_files",
      "get_file_metadata",
      "read_file_content",
      "get_account_info",
    ]);
    for (const tool of tools) {
      expect(classifyTool(entry, tool.name, true)).toBe("read");
      expect(entry?.writeTools).not.toContain(tool.name);
    }
    // The listing is this code: no request is made for it.
    expect(seen).toEqual([]);
    // A write Baidu's scope would allow stays a write if it is ever advertised.
    expect(classifyTool(entry, "delete_file", true)).toBe("write");
  });
});

describe("the consent flow against Baidu", () => {
  const entry = catalogueEntry("baidu-netdisk");
  if (entry?.auth.kind !== "user-oauth") throw new Error("not user-oauth");
  const auth = entry.auth;

  test("the authorization URL carries what Baidu reads", () => {
    const redirectUri = redirectUriFor("https://xiongbao.example/");
    const url = new URL(
      authorizationUrlFor({
        auth,
        clientId: "app-key",
        redirectUri,
        state: "sealed-state",
        codeChallenge: "challenge",
      }),
    );
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://openapi.baidu.com/oauth/2.0/authorize",
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("app-key");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://xiongbao.example/api/plugins/oauth/callback",
    );
    // Exactly the value Baidu's netdisk documentation fixes, comma and all.
    expect(url.searchParams.get("scope")).toBe("basic,netdisk");
    expect(url.searchParams.get("state")).toBe("sealed-state");
    expect(url.searchParams.get("display")).toBe("page");
    // Sent for every vendor; Baidu ignores parameters it does not define.
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  test("a code is redeemed with Baidu's form fields and Baidu's answer is read", async () => {
    tokenAnswer = {
      status: 200,
      body: {
        expires_in: 2592000,
        refresh_token: "baidu-refresh",
        access_token: "baidu-access",
        session_secret: "",
        session_key: "",
        scope: "basic netdisk",
      },
    };
    const grant = await redeemAuthorizationCode({
      tokenUrl: `${origin}/oauth/2.0/token`,
      clientId: "app-key",
      clientSecret: "secret-key",
      code: "the-code",
      redirectUri: "https://xiongbao.example/api/plugins/oauth/callback",
      verifier: "v".repeat(64),
    });
    expect(grant).toEqual({
      refreshToken: "baidu-refresh",
      scope: "basic netdisk",
    });
    const form = new URLSearchParams(seen[0]?.body);
    expect(seen[0]?.method).toBe("POST");
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("the-code");
    expect(form.get("client_id")).toBe("app-key");
    expect(form.get("client_secret")).toBe("secret-key");
    expect(form.get("redirect_uri")).toBe(
      "https://xiongbao.example/api/plugins/oauth/callback",
    );
  });

  test("Baidu's refusal of a code is a refusal, not a throw", async () => {
    tokenAnswer = {
      status: 400,
      body: {
        error: "invalid_grant",
        error_description: "Invalid authorization code",
      },
    };
    expect(
      await redeemAuthorizationCode({
        tokenUrl: `${origin}/oauth/2.0/token`,
        clientId: "app-key",
        clientSecret: "secret-key",
        code: "stale",
        redirectUri: "https://xiongbao.example/api/plugins/oauth/callback",
        verifier: "v".repeat(64),
      }),
    ).toBeNull();
  });

  test("a refresh is Baidu's refresh_token grant, and Baidu's rotated token is kept", async () => {
    tokenAnswer = {
      status: 200,
      body: {
        expires_in: 2592000,
        refresh_token: "baidu-refresh-2",
        access_token: "baidu-access-2",
        scope: "basic netdisk",
      },
    };
    const renewed = await exchangeRefreshTokenOverHttp({
      tokenUrl: `${origin}/oauth/2.0/token`,
      client: { clientId: "app-key", clientSecret: "secret-key" },
      refreshToken: "baidu-refresh",
    });
    expect(renewed).toEqual({
      accessToken: "baidu-access-2",
      expiresInSeconds: 2592000,
      refreshToken: "baidu-refresh-2",
    });
    const form = new URLSearchParams(seen[0]?.body);
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("baidu-refresh");
    expect(form.get("client_id")).toBe("app-key");
    expect(form.get("client_secret")).toBe("secret-key");
  });
});

describe("searching and listing", () => {
  test("search sends the token and the term in the query, and keeps a large id exact", async () => {
    const result = await callTool(connection(), "search_files", {
      query: "周报",
    });
    expect(result.isError).toBe(false);
    expect(seen).toHaveLength(1);
    const request = seen[0];
    expect(request?.path).toBe("/rest/2.0/xpan/file");
    expect(request?.query.get("method")).toBe("search");
    expect(request?.query.get("key")).toBe("周报");
    expect(request?.query.get("recursion")).toBe("1");
    expect(request?.query.get("dir")).toBe("/");
    expect(request?.query.get("access_token")).toBe(TOKEN);
    expect(request?.userAgent).toBe("pan.baidu.com");
    expect(result.text).toContain(`id: ${BIG_ID}`);
    expect(result.text).toContain("/工作/周报.md");
    expect(result.text).toContain("modified 2023-11-14T22:13:20.000Z");
    expect(result.text).toContain("资料/");
    expect(result.text).toContain(
      `https://pan.baidu.com/disk/main#/index?category=all&path=${encodeURIComponent("/工作")}`,
    );
    // The answer never quotes the address it was fetched from.
    expect(result.text).not.toContain(TOKEN);
  });

  test("search needs a term, and a folder must be an absolute path", async () => {
    expect((await callTool(connection(), "search_files", {})).isError).toBe(
      true,
    );
    const relative = await callTool(connection(), "search_files", {
      query: "x",
      dir: "工作",
    });
    expect(relative.isError).toBe(true);
    expect(seen).toEqual([]);
  });

  test("a search that matched nothing says so in words", async () => {
    const result = await callTool(connection(), "search_files", {
      query: "nothing",
    });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("Nothing was found");
  });

  test("list asks Baidu for one folder, newest first", async () => {
    const result = await callTool(connection(), "list_files", { dir: "/工作" });
    expect(result.isError).toBe(false);
    const request = seen[0];
    expect(request?.query.get("method")).toBe("list");
    expect(request?.query.get("dir")).toBe("/工作");
    expect(request?.query.get("order")).toBe("time");
    expect(request?.query.get("desc")).toBe("1");
    expect(request?.query.get("access_token")).toBe(TOKEN);
  });

  test("account info names the Baidu account", async () => {
    const result = await callTool(connection(), "get_account_info", {});
    expect(result.isError).toBe(false);
    expect(seen[0]?.path).toBe("/rest/2.0/xpan/nas");
    expect(seen[0]?.query.get("method")).toBe("uinfo");
    expect(result.text).toContain("百度账号：熊宝测试");
    expect(result.text).toContain("超级会员");
  });
});

describe("errors", () => {
  test("a refusal carried in errno on an HTTP 200 is an error, said in words", async () => {
    const result = await callTool(connection(), "search_files", {
      query: "errno",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("errno -6");
    expect(result.text).toContain("重新连接百度网盘");
    expect(result.text).not.toContain(TOKEN);
  });

  test("an HTTP failure with a body that is not JSON names the status", async () => {
    const result = await callTool(connection(), "search_files", {
      query: "boom",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("500");
    expect(result.text).not.toContain(TOKEN);
  });

  test("no token is refused before anything is sent", async () => {
    const result = await callTool({ url: api }, "list_files", {});
    expect(result.isError).toBe(true);
    expect(seen).toEqual([]);
  });

  test("an unreachable Baidu is an error that does not quote the token-bearing address", async () => {
    // A port that was just freed, so nothing answers on it.
    const closed = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(),
    });
    const port = closed.port;
    closed.stop(true);
    const result = await callTool(
      { url: `http://127.0.0.1:${port}/rest/2.0/xpan`, token: TOKEN },
      "list_files",
      {},
    );
    expect(result.isError).toBe(true);
    expect(result.text).toContain("百度网盘");
    expect(result.text).not.toContain(TOKEN);
  });

  test("a tool this connector does not implement is refused, not guessed at", async () => {
    const result = await callTool(connection(), "delete_file", { fileId: "1" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("delete_file");
    expect(seen).toEqual([]);
  });

  test("a file id must be Baidu's digits", async () => {
    const result = await callTool(connection(), "read_file_content", {
      fileId: "../etc",
    });
    expect(result.isError).toBe(true);
    expect(seen).toEqual([]);
  });
});

describe("reading a file", () => {
  const dlinkFor = (path = "/file/dl") => `${origin}${path}?fid=1-2-3&rt=pr`;

  test("metadata asks filemetas for exactly the id given, without a download address", async () => {
    metas = {
      errno: 0,
      list: [
        {
          fs_id: BIG_ID,
          filename: "周报.md",
          path: "/工作/周报.md",
          size: 120,
          isdir: 0,
        },
      ],
    };
    const result = await callTool(connection(), "get_file_metadata", {
      fileId: BIG_ID,
    });
    expect(result.isError).toBe(false);
    expect(seen[0]?.path).toBe("/rest/2.0/xpan/multimedia");
    expect(seen[0]?.query.get("method")).toBe("filemetas");
    expect(seen[0]?.query.get("fsids")).toBe(`[${BIG_ID}]`);
    expect(seen[0]?.query.get("dlink")).toBe("0");
    expect(result.text).toContain("周报.md");
    expect(result.text).toContain("120 bytes");
  });

  test("a text file is downloaded through its dlink with Baidu's agent, and the token stays on Baidu's hop", async () => {
    metas = {
      errno: 0,
      list: [
        {
          fs_id: BIG_ID,
          filename: "周报.md",
          path: "/工作/周报.md",
          isdir: 0,
          dlink: dlinkFor(),
        },
      ],
    };
    cdnBody = "# 本周\n完成了百度网盘连接器。";
    const result = await callTool(connection(), "read_file_content", {
      fileId: BIG_ID,
    });
    expect(result.isError).toBe(false);
    expect(result.text).toBe("周报.md\n\n# 本周\n完成了百度网盘连接器。");

    const [metasCall, dl, cdn] = seen;
    expect(metasCall?.query.get("dlink")).toBe("1");
    expect(dl?.path).toBe("/file/dl");
    expect(dl?.userAgent).toBe("pan.baidu.com");
    expect(dl?.query.get("access_token")).toBe(TOKEN);
    expect(dl?.query.get("fid")).toBe("1-2-3");
    // The redirect target authorises by its own signature: the token is not carried there.
    expect(cdn?.path).toBe("/cdn/file");
    expect(cdn?.userAgent).toBe("pan.baidu.com");
    expect(cdn?.query.has("access_token")).toBe(false);
    expect(cdn?.query.get("sign")).toBe("abc");
  });

  test("a file longer than a result can hold is cut, and says so", async () => {
    metas = {
      errno: 0,
      list: [{ fs_id: "7", filename: "big.log", isdir: 0, dlink: dlinkFor() }],
    };
    cdnBody = "x".repeat(MAX_RESULT_CHARS * 3);
    const result = await callTool(connection(), "read_file_content", {
      fileId: "7",
    });
    expect(result.isError).toBe(false);
    expect(result.truncated).toBe(true);
    expect(result.text).toContain("[truncated: the file is longer than this]");
    expect(result.text.length).toBeLessThan(MAX_RESULT_CHARS + 200);
  });

  test("a file that is not text returns its metadata and is never downloaded", async () => {
    metas = {
      errno: 0,
      list: [
        {
          fs_id: "8",
          filename: "合同.pdf",
          path: "/工作/合同.pdf",
          size: 2048,
          isdir: 0,
          dlink: dlinkFor(),
        },
      ],
    };
    const result = await callTool(connection(), "read_file_content", {
      fileId: "8",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("合同.pdf");
    expect(result.text).toContain("2048 bytes");
    expect(seen.map((request) => request.path)).toEqual([
      "/rest/2.0/xpan/multimedia",
    ]);
  });

  test("a folder is not read as a file", async () => {
    metas = { errno: 0, list: [{ fs_id: "9", filename: "资料", isdir: 1 }] };
    const result = await callTool(connection(), "read_file_content", {
      fileId: "9",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("文件夹");
  });

  test("a dlink on a host that is not Baidu's is never fetched", async () => {
    metas = {
      errno: 0,
      list: [
        {
          fs_id: "10",
          filename: "a.txt",
          isdir: 0,
          dlink: "https://evil.test/file?x=1",
        },
      ],
    };
    const result = await callTool(connection(), "read_file_content", {
      fileId: "10",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("凭据未被转发");
    expect(seen).toHaveLength(1);
  });

  test("a dlink that redirects off Baidu's hosts is not followed", async () => {
    metas = {
      errno: 0,
      list: [{ fs_id: "11", filename: "a.txt", isdir: 0, dlink: dlinkFor() }],
    };
    dlinkRedirect = "https://evil.test/steal";
    const result = await callTool(connection(), "read_file_content", {
      fileId: "11",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("没有跟随");
    expect(seen.map((request) => request.path)).toEqual([
      "/rest/2.0/xpan/multimedia",
      "/file/dl",
    ]);
  });

  test("a file Baidu does not have is said in words", async () => {
    metas = { errno: -9 };
    const result = await callTool(connection(), "read_file_content", {
      fileId: "12",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("找不到");
  });
});
