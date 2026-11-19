import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { createAuditStore } from "../src/audit";
import { createAdminScope } from "../src/auth/admin-scope";
import { type AppVariables, createRoleRepository } from "../src/auth/guards";
import { setRole } from "../src/auth/roles";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  auditEvents,
  mcpServers,
  pluginGrants,
  users,
} from "../src/db/schema";
import {
  sharedUseApprovals,
  sharedUseRequests,
} from "../src/db/schema/shared-use";
import type { ComposioBroker } from "../src/plugins/broker";
import { createPluginRoutes } from "../src/plugins/routes";
import {
  createSharedAudience,
  createSharedUseStore,
} from "../src/plugins/shared-use-store";
import { createPluginStore } from "../src/plugins/store";
import { asPlatform, runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { bindTestRoleWriter } from "./support/role-writer";

/**
 * 共享使用的申请与批准路由（上游 `shared-use-routes.test.ts`，按 fork 改成经真实插件路由、管理员能力中间件
 * 和行级安全的集成测试）。
 *
 * 断言安全规则：只有持有能力的管理员列出、批准、驳回；只有员工的主人（或管理员）申请，提议由服务端定；
 * 批准落在员工主人名下；同一条申请只能决定一次；没有主人的员工没有地方记批准。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const id = (name: string) => `sr-${suite}-${name}`;
const OWNER = id("owner");
const ADMIN = id("admin");
const STRANGER = id("stranger");
/** 会话里还是管理员、数据库里已没有管理员角色的人。 */
const DEMOTED = id("demoted");
const people = [OWNER, ADMIN, STRANGER, DEMOTED];
const BOT = id("bot");
const IDLE_BOT = id("idle-bot");
const ORPHAN = id("orphan");
const bots = [BOT, IDLE_BOT, ORPHAN];
const APP = `sr_${suite.replace(/-/g, "_")}`;
let releaseRoleWriter: (() => Promise<void>) | undefined;

const audit = createAuditStore(database);
const sharedStore = createSharedUseStore(database);
const audience = createSharedAudience(database, sharedStore, audit);
const plugins = createPluginStore({
  database,
  auditStore: audit,
  credentials: { readSecret: async () => null } as never,
  encryptionKey: "x".repeat(44),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  sharedUse: audience.gate,
});
const adminScope = createAdminScope({
  roleRepository: createRoleRepository(database),
});

function as(actorId: string) {
  const session: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", {
      id: actorId,
      email: `${actorId}@example.test`,
      role: actorId === ADMIN || actorId === DEMOTED ? "admin" : "user",
    } as never);
    await runAsTenant(actorId, () => next());
  };
  return new Hono().route(
    "/api/plugins",
    createPluginRoutes(
      plugins,
      session,
      async () => true,
      {
        publicUrl: "https://openbot.example",
        appUrl: "https://app.example",
        encryptionKey: `${"A".repeat(43)}=`,
        personHasAccess: async () => true,
      },
      {
        broker: {} as ComposioBroker,
        sharedUse: { store: sharedStore, audience },
      },
      adminScope,
    ),
  );
}

const post = (actor: string, path: string, body?: unknown) =>
  as(actor).request(`/api/plugins${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const get = (actor: string, path: string) =>
  as(actor).request(`/api/plugins${path}`);

beforeAll(async () => {
  releaseRoleWriter = await bindTestRoleWriter(database);
  await asPlatform(async () => {
    await database
      .insert(users)
      .values(
        people.map((person) => ({ id: person, email: `${person}@x.test` })),
      );
    await setRole(database, ADMIN, "admin");
    await database.insert(mcpServers).values({
      id: APP,
      tenantId: "team",
      title: "Team GitHub",
      vendor: "Composio",
      url: `composio://${APP}`,
      provenance: "composio",
      authScheme: "OAUTH2",
      accountMode: "shared",
      sharedVendorUserId: `openbot-deployment:${suite}:R`,
      sharedConnectedAt: new Date(),
      sharedConnectedBy: ADMIN,
      sharedVerified: true,
    });
    for (const [bot, name] of [
      [BOT, "Triage"],
      [IDLE_BOT, "Idle"],
    ] as const) {
      await database.insert(agents).values({
        id: bot,
        tenantId: OWNER,
        name,
        type: "built_in",
        configuration: {},
      });
      await database.insert(agentProfiles).values({
        agentId: bot,
        tenantId: OWNER,
        ownerUserId: OWNER,
        title: name,
        roleDescription: "测试",
        avatarSeed: bot,
        visibility: "private",
      });
    }
    await database.insert(agents).values({
      id: ORPHAN,
      tenantId: "system",
      name: "Catalogue",
      type: "built_in",
      configuration: {},
    });
    await database.insert(pluginGrants).values({
      tenantId: OWNER,
      kind: "mcp",
      ref: `${APP}/GITHUB_LIST_ISSUES`,
      agentId: BOT,
      grantedBy: ADMIN,
    });
  });
});

