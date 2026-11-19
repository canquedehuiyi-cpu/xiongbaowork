import type { DeliverableRef } from "./projector";

/**
 * What a turn that ends without a hand-in leaves on its card (`channels/dispatch.ts`, `channels/group.ts`):
 * the card moves to 等验收 by itself, and this is the evidence it carries so the person reviewing it can see
 * the work -- the workspace files its coworker wrote in this card's rounds (`tasks/evidence-gate.ts`
 * `workspaceFilesOf`).
 */
export type AutoDeliveryReader = {
  /** The workspace files the card's coworker wrote; see `RunFiles` in `tasks/evidence-gate.ts`. */
  workspaceFilesOf?(tenantId: string, runRef: string): Promise<string[]>;
  /**
   * Resolves once the run's events are all in the database, false when it gave up waiting (`whenRunPersisted`
   * in `threads/postgres-runner.ts`). The turn's stream has ended by then but its last events are written a
   * moment later, and a file written in the last seconds of the turn is among them.
   */
  eventsPersisted?(runId: string): Promise<boolean>;
};

/**
 * The hand-in a card ends with, or undefined for none: nothing when no reader is wired, when the
 * coworker wrote no file, or when they cannot be read -- the card moves on either way, as it did before
 * it carried any. When the run's events were not all written in time, what is there is read, and said.
 */
export async function autoDeliverable(
  reader: AutoDeliveryReader,
  tenantId: string,
  runId: string,
  log: (type: string, detail: Record<string, unknown>) => void,
): Promise<DeliverableRef | undefined> {
  if (!reader.workspaceFilesOf) return undefined;
  try {
    if (reader.eventsPersisted && !(await reader.eventsPersisted(runId)))
      log("auto-delivery-events-late", { runId });
    const files = await reader.workspaceFilesOf(tenantId, runId);
    return files.length > 0
      ? { kind: "deliverable", workspaceFiles: files }
      : undefined;
  } catch (error) {
    log("auto-delivery-files-unreadable", {
      runId,
      reason: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}
