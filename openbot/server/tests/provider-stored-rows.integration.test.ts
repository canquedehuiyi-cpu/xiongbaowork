import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray, like } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { createAuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import { composioConnections, mcpServers } from "../src/db/schema";
import { connectionOwners } from "../src/plugins/arcade-attempts";
import { providerDecision } from "../src/plugins/broker";
import { storedProvider } from "../src/plugins/provider-wiring";
import { createPluginRoutes } from "../src/plugins/routes";
import { createPluginStore } from "../src/plugins/store";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * 上游 #1017 的第三组（`provider-undecided.test.ts`「the plugins routes read one name」）按 fork 改写：
 * 没有活动的 broker 时，已存的连接按它们自己的提供商读。
 *
 * 为什么：撤掉 ARCADE_API_KEY 之后，部署里的 Arcade 连接还在。按「没配就是 Composio」来读，这些行会被
 * 另一家的解析器读丢——页面上看不到，背后在厂商那边活着的账号也就没人知道要去结束。所以存储读写哪一家
 * 由行自己说，store 与路由用同一个答案。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8).replaceAll("-", "");
const PERSON = `stored-person-${suite}`;
const GMAIL = `Gmail${suite}`;
const DRIVE = `GoogleDrive${suite}`;
const app = (toolkit: string) => `arcade-${toolkit}`;
const platform = <T>(work: () => Promise<T>) => runAsTenant("platform", work);

beforeAll(async () => {
  await platform(async () => {
    await database.insert(mcpServers).values([
      {
        id: app(GMAIL),
        tenantId: "team",
        title: "Gmail",
        vendor: "Arcade",
        url: `arcade://${GMAIL}`,
        provenance: "arcade",
        authScheme: "OAUTH2",
      },
      {
        id: app(DRIVE),
        tenantId: "team",
        title: "Google Drive",
        vendor: "Arcade",
        url: `arcade://${DRIVE}`,
        provenance: "arcade",
        authScheme: "OAUTH2",
        accountMode: "shared",
        sharedVendorUserId: `deployment:${suite}`,
      },
    ]);
  });
});

afterAll(async () => {
  await platform(async () => {
    await database
      .delete(composioConnections)
      .where(like(composioConnections.toolkit, `%${suite}`));
    await database
      .delete(mcpServers)
      .where(inArray(mcpServers.id, [app(GMAIL), app(DRIVE)]));
  });
  await database.$client.close();
});

describe("the rows a deployment holds say whose they are", () => {
  test("a person's Arcade connection names Arcade", async () => {
    const before = await platform(() => connectionOwners(database));
    await platform(() =>
      database.insert(composioConnections).values({
        tenantId: PERSON,
        toolkit: GMAIL,
        userId: PERSON,
        provider: "arcade",
        verified: true,
      }),
    );
    const after = await platform(() => connectionOwners(database));
    expect(after).toContain("arcade");
    // 只多出 Arcade：别的测试留下的行原样。
    expect(after.filter((owner) => owner !== "arcade")).toEqual(
      before.filter((owner) => owner !== "arcade"),
    );
  });

  test("so does a connected team account, which has no row of anybody's", async () => {
    await platform(async () => {
      await database
        .delete(composioConnections)
        .where(like(composioConnections.toolkit, `%${suite}`));
    });
    const without = await platform(() => connectionOwners(database));
    await platform(() =>
      database
        .update(mcpServers)
        .set({ sharedConnectedAt: new Date(), sharedConnectedBy: PERSON })
        .where(eq(mcpServers.id, app(DRIVE))),
    );
    const withTeam = await platform(() => connectionOwners(database));
    expect(withTeam).toContain("arcade");
    await platform(() =>
      database
        .update(mcpServers)
        .set({ sharedConnectedAt: null, sharedConnectedBy: null })
        .where(eq(mcpServers.id, app(DRIVE))),
    );
    expect(await platform(() => connectionOwners(database))).toEqual(without);
  });

  test("with no key at all, Arcade rows make the stored provider Arcade, and both vendors' rows refuse", () => {
    const nothingConfigured = providerDecision({});
    expect(storedProvider(nothingConfigured, ["arcade"])).toBe("arcade");
    expect(storedProvider(nothingConfigured, [])).toBe("composio");
    expect(() =>
      storedProvider(nothingConfigured, ["arcade", "composio"]),
    ).toThrow(/Arcade/);
  });
});

describe("an Arcade deployment whose key was withdrawn", () => {
  const signedIn: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", {
      id: PERSON,
      email: `${PERSON}@example.test`,
      role: "user",
    } as never);
    await runAsTenant(PERSON, () => next());
  };
  const built = (provider: "arcade" | undefined) => {
    const store = createPluginStore({
      ...(provider ? { brokerProvider: provider } : {}),
      database,
      auditStore: createAuditStore(database),
      credentials: {} as never,
      encryptionKey: "x".repeat(44),
      policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
    });
    const routes = new Hono().route(
      "/api/plugins",
      createPluginRoutes(store, signedIn, async () => true, {
        publicUrl: "https://openbot.example",
        appUrl: "https://app.example",
        encryptionKey: `${"A".repeat(43)}=`,
        personHasAccess: async () => true,
      }),
    );
    return { store, routes };
  };

  test("still lists the person's Arcade connection under the Arcade app", async () => {
    await platform(() =>
      database
        .insert(composioConnections)
        .values({
          tenantId: PERSON,
          toolkit: GMAIL,
          userId: PERSON,
          provider: "arcade",
          verified: true,
        })
        .onConflictDoNothing(),
    );
    const { store } = built(
      storedProvider(providerDecision({}), ["arcade"]) === "arcade"
        ? "arcade"
        : undefined,
    );
    expect(store.brokerProvider).toBe("arcade");
    const listed = await runAsTenant(PERSON, () =>
      store.brokeredConnectionsFor(PERSON),
    );
    expect(listed.map((row) => row.serverId)).toEqual([app(GMAIL)]);
  });

  test("the routes read the Arcade row as a connected app with no broker, not as something else", async () => {
    const { routes } = built("arcade");
    const response = await routes.request(
      `/api/plugins/servers/${app(GMAIL)}/connect`,
      { method: "POST" },
    );
    // 认出它是连接应用，如实说现在没有接上 broker。
    expect(response.status).toBe(503);
  });

  test("read as Composio's instead, the same row is not recognised as a connected app at all", async () => {
    // 这就是没有 `storedProvider` 时的读法：解析器不认 arcade://，这一行掉进了别的分支。
    const { store, routes } = built(undefined);
    expect(store.brokerProvider).toBe("composio");
    const response = await routes.request(
      `/api/plugins/servers/${app(GMAIL)}/connect`,
      { method: "POST" },
    );
    expect(response.status).not.toBe(503);
  });
});
