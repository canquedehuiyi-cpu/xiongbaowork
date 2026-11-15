import type { BaseEvent } from "@ag-ui/client";
import { Observable } from "rxjs";

/**
 * Events a server tool adds to the run it is called in.
 *
 * A tool answers its call with a string, which is all the model needs. Some calls also change what
 * the person should see in the conversation -- the delivery loop's 接活回执, 延期申请 and 交付卡
 * (spec 2026-11-15-delivery-loop §4) -- and those are AG-UI `CUSTOM` events the chat draws. They have
 * to ride in the run's own stream, not beside it: the runner stores and persists exactly what the
 * stream carried (`threads/postgres-runner.ts`), so an event added here is in the live conversation,
 * in the stored thread, and in the history a reload replays, like any other event of the run.
 *
 * KEYED BY RUN ID, NOT BY ASYNC CONTEXT. A built-in Bot's tools run from the provider stream's flush,
 * where Bun has dropped the async frame the run started in (`@openbot/toolkit/native-approval`), so a
 * tool finds its run by the id it was called with, and the agent's stream registers itself under that
 * id while it is open. A run id names one run, and one run is one stream.
 */

type OpenRun = {
  emit(event: BaseEvent): void;
  /** Every event the run has carried so far, its own and the ones added here. */
  seen: BaseEvent[];
};

const open = new Map<string, OpenRun>();

/**
 * The run's stream, with room for the events its tools add. While it is subscribed, an event sent to
 * {@link emitRunEvent} under `runId` goes out in it, in order with the run's own; once the stream
 * ends, nothing more is added. Wrap the agent's own stream, so the events pass through the agent's
 * bookkeeping like the ones the model produced.
 */
export function withRunSideEvents(
  runId: string,
  stream: Observable<BaseEvent>,
): Observable<BaseEvent> {
  return new Observable<BaseEvent>((subscriber) => {
    const run: OpenRun = {
      seen: [],
      emit(event) {
        if (subscriber.closed) return;
        run.seen.push(event);
        subscriber.next(event);
      },
    };
    open.set(runId, run);
    const close = () => {
      if (open.get(runId) === run) open.delete(runId);
    };
    const inner = stream.subscribe({
      next(event) {
        run.seen.push(event);
        subscriber.next(event);
      },
      error(error) {
        close();
        subscriber.error(error);
      },
      complete() {
        close();
        subscriber.complete();
      },
    });
    return () => {
      close();
      inner.unsubscribe();
    };
  });
}

/** Add an event to the open run `runId`. False when no such run is open here (nothing is sent). */
export function emitRunEvent(runId: string, event: BaseEvent): boolean {
  const run = open.get(runId);
  if (!run) return false;
  run.emit(event);
  return true;
}

/**
 * What the open run `runId` has carried so far, or nothing when it is not open here. For a check
 * that has to see what this very run did before its events are stored (the stored copy is written
 * when the run ends).
 */
export function runEventsSoFar(runId: string): readonly BaseEvent[] {
  return open.get(runId)?.seen ?? [];
}
