import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import {
  type CredentialBinding,
  CredentialUnusableError,
  createCredential,
  createCredentialStore,
  decryptCredentialForUse,
  decryptSecret,
  encryptSecret,
  openCredential,
  resolveModelApiKey,
  revokeCredential,
  rotateCredential,
  sealCredential,
  vaultRequiresAad,
} from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { credentials } from "../src/db/schema";
import { asPlatform, runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";

const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const config = loadConfig(testEnvironment({ KEY_ENCRYPTION_KEY: key }));
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const credentialIds: string[] = [];

/** Rows written under a tenant scope, which row security hides from the unscoped cleanup above. */
const tenantCredentialIds: { tenant: string; id: string }[] = [];

/**
 * The administrator every vault row in this file is written, read and removed as. The credential
 * routes reach the store inside the request's frame, `runAsTenant(actor.id)`, so a test that talks
 * to the real store does it in that person's frame too rather than in the unframed fallback.
 */
const ADMIN = "admin";
function asAdmin<T>(work: () => Promise<T>) {
  return runAsTenant(ADMIN, work);
}

afterEach(async () => {
  for (const credentialId of credentialIds.splice(0)) {
    await asAdmin(() =>
      database.delete(credentials).where(eq(credentials.id, credentialId)),
    );
  }
  for (const { tenant, id } of tenantCredentialIds.splice(0)) {
    await runAsTenant(tenant, () =>
      database.delete(credentials).where(eq(credentials.id, id)),
    );
  }
});

describe("credential encryption", () => {
  test("stores a versioned AES-GCM envelope and restores it only server-side", async () => {
    const envelope = await encryptSecret(key, "openai-secret-value");

    expect(JSON.parse(envelope)).toEqual({
      version: 1,
      iv: expect.any(String),
      ciphertext: expect.any(String),
    });
    await expect(decryptSecret(key, envelope)).resolves.toBe(
      "openai-secret-value",
    );
  });

  test("creates a write-only credential and audits safe metadata", async () => {
    const stored: unknown[] = [];
    const audited: unknown[] = [];

    const credential = await createCredential(
      {
        encryptionKey: key,
        store: {
          create: async (value) => {
            stored.push(value);
            return { id: "credential-1", revokedAt: null };
          },
          // An administrator's credential is replaced by a new row, never edited in place, so a
          // call here would mean this path had changed shape.
          updateSecret: async () => {
            throw new Error(
              "administrator credentials are not updated in place",
            );
          },
          rotate: async () => {
            throw new Error("nothing live to replace, so create is the path");
          },
          revoke: async () => new Date(),
          isLive: async () => false,
          findLiveByKey: async () => null,
        },
        auditStore: {
          insert: async (event) => {
            audited.push(event);
          },
        },
      },
      {
        kind: "model",
        provider: "openai",
        keyId: "primary",
        metadata: { label: "Production OpenAI" },
        plaintext: "openai-secret-value",
        actorUserId: "admin",
      },
    );

    expect(credential).toEqual({
      id: "credential-1",
      kind: "model",
      provider: "openai",
      keyId: "primary",
      metadata: { label: "Production OpenAI" },
      revokedAt: null,
    });
    expect(JSON.stringify(stored)).not.toContain("openai-secret-value");
    expect(audited).toEqual([
      {
        eventType: "credential.created",
        targetType: "credential",
        targetId: "credential-1",
        actorUserId: "admin",
        payload: {
          kind: "model",
          provider: "openai",
          keyId: "primary",
        },
      },
    ]);
  });

  test("rotates then revokes credentials without returning plaintext", async () => {
    const rotated: { previousCredentialId: string }[] = [];
    const revoked: string[] = [];
    const audited: unknown[] = [];
    const service = {
      encryptionKey: key,
      store: {
        create: async () => ({ id: "credential-unused", revokedAt: null }),
        updateSecret: async () => {
          throw new Error("administrator credentials are not updated in place");
        },
        rotate: async (input: { previousCredentialId: string }) => {
          rotated.push(input);
          return { id: "credential-new", revokedAt: null };
        },
        revoke: async (id: string) => {
          revoked.push(id);
          return new Date("2026-08-13T12:00:00.000Z");
        },
      },
      auditStore: {
        insert: async (event: unknown) => {
          audited.push(event);
        },
      },
    };

    await rotateCredential(service, {
      previousCredentialId: "credential-old",
      kind: "model",
      provider: "openai",
      keyId: "secondary",
      metadata: { label: "Rotated OpenAI" },
      plaintext: "new-openai-secret",
      actorUserId: "admin",
    });
    await revokeCredential(service, "credential-new", "admin");

    // The rotation retires the previous credential inside the store's own
    // transaction, so the service makes no separate revoke call of its own.
    expect(rotated.map((call) => call.previousCredentialId)).toEqual([
      "credential-old",
    ]);
    expect(revoked).toEqual(["credential-new"]);
    expect(JSON.stringify(rotated)).not.toContain("new-openai-secret");
    expect(JSON.stringify(audited)).not.toContain("new-openai-secret");
    expect(
      audited.map((event) => (event as { eventType: string }).eventType),
    ).toEqual(["credential.rotated", "credential.revoked"]);
  });

  test("records the refusal when the rotation fails, and never a success", async () => {
    // The store's rotate is one transaction, so a failure commits nothing and
    // no row may say a rotation happened. The refusal itself is recorded
    // though: a rotation aimed at a revoked credential, at one that does not
    // exist, or at a key other than the credential's own is either a caller
    // with a bug or an attempt to retire somebody else's key, and it used to
    // leave nothing behind. The caller still sees the original cause.
    const audited: unknown[] = [];
    const service = {
      encryptionKey: key,
      store: {
        create: async () => {
          throw new Error("create is not part of a rotation");
        },
        rotate: async () => {
          throw new Error("Previous credential is already revoked");
        },
        revoke: async () => {
          throw new Error("revoke is not part of a failed rotation");
        },
      },
      auditStore: {
        insert: async (event: unknown) => {
          audited.push(event);
        },
      },
    };

    await expect(
      rotateCredential(service, {
        previousCredentialId: "credential-old",
        kind: "model",
        provider: "openai",
        keyId: "primary",
        metadata: {},
        plaintext: "new-openai-secret",
        actorUserId: "admin",
      }),
    ).rejects.toThrow("Previous credential is already revoked");

    expect(audited).toEqual([
      {
        eventType: "credential.rotation_refused",
        targetType: "credential",
        targetId: "credential-old",
        actorUserId: "admin",
        payload: {
          kind: "model",
          provider: "openai",
          keyId: "primary",
          reason: "Previous credential is already revoked",
        },
      },
    ]);
  });

  test("decrypts only an active credential for server-side use", async () => {
    const encryptedValue = await encryptSecret(key, "connector-secret");

    await expect(
      decryptCredentialForUse(
        key,
        { readSecret: async () => ({ encryptedValue, revokedAt: null }) },
        "credential-1",
      ),
    ).resolves.toBe("connector-secret");
    await expect(
      decryptCredentialForUse(
        key,
        { readSecret: async () => ({ encryptedValue, revokedAt: new Date() }) },
        "credential-1",
      ),
    ).rejects.toThrow("Credential is revoked");
  });
});

describe("model credential resolution", () => {
  test("prefers a stored model credential over the environment", async () => {
    const encryptedValue = await encryptSecret(key, "stored-openai-key");

    await expect(
      resolveModelApiKey({
        encryptionKey: key,
        reader: {
          readModelSecret: async () => ({ encryptedValue }),
        },
        provider: "openai",
        keyId: "openai-api-key",
        environment: { OPENAI_API_KEY: "environment-openai-key" },
      }),
    ).resolves.toBe("stored-openai-key");
  });

  test("uses OPENAI_API_KEY when no stored credential exists", async () => {
    await expect(
      resolveModelApiKey({
        encryptionKey: key,
        reader: { readModelSecret: async () => null },
        provider: "openai",
        keyId: "openai-api-key",
        environment: { OPENAI_API_KEY: " environment-openai-key " },
      }),
    ).resolves.toBe("environment-openai-key");
  });

  test("returns null when neither credential source is configured", async () => {
    await expect(
      resolveModelApiKey({
        encryptionKey: key,
        reader: { readModelSecret: async () => null },
        provider: "openai",
        keyId: "openai-api-key",
        environment: {},
      }),
    ).resolves.toBeNull();
  });

  test("rejects corrupt stored ciphertext instead of falling back to the environment", async () => {
    await expect(
      resolveModelApiKey({
        encryptionKey: key,
        reader: {
          readModelSecret: async () => ({ encryptedValue: "corrupt" }),
        },
        provider: "openai",
        keyId: "openai-api-key",
        environment: { OPENAI_API_KEY: "environment-openai-key" },
      }),
    ).rejects.toThrow("Credential envelope is invalid");
  });
});

describe("model credential store lookup", () => {
  test("selects the live matching model credential and ignores the rest", async () => {
    // A key holds one live credential, which `credentials_active_key_idx`
    // enforces, so the lookup never has more than one candidate to choose
    // between. What is under test is the filter: the rows that do not match on
    // kind, provider or keyId, and the revoked row for this very key, all have
    // to be passed over.
    const activeId = randomUUID();
    const ignoredIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    credentialIds.push(activeId, ...ignoredIds);

    await asAdmin(() =>
      database.insert(credentials).values([
        {
          id: activeId,
          kind: "model",
          provider: "openai",
          keyId: "openai-api-key",
          encryptedValue: "active-value",
          metadata: {},
          createdAt: new Date("2026-02-01T00:00:00.000Z"),
        },
        {
          id: ignoredIds[0]!,
          kind: "connector",
          provider: "openai",
          keyId: "openai-api-key",
          encryptedValue: "wrong-kind-value",
          metadata: {},
          createdAt: new Date("2026-03-01T00:00:00.000Z"),
        },
        {
          id: ignoredIds[1]!,
          kind: "model",
          provider: "other",
          keyId: "openai-api-key",
          encryptedValue: "wrong-provider-value",
          metadata: {},
          createdAt: new Date("2026-03-01T00:00:00.000Z"),
        },
        {
          id: ignoredIds[2]!,
          kind: "model",
          provider: "openai",
          keyId: "other-api-key",
          encryptedValue: "wrong-key-value",
          metadata: {},
          createdAt: new Date("2026-03-01T00:00:00.000Z"),
        },
        {
          id: ignoredIds[3]!,
          kind: "model",
          provider: "openai",
          keyId: "openai-api-key",
          encryptedValue: "revoked-value",
          metadata: {},
          revokedAt: new Date("2026-03-01T00:00:00.000Z"),
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      ]),
    );

    await expect(
      asAdmin(() =>
        createCredentialStore(database).readModelSecret({
          provider: "openai",
          keyId: "openai-api-key",
        }),
      ),
    ).resolves.toMatchObject({ encryptedValue: "active-value" });
  });
});

describe("credential store rotation", () => {
  test("retires the previous credential and stores the new one together", async () => {
    const store = createCredentialStore(database);
    const previousId = randomUUID();
    const keyId = `rotation-atomic-${previousId}`;
    credentialIds.push(previousId);
    await asAdmin(() =>
      database.insert(credentials).values({
        id: previousId,
        kind: "model",
        provider: "openai",
        keyId,
        encryptedValue: "initial",
        metadata: {},
      }),
    );

    const rotated = await asAdmin(() =>
      store.rotate({
        previousCredentialId: previousId,
        kind: "model",
        provider: "openai",
        keyId,
        metadata: {},
        encryptedValue: "rotated",
      }),
    );
    credentialIds.push(rotated.id);

    const rows = await asAdmin(() =>
      database
        .select({
          id: credentials.id,
          encryptedValue: credentials.encryptedValue,
          revokedAt: credentials.revokedAt,
        })
        .from(credentials)
        .where(eq(credentials.keyId, keyId)),
    );
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]));

    expect(byId[previousId]?.revokedAt).not.toBeNull();
    expect(byId[rotated.id]?.revokedAt).toBeNull();
    expect(byId[rotated.id]?.encryptedValue).toBe("rotated");
  });

  test("refuses a previous credential that is already revoked, and stores nothing", async () => {
    const store = createCredentialStore(database);
    const previousId = randomUUID();
    const keyId = `rotation-revoked-${previousId}`;
    credentialIds.push(previousId);
    await asAdmin(() =>
      database.insert(credentials).values({
        id: previousId,
        kind: "model",
        provider: "openai",
        keyId,
        encryptedValue: "initial",
        metadata: {},
        revokedAt: new Date("2026-08-01T00:00:00.000Z"),
      }),
    );

    await expect(
      asAdmin(() =>
        store.rotate({
          previousCredentialId: previousId,
          kind: "model",
          provider: "openai",
          keyId,
          metadata: {},
          encryptedValue: "rotated",
        }),
      ),
    ).rejects.toThrow("already revoked");

    const rows = await asAdmin(() =>
      database
        .select({ id: credentials.id })
        .from(credentials)
        .where(eq(credentials.keyId, keyId)),
    );
    expect(rows.map((row) => row.id)).toEqual([previousId]);
  });

  test("refuses a previous credential that does not exist, and stores nothing", async () => {
    const store = createCredentialStore(database);
    const missing = randomUUID();
    const keyId = `rotation-missing-${missing}`;

    await expect(
      asAdmin(() =>
        store.rotate({
          previousCredentialId: missing,
          kind: "model",
          provider: "openai",
          keyId,
          metadata: {},
          encryptedValue: "orphan-if-broken",
        }),
      ),
    ).rejects.toThrow("not found");

    // Nothing was written, so the failed rotation left no credential behind
    // for this key at all.
    const rows = await asAdmin(() =>
      database
        .select({ id: credentials.id })
        .from(credentials)
        .where(eq(credentials.keyId, keyId)),
    );
    expect(rows).toEqual([]);
  });

  test("refuses a rotation aimed at a different kind, provider or keyId", async () => {
    // Rotating one credential with another's identity would retire a secret
    // the caller never named and leave its key with nothing live, which is a
    // worse outcome than a raised error.
    const store = createCredentialStore(database);
    const previousId = randomUUID();
    const previousKey = `mismatch-previous-${previousId}`;
    credentialIds.push(previousId);
    await asAdmin(() =>
      database.insert(credentials).values({
        id: previousId,
        kind: "model",
        provider: "openai",
        keyId: previousKey,
        encryptedValue: "previous",
        metadata: {},
      }),
    );

    await expect(
      asAdmin(() =>
        store.rotate({
          previousCredentialId: previousId,
          kind: "model",
          provider: "openai",
          keyId: `mismatch-input-${previousId}`,
          metadata: {},
          encryptedValue: "would-retire-the-wrong-secret",
        }),
      ),
    ).rejects.toThrow("does not match");

    const [after] = await asAdmin(() =>
      database
        .select({ revokedAt: credentials.revokedAt })
        .from(credentials)
        .where(eq(credentials.id, previousId)),
    );
    expect(after?.revokedAt).toBeNull();
  });

  test("refuses to revoke a credential that is already revoked", async () => {
    const store = createCredentialStore(database);
    const id = randomUUID();
    credentialIds.push(id);
    await asAdmin(() =>
      database.insert(credentials).values({
        id,
        kind: "model",
        provider: "openai",
        keyId: `revoke-guard-${id}`,
        encryptedValue: "one",
        metadata: {},
        revokedAt: new Date("2026-08-01T00:00:00.000Z"),
      }),
    );

    await expect(asAdmin(() => store.revoke(id))).rejects.toThrow(
      "already revoked",
    );
    // As a refusal the route can answer with a status, not an error it can only pass on as a 500.
    await expect(asAdmin(() => store.revoke(id))).rejects.toMatchObject({
      name: "CredentialRefusedError",
      status: 404,
    });
  });
});

