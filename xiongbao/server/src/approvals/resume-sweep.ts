import { HeadlessToolSuspension } from "@xiongbao/toolkit/headless-tools";
import type { TurnRunner } from "@xiongbao/toolkit/run-turn";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { headlessTurnRefusal } from "../admin/controls";
import type { AgentActor } from "../agents/profile-types";
import { PERSON_INITIATOR } from "../audit";
import { firingOfInitiator } from "../automations/waker-executor";
import type { GroupConversations } from "../channels/group";
import type { ChannelStore } from "../channels/routes";
import {
  markBeforeApprovedAction,
  withApprovedActionTurn,
} from "../computer/turn-artifacts";
import type { Database } from "../db/client";
import {
  intelligenceChannelMappings,
  responsibilityRuns,
  routineRuns,
} from "../db/schema";
import type { DeliveryScope } from "../delivery/types";
import { APPROVAL_RESUME_GATED_REASON } from "../recovery/abandoned-work";
import type { ResponsibilityStore } from "../responsibilities/types";
import {
  assertPersonTenant,
  runAsClaimedTenant,
  runAsTenant,
  TenantContextError,
} from "../tenant/context";
import { DEFAULT_MAX_ATTEMPTS, type WorkQueue } from "../work/queue";
import {
  ApprovalRecoveryBlockedError,
  type ApprovalResumeDependencies,
  type ApprovalService,
} from "./service";

/**
 * What a one-to-one conversation is told when the turn an approval carried on started and then failed.
 * The decision was made, allowed or declined, and what the turn did before it failed stays done; it is
 * not run again, so the person is told to ask for the rest.
 */
export const CONTINUATION_FAILED = "这一轮没能做完。发一条消息，让它接着做。";

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * A crew's pipeline, as the resume loop reaches it: the action step parked on an approval (WF7), and
 * the step whose coworker stopped to ask (ticket 021, spec I3). See pipeline/store.ts.
 */
export type ResumablePipeline = {
  actionHoldingApproval(input: {
    approvalId: string;
  }): Promise<{ runId: string; tenantId: string } | null | undefined>;
  resumeAction(input: {
    tenantId: string;
    runId: string;
    approvalId: string;
  }): Promise<unknown>;
  runHoldingApproval(input: {
    approvalId: string;
  }): Promise<{ runId: string; tenantId: string } | null | undefined>;
  resume(input: {
    tenantId: string;
    runId: string;
    /** What the resumed turn answered; absent with `error` when it started and failed. */
    output?: string;
    error?: string;
  }): Promise<unknown>;
};

/**
 * One pass of the approval resume loop: claim a decided approval, carry it out, and pick the waiting
 * turn back up — a responsibility run, a group conversation or a routine run — then tell the channel.
 *
 * Moved out of index.ts verbatim. `notify` is taken as a function because index.ts assigns delivery
 * after this loop is created: the loop reads it when it runs, never when it is built.
 *
 * WHOSE DECISION THIS IS comes from the row the queue handed out, never from the payload (G01). The
 * route the person decided through offered it inside their own frame, so the database stamped their
 * tenant on it; the payload's owner may only agree. A row stamped as nobody's, or naming somebody
 * else, is ended here and never runs. Everything the item does runs in that tenant's frame.
 *
 * The fork's additions, each optional: a crew's step parked on the approval is carried on by the
 * pipeline (`pipeline`), and an automation firing that stopped for it is settled (`automations`).
 */
