import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import type { ApprovalRuleInput } from "../src/approvals/types";
import { type AuditInitiator, createAuditStore } from "../src/audit";
import { createAdminScope } from "../src/auth/admin-scope";
import { type AppVariables, createRoleRepository } from "../src/auth/guards";
import { setRole } from "../src/auth/roles";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  auditEvents,
  composioConnections,
  mcpServers,
  mcpTools,
  pluginGrants,
  users,
} from "../src/db/schema";
import { createAccountModeSwitch } from "../src/plugins/account-mode";
import type { ComposioBroker } from "../src/plugins/broker";
import { createPluginRoutes } from "../src/plugins/routes";
import { DEPLOYMENT_VENDOR_PREFIX } from "../src/plugins/shared-accounts";
import {
  createPluginStore,
  PluginRefusedError,
  ServerWriteRefusedError,
} from "../src/plugins/store";
import { asPlatform, runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { bindTestRoleWriter } from "./support/role-writer";

/**
 * 共享账号与账号模式（上游 #757：`account-mode.integration`、`shared-brokered-routes`、
 * `shared-gated-mode`，按 fork 改写成一个文件）。
 *
 * 断言的是安全规则本身：谁能连接团队账号（只有持有管理员能力的请求，降权的会话不行）、谁能驾驶团队账号
 * （X3 并入共享使用批准之前没有任何批准，所以谁都不能——主人、管理员、自助授权的成员、Team Bot 队友，与
 * 上游「没有批准就拒绝」一致；发起者说不清是谁在驾驶、check-in 同样拒绝）、切换模式在 vendor 处全部撤销
 * 成功之前什么都不变、切到 Shared 立起「写之前先问」规则、团队身份下的账号不论是否确认都会被撤销。
 *
 * 真实的 store、路由、管理员能力中间件和行级安全；broker 和 vendor 调用是替身，记下被问了什么。直接调用
 * 切换时在 platform 帧里（等同持有能力的管理员）；经路由时由管理员能力中间件给出能力。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const ADMIN = `sa-${suite}-admin`;
const OWNER = `sa-${suite}-owner`;
const TEAMMATE = `sa-${suite}-teammate`;
/** 会话里还是管理员、数据库里已被收回管理员角色的人。 */
const DEMOTED = `sa-${suite}-demoted`;
const people = [ADMIN, OWNER, TEAMMATE, DEMOTED];
/** OWNER 自己的私人员工（自助安装 / 给自己的员工授权的路径）。 */
const OWN_BOT = `sa-${suite}-own-bot`;
const BOT = `sa-${suite}-bot`;
const made: string[] = [];
let releaseRoleWriter: (() => Promise<void>) | undefined;

const roleOf = (id: string) =>
  id === ADMIN || id === DEMOTED ? "admin" : "user";

/** broker 替身：持有的团队身份、被问的撤销与链接，以及一个会失败的撤销。 */
function fakeBroker() {
  const asked = {
    authorized: [] as { userId: string; toolkit: string }[],
    revoked: [] as string[],
    fields: [] as string[],
  };
  const held = new Set<string>();
  const failing = new Set<string>();
  const broker = {
    authorize: async (request: { userId: string; toolkit: string }) => {
      asked.authorized.push({
        userId: request.userId,
        toolkit: request.toolkit,
      });
      return { redirectUrl: "https://connect.composio.test/link" };
    },
    isConnected: async ({ userId }: { userId: string }) => held.has(userId),
    revoke: async ({ userId }: { userId: string }) => {
      if (failing.has(userId)) throw new Error("the vendor did not answer");
      asked.revoked.push(userId);
      held.delete(userId);
      return true;
    },
    deleteAuthConfig: async () => {},
    connectionFields: async () => [
      {
        name: "subdomain",
        label: "Subdomain",
        help: "Your store's subdomain.",
        required: true,
        secret: false,
      },
    ],
    connectWithFields: async ({ userId }: { userId: string }) => {
      asked.fields.push(userId);
      held.add(userId);
      return { accountId: "ca_team" };
    },
  } as unknown as ComposioBroker;
  return { broker, asked, held, failing };
}

/** 团队规则的替身：只记下写了什么、撤了什么。 */
function fakeTeamRules() {
  const rules: (ApprovalRuleInput & {
    id: string;
    revokedAt: Date | null;
    createdAt: Date;
    createdBy: string | null;
  })[] = [];
  return {
    rules,
    store: {
      teamRules: async () => rules,
      createTeamRule: async (by: string, input: ApprovalRuleInput) => {
        const rule = {
          ...input,
          id: randomUUID(),
          revokedAt: null,
          createdAt: new Date(),
          createdBy: by,
        };
        rules.push(rule);
        return rule as never;
      },
      revokeTeamRule: async (_by: string, id: string) => {
        const rule = rules.find((candidate) => candidate.id === id);
        if (rule) rule.revokedAt = new Date();
      },
    } as never,
  };
}

function harness(options: { deploymentId?: string } = {}) {
  const toolkit = `shared_${suite.replace(/-/g, "_")}_${made.length}`;
  made.push(toolkit);
  const vendor = fakeBroker();
  const rules = fakeTeamRules();
  const reached: string[] = [];
  const store = createPluginStore({
    database,
    auditStore: createAuditStore(database),
    credentials: { readSecret: async () => null } as never,
    encryptionKey: "x".repeat(44),
    policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
    broker: vendor.broker,
    callVendor: async (connection) => {
      reached.push(connection.actorId ?? "");
      return { text: "ok", isError: false };
    },
  });
  const modes = createAccountModeSwitch({
    store,
    teamRules: rules.store,
    deploymentId: options.deploymentId ?? `acme-${suite}`,
    audit: createAuditStore(database),
  });
  const adminScope = createAdminScope({
    roleRepository: createRoleRepository(database),
  });
  const as = (id: string) => {
    const session: MiddlewareHandler<{ Variables: AppVariables }> = async (
      context,
      next,
    ) => {
      context.set("actor", {
        id,
        email: `${id}@example.test`,
        role: roleOf(id),
      } as never);
      await runAsTenant(id, () => next());
    };
    return new Hono().route(
      "/api/plugins",
      createPluginRoutes(
        store,
        session,
        async () => true,
        {
          publicUrl: "https://openbot.example",
          appUrl: "https://app.example",
          encryptionKey: `${"A".repeat(43)}=`,
          personHasAccess: async () => true,
        },
        { broker: vendor.broker },
        adminScope,
        modes,
      ),
    );
  };
  const ref = `${toolkit}/APP_LIST`;
  const call = (
    actorId: string,
    // null：这次运行没有说明是什么开始的（不能用 undefined，那会取默认值）。
    initiator: AuditInitiator | null = { kind: "person" },
    args: Record<string, unknown> = {},
  ) =>
    runAsTenant(actorId, () =>
      store.callTool({
        ref,
        args,
        botId: BOT,
        actorId,
        ...(initiator ? { initiator } : {}),
      }),
    );
  return { toolkit, vendor, rules, reached, store, modes, as, ref, call };
}

/** 一个管理员启用的 broker 应用（`team` 标记），一个读动作，授给团队员工。 */
async function enable(toolkit: string, scheme: string) {
  await asPlatform(async () => {
    await database.insert(mcpServers).values({
      id: toolkit,
      tenantId: "team",
      title: "Acme",
      vendor: "Composio",
      url: `composio://${toolkit}`,
      provenance: "composio",
      authScheme: scheme,
    });
    await database.insert(mcpTools).values({
      serverId: toolkit,
      tenantId: "team",
      name: "APP_LIST",
      description: "Lists things.",
      effect: "read",
      version: "20260903_00",
    });
    await database.insert(pluginGrants).values({
      tenantId: "team",
      kind: "mcp",
      ref: `${toolkit}/APP_LIST`,
      agentId: BOT,
      grantedBy: OWNER,
    });
  });
}

async function connectPerson(toolkit: string, userId: string) {
  await runAsTenant(userId, () =>
    database
      .insert(composioConnections)
      .values({ toolkit, userId, verified: true }),
  );
}

async function appRow(toolkit: string) {
  const [row] = await asPlatform(() =>
    database.select().from(mcpServers).where(eq(mcpServers.id, toolkit)),
  );
  return row;
}

beforeAll(async () => {
  releaseRoleWriter = await bindTestRoleWriter(database);
  await asPlatform(async () => {
    await database
      .insert(users)
      .values(people.map((id) => ({ id, email: `${id}@example.test` })));
    await setRole(database, ADMIN, "admin");
    // OWNER 的团队员工：公开，所以队友也看得到、能用。
    await database.insert(agents).values({
      id: BOT,
      tenantId: "team",
      name: "Desk",
      type: "built_in",
      configuration: {},
    });
    await database.insert(agentProfiles).values({
      agentId: BOT,
      tenantId: "team",
      ownerUserId: OWNER,
      title: "Desk",
      roleDescription: "测试员工",
      avatarSeed: suite,
      visibility: "public",
    });
    await database.insert(agents).values({
      id: OWN_BOT,
      tenantId: OWNER,
      name: "Mine",
      type: "built_in",
      configuration: {},
    });
    await database.insert(agentProfiles).values({
      agentId: OWN_BOT,
      tenantId: OWNER,
      ownerUserId: OWNER,
      title: "Mine",
      roleDescription: "测试员工",
      avatarSeed: `${suite}-own`,
      visibility: "private",
    });
  });
});

afterAll(async () => {
  await asPlatform(async () => {
    if (made.length) {
      await database
        .delete(composioConnections)
        .where(inArray(composioConnections.toolkit, made));
      await database
        .delete(pluginGrants)
        .where(inArray(pluginGrants.agentId, [BOT, OWN_BOT]));
      await database.delete(mcpServers).where(inArray(mcpServers.id, made));
    }
    await database.delete(agents).where(inArray(agents.id, [BOT, OWN_BOT]));
    await database.delete(users).where(inArray(users.id, people));
  });
  await releaseRoleWriter?.();
  await database.$client.close();
});

/** 切到 Shared 并由管理员连好团队账号。 */
async function sharedAndConnected(h: ReturnType<typeof harness>) {
  const switched = await asPlatform(() =>
    h.modes.switchMode({
      serverId: h.toolkit,
      mode: "shared",
      by: ADMIN,
      confirm: true,
    }),
  );
  expect(switched).toEqual({ changed: true, revoked: 0 });
  const vendorId = (await appRow(h.toolkit))?.sharedVendorUserId ?? "";
  h.vendor.held.add(vendorId);
  const confirmed = await h
    .as(ADMIN)
    .request(`/api/plugins/servers/${h.toolkit}/connection/confirm`, {
      method: "POST",
    });
  expect(await confirmed.json()).toEqual({ connected: true });
  return vendorId;
}

describe("switching an app between Personal and Shared", () => {
  test("nothing changes until every person's account is ended at the vendor", async () => {
    const h = harness();
    await enable(h.toolkit, "OAUTH2");
    await connectPerson(h.toolkit, OWNER);
    await connectPerson(h.toolkit, TEAMMATE);
    h.vendor.failing.add(TEAMMATE);

    const preview = await asPlatform(() =>
      h.modes.preview(h.toolkit, "shared"),
    );
    expect(preview).toEqual({
      mode: "shared",
      current: "personal",
      wouldRevoke: { holder: "person", count: 2 },
    });
    // 只预览不确认：什么都不做。
    const unconfirmed = await asPlatform(() =>
      h.modes.switchMode({
        serverId: h.toolkit,
        mode: "shared",
        by: ADMIN,
        confirm: false,
      }),
    );
    expect(unconfirmed).toEqual({ changed: false, preview });
    expect(h.vendor.asked.revoked).toEqual([]);

    const failed = await asPlatform(() =>
      h.modes.switchMode({
        serverId: h.toolkit,
        mode: "shared",
        by: ADMIN,
        confirm: true,
      }),
    );
    expect(failed).toMatchObject({
      changed: false,
      failures: [{ account: TEAMMATE }],
    });
    // 模式没变，没有团队身份，也没有立规则；撤销成功的那一行删掉了。
    expect((await appRow(h.toolkit))?.accountMode).toBe("personal");
    expect((await appRow(h.toolkit))?.sharedVendorUserId).toBeNull();
    expect(h.rules.rules).toEqual([]);
    expect(h.vendor.asked.revoked).toEqual([OWNER]);

    h.vendor.failing.clear();
    const switched = await asPlatform(() =>
      h.modes.switchMode({
        serverId: h.toolkit,
        mode: "shared",
        by: ADMIN,
        confirm: true,
      }),
    );
    expect(switched).toEqual({ changed: true, revoked: 1 });
    const row = await appRow(h.toolkit);
    expect(row?.accountMode).toBe("shared");
    expect(row?.sharedVendorUserId).toStartWith(
      `${DEPLOYMENT_VENDOR_PREFIX}acme-${suite}:`,
    );
    expect(
      await asPlatform(() =>
        database
          .select()
          .from(composioConnections)
          .where(eq(composioConnections.toolkit, h.toolkit)),
      ),
    ).toEqual([]);
    // 写之前先问：一条，针对这个应用的所有写动作。
    expect(
      h.rules.rules.map(({ botId, toolRef, effect, scope, behaviour }) => ({
        botId,
        toolRef,
        effect,
        scope,
        behaviour,
      })),
    ).toEqual([
      {
        botId: "*",
        toolRef: `${h.toolkit}/*`,
        effect: "write",
        scope: h.toolkit,
        behaviour: "ask",
      },
    ]);
    const trail = await asPlatform(() =>
      database
        .select({ payload: auditEvents.payload })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.eventType, "configuration.changed"),
            eq(auditEvents.targetId, h.toolkit),
          ),
        ),
    );
    expect(trail.map((entry) => entry.payload)).toContainEqual(
      expect.objectContaining({ change: "account_mode", mode: "shared" }),
    );
  });

  test("switching back ends the team account and the rule, and a repeat switch mints nothing", async () => {
    const h = harness();
    await enable(h.toolkit, "OAUTH2");
    const vendorId = await sharedAndConnected(h);

    // 已经是 Shared：不铸新身份，规则不重复。
    await asPlatform(() =>
      h.modes.switchMode({
        serverId: h.toolkit,
        mode: "shared",
        by: ADMIN,
        confirm: true,
      }),
    );
    expect((await appRow(h.toolkit))?.sharedVendorUserId).toBe(vendorId);
    expect(h.rules.rules.filter((rule) => !rule.revokedAt)).toHaveLength(1);

    const back = await asPlatform(() =>
      h.modes.switchMode({
        serverId: h.toolkit,
        mode: "personal",
        by: ADMIN,
        confirm: true,
      }),
    );
    expect(back).toEqual({ changed: true, revoked: 1 });
    expect(h.vendor.asked.revoked).toEqual([vendorId]);
    const row = await appRow(h.toolkit);
    expect(row?.accountMode).toBe("personal");
    expect(row?.sharedVendorUserId).toBeNull();
    expect(row?.sharedConnectedAt).toBeNull();
    expect(h.rules.rules.every((rule) => rule.revokedAt !== null)).toBe(true);
  });

  test("the store itself refuses a switch from a frame without the administrator's capability", async () => {
    const h = harness();
    await enable(h.toolkit, "OAUTH2");
    await expect(
      runAsTenant(ADMIN, () =>
        h.modes.switchMode({
          serverId: h.toolkit,
          mode: "shared",
          by: ADMIN,
          confirm: true,
        }),
      ),
    ).rejects.toThrow();
    expect((await appRow(h.toolkit))?.accountMode).toBe("personal");
  });

  test("only an administrator can preview or switch, through the routes", async () => {
    const h = harness();
    await enable(h.toolkit, "OAUTH2");
    const asMember = await h
      .as(OWNER)
      .request(`/api/plugins/servers/${h.toolkit}/account-mode`, {
        method: "PUT",
        body: JSON.stringify({ mode: "shared", confirm: true }),
        headers: { "content-type": "application/json" },
      });
    expect(asMember.status).toBe(403);
    const preview = await h
      .as(ADMIN)
      .request(`/api/plugins/servers/${h.toolkit}/account-mode?mode=shared`);
    expect(preview.status).toBe(200);
    const done = await h
      .as(ADMIN)
      .request(`/api/plugins/servers/${h.toolkit}/account-mode`, {
        method: "PUT",
        body: JSON.stringify({ mode: "shared", confirm: true }),
        headers: { "content-type": "application/json" },
      });
    expect(await done.json()).toEqual({ changed: true, revoked: 0 });
    expect((await appRow(h.toolkit))?.accountMode).toBe("shared");
  });
});

