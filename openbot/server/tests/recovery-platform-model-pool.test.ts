import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type SQL, sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { asPlatform } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Migration 0120 (stories H1, K1): the platform model pool is a platform-owned catalogue with no
 * tenant column, readable and never writable by the application role, holding the NAME of a pool key
 * and never a key; and agent_profiles may point at it, but never at a pool model and a library model
 * at once.
 *
 * Asked of the catalogue of the database the server writes to, as the role it writes as, rather than
 * of the migration text. The journal position is not assumed: other overlay migrations may sit around
 * this one, so only its own entry and its ordering against its predecessors are checked.
 */
const overlay = join(import.meta.dir, "../recovery/recovery-20261018-v1");
const TAG = "0120_platform_model_pool";
const database = createDatabase(testDatabaseUrl(), TEST_POOL);

afterAll(async () => {
  await database.$client.close();
});

/**
 * Catalogue probes and the refused write belong to no tenant: run in the platform frame. The frame
 * changes only the tenant settings, not the role: the connection is still openbot_app.
 */
async function rows<T>(query: SQL): Promise<T[]> {
  const result = await asPlatform(() => database.execute(query));
  return (Array.isArray(result) ? result : []) as T[];
}

/** The message of an error and of every cause under it, which is where Postgres's sentence is. */
function failureText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    if (current instanceof Error) parts.push(current.message);
    else parts.push(String(current));
    current = (current as { cause?: unknown }).cause;
  }
  return parts.join(" | ");
}

type Entry = {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
};

