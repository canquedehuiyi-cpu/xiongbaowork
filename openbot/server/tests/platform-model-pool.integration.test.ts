import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import type { LanguageModel } from "ai";
import { SQL } from "bun";
import { and, eq } from "drizzle-orm";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  modelRegistry,
  modelTokenCalls,
  subscriptions,
} from "../src/db/schema";
import {
  boundModelName,
  createAgentModelResolver,
  type LanguageModelFactory,
} from "../src/models/runtime-resolver";
import {
  databaseTokenCallSink,
  type ModelTokenCallRow,
} from "../src/models/token-metering";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Stories H1 and K1, data plane: a Free tenant's coworker bound to a platform pool model speaks with
 * it on the platform's key, and every call is metered under that tenant — never `system` or
 * `platform`. A row whose tiers leave the tenant's plan out, a pool key the deployment does not have,
 * or a row switched off all fall back to the deployment default (`null`), and a coworker can never be
 * bound to a pool model and a library model at once.
 *
 * The suite runs as `openbot_app`. The pool is platform-owned and the application may only read it,
 * so its rows are written through the owner connection (`TEST_DATABASE_ADMIN_URL`, pointed at the
 * same database). No provider is called: the language model factory is a fake, and the pool keys come
 * from an injected environment, never from `process.env`.
 */
const url = testDatabaseUrl();
const db = createDatabase(url, TEST_POOL);
const encryptionKey = Buffer.alloc(32, 7).toString("base64");

function ownerConnection(): SQL {
  const raw = process.env.TEST_DATABASE_ADMIN_URL?.trim();
  if (!raw) {
    throw new Error(
      "TEST_DATABASE_ADMIN_URL must name the database owner: platform_model_pool is not writable by openbot_app.",
    );
  }
  const admin = new URL(raw);
  const target = new URL(url);
  if (admin.hostname !== target.hostname || admin.port !== target.port) {
    throw new Error(
      "TEST_DATABASE_ADMIN_URL must reach the same server as TEST_DATABASE_URL.",
    );
  }
  // Bun prefers $DATABASE_URL over explicit parts; never let it pick the target.
  delete process.env.DATABASE_URL;
  return new SQL({
    adapter: "postgres",
    hostname: admin.hostname,
    port: admin.port ? Number(admin.port) : 5432,
    username: decodeURIComponent(admin.username),
    password: decodeURIComponent(admin.password),
    database: decodeURIComponent(target.pathname.replace(/^\//, "")),
    max: 1,
  });
}

const owner = ownerConnection();

const marker = randomUUID().replaceAll("-", "").slice(0, 10);
const MARK = marker.toUpperCase();
const freeTenant = `pool-${marker}-free`;
const proTenant = `pool-${marker}-pro`;
const FREE_KEY = `OPENBOT_POOL_FREE_${MARK}`;
const PRO_KEY = `OPENBOT_POOL_PRO_${MARK}`;
const UNSET_KEY = `OPENBOT_POOL_UNSET_${MARK}`;
const EMPTY_KEY = `OPENBOT_POOL_EMPTY_${MARK}`;
const OFF_KEY = `OPENBOT_POOL_OFF_${MARK}`;
const environment: Record<string, string | undefined> = {
  [FREE_KEY]: `pool-free-secret-${marker}`,
  [PRO_KEY]: `pool-pro-secret-${marker}`,
  [EMPTY_KEY]: "",
  [OFF_KEY]: `pool-off-secret-${marker}`,
};

const sha = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

/** One factory call, with the key it was handed; asserted on, never printed. */
type Built = {
  provider: string;
  baseUrl: string | null;
  modelName: string;
  apiKey: string;
};
const built: Built[] = [];

/** A provider-shaped model that never leaves the process. */
const fakeFactory: LanguageModelFactory = (
  provider,
  baseUrl,
  modelName,
  apiKey,
) => {
  built.push({ provider, baseUrl, modelName, apiKey });
  return {
    specificationVersion: "v3",
    provider: `${provider}.chat`,
    modelId: modelName,
    supportedUrls: {},
    doGenerate: async () => ({
      content: [{ type: "text", text: "你好" }],
      finishReason: "stop",
      usage: {
        inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 3, text: 3, reasoning: 0 },
      },
      response: { modelId: modelName },
      warnings: [],
    }),
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
    }),
  } as unknown as LanguageModel;
};

/** A capture sink in front of the real one, so the row is both inspected and written. */
const captured: ModelTokenCallRow[] = [];
const writes: Promise<void>[] = [];
const databaseSink = databaseTokenCallSink(db);
const sink = async (row: ModelTokenCallRow) => {
  captured.push(row);
  const write = databaseSink(row);
  writes.push(write);
  await write;
};

const resolveModel = createAgentModelResolver(
  db,
  createCredentialStore(db),
  encryptionKey,
  sink,
  { environment, languageModel: fakeFactory },
);

