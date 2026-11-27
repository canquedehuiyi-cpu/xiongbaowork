import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import {
  judgeRlsEnforcement,
  ROLE_FACTS_SQL,
  readRoleFacts,
} from "../src/db/rls-role";
import { asPlatform, runAsTenant } from "../src/tenant/context";
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
      role: "xiongbao_app",
      super: false,
      bypassesRls: false,
    }),
  ).toEqual({ enforced: true });
});

test("a superuser is not, and says so with the fix", () => {
  const verdict = judgeRlsEnforcement({
    role: "xiongbao",
    super: true,
    bypassesRls: false,
  });
  expect(verdict.enforced).toBeFalse();
  if (verdict.enforced) return;
  expect(verdict.reason).toContain("xiongbao is a superuser");
  expect(verdict.fix).toContain("xiongbao_app");
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
  expect(facts.role).toBe("xiongbao_app");
  expect(judgeRlsEnforcement(facts)).toEqual({ enforced: true });
  await database.$client.close();
});

/**
 * Audit defect #8: migration 0054 of the history granted the application role CREATE on `public` (and
 * ALL on `drizzle`), so the role meant to hold row rights and nothing else could add tables, functions
 * and triggers to the schema it writes through; 0112 took the schema-level CREATE back. The server
 * creates nothing at runtime; migrations run as the owner, and the baseline grants the role USAGE only.
 */

test("the application role cannot create objects in the schemas it writes through", async () => {
  const database = createDatabase(testDatabaseUrl(), TEST_POOL);
  // Schema privileges and DDL belong to no tenant: probed in the platform frame, which still connects
  // as xiongbao_app, so the probe tests the application role's own rights.
  const [row] = (await asPlatform(() =>
    database.execute(
      sql.raw(`
      select
        has_schema_privilege('xiongbao_app', 'public', 'CREATE') as creates_public,
        has_schema_privilege('xiongbao_app', 'drizzle', 'CREATE') as creates_drizzle,
        has_schema_privilege('xiongbao_app', 'public', 'USAGE') as uses_public,
        has_schema_privilege('xiongbao_app', 'drizzle', 'USAGE') as uses_drizzle
    `),
    ),
  )) as unknown as Record<string, unknown>[];
  expect(row).toEqual({
    creates_public: false,
    creates_drizzle: false,
    uses_public: true,
    uses_drizzle: true,
  });

  // And the catalog answer is the behaviour: the suite connects as xiongbao_app (asserted above).
  const name = `app_role_create_probe_${Date.now()}`;
  const failure: unknown = await asPlatform(() =>
    database.execute(sql.raw(`create table public.${name} (id int)`)),
  ).then(
    () => undefined,
    (error: unknown) => error,
  );
  // Drizzle wraps the driver error as "Failed query: ..." with PostgreSQL's own error as the cause.
  const cause =
    failure instanceof Error && failure.cause !== undefined
      ? failure.cause
      : failure;
  expect(String(cause)).toMatch(/permission denied/i);
  await database.$client.close();
});
