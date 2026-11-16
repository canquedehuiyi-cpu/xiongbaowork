import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { createHmac, randomUUID } from "node:crypto";
import { and, eq, like } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { createAuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import {
  AUTOMATION_EXPIRED,
  AUTOMATION_MAX_RUNS,
  AUTOMATION_PAUSED,
  createAutomationHookDirectory,
  createAutomationHookRoutes,
  HOOK_NOT_FOUND,
} from "../src/automations/ingress-routes";
import { createAutomationRoutes } from "../src/automations/routes";
import { createAutomationStore } from "../src/automations/store";
import {
  AUTOMATION_FIRE_KIND,
  type AutomationEvent,
  type AutomationFiringExecutor,
  dispatchClaimedAutomations,
} from "../src/automations/sweep";
import { createDatabase } from "../src/db/client";
import {
  agents,
  auditEvents,
  automationFirings,
  automations,
  workItems,
} from "../src/db/schema";
import { currentTenant, runAsTenant } from "../src/tenant/context";
import { createWorkQueue } from "../src/work/queue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * D06 AUT2 end to end against PostgreSQL under forced row security: the public hook and the signed-in
 * `POST /api/automations/:id/run`, through the real store, the real `work_items` queue, the real
 * dispatcher and the real audit trail. The executor is a fake that records what it was handed and in
 * which tenant frame; no model is dialled.
 *
 * Offers `AUTOMATION_FIRE_KIND`, which `automation-sweep.integration.test.ts` also offers and wipes.
 * Files in one shard run one after another, so each file clears the kind before its own tests.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createAutomationStore(database);
const queue = createWorkQueue(database);
const auditStore = createAuditStore(database);
const suite = randomUUID().slice(0, 8);
const alice = `aut-ingress-${suite}-a`;
const bob = `aut-ingress-${suite}-b`;
const wakerA = `aut-ingress-${suite}-waker-a`;
const wakerB = `aut-ingress-${suite}-waker-b`;
const created: { tenant: string; id: string }[] = [];

const as = <T>(tenant: string, run: () => Promise<T>): Promise<T> =>
  runAsTenant(tenant, run);

type Executed = {
  firingId: string;
  automationId: string;
  externalId: string;
  tenant: string;
  event: AutomationEvent | undefined;
};
let executed: Executed[] = [];
const recordingExecutor: AutomationFiringExecutor = async (firing, event) => {
  executed.push({
    firingId: firing.id,
    automationId: firing.automation.id,
    externalId: firing.externalId,
    tenant: currentTenant(),
    event,
  });
  await store.finishFiring(firing.id, "succeeded");
};
const dispatch = () =>
  dispatchClaimedAutomations({
    store,
    queue,
    executors: { waker: recordingExecutor },
    owner: `automation-ingress-test-${suite}`,
  });

const ingress = {
  queue,
  auditStore,
  signingPepper: `aut-ingress-pepper-${suite}`,
};
const hooks = createAutomationHookRoutes({
  ...ingress,
  directory: createAutomationHookDirectory(database),
});

const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  const user = context.req.header("x-test-user");
  if (!user) return context.json({ error: "Authentication required." }, 401);
  context.set("actor", {
    id: user,
    email: `${user}@example.test`,
    name: user,
    role: "user",
  });
  await runAsTenant(user, () => next());
};
const api = createAutomationRoutes(store, requireUser, ingress);

function hook(
  triggerId: string,
  body: string,
  headers: Record<string, string> = {},
) {
  return hooks.request(`http://openbot.test/${triggerId}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

function run(
  user: string | null,
  automationId: string,
  body: string,
  headers: Record<string, string> = {},
) {
  return api.request(`http://openbot.test/${automationId}/run`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(user ? { "x-test-user": user } : {}),
      ...headers,
    },
    body,
  });
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

