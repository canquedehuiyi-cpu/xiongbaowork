import { and, eq, isNull, sql } from "drizzle-orm";
import { type AuditStore, createAuditStore, recordAuditEvent } from "../audit";
import type { Database } from "../db/client";
import {
  composioConnections,
  mcpServers,
  pendingAuthorizations,
} from "../db/schema";
import { type BrokerProvider, toolkitOfFor } from "./access";
import type { AccountRef } from "./shared-accounts";

/**
 * 进行中的 Arcade 授权（X5，上游 `plugin-store/connections.ts` 的授权尝试部分，按 fork 改写）。
 *
 * 一次授权的生命：发起（`claimAuthorizationAttempt`）→ 厂商给出 mint id 后绑定（`recordAuthorizationMint`）
 * → 人在厂商页面同意 → 浏览器回到 `/api/plugins/arcade/verify`，核对通过后完成（`completeAuthorizationAttempt`，
 * 只成功一次）或结束（失败 / 未对账 / 已撤回 / 取消）。
 *
 * 与上游的差异：
 * - 个人连接写进 fork 的 `composio_connections`（`provider = 'arcade'`），团队账号写进应用行的 `shared_*`
 *   列（X1 的账号模型），而不是上游的 `brokered_connections`。
 * - 一个人「再连一个 Arcade 账号」（上游 `<id>~<suffix>`）不在 X5：完成时账号必须是本人自己的 vendor id，
 *   否则不记录。fork 的调用路径按 Composio 的 account id 钉账号，Arcade 的第二个账号是另一个 user id，
 *   这条路还没接上，记下来只会得到一个调用不到的账号。
 */
export type PendingAuthorization = typeof pendingAuthorizations.$inferSelect;

/** 过了这个时长，一次没完成的尝试就让位给新的发起。与迁移 0192 的说明一致。 */
const ATTEMPT_TTL = sql`interval '15 minutes'`;

function attemptInstant(createdAt: Date | string): Date {
  const instant =
    createdAt instanceof Date
      ? createdAt
      : typeof createdAt === "string"
        ? new Date(createdAt)
        : new Date(Number.NaN);
  if (Number.isNaN(instant.getTime())) {
    throw new Error(
      `An authorization attempt's created_at must be a Date or an ISO timestamp, not ${JSON.stringify(createdAt) ?? String(createdAt)}.`,
    );
  }
  return instant;
}

