import { randomUUID } from "node:crypto";
import { type BaseEvent, EventType } from "@ag-ui/client";
import type { Delivery } from "../../tasks/delivery";
import {
  DEFAULT_TIME_ZONE,
  DELIVERY_EVENTS,
  deliveryProtocol,
  EXTERNAL_DELIVERY_GUIDE,
} from "../../tasks/delivery-tools";
import { diffSummary, diffTitle, editedFiles } from "../../tasks/diff-summary";
import { readDueTime } from "../../tasks/due-time";
import {
  attachmentsProduced,
  type DeliveryItem,
  type EvidenceGate,
} from "../../tasks/evidence-gate";
import { roundOnCard } from "../../tasks/turn-cards";
import { emitRunEvent } from "../../threads/run-side-events";
import type { AcpRelay } from "./relay";
import type { AcpTurnStore } from "./turns";

/**
 * The delivery loop's three steps for an external employee (spec 2026-11-15-delivery-loop §9). An
 * external employee runs on its owner's computer and cannot call `accept_task`, `deliver_task` or
 * `request_extension`, so the server walks the steps for it, from what its turns do:
 *
 * - QUEUED (`queued`): when the turn is work handed to the employee (派活), the card it answers for
 *   becomes followed -- 派出 · 待接下 -- as soon as the turn is in the queue, whether the computer is
 *   there or not. Work is handed to it in three ways, as to any coworker (spec §1): asked of it in a
 *   group (`createAcpGroupTurn`, a peer's 转交 excepted), handed to it with `@` in another
 *   conversation (`POST /api/channels/:id/dispatch`, whose run is in the dispatch ledger:
 *   `dispatched`), or followed by the person (`POST /api/tasks/:id/track`, which follows the card
 *   itself). A question asked in its own conversation is not work handed to it: the card stays a
 *   conversation's card, nothing below touches it (every later hook asks for a followed card), and
 *   it is neither told the rules, nor 「它没交东西」, nor nudged, nor recorded overdue. A later turn of
 *   a thread whose followed card is still open hangs on that card (一件活一张卡), as for any coworker.
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

/**
 * Where a turn was queued from: a group (`group`: work asked of the employee there, followed) or its
 * own conversation (`conversation`: followed only when the run is a 派活's).
 */
export type AcpQueuedFrom = "group" | "conversation";

