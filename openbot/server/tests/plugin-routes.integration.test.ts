import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { createApp } from "../src/app";
import { createAuditStore } from "../src/audit";
import { loadConfig } from "../src/config";
import { encryptSecret } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { credentials, mcpServers, mcpTools } from "../src/db/schema";
import { atServerAddress, createPluginStore } from "../src/plugins/store";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";

/**
 * The whole path an administrator's request actually takes, with nothing stubbed between the request
 * and the row.
 *
 * The two halves are covered on their own: the store's refusals against a real database, and the
 * route's mapping of them against a stubbed store. Both passing does not prove the pair is wired
 * together, and the failure that would live in the gap is quiet in exactly the way that matters: a
 * refusal that reaches the browser as a 500 reads as a broken deployment rather than a correctable
 * mistake, and a refusal that stops short of the write leaves a row pointing at a credential the
 * next refresh spends. So this asks the question end to end and then looks in the table.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);

const store = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: {
    // Never read: Drive's tool list is in this deployment's own code, so the add path here reaches
    // no vault. Loud rather than absent, so a call that starts reaching one is named.
    readSecret: async () => {
      throw new Error("this suite does not read credentials");
    },
    create: async () => {
      throw new Error("this suite does not write credentials");
    },
    revoke: async () => {
      throw new Error("this suite does not revoke credentials");
    },
  },
  encryptionKey: "x".repeat(44),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
});

const ADMIN = {
  id: "admin-1",
  email: "admin@openbot.test",
  name: "An Administrator",
  image: null,
};

/**
 * Read or clean up in the frame the request itself ran in.
 *
 * The auth guard wraps every request in `runAsTenant(session.user.id)`, so the rows this suite writes
 * belong to `admin-1` — and a SELECT outside any frame is a `system` frame, which cannot see them. Left
 * that way, "nothing was written" passed because the reader was blind rather than because the refusal
 * stopped the write, and the teardown could not delete the rows it had just created: the credential
 * rows it tried to free stayed referenced, and the foreign key reported that as an anonymous failure.
 */
function asAdmin<T>(read: () => Promise<T>) {
  return runAsTenant(ADMIN.id, read);
}

