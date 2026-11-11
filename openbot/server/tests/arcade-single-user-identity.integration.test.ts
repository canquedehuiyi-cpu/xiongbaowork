import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray, like } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { createAuditStore } from "../src/audit";
import { DEV_ACTOR } from "../src/auth/dev-actor";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import {
  composioConnections,
  mcpServers,
  pendingAuthorizations,
} from "../src/db/schema";
import { asComposioBroker } from "../src/plugins/arcade-adapter";
import { createPluginRoutes } from "../src/plugins/routes";
import {
  underOwnName,
  vendorNameFor,
} from "../src/plugins/single-user-identity";
import { createPluginStore } from "../src/plugins/store";
import { runAsTenant } from "../src/tenant/context";
import { arcadeDouble, consented, reasonOf } from "./support/arcade-double";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { seedPeople } from "./support/people";

/**
 * 上游 #927 的 Arcade 一半（`arcade-single-user-identity.integration.test.ts` 的要点，按 fork 路由重写）：
 * 单用户安装的那个人在 Arcade 那边用这台安装自己的名字。
 *
 * 为什么钉这些：Arcade 按发来的 `user_id` 存授权。授权尝试、回程验证、兄弟应用对账里任何一处仍用
 * `dev-local-user`，共用一把 key 的别的安装的同意就会被这台安装确认、记下或撤掉。升级前开始、升级后才
 * 回来的同意记在共享名下：既不能确认（完成的是共享名下的授权），也不能撤销（别的安装可能在用），只能拒绝。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8).replaceAll("-", "");
const GMAIL = `Gmail${suite}`;
const CALENDAR = `GoogleCalendar${suite}`;
const app = (toolkit: string) => `arcade-${toolkit}`;
const OWN = `dev-local-user:${suite}`;
const DEV = DEV_ACTOR.id;
const platform = <T>(work: () => Promise<T>) => runAsTenant("platform", work);

const { arcade, state } = arcadeDouble({ suite });
const names = vendorNameFor(OWN);
const broker = underOwnName(asComposioBroker(arcade), names);
const store = createPluginStore({
  brokerProvider: "arcade",
  database,
  auditStore: createAuditStore(database),
  credentials: {} as never,
  encryptionKey: "x".repeat(44),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  broker,
  personVendorId: names,
});

/** 单用户模式的守卫：每个请求都是 `dev-local-user`，在他自己的帧里跑。 */
const session: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", { ...DEV_ACTOR } as never);
  await runAsTenant(DEV, () => next());
};

const routes = new Hono().route(
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
    { broker, provider: "arcade", arcade },
  ),
);

const request = (path: string, init: RequestInit = {}) =>
  routes.request(`/api/plugins${path}`, init);

const attempt = () =>
  platform(async () => {
    const [row] = await database
      .select()
      .from(pendingAuthorizations)
      .where(eq(pendingAuthorizations.actorId, DEV));
    return row;
  });

const connections = () =>
  platform(async () =>
    (
      await database
        .select({
          toolkit: composioConnections.toolkit,
          provider: composioConnections.provider,
          vendorUserId: composioConnections.vendorUserId,
        })
        .from(composioConnections)
        .where(like(composioConnections.toolkit, `%${suite}`))
    ).sort((left, right) => left.toolkit.localeCompare(right.toolkit)),
  );

beforeAll(async () => {
  await platform(async () => {
    await seedPeople(database, [DEV]);
    await database.insert(mcpServers).values(
      [GMAIL, CALENDAR].map((toolkit) => ({
        id: app(toolkit),
        tenantId: "team",
        title: toolkit,
        vendor: "Arcade",
        url: `arcade://${toolkit}`,
        provenance: "arcade",
        authScheme: "OAUTH2",
      })),
    );
  });
});

afterAll(async () => {
  await platform(async () => {
    await database
      .delete(pendingAuthorizations)
      .where(eq(pendingAuthorizations.actorId, DEV));
    await database
      .delete(composioConnections)
      .where(like(composioConnections.toolkit, `%${suite}`));
    await database
      .delete(mcpServers)
      .where(inArray(mcpServers.id, [GMAIL, CALENDAR].map(app)));
  });
  await database.$client.close();
});

