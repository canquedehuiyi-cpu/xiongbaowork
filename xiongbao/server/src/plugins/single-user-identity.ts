import { randomBytes } from "node:crypto";
import { and, eq, isNull, or } from "drizzle-orm";
import { DEV_ACTOR } from "../auth/dev-actor";
import type { Database } from "../db/client";
import {
  brokeredAccounts,
  brokeredIdentities,
  composioConnections,
} from "../db/schema";
import { runAsTenant } from "../tenant/context";
import type { BrokerProvider } from "./access";
import type { ComposioBroker } from "./broker";

/**
 * 给单用户安装在它的连接应用提供商（Composio 或 Arcade）那边一个自己的名字，只给一次，并让它不再用共享的
 * 那个名字行事（上游 #927 的 `ensureSingleUserIdentity`，按 fork 的表改写）。
 *
 * 为什么需要：两个提供商都把授权记在调用方自选的用户 id 下，这个部署选的是本人的 id。单用户安装的那一个人
 * 在每台安装上都是 `dev-local-user`，所以共用一把 key 的每台安装在厂商那边是同一个用户。Composio 上，一台
 * 安装的 Gmail 被另一台列出、使用，一台断开就结束了两台的账号，不指明账号的调用跑在最后连接的那个邮箱里。
 * Arcade 上，一台安装对 Google 的同意就是其他每台安装的调用所用的授权，一台断开就把它从所有安装撤掉。
 *
 * 给什么：`dev-local-user:<随机>`，第一次带着那个提供商启动时写进 `brokered_identities`，之后永不替换，
 * 所以每个副本、每次重启都是同一个。只换厂商那边的名字：主体仍是 `dev-local-user`，会话、记忆和每一行
 * 本地数据都还在同一个人名下。
 *
 * 已经持有连接的安装也给。以前的想法是「名下还有连接就保留共享名」，那正好让互相共享的安装永远共享下去，
 * 而且它信任的本地记录可能根本不是它自己的账号：在这一步之前，打开一个应用的页面（页面加载时的确认）就会
 * 把同一把 key 上别的安装连接的账号记成自己的。厂商那边没有任何东西能说明共享名下的账号是哪台安装建的。
 *
 * 所以共享名下的连接在这里退役，既不搬走也不在厂商那边结束。两个提供商都不能把连接换到另一个用户 id 下；
 * 在厂商那边结束它，会让同一把 key 上仍在用它的每台安装一起断开，而那台可能才是真正的主人。因此只删这台
 * 安装自己的行（本人、这个提供商、记在共享名下的），与写名字在同一个事务里，对厂商什么也不问。之后这些
 * 应用在各处读作未连接，员工的调用得到带「连接」的卡片，按一次「连接」就把账号记到新名字下。留在厂商
 * 共享名下的账号由运维在厂商后台处理，那里才看得出是谁的。
 *
 * 每次启动都做，不只第一次：这一版写的行都不在共享名下，所以第一次之后删不到东西；但旧版本连同一个库时
 * 会把新连接记在共享名下，下一次启动得像第一次那样把它们退役。
 *
 * 两个副本同时启动结果一致：各铸各的候选，主键只收一个，两边读回被留下的那一个。
 *
 * 行在那个人自己的租户里，所以整件事在 `dev-local-user` 的帧里做。
 *
 * @returns 单用户那个人的账号今后在厂商那边记在哪个名字下；没有这样的人或没有 broker 时为 `null`
 */
export async function ensureSingleUserIdentity(
  database: Pick<Database, "transaction">,
  input: { singleUser: boolean; provider: BrokerProvider | null },
  random: () => string = () => randomBytes(16).toString("base64url"),
): Promise<string | null> {
  const { provider } = input;
  if (!input.singleUser || !provider) return null;

  const { kept, retired } = await runAsTenant(DEV_ACTOR.id, () =>
    database.transaction(async (transaction) => {
      await transaction
        .insert(brokeredIdentities)
        .values({
          provider,
          userId: DEV_ACTOR.id,
          vendorUserId: `${DEV_ACTOR.id}:${random()}`,
        })
        .onConflictDoNothing();
      const retired = await transaction
        .delete(composioConnections)
        .where(
          and(
            eq(composioConnections.provider, provider),
            eq(composioConnections.userId, DEV_ACTOR.id),
            or(
              isNull(composioConnections.vendorUserId),
              eq(composioConnections.vendorUserId, DEV_ACTOR.id),
            ),
          ),
        )
        .returning({ app: composioConnections.toolkit });
      // 逐个账号的缓存同样只是这台安装的本地行：共享名下的那些一并删掉，新名字下的由下一次同步重建。
      await transaction
        .delete(brokeredAccounts)
        .where(
          and(
            eq(brokeredAccounts.provider, provider),
            eq(brokeredAccounts.userId, DEV_ACTOR.id),
            eq(brokeredAccounts.vendorUserId, DEV_ACTOR.id),
          ),
        );
      return {
        kept: await filedUnder(transaction, provider, DEV_ACTOR.id),
        retired: retired.map((row) => row.app),
      };
    }),
  );
  if (!kept) {
    throw new Error(
      "这台安装在连接应用提供商那边的名字写入后读不回来，所以服务停下了：不能把账号记在一个之后找不回的名字下。",
    );
  }
  if (retired.length > 0) {
    console.warn(
      JSON.stringify({
        type: "single-user-connections-retired",
        provider,
        apps: retired.sort(),
        note: "These apps were connected under dev-local-user, the name every single-user deployment shared at this broker, and this deployment now has its own. Their records here were removed and nothing was ended at the broker, because other deployments on the same key may be using those accounts. Each app reads as not connected until it is connected again.",
      }),
    );
  }
  return kept;
}