function request(
  body: unknown,
  role: "admin" | "user" = "admin",
  path = "/api/plugins/servers",
) {
  const app = createApp(
    loadConfig(testEnvironment()),
    {
      handler: () => new Response(null, { status: 204 }),
      api: { getSession: async () => ({ user: ADMIN }) },
    } as never,
    { rolesForUser: async () => [role] },
    // Positions 4-14 are the other stores; the real one is 15, pluginStore.
    ...(Array.from({ length: 11 }) as never[]),
    store as never,
  );

  return app.request(`http://openbot.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const serverId = "google-drive";
const suffix = randomUUID().slice(0, 8);
const personalCredentialId = randomUUID();
const customServerId = `route-custom-${suffix}`;
const foreignCredentialId = randomUUID();
const ownCredentialId = randomUUID();

/** What this deployment already had, so a database somebody is using is left as it was found. */
let existing: Awaited<ReturnType<typeof entryRow>> = null;

beforeAll(async () => {
  existing = await entryRow();

  const encrypted = await encryptSecret(`${"A".repeat(43)}=`, "not-read-here");
  await database.insert(credentials).values([
    {
      id: personalCredentialId,
      kind: "mcp_user_token",
      provider: serverId,
      keyId: `user_someone_else_${suffix}`,
      encryptedValue: encrypted,
      metadata: {},
    },
    {
      id: foreignCredentialId,
      kind: "mcp",
      // Minted for a different server, which is what makes it somebody else's to spend.
      provider: `route-elsewhere-${suffix}`,
      keyId: `mcp-elsewhere-${suffix}`,
      encryptedValue: encrypted,
      metadata: {},
    },
    {
      id: ownCredentialId,
      kind: "mcp",
      provider: customServerId,
      keyId: `mcp-${customServerId}`,
      encryptedValue: encrypted,
      metadata: {},
    },
  ]);
});

afterAll(async () => {
  // The ids are read back rather than assumed, and the cleanup runs in the actor's frame: DELETE is
  // governed only by the USING half of the policy, so a `system`-frame delete of an `admin-1` row
  // matches nothing and leaves the row holding a credential the teardown then cannot free.
  const curated = await entryRow();
  const custom = await customRow();
  const ids = [curated?.id, custom?.id].filter(
    (id): id is string => id != null,
  );
  await asAdmin(async () => {
    if (ids.length > 0) {
      await database.delete(mcpTools).where(inArray(mcpTools.serverId, ids));
    }
    if (curated?.id) {
      if (existing) {
        await database
          .update(mcpServers)
          .set({ credentialId: existing.credentialId })
          .where(eq(mcpServers.id, curated.id));
      } else {
        await database.delete(mcpServers).where(eq(mcpServers.id, curated.id));
      }
    }
    if (custom?.id) {
      await database.delete(mcpServers).where(eq(mcpServers.id, custom.id));
    }
  });
  await database
    .delete(credentials)
    .where(
      inArray(credentials.id, [
        personalCredentialId,
        foreignCredentialId,
        ownCredentialId,
      ]),
    );
});

/**
 * The row this tenant holds for the catalogue entry.
 *
 * Addressed by the entry, not by a name the suite assumed: after ADR-0002 the row's identity is the
 * tenant's own and `catalogue_key` is what says which app it instantiates. The tenant filter is
 * deliberate even inside the tenant's frame, because the frame can also see the platform's rows, and
 * "which row did MY add write" has one answer.
 */
async function entryRow() {
  return await asAdmin(async () => {
    const [row] = await database
      .select({
        id: mcpServers.id,
        credentialId: mcpServers.credentialId,
        url: mcpServers.url,
      })
      .from(mcpServers)
      .where(and(atServerAddress(serverId), eq(mcpServers.tenantId, ADMIN.id)));
    return row ?? null;
  });
}

/** A server the administrator addressed by URL is its own thing — the typed name is the row's id. */
async function customRow() {
  return await asAdmin(async () => {
    const [row] = await database
      .select({
        id: mcpServers.id,
        credentialId: mcpServers.credentialId,
        url: mcpServers.url,
      })
      .from(mcpServers)
      .where(
        and(
          eq(mcpServers.id, customServerId),
          eq(mcpServers.tenantId, ADMIN.id),
        ),
      );
    return row ?? null;
  });
}

describe("adding a curated server over HTTP", () => {
  test("a credential of the wrong kind is refused, and nothing is written", async () => {
    const before = await entryRow();

    const response = await request({
      key: serverId,
      credentialId: personalCredentialId,
    });

    // Not a 500. An administrator who picked the wrong row is told what to do about it.
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain(
      "takes no credential when it is added",
    );

    // And the refusal stopped the write rather than reporting on it.
    expect(await entryRow()).toEqual(before);
  });

  test("a malformed credential id is refused the same way, not as a database error", async () => {
    const response = await request({ key: serverId, credentialId: "nonsense" });

    expect(response.status).toBe(400);
  });

  test("the add the admin screen makes still works and writes the row", async () => {
    const response = await request({ key: serverId });

    expect(response.status).toBe(200);
    // The id the screen is handed back is the row this tenant now holds, and that is what every later
    // call names. It is deliberately not compared to the catalogue key: after the split the key says
    // which app the row instantiates, and the tenant may hold one row per key with its own name.
    const row = await entryRow();
    expect((await response.json()).server.id).toBe(row?.id);
    expect(row).not.toBeNull();
    // Whatever the column held before, not null: an add that names no credential leaves a registered
    // OAuth client alone, so asserting null here would pass on a fresh database and fail on the one
    // deployment shape that behaviour exists for.
    expect(row?.credentialId).toEqual(existing?.credentialId ?? null);
  });

  test("somebody who is not an administrator is refused before the store", async () => {
    const response = await request({ key: serverId }, "user");

    expect(response.status).toBe(403);
  });
});

/**
 * The same two rules, asked over HTTP against the real store.
 *
 * Both are refusals an administrator has to be able to act on, so what they must never be is a 500:
 * "something went wrong" sends somebody to look at the deployment when the answer is to pick a
 * different token or remove the server first.
 */
describe("adding a server by URL over HTTP", () => {
  const custom = "/api/plugins/servers/custom";

  test("another server's token is refused rather than spent", async () => {
    const response = await request(
      {
        id: customServerId,
        title: "Collector",
        url: "https://collector.attacker.example/mcp",
        credentialId: foreignCredentialId,
      },
      "admin",
      custom,
    );

    expect(response.status).toBe(400);

    expect(await customRow()).toBeNull();
  });

  test("re-addressing a server that holds a token is refused", async () => {
    const added = await request(
      {
        id: customServerId,
        title: "Collector",
        url: "https://legit.vendor.example/mcp",
        credentialId: ownCredentialId,
      },
      "admin",
      custom,
    );
    expect(added.status).toBe(200);

    const moved = await request(
      {
        id: customServerId,
        title: "Collector",
        url: "https://collector.attacker.example/mcp",
        credentialId: ownCredentialId,
      },
      "admin",
      custom,
    );
    expect(moved.status).toBe(400);

    expect((await customRow())?.url).toBe("https://legit.vendor.example/mcp");
  });
});
