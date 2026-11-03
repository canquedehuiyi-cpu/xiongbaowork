import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { LLMock } from "@copilotkit/aimock";
import { and, eq } from "drizzle-orm";
import {
  PLATFORM_FLOW_MODEL_ID,
  WAKERFLOW_PLAN_FORMAT_MESSAGE,
  type WakerFlowPlan,
} from "../../shared/wakerflows";
import { createCredentialStore, encryptSecret } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  agents,
  credentials,
  groupTaskTemplates,
  modelRegistry,
  wakerFlowRequests,
  wakerFlows,
  wakerGroups,
} from "../src/db/schema";
import { createPipelineStore } from "../src/pipeline/store";
import { createTaskProjector } from "../src/tasks/projector";
import { runAsTenant } from "../src/tenant/context";
import { createFlowGenerator } from "../src/wakerflows/generator";
import { createFlowModelResolver } from "../src/wakerflows/model";
import {
  createWakerFlowStore,
  WakerFlowNotFoundError,
  WakerFlowRequestConflictError,
} from "../src/wakerflows/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * WF-B (spec D10, stories WF2/WF3): natural-language planning on the real database under row-level
 * security, through the real AI SDK, against a local mock provider only.
 *
 * Ported where applicable from the archived wakerflows.integration.test.after.ts (unpublished-c89/
 * wakerflow-card, lines 191-353, 558-628, 670-822 and 1014-1152). The "journal" is what the local
 * provider received: `LLMock.getRequests()`, or the request count of a local `Bun.serve` where the
 * test needs a provider that holds or refuses the call. No real provider is ever reached: every model
 * row points at 127.0.0.1, and OPENAI_BASE_URL is pointed at the mock too while a test runs.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const encryptionKey = Buffer.alloc(32, 21).toString("base64");
const credentialStore = createCredentialStore(database);
const tenants: string[] = [];

afterAll(async () => {
  for (const tenantId of tenants) {
    await runAsTenant(tenantId, async () => {
      await database
        .delete(wakerFlowRequests)
        .where(eq(wakerFlowRequests.tenantId, tenantId));
      await database
        .delete(groupTaskTemplates)
        .where(eq(groupTaskTemplates.tenantId, tenantId));
      await database
        .delete(wakerFlows)
        .where(eq(wakerFlows.tenantId, tenantId));
      await database
        .delete(wakerGroups)
        .where(eq(wakerGroups.tenantId, tenantId));
      await database
        .delete(modelRegistry)
        .where(eq(modelRegistry.tenantId, tenantId));
      await database
        .delete(credentials)
        .where(eq(credentials.tenantId, tenantId));
      await database.delete(agents).where(eq(agents.tenantId, tenantId));
    });
  }
  await database.$client.close();
});

/** A model row in the tenant's library, keyed with a synthetic secret, served from `baseUrl`. */
async function connectModel(
  tenantId: string,
  baseUrl: string,
  modelName = `planner-${randomUUID()}`,
) {
  return runAsTenant(tenantId, async () => {
    const credential = await credentialStore.create({
      kind: "model",
      provider: "custom",
      keyId: `${tenantId}-${modelName}`,
      encryptedValue: await encryptSecret(encryptionKey, "synthetic-flow-key"),
      metadata: {},
    });
    const [row] = await database
      .insert(modelRegistry)
      .values({
        tenantId,
        provider: "custom",
        baseUrl,
        modelName,
        credentialId: credential.id,
      })
      .returning({ id: modelRegistry.id });
    if (!row) throw new Error("Fixture model not inserted.");
    return { id: row.id, credentialId: credential.id };
  });
}

