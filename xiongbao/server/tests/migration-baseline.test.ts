import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import postgres from "postgres";
import { applyRelease, MIGRATIONS_FOLDER } from "../scripts/migrate";
import {
  applyMigrations,
  MIGRATIONS_JOURNAL,
} from "../src/db/apply-migrations";
import {
  BASELINE_TAG,
  BaselineMismatchError,
  PRE_BASELINE_LEDGER,
  readBaselineStructure,
} from "../src/db/baseline-adoption";
import { readMigrationFolder } from "../src/db/migration-reach";
import {
  diffStructure,
  flattenBooleanNesting,
  formatStructureDifferences,
  readStructure,
} from "../src/db/schema-structure";
import { UpgradeRefusedError } from "../src/db/upgrade-gate";
import {
  dumpDifference,
  normalizeSchemaDump,
  pgDumpSchema,
} from "./support/schema-dump";
import { splitSqlStatements } from "./support/sql-statements";
import {
  dropHistoryOwner,
  ensureHistoryOwner,
  LAST_V0215_MIGRATION,
  migrateThroughHistory,
  removeExtractedHistory,
  v0216MigrationsFolder,
} from "./support/v0216-history";

/**
 * v0.2.17 replaced the migration history (222 migrations, 0000–0241) with one baseline,
 * `drizzle/0000_baseline.sql`. These are the four things that make that safe:
 *
 *  - a new database built by the baseline is the database v0.2.16's history builds: the same structure
 *    item by item (`src/db/schema-structure`), the same schema-only dump once normalised
 *    (`tests/support/schema-dump`), and the same rows the history wrote into it;
 *  - production's own schema-only dump, taken on the v0.2.16 JD Cloud server
 *    (`tests/fixtures/production-schema-v0.2.16.sql`, structure only), is the baseline's;
 *  - a database whose structure is NOT the baseline's is refused at start, with every difference printed;
 *  - a database v0.2.16 left behind has its ledger rewritten to the baseline once, and only once.
 *
 * Databases are created through the owner (`TEST_DATABASE_ADMIN_URL`, a superuser); without it the
 * database half is skipped. The history comes from git (`tests/support/v0216-history`).
 */
const FIXTURE = join(
  import.meta.dir,
  "fixtures",
  "production-schema-v0.2.16.sql",
);
/** What the dump measured on the server it was taken on (2026-11-27). */
const FIXTURE_SHA256 =
  "57f3091c9f83ec245b98e10cd95c4239a297f3b943ee49d2b250fb4d7ca9931f";
const FIXTURE_BYTES = 838_688;
const FIXTURE_TABLES = 211;
/** The baseline as released in v0.2.17 (see the test that pins it). */
const BASELINE_SHA256 =
  "f28afdd65f58d5ead75a82654778c83eca544fc494de3ed764e9fc1b9c24f8f2";
/** Rows in v0.2.16's ledger: migrations 0000–0241, with the numbers the history skipped. */
const V0216_LEDGER_ROWS = 222;

const owner = process.env.TEST_DATABASE_ADMIN_URL?.trim();
const created: string[] = [];

