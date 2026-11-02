import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import {
  judgeRlsEnforcement,
  ROLE_FACTS_SQL,
  readRoleFacts,
} from "../src/db/rls-role";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Ticket 026, spec D15: the database layer of tenant isolation either binds the role the server
 * actually connects as, or it does nothing at all — quietly.
 *
 * The verdict is decided here without a database because the whole point is a truth table that must
 * not be able to drift: `FORCE ROW LEVEL SECURITY` binds a table's owner and binds nothing else, so a
 * superuser or a `BYPASSRLS` role is outside the policy no matter how the migrations are written.
 * The query below is then checked against a real connection, so the shape the code reads is the
 * shape the server sends rather than a guess about it.
 */

test("an ordinary role is governed by the policy", () => {
  expect(
    judgeRlsEnforcement({
      role: "openbot_app",
      super: false,
      bypassesRls: false,
    }),
  ).toEqual({ enforced: true });
});

test("a superuser is not, and says so with the fix", () => {
  const verdict = judgeRlsEnforcement({
    role: "openbot",
    super: true,
    bypassesRls: false,
  });
  expect(verdict.enforced).toBeFalse();
  if (verdict.enforced) return;
  expect(verdict.reason).toContain("openbot is a superuser");
  expect(verdict.fix).toContain("openbot_app");
});

test("BYPASSRLS is named as itself, not as superuser", () => {
  const verdict = judgeRlsEnforcement({
    role: "reporting",
    super: false,
    bypassesRls: true,
  });
  if (verdict.enforced) throw new Error("expected unenforced");
  // Two different repairs: one is a wrong connection string, the other a privilege somebody granted.
  // Reporting only "superuser" would send the second person hunting for the wrong cause.
  expect(verdict.reason).toContain("reporting holds BYPASSRLS");
  expect(verdict.reason).not.toContain("superuser");
});

test("both at once names both", () => {
  const verdict = judgeRlsEnforcement({
    role: "postgres",
    super: true,
    bypassesRls: true,
  });
  if (verdict.enforced) throw new Error("expected unenforced");
  expect(verdict.reason).toContain(
    "is a superuser and postgres holds BYPASSRLS",
  );
});

test("the catalog query answers in the shape the reader expects", async () => {
  const database = createDatabase(testDatabaseUrl(), TEST_POOL);
  // The role catalogue belongs to no tenant: read in the system frame.
  const rows = await runAsTenant("system", () =>
    database.execute(sql.raw(ROLE_FACTS_SQL)),
  );
  const facts = readRoleFacts(rows as unknown[]);

  // The test database is reached as the application role, so this is also the assertion that the
  // suite is testing the layer it claims to test. If it ever starts failing, the isolation tests
  // above it have been passing against an unenforced connection — which is the exact accident this
  // ticket exists to prevent, arriving as a red line instead of as a quiet green.
  expect(facts.role).toBe("openbot_app");
  expect(judgeRlsEnforcement(facts)).toEqual({ enforced: true });
});

/**
 * Audit defect #8: `0054_app_role.sql` granted `openbot_app` CREATE on `public` (and ALL on
 * `drizzle`), so the role meant to hold row rights and nothing else could add tables, functions and
 * triggers to the schema it writes through. The server creates nothing at runtime; migrations run as
 * the owner. `0112_app_role_hardening.sql` takes the schema-level CREATE back.
 */
const overlay = join(import.meta.dir, "..", "recovery", "recovery-20261018-v1");

test("the overlay migration revokes schema CREATE from the application role", () => {
  const migration = readFileSync(
    join(overlay, "sql", "0112_app_role_hardening.sql"),
    "utf8",
  );
  const statements = migration
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("--> statement-breakpoint")
    .map((statement) => statement.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  expect(statements).toEqual([
    "REVOKE CREATE ON SCHEMA public FROM openbot_app;",
    "REVOKE CREATE ON SCHEMA drizzle FROM openbot_app;",
  ]);
  // Nothing in it may touch the password: an external deployment still on 0054's default would be
  // locked out at its next restart, with nothing in the migration log to say why.
  expect(statements.join(" ")).not.toMatch(/PASSWORD|ALTER ROLE/i);

  const journal = JSON.parse(
    readFileSync(join(overlay, "meta", "_journal.json"), "utf8"),
  ) as { entries: { idx: number; when: number; tag: string }[] };
  const entry = journal.entries.find(
    (candidate) => candidate.tag === "0112_app_role_hardening",
  );
  expect(entry?.idx).toBe(112);
  const previous = journal.entries[journal.entries.indexOf(entry as never) - 1];
  expect(entry && previous && entry.when > previous.when).toBeTrue();
});

test("the application role cannot create objects in the schemas it writes through", async () => {
  const database = createDatabase(testDatabaseUrl(), TEST_POOL);
  const [row] = (await database.execute(
    sql.raw(`
      select
        has_schema_privilege('openbot_app', 'public', 'CREATE') as creates_public,
        has_schema_privilege('openbot_app', 'drizzle', 'CREATE') as creates_drizzle,
        has_schema_privilege('openbot_app', 'public', 'USAGE') as uses_public,
        has_schema_privilege('openbot_app', 'drizzle', 'USAGE') as uses_drizzle
    `),
  )) as unknown as Record<string, unknown>[];
  expect(row).toEqual({
    creates_public: false,
    creates_drizzle: false,
    uses_public: true,
    uses_drizzle: true,
  });

  // And the catalog answer is the behaviour: the suite connects as openbot_app (asserted above).
  const name = `app_role_create_probe_${Date.now()}`;
  const failure: unknown = await database
    .execute(sql.raw(`create table public.${name} (id int)`))
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  // Drizzle wraps the driver error as "Failed query: ..." with PostgreSQL's own error as the cause.
  const cause =
    failure instanceof Error && failure.cause !== undefined
      ? failure.cause
      : failure;
  expect(String(cause)).toMatch(/permission denied/i);
});
