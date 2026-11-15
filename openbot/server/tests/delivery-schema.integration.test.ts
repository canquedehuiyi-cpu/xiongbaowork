import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { tasks } from "../src/db/schema";
import { appendTaskEvent, listTaskEvents } from "../src/tasks/events";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * 交付闭环第一步的数据底座（spec 2026-11-15-delivery-loop 第 3、7 节，迁移 0217）：`tasks` 的在跟列、
 * `cancelled` 状态，以及只追加的流水表 `task_events`。
 *
 * 连的是应用角色（`TEST_DATABASE_URL`），所以行级安全和 REVOKE 都是真的在起作用。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const tenantA = `loop-a-${suite}`;
const tenantB = `loop-b-${suite}`;

async function card(tenant: string): Promise<string> {
  const [row] = await runAsTenant(tenant, () =>
    database
      .insert(tasks)
      .values({ title: "核对发票", source: "chat", status: "running" })
      .returning({ id: tasks.id }),
  );
  return row.id;
}

/** Drizzle wraps a driver error as "Failed query"; the database's own words are on `cause`. */
async function refusal(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
  } catch (error) {
    const cause = (error as { cause?: { message?: string } }).cause;
    return cause?.message ?? (error as Error).message;
  }
  return "accepted";
}

afterAll(async () => {
  await database.$client.close();
});

describe("task_events is an append-only ledger", () => {
  test("task_events rejects UPDATE and DELETE for the app role", async () => {
    const taskId = await card(tenantA);
    await runAsTenant(tenantA, () =>
      appendTaskEvent(database, {
        tenantId: tenantA,
        taskId,
        kind: "dispatched",
        actor: "system",
      }),
    );
    expect(
      await refusal(() =>
        runAsTenant(tenantA, () =>
          database.execute(
            sql`UPDATE task_events SET kind = 'reviewed' WHERE task_id = ${taskId}`,
          ),
        ),
      ),
    ).toMatch(/permission denied/i);
    expect(
      await refusal(() =>
        runAsTenant(tenantA, () =>
          database.execute(
            sql`DELETE FROM task_events WHERE task_id = ${taskId}`,
          ),
        ),
      ),
    ).toMatch(/permission denied/i);
    const rows = await runAsTenant(tenantA, () =>
      listTaskEvents(database, { tenantId: tenantA, taskId }),
    );
    expect(rows.map((row) => row.kind)).toEqual(["dispatched"]);
  });

  test("task_events rows are tenant-isolated", async () => {
    const taskId = await card(tenantA);
    await runAsTenant(tenantA, () =>
      appendTaskEvent(database, {
        tenantId: tenantA,
        taskId,
        kind: "accepted",
        actor: "agent:小财",
        detail: { dueAt: "2026-11-15T10:00:00Z" },
      }),
    );
    const seenByB = await runAsTenant(tenantB, () =>
      listTaskEvents(database, { tenantId: tenantA, taskId }),
    );
    expect(seenByB).toEqual([]);
    await expect(
      runAsTenant(tenantB, () =>
        appendTaskEvent(database, {
          tenantId: tenantA,
          taskId,
          kind: "progress",
          actor: "system",
        }),
      ),
    ).rejects.toThrow();
  });

  test("events come back oldest first, with their detail", async () => {
    const taskId = await card(tenantA);
    for (const kind of ["dispatched", "accepted", "delivered"] as const) {
      await runAsTenant(tenantA, () =>
        appendTaskEvent(database, {
          tenantId: tenantA,
          taskId,
          kind,
          actor: "user:u1",
          detail: { kind },
        }),
      );
    }
    const rows = await runAsTenant(tenantA, () =>
      listTaskEvents(database, { tenantId: tenantA, taskId }),
    );
    expect(rows.map((row) => row.kind)).toEqual([
      "dispatched",
      "accepted",
      "delivered",
    ]);
    expect(rows[2].detail).toEqual({ kind: "delivered" });
    expect(rows[0].actor).toBe("user:u1");
  });
});

describe("the tasks columns of a tracked card", () => {
  test("cancelled is a valid task_status", async () => {
    const taskId = await card(tenantA);
    await runAsTenant(tenantA, () =>
      database
        .update(tasks)
        .set({ status: "cancelled" })
        .where(eq(tasks.id, taskId)),
    );
    const [row] = await runAsTenant(tenantA, () =>
      database.select().from(tasks).where(eq(tasks.id, taskId)),
    );
    expect(row.status).toBe("cancelled");
  });

  test("a card is untracked by default and the new columns start empty", async () => {
    const taskId = await card(tenantA);
    const [row] = await runAsTenant(tenantA, () =>
      database.select().from(tasks).where(eq(tasks.id, taskId)),
    );
    expect(row).toMatchObject({
      tracked: false,
      threadRef: null,
      acceptedAt: null,
      dueAt: null,
      originalDueAt: null,
      overdueAt: null,
      dueReported: false,
      criteria: null,
      lastError: null,
      nudges: 0,
      returns: 0,
    });
  });
});
