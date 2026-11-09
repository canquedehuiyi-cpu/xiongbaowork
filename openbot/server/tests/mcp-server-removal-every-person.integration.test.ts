import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createCredentialStore, sealCredential } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  auditEvents,
  composioConnections,
  credentials,
  mcpServers,
  mcpUserCredentials,
  pluginGrants,
  users,
} from "../src/db/schema";
import type { ComposioBroker } from "../src/plugins/broker";
import { createPluginStore } from "../src/plugins/store";
import { runAsTenant } from "../src/tenant/context";
import { createAdminRequest, seedAdministrator } from "./support/admin-request";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * G01-E P21 (Codex review of P10, F5/F6): removing a team server reaches EVERY person's rows tied to
 * it, not only the ones the administrator's own frame can see.
 *
 * The server is `team` and the administrator removes it from their own frame, holding the capability.
 * But what hangs off it is stamped with each person: a person's grant on their own private Bot (an
 * administrator's grant there runs in the owner's frame, and a person's own install lands there too),
 * a person's `mcp_user_token` and its `mcp_user_credentials` pointer, and a person's brokered
 * `composio_connections` row. Row security hides all of those from the administrator's frame, so the
 * removal used to delete the server row and leave them: the token stayed live at the vendor with its
 * pointer cascaded away, the brokered account stayed attached, and adding the server back made the
 * stale grant and the stale connection count again with nobody asked.
 *
 * No vendor is reached: the broker is a recorder, and the vault is the real one.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

const suite = `msr-${randomUUID().slice(0, 8)}`;
const admin = `${suite}-admin`;
const person = `${suite}-person`;
const personBot = `${suite}-person-bot`;

/** A server reached with each person's own token. */
const tokenServer = `${suite}-tokens`;
const tokenRef = `${tokenServer}/lookup`;
/** A brokered app, reached through each person's own Composio account. */
const slug = `msr${randomUUID().slice(0, 8)}`;
const brokeredServer = `composio-${slug}`;
const brokeredRef = `${brokeredServer}/${slug.toUpperCase()}_FETCH`;

const revoked: { userId: string; toolkit: string }[] = [];
const broker: ComposioBroker = {
  listApps: async () => [],
  ensureAuthConfig: async () => "standing",
  deleteAuthConfig: async () => undefined,
  authorize: async () => {
    throw new Error("the removal path asked the broker to begin a connection");
  },
  isConnected: async () => true,
  revoke: async (input) => {
    revoked.push({ userId: input.userId, toolkit: input.toolkit });
    return true;
  },
  // Removal never draws a connect form, connects with typed fields or undoes one account.
  connectionFields: async () => {
    throw new Error("the removal path asked the broker for a connect form");
  },
  connectWithFields: async () => {
    throw new Error("the removal path asked the broker to connect");
  },
  revokeAccount: async () => {
    throw new Error("the removal path asked the broker to undo one account");
  },
};

const vault = createCredentialStore(database);
const store = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: vault,
  encryptionKey: ENCRYPTION_KEY,
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  broker,
});

const adminRequest = createAdminRequest(database);
const asPlatform = <T>(work: () => Promise<T>) => runAsTenant("platform", work);
let releaseAdmin: (() => Promise<void>) | undefined;
let personToken = "";

