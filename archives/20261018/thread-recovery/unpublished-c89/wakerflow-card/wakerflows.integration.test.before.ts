import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { LanguageModel } from "ai";
import { eq } from "drizzle-orm";
import {
  PLATFORM_FLOW_MODEL_ID,
  type WakerFlowPlan,
} from "../../shared/wakerflows";
import {
  configureBotLifecycle,
  resetBotLifecycleForTests,
} from "../src/agents/lifecycle";
import { createAuditStore } from "../src/audit";
import { encryptSecret } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  agents,
  credentials,
  groupTaskRuns,
  groupTaskTemplates,
  modelRegistry,
  modelUsage,
  tasks,
  wakerFlowRequests,
  wakerFlows,
  wakerGroups,
} from "../src/db/schema";
import { createPipelineStore } from "../src/pipeline/store";
import { createTaskProjector } from "../src/tasks/projector";
import { createTaskRoutes } from "../src/tasks/routes";
import { runAsTenant } from "../src/tenant/context";
import { createWakerGroupStore } from "../src/waker-groups/store";
import { createFlowGenerator } from "../src/wakerflows/generator";
import { createFlowModelResolver } from "../src/wakerflows/model";
import { createWakerFlowRoutes } from "../src/wakerflows/routes";
import { createWakerFlowStore } from "../src/wakerflows/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
function resolvedModelId(model: LanguageModel) {
  if (typeof model === "string")
    throw new Error("Expected the resolver's concrete provider model.");
  return model.modelId;
}
const tenants: string[] = [];
async function fixture() {
  const tenantId = `flow-${randomUUID()}`;
  tenants.push(tenantId);
  const member = `${tenantId}-worker`;
  await runAsTenant(tenantId, () =>
    database.insert(agents).values({
      id: member,
      tenantId,
      name: "Own worker",
      type: "built_in",
      configuration: {},
    }),
  );
  const plan: WakerFlowPlan = {
    name: "会议纪要",
    description: "整理与复核",
    members: [{ agentId: member, role: "记录员" }],
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
        agentId: member,
        instruction: "复核纪要",
        inputKeys: ["summary"],
        outputKey: "result",
      },
    ],
  };
  const board = createTaskProjector(database);
  const invoked: string[] = [];
  const pipeline = createPipelineStore({
    database,
    board,
    canUse: async (owner, id) => owner === tenantId && id === member,
    executeStep: async (input) => {
      invoked.push(input.instruction);
      return { status: "done", output: `output-${invoked.length}` };
    },
  });
  let generations = 0;
  const options = {
    database,
    pipeline,
    board,
    canUse: async (owner: string, id: string) =>
      owner === tenantId && id === member,
    preflight: async () => {},
    generate: async () => {
      generations += 1;
      return plan;
    },
  };
  const store = createWakerFlowStore(options);
  const flow = await store.create(tenantId, { idea: "整理会议" });
  const modelRef = randomUUID();
  const input = {
    requestId: randomUUID(),
    modelRef,
    idea: "整理会议",
    members: plan.members,
  };
  return {
    tenantId,
    member,
    plan,
    board,
    pipeline,
    options,
    store,
    flow,
    modelRef,
    input,
    invoked,
    generations: () => generations,
  };
}

test("Flow plans are private, revision fenced, and protected from generic crew/template mutation", async () => {
  const f = await fixture();
  expect(await f.store.inspect("foreign", f.flow.id)).toBeNull();
  expect(await f.store.list("foreign")).toEqual([]);
  const saved = await f.store.save(f.tenantId, f.flow.id, {
    revision: 0,
    plan: f.plan,
    modelRef: f.modelRef,
  });
  expect(saved).toMatchObject({
    status: "ready",
    revision: 1,
    modelRef: f.modelRef,
  });
  await expect(
    f.store.save(f.tenantId, f.flow.id, { revision: 0, plan: f.plan }),
  ).rejects.toThrow("另一处修改");
  if (!saved.groupId || !saved.templateId)
    throw new Error("Saved Flow has no compiled plan.");
  await runAsTenant(f.tenantId, async () => {
    const groups = createWakerGroupStore(database);
    expect(await groups.list()).toEqual([]);
    expect(
      await groups.setMembers(saved.groupId as string, [f.member]),
    ).toBeNull();
    expect(await groups.remove(saved.groupId as string)).toBeFalse();
  });
  expect(await f.pipeline.listTemplates({ tenantId: f.tenantId })).toEqual([]);
  await expect(
    f.pipeline.createTemplate({
      tenantId: f.tenantId,
      groupId: saved.groupId,
      name: "bypass",
      steps: f.plan.steps,
    }),
  ).rejects.toThrow("WakerFlow 内");
  await expect(
    f.pipeline.start({
      tenantId: f.tenantId,
      templateId: saved.templateId,
      task: "bypass",
      initiatedBy: f.tenantId,
    }),
  ).rejects.toThrow();
  const edited = await f.store.save(f.tenantId, f.flow.id, {
    revision: 1,
    plan: { ...f.plan, name: "修改后的纪要" },
  });
  expect(edited.templateId).not.toBe(saved.templateId);
  const versions = await runAsTenant(f.tenantId, () =>
    database
      .select()
      .from(groupTaskTemplates)
      .where(eq(groupTaskTemplates.tenantId, f.tenantId)),
  );
  expect(versions).toHaveLength(2);
  expect(versions.find((row) => row.id === saved.templateId)?.steps).toEqual(
    f.plan.steps,
  );
});

