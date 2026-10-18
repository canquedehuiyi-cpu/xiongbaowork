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
const store = new AsyncLocalStorage<true>();

/**
 * Run `body`, and let the turns it starts write the thread without also filing a card.
 *
 * `body` is called synchronously inside the frame, so everything it awaits inherits it — which is why
 * the entries wrap the region that SUBSCRIBES to the run rather than the expression that builds the
 * observable: `Observable` is lazy, and the card is opened at subscribe time.
 */
export function suppressRunnerCard<T>(body: () => T): T {
  return store.run(true, body);
}

/** Whether the turn now being accepted belongs to an entry that already opened its own card. */
export function runnerCardSuppressed(): boolean {
  return store.getStore() === true;
}
