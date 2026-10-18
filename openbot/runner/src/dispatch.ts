import type { ActionOutcome, RunnerAction } from "./execute";
import type { createActionJournal } from "./journal";

/** Cancellation refers to the same durable action key as dispatch, including across reconnects. */
export function createRunnerDispatcher(
  journal: ReturnType<typeof createActionJournal>,
  execute: (action: RunnerAction) => Promise<ActionOutcome>,
) {
  const controllers = new Map<string, AbortController>();
  return async (
    scope: string,
    frame: Record<string, unknown>,
    send: (frame: Record<string, unknown>) => void,
  ) => {
    const key = typeof frame.key === "string" ? frame.key : "";
    const identity = JSON.stringify([scope, key]);
    if (frame.type === "cancel") {
      controllers.get(identity)?.abort();
      return;
    }
    if (frame.type !== "action" || typeof frame.id !== "string") return;
    const existing = controllers.get(identity);
    const controller = existing ?? new AbortController();
    if (!existing) controllers.set(identity, controller);
    try {
      const outcome = await journal.execute(
        scope,
        key,
        { action: String(frame.action ?? ""), payload: frame.payload },
        (action) => execute({ ...action, signal: controller.signal }),
      );
      send({ type: "result", id: frame.id, ...outcome });
    } finally {
      if (!existing && controllers.get(identity) === controller)
        controllers.delete(identity);
    }
  };
}
