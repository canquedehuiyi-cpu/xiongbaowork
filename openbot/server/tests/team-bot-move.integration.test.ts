import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import {
  AgentNotFoundError,
  AgentNotManageableError,
  createAgentProfileStore,
  moveToOwner,
  moveToTeam,
} from "../src/agents/profile-store";
import type { AgentActor, CreateAgentInput } from "../src/agents/profile-types";
import { createAuditStore } from "../src/audit";
import { createAdminScope } from "../src/auth/admin-scope";
import { type AppVariables, createRoleRepository } from "../src/auth/guards";
import { setRole } from "../src/auth/roles";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  mcpServers,
  mcpTools,
  pluginGrants,
  registeredDevices,
  skills,
  users,
} from "../src/db/schema";
import { createPluginStore, PluginRefusedError } from "../src/plugins/store";
import { asPlatform, runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { bindTestRoleWriter } from "./support/role-writer";

/**
 * G01-E P8b: a public Bot lives in the shared `team` tenant, and its owner moves it there and back.
 *
 * The move is the owner's own, in the owner's frame (`app.team_move`, the 0122 row guard): the profile,
 * the `agents` row and the Bot's grants are re-stamped together; the Bot's child rows (security policy,
 * knowledge bindings, device projects) stay with the owner (I8). After the move the Bot keeps what it
 * was granted for its owner AND for a teammate (R11), the owner keeps their skill, and nobody but the
 * owner can write, delete or move it. A store write that row security turns into "0 rows" throws (I9),
 * so a callback token that was never stored is never handed out.
 *
 * Every person acts in their own frame; only fixtures and the stamp checks use `platform`.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const plugins = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: { readSecret: async () => null },
  encryptionKey: "x".repeat(44),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
});

const suite = `tbm-${randomUUID().slice(0, 8)}`;
const owner: AgentActor = { id: `${suite}-owner`, role: "user" };
const teammate: AgentActor = { id: `${suite}-teammate`, role: "user" };
const stranger: AgentActor = { id: `${suite}-stranger`, role: "user" };
const admin: AgentActor = { id: `${suite}-admin`, role: "admin" };
const people = [owner, teammate, stranger, admin];

const server = `${suite}-server`;
const toolRef = `${server}/lookup`;
const skillSlug = `${suite}-standup`;
const createdAgentIds: string[] = [];

const as = <T>(actor: AgentActor, fn: () => T): T => runAsTenant(actor.id, fn);

/*
 * An administrator's request: their own frame, holding the capability `adminCapability` grants after
 * re-reading `user_roles` (where `beforeAll` makes `admin` an administrator).
 */
const adminScope = createAdminScope({
  roleRepository: createRoleRepository(database),
});
let releaseRoleWriter: (() => Promise<void>) | undefined;

async function withCapability<T>(
  actor: AgentActor,
  work: () => Promise<T>,
): Promise<T> {
  let outcome: { value: T } | { error: unknown } | undefined;
  const app = new Hono<{ Variables: AppVariables }>();
  app.use(
    "*",
    async (context, next) => {
      context.set("actor", { ...actor, email: `${actor.id}@example.test` });
      await runAsTenant(actor.id, () => next());
    },
    adminScope.adminCapability,
  );
  app.get("/", async (context) => {
    outcome = await work().then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    return context.body(null, 204);
  });
  await app.request("http://test/");
  if (!outcome) throw new Error("The admin request never ran its work.");
  if ("error" in outcome) throw outcome.error;
  return outcome.value;
}

/** The message of a refused statement, wherever the query builder put the driver's error. */
async function refusal(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    const messages: string[] = [];
    for (
      let current: unknown = error;
      current instanceof Error;
      current = (current as Error & { cause?: unknown }).cause
    )
      messages.push(current.message);
    return messages.join(" / ");
  }
  return "not refused";
}

const input = (visibility: "public" | "private"): CreateAgentInput => ({
  name: "Ledger Desk",
  title: "Finance",
  roleDescription: "Answers ledger questions.",
  visibility,
});

async function createBot(visibility: "public" | "private") {
  const profile = await as(owner, () => store.create(owner, input(visibility)));
  createdAgentIds.push(profile.id);
  return profile.id;
}

