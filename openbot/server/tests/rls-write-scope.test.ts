import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { agents, wakerGroupMembers, wakerGroups } from "../src/db/schema";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Ticket 026, spec D15: reading the platform's rows is a courtesy, becoming them is not.
 *
 * Migrations 0053 through 0070 gave every tenant table ONE policy for ALL commands, which forced the
 * read view and the write view to be the same expression. So `tenant_id = 'system'` — the branch that
 * makes a vendor catalogue visible to everybody — also let any tenant insert or rewrite rows stamped
 * `system`, rows every other workspace reads, as long as it could name one. 0071 dropped that branch
 * from WITH CHECK. It did not drop it from USING, and USING is the only half a DELETE is gated by: a
 * tenant could still delete the platform's rows, quietly and with no error to show for it. 0072 splits
 * the commands, so this file can say what a workspace may do with a row it does not own.
 *
 * Three things about the shape of these tests, all earned:
 *  - Every statement is awaited inside its scope. Drizzle answers with a lazy builder, so a scope that
 *    returns one without awaiting hands back an object, and `rejects` on an object asserts nothing at
 *    all.
 *  - A refused write is asserted against the ROW, not against the error. Row security does not answer
 *    "you may not touch that"; it answers "there is no such row here", so a tenant's UPDATE or DELETE
 *    of a platform row succeeds having changed nothing. INSERT is the exception — WITH CHECK is asked
 *    of the row being written whether or not it was ever visible — and that one keeps its `rejects`.
 *  - The legitimate `system` writer is expected to keep working. `tenant/context.ts` resolves an absent
 *    scope to `system` and the client stamps that onto the session, so `tenant_id = current_setting(…)`
 *    still holds for boot-time and unscoped seeding, and the cross-tenant writers that name
 *    `platform` still reach everything.
 */
/**
 * What the catalog says each tenant table answers, command by command.
 *
 * Read from `pg_policies` rather than from the migrations, because the question is what the database
 * the server is about to write to actually enforces. `deployment_packages` is exempt by 0062, and
 * `waker_group_members` is named separately because it carries no `tenant_id` of its own — the exact
 * shape of table that a `WHERE column_name = 'tenant_id'` loop skips, and skipped on the way in here.
 */
const POLICY_CATALOG_SQL = `
  select p.tablename as "table", p.cmd as "command", p.qual as "using", p.with_check as "check"
  from pg_policies p
  join (
    select table_name from information_schema.columns
      where column_name = 'tenant_id' and table_schema = 'public'
        and table_name <> 'deployment_packages'
    union select 'waker_group_members'
  ) scoped on scoped.table_name = p.tablename
  order by p.tablename, p.cmd
`;

type PolicyRow = {
  table: string;
  command: string;
  using: string | null;
  check: string | null;
};

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const tenantA = `w-${suite}-a`;
const tenantB = `w-${suite}-b`;
const systemAgent = `w-${suite}-vendor-bot`;
const ownAgent = `w-${suite}-own-bot`;
const systemCrewName = `${suite} platform crew`;
const ownCrewName = `${suite} own crew`;
const memberAgent = `w-${suite}-member`;

/** A crew id, so the member rows can be reached without knowing what the database generated. */
let systemCrew = "";
let ownCrew = "";

function seed(tenant: string, id: string) {
  return async () => {
    await database.insert(agents).values({
      id,
      tenantId: tenant,
      name: `${id} seed`,
      type: "built_in",
      configuration: {},
    });
  };
}

function rename(id: string, to: string) {
  return async () => {
    await database.update(agents).set({ name: to }).where(eq(agents.id, id));
  };
}

function remove(id: string) {
  return async () => {
    await database.delete(agents).where(eq(agents.id, id));
  };
}

async function nameAs(scope: string, id: string): Promise<string | undefined> {
  const [row] = await runAsTenant(scope, () =>
    database
      .select({ name: agents.name })
      .from(agents)
      .where(eq(agents.id, id)),
  );
  return row?.name;
}

async function memberCount(scope: string, groupId: string): Promise<number> {
  const rows = await runAsTenant(scope, () =>
    database
      .select({ agentId: wakerGroupMembers.agentId })
      .from(wakerGroupMembers)
      .where(eq(wakerGroupMembers.groupId, groupId)),
  );
  return rows.length;
}

