import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  createAutomationStore,
  hashTriggerSecret,
} from "../src/automations/store";
import {
  AutomationNotFoundError,
  AutomationRefusedError,
  createAutomationTargetRegistry,
  MAX_ACTIVE_TRIGGERS,
} from "../src/automations/types";
import { createDatabase } from "../src/db/client";
import {
  agents,
  automationFirings,
  automations,
  automationTriggers,
} from "../src/db/schema";
import { runAsTenant, TenantContextError } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * D06 AUT1/AUT3/AUT4 against real PostgreSQL, as the application role under 0117's forced policies.
 *
 * Every store call runs inside a tenant frame, the way a request handler calls it; the tenant (and,
 * by D12, the owner) is never passed in. Cross-tenant checks go both through the store and around it
 * with raw statements, because the store's own `tenant_id` filters would hide a missing policy.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createAutomationStore(database);
const suite = randomUUID().slice(0, 8);
const tenantA = `aut-${suite}-a`;
const tenantB = `aut-${suite}-b`;
const wakerA = `aut-${suite}-waker-a`;
const wakerB = `aut-${suite}-waker-b`;
const HOUR = 60 * 60 * 1000;

const as = <T>(tenant: string, run: () => Promise<T>): Promise<T> =>
  runAsTenant(tenant, run);

