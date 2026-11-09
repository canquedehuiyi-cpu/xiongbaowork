import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { createAuditStore } from "../src/audit";
import { createAdminScope } from "../src/auth/admin-scope";
import { type AppVariables, createRoleRepository } from "../src/auth/guards";
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
import { createPluginRoutes } from "../src/plugins/routes";
import { createPluginStore } from "../src/plugins/store";
import { runAsTenant } from "../src/tenant/context";
import { seedAdministrator } from "./support/admin-request";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * 申请访问的收件箱接口（迁移 0153）：申请人看、撤回自己的申请；管理员列出、批准、驳回。
 *
 * 批准不新增授权路径：enable 调用 fork 现有的上架（`addInstallListing`），grant 走现有的授予（`asBotOwner` +
 * `enablementDecision` + `store.grant`），只授予应用标为只读、非破坏性的动作。任一步失败时申请保持 pending，
 * 并返回中文错误。只有持有管理员 capability 的人能批准或驳回。真实的表、真实的行安全、真实的 capability。
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
const adminScope = createAdminScope({
  roleRepository: createRoleRepository(database),
});

const suite = `aac-${randomUUID().slice(0, 8)}`;
const admin = `${suite}-admin`;
/** 角色写着 admin，但 `user_roles` 里不是：capability 不会给他。 */
const formerAdmin = `${suite}-former-admin`;
const alice = `${suite}-alice`;
const bob = `${suite}-bob`;
const people = [formerAdmin, alice, bob];
const aliceBot = `${suite}-alice-bot`;
const bobBot = `${suite}-bob-bot`;
const bots = [aliceBot, bobBot];
const unlistedApp = `${suite}-unlisted`;
const listedApp = `${suite}-listed`;
const writeOnlyApp = `${suite}-write-only`;
const apps = [unlistedApp, listedApp, writeOnlyApp];

let releaseAdmin: (() => Promise<void>) | undefined;
const asPlatform = <T>(work: () => Promise<T>) => runAsTenant("platform", work);

function routesAs(actor: { id: string; role: "admin" | "user" }) {
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", { ...actor, email: `${actor.id}@example.test` });
    await runAsTenant(actor.id, () => next());
  };
  return createPluginRoutes(
    store,
    requireUser,
    async () => true,
    undefined,
    undefined,
    adminScope,
  );
}
const asAdmin = () => routesAs({ id: admin, role: "admin" });
const asFormerAdmin = () => routesAs({ id: formerAdmin, role: "admin" });
const asAlice = () => routesAs({ id: alice, role: "user" });
const asBob = () => routesAs({ id: bob, role: "user" });

const post = { method: "POST" };

/** 在申请人的帧里提一条申请，就像工具在对话里做的那样。 */
async function file(
  person: string,
  botId: string,
  serverId: string,
  kind: "enable" | "grant",
) {
  const filed = await runAsTenant(person, () =>
    store.fileAppAccessRequest({
      serverId,
      botId,
      requesterUserId: person,
      kind,
      note: "需要它",
      maxPending: 20,
    }),
  );
  if (filed.outcome === "limited") throw new Error("limited");
  return filed.request.id;
}

const row = async (id: string) => {
  const [found] = await asPlatform(() =>
    database
      .select({
        tenantId: appAccessRequests.tenantId,
        status: appAccessRequests.status,
        decidedBy: appAccessRequests.decidedBy,
      })
      .from(appAccessRequests)
      .where(eq(appAccessRequests.id, id)),
  );
  return found;
};

const grantsOn = (agentId: string) =>
  asPlatform(() =>
    database
      .select({ ref: pluginGrants.ref, tenantId: pluginGrants.tenantId })
      .from(pluginGrants)
      .where(eq(pluginGrants.agentId, agentId))
      .orderBy(pluginGrants.ref),
  );

const listed = (ref: string) =>
  asPlatform(async () => (await store.isInstallListed("mcp", ref)) === true);