beforeEach(async () => {
  await asPlatform(async () => {
    await database
      .delete(sharedUseRequests)
      .where(inArray(sharedUseRequests.agentId, bots));
    await database
      .delete(sharedUseApprovals)
      .where(inArray(sharedUseApprovals.agentId, bots));
  });
});

afterAll(async () => {
  await asPlatform(async () => {
    await database.delete(agents).where(inArray(agents.id, bots));
    await database.delete(mcpServers).where(eq(mcpServers.id, APP));
    await database.delete(users).where(inArray(users.id, people));
  });
  await releaseRoleWriter?.();
  await database.$client.close();
});

const ask = (actor: string, botId = BOT) =>
  post(actor, "/shared-use", {
    botId,
    serverId: APP,
    reason: "trigger",
    // 浏览器写的提议不算数：服务端按员工现在的开放范围定。
    proposed: { audience: "team", outsideInput: true },
  });

describe("asking for a Bot's use of a Shared app", () => {
  test("the owner can ask, and the server decides what is proposed, in the owner's name", async () => {
    const response = await ask(OWNER);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ created: true });
    const [row] = await asPlatform(() =>
      database
        .select()
        .from(sharedUseRequests)
        .where(eq(sharedUseRequests.agentId, BOT)),
    );
    expect(row).toMatchObject({
      tenantId: OWNER,
      requestedBy: OWNER,
      reason: "trigger",
      proposedAudience: "owner",
      proposedOutsideInput: false,
      proposedMembers: [],
    });
    // 同一个提议再问一次拿到同一条。
    expect(await (await ask(OWNER)).json()).toMatchObject({ created: false });
  });

  test("someone who is neither owner nor admin cannot ask, and a session without the admin role behind it cannot either", async () => {
    expect((await ask(STRANGER)).status).toBe(403);
    expect((await ask(DEMOTED)).status).toBe(403);
    expect(
      await asPlatform(() =>
        database
          .select()
          .from(sharedUseRequests)
          .where(eq(sharedUseRequests.agentId, BOT)),
      ),
    ).toEqual([]);
  });

  test("a Bot that does not use the app, a missing reason, and a Bot nobody owns are refused", async () => {
    expect((await ask(OWNER, IDLE_BOT)).status).toBe(400);
    expect(
      (await post(OWNER, "/shared-use", { botId: BOT, serverId: APP })).status,
    ).toBe(400);
    expect((await ask(ADMIN, ORPHAN)).status).toBe(409);
  });

  test("an administrator can ask for another person's Bot, and the request is the owner's", async () => {
    expect((await ask(ADMIN)).status).toBe(200);
    const [row] = await asPlatform(() =>
      database
        .select()
        .from(sharedUseRequests)
        .where(eq(sharedUseRequests.agentId, BOT)),
    );
    expect(row?.tenantId).toBe(OWNER);
    expect(row?.requestedBy).toBe(ADMIN);
  });
});