/** Every stamp the move touches, as `platform` sees it. */
async function stampsOf(agentId: string) {
  return asPlatform(async () => {
    const [agent] = await database
      .select({ tenantId: agents.tenantId })
      .from(agents)
      .where(eq(agents.id, agentId));
    const [profile] = await database
      .select({ tenantId: agentProfiles.tenantId })
      .from(agentProfiles)
      .where(eq(agentProfiles.agentId, agentId));
    const grants = await database
      .select({ tenantId: pluginGrants.tenantId })
      .from(pluginGrants)
      .where(eq(pluginGrants.agentId, agentId));
    return {
      agent: agent?.tenantId,
      profile: profile?.tenantId,
      grants: [...new Set(grants.map((row) => row.tenantId))],
    };
  });
}

/** What the runtime would offer this Bot, asked in `frame`. */
async function offered(frame: string, agentId: string) {
  const granted = await runAsTenant(frame, () => plugins.listForAgent(agentId));
  return {
    tools: granted.tools.map((tool) => tool.ref),
    skills: granted.skills.map((skill) => skill.slug),
  };
}

/** The raw rows `actor` can select in `table` for this Bot. */
async function visibleCount(actor: AgentActor, table: string, agentId: string) {
  const [row] = await as(actor, () =>
    database.execute(
      sql`select count(*)::int as n from ${sql.identifier(table)} where agent_id = ${agentId}`,
    ),
  );
  return (row as { n: number }).n;
}

const childTables = [
  "agent_security_policies",
  "knowledge_bindings",
  "knowledge_binding_heads",
  "resource_projects",
  "project_context_bindings",
];

beforeAll(async () => {
  releaseRoleWriter = await bindTestRoleWriter(database);
  await asPlatform(async () => {
    await database.insert(users).values(
      people.map((person) => ({
        id: person.id,
        email: `${person.id}@example.test`,
      })),
    );
    await setRole(database, admin.id, "admin");
    // A server every person reads (`team`, as P10 stamps them), with one tool.
    await database.insert(mcpServers).values({
      id: server,
      tenantId: "team",
      title: "Ledger server",
      vendor: "Test",
      url: "https://mcp.example.invalid/ledger",
    });
    await database.insert(mcpTools).values({
      serverId: server,
      tenantId: "team",
      name: "lookup",
      description: "Looks up a ledger line.",
    });
  });
  // The owner's own skill.
  await as(owner, () =>
    database.insert(skills).values({
      id: randomUUID(),
      slug: skillSlug,
      ownerUserId: owner.id,
      title: "Standup",
      summary: "The owner's standup.",
      instructions: "Owner's own instructions.",
      origin: "yours",
    }),
  );
});

afterAll(async () => {
  await asPlatform(async () => {
    if (createdAgentIds.length > 0)
      await database.delete(agents).where(inArray(agents.id, createdAgentIds));
    await database
      .delete(registeredDevices)
      .where(eq(registeredDevices.deviceId, `${suite}-device`));
    await database.delete(mcpServers).where(eq(mcpServers.id, server));
    await database.delete(skills).where(eq(skills.slug, skillSlug));
    await database.delete(users).where(
      inArray(
        users.id,
        people.map((person) => person.id),
      ),
    );
  });
  await releaseRoleWriter?.();
  await database.$client.close();
});

