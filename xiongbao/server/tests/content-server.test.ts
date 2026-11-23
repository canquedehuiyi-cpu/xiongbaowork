import { describe, expect, test } from "bun:test";
import type { AgentProfileStore } from "../src/agents/profile-store";
import type { DeploymentConfig } from "../src/config";
import {
  ALLOWED_CACHE_MS,
  appLocation,
  CONTENT_COOKIE,
  createContentServer,
} from "../src/content/server";
import {
  type ContentGrant,
  hostCodeOf,
  issueOpenToken,
  issuePathToken,
  issueSessionToken,
  MAX_SESSION_AGE_MS,
  OPEN_TOKEN_TTL_MS,
  readPathToken,
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

  test("a folder token redirects to /u/<path token>/, never carrying the open token", async () => {
    const { server } = setup();
    const open = issueOpenToken(dirGrant(), KEY);
    const res = await get(server, `http://c/__open/${open}`);
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).not.toContain(open);
    const session = cookieOf(res);
    expect(session).not.toBeNull();
    expect(session).not.toBe(open);
    const pathToken = location.slice("/u/".length, -1);
    // The path token and the cookie are different values with different labels.
    expect(pathToken).not.toBe(session);
    expect(readPathToken(pathToken, KEY, T0)).toEqual(
      dirGrant({ exp: T0 + OPEN_TOKEN_TTL_MS, born: T0 }),
    );
    expect(readSessionToken(pathToken, KEY, T0)).toBeNull();
    expect(readSessionToken(session ?? "", KEY, T0)).toEqual(
      dirGrant({ exp: T0 + OPEN_TOKEN_TTL_MS, born: T0 }),
    );
    expect(readPathToken(session ?? "", KEY, T0)).toBeNull();
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

  test.each(["script", "style", "image", "font", "empty", "worker", "object"])(
    "a %s request through the cookie's root path is 404, a document or iframe is served",
    async (dest) => {
      const { server, cookie } = await opened();
      const headers = { ...asCookie(cookie), "sec-fetch-dest": dest };
      expect((await get(server, "http://c/", headers)).status).toBe(404);
      expect((await get(server, "http://c/app.css", headers)).status).toBe(404);
      for (const ok of ["document", "iframe"]) {
        const res = await get(server, "http://c/", {
          ...asCookie(cookie),
          "sec-fetch-dest": ok,
        });
        expect(res.status).toBe(200);
      }
    },
  );

  test("without Sec-Fetch-Dest (an old browser) only GET and HEAD are answered", async () => {
    const { server, cookie } = await opened();
    expect((await get(server, "http://c/", asCookie(cookie))).status).toBe(200);
    expect(
      (await get(server, "http://c/", asCookie(cookie), "HEAD")).status,
    ).toBe(200);
    expect(
      (await get(server, "http://c/", asCookie(cookie), "POST")).status,
    ).toBe(404);
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

  test("a web app target is not served from files: without a way to forward it is an unavailable answer, never a folder", async () => {
    const { server, cookie } = await opened(undefined, appGrant());
    expect((await get(server, "http://c/", asCookie(cookie))).status).toBe(502);
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
    const t = issuePathToken(dirGrant(), KEY);
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
    const other = issuePathToken(
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
    const t = issuePathToken(dirGrant(), KEY);
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

  test("is checked on every request, not renewed, and cut off once the answer has expired", async () => {
    const { server, asked, state, clock } = setup();
    const t = issuePathToken(dirGrant(), KEY);
    const first = await get(server, `http://c/u/${t}/`);
    expect(first.status).toBe(200);
    expect(first.headers.get("set-cookie")).toBeNull();
    expect(asked.length).toBe(1);
    state.allowed = false;
    // Still inside the minute: the remembered answer stands.
    expect((await get(server, `http://c/u/${t}/app.css`)).status).toBe(200);
    expect(asked.length).toBe(1);
    clock.now = T0 + ALLOWED_CACHE_MS + 1;
    expect((await get(server, `http://c/u/${t}/`)).status).toBe(404);
    expect(asked.length).toBe(2);
  });

  test("a cookie value is no path token, and a path token is no cookie", async () => {
    const { server } = setup();
    const cookieValue = issueSessionToken(dirGrant(), KEY);
    const pathValue = issuePathToken(dirGrant(), KEY);
    expect((await get(server, `http://c/u/${cookieValue}/`)).status).toBe(404);
    const planted = await get(server, "http://c/", asCookie(pathValue));
    expect(planted.status).toBe(404);
    expect(planted.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  describe("an expired page", () => {
    const navigation = { "sec-fetch-dest": "document" };
    const expired = () => issuePathToken(dirGrant({ exp: T0 - 1 }), KEY);
    const later = (clock: { now: number }) => {
      clock.now = T0 + 5 * 60_000;
    };

    test("is continued to a fresh path token when a document navigation carries the same target's cookie", async () => {
      const { server, clock } = setup();
      later(clock);
      const cookie = issueSessionToken(
        dirGrant({ exp: clock.now + 1000 }),
        KEY,
      );
      for (const dest of ["document", "iframe"]) {
        const res = await get(
          server,
          `http://c/u/${expired()}/sub/page.html?x=1`,
          { ...asCookie(cookie), "sec-fetch-dest": dest },
        );
        expect(res.status).toBe(302);
        const location = res.headers.get("location") ?? "";
        const match = /^\/u\/([^/]+)\/sub\/page\.html\?x=1$/.exec(location);
        expect(match).not.toBeNull();
        const grant = readPathToken(match?.[1], KEY, clock.now);
        expect(grant?.target).toEqual({ kind: "dir", path: "site" });
        expect(grant?.exp).toBe(clock.now + OPEN_TOKEN_TTL_MS);
        expect(res.headers.get("set-cookie")).toBeNull();
      }
    });

    test("is 404 for a sub-resource fetch, a missing header, a missing cookie or another method", async () => {
      const { server, clock } = setup();
      later(clock);
      const cookie = issueSessionToken(
        dirGrant({ exp: clock.now + 1000 }),
        KEY,
      );
      const url = `http://c/u/${expired()}/`;
      expect(
        (
          await get(server, url, {
            ...asCookie(cookie),
            "sec-fetch-dest": "image",
          })
        ).status,
      ).toBe(404);
      expect((await get(server, url, asCookie(cookie))).status).toBe(404);
      expect((await get(server, url, navigation)).status).toBe(404);
      expect(
        (await get(server, url, { ...asCookie(cookie), ...navigation }, "POST"))
          .status,
      ).toBe(404);
    });

    test("is 404 when the cookie is another target's, another person's, expired, or not allowed any more", async () => {
      const { server, clock, state } = setup();
      later(clock);
      const url = `http://c/u/${expired()}/`;
      const fresh = (over: Partial<ContentGrant>) =>
        asCookie(
          issueSessionToken(dirGrant({ exp: clock.now + 1000, ...over }), KEY),
        );
      for (const over of [
        { target: { kind: "dir", path: "other" } } as const,
        { person: "p2" },
        { bot: "b2" },
        { seat: "person:p2" },
        { exp: clock.now },
      ]) {
        expect(
          (await get(server, url, { ...fresh(over), ...navigation })).status,
        ).toBe(404);
      }
      state.allowed = false;
      expect(
        (await get(server, url, { ...fresh({}), ...navigation })).status,
      ).toBe(404);
    });

    test("is 404 past the absolute lifetime", async () => {
      const { server, clock } = setup();
      clock.now = T0 + MAX_SESSION_AGE_MS + 1000;
      const cookie = issueSessionToken(
        dirGrant({ born: T0, exp: clock.now + 1000 }),
        KEY,
      );
      const res = await get(server, `http://c/u/${expired()}/`, {
        ...asCookie(cookie),
        ...navigation,
      });
      expect(res.status).toBe(404);
    });

    test("a forged expired token is not continued", async () => {
      const { server, clock } = setup();
      later(clock);
      const cookie = issueSessionToken(
        dirGrant({ exp: clock.now + 1000 }),
        KEY,
      );
      const res = await get(server, `http://c/u/${expired()}x/`, {
        ...asCookie(cookie),
        ...navigation,
      });
      expect(res.status).toBe(404);
    });
  });

  test("HEAD has no body and other methods are 405", async () => {
    const { server } = setup();
    const t = issuePathToken(dirGrant(), KEY);
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

  test("a fresh grant is checked but not reissued", async () => {
    const { server, asked } = setup();
    const res = await get(server, "http://c/", asCookie(cookieFor(dirGrant())));
    expect(res.status).toBe(200);
    expect(asked.length).toBe(1);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  test("past half-life the cookie is reissued for another 30 minutes, keeping its birth", async () => {
    const { server, clock } = setup();
    const old = cookieFor(dirGrant());
    clock.now = T0 + OPEN_TOKEN_TTL_MS / 2 + 1_000;
    const res = await get(server, "http://c/", asCookie(old));
    expect(res.status).toBe(200);
    const renewed = cookieOf(res) ?? "";
    expect(renewed).not.toBe(old);
    const grant = readSessionToken(renewed, KEY, clock.now);
    expect(grant).not.toBeNull();
    expect(grant?.exp).toBe(clock.now + OPEN_TOKEN_TTL_MS);
    expect(grant?.born).toBe(T0);
    expect(grant?.target).toEqual({ kind: "dir", path: "site" });
    expect(res.headers.get("set-cookie")).toContain("HttpOnly");
  });

  test("renewals stop twelve hours after the first issue", async () => {
    const { server, clock } = setup();
    // A session kept alive by renewals for just under twelve hours...
    clock.now = T0 + MAX_SESSION_AGE_MS - 60_000;
    const nearEnd = cookieFor(dirGrant({ born: T0, exp: clock.now + 60_000 }));
    const last = await get(server, "http://c/", asCookie(nearEnd));
    expect(last.status).toBe(200);
    const renewed = readSessionToken(cookieOf(last) ?? "", KEY, clock.now);
    // ...gets a short last one, ending exactly at the cap.
    expect(renewed?.exp).toBe(T0 + MAX_SESSION_AGE_MS);
    // And after the cap there is nothing to renew: the cookie has expired on its own.
    clock.now = T0 + MAX_SESSION_AGE_MS + 1;
    const past = await get(server, "http://c/", asCookie(cookieOf(last) ?? ""));
    expect(past.status).toBe(404);
    // Even a long-lived value (made by some earlier bug) is refused for renewal past the cap.
    const stuck = cookieFor(dirGrant({ born: T0, exp: clock.now + 60_000 }));
    const refused = await get(server, "http://c/", asCookie(stuck));
    expect(refused.status).toBe(404);
    expect(refused.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  test("a person who is no longer allowed gets 404 and the cookie is cleared", async () => {
    const { server, state } = setup();
    const old = cookieFor(dirGrant());
    state.allowed = false;
    const res = await get(server, "http://c/", asCookie(old));
    expect(res.status).toBe(404);
    const cleared = res.headers.get("set-cookie") ?? "";
    expect(cleared).toContain(`${CONTENT_COOKIE}=;`);
    expect(cleared).toContain("Max-Age=0");
    expect(cleared).toContain("HttpOnly");
  });

  test("a person removed after a request is cut off by the first request once the minute is up", async () => {
    const { server, state, clock } = setup();
    const cookie = cookieFor(dirGrant({ exp: T0 + 10 * 60_000 }));
    expect((await get(server, "http://c/", asCookie(cookie))).status).toBe(200);
    state.allowed = false;
    clock.now = T0 + ALLOWED_CACHE_MS - 1;
    expect((await get(server, "http://c/", asCookie(cookie))).status).toBe(200);
    clock.now = T0 + ALLOWED_CACHE_MS + 1;
    const res = await get(server, "http://c/", asCookie(cookie));
    expect(res.status).toBe(404);
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  test("an answer is remembered by the grant, not by the token text, refusals too", async () => {
    const { server, asked, state } = setup({ allowed: false });
    // Two different tokens for the same grant (the birth differs) share one remembered answer.
    const a = cookieFor(dirGrant({ born: T0 - 1 }));
    const b = cookieFor(dirGrant({ born: T0 - 2 }));
    expect((await get(server, "http://c/", asCookie(a))).status).toBe(404);
    expect((await get(server, "http://c/", asCookie(b))).status).toBe(404);
    expect(asked.length).toBe(1);
    state.allowed = true;
    expect((await get(server, "http://c/", asCookie(a))).status).toBe(404);
    // A different grant is a different question.
    const other = cookieFor(
      dirGrant({ target: { kind: "dir", path: "other" } }),
    );
    expect((await get(server, "http://c/", asCookie(other))).status).toBe(200);
    expect(asked.length).toBe(2);
  });

  test.each([
    ["person", { person: "p2" }],
    ["seat", { seat: "person:p2" }],
    ["bot", { bot: "b2" }],
    ["channel", { channel: "c2" }],
    ["run", { run: "r2" }],
    ["task", { task: "t2" }],
    ["target path", { target: { kind: "dir", path: "other" } }],
    ["target kind", { target: { kind: "app", port: 4000, path: "site" } }],
  ] as [string, Partial<ContentGrant>][])(
    "the remembered answer does not carry over when only the %s differs",
    async (_name, difference) => {
      const base = dirGrant({ channel: "c1", run: "r1", task: "t1" });
      const { server, asked, state } = setup();
      expect(
        (await get(server, "http://c/", asCookie(cookieFor(base)))).status,
      ).toBe(200);
      // A is remembered as allowed; B must be asked, and refused, on its own.
      state.allowed = false;
      const other = { ...base, ...difference } as ContentGrant;
      const res = await get(server, "http://c/", asCookie(cookieFor(other)));
      expect(res.status).toBe(404);
      expect(asked.length).toBe(2);
      // And A is still remembered as allowed.
      expect(
        (await get(server, "http://c/", asCookie(cookieFor(base)))).status,
      ).toBe(200);
      expect(asked.length).toBe(2);
    },
  );

  test("concurrent requests for one grant share one lookup", async () => {
    let calls = 0;
    let release: (value: boolean) => void = () => undefined;
    const gate = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    const server = createContentServer({
      key: KEY,
      now: () => T0,
      gateway: {
        serveFile: async () => stream("ok"),
      },
      stillAllowed: () => {
        calls += 1;
        return gate;
      },
    });
    const cookie = asCookie(cookieFor(dirGrant()));
    const pending = [1, 2, 3, 4].map(() => get(server, "http://c/", cookie));
    await Bun.sleep(5);
    expect(calls).toBe(1);
    release(true);
    const answers = await Promise.all(pending);
    expect(answers.map((res) => res.status)).toEqual([200, 200, 200, 200]);
    expect(calls).toBe(1);
  });

  test("the table of remembered answers is bounded, oldest first", async () => {
    let calls = 0;
    const server = createContentServer({
      key: KEY,
      now: () => T0,
      gateway: { serveFile: async () => stream("ok") },
      stillAllowed: async () => {
        calls += 1;
        return true;
      },
    });
    const as = (person: string) => asCookie(cookieFor(dirGrant({ person })));
    for (let i = 0; i < 1005; i += 1)
      await get(server, "http://c/", as(`p${i}`));
    expect(calls).toBe(1005);
    await get(server, "http://c/", as("p1004"));
    expect(calls).toBe(1005);
    await get(server, "http://c/", as("p0"));
    expect(calls).toBe(1006);
  });

  test("a failing lookup is a 502 and is not remembered", async () => {
    let fail = true;
    const server = createContentServer({
      key: KEY,
      now: () => T0,
      gateway: { serveFile: async () => stream("ok") },
      stillAllowed: async () => {
        if (fail) throw new Error("down");
        return true;
      },
    });
    const cookie = asCookie(cookieFor(dirGrant()));
    expect((await get(server, "http://c/", cookie)).status).toBe(502);
    fail = false;
    expect((await get(server, "http://c/", cookie)).status).toBe(200);
  });
});

describe("an app target's location", () => {
  test("only a plain absolute path is taken", () => {
    expect(appLocation("/dash")).toBe("/dash");
    expect(appLocation("/a/b?x=1")).toBe("/a/b?x=1");
    for (const bad of [
      "",
      "dash",
      "//evil.com",
      "\t/evil.com",
      "\t//evil.com",
      "/\\evil.com",
      "/a\nb",
      "/a b",
      "https://evil.com",
      "///x",
    ]) {
      expect(appLocation(bad)).toBe("/");
    }
  });

  test("the redirect from /__open never leaves the origin", async () => {
    const { server } = setup();
    for (const path of ["//evil.com", "\t/evil.com", "evil.com", "/ok"]) {
      const token = issueOpenToken(
        { ...appGrant(), target: { kind: "app", port: 4000, path } },
        KEY,
      );
      const location = (
        await get(server, `http://c/__open/${token}`)
      ).headers.get("location");
      expect(location).toBe(path === "/ok" ? "/ok" : "/");
    }
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
    const pathToken = issuePathToken(grant, KEY);
    expect(
      (await get(server, `https://${otherHost}/__open/${open}`)).status,
    ).toBe(404);
    expect(
      (await get(server, `https://${otherHost}/u/${pathToken}/`)).status,
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