beforeAll(async () => {
  releaseAdmin = await seedAdministrator(database, admin);
  personToken = randomUUID();
  const sealed = await sealCredential(
    ENCRYPTION_KEY,
    { id: personToken, tenantId: person, kind: "mcp_user_token" },
    `${suite}-refresh-token`,
  );
  await asPlatform(async () => {
    await database
      .insert(users)
      .values({ id: person, email: `${person}@example.test` });
    await database.insert(agents).values({
      id: personBot,
      tenantId: person,
      name: "Desk",
      type: "built_in",
      configuration: {},
    });
    await database.insert(agentProfiles).values({
      agentId: personBot,
      tenantId: person,
      ownerUserId: person,
      title: "Desk",
      roleDescription: "Answers questions.",
      avatarSeed: "seed",
      visibility: "private",
    });
    await database.insert(mcpServers).values([
      {
        id: tokenServer,
        tenantId: "team",
        title: "Ledger",
        vendor: "ledger.vendor.example",
        url: "https://ledger.vendor.example/mcp",
        provenance: "custom",
      },
      {
        id: brokeredServer,
        tenantId: "team",
        title: "Brokered",
        vendor: "composio",
        url: `composio://${slug}`,
        provenance: "composio",
        authScheme: "OAUTH2",
      },
    ]);
    // The person's own token for the server, and the pointer to it, both stamped with the person.
    await database.insert(credentials).values({
      id: personToken,
      tenantId: person,
      kind: "mcp_user_token",
      provider: tokenServer,
      keyId: person,
      encryptedValue: sealed,
      metadata: {},
    });
    await database.insert(mcpUserCredentials).values({
      tenantId: person,
      serverId: tokenServer,
      userId: person,
      credentialId: personToken,
      scope: "read",
    });
    await database.insert(composioConnections).values({
      tenantId: person,
      toolkit: slug,
      userId: person,
      verified: true,
    });
    // Grants on the person's private Bot carry the Bot's own stamp: the person's (0127).
    await database.insert(pluginGrants).values([
      {
        tenantId: person,
        kind: "mcp",
        ref: tokenRef,
        agentId: personBot,
        grantedBy: `${admin}@example.test`,
      },
      {
        tenantId: person,
        kind: "mcp",
        ref: brokeredRef,
        agentId: personBot,
        grantedBy: `${admin}@example.test`,
      },
    ]);
  });
});

afterAll(async () => {
  await asPlatform(async () => {
    await database
      .delete(pluginGrants)
      .where(eq(pluginGrants.agentId, personBot));
    await database
      .delete(composioConnections)
      .where(eq(composioConnections.toolkit, slug));
    await database
      .delete(mcpUserCredentials)
      .where(eq(mcpUserCredentials.userId, person));
    await database
      .delete(mcpServers)
      .where(inArray(mcpServers.id, [tokenServer, brokeredServer]));
    await database.delete(credentials).where(eq(credentials.id, personToken));
    await database.delete(agents).where(eq(agents.id, personBot));
    await database.delete(users).where(eq(users.id, person));
  });
  await releaseAdmin?.();
});

test("removing a token server revokes every person's token and releases every person's grant", async () => {
  await adminRequest(admin, () =>
    store.removeServer(tokenServer, `${admin}@example.test`),
  );

  const [token] = await asPlatform(() =>
    database
      .select({ revokedAt: credentials.revokedAt })
      .from(credentials)
      .where(eq(credentials.id, personToken)),
  );
  // Live at the vendor with nothing left pointing at it, before.
  expect(token?.revokedAt).toBeInstanceOf(Date);

  const grants = await asPlatform(() =>
    database
      .select({ ref: pluginGrants.ref })
      .from(pluginGrants)
      .where(
        and(
          eq(pluginGrants.agentId, personBot),
          eq(pluginGrants.ref, tokenRef),
        ),
      ),
  );
  expect(grants).toEqual([]);

  // The trail names the person whose token went, and what was released.
  const trail = await asPlatform(() =>
    database
      .select({
        eventType: auditEvents.eventType,
        payload: auditEvents.payload,
      })
      .from(auditEvents)
      .where(eq(auditEvents.targetId, tokenServer)),
  );
  expect(
    trail.some(
      (row) =>
        row.eventType === "mcp.account_disconnected" &&
        (row.payload as Record<string, unknown>).owner === person,
    ),
  ).toBe(true);
  const removal = trail.find(
    (row) =>
      (row.payload as Record<string, unknown>).change === "mcp_server_removed",
  );
  const payload = (removal?.payload ?? {}) as Record<string, unknown>;
  expect(payload.releasedGrants).toEqual([tokenRef]);
  expect(payload.bots).toEqual([personBot]);
});

test("removing a brokered app ends every person's account at the broker and releases their grant", async () => {
  revoked.length = 0;
  await adminRequest(admin, () =>
    store.removeServer(brokeredServer, `${admin}@example.test`),
  );

  expect(revoked).toEqual([{ userId: person, toolkit: slug }]);
  expect(
    await asPlatform(() =>
      database
        .select({ userId: composioConnections.userId })
        .from(composioConnections)
        .where(eq(composioConnections.toolkit, slug)),
    ),
  ).toEqual([]);
  expect(
    await asPlatform(() =>
      database
        .select({ ref: pluginGrants.ref })
        .from(pluginGrants)
        .where(
          and(
            eq(pluginGrants.agentId, personBot),
            eq(pluginGrants.ref, brokeredRef),
          ),
        ),
    ),
  ).toEqual([]);
});
