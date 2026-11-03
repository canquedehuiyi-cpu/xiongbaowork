import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  automations,
  automationTriggers,
} from "../src/db/schema/automation-foundations";
import { automationFirings } from "../src/db/schema/automation-run-records";

/**
 * D06 AUT1/AUT3/AUT4: overlay 0117 fences the automation tables before the store writes them.
 *
 * Read statically, without a database, so the shape is checked on every machine: each table forced
 * under row security, answering all four commands with its own policy (never one `FOR ALL`), every
 * clause scoped to the row's own tenant or the platform writer, and no clause that lets anybody read
 * or write a 'system' row. `rls-write-scope.test.ts` asks the same of the live catalog.
 */
const server = join(import.meta.dir, "..");
const overlay = join(server, "recovery/recovery-20261018-v1");
const migration = readFileSync(
  join(overlay, "sql/0117_automation_tenant_policies.sql"),
  "utf8",
);
const journal = JSON.parse(
  readFileSync(join(overlay, "meta/_journal.json"), "utf8"),
) as { entries: { idx: number; when: number; tag: string }[] };

const TABLES = ["automations", "automation_triggers", "automation_firings"];
const SCOPE =
  "\"tenant_id\" NOT IN ('system', 'platform') AND (\"tenant_id\" = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform')";

/**
 * What a child row's INSERT and UPDATE check adds to SCOPE: its parent, read under the writer's own
 * policies, exists with the same tenant. A foreign key alone is checked without row security.
 */
const PARENT: Record<string, string | undefined> = {
  automation_triggers:
    ' AND EXISTS (SELECT 1 FROM "public"."automations" a WHERE a."id" = "automation_triggers"."automation_id" AND a."tenant_id" = "automation_triggers"."tenant_id")',
  automation_firings:
    ' AND EXISTS (SELECT 1 FROM "public"."automation_triggers" t WHERE t."id" = "automation_firings"."trigger_id" AND t."automation_id" = "automation_firings"."automation_id" AND t."tenant_id" = "automation_firings"."tenant_id")',
};

/** Statements without their comments, one string each, whitespace collapsed. */
const statements = migration
  .split("--> statement-breakpoint")
  .map((part) =>
    part
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*--.*$/gm, "")
      .replace(/\s+/g, " ")
      .trim(),
  )
  .filter((part) => part.length > 0);

type Policy = {
  name: string;
  table: string;
  command: string;
  using: string | null;
  check: string | null;
};

/** Takes the clause in the parentheses that open at `start`, balancing nested ones. */
function balanced(text: string, start: number): string {
  let depth = 0;
  for (let index = start; index < text.length; index++) {
    if (text[index] === "(") depth++;
    else if (text[index] === ")" && --depth === 0) {
      return text.slice(start + 1, index);
    }
  }
  throw new Error(`unbalanced clause in: ${text}`);
}

const policies: Policy[] = statements
  .filter((statement) => statement.startsWith("CREATE POLICY"))
  .map((statement) => {
    const head =
      /^CREATE POLICY "([a-z_]+)" ON "public"\."([a-z_]+)" AS PERMISSIVE FOR (SELECT|INSERT|UPDATE|DELETE|ALL) TO public /.exec(
        statement,
      );
    if (!head) throw new Error(`unreadable policy: ${statement}`);
    const usingAt = statement.indexOf(" USING (");
    const checkAt = statement.indexOf(" WITH CHECK (");
    return {
      name: head[1] ?? "",
      table: head[2] ?? "",
      command: head[3] ?? "",
      using: usingAt < 0 ? null : balanced(statement, usingAt + 7),
      check: checkAt < 0 ? null : balanced(statement, checkAt + 12),
    };
  });

/** The rls-write-scope reading: an explicit exclusion of 'system' is not a way to reach it. */
function reachesSystem(clause: string | null): boolean {
  if (!clause) return false;
  return clause
    .replace(/NOT IN \('system', 'platform'\)/g, "NOT IN (excluded)")
    .includes("'system'");
}

