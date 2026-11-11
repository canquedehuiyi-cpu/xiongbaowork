import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, eq, inArray } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  auditEvents,
  composioConnections,
  mcpServers,
  mcpTools,
  pluginGrants,
  revokedAccess,
  teamBotPublications,
  users,
} from "../src/db/schema";
import { sharedUseApprovals } from "../src/db/schema/shared-use";
import type { ComposioBroker } from "../src/plugins/broker";
import {
  ownerGrantRefusal,
  ownerStillGives,
} from "../src/plugins/owner-grants";
import {
  createSharedAudience,
  createSharedUseStore,
} from "../src/plugins/shared-use-store";
import { createPluginStore, PluginRefusedError } from "../src/plugins/store";
import { createTeamBots } from "../src/team-bots/team-bots";
import { asPlatform, runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { bindTestRoleWriter } from "./support/role-writer";

/**
 * 主人授权的收紧：自助安装记成主人的授予、主人的标记不会被自助安装改回管理员；升级前已有的应用回填为
 * 只有管理员能给；切换账号模式时「谁可以给员工」回到默认，由管理员在新模式下重新决定；读不到员工资料时
 * 主人的授予不设受众；主人离开或被关掉 `ownerApps` 之后，主人设下的受众和主人做的授予在调用时失效。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const id = (name: string) => `ogh-${suite}-${name}`;
const OWNER = id("owner");
const TEAMMATE = id("teammate");
const ADMIN = id("admin");
const people = [OWNER, TEAMMATE, ADMIN];
const BOT = id("bot");
const TEAM_BOT = id("team-bot");
const GONE_BOT = id("gone-bot");
const bots = [BOT, TEAM_BOT, GONE_BOT];
const slug = suite.replace(/-/g, "_");
const MAIL = `ogh_mail_${slug}`;
const DESK = `ogh_desk_${slug}`;
const apps = [MAIL, DESK];
let releaseRoleWriter: (() => Promise<void>) | undefined;

const audit = createAuditStore(database);
const sharedStore = createSharedUseStore(database);
const audience = createSharedAudience(database, sharedStore, audit);
const reached: string[] = [];
const plugins = createPluginStore({
  database,
  auditStore: audit,
  credentials: { readSecret: async () => null } as never,
  encryptionKey: "x".repeat(44),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  broker: { isConnected: async () => true } as unknown as ComposioBroker,
  callVendor: async (connection) => {
    reached.push(connection.actorId ?? "");
    return { text: "ok", isError: false };
  },
  sharedUse: audience.gate,
  sharedAdmits: audience.admitsPerson,
});

const grantRow = async (botId: string, ref: string) =>
  (
    await asPlatform(() =>
      database
        .select({
          grantedAs: pluginGrants.grantedAs,
          grantedBy: pluginGrants.grantedBy,
        })
        .from(pluginGrants)
        .where(and(eq(pluginGrants.agentId, botId), eq(pluginGrants.ref, ref))),
    )
  )[0];

const sharedColumns = {
  accountMode: "shared",
  sharedVendorUserId: `openbot-deployment:${suite}:R`,
  sharedConnectedAt: new Date(),
  sharedConnectedBy: ADMIN,
  sharedVerified: true,
} as const;

beforeAll(async () => {
  releaseRoleWriter = await bindTestRoleWriter(database);
  await asPlatform(async () => {
    await database
      .insert(users)
      .values(
        people.map((person) => ({ id: person, email: `${person}@x.test` })),
      );
    for (const app of apps)
      await database.insert(mcpServers).values({
        id: app,
        tenantId: "team",
        title: app,
        vendor: "Composio",
        url: `composio://${app}`,
        provenance: "composio",
        authScheme: "OAUTH2",
        ...(app === DESK ? { ...sharedColumns, ownerGrants: "any" } : {}),
      });
    for (const app of apps)
      await database.insert(mcpTools).values({
        serverId: app,
        tenantId: "team",
        name: "LIST",
        description: "Lists.",
        effect: "read",
        version: "20260903_00",
      });
    for (const [bot, tenant] of [
      [BOT, OWNER],
      [TEAM_BOT, "team"],
      [GONE_BOT, OWNER],
    ] as const) {
      await database.insert(agents).values({
        id: bot,
        tenantId: tenant,
        name: bot,
        type: "built_in",
        configuration: {},
      });
      await database.insert(agentProfiles).values({
        agentId: bot,
        tenantId: tenant,
        ownerUserId: OWNER,
        title: bot,
        roleDescription: "测试员工",
        avatarSeed: bot,
        visibility: "private",
        ...(bot === GONE_BOT ? { deletedAt: new Date() } : {}),
      });
    }
    await database.insert(teamBotPublications).values({
      agentId: TEAM_BOT,
      tenantId: "team",
      publishedBy: OWNER,
      audience: "team",
    });
  });
  for (const person of [OWNER, TEAMMATE])
    await runAsTenant(person, () =>
      database
        .insert(composioConnections)
        .values({ toolkit: MAIL, userId: person, verified: true }),
    );
});

beforeEach(async () => {
  reached.length = 0;
  await asPlatform(async () => {
    await database
      .delete(pluginGrants)
      .where(inArray(pluginGrants.agentId, bots));
    await database
      .delete(sharedUseApprovals)
      .where(inArray(sharedUseApprovals.agentId, bots));
    await database
      .delete(revokedAccess)
      .where(eq(revokedAccess.email, `${OWNER}@x.test`));
    await database
      .update(mcpServers)
      .set({ ...sharedColumns, ownerGrants: "any" })
      .where(eq(mcpServers.id, DESK));
  });
});

afterAll(async () => {
  await asPlatform(async () => {
    await database
      .delete(composioConnections)
      .where(inArray(composioConnections.toolkit, apps));
    await database.delete(agents).where(inArray(agents.id, bots));
    await database.delete(mcpServers).where(inArray(mcpServers.id, apps));
    await database.delete(users).where(inArray(users.id, people));
  });
  await releaseRoleWriter?.();
  await database.$client.close();
});

describe("an owner's self-service install is the owner's grant", () => {
  const ref = `${MAIL}/LIST`;

  test("it is recorded as the owner's", async () => {
    await runAsTenant(OWNER, () =>
      plugins.grant("mcp", ref, TEAM_BOT, `${OWNER}@x.test`, {
        selfService: true,
      }),
    );
    expect((await grantRow(TEAM_BOT, ref))?.grantedAs).toBe("owner");
  });

  test("installing again after giving it does not turn the owner's mark into an admin's", async () => {
    await runAsTenant(OWNER, () =>
      plugins.grant("mcp", ref, TEAM_BOT, `${OWNER}@x.test`, { as: "owner" }),
    );
    await runAsTenant(OWNER, () =>
      plugins.grant("mcp", ref, TEAM_BOT, `${OWNER}@x.test`, {
        selfService: true,
      }),
    );
    expect((await grantRow(TEAM_BOT, ref))?.grantedAs).toBe("owner");
  });

  test("a teammate's call on it never goes out on the owner's account, even where the owner's connection is seen", async () => {
    await runAsTenant(OWNER, () =>
      plugins.grant("mcp", ref, TEAM_BOT, `${OWNER}@x.test`, {
        selfService: true,
      }),
    );
    const teamBots = createTeamBots({
      database,
      // 读得到主人连接的帧：主人连着它。
      connectedServers: async (userId) =>
        new Set(userId === OWNER ? [MAIL] : []),
    });
    expect(
      await runAsTenant(TEAMMATE, () =>
        teamBots.credentialActorFor(TEAMMATE, TEAM_BOT)(ref),
      ),
    ).toBe(TEAMMATE);
  });
});

describe("upgrading keeps who may give an app what it was", () => {
  test("0197 sets every app already added to admin-only", () => {
    const migration = readFileSync(
      new URL(
        "../recovery/recovery-20261018-v1/sql/0197_owner_app_grants.sql",
        import.meta.url,
      ),
      "utf8",
    );
    expect(migration).toMatch(
      /UPDATE "public"\."mcp_servers" SET "owner_grants" = 'admin' WHERE "owner_grants" IS NULL/,
    );
  });
});

describe("switching the account mode", () => {
  test("sets who may give the app to admin-only, so an owner cannot open the team account with an old choice", async () => {
    await asPlatform(() =>
      database
        .update(mcpServers)
        .set({ ownerGrants: "any" })
        .where(eq(mcpServers.id, MAIL)),
    );
    await asPlatform(() =>
      plugins.setAccountModeColumns(
        MAIL,
        "shared",
        `openbot-deployment:${suite}:M`,
      ),
    );
    const [row] = await asPlatform(() =>
      database
        .select({ ownerGrants: mcpServers.ownerGrants })
        .from(mcpServers)
        .where(eq(mcpServers.id, MAIL)),
    );
    expect(row?.ownerGrants).toBe("admin");
    // 只有管理员能给，主人的授予设不下受众。
    await runAsTenant(OWNER, () =>
      plugins.grant("mcp", `${MAIL}/LIST`, TEAM_BOT, OWNER, { as: "owner" }),
    );
    expect(
      await runAsTenant(OWNER, () =>
        sharedStore.approveOwnerGrant({
          botId: TEAM_BOT,
          serverId: MAIL,
          by: OWNER,
        }),
      ),
    ).toBeNull();
    const trail = await asPlatform(() =>
      database
        .select({ payload: auditEvents.payload })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.eventType, "configuration.changed"),
            eq(auditEvents.targetId, MAIL),
          ),
        ),
    );
    expect(trail.map((entry) => entry.payload)).toContainEqual(
      expect.objectContaining({
        change: "owner_grants_changed",
        from: "any",
        to: "admin",
        reason: "account_mode_switched",
      }),
    );
    await asPlatform(() =>
      plugins.setAccountModeColumns(MAIL, "personal", null),
    );
  });

  test("a Personal app set to admin-only stays so through Personal → Shared → Personal, and each switch is in the trail", async () => {
    // 升级回填后的状态：只有管理员能给。
    await asPlatform(() =>
      database
        .update(mcpServers)
        .set({ ownerGrants: "admin" })
        .where(eq(mcpServers.id, MAIL)),
    );
    const before = new Date();
    await asPlatform(() =>
      plugins.setAccountModeColumns(
        MAIL,
        "shared",
        `openbot-deployment:${suite}:M`,
      ),
    );
    await asPlatform(() =>
      database
        .update(mcpServers)
        .set({ ownerGrants: null })
        .where(eq(mcpServers.id, MAIL)),
    );
    await asPlatform(() =>
      plugins.setAccountModeColumns(MAIL, "personal", null),
    );
    expect(
      await runAsTenant(OWNER, () => plugins.ownerGrantsSetting(MAIL)),
    ).toEqual({ ownerGrants: "admin", chosen: "admin" });
    // 主人对它「给」被拒，和 `/give` 同一个判断。
    const inspected = await runAsTenant(OWNER, () =>
      plugins.inspectApp({
        app: MAIL,
        agentId: BOT,
        userId: OWNER,
        composioConfigured: true,
      }),
    );
    expect(inspected).not.toBeNull();
    expect(
      await runAsTenant(OWNER, () =>
        ownerGrantRefusal(plugins, OWNER, BOT, inspected as never),
      ),
    ).toContain("只有管理员");
    // 第二次切换时原值是 NULL，也写下回到只有管理员。
    const trail = await asPlatform(() =>
      database
        .select({ payload: auditEvents.payload, at: auditEvents.createdAt })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.eventType, "configuration.changed"),
            eq(auditEvents.targetId, MAIL),
          ),
        ),
    );
    expect(
      trail.filter((entry) => entry.at >= before).map((entry) => entry.payload),
    ).toContainEqual(
      expect.objectContaining({
        change: "owner_grants_changed",
        from: null,
        to: "admin",
        reason: "account_mode_switched",
      }),
    );
  });
});

describe("an owner's audience", () => {
  test("is not set from a Bot whose profile cannot be read", async () => {
    expect(
      await runAsTenant(OWNER, () =>
        sharedStore.approveOwnerGrant({
          botId: GONE_BOT,
          serverId: DESK,
          by: OWNER,
        }),
      ),
    ).toBeNull();
  });

  test("is not read once the owner has left", async () => {
    await runAsTenant(OWNER, () =>
      sharedStore.approveOwnerGrant({
        botId: TEAM_BOT,
        serverId: DESK,
        by: OWNER,
      }),
    );
    const ask = () =>
      runAsTenant(TEAMMATE, () =>
        audience.gate({
          botId: TEAM_BOT,
          serverId: DESK,
          title: "Desk",
          actorId: TEAMMATE,
          initiator: { kind: "person" },
          outside: false,
        }),
      );
    expect((await ask()).allowed).toBe(true);
    await asPlatform(() =>
      database
        .insert(revokedAccess)
        .values({ email: `${OWNER}@x.test`, revokedBy: ADMIN }),
    );
    expect((await ask()).allowed).toBe(false);
  });
});

describe("an owner's grant at call time", () => {
  const call = () =>
    runAsTenant(TEAMMATE, () =>
      plugins.callTool({
        ref: `${MAIL}/LIST`,
        args: {},
        botId: TEAM_BOT,
        actorId: TEAMMATE,
        initiator: { kind: "person" },
      }),
    );

  test("goes out on the asker's own account while the owner may give it, and is refused once they have left", async () => {
    await runAsTenant(OWNER, () =>
      plugins.grant("mcp", `${MAIL}/LIST`, TEAM_BOT, OWNER, { as: "owner" }),
    );
    expect((await call()).isError).toBe(false);
    expect(reached).toEqual([TEAMMATE]);
    await asPlatform(() =>
      database
        .insert(revokedAccess)
        .values({ email: `${OWNER}@x.test`, revokedBy: ADMIN }),
    );
    await expect(call()).rejects.toBeInstanceOf(PluginRefusedError);
    expect(reached).toEqual([TEAMMATE]);
  });

  test("an administrator's grant is not affected by the owner leaving", async () => {
    await runAsTenant(OWNER, () =>
      plugins.grant("mcp", `${MAIL}/LIST`, TEAM_BOT, ADMIN),
    );
    await asPlatform(() =>
      database
        .insert(revokedAccess)
        .values({ email: `${OWNER}@x.test`, revokedBy: ADMIN }),
    );
    expect((await call()).isError).toBe(false);
  });

  test("whether the owner still gives is the ownerApps capability too", async () => {
    expect(
      await runAsTenant(TEAMMATE, () =>
        ownerStillGives(database, OWNER, async () => true),
      ),
    ).toBe(true);
    expect(
      await runAsTenant(TEAMMATE, () =>
        ownerStillGives(database, OWNER, async () => false),
      ),
    ).toBe(false);
    expect(
      await runAsTenant(TEAMMATE, () =>
        ownerStillGives(database, `${OWNER}-nobody`, async () => true),
      ),
    ).toBe(false);
  });
});
