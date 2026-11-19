/**
 * What the runner knows about a turn in flight that the delivery loop's tools need: which card the
 * turn's entry filed for it, and which followed cards were taken on during it and so need the turn's
 * end written on them (spec 2026-11-15-delivery-loop §1-§2).
 *
 * An entry that opens its own card -- a routine, a responsibility, a hop, a check-in, an automation, a
 * pipeline step, a group coworker's answer -- runs its turn with the runner's card suppressed, and
 * closes its card itself with `board.finished`, which leaves a followed card alone. When the coworker
 * calls `accept_task` in such a turn, the card becomes followed mid-turn, and nothing on the entry's
 * path would write that round's progress and end. The runner does, for every card registered here,
 * when the turn ends: one place for every entry, rather than one per entry.
 *
 * In memory and per process: the tool runs in the process that runs the turn, and the registry lives
 * exactly as long as the turn does (`beginTurn` .. `endTurn`, both the runner's).
 */

type Turn = {
  /** The key the entry filed its card under, when it is not the run id (a routine's firing). */
  entryCardRef?: string;
  /** Followed cards whose round is this turn, by id, with their tenant. */
  rounds: Map<string, string>;
};

const turns = new Map<string, Turn>();

/** The runner starts a turn. */
export function beginTurn(runId: string, entryCardRef?: string): void {
  turns.set(runId, {
    ...(entryCardRef ? { entryCardRef } : {}),
    rounds: new Map(),
  });
}

/** The runner ends a turn: the cards whose round it was, for their end to be written. */
export function endTurn(runId: string): { tenantId: string; taskId: string }[] {
  const turn = turns.get(runId);
  turns.delete(runId);
  return [...(turn?.rounds ?? [])].map(([taskId, tenantId]) => ({
    tenantId,
    taskId,
  }));
}

/** The key of the card the turn's entry filed for it, when it named one. */
export function entryCardRefOf(runId: string): string | undefined {
  return turns.get(runId)?.entryCardRef;
}

/** A card taken on in this turn: its round ends when the turn does. No-op outside a runner's turn. */
export function roundOnCard(
  runId: string,
  tenantId: string,
  taskId: string,
): void {
  turns.get(runId)?.rounds.set(taskId, tenantId);
}
