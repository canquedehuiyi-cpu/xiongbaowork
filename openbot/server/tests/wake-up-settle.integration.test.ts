import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, like, sql } from "drizzle-orm";
import { createActivityStore } from "../src/activity/activity";
import { createWakeUpStore, WAKE_UP_KIND } from "../src/agents/wake-up";
import { createDatabase } from "../src/db/client";
import { workItems } from "../src/db/schema/work";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * How a follow-up's outcome is written onto its row, against a real PostgreSQL as the app role.
 *
 * `settle` used to append `JSON.stringify({ outcome })` with `||`, which the driver sent as a JSON
 * string, so the payload became `[{...payload}, "{\"outcome\":...}"]`: invisible to every
 * `payload->>'ownerUserId'` filter and with no readable outcome. These pin the object shape, that a
 * second settle replaces rather than nests, and that rows already in the array shape still read.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `wake-settle-${randomUUID()}`;
const owner = `${prefix}-owner`;
const bot = `${prefix}-bot`;
const scoped = <T>(fn: () => T) => runAsTenant(owner, fn);
const wakeUps = createWakeUpStore(database);

async function stored(id: string) {
  return await scoped(async () => {
    const [row] = await database
      .select({
        type: sql<string>`jsonb_typeof(${workItems.payload})`,
        payload: workItems.payload,
      })
      .from(workItems)
      .where(and(eq(workItems.kind, WAKE_UP_KIND), eq(workItems.key, id)));
    return row;
  });
}

async function schedule(reason: string) {
  return await scoped(
    async () =>
      await wakeUps.schedule({
        ownerUserId: owner,
        agentId: bot,
        reason,
        dueAt: new Date(Date.now() + 60 * 60_000),
      }),
  );
}

afterAll(async () => {
  await scoped(
    async () =>
      await database
        .delete(workItems)
        .where(
          and(
            eq(workItems.kind, WAKE_UP_KIND),
            like(workItems.key, `wake:%${prefix}%`),
          ),
        ),
  );
});

describe("settling a follow-up", () => {
  test("merges the outcome into the payload object", async () => {
    const record = await schedule("check the deploy");
    const outcome = {
      status: "succeeded" as const,
      at: new Date().toISOString(),
    };
    await scoped(async () => await wakeUps.settle(record.id, outcome));

    const row = await stored(record.id);
    expect(row?.type).toBe("object");
    expect(row?.payload).toMatchObject({
      ownerUserId: owner,
      agentId: bot,
      reason: "check the deploy",
      outcome,
    });
    const [listed] = (
      await scoped(async () => await wakeUps.list(owner, bot))
    ).filter((item) => item.id === record.id);
    expect(listed?.outcome).toEqual(outcome);
  });

  test("twice replaces the outcome rather than nesting it", async () => {
    const record = await schedule("check twice");
    await scoped(
      async () =>
        await wakeUps.settle(record.id, {
          status: "waiting",
          at: "2026-01-01T00:00:00.000Z",
          detail: "first",
        }),
    );
    const second = {
      status: "failed" as const,
      at: "2026-01-01T00:05:00.000Z",
      detail: "second",
    };
    await scoped(async () => await wakeUps.settle(record.id, second));

    const row = await stored(record.id);
    expect(row?.type).toBe("object");
    expect(row?.payload.outcome).toEqual(second);
    expect(Object.keys(row?.payload ?? {}).sort()).toEqual(
      [
        "agentId",
        "dueAt",
        "outcome",
        "ownerUserId",
        "reason",
        "scheduledAt",
      ].sort(),
    );
  });

  test("a row in the old array shape still reads, and settles back to an object", async () => {
    const id = `wake:${JSON.stringify([owner, bot])}:${prefix}-legacy`;
    const base = {
      ownerUserId: owner,
      agentId: bot,
      reason: "legacy follow-up",
      dueAt: "2026-01-01T00:00:00.000Z",
      scheduledAt: "2025-12-31T23:00:00.000Z",
    };
    // Settled twice by the old code: each outcome appended as another JSON string.
    const earlierOutcome = {
      status: "waiting",
      at: "2026-01-01T00:00:00.500Z",
      detail: "earlier",
    };
    const legacyOutcome = {
      status: "skipped",
      at: "2026-01-01T00:00:01.000Z",
      detail: "old shape",
    };
    await scoped(
      async () =>
        await database.insert(workItems).values({
          kind: WAKE_UP_KIND,
          key: id,
          runAt: new Date("2026-01-01T00:00:00.000Z"),
          finishedAt: new Date("2026-01-01T00:00:01.000Z"),
          payload: sql`jsonb_build_array(${base}::jsonb, to_jsonb(${JSON.stringify({ outcome: earlierOutcome })}::text), to_jsonb(${JSON.stringify({ outcome: legacyOutcome })}::text))`,
        }),
    );
    expect((await stored(id))?.type).toBe("array");

    const [listed] = (
      await scoped(async () => await wakeUps.list(owner, bot))
    ).filter((item) => item.id === id);
    expect(listed).toMatchObject({
      ...base,
      outcome: legacyOutcome,
      state: "done",
    });

    const activity = await scoped(
      async () => await createActivityStore(database).forBot(owner, bot),
    );
    expect(activity.completed.find((item) => item.id === id)).toMatchObject({
      kind: "follow_up",
      title: "legacy follow-up",
      detail: "old shape",
      status: "skipped",
    });

    const outcome = {
      status: "failed" as const,
      at: "2026-01-01T00:00:02.000Z",
    };
    await scoped(async () => await wakeUps.settle(id, outcome));
    const row = await stored(id);
    expect(row?.type).toBe("object");
    expect(row?.payload).toEqual({ ...base, outcome });
  });
});
