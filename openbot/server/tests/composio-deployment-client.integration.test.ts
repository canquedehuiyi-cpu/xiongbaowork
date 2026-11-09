import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, gte, inArray, like, sql } from "drizzle-orm";
import { Hono } from "hono";
import { createAuditStore } from "../src/audit";
import { createAdminScope } from "../src/auth/admin-scope";
import { type AppVariables, createRoleRepository } from "../src/auth/guards";
import { setRole } from "../src/auth/roles";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { auditEvents, credentials, mcpServers, users } from "../src/db/schema";
import type { ComposioBroker } from "../src/plugins/broker";
import { DEPLOYMENT_CLIENT_SCHEME } from "../src/plugins/deployment-clients";
import {
  CustomServerRefusedError,
  createPluginStore,
  PluginRefusedError,
} from "../src/plugins/store";
import { asPlatform, runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { bindTestRoleWriter } from "./support/role-writer";

/**
 * A deployment's own OAuth client for a server-to-server app (upstream #950), held in the vault.
 *
 * Upstream reads the pair from environment variables; this fork stores it the way it stores every
 * other OAuth client: an administrator holding the capability writes it, it is sealed to `team` in
 * an envelope bound to its row, no member's frame can see that it exists, nothing of the secret
 * reaches a listing or the trail, and the only place it travels is the authorization config the
 * broker creates at enable. A person is never connected on that client; only an administrator is.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = `dcl-${randomUUID().slice(0, 8)}`;
const ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const SECRET = `shpss_${randomUUID().replaceAll("-", "")}`;
const CLIENT = { client_id: `shpca_${suite}`, client_secret: SECRET };
/** An app name only this run uses, so the vault rows and the server row are this suite's own. */
const toolkit = `shop_${suite.replace(/-/g, "_")}`;
const serverId = `composio-${toolkit}`;

const admin = { id: `${suite}-admin`, role: "admin" as const };
const member = { id: `${suite}-member`, role: "user" as const };

/** What the broker was handed, and the one call this suite lets through to it. */
const enabled: unknown[] = [];
const ENABLE_STOPPED = "the enable stops here in this suite";
const unasked = (what: string) => async () => {
  throw new Error(`the broker was asked to ${what}`);
};
const broker = {
  listApps: unasked("list the catalogue"),
  ensureAuthConfig: async (request: unknown) => {
    enabled.push(request);
    // Stopped before anything is written: what is under test is what the store handed over.
    throw new Error(ENABLE_STOPPED);
  },
  deleteAuthConfig: unasked("delete an auth config"),
  authorize: unasked("begin somebody's connection"),
  isConnected: unasked("check somebody's connection"),
  revoke: unasked("withdraw somebody's grant"),
  connectionFields: unasked("draw a connect form"),
  connectWithFields: unasked("connect with typed fields"),
  revokeAccount: unasked("undo one account"),
} as unknown as ComposioBroker;

const vault = createCredentialStore(database);
const store = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: vault,
  encryptionKey: ENCRYPTION_KEY,
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  broker,
});

const adminScope = createAdminScope({
  roleRepository: createRoleRepository(database),
});
let releaseRoleWriter: (() => Promise<void>) | undefined;
let runStartedAt: Date | null = null;

/** An administrator's request: their own frame, holding the capability the middleware grants. */
async function asAdmin<T>(work: () => Promise<T>): Promise<T> {
  let outcome: { value: T } | { error: unknown } | undefined;
  const app = new Hono<{ Variables: AppVariables }>();
  app.use(
    "*",
    async (context, next) => {
      context.set("actor", { ...admin, email: `${admin.id}@example.test` });
      await runAsTenant(admin.id, () => next());
    },
    adminScope.adminCapability,
  );
  app.get("/", async (context) => {
    outcome = await work().then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    return context.body(null, 204);
  });
  await app.request("http://test/");
  if (!outcome) throw new Error("The admin request never ran its work.");
  if ("error" in outcome) throw outcome.error;
  return outcome.value;
}

