import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, like, or } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { readAppAccessRequestAnswer } from "../../shared/app-access-request";
import type { AuditEventInput, AuditStore } from "../src/audit";
import { createAdminScope } from "../src/auth/admin-scope";
import { type AppVariables, createRoleRepository } from "../src/auth/guards";
import type {
  CredentialSecretReader,
  CredentialStore,
} from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  appAccessRequests,
  composioConnections,
  mcpServers,
  mcpTools,
  pluginGrants,
  teamBotConsentDefaults,
  teamBotPublications,
  users,
} from "../src/db/schema";
import { pluginInstallListings } from "../src/db/schema/plugin-install-listings";
import type { AppAccess } from "../src/plugins/app-access";
import { appAccessTools } from "../src/plugins/app-access-tool";
import type { BrokerApp, ComposioBroker } from "../src/plugins/broker";
import { createPluginRoutes } from "../src/plugins/routes";
import {
  type AppAccessRequestRecord,
  createPluginStore,
} from "../src/plugins/store";
import { runAsTenant } from "../src/tenant/context";
import { seedAdministrator } from "./support/admin-request";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * 上游的应用访问审批（`app-access-routes.integration.test.ts`），按 fork 的接口改写（X2）：
 * 每个应用对一个人在一位员工上是什么、只有管理员能解决时怎么申请、批准做了什么。真实的表、真实的行安全、
 * 真实的路由；只有 Composio 的目录是假的（它是唯一会出本进程的读）。
 *
 * 与上游用例的差异按 fork 底线改写：
 * - 账号读 X1 的模型：个人账号在 `composio_connections`，团队账号在应用行的 `shared_*` 列。
 * - 共享闸门固定为 X1 最严一档（员工主人与管理员）：Team Bot 的队友在 Shared 应用上是 `shared_not_approved`。
 * - `connect_shared` 不建申请（fork 0153 的 CHECK）；批准 enable 是上架（D08），不授予。
 * - 批准先改后关单（fork 测试钉住的顺序），不是上游的先认领。
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

const store = createPluginStore({
  database,
  auditStore: audit,
  credentials: {
    readSecret: async () => null,
    create: async () => {
      throw new Error("this suite does not write credentials");
    },
    revoke: async () => {
      throw new Error("this suite does not revoke credentials");
    },
  } as unknown as CredentialSecretReader & CredentialStore,
  encryptionKey: "x".repeat(44),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
});
const adminScope = createAdminScope({
  roleRepository: createRoleRepository(database),
});

const suite = randomUUID().slice(0, 8);
const id = (name: string) => `aup-${suite}-${name}`;
const person = id("person");
const maker = id("maker");
const admin = id("admin");
const crowded = id("crowded");
const people = [person, maker, crowded];

/** person 自己的私有员工。 */
const personBot = id("person-bot");
/** maker 的 Team Bot，已发布给全队。 */
const teamBot = id("team-bot");
/** 谁都不能用的员工（canUseBot 拒绝）。 */
const hidden = id("hidden");

const slug = (name: string) => `${name}_${suite}`;
const row = (name: string) => `composio-${slug(name)}`;
const GMAIL = row("gmail");
const SLACK = row("slack");
const LINEAR = row("linear");
const NEWS = row("news");
const CALENDAR = row("calendar");
const STALE = row("stale");
const DROPBOX = row("dropbox");
const CUSTOM = id("custom");
const brokered = [GMAIL, SLACK, LINEAR, NEWS, CALENDAR, STALE];
const servers = [...brokered, CUSTOM];

const directory: BrokerApp[] = [
  {
    slug: slug("dropbox"),
    name: `Dropbox ${suite}`,
    description: "Files",
    logo: null,
    categories: [],
    actionCount: 1,
    connection: { kind: "consent" },
  },
];
const broker = {
  listApps: async () => directory,
} as unknown as ComposioBroker;

const canUseBot = async (_actor: unknown, agentId: string) =>
  agentId !== hidden;

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
    canUseBot,
    undefined,
    { broker },
    adminScope,
  );
}
const asPerson = () => routesAs({ id: person, role: "user" });
const asMaker = () => routesAs({ id: maker, role: "user" });
const asAdmin = () => routesAs({ id: admin, role: "admin" });
const asCrowded = () => routesAs({ id: crowded, role: "user" });

const json = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const post = { method: "POST" };
const asPlatform = <T>(work: () => Promise<T>) => runAsTenant("platform", work);

async function appsOf(
  routes: ReturnType<typeof routesAs>,
  agentId: string,
): Promise<AppAccess[]> {
  const response = await routes.request(`/for/${agentId}/apps`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { apps: AppAccess[] }).apps;
}
async function appOf(
  routes: ReturnType<typeof routesAs>,
  agentId: string,
  app: string,
) {
  return routes.request(`/for/${agentId}/apps/${encodeURIComponent(app)}`);
}
const access = async (
  routes: ReturnType<typeof routesAs>,
  agentId: string,
  app: string,
) =>
  ((await (await appOf(routes, agentId, app)).json()) as { app: AppAccess })
    .app;

