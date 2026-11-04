import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { testDatabaseUrl } from "./support/database";

/**
 * Migration 0131 (SEC1, docs/specs/2026-11-02-sec1-employee-tool-permissions.md §6.2) on the rows
 * written before it.
 *
 * 0131 widens the behaviour CHECK of `approval_rules` and `approval_team_rules` to accept `deny`,
 * adds the team's `enforce_dangerous_commands` switch, and creates `agent_security_settings`. The
 * rules people saved before it must read back exactly as they were, and the dormant
 * `agent_security_policies` (D3) must be left as it was.
 *
 * Read from the file rather than restated, and run inside a transaction that is rolled back, the
 * pattern of the 0129 test: the shared test database is already past 0131, so the transaction first
 * puts the three tables back the way 0131 found them, writes rules with every behaviour that existed
 * then, and runs every statement of the file verbatim. That needs the tables' owner
 * (`TEST_DATABASE_ADMIN_URL`, pointed at the same database), who also runs migrations.
 */
const MIGRATION = await Bun.file(
  new URL(
    "../recovery/recovery-20261018-v1/sql/0131_employee_tool_permissions.sql",
    import.meta.url,
  ),
).text();
const STATEMENTS = MIGRATION.split("--> statement-breakpoint")
  .map((statement) => statement.trim())
  .filter(Boolean);

const url = testDatabaseUrl();