beforeAll(async () => {
  releaseAdmin = await seedAdministrator(database, admin);
  await asPlatform(async () => {
    await database
      .insert(users)
      .values(people.map((id) => ({ id, email: `${id}@example.test` })));
    for (const [id, owner] of [
      [aliceBot, alice],
      [bobBot, bob],
    ] as const) {
      await database.insert(agents).values({
        id,
        tenantId: owner,
        name: `${owner} 的助理`,
        type: "built_in",
        configuration: {},
      });
      await database.insert(agentProfiles).values({
        agentId: id,
        tenantId: owner,
        ownerUserId: owner,
        title: "助理",
        roleDescription: "测试用。",
        avatarSeed: id,
        visibility: "private",
      });
    }
    for (const app of apps)
      await database.insert(mcpServers).values({
        tenantId: "team",
        id: app,
        title: `应用 ${app}`,
        vendor: "test",
        url: "https://example.invalid/mcp",
        provenance: "custom",
      });
    await database.insert(mcpTools).values([
      {
        tenantId: "team",
        serverId: unlistedApp,
        name: "search",
        description: "搜索。",
        effect: "read",
      },
      {
        tenantId: "team",
        serverId: listedApp,
        name: "search",
        description: "搜索。",
        effect: "read",
      },
      {
        tenantId: "team",
        serverId: listedApp,
        name: "send",
        description: "发送。",
        effect: "write",
      },
      {
        tenantId: "team",
        serverId: listedApp,
        name: "purge",
        description: "清空。",
        effect: "read",
        destructive: true,
      },
      {
        tenantId: "team",
        serverId: writeOnlyApp,
        name: "send",
        description: "发送。",
        effect: "write",
      },
    ]);
    await store.addInstallListing("mcp", listedApp, "admin@example.test");
    await store.addInstallListing("mcp", writeOnlyApp, "admin@example.test");
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
  await releaseAdmin?.();
});

describe("the person who asked", () => {
  test("sees their own pending requests, and nobody else's", async () => {
    const id = await file(alice, aliceBot, unlistedApp, "enable");
    const mine = await asAlice().request("/access-requests/mine");
    expect(mine.status).toBe(200);
    const { requests } = (await mine.json()) as {
      requests: { id: string; appTitle: string; kind: string }[];
    };
    expect(requests.map((request) => request.id)).toEqual([id]);
    expect(requests[0]).toMatchObject({
      appTitle: `应用 ${unlistedApp}`,
      kind: "enable",
    });
    const one = await asAlice().request(`/access-requests/${id}`);
    expect(one.status).toBe(200);

    const bobs = await asBob().request("/access-requests/mine");
    expect(((await bobs.json()) as { requests: unknown[] }).requests).toEqual(
      [],
    );
    expect((await asBob().request(`/access-requests/${id}`)).status).toBe(404);
  });

  test("withdraws their own request; somebody else cannot, and learns nothing", async () => {
    const id = await file(alice, aliceBot, writeOnlyApp, "grant");
    const bobs = await asBob().request(`/access-requests/${id}`, {
      method: "DELETE",
    });
    expect(bobs.status).toBe(404);
    expect((await row(id))?.status).toBe("pending");

    const withdrawn = await asAlice().request(`/access-requests/${id}`, {
      method: "DELETE",
    });
    expect(withdrawn.status).toBe(200);
    expect((await row(id))?.status).toBe("cancelled");

    const again = await asAlice().request(`/access-requests/${id}`, {
      method: "DELETE",
    });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toBe(
      "这条申请已经处理过了。",
    );
  });

  test("an id that is not a request at all is answered as none", async () => {
    expect(
      (
        await asAlice().request("/access-requests/not-a-uuid", {
          method: "DELETE",
        })
      ).status,
    ).toBe(404);
  });
});

describe("only somebody holding the admin capability decides", () => {
  test("a member cannot list, approve or dismiss", async () => {
    const id = await file(bob, bobBot, unlistedApp, "enable");
    expect((await asBob().request("/access-requests")).status).toBe(403);
    expect(
      (await asBob().request(`/access-requests/${id}/approve`, post)).status,
    ).toBe(403);
    expect(
      (await asBob().request(`/access-requests/${id}/dismiss`, post)).status,
    ).toBe(403);
    expect((await row(id))?.status).toBe("pending");
    expect(await listed(unlistedApp)).toBe(false);
  });

  test("an administrator whose role was taken away cannot either", async () => {
    const [request] = await asPlatform(() =>
      store.pendingAppAccessRequests({ requesterUserId: bob }),
    );
    const response = await asFormerAdmin().request(
      `/access-requests/${request?.id}/approve`,
      post,
    );
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: string }).error).toContain(
      "插件管理权限",
    );
    expect((await row(request?.id ?? ""))?.status).toBe("pending");
  });
});

