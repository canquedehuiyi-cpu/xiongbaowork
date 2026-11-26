import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { LLMock } from "@copilotkit/aimock";
import { SQL } from "bun";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { buildAgents } from "../src/copilot";
import { createDatabase } from "../src/db/client";
import {
  modelRegistry,
  modelTokenCalls,
  providerTemplates,
  threadContextBreakdowns,
} from "../src/db/schema";
import { templateVendors } from "../src/model-catalogue";
import { DEPLOYMENT_MODEL_REF } from "../src/models/runtime-resolver";
import {
  buildModelTokenCallRow,
  type MeteredBinding,
  sha256Hex,
} from "../src/models/token-metering";
import { runAsTenant } from "../src/tenant/context";
import {
  contextBreakdownRecorder,
  readContextUsage,
} from "../src/threads/context-usage";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * 对话侧栏「上下文」读写真库：运行开始时写分类比例，读的时候按最近一次调用的真实用量和那次调用的模型
 * 算上限。每个用例用自己的租户。
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = `ctxu-${randomUUID().slice(0, 8)}`;
const people: string[] = [];
const poolIds: string[] = [];

/** platform_model_pool 应用角色只读，运维用库主人写；同 platform-model-pool 测试的做法。 */
function ownerConnection(): SQL {
  const raw = process.env.TEST_DATABASE_ADMIN_URL?.trim();
  if (!raw)
    throw new Error("TEST_DATABASE_ADMIN_URL must name the database owner.");
  const adminUrl = new URL(raw);
  const target = new URL(testDatabaseUrl());
  return new SQL({
    adapter: "postgres",
    hostname: adminUrl.hostname,
    port: adminUrl.port ? Number(adminUrl.port) : 5432,
    username: decodeURIComponent(adminUrl.username),
    password: decodeURIComponent(adminUrl.password),
    database: decodeURIComponent(target.pathname.replace(/^\//, "")),
    max: 1,
  });
}
const admin = ownerConnection();

afterAll(async () => {
  if (people.length > 0)
    await runAsTenant("platform", async () => {
      await database
        .delete(threadContextBreakdowns)
        .where(inArray(threadContextBreakdowns.tenantId, people));
      await database
        .delete(modelRegistry)
        .where(inArray(modelRegistry.tenantId, people));
    });
  for (const person of people)
    await runAsTenant(person, () =>
      database
        .delete(modelTokenCalls)
        .where(inArray(modelTokenCalls.tenantId, [person])),
    );
  for (const id of poolIds)
    await admin`delete from platform_model_pool where id = ${id}`;
  await admin.close();
  await database.$client.close();
});

function person(): string {
  const id = `${suite}-user-${randomUUID()}`;
  people.push(id);
  return id;
}

async function registryRow(
  tenantId: string,
  modelName: string,
  contextWindow: number | null,
): Promise<string> {
  const [row] = await runAsTenant(tenantId, () =>
    database
      .insert(modelRegistry)
      .values({ tenantId, provider: "openai", modelName, contextWindow })
      .returning({ id: modelRegistry.id }),
  );
  return row?.id as string;
}

let clock = Date.parse("2026-11-15T08:00:00Z");

/** 一次已结束的调用，像计量那样建行；`startedAt` 依次往后，后写的就是“最近一次”。 */
async function call(options: {
  tenantId: string;
  threadId: string;
  agentId: string;
  modelRef: string;
  credentialId?: string;
  provider?: string;
  modelName: string;
  usage: unknown;
  outcome?: "completed" | "stopped" | "unknown";
}): Promise<void> {
  const binding: MeteredBinding = {
    tenantId: options.tenantId,
    agentId: options.agentId,
    modelRef: options.modelRef,
    provider: options.provider ?? "openai",
    modelName: options.modelName,
    credentialId: options.credentialId ?? randomUUID(),
    credentialDigest: sha256Hex("credential"),
    originalModelFingerprint: sha256Hex("fingerprint"),
    originalText: `${options.provider ?? "openai"}/${options.modelName}`,
  };
  clock += 60_000;
  const row = buildModelTokenCallRow({
    binding,
    scope: { runId: `run-${randomUUID()}`, threadId: options.threadId },
    callId: randomUUID(),
    sdkProvider: binding.provider,
    sdkModelId: binding.modelName,
    startedAt: new Date(clock),
    observedAt: new Date(clock + 1_000),
    outcome: options.outcome ?? "completed",
    usage: options.usage,
  });
  await runAsTenant(options.tenantId, () =>
    database.insert(modelTokenCalls).values(row),
  );
}

const reported = (input: number) => ({ inputTokens: input, outputTokens: 10 });
const noCatalogue = async () => undefined;

describe("context usage", () => {
  test("limit follows the model of the latest call, not the current configuration", async () => {
    const tenantId = person();
    const threadId = `thread-${randomUUID()}`;
    const agentId = "agent-switched";
    // 员工先绑大窗口模型，后来改成小窗口模型；再往后一次调用被停掉、没报用量。
    const big = await registryRow(tenantId, `big-${randomUUID()}`, 200_000);
    const small = await registryRow(tenantId, `small-${randomUUID()}`, 64_000);
    await call({
      tenantId,
      threadId,
      agentId,
      modelRef: big,
      modelName: "big-model",
      usage: reported(90_000),
    });
    await call({
      tenantId,
      threadId,
      agentId,
      modelRef: small,
      modelName: "small-model",
      usage: reported(12_000),
    });
    await call({
      tenantId,
      threadId,
      agentId,
      modelRef: big,
      modelName: "big-model",
      usage: undefined,
      outcome: "stopped",
    });
    const usage = await readContextUsage(tenantId, threadId, agentId, {
      database,
      contextWindowFor: noCatalogue,
    });
    expect(usage.used).toBe(12_000);
    expect(usage.limit).toBe(64_000);
    expect(usage.lastModel).toEqual({
      provider: "openai",
      name: "small-model",
    });
    expect(usage.percent).toBe(18.8);
  });

  test("a pool call reads the pool row, a deployment call asks the catalogue", async () => {
    const tenantId = person();
    const agentId = "agent-pool";
    const poolId = randomUUID();
    poolIds.push(poolId);
    await admin`insert into platform_model_pool (id, provider, model_name, label, api_key_env, context_window)
                values (${poolId}, ${`p-${suite}`}, ${`m-${randomUUID()}`}, 'pool', 'XIONGBAO_POOL_CTXU_TEST', 96000)`;
    const poolThread = `thread-${randomUUID()}`;
    // 平台模型池的调用把池行 id 同时记作 model_ref 和 credential_id（runtime-resolver 的 poolModel）。
    await call({
      tenantId,
      threadId: poolThread,
      agentId,
      modelRef: poolId,
      credentialId: poolId,
      provider: "deepseek",
      modelName: "deepseek-chat",
      usage: reported(48_000),
    });
    const asked: string[] = [];
    const contextWindowFor = async (provider: string, modelName: string) => {
      asked.push(`${provider}/${modelName}`);
      return 128_000;
    };
    const pooled = await readContextUsage(tenantId, poolThread, agentId, {
      database,
      contextWindowFor,
    });
    expect(pooled.limit).toBe(96_000);
    expect(asked).toEqual([]);

    const defaultThread = `thread-${randomUUID()}`;
    await call({
      tenantId,
      threadId: defaultThread,
      agentId,
      modelRef: DEPLOYMENT_MODEL_REF,
      credentialId: DEPLOYMENT_MODEL_REF,
      provider: "anthropic",
      modelName: "claude-x",
      usage: {
        // AI SDK v3：total 已含缓存读写（1 000 + 3 000 + 500），已用就是它，不再另加。
        inputTokens: { total: 4_500, cacheRead: 3_000, cacheWrite: 500 },
        outputTokens: { total: 10 },
      },
    });
    const deployed = await readContextUsage(tenantId, defaultThread, agentId, {
      database,
      contextWindowFor,
    });
    expect(asked).toEqual(["anthropic/claude-x"]);
    expect(deployed.limit).toBe(128_000);
    expect(deployed.used).toBe(4_500);
  });

  test("categories come from the latest breakdown of this agent; nothing yet reads as unknown", async () => {
    const tenantId = person();
    const threadId = `thread-${randomUUID()}`;
    const ref = await registryRow(tenantId, `m-${randomUUID()}`, 100_000);
    const deps = { database, contextWindowFor: noCatalogue };

    const empty = await readContextUsage(tenantId, threadId, "agent-a", deps);
    expect(empty).toEqual({
      used: null,
      limit: null,
      percent: null,
      categories: [],
      untilAutoCompact: null,
      lastModel: null,
    });

    await call({
      tenantId,
      threadId,
      agentId: "agent-a",
      modelRef: ref,
      modelName: "m",
      usage: reported(40_000),
    });
    const shares = (messages: number) => ({
      messages,
      system: 1 - messages,
      tools: 0,
      skills: 0,
      memory: 0,
    });
    await runAsTenant(tenantId, async () => {
      await database.insert(threadContextBreakdowns).values({
        tenantId,
        threadId,
        agentId: "agent-a",
        runId: "run-old",
        shares: shares(0.5),
        createdAt: new Date("2026-11-15T08:00:00Z"),
      });
      await database.insert(threadContextBreakdowns).values({
        tenantId,
        threadId,
        agentId: "agent-a",
        runId: "run-new",
        shares: shares(0.75),
        createdAt: new Date("2026-11-15T09:00:00Z"),
      });
      // 另一位员工的比例不算到 agent-a 头上。
      await database.insert(threadContextBreakdowns).values({
        tenantId,
        threadId,
        agentId: "agent-b",
        runId: "run-b",
        shares: shares(0),
        createdAt: new Date("2026-11-15T10:00:00Z"),
      });
    });
    const usage = await readContextUsage(tenantId, threadId, "agent-a", deps);
    expect(usage.categories).toEqual([
      { key: "messages", tokens: 30_000 },
      { key: "system", tokens: 10_000 },
      { key: "tools", tokens: 0 },
      { key: "skills", tokens: 0 },
      { key: "memory", tokens: 0 },
      { key: "reserve", tokens: 10_000 },
      { key: "free", tokens: 50_000 },
    ]);
    expect(usage.untilAutoCompact).toBe(50_000);
    // 另一个人读不到这条线程的任何东西。
    const stranger = person();
    expect(
      (await readContextUsage(stranger, threadId, "agent-a", deps)).used,
    ).toBeNull();
  });

  test("every provider template in the model library names a models.dev vendor", async () => {
    const templates = await runAsTenant("platform", () =>
      database.select({ id: providerTemplates.id }).from(providerTemplates),
    );
    expect(templates.length).toBeGreaterThan(0);
    for (const { id } of templates)
      if (id !== "custom")
        expect({ id, vendors: templateVendors(id).length > 0 }).toEqual({
          id,
          vendors: true,
        });
  });
});

describe("provider templates", () => {
  test("the AIHUB relay is seeded as an OpenAI-compatible provider that takes its own base URL", async () => {
    const [aihub] = await runAsTenant("platform", () =>
      database
        .select()
        .from(providerTemplates)
        .where(eq(providerTemplates.id, "aihub")),
    );
    expect(aihub).toMatchObject({
      label: "AIHUB 中转 (OpenAI 兼容)",
      allowsBaseUrl: true,
      probe: "chat-completions",
    });
  });
});

describe("context breakdown", () => {
  test("a built-in run writes one breakdown row whose shares sum to 1", async () => {
    const tenantId = person();
    const reviewer = {
      id: "reviewer",
      name: "Reviewer",
      type: "built_in" as const,
      systemPrompt: "Review the code.",
    };
    const recorder = new LLMock();
    const originalBase = process.env.OPENAI_BASE_URL;
    const threadId = `thread-${randomUUID()}`;
    const runId = `run-${randomUUID()}`;
    try {
      process.env.OPENAI_BASE_URL = await recorder.start();
      recorder.onMessage(/.*/, { content: "CTXU001 fixture completed." });
      const agents = await runAsTenant(tenantId, () =>
        buildAgents(
          [reviewer],
          { provider: "openai", defaultModel: "gpt-5.6-terra" },
          "synthetic-deployment-key",
          undefined,
          async () => [
            {
              name: "lookup_ticket",
              ref: "fixture/lookup_ticket",
              description: "Look up a ticket by its number.",
              parameters: z.object({ number: z.string() }),
              execute: async () => "ticket",
            },
          ],
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          async () => "The person prefers short answers in Chinese.",
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          contextBreakdownRecorder(database, tenantId),
        ),
      );
      const built = agents[reviewer.id]?.clone();
      if (!built) throw new Error("buildAgents returned no reviewer");
      built.threadId = threadId;
      built.addMessage({
        id: "ctxu-request",
        role: "user",
        content: "Please review the fixture change.",
      });
      await runAsTenant(tenantId, () => built.runAgent({ runId }));
    } finally {
      if (originalBase === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = originalBase;
      await recorder.stop();
    }

    const read = () =>
      runAsTenant(tenantId, () =>
        database
          .select()
          .from(threadContextBreakdowns)
          .where(inArray(threadContextBreakdowns.threadId, [threadId])),
      );
    let rows = await read();
    for (let i = 0; i < 50 && rows.length === 0; i++) {
      await Bun.sleep(20);
      rows = await read();
    }
    // 给可能的第二次写入一点时间，确认一次运行只有一行。
    await Bun.sleep(100);
    rows = await read();
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row).toMatchObject({
      tenantId,
      threadId,
      agentId: reviewer.id,
      runId,
    });
    const shares = row?.shares as Record<string, number>;
    const sum = Object.values(shares).reduce((acc, value) => acc + value, 0);
    expect(sum).toBeCloseTo(1, 9);
    expect(shares.system).toBeGreaterThan(0);
    expect(shares.messages).toBeGreaterThan(0);
    expect(shares.tools).toBeGreaterThan(0);
    expect(shares.memory).toBeGreaterThan(0);
    expect(shares.skills).toBe(0);
  });
});