/**
 * `brokered_identities` 为一个人在一个提供商那边记的名字；没有行时为 `null`。
 *
 * 这张表唯一的读法：启动时读回刚写的名字用它，所以「启动定下的名字」和「调用发出去用的名字」不会是对同一张
 * 表的两种读法。
 */
export async function filedUnder(
  database: Pick<Database, "select">,
  provider: BrokerProvider,
  userId: string,
): Promise<string | null> {
  const [row] = await database
    .select({ vendorUserId: brokeredIdentities.vendorUserId })
    .from(brokeredIdentities)
    .where(
      and(
        eq(brokeredIdentities.provider, provider),
        eq(brokeredIdentities.userId, userId),
      ),
    )
    .limit(1);
  return row?.vendorUserId ?? null;
}

/** 一个人的账号在厂商那边记在哪个名字下。对除单用户安装那个人之外的每个人，就是他自己的用户 id。 */
export type VendorNameOf = (userId: string) => string;

/**
 * 启动时定下的名字，变成一个到处可用的换名函数。
 *
 * 只换 `dev-local-user` 一个人：`ensureSingleUserIdentity` 是那张表唯一的写入方，只写这一个人，所以对
 * 登录进来的任何人、对团队账号的身份，答案永远是原样。名字写下后永不替换，因此启动时读一次、放在内存里，
 * 与每次去读表是同一个答案。
 */
export function vendorNameFor(kept: string | null): VendorNameOf {
  if (kept === null) return (userId) => userId;
  return (userId) => (userId === DEV_ACTOR.id ? kept : userId);
}

/**
 * fork 的 broker 接口里每一个带 `userId` 的方法（`userId` 就是发给厂商的用户 id）。类型上算出来，所以以后
 * 新加一个带 `userId` 的方法而没有在 {@link underOwnName} 里换名，`tsc` 会在下面那张表上报错，而不是让那个
 * 方法悄悄用共享名发出去。
 */
type TakesUserId = {
  [K in keyof ComposioBroker]-?: NonNullable<ComposioBroker[K]> extends (
    request: infer Request,
  ) => unknown
    ? Request extends { userId: string }
      ? K
      : never
    : never;
}[keyof ComposioBroker];

const _RENAMED = {
  authorize: true,
  isConnected: true,
  accountsOf: true,
  revoke: true,
  connectWithFields: true,
} as const satisfies Record<TakesUserId, true>;

/**
 * 让一个 broker 的每一次厂商调用都以这台安装自己的名字发出。
 *
 * 在 broker 这一层换，而不是在每个调用点换：连接、确认、重查、断开、逐个列账号、离职处理都经过这同一个
 * 对象，漏一个调用点就是一次以共享名发出的调用。传进来的 `userId` 仍是本地的主体 id，所以本地的行、审计和
 * 权限判断都不变。换名是幂等的（新名字不会再被换），包两层也无妨。
 */
export function underOwnName<Broker extends ComposioBroker>(
  broker: Broker,
  nameOf: VendorNameOf,
): Broker {
  const renamed = <Request extends { userId: string }>(
    request: Request,
  ): Request => ({ ...request, userId: nameOf(request.userId) });
  const accountsOf = broker.accountsOf?.bind(broker);
  return {
    ...broker,
    authorize: (request) => broker.authorize(renamed(request)),
    isConnected: (request) => broker.isConnected(renamed(request)),
    ...(accountsOf
      ? {
          accountsOf: (request: Parameters<typeof accountsOf>[0]) =>
            accountsOf(renamed(request)),
        }
      : {}),
    revoke: (request) => broker.revoke(renamed(request)),
    connectWithFields: (request) => broker.connectWithFields(renamed(request)),
  };
}