export function createArcadeAttempts(context: {
  database: Database;
  auditStore: AuditStore;
  provider: BrokerProvider;
}) {
  const { database, auditStore, provider } = context;

  /**
   * 按发起人和发起时刻点名一次尝试，比较到毫秒（JS 的 Date 只有毫秒）：用列默认值写入、带微秒的行
   * 也能点到，「丢弃那一次」又不会碰到同一个人后来的那一次。点不出时刻的值直接拒绝，不去匹配。
   */
  const attemptNamed = (actorId: string, createdAt: Date | string) =>
    and(
      eq(pendingAuthorizations.actorId, actorId),
      sql`date_trunc('milliseconds', ${pendingAuthorizations.createdAt}) = ${attemptInstant(createdAt).toISOString()}::timestamptz`,
    );

  /**
   * 以一个结局结束一次还没结束的尝试（按发起人与 mint id），只结束一次：已结束的不会被迟到的回调改写。
   * 「未对账」另写一条审计（与结束在同一个事务里，审计写不进去就不结束）：厂商那边可能有一个这里没有
   * 记录的授权。审计里不放 mint id。
   */
  async function closeAuthorizationAttempt(
    input: { actorId: string; authId: string },
    outcome: "failed" | "unreconciled" | "withdrawn",
  ): Promise<boolean> {
    return await database.transaction(async (transaction) => {
      const closed = await transaction
        .update(pendingAuthorizations)
        .set({ completedAt: sql`date_trunc('milliseconds', now())`, outcome })
        .where(
          and(
            eq(pendingAuthorizations.actorId, input.actorId),
            eq(pendingAuthorizations.authId, input.authId),
            isNull(pendingAuthorizations.completedAt),
          ),
        )
        .returning({
          serverId: pendingAuthorizations.serverId,
          action: pendingAuthorizations.action,
          holder: pendingAuthorizations.holder,
          createdAt: pendingAuthorizations.createdAt,
        });
      const attempt = closed[0];
      if (!attempt) return false;
      if (outcome === "unreconciled") {
        const [row] = await transaction
          .select({ url: mcpServers.url })
          .from(mcpServers)
          .where(eq(mcpServers.id, attempt.serverId))
          .limit(1);
        await recordAuditEvent(
          createAuditStore(transaction as unknown as Database),
          {
            eventType: "mcp.authorization_unreconciled",
            targetType: "mcp_server",
            targetId: attempt.serverId,
            payload: {
              actor: input.actorId,
              server: row ? toolkitOfFor(provider, row.url) : null,
              serverId: attempt.serverId,
              action: attempt.action,
              holder: attempt.holder,
              attemptStartedAt: attempt.createdAt.toISOString(),
              outcome,
            },
          },
        );
      }
      return true;
    });
  }

  function fromRow(row: Record<string, unknown>): PendingAuthorization {
    const date = (value: unknown) =>
      value === null || value === undefined ? null : new Date(value as string);
    return {
      tenantId: row.tenant_id as string,
      actorId: row.actor_id as string,
      serverId: row.server_id as string,
      action: (row.action as string | null) ?? null,
      holder: row.holder as "person" | "deployment",
      userId: (row.user_id as string | null) ?? null,
      vendorUserId: row.vendor_user_id as string,
      authId: (row.auth_id as string | null) ?? null,
      createdAt: date(row.created_at) as Date,
      completedAt: date(row.completed_at),
      outcome: (row.outcome as PendingAuthorization["outcome"]) ?? null,
    };
  }

  return {
    /**
     * 开始一次尝试。一条语句：活着的尝试拒绝（并答出它），过期或已结束的被接管，谁也不会被永久锁住。
     */
    async claimAuthorizationAttempt(input: {
      actorId: string;
      serverId: string;
      action: string | null;
      account: AccountRef;
    }): Promise<
      | { claimed: true; attempt: PendingAuthorization }
      | { claimed: false; live: PendingAuthorization | null }
    > {
      const rows = await database.execute(sql`
        WITH claimed AS (
          INSERT INTO pending_authorizations
            (actor_id, server_id, action, holder, user_id, vendor_user_id, created_at)
          VALUES (
            ${input.actorId}, ${input.serverId}, ${input.action}, ${input.account.holder},
            ${input.account.holder === "person" ? input.account.userId : null},
            ${input.account.vendorUserId}, date_trunc('milliseconds', now())
          )
          ON CONFLICT (actor_id) DO UPDATE SET
            server_id = EXCLUDED.server_id,
            action = EXCLUDED.action,
            holder = EXCLUDED.holder,
            user_id = EXCLUDED.user_id,
            vendor_user_id = EXCLUDED.vendor_user_id,
            auth_id = NULL,
            created_at = EXCLUDED.created_at,
            completed_at = NULL,
            outcome = NULL
          WHERE pending_authorizations.created_at < now() - ${ATTEMPT_TTL}
            OR pending_authorizations.completed_at IS NOT NULL
          RETURNING *
        )
        SELECT true AS claimed, claimed.* FROM claimed
        UNION ALL
        SELECT false AS claimed, p.* FROM pending_authorizations p
        WHERE p.actor_id = ${input.actorId}
          AND NOT EXISTS (SELECT 1 FROM claimed)
      `);
      const row = rows[0] as Record<string, unknown> | undefined;
      if (!row) return { claimed: false, live: null };
      const attempt = fromRow(row);
      return row.claimed === true
        ? { claimed: true, attempt }
        : { claimed: false, live: attempt };
    },

    /**
     * 把厂商的 mint id 写到这一次尝试上。只写还没有 id、还没结束的那一次：迟到或重复的 mint 不能
     * 改绑一次已完成、已失败或已绑定的尝试。
     */
    async recordAuthorizationMint(input: {
      actorId: string;
      createdAt: Date | string;
      authId: string | null;
    }): Promise<boolean> {
      const written = await database
        .update(pendingAuthorizations)
        .set({ authId: input.authId })
        .where(
          and(
            attemptNamed(input.actorId, input.createdAt),
            isNull(pendingAuthorizations.authId),
            isNull(pendingAuthorizations.completedAt),
          ),
        )
        .returning({ actorId: pendingAuthorizations.actorId });
      return written.length > 0;
    },

    /** 删掉点名的那一次（还没结束的）。已结束的留着，它的结果是别人要读的。 */
    async discardAuthorizationAttempt(input: {
      actorId: string;
      createdAt: Date | string;
    }): Promise<boolean> {
      const deleted = await database
        .delete(pendingAuthorizations)
        .where(
          and(
            attemptNamed(input.actorId, input.createdAt),
            isNull(pendingAuthorizations.completedAt),
          ),
        )
        .returning({ actorId: pendingAuthorizations.actorId });
      return deleted.length > 0;
    },

    async settledAuthorizationOutcome(input: {
      actorId: string;
      createdAt: Date | string;
    }): Promise<PendingAuthorization["outcome"]> {
      const [row] = await database
        .select({ outcome: pendingAuthorizations.outcome })
        .from(pendingAuthorizations)
        .where(attemptNamed(input.actorId, input.createdAt));
      return row?.outcome ?? null;
    },

    /**
     * 完成一次尝试并记下连接，在一个事务里，只成功一次：先按发起人与 mint id 认领（`completed_at` 为空才
     * 认领得到），再写连接与审计。认领不到答 `{ claimed: false }`，什么也不写。
     *
     * 个人：账号必须是发起人自己的 vendor id（见文件头）；写 `composio_connections`（`provider` 为活动的
     * 提供商，`verified` 为真：厂商自己说授权完成了）。团队账号：只写应用行上 X1 的 `shared_*` 列，
     * 且只在它仍是 Shared、团队身份仍是这次授权的身份时；否则回滚，不留半个结果。
     */
    async completeAuthorizationAttempt(input: {
      actorId: string;
      authId: string;
      /** 团队账号的完成必须给：要更新的应用行。个人的完成不读它。 */
      serverId?: string;
      toolkit: string;
      account: AccountRef;
      action: string | null;
      scopes: string[];
      authProvider: string;
    }): Promise<{ claimed: boolean }> {
      if (
        input.account.holder === "person" &&
        input.account.vendorUserId !== input.account.userId
      ) {
        throw new Error(
          "An Arcade account filed under a name other than the person's own is not recorded in this deployment.",
        );
      }
      return await database.transaction(async (transaction) => {
        const claimed = await transaction.execute(sql`
          UPDATE pending_authorizations
             SET completed_at = date_trunc('milliseconds', now()),
                 outcome = 'completed'
           WHERE actor_id = ${input.actorId}
             AND auth_id = ${input.authId}
             AND completed_at IS NULL
          RETURNING actor_id
        `);
        if (claimed.length === 0) return { claimed: false };

        const now = new Date();
        let reconnected: boolean;
        if (input.account.holder === "person") {
          const [existing] = await transaction
            .select({ toolkit: composioConnections.toolkit })
            .from(composioConnections)
            .where(
              and(
                eq(composioConnections.toolkit, input.toolkit),
                eq(composioConnections.userId, input.account.userId),
              ),
            );
          reconnected = existing !== undefined;
          const set = {
            verified: true,
            verifiedAt: now,
            probeAction: null,
            provider,
            updatedAt: now,
          };
          await transaction
            .insert(composioConnections)
            .values({
              toolkit: input.toolkit,
              userId: input.account.userId,
              ...set,
            })
            .onConflictDoUpdate({
              target: [composioConnections.toolkit, composioConnections.userId],
              set,
            });
        } else {
          /*
           * Whether the team account was already connected, read in this transaction and locked
           * before the write. Read off the row as it was, not off the write's answer: the write keeps
           * the first connection's `shared_connected_by` (coalesce), so comparing that with this actor
           * called the same admin connecting again a first connection.
           */
          const [before] = await transaction
            .select({ connectedAt: mcpServers.sharedConnectedAt })
            .from(mcpServers)
            .where(eq(mcpServers.id, input.serverId ?? ""))
            .for("update");
          const updated = await transaction
            .update(mcpServers)
            .set({
              sharedConnectedAt: sql`coalesce(${mcpServers.sharedConnectedAt}, ${now})`,
              sharedConnectedBy: sql`coalesce(${mcpServers.sharedConnectedBy}, ${input.actorId})`,
              sharedVerified: true,
              sharedVerifiedAt: now,
              sharedProbeAction: null,
              updatedAt: now,
            })
            .where(
              and(
                eq(mcpServers.id, input.serverId ?? ""),
                eq(mcpServers.accountMode, "shared"),
                eq(mcpServers.sharedVendorUserId, input.account.vendorUserId),
              ),
            )
            .returning({ connectedBy: mcpServers.sharedConnectedBy });
          if (updated.length === 0) {
            throw new Error(
              "The app's team account changed while its consent was in progress, so nothing was recorded.",
            );
          }
          reconnected = Boolean(before?.connectedAt);
        }

        await recordAuditEvent(
          createAuditStore(transaction as unknown as Database),
          {
            eventType: "mcp.account_connected",
            targetType: "mcp_server",
            targetId: input.toolkit,
            payload: {
              actor: input.actorId,
              server: input.toolkit,
              scope: input.scopes.join(" "),
              action: input.action,
              authProvider: input.authProvider,
              reconnected,
              holder: input.account.holder,
            },
          },
        );
        return { claimed: true };
      });
    },

    async failAuthorizationAttempt(input: {
      actorId: string;
      authId: string;
    }): Promise<boolean> {
      return await closeAuthorizationAttempt(input, "failed");
    },

    async markAuthorizationUnreconciled(input: {
      actorId: string;
      authId: string;
    }): Promise<boolean> {
      return await closeAuthorizationAttempt(input, "unreconciled");
    },

    async markAuthorizationWithdrawn(input: {
      actorId: string;
      authId: string;
    }): Promise<boolean> {
      return await closeAuthorizationAttempt(input, "withdrawn");
    },

    /** 这一次是否已经完成：用于「写入报错了，但其实提交了」的判断，不靠异常猜。 */
    async authorizationAttemptCompleted(input: {
      actorId: string;
      authId: string;
    }): Promise<boolean> {
      const [row] = await database
        .select({ actorId: pendingAuthorizations.actorId })
        .from(pendingAuthorizations)
        .where(
          and(
            eq(pendingAuthorizations.actorId, input.actorId),
            eq(pendingAuthorizations.authId, input.authId),
            eq(pendingAuthorizations.outcome, "completed"),
          ),
        );
      return row !== undefined;
    },

    /**
     * 这个人刚被取消（撤回）、带着 mint id 的那一次，还在 15 分钟内（X5 评审 I1）。取消后厂商那边仍可能
     * 完成同意；回程拿它核对这个遗留授权是不是这一次的，再决定撤销还是留痕。
     */
    async withdrawnAttemptFor(
      actorId: string,
    ): Promise<PendingAuthorization | null> {
      const [row] = await database
        .select()
        .from(pendingAuthorizations)
        .where(
          and(
            eq(pendingAuthorizations.actorId, actorId),
            eq(pendingAuthorizations.outcome, "withdrawn"),
            sql`${pendingAuthorizations.authId} IS NOT NULL`,
            sql`${pendingAuthorizations.createdAt} >= now() - ${ATTEMPT_TTL}`,
          ),
        );
      return row ?? null;
    },

    /** 这个人活着的那一次：没结束、没过期。 */
    async authorizationAttemptFor(
      actorId: string,
    ): Promise<PendingAuthorization | null> {
      const [row] = await database
        .select()
        .from(pendingAuthorizations)
        .where(
          and(
            eq(pendingAuthorizations.actorId, actorId),
            isNull(pendingAuthorizations.completedAt),
            sql`${pendingAuthorizations.createdAt} >= now() - ${ATTEMPT_TTL}`,
          ),
        );
      return row ?? null;
    },

    async recordAuthorizationCancelled(input: {
      actorId: string;
      attempt: PendingAuthorization;
    }): Promise<void> {
      const [row] = await database
        .select({ url: mcpServers.url })
        .from(mcpServers)
        .where(eq(mcpServers.id, input.attempt.serverId))
        .limit(1);
      const toolkit = row ? toolkitOfFor(provider, row.url) : null;
      await recordAuditEvent(auditStore, {
        eventType: "mcp.authorization_cancelled",
        targetType: "mcp_server",
        targetId: toolkit ?? input.attempt.serverId,
        payload: {
          actor: input.actorId,
          server: toolkit,
          serverId: input.attempt.serverId,
          action: input.attempt.action,
          holder: input.attempt.holder,
          minted: input.attempt.authId !== null,
        },
      });
    },

    async recordCancelledGrantLeftLive(input: {
      actorId: string;
      attempt: PendingAuthorization;
      toolkit: string;
      why: string;
      siblings: readonly string[];
    }): Promise<void> {
      await recordAuditEvent(auditStore, {
        eventType: "mcp.cancelled_grant_left_live",
        targetType: "mcp_server",
        targetId: input.toolkit,
        payload: {
          actor: input.actorId,
          server: input.toolkit,
          serverId: input.attempt.serverId,
          action: input.attempt.action,
          holder: input.attempt.holder,
          why: input.why,
          siblings: [...input.siblings],
        },
      });
    },
  };
}

export type ArcadeAttempts = ReturnType<typeof createArcadeAttempts>;

/**
 * 另一个提供商持有的个人连接数，给启动时的 `assertActivatable`（X5）。在 platform 帧里数，所以数的是
 * 整个部署的行。团队账号记在应用行上：provenance 是另一个提供商、且已连接团队账号的应用也算。
 */
export async function connectionsHeldBy(
  database: Database,
  other: BrokerProvider,
): Promise<number> {
  const [people] = await database
    .select({ count: sql<number>`count(*)::int` })
    .from(composioConnections)
    .where(eq(composioConnections.provider, other));
  const [shared] = await database
    .select({ count: sql<number>`count(*)::int` })
    .from(mcpServers)
    .where(
      and(
        eq(mcpServers.provenance, other),
        sql`${mcpServers.sharedConnectedAt} IS NOT NULL`,
      ),
    );
  return (people?.count ?? 0) + (shared?.count ?? 0);
}