const asMember = <T>(work: () => Promise<T>): Promise<T> =>
  runAsTenant(member.id, work);

/** This suite's vault rows, as `platform` sees them. */
const vaultRows = () =>
  asPlatform(() =>
    database
      .select({
        id: credentials.id,
        tenantId: credentials.tenantId,
        kind: credentials.kind,
        encryptedValue: credentials.encryptedValue,
        metadata: credentials.metadata,
        revokedAt: credentials.revokedAt,
      })
      .from(credentials)
      .where(like(credentials.keyId, `%${toolkit}`)),
  );

beforeAll(async () => {
  releaseRoleWriter = await bindTestRoleWriter(database);
  await asPlatform(async () => {
    const [clock] = await database.execute<{ now: Date }>(
      sql`select now() as now`,
    );
    if (!clock) throw new Error("the database would not say what time it is");
    runStartedAt = clock.now;
    await database.insert(users).values(
      [admin, member].map((person) => ({
        id: person.id,
        email: `${person.id}@example.test`,
      })),
    );
    await setRole(database, admin.id, "admin");
  });
});

afterAll(async () => {
  await asPlatform(async () => {
    await database.delete(mcpServers).where(eq(mcpServers.id, serverId));
    await database
      .delete(credentials)
      .where(like(credentials.keyId, `%${toolkit}`));
    await database
      .delete(users)
      .where(inArray(users.id, [admin.id, member.id]));
  });
  await releaseRoleWriter?.();
  await database.$client.close();
});

describe("the deployment's own client for a server-to-server app", () => {
  test("a member can neither store one nor see that one is held", async () => {
    await expect(
      asMember(() =>
        store.storeDeploymentClient({ toolkit, client: CLIENT, by: "member" }),
      ),
    ).rejects.toBeInstanceOf(CustomServerRefusedError);
    expect(await vaultRows()).toEqual([]);
  });

  test("an administrator stores it sealed to `team`, and nothing of the secret is readable", async () => {
    expect(
      await asAdmin(() =>
        store.storeDeploymentClient({
          toolkit,
          client: CLIENT,
          by: "admin@example.test",
        }),
      ),
    ).toEqual({ replaced: false });

    const rows = await vaultRows();
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row?.tenantId).toBe("team");
    expect(row?.kind).toBe("mcp_oauth_client");
    expect(row?.revokedAt).toBeNull();
    expect(row?.encryptedValue).not.toContain(SECRET);
    expect(JSON.stringify(row?.metadata)).not.toContain(SECRET);
    expect(row?.metadata).toEqual({ toolkit, clientId: CLIENT.client_id });
    // A v2 envelope, bound to the row it was written for.
    expect(JSON.parse(row?.encryptedValue ?? "{}").version).toBe(2);

    const listed = await asAdmin(() => store.listDeploymentClients());
    expect(listed.filter((entry) => entry.toolkit === toolkit)).toEqual([
      expect.objectContaining({ toolkit, clientId: CLIENT.client_id }),
    ]);
    expect(JSON.stringify(listed)).not.toContain(SECRET);

    // The trail names the app, the client id and who; never the secret.
    const trail = await asPlatform(() =>
      database
        .select({ payload: auditEvents.payload })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.targetId, toolkit),
            gte(auditEvents.createdAt, runStartedAt ?? new Date(0)),
          ),
        ),
    );
    expect(trail.length).toBeGreaterThan(0);
    expect(JSON.stringify(trail)).not.toContain(SECRET);
  });

  test("an administrator's frame finds the app held; a member's finds nothing", async () => {
    expect(
      (await asAdmin(() => store.deploymentClientToolkits())).has(toolkit),
    ).toBe(true);
    expect(
      (await asMember(() => store.deploymentClientToolkits())).has(toolkit),
    ).toBe(false);
  });

  test("storing again replaces it: one live row, the previous one revoked", async () => {
    const replacement = { ...CLIENT, client_id: `${CLIENT.client_id}-2` };
    expect(
      await asAdmin(() =>
        store.storeDeploymentClient({
          toolkit,
          client: replacement,
          by: "admin@example.test",
        }),
      ),
    ).toEqual({ replaced: true });
    const rows = await vaultRows();
    expect(rows.filter((row) => row.revokedAt === null)).toHaveLength(1);
    expect(rows.filter((row) => row.revokedAt !== null)).toHaveLength(1);
    // Back to the original for the enable below.
    await asAdmin(() =>
      store.storeDeploymentClient({
        toolkit,
        client: CLIENT,
        by: "admin@example.test",
      }),
    );
  });

  test("enabling the app hands the broker the client opened out of the vault", async () => {
    enabled.length = 0;
    await expect(
      asAdmin(() =>
        store.addBrokeredApp({
          slug: toolkit,
          title: "Shop",
          by: "admin@example.test",
          connection: { kind: "fields", authScheme: DEPLOYMENT_CLIENT_SCHEME },
        }),
      ),
    ).rejects.toThrow(ENABLE_STOPPED);
    expect(enabled).toEqual([
      {
        toolkit,
        name: "Shop",
        connection: { kind: "fields", authScheme: DEPLOYMENT_CLIENT_SCHEME },
        client: CLIENT,
      },
    ]);
  });

  test("a key app's enable is handed no client at all", async () => {
    enabled.length = 0;
    await expect(
      asAdmin(() =>
        store.addBrokeredApp({
          slug: toolkit,
          title: "Shop",
          by: "admin@example.test",
          connection: { kind: "fields", authScheme: "API_KEY" },
        }),
      ),
    ).rejects.toThrow(ENABLE_STOPPED);
    expect(enabled).toEqual([
      {
        toolkit,
        name: "Shop",
        connection: { kind: "fields", authScheme: "API_KEY" },
      },
    ]);
  });

  test("removing it revokes the row, and the app is no longer held", async () => {
    expect(
      await asAdmin(() =>
        store.removeDeploymentClient({ toolkit, by: "admin@example.test" }),
      ),
    ).toEqual({ removed: true });
    expect((await vaultRows()).filter((row) => row.revokedAt === null)).toEqual(
      [],
    );
    expect(
      (await asAdmin(() => store.deploymentClientToolkits())).has(toolkit),
    ).toBe(false);
    expect(
      await asAdmin(() =>
        store.removeDeploymentClient({ toolkit, by: "admin@example.test" }),
      ),
    ).toEqual({ removed: false });
  });
});

