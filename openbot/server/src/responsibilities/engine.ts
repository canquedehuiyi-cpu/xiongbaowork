import { HeadlessToolSuspension } from "@openbot/toolkit/headless-tools";
import { QuotaExceeded, type QuotaService } from "../quota/limits";
import {
  type DeliverableComponent,
  deliverableRefOf,
  type TaskProjector,
} from "../tasks/projector";
import { runAsTenant } from "../tenant/context";
import { isThreadBusy } from "@openbot/toolkit/lease";
import { BOT_PAUSED_REASON, isBotPaused } from "../agents/lifecycle";
import type { WorkQueue } from "../work/queue";
import type { ResponsibilityRunContext, ResponsibilityStore } from "./types";

export const RESPONSIBILITY_RUN_KIND = "responsibility.run";
export type RunResponsibilityTurn = (
  input: ResponsibilityRunContext & {
    signal: AbortSignal;
    /** See `TurnRunner`'s `cardOwnedByCaller` — the engine files the run's card itself. */
    cardOwnedByCaller?: boolean;
  },
) => Promise<{
  replyText: string;
  /** What the turn drew and handed over, for the board's 查收 (spec A9). */
  components?: DeliverableComponent[];
  attachments?: string[];
}>;
export type ResponsibilityDispatchReport = {
  succeeded: string[];
  waiting: string[];
  skipped: string[];
  /** Put back to wait for a conversation another run was using. Nothing ran. */
  busy: string[];
  failed: { runId: string; error: string }[];
};

/**
 * How long a run waits for a conversation another run is using: `firstMs`, doubling, never more than
 * `maxMs` between tries, for at most `tries` tries before the run fails.
 *
 * FOUND LIVE: "Create a goal … then run it now" in one message started the goal's run while the Bot
 * was still answering in that conversation. Intelligence refused the run's lock with 409
 * `THREAD_LOCK_FAILED`, marked retryable, and the run was recorded as failed with the platform's
 * response body as its reason. The defaults wait about nine minutes in all: far longer than a
 * Bot's answer, and short enough that a goal stuck behind something else says so the same day.
 */
export type BusyRetry = { firstMs: number; maxMs: number; tries: number };
export const BUSY_RETRY: BusyRetry = {
  firstMs: 5_000,
  maxMs: 60_000,
  tries: 12,
};

/** The longest a run waits in all, in whole minutes, for the sentence that says it gave up. */
function waitedFor({ firstMs, maxMs, tries }: BusyRetry): string {
  let total = 0;
  for (let index = 0; index < tries; index += 1)
    total += Math.min(firstMs * 2 ** index, maxMs);
  const minutes = Math.max(1, Math.round(total / 60_000));
  return minutes === 1 ? "a minute" : `${minutes} minutes`;
}

function errorText(error: unknown) {
  return Array.from(error instanceof Error ? error.message : String(error))
    .slice(0, 1000)
    .join("");
}

