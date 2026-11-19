import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { computerWaits } from "../db/schema/computer-waits";
import { runAsTenant } from "../tenant/context";
import type { ComputerSeat } from "./computer-key";
import type { ComputerGateway } from "./gateway";

/**
 * A turn that asks a person at the computer waits for them, in the background (期九·三).
 *
 * Taking over the browser, typing one value into a field, and signing in used to stop the turn on the
 * spot: it ended waiting, parked in the review lane, and nothing carried it on when the person was done.
 * The browser had its own answer (the page held the tool call open and polled the computer), which a
 * closed page loses. Now the tool waits, on the server, up to {@link HANDOFF_WAIT_MS}: it polls the
 * computer's control state the way the page did, and when the person hands control back, or enters the
 * value, or cancels, it returns that as its result and the turn carries on.
 *
 * Past that time the turn ends as 「需要你」, as it always could, and the wait is written down
 * (`computer_waits`). A sweep reads the computer's state for each such wait and, once the person has
 * answered, continues the turn from where it stopped. Nothing is run again: the continuation is the
 * snapshot the turn left, with the outcome as the tool's result.
 *
 * Two lines are unchanged. The Bot never sees a secret: what the tool returns is whether a value was
 * entered, and the value goes from the person's keyboard to the page. And while a person holds the
 * wheel the Bot's own actions are still refused (`HumanHasControlError` in the gateway).
 */

/** How long the server holds a turn on a person: the same ten minutes the page waited for a secret. */
export const HANDOFF_WAIT_MS = 10 * 60_000;
/** How often a waiting tool asks the computer. */
export const WAIT_POLL_MS = 1_000;
/** How often the sweep looks at the waits that outlived their turn. */
export const WAIT_SWEEP_MS = 3_000;
/** A wait is left alone this long after it is written: its turn is still winding up. */
const WAIT_GRACE_MS = 5_000;
/** How long one resume may hold a wait before another sweep may take it: longer than a turn can run. */
const RESUME_LEASE_MS = 30 * 60_000;
/** A wait whose turn could not be carried on this many times is given up on, and said so in the log. */
export const MAX_RESUME_ATTEMPTS = 5;

export type ComputerWaitRecord = typeof computerWaits.$inferSelect;

export type ComputerWaitStore = {
  /** Write a wait down, in the owner's frame. */
  open(input: {
    ownerUserId: string;
    botId: string;
    kind: "help" | "secret";
    requestId?: string;
    label: string;
    toolCallId: string;
    threadId: string;
    continuation: unknown;
  }): Promise<ComputerWaitRecord>;
  /** Take one wait for the caller alone. False when somebody else has it or it is finished. */
  claim(id: string): Promise<boolean>;
  /** Take the waits that are due, from every tenant, for the sweep. */
  claimDue(input: { limit: number }): Promise<ComputerWaitRecord[]>;
  /** The person has not answered yet: give it back, without counting a try. */
  release(id: string): Promise<void>;
  /** The turn could not be carried on: give it back and count it. True when that was the last try. */
  retry(id: string): Promise<boolean>;
  finish(id: string): Promise<void>;
};