test("a generation identity admits one mock call and one card, and rejects changed arguments", async () => {
  const f = await fixture();
  const answers = await Promise.all([
    f.store.generate(f.tenantId, f.flow.id, f.input),
    createWakerFlowStore(f.options).generate(f.tenantId, f.flow.id, f.input),
  ]);
  expect(answers.some((row) => row.status === "completed")).toBeTrue();
  expect(f.generations()).toBe(1);
  const repeated = await f.store.generate(f.tenantId, f.flow.id, f.input);
  expect(repeated).toMatchObject({
    status: "completed",
    result: { plan: f.plan, modelRef: f.modelRef, revision: 0 },
  });
  await expect(
    f.store.generate(f.tenantId, f.flow.id, { ...f.input, idea: "different" }),
  ).rejects.toThrow("另一项操作");
  expect(f.generations()).toBe(1);
  const cards = await runAsTenant(f.tenantId, () =>
    database.select().from(tasks).where(eq(tasks.tenantId, f.tenantId)),
  );
  expect(cards).toHaveLength(1);
});

test("model or employee refusal precedes request claims, quota cards and generation", async () => {
  const f = await fixture();
  const refused = createWakerFlowStore({
    ...f.options,
    preflight: async () => {
      throw new Error("selected model refused");
    },
  });
  await expect(
    refused.generate(f.tenantId, f.flow.id, f.input),
  ).rejects.toThrow("selected model refused");
  await expect(
    f.store.generate(f.tenantId, f.flow.id, {
      ...f.input,
      members: [{ agentId: "foreign-worker", role: "foreign" }],
    }),
  ).rejects.toThrow("无权使用");
  expect(f.generations()).toBe(0);
  await runAsTenant(f.tenantId, async () => {
    expect(
      await database
        .select()
        .from(wakerFlowRequests)
        .where(eq(wakerFlowRequests.tenantId, f.tenantId)),
    ).toHaveLength(0);
    expect(
      await database.select().from(tasks).where(eq(tasks.tenantId, f.tenantId)),
    ).toHaveLength(0);
  });
});

test("an uncertain planning call is recorded once without provider error leakage or automatic replay", async () => {
  const f = await fixture();
  let calls = 0;
  const options = {
    ...f.options,
    generate: async () => {
      calls += 1;
      throw new Error("synthetic secret in upstream error");
    },
  };
  const store = createWakerFlowStore(options);
  const result = await store.generate(f.tenantId, f.flow.id, f.input);
  expect(result.status).toBe("unknown");
  expect(JSON.stringify(result)).not.toContain("synthetic secret");
  expect((await store.generate(f.tenantId, f.flow.id, f.input)).status).toBe(
    "unknown",
  );
  expect(
    (
      await createWakerFlowStore(options).generate(
        f.tenantId,
        f.flow.id,
        f.input,
      )
    ).status,
  ).toBe("unknown");
  expect(calls).toBe(1);
});