describe("the administrator's inbox", () => {
  test("only an administrator holding the capability lists them", async () => {
    await ask(OWNER);
    expect((await get(OWNER, "/shared-use")).status).toBe(403);
    expect((await get(DEMOTED, "/shared-use")).status).toBe(403);
    const listed = (await (await get(ADMIN, "/shared-use")).json()) as {
      requests: { botId: string; ownerUserId: string; current: unknown }[];
    };
    expect(listed.requests.filter((row) => row.botId === BOT)).toEqual([
      expect.objectContaining({
        botId: BOT,
        ownerUserId: OWNER,
        current: null,
        title: "Team GitHub",
      }),
    ]);
    // 应用访问申请的收件箱形状不变。
    const inbox = (await (
      await get(ADMIN, "/access-requests")
    ).json()) as Record<string, unknown>;
    expect(Object.keys(inbox).sort()).toEqual(["counts", "requests"]);
  });

  test("approving writes the approval in the owner's name, and a second decision is told it was already decided", async () => {
    await ask(OWNER);
    const [pending] = await runAsTenant(OWNER, () =>
      sharedStore.pendingFor(BOT),
    );
    expect(
      (await post(OWNER, `/shared-use/${pending?.id}/approve`)).status,
    ).toBe(403);
    expect(
      (await post(DEMOTED, `/shared-use/${pending?.id}/approve`)).status,
    ).toBe(403);
    const approved = await post(ADMIN, `/shared-use/${pending?.id}/approve`);
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({
      request: { id: pending?.id, status: "approved" },
    });
    const [row] = await asPlatform(() =>
      database
        .select()
        .from(sharedUseApprovals)
        .where(eq(sharedUseApprovals.agentId, BOT)),
    );
    expect(row).toMatchObject({
      tenantId: OWNER,
      audience: "owner",
      approvedBy: ADMIN,
      approvedAs: "admin",
    });
    const again = await post(ADMIN, `/shared-use/${pending?.id}/decline`);
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "这条申请已经处理过了。" });
    const trail = await asPlatform(() =>
      database
        .select({ tenantId: auditEvents.tenantId })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.eventType, "shared_use.approved"),
            eq(auditEvents.targetId, APP),
          ),
        ),
    );
    expect(trail).toEqual([{ tenantId: OWNER }]);
    // 批准之后，主人自己的调用过了闸门。
    expect(
      (
        await runAsTenant(OWNER, () =>
          audience.gate({
            botId: BOT,
            serverId: APP,
            title: "Team GitHub",
            actorId: OWNER,
            initiator: { kind: "person" },
            outside: false,
          }),
        )
      ).allowed,
    ).toBe(true);
  });

  test("declining writes no approval", async () => {
    await ask(OWNER);
    const [pending] = await runAsTenant(OWNER, () =>
      sharedStore.pendingFor(BOT),
    );
    expect(
      (await post(ADMIN, `/shared-use/${pending?.id}/decline`)).status,
    ).toBe(200);
    expect(
      await asPlatform(() =>
        database
          .select()
          .from(sharedUseApprovals)
          .where(eq(sharedUseApprovals.agentId, BOT)),
      ),
    ).toEqual([]);
  });

  test("a request id that is not pending is refused without touching anything", async () => {
    expect(
      (await post(ADMIN, `/shared-use/${randomUUID()}/approve`)).status,
    ).toBe(409);
  });
});

describe("what a Bot's Shared apps need", () => {
  test("the owner and an administrator see it; a stranger does not", async () => {
    const before = (await (
      await get(OWNER, `/shared-use/bot/${BOT}`)
    ).json()) as {
      apps: { serverId: string; covered: boolean; needed: unknown }[];
      pending: unknown[];
    };
    expect(before.apps).toEqual([
      expect.objectContaining({
        serverId: APP,
        covered: false,
        needed: { audience: "owner", outsideInput: false, members: [] },
      }),
    ]);
    await runAsTenant(OWNER, () =>
      sharedStore.setApproval({
        botId: BOT,
        serverId: APP,
        by: ADMIN,
        approval: { audience: "owner", outsideInput: false, members: [] },
      }),
    );
    const viewed = (await (
      await get(ADMIN, `/shared-use/bot/${BOT}`)
    ).json()) as {
      apps: { covered: boolean }[];
    };
    expect(viewed.apps).toEqual([expect.objectContaining({ covered: true })]);
    expect((await get(STRANGER, `/shared-use/bot/${BOT}`)).status).toBe(403);
  });
});