const pool = {
  freeTier: "",
  proOnly: "",
  unset: "",
  empty: "",
  off: "",
};

async function poolRow(
  name: string,
  keyEnv: string,
  tiers: string,
  enabled = true,
): Promise<string> {
  const [row] = await owner`
    insert into public.platform_model_pool
      (provider, model_name, label, api_key_env, tiers, enabled)
    values ('openai', ${`${name}-${marker}`}, ${`体验模型 ${name}`}, ${keyEnv},
            ${tiers}::text[], ${enabled})
    returning id
  `;
  return String((row as { id: string }).id);
}

async function newCoworker(
  tenant: string,
  name: string,
  binding: { modelRef?: string | null; platformModelRef?: string | null },
): Promise<string> {
  const id = `pool-${marker}-${name}`;
  await runAsTenant(tenant, async () => {
    await db.insert(agents).values({
      id,
      name: id,
      type: "built_in",
      configuration: { systemPrompt: "test" },
    });
    await db.insert(agentProfiles).values({
      agentId: id,
      title: id,
      roleDescription: "体验模型测试员工",
      avatarSeed: marker,
      visibility: "private",
      modelRef: binding.modelRef ?? null,
      platformModelRef: binding.platformModelRef ?? null,
    });
  });
  return id;
}

type Callable = {
  doGenerate: (o: unknown) => Promise<Record<string, unknown>>;
};
const callable = (model: LanguageModel) => model as unknown as Callable;

/** The message of an error and of every cause under it, which is where Postgres's sentence is. */
function failureText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    parts.push(current instanceof Error ? current.message : String(current));
    current = (current as { cause?: unknown }).cause;
  }
  return parts.join(" | ");
}

beforeAll(async () => {
  pool.freeTier = await poolRow("free-tier", FREE_KEY, "{free,pro}");
  pool.proOnly = await poolRow("pro-only", PRO_KEY, "{pro}");
  pool.unset = await poolRow("unset-key", UNSET_KEY, "{free,pro}");
  pool.empty = await poolRow("empty-key", EMPTY_KEY, "{free,pro}");
  pool.off = await poolRow("switched-off", OFF_KEY, "{free,pro}", false);
  // The Pro tenant has an active Pro subscription; the Free tenant has none at all, which is Free.
  await runAsTenant(proTenant, () =>
    db.insert(subscriptions).values({ planId: "pro" }),
  );
});

afterAll(async () => {
  try {
    // agent_profiles restricts the pool row's delete, so the coworkers go first. Everything this
    // file wrote carries its marker, so the cleanup matches on that rather than on a bound list.
    await owner`delete from public.agents where id like ${`pool-${marker}-%`}`;
    await owner`
      delete from public.model_registry
      where tenant_id = ${freeTenant} and model_name = ${`library-${marker}`}
    `;
    await owner`delete from public.subscriptions where tenant_id = ${proTenant}`;
    await owner`
      delete from public.platform_model_pool where model_name like ${`%-${marker}`}
    `;
  } finally {
    await owner.close();
    await db.$client.close();
  }
});

