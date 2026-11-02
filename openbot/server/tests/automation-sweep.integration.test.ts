import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, like } from "drizzle-orm";
import { createAutomationStore } from "../src/automations/store";
import {
  AUTOMATION_FIRE_KIND,
  type AutomationFiringExecutor,
  type AutomationSweepOptions,
  dispatchClaimedAutomations,
  minuteKey,
  offerDueAutomations,
} from "../src/automations/sweep";
import { createDatabase } from "../src/db/client";
import {
  agents,
  automationFirings,
  automations,
  automationTriggers,
  workItems,
} from "../src/db/schema";
import { nextOccurrence } from "../src/routines/schedule";
import { currentTenant, runAsTenant } from "../src/tenant/context";
import { createWorkQueue } from "../src/work/queue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * D06 AUT1/AUT4 scheduling against real PostgreSQL and the real `work_items` queue, as the
 * application role under 0117's forced policies. The executor is a fake that records what it was
 * handed and in which tenant frame; no model is ever dialled.
 *
 * THIS FILE OWNS `AUTOMATION_FIRE_KIND`: every row of that kind is deleted before each test, so a
 * second file offering it would race this one. Put such tests here.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createAutomationStore(database);
const queue = createWorkQueue(database);
const suite = randomUUID().slice(0, 8);
const tenantA = `aut-sweep-${suite}-a`;
const tenantB = `aut-sweep-${suite}-b`;
const wakerA = `aut-sweep-${suite}-waker-a`;
const wakerB = `aut-sweep-${suite}-waker-b`;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/*
 * Daily, at the UTC hour twelve hours away from now: the next occurrence after a recent minute is
 * never itself already due, whatever time of day the suite runs.
 */
const DAILY_CRON = `0 ${(new Date().getUTCHours() + 12) % 24} * * *`;
const DAILY = { kind: "schedule", cron: DAILY_CRON, timezone: "UTC" };
const created: { tenant: string; id: string }[] = [];

const as = <T>(tenant: string, run: () => Promise<T>): Promise<T> =>
  runAsTenant(tenant, run);

type Executed = { firingId: string; automationId: string; tenant: string };
let executed: Executed[] = [];
const recordingExecutor: AutomationFiringExecutor = async (firing) => {
  executed.push({
    firingId: firing.id,
    automationId: firing.automation.id,
    tenant: currentTenant(),
  });
  await store.finishFiring(firing.id, "succeeded");
};

function options(
  overrides: Partial<AutomationSweepOptions> = {},
): AutomationSweepOptions {
  return {
    store,
    queue,
    executors: { waker: recordingExecutor },
    owner: `automation-sweep-test-${suite}`,
    ...overrides,
  };
}

/** A whole minute in the recent past: due by the database's clock and well inside the grace. */
function recentMinute(): Date {
  return new Date(Math.floor(Date.now() / MINUTE) * MINUTE - MINUTE);
}

async function seedAgent(tenant: string, id: string) {
  await as(tenant, async () => {
    await database.insert(agents).values({
      id,
      tenantId: tenant,
      name: `${id} 熊宝`,
      type: "built_in",
      configuration: {},
    });
  });
}

async function createFor(
  tenant: string,
  waker: string,
  extra: { maxRuns?: number | null } = {},
) {
  const automation = await as(tenant, () =>
    store.create({
      name: `巡检 ${randomUUID().slice(0, 4)}`,
      target: { kind: "waker", agentId: waker },
      ...extra,
    }),
  );
  created.push({ tenant, id: automation.id });
  return automation;
}

async function addTrigger(
  tenant: string,
  automationId: string,
  config: unknown,
) {
  const { trigger } = await as(tenant, () =>
    store.addTrigger(automationId, config),
  );
  return trigger;
}

/** Puts a trigger's clock at `at`, as if that moment had come. */
async function makeDue(tenant: string, triggerId: string, at: Date) {
  await as(tenant, async () => {
    await database
      .update(automationTriggers)
      .set({ nextRunAt: at })
      .where(eq(automationTriggers.id, triggerId));
  });
}