test("a missing planning model is refused over HTTP before any request, card, usage or provider dispatch", async () => {
  const f = await fixture();
  let resolved = 0;
  let generated = 0;
  const generator = createFlowGenerator({
    database,
    encryptionKey: Buffer.alloc(32, 12).toString("base64"),
    audit: createAuditStore(database),
    platform: {
      name: "custom/missing-fixture-model",
      available: async () => false,
      resolve: async () => {
        resolved += 1;
        throw new Error(
          "An unavailable platform must never resolve a provider.",
        );
      },
    },
  });
  const store = createWakerFlowStore({
    ...f.options,
    ...generator,
    generate: async (input) => {
      generated += 1;
      return generator.generate(input);
    },
  });
  const routes = createWakerFlowRoutes(
    store,
    f.pipeline,
    async (context, next) => {
      context.set("actor", {
        id: f.tenantId,
        email: "flow-fixture@example.test",
        role: "user",
      });
      await next();
    },
  );
  const choices = await routes.request("/model-choices");
  expect(choices.status).toBe(200);
  expect(await choices.json()).toEqual({ models: [] });
  for (const modelRef of [PLATFORM_FLOW_MODEL_ID, randomUUID()]) {
    const response = await routes.request(`/${f.flow.id}/generate`, {
      method: "POST",
      body: JSON.stringify({ ...f.input, modelRef }),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain(
      modelRef === PLATFORM_FLOW_MODEL_ID ? "未配置" : "不可用",
    );
  }
  expect(generated).toBe(0);
  expect(resolved).toBe(0);
  await runAsTenant(f.tenantId, async () => {
    expect(
      await database
        .select()
        .from(wakerFlowRequests)
        .where(eq(wakerFlowRequests.tenantId, f.tenantId)),
    ).toHaveLength(0);
    expect(
      await database.select().from(tasks).where(eq(tasks.tenantId, f.tenantId)),
    ).toHaveLength(0);
    expect(
      await database
        .select()
        .from(modelUsage)
        .where(eq(modelUsage.tenantId, f.tenantId)),
    ).toHaveLength(0);
    expect(
      await database
        .select()
        .from(groupTaskRuns)
        .where(eq(groupTaskRuns.tenantId, f.tenantId)),
    ).toHaveLength(0);
  });
});

test("a stopped Flow stays terminal after stores are reconstructed and the original run request is repeated", async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let calls = 0;
  const pipelineOptions = {
    database,
    board: f.board,
    canUse: f.options.canUse,
    executeStep: async () => {
      calls += 1;
      entered.resolve();
      await release.promise;
      return { status: "done" as const, output: "late stopped output" };
    },
  };
  const pipeline = createPipelineStore(pipelineOptions);
  const store = createWakerFlowStore({ ...f.options, pipeline });
  await store.save(f.tenantId, f.flow.id, { revision: 0, plan: f.plan });
  const input = {
    requestId: randomUUID(),
    revision: 1,
    inputs: { notes: "synthetic stop fixture" },
  };
  const request = await store.start(f.tenantId, f.flow.id, input);
  if (!request.runId) throw new Error("Flow did not register its run.");
  const running = pipeline.advance({
    tenantId: f.tenantId,
    runId: request.runId,
  });
  try {
    await entered.promise;
    expect(
      (await pipeline.abort({ tenantId: f.tenantId, runId: request.runId }))
        .status,
    ).toBe("aborted");
  } finally {
    release.resolve();
    await running;
  }
  expect(calls).toBe(1);
  const before = await runAsTenant(f.tenantId, async () => ({
    cards: await database
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.tenantId, f.tenantId)),
    requests: await database
      .select({ id: wakerFlowRequests.id })
      .from(wakerFlowRequests)
      .where(eq(wakerFlowRequests.tenantId, f.tenantId)),
  }));
  const reconstructedPipeline = createPipelineStore(pipelineOptions);
  const reconstructedStore = createWakerFlowStore({
    ...f.options,
    pipeline: reconstructedPipeline,
  });
  expect(
    (await reconstructedStore.start(f.tenantId, f.flow.id, input)).runId,
  ).toBe(request.runId);
  expect(
    (
      await reconstructedPipeline.advance({
        tenantId: f.tenantId,
        runId: request.runId,
      })
    ).status,
  ).toBe("aborted");
  const inspected = await reconstructedPipeline.inspect({
    tenantId: f.tenantId,
    runId: request.runId,
  });
  expect(inspected?.status).toBe("aborted");
  expect(inspected?.steps.map((step) => step.state)).toEqual([
    "aborted",
    "aborted",
  ]);
  expect(calls).toBe(1);
  const after = await runAsTenant(f.tenantId, async () => ({
    cards: await database
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.tenantId, f.tenantId)),
    requests: await database
      .select({ id: wakerFlowRequests.id })
      .from(wakerFlowRequests)
      .where(eq(wakerFlowRequests.tenantId, f.tenantId)),
  }));
  expect(after.cards.map((card) => card.id).sort()).toEqual(
    before.cards.map((card) => card.id).sort(),
  );
  expect(after.requests.map((row) => row.id).sort()).toEqual(
    before.requests.map((row) => row.id).sort(),
  );
});

