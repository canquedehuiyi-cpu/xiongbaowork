import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import postgres from "postgres";
import { applyRelease, mergedMigrationsFolder } from "../scripts/migrate";
import {
  type CredentialBinding,
  type CredentialKind,
  encryptSecret,
  openCredential,
} from "../src/credentials";
import { rekeyCredentials } from "../src/credentials-rekey";
import { applyMigrations } from "../src/db/apply-migrations";
import {
  openUnder,
  sealAsV0215,
  V0215_AAD_LABEL,
  V0216_AAD_LABEL,
} from "./support/sealed-before-v0216";

/**
 * The v0.2.16 credential rekey: every v2 envelope sealed under kid `k1` (the label before v0.2.16) is
 * opened and sealed again under `k2`, inside the transaction that applies the business database's
 * migrations, so the rekey commits exactly when the migration journal grows and a row that will not
 * open rolls all of it back.
 *
 * Each database starts where a v0.2.15 deployment left it: migrated by the real migrator through the
 * last v0.2.15 migration, with credential rows sealed the way v0.2.15 sealed them. `sealAsV0215` is
 * written out in `support/sealed-before-v0216` rather than borrowed from the server, so it is an
 * independent account of the old envelope and not the code under test agreeing with itself.
 *
 * Creating a database takes the owner (`TEST_DATABASE_ADMIN_URL`); without it this is skipped.
 */
const owner = process.env.TEST_DATABASE_ADMIN_URL?.trim();
const LAST_V0215_MIGRATION = "0239_aihub_provider_template";
const key = randomBytes(32).toString("base64");
const otherKey = randomBytes(32).toString("base64");
const suffix = randomUUID().slice(0, 8);
const template = `xiongbao_rekey_template_${suffix}`;
const created: string[] = [];

function databaseUrl(name: string) {
  const url = new URL(owner as string);
  url.pathname = `/${name}`;
  return url.href;
}

async function onAdmin<T>(work: (admin: postgres.Sql) => Promise<T>) {
  const admin = postgres(databaseUrl("postgres"), {
    max: 1,
    onnotice: () => {},
  });
  try {
    return await work(admin);
  } finally {
    await admin.end({ timeout: 5 });
  }
}

type Seeded = CredentialBinding & { plaintext: string; envelope: string };

/** Three tenants' k1 rows (one revoked), and a v1 row the rekey has no business touching. */
async function seed(client: postgres.Sql, extra: Seeded[] = []) {
  const rows: Seeded[] = [];
  const specs: [string, CredentialKind, string][] = [
    ["rekey-person-a", "model", "sk-person-a"],
    ["rekey-person-b", "connector", "refresh-token-b"],
    ["team", "mcp", "team-server-secret"],
  ];
  for (const [index, [tenantId, kind, plaintext]] of specs.entries()) {
    const id = `0000000${index}-0000-4000-8000-000000000000`;
    const binding = { tenantId, id, kind };
    rows.push({
      ...binding,
      plaintext,
      envelope: await sealAsV0215(key, binding, plaintext),
    });
  }
  const v1 = {
    tenantId: "rekey-person-a",
    id: "00000009-0000-4000-8000-000000000000",
    kind: "agent" as const,
    plaintext: "unbound-agent-key",
    envelope: await encryptSecret(key, "unbound-agent-key"),
  };
  for (const row of [...rows, v1, ...extra]) {
    await client`insert into credentials (id, tenant_id, kind, provider, encrypted_value, key_id, metadata, revoked_at)
      values (${row.id}::uuid, ${row.tenantId}, ${row.kind}, 'rekey-test', ${row.envelope}, ${`key-${row.id}`}, '{}',
              case when ${row.id.startsWith("00000001")}::boolean then now() end)`;
  }
  return { k1: rows, v1 };
}

async function stored(client: postgres.Sql) {
  return client<{ id: string; encrypted_value: string; updated_at: Date }[]>`
    select id::text, encrypted_value, updated_at from credentials order by id`;
}

async function journalSize(client: postgres.Sql) {
  const [row] = await client<
    { n: number }[]
  >`select count(*)::int as n from drizzle.__drizzle_migrations`;
  return row?.n ?? -1;
}

/** Functions this database carries under the new names: migration 0240 renames a dozen and more. */
async function renamedFunctions(client: postgres.Sql) {
  const [row] = await client<{ n: number }[]>`
    select count(*)::int as n from pg_proc
     where pronamespace = 'public'::regnamespace and proname like 'xiongbao\_%'`;
  return row?.n ?? -1;
}

