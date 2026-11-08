import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { WakerFlow, WakerFlowPlan } from "../../shared/wakerflows";
import type { AppVariables } from "../src/auth/guards";
import { createAutomationRoutes } from "../src/automations/routes";
import {
  createAutomationStore,
  hashTriggerSecret,
} from "../src/automations/store";
import {
  createAutomationTargetRegistry,
  MAX_ACTIVE_TRIGGERS,
} from "../src/automations/types";
import { wakerflowAutomationTarget } from "../src/automations/waker-executor";
import { createDatabase } from "../src/db/client";
import { agents, automationTriggers } from "../src/db/schema";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * D06 AUT1/AUT3/AUT4: the management API at `/api/automations`, real routes over the real store and
 * PostgreSQL under forced row security. The session guard here is a stand-in that does what the real
 * one does — set the actor and run the request in that person's tenant frame — and refuses a request
 * with no person, so a route mounted without it is caught.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createAutomationStore(database);
const suite = randomUUID().slice(0, 8);
const alice = `aut-routes-${suite}-a`;
const bob = `aut-routes-${suite}-b`;
const wakerA = `aut-routes-${suite}-waker-a`;
const wakerB = `aut-routes-${suite}-waker-b`;
const created: { tenant: string; id: string }[] = [];

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
const routes = createAutomationRoutes(store, requireUser);

