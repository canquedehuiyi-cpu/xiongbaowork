import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";

/**
 * What the Drizzle column types hand the driver, for every table at once: a JSONB value goes through as
 * the caller's object (never a string of it, which the driver would encode a second time), a bytea value
 * as the caller's Buffer, and a 64-bit integer column in bigint mode keeps every digit.
 *
 * Until v0.2.17 each recovery-overlay migration's own test checked this for the tables it created, beside
 * its byte-frozen SQL. The SQL is one baseline now (`migration-baseline.test.ts`); this keeps the half
 * about the driver, without a database.
 */
async function columns() {
  const directory = join(import.meta.dir, "..", "src", "db", "schema");
  const found: {
    table: string;
    column: ReturnType<typeof getTableConfig>["columns"][number];
  }[] = [];
  for (const file of readdirSync(directory).filter((name) =>
    name.endsWith(".ts"),
  )) {
    const module = (await import(join(directory, file))) as Record<
      string,
      unknown
    >;
    for (const value of Object.values(module)) {
      if (!is(value, PgTable)) continue;
      const config = getTableConfig(value as PgTable);
      for (const column of config.columns)
        found.push({ table: config.name, column });
    }
  }
  return found;
}

test("JSONB and bytea columns hand the driver the caller's own value", async () => {
  const all = await columns();
  const custom = all.filter(
    ({ column }) =>
      column.columnType === "PgCustomColumn" &&
      ["jsonb", "bytea"].includes(column.getSQLType()),
  );
  expect(
    custom.filter(({ column }) => column.getSQLType() === "jsonb").length,
  ).toBeGreaterThan(20);
  expect(
    custom.filter(({ column }) => column.getSQLType() === "bytea").length,
  ).toBeGreaterThan(3);
  const problems: string[] = [];
  for (const { table, column } of custom) {
    const value =
      column.getSQLType() === "jsonb"
        ? { arbitrary: { x: null }, items: [1, true, "两"] }
        : Buffer.from([0, 1, 254, 255]);
    if (column.mapToDriverValue(value) !== value)
      problems.push(`${table}.${column.name} does not pass its value through`);
  }
  expect(problems).toEqual([]);
});

test("bigint-mode columns keep every digit of a 64-bit value", async () => {
  const all = await columns();
  const wide = all.filter(({ column }) => column.columnType === "PgBigInt64");
  expect(wide.length).toBeGreaterThan(3);
  const problems: string[] = [];
  for (const { table, column } of wide) {
    for (const [driver, value] of [
      ["9223372036854775807", 9223372036854775807n],
      ["-9223372036854775808", -9223372036854775808n],
      ["0", 0n],
    ] as const) {
      if (column.mapFromDriverValue(driver) !== value)
        problems.push(
          `${table}.${column.name} reads ${driver} as ${String(column.mapFromDriverValue(driver))}`,
        );
    }
    if (
      String(column.mapToDriverValue(9223372036854775807n)) !==
      "9223372036854775807"
    )
      problems.push(
        `${table}.${column.name} narrows a 64-bit value on the way out`,
      );
  }
  expect(problems).toEqual([]);
});
