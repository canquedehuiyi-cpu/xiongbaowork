/**
 * Where a run that stopped to wait for a person carries what it waits on: the key on its AG-UI
 * interrupt's `metadata`.
 *
 * ONE DECLARATION, READ FROM BOTH SIDES. The server sets it on every interrupt it raises for an
 * approval, a question or a sign-in (toolkit/headless-tools.ts, toolkit/native-approval.ts), and the
 * server answers every one of them itself: the person decides on a card, and the server carries the
 * conversation on (approvals/resume-sweep.ts). The browser reads the same key to know that an
 * interrupt it replayed is one it must never try to resume (see `serverOwnedInterrupt` in
 * app/src/lib/copilot/server-owned-interrupts.ts).
 */
export const XIONGBAO_WAITING_METADATA = "xiongbaoWaiting";

/**
 * The same key before v0.2.16. The v0.2.16 migration rewrites stored history to the key above
 * (recovery 0241); this is read, never written, for a run a v0.2.15 process finished meanwhile.
 * legacy-compat：introducedIn 0.2.16，removeIn 0.2.17
 */
export const LEGACY_WAITING_METADATA = "openbotWaiting";

/** What an interrupt's metadata says the run waits on, under either key; undefined when it says nothing. */
export function waitingIn(
  metadata: Record<string, unknown> | undefined,
): unknown {
  return (
    metadata?.[XIONGBAO_WAITING_METADATA] ?? metadata?.[LEGACY_WAITING_METADATA]
  );
}
