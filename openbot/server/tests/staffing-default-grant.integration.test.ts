import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, like } from "drizzle-orm";
import { STAFFING_TOOL_NAMES } from "../../shared/staffing-proposal";
import { createAgentProfileStore } from "../src/agents/profile-store";
import { createApprovalService } from "../src/approvals/service";
import { createApprovalStore } from "../src/approvals/store";
import { createAuditStore } from "../src/audit";
import type {
  CredentialSecretReader,
  CredentialStore,
} from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  enterpriseSettings,
  mcpServers,
  pluginGrants,
  subscriptions,
  users,
} from "../src/db/schema";
import { setEdition } from "../src/edition";
import {
  personalDefaultsDeps,
  personalGrantsLeftInTeam,
  personalRevokeRefusal,
  withPersonalDefaults,
} from "../src/plugins/personal-defaults";
import { createPluginStore } from "../src/plugins/store";
import {
  backfillStaffingForAvatars,
  ensureStaffingServer,
  STAFFING_DEFAULT_BY,
  staffingBackfillDeps,
  withStaffingDefault,
} from "../src/staffing/default-grant";
import { runAsTenant } from "../src/tenant/context";
import { avatarAgentId, provisionTenant } from "../src/tenant/provisioning";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * 小管家默认会招人、组群：新开通时就有，升级时补一次，别的员工没有，本人关掉的一直关着。
 * 每一条都看库里留下的授予行。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const plugins = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: {
    readSecret: async () => null,
  } as unknown as CredentialSecretReader & CredentialStore,
  encryptionKey: "x".repeat(44),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
});
const approvals = createApprovalService(
  createApprovalStore(database),
  undefined,
  undefined,
  { settlement: "database" },
);
const profiles = createAgentProfileStore(database, undefined);

const people: string[] = [];
const asPlatform = <T>(work: () => Promise<T>) => runAsTenant("platform", work);

/** 一个只有账号、还没开通的人。 */
async function newcomer(name: string): Promise<string> {
  const userId = `sdg-${suite}-${name}`;
  await runAsTenant(userId, async () => {
    await database
      .insert(users)
      .values({ id: userId, email: `${userId}@example.test`, name });
    await database
      .insert(subscriptions)
      .values({ tenantId: userId, planId: "pro" });
  });
  people.push(userId);
  return userId;
}

const staffingRows = (agentId: string) =>
  asPlatform(() =>
    database
      .select({ ref: pluginGrants.ref, by: pluginGrants.grantedBy })
      .from(pluginGrants)
      .where(
        and(
          eq(pluginGrants.agentId, agentId),
          like(pluginGrants.ref, "staffing/%"),
        ),
      ),
  );

/** 补授，在这个人自己的帧里，带上真正的禁用判断。 */
const backfill = (userId: string) =>
  runAsTenant(userId, () =>
    backfillStaffingForAvatars(
      staffingBackfillDeps(database, {
        store: plugins,
        disabled: (avatarId) => approvals.disabledTools(userId, avatarId),
      }),
    ),
  );

/** 升级前开通的分身：有分身、没有招人的授予。 */
async function upgradedPerson(name: string): Promise<string> {
  const userId = await newcomer(name);
  await provisionTenant(database, {
    id: userId,
    email: `${userId}@example.test`,
  });
  await asPlatform(() =>
    database
      .delete(pluginGrants)
      .where(eq(pluginGrants.agentId, avatarAgentId(userId))),
  );
  return userId;
}

/** 默认授予只在部署里有「招聘与组群」这个应用时做：先走一遍启动那一步，没有就添加（见下面的 `startupStep`）。 */
beforeAll(async () => {
  await startupStep();
});