async function call(
  user: string | null,
  method: string,
  path: string,
  body?: unknown,
  raw?: string,
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (user) headers["x-test-user"] = user;
  const response = await routes.request(`http://openbot.test${path}`, {
    method,
    headers,
    ...(raw !== undefined
      ? { body: raw }
      : body === undefined
        ? {}
        : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    json: (text ? JSON.parse(text) : {}) as Record<string, unknown>,
  };
}

async function createAs(user: string, waker: string, extra: object = {}) {
  const response = await call(user, "POST", "/", {
    name: "每周周报",
    target: { kind: "waker", agentId: waker },
    ...extra,
  });
  expect(response.status).toBe(201);
  const automation = response.json.automation as { id: string };
  created.push({ tenant: user, id: automation.id });
  return automation;
}

beforeAll(async () => {
  for (const [tenant, id] of [
    [alice, wakerA],
    [bob, wakerB],
  ] as const) {
    await runAsTenant(tenant, async () => {
      await database.insert(agents).values({
        id,
        tenantId: tenant,
        name: `${id} 熊宝`,
        type: "built_in",
        configuration: {},
      });
    });
  }
});

afterAll(async () => {
  for (const { tenant, id } of created) {
    await runAsTenant(tenant, () => store.softDelete(id)).catch(() => false);
  }
});

describe("every route asks who is calling", () => {
  test("no person, no answer", async () => {
    const id = randomUUID();
    const tid = randomUUID();
    const requests: [string, string][] = [
      ["GET", "/"],
      ["POST", "/"],
      ["GET", `/${id}`],
      ["PATCH", `/${id}`],
      ["PUT", `/${id}/enabled`],
      ["DELETE", `/${id}`],
      ["POST", `/${id}/triggers`],
      ["PUT", `/${id}/triggers/${tid}/enabled`],
      ["DELETE", `/${id}/triggers/${tid}`],
      ["POST", `/${id}/triggers/${tid}/secret`],
    ];
    for (const [method, path] of requests) {
      // No body on a GET: a fetch Request may refuse one, which is not the refusal under test.
      const response = await call(
        null,
        method,
        path,
        method === "GET" ? undefined : {},
      );
      expect({ method, path, status: response.status }).toEqual({
        method,
        path,
        status: 401,
      });
    }
  });
});

describe("creating and reading (AUT1, AUT3, AUT4)", () => {
  test("a Waker target with limits is created for the caller and read back with its triggers", async () => {
    const endDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const automation = await createAs(alice, wakerA, {
      maxRuns: 12,
      endDate: endDate.toISOString(),
    });
    const read = await call(alice, "GET", `/${automation.id}`);
    expect(read.status).toBe(200);
    expect(read.json.automation).toMatchObject({
      id: automation.id,
      tenantId: alice,
      name: "每周周报",
      target: { kind: "waker", agentId: wakerA },
      enabled: true,
      maxRuns: 12,
      endDate: endDate.toISOString(),
      runCount: 0,
    });
    expect(read.json.triggers).toEqual([]);

    const list = await call(alice, "GET", "/");
    expect(
      (list.json.automations as { id: string }[]).map((item) => item.id),
    ).toContain(automation.id);
    const others = await call(bob, "GET", "/");
    expect(
      (others.json.automations as { id: string }[]).map((item) => item.id),
    ).not.toContain(automation.id);
  });

  test("refusals are 422 with the sentence a person reads", async () => {
    const cases: [unknown, string][] = [
      [
        { name: "", target: { kind: "waker", agentId: wakerA } },
        "请给自动任务起个名字。",
      ],
      [
        { name: "越权", target: { kind: "waker", agentId: wakerB } },
        "找不到这位 Waker，或你无权使用它。",
      ],
      [
        { name: "流程", target: { kind: "wakerflow", flowId: randomUUID() } },
        "WakerFlow 自动执行尚未开放，暂时只能选择 Waker。",
      ],
      [
        {
          name: "上限",
          target: { kind: "waker", agentId: wakerA },
          maxRuns: 0,
        },
        "最大运行次数至少为 1。",
      ],
    ];
    for (const [body, error] of cases) {
      const response = await call(alice, "POST", "/", body);
      expect({ status: response.status, error: response.json.error }).toEqual({
        status: 422,
        error,
      });
    }
    // A tenant named in the body is refused, never obeyed.
    const forged = await call(alice, "POST", "/", {
      name: "越权",
      target: { kind: "waker", agentId: wakerA },
      tenantId: bob,
    });
    expect(forged.status).toBe(422);
    const garbled = await call(alice, "POST", "/", undefined, "{not json");
    expect(garbled.status).toBe(422);
    expect(garbled.json.error).toBe("请求内容无法读取，请检查填写的内容。");
  });
});

describe("another tenant's automation is indistinguishable from none", () => {
  test("every route answers the same 404", async () => {
    const automation = await createAs(alice, wakerA);
    const { json } = await call(alice, "POST", `/${automation.id}/triggers`, {
      kind: "schedule",
      cron: "0 9 * * 1",
      timezone: "Asia/Shanghai",
    });
    const triggerId = (json.trigger as { id: string }).id;

    const unknown = randomUUID();
    for (const id of [automation.id, unknown, "not-a-uuid"]) {
      const responses = [
        await call(bob, "GET", `/${id}`),
        await call(bob, "PATCH", `/${id}`, { name: "改名" }),
        await call(bob, "PUT", `/${id}/enabled`, { enabled: false }),
        await call(bob, "POST", `/${id}/triggers`, { kind: "webhook" }),
        await call(bob, "PUT", `/${id}/triggers/${triggerId}/enabled`, {
          enabled: false,
        }),
        await call(bob, "DELETE", `/${id}/triggers/${triggerId}`),
        await call(bob, "POST", `/${id}/triggers/${triggerId}/secret`),
        await call(bob, "DELETE", `/${id}`),
      ];
      for (const response of responses) {
        expect(response).toEqual({
          status: 404,
          json: { error: "找不到这个自动任务。" },
        });
      }
    }

    // And nothing of Alice's moved.
    const still = await call(alice, "GET", `/${automation.id}`);
    expect(still.json.automation).toMatchObject({
      name: "每周周报",
      enabled: true,
    });
    expect((still.json.triggers as unknown[]).length).toBe(1);
  });
});

describe("changing it (AUT4)", () => {
  test("update, switch off and on, refuse a cap below the runs made, delete", async () => {
    const automation = await createAs(alice, wakerA);
    const renamed = await call(alice, "PATCH", `/${automation.id}`, {
      name: "每日站会",
      maxRuns: 3,
    });
    expect(renamed.status).toBe(200);
    expect(renamed.json.automation).toMatchObject({
      name: "每日站会",
      maxRuns: 3,
    });

    const off = await call(alice, "PUT", `/${automation.id}/enabled`, {
      enabled: false,
    });
    expect(off.json.automation).toMatchObject({ enabled: false });
    const bad = await call(alice, "PUT", `/${automation.id}/enabled`, {
      enabled: "yes",
    });
    expect(bad).toEqual({
      status: 422,
      json: { error: "请说明要启用还是停用。" },
    });
    const pastEnd = await call(alice, "PATCH", `/${automation.id}`, {
      endDate: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(pastEnd).toEqual({
      status: 422,
      json: { error: "截止日期必须晚于现在。" },
    });

    const removed = await call(alice, "DELETE", `/${automation.id}`);
    expect(removed.status).toBe(204);
    expect((await call(alice, "GET", `/${automation.id}`)).status).toBe(404);
    expect((await call(alice, "DELETE", `/${automation.id}`)).status).toBe(404);
  });
});

describe("triggers (AUT1)", () => {
  test("at most five switched on; a sixth is a 422", async () => {
    const automation = await createAs(alice, wakerA);
    for (let index = 0; index < MAX_ACTIVE_TRIGGERS; index += 1) {
      const response = await call(alice, "POST", `/${automation.id}/triggers`, {
        kind: "once",
        at: new Date(Date.now() + (index + 1) * 60 * 60 * 1000).toISOString(),
      });
      expect(response.status).toBe(201);
      expect("secret" in response.json).toBe(false);
    }
    const sixth = await call(alice, "POST", `/${automation.id}/triggers`, {
      kind: "schedule",
      cron: "0 9 * * *",
      timezone: "Asia/Shanghai",
    });
    expect(sixth).toEqual({
      status: 422,
      json: {
        error: `每个自动任务最多同时启用 ${MAX_ACTIVE_TRIGGERS} 个触发条件。`,
      },
    });
    const tooOften = await call(alice, "POST", `/${automation.id}/triggers`, {
      kind: "schedule",
      cron: "*/5 * * * *",
      timezone: "Asia/Shanghai",
    });
    // The floor's own sentence, not the cap's: the cap alone would also answer 422 here.
    expect(tooOften).toEqual({
      status: 422,
      json: {
        error: "定时规则需要五段 cron 表达式和有效时区，且间隔不少于 15 分钟。",
      },
    });
  });

  test("a webhook secret is shown once, stored only as its hash, and rotated", async () => {
    const automation = await createAs(alice, wakerA);
    const added = await call(alice, "POST", `/${automation.id}/triggers`, {
      kind: "webhook",
    });
    expect(added.status).toBe(201);
    const secret = added.json.secret as string;
    const trigger = added.json.trigger as { id: string; hasSecret: boolean };
    expect(typeof secret).toBe("string");
    expect(secret.length).toBeGreaterThan(20);
    expect(trigger.hasSecret).toBe(true);

    const read = await call(alice, "GET", `/${automation.id}`);
    expect(JSON.stringify(read.json)).not.toContain(secret);
    const [row] = await runAsTenant(alice, async () => {
      return await database
        .select({ secretHash: automationTriggers.secretHash })
        .from(automationTriggers)
        .where(eq(automationTriggers.id, trigger.id));
    });
    expect(row?.secretHash).toBe(hashTriggerSecret(secret));

    const rotated = await call(
      alice,
      "POST",
      `/${automation.id}/triggers/${trigger.id}/secret`,
    );
    expect(rotated.status).toBe(200);
    expect(rotated.json.secret).not.toBe(secret);
    expect(
      JSON.stringify((await call(alice, "GET", `/${automation.id}`)).json),
    ).not.toContain(rotated.json.secret as string);

    const off = await call(
      alice,
      "PUT",
      `/${automation.id}/triggers/${trigger.id}/enabled`,
      { enabled: false },
    );
    expect(off.json.trigger).toMatchObject({ id: trigger.id, enabled: false });
    const gone = await call(
      alice,
      "DELETE",
      `/${automation.id}/triggers/${trigger.id}`,
    );
    expect(gone).toEqual({ status: 200, json: { result: "removed" } });
  });
});

describe("the list says when the breaker stopped it (C1/C3)", () => {
  test("tripped: off with the breaker's firing as its newest; switched back on, no longer", async () => {
    const automation = await createAs(alice, wakerA);
    const plain = await createAs(alice, wakerA);
    const added = await call(alice, "POST", `/${automation.id}/triggers`, {
      kind: "schedule",
      cron: "0 9 * * *",
      timezone: "Asia/Shanghai",
    });
    expect(added.status).toBe(201);
    const trigger = added.json.trigger as { id: string };

    const listed = async (user: string) =>
      (await call(user, "GET", "/")).json.automations as {
        id: string;
        enabled: boolean;
        breakerTripped: boolean;
      }[];
    expect(
      (await listed(alice)).find((item) => item.id === automation.id),
    ).toMatchObject({ enabled: true, breakerTripped: false });

    const begun = await runAsTenant(alice, () =>
      store.beginFiring({
        automationId: automation.id,
        triggerId: trigger.id,
        externalId: `breaker:${randomUUID()}`,
        fingerprint: "breaker",
      }),
    );
    if (begun.status !== "started") {
      throw new Error(`firing not started: ${begun.status}`);
    }
    // The breaker trips only on a failed streak that reached its limit (here, one failure).
    await runAsTenant(alice, () =>
      store.finishFiring(begun.firing.id, "failed", "Notion 授权已过期"),
    );
    expect(
      await runAsTenant(alice, () =>
        store.tripBreaker(automation.id, begun.firing.id, 1),
      ),
    ).toBe(true);

    const after = await listed(alice);
    expect(after.find((item) => item.id === automation.id)).toMatchObject({
      enabled: false,
      breakerTripped: true,
    });
    // Paused by hand, never tripped: off, but not the breaker's doing.
    const pausedByHand = await call(alice, "PUT", `/${plain.id}/enabled`, {
      enabled: false,
    });
    expect(pausedByHand.status).toBe(200);
    expect(
      (await listed(alice)).find((item) => item.id === plain.id),
    ).toMatchObject({ enabled: false, breakerTripped: false });
    // Another tenant sees neither.
    expect(
      (await listed(bob)).some(
        (item) => item.id === automation.id || item.id === plain.id,
      ),
    ).toBe(false);

    const back = await call(alice, "PUT", `/${automation.id}/enabled`, {
      enabled: true,
    });
    expect(back.status).toBe(200);
    expect(
      (await listed(alice)).find((item) => item.id === automation.id),
    ).toMatchObject({ enabled: true, breakerTripped: false });

    // Resumed, then paused by hand: off, but no longer the breaker's doing.
    const pausedAgain = await call(alice, "PUT", `/${automation.id}/enabled`, {
      enabled: false,
    });
    expect(pausedAgain.status).toBe(200);
    expect(
      (await listed(alice)).find((item) => item.id === automation.id),
    ).toMatchObject({ enabled: false, breakerTripped: false });
    // The retired marker still ends the failed streak: nothing is counted from before the trip.
    expect(
      await runAsTenant(alice, () => store.consecutiveFailures(automation.id)),
    ).toBe(0);
  });
});

/*
 * WF8 (AUT3): a WakerFlow target carries the Flow inputs it runs with. The registry's verify is the
 * real one (`wakerflowAutomationTarget`) over a stand-in Flow reader holding one saved Flow of
 * alice's with a required and a typed input.
 */
describe("a WakerFlow target with inputs (WF8)", () => {
  const flowId = randomUUID();
  const plan: WakerFlowPlan = {
    name: "周报流程",
    description: "",
    members: [{ agentId: wakerA, role: "撰写" }],
    inputs: [
      { key: "topic", label: "主题", required: true },
      {
        key: "tone",
        label: "语气",
        required: false,
        type: "select",
        options: ["正式", "轻松"],
      },
    ],
    steps: [
      {
        id: "write",
        agentId: wakerA,
        instruction: "写周报",
        inputKeys: ["topic", "tone"],
        outputKey: "report",
      },
    ],
  };
  const registry = createAutomationTargetRegistry();
  registry.register(
    wakerflowAutomationTarget({
      inspect: async (tenantId, id) =>
        tenantId === alice && id === flowId
          ? ({ id, status: "ready", revision: 2, plan } as WakerFlow)
          : null,
    }),
  );
  const flowRoutes = createAutomationRoutes(
    createAutomationStore(database, { executors: registry }),
    requireUser,
  );
  const post = async (user: string, body: unknown) => {
    const response = await flowRoutes.request("http://openbot.test/", {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-user": user },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      json: (await response.json()) as Record<string, unknown>,
    };
  };

  test("missing or mistyped inputs are a 422 with the run panel's sentence; complete ones are saved and read back", async () => {
    const refusals: [unknown, string][] = [
      [undefined, "请填写 主题。"],
      [{ topic: "发布", tone: "随意" }, "语气 需要从选项中选择。"],
      [{ topic: "发布", other: "x" }, "流程没有声明输入 other。"],
      [{ topic: 7 }, "流程输入格式不正确。"],
    ];
    for (const [inputs, error] of refusals) {
      const response = await post(alice, {
        name: "周报",
        target: { kind: "wakerflow", flowId, ...(inputs ? { inputs } : {}) },
      });
      expect({ status: response.status, error: response.json.error }).toEqual({
        status: 422,
        error,
      });
    }

    const saved = await post(alice, {
      name: "周报",
      target: { kind: "wakerflow", flowId, inputs: { topic: "发布" } },
    });
    expect(saved.status).toBe(201);
    const automation = saved.json.automation as {
      id: string;
      target: unknown;
    };
    created.push({ tenant: alice, id: automation.id });
    expect(automation.target).toEqual({
      kind: "wakerflow",
      flowId,
      inputs: { topic: "发布" },
    });
    const read = await flowRoutes.request(
      `http://openbot.test/${automation.id}`,
      { headers: { "x-test-user": alice } },
    );
    expect(
      ((await read.json()) as { automation: { target: unknown } }).automation
        .target,
    ).toEqual({ kind: "wakerflow", flowId, inputs: { topic: "发布" } });

    // Another tenant's Flow is not found, whatever inputs come with it.
    const stranger = await post(bob, {
      name: "周报",
      target: { kind: "wakerflow", flowId, inputs: { topic: "发布" } },
    });
    expect({ status: stranger.status, error: stranger.json.error }).toEqual({
      status: 422,
      error: "找不到这个 WakerFlow。",
    });
  });
});

/*
 * The management list carries each automation's triggers, so a screen showing what fires each one
 * reads the list once instead of `GET /:id` per automation. The triggers are the same rows, in the
 * same order, as the detail answers, and another tenant's never appear.
 */
describe("the list carries each automation's triggers", () => {
  test("every listed automation has its own triggers, as the detail reads them", async () => {
    const withTwo = await createAs(alice, wakerA);
    const withNone = await createAs(alice, wakerA);
    for (const body of [
      { kind: "schedule", cron: "0 9 * * 1-5", timezone: "Asia/Shanghai" },
      { kind: "webhook" },
    ]) {
      const added = await call(alice, "POST", `/${withTwo.id}/triggers`, body);
      expect(added.status).toBe(201);
    }
    const bobs = await createAs(bob, wakerB);
    expect(
      (await call(bob, "POST", `/${bobs.id}/triggers`, { kind: "webhook" }))
        .status,
    ).toBe(201);

    const listed = await call(alice, "GET", "/");
    expect(listed.status).toBe(200);
    const rows = listed.json.automations as {
      id: string;
      triggers: { automationId: string }[];
    }[];
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.has(bobs.id)).toBe(false);

    const detail = await call(alice, "GET", `/${withTwo.id}`);
    expect(byId.get(withTwo.id)?.triggers).toEqual(
      detail.json.triggers as never,
    );
    expect(byId.get(withTwo.id)?.triggers).toHaveLength(2);
    expect(byId.get(withNone.id)?.triggers).toEqual([]);
    for (const row of rows) {
      for (const trigger of row.triggers) {
        expect(trigger.automationId).toBe(row.id);
      }
    }
  });
});