/** Whether row security is on and forced for the owner too: the rekey must leave both as they were. */
async function rowSecurity(client: postgres.Sql) {
  const [row] = await client<{ state: string }[]>`
    select relrowsecurity::text || '/' || relforcerowsecurity::text as state
      from pg_class where oid = 'public.credentials'::regclass`;
  return row?.state ?? "";
}

/** The head's migrations without the rekey: k1 rows seeded after this are what a v0.2.15 replica writes. */
async function migrateWithoutRekey(client: postgres.Sql) {
  const folder = await mergedMigrationsFolder();
  try {
    await applyMigrations(client, folder);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/** A copy of the v0.2.15-shaped template, connected. */
async function v0215Database(label: string) {
  const name = `xiongbao_rekey_${label}_${suffix}`;
  await onAdmin((admin) =>
    admin.unsafe(`CREATE DATABASE "${name}" TEMPLATE "${template}"`),
  );
  created.push(name);
  return postgres(databaseUrl(name), { max: 1, onnotice: () => {} });
}

/** What `scripts/migrate.ts` runs for a deployment: every pending migration, then the rekey. */
async function migrateAsRelease(
  client: postgres.Sql,
  encryptionKey: string | undefined,
  log: string[] = [],
) {
  const folder = await mergedMigrationsFolder();
  try {
    await applyRelease(encryptionKey, (line) => log.push(line))(client, folder);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

beforeAll(async () => {
  if (!owner) return;
  await onAdmin((admin) => admin.unsafe(`CREATE DATABASE "${template}"`));
  created.push(template);
  const client = postgres(databaseUrl(template), {
    max: 1,
    onnotice: () => {},
  });
  const folder = await mergedMigrationsFolder({
    through: LAST_V0215_MIGRATION,
  });
  try {
    await applyMigrations(client, folder);
  } finally {
    await rm(folder, { recursive: true, force: true });
    // A template takes no connections while it is copied.
    await client.end({ timeout: 5 });
  }
}, 300_000);

afterAll(async () => {
  if (!owner) return;
  await onAdmin(async (admin) => {
    for (const name of created.reverse())
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.unsafe("DROP ROLE IF EXISTS xiongbao_rekey_owner");
    await admin.unsafe("DROP ROLE IF EXISTS xiongbao_rekey_stranger");
    // Migrating here on a cluster another database already renamed recreates the old roles; drop
    // them once nothing references them, as the rename migration's own test does.
    // legacy-compat：introducedIn 0.2.16，removeIn 0.2.17
    for (const role of ["openbot_app", "openbot_role_writer"]) {
      const [held] = await admin<{ refs: number }[]>`
        select count(*)::int as refs from pg_shdepend d join pg_roles r on r.oid = d.refobjid
         where r.rolname = ${role}`;
      const [exists] = await admin<{ n: number }[]>`
        select count(*)::int as n from pg_roles where rolname = ${role}`;
      if (exists?.n && held?.refs === 0)
        await admin.unsafe(`DROP ROLE IF EXISTS "${role}"`);
    }
  });
}, 120_000);

describe.skipIf(!owner)("the v0.2.16 credential rekey", () => {
  test("every k1 row becomes k2 and decrypts to the same plaintext", async () => {
    const client = await v0215Database("rekeyed");
    try {
      const { k1, v1 } = await seed(client);
      const before = await stored(client);
      const journalBefore = await journalSize(client);
      const renamedBefore = await renamedFunctions(client);
      const log: string[] = [];

      // A superuser migrates here, as in the delivery container.
      await migrateAsRelease(client, key, log);

      // Nothing about the table's row security moved.
      expect(await rowSecurity(client)).toBe("true/true");

      expect(log).toEqual(['{"type":"credentials-rekeyed","rekeyed":3}']);
      const after = await stored(client);
      for (const row of k1) {
        const now = after.find((entry) => entry.id === row.id);
        expect(now).toBeDefined();
        const envelope = now?.encrypted_value ?? "";
        expect(JSON.parse(envelope)).toEqual({
          version: 2,
          alg: "A256GCM",
          bind: "credential",
          kid: "k2",
          iv: expect.any(String),
          ciphertext: expect.any(String),
        });
        // Re-bound, not relabelled: the new envelope opens under the new label and not the old one.
        expect(await openUnder(V0216_AAD_LABEL, key, row, envelope)).toBe(
          row.plaintext,
        );
        await expect(
          openUnder(V0215_AAD_LABEL, key, row, envelope),
        ).rejects.toThrow();
        expect(
          await openCredential(key, { ...row, encryptedValue: envelope }),
        ).toBe(row.plaintext);
        // Only the wrapping changed: when the secret was last set stays what it was.
        expect(now?.updated_at).toEqual(
          before.find((entry) => entry.id === row.id)?.updated_at as Date,
        );
      }
      // A v1 envelope is left exactly as it was: it carries no label to change.
      expect(after.find((entry) => entry.id === v1.id)?.encrypted_value).toBe(
        v1.envelope,
      );
      // The rekey committed with the migrations that brought it, never on its own.
      expect(await journalSize(client)).toBeGreaterThan(journalBefore);
      expect(await renamedFunctions(client)).toBeGreaterThan(renamedBefore);
    } finally {
      await client.end({ timeout: 5 });
    }
  }, 300_000);

  test("a credential that fails to decrypt rolls back every re-encrypted row", async () => {
    const client = await v0215Database("rollback");
    try {
      // Last in id order, so every good row has already been rewritten when this one is reached.
      const unreadable: CredentialBinding = {
        tenantId: "rekey-person-c",
        id: "ffffffff-0000-4000-8000-000000000000",
        kind: "model",
      };
      await seed(client, [
        {
          ...unreadable,
          plaintext: "sealed-under-another-key",
          envelope: await sealAsV0215(
            otherKey,
            unreadable,
            "sealed-under-another-key",
          ),
        },
      ]);
      const before = await stored(client);
      const journalBefore = await journalSize(client);
      const renamedBefore = await renamedFunctions(client);
      const securityBefore = await rowSecurity(client);

      const failure = await migrateAsRelease(client, key).then(
        () => null,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(Error);
      const message = (failure as Error).message;
      // Names the row and says nothing was changed; never carries a secret or the key.
      expect(message).toContain(unreadable.id);
      expect(message).toContain("业务库没有任何改动");
      for (const secret of [
        key,
        otherKey,
        "sealed-under-another-key",
        "sk-person-a",
      ])
        expect(message).not.toContain(secret);
      // Every row, the journal and the rest of the migration are as v0.2.15 left them.
      expect(await stored(client)).toEqual(before);
      expect(await journalSize(client)).toBe(journalBefore);
      expect(await renamedFunctions(client)).toBe(renamedBefore);
      expect(await rowSecurity(client)).toBe(securityBefore);
    } finally {
      await client.end({ timeout: 5 });
    }
  }, 300_000);

  test("rekey applied twice changes nothing", async () => {
    const client = await v0215Database("twice");
    try {
      await seed(client);
      await migrateAsRelease(client, key);
      const once = await stored(client);
      const journalOnce = await journalSize(client);

      // The function on its own, in a transaction of its own, finds nothing left to do.
      const again = await client.begin((tx) => rekeyCredentials(tx, key));
      expect(again).toEqual({ rekeyed: 0 });
      // And so does the whole release migration, run the way a second start runs it, saying nothing.
      const log: string[] = [];
      await migrateAsRelease(client, key, log);
      expect(log).toEqual([]);

      expect(await stored(client)).toEqual(once);
      expect(await journalSize(client)).toBe(journalOnce);
    } finally {
      await client.end({ timeout: 5 });
    }
  }, 300_000);

  test("k1 rows without KEY_ENCRYPTION_KEY refuse the migration and change nothing", async () => {
    const client = await v0215Database("nokey");
    try {
      await seed(client);
      const before = await stored(client);
      const journalBefore = await journalSize(client);

      const failure = await migrateAsRelease(client, undefined).then(
        () => null,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain("KEY_ENCRYPTION_KEY");
      expect((failure as Error).message).toContain("业务库没有任何改动");
      expect(await stored(client)).toEqual(before);
      expect(await journalSize(client)).toBe(journalBefore);
    } finally {
      await client.end({ timeout: 5 });
    }
  }, 300_000);

  test("a database with no k1 row migrates without KEY_ENCRYPTION_KEY", async () => {
    const client = await v0215Database("nothing");
    try {
      const journalBefore = await journalSize(client);
      await migrateAsRelease(client, undefined);
      expect(await journalSize(client)).toBeGreaterThan(journalBefore);
    } finally {
      await client.end({ timeout: 5 });
    }
  }, 300_000);

  test("a table owner that row security filters still rekeys every tenant's rows", async () => {
    const client = await v0215Database("owner");
    try {
      await migrateWithoutRekey(client);
      const { k1 } = await seed(client);
      // Stand where an external database's owner stands: not a superuser, no BYPASSRLS, owning the
      // table that FORCE ROW LEVEL SECURITY applies to even its owner.
      await client.unsafe(`DO $$ BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'xiongbao_rekey_owner') THEN
          CREATE ROLE xiongbao_rekey_owner NOLOGIN NOSUPERUSER NOBYPASSRLS;
        END IF; END $$`);
      await client.unsafe(
        "ALTER TABLE public.credentials OWNER TO xiongbao_rekey_owner",
      );
      // The table's policies read these; an owner of the table can read them too.
      await client.unsafe(
        "GRANT SELECT ON public.user_roles TO xiongbao_rekey_owner",
      );
      const securityBefore = await rowSecurity(client);
      const { result, frameAfter } = await client.begin(async (tx) => {
        await tx`set local role xiongbao_rekey_owner`;
        const [visible] = await tx<
          { n: number }[]
        >`select count(*)::int as n from credentials`;
        // In no frame this role sees none of the seeded rows.
        expect(visible?.n).toBe(0);
        // Whatever frame the caller is in, it is in it again afterwards.
        await tx`select set_config('app.tenant_id', 'rekey-person-a', true)`;
        const result = await rekeyCredentials(tx, key);
        const [frame] = await tx<{ value: string }[]>`
          select current_setting('app.tenant_id', true) as value`;
        return { result, frameAfter: frame?.value };
      });

      expect(result).toEqual({ rekeyed: k1.length });
      expect(frameAfter).toBe("rekey-person-a");
      const after = await stored(client);
      for (const row of k1)
        expect(
          JSON.parse(
            after.find((entry) => entry.id === row.id)?.encrypted_value ?? "{}",
          ).kid,
        ).toBe("k2");
      // Done in the platform frame: the table's row security is exactly as it was.
      expect(await rowSecurity(client)).toBe(securityBefore);
      expect(securityBefore).toBe("true/true");
    } finally {
      await client.end({ timeout: 5 });
    }
  }, 300_000);

  test("a role with no rights on the credentials table is refused and changes nothing", async () => {
    const client = await v0215Database("stranger");
    try {
      await migrateWithoutRekey(client);
      await seed(client);
      await client.unsafe(`DO $$ BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'xiongbao_rekey_stranger') THEN
          CREATE ROLE xiongbao_rekey_stranger NOLOGIN NOSUPERUSER NOBYPASSRLS;
        END IF; END $$`);
      const before = await stored(client);
      const securityBefore = await rowSecurity(client);

      const failure = await client
        .begin(async (tx) => {
          await tx`set local role xiongbao_rekey_stranger`;
          return rekeyCredentials(tx, key);
        })
        .then(
          () => null,
          (error: unknown) => error,
        );

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain(
        "没有读写 credentials 表的权限",
      );
      expect((failure as Error).message).toContain("业务库没有任何改动");
      expect(await stored(client)).toEqual(before);
      expect(await rowSecurity(client)).toBe(securityBefore);
    } finally {
      await client.end({ timeout: 5 });
    }
  }, 300_000);

  test("a KEY_ENCRYPTION_KEY that is not a 32-byte base64 key is refused, changes nothing and is not printed", async () => {
    const client = await v0215Database("badkey");
    try {
      await seed(client);
      const before = await stored(client);
      const journalBefore = await journalSize(client);
      const securityBefore = await rowSecurity(client);
      const notAKey = `secret-looking-${randomUUID()}`;

      const failure = await migrateAsRelease(client, notAKey).then(
        () => null,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(Error);
      const message = (failure as Error).message;
      expect(message).toContain("不是 base64 编码的 32 字节密钥");
      expect(message).toContain("业务库没有任何改动");
      expect(message).not.toContain(notAKey);
      expect(await stored(client)).toEqual(before);
      expect(await journalSize(client)).toBe(journalBefore);
      expect(await rowSecurity(client)).toBe(securityBefore);
    } finally {
      await client.end({ timeout: 5 });
    }
  }, 300_000);
});
