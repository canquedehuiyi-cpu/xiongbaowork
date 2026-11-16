import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { createApp } from "../src/app";
import { createAuditStore } from "../src/audit";
import { createRoleRepository } from "../src/auth/guards";
import { setRole } from "../src/auth/roles";
import { loadConfig } from "../src/config";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  mcpServers,
  mcpTools,
  users,
} from "../src/db/schema";
import type { ComposioBroker } from "../src/plugins/broker";
import { createPluginStore } from "../src/plugins/store";
import { asPlatform } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";
import { bindTestRoleWriter } from "./support/role-writer";

/**
 * 插件接口照 `createApp` 装起来的样子（真实的会话守卫、角色仓库、store 和数据库），由一个会话里还写着
 * admin、`user_roles` 里已被收回管理员角色的人来调用。
 *
 * 会话带着角色时（组织身份源给出的会话就是这样），守卫直接用它，不再读 `user_roles`；管理员能力是每次
 * 请求重新读 `user_roles` 之后才给的。两者不一致的那段时间里，只看会话角色的路径会让这个人继续做管理员
 * 的事：
 *
 * - 单个授予和收回（`POST`、`DELETE /grants`）：授予写在本人自己的帧里，行安全不拦，他可以把任何已添加
 *   应用的动作给自己的员工，包括带着部署令牌的服务器。
 * - 上架和下架（`POST`、`DELETE /listings`）：上架表由 store 以 platform 写，行安全同样不拦；上架之后
 *   每位员工的主人都能自己装。
 * - 浏览 broker 目录（`GET /composio/apps`）：用部署的密钥去问厂商。
 *
 * 这几条在装配层的门（`plugins/admin-session-gate.ts`）上核对管理员能力，在请求到达路由之前拒绝，所以
 * 这里每一条都看：403、那句中文、数据库里什么都没写、厂商没有被问到。添加应用那几条 store 自己会拒绝，
 * 门让它们在动手之前、连目录都还没读的时候就被拒绝。成员不归这道门管，照旧由路由回答。
 *
 * 会话不带角色时（Better Auth 的会话），守卫每次请求都读 `user_roles`，角色收回的下一次请求就已经是成员，
 * 走不到这道门要管的情形；最后一组测试钉的是这一点，说明这道门防的是哪一种会话。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const id = (name: string) => `dag-${suite}-${name}`;
const ADMIN = id("admin");
/** 会话里还是管理员、`user_roles` 里已被收回管理员角色的人。 */
const DEMOTED = id("demoted");
const MEMBER = id("member");
/** 会话里不带角色的人（Better Auth 的会话就是这样）：守卫每次请求都从 `user_roles` 读他的角色。 */
const FORMER = id("former");
const people = [ADMIN, DEMOTED, MEMBER, FORMER];
/** DEMOTED 自己的私人员工：他在自己的帧里就是它的主人，授予写得进去。 */
const OWN_BOT = id("own-bot");
const MEMBERS_BOT = id("members-bot");
const slug = suite.replace(/-/g, "_");
/** 个人账号的 broker 应用，没有上架。 */
const APP = `dag_app_${slug}`;
/** 已经上架的应用：员工的主人可以自己装。 */
const LISTED = `dag_listed_${slug}`;
/** 管理员按地址添加的服务器，带着部署自己的令牌。 */
const CUSTOM = `dag-custom-${suite}`;
const NEW_APP = `dagnew${slug}`;
const STALE = "你的管理员身份没能确认，没有改变任何东西。";
let releaseRoleWriter: (() => Promise<void>) | undefined;

/** 厂商那边被问到的每一件事。 */
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
} as unknown as ComposioBroker;

const store = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: createCredentialStore(database),
  encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  broker,
});

/** `createApp` 的第 4 到 14 个位置，这里都不给；第 15 个是插件 store。 */
const UP_TO_PLUGIN_STORE = [
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
] as const;
/** 第 16 到 29 个位置；第 30 个是 broker。 */
const UP_TO_BROKER = [
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
] as const;

/**
 * 请求头 `x-actor` 说是谁。会话自己带着角色，和组织身份源给出的会话一样；角色仓库是真的，所以 DEMOTED
 * 的会话说 admin，`user_roles` 说不是。
 */
const app = createApp(
  loadConfig(testEnvironment()),
  {
    handler: () => new Response(null, { status: 204 }),
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        const actor = headers.get("x-actor");
        if (!actor) return null;
        const user = { id: actor, email: `${actor}@example.test` };
        if (actor === FORMER) return { user };
        return { user: { ...user, role: actor === MEMBER ? "user" : "admin" } };
      },
    },
  } as never,
  createRoleRepository(database),
  ...UP_TO_PLUGIN_STORE,
  store,
  ...UP_TO_BROKER,
  { broker },
);

