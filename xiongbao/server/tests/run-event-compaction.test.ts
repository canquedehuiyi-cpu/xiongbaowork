import { describe, expect, test } from "bun:test";
import type { BaseEvent } from "@ag-ui/client";
import { compactRunEvents } from "../src/threads/run-event-compaction";

const at = (n: number) => 1_700_000_000_000 + n;

function reasoning(messageId: string, delta: string, n: number): BaseEvent {
  return {
    type: "REASONING_MESSAGE_CONTENT",
    messageId,
    delta,
    timestamp: at(n),
  } as BaseEvent;
}

function text(messageId: string, delta: string, n: number): BaseEvent {
  return {
    type: "TEXT_MESSAGE_CONTENT",
    messageId,
    delta,
    timestamp: at(n),
  } as BaseEvent;
}

function marker(type: string, n: number, extra: object = {}): BaseEvent {
  return { type, timestamp: at(n), ...extra } as BaseEvent;
}

describe("compacting a run's events before they are stored", () => {
  test("consecutive deltas of one message become one, with the first one's timestamp", () => {
    const events = [
      marker("RUN_STARTED", 0),
      marker("REASONING_START", 1, { messageId: "r" }),
      marker("REASONING_MESSAGE_START", 2, {
        messageId: "r",
        role: "reasoning",
      }),
      reasoning("r", "Let me ", 3),
      reasoning("r", "think ", 4),
      reasoning("r", "about it.", 5),
      marker("REASONING_MESSAGE_END", 6, { messageId: "r" }),
      marker("REASONING_END", 7, { messageId: "r" }),
      text("t", "Hel", 8),
      text("t", "lo", 9),
      marker("RUN_FINISHED", 10),
    ];
    const kept = compactRunEvents(events);
    expect(kept.map((event) => event.type)).toEqual([
      "RUN_STARTED",
      "REASONING_START",
      "REASONING_MESSAGE_START",
      "REASONING_MESSAGE_CONTENT",
      "REASONING_MESSAGE_END",
      "REASONING_END",
      "TEXT_MESSAGE_CONTENT",
      "RUN_FINISHED",
    ]);
    expect(kept[3]).toEqual(reasoning("r", "Let me think about it.", 3));
    expect(kept[6]).toEqual(text("t", "Hello", 8));
    // The events the thinking seconds are read from are untouched.
    expect(kept[1]).toBe(events[1] as BaseEvent);
    expect(kept[5]).toBe(events[7] as BaseEvent);
  });

  test("anything between two deltas, or a different message or kind, keeps them apart and in order", () => {
    const events = [
      text("a", "1", 0),
      text("b", "2", 1),
      text("a", "3", 2),
      reasoning("a", "4", 3),
      marker("CUSTOM", 4, { name: "x", value: 1 }),
      reasoning("a", "5", 5),
    ];
    expect(compactRunEvents(events)).toEqual(events);
  });

  test("a delta that carries more than its text is kept as it was sent", () => {
    const events = [
      text("a", "1", 0),
      { ...text("a", "2", 1), metadata: { k: 1 } } as BaseEvent,
      text("a", "3", 2),
    ];
    expect(compactRunEvents(events)).toEqual(events);
  });

  test("no events, and events with nothing to join, come back as they were", () => {
    expect(compactRunEvents([])).toEqual([]);
    const events = [marker("RUN_STARTED", 0), marker("RUN_FINISHED", 1)];
    expect(compactRunEvents(events)).toEqual(events);
  });

  test("a hundred thousand deltas are one event with the text in order", () => {
    const deltas = Array.from({ length: 100_000 }, (_, n) =>
      reasoning("r", `${n},`, n),
    );
    const kept = compactRunEvents(deltas);
    expect(kept).toHaveLength(1);
    const first = kept[0] as BaseEvent & { delta: string; timestamp: number };
    expect(first.delta).toBe(
      deltas.map((e) => (e as never as { delta: string }).delta).join(""),
    );
    expect(first.timestamp).toBe(at(0));
  });
});
