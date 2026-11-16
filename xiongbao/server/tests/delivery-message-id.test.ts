import { expect, test } from "bun:test";
import { deliveryMessageId } from "../src/delivery/message-id";

test("微信来的那条用户消息 ID 带 wechat 来源，其他渠道保持原样", () => {
  expect(deliveryMessageId("wechat", "run-1")).toBe("delivery:wechat:run-1");
  expect(deliveryMessageId("slack", "run-1")).toBe("delivery:run-1");
  expect(deliveryMessageId("teams", "run-1")).toBe("delivery:run-1");
  expect(deliveryMessageId("sms", "run-1")).toBe("delivery:run-1");
});
