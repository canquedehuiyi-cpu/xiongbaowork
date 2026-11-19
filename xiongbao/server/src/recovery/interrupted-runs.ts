/**
 * Restart recovery for a conversation's turn: the turn a dead process was running is marked
 * interrupted, and the conversation says so (期九·二).
 *
 * A turn writes its events as it goes (`threads/run-event-writer.ts`), with `thread_run_liveness.status =
 * 'running'` and a heartbeat that every write moves forward. A process that stops leaves the row at
 * `running` with a heartbeat that never moves again. This sweep finds such rows, on the database's
 * clock, and for each one:
 *
 *  1. claims it with one conditional UPDATE (`running` to `interrupted`), so two replicas sweeping at
 *     once close it once;
 *  2. closes what the stored events left open (a half-said answer, a tool call nobody answered) and
 *     adds one sentence in Chinese saying the turn was cut off, with the 「继续」 reply the person can
 *     send, and a `turn-interrupted` event for a surface that wants to draw it;
 *  3. writes the thread's messages as of the turn's end, so the history holds what happened.
 *
 * NOTHING IS REPLAYED, and neither is any tool call: a step that was running may have spent money or
 * touched the computer, and running it again is the duplicate this exists not to cause. What a person
 * does after reading the sentence is say 「继续」, which starts a new turn that knows what was done.
 *
 * It is the same shape as the restart recovery in `abandoned-work.ts` (a conditional, database-clocked
 * UPDATE; nothing replayed; each row written in its own tenant's frame) but not a phase of that
 * sweep: that one runs once per five-minute bucket across the fleet, and a conversation should not
 * wait that long to be told. The age test here is the heartbeat's, a few missed beats rather than
 * ten minutes.
 *
 * MULTIPLE REPLICAS. A replica never marks a turn another live replica is running, because that turn's
 * heartbeat is fresh. The turn's live stream is in the memory of the process running it, so after a
 * restart, or on a replica that was not running it, a conversation reads the rows. Deploying more than
 * one replica needs a thread to stay on one of them (session affinity); see docs/restart-recovery.md.
 */
import { type BaseEvent, EventType, type Message } from "@ag-ui/client";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  INTERRUPTED_NOTICE,
  TURN_INTERRUPTED_EVENT,
} from "../../../shared/turn-notices";
import type { Database } from "../db/client";
import {
  threadRunEvents,
  threadRunLiveness,
  threadRuns,
  threads,
} from "../db/schema";
import { runAsTenant } from "../tenant/context";
import { openTracker } from "../threads/open-tracker";
import { FLUSH_EVERY_MS } from "../threads/run-event-writer";

/** A `running` turn whose heartbeat is older than this has no process behind it: six missed beats. */
export const RUN_STALE_MS = FLUSH_EVERY_MS * 6;
/** How often a replica looks. A restarted conversation hears within `RUN_STALE_MS` plus this. */
export const INTERRUPT_SWEEP_MS = 15_000;

/** The event the closing leaves in the turn, for whatever tells a person a turn was cut off. */
export { INTERRUPTED_NOTICE, TURN_INTERRUPTED_EVENT };

/** What a tool call that was running when the process stopped is answered with. */
export const INTERRUPTED_CALL =
  "服务重启时这一步正在执行，可能已经做了一部分，系统没有重新执行它。";

export type InterruptDeps = {
  database: Database;
  /** How old a heartbeat may be. Tests pass 0. */
  staleMs?: number;
  /**
   * The turn's card on the board, closed as failed: it was `running` for a turn that is over. A chat
   * card is otherwise never reclaimed by age (`tasks/reclaim.ts`).
   */
  closeCard?: (run: {
    tenantId: string;
    runId: string;
    threadId: string;
  }) => Promise<unknown>;
  /** Told once a turn is closed, so the process can put it into the conversation it holds in memory. */
  closed?: (run: {
    tenantId: string;
    runId: string;
    threadId: string;
  }) => Promise<unknown> | unknown;
};

type Said = Record<string, unknown> & { id: string; role: string };

