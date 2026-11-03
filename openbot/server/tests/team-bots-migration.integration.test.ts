import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inArray } from "drizzle-orm";
import { setRole } from "../src/auth/roles";
import { createDatabase } from "../src/db/client";
import { agents, users } from "../src/db/schema";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { bindTestRoleWriter } from "./support/role-writer";

/**
 * G01-E P8b, migration 0125: only the rows a Bot's legitimate writer stamped move to `team`.
 *
 * Before 0122 anybody could insert a row stamped with their OWN tenant naming any agent id: a
 * publication, an audience or assignment row, a plugin grant. The migration runs as `platform`, past
 * row security, so a careless re-stamp would turn a stranger's row into the Bot's own: a stranger's
 * publication of somebody's private Bot would publish it to the team, and a stranger's grant would
 * become a tool on somebody's public Bot. Here a stranger's rows are planted next to the legitimate
 * ones, the migration's own statements run, and the stranger's rows keep their stamp and count for
 * nothing in `openbot_team_bot_visible`.
 *
 * The data statements run as this NOBYPASSRLS application role, from the empty frame a migrator
 * arrives with, inside a transaction that is rolled back. The file's `CREATE OR REPLACE FUNCTION` of
 * the row guard is the migrator's (the function belongs to it); it is checked by
 * `team-bot-move.integration.test.ts` against the migrated database.
 */
const db = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = `tbmig-${randomUUID().slice(0, 8)}`;
const owner = `${suite}-owner`;
const stranger = `${suite}-stranger`;
const admin = `${suite}-admin`;
/** Named by the owner's audience row. */
const invited = `${suite}-invited`;
/** Named only by the stranger's audience row. */
const strangersPick = `${suite}-strangers-pick`;
/** In the group the administrator assigned. */
const assignedMember = `${suite}-assigned-member`;
/** In the group only a non-administrator's (or a forged) assignment names. */
const forgedMember = `${suite}-forged-member`;
const people = [
  owner,
  stranger,
  admin,
  invited,
  strangersPick,
  assignedMember,
  forgedMember,
];
const assignedGroup = `${suite}-assigned`;
const forgedGroup = `${suite}-forged`;
const strangerGroup = `${suite}-stranger-group`;

/** Public, owner-stamped: moves, with the owner's grant; the stranger's grant does not. */
const publicBot = `${suite}-public`;
/** Private, published by its owner to named people: moves, with the owner's rows only. */
const publishedBot = `${suite}-published`;
/** Private, "published" by a stranger's own-tenant row: stays the owner's and private. */
const strangerPublishedBot = `${suite}-stranger-published`;
const bots = [publicBot, publishedBot, strangerPublishedBot];

const migration = readFileSync(
  join(
    import.meta.dir,
    "..",
    "recovery",
    "recovery-20261018-v1",
    "sql",
    "0125_team_bots.sql",
  ),
  "utf8",
);
const rosterMigration = readFileSync(
  join(
    import.meta.dir,
    "..",
    "recovery",
    "recovery-20261018-v1",
    "sql",
    "0126_team_bot_roster_stamp.sql",
  ),
  "utf8",
);
/** 0126 minus its policy block, which belongs to the migrator and is already in place here. */
function rosterDataStatements() {
  const statements = rosterMigration.split("--> statement-breakpoint");
  const kept = statements.filter(
    (statement) => !/CREATE POLICY/i.test(statement),
  );
  expect(statements.length - kept.length).toBe(1);
  return kept.join("\n");
}

/** The file's statements minus the migrator's function replacement (see the note above). */
function dataStatements() {
  const statements = migration.split("--> statement-breakpoint");
  const kept = statements.filter(
    (statement) => !/CREATE OR REPLACE FUNCTION/i.test(statement),
  );
  // Exactly the row guard is left out; every data statement runs.
  expect(statements.length - kept.length).toBe(1);
  return kept.join("\n");
}

let releaseRoleWriter: (() => Promise<void>) | undefined;

beforeAll(async () => {
  releaseRoleWriter = await bindTestRoleWriter(db);
  await runAsTenant("platform", async () => {
    await db.insert(users).values(
      people.map((id) => ({
        id,
        email: `${id}@example.test`,
        groups:
          id === assignedMember
            ? [assignedGroup]
            : id === forgedMember
              ? [forgedGroup, strangerGroup]
              : [],
      })),
    );
    await setRole(db, admin, "admin");
  });
});

