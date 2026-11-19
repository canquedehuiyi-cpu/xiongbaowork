import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, like } from "drizzle-orm";
import { DEV_ACTOR } from "../src/auth/dev-actor";
import { createDatabase } from "../src/db/client";
import {
  brokeredAccounts,
  brokeredIdentities,
  composioConnections,
} from "../src/db/schema";
import type { ComposioBroker } from "../src/plugins/broker";
import {
  ensureSingleUserIdentity,
  filedUnder,
  underOwnName,
  vendorNameFor,
} from "../src/plugins/single-user-identity";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * 上游 #927（`composio-single-user-identity` / `arcade-single-user-identity` 的要点，按 fork 的表改写）：
 * 每台单用户安装在连接应用提供商那边有自己的名字。
 *
 * 为什么要这些断言：每台单用户安装的那个人都是 `dev-local-user`，共用一把 key 时在厂商那边是同一个用户，
 * 互相列得到、用得到、断得掉对方的账号。名字只给一次、重启与并发启动都不变；仍记在共享名下的连接只删本地
 * 行（不问厂商，别的安装可能正在用）；要登录的部署一个名字也不写。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const app = (name: string) => `${name}-${suite}`;
const SOMEBODY = `signed-in-${suite}`;
const asDev = <T>(work: () => Promise<T>) => runAsTenant(DEV_ACTOR.id, work);
const platform = <T>(work: () => Promise<T>) => runAsTenant("platform", work);

const identities = () =>
  platform(() =>
    database
      .select({
        provider: brokeredIdentities.provider,
        userId: brokeredIdentities.userId,
        vendorUserId: brokeredIdentities.vendorUserId,
      })
      .from(brokeredIdentities)
      .where(eq(brokeredIdentities.userId, DEV_ACTOR.id)),
  );

const connectionsOf = (userId: string) =>
  platform(async () =>
    (
      await database
        .select({
          toolkit: composioConnections.toolkit,
          provider: composioConnections.provider,
          vendorUserId: composioConnections.vendorUserId,
        })
        .from(composioConnections)
        .where(
          and(
            eq(composioConnections.userId, userId),
            like(composioConnections.toolkit, `%-${suite}`),
          ),
        )
    ).sort((left, right) => left.toolkit.localeCompare(right.toolkit)),
  );

const clear = () =>
  platform(async () => {
    await database
      .delete(brokeredIdentities)
      .where(eq(brokeredIdentities.userId, DEV_ACTOR.id));
    await database
      .delete(composioConnections)
      .where(like(composioConnections.toolkit, `%-${suite}`));
    await database
      .delete(brokeredAccounts)
      .where(like(brokeredAccounts.app, `%-${suite}`));
  });

afterEach(clear);
afterAll(async () => {
  await database.$client.close();
});

describe("a single-user deployment's name at its broker", () => {
  test("is not given to a deployment that signs people in, or has no broker", async () => {
    expect(
      await ensureSingleUserIdentity(database, {
        singleUser: false,
        provider: "composio",
      }),
    ).toBeNull();
    expect(
      await ensureSingleUserIdentity(database, {
        singleUser: true,
        provider: null,
      }),
    ).toBeNull();
    expect(await identities()).toEqual([]);
  });

  test("is dev-local-user plus a random part, kept per provider, and the same after a restart", async () => {
    const first = await ensureSingleUserIdentity(
      database,
      { singleUser: true, provider: "composio" },
      () => "first",
    );
    expect(first).toBe("dev-local-user:first");
    // 重启：再铸的候选被主键挡下，读回的仍是第一次留下的。
    const again = await ensureSingleUserIdentity(
      database,
      { singleUser: true, provider: "composio" },
      () => "second",
    );
    expect(again).toBe("dev-local-user:first");
    // 换了提供商是另一行：Composio 的名字不会被带到 Arcade。
    const arcade = await ensureSingleUserIdentity(
      database,
      { singleUser: true, provider: "arcade" },
      () => "third",
    );
    expect(arcade).toBe("dev-local-user:third");
    expect(
      (await identities()).sort((a, b) => a.provider.localeCompare(b.provider)),
    ).toEqual([
      {
        provider: "arcade",
        userId: "dev-local-user",
        vendorUserId: "dev-local-user:third",
      },
      {
        provider: "composio",
        userId: "dev-local-user",
        vendorUserId: "dev-local-user:first",
      },
    ]);
    expect(
      await asDev(() => filedUnder(database, "composio", DEV_ACTOR.id)),
    ).toBe("dev-local-user:first");
  });

  test("is one name when two replicas start together", async () => {
    const [left, right] = await Promise.all([
      ensureSingleUserIdentity(
        database,
        { singleUser: true, provider: "composio" },
        () => "left",
      ),
      ensureSingleUserIdentity(
        database,
        { singleUser: true, provider: "composio" },
        () => "right",
      ),
    ]);
    expect(left).toBe(right);
    expect(["dev-local-user:left", "dev-local-user:right"]).toContain(
      left ?? "",
    );
    expect(await identities()).toHaveLength(1);
  });

  test("the default random part is long enough not to be guessed and differs each time", async () => {
    const name = await ensureSingleUserIdentity(database, {
      singleUser: true,
      provider: "composio",
    });
    expect(name).toMatch(/^dev-local-user:[A-Za-z0-9_-]{22}$/);
  });

  test("the name's row is the person's own: another person's frame cannot read it", async () => {
    await ensureSingleUserIdentity(
      database,
      { singleUser: true, provider: "composio" },
      () => "mine",
    );
    expect(
      await runAsTenant(SOMEBODY, () =>
        filedUnder(database, "composio", DEV_ACTOR.id),
      ),
    ).toBeNull();
  });
});