test("saved Flow runs preserve named inputs, reserve one parent and two children and deduplicate", async () => {
  const f = await fixture();
  await f.store.save(f.tenantId, f.flow.id, { revision: 0, plan: f.plan });
  const input = {
    requestId: randomUUID(),
    revision: 1,
    inputs: { notes: "meeting-marker" },
  };
  const requests = await Promise.all([
    f.store.start(f.tenantId, f.flow.id, input),
    createWakerFlowStore(f.options).start(f.tenantId, f.flow.id, input),
  ]);
  const started = requests.find((row) => row.runId);
  if (!started?.runId) throw new Error("Flow did not start.");
  await f.pipeline.advance({ tenantId: f.tenantId, runId: started.runId });
  expect(f.invoked).toHaveLength(2);
  expect(f.invoked[0]).toContain("meeting-marker");
  expect(f.invoked[1]).toContain("output-1");
  expect((await f.store.start(f.tenantId, f.flow.id, input)).runId).toBe(
    started.runId,
  );
  const cards = await runAsTenant(f.tenantId, () =>
    database.select().from(tasks).where(eq(tasks.tenantId, f.tenantId)),
  );
  expect(cards).toHaveLength(3);
  expect(
    cards.filter((row) => row.parentTaskId === started.taskId),
  ).toHaveLength(2);
  await expect(
    f.store.run("foreign", f.flow.id, started.runId),
  ).rejects.toThrow("这里没有");
  await expect(
    f.store.start(f.tenantId, f.flow.id, {
      ...input,
      requestId: randomUUID(),
      inputs: {},
    }),
  ).rejects.toThrow();
  expect(f.invoked).toHaveLength(2);
});

test("partial run registration stays unknown and the same request never opens another card", async () => {
  const f = await fixture();
  await f.store.save(f.tenantId, f.flow.id, { revision: 0, plan: f.plan });
  let starts = 0;
  const pipeline = {
    ...f.pipeline,
    start: async (input: Parameters<typeof f.pipeline.start>[0]) => {
      starts += 1;
      await f.board.opened({
        tenantId: f.tenantId,
        title: "partial run",
        source: "group_run",
        runRef: input.runId as string,
        quotaUnits: 3,
      });
      throw new Error("lost registration");
    },
  };
  const store = createWakerFlowStore({ ...f.options, pipeline });
  const input = {
    requestId: randomUUID(),
    revision: 1,
    inputs: { notes: "safe mock" },
  };
  expect((await store.start(f.tenantId, f.flow.id, input)).status).toBe(
    "unknown",
  );
  expect((await store.start(f.tenantId, f.flow.id, input)).status).toBe(
    "unknown",
  );
  expect(starts).toBe(1);
  expect(await store.runs(f.tenantId, f.flow.id)).toHaveLength(0);
});

test("Flow HTTP routes require an actor and return 404 for foreign reads and writes", async () => {
  const f = await fixture();
  const foreign = createWakerFlowRoutes(
    f.store,
    f.pipeline,
    async (context, next) => {
      context.set("actor", {
        id: "foreign",
        role: "user",
        email: "foreign@example.test",
      });
      await next();
    },
  );
  expect((await foreign.request(`/${f.flow.id}`)).status).toBe(404);
  expect(
    (
      await foreign.request(`/${f.flow.id}/generate`, {
        method: "POST",
        body: JSON.stringify(f.input),
      })
    ).status,
  ).toBe(404);
  const anonymous = createWakerFlowRoutes(
    f.store,
    f.pipeline,
    async (context) => context.json({ error: "No actor" }, 401),
  );
  expect((await anonymous.request("/")).status).toBe(401);
  expect(
    (await anonymous.request("/", { method: "POST", body: "{}" })).status,
  ).toBe(401);
  expect(f.generations()).toBe(0);
});

test("selected planning models refuse foreign, disabled and revoked credentials without default fallback", async () => {
  const f = await fixture();
  const key = Buffer.alloc(32, 9).toString("base64");
  const [secret] = await runAsTenant(f.tenantId, () =>
    database
      .insert(credentials)
      .values({
        tenantId: f.tenantId,
        kind: "model",
        provider: "openai",
        keyId: f.tenantId,
        encryptedValue: "bad-envelope",
        metadata: {},
      })
      .returning(),
  );
  if (!secret) throw new Error("Fixture credential not inserted.");
  const [entry] = await runAsTenant(f.tenantId, () =>
    database
      .insert(modelRegistry)
      .values({
        tenantId: f.tenantId,
        provider: "openai",
        modelName: "selected-model",
        credentialId: secret.id,
      })
      .returning(),
  );
  if (!entry) throw new Error("Fixture model not inserted.");
  const resolver = createFlowModelResolver(database, key);
  expect(await resolver.name(f.tenantId, entry.id)).toBe(
    "openai/selected-model",
  );
  await expect(resolver.resolve(f.tenantId, entry.id)).rejects.toThrow(
    "凭据无法读取",
  );
  await expect(resolver.name("foreign", entry.id)).rejects.toThrow("不可用");
  await runAsTenant(f.tenantId, async () => {
    await database
      .update(credentials)
      .set({ encryptedValue: await encryptSecret(key, "synthetic-only-key") })
      .where(eq(credentials.id, secret.id));
    await database
      .update(modelRegistry)
      .set({ enabled: false })
      .where(eq(modelRegistry.id, entry.id));
  });
  await expect(resolver.resolve(f.tenantId, entry.id)).rejects.toThrow(
    "不可用",
  );
  await runAsTenant(f.tenantId, () =>
    database
      .update(modelRegistry)
      .set({ enabled: true })
      .where(eq(modelRegistry.id, entry.id)),
  );
  expect(
    resolvedModelId((await resolver.resolve(f.tenantId, entry.id)).model),
  ).toBe("selected-model");
  await runAsTenant(f.tenantId, () =>
    database
      .update(credentials)
      .set({ revokedAt: new Date() })
      .where(eq(credentials.id, secret.id)),
  );
  await expect(resolver.resolve(f.tenantId, entry.id)).rejects.toThrow(
    "不可用",
  );
});

