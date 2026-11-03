import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  type AutomationFiring,
  createAutomationStore,
} from "../src/automations/store";
import {
  AUTOMATION_BREAKER_LIMIT,
  AUTOMATION_SKIPPED_ACCESS_REVOKED,
  AUTOMATION_SKIPPED_BOT_PAUSED,
  automationFiringInitiator,
  automationInstruction,
  breakerMessage,
  createWakerAutomationExecutor,
  firingOfInitiator,
  type WakerAutomationExecutorDeps,
} from "../src/automations/waker-executor";
import type { AgentChannel } from "../src/channels/routes";
import { HeadlessToolSuspension } from "../src/computer/headless-tools";
import { createDatabase } from "../src/db/client";
import {
  agents,
  automationFirings,
  automations,
  tasks,
} from "../src/db/schema";
import { QuotaExceeded } from "../src/quota/limits";
import type { TurnRunner } from "../src/routines/runner";
import { createTaskProjector } from "../src/tasks/projector";
import { currentTenant, runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * D06 AUT3 + C2 + C3: one automation firing whose target is a Waker, against real PostgreSQL (the
 * automation store and the real task projector, as the application role under forced row security)
 * with a fake turn runner and a fake conversation. No model is dialled.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createAutomationStore(database);
const board = createTaskProjector(database);
const suite = randomUUID().slice(0, 8);
const tenant = `aut-exec-${suite}`;
const waker = `aut-exec-${suite}-waker`;
const channel: AgentChannel = {
  id: `aut-exec-${suite}-channel`,
  name: "熊宝",
  agentIds: [waker],
  threadId: `aut-exec-${suite}-thread`,
  active: true,
} as AgentChannel;

const as = <T>(run: () => Promise<T>): Promise<T> => runAsTenant(tenant, run);

let said: string[] = [];
let turns: { input: Parameters<TurnRunner>[0]; tenant: string }[] = [];
let calls: string[] = [];
let turnOutcome: () => Promise<{ replyText: string }> = async () => ({
  replyText: "今天的巡检已完成。",
});

const runTurn: TurnRunner = async (input) => {
  calls.push("turn");
  turns.push({ input, tenant: currentTenant() });
  return await turnOutcome();
};

function executor(overrides: Partial<WakerAutomationExecutorDeps> = {}) {
  return createWakerAutomationExecutor({
    store,
    channels: {
      direct: async (actor, agentId) => {
        calls.push(`direct:${actor.id}:${agentId}`);
        return channel;
      },
      recordActivity: async (_actor, channelId, activity) => {
        expect(channelId).toBe(channel.id);
        said.push(activity.text);
      },
    },
    actorFor: async (id) => ({ id, role: "user" }),
    runTurn,
    board,
    isBotPaused: async () => false,
    ...overrides,
  });
}

beforeAll(async () => {
  await as(async () => {
    await database.insert(agents).values({
      id: waker,
      tenantId: tenant,
      name: "巡检熊宝",
      type: "built_in",
      configuration: {},
    });
  });
});

beforeEach(() => {
  said = [];
  turns = [];
  calls = [];
  turnOutcome = async () => ({ replyText: "今天的巡检已完成。" });
});

async function newAutomation() {
  const automation = await as(() =>
    store.create({
      name: `每日巡检 ${randomUUID().slice(0, 4)}`,
      target: { kind: "waker", agentId: waker },
    }),
  );
  const { trigger } = await as(() =>
    store.addTrigger(automation.id, {
      kind: "schedule",
      cron: "0 9 * * *",
      timezone: "Asia/Shanghai",
    }),
  );
  return { automation, trigger };
}

async function begin(automationId: string, triggerId: string) {
  const begun = await as(() =>
    store.beginFiring({
      automationId,
      triggerId,
      externalId: `test:${randomUUID()}`,
      fingerprint: "test",
    }),
  );
  if (begun.status !== "started")
    throw new Error(`not started: ${begun.status}`);
  return begun.firing;
}

async function fire(
  firing: AutomationFiring,
  deps: Partial<WakerAutomationExecutorDeps> = {},
) {
  await as(() => executor(deps).run(firing));
}

async function firingRow(id: string) {
  const [row] = await as(async () => {
    return await database
      .select()
      .from(automationFirings)
      .where(eq(automationFirings.id, id));
  });
  return row;
}

async function cardFor(firingId: string) {
  return await as(async () => {
    return await database
      .select()
      .from(tasks)
      .where(eq(tasks.runRef, firingId));
  });
}

async function automationRow(id: string) {
  const [row] = await as(async () => {
    return await database
      .select()
      .from(automations)
      .where(eq(automations.id, id));
  });
  return row;
}

describe("a firing that runs (AUT3, C2)", () => {
  test("opens its own card, runs the Waker as the owner, and lands the reply", async () => {
    const { automation, trigger } = await newAutomation();
    const firing = await begin(automation.id, trigger.id);
    await fire(firing);

    expect(turns).toHaveLength(1);
    expect(turns[0]?.tenant).toBe(tenant);
    expect(turns[0]?.input).toMatchObject({
      ownerUserId: tenant,
      agentId: waker,
      threadId: channel.threadId,
      routineId: `automation:${automation.id}`,
      instruction: automationInstruction(automation.name),
      // Names the firing, so an approval it stops for can settle it.
      initiator: automationFiringInitiator(firing.id),
      // One firing, one card: the runner is told not to file its own.
      cardOwnedByCaller: true,
    });
    expect(said).toEqual(["今天的巡检已完成。"]);
    expect((await firingRow(firing.id))?.status).toBe("succeeded");

    const cards = await cardFor(firing.id);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      tenantId: tenant,
      title: automation.name,
      executorAgentId: waker,
      source: "routine",
      triggerSource: "automation:schedule",
      channelRef: channel.id,
      status: "awaiting_review",
    });
  });

  test("a turn waiting on a person is recorded as waiting and goes to review", async () => {
    const { automation, trigger } = await newAutomation();
    const firing = await begin(automation.id, trigger.id);
    turnOutcome = async () => {
      throw new HeadlessToolSuspension("这个动作等你批准", {
        kind: "approval",
        requestId: "req-1",
      });
    };
    await fire(firing);

    expect((await firingRow(firing.id))?.status).toBe("waiting");
    expect((await cardFor(firing.id))[0]?.status).toBe("awaiting_review");
    expect(said).toEqual(["这个动作等你批准"]);

    // Answered (allowed or declined), the approval-resume path settles the firing it names.
    const named = firingOfInitiator(turns[0]?.input.initiator);
    expect(named).toBe(firing.id);
    expect(await as(() => store.settleWaitingFiring(named ?? ""))).toBe(true);
    expect((await firingRow(firing.id))?.status).toBe("succeeded");
    // Once only, and never a firing that was not waiting.
    expect(await as(() => store.settleWaitingFiring(firing.id))).toBe(false);
    expect(firingOfInitiator({ kind: "routine", id: "routine-1" })).toBeNull();
    expect(firingOfInitiator({ kind: "person" })).toBeNull();
  });

  test("another person cannot settle this owner's waiting firing", async () => {
    const { automation, trigger } = await newAutomation();
    const firing = await begin(automation.id, trigger.id);
    turnOutcome = async () => {
      throw new HeadlessToolSuspension("等你批准", { kind: "approval" });
    };
    await fire(firing);
    expect(
      await runAsTenant(`aut-exec-${suite}-stranger`, () =>
        store.settleWaitingFiring(firing.id),
      ),
    ).toBe(false);
    expect((await firingRow(firing.id))?.status).toBe("waiting");
  });

  test("a firing closed before it was taken up does not run", async () => {
    const { automation, trigger } = await newAutomation();
    const firing = await begin(automation.id, trigger.id);
    await as(() => store.finishFiring(firing.id, "failed", "reaped"));
    await fire(firing);
    expect(turns).toHaveLength(0);
    expect(calls).toEqual([]);
    expect((await firingRow(firing.id))?.error).toBe("reaped");
  });

  test("firings that share a thread run one at a time, in arrival order", async () => {
    const { automation, trigger } = await newAutomation();
    const first = await begin(automation.id, trigger.id);
    const second = await begin(automation.id, trigger.id);
    let running = 0;
    let most = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    turnOutcome = async () => {
      running += 1;
      most = Math.max(most, running);
      if (turns.length === 1) await gate;
      running -= 1;
      return { replyText: "好了" };
    };
    const shared = executor();
    const both = Promise.all([
      as(() => shared.run(first)),
      as(() => shared.run(second)),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The second is still waiting for the thread while the first turn is held open.
    expect(turns).toHaveLength(1);
    release();
    await both;
    expect(most).toBe(1);
    expect(turns).toHaveLength(2);
    expect((await firingRow(first.id))?.status).toBe("succeeded");
    expect((await firingRow(second.id))?.status).toBe("succeeded");
  });
});

describe("the gates, in the routine runner's order", () => {
  test("a revoked account is skipped before a paused Waker, with no card and no turn", async () => {
    const { automation, trigger } = await newAutomation();
    const firing = await begin(automation.id, trigger.id);
    await fire(firing, {
      accessRevokedOf: async () => true,
      isBotPaused: async () => true,
    });

    const row = await firingRow(firing.id);
    expect(row?.status).toBe("skipped");
    expect(row?.error).toBe(AUTOMATION_SKIPPED_ACCESS_REVOKED);
    expect(turns).toHaveLength(0);
    expect(await cardFor(firing.id)).toHaveLength(0);
    // The conversation is resolved first, as the routine runner reads its channel first.
    expect(calls).toEqual([`direct:${tenant}:${waker}`]);
  });

  test("a paused Waker is skipped", async () => {
    const { automation, trigger } = await newAutomation();
    const firing = await begin(automation.id, trigger.id);
    await fire(firing, { isBotPaused: async () => true });

    const row = await firingRow(firing.id);
    expect(row?.status).toBe("skipped");
    expect(row?.error).toBe(AUTOMATION_SKIPPED_BOT_PAUSED);
    expect(turns).toHaveLength(0);
    expect(await cardFor(firing.id)).toHaveLength(0);
  });

  test("a full month is skipped and said, before any card is filed", async () => {
    const { automation, trigger } = await newAutomation();
    const firing = await begin(automation.id, trigger.id);
    const full = new QuotaExceeded("tasksPerMonth", 50, 50, "free");
    await fire(firing, {
      quota: {
        assertCapacity: async () => {
          throw full;
        },
      },
    });

    expect((await firingRow(firing.id))?.status).toBe("skipped");
    expect(said).toEqual([full.message]);
    expect(turns).toHaveLength(0);
    expect(await cardFor(firing.id)).toHaveLength(0);
  });

  test("a conversation that cannot be reached is a failure, without a turn", async () => {
    const { automation, trigger } = await newAutomation();
    const firing = await begin(automation.id, trigger.id);
    await fire(firing, {
      channels: {
        direct: async () => {
          throw new Error("那位 Waker 已不存在");
        },
        recordActivity: async () => {},
      },
    });

    const row = await firingRow(firing.id);
    expect(row?.status).toBe("failed");
    expect(row?.error).toBe("那位 Waker 已不存在");
    expect(turns).toHaveLength(0);
  });

  test("a gate that cannot be asked is a counted failure, not an uncounted crash", async () => {
    for (const broken of [
      {
        accessRevokedOf: async () => {
          throw new Error("封禁名单暂时读不到");
        },
      },
      {
        isBotPaused: async () => {
          throw new Error("暂停状态暂时读不到");
        },
      },
      {
        quota: {
          assertCapacity: async () => {
            throw new Error("本月用量暂时读不到");
          },
        },
      },
    ] satisfies Partial<WakerAutomationExecutorDeps>[]) {
      const { automation, trigger } = await newAutomation();
      const firing = await begin(automation.id, trigger.id);
      await fire(firing, broken);
      expect((await firingRow(firing.id))?.status).toBe("failed");
      expect(turns).toHaveLength(0);
      // Counted by the breaker, like any other failure.
      expect(await as(() => store.consecutiveFailures(automation.id))).toBe(1);
    }
  });

  test("an owner who can no longer be resolved is a counted failure, without a turn", async () => {
    const { automation, trigger } = await newAutomation();
    const firing = await begin(automation.id, trigger.id);
    await fire(firing, {
      actorFor: async () => {
        throw new Error("这个账号已无权使用自动任务");
      },
    });

    const row = await firingRow(firing.id);
    expect(row?.status).toBe("failed");
    expect(row?.error).toBe("这个账号已无权使用自动任务");
    expect(turns).toHaveLength(0);
    expect(calls).toEqual([]);
    expect(await as(() => store.consecutiveFailures(automation.id))).toBe(1);
  });
});

describe("failures and the breaker (C3)", () => {
  test("one failure fails its card and is said once; the automation stays on", async () => {
    const { automation, trigger } = await newAutomation();
    turnOutcome = async () => {
      throw new Error("Notion 授权已过期");
    };
    const first = await begin(automation.id, trigger.id);
    await fire(first);
    const second = await begin(automation.id, trigger.id);
    await fire(second);

    expect((await firingRow(first.id))?.status).toBe("failed");
    expect((await firingRow(second.id))?.status).toBe("failed");
    const card = (await cardFor(first.id))[0];
    expect(card?.status).toBe("failed");
    expect(card?.deliverableRef).toBeNull();
    expect(said).toEqual([
      `自动任务「${automation.name}」执行失败：Notion 授权已过期`,
    ]);
    expect((await automationRow(automation.id))?.enabled).toBe(true);
  });

  test("ten failures in a row switch it off and mark the tenth card as the breaker", async () => {
    const { automation, trigger } = await newAutomation();
    turnOutcome = async () => {
      throw new Error("Notion 授权已过期");
    };
    const firings: AutomationFiring[] = [];
    for (let index = 0; index < AUTOMATION_BREAKER_LIMIT - 1; index += 1) {
      const firing = await begin(automation.id, trigger.id);
      firings.push(firing);
      await fire(firing);
    }
    expect((await automationRow(automation.id))?.enabled).toBe(true);

    // A skipped firing neither counts nor breaks the streak.
    const skipped = await begin(automation.id, trigger.id);
    await fire(skipped, { isBotPaused: async () => true });
    expect((await automationRow(automation.id))?.enabled).toBe(true);
    expect(await as(() => store.consecutiveFailures(automation.id))).toBe(
      AUTOMATION_BREAKER_LIMIT - 1,
    );

    const tenth = await begin(automation.id, trigger.id);
    await fire(tenth);

    expect((await automationRow(automation.id))?.enabled).toBe(false);
    expect((await firingRow(tenth.id))?.status).toBe("circuit_breaker");
    const card = (await cardFor(tenth.id))[0];
    // 已结束-失败, not archived: it sits in 需要关注 until a person files it away.
    expect(card?.status).toBe("failed");
    expect(card?.source).toBe("routine");
    expect(card?.triggerSource).toBe("automation:schedule");
    expect(card?.deliverableRef).toEqual({
      kind: "circuit_breaker",
      automationId: automation.id,
      consecutiveFailures: AUTOMATION_BREAKER_LIMIT,
      reason: "Notion 授权已过期",
    });
    // The earlier cards are plain failures.
    expect((await cardFor(firings[0]?.id ?? ""))[0]?.deliverableRef).toBeNull();
    expect(said).toEqual([
      `自动任务「${automation.name}」执行失败：Notion 授权已过期`,
      breakerMessage(automation.name),
    ]);

    // Switched off, it begins nothing more.
    expect(
      await as(() =>
        store.beginFiring({
          automationId: automation.id,
          triggerId: trigger.id,
          externalId: "after-breaker",
          fingerprint: "after-breaker",
        }),
      ),
    ).toEqual({ status: "stopped", reason: "disabled" });

    // Switched back on, the streak starts again from zero: one more failure does not re-trip.
    await as(() => store.setEnabled(automation.id, true));
    const again = await begin(automation.id, trigger.id);
    await fire(again);
    expect((await firingRow(again.id))?.status).toBe("failed");
    expect((await automationRow(automation.id))?.enabled).toBe(true);
    expect(await as(() => store.consecutiveFailures(automation.id))).toBe(1);
  });

  test("failures racing past the limit trip the breaker once, and it is said once", async () => {
    const { automation, trigger } = await newAutomation();
    turnOutcome = async () => {
      throw new Error("Notion 授权已过期");
    };
    for (let index = 0; index < AUTOMATION_BREAKER_LIMIT - 1; index += 1) {
      await fire(await begin(automation.id, trigger.id));
    }
    said = [];
    const racing = [
      await begin(automation.id, trigger.id),
      await begin(automation.id, trigger.id),
    ];
    // Two executors, so nothing in this process keeps them apart: only the store's lock does.
    await Promise.all(racing.map((firing) => fire(firing)));

    const statuses = await Promise.all(
      racing.map(async (firing) => (await firingRow(firing.id))?.status),
    );
    expect(
      statuses.filter((status) => status === "circuit_breaker"),
    ).toHaveLength(1);
    expect(statuses.filter((status) => status === "failed")).toHaveLength(1);
    expect(
      said.filter((line) => line === breakerMessage(automation.name)),
    ).toHaveLength(1);
    expect((await automationRow(automation.id))?.enabled).toBe(false);
  });

  test("tripping the breaker is single-winner in the store itself", async () => {
    const { automation, trigger } = await newAutomation();
    turnOutcome = async () => {
      throw new Error("超时");
    };
    const firings: AutomationFiring[] = [];
    for (let index = 0; index < AUTOMATION_BREAKER_LIMIT; index += 1) {
      const firing = await begin(automation.id, trigger.id);
      firings.push(firing);
      // Recorded as failed without the executor, so nothing has tripped yet.
      await as(() => store.finishFiring(firing.id, "failed", "超时"));
    }
    const [last, previous] = [firings.at(-1), firings.at(-2)];
    const tries = await Promise.all([
      as(() =>
        store.tripBreaker(
          automation.id,
          last?.id ?? "",
          AUTOMATION_BREAKER_LIMIT,
        ),
      ),
      as(() =>
        store.tripBreaker(
          automation.id,
          previous?.id ?? "",
          AUTOMATION_BREAKER_LIMIT,
        ),
      ),
    ]);
    expect(tries.filter(Boolean)).toHaveLength(1);
    expect(
      await as(() =>
        store.tripBreaker(
          automation.id,
          last?.id ?? "",
          AUTOMATION_BREAKER_LIMIT,
        ),
      ),
    ).toBe(false);
  });

  test("a success ends the streak", async () => {
    const { automation, trigger } = await newAutomation();
    turnOutcome = async () => {
      throw new Error("超时");
    };
    for (let index = 0; index < 3; index += 1) {
      await fire(await begin(automation.id, trigger.id));
    }
    turnOutcome = async () => ({ replyText: "好了" });
    await fire(await begin(automation.id, trigger.id));
    expect(await as(() => store.consecutiveFailures(automation.id))).toBe(0);
  });
});