async function fixture(baseUrl: string) {
  const tenantId = `flowgen-${randomUUID()}`;
  tenants.push(tenantId);
  const member = `${tenantId}-worker`;
  const reviewer = `${tenantId}-reviewer`;
  await runAsTenant(tenantId, () =>
    database.insert(agents).values(
      [member, reviewer].map((id) => ({
        id,
        tenantId,
        name: id === member ? "小记" : "小审",
        type: "built_in" as const,
        configuration: {},
      })),
    ),
  );
  const plan: WakerFlowPlan = {
    name: "会议纪要",
    description: "整理与复核",
    members: [
      { agentId: member, role: "记录员" },
      { agentId: reviewer, role: "复核员" },
    ],
    inputs: [{ key: "notes", label: "会议内容", required: true }],
    steps: [
      {
        id: "draft",
        agentId: member,
        instruction: "整理纪要",
        inputKeys: ["notes"],
        outputKey: "summary",
      },
      {
        id: "review",
        agentId: reviewer,
        instruction: "复核纪要",
        inputKeys: ["summary"],
        outputKey: "result",
      },
    ],
  };
  const canUse = async (actor: string, agentId: string) =>
    actor === tenantId && (agentId === member || agentId === reviewer);
  const board = createTaskProjector(database);
  const pipeline = createPipelineStore({
    database,
    board,
    canUse,
    executeStep: async () => ({ status: "done", output: "mock" }),
  });
  const quotaAsked: string[] = [];
  const options = {
    database,
    pipeline,
    board,
    canUse,
    models: createFlowModelResolver({ database, encryptionKey }),
    generator: createFlowGenerator(),
    quota: {
      assertCapacity: async (tenant: string) => {
        quotaAsked.push(tenant);
      },
    },
  };
  const store = createWakerFlowStore(options);
  const flow = await store.create(tenantId, { idea: "整理会议" });
  const model = await connectModel(tenantId, baseUrl);
  const input = {
    requestId: randomUUID(),
    modelRef: model.id,
    idea: "整理每周例会的纪要",
    members: [
      { agentId: member, name: "小记", role: "记录员" },
      { agentId: reviewer, name: "小审", role: "复核员" },
    ],
  };
  return {
    tenantId,
    member,
    reviewer,
    plan,
    options,
    store,
    flow,
    model,
    input,
    quotaAsked,
  };
}

async function requestRows(tenantId: string) {
  return runAsTenant(tenantId, () =>
    database
      .select()
      .from(wakerFlowRequests)
      .where(eq(wakerFlowRequests.tenantId, tenantId)),
  );
}

/** One LLMock per test, with OPENAI_BASE_URL pointed at it so nothing can fall through to a real one. */
async function withMock(
  content: string,
  body: (mock: LLMock, baseUrl: string) => Promise<void>,
) {
  const mock = new LLMock();
  const originalBase = process.env.OPENAI_BASE_URL;
  try {
    const base = await mock.start();
    process.env.OPENAI_BASE_URL = base;
    if (content) mock.onMessage(/.*/, { content });
    await body(mock, `${base}/v1`);
  } finally {
    if (originalBase === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = originalBase;
    await mock.stop();
  }
}

/** A provider this test controls: it counts, then holds or answers as `respond` says. */
function localProvider(
  respond: (request: Request) => Promise<Response> | Response,
) {
  const received: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      received.push(new URL(request.url).pathname);
      return respond(request);
    },
  });
  return {
    received,
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    stop: () => server.stop(true),
  };
}

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => error,
  );

test("two stores racing on one request id reach the provider once and write one draft", async () => {
  await withMock("", async (mock, baseUrl) => {
    const f = await fixture(baseUrl);
    mock.clearFixtures();
    mock.onMessage(/.*/, {
      content: `这是计划：${JSON.stringify(f.plan)}`,
    });
    const answers = await Promise.all([
      f.store.generate(f.tenantId, f.tenantId, f.flow.id, f.input),
      createWakerFlowStore(f.options).generate(
        f.tenantId,
        f.tenantId,
        f.flow.id,
        f.input,
      ),
    ]);
    expect(answers.some((answer) => answer.status === "completed")).toBeTrue();
    for (const answer of answers)
      expect(["pending", "completed"]).toContain(answer.status);
    expect(mock.getRequests()).toHaveLength(1);
    // The model really was given the coworkers the person offered.
    const sent = JSON.stringify(mock.getRequests()[0]?.body);
    expect(sent).toContain(f.member);
    expect(sent).toContain("小审");

    const repeated = await f.store.generate(
      f.tenantId,
      f.tenantId,
      f.flow.id,
      f.input,
    );
    expect(repeated).toMatchObject({
      requestId: f.input.requestId,
      flowId: f.flow.id,
      kind: "generate",
      status: "completed",
      error: null,
      result: {
        plan: f.plan,
        modelRef: f.model.id,
        revision: 1,
        applied: true,
      },
    });
    expect(mock.getRequests()).toHaveLength(1);
    expect(await requestRows(f.tenantId)).toHaveLength(1);

    // The draft holds the plan but is not runnable until it is saved.
    const draft = await f.store.inspect(f.tenantId, f.flow.id);
    expect(draft).toMatchObject({
      status: "draft",
      plan: f.plan,
      name: f.plan.name,
      modelRef: f.model.id,
      revision: 1,
      groupId: null,
      templateId: null,
    });
    // Model, then quota, then the claim: each racer asks before claiming, always for this tenant,
    // and the repeat answered from the row without asking again.
    expect(f.quotaAsked.length).toBeGreaterThanOrEqual(1);
    expect(f.quotaAsked.length).toBeLessThanOrEqual(2);
    expect(new Set(f.quotaAsked)).toEqual(new Set([f.tenantId]));
    const saved = await f.store.save(f.tenantId, f.tenantId, f.flow.id, {
      revision: 1,
      plan: f.plan,
    });
    expect(saved.status).toBe("ready");
    expect(
      (await f.store.getRequest(f.tenantId, f.input.requestId))?.status,
    ).toBe("completed");
  });
});