describe("the owner's move of a Bot to `team` and back", () => {
  test("a Bot made public at creation is `team` from its first commit", async () => {
    const agentId = await createBot("public");
    expect(await stampsOf(agentId)).toEqual({
      agent: "team",
      profile: "team",
      grants: [],
    });
    expect((await as(teammate, () => store.get(teammate, agentId)))?.id).toBe(
      agentId,
    );
  });

  test("the profile, the Bot and its grants move; child rows stay with the owner; tools and skills survive", async () => {
    const agentId = await createBot("private");
    await as(owner, async () => {
      await plugins.grant("mcp", toolRef, agentId, owner.id);
      await plugins.grant("skill", skillSlug, agentId, owner.id);
    });
    // The owner's child rows of this Bot, in the owner's frame.
    const notebook = randomUUID();
    const project = randomUUID();
    await as(owner, () =>
      database.transaction(async (tx) => {
        const [device] = await tx
          .insert(registeredDevices)
          .values({
            deviceId: `${suite}-device`,
            name: `${suite}-device`,
            tokenHash: `${suite}-hash`,
          })
          .returning({ id: registeredDevices.id });
        await tx.execute(
          sql`insert into knowledge_notebooks (id, owner_user_id, title) values (${notebook}, ${owner.id}, 'Notes')`,
        );
        await tx.execute(
          sql`insert into agent_security_policies (agent_id, config) values (${agentId}, jsonb_build_object('enterpriseMode', false, 'dangerousCommandsEnabled', false, 'sensitivePathsEnabled', false, 'sensitivePaths', '[]'::jsonb, 'toolModes', '{}'::jsonb))`,
        );
        await tx.execute(
          sql`insert into knowledge_bindings (owner_user_id, agent_id, notebook_id, access_mode) values (${owner.id}, ${agentId}, ${notebook}, 'read_only')`,
        );
        await tx.execute(
          sql`insert into knowledge_binding_heads (owner_user_id, agent_id) values (${owner.id}, ${agentId})`,
        );
        await tx.execute(
          sql`insert into resource_projects (id, device_id, scope, agent_id, name, source) values (${project}, ${device?.id}, 'agent', ${agentId}, 'Repo', '{"kind":"local","rootRef":"fld_AAAAAAAAAAAAAAAAAAAAAA","label":"Repo","writable":false}'::jsonb)`,
        );
        await tx.execute(
          sql`insert into project_context_bindings (device_id, agent_id, project_id) values (${device?.id}, ${agentId}, ${project})`,
        );
      }),
    );
    const childCounts = async (actor: AgentActor) => {
      const counts: string[] = [];
      for (const table of childTables)
        counts.push(`${table}:${await visibleCount(actor, table, agentId)}`);
      return counts;
    };
    const ownerHasAll = childTables.map((table) => `${table}:1`);
    const strangerHasNone = childTables.map((table) => `${table}:0`);

    expect(await stampsOf(agentId)).toEqual({
      agent: owner.id,
      profile: owner.id,
      grants: [owner.id],
    });
    const before = await offered(owner.id, agentId);
    expect(before).toEqual({ tools: [toolRef], skills: [skillSlug] });

    // Public: everything that is the Bot moves to `team`.
    await as(owner, () => store.update(owner, agentId, input("public")));
    expect(await stampsOf(agentId)).toEqual({
      agent: "team",
      profile: "team",
      grants: ["team"],
    });
    expect(await childCounts(owner)).toEqual(ownerHasAll);
    expect(await childCounts(stranger)).toEqual(strangerHasNone);
    // The owner keeps the tool and their skill; a teammate keeps the tool, and gets only what the
    // deployment ships for skills (Q4); the background frame resolves the owner's skill too.
    expect(await offered(owner.id, agentId)).toEqual(before);
    expect(await offered(teammate.id, agentId)).toEqual({
      tools: [toolRef],
      skills: [],
    });
    expect(await offered("platform", agentId)).toEqual(before);

    // Private again: back to the owner, with nothing lost.
    await as(owner, () => store.update(owner, agentId, input("private")));
    expect(await stampsOf(agentId)).toEqual({
      agent: owner.id,
      profile: owner.id,
      grants: [owner.id],
    });
    expect(await childCounts(owner)).toEqual(ownerHasAll);
    expect(await offered(owner.id, agentId)).toEqual(before);
    expect(await offered(teammate.id, agentId)).toEqual({
      tools: [],
      skills: [],
    });
    expect(await as(teammate, () => store.get(teammate, agentId))).toBeNull();
  });
});

