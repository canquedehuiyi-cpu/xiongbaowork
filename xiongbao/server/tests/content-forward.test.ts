import { afterEach, describe, expect, test } from "bun:test";
import type { BaseEvent } from "@ag-ui/client";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { TURN_ARTIFACTS_EVENT } from "../../shared/turn-artifacts";
import type { AuditEventInput, AuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import {
  type ArtifactAccessDeps,
  deliveredAppsOf,
} from "../src/computer/artifact-access";
import { personSeat } from "../src/computer/computer-key";
import { createContentAccess } from "../src/content/access";
import {
  createRateLimiter,
  FORWARD_RATE_PER_MINUTE,
  FORWARD_RATE_PER_SEAT_PER_MINUTE,
  programRequestHeaders,
  programResponse,
  programSocketHeaders,
  rewrittenLocation,
} from "../src/content/forward";
import { createOpenRoutes } from "../src/content/open-routes";
import {
  type AppSocketData,
  CONTENT_COOKIE,
  type ContentServerDeps,
  createContentServer,
} from "../src/content/server";
import {
  type ContentGrant,
  hostCodeOf,
  issueSessionToken,
  MAX_SESSION_AGE_MS,
  OPEN_TOKEN_TTL_MS,
} from "../src/content/token";

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const T0 = 1_800_000_000_000;

const appGrant = (over: Partial<ContentGrant> = {}): ContentGrant => ({
  person: "p1",
  bot: "b1",
  seat: "person:p1",
  target: { kind: "app", port: 4000, path: "/" },
  exp: T0 + OPEN_TOKEN_TTL_MS,
  ...over,
});
const dirGrant = (): ContentGrant => ({
  person: "p1",
  bot: "b1",
  seat: "person:p1",
  target: { kind: "dir", path: "site" },
  exp: T0 + OPEN_TOKEN_TTL_MS,
});
const cookieFor = (grant: ContentGrant) =>
  `${CONTENT_COOKIE}=${issueSessionToken(grant, KEY)}`;

type Seen = {
  port: number;
  method: string;
  path: string;
  headers: Headers;
  body: string;
};

/** A content server whose computer answers with whatever `program` returns, recording what it was sent. */
function setup(
  over: {
    domain?: string;
    program?: (seen: Seen) => Response | Promise<Response>;
    allowed?: boolean;
    clock?: { now: number };
    socketUrl?: () => string;
    recheckMs?: number;
  } = {},
) {
  const clock = over.clock ?? { now: T0 };
  const seen: Seen[] = [];
  const sockets: { port: number; path: string }[] = [];
  const state = { allowed: over.allowed ?? true };
  const asked: ContentGrant[] = [];
  const deps: ContentServerDeps = {
    key: KEY,
    ...(over.domain !== undefined ? { domain: over.domain } : {}),
    now: () => clock.now,
    ...(over.recheckMs !== undefined
      ? { socketRecheckMs: over.recheckMs }
      : {}),
    gateway: {
      serveFile: async () => null,
      forwardHttp: async (_seat, input) => {
        const record: Seen = {
          port: input.port,
          method: input.method,
          path: input.path,
          headers: input.headers,
          body: input.body ? await new Response(input.body).text() : "",
        };
        seen.push(record);
        return over.program ? over.program(record) : new Response("from app");
      },
      forwardSocket: async (_seat, port, path) => {
        sockets.push({ port, path });
        return {
          url: over.socketUrl ? over.socketUrl() : "ws://127.0.0.1:1/never",
          headers: { "x-xiongbao-computer-token": "secret" },
        };
      },
    },
    stillAllowed: async (grant) => {
      asked.push(grant);
      return state.allowed;
    },
  };
  return {
    server: createContentServer(deps),
    seen,
    sockets,
    state,
    clock,
    asked,
  };
}

const call = (
  server: ReturnType<typeof setup>["server"],
  url: string,
  init: RequestInit & { headers?: Record<string, string> } = {},
) => server.fetch(new Request(url, init));

const withCookie = (
  grant: ContentGrant,
  extra: Record<string, string> = {},
) => ({
  headers: { cookie: cookieFor(grant), ...extra },
});

describe("what the program is sent", () => {
  test("none of the person's credentials reach it: no cookie at all, no Authorization, no proxy or seat headers", async () => {
    const { server, seen } = setup();
    const res = await call(server, "http://c/api/items?x=1", {
      method: "POST",
      body: "payload",
      headers: {
        cookie: `${cookieFor(appGrant())}; session=main-app-session; theme=dark`,
        authorization: "Bearer secret",
        "proxy-authorization": "Basic zzz",
        "x-forwarded-for": "9.9.9.9",
        "x-forwarded-host": "evil.test",
        forwarded: "for=9.9.9.9",
        "x-real-ip": "9.9.9.9",
        "x-xiongbao-person-id": "someone-else",
        "x-xiongbao-bot-id": "other-bot",
        "x-old-person-id": "someone-else",
        "x-api-key": "kept",
        "content-type": "text/plain",
      },
    });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    const sent = seen[0];
    expect(sent?.method).toBe("POST");
    expect(sent?.path).toBe("/api/items?x=1");
    expect(sent?.port).toBe(4000);
    expect(sent?.body).toBe("payload");
    const names = [...(sent?.headers.keys() ?? [])].sort();
    expect(names).toEqual(["accept-encoding", "content-type", "x-api-key"]);
    expect(sent?.headers.get("x-api-key")).toBe("kept");
  });

  test("domain mode sends the program's own cookies and never the content cookie; port mode sends none", async () => {
    const code = hostCodeOf(appGrant());
    const headers = {
      cookie: `${cookieFor(appGrant())}; sid=program-1; theme=dark`,
    };
    const domain = setup({ domain: "apps.example.com" });
    await call(domain.server, `http://${code}.apps.example.com/x`, { headers });
    expect(domain.seen[0]?.headers.get("cookie")).toBe(
      "sid=program-1; theme=dark",
    );
    const only = setup({ domain: "apps.example.com" });
    await call(only.server, `http://${code}.apps.example.com/x`, {
      headers: { cookie: cookieFor(appGrant()) },
    });
    expect(only.seen[0]?.headers.has("cookie")).toBe(false);
    const port = setup();
    await call(port.server, "http://c/x", { headers });
    expect(port.seen[0]?.headers.has("cookie")).toBe(false);
  });

  test("Host is never sent, and Origin and Referer, when present, become the program's own origin", () => {
    const rewritten = programRequestHeaders(
      new Headers({
        host: "c.example:3774",
        origin: "https://c.example:3774",
        referer: "https://c.example:3774/page?q=1",
      }),
      4000,
    );
    expect(rewritten.has("host")).toBe(false);
    expect(rewritten.get("origin")).toBe("http://127.0.0.1:4000");
    expect(rewritten.get("referer")).toBe("http://127.0.0.1:4000/page?q=1");
    const bare = programRequestHeaders(new Headers({ host: "c" }), 4000);
    expect(bare.has("origin")).toBe(false);
    expect(bare.has("referer")).toBe(false);
  });

  test("a request to a program whose body is read as it is sent reaches it intact, and GET carries none", async () => {
    const { server, seen } = setup();
    await call(server, "http://c/a", {
      method: "PUT",
      body: "x".repeat(5000),
      ...withCookie(appGrant()),
    });
    await call(server, "http://c/b", withCookie(appGrant()));
    expect(seen[0]?.body).toBe("x".repeat(5000));
    expect(seen[1]?.body).toBe("");
  });

  test("a path that could leave the program's host is refused before it is forwarded", async () => {
    const { server, seen } = setup();
    const res = await call(
      server,
      "http://c//evil.test/x",
      withCookie(appGrant()),
    );
    expect(res.status).toBe(400);
    expect(seen).toEqual([]);
  });

  test("a method outside the usual set is 405", async () => {
    const { server, seen } = setup();
    const res = await call(server, "http://c/x", {
      method: "PROPFIND",
      ...withCookie(appGrant()),
    });
    expect(res.status).toBe(405);
    expect(seen).toEqual([]);
  });
});

describe("what the person gets back", () => {
  const program =
    (headers: [string, string][], status = 200, body = "ok") =>
    () => {
      const out = new Headers();
      for (const [name, value] of headers) out.append(name, value);
      return new Response(body, { status, headers: out });
    };

  test("port mode: every Set-Cookie of the program is dropped", async () => {
    const { server } = setup({
      program: program([
        ["set-cookie", "sid=1; Path=/"],
        ["set-cookie", "xb_content=forged; Path=/"],
      ]),
    });
    const res = await call(server, "http://c/", withCookie(appGrant()));
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  test("domain mode: cookies stay but become host-only, and the content cookie's name is never written by a program", async () => {
    const code = hostCodeOf(appGrant());
    const { server } = setup({
      domain: "apps.example.com",
      program: program([
        ["set-cookie", "sid=1; Domain=apps.example.com; Path=/; HttpOnly"],
        ["set-cookie", "theme=dark; domain=.example.com; Max-Age=60"],
        ["set-cookie", "xb_content=forged; Path=/"],
        ["set-cookie", "plain=1"],
      ]),
    });
    const res = await call(
      server,
      `http://${code}.apps.example.com/`,
      withCookie(appGrant()),
    );
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual([
      "sid=1; Path=/; HttpOnly",
      "theme=dark; Max-Age=60",
      "plain=1",
    ]);
  });

  test("transport rules the program could set for the whole host are dropped", async () => {
    const { server } = setup({
      program: program([
        ["strict-transport-security", "max-age=63072000"],
        ["clear-site-data", '"cookies"'],
        ["alt-svc", 'h3=":443"'],
        ["x-app", "kept"],
      ]),
    });
    const res = await call(server, "http://c/", withCookie(appGrant()));
    expect(res.headers.get("strict-transport-security")).toBeNull();
    expect(res.headers.get("clear-site-data")).toBeNull();
    expect(res.headers.get("alt-svc")).toBeNull();
    expect(res.headers.get("x-app")).toBe("kept");
  });

  test("nosniff and no-referrer are added; the program's own policies are kept and no sandbox is imposed", async () => {
    const { server } = setup({
      program: program([["content-security-policy", "default-src 'self'"]]),
    });
    const res = await call(server, "http://c/", withCookie(appGrant()));
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("content-security-policy")).toBe(
      "default-src 'self'",
    );
    const bare = setup();
    const plain = await call(bare.server, "http://c/", withCookie(appGrant()));
    expect(plain.headers.get("content-security-policy")).toBeNull();
  });

  test("a body fetch has already decoded no longer claims its encoding or length", async () => {
    const { server } = setup({
      program: program([
        ["content-encoding", "gzip"],
        ["content-length", "20"],
      ]),
    });
    const res = await call(server, "http://c/", withCookie(appGrant()));
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("content-length")).not.toBe("20");
    expect(await res.text()).toBe("ok");
  });

  test("Bun's fetch decodes gzip, deflate and zstd bodies and leaves Content-Encoding, which is why those are dropped", async () => {
    const text = "hello ".repeat(300);
    const bodies: Record<string, Uint8Array> = {
      gzip: Bun.gzipSync(Buffer.from(text)),
      deflate: Bun.deflateSync(Buffer.from(text)),
      zstd: Bun.zstdCompressSync(Buffer.from(text)),
    };
    const upstream = Bun.serve({
      port: 0,
      fetch(request) {
        const kind = new URL(request.url).pathname.slice(1);
        return new Response(Buffer.from(bodies[kind] ?? ""), {
          headers: { "content-encoding": kind },
        });
      },
    });
    try {
      for (const kind of Object.keys(bodies)) {
        const fetched = await fetch(
          `http://127.0.0.1:${upstream.port}/${kind}`,
        );
        const answered = programResponse(fetched, {
          port: 4000,
          domainMode: false,
          contentCookie: CONTENT_COOKIE,
        });
        expect(answered.headers.get("content-encoding")).toBeNull();
        expect(await answered.text()).toBe(text);
      }
    } finally {
      upstream.stop(true);
    }
  });

  test("a redirect to the program itself, or a relative one, becomes a path and query on this origin", async () => {
    for (const [from, to] of [
      ["/next?a=1", "/next?a=1"],
      ["next", "/next"],
      ["http://127.0.0.1:4000/a?b=1#frag", "/a?b=1#frag"],
      ["/page#top", "/page#top"],
      ["http://localhost:4000/x", "/x"],
      ["http://127.0.0.1:4000//evil.test/p", "/evil.test/p"],
    ] as const) {
      const { server } = setup({
        program: program([["location", from]], 302, ""),
      });
      const res = await call(server, "http://c/", withCookie(appGrant()));
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(to);
    }
  });

  test("a redirect to any other host is removed and the answer is 502", async () => {
    for (const to of [
      "https://evil.test/",
      "http://127.0.0.1:5000/",
      "http://localhost/",
      "//evil.test/x",
      "http://[::1]:4000/",
      "javascript:alert(1)",
    ]) {
      const { server } = setup({
        program: program([["location", to]], 302, ""),
      });
      const res = await call(server, "http://c/", withCookie(appGrant()));
      expect(res.status).toBe(502);
      expect(res.headers.get("location")).toBeNull();
    }
  });

  test("rewrittenLocation keeps only the path of the program's own address", () => {
    expect(rewrittenLocation("http://127.0.0.1:4000/", 4000)).toBe("/");
    expect(rewrittenLocation("http://127.0.0.1:4001/", 4000)).toBeNull();
  });

  test("a program the computer cannot reach is 502 and says nothing more", async () => {
    const { server } = setup({
      program: () => {
        throw new Error("down");
      },
    });
    const res = await call(server, "http://c/", withCookie(appGrant()));
    expect(res.status).toBe(502);
    expect(await res.text()).toBe("Unavailable");
  });
});

describe("who may reach the program", () => {
  test("every kind of request of an app target goes through with the cookie alone, unlike a folder's", async () => {
    const { server, seen } = setup();
    for (const dest of [
      "script",
      "style",
      "image",
      "empty",
      "document",
      "font",
    ]) {
      const res = await call(server, `http://c/${dest}`, {
        headers: { ...withCookie(appGrant()).headers, "sec-fetch-dest": dest },
      });
      expect(res.status).toBe(200);
    }
    const posted = await call(server, "http://c/api", {
      method: "POST",
      body: "{}",
      headers: { ...withCookie(appGrant()).headers, "sec-fetch-dest": "empty" },
    });
    expect(posted.status).toBe(200);
    expect(seen).toHaveLength(7);

    // The same subresource request of a folder target is not answered.
    const folder = await call(server, "http://c/a.js", {
      headers: {
        ...withCookie(dirGrant()).headers,
        "sec-fetch-dest": "script",
      },
    });
    expect(folder.status).toBe(404);
    expect(seen).toHaveLength(7);
  });

  test("a program's own /u/ routes work, and the open-link prefix stays ours", async () => {
    const { server, seen } = setup();
    expect(
      (await call(server, "http://c/u/profile/edit", withCookie(appGrant())))
        .status,
    ).toBe(200);
    expect(
      (await call(server, "http://c/u", withCookie(appGrant()))).status,
    ).toBe(200);
    expect(seen.map((one) => one.path)).toEqual(["/u/profile/edit", "/u"]);
    expect(
      (await call(server, "http://c/__open/a/b", withCookie(appGrant())))
        .status,
    ).toBe(404);
    expect(seen).toHaveLength(2);
  });

  test("no cookie, a forged cookie or an expired one reaches nothing", async () => {
    const { server, seen, clock } = setup();
    expect((await call(server, "http://c/")).status).toBe(404);
    const forged = await call(server, "http://c/", {
      headers: { cookie: `${CONTENT_COOKIE}=nope` },
    });
    expect(forged.status).toBe(404);
    clock.now = T0 + OPEN_TOKEN_TTL_MS + 1;
    expect(
      (await call(server, "http://c/", withCookie(appGrant()))).status,
    ).toBe(404);
    expect(seen).toEqual([]);
  });

  test("a person no longer allowed is refused with the cookie cleared, and the program is not asked", async () => {
    const { server, seen, state } = setup();
    expect(
      (await call(server, "http://c/", withCookie(appGrant()))).status,
    ).toBe(200);
    state.allowed = false;
    const later = setup({ allowed: false });
    const res = await call(later.server, "http://c/", withCookie(appGrant()));
    expect(res.status).toBe(404);
    expect(res.headers.get("set-cookie")).toMatch(/xb_content=; Max-Age=0/);
    expect(later.seen).toEqual([]);
    expect(seen).toHaveLength(1);
  });

  test("in domain mode a cookie only works on the host its grant hashes to", async () => {
    const { server, seen } = setup({ domain: "apps.example.com" });
    const res = await call(
      server,
      "http://0123456789abcdef.apps.example.com/",
      withCookie(appGrant()),
    );
    expect(res.status).toBe(404);
    expect(seen).toEqual([]);
  });

  test("a deployment without forwarding answers 502, not an error page", async () => {
    const server = createContentServer({
      key: KEY,
      now: () => T0,
      gateway: { serveFile: async () => null },
      stillAllowed: async () => true,
    });
    const res = await server.fetch(
      new Request("http://c/", withCookie(appGrant())),
    );
    expect(res.status).toBe(502);
  });
});

describe("the rate limit, per employee", () => {
  test("the 601st request in a minute is 429, with when to retry; another employee is unaffected", async () => {
    const { server, seen } = setup();
    const mine = withCookie(appGrant());
    for (let i = 0; i < FORWARD_RATE_PER_MINUTE; i += 1) {
      const res = await call(server, "http://c/x", mine);
      expect(res.status).toBe(200);
    }
    const over = await call(server, "http://c/x", mine);
    expect(over.status).toBe(429);
    expect(Number(over.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(seen).toHaveLength(FORWARD_RATE_PER_MINUTE);
    const other = await call(
      server,
      "http://c/x",
      withCookie(appGrant({ bot: "b2" })),
    );
    expect(other.status).toBe(200);
  });

  test("one person's flood does not use up what another person of the same employee is allowed", async () => {
    const { server } = setup();
    for (let i = 0; i < FORWARD_RATE_PER_MINUTE; i += 1) {
      await call(server, "http://c/x", withCookie(appGrant({ person: "p1" })));
    }
    const flooded = await call(
      server,
      "http://c/x",
      withCookie(appGrant({ person: "p1" })),
    );
    expect(flooded.status).toBe(429);
    const second = await call(
      server,
      "http://c/x",
      withCookie(appGrant({ person: "p2" })),
    );
    expect(second.status).toBe(200);
  });

  test("all the people of one employee together are held to the per-employee total", async () => {
    const { server } = setup();
    const people = FORWARD_RATE_PER_SEAT_PER_MINUTE / FORWARD_RATE_PER_MINUTE;
    for (let person = 0; person < people; person += 1) {
      for (let i = 0; i < FORWARD_RATE_PER_MINUTE; i += 1) {
        const res = await call(
          server,
          "http://c/x",
          withCookie(appGrant({ person: `q${person}` })),
        );
        expect(res.status).toBe(200);
      }
    }
    // A person who has not asked at all still finds the employee's total used up.
    const late = await call(
      server,
      "http://c/x",
      withCookie(appGrant({ person: "late" })),
    );
    expect(late.status).toBe(429);
  });

  test("allowance comes back as time passes, and the table does not grow without bound", async () => {
    const clock = { now: T0 };
    const limiter = createRateLimiter(600, () => clock.now);
    for (let i = 0; i < 600; i += 1) expect(limiter.take("e").ok).toBe(true);
    expect(limiter.take("e").ok).toBe(false);
    clock.now += 6_000;
    // 600 a minute is ten a second, so six seconds gives back sixty.
    expect(limiter.take("e").ok).toBe(true);
    // More employees than the table holds push the oldest out; one forgotten simply starts with a full bucket.
    for (let i = 0; i < 12_000; i += 1) limiter.take(`bot-${i}`);
    expect(limiter.take("e").ok).toBe(true);
  });
});

describe("an answer that is still being streamed", () => {
  const stops: (() => void)[] = [];
  afterEach(() => {
    for (const stop of stops.splice(0)) stop();
  });

  /** A program that sends a line every 10 ms until it is cancelled. */
  const endless = (seen: { cancelled: boolean }) => () => {
    let timer: ReturnType<typeof setInterval> | undefined;
    stops.push(() => clearInterval(timer));
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          timer = setInterval(() => {
            try {
              controller.enqueue(new TextEncoder().encode("data: x\n\n"));
            } catch {}
          }, 10);
        },
        cancel() {
          clearInterval(timer);
          seen.cancelled = true;
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  };

  /** Reads until the stream ends, fails, or five seconds pass; says which. */
  async function drain(res: Response): Promise<"ended" | "failed" | "hung"> {
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const give_up = new Promise<"hung">((resolve) =>
      setTimeout(() => resolve("hung"), 5_000),
    );
    const read = (async () => {
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) return "ended" as const;
        }
      } catch {
        return "failed" as const;
      }
    })();
    const outcome = await Promise.race([read, give_up]);
    if (outcome === "hung") await reader.cancel().catch(() => undefined);
    return outcome;
  }

  test("it is cut within about one recheck after the person is removed, and the program's side is cancelled", async () => {
    const seen = { cancelled: false };
    const s = setup({ program: endless(seen), recheckMs: 20 });
    const res = await call(s.server, "http://c/events", withCookie(appGrant()));
    expect(res.status).toBe(200);
    const done = drain(res);
    // The clock is not moved: the recheck must not be answered from the remembered minute.
    s.state.allowed = false;
    const started = Date.now();
    expect(await done).toBe("failed");
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(seen.cancelled).toBe(true);
  });

  test("it is cut at the session's absolute age, not at the grant's own thirty minutes", async () => {
    const seen = { cancelled: false };
    // A recheck that never comes in this test: only the age limit can end it.
    const s = setup({ program: endless(seen), recheckMs: 600_000 });
    const grant = appGrant({ born: T0 - MAX_SESSION_AGE_MS + 150 });
    const res = await call(s.server, "http://c/events", withCookie(grant));
    expect(res.status).toBe(200);
    const started = Date.now();
    expect(await drain(res)).toBe("failed");
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(seen.cancelled).toBe(true);
  });

  test("a stream that outlives the grant's own expiry is not cut while it is still allowed", async () => {
    const seen = { cancelled: false };
    const s = setup({ program: endless(seen), recheckMs: 20 });
    const res = await call(
      s.server,
      "http://c/events",
      withCookie(appGrant({ exp: T0 + 100 })),
    );
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    s.clock.now = T0 + 1_000;
    const began = Date.now();
    let chunks = 0;
    while (Date.now() - began < 400) {
      const next = await reader.read();
      if (next.done) break;
      chunks += 1;
    }
    expect(Date.now() - began).toBeGreaterThanOrEqual(400);
    expect(chunks).toBeGreaterThan(5);
    await reader.cancel();
    expect(seen.cancelled).toBe(true);
  });

  test("an ordinary answer arrives whole", async () => {
    const s = setup({ program: () => new Response("whole body") });
    const res = await call(s.server, "http://c/", withCookie(appGrant()));
    expect(await res.text()).toBe("whole body");
  });
});

