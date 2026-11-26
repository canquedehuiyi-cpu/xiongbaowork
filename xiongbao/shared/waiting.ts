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

/** What an interrupt's metadata says the run waits on; undefined when it says nothing. */
export function waitingIn(
  metadata: Record<string, unknown> | undefined,
): unknown {
  return metadata?.[XIONGBAO_WAITING_METADATA];
}
