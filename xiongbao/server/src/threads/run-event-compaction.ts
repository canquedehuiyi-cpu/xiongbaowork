import { type BaseEvent, EventType } from "@ag-ui/client";

/**
 * Stored runs keep the stream's text and thinking in far fewer rows than the stream sent them.
 *
 * A model streams its answer, and in thinking mode its reasoning, one token at a time, and each token
 * is an event. A long reasoning turn is tens of thousands of them, which is tens of thousands of rows
 * to write and to read back on every cold start for text that is only ever shown joined. Consecutive
 * deltas of one message are therefore joined into a single delta before the run is stored.
 *
 * What stays exactly as the stream had it, so a replay is the live conversation:
 *  - the order of every event, and every event that is not a delta of the same message right next to
 *    the one before it (an interleaved message, a tool call, a custom event ends the run of deltas);
 *  - the joined text, which is the deltas' text in order;
 *  - the `timestamp` of the first delta of each joined run. The thinking block's seconds are read
 *    off the timestamps of the events around the text (`REASONING_START` / `REASONING_END`), which
 *    this never touches, and the first delta is the earliest moment the message had content.
 */
const JOINABLE = new Set<string>([
  EventType.TEXT_MESSAGE_CONTENT,
  EventType.REASONING_MESSAGE_CONTENT,
]);

type Delta = BaseEvent & { messageId?: unknown; delta?: unknown };

const PLAIN = new Set(["type", "messageId", "delta", "timestamp"]);

/** A delta that carries nothing but its text: one with metadata or a raw event of its own is kept. */
function joinable(event: BaseEvent): event is Delta {
  const { messageId, delta } = event as Delta;
  return (
    JOINABLE.has(event.type) &&
    typeof messageId === "string" &&
    typeof delta === "string" &&
    Object.keys(event).every((key) => PLAIN.has(key))
  );
}

/** The run's events with each stretch of same-message deltas joined into one event. */
export function compactRunEvents(events: readonly BaseEvent[]): BaseEvent[] {
  const joined: BaseEvent[] = [];
  let open: Delta | undefined;
  for (const event of events) {
    if (
      open &&
      joinable(event) &&
      event.type === open.type &&
      event.messageId === open.messageId
    ) {
      open = { ...open, delta: `${open.delta}${event.delta}` };
      joined[joined.length - 1] = open;
      continue;
    }
    joined.push(event);
    open = joinable(event) ? event : undefined;
  }
  return joined;
}
