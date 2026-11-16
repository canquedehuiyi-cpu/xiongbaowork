/*
 * 微信 ClawBot 通道的账号、绑定尝试、提示存取（迁移 0223、0224、0225）。
 *
 * 帧：本人的事（绑定、解绑、提示）在调用方的帧里做，调用方应在这个人自己的帧里；行级安全保证别人的帧
 * 里读不到、改不到。跨人的问题由这里自己开 platform 帧，调用方在谁的帧里都一样：
 *  - `accountByIlinkUser`：第二个人扫同一个微信时，要看得见第一个人的行才能拒绝；
 *  - `claimForPolling` / `renewLease`：轮询器从定时器起跑，不属于任何人，要认领所有人的账号。
 *
 * 租约按数据库时钟（`now()`）算，理由同 `work/queue.ts`：副本的时钟和数据库的时钟不是一个钟。
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../../db/client";
import {
  type WechatAccount,
  type WechatBindAttempt,
  type WechatBindAttemptStatus,
  type WechatPrompt,
  type WechatPromptKind,
  wechatAccounts,
  wechatBindAttempts,
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

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
/** 账号写入可以加入调用方的事务（绑定时和凭据一起提交，撞上唯一索引时一起回滚）。 */
export type WechatExecutor = Database | Transaction;

/** 账号行上留多少个最近处理过的入站消息 ID（持久去重）。 */
export const WECHAT_SEEN_MESSAGES = 500;