const requestRow = async (requestId: string) => {
  const [found] = await asPlatform(() =>
    database
      .select({
        tenantId: appAccessRequests.tenantId,
        status: appAccessRequests.status,
        serverId: appAccessRequests.serverId,
        appKey: appAccessRequests.appKey,
        kind: appAccessRequests.kind,
      })
      .from(appAccessRequests)
      .where(eq(appAccessRequests.id, requestId)),
  );
  return found;
};
const grantsOn = (agentId: string) =>
  asPlatform(async () =>
    (
      await database
        .select({ ref: pluginGrants.ref })
        .from(pluginGrants)
        .where(eq(pluginGrants.agentId, agentId))
    )
      .map((grant) => grant.ref)
      .sort(),
  );

let releaseAdmin: (() => Promise<void>) | undefined;

beforeAll(async () => {
  releaseAdmin = await seedAdministrator(database, admin);
  await asPlatform(async () => {
    await database
      .insert(users)
      .values(people.map((who) => ({ id: who, email: `${who}@example.test` })));
    const bot = async (botId: string, tenant: string, owner: string) => {
      await database.insert(agents).values({
        id: botId,
        tenantId: tenant,
        name: `员工 ${botId}`,
        type: "built_in",
        configuration: {},
      });
      await database.insert(agentProfiles).values({
        agentId: botId,
        tenantId: tenant,
        ownerUserId: owner,
        title: "助理",
        roleDescription: "测试用。",
        avatarSeed: botId,
        visibility: "private",
      });
    };
    await bot(personBot, person, person);
    await bot(teamBot, "team", maker);
    await bot(hidden, maker, maker);
    await database.insert(teamBotPublications).values({
      tenantId: "team",
      agentId: teamBot,
      publishedBy: maker,
      audience: "team",
    });

    const app = (
      serverId: string,
      title: string,
      extra: Partial<typeof mcpServers.$inferInsert> = {},
    ) => ({
      tenantId: "team",
      id: serverId,
      title,
      vendor: "composio",
      url: `composio://${serverId.slice("composio-".length)}`,
      provenance: "composio",
      authScheme: "OAUTH2",
      ...extra,
    });
    await database.insert(mcpServers).values([
      app(GMAIL, `Gmail ${suite}`),
      app(SLACK, `Slack ${suite}`, {
        accountMode: "shared",
        sharedVendorUserId: `openbot-deployment:test:${suite}`,
        sharedConnectedAt: new Date(),
        sharedConnectedBy: admin,
        sharedVerified: true,
      }),
      app(LINEAR, `Linear ${suite}`, {
        accountMode: "shared",
        sharedVendorUserId: `openbot-deployment:test:${suite}-l`,
      }),
      app(NEWS, `News ${suite}`, { authScheme: "NO_AUTH" }),
      app(CALENDAR, `Calendar ${suite}`),
      app(STALE, `Stale ${suite}`),
      {
        tenantId: "team",
        id: CUSTOM,
        title: `内部应用 ${suite}`,
        vendor: "test",
        url: "https://example.invalid/mcp",
        provenance: "custom",
      },
    ]);
    const tool = (
      serverId: string,
      name: string,
      effect: string,
      destructive = false,
    ) => ({
      tenantId: "team",
      serverId,
      name,
      description: name,
      effect,
      destructive,
    });
    await database
      .insert(mcpTools)
      .values([
        tool(GMAIL, "fetch", "read"),
        tool(GMAIL, "send", "write"),
        tool(SLACK, "read", "read"),
        tool(LINEAR, "read", "read"),
        tool(NEWS, "read", "read"),
        tool(CALENDAR, "list", "read"),
        tool(CALENDAR, "create", "write"),
        tool(STALE, "list", "read"),
        tool(CUSTOM, "search", "read"),
        tool(CUSTOM, "send", "write"),
        tool(CUSTOM, "purge", "read", true),
      ]);
    const grant = (tenantId: string, agentId: string, ref: string) => ({
      tenantId,
      kind: "mcp",
      ref,
      agentId,
      grantedBy: "admin@example.test",
    });
    await database
      .insert(pluginGrants)
      .values([
        grant(person, personBot, `${GMAIL}/fetch`),
        grant(person, personBot, `${SLACK}/read`),
        grant(person, personBot, `${LINEAR}/read`),
        grant(person, personBot, `${NEWS}/read`),
        grant(person, personBot, `${STALE}/list`),
        grant("team", teamBot, `${GMAIL}/fetch`),
        grant("team", teamBot, `${SLACK}/read`),
      ]);
    await database.insert(composioConnections).values([
      {
        tenantId: person,
        toolkit: slug("gmail"),
        userId: person,
        verified: true,
      },
      {
        tenantId: person,
        toolkit: slug("stale"),
        userId: person,
        verified: false,
        probeAction: "STALE_LIST",
      },
    ]);
  });
});