describe("what a program's cache headers become", () => {
  const cached = () =>
    new Response("ok", {
      headers: {
        "cache-control": "public, max-age=31536000, immutable",
        expires: "Wed, 21 Oct 2099 07:28:00 GMT",
        etag: '"abc"',
        "last-modified": "Wed, 21 Oct 2015 07:28:00 GMT",
        pragma: "cache",
        "cdn-cache-control": "max-age=999",
        "surrogate-control": "max-age=999",
        "x-accel-expires": "999",
      },
    });

  test("port mode: no-store whatever the program said, and no validators to revalidate with", async () => {
    const { server } = setup({ program: cached });
    const res = await call(server, "http://c/index.js", withCookie(appGrant()));
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.has("expires")).toBe(false);
    expect(res.headers.has("etag")).toBe(false);
    expect(res.headers.has("last-modified")).toBe(false);
    for (const name of [
      "cdn-cache-control",
      "surrogate-control",
      "x-accel-expires",
    ]) {
      expect(res.headers.has(name)).toBe(false);
    }
  });

  test("domain mode: the program's caching stays but public becomes private", async () => {
    const code = hostCodeOf(appGrant());
    const { server } = setup({ domain: "apps.example.com", program: cached });
    const res = await call(
      server,
      `http://${code}.apps.example.com/index.js`,
      withCookie(appGrant()),
    );
    expect(res.headers.get("cache-control")).toBe(
      "max-age=31536000, immutable, private",
    );
    expect(res.headers.get("etag")).toBe('"abc"');
  });

  test("domain mode: an answer with no Cache-Control gets private, and one that already says private is kept as is", async () => {
    const code = hostCodeOf(appGrant());
    const none = setup({
      domain: "apps.example.com",
      program: () => new Response("ok"),
    });
    const bare = await call(
      none.server,
      `http://${code}.apps.example.com/`,
      withCookie(appGrant()),
    );
    expect(bare.headers.get("cache-control")).toBe("private");
    const own = setup({
      domain: "apps.example.com",
      program: () =>
        new Response("ok", {
          headers: { "cache-control": "private, max-age=5" },
        }),
    });
    const kept = await call(
      own.server,
      `http://${code}.apps.example.com/`,
      withCookie(appGrant()),
    );
    expect(kept.headers.get("cache-control")).toBe("private, max-age=5");
  });
});

