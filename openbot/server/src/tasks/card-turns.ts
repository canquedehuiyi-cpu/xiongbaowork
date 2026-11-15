import { randomUUID } from "node:crypto";
import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type Message,
} from "@ag-ui/client";
import { and, eq } from "drizzle-orm";
import { Observable } from "rxjs";
import { type AuditInitiator, PERSON_INITIATOR } from "../audit";
import type { Database } from "../db/client";
import { groupBotThreads } from "../db/schema";
import type { NoticeRunner } from "../devices/queued-results";
import type { TurnRunner } from "../routines/run-turn";
import { runAsTenant } from "../tenant/context";
import { emitRunEvent } from "../threads/run-side-events";
import { suppressRunnerCard, turnForCard } from "../threads/unattended-card";

/**
 * What the person's decisions on a followed card do in its conversation (spec 2026-11-15-delivery-loop
 * §6): a 退回 is said in the card's conversation as the person's own message and the coworker answers
 * it, a 取消 stops the round running on the card, and an answer to a 延期申请 is put where the chat's
 * card can show it. The card itself is written by `tasks/delivery.ts`; this is only the conversation.
 *
 * Every call takes the card's tenant and works in its frame: the thread is that tenant's, and so are
 * the turn's grants, its usage and its audit trail.
 *
 * TWO KINDS OF CONVERSATION. A one-to-one card's thread is the conversation the person reads, so a
 * message goes straight into it as a turn. A group card's thread (`group_bot_threads`, the coworker's
 * thread with this person) is not: the group's transcript is `group_messages`, and only what is posted
 * to the group is seen there. So in a group the person's words are posted to the group itself, by the
 * group's own send (`channels/group.ts`), addressed to the coworker -- the transcript shows them, and
 * the group's turn runs on that same thread, where it hangs on the card like any later round.
 */
export type CardTurns = {
  /**
   * Say `text` as the person to `agentId` in the card's conversation, and have it answer. Resolves
   * once the message is in: for a one-to-one card, when the coworker's turn has started (past its
   * admission, holding the thread; a turn not started within {@link START_TIMEOUT_MS} is stopped and
   * refused); for a group card, when the group has taken the message and queued
   * its turn. Throws {@link CardTurnRefused} when it could not be said -- the thread is busy, the
   * coworker is paused, the group is gone -- and then nothing was said.
   *
   * `taskId` names the followed card the message is about (a 退回's): the coworker's turn on it is a
   * round of THAT card, even when the coworker holds a newer open card on the same thread.
   */
  sendAsUser(
    tenantId: string,
    to: { threadId: string; agentId: string },
    text: string,
    options?: { source?: string; taskId?: string },
  ): Promise<{ runId: string | null; groupMessageId: string | null }>;
  /**
   * Stop the round `runId` running on the card's thread, through the runner's own stop -- the one the
   * conversation's stop button uses -- and an external coworker's turn on it, when this deployment can.
   *
   * THIS REPLICA ONLY: the runner's live runs are in this process's memory, so a round running on
   * another replica is not reached (its card is cancelled all the same, and its late end writes nothing).
   */
  stopRound(
    tenantId: string,
    round: { threadId: string; agentId: string | null; runId: string | null },
  ): Promise<void>;
  /**
   * Tell the card's conversation what the person decided. One-to-one: the server's `delivery.*` event,
   * into the round running on the card when it is open here, otherwise as a run of its own that says
   * nothing else, so the conversation stores and replays it (a thread with somebody else's turn in
   * flight is left alone: the runner would supersede it). In a group: `groupText`, posted to the group
   * as the person, addressed to the coworker.
   */
  say(
    tenantId: string,
    where: { threadId: string; agentId: string; runId: string | null },
    event: BaseEvent,
    groupText: string,
  ): Promise<void>;
};

/** A message that could not be said, and why, in words for the person. Nothing was said. */
export class CardTurnRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CardTurnRefused";
  }
}

/**
 * Refused because the thread is taken: a turn is already running on it, or the new one could not get
 * hold of it in time. Somebody is working; nothing is wrong, and later may do.
 */
