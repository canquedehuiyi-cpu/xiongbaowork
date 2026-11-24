/**
 * Conversations that may only read: the pre-delivery reviewer's thread (XIONGBAO_PILOT_PLAN_APPROVAL).
 *
 * The gate asks here for every action that is not a read, so a reviewer run cannot change the work
 * it reviews whatever tool it reaches for. Kept in this process because the reviewer's turn runs in
 * it, inside the call that started it; entries are removed when that call ends.
 */
const readOnly = new Map<string, number>();

/** Hold `threadId` to reads until the returned function is called. */
export function restrictToReads(threadId: string): () => void {
  readOnly.set(threadId, (readOnly.get(threadId) ?? 0) + 1);
  return () => {
    const left = (readOnly.get(threadId) ?? 1) - 1;
    if (left <= 0) readOnly.delete(threadId);
    else readOnly.set(threadId, left);
  };
}

export const isReadOnlyThread = (threadId: string) => readOnly.has(threadId);
