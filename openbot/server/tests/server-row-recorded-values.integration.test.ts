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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { createAuditStore } from "../src/audit";
import { createAdminScope } from "../src/auth/admin-scope";
import { type AppVariables, createRoleRepository } from "../src/auth/guards";
import { setRole } from "../src/auth/roles";
import { createDatabase } from "../src/db/client";
import { mcpServers, mcpTools, users } from "../src/db/schema";
import { createAccountModeSwitch } from "../src/plugins/account-mode";
import type { ComposioBroker } from "../src/plugins/broker";
import { useComposioClient } from "../src/plugins/composio";
import { createPluginRoutes } from "../src/plugins/routes";
import { createPluginStore, type ServerRecord } from "../src/plugins/store";
import { asPlatform, runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { bindTestRoleWriter } from "./support/role-writer";

/**
 * 服务器行上两个原来只能给占位值的字段，现在各有一列记着真值（迁移 0198）：
 *
 * - `skippedTools`：上一次存下清单时，因为名字不能交给模型而略过的动作，照厂商的拼法（上游迁移 0059 的
 *   `skipped_tools`，上游 `plugin-store.integration.test.ts` 里那三条测试按 fork 接口改写）。模型的工具名
 *   只能用字母、数字、下划线和连字符，带点的名字存下来，之后每一次带着它的模型请求都会被整个拒绝；所以
 *   它不存，只花掉它自己这一个动作，并且说出来。它是提醒，不是失败：不进 `lastError`，下一次干净的刷新
 *   就清掉。
 * - `ownerGrantsChosen`：管理员明确选过的「谁可以把这个应用给员工」。管理员的 PUT 在
 *   `owner_grants_chosen_at` 上记下时刻；升级时回填的、切换账号模式写回的 `admin` 不记，所以不算选过。
 *   原有的 `GET /servers/:id/owner-grants` 的 `chosen` 仍是列里存的值，没有变。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const slug = suite.replace(/-/g, "_");
const ADMIN = `srv-${suite}-admin`;
const MEMBER = `srv-${suite}-member`;
const people = [ADMIN, MEMBER];
/** 刷新清单用的应用。 */
const LISTED = `srv_listed_${slug}`;
/** 个人账号应用，没人选过。 */
const PLAIN = `srv_plain_${slug}`;
/** 升级之前就有的应用：0197 回填成了 admin，没有选过的记号。 */
const BACKFILLED = `srv_backfilled_${slug}`;
/** 0198 之前管理员就放开过的应用：列里是 any，没有选过的记号。 */
const OPENED_EARLIER = `srv_opened_${slug}`;
/** 同一个地址上的两行，是同一个应用。 */
const TWIN_A = `srv_twin_a_${slug}`;
const TWIN_B = `srv_twin_b_${slug}`;
const apps = [LISTED, PLAIN, BACKFILLED, OPENED_EARLIER, TWIN_A, TWIN_B];
let releaseRoleWriter: (() => Promise<void>) | undefined;

const audit = createAuditStore(database);
const broker = {
  listApps: async () => [],
  isConnected: async () => false,
  revoke: async () => true,
  deleteAuthConfig: async () => {},
} as unknown as ComposioBroker;
const store = createPluginStore({
  database,
  auditStore: audit,
  credentials: { readSecret: async () => null } as never,
  encryptionKey: "x".repeat(44),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  broker,
});
const adminScope = createAdminScope({
  roleRepository: createRoleRepository(database),
});
const modes = createAccountModeSwitch({
  store,
  teamRules: undefined,
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
      role: actorId === ADMIN ? "admin" : "user",
    } as never);
    await runAsTenant(actorId, () => next());
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
      { broker },
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

async function rowFor(actor: string, app: string) {
  const response = await request(actor, "GET", "");
  expect(response.status).toBe(200);
  const body = (await response.json()) as { servers: ServerRecord[] };
  const row = body.servers.find((server) => server.id === app);
  if (!row) throw new Error(`${app} is not in the list.`);
  return row;
}

const chosenOf = async (actor: string, app: string) => {
  const row = await rowFor(actor, app);
  return { effective: row.ownerGrants, chosen: row.ownerGrantsChosen };
};

const settingOf = async (app: string) =>
  (await (
    await request(ADMIN, "GET", `/servers/${app}/owner-grants`)
  ).json()) as { ownerGrants: string; chosen: string | null };

const setOwnerGrants = (app: string, ownerGrants: "any" | "admin" | null) =>
  request(ADMIN, "PUT", `/servers/${app}/owner-grants`, { ownerGrants });

/** 列里现在存的两样：值，和有没有「管理员选过」的记号。 */
const columnsOf = async (app: string) => {
  const [row] = await asPlatform(() =>
    database
      .select({
        ownerGrants: mcpServers.ownerGrants,
        chosenAt: mcpServers.ownerGrantsChosenAt,
      })
      .from(mcpServers)
      .where(eq(mcpServers.id, app)),
  );
  return { value: row?.ownerGrants ?? null, marked: row?.chosenAt != null };
};

async function seedApps() {
  await asPlatform(async () => {
    await database.delete(mcpServers).where(inArray(mcpServers.id, apps));
    for (const [app, ownerGrants, url] of [
      [LISTED, null, `composio://${LISTED}`],
      [PLAIN, null, `composio://${PLAIN}`],
      [BACKFILLED, "admin", `composio://${BACKFILLED}`],
      [OPENED_EARLIER, "any", `composio://${OPENED_EARLIER}`],
      [TWIN_A, null, `composio://${TWIN_A}`],
      [TWIN_B, null, `composio://${TWIN_A}`],
    ] as const) {
      await database.insert(mcpServers).values({
        id: app,
        tenantId: "team",
        title: app,
        vendor: "Composio",
        url,
        provenance: "composio",
        authScheme: "OAUTH2",
        accountMode: "personal",
        ownerGrants,
      });
    }
  });
}

beforeAll(async () => {
  releaseRoleWriter = await bindTestRoleWriter(database);
  await asPlatform(async () => {
    await database
      .insert(users)
      .values(people.map((id) => ({ id, email: `${id}@example.test` })));
    await setRole(database, ADMIN, "admin");
  });
});

beforeEach(seedApps);
afterEach(() => useComposioClient(null));

afterAll(async () => {
  await asPlatform(async () => {
    await database.delete(mcpServers).where(inArray(mcpServers.id, apps));
    await database.delete(users).where(inArray(users.id, people));
  });
  await releaseRoleWriter?.();
  await database.$client.close();
});

/** 厂商这一次列出的动作。 */
function vendorLists(names: string[]) {
  useComposioClient({
    listActions: async () =>
      names.map((name) => ({
        slug: name,
        description: `${name} does something.`,
        version: "20260903_00",
      })) as never,
    execute: async () => ({ text: "ok", isError: false }) as never,
  } as never);
}

const refresh = () => asPlatform(() => store.refreshTools(LISTED));

const storedNames = async () =>
  (
    await asPlatform(() =>
      database
        .select({ name: mcpTools.name })
        .from(mcpTools)
        .where(eq(mcpTools.serverId, LISTED))
        .orderBy(asc(mcpTools.name)),
    )
  ).map((row) => row.name);

const listedRow = async () => {
  const [row] = await asPlatform(() =>
    database
      .select({
        lastError: mcpServers.lastError,
        skippedTools: mcpServers.skippedTools,
        toolsRefreshedAt: mcpServers.toolsRefreshedAt,
      })
      .from(mcpServers)
      .where(eq(mcpServers.id, LISTED)),
  );
  return row;
};

describe("an action whose name no model could be offered costs that one action, and is named", () => {
  test("a dotted name is skipped and named, and the rest are stored", async () => {
    vendorLists(["APP_FETCH", "APP.EXPORT", "APP_CREATE"]);
    expect(await refresh()).toEqual({ tools: 2 });
    expect(await storedNames()).toEqual(["APP_CREATE", "APP_FETCH"]);

    const server = await listedRow();
    // 学到了东西，所以刷新盖了时间，也不算失败；没学到的那一个，说在按了刷新的管理员会读到的地方。
    expect(server?.toolsRefreshedAt).not.toBeNull();
    expect(server?.lastError).toBeNull();
    expect(server?.skippedTools).toEqual(["APP.EXPORT"]);

    // 页面读到的那一行把它带出来，成员和管理员一样。
    for (const actor of [ADMIN, MEMBER])
      expect((await rowFor(actor, LISTED)).skippedTools).toEqual([
        "APP.EXPORT",
      ]);
  });

  test("each skipped name is reported once, as the vendor spelled it", async () => {
    vendorLists(["APP FETCH", "APP.EXPORT", "APP.EXPORT", "APP_OK"]);
    expect(await refresh()).toEqual({ tools: 1 });
    expect((await listedRow())?.skippedTools).toEqual([
      "APP FETCH",
      "APP.EXPORT",
    ]);
  });

  test("a clean refresh after one that skipped a name clears the warning", async () => {
    vendorLists(["APP_FETCH", "APP.EXPORT"]);
    await refresh();
    vendorLists(["APP_FETCH"]);
    expect(await refresh()).toEqual({ tools: 1 });

    expect((await listedRow())?.skippedTools).toBeNull();
    expect((await rowFor(MEMBER, LISTED)).skippedTools).toEqual([]);
  });

  test("a listing whose every name is skipped keeps the actions already held", async () => {
    await asPlatform(() =>
      database.insert(mcpTools).values({
        serverId: LISTED,
        tenantId: "team",
        name: "APP_FETCH",
        description: "Held from an earlier listing.",
        effect: "read",
        version: "20260903_00",
      }),
    );
    vendorLists(["APP.FETCH"]);

    expect(await refresh()).toEqual({ tools: 1 });
    expect(await storedNames()).toEqual(["APP_FETCH"]);

    const server = await listedRow();
    expect(server?.lastError).toContain('"APP.FETCH"');
    expect(server?.lastError).toContain("保留");
    expect(server?.skippedTools).toEqual(["APP.FETCH"]);
  });

  test("an app that has never skipped anything carries an empty list", async () => {
    expect((await rowFor(MEMBER, PLAIN)).skippedTools).toEqual([]);
  });
});

describe("the row says what an administrator chose, and only that", () => {
  test("an administrator keeping an app to administrators is a choice, and the row now says so", async () => {
    expect((await setOwnerGrants(PLAIN, "admin")).status).toBe(200);
    expect(await chosenOf(MEMBER, PLAIN)).toEqual({
      effective: "admin",
      chosen: "admin",
    });
    expect(await columnsOf(PLAIN)).toEqual({ value: "admin", marked: true });
  });

  test("an administrator opening an app to owners is a choice", async () => {
    expect((await setOwnerGrants(BACKFILLED, "any")).status).toBe(200);
    expect(await chosenOf(MEMBER, BACKFILLED)).toEqual({
      effective: "any",
      chosen: "any",
    });
    expect(await columnsOf(BACKFILLED)).toEqual({ value: "any", marked: true });
  });

  test("the admin the upgrade backfilled is nobody's choice", async () => {
    expect(await chosenOf(ADMIN, BACKFILLED)).toEqual({
      effective: "admin",
      chosen: null,
    });
    // 原有的接口照旧给出列里存的值。
    expect(await settingOf(BACKFILLED)).toEqual({
      ownerGrants: "admin",
      chosen: "admin",
    });
  });

  test("an app opened to owners before the mark existed is still read as chosen: only an administrator could have written it", async () => {
    expect(await columnsOf(OPENED_EARLIER)).toEqual({
      value: "any",
      marked: false,
    });
    expect(await chosenOf(MEMBER, OPENED_EARLIER)).toEqual({
      effective: "any",
      chosen: "any",
    });
  });

  test("going back to the default takes the choice away", async () => {
    await setOwnerGrants(PLAIN, "admin");
    expect((await setOwnerGrants(PLAIN, null)).status).toBe(200);
    expect(await chosenOf(MEMBER, PLAIN)).toEqual({
      effective: "any",
      chosen: null,
    });
    expect(await columnsOf(PLAIN)).toEqual({ value: null, marked: false });
  });

  test("switching the account mode writes admin back, and that is not a choice even where one stood before", async () => {
    await setOwnerGrants(PLAIN, "admin");
    const switched = await request(
      ADMIN,
      "PUT",
      `/servers/${PLAIN}/account-mode`,
      { mode: "shared", confirm: true },
    );
    expect(switched.status).toBe(200);
    expect(await chosenOf(ADMIN, PLAIN)).toEqual({
      effective: "admin",
      chosen: null,
    });
    expect(await columnsOf(PLAIN)).toEqual({ value: "admin", marked: false });

    // 管理员在新模式下再选一次，才又算选过。
    await setOwnerGrants(PLAIN, "admin");
    expect(await chosenOf(ADMIN, PLAIN)).toEqual({
      effective: "admin",
      chosen: "admin",
    });
  });

  test("two rows at one app's address carry the same choice", async () => {
    await setOwnerGrants(TWIN_B, "admin");
    expect(await chosenOf(MEMBER, TWIN_A)).toEqual(
      await chosenOf(MEMBER, TWIN_B),
    );
    expect(await columnsOf(TWIN_A)).toEqual({ value: "admin", marked: true });
    expect(await columnsOf(TWIN_B)).toEqual({ value: "admin", marked: true });
  });

  test("the owner-grants route answers what it always answered", async () => {
    await setOwnerGrants(PLAIN, "admin");
    expect(await settingOf(PLAIN)).toEqual({
      ownerGrants: "admin",
      chosen: "admin",
    });
    await setOwnerGrants(PLAIN, null);
    expect(await settingOf(PLAIN)).toEqual({
      ownerGrants: "any",
      chosen: null,
    });
  });

  test("a member cannot make the choice", async () => {
    const response = await request(
      MEMBER,
      "PUT",
      `/servers/${PLAIN}/owner-grants`,
      { ownerGrants: "admin" },
    );
    expect(response.status).toBe(403);
    expect(await columnsOf(PLAIN)).toEqual({ value: null, marked: false });
  });
});

describe("migration 0198 adds the two columns and decides nothing for anybody", () => {
  const overlay = join(
    import.meta.dir,
    "..",
    "recovery",
    "recovery-20261018-v1",
  );

  test("both columns are nullable and carry no default", async () => {
    const columns = await asPlatform(() =>
      database.execute<{
        column_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }>(sql`
        select column_name, data_type, is_nullable, column_default
        from information_schema.columns
        where table_schema = 'public' and table_name = 'mcp_servers'
          and column_name in ('skipped_tools', 'owner_grants_chosen_at')
        order by column_name
      `),
    );
    expect([...columns]).toEqual([
      {
        column_name: "owner_grants_chosen_at",
        data_type: "timestamp with time zone",
        is_nullable: "YES",
        column_default: null,
      },
      {
        column_name: "skipped_tools",
        data_type: "ARRAY",
        is_nullable: "YES",
        column_default: null,
      },
    ]);
  });

  test("it backfills nothing: no row is marked as an administrator's choice by the upgrade", () => {
    const text = readFileSync(
      join(overlay, "sql", "0198_server_row_shapes.sql"),
      "utf8",
    )
      // 去掉注释，只看语句。
      .replace(/\/\*[\s\S]*?\*\//g, "");
    expect(text).not.toMatch(/\bUPDATE\b/i);
    expect(text).not.toMatch(/\bPOLICY\b/i);
    expect(text.match(/ADD COLUMN/gi)?.length).toBe(2);
  });

  test("it is journalled right after 0197, a second later", () => {
    const journal = JSON.parse(
      readFileSync(join(overlay, "meta", "_journal.json"), "utf8"),
    ) as { entries: { idx: number; when: number; tag: string }[] };
    const before = journal.entries.find(
      (entry) => entry.tag === "0197_owner_app_grants",
    );
    const added = journal.entries.find(
      (entry) => entry.tag === "0198_server_row_shapes",
    );
    expect({
      idx: added?.idx,
      after: (added?.when ?? 0) - (before?.when ?? 0),
    }).toEqual({ idx: 198, after: 1000 });
  });
});
