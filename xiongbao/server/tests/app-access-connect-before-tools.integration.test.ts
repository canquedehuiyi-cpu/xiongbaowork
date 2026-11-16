import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { MCPMock } from "@copilotkit/aimock/mcp";
import { and, eq, inArray, like, or } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AuditEventInput, AuditStore } from "../src/audit";
import { createAdminScope } from "../src/auth/admin-scope";
import { type AppVariables, createRoleRepository } from "../src/auth/guards";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  appAccessRequests,
  mcpServers,
  mcpTools,
  pluginGrants,
} from "../src/db/schema";
import { setEdition } from "../src/edition";
import {
  personalDefaultsDeps,
  withPersonalDefaults,
} from "../src/plugins/personal-defaults";
import { createPluginRoutes } from "../src/plugins/routes";
import { createPluginStore } from "../src/plugins/store";
import { asPlatform, runAsTenant } from "../src/tenant/context";
import { seedAdministrator } from "./support/admin-request";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * 对话卡片上的「连接」：没有保存工具时，批准先向应用要工具（上游 #1277 的服务端核心，按 fork 的批准路径改写）。
 *
 * 卡片上的一按和收件箱的批准走同一个 `carryOut`。应用添加时保存的工具清单可能是空的：当时 vendor 没回答，
 * 或者它只对登录了的人列工具（Notion）。所以：
 * - 两个版本里，批准都先以按下的人的身份再问一次应用要工具，不再叫管理员去应用页刷新；问到了就照常给只读动作。
 * - 团队版里还是什么都没有，就照旧拒绝：管理员的批准就是授予本身，什么都不给的批准不算数。
 * - 个人版里，工具要随本人登录才列出的应用（个人账号、靠 OAuth 或同意页连接、本人还没连上），批准就是打开
 *   它、什么都不给；之后的登录列出工具，`withPersonalDefaults` 把全部工具给每位员工。
 *
 * 安全上不变的：一按仍只给管理员（个人版里那个人就是管理员）；批准仍只给只读、非破坏性的动作；什么都不给的
 * 批准不写任何授予；共享使用闸门、主人授权、审批底线都不经过这里。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const events: AuditEventInput[] = [];
const audit: AuditStore = {
  insert: async (event) => {
    events.push(event);
  },
};
const eventsOf = (type: string) =>
  events.filter((event) => event.eventType === type);

const suite = randomUUID().slice(0, 8);
const ADMIN = `acbt-admin-${suite}`;
const BOT = `acbt-bot-${suite}`;
const NOTION = "notion";
const PARALLEL = "parallel";
const APPS = [NOTION, PARALLEL];
const ROWS = APPS.map((app) => `team:${app}`);
const SEARCH = ["parallel/web_fetch", "parallel/web_search"];

const plain = createPluginStore({
  database,
  auditStore: audit,
  credentials: createCredentialStore(database),
  encryptionKey: Buffer.alloc(32, 7).toString("base64"),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
});
const real = personalDefaultsDeps(database, ADMIN);
const store = withPersonalDefaults(plain, {
  ...real,
  bots: async () => (await real.bots()).filter((id) => id === BOT),
  servers: async () => (await real.servers()).filter((id) => ROWS.includes(id)),
});
/** 批准里每一次「再问一次应用要工具」，按的是谁。 */
const refreshedAs: { serverId: string; actor: string | undefined }[] = [];
/** 每一次刷新带的内部选项（第三个参数）。 */
const refreshedWith: unknown[] = [];
const refresh = store.refreshTools;
store.refreshTools = async function (
  this: typeof store,
  serverId: string,
  actorId?: string,
  ...rest: never[]
) {
  refreshedAs.push({ serverId, actor: actorId });
  refreshedWith.push(rest[0]);
  return refresh.call(this, serverId, actorId, ...rest);
} as typeof store.refreshTools;

const adminScope = createAdminScope({
  roleRepository: createRoleRepository(database),
});
let releaseAdmin: (() => Promise<void>) | undefined;

function routes() {
  const session: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", {
      id: ADMIN,
      email: `${ADMIN}@example.test`,
      role: "admin",
    } as never);
    await runAsTenant(ADMIN, () => next());
  };
  return new Hono().route(
    "/api/plugins",
    createPluginRoutes(
      store,
      session,
      async () => true,
      undefined,
      undefined,
      adminScope,
    ),
  );
}
const press = (app: string) =>
  routes().request(`/api/plugins/for/${BOT}/apps/${app}/approve`, {
    method: "POST",
  });

const mock = new MCPMock();
let mockUrl = "";
/** Parallel 此刻会不会回答。 */
let parallelOnline = true;
const realFetch = globalThis.fetch;