describe("one live credential per key", () => {
  test("the index refuses a second live credential for the same key", async () => {
    const first = randomUUID();
    const second = randomUUID();
    credentialIds.push(first, second);
    const keyId = `unique-active-${first}`;
    await asAdmin(() =>
      database.insert(credentials).values({
        id: first,
        kind: "model",
        provider: "openai",
        keyId,
        encryptedValue: "first",
        metadata: {},
      }),
    );

    await expect(
      asAdmin(async () =>
        database.insert(credentials).values({
          id: second,
          kind: "model",
          provider: "openai",
          keyId,
          encryptedValue: "second",
          metadata: {},
        }),
      ),
    ).rejects.toThrow();
  });

  test("storing a credential for a key that has one replaces it", async () => {
    // The Credentials page offers Add and Revoke and no rotate control, so
    // replacing a key is done by adding one for the same provider and keyId.
    // That has to retire what is there rather than raise a unique violation.
    const audited: { eventType: string; targetId?: string }[] = [];
    const service = {
      encryptionKey: key,
      store: createCredentialStore(database),
      auditStore: {
        insert: async (event: { eventType: string; targetId?: string }) => {
          audited.push(event);
        },
      },
    };
    const keyId = `replace-on-add-${randomUUID()}`;

    const first = await asAdmin(() =>
      createCredential(service, {
        kind: "model",
        provider: "openai",
        keyId,
        metadata: {},
        plaintext: "first-secret",
        actorUserId: "admin",
      }),
    );
    credentialIds.push(first.id);

    const second = await asAdmin(() =>
      createCredential(service, {
        kind: "model",
        provider: "openai",
        keyId,
        metadata: {},
        plaintext: "second-secret",
        actorUserId: "admin",
      }),
    );
    credentialIds.push(second.id);

    expect(second.id).not.toBe(first.id);
    const rows = await asAdmin(() =>
      database
        .select({ id: credentials.id, revokedAt: credentials.revokedAt })
        .from(credentials)
        .where(eq(credentials.keyId, keyId)),
    );
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
    expect(byId[first.id]?.revokedAt).not.toBeNull();
    expect(byId[second.id]?.revokedAt).toBeNull();

    // The trail says what happened: an addition, then a replacement naming it.
    expect(audited.map((event) => event.eventType)).toEqual([
      "credential.created",
      "credential.rotated",
    ]);
  });
});