describe("a program's WebSocket", () => {
  const stops: (() => void)[] = [];
  afterEach(() => {
    for (const stop of stops.splice(0)) stop();
  });

  /** A program that echoes, remembers what it was asked for, and can be told to close. */
  function program() {
    const info = {
      protocols: [] as string[],
      paths: [] as string[],
      cookies: [] as (string | null)[],
      origins: [] as (string | null)[],
      sockets: [] as { close(code?: number, reason?: string): void }[],
    };
    const upstream = Bun.serve<Record<string, never>>({
      port: 0,
      fetch(request, server) {
        info.paths.push(new URL(request.url).pathname);
        info.cookies.push(request.headers.get("cookie"));
        info.origins.push(request.headers.get("origin"));
        info.protocols.push(
          request.headers.get("sec-websocket-protocol") ?? "",
        );
        const chosen = (request.headers.get("sec-websocket-protocol") ?? "")
          .split(",")[0]
          ?.trim();
        return server.upgrade(request, {
          data: {},
          ...(chosen ? { headers: { "sec-websocket-protocol": chosen } } : {}),
        })
          ? undefined
          : new Response("no", { status: 400 });
      },
      websocket: {
        open(ws) {
          info.sockets.push(ws);
        },
        message(ws, message) {
          ws.send(message);
        },
      },
    });
    stops.push(() => upstream.stop(true));
    return { info, port: upstream.port ?? 0 };
  }

  function listen(content: ReturnType<typeof setup>["server"]) {
    const door = Bun.serve<AppSocketData>({
      port: 0,
      fetch: (request, server) =>
        content.fetch(request, (incoming, options) =>
          server.upgrade(incoming, {
            data: options.data,
            ...(options.headers ? { headers: options.headers } : {}),
          }),
        ) as Promise<Response>,
      websocket: {
        open: (ws) => content.sockets.open(ws),
        message: (ws, raw) => content.sockets.message(ws, raw),
        close: (ws, code, reason) => content.sockets.close(ws, code, reason),
      },
    });
    stops.push(() => door.stop(true));
    return door.port ?? 0;
  }

  const connect = (
    port: number,
    path: string,
    headers: Record<string, string>,
    protocols?: string[],
  ) =>
    new WebSocket(`ws://127.0.0.1:${port}${path}`, {
      headers,
      ...(protocols ? { protocols } : {}),
    } as never);

  const opened = (ws: WebSocket) =>
    new Promise<"open" | "failed">((resolve) => {
      ws.onopen = () => resolve("open");
      ws.onerror = () => resolve("failed");
      ws.onclose = () => resolve("failed");
    });
  const closed = (ws: WebSocket) =>
    new Promise<{ code: number; reason: string }>((resolve) => {
      ws.onclose = (event) =>
        resolve({ code: event.code, reason: event.reason });
    });
  const nextMessage = (ws: WebSocket) =>
    new Promise<string>((resolve) => {
      ws.onmessage = (event) => resolve(String(event.data));
    });

  test("messages go both ways, the path is passed on, and the program's chosen subprotocol is the one the browser gets", async () => {
    const upstream = program();
    const s = setup({
      socketUrl: () => `ws://127.0.0.1:${upstream.port}/forward-ws/4000/live`,
    });
    const port = listen(s.server);
    const ws = connect(
      port,
      "/live?room=1",
      { cookie: cookieFor(appGrant()) },
      ["chat", "other"],
    );
    expect(await opened(ws)).toBe("open");
    expect(ws.protocol).toBe("chat");
    const reply = nextMessage(ws);
    ws.send("hello");
    expect(await reply).toBe("hello");
    expect(s.sockets).toEqual([{ port: 4000, path: "/live?room=1" }]);
    expect(upstream.info.protocols[0]).toBe("chat, other");
    ws.close();
  });

  test("a socket of a person who is not allowed never reaches the computer", async () => {
    const upstream = program();
    const s = setup({
      allowed: false,
      socketUrl: () => `ws://127.0.0.1:${upstream.port}/x`,
    });
    const port = listen(s.server);
    const ws = connect(port, "/live", { cookie: cookieFor(appGrant()) });
    expect(await opened(ws)).toBe("failed");
    expect(s.sockets).toEqual([]);
    expect(upstream.info.paths).toEqual([]);
  });

  test("a page of another origin cannot open it, even with the cookie", async () => {
    const upstream = program();
    const s = setup({ socketUrl: () => `ws://127.0.0.1:${upstream.port}/x` });
    const port = listen(s.server);
    const foreign = connect(port, "/live", {
      cookie: cookieFor(appGrant()),
      origin: "http://evil.test",
    });
    expect(await opened(foreign)).toBe("failed");
    expect(s.sockets).toEqual([]);
    const own = connect(port, "/live", {
      cookie: cookieFor(appGrant()),
      origin: `http://127.0.0.1:${port}`,
    });
    expect(await opened(own)).toBe("open");
    own.close();
  });

  test("the socket to the program carries no cookie in port mode, and the browser's Origin becomes the program's own", async () => {
    const upstream = program();
    const s = setup({ socketUrl: () => `ws://127.0.0.1:${upstream.port}/x` });
    const port = listen(s.server);
    const ws = connect(port, "/live", {
      cookie: `${cookieFor(appGrant())}; sid=main-app`,
      origin: `http://127.0.0.1:${port}`,
    });
    expect(await opened(ws)).toBe("open");
    expect(upstream.info.cookies[0]).toBeNull();
    expect(upstream.info.origins[0]).toBe("http://127.0.0.1:4000");
    ws.close();
    const bare = connect(port, "/live", { cookie: cookieFor(appGrant()) });
    expect(await opened(bare)).toBe("open");
    expect(upstream.info.origins[1]).toBeNull();
    bare.close();
  });

  test("it is closed by its own timer when the grant runs out, with no recheck needed", async () => {
    const upstream = program();
    const s = setup({
      socketUrl: () => `ws://127.0.0.1:${upstream.port}/x`,
      // Long enough that only the grant's own timer can end it.
      recheckMs: 600_000,
    });
    const port = listen(s.server);
    const ws = connect(port, "/live", {
      cookie: cookieFor(appGrant({ exp: T0 + 150 })),
    });
    expect(await opened(ws)).toBe("open");
    const started = Date.now();
    const gone = await closed(ws);
    expect(gone.code).toBe(1008);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("a program that cannot be reached is a failed upgrade", async () => {
    const s = setup({ socketUrl: () => "ws://127.0.0.1:1/never" });
    const port = listen(s.server);
    const ws = connect(port, "/live", { cookie: cookieFor(appGrant()) });
    expect(await opened(ws)).toBe("failed");
  });

  test("the program closing it passes its code and reason to the browser", async () => {
    const upstream = program();
    const s = setup({ socketUrl: () => `ws://127.0.0.1:${upstream.port}/x` });
    const port = listen(s.server);
    const ws = connect(port, "/live", { cookie: cookieFor(appGrant()) });
    await opened(ws);
    const gone = closed(ws);
    upstream.info.sockets[0]?.close(4001, "bye");
    expect(await gone).toEqual({ code: 4001, reason: "bye" });
  });

  test("it is closed when the grant's time is up", async () => {
    const upstream = program();
    const s = setup({
      socketUrl: () => `ws://127.0.0.1:${upstream.port}/x`,
      recheckMs: 20,
    });
    const port = listen(s.server);
    const ws = connect(port, "/live", { cookie: cookieFor(appGrant()) });
    await opened(ws);
    const gone = closed(ws);
    s.clock.now = T0 + OPEN_TOKEN_TTL_MS;
    expect((await gone).code).toBe(1008);
  });

  test("it is closed at the next check after the person is removed", async () => {
    const upstream = program();
    const s = setup({
      socketUrl: () => `ws://127.0.0.1:${upstream.port}/x`,
      recheckMs: 20,
    });
    const port = listen(s.server);
    const ws = connect(port, "/live", { cookie: cookieFor(appGrant()) });
    await opened(ws);
    const gone = closed(ws);
    s.state.allowed = false;
    // The answer is remembered for a minute, so the check sees the change once that has passed.
    s.clock.now = T0 + 61_000;
    expect((await gone).code).toBe(1008);
  });

  test("the periodic check does not use the remembered answer: a removal is seen without a minute passing", async () => {
    const upstream = program();
    const s = setup({
      socketUrl: () => `ws://127.0.0.1:${upstream.port}/x`,
      recheckMs: 20,
    });
    const port = listen(s.server);
    const ws = connect(port, "/live", { cookie: cookieFor(appGrant()) });
    await opened(ws);
    const gone = closed(ws);
    s.state.allowed = false;
    expect((await gone).code).toBe(1008);
  });

  test("more than 16 MB in one message closes it with 1009", async () => {
    const upstream = program();
    const s = setup({ socketUrl: () => `ws://127.0.0.1:${upstream.port}/x` });
    const port = listen(s.server);
    const ws = connect(port, "/live", { cookie: cookieFor(appGrant()) });
    await opened(ws);
    const gone = closed(ws);
    ws.send("x".repeat(17 * 1024 * 1024));
    expect((await gone).code).toBe(1009);
  });
});

/* ---- POST /open for a program ---- */

const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  const id = context.req.header("x-user");
  if (!id) return context.json({ error: "Authentication required." }, 401);
  context.set("actor", {
    id,
    email: `${id}@example.com`,
    role: "user",
  } as AppVariables["actor"]);
  return next();
};

const custom = (name: string, value: unknown) =>
  ({ type: "CUSTOM", name, value }) as unknown as BaseEvent;
const announced = custom(TURN_ARTIFACTS_EVENT, {
  botId: "b1",
  seat: "person:owner-1",
  files: [],
  scanned: 0,
  scanTruncated: false,
  omitted: 0,
});
const delivered = (apps: unknown) =>
  custom("delivery.delivered", { agentId: "b1", deliverable: { apps } });

function openSetup(
  over: {
    events?: BaseEvent[];
    cardApps?: unknown[] | null;
    canUse?: boolean;
    content?: { port?: number; domain?: string };
    /** The employee the person opens; the run below was made by `b1`, and `b2` is in the same conversation. */
    bot?: string;
  } = {},
) {
  const audits: AuditEventInput[] = [];
  const artifact: ArtifactAccessDeps = {
    channelFor: async (_a, id) =>
      id === "c1" ? { agentIds: ["b1", "b2"], threadIds: ["th1"] } : null,
    runOf: async (_a, _c, id) =>
      id === "r1"
        ? {
            threadId: "th1",
            ownerId: "owner-1",
            agentId: "b1",
            events: over.events ?? [
              announced,
              delivered([{ port: 4000, path: "/", title: "Dash" }]),
            ],
          }
        : null,
    cardFor: async (_a, id) =>
      id === "t1" && over.cardApps
        ? {
            botId: "b1",
            seat: "person:owner-1",
            ownerId: "owner-1",
            workspaceFiles: [],
            apps: deliveredAppsOf(over.cardApps),
          }
        : null,
    seatFor: async (botId, personId) => personSeat(personId, botId),
    botIsLive: async () => true,
  };
  const access = createContentAccess({
    canUseBot: async () => over.canUse ?? true,
    seatFor: async (botId, personId) => personSeat(personId, botId),
    artifact,
    roleOf: async () => "user",
  });
  const routes = createOpenRoutes({
    requireUser,
    content: over.content ?? { port: 3773 },
    key: KEY,
    now: () => T0,
    access,
    gateway: { statFile: (async () => null) as never },
    auditStore: {
      insert: async (event) => {
        audits.push(event);
      },
    } satisfies AuditStore,
  });
  const app = new Hono<{ Variables: AppVariables }>();
  app.route("/api/computers", routes);
  const open = (
    body: unknown,
    headers: Record<string, string> = { "x-user": "p1" },
  ) =>
    app.fetch(
      new Request(
        `http://app.test:3010/api/computers/${over.bot ?? "b1"}/open`,
        {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(body),
        },
      ),
    );
  return { open, audits, access };
}

describe("POST /api/computers/:botId/open for a program", () => {
  test("a person's own employee: any port is theirs to open, and the link's token reads back as an app grant", async () => {
    const { open, audits } = openSetup();
    const res = await open({ kind: "app", port: 4000, path: "/dash?x=1" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      url: string;
      mode: string;
      replaces: boolean;
    };
    expect(body.mode).toBe("port");
    expect(body.url).toMatch(/^http:\/\/app\.test:3773\/__open\//);
    const token = body.url.split("/__open/")[1] ?? "";
    const { readOpenToken } = await import("../src/content/token");
    expect(readOpenToken(token, KEY, T0)?.target).toEqual({
      kind: "app",
      port: 4000,
      path: "/dash?x=1",
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]?.eventType).toBe("content.opened");
    expect(audits[0]?.payload).toMatchObject({
      kind: "app",
      port: 4000,
      path: "/dash?x=1",
      mode: "port",
    });
  });

  test("a run's delivered program is not open to another employee of the same conversation", async () => {
    // b1 delivered port 4000 in run r1; b2 is in the conversation but did not run it.
    const { open, audits } = openSetup({ bot: "b2" });
    const res = await open({
      kind: "app",
      port: 4000,
      channel: "c1",
      run: "r1",
    });
    expect(res.status).toBe(404);
    expect(audits).toEqual([]);
    const own = await openSetup().open({
      kind: "app",
      port: 4000,
      channel: "c1",
      run: "r1",
    });
    expect(own.status).toBe(200);
  });

  test("the path defaults to the program's root", async () => {
    const { open } = openSetup();
    const res = await open({ kind: "app", port: 4000 });
    const token =
      ((await res.json()) as { url: string }).url.split("/__open/")[1] ?? "";
    const { readOpenToken } = await import("../src/content/token");
    expect(readOpenToken(token, KEY, T0)?.target).toEqual({
      kind: "app",
      port: 4000,
      path: "/",
    });
  });

  test("a port outside 1024 to 65535, a fraction, a text port and a path that is not a plain absolute path are 400", async () => {
    const { open, audits } = openSetup();
    for (const body of [
      { kind: "app", port: 80 },
      { kind: "app", port: 1023 },
      { kind: "app", port: 65536 },
      { kind: "app", port: 4000.5 },
      { kind: "app", port: "4000" },
      { kind: "app", port: 4000, path: "dash" },
      { kind: "app", port: 4000, path: "//evil.test/x" },
      { kind: "app", port: 4000, path: "/a\\b" },
      { kind: "app", port: 4000, path: "/a\u0000b" },
      { kind: "app", port: 4000, path: "/a\nb" },
      { kind: "app", port: 4000, path: `/${"a".repeat(2000)}` },
    ]) {
      expect((await open(body)).status).toBe(400);
    }
    expect(audits).toEqual([]);
  });

  test("not signed in is 401", async () => {
    const { open } = openSetup();
    expect((await open({ kind: "app", port: 4000 }, {})).status).toBe(401);
  });

  test("a person who may not use the employee, with no delivery to stand on, is 404", async () => {
    const { open, audits } = openSetup({ canUse: false });
    expect((await open({ kind: "app", port: 4000 })).status).toBe(404);
    expect(audits).toEqual([]);
  });

  test("scoped to a run: the port must be listed in the run's delivery", async () => {
    const { open, audits } = openSetup();
    const ok = await open({
      kind: "app",
      port: 4000,
      channel: "c1",
      run: "r1",
    });
    expect(ok.status).toBe(200);
    const unlisted = await open({
      kind: "app",
      port: 4001,
      channel: "c1",
      run: "r1",
    });
    expect(unlisted.status).toBe(404);
    expect(audits).toHaveLength(1);
  });

  test("a run that delivered no programs, a conversation the person is not in and an unknown run are all 404", async () => {
    const none = openSetup({ events: [announced, delivered([])] });
    expect(
      (await none.open({ kind: "app", port: 4000, channel: "c1", run: "r1" }))
        .status,
    ).toBe(404);
    const other = openSetup();
    expect(
      (await other.open({ kind: "app", port: 4000, channel: "c9", run: "r1" }))
        .status,
    ).toBe(404);
    expect(
      (await other.open({ kind: "app", port: 4000, channel: "c1", run: "r9" }))
        .status,
    ).toBe(404);
    expect(
      (await other.open({ kind: "app", port: 4000, channel: "c1" })).status,
    ).toBe(404);
  });

  test("a malformed app entry in a delivery lists nothing", async () => {
    const { open } = openSetup({
      events: [
        announced,
        delivered([
          { port: "4000", path: "/", title: "x" },
          { port: 80, path: "/", title: "x" },
          { port: 4000, title: "x" },
        ]),
      ],
    });
    expect(
      (await open({ kind: "app", port: 4000, channel: "c1", run: "r1" }))
        .status,
    ).toBe(404);
  });

  test("scoped to a card: the card's deliverable must list the port", async () => {
    const { open } = openSetup({
      cardApps: [{ port: 4000, path: "/", title: "Dash" }],
    });
    expect((await open({ kind: "app", port: 4000, task: "t1" })).status).toBe(
      200,
    );
    expect((await open({ kind: "app", port: 4002, task: "t1" })).status).toBe(
      404,
    );
  });

  test("a grant for a program holds while the delivery lists it and stops when it does not", async () => {
    const listed = openSetup();
    const grant = appGrant({
      channel: "c1",
      run: "r1",
      seat: "person:owner-1",
    });
    expect(await listed.access.stillAllowed(grant)).toBe(true);
    const dropped = openSetup({ events: [announced, delivered([])] });
    expect(await dropped.access.stillAllowed(grant)).toBe(false);
    const unscoped = openSetup({ canUse: false });
    expect(await unscoped.access.stillAllowed(appGrant())).toBe(false);
  });

  test("domain mode answers a link on the grant's own subdomain", async () => {
    const { open } = openSetup({ content: { domain: "apps.example.com" } });
    const res = await open({ kind: "app", port: 4000 });
    const body = (await res.json()) as { url: string; mode: string };
    expect(body.mode).toBe("domain");
    expect(body.url).toMatch(
      /^https:\/\/[0-9a-f]{16}\.apps\.example\.com\/__open\//,
    );
  });
});

describe("a request that another site made the browser send", () => {
  const post = (
    server: ReturnType<typeof setup>["server"],
    headers: Record<string, string>,
    method = "POST",
  ) =>
    call(server, "http://c.test:3774/api/do", {
      method,
      body: "x",
      headers: { cookie: cookieFor(appGrant()), ...headers },
    });

  test("a state-changing request from another origin, or from the opaque origin, is 403 and never reaches the program", async () => {
    const { server, seen } = setup();
    for (const origin of ["http://evil.test", "http://c.test:3775", "null"]) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        expect((await post(server, { origin }, method)).status).toBe(403);
      }
    }
    expect(seen).toEqual([]);
  });

  test("a same-origin request passes, and the program sees its own origin in Origin", async () => {
    const { server, seen } = setup();
    const res = await post(server, { origin: "http://c.test:3774" });
    expect(res.status).toBe(200);
    expect(seen[0]?.headers.get("origin")).toBe("http://127.0.0.1:4000");
  });

  test("without Origin, Sec-Fetch-Site decides: only same-origin and none pass", async () => {
    const { server, seen } = setup();
    expect(
      (await post(server, { "sec-fetch-site": "cross-site" })).status,
    ).toBe(403);
    expect((await post(server, { "sec-fetch-site": "same-site" })).status).toBe(
      403,
    );
    expect(seen).toEqual([]);
    expect(
      (await post(server, { "sec-fetch-site": "same-origin" })).status,
    ).toBe(200);
    expect((await post(server, { "sec-fetch-site": "none" })).status).toBe(200);
    // A client that sends neither header is not a browser acting for another site.
    expect((await post(server, {})).status).toBe(200);
  });

  test("a same-origin Origin with a cross-site Sec-Fetch-Site is still refused", async () => {
    const { server } = setup();
    const res = await post(server, {
      origin: "http://c.test:3774",
      "sec-fetch-site": "cross-site",
    });
    expect(res.status).toBe(403);
  });

  test("reading is not restricted: a cross-origin GET, HEAD or OPTIONS reaches the program", async () => {
    const { server, seen } = setup();
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      const res = await call(server, "http://c.test:3774/x", {
        method,
        headers: {
          cookie: cookieFor(appGrant()),
          origin: "http://evil.test",
          "sec-fetch-site": "cross-site",
        },
      });
      expect(res.status).toBe(200);
    }
    expect(seen).toHaveLength(3);
  });
});