async function automationWithHook(
  tenant: string,
  waker: string,
  extra: { maxRuns?: number | null } = {},
) {
  const automation = await as(tenant, () =>
    store.create({
      name: `事件 ${randomUUID().slice(0, 4)}`,
      target: { kind: "waker", agentId: waker },
      ...extra,
    }),
  );
  created.push({ tenant, id: automation.id });
  const { trigger, secret } = await as(tenant, () =>
    store.addTrigger(automation.id, { kind: "webhook" }),
  );
  if (!secret) throw new Error("A webhook trigger must come with a secret.");
  return { automation, trigger, secret };
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

async function firingsOf(tenant: string, automationId: string) {
  return await as(tenant, async () => {
    return await database
      .select()
      .from(automationFirings)
      .where(eq(automationFirings.automationId, automationId));
  });
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

async function auditOf(tenant: string, automationId: string) {
  return await as(tenant, async () => {
    return await database
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.eventType, "automation.triggered"),
          eq(auditEvents.targetId, automationId),
        ),
      );
  });
}

async function clearQueue() {
  await as("platform", async () => {
    await database
      .delete(workItems)
      .where(eq(workItems.kind, AUTOMATION_FIRE_KIND));
  });
}

beforeAll(async () => {
  await seedAgent(alice, wakerA);
  await seedAgent(bob, wakerB);
});

beforeEach(async () => {
  executed = [];
  await clearQueue();
});

afterAll(async () => {
  for (const { tenant, id } of created) {
    await as(tenant, () => store.softDelete(id)).catch(() => false);
  }
  await clearQueue();
  await database.$client.close();
});