describe("migration 0120 platform model pool", () => {
  test("is journaled once, after everything before it, with its SQL beside it", () => {
    const journal = JSON.parse(
      readFileSync(join(overlay, "meta/_journal.json"), "utf8"),
    ) as { entries: Entry[] };
    const matches = journal.entries.filter((entry) => entry.tag === TAG);
    expect(matches).toHaveLength(1);
    const position = journal.entries.findIndex((entry) => entry.tag === TAG);
    const entry = journal.entries[position];
    expect(entry).toMatchObject({ version: "7", breakpoints: true });
    for (const earlier of journal.entries.slice(0, position)) {
      expect(earlier.when).toBeLessThan(entry.when);
      expect(earlier.idx).toBeLessThan(entry.idx);
    }
    expect(new Set(journal.entries.map((e) => e.idx)).size).toBe(
      journal.entries.length,
    );
    expect(existsSync(join(overlay, `sql/${TAG}.sql`))).toBe(true);
  });

  test("the pool has exactly its columns, and no tenant column", async () => {
    const columns = await rows<{
      name: string;
      type: string;
      nullable: string;
      fallback: string | null;
    }>(sql`
      select column_name as name, data_type as type, is_nullable as nullable,
             column_default as fallback
      from information_schema.columns
      where table_schema = 'public' and table_name = 'platform_model_pool'
      order by ordinal_position
    `);
    expect(columns.map((c) => [c.name, c.type, c.nullable])).toEqual([
      ["id", "uuid", "NO"],
      ["provider", "text", "NO"],
      ["base_url", "text", "YES"],
      ["model_name", "text", "NO"],
      ["label", "text", "NO"],
      ["api_key_env", "text", "NO"],
      ["tiers", "ARRAY", "NO"],
      ["enabled", "boolean", "NO"],
      ["created_at", "timestamp with time zone", "NO"],
      ["updated_at", "timestamp with time zone", "NO"],
    ]);
    expect(columns.some((c) => c.name === "tenant_id")).toBe(false);
    const byName = new Map(columns.map((c) => [c.name, c.fallback ?? ""]));
    expect(byName.get("id")).toContain("gen_random_uuid()");
    expect(byName.get("tiers")).toContain("{free,pro}");
    expect(byName.get("enabled")).toBe("true");
  });

  test("the pool's constraints: a pool key name, plans from the catalogue, one row per model", async () => {
    const constraints = await rows<{
      name: string;
      kind: string;
      def: string;
    }>(sql`
      select conname as name, contype as kind, pg_get_constraintdef(oid) as def
      from pg_catalog.pg_constraint
      where conrelid = 'public.platform_model_pool'::regclass
      order by conname
    `);
    const byName = new Map(constraints.map((c) => [c.name, c]));
    const keyEnv = byName.get("platform_model_pool_api_key_env");
    expect(keyEnv?.kind).toBe("c");
    expect(keyEnv?.def).toContain("api_key_env");
    expect(keyEnv?.def).toContain("'^OPENBOT_POOL_[A-Z0-9_]{1,64}$'");
    const tiers = byName.get("platform_model_pool_tiers");
    expect(tiers?.kind).toBe("c");
    expect(tiers?.def).toContain("tiers <@ '{free,pro}'::text[]");
    const unique = byName.get("platform_model_pool_provider_model_unique");
    expect(unique?.kind).toBe("u");
    expect(unique?.def).toBe("UNIQUE (provider, model_name)");
    expect(constraints.filter((c) => c.kind === "p")).toHaveLength(1);
  });

  test("the application role may read the pool and nothing more", async () => {
    const [privileges] = await rows<Record<string, boolean>>(sql`
      select
        has_table_privilege('openbot_app', 'public.platform_model_pool', 'SELECT') as "select",
        has_table_privilege('openbot_app', 'public.platform_model_pool', 'INSERT') as "insert",
        has_table_privilege('openbot_app', 'public.platform_model_pool', 'UPDATE') as "update",
        has_table_privilege('openbot_app', 'public.platform_model_pool', 'DELETE') as "delete",
        has_table_privilege('openbot_app', 'public.platform_model_pool', 'TRUNCATE') as "truncate",
        has_table_privilege('openbot_app', 'public.platform_model_pool', 'REFERENCES') as "references",
        has_table_privilege('openbot_app', 'public.platform_model_pool', 'TRIGGER') as "trigger"
    `);
    expect(privileges).toEqual({
      select: true,
      insert: false,
      update: false,
      delete: false,
      truncate: false,
      references: false,
      trigger: false,
    });
  });

  test("an INSERT through the application's own connection is refused", async () => {
    const [who] = await rows<{ role: string }>(
      sql`select current_user as role`,
    );
    // The suite connects as the application role in CI; the refusal below is about that role.
    expect(who?.role).toBe("openbot_app");
    const failure = await asPlatform(() =>
      database.execute(sql`
        insert into public.platform_model_pool (provider, model_name, label, api_key_env)
        values ('openai', ${`app-insert-${Date.now()}`}, '越权写入', 'OPENBOT_POOL_APP_INSERT')
      `),
    ).then(
        () => null,
        (error: unknown) => error,
      );
    expect(failure).not.toBeNull();
    expect(failureText(failure)).toContain(
      "permission denied for table platform_model_pool",
    );
  });

  test("agent_profiles binds to the pool, restricted on delete, and never to both kinds of model", async () => {
    const [column] = await rows<{ type: string; nullable: string }>(sql`
      select data_type as type, is_nullable as nullable
      from information_schema.columns
      where table_schema = 'public' and table_name = 'agent_profiles'
        and column_name = 'platform_model_ref'
    `);
    expect(column).toEqual({ type: "uuid", nullable: "YES" });

    const constraints = await rows<{
      name: string;
      kind: string;
      onDelete: string;
      target: string | null;
      def: string;
    }>(sql`
      select conname as name, contype as kind, confdeltype as "onDelete",
             confrelid::regclass::text as target, pg_get_constraintdef(oid) as def
      from pg_catalog.pg_constraint
      where conrelid = 'public.agent_profiles'::regclass
        and conname in (
          'agent_profiles_platform_model_ref_platform_model_pool_id_fk',
          'agent_profiles_single_model_binding'
        )
      order by conname
    `);
    expect(constraints).toHaveLength(2);
    const [foreignKey, single] = constraints;
    expect(foreignKey).toMatchObject({
      name: "agent_profiles_platform_model_ref_platform_model_pool_id_fk",
      kind: "f",
      onDelete: "r",
      target: "platform_model_pool",
    });
    expect(foreignKey.def).toContain("FOREIGN KEY (platform_model_ref)");
    expect(single).toMatchObject({
      name: "agent_profiles_single_model_binding",
      kind: "c",
    });
    expect(single.def).toContain("model_ref IS NULL");
    expect(single.def).toContain("platform_model_ref IS NULL");
    expect(single.def).toContain(" OR ");
  });
});
