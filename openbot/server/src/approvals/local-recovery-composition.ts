import { createApprovalLocalRecoveryPort } from "../routines/run-turn";
import type { ApprovalRecoveryPort } from "./types";

export type LocalRecoveryWiring = Readonly<
  Omit<Parameters<typeof createApprovalLocalRecoveryPort>[0], "authorityDatabase" | "release"> & {
    authorityPool: Parameters<typeof createApprovalLocalRecoveryPort>[0]["authorityDatabase"] | null;
    release: NonNullable<Parameters<typeof createApprovalLocalRecoveryPort>[0]["release"]> | null;
  }
>;

// Match the durable continuation store's existing lease range.
export const LOCAL_RECOVERY_MAX_LEASE_MS = 900_000;
export const AP_LOCAL_RECOVERY_UNWIRED: ApprovalRecoveryPort | null = null;

/**
 * Internal composition only. No request/config flag is mapped to this object.
 * Constructing a port does not attest a release or enable persistence: recover()
 * must still verify the saved plan and the real authority on every use.
 */
export function composeLocalRecovery(
  wiring: LocalRecoveryWiring | null | undefined,
): ApprovalRecoveryPort | null {
  if (!wiring) return null;
  const { database, authorityPool, release, leaseMs } = wiring;
  if (!database || !authorityPool || authorityPool === database || !release)
    return null;
  if (
    !Number.isSafeInteger(leaseMs) ||
    leaseMs < 1 ||
    leaseMs > LOCAL_RECOVERY_MAX_LEASE_MS
  )
    return null;
  let worker: unknown;
  try {
    worker = wiring.workerId();
  } catch {
    return null;
  }
  if (typeof worker !== "string" || !worker.trim()) return null;
  const workerId = worker.trim();
  // Snapshot the internal dependencies once; later caller mutation cannot swap
  // a loader or runner after the composition boundary has accepted them.
  const { runner, loadPersistedPlan, prepareExactInput } = wiring;
  if (
    !runner ||
    typeof runner.runContinuation !== "function" ||
    typeof loadPersistedPlan !== "function" ||
    typeof prepareExactInput !== "function"
  )
    return null;
  return createApprovalLocalRecoveryPort({
    database,
    authorityDatabase: authorityPool,
    release,
    leaseMs,
    workerId: () => workerId,
    runner: { runContinuation: runner.runContinuation.bind(runner) },
    loadPersistedPlan,
    prepareExactInput,
  });
}