/**
 * The in-place write, which exists for one caller: a connector whose vendor rotates its refresh
 * token on every exchange. Everything else replaces a credential by writing a new row and revoking
 * the old one, because that is the act that has an old grant to withdraw.
 */
describe("credential secret update", () => {
  /** A live `mcp_user_token` row, which is the only kind of row this write is for. */
  async function liveCredential(plaintext: string, revoked = false) {
    const id = randomUUID();
    credentialIds.push(id);
    const encryptedValue = await encryptSecret(key, plaintext);
    await asAdmin(() =>
      database.insert(credentials).values({
        id,
        kind: "mcp_user_token",
        provider: "notion",
        keyId: `user-${id}`,
        encryptedValue,
        metadata: {},
        revokedAt: revoked ? new Date("2026-03-01T00:00:00.000Z") : null,
      }),
    );
    return id;
  }

  test("re-encrypts a live row without moving it", async () => {
    const store = createCredentialStore(database);
    const id = await liveCredential("rt-1");

    const rotated = await encryptSecret(key, "rt-2");
    await asAdmin(() => store.updateSecret(id, rotated));

    // The same row, addressed by the same id everything else already holds, now carrying the new
    // token — and still live, because nothing about the grant changed.
    const stored = await asAdmin(() => store.readSecret(id));
    expect(stored?.revokedAt).toBeNull();
    await expect(
      decryptSecret(key, stored?.encryptedValue ?? ""),
    ).resolves.toBe("rt-2");
  });

  test("refuses a revoked row rather than bringing it back to life", async () => {
    const store = createCredentialStore(database);
    const id = await liveCredential("rt-1", true);

    const rotated = await encryptSecret(key, "rt-2");
    await expect(
      asAdmin(() => store.updateSecret(id, rotated)),
    ).rejects.toThrow("Credential was not found or is revoked");
    // Untouched: a withdrawn grant must not become usable again by being written through.
    const stored = await asAdmin(() => store.readSecret(id));
    await expect(
      decryptSecret(key, stored?.encryptedValue ?? ""),
    ).resolves.toBe("rt-1");
  });

  test("refuses a row that is not there", async () => {
    const rotated = await encryptSecret(key, "rt-2");
    await expect(
      asAdmin(() =>
        createCredentialStore(database).updateSecret(randomUUID(), rotated),
      ),
    ).rejects.toThrow("Credential was not found or is revoked");
  });

  /**
   * The write joins the caller's transaction when it is handed one.
   *
   * A rotating vendor is spent under a row lock the caller took, and the re-encryption has to be
   * part of that transaction: on its own connection it would commit whether or not the caller's
   * transaction did, and — with every pooled connection inside such a transaction — would wait for a
   * connection that only the caller could release.
   */
  test("joins a caller's transaction, so a rollback takes the new secret with it", async () => {
    const store = createCredentialStore(database);
    const id = await liveCredential("rt-1");

    await expect(
      asAdmin(() =>
        database.transaction(async (transaction) => {
          await store.updateSecret(
            id,
            await encryptSecret(key, "rt-2"),
            transaction,
          );
          throw new Error("the caller changed its mind");
        }),
      ),
    ).rejects.toThrow("the caller changed its mind");

    const stored = await asAdmin(() => store.readSecret(id));
    await expect(
      decryptSecret(key, stored?.encryptedValue ?? ""),
    ).resolves.toBe("rt-1");
  });
});