export function createResponsibilityEngine(options: {
  store: Pick<
    ResponsibilityStore,
    "ingestEvent" | "beginRun" | "settleRun" | "requeueRun"
  >;
  queue: Pick<WorkQueue, "claim" | "renew" | "finish" | "release">;
  runTurn: RunResponsibilityTurn;
  /**
   * The task board (ticket 020, spec C2): an event that woke a coworker is work somebody should see
   * started, not a row in a table nobody opens.
   */
  board?: Pick<TaskProjector, "opened" | "finished">;
  /** The plan's monthly ceiling, asked before the model is dialled. */
  quota?: QuotaService;
  /** Which of the owner's machines this coworker's actions run on, in device mode. */
  deviceIdOf?: (agentId: string, taskRef?: string) => Promise<string | null>;
  /**
   * Whether an administrator has revoked this workspace's access (spec J5). A ban freezes the queue;
   * an event that arrives for a banned account must not be spent on that account's models.
   */
  accessRevokedOf?: (userId: string) => Promise<boolean>;
  onReply?: (
    context: ResponsibilityRunContext,
    replyText: string,
  ) => Promise<void>;
  busyRetry?: BusyRetry;
}) {
  const {
    store,
    queue,
    runTurn,
    onReply,
    board,
    quota,
    deviceIdOf,
    accessRevokedOf,
  } = options;
  const busyRetry = options.busyRetry ?? BUSY_RETRY;
  return {
    ingest: (event: unknown) => store.ingestEvent(event),
    async dispatch(input: {
      owner: string;
      limit?: number;
      leaseMs?: number;
    }): Promise<ResponsibilityDispatchReport> {
      const leaseMs = input.leaseMs ?? 15 * 60_000;
      if (leaseMs < 1000)
        throw new Error("Responsibility lease must be at least one second.");
      const report: ResponsibilityDispatchReport = {
        succeeded: [],
        waiting: [],
        skipped: [],
        busy: [],
        failed: [],
      };
      const items = await queue.claim({
        kind: RESPONSIBILITY_RUN_KIND,
        owner: input.owner,
        leaseMs,
        limit: input.limit ?? 5,
        maxAttempts: 2,
      });
      for (const item of items) {
        const runId = item.payload.runId;
        if (typeof runId !== "string" || !runId)
          throw new Error("Responsibility work item has no run ID.");
        if (
          !(await queue.renew({
            kind: RESPONSIBILITY_RUN_KIND,
            key: item.key,
            owner: input.owner,
            leaseMs,
          }))
        )
          throw new Error("Responsibility work lease expired before dispatch.");
        const context = await store.beginRun(runId, {
          recovered: item.attempts > 1,
        });
        if (!context) {
          await finish(item.key);
          report.skipped.push(runId);
          continue;
        }
        // A paused Bot's run is skipped, not failed. See agents/lifecycle.ts.
        if (await isBotPaused(context.ownerUserId, context.agentId)) {
          await store.settleRun(runId, {
            status: "skipped",
            error: BOT_PAUSED_REASON,
          });
          await finish(item.key);
          report.skipped.push(runId);
          continue;
        }
        /*
         * Spec J5, and it is asked before anything is spent: an administrator's ban freezes this
         * workspace's work, and an incoming event is the one thing that would otherwise walk straight
         * past it. Skipped rather than failed, with the lease handed back like every other skip here —
         * lifting a ban should resume the responsibility, not require repairing a broken integration.
         */
        if (await accessRevokedOf?.(context.ownerUserId)) {
          await store.settleRun(runId, {
            status: "skipped",
            error: "access to this workspace has been revoked",
          });
          await finish(item.key);
          report.skipped.push(runId);
          continue;
        }
        /*
         * The ceiling first, and refused means this firing never happened — the same arithmetic a
         * person's turn is held to (ticket 022). `skipped` rather than `failed`, because over quota is
         * not a broken integration; the lease is handed back like every other skip here.
         */
        try {
          await quota?.assertCapacity(context.ownerUserId, "tasksPerMonth");
        } catch (error) {
          if (!(error instanceof QuotaExceeded)) throw error;
          await store.settleRun(runId, {
            status: "skipped",
            error: error.message,
          });
          await finish(item.key);
          report.skipped.push(runId);
          continue;
        }

        /*
         * One card per firing, keyed by the run id this board call returns nothing for on purpose:
         * `finished` below finds it by the same ref. A board that cannot be written is logged and the
         * job goes ahead, because the person subscribed to the outcome, not to the card.
         */
        let carded = false;
        if (board) {
          try {
            await board.opened({
              tenantId: context.ownerUserId,
              title: context.instruction,
              executorAgentId: context.agentId,
              source: "responsibility",
              triggerSource: "responsibility",
              channelRef: context.channelId,
              runRef: runId,
              deviceId: (await deviceIdOf?.(context.agentId, runId)) ?? null,
            });
            carded = true;
          } catch (error) {
            if (quota) {
              await store.settleRun(runId, {
                status: error instanceof QuotaExceeded ? "skipped" : "failed",
                error: errorText(error),
              });
              await finish(item.key);
              if (error instanceof QuotaExceeded) report.skipped.push(runId);
              else report.failed.push({ runId, error: errorText(error) });
              continue;
            }
            console.error(
              JSON.stringify({
                type: "responsibility-board-open-failed",
                runId,
                reason: errorText(error),
              }),
            );
          }
        }
        const closeCard = async (failed: boolean, deliverableRef?: unknown) => {
          if (!carded || !board) return;
          try {
            await board.finished({
              tenantId: context.ownerUserId,
              runRef: runId,
              failed,
              deliverableRef,
            });
          } catch (error) {
            console.error(
              JSON.stringify({
                type: "responsibility-board-close-failed",
                runId,
                reason: errorText(error),
              }),
            );
          }
        };
        const controller = new AbortController();
        /** Put back on the queue to wait for its conversation, so not finished here. */
        let released = false;
        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let renewing: Promise<void> | undefined;
        let lostLease: Error | undefined;
        const scheduleRenewal = () => {
          timer = setTimeout(
            () => {
              renewing = renew();
            },
            Math.floor(leaseMs / 3),
          );
        };
        const renew = async () => {
          try {
            const held = await queue.renew({
              kind: RESPONSIBILITY_RUN_KIND,
              key: item.key,
              owner: input.owner,
              leaseMs,
            });
            if (!held) throw new Error("Responsibility work lease was lost.");
          } catch (error) {
            lostLease =
              error instanceof Error ? error : new Error(String(error));
            controller.abort(lostLease);
          }
          if (!stopped && !lostLease) scheduleRenewal();
        };
        scheduleRenewal();
        try {
          /*
           * THE SUBSCRIBER'S TENANT FOR THE TURN ITSELF. The claim, the lease and this run's own row
           * are the platform's business and stay the platform's; what the turn writes is not. A
           * headless turn creates the thread the person will open and the messages inside it, and
           * those rows take the tenant of the context they are written in — as the loop's `platform`
           * they would be filed where no subscriber can read them, which is an event that woke a
           * coworker with nothing anywhere to show for it.
           */
          const result = await runAsTenant(context.tenantId, () =>
            runTurn({
              ...context,
              signal: controller.signal,
              // The card opened for this firing above is the run's record; when that write failed the
              // runner's own card is the only mark this run leaves.
              cardOwnedByCaller: carded,
            }),
          );
          if (lostLease) throw lostLease;
          await store.settleRun(runId, {
            status: "succeeded",
            replyText: result.replyText,
          });
          report.succeeded.push(runId);
          // The reply is a thing to look at, not a done deal: the review lane is where it goes.
          await closeCard(false, deliverableRefOf(result));
          if (onReply) {
            try {
              await runAsTenant(context.tenantId, () =>
                onReply(context, result.replyText),
              );
            } catch (error) {
              report.failed.push({
                runId,
                error: `Reply delivery failed: ${errorText(error)}`,
              });
            }
          }
        } catch (error) {
          if (error instanceof HeadlessToolSuspension) {
            await store.settleRun(runId, {
              status: "waiting",
              waiting: error.waiting,
              error: errorText(error),
            });
            report.waiting.push(runId);
            /*
             * To review, not to needs_action: that lane holds a card against an approval row, and a
             * headless suspension waits on a durable request id. Filing one under the approval column
             * would create a card only a signature nobody made can move.
             */
            await closeCard(false);
          } else if (isThreadBusy(error) && !lostLease) {
            /*
             * ANOTHER RUN HAS THE CONVERSATION, SO NOTHING RAN. The lock is taken before anything
             * is streamed, and the platform said to try again: the run goes back to queued and the
             * item back on the queue, uncounted, to be tried after a wait that doubles. Only once
             * the waits are spent is it a failure, in words a person reads.
             */
            const waited = Number(
              (item.payload as { busyRetries?: unknown }).busyRetries ?? 0,
            );
            const tries = Number.isFinite(waited) ? waited : 0;
            if (tries >= busyRetry.tries) {
              const reason = `This goal's conversation was busy for about ${waitedFor(busyRetry)}, so the run never started and nothing was done. Run the goal again when the conversation is free.`;
              await store.settleRun(runId, { status: "failed", error: reason });
              report.failed.push({ runId, error: reason });
              await closeCard(true);
            } else if (!(await store.requeueRun(runId))) {
              report.skipped.push(runId);
            } else {
              released = await queue.release({
                kind: RESPONSIBILITY_RUN_KIND,
                key: item.key,
                owner: input.owner,
                delayMs: Math.min(
                  busyRetry.firstMs * 2 ** tries,
                  busyRetry.maxMs,
                ),
                reason: errorText(error),
                uncounted: true,
                payload: { busyRetries: tries + 1 },
              });
              if (!released)
                throw new Error(
                  "Responsibility work lease was lost before the run could wait.",
                );
              report.busy.push(runId);
            }
          } else {
            const reason = errorText(error);
            await store.settleRun(runId, { status: "failed", error: reason });
            report.failed.push({ runId, error: reason });
            await closeCard(true);
          }
        } finally {
          stopped = true;
          if (timer) clearTimeout(timer);
          await renewing;
          if (!released) await finish(item.key);
        }
      }
      return report;
      async function finish(key: string) {
        const finished = await queue.finish({
          kind: RESPONSIBILITY_RUN_KIND,
          key,
          owner: input.owner,
        });
        if (!finished)
          throw new Error(
            "Responsibility work lease was lost before completion.",
          );
      }
    },
  };
}

export type ResponsibilityEngine = ReturnType<
  typeof createResponsibilityEngine
>;
