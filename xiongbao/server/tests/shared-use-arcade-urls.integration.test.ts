import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  mcpServers,
  pluginGrants,
  users,
} from "../src/db/schema";
import { sharedUseApprovals } from "../src/db/schema/shared-use";
import type { BrokerProvider } from "../src/plugins/access";
import {
  createSharedUseStore,
  sharedUseAppLockKey,
} from "../src/plugins/shared-use-store";
import { createPluginStore } from "../src/plugins/store";
import { asPlatform, runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * 共享使用按应用的地址认应用，Arcade 的地址也一样（上游 `shared-use-arcade-urls.test.ts`，按 fork 的租户
 * 改写；X3 原来只认 `composio://`，X5 合入后按地址自己的提供商解析）。
 *
 * 同一个地址上两行是同一个应用，id 小的那一行应答；员工经 id 大的那一行被授予，列出的仍是应答行；应用的锁
 * 对两行是同一把；管理员不再让主人决定时，在任何一行上改都撤回记在应答行上的主人受众。fork 没有上游的
 * `botsHolding`，第三条换成撤回。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const id = (name: string) => `${name}-${suite}`;

/** Two rows at one app url, the lower id first, and a Bot granted through the HIGHER one only. */
const lowId = id("sua-a-row");
const highId = id("sua-b-row");
const bot = id("sua-bot");
const owner = id("sua-owner");

const spec: Record<BrokerProvider, { toolkit: string; scheme: string }> = {
  composio: { toolkit: `gmail${suite}`, scheme: "composio://" },
  arcade: { toolkit: `Gmail${suite}`, scheme: "arcade://" },
};

const audit = createAuditStore(database);
const plugins = createPluginStore({
  database,
  auditStore: audit,
  credentials: { readSecret: async () => null } as never,
  encryptionKey: "x".repeat(44),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
});

async function cleanup() {
  await asPlatform(async () => {
    await database.delete(agents).where(eq(agents.id, bot));
    await database
      .delete(mcpServers)
      .where(inArray(mcpServers.id, [lowId, highId]));
    await database.delete(users).where(eq(users.id, owner));
  });
}

async function seed(provider: BrokerProvider) {
  const url = `${spec[provider].scheme}${spec[provider].toolkit}`;
  await asPlatform(async () => {
    await database
      .insert(users)
      .values({ id: owner, email: `${owner}@example.test`, name: "owner" });
    for (const rowId of [lowId, highId])
      await database.insert(mcpServers).values({
        id: rowId,
        tenantId: "team",
        title: `Team ${rowId}`,
        vendor: provider,
        url,
        provenance: provider,
        authScheme: "OAUTH2",
        accountMode: "shared",
        sharedVendorUserId: "openbot-deployment:x:R",
        ownerGrants: "any",
      });
    await database.insert(agents).values({
      id: bot,
      tenantId: owner,
      name: "Triage",
      type: "built_in",
      configuration: {},
    });
    await database.insert(agentProfiles).values({
      agentId: bot,
      tenantId: owner,
      ownerUserId: owner,
      visibility: "private",
      title: "Triage",
      roleDescription: "Triage",
      avatarSeed: "x",
    });
  });
  await runAsTenant(owner, () =>
    database.insert(pluginGrants).values({
      kind: "mcp",
      ref: `${highId}/ACTION`,
      agentId: bot,
      grantedBy: "admin@example.test",
    }),
  );
  return url;
}

beforeEach(cleanup);
afterAll(cleanup);
afterAll(async () => {
  await database.$client.close();
});

for (const provider of ["arcade", "composio"] as const) {
  describe(`shared use urls under ${provider}`, () => {
    test("two rows at one url are ONE app and the lower id answers", async () => {
      await seed(provider);
      const store = createSharedUseStore(database);
      expect(await runAsTenant(owner, () => store.appIdOf(highId))).toBe(lowId);
      expect(await runAsTenant(owner, () => store.appIdOf(lowId))).toBe(lowId);
    });

    test("sharedAppsHeldBy lists the app, under the answering row", async () => {
      await seed(provider);
      const store = createSharedUseStore(database);
      const held = await runAsTenant(owner, () => store.sharedAppsHeldBy(bot));
      expect(held.map((app) => app.serverId)).toEqual([lowId]);
    });

    test("both rows take the same app lock, and another broker's app of the same name does not", async () => {
      const url = await seed(provider);
      expect(sharedUseAppLockKey(url, highId)).toBe(
        sharedUseAppLockKey(url, lowId),
      );
      const other = provider === "arcade" ? "composio" : "arcade";
      expect(
        sharedUseAppLockKey(
          `${spec[other].scheme}${spec[provider].toolkit}`,
          lowId,
        ),
      ).not.toBe(sharedUseAppLockKey(url, lowId));
    });

    test("taking the decision back from owners on the sibling row withdraws the audience recorded on the answering row", async () => {
      await seed(provider);
      await runAsTenant(owner, () =>
        database.insert(sharedUseApprovals).values({
          agentId: bot,
          serverId: lowId,
          audience: "owner",
          outsideInput: false,
          approvedBy: owner,
          approvedAs: "owner",
        }),
      );
      const result = await asPlatform(() =>
        plugins.setOwnerGrants({
          serverId: highId,
          ownerGrants: "admin",
          by: "admin@example.test",
        }),
      );
      expect(result?.withdrawn).toEqual([bot]);
      expect(
        await asPlatform(() =>
          database
            .select()
            .from(sharedUseApprovals)
            .where(eq(sharedUseApprovals.agentId, bot)),
        ),
      ).toEqual([]);
    });
  });
}