describe("more than one content cookie", () => {
  test("two xb_content cookies are refused, and both ways of writing one are cleared", async () => {
    const { server, seen } = setup();
    const good = cookieFor(appGrant());
    const res = await call(server, "http://c.test:3774/x", {
      headers: { cookie: `${CONTENT_COOKIE}=planted; ${good}` },
    });
    expect(res.status).toBe(404);
    expect(seen).toEqual([]);
    const cleared = res.headers.getSetCookie();
    expect(cleared.every((line) => /Max-Age=0/.test(line))).toBe(true);
    const root = cleared.filter((line) => line.includes("Path=/;"));
    expect(root.filter((line) => /Domain=c\.test/i.test(line))).toHaveLength(1);
    expect(root.filter((line) => !/Domain=/i.test(line))).toHaveLength(1);
  });

  test("the same holds with the valid cookie first, and for a link to open", async () => {
    const { server, seen } = setup();
    const good = cookieFor(appGrant());
    const res = await call(server, "http://c.test:3774/x", {
      headers: { cookie: `${good}; ${CONTENT_COOKIE}=planted` },
    });
    expect(res.status).toBe(404);
    const open = await call(server, "http://c.test:3774/__open/anything", {
      headers: { cookie: `${good}; ${CONTENT_COOKIE}=planted` },
    });
    expect(open.status).toBe(404);
    expect(open.headers.getSetCookie().length).toBeGreaterThanOrEqual(2);
    expect(seen).toEqual([]);
  });

  test("a cookie written for a deeper path is cleared at every prefix of the request's path", async () => {
    const { server } = setup();
    const res = await call(server, "http://c.test:3774/api/x", {
      headers: {
        cookie: `${CONTENT_COOKIE}=planted; ${cookieFor(appGrant())}`,
      },
    });
    expect(res.status).toBe(404);
    const lines = res.headers.getSetCookie();
    for (const path of ["/", "/api", "/api/x"]) {
      const spelled = lines.filter((line) => line.includes(`Path=${path};`));
      // Once host-only and once with Domain=<host>.
      expect(spelled).toHaveLength(2);
    }
  });

  test("the prefixes of a very deep path stop at eight levels", async () => {
    const { server } = setup();
    const res = await call(server, "http://c.test:3774/a/b/c/d/e/f/g/h/i/j/k", {
      headers: {
        cookie: `${CONTENT_COOKIE}=planted; ${cookieFor(appGrant())}`,
      },
    });
    const paths = new Set(
      res.headers.getSetCookie().map((line) => /Path=([^;]+)/.exec(line)?.[1]),
    );
    expect(paths.size).toBe(8);
    expect(paths.has("/")).toBe(true);
  });

  test("in domain mode the parent domain's spelling is cleared too", async () => {
    const code = hostCodeOf(appGrant());
    const { server } = setup({ domain: "apps.example.com" });
    const good = cookieFor(appGrant());
    const res = await call(server, `http://${code}.apps.example.com/x`, {
      headers: { cookie: `${CONTENT_COOKIE}=planted; ${good}` },
    });
    expect(res.status).toBe(404);
    const domains = res.headers
      .getSetCookie()
      .filter((line) => line.includes("Path=/;"))
      .map((line) => /Domain=([^;]+)/i.exec(line)?.[1] ?? null);
    expect(domains.sort()).toEqual(
      [null, `${code}.apps.example.com`, "apps.example.com"].sort(),
    );
  });

  test("one cookie, with other people's cookies beside it, still works", async () => {
    const { server } = setup();
    const res = await call(server, "http://c.test:3774/x", {
      headers: { cookie: `session=main; ${cookieFor(appGrant())}` },
    });
    expect(res.status).toBe(200);
  });
});