describe("platform model pool binding", () => {
  test("a Free tenant's coworker on a free-tier pool row speaks with it, metered under that tenant", async () => {
    const coworker = await newCoworker(freeTenant, "free-on-free", {
      platformModelRef: pool.freeTier,
    });
    const before = built.length;
    const model = await runAsTenant(freeTenant, () => resolveModel(coworker));
    expect(model).not.toBeNull();
    expect(built.slice(before)).toEqual([
      {
        provider: "openai",
        baseUrl: null,
        modelName: `free-tier-${marker}`,
        apiKey: environment[FREE_KEY] as string,
      },
    ]);
    expect(
      await runAsTenant(freeTenant, () =>
        boundModelName(db, coworker, environment),
      ),
    ).toBe(`openai/free-tier-${marker}`);

    const already = captured.length;
    const result = await runAsTenant(freeTenant, () =>
      callable(model as LanguageModel).doGenerate({}),
    );
    expect(result.finishReason).toBe("stop");
    await Promise.all(writes);
    const rows = captured.slice(already);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toMatchObject({
      tenantId: freeTenant,
      agentId: coworker,
      modelRef: pool.freeTier,
      credentialId: pool.freeTier,
      provider: "openai",
      modelName: `free-tier-${marker}`,
      originalText: `openai/free-tier-${marker}`,
      outcome: "completed",
      usageStatus: "reported",
      inputTokens: 12,
      outputTokens: 3,
    });
    expect(row.credentialDigest).toBe(
      sha(
        `pool:${pool.freeTier}:${FREE_KEY}:${sha(environment[FREE_KEY] as string)}`,
      ),
    );
    // The key itself is in no field of the usage row.
    expect(JSON.stringify(row)).not.toContain(environment[FREE_KEY] as string);

    // Written to the database under the profile's tenant, and invisible to anybody else's frame.
    const callId = row.callId as string;
    const mine = await runAsTenant(freeTenant, () =>
      db
        .select({
          tenantId: modelTokenCalls.tenantId,
          modelRef: modelTokenCalls.modelRef,
        })
        .from(modelTokenCalls)
        .where(
          and(
            eq(modelTokenCalls.tenantId, freeTenant),
            eq(modelTokenCalls.callId, callId),
          ),
        ),
    );
    expect(mine).toEqual([{ tenantId: freeTenant, modelRef: pool.freeTier }]);
    const elsewhere = await runAsTenant(proTenant, () =>
      db
        .select({ callId: modelTokenCalls.callId })
        .from(modelTokenCalls)
        .where(eq(modelTokenCalls.callId, callId)),
    );
    expect(elsewhere).toEqual([]);
  });

  test("a pro-only pool row is no binding for a Free tenant, and is one for a Pro tenant", async () => {
    const freeCoworker = await newCoworker(freeTenant, "free-on-pro", {
      platformModelRef: pool.proOnly,
    });
    const before = built.length;
    expect(
      await runAsTenant(freeTenant, () => resolveModel(freeCoworker)),
    ).toBeNull();
    expect(
      await runAsTenant(freeTenant, () =>
        boundModelName(db, freeCoworker, environment),
      ),
    ).toBeNull();
    // Refused before the key was ever read into a provider client.
    expect(built.length).toBe(before);

    const proCoworker = await newCoworker(proTenant, "pro-on-pro", {
      platformModelRef: pool.proOnly,
    });
    const model = await runAsTenant(proTenant, () => resolveModel(proCoworker));
    expect(model).not.toBeNull();
    expect(built.at(-1)).toMatchObject({
      modelName: `pro-only-${marker}`,
      apiKey: environment[PRO_KEY] as string,
    });
  });

  test("a pool key the deployment does not have, or has empty, falls back to the default", async () => {
    const unset = await newCoworker(freeTenant, "unset-key", {
      platformModelRef: pool.unset,
    });
    const empty = await newCoworker(freeTenant, "empty-key", {
      platformModelRef: pool.empty,
    });
    const before = built.length;
    expect(await runAsTenant(freeTenant, () => resolveModel(unset))).toBeNull();
    expect(await runAsTenant(freeTenant, () => resolveModel(empty))).toBeNull();
    expect(
      await runAsTenant(freeTenant, () =>
        boundModelName(db, unset, environment),
      ),
    ).toBeNull();
    expect(built.length).toBe(before);
  });

  test("a switched-off pool row falls back to the default", async () => {
    const coworker = await newCoworker(freeTenant, "switched-off", {
      platformModelRef: pool.off,
    });
    expect(
      await runAsTenant(freeTenant, () => resolveModel(coworker)),
    ).toBeNull();
  });

  test("a coworker cannot be bound to a library model and a pool model at once", async () => {
    const [library] = await runAsTenant(freeTenant, () =>
      db
        .insert(modelRegistry)
        .values({ provider: "openai", modelName: `library-${marker}` })
        .returning({ id: modelRegistry.id }),
    );
    const failure = await newCoworker(freeTenant, "both-refs", {
      modelRef: library.id,
      platformModelRef: pool.freeTier,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).not.toBeNull();
    expect(failureText(failure)).toContain(
      'violates check constraint "agent_profiles_single_model_binding"',
    );

    // And a coworker already on the pool cannot be moved onto a library model without leaving it.
    const pooled = await newCoworker(freeTenant, "pooled", {
      platformModelRef: pool.freeTier,
    });
    const update = await runAsTenant(freeTenant, () =>
      db
        .update(agentProfiles)
        .set({ modelRef: library.id })
        .where(eq(agentProfiles.agentId, pooled)),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failureText(update)).toContain(
      'violates check constraint "agent_profiles_single_model_binding"',
    );
  });

  test("the pool refuses a key name outside the pool prefix and a plan outside the catalogue", async () => {
    const badKey = await poolRow("bad-key", "DATABASE_URL", "{free,pro}").then(
      () => null,
      (error: unknown) => error,
    );
    expect(failureText(badKey)).toContain("platform_model_pool_api_key_env");
    const badTier = await poolRow(
      "bad-tier",
      `OPENBOT_POOL_TIER_${MARK}`,
      "{free,enterprise}",
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failureText(badTier)).toContain("platform_model_pool_tiers");
  });

  test("a pool row a coworker is bound to cannot be deleted from under it", async () => {
    await newCoworker(freeTenant, "holds-row", {
      platformModelRef: pool.freeTier,
    });
    const failure = await owner`
      delete from public.platform_model_pool where id = ${pool.freeTier}
    `.then(
      () => null,
      (error: unknown) => error,
    );
    expect(failureText(failure)).toContain(
      "agent_profiles_platform_model_ref_platform_model_pool_id_fk",
    );
  });
});