test("plan history activates and rolls back as new revisions while retaining prior immutable versions", async () => {
  const f = await fixture();
  await f.store.generate(f.tenantId, f.flow.id, f.input);
  const [generated] = await f.store.history(f.tenantId, f.flow.id, "plan");
  if (!generated) throw new Error("No planning history.");
  const active = await f.store.activate(f.tenantId, f.flow.id, {
    revision: 0,
    historyId: generated.id,
  });
  expect(active).toMatchObject({
    revision: 1,
    name: f.plan.name,
    modelRef: f.modelRef,
  });
  const [version] = await f.store.history(f.tenantId, f.flow.id, "version");
  if (!version) throw new Error("No saved version.");
  await f.store.save(f.tenantId, f.flow.id, {
    revision: 1,
    plan: { ...f.plan, name: "changed" },
  });
  const restored = await f.store.activate(f.tenantId, f.flow.id, {
    revision: 2,
    historyId: version.id,
  });
  expect(restored).toMatchObject({ revision: 3, name: f.plan.name });
  expect(await f.store.history(f.tenantId, f.flow.id, "version")).toHaveLength(
    3,
  );
  await expect(
    f.store.activate(f.tenantId, f.flow.id, {
      revision: 1,
      historyId: version.id,
    }),
  ).rejects.toThrow("另一处修改");
  await expect(
    f.store.activate("foreign", f.flow.id, {
      revision: 3,
      historyId: version.id,
    }),
  ).rejects.toThrow("这里没有");
});

test("the real planning SDK calls only a disposable local provider once, including when it refuses", async () => {
  const f = await fixture();
  const key = Buffer.alloc(32, 11).toString("base64");
  let calls = 0;
  let refusing = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      calls += 1;
      expect(request.headers.get("authorization")).toBe(
        "Bearer synthetic-flow-key",
      );
      const body = (await request.json()) as { model: string };
      expect(body.model).toBe("mock-selected-model");
      if (refusing)
        return Response.json(
          { error: { message: "synthetic provider refusal" } },
          { status: 503 },
        );
      return Response.json({
        id: "local-completion",
        object: "chat.completion",
        created: 1,
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: JSON.stringify(f.plan) },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 80, completion_tokens: 120, total_tokens: 200 },
      });
    },
  });
  configureBotLifecycle({ database });
  try {
    const [secret] = await runAsTenant(
      f.tenantId,
      async () =>
        await database
          .insert(credentials)
          .values({
            tenantId: f.tenantId,
            kind: "model",
            provider: "custom",
            keyId: f.tenantId,
            encryptedValue: await encryptSecret(key, "synthetic-flow-key"),
            metadata: {},
          })
          .returning(),
    );
    if (!secret) throw new Error("No fixture credential.");
    const [model] = await runAsTenant(f.tenantId, () =>
      database
        .insert(modelRegistry)
        .values({
          tenantId: f.tenantId,
          provider: "custom",
          baseUrl: `http://127.0.0.1:${server.port}/v1`,
          credentialId: secret.id,
          modelName: "mock-selected-model",
        })
        .returning(),
    );
    if (!model) throw new Error("No fixture model.");
    const generator = createFlowGenerator({
      database,
      encryptionKey: key,
      audit: createAuditStore(database),
    });
    const store = createWakerFlowStore({ ...f.options, ...generator });
    const input = { ...f.input, modelRef: model.id };
    expect((await store.generate(f.tenantId, f.flow.id, input)).status).toBe(
      "completed",
    );
    expect((await store.generate(f.tenantId, f.flow.id, input)).status).toBe(
      "completed",
    );
    expect(calls).toBe(1);
    refusing = true;
    const failedInput = { ...input, requestId: randomUUID() };
    expect(
      (await store.generate(f.tenantId, f.flow.id, failedInput)).status,
    ).toBe("unknown");
    expect(
      (await store.generate(f.tenantId, f.flow.id, failedInput)).status,
    ).toBe("unknown");
    expect(calls).toBe(2);
  } finally {
    resetBotLifecycleForTests();
    server.stop(true);
  }
});

