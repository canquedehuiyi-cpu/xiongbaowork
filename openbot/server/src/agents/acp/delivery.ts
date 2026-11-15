import { type BaseEvent, EventType } from "@ag-ui/client";
import type { Delivery } from "../../tasks/delivery";
import {
  DEFAULT_TIME_ZONE,
  DELIVERY_EVENTS,
  deliveryProtocol,
} from "../../tasks/delivery-tools";
import { readDueTime } from "../../tasks/due-time";
import {
  attachmentsProduced,
  type DeliveryItem,
  type EvidenceGate,
} from "../../tasks/evidence-gate";
import { roundOnCard } from "../../tasks/turn-cards";
import { emitRunEvent } from "../../threads/run-side-events";
import type { AcpRelay } from "./relay";
import { diffSummary, diffTitle, editedFiles } from "./translate";
import type { AcpTurnStore } from "./turns";

/**
 * The delivery loop's three steps for an external employee (spec 2026-11-15-delivery-loop §9). An
 * external employee runs on its owner's computer and cannot call `accept_task`, `deliver_task` or
 * `request_extension`, so the server walks the steps for it, from what its turns do:
 *
 * - QUEUED (`queued`): the card the turn answers for becomes followed -- 派出 · 待接下 -- as soon as the
 *   turn is in the queue, whether the computer is there or not.
 * - STARTED (`opening`, then `started`): the card's first round is told the four rules before its
 *   prompt (once per card: a later round, a resumed or re-opened session, is not told again), and the
 *   moment its prompt is on the computer the work is taken on: `accepted_at` is then, and the round
 *   hangs on the card (`active_run_ref`), so the checker leaves it alone while it runs and its end is
 *   written there.
 * - 「预计」 (`reported`): the first 「预计 HH:MM」 or 「预计 N 分钟 / 小时」 the employee writes is the
 *   card's due time, read on the person's zone; without one the card is checked two hours after it was
 *   taken on, as for any coworker who gave no time.
 * - ENDED (`ended`): what the turn changed (its `acp.diff`s, summed) and the attachments it produced are
 *   its hand-in, put through the evidence gate with the lines of its reply that start with 「自查」 or
 *   「测试」 as its checks. Passed: 已交成果. Refused: one `bounced` line and the chat's grey line, the
 *   card stays. Nothing to hand in: the card stays in 已接下 · 在做, and the conversation is told so in
 *   one sentence ({@link nothingHandedIn}).
 *
 * Every hook is best effort: a write that fails is logged and the turn goes on, as a board write never
 * holds up somebody's answer.
 */

/** The run of an external employee's turn, as each hook needs it. */
export type AcpDeliveryTurn = {
  tenantId: string;
  agentId: string;
  threadId: string;
  runId: string;
  /** The card the run that queued the turn left open (`acpPromptOf(...).runRef`), when it is another run's. */
  cardRef?: string;
};

export type AcpDelivery = {
  queued(turn: AcpDeliveryTurn): Promise<void>;
  /** Before the prompt goes out: the words to put in front of it, on the card's first round only. */
  opening(turn: AcpDeliveryTurn): Promise<string | undefined>;
  started(turn: AcpDeliveryTurn): Promise<void>;
  /** The employee wrote `due` (the words after 「预计」, `dueSaidIn`). */
  reported(turn: AcpDeliveryTurn, due: string): Promise<void>;
  /**
   * The turn ended as it should (not stopped, failed or cut off): its hand-in, if any. What comes back
   * is a sentence for the conversation, when there is one to say.
   */
  ended(
    turn: AcpDeliveryTurn,
    round: { events: readonly BaseEvent[]; reply: string; name: string },
  ): Promise<string | undefined>;
};

/** Said when an external employee's turn ended with nothing to hand in, its card still being worked on. */
export function nothingHandedIn(name: string): string {
  return `${name}这一轮结束了，但它没交东西：没有改动，也没有附件。这件活还在「已接下 · 在做」，交了成果才会进「已交成果」。`;
}