function databaseUrl(name: string, role?: { role: string; password: string }) {
  const url = new URL(owner as string);
  url.pathname = `/${name}`;
  if (role) {
    url.username = role.role;
    url.password = role.password;
  }
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

/** A new empty database and a one-connection superuser client on it. */
async function newDatabase(label: string) {
  const name = `xiongbao_baseline_${label}_${randomUUID().slice(0, 8)}`;
  await onAdmin((admin) => admin.unsafe(`CREATE DATABASE "${name}"`));
  created.push(name);
  return {
    name,
    client: postgres(databaseUrl(name), { max: 1, onnotice: () => {} }),
  };
}

/** Close the client and drop its database now, rather than at the end: each one is a full schema. */
async function finish(database: { name: string; client: postgres.Sql }) {
  await database.client.end({ timeout: 5 });
  await onAdmin((admin) =>
    admin.unsafe(`DROP DATABASE IF EXISTS "${database.name}" WITH (FORCE)`),
  );
  created.splice(created.indexOf(database.name), 1);
}

/** A database v0.2.16 left behind: migrated through the whole history by its owner. */
async function v0216Database(label: string) {
  const database = await newDatabase(label);
  await onAdmin((admin) => ensureHistoryOwner(admin));
  await migrateThroughHistory(database.client);
  return database;
}

async function ledger(client: postgres.Sql) {
  return client<{ id: number; hash: string; created_at: string | null }[]>`
    select id, hash, created_at::text as created_at
      from drizzle.__drizzle_migrations order by id`;
}

async function archiveExists(client: postgres.Sql) {
  const [row] = await client<{ present: string | null }[]>`
    select to_regclass(${`drizzle.${PRE_BASELINE_LEDGER}`})::text as present`;
  return row?.present !== null && row?.present !== undefined;
}

/** Every row of every table in `public` that has any, as sorted JSON per table. */
async function rows(client: postgres.Sql) {
  const tables = await client<{ name: string }[]>`
    select quote_ident(relname) as name from pg_catalog.pg_class
     where relnamespace = 'public'::regnamespace and relkind = 'r' order by relname`;
  const out: Record<string, string> = {};
  for (const { name } of tables) {
    const [row] = await client.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', 'platform', true)`;
      return tx.unsafe<{ rows: string | null }[]>(
        `select json_agg(t order by t::text)::text as rows from public.${name} t`,
      );
    });
    if (row?.rows) out[name] = row.rows;
  }
  return out;
}

const baselineHash = async () => {
  const [baseline] = await readMigrationFolder(MIGRATIONS_FOLDER);
  if (!baseline) throw new Error("no baseline");
  return baseline;
};

afterAll(async () => {
  await removeExtractedHistory();
  if (!owner) return;
  await onAdmin(async (admin) => {
    for (const name of created)
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await dropHistoryOwner(admin);
  });
}, 120_000);

describe("the baseline", () => {
  test("is the only migration, and the folder's first entry", async () => {
    const folder = await readMigrationFolder(MIGRATIONS_FOLDER);
    expect(folder.map((entry) => entry.tag)).toEqual([BASELINE_TAG]);
  });

  test("is never edited once released: every adopted or new database records exactly this hash", async () => {
    // A database adopted onto the baseline, or built by it, holds its hash in the ledger. Edit the file and
    // that hash no longer names it: the ledger reads as the history, the history check refuses the database
    // (it lacks v0.2.16's rename migrations) and the service does not start. A change of structure is a
    // new migration after the baseline, never an edit to it.
    const [baseline] = await readMigrationFolder(MIGRATIONS_FOLDER);
    expect(baseline?.hash).toBe(BASELINE_SHA256);
  });

  test("names no role the product had before v0.2.16", async () => {
    const text = await readFile(
      join(MIGRATIONS_FOLDER, `${BASELINE_TAG}.sql`),
      "utf8",
    );
    expect(text).not.toMatch(/FOR ROLE\s/);
    expect(text).not.toMatch(/OWNER TO\s/);
    expect(text).toContain("CREATE ROLE xiongbao_app");
    expect(text).toContain("CREATE ROLE xiongbao_role_writer");
  });
});

describe.skipIf(!owner)("against v0.2.16's history", () => {
  test("fresh database from baseline equals database migrated from v0.2.16 history", async () => {
    const fresh = await newDatabase("fresh");
    const history = await v0216Database("history");
    try {
      await applyRelease(fresh.client, MIGRATIONS_FOLDER);

      const built = await fresh.client.begin((tx) => readStructure(tx));
      const migrated = await history.client.begin((tx) => readStructure(tx));
      expect(built).toEqual(migrated);
      // What the start-up check compares a database v0.2.16 left behind with is what the baseline builds.
      expect(built).toEqual(await readBaselineStructure(MIGRATIONS_FOLDER));

      const dumped = normalizeSchemaDump(pgDumpSchema(databaseUrl(fresh.name)));
      expect(
        dumpDifference(
          normalizeSchemaDump(pgDumpSchema(databaseUrl(history.name))),
          dumped,
        ),
      ).toEqual({ missing: [], unexpected: [] });

      // The rows the history wrote into an empty database (plans, provider templates), the baseline writes.
      expect(await rows(fresh.client)).toEqual(await rows(history.client));
      expect(Object.keys(await rows(fresh.client)).length).toBeGreaterThan(0);
    } finally {
      await finish(fresh);
      await finish(history);
    }
  }, 600_000);
});