test("the platform is an explicit choice and never substitutes for an unusable private model", async () => {
  const f = await fixture();
  let resolved = 0;
  const platform = {
    name: "custom/platform-plan",
    available: async () => true,
    resolve: async () => {
      resolved++;
      return (await import("../src/models/runtime-resolver")).languageModelFor(
        "custom",
        "http://127.0.0.1:1/v1",
        "platform-plan",
        "synthetic-only",
      );
    },
  };
  const resolver = createFlowModelResolver(
    database,
    Buffer.alloc(32, 7).toString("base64"),
    platform,
  );
  expect(await resolver.choices(f.tenantId)).toEqual([
    {
      id: PLATFORM_FLOW_MODEL_ID,
      name: platform.name,
      label: `平台模型 · ${platform.name}`,
    },
  ]);
  expect(await resolver.name(f.tenantId, PLATFORM_FLOW_MODEL_ID)).toBe(
    platform.name,
  );
  expect(
    resolvedModelId(
      (await resolver.resolve(f.tenantId, PLATFORM_FLOW_MODEL_ID)).model,
    ),
  ).toBe("platform-plan");
  await expect(resolver.resolve(f.tenantId, randomUUID())).rejects.toThrow(
    "不可用",
  );
  expect(resolved).toBe(1);
  const missing = createFlowModelResolver(database, "", {
    ...platform,
    available: async () => false,
  });
  expect(await missing.choices(f.tenantId)).toEqual([]);
  await expect(
    missing.name(f.tenantId, PLATFORM_FLOW_MODEL_ID),
  ).rejects.toThrow("未配置");
  await expect(
    createFlowModelResolver(database, "").resolve(
      f.tenantId,
      PLATFORM_FLOW_MODEL_ID,
    ),
  ).rejects.toThrow("未配置");
});

test("a Flow cannot be deleted during planning or while its saved run is active", async () => {
  const f = await fixture();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const store = createWakerFlowStore({
    ...f.options,
    generate: async () => {
      entered();
      await gate;
      return f.plan;
    },
  });
  const planning = store.generate(f.tenantId, f.flow.id, f.input);
  await started;
  await expect(store.remove(f.tenantId, f.flow.id, 0)).rejects.toThrow("仍有");
  release();
  await planning;
  await store.save(f.tenantId, f.flow.id, { revision: 0, plan: f.plan });
  const request = await store.start(f.tenantId, f.flow.id, {
    requestId: randomUUID(),
    revision: 1,
    inputs: { notes: "test" },
  });
  await expect(store.remove(f.tenantId, f.flow.id, 1)).rejects.toThrow("仍有");
  if (!request.runId) throw new Error("No run");
  await f.pipeline.abort({ tenantId: f.tenantId, runId: request.runId });
  await store.remove(f.tenantId, f.flow.id, 1);
  expect(await store.inspect(f.tenantId, f.flow.id)).toBeNull();
});

test("planning, parent and child task cards open the owning Flow and preserve the run identity", async () => {
  const f = await fixture();
  await f.store.generate(f.tenantId, f.flow.id, f.input);
  await f.store.save(f.tenantId, f.flow.id, { revision: 0, plan: f.plan });
  const started = await f.store.start(f.tenantId, f.flow.id, {
    requestId: randomUUID(),
    revision: 1,
    inputs: { notes: "local fixture" },
  });
  if (!started.runId) throw new Error("No run.");
  await f.pipeline.advance({ tenantId: f.tenantId, runId: started.runId });
  const routes = createTaskRoutes(
    database,
    async (context, next) => {
      context.set("actor", {
        id: f.tenantId,
        role: "user",
        email: `${f.tenantId}@example.test`,
      });
      await runAsTenant(f.tenantId, next);
    },
    f.board,
  );
  const response = await runAsTenant(f.tenantId, () => routes.request("/"));
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    tasks: { source: string; open: unknown }[];
  };
  expect(
    body.tasks
      .filter((task) => task.source === "chat")
      .map((task) => task.open),
  ).toEqual([{ kind: "wakerflow", id: f.flow.id }]);
  expect(body.tasks.filter((task) => task.source === "group_run")).toHaveLength(
    3,
  );
  for (const task of body.tasks.filter((task) => task.source === "group_run"))
    expect(task.open).toEqual({
      kind: "wakerflow",
      id: f.flow.id,
      runId: started.runId,
    });
});