/** How a reply's self-check lines may be written: at most this many, each at most this long. */
const MOST_CHECKS = 20;
const CHECK_CHARS = 500;

/**
 * The lines of a reply that say how the work was checked: each sentence or line that starts with
 * 「自查」 or 「测试」 (after a list mark), as written.
 */
export function selfChecksOf(reply: string): string[] {
  const checks: string[] = [];
  for (const line of reply.split(/\n+/)) {
    for (const piece of line.split(/(?<=[。！？!?；;])/)) {
      const sentence = piece
        .trim()
        .replace(/^(?:[-*•·]|\d+[.、)）])\s*/, "")
        .trim();
      if (/^(?:自查|测试)/.test(sentence))
        checks.push(Array.from(sentence).slice(0, CHECK_CHARS).join(""));
      if (checks.length >= MOST_CHECKS) return checks;
    }
  }
  return checks;
}

/**
 * What the employee is told before its first prompt on a card: the four rules, word for word, and how
 * the server reads what it writes, since it has no tools to say it with.
 */
export function externalProtocol(): string {
  return `${deliveryProtocol()}\n你没有接活、交付的工具：在回复里写「预计 16:00」或「预计 40 分钟」就是报预计时间；做完的改动会自动当作交付物，用「自查：」开头的一句写你怎么查过的。`;
}