afterAll(async () => {
  await asPlatform(async () => {
    await database
      .delete(appAccessRequests)
      .where(
        or(
          inArray(appAccessRequests.requesterUserId, [...people, admin]),
          like(appAccessRequests.appKey, `%${suite}%`),
        ),
      );
    await database
      .delete(pluginGrants)
      .where(inArray(pluginGrants.agentId, [personBot, teamBot, hidden]));
    await database
      .delete(composioConnections)
      .where(inArray(composioConnections.userId, people));
    await database
      .delete(teamBotConsentDefaults)
      .where(inArray(teamBotConsentDefaults.userId, people));
    await database.delete(mcpTools).where(inArray(mcpTools.serverId, servers));
    await database.delete(mcpServers).where(inArray(mcpServers.id, servers));
    await database
      .delete(agents)
      .where(inArray(agents.id, [personBot, teamBot, hidden]));
    await database.delete(users).where(inArray(users.id, people));
  });
  await releaseAdmin?.();
});

describe("what each app a Bot holds is, for the person asking", () => {
  test("every state a held app can be in, named by the app's own name", async () => {
    const apps = await appsOf(asPerson(), personBot);
    const byKey = new Map(apps.map((app) => [app.key, app]));
    expect(byKey.get(GMAIL)).toMatchObject({
      displayName: `Gmail ${suite}`,
      provider: "composio",
      account: "personal",
      connect: "consent",
      state: "ready",
      accountHolder: "you",
      asksFirst: false,
      granted: true,
      requestKind: null,
    });
    expect(byKey.get(GMAIL)?.connectedAt).not.toBeNull();
    expect(byKey.get(STALE)?.state).toBe("reconnect");
    // 团队账号已连接，但 X3 之前没有共享使用批准：调用会被 X1 的闸门拒绝，状态照实说，也没有可申请的。
    expect(byKey.get(SLACK)).toMatchObject({
      account: "shared",
      accountMode: "shared",
      state: "shared_not_approved",
      requestKind: null,
    });
    expect(byKey.get(LINEAR)).toMatchObject({
      account: "shared",
      state: "shared_not_connected",
      // fork：connect_shared 不建申请（0153 的 CHECK）。
      requestKind: null,
    });
    expect(byKey.get(NEWS)).toMatchObject({
      account: "deployment",
      state: "ready",
    });
    // 名字排序，两次读同一顺序。
    expect(apps.map((app) => app.displayName)).toEqual(
      [...apps.map((app) => app.displayName)].sort((a, b) =>
        a.localeCompare(b),
      ),
    );
  });

  test("a Bot the person cannot use answers 404", async () => {
    expect((await asPerson().request(`/for/${hidden}/apps`)).status).toBe(404);
    expect((await appOf(asPerson(), hidden, GMAIL)).status).toBe(404);
  });
});

describe("one app, by key or by name, held or not", () => {
  test("an enabled app the Bot does not hold is not_granted, found by its name", async () => {
    const app = await access(asPerson(), personBot, `calendar ${suite}`);
    expect(app).toMatchObject({
      key: CALENDAR,
      state: "not_granted",
      granted: false,
      requestKind: "grant",
      request: null,
    });
  });

  test("an app only the directory knows is disabled, under the id enabling would mint, and says how it connects", async () => {
    const app = await access(asPerson(), personBot, `Dropbox ${suite}`);
    expect(app).toMatchObject({
      key: DROPBOX,
      state: "disabled",
      unavailable: "absent",
      connect: "consent",
      requestKind: "enable",
    });
  });

  test("a catalogue entry nobody added is disabled under its key", async () => {
    const app = await access(asPerson(), personBot, "parallel-authenticated");
    expect(app).toMatchObject({
      key: "parallel-authenticated",
      provider: "catalogue",
      state: "disabled",
      unavailable: "absent",
      requestKind: "enable",
    });
  });

  test("a word that names no app is 404, and so is one past the length cap", async () => {
    expect(
      (await appOf(asPerson(), personBot, `nothing-${suite}`)).status,
    ).toBe(404);
    expect((await appOf(asPerson(), personBot, "x".repeat(201))).status).toBe(
      404,
    );
  });
});

