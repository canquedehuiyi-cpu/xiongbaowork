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
  users,
} from "../src/db/schema";
import {
  DEPLOYMENT_MODEL_REF,
  type DeploymentModel,
} from "../src/models/runtime-resolver";
import {
  databaseTokenCallSink,
  type ModelTokenCallRow,
} from "../src/models/token-metering";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * 外部员工没有自己的模型时，用租户内置员工默认的那个模型（规格 §8.3）：`acp.open` 照样带 `model` 块，代理按
 * 默认模型转发、用部署的 key、计量记在这个人名下；有绑定就用绑定；默认模型也解析不到时还是原来那句中文。
 * 数据库这一侧是真的，上游是假的（注入 fetch）。
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const encryptionKey = Buffer.alloc(32, 7).toString("base64");
const credentialStore = createCredentialStore(database);
const marker = randomUUID().replaceAll("-", "").slice(0, 10);
const tenant = `amd-${marker}`;
const DEPLOY_KEY = `sk-deploy-${marker}`;
const OWN_KEY = `sk-own-${marker}`;
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

/** The deployment default model: DeepSeek behind an OpenAI-shaped endpoint, as a deployment sets it up. */
let deployment: DeploymentModel | undefined = {
  model: {} as never,
  provider: "openai",
  modelName: "deepseek-chat",
  baseUrl: "https://api.deepseek.com/v1",
  apiKey: DEPLOY_KEY,
};

const service = createAgentModelService({
  database,
  credentials: credentialStore,
  encryptionKey,
  sink,
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
        usage: { input_tokens: 11, output_tokens: 4, total_tokens: 15 },
      });
    }) as typeof fetch,
  },
  config: { enabled: true, baseUrl: BASE, perMinute: undefined },
  environment: {},
  deployment: async () => deployment,
});

const ids = { bare: "", bound: "" };
let library = { modelRef: "", credentialId: "" };

async function employee(name: string, modelRef: string | null) {
  const id = `amd-${marker}-${name}`;
  await runAsTenant(tenant, async () => {
    await database.insert(agents).values({
      id,
      name: id,
      type: "device_acp",
      configuration: {
        deviceId: `cloud:${id}`,
        harness: "claude-code",
        workdirRef: "cloud:workspace",
        runtime: "cloud",
        permissions: {},
      },
    });
    await database.insert(agentProfiles).values({
      agentId: id,
      ownerUserId: tenant,
      title: id,
      roleDescription: "默认模型测试员工",
      avatarSeed: marker,
      visibility: "private",
      modelRef,
    });
  });
  return id;
}

const open = (agentId: string) =>
  service.access.issue({
    tenantId: tenant,
    agentId,
    threadId: THREAD,
    harness: "claude-code",
    runtime: "cloud",
  });