test("the platform's own writer still works, and its rows stay readable everywhere", async () => {
  await runAsTenant("system", seed("system", systemAgent));
  expect(await nameAs("system", systemAgent)).toBe(`${systemAgent} seed`);
  expect(await nameAs(tenantA, systemAgent)).toBe(`${systemAgent} seed`);
});

test("a tenant may read a platform row and may neither rewrite nor delete it", async () => {
  await runAsTenant(tenantA, rename(systemAgent, "renamed by a stranger"));
  await runAsTenant(tenantA, remove(systemAgent));

  // Refused, which here means untouched: see the header on why nothing above raised.
  expect(await nameAs("system", systemAgent)).toBe(`${systemAgent} seed`);
});

test("a tenant may not create a platform row, and still owns its own rows", async () => {
  await expect(
    runAsTenant(tenantB, seed("system", ownAgent)),
  ).rejects.toThrow();

  await runAsTenant(tenantB, seed(tenantB, ownAgent));
  await runAsTenant(tenantB, rename(ownAgent, "renamed by its owner"));
  expect(await nameAs(tenantB, ownAgent)).toBe("renamed by its owner");
  // The other side of the same policy: a tenant's row is invisible to the platform's own scope,
  // which only reaches what its setting names.
  expect(await nameAs("system", ownAgent)).toBeUndefined();
});

test("a seat in the platform's crew is readable by everyone and editable by nobody else", async () => {
  const [crew] = await runAsTenant("system", async () => {
    const created = await database
      .insert(wakerGroups)
      .values({ name: systemCrewName, tenantId: "system" })
      .returning({ id: wakerGroups.id });
    await database
      .insert(wakerGroupMembers)
      .values({ groupId: created[0]!.id, agentId: memberAgent });
    return created;
  });
  systemCrew = crew!.id;

  // Readable: the catalogue of crews the platform ships is there to be joined.
  expect(await memberCount(tenantA, systemCrew)).toBe(1);

  // Not editable, in either direction, and not deletable. All three change nothing rather than raise.
  await runAsTenant(tenantA, async () => {
    await database
      .delete(wakerGroupMembers)
      .where(
        and(
          eq(wakerGroupMembers.groupId, systemCrew),
          eq(wakerGroupMembers.agentId, memberAgent),
        ),
      );
  });
  await expect(
    runAsTenant(tenantA, async () => {
      await database.insert(wakerGroupMembers).values({
        groupId: systemCrew,
        agentId: `${suite}-freelancer`,
      });
    }),
  ).rejects.toThrow();
  expect(await memberCount("system", systemCrew)).toBe(1);

  // A tenant's own crew is writable by that tenant, which is the half that must not be lost.
  const [own] = await runAsTenant(tenantB, async () => {
    const created = await database
      .insert(wakerGroups)
      .values({ name: ownCrewName })
      .returning({ id: wakerGroups.id });
    await database
      .insert(wakerGroupMembers)
      .values({ groupId: created[0]!.id, agentId: memberAgent });
    return created;
  });
  ownCrew = own!.id;
  expect(await memberCount(tenantB, ownCrew)).toBe(1);
  await runAsTenant(tenantB, async () => {
    await database
      .delete(wakerGroupMembers)
      .where(eq(wakerGroupMembers.groupId, ownCrew));
  });
  expect(await memberCount(tenantB, ownCrew)).toBe(0);
});

