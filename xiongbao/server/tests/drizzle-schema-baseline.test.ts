import { afterAll, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { is, sql } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { createDatabase } from "../src/db/client";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * The Drizzle schema the server queries through (`src/db/schema`) agrees with the database the
 * baseline builds.
 *
 * Until v0.2.17 each migration in the recovery overlay had a test of its own holding that migration's
 * SQL, byte for byte, against the Drizzle definition of the tables it created. The migrations are one
 * baseline now, and what the baseline builds is pinned by `migration-baseline.test.ts` (the same
 * structure as v0.2.16's history and as production); this is the other half those tests carried, for
 * every table at once: each table Drizzle declares exists, with each of its columns under the same type
 * and nullability, a default where Drizzle has one, its primary key on the same columns, each foreign key
 * pointing at the same columns, each unique constraint, check, index and policy present, and row-level
 * security on where Drizzle turns it on.
 *
 * Constraint names are compared only where Drizzle's name is the database's: several foreign and primary
 * keys were named by hand in the migrations (or cut at PostgreSQL's 63 bytes), so keys are matched by
 * their columns instead.
 *
 * Read from the catalogs of the test database, which the baseline migrated.
 */

/**
 * Where Drizzle and the database disagree in v0.2.16 already, and production with them. Each is the
 * structure production has (the baseline must not change it); fixing one is a migration of its own.
 *
 *  - `skill_assets` was created by migration 0205 without the primary key Drizzle declares on
 *    (skill_id, path): production's dump has none either.
 */
const KNOWN_DISAGREEMENTS: readonly string[] = [
  "primary key skill_assets(skill_id,path) is not in the database",
];
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
afterAll(async () => {
  await database.$client.close();
});

async function catalog<T>(query: string): Promise<T[]> {
  return (await runAsTenant("system", () =>
    database.execute(sql.raw(query)),
  )) as unknown as T[];
}

async function drizzleTables(): Promise<Map<string, PgTable>> {
  const directory = join(import.meta.dir, "..", "src", "db", "schema");
  const tables = new Map<string, PgTable>();
  for (const file of readdirSync(directory).filter((name) =>
    name.endsWith(".ts"),
  )) {
    const module = (await import(join(directory, file))) as Record<
      string,
      unknown
    >;
    for (const value of Object.values(module)) {
      if (is(value, PgTable))
        tables.set(getTableConfig(value as PgTable).name, value as PgTable);
    }
  }
  return tables;
}

/** Drizzle's SQL type as PostgreSQL's `format_type` prints it. */
function asPostgresType(type: string): string {
  return type
    .replace(/^varchar/, "character varying")
    .replace(/^serial$/, "integer")
    .replace(/^bigserial$/, "bigint")
    .replace(/^smallserial$/, "smallint")
    .replace(/^"([a-z_]+)"$/, "$1");
}

test("every table, column, key, constraint, index and policy Drizzle declares is in the baseline database", async () => {
  const tables = await drizzleTables();
  expect(tables.size).toBeGreaterThan(200);

  const columns = await catalog<{
    t: string;
    c: string;
    type: string;
    not_null: boolean;
    has_default: boolean;
  }>(`select c.relname as t, a.attname as c, format_type(a.atttypid, a.atttypmod) as type,
            a.attnotnull as not_null, a.atthasdef as has_default
       from pg_attribute a join pg_class c on c.oid = a.attrelid
      where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
        and a.attnum > 0 and not a.attisdropped`);
  const constraints = await catalog<{
    t: string;
    n: string;
    k: string;
    cols: string;
    ref: string | null;
    ref_cols: string | null;
  }>(`select k.conrelid::regclass::text as t, k.conname as n, k.contype::text as k,
            (select string_agg(a.attname, ',' order by u.o) from unnest(k.conkey) with ordinality u(n, o)
               join pg_attribute a on a.attrelid = k.conrelid and a.attnum = u.n) as cols,
            k.confrelid::regclass::text as ref,
            (select string_agg(a.attname, ',' order by u.o) from unnest(k.confkey) with ordinality u(n, o)
               join pg_attribute a on a.attrelid = k.confrelid and a.attnum = u.n) as ref_cols
       from pg_constraint k
      where k.connamespace = 'public'::regnamespace and k.conrelid <> 0`);
  const indexes = await catalog<{ t: string; n: string; cols: string }>(
    `select i.indrelid::regclass::text as t, c.relname as n,
            (select string_agg(coalesce(a.attname, '?'), ',' order by u.o) from unnest(i.indkey::int2[]) with ordinality u(n, o)
               left join pg_attribute a on a.attrelid = i.indrelid and a.attnum = u.n) as cols
       from pg_index i join pg_class c on c.oid = i.indexrelid
      where c.relnamespace = 'public'::regnamespace`,
  );
  const uniqueIndexes = await catalog<{ t: string; cols: string }>(
    `select i.indrelid::regclass::text as t,
            (select string_agg(a.attname, ',' order by u.o) from unnest(i.indkey::int2[]) with ordinality u(n, o)
               join pg_attribute a on a.attrelid = i.indrelid and a.attnum = u.n) as cols
       from pg_index i join pg_class c on c.oid = i.indexrelid
      where c.relnamespace = 'public'::regnamespace and i.indisunique`,
  );
  const policies = await catalog<{ t: string; n: string }>(
    "select polrelid::regclass::text as t, polname as n from pg_policy",
  );
  const security = await catalog<{ t: string; rls: boolean }>(
    `select relname as t, relrowsecurity as rls from pg_class
      where relnamespace = 'public'::regnamespace and relkind in ('r', 'p')`,
  );

  const column = new Map(columns.map((row) => [`${row.t}.${row.c}`, row]));
  const problems: string[] = [];
  for (const [name, table] of tables) {
    const config = getTableConfig(table);
    if (!security.some((row) => row.t === name)) {
      problems.push(`table ${name} is not in the database`);
      continue;
    }
    for (const declared of config.columns) {
      const found = column.get(`${name}.${declared.name}`);
      if (!found) {
        problems.push(`column ${name}.${declared.name} is not in the database`);
        continue;
      }
      if (asPostgresType(declared.getSQLType()) !== found.type)
        problems.push(
          `column ${name}.${declared.name}: Drizzle ${declared.getSQLType()}, database ${found.type}`,
        );
      if (declared.notNull !== found.not_null)
        problems.push(
          `column ${name}.${declared.name}: Drizzle not null ${declared.notNull}, database ${found.not_null}`,
        );
      if (declared.hasDefault && !found.has_default && !declared.generated)
        problems.push(
          `column ${name}.${declared.name}: Drizzle has a default, the database none`,
        );
    }
    const keyOf = (kind: string, cols: string) =>
      constraints.some(
        (row) => row.t === name && row.k === kind && row.cols === cols,
      );
    const inlinePrimary = config.columns
      .filter((declared) => declared.primary)
      .map((declared) => declared.name);
    for (const cols of [
      ...(inlinePrimary.length > 0 ? [inlinePrimary.join(",")] : []),
      ...config.primaryKeys.map((key) =>
        key.columns.map((declared) => declared.name).join(","),
      ),
    ]) {
      if (!keyOf("p", cols))
        problems.push(`primary key ${name}(${cols}) is not in the database`);
    }
    for (const key of config.foreignKeys) {
      const reference = key.reference();
      const cols = reference.columns.map((declared) => declared.name).join(",");
      const target = getTableConfig(reference.foreignTable).name;
      const targetCols = reference.foreignColumns
        .map((declared) => declared.name)
        .join(",");
      if (
        !constraints.some(
          (row) =>
            row.t === name &&
            row.k === "f" &&
            row.cols === cols &&
            row.ref === target &&
            row.ref_cols === targetCols,
        )
      )
        problems.push(
          `foreign key ${name}(${cols}) → ${target}(${targetCols}) is not in the database`,
        );
    }
    for (const unique of config.uniqueConstraints) {
      const cols = unique.columns.map((declared) => declared.name).join(",");
      if (!uniqueIndexes.some((row) => row.t === name && row.cols === cols))
        problems.push(`unique ${name}(${cols}) is not in the database`);
    }
    for (const declared of config.columns.filter((c) => c.isUnique)) {
      if (
        !uniqueIndexes.some(
          (row) => row.t === name && row.cols === declared.name,
        )
      )
        problems.push(
          `unique ${name}(${declared.name}) is not in the database`,
        );
    }
    for (const check of config.checks) {
      if (
        !constraints.some(
          (row) => row.t === name && row.k === "c" && row.n === check.name,
        )
      )
        problems.push(`check ${name}.${check.name} is not in the database`);
    }
    for (const index of config.indexes) {
      const indexName = index.config.name;
      if (
        !indexName ||
        !indexes.some((row) => row.t === name && row.n === indexName)
      )
        problems.push(`index ${name}.${indexName} is not in the database`);
    }
    for (const policy of config.policies) {
      if (!policies.some((row) => row.t === name && row.n === policy.name))
        problems.push(`policy ${name}.${policy.name} is not in the database`);
    }
    if (
      (config.enableRLS || config.policies.length > 0) &&
      !security.find((row) => row.t === name)?.rls
    )
      problems.push(
        `table ${name}: Drizzle turns row-level security on, the database does not`,
      );
  }
  expect(
    problems.filter((problem) => !KNOWN_DISAGREEMENTS.includes(problem)),
  ).toEqual([]);
  // A known disagreement that has been fixed comes off the list.
  expect(
    KNOWN_DISAGREEMENTS.filter((known) => !problems.includes(known)),
  ).toEqual([]);
});
