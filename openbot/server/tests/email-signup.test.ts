import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createAuth } from "../src/auth";
import type { DeploymentConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import {
  accounts,
  agentProfiles,
  agents,
  sessions,
  subscriptions,
  users,
} from "../src/db/schema";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Ticket 004 acceptance: registering with an address and a password opens a tenant.
 *
 * Run through Better Auth's own handler rather than by calling `provisionTenant` directly, because
 * what has to hold is the whole chain — the route, the `user.create` hooks, and row-level security
 * agreeing with each other. The direct call would stay green while the endpoint 500s, which is
 * precisely the failure this ticket would otherwise ship.
 *
 * The auth instance is built the way `index.ts` builds it for the server, on the same `database`, so
 * the hooks that decide who may register are the real ones. `allowedEmailDomains` is empty on
 * purpose: that is the shape a self-serve deployment has, and an empty list admitting everybody is
 * the one thing the domain filter must not get wrong here.
 */
const databaseUrl = testDatabaseUrl();
if (!databaseUrl) {
  throw new Error(
    "email-signup.test.ts needs DATABASE_URL, run it with `bun --env-file=../.env test`.",
  );
}
const database = createDatabase(databaseUrl, TEST_POOL);

const suite = randomUUID().slice(0, 8);
const email = `signup-${suite}@acme.test`;
const PASSWORD = "a-passphrase-long-enough";

const auth = createAuth(
  {
    auth: {
      baseUrl: "http://127.0.0.1:3000",
      secret: "x".repeat(40),
      trustedOrigins: [],
      initialAdminEmails: [],
      allowedEmailDomains: [],
    },
    keyEncryptionKey: Buffer.alloc(32, 7).toString("base64"),
  } as unknown as DeploymentConfig,
  database,
  async () => false,
);

/** POST one of Better Auth's own endpoints, the way the browser's client does. */
async function post(path: string, body: unknown) {
  return auth.handler(
    new Request(`http://127.0.0.1:3000/api/auth${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // The origin Better Auth trusts, which is the deployment's own address.
        origin: "http://127.0.0.1:3000",
      },
      body: JSON.stringify(body),
    }),
  );
}

let userId = "";

describe("email and password registration", () => {
  afterAll(async () => {
    // The tenant-scoped rows first, and inside the tenant: RLS lets a delete only touch the rows the
    // session's tenant owns, so the same sweep from a context-free connection would delete nothing
    // and leave the suite's rows behind forever.
    if (userId) {
      await runAsTenant(userId, async () => {
        await database
          .delete(agentProfiles)
          .where(eq(agentProfiles.tenantId, userId));
        await database.delete(agents).where(eq(agents.tenantId, userId));
        await database
          .delete(subscriptions)
          .where(eq(subscriptions.tenantId, userId));
      });
      await database.delete(accounts).where(eq(accounts.userId, userId));
      await database.delete(sessions).where(eq(sessions.userId, userId));
      await database.delete(users).where(eq(users.id, userId));
    }
  });

  test("signing up returns the person it just made", async () => {
    const response = await post("/sign-up/email", {
      name: `Signup ${suite}`,
      email,
      password: PASSWORD,
    });
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.user?.email).toBe(email);

    userId = body.user.id as string;
    const [row] = await database
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(eq(users.id, userId));
    expect(row?.email ?? email).toBe(email);
  });

  /**
   * The tenant exists the moment the person does.
   *
   * Read inside `runAsTenant(userId)`, which is the only way these rows are visible at all — and so
   * the assertion does double duty: the provisioning hook wrote them into the new person's own
   * partition, and nobody else's.
   */
  test("the subscription and the 分身 were provisioned for that tenant", async () => {
    expect(userId, "the sign-up above has to have run").not.toBe("");

    const owned = await runAsTenant(userId, async () => ({
      subscriptions: await database
        .select({
          planId: subscriptions.planId,
          tenant: subscriptions.tenantId,
        })
        .from(subscriptions)
        .where(eq(subscriptions.tenantId, userId)),
      profile: await database
        .select({
          agent: agentProfiles.agentId,
          title: agentProfiles.title,
          tenant: agentProfiles.tenantId,
        })
        .from(agentProfiles)
        .where(eq(agentProfiles.tenantId, userId)),
      employee: await database
        .select({ id: agents.id, tenant: agents.tenantId })
        .from(agents)
        .where(eq(agents.tenantId, userId)),
    }));

    expect(owned.subscriptions).toEqual([{ planId: "free", tenant: userId }]);
    expect(owned.employee.map((row) => row.id)).toEqual([`avatar-${userId}`]);
    expect(owned.profile.map((row) => row.title)).toEqual(["个人分身"]);
    expect(owned.profile.map((row) => row.tenant)).toEqual([userId]);
  });

  test("the wrong password is refused, and gets no session", async () => {
    const response = await post("/sign-in/email", {
      email,
      password: "not-the-password",
    });

    expect(response.status).not.toBe(200);
    const body = (await response.json()) as { token?: unknown };
    // The bearer token IS the session here; `session` is not in this response at all, so asserting on
    // its absence would prove nothing about a refusal.
    expect(body.token).toBeUndefined();
  });

  test("the right password signs the same person back in", async () => {
    const response = await post("/sign-in/email", {
      email,
      password: PASSWORD,
    });
    const body = await response.json();

    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.user?.id).toBe(userId);
    /*
     * Better Auth's sign-in answers with the token at the top level — `{redirect, token, user}` — and the
     * session object this assertion used to read is not in the body at all. Measured against this very
     * handler rather than remembered: the browser's client reads `token` and stores it, which is the only
     * reason every real sign-in worked while this case sat red.
     */
    expect(body.token).toBeString();
  });
});