test("a request id reused with changed arguments is a 409 and never a second call", async () => {
  await withMock("", async (mock, baseUrl) => {
    const f = await fixture(baseUrl);
    mock.clearFixtures();
    mock.onMessage(/.*/, { content: JSON.stringify(f.plan) });
    await f.store.generate(f.tenantId, f.tenantId, f.flow.id, f.input);
    for (const changed of [
      { ...f.input, idea: "另一个想法" },
      { ...f.input, members: f.input.members.slice(0, 1) },
      { ...f.input, scenario: "帮我创建会议纪要流程，整理结论、待办和负责人" },
    ]) {
      const error = await failure(
        f.store.generate(f.tenantId, f.tenantId, f.flow.id, changed),
      );
      expect(error).toBeInstanceOf(WakerFlowRequestConflictError);
      expect((error as WakerFlowRequestConflictError).status).toBe(409);
      expect((error as Error).message).toContain("另一项操作");
    }
    // Same id against another Flow of the same tenant is a different intent too.
    const other = await f.store.create(f.tenantId, { idea: "另一个流程" });
    const crossFlow = await failure(
      f.store.generate(f.tenantId, f.tenantId, other.id, f.input),
    );
    expect(crossFlow).toBeInstanceOf(WakerFlowRequestConflictError);
    expect(mock.getRequests()).toHaveLength(1);
    expect(await requestRows(f.tenantId)).toHaveLength(1);
  });
});

test("an answer that is not a plan fails the request and leaves the draft as it was", async () => {
  await withMock("抱歉，这次没有计划。", async (mock, baseUrl) => {
    const f = await fixture(baseUrl);
    const failed = await f.store.generate(
      f.tenantId,
      f.tenantId,
      f.flow.id,
      f.input,
    );
    expect(failed).toMatchObject({
      status: "failed",
      error: WAKERFLOW_PLAN_FORMAT_MESSAGE,
      result: null,
    });
    expect(mock.getRequests()).toHaveLength(1);
    expect(await f.store.inspect(f.tenantId, f.flow.id)).toMatchObject({
      status: "draft",
      plan: null,
      revision: 0,
      modelRef: null,
    });
    // The failed id answers from its row; a retry is a NEW id, and that one may call again.
    expect(
      (await f.store.generate(f.tenantId, f.tenantId, f.flow.id, f.input))
        .status,
    ).toBe("failed");
    expect(mock.getRequests()).toHaveLength(1);
    mock.clearFixtures();
    mock.onMessage(/.*/, { content: JSON.stringify(f.plan) });
    const retried = await f.store.generate(f.tenantId, f.tenantId, f.flow.id, {
      ...f.input,
      requestId: randomUUID(),
    });
    expect(retried.status).toBe("completed");
    expect(mock.getRequests()).toHaveLength(2);
  });
});

test("a plan for a Flow that was already saved is returned but never written behind its template", async () => {
  await withMock("", async (mock, baseUrl) => {
    const f = await fixture(baseUrl);
    const saved = await f.store.save(f.tenantId, f.tenantId, f.flow.id, {
      revision: 0,
      plan: f.plan,
    });
    const proposal = { ...f.plan, name: "新的纪要流程" };
    mock.clearFixtures();
    mock.onMessage(/.*/, { content: JSON.stringify(proposal) });
    const answer = await f.store.generate(
      f.tenantId,
      f.tenantId,
      f.flow.id,
      f.input,
    );
    expect(answer).toMatchObject({
      status: "completed",
      result: { plan: proposal, applied: false, revision: null },
    });
    expect(await f.store.inspect(f.tenantId, f.flow.id)).toMatchObject({
      status: "ready",
      plan: f.plan,
      revision: saved.revision,
      templateId: saved.templateId,
    });
  });
});