afterAll(async () => {
  await runAsTenant("platform", async () => {
    // Rolled back already; this only guards against a failure half way through.
    await db.delete(agents).where(inArray(agents.id, bots));
    // `user_roles` follows its user by cascade.
    await db.delete(users).where(inArray(users.id, people));
  });
  await releaseRoleWriter?.();
  await db.$client.close();
});

test("0125 moves only rows their legitimate writer stamped; a stranger's rows stay inert", async () => {
  const rollback = new Error("rollback the migration fixture");
  type Row = Record<string, unknown>;
  let seen:
    | {
        frame: unknown;
        profiles: Row[];
        agents: Row[];
        publications: Row[];
        audience: Row[];
        assignments: Row[];
        grants: Row[];
        visible: Row[];
      }
    | undefined;
  await expect(
    db.$client.begin(async (tx) => {
      // The pre-0125 shape: every row stamped with the frame that wrote it.
      await tx`select set_config('app.tenant_id', 'platform', true)`;
      for (const [id, visibility] of [
        [publicBot, "public"],
        [publishedBot, "private"],
        [strangerPublishedBot, "private"],
      ] as const) {
        await tx`insert into agents (tenant_id, id, name, type, configuration) values (${owner}, ${id}, 'Ledger Desk', 'built_in', '{}'::jsonb)`;
        await tx`insert into agent_profiles (tenant_id, agent_id, owner_user_id, title, role_description, avatar_seed, visibility) values (${owner}, ${id}, ${owner}, 'Finance', 'Answers ledger questions.', 'seed', ${visibility})`;
      }
      // Grants: the owner's, and a stranger's own-tenant row naming the owner's public Bot.
      await tx`insert into plugin_grants (tenant_id, kind, ref, agent_id, granted_by) values (${owner}, 'mcp', 'owner/tool', ${publicBot}, ${owner}), (${stranger}, 'mcp', 'stranger/exfil', ${publicBot}, ${stranger})`;
      // The owner's publication to named people, and the stranger's "publication" of another Bot.
      await tx`insert into team_bot_publications (tenant_id, agent_id, published_by, audience) values (${owner}, ${publishedBot}, ${owner}, 'people'), (${stranger}, ${strangerPublishedBot}, ${stranger}, 'team')`;
      // Audience: the owner's row, and a stranger's row adding their own pick.
      await tx`insert into team_bot_audience (tenant_id, agent_id, kind, value) values (${owner}, ${publishedBot}, 'user', ${invited}), (${stranger}, ${publishedBot}, 'user', ${strangersPick}), (${stranger}, ${publishedBot}, 'group', ${strangerGroup})`;
      // Assignments: an administrator's in their own frame; a stranger's own; one forged in the administrator's name.
      await tx`insert into team_bot_assignments (tenant_id, agent_id, group_name, assigned_by) values (${admin}, ${publishedBot}, ${assignedGroup}, ${admin}), (${stranger}, ${publishedBot}, '*', ${stranger}), (${stranger}, ${strangerPublishedBot}, ${forgedGroup}, ${admin})`;

      await tx`select set_config('app.tenant_id', '', true)`;
      await tx.unsafe(dataStatements());
      const [frame] =
        await tx`select current_setting('app.tenant_id', true) as tenant`;

      await tx`select set_config('app.tenant_id', 'platform', true)`;
      const read = async (query: Promise<unknown>) =>
        Array.from((await query) as ArrayLike<Row>);
      const profiles = await read(
        tx`select agent_id, tenant_id from agent_profiles where agent_id in ${tx(bots)} order by agent_id`,
      );
      const agentRows = await read(
        tx`select id, tenant_id from agents where id in ${tx(bots)} order by id`,
      );
      const publications = await read(
        tx`select agent_id, tenant_id from team_bot_publications where agent_id in ${tx(bots)} order by agent_id`,
      );
      const audience = await read(
        tx`select value, tenant_id from team_bot_audience where agent_id in ${tx(bots)} order by value`,
      );
      const assignments = await read(
        tx`select agent_id, group_name, tenant_id from team_bot_assignments where agent_id in ${tx(bots)} order by agent_id, group_name`,
      );
      const grants = await read(
        tx`select ref, tenant_id from plugin_grants where agent_id in ${tx(bots)} order by ref`,
      );
      // Who `openbot_team_bot_visible` admits now, each asked in their own frame.
      const visible: Row[] = [];
      for (const person of [
        invited,
        strangersPick,
        assignedMember,
        forgedMember,
        stranger,
      ]) {
        await tx`select set_config('app.tenant_id', ${person}, true)`;
        for (const bot of [publishedBot, strangerPublishedBot]) {
          const [row] =
            await tx`select openbot_team_bot_visible(${bot}) as visible`;
          visible.push({ person, bot, visible: (row as Row).visible });
        }
      }
      seen = {
        frame: (frame as Row).tenant,
        profiles,
        agents: agentRows,
        publications,
        audience,
        assignments,
        grants,
        visible,
      };
      throw rollback;
    }),
  ).rejects.toBe(rollback);

  // The frame the migration found is the frame it leaves.
  expect(seen?.frame).toBe("");
  // The public Bot and the Bot its owner published move; the one a stranger "published" stays put.
  expect(seen?.profiles).toEqual([
    { agent_id: publicBot, tenant_id: "team" },
    { agent_id: publishedBot, tenant_id: "team" },
    { agent_id: strangerPublishedBot, tenant_id: owner },
  ]);
  expect(seen?.agents).toEqual([
    { id: publicBot, tenant_id: "team" },
    { id: publishedBot, tenant_id: "team" },
    { id: strangerPublishedBot, tenant_id: owner },
  ]);
  expect(seen?.publications).toEqual([
    { agent_id: publishedBot, tenant_id: "team" },
    { agent_id: strangerPublishedBot, tenant_id: stranger },
  ]);
  expect(seen?.audience).toEqual(
    [
      { value: invited, tenant_id: "team" },
      { value: strangersPick, tenant_id: stranger },
      { value: strangerGroup, tenant_id: stranger },
    ].sort((a, b) => (a.value < b.value ? -1 : 1)),
  );
  expect(seen?.assignments).toEqual(
    [
      { agent_id: publishedBot, group_name: "*", tenant_id: stranger },
      { agent_id: publishedBot, group_name: assignedGroup, tenant_id: "team" },
      {
        agent_id: strangerPublishedBot,
        group_name: forgedGroup,
        tenant_id: stranger,
      },
    ].sort((a, b) =>
      a.agent_id === b.agent_id
        ? a.group_name < b.group_name
          ? -1
          : 1
        : a.agent_id < b.agent_id
          ? -1
          : 1,
    ),
  );
  expect(seen?.grants).toEqual([
    { ref: "owner/tool", tenant_id: "team" },
    { ref: "stranger/exfil", tenant_id: stranger },
  ]);
  // The owner's audience and the administrator's assignment admit; nothing the stranger wrote does.
  expect(seen?.visible).toEqual([
    { person: invited, bot: publishedBot, visible: true },
    { person: invited, bot: strangerPublishedBot, visible: false },
    { person: strangersPick, bot: publishedBot, visible: false },
    { person: strangersPick, bot: strangerPublishedBot, visible: false },
    { person: assignedMember, bot: publishedBot, visible: true },
    { person: assignedMember, bot: strangerPublishedBot, visible: false },
    { person: forgedMember, bot: publishedBot, visible: false },
    { person: forgedMember, bot: strangerPublishedBot, visible: false },
    { person: stranger, bot: publishedBot, visible: false },
    { person: stranger, bot: strangerPublishedBot, visible: false },
  ]);

  // Rolled back: nothing of the fixture is left for anybody.
  expect(
    await runAsTenant("platform", () =>
      db.select({ id: agents.id }).from(agents).where(inArray(agents.id, bots)),
    ),
  ).toEqual([]);
});

