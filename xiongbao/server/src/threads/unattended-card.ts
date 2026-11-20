import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Whose card a turn's board row is.
 *
 * `PostgresAgentRunner` opens a `chat` card for every turn it is handed, because for the turn a person
 * starts in a browser that is the only card there is — and it is charged once, by that same row. An
 * unattended entry is different: a routine firing, a crew's step, a responsibility run and a hop each
 * open a card of their own FIRST (`routines/runner.ts`, `pipeline/store.ts`, `responsibilities/engine.ts`,
 * `agents/handoff-delivery.ts`), so a turn that reaches the runner unmarked is board work counted twice
 * and, worse, spent twice against the tenant's monthly ceiling (Free is 50 tasks, so the real number
 * was 25 — audit N10, ticket WP-1.2).
 *
 * ASYNC LOCAL STORAGE RATHER THAN A FIELD ON THE REQUEST. The marker must not be something a caller can
 * put on the wire: `RunAgentInput.forwardedProps` is read straight out of the browser's request body, so
 * a flag riding there is a flag anybody can set to stop being charged for their own conversation. This
 * store can only be entered by server code that imports it, which is exactly the set of entries that own
 * a card — and nothing else ever does.
 *
 * Read once, at the top of `run()`, and carried down as a value: a stream's later callbacks are re-entered
 * by the agent's own machinery, whose async frame was opened when the run's socket was created, not when
 * this turn was asked for. Asking the store after that point would answer `false` for a turn that is
 * unattended, which is the bug wearing the shape of a flake.
 */
const store = new AsyncLocalStorage<{ cardRef?: string }>();

/**
 * Run `body`, and let the turns it starts write the thread without also filing a card.
 *
 * `body` is called synchronously inside the frame, so everything it awaits inherits it — which is why
 * the entries wrap the region that SUBSCRIBES to the run rather than the expression that builds the
 * observable: `Observable` is lazy, and the card is opened at subscribe time.
 */
export function suppressRunnerCard<T>(
  body: () => T,
  /**
   * The key the entry filed its card under (`tasks.run_ref`), when that is not the turn's run id: a
   * routine's card is keyed by its firing, not by the turn. Read by the delivery loop's `accept_task`,
   * which follows the turn's own card. Absent, the card is keyed by the run id.
   */
  cardRef?: string,
): T {
  return store.run(cardRef ? { cardRef } : {}, body);
}

/** Whether the turn now being accepted belongs to an entry that already opened its own card. */
export function runnerCardSuppressed(): boolean {
  return store.getStore() !== undefined;
}

/** The key of the entry's own card, when the entry named one; read where `runnerCardSuppressed` is. */
export function suppressedCardRef(): string | undefined {
  return store.getStore()?.cardRef;
}

const hung = new AsyncLocalStorage<true>();

/**
 * Run `body` -- an entry's turn -- as a round the entry has already hung on a followed card
 * (`tasks/delivery.ts` `attachRun`), as a group turn does before it starts. The runner asks whether
 * such a round's card still waits for its 接活回执 only then: no other entry that owns its card hangs
 * the turn on a followed one, so for them the question is not asked at all.
 */
export function roundHungByEntry<T>(body: () => T): T {
  return hung.run(true, body);
}

/** Whether the turn running here is one an entry hung on a followed card first. */
export function entryHungRound(): boolean {
  return hung.getStore() === true;
}

const targeted = new AsyncLocalStorage<string>();

/**
 * Run `body` -- a turn the person's decision on one followed card starts (a 退回) -- as a round of
 * THAT card. The runner otherwise hangs a turn on the thread's newest open followed card
 * (`tasks/delivery.ts` `openTrackedCard`), and a coworker with two open cards on one thread would
 * have the 修正轮次 of the older one land on the newer: its progress, its approvals and its
 * `deliver_task` all on the wrong card. Server code only, for the reason the marker above is.
 */
export function turnForCard<T>(taskId: string, body: () => T): T {
  return targeted.run(taskId, body);
}

/** The followed card the turn now being accepted was started for, if one was named. */
export function targetedCard(): string | undefined {
  return targeted.getStore();
}

const idleOnly = new AsyncLocalStorage<true>();

/**
 * Run `body` -- a turn the server starts on a conversation by itself (a nudge, a hand-over, a 退回
 * said for the person) -- as one that may only start while the thread is idle. The runner otherwise
 * supersedes whatever is running there; such a turn is refused instead (`ThreadBusyError`), and the
 * question "is anything running or on its way in?" is answered in the same step that admits the turn,
 * so a person's turn that started a moment ago is never stopped by it. Server code only.
 */
export function onlyOnIdleThread<T>(body: () => T): T {
  return idleOnly.run(true, body);
}

/** Whether the turn now being accepted may only start on an idle thread. */
export function onlyOnIdleThreadRequested(): boolean {
  return idleOnly.getStore() === true;
}

const personChat = new AsyncLocalStorage<true>();

/**
 * Run `body` as a person's own chat request: what the browser sent to the runtime. Set where that request
 * is handled (`mountCopilotRuntime`), and nowhere else, so a turn is a person's chat turn because it
 * arrived that way and not because of what it did or did not file: a group's turn, a routine's, a card's
 * round and a hop to another employee all start from server code outside it. Read by the runner when it
 * is handed the turn, to tell the observers what kind it is (期 2: only a person's chat is read for
 * memories).
 */
export function asPersonChat<T>(body: () => T): T {
  return personChat.run(true, body);
}

/** Whether the turn now being accepted arrived as a person's own chat request. See {@link asPersonChat}. */
export function personChatRequested(): boolean {
  return personChat.getStore() === true;
}