describe("nobody but the owner writes, deletes or moves the Bot", () => {
  test("a stranger's raw writes change nothing, and a stranger cannot move somebody else's Bot", async () => {
    const privateBot = await createBot("private");
    // Granted while private, then made public, so the grant moved with it. (Grants written to a Bot
    // that is already `team` are stamped `team` by `grant`: see the last describe below.)
    const teamBot = await createBot("private");
    await as(owner, () => plugins.grant("mcp", toolRef, teamBot, owner.id));
    await as(owner, () => store.update(owner, teamBot, input("public")));

    for (const agentId of [privateBot, teamBot]) {
      const changed = await as(stranger, async () => ({
        profile: await database
          .update(agentProfiles)
          .set({ title: "Taken" })
          .where(eq(agentProfiles.agentId, agentId))
          .returning({ id: agentProfiles.agentId }),
        agent: await database
          .update(agents)
          .set({ name: "Taken" })
          .where(eq(agents.id, agentId))
          .returning({ id: agents.id }),
        grants: await database
          .delete(pluginGrants)
          .where(eq(pluginGrants.agentId, agentId))
          .returning({ ref: pluginGrants.ref }),
        deletedProfile: await database
          .delete(agentProfiles)
          .where(eq(agentProfiles.agentId, agentId))
          .returning({ id: agentProfiles.agentId }),
        deletedAgent: await database
          .delete(agents)
          .where(eq(agents.id, agentId))
          .returning({ id: agents.id }),
      }));
      expect(changed).toEqual({
        profile: [],
        agent: [],
        grants: [],
        deletedProfile: [],
        deletedAgent: [],
      });
    }

    // The move sets `app.team_move` for the Bot it names; for a stranger that still opens nothing.
    await expect(
      as(stranger, () =>
        database.transaction((tx) => moveToTeam(tx, privateBot)),
      ),
    ).rejects.toBeInstanceOf(AgentNotFoundError);
    await expect(
      as(stranger, () =>
        database.transaction((tx) => moveToOwner(tx, teamBot, stranger.id)),
      ),
    ).rejects.toBeInstanceOf(AgentNotFoundError);
    // By hand, with the GUC set for that very Bot: still nothing.
    const byHand = await as(stranger, () =>
      database.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('app.team_move', ${privateBot}, true)`,
        );
        return tx
          .update(agentProfiles)
          .set({ tenantId: "team" })
          .where(eq(agentProfiles.agentId, privateBot))
          .returning({ id: agentProfiles.agentId });
      }),
    );
    expect(byHand).toEqual([]);

    expect(await stampsOf(privateBot)).toEqual({
      agent: owner.id,
      profile: owner.id,
      grants: [],
    });
    expect(await stampsOf(teamBot)).toEqual({
      agent: "team",
      profile: "team",
      grants: ["team"],
    });
    const names = await asPlatform(() =>
      database
        .select({ name: agents.name, title: agentProfiles.title })
        .from(agents)
        .innerJoin(agentProfiles, eq(agentProfiles.agentId, agents.id))
        .where(inArray(agents.id, [privateBot, teamBot])),
    );
    expect(names).toEqual([
      { name: "Ledger Desk", title: "Finance" },
      { name: "Ledger Desk", title: "Finance" },
    ]);
  });

  test("a write row security turns into nothing throws, and no unstored callback token is handed out", async () => {
    const teamBot = await createBot("public");
    // The administrator's own frame sees the team Bot, and the store's role check lets an
    // administrator manage it, but only the owner's frame may write it: every write matches 0 rows.
    await expect(
      as(admin, () => store.issueCallbackToken(admin, teamBot)),
    ).rejects.toBeInstanceOf(AgentNotManageableError);
    await expect(
      as(admin, () =>
        store.update(admin, teamBot, {
          ...input("public"),
          title: "Renamed",
        }),
      ),
    ).rejects.toBeInstanceOf(AgentNotManageableError);
    await expect(
      as(admin, () => store.softDelete(admin, teamBot)),
    ).rejects.toBeInstanceOf(AgentNotManageableError);
    await expect(
      as(admin, () => store.revokeCallbackToken(admin, teamBot)),
    ).rejects.toBeInstanceOf(AgentNotManageableError);
    const stored = async () =>
      (
        await asPlatform(() =>
          database
            .select({
              hash: agentProfiles.callbackTokenHash,
              title: agentProfiles.title,
              deletedAt: agentProfiles.deletedAt,
            })
            .from(agentProfiles)
            .where(eq(agentProfiles.agentId, teamBot)),
        )
      )[0];
    expect(await stored()).toEqual({
      hash: null,
      title: "Finance",
      deletedAt: null,
    });

    // The owner's frame writes it, and the token it is handed is the one stored.
    const token = await as(owner, () =>
      store.issueCallbackToken(owner, teamBot),
    );
    expect(typeof token).toBe("string");
    expect((await stored())?.hash).not.toBeNull();
    const holder = await asPlatform(() =>
      database
        .select({ agentId: agentProfiles.agentId })
        .from(agentProfiles)
        .where(
          and(
            eq(agentProfiles.agentId, teamBot),
            eq(agentProfiles.tenantId, "team"),
          ),
        ),
    );
    expect(holder).toEqual([{ agentId: teamBot }]);
  });
});

describe("a team Bot's grants, written after it moved", () => {
  const otherRef = `${server}/audit`;
  const grantRows = (agentId: string) =>
    asPlatform(() =>
      database
        .select({ ref: pluginGrants.ref, tenantId: pluginGrants.tenantId })
        .from(pluginGrants)
        .where(eq(pluginGrants.agentId, agentId))
        .orderBy(pluginGrants.ref),
    );

  test("the owner's new grant is stamped `team` and offered; a teammate's grant or revoke is refused", async () => {
    const agentId = await createBot("public");
    await as(owner, () => plugins.grant("mcp", toolRef, agentId, owner.id));
    expect(await grantRows(agentId)).toEqual([
      { ref: toolRef, tenantId: "team" },
    ]);
    expect((await offered(owner.id, agentId)).tools).toEqual([toolRef]);
    expect((await offered(teammate.id, agentId)).tools).toEqual([toolRef]);
    expect((await offered("platform", agentId)).tools).toEqual([toolRef]);

    // A teammate sees the Bot and its grant, and may change neither.
    await expect(
      as(teammate, () => plugins.grant("mcp", otherRef, agentId, teammate.id)),
    ).rejects.toBeInstanceOf(PluginRefusedError);
    await expect(
      as(teammate, () => plugins.revoke("mcp", toolRef, agentId, teammate.id)),
    ).rejects.toBeInstanceOf(PluginRefusedError);
    // An administrator without the capability (a routine, a Bot turn) neither.
    await expect(
      as(admin, () => plugins.grant("mcp", otherRef, agentId, admin.id)),
    ).rejects.toBeInstanceOf(PluginRefusedError);
    expect(await grantRows(agentId)).toEqual([
      { ref: toolRef, tenantId: "team" },
    ]);

    // An administrator holding the capability may, and writes `team` too.
    await withCapability(admin, () =>
      plugins.grant("mcp", otherRef, agentId, admin.id),
    );
    expect(await grantRows(agentId)).toEqual([
      { ref: otherRef, tenantId: "team" },
      { ref: toolRef, tenantId: "team" },
    ]);
    await withCapability(admin, () =>
      plugins.revoke("mcp", otherRef, agentId, admin.id),
    );

    // The owner takes theirs away, and the Bot is offered nothing.
    await as(owner, () => plugins.revoke("mcp", toolRef, agentId, owner.id));
    expect(await grantRows(agentId)).toEqual([]);
    expect((await offered(owner.id, agentId)).tools).toEqual([]);
  });

  test("an administrator with the capability cannot re-stamp a team Bot's grants, even with `app.team_move` set", async () => {
    const agentId = await createBot("public");
    await as(owner, () => plugins.grant("mcp", toolRef, agentId, owner.id));
    // Row security admits the administrator's update of a team grant (0122); the row guard's owner
    // check (0125) is what refuses the re-stamp out of `team`.
    const refused = await withCapability(admin, () =>
      refusal(
        database.transaction(async (tx) => {
          await tx.execute(
            sql`select set_config('app.team_move', ${agentId}, true)`,
          );
          return tx
            .update(pluginGrants)
            .set({ tenantId: admin.id })
            .where(eq(pluginGrants.agentId, agentId))
            .returning({ ref: pluginGrants.ref });
        }),
      ),
    );
    expect(refused).toContain("tenant_id of plugin_grants is fixed");
    expect(await grantRows(agentId)).toEqual([
      { ref: toolRef, tenantId: "team" },
    ]);
    expect(await stampsOf(agentId)).toEqual({
      agent: "team",
      profile: "team",
      grants: ["team"],
    });
    // The owner's own move back still passes the same guard.
    await as(owner, () => store.update(owner, agentId, input("private")));
    expect(await stampsOf(agentId)).toEqual({
      agent: owner.id,
      profile: owner.id,
      grants: [owner.id],
    });
  });
});