async function rawTrigger(tenant: string, id: string) {
  const [row] = await as(tenant, async () => {
    return await database
      .select()
      .from(automationTriggers)
      .where(eq(automationTriggers.id, id));
  });
  return row;
}

async function rawAutomation(tenant: string, id: string) {
  const [row] = await as(tenant, async () => {
    return await database
      .select()
      .from(automations)
      .where(eq(automations.id, id));
  });
  return row;
}

async function firingsOf(tenant: string, automationId: string) {
  return await as(tenant, async () => {
    return await database
      .select()
      .from(automationFirings)
      .where(eq(automationFirings.automationId, automationId));
  });
}

async function itemsFor(triggerId: string) {
  return await as("platform", async () => {
    return await database
      .select()
      .from(workItems)
      .where(
        and(
          eq(workItems.kind, AUTOMATION_FIRE_KIND),
          like(workItems.key, `${triggerId}:%`),
        ),
      );
  });
}

beforeAll(async () => {
  await seedAgent(tenantA, wakerA);
  await seedAgent(tenantB, wakerB);
});

beforeEach(async () => {
  executed = [];
  await as("platform", async () => {
    await database
      .delete(workItems)
      .where(eq(workItems.kind, AUTOMATION_FIRE_KIND));
  });
});

afterAll(async () => {
  // Nothing this file made may stay due for another file's sweep.
  for (const { tenant, id } of created) {
    await as(tenant, () => store.softDelete(id)).catch(() => false);
  }
  await as("platform", async () => {
    await database
      .delete(workItems)
      .where(eq(workItems.kind, AUTOMATION_FIRE_KIND));
  });
});

describe("the minute key", () => {
  test("is pinned literally: UTC, truncated to the minute", () => {
    expect(minuteKey(new Date("2026-08-26T09:30:59.999Z"))).toBe(
      "2026-08-26T09:30Z",
    );
    expect(minuteKey(new Date("2026-08-26T17:30:00+08:00"))).toBe(
      "2026-08-26T09:30Z",
    );
  });
});