describe("reading the structure", () => {
  test("a boolean expression regrouped by a dump and restore reads the same, a changed one does not", () => {
    const stored =
      "type=c CHECK ((((char_length(title) >= 1) AND (char_length(title) <= 80)) AND (revision >= 0)))";
    const restored =
      "type=c CHECK (((char_length(title) >= 1) AND (char_length(title) <= 80) AND (revision >= 0)))";
    expect(flattenBooleanNesting(stored)).toBe(flattenBooleanNesting(restored));
    expect(flattenBooleanNesting("(((a) OR (b)) OR (c))")).toBe(
      "((a) OR (b) OR (c))",
    );
    // A grouping that changes the meaning, a different bound, and text inside quotes stay as they are.
    expect(flattenBooleanNesting("((a) OR ((b) AND (c)))")).toBe(
      "((a) OR ((b) AND (c)))",
    );
    expect(flattenBooleanNesting(stored)).not.toBe(
      flattenBooleanNesting(stored.replace("<= 80", "<= 81")),
    );
    expect(flattenBooleanNesting("CHECK ((a = '((x) AND (y)) AND z'))")).toBe(
      "CHECK ((a = '((x) AND (y)) AND z'))",
    );
  });

  test("differences are listed per object, missing, unexpected or changed", () => {
    const expected = [
      [
        "index",
        "public.a_idx",
        "CREATE INDEX a_idx ON public.a USING btree (x)",
      ],
      ["policy", "public.a.p", "command=r"],
    ] as const;
    const actual = [
      [
        "index",
        "public.b_idx",
        "CREATE INDEX b_idx ON public.a USING btree (y)",
      ],
      ["policy", "public.a.p", "command=*"],
    ] as const;
    const differences = diffStructure(expected, actual);
    expect(differences).toEqual([
      { kind: "index", name: "public.a_idx", expected: expected[0][2] },
      { kind: "index", name: "public.b_idx", actual: actual[0][2] },
      {
        kind: "policy",
        name: "public.a.p",
        expected: "command=r",
        actual: "command=*",
      },
    ]);
    const printed = formatStructureDifferences(differences);
    expect(printed).toContain("index public.a_idx\n  - CREATE INDEX a_idx");
    expect(printed).toContain("  + （这个库里没有）");
    expect(printed).toContain("  - （基线里没有）");
  });
});

