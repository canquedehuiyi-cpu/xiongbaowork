import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import type { ActionPolicy } from "../src/computer/policy";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  credentials,
  mcpServers,
  mcpUserCredentials,
  users,
} from "../src/db/schema";
import { createPluginStore } from "../src/plugins/store";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Registering a client twice, and connecting twice, against a real vault.
 *
 * Both paths used to insert a second live credential for a key and revoke the first afterwards, on
 * a best-effort basis. `credentials_active_key_idx` refuses the second insert outright, so the
 * question is no longer whether an orphan is left behind but whether the path still works at all.
 * A stubbed vault cannot answer that: the index is a database object, and only a database enforces
 * it.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);

const ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const policy: ActionPolicy = { mode: "enforce", deny: [], allow: ["true"] };
const suite = randomUUID().slice(0, 8);
const serverId = "google-drive";
const personId = `plugin_rotation_person_${suite}`;

const store = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: createCredentialStore(database),
  encryptionKey: ENCRYPTION_KEY,
  policy: () => policy,
});

/**
 * The person here registers the client and connects, as an administrator of their own workspace
 * would: every route runs the store in the requester's frame, so the server row this run adds, the
 * vault rows and the connection are that person's.
 */
function asPerson<T>(work: () => Promise<T>) {
  return runAsTenant(personId, work);
}

/**
 * Questions about the deployment as a whole: whether a Drive row was already here (whoever holds
 * it), and the leftover live client registrations `credentials_active_key_idx` counts across every
 * tenant.
 */
function asPlatform<T>(work: () => Promise<T>) {
  return runAsTenant("platform", work);
}

let clientBefore: string | null = null;
let serverExisted = false;

async function rowsFor(
  kind: "mcp_oauth_client" | "mcp_user_token",
  keyId: string,
) {
  return asPerson(() =>
    database
      .select({ id: credentials.id, revokedAt: credentials.revokedAt })
      .from(credentials)
      .where(
        and(
          eq(credentials.kind, kind),
          eq(credentials.provider, serverId),
          eq(credentials.keyId, keyId),
        ),
      ),
  );
}

function live<T extends { revokedAt: Date | null }>(rows: T[]) {
  return rows.filter((row) => row.revokedAt === null);
}

beforeAll(async () => {
  await asPerson(() =>
    database
      .insert(users)
      .values({
        id: personId,
        email: `${personId}@openbot.test`,
        name: personId,
        emailVerified: false,
      })
      .onConflictDoNothing(),
  );

  const [existing] = await asPlatform(() =>
    database
      .select({ id: mcpServers.id, credentialId: mcpServers.credentialId })
      .from(mcpServers)
      .where(eq(mcpServers.id, serverId)),
  );
  serverExisted = existing !== undefined;
  clientBefore = existing?.credentialId ?? null;

  await asPerson(() =>
    database
      .insert(mcpServers)
      .values({
        id: serverId,
        title: "Google Drive",
        vendor: "Google",
        url: "https://www.googleapis.com/drive/v3",
        provenance: "first-party",
      })
      .onConflictDoNothing(),
  );

  // This run's own client key, so a deployment's real Drive registration is never touched.
  await asPlatform(() =>
    database
      .update(credentials)
      .set({ revokedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(credentials.kind, "mcp_oauth_client"),
          eq(credentials.provider, serverId),
          isNull(credentials.revokedAt),
        ),
      ),
  );
});

afterAll(async () => {
  await asPerson(() =>
    database
      .delete(mcpUserCredentials)
      .where(eq(mcpUserCredentials.userId, personId)),
  );
  /*
   * The pointer is dropped before the rows are, and put back only if what it named survives.
   *
   * `mcp_servers.credential_id` is a real foreign key, so a credential this run registered cannot be
   * deleted while the server still names it. Restoring first is not enough either: on a database
   * where an earlier run of this file left the pointer on one of its own rows, restoring puts it
   * straight back onto a row about to be deleted.
   */
  await asPlatform(() =>
    database
      .update(mcpServers)
      .set({ credentialId: null })
      .where(eq(mcpServers.id, serverId)),
  );
  const mine = [
    ...(await rowsFor("mcp_user_token", personId)),
    ...(await rowsFor("mcp_oauth_client", `oauth-client-${serverId}`)),
  ].map((row) => row.id);
  if (mine.length) {
    await asPerson(() =>
      database.delete(credentials).where(inArray(credentials.id, mine)),
    );
  }
  await asPerson(() => database.delete(users).where(eq(users.id, personId)));
  const restore = clientBefore;
  if (restore) {
    const [survivor] = await asPlatform(() =>
      database
        .select({ id: credentials.id })
        .from(credentials)
        .where(eq(credentials.id, restore)),
    );
    if (survivor) {
      await asPlatform(() =>
        database
          .update(mcpServers)
          .set({ credentialId: restore })
          .where(eq(mcpServers.id, serverId)),
      );
    }
  }
  if (!serverExisted) {
    await asPlatform(() =>
      database.delete(mcpServers).where(eq(mcpServers.id, serverId)),
    );
  }
  await database.$client.end();
});

describe("registering an OAuth client twice", () => {
  test("replaces the client rather than meeting the index", async () => {
    await asPerson(() =>
      store.registerOAuthClient({
        serverId,
        client: { clientId: `client-one-${suite}`, clientSecret: "one" },
        by: personId,
      }),
    );
    const first = live(
      await rowsFor("mcp_oauth_client", `oauth-client-${serverId}`),
    );
    expect(first).toHaveLength(1);

    await asPerson(() =>
      store.registerOAuthClient({
        serverId,
        client: { clientId: `client-two-${suite}`, clientSecret: "two" },
        by: personId,
      }),
    );

    const all = await rowsFor("mcp_oauth_client", `oauth-client-${serverId}`);
    expect(live(all)).toHaveLength(1);
    expect(live(all)[0]?.id).not.toBe(first[0]?.id);
    expect(all.filter((row) => row.revokedAt !== null).length).toBeGreaterThan(
      0,
    );

    const [server] = await asPerson(() =>
      database
        .select({ credentialId: mcpServers.credentialId })
        .from(mcpServers)
        .where(eq(mcpServers.id, serverId)),
    );
    expect(server?.credentialId).toBe(live(all)[0]?.id as string);
  });
});

describe("reconnecting the same person to the same server", () => {
  test("replaces their token rather than meeting the index", async () => {
    await asPerson(() =>
      store.recordConnection({
        serverId,
        userId: personId,
        refreshToken: "refresh-one",
        scope: "https://www.googleapis.com/auth/drive.readonly",
      }),
    );
    const first = live(await rowsFor("mcp_user_token", personId));
    expect(first).toHaveLength(1);

    await asPerson(() =>
      store.recordConnection({
        serverId,
        userId: personId,
        refreshToken: "refresh-two",
        scope: "https://www.googleapis.com/auth/drive.readonly",
      }),
    );

    const all = await rowsFor("mcp_user_token", personId);
    expect(live(all)).toHaveLength(1);
    expect(live(all)[0]?.id).not.toBe(first[0]?.id);

    const [connection] = await asPerson(() =>
      database
        .select({ credentialId: mcpUserCredentials.credentialId })
        .from(mcpUserCredentials)
        .where(
          and(
            eq(mcpUserCredentials.serverId, serverId),
            eq(mcpUserCredentials.userId, personId),
          ),
        ),
    );
    expect(connection?.credentialId).toBe(live(all)[0]?.id as string);
  });
});
