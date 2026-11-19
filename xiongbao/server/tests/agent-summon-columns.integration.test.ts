import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createDatabase } from "../src/db/client";
import { agentProfiles, agents, users } from "../src/db/schema";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const prefix = `summon-cols-${randomUUID()}`;
const userIds: string[] = [];
const agentIds: string[] = [];

afterEach(async () => {
  await runAsTenant("platform", async () => {
    for (const id of agentIds.splice(0)) {
      await database.delete(agents).where(eq(agents.id, id));
    }
    for (const id of userIds.splice(0)) {
      await database.delete(users).where(eq(users.id, id));
    }
  });
});
afterAll(async () => {
  await database.$client.close();
});

async function makeOwner(): Promise<AgentActor> {
  const id = `${prefix}-user-${randomUUID()}`;
  await runAsTenant(id, () =>
    database
      .insert(users)
      .values({ id, email: `${id}@example.test`, name: "Summon Test" }),
  );
  userIds.push(id);
  return { id, role: "user" };
}

/** 召唤的来源：一个已有的 agents 行（summoned_from 引用 agents.id）。 */
async function makeSource(): Promise<string> {
  const id = `${prefix}-source-${randomUUID()}`;
  await runAsTenant("platform", () =>
    database.insert(agents).values({
      id,
      name: id,
      type: "remote_ag_ui",
      configuration: { endpoint: "https://seed.example.test/ag-ui" },
    }),
  );
  agentIds.push(id);
  return id;
}

async function makeAgent(owner: AgentActor, extra: Record<string, unknown>) {
  const agentId = `${prefix}-agent-${randomUUID()}`;
  await runAsTenant(owner.id, async () => {
    await database.insert(agents).values({
      id: agentId,
      name: agentId,
      type: "remote_ag_ui",
      configuration: { endpoint: "https://seed.example.test/ag-ui" },
    });
    agentIds.push(agentId);
    await database.insert(agentProfiles).values({
      agentId,
      ownerUserId: owner.id,
      title: "t",
      roleDescription: "r",
      avatarSeed: agentId,
      visibility: "private",
      ...extra,
    });
  });
  return agentId;
}

describe("agent_profiles summon columns", () => {
  test("同一主人对同一预设插两行未删除资料，第二行违反唯一约束", async () => {
    const owner = await makeOwner();
    const source = await makeSource();
    await makeAgent(owner, { summonedFrom: source });
    let code: string | undefined;
    try {
      await makeAgent(owner, { summonedFrom: source });
    } catch (error) {
      // Bun's driver reports the SQLSTATE as `errno`; Drizzle wraps it in `cause`.
      const e = error as { errno?: string; cause?: { errno?: string } };
      code = e.cause?.errno ?? e.errno;
    }
    expect(code).toBe("23505");
  });

  test("第一行 deleted_at 置值后，再插一行成功", async () => {
    const owner = await makeOwner();
    const source = await makeSource();
    const first = await makeAgent(owner, { summonedFrom: source });
    await runAsTenant(owner.id, () =>
      database
        .update(agentProfiles)
        .set({ deletedAt: sql`now()` })
        .where(eq(agentProfiles.agentId, first)),
    );
    const second = await makeAgent(owner, { summonedFrom: source });
    expect(second).not.toBe(first);
  });

  test("资料读取带出 presetPortrait 与 summonedFrom", async () => {
    const owner = await makeOwner();
    const source = await makeSource();
    const id = await makeAgent(owner, {
      summonedFrom: source,
      presetPortrait: "test-engineer",
    });
    const profile = await runAsTenant(owner.id, () => store.get(owner, id));
    expect(profile?.presetPortrait).toBe("test-engineer");
    expect(profile?.summonedFrom).toBe(source);
    const plain = await makeAgent(owner, {});
    const other = await runAsTenant(owner.id, () => store.get(owner, plain));
    expect(other?.presetPortrait).toBeNull();
    expect(other?.summonedFrom).toBeNull();
  });
});