test("cancelling mid-call reaches the provider once, records cancelled, and writes nothing", async () => {
  let release: (() => void) | undefined;
  const provider = localProvider(
    (request) =>
      new Promise<Response>((resolve) => {
        const answer = () => resolve(new Response(null, { status: 499 }));
        release = answer;
        request.signal.addEventListener("abort", answer);
      }),
  );
  try {
    const f = await fixture(provider.baseUrl);
    const pending = f.store.generate(
      f.tenantId,
      f.tenantId,
      f.flow.id,
      f.input,
    );
    for (let wait = 0; provider.received.length === 0 && wait < 200; wait++)
      await Bun.sleep(25);
    expect(provider.received).toEqual(["/v1/chat/completions"]);
    expect(
      (await f.store.getRequest(f.tenantId, f.input.requestId))?.status,
    ).toBe("pending");
    // Another tenant cannot cancel it: it is not there.
    expect(
      await f.store.cancel("foreign-tenant", f.flow.id, f.input.requestId),
    ).toBeNull();
    const cancelled = await f.store.cancel(
      f.tenantId,
      f.flow.id,
      f.input.requestId,
    );
    expect(cancelled?.status).toBe("cancelled");
    expect((await pending).status).toBe("cancelled");
    expect(provider.received).toHaveLength(1);
    expect(await f.store.inspect(f.tenantId, f.flow.id)).toMatchObject({
      plan: null,
      revision: 0,
    });
    // Repeating the cancelled request answers from its row and does not call again.
    expect(
      (await f.store.generate(f.tenantId, f.tenantId, f.flow.id, f.input))
        .status,
    ).toBe("cancelled");
    expect(provider.received).toHaveLength(1);
    const rows = await requestRows(f.tenantId);
    expect(rows.map((row) => row.status)).toEqual(["cancelled"]);
    // Deleting is allowed again once nothing is pending.
    expect(await f.store.remove(f.tenantId, f.flow.id)).toBeTrue();
  } finally {
    release?.();
    provider.stop();
  }
});

test("an uncertain provider outcome is recorded once as unknown, without its text, and never replayed", async () => {
  let status = 503;
  const provider = localProvider(() =>
    Response.json(
      { error: { message: "synthetic secret in upstream error" } },
      { status },
    ),
  );
  try {
    const f = await fixture(provider.baseUrl);
    const first = await f.store.generate(
      f.tenantId,
      f.tenantId,
      f.flow.id,
      f.input,
    );
    expect(first.status).toBe("unknown");
    expect(JSON.stringify(first)).not.toContain("synthetic secret");
    for (const store of [f.store, createWakerFlowStore(f.options)]) {
      expect(
        (await store.generate(f.tenantId, f.tenantId, f.flow.id, f.input))
          .status,
      ).toBe("unknown");
    }
    expect(provider.received).toHaveLength(1);
    // A definite refusal is `failed`, also without the provider's words.
    status = 401;
    const refused = await f.store.generate(f.tenantId, f.tenantId, f.flow.id, {
      ...f.input,
      requestId: randomUUID(),
    });
    expect(refused.status).toBe("failed");
    expect(JSON.stringify(refused)).not.toContain("synthetic secret");
    expect(provider.received).toHaveLength(2);
    const rows = await requestRows(f.tenantId);
    expect(rows.map((row) => row.error).join(" ")).not.toContain(
      "synthetic secret",
    );
    expect(await f.store.inspect(f.tenantId, f.flow.id)).toMatchObject({
      plan: null,
      revision: 0,
    });
  } finally {
    provider.stop();
  }
});

