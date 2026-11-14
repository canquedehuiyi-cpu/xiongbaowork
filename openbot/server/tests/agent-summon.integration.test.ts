import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createAgentRoutes } from "../src/agents/routes";
import type { AuditEventInput, AuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import { createChannelStore } from "../src/channels/routes";
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
import {
  createPortraitStore,
  type PortraitPreset,
} from "../src/portraits/store";
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
const portraitStore = createPortraitStore(database);
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

function routesFor(actor: AgentActor) {
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
    {
      database,
      direct: (who, agentId) => channelStore.direct(who, agentId),
      portraits: portraitStore,
    },
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

/** The person's live coworkers (the 分身 included). */
function liveAgents(actor: AgentActor) {
  return runAsTenant(actor.id, () =>
    database
      .select({ id: agentProfiles.agentId })
      .from(agentProfiles)
      .where(
        and(
          eq(agentProfiles.ownerUserId, actor.id),
          isNull(agentProfiles.deletedAt),
        ),
      ),
  );
}

function memberships(actor: AgentActor) {
  return runAsTenant(actor.id, () =>
    database
      .select({ id: channelMemberships.channelId })
      .from(channelMemberships)
      .where(eq(channelMemberships.userId, actor.id)),
  );
}

function grantsOf(actor: AgentActor, agentId: string) {
  return runAsTenant(actor.id, () =>
    database
      .select({
        kind: pluginGrants.kind,
        ref: pluginGrants.ref,
        grantedBy: pluginGrants.grantedBy,
        grantedAs: pluginGrants.grantedAs,
      })
      .from(pluginGrants)
      .where(eq(pluginGrants.agentId, agentId)),
  );
}

describe("POST /api/agents/:agentId/summon", () => {
  test("召唤预设 → 本人名下一份新的私有员工，记着来源，created 为 true", async () => {
    const actor = await person();
    const source = await preset();
    const body = await summoned(actor, source);
    expect(body.agent.id).not.toBe(source);
    expect(body.agent.summonedFrom).toBe(source);
    expect(body.agent.visibility).toBe("private");
    expect(body.agent.mine).toBe(true);
    expect(body.created).toBe(true);
    expect(typeof body.channelId).toBe("string");
    // The 一对一 conversation is this person's, with the copy alone in it.
    const channel = await runAsTenant(actor.id, () =>
      channelStore.get(actor, body.channelId),
    );
    expect(channel?.agentIds).toEqual([body.agent.id]);
    // Recorded on the trail against the copy, naming the preset.
    const row = audit.find((event) => event.eventType === "bot.summoned");
    expect(row?.targetId).toBe(body.agent.id);
    expect(row?.payload).toMatchObject({ summonedFrom: source });
  });

  test("复制出的员工带着预设的技能授予（同样的 ref，授予人是本人），不带应用授予", async () => {
    // Requirement change from the controller (2026-11-14): a summoned expert keeps its skills.
    const actor = await person();
    const skills = [`${prefix}-persona-skill`, `${prefix}-other-skill`];
    const source = await preset({ skills, mcp: [`${prefix}-server/tool`] });
    const body = await summoned(actor, source);
    const grants = await grantsOf(actor, body.agent.id);
    expect(grants.map((grant) => grant.kind)).toEqual(["skill", "skill"]);
    expect(grants.map((grant) => grant.ref).sort()).toEqual([...skills].sort());
    for (const grant of grants) {
      expect(grant.grantedBy).toBe(actor.id);
      expect(grant.grantedAs).toBe("owner");
    }
    // Summoning again neither copies again nor grants twice.
    const again = await summoned(actor, source);
    expect(again.agent.id).toBe(body.agent.id);
    expect(await grantsOf(actor, body.agent.id)).toHaveLength(2);
  });

  test("本人名下有一行 portraits，preset 是预设的 presetPortrait", async () => {
    const actor = await person();
    const source = await preset({ portrait: "test-engineer" });
    const body = await summoned(actor, source);
    const face = await runAsTenant(actor.id, () =>
      portraitStore.get("coworker", body.agent.id),
    );
    expect(face?.preset).toBe("test-engineer");
    const [row] = await runAsTenant(actor.id, () =>
      database
        .select({ tenantId: portraits.tenantId })
        .from(portraits)
        .where(eq(portraits.subjectId, body.agent.id)),
    );
    expect(row?.tenantId).toBe(actor.id);
  });

  test("预设没有 presetPortrait 时不写 portraits", async () => {
    const actor = await person();
    const source = await preset({ portrait: null });
    const body = await summoned(actor, source);
    const face = await runAsTenant(actor.id, () =>
      portraitStore.get("coworker", body.agent.id),
    );
    expect(face).toBeNull();
  });

  test("再召唤一次 → 同一份员工、同一个会话，created 为 false", async () => {
    const actor = await person();
    const source = await preset();
    const first = await summoned(actor, source);
    const second = await summoned(actor, source);
    expect(second.agent.id).toBe(first.agent.id);
    expect(second.channelId).toBe(first.channelId);
    expect(second.created).toBe(false);
  });

  test("两个请求并发召唤同一预设 → 只有一份员工，两个响应 agent.id 相同", async () => {
    const actor = await person();
    const source = await preset({ skills: [`${prefix}-persona-skill`] });
    const [a, b] = await Promise.all([
      summoned(actor, source),
      summoned(actor, source),
    ]);
    expect(a.agent.id).toBe(b.agent.id);
    expect(a.channelId).toBe(b.channelId);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    const copies = await runAsTenant(actor.id, () =>
      database
        .select({ id: agentProfiles.agentId })
        .from(agentProfiles)
        .where(
          and(
            eq(agentProfiles.ownerUserId, actor.id),
            eq(agentProfiles.summonedFrom, source),
          ),
        ),
    );
    expect(copies).toHaveLength(1);
  }, 20000);

  test("召唤分身 → 就是分身本人，员工数不变，返回会话", async () => {
    const actor = await person();
    const before = await liveAgents(actor);
    const body = await summoned(actor, avatarAgentId(actor.id));
    expect(body.agent.id).toBe(avatarAgentId(actor.id));
    expect(body.created).toBe(false);
    expect(typeof body.channelId).toBe("string");
    expect(await liveAgents(actor)).toHaveLength(before.length);
  });

  test("召唤本人自己的员工 → 不复制，created 为 false", async () => {
    const actor = await person();
    const own = await privateAgent(actor);
    const before = await liveAgents(actor);
    const body = await summoned(actor, own);
    expect(body.agent.id).toBe(own);
    expect(body.created).toBe(false);
    expect(await liveAgents(actor)).toHaveLength(before.length);
  });

  test("召唤别人的私有员工 → 404，同 duplicate", async () => {
    const actor = await person();
    const other = await person();
    const theirs = await privateAgent(other);
    const response = await summon(actor, theirs);
    expect(response.status).toBe(404);
    const duplicate = await routesFor(actor).request(
      new Request(`http://summon.test/${theirs}/duplicate`, { method: "POST" }),
    );
    expect(await response.json()).toEqual(await duplicate.json());
    expect(await memberships(actor)).toHaveLength(0);
  });

  test("召唤看不到的 id → 404", async () => {
    const actor = await person();
    const response = await summon(actor, `${prefix}-nobody`);
    expect(response.status).toBe(404);
  });

  test("套餐名额已满 → 与 duplicate 相同的拒绝，员工数与会话数不变", async () => {
    const actor = await person();
    const source = await preset();
    const { limits } = await quota.planFor(actor.id);
    const seats = typeof limits.wakers === "number" ? limits.wakers : 0;
    expect(seats).toBeGreaterThan(0);
    for (let i = 0; i < seats; i++) await privateAgent(actor);
    const agentsBefore = await liveAgents(actor);
    const channelsBefore = await memberships(actor);

    const refused = await summon(actor, source);
    const duplicate = await routesFor(actor).request(
      new Request(`http://summon.test/${source}/duplicate`, { method: "POST" }),
    );
    expect(refused.status).toBe(duplicate.status);
    expect(refused.status).toBe(402);
    expect(await refused.json()).toEqual(await duplicate.json());
    expect(await liveAgents(actor)).toHaveLength(agentsBefore.length);
    expect(await memberships(actor)).toHaveLength(channelsBefore.length);
  });

  test("名额满了，已经召唤过的那份照样能进会话", async () => {
    const actor = await person();
    const source = await preset();
    const first = await summoned(actor, source);
    const { limits } = await quota.planFor(actor.id);
    const seats = typeof limits.wakers === "number" ? limits.wakers : 0;
    for (let i = 1; i < seats; i++) await privateAgent(actor);
    const again = await summoned(actor, source);
    expect(again.agent.id).toBe(first.agent.id);
    expect(again.created).toBe(false);
  });

  test("召唤后删掉那份员工，再召唤 → 新的一份，created 为 true", async () => {
    const actor = await person();
    const source = await preset();
    const first = await summoned(actor, source);
    await runAsTenant(actor.id, () =>
      profiles.softDelete(actor, first.agent.id),
    );
    const second = await summoned(actor, source);
    expect(second.agent.id).not.toBe(first.agent.id);
    expect(second.created).toBe(true);
    expect(second.agent.summonedFrom).toBe(source);
  });

  test("召唤后软删一对一会话，再召唤 → created 为 false，新的会话", async () => {
    const actor = await person();
    const source = await preset();
    const first = await summoned(actor, source);
    await runAsTenant(actor.id, () =>
      channelStore.softDelete(actor, first.channelId),
    );
    const second = await summoned(actor, source);
    expect(second.created).toBe(false);
    expect(second.agent.id).toBe(first.agent.id);
    expect(second.channelId).not.toBe(first.channelId);
    const live = await runAsTenant(actor.id, () =>
      database
        .select({ id: channels.id })
        .from(channels)
        .where(
          and(
            inArray(channels.id, [first.channelId, second.channelId]),
            isNull(channels.deletedAt),
          ),
        ),
    );
    expect(live.map((row) => row.id)).toEqual([second.channelId]);
  });
});
