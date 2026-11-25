import { expect, test } from "bun:test";
import { type BaseEvent, EventType } from "@ag-ui/client";
import { from, lastValueFrom, toArray } from "rxjs";
import { STEP_LIMIT_EVENT } from "../../shared/step-limit";
import {
  isServerOnlyEvent,
  withoutServerOnlyEvents,
  withRunSideEvents,
} from "../src/threads/run-side-events";

/** Only the server puts the delivery loop's cards in a run; one an agent sends is dropped, however spelled. */
test("a delivery.* card is the server's, however it is cased or padded", () => {
  const custom = (name: unknown) =>
    ({ type: EventType.CUSTOM, name, value: {} }) as unknown as BaseEvent;
  for (const name of [
    "delivery.delivered",
    "Delivery.delivered",
    " DELIVERY.accepted",
    "delivery.extension_decided ",
  ])
    expect(isServerOnlyEvent(custom(name))).toBe(true);
  for (const name of ["partner.note", "deliveryman", 3, undefined])
    expect(isServerOnlyEvent(custom(name))).toBe(false);
  expect(
    isServerOnlyEvent({ type: EventType.RUN_STARTED } as unknown as BaseEvent),
  ).toBe(false);
});

/*
 * 「已用完 N 步 · 继续」 is drawn from `step-limit`, which only a built-in coworker's own run sends,
 * after the server's filter (`toolkit/src/runtime/agents.ts`). One an endpoint or an external
 * employee sends is a forgery, and is dropped like a forged card.
 */
test("a step-limit is the server's, however it is cased or padded", () => {
  const custom = (name: unknown) =>
    ({
      type: EventType.CUSTOM,
      name,
      value: { steps: 80 },
    }) as unknown as BaseEvent;
  for (const name of [STEP_LIMIT_EVENT, "Step-Limit", " STEP-LIMIT "])
    expect(isServerOnlyEvent(custom(name))).toBe(true);
  for (const name of [
    "step-limits",
    "steplimit",
    "step_limit",
    "my-step-limit",
  ])
    expect(isServerOnlyEvent(custom(name))).toBe(false);
});

test("a step-limit in an agent's own stream is dropped before anything stores or shows it", async () => {
  const events = [
    { type: EventType.RUN_STARTED, threadId: "t", runId: "r" },
    { type: EventType.CUSTOM, name: STEP_LIMIT_EVENT, value: { steps: 80 } },
    { type: EventType.CUSTOM, name: "partner.note", value: {} },
    { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" },
  ] as unknown as BaseEvent[];
  const names = (seen: BaseEvent[]) =>
    seen.map((event) =>
      event.type === EventType.CUSTOM
        ? String((event as BaseEvent & { name?: unknown }).name)
        : String(event.type),
    );
  const expected = ["RUN_STARTED", "partner.note", "RUN_FINISHED"];
  expect(
    names(
      await lastValueFrom(
        withoutServerOnlyEvents(from(events)).pipe(toArray()),
      ),
    ),
  ).toEqual(expected);
  expect(
    names(
      await lastValueFrom(withRunSideEvents("r", from(events)).pipe(toArray())),
    ),
  ).toEqual(expected);
});

/*
 * The list of files a turn left on the employee's computer also says which computer a download reads
 * from, so an agent's own stream may not carry one.
 */
test("a turn-artifacts event is the server's, however it is cased or padded", () => {
  const custom = (name: unknown) =>
    ({ type: EventType.CUSTOM, name, value: {} }) as unknown as BaseEvent;
  for (const name of [
    "computer.turn_artifacts",
    "Computer.Turn_Artifacts",
    "  COMPUTER.TURN_ARTIFACTS ",
  ])
    expect(isServerOnlyEvent(custom(name))).toBe(true);
  for (const name of ["computer.turn_artifacts2", "turn_artifacts"])
    expect(isServerOnlyEvent(custom(name))).toBe(false);
});