describe("offering due triggers (AUT1)", () => {
  test("a due schedule is offered once, in its owner's tenant, and its clock moves once", async () => {
    const automation = await createFor(tenantA, wakerA);
    const trigger = await addTrigger(tenantA, automation.id, DAILY);
    const due = recentMinute();
    await makeDue(tenantA, trigger.id, due);

    const first = await offerDueAutomations(options());
    expect(first.offered).toContain(automation.id);
    // The clock moved past the moment, from the stamp: the next occurrence after it.
    const advanced = await rawTrigger(tenantA, trigger.id);
    expect(advanced?.nextRunAt?.toISOString()).toBe(
      nextOccurrence(DAILY_CRON, "UTC", due).toISOString(),
    );
    expect(advanced?.enabled).toBe(true);
    const second = await offerDueAutomations(options());
    expect(second.offered).not.toContain(automation.id);

    // A replica that read the same stamp before the clock moved collides on the same key.
    await makeDue(tenantA, trigger.id, due);
    await offerDueAutomations(options());

    const items = await itemsFor(trigger.id);
    expect(items).toHaveLength(1);
    expect(items[0]?.key).toBe(`${trigger.id}:${minuteKey(due)}`);
    expect(items[0]?.key).toMatch(/:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/);
    // Stamped with the owner the trigger row names, never the sweep's platform frame.
    expect(items[0]?.tenantId).toBe(tenantA);
    expect(items[0]?.payload).toEqual({
      automationId: automation.id,
      triggerId: trigger.id,
      triggerKind: "schedule",
      scheduledFor: due.toISOString(),
    });
  });

  test("a one-off fires once and switches itself off", async () => {
    const automation = await createFor(tenantA, wakerA);
    const trigger = await addTrigger(tenantA, automation.id, {
      kind: "once",
      at: new Date(Date.now() + HOUR).toISOString(),
    });
    await makeDue(tenantA, trigger.id, recentMinute());

    expect((await offerDueAutomations(options())).offered).toContain(
      automation.id,
    );
    const after = await rawTrigger(tenantA, trigger.id);
    expect(after?.enabled).toBe(false);
    expect(after?.nextRunAt).toBeNull();
    expect(after?.lastError).toBeNull();

    const report = await dispatchClaimedAutomations(options());
    expect(report.fired).toEqual([automation.id]);
    expect(executed.map((run) => run.automationId)).toEqual([automation.id]);
    expect((await offerDueAutomations(options())).offered).not.toContain(
      automation.id,
    );
  });

  test("a stale stamp is not replayed: a schedule jumps ahead, a missed one-off says so", async () => {
    const automation = await createFor(tenantA, wakerA);
    const schedule = await addTrigger(tenantA, automation.id, DAILY);
    const once = await addTrigger(tenantA, automation.id, {
      kind: "once",
      at: new Date(Date.now() + HOUR).toISOString(),
    });
    const stale = new Date(Date.now() - 3 * HOUR);
    await makeDue(tenantA, schedule.id, stale);
    await makeDue(tenantA, once.id, stale);

    const report = await offerDueAutomations(options());
    expect(report.offered).not.toContain(automation.id);
    expect(await itemsFor(schedule.id)).toHaveLength(0);
    expect(await itemsFor(once.id)).toHaveLength(0);

    const jumped = await rawTrigger(tenantA, schedule.id);
    expect(jumped?.nextRunAt?.getTime()).toBeGreaterThan(Date.now());
    const missed = await rawTrigger(tenantA, once.id);
    expect(missed?.enabled).toBe(false);
    expect(missed?.nextRunAt).toBeNull();
    expect(missed?.lastError).toBe("一次性触发错过了预定时间，没有执行。");
  });

  test("a switched-off automation's triggers are not due", async () => {
    const automation = await createFor(tenantA, wakerA);
    const trigger = await addTrigger(tenantA, automation.id, DAILY);
    await as(tenantA, () => store.setEnabled(automation.id, false));
    await makeDue(tenantA, trigger.id, recentMinute());

    expect((await offerDueAutomations(options())).offered).not.toContain(
      automation.id,
    );
    expect(await itemsFor(trigger.id)).toHaveLength(0);
  });
});

