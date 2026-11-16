/*
 * 微信 ClawBot 通道的账号、提示存取（迁移 0223、0224）。
 *
 * 帧：本人的事（绑定、解绑、提示）在调用方的帧里做，调用方应在这个人自己的帧里；行级安全保证别人的帧
 * 里读不到、改不到。跨人的问题由这里自己开 platform 帧，调用方在谁的帧里都一样：
 *  - `accountByIlinkUser`：第二个人扫同一个微信时，要看得见第一个人的行才能拒绝；
 *  - `claimForPolling` / `renewLease`：轮询器从定时器起跑，不属于任何人，要认领所有人的账号。
 *
 * 租约按数据库时钟（`now()`）算，理由同 `work/queue.ts`：副本的时钟和数据库的时钟不是一个钟。
 */
import { randomUUID } from "node:crypto";
import { and, eq, ne, sql } from "drizzle-orm";
import type { Database } from "../../db/client";
import {
  type WechatAccount,
  type WechatPrompt,
  type WechatPromptKind,
  wechatAccounts,
  wechatPrompts,
} from "../../db/schema/wechat";
import { runAsTenant } from "../../tenant/context";

export type WechatAccountInput = {
  userId: string;
  ilinkBotId: string;
  ilinkUserId: string;
  baseUrl: string;
  credentialId: string | null;
};

export type WechatStore = ReturnType<typeof createWechatStore>;

const leaseFromNow = (ms: number) =>
  sql`now() + make_interval(secs => ${ms / 1000})`;

const rowsOf = <T>(result: unknown): T[] =>
  (Array.isArray(result)
    ? result
    : ((result as { rows?: unknown[] })?.rows ?? [])) as T[];