describe("admin credential API", () => {
  test("returns only credential status and metadata", async () => {
    const app = createApp(
      config,
      {
        handler: () => new Response(null, { status: 204 }),
        api: {
          getSession: async () => ({
            user: { id: "admin", email: "admin@openbot.test" },
          }),
        },
      },
      { rolesForUser: async () => ["admin"] },
      undefined,
      {
        list: async () => [
          {
            id: "credential-1",
            kind: "model",
            provider: "openai",
            keyId: "primary",
            metadata: { label: "Production OpenAI" },
            revokedAt: null,
          },
        ],
      },
    );

    const response = await app.request(
      "http://openbot.local/api/admin/credentials",
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      credentials: [
        {
          id: "credential-1",
          kind: "model",
          provider: "openai",
          keyId: "primary",
          metadata: { label: "Production OpenAI" },
          revokedAt: null,
        },
      ],
    });
  });

  test("accepts plaintext only on credential creation and returns safe status", async () => {
    const created: unknown[] = [];
    const app = createApp(
      config,
      {
        handler: () => new Response(null, { status: 204 }),
        api: {
          getSession: async () => ({
            user: { id: "admin", email: "admin@openbot.test" },
          }),
        },
      },
      { rolesForUser: async () => ["admin"] },
      undefined,
      {
        list: async () => [],
        create: async (input) => {
          created.push(input);
          return {
            id: "credential-1",
            kind: input.kind,
            provider: input.provider,
            keyId: input.keyId,
            metadata: input.metadata,
            revokedAt: null,
          };
        },
      },
    );

    const response = await app.request(
      "http://openbot.local/api/admin/credentials",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "model",
          provider: "openai",
          keyId: "primary",
          metadata: { label: "Production OpenAI" },
          plaintext: "openai-secret-value",
        }),
      },
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      credential: {
        id: "credential-1",
        kind: "model",
        provider: "openai",
        keyId: "primary",
        metadata: { label: "Production OpenAI" },
        revokedAt: null,
      },
    });
    expect(created).toEqual([
      {
        kind: "model",
        provider: "openai",
        keyId: "primary",
        metadata: { label: "Production OpenAI" },
        plaintext: "openai-secret-value",
        actorUserId: "admin",
      },
    ]);
  });

  test("rotates and revokes through write-only administrator operations", async () => {
    const calls: string[] = [];
    const app = createApp(
      config,
      {
        handler: () => new Response(null, { status: 204 }),
        api: {
          getSession: async () => ({
            user: { id: "admin", email: "admin@openbot.test" },
          }),
        },
      },
      { rolesForUser: async () => ["admin"] },
      undefined,
      {
        list: async () => [],
        create: async () => {
          throw new Error("not used");
        },
        rotate: async (input) => {
          calls.push(`rotate:${input.previousCredentialId}`);
          return {
            id: "credential-new",
            kind: input.kind,
            provider: input.provider,
            keyId: input.keyId,
            metadata: input.metadata,
            revokedAt: null,
          };
        },
        revoke: async (id) => {
          calls.push(`revoke:${id}`);
          return { id, revokedAt: new Date("2026-08-13T12:00:00.000Z") };
        },
      },
    );

    const rotate = await app.request(
      "http://openbot.local/api/admin/credentials/credential-old/rotate",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "model",
          provider: "openai",
          keyId: "secondary",
          metadata: {},
          plaintext: "rotated-secret",
        }),
      },
    );
    const revoke = await app.request(
      "http://openbot.local/api/admin/credentials/credential-new/revoke",
      { method: "POST" },
    );

    expect(rotate.status).toBe(200);
    expect(revoke.status).toBe(200);
    expect(calls).toEqual(["rotate:credential-old", "revoke:credential-new"]);
    expect(await rotate.text()).not.toContain("rotated-secret");
  });
});