export class ThreadBusy extends CardTurnRefused {
  constructor() {
    super(BUSY);
    this.name = "ThreadBusy";
  }
}

/** The group's own send (`createGroupConversations(...).send`): a person's message and its queued turn. */
export type GroupSend = (
  ownerUserId: string,
  channelId: string,
  input: { id: string; text: string; agentId: string },
  /** The followed card the message is about: the group's turn on it hangs on that card. */
  options?: { taskId?: string },
) => Promise<unknown>;

export type CardTurnsDeps = {
  database: Database;
  /** The unattended turn (`routines/run-turn.ts`'s `createTurnRunner`), as a dispatched `@` uses it. */
  runTurn: TurnRunner;
  /** The deployment's thread runner (`threads/postgres-runner.ts`). */
  runner: NoticeRunner & {
    stop(request: {
      threadId: string;
      runId?: string;
    }): Promise<boolean | undefined>;
  };
  /** How long a turn may take to start before it is given up (default {@link START_TIMEOUT_MS}). */
  startTimeoutMs?: number;
  /** Posting to a group, for a group card. Without it a group card's message is refused. */
  groupSend?: GroupSend;
  /** The coworker's name as this person sees it, for the `@Name` a group message starts with. */
  botName?: (tenantId: string, agentId: string) => Promise<string | null>;
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

const BUSY = "员工这会儿正忙，稍后再试。";
/** How long a 退回's turn may take to start (admission, the thread's lock) before it is given up. */
export const START_TIMEOUT_MS = 30_000;
const PAUSED = "这位员工已暂停，恢复后再试。";
const GROUP_GONE = "这个群已经不在了，或这位员工已不在群里。";

const log = (type: string, detail: Record<string, unknown>) =>
  console.error(JSON.stringify({ type, ...detail }));

const reasonOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** Why a turn did not start, as the person is told it. */
function refusalOf(error: unknown): CardTurnRefused {
  if (error instanceof CardTurnRefused) return error;
  const name = error instanceof Error ? error.name : "";
  if (name === "BotPausedError") return new CardTurnRefused(PAUSED);
  // "Use Bots" switched off, or the model is not on the allowlist: the gate's own sentence.
  if (name === "CapabilityRefusedError" && error instanceof Error)
    return new CardTurnRefused(error.message);
  // The thread is held (somebody's turn), or the turn could not take it: try again later.
  return new ThreadBusy();
}

/** How a server-started turn on a card's thread is said and filed. */
export type ThreadTurnOrigin = {
  /** What the trail names as having started the turn (`TurnRunner`'s `routineId`). */
  source: string;
  /** The followed card the turn is a round of (`turnForCard`). */
  taskId?: string;
  initiator: AuditInitiator;
  telemetry: Parameters<TurnRunner>[0]["telemetry"];
  /** The message id's prefix, so the stored message says who put it there. */
  messagePrefix: string;
};

/**
 * Start a turn on a one-to-one thread with `text` as its message, and resolve once it has started
 * (past its admission, holding the thread) with its run id. A thread with a turn already running is
 * refused ({@link ThreadBusy}), never superseded: the runner would stop that turn for this one. A turn
 * not started within the timeout is stopped and refused the same way; any other refusal comes back as
 * a {@link CardTurnRefused} in words for the person. Nothing was said when it throws.
 *
 * Shared by the person's 退回 ({@link CardTurns.sendAsUser}) and the server's own rounds on a card
 * (`tasks/nudge-run.ts`): the same start, timeout and refusals, with a different voice.
 */
export async function startThreadTurn(
  deps: Pick<CardTurnsDeps, "runTurn" | "runner" | "startTimeoutMs">,
  tenantId: string,
  to: { threadId: string; agentId: string },
  text: string,
  origin: ThreadTurnOrigin,
): Promise<string> {
  // A turn already in flight on the thread would be superseded by this one: refused, not replaced.
  const busy = await runAsTenant(tenantId, async () => {
    await deps.runner.hydrate();
    return deps.runner.isRunning({ threadId: to.threadId });
  });
  if (busy) throw new ThreadBusy();

  // A uuid, because the thread lock wants one.
  const runId = randomUUID();
  const userMessage: Message = {
    id: `${origin.messagePrefix}:${runId}`,
    role: "user",
    content: text,
  };
  let began = false;
  // A turn that has not started in time (a lock that never comes) is given up, and stopped.
  const giveUp = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  await new Promise<void>((started, refused) => {
    timer = setTimeout(() => {
      if (began) return;
      refused(new ThreadBusy());
      giveUp.abort();
      void runAsTenant(tenantId, () =>
        deps.runner.stop({ threadId: to.threadId, runId }),
      ).catch(() => undefined);
    }, deps.startTimeoutMs ?? START_TIMEOUT_MS);
    // A round of the card named, not of whichever card the thread's coworker took on last.
    const taskId = origin.taskId;
    const forCard = <T>(body: () => T): T =>
      taskId ? turnForCard(taskId, body) : body();
    runAsTenant(tenantId, () =>
      forCard(() =>
        deps.runTurn({
          signal: giveUp.signal,
          ownerUserId: tenantId,
          routineId: origin.source,
          agentId: to.agentId,
          threadId: to.threadId,
          instruction: text,
          userMessage,
          runId,
          tenantId,
          initiator: origin.initiator,
          telemetry: origin.telemetry,
          onStarted: () => {
            began = true;
            started();
          },
        }),
      ),
    ).then(
      () => started(),
      (error) => {
        // Before the start, the caller hears why and says so; after it, the card records the round.
        if (!began) return refused(error);
        log("task-card-turn-ended-early", {
          runId,
          threadId: to.threadId,
          reason: reasonOf(error),
        });
      },
    );
  })
    .catch((error) => {
      throw refusalOf(error);
    })
    .finally(() => clearTimeout(timer));
  return runId;
}

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
  /** The group a card's thread belongs to, when it is a coworker's group thread with this person. */
  const groupOf = (tenantId: string, threadId: string, agentId: string) =>
    runAsTenant(tenantId, async () => {
      const [row] = await deps.database
        .select({ channelId: groupBotThreads.channelId })
        .from(groupBotThreads)
        .where(
          and(
            eq(groupBotThreads.ownerUserId, tenantId),
            eq(groupBotThreads.threadId, threadId),
            eq(groupBotThreads.agentId, agentId),
          ),
        )
        .limit(1);
      return row?.channelId ?? null;
    });

  /** Post to the group as the person, addressed to the coworker; refused in words when it cannot be. */
  const postToGroup = async (
    tenantId: string,
    channelId: string,
    agentId: string,
    text: string,
    taskId?: string,
  ): Promise<string> => {
    if (!deps.groupSend) throw new CardTurnRefused(GROUP_GONE);
    const name = await deps.botName?.(tenantId, agentId).catch(() => null);
    const id = randomUUID();
    try {
      await runAsTenant(tenantId, () =>
        // biome-ignore lint/style/noNonNullAssertion: checked above
        deps.groupSend!(
          tenantId,
          channelId,
          { id, text: name ? `@${name} ${text}` : text, agentId },
          taskId ? { taskId } : undefined,
        ),
      );
    } catch (error) {
      log("task-card-group-post-refused", {
        channelId,
        reason: reasonOf(error),
      });
      throw new CardTurnRefused(GROUP_GONE);
    }
    return id;
  };

  return {
    async sendAsUser(tenantId, to, text, options) {
      const channelId = await groupOf(tenantId, to.threadId, to.agentId);
      if (channelId)
        return {
          runId: null,
          groupMessageId: await postToGroup(
            tenantId,
            channelId,
            to.agentId,
            text,
            options?.taskId,
          ),
        };

      const runId = await startThreadTurn(deps, tenantId, to, text, {
        source: options?.source ?? "task-card",
        ...(options?.taskId ? { taskId: options.taskId } : {}),
        initiator: PERSON_INITIATOR,
        telemetry: { trigger: "human" },
        messagePrefix: "card-user",
      });
      return { runId, groupMessageId: null };
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

    async say(tenantId, where, event, groupText) {
      const channelId = await groupOf(tenantId, where.threadId, where.agentId);
      if (channelId) {
        await postToGroup(tenantId, channelId, where.agentId, groupText);
        return;
      }
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