export function createComputerWaitStore(
  database: Database,
  /** How long a wait is left alone after it is written; a test passes 0. */
  options: { graceMs?: number } = {},
): ComputerWaitStore {
  const graceMs = options.graceMs ?? WAIT_GRACE_MS;
  return {
    async open(input) {
      const [row] = await database
        .insert(computerWaits)
        .values({
          ownerUserId: input.ownerUserId,
          botId: input.botId,
          kind: input.kind,
          requestId: input.requestId ?? null,
          label: input.label,
          toolCallId: input.toolCallId,
          threadId: input.threadId,
          continuation: input.continuation,
        })
        .returning();
      if (!row) throw new Error("The wait was not recorded.");
      return row;
    },
    async claim(id) {
      const rows = await database
        .update(computerWaits)
        .set({
          status: "resuming",
          leaseUntil: sql`now() + (${RESUME_LEASE_MS} * interval '1 millisecond')`,
        })
        .where(
          and(eq(computerWaits.id, id), eq(computerWaits.status, "waiting")),
        )
        .returning({ id: computerWaits.id });
      return rows.length > 0;
    },
    async claimDue({ limit }) {
      // The platform's frame reads and updates every tenant's rows; each is carried on in its own.
      return runAsTenant("platform", () => {
        const due = database
          .select({ id: computerWaits.id })
          .from(computerWaits)
          .where(
            and(
              sql`${computerWaits.createdAt} <= now() - (${graceMs} * interval '1 millisecond')`,
              or(
                eq(computerWaits.status, "waiting"),
                and(
                  eq(computerWaits.status, "resuming"),
                  sql`${computerWaits.leaseUntil} < now()`,
                ),
              ),
            ),
          )
          .orderBy(asc(computerWaits.createdAt))
          .limit(limit)
          .for("update", { skipLocked: true });
        return database
          .update(computerWaits)
          .set({
            status: "resuming",
            leaseUntil: sql`now() + (${RESUME_LEASE_MS} * interval '1 millisecond')`,
          })
          .where(inArray(computerWaits.id, due))
          .returning();
      });
    },
    async release(id) {
      await database
        .update(computerWaits)
        .set({ status: "waiting", leaseUntil: null })
        .where(
          and(eq(computerWaits.id, id), eq(computerWaits.status, "resuming")),
        );
    },
    async retry(id) {
      const [row] = await database
        .update(computerWaits)
        .set({
          attempts: sql`${computerWaits.attempts} + 1`,
          leaseUntil: null,
          status: sql`case when ${computerWaits.attempts} + 1 >= ${MAX_RESUME_ATTEMPTS} then 'done' else 'waiting' end`,
        })
        .where(eq(computerWaits.id, id))
        .returning({ attempts: computerWaits.attempts });
      return (row?.attempts ?? 0) >= MAX_RESUME_ATTEMPTS;
    },
    async finish(id) {
      await database
        .update(computerWaits)
        .set({ status: "done", finishedAt: new Date(), leaseUntil: null })
        .where(eq(computerWaits.id, id));
    },
  };
}

/** What a tool that waits on a person needs besides the gateway. */
export type ComputerWaiting = {
  store: ComputerWaitStore;
  /** How long the tool waits. Tests shorten it. */
  maxMs: number;
  /** How often it asks. Tests shorten it. */
  pollMs: number;
};

let configured: ComputerWaiting | undefined;

/**
 * Turn the background wait on for every server-run turn of this process (the deployment does, once).
 * Left unset, the tools stop at once as they did before. Pass nothing to turn it off again.
 */
export function configureComputerWaits(waiting?: ComputerWaiting): void {
  configured = waiting;
}

export function computerWaiting(): ComputerWaiting | undefined {
  return configured;
}

/** The gateway calls a wait reads the computer with. */
export type WaitGateway = Pick<ComputerGateway, "control" | "snapshot">;

export type Reading =
  | { open: true }
  | { open: false; result: Record<string, unknown> };

/**
 * What the Bot is told when the person hands control back after doing what it asked. The same words the
 * browser's tool says (`handedBack` in app/src/lib/computers/handoff.ts): the Bot reads this first and
 * is asked to say what it will do next, because a turn that ended in silence under the help request
 * read as a blank answer.
 */
export function handedBack(reason: string): string {
  return (
    `A person took control to do what you asked: "${reason}" They have finished and handed control back to you, ` +
    "and the snapshot here is the page as they left it. Carry on with the task now. Start your reply by telling the " +
    "person, in one short sentence, what you are doing next; if nothing is left to do, tell them it is done."
  );
}

/** Where a takeover request stands: still with the person, or over, and what the Bot is told if so. */
export async function readHandoff(
  gateway: WaitGateway,
  seat: ComputerSeat,
  request: { id: string; reason: string },
  signal?: AbortSignal,
): Promise<Reading> {
  const state = await gateway.control(seat, request.id);
  const current = state.request;
  if (!current || current.id !== request.id)
    return {
      open: false,
      result: {
        ok: false,
        requestId: request.id,
        reason:
          "The computer did not return the requested handoff. Nothing has been marked complete.",
      },
    };
  if (current.status === "waiting" || current.status === "taken")
    return { open: true };
  if (current.status === "completed") {
    const snapshot = await gateway.snapshot(seat, signal);
    return {
      open: false,
      result: {
        ok: true,
        result: handedBack(request.reason),
        handoffStatus: "completed",
        ...snapshot,
        requestId: request.id,
      },
    };
  }
  return {
    open: false,
    result: {
      ok: false,
      requestId: request.id,
      handoffStatus: current.status,
      reason:
        current.interruption ??
        `The handoff was ${current.status}. The person has not completed this request.`,
    },
  };
}