describe("an enabled app on the deployment's own client", () => {
  beforeAll(async () => {
    await asPlatform(async () => {
      await database.insert(mcpServers).values({
        id: serverId,
        tenantId: "team",
        title: "Shop",
        vendor: "Composio",
        url: `composio://${toolkit}`,
        provenance: "composio",
        authScheme: DEPLOYMENT_CLIENT_SCHEME,
      });
    });
  });

  test("is listed as one only an administrator connects", async () => {
    const row = (await asMember(() => store.listServers())).find(
      (server) => server.id === serverId,
    );
    expect(row?.authScheme).toBe(DEPLOYMENT_CLIENT_SCHEME);
    expect(row?.adminConnectOnly).toBe(true);
  });

  test("a person is refused before anything reaches the broker", async () => {
    const refused = asMember(() =>
      store.connectBrokeredWithFields({
        toolkit,
        userId: member.id,
        values: { subdomain: "acme-store" },
      }),
    );
    await expect(refused).rejects.toBeInstanceOf(PluginRefusedError);
    await expect(refused).rejects.toThrow("只有管理员能连接");
  });

  test("an administrator's connect reaches the broker", async () => {
    // The stub refuses every connect: reaching it at all is what an administrator's press earns.
    await expect(
      asAdmin(() =>
        store.connectBrokeredWithFields({
          toolkit,
          userId: admin.id,
          values: { subdomain: "acme-store" },
          byAdmin: true,
        }),
      ),
    ).rejects.toThrow("the broker was asked to connect with typed fields");
  });
});