test("every tenant table answers all four commands, and no writer answers the platform's row", async () => {
  /*
   * The hole this file exists for was one policy serving two questions, and a single `FOR ALL` policy
   * is exactly what a hand-written tenant table still tends to copy from 0067. So read the catalog
   * rather than trusting the next author: a table missing one command's policy would see no rows for
   * it — safe but silently broken — and a table with a `FOR ALL` policy has re-opened the write path.
   */
  // `pg_policies` is the catalogue, not a tenant's rows: read in the system frame.
  const rows = Array.from(
    (await runAsTenant("system", () =>
      database.execute(sql.raw(POLICY_CATALOG_SQL)),
    )) as ArrayLike<PolicyRow>,
  );

  const commands = new Map<string, Set<string>>();
  for (const row of rows) {
    const seen = commands.get(row.table) ?? new Set<string>();
    seen.add(row.command);
    commands.set(row.table, seen);
  }

  // `deployment_packages` is exempt by 0062; `waker_group_members` has no tenant_id of its own and is
  // scoped through its group, which is why it is named separately in the query above.
  expect([...commands.keys()].sort()).toEqual(
    expect.arrayContaining([
      "agents",
      "tasks",
      "waker_groups",
      "waker_group_members",
    ]),
  );
  expect(commands.get("deployment_packages")).toBeUndefined();

  const incomplete = [...commands]
    .filter(
      ([, seen]) =>
        seen.size !== 4 ||
        !["DELETE", "INSERT", "SELECT", "UPDATE"].every((command) =>
          seen.has(command),
        ),
    )
    .map(
      ([table, seen]) => `"${table}" answers ${[...seen].sort().join(", ")}`,
    );
  expect(incomplete).toEqual([]);

  /*
   * The write side never mentions the platform's rows as something a tenant may reach. The platform
   * writer's own branch — `current_setting(…) = 'platform'` — is not the same thing and must stay.
   */
  const reachable = rows
    .filter((row) => row.command !== "SELECT")
    .filter((row) =>
      [row.using, row.check].some((clause) => {
        const own = ownRowCondition(clause);
        return own.includes("'system'::text") || own.includes("= 'system'");
      }),
    )
    .map((row) => `"${row.table}" ${row.command} can reach a platform row`);
  expect(reachable).toEqual([]);
});

/** The tables 0122 (and 0127, for server secrets) share through the `team` stamp (G01-E). */
const TEAM_TABLES = [
  "agent_profiles",
  "agents",
  "approval_team_rules",
  "approval_team_settings",
  "channel_agents",
  "channel_memberships",
  "channels",
  "credentials",
  "group_bot_threads",
  "group_messages",
  "mcp_servers",
  "mcp_tools",
  "plugin_grants",
  "sandboxed_components",
  "team_bot_assignments",
  "team_bot_audience",
  "team_bot_publications",
];

type NamedPolicyRow = PolicyRow & { name: string; permissive: string };

test("every write that names a 'team' row also names who is writing it (G01-E, 0122)", async () => {
  /*
   * A `team` row belongs to nobody, so a write policy that admits one on its stamp alone admits it
   * for everybody. Each such clause must carry an ownership predicate: the writer's own setting, a
   * membership or visibility function, or a subquery that reads the owner or the admin's role.
   */
  const rows = Array.from(
    (await runAsTenant("system", () =>
      database.execute(
        sql.raw(`
          select p.tablename as "table", p.policyname as "name", p.permissive as "permissive",
                 p.cmd as "command", p.qual as "using", p.with_check as "check"
          from pg_policies p
          where p.schemaname = 'public'
          order by p.tablename, p.policyname
        `),
      ),
    )) as ArrayLike<NamedPolicyRow>,
  );

  const unowned = rows
    .filter((row) => row.command !== "SELECT")
    .flatMap((row) =>
      [row.using, row.check]
        .map((clause) => ownRowCondition(clause))
        .filter((own) => own.includes("'team'"))
        .filter(
          (own) =>
            !own.includes("current_setting('app.tenant_id'") &&
            !own.includes("openbot_team_channel_") &&
            !own.includes("openbot_team_bot_visible(") &&
            !own.includes("SUBQUERY_EXISTS"),
        )
        .map(() => `"${row.table}" ${row.name} admits a team row for anybody`),
    );
  expect(unowned).toEqual([]);

  // `team_read` is a read, and exists exactly where 0122 shares rows.
  const teamRead = rows.filter((row) => row.name === "team_read");
  expect([...new Set(teamRead.map((row) => row.table))].sort()).toEqual(
    TEAM_TABLES,
  );
  expect(teamRead.every((row) => row.command === "SELECT")).toBeTrue();
  expect(teamRead.every((row) => row.permissive === "PERMISSIVE")).toBeTrue();

  // Every table that shares anything refuses a `team` frame per command, and freezes its stamp.
  const triggers = Array.from(
    (await runAsTenant("system", () =>
      database.execute(
        sql.raw(`
          select c.relname as "table", t.tgnargs as "count",
                 encode(t.tgargs, 'escape') as "args", t.tgenabled as "enabled"
          from pg_trigger t join pg_class c on c.oid = t.tgrelid
          where t.tgname = 'openbot_team_row_guard' and not t.tgisinternal
        `),
      ),
    )) as ArrayLike<{
      table: string;
      count: number;
      args: string;
      enabled: string;
    }>,
  );
  const guarded = new Map(triggers.map((row) => [row.table, row]));
  const shared = [
    ...new Set(
      rows
        .filter((row) => row.name.startsWith("team_"))
        .map((row) => row.table),
    ),
  ].sort();
  /*
   * `group_message_private` (0128) shares nothing, so it has no `team_read`; it holds the private
   * part of shared group rows, and refuses a `team` frame and freezes its stamp like them.
   */
  expect(shared).toEqual([...TEAM_TABLES, "group_message_private"].sort());
  const unguarded = shared.flatMap((table) => {
    const problems: string[] = [];
    for (const command of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
      const refused = rows.find(
        (row) =>
          row.table === table &&
          row.name === `team_frame_refused_${command.toLowerCase()}`,
      );
      if (
        !refused ||
        refused.command !== command ||
        refused.permissive !== "RESTRICTIVE"
      )
        problems.push(`"${table}" does not refuse a team frame on ${command}`);
    }
    if (!guarded.has(table)) problems.push(`"${table}" has no row guard`);
    else if (guarded.get(table)?.enabled !== "O")
      problems.push(`"${table}" row guard is not enabled`);
    return problems;
  });
  expect(unguarded).toEqual([]);

  /*
   * A misspelled trigger argument compares NULL with NULL and silently guards nothing, so every
   * argument must name a real column of its table.
   */
  const columns = Array.from(
    (await runAsTenant("system", () =>
      database.execute(
        sql.raw(`
          select table_name as "table", column_name as "column"
          from information_schema.columns where table_schema = 'public'
        `),
      ),
    )) as ArrayLike<{ table: string; column: string }>,
  );
  const known = new Set(columns.map((row) => `${row.table}.${row.column}`));
  const misspelled = triggers.flatMap((row) => {
    const args = row.args.split("\\000").filter((arg) => arg !== "");
    const problems = args
      .filter((arg) => !known.has(`${row.table}.${arg}`))
      .map((arg) => `"${row.table}" guards a column it does not have: ${arg}`);
    if (args.length !== Number(row.count))
      problems.push(`"${row.table}" guard arguments were not all read`);
    return problems;
  });
  expect(misspelled).toEqual([]);
  // The credential kind is frozen too: `credentials` holds team server secrets since 0127 (P10).
  expect(guarded.has("credentials")).toBeTrue();
});

