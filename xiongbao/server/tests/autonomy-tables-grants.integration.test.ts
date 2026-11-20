import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Tables made by 期 3 are written by the application's own role, so each migration grants it the four
 * privileges (as 0232 and 0233 do). Without the grant the first write fails with "permission denied", and
 * the tables are empty on every deployment whose role did not get default privileges.
 */
const TABLES = [["0236_heartbeat_runs", "heartbeat_runs"]] as const;
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
afterAll(async () => {
  await database.$client.close();
});

test.each(TABLES)(
  "migration %s grants the application role the table",
  (tag, table) => {
    const text = readFileSync(
      join(
        import.meta.dir,
        "..",
        "recovery",
        "recovery-20261018-v1",
        "sql",
        `${tag}.sql`,
      ),
      "utf8",
    );
    expect(text).toContain(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."${table}" TO openbot_app;`,
    );
  },
);

test.each(TABLES)(
  "%s: the role this suite connects as can read and write it",
  async (_tag, table) => {
    const rows = await runAsTenant("platform", () =>
      database.execute<{ ok: boolean }>(
        sql`select bool_and(has_table_privilege('openbot_app', ${`public.${table}`}, privilege)) as ok
        from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) as privilege`,
      ),
    );
    const list = Array.isArray(rows)
      ? rows
      : ((rows as { rows?: { ok: boolean }[] }).rows ?? []);
    expect(list[0]?.ok).toBe(true);
  },
);
