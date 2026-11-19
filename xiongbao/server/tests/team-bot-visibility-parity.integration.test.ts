import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, like, or, sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  teamBotAssignments,
  teamBotAudience,
  teamBotPublications,
  users,
} from "../src/db/schema";
import { TEAM_TENANT } from "../src/db/schema/tenant";
import { teamBotAccess } from "../src/team-bots/access";
import { asPlatform, runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * `openbot_team_bot_visible` (migration 0122) is a hand-written SQL copy of the Team Bot access rule
 * in `src/team-bots/access.ts` — `teamBotAccess` with `describedForTeam` and `PLACEHOLDER_BOT_NAMES`
 * — plus "public" and "the owner", for a live profile. Row security on the Bot and roster tables
 * reads the copy; the profile store and the runtime loader read the TypeScript. If the two ever
 * disagree, a person either loses a Bot the app shows them or reads one the app hides, so this file
 * asks both, for every person and Bot in a matrix that touches each branch, and wants the same answer.
 *
 * The Bots are stamped `team` directly under `platform`: raw fixture rows, not a production path.
 * The SQL side is asked in each person's own frame, the way row security asks it.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = `tbv-${randomUUID().slice(0, 8)}`;
const groupA = `${suite}-group-a`;
const groupB = `${suite}-group-b`;

const owner = `${suite}-owner`;
const named = `${suite}-named`;
const inGroupA = `${suite}-in-a`;
const inGroupB = `${suite}-in-b`;
const outsider = `${suite}-outsider`;
/** A frame with no `users` row at all: no groups to read. */
const unknown = `${suite}-unknown`;
const people = [owner, named, inGroupA, inGroupB, outsider, unknown];

type Bot = {
  id: string;
  name?: string;
  roleDescription?: string;
  visibility?: "public" | "private";
  deleted?: boolean;
  audience?: "team" | "people";
  audienceRows?: { kind: "user" | "group"; value: string }[];
  assignments?: string[];
  /**
   * Roster rows the outsider inserted stamped with their OWN tenant, which row security lets anybody
   * do for any agent id. Neither copy of the rule may count them.
   */
  forged?: ("audience" | "assignment" | "publication")[];
};

const bots: Bot[] = [
  { id: `${suite}-to-team`, audience: "team" },
  {
    id: `${suite}-to-a-person`,
    audience: "people",
    audienceRows: [{ kind: "user", value: named }],
  },
  {
    id: `${suite}-to-a-group`,
    audience: "people",
    audienceRows: [{ kind: "group", value: groupA }],
  },
  { id: `${suite}-assigned-all`, audience: "people", assignments: ["*"] },
  { id: `${suite}-assigned-b`, audience: "people", assignments: [groupB] },
  { id: `${suite}-undescribed`, audience: "team", roleDescription: "   " },
  { id: `${suite}-placeholder`, audience: "team", name: "  New Bot " },
  {
    id: `${suite}-placeholder-assigned`,
    audience: "people",
    name: "Untitled",
    assignments: ["*"],
  },
  { id: `${suite}-deleted`, audience: "team", deleted: true },
  { id: `${suite}-public`, visibility: "public" },
  { id: `${suite}-unpublished` },
  {
    id: `${suite}-audience-unpublished`,
    audienceRows: [{ kind: "user", value: named }],
  },
  { id: `${suite}-forged-audience`, audience: "people", forged: ["audience"] },
  {
    id: `${suite}-forged-assignment`,
    audience: "people",
    forged: ["assignment"],
  },
  { id: `${suite}-forged-publication`, forged: ["publication"] },
];

beforeAll(async () => {
  await asPlatform(async () => {
    await database.insert(users).values([
      { id: owner, email: `${owner}@example.test` },
      { id: named, email: `${named}@example.test` },
      { id: inGroupA, email: `${inGroupA}@example.test`, groups: [groupA] },
      {
        id: inGroupB,
        email: `${inGroupB}@example.test`,
        groups: [groupB, `${suite}-unrelated`],
      },
      { id: outsider, email: `${outsider}@example.test` },
    ]);
    for (const bot of bots) {
      await database.insert(agents).values({
        id: bot.id,
        tenantId: TEAM_TENANT,
        name: bot.name ?? `Reviewer ${bot.id}`,
        type: "built_in",
        configuration: {},
      });
      await database.insert(agentProfiles).values({
        agentId: bot.id,
        tenantId: TEAM_TENANT,
        ownerUserId: owner,
        title: "Reviewer",
        roleDescription: bot.roleDescription ?? "Reviews pull requests",
        avatarSeed: bot.id,
        visibility: bot.visibility ?? "private",
        deletedAt: bot.deleted ? new Date() : null,
      });
      if (bot.audience)
        await database.insert(teamBotPublications).values({
          agentId: bot.id,
          tenantId: TEAM_TENANT,
          publishedBy: owner,
          audience: bot.audience,
        });
      for (const row of bot.audienceRows ?? [])
        await database
          .insert(teamBotAudience)
          .values({ agentId: bot.id, tenantId: TEAM_TENANT, ...row });
      for (const groupName of bot.assignments ?? [])
        await database.insert(teamBotAssignments).values({
          agentId: bot.id,
          tenantId: TEAM_TENANT,
          groupName,
          assignedBy: owner,
        });
      for (const kind of bot.forged ?? []) {
        if (kind === "audience")
          await database.insert(teamBotAudience).values({
            agentId: bot.id,
            tenantId: outsider,
            kind: "user",
            value: outsider,
          });
        if (kind === "assignment")
          await database.insert(teamBotAssignments).values({
            agentId: bot.id,
            tenantId: outsider,
            groupName: "*",
            assignedBy: outsider,
          });
        if (kind === "publication")
          await database.insert(teamBotPublications).values({
            agentId: bot.id,
            tenantId: outsider,
            publishedBy: outsider,
            audience: "team",
          });
      }
    }
  });
});

afterAll(async () => {
  await asPlatform(async () => {
    // Profiles, publications, audience and assignments follow their agent by cascade.
    await database.delete(agents).where(like(agents.id, `${suite}-%`));
    await database.delete(users).where(like(users.id, `${suite}-%`));
  });
  await database.$client.close();
});

/** The TypeScript rule, as the profile store's `accessFilter` applies it to a live profile. */
async function visibleByTypeScript(person: string): Promise<Set<string>> {
  const rows = await asPlatform(() =>
    database
      .select({ id: agentProfiles.agentId })
      .from(agentProfiles)
      .where(
        and(
          inArray(
            agentProfiles.agentId,
            bots.map((bot) => bot.id),
          ),
          isNull(agentProfiles.deletedAt),
          or(
            eq(agentProfiles.visibility, "public"),
            eq(agentProfiles.ownerUserId, person),
            teamBotAccess(person, agentProfiles.agentId),
          ),
        ),
      ),
  );
  return new Set(rows.map((row) => row.id));
}

/** The SQL copy, asked in the person's own frame. */
async function visibleBySql(person: string): Promise<Set<string>> {
  const visible = new Set<string>();
  for (const bot of bots) {
    const rows = (await runAsTenant(person, () =>
      database.execute(
        sql`select public.openbot_team_bot_visible(${bot.id}) as visible`,
      ),
    )) as unknown as { visible: boolean }[];
    if (rows[0]?.visible === true) visible.add(bot.id);
  }
  return visible;
}

test("every fixture Bot is stamped team, so the SQL copy is asked about a row it governs", async () => {
  const stamps = await asPlatform(() =>
    database
      .select({ tenant: agentProfiles.tenantId })
      .from(agentProfiles)
      .where(like(agentProfiles.agentId, `${suite}-%`)),
  );
  expect(stamps).toHaveLength(bots.length);
  expect(stamps.every((row) => row.tenant === TEAM_TENANT)).toBeTrue();
});

test("the SQL copy answers exactly what src/team-bots/access.ts answers, for every person and Bot", async () => {
  const disagreements: string[] = [];
  const answers = new Map<string, Set<string>>();
  for (const person of people) {
    const typescript = await visibleByTypeScript(person);
    const database = await visibleBySql(person);
    answers.set(person, database);
    for (const bot of bots) {
      if (typescript.has(bot.id) !== database.has(bot.id))
        disagreements.push(
          `${person} / ${bot.id}: access.ts ${typescript.has(bot.id)}, SQL ${database.has(bot.id)}`,
        );
    }
  }
  expect(disagreements).toEqual([]);

  // The matrix reaches every branch: what each person sees, by Bot.
  const seen = (person: string) =>
    [...(answers.get(person) ?? [])]
      .map((id) => id.slice(suite.length + 1))
      .sort();
  const shared = ["assigned-all", "public", "to-team"];
  expect(seen(owner)).toEqual(
    bots
      .filter((bot) => !bot.deleted)
      .map((bot) => bot.id.slice(suite.length + 1))
      .sort(),
  );
  expect(seen(named)).toEqual([...shared, "to-a-person"].sort());
  expect(seen(inGroupA)).toEqual([...shared, "to-a-group"].sort());
  expect(seen(inGroupB)).toEqual([...shared, "assigned-b"].sort());
  expect(seen(outsider)).toEqual(shared);
  expect(seen(unknown)).toEqual(shared);
});

test("no frame that is nobody's sees a Team Bot through the SQL copy", async () => {
  for (const frame of ["system", "platform"]) {
    const rows = (await runAsTenant(frame, () =>
      database.execute(
        sql`select public.openbot_team_bot_visible(${bots[0]!.id}) as visible`,
      ),
    )) as unknown as { visible: boolean }[];
    expect(rows[0]?.visible).toBe(false);
  }
});
