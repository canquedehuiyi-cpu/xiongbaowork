import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
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
 * 共享使用的加固：申请表的一致性约束与以租户开头的键、收件箱在别人有同地址私有行时仍读对、切换账号模式
 * 之后不再写批准并把待处理申请作废、读不到员工资料时按非公开处理、没有提问人的调用被拒、管理员撤销单条
 * 批准。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const id = (name: string) => `sh-${suite}-${name}`;
const OWNER = id("owner");
const ADMIN = id("admin");
const STRANGER = id("stranger");
const people = [OWNER, ADMIN, STRANGER];
const BOT = id("bot");
const GONE_BOT = id("gone-bot");
const bots = [BOT, GONE_BOT];
const toolkit = `sh_${suite.replace(/-/g, "_")}`;
const APP = `sh_${toolkit}`;
/** 别人自己帧里同一个地址上的一行，id 比应答行小。 */
const PRIVATE_TWIN = `a_${toolkit}`;
let releaseRoleWriter: (() => Promise<void>) | undefined;

const audit = createAuditStore(database);
const store = createSharedUseStore(database);
const audience = createSharedAudience(database, store, audit);
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
      role: actorId === ADMIN ? "admin" : "user",
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
        sharedUse: { store, audience },
      },
      adminScope,
    ),
  );
}

const sharedColumns = {
  accountMode: "shared",
  sharedVendorUserId: `openbot-deployment:${suite}:R`,
  sharedConnectedAt: new Date(),
  sharedConnectedBy: ADMIN,
  sharedVerified: true,
};

const approveTeam = () =>
  runAsTenant(OWNER, () =>
    store.setApproval({
      botId: BOT,
      serverId: APP,
      by: ADMIN,
      approval: { audience: "team", outsideInput: false, members: [] },
    }),
  );

const ask = (actorId: string) =>
  runAsTenant(actorId || OWNER, () =>
    audience.gate({
      botId: BOT,
      serverId: APP,
      title: "Desk",
      actorId,
      initiator: { kind: "person" },
      outside: false,
    }),
  );

async function catalogue<T>(query: string): Promise<T[]> {
  return Array.from(
    (await runAsTenant("system", () =>
      database.execute(sql.raw(query)),
    )) as ArrayLike<T>,
  );
}

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
      title: "Desk",
      vendor: "Composio",
      url: `composio://${toolkit}`,
      provenance: "composio",
      authScheme: "OAUTH2",
      ...sharedColumns,
    });
    await database.insert(mcpServers).values({
      id: PRIVATE_TWIN,
      tenantId: STRANGER,
      title: "Desk (mine)",
      vendor: "Composio",
      url: `composio://${toolkit}`,
      provenance: "composio",
      authScheme: "OAUTH2",
    });
    for (const bot of bots) {
      await database.insert(agents).values({
        id: bot,
        tenantId: OWNER,
        name: bot,
        type: "built_in",
        configuration: {},
      });
      await database.insert(agentProfiles).values({
        agentId: bot,
        tenantId: OWNER,
        ownerUserId: OWNER,
        title: bot,
        roleDescription: "测试员工",
        avatarSeed: bot,
        visibility: "private",
        ...(bot === GONE_BOT ? { deletedAt: new Date() } : {}),
      });
    }
    await database.insert(pluginGrants).values({
      tenantId: OWNER,
      kind: "mcp",
      ref: `${APP}/LIST`,
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
    await database
      .update(mcpServers)
      .set(sharedColumns)
      .where(eq(mcpServers.id, APP));
  });
});

afterAll(async () => {
  await asPlatform(async () => {
    await database.delete(agents).where(inArray(agents.id, bots));
    await database
      .delete(mcpServers)
      .where(inArray(mcpServers.id, [APP, PRIVATE_TWIN]));
    await database.delete(users).where(inArray(users.id, people));
  });
  await releaseRoleWriter?.();
  await database.$client.close();
});