export function createWechatStore(database: Database) {
  return {
    /** 这个人的账号（含已解绑的行），没有为 null。 */
    async account(userId: string): Promise<WechatAccount | null> {
      const [row] = await database
        .select()
        .from(wechatAccounts)
        .where(eq(wechatAccounts.userId, userId));
      return row ?? null;
    },

    /**
     * 这个微信用户当前绑在谁身上（不算已解绑的行）。
     *
     * 在 platform 帧里查：第二个人绑定时在自己的帧里看不见第一个人的行，`ilink_user_id` 的部分唯一索引
     * 会在插入时拒绝，但拒绝前先问这里，才能给出「这个微信已经绑了别人」而不是一个唯一冲突。
     */
    async accountByIlinkUser(
      ilinkUserId: string,
    ): Promise<WechatAccount | null> {
      const [row] = await runAsTenant("platform", () =>
        database
          .select()
          .from(wechatAccounts)
          .where(
            and(
              eq(wechatAccounts.ilinkUserId, ilinkUserId),
              ne(wechatAccounts.status, "unbound"),
            ),
          ),
      );
      return row ?? null;
    },

    /**
     * 绑定或重新绑定：一人一行，重新绑定改写原行，旧游标、上下文、暂停、租约和漏发计数一并清掉。
     * 同一个 iLink 用户已绑在别人身上时，部分唯一索引让这里抛错。
     */
    async saveAccount(input: WechatAccountInput): Promise<WechatAccount> {
      const fresh = {
        ilinkBotId: input.ilinkBotId,
        ilinkUserId: input.ilinkUserId,
        baseUrl: input.baseUrl,
        credentialId: input.credentialId,
        cursor: null,
        contextToken: null,
        lastInboundAt: null,
        status: "bound" as const,
        pausedUntil: null,
        leaseOwner: null,
        leaseUntil: null,
        missedCount: 0,
      };
      const [row] = await database
        .insert(wechatAccounts)
        .values({ id: randomUUID(), userId: input.userId, ...fresh })
        .onConflictDoUpdate({
          target: wechatAccounts.userId,
          set: { ...fresh, updatedAt: sql`now()` },
        })
        .returning();
      if (!row) throw new Error("wechat account was not saved");
      return row;
    },

    /** 收到一条入站：记时间；带了 `context_token` 就换成新的。 */
    async markInbound(
      accountId: string,
      input: { at: Date; contextToken?: string | null },
    ): Promise<void> {
      await database
        .update(wechatAccounts)
        .set({
          lastInboundAt: input.at,
          ...(input.contextToken ? { contextToken: input.contextToken } : {}),
          updatedAt: sql`now()`,
        })
        .where(eq(wechatAccounts.id, accountId));
    },

    /** 保存 `get_updates_buf`；空串不保存，保留上一次的游标。 */
    async setCursor(accountId: string, cursor: string): Promise<void> {
      if (!cursor) return;
      await database
        .update(wechatAccounts)
        .set({ cursor, updatedAt: sql`now()` })
        .where(eq(wechatAccounts.id, accountId));
    },

    /** 暂停到 `until`（iLink 返回 -14 时一小时）；到期后下一次认领恢复为 `bound`。 */
    async pause(accountId: string, until: Date): Promise<void> {
      await database
        .update(wechatAccounts)
        .set({ status: "paused", pausedUntil: until, updatedAt: sql`now()` })
        .where(
          and(
            eq(wechatAccounts.id, accountId),
            ne(wechatAccounts.status, "unbound"),
          ),
        );
    },

    /**
     * 解绑：保留行、标成 `unbound`，清掉游标、上下文和租约，这个微信从此可以再绑给别人。
     * 返回改后的行（`credentialId` 供调用方吊销凭据），没有账号为 null。
     */
    async unbind(userId: string): Promise<WechatAccount | null> {
      const [row] = await database
        .update(wechatAccounts)
        .set({
          status: "unbound",
          pausedUntil: null,
          cursor: null,
          contextToken: null,
          leaseOwner: null,
          leaseUntil: null,
          updatedAt: sql`now()`,
        })
        .where(eq(wechatAccounts.userId, userId))
        .returning();
      return row ?? null;
    },

    /**
     * 认领要长轮询的账号：`bound` 的，和暂停已到期的 `paused`（认领时恢复为 `bound`），租约为空或已过期。
     *
     * platform 帧，一个事务里 `for update skip locked`：两个副本同时认领时，第二个跳过第一个锁住的行，
     * 同一个账号只会被一个拿到。返回的行带 `tenantId`，处理消息时用 `runAsTenant(account.tenantId, …)`。
     */
    async claimForPolling(
      owner: string,
      leaseMs: number,
      limit: number,
    ): Promise<WechatAccount[]> {
      return runAsTenant("platform", () =>
        database.transaction(async (transaction) => {
          const due = rowsOf<{ id: string }>(
            await transaction.execute(sql`
              select "id"
              from "wechat_accounts"
              where ("status" = 'bound'
                  or ("status" = 'paused' and "paused_until" <= now()))
                and ("lease_until" is null or "lease_until" <= now())
              order by "lease_until" asc nulls first, "id" asc
              limit ${limit}
              for update skip locked
            `),
          );
          const claimed: WechatAccount[] = [];
          for (const { id } of due) {
            const [row] = await transaction
              .update(wechatAccounts)
              .set({
                status: "bound",
                pausedUntil: null,
                leaseOwner: owner,
                leaseUntil: leaseFromNow(leaseMs),
                updatedAt: sql`now()`,
              })
              .where(eq(wechatAccounts.id, id))
              .returning();
            if (row) claimed.push(row);
          }
          return claimed;
        }),
      );
    },

    /**
     * 续租，只在租约仍是自己的、且没过期时成功：过期后可能已被别人认领，不能从别人手里续回来。
     */
    async renewLease(
      accountId: string,
      owner: string,
      leaseMs: number,
    ): Promise<boolean> {
      const [row] = await runAsTenant("platform", () =>
        database
          .update(wechatAccounts)
          .set({ leaseUntil: leaseFromNow(leaseMs), updatedAt: sql`now()` })
          .where(
            and(
              eq(wechatAccounts.id, accountId),
              eq(wechatAccounts.leaseOwner, owner),
              sql`${wechatAccounts.leaseUntil} > now()`,
              ne(wechatAccounts.status, "unbound"),
            ),
          )
          .returning({ id: wechatAccounts.id }),
      );
      return Boolean(row);
    },

    /**
     * 开一条提示，给它这个人下一个编号：`A1`、`A2`……每人自增、不复用、按天不重置。
     *
     * 同一个人的编号分配用事务级咨询锁串行，取已有最大号加一，所以并发开提示也不撞号；(`user_id`, `code`)
     * 唯一索引兜底。
     */
    async openPrompt(
      userId: string,
      kind: WechatPromptKind,
      refId: string,
    ): Promise<{ code: string }> {
      return database.transaction(async (transaction) => {
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`wechat_prompt:${userId}`}, 0))`,
        );
        const [top] = rowsOf<{ n: number | string | null }>(
          await transaction.execute(sql`
            select max(substring("code" from 2)::integer) as "n"
            from "wechat_prompts"
            where "user_id" = ${userId}
          `),
        );
        const code = `A${Number(top?.n ?? 0) + 1}`;
        await transaction
          .insert(wechatPrompts)
          .values({ id: randomUUID(), userId, code, kind, refId });
        return { code };
      });
    },

    /** 这个人还开着的提示，按编号先后。 */
    async openPrompts(userId: string): Promise<WechatPrompt[]> {
      return database
        .select()
        .from(wechatPrompts)
        .where(
          and(
            eq(wechatPrompts.userId, userId),
            eq(wechatPrompts.state, "open"),
          ),
        )
        .orderBy(sql`substring(${wechatPrompts.code} from 2)::integer`);
    },

    /** 关掉一条提示；它本来就关着或不存在时返回 false。 */
    async closePrompt(userId: string, code: string): Promise<boolean> {
      const [row] = await database
        .update(wechatPrompts)
        .set({ state: "done" })
        .where(
          and(
            eq(wechatPrompts.userId, userId),
            eq(wechatPrompts.code, code),
            eq(wechatPrompts.state, "open"),
          ),
        )
        .returning({ id: wechatPrompts.id });
      return Boolean(row);
    },
  };
}