export type AcpDelivery = {
  queued(turn: AcpDeliveryTurn, from: AcpQueuedFrom): Promise<void>;
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

/** How long a written conclusion handed in as a note may be. */
const CONCLUSION_CHARS = 2000;

/** What marks a written conclusion as one handed in (`EXTERNAL_DELIVERY_GUIDE`): a line that starts so. */
const CONCLUSION_MARK = /^(?:[-*•·]\s*)?(?:结论|交付)\s*[：:]\s*/;
/** Words that say the work is not done: a reply with them is not a hand-in, whatever else it says. */
const NOT_DONE = /交不了|做不完|没做完/;

/**
 * The conclusion a words-only reply hands in, or undefined when it hands in none (规约第 2 条, for work
 * with nothing to change). Only an explicit one: a line starting 「结论：」 (or 「交付：」), as the guide
 * asks, with what follows it up to the first self-check line -- and never in a reply that says the work
 * is not done or asks for more time (「交不了」「延到 …」), which is a 延期申请 or a progress report, not a
 * delivery. Without the mark a reply is an answer or a progress line, even with a 「自查：」 in it.
 *
 * Only this section is the note, so the criteria's 必需 items are matched against the conclusion and the
 * check lines, not against everything the reply said on the way.
 */
export function conclusionOf(reply: string): string | undefined {
  if (NOT_DONE.test(reply) || extensionSaidIn(reply)) return undefined;
  const lines = reply.split(/\n+/).map((line) => line.trim());
  const start = lines.findIndex((line) => CONCLUSION_MARK.test(line));
  if (start < 0) return undefined;
  const section: string[] = [];
  for (const [index, line] of lines.slice(start).entries()) {
    const text = (
      index === 0 ? line.replace(CONCLUSION_MARK, "") : line
    ).trim();
    // The self-checks are its checks, not its conclusion: the section ends where they start.
    const cut = text.search(/(?:自查|测试)\s*[：:]/);
    if (cut === 0) break;
    if (cut > 0) {
      section.push(text.slice(0, cut).trim());
      break;
    }
    if (text) section.push(text);
  }
  const conclusion = section.join("\n").trim();
  return conclusion
    ? Array.from(conclusion).slice(0, CONCLUSION_CHARS).join("")
    : undefined;
}

/** How long the reason of a 延期申请 read from a reply may be. */
const REASON_CHARS = 500;

/**
 * A request for more time in a reply (规约第 3 条): 「延到 18:00」「延期到明早 10 点」「推迟到 17:30」, with
 * the sentence it is in as the reason. The time is the longest start of what follows that reads as one
 * (`readDueTime` decides); undefined when there is none.
 */
export function extensionSaidIn(
  reply: string,
): { due: string; reason: string } | undefined {
  /*
   * Its own request only: 「延到」 at the start of a clause or after 要 / 申请 / 想 / 得 / 请 -- not
   * 「蔓延到」「顺延到」, nor a change it describes (「把超时延到 30 分钟」).
   */
  const asked =
    /(?:^|[^\u4e00-\u9fff]|要|申请|想|得|请)(?:延期?到|延后到|推迟到)\s*([^，,。；;！!？?\n）)」]{1,20})/.exec(
      reply,
    );
  if (!asked?.[1]) return undefined;
  const words = asked[1].trim();
  const probe = new Date();
  let due: string | undefined;
  for (let end = words.length; end > 0 && !due; end -= 1) {
    const candidate = words.slice(0, end).trim();
    const reading = readDueTime(candidate, probe, DEFAULT_TIME_ZONE);
    if (reading.at !== null || reading.why !== "unreadable") due = candidate;
  }
  if (!due) return undefined;
  const before = reply.slice(0, asked.index);
  const start =
    Math.max(
      before.lastIndexOf("。"),
      before.lastIndexOf("！"),
      before.lastIndexOf("？"),
      before.lastIndexOf("\n"),
    ) + 1;
  const after = reply.slice(asked.index);
  const stop = after.search(/[。！？\n]/);
  const sentence = reply
    .slice(start, stop < 0 ? undefined : asked.index + stop)
    .trim();
  return {
    due,
    reason: Array.from(sentence).slice(0, REASON_CHARS).join(""),
  };
}

/**
 * What the employee is told before its first prompt on a card: the four rules, word for word, and how
 * the server reads what it writes, since it has no tools to say it with.
 */
export function externalProtocol(): string {
  return `${deliveryProtocol()}\n${EXTERNAL_DELIVERY_GUIDE}`;
}