describe("小管家默认会招人组群", () => {
  test("a new person's avatar can propose employees", async () => {
    const userId = await newcomer("fresh");
    await provisionTenant(
      database,
      {
        id: userId,
        email: `${userId}@example.test`,
      },
      { withStaffing: true },
    );
    const avatarId = avatarAgentId(userId);
    const rows = await staffingRows(avatarId);
    expect(rows.map((row) => row.ref).sort()).toEqual(
      STAFFING_TOOL_NAMES.map((tool) => `staffing/${tool}`).sort(),
    );
    expect(rows.map((row) => row.by)).toEqual(
      STAFFING_TOOL_NAMES.map(() => STAFFING_DEFAULT_BY),
    );
    const decision = await runAsTenant(userId, () =>
      plugins.decide("mcp", "staffing/propose_employee", avatarId),
    );
    expect(decision.allowed).toBe(true);
    // 再开通一次（每次登录都会）不多出行，也不把收回的补回来。
    await asPlatform(() =>
      database.delete(pluginGrants).where(eq(pluginGrants.agentId, avatarId)),
    );
    await provisionTenant(
      database,
      {
        id: userId,
        email: `${userId}@example.test`,
      },
      { withStaffing: true },
    );
    expect(await staffingRows(avatarId)).toEqual([]);
  });

  test("an upgraded avatar gets the tools once", async () => {
    const userId = await upgradedPerson("upgraded");
    expect(await staffingRows(avatarAgentId(userId))).toEqual([]);
    expect(await backfill(userId)).toBe(1);
    const first = await staffingRows(avatarAgentId(userId));
    expect(first).toHaveLength(STAFFING_TOOL_NAMES.length);
    expect(await backfill(userId)).toBe(0);
    expect(await staffingRows(avatarAgentId(userId))).toHaveLength(
      first.length,
    );
  });

  test("a bot other than the avatar is not granted", async () => {
    const userId = await upgradedPerson("others");
    const hired = await runAsTenant(userId, () =>
      profiles.create(
        { id: userId, role: "user" },
        {
          name: "小红",
          title: "员工",
          roleDescription: "回答问题。",
          visibility: "private",
          systemPrompt: "回答问题。",
        },
      ),
    );
    await backfill(userId);
    expect(await staffingRows(hired.id)).toEqual([]);
    expect(await staffingRows(avatarAgentId(userId))).toHaveLength(
      STAFFING_TOOL_NAMES.length,
    );
  });

  test("an avatar whose owner switched staffing off stays off", async () => {
    const userId = await upgradedPerson("off");
    const avatarId = avatarAgentId(userId);
    await runAsTenant(userId, () =>
      approvals.createRule(userId, {
        botId: avatarId,
        toolRef: "staffing/*",
        effect: "*",
        scope: "*",
        behaviour: "deny",
      }),
    );
    expect(await backfill(userId)).toBe(0);
    expect(await staffingRows(avatarId)).toEqual([]);
    const disabled = await runAsTenant(userId, () =>
      approvals.disabledTools(userId, avatarId),
    );
    expect(disabled("staffing/propose_employee")).toBe(true);
  });
});

const OPEN_APP = `team:staffing`;
let addedServer = false;

/** 启动时那一步：没有「招聘与组群」这个应用就添加。 */
async function startupStep() {
  const had = await asPlatform(() => plugins.serverAddress("staffing"));
  await asPlatform(() => ensureStaffingServer(plugins));
  if (!had) addedServer = true;
}

afterEach(() => setEdition("team"));

/** 一位登记在这个人名下的普通员工（内置、非分身）。 */
async function hire(userId: string, name: string): Promise<string> {
  const id = `sdg-${suite}-${name}`;
  await asPlatform(async () => {
    await database.insert(agents).values({
      id,
      tenantId: userId,
      name,
      type: "built_in",
      configuration: {},
    });
    await database.insert(agentProfiles).values({
      agentId: id,
      tenantId: userId,
      ownerUserId: userId,
      title: name,
      roleDescription: "测试员工",
      avatarSeed: name,
      visibility: "private",
    });
  });
  return id;
}

const toolsOf = async (store: typeof plugins, userId: string, bot: string) =>
  (await runAsTenant(userId, () => store.listForAgent(bot))).tools.map(
    (tool) => tool.ref,
  );

