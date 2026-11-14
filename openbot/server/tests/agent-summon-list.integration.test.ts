import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createAgentRoutes } from "../src/agents/routes";
import type { SummonDeps } from "../src/agents/summon";
import type { AuditEventInput, AuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import {
  createChannelRoutes,
  createChannelStore,
} from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channelMemberships,
  channels,
  deploymentPackages,
  intelligenceChannelMappings,
  pluginGrants,
  portraits,
  subscriptions,
  users,
} from "../src/db/schema";
import type { PortraitPreset } from "../src/portraits/store";
import { createQuotaService } from "../src/quota/limits";
import { runAsTenant } from "../src/tenant/context";
import { avatarAgentId, provisionTenant } from "../src/tenant/provisioning";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

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
const quota = createQuotaService(database);
const audit: AuditEventInput[] = [];
const auditStore: AuditStore = {
  async insert(event) {
    audit.push(event);
  },
};

const prefix = `summon-${randomUUID()}`;
const tenants: string[] = [];
const presetIds: string[] = [];
const packageIds: string[] = [];

afterEach(async () => {
  audit.splice(0);
  await runAsTenant("platform", async () => {
    for (const tenant of tenants.splice(0)) {
      const owned = await database
        .select({ id: channels.id })
        .from(channels)
        .where(eq(channels.tenantId, tenant));
      for (const { id } of owned) {
        await database
          .delete(intelligenceChannelMappings)
          .where(eq(intelligenceChannelMappings.channelId, id));
        await database.delete(channels).where(eq(channels.id, id));
      }
      await database.delete(portraits).where(eq(portraits.tenantId, tenant));
      await database
        .delete(pluginGrants)
        .where(eq(pluginGrants.tenantId, tenant));
      const ownedAgents = await database
        .select({ id: agentProfiles.agentId })
        .from(agentProfiles)
        .where(eq(agentProfiles.ownerUserId, tenant));
      for (const { id } of ownedAgents) {
        await database
          .delete(agentProfiles)
          .where(eq(agentProfiles.agentId, id));
        await database.delete(agents).where(eq(agents.id, id));
      }
      await database
        .delete(subscriptions)
        .where(eq(subscriptions.tenantId, tenant));
      await database.delete(users).where(eq(users.id, tenant));
    }
    for (const id of presetIds.splice(0)) {
      await database.delete(pluginGrants).where(eq(pluginGrants.agentId, id));
      await database.delete(agentProfiles).where(eq(agentProfiles.agentId, id));
      await database.delete(agents).where(eq(agents.id, id));
    }
    for (const id of packageIds.splice(0)) {
      await database
        .delete(deploymentPackages)
        .where(eq(deploymentPackages.id, id));
    }
  });
});
afterAll(async () => {
  await database.$client.close();
});

/** A signed-up person: a Free subscription and their 分身, as sign-up leaves them. */
async function person(): Promise<AgentActor> {
  const id = `${prefix}-user-${randomUUID()}`;
  tenants.push(id);
  await runAsTenant(id, () =>
    database
      .insert(users)
      .values({ id, email: `${id}@example.test`, name: "Summon Test" }),
  );
  await provisionTenant(database, { id, email: `${id}@example.test` });
  return { id, role: "user" };
}

/**
 * A shared preset as package sync leaves it: no owner, public, the package's `agents.package_id`,
 * a preset portrait, and the package's skill grants (plus an app grant, to prove it is not copied).
 */
async function preset(
  options: {
    portrait?: PortraitPreset | null;
    skills?: string[];
    mcp?: string[];
  } = {},
) {
  const [pkg] = await runAsTenant("platform", () =>
    database
      .insert(deploymentPackages)
      .values({
        tenantId: `${prefix}-package-tenant`,
        sourcePath: "/packages/summon-test",
        checksum: randomUUID(),
      })
      .returning({ id: deploymentPackages.id }),
  );
  if (!pkg) throw new Error("package row was not created");
  packageIds.push(pkg.id);
  const id = `${prefix}-preset-${randomUUID()}`;
  presetIds.push(id);
  await runAsTenant("system", async () => {
    await database.insert(agents).values({
      id,
      name: "测试工程师",
      type: "built_in",
      configuration: { systemPrompt: "你是测试工程师。" },
      packageId: pkg.id,
    });
    await database.insert(agentProfiles).values({
      agentId: id,
      ownerUserId: null,
      title: "测试工程师",
      roleDescription: "写测试、找缺陷。",
      avatarSeed: id,
      visibility: "public",
      presetPortrait:
        options.portrait === undefined ? "test-engineer" : options.portrait,
    });
    const grants = [
      ...(options.skills ?? []).map((ref) => ({ kind: "skill", ref })),
      ...(options.mcp ?? []).map((ref) => ({ kind: "mcp", ref })),
    ];
    if (grants.length > 0)
      await database.insert(pluginGrants).values(
        grants.map((grant) => ({
          ...grant,
          agentId: id,
          // What package sync writes (`PACKAGE_GRANT` in tenant-package.ts).
          grantedBy: "tenant-package",
        })),
      );
  });
  return id;
}

/** Somebody's own private coworker. */
async function privateAgent(owner: AgentActor) {
  const id = `${prefix}-private-${randomUUID()}`;
  await runAsTenant(owner.id, async () => {
    await database.insert(agents).values({
      id,
      name: "私有员工",
      type: "built_in",
      configuration: { systemPrompt: "私有。" },
    });
    await database.insert(agentProfiles).values({
      agentId: id,
      ownerUserId: owner.id,
      title: "私有员工",
      roleDescription: "只归主人。",
      avatarSeed: id,
      visibility: "private",
    });
  });
  return id;
}