describe("connecting the team account", () => {
  test("only an administrator connects it, under the team identity and never their own", async () => {
    const h = harness();
    await enable(h.toolkit, "OAUTH2");
    await asPlatform(() =>
      h.modes.switchMode({
        serverId: h.toolkit,
        mode: "shared",
        by: ADMIN,
        confirm: true,
      }),
    );
    const vendorId = (await appRow(h.toolkit))?.sharedVendorUserId;

    const member = await h
      .as(OWNER)
      .request(`/api/plugins/servers/${h.toolkit}/connect`, {
        method: "POST",
      });
    expect(member.status).toBe(403);

    const admin = await h
      .as(ADMIN)
      .request(`/api/plugins/servers/${h.toolkit}/connect`, {
        method: "POST",
      });
    expect(admin.status).toBe(200);
    expect(h.vendor.asked.authorized).toEqual([
      { userId: vendorId as string, toolkit: h.toolkit },
    ]);

    // vendor 还没有这个账号：确认什么都不写。
    const early = await h
      .as(ADMIN)
      .request(`/api/plugins/servers/${h.toolkit}/connection/confirm`, {
        method: "POST",
      });
    expect(await early.json()).toEqual({ connected: false });
    expect((await appRow(h.toolkit))?.sharedConnectedAt).toBeNull();

    h.vendor.held.add(vendorId as string);
    const confirmed = await h
      .as(ADMIN)
      .request(`/api/plugins/servers/${h.toolkit}/connection/confirm`, {
        method: "POST",
      });
    expect(await confirmed.json()).toEqual({ connected: true });
    const row = await appRow(h.toolkit);
    expect(row?.sharedConnectedBy).toBe(ADMIN);
    expect(row?.sharedVerified).toBe(true);
    // 没有任何人的个人连接行被写。
    expect(
      await asPlatform(() =>
        database
          .select()
          .from(composioConnections)
          .where(eq(composioConnections.toolkit, h.toolkit)),
      ),
    ).toEqual([]);

    const again = await h
      .as(ADMIN)
      .request(`/api/plugins/servers/${h.toolkit}/connect`, {
        method: "POST",
      });
    expect(again.status).toBe(409);

    // 列表：成员看到团队账号已连接、不能连接；浏览器拿不到团队身份。
    const listing = await h.as(OWNER).request("/api/plugins");
    const body = (await listing.json()) as {
      servers: {
        id: string;
        accountMode?: string;
        canConnect: boolean;
        sharedAccount?: { connected: boolean } | null;
      }[];
    };
    const server = body.servers.find((candidate) => candidate.id === h.toolkit);
    expect(server?.accountMode).toBe("shared");
    expect(server?.canConnect).toBe(false);
    expect(server?.sharedAccount?.connected).toBe(true);
    expect(JSON.stringify(body)).not.toContain(DEPLOYMENT_VENDOR_PREFIX);

    // 断开：成员不行，管理员可以。
    const memberEnds = await h
      .as(OWNER)
      .request(`/api/plugins/servers/${h.toolkit}/connection`, {
        method: "DELETE",
      });
    expect(memberEnds.status).toBe(403);
    const ended = await h
      .as(ADMIN)
      .request(`/api/plugins/servers/${h.toolkit}/connection`, {
        method: "DELETE",
      });
    expect(await ended.json()).toEqual({ vendorRevocationRequested: true });
    expect(h.vendor.asked.revoked).toEqual([vendorId as string]);
    expect((await appRow(h.toolkit))?.sharedConnectedAt).toBeNull();
  });

  test("an app on the deployment's own client is connected as the team account by an administrator", async () => {
    const h = harness();
    await enable(h.toolkit, "S2S_OAUTH2");
    await asPlatform(() =>
      h.modes.switchMode({
        serverId: h.toolkit,
        mode: "shared",
        by: ADMIN,
        confirm: true,
      }),
    );
    const form = await h
      .as(ADMIN)
      .request(`/api/plugins/servers/${h.toolkit}/connect`, {
        method: "POST",
      });
    expect(await form.json()).toMatchObject({
      fields: [{ name: "subdomain" }],
    });
    const connected = await h
      .as(ADMIN)
      .request(`/api/plugins/servers/${h.toolkit}/connect`, {
        method: "POST",
        body: JSON.stringify({ values: { subdomain: "acme" } }),
        headers: { "content-type": "application/json" },
      });
    expect(await connected.json()).toEqual({
      connected: true,
      verified: false,
    });
    expect(h.vendor.asked.fields).toEqual([
      (await appRow(h.toolkit))?.sharedVendorUserId as string,
    ]);
    const listing = await h.as(OWNER).request("/api/plugins");
    const server = (
      (await listing.json()) as {
        servers: {
          id: string;
          sharedOnly?: boolean;
          adminConnectOnly: boolean;
        }[];
      }
    ).servers.find((candidate) => candidate.id === h.toolkit);
    expect(server?.sharedOnly).toBe(true);
    expect(server?.adminConnectOnly).toBe(true);
  });

  test("a Shared app has no personal accounts to list, default or end one by one", async () => {
    const h = harness();
    await enable(h.toolkit, "OAUTH2");
    await sharedAndConnected(h);
    const listed = await h
      .as(OWNER)
      .request(`/api/plugins/servers/${h.toolkit}/accounts`);
    expect(await listed.json()).toEqual({ accounts: [], canAddAnother: false });
    const defaulted = await h
      .as(OWNER)
      .request(
        `/api/plugins/servers/${h.toolkit}/accounts/${randomUUID()}/default`,
        {
          method: "POST",
        },
      );
    expect(defaulted.status).toBe(400);
  });
});