describe("the grant reaches the avatar's run", () => {
  test("after the startup step the avatar is offered the staffing tools", async () => {
    await startupStep();
    const userId = await newcomer("offered");
    await provisionTenant(
      database,
      { id: userId, email: `${userId}@example.test` },
      { withStaffing: true },
    );
    expect(await toolsOf(plugins, userId, avatarAgentId(userId))).toContain(
      "staffing/propose_employee",
    );
  });

  test("the owner's revoke is not undone: grant, revoke all, backfill again, still none", async () => {
    const userId = await upgradedPerson("once");
    const avatarId = avatarAgentId(userId);
    expect(await backfill(userId)).toBe(1);
    for (const row of await staffingRows(avatarId))
      await runAsTenant(userId, () =>
        plugins.revoke("mcp", row.ref, avatarId, userId),
      );
    expect(await staffingRows(avatarId)).toEqual([]);
    expect(await backfill(userId)).toBe(0);
    expect(await staffingRows(avatarId)).toEqual([]);
  });

  test("a revoke after provisioning is not undone either", async () => {
    const userId = await newcomer("provisioned-once");
    await provisionTenant(
      database,
      { id: userId, email: `${userId}@example.test` },
      { withStaffing: true },
    );
    await asPlatform(() =>
      database
        .delete(pluginGrants)
        .where(eq(pluginGrants.agentId, avatarAgentId(userId))),
    );
    expect(await backfill(userId)).toBe(0);
    expect(await staffingRows(avatarAgentId(userId))).toEqual([]);
  });

  test("in the team edition an existing avatar gets the tools on its first read, once", async () => {
    await startupStep();
    setEdition("team");
    const userId = await upgradedPerson("lazy-team");
    const avatarId = avatarAgentId(userId);
    const store = withStaffingDefault(
      createPluginStore({
        database,
        auditStore: createAuditStore(database),
        credentials: {
          readSecret: async () => null,
        } as unknown as CredentialSecretReader & CredentialStore,
        encryptionKey: "x".repeat(44),
        policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
      }),
      {
        database,
        disabled: (id) => approvals.disabledTools(userId, id),
      },
    );
    expect(await toolsOf(store, userId, avatarId)).toContain(
      "staffing/propose_employee",
    );
    for (const row of await staffingRows(avatarId))
      await runAsTenant(userId, () =>
        store.revoke("mcp", row.ref, avatarId, userId),
      );
    expect(await toolsOf(store, userId, avatarId)).not.toContain(
      "staffing/propose_employee",
    );
  });

  test("in the team edition the avatar's default grant is not reported as a leftover personal grant", async () => {
    setEdition("team");
    // 先清掉本文件前面几条留下的默认授予，让「之前」只剩别的测试可能留下的。
    await asPlatform(() =>
      database
        .delete(pluginGrants)
        .where(inArray(pluginGrants.agentId, people.map(avatarAgentId))),
    );
    const leftBefore = await asPlatform(() =>
      personalGrantsLeftInTeam(database),
    );
    const userId = await newcomer("not-leftover");
    await provisionTenant(
      database,
      { id: userId, email: `${userId}@example.test` },
      { withStaffing: true },
    );
    expect(await staffingRows(avatarAgentId(userId))).toHaveLength(
      STAFFING_TOOL_NAMES.length,
    );
    // 别的测试可能在共用的库里留着别的 openbot: 授予，所以比较的是有它之前与之后：它不改变答案。
    expect(await asPlatform(() => personalGrantsLeftInTeam(database))).toBe(
      leftBefore,
    );
  });

  test("in the personal edition an ordinary employee is not handed staffing, and the owner can switch it per employee", async () => {
    await startupStep();
    setEdition("personal");
    const userId = await upgradedPerson("per-bot");
    const helper = await hire(userId, "per-bot-helper");
    const real = personalDefaultsDeps(database, userId);
    const store = withPersonalDefaults(
      createPluginStore({
        database,
        auditStore: createAuditStore(database),
        credentials: {
          readSecret: async () => null,
        } as unknown as CredentialSecretReader & CredentialStore,
        encryptionKey: "x".repeat(44),
        policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
      }),
      {
        ...real,
        bots: async () => (await real.bots()).filter((id) => id === helper),
      },
    );
    expect(await toolsOf(store, userId, helper)).not.toContain(
      "staffing/propose_employee",
    );
    expect(await staffingRows(helper)).toEqual([]);
    expect(
      personalRevokeRefusal("mcp", "staffing/propose_employee", {
        id: helper,
        type: "built_in",
      }),
    ).toBeNull();
    await runAsTenant(userId, () =>
      store.grant("mcp", "staffing/propose_employee", helper, userId),
    );
    expect(await toolsOf(store, userId, helper)).toContain(
      "staffing/propose_employee",
    );
    await runAsTenant(userId, () =>
      store.revoke("mcp", "staffing/propose_employee", helper, userId),
    );
    expect(await toolsOf(store, userId, helper)).not.toContain(
      "staffing/propose_employee",
    );
  });
});

afterAll(async () => {
  await asPlatform(async () => {
    const avatars = people.map(avatarAgentId);
    const owned = (
      await database
        .select({ id: agentProfiles.agentId })
        .from(agentProfiles)
        .where(inArray(agentProfiles.ownerUserId, people))
    ).map((row) => row.id);
    const ids = [...new Set([...avatars, ...owned])];
    await database
      .delete(pluginGrants)
      .where(inArray(pluginGrants.agentId, ids));
    await database.delete(enterpriseSettings).where(
      inArray(
        enterpriseSettings.key,
        avatars.map((id) => `staffing_default_given:${id}`),
      ),
    );
    if (addedServer)
      await database.delete(mcpServers).where(eq(mcpServers.id, OPEN_APP));
    await database
      .delete(agentProfiles)
      .where(inArray(agentProfiles.agentId, ids));
    await database.delete(agents).where(inArray(agents.id, ids));
    await database
      .delete(subscriptions)
      .where(inArray(subscriptions.tenantId, people));
    await database.delete(users).where(inArray(users.id, people));
  });
});

// Last-registered, so it runs after the cleanup above has used the pool.
afterAll(async () => {
  await database.$client.close();
});