export function createAcpDelivery(options: {
  delivery: Delivery;
  gate: EvidenceGate;
  /**
   * Whether the run is a 派活's (`channelDispatched`): work handed to the employee with `@` in another
   * conversation, which the loop follows. Absent: no run queued from a conversation is one.
   */
  dispatched?: (tenantId: string, runId: string) => Promise<boolean>;
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

  /** A 「延到 …」 in the reply, as a 延期申请 on the card: true when one was filed. */
  async function askedForMoreTime(
    turn: AcpDeliveryTurn,
    taskId: string,
    reply: string,
  ): Promise<boolean> {
    const asked = extensionSaidIn(reply);
    if (!asked) return false;
    const timeZone =
      (await options.timeZone?.(turn.tenantId).catch(() => undefined)) ??
      DEFAULT_TIME_ZONE;
    const reading = readDueTime(asked.due, now(), timeZone);
    if (reading.at === null) return false;
    const askedLine = randomUUID();
    const filed = await delivery.requestExtension(turn.tenantId, taskId, {
      eventId: askedLine,
      dueAt: reading.at,
      reason: asked.reason,
      runId: turn.runId,
      actor: actor(turn),
    });
    if (filed)
      said(turn.runId, DELIVERY_EVENTS.extensionRequested, {
        taskId,
        eventId: askedLine,
        dueAt: reading.at.toISOString(),
        reason: asked.reason,
      });
    return filed;
  }

  return {
    queued: guarded(
      "queued",
      undefined,
      async (turn: AcpDeliveryTurn, from: AcpQueuedFrom) => {
        const card = await cardOf(turn);
        if (!card || card.tracked) return;
        // A question in its own conversation is not work handed to it: only a 派活's run is.
        if (
          from === "conversation" &&
          !(await options.dispatched?.(
            turn.tenantId,
            turn.cardRef ?? turn.runId,
          ))
        )
          return;
        await delivery.markTracked(turn.tenantId, card.id, "system", {
          threadRef: turn.threadId,
        });
      },
    ),

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
        const acceptedLine = randomUUID();
        const accepted = await delivery.accept(turn.tenantId, card.id, {
          eventId: acceptedLine,
          runId: turn.runId,
          threadRef: turn.threadId,
          actor: actor(turn),
          dueAt: null,
        });
        if (accepted)
          said(turn.runId, DELIVERY_EVENTS.accepted, {
            taskId: card.id,
            eventId: acceptedLine,
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
        const checks = selfChecksOf(round.reply);
        if (items.length === 0) {
          // Already handed in: a follow-up with nothing new is not 「没交东西」.
          if (card.status !== "running") return undefined;
          // 交不了就说：「延到 HH:MM」 is its 延期申请 first, which the person grants or not.
          if (await askedForMoreTime(turn, card.id, round.reply))
            return undefined;
          /*
           * Work with nothing to change (a question answered, something looked up) is handed in as its
           * written conclusion: an explicit 「结论：」 with a 「自查：」 line saying how it was checked,
           * what the gate asks of any words-only hand-in. Anything less is an answer or a progress line.
           */
          const conclusion = checks.some((check) => check.startsWith("自查"))
            ? conclusionOf(round.reply)
            : undefined;
          if (!conclusion) return nothingHandedIn(round.name);
          items.push({ kind: "note", ref: conclusion });
        }
        const verdict = await gate.checkEvidence({
          tenantId: turn.tenantId,
          taskId: card.id,
          threadRef: card.threadRef,
          items,
          checks,
          criteria: card.criteria,
          externalRun: turn.runId,
        });
        if (!verdict.ok) {
          const bouncedLine = randomUUID();
          await delivery.bounced(turn.tenantId, card.id, {
            eventId: bouncedLine,
            runId: turn.runId,
            actor: actor(turn),
            reason: verdict.reason,
            ...(verdict.missing ? { missing: verdict.missing } : {}),
          });
          said(turn.runId, DELIVERY_EVENTS.bounced, {
            taskId: card.id,
            eventId: bouncedLine,
            reason: verdict.reason,
          });
          return undefined;
        }
        const deliveredLine = randomUUID();
        const merged = await delivery.delivered(turn.tenantId, card.id, {
          eventId: deliveredLine,
          runId: turn.runId,
          agentId: turn.agentId,
          actor: actor(turn),
          deliverable: verdict.ref,
        });
        if (merged)
          said(turn.runId, DELIVERY_EVENTS.delivered, {
            taskId: card.id,
            eventId: deliveredLine,
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

/**
 * Whether an external employee's turn on a thread is still waiting to run, and whether its computer is
 * away (the delivery checker's `turnQueued`): any turn of the thread that is not over, asked once the
 * runner has said no run is open there -- so it is queued, or on a computer no run of this server
 * follows. Null when none waits.
 */
export function externalTurnWaiting(deps: {
  turns: Pick<AcpTurnStore, "openInThread">;
  /** Whether the computer can be reached at all: connected here, or online on another server. */
  reachable: (target: {
    tenantId: string;
    deviceId: string;
  }) => Promise<boolean>;
}): (
  tenantId: string,
  threadId: string,
) => Promise<{ offline: boolean } | null> {
  return async (tenantId, threadId) => {
    const [waiting] = await deps.turns.openInThread(tenantId, threadId);
    if (!waiting) return null;
    const online = await deps
      .reachable({ tenantId, deviceId: waiting.deviceId })
      .catch(() => false);
    return { offline: !online };
  };
}