describe("production's schema dump", () => {
  test("is the file taken on the server, and holds no data", async () => {
    const bytes = await readFile(FIXTURE);
    expect(bytes.length).toBe(FIXTURE_BYTES);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      FIXTURE_SHA256,
    );
    const text = bytes.toString("utf8");
    expect((text.match(/^CREATE TABLE /gm) ?? []).length).toBe(FIXTURE_TABLES);
    expect(text).not.toMatch(/^(INSERT INTO|COPY) /m);
    expect(text).not.toMatch(/pg_catalog\.setval/);
  });

  test.skipIf(!owner)(
    "production schema dump matches the baseline",
    async () => {
      const fresh = await newDatabase("production");
      try {
        await applyRelease(fresh.client, MIGRATIONS_FOLDER);
        const difference = dumpDifference(
          normalizeSchemaDump(await readFile(FIXTURE, "utf8")),
          normalizeSchemaDump(pgDumpSchema(databaseUrl(fresh.name))),
        );
        expect(difference).toEqual({ missing: [], unexpected: [] });
      } finally {
        await finish(fresh);
      }
    },
    300_000,
  );

  test.skipIf(!owner)(
    "a database restored from production's dump, with v0.2.16's ledger, is taken onto the baseline",
    async () => {
      // What the start-up check concludes on production: its structure, rebuilt from its own dump (owners
      // left to the restoring role, psql's meta-commands and the client encoding dropped), under the
      // ledger v0.2.16 records. A restore also regroups some boolean expressions; the structure read
      // treats the two groupings as one (`flattenBooleanNesting`), which this proves on production's.
      const restored = await newDatabase("restored");
      const history = await v0216MigrationsFolder();
      try {
        const statements = splitSqlStatements(await readFile(FIXTURE, "utf8"))
          .filter((statement) => !statement.startsWith("\\"))
          // The production database's encoding (SQL_ASCII) is not this connection's to take.
          .filter((statement) => !statement.startsWith("SET client_encoding"))
          .filter(
            (statement) => !/^ALTER [A-Z ]+ .+ OWNER TO \S+$/s.test(statement),
          );
        await restored.client.unsafe(`${statements.join(";\n")};`);
        for (const migration of await readMigrationFolder(history))
          await restored.client`
            insert into drizzle.__drizzle_migrations (hash, created_at)
            values (${migration.hash}, ${migration.when})`;
        expect(await restored.client.begin((tx) => readStructure(tx))).toEqual(
          await readBaselineStructure(MIGRATIONS_FOLDER),
        );
        await applyRelease(restored.client, MIGRATIONS_FOLDER);
        const baseline = await baselineHash();
        expect((await ledger(restored.client)).map(({ hash }) => hash)).toEqual(
          [baseline.hash],
        );
      } finally {
        await rm(history, { recursive: true, force: true });
        await finish(restored);
      }
    },
    300_000,
  );

  test("normalising keeps every structural statement and drops only per-environment noise", async () => {
    const text = await readFile(FIXTURE, "utf8");
    const normalized = normalizeSchemaDump(text);
    // Gone: version comments, the per-run restrict key, session settings, owners, the ledger's own table.
    for (const statement of normalized) {
      expect(statement).not.toMatch(
        /^(--|\\|SET |SELECT pg_catalog\.set_config)/,
      );
      expect(statement).not.toMatch(/OWNER TO/);
      expect(statement).not.toMatch(/FOR ROLE/);
      expect(statement).not.toMatch(/drizzle\.__drizzle_migrations/);
    }
    // Kept: the grants to the application roles, the policies, the functions, the triggers, the ledger
    // schema's grant.
    expect(normalized).toContain(
      "GRANT USAGE ON SCHEMA drizzle TO xiongbao_app",
    );
    const lines = (pattern: RegExp) => (text.match(pattern) ?? []).length;
    const statements = (prefix: string) =>
      normalized.filter((statement) => statement.startsWith(prefix)).length;
    expect(lines(/^CREATE POLICY /gm)).toBeGreaterThan(900);
    expect(statements("CREATE POLICY")).toBe(lines(/^CREATE POLICY /gm));
    expect(statements("CREATE FUNCTION")).toBe(lines(/^CREATE FUNCTION /gm));
    expect(statements("CREATE TRIGGER")).toBe(lines(/^CREATE TRIGGER /gm));
    expect(statements("GRANT ")).toBe(lines(/^GRANT /gm));
    // A real difference is not normalised away: one more index, one column's type.
    const changed = normalizeSchemaDump(
      text
        .replace(
          "CREATE TABLE public.users (",
          "CREATE INDEX users_extra ON public.users USING btree (id);\n\nCREATE TABLE public.users (",
        )
        .replace(/(CREATE TABLE public\.plans \(\n\s+id) text/, "$1 varchar"),
    );
    const difference = dumpDifference(normalized, changed);
    expect(difference.unexpected.length).toBe(2);
    expect(difference.missing.length).toBe(1);
  });
});

