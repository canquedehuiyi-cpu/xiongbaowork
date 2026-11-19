import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { AGENT_MODEL_ROUTE } from "../src/agents/model-proxy/proxy";
import { createAgentModelService } from "../src/agents/model-proxy/wiring";
import { createCredentialStore, encryptSecret } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  credentials,
  modelRegistry,
  modelTokenCalls,
  usageCounters,
  users,
} from "../src/db/schema";
import {
  databaseTokenCallSink,
  type ModelTokenCallRow,
} from "../src/models/token-metering";
import { billingPeriod, createQuotaService } from "../src/quota/limits";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * 外部员工的模型代理，数据库这一侧是真的：员工和它的模型绑定、凭据库里的真实 key、`acp.open` 签发的令牌、
 * 用量真的写进 model_token_calls、额度读的是真实的套餐和计数、员工删除后令牌作废。上游是假的（注入 fetch）。
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const encryptionKey = Buffer.alloc(32, 7).toString("base64");
const credentialStore = createCredentialStore(database);
const marker = randomUUID().replaceAll("-", "").slice(0, 10);
const tenantA = `amp-${marker}-a`;
const tenantB = `amp-${marker}-b`;
const LIVE_KEY = `sk-live-${marker}`;
const BASE = "https://xiongbao.test/api/agent-model";
const THREAD = `thread-${marker}`;

type Seen = { url: string; headers: Headers; body: Record<string, unknown> };
const seen: Seen[] = [];
const written: Promise<void>[] = [];
const databaseSink = databaseTokenCallSink(database);
const sink = async (row: ModelTokenCallRow) => {
  const write = databaseSink(row);
  written.push(write);
  await write;
};

const service = createAgentModelService({
  database,
  credentials: credentialStore,
  encryptionKey,
  sink,
  quota: createQuotaService(database),
  outbound: {
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    viaProxy: () => false,
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      return Response.json({
        id: "r1",
        usage: { input_tokens: 21, output_tokens: 9, total_tokens: 30 },
      });
    }) as typeof fetch,
  },
  config: { enabled: true, baseUrl: BASE, perMinute: undefined },
  environment: {},
});

async function person(id: string) {
  await runAsTenant(id, () =>
    database
      .insert(users)
      .values({ id, email: `${id}@example.test`, name: "Proxy Test" }),
  );
}

/** A model in the person's library with a live key in the vault. */
async function connect(tenant: string, provider: string, modelName: string) {
  return runAsTenant(tenant, async () => {
    const credential = await credentialStore.create({
      kind: "model",
      provider,
      keyId: `${tenant}-${modelName}`,
      encryptedValue: await encryptSecret(encryptionKey, LIVE_KEY),
      metadata: {},
    });
    const [row] = await database
      .insert(modelRegistry)
      .values({ provider, modelName, credentialId: credential.id })
      .returning({ id: modelRegistry.id });
    return { modelRef: row?.id as string, credentialId: credential.id };
  });
}

async function employee(
  tenant: string,
  name: string,
  options: { modelRef?: string | null; type?: "device_acp" | "built_in" } = {},
) {
  const id = `amp-${marker}-${name}`;
  const type = options.type ?? "device_acp";
  await runAsTenant(tenant, async () => {
    await database.insert(agents).values({
      id,
      name: id,
      type,
      configuration:
        type === "device_acp"
          ? {
              deviceId: `laptop-${marker}`,
              harness: "codex",
              workdirRef: `fld_${marker}`,
              permissions: {},
            }
          : { systemPrompt: "test" },
    });
    await database.insert(agentProfiles).values({
      agentId: id,
      ownerUserId: tenant,
      title: id,
      roleDescription: "模型代理测试员工",
      avatarSeed: marker,
      visibility: "private",
      modelRef: options.modelRef ?? null,
    });
  });
  return id;
}