async function call(agentId: string) {
  const { token } = service.tokens.issue({
    tenantId: tenant,
    agentId,
    threadId: THREAD,
  });
  return service.proxy.forward(
    new Request(`http://xiongbao.test${AGENT_MODEL_ROUTE}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "whatever", max_tokens: 8, messages: [] }),
    }),
    "messages",
  );
}

const callsOf = (agentId: string) =>
  runAsTenant(tenant, () =>
    database
      .select()
      .from(modelTokenCalls)
      .where(eq(modelTokenCalls.agentId, agentId)),
  );

afterAll(async () => {
  await runAsTenant(tenant, async () => {
    await database
      .delete(modelTokenCalls)
      .where(eq(modelTokenCalls.tenantId, tenant));
  });
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
      .where(eq(modelRegistry.tenantId, tenant));
    await database.delete(credentials).where(eq(credentials.tenantId, tenant));
    await database.delete(users).where(eq(users.id, tenant));
  });
  await database.$client.end();
});

describe("an external employee with no model of its own speaks the deployment default", () => {
  test("setup", async () => {
    await runAsTenant(tenant, () =>
      database.insert(users).values({
        id: tenant,
        email: `${tenant}@example.test`,
        name: "Default",
      }),
    );
    library = await runAsTenant(tenant, async () => {
      const credential = await credentialStore.create({
        kind: "model",
        provider: "anthropic",
        keyId: `${tenant}-own`,
        encryptedValue: await encryptSecret(encryptionKey, OWN_KEY),
        metadata: {},
      });
      const [row] = await database
        .insert(modelRegistry)
        .values({
          provider: "anthropic",
          modelName: "claude-own",
          credentialId: credential.id,
        })
        .returning({ id: modelRegistry.id });
      return { modelRef: row?.id as string, credentialId: credential.id };
    });
    ids.bare = await employee("bare", null);
    ids.bound = await employee("bound", library.modelRef);
    expect(ids.bare).not.toBe("");
  });

  test("a cloud Claude Code with no binding gets a `model` block for the default model, never the key", async () => {
    const block = await open(ids.bare);
    expect(block).toMatchObject({
      baseUrl: BASE,
      model: "deepseek-chat",
      wire: "messages",
    });
    expect(service.tokens.verify(block?.token)).toMatchObject({
      tenantId: tenant,
      agentId: ids.bare,
    });
    expect(JSON.stringify(block)).not.toContain(DEPLOY_KEY);
  });

  test("the proxy forwards it on the default model and the deployment's key, metered to the person", async () => {
    const response = await call(ids.bare);
    expect(response.status).toBe(200);
    await response.text();
    await Promise.all(written);
    const last = seen.at(-1);
    expect(last?.url).toBe("https://api.deepseek.com/anthropic/v1/messages");
    expect(last?.headers.get("authorization")).toBe(`Bearer ${DEPLOY_KEY}`);
    expect(last?.body.model).toBe("deepseek-chat");
    const rows = await callsOf(ids.bare);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenantId: tenant,
      threadId: THREAD,
      provider: "openai",
      modelName: "deepseek-chat",
      modelRef: DEPLOYMENT_MODEL_REF,
      outcome: "completed",
      usageStatus: "reported",
    });
    expect(JSON.stringify(rows)).not.toContain(DEPLOY_KEY);
  });

  test("an employee with a binding still uses it, not the default", async () => {
    const block = await open(ids.bound);
    expect(block).toMatchObject({ model: "claude-own", wire: "messages" });
    const response = await call(ids.bound);
    expect(response.status).toBe(200);
    await response.text();
    await Promise.all(written);
    const last = seen.at(-1);
    expect(last?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(last?.headers.get("x-api-key")).toBe(OWN_KEY);
    expect(last?.body.model).toBe("claude-own");
  });

  test("a binding whose key was withdrawn falls back to the default, as a built-in employee does", async () => {
    await runAsTenant(tenant, () =>
      database
        .update(credentials)
        .set({ revokedAt: new Date() })
        .where(eq(credentials.id, library.credentialId)),
    );
    expect((await open(ids.bound))?.model).toBe("deepseek-chat");
    const response = await call(ids.bound);
    expect(response.status).toBe(200);
    await response.text();
    expect(seen.at(-1)?.url).toBe(
      "https://api.deepseek.com/anthropic/v1/messages",
    );
    expect(seen.at(-1)?.headers.get("authorization")).toBe(
      `Bearer ${DEPLOY_KEY}`,
    );
  });

  test("a default model the provider cannot serve in this format is refused in words, not forwarded", async () => {
    const original = deployment;
    deployment = original && { ...original, provider: "google", baseUrl: null };
    const before = seen.length;
    const response = await call(ids.bare);
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toContain("google/");
    expect(seen.length).toBe(before);
    deployment = original;
  });

  test("with no default model to resolve (no key), the original sentence: no block, and 400 at the proxy", async () => {
    const original = deployment;
    deployment = undefined;
    expect(await open(ids.bare)).toBeNull();
    const before = seen.length;
    const response = await call(ids.bare);
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toContain(
      "这位员工还没有可用的模型，请在员工设置里为它选一个模型。",
    );
    expect(seen.length).toBe(before);
    deployment = original;
  });
});