<<<<<<< fork
/**
 * Audit #9: the live-key index is per tenant, the deployment lookup prefers the deployment's own
 * row, and a credential's envelope is bound to the row it was written for.
 */
describe("tenant-scoped credential keys", () => {
  function tenants() {
    const suite = randomUUID().slice(0, 8);
    return { a: `cred-a-${suite}`, b: `cred-b-${suite}` };
  }

  async function insertAs(
    tenant: string,
    value: { keyId: string; encryptedValue?: string; createdAt?: Date },
  ) {
    const id = randomUUID();
    tenantCredentialIds.push({ tenant, id });
    await runAsTenant(tenant, () =>
      database.insert(credentials).values({
        id,
        kind: "model",
        provider: "openai",
        keyId: value.keyId,
        encryptedValue: value.encryptedValue ?? `value-${tenant}`,
        metadata: {},
        ...(value.createdAt ? { createdAt: value.createdAt } : {}),
      }),
    );
    return id;
  }

  test("two tenants each hold a live credential for the same key; one tenant still holds one", async () => {
    const { a, b } = tenants();
    const keyId = "gpt-4o";

    await insertAs(a, { keyId });
    // Refused by the old global index, with a unique violation that told B that A's row existed.
    await insertAs(b, { keyId });

    await expect(insertAs(a, { keyId })).rejects.toThrow();
  });

  test("findLiveByKey answers only for the current tenant, never another tenant's or system's row", async () => {
    const { a, b } = tenants();
    const store = createCredentialStore(database);
    const keyId = `shared-key-${randomUUID()}`;
    const systemId = randomUUID();
    tenantCredentialIds.push({ tenant: "system", id: systemId });
    // The deployment's own row, written in the deployment's (`system`) frame.
    await runAsTenant("system", () =>
      database.insert(credentials).values({
        id: systemId,
        kind: "model",
        provider: "openai",
        keyId,
        encryptedValue: "system-value",
        metadata: {},
      }),
    );
    const ownedByA = await insertAs(a, { keyId });

    const key = { kind: "model" as const, provider: "openai", keyId };
    await expect(
      runAsTenant(b, () => store.findLiveByKey(key)),
    ).resolves.toBeNull();
    await expect(
      runAsTenant(a, () => store.findLiveByKey(key)),
    ).resolves.toEqual({ id: ownedByA });
  });

  test("rotate refuses a previous credential that is not this tenant's own", async () => {
    const { a } = tenants();
    const store = createCredentialStore(database);
    const keyId = `system-only-${randomUUID()}`;
    const systemId = randomUUID();
    tenantCredentialIds.push({ tenant: "system", id: systemId });
    // The deployment's own row, written in the deployment's (`system`) frame.
    await runAsTenant("system", () =>
      database.insert(credentials).values({
        id: systemId,
        kind: "model",
        provider: "openai",
        keyId,
        encryptedValue: "system-value",
        metadata: {},
      }),
    );

    await expect(
      runAsTenant(a, () =>
        store.rotate({
          previousCredentialId: systemId,
          kind: "model",
          provider: "openai",
          keyId,
          metadata: {},
          encryptedValue: "would-retire-the-deployment-key",
        }),
      ),
    ).rejects.toMatchObject({ name: "CredentialRefusedError", status: 404 });
    // Looked at across every tenant, so the row cannot be hidden from the check by a frame.
    const [after] = await asPlatform(() =>
      database
        .select({ revokedAt: credentials.revokedAt })
        .from(credentials)
        .where(eq(credentials.id, systemId)),
    );
    expect(after?.revokedAt).toBeNull();
  });

  test("readModelSecret prefers the deployment's system row and never answers with a library key", async () => {
    const { a } = tenants();
    const store = createCredentialStore(database);
    const keyId = `deployment-ref-${randomUUID()}`;
    const systemId = randomUUID();
    tenantCredentialIds.push({ tenant: "system", id: systemId });
    // The deployment's own row, written in the deployment's (`system`) frame.
    await runAsTenant("system", () =>
      database.insert(credentials).values({
        id: systemId,
        kind: "model",
        provider: "openai",
        keyId,
        encryptedValue: "system-value",
        metadata: {},
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      }),
    );
    // Newer, and visible to tenant A beside the system row: it must still not be chosen.
    await insertAs(a, {
      keyId,
      encryptedValue: "tenant-value",
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
    });

    await expect(
      runAsTenant(a, () =>
        store.readModelSecret({ provider: "openai", keyId }),
      ),
    ).resolves.toMatchObject({ encryptedValue: "system-value", id: systemId });

    const libraryKey = `model_registry:${randomUUID()}`;
    const libraryId = randomUUID();
    tenantCredentialIds.push({ tenant: "system", id: libraryId });
    await runAsTenant("system", () =>
      database.insert(credentials).values({
        id: libraryId,
        kind: "model",
        provider: "openai",
        keyId: libraryKey,
        encryptedValue: "library-value",
        metadata: {},
      }),
    );
    // Asked from a person's frame and from the deployment's own: a library key is never the answer.
    for (const frame of [a, "system"]) {
      await expect(
        runAsTenant(frame, () =>
          store.readModelSecret({ provider: "openai", keyId: libraryKey }),
        ),
      ).resolves.toBeNull();
    }
  });
});