async function call(
  claims: { tenantId: string; agentId: string },
  wire: "responses" | "messages" = "responses",
) {
  const { token } = service.tokens.issue({ ...claims, threadId: THREAD });
  return service.proxy.forward(
    new Request(`http://xiongbao.test${AGENT_MODEL_ROUTE}/v1/${wire}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "whatever", input: "hi" }),
    }),
    wire,
  );
}

const callsOf = (tenant: string, agentId: string) =>
  runAsTenant(tenant, () =>
    database
      .select()
      .from(modelTokenCalls)
      .where(eq(modelTokenCalls.agentId, agentId)),
  );

const ids = { codex: "", bare: "", builtIn: "", foreign: "" };
let library = { modelRef: "", credentialId: "" };

afterAll(async () => {
  for (const tenant of [tenantA, tenantB]) {
    await runAsTenant(tenant, async () => {
      await database
        .delete(modelTokenCalls)
        .where(eq(modelTokenCalls.tenantId, tenant));
      await database
        .delete(usageCounters)
        .where(eq(usageCounters.tenantId, tenant));
    });
  }
  await runAsTenant("platform", async () => {
    const mine = Object.values(ids).filter(Boolean);
    if (mine.length) {
      await database
        .delete(agentProfiles)
        .where(inArray(agentProfiles.agentId, mine));
      await database.delete(agents).where(inArray(agents.id, mine));
    }
    await database
      .delete(modelRegistry)
      .where(inArray(modelRegistry.tenantId, [tenantA, tenantB]));
    await database
      .delete(credentials)
      .where(inArray(credentials.tenantId, [tenantA, tenantB]));
    await database.delete(users).where(inArray(users.id, [tenantA, tenantB]));
  });
  await database.$client.end();
});

describe("the model proxy against the real tables", () => {
  test("setup", async () => {
    await person(tenantA);
    await person(tenantB);
    library = await connect(tenantA, "deepseek", "deepseek-chat");
    ids.codex = await employee(tenantA, "codex", {
      modelRef: library.modelRef,
    });
    ids.bare = await employee(tenantA, "bare");
    ids.builtIn = await employee(tenantA, "builtin", {
      type: "built_in",
      modelRef: library.modelRef,
    });
    ids.foreign = await employee(tenantB, "foreign");
    expect(ids.codex).not.toBe("");
  });

  test("acp.open hands an employee with a model a pass that is bound to it; one without gets none", async () => {
    const block = await service.access.issue({
      tenantId: tenantA,
      agentId: ids.codex,
      threadId: THREAD,
      harness: "codex",
    });
    expect(block).toMatchObject({
      baseUrl: BASE,
      model: "deepseek-chat",
      wire: "responses",
    });
    expect(service.tokens.verify(block?.token)).toMatchObject({
      tenantId: tenantA,
      agentId: ids.codex,
      threadId: THREAD,
    });
    // What goes to the device is the pass, never the key.
    expect(JSON.stringify(block)).not.toContain(LIVE_KEY);
    expect(
      await service.access.issue({
        tenantId: tenantA,
        agentId: ids.bare,
        threadId: THREAD,
        harness: "codex",
      }),
    ).toBeNull();
  });

  test("a call goes out on the vault's key and the employee's model, and its usage lands in model_token_calls", async () => {
    const response = await call({ tenantId: tenantA, agentId: ids.codex });
    expect(response.status).toBe(200);
    await response.text();
    await Promise.all(written);
    const last = seen.at(-1);
    expect(last?.url).toBe("https://api.deepseek.com/responses");
    expect(last?.headers.get("authorization")).toBe(`Bearer ${LIVE_KEY}`);
    expect(last?.body.model).toBe("deepseek-chat");
    const rows = await callsOf(tenantA, ids.codex);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenantId: tenantA,
      threadId: THREAD,
      provider: "deepseek",
      modelName: "deepseek-chat",
      modelRef: library.modelRef,
      credentialId: library.credentialId,
      outcome: "completed",
      usageStatus: "reported",
      inputTokens: 21,
      outputTokens: 9,
      totalTokens: 30,
    });
    expect(JSON.stringify(rows)).not.toContain(LIVE_KEY);
  });

  test("another tenant's employee, and an employee that is not an external one, are refused", async () => {
    const before = seen.length;
    // Tenant B's pass naming tenant A's employee, and tenant A's naming tenant B's.
    expect((await call({ tenantId: tenantB, agentId: ids.codex })).status).toBe(
      403,
    );
    expect(
      (await call({ tenantId: tenantA, agentId: ids.foreign })).status,
    ).toBe(403);
    // A built-in coworker of the same tenant is bound to a model too, and is still not this door's.
    expect(
      (await call({ tenantId: tenantA, agentId: ids.builtIn })).status,
    ).toBe(403);
    expect(seen.length).toBe(before);
  });

  test("a tenant over its monthly allowance is 429", async () => {
    await runAsTenant(tenantA, () =>
      database.insert(usageCounters).values({
        tenantId: tenantA,
        period: billingPeriod(),
        metric: "tasks",
        value: 51,
      }),
    );
    const before = seen.length;
    const response = await call({ tenantId: tenantA, agentId: ids.codex });
    expect(response.status).toBe(429);
    expect(JSON.stringify(await response.json())).toContain(
      "本月任务额度已用完",
    );
    expect(seen.length).toBe(before);
    await runAsTenant(tenantA, () =>
      database.delete(usageCounters).where(eq(usageCounters.tenantId, tenantA)),
    );
    expect((await call({ tenantId: tenantA, agentId: ids.codex })).status).toBe(
      200,
    );
  });

  test("a model whose key was withdrawn is refused with a sentence, not forwarded", async () => {
    await runAsTenant(tenantA, () =>
      database
        .update(credentials)
        .set({ revokedAt: new Date() })
        .where(eq(credentials.id, library.credentialId)),
    );
    const before = seen.length;
    const response = await call({ tenantId: tenantA, agentId: ids.codex });
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toContain("还没有可用的模型");
    expect(seen.length).toBe(before);
    await runAsTenant(tenantA, () =>
      database
        .update(credentials)
        .set({ revokedAt: null })
        .where(eq(credentials.id, library.credentialId)),
    );
  });

  test("deleting the employee takes its pass away at once", async () => {
    const { token } = service.tokens.issue({
      tenantId: tenantA,
      agentId: ids.codex,
      threadId: THREAD,
    });
    const ask = () =>
      service.proxy.forward(
        new Request(`http://xiongbao.test${AGENT_MODEL_ROUTE}/v1/responses`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ input: "hi" }),
        }),
        "responses",
      );
    expect((await ask()).status).toBe(200);
    await runAsTenant(tenantA, () =>
      database
        .update(agentProfiles)
        .set({ deletedAt: new Date() })
        .where(eq(agentProfiles.agentId, ids.codex)),
    );
    const before = seen.length;
    expect((await ask()).status).toBe(403);
    expect(seen.length).toBe(before);
  });
});
