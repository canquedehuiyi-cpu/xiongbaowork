import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import postgres from "postgres";
import { applyRelease, mergedMigrationsFolder } from "../scripts/migrate";
import { applyMigrations } from "../src/db/apply-migrations";
import { readMigrationFolder } from "../src/db/migration-reach";
import {
  PRE_RENAME_CREDENTIAL_KID,
  RENAME_MIGRATIONS,
  RENAMED_ROLES,
  readUpgradeFacts,
  type UpgradeFacts,
  UpgradeRefusedError,
  upgradeRefusal,
} from "../src/db/upgrade-gate";

/**
 * This release is reached only from v0.2.16. A database that has not been through v0.2.16's rename is
 * refused before any migration runs (`src/db/upgrade-gate.ts`), and keeps every row it had; a new one
 * migrates straight through.
 *
 * The decision is a function of four facts and is tested on its own; the database half stands real
 * databases at the shapes in question with the real migrator. Creating a database takes the owner
 * (`TEST_DATABASE_ADMIN_URL`); without it that half is skipped.
 */
const renamed: UpgradeFacts = {
  applied: 242,
  missingMigrations: [],
  oldRoles: [],
  oldCredentials: 0,
};

describe("the decision", () => {
  test("a database the migrator has never touched is never refused", () => {
    expect(
      upgradeRefusal({
        applied: 0,
        missingMigrations: [...RENAME_MIGRATIONS],
        oldRoles: ["openbot_app"],
        oldCredentials: 3,
      }),
    ).toBeUndefined();
  });

  test("a database through v0.2.16 is not refused", () => {
    expect(upgradeRefusal(renamed)).toBeUndefined();
  });

  test("each fact on its own refuses, says what it found and that nothing changed", () => {
    const cases: [UpgradeFacts, string][] = [
      [
        { ...renamed, missingMigrations: ["0240_rebrand_names"] },
        "迁移记录里没有 v0.2.16 的改名迁移（0240_rebrand_names）",
      ],
      [
        { ...renamed, oldRoles: ["openbot_role_writer"] },
        "应用角色仍是改名前的名字（openbot_role_writer）",
      ],
      [
        { ...renamed, oldCredentials: 2 },
        `还有 2 条 v0.2.16 之前格式（kid ${PRE_RENAME_CREDENTIAL_KID}）的凭据`,
      ],
    ];
    for (const [facts, says] of cases) {
      const refusal = upgradeRefusal(facts);
      expect(refusal).toContain(says);
      expect(refusal).toContain("请先升级到 v0.2.16");
      expect(refusal).toContain("数据库没有任何改动");
    }
  });

  test("a v0.2.15 database is refused for every reason at once", () => {
    const refusal = upgradeRefusal({
      applied: 240,
      missingMigrations: [...RENAME_MIGRATIONS],
      oldRoles: RENAMED_ROLES.map(([old]) => old),
      oldCredentials: 5,
    });
    expect(refusal).toContain("0240_rebrand_names、0241_rebrand_history");
    expect(refusal).toContain("openbot_app、openbot_role_writer");
    expect(refusal).toContain("5 条");
  });
});

const owner = process.env.TEST_DATABASE_ADMIN_URL?.trim();
const LAST_V0215_MIGRATION = "0239_aihub_provider_template";
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

async function newDatabase(label: string) {
  const name = `xiongbao_gate_${label}_${randomUUID().slice(0, 8)}`;
  await onAdmin((admin) => admin.unsafe(`CREATE DATABASE "${name}"`));
  created.push(name);
  return postgres(databaseUrl(name), { max: 1, onnotice: () => {} });
}

