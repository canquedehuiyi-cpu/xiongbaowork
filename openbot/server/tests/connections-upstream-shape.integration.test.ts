import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { createAuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import { composioConnections, mcpServers, users } from "../src/db/schema";
import type { ComposioBroker } from "../src/plugins/broker";
import { createPluginRoutes } from "../src/plugins/routes";
import { createPluginStore } from "../src/plugins/store";
import { asPlatform, runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * `GET /api/plugins/connections?shared=1`：在本人自己的连接旁边，把每个 Shared 应用的团队账号也列出来
 * （上游 `shared-brokered-routes.test.ts` 的 `GET /connections`，按 fork 接口改写）。
 *
 * 团队账号那一行带 `holder: "deployment"`、`connected`、`displayName`、`connectedBy`，是上游前端
 * `PluginConnection` 读的四样。本人自己的行不带 `holder`（上游把没有 `holder` 读作本人的）。
 *
 * 只在带 `shared=1` 时才列，是因为不带参数的答案被现有的页面当作「每一行都是我自己的连接」来读：多出
 * 一行团队账号，没连接的 Shared 应用也会被画成「已连接」。不带参数时一行都不多。
 *
 * 谁能看到什么：
 * - 团队账号那一行任何登录的人都看得到（成员要知道这个应用有没有连上、是哪个账号在办事）。
 * - `connectedBy` 是连接它的管理员的邮箱，只给管理员；成员拿到 null。
 * - 团队账号在厂商那边的身份从不出去。
 * - 别人自己的连接从不出现在这个人的列表里。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const slug = suite.replace(/-/g, "_");
const ADMIN = `cus-${suite}-admin`;
const OWNER = `cus-${suite}-owner`;
const TEAMMATE = `cus-${suite}-teammate`;
const people = [ADMIN, OWNER, TEAMMATE];
const ADMIN_EMAIL = `${ADMIN}@people.example.test`;
/** 个人账号应用，OWNER 连了自己的。 */
const MAIL = `cus_mail_${slug}`;
/** Shared 应用，团队账号已连。 */
const TEAM_ON = `cus_team_on_${slug}`;
/** Shared 应用，团队账号还没连。 */
const TEAM_OFF = `cus_team_off_${slug}`;
const apps = [MAIL, TEAM_ON, TEAM_OFF];
const identityOf = (app: string) =>
  `openbot-deployment:${suite}:TEAMSECRET-${app}`;
const CONNECTED_AT = "2026-04-04T00:00:00.000Z";
const VERIFIED_AT = "2026-04-05T00:00:00.000Z";

const vendor = {
  named: [] as { userId: string; toolkit: string }[],
  down: false,
};
const broker = {
  listApps: async () => [],
  accountsOf: async (request: { userId: string; toolkit: string }) => {
    vendor.named.push(request);
    if (vendor.down) throw new Error("the vendor did not answer");
    return [
      {
        accountId: "ca_team",
        identity: "acme-bot",
        connectedAt: CONNECTED_AT,
      },
    ];
  },
} as unknown as ComposioBroker;
const store = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: { readSecret: async () => null } as never,
  encryptionKey: "x".repeat(44),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  broker,
});

function as(actorId: string) {
  const session: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", {
      id: actorId,
      email: `${actorId}@session.example.test`,
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
    ),
  );
}

async function connectionsFor(actor: string, query = "") {
  const response = await as(actor).request(`/api/plugins/connections${query}`);
  expect(response.status).toBe(200);
  const text = await response.text();
  const body = JSON.parse(text) as {
    connections: ({ serverId: string } & Record<string, unknown>)[];
  };
  return {
    text,
    rows: body.connections.filter((row) => apps.includes(row.serverId)),
  };
}

beforeAll(async () => {
  await asPlatform(async () => {
    await database.insert(users).values(
      people.map((id) => ({
        id,
        email: id === ADMIN ? ADMIN_EMAIL : `${id}@people.example.test`,
      })),
    );
    for (const [app, mode, connected] of [
      [MAIL, "personal", false],
      [TEAM_ON, "shared", true],
      [TEAM_OFF, "shared", false],
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
        ...(mode === "shared"
          ? {
              sharedVendorUserId: identityOf(app),
              ...(connected
                ? {
                    sharedConnectedAt: new Date(CONNECTED_AT),
                    sharedConnectedBy: ADMIN,
                    sharedVerified: true,
                    sharedVerifiedAt: new Date(VERIFIED_AT),
                  }
                : {}),
            }
          : {}),
      });
    }
  });
  await runAsTenant(OWNER, () =>
    database.insert(composioConnections).values({
      toolkit: MAIL,
      userId: OWNER,
      verified: true,
      connectedAt: new Date(CONNECTED_AT),
      verifiedAt: new Date(VERIFIED_AT),
    }),
  );
});

