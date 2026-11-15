import { expect, test } from "bun:test";
import { type BaseEvent, EventType } from "@ag-ui/client";
import { isServerOnlyEvent } from "../src/threads/run-side-events";

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