function routesFor(
  actor: AgentActor,
  direct: SummonDeps["direct"] = (who, agentId) =>
    channelStore.direct(who, agentId),
) {
  const guard: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", {
      id: actor.id,
      email: `${actor.id}@example.test`,
      role: actor.role,
    });
    await runAsTenant(actor.id, next);
  };
  return createAgentRoutes(
    profiles,
    guard,
    false,
    auditStore,
    new Set<string>(),
    undefined,
    true,
    undefined,
    quota,
    undefined,
    undefined,
    undefined,
    undefined,
    { database, direct },
  );
}

type Summoned = {
  agent: {
    id: string;
    summonedFrom?: string | null;
    visibility: string;
    mine: boolean;
  };
  channelId: string;
  created: boolean;
};

async function summon(actor: AgentActor, agentId: string) {
  return routesFor(actor).request(
    new Request(`http://summon.test/${encodeURIComponent(agentId)}/summon`, {
      method: "POST",
    }),
  );
}

async function summoned(actor: AgentActor, agentId: string): Promise<Summoned> {
  const response = await summon(actor, agentId);
  expect(response.status).toBe(200);
  return (await response.json()) as Summoned;
}

function memberships(actor: AgentActor) {
  return runAsTenant(actor.id, () =>
    database
      .select({ id: channelMemberships.channelId })
      .from(channelMemberships)
      .where(eq(channelMemberships.userId, actor.id)),
  );
}

type Listed = {
  id: string;
  summonKind: "preset" | "avatar" | null;
  summoned: boolean;
  summonedFrom: string | null;
};

async function listAgents(actor: AgentActor): Promise<Listed[]> {
  const response = await routesFor(actor).request(
    new Request("http://summon.test/"),
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { agents: Listed[] }).agents;
}

async function listChannels(actor: AgentActor) {
  const guard: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", {
      id: actor.id,
      email: `${actor.id}@example.test`,
      role: actor.role,
    });
    await runAsTenant(actor.id, next);
  };
  const app = new Hono<{ Variables: AppVariables }>();
  app.route("/", createChannelRoutes(channelStore, guard));
  const response = await app.request("/");
  expect(response.status).toBe(200);
  return ((await response.json()) as { channels: { id: string }[] }).channels;
}

describe("会话列表从空开始", () => {
  test("新开通的用户 GET /api/channels 为空，数据库里没有任何一对一会话", async () => {
    const actor = await person();
    expect(await listChannels(actor)).toEqual([]);
    expect(await listChannels(actor)).toEqual([]);
    expect(await memberships(actor)).toEqual([]);
  });

  test("老用户已有和共用预设的一对一会话：会话仍在列表里，预设 summoned 为 false", async () => {
    const actor = await person();
    const source = await preset();
    const channel = await runAsTenant(actor.id, () =>
      channelStore.direct(actor, source),
    );
    const listed = await listChannels(actor);
    expect(listed.map((row) => row.id)).toEqual([channel.id]);
    const found = (await listAgents(actor)).find((row) => row.id === source);
    expect(found).toMatchObject({ summonKind: "preset", summoned: false });
  });
});

describe("GET /api/agents 的召唤状态", () => {
  test("预设员工：未召唤时 preset / false，召唤后 true，复制出的员工 summonKind 为 null", async () => {
    const actor = await person();
    const source = await preset();
    const before = (await listAgents(actor)).find((row) => row.id === source);
    expect(before).toMatchObject({ summonKind: "preset", summoned: false });

    const body = await summoned(actor, source);
    const after = await listAgents(actor);
    expect(after.find((row) => row.id === source)).toMatchObject({
      summonKind: "preset",
      summoned: true,
    });
    expect(after.find((row) => row.id === body.agent.id)).toMatchObject({
      summonKind: null,
      summoned: true,
    });
  });

  test("别人召唤过的预设，对本人仍是未召唤", async () => {
    const actor = await person();
    const other = await person();
    const source = await preset();
    await summoned(other, source);
    const found = (await listAgents(actor)).find((row) => row.id === source);
    expect(found).toMatchObject({ summonKind: "preset", summoned: false });
  });

  test("分身没有一对一会话时 avatar / false，召唤分身后 true", async () => {
    const actor = await person();
    const avatar = avatarAgentId(actor.id);
    expect(
      (await listAgents(actor)).find((row) => row.id === avatar),
    ).toMatchObject({ summonKind: "avatar", summoned: false });
    await summoned(actor, avatar);
    expect(
      (await listAgents(actor)).find((row) => row.id === avatar),
    ).toMatchObject({ summonKind: "avatar", summoned: true });
  });

  test("本人手建的员工 summonKind 为 null、summoned 为 true", async () => {
    const actor = await person();
    const own = await privateAgent(actor);
    expect(
      (await listAgents(actor)).find((row) => row.id === own),
    ).toMatchObject({ summonKind: null, summoned: true });
  });
});

test("没有召唤接线时，员工列表不带 summonKind / summoned", async () => {
  const actor = await person();
  const guard: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", {
      id: actor.id,
      email: `${actor.id}@example.test`,
      role: actor.role,
    });
    await runAsTenant(actor.id, next);
  };
  const response = await createAgentRoutes(profiles, guard).request(
    new Request("http://summon.test/"),
  );
  const rows = ((await response.json()) as { agents: object[] }).agents;
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect("summonKind" in row).toBe(false);
    expect("summoned" in row).toBe(false);
  }
});