describe("dispatching firings (AUT1, AUT4)", () => {
  test("a claimed firing is counted, recorded and run in the owner's frame", async () => {
    const automation = await createFor(tenantA, wakerA);
    const trigger = await addTrigger(tenantA, automation.id, DAILY);
    const due = recentMinute();
    await makeDue(tenantA, trigger.id, due);
    await offerDueAutomations(options());

    const report = await dispatchClaimedAutomations(options());
    expect(report.fired).toEqual([automation.id]);
    expect(executed).toHaveLength(1);
    expect(executed[0]?.tenant).toBe(tenantA);

    expect((await rawAutomation(tenantA, automation.id))?.runCount).toBe(1);
    const firings = await firingsOf(tenantA, automation.id);
    expect(firings).toHaveLength(1);
    expect(firings[0]).toMatchObject({
      id: executed[0]?.firingId,
      tenantId: tenantA,
      triggerId: trigger.id,
      externalId: `due:${minuteKey(due)}`,
      fingerprint: `${trigger.id}:${minuteKey(due)}`,
      target: { kind: "waker", agentId: wakerA },
      status: "succeeded",
    });
    // The queue's part is over: nothing left to claim.
    expect((await dispatchClaimedAutomations(options())).considered).toBe(0);
  });

  test("handed off, the firing is counted and recorded before the turn runs", async () => {
    const automation = await createFor(tenantA, wakerA);
    const trigger = await addTrigger(tenantA, automation.id, DAILY);
    await makeDue(tenantA, trigger.id, recentMinute());
    await offerDueAutomations(options());

    const handedOff: (() => Promise<void>)[] = [];
    const report = await dispatchClaimedAutomations(
      options({ background: (run) => handedOff.push(run) }),
    );
    // The pass is over and nothing has run yet, but the firing already counts and the item is done.
    expect(report.fired).toEqual([automation.id]);
    expect(handedOff).toHaveLength(1);
    expect(executed).toHaveLength(0);
    expect((await rawAutomation(tenantA, automation.id))?.runCount).toBe(1);
    expect((await firingsOf(tenantA, automation.id))[0]?.status).toBe(
      "running",
    );
    expect((await dispatchClaimedAutomations(options())).considered).toBe(0);

    // Run later from an unframed timer, it still runs in the owner's frame.
    await handedOff[0]?.();
    expect(executed).toHaveLength(1);
    expect(executed[0]?.tenant).toBe(tenantA);
    expect((await firingsOf(tenantA, automation.id))[0]?.status).toBe(
      "succeeded",
    );
  });

  test("a redelivered firing of the same moment does nothing and counts nothing", async () => {
    const automation = await createFor(tenantA, wakerA);
    const trigger = await addTrigger(tenantA, automation.id, DAILY);
    const due = recentMinute();
    await makeDue(tenantA, trigger.id, due);
    await offerDueAutomations(options());
    await dispatchClaimedAutomations(options());
    expect(executed).toHaveLength(1);

    // The same moment, handed out again under another key (a lease lost mid-dispatch, say).
    await as(tenantA, async () => {
      await queue.offer({
        kind: AUTOMATION_FIRE_KIND,
        key: `${trigger.id}:${minuteKey(due)}:again`,
        payload: {
          automationId: automation.id,
          triggerId: trigger.id,
          triggerKind: "schedule",
          scheduledFor: due.toISOString(),
        },
      });
    });
    const report = await dispatchClaimedAutomations(options());
    expect(report.fired).toEqual([]);
    expect(report.skipped).toEqual([
      { automationId: automation.id, reason: "this moment already fired" },
    ]);
    expect(executed).toHaveLength(1);
    expect((await rawAutomation(tenantA, automation.id))?.runCount).toBe(1);
    expect(await firingsOf(tenantA, automation.id)).toHaveLength(1);
  });

  test("the run cap is counted at firing time and stops the automation (到期停止)", async () => {
    const automation = await createFor(tenantA, wakerA, { maxRuns: 1 });
    const trigger = await addTrigger(tenantA, automation.id, DAILY);
    await makeDue(tenantA, trigger.id, recentMinute());
    await offerDueAutomations(options());
    expect((await dispatchClaimedAutomations(options())).fired).toEqual([
      automation.id,
    ]);
    const spent = await rawAutomation(tenantA, automation.id);
    expect(spent?.runCount).toBe(1);
    expect(spent?.enabled).toBe(false);

    // Spent: its trigger is no longer due, and a firing asked for directly is refused.
    await makeDue(tenantA, trigger.id, recentMinute());
    expect((await offerDueAutomations(options())).offered).not.toContain(
      automation.id,
    );
    expect(
      await as(tenantA, () =>
        store.beginFiring({
          automationId: automation.id,
          triggerId: trigger.id,
          externalId: "manual:1",
          fingerprint: "manual:1",
        }),
      ),
    ).toEqual({ status: "stopped", reason: "disabled" });
    expect(executed).toHaveLength(1);
  });

  test("an end date that passed between the offer and the firing stops it before anything runs", async () => {
    const automation = await createFor(tenantA, wakerA);
    const trigger = await addTrigger(tenantA, automation.id, DAILY);
    await makeDue(tenantA, trigger.id, recentMinute());
    await offerDueAutomations(options());
    await as(tenantA, async () => {
      await database
        .update(automations)
        .set({ endDate: new Date(Date.now() - MINUTE) })
        .where(eq(automations.id, automation.id));
    });

    const report = await dispatchClaimedAutomations(options());
    expect(report.fired).toEqual([]);
    expect(report.skipped).toEqual([
      { automationId: automation.id, reason: "stopped: end_date" },
    ]);
    expect(executed).toHaveLength(0);
    const stopped = await rawAutomation(tenantA, automation.id);
    expect(stopped?.enabled).toBe(false);
    expect(stopped?.runCount).toBe(0);
    expect(await firingsOf(tenantA, automation.id)).toHaveLength(0);
  });

  test("switched off between the offer and the firing: nothing runs", async () => {
    const automation = await createFor(tenantA, wakerA);
    const trigger = await addTrigger(tenantA, automation.id, DAILY);
    await makeDue(tenantA, trigger.id, recentMinute());
    await offerDueAutomations(options());
    await as(tenantA, () => store.setEnabled(automation.id, false));

    const report = await dispatchClaimedAutomations(options());
    expect(report.skipped).toEqual([
      { automationId: automation.id, reason: "stopped: disabled" },
    ]);
    expect(executed).toHaveLength(0);
  });
});

