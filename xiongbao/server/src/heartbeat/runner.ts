/**
 * 心跳醒来的那一轮（期 3·3.1）。
 *
 * 不另造执行器：醒来是 `work_items` 队列上的一条（`heartbeat.run`），领出来在本人的帧里跑，模型那一轮走的
 * 是和巡检、跟进同一个无头轮（`createTurnRunner`），用员工设置里的轻量模型（`agents/light-model.ts` 认
 * `heartbeat:` 开头的发起者）。
 *
 * 没事就静默，这是这个模块最要紧的约定：
 *  - 醒来用的是一条不挂在任何对话上的新线程，不是本人和员工的单聊；
 *  - 回复只有 `HEARTBEAT_OK`（或什么也没说）就收工：不往对话里写一行，不发一条通知，不在看板上开卡，
 *    也不会为它再开第二轮；账里只留一行 `quiet`；
 *  - 清单是空的、也没有可认领的卡，连模型都不叫，账里一行都不留。
 * 有事（回复里有别的话）才把那一两句话写进本人和员工的单聊、发通知、在看板上留一张卡。
 *
 * 每一次醒来先把下一次排进队列再做这一次的事，所以一次出错、一次被挡下都不会让这串心跳断掉。受安静时段管：
 * 在安静时段里这一次不做，下一次排到时段结束；受每天次数上限管：和巡检合起来数，超了这一次不做。
 */

import {
  type HeartbeatSettings,
  isHeartbeatQuiet,
} from "../../../shared/heartbeat";
import { HeadlessToolSuspension } from "../../../toolkit/src/headless-tools";
import { EmptyTurnError, type TurnRunner } from "../../../toolkit/src/run-turn";
import { BotPausedError } from "../agents/lifecycle";
import type { AgentActor } from "../agents/profile-types";
import type { AuditInitiator } from "../audit";
import type { AgentChannel } from "../channels/routes";
import type { TaskProjector } from "../tasks/projector";
import {
  assertPersonTenant,
  runAsTenant,
  TenantContextError,
} from "../tenant/context";
import type { QuietUntil } from "../user-preferences";
import type { WorkQueue } from "../work/queue";
import {
  HEARTBEAT_KIND,
  type HeartbeatPayload,
  heartbeatInstruction,
  nextSlot,
} from "./schedule";
import type { HeartbeatStore } from "./store";

/** 心跳醒来的发起者 id 前缀，`agents/light-model.ts` 靠它认出这是轻量轮。 */
export const HEARTBEAT_INITIATOR_PREFIX = "heartbeat:";

export function heartbeatInitiator(runId: string): AuditInitiator {
  return { kind: "routine", id: `${HEARTBEAT_INITIATOR_PREFIX}${runId}` };
}

/** 一次醒来没有走到模型的原因，写进报告和日志，不写进账。 */
export type HeartbeatSkip =
  | "dropped"
  | "quiet_hours"
  | "off_person"
  | "paused"
  | "off_admin"
  | "quota"
  | "capped"
  | "unreachable"
  | "empty"
  | "recovered";

export type HeartbeatReport = {
  /** 用了模型或做了事的醒来：键和结局。 */
  ran: { key: string; outcome: "quiet" | "acted" | "failed" }[];
  /** 没走到模型的醒来：键和原因。 */
  skipped: { key: string; reason: HeartbeatSkip }[];
};