describe("asking for access", () => {
  let calendarRequest = "";

  test("files the kind the state needs, once, and the status shows it", async () => {
    const before = eventsOf("app_access.requested").length;
    const first = await asPerson().request(
      "/access-requests",
      json({ agentId: personBot, app: `Calendar ${suite}`, note: "要看日程" }),
    );
    expect(first.status).toBe(201);
    const filed = (await first.json()) as {
      request: AppAccessRequestRecord;
      created: boolean;
    };
    expect(filed.created).toBe(true);
    expect(filed.request).toMatchObject({
      appKey: CALENDAR,
      appTitle: `Calendar ${suite}`,
      kind: "grant",
      status: "pending",
      agentId: personBot,
      botId: personBot,
      requestedBy: person,
      requesterUserId: person,
      note: "要看日程",
      resolvedAt: null,
    });
    calendarRequest = filed.request.id;
    expect(await requestRow(calendarRequest)).toMatchObject({
      tenantId: person,
      serverId: CALENDAR,
    });
    expect(eventsOf("app_access.requested").length).toBe(before + 1);

    const again = await asPerson().request(
      "/access-requests",
      json({ agentId: personBot, app: CALENDAR }),
    );
    expect(again.status).toBe(200);
    expect(
      (await again.json()) as { request: { id: string }; created: boolean },
    ).toMatchObject({ request: { id: calendarRequest }, created: false });
    expect(eventsOf("app_access.requested").length).toBe(before + 1);

    const shown = await access(asPerson(), personBot, CALENDAR);
    expect(shown.request).toMatchObject({ id: calendarRequest, kind: "grant" });
  });

  test("an app with no row is filed under its key and title, and appears in the person's own list", async () => {
    const response = await asPerson().request(
      "/access-requests",
      json({ agentId: personBot, app: `Dropbox ${suite}` }),
    );
    expect(response.status).toBe(201);
    const { request } = (await response.json()) as {
      request: AppAccessRequestRecord;
    };
    expect(request).toMatchObject({
      appKey: DROPBOX,
      appTitle: `Dropbox ${suite}`,
      kind: "enable",
      // 没有行：fork 记录的 `serverId` 是空串（类型是既有测试钉住的 string），数据库里是 NULL。
      serverId: "",
    });
    expect(await requestRow(request.id)).toMatchObject({
      serverId: null,
      appKey: DROPBOX,
    });
    const again = await asPerson().request(
      "/access-requests",
      json({ agentId: personBot, app: DROPBOX }),
    );
    expect(again.status).toBe(200);
    const mine = (await (
      await asPerson().request("/access-requests/mine")
    ).json()) as { requests: AppAccessRequestRecord[] };
    expect(mine.requests.map((one) => one.appKey)).toContain(DROPBOX);
  });

  test("a state the person can fix themselves is refused, and the refusal is in the trail", async () => {
    for (const [app, reason] of [
      [GMAIL, "nothing_to_request:ready"],
      [STALE, "nothing_to_request:reconnect"],
      [LINEAR, "nothing_to_request:shared_not_connected"],
    ] as const) {
      const response = await asPerson().request(
        "/access-requests",
        json({ agentId: personBot, app }),
      );
      expect(response.status).toBe(409);
      expect(((await response.json()) as { error: string }).error).toMatch(
        /[一-龥]/,
      );
      expect(
        eventsOf("app_access.refused").some(
          (event) =>
            event.targetId === app &&
            (event.payload as { reason?: string }).reason === reason,
        ),
      ).toBe(true);
    }
  });

  test("a Bot the person cannot use, an unknown app, and an unvouched composio- id are refused and recorded", async () => {
    const hiddenBot = await asPerson().request(
      "/access-requests",
      json({ agentId: hidden, app: CALENDAR }),
    );
    expect(hiddenBot.status).toBe(404);
    const unknown = await asPerson().request(
      "/access-requests",
      json({ agentId: personBot, app: `no-such-${suite}` }),
    );
    expect(unknown.status).toBe(404);
    const unvouched = await asPerson().request(
      "/access-requests",
      json({ agentId: personBot, app: `composio-made-up-${suite}` }),
    );
    expect(unvouched.status).toBe(404);
    const reasons = eventsOf("app_access.refused").map(
      (event) => (event.payload as { reason?: string }).reason,
    );
    expect(reasons).toContain("no_such_bot");
    expect(reasons).toContain("no_such_app");
  });

  test("names past the cap and a missing name are refused before anything is read or written", async () => {
    for (const body of [
      { agentId: personBot, app: "x".repeat(201) },
      { agentId: "x".repeat(201), app: CALENDAR },
      { agentId: personBot },
      { agentId: personBot, app: CALENDAR, note: "长".repeat(501) },
    ]) {
      const response = await asPerson().request("/access-requests", json(body));
      expect(response.status).toBe(400);
    }
  });

  test("at 20 waiting a new one is refused, and one already waiting is still shown", async () => {
    await runAsTenant(crowded, () =>
      database.insert(appAccessRequests).values(
        Array.from({ length: 20 }, (_, index) => ({
          serverId: null,
          appKey: `${id("filler")}-${index}`,
          appTitle: `填充 ${index}`,
          botId: personBot,
          requesterUserId: crowded,
          kind: "enable",
        })),
      ),
    );
    const refused = await asCrowded().request(
      "/access-requests",
      json({ agentId: personBot, app: CALENDAR }),
    );
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as { error: string }).error).toContain(
      "20 条申请",
    );
  });

  test("a person withdraws their own, and nobody else can touch it", async () => {
    const response = await asPerson().request(
      "/access-requests",
      json({ agentId: personBot, app: CUSTOM }),
    );
    expect(response.status).toBe(201);
    const { request } = (await response.json()) as {
      request: AppAccessRequestRecord;
    };
    expect(
      (
        await asMaker().request(`/access-requests/${request.id}`, {
          method: "DELETE",
        })
      ).status,
    ).toBe(404);
    const withdrawn = await asPerson().request(
      `/access-requests/${request.id}`,
      { method: "DELETE" },
    );
    expect(withdrawn.status).toBe(200);
    expect(
      eventsOf("app_access.cancelled").some(
        (event) =>
          (event.payload as { request?: string }).request === request.id,
      ),
    ).toBe(true);
  });

  test("the request_app_access tool's 上架 request counts as asked on the card", async () => {
    await runAsTenant(person, () =>
      store.fileAppAccessRequest({
        serverId: CUSTOM,
        botId: personBot,
        requesterUserId: person,
        kind: "enable",
        note: "工具提的",
        maxPending: 20,
      }),
    );
    const app = await access(asPerson(), personBot, CUSTOM);
    expect(app).toMatchObject({ state: "not_granted", requestKind: "grant" });
    expect(app.request?.kind).toBe("enable");
  });
});