test("a missing, foreign, disabled, revoked or platform model is refused before any row, quota or call", async () => {
  await withMock("", async (mock, baseUrl) => {
    const f = await fixture(baseUrl);
    mock.clearFixtures();
    mock.onMessage(/.*/, { content: JSON.stringify(f.plan) });
    const stranger = await fixture(baseUrl);
    const disabled = await connectModel(f.tenantId, baseUrl);
    await runAsTenant(f.tenantId, () =>
      database
        .update(modelRegistry)
        .set({ enabled: false })
        .where(eq(modelRegistry.id, disabled.id)),
    );
    const revoked = await connectModel(f.tenantId, baseUrl);
    await runAsTenant(f.tenantId, () =>
      database
        .update(credentials)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(credentials.id, revoked.credentialId),
            eq(credentials.tenantId, f.tenantId),
          ),
        ),
    );

    // The picker lists the tenant's own usable model only; the platform model is not offered.
    expect(
      (await f.options.models.choices(f.tenantId)).map((choice) => choice.id),
    ).toEqual([f.model.id]);

    for (const [modelRef, words] of [
      [randomUUID(), "不可用"],
      [stranger.model.id, "不可用"],
      [disabled.id, "不可用"],
      [revoked.id, "不可用"],
      [PLATFORM_FLOW_MODEL_ID, "未配置"],
    ] as const) {
      const error = await failure(
        f.store.generate(f.tenantId, f.tenantId, f.flow.id, {
          ...f.input,
          requestId: randomUUID(),
          modelRef,
        }),
      );
      expect((error as { status?: number }).status).toBe(400);
      expect((error as Error).message).toContain(words);
    }
    // A coworker the actor may not use is refused at the same point.
    const refusedMember = await failure(
      f.store.generate(f.tenantId, f.tenantId, f.flow.id, {
        ...f.input,
        requestId: randomUUID(),
        members: [{ agentId: stranger.member, name: "外人", role: "外人" }],
      }),
    );
    expect((refusedMember as Error).message).toContain("无权使用");
    expect(f.quotaAsked).toEqual([]);
    expect(await requestRows(f.tenantId)).toHaveLength(0);
    expect(mock.getRequests()).toHaveLength(0);
    expect(await f.store.inspect(f.tenantId, f.flow.id)).toMatchObject({
      plan: null,
      revision: 0,
    });
  });
});

test("a quota refusal leaves no request row and no call", async () => {
  await withMock("", async (mock, baseUrl) => {
    const f = await fixture(baseUrl);
    mock.clearFixtures();
    mock.onMessage(/.*/, { content: JSON.stringify(f.plan) });
    const store = createWakerFlowStore({
      ...f.options,
      quota: {
        assertCapacity: async () => {
          throw new Error("synthetic quota refusal");
        },
      },
    });
    await expect(
      store.generate(f.tenantId, f.tenantId, f.flow.id, f.input),
    ).rejects.toThrow("synthetic quota refusal");
    expect(await requestRows(f.tenantId)).toHaveLength(0);
    expect(mock.getRequests()).toHaveLength(0);
  });
});

test("another tenant can neither plan, read nor cancel this tenant's Flow or requests", async () => {
  await withMock("", async (mock, baseUrl) => {
    const f = await fixture(baseUrl);
    mock.clearFixtures();
    mock.onMessage(/.*/, { content: JSON.stringify(f.plan) });
    const other = await fixture(baseUrl);
    // The other tenant uses its OWN usable model and its own coworkers, against this tenant's Flow.
    const error = await failure(
      other.store.generate(other.tenantId, other.tenantId, f.flow.id, {
        ...other.input,
      }),
    );
    expect(error).toBeInstanceOf(WakerFlowNotFoundError);
    expect(mock.getRequests()).toHaveLength(0);
    expect(await requestRows(other.tenantId)).toHaveLength(0);
    expect(await requestRows(f.tenantId)).toHaveLength(0);
    expect(other.quotaAsked).toEqual([]);

    await f.store.generate(f.tenantId, f.tenantId, f.flow.id, f.input);
    expect(mock.getRequests()).toHaveLength(1);
    expect(
      await other.store.getRequest(other.tenantId, f.input.requestId),
    ).toBeNull();
    expect(
      await other.store.cancel(other.tenantId, f.flow.id, f.input.requestId),
    ).toBeNull();
    // The same request id in another tenant is that tenant's own, separate request.
    mock.clearFixtures();
    mock.onMessage(/.*/, { content: JSON.stringify(other.plan) });
    const own = await other.store.generate(
      other.tenantId,
      other.tenantId,
      other.flow.id,
      { ...other.input, requestId: f.input.requestId },
    );
    expect(own.status).toBe("completed");
    expect(own.flowId).toBe(other.flow.id);
    expect(mock.getRequests()).toHaveLength(2);
    expect(
      (await f.store.getRequest(f.tenantId, f.input.requestId))?.flowId,
    ).toBe(f.flow.id);
  });
});
