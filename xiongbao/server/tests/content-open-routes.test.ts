import { describe, expect, test } from "bun:test";
import type { BaseEvent } from "@ag-ui/client";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { TURN_ARTIFACTS_EVENT } from "../../shared/turn-artifacts";
import type { AuditEventInput, AuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import type { ArtifactAccessDeps } from "../src/computer/artifact-access";
import { personSeat } from "../src/computer/computer-key";
import { createContentAccess } from "../src/content/access";
import { createOpenRoutes } from "../src/content/open-routes";
import { createContentServer } from "../src/content/server";
import {
  type ContentGrant,
  hostCodeOf,
  issueSessionToken,
  OPEN_TOKEN_TTL_MS,
  readOpenToken,
} from "../src/content/token";
import { createOriginGuard } from "../src/request-trust";

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const T0 = 1_800_000_000_000;

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

type Stat = { kind: "file" | "folder"; bytes: number } | "absent" | null;

/** A workspace with these paths: folders are inferred from the files under them. */
function workspace(files: string[]) {
  const stat = async (
    _seat: unknown,
    input: { path: string },
  ): Promise<Stat> => {
    if (files.includes(input.path)) return { kind: "file", bytes: 1 };
    if (files.some((file) => file.startsWith(`${input.path}/`)))
      return { kind: "folder", bytes: 0 };
    return "absent";
  };
  return stat;
}

function build(
  over: {
    content?: { port?: number; domain?: string };
    files?: string[];
    stat?: (seat: unknown, input: { path: string }) => Promise<Stat>;
    allow?: boolean;
    audit?: boolean;
  } = {},
) {
  const audits: AuditEventInput[] = [];
  const authorized: { dir: string; botId: string; scope: unknown }[] = [];
  const statted: string[] = [];
  const baseStat =
    over.stat ??
    workspace(
      over.files ?? [
        "site/index.html",
        "site/a.css",
        "other/index.html",
        "page.html",
      ],
    );
  const routes = createOpenRoutes({
    requireUser,
    content: over.content ?? { port: 3773 },
    key: KEY,
    now: () => T0,
    access: {
      authorize: async (actor, input) => {
        authorized.push({
          dir: input.dir,
          botId: input.botId,
          scope: input.scope,
        });
        return over.allow === false
          ? null
          : { seat: personSeat(actor.id, input.botId) };
      },
    },
    gateway: {
      statFile: (async (seat: unknown, input: { path: string }) => {
        statted.push(input.path);
        return baseStat(seat, input);
      }) as never,
    },
    ...(over.audit === false
      ? {}
      : {
          auditStore: {
            insert: async (event) => {
              audits.push(event);
            },
          } satisfies AuditStore,
        }),
  });
  const app = new Hono<{ Variables: AppVariables }>();
  app.route("/api/computers", routes);
  return { app, audits, authorized, statted };
}

const open = (
  app: ReturnType<typeof build>["app"],
  body: unknown,
  headers: Record<string, string> = { "x-user": "p1" },
  url = "http://app.test:3010/api/computers/b1/open",
) =>
  app.fetch(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );

const dirBody = (path = "site", extra: object = {}) => ({
  kind: "dir",
  path,
  ...extra,
});

describe("POST /api/computers/:botId/open", () => {
  test("not signed in is 401", async () => {
    const { app } = build();
    expect((await open(app, dirBody(), {})).status).toBe(401);
  });

  test("a person who may not see it is 404, and nothing is looked up on the computer", async () => {
    const { app, statted, audits } = build({ allow: false });
    const res = await open(app, dirBody());
    expect(res.status).toBe(404);
    expect(statted).toEqual([]);
    expect(audits).toEqual([]);
  });

  test("a folder with no index.html is 404, so is a file, an empty path and a computer that cannot answer", async () => {
    const cases: [string, Parameters<typeof build>[0]][] = [
      ["site", { files: ["site/a.css"] }],
      ["page.html", { files: ["page.html"] }],
      ["site", { files: [] }],
      ["site", { stat: async () => null }],
      ["site", { files: ["site/index.html/x"] }],
    ];
    for (const [path, over] of cases) {
      const { app, audits } = build(over);
      expect((await open(app, dirBody(path))).status).toBe(404);
      expect(audits).toEqual([]);
    }
  });

  test("the workspace root and hidden or escaping paths are 404 before anything is asked", async () => {
    for (const path of [
      ".",
      "",
      "./",
      "/",
      ".git",
      "a/.git",
      ".git/x",
      ".xb-preview",
      "../x",
      "a/../b",
      "/etc",
      "a\\b",
      "C:/x",
      "a\u0000b",
    ]) {
      const { app, authorized, statted } = build({
        files: [`${path}/index.html`, "site/index.html"],
      });
      const res = await open(app, dirBody(path));
      expect(res.status).toBe(404);
      expect(authorized).toEqual([]);
      expect(statted).toEqual([]);
    }
  });

  test("a computer that fails is a 502, not a success", async () => {
    const { app } = build({
      stat: async () => {
        throw new Error("down");
      },
    });
    expect((await open(app, dirBody())).status).toBe(502);
  });

  test("no content source configured answers available:false", async () => {
    const { app, statted } = build({ content: {} });
    const res = await open(app, dirBody());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { available: boolean; reason: string };
    expect(body.available).toBe(false);
    expect(body.reason.length).toBeGreaterThan(0);
    expect(statted).toEqual([]);
  });

  test("an app kind answers a placeholder and mints nothing", async () => {
    const { app, audits, authorized } = build();
    const res = await open(app, { kind: "app", port: 4000, path: "x" });
    expect(await res.json()).toEqual({
      available: false,
      reason: "程序转发将在后续版本提供",
    });
    expect(audits).toEqual([]);
    expect(authorized).toEqual([]);
  });

  test("a malformed body is 400", async () => {
    const { app } = build();
    for (const body of [
      null,
      [],
      {},
      { kind: "zip", path: "a" },
      { kind: "dir" },
      { kind: "dir", path: 3 },
      { kind: "dir", path: "site", channel: 1 },
      { kind: "app", port: "80" },
      { kind: "app", port: 80 },
      { kind: "app", port: 4000, path: 5 },
    ]) {
      expect((await open(app, body)).status).toBe(400);
    }
    const res = await app.fetch(
      new Request("http://app.test/api/computers/b1/open", {
        method: "POST",
        headers: { "x-user": "p1" },
        body: "{nope",
      }),
    );
    expect(res.status).toBe(400);
  });

  describe("port mode", () => {
    test("the link is the request's host, protocol and the content port, with a token that reads back", async () => {
      const { app } = build();
      const res = await open(app, dirBody("site/"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        url: string;
        mode: string;
        expiresAt: string;
        replaces: boolean;
      };
      expect(body.mode).toBe("port");
      expect(body.replaces).toBe(false);
      expect(body.expiresAt).toBe(
        new Date(T0 + OPEN_TOKEN_TTL_MS).toISOString(),
      );
      const match = /^http:\/\/app\.test:3773\/__open\/(.+)$/.exec(body.url);
      expect(match).not.toBeNull();
      const grant = readOpenToken(match?.[1], KEY, T0);
      expect(grant).toEqual({
        person: "p1",
        bot: "b1",
        seat: "person:p1",
        target: { kind: "dir", path: "site" },
        exp: T0 + OPEN_TOKEN_TTL_MS,
        born: T0,
      });
    });

    test("an https request gives an https link, and a forwarded protocol header is not believed", async () => {
      const { app } = build();
      const secure = (await (
        await open(
          app,
          dirBody(),
          { "x-user": "p1" },
          "https://box.example.com/api/computers/b1/open",
        )
      ).json()) as { url: string };
      expect(
        secure.url.startsWith("https://box.example.com:3773/__open/"),
      ).toBe(true);
      const spoofed = (await (
        await open(app, dirBody(), {
          "x-user": "p1",
          "x-forwarded-proto": "https",
          "x-forwarded-host": "evil.test",
        })
      ).json()) as { url: string };
      expect(spoofed.url.startsWith("http://app.test:3773/__open/")).toBe(true);
    });

    test("an IPv6 host keeps its brackets", async () => {
      const { app } = build();
      const body = (await (
        await open(
          app,
          dirBody(),
          { "x-user": "p1" },
          "http://[::1]:3010/api/computers/b1/open",
        )
      ).json()) as { url: string };
      expect(body.url.startsWith("http://[::1]:3773/__open/")).toBe(true);
    });

    test("replaces is true only when this person's own content cookie holds another target", async () => {
      const { app } = build();
      const cookie = (grant: Partial<ContentGrant>, key = KEY) => ({
        "x-user": "p1",
        cookie: `session=app; xb_content=${issueSessionToken(
          {
            person: "p1",
            bot: "b1",
            seat: "person:p1",
            target: { kind: "dir", path: "other" },
            exp: T0 + 1000,
            ...grant,
          },
          key,
        )}`,
      });
      const replaces = async (headers: Record<string, string>) =>
        (
          (await (await open(app, dirBody(), headers)).json()) as {
            replaces: boolean;
          }
        ).replaces;
      expect(await replaces(cookie({}))).toBe(true);
      // The same target again is not a replacement.
      expect(
        await replaces(cookie({ target: { kind: "dir", path: "site" } })),
      ).toBe(false);
      // Somebody else's cookie, an expired one, a forged one and none at all are not.
      expect(await replaces(cookie({ person: "p2" }))).toBe(false);
      expect(await replaces(cookie({ exp: T0 }))).toBe(false);
      expect(await replaces(cookie({}, `${KEY}other`))).toBe(false);
      expect(await replaces({ "x-user": "p1", cookie: "session=app" })).toBe(
        false,
      );
    });
  });

  describe("domain mode", () => {
    test("the link is on the grant's own subdomain over https, and nothing replaces", async () => {
      const { app } = build({
        content: { domain: "apps.example.com", port: 3773 },
      });
      const body = (await (await open(app, dirBody())).json()) as {
        url: string;
        mode: string;
        replaces: boolean;
      };
      expect(body.mode).toBe("domain");
      expect(body.replaces).toBe(false);
      const match =
        /^https:\/\/([0-9a-f]{16})\.apps\.example\.com\/__open\/(.+)$/.exec(
          body.url,
        );
      expect(match).not.toBeNull();
      const grant = readOpenToken(match?.[2], KEY, T0) as ContentGrant;
      expect(match?.[1]).toBe(hostCodeOf(grant));
    });
  });

  describe("audit", () => {
    test("one content.opened row with the facts and no token", async () => {
      const { app, audits } = build();
      const res = await open(
        app,
        dirBody("site", { channel: "c1", run: "r1" }),
      );
      const body = (await res.json()) as { url: string };
      const token = body.url.slice(body.url.lastIndexOf("/") + 1);
      expect(audits.length).toBe(1);
      const [event] = audits;
      expect(event?.eventType).toBe("content.opened");
      expect(event?.actorUserId).toBe("p1");
      expect(event?.payload).toEqual({
        bot: "b1",
        kind: "dir",
        path: "site",
        scopeType: "channel",
        scopeId: "c1",
        run: "r1",
        mode: "port",
      });
      const text = JSON.stringify(event);
      expect(text).not.toContain(token);
      expect(text).not.toContain("__open");
      expect(text).not.toContain(body.url);
    });

    test("a card scope and an unscoped open are named as such", async () => {
      const task = build();
      await open(task.app, dirBody("site", { task: "t9" }));
      expect(task.audits[0]?.payload).toMatchObject({
        scopeType: "task",
        scopeId: "t9",
        mode: "port",
      });
      const own = build({ content: { domain: "apps.example.com" } });
      await open(own.app, dirBody());
      expect(own.audits[0]?.payload).toMatchObject({
        scopeType: "none",
        scopeId: null,
        mode: "domain",
      });
    });
  });

  test("the scope is passed to the rules exactly as given", async () => {
    const { app, authorized } = build();
    await open(app, dirBody("site", { channel: "c1", run: "r1" }));
    await open(app, dirBody("site"));
    expect(authorized).toEqual([
      { dir: "site", botId: "b1", scope: { channel: "c1", run: "r1" } },
      { dir: "site", botId: "b1", scope: null },
    ]);
  });
});

/* The rules themselves, with fake lookups, as artifact-access.test.ts does. */
const custom = (name: string, value: unknown) =>
  ({ type: "CUSTOM", name, value }) as unknown as BaseEvent;
const artifacts = (paths: string[], botId = "b1") =>
  custom(TURN_ARTIFACTS_EVENT, {
    botId,
    seat: "person:owner-1",
    files: paths.map((path) => ({
      path,
      bytes: 1,
      modifiedMs: 1,
      change: "new",
    })),
    scanned: paths.length,
    scanTruncated: false,
    omitted: 0,
  });

function realAccess(
  setup: {
    events?: BaseEvent[];
    card?: string[] | null;
    member?: boolean;
    live?: boolean;
    role?: "user" | "admin" | null;
    canUse?: boolean;
  } = {},
) {
  const artifact: ArtifactAccessDeps = {
    channelFor: async (_a, id) =>
      id === "c1" && setup.member !== false
        ? { agentIds: ["b1"], threadIds: ["th1"] }
        : null,
    runOf: async (_a, _c, id) =>
      id === "r1"
        ? {
            threadId: "th1",
            ownerId: "owner-1",
            events: setup.events ?? [artifacts(["site/index.html"])],
          }
        : null,
    cardFor: async (_a, id) =>
      id === "t1" && setup.card
        ? {
            botId: "b1",
            seat: "person:owner-1",
            ownerId: "owner-1",
            workspaceFiles: setup.card,
          }
        : null,
    seatFor: async (botId, personId) => personSeat(personId, botId),
    botIsLive: async () => setup.live ?? true,
  };
  return createContentAccess({
    canUseBot: async () => setup.canUse ?? true,
    seatFor: async (botId, personId) => personSeat(personId, botId),
    artifact,
    roleOf: async () => (setup.role === undefined ? "user" : setup.role),
  });
}
const member = { id: "m2", role: "user" } as const;

describe("who may open a folder", () => {
  test("a run that announced a file directly in the folder opens it, and the seat is the run owner's", async () => {
    const access = realAccess({ events: [artifacts(["site/deep.html"])] });
    const found = await access.authorize(member, {
      botId: "b1",
      dir: "site",
      scope: { channel: "c1", run: "r1" },
    });
    expect(found?.seat.key).toEqual({ kind: "person", personId: "owner-1" });
  });

  test("a file deeper down does not open its ancestors, only its own folder", async () => {
    const access = realAccess({ events: [artifacts(["work/p1/out.md"])] });
    const scope = { channel: "c1", run: "r1" };
    expect(
      await access.authorize(member, { botId: "b1", dir: "work", scope }),
    ).toBeNull();
    expect(
      await access.authorize(member, { botId: "b1", dir: "work/p1", scope }),
    ).not.toBeNull();
    const card = realAccess({ card: ["work/p1/out.md"] });
    expect(
      await card.authorize(member, {
        botId: "b1",
        dir: "work",
        scope: { task: "t1" },
      }),
    ).toBeNull();
    expect(
      await card.authorize(member, {
        botId: "b1",
        dir: "work/p1",
        scope: { task: "t1" },
      }),
    ).not.toBeNull();
  });

  test("the folder's own index.html is enough, and a delivered file counts", async () => {
    const delivered = custom("delivery.delivered", {
      deliverable: { workspaceFiles: ["site/index.html"] },
    });
    const access = realAccess({ events: [artifacts(["x.txt"]), delivered] });
    expect(
      await access.authorize(member, {
        botId: "b1",
        dir: "site",
        scope: { channel: "c1", run: "r1" },
      }),
    ).not.toBeNull();
  });

  test("files outside the folder, or in a folder that only shares its name's start, do not", async () => {
    const access = realAccess({
      events: [
        artifacts(["site2/index.html", "other/site/index.html", "site.html"]),
      ],
    });
    expect(
      await access.authorize(member, {
        botId: "b1",
        dir: "site",
        scope: { channel: "c1", run: "r1" },
      }),
    ).toBeNull();
  });

  test("a card opens a folder its files list under, nothing else", async () => {
    const access = realAccess({ card: ["site/index.html"] });
    expect(
      await access.authorize(member, {
        botId: "b1",
        dir: "site",
        scope: { task: "t1" },
      }),
    ).not.toBeNull();
    expect(
      await access.authorize(member, {
        botId: "b1",
        dir: "other",
        scope: { task: "t1" },
      }),
    ).toBeNull();
    expect(
      await access.authorize(member, {
        botId: "b1",
        dir: "site",
        scope: { task: "nope" },
      }),
    ).toBeNull();
  });

  test("a person outside the conversation, or a scope that is incomplete, gets nothing", async () => {
    const outsider = realAccess({ member: false });
    expect(
      await outsider.authorize(member, {
        botId: "b1",
        dir: "site",
        scope: { channel: "c1", run: "r1" },
      }),
    ).toBeNull();
    const access = realAccess();
    expect(
      await access.authorize(member, {
        botId: "b1",
        dir: "site",
        scope: { channel: "c1" },
      }),
    ).toBeNull();
    expect(
      await access.authorize(member, {
        botId: "b1",
        dir: "site",
        scope: { channel: "", run: "" },
      }),
    ).toBeNull();
    expect(
      await access.authorize(member, {
        botId: "b1",
        dir: ".",
        scope: { channel: "c1", run: "r1" },
      }),
    ).toBeNull();
  });

  test("without a scope it is the person's own employee on their own seat", async () => {
    const own = realAccess();
    const found = await own.authorize(member, {
      botId: "b1",
      dir: "site",
      scope: null,
    });
    expect(found?.seat.key).toEqual({ kind: "person", personId: "m2" });
    expect(
      await realAccess({ canUse: false }).authorize(member, {
        botId: "b1",
        dir: "site",
        scope: null,
      }),
    ).toBeNull();
  });
});

describe("stillAllowed", () => {
  const grant = (over: Partial<ContentGrant> = {}): ContentGrant => ({
    person: "m2",
    bot: "b1",
    seat: "person:owner-1",
    channel: "c1",
    run: "r1",
    target: { kind: "dir", path: "site" },
    exp: T0,
    ...over,
  });

  test("holds while the person is in, the employee is live and the run still lists the folder", async () => {
    expect(await realAccess().stillAllowed(grant())).toBe(true);
  });

  test("fails when the person left, the employee is gone, the person is gone, or the seat moved", async () => {
    expect(await realAccess({ member: false }).stillAllowed(grant())).toBe(
      false,
    );
    expect(await realAccess({ live: false }).stillAllowed(grant())).toBe(false);
    expect(await realAccess({ role: null }).stillAllowed(grant())).toBe(false);
    expect(
      await realAccess().stillAllowed(grant({ seat: "person:someone-else" })),
    ).toBe(false);
  });

  test("an unscoped grant follows canUseBot and the seat; an app grant is never allowed", async () => {
    const own = grant({
      channel: undefined,
      run: undefined,
      seat: "person:m2",
    });
    expect(await realAccess().stillAllowed(own)).toBe(true);
    expect(await realAccess({ canUse: false }).stillAllowed(own)).toBe(false);
    expect(
      await realAccess().stillAllowed(
        grant({ target: { kind: "app", port: 4000, path: "" } }),
      ),
    ).toBe(false);
  });

  test("a card grant fails once the card no longer lists the folder", async () => {
    const task = grant({ channel: undefined, run: undefined, task: "t1" });
    expect(
      await realAccess({ card: ["site/index.html"] }).stillAllowed(task),
    ).toBe(true);
    expect(await realAccess({ card: null }).stillAllowed(task)).toBe(false);
  });
});

describe("cross-site requests", () => {
  test("the application's origin guard stands in front of the open route", async () => {
    const { routes } = (() => {
      const built = build();
      return { routes: built.app };
    })();
    const app = new Hono<{ Variables: AppVariables }>();
    app.use(
      "/api/*",
      createOriginGuard({ browserOrigins: [], recorder: undefined } as never),
    );
    app.route("/", routes);
    const attempt = (headers: Record<string, string>) =>
      app.fetch(
        new Request("http://app.test:3010/api/computers/b1/open", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-user": "p1",
            ...headers,
          },
          body: JSON.stringify(dirBody()),
        }),
      );
    expect((await attempt({ origin: "https://evil.test" })).status).toBe(403);
    expect((await attempt({ "sec-fetch-site": "cross-site" })).status).toBe(
      403,
    );
    expect((await attempt({ origin: "http://app.test:3010" })).status).toBe(
      200,
    );
  });
});

describe("opening end to end", () => {
  test("the link from the route is accepted by the content server and serves the page", async () => {
    const { app } = build();
    const body = (await (await open(app, dirBody())).json()) as { url: string };
    const server = createContentServer({
      key: KEY,
      now: () => T0,
      stillAllowed: async () => true,
      gateway: {
        serveFile: async (_seat, input) => {
          const bytes = new TextEncoder().encode(`served ${input.path}`);
          return {
            body: new Response(bytes).body as ReadableStream<Uint8Array>,
            bytes: bytes.length,
          };
        },
      },
    });
    const redirect = await server.fetch(new Request(body.url));
    expect(redirect.status).toBe(302);
    const location = redirect.headers.get("location") ?? "";
    const cookie =
      (redirect.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    expect(
      await (
        await server.fetch(new Request(`http://app.test:3773${location}`))
      ).text(),
    ).toBe("served site/index.html");
    expect(
      await (
        await server.fetch(
          new Request("http://app.test:3773/a.css", { headers: { cookie } }),
        )
      ).text(),
    ).toBe("served site/a.css");
  });
});