describe("the public hook (AUT2)", () => {
  test("a Bearer delivery becomes one firing in the owner's tenant, carrying its payload, audited", async () => {
    const { automation, trigger, secret } = await automationWithHook(
      alice,
      wakerA,
    );
    const response = await hook(trigger.id, JSON.stringify({ build: 7 }), {
      authorization: `Bearer ${secret}`,
      "idempotency-key": "build-7",
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true, duplicate: false });

    const items = await itemsFor(trigger.id);
    expect(items).toHaveLength(1);
    expect(items[0]?.key).toBe(`${trigger.id}:hook:build-7`);
    // Stamped with the tenant the trigger row names; the request named none.
    expect(items[0]?.tenantId).toBe(alice);

    const report = await dispatch();
    expect(report.fired).toEqual([automation.id]);
    expect(executed).toHaveLength(1);
    expect(executed[0]?.tenant).toBe(alice);
    expect(executed[0]?.externalId).toBe("hook:build-7");
    expect(executed[0]?.event).toMatchObject({
      source: "hook",
      payload: { contentType: "application/json", body: { build: 7 } },
    });
    expect((await rawAutomation(alice, automation.id))?.runCount).toBe(1);

    const audit = await auditOf(alice, automation.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actorUserId).toBe(alice);
    expect(audit[0]?.tenantId).toBe(alice);
    expect(audit[0]?.payload).toMatchObject({
      source: "hook",
      triggerId: trigger.id,
    });
    // Bob's frame sees none of it.
    expect(await auditOf(bob, automation.id)).toHaveLength(0);
    expect(await firingsOf(bob, automation.id)).toHaveLength(0);
  });

  test("the same delivery twice fires once, even after its queue row is gone", async () => {
    const { automation, trigger, secret } = await automationWithHook(
      alice,
      wakerA,
    );
    const send = () =>
      hook(trigger.id, "{}", {
        authorization: `Bearer ${secret}`,
        "idempotency-key": "same-one",
      });
    expect((await send()).status).toBe(202);
    const again = await send();
    expect(again.status).toBe(202);
    expect(await again.json()).toEqual({ accepted: true, duplicate: true });
    expect(await itemsFor(trigger.id)).toHaveLength(1);
    await dispatch();

    // The queue row reaped: the firing's own identity still says it already happened.
    await clearQueue();
    expect((await send()).status).toBe(202);
    const report = await dispatch();
    expect(report.fired).toEqual([]);
    expect(executed).toHaveLength(1);
    expect(await firingsOf(alice, automation.id)).toHaveLength(1);
    expect((await rawAutomation(alice, automation.id))?.runCount).toBe(1);
  });

  test("a Standard Webhooks delivery signed with the signing secret from the API is accepted", async () => {
    const owned = await as(alice, () =>
      store.create({
        name: "签名事件",
        target: { kind: "waker", agentId: wakerA },
      }),
    );
    createdPush(alice, owned.id);
    const added = await api.request(
      `http://openbot.test/${owned.id}/triggers`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-user": alice },
        body: JSON.stringify({ kind: "webhook" }),
      },
    );
    expect(added.status).toBe(201);
    const { trigger, signingSecret } = (await added.json()) as {
      trigger: { id: string };
      signingSecret: string;
    };
    expect(signingSecret.startsWith("whsec_")).toBe(true);

    const body = JSON.stringify({ type: "deploy.finished" });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac(
      "sha256",
      Buffer.from(signingSecret.slice(6), "base64"),
    )
      .update(`msg_9.${timestamp}.${body}`)
      .digest("base64");
    const response = await hook(trigger.id, body, {
      "webhook-id": "msg_9",
      "webhook-timestamp": String(timestamp),
      "webhook-signature": `v1,${signature}`,
    });
    expect(response.status).toBe(202);
    expect((await itemsFor(trigger.id))[0]?.key).toBe(
      `${trigger.id}:hook:msg_9`,
    );
  });

  test("a wrong secret, or another trigger's, is 401 and leaves nothing behind", async () => {
    const mine = await automationWithHook(alice, wakerA);
    const theirs = await automationWithHook(bob, wakerB);
    for (const authorization of [
      "Bearer wrong",
      `Bearer ${theirs.secret}`,
      "",
    ]) {
      const response = await hook(
        mine.trigger.id,
        "{}",
        authorization ? { authorization } : {},
      );
      expect(response.status).toBe(401);
    }
    expect(await itemsFor(mine.trigger.id)).toHaveLength(0);
    expect(await auditOf(alice, mine.automation.id)).toHaveLength(0);
  });

  test("unknown, switched-off, removed, deleted and non-webhook triggers are one identical 404", async () => {
    const off = await automationWithHook(alice, wakerA);
    await as(alice, () =>
      store.setTriggerEnabled(off.automation.id, off.trigger.id, false),
    );
    const deleted = await automationWithHook(alice, wakerA);
    await as(alice, () => store.softDelete(deleted.automation.id));
    const scheduled = await automationWithHook(alice, wakerA);
    const { trigger: schedule } = await as(alice, () =>
      store.addTrigger(scheduled.automation.id, {
        kind: "schedule",
        cron: "0 9 * * *",
        timezone: "Asia/Shanghai",
      }),
    );

    const bodies = new Set<string>();
    for (const [id, secret] of [
      [randomUUID(), off.secret],
      ["not-a-uuid", off.secret],
      [off.trigger.id, off.secret],
      [deleted.trigger.id, deleted.secret],
      [schedule.id, scheduled.secret],
    ] as const) {
      const response = await hook(id, "{}", {
        authorization: `Bearer ${secret}`,
      });
      expect(response.status).toBe(404);
      bodies.add(await response.text());
    }
    expect([...bodies]).toEqual([JSON.stringify({ error: HOOK_NOT_FOUND })]);
    expect(await itemsFor(off.trigger.id)).toHaveLength(0);
    expect(await itemsFor(deleted.trigger.id)).toHaveLength(0);
  });

  test("paused, out of runs, or past the end date: 409 with no side effects", async () => {
    const paused = await automationWithHook(alice, wakerA);
    await as(alice, () => store.setEnabled(paused.automation.id, false));

    const spent = await automationWithHook(alice, wakerA, { maxRuns: 1 });
    expect(
      (
        await hook(spent.trigger.id, "{}", {
          authorization: `Bearer ${spent.secret}`,
        })
      ).status,
    ).toBe(202);
    await dispatch();
    expect((await rawAutomation(alice, spent.automation.id))?.runCount).toBe(1);
    await clearQueue();

    // Still switched on, but its end date has passed: refused, and NOT switched off by the refusal.
    const expired = await automationWithHook(alice, wakerA);
    await as(alice, async () => {
      await database
        .update(automations)
        .set({ endDate: new Date(Date.now() - 60_000) })
        .where(eq(automations.id, expired.automation.id));
    });

    for (const [target, message] of [
      [paused, AUTOMATION_PAUSED],
      [spent, AUTOMATION_MAX_RUNS],
      [expired, AUTOMATION_EXPIRED],
    ] as const) {
      const before = await rawAutomation(alice, target.automation.id);
      const response = await hook(target.trigger.id, "{}", {
        authorization: `Bearer ${target.secret}`,
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: message,
        accepted: false,
      });
      expect(await itemsFor(target.trigger.id)).toHaveLength(0);
      const after = await rawAutomation(alice, target.automation.id);
      expect(after?.enabled).toBe(before?.enabled ?? false);
      expect(after?.runCount).toBe(before?.runCount ?? -1);
    }
    expect(await auditOf(alice, paused.automation.id)).toHaveLength(0);
    expect(await auditOf(alice, expired.automation.id)).toHaveLength(0);
    // The spent one was audited for its one accepted delivery only.
    expect(await auditOf(alice, spent.automation.id)).toHaveLength(1);
  });

  test("a body over 256 KiB is 413 and never queued", async () => {
    const { trigger, secret } = await automationWithHook(alice, wakerA);
    const body = "x".repeat(256 * 1024 + 1);
    const response = await hook(trigger.id, body, {
      authorization: `Bearer ${secret}`,
      "content-length": String(body.length),
    });
    expect(response.status).toBe(413);
    expect(await itemsFor(trigger.id)).toHaveLength(0);
  });
});