export function createApprovalResumeTick(deps: {
  approvalQueue: WorkQueue;
  approvalOwner: string;
  approvalService: ApprovalService;
  executeApprovedAction: ApprovalResumeDependencies["execute"];
  database: Database;
  responsibilityStore: ResponsibilityStore;
  groupConversations: Pick<GroupConversations, "continueWaiting">;
  approvalContinuationRunner: TurnRunner;
  channelStore: ChannelStore;
  actorFor: (ownerUserId: string) => Promise<AgentActor>;
  notify: (
    scope: DeliveryScope,
    input: { id: string; text: string; kind: "reply" },
  ) => Promise<void>;
  /**
   * Resolves once the thread's stored history holds a carried-on turn's reply, or gives up.
   *
   * The conversation reads its history again when the channel says the Bot replied, and the
   * platform's read of a thread can trail the run that wrote it. Told first, the browser read the
   * reply half written ("...shared with") and kept that half, because a message it already holds is
   * never read twice. So the channel is told, and the request finished, only once the reply is there
   * to read. Absent, the channel is told at once.
   */
  transcriptHolds?: (input: {
    ownerUserId: string;
    threadId: string;
    replyText: string;
  }) => Promise<void>;
  /** A crew's pipeline, carried on when one of its steps was waiting on this decision. */
  pipeline?: ResumablePipeline;
  /** An automation firing that stopped for this approval (D06), settled once the turn continued. */
  automations?: {
    /** With `failure`, the carried-on turn started and failed: the firing fails with it. */
    settleWaitingFiring(firingId: string, failure?: string): Promise<unknown>;
  };
}): () => Promise<void> {
  const {
    approvalQueue,
    approvalOwner,
    approvalService,
    executeApprovedAction,
    database,
    responsibilityStore,
    groupConversations,
    approvalContinuationRunner,
    channelStore,
    actorFor,
    pipeline,
  } = deps;

  /**
   * A pipeline run looked up as `platform` names any person's run, so it is only acted on when its
   * tenant is this approval's owner (G01-E R10, R14); anything else is left parked and logged.
   */
  const ownedBy = (
    parked: { runId: string; tenantId: string },
    ownerUserId: string,
    type: string,
    approvalId: string,
  ): string | undefined => {
    try {
      return assertPersonTenant(parked.tenantId, ownerUserId);
    } catch (error) {
      if (!(error instanceof TenantContextError)) throw error;
      console.warn(JSON.stringify({ type, approvalId, runId: parked.runId }));
      return undefined;
    }
  };

  return async () => {
    try {
      const [item] = await approvalQueue.claim({
        kind: "approval.resume",
        owner: approvalOwner,
        leaseMs: 15 * 60_000,
        limit: 1,
      });
      if (!item) return;
      const claimed = await runAsClaimedTenant(
        item,
        item.payload.ownerUserId,
        async () => {
          // Set once the item is understood, so its last failed try can still tell the Bot.
          let abandon: ((reason: string) => Promise<void>) | undefined;
          try {
            const input = z
              .object({
                ownerUserId: z.string().min(1),
                approvalId: z.string().min(1),
              })
              .parse(item.payload);
            /*
             * WF7: an action step of a crew run parked on this approval is carried on by the
             * pipeline itself, which calls the tool again with the identity it asked with, so the
             * gate consumes the decision once (or refuses it). It has no conversation to resume.
             */
            const parkedAction = await pipeline?.actionHoldingApproval({
              approvalId: input.approvalId,
            });
            const actionTenant = parkedAction
              ? ownedBy(
                  parkedAction,
                  input.ownerUserId,
                  "parked-action-owner-mismatch",
                  input.approvalId,
                )
              : undefined;
            if (pipeline && parkedAction && actionTenant) {
              const resumed = await runAsTenant(actionTenant, () =>
                pipeline.resumeAction({
                  tenantId: actionTenant,
                  runId: parkedAction.runId,
                  approvalId: input.approvalId,
                }),
              );
              if (resumed) {
                if (
                  !(await approvalQueue.finish({
                    kind: item.kind,
                    key: item.key,
                    owner: approvalOwner,
                  }))
                )
                  throw new Error(
                    "The approval work lease was lost before completion.",
                  );
                return;
              }
            }
            /**
             * The decision's answer, carried on into the conversation that asked. `turn.started` is
             * set once the carried-on turn's run is under way, which is where repeating it would
             * repeat what its tools did (see `continue` below).
             */
            const carryOn = async (
              {
                continuation: snapshot,
                result,
                messageId,
                approvalId,
              }: Parameters<ApprovalResumeDependencies["continue"]>[0],
              turn: { started: boolean },
            ): Promise<void> => {
              const [waitingRun] = await database
                .select({ id: responsibilityRuns.id })
                .from(responsibilityRuns)
                .where(
                  and(
                    eq(responsibilityRuns.status, "waiting"),
                    sql`${responsibilityRuns.waiting}->>'approvalId' = ${approvalId}`,
                  ),
                )
                .limit(1);
              if (waitingRun) {
                await responsibilityStore.resumeWaiting(
                  input.ownerUserId,
                  waitingRun.id,
                  result,
                );
                return;
              }
              const request = await approvalService.store.get(
                input.ownerUserId,
                approvalId,
              );
              /*
               * ASKING AGAIN IS WHERE THE TURN STOPS, NOT A FAILURE. A carried-on turn that reaches
               * another action needing the person opens its own request and stops on it, nothing
               * done, exactly as a run in the browser does. Thrown on from here, the resume loop
               * took it for a failure: it released this decision and carried the conversation on
               * again, from the same place, until its tries ran out, while the new request sat
               * pending where nobody was shown it. Now this decision is finished, the conversation
               * says what it waits on, and the new request carries it on when it is answered.
               */
              let waitingOn:
                | { message: string; approvalId?: string }
                | undefined;
              let outcome: { replyText: string };
              // A failure once the turn started is not retried (see `continue`); before it, it is.
              let failedAfterStart: unknown;
              try {
                // A group turn's approval also writes the resumed reply into the shared transcript.
                outcome = await groupConversations.continueWaiting(
                  approvalId,
                  // 群聊要接着记这一轮里交付卡的状态标记（`channels/group.ts` `continueWaiting`）。
                  (hooks) =>
                    approvalContinuationRunner({
                      onStarted: () => {
                        turn.started = true;
                      },
                      ...(hooks?.onCustom ? { onCustom: hooks.onCustom } : {}),
                      ...(hooks?.onToolCall
                        ? { onToolCall: hooks.onToolCall }
                        : {}),
                      ...(hooks?.onReasoning
                        ? { onReasoning: hooks.onReasoning }
                        : {}),
                      ownerUserId: input.ownerUserId,
                      routineId: "approval",
                      agentId: request.action.botId,
                      threadId: snapshot.threadId,
                      instruction: "",
                      initiator: snapshot.initiator ?? PERSON_INITIATOR,
                      continuation: { snapshot, result, messageId },
                    }),
                );
              } catch (error) {
                if (!(error instanceof HeadlessToolSuspension)) {
                  if (!turn.started) throw error;
                  failedAfterStart = error;
                  outcome = { replyText: "" };
                } else {
                  waitingOn = {
                    message: error.message,
                    ...(typeof error.waiting.approvalId === "string"
                      ? { approvalId: error.waiting.approvalId }
                      : {}),
                  };
                  outcome = { replyText: "" };
                }
              }
              const failure =
                failedAfterStart === undefined
                  ? undefined
                  : messageOf(failedAfterStart);
              /*
               * ONE STEP FAILING NEVER STOPS THE NEXT. Once the turn started, the decision is not run
               * again (see `continue`), so a routine run, a firing or a crew step left waiting here is
               * left waiting for good: nothing sweeps a finished approval's waiters later. So each
               * step after the turn -- telling the conversation, telling Slack or the phone, settling
               * the crew step, the routine run and the firing -- is its own: one that fails (the Bot
               * taken out of the conversation, the conversation deleted, Slack down) is logged, and
               * the rest still happen. Before the turn started nothing ran, and a failure is thrown
               * on for the queue to retry.
               */
              const tell = async (
                step: string,
                body: () => Promise<unknown>,
              ) => {
                try {
                  await body();
                } catch (error) {
                  if (!turn.started) throw error;
                  console.error(
                    JSON.stringify({
                      type: "approval-continuation-step-failed",
                      approvalId,
                      step,
                      error: messageOf(error),
                      timestamp: new Date().toISOString(),
                    }),
                  );
                }
              };
              let source: { channelId: string } | undefined;
              await tell("conversation", async () => {
                [source] = await database
                  .select({ channelId: intelligenceChannelMappings.channelId })
                  .from(intelligenceChannelMappings)
                  .where(
                    and(
                      eq(intelligenceChannelMappings.userId, input.ownerUserId),
                      eq(
                        intelligenceChannelMappings.threadId,
                        snapshot.threadId,
                      ),
                    ),
                  )
                  .limit(1);
              });
              const scope = (channelId: string) => ({
                ownerUserId: input.ownerUserId,
                channelId,
                agentId: request.action.botId,
                threadId: snapshot.threadId,
              });
              const line = (text: string, id: string) => async () => {
                if (!source) return;
                await channelStore.recordActivity(
                  await actorFor(input.ownerUserId),
                  source.channelId,
                  { text, agentId: request.action.botId, at: new Date() },
                  { id },
                );
              };
              if (outcome.replyText) {
                const replyText = outcome.replyText;
                await tell("reply", async () => {
                  await deps.transcriptHolds?.({
                    ownerUserId: input.ownerUserId,
                    threadId: snapshot.threadId,
                    replyText,
                  });
                  await line(replyText, messageId)();
                });
                // A decision made in Slack, SMS or the phone gets its result back there too.
                await tell("notify", async () => {
                  if (source)
                    await deps.notify(scope(source.channelId), {
                      id: messageId,
                      text: replyText,
                      kind: "reply",
                    });
                });
              }
              // The conversation's last line says what it waits on, and its card is read with it.
              if (waitingOn)
                await tell(
                  "waiting",
                  line(waitingOn.message, `${messageId}:waiting`),
                );
              /*
               * A one-to-one conversation whose carried-on turn started and failed is told so, here
               * and where the decision was made. A group's row already says it failed
               * (`channels/group.ts` `continueWaiting`), and a group thread has no conversation of its
               * own here (`source` is not found), so this is never said twice.
               */
              if (failure !== undefined && source) {
                const failedLine = `${messageId}:failed`;
                await tell("failed", line(CONTINUATION_FAILED, failedLine));
                await tell("notify", async () => {
                  if (source)
                    await deps.notify(scope(source.channelId), {
                      id: failedLine,
                      text: CONTINUATION_FAILED,
                      kind: "reply",
                    });
                });
              }
              // A routine run waiting on this decision now waits on the request its turn opened.
              if (waitingOn) {
                if (waitingOn.approvalId)
                  await database
                    .update(routineRuns)
                    .set({
                      waiting: sql`jsonb_set(${routineRuns.waiting}, '{approvalId}', to_jsonb(${waitingOn.approvalId}::text))`,
                    })
                    .where(
                      and(
                        eq(routineRuns.status, "waiting"),
                        sql`${routineRuns.waiting}->>'approvalId' = ${approvalId}`,
                      ),
                    );
                // M3: a crew step parked on this approval stays parked on it; the pipeline has no
                // way yet to move its wait to the request the carried-on turn opened.
                return;
              }
              /*
               * A crew's step that stopped to ask is told the answer (ticket 021, spec I3).
               *
               * The person decided in the approvals region, which knows nothing about pipelines:
               * without this the coworker's resumed turn would finish inside its own thread while
               * the run it stopped in stayed `awaiting_action`. What that turn finally said IS the
               * step's output, so the sequence is handed the answer rather than asking again. A turn
               * that started and failed hands the step its failure instead, and the step fails.
               */
              const parkedCrew = await pipeline?.runHoldingApproval({
                approvalId,
              });
              const crewTenant = parkedCrew
                ? ownedBy(
                    parkedCrew,
                    input.ownerUserId,
                    "parked-crew-owner-mismatch",
                    approvalId,
                  )
                : undefined;
              if (pipeline && parkedCrew && crewTenant)
                await tell("crew", () =>
                  runAsTenant(crewTenant, () =>
                    pipeline.resume({
                      tenantId: crewTenant,
                      runId: parkedCrew.runId,
                      ...(failure === undefined
                        ? { output: outcome.replyText }
                        : { error: failure }),
                    }),
                  ),
                );
              // The routine run waiting on this decision ends as the turn did: succeeded, or failed.
              await tell("routine", async () => {
                await database
                  .update(routineRuns)
                  .set({
                    status: failure === undefined ? "succeeded" : "failed",
                    finishedAt: new Date(),
                    error: failure ?? null,
                    waiting: null,
                  })
                  .where(
                    and(
                      eq(routineRuns.status, "waiting"),
                      sql`${routineRuns.waiting}->>'approvalId' = ${approvalId}`,
                    ),
                  );
              });
              /*
               * An automation firing that stopped for this approval (D06) is settled the same
               * way, allowed or declined: the turn has now continued with the person's answer.
               * A turn that started and failed settles it as failed, with the routine's error.
               * Named by the snapshot's initiator and settled in this owner's frame, so another
               * person's firing id matches nothing.
               */
              const waitingFiring = firingOfInitiator(snapshot.initiator);
              const automations = deps.automations;
              if (waitingFiring && automations)
                await tell("firing", () =>
                  automations.settleWaitingFiring(
                    waitingFiring,
                    ...(failure === undefined ? [] : [failure]),
                  ),
                );
              // Thrown on to `continue`, which logs it and finishes the request: not retried.
              if (failedAfterStart !== undefined) throw failedAfterStart;
            };
            const resumeDependencies: ApprovalResumeDependencies = {
              // Asked before the action runs: with Use Bots off, or the Bot's model off the allowlist,
              // nothing is carried out and the refusal is final rather than retried.
              refusal: (action) =>
                headlessTurnRefusal({
                  ownerUserId: action.actorId,
                  agentId: action.botId,
                  threadId: action.threadId,
                }),
              validate: (action) =>
                approvalService.validateReentry(action, () =>
                  executeApprovedAction(action),
                ),
              // 先给员工的电脑记快照，续跑的那一轮才列得出这次动作写下的文件（`computer/turn-artifacts.ts`）。
              execute: async (action) => {
                await markBeforeApprovedAction({
                  approvalId: input.approvalId,
                  botId: action.botId,
                });
                return executeApprovedAction(action);
              },
              /*
               * ONCE THE CARRIED-ON TURN HAS STARTED, NOTHING HERE RUNS IT AGAIN. Its tools ran as it
               * went (a file written, a card handed in, a message sent), and the queue's retry starts
               * the same continuation from the same place, doing all of it a second time: a turn that
               * ended by handing in its card handed it in again every ten seconds until its tries ran
               * out, while the request stayed `consumed` and the chat showed the action as running.
               * So once it started, whatever goes wrong after -- the turn failing, stopping, saying
               * nothing, or the bookkeeping after it -- ends this decision as it is: the request is
               * finished, and what the turn did stays done. Only a failure before the turn started,
               * when nothing ran, is thrown on for the queue to try again.
               *
               * Two ways it can still run again, both known limits, neither fixed here: the item's
               * lease (15 minutes, never renewed) running out under a continuation on the working
               * turn's 25-minute clock, when another replica may claim it after this one releases
               * the thread; and `store.finish` failing after this returns, when the retry finds the
               * answer saved and carries the conversation on once more. Either needs a durable
               * "started" mark on the approval.
               */
              continue: async (answer) => {
                const turn = { started: false };
                try {
                  await carryOn(answer, turn);
                } catch (error) {
                  if (!turn.started) throw error;
                  console.error(
                    JSON.stringify({
                      type: "approval-continuation-ended",
                      approvalId: answer.approvalId,
                      error:
                        error instanceof Error ? error.message : String(error),
                      timestamp: new Date().toISOString(),
                    }),
                  );
                }
              },
            };
            abandon = (reason) =>
              approvalService.abandon(
                input.ownerUserId,
                input.approvalId,
                reason,
                resumeDependencies,
              );
            // 执行与续跑包在一起：执行前记的快照留给续跑的那个 run 沿用。
            await withApprovedActionTurn({ personId: input.ownerUserId }, () =>
              approvalService.resume(
                input.ownerUserId,
                input.approvalId,
                resumeDependencies,
              ),
            );
            if (
              !(await approvalQueue.finish({
                kind: item.kind,
                key: item.key,
                owner: approvalOwner,
              }))
            )
              throw new Error(
                "The approval work lease was lost before completion.",
              );
          } catch (error) {
            const reason =
              error instanceof Error ? error.message : String(error);
            // The queue will not hand this item out again, so the conversation hears now or never.
            if (abandon && item.attempts >= DEFAULT_MAX_ATTEMPTS) {
              try {
                await abandon(reason);
                await approvalQueue.finish({
                  kind: item.kind,
                  key: item.key,
                  owner: approvalOwner,
                });
                return;
              } catch (failure) {
                console.error(
                  JSON.stringify({
                    type: "approval-abandon-error",
                    error:
                      failure instanceof Error
                        ? failure.message
                        : String(failure),
                    timestamp: new Date().toISOString(),
                  }),
                );
              }
            }
            await approvalQueue.release({
              kind: item.kind,
              key: item.key,
              owner: approvalOwner,
              delayMs: 10_000,
              reason,
            });
            throw error;
          }
        },
      );
      if (!claimed.ran) {
        await approvalQueue.finish({
          kind: item.kind,
          key: item.key,
          owner: approvalOwner,
        });
        /*
         * Ended, not retried: no frame would ever make this row a person's. Every path that decides
         * runs in the owner's frame (the app's routes, and OpenTag as the binding's tenant), so this
         * is a legacy or misfiled row, reported where an operator looks rather than run as whoever
         * its payload names.
         */
        console.error(
          JSON.stringify({
            type: "approval-resume-untrusted-tenant",
            key: item.key,
            reason: claimed.reason,
          }),
        );
      }
    } catch (error) {
      /*
       * Named, so an operator can tell this from a fault. The server settles approved actions on the
       * approval row itself (`settlement: "database"`), so this is raised only when a row's tenant,
       * owner or run binding does not match the frame that claimed it, and that row is never run.
       */
      if (error instanceof ApprovalRecoveryBlockedError) {
        console.warn(
          JSON.stringify({
            type: "approval-resume-gated",
            reason: APPROVAL_RESUME_GATED_REASON,
            timestamp: new Date().toISOString(),
          }),
        );
        return;
      }
      console.error(
        JSON.stringify({
          type: "approval-resume-error",
          error: error instanceof Error ? error.message : String(error),
          timestamp: new Date().toISOString(),
        }),
      );
    }
  };
}
