import { randomUUID } from "node:crypto";
import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type Message,
} from "@ag-ui/client";
import type { TurnRunner } from "@openbot/toolkit/run-turn";
import { Observable } from "rxjs";
import { PERSON_INITIATOR } from "../audit";
import type { NoticeRunner } from "../devices/queued-results";
import { runAsTenant } from "../tenant/context";
import { emitRunEvent } from "../threads/run-side-events";
import { suppressRunnerCard } from "../threads/unattended-card";

/**
 * What the person's decisions on a followed card do in its conversation (spec 2026-11-15-delivery-loop
 * §6): a 退回 is said in the card's thread as the person's own message and the coworker answers it, a
 * 取消 stops the round running on the card, and an answer to a 延期申请 is put in the thread for the
 * chat's card to show. The card itself is written by `tasks/delivery.ts`; this is only the thread.
 *
 * Every call takes the card's tenant and works in its frame: the thread is that tenant's, and so are
 * the turn's grants, its usage and its audit trail. A group card's thread is the coworker's group
 * thread with that person (`thread_ref`), never the group's channel.
 */
export type CardTurns = {
  /**
   * Say `text` in `threadId` as the person, and have `agentId` answer it there: a turn of that
   * conversation like one the person started, through the same unattended runner a dispatched `@` runs
   * on (`channels/dispatch.ts`). Started, not awaited: the reply is the coworker's, in its own time. The
   * runner hangs the turn on the open followed card of the thread, as it does any later round.
   */
  sendAsUser(
    tenantId: string,
    threadId: string,
    agentId: string,
    text: string,
    options?: { source?: string },
  ): Promise<{ runId: string }>;
  /**
   * Stop the round `runId` running on the card's thread, through the runner's own stop -- the one the
   * conversation's stop button uses -- and an external coworker's turn on it, when this deployment can.
   */
  stopRound(
    tenantId: string,
    round: { threadId: string; agentId: string | null; runId: string | null },
  ): Promise<void>;
  /**
   * Put one of the server's `delivery.*` events in the card's thread: into the round running on the
   * card when it is open here, otherwise as a run of its own that says nothing else, so the
   * conversation stores and replays it like every other event. A thread with somebody else's turn in
   * flight is left alone (the runner would supersede it).
   */
  say(
    tenantId: string,
    where: { threadId: string; agentId: string; runId: string | null },
    event: BaseEvent,
  ): Promise<void>;
};

export type CardTurnsDeps = {
  /** The unattended turn (`routines/run-turn.ts`'s `createTurnRunner`), as a dispatched `@` uses it. */
  runTurn: TurnRunner;
  /** The deployment's thread runner (`threads/postgres-runner.ts`). */
  runner: NoticeRunner & {
    stop(request: {
      threadId: string;
      runId?: string;
    }): Promise<boolean | undefined>;
  };
  /**
   * Cancel an external coworker's queued or running turn on the thread (spec §6: 外部员工排队或进行中
   * 的轮次一并取消). The ACP runtime that runs those turns (`DeviceAcpAgent`, external coworkers phase
   * two) is not on this branch, so nothing is wired here yet; when it lands, its cancel goes here.
   */
  cancelExternalTurn?: (
    tenantId: string,
    turn: { threadId: string; agentId: string },
  ) => Promise<void>;
};

const log = (type: string, detail: Record<string, unknown>) =>
  console.error(JSON.stringify({ type, ...detail }));

const reasonOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** A run that carries one server event and nothing else. */
class ServerNotice extends AbstractAgent {
  constructor(
    agentId: string,
    private readonly event: BaseEvent,
  ) {
    super({ agentId });
  }

  run(input: { threadId: string; runId: string }): Observable<BaseEvent> {
    const events: BaseEvent[] = [
      {
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      } as BaseEvent,
      this.event,
      {
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
      } as BaseEvent,
    ];
    return new Observable<BaseEvent>((subscriber) => {
      for (const event of events) subscriber.next(event);
      subscriber.complete();
    });
  }
}

export function createCardTurns(deps: CardTurnsDeps): CardTurns {
  return {
    async sendAsUser(tenantId, threadId, agentId, text, options) {
      // A uuid, because the thread lock wants one.
      const runId = randomUUID();
      const userMessage: Message = {
        id: `card-user:${runId}`,
        role: "user",
        content: text,
      };
      void runAsTenant(tenantId, () =>
        deps.runTurn({
          ownerUserId: tenantId,
          routineId: options?.source ?? "task-card",
          agentId,
          threadId,
          instruction: text,
          userMessage,
          runId,
          tenantId,
          initiator: PERSON_INITIATOR,
          telemetry: { trigger: "human" },
        }),
      ).catch((error) =>
        // A turn parked on a person's decision throws too; the card it hangs on is parked by its run id.
        log("task-card-turn-ended-early", {
          runId,
          threadId,
          reason: reasonOf(error),
        }),
      );
      return { runId };
    },

    async stopRound(tenantId, round) {
      if (round.runId) {
        const runId = round.runId;
        await runAsTenant(tenantId, () =>
          deps.runner.stop({ threadId: round.threadId, runId }),
        ).catch((error) =>
          log("task-card-stop-failed", {
            runId,
            threadId: round.threadId,
            reason: reasonOf(error),
          }),
        );
      }
      if (round.agentId && deps.cancelExternalTurn) {
        const agentId = round.agentId;
        await deps
          .cancelExternalTurn(tenantId, { threadId: round.threadId, agentId })
          .catch((error) =>
            log("task-card-external-cancel-failed", {
              threadId: round.threadId,
              reason: reasonOf(error),
            }),
          );
      }
    },

    async say(tenantId, where, event) {
      if (where.runId && emitRunEvent(where.runId, event)) return;
      await runAsTenant(tenantId, async () => {
        await deps.runner.hydrate();
        if (await deps.runner.isRunning({ threadId: where.threadId })) {
          log("task-card-notice-skipped", {
            threadId: where.threadId,
            reason: "busy",
          });
          return;
        }
        const history = deps.runner.getThreadMessages(where.threadId);
        const agent = new ServerNotice(where.agentId, event);
        agent.threadId = where.threadId;
        agent.setMessages(history);
        await suppressRunnerCard(
          () =>
            new Promise<void>((resolve, reject) => {
              deps.runner
                .run({
                  threadId: where.threadId,
                  agent,
                  input: {
                    threadId: where.threadId,
                    runId: randomUUID(),
                    messages: history,
                    tools: [],
                    context: [],
                    state: {},
                    forwardedProps: {},
                  },
                })
                .subscribe({ error: reject, complete: resolve });
            }),
        );
      });
    },
  };
}