/** 一次扫码绑定的有效期。 */
export const WECHAT_BIND_ATTEMPT_MINUTES = 10;

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
     * 这个微信用户当前绑在谁身上（只算 `bound` 和 `paused`；已解绑、已断开的行不占着这个微信）。
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
              inArray(wechatAccounts.status, ["bound", "paused"]),
            ),
          ),
      );
      return row ?? null;
    },

    /**
     * 绑定或重新绑定：一人一行，重新绑定改写原行，旧游标、上下文、暂停、租约和漏发计数一并清掉。
     * 同一个 iLink 用户已绑在别人身上时，部分唯一索引让这里抛错。
     */
    async saveAccount(
      input: WechatAccountInput,
      executor: WechatExecutor = database,
    ): Promise<WechatAccount> {
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
        boundAt: sql`now()`,
      };
      const [row] = await executor
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

    /**
     * 保存 `get_updates_buf`；空串不保存，保留上一次的游标。
     *
     * 给了 `owner`（轮询器总是给本次认领的 owner）时，只在租约还在它手里时写：租约过期、被别的副本认领后，
     * 慢下来的这一个不能把游标写回旧的位置。
     */
    async setCursor(
      accountId: string,
      cursor: string,
      owner?: string,
    ): Promise<void> {
      if (!cursor) return;
      await database
        .update(wechatAccounts)
        .set({ cursor, updatedAt: sql`now()` })
        .where(
          and(
            eq(wechatAccounts.id, accountId),
            ...(owner === undefined
              ? []
              : [eq(wechatAccounts.leaseOwner, owner)]),
          ),
        );
    },

    /**
     * 入站的持久去重：把这条消息的 ID 记到账号行上（最多留最近 `WECHAT_SEEN_MESSAGES` 个），
     * 返回 true 表示第一次见；已经记过返回 false。一条 UPDATE，两个并发的同一条只有一个拿到 true
     * （第二个等第一个提交后重新判断条件）。在本人的帧里。
     */
    async claimMessage(accountId: string, messageId: string): Promise<boolean> {
      const [row] = await database
        .update(wechatAccounts)
        .set({
          recentMessageIds: sql`(array_append(${wechatAccounts.recentMessageIds}, ${messageId}::text))[greatest(1, cardinality(${wechatAccounts.recentMessageIds}) + 2 - ${WECHAT_SEEN_MESSAGES}::integer):]`,
        })
        .where(
          and(
            eq(wechatAccounts.id, accountId),
            sql`not (${messageId}::text = any(${wechatAccounts.recentMessageIds}))`,
          ),
        )
        .returning({ id: wechatAccounts.id });
      return Boolean(row);
    },

    /** 处理中途出错：拿掉这条的记录，轮询器重试时照常处理。 */
    async releaseMessage(accountId: string, messageId: string): Promise<void> {
      await database
        .update(wechatAccounts)
        .set({
          recentMessageIds: sql`array_remove(${wechatAccounts.recentMessageIds}, ${messageId}::text)`,
        })
        .where(eq(wechatAccounts.id, accountId));
    },

    /** 记下这个人在微信里最后交给的员工（不带 @ 的消息交给它）。 */
    async setLastAgent(accountId: string, agentId: string): Promise<void> {
      await database
        .update(wechatAccounts)
        .set({ lastAgentId: agentId, updatedAt: sql`now()` })
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
            inArray(wechatAccounts.status, ["bound", "paused"]),
          ),
        );
    },

    /**
     * iLink 拒绝了令牌（401/403）：标成 `disconnected`，不再认领，行和凭据保留；清掉租约。
     * 这个微信号随之不再占着唯一索引。本人重新扫码时 `saveAccount` 覆盖这一行、回到 `bound`。
     */
    async disconnect(accountId: string): Promise<void> {
      await database
        .update(wechatAccounts)
        .set({
          status: "disconnected",
          pausedUntil: null,
          leaseOwner: null,
          leaseUntil: null,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(wechatAccounts.id, accountId),
            inArray(wechatAccounts.status, ["bound", "paused"]),
          ),
        );
    },

    /**
     * 轮询完一次就还租约，下一轮马上能认领；只还自己的。在调用方的帧里（账号所属租户）。
     *
     * `lease_until` 设成 `now() + backoffMs`（默认就是现在）而不是清空：认领按 `lease_until` 从小到大、
     * 空的最先，刚拉过的账号排到队尾，账号多过一批时每个都轮得到；新绑定的（空）仍排最前。
     * `backoffMs` 大于 0 时这个账号要等这么久才会再被认领（出错退避）。
     */
    async releaseLease(
      accountId: string,
      owner: string,
      backoffMs = 0,
    ): Promise<void> {
      await database
        .update(wechatAccounts)
        .set({ leaseOwner: null, leaseUntil: leaseFromNow(backoffMs) })
        .where(
          and(
            eq(wechatAccounts.id, accountId),
            eq(wechatAccounts.leaseOwner, owner),
          ),
        );
    },

    /**
     * 解绑：保留行、标成 `unbound`，清掉游标、上下文和租约，这个微信从此可以再绑给别人。
     * 返回改后的行（`credentialId` 供调用方吊销凭据），没有账号为 null。
     */
    async unbind(
      userId: string,
      executor: WechatExecutor = database,
    ): Promise<WechatAccount | null> {
      const [row] = await executor
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

    /** 开一次扫码绑定，`expires_at` 按数据库时钟定在 10 分钟后。 */
    async createAttempt(
      userId: string,
      input: { qrcode: string; imageContent: string | null },
    ): Promise<WechatBindAttempt> {
      const [row] = await database
        .insert(wechatBindAttempts)
        .values({
          id: randomUUID(),
          userId,
          qrcode: input.qrcode,
          imageContent: input.imageContent,
          status: "wait",
          expiresAt: sql`now() + make_interval(mins => ${WECHAT_BIND_ATTEMPT_MINUTES})`,
        })
        .returning();
      if (!row) throw new Error("wechat bind attempt was not saved");
      return row;
    },

    /**
     * 这个人的一次绑定，别人的或不存在的为 null（行级安全之外再按 `user_id` 过滤）。
     * `expired` 按数据库时钟算。
     */
    async attempt(
      userId: string,
      id: string,
    ): Promise<(WechatBindAttempt & { expired: boolean }) | null> {
      const [row] = await database
        .select({
          attempt: wechatBindAttempts,
          expired: sql<boolean>`${wechatBindAttempts.expiresAt} <= now()`,
        })
        .from(wechatBindAttempts)
        .where(
          and(
            eq(wechatBindAttempts.id, id),
            eq(wechatBindAttempts.userId, userId),
          ),
        );
      return row ? { ...row.attempt, expired: Boolean(row.expired) } : null;
    },

    async setAttemptStatus(
      userId: string,
      id: string,
      status: WechatBindAttemptStatus,
    ): Promise<void> {
      await database
        .update(wechatBindAttempts)
        .set({ status })
        .where(
          and(
            eq(wechatBindAttempts.id, id),
            eq(wechatBindAttempts.userId, userId),
          ),
        );
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
      /** 本副本还在处理的账号：不认领，也就不动它们的租约。 */
      exclude: readonly string[] = [],
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
                ${
                  exclude.length
                    ? sql`and "id" not in (${sql.join(
                        exclude.map((id) => sql`${id}`),
                        sql`, `,
                      )})`
                    : sql``
                }
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
     * 续租，只在账号是 `bound`、租约仍是自己的、且没过期时成功：过期后可能已被别人认领，不能从别人手里续回来。
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
              eq(wechatAccounts.status, "bound"),
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
     * 唯一索引兜底。同一件事（同一 `kind`、同一 `ref_id`）还开着时不再开，返回原来那条的编号：锁里先查，
     * 部分唯一索引（迁移 0228）在库里兜底，冲突时同样返回已有的那条。
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
        const existing = async () => {
          const [row] = await transaction
            .select({ code: wechatPrompts.code })
            .from(wechatPrompts)
            .where(
              and(
                eq(wechatPrompts.userId, userId),
                eq(wechatPrompts.kind, kind),
                eq(wechatPrompts.refId, refId),
                eq(wechatPrompts.state, "open"),
              ),
            )
            .limit(1);
          return row ?? null;
        };
        const open = await existing();
        if (open) return { code: open.code };
        const code = `A${Number(top?.n ?? 0) + 1}`;
        const [inserted] = await transaction
          .insert(wechatPrompts)
          .values({ id: randomUUID(), userId, code, kind, refId })
          .onConflictDoNothing()
          .returning({ code: wechatPrompts.code });
        if (inserted) return { code: inserted.code };
        const raced = await existing();
        if (!raced) throw new Error("wechat prompt could not be opened");
        return { code: raced.code };
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