async function holds(app: string) {
  const rows = await asPlatform(() =>
    database
      .select({ ref: pluginGrants.ref })
      .from(pluginGrants)
      .where(
        and(eq(pluginGrants.agentId, BOT), like(pluginGrants.ref, `${app}/%`)),
      ),
  );
  return rows.map((row) => row.ref).sort();
}

async function requestsFor(app: string) {
  return asPlatform(() =>
    database
      .select({ status: appAccessRequests.status })
      .from(appAccessRequests)
      .where(
        and(
          eq(appAccessRequests.botId, BOT),
          or(
            eq(appAccessRequests.serverId, `team:${app}`),
            eq(appAccessRequests.appKey, app),
          ),
        ),
      ),
  );
}

/** 一个已经打开、却还没保存任何工具的目录应用，像离线添加或 Notion 未登录时那样。 */
async function turnedOnWithNothingListed(app: string) {
  await asPlatform(() =>
    database.insert(mcpServers).values({
      id: `team:${app}`,
      tenantId: "team",
      title: app === NOTION ? "Notion" : "Parallel Search",
      vendor: app === NOTION ? "Notion" : "Parallel",
      url:
        app === NOTION
          ? "https://mcp.notion.com/mcp"
          : "https://search.parallel.ai/mcp",
      catalogueKey: app,
      addedBy: ADMIN,
    }),
  );
}

async function forget() {
  await asPlatform(async () => {
    await database
      .delete(appAccessRequests)
      .where(eq(appAccessRequests.botId, BOT));
    await database.delete(pluginGrants).where(eq(pluginGrants.agentId, BOT));
    await database.delete(mcpTools).where(inArray(mcpTools.serverId, ROWS));
    await database.delete(mcpServers).where(inArray(mcpServers.id, ROWS));
  });
}

beforeAll(async () => {
  const [existing] = await asPlatform(() =>
    database
      .select({ id: mcpServers.id })
      .from(mcpServers)
      .where(
        or(
          inArray(mcpServers.id, ROWS),
          inArray(mcpServers.catalogueKey, APPS),
        ),
      ),
  );
  if (existing)
    throw new Error(
      `测试库里已经有 ${existing.id} 这一行，这个测试会替换它的工具，所以不在这个库上跑。`,
    );
  mock.addTool({
    name: "web_search",
    description: "Search the public web.",
    inputSchema: { type: "object", properties: {} },
  });
  mock.addTool({
    name: "web_fetch",
    description: "Read public web pages.",
    inputSchema: { type: "object", properties: {} },
  });
  mockUrl = await mock.start();
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const target = String(input instanceof Request ? input.url : input);
    if (target.startsWith("https://search.parallel.ai")) {
      if (!parallelOnline) return Promise.reject(new TypeError("fetch failed"));
      return realFetch(mockUrl, init);
    }
    // Notion 只对登录了的人列工具；这里谁都没登录，它什么也不答。
    if (target.startsWith("https://mcp.notion.com"))
      return Promise.resolve(new Response("unauthorized", { status: 401 }));
    return realFetch(input, init);
  }) as typeof fetch;
  releaseAdmin = await seedAdministrator(database, ADMIN);
  await asPlatform(async () => {
    await database.insert(agents).values({
      id: BOT,
      tenantId: ADMIN,
      name: BOT,
      type: "built_in",
      configuration: {},
    });
    await database.insert(agentProfiles).values({
      agentId: BOT,
      tenantId: ADMIN,
      ownerUserId: ADMIN,
      title: BOT,
      roleDescription: "测试员工",
      avatarSeed: BOT,
      visibility: "private",
    });
  });
});

beforeEach(async () => {
  parallelOnline = true;
  events.length = 0;
  refreshedAs.length = 0;
  refreshedWith.length = 0;
  await forget();
});

afterEach(() => setEdition("team"));

afterAll(async () => {
  globalThis.fetch = realFetch;
  await mock.stop?.();
  await forget();
  await asPlatform(() => database.delete(agents).where(eq(agents.id, BOT)));
  await releaseAdmin?.();
  await database.$client.close();
});

