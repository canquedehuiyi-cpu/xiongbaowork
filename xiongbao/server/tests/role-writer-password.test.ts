import { afterAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { roleWriterPasswordStatement } from "../scripts/role-writer-password";

/**
 * The statement the compose `migrate` service runs after the migrations (audit #633 M1), so the role
 * writer migration 0109 creates without a password can log in with the one the server is given.
 *
 * The real-database case runs the statement as the owner inside a transaction and rolls it back: the
 * role is the cluster's, shared by every test database on it, so its password is asserted and never
 * changed.
 */

describe("the role writer's password statement", () => {
  test("is the chart's own ALTER ROLE, with the password in its literal", () => {
    expect(roleWriterPasswordStatement("xiongbao")).toBe(
      "ALTER ROLE xiongbao_role_writer WITH LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS PASSWORD 'xiongbao'",
    );
  });

  test.each([
    undefined,
    "",
    "has-a-dash",
    "x' SUPERUSER --",
    "space in it",
    "ünïcode",
  ])("refuses %p, which could not go into a SQL literal safely", (password) => {
    expect(() => roleWriterPasswordStatement(password)).toThrow(
      "ROLE_WRITER_PASSWORD must be letters and digits only",
    );
  });
});

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL?.trim();
const owner = adminUrl
  ? postgres(adminUrl, { max: 1, onnotice: () => {} })
  : undefined;

afterAll(async () => {
  await owner?.end({ timeout: 5 });
});

describe("the statement against the real cluster", () => {
  test("sets a SCRAM password and leaves the role unprivileged, inside a rolled-back transaction", async () => {
    if (!owner)
      throw new Error(
        "TEST_DATABASE_ADMIN_URL must connect as the database owner, as CI sets it.",
      );
    const rolledBack = new Error("rolled back on purpose");
    let seen: Record<string, unknown> | undefined;
    const outcome = await owner
      .begin(async (transaction) => {
        await transaction.unsafe(
          roleWriterPasswordStatement("unitRolledBack0"),
        );
        const [row] = await transaction`
          select rolcanlogin as login, rolsuper as super, rolbypassrls as bypass,
                 rolinherit as inherit, rolpassword like 'SCRAM-SHA-256$%' as scram
          from pg_authid where rolname = 'xiongbao_role_writer'`;
        seen = row;
        throw rolledBack;
      })
      .then(
        () => "committed",
        (error: unknown) => (error === rolledBack ? "rolled back" : error),
      );
    expect(outcome).toBe("rolled back");
    expect(seen).toEqual({
      login: true,
      super: false,
      bypass: false,
      inherit: false,
      scram: true,
    });
  });
});