describe("answering a request", () => {
  test("only an administrator sees the inbox, with counts per app and an app filter", async () => {
    expect((await asPerson().request("/access-requests")).status).toBe(403);
    const response = await asAdmin().request("/access-requests");
    expect(response.status).toBe(200);
    const inbox = (await response.json()) as {
      requests: AppAccessRequestRecord[];
      counts: { total: number; byApp: Record<string, number> };
    };
    expect(inbox.counts.byApp[CALENDAR]).toBe(1);
    expect(inbox.counts.total).toBeGreaterThanOrEqual(inbox.requests.length);
    const one = (await (
      await asAdmin().request(`/access-requests?app=${CALENDAR}`)
    ).json()) as { requests: AppAccessRequestRecord[] };
    expect(one.requests.map((request) => request.appKey)).toEqual([CALENDAR]);
  });

  test("`refs` narrows the grant, and a ref outside the app is refused and leaves it pending", async () => {
    const [pending] = await runAsTenant(person, () =>
      store.pendingAppAccessRequests({ requesterUserId: person }),
    ).then((rows) => rows.filter((row) => row.appKey === CALENDAR));
    const requestId = pending?.id ?? "";
    const outside = await asAdmin().request(
      `/access-requests/${requestId}/approve`,
      json({ refs: [`${GMAIL}/send`] }),
    );
    expect(outside.status).toBe(400);
    expect((await requestRow(requestId))?.status).toBe("pending");
    const bad = await asAdmin().request(
      `/access-requests/${requestId}/approve`,
      json({ refs: "all" }),
    );
    expect(bad.status).toBe(400);

    const approved = await asAdmin().request(
      `/access-requests/${requestId}/approve`,
      json({ refs: [`${CALENDAR}/create`] }),
    );
    expect(approved.status).toBe(200);
    const body = (await approved.json()) as {
      granted: string[];
      enabled: boolean;
      request: AppAccessRequestRecord;
    };
    expect(body.granted).toEqual([`${CALENDAR}/create`]);
    expect(body.enabled).toBe(false);
    expect(body.request.status).toBe("approved");
    expect(await grantsOn(personBot)).toContain(`${CALENDAR}/create`);
    expect(await grantsOn(personBot)).not.toContain(`${CALENDAR}/list`);
    expect(
      eventsOf("app_access.approved").some(
        (event) =>
          (event.payload as { request?: string }).request === requestId,
      ),
    ).toBe(true);
  });

  test("an app that needs what only an administrator can type stays pending", async () => {
    const response = await asPerson().request(
      "/access-requests",
      json({ agentId: personBot, app: "parallel-authenticated" }),
    );
    expect(response.status).toBe(201);
    const { request } = (await response.json()) as {
      request: AppAccessRequestRecord;
    };
    const approve = await asAdmin().request(
      `/access-requests/${request.id}/approve`,
      post,
    );
    expect(approve.status).toBe(409);
    expect(((await approve.json()) as { error: string }).error).toContain(
      "密钥",
    );
    expect((await requestRow(request.id))?.status).toBe("pending");
  });

  test("an app only the broker's directory knows asks the administrator to enable it first", async () => {
    const [dropbox] = (
      await runAsTenant(person, () =>
        store.pendingAppAccessRequests({ requesterUserId: person }),
      )
    ).filter((row) => row.appKey === DROPBOX);
    const approve = await asAdmin().request(
      `/access-requests/${dropbox?.id}/approve`,
      post,
    );
    expect(approve.status).toBe(409);
    expect(((await approve.json()) as { error: string }).error).toContain(
      "启用",
    );
    expect((await requestRow(dropbox?.id ?? ""))?.status).toBe("pending");
  });

  test("dismissing changes nothing but the request, and is in the trail", async () => {
    const [dropbox] = (
      await runAsTenant(person, () =>
        store.pendingAppAccessRequests({ requesterUserId: person }),
      )
    ).filter((row) => row.appKey === DROPBOX);
    const dismissed = await asAdmin().request(
      `/access-requests/${dropbox?.id}/dismiss`,
      post,
    );
    expect(dismissed.status).toBe(200);
    expect(
      eventsOf("app_access.dismissed").some(
        (event) =>
          (event.payload as { request?: string }).request === dropbox?.id,
      ),
    ).toBe(true);
  });
});