describe.skipIf(!owner)("starting on a database v0.2.16 left behind", () => {
  test("migration ledger is rewritten once", async () => {
    const database = await v0216Database("adopt");
    const { client } = database;
    try {
      const before = await ledger(client);
      expect(before.length).toBe(V0216_LEDGER_ROWS);
      // A row the service wrote, which the adoption must not touch.
      await client.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', 'platform', true)`;
        await tx`insert into public.users (id, email, name) values ('baseline-person', 'baseline@example.test', 'Baseline')`;
      });

      await applyRelease(client, MIGRATIONS_FOLDER);
      const baseline = await baselineHash();
      const after = await ledger(client);
      expect(after.map(({ hash, created_at }) => [hash, created_at])).toEqual([
        [baseline.hash, String(baseline.when)],
      ]);
      const kept = await client<
        { id: number; hash: string; created_at: string | null }[]
      >`
        select id, hash, created_at::text as created_at
          from ${client(MIGRATIONS_JOURNAL.migrationsSchema)}.${client(PRE_BASELINE_LEDGER)} order by id`;
      expect(kept).toEqual(before);

      // The second start: the ledger already holds the baseline, so nothing is rewritten or kept again.
      await applyRelease(client, MIGRATIONS_FOLDER);
      expect(await ledger(client)).toEqual(after);
      const [still] = await client<{ n: number }[]>`
        select count(*)::int as n from ${client(MIGRATIONS_JOURNAL.migrationsSchema)}.${client(PRE_BASELINE_LEDGER)}`;
      expect(still?.n).toBe(V0216_LEDGER_ROWS);

      const [person] = await client.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', 'platform', true)`;
        return tx<
          { email: string }[]
        >`select email from public.users where id = 'baseline-person'`;
      });
      expect(person?.email).toBe("baseline@example.test");

      // The way back: with the kept rows put back, v0.2.16's own migrator finds nothing to do here.
      await client.begin(async (tx) => {
        await tx`delete from drizzle.__drizzle_migrations`;
        await tx.unsafe(
          `insert into drizzle.__drizzle_migrations (id, hash, created_at)
           select id, hash, created_at from drizzle.${PRE_BASELINE_LEDGER}`,
        );
      });
      const history = await v0216MigrationsFolder();
      try {
        await applyMigrations(client, history);
      } finally {
        await rm(history, { recursive: true, force: true });
      }
      expect((await ledger(client)).length).toBe(V0216_LEDGER_ROWS);
    } finally {
      await finish(database);
    }
  }, 600_000);

  test("mismatched schema refuses to start and prints the difference", async () => {
    const database = await v0216Database("mismatch");
    const { client } = database;
    try {
      await client.unsafe(
        "CREATE INDEX baseline_test_extra ON public.users USING btree (name)",
      );
      await client.unsafe("DROP POLICY tenant_isolation ON public.credentials");
      const before = await ledger(client);

      const refused = await applyRelease(client, MIGRATIONS_FOLDER).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(refused).toBeInstanceOf(BaselineMismatchError);
      const message = (refused as Error).message;
      expect(message).toContain("共 2 处");
      expect(message).toContain("index public.baseline_test_extra");
      expect(message).toContain("policy public.credentials.tenant_isolation");
      expect(message).toContain("数据库没有任何改动");
      expect(await ledger(client)).toEqual(before);
      expect(await archiveExists(client)).toBe(false);

      // The same through the script every deployment runs: it exits non-zero and prints the difference.
      const credentials = await onAdmin((admin) => ensureHistoryOwner(admin));
      const run = spawnSync(
        process.execPath,
        [join(import.meta.dir, "..", "scripts", "migrate.ts")],
        {
          encoding: "utf8",
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            NODE_ENV: "test",
            DATABASE_URL: databaseUrl(database.name, credentials),
          },
          timeout: 120_000,
        },
      );
      expect(run.status).not.toBe(0);
      expect(run.stdout).not.toContain("migrations-applied");
      expect(run.stderr).toContain("和 v0.2.17 的基线不一致");
      expect(run.stderr).toContain("index public.baseline_test_extra");
      expect(run.stderr).toContain("  + （这个库里没有）");
      expect(await ledger(client)).toEqual(before);
    } finally {
      await finish(database);
    }
  }, 600_000);

  test("a database v0.2.15 left behind is refused by the upgrade gate before any structure is compared", async () => {
    const database = await newDatabase("v0215");
    const { client } = database;
    try {
      await onAdmin((admin) => ensureHistoryOwner(admin));
      await migrateThroughHistory(client, { through: LAST_V0215_MIGRATION });
      const before = await ledger(client);
      const refused = await applyRelease(client, MIGRATIONS_FOLDER).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(refused).toBeInstanceOf(UpgradeRefusedError);
      expect((refused as Error).message).toContain("请先升级到 v0.2.16");
      expect(await ledger(client)).toEqual(before);
      expect(await archiveExists(client)).toBe(false);
    } finally {
      await finish(database);
    }
  }, 600_000);
});
