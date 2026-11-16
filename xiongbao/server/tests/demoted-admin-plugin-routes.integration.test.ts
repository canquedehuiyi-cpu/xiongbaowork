import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { createAuditStore } from "../src/audit";
import { createAdminScope } from "../src/auth/admin-scope";
import { type AppVariables, createRoleRepository } from "../src/auth/guards";
import { setRole } from "../src/auth/roles";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  mcpServers,
  mcpTools,
  users,
} from "../src/db/schema";
import { createAccountModeSwitch } from "../src/plugins/account-mode";
import type { ComposioBroker } from "../src/plugins/broker";
import { adminConnectOnlySentence } from "../src/plugins/deployment-clients";
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
 * 会话给出的角色和 `user_roles` 可以不一致：管理员的角色已被收回，会话还说是 admin。只看会话角色的管理员
 * 写路径会让这个人继续做管理员的事。这里的 DEMOTED 就是这样的人：会话写着 admin，`user_roles` 里没有
 * 管理员角色，`adminCapability` 重新读过角色后不给能力。
 *
 * 这一份看插件路由自己能判断的那些路径（接了 `adminScope` 的装配，真实的 store 和数据库）：
 *
 * - 一次保存员工在一个应用上的几个动作：授予写在本人自己的帧里，行安全拦不住，所以在入口核对能力。
 * - 改部署的应用（添加、换令牌、登记 OAuth 客户端、刷新、移除、启用 broker 应用）：store 在动手之前已经
 *   拒绝，这里钉的是路由把这次拒绝答成 403 和一句中文，而不是 400 或 500。
 * - 账号模式的预览和切换、用部署自己的客户端连接：入口核对能力。
 * - 应用列表里的 `canConnect`：按成员来答。
 *
 * 每一条都看两件事：答的是 403 和那句中文，以及数据库里和厂商那边什么都没有动。单个授予和上下架两组
 * 路由在装配层核对，见 `demoted-admin-plugin-gate.integration.test.ts`。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const id = (name: string) => `dap-${suite}-${name}`;
const ADMIN = id("admin");
/** 会话里还是管理员、`user_roles` 里已被收回管理员角色的人。 */
const DEMOTED = id("demoted");
const MEMBER = id("member");
const people = [ADMIN, DEMOTED, MEMBER];
/** DEMOTED 自己的私人员工：他在自己的帧里就是它的主人，授予写得进去。 */
const OWN_BOT = id("own-bot");
const MEMBERS_BOT = id("members-bot");
const slug = suite.replace(/-/g, "_");
/** 个人账号的 broker 应用，没有上架。 */
const APP = `dap_app_${slug}`;
/** Shared 应用，已连团队账号。 */
const TEAM_APP = `dap_team_${slug}`;
/** 用部署自己的客户端连接的应用：只有管理员能连。 */
const S2S_APP = `dap_s2s_${slug}`;
/** 管理员按地址添加的服务器。 */
const CUSTOM = `dap-custom-${suite}`;
/** broker 目录里还没有启用的应用。 */
const NEW_APP = `dapnew${slug}`;
const ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const CAPABILITY_UNCONFIRMED = "你的管理员身份没能确认，没有改变任何东西。";
let releaseRoleWriter: (() => Promise<void>) | undefined;
const realFetch = globalThis.fetch;

/** 厂商那边被问到的每一件事。被降权的人的请求一件都不该留下。 */
const vendor: string[] = [];
const broker = {
  listApps: async () => {
    vendor.push("listApps");
    return [
      {
        slug: NEW_APP,
        name: "New",
        description: "",
        logo: null,
        categories: [],
        actionCount: 1,
        connection: { kind: "consent" },
      },
    ];
  },
  ensureAuthConfig: async () => {
    vendor.push("ensureAuthConfig");
    return "created";
  },
  connectionFields: async () => {
    vendor.push("connectionFields");
    return [];
  },
  isConnected: async () => false,
  revoke: async () => {
    vendor.push("revoke");
    return true;
  },
  deleteAuthConfig: async () => {
    vendor.push("deleteAuthConfig");
  },
  listTools: async () => {
    vendor.push("listTools");
    return [];
  },
} as unknown as ComposioBroker;