describe("credential envelopes bound to their row", () => {
  const binding = {
    tenantId: "tenant-a",
    id: "11111111-1111-4111-8111-111111111111",
    kind: "model" as const,
  };

  test("a v2 envelope opens with its own row and with no other", async () => {
    const sealed = await sealCredential(key, binding, "bound-secret");
    expect(JSON.parse(sealed)).toEqual({
      version: 2,
      alg: "A256GCM",
      bind: "credential",
      kid: "k1",
      iv: expect.any(String),
      ciphertext: expect.any(String),
    });
    // The binding is rebuilt from the row, never carried in the envelope.
    expect(sealed).not.toContain(binding.tenantId);
    expect(sealed).not.toContain(binding.id);

    await expect(
      openCredential(key, { ...binding, encryptedValue: sealed }),
    ).resolves.toBe("bound-secret");
    for (const other of [
      { ...binding, tenantId: "tenant-b" },
      { ...binding, id: "22222222-2222-4222-8222-222222222222" },
      { ...binding, kind: "connector" as const },
    ]) {
      await expect(
        openCredential(key, { ...other, encryptedValue: sealed }),
      ).rejects.toThrow();
    }
    // Without its row a v2 envelope does not open at all.
    await expect(
      openCredential(key, { encryptedValue: sealed }),
    ).rejects.toThrow();
    await expect(decryptSecret(key, sealed)).rejects.toThrow(
      "Credential envelope is invalid",
    );
  });

  test("a legacy v1 envelope still opens through the credential path", async () => {
    const legacy = await encryptSecret(key, "legacy-secret");
    await expect(
      openCredential(key, { ...binding, encryptedValue: legacy }),
    ).resolves.toBe("legacy-secret");
    await expect(
      decryptCredentialForUse(
        key,
        {
          readSecret: async () => ({ encryptedValue: legacy, revokedAt: null }),
        },
        "credential-1",
      ),
    ).resolves.toBe("legacy-secret");
  });

  test("OPEN (audit #9): with the gate off, a v1 envelope pasted over a v2-bound row still opens", async () => {
    /*
     * Records the half of #9 that is NOT closed. v1 authenticates nothing about its row, and
     * nothing records that a row was ever v2, so a v1 envelope lifted from another tenant (or
     * from any other v1 writer under the same key) and written over a bound row is accepted. When
     * the reseal lands and VAULT_REQUIRE_AAD is on by default, flip this to `rejects`.
     */
    const v2Row = {
      ...binding,
      encryptedValue: await sealCredential(key, binding, "own"),
    };
    await expect(
      openCredential(key, v2Row, { requireAad: false }),
    ).resolves.toBe("own");
    const elsewhere = await encryptSecret(key, "another-tenants-secret");
    await expect(
      openCredential(
        key,
        { ...v2Row, encryptedValue: elsewhere },
        { requireAad: false },
      ),
    ).resolves.toBe("another-tenants-secret");
  });

  test("VAULT_REQUIRE_AAD refuses an unbound v1 envelope and still opens a bound one", async () => {
    const legacy = await encryptSecret(key, "legacy-secret");
    await expect(
      openCredential(
        key,
        { ...binding, encryptedValue: legacy },
        { requireAad: true },
      ),
    ).rejects.toThrow("requires bound envelopes");
    const sealed = await sealCredential(key, binding, "bound-secret");
    await expect(
      openCredential(
        key,
        { ...binding, encryptedValue: sealed },
        { requireAad: true },
      ),
    ).resolves.toBe("bound-secret");
  });

  test("VAULT_REQUIRE_AAD is off unless set to 1 or true", () => {
    expect(vaultRequiresAad({})).toBe(false);
    expect(vaultRequiresAad({ VAULT_REQUIRE_AAD: "" })).toBe(false);
    expect(vaultRequiresAad({ VAULT_REQUIRE_AAD: "0" })).toBe(false);
    expect(vaultRequiresAad({ VAULT_REQUIRE_AAD: "false" })).toBe(false);
    expect(vaultRequiresAad({ VAULT_REQUIRE_AAD: "1" })).toBe(true);
    expect(vaultRequiresAad({ VAULT_REQUIRE_AAD: " TRUE " })).toBe(true);
  });

  test("an envelope copied into another tenant's row fails as a fault, not as a withdrawal", async () => {
    const suite = randomUUID().slice(0, 8);
    const a = `seal-a-${suite}`;
    const b = `seal-b-${suite}`;
    const store = createCredentialStore(database);

    let sealedFor: unknown;
    const created = await runAsTenant(a, () =>
      store.create({
        kind: "model",
        provider: "openai",
        keyId: `sealed-${suite}`,
        metadata: {},
        seal: (row) => {
          sealedFor = row;
          return sealCredential(key, row, "tenant-a-secret");
        },
      }),
    );
    tenantCredentialIds.push({ tenant: a, id: created.id });
    expect(sealedFor).toEqual({ id: created.id, tenantId: a, kind: "model" });

    const [stored] = await runAsTenant(a, () =>
      database
        .select({
          tenantId: credentials.tenantId,
          encryptedValue: credentials.encryptedValue,
        })
        .from(credentials)
        .where(eq(credentials.id, created.id)),
    );
    expect(stored?.tenantId).toBe(a);
    expect(JSON.parse(stored?.encryptedValue ?? "{}").version).toBe(2);
    await expect(
      runAsTenant(a, () => decryptCredentialForUse(key, store, created.id)),
    ).resolves.toBe("tenant-a-secret");

    // The same bytes pasted into a row of tenant B's, and into another row of A's own.
    const copiedToB = randomUUID();
    tenantCredentialIds.push({ tenant: b, id: copiedToB });
    await runAsTenant(b, () =>
      database.insert(credentials).values({
        id: copiedToB,
        kind: "model",
        provider: "openai",
        keyId: `sealed-${suite}`,
        encryptedValue: stored?.encryptedValue ?? "",
        metadata: {},
      }),
    );
    const copiedInA = randomUUID();
    tenantCredentialIds.push({ tenant: a, id: copiedInA });
    await runAsTenant(a, () =>
      database.insert(credentials).values({
        id: copiedInA,
        kind: "model",
        provider: "openai",
        keyId: `sealed-copy-${suite}`,
        encryptedValue: stored?.encryptedValue ?? "",
        metadata: {},
      }),
    );

    for (const [tenant, id] of [
      [b, copiedToB],
      [a, copiedInA],
    ] as const) {
      const failure = await runAsTenant(tenant, () =>
        decryptCredentialForUse(key, store, id),
      ).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(CredentialUnusableError);
    }
  });

  test("a legacy v1 row still opens through the store", async () => {
    const tenant = `seal-v1-${randomUUID().slice(0, 8)}`;
    const id = randomUUID();
    tenantCredentialIds.push({ tenant, id });
    const encryptedValue = await encryptSecret(key, "legacy-row-secret");
    await runAsTenant(tenant, () =>
      database.insert(credentials).values({
        id,
        kind: "connector",
        provider: "legacy",
        keyId: `legacy-${id}`,
        encryptedValue,
        metadata: {},
      }),
    );

    await expect(
      runAsTenant(tenant, () =>
        decryptCredentialForUse(key, createCredentialStore(database), id),
      ),
    ).resolves.toBe("legacy-row-secret");
  });

  test("rotate and updateSecret write v2 envelopes bound to the row they land on", async () => {
    const tenant = `seal-rot-${randomUUID().slice(0, 8)}`;
    const store = createCredentialStore(database);
    const keyId = `rotating-${tenant}`;
    const seal = (plaintext: string) => (row: CredentialBinding) =>
      sealCredential(key, row, plaintext);

    const first = await runAsTenant(tenant, () =>
      store.create({
        kind: "model",
        provider: "openai",
        keyId,
        metadata: {},
        seal: seal("first"),
      }),
    );
    tenantCredentialIds.push({ tenant, id: first.id });
    const rotated = await runAsTenant(tenant, () =>
      store.rotate({
        previousCredentialId: first.id,
        kind: "model",
        provider: "openai",
        keyId,
        metadata: {},
        seal: seal("second"),
      }),
    );
    tenantCredentialIds.push({ tenant, id: rotated.id });
    expect(rotated.id).not.toBe(first.id);

    const versionOf = async (id: string) => {
      const [row] = await runAsTenant(tenant, () =>
        database
          .select({ encryptedValue: credentials.encryptedValue })
          .from(credentials)
          .where(eq(credentials.id, id)),
      );
      return JSON.parse(row?.encryptedValue ?? "{}").version;
    };
    expect(await versionOf(rotated.id)).toBe(2);
    await expect(
      runAsTenant(tenant, () =>
        decryptCredentialForUse(key, store, rotated.id),
      ),
    ).resolves.toBe("second");

    await runAsTenant(tenant, () =>
      store.updateSecret(rotated.id, seal("third")),
    );
    expect(await versionOf(rotated.id)).toBe(2);
    await expect(
      runAsTenant(tenant, () =>
        decryptCredentialForUse(key, store, rotated.id),
      ),
    ).resolves.toBe("third");

    // A revoked row is still refused before anything is sealed for it.
    await expect(
      runAsTenant(tenant, () => store.updateSecret(first.id, seal("revived"))),
    ).rejects.toThrow("Credential was not found or is revoked");
  });

  test("the administrator's create and rotate store v2 envelopes", async () => {
    // In the administrator's own frame, as the credential routes run it.
    await asAdmin(async () => {
      const service = {
        encryptionKey: key,
        store: createCredentialStore(database),
        auditStore: { insert: async () => {} },
      };
      const keyId = `admin-sealed-${randomUUID()}`;
      const created = await createCredential(service, {
        kind: "model",
        provider: "openai",
        keyId,
        metadata: {},
        plaintext: "admin-first",
      });
      credentialIds.push(created.id);
      const replaced = await createCredential(service, {
        kind: "model",
        provider: "openai",
        keyId,
        metadata: {},
        plaintext: "admin-second",
      });
      credentialIds.push(replaced.id);

      for (const [id, plaintext] of [
        [created.id, "admin-first"],
        [replaced.id, "admin-second"],
      ] as const) {
        const stored = await service.store.readSecret(id);
        expect(JSON.parse(stored?.encryptedValue ?? "{}").version).toBe(2);
        await expect(
          openCredential(key, stored ?? { encryptedValue: "" }),
        ).resolves.toBe(plaintext);
      }
    });
  });
=======
afterAll(async () => {
  await database.$client.close();
>>>>>>> v1.0.0
});
