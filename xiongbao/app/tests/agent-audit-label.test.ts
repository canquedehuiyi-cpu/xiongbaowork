import { expect, test } from "bun:test";
import { auditEventLabel } from "@/components/agents/audit-trail";

test("a summoned coworker's trail says it was summoned, in words", () => {
  expect(auditEventLabel("bot.summoned")).toBe("召唤了这位员工");
});
