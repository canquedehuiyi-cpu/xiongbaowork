/**
 * 心跳的设置和账（期 3·3.1）。
 *
 * 设置存在员工的 `agents.configuration.heartbeat`（`shared/heartbeat.ts`），改它的是员工的主人（设置接口）和员工
 * 自己（`update_heartbeat_checklist`，只改清单）。账是 `heartbeat_runs`：每次真的用了模型或做了事的醒来记一行。
 *
 * 心跳的下一次醒来排在 `work_items` 队列上，一串接一串（`schedule.ts`）。打开心跳、改间隔、改清单都在这里经手，
 * 所以排队也在这里：打开或改了间隔就换一个新的串号，把第一次排上；原来那一串醒来时看到串号对不上，自己收掉。
 */
import { randomUUID } from "node:crypto";
import { and, eq, gte, isNotNull, sql } from "drizzle-orm";
import {
  HEARTBEAT_KEY,
  type HeartbeatPatch,
  type HeartbeatSettings,
  heartbeatOf,
  publicHeartbeat,
  type StoredHeartbeat,
} from "../../../shared/heartbeat";
import type { Database } from "../db/client";
import { agents } from "../db/schema/core";
import { heartbeatRuns } from "../db/schema/heartbeat";
import { proactiveCheckInRuns } from "../db/schema/proactive";
import { lockDefaults } from "../memory/defaults";
import { runAsTenant } from "../tenant/context";
import type { WorkQueue } from "../work/queue";
import {
  HEARTBEAT_KIND,
  type HeartbeatPayload,
  heartbeatKey,
  nextSlot,
} from "./schedule";

/** 一次醒来占着「正在跑」超过这么久，就当它的服务停了，不再算在跑。 */
const STALE_RUNNING_MS = 20 * 60_000;

export type HeartbeatRead = {
  /** `device_acp` 的外部员工自己干活，不开心跳。 */
  type: string;
  heartbeat: StoredHeartbeat | undefined;
};

export type HeartbeatApplied =
  | { ok: true; settings: HeartbeatSettings; scheduledFor: Date | null }
  | { ok: false; why: "not_found" | "external" | "not_yours" };

export type HeartbeatStore = ReturnType<typeof createHeartbeatStore>;