/*
 * The part of a policy clause that is about the row being written.
 *
 * Two shapes mention 'system' without letting a tenant reach the platform's rows, and both are
 * removed before looking: an exclusion (`tenant_id <> ALL (ARRAY['system'::text, …])`, which is how
 * PostgreSQL stores `NOT IN ('system', …)` and which forbids exactly those rows), and an `EXISTS (…)`
 * subquery, which reads another table (a binding may point at a built-in 'system' agent while the
 * binding itself must carry the writer's own tenant). Anything else naming 'system' still counts.
 */
function ownRowCondition(clause: string | null | undefined): string {
  if (!clause) return "";
  let text = clause.replace(
    /<>\s*ALL\s*\(ARRAY\[[^\]]*\]\)/g,
    "<> ALL (excluded)",
  );
  for (;;) {
    const start = text.search(/EXISTS\s*\(/);
    if (start < 0) return text;
    let depth = 0;
    let end = text.indexOf("(", start);
    for (; end < text.length; end++) {
      if (text[end] === "(") depth++;
      else if (text[end] === ")" && --depth === 0) break;
    }
    text = `${text.slice(0, start)}SUBQUERY_EXISTS${text.slice(end + 1)}`;
  }
}

afterAll(async () => {
  /*
   * Members before groups, and every statement awaited inside its scope: a platform crew a previous
   * run left behind is readable by EVERY tenant, so it would show up in the list assertions of the
   * suites that run after this one.
   */
  const clean = async (scope: string, groupId: string) => {
    await runAsTenant(scope, async () => {
      await database
        .delete(wakerGroupMembers)
        .where(eq(wakerGroupMembers.groupId, groupId));
    });
    await runAsTenant(scope, async () => {
      await database.delete(wakerGroups).where(eq(wakerGroups.id, groupId));
    });
  };
  if (ownCrew) await clean(tenantB, ownCrew);
  if (systemCrew) await clean("system", systemCrew);
  await runAsTenant("system", remove(systemAgent));
  await runAsTenant(tenantB, remove(ownAgent));
});