export type HeartbeatRunnerDeps = {
  queue: Pick<WorkQueue, "claim" | "renew" | "finish" | "purge" | "release">;
  store: HeartbeatStore;
  owner: string;
  runTurn: TurnRunner;
  mintThreadId: () => string;
  actorFor: (ownerUserId: string) => Promise<AgentActor>;
  channels: {
    direct(actor: AgentActor, agentId: string): Promise<AgentChannel>;
    recordActivity(
      actor: AgentActor,
      channelId: string,
      activity: { text: string; agentId: string | null; at: Date },
      source?: { id: string },
    ): Promise<void>;
  };
  /** 安静时段：这个人现在在里面，就答结束的时刻。 */
  quietUntil?: QuietUntil;
  /**
   * 不用模型就能知道这一次不该做的原因：本人关了主动检查、员工被暂停、管理员关了、本月额度用完了。
   * 沿用巡检的那几道关（`proactive/engine.ts` 的 `gateOf`），不另立一套。没有就不拦。
   */
  gate?: (input: {
    ownerUserId: string;
    agentId: string;
  }) => Promise<Exclude<
    HeartbeatSkip,
    "dropped" | "quiet_hours" | "capped" | "unreachable" | "empty"
  > | null>;
  /** 每天最多几次：和巡检共用的那个上限（管理员可调）。 */
  dailyRuns: (agentId: string) => Promise<number>;
  /**
   * 这次醒来顺手在看板上认领派给这位员工岗位的卡并开工（Task 3.3）。答认领了几张。没有就不认领。
   * 它不用模型，也不算每天次数。
   */
  claimCards?: (input: {
    ownerUserId: string;
    agentId: string;
  }) => Promise<number>;
  /** 有事时：把话告诉本人（推送、聊天软件），受本人的路由和安静时段管。 */
  notify?: (
    scope: {
      ownerUserId: string;
      channelId: string;
      agentId: string;
      threadId: string;
    },
    input: {
      id: string;
      text: string;
      kind: "reply";
      /**
       * 醒来这一轮跨进了安静时段、或本人不在时：按「人不在时的通知」发，和别的主动通知一样，在安静时段里推迟到结束。
       */
      away: { push: boolean; chat: boolean; chatText: string };
    },
  ) => Promise<void>;
  /** 有事时：在看板上留一张卡（路线同巡检：只有有事的才留）。 */
  board?: Pick<TaskProjector, "opened" | "finished">;
  now?: () => Date;
  leaseMs?: number;
};

const logged = (type: string, detail: Record<string, unknown> = {}) =>
  console.warn(
    JSON.stringify({ type, ...detail, timestamp: new Date().toISOString() }),
  );

const firstLine = (text: string) =>
  (text.split("\n")[0] ?? "").trim().slice(0, 60);