describe("the request table's keys and constraints", () => {
  test("a decided request carries when it was decided, and a pending one does not", async () => {
    await expect(
      runAsTenant(OWNER, async () => {
        await database.insert(sharedUseRequests).values({
          agentId: BOT,
          serverId: APP,
          proposedAudience: "owner",
          proposedOutsideInput: false,
          reason: "publish",
          requestedBy: OWNER,
          status: "approved",
        });
      }),
    ).rejects.toThrow();
  });

  test("a superseded request is decided too", async () => {
    await ask(OWNER);
    await runAsTenant(OWNER, () =>
      store.fileRequest({
        botId: BOT,
        serverId: APP,
        reason: "publish",
        requestedBy: OWNER,
        proposed: { audience: "team", outsideInput: true, members: [] },
      }),
    );
    const rows = await asPlatform(() =>
      database
        .select({
          status: sharedUseRequests.status,
          decidedAt: sharedUseRequests.decidedAt,
        })
        .from(sharedUseRequests)
        .where(eq(sharedUseRequests.agentId, BOT)),
    );
    const superseded = rows.find((row) => row.status === "superseded");
    expect(superseded?.decidedAt).toBeInstanceOf(Date);
  });

  test("every key and index on the three tables begins with tenant_id", async () => {
    const indexes = await catalogue<{ name: string; first: string }>(`
      select i.relname as "name", a.attname as "first"
      from pg_index x
      join pg_class i on i.oid = x.indexrelid
      join pg_class t on t.oid = x.indrelid
      join pg_attribute a on a.attrelid = t.oid and a.attnum = x.indkey[0]
      where t.relname in ('shared_use_approvals', 'shared_use_approval_members', 'shared_use_requests')
      order by 1
    `);
    expect(indexes.length).toBeGreaterThanOrEqual(5);
    expect(indexes.filter((index) => index.first !== "tenant_id")).toEqual([]);
  });
});

describe("the inbox reads what the owner holds", () => {
  test("even where somebody keeps a private row at the same address with a smaller id", async () => {
    await approveTeam();
    await runAsTenant(OWNER, () =>
      store.fileRequest({
        botId: BOT,
        serverId: APP,
        reason: "publish",
        requestedBy: OWNER,
        proposed: { audience: "team", outsideInput: true, members: [] },
      }),
    );
    const listed = await asPlatform(() => store.listRequests());
    expect(listed.find((row) => row.botId === BOT)?.current).toEqual({
      audience: "team",
      outsideInput: false,
      members: [],
    });
  });
});

describe("switching the account mode", () => {
  test("ends every approval, sets aside pending requests, and no approval is written while the app is Personal", async () => {
    await approveTeam();
    await ask(OWNER);
    await runAsTenant(OWNER, () =>
      store.fileRequest({
        botId: BOT,
        serverId: APP,
        reason: "publish",
        requestedBy: OWNER,
        proposed: { audience: "team", outsideInput: true, members: [] },
      }),
    );
    await asPlatform(() =>
      plugins.setAccountModeColumns(APP, "personal", null),
    );
    expect(
      await asPlatform(() =>
        database
          .select()
          .from(sharedUseApprovals)
          .where(eq(sharedUseApprovals.agentId, BOT)),
      ),
    ).toEqual([]);
    const pending = await asPlatform(() =>
      database
        .select()
        .from(sharedUseRequests)
        .where(
          and(
            eq(sharedUseRequests.agentId, BOT),
            eq(sharedUseRequests.status, "pending"),
          ),
        ),
    );
    expect(pending).toEqual([]);
    // 一条在切换之后才落下的批准不能留下来，等再切回 Shared 时复活。
    await expect(approveTeam()).rejects.toThrow();
    expect(
      await asPlatform(() =>
        database
          .select()
          .from(sharedUseApprovals)
          .where(eq(sharedUseApprovals.agentId, BOT)),
      ),
    ).toEqual([]);
  });
});

describe("closed by default", () => {
  test("a Bot whose profile cannot be read is read as private, never as the whole team", async () => {
    const facts = await runAsTenant(OWNER, () => store.botFacts(GONE_BOT));
    expect(facts.visibility).toBe("private");
    expect(facts.ownerUserId).toBeNull();
  });

  test("a call that names nobody is refused, whatever the audience", async () => {
    await approveTeam();
    expect((await ask(OWNER)).allowed).toBe(true);
    expect(await ask("")).toMatchObject({
      allowed: false,
      refusal: "shared_account_not_approved",
    });
  });
});

describe("an administrator revoking one approval", () => {
  const revoke = (actor: string) =>
    as(actor).request(`/api/plugins/shared-use/bot/${BOT}/${APP}`, {
      method: "DELETE",
    });

  test("only an administrator holding the capability, in the owner's name, with a trail row", async () => {
    await approveTeam();
    expect((await revoke(OWNER)).status).toBe(403);
    expect((await revoke(STRANGER)).status).toBe(403);
    const revoked = await revoke(ADMIN);
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ revoked: true });
    expect((await ask(OWNER)).allowed).toBe(false);
    const trail = await asPlatform(() =>
      database
        .select({
          tenantId: auditEvents.tenantId,
          payload: auditEvents.payload,
        })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.eventType, "shared_use.revoked"),
            eq(auditEvents.targetId, APP),
          ),
        ),
    );
    expect(trail).toEqual([
      { tenantId: OWNER, payload: { bot: BOT, server: APP } },
    ]);
    expect(await (await revoke(ADMIN)).json()).toEqual({ revoked: false });
  });
});