describe("connections recorded under the shared name", () => {
  const seed = (rows: (typeof composioConnections.$inferInsert)[]) =>
    platform(() => database.insert(composioConnections).values(rows));

  test("are retired here at the first start, and only the single-user person's, only this provider's", async () => {
    await seed([
      // 升级之前连接的：没有记名字，也就是记在共享名下。
      {
        tenantId: DEV_ACTOR.id,
        toolkit: app("gmail"),
        userId: DEV_ACTOR.id,
      },
      // 明写着共享名的同样退役。
      {
        tenantId: DEV_ACTOR.id,
        toolkit: app("slack"),
        userId: DEV_ACTOR.id,
        vendorUserId: DEV_ACTOR.id,
      },
      // 另一个提供商的行不归这次启动管。
      {
        tenantId: DEV_ACTOR.id,
        toolkit: app("Calendar"),
        userId: DEV_ACTOR.id,
        provider: "arcade",
      },
      // 别人的连接记在他自己的 id 下，从来不是共享名。
      { tenantId: SOMEBODY, toolkit: app("gmail"), userId: SOMEBODY },
    ]);
    await platform(() =>
      database.insert(brokeredAccounts).values([
        {
          tenantId: DEV_ACTOR.id,
          provider: "composio",
          app: app("gmail"),
          userId: DEV_ACTOR.id,
          vendorUserId: DEV_ACTOR.id,
          accountId: "ca_shared",
        },
      ]),
    );

    const name = await ensureSingleUserIdentity(
      database,
      { singleUser: true, provider: "composio" },
      () => "own",
    );

    expect(name).toBe("dev-local-user:own");
    expect(await connectionsOf(DEV_ACTOR.id)).toEqual([
      { toolkit: app("Calendar"), provider: "arcade", vendorUserId: null },
    ]);
    expect(await connectionsOf(SOMEBODY)).toEqual([
      { toolkit: app("gmail"), provider: "composio", vendorUserId: null },
    ]);
    expect(
      await platform(() =>
        database
          .select({ accountId: brokeredAccounts.accountId })
          .from(brokeredAccounts)
          .where(eq(brokeredAccounts.app, app("gmail"))),
      ),
    ).toEqual([]);
  });

  test("a connection made under the deployment's own name survives every later start", async () => {
    const name = await ensureSingleUserIdentity(
      database,
      { singleUser: true, provider: "composio" },
      () => "own",
    );
    await seed([
      {
        tenantId: DEV_ACTOR.id,
        toolkit: app("gmail"),
        userId: DEV_ACTOR.id,
        vendorUserId: name,
      },
    ]);
    await platform(() =>
      database.insert(brokeredAccounts).values([
        {
          tenantId: DEV_ACTOR.id,
          provider: "composio",
          app: app("gmail"),
          userId: DEV_ACTOR.id,
          vendorUserId: name ?? "",
          accountId: "ca_own",
          isDefault: true,
        },
      ]),
    );

    await ensureSingleUserIdentity(database, {
      singleUser: true,
      provider: "composio",
    });

    expect(await connectionsOf(DEV_ACTOR.id)).toEqual([
      {
        toolkit: app("gmail"),
        provider: "composio",
        vendorUserId: "dev-local-user:own",
      },
    ]);
    expect(
      await platform(() =>
        database
          .select({
            accountId: brokeredAccounts.accountId,
            isDefault: brokeredAccounts.isDefault,
          })
          .from(brokeredAccounts)
          .where(eq(brokeredAccounts.app, app("gmail"))),
      ),
    ).toEqual([{ accountId: "ca_own", isDefault: true }]);
  });

  test("one an older version wrote after the first start is retired at the next start", async () => {
    await ensureSingleUserIdentity(
      database,
      { singleUser: true, provider: "composio" },
      () => "own",
    );
    // 旧版本连着同一个库：它不认识这个名字，新连接仍记在共享名下。
    await seed([
      { tenantId: DEV_ACTOR.id, toolkit: app("notion"), userId: DEV_ACTOR.id },
    ]);
    await ensureSingleUserIdentity(database, {
      singleUser: true,
      provider: "composio",
    });
    expect(await connectionsOf(DEV_ACTOR.id)).toEqual([]);
  });
});

