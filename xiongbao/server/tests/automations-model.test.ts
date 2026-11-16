import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { exhausted, hashTriggerSecret } from "../src/automations/store";
import {
  AutomationRefusedError,
  automationCreateSchema,
  automationTargetSchema,
  automationTriggerConfigSchema,
  createAutomationTargetRegistry,
  parseOrRefuse,
} from "../src/automations/types";

/**
 * D06 AUT1/AUT3/AUT4 without a database: what an automation may target, what may start it, and when
 * it has run out. The store and its real-PG suite (`automations-store.integration.test.ts`) build on
 * exactly these rules.
 */
describe("AUT3: what an automation may run", () => {
  test("a Waker or an existing WakerFlow, and nothing else", () => {
    expect(
      automationTargetSchema.parse({ kind: "waker", agentId: " bot-1 " }),
    ).toEqual({ kind: "waker", agentId: "bot-1" });
    const flowId = "7f3c2a10-5b7e-4c1d-9a2b-3c4d5e6f7a8b";
    expect(automationTargetSchema.parse({ kind: "wakerflow", flowId })).toEqual(
      { kind: "wakerflow", flowId },
    );
    for (const target of [
      { kind: "channel", channelId: "c1" },
      { kind: "waker", agentId: "" },
      { kind: "wakerflow", flowId: "not-a-flow" },
      { kind: "waker", agentId: "a", tenantId: "someone-else" },
      "waker",
    ]) {
      expect(automationTargetSchema.safeParse(target).success).toBe(false);
    }
  });

  test("a refusal reads in Chinese, whatever Zod would have said", () => {
    const refusal = () =>
      parseOrRefuse(
        automationCreateSchema,
        { name: "日报", target: { kind: "channel" } },
        "无法创建这个自动任务。",
      );
    expect(refusal).toThrow(AutomationRefusedError);
    expect(refusal).toThrow(/[一-鿿]/);
    expect(() =>
      parseOrRefuse(
        automationCreateSchema,
        { name: "日报", target: { kind: "waker", agentId: "a" }, owner: "x" },
        "无法创建这个自动任务。",
      ),
    ).toThrow("无法创建这个自动任务。");
  });

  test("the executor registry starts empty and takes one executor per kind", async () => {
    const registry = createAutomationTargetRegistry();
    expect(registry.get("wakerflow")).toBeUndefined();
    const seen: string[] = [];
    registry.register({
      kind: "wakerflow",
      async verify(target, frame) {
        seen.push(`${frame.tenantId}:${target.flowId}`);
      },
    });
    await registry
      .get("wakerflow")
      ?.verify(
        { kind: "wakerflow", flowId: "7f3c2a10-5b7e-4c1d-9a2b-3c4d5e6f7a8b" },
        { tenantId: "t1" },
      );
    expect(seen).toEqual(["t1:7f3c2a10-5b7e-4c1d-9a2b-3c4d5e6f7a8b"]);
    expect(() =>
      registry.register({ kind: "wakerflow", async verify() {} }),
    ).toThrow();
  });
});

describe("AUT1: what may start an automation", () => {
  test("a schedule, a one-off instant, or an event entry", () => {
    expect(
      automationTriggerConfigSchema.parse({
        kind: "schedule",
        cron: "0 9 * * 1-5",
        timezone: "Asia/Shanghai",
      }).kind,
    ).toBe("schedule");
    expect(
      automationTriggerConfigSchema.parse({
        kind: "once",
        at: "2030-01-01T09:00:00+08:00",
      }).kind,
    ).toBe("once");
    expect(automationTriggerConfigSchema.parse({ kind: "webhook" }).kind).toBe(
      "webhook",
    );
  });

  test("refuses an instant without a zone, a schedule without one, and a stored secret", () => {
    for (const config of [
      { kind: "once", at: "2030-01-01 09:00" },
      { kind: "schedule", cron: "0 9 * * *" },
      { kind: "webhook", secretHash: "abc" },
      { kind: "hourly" },
    ]) {
      expect(automationTriggerConfigSchema.safeParse(config).success).toBe(
        false,
      );
    }
  });
});

describe("AUT4: limits", () => {
  const now = new Date("2030-06-01T00:00:00Z");

  test("a cap or an end date that is reached stops the automation; none means no limit", () => {
    expect(
      exhausted({ maxRuns: null, runCount: 999, endDate: null }, now),
    ).toBe(null);
    expect(exhausted({ maxRuns: 3, runCount: 2, endDate: null }, now)).toBe(
      null,
    );
    expect(exhausted({ maxRuns: 3, runCount: 3, endDate: null }, now)).toBe(
      "max_runs",
    );
    expect(
      exhausted({ maxRuns: null, runCount: 0, endDate: new Date(now) }, now),
    ).toBe("end_date");
    expect(
      exhausted(
        {
          maxRuns: null,
          runCount: 0,
          endDate: new Date(now.getTime() + 1),
        },
        now,
      ),
    ).toBe(null);
    // The cap is final, so it is the reason given when both apply.
    expect(
      exhausted({ maxRuns: 1, runCount: 1, endDate: new Date(0) }, now),
    ).toBe("max_runs");
  });

  test("a cap is a positive whole number and an end date carries its zone", () => {
    const target = { kind: "waker", agentId: "a" };
    for (const maxRuns of [0, -1, 1.5, "3"]) {
      expect(
        automationCreateSchema.safeParse({ name: "n", target, maxRuns })
          .success,
      ).toBe(false);
    }
    expect(
      automationCreateSchema.safeParse({
        name: "n",
        target,
        endDate: "2030-01-01T00:00:00",
      }).success,
    ).toBe(false);
    const parsed = automationCreateSchema.parse({
      name: "n",
      target,
      maxRuns: 5,
      endDate: "2030-01-01T00:00:00+08:00",
    });
    expect(parsed.endDate).toEqual(new Date("2029-12-31T16:00:00Z"));
  });

  test("a trigger secret is stored as its SHA-256, never as itself", () => {
    const secret = "s3cret-value";
    expect(hashTriggerSecret(secret)).toBe(
      createHash("sha256").update(secret).digest("hex"),
    );
    expect(hashTriggerSecret(secret)).not.toContain(secret);
  });
});