describe("service workers", () => {
  test("a service worker request is 403 on every path: a folder's, the open link's and a program's own /u/ route", async () => {
    const { server, seen } = setup();
    const dir = await call(server, "http://c/u/anything/sw.js", {
      headers: { cookie: cookieFor(dirGrant()), "service-worker": "script" },
    });
    expect(dir.status).toBe(403);
    const open = await call(server, "http://c/__open/anything", {
      headers: { "service-worker": "script" },
    });
    expect(open.status).toBe(403);
    const own = await call(server, "http://c/u/x/sw.js", {
      headers: { cookie: cookieFor(appGrant()), "service-worker": "script" },
    });
    expect(own.status).toBe(403);
    expect(seen).toEqual([]);
  });

  test("a service worker script request is 403 before it is forwarded", async () => {
    const { server, seen } = setup();
    const res = await call(server, "http://c/sw.js", {
      headers: { cookie: cookieFor(appGrant()), "service-worker": "script" },
    });
    expect(res.status).toBe(403);
    expect(seen).toEqual([]);
  });

  test("a program cannot widen a worker's scope: Service-Worker-Allowed is dropped from its answers", async () => {
    const { server } = setup({
      program: () =>
        new Response("self.x=1", {
          headers: { "service-worker-allowed": "/", "x-app": "kept" },
        }),
    });
    const res = await call(server, "http://c/sw.js", withCookie(appGrant()));
    expect(res.status).toBe(200);
    expect(res.headers.get("service-worker-allowed")).toBeNull();
    expect(res.headers.get("x-app")).toBe("kept");
  });
});

