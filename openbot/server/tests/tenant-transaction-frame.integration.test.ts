import { afterAll, afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { createAdminScope } from "../src/auth/admin-scope";
import type { AppVariables } from "../src/auth/guards";
import { markAttachmentsSent } from "../src/channels/attachments";
import {
  type CredentialBinding,
  createCredentialStore,
} from "../src/credentials";
import { createDatabase, type Database } from "../src/db/client";
import {
  attachments,
  channelMemberships,
  channels,
  credentials,
  intelligenceChannelMappings,
  users,
} from "../src/db/schema";
import { TEAM_TENANT } from "../src/db/schema/tenant";
import {
  currentTenant,
  runAsTenant,
  TenantContextError,
} from "../src/tenant/context";
import { testDatabaseUrl } from "./support/database";

/**
 * A transaction runs in the frame that opened it, on a fresh connection as on a reused one (G01-E P2).
 *
 * Bun runs a transaction's callback from its own connection machinery, outside the caller's
 * AsyncLocalStorage frame. The session's `app.tenant_id` was already right, but any `currentTenant()`
 * read inside the callback — a store binding an envelope, a predicate built on the outer database —
 * answered the legacy `system` (or, once every access needed a frame, threw). The client now runs
 * the callback inside `runAsTenant(tenant)`, so code inside a transaction sees the tenant its
 * statements run as.
 *
 * Each case opens its own pool of ONE connection and closes it at the end, so "fresh connection"
 * means a connection no earlier statement has touched, and "the same pooled connection" means the
 * only one there is.
 */
const databaseUrl = testDatabaseUrl();
const suite = `txframe-${randomUUID().slice(0, 8)}`;
const alice = `${suite}-alice`;
const opened: Database[] = [];
const cleanups: (() => Promise<unknown>)[] = [];

function freshDatabase(): Database {
  const database = createDatabase(databaseUrl, { max: 1 });
  opened.push(database);
  return database;
}

async function capabilityOn(
  database: Pick<Database, "execute">,
): Promise<unknown> {
  const rows = (await database.execute(
    sql`select current_setting('app.capability', true) as capability`,
  )) as unknown as { capability: unknown }[];
  return rows[0]?.capability;
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const database of opened.splice(0)) await database.$client.close();
});

afterAll(async () => {
  for (const database of opened.splice(0)) await database.$client.close();
});

test("a transaction's callback runs in the frame that opened it, on a fresh connection", async () => {
  const database = freshDatabase();
  const seen = await runAsTenant(alice, () =>
    database.transaction(async (tx) => {
      const before = currentTenant();
      const rows = (await tx.execute(
        sql`select current_setting('app.tenant_id', true) as tenant`,
      )) as unknown as { tenant: string }[];
      // After a round trip as well: the frame must not be lost by the continuation.
      return { before, session: rows[0]?.tenant, after: currentTenant() };
    }),
  );
  expect(seen).toEqual({ before: alice, session: alice, after: alice });

  // And again on the same, now reused, connection.
  const again = await runAsTenant(alice, () =>
    database.transaction(async () => currentTenant()),
  );
  expect(again).toBe(alice);
});

test("markAttachmentsSent records a send under the throwing guard", async () => {
  const database = freshDatabase();
  const channelId = `${suite}-channel-${randomUUID()}`;
  const threadId = `${suite}-thread-${randomUUID()}`;
  const id = await runAsTenant(alice, async () => {
    await database
      .insert(users)
      .values({ id: alice, email: `${alice}@example.test` })
      .onConflictDoNothing();
    await database
      .insert(channels)
      .values({ id: channelId, name: "frame", description: "frame" });
    await database
      .insert(channelMemberships)
      .values({ channelId, userId: alice });
    await database
      .insert(intelligenceChannelMappings)
      .values({ channelId, userId: alice, threadId });
    const [row] = await database
      .insert(attachments)
      .values({
        channelId,
        uploadedBy: alice,
        name: "note.txt",
        mimeType: "text/plain",
        sizeBytes: 2,
        bytes: Buffer.from("hi"),
      })
      .returning({ id: attachments.id });
    return row?.id;
  });
  cleanups.push(() =>
    runAsTenant(alice, async () => {
      await database.delete(channels).where(eq(channels.id, channelId));
      await database.delete(users).where(eq(users.id, alice));
    }),
  );
  if (!id) throw new Error("attachment was not seeded");

  await runAsTenant(alice, () =>
    markAttachmentsSent(database, { actorId: alice, threadId }, [id]),
  );

  const [row] = await runAsTenant(alice, () =>
    database
      .select({ attachedAt: attachments.attachedAt })
      .from(attachments)
      .where(eq(attachments.id, id)),
  );
  expect(row?.attachedAt).toBeInstanceOf(Date);
});