describe("guarding the team account itself", () => {
  test("a session that still says admin, without the role behind it, cannot connect, confirm or end it, and the vendor is never asked", async () => {
    const h = harness();
    await enable(h.toolkit, "OAUTH2");
    const vendorId = await sharedAndConnected(h);
    h.vendor.asked.authorized.length = 0;

    const demoted = h.as(DEMOTED);
    const ended = await demoted.request(
      `/api/plugins/servers/${h.toolkit}/connection`,
      { method: "DELETE" },
    );
    expect(ended.status).toBe(403);
    const confirmed = await demoted.request(
      `/api/plugins/servers/${h.toolkit}/connection/confirm`,
      { method: "POST" },
    );
    expect(confirmed.status).toBe(403);
    expect(h.vendor.asked.revoked).toEqual([]);
    expect((await appRow(h.toolkit))?.sharedConnectedAt).not.toBeNull();

    // 断开之后再连：降权的会话拿不到以团队身份发起的授权链接。
    await h.as(ADMIN).request(`/api/plugins/servers/${h.toolkit}/connection`, {
      method: "DELETE",
    });
    expect(h.vendor.asked.revoked).toEqual([vendorId]);
    const connect = await demoted.request(
      `/api/plugins/servers/${h.toolkit}/connect`,
      { method: "POST" },
    );
    expect(connect.status).toBe(403);
    expect(h.vendor.asked.authorized).toEqual([]);

    // store 自己也拒绝：没有管理员能力的帧里，团队账号方法在问 vendor 之前就停下。
    await expect(
      runAsTenant(DEMOTED, () =>
        h.store.disconnectShared({
          toolkit: h.toolkit,
          by: DEMOTED,
          reason: "self",
        }),
      ),
    ).rejects.toThrow();
    expect(h.vendor.asked.revoked).toEqual([vendorId]);
  });

  test("a key app's team account is never connected from a frame without the administrator's capability", async () => {
    // 填写字段的应用：没有能力检查的话，下面这一步会把内容以团队身份交给 vendor（复核 N4）。
    const h = harness();
    await enable(h.toolkit, "API_KEY");
    await asPlatform(() =>
      h.modes.switchMode({
        serverId: h.toolkit,
        mode: "shared",
        by: ADMIN,
        confirm: true,
      }),
    );

    await expect(
      runAsTenant(ADMIN, () =>
        h.store.connectSharedWithFields({
          toolkit: h.toolkit,
          values: { api_key: "a-key" },
          by: ADMIN,
        }),
      ),
    ).rejects.toBeInstanceOf(ServerWriteRefusedError);
    expect(h.vendor.asked.fields).toEqual([]);

    // 同一个调用在持有能力的帧里（platform 等同）照常连上，说明拦下它的就是能力检查。
    await asPlatform(() =>
      h.store.connectSharedWithFields({
        toolkit: h.toolkit,
        values: { api_key: "a-key" },
        by: ADMIN,
      }),
    );
    expect(h.vendor.asked.fields).toEqual([
      (await appRow(h.toolkit))?.sharedVendorUserId as string,
    ]);
  });

  test("an account authorised under the team identity but never confirmed is ended when the app goes back to Personal", async () => {
    const h = harness();
    await enable(h.toolkit, "OAUTH2");
    await asPlatform(() =>
      h.modes.switchMode({
        serverId: h.toolkit,
        mode: "shared",
        by: ADMIN,
        confirm: true,
      }),
    );
    const vendorId = (await appRow(h.toolkit))?.sharedVendorUserId as string;
    // 管理员在同意屏幕上授权了，却没有回来确认。
    h.vendor.held.add(vendorId);
    expect((await appRow(h.toolkit))?.sharedConnectedAt).toBeNull();

    // 撤销失败：模式与团队身份都不变，这个账号仍能从这里被撤销。
    h.vendor.failing.add(vendorId);
    const failed = await asPlatform(() =>
      h.modes.switchMode({
        serverId: h.toolkit,
        mode: "personal",
        by: ADMIN,
        confirm: true,
      }),
    );
    expect(failed).toMatchObject({ changed: false });
    expect((await appRow(h.toolkit))?.accountMode).toBe("shared");
    expect((await appRow(h.toolkit))?.sharedVendorUserId).toBe(vendorId);

    h.vendor.failing.clear();
    const back = await asPlatform(() =>
      h.modes.switchMode({
        serverId: h.toolkit,
        mode: "personal",
        by: ADMIN,
        confirm: true,
      }),
    );
    expect(back).toEqual({ changed: true, revoked: 1 });
    expect(h.vendor.asked.revoked).toEqual([vendorId]);
    expect(h.vendor.held.has(vendorId)).toBe(false);
  });

  test("removing a Shared app ends its team account, confirmed or not, and the trail never names the team identity", async () => {
    const h = harness();
    await enable(h.toolkit, "OAUTH2");
    await asPlatform(() =>
      h.modes.switchMode({
        serverId: h.toolkit,
        mode: "shared",
        by: ADMIN,
        confirm: true,
      }),
    );
    const vendorId = (await appRow(h.toolkit))?.sharedVendorUserId as string;
    h.vendor.held.add(vendorId);

    await asPlatform(() => h.store.removeServer(h.toolkit, ADMIN));

    expect(h.vendor.asked.revoked).toEqual([vendorId]);
    const trail = await asPlatform(() =>
      database
        .select({ payload: auditEvents.payload })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.eventType, "mcp.account_disconnected"),
            eq(auditEvents.targetId, h.toolkit),
          ),
        ),
    );
    expect(trail.map((entry) => entry.payload)).toContainEqual(
      expect.objectContaining({ holder: "deployment" }),
    );
    expect(JSON.stringify(trail)).not.toContain(DEPLOYMENT_VENDOR_PREFIX);
  });

  test("a deployment with no id refuses the switch before anybody's account is ended", async () => {
    const h = harness({ deploymentId: "  " });
    await enable(h.toolkit, "OAUTH2");
    await connectPerson(h.toolkit, OWNER);

    await expect(
      asPlatform(() =>
        h.modes.switchMode({
          serverId: h.toolkit,
          mode: "shared",
          by: ADMIN,
          confirm: true,
        }),
      ),
    ).rejects.toThrow(/DEPLOYMENT_ID/);
    expect(h.vendor.asked.revoked).toEqual([]);
    expect(
      await asPlatform(() =>
        database
          .select()
          .from(composioConnections)
          .where(eq(composioConnections.toolkit, h.toolkit)),
      ),
    ).toHaveLength(1);
  });
});

