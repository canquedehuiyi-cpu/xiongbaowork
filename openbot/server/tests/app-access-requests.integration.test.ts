import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { readAppAccessRequestAnswer } from "../../shared/app-access-request";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  appAccessRequests,
  mcpServers,
  mcpTools,
  pluginGrants,
  users,
} from "../src/db/schema";
import { pluginInstallListings } from "../src/db/schema/plugin-install-listings";
import {
  appAccessTools,
  REQUEST_APP_ACCESS_REF,
} from "../src/plugins/app-access-tool";
import { createPluginStore } from "../src/plugins/store";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * 申请访问（迁移 0153）：员工在对话里用不了某个应用时，调用 `request_app_access` 替对方向管理员申请。
 *
 * 用真实的表、真实的行安全和应用角色跑：申请属于申请人的租户，另一个人的帧既读不到也改不了，这是数据库
 * 的性质，所以在数据库上断言。类型（enable / grant）由服务端按应用当前状态判定，应用已就绪时不建申请，
 * 重复申请拿到已有的那条。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: {
    readSecret: async () => null,
    create: async () => {
      throw new Error("this suite does not write credentials");
    },
    revoke: async () => {
      throw new Error("this suite does not revoke credentials");
    },
  },
  encryptionKey: "x".repeat(44),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
});

const suite = randomUUID().slice(0, 8);
const alice = `aar-${suite}-alice`;
const bob = `aar-${suite}-bob`;
const people = [alice, bob];
const aliceBot = `aar-${suite}-alice-bot`;
const bobBot = `aar-${suite}-bob-bot`;
const bots = [aliceBot, bobBot];
/** 还没上架的应用：申请类型是 enable。 */
const unlistedApp = `aar-${suite}-unlisted`;
/** 已上架、但 aliceBot 没被授予：申请类型是 grant。 */
const listedApp = `aar-${suite}-listed`;
/** 已授予 aliceBot：已就绪，不建申请。 */
const readyApp = `aar-${suite}-ready`;
const apps = [unlistedApp, listedApp, readyApp];
const toolName = "search";

const asPlatform = <T>(work: () => Promise<T>) => runAsTenant("platform", work);