describe("the administrator's inbox", () => {
  test("lists every person's pending requests, naming who asked, which Bot and which app", async () => {
    const response = await asAdmin().request("/access-requests");
    expect(response.status).toBe(200);
    const { requests } = (await response.json()) as {
      requests: {
        requesterUserId: string;
        botId: string;
        appKey: string;
        kind: string;
        note: string | null;
      }[];
    };
    const ours = requests
      .filter((request) => apps.includes(request.appKey))
      .map((request) => `${request.requesterUserId} ${request.appKey}`)
      .sort();
    expect(ours).toEqual(
      [`${alice} ${unlistedApp}`, `${bob} ${unlistedApp}`].sort(),
    );
    expect(
      requests.find((request) => request.requesterUserId === alice),
    ).toMatchObject({ botId: aliceBot, kind: "enable", note: "需要它" });
  });

  test("approving enable lists (上架) the app, and closes the request in the asker's tenant", async () => {
    const [request] = await runAsTenant(alice, () =>
      store.pendingAppAccessRequests({ requesterUserId: alice }),
    );
    const response = await asAdmin().request(
      `/access-requests/${request?.id}/approve`,
      post,
    );
    expect(response.status).toBe(200);
    expect(await listed(unlistedApp)).toBe(true);
    expect(await row(request?.id ?? "")).toEqual({
      tenantId: alice,
      status: "approved",
      decidedBy: `${admin}@example.test`,
    });
    // 上架不授予：Bot 的主人从此可以自己装（D08）。
    expect(await grantsOn(aliceBot)).toEqual([]);
  });

  test("approving grant gives the Bot the app's read-only actions only, stamped as its owner's", async () => {
    const id = await file(alice, aliceBot, listedApp, "grant");
    const response = await asAdmin().request(
      `/access-requests/${id}/approve`,
      post,
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as { granted: string[] }).granted).toEqual([
      `${listedApp}/search`,
    ]);
    expect(await grantsOn(aliceBot)).toEqual([
      { ref: `${listedApp}/search`, tenantId: alice },
    ]);
    expect((await row(id))?.status).toBe("approved");
  });

  test("a grant with nothing read-only to give fails in words, and the request stays pending", async () => {
    const id = await file(bob, bobBot, writeOnlyApp, "grant");
    const response = await asAdmin().request(
      `/access-requests/${id}/approve`,
      post,
    );
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toContain(
      "没有标为只读的动作",
    );
    expect((await row(id))?.status).toBe("pending");
    expect(await grantsOn(bobBot)).toEqual([]);
  });

  test("dismissing closes a request once and changes nothing else", async () => {
    // 上一项留下的那条仍在等：再提一次拿到的就是它。
    const id = await file(bob, bobBot, writeOnlyApp, "grant");
    const response = await asAdmin().request(
      `/access-requests/${id}/dismiss`,
      post,
    );
    expect(response.status).toBe(200);
    expect(await row(id)).toEqual({
      tenantId: bob,
      status: "dismissed",
      decidedBy: `${admin}@example.test`,
    });
    expect(await grantsOn(bobBot)).toEqual([]);
    const again = await asAdmin().request(
      `/access-requests/${id}/dismiss`,
      post,
    );
    expect(again.status).toBe(409);
  });

  test("a request that does not exist is answered as none", async () => {
    for (const id of [randomUUID(), "not-a-uuid"]) {
      expect(
        (await asAdmin().request(`/access-requests/${id}/approve`, post))
          .status,
      ).toBe(404);
      expect(
        (await asAdmin().request(`/access-requests/${id}/dismiss`, post))
          .status,
      ).toBe(404);
    }
  });
});