describe("who may steer a run on the team account", () => {
  test("without an administrator's approval nobody reaches it: not the owner, not an administrator", async () => {
    const h = harness();
    await enable(h.toolkit, "OAUTH2");
    await sharedAndConnected(h);

    for (const [actor, initiator] of [
      [OWNER, { kind: "person" }],
      [ADMIN, { kind: "person" }],
      [
        OWNER,
        { kind: "handoff", id: "another-bot", origin: { kind: "person" } },
      ],
    ] as [string, AuditInitiator][]) {
      const refused = h.call(actor, initiator);
      await expect(refused).rejects.toBeInstanceOf(PluginRefusedError);
      await expect(refused).rejects.toThrow(/管理员还没有批准/);
    }
    expect(h.reached).toEqual([]);
  });

  test("a member who grants the app to their own Bot still does not reach the team account", async () => {
    const h = harness();
    await enable(h.toolkit, "OAUTH2");
    await sharedAndConnected(h);
    // 成员给自己的员工授予这个应用的工具（自助安装落在同一处）。
    await runAsTenant(OWNER, () => h.store.grant("mcp", h.ref, OWN_BOT, OWNER));

    const refused = runAsTenant(OWNER, () =>
      h.store.callTool({
        ref: h.ref,
        args: {},
        botId: OWN_BOT,
        actorId: OWNER,
        initiator: { kind: "person" },
      }),
    );
    await expect(refused).rejects.toBeInstanceOf(PluginRefusedError);
    await expect(refused).rejects.toThrow(/管理员还没有批准/);
    expect(h.reached).toEqual([]);
  });

  test("a teammate on the owner's Team Bot does not reach the team account", async () => {
    const h = harness();
    await enable(h.toolkit, "OAUTH2");
    await sharedAndConnected(h);

    const refused = h.call(TEAMMATE);
    await expect(refused).rejects.toBeInstanceOf(PluginRefusedError);
    await expect(refused).rejects.toThrow(/管理员还没有批准/);
    expect(h.reached).toEqual([]);
    const trail = await asPlatform(() =>
      database
        .select({ payload: auditEvents.payload })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.eventType, "mcp.call_rejected"),
            eq(auditEvents.targetId, h.ref),
          ),
        ),
    );
    expect(
      trail.map((entry) => (entry.payload as { refusal?: string }).refusal),
    ).toContain("shared_account_not_approved");
  });

  test("a run that cannot say who is steering, a check-in, or outside input is refused", async () => {
    const h = harness();
    await enable(h.toolkit, "OAUTH2");
    await sharedAndConnected(h);

    for (const initiator of [
      null,
      { kind: "deployment" },
      { kind: "handoff", id: "another-bot" },
      { kind: "responsibility", id: "duty-1" },
      { kind: "routine", id: "proactive:check-in-1" },
    ] as (AuditInitiator | null)[]) {
      await expect(h.call(OWNER, initiator)).rejects.toBeInstanceOf(
        PluginRefusedError,
      );
    }
    expect(h.reached).toEqual([]);
  });

  test("a named account is refused, and an unconnected team account is refused", async () => {
    const h = harness();
    await enable(h.toolkit, "OAUTH2");
    await asPlatform(() =>
      h.modes.switchMode({
        serverId: h.toolkit,
        mode: "shared",
        by: ADMIN,
        confirm: true,
      }),
    );
    // X3 之前共享闸门先拒绝（没有批准），未连接的检查在它之后，同样到不了 vendor。
    await expect(h.call(OWNER)).rejects.toBeInstanceOf(PluginRefusedError);
    await expect(
      h.call(OWNER, { kind: "person" }, { account: "x@example.test" }),
    ).rejects.toThrow(/没有账号可选/);
    expect(h.reached).toEqual([]);
  });

  test("a Personal app still runs in the asker's own account", async () => {
    const h = harness();
    await enable(h.toolkit, "OAUTH2");
    await connectPerson(h.toolkit, OWNER);
    expect((await h.call(OWNER)).isError).toBe(false);
    expect(h.reached).toEqual([OWNER]);
  });
});
