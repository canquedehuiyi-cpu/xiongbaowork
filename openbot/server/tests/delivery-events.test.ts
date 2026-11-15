import { expect, test } from "bun:test";
import { deliveryMarkOf } from "../src/channels/group";
import { DELIVERY_EVENTS } from "../src/tasks/delivery-events";
import { DELIVERY_EVENTS as FROM_TOOLS } from "../src/tasks/delivery-tools";

/**
 * 交付卡的事件名只写在一个不引任何东西的模块里（`tasks/delivery-events.ts`），员工工具和群聊的状态标记
 * 都从那里读，不会再出现两份。
 */
test("员工工具放的卡和群聊记标记认的是同一组事件名；答复延期的事件不记", () => {
  expect(FROM_TOOLS).toBe(DELIVERY_EVENTS);
  const at = new Date("2026-11-15T03:00:00.000Z");
  const value = {
    taskId: "t1",
    dueAt: "2026-11-15T08:00:00.000Z",
    criteria: "保密",
    reason: "保密",
    deliverable: { kind: "deliverable", notes: ["保密"] },
  };
  const { extensionDecided, ...cards } = DELIVERY_EVENTS;
  expect(deliveryMarkOf(extensionDecided, value, "a1", at)).toBeNull();
  expect(
    Object.values(cards).map((name) => deliveryMarkOf(name, value, "a1", at)),
  ).toEqual([
    {
      kind: "accepted",
      taskId: "t1",
      at: at.toISOString(),
      agentId: "a1",
      dueAt: value.dueAt,
    },
    {
      kind: "extension_requested",
      taskId: "t1",
      at: at.toISOString(),
      agentId: "a1",
      dueAt: value.dueAt,
    },
    { kind: "delivered", taskId: "t1", at: at.toISOString(), agentId: "a1" },
    { kind: "bounced", taskId: "t1", at: at.toISOString(), agentId: "a1" },
  ]);
  expect(deliveryMarkOf(cards.delivered, {}, "a1", at)).toBeNull();
});