const audit = createAuditStore(database);
const sharedStore = createSharedUseStore(database);
const audience = createSharedAudience(database, sharedStore, audit);
const plugins = createPluginStore({
  database,
  auditStore: audit,
  credentials: createCredentialStore(database),
  encryptionKey: ENCRYPTION_KEY,
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  broker,
  sharedUse: audience.gate,
  sharedAdmits: audience.admitsPerson,
  outboundLookup: async () => [{ address: "93.184.216.34", family: 4 }],
});
const adminScope = createAdminScope({
  roleRepository: createRoleRepository(database),
});
const modes = createAccountModeSwitch({
  store: plugins,
  teamRules: {
    teamRules: async () => [],
    createTeamRule: async () => ({}) as never,
    revokeTeamRule: async () => {},
  } as never,
  deploymentId: `acme-${suite}`,
  audit,
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
        encryptionKey: ENCRYPTION_KEY,
        personHasAccess: async () => true,
      },
      { broker, sharedUse: { store: sharedStore, audience } },
      adminScope,
      modes,
    ),
  );
}

const request = (actor: string, method: string, path: string, body?: unknown) =>
  as(actor).request(`/api/plugins${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/** 这个套件碰得到的每一张表里属于它的行，按 platform 读出来，用来比较请求前后。 */
async function everything() {
  const rows = async (query: ReturnType<typeof sql>) =>
    JSON.stringify(
      Array.from(
        (await database.execute(query)) as unknown as ArrayLike<unknown>,
      ),
    );
  return asPlatform(async () => ({
    grants: await rows(
      sql`select kind, ref, agent_id, tenant_id from plugin_grants where agent_id like ${`dap-${suite}-%`} order by 1, 2, 3`,
    ),
    servers: await rows(
      sql`select to_jsonb(s) - 'updated_at' as server from mcp_servers s where id like ${`dap%${suite}%`} or id like ${`%${slug}%`} order by id`,
    ),
    tools: await rows(
      sql`select server_id, name from mcp_tools where server_id like ${`dap%${suite}%`} or server_id like ${`%${slug}%`} order by 1, 2`,
    ),
    secrets: await rows(
      sql`select kind, provider from credentials where provider like ${`dap%${suite}%`} or provider like ${`%${slug}%`} order by 1, 2`,
    ),
    connections: await rows(
      sql`select toolkit, user_id from composio_connections where user_id like ${`dap-${suite}-%`} order by 1, 2`,
    ),
    approvals: await rows(
      sql`select agent_id from shared_use_approvals where agent_id like ${`dap-${suite}-%`} order by 1`,
    ),
    trail: await rows(
      sql`select event_type from audit_events where tenant_id = ${DEMOTED} or actor_user_id = ${DEMOTED} or payload::text like ${`%${DEMOTED}%`} order by created_at`,
    ),
  }));
}

/** 这次请求被拒绝：403、那句中文，数据库里和厂商那边什么都没有动。 */
async function refusedLeavingNothing(
  ask: () => Response | Promise<Response>,
  sentence = CAPABILITY_UNCONFIRMED,
) {
  const before = await everything();
  vendor.length = 0;
  const response = await ask();
  expect({
    status: response.status,
    body: await response.json(),
  }).toEqual({ status: 403, body: { error: sentence } });
  expect(await everything()).toEqual(before);
  expect(vendor).toEqual([]);
}

const grantsOf = (botId: string) =>
  asPlatform(async () =>
    Array.from(
      (await database.execute(
        sql`select ref from plugin_grants where agent_id = ${botId} order by ref`,
      )) as unknown as ArrayLike<{ ref: string }>,
    ).map((row) => row.ref),
  );

beforeAll(async () => {
  // 添加和刷新会去问服务器；被降权的人的请求走不到那一步，这里只是保证走到了也不出网。
  globalThis.fetch = (async () =>
    new Response("{}", { status: 500 })) as unknown as typeof fetch;
  releaseRoleWriter = await bindTestRoleWriter(database);
  await asPlatform(async () => {
    await database
      .insert(users)
      .values(
        people.map((person) => ({ id: person, email: `${person}@x.test` })),
      );
    await setRole(database, ADMIN, "admin");
    for (const [app, scheme, mode] of [
      [APP, "OAUTH2", "personal"],
      [TEAM_APP, "OAUTH2", "shared"],
      [S2S_APP, "S2S_OAUTH2", "personal"],
    ] as const) {
      await database.insert(mcpServers).values({
        id: app,
        tenantId: "team",
        title: app,
        vendor: "Composio",
        url: `composio://${app}`,
        provenance: "composio",
        authScheme: scheme,
        accountMode: mode,
        ...(mode === "shared"
          ? {
              sharedVendorUserId: `openbot-deployment:${suite}:R`,
              sharedConnectedAt: new Date(),
              sharedConnectedBy: ADMIN,
              sharedVerified: true,
            }
          : {}),
      });
    }
    await database.insert(mcpServers).values({
      id: CUSTOM,
      tenantId: "team",
      title: "Custom",
      vendor: "Custom",
      url: `https://${CUSTOM}.example/mcp`,
      provenance: "custom",
    });
    for (const app of [APP, TEAM_APP, S2S_APP, CUSTOM])
      await database.insert(mcpTools).values([
        {
          serverId: app,
          tenantId: "team",
          name: "LIST",
          description: "Lists.",
          effect: "read",
          version: "20260903_00",
        },
        {
          serverId: app,
          tenantId: "team",
          name: "SEND",
          description: "Sends.",
          effect: "write",
          version: "20260903_00",
        },
      ]);
    for (const [bot, owner] of [
      [OWN_BOT, DEMOTED],
      [MEMBERS_BOT, MEMBER],
    ] as const) {
      await database.insert(agents).values({
        id: bot,
        tenantId: owner,
        name: bot,
        type: "built_in",
        configuration: {},
      });
      await database.insert(agentProfiles).values({
        agentId: bot,
        tenantId: owner,
        ownerUserId: owner,
        title: bot,
        roleDescription: "测试员工",
        avatarSeed: bot,
        visibility: "private",
      });
    }
  });
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await asPlatform(async () => {
    await database.execute(
      sql`delete from agents where id like ${`dap-${suite}-%`}`,
    );
    await database.execute(
      sql`delete from mcp_servers where id like ${`dap%${suite}%`} or id like ${`%${slug}%`}`,
    );
    await database.execute(
      sql`delete from users where id like ${`dap-${suite}-%`}`,
    );
  });
  await releaseRoleWriter?.();
  await database.$client.close();
});

