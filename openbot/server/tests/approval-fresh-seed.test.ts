import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import {
  approvalFreshSeeds,
  approvalRequests,
} from "../src/db/schema/approvals";

// Source metadata / SQL contract only. These are not PG, privilege, concurrency,
// persisted-CAS, producer, or production-release acceptance tests.
const seedColumns = [
  "approval_id", "tenant_id", "owner_user_id", "run_id", "tool_call_id",
  "action_digest", "template_digest", "producer_proof_id", "prepared_at",
];
const childIdentity = [
  "approval_id", "tenant_id", "owner_user_id", "run_id", "tool_call_id", "action_digest",
];
const parentIdentity = [
  "id", "tenant_id", "owner_user_id", "run_id", "tool_call_id", "action_digest",
];
const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");
const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
const withoutComments = (value: string) => value.replace(/--[^\n]*/g, "");
const sql = read("../drizzle/0081_approval_fresh_seeds.sql");
const seedTable = '"public"."approval_fresh_seeds"';
const requestTable = '"public"."approval_requests"';
const quote = (name: string) => `"${name}"`;
const columns = (names: readonly string[]) => names.map(quote).join(", ");

// Independent closed-foundation allowlist: consume every complete statement,
// including both revokes. Extra commands cannot hide behind a substring check.
function assertClosedSQL(value: string) {
  const actual = value.split("--> statement-breakpoint")
    .map(withoutComments).map(normalize);
  const expected = [
    `ALTER TABLE ${requestTable} ADD CONSTRAINT "approval_requests_id_tenant_owner_unique" UNIQUE ("id", "tenant_id", "owner_user_id");`,
    `ALTER TABLE ${requestTable} ADD CONSTRAINT "approval_requests_fresh_seed_identity_uq" UNIQUE (${columns(parentIdentity)});`,
    `ALTER TABLE ${requestTable} ADD COLUMN "result_disposition" text;`,
    `ALTER TABLE ${requestTable} ADD CONSTRAINT "approval_result_disposition_check" CHECK ("result_disposition" IN ('continue', 'final'));`,
    `ALTER TABLE ${requestTable} ADD CONSTRAINT "approval_result_disposition_result_pair_check" CHECK ("result_disposition" IS NULL OR "result" IS NOT NULL);`,
    `CREATE TABLE ${seedTable} (
      "approval_id" text NOT NULL,
      "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
      "owner_user_id" text NOT NULL,
      "run_id" text NOT NULL,
      "tool_call_id" text NOT NULL,
      "action_digest" text NOT NULL,
      "template_digest" text NOT NULL,
      "producer_proof_id" text NOT NULL,
      "prepared_at" timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT "approval_fresh_seeds_pkey" PRIMARY KEY ("approval_id"),
      CONSTRAINT "approval_fresh_seeds_parent_fk" FOREIGN KEY (${columns(childIdentity)}) REFERENCES ${requestTable} (${columns(parentIdentity)}) ON DELETE NO ACTION ON UPDATE NO ACTION,
      CONSTRAINT "approval_fresh_seeds_template_sha_check" CHECK ("template_digest" ~ '^[a-f0-9]{64}$'),
      CONSTRAINT "approval_fresh_seeds_nonblank_check" CHECK (length(btrim("approval_id")) > 0 AND length(btrim("tenant_id")) > 0 AND length(btrim("owner_user_id")) > 0 AND length(btrim("run_id")) > 0 AND length(btrim("tool_call_id")) > 0 AND length(btrim("action_digest")) > 0 AND length(btrim("producer_proof_id")) > 0)
    );`,
    `ALTER TABLE ${seedTable} ENABLE ROW LEVEL SECURITY;`,
    `ALTER TABLE ${seedTable} FORCE ROW LEVEL SECURITY;`,
    `REVOKE ALL ON TABLE ${seedTable} FROM "openbot_app";`,
    `REVOKE ALL ON TABLE ${seedTable} FROM PUBLIC;`,
  ].map(normalize);
  expect(actual).toEqual(expected);
}

