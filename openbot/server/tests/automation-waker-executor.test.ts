import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { WakerFlowPlan } from "../../shared/wakerflows";
import {
  type AutomationFiring,
  createAutomationStore,
} from "../src/automations/store";
import { ABANDONED_FIRING_MS } from "../src/automations/sweep";
import { createAutomationTargetRegistry } from "../src/automations/types";
import {
  AUTOMATION_BREAKER_LIMIT,
  AUTOMATION_FLOW_GONE,
  AUTOMATION_FLOW_INPUTS_CHANGED,
  AUTOMATION_FLOW_NOT_READY,
  AUTOMATION_FLOW_UNAVAILABLE,
  AUTOMATION_SKIPPED_ACCESS_REVOKED,
  AUTOMATION_SKIPPED_BOT_PAUSED,
  automationFiringInitiator,
  automationInstruction,
  breakerMessage,
  createWakerAutomationExecutor,
  firingOfInitiator,
  type WakerAutomationExecutorDeps,
  wakerflowAutomationTarget,
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
import type { WakerFlowStore } from "../src/wakerflows/store";
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

/**
 * Wait until `probe` holds, for at most `ms`. A fixed sleep is a race on a loaded runner: the first
 * firing may simply not have reached its turn yet, which says nothing about the lane.
 */
async function until(probe: () => boolean, what: string, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!probe()) {
    if (Date.now() > deadline)
      throw new Error(`Timed out after ${ms} ms waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** How long the second firing is given to (wrongly) start while the first holds the gate. */
const HOLD_MS = 150;

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

  test("what the turn drew or handed over is kept on the card, and the card is the turn's run", async () => {
    const { automation, trigger } = await newAutomation();
    const firing = await begin(automation.id, trigger.id);
    const components = [{ name: "show_table", args: { rows: [["周一", 3]] } }];
    turnOutcome = async () => ({
      replyText: "周报已生成。",
      components,
      attachments: ["attachment-1", "attachment-1"],
    });
    await fire(firing);

    expect(turns[0]?.input.runRef).toBe(firing.id);
    const card = (await cardFor(firing.id))[0];
    expect(card?.status).toBe("awaiting_review");
    expect(card?.deliverableRef).toEqual({
      kind: "deliverable",
      components,
      attachments: ["attachment-1"],
    });
  });

  test("a reply with nothing drawn leaves the card without a deliverable", async () => {
    const { automation, trigger } = await newAutomation();
    const firing = await begin(automation.id, trigger.id);
    await fire(firing);
    expect((await cardFor(firing.id))[0]?.deliverableRef).toBeNull();
  });

  test("a firing waiting for its thread keeps its clock fresh, so the reaper leaves it", async () => {
    const { automation, trigger } = await newAutomation();
    const first = await begin(automation.id, trigger.id);
    const second = await begin(automation.id, trigger.id);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    turnOutcome = async () => {
      if (turns.length === 1) await gate;
      return { replyText: "好了" };
    };
    const shared = executor({ laneHeartbeatMs: 20 });
    const both = Promise.all([
      as(() => shared.run(first)),
      as(() => shared.run(second)),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    // Made to look long abandoned while it waits behind the first turn ...
    await as(async () => {
      await database
        .update(automationFirings)
        .set({ updatedAt: new Date(Date.now() - ABANDONED_FIRING_MS - 60_000) })
        .where(eq(automationFirings.id, second.id));
    });
    // ... its heartbeat restarts the clock before the reaper looks.
    await new Promise((resolve) => setTimeout(resolve, 80));
    const stale = new Date(Date.now() - ABANDONED_FIRING_MS);
    expect(
      ((await firingRow(second.id))?.updatedAt.getTime() ?? 0) >
        stale.getTime(),
    ).toBe(true);
    await store.reapAbandonedFirings(ABANDONED_FIRING_MS, "reaped");
    expect((await firingRow(second.id))?.status).toBe("running");

    release();
    await both;
    expect(turns).toHaveLength(2);
    expect((await firingRow(second.id))?.status).toBe("succeeded");
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
    await until(() => turns.length >= 1, "the first firing's turn");
    await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
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
      failures: AUTOMATION_BREAKER_LIMIT,
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

/*
 * AUT3: a WakerFlow target. The firing starts one run through the WakerFlow run-start path (here a
 * stand-in with the store's `inspect` and `start` shape, which records what it was asked and in
 * which frame), under the same ledger, breaker and lane rules as a Waker firing.
 */
describe("a WakerFlow target (AUT3)", () => {
  const flowId = randomUUID();
  /** The Flow's plan as it is now; WF8 checks an automation's saved inputs against it. */
  const planWith = (inputs: WakerFlowPlan["inputs"]): WakerFlowPlan => ({
    name: "周报流程",
    description: "",
    members: [{ agentId: "flow-agent", role: "撰写" }],
    inputs,
    steps: [
      {
        id: "write",
        agentId: "flow-agent",
        instruction: "写周报",
        inputKeys: inputs.map((input) => input.key),
        outputKey: "report",
      },
    ],
  });
  let flow: {
    status: "ready" | "draft";
    revision: number;
    plan?: WakerFlowPlan | null;
  } | null = null;
  let starts: {
    tenantId: string;
    frame: string;
    actor: string;
    id: string;
    input: unknown;
  }[] = [];
  let startOutcome: () => Promise<{ status: string; error: string | null }>;
  const flows = {
    async inspect(tenantId: string, id: string) {
      return tenantId === tenant && id === flowId && flow
        ? {
            id,
            name: "周报流程",
            plan: flow.status === "ready" ? planWith([]) : null,
            ...flow,
          }
        : null;
    },
    async start(tenantId: string, actor: string, id: string, input: unknown) {
      starts.push({ tenantId, frame: currentTenant(), actor, id, input });
      return await startOutcome();
    },
  } as unknown as Pick<WakerFlowStore, "inspect" | "start">;
  const registry = createAutomationTargetRegistry();
  registry.register(wakerflowAutomationTarget(flows));
  const flowStore = createAutomationStore(database, { executors: registry });

  beforeEach(() => {
    flow = { status: "ready", revision: 3 };
    starts = [];
    startOutcome = async () => ({ status: "completed", error: null });
  });

  async function newFlowAutomation(inputs?: Record<string, string>) {
    const automation = await as(() =>
      flowStore.create({
        name: `流程任务 ${randomUUID().slice(0, 4)}`,
        target: { kind: "wakerflow", flowId, ...(inputs ? { inputs } : {}) },
      }),
    );
    const { trigger } = await as(() =>
      flowStore.addTrigger(automation.id, {
        kind: "schedule",
        cron: "0 9 * * *",
        timezone: "Asia/Shanghai",
      }),
    );
    return { automation, trigger };
  }

  const fireFlow = (
    firing: AutomationFiring,
    deps: Partial<WakerAutomationExecutorDeps> = {},
  ) => fire(firing, { wakerflows: flows, ...deps });

  test("only a saved WakerFlow of the owner's own can be chosen", async () => {
    flow = { status: "draft", revision: 1 };
    await expect(
      as(() =>
        flowStore.create({
          name: "草稿流程",
          target: { kind: "wakerflow", flowId },
        }),
      ),
    ).rejects.toThrow(AUTOMATION_FLOW_NOT_READY);
    await expect(
      as(() =>
        flowStore.create({
          name: "别处流程",
          target: { kind: "wakerflow", flowId: randomUUID() },
        }),
      ),
    ).rejects.toThrow("找不到这个 WakerFlow。");
    flow = { status: "ready", revision: 1 };
    const { automation } = await newFlowAutomation();
    expect(automation.target).toEqual({ kind: "wakerflow", flowId });
  });

  test("a firing starts one run as the owner, keyed by the firing, and succeeds", async () => {
    const { automation, trigger } = await newFlowAutomation();
    const firing = await begin(automation.id, trigger.id);
    await fireFlow(firing);

    expect(starts).toEqual([
      {
        tenantId: tenant,
        frame: tenant,
        actor: tenant,
        id: flowId,
        // The firing's id is the request id: a repeat of this firing can never start a second run.
        input: { requestId: firing.id, revision: 3, inputs: {} },
      },
    ]);
    expect((await firingRow(firing.id))?.status).toBe("succeeded");
    // No Waker turn, and no card of the executor's own: the run's card is the pipeline's.
    expect(turns).toHaveLength(0);
    expect(await cardFor(firing.id)).toHaveLength(0);
  });

  test("a run that could not start, or a flow that is gone, is a counted failure", async () => {
    const { automation, trigger } = await newFlowAutomation();
    startOutcome = async () => ({ status: "failed", error: "请填写 主题。" });
    const refused = await begin(automation.id, trigger.id);
    await fireFlow(refused);
    expect(await firingRow(refused.id)).toMatchObject({
      status: "failed",
      error: "请填写 主题。",
    });

    flow = null;
    const gone = await begin(automation.id, trigger.id);
    await fireFlow(gone);
    expect(await firingRow(gone.id)).toMatchObject({
      status: "failed",
      error: AUTOMATION_FLOW_GONE,
    });
    expect(await as(() => store.consecutiveFailures(automation.id))).toBe(2);
  });

  test("a full month and a revoked account are skipped, not counted", async () => {
    const { automation, trigger } = await newFlowAutomation();
    const full = new QuotaExceeded("tasksPerMonth", 50, 50, "free");
    startOutcome = async () => {
      throw full;
    };
    const capped = await begin(automation.id, trigger.id);
    await fireFlow(capped);
    expect(await firingRow(capped.id)).toMatchObject({
      status: "skipped",
      error: full.message,
    });

    const banned = await begin(automation.id, trigger.id);
    await fireFlow(banned, { accessRevokedOf: async () => true });
    expect(await firingRow(banned.id)).toMatchObject({
      status: "skipped",
      error: AUTOMATION_SKIPPED_ACCESS_REVOKED,
    });
    expect(starts).toHaveLength(1);
    expect(await as(() => store.consecutiveFailures(automation.id))).toBe(0);
  });

  test("ten failures in a row trip the breaker, with a breaker card naming the automation", async () => {
    const { automation, trigger } = await newFlowAutomation();
    startOutcome = async () => ({ status: "failed", error: "流程启动失败" });
    let last: AutomationFiring | undefined;
    for (let index = 0; index < AUTOMATION_BREAKER_LIMIT; index += 1) {
      last = await begin(automation.id, trigger.id);
      await fireFlow(last);
    }
    expect((await automationRow(automation.id))?.enabled).toBe(false);
    expect((await firingRow(last?.id ?? ""))?.status).toBe("circuit_breaker");
    const card = (await cardFor(last?.id ?? ""))[0];
    expect(card).toMatchObject({
      status: "failed",
      executorAgentId: null,
      source: "routine",
      triggerSource: "automation:schedule",
    });
    expect(card?.deliverableRef).toMatchObject({
      kind: "circuit_breaker",
      automationId: automation.id,
      failures: AUTOMATION_BREAKER_LIMIT,
    });
  });

  test("firings of one WakerFlow start one at a time", async () => {
    const { automation, trigger } = await newFlowAutomation();
    const first = await begin(automation.id, trigger.id);
    const second = await begin(automation.id, trigger.id);
    let running = 0;
    let most = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    startOutcome = async () => {
      running += 1;
      most = Math.max(most, running);
      if (starts.length === 1) await gate;
      running -= 1;
      return { status: "completed", error: null };
    };
    const shared = executor({ wakerflows: flows });
    const both = Promise.all([
      as(() => shared.run(first)),
      as(() => shared.run(second)),
    ]);
    await until(() => starts.length >= 1, "the first firing's start");
    await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
    // The second has not started while the first holds the gate.
    expect(starts).toHaveLength(1);
    release();
    await both;
    expect(most).toBe(1);
    expect(
      starts.map((start) => (start.input as { requestId: string }).requestId),
    ).toEqual([first.id, second.id]);
  });

  describe("the Flow's inputs (WF8)", () => {
    const typed = planWith([
      { key: "topic", label: "主题", required: true },
      { key: "count", label: "人数", required: false, type: "number" },
    ]);

    test("a missing required input or a value its type refuses is refused at save time", async () => {
      flow = { status: "ready", revision: 3, plan: typed };
      await expect(
        as(() =>
          flowStore.create({
            name: "缺输入",
            target: { kind: "wakerflow", flowId },
          }),
        ),
      ).rejects.toThrow("请填写 主题。");
      await expect(
        as(() =>
          flowStore.create({
            name: "错类型",
            target: {
              kind: "wakerflow",
              flowId,
              inputs: { topic: "发布", count: "很多" },
            },
          }),
        ),
      ).rejects.toThrow("人数 需要填写数字。");
      await expect(
        as(() =>
          flowStore.create({
            name: "多输入",
            target: {
              kind: "wakerflow",
              flowId,
              inputs: { topic: "发布", extra: "x" },
            },
          }),
        ),
      ).rejects.toThrow("流程没有声明输入 extra。");
      // An update that changes the target is asked the same question.
      const { automation } = await newFlowAutomation({ topic: "发布" });
      await expect(
        as(() =>
          flowStore.update(automation.id, {
            target: { kind: "wakerflow", flowId, inputs: {} },
          }),
        ),
      ).rejects.toThrow("请填写 主题。");
    });

    test("a firing passes the saved inputs to the run exactly as saved", async () => {
      flow = { status: "ready", revision: 3, plan: typed };
      const saved = { topic: "季度复盘", count: "12" };
      const { automation, trigger } = await newFlowAutomation(saved);
      expect(automation.target).toEqual({
        kind: "wakerflow",
        flowId,
        inputs: saved,
      });
      const firing = await begin(automation.id, trigger.id);
      await fireFlow(firing);
      expect(starts.map((start) => start.input)).toEqual([
        { requestId: firing.id, revision: 3, inputs: saved },
      ]);
      expect((await firingRow(firing.id))?.status).toBe("succeeded");
    });

    test("a Flow whose inputs changed since the save fails the firing with the reason and starts nothing", async () => {
      flow = { status: "ready", revision: 3, plan: typed };
      const { automation, trigger } = await newFlowAutomation({
        topic: "季度复盘",
      });
      // The Flow gains a required input; a default does not paper over it.
      flow = {
        status: "ready",
        revision: 4,
        plan: planWith([
          ...typed.inputs,
          { key: "owner", label: "负责人", required: true, default: "我" },
        ]),
      };
      const added = await begin(automation.id, trigger.id);
      await fireFlow(added);
      expect(await firingRow(added.id)).toMatchObject({
        status: "failed",
        error: `${AUTOMATION_FLOW_INPUTS_CHANGED}：请填写 负责人。`,
      });

      // The Flow drops an input the automation still carries.
      flow = { status: "ready", revision: 5, plan: planWith([]) };
      const removed = await begin(automation.id, trigger.id);
      await fireFlow(removed);
      const row = await firingRow(removed.id);
      expect(row?.status).toBe("failed");
      expect(row?.error).toContain("输入已变更");
      expect(row?.error).toContain("topic");

      expect(starts).toHaveLength(0);
      expect(await as(() => store.consecutiveFailures(automation.id))).toBe(2);
    });
  });

  test("a deployment without the WakerFlow path records the firing as failed and starts nothing", async () => {
    const { automation, trigger } = await newFlowAutomation();
    const firing = await begin(automation.id, trigger.id);
    await fire(firing);
    expect(await firingRow(firing.id)).toMatchObject({
      status: "failed",
      error: AUTOMATION_FLOW_UNAVAILABLE,
    });
    expect(starts).toHaveLength(0);
  });
});

afterAll(async () => {
  await database.$client.close();
});
