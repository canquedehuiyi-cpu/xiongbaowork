import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createRoleRepository } from "../src/auth/guards";
import { createRoleOf } from "../src/auth/role-of";
import { computerKeyText, personSeat } from "../src/computer/computer-key";
import type { DeploymentConfig } from "../src/config";
import { createContentAccess } from "../src/content/access";
import { createContentServer } from "../src/content/server";
import {
  type ContentGrant,
  issueOpenToken,
  OPEN_TOKEN_TTL_MS,
} from "../src/content/token";
import { createDatabase } from "../src/db/client";
import { userRoles } from "../src/db/schema/core";
import { startHttpServer } from "../src/http-server";
import { runAsTenant, tenantFrame } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { removePeople, seedPerson } from "./support/people";

/**
 * The content origin on its own port, in a deployment with real sign-in: who may still open a page is
 * answered from the person's roles in the database.
 *
 * Nothing here is framed on purpose (this file does not use the platform-frame harness): the content
 * listener's requests arrive outside any request frame of the app, as they do in a deployment, and
 * the content server's questions to the database must open the frame themselves. The role lookup is
 * the real one over the real table; only the computer behind the gateway is a stand-in.
 */

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
/** Roles are written only by their own restricted writer; the application role can only read them. */
const writer = createDatabase(
  process.env.TEST_ROLE_WRITER_DATABASE_URL?.trim() ??
    (() => {
      throw new Error(
        "TEST_ROLE_WRITER_DATABASE_URL must connect to the TEST_DATABASE_URL database as openbot_role_writer.",
      );
    })(),
  { max: 1 },
);
const personId = `content-frame-${randomUUID()}`;
const BOT = "employee-1";
const seat = personSeat(personId, BOT);
const clock = { now: Date.now() };

const access = createContentAccess({
  canUseBot: async () => true,
  seatFor: async (botId, person) => personSeat(person, botId),
  // A request that names no conversation never asks the artifact rules.
  artifact: {} as never,
  roleOf: createRoleOf({
    singleUser: false,
    roles: createRoleRepository(database),
  }),
});

const grant = (over: Partial<ContentGrant> = {}): ContentGrant => ({
  person: personId,
  bot: BOT,
  seat: computerKeyText(seat.key),
  target: { kind: "dir", path: "site" },
  exp: clock.now + OPEN_TOKEN_TTL_MS,
  ...over,
});

const content = createContentServer({
  key: KEY,
  now: () => clock.now,
  gateway: {
    serveFile: async (_seat, input) =>
      input.path === "site/index.html"
        ? {
            body: new Response("<h1>site</h1>")
              .body as ReadableStream<Uint8Array>,
            bytes: 13,
          }
        : null,
    forwardHttp: async () => new Response("the program"),
  },
  stillAllowed: (given) => access.stillAllowed(given),
});

const freePort = () => {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = probe.port ?? 0;
  probe.stop(true);
  return port;
};
const contentPort = freePort();
const front = startHttpServer({
  port: freePort(),
  config: { content: { port: contentPort } } as unknown as DeploymentConfig,
  resolveRequestActor: async () => ({ id: "u", name: "u", role: "user" }),
  agentProfileStore: {} as never,
  computerGateway: undefined,
  app: { fetch: () => new Response("the app") },
  content,
});
const origin = `http://127.0.0.1:${contentPort}`;

const open = (given: ContentGrant) =>
  fetch(`${origin}/__open/${issueOpenToken(given, KEY)}`, {
    redirect: "manual",
  });

const cookieOf = (response: Response) =>
  (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

beforeAll(async () => {
  expect(tenantFrame()).toBeUndefined();
  await runAsTenant("platform", async () => {
    await seedPerson(database, personId);
    await writer.insert(userRoles).values({ userId: personId, role: "user" });
  });
});

afterAll(async () => {
  front.stop(true);
  await runAsTenant("platform", () => removePeople(database, [personId]));
  await writer.$client.close();
  await database.$client.end();
});

describe("the content port with real sign-in", () => {
  test("a folder opens: the link is taken, the cookie is set, and the page is served", async () => {
    const opened = await open(grant());
    expect(opened.status).toBe(302);
    const page = await fetch(`${origin}${opened.headers.get("location")}`, {
      headers: { cookie: cookieOf(opened) },
    });
    expect(page.status).toBe(200);
    expect(await page.text()).toBe("<h1>site</h1>");
  });

  test("a program's link is not a 502: it is taken, and the program answers", async () => {
    const given = grant({ target: { kind: "app", port: 4000, path: "" } });
    const opened = await open(given);
    expect(opened.status).toBe(302);
    const page = await fetch(`${origin}/`, {
      headers: { cookie: cookieOf(opened) },
    });
    expect(page.status).toBe(200);
    expect(await page.text()).toBe("the program");
  });

  test("a person removed from the deployment is refused: the question says no, and a new link is a 404", async () => {
    expect(await access.stillAllowed(grant())).toBe(true);
    await runAsTenant("platform", () =>
      writer.delete(userRoles).where(eq(userRoles.userId, personId)),
    );
    try {
      expect(await access.stillAllowed(grant())).toBe(false);
      // Past what the content server remembers of an earlier answer.
      clock.now += 120_000;
      expect((await open(grant())).status).toBe(404);
    } finally {
      await runAsTenant("platform", () =>
        writer.insert(userRoles).values({ userId: personId, role: "user" }),
      );
    }
  });

  test("a grant that names nobody who can be acted as is refused, not thrown", async () => {
    for (const person of ["", "team", "platform", "system"])
      expect(await access.stillAllowed(grant({ person }))).toBe(false);
  });
});
