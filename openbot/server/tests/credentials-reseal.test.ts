import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  encryptSecret,
  openCredential,
  sealCredential,
} from "../src/credentials";
import {
  listTenantsWithUnboundCredentials,
  resealCredentials,
} from "../src/credentials-reseal";
import { createDatabase } from "../src/db/client";
import { credentials } from "../src/db/schema";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Audit #9, second half: every v1 credential row is resealed into a v2 envelope bound to its own
 * tenant, id and kind, so VAULT_REQUIRE_AAD can be switched on. Real PostgreSQL, the application
 * role, row security forced: the sweep lists tenants in the platform frame and writes each tenant's
 * rows inside that tenant's own frame.
 *
 * Each test names its own tenants and passes them as `tenants`, so a sweep never touches rows that
 * other files in the same database are writing at the same moment.
 */
const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const written: { tenant: string; id: string }[] = [];

afterEach(async () => {
  for (const { tenant, id } of written.splice(0)) {
    await runAsTenant(tenant, () =>
      database.delete(credentials).where(eq(credentials.id, id)),
    );
  }
});

function suiteTenants() {
  const suite = randomUUID().slice(0, 8);
  return { a: `reseal-a-${suite}`, b: `reseal-b-${suite}`, suite };
}

async function insertRow(
  tenant: string,
  input: {
    kind?: "model" | "connector";
    keyId: string;
    encryptedValue: string;
    revoked?: boolean;
  },
) {
  const id = randomUUID();
  written.push({ tenant, id });
  await runAsTenant(tenant, () =>
    database.insert(credentials).values({
      id,
      kind: input.kind ?? "model",
      provider: "openai",
      keyId: input.keyId,
      encryptedValue: input.encryptedValue,
      metadata: {},
      revokedAt: input.revoked ? new Date() : null,
    }),
  );
  return id;
}

async function storedRow(tenant: string, id: string) {
  const [row] = await runAsTenant(tenant, () =>
    database
      .select({
        id: credentials.id,
        tenantId: credentials.tenantId,
        kind: credentials.kind,
        encryptedValue: credentials.encryptedValue,
      })
      .from(credentials)
      .where(and(eq(credentials.id, id), eq(credentials.tenantId, tenant))),
  );
  if (!row) {
    throw new Error(`row ${id} of ${tenant} is missing`);
  }
  return row;
}