/** 被拒绝的语句的全部消息，不管查询构造器把驱动的错误包在哪一层。 */
async function refusal(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
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

function toolFor(actorId: string, botId: string) {
  const [tool] = appAccessTools({ store, botId, actorId });
  if (!tool) throw new Error("no request_app_access tool");
  return tool;
}

/** 以 `actorId` 的身份、在其帧内调用工具，就像对话里的一次工具调用。 */
const ask = (
  actorId: string,
  botId: string,
  args: { app: string; reason: string },
) => runAsTenant(actorId, () => toolFor(actorId, botId).execute(args));

const rowsFor = (scope: string) =>
  runAsTenant(scope, () =>
    database
      .select({
        id: appAccessRequests.id,
        tenantId: appAccessRequests.tenantId,
        serverId: appAccessRequests.serverId,
        botId: appAccessRequests.botId,
        requesterUserId: appAccessRequests.requesterUserId,
        kind: appAccessRequests.kind,
        status: appAccessRequests.status,
        note: appAccessRequests.note,
      })
      .from(appAccessRequests)
      .where(inArray(appAccessRequests.serverId, apps)),
  );

beforeAll(async () => {
  await asPlatform(async () => {
    await database
      .insert(users)
      .values(people.map((id) => ({ id, email: `${id}@example.test` })));
    await database.insert(agents).values(
      [
        [aliceBot, alice],
        [bobBot, bob],
      ].map(([id, owner]) => ({
        id: id as string,
        tenantId: owner as string,
        name: `${id} 的员工`,
        type: "built_in" as const,
        configuration: {},
      })),
    );
    await database.insert(agentProfiles).values(
      [
        [aliceBot, alice],
        [bobBot, bob],
      ].map(([id, owner]) => ({
        agentId: id as string,
        tenantId: owner as string,
        ownerUserId: owner as string,
        title: "助理",
        roleDescription: "测试用。",
        avatarSeed: id as string,
        visibility: "private",
      })),
    );
    // 团队的应用和工具，管理员添加时就是这样盖章的（G01-E P10）。
    for (const app of apps) {
      await database.insert(mcpServers).values({
        tenantId: "team",
        id: app,
        title: `应用${app.slice(-6)}`,
        vendor: "test",
        url: "https://example.invalid/mcp",
        provenance: "custom",
      });
      await database.insert(mcpTools).values({
        tenantId: "team",
        serverId: app,
        name: toolName,
        description: "搜索。",
        effect: "read",
      });
    }
    // 已就绪的应用授予了 aliceBot，盖的是 Bot 主人的章。
    await database.insert(pluginGrants).values({
      tenantId: alice,
      kind: "mcp",
      ref: `${readyApp}/${toolName}`,
      agentId: aliceBot,
      grantedBy: "admin@example.test",
    });
  });
  await asPlatform(async () => {
    await store.addInstallListing("mcp", listedApp, "admin@example.test");
    await store.addInstallListing("mcp", readyApp, "admin@example.test");
  });
});

afterAll(async () => {
  await asPlatform(async () => {
    await database
      .delete(appAccessRequests)
      .where(inArray(appAccessRequests.serverId, apps));
    await database
      .delete(pluginInstallListings)
      .where(
        and(
          eq(pluginInstallListings.tenantId, "system"),
          inArray(pluginInstallListings.ref, apps),
        ),
      );
    await database
      .delete(pluginGrants)
      .where(inArray(pluginGrants.agentId, bots));
    await database.delete(mcpTools).where(inArray(mcpTools.serverId, apps));
    await database.delete(mcpServers).where(inArray(mcpServers.id, apps));
    await database.delete(agents).where(inArray(agents.id, bots));
    await database.delete(users).where(inArray(users.id, people));
  });
});

describe("the table (0153)", () => {
  test("row security is enabled and forced, with one policy per command", async () => {
    const [table] = await asPlatform(() =>
      database.execute<{ enabled: boolean; forced: boolean }>(sql`
        select relrowsecurity as enabled, relforcerowsecurity as forced
        from pg_class where oid = 'public.app_access_requests'::regclass
      `),
    );
    expect(table).toEqual({ enabled: true, forced: true });
    const policies = await asPlatform(() =>
      database.execute<{ cmd: string }>(sql`
        select cmd from pg_policies where tablename = 'app_access_requests' order by cmd
      `),
    );
    expect(Array.from(policies).map((row) => row.cmd)).toEqual([
      "DELETE",
      "INSERT",
      "SELECT",
      "UPDATE",
    ]);
  });

  test("a kind outside enable and grant is refused, connect_shared included", async () => {
    expect(
      await refusal(() =>
        runAsTenant(alice, async () => {
          await database.insert(appAccessRequests).values({
            serverId: unlistedApp,
            botId: aliceBot,
            requesterUserId: alice,
            kind: "connect_shared",
          });
        }),
      ),
    ).toContain("app_access_requests_kind_check");
  });
});

describe("request_app_access", () => {
  test("is a tool every Bot holds, under its own ref", () => {
    const tool = toolFor(alice, aliceBot);
    expect(tool.name).toBe("request_app_access");
    expect(tool.ref).toBe(REQUEST_APP_ACCESS_REF);
  });

  test("an app nobody listed is asked to be listed (enable), in the asker's tenant", async () => {
    const answer = await ask(alice, aliceBot, {
      app: unlistedApp,
      reason: "要查一下上周的工单",
    });
    const read = readAppAccessRequestAnswer(answer);
    expect(read?.card).toMatchObject({
      appKey: unlistedApp,
      title: `应用${unlistedApp.slice(-6)}`,
      kind: "enable",
      status: "created",
    });
    expect(read?.sentence).toContain("已向管理员申请访问");
    expect(await rowsFor(alice)).toEqual([
      {
        id: read?.card.requestId as string,
        tenantId: alice,
        serverId: unlistedApp,
        botId: aliceBot,
        requesterUserId: alice,
        kind: "enable",
        status: "pending",
        note: "要查一下上周的工单",
      },
    ]);
  });

  test("asking again answers with the pending request already there, and files nothing new", async () => {
    const [first] = await rowsFor(alice);
    const answer = await ask(alice, aliceBot, {
      app: unlistedApp,
      reason: "再问一次",
    });
    const read = readAppAccessRequestAnswer(answer);
    expect(read?.card).toMatchObject({
      requestId: first?.id,
      status: "existing",
    });
    expect(read?.sentence).toContain("已有待处理的申请");
    expect(await rowsFor(alice)).toHaveLength(1);
  });

  test("an app that is listed but not on this Bot is asked to be granted (grant), found by its name", async () => {
    const answer = await ask(alice, aliceBot, {
      app: `应用${listedApp.slice(-6)}`,
      reason: "需要它",
    });
    expect(readAppAccessRequestAnswer(answer)?.card).toMatchObject({
      appKey: listedApp,
      kind: "grant",
      status: "created",
    });
  });

  test("an app this Bot already holds is ready: said in words, and nothing is filed", async () => {
    const answer = await ask(alice, aliceBot, {
      app: readyApp,
      reason: "需要它",
    });
    expect(readAppAccessRequestAnswer(answer)).toBeNull();
    expect(answer).toContain("已经可以使用");
    expect(
      (await rowsFor(alice)).filter((row) => row.serverId === readyApp),
    ).toEqual([]);
  });

  test("an app this deployment does not have is said plainly, and nothing is filed", async () => {
    const answer = await ask(alice, aliceBot, {
      app: `no-such-app-${suite}`,
      reason: "需要它",
    });
    expect(readAppAccessRequestAnswer(answer)).toBeNull();
    expect(answer).toContain("没有叫");
    expect(await rowsFor(alice)).toHaveLength(2);
  });

  test("arguments that name no app are refused without filing anything", async () => {
    const answer = await runAsTenant(alice, () =>
      toolFor(alice, aliceBot).execute({ app: "", reason: "" }),
    );
    expect(answer.startsWith("Refused.")).toBe(true);
    expect(await rowsFor(alice)).toHaveLength(2);
  });
});

describe("one person's requests are theirs (tenant frame)", () => {
  test("another person's frame reads none of them", async () => {
    expect(await rowsFor(bob)).toEqual([]);
    const [first] = await rowsFor(alice);
    expect(
      await runAsTenant(bob, () => store.appAccessRequest(first?.id ?? "")),
    ).toBeNull();
    expect(
      await runAsTenant(bob, () => store.pendingAppAccessRequests()),
    ).toEqual([]);
  });

  test("another person cannot withdraw one, and nothing changes", async () => {
    const [first] = await rowsFor(alice);
    expect(
      await runAsTenant(bob, () =>
        store.cancelAppAccessRequest({
          id: first?.id ?? "",
          requesterUserId: bob,
        }),
      ),
    ).toBeNull();
    expect(
      (await rowsFor(alice)).every((row) => row.status === "pending"),
    ).toBe(true);
  });

  test("a row stamped with somebody else's tenant cannot be written", async () => {
    expect(
      await refusal(() =>
        runAsTenant(bob, async () => {
          await database.insert(appAccessRequests).values({
            tenantId: alice,
            serverId: unlistedApp,
            botId: bobBot,
            requesterUserId: bob,
            kind: "enable",
          });
        }),
      ),
    ).toContain("row-level security");
  });

  test("a second person asking about the same app files their own request", async () => {
    const answer = await ask(bob, bobBot, {
      app: unlistedApp,
      reason: "我也要",
    });
    expect(readAppAccessRequestAnswer(answer)?.card.status).toBe("created");
    expect(await rowsFor(bob)).toHaveLength(1);
    expect(await rowsFor(alice)).toHaveLength(2);
  });

  test("the platform frame sees every pending request, with the app, the Bot and who asked", async () => {
    const pending = (await asPlatform(() => store.pendingAppAccessRequests()))
      .filter((request) => apps.includes(request.serverId))
      .map((request) => ({
        requester: request.requesterUserId,
        appKey: request.appKey,
        kind: request.kind,
        tenantId: request.tenantId,
      }))
      .sort((a, b) =>
        `${a.requester}${a.appKey}`.localeCompare(`${b.requester}${b.appKey}`),
      );
    expect(pending).toEqual([
      { requester: alice, appKey: listedApp, kind: "grant", tenantId: alice },
      {
        requester: alice,
        appKey: unlistedApp,
        kind: "enable",
        tenantId: alice,
      },
      { requester: bob, appKey: unlistedApp, kind: "enable", tenantId: bob },
    ]);
  });
});

describe("withdrawing and deciding", () => {
  test("the person who asked withdraws their own pending request", async () => {
    const [first] = (await rowsFor(alice)).filter(
      (row) => row.serverId === unlistedApp,
    );
    const cancelled = await runAsTenant(alice, () =>
      store.cancelAppAccessRequest({
        id: first?.id ?? "",
        requesterUserId: alice,
      }),
    );
    expect(cancelled).toMatchObject({ id: first?.id, status: "cancelled" });
    // 已撤回的不能再撤回一次。
    expect(
      await runAsTenant(alice, () =>
        store.cancelAppAccessRequest({
          id: first?.id ?? "",
          requesterUserId: alice,
        }),
      ),
    ).toBeNull();
  });

  test("once withdrawn, asking again files a new request", async () => {
    const answer = await ask(alice, aliceBot, {
      app: unlistedApp,
      reason: "还是需要",
    });
    expect(readAppAccessRequestAnswer(answer)?.card.status).toBe("created");
  });

  test("a decision closes a pending request once, in the asker's frame", async () => {
    const [grant] = (await rowsFor(alice)).filter(
      (row) => row.serverId === listedApp,
    );
    const decided = await runAsTenant(alice, () =>
      store.decideAppAccessRequest({
        id: grant?.id ?? "",
        status: "dismissed",
        by: "admin@example.test",
      }),
    );
    expect(decided).toMatchObject({
      status: "dismissed",
      decidedBy: "admin@example.test",
    });
    expect(decided?.decidedAt).not.toBeNull();
    expect(
      await runAsTenant(alice, () =>
        store.decideAppAccessRequest({
          id: grant?.id ?? "",
          status: "approved",
          by: "admin@example.test",
        }),
      ),
    ).toBeNull();
    // 别人的帧里决定不了它。
    const [bobs] = await rowsFor(bob);
    expect(
      await runAsTenant(alice, () =>
        store.decideAppAccessRequest({
          id: bobs?.id ?? "",
          status: "approved",
          by: "admin@example.test",
        }),
      ),
    ).toBeNull();
    expect((await rowsFor(bob))[0]?.status).toBe("pending");
  });
});
