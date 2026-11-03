import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { TransactionSQL } from "bun";
import { eq, like, sql } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { createAdminScope } from "../src/auth/admin-scope";
import { type AppVariables, createRoleRepository } from "../src/auth/guards";
import { setRole } from "../src/auth/roles";
import { createDatabase } from "../src/db/client";
import { agents, approvalTeamRules, channels, users } from "../src/db/schema";
import { TEAM_TENANT } from "../src/db/schema/tenant";
import {
  asPlatform,
  runAsTenant,
  TenantContextError,
} from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { bindTestRoleWriter } from "./support/role-writer";

/**
 * Migration 0122: rows shared by the team are stamped `team` and reached only through an ownership
 * predicate in the frame of the person asking (G01-E, invariants I1–I4, I10).
 *
 * Frames are opened as the database sees them: a transaction that sets `app.tenant_id`,
 * `app.capability` and `app.team_move` exactly as `db/client.ts` and the profile store set them, so a
 * case can name a frame the application refuses to open (`team`) or a GUC only the Bot move sets.
 * Where the application's own path matters — the client's frame, the `adminCapability` middleware —
 * the case goes through it. Team rows are written the way production will write them: from the
 * owner's, member's or administrator's own frame. Only raw fixture rows (a Bot re-stamped by hand)
 * use `platform`.
 *
 * A refused INSERT raises (WITH CHECK is asked of the new row); a refused UPDATE or DELETE of a row
 * the frame cannot see changes nothing, and is asserted by its row count; an UPDATE of a row the frame
 * CAN see that would move it — a re-stamp, a different link — raises from the row guard trigger.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const roleRepository = createRoleRepository(database);
const scope = createAdminScope({ roleRepository });
const suite = `ttr-${randomUUID().slice(0, 8)}`;
let releaseRoleWriter: (() => Promise<void>) | undefined;

const owner = `${suite}-owner`;
const member = `${suite}-member`;
const creator = `${suite}-creator`;
const stranger = `${suite}-stranger`;
const audience = `${suite}-audience`;
const admin = `${suite}-admin`;

/** A Bot the owner publishes to one named person: invisible to everybody else. */
const restrictedBot = `${suite}-restricted-bot`;
/** A Bot the owner moves to `team` in the exploit case (k). */
const movingBot = `${suite}-moving-bot`;
/** A Bot re-stamped `team` by hand, whose owner keeps its child rows. */
const childBot = `${suite}-child-bot`;

const group = `${suite}-group`;
const victimGroup = `${suite}-victim-group`;
const doomedGroup = `${suite}-doomed-group`;
const leftGroup = `${suite}-left-group`;
const linkGroup = `${suite}-link-group`;

const rule = `${suite}-rule`;
const settings = `${suite}-settings`;
const server = `${suite}-server`;
const component = `${suite}-component`;
const draftComponent = `${suite}-draft-component`;

type Frame = { tenant: string; capability?: "admin"; teamMove?: string };

/** One transaction in `frame`, with every GUC the policies read set explicitly. */
function inFrame<T>(
  frame: Frame,
  work: (tx: TransactionSQL) => Promise<T>,
): Promise<T> {
  return database.$client.begin(async (tx) => {
    await tx`select set_config('app.tenant_id', ${frame.tenant}, true),
                    set_config('app.capability', ${frame.capability ?? ""}, true),
                    set_config('app.team_move', ${frame.teamMove ?? ""}, true)`;
    return work(tx);
  }) as Promise<T>;
}

const as = (tenant: string): Frame => ({ tenant });
const asAdmin: Frame = { tenant: admin, capability: "admin" };

/** Rows `frame` can select from `table` where `column` = `value`. */
async function count(
  frame: Frame,
  table: string,
  column: string,
  value: string,
): Promise<number> {
  return inFrame(frame, async (tx) => {
    const [row] = await tx.unsafe(
      `select count(*)::int as n from public.${table} where ${column} = $1`,
      [value],
    );
    return (row as { n: number }).n;
  });
}

/** How many rows a write in `frame` changed. */
async function changed(
  frame: Frame,
  work: (tx: TransactionSQL) => Promise<unknown>,
): Promise<number> {
  return inFrame(frame, async (tx) => {
    const result = (await work(tx)) as { count: number };
    return result.count;
  });
}

