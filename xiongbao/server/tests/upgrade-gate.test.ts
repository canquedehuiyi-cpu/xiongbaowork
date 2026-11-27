import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import postgres from "postgres";
import { applyRelease, MIGRATIONS_FOLDER } from "../scripts/migrate";
import {
  PRE_RENAME_CREDENTIAL_KID,
  RENAME_MIGRATIONS,
  RENAMED_ROLES,
  readUpgradeFacts,
  type UpgradeFacts,
  UpgradeRefusedError,
  upgradeRefusal,
} from "../src/db/upgrade-gate";
import {
  dropHistoryOwner,
  ensureHistoryOwner,
  LAST_V0215_MIGRATION,
  migrateThroughHistory,
  removeExtractedHistory,
  V0216_COMMIT,
} from "./support/v0216-history";

/**
 * This release is reached only from v0.2.16. A database that has not been through v0.2.16's rename is
 * refused before any migration runs (`src/db/upgrade-gate.ts`), and keeps every row it had; a new one
 * migrates straight through.
 *
 * The decision is a function of four facts and is tested on its own; the database half stands real
 * databases at the shapes in question with the real migrator, v0.2.15's and v0.2.16's built by the
 * history they shipped (`tests/support/v0216-history`). Creating a database takes the owner
 * (`TEST_DATABASE_ADMIN_URL`); without it that half is skipped.
 *
 * Since v0.2.17 replaced the history with a baseline, the check runs on a ledger that still holds the
 * history, before the baseline is adopted (`src/db/baseline-adoption.ts`): a new database and one
 * already on the baseline are never asked.
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
        missingMigrations: RENAME_MIGRATIONS.map(([tag]) => tag),
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
      missingMigrations: RENAME_MIGRATIONS.map(([tag]) => tag),
      oldRoles: RENAMED_ROLES.map(([old]) => old),
      oldCredentials: 5,
    });
    expect(refusal).toContain("0240_rebrand_names、0241_rebrand_history");
    expect(refusal).toContain("openbot_app、openbot_role_writer");
    expect(refusal).toContain("5 条");
  });
});

test("the rename migrations are recognised by the hashes v0.2.16 recorded for them", () => {
  // The files as v0.2.16 shipped them, read from the commit it was released from.
  for (const [tag, hash] of RENAME_MIGRATIONS) {
    const file = spawnSync(
      "git",
      [
        "show",
        `${V0216_COMMIT}:xiongbao/server/recovery/recovery-20261018-v1/sql/${tag}.sql`,
      ],
      { cwd: import.meta.dir, maxBuffer: 16 * 1024 * 1024 },
    );
    expect(file.status).toBe(0);
    expect(createHash("sha256").update(file.stdout).digest("hex")).toBe(hash);
  }
});

const owner = process.env.TEST_DATABASE_ADMIN_URL?.trim();
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

/** A database the history built, through `through` when given (v0.2.15), else to the end (v0.2.16). */
async function historyDatabase(label: string, through?: string) {
  const client = await newDatabase(label);
  await onAdmin((admin) => ensureHistoryOwner(admin));
  await migrateThroughHistory(client, through ? { through } : {});
  return client;
}

async function journalSize(client: postgres.Sql) {
  const [row] = await client<{ n: number }[]>`
    select count(*)::int as n from drizzle.__drizzle_migrations`;
  return row?.n ?? 0;
}

async function appliedRows(client: postgres.Sql) {
  return (
    await client<{ hash: string; created_at: string | null }[]>`
      select hash, created_at from drizzle.__drizzle_migrations`
  ).map((entry) => ({
    hash: entry.hash,
    createdAt: entry.created_at === null ? null : Number(entry.created_at),
  }));
}

afterAll(async () => {
  await removeExtractedHistory();
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
    await dropHistoryOwner(admin);
  });
}, 120_000);

describe.skipIf(!owner)("migrating with the check", () => {
  test("a new database migrates straight from the baseline, and again changes nothing", async () => {
    const client = await newDatabase("new");
    try {
      await applyRelease(client, MIGRATIONS_FOLDER);
      expect(await journalSize(client)).toBe(1);
      await applyRelease(client, MIGRATIONS_FOLDER);
      expect(await journalSize(client)).toBe(1);
    } finally {
      await client.end({ timeout: 5 });
    }
  }, 300_000);

  test("a database at v0.2.15's schema is refused before any migration, and keeps its journal", async () => {
    const client = await historyDatabase("v0215", LAST_V0215_MIGRATION);
    try {
      const before = await journalSize(client);
      const refused = await applyRelease(client, MIGRATIONS_FOLDER).then(
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
    const client = await historyDatabase("k1");
    try {
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
      const refused = await applyRelease(client, MIGRATIONS_FOLDER).then(
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
      const applied = await appliedRows(client);
      const [after] = await client.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', 'caller-frame', true)`;
        const facts = await readUpgradeFacts(tx, applied);
        expect(facts.oldCredentials).toBe(1);
        expect(facts.missingMigrations).toEqual([]);
        return tx<{ frame: string | null }[]>`
          select current_setting('app.tenant_id', true) as frame`;
      });
      expect(after?.frame).toBe("caller-frame");
    } finally {
      await client.end({ timeout: 5 });
    }
  }, 300_000);

  test("a database already on the baseline is not asked again", async () => {
    const client = await historyDatabase("adopted");
    try {
      await applyRelease(client, MIGRATIONS_FOLDER);
      expect(await journalSize(client)).toBe(1);
      // The rename migrations are no longer in the ledger; the baseline is, so the check does not run.
      await applyRelease(client, MIGRATIONS_FOLDER);
      expect(await journalSize(client)).toBe(1);
    } finally {
      await client.end({ timeout: 5 });
    }
  }, 300_000);
});