describe("resealing v1 credential rows", () => {
  test("two tenants' v1 rows become v2, open only in their own row, and a rerun changes nothing", async () => {
    const { a, b, suite } = suiteTenants();
    const aModel = await insertRow(a, {
      keyId: `a-model-${suite}`,
      encryptedValue: await encryptSecret(key, "tenant-a-model-secret"),
    });
    const aConnector = await insertRow(a, {
      kind: "connector",
      keyId: `a-connector-${suite}`,
      encryptedValue: await encryptSecret(key, "tenant-a-connector-secret"),
    });
    const aRevoked = await insertRow(a, {
      keyId: `a-revoked-${suite}`,
      encryptedValue: await encryptSecret(key, "tenant-a-revoked-secret"),
      revoked: true,
    });
    const bModel = await insertRow(b, {
      keyId: `b-model-${suite}`,
      encryptedValue: await encryptSecret(key, "tenant-b-model-secret"),
    });
    // Already bound: left exactly as it is.
    const bAlready = randomUUID();
    written.push({ tenant: b, id: bAlready });
    const alreadySealed = await sealCredential(
      key,
      { tenantId: b, id: bAlready, kind: "model" },
      "tenant-b-already-v2",
    );
    await runAsTenant(b, () =>
      database.insert(credentials).values({
        id: bAlready,
        kind: "model",
        provider: "openai",
        keyId: `b-already-${suite}`,
        encryptedValue: alreadySealed,
        metadata: {},
      }),
    );

    const lines: string[] = [];
    const first = await resealCredentials(database, key, {
      tenants: [a, b],
      log: (line) => lines.push(line),
    });

    expect(first).toEqual({
      tenants: 2,
      scanned: 4,
      resealed: 4,
      changedSinceRead: 0,
      unreadable: 0,
      remaining: 0,
    });
    // Counts only: no envelope, no plaintext, in anything the sweep says.
    const said = lines.join("\n");
    for (const secret of [
      "tenant-a-model-secret",
      "tenant-a-connector-secret",
      "tenant-a-revoked-secret",
      "tenant-b-model-secret",
      "ciphertext",
    ]) {
      expect(said).not.toContain(secret);
    }

    const expected = [
      [a, aModel, "tenant-a-model-secret"],
      [a, aConnector, "tenant-a-connector-secret"],
      [a, aRevoked, "tenant-a-revoked-secret"],
      [b, bModel, "tenant-b-model-secret"],
    ] as const;
    for (const [tenant, id, plaintext] of expected) {
      const row = await storedRow(tenant, id);
      expect(JSON.parse(row.encryptedValue).version).toBe(2);
      await expect(
        openCredential(key, row, { requireAad: true }),
      ).resolves.toBe(plaintext);
    }
    expect((await storedRow(b, bAlready)).encryptedValue).toBe(alreadySealed);

    // Decryptable only in its own row: another tenant, another id, another kind all fail the tag.
    const aRow = await storedRow(a, aModel);
    for (const elsewhere of [
      { tenantId: b, id: aModel, kind: "model" as const },
      { tenantId: a, id: aConnector, kind: "model" as const },
      { tenantId: a, id: aModel, kind: "connector" as const },
    ]) {
      await expect(
        openCredential(
          key,
          { ...elsewhere, encryptedValue: aRow.encryptedValue },
          { requireAad: true },
        ),
      ).rejects.toThrow();
    }

    const before = await Promise.all(
      expected.map(([tenant, id]) => storedRow(tenant, id)),
    );
    const second = await resealCredentials(database, key, {
      tenants: [a, b],
      log: () => {},
    });
    expect(second).toEqual({
      tenants: 2,
      scanned: 0,
      resealed: 0,
      changedSinceRead: 0,
      unreadable: 0,
      remaining: 0,
    });
    const after = await Promise.all(
      expected.map(([tenant, id]) => storedRow(tenant, id)),
    );
    expect(after).toEqual(before);
  });

  test("a row whose value changed after it was read is left to the writer that changed it", async () => {
    const { a, suite } = suiteTenants();
    const id = await insertRow(a, {
      keyId: `raced-${suite}`,
      encryptedValue: await encryptSecret(key, "the-old-secret"),
    });
    // Another writer stores a new v1 value between the sweep's read and its write.
    const newer = await encryptSecret(key, "the-new-secret");

    const report = await resealCredentials(database, key, {
      tenants: [a],
      log: () => {},
      beforeWrite: async (row) => {
        if (row.id === id) {
          await runAsTenant(a, () =>
            database
              .update(credentials)
              .set({ encryptedValue: newer })
              .where(eq(credentials.id, id)),
          );
        }
      },
    });

    expect(report).toMatchObject({
      scanned: 1,
      resealed: 0,
      changedSinceRead: 1,
      remaining: 1,
    });
    // The newer value survives untouched: the stale reseal of the old secret never landed.
    expect((await storedRow(a, id)).encryptedValue).toBe(newer);

    const rerun = await resealCredentials(database, key, {
      tenants: [a],
      log: () => {},
    });
    expect(rerun).toMatchObject({ resealed: 1, remaining: 0 });
    await expect(
      openCredential(key, await storedRow(a, id), { requireAad: true }),
    ).resolves.toBe("the-new-secret");
  });

  test("a row that is not a readable v1 envelope is counted, left alone and still blocks the switch", async () => {
    const { a, suite } = suiteTenants();
    const junk = await insertRow(a, {
      keyId: `junk-${suite}`,
      encryptedValue: "not-an-envelope",
    });
    // A v1 envelope under a different key: it cannot be opened, so it cannot be resealed.
    const foreign = await insertRow(a, {
      keyId: `foreign-${suite}`,
      encryptedValue: await encryptSecret(
        "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA=",
        "foreign-key-secret",
      ),
    });

    const lines: string[] = [];
    const report = await resealCredentials(database, key, {
      tenants: [a],
      log: (line) => lines.push(line),
    });
    expect(report).toEqual({
      tenants: 1,
      scanned: 2,
      resealed: 0,
      changedSinceRead: 0,
      unreadable: 2,
      remaining: 2,
    });
    expect((await storedRow(a, junk)).encryptedValue).toBe("not-an-envelope");
    expect(
      JSON.parse((await storedRow(a, foreign)).encryptedValue).version,
    ).toBe(1);
    expect(lines.join("\n")).not.toContain("foreign-key-secret");
    expect(lines.join("\n")).not.toContain("not-an-envelope");
  });

  test("without a tenant list, the platform frame finds every tenant holding an unbound row", async () => {
    const { a, b, suite } = suiteTenants();
    await insertRow(a, {
      keyId: `listed-a-${suite}`,
      encryptedValue: await encryptSecret(key, "listed-a"),
    });
    await insertRow(b, {
      keyId: `listed-b-${suite}`,
      encryptedValue: await encryptSecret(key, "listed-b"),
    });

    const tenants = await listTenantsWithUnboundCredentials(database);
    expect(tenants).toContain(a);
    expect(tenants).toContain(b);
  });
});