export function createHeartbeatRunner(deps: HeartbeatRunnerDeps) {
  const now = deps.now ?? (() => new Date());
  const leaseMs = deps.leaseMs ?? 10 * 60_000;

  /** 读这位员工现在的心跳设置，在本人的帧里。 */
  async function settingsOf(agentId: string) {
    return (await deps.store.read(agentId))?.heartbeat;
  }

  /**
   * 下一次醒来排进队列：网格上的下一格；本人在安静时段里，就排到时段结束之后。同一串号同一格是同一条，
   * 几个副本同时排也只有一条。
   */
  async function scheduleNext(
    payload: HeartbeatPayload,
    settings: HeartbeatSettings,
    resting: Date | null,
  ) {
    const grid = nextSlot(now(), settings.intervalMinutes);
    const at = resting && resting.getTime() > grid.getTime() ? resting : grid;
    await deps.store.schedule(
      payload.ownerUserId,
      payload.agentId,
      payload.chain,
      at,
    );
  }

  /** 有事：话写进本人和员工的单聊，通知，看板上留一张卡。 */
  async function speak(
    tenant: string,
    payload: HeartbeatPayload,
    runId: string,
    text: string,
  ) {
    const actor = await deps.actorFor(payload.ownerUserId);
    const channel = await deps.channels.direct(actor, payload.agentId);
    await deps.channels.recordActivity(
      actor,
      channel.id,
      { text, agentId: payload.agentId, at: now() },
      { id: `heartbeat:${runId}` },
    );
    let carded = false;
    if (deps.board)
      try {
        await deps.board.opened({
          tenantId: tenant,
          title: `心跳：${firstLine(text) || "有事"}`,
          executorAgentId: payload.agentId,
          source: "routine",
          triggerSource: "heartbeat",
          channelRef: channel.id,
          runRef: runId,
        });
        carded = true;
      } catch (error) {
        logged("heartbeat-board-open-failed", {
          runId,
          reason: error instanceof Error ? error.name : "UnknownError",
        });
      }
    if (carded)
      await deps.board
        ?.finished({ tenantId: tenant, runRef: runId, failed: false })
        .catch((error: unknown) =>
          logged("heartbeat-board-close-failed", {
            runId,
            reason: error instanceof Error ? error.name : "UnknownError",
          }),
        );
    await deps
      .notify?.(
        {
          ownerUserId: payload.ownerUserId,
          channelId: channel.id,
          agentId: payload.agentId,
          threadId: channel.threadId,
        },
        {
          id: `heartbeat:${runId}`,
          text,
          kind: "reply",
          away: { push: true, chat: true, chatText: text },
        },
      )
      .catch((error: unknown) =>
        logged("heartbeat-notify-failed", {
          runId,
          reason: error instanceof Error ? error.name : "UnknownError",
        }),
      );
  }

  /** 一条队列条目的全部：在本人的帧里，从核对设置到收账。 */
  async function beat(
    tenant: string,
    payload: HeartbeatPayload,
    key: string,
    signal: AbortSignal,
    report: HeartbeatReport,
    /** 这一条是第几次被领出来：大于 1 是上一个领它的进程没做完就没了。 */
    attempt: number,
    /** 下一次排上了（或这一串本该到此为止）：没排上就失败的，这一条要放回去重来，不能收掉。 */
    chain: { settled: boolean },
  ) {
    const skipped = (reason: HeartbeatSkip) =>
      report.skipped.push({ key, reason });
    const settings = await settingsOf(payload.agentId);
    // 关了、删了、或是另一串的（改过间隔、重新打开过）：这一条到此为止，不再接下一次。
    if (!settings?.enabled || settings.chain !== payload.chain) {
      chain.settled = true;
      return skipped("dropped");
    }

    const resting = deps.quietUntil
      ? await deps.quietUntil(payload.ownerUserId).catch(() => null)
      : null;
    // 下一次先排上，这一次出什么事都断不了这一串。
    await scheduleNext(payload, settings, resting);
    chain.settled = true;
    if (resting) return skipped("quiet_hours");
    // 上一个领它的进程做到一半没了：下一次已经排好，这一次不重来（重来可能把模型那一轮做两遍）。
    if (attempt > 1) return skipped("recovered");

    const refusal = await deps.gate?.({
      ownerUserId: payload.ownerUserId,
      agentId: payload.agentId,
    });
    if (refusal) return skipped(refusal);

    // 先看每天的上限，再去认领：超了这一次什么都不做。只认领卡不占名额，但也不能越过上限去认领。
    if (
      (await deps.store.runsToday(payload.ownerUserId, payload.agentId)) >=
      (await deps.dailyRuns(payload.agentId))
    )
      return skipped("capped");

    // 认领看板上派给自己岗位的卡（不用模型）；清单是空的又没有卡可领，这一次就什么都不做、什么都不留。
    const claimed = deps.claimCards
      ? await deps
          .claimCards({
            ownerUserId: payload.ownerUserId,
            agentId: payload.agentId,
          })
          .catch((error: unknown) => {
            logged("heartbeat-claim-failed", {
              reason: error instanceof Error ? error.name : "UnknownError",
            });
            return 0;
          })
      : 0;
    const checklist = settings.checklist.trim();
    if (!checklist && claimed === 0) return skipped("empty");

    const runId = crypto.randomUUID();
    // 只认领了卡、没有叫模型的醒来：记账，但没有线程，不占每天的名额。
    const threadId = checklist ? deps.mintThreadId() : null;
    const admitted = await deps.store.beginRun({
      id: runId,
      ownerUserId: payload.ownerUserId,
      agentId: payload.agentId,
      scheduledFor: new Date(payload.scheduledFor),
      threadId,
      dailyLimit: checklist ? await deps.dailyRuns(payload.agentId) : null,
    });
    if (admitted !== true) return skipped("capped");

    let outcome: "quiet" | "acted" | "failed" = "quiet";
    let error: string | null = null;
    try {
      if (checklist) {
        let reply = "";
        try {
          ({ replyText: reply } = await deps.runTurn({
            ownerUserId: payload.ownerUserId,
            // 本人的租户：领队列的那一边没有自己的租户（见 `TurnRunner`）。
            tenantId: tenant,
            routineId: `heartbeat:${payload.agentId}`,
            agentId: payload.agentId,
            // 不挂在任何对话上的新线程：醒来一次一条，不拖着之前的历史。
            threadId: threadId ?? deps.mintThreadId(),
            instruction: heartbeatInstruction({ checklist, now: now() }),
            userMessage: {
              id: `heartbeat:${runId}`,
              role: "user",
              content: heartbeatInstruction({ checklist, now: now() }),
            },
            initiator: heartbeatInitiator(runId),
            runId,
            signal,
            // 看板上的卡由这里决定开不开：没事的这一次不开。
            cardOwnedByCaller: true,
          }));
        } catch (cause) {
          if (!(cause instanceof EmptyTurnError)) throw cause;
          // 什么也没说就收工，和只回 HEARTBEAT_OK 一样是没事。
          reply = "";
        }
        if (!isHeartbeatQuiet(reply)) {
          await speak(tenant, payload, runId, reply.trim());
          outcome = "acted";
        }
      }
      if (claimed > 0) outcome = "acted";
    } catch (cause) {
      outcome = "failed";
      if (cause instanceof BotPausedError) {
        error = cause.message;
        // 被暂停的员工醒来没做事，不算一次失败的心跳。
        report.skipped.push({ key, reason: "paused" });
        await deps.store.finishRun(runId, {
          outcome: "quiet",
          cardsClaimed: claimed,
        });
        return;
      }
      error =
        cause instanceof HeadlessToolSuspension
          ? cause.message
          : cause instanceof Error
            ? cause.message
            : String(cause);
      // 停下来等人批准的，不算失败：它已经把等的话留在对话里了。
      if (cause instanceof HeadlessToolSuspension) outcome = "acted";
    }
    await deps.store.finishRun(runId, {
      outcome,
      cardsClaimed: claimed,
      error: outcome === "failed" ? error : null,
    });
    report.ran.push({ key, outcome });
  }

  return {
    /** 领一条到点的醒来并做完。没有就是什么都不做。 */
    async sweep(): Promise<HeartbeatReport> {
      const report: HeartbeatReport = { ran: [], skipped: [] };
      const [item] = await deps.queue.claim({
        kind: HEARTBEAT_KIND,
        owner: deps.owner,
        leaseMs,
        limit: 1,
        // 领出来的进程没做完就没了，租约到期后会再被领一次（最多三次）；再领到时只补排下一次，不重做
        // （`attempt` > 1，见 `beat`）。正常失败不靠它：没排上下一次的失败走 `release`，见下面。
        maxAttempts: 3,
      });
      if (!item) return report;
      const finish = () =>
        deps.queue.finish({
          kind: HEARTBEAT_KIND,
          key: item.key,
          owner: deps.owner,
        });
      const payload = item.payload as Partial<HeartbeatPayload>;
      let tenant: string;
      try {
        // 谁的醒来看队列条目上数据库盖的租户，载荷里的本人只许和它一致。
        tenant = assertPersonTenant(item.tenantId, payload.ownerUserId);
        if (!payload.agentId || !payload.chain || !payload.scheduledFor)
          throw new TenantContextError("not a heartbeat");
      } catch (error) {
        if (!(error instanceof TenantContextError)) throw error;
        logged("heartbeat-untrusted-tenant", { key: item.key });
        report.skipped.push({ key: item.key, reason: "dropped" });
        await finish();
        return report;
      }
      const controller = new AbortController();
      const chain = { settled: false };
      const renew = setInterval(() => {
        void deps.queue
          .renew({
            kind: HEARTBEAT_KIND,
            key: item.key,
            owner: deps.owner,
            leaseMs,
          })
          .then(
            (kept) => {
              if (!kept) controller.abort();
            },
            () => controller.abort(),
          );
      }, leaseMs / 3);
      renew.unref?.();
      try {
        await runAsTenant(tenant, () =>
          beat(
            tenant,
            payload as HeartbeatPayload,
            item.key,
            controller.signal,
            report,
            item.attempts,
            chain,
          ),
        );
      } catch (error) {
        logged("heartbeat-run-error", {
          key: item.key,
          reason: error instanceof Error ? error.name : "UnknownError",
        });
      } finally {
        clearInterval(renew);
        if (chain.settled) await finish();
        /*
         * 下一次还没排上就出了错（读设置、排队失败）：这一串不能就此断掉。放回队列、一分钟后重来，不算一次尝试；
         * 放回也失败了，租约到期后同一条会被再领出来（见 `maxAttempts`）。
         */ else
          await deps.queue
            .release({
              kind: HEARTBEAT_KIND,
              key: item.key,
              owner: deps.owner,
              delayMs: 60_000,
              uncounted: true,
              reason: "next beat not scheduled",
            })
            .catch(() => false);
      }
      return report;
    },
    /** 清掉一周前就收了的醒来条目。 */
    reap: () =>
      deps.queue.purge({
        kind: HEARTBEAT_KIND,
        olderThanMs: 7 * 24 * 60 * 60_000,
        maxAttempts: 1,
      }),
  };
}
