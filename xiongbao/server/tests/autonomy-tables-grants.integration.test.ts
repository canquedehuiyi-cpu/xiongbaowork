import { afterAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Tables made by 期 3 are written by the application's own role, so the baseline grants it the four
 * privileges on each (in v0.2.16's history migrations 0236 and 0237 did). Without the grant the first
 * write fails with "permission denied", and the tables are empty on every deployment whose role did not
 * get default privileges.
 */
const TABLES = [
  ["0236_heartbeat_runs", "heartbeat_runs"],
  ["0237_board_cards", "board_cards"],
] as const;
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
afterAll(async () => {
  await database.$client.close();
});

test.each(TABLES)(
  "%s: the role this suite connects as can read and write it",
  async (_tag, table) => {
    const rows = await runAsTenant("platform", () =>
      database.execute<{ ok: boolean }>(
        sql`select bool_and(has_table_privilege('xiongbao_app', ${`public.${table}`}, privilege)) as ok
        from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) as privilege`,
      ),
    );
    const list = Array.isArray(rows)
      ? rows
      : ((rows as { rows?: { ok: boolean }[] }).rows ?? []);
    expect(list[0]?.ok).toBe(true);
  },
);
