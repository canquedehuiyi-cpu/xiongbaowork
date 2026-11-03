import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { computerAccessCheck } from "../src/agents/computer-access";
import {
  AgentAssignedError,
  createAgentProfileStore,
} from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createAdminScope } from "../src/auth/admin-scope";
import { type AppVariables, createRoleRepository } from "../src/auth/guards";
import { setRole } from "../src/auth/roles";
import { createChannelStore } from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channels,
  intelligenceChannelMappings,
  users,
} from "../src/db/schema";
import {
  teamBotAssignments,
  teamBotAudience,
  teamBotPublications,
} from "../src/db/schema/team-bots";
import { TEAM_TENANT } from "../src/db/schema/tenant";
import { PluginRefusedError } from "../src/plugins/store";
import { teamBotAccess } from "../src/team-bots/access";
import { createTeamBotRoutes } from "../src/team-bots/routes";
import {
  createTeamBots,
  TEAM_BOT_CONSENT_MARKER,
  TeamBotNotFoundError,
  TeamBotRefusedError,
} from "../src/team-bots/team-bots";
import { asPlatform, runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { bindTestRoleWriter } from "./support/role-writer";

/**
 * Team Bots in PostgreSQL, every person acting in their own frame (G01-E P9).
 *
 * A published Bot lives in `team`, moved there by its owner when they publish it, and its
 * publication, audience and assignment rows are stamped `team`: row security shows them to exactly
 * the people the publication names. An administrator reaches Team Bots that are not theirs only
 * through the routes' admin doors (the capability `adminCapability` grants after re-reading
 * `user_roles`): assignments and the full list as `platform`, another person's unpublish in that
 * owner's frame. Only fixtures, cleanup and the stamp checks use `platform` directly.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const profiles = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const channelStore = createChannelStore(
  database,
  profiles,
  createThreadIdentity("test-deployment"),
);
const prefix = `team-bots-${randomUUID()}`;
const createdUsers: string[] = [];
const createdAgents: string[] = [];
const createdChannels: string[] = [];
/** Which servers each person has their own account on, for the consent rule. */
const connected = new Map<string, Set<string>>();
const teamBots = createTeamBots({
  database,
  connectedServers: async (userId) => connected.get(userId) ?? new Set(),
});
const adminScope = createAdminScope({
  roleRepository: createRoleRepository(database),
});
let releaseRoleWriter: (() => Promise<void>) | undefined;

beforeAll(async () => {
  releaseRoleWriter = await bindTestRoleWriter(database);
});

/** As a signed-in request runs: inside the person's own tenant. */
function as<T>(actor: AgentActor, work: () => T): T {
  return runAsTenant(actor.id, work);
}

/** One request to the Team Bot routes, signed in as `actor`, with the admin doors mounted. */
function teamBotRequest(
  actor: AgentActor,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
) {
  const signedIn: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", { ...actor, email: `${actor.id}@example.test` });
    await runAsTenant(actor.id, () => next());
  };
  const app = new Hono<{ Variables: AppVariables }>();
  app.route("/", createTeamBotRoutes(teamBots, signedIn, adminScope));
  return app.request(`http://test${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        }),
  });
}

/** The stamps on a Bot's rows and its publication, as `platform` sees them. */
async function stampsOf(botId: string) {
  return asPlatform(async () => {
    const [agent] = await database
      .select({ tenantId: agents.tenantId })
      .from(agents)
      .where(eq(agents.id, botId));
    const [profile] = await database
      .select({ tenantId: agentProfiles.tenantId })
      .from(agentProfiles)
      .where(eq(agentProfiles.agentId, botId));
    const publications = await database
      .select({ tenantId: teamBotPublications.tenantId })
      .from(teamBotPublications)
      .where(eq(teamBotPublications.agentId, botId));
    const audience = await database
      .select({ tenantId: teamBotAudience.tenantId })
      .from(teamBotAudience)
      .where(eq(teamBotAudience.agentId, botId));
    const assignments = await database
      .select({ tenantId: teamBotAssignments.tenantId })
      .from(teamBotAssignments)
      .where(eq(teamBotAssignments.agentId, botId));
    return {
      agent: agent?.tenantId,
      profile: profile?.tenantId,
      publications: publications.map((row) => row.tenantId),
      audience: audience.map((row) => row.tenantId),
      assignments: assignments.map((row) => row.tenantId),
    };
  });
}

/** Publish as the owner does: in the owner's own frame. */
function publish(
  owner: AgentActor,
  botId: string,
  input: { audience: "team" | "people"; emails: string[]; groups: string[] },
) {
  return as(owner, () => teamBots.publish(owner, botId, input));
}

afterEach(async () => {
  // Cleanup spans several people's rows, which only the platform reaches.
  await runAsTenant("platform", async () => {
    for (const id of createdChannels.splice(0)) {
      await database
        .delete(intelligenceChannelMappings)
        .where(eq(intelligenceChannelMappings.channelId, id));
      await database.delete(channels).where(eq(channels.id, id));
    }
    const ids = createdAgents.splice(0);
    if (ids.length) {
      await database
        .delete(agentProfiles)
        .where(inArray(agentProfiles.agentId, ids));
      await database.delete(agents).where(inArray(agents.id, ids));
    }
    for (const id of createdUsers.splice(0))
      await database.delete(users).where(eq(users.id, id));
  });
  connected.clear();
});
afterAll(async () => {
  await releaseRoleWriter?.();
  await database.$client.close();
});

async function person(
  role: AgentActor["role"] = "user",
  groups: string[] = [],
): Promise<AgentActor & { email: string }> {
  const id = `${prefix}-user-${randomUUID()}`;
  const email = `${id}@example.test`;
  await runAsTenant(id, () =>
    database.insert(users).values({ id, email, name: "Team Bot Test", groups }),
  );
  createdUsers.push(id);
  // `user_roles` is what the admin doors re-read; a session's role alone opens nothing.
  await asPlatform(() => setRole(database, id, role));
  return { id, role, email };
}
async function privateBot(owner: AgentActor, roleDescription = "Answers.") {
  const profile = await as(owner, () =>
    profileStore().create(owner, {
      name: "Release Helper",
      title: "Releases",
      roleDescription,
      visibility: "private",
    }),
  );
  createdAgents.push(profile.id);
  return profile.id;
}
const profileStore = () => profiles;

describe("Team Bots in PostgreSQL", () => {
  test("a teammate chats with a Team Bot but cannot watch or drive its owner's computer", async () => {
    const owner = await person();
    const teammate = await person();
    const admin = await person("admin");
    const bot = await privateBot(owner);
    await publish(owner, bot, {
      audience: "team",
      emails: [],
      groups: [],
    });
    // The teammate can see and use the Bot...
    expect(
      await as(teammate, () => profiles.get(teammate, bot)),
    ).not.toBeNull();
    // ...but the computer, which carries the owner's signed-in browser, stays with the owner.
    const mayUseComputer = computerAccessCheck(profiles);
    expect(await as(teammate, () => mayUseComputer(teammate, bot))).toBe(false);
    expect(await as(owner, () => mayUseComputer(owner, bot))).toBe(true);
    expect(await as(admin, () => mayUseComputer(admin, bot))).toBe(true);
    // The check the computer routes were given before: seeing the Bot was enough.
    const canUseBot = async (actor: AgentActor, botId: string) =>
      (await as(actor, () => profiles.get(actor, botId))) !== null;
    expect(await canUseBot(teammate, bot)).toBe(true);
  });

  test("publishing reaches the team, named people or groups, and unpublishing takes it away", async () => {
    const owner = await person();
    const teammate = await person();
    const engineer = await person("user", ["eng"]);
    const bot = await privateBot(owner);
    const get = (actor: AgentActor) =>
      as(actor, () => profiles.get(actor, bot));
    expect(await get(teammate)).toBeNull();
    expect(await stampsOf(bot)).toMatchObject({
      agent: owner.id,
      profile: owner.id,
    });

    await publish(owner, bot, {
      audience: "team",
      emails: [],
      groups: [],
    });
    expect(await get(teammate)).not.toBeNull();
    expect(await get(engineer)).not.toBeNull();
    // Published, the Bot and its publication live in `team` (G01-E P9).
    expect(await stampsOf(bot)).toEqual({
      agent: TEAM_TENANT,
      profile: TEAM_TENANT,
      publications: [TEAM_TENANT],
      audience: [],
      assignments: [],
    });

    await publish(owner, bot, {
      audience: "people",
      emails: [teammate.email.toUpperCase()],
      groups: [],
    });
    expect(await get(teammate)).not.toBeNull();
    expect(await get(engineer)).toBeNull();
    expect((await stampsOf(bot)).audience).toEqual([TEAM_TENANT]);

    await publish(owner, bot, {
      audience: "people",
      emails: [],
      groups: ["eng"],
    });
    expect(await get(teammate)).toBeNull();
    expect(await get(engineer)).not.toBeNull();

    await as(owner, () => teamBots.unpublish(owner, bot));
    expect(await get(engineer)).toBeNull();
    // Unpublished, a private Bot goes back to its owner, with nothing of the roster left behind.
    expect(await stampsOf(bot)).toEqual({
      agent: owner.id,
      profile: owner.id,
      publications: [],
      audience: [],
      assignments: [],
    });
    expect(await get(owner)).not.toBeNull();
    // Only the owner publishes, and an undescribed Bot is not published at all.
    await expect(
      as(teammate, () =>
        teamBots.publish(teammate, bot, {
          audience: "team",
          emails: [],
          groups: [],
        }),
      ),
    ).rejects.toThrow();
    const bare = await privateBot(owner, "  ");
    await expect(
      publish(owner, bare, {
        audience: "team",
        emails: [],
        groups: [],
      }),
    ).rejects.toThrow(TeamBotRefusedError);
    // Neither refusal moved anything.
    expect((await stampsOf(bot)).profile).toBe(owner.id);
    expect((await stampsOf(bare)).profile).toBe(owner.id);
  });

  test("a teammate in the audience reads the publication; one outside it cannot select the Bot at all", async () => {
    const owner = await person();
    const teammate = await person();
    const outsider = await person();
    const bot = await privateBot(owner);
    await publish(owner, bot, {
      audience: "people",
      emails: [teammate.email],
      groups: [],
    });
    const seen = (actor: AgentActor) =>
      as(actor, async () => ({
        agents: (
          await database
            .select({ id: agents.id })
            .from(agents)
            .where(eq(agents.id, bot))
        ).length,
        profiles: (
          await database
            .select({ id: agentProfiles.agentId })
            .from(agentProfiles)
            .where(eq(agentProfiles.agentId, bot))
        ).length,
        publications: (
          await database
            .select({ id: teamBotPublications.agentId })
            .from(teamBotPublications)
            .where(eq(teamBotPublications.agentId, bot))
        ).length,
        access: (
          await database
            .select({ id: agents.id })
            .from(agents)
            .where(and(eq(agents.id, bot), teamBotAccess(actor.id, agents.id)))
        ).length,
      }));
    expect(await seen(teammate)).toEqual({
      agents: 1,
      profiles: 1,
      publications: 1,
      access: 1,
    });
    expect(await seen(outsider)).toEqual({
      agents: 0,
      profiles: 0,
      publications: 0,
      access: 0,
    });
    // The owner manages it and sees the audience; a teammate sees neither the roster nor the switch.
    const mine = await as(owner, () => teamBots.list(owner));
    expect(mine.find((row) => row.id === bot)).toMatchObject({
      mine: true,
      people: [teammate.email],
    });
    const theirs = await as(teammate, () => teamBots.list(teammate));
    expect(theirs.find((row) => row.id === bot)).not.toHaveProperty("people");
    expect(
      (await as(outsider, () => teamBots.list(outsider))).find(
        (row) => row.id === bot,
      ),
    ).toBeUndefined();
  });

  test("a teammate's chat is private from the owner, and the Bot can join the teammate's group", async () => {
    const owner = await person();
    const teammate = await person();
    const bot = await privateBot(owner);
    await publish(owner, bot, {
      audience: "team",
      emails: [],
      groups: [],
    });
    const chat = await as(teammate, () => channelStore.create(teammate, [bot]));
    createdChannels.push(chat.id);
    expect(
      await as(teammate, () => channelStore.get(teammate, chat.id)),
    ).not.toBeNull();
    expect(await as(owner, () => channelStore.get(owner, chat.id))).toBeNull();

    const own = await privateBot(teammate);
    const group = await as(teammate, () =>
      channelStore.create(teammate, [bot, own]),
    );
    createdChannels.push(group.id);
    expect(group.agentIds.sort()).toEqual([bot, own].sort());
  });

  test("an administrator's assignment reaches a group's sidebars and cannot be hidden", async () => {
    const owner = await person();
    const admin = await person("admin");
    const member = await person("user", ["support"]);
    const outsider = await person();
    const bot = await privateBot(owner);
    await expect(
      as(admin, () => teamBots.assign(admin, bot, "support")),
    ).rejects.toThrow(TeamBotRefusedError);
    // The same refusal through the admin page, before anything is published.
    expect(
      (
        await teamBotRequest(admin, "POST", `/${bot}/assignments`, {
          group: "support",
        })
      ).status,
    ).toBe(400);
    await publish(owner, bot, {
      audience: "people",
      emails: [],
      groups: ["nobody"],
    });
    await expect(
      as(member, () => teamBots.assign(member, bot, "support")),
    ).rejects.toThrow(TeamBotRefusedError);
    expect(
      (
        await teamBotRequest(member, "POST", `/${bot}/assignments`, {
          group: "support",
        })
      ).status,
    ).toBe(400);
    // The administrator is not in the audience: their own frame cannot see the publication...
    await expect(
      as(admin, () => teamBots.assign(admin, bot, "support")),
    ).rejects.toThrow(TeamBotRefusedError);
    // ...and a raw assignment from it is refused without the capability, whatever its stamp: an
    // own-tenant row would hold the (Bot, group) key and make the real assignment do nothing (0126).
    for (const tenantId of [TEAM_TENANT, admin.id])
      await expect(
        as(admin, async () => {
          await database.insert(teamBotAssignments).values({
            agentId: bot,
            groupName: "support",
            assignedBy: admin.id,
            tenantId,
          });
        }),
      ).rejects.toThrow();
    // The admin page assigns, holding the capability.
    expect(
      (
        await teamBotRequest(admin, "POST", `/${bot}/assignments`, {
          group: "support",
        })
      ).status,
    ).toBe(204);
    expect((await stampsOf(bot)).assignments).toEqual([TEAM_TENANT]);
    expect(await as(member, () => teamBots.isAssignedTo(member.id, bot))).toBe(
      true,
    );
    expect(
      await as(outsider, () => teamBots.isAssignedTo(outsider.id, bot)),
    ).toBe(false);
    expect(await as(member, () => profiles.get(member, bot))).not.toBeNull();
    expect(await as(outsider, () => profiles.get(outsider, bot))).toBeNull();
    await expect(
      as(member, () => profiles.setHidden(member, bot, true)),
    ).rejects.toThrow(AgentAssignedError);
    const listed = await as(member, () => teamBots.list(member));
    expect(listed.find((row) => row.id === bot)).toMatchObject({
      assigned: true,
    });
    expect(listed.find((row) => row.id === bot)).not.toHaveProperty("people");
    // The admin page lists it with its roster, though the administrator is in no audience.
    const page = (await (await teamBotRequest(admin, "GET", "/")).json()) as {
      teamBots: { id: string; assignments?: string[] }[];
    };
    expect(page.teamBots.find((row) => row.id === bot)).toMatchObject({
      assignments: ["support"],
    });

    // And takes it back.
    expect(
      (await teamBotRequest(admin, "DELETE", `/${bot}/assignments/support`))
        .status,
    ).toBe(204);
    expect(await as(member, () => teamBots.isAssignedTo(member.id, bot))).toBe(
      false,
    );
    expect(await as(member, () => profiles.get(member, bot))).toBeNull();
  });

  test("a stranger cannot squat an unpublished Bot's publication, audience or assignment key", async () => {
    /*
     * The roster tables are keyed by agent id. A row a stranger stamped with their own tenant used to
     * be accepted, grant nothing, and still hold the key: the owner's publish then failed on a row
     * the owner can neither see nor delete, and an administrator's assignment of the same group did
     * nothing at all (ON CONFLICT DO NOTHING). Since 0126 the stranger's rows are refused, so the
     * owner's publish and the administrator's assignment go through.
     */
    const owner = await person();
    const stranger = await person();
    const admin = await person("admin");
    const member = await person("user", ["support"]);
    const bot = await privateBot(owner);
    const squats = [
      () =>
        database.insert(teamBotPublications).values({
          agentId: bot,
          publishedBy: stranger.id,
          audience: "team",
          tenantId: stranger.id,
        }),
      () =>
        database.insert(teamBotAudience).values({
          agentId: bot,
          kind: "user",
          value: member.id,
          tenantId: stranger.id,
        }),
      () =>
        database.insert(teamBotAssignments).values({
          agentId: bot,
          groupName: "support",
          assignedBy: stranger.id,
          tenantId: stranger.id,
        }),
    ];
    for (const squat of squats) {
      await expect(
        as(stranger, async () => {
          await squat();
        }),
      ).rejects.toThrow();
    }
    expect(await stampsOf(bot)).toEqual({
      agent: owner.id,
      profile: owner.id,
      publications: [],
      audience: [],
      assignments: [],
    });

    await publish(owner, bot, {
      audience: "people",
      emails: [member.email],
      groups: [],
    });
    expect(
      (
        await teamBotRequest(admin, "POST", `/${bot}/assignments`, {
          group: "support",
        })
      ).status,
    ).toBe(204);
    expect(await stampsOf(bot)).toEqual({
      agent: TEAM_TENANT,
      profile: TEAM_TENANT,
      publications: [TEAM_TENANT],
      audience: [TEAM_TENANT],
      assignments: [TEAM_TENANT],
    });
    expect(await as(member, () => profiles.get(member, bot))).not.toBeNull();
    expect(await as(member, () => teamBots.isAssignedTo(member.id, bot))).toBe(
      true,
    );
    // Once it is `team`, the stranger still writes nothing next to it.
    for (const squat of squats) {
      await expect(
        as(stranger, async () => {
          await squat();
        }),
      ).rejects.toThrow();
    }
    expect(await as(stranger, () => profiles.get(stranger, bot))).toBeNull();
  });

  test("an administrator unpublishes another person's Bot in the owner's frame, and the owner keeps it", async () => {
    const owner = await person();
    const admin = await person("admin");
    const teammate = await person();
    const bot = await privateBot(owner);
    await publish(owner, bot, {
      audience: "team",
      emails: [],
      groups: [],
    });
    expect(
      await as(teammate, () => profiles.get(teammate, bot)),
    ).not.toBeNull();

    // From the administrator's own frame the rows are not theirs to delete: refused, nothing changes.
    await expect(
      as(admin, () => teamBots.unpublish(admin, bot)),
    ).rejects.toThrow(TeamBotNotFoundError);
    expect((await stampsOf(bot)).publications).toEqual([TEAM_TENANT]);
    // A person who is not the owner is refused by the route as well.
    expect(
      (await teamBotRequest(teammate, "DELETE", `/${bot}/publication`)).status,
    ).toBe(404);
    expect((await stampsOf(bot)).publications).toEqual([TEAM_TENANT]);

    // The admin page: in the owner's frame, so the Bot goes back to its owner, private.
    expect(
      (await teamBotRequest(admin, "DELETE", `/${bot}/publication`)).status,
    ).toBe(204);
    expect(await stampsOf(bot)).toEqual({
      agent: owner.id,
      profile: owner.id,
      publications: [],
      audience: [],
      assignments: [],
    });
    expect(await as(teammate, () => profiles.get(teammate, bot))).toBeNull();
    expect(await as(owner, () => profiles.get(owner, bot))).toMatchObject({
      ownerUserId: owner.id,
      visibility: "private",
    });
    // The owner may publish it again.
    expect(
      (await as(owner, () => teamBots.publishable(owner))).map((row) => row.id),
    ).toContain(bot);
  });

  test("the Bot reaches the owner's accounts, and a teammate's own only with consent", async () => {
    const owner = await person();
    const teammate = await person();
    const bot = await privateBot(owner);
    await publish(owner, bot, {
      audience: "team",
      emails: [],
      groups: [],
    });
    connected.set(owner.id, new Set(["github"]));
    connected.set(teammate.id, new Set(["github", "gmail"]));
    const ask = teamBots.credentialActorFor(teammate.id, bot);
    // A teammate's call runs in the teammate's frame.
    const as_ = (ref: string) => as(teammate, () => ask(ref));
    expect(await as_("github/search")).toBe(owner.id);
    expect(await as_("shared-docs/search")).toBe(teammate.id);
    expect(
      await as(owner, () =>
        teamBots.credentialActorFor(owner.id, bot)("gmail/send"),
      ),
    ).toBe(owner.id);

    const refusal = await as_("gmail/send").catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(PluginRefusedError);
    expect((refusal as Error).message).toStartWith(TEAM_BOT_CONSENT_MARKER);

    const consent = (decision: Parameters<typeof teamBots.consent>[3]) =>
      as(teammate, () => teamBots.consent(teammate, bot, "gmail", decision));
    await consent("allow_once");
    expect(await as_("gmail/send")).toBe(teammate.id);
    await expect(as_("gmail/send")).rejects.toThrow(PluginRefusedError);

    await consent("allow_always");
    expect(await as_("gmail/send")).toBe(teammate.id);
    expect(await as_("gmail/read")).toBe(teammate.id);
    await consent("skip");
    await expect(as_("gmail/send")).rejects.toThrow(PluginRefusedError);
    await consent("allow_always");
    await as(teammate, () => teamBots.clearConsents(teammate));
    await expect(as_("gmail/send")).rejects.toThrow(PluginRefusedError);
  });
  test("always allow for all Team Bots, and a Bot nobody described stays hidden", async () => {
    const owner = await person();
    const teammate = await person();
    const first = await privateBot(owner);
    const second = await privateBot(owner);
    for (const bot of [first, second])
      await publish(owner, bot, {
        audience: "team",
        emails: [],
        groups: [],
      });
    connected.set(teammate.id, new Set(["gmail"]));
    const ask = (bot: string) =>
      as(teammate, () =>
        teamBots.credentialActorFor(teammate.id, bot)("gmail/send"),
      );
    await expect(ask(second)).rejects.toThrow(PluginRefusedError);
    await as(teammate, () =>
      teamBots.consent(teammate, first, "gmail", "allow_all_team_bots"),
    );
    expect(await ask(second)).toBe(teammate.id);
    await as(teammate, () => teamBots.clearConsents(teammate));
    await expect(ask(second)).rejects.toThrow(PluginRefusedError);

    // A published Bot whose description was later emptied, or that still has a placeholder name,
    // is invisible to teammates and says so to its owner. The owner edits their own `team` rows.
    expect(
      await as(teammate, () => profiles.get(teammate, first)),
    ).not.toBeNull();
    await as(owner, () =>
      database
        .update(agentProfiles)
        .set({ roleDescription: "" })
        .where(eq(agentProfiles.agentId, first)),
    );
    expect(await as(teammate, () => profiles.get(teammate, first))).toBeNull();
    await as(owner, () =>
      database
        .update(agents)
        .set({ name: "New Bot" })
        .where(eq(agents.id, second)),
    );
    expect(await as(teammate, () => profiles.get(teammate, second))).toBeNull();
    const own = await as(owner, () => teamBots.list(owner));
    expect(own.find((row) => row.id === first)?.visibleToTeam).toBe(false);
    const placeholder = await privateBot(owner);
    await as(owner, () =>
      database
        .update(agents)
        .set({ name: "Untitled" })
        .where(eq(agents.id, placeholder)),
    );
    await expect(
      publish(owner, placeholder, {
        audience: "team",
        emails: [],
        groups: [],
      }),
    ).rejects.toThrow(TeamBotRefusedError);
  });
});