describe("a single-user deployment's person at Arcade", () => {
  test("Connect mints the consent under the deployment's own name and binds the attempt to it", async () => {
    const response = await request(`/servers/${app(GMAIL)}/connect`, {
      method: "POST",
    });
    expect(response.status).toBe(200);
    expect(state.minted).toEqual([
      { userId: OWN, toolkit: GMAIL, action: null },
    ]);
    const row = await attempt();
    expect(row?.userId).toBe(DEV);
    expect(row?.vendorUserId).toBe(OWN);
  });

  test("the return is confirmed under that name and the connection is filed under it", async () => {
    const authId = (await attempt())?.authId ?? "";
    consented(state, "flow-own", OWN, authId);
    state.connected.add(`${OWN}/google`);

    const response = await request("/arcade/verify?flow_id=flow-own");

    expect(response.status).toBe(303);
    expect(reasonOf(response)).toBeNull();
    expect(state.confirms).toEqual([{ handle: "flow-own", vendorUserId: OWN }]);
    expect(await connections()).toEqual([
      { toolkit: GMAIL, provider: "arcade", vendorUserId: OWN },
    ]);
  });

  test("a consent made under dev-local-user by another install on the key is not this install's", async () => {
    // 同一把 key 上的另一台安装（还没升级）在共享名下同意了日历。
    state.connected.add(`${DEV}/google`);
    state.connectionReads.length = 0;
    const confirmed = await request(
      `/servers/${app(CALENDAR)}/connection/confirm`,
      { method: "POST" },
    );
    expect(await confirmed.json()).toEqual({ connected: false });
    expect(await connections()).toEqual([
      { toolkit: GMAIL, provider: "arcade", vendorUserId: OWN },
    ]);
    expect(
      state.connectionReads.map((read) => read.vendorUserId),
    ).not.toContain(DEV);
  });

  test("disconnecting reconciles sibling apps under the own name and leaves the shared name alone", async () => {
    state.revoked.length = 0;
    state.connectionReads.length = 0;
    const response = await request(`/servers/${app(GMAIL)}/connection`, {
      method: "DELETE",
    });
    expect(response.status).toBe(200);
    expect(state.revoked).toEqual([`${OWN}/google`]);
    expect(state.connected.has(`${DEV}/google`)).toBe(true);
    expect(
      state.connectionReads.map((read) => read.vendorUserId),
    ).not.toContain(DEV);
    expect(await connections()).toEqual([]);
  });
});

describe("a consent begun before the deployment had its own Arcade name", () => {
  test("is refused when it comes back, and nothing under dev-local-user is confirmed or withdrawn", async () => {
    // 升级之前按下的「连接」：尝试记在共享名下，厂商那边的 flow 也是共享名的。
    await platform(async () => {
      // 一个人只有一行尝试：先让出上一条用例里已经完成的那一次。
      await database
        .delete(pendingAuthorizations)
        .where(eq(pendingAuthorizations.actorId, DEV));
      await database.insert(pendingAuthorizations).values({
        tenantId: DEV,
        actorId: DEV,
        serverId: app(GMAIL),
        action: null,
        holder: "person",
        userId: DEV,
        vendorUserId: DEV,
        authId: `ar_${suite}_before`,
      });
    });
    consented(state, "flow-before", DEV, `ar_${suite}_before`);
    state.confirms.length = 0;
    state.revoked.length = 0;

    const response = await request("/arcade/verify?flow_id=flow-before");

    expect(response.status).toBe(303);
    expect(reasonOf(response)).toBe("name-changed");
    // 在问厂商任何事之前就拒绝：不确认、不撤销。
    expect(state.confirms).toEqual([]);
    expect(state.revoked).toEqual([]);
    expect(await connections()).toEqual([]);
    // 尝试清掉了，马上可以在新名字下重新连接。
    expect(await attempt()).toBeUndefined();
    const again = await request(`/servers/${app(GMAIL)}/connect`, {
      method: "POST",
    });
    expect(again.status).toBe(200);
    expect(state.minted.at(-1)).toEqual({
      userId: OWN,
      toolkit: GMAIL,
      action: null,
    });
  });
});
