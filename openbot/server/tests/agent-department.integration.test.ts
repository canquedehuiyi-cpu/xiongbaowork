import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createAgentRoutes } from "../src/agents/routes";
import type { AuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import { createChannelStore } from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channels,
  deploymentPackages,
  intelligenceChannelMappings,
  pluginGrants,
  portraits,
  subscriptions,
  users,
} from "../src/db/schema";
import { runAsTenant } from "../src/tenant/context";
import { provisionTenant } from "../src/tenant/provisioning";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * 员工部门（聊天工作台 Task 6）：预设的部门随召唤复制到副本；此前召唤、没有部门的副本读到来源预设的部门；
 * 主人可以改，别人改不了；手工建的员工没有部门。
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
const auditStore: AuditStore = {
  async insert() {},
};

const prefix = `department-${randomUUID()}`;
const tenants: string[] = [];
const presetIds: string[] = [];
const packageIds: string[] = [];

afterEach(async () => {
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
      .values({ id, email: `${id}@example.test`, name: "Department Test" }),
  );
  await provisionTenant(database, { id, email: `${id}@example.test` });
  return { id, role: "user" };
}

/** A shared preset as package sync leaves it, in the given department. */
async function preset(department: string | null) {
  const [pkg] = await runAsTenant("platform", () =>
    database
      .insert(deploymentPackages)
      .values({
        tenantId: `${prefix}-package-tenant`,
        sourcePath: "/packages/department-test",
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
      name: "后端工程师",
      type: "built_in",
      configuration: { systemPrompt: "你是后端工程师。" },
      packageId: pkg.id,
    });
    await database.insert(agentProfiles).values({
      agentId: id,
      ownerUserId: null,
      title: "后端工程师",
      roleDescription: "写实现、跑测试。",
      avatarSeed: id,
      visibility: "public",
      department,
    });
  });
  return id;
}

