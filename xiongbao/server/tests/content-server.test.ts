import { describe, expect, test } from "bun:test";
import type { AgentProfileStore } from "../src/agents/profile-store";
import type { DeploymentConfig } from "../src/config";
import { CONTENT_COOKIE, createContentServer } from "../src/content/server";
import {
  type ContentGrant,
  hostCodeOf,
  issueOpenToken,
  issueSessionToken,
  OPEN_TOKEN_TTL_MS,
  readSessionToken,
} from "../src/content/token";
import { startHttpServer } from "../src/http-server";

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const T0 = 1_800_000_000_000;
const SANDBOX = "sandbox allow-scripts allow-forms allow-popups allow-modals";

const dirGrant = (over: Partial<ContentGrant> = {}): ContentGrant => ({
  person: "p1",
  bot: "b1",
  seat: "person:p1",
  target: { kind: "dir", path: "site" },
  exp: T0 + OPEN_TOKEN_TTL_MS,
  ...over,
});
const appGrant = (): ContentGrant => ({
  person: "p1",
  bot: "b1",
  seat: "person:p1",
  target: { kind: "app", port: 4000, path: "dash" },
  exp: T0 + OPEN_TOKEN_TTL_MS,
});

const stream = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  return {
    body: new Response(bytes).body as ReadableStream<Uint8Array>,
    bytes: bytes.length,
  };
};

function setup(
  over: {
    domain?: string;
    allowed?: boolean;
    files?: Record<string, string>;
    clock?: { now: number };
  } = {},
) {
  const asked: ContentGrant[] = [];
  const served: string[] = [];
  const clock = over.clock ?? { now: T0 };
  const files = over.files ?? {
    "site/index.html": "<h1>site</h1>",
    "site/app.css": "body{}",
    "other/index.html": "<h1>other</h1>",
  };
  const state = { allowed: over.allowed ?? true, broken: false };
  const server = createContentServer({
    key: KEY,
    ...(over.domain !== undefined ? { domain: over.domain } : {}),
    now: () => clock.now,
    gateway: {
      serveFile: async (_seat, input) => {
        if (state.broken) throw new Error("the computer is down");
        served.push(input.path);
        const found = files[input.path];
        return found === undefined ? null : stream(found);
      },
    },
    stillAllowed: async (grant) => {
      asked.push(grant);
      return state.allowed;
    },
  });
  return { server, asked, served, state, clock };
}

const get = (
  server: ReturnType<typeof setup>["server"],
  url: string,
  headers: Record<string, string> = {},
  method = "GET",
) => server.fetch(new Request(url, { method, headers }));

/** The cookie's value from a response's Set-Cookie, or null. */
function cookieOf(res: Response): string | null {
  const header = res.headers.get("set-cookie");
  const match = header
    ? new RegExp(`${CONTENT_COOKIE}=([^;]*)`).exec(header)
    : null;
  return match ? (match[1] ?? null) : null;
}
const asCookie = (value: string) => ({ cookie: `${CONTENT_COOKIE}=${value}` });