const request = (actor: string, method: string, path: string, body?: unknown) =>
  app.request(`http://openbot.test/api/plugins${path}`, {
    method,
    headers: { "content-type": "application/json", "x-actor": actor },
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
      sql`select kind, ref, agent_id, tenant_id from plugin_grants where agent_id like ${`dag-${suite}-%`} order by 1, 2, 3`,
    ),
    listings: await rows(
      sql`select kind, ref from plugin_install_listings where ref like ${`dag%${suite}%`} or ref like ${`dag%${slug}%`} order by 1, 2`,
    ),
    servers: await rows(
      sql`select to_jsonb(s) - 'updated_at' as server from mcp_servers s where id like ${`dag%${suite}%`} or id like ${`%${slug}%`} order by id`,
    ),
    secrets: await rows(
      sql`select kind, provider from credentials where provider like ${`dag%${suite}%`} or provider like ${`%${slug}%`} order by 1, 2`,
    ),
    trail: await rows(
      sql`select event_type from audit_events where tenant_id = ${DEMOTED} or actor_user_id = ${DEMOTED} or payload::text like ${`%${DEMOTED}%`} order by created_at`,
    ),
  }));
}

/** 这次请求被拒绝：403、那句中文，数据库里什么都没有动，厂商没有被问到。 */
async function refusedLeavingNothing(ask: () => Response | Promise<Response>) {
  const before = await everything();
  vendor.length = 0;
  const response = await ask();
  expect({ status: response.status, body: await response.json() }).toEqual({
    status: 403,
    body: { error: STALE },
  });
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

const listed = () =>
  asPlatform(async () =>
    Array.from(
      (await database.execute(
        sql`select ref from plugin_install_listings where ref like ${`dag%${suite}%`} or ref like ${`dag%${slug}%`} order by ref`,
      )) as unknown as ArrayLike<{ ref: string }>,
    ).map((row) => row.ref),
  );

beforeAll(async () => {
  releaseRoleWriter = await bindTestRoleWriter(database);
  await asPlatform(async () => {
    await database
      .insert(users)
      .values(
        people.map((person) => ({ id: person, email: `${person}@x.test` })),
      );
    await setRole(database, ADMIN, "admin");
    for (const appId of [APP, LISTED])
      await database.insert(mcpServers).values({
        id: appId,
        tenantId: "team",
        title: appId,
        vendor: "Composio",
        url: `composio://${appId}`,
        provenance: "composio",
        authScheme: "OAUTH2",
        accountMode: "personal",
      });
    await database.insert(mcpServers).values({
      id: CUSTOM,
      tenantId: "team",
      title: "Custom",
      vendor: "Custom",
      url: `https://${CUSTOM}.example/mcp`,
      provenance: "custom",
    });
    for (const appId of [APP, LISTED, CUSTOM])
      await database.insert(mcpTools).values([
        {
          serverId: appId,
          tenantId: "team",
          name: "LIST",
          description: "Lists.",
          effect: "read",
          version: "20260903_00",
        },
        {
          serverId: appId,
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
  await asPlatform(async () => {
    await database.execute(
      sql`delete from plugin_install_listings where ref like ${`dag%${suite}%`} or ref like ${`dag%${slug}%`}`,
    );
    await database.execute(
      sql`delete from agents where id like ${`dag-${suite}-%`}`,
    );
    await database.execute(
      sql`delete from mcp_servers where id like ${`dag%${suite}%`} or id like ${`%${slug}%`}`,
    );
    await database.execute(
      sql`delete from users where id like ${`dag-${suite}-%`}`,
    );
  });
  await releaseRoleWriter?.();
  await database.$client.close();
});

const grantQuery = (ref: string, botId: string) =>
  `/grants?kind=mcp&ref=${encodeURIComponent(ref)}&agentId=${botId}`;

describe("granting and revoking, by a session that still says admin after the role was taken away", () => {
  test("an app's action on their own Bot is refused: the grant would be written in their own frame, where row security has nothing to object to", async () => {
    await refusedLeavingNothing(() =>
      request(DEMOTED, "POST", "/grants", {
        kind: "mcp",
        ref: `${APP}/SEND`,
        agentId: OWN_BOT,
      }),
    );
  });

  test("a server holding the deployment's own token is refused the same way, so their Bot never gets to spend that token", async () => {
    await refusedLeavingNothing(() =>
      request(DEMOTED, "POST", "/grants", {
        kind: "mcp",
        ref: `${CUSTOM}/SEND`,
        agentId: OWN_BOT,
      }),
    );
  });

  test("the administrator who still holds the role grants it, and the stale session cannot revoke what that administrator decided", async () => {
    const granted = await request(ADMIN, "POST", "/grants", {
      kind: "mcp",
      ref: `${CUSTOM}/LIST`,
      agentId: OWN_BOT,
    });
    expect(granted.status).toBe(200);
    expect(await grantsOf(OWN_BOT)).toEqual([`${CUSTOM}/LIST`]);

    await refusedLeavingNothing(() =>
      request(DEMOTED, "DELETE", grantQuery(`${CUSTOM}/LIST`, OWN_BOT)),
    );
    expect(await grantsOf(OWN_BOT)).toEqual([`${CUSTOM}/LIST`]);
  });

  test("the path spelled with an escape reaches the same route, so it meets the same refusal", async () => {
    await refusedLeavingNothing(() =>
      request(DEMOTED, "POST", "/%67rants", {
        kind: "mcp",
        ref: `${APP}/SEND`,
        agentId: OWN_BOT,
      }),
    );
  });
});

describe("listing and unlisting, by a session that still says admin after the role was taken away", () => {
  test("listing an app is refused: once listed, every owner could install it on their own Bot", async () => {
    await refusedLeavingNothing(() =>
      request(DEMOTED, "POST", "/listings", { kind: "mcp", ref: CUSTOM }),
    );
    expect(await listed()).toEqual([]);
  });

  test("the administrator who still holds the role lists an app, and the stale session cannot unlist it", async () => {
    const response = await request(ADMIN, "POST", "/listings", {
      kind: "mcp",
      ref: LISTED,
    });
    expect(response.status).toBe(200);
    expect(await listed()).toEqual([LISTED]);

    await refusedLeavingNothing(() =>
      request(DEMOTED, "DELETE", `/listings?kind=mcp&ref=${LISTED}`),
    );
    expect(await listed()).toEqual([LISTED]);
  });
});

describe("the deployment's apps, by a session that still says admin after the role was taken away", () => {
  const writes: [string, string, unknown][] = [
    ["adding a catalogue app", "/servers", { key: "context7" }],
    [
      "adding a server by address",
      "/servers/custom",
      {
        id: id("mine"),
        title: "Mine",
        url: `https://${id("mine")}.example/mcp`,
      },
    ],
    [
      "replacing a server's token",
      `/servers/${CUSTOM}/token`,
      { token: "tok-0123456789" },
    ],
    [
      "registering a server's OAuth client",
      `/servers/${CUSTOM}/oauth-client`,
      { clientId: "client-id", clientSecret: "client-secret" },
    ],
    ["enabling a brokered app", "/composio/apps", { slug: NEW_APP }],
  ];
  for (const [what, path, body] of writes)
    test(`${what} is refused before the store or the vendor is asked anything`, async () => {
      await refusedLeavingNothing(() => request(DEMOTED, "POST", path, body));
    });

  test("the broker's directory is not read for them either: it is asked for with the deployment's own key", async () => {
    await refusedLeavingNothing(() =>
      request(DEMOTED, "GET", "/composio/apps"),
    );
    vendor.length = 0;
    const head = await request(DEMOTED, "HEAD", "/composio/apps");
    expect(head.status).toBe(403);
    expect(vendor).toEqual([]);
  });

  test("the administrator who still holds the role reads the directory", async () => {
    vendor.length = 0;
    const response = await request(ADMIN, "GET", "/composio/apps");
    expect(response.status).toBe(200);
    expect(vendor).toEqual(["listApps"]);
  });
});

describe("describing a Bot's grants in a sentence, by a session that still says admin after the role was taken away", () => {
  test("the description is not sent to the deployment's model and no trail row is written", async () => {
    await refusedLeavingNothing(() =>
      request(
        DEMOTED,
        "POST",
        `/for/${OWN_BOT}/apps/${CUSTOM}/grants/translate`,
        {
          text: "它可以读，不可以发。",
        },
      ),
    );
  });

  test("a set of grants is not replayed for them either", async () => {
    await refusedLeavingNothing(() =>
      request(DEMOTED, "POST", `/for/${OWN_BOT}/apps/${CUSTOM}/grants/replay`, {
        grants: [`${CUSTOM}/LIST`],
      }),
    );
  });
});

describe("a member, whom this refusal is not about", () => {
  test("installs a listed app's action on their own Bot as before", async () => {
    const response = await request(MEMBER, "POST", "/grants", {
      kind: "mcp",
      ref: `${LISTED}/LIST`,
      agentId: MEMBERS_BOT,
    });
    expect(response.status).toBe(200);
    expect(await grantsOf(MEMBERS_BOT)).toEqual([`${LISTED}/LIST`]);
  });

  test("is still told by the route itself that listing is an administrator's", async () => {
    const response = await request(MEMBER, "POST", "/listings", {
      kind: "mcp",
      ref: APP,
    });
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 403,
      body: { error: "Only an admin can do this." },
    });
  });
});

describe("a session that carries no role of its own", () => {
  test("is read from user_roles on every request, so taking the role away already applies to the very next request", async () => {
    await asPlatform(() => setRole(database, FORMER, "admin"));
    const asAdmin = await request(FORMER, "POST", "/listings", {
      kind: "mcp",
      ref: APP,
    });
    expect(asAdmin.status).toBe(200);
    const unlisted = await request(
      FORMER,
      "DELETE",
      `/listings?kind=mcp&ref=${APP}`,
    );
    expect(unlisted.status).toBe(200);

    await asPlatform(() => setRole(database, FORMER, "user"));
    const asMember = await request(FORMER, "POST", "/listings", {
      kind: "mcp",
      ref: APP,
    });
    expect({ status: asMember.status, body: await asMember.json() }).toEqual({
      status: 403,
      body: { error: "Only an admin can do this." },
    });
    expect(await listed()).toEqual([LISTED]);
  });
});