test("0126 removes every roster row not stamped team, so a squatted key is free for the owner", async () => {
  /*
   * A stranger's own-tenant rows written before 0126 (a "publication" of the owner's private Bot, an
   * audience row, a '*' assignment) grant nothing but hold the key. 0126 deletes every roster row
   * not stamped `team`, and keeps the `team` ones. Run, like the 0125 case above, as the application
   * role from the empty frame a migrator arrives with, and rolled back.
   */
  const squattedBot = `${suite}-squatted`;
  const sharedBot = `${suite}-shared`;
  const rollback = new Error("rollback the migration fixture");
  type Row = Record<string, unknown>;
  let seen:
    | {
        frame: unknown;
        publications: Row[];
        audience: Row[];
        assignments: Row[];
        published: unknown;
      }
    | undefined;
  await expect(
    db.$client.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', 'platform', true)`;
      // The owner's private Bot, unpublished, and their shared Bot, published to the team.
      await tx`insert into agents (tenant_id, id, name, type, configuration) values (${owner}, ${squattedBot}, 'Ledger Desk', 'built_in', '{}'::jsonb), ('team', ${sharedBot}, 'Ledger Desk', 'built_in', '{}'::jsonb)`;
      await tx`insert into agent_profiles (tenant_id, agent_id, owner_user_id, title, role_description, avatar_seed, visibility) values (${owner}, ${squattedBot}, ${owner}, 'Finance', 'Answers ledger questions.', 'seed', 'private'), ('team', ${sharedBot}, ${owner}, 'Finance', 'Answers ledger questions.', 'seed', 'private')`;
      await tx`insert into team_bot_publications (tenant_id, agent_id, published_by, audience) values (${stranger}, ${squattedBot}, ${stranger}, 'team'), ('team', ${sharedBot}, ${owner}, 'people')`;
      await tx`insert into team_bot_audience (tenant_id, agent_id, kind, value) values (${stranger}, ${squattedBot}, 'user', ${strangersPick}), ('team', ${sharedBot}, 'user', ${invited}), (${stranger}, ${sharedBot}, 'user', ${stranger})`;
      await tx`insert into team_bot_assignments (tenant_id, agent_id, group_name, assigned_by) values (${stranger}, ${squattedBot}, '*', ${stranger}), ('team', ${sharedBot}, ${assignedGroup}, ${admin}), (${stranger}, ${sharedBot}, '*', ${stranger})`;

      await tx`select set_config('app.tenant_id', '', true)`;
      await tx.unsafe(rosterDataStatements());
      const [frame] =
        await tx`select current_setting('app.tenant_id', true) as tenant`;

      await tx`select set_config('app.tenant_id', 'platform', true)`;
      const read = async (query: Promise<unknown>) =>
        Array.from((await query) as ArrayLike<Row>);
      const publications = await read(
        tx`select agent_id, tenant_id from team_bot_publications where agent_id in ${tx([squattedBot, sharedBot])} order by agent_id`,
      );
      const audience = await read(
        tx`select agent_id, value, tenant_id from team_bot_audience where agent_id in ${tx([squattedBot, sharedBot])} order by agent_id, value`,
      );
      const assignments = await read(
        tx`select agent_id, group_name, tenant_id from team_bot_assignments where agent_id in ${tx([squattedBot, sharedBot])} order by agent_id, group_name`,
      );

      // The key is free: the owner moves their Bot and publishes it, from their own frame.
      await tx`select set_config('app.tenant_id', ${owner}, true), set_config('app.team_move', ${squattedBot}, true)`;
      await tx`update agent_profiles set tenant_id = 'team' where agent_id = ${squattedBot}`;
      await tx`update agents set tenant_id = 'team' where id = ${squattedBot}`;
      await tx`select set_config('app.team_move', '', true)`;
      const published =
        await tx`insert into team_bot_publications (tenant_id, agent_id, published_by, audience) values ('team', ${squattedBot}, ${owner}, 'team')`;
      seen = {
        frame: (frame as Row).tenant,
        publications,
        audience,
        assignments,
        published: (published as unknown as { count: number }).count,
      };
      throw rollback;
    }),
  ).rejects.toBe(rollback);

  expect(seen?.frame).toBe("");
  expect(seen?.publications).toEqual([
    { agent_id: sharedBot, tenant_id: "team" },
  ]);
  expect(seen?.audience).toEqual([
    { agent_id: sharedBot, value: invited, tenant_id: "team" },
  ]);
  expect(seen?.assignments).toEqual([
    { agent_id: sharedBot, group_name: assignedGroup, tenant_id: "team" },
  ]);
  expect(seen?.published).toBe(1);
  expect(
    await runAsTenant("platform", () =>
      db
        .select({ id: agents.id })
        .from(agents)
        .where(inArray(agents.id, [squattedBot, sharedBot])),
    ),
  ).toEqual([]);
});
