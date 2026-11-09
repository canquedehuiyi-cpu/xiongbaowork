import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { createApp } from "../src/app";
import { createAuditStore } from "../src/audit";
import { createAdminScope } from "../src/auth/admin-scope";
import type { ActionPolicy } from "../src/computer/policy";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import {
  auditEvents,
  composioConnections,
  credentials,
  revokedAccess,
  sessions,
  users,
} from "../src/db/schema";
import { createPeopleStore } from "../src/people/store";
import type { ComposioBroker } from "../src/plugins/broker";
import { createPluginStore } from "../src/plugins/store";
import { currentTenant, runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);

const suite = randomUUID().slice(0, 8);
const adminId = `offboarding-admin-${suite}`;
const memberId = `offboarding-member-${suite}`;
const memberEmail = `${memberId}@openbot.test`;

/** The identity rows and the deny list are the deployment's: seeded, read and removed as `platform`. */
const asPlatform = <T>(work: () => T): T => runAsTenant("platform", work);

const ADMIN = {
  id: adminId,
  email: `${adminId}@openbot.test`,
  name: "An Administrator",
  image: null,
};

afterAll(async () => {
  await asPlatform(async () => {
    await database
      .delete(composioConnections)
      .where(eq(composioConnections.userId, memberId));
    await database.delete(credentials).where(eq(credentials.keyId, memberId));
    await database
      .delete(revokedAccess)
      .where(eq(revokedAccess.email, memberEmail));
    await database.delete(sessions).where(eq(sessions.userId, memberId));
    await database.delete(users).where(inArray(users.id, [adminId, memberId]));
  });
  await database.$client.close();
});

function appFor(
  retire: (userId: string, by: string) => Promise<{ retired: number }>,
) {
  const events: string[] = [];
  const store = createPeopleStore(database, [], retire);
  const auditStore = {
    insert: async (event: { eventType: string }) => {
      events.push(event.eventType);
    },
  };

  const app = createApp(
    loadConfig(testEnvironment()),
    {
      handler: () => new Response(null, { status: 204 }),
      api: { getSession: async () => ({ user: ADMIN }) },
    } as never,
    { rolesForUser: async () => ["admin"] },
    ...(Array.from({ length: 9 }) as never[]),
    auditStore as never,
    ...(Array.from({ length: 4 }) as never[]),
    store as never,
  );

  return {
    events,
    remove: () =>
      app.request(`http://openbot.test/api/admin/people/${memberId}/access`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ revoked: true }),
      }),
  };
}

test("a broker that will not answer still leaves the removal on the trail, and asking again finishes it", async () => {
  await asPlatform(async () => {
    await database
      .insert(users)
      .values([
        {
          id: adminId,
          email: ADMIN.email,
          name: "An Administrator",
          emailVerified: true,
        },
        {
          id: memberId,
          email: memberEmail,
          name: "A Member",
          emailVerified: true,
        },
      ])
      .onConflictDoNothing();
    await database.insert(sessions).values({
      id: `${memberId}-session`,
      userId: memberId,
      token: `${memberId}-token`,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
  });

  let attempts = 0;
  const { events, remove } = appFor(async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new Error("composio: 503 Service Unavailable");
    }
    return { retired: 0 };
  });

  expect((await remove()).status).toBe(500);

  const denied = await asPlatform(() =>
    database
      .select({ email: revokedAccess.email })
      .from(revokedAccess)
      .where(eq(revokedAccess.email, memberEmail)),
  );
  expect(denied).toHaveLength(1);
  expect(
    await asPlatform(() =>
      database
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.userId, memberId)),
    ),
  ).toEqual([]);
  expect(events).toEqual(["person.access_revoked"]);

  expect((await remove()).status).toBe(200);
  expect(attempts).toBe(2);
  expect(events).toEqual(["person.access_revoked"]);
});

/*
 * G01-E P7: the retirement runs in the removed person's own frame.
 *
 * Their vault rows and brokered connections are stamped with them, so a sweep from the
 * administrator's frame found nothing, retired nothing and the route still answered 200. The route
 * now hands the sweep to `adminActAsOwner`, and the trail rows the sweep writes are the person's.
 * Driven through the real plugin store's `retireConnectionsFor`, the closure production wires.
 */
test("removing somebody retires the credentials and connections stamped with them, on their own trail", async () => {
  await asPlatform(() =>
    database
      .insert(users)
      .values([
        {
          id: adminId,
          email: ADMIN.email,
          name: "An Administrator",
          emailVerified: true,
        },
        {
          id: memberId,
          email: memberEmail,
          name: "A Member",
          emailVerified: true,
        },
      ])
      .onConflictDoNothing(),
  );
  const toolkit = `offboard-app-${suite}`;
  const provider = `offboard-server-${suite}`;
  await runAsTenant(memberId, async () => {
    await database.insert(credentials).values({
      kind: "mcp_user_token",
      provider,
      encryptedValue: "sealed",
      keyId: memberId,
      metadata: {},
    });
    await database
      .insert(composioConnections)
      .values({ toolkit, userId: memberId });
  });

  const sweptIn: string[] = [];
  const policy: ActionPolicy = { mode: "enforce", deny: [], allow: ["true"] };
  const plugins = createPluginStore({
    database,
    auditStore: createAuditStore(database),
    broker: { revoke: async () => true } as unknown as ComposioBroker,
    credentials: {
      readSecret: async () => null,
      create: async () => {
        throw new Error("this suite writes credentials directly");
      },
      updateSecret: async () => {
        throw new Error("this suite writes credentials directly");
      },
      revoke: async (id: string) => {
        await database
          .update(credentials)
          .set({ revokedAt: new Date() })
          .where(eq(credentials.id, id));
      },
    } as never,
    encryptionKey: "x".repeat(44),
    policy: () => policy,
  });
  let result: { retired: number } | undefined;
  const { remove } = appFor(async (userId, by) => {
    sweptIn.push(currentTenant());
    result = await plugins.retireConnectionsFor(userId, by);
    return result;
  });

  expect((await remove()).status).toBe(200);
  expect(sweptIn).toEqual([memberId]);
  expect(result?.retired).toBe(2);

  const [vault] = await asPlatform(() =>
    database
      .select({ revokedAt: credentials.revokedAt })
      .from(credentials)
      .where(eq(credentials.keyId, memberId)),
  );
  expect(vault?.revokedAt).not.toBeNull();
  expect(
    await asPlatform(() =>
      database
        .select({ toolkit: composioConnections.toolkit })
        .from(composioConnections)
        .where(eq(composioConnections.userId, memberId)),
    ),
  ).toEqual([]);
  const trail = await asPlatform(() =>
    database
      .select({
        targetId: auditEvents.targetId,
        tenantId: auditEvents.tenantId,
      })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.eventType, "mcp.account_disconnected"),
          inArray(auditEvents.targetId, [provider, toolkit]),
        ),
      ),
  );
  expect(trail.map((row) => row.targetId).sort()).toEqual(
    [provider, toolkit].sort(),
  );
  expect(new Set(trail.map((row) => row.tenantId))).toEqual(
    new Set([memberId]),
  );
});

test("acting as the owner without the admin capability is refused", async () => {
  const scope = createAdminScope({
    roleRepository: { rolesForUser: async () => ["admin"] },
  });
  let ran = false;
  await runAsTenant(adminId, async () => {
    expect(() =>
      scope.adminActAsOwner({ id: adminId }, memberId, () => {
        ran = true;
      }),
    ).toThrow("the admin capability is not held here");
  });
  expect(ran).toBe(false);
});