describe("0117 automation tenant policies", () => {
  test("every automation table is enabled and forced under row security", () => {
    for (const table of TABLES) {
      expect(statements).toContain(
        `ALTER TABLE "public"."${table}" ENABLE ROW LEVEL SECURITY;`,
      );
      expect(statements).toContain(
        `ALTER TABLE "public"."${table}" FORCE ROW LEVEL SECURITY;`,
      );
    }
  });

  test("each table answers all four commands with one policy each, and none is FOR ALL", () => {
    expect(policies).toHaveLength(12);
    for (const table of TABLES) {
      const own = policies.filter((policy) => policy.table === table);
      expect(own.map((policy) => policy.command).sort()).toEqual([
        "DELETE",
        "INSERT",
        "SELECT",
        "UPDATE",
      ]);
    }
    expect(policies.some((policy) => policy.command === "ALL")).toBe(false);
  });

  test("every clause is the tenant's own rows or the platform writer, and nothing else", () => {
    for (const policy of policies) {
      const written = `${SCOPE}${PARENT[policy.table] ?? ""}`;
      if (policy.command === "INSERT") {
        expect(policy.using).toBeNull();
        expect(policy.check).toBe(written);
      } else if (policy.command === "UPDATE") {
        expect(policy.using).toBe(SCOPE);
        expect(policy.check).toBe(written);
      } else {
        expect(policy.using).toBe(SCOPE);
        expect(policy.check).toBeNull();
      }
    }
    expect(SCOPE).toContain(
      "current_setting('app.tenant_id', true) = 'platform'",
    );
  });

  test("no policy, read or write, reaches a 'system' row", () => {
    const reaching = policies
      .filter(
        (policy) => reachesSystem(policy.using) || reachesSystem(policy.check),
      )
      .map((policy) => `${policy.table} ${policy.command}`);
    expect(reaching).toEqual([]);
    // The checker itself sees a 'system' branch when there is one.
    expect(reachesSystem("tenant_id = 'system' OR tenant_id = x")).toBe(true);
  });

  test("the run cap and run count are checked by the database (AUT4)", () => {
    expect(statements).toContain(
      'ALTER TABLE "public"."automations" ADD CONSTRAINT "automations_max_runs_check" CHECK ("max_runs" IS NULL OR "max_runs" > 0);',
    );
    expect(statements).toContain(
      'ALTER TABLE "public"."automations" ADD CONSTRAINT "automations_run_count_check" CHECK ("run_count" >= 0 AND ("max_runs" IS NULL OR "run_count" <= "max_runs"));',
    );
  });

  test("the due, cap and breaker indexes exist, and openbot_app keeps its four rights", () => {
    expect(statements).toContain(
      'CREATE INDEX "automation_triggers_enabled_due_idx" ON "public"."automation_triggers" USING btree ("next_run_at") WHERE "enabled" AND "next_run_at" IS NOT NULL;',
    );
    expect(statements).toContain(
      'CREATE INDEX "automation_triggers_automation_idx" ON "public"."automation_triggers" USING btree ("tenant_id", "automation_id");',
    );
    expect(statements).toContain(
      'CREATE INDEX "automation_firings_breaker_idx" ON "public"."automation_firings" USING btree ("tenant_id", "automation_id", "created_at" DESC);',
    );
    expect(statements).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."automations", "public"."automation_triggers", "public"."automation_firings" TO openbot_app;',
    );
    // Nothing else is granted, created or dropped here.
    expect(
      statements.filter(
        (statement) =>
          !/^(ALTER TABLE|CREATE POLICY|CREATE INDEX|GRANT SELECT)/.test(
            statement,
          ),
      ),
    ).toEqual([]);
    expect(statements.join("\n")).not.toMatch(
      /\bDROP\b|\bBYPASSRLS\b|\bTO\s+openbot\b/i,
    );
  });

  test("the journal applies 0117 after 0116, with a strictly increasing 'when'", () => {
    const entry = journal.entries.find((item) => item.idx === 117);
    expect(entry).toMatchObject({
      idx: 117,
      when: 1793625600000,
      tag: "0117_automation_tenant_policies",
    });
    const tags = journal.entries.map((item) => item.tag);
    expect(tags.indexOf("0117_automation_tenant_policies")).toBeGreaterThan(
      tags.indexOf("0116_task_archives"),
    );
    expect(tags.indexOf("0116_task_archives")).toBeGreaterThanOrEqual(0);
    for (let index = 1; index < journal.entries.length; index++) {
      const previous = journal.entries[index - 1];
      const current = journal.entries[index];
      expect(current && previous && current.when > previous.when).toBe(true);
    }
    for (const item of journal.entries) {
      const name = `${item.tag}.sql`;
      expect(
        existsSync(join(server, "drizzle", name)) ||
          existsSync(join(overlay, "sql", name)),
      ).toBe(true);
    }
  });

  test("the frozen Drizzle models still declare no policy: the fence lives in the overlay", () => {
    for (const model of [automations, automationTriggers, automationFirings]) {
      const config = getTableConfig(model);
      expect(config.enableRLS).toBe(false);
      expect(config.policies).toHaveLength(0);
    }
  });
});
