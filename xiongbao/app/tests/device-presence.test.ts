import { expect, test } from "bun:test";
import {
  ownerPresence,
  presenceOf,
  presenceWord,
} from "@/lib/devices/presence";
import type { RegisteredDevice } from "@/lib/devices/queries";

/**
 * Spec F4's two readings: a task's own machine (its `deviceId`, against this person's device list),
 * and, where no task binds one, the owner's machines as a count.
 */
const machine = (
  deviceId: string,
  name: string,
  online: boolean,
): RegisteredDevice => ({
  id: `row-${deviceId}`,
  deviceId,
  name,
  platform: null,
  lastSeenAt: null,
  online,
});

const DEVICES = [
  machine("d-1", "studio", true),
  machine("d-2", "laptop", false),
];

test("a task's machine is named with its presence; no binding is no answer", () => {
  expect(presenceOf("d-1", DEVICES)).toEqual({ name: "studio", online: true });
  expect(presenceOf("d-2", DEVICES)).toEqual({ name: "laptop", online: false });
  expect(presenceOf(null, DEVICES)).toBeNull();
  expect(presenceOf(undefined, DEVICES)).toBeNull();
});

test("a machine the list does not know is not called offline", () => {
  // Unpaired since, or the list has not answered: named by its id, presence unknown.
  expect(presenceOf("0123456789abcdef", DEVICES)).toEqual({
    name: "01234567",
    online: null,
  });
  expect(presenceOf("d-1", undefined)).toEqual({ name: "d-1", online: null });
  expect(presenceWord(null)).toBe("状态未知");
  expect(presenceWord(true)).toBe("在线");
  expect(presenceWord(false)).toBe("离线");
});

test("the owner's presence counts their machines, and is nothing without any", () => {
  expect(ownerPresence(DEVICES)).toEqual({ online: 1, total: 2 });
  expect(ownerPresence([])).toBeNull();
  expect(ownerPresence(undefined)).toBeNull();
});