/**
 * The thread's messages once `events` are applied to `prior`, as the turn's own agent would have held
 * them: what was asked, what was said and thought, the tool calls and their answers.
 *
 * Read off the events directly, in one pass. The client's own reducer clones the messages on every
 * event, which for a turn of tens of thousands of events takes minutes, and a sweep must not hold the
 * server that long. `tests/run-durability.integration.test.ts` checks it agrees with that reducer.
 */
export function messagesAfter(
  prior: Message[],
  events: BaseEvent[],
): Message[] {
  const messages: Said[] = structuredClone(prior) as Said[];
  const byId = new Map<string, Said>(messages.map((m) => [m.id, m]));
  const add = (message: Said) => {
    messages.push(message);
    byId.set(message.id, message);
  };
  const callOwner = new Map<string, Said & { toolCalls: Said[] }>();
  for (const event of events) {
    const e = event as BaseEvent & Record<string, unknown>;
    switch (e.type) {
      case EventType.RUN_STARTED: {
        const input = e.input as { messages?: Said[] } | undefined;
        for (const message of input?.messages ?? [])
          if (!byId.has(message.id)) add(structuredClone(message));
        break;
      }
      case EventType.MESSAGES_SNAPSHOT: {
        messages.length = 0;
        byId.clear();
        for (const message of (e.messages as Said[]) ?? [])
          add(structuredClone(message));
        break;
      }
      case EventType.TEXT_MESSAGE_START:
        add({
          id: String(e.messageId),
          role: String(e.role ?? "assistant"),
          content: "",
        });
        break;
      case EventType.REASONING_MESSAGE_START:
        add({ id: String(e.messageId), role: "reasoning", content: "" });
        break;
      case EventType.TEXT_MESSAGE_CONTENT:
      case EventType.REASONING_MESSAGE_CONTENT: {
        const message = byId.get(String(e.messageId));
        if (message && typeof e.delta === "string")
          message.content = `${String(message.content ?? "")}${e.delta}`;
        break;
      }
      case EventType.TOOL_CALL_START: {
        const parent =
          typeof e.parentMessageId === "string"
            ? byId.get(e.parentMessageId)
            : undefined;
        const owner = (parent ??
          (() => {
            const created = {
              id: String(e.parentMessageId ?? e.toolCallId),
              role: "assistant",
            } as Said;
            add(created);
            return created;
          })()) as Said & { toolCalls?: Said[] };
        owner.toolCalls ??= [];
        const call = {
          id: String(e.toolCallId),
          type: "function",
          function: { name: String(e.toolCallName), arguments: "" },
        } as unknown as Said;
        owner.toolCalls.push(call);
        callOwner.set(String(e.toolCallId), owner as never);
        break;
      }
      case EventType.TOOL_CALL_ARGS: {
        const call = callOwner
          .get(String(e.toolCallId))
          ?.toolCalls.find((candidate) => candidate.id === e.toolCallId) as
          | { function: { arguments: string } }
          | undefined;
        if (call && typeof e.delta === "string")
          call.function.arguments += e.delta;
        break;
      }
      case EventType.TOOL_CALL_RESULT:
        add({
          id: String(e.messageId),
          role: "tool",
          toolCallId: String(e.toolCallId),
          content: String(e.content ?? ""),
        });
        break;
    }
  }
  return messages as unknown as Message[];
}