/** Somebody's own coworker, made by hand: no department. */
async function handMade(owner: AgentActor) {
  const id = `${prefix}-private-${randomUUID()}`;
  await runAsTenant(owner.id, async () => {
    await database.insert(agents).values({
      id,
      name: "手工员工",
      type: "built_in",
      configuration: { systemPrompt: "手工。" },
    });
    await database.insert(agentProfiles).values({
      agentId: id,
      ownerUserId: owner.id,
      title: "手工员工",
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
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      database,
      direct: (who, agentId) => channelStore.direct(who, agentId),
    },
  );
}

type AgentBody = {
  agent: {
    id: string;
    department: string | null;
    summonedFrom: string | null;
  };
};

async function summonedCopy(actor: AgentActor, presetId: string) {
  const response = await routesFor(actor).request(
    new Request(
      `http://department.test/${encodeURIComponent(presetId)}/summon`,
      {
        method: "POST",
      },
    ),
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as AgentBody).agent;
}

async function read(actor: AgentActor, agentId: string) {
  const response = await routesFor(actor).request(
    new Request(`http://department.test/${encodeURIComponent(agentId)}`),
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as AgentBody).agent;
}

function patch(actor: AgentActor, agentId: string, body: unknown) {
  return routesFor(actor).request(
    new Request(`http://department.test/${encodeURIComponent(agentId)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
  );
}

/** What is stored on the coworker's own row, not what the DTO falls back to. */
async function storedDepartment(actor: AgentActor, agentId: string) {
  const rows = await runAsTenant(actor.id, () =>
    database
      .select({ department: agentProfiles.department })
      .from(agentProfiles)
      .where(eq(agentProfiles.agentId, agentId)),
  );
  expect(rows).toHaveLength(1);
  return rows[0]?.department;
}

/** The roster entry for one coworker, as `GET /api/agents` lists it. */
async function listed(actor: AgentActor, agentId: string) {
  const response = await routesFor(actor).request(
    new Request("http://department.test/"),
  );
  expect(response.status).toBe(200);
  const { agents: roster } = (await response.json()) as {
    agents: AgentBody["agent"][];
  };
  const entry = roster.find((candidate) => candidate.id === agentId);
  if (!entry) throw new Error(`${agentId} is not on the roster`);
  return entry;
}

/** What the preset's own row holds, read where package sync writes it. */
async function presetDepartment(presetId: string) {
  const rows = await runAsTenant("system", () =>
    database
      .select({ department: agentProfiles.department })
      .from(agentProfiles)
      .where(eq(agentProfiles.agentId, presetId)),
  );
  expect(rows).toHaveLength(1);
  return rows[0]?.department;
}

const editBody = (department: unknown, visibility = "private") => ({
  name: "后端工程师",
  title: "后端工程师",
  roleDescription: "写实现、跑测试。",
  visibility,
  department,
});

describe("员工部门", () => {
  test("召唤副本带上预设的部门：写在副本自己的行上，DTO 也是这个部门", async () => {
    const actor = await person();
    const source = await preset("研发部");
    const copy = await summonedCopy(actor, source);
    expect(copy.summonedFrom).toBe(source);
    expect(copy.department).toBe("研发部");
    expect(await storedDepartment(actor, copy.id)).toBe("研发部");
  });

  test("副本自己没有部门时，DTO 回退到来源预设的部门（读时回退，不改数据）", async () => {
    const actor = await person();
    const source = await preset("测试部");
    const copy = await summonedCopy(actor, source);
    // A copy summoned before the column existed carries none of its own.
    await runAsTenant(actor.id, () =>
      database
        .update(agentProfiles)
        .set({ department: null })
        .where(eq(agentProfiles.agentId, copy.id)),
    );
    expect(await storedDepartment(actor, copy.id)).toBeNull();
    expect((await read(actor, copy.id)).department).toBe("测试部");
    // The roster reads it the same way.
    expect((await listed(actor, copy.id)).department).toBe("测试部");
  });

  test("主人清空召唤副本的部门 → 「未分组」：单个读取和列表都是 null，不回退到预设；预设自己的部门不变", async () => {
    const actor = await person();
    const source = await preset("设计部");
    const copy = await summonedCopy(actor, source);
    expect(copy.department).toBe("设计部");

    const cleared = await patch(actor, copy.id, editBody(""));
    expect(cleared.status).toBe(200);
    expect(((await cleared.json()) as AgentBody).agent.department).toBeNull();
    // Kept as an explicit clear, not NULL, which is what stops the fallback.
    expect(await storedDepartment(actor, copy.id)).toBe("");
    expect((await read(actor, copy.id)).department).toBeNull();
    expect((await listed(actor, copy.id)).department).toBeNull();
    // A null in the body clears it the same way.
    expect((await patch(actor, copy.id, editBody("运营部"))).status).toBe(200);
    expect((await patch(actor, copy.id, editBody(null))).status).toBe(200);
    expect((await read(actor, copy.id)).department).toBeNull();

    expect(await presetDepartment(source)).toBe("设计部");
  });

  test("手工建的员工没有部门，DTO 为 null", async () => {
    const actor = await person();
    const id = await handMade(actor);
    expect((await read(actor, id)).department).toBeNull();
  });

  test("主人可以改部门、清空部门；超过 32 个字被拒", async () => {
    const actor = await person();
    const id = await handMade(actor);

    const saved = await patch(actor, id, editBody("  市场部 "));
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as AgentBody).agent.department).toBe("市场部");
    expect(await storedDepartment(actor, id)).toBe("市场部");

    // An edit that never showed the department leaves it alone.
    const { department: _absent, ...withoutDepartment } = editBody(null);
    expect((await patch(actor, id, withoutDepartment)).status).toBe(200);
    expect(await storedDepartment(actor, id)).toBe("市场部");

    const tooLong = await patch(actor, id, editBody("部".repeat(33)));
    expect(tooLong.status).toBe(400);
    expect(await storedDepartment(actor, id)).toBe("市场部");

    const cleared = await patch(actor, id, editBody(""));
    expect(cleared.status).toBe(200);
    expect(((await cleared.json()) as AgentBody).agent.department).toBeNull();
    // An explicit clear is stored as "" (未分组), never NULL ("never written").
    expect(await storedDepartment(actor, id)).toBe("");
  });

  test("不是主人改不了部门：别人能看到的公开员工，改部门得到 403，部门不变", async () => {
    const owner = await person();
    const other = await person();
    const id = await handMade(owner);
    // Published by its owner, so the other person can see it and is refused as not its manager.
    const published = await patch(owner, id, editBody("研发部", "public"));
    expect(published.status).toBe(200);

    const refused = await patch(other, id, editBody("行政部", "public"));
    expect(refused.status).toBe(403);
    expect((await read(owner, id)).department).toBe("研发部");
  });
});