afterAll(async () => {
  await asPlatform(async () => {
    await database
      .delete(composioConnections)
      .where(inArray(composioConnections.toolkit, apps));
    await database.delete(mcpServers).where(inArray(mcpServers.id, apps));
    await database.delete(users).where(inArray(users.id, people));
  });
  await database.$client.close();
});

/** OWNER 自己在 MAIL 上的连接，store 原样给出的那一行。 */
const OWN_MAIL = {
  serverId: MAIL,
  scope: "",
  connectedAt: CONNECTED_AT,
  verified: true,
  verifiedAt: VERIFIED_AT,
  probe: null,
  checkable: false,
};

describe("GET /connections with no parameter answers what it always answered", () => {
  test("a person's own rows only, with no holder on them and no team account beside them", async () => {
    const { rows } = await connectionsFor(OWNER);
    expect(rows).toEqual([OWN_MAIL]);
  });

  test("a parameter that is not exactly shared=1 changes nothing", async () => {
    for (const query of ["?shared=0", "?shared=true", "?shared="]) {
      const { rows } = await connectionsFor(OWNER, query);
      expect(rows).toEqual([OWN_MAIL]);
    }
  });
});

describe("GET /connections?shared=1 lists each Shared app's team account beside a person's own", () => {
  test("a connected team account is listed once as the deployment's, with its display name, for a member", async () => {
    vendor.named.length = 0;
    const { rows } = await connectionsFor(TEAMMATE, "?shared=1");
    expect(rows.filter((row) => row.serverId === TEAM_ON)).toEqual([
      {
        serverId: TEAM_ON,
        scope: "",
        holder: "deployment",
        connected: true,
        connectedAt: CONNECTED_AT,
        connectedBy: null,
        verified: true,
        verifiedAt: VERIFIED_AT,
        probe: null,
        checkable: false,
        displayName: "acme-bot",
      },
    ]);
    // 名字是按团队身份向厂商问来的，只为已连接的那一个问。
    expect(vendor.named).toEqual([
      { userId: identityOf(TEAM_ON), toolkit: TEAM_ON },
    ]);
  });

  test("an unconnected Shared app is listed as not connected rather than left out", async () => {
    const { rows } = await connectionsFor(TEAMMATE, "?shared=1");
    expect(rows.filter((row) => row.serverId === TEAM_OFF)).toEqual([
      {
        serverId: TEAM_OFF,
        scope: "",
        holder: "deployment",
        connected: false,
        connectedAt: null,
        connectedBy: null,
        verified: false,
        verifiedAt: null,
        probe: null,
        checkable: false,
        displayName: null,
      },
    ]);
  });

  test("a person's own row keeps its shape and carries no holder, so it reads as theirs", async () => {
    const { rows } = await connectionsFor(OWNER, "?shared=1");
    expect(rows.filter((row) => row.serverId === MAIL)).toEqual([OWN_MAIL]);
    expect(rows.map((row) => row.serverId)).toEqual([MAIL, TEAM_OFF, TEAM_ON]);
  });

  test("a vendor that will not name the account costs the label, never the read", async () => {
    vendor.down = true;
    try {
      const { rows } = await connectionsFor(TEAMMATE, "?shared=1");
      expect(
        rows
          .filter((row) => row.serverId === TEAM_ON)
          .map((row) => ({
            connected: row.connected,
            displayName: row.displayName,
          })),
      ).toEqual([{ connected: true, displayName: null }]);
    } finally {
      vendor.down = false;
    }
  });
});

describe("who sees what of a team account's row", () => {
  test("an administrator is told who connected it, by email", async () => {
    const { rows } = await connectionsFor(ADMIN, "?shared=1");
    expect(
      rows
        .filter((row) => row.serverId === TEAM_ON)
        .map((row) => row.connectedBy),
    ).toEqual([ADMIN_EMAIL]);
  });

  test("a member is not: neither the administrator's email nor their id leaves", async () => {
    const { text, rows } = await connectionsFor(TEAMMATE, "?shared=1");
    expect(
      rows
        .filter((row) => row.serverId === TEAM_ON)
        .map((row) => row.connectedBy),
    ).toEqual([null]);
    expect(text).not.toContain(ADMIN_EMAIL);
    expect(text).not.toContain(ADMIN);
  });

  test("the team account's identity at the vendor never leaves, for anybody", async () => {
    for (const actor of [ADMIN, TEAMMATE]) {
      const { text } = await connectionsFor(actor, "?shared=1");
      expect(text).not.toContain("TEAMSECRET");
      expect(text).not.toContain("openbot-deployment:");
    }
  });

  test("a teammate sees none of somebody else's own connections", async () => {
    const { rows, text } = await connectionsFor(TEAMMATE, "?shared=1");
    expect(rows.filter((row) => row.serverId === MAIL)).toEqual([]);
    expect(rows.map((row) => row.holder)).toEqual(["deployment", "deployment"]);
    expect(text).not.toContain(OWNER);
  });
});