/** The events that close a turn the stored ones left open, and say why it ended. */
export function interruptionEvents(
  stored: BaseEvent[],
  threadId: string,
  runId: string,
): BaseEvent[] {
  const seen = openTracker();
  for (const event of stored) seen.see(event);
  const events: BaseEvent[] = [];
  if (!seen.started)
    events.push({ type: EventType.RUN_STARTED, threadId, runId } as BaseEvent);
  events.push(...seen.closing(INTERRUPTED_CALL));
  const messageId = crypto.randomUUID();
  events.push(
    { type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" },
    {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId,
      delta: INTERRUPTED_NOTICE,
    },
    { type: EventType.TEXT_MESSAGE_END, messageId },
    {
      type: EventType.CUSTOM,
      name: TURN_INTERRUPTED_EVENT,
      value: { reason: "restart" },
    },
    { type: EventType.RUN_FINISHED, threadId, runId },
  );
  return events.map((event) => ({ timestamp: Date.now(), ...event }));
}

/** Mark the turns whose process is gone as interrupted. Returns how many were closed. */
export async function interruptStaleRuns(deps: InterruptDeps): Promise<number> {
  const staleMs = deps.staleMs ?? RUN_STALE_MS;
  const stale = sql`${threadRunLiveness.heartbeatAt} < now() - (${staleMs} * interval '1 millisecond')`;
  // Found in the platform's frame, which reads every tenant's rows; each is written in its own.
  const found = await runAsTenant("platform", () =>
    deps.database
      .select({
        id: threadRunLiveness.runId,
        tenantId: threadRunLiveness.tenantId,
        threadId: threadRuns.threadId,
      })
      .from(threadRunLiveness)
      .innerJoin(threadRuns, eq(threadRuns.id, threadRunLiveness.runId))
      .where(and(eq(threadRunLiveness.status, "running"), stale)),
  );
  let closed = 0;
  for (const run of found) {
    try {
      /*
       * One transaction: the claim, the closing events and the history land together or not at all,
       * so a process that dies in the middle of this leaves the turn `running` for the next pass.
       */
      const done = await runAsTenant(run.tenantId, () =>
        deps.database.transaction(async (transaction) => {
          const [claimed] = await transaction
            .update(threadRunLiveness)
            .set({ status: "interrupted" })
            .where(
              and(
                eq(threadRunLiveness.runId, run.id),
                eq(threadRunLiveness.status, "running"),
                stale,
              ),
            )
            .returning({ id: threadRunLiveness.runId });
          // Another replica closed it first, or its process came back and wrote again.
          if (!claimed) return false;
          const rows = await transaction
            .select({ seq: threadRunEvents.seq, event: threadRunEvents.event })
            .from(threadRunEvents)
            .where(
              and(
                eq(threadRunEvents.threadId, run.threadId),
                eq(threadRunEvents.runId, run.id),
              ),
            )
            .orderBy(asc(threadRunEvents.seq));
          const stored = rows.map((row) => row.event as BaseEvent);
          const closing = interruptionEvents(stored, run.threadId, run.id);
          const next =
            rows.length === 0 ? 0 : (rows[rows.length - 1]?.seq ?? -1) + 1;
          const [header] = await transaction
            .select({ messages: threads.messagesSnapshot })
            .from(threads)
            .where(eq(threads.id, run.threadId))
            .limit(1);
          const messages = messagesAfter(
            (header?.messages ?? []) as Message[],
            [...stored, ...closing],
          );
          await transaction
            .insert(threadRunEvents)
            .values(
              closing.map((event, offset) => ({
                threadId: run.threadId,
                runId: run.id,
                seq: next + offset,
                event,
              })),
            )
            .onConflictDoNothing();
          await transaction
            .update(threadRuns)
            .set({ eventCount: next + closing.length })
            .where(eq(threadRuns.id, run.id));
          await transaction
            .update(threads)
            .set({ messagesSnapshot: messages, updatedAt: new Date() })
            .where(eq(threads.id, run.threadId));
          return true;
        }),
      );
      if (!done) continue;
      closed += 1;
      const ref = {
        tenantId: run.tenantId,
        runId: run.id,
        threadId: run.threadId,
      };
      await Promise.resolve(deps.closeCard?.(ref)).catch((error) =>
        console.error("interrupted turn's card not closed", run.id, error),
      );
      await Promise.resolve(deps.closed?.(ref)).catch((error) =>
        console.error("interrupted turn not adopted", run.id, error),
      );
    } catch (error) {
      // One turn that cannot be closed must not keep the others from it; the next pass tries again.
      console.error("interrupted turn not closed", run.id, error);
    }
  }
  return closed;
}
