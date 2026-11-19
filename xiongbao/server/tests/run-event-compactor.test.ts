import { describe, expect, test } from "bun:test";
import type { BaseEvent } from "@ag-ui/client";
import {
  compactRunEvents,
  createRunEventCompactor,
} from "../src/threads/run-event-compaction";

/*
 * A turn that is written while it runs is cut into pieces, and the pieces together must be what one
 * write of the whole turn is: the same rows, in the same order, whatever the cuts and wherever a
 * stretch of deltas that is still being joined falls across one.
 */

/** A small deterministic generator, so a failure names a seed and can be run again. */
function random(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
}

function stream(seed: number, length: number): BaseEvent[] {
  const next = random(seed);
  const events: BaseEvent[] = [];
  for (let n = 0; n < length; n += 1) {
    const roll = next();
    const messageId = `m${Math.floor(next() * 3)}`;
    if (roll < 0.55)
      events.push({
        type: "TEXT_MESSAGE_CONTENT",
        messageId,
        delta: `t${n}`,
        timestamp: n,
      } as BaseEvent);
    else if (roll < 0.8)
      events.push({
        type: "REASONING_MESSAGE_CONTENT",
        messageId,
        delta: `r${n}`,
        timestamp: n,
      } as BaseEvent);
    else if (roll < 0.85)
      // A delta with something besides its text is never joined.
      events.push({
        type: "TEXT_MESSAGE_CONTENT",
        messageId,
        delta: `x${n}`,
        rawEvent: { n },
      } as BaseEvent);
    else
      events.push({
        type: "TOOL_CALL_RESULT",
        toolCallId: `c${n}`,
        content: `${n}`,
      } as BaseEvent);
  }
  return events;
}

/** The turn fed in with a `take` after the events at these positions, then `end`. */
function inPieces(events: BaseEvent[], cuts: Set<number>): BaseEvent[] {
  const compactor = createRunEventCompactor();
  const stored: BaseEvent[] = [];
  events.forEach((event, at) => {
    compactor.push(event);
    if (cuts.has(at)) stored.push(...compactor.take());
  });
  stored.push(...compactor.end());
  return stored;
}

describe("a turn written in pieces", () => {
  test("is the rows one write of the whole turn makes, wherever it is cut", () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      const next = random(seed * 7);
      const events = stream(seed, 40 + Math.floor(next() * 400));
      const cuts = new Set<number>();
      for (let at = 0; at < events.length; at += 1)
        if (next() < 0.15) cuts.add(at);
      expect(inPieces(events, cuts)).toEqual(compactRunEvents(events));
    }
  });

  test("a cut after every single event, and none at all, store the same thing", () => {
    const events = stream(99, 500);
    const every = new Set(events.map((_, at) => at));
    expect(inPieces(events, every)).toEqual(compactRunEvents(events));
    expect(inPieces(events, new Set())).toEqual(compactRunEvents(events));
  });

  test("what a cut hands over is settled: the delta still being joined is held back", () => {
    const compactor = createRunEventCompactor();
    const delta = (text: string) =>
      ({
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "m",
        delta: text,
      }) as BaseEvent;
    compactor.push({ type: "TEXT_MESSAGE_START", messageId: "m" } as BaseEvent);
    compactor.push(delta("a"));
    compactor.push(delta("b"));
    expect(compactor.take()).toEqual([
      { type: "TEXT_MESSAGE_START", messageId: "m" } as BaseEvent,
    ]);
    // Taking again hands nothing over twice.
    expect(compactor.take()).toEqual([]);
    compactor.push(delta("c"));
    expect(compactor.end()).toEqual([delta("abc")]);
  });
});