describe("an app with no tools saved, pressed in the team edition", () => {
  test("the press asks the app again, as whoever pressed, and gives the read tools it lists now", async () => {
    await turnedOnWithNothingListed(PARALLEL);
    const response = await press(PARALLEL);
    expect(response.status).toBe(200);
    expect(
      ((await response.json()) as { granted: string[] }).granted.sort(),
    ).toEqual(SEARCH);
    expect(refreshedAs).toContainEqual({
      serverId: `team:${PARALLEL}`,
      actor: ADMIN,
    });
    expect(await holds(PARALLEL)).toEqual(SEARCH);
  });

  /*
   * 管理员的批准就是授予本身，所以什么都没列出时仍拒绝；但刚问过一次，就不再叫管理员去刷新，而是去应用页
   * 看原因。一按没做成，替管理员提的那条申请撤回，收件箱里不留。
   */
  test("one that still lists nothing is refused without being told to refresh, and leaves nothing behind", async () => {
    await turnedOnWithNothingListed(NOTION);
    const response = await press(NOTION);
    expect(response.status).toBe(409);
    const { error } = (await response.json()) as { error: string };
    expect(error).toBe(
      "「Notion」还没有可以授予的工具。请在插件页打开它的页面看看原因，然后再试一次。",
    );
    expect(error).not.toContain("刷新");
    expect(refreshedAs.map((call) => call.serverId)).toContain(
      `team:${NOTION}`,
    );
    expect(eventsOf("app_access.refused").at(-1)?.payload).toMatchObject({
      reason: "no_tools",
    });
    expect(await holds(NOTION)).toEqual([]);
    expect(await requestsFor(NOTION)).toEqual([{ status: "cancelled" }]);
  });
});

describe("an app whose tools come with the person's own sign-in, in the personal edition", () => {
  /*
   * Notion 只对登录了的人列工具，所以登录之前怎么问都是空的。卡片上的「连接」在这里把它打开，接着打开登录；
   * 因为没有工具就拒绝，会拦在那个本来会带来工具的登录前面。
   */
  test("the press turns it on with nothing given, and the request is approved", async () => {
    setEdition("personal");
    await turnedOnWithNothingListed(NOTION);
    const response = await press(NOTION);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      granted: string[];
      enabled: boolean;
      request: { status: string };
    };
    expect(body.granted).toEqual([]);
    expect(body.request.status).toBe("approved");
    expect(await holds(NOTION)).toEqual([]);
    expect(eventsOf("app_access.approved").at(-1)?.payload).toMatchObject({
      granted: 0,
      direct: true,
    });
  });

  /*
   * 之后的登录走 `refreshTools`：工具列出来，个人版的默认把全部工具给每位员工，和在连接页上连接一样。
   * 这里用 Parallel 代替一个登录之后才回答的应用：先离线按下，再上线刷新。
   */
  test("once the app lists its tools, every Bot is given all of them", async () => {
    setEdition("personal");
    await turnedOnWithNothingListed(PARALLEL);
    parallelOnline = true;
    // 服务器级的写在平台帧里做，和连接回调写 `team` 行时一样；授予由包装在这个人的帧里写。
    await asPlatform(() => store.refreshTools(`team:${PARALLEL}`, ADMIN));
    expect(await holds(PARALLEL)).toEqual(SEARCH);
  });

  /*
   * 不是随登录列工具的应用（这里是不用登录的 Parallel，此刻离线），个人版里也照旧拒绝，句子指向连接页：
   * 个人版没有插件页。
   */
  test("an app that does not wait for a sign-in is still refused, and sent to the Connections page", async () => {
    setEdition("personal");
    parallelOnline = false;
    await turnedOnWithNothingListed(PARALLEL);
    const response = await press(PARALLEL);
    expect(response.status).toBe(409);
    const { error } = (await response.json()) as { error: string };
    expect(error).toBe(
      "「Parallel Search」还没有可以授予的工具。请在连接页打开它的页面看看原因，然后再试一次。",
    );
    expect(await holds(PARALLEL)).toEqual([]);
  });
});

/*
 * 批准里的刷新只为列出工具：vendor 答 `invalid_client` 时不能顺手替换部署共用的 OAuth 客户端（那是应用页上
 * 管理员的事，和连接时列工具 `discoverToolsOnConnect` 的做法一样）。
 */
test("the press's refresh never re-registers the deployment's OAuth client", async () => {
  await turnedOnWithNothingListed(NOTION);
  await press(NOTION);
  expect(refreshedWith).toContainEqual({ reRegister: false });
  expect(refreshedWith).not.toContainEqual({ reRegister: true });
});

/*
 * 「打开、什么都不给」和「授予了 0 个」在轨迹上要分得开：前者是在等本人登录，后者不会发生（团队版拒绝）。
 */
test("turning an app on for a sign-in is told apart from a grant on the trail", async () => {
  setEdition("personal");
  await turnedOnWithNothingListed(NOTION);
  await press(NOTION);
  expect(eventsOf("app_access.approved").at(-1)?.payload).toMatchObject({
    granted: 0,
    opened: true,
  });
});
