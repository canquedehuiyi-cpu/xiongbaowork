import { Observable } from "rxjs";

/**
 * Who is looking at a conversation right now, counted by the streams the server holds open for it.
 *
 * A page that watches a thread holds one of two connections: the run it started (the runtime answers a
 * run with a stream that lasts as long as the turn), or the reconnect it made to join a turn already
 * under way (`connect`). Both end the moment the page goes: closing the tab, a laptop lid, a phone
 * losing signal. So the number of those streams that are open on a thread is the number of pages that
 * will hear the turn's end as it happens, and when it is zero nobody does (`threads/turn-notice.ts`
 * tells the person some other way).
 *
 * Counted in this process, which is the process that runs the turn: a turn's live stream is in the
 * memory of the process running it, and a deployment of more than one replica keeps a thread on one of
 * them (docs/restart-recovery.md). Keyed by the tenant as well as the thread, so a count is only ever
 * read for the person whose thread it is.
 */

const open = new Map<string, number>();

const keyOf = (tenantId: string, threadId: string) =>
  `${tenantId}\u0000${threadId}`;

/** One more stream is watching the thread; the returned function says it stopped. Safe to call twice. */
export function watchThread(tenantId: string, threadId: string): () => void {
  const key = keyOf(tenantId, threadId);
  open.set(key, (open.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (open.get(key) ?? 1) - 1;
    if (left > 0) open.set(key, left);
    else open.delete(key);
  };
}

/** How many streams are watching the thread now. Zero for a thread nobody has opened. */
export function threadViewers(tenantId: string, threadId: string): number {
  return open.get(keyOf(tenantId, threadId)) ?? 0;
}

/**
 * `stream` as a stream that counts its subscribers as watchers of the thread for as long as each stays
 * subscribed: from subscription to completion, error or unsubscription, whichever comes first.
 */
export function watched<T>(
  tenantId: string,
  threadId: string,
  stream: Observable<T>,
): Observable<T> {
  return new Observable<T>((subscriber) => {
    const release = watchThread(tenantId, threadId);
    const inner = stream.subscribe(subscriber);
    return () => {
      inner.unsubscribe();
      release();
    };
  });
}