describe("/__open", () => {
  test("an app token sets an HttpOnly cookie and redirects to the target root without the token", async () => {
    const { server } = setup();
    const token = issueOpenToken(
      { ...appGrant(), target: { kind: "app", port: 4000, path: "" } },
      KEY,
    );
    const res = await get(server, `http://c/__open/${token}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("set-cookie")).toMatch(/xb_content=.*HttpOnly/);
    expect(res.headers.get("location")).toBe("/");
  });

  test("a folder token redirects to /u/<session token>/, never carrying the open token", async () => {
    const { server } = setup();
    const open = issueOpenToken(dirGrant(), KEY);
    const res = await get(server, `http://c/__open/${open}`);
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).not.toContain(open);
    const session = cookieOf(res);
    expect(session).not.toBeNull();
    expect(session).not.toBe(open);
    expect(location).toBe(`/u/${session}/`);
    expect(readSessionToken(session ?? "", KEY, T0)).toEqual(
      dirGrant({ exp: T0 + OPEN_TOKEN_TTL_MS }),
    );
  });

  test("the cookie is host-only, HttpOnly, Lax and Path=/, Secure only over https", async () => {
    const { server } = setup();
    const open = issueOpenToken(dirGrant(), KEY);
    const http =
      (await get(server, `http://c/__open/${open}`)).headers.get(
        "set-cookie",
      ) ?? "";
    expect(http).toContain("HttpOnly");
    expect(http).toContain("Path=/");
    expect(http).toContain("SameSite=Lax");
    expect(http).not.toContain("Secure");
    expect(http).not.toMatch(/domain=/i);
    const https =
      (await get(server, `https://c/__open/${open}`)).headers.get(
        "set-cookie",
      ) ?? "";
    expect(https).toContain("Secure");
    expect(https).not.toMatch(/domain=/i);
  });

  test("the response is not stored and does not leak a referrer", async () => {
    const { server } = setup();
    const res = await get(
      server,
      `http://c/__open/${issueOpenToken(dirGrant(), KEY)}`,
    );
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  test("expired, forged, truncated and wrong-label tokens are 404 with no cookie", async () => {
    const { server, clock } = setup();
    const good = issueOpenToken(dirGrant(), KEY);
    const cases = [
      `${good}x`,
      `x${good}`,
      good.slice(0, -3),
      "garbage",
      issueSessionToken(dirGrant(), KEY),
      issueOpenToken(dirGrant(), `${KEY}different`),
    ];
    for (const token of cases) {
      const res = await get(server, `http://c/__open/${token}`);
      expect(res.status).toBe(404);
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    clock.now = T0 + OPEN_TOKEN_TTL_MS;
    expect((await get(server, `http://c/__open/${good}`)).status).toBe(404);
  });

  test("a link whose person is no longer allowed is 404 and sets no cookie", async () => {
    const { server, asked } = setup({ allowed: false });
    const res = await get(
      server,
      `http://c/__open/${issueOpenToken(dirGrant(), KEY)}`,
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(asked.length).toBe(1);
  });

  test("only GET opens", async () => {
    const { server } = setup();
    const res = await get(
      server,
      `http://c/__open/${issueOpenToken(dirGrant(), KEY)}`,
      {},
      "POST",
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});

describe("the cookie's target", () => {
  async function opened(
    over?: Parameters<typeof setup>[0],
    grant = dirGrant(),
  ) {
    const s = setup(over);
    const res = await get(
      s.server,
      `http://c/__open/${issueOpenToken(grant, KEY)}`,
    );
    return { ...s, cookie: cookieOf(res) ?? "" };
  }

  test("the root and any path follow the cookie's folder, with the sandbox headers", async () => {
    const { server, cookie } = await opened();
    const root = await get(server, "http://c/", asCookie(cookie));
    expect(root.status).toBe(200);
    expect(await root.text()).toBe("<h1>site</h1>");
    expect(root.headers.get("content-security-policy")).toBe(SANDBOX);
    expect(root.headers.get("referrer-policy")).toBe("no-referrer");
    const css = await get(server, "http://c/app.css", asCookie(cookie));
    expect(await css.text()).toBe("body{}");
  });

  test("no cookie is 404", async () => {
    const { server } = setup();
    const res = await get(server, "http://c/");
    expect(res.status).toBe(404);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  test("another application's cookie is no credential: not read, not cleared, not answered", async () => {
    const { server, cookie } = await opened();
    const app = "session=abc123; __Host-sid=zzz";
    const alone = await get(server, "http://c/", { cookie: app });
    expect(alone.status).toBe(404);
    expect(alone.headers.get("set-cookie")).toBeNull();
    const mixed = await get(server, "http://c/", {
      cookie: `${app}; ${CONTENT_COOKIE}=${cookie}`,
    });
    expect(mixed.status).toBe(200);
    // Nothing of the application's cookie comes back in any header.
    for (const [, value] of mixed.headers)
      expect(value).not.toContain("abc123");
    // A cookie whose name merely ends the same way is not the content cookie.
    const lookalike = await get(server, "http://c/", {
      cookie: `x${CONTENT_COOKIE}=${cookie}; ${CONTENT_COOKIE}x=${cookie}`,
    });
    expect(lookalike.status).toBe(404);
  });

  test("an expired or forged cookie is 404 and is cleared", async () => {
    const { server, clock, cookie } = await opened();
    const forged = await get(server, "http://c/", asCookie(`${cookie}x`));
    expect(forged.status).toBe(404);
    expect(forged.headers.get("set-cookie")).toContain("Max-Age=0");
    clock.now = T0 + OPEN_TOKEN_TTL_MS + 1;
    expect((await get(server, "http://c/", asCookie(cookie))).status).toBe(404);
  });

  test("the one-time link is not a cookie, and the cookie is not a link", async () => {
    const { server, cookie } = await opened();
    const open = issueOpenToken(dirGrant(), KEY);
    expect((await get(server, "http://c/", asCookie(open))).status).toBe(404);
    expect((await get(server, `http://c/__open/${cookie}`)).status).toBe(404);
  });

  test("a hidden folder or a path that leaves the folder is 404", async () => {
    const { server, cookie } = await opened();
    for (const path of [
      "/.env",
      "/../other/index.html",
      "/%2e%2e/other/index.html",
      "/a%5c..%5cb",
    ]) {
      expect(
        (await get(server, `http://c${path}`, asCookie(cookie))).status,
      ).toBe(404);
    }
  });

  test("a web app target answers nothing yet", async () => {
    const { server, cookie } = await opened(undefined, appGrant());
    expect((await get(server, "http://c/", asCookie(cookie))).status).toBe(404);
  });

  test("a second open replaces the first: the cookie is the latest target", async () => {
    const s = setup();
    const first =
      cookieOf(
        await get(
          s.server,
          `http://c/__open/${issueOpenToken(dirGrant(), KEY)}`,
        ),
      ) ?? "";
    const second =
      cookieOf(
        await get(
          s.server,
          `http://c/__open/${issueOpenToken(dirGrant({ target: { kind: "dir", path: "other" } }), KEY)}`,
        ),
      ) ?? "";
    // The browser keeps the newer value for the one cookie name.
    expect(
      await (await get(s.server, "http://c/", asCookie(first))).text(),
    ).toBe("<h1>site</h1>");
    expect(
      await (await get(s.server, "http://c/", asCookie(second))).text(),
    ).toBe("<h1>other</h1>");
  });

  test("a failing computer is a bare 502", async () => {
    const { server, cookie, state } = await opened();
    state.broken = true;
    const res = await get(server, "http://c/", asCookie(cookie));
    expect(res.status).toBe(502);
    expect(await res.text()).toBe("Unavailable");
  });
});

describe("/u/<token>/", () => {
  test("serves the folder named by the token in the path, without any cookie", async () => {
    const { server } = setup();
    const t = issueSessionToken(dirGrant(), KEY);
    const res = await get(server, `http://c/u/${t}/app.css`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("body{}");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("content-security-policy")).toBe(SANDBOX);
    expect(await (await get(server, `http://c/u/${t}/`)).text()).toBe(
      "<h1>site</h1>",
    );
  });

  test("the token in the path wins over a cookie with a different target, each verified by itself", async () => {
    const { server } = setup();
    const site = issueSessionToken(dirGrant(), KEY);
    const other = issueSessionToken(
      dirGrant({ target: { kind: "dir", path: "other" } }),
      KEY,
    );
    const res = await get(server, `http://c/u/${other}/`, asCookie(site));
    expect(await res.text()).toBe("<h1>other</h1>");
    // A bad path token is not rescued by a good cookie.
    const bad = await get(server, `http://c/u/${other}x/`, asCookie(site));
    expect(bad.status).toBe(404);
    expect(bad.headers.get("set-cookie")).toBeNull();
  });

  test("expired, tampered, one-time-link and malformed path tokens are 404", async () => {
    const { server, clock } = setup();
    const t = issueSessionToken(dirGrant(), KEY);
    for (const path of [
      `/u/${t}x/`,
      `/u/${issueOpenToken(dirGrant(), KEY)}/`,
      "/u/garbage/",
      `/u/${t}`,
      "/u//index.html",
      "/u/",
    ]) {
      expect((await get(server, `http://c${path}`)).status).toBe(404);
    }
    clock.now = T0 + OPEN_TOKEN_TTL_MS;
    expect((await get(server, `http://c/u/${t}/`)).status).toBe(404);
  });

  test("does not renew or set a cookie, and is cut off past half-life when no longer allowed", async () => {
    const { server, asked, state, clock } = setup();
    const t = issueSessionToken(dirGrant(), KEY);
    const early = await get(server, `http://c/u/${t}/`);
    expect(early.headers.get("set-cookie")).toBeNull();
    expect(asked.length).toBe(0);
    clock.now = T0 + OPEN_TOKEN_TTL_MS / 2 + 1;
    const late = await get(server, `http://c/u/${t}/`);
    expect(late.status).toBe(200);
    expect(late.headers.get("set-cookie")).toBeNull();
    expect(asked.length).toBe(1);
    state.allowed = false;
    expect((await get(server, `http://c/u/${t}/`)).status).toBe(404);
  });

  test("HEAD has no body and other methods are 405", async () => {
    const { server } = setup();
    const t = issueSessionToken(dirGrant(), KEY);
    const head = await get(server, `http://c/u/${t}/`, {}, "HEAD");
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect((await get(server, `http://c/u/${t}/`, {}, "DELETE")).status).toBe(
      405,
    );
  });
});

describe("renewal and revocation", () => {
  const cookieFor = (grant: ContentGrant) => issueSessionToken(grant, KEY);

  test("a fresh grant is not asked about and not reissued", async () => {
    const { server, asked } = setup();
    const res = await get(server, "http://c/", asCookie(cookieFor(dirGrant())));
    expect(res.status).toBe(200);
    expect(asked.length).toBe(0);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  test("past half-life it is checked, and the cookie is reissued for another 30 minutes", async () => {
    const { server, asked, clock } = setup();
    const old = cookieFor(dirGrant());
    clock.now = T0 + OPEN_TOKEN_TTL_MS / 2 + 1_000;
    const res = await get(server, "http://c/", asCookie(old));
    expect(res.status).toBe(200);
    expect(asked.length).toBe(1);
    const renewed = cookieOf(res) ?? "";
    expect(renewed).not.toBe(old);
    const grant = readSessionToken(renewed, KEY, clock.now);
    expect(grant).not.toBeNull();
    expect(grant?.exp).toBe(clock.now + OPEN_TOKEN_TTL_MS);
    expect(grant?.target).toEqual({ kind: "dir", path: "site" });
    expect(res.headers.get("set-cookie")).toContain("HttpOnly");
  });

  test("a person who is no longer allowed gets 404 and the cookie is cleared", async () => {
    const { server, state, clock } = setup();
    const old = cookieFor(dirGrant());
    state.allowed = false;
    clock.now = T0 + OPEN_TOKEN_TTL_MS / 2 + 1_000;
    const res = await get(server, "http://c/", asCookie(old));
    expect(res.status).toBe(404);
    const cleared = res.headers.get("set-cookie") ?? "";
    expect(cleared).toContain(`${CONTENT_COOKIE}=;`);
    expect(cleared).toContain("Max-Age=0");
    expect(cleared).toContain("HttpOnly");
  });
});

describe("domain mode", () => {
  const DOMAIN = "apps.example.com";
  const grant = dirGrant();
  const host = `${hostCodeOf(grant)}.${DOMAIN}`;
  const otherHost = `${hostCodeOf(dirGrant({ target: { kind: "dir", path: "other" } }))}.${DOMAIN}`;

  test("the link opens on the grant's own subdomain, with a host-only Secure cookie", async () => {
    const { server } = setup({ domain: DOMAIN });
    const res = await get(
      server,
      `http://${host}/__open/${issueOpenToken(grant, KEY)}`,
    );
    expect(res.status).toBe(302);
    const header = res.headers.get("set-cookie") ?? "";
    expect(header).toContain("Secure");
    expect(header).toContain("HttpOnly");
    expect(header).not.toMatch(/domain=/i);
    const session = cookieOf(res) ?? "";
    const page = await get(server, `https://${host}/`, asCookie(session));
    expect(await page.text()).toBe("<h1>site</h1>");
  });

  test("a subdomain that is not the grant's code is 404 for the link, the path token and the cookie", async () => {
    const { server } = setup({ domain: DOMAIN });
    const open = issueOpenToken(grant, KEY);
    const session = issueSessionToken(grant, KEY);
    expect(
      (await get(server, `https://${otherHost}/__open/${open}`)).status,
    ).toBe(404);
    expect(
      (await get(server, `https://${otherHost}/u/${session}/`)).status,
    ).toBe(404);
    expect(
      (await get(server, `https://${otherHost}/`, asCookie(session))).status,
    ).toBe(404);
  });

  test("a host outside the content domain, or with extra labels, is 404", async () => {
    const { server } = setup({ domain: DOMAIN });
    const open = issueOpenToken(grant, KEY);
    for (const bad of [
      "apps.example.com",
      "evil.com",
      `${host}.evil.com`,
      `x.${host}`,
      `${hostCodeOf(grant)}apps.example.com`,
    ]) {
      expect((await get(server, `https://${bad}/__open/${open}`)).status).toBe(
        404,
      );
    }
  });

  test("in port mode the host is not part of the check", async () => {
    const { server } = setup();
    const res = await get(
      server,
      `http://anything.test:3773/__open/${issueOpenToken(grant, KEY)}`,
    );
    expect(res.status).toBe(302);
  });
});

describe("front door", () => {
  const freePort = () => {
    const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
    const port = probe.port ?? 0;
    probe.stop(true);
    return port;
  };
  const reached = (label: string) => ({
    fetch: async () => new Response(label),
  });
  const config = (content: { port?: number; domain?: string }) =>
    ({ content }) as unknown as DeploymentConfig;
  const door = (
    content: { port?: number; domain?: string },
    port: number,
    withContent = true,
  ) =>
    startHttpServer({
      port,
      config: config(content),
      resolveRequestActor: async () => ({ id: "u", name: "u", role: "user" }),
      agentProfileStore: {} as unknown as AgentProfileStore,
      computerGateway: undefined,
      app: { fetch: () => new Response("the app") },
      ...(withContent ? { content: reached("the content server") } : {}),
    });

  test("port mode: a second listener answers only the content server; the main one only the app", async () => {
    const main = freePort();
    const content = freePort();
    const server = door({ port: content }, main);
    try {
      expect(await (await fetch(`http://127.0.0.1:${content}/x`)).text()).toBe(
        "the content server",
      );
      expect(await (await fetch(`http://127.0.0.1:${main}/x`)).text()).toBe(
        "the app",
      );
    } finally {
      await server.stop(true);
    }
    // Stopping the front door stops both listeners.
    await expect(fetch(`http://127.0.0.1:${content}/x`)).rejects.toThrow();
  });

  test("no content port, no second listener", async () => {
    const main = freePort();
    const server = door({}, main);
    try {
      expect(await (await fetch(`http://127.0.0.1:${main}/x`)).text()).toBe(
        "the app",
      );
    } finally {
      await server.stop(true);
    }
  });

  test("domain mode: a host under the content domain is the content server's, any other is the app's, and no second listener is started", async () => {
    const main = freePort();
    const spare = freePort();
    const server = door({ domain: "apps.example.com", port: spare }, main);
    try {
      const to = async (host: string) =>
        (
          await fetch(`http://127.0.0.1:${main}/x`, { headers: { host } })
        ).text();
      expect(await to("0123456789abcdef.apps.example.com")).toBe(
        "the content server",
      );
      expect(await to("0123456789ABCDEF.Apps.Example.com:8443")).toBe(
        "the content server",
      );
      expect(await to("apps.example.com")).toBe("the app");
      expect(await to("evilapps.example.com")).toBe("the app");
      expect(await to("apps.example.com.evil.test")).toBe("the app");
      expect(await to("localhost")).toBe("the app");
      await expect(fetch(`http://127.0.0.1:${spare}/x`)).rejects.toThrow();
    } finally {
      await server.stop(true);
    }
  });
});