describe("an administrator's one press on a card", () => {
  test("gives the app's read-only, non-destructive actions to the Bot, with the trail two presses leave", async () => {
    // 先撤回工具提的那条，免得这次一按读到它。
    for (const pending of await runAsTenant(person, () =>
      store.pendingAppAccessRequests({ requesterUserId: person }),
    ))
      if (pending.appKey === CUSTOM)
        await runAsTenant(person, () =>
          store.cancelAppAccessRequest({
            id: pending.id,
            requesterUserId: person,
          }),
        );
    const response = await asAdmin().request(
      `/for/${personBot}/apps/${CUSTOM}/approve`,
      post,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      granted: string[];
      request: AppAccessRequestRecord;
    };
    expect(body.granted).toEqual([`${CUSTOM}/search`]);
    expect(body.request).toMatchObject({
      requestedBy: admin,
      status: "approved",
    });
    expect(await requestRow(body.request.id)).toMatchObject({
      tenantId: admin,
      status: "approved",
    });
    const granted = await grantsOn(personBot);
    expect(granted).toContain(`${CUSTOM}/search`);
    expect(granted).not.toContain(`${CUSTOM}/send`);
    expect(granted).not.toContain(`${CUSTOM}/purge`);
    const approved = eventsOf("app_access.approved").find(
      (event) =>
        (event.payload as { request?: string }).request === body.request.id,
    );
    expect(
      (approved?.payload as { direct?: boolean } | undefined)?.direct,
    ).toBe(true);
  });

  test("only an administrator may press it, and nothing is filed for anybody else", async () => {
    const response = await asPerson().request(
      `/for/${personBot}/apps/${CALENDAR}/approve`,
      post,
    );
    expect(response.status).toBe(403);
    const pending = await runAsTenant(person, () =>
      store.pendingAppAccessRequests({ requesterUserId: person }),
    );
    expect(pending.filter((row) => row.appKey === CALENDAR)).toEqual([]);
  });

  test("a state with nothing for an administrator to do is refused like a request", async () => {
    const response = await asAdmin().request(
      `/for/${personBot}/apps/${NEWS}/approve`,
      post,
    );
    expect(response.status).toBe(409);
  });

  test("a press that cannot be carried out leaves no request waiting", async () => {
    const response = await asAdmin().request(
      `/for/${personBot}/apps/parallel-authenticated/approve`,
      post,
    );
    expect(response.status).toBe(409);
    const waiting = await runAsTenant(admin, () =>
      store.pendingAppAccessRequests({ requesterUserId: admin }),
    );
    expect(waiting).toEqual([]);
    expect(
      eventsOf("app_access.cancelled").some(
        (event) => (event.payload as { direct?: boolean }).direct === true,
      ),
    ).toBe(true);
  });
});

describe("a teammate on somebody else's Team Bot, and team accounts (X1 底线)", () => {
  test("a Shared app is not theirs to drive: shared_not_approved, and nothing to request", async () => {
    const app = await access(asPerson(), teamBot, SLACK);
    expect(app).toMatchObject({
      account: "shared",
      state: "shared_not_approved",
      requestKind: null,
    });
    const filed = await asPerson().request(
      "/access-requests",
      json({ agentId: teamBot, app: SLACK }),
    );
    expect(filed.status).toBe(409);
  });

  test("until shared use is approved (X3), nobody drives a team account: not the owner, not an administrator", async () => {
    // X1 的闸门（评审 C1）：没有共享使用批准就拒绝，管理员也不例外；状态与调用时的答案一致。
    expect((await access(asMaker(), teamBot, SLACK)).state).toBe(
      "shared_not_approved",
    );
    expect((await access(asAdmin(), teamBot, SLACK)).state).toBe(
      "shared_not_approved",
    );
  });

  test("with no owner account, the teammate's own, asked first until they always allow it", async () => {
    const first = await access(asPerson(), teamBot, GMAIL);
    expect(first).toMatchObject({
      state: "ready",
      accountHolder: "you",
      asksFirst: true,
    });
    await runAsTenant(person, () =>
      database
        .insert(teamBotConsentDefaults)
        .values({ tenantId: person, userId: person, serverId: GMAIL }),
    );
    expect((await access(asPerson(), teamBot, GMAIL)).asksFirst).toBe(false);
  });

  test("the owner reads their own account, and is never asked", async () => {
    const owners = await access(asMaker(), teamBot, GMAIL);
    expect(owners).toMatchObject({
      state: "not_connected",
      accountHolder: "you",
      asksFirst: false,
    });
  });
});

/*
 * 安全评审的修正（X2 评审 I1、M1、M2、M4、M5）：每项自备数据，放在最后，不改上面用例的前提。
 */