const BATCH = (app: string, botId: string) =>
  `/for/${botId}/apps/${app}/grants`;

describe("saving several of an app's actions on a Bot, by somebody whose admin role was taken away since sign-in", () => {
  test("turning actions on for their own Bot is refused whole: the grant would be written in their own frame, where row security has nothing to object to", async () => {
    await refusedLeavingNothing(() =>
      request(DEMOTED, "POST", BATCH(APP, OWN_BOT), {
        add: [`${APP}/LIST`, `${APP}/SEND`],
        remove: [],
      }),
    );
    await refusedLeavingNothing(() =>
      request(DEMOTED, "POST", BATCH(CUSTOM, OWN_BOT), {
        add: [`${CUSTOM}/SEND`],
        remove: [],
      }),
    );
  });

  test("the administrator who still holds the role makes the same save, and the demoted session cannot take it back", async () => {
    const saved = await request(ADMIN, "POST", BATCH(CUSTOM, OWN_BOT), {
      add: [`${CUSTOM}/LIST`],
      remove: [],
    });
    expect(saved.status).toBe(200);
    expect(await grantsOf(OWN_BOT)).toEqual([`${CUSTOM}/LIST`]);

    await refusedLeavingNothing(() =>
      request(DEMOTED, "POST", BATCH(CUSTOM, OWN_BOT), {
        add: [],
        remove: [`${CUSTOM}/LIST`],
      }),
    );
    expect(await grantsOf(OWN_BOT)).toEqual([`${CUSTOM}/LIST`]);
  });

  test("a member is still answered by the rule for members, so this refusal is only about a session whose role went stale", async () => {
    const response = await request(MEMBER, "POST", BATCH(APP, MEMBERS_BOT), {
      add: [`${APP}/LIST`],
      remove: [],
    });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: string }).error).toBe(
      "An administrator decides which Bots may reach a tool.",
    );
    expect(await grantsOf(MEMBERS_BOT)).toEqual([]);
  });
});