export function createAcpDelivery(options: {
  delivery: Delivery;
  gate: EvidenceGate;
  /** The person's zone (`readWorkHours`), for 「预计 16:00」. */
  timeZone?: (tenantId: string) => Promise<string>;
  now?: () => Date;
  /** Where the chat's cards go: the run's own stream (`emitRunEvent`) by default. */
  emit?: (runId: string, event: BaseEvent) => void;
  log?: (message: string) => void;
}): AcpDelivery {
  const { delivery, gate } = options;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? ((message: string) => console.warn(message));
  const emit =
    options.emit ??
    ((runId: string, event: BaseEvent) => {
      emitRunEvent(runId, event);
    });
  const said = (runId: string, name: string, value: Record<string, unknown>) =>
    emit(runId, { type: EventType.CUSTOM, name, value } as BaseEvent);
  const actor = (turn: AcpDeliveryTurn) => `agent:${turn.agentId}` as const;
  const cardOf = (turn: AcpDeliveryTurn) =>
    delivery.cardOfExternalTurn(turn.tenantId, {
      runId: turn.runId,
      agentId: turn.agentId,
      threadId: turn.threadId,
      ...(turn.cardRef ? { cardRef: turn.cardRef } : {}),
    });
  /** A hook that fails says so and changes nothing more: the turn goes on. */
  const guarded =
    <A extends unknown[], R>(
      what: string,
      fallback: R,
      body: (...args: A) => Promise<R>,
    ) =>
    async (...args: A): Promise<R> => {
      try {
        return await body(...args);
      } catch (error) {
        log(
          `acp delivery: ${what} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return fallback;
      }
    };

  return {
    queued: guarded("queued", undefined, async (turn: AcpDeliveryTurn) => {
      const card = await cardOf(turn);
      if (!card || card.tracked) return;
      await delivery.markTracked(turn.tenantId, card.id, "system", {
        threadRef: turn.threadId,
      });
    }),

    opening: guarded(
      "opening",
      undefined as string | undefined,
      async (turn: AcpDeliveryTurn) => {
        const card = await cardOf(turn);
        return card?.tracked && card.acceptedAt === null
          ? externalProtocol()
          : undefined;
      },
    ),

    started: guarded("started", undefined, async (turn: AcpDeliveryTurn) => {
      const card = await cardOf(turn);
      if (!card?.tracked) return;
      if (card.acceptedAt === null) {
        const accepted = await delivery.accept(turn.tenantId, card.id, {
          runId: turn.runId,
          threadRef: turn.threadId,
          actor: actor(turn),
          dueAt: null,
        });
        if (accepted)
          said(turn.runId, DELIVERY_EVENTS.accepted, {
            taskId: card.id,
            dueAt: accepted.dueAt?.toISOString() ?? null,
            criteria: accepted.criteria,
          });
      } else await delivery.attachRun(turn.tenantId, card.id, turn.runId);
      // This round is the card's: its end is written there when the turn ends (`endTurn`).
      roundOnCard(turn.runId, turn.tenantId, card.id);
    }),

    reported: guarded(
      "reported",
      undefined,
      async (turn: AcpDeliveryTurn, due: string) => {
        const card = await cardOf(turn);
        if (!card?.tracked || !card.acceptedAt || card.dueReported) return;
        const timeZone =
          (await options.timeZone?.(turn.tenantId).catch(() => undefined)) ??
          DEFAULT_TIME_ZONE;
        const reading = readDueTime(due, now(), timeZone);
        if (reading.at === null) return;
        await delivery.reportDue(turn.tenantId, card.id, { dueAt: reading.at });
      },
    ),

    ended: guarded(
      "ended",
      undefined as string | undefined,
      async (
        turn: AcpDeliveryTurn,
        round: { events: readonly BaseEvent[]; reply: string; name: string },
      ) => {
        const card = await cardOf(turn);
        if (!card?.tracked || !card.acceptedAt) return undefined;
        // Waiting on the person (an approval, a question): their answer comes first.
        if (card.status === "needs_action") return undefined;
        const items: DeliveryItem[] = [];
        const files = editedFiles(round.events);
        if (files.length > 0)
          items.push({
            kind: "diff",
            ref: turn.runId,
            title: diffTitle(diffSummary(files)),
          });
        for (const id of attachmentsProduced(round.events))
          items.push({ kind: "attachment", ref: id });
        if (items.length === 0)
          // Already handed in: a follow-up with nothing new is not 「没交东西」.
          return card.status === "running"
            ? nothingHandedIn(round.name)
            : undefined;
        const verdict = await gate.checkEvidence({
          tenantId: turn.tenantId,
          taskId: card.id,
          threadRef: card.threadRef,
          items,
          checks: selfChecksOf(round.reply),
          criteria: card.criteria,
          externalRun: turn.runId,
        });
        if (!verdict.ok) {
          await delivery.bounced(turn.tenantId, card.id, {
            runId: turn.runId,
            actor: actor(turn),
            reason: verdict.reason,
            ...(verdict.missing ? { missing: verdict.missing } : {}),
          });
          said(turn.runId, DELIVERY_EVENTS.bounced, {
            taskId: card.id,
            reason: verdict.reason,
          });
          return undefined;
        }
        const merged = await delivery.delivered(turn.tenantId, card.id, {
          runId: turn.runId,
          agentId: turn.agentId,
          actor: actor(turn),
          deliverable: verdict.ref,
        });
        if (merged)
          said(turn.runId, DELIVERY_EVENTS.delivered, {
            taskId: card.id,
            deliverable: verdict.ref,
          });
        return undefined;
      },
    ),
  };
}

/**
 * 取消 reaches an external employee's turns too (spec §6: 外部员工排队或进行中的轮次一并取消): every turn of
 * the employee on the card's thread that is not over -- queued, on the computer, waiting for an answer
 * -- is cancelled through the relay's own stop (`cancelTurn`), as its hirer's stop would. What
 * `createCardTurns`'s `cancelExternalTurn` is given.
 */
export function cancelExternalTurns(deps: {
  turns: Pick<AcpTurnStore, "openInThread">;
  relay: Pick<AcpRelay, "cancelTurn">;
}): (
  tenantId: string,
  turn: { threadId: string; agentId: string },
) => Promise<void> {
  return async (tenantId, turn) => {
    const open = await deps.turns.openInThread(
      tenantId,
      turn.threadId,
      turn.agentId,
    );
    for (const row of open) await deps.relay.cancelTurn(tenantId, row.turnId);
  };
}