function ownerConnection(): SQL {
  const raw = process.env.TEST_DATABASE_ADMIN_URL?.trim();
  if (!raw) {
    throw new Error(
      "TEST_DATABASE_ADMIN_URL must name the database owner: only the owner can put 0131's tables back.",
    );
  }
  const admin = new URL(raw);
  const target = new URL(url);
  if (admin.hostname !== target.hostname || admin.port !== target.port) {
    throw new Error(
      "TEST_DATABASE_ADMIN_URL must reach the same server as TEST_DATABASE_URL.",
    );
  }
  return new SQL({
    adapter: "postgres",
    hostname: admin.hostname,
    port: admin.port ? Number(admin.port) : 5432,
    username: decodeURIComponent(admin.username),
    password: decodeURIComponent(admin.password),
    database: decodeURIComponent(target.pathname.replace(/^\//, "")),
    max: 1,
  });
}

const owner = ownerConnection();
afterAll(async () => {
  await owner.close();
});

/** Thrown to unwind the transaction, so the migration never touches the shared database's rows. */
class Rollback extends Error {}

const run = randomUUID().slice(0, 8);
const person = `mig130-${run}-person`;
const OLD_BEHAVIOURS = ["allow", "pre_approved", "ask", "hand_off"] as const;

describe("migration 0131 on the rules written before it", () => {
  test("it only widens the two behaviour checks, then adds the switch and the new table", () => {
    const checks = STATEMENTS.filter((statement) =>
      /ADD CONSTRAINT "approval(_team)?_rules_behaviour_check"/.test(statement),
    );
    expect(checks).toHaveLength(2);
    for (const check of checks) {
      for (const behaviour of [...OLD_BEHAVIOURS, "deny"])
        expect(check).toContain(`'${behaviour}'`);
    }
    expect(MIGRATION).toContain(
      'ADD COLUMN "enforce_dangerous_commands" boolean DEFAULT false NOT NULL',
    );
    expect(MIGRATION).toContain('CREATE TABLE "public"."agent_security_settings"');
    // D3: the dormant table is not revived. Nothing here names it.
    expect(MIGRATION).not.toMatch(/ON\s+"?public"?\."?agent_security_policies/i);
  });

  test("old rules read back unchanged, deny is accepted, and anything else is still refused", async () => {
    let seen:
      | {
          rules: { behaviour: string }[];
          teamRules: { behaviour: string }[];
          denyAccepted: boolean;
          junkRefused: boolean;
          switchDefault: boolean | null;
          policies: number;
          forced: boolean;
          appGrants: number;
          dormantPolicies: number;
          dormantPoliciesAfter: number;
          dormantAppGrants: number;
          dormantAppGrantsAfter: number;
        }
      | undefined;
    try {
      await owner.begin(async (tx) => {
        const dormantBefore = await tx`
          select count(*)::int as n from pg_policies where tablename = 'agent_security_policies'
        `;
        const dormantGrantsBefore = await tx`
          select count(*)::int as n from information_schema.role_table_grants
           where table_name = 'agent_security_policies' and grantee = 'openbot_app'
        `;
        // The tables as 0131 found them.
        await tx.unsafe('DROP TABLE "public"."agent_security_settings"');
        await tx.unsafe(
          'ALTER TABLE "public"."approval_team_settings" DROP COLUMN "enforce_dangerous_commands"',
        );
        for (const table of ["approval_rules", "approval_team_rules"]) {
          await tx.unsafe(
            `ALTER TABLE "public"."${table}" DROP CONSTRAINT "${table}_behaviour_check"`,
          );
          await tx.unsafe(
            `ALTER TABLE "public"."${table}" ADD CONSTRAINT "${table}_behaviour_check" CHECK ("behaviour" IN ('allow', 'pre_approved', 'ask', 'hand_off'))`,
          );
        }
        await tx`insert into public.users (id, email) values (${person}, ${`${person}@example.test`})`;
        for (const behaviour of OLD_BEHAVIOURS) {
          await tx`
            insert into public.approval_rules (id, tenant_id, owner_user_id, bot_id, tool_ref, effect, scope, behaviour)
            values (${`${person}-${behaviour}`}, ${person}, ${person}, '*', ${`mcp/old/${behaviour}`}, '*', '*', ${behaviour})
          `;
          await tx`
            insert into public.approval_team_rules (id, tenant_id, bot_id, tool_ref, effect, scope, behaviour)
            values (${`${person}-team-${behaviour}`}, 'team', '*', ${`mcp/old/${behaviour}`}, '*', '*', ${behaviour})
          `;
        }

        for (const statement of STATEMENTS) await tx.unsafe(statement);

        const rules = await tx`
          select behaviour from public.approval_rules where owner_user_id = ${person} order by tool_ref
        `;
        const teamRules = await tx`
          select behaviour from public.approval_team_rules where id like ${`${person}-team-%`} order by tool_ref
        `;
        await tx`
          insert into public.approval_rules (id, tenant_id, owner_user_id, bot_id, tool_ref, effect, scope, behaviour)
          values (${`${person}-deny`}, ${person}, ${person}, '*', 'mcp/new/deny', '*', '*', 'deny')
        `;
        await tx`
          insert into public.approval_team_rules (id, tenant_id, bot_id, tool_ref, effect, scope, behaviour)
          values (${`${person}-team-deny`}, 'team', '*', 'mcp/new/deny', '*', '*', 'deny')
        `;
        const denied = await tx`
          select count(*)::int as n from public.approval_rules where id = ${`${person}-deny`}
        `;
        let junkRefused = false;
        await tx.unsafe("SAVEPOINT junk");
        try {
          await tx`
            insert into public.approval_rules (id, tenant_id, owner_user_id, bot_id, tool_ref, effect, scope, behaviour)
            values (${`${person}-junk`}, ${person}, ${person}, '*', 'mcp/new/junk', '*', '*', 'whatever')
          `;
        } catch {
          junkRefused = true;
        }
        await tx.unsafe("ROLLBACK TO SAVEPOINT junk");
        const [column] = await tx`
          select column_default is not null and is_nullable = 'NO' as present,
                 (column_default = 'false') as default_false
            from information_schema.columns
           where table_name = 'approval_team_settings' and column_name = 'enforce_dangerous_commands'
        `;
        const [policies] = await tx`
          select count(*)::int as n from pg_policies where tablename = 'agent_security_settings'
        `;
        const [forced] = await tx`
          select relrowsecurity and relforcerowsecurity as forced from pg_class
           where oid = 'public.agent_security_settings'::regclass
        `;
        const [grants] = await tx`
          select count(*)::int as n from information_schema.role_table_grants
           where table_name = 'agent_security_settings' and grantee = 'openbot_app'
        `;
        const [dormantAfter] = await tx`
          select count(*)::int as n from pg_policies where tablename = 'agent_security_policies'
        `;
        const [dormantGrants] = await tx`
          select count(*)::int as n from information_schema.role_table_grants
           where table_name = 'agent_security_policies' and grantee = 'openbot_app'
        `;
        seen = {
          rules: rules as { behaviour: string }[],
          teamRules: teamRules as { behaviour: string }[],
          denyAccepted: denied[0].n === 1,
          junkRefused,
          switchDefault: column?.default_false ?? null,
          policies: policies.n,
          forced: forced.forced,
          appGrants: grants.n,
          dormantPolicies: dormantBefore[0].n,
          dormantPoliciesAfter: dormantAfter.n,
          dormantAppGrants: dormantGrantsBefore[0].n,
          dormantAppGrantsAfter: dormantGrants.n,
        };
        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }

    expect(seen?.rules.map((row) => row.behaviour).sort()).toEqual(
      [...OLD_BEHAVIOURS].sort(),
    );
    expect(seen?.teamRules.map((row) => row.behaviour).sort()).toEqual(
      [...OLD_BEHAVIOURS].sort(),
    );
    expect(seen?.denyAccepted).toBeTrue();
    expect(seen?.junkRefused).toBeTrue();
    expect(seen?.switchDefault).toBeTrue();
    // The owner policies and their `_team_bot_` copies, one per command each.
    expect(seen?.policies).toBe(8);
    expect(seen?.forced).toBeTrue();
    expect(seen?.appGrants).toBe(4);
    // The dormant table is untouched: the same policies and the same privileges as before.
    expect(seen?.dormantPolicies).toBe(8);
    expect(seen?.dormantPoliciesAfter).toBe(seen?.dormantPolicies);
    expect(seen?.dormantAppGrantsAfter).toBe(seen?.dormantAppGrants);

    // Rolled back: the shared database has none of these rows.
    const [still] = await owner`
      select count(*)::int as n from public.users where id = ${person}
    `;
    expect(still.n).toBe(0);
  });
});