test("credentials.rotate seals the new row to the caller's tenant under the throwing guard", async () => {
  const database = freshDatabase();
  const store = createCredentialStore(database);
  const previousId = randomUUID();
  const keyId = `${suite}-rotate-${previousId}`;
  await runAsTenant(alice, () =>
    database.insert(credentials).values({
      id: previousId,
      kind: "model",
      provider: "openai",
      keyId,
      encryptedValue: "initial",
      metadata: {},
    }),
  );
  cleanups.push(() =>
    runAsTenant(alice, () =>
      database.delete(credentials).where(eq(credentials.keyId, keyId)),
    ),
  );

  const bindings: CredentialBinding[] = [];
  const rotated = await runAsTenant(alice, () =>
    store.rotate({
      previousCredentialId: previousId,
      kind: "model",
      provider: "openai",
      keyId,
      metadata: {},
      seal: async (binding) => {
        bindings.push(binding);
        return "sealed";
      },
    }),
  );

  expect(bindings).toEqual([
    { id: rotated.id, tenantId: alice, kind: "model" },
  ]);
  const rows = await runAsTenant(alice, () =>
    database
      .select({
        id: credentials.id,
        tenantId: credentials.tenantId,
        revokedAt: credentials.revokedAt,
      })
      .from(credentials)
      .where(eq(credentials.keyId, keyId)),
  );
  const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
  expect(byId[rotated.id]?.tenantId).toBe(alice);
  expect(byId[rotated.id]?.revokedAt).toBeNull();
  expect(byId[previousId]?.revokedAt).toBeInstanceOf(Date);
});

test("'team' never reaches a session: no statement, no transaction", async () => {
  const database = freshDatabase();
  let ran = false;
  expect(() =>
    runAsTenant(TEAM_TENANT, () => {
      ran = true;
      return database.select({ id: users.id }).from(users).limit(1);
    }),
  ).toThrow(TenantContextError);
  expect(() =>
    runAsTenant(TEAM_TENANT, () =>
      database.transaction(async () => {
        ran = true;
      }),
    ),
  ).toThrow(TenantContextError);
  expect(ran).toBe(false);
  // The connection is untouched and still usable by a person's frame.
  expect(
    await runAsTenant(alice, () =>
      database.transaction(async () => currentTenant()),
    ),
  ).toBe(alice);
});

test("a capability does not outlive its request on the pooled connection", async () => {
  const database = freshDatabase();
  const scope = createAdminScope({
    roleRepository: { rolesForUser: async () => ["admin"] },
  });
  const signedIn: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", {
      id: alice,
      email: `${alice}@example.test`,
      role: "admin",
    });
    await runAsTenant(alice, () => next());
  };
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", signedIn, scope.adminCapability);
  app.get("/", async (context) =>
    context.json({
      statement: await capabilityOn(database),
      transaction: await database.transaction((tx) => capabilityOn(tx)),
    }),
  );

  const response = await app.request("http://test/");
  expect(await response.json()).toEqual({
    statement: "admin",
    transaction: "admin",
  });

  // The next, unprivileged statement and transaction on the one connection the pool holds.
  expect(await runAsTenant(alice, () => capabilityOn(database))).toBe("");
  expect(
    await runAsTenant(alice, () =>
      database.transaction((tx) => capabilityOn(tx)),
    ),
  ).toBe("");
});