describe("review fixes", () => {
  /** 申请时还没有行、之后被打开、但仍读不出怎么连接的 broker 应用（I1）。 */
  const BOX = row("box");
  /** 已上架、但读不出怎么连接的 broker 应用：状态是 disabled，要的是打开，不是授予（M4）。 */
  const VAULT = row("vault");
  /** 一按批准时 carryOut 会抛出的应用（M1）。 */
  const THROWS = id("throws");
  /** 两个入口先后申请的应用（M4）。 */
  const TOOL_FIRST = id("tool-first");
  const ROUTE_FIRST = id("route-first");
  const added = [BOX, VAULT, THROWS, TOOL_FIRST, ROUTE_FIRST];
  const noisy = id("noisy");
  const repeat = id("repeat");
  const makersConnectedAt = new Date("2020-01-02T03:04:05.000Z");
  let boxRequest = "";

  const toolAs = (actorId: string, botId: string) => {
    const [tool] = appAccessTools({
      store,
      botId,
      actorId,
      composioConfigured: true,
      directory: async () => directory,
    });
    if (!tool) throw new Error("no request_app_access tool");
    return (app: string) =>
      runAsTenant(actorId, () => tool.execute({ app, reason: "评审用例" }));
  };
  const refusedBy = (actor: string) =>
    events.filter(
      (event) =>
        event.eventType === "app_access.refused" && event.actorUserId === actor,
    );

  beforeAll(async () => {
    const [filed] = await runAsTenant(person, () =>
      database
        .insert(appAccessRequests)
        .values({
          serverId: null,
          appKey: BOX,
          appTitle: `Box ${suite}`,
          botId: personBot,
          requesterUserId: person,
          kind: "enable",
        })
        .returning({ id: appAccessRequests.id }),
    );
    boxRequest = filed?.id ?? "";
    await asPlatform(async () => {
      await database.insert(mcpServers).values([
        ...[BOX, VAULT].map((serverId) => ({
          tenantId: "team",
          id: serverId,
          title: `${serverId} 应用`,
          vendor: "composio",
          url: `composio://${serverId.slice("composio-".length)}`,
          provenance: "composio",
          authScheme: null,
        })),
        ...[THROWS, TOOL_FIRST, ROUTE_FIRST].map((serverId) => ({
          tenantId: "team",
          id: serverId,
          title: `${serverId} 应用`,
          vendor: "test",
          url: "https://example.invalid/mcp",
          provenance: "custom",
        })),
      ]);
      await database.insert(mcpTools).values(
        added.map((serverId) => ({
          tenantId: "team",
          serverId,
          name: "read",
          description: "read",
          effect: "read",
        })),
      );
      await database.insert(composioConnections).values({
        tenantId: maker,
        toolkit: slug("gmail"),
        userId: maker,
        verified: true,
        connectedAt: makersConnectedAt,
      });
      await store.addInstallListing("mcp", VAULT, "admin@example.test");
    });
  });

  afterAll(async () => {
    await asPlatform(async () => {
      await database
        .delete(appAccessRequests)
        .where(
          or(
            inArray(appAccessRequests.serverId, added),
            inArray(appAccessRequests.appKey, added),
          ),
        );
      await database
        .delete(pluginInstallListings)
        .where(
          and(
            eq(pluginInstallListings.tenantId, "system"),
            eq(pluginInstallListings.ref, VAULT),
          ),
        );
      await database
        .delete(pluginGrants)
        .where(like(pluginGrants.ref, `%${suite}%`));
      await database.delete(mcpTools).where(inArray(mcpTools.serverId, added));
      await database.delete(mcpServers).where(inArray(mcpServers.id, added));
    });
  });

  describe("I1: one dedupe key, the index's", () => {
    test("asking again after the app was opened answers the request filed before it had a row", async () => {
      const response = await asPerson().request(
        "/access-requests",
        json({ agentId: personBot, app: BOX }),
      );
      expect(response.status).toBe(200);
      expect(
        (await response.json()) as {
          request: { id: string };
          created: boolean;
        },
      ).toMatchObject({ request: { id: boxRequest }, created: false });
    });

    test("the store itself hands back that request when asked under the row's id", async () => {
      const filed = await runAsTenant(person, () =>
        store.fileAppAccessRequest({
          serverId: BOX,
          botId: personBot,
          requesterUserId: person,
          kind: "enable",
          note: null,
          maxPending: 20,
        }),
      );
      expect(filed.outcome).toBe("existing");
      expect(filed.outcome === "limited" ? null : filed.request.id).toBe(
        boxRequest,
      );
    });

    test("so does request_app_access", async () => {
      const read = readAppAccessRequestAnswer(
        await toolAs(person, personBot)(BOX),
      );
      expect(read?.card).toMatchObject({
        requestId: boxRequest,
        status: "existing",
      });
    });
  });

  describe("M1: a one-press approval that throws leaves nothing waiting", () => {
    test("the request it filed is withdrawn, and the withdrawal is in the trail", async () => {
      const broken = Object.assign(Object.create(store) as typeof store, {
        listServers: async () => {
          throw new Error("the server list could not be read");
        },
      });
      const requireAdmin: MiddlewareHandler<{
        Variables: AppVariables;
      }> = async (context, next) => {
        context.set("actor", {
          id: admin,
          role: "admin",
          email: `${admin}@example.test`,
        });
        await runAsTenant(admin, () => next());
      };
      const routes = createPluginRoutes(
        broken,
        requireAdmin,
        canUseBot,
        undefined,
        { broker },
        adminScope,
      );
      const response = await routes.request(
        `/for/${personBot}/apps/${THROWS}/approve`,
        post,
      );
      expect(response.status).toBeGreaterThanOrEqual(500);
      const waiting = await runAsTenant(admin, () =>
        store.pendingAppAccessRequests({ requesterUserId: admin }),
      );
      expect(waiting.filter((request) => request.appKey === THROWS)).toEqual(
        [],
      );
      expect(
        eventsOf("app_access.cancelled").some(
          (event) =>
            event.targetId === THROWS &&
            (event.payload as { direct?: boolean }).direct === true,
        ),
      ).toBe(true);
      expect(await grantsOn(personBot)).not.toContain(`${THROWS}/read`);
    });
  });

  describe("M2: a teammate never reads the owner's connection", () => {
    test("in the teammate's own frame the owner's account is not there to read", async () => {
      const app = await access(asPerson(), teamBot, GMAIL);
      expect(app.accountHolder).toBe("you");
      expect(app.connectedAt).not.toBe(makersConnectedAt.toISOString());
      for (const listed of await appsOf(asPerson(), teamBot))
        expect(listed.connectedAt).not.toBe(makersConnectedAt.toISOString());
    });

    test("even read from a frame that can see it, the owner's account is only a holder, never its details", async () => {
      const inspected = await asPlatform(() =>
        store.inspectApp({
          app: GMAIL,
          agentId: teamBot,
          userId: person,
          composioConfigured: true,
        }),
      );
      expect(inspected?.access).toMatchObject({
        state: "ready",
        accountHolder: "owner",
        connectedAt: null,
      });
    });
  });

  describe("M4: request_app_access asks for what the state needs", () => {
    test("a listed app that is still disabled is asked to be opened, as in the browser", async () => {
      const read = readAppAccessRequestAnswer(
        await toolAs(person, personBot)(VAULT),
      );
      expect(read?.card).toMatchObject({ appKey: VAULT, kind: "enable" });
      const shown = await access(asPerson(), personBot, VAULT);
      expect(shown).toMatchObject({ state: "disabled", requestKind: "enable" });
      expect(shown.request?.id).toBe(read?.card.requestId);
    });

    test("a state the person fixes themselves files nothing and says so", async () => {
      const ask = toolAs(person, personBot);
      for (const app of [STALE, SLACK, LINEAR]) {
        const answer = await ask(app);
        expect(readAppAccessRequestAnswer(answer)).toBeNull();
        expect(answer).not.toContain("已经可以使用");
      }
      const pending = await runAsTenant(person, () =>
        store.pendingAppAccessRequests({ requesterUserId: person }),
      );
      expect(
        pending.filter((request) =>
          [STALE, SLACK, LINEAR].includes(request.appKey),
        ),
      ).toEqual([]);
    });

    test("the tool's request and the browser's are one: whichever came first is answered", async () => {
      const fromTool = readAppAccessRequestAnswer(
        await toolAs(person, personBot)(TOOL_FIRST),
      );
      expect(fromTool?.card.status).toBe("created");
      const fromBrowser = await asPerson().request(
        "/access-requests",
        json({ agentId: personBot, app: TOOL_FIRST }),
      );
      expect(fromBrowser.status).toBe(200);
      expect(
        ((await fromBrowser.json()) as { request: { id: string } }).request.id,
      ).toBe(fromTool?.card.requestId ?? "");

      const browserFirst = await asPerson().request(
        "/access-requests",
        json({ agentId: personBot, app: ROUTE_FIRST }),
      );
      expect(browserFirst.status).toBe(201);
      const { request } = (await browserFirst.json()) as {
        request: { id: string };
      };
      const toolAfter = readAppAccessRequestAnswer(
        await toolAs(person, personBot)(ROUTE_FIRST),
      );
      expect(toolAfter?.card).toMatchObject({
        requestId: request.id,
        status: "existing",
      });
      const pending = await runAsTenant(person, () =>
        store.pendingAppAccessRequests({ requesterUserId: person }),
      );
      expect(
        pending.filter((one) => [TOOL_FIRST, ROUTE_FIRST].includes(one.appKey)),
      ).toHaveLength(2);
    });
  });

  describe("M5: refusals cannot fill the trail", () => {
    test("withdrawing an id that is not a request id is 404 and writes nothing", async () => {
      const response = await routesAs({ id: noisy, role: "user" }).request(
        `/access-requests/${"x".repeat(2000)}`,
        { method: "DELETE" },
      );
      expect(response.status).toBe(404);
      expect(refusedBy(noisy)).toEqual([]);
    });

    test("the same refusal again is recorded once", async () => {
      const routes = routesAs({ id: repeat, role: "user" });
      for (let round = 0; round < 3; round += 1) {
        const response = await routes.request(
          "/access-requests",
          json({ agentId: hidden, app: CALENDAR }),
        );
        expect(response.status).toBe(404);
      }
      expect(refusedBy(repeat)).toHaveLength(1);
    });

    test("one person's refusals are capped, while every answer is still given", async () => {
      const routes = routesAs({ id: noisy, role: "user" });
      for (let round = 0; round < 60; round += 1) {
        const response = await routes.request(
          "/access-requests",
          json({ agentId: hidden, app: `noise-${round}` }),
        );
        expect(response.status).toBe(404);
      }
      expect(refusedBy(noisy).length).toBeGreaterThan(0);
      expect(refusedBy(noisy).length).toBeLessThanOrEqual(30);
    });
  });
});

// The pool closes last, after every cleanup above has run its queries (database-pool-closing).
afterAll(async () => {
  await database.$client.close();
});
