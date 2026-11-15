import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { Database } from "../db/client";
import { tasks } from "../db/schema";
import { runAsTenant } from "../tenant/context";
import {
  type CardTurns,
  type CardTurnsDeps,
  startThreadTurn,
  ThreadBusy,
} from "./card-turns";
import { createDelivery, type Delivery } from "./delivery";
import { nudgeTextOf } from "./delivery-checker";
import type { TaskEventActor } from "./events";
import type { DeliverableRef } from "./projector";

/**
 * The rounds the server itself starts on a followed card (spec 2026-11-15-delivery-loop §8): the
 * checker's nudge, the person's 再催, and the hand-over to a new coworker (换人接手).
 *
 * A NUDGE ROUND IS NOT A WAKE-UP. A coworker's own follow-up (`agents/wake-up.ts`) pushes its reply to
 * the person as `kind: "reply"`, opens a card of its own, counts against the coworker's twenty a day
 * and five at once, and charges the month. A nudge round does none of that: it is one turn on the
 * card's own thread, in the server's voice (a `routine` initiator named after the card, the message
 * marked 【系统催办】), started for THIS card (`turnForCard`) -- so the runner hangs it on the card
 * like any later round, opening no card and asking no quota (`threads/postgres-runner.ts`). Nothing
 * here pushes anything. The model's usage is metered as for every headless turn.
 *
 * A thread with a turn already running is never nudged: the runner would supersede that turn.
 *
 * A group card's thread is the coworker's thread with this person inside the group
 * (`group_bot_threads`); its round runs on that thread directly, so the coworker's answer is on the
 * card (its progress, its hand-in) but not posted to the group's transcript.
 */
export type NudgeRuns = {
  /**
   * Start one round on the card's thread with `text`, as the server: `started` once the turn is
   * running, `skipped_running` when the thread is busy (nothing was said). Throws a `CardTurnRefused`
   * when the turn was refused for another reason (the coworker paused, the model not allowed), and an
   * error when the card is not followed and open.
   */
  startNudgeRun(
    tenantId: string,
    taskId: string,
    text: string,
  ): Promise<"started" | "skipped_running">;
  /**
   * 再催: nudge the card's coworker now, as the person asked. The round started: `nudges + 1` and a
   * `nudged` line in the person's name. Refused when the card is not with its coworker (`running`),
   * or a round is running on it already.
   */
  nudgeNow(
    tenantId: string,
    taskId: string,
    input: { actor: TaskEventActor; now: Date; timeZone: string },
  ): Promise<
    | { ok: true; nudges: number }
    | { ok: false; why: "not_nudgeable" | "running" }
    | { ok: false; why: "refused"; message: string }
  >;
  /**
   * 换人接手: the card goes to `agentId` on its thread with the person and back to 派出 · 待接下
   * (`tasks/delivery.ts` `reassign`); the round the old coworker had running on it is stopped; and
   * the new coworker is handed the work -- its title, criteria, what was handed in so far and the old
   * coworker's latest progress -- in a round on its thread, which asks it for its own 接活回执.
   * `started` says whether that round began (a busy or paused coworker is nudged by the checker later).
   */
  reassignTask(
    tenantId: string,
    taskId: string,
    agentId: string,
    actor: TaskEventActor,
  ): Promise<
    | { ok: true; threadRef: string; started: boolean }
    | {
        ok: false;
        why: "no_coworker" | "not_open" | "handed_in" | "same_coworker";
      }
  >;
};

export type NudgeRunsDeps = Pick<
  CardTurnsDeps,
  "runTurn" | "runner" | "startTimeoutMs"
> & {
  database: Database;
  delivery?: Delivery;
  /** Stopping the old coworker's round on a hand-over (`createCardTurns(...).stopRound`). */
  turns?: Pick<CardTurns, "stopRound">;
  /**
   * The person's thread with a coworker they can use, for a hand-over; null when the coworker is not
   * theirs to use. Without it nothing can be handed over.
   */
  coworkerThread?: (
    tenantId: string,
    agentId: string,
  ) => Promise<string | null>;
};

/** Why a card cannot be nudged: it is not followed and open, or names no thread or coworker. */
export class NotNudgeable extends Error {
  constructor() {
    super("这件活不在跟、已经结束，或没有可以催的员工。");
    this.name = "NotNudgeable";
  }
}

const log = (type: string, detail: Record<string, unknown>) =>
  console.error(JSON.stringify({ type, ...detail }));

const reasonOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** What the new coworker is told on a hand-over. */
function handoverText(card: {
  title: string;
  criteria: string | null;
  deliverable: DeliverableRef | null;
  progress: string | null;
}): string {
  const handedIn = card.deliverable
    ? [
        ...(card.deliverable.notes ?? []).map((note) => `结论：${note}`),
        ...(card.deliverable.links ?? []).map(
          (link) => `链接：${link.title ? `${link.title} ` : ""}${link.url}`,
        ),
        ...(card.deliverable.attachments ?? []).map((id) => `附件 ${id}`),
        ...(card.deliverable.components ?? []).map(
          (component) => `组件 ${component.name}`,
        ),
        ...(card.deliverable.checks ?? []).map((check) => `自查：${check}`),
      ]
    : [];
  return [
    `【系统转交】这件活从另一位员工那里转给你：『${card.title}』。`,
    `验收标准：${card.criteria ?? "（没写）"}`,
    handedIn.length
      ? `已经交过的：${handedIn.join("；")}`
      : "已经交过的：还没有",
    `上一位员工最后的进度：${card.progress ?? "（没有记录）"}`,
    "先调用 accept_task 接下（预计几点交、验收标准），再接着做。",
  ].join("\n");
}

export function createNudgeRuns(deps: NudgeRunsDeps): NudgeRuns {
  const delivery = deps.delivery ?? createDelivery(deps.database);

  const startNudgeRun: NudgeRuns["startNudgeRun"] = async (
    tenantId,
    taskId,
    text,
  ) => {
    const [card] = await runAsTenant(tenantId, () =>
      deps.database
        .select({ threadRef: tasks.threadRef, agentId: tasks.executorAgentId })
        .from(tasks)
        .where(
          and(
            eq(tasks.tenantId, tenantId),
            eq(tasks.id, taskId),
            eq(tasks.tracked, true),
            inArray(tasks.status, ["running", "needs_action"]),
            isNotNull(tasks.threadRef),
            isNotNull(tasks.executorAgentId),
          ),
        )
        .limit(1),
    );
    if (!card?.threadRef || !card.agentId) throw new NotNudgeable();
    try {
      await startThreadTurn(
        deps,
        tenantId,
        { threadId: card.threadRef, agentId: card.agentId },
        text,
        {
          source: `task-nudge:${taskId}`,
          taskId,
          initiator: { kind: "routine", id: `task-nudge:${taskId}` },
          telemetry: { trigger: "routine", rootTaskId: `task-nudge:${taskId}` },
          messagePrefix: "task-nudge",
        },
      );
      return "started";
    } catch (error) {
      if (error instanceof ThreadBusy) return "skipped_running";
      throw error;
    }
  };

  return {
    startNudgeRun,

    async nudgeNow(tenantId, taskId, input) {
      const [card] = await runAsTenant(tenantId, () =>
        deps.database
          .select({
            title: tasks.title,
            acceptedAt: tasks.acceptedAt,
            dueAt: tasks.dueAt,
            createdAt: tasks.createdAt,
          })
          .from(tasks)
          .where(
            and(
              eq(tasks.tenantId, tenantId),
              eq(tasks.id, taskId),
              eq(tasks.tracked, true),
              eq(tasks.status, "running"),
            ),
          )
          .limit(1),
      );
      if (!card) return { ok: false, why: "not_nudgeable" };
      const text = nudgeTextOf(card, input.now, input.timeZone);
      let outcome: "started" | "skipped_running";
      try {
        outcome = await startNudgeRun(tenantId, taskId, text);
      } catch (error) {
        if (error instanceof NotNudgeable)
          return { ok: false, why: "not_nudgeable" };
        return { ok: false, why: "refused", message: reasonOf(error) };
      }
      if (outcome === "skipped_running") return { ok: false, why: "running" };
      const nudged = await delivery.nudged(tenantId, taskId, {
        actor: input.actor,
        text,
        at: input.now,
      });
      return { ok: true, nudges: nudged?.nudges ?? 0 };
    },

    async reassignTask(tenantId, taskId, agentId, actor) {
      const threadRef = deps.coworkerThread
        ? await runAsTenant(tenantId, () =>
            // biome-ignore lint/style/noNonNullAssertion: checked above
            deps.coworkerThread!(tenantId, agentId),
          )
        : null;
      if (!threadRef) return { ok: false, why: "no_coworker" };
      const moved = await delivery.reassign(tenantId, taskId, {
        agentId,
        threadRef,
        actor,
      });
      if (!moved.ok) return moved;
      // The old coworker's round is over: it is stopped, and its late hand-in is refused by the card.
      if (moved.previous.threadRef)
        await deps.turns?.stopRound(tenantId, {
          threadId: moved.previous.threadRef,
          agentId: moved.previous.agentId,
          runId: moved.previous.runId,
        });
      let started = false;
      try {
        started =
          (await startNudgeRun(tenantId, taskId, handoverText(moved))) ===
          "started";
      } catch (error) {
        // Handed over all the same: the checker nudges the new coworker five minutes on.
        log("task-reassign-handover-not-started", {
          taskId,
          reason: reasonOf(error),
        });
      }
      return { ok: true, threadRef, started };
    },
  };
}