describe("changing the deployment's apps, by somebody whose admin role was taken away since sign-in", () => {
  /*
   * store 在动手之前就拒绝了（应用、动作和密钥是 team 行，只有持有能力的管理员能写）。路由要把这次拒绝
   * 答成「你不是管理员了」的 403，而不是「你送来的东西不对」的 400：页面按 400 会让人去改表单重试。
   */
  const writes: [string, string, string, unknown][] = [
    ["adding a catalogue app", "POST", "/servers", { key: "context7" }],
    [
      "adding a server by address",
      "POST",
      "/servers/custom",
      {
        id: id("mine"),
        title: "Mine",
        url: `https://${id("mine")}.example/mcp`,
      },
    ],
    [
      "replacing a server's token",
      "POST",
      `/servers/${CUSTOM}/token`,
      { token: "tok-0123456789" },
    ],
    [
      "registering a server's OAuth client",
      "POST",
      `/servers/${CUSTOM}/oauth-client`,
      { clientId: "client-id", clientSecret: "client-secret" },
    ],
    ["refreshing a server's tools", "POST", `/servers/${CUSTOM}/refresh`, {}],
    ["removing a server", "DELETE", `/servers/${CUSTOM}`, undefined],
    ["removing a brokered app", "DELETE", `/servers/${APP}`, undefined],
  ];
  for (const [what, method, path, body] of writes)
    test(`${what} is answered 403 in Chinese, because the refusal is about who is asking and not about what was sent`, async () => {
      await refusedLeavingNothing(() => request(DEMOTED, method, path, body));
    });

  test("enabling a brokered app is answered the same way, and no auth config is made at the vendor for a row that could not be written", async () => {
    const before = await everything();
    vendor.length = 0;
    const response = await request(DEMOTED, "POST", "/composio/apps", {
      slug: NEW_APP,
    });
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 403,
      body: { error: CAPABILITY_UNCONFIRMED },
    });
    expect(await everything()).toEqual(before);
    // 目录是读出来的；在厂商那边留下东西的那一步（建 auth config）没有走到。
    expect(vendor).toEqual(["listApps"]);
  });
});

describe("an app's account mode, by somebody whose admin role was taken away since sign-in", () => {
  test("the preview is refused before anybody's connections are counted, as a 403 and not a failure", async () => {
    await refusedLeavingNothing(() =>
      request(DEMOTED, "GET", `/servers/${APP}/account-mode?mode=shared`),
    );
  });

  test("the switch is refused before it starts, so it is not reported as something to retry", async () => {
    await refusedLeavingNothing(() =>
      request(DEMOTED, "PUT", `/servers/${APP}/account-mode`, {
        mode: "shared",
      }),
    );
    await refusedLeavingNothing(() =>
      request(DEMOTED, "PUT", `/servers/${APP}/account-mode`, {
        mode: "shared",
        confirm: true,
      }),
    );
  });

  test("the administrator who still holds the role is shown the preview", async () => {
    const response = await request(
      ADMIN,
      "GET",
      `/servers/${APP}/account-mode?mode=shared`,
    );
    expect(response.status).toBe(200);
  });
});

describe("connecting an account, by somebody whose admin role was taken away since sign-in", () => {
  test("an app on the deployment's own client is refused before the vendor is asked anything: the account would be the organization's access under their name", async () => {
    await refusedLeavingNothing(
      () => request(DEMOTED, "POST", `/servers/${S2S_APP}/connect`),
      adminConnectOnlySentence(S2S_APP),
    );
  });

  test("the administrator who still holds the role gets past that refusal", async () => {
    vendor.length = 0;
    const response = await request(
      ADMIN,
      "POST",
      `/servers/${S2S_APP}/connect`,
    );
    expect(response.status).not.toBe(403);
    expect(vendor).toEqual(["connectionFields"]);
  });
});

describe("what the apps list tells the page about connecting", () => {
  const canConnect = async (actor: string) => {
    const response = await request(actor, "GET", "");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      servers: { id: string; canConnect: boolean }[];
    };
    return Object.fromEntries(
      body.servers
        .filter((server) => [APP, TEAM_APP, S2S_APP].includes(server.id))
        .map((server) => [server.id, server.canConnect]),
    );
  };

  test("a session whose role went stale is told what a member is told, so the page does not draw a Connect that will be refused", async () => {
    expect(await canConnect(DEMOTED)).toEqual({
      [APP]: true,
      [TEAM_APP]: false,
      [S2S_APP]: false,
    });
    expect(await canConnect(MEMBER)).toEqual({
      [APP]: true,
      [TEAM_APP]: false,
      [S2S_APP]: false,
    });
  });

  test("the administrator who still holds the role may connect all three", async () => {
    expect(await canConnect(ADMIN)).toEqual({
      [APP]: true,
      [TEAM_APP]: true,
      [S2S_APP]: true,
    });
  });
});