/** Run one case under the frame guard set to `throw`, then put back what the run was given. */
async function underThrowGuard<T>(run: () => Promise<T>): Promise<T> {
  const saved = process.env.OPENBOT_TENANT_FRAME_GUARD;
  process.env.OPENBOT_TENANT_FRAME_GUARD = "throw";
  try {
    return await run();
  } finally {
    if (saved === undefined) delete process.env.OPENBOT_TENANT_FRAME_GUARD;
    else process.env.OPENBOT_TENANT_FRAME_GUARD = saved;
  }
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

beforeAll(async () => {
  await seedAgent(tenantA, wakerA);
  await seedAgent(tenantB, wakerB);
});

function createFor(
  tenant: string,
  waker: string,
  extra: { maxRuns?: number | null; endDate?: Date | string | null } = {},
) {
  return as(tenant, () =>
    store.create({
      name: `日报 ${randomUUID().slice(0, 4)}`,
      target: { kind: "waker", agentId: waker },
      ...extra,
    }),
  );
}

async function rawAutomation(tenant: string, id: string) {
  const rows = await as(tenant, async () =>
    database.select().from(automations).where(eq(automations.id, id)),
  );
  return rows[0];
}

async function rawTrigger(tenant: string, id: string) {
  const rows = await as(tenant, async () =>
    database
      .select()
      .from(automationTriggers)
      .where(eq(automationTriggers.id, id)),
  );
  return rows[0];
}

const schedule = {
  kind: "schedule",
  cron: "0 9 * * *",
  timezone: "Asia/Shanghai",
};

describe("whose automation it is (tenant from the caller frame)", () => {
  test("the owner creates, lists and reads it; the tenant is the caller's, never an argument", async () => {
    const created = await createFor(tenantA, wakerA);
    expect(created.tenantId).toBe(tenantA);
    expect(created.enabled).toBe(true);
    expect(created.runCount).toBe(0);
    expect(created.target).toEqual({ kind: "waker", agentId: wakerA });

    const listed = await as(tenantA, () => store.list());
    expect(listed.map((item) => item.id)).toContain(created.id);
    expect((await as(tenantA, () => store.get(created.id)))?.name).toBe(
      created.name,
    );
    expect(await as(tenantA, () => store.get("not-a-uuid"))).toBeNull();

    // Naming another tenant in the input is refused, not obeyed.
    await expect(
      as(tenantA, () =>
        store.create({
          name: "越权",
          target: { kind: "waker", agentId: wakerA },
          tenantId: tenantB,
        } as never),
      ),
    ).rejects.toThrow(AutomationRefusedError);
  });

  test("another tenant can neither see nor change it, through the store or around it", async () => {
    const created = await createFor(tenantA, wakerA);

    expect(await as(tenantB, () => store.get(created.id))).toBeNull();
    expect(
      (await as(tenantB, () => store.list())).map((item) => item.id),
    ).not.toContain(created.id);
    await expect(
      as(tenantB, () => store.update(created.id, { name: "被改名" })),
    ).rejects.toThrow(AutomationNotFoundError);
    await expect(
      as(tenantB, () => store.setEnabled(created.id, false)),
    ).rejects.toThrow(AutomationNotFoundError);
    await expect(
      as(tenantB, () => store.addTrigger(created.id, schedule)),
    ).rejects.toThrow(AutomationNotFoundError);
    await expect(
      as(tenantB, () => store.listTriggers(created.id)),
    ).rejects.toThrow(AutomationNotFoundError);
    await expect(as(tenantB, () => store.claimRun(created.id))).rejects.toThrow(
      AutomationNotFoundError,
    );
    expect(await as(tenantB, () => store.softDelete(created.id))).toBe(false);

    // Around the store: the policies alone hide and protect the row.
    expect(await rawAutomation(tenantB, created.id)).toBeUndefined();
    await as(tenantB, async () => {
      await database
        .update(automations)
        .set({ name: "绕过", enabled: false })
        .where(eq(automations.id, created.id));
      await database.delete(automations).where(eq(automations.id, created.id));
    });
    const untouched = await rawAutomation(tenantA, created.id);
    expect(untouched?.name).toBe(created.name);
    expect(untouched?.enabled).toBe(true);
    expect(untouched?.deletedAt).toBeNull();

    // A row stamped with somebody else's tenant cannot be written at all.
    await expect(
      as(tenantB, async () => {
        await database.insert(automations).values({
          tenantId: tenantA,
          name: "冒名",
          target: { kind: "waker", agentId: wakerB },
        });
      }),
    ).rejects.toThrow();
    // Nor can a trigger be hung on another tenant's automation: not stamped with the owner's tenant,
    // and not stamped with the writer's own either (the foreign key alone would let that through).
    await expect(
      as(tenantB, async () => {
        await database.insert(automationTriggers).values({
          tenantId: tenantA,
          automationId: created.id,
          config: schedule,
        });
      }),
    ).rejects.toThrow();
    await expect(
      as(tenantB, async () => {
        await database.insert(automationTriggers).values({
          tenantId: tenantB,
          automationId: created.id,
          config: schedule,
        });
      }),
    ).rejects.toThrow();
    // The same for a firing under another tenant's trigger.
    const { trigger } = await as(tenantA, () =>
      store.addTrigger(created.id, schedule),
    );
    await expect(
      as(tenantB, async () => {
        await database.insert(automationFirings).values({
          tenantId: tenantB,
          automationId: created.id,
          triggerId: trigger.id,
          externalId: `foreign-${suite}`,
          fingerprint: "f",
          target: { kind: "waker", agentId: wakerB },
        });
      }),
    ).rejects.toThrow();
    // And a tenant's own trigger cannot be moved under somebody else's automation.
    const own = await createFor(tenantB, wakerB);
    const ownTrigger = await as(tenantB, () =>
      store.addTrigger(own.id, schedule),
    );
    await expect(
      as(tenantB, async () => {
        await database
          .update(automationTriggers)
          .set({ automationId: created.id })
          .where(eq(automationTriggers.id, ownTrigger.trigger.id));
      }),
    ).rejects.toThrow();
    expect(
      (await rawTrigger(tenantB, ownTrigger.trigger.id))?.automationId,
    ).toBe(own.id);
    expect(
      (await as(tenantA, () => store.listTriggers(created.id))).map(
        (item) => item.id,
      ),
    ).toEqual([trigger.id]);
  });

  test("no 'system' rows: an unscoped connection reads none and writes none", async () => {
    const created = await createFor(tenantA, wakerA);
    // The `system` frame (what no frame at all used to fall back to) reads none of a person's rows.
    const unscoped = await as("system", () =>
      database
        .select({ id: automations.id })
        .from(automations)
        .where(eq(automations.id, created.id)),
    );
    expect(unscoped).toEqual([]);
    // And with the guard at `throw`, no frame at all reads nothing: it is refused outright.
    await expect(
      underThrowGuard(async () =>
        database
          .select({ id: automations.id })
          .from(automations)
          .where(eq(automations.id, created.id)),
      ),
    ).rejects.toBeInstanceOf(TenantContextError);
    await expect(
      as("system", async () => {
        await database.insert(automations).values({
          tenantId: "system",
          name: "平台任务",
          target: { kind: "waker", agentId: wakerA },
        });
      }),
    ).rejects.toThrow();
    await expect(
      as(tenantA, async () => {
        await database.insert(automations).values({
          tenantId: "system",
          name: "平台任务",
          target: { kind: "waker", agentId: wakerA },
        });
      }),
    ).rejects.toThrow();
    // The platform writer keeps its cross-tenant read.
    expect((await rawAutomation("platform", created.id))?.tenantId).toBe(
      tenantA,
    );
  });

  test("the store refuses to act outside a person's frame", async () => {
    // `system` is the frame no frame at all used to fall back to; it is nobody's, so it is refused.
    await expect(as("system", () => store.list())).rejects.toThrow(
      /tenant's frame/,
    );
    // With the guard at `throw`, no frame at all is refused before the store is reached.
    await expect(underThrowGuard(() => store.list())).rejects.toBeInstanceOf(
      TenantContextError,
    );
    await expect(as("platform", () => store.list())).rejects.toThrow(
      /tenant's frame/,
    );
  });

  test("soft delete hides it, switches its triggers off, and leaves it closed to changes", async () => {
    const created = await createFor(tenantA, wakerA);
    const { trigger } = await as(tenantA, () =>
      store.addTrigger(created.id, schedule),
    );
    expect(trigger.nextRunAt).not.toBeNull();

    expect(await as(tenantA, () => store.softDelete(created.id))).toBe(true);
    expect(await as(tenantA, () => store.get(created.id))).toBeNull();
    expect(
      (await as(tenantA, () => store.list())).map((item) => item.id),
    ).not.toContain(created.id);
    await expect(
      as(tenantA, () => store.addTrigger(created.id, schedule)),
    ).rejects.toThrow(AutomationNotFoundError);
    expect(await as(tenantA, () => store.softDelete(created.id))).toBe(false);

    const row = await rawAutomation(tenantA, created.id);
    expect(row?.deletedAt).not.toBeNull();
    expect(row?.enabled).toBe(false);
    const switchedOff = await rawTrigger(tenantA, trigger.id);
    expect(switchedOff?.enabled).toBe(false);
    expect(switchedOff?.nextRunAt).toBeNull();
  });
});

describe("AUT3: a Waker or an existing WakerFlow", () => {
  test("a Waker must be one this tenant can see", async () => {
    await expect(
      as(tenantA, () =>
        store.create({
          name: "别人的 Waker",
          target: { kind: "waker", agentId: wakerB },
        }),
      ),
    ).rejects.toThrow("找不到这位 Waker，或你无权使用它。");
    await expect(
      as(tenantA, () =>
        store.create({
          name: "不存在",
          target: { kind: "waker", agentId: `${wakerA}-missing` },
        }),
      ),
    ).rejects.toThrow(AutomationRefusedError);

    const created = await createFor(tenantA, wakerA);
    await expect(
      as(tenantA, () =>
        store.update(created.id, {
          target: { kind: "waker", agentId: wakerB },
        }),
      ),
    ).rejects.toThrow(AutomationRefusedError);
    expect((await as(tenantA, () => store.get(created.id)))?.target).toEqual({
      kind: "waker",
      agentId: wakerA,
    });
  });

  test("a WakerFlow target is refused while no executor is registered", async () => {
    const flowId = randomUUID();
    await expect(
      as(tenantA, () =>
        store.create({ name: "流程", target: { kind: "wakerflow", flowId } }),
      ),
    ).rejects.toThrow("WakerFlow 自动执行尚未开放，暂时只能选择 Waker。");
    const created = await createFor(tenantA, wakerA);
    await expect(
      as(tenantA, () =>
        store.update(created.id, { target: { kind: "wakerflow", flowId } }),
      ),
    ).rejects.toThrow(AutomationRefusedError);
  });

  test("with an executor registered, the executor decides, in the caller's tenant", async () => {
    const knownFlow = randomUUID();
    const asked: string[] = [];
    const executors = createAutomationTargetRegistry();
    executors.register({
      kind: "wakerflow",
      async verify(target, frame) {
        asked.push(frame.tenantId);
        if (target.flowId !== knownFlow) {
          throw new AutomationRefusedError("找不到这个 WakerFlow。");
        }
      },
    });
    const withFlows = createAutomationStore(database, { executors });

    const created = await as(tenantA, () =>
      withFlows.create({
        name: "跑流程",
        target: { kind: "wakerflow", flowId: knownFlow },
      }),
    );
    expect(created.target).toEqual({ kind: "wakerflow", flowId: knownFlow });
    await expect(
      as(tenantA, () =>
        withFlows.create({
          name: "未知流程",
          target: { kind: "wakerflow", flowId: randomUUID() },
        }),
      ),
    ).rejects.toThrow("找不到这个 WakerFlow。");
    expect(asked).toEqual([tenantA, tenantA]);
  });
});

describe("AUT1: scheduled and one-off triggers, at most five switched on", () => {
  test("a schedule and a one-off instant each get their next run", async () => {
    const created = await createFor(tenantA, wakerA);
    const now = new Date();
    const at = new Date(now.getTime() + 3 * HOUR);
    const daily = await as(tenantA, () =>
      store.addTrigger(created.id, schedule, now),
    );
    const once = await as(tenantA, () =>
      store.addTrigger(created.id, { kind: "once", at: at.toISOString() }, now),
    );
    expect(daily.secret).toBeNull();
    expect(daily.trigger.nextRunAt?.getTime()).toBeGreaterThan(now.getTime());
    expect(daily.trigger.nextRunAt?.getUTCHours()).toBe(1); // 09:00 Asia/Shanghai
    expect(once.trigger.nextRunAt?.getTime()).toBe(at.getTime());

    const triggers = await as(tenantA, () => store.listTriggers(created.id));
    expect(triggers.map((item) => item.config.kind).sort()).toEqual([
      "once",
      "schedule",
    ]);
    // The tenant of a trigger is copied from its automation.
    expect((await rawTrigger(tenantA, once.trigger.id))?.tenantId).toBe(
      tenantA,
    );
  });

  test("refuses a one-off in the past and a schedule under the 15-minute floor", async () => {
    const created = await createFor(tenantA, wakerA);
    await expect(
      as(tenantA, () =>
        store.addTrigger(created.id, {
          kind: "once",
          at: new Date(Date.now() - HOUR).toISOString(),
        }),
      ),
    ).rejects.toThrow("一次性触发时间必须晚于现在。");
    await expect(
      as(tenantA, () =>
        store.addTrigger(created.id, {
          kind: "schedule",
          cron: "*/5 * * * *",
          timezone: "Asia/Shanghai",
        }),
      ),
    ).rejects.toThrow(
      "定时规则需要五段 cron 表达式和有效时区，且间隔不少于 15 分钟。",
    );
    await expect(
      as(tenantA, () => store.addTrigger(created.id, { kind: "hourly" })),
    ).rejects.toThrow(AutomationRefusedError);
  });

  test("a sixth switched-on trigger is refused, and two racing for the fifth slot leave five", async () => {
    const created = await createFor(tenantA, wakerA);
    for (let index = 0; index < MAX_ACTIVE_TRIGGERS - 1; index++) {
      await as(tenantA, () => store.addTrigger(created.id, schedule));
    }
    const raced = await Promise.allSettled([
      as(tenantA, () => store.addTrigger(created.id, schedule)),
      as(tenantA, () => store.addTrigger(created.id, { kind: "webhook" })),
    ]);
    expect(raced.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    const refused = raced.find((item) => item.status === "rejected");
    expect(refused?.status === "rejected" && refused.reason).toBeInstanceOf(
      AutomationRefusedError,
    );
    expect(
      refused?.status === "rejected" && (refused.reason as Error).message,
    ).toBe("每个自动任务最多同时启用 5 个触发条件。");

    const triggers = await as(tenantA, () => store.listTriggers(created.id));
    expect(triggers).toHaveLength(MAX_ACTIVE_TRIGGERS);

    // Switching one off frees a slot; switching it back on while the slot is taken is refused.
    const first = triggers[0];
    if (!first) throw new Error("expected a trigger");
    await as(tenantA, () =>
      store.setTriggerEnabled(created.id, first.id, false),
    );
    const replacement = await as(tenantA, () =>
      store.addTrigger(created.id, schedule),
    );
    await expect(
      as(tenantA, () => store.setTriggerEnabled(created.id, first.id, true)),
    ).rejects.toThrow("每个自动任务最多同时启用 5 个触发条件。");
    expect(
      await as(tenantA, () =>
        store.removeTrigger(created.id, replacement.trigger.id),
      ),
    ).toBe("removed");
    const back = await as(tenantA, () =>
      store.setTriggerEnabled(created.id, first.id, true),
    );
    expect(back.enabled).toBe(true);
    expect(back.nextRunAt).not.toBeNull();
  });

  test("a trigger that already fired is switched off rather than deleted", async () => {
    const created = await createFor(tenantA, wakerA);
    const { trigger } = await as(tenantA, () =>
      store.addTrigger(created.id, schedule),
    );
    await as(tenantA, async () => {
      await database.insert(automationFirings).values({
        tenantId: tenantA,
        automationId: created.id,
        triggerId: trigger.id,
        externalId: `fire-${suite}`,
        fingerprint: "f",
        target: { kind: "waker", agentId: wakerA },
      });
    });
    expect(
      await as(tenantA, () => store.removeTrigger(created.id, trigger.id)),
    ).toBe("disabled");
    const row = await rawTrigger(tenantA, trigger.id);
    expect(row?.enabled).toBe(false);
    expect(row?.nextRunAt).toBeNull();
    // The firing is the tenant's own history: invisible to anybody else.
    const foreign = await as(tenantB, async () =>
      database
        .select({ id: automationFirings.id })
        .from(automationFirings)
        .where(eq(automationFirings.triggerId, trigger.id)),
    );
    expect(foreign).toEqual([]);
  });

  test("an event entry's secret is shown once and stored only as its hash", async () => {
    const created = await createFor(tenantA, wakerA);
    const { trigger, secret } = await as(tenantA, () =>
      store.addTrigger(created.id, { kind: "webhook" }),
    );
    if (!secret) throw new Error("expected a secret");
    expect(secret.length).toBeGreaterThanOrEqual(32);
    expect(trigger.hasSecret).toBe(true);
    expect(trigger.nextRunAt).toBeNull();
    expect(Object.keys(trigger)).not.toContain("secretHash");
    const row = await rawTrigger(tenantA, trigger.id);
    expect(row?.secretHash).toBe(hashTriggerSecret(secret));
    expect(JSON.stringify(row)).not.toContain(secret);

    const rotated = await as(tenantA, () =>
      store.rotateTriggerSecret(created.id, trigger.id),
    );
    expect(rotated).not.toBe(secret);
    expect((await rawTrigger(tenantA, trigger.id))?.secretHash).toBe(
      hashTriggerSecret(rotated),
    );
    const timed = await as(tenantA, () =>
      store.addTrigger(created.id, schedule),
    );
    expect(timed.trigger.hasSecret).toBe(false);
    await expect(
      as(tenantA, () =>
        store.rotateTriggerSecret(created.id, timed.trigger.id),
      ),
    ).rejects.toThrow(AutomationRefusedError);
    await expect(
      as(tenantB, () => store.rotateTriggerSecret(created.id, trigger.id)),
    ).rejects.toThrow(AutomationNotFoundError);
  });
});

describe("AUT4: maximum runs, end date, and stopping when spent", () => {
  test("stops itself after its last allowed run and stays stopped until the cap is raised", async () => {
    const created = await createFor(tenantA, wakerA, { maxRuns: 2 });
    expect(await as(tenantA, () => store.claimRun(created.id))).toEqual({
      status: "claimed",
      runCount: 1,
      remaining: 1,
    });
    expect(await as(tenantA, () => store.claimRun(created.id))).toEqual({
      status: "claimed",
      runCount: 2,
      remaining: 0,
    });
    const spent = await as(tenantA, () => store.get(created.id));
    expect(spent?.enabled).toBe(false);
    expect(spent?.runCount).toBe(2);
    expect(await as(tenantA, () => store.claimRun(created.id))).toEqual({
      status: "stopped",
      reason: "disabled",
    });

    await expect(
      as(tenantA, () => store.setEnabled(created.id, true)),
    ).rejects.toThrow("已达到最大运行次数，请先调高上限再启用。");
    await expect(
      as(tenantA, () => store.update(created.id, { maxRuns: 1 })),
    ).rejects.toThrow("最大运行次数不能小于已运行的 2 次。");

    await as(tenantA, () => store.update(created.id, { maxRuns: 3 }));
    await as(tenantA, () => store.setEnabled(created.id, true));
    expect(await as(tenantA, () => store.claimRun(created.id))).toEqual({
      status: "claimed",
      runCount: 3,
      remaining: 0,
    });
    expect((await as(tenantA, () => store.get(created.id)))?.enabled).toBe(
      false,
    );
  });

  test("lowering the cap to the runs already made switches it off at once", async () => {
    const created = await createFor(tenantA, wakerA, { maxRuns: 3 });
    await as(tenantA, () => store.claimRun(created.id));
    const lowered = await as(tenantA, () =>
      store.update(created.id, { maxRuns: 1 }),
    );
    expect(lowered.maxRuns).toBe(1);
    expect(lowered.runCount).toBe(1);
    expect(lowered.enabled).toBe(false);
    expect(await as(tenantA, () => store.claimRun(created.id))).toEqual({
      status: "stopped",
      reason: "disabled",
    });
  });

  test("two claims racing for the last run: exactly one runs", async () => {
    const created = await createFor(tenantA, wakerA, { maxRuns: 1 });
    const results = await Promise.all([
      as(tenantA, () => store.claimRun(created.id)),
      as(tenantA, () => store.claimRun(created.id)),
    ]);
    expect(results.filter((item) => item.status === "claimed")).toHaveLength(1);
    expect((await rawAutomation(tenantA, created.id))?.runCount).toBe(1);
  });

  test("past its end date it stops, and enabling it needs a later end date", async () => {
    const endDate = new Date(Date.now() + HOUR);
    const created = await createFor(tenantA, wakerA, {
      endDate: endDate.toISOString(),
    });
    expect(created.endDate?.getTime()).toBe(endDate.getTime());
    const later = new Date(endDate.getTime() + HOUR);
    expect(await as(tenantA, () => store.claimRun(created.id, later))).toEqual({
      status: "stopped",
      reason: "end_date",
    });
    expect((await as(tenantA, () => store.get(created.id)))?.enabled).toBe(
      false,
    );
    await expect(
      as(tenantA, () => store.setEnabled(created.id, true, later)),
    ).rejects.toThrow("已过截止日期，请先修改截止日期再启用。");
    // Before the end date (the real clock) it may run again.
    await as(tenantA, () => store.setEnabled(created.id, true));
    expect((await as(tenantA, () => store.claimRun(created.id))).status).toBe(
      "claimed",
    );
  });

  test("an end date bounds the triggers: in the past it is refused, beyond it nothing is scheduled", async () => {
    await expect(
      as(tenantA, () =>
        store.create({
          name: "已过期",
          target: { kind: "waker", agentId: wakerA },
          endDate: new Date(Date.now() - HOUR),
        }),
      ),
    ).rejects.toThrow("截止日期必须晚于现在。");

    const created = await createFor(tenantA, wakerA, {
      endDate: new Date(Date.now() + HOUR),
    });
    // 29 February at 09:00: never inside the next hour.
    const leapDay = await as(tenantA, () =>
      store.addTrigger(created.id, {
        kind: "schedule",
        cron: "0 9 29 2 *",
        timezone: "Asia/Shanghai",
      }),
    );
    expect(leapDay.trigger.nextRunAt).toBeNull();
    await expect(
      as(tenantA, () =>
        store.addTrigger(created.id, {
          kind: "once",
          at: new Date(Date.now() + 2 * HOUR).toISOString(),
        }),
      ),
    ).rejects.toThrow("一次性触发时间必须早于截止日期。");
  });

  test("the database itself refuses a zero cap and a count past the cap", async () => {
    const created = await createFor(tenantA, wakerA, { maxRuns: 2 });
    await expect(
      as(tenantA, async () => {
        await database
          .update(automations)
          .set({ runCount: 3 })
          .where(eq(automations.id, created.id));
      }),
    ).rejects.toThrow();
    await expect(
      as(tenantA, async () => {
        await database
          .update(automations)
          .set({ maxRuns: 0 })
          .where(eq(automations.id, created.id));
      }),
    ).rejects.toThrow();
    await expect(
      as(tenantA, async () => {
        await database
          .update(automations)
          .set({ runCount: -1 })
          .where(eq(automations.id, created.id));
      }),
    ).rejects.toThrow();
    expect((await rawAutomation(tenantA, created.id))?.runCount).toBe(0);
  });
});

afterAll(async () => {
  for (const tenant of [tenantA, tenantB]) {
    await as(tenant, async () => {
      await database
        .delete(automationFirings)
        .where(eq(automationFirings.tenantId, tenant));
      await database
        .delete(automationTriggers)
        .where(eq(automationTriggers.tenantId, tenant));
      await database
        .delete(automations)
        .where(eq(automations.tenantId, tenant));
      await database.delete(agents).where(eq(agents.tenantId, tenant));
    });
  }
  await database.$client.close();
});