/** 设置和账的读写，都在调用者所在的租户帧里做（本人的帧）。 */
export function createHeartbeatStore(
  database: Database,
  deps: {
    queue: Pick<WorkQueue, "offer">;
    now?: () => Date;
  },
) {
  const now = deps.now ?? (() => new Date());

  async function read(agentId: string): Promise<HeartbeatRead | null> {
    const [row] = await database
      .select({ type: agents.type, configuration: agents.configuration })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);
    return row
      ? { type: row.type, heartbeat: heartbeatOf(row.configuration) }
      : null;
  }

  /** 把下一次醒来排上，在本人的帧里（队列条目带上本人的租户）。同一格同一串号再排一次是同一条。 */
  async function schedule(
    ownerUserId: string,
    agentId: string,
    chain: string,
    at: Date,
  ): Promise<void> {
    const payload: HeartbeatPayload = {
      ownerUserId,
      agentId,
      chain,
      scheduledFor: at.toISOString(),
    };
    await runAsTenant(ownerUserId, () =>
      deps.queue.offer({
        kind: HEARTBEAT_KIND,
        key: heartbeatKey(agentId, chain, at),
        payload,
        runAt: at,
      }),
    );
  }

  return {
    read,
    schedule,

    /**
     * 改设置：只带要改的几项，别的原样留着。打开心跳、或开着时改了间隔，换新的串号并把第一次排上；
     * 清单的改动不动串号。关掉的不排，队列里已有的那一条醒来时自己收掉。同一份设置再存一次，会把排队补上
     * （比如排队失败过），不会多出一串。
     */
    async apply(
      ownerUserId: string,
      agentId: string,
      patch: HeartbeatPatch,
    ): Promise<HeartbeatApplied> {
      const current = await read(agentId);
      if (!current) return { ok: false, why: "not_found" };
      if (current.type === "device_acp") return { ok: false, why: "external" };
      const before = current.heartbeat;
      const enabled = patch.enabled ?? before?.enabled ?? false;
      const opened = enabled && !before?.enabled;
      const retimed =
        enabled &&
        patch.intervalMinutes !== undefined &&
        patch.intervalMinutes !== before?.intervalMinutes;
      // 新的串号：刚打开、改了间隔，或从没有过；其余沿用，清单的改动不动它。
      const chain =
        opened || retimed || !before?.chain ? randomUUID() : before.chain;
      const merged: Record<string, unknown> = {
        ...patch,
        ...(enabled ? { chain } : {}),
      };
      const rows = await database
        .update(agents)
        .set({
          configuration: sql`coalesce(${agents.configuration}, '{}'::jsonb) || jsonb_build_object(${HEARTBEAT_KEY}::text, coalesce(${agents.configuration} -> ${HEARTBEAT_KEY}::text, '{}'::jsonb) || ${JSON.stringify(merged)}::text::jsonb)`,
          updatedAt: sql`now()`,
        })
        .where(eq(agents.id, agentId))
        .returning({ configuration: agents.configuration });
      // 这一行不在这个人的帧里可写（别人名下的员工，管理员也只读它）。
      if (rows.length === 0) return { ok: false, why: "not_yours" };
      const after = heartbeatOf(rows[0]?.configuration);
      let scheduledFor: Date | null = null;
      if (after?.enabled && after.chain) {
        scheduledFor = nextSlot(now(), after.intervalMinutes);
        await schedule(ownerUserId, agentId, after.chain, scheduledFor);
      }
      return { ok: true, settings: publicHeartbeat(after), scheduledFor };
    },

    /**
     * 这位员工、这个人最近 24 小时的心跳和巡检合起来用了多少次。两边共用每天次数上限，所以一起数；
     * 巡检里被挡下（skipped）的没有走到模型，不算。
     */
    async runsToday(ownerUserId: string, agentId: string): Promise<number> {
      const [heart] = await database
        .select({ count: sql<number>`count(*)::int` })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.ownerUserId, ownerUserId),
            eq(heartbeatRuns.agentId, agentId),
            // 只数用了模型的醒来；只认领了卡的（没有线程）不占每天的名额。
            isNotNull(heartbeatRuns.threadId),
            gte(heartbeatRuns.startedAt, sql`now() - interval '24 hours'`),
          ),
        );
      const [check] = await database
        .select({ count: sql<number>`count(*)::int` })
        .from(proactiveCheckInRuns)
        .where(
          and(
            eq(proactiveCheckInRuns.ownerUserId, ownerUserId),
            eq(proactiveCheckInRuns.agentId, agentId),
            sql`${proactiveCheckInRuns.outcome} <> 'skipped'`,
            gte(
              proactiveCheckInRuns.startedAt,
              sql`now() - interval '24 hours'`,
            ),
          ),
        );
      return (heart?.count ?? 0) + (check?.count ?? 0);
    },

    /**
     * 开始一次醒来的账，和次数上限一起一步做完（按员工和本人加锁，几个副本同时来也不会都挤进最后一个名额）。
     * 超过上限答 `capped`，不写行。顺手把这位员工自己留下的、早就没人在跑的「正在跑」行收成失败。
     */
    async beginRun(input: {
      id: string;
      ownerUserId: string;
      agentId: string;
      scheduledFor: Date;
      /** 没用模型、只认领了卡的醒来没有线程，也不占每天的名额。 */
      threadId: string | null;
      /** 每天最多几次；null 是不数（只认领卡的醒来）。 */
      dailyLimit: number | null;
    }): Promise<true | "capped"> {
      return database.transaction(async (transaction) => {
        // 和巡检开始一次检查用的是同一把锁：两边合起来数每天次数，谁先谁后都不会一起挤进最后一个名额。
        await lockDefaults(transaction, input.ownerUserId, input.agentId);
        await transaction
          .update(heartbeatRuns)
          .set({
            outcome: "failed",
            error: "服务器没有等到这一次醒来收尾。",
            finishedAt: sql`now()`,
          })
          .where(
            and(
              eq(heartbeatRuns.agentId, input.agentId),
              eq(heartbeatRuns.outcome, "running"),
              sql`${heartbeatRuns.startedAt} < now() - make_interval(secs => ${STALE_RUNNING_MS / 1000})`,
            ),
          );
        const [heart] = await transaction
          .select({ count: sql<number>`count(*)::int` })
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.ownerUserId, input.ownerUserId),
              eq(heartbeatRuns.agentId, input.agentId),
              isNotNull(heartbeatRuns.threadId),
              gte(heartbeatRuns.startedAt, sql`now() - interval '24 hours'`),
            ),
          );
        const [check] = await transaction
          .select({ count: sql<number>`count(*)::int` })
          .from(proactiveCheckInRuns)
          .where(
            and(
              eq(proactiveCheckInRuns.ownerUserId, input.ownerUserId),
              eq(proactiveCheckInRuns.agentId, input.agentId),
              sql`${proactiveCheckInRuns.outcome} <> 'skipped'`,
              gte(
                proactiveCheckInRuns.startedAt,
                sql`now() - interval '24 hours'`,
              ),
            ),
          );
        if (
          input.dailyLimit !== null &&
          (heart?.count ?? 0) + (check?.count ?? 0) >= input.dailyLimit
        )
          return "capped" as const;
        await transaction.insert(heartbeatRuns).values({
          id: input.id,
          ownerUserId: input.ownerUserId,
          agentId: input.agentId,
          scheduledFor: input.scheduledFor,
          threadId: input.threadId,
        });
        return true as const;
      });
    },

    /** 收一次醒来：没事静默收工、做了事、出了错。只收还在跑的，收过的不改。 */
    async finishRun(
      id: string,
      result: {
        outcome: "quiet" | "acted" | "failed";
        cardsClaimed?: number;
        error?: string | null;
      },
    ): Promise<void> {
      await database
        .update(heartbeatRuns)
        .set({
          outcome: result.outcome,
          cardsClaimed: result.cardsClaimed ?? 0,
          error: result.error?.slice(0, 500) ?? null,
          finishedAt: sql`now()`,
        })
        .where(
          and(eq(heartbeatRuns.id, id), eq(heartbeatRuns.outcome, "running")),
        );
    },

    /** 最近几次醒来，新的在前，给设置界面读「上次什么时候、什么结果」。 */
    async recent(agentId: string, limit = 5) {
      return database
        .select({
          id: heartbeatRuns.id,
          scheduledFor: heartbeatRuns.scheduledFor,
          startedAt: heartbeatRuns.startedAt,
          finishedAt: heartbeatRuns.finishedAt,
          outcome: heartbeatRuns.outcome,
          cardsClaimed: heartbeatRuns.cardsClaimed,
          error: heartbeatRuns.error,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId))
        .orderBy(sql`${heartbeatRuns.startedAt} desc`)
        .limit(limit);
    },
  };
}
