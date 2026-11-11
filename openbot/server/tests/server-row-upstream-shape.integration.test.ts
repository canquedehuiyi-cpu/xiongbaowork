import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { createAuditStore } from "../src/audit";
import { createAdminScope } from "../src/auth/admin-scope";
import { type AppVariables, createRoleRepository } from "../src/auth/guards";
import { setRole } from "../src/auth/roles";
import { createDatabase } from "../src/db/client";
import { mcpServers, users } from "../src/db/schema";
import { createAccountModeSwitch } from "../src/plugins/account-mode";
import type { ComposioBroker } from "../src/plugins/broker";
import { createPluginRoutes } from "../src/plugins/routes";
import { createPluginStore, type ServerRecord } from "../src/plugins/store";
import { asPlatform, runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { bindTestRoleWriter } from "./support/role-writer";

/**
 * 服务器行上上游前端读、fork 之前不在行里给的几样：`ownerGrants`、`ownerGrantsChosen`、`skippedTools`、
 * `sharedVendorConnected`，以及已有的 `entraScope`。每一处返回服务器的地方都经 `listServers`，所以这里读
 * `GET /api/plugins` 的 `servers` 和 store 自己的答案。
 *
 * - `ownerGrants` 是现在生效的「谁可以把这个应用给员工」，和 `GET /servers/:id/owner-grants` 同一个算法，
 *   两处不会答得不一样。
 * - `ownerGrantsChosen` 只在确知是管理员选的时候才说选过。列里的 `any` 只有管理员的 PUT 能写；`admin` 还
 *   可能是升级时的回填或切换账号模式写回的，列里分不出是谁写的，所以不报成管理员选过。
 * - `sharedVendorConnected` 只在应用是 Shared 且团队账号已连接时为 true；团队身份不随它出去。
 * - `skippedTools` 在 fork 里恒为空数组：没有记录「上一次列出时因名字被略过的动作」的那一列。
 * - `entraScope` 任何能读服务器列表的人都读得到（它是一个资源名，不是凭据）。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const slug = suite.replace(/-/g, "_");
const ADMIN = `srs-${suite}-admin`;
const MEMBER = `srs-${suite}-member`;
const people = [ADMIN, MEMBER];
/** 个人账号应用，没人选过谁可以给：按账号的默认值，主人可以给。 */
const PERSONAL = `srs_personal_${slug}`;
/** 升级之前就有的个人账号应用：0197 回填成了 admin。 */
const BACKFILLED = `srs_backfilled_${slug}`;
/** Shared 应用，团队账号还没连。 */
const SHARED_OFF = `srs_shared_off_${slug}`;
/** Shared 应用，团队账号已连。 */
const SHARED_ON = `srs_shared_on_${slug}`;
/** 以登录人的身份访问的自定义服务器。 */
const ENTRA = `srs-entra-${suite}`;
const apps = [PERSONAL, BACKFILLED, SHARED_OFF, SHARED_ON, ENTRA];
const TEAM_IDENTITY = `openbot-deployment:${suite}:TEAMSECRET`;
const ENTRA_SCOPE = "api://srs-hr/.default";
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

async function rowsFor(actor: string) {
  const response = await request(actor, "GET", "");
  expect(response.status).toBe(200);
  const body = (await response.json()) as { servers: ServerRecord[] };
  return {
    text: JSON.stringify(body),
    byId: new Map(
      body.servers
        .filter((server) => apps.includes(server.id))
        .map((server) => [server.id, server]),
    ),
  };
}

const settingOf = async (actor: string, app: string) =>
  (await (
    await request(actor, "GET", `/servers/${app}/owner-grants`)
  ).json()) as {
    ownerGrants: string;
    chosen: string | null;
  };

async function seedApps() {
  await asPlatform(async () => {
    await database.delete(mcpServers).where(inArray(mcpServers.id, apps));
    for (const [app, mode, ownerGrants, connected] of [
      [PERSONAL, "personal", null, false],
      [BACKFILLED, "personal", "admin", false],
      [SHARED_OFF, "shared", null, false],
      [SHARED_ON, "shared", null, true],
    ] as const) {
      await database.insert(mcpServers).values({
        id: app,
        tenantId: "team",
        title: app,
        vendor: "Composio",
        url: `composio://${app}`,
        provenance: "composio",
        authScheme: "OAUTH2",
        accountMode: mode,
        ownerGrants,
        ...(mode === "shared"
          ? {
              sharedVendorUserId: `${TEAM_IDENTITY}-${app}`,
              ...(connected
                ? {
                    sharedConnectedAt: new Date("2026-03-03T00:00:00.000Z"),
                    sharedConnectedBy: ADMIN,
                    sharedVerified: true,
                  }
                : {}),
            }
          : {}),
      });
    }
    await database.insert(mcpServers).values({
      id: ENTRA,
      tenantId: "team",
      title: "HR",
      vendor: "Custom",
      url: "https://srs-hr.example.com/mcp",
      provenance: "custom",
      entraScope: ENTRA_SCOPE,
    });
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

afterAll(async () => {
  await asPlatform(async () => {
    await database.delete(mcpServers).where(inArray(mcpServers.id, apps));
    await database.delete(users).where(inArray(users.id, people));
  });
  await releaseRoleWriter?.();
  await database.$client.close();
});

describe("a server row says who may give the app to a Bot", () => {
  test("an app nobody decided about carries the default for its account, and no choice", async () => {
    const { byId } = await rowsFor(MEMBER);
    expect({
      ownerGrants: byId.get(PERSONAL)?.ownerGrants,
      ownerGrantsChosen: byId.get(PERSONAL)?.ownerGrantsChosen,
    }).toEqual({ ownerGrants: "any", ownerGrantsChosen: null });
    // Shared 应用和用部署凭据的服务器默认只有管理员能给。
    expect({
      ownerGrants: byId.get(SHARED_OFF)?.ownerGrants,
      ownerGrantsChosen: byId.get(SHARED_OFF)?.ownerGrantsChosen,
    }).toEqual({ ownerGrants: "admin", ownerGrantsChosen: null });
    expect({
      ownerGrants: byId.get(ENTRA)?.ownerGrants,
      ownerGrantsChosen: byId.get(ENTRA)?.ownerGrantsChosen,
    }).toEqual({ ownerGrants: "admin", ownerGrantsChosen: null });
  });

  test("an app the upgrade backfilled to admin is not reported as an administrator's choice", async () => {
    const { byId } = await rowsFor(ADMIN);
    expect({
      ownerGrants: byId.get(BACKFILLED)?.ownerGrants,
      ownerGrantsChosen: byId.get(BACKFILLED)?.ownerGrantsChosen,
    }).toEqual({ ownerGrants: "admin", ownerGrantsChosen: null });
    // 原有的接口照旧给出列里存的值。
    expect(await settingOf(ADMIN, BACKFILLED)).toEqual({
      ownerGrants: "admin",
      chosen: "admin",
    });
  });

  test("an administrator opening an app to owners is a choice, and the row says so", async () => {
    const opened = await request(
      ADMIN,
      "PUT",
      `/servers/${BACKFILLED}/owner-grants`,
      { ownerGrants: "any" },
    );
    expect(opened.status).toBe(200);
    const { byId } = await rowsFor(MEMBER);
    expect({
      ownerGrants: byId.get(BACKFILLED)?.ownerGrants,
      ownerGrantsChosen: byId.get(BACKFILLED)?.ownerGrantsChosen,
    }).toEqual({ ownerGrants: "any", ownerGrantsChosen: "any" });
  });

  test("switching the account mode writes admin back, and that is not reported as a choice either", async () => {
    await request(ADMIN, "PUT", `/servers/${PERSONAL}/owner-grants`, {
      ownerGrants: "any",
    });
    const switched = await request(
      ADMIN,
      "PUT",
      `/servers/${PERSONAL}/account-mode`,
      { mode: "shared", confirm: true },
    );
    expect(switched.status).toBe(200);
    const { byId } = await rowsFor(ADMIN);
    expect({
      ownerGrants: byId.get(PERSONAL)?.ownerGrants,
      ownerGrantsChosen: byId.get(PERSONAL)?.ownerGrantsChosen,
      accountMode: byId.get(PERSONAL)?.accountMode,
    }).toEqual({
      ownerGrants: "admin",
      ownerGrantsChosen: null,
      accountMode: "shared",
    });
  });

  test("the row and the owner-grants route answer the same rule for every app", async () => {
    const { byId } = await rowsFor(ADMIN);
    const fromRows: Record<string, string> = {};
    const fromRoute: Record<string, string> = {};
    for (const app of apps) {
      fromRows[app] = String(byId.get(app)?.ownerGrants);
      fromRoute[app] = (await settingOf(ADMIN, app)).ownerGrants;
    }
    expect(fromRows).toEqual(fromRoute);
  });
});

describe("a server row says whether a Shared app's team account is connected", () => {
  test("true only for a Shared app whose team account is connected", async () => {
    const { byId } = await rowsFor(MEMBER);
    expect(
      Object.fromEntries(
        apps.map((app) => [app, byId.get(app)?.sharedVendorConnected]),
      ),
    ).toEqual({
      [PERSONAL]: false,
      [BACKFILLED]: false,
      [SHARED_OFF]: false,
      [SHARED_ON]: true,
      [ENTRA]: false,
    });
  });

  test("the fork's own sharedAccount stays beside it, and the team identity never leaves", async () => {
    const { byId, text } = await rowsFor(MEMBER);
    expect(byId.get(SHARED_ON)?.sharedAccount).toEqual({
      connected: true,
      connectedAt: "2026-03-03T00:00:00.000Z",
      connectedBy: ADMIN,
      verified: true,
    });
    expect(byId.get(SHARED_OFF)?.sharedAccount).toEqual({
      connected: false,
      connectedAt: null,
      connectedBy: null,
      verified: false,
    });
    expect(text).not.toContain(TEAM_IDENTITY);
  });
});

describe("the rest of what upstream's page reads off a server row", () => {
  test("skippedTools is an empty list on every row, because this deployment records none", async () => {
    const { byId } = await rowsFor(MEMBER);
    expect(
      Object.fromEntries(apps.map((app) => [app, byId.get(app)?.skippedTools])),
    ).toEqual(Object.fromEntries(apps.map((app) => [app, []])));
  });

  test("entraScope is on the row for a member and an administrator alike, and null where there is none", async () => {
    for (const actor of [MEMBER, ADMIN]) {
      const { byId } = await rowsFor(actor);
      expect({
        marked: byId.get(ENTRA)?.entraScope,
        unmarked: byId.get(PERSONAL)?.entraScope,
      }).toEqual({ marked: ENTRA_SCOPE, unmarked: null });
    }
  });

  test("the store's own listing carries the same fields the page serves", async () => {
    const listed = await runAsTenant(MEMBER, () => store.listServers());
    const row = listed.find((server) => server.id === SHARED_ON);
    expect({
      ownerGrants: row?.ownerGrants,
      ownerGrantsChosen: row?.ownerGrantsChosen,
      skippedTools: row?.skippedTools,
      sharedVendorConnected: row?.sharedVendorConnected,
      entraScope: row?.entraScope,
    }).toEqual({
      ownerGrants: "admin",
      ownerGrantsChosen: null,
      skippedTools: [],
      sharedVendorConnected: true,
      entraScope: null,
    });
  });
});
