import { type BaseEvent, EventType } from "@ag-ui/client";
import { concat, concatMap, defer, filter, Observable, of } from "rxjs";

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
 *
 * THE SAME CHANNEL CARRIES THE TURN'S STAGES. A built-in turn has always said which boundary it
 * crossed — a run opening, a call starting, an answer starting — but only as the events themselves,
 * which the browser has to read together to guess what a wait is for. `withRunStages` below marks
 * those same boundaries with a `CUSTOM run.stage` event of its own, at the event that begins them, so
 * the stage a person is looking at is stored and replayed like anything else the run said.
 */

/**
 * Events only the server may put in a run: the delivery loop's cards (`delivery.*`). Drawn as
 * "已交成果" and the like, so one an agent's own stream carries -- an external coworker's endpoint can
 * send any event it likes -- is a forgery, and is dropped before anything stores or shows it. The
 * real ones enter through {@link emitRunEvent}, after the agent's stream has been cleaned.
 */
export function isServerOnlyEvent(event: BaseEvent): boolean {
  if (event.type !== EventType.CUSTOM) return false;
  const name = (event as BaseEvent & { name?: unknown }).name;
  // However it is cased or padded: the chat would draw " Delivery.delivered" as the same card.
  return (
    typeof name === "string" &&
    name.trim().toLowerCase().startsWith("delivery.")
  );
}

/** An agent's own stream without the events only the server may send. */
export function withoutServerOnlyEvents(
  stream: Observable<BaseEvent>,
): Observable<BaseEvent> {
  return stream.pipe(filter((event) => !isServerOnlyEvent(event)));
}

/**
 * The stage a built-in turn is in, as the run's own stream says it.
 *
 * Three, because three are the boundaries this channel really has: a run opened, which is the turn
 * waiting on the model (and again when the last tool has answered and the model is asked with its
 * results), a tool call starting, an answer starting. Reading the context is not one of them — nothing
 * on this side of the runtime says when the prompt was assembled, and inventing a beat for it would be
 * a heartbeat, which this is not. Where no stage has arrived, the browser keeps saying what it has
 * always said while a turn has nothing to show (`Thinking`).
 */
export type RunStage = "model" | "tool" | "answer";

/** The events that begin a stage. Any other event changes nothing. */
const STAGE_STARTED_BY: Record<string, RunStage | undefined> = {
  [EventType.TOOL_CALL_START]: "tool",
  [EventType.TEXT_MESSAGE_START]: "answer",
  /*
   * A tool having answered puts the turn back in the model's hands, which is the wait this channel was
   * added for: five steps sit finished on screen and the person has nothing to read while the model
   * takes them in. It is said once however many results arrive before the next request answers — the
   * stage is what the turn is doing, not a count of calls.
   */
  [EventType.TOOL_CALL_RESULT]: "model",
};

/**
 * The run's stream with its stage boundaries marked, as `CUSTOM run.stage` events of `{stage, seq}`
 * said at the event that begins each one.
 *
 * Only a change of stage is said: a turn that opens five tool calls marks one 执行工具, not five, and the
 * results of those five mark one 调用模型, not five. `seq` counts the marks of THIS run from one up, so a
 * stored thread can tell the marks of one turn from the marks of the next when both are replayed; what
 * orders them is the order they arrive in, which is the order they are stored and replayed in.
 *
 * The mark of the first stage follows `RUN_STARTED` rather than preceding it: a run is read as
 * beginning with that event, and nothing this server adds belongs in front of it.
 *
 * The marks ride the run's own stream, which is what puts them in the stored thread and in a reload's
 * replay like anything the run said (`threads/postgres-runner.ts`). They are not in
 * {@link isServerOnlyEvent}: that gate exists to drop what an agent's own stream claims about the
 * delivery loop, and dropping these would drop the server's own marks too — a stage a browser may draw
 * is a fact about the turn, not a card only the server may hand out.
 */
export function withRunStages(
  stream: Observable<BaseEvent>,
): Observable<BaseEvent> {
  return defer(() => {
    let said: RunStage | null = null;
    let seq = 0;
    return stream.pipe(
      concatMap((event) => {
        // 一轮开头就是「在等模型」：这一件事实由 RUN_STARTED 说，不靠流的订阅点。
        const stage =
          event.type === EventType.RUN_STARTED
            ? "model"
            : STAGE_STARTED_BY[event.type];
        if (stage === undefined || stage === said) return of(event);
        said = stage;
        seq += 1;
        const mark = {
          type: EventType.CUSTOM,
          name: "run.stage",
          value: { stage, seq },
        } as BaseEvent;
        return event.type === EventType.RUN_STARTED
          ? concat(of(event), of(mark))
          : concat(of(mark), of(event));
      }),
    );
  });
}

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
 *
 * The turn's stage marks ({@link withRunStages}) are drawn out of the same stream here, before the
 * events the tools add arrive, so a person watching a turn live, a thread opened later, and a history
 * replayed after a reload all read one order: a stage, what began it, and whatever the run's own tools
 * handed the conversation along the way.
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
    const inner = withRunStages(stream).subscribe({
      next(event) {
        // The run's own stream may not carry the server's cards; only `emitRunEvent` adds them.
        if (isServerOnlyEvent(event)) return;
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