/** The write raises a row-security (or row guard) refusal, never some unrelated error. */
async function refused(
  frame: Frame,
  work: (tx: TransactionSQL) => Promise<unknown>,
) {
  let caught: unknown;
  try {
    await inFrame(frame, work);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeDefined();
  expect((caught as { errno?: string }).errno).toBe("42501");
}

/**
 * Runs `statement` from inside a trigger the frame itself creates on a temporary table, so the
 * row guard sees `pg_trigger_depth() > 1` without any foreign key being involved. Any role with
 * TEMP on the database can do this; the guard must not take depth for a referential action.
 */
async function refusedFromNestedTrigger(frame: Frame, statement: string) {
  const tag = `zz_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  await refused(frame, async (tx) => {
    await tx.unsafe(`create temp table ${tag} (x int) on commit drop`);
    await tx.unsafe(
      `create function pg_temp.${tag}_f() returns trigger language plpgsql as $f$
       begin ${statement}; return new; end $f$`,
    );
    await tx.unsafe(
      `create trigger ${tag}_tr after insert on ${tag} for each row execute function pg_temp.${tag}_f()`,
    );
    await tx.unsafe(`insert into ${tag} values (1)`);
  });
}

/** An app signed in as `id`, through `adminCapability`, the way an admin route runs. */
function adminRequest<T>(id: string, handler: () => Promise<T>) {
  const signedIn: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", { id, role: "admin", email: `${id}@example.test` });
    await runAsTenant(id, () => next());
  };
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", signedIn, scope.adminCapability);
  app.get("/", async (context) => context.json({ value: await handler() }));
  return app.request("http://test/");
}

async function privateBot(id: string, ownerId: string) {
  await inFrame(as(ownerId), async (tx) => {
    await tx`insert into agents (id, name, type, configuration) values (${id}, ${`Reviewer ${id}`}, 'built_in', '{}'::jsonb)`;
    await tx`insert into agent_profiles (agent_id, owner_user_id, title, role_description, avatar_seed, visibility)
             values (${id}, ${ownerId}, 'Reviewer', 'Reviews pull requests', ${id}, 'private')`;
  });
}

/** The owner's explicit move of their own Bot to `team`, as the profile store makes it (P8b). */
async function moveToTeam(id: string, ownerId: string) {
  await inFrame({ tenant: ownerId, teamMove: id }, async (tx) => {
    await tx`update agent_profiles set tenant_id = 'team' where agent_id = ${id}`;
    await tx`update agents set tenant_id = 'team' where id = ${id}`;
  });
}

/** A shared group opened by `creatorId`, who seeds their own membership and adds `others`. */
async function sharedGroup(id: string, creatorId: string, others: string[]) {
  await inFrame(as(creatorId), async (tx) => {
    await tx`insert into channels (id, name, description, tenant_id) values (${id}, ${id}, '', 'team')`;
    await tx`insert into channel_memberships (channel_id, user_id, tenant_id) values (${id}, ${creatorId}, 'team')`;
    for (const other of others)
      await tx`insert into channel_memberships (channel_id, user_id, tenant_id) values (${id}, ${other}, 'team')`;
  });
}

beforeAll(async () => {
  releaseRoleWriter = await bindTestRoleWriter(database);
  await asPlatform(() =>
    database.insert(users).values(
      [owner, member, creator, stranger, audience, admin].map((id) => ({
        id,
        email: `${id}@example.test`,
      })),
    ),
  );
  for (const id of [owner, member, creator, stranger, audience])
    await asPlatform(() => setRole(database, id, "user"));
  await asPlatform(() => setRole(database, admin, "admin"));

  // A restricted Team Bot, moved and published by its owner from the owner's own frame.
  await privateBot(restrictedBot, owner);
  await moveToTeam(restrictedBot, owner);
  await inFrame(as(owner), async (tx) => {
    await tx`insert into team_bot_publications (agent_id, published_by, audience, tenant_id) values (${restrictedBot}, ${owner}, 'people', 'team')`;
    await tx`insert into team_bot_audience (agent_id, kind, value, tenant_id) values (${restrictedBot}, 'user', ${audience}, 'team')`;
    await tx`insert into plugin_grants (kind, ref, agent_id, granted_by, tenant_id) values ('skill', ${`${suite}-skill`}, ${restrictedBot}, ${owner}, 'team')`;
  });
  // Governance rows, written by an administrator holding the capability.
  await inFrame(asAdmin, async (tx) => {
    await tx`insert into team_bot_assignments (agent_id, group_name, assigned_by, tenant_id) values (${restrictedBot}, ${`${suite}-nobody`}, ${admin}, 'team')`;
    await tx`insert into approval_team_rules (id, bot_id, tool_ref, effect, scope, behaviour, created_by, tenant_id)
             values (${rule}, ${restrictedBot}, 'shell', 'write', 'bot', 'ask', ${admin}, 'team')`;
    await tx`insert into approval_team_settings (id, updated_by, tenant_id) values (${settings}, ${admin}, 'team')`;
    await tx`insert into mcp_servers (id, title, vendor, url, tenant_id) values (${server}, 'Tracker', 'example', 'https://mcp.example.test', 'team')`;
    await tx`insert into mcp_tools (server_id, name, tenant_id) values (${server}, 'search', 'team')`;
    await tx`insert into sandboxed_components (name, title, published, tenant_id) values (${component}, 'Chart', true, 'team')`;
    await tx`insert into sandboxed_components (name, title, published, tenant_id) values (${draftComponent}, 'Draft', false, 'team')`;
  });
  // The shared group: `creator` opens it with `member` and `owner` in it.
  await sharedGroup(group, creator, [member, owner]);
  // The restricted Bot is linked by its owner, the one member it is visible to (0128).
  await inFrame(as(owner), async (tx) => {
    await tx`insert into channel_agents (channel_id, agent_id, tenant_id) values (${group}, ${restrictedBot}, 'team')`;
  });
  await inFrame(as(member), async (tx) => {
    await tx`insert into group_messages (id, channel_id, owner_user_id, text, tenant_id) values (${`${suite}-message`}, ${group}, ${member}, 'hello', 'team')`;
    await tx`insert into group_bot_threads (owner_user_id, channel_id, agent_id, thread_id, tenant_id) values (${member}, ${group}, ${restrictedBot}, ${`${suite}-thread`}, 'team')`;
  });
  // A group the stranger is not in.
  await sharedGroup(victimGroup, owner, []);
});

afterAll(async () => {
  await asPlatform(async () => {
    // Memberships, channel Bots, messages and threads follow their channel by cascade.
    await database.delete(channels).where(like(channels.id, `${suite}-%`));
    await database.execute(
      sql`delete from approval_team_rules where id like ${`${suite}-%`}`,
    );
    await database.execute(
      sql`delete from approval_team_settings where id like ${`${suite}-%`}`,
    );
    await database.execute(
      sql`delete from mcp_servers where id like ${`${suite}-%`}`,
    );
    await database.execute(
      sql`delete from sandboxed_components where name like ${`${suite}-%`}`,
    );
    await database.execute(
      sql`delete from registered_devices where name like ${`${suite}-%`}`,
    );
    // Profiles, publications, audience, assignments, grants and child rows follow their agent.
    await database.delete(agents).where(like(agents.id, `${suite}-%`));
    // `user_roles`, notebooks and knowledge rows follow their user.
    await database.delete(users).where(like(users.id, `${suite}-%`));
  });
  await releaseRoleWriter?.();
  await database.$client.close();
});

describe("governance rows (approval rules and settings, MCP servers and tools, components)", () => {
  const governance: [string, string, string][] = [
    ["approval_team_rules", "id", rule],
    ["approval_team_settings", "id", settings],
    ["mcp_servers", "id", server],
    ["mcp_tools", "server_id", server],
    ["sandboxed_components", "name", component],
  ];

  test("any person reads them; an unpublished component only an administrator with the capability", async () => {
    for (const reader of [member, stranger, owner])
      for (const [table, column, value] of governance)
        expect(
          `${table}:${await count(as(reader), table, column, value)}`,
        ).toBe(`${table}:1`);
    expect(
      await count(as(member), "sandboxed_components", "name", draftComponent),
    ).toBe(0);
    expect(
      await count(as(admin), "sandboxed_components", "name", draftComponent),
    ).toBe(0);
    expect(
      await count(asAdmin, "sandboxed_components", "name", draftComponent),
    ).toBe(1);
  });

  test("a member writes none of them: inserts raise, updates and deletes change nothing", async () => {
    await refused(
      as(member),
      (tx) =>
        tx`insert into approval_team_rules (id, bot_id, tool_ref, effect, scope, behaviour, tenant_id)
           values (${`${suite}-member-rule`}, ${restrictedBot}, 'shell', 'write', 'bot', 'allow', 'team')`,
    );
    await refused(
      as(member),
      (tx) =>
        tx`insert into mcp_servers (id, title, vendor, url, tenant_id) values (${`${suite}-member-server`}, 'x', 'x', 'https://x.example.test', 'team')`,
    );
    expect(
      await changed(
        as(member),
        (tx) =>
          tx`update approval_team_rules set behaviour = 'allow' where id = ${rule}`,
      ),
    ).toBe(0);
    expect(
      await changed(
        as(member),
        (tx) =>
          tx`update approval_team_settings set host_commands_cap = 'allow' where id = ${settings}`,
      ),
    ).toBe(0);
    expect(
      await changed(
        as(member),
        (tx) => tx`delete from mcp_tools where server_id = ${server}`,
      ),
    ).toBe(0);
    expect(
      await changed(
        as(member),
        (tx) => tx`delete from sandboxed_components where name = ${component}`,
      ),
    ).toBe(0);
    expect(await count(as(member), "mcp_tools", "server_id", server)).toBe(1);
  });

  test("an administrator with the capability writes them, with the right row count", async () => {
    expect(
      await changed(
        asAdmin,
        (tx) =>
          tx`update approval_team_settings set host_commands_cap = 'never' where id = ${settings}`,
      ),
    ).toBe(1);
    expect(
      await changed(
        asAdmin,
        (tx) =>
          tx`update approval_team_rules set behaviour = 'hand_off' where id = ${rule}`,
      ),
    ).toBe(1);
  });

  test("(j) an administrator without the capability — a routine's frame — inserts no rule; through adminCapability they do", async () => {
    const routineRule = `${suite}-routine-rule`;
    const values = {
      id: routineRule,
      botId: restrictedBot,
      toolRef: "shell",
      effect: "write",
      scope: "bot",
      behaviour: "ask",
      tenantId: TEAM_TENANT,
    } as const;
    // The admin's own frame, as their routines and Bot turns run: no capability.
    await expect(
      runAsTenant(admin, async () => {
        await database.insert(approvalTeamRules).values(values);
      }),
    ).rejects.toThrow();
    expect(await count(asAdmin, "approval_team_rules", "id", routineRule)).toBe(
      0,
    );

    // The same insert inside an admin request, after `adminCapability` re-read the role.
    const response = await adminRequest(admin, async () => {
      await database.insert(approvalTeamRules).values(values);
      return true;
    });
    expect(response.status).toBe(200);
    expect(await count(asAdmin, "approval_team_rules", "id", routineRule)).toBe(
      1,
    );

    // A member who claims to be an admin gets no capability from the middleware.
    const claimed = await adminRequest(member, async () => {
      await database
        .insert(approvalTeamRules)
        .values({ ...values, id: `${suite}-claimed-rule` });
      return true;
    });
    expect(claimed.status).toBe(500);
    expect(
      await count(
        asAdmin,
        "approval_team_rules",
        "id",
        `${suite}-claimed-rule`,
      ),
    ).toBe(0);
  });

  test("(e) an administrator with the capability cannot re-stamp a rule into their own tenant", async () => {
    await refused(
      asAdmin,
      (tx) =>
        tx`update approval_team_rules set tenant_id = ${admin} where id = ${rule}`,
    );
    await refused(
      asAdmin,
      (tx) =>
        tx`update approval_team_settings set id = ${`${suite}-renamed`} where id = ${settings}`,
    );
  });
});

describe("Team Bot rows (agents, profiles, publications, audience, assignments, grants)", () => {
  const botRows: [string, string][] = [
    ["agents", "id"],
    ["agent_profiles", "agent_id"],
    ["team_bot_publications", "agent_id"],
    ["team_bot_audience", "agent_id"],
    ["team_bot_assignments", "agent_id"],
    ["plugin_grants", "agent_id"],
  ];

  test("(i) the owner and the named audience read a restricted Bot; a stranger reads none of it", async () => {
    for (const [table, column] of botRows) {
      expect(
        `${table}:${await count(as(owner), table, column, restrictedBot)}`,
      ).toBe(`${table}:1`);
      expect(
        `${table}:${await count(as(audience), table, column, restrictedBot)}`,
      ).toBe(`${table}:1`);
      expect(
        `${table}:${await count(as(stranger), table, column, restrictedBot)}`,
      ).toBe(`${table}:0`);
      // An administrator's own frame is a person's: not in the audience, not the owner.
      expect(
        `${table}:${await count(asAdmin, table, column, restrictedBot)}`,
      ).toBe(`${table}:0`);
    }
  });

  test("the owner writes the publication and audience; a stranger's writes raise or change nothing", async () => {
    expect(
      await changed(
        as(owner),
        (tx) =>
          tx`update team_bot_publications set audience = 'people' where agent_id = ${restrictedBot}`,
      ),
    ).toBe(1);
    expect(
      await changed(
        as(stranger),
        (tx) =>
          tx`update team_bot_publications set audience = 'team' where agent_id = ${restrictedBot}`,
      ),
    ).toBe(0);
    expect(
      await changed(
        as(stranger),
        (tx) =>
          tx`delete from team_bot_audience where agent_id = ${restrictedBot}`,
      ),
    ).toBe(0);
    expect(
      await changed(
        as(audience),
        (tx) =>
          tx`update agent_profiles set title = 'Mine now' where agent_id = ${restrictedBot}`,
      ),
    ).toBe(0);
    await refused(
      as(stranger),
      (tx) =>
        tx`insert into team_bot_audience (agent_id, kind, value, tenant_id) values (${restrictedBot}, 'user', ${stranger}, 'team')`,
    );
    await refused(
      as(stranger),
      (tx) =>
        tx`insert into plugin_grants (kind, ref, agent_id, tenant_id) values ('skill', ${`${suite}-sneaky`}, ${restrictedBot}, 'team')`,
    );
    // An administrator with the capability may grant to a Team Bot; without it, may not.
    await refused(
      as(admin),
      (tx) =>
        tx`insert into plugin_grants (kind, ref, agent_id, tenant_id) values ('skill', ${`${suite}-admin-skill`}, ${restrictedBot}, 'team')`,
    );
    await inFrame(
      asAdmin,
      (tx) =>
        tx`insert into plugin_grants (kind, ref, agent_id, tenant_id) values ('skill', ${`${suite}-admin-skill`}, ${restrictedBot}, 'team')`,
    );
    expect(
      await count(as(owner), "plugin_grants", "agent_id", restrictedBot),
    ).toBe(2);
    // Assignments are governance: the owner does not write them, an administrator does.
    await refused(
      as(owner),
      (tx) =>
        tx`insert into team_bot_assignments (agent_id, group_name, assigned_by, tenant_id) values (${restrictedBot}, '*', ${owner}, 'team')`,
    );
  });

  test("(i) a stranger's own-tenant audience, assignment or publication row opens nothing", async () => {
    // Until 0126, row security let anybody insert a roster row stamped with their OWN tenant naming
    // any agent id. Such a row must not count for the Team Bot, which is stamped `team`. Since 0126
    // the stranger cannot write one (case (l)), so the rows a stranger wrote before it are planted
    // here as they were left, stamped with the stranger, and read back in the stranger's own frame.
    const unpublishedBot = `${suite}-unpublished-bot`;
    await privateBot(unpublishedBot, owner);
    await moveToTeam(unpublishedBot, owner);
    const forged = (bot: string, insert: string) =>
      inFrame({ tenant: "platform" }, async (tx) => {
        await tx.unsafe(insert, [bot, stranger]);
        await tx`select set_config('app.tenant_id', ${stranger}, true)`;
        const [row] = await tx.unsafe(
          `select public.openbot_team_bot_visible($1) as visible,
                  (select count(*)::int from public.agents where id = $1) as agents,
                  (select count(*)::int from public.agent_profiles where agent_id = $1) as profiles,
                  (select count(*)::int from public.team_bot_publications
                    where agent_id = $1 and tenant_id = 'team') as publications`,
          [bot],
        );
        // Undo the forged row so later cases see the fixture as it was.
        throw Object.assign(new Error("rollback"), { seen: row });
      }).catch((error: { seen?: unknown }) => {
        if (!error.seen) throw error;
        return error.seen;
      });
    const nothing = { visible: false, agents: 0, profiles: 0, publications: 0 };
    expect(
      await forged(
        restrictedBot,
        `insert into team_bot_audience (agent_id, kind, value, tenant_id) values ($1, 'user', $2, $2)`,
      ),
    ).toEqual(nothing);
    expect(
      await forged(
        restrictedBot,
        `insert into team_bot_assignments (agent_id, group_name, assigned_by, tenant_id) values ($1, '*', $2, $2)`,
      ),
    ).toEqual(nothing);
    expect(
      await forged(
        unpublishedBot,
        `insert into team_bot_publications (agent_id, published_by, audience, tenant_id) values ($1, $2, 'team', $2)`,
      ),
    ).toEqual(nothing);
  });

  test("(l) nobody squats a Bot's roster key: outside platform a roster row is stamped team, by its rightful writer", async () => {
    // The three tables are keyed by agent id. A row a stranger stamped with their own tenant used to
    // hold the key of somebody's unpublished Bot, and the owner's publish then failed on a row the
    // owner could neither see nor delete (0126).
    const squatted = `${suite}-squatted-bot`;
    await privateBot(squatted, owner);
    const inserts = {
      publication: `insert into team_bot_publications (agent_id, published_by, audience, tenant_id) values ($1, $2, 'team', $3)`,
      audience: `insert into team_bot_audience (agent_id, kind, value, tenant_id) values ($1, 'user', $2, $3)`,
      assignment: `insert into team_bot_assignments (agent_id, group_name, assigned_by, tenant_id) values ($1, '*', $2, $3)`,
    };
    for (const insert of Object.values(inserts)) {
      // Neither with the stranger's own stamp, nor with `team`, nor before or after the owner moves it.
      await refused(as(stranger), (tx) =>
        tx.unsafe(insert, [squatted, stranger, stranger]),
      );
      await refused(as(stranger), (tx) =>
        tx.unsafe(insert, [squatted, stranger, "team"]),
      );
      // An administrator with the capability writes assignments, but only stamped `team`.
      await refused(asAdmin, (tx) =>
        tx.unsafe(insert, [squatted, admin, admin]),
      );
      // The owner, too, writes the Bot's roster only stamped `team`.
      await refused(as(owner), (tx) =>
        tx.unsafe(insert, [squatted, owner, owner]),
      );
    }
    await moveToTeam(squatted, owner);
    for (const insert of Object.values(inserts)) {
      await refused(as(stranger), (tx) =>
        tx.unsafe(insert, [squatted, stranger, stranger]),
      );
      await refused(as(stranger), (tx) =>
        tx.unsafe(insert, [squatted, stranger, "team"]),
      );
    }
    expect(
      await count(
        { tenant: "platform" },
        "team_bot_publications",
        "agent_id",
        squatted,
      ),
    ).toBe(0);
    // The key is free: the owner publishes, and the administrator assigns, stamped `team`.
    await inFrame(as(owner), async (tx) => {
      await tx.unsafe(inserts.publication, [squatted, owner, "team"]);
      await tx.unsafe(inserts.audience, [squatted, audience, "team"]);
    });
    await inFrame(asAdmin, (tx) =>
      tx.unsafe(inserts.assignment, [squatted, admin, "team"]),
    );
    for (const table of [
      "team_bot_publications",
      "team_bot_audience",
      "team_bot_assignments",
    ])
      expect(
        `${table}:${await count(as(owner), table, "agent_id", squatted)}`,
      ).toBe(`${table}:1`);
    // `platform` (fixtures, operator scripts, the migrations) keeps writing any stamp.
    expect(
      await changed({ tenant: "platform" }, (tx) =>
        tx.unsafe(inserts.audience, [squatted, stranger, stranger]),
      ),
    ).toBe(1);
    // Profiles, publications, audience and assignments follow their agent by cascade.
    await asPlatform(() =>
      database.delete(agents).where(eq(agents.id, squatted)),
    );
  });

  test("(k) the owner's re-stamp needs app.team_move for that Bot; a stranger with the GUC changes nothing", async () => {
    await privateBot(movingBot, owner);
    await refused(
      as(owner),
      (tx) =>
        tx`update agent_profiles set tenant_id = 'team' where agent_id = ${movingBot}`,
    );
    // A move keyed to another Bot does not open this one.
    await refused(
      { tenant: owner, teamMove: restrictedBot },
      (tx) =>
        tx`update agent_profiles set tenant_id = 'team' where agent_id = ${movingBot}`,
    );
    expect(
      await changed(
        { tenant: owner, teamMove: movingBot },
        (tx) =>
          tx`update agent_profiles set tenant_id = 'team' where agent_id = ${movingBot}`,
      ),
    ).toBe(1);
    expect(
      await changed(
        { tenant: stranger, teamMove: movingBot },
        (tx) =>
          tx`update agent_profiles set tenant_id = ${stranger}, owner_user_id = ${stranger} where agent_id = ${movingBot}`,
      ),
    ).toBe(0);
    expect(
      await changed(
        { tenant: stranger, teamMove: movingBot },
        (tx) =>
          tx`update agents set tenant_id = ${stranger} where id = ${movingBot}`,
      ),
    ).toBe(0);
    // The owner cannot hand the Bot to somebody else on the way.
    await refused(
      { tenant: owner, teamMove: movingBot },
      (tx) =>
        tx`update agent_profiles set owner_user_id = ${stranger} where agent_id = ${movingBot}`,
    );
    const [profile] = await asPlatform(() =>
      database.execute(
        sql`select tenant_id, owner_user_id from agent_profiles where agent_id = ${movingBot}`,
      ),
    );
    expect(profile).toEqual({ tenant_id: "team", owner_user_id: owner });
  });
});

describe("deleting a person", () => {
  test("a Team Bot's owner who is deleted leaves the Bot without an owner rather than failing the delete", async () => {
    // `agent_profiles.owner_user_id` is ON DELETE SET NULL: the row guard admits a link the foreign
    // key clears, from whatever frame deletes the person, and nothing else.
    const leaver = `${suite}-leaver`;
    const leaverBot = `${suite}-leaver-bot`;
    await asPlatform(() =>
      database
        .insert(users)
        .values({ id: leaver, email: `${leaver}@example.test` }),
    );
    await privateBot(leaverBot, leaver);
    await moveToTeam(leaverBot, leaver);
    await runAsTenant(leaver, async () => {
      await database.delete(users).where(eq(users.id, leaver));
    });
    const [profile] = await asPlatform(() =>
      database.execute(
        sql`select tenant_id, owner_user_id from agent_profiles where agent_id = ${leaverBot}`,
      ),
    );
    expect(profile).toEqual({ tenant_id: "team", owner_user_id: null });
    // Clearing the owner by hand is still refused.
    await refused(
      as(owner),
      (tx) =>
        tx`update agent_profiles set owner_user_id = null where agent_id = ${restrictedBot}`,
    );
    // So is clearing it from a trigger of the owner's own, while the owner still exists.
    await refusedFromNestedTrigger(
      as(owner),
      `update public.agent_profiles set owner_user_id = null where agent_id = '${restrictedBot}'`,
    );
  });
});

describe("shared group rows (channels, memberships, channel Bots, messages, threads)", () => {
  const groupRows: [string, string][] = [
    ["channels", "id"],
    ["channel_memberships", "channel_id"],
    ["channel_agents", "channel_id"],
    ["group_messages", "channel_id"],
    ["group_bot_threads", "channel_id"],
  ];

  test("members read the group; a stranger reads none of it", async () => {
    for (const [table, column] of groupRows) {
      for (const reader of [creator, member, owner])
        expect(
          `${table}:${(await count(as(reader), table, column, group)) > 0}`,
        ).toBe(`${table}:true`);
      expect(
        `${table}:${await count(as(stranger), table, column, group)}`,
      ).toBe(`${table}:0`);
    }
    expect(
      await count(as(member), "channel_memberships", "channel_id", group),
    ).toBe(3);
  });

  test("a member writes their own messages only; a stranger writes nothing", async () => {
    await inFrame(
      as(owner),
      (tx) =>
        tx`insert into group_messages (id, channel_id, owner_user_id, text, tenant_id) values (${`${suite}-owner-message`}, ${group}, ${owner}, 'hi', 'team')`,
    );
    await refused(
      as(owner),
      (tx) =>
        tx`insert into group_messages (id, channel_id, owner_user_id, text, tenant_id) values (${`${suite}-forged`}, ${group}, ${member}, 'as you', 'team')`,
    );
    expect(
      await changed(
        as(owner),
        (tx) =>
          tx`update group_messages set text = 'edited' where id = ${`${suite}-message`}`,
      ),
    ).toBe(0);
    expect(
      await changed(
        as(member),
        (tx) =>
          tx`update group_messages set text = 'edited' where id = ${`${suite}-message`}`,
      ),
    ).toBe(1);
    await refused(
      as(stranger),
      (tx) =>
        tx`insert into group_messages (id, channel_id, owner_user_id, text, tenant_id) values (${`${suite}-stranger-message`}, ${group}, ${stranger}, 'let me in', 'team')`,
    );
    await refused(
      as(stranger),
      (tx) =>
        tx`insert into channel_memberships (channel_id, user_id, tenant_id) values (${group}, ${stranger}, 'team')`,
    );
    expect(
      await changed(
        as(stranger),
        (tx) => tx`delete from channel_memberships where channel_id = ${group}`,
      ),
    ).toBe(0);
    // markRead / setPinned: a member updates their own membership row, and only theirs.
    expect(
      await changed(
        as(member),
        (tx) =>
          tx`update channel_memberships set last_read_at = now() where channel_id = ${group} and user_id = ${member}`,
      ),
    ).toBe(1);
    expect(
      await changed(
        as(member),
        (tx) =>
          tx`update channel_memberships set pinned_at = now() where channel_id = ${group} and user_id = ${owner}`,
      ),
    ).toBe(0);
  });

  test("(a) Path A: an own-tenant membership in a victim group cannot be re-stamped team", async () => {
    // Inserting into one's own tenant is what tenant_isolation always allowed.
    await inFrame(
      as(stranger),
      (tx) =>
        tx`insert into channel_memberships (channel_id, user_id) values (${victimGroup}, ${stranger})`,
    );
    await refused(
      as(stranger),
      (tx) =>
        tx`update channel_memberships set tenant_id = 'team' where channel_id = ${victimGroup} and user_id = ${stranger}`,
    );
    expect(await count(as(stranger), "channels", "id", victimGroup)).toBe(0);
    expect(
      await count(
        as(stranger),
        "channel_memberships",
        "channel_id",
        victimGroup,
      ),
    ).toBe(1);
  });

  test("(b) Path B: a member cannot move their membership to another group", async () => {
    await refused(
      as(member),
      (tx) =>
        tx`update channel_memberships set channel_id = ${victimGroup} where channel_id = ${group} and user_id = ${member}`,
    );
    await refused(
      as(member),
      (tx) =>
        tx`update channel_memberships set user_id = ${stranger} where channel_id = ${group} and user_id = ${member}`,
    );
    expect(await count(as(member), "channels", "id", victimGroup)).toBe(0);
  });

  test("(c, d) a member cannot re-stamp the group or its Bot into their own tenant", async () => {
    await refused(
      as(member),
      (tx) => tx`update channels set tenant_id = ${member} where id = ${group}`,
    );
    await refused(
      as(member),
      (tx) =>
        tx`update channel_agents set tenant_id = ${member} where channel_id = ${group}`,
    );
    await refused(
      as(member),
      (tx) =>
        tx`update group_bot_threads set owner_user_id = ${owner} where channel_id = ${group}`,
    );
    // A member may rename the group: the guard freezes links, not content.
    expect(
      await changed(
        as(member),
        (tx) =>
          tx`update channels set name = 'Renamed by a member' where id = ${group}`,
      ),
    ).toBe(1);
  });

  test("(f) a member cannot make themselves the creator", async () => {
    await refused(
      as(member),
      (tx) =>
        tx`update channels set created_by = ${member} where id = ${group}`,
    );
    // Nor clear the creator from a nested trigger of their own (only a foreign key's SET NULL on
    // agent_profiles.owner_user_id may clear a fixed link one level down).
    await refusedFromNestedTrigger(
      as(member),
      `update public.channels set created_by = null where id = '${group}'`,
    );
    const [row] = await asPlatform(() =>
      database.execute(
        sql`select created_by from channels where id = ${group}`,
      ),
    );
    expect(row).toEqual({ created_by: creator });
  });

  test("(g) only the creator soft-deletes a shared group", async () => {
    await sharedGroup(doomedGroup, creator, [member]);
    await refused(
      as(member),
      (tx) =>
        tx`update channels set deleted_at = now() where id = ${doomedGroup}`,
    );
    expect(
      await changed(
        as(creator),
        (tx) =>
          tx`update channels set deleted_at = now() where id = ${doomedGroup}`,
      ),
    ).toBe(1);
    // Bringing it back is the creator's too: a member cannot resurrect it for everybody.
    await refused(
      as(member),
      (tx) =>
        tx`update channels set deleted_at = null where id = ${doomedGroup}`,
    );
    const [doomed] = await asPlatform(() =>
      database.execute(
        sql`select deleted_at is not null as deleted from channels where id = ${doomedGroup}`,
      ),
    );
    expect(doomed).toEqual({ deleted: true });
    // Removing someone else's membership is the creator's power, not a member's.
    expect(
      await changed(
        as(member),
        (tx) =>
          tx`delete from channel_memberships where channel_id = ${doomedGroup} and user_id = ${creator}`,
      ),
    ).toBe(0);
  });

  test("(h) a creator who left can no longer read the group", async () => {
    await sharedGroup(leftGroup, creator, [member]);
    expect(
      await changed(
        as(creator),
        (tx) =>
          tx`delete from channel_memberships where channel_id = ${leftGroup} and user_id = ${creator}`,
      ),
    ).toBe(1);
    expect(await count(as(creator), "channels", "id", leftGroup)).toBe(0);
    expect(await count(as(member), "channels", "id", leftGroup)).toBe(1);
    // Nor seed their way back in: the group already has members.
    await refused(
      as(creator),
      (tx) =>
        tx`insert into channel_memberships (channel_id, user_id, tenant_id) values (${leftGroup}, ${creator}, 'team')`,
    );
  });

  test("(m) a member links only a Bot they could use: never somebody's private Bot or a Team Bot hidden from them (0128)", async () => {
    const ownersPrivate = `${suite}-owners-private-bot`;
    const membersOwn = `${suite}-members-own-bot`;
    const catalogue = `${suite}-catalogue-bot`;
    await privateBot(ownersPrivate, owner);
    await privateBot(membersOwn, member);
    await asPlatform(() =>
      database.insert(agents).values({
        id: catalogue,
        tenantId: "system",
        name: "Catalogue",
        type: "built_in",
        configuration: {},
      }),
    );
    // `member` opens the group; `audience` is in it too, and is the restricted Bot's audience.
    await sharedGroup(linkGroup, member, [audience]);
    const link = (agentId: string) => (tx: TransactionSQL) =>
      tx`insert into channel_agents (channel_id, agent_id, tenant_id) values (${linkGroup}, ${agentId}, 'team')`;

    // Another person's private Bot, and a Team Bot published to an audience the member is not in.
    await refused(as(member), link(ownersPrivate));
    await refused(as(member), link(restrictedBot));
    // Not by naming a Bot nobody has either.
    await refused(as(member), link(`${suite}-no-such-bot`));
    expect(
      await count(as(member), "channel_agents", "channel_id", linkGroup),
    ).toBe(0);

    // Their own private Bot, a catalogue Bot, and (for the audience) the restricted Team Bot.
    expect(await changed(as(member), link(membersOwn))).toBe(1);
    expect(await changed(as(member), link(catalogue))).toBe(1);
    expect(await changed(as(audience), link(restrictedBot))).toBe(1);
    // The owner of the private Bot is no member of this group, so even they cannot add it here.
    await refused(as(owner), link(ownersPrivate));

    // An existing link cannot be turned into a link to somebody else's Bot.
    await refused(
      as(member),
      (tx) =>
        tx`update channel_agents set agent_id = ${ownersPrivate} where channel_id = ${linkGroup} and agent_id = ${membersOwn}`,
    );
    expect(
      (
        await asPlatform(() =>
          database.execute(
            sql`select agent_id from channel_agents where channel_id = ${linkGroup} order by agent_id`,
          ),
        )
      ).map((row) => (row as { agent_id: string }).agent_id),
    ).toEqual([catalogue, membersOwn, restrictedBot].sort());
  });

  test("the creator column is stamped by the database from the opening frame", async () => {
    const [row] = await asPlatform(() =>
      database.execute(
        sql`select created_by from channels where id = ${group}`,
      ),
    );
    expect(row).toEqual({ created_by: creator });
    // Nobody opens a shared group in someone else's name.
    await refused(
      as(stranger),
      (tx) =>
        tx`insert into channels (id, name, description, tenant_id, created_by) values (${`${suite}-forged-group`}, 'x', '', 'team', ${owner})`,
    );
  });
});

describe("frames that are nobody's", () => {
  const sample: [string, string, string][] = [
    ["agents", "id", restrictedBot],
    ["agent_profiles", "agent_id", restrictedBot],
    ["team_bot_publications", "agent_id", restrictedBot],
    ["team_bot_audience", "agent_id", restrictedBot],
    ["team_bot_assignments", "agent_id", restrictedBot],
    ["plugin_grants", "agent_id", restrictedBot],
    ["approval_team_rules", "id", rule],
    ["approval_team_settings", "id", settings],
    ["mcp_servers", "id", server],
    ["mcp_tools", "server_id", server],
    ["sandboxed_components", "name", component],
    ["channels", "id", group],
    ["channel_memberships", "channel_id", group],
    ["channel_agents", "channel_id", group],
    ["group_messages", "channel_id", group],
    ["group_bot_threads", "channel_id", group],
  ];

  test("the system frame sees no team row", async () => {
    for (const [table, column, value] of sample)
      expect(
        `${table}:${await count(as("system"), table, column, value)}`,
      ).toBe(`${table}:0`);
    const seen = await runAsTenant("system", () =>
      database
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.id, restrictedBot)),
    );
    expect(seen).toEqual([]);
  });

  test("platform sees every team row and writes them", async () => {
    for (const [table, column, value] of sample)
      expect(
        `${table}:${(await count(as("platform"), table, column, value)) > 0}`,
      ).toBe(`${table}:true`);
    const seen = await asPlatform(() =>
      database
        .select({ id: agents.id, tenant: agents.tenantId })
        .from(agents)
        .where(eq(agents.id, restrictedBot)),
    );
    expect(seen).toEqual([{ id: restrictedBot, tenant: TEAM_TENANT }]);
    expect(
      await changed(
        as("platform"),
        (tx) =>
          tx`update approval_team_rules set behaviour = 'ask' where id = ${rule}`,
      ),
    ).toBe(1);
  });

  test("runAsTenant('team') throws before any statement runs", () => {
    expect(() =>
      runAsTenant("team", () =>
        database.select({ id: agents.id }).from(agents),
      ),
    ).toThrow(TenantContextError);
  });

  test("a raw session set to 'team' reads nothing, and every write is refused", async () => {
    for (const [table, column, value] of sample)
      expect(`${table}:${await count(as("team"), table, column, value)}`).toBe(
        `${table}:0`,
      );
    // Inserts raise on the RESTRICTIVE check; updates and deletes see no row to change.
    await refused(
      as("team"),
      (tx) =>
        tx`insert into approval_team_rules (id, bot_id, tool_ref, effect, scope, behaviour, tenant_id)
           values (${`${suite}-team-rule`}, ${restrictedBot}, 'shell', 'write', 'bot', 'allow', 'team')`,
    );
    await refused(
      as("team"),
      (tx) =>
        tx`insert into channel_memberships (channel_id, user_id, tenant_id) values (${group}, ${stranger}, 'team')`,
    );
    await refused(
      as("team"),
      (tx) =>
        tx`insert into channels (id, name, description, tenant_id) values (${`${suite}-team-group`}, 'x', '', 'team')`,
    );
    await refused(
      as("team"),
      (tx) =>
        tx`insert into agents (id, name, type, configuration, tenant_id) values (${`${suite}-team-agent`}, 'x', 'built_in', '{}'::jsonb, 'team')`,
    );
    for (const [table, column, value] of sample) {
      expect(
        `${table}:${await changed(as("team"), (tx) =>
          tx.unsafe(
            `update public.${table} set tenant_id = tenant_id where ${column} = $1`,
            [value],
          ),
        )}`,
      ).toBe(`${table}:0`);
      expect(
        `${table}:${await changed(as("team"), (tx) =>
          tx.unsafe(`delete from public.${table} where ${column} = $1`, [
            value,
          ]),
        )}`,
      ).toBe(`${table}:0`);
    }
  });

  test("no person may be called system, platform or team", async () => {
    for (const reserved of ["system", "platform", "team"]) {
      let caught: unknown;
      try {
        await inFrame(
          as("platform"),
          (tx) =>
            tx`insert into users (id, email) values (${reserved}, ${`${reserved}-${suite}@example.test`})`,
        );
      } catch (error) {
        caught = error;
      }
      expect((caught as { errno?: string } | undefined)?.errno).toBe("23514");
    }
  });
});

describe("a Bot moved to team keeps its owner's child rows", () => {
  let device = "";
  let notebook = "";
  let project = "";

  test("the owner reads and writes security policy, knowledge bindings and device projects; a stranger cannot", async () => {
    await privateBot(childBot, owner);
    // Re-stamped by hand, as a raw fixture: the move itself is case (k) and P8b's.
    await asPlatform(async () => {
      await database.execute(
        sql`update agent_profiles set tenant_id = 'team' where agent_id = ${childBot}`,
      );
      await database.execute(
        sql`update agents set tenant_id = 'team' where id = ${childBot}`,
      );
    });
    notebook = randomUUID();
    await inFrame(as(owner), async (tx) => {
      const [created] =
        await tx`insert into registered_devices (device_id, name, token_hash) values (${`${suite}-device`}, ${`${suite}-device`}, ${`${suite}-hash`}) returning id`;
      device = (created as { id: string }).id;
      await tx`insert into knowledge_notebooks (id, owner_user_id, title) values (${notebook}, ${owner}, 'Notes')`;
    });

    await inFrame(as(owner), async (tx) => {
      await tx`insert into agent_security_policies (agent_id, config) values (${childBot}, jsonb_build_object('enterpriseMode', false, 'dangerousCommandsEnabled', false, 'sensitivePathsEnabled', false, 'sensitivePaths', '[]'::jsonb, 'toolModes', '{}'::jsonb))`;
      await tx`insert into knowledge_bindings (owner_user_id, agent_id, notebook_id, access_mode) values (${owner}, ${childBot}, ${notebook}, 'read_only')`;
      await tx`insert into knowledge_binding_heads (owner_user_id, agent_id) values (${owner}, ${childBot})`;
      project = randomUUID();
      await tx`insert into resource_projects (id, device_id, scope, agent_id, name, source) values (${project}, ${device}, 'agent', ${childBot}, 'Repo', '{}'::jsonb)`;
      await tx`insert into project_context_bindings (device_id, agent_id, project_id) values (${device}, ${childBot}, ${project})`;
    });

    const children: [string, string][] = [
      ["agent_security_policies", "agent_id"],
      ["knowledge_bindings", "agent_id"],
      ["knowledge_binding_heads", "agent_id"],
      ["resource_projects", "agent_id"],
      ["project_context_bindings", "agent_id"],
    ];
    for (const [table, column] of children) {
      expect(
        `${table}:${await count(as(owner), table, column, childBot)}`,
      ).toBe(`${table}:1`);
      expect(
        `${table}:${await count(as(stranger), table, column, childBot)}`,
      ).toBe(`${table}:0`);
    }
    expect(
      await changed(
        as(owner),
        (tx) =>
          tx`update agent_security_policies set revision = revision + 1 where agent_id = ${childBot}`,
      ),
    ).toBe(1);
    expect(
      await changed(
        as(owner),
        (tx) =>
          tx`update knowledge_bindings set access_mode = 'read_write' where agent_id = ${childBot}`,
      ),
    ).toBe(1);
    expect(
      await changed(
        as(owner),
        (tx) =>
          tx`update knowledge_binding_heads set revision = revision + 1 where agent_id = ${childBot}`,
      ),
    ).toBe(1);
    expect(
      await changed(
        as(owner),
        (tx) =>
          tx`update resource_projects set name = 'Repo 2' where id = ${project}`,
      ),
    ).toBe(1);
    expect(
      await changed(
        as(owner),
        (tx) =>
          tx`update project_context_bindings set updated_at = now() where agent_id = ${childBot}`,
      ),
    ).toBe(1);

    // A stranger writes none of them for the owner's Bot, not even into their own tenant.
    await refused(
      as(stranger),
      (tx) =>
        tx`insert into agent_security_policies (agent_id, config) values (${childBot}, jsonb_build_object('enterpriseMode', false, 'dangerousCommandsEnabled', false, 'sensitivePathsEnabled', false, 'sensitivePaths', '[]'::jsonb, 'toolModes', '{}'::jsonb))`,
    );
    await refused(
      as(stranger),
      (tx) =>
        tx`insert into knowledge_binding_heads (owner_user_id, agent_id) values (${stranger}, ${childBot})`,
    );
    expect(
      await changed(
        as(stranger),
        (tx) =>
          tx`update agent_security_policies set revision = revision + 1 where agent_id = ${childBot}`,
      ),
    ).toBe(0);
    expect(
      await changed(
        as(stranger),
        (tx) => tx`delete from knowledge_bindings where agent_id = ${childBot}`,
      ),
    ).toBe(0);
  });
});