/**
 * Whether the masked box for one value is still open. The computer holds one at a time and clears it
 * when the value is typed in, when the person takes the wheel, and when it expires, and says nothing
 * of which; `late` is a turn that was carried on after the wait it had made, and says so.
 */
export async function readSecret(
  gateway: WaitGateway,
  seat: ComputerSeat,
  label: string,
  late = false,
): Promise<Reading> {
  const state = await gateway.control(seat);
  if (state.secretWanted !== undefined) return { open: true };
  return {
    open: false,
    result: {
      ok: true,
      result: late
        ? `The request for ${label} is closed: the person entered it into the field, or took control, or it ran out of time. You were not told what was entered. Take a snapshot to see the page before you go on, and do not ask for it another way.`
        : `The person has entered ${label} into the field. It was typed straight into the page and you were not told what it is.`,
    },
  };
}

/** Resolves after `ms`, or at once when the signal aborts. */
export function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

export type Waited =
  | { kind: "answered"; result: Record<string, unknown> }
  | { kind: "stopped" }
  | { kind: "timeout" };

/**
 * Ask until the person has answered, the turn is stopped, or `maxMs` has passed. A read that fails is
 * asked again: a computer that blinks does not end the wait, and one that stays unreachable ends it as
 * a timeout, which the durable wait then carries.
 */
export async function waitForPerson(options: {
  maxMs: number;
  pollMs: number;
  signal: AbortSignal;
  read: () => Promise<Reading>;
}): Promise<Waited> {
  const deadline = Date.now() + options.maxMs;
  for (;;) {
    // Stop must actually stop, including out of a wait.
    if (options.signal.aborted) return { kind: "stopped" };
    try {
      const reading = await options.read();
      if (!reading.open) return { kind: "answered", result: reading.result };
    } catch {
      // Asked again below.
    }
    if (Date.now() >= deadline) return { kind: "timeout" };
    await pause(
      Math.min(options.pollMs, Math.max(0, deadline - Date.now())),
      options.signal,
    );
  }
}

/**
 * The sweep that carries on a turn whose person answered after the turn stopped waiting.
 *
 * `resume` continues the turn with `content` as the tool's result and is not awaited by the tick: a
 * continued turn may run for twenty-five minutes, and the waits behind it must not wait for that.
 * The tick hands back what it started so a test can wait for it.
 */
export function createComputerWaitSweep(deps: {
  store: ComputerWaitStore;
  gateway: WaitGateway & Pick<ComputerGateway, "seatFor">;
  resume: (wait: ComputerWaitRecord, content: string) => Promise<void>;
  /** How many due waits one tick looks at. */
  batch?: number;
  log?: (line: Record<string, unknown>) => void;
}): { tick(): Promise<Promise<void>[]> } {
  const log =
    deps.log ??
    ((line: Record<string, unknown>) => console.warn(JSON.stringify(line)));
  return {
    async tick() {
      const due = await deps.store.claimDue({ limit: deps.batch ?? 10 });
      const started: Promise<void>[] = [];
      for (const wait of due) {
        const one = runAsTenant(wait.tenantId, async () => {
          let reading: Reading;
          try {
            const seat = await deps.gateway.seatFor(
              wait.botId,
              wait.ownerUserId,
            );
            reading =
              wait.kind === "help" && wait.requestId
                ? await readHandoff(deps.gateway, seat, {
                    id: wait.requestId,
                    reason: wait.label,
                  })
                : await readSecret(deps.gateway, seat, wait.label, true);
          } catch {
            // A computer that cannot be reached is not an answer, and is not a failed try either.
            await deps.store.release(wait.id).catch(() => undefined);
            return;
          }
          if (reading.open) {
            await deps.store.release(wait.id);
            return;
          }
          try {
            await deps.resume(wait, JSON.stringify(reading.result));
            await deps.store.finish(wait.id);
          } catch (error) {
            const gaveUp = await deps.store.retry(wait.id);
            log({
              type: gaveUp ? "computer-wait-abandoned" : "computer-wait-retry",
              wait: wait.id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        });
        started.push(one);
      }
      return started;
    },
  };
}