test("missing Flow inputs are a 400 before any run identity, task card or step can be admitted", async () => {
  const f = await fixture();
  await f.store.save(f.tenantId, f.flow.id, { revision: 0, plan: f.plan });
  const routes = createWakerFlowRoutes(
    f.store,
    f.pipeline,
    async (context, next) => {
      context.set("actor", {
        id: f.tenantId,
        role: "user",
        email: `${f.tenantId}@example.test`,
      });
      await next();
    },
  );
  const response = await routes.request(`/${f.flow.id}/runs`, {
    method: "POST",
    body: JSON.stringify({ requestId: randomUUID(), revision: 1, inputs: {} }),
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "请填写 会议内容。" });
  await runAsTenant(f.tenantId, async () => {
    expect(
      await database.select().from(tasks).where(eq(tasks.tenantId, f.tenantId)),
    ).toHaveLength(0);
    expect(
      await database
        .select()
        .from(wakerFlowRequests)
        .where(eq(wakerFlowRequests.tenantId, f.tenantId)),
    ).toHaveLength(1);
  });
  expect(f.invoked).toHaveLength(0);
});

afterAll(async () => {
  for (const tenantId of tenants)
    await runAsTenant(tenantId, async () => {
      await database
        .delete(wakerFlowRequests)
        .where(eq(wakerFlowRequests.tenantId, tenantId));
      await database
        .delete(wakerFlows)
        .where(eq(wakerFlows.tenantId, tenantId));
      await database.delete(tasks).where(eq(tasks.tenantId, tenantId));
      await database
        .delete(groupTaskRuns)
        .where(eq(groupTaskRuns.tenantId, tenantId));
      await database
        .delete(groupTaskTemplates)
        .where(eq(groupTaskTemplates.tenantId, tenantId));
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
  await database.$client.close();
});

test("client-selected draft UUID survives a lost ACK without replacement or resurrection", async () => {
  const f = await fixture();
  const draftId = randomUUID();
  const first = await f.store.create(f.tenantId, { draftId, idea: "持久草稿" });
  const repeated = await f.store.create(f.tenantId, { draftId, idea: "持久草稿" });
  expect(first.id).toBe(draftId);
  expect(repeated.id).toBe(draftId);
  expect((await f.store.inspect(f.tenantId, draftId))?.idea).toBe("持久草稿");
  await expect(f.store.create("foreign-owner", { draftId, idea: "持久草稿" })).rejects.toThrow("这里没有");
  await expect(f.store.create(f.tenantId, { draftId, idea: "不同内容" })).rejects.toThrow("已有不同内容");
  await f.store.remove(f.tenantId, draftId, 0);
  await expect(f.store.create(f.tenantId, { draftId, idea: "持久草稿" })).rejects.toThrow("这里没有");
  expect(await f.store.inspect(f.tenantId, draftId)).toBeNull();
  expect(f.generations()).toBe(0);
});

test("generation actor fence refuses changed-cookie intent before draft claim or model work", async () => {
  const f = await fixture();
  const routes = createWakerFlowRoutes(f.store, f.pipeline, async (context, next) => {
    context.set("actor", { id: f.tenantId, email: "synthetic-wf@example.test", role: "user" });
    await next();
  });
  const draftId = randomUUID();
  const refusedDraft = await routes.request("/", {
    method: "POST",
    body: JSON.stringify({ draftId, idea: "拒绝旧身份", expectedActorId: "other-person" }),
  });
  expect(refusedDraft.status).toBe(409);
  expect((await refusedDraft.json()).code).toBe("flow_actor_changed");
  expect(await f.store.inspect(f.tenantId, draftId)).toBeNull();
  const refusedGeneration = await routes.request("/" + f.flow.id + "/generate", {
    method: "POST",
    body: JSON.stringify({ ...f.input, expectedActorId: "other-person" }),
  });
  expect(refusedGeneration.status).toBe(409);
  expect((await refusedGeneration.json()).precommit).toBe(true);
  expect(f.generations()).toBe(0);
  await runAsTenant(f.tenantId, async () => {
    expect(await database.select().from(wakerFlowRequests).where(eq(wakerFlowRequests.tenantId, f.tenantId))).toHaveLength(0);
    expect(await database.select().from(tasks).where(eq(tasks.tenantId, f.tenantId))).toHaveLength(0);
  });
  const accepted = await routes.request("/" + f.flow.id + "/generate", {
    method: "POST",
    body: JSON.stringify({ ...f.input, expectedActorId: f.tenantId, expectedRevision: 0 }),
  });
  expect(accepted.status).toBe(200);
  const receipt = (await accepted.json()).request;
  expect(receipt).toMatchObject({ flowId: f.flow.id, requestId: f.input.requestId, kind: "plan", status: "completed" });
  const inspected = await routes.request("/" + f.flow.id + "/requests/" + f.input.requestId);
  expect((await inspected.json()).request.id).toBe(receipt.id);
  expect(f.generations()).toBe(1);
});

test("a definition committed during generation preflight refuses before claim, card and provider", async () => {
  const f = await fixture();
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  const store = createWakerFlowStore({
    ...f.options,
    preflight: async () => { enter(); await released; },
  });
  const pending = store.generate(f.tenantId, f.flow.id, { ...f.input, expectedRevision: 0 })
    .then((value) => ({ value, error: null }), (error: unknown) => ({ value: null, error }));
  try {
    await entered;
    const saved = await f.store.save(f.tenantId, f.flow.id, { revision: 0, plan: f.plan });
    expect(saved.revision).toBe(1);
    // The concurrent save legitimately commits its version history while generation is held.
    // That receipt is the baseline, never evidence that this rejected generation was admitted.
    const baselineRequests = await runAsTenant(f.tenantId, () =>
      database.select().from(wakerFlowRequests).where(eq(wakerFlowRequests.tenantId, f.tenantId)),
    );
    expect(baselineRequests.map(({ flowId, kind, status, result }) => ({
      flowId, kind, status, result,
    }))).toEqual([{
      flowId: f.flow.id,
      kind: "version",
      status: "completed",
      result: expect.objectContaining({ revision: saved.revision }),
    }]);
    const baselineRequestIds = new Set(baselineRequests.map((row) => row.id));
    release();
    const result = await pending;
    expect(result.value).toBeNull();
    expect(result.error).toMatchObject({ code: "flow_revision_changed", precommit: true });
    expect(f.generations()).toBe(0);
    await runAsTenant(f.tenantId, async () => {
      const currentRequests = await database.select().from(wakerFlowRequests)
        .where(eq(wakerFlowRequests.tenantId, f.tenantId));
      expect(currentRequests.filter((row) => !baselineRequestIds.has(row.id))).toHaveLength(0);
      expect([...currentRequests].sort((a, b) => a.id.localeCompare(b.id))).toEqual(
        [...baselineRequests].sort((a, b) => a.id.localeCompare(b.id)),
      );
      expect(currentRequests.filter((row) => row.kind === "plan")).toHaveLength(0);
      expect(currentRequests.filter((row) => row.requestId === f.input.requestId)).toHaveLength(0);
      expect(await database.select().from(tasks).where(eq(tasks.tenantId, f.tenantId))).toHaveLength(0);
    });
  } finally {
    release();
    await pending;
  }
});

test("an accepted unknown generation is inspected without replay and a distinct confirmed identity remains legal", async () => {
  const f = await fixture();
  let providerCalls = 0;
  const store = createWakerFlowStore({
    ...f.options,
    generate: async () => { providerCalls++; throw Error("synthetic transport accepted then lost"); },
  });
  const first = await store.generate(f.tenantId, f.flow.id, { ...f.input, expectedRevision: 0 });
  expect(first.status).toBe("unknown");
  expect((await store.request(f.tenantId, f.flow.id, f.input.requestId))?.id).toBe(first.id);
  expect(providerCalls).toBe(1);
  const duplicate = await store.generate(f.tenantId, f.flow.id, { ...f.input, expectedRevision: 0 });
  expect(duplicate.id).toBe(first.id);
  expect(providerCalls).toBe(1);
  const nextRequest = randomUUID();
  const next = await store.generate(f.tenantId, f.flow.id, { ...f.input, requestId: nextRequest, expectedRevision: 0 });
  expect(next.id).not.toBe(first.id);
  expect(providerCalls).toBe(2);
  expect((await store.request(f.tenantId, f.flow.id, f.input.requestId))?.status).toBe("unknown");
  expect(await store.request("foreign", f.flow.id, f.input.requestId).catch(() => null)).toBeNull();
});


test("matching generation receipt survives later definition changes without recharging", async () => {
  const f = await fixture();
  const input = { ...f.input, expectedRevision: 0 };
  const first = await f.store.generate(f.tenantId, f.flow.id, input);
  await f.store.save(f.tenantId, f.flow.id, { revision: 0, plan: f.plan });
  const repeated = await f.store.generate(f.tenantId, f.flow.id, input);
  expect(repeated.id).toBe(first.id);
  expect(f.generations()).toBe(1);
  await expect(f.store.generate(f.tenantId, f.flow.id, { ...input, idea: "another paid intent" })).rejects.toThrow("另一项操作");
  expect(f.generations()).toBe(1);
});