/**
 * 一个按用户 id 分开账号的厂商替身：两台「安装」共用它，就是两台单用户安装共用一把 key。
 */
function vendor() {
  const accounts = new Map<string, Set<string>>();
  const seen: string[] = [];
  const of = (userId: string) => {
    seen.push(userId);
    let held = accounts.get(userId);
    if (!held) {
      held = new Set();
      accounts.set(userId, held);
    }
    return held;
  };
  const broker: ComposioBroker = {
    listApps: async () => [],
    ensureAuthConfig: async () => "standing",
    deleteAuthConfig: async () => {},
    authorize: async ({ userId, toolkit }) => {
      of(userId).add(toolkit);
      return { redirectUrl: `https://vendor.example/consent/${toolkit}` };
    },
    isConnected: async ({ userId, toolkit }) => of(userId).has(toolkit),
    accountsOf: async ({ userId, toolkit }) =>
      of(userId).has(toolkit)
        ? [{ accountId: `ca_${userId}`, identity: null, connectedAt: null }]
        : [],
    revoke: async ({ userId, toolkit }) => of(userId).delete(toolkit),
    connectionFields: async () => [],
    connectWithFields: async ({ userId, toolkit }) => {
      of(userId).add(toolkit);
      return { accountId: `ca_${userId}` };
    },
    revokeAccount: async () => {},
  };
  return { broker, seen, accounts };
}

describe("two single-user deployments on one broker key", () => {
  test("each is its own user at the vendor: one's account is not seen, listed or ended by the other", async () => {
    const shared = vendor();
    const one = underOwnName(
      shared.broker,
      vendorNameFor("dev-local-user:one"),
    );
    const two = underOwnName(
      shared.broker,
      vendorNameFor("dev-local-user:two"),
    );
    const person = { userId: DEV_ACTOR.id, toolkit: "gmail" };

    await one.authorize({ ...person, returnUrl: "https://one.example" });

    expect(await one.isConnected(person)).toBe(true);
    expect(await two.isConnected(person)).toBe(false);
    expect(await two.accountsOf?.(person)).toEqual([]);
    // 另一台的断开找不到账号，这一台的账号还在。
    expect(await two.revoke(person)).toBe(false);
    expect(await one.isConnected(person)).toBe(true);
    expect(await one.accountsOf?.(person)).toEqual([
      { accountId: "ca_dev-local-user:one", identity: null, connectedAt: null },
    ]);
    await two.connectWithFields({
      ...person,
      authScheme: "API_KEY",
      values: { api_key: "k" },
    });
    // 厂商从头到尾没有见过共享名。
    expect(shared.seen).not.toContain(DEV_ACTOR.id);
    expect([...shared.accounts.keys()].sort()).toEqual([
      "dev-local-user:one",
      "dev-local-user:two",
    ]);
  });

  test("everybody else goes out under their own id, and so does a team account's identity", async () => {
    const shared = vendor();
    const broker = underOwnName(
      shared.broker,
      vendorNameFor("dev-local-user:one"),
    );
    await broker.isConnected({ userId: SOMEBODY, toolkit: "gmail" });
    await broker.revoke({ userId: "deployment:abc:gmail", toolkit: "gmail" });
    expect(shared.seen).toEqual([SOMEBODY, "deployment:abc:gmail"]);
  });

  test("a deployment that signs people in changes nobody's name, the single-user id included", async () => {
    const shared = vendor();
    const broker = underOwnName(shared.broker, vendorNameFor(null));
    await broker.isConnected({ userId: DEV_ACTOR.id, toolkit: "gmail" });
    expect(shared.seen).toEqual([DEV_ACTOR.id]);
  });

  test("a broker that cannot list accounts one by one still cannot after the wrap", () => {
    const { accountsOf: _dropped, ...plain } = vendor().broker;
    expect(
      "accountsOf" in underOwnName(plain, vendorNameFor("dev-local-user:one")),
    ).toBe(false);
  });
});
