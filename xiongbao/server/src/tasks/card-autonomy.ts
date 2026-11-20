/**
 * 领到卡之后的事：把它变成一张跟着走的看板卡，让员工开工（期 3·3.3）。
 *
 * 领卡本身在 `claim.ts`（原子、按岗位、有并行上限）。这里接着做：
 *  1. 在看板上开一张卡（`opened`，执行人是这位员工，挂在本人和它的单聊上）；
 *  2. 把它当作一件活来跟（`delivery.track`）：派出 → 已接下 → 已交成果 → 验收，沿用现有的交付和验收闭环；
 *  3. 在单聊线程上起一轮，把卡的内容告诉员工（`startNudgeRun`，和送达核对器催办用的是同一个入口，这一轮是服务器
 *     起的，不是本人的单聊，不会被当成单聊去抽记忆）。起不来（线程忙、出错）不算失败：卡已经在跟了，送达核对器
 *     发现员工没接下，会按它的规矩催。
 *
 * 两处会调它：心跳醒来时（`heartbeat/runner.ts` 的 `claimCards`），和一张新卡放进来时（踢一下同岗位开了心跳的员工）。
 * 受安静时段管：安静时段里只领紧急的卡，别的留到心跳在时段结束后醒来再领。
 */
import type { TaskProjector } from "../tasks/projector";
import { runAsTenant } from "../tenant/context";
import type { QuietUntil } from "../user-preferences";
import type { Delivery } from "./delivery";
import type { NudgeRuns } from "./nudge-run";
import {
  type BoardCard,
  type BoardCardsStore,
  cardAsk,
  cardAutoclaimOn,
  maxParallelCards,
} from "./claim";
import type { AgentChannel } from "../channels/routes";
import type { AgentActor } from "../agents/profile-types";

const logged = (type: string, detail: Record<string, unknown> = {}) =>
  console.warn(
    JSON.stringify({ type, ...detail, timestamp: new Date().toISOString() }),
  );

export function createCardAutonomy(deps: {
  cards: BoardCardsStore;
  board: Pick<TaskProjector, "opened">;
  delivery: Pick<Delivery, "track">;
  rounds: Pick<NudgeRuns, "startNudgeRun">;
  actorFor: (ownerUserId: string) => Promise<AgentActor>;
  channels: {
    direct(actor: AgentActor, agentId: string): Promise<AgentChannel>;
  };
  /** 这位员工现在能不能自己接活：不是外部员工、没被暂停、没关 `accept_task`。没有就都能。 */
  canClaim?: (ownerUserId: string, agentId: string) => Promise<boolean>;
  quietUntil?: QuietUntil;
  /**
   * 新卡踢员工之前的几道关，不用模型：本人关了主动检查、管理员关了、员工被暂停、本月额度用完。和心跳醒来用的是同一套
   * （`heartbeat/runner.ts` 的 `gate`），答非空就是不踢。没有就不拦。
   */
  gate?: (input: {
    ownerUserId: string;
    agentId: string;
  }) => Promise<string | null>;
  /** 整个功能的开关，默认看 `XIONGBAO_CARD_AUTOCLAIM`。 */
  enabled?: () => boolean;
  maxParallel?: () => number;
}) {
  const enabled = deps.enabled ?? (() => cardAutoclaimOn());
  const maxParallel = deps.maxParallel ?? (() => maxParallelCards());

  /** 一张领到的卡：开卡、跟着走、起一轮。开不出卡就放回去。 */
  async function start(ownerUserId: string, card: BoardCard): Promise<void> {
    const agentId = card.claimedBy;
    if (!agentId) return;
    let taskId: string;
    try {
      const actor = await deps.actorFor(ownerUserId);
      const channel = await deps.channels.direct(actor, agentId);
      taskId = await deps.board.opened({
        tenantId: ownerUserId,
        title: card.title,
        executorAgentId: agentId,
        source: "routine",
        triggerSource: "board_claim",
        channelRef: channel.id,
        runRef: `board-card:${card.id}`,
      });
    } catch (error) {
      // 没有开出看板卡（比如本月额度用完）：什么都没发生过，放回去。
      await deps.cards.release(card.id);
      throw error;
    }
    try {
      await deps.cards.markStarted(card.id, taskId);
      await deps.delivery.track(ownerUserId, taskId, "system");
    } catch (error) {
      // 看板卡开出来了却没跟起来：这张卡放回去，别卡在「已领」。
      await deps.cards.release(card.id, { clearTask: true }).catch(() => undefined);
      throw error;
    }
    try {
      await deps.rounds.startNudgeRun(ownerUserId, taskId, cardAsk(card));
    } catch (error) {
      logged("board-card-round-not-started", {
        cardId: card.id,
        reason: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }

  return {
    /**
     * 这位员工能领几张就领几张（到并行上限为止）并开工，答领了几张。在本人的帧里做。
     * `onlyUrgent`：安静时段里用，只领紧急的卡。
     */
    async claimAndStart(
      ownerUserId: string,
      agentId: string,
      options: { onlyUrgent?: boolean } = {},
    ): Promise<number> {
      if (!enabled()) return 0;
      return runAsTenant(ownerUserId, async () => {
        if ((await deps.canClaim?.(ownerUserId, agentId)) === false) return 0;
        // 先把卡死在「已领」的放回去，再领。
        await deps.cards.recoverStale().catch((error: unknown) =>
          logged("board-card-recover-failed", {
            reason: error instanceof Error ? error.name : "UnknownError",
          }),
        );
        let started = 0;
        for (let round = 0; round < maxParallel(); round += 1) {
          const card = await deps.cards.claimNextCard(agentId, options);
          if (!card) break;
          try {
            await start(ownerUserId, card);
            started += 1;
          } catch (error) {
            logged("board-card-start-failed", {
              cardId: card.id,
              reason: error instanceof Error ? error.name : "UnknownError",
            });
            break;
          }
        }
        return started;
      });
    },

    /**
     * 一张新卡放进来：同岗位开了心跳的员工现在就去看一眼，不等下一次醒来。安静时段里只踢紧急的卡。
     * 答一共领了几张。
     */
    async kick(
      ownerUserId: string,
      card: Pick<BoardCard, "role" | "urgent">,
    ): Promise<number> {
      if (!enabled()) return 0;
      /*
       * 先不看紧急标记，只问现在是不是安静时段。在里面：普通卡不踢，留给时段结束后的心跳；紧急卡才踢，而且领的时候只领
       * 紧急的（`onlyUrgent`），不然这一踢会把排在前面的普通卡一起带走。
       */
      const resting = deps.quietUntil
        ? await deps.quietUntil(ownerUserId).catch(() => null)
        : null;
      if (resting && !card.urgent) return 0;
      const employees = await runAsTenant(ownerUserId, () =>
        deps.cards.heartbeatEmployees(card.role),
      );
      let started = 0;
      for (const employee of employees) {
        if (await deps.gate?.({ ownerUserId, agentId: employee })) continue;
        started += await this.claimAndStart(ownerUserId, employee, {
          ...(resting ? { onlyUrgent: true } : {}),
        });
      }
      return started;
    },
  };
}