describe("whose firing it is (tenant from the claimed record)", () => {
  test("an item stamped for another tenant cannot fire this tenant's automation", async () => {
    const automation = await createFor(tenantA, wakerA);
    const trigger = await addTrigger(tenantA, automation.id, DAILY);
    const due = recentMinute();
    // Offered from tenant B's frame, naming tenant A's automation in its payload.
    await as(tenantB, async () => {
      await queue.offer({
        kind: AUTOMATION_FIRE_KIND,
        key: `${trigger.id}:${minuteKey(due)}`,
        payload: {
          automationId: automation.id,
          triggerId: trigger.id,
          triggerKind: "schedule",
          scheduledFor: due.toISOString(),
        },
      });
    });

    const report = await dispatchClaimedAutomations(options());
    expect(report.skipped).toEqual([
      { automationId: automation.id, reason: "stopped: deleted" },
    ]);
    expect(executed).toHaveLength(0);
    expect((await rawAutomation(tenantA, automation.id))?.runCount).toBe(0);
    expect(await firingsOf(tenantA, automation.id)).toHaveLength(0);
  });

  test("an item that names nobody is dropped without running", async () => {
    const automation = await createFor(tenantA, wakerA);
    const trigger = await addTrigger(tenantA, automation.id, DAILY);
    await as("platform", async () => {
      await queue.offer({
        kind: AUTOMATION_FIRE_KIND,
        key: `${trigger.id}:platform`,
        payload: { automationId: automation.id, triggerId: trigger.id },
      });
    });

    const report = await dispatchClaimedAutomations(options());
    expect(report.skipped).toEqual([
      { automationId: automation.id, reason: "the work item names no person" },
    ]);
    expect(executed).toHaveLength(0);
    expect((await rawAutomation(tenantA, automation.id))?.runCount).toBe(0);
  });

  test("beginFiring from another tenant's frame finds nothing to begin", async () => {
    const automation = await createFor(tenantA, wakerA);
    const trigger = await addTrigger(tenantA, automation.id, DAILY);
    expect(
      await as(tenantB, () =>
        store.beginFiring({
          automationId: automation.id,
          triggerId: trigger.id,
          externalId: "cross:1",
          fingerprint: "cross:1",
        }),
      ),
    ).toEqual({ status: "stopped", reason: "deleted" });
    // And the database itself refuses a firing stamped for B under A's trigger.
    await expect(
      as(tenantB, async () => {
        await database.insert(automationFirings).values({
          tenantId: tenantB,
          automationId: automation.id,
          triggerId: trigger.id,
          externalId: "cross:2",
          fingerprint: "cross:2",
          target: { kind: "waker", agentId: wakerB },
        });
      }),
    ).rejects.toThrow();
  });
});