async function migrate(
  client: postgres.Sql,
  apply: typeof applyMigrations,
  through?: string,
) {
  const folder = await mergedMigrationsFolder(through ? { through } : {});
  try {
    await apply(client, folder);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

async function journalSize(client: postgres.Sql) {
  const [row] = await client<{ n: number }[]>`
    select count(*)::int as n from drizzle.__drizzle_migrations`;
  return row?.n ?? 0;
}

afterAll(async () => {
  if (!owner) return;
  await onAdmin(async (admin) => {
    for (const name of created)
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    /*
     * A database stood at v0.2.15's schema on a cluster whose roles another database had already renamed
     * recreates the old roles (0054, 0109). Nothing references them once these databases are gone; drop
     * them so a known-password login does not outlive the suite. Ones another database still uses stay.
     */
    for (const [role] of RENAMED_ROLES) {
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

describe.skipIf(!owner)("migrating with the check", () => {
  test("a new database migrates straight through, and again changes nothing", async () => {
    const client = await newDatabase("new");
    try {
      await migrate(client, applyRelease);
      const size = await journalSize(client);
      expect(size).toBeGreaterThan(200);
      await migrate(client, applyRelease);
      expect(await journalSize(client)).toBe(size);
    } finally {
      await client.end({ timeout: 5 });
    }
  }, 300_000);

  test("a database at v0.2.15's schema is refused before any migration, and keeps its journal", async () => {
    const client = await newDatabase("v0215");
    try {
      await migrate(client, applyMigrations, LAST_V0215_MIGRATION);
      const before = await journalSize(client);
      const refused = await migrate(client, applyRelease).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(refused).toBeInstanceOf(UpgradeRefusedError);
      expect((refused as Error).message).toContain(
        "0240_rebrand_names、0241_rebrand_history",
      );
      expect((refused as Error).message).toContain("请先升级到 v0.2.16");
      expect(await journalSize(client)).toBe(before);
    } finally {
      await client.end({ timeout: 5 });
    }
  }, 300_000);

  test("a credential still sealed under the pre-v0.2.16 kid is refused, and the row stays as it was", async () => {
    const client = await newDatabase("k1");
    try {
      await migrate(client, applyRelease);
      const envelope = JSON.stringify({
        version: 2,
        alg: "A256GCM",
        bind: "credential",
        kid: PRE_RENAME_CREDENTIAL_KID,
        iv: "AAAAAAAAAAAAAAAA",
        ciphertext: "AAAA",
      });
      const id = randomUUID();
      await client.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', 'platform', true)`;
        await tx`insert into public.credentials (id, kind, provider, encrypted_value, key_id, metadata, tenant_id)
          values (${id}, 'connector', 'gate-test', ${envelope}, 'k', '{}'::jsonb, 'gate-tenant')`;
      });
      const before = await journalSize(client);
      const refused = await migrate(client, applyRelease).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(refused).toBeInstanceOf(UpgradeRefusedError);
      expect((refused as Error).message).toContain(
        `还有 1 条 v0.2.16 之前格式（kid ${PRE_RENAME_CREDENTIAL_KID}）的凭据`,
      );
      expect((refused as Error).message).not.toContain("迁移记录里没有");
      expect(await journalSize(client)).toBe(before);
      const [row] = await client.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', 'platform', true)`;
        return tx<{ value: string }[]>`
          select encrypted_value as value from public.credentials where id = ${id}`;
      });
      expect(row?.value).toBe(envelope);

      // The check counts in the platform frame and leaves the caller's frame exactly as it found it.
      const folder = await mergedMigrationsFolder();
      try {
        const migrations = await readMigrationFolder(folder);
        const applied = (
          await client<{ hash: string; created_at: string | null }[]>`
            select hash, created_at from drizzle.__drizzle_migrations`
        ).map((entry) => ({
          hash: entry.hash,
          createdAt:
            entry.created_at === null ? null : Number(entry.created_at),
        }));
        const [after] = await client.begin(async (tx) => {
          await tx`select set_config('app.tenant_id', 'caller-frame', true)`;
          const facts = await readUpgradeFacts(tx, migrations, applied);
          expect(facts.oldCredentials).toBe(1);
          return tx<{ frame: string | null }[]>`
            select current_setting('app.tenant_id', true) as frame`;
        });
        expect(after?.frame).toBe("caller-frame");
      } finally {
        await rm(folder, { recursive: true, force: true });
      }
    } finally {
      await client.end({ timeout: 5 });
    }
  }, 300_000);
});
