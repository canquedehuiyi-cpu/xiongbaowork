import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { createApp } from "../src/app";
import { createAuditReader, createAuditStore } from "../src/audit";
import { createAdminScope } from "../src/auth/admin-scope";
import { createRequireUser, createRoleRepository } from "../src/auth/guards";
import { setRole } from "../src/auth/roles";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import {
  auditEvents,
  revokedAccess,
  subscriptions,
  userRoles,
  users,
} from "../src/db/schema";
import { createPeopleStore } from "../src/people/store";
import { createPlatformRoutes } from "../src/platform/routes";
import { createQuotaService } from "../src/quota/limits";
import { createQuotaRoutes } from "../src/quota/routes";
import { asPlatform, runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";
import { bindTestRoleWriter } from "./support/role-writer";

/**
 * 角色、平台和套餐这三处写路径，照 `src/index.ts` 的装法（`createApp` 之后再挂 `/api/platform` 和
 * `/api/quota`，守卫和角色仓库都是真的），由一个会话里还写着 admin、`user_roles` 里已经不是的人来调用。
 *
 * - 改角色：走专用的角色写入器，没有行安全。降权的会话能把自己写回管理员，一次请求就变成真管理员。
 * - 停用、恢复租户：store 以 `platform` 写 `revoked_access`、`sessions`、`routines`。降权的会话能把所有
 *   管理员锁在外面，也能把对自己的停用撤掉。
 * - 换套餐：`subscriptions` 的行安全允许本人租户的行，降权的会话能给自己免费换成高档套餐。
 *
 * 每一条看三种人：降权的会话答 403「你的管理员身份没能确认，没有改变任何东西。」、库里什么都没变；持有
 * 能力的管理员照常成功；成员照旧得到路由原来的答复。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const id = (name: string) => `dpw-${suite}-${name}`;
const ADMIN = id("admin");
/** 会话里还是管理员、`user_roles` 里已被收回管理员角色的人。 */
const DEMOTED = id("demoted");
const MEMBER = id("member");
/** 被停用的那一位。 */
const VICTIM = id("victim");
const people = [ADMIN, DEMOTED, MEMBER, VICTIM];
const emailOf = (person: string) => `${person}@dpw.test`;
const STALE = "你的管理员身份没能确认，没有改变任何东西。";
let releaseRoleWriter: (() => Promise<void>) | undefined;

const roleRepository = createRoleRepository(database);
/** 会话自己带着角色，和组织身份源给出的会话一样：DEMOTED 的会话说 admin。 */
const auth = {
  handler: () => new Response(null, { status: 204 }),
  api: {
    getSession: async ({ headers }: { headers: Headers }) => {
      const actor = headers.get("x-actor");
      if (!actor) return null;
      return {
        user: {
          id: actor,
          email: emailOf(actor),
          role: actor === MEMBER ? "user" : "admin",
        },
      };
    },
  },
} as never;

const auditStore = createAuditStore(database);
const app = createApp(
  loadConfig(testEnvironment()),
  auth,
  roleRepository,
  // 第 4 到 17 个位置这里都不给；第 18 个是成员 store。
  ...(Array.from({ length: 14 }) as never[]),
  createPeopleStore(database, []) as never,
);
// `src/index.ts` 在 `createApp` 之后把这两组挂到同一个 app 上，守卫也是同一种。
const requireUser = createRequireUser(auth, roleRepository);
app.route(
  "/api/platform",
  createPlatformRoutes(database, requireUser, auditStore, {
    adminScope: createAdminScope({ roleRepository }),
    auditReader: createAuditReader(database),
  }),
);
app.route(
  "/api/quota",
  createQuotaRoutes(database, createQuotaService(database), requireUser),
);

const request = (actor: string, path: string, body: unknown = {}) =>
  app.request(`http://openbot.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-actor": actor },
    body: JSON.stringify(body),
  });

const answer = async (response: Response) => ({
  status: response.status,
  body: await response.json(),
});

const rolesOf = (person: string) =>
  asPlatform(async () =>
    (
      await database
        .select({ role: userRoles.role })
        .from(userRoles)
        .where(eq(userRoles.userId, person))
    ).map((row) => row.role),
  );

const suspended = () =>
  asPlatform(async () =>
    (
      await database
        .select({ email: revokedAccess.email })
        .from(revokedAccess)
        .where(inArray(revokedAccess.email, people.map(emailOf)))
    )
      .map((row) => row.email)
      .sort(),
  );

const planOf = (person: string) =>
  runAsTenant(person, async () =>
    (
      await database
        .select({ planId: subscriptions.planId })
        .from(subscriptions)
        .where(eq(subscriptions.tenantId, person))
    ).map((row) => row.planId),
  );

/** 这个套件的人留在轨迹里的每一行事件类型，按 platform 读。 */
const trail = () =>
  asPlatform(async () =>
    Array.from(
      (await database.execute(
        sql`select event_type from audit_events where actor_user_id like ${`dpw-${suite}-%`} or target_id like ${`dpw-${suite}-%`} order by created_at, event_type`,
      )) as unknown as ArrayLike<{ event_type: string }>,
    ).map((row) => row.event_type),
  );

beforeAll(async () => {
  releaseRoleWriter = await bindTestRoleWriter(database);
  for (const person of people) {
    await runAsTenant(person, async () => {
      await database
        .insert(users)
        .values({ id: person, email: emailOf(person), name: person });
      await database
        .insert(subscriptions)
        .values({ tenantId: person, planId: "free" });
    });
  }
  await asPlatform(async () => {
    await setRole(database, ADMIN, "admin");
    for (const person of [DEMOTED, MEMBER, VICTIM])
      await setRole(database, person, "user");
  });
});

afterAll(async () => {
  await asPlatform(async () => {
    await database
      .delete(revokedAccess)
      .where(inArray(revokedAccess.email, people.map(emailOf)));
  });
  for (const person of people)
    await runAsTenant(person, () =>
      database.delete(subscriptions).where(eq(subscriptions.tenantId, person)),
    );
  await asPlatform(() =>
    database.execute(sql`delete from users where id like ${`dpw-${suite}-%`}`),
  );
  await releaseRoleWriter?.();
  await database.$client.close();
});

describe("a role change", () => {
  test("a demoted session cannot write itself back as an administrator", async () => {
    const before = await trail();

    expect(
      await answer(
        await request(DEMOTED, `/api/admin/people/${DEMOTED}/role`, {
          role: "admin",
        }),
      ),
    ).toEqual({ status: 403, body: { error: STALE } });
    expect(await rolesOf(DEMOTED)).toEqual(["user"]);
    expect(await trail()).toEqual(before);
  });

  test("a member still gets the route's own answer", async () => {
    expect(
      await answer(
        await request(MEMBER, `/api/admin/people/${MEMBER}/role`, {
          role: "admin",
        }),
      ),
    ).toEqual({ status: 403, body: { error: "Only an admin can do this." } });
    expect(await rolesOf(MEMBER)).toEqual(["user"]);
  });

  test("an administrator holding the capability still promotes and demotes", async () => {
    const promoted = await request(ADMIN, `/api/admin/people/${MEMBER}/role`, {
      role: "admin",
    });
    expect(promoted.status).toBe(200);
    expect(await rolesOf(MEMBER)).toEqual(["admin"]);

    const demoted = await request(ADMIN, `/api/admin/people/${MEMBER}/role`, {
      role: "user",
    });
    expect(demoted.status).toBe(200);
    expect(await rolesOf(MEMBER)).toEqual(["user"]);
  });
});

describe("suspending and restoring a tenant", () => {
  test("a demoted session cannot suspend anybody", async () => {
    const before = await trail();

    expect(
      await answer(
        await request(DEMOTED, `/api/platform/tenants/${VICTIM}/suspend`),
      ),
    ).toEqual({ status: 403, body: { error: STALE } });
    expect(await suspended()).toEqual([]);
    expect(await trail()).toEqual(before);
  });

  test("a demoted session cannot lift a suspension, its own included", async () => {
    const suspendedByAdmin = await request(
      ADMIN,
      `/api/platform/tenants/${DEMOTED}/suspend`,
    );
    expect(suspendedByAdmin.status).toBe(200);
    const before = await trail();

    try {
      expect(
        await answer(
          await request(DEMOTED, `/api/platform/tenants/${DEMOTED}/restore`),
        ),
      ).toEqual({ status: 403, body: { error: STALE } });
      expect(await suspended()).toContain(emailOf(DEMOTED));
      expect(await trail()).toEqual(before);
    } finally {
      const restored = await request(
        ADMIN,
        `/api/platform/tenants/${DEMOTED}/restore`,
      );
      expect(restored.status).toBe(200);
    }
    expect(await suspended()).not.toContain(emailOf(DEMOTED));
  });

  test("a member still gets the route's own answer", async () => {
    const before = await suspended();
    for (const lever of ["suspend", "restore"]) {
      expect(
        await answer(
          await request(MEMBER, `/api/platform/tenants/${VICTIM}/${lever}`),
        ),
      ).toEqual({ status: 403, body: { error: "Operator access required." } });
    }
    expect(await suspended()).toEqual(before);
  });

  test("an administrator holding the capability still suspends and restores", async () => {
    const suspendedNow = await request(
      ADMIN,
      `/api/platform/tenants/${VICTIM}/suspend`,
    );
    expect(await answer(suspendedNow)).toEqual({
      status: 200,
      body: { ok: true },
    });
    expect(await suspended()).toContain(emailOf(VICTIM));

    const restored = await request(
      ADMIN,
      `/api/platform/tenants/${VICTIM}/restore`,
    );
    expect(await answer(restored)).toEqual({
      status: 200,
      body: { ok: true },
    });
    expect(await suspended()).not.toContain(emailOf(VICTIM));
  });
});

describe("switching plans", () => {
  test("a demoted session cannot move its own workspace onto another plan", async () => {
    const before = await trail();

    expect(
      await answer(
        await request(DEMOTED, "/api/quota/plan", { planId: "pro" }),
      ),
    ).toEqual({ status: 403, body: { error: STALE } });
    expect(await planOf(DEMOTED)).toEqual(["free"]);
    expect(await trail()).toEqual(before);
  });

  test("a member still gets the route's own answer", async () => {
    expect(
      await answer(await request(MEMBER, "/api/quota/plan", { planId: "pro" })),
    ).toEqual({ status: 403, body: { error: "Only an admin can do this." } });
    expect(await planOf(MEMBER)).toEqual(["free"]);
  });

  test("an administrator holding the capability still switches", async () => {
    const moved = await request(ADMIN, "/api/quota/plan", { planId: "pro" });

    expect(await answer(moved)).toEqual({
      status: 200,
      body: { planId: "pro", changed: true },
    });
    expect(await planOf(ADMIN)).toEqual(["pro"]);
    const events = await asPlatform(() =>
      database
        .select({ eventType: auditEvents.eventType })
        .from(auditEvents)
        .where(eq(auditEvents.targetId, ADMIN)),
    );
    expect(events.map((event) => event.eventType)).toContain("plan.changed");
  });
});