describe("the rest of what a program's answer and request are cleaned of", () => {
  test("every header that begins with proxy- is removed from the request, Proxy-Connection included", () => {
    const out = programRequestHeaders(
      new Headers({
        "proxy-connection": "keep-alive",
        "proxy-authorization": "Basic x",
        "proxy-foo": "1",
        "x-kept": "1",
      }),
      4000,
    );
    expect([...out.keys()].filter((name) => name.startsWith("proxy-"))).toEqual(
      [],
    );
    expect(out.get("x-kept")).toBe("1");
  });

  test("the other spellings of the viewer's address are not sent on", () => {
    const out = programRequestHeaders(
      new Headers({
        "cf-connecting-ip": "9.9.9.9",
        "true-client-ip": "9.9.9.9",
        "x-client-ip": "9.9.9.9",
        "x-original-forwarded-for": "9.9.9.9",
        "x-cluster-client-ip": "9.9.9.9",
        "fastly-client-ip": "9.9.9.9",
        "x-kept": "1",
      }),
      4000,
    );
    expect([...out.keys()].sort()).toEqual(["accept-encoding", "x-kept"]);
  });

  test("Refresh is removed from the answer, since it can send the browser elsewhere", async () => {
    const { server } = setup({
      program: () =>
        new Response("ok", {
          headers: { refresh: "0; url=https://evil.test/", "x-app": "kept" },
        }),
    });
    const res = await call(server, "http://c/", withCookie(appGrant()));
    expect(res.status).toBe(200);
    expect(res.headers.get("refresh")).toBeNull();
    expect(res.headers.get("x-app")).toBe("kept");
  });

  test("a created resource that names another site loses its Location but is not an error; a redirect still is", async () => {
    const created = setup({
      program: () =>
        new Response("made", {
          status: 201,
          headers: { location: "https://evil.test/x" },
        }),
    });
    const res = await call(created.server, "http://c/", withCookie(appGrant()));
    expect(res.status).toBe(201);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.text()).toBe("made");
    const own = setup({
      program: () =>
        new Response("made", {
          status: 201,
          headers: { location: "http://127.0.0.1:4000/items/1#a" },
        }),
    });
    const ownRes = await call(own.server, "http://c/", withCookie(appGrant()));
    expect(ownRes.status).toBe(201);
    expect(ownRes.headers.get("location")).toBe("/items/1#a");
    const moved = setup({
      program: () =>
        new Response(null, {
          status: 307,
          headers: { location: "https://evil.test/x" },
        }),
    });
    const redirected = await call(
      moved.server,
      "http://c/",
      withCookie(appGrant()),
    );
    expect(redirected.status).toBe(502);
  });

  test("the rate limit is kept per computer seat and employee", async () => {
    const { server } = setup();
    for (let i = 0; i < FORWARD_RATE_PER_MINUTE; i += 1) {
      await call(server, "http://c/x", withCookie(appGrant()));
    }
    // The same employee id on another person's computer is another allowance.
    const elsewhere = await call(
      server,
      "http://c/x",
      withCookie(appGrant({ person: "p2", seat: "person:p2" })),
    );
    expect(elsewhere.status).toBe(200);
    const same = await call(server, "http://c/x", withCookie(appGrant()));
    expect(same.status).toBe(429);
  });

  test("programSocketHeaders sends the program's own cookies in domain mode only, and an Origin of the program's own", () => {
    const from = new Headers({
      cookie: `${CONTENT_COOKIE}=secret; sid=1`,
      origin: "https://c.example",
      authorization: "Bearer x",
      "x-other": "no",
    });
    const domain = programSocketHeaders(from, 4000, {
      keepExcept: CONTENT_COOKIE,
    });
    expect(domain).toEqual({
      cookie: "sid=1",
      origin: "http://127.0.0.1:4000",
    });
    expect(programSocketHeaders(from, 4000)).toEqual({
      origin: "http://127.0.0.1:4000",
    });
    expect(programSocketHeaders(new Headers(), 4000)).toEqual({});
  });
});