describe("the signed-in API entry (AUT2)", () => {
  test("the owner runs it through its event entry; the payload rides along", async () => {
    const { automation, trigger } = await automationWithHook(alice, wakerA);
    const response = await run(alice, automation.id, '{"note":"手动"}', {
      "idempotency-key": "api-1",
    });
    expect(response.status).toBe(202);
    const items = await itemsFor(trigger.id);
    expect(items.map((item) => item.key)).toEqual([`${trigger.id}:api:api-1`]);
    expect(items[0]?.tenantId).toBe(alice);
    await dispatch();
    expect(executed[0]?.event).toMatchObject({
      source: "api",
      payload: { body: { note: "手动" } },
    });
    const audit = await auditOf(alice, automation.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.initiatorKind).toBe("person");

    // An over-long Idempotency-Key is the same 400 as on the public hook, and queues nothing.
    const tooLong = await run(alice, automation.id, "{}", {
      "idempotency-key": "k".repeat(201),
    });
    expect(tooLong.status).toBe(400);
    expect(await itemsFor(trigger.id)).toHaveLength(1);
  });

  test("another person's automation is the same 404 as an unknown one; no session is 401", async () => {
    const { automation, trigger } = await automationWithHook(alice, wakerA);
    const theirs = await run(bob, automation.id, "{}");
    const unknown = await run(bob, randomUUID(), "{}");
    expect(theirs.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await theirs.text()).toBe(await unknown.text());
    expect((await run(null, automation.id, "{}")).status).toBe(401);
    expect(await itemsFor(trigger.id)).toHaveLength(0);
  });

  test("paused is 409; no event entry is 422; nothing is queued", async () => {
    const paused = await automationWithHook(alice, wakerA);
    await as(alice, () => store.setEnabled(paused.automation.id, false));
    const refused = await run(alice, paused.automation.id, "{}");
    expect(refused.status).toBe(409);
    expect(await itemsFor(paused.trigger.id)).toHaveLength(0);

    const bare = await as(alice, () =>
      store.create({
        name: "无入口",
        target: { kind: "waker", agentId: wakerA },
      }),
    );
    createdPush(alice, bare.id);
    expect((await run(alice, bare.id, "{}")).status).toBe(422);
  });
});

function createdPush(tenant: string, id: string) {
  created.push({ tenant, id });
}