describe("fresh seed closed schema proposal, no owner writer wired", () => {
  test("complete SQL contract contains no policies, grants, functions or owner GUC", () => {
    assertClosedSQL(sql);
    const executable = withoutComments(sql);
    expect(executable).not.toMatch(/\b(?:CREATE\s+POLICY|GRANT|CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION)\b/i);
    expect(executable.match(/current_setting\([^)]*\)/g)).toEqual([
      "current_setting('app.tenant_id', true)",
    ]);
  });

  for (const [name, mutate] of [
    ["missing FORCE", (value: string) =>
      value.replace("FORCE ROW LEVEL SECURITY", "ENABLE ROW LEVEL SECURITY")],
    ["missing application revoke", (value: string) =>
      value.replace(`REVOKE ALL ON TABLE ${seedTable} FROM "openbot_app";`, "")],
    ["extra SELECT grant", (value: string) =>
      value + "\nGRANT SELECT ON approval_fresh_seeds TO openbot_app;"],
    ["extra policy", (value: string) =>
      value + "\nCREATE POLICY unsafe ON approval_fresh_seeds USING (true);"],
    ["partial parent binding", (value: string) =>
      value.replace('FOREIGN KEY ("approval_id", "tenant_id", "owner_user_id", "run_id", "tool_call_id", "action_digest")', 'FOREIGN KEY ("approval_id")')],
    ["reverse result check", (value: string) =>
      value.replace('"result_disposition" IS NULL OR "result" IS NOT NULL',
        '"result" IS NULL OR "result_disposition" IS NOT NULL')],
  ] as const) {
    test(`closed SQL rejects ${name}`, () =>
      expect(() => assertClosedSQL(mutate(sql))).toThrow());
  }

  test("actual seed metadata is RLS-on with zero policies and immutable six-field parent binding", () => {
    const config = getTableConfig(approvalFreshSeeds);
    expect(config.name).toBe("approval_fresh_seeds");
    expect(config.enableRLS).toBe(true);
    expect(config.policies).toHaveLength(0);
    expect(config.columns.map((column) => column.name)).toEqual(seedColumns);
    expect(config.columns.every((column) => column.notNull)).toBe(true);
    expect(config.primaryKeys.map((key) => ({
      name: key.getName(),
      columns: key.columns.map((column) => column.name),
    }))).toEqual([{
      name: "approval_fresh_seeds_pkey", columns: ["approval_id"],
    }]);
    expect(config.foreignKeys.map((key) => ({
      name: key.getName(),
      columns: key.reference().columns.map((column) => column.name),
      parent: key.reference().foreignColumns.map((column) => column.name),
      onDelete: key.onDelete, onUpdate: key.onUpdate,
    }))).toEqual([{
      name: "approval_fresh_seeds_parent_fk", columns: childIdentity,
      parent: parentIdentity, onDelete: "no action", onUpdate: "no action",
    }]);
    expect(config.columns.filter((column) => column.hasDefault).map((column) =>
      column.name)).toEqual(["tenant_id", "prepared_at"]);
  });

  test("parent keeps old identity key and adds the full seed identity key", () => {
    const keys = getTableConfig(approvalRequests).uniqueConstraints.map((key) => ({
      name: key.getName(), columns: key.columns.map((column) => column.name),
    }));
    expect(keys).toContainEqual({
      name: "approval_requests_id_tenant_owner_unique",
      columns: ["id", "tenant_id", "owner_user_id"],
    });
    expect(keys).toContainEqual({
      name: "approval_requests_fresh_seed_identity_uq", columns: parentIdentity,
    });
  });

  test("result disposition is nullable and only implies result presence", () => {
    const config = getTableConfig(approvalRequests);
    const disposition = config.columns.find((column) =>
      column.name === "result_disposition");
    expect(disposition?.notNull).toBe(false);
    expect(disposition?.hasDefault).toBe(false);
    const check = config.checks.find((item) =>
      item.name === "approval_result_disposition_result_pair_check");
    expect(check).toBeDefined();
    if (!check) throw new Error("missing disposition pair check");
    const rendered = new PgDialect().sqlToQuery(check.value).sql;
    expect(normalize(rendered)).toBe(
      '"approval_requests"."result_disposition" IS NULL OR "approval_requests"."result" IS NOT NULL',
    );
    // The existing withdrawal path may persist a result without a disposition.
    // This checks the definition, not PostgreSQL's evaluation or jsonb behavior.
  });

  test("template and source guards remain explicit and real role defaults are revoked", () => {
    const config = getTableConfig(approvalFreshSeeds);
    const dialect = new PgDialect();
    const checks = config.checks.map((item) => ({
      name: item.name, sql: dialect.sqlToQuery(item.value).sql,
    }));
    expect(checks).toHaveLength(2);
    expect(checks.find((item) =>
      item.name === "approval_fresh_seeds_template_sha_check")?.sql)
      .toContain("~ '^[a-f0-9]{64}$'");
    expect(checks.find((item) =>
      item.name === "approval_fresh_seeds_nonblank_check")?.sql)
      .toContain('"producer_proof_id"');
    const prior = read("../drizzle/0054_app_role.sql");
    expect(prior).toContain("TO openbot_app");
    expect(prior).toContain("ALTER DEFAULT PRIVILEGES");
    expect(sql).toContain(`REVOKE ALL ON TABLE ${seedTable} FROM "openbot_app";`);
  });
});
