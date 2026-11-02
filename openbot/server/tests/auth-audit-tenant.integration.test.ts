import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createAuth } from "../src/auth";
import type { DeploymentConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import {
  accounts,
  agentProfiles,
  agents,
  auditEvents,
  sessions,
  subscriptions,
  users,
} from "../src/db/schema";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { bindTestRoleWriter } from "./support/role-writer";

/*
 * G01-D: the sign-in trail says whose each row is. A refusal before any account is proven is the
 * deployment's (`platform`); a row about a session Better Auth resolved goes in that person's own
 * trail. Unframed, every one of them was `system`, which every tenant's trail lists, address
 * included. The handler is driven as `app.ts` drives it, as the identity layer (`platform`), and
 * under `OPENBOT_TENANT_FRAME_GUARD=throw` so a hook that read the tenant with no frame fails here.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const auditStore = createAuditStore(database);
const suite = randomUUID().slice(0, 8);
const admitted = `auth-audit-${suite}@acme.test`;
const refused = `auth-audit-${suite}@elsewhere.test`;
const savedGuard = process.env.OPENBOT_TENANT_FRAME_GUARD;
let releaseRoleWriter: (() => Promise<void>) | undefined;
let userId = "";

const auth = createAuth(
  {
    auth: {
      baseUrl: "http://127.0.0.1:3000",
      secret: "x".repeat(40),
      trustedOrigins: [],
      initialAdminEmails: [],
      allowedEmailDomains: ["acme.test"],
    },
    keyEncryptionKey: Buffer.alloc(32, 7).toString("base64"),
  } as unknown as DeploymentConfig,
  database,
  async () => false,
  auditStore,
);

async function signUp(email: string) {
  process.env.OPENBOT_TENANT_FRAME_GUARD = "throw";
  try {
    return await runAsTenant("platform", () =>
      auth.handler(
        new Request("http://127.0.0.1:3000/api/auth/sign-up/email", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "http://127.0.0.1:3000",
          },
          body: JSON.stringify({
            name: "Audit",
            email,
            password: "a-passphrase-long-enough",
          }),
        }),
      ),
    );
  } finally {
    if (savedGuard === undefined) delete process.env.OPENBOT_TENANT_FRAME_GUARD;
    else process.env.OPENBOT_TENANT_FRAME_GUARD = savedGuard;
  }
}

/** The tenant of every row of one type that names this address. */
const tenantsFor = (eventType: string, email: string) =>
  runAsTenant("platform", () =>
    database
      .select({ tenantId: auditEvents.tenantId })
      .from(auditEvents)
      .where(
        sql`${auditEvents.eventType} = ${eventType} and ${auditEvents.payload}->>'email' = ${email}`,
      ),
  );

beforeAll(async () => {
  releaseRoleWriter = await bindTestRoleWriter(database);
});

afterAll(async () => {
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
  await releaseRoleWriter?.();
  await database.$client.end({ timeout: 5 });
});

describe("the sign-in trail", () => {
  test("a refusal before any account exists is the deployment's, not everybody's", async () => {
    const response = await signUp(refused);
    expect(response.status).toBe(403);
    expect(await tenantsFor("session.refused", refused)).toEqual([
      { tenantId: "platform" },
    ]);
  });

  test("a sign-in is filed in the person's own trail", async () => {
    const response = await signUp(admitted);
    const body = (await response.json()) as { user?: { id?: string } };
    expect(response.status, JSON.stringify(body)).toBe(200);
    userId = body.user?.id ?? "";
    expect(userId).not.toBe("");
    expect(await tenantsFor("session.signed_in", admitted)).toEqual([
      { tenantId: userId },
    ]);
  });
});
