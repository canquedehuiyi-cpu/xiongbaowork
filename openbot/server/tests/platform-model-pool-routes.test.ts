import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import {
  parsePlatformModelsCommand,
  runPlatformModelsCommand,
} from "../scripts/platform-models";
import {
  createAgentProfileStore,
  ModelBindingConflictError,
  PlatformModelNotAvailableError,
} from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createAgentRoutes } from "../src/agents/routes";
import type { AppVariables } from "../src/auth/guards";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  modelRegistry,
  platformModelPool,
  subscriptions,
  users,
} from "../src/db/schema";
import { createModelRoutes } from "../src/models/routes";
import { createQuotaService } from "../src/quota/limits";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Stories H1, H2 and K1, API plane: what a tenant sees of the platform model pool and how a coworker
 * is bound to it.
 *
 * - `GET /api/models` lists only the enabled pool rows the tenant's plan may use (no subscription is
 *   Free), never the key variable's name or a key, and says whether the deployment holds the key.
 * - `PATCH /api/agents/:id` binds a coworker to a pool row with the same three-way as `modelRef`;
 *   a Pro-only row is refused for a Free tenant, naming both bindings is refused, and binding one
 *   clears the other.
 * - The per-row coworker count is the tenant's own, under row-level security.
 * - The operator CLI takes a key variable's NAME and never a key.
 *
 * The suite runs as `openbot_app` (NOBYPASSRLS, FORCE RLS in CI). The pool is platform-owned and
 * the application may only read it, so its rows are written through the owner connection
 * (`TEST_DATABASE_ADMIN_URL`). No provider is ever called.
 */
const url = testDatabaseUrl();
const db = createDatabase(url, TEST_POOL);
const encryptionKey = Buffer.alloc(32, 9).toString("base64");

function ownerUrl(): string {
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
  admin.pathname = target.pathname;
  return admin.toString();
}

function ownerConnection(address: string): SQL {
  const parsed = new URL(address);
  // Bun prefers $DATABASE_URL over explicit parts. `createDatabase` above has already removed it
  // from the environment, so the parts below are what this connection uses.
  return new SQL({
    adapter: "postgres",
    hostname: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 5432,
    username: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: decodeURIComponent(parsed.pathname.replace(/^\//, "")),
    max: 1,
  });
}

const ownerAddress = ownerUrl();
const owner = ownerConnection(ownerAddress);
/** The operator CLI's own path: drizzle over an owner connection. */
const operator = createDatabase(ownerAddress, { max: 1 });

const marker = randomUUID().replaceAll("-", "").slice(0, 10);
const MARK = marker.toUpperCase();
const freeTenant = `poolapi-${marker}-free`;
const proTenant = `poolapi-${marker}-pro`;
const FREE_KEY = `OPENBOT_POOL_APIFREE_${MARK}`;
const PRO_KEY = `OPENBOT_POOL_APIPRO_${MARK}`;
const UNSET_KEY = `OPENBOT_POOL_APIUNSET_${MARK}`;
const OFF_KEY = `OPENBOT_POOL_APIOFF_${MARK}`;
const CLI_KEY = `OPENBOT_POOL_APICLI_${MARK}`;
const environment: Record<string, string | undefined> = {
  [FREE_KEY]: `pool-api-free-secret-${marker}`,
  [PRO_KEY]: `pool-api-pro-secret-${marker}`,
  [OFF_KEY]: `pool-api-off-secret-${marker}`,
  [CLI_KEY]: `pool-api-cli-secret-${marker}`,
};

const pool = { freeTier: "", proOnly: "", unset: "", off: "" };

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

/** The signed-in person, who is also the tenant; switched per call. */
let signedIn: AgentActor = { id: freeTenant, role: "user" };
const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", signedIn as AppVariables["actor"]);
  await next();
};

const quota = createQuotaService(db);
const modelRoutes = createModelRoutes(
  db,
  requireUser,
  createCredentialStore(db),
  encryptionKey,
  quota,
  { environment },
);
const store = createAgentProfileStore(db, undefined);
const agentRoutes = createAgentRoutes(store, requireUser);

type PoolEntry = {
  id: string;
  provider: string;
  modelName: string;
  label: string;
  coworkers: number;
  available: boolean;
};
type Library = { pool: PoolEntry[]; customModels: boolean };
type AgentBody = {
  agent?: { modelRef: string | null; platformModelRef: string | null };
  error?: string;
};

async function call<T>(
  routes: { request: (request: Request) => Response | Promise<Response> },
  tenant: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; text: string; body: T }> {
  signedIn = { id: tenant, role: "user" };
  const response = await runAsTenant(tenant, () =>
    routes.request(
      new Request(`http://openbot.test${path}`, {
        method,
        ...(body === undefined
          ? {}
          : {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            }),
      }),
    ),
  );
  const text = await response.text();
  return {
    status: response.status,
    text,
    body: (text ? JSON.parse(text) : null) as T,
  };
}

const library = (tenant: string) =>
  call<Library>(modelRoutes, tenant, "GET", "/");

/** Only this file's rows: other suites may hold pool rows of their own in the same database. */
const mine = (entries: PoolEntry[]) =>
  entries.filter((entry) => entry.modelName.endsWith(`-${marker}`));

const form = {
  name: "体验员工",
  title: "助理",
  roleDescription: "回答问题。",
  visibility: "private" as const,
};

let coworkerSeq = 0;
async function newCoworker(tenant: string): Promise<string> {
  coworkerSeq += 1;
  const id = `poolapi-${marker}-${coworkerSeq}`;
  await runAsTenant(tenant, async () => {
    await db.insert(agents).values({
      id,
      name: id,
      type: "built_in",
      configuration: { systemPrompt: "test" },
    });
    await db.insert(agentProfiles).values({
      agentId: id,
      ownerUserId: tenant,
      title: id,
      roleDescription: "体验模型测试员工",
      avatarSeed: marker,
      visibility: "private",
    });
  });
  return id;
}

const patch = (tenant: string, coworker: string, binding: object) =>
  call<AgentBody>(agentRoutes, tenant, "PATCH", `/${coworker}`, {
    ...form,
    ...binding,
  });

async function stored(tenant: string, coworker: string) {
  const [row] = await runAsTenant(tenant, () =>
    db
      .select({
        modelRef: agentProfiles.modelRef,
        platformModelRef: agentProfiles.platformModelRef,
      })
      .from(agentProfiles)
      .where(eq(agentProfiles.agentId, coworker)),
  );
  return row;
}

beforeAll(async () => {
  pool.freeTier = await poolRow("free-tier", FREE_KEY, "{free,pro}");
  pool.proOnly = await poolRow("pro-only", PRO_KEY, "{pro}");
  pool.unset = await poolRow("unset-key", UNSET_KEY, "{free}");
  pool.off = await poolRow("switched-off", OFF_KEY, "{free,pro}", false);
  for (const tenant of [freeTenant, proTenant]) {
    await runAsTenant(tenant, () =>
      db
        .insert(users)
        .values({ id: tenant, email: `${tenant}@example.test`, name: tenant })
        .onConflictDoNothing(),
    );
  }
  // Pro holds an active Pro subscription; Free holds none at all, which is Free.
  await runAsTenant(proTenant, () =>
    db.insert(subscriptions).values({ planId: "pro" }),
  );
});

afterAll(async () => {
  try {
    // agent_profiles restricts the pool row's delete, so the coworkers go first.
    await owner`delete from public.agents where id like ${`poolapi-${marker}-%`}`;
    await owner`
      delete from public.model_registry where model_name = ${`library-${marker}`}
    `;
    await owner`
      delete from public.subscriptions where tenant_id in (${freeTenant}, ${proTenant})
    `;
    await owner`delete from public.users where id in (${freeTenant}, ${proTenant})`;
    await owner`
      delete from public.platform_model_pool where model_name like ${`%-${marker}`}
    `;
  } finally {
    await owner.close();
    await operator.$client.close();
    await db.$client.close();
  }
});

describe("GET /api/models: the platform pool", () => {
  test("a Free tenant sees only enabled free-tier rows, and no key field anywhere", async () => {
    const response = await library(freeTenant);
    expect(response.status).toBe(200);
    const entries = mine(response.body.pool);
    expect(entries.map((entry) => entry.id).sort()).toEqual(
      [pool.freeTier, pool.unset].sort(),
    );
    // Pro-only and switched-off rows are not offered.
    expect(entries.some((entry) => entry.id === pool.proOnly)).toBe(false);
    expect(entries.some((entry) => entry.id === pool.off)).toBe(false);
    for (const entry of response.body.pool) {
      expect(Object.keys(entry).sort()).toEqual(
        [
          "available",
          "coworkers",
          "id",
          "label",
          "modelName",
          "provider",
        ].sort(),
      );
    }
    // Not the variable's name, not its value, not the column, anywhere in the body.
    for (const leak of [
      FREE_KEY,
      UNSET_KEY,
      environment[FREE_KEY] as string,
      "apiKeyEnv",
      "api_key_env",
      "OPENBOT_POOL_",
    ]) {
      expect(response.text).not.toContain(leak);
    }
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    expect(byId.get(pool.freeTier)).toMatchObject({
      provider: "openai",
      modelName: `free-tier-${marker}`,
      label: "体验模型 free-tier",
      available: true,
    });
    // The deployment holds no value for this row's key: listed, but not available.
    expect(byId.get(pool.unset)?.available).toBe(false);
    // Free may not connect models with its own key (K1).
    expect(response.body.customModels).toBe(false);
  });

  test("a Pro tenant sees the pro-only row and may connect its own models", async () => {
    const response = await library(proTenant);
    expect(response.status).toBe(200);
    const ids = mine(response.body.pool).map((entry) => entry.id);
    expect(ids).toContain(pool.freeTier);
    expect(ids).toContain(pool.proOnly);
    // `{free}` only: Pro is not in its tiers.
    expect(ids).not.toContain(pool.unset);
    expect(ids).not.toContain(pool.off);
    expect(response.text).not.toContain(PRO_KEY);
    expect(response.text).not.toContain(environment[PRO_KEY] as string);
    expect(response.body.customModels).toBe(true);
  });
});

describe("PATCH /api/agents/:id: binding a coworker to the pool", () => {
  test("a pro-only row is refused for a Free tenant, and so is a switched-off row", async () => {
    const coworker = await newCoworker(freeTenant);
    const proOnly = await patch(freeTenant, coworker, {
      platformModelRef: pool.proOnly,
    });
    expect(proOnly.status).toBe(400);
    expect(proOnly.body.error).toBe(
      new PlatformModelNotAvailableError().message,
    );
    const off = await patch(freeTenant, coworker, {
      platformModelRef: pool.off,
    });
    expect(off.status).toBe(400);
    expect(off.body.error).toBe(new PlatformModelNotAvailableError().message);
    const unknown = await patch(freeTenant, coworker, {
      platformModelRef: randomUUID(),
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toBe(
      new PlatformModelNotAvailableError().message,
    );
    // Not a uuid at all: refused by the form parser before the store is asked.
    const malformed = await patch(freeTenant, coworker, {
      platformModelRef: "not-a-pool-id",
    });
    expect(malformed.status).toBe(400);
    expect(await stored(freeTenant, coworker)).toEqual({
      modelRef: null,
      platformModelRef: null,
    });

    // The same row binds for a Pro tenant: the refusal was the plan, not the row.
    const proCoworker = await newCoworker(proTenant);
    const bound = await patch(proTenant, proCoworker, {
      platformModelRef: pool.proOnly,
    });
    expect(bound.status).toBe(200);
    expect(bound.body.agent?.platformModelRef).toBe(pool.proOnly);
  });

  test("naming a library model and a pool model at once is refused", async () => {
    const coworker = await newCoworker(freeTenant);
    const both = await patch(freeTenant, coworker, {
      modelRef: randomUUID(),
      platformModelRef: pool.freeTier,
    });
    expect(both.status).toBe(400);
    expect(both.body.error).toBe(new ModelBindingConflictError().message);
    expect(await stored(freeTenant, coworker)).toEqual({
      modelRef: null,
      platformModelRef: null,
    });

    // The store refuses it too, for a caller that skips the form parser.
    const [libraryModel] = await runAsTenant(freeTenant, () =>
      db
        .insert(modelRegistry)
        .values({ provider: "openai", modelName: `library-${marker}` })
        .returning({ id: modelRegistry.id }),
    );
    let refused: unknown;
    try {
      await runAsTenant(freeTenant, () =>
        store.update({ id: freeTenant, role: "user" }, coworker, {
          ...form,
          modelRef: libraryModel.id,
          platformModelRef: pool.freeTier,
        }),
      );
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(ModelBindingConflictError);
    expect(await stored(freeTenant, coworker)).toEqual({
      modelRef: null,
      platformModelRef: null,
    });
  });

  test("bind, switch to the library and back, then clear", async () => {
    const coworker = await newCoworker(freeTenant);
    const bound = await patch(freeTenant, coworker, {
      platformModelRef: pool.freeTier,
    });
    expect(bound.status).toBe(200);
    expect(bound.body.agent).toMatchObject({
      modelRef: null,
      platformModelRef: pool.freeTier,
    });

    // A save that does not mention the binding leaves it alone.
    const renamed = await patch(freeTenant, coworker, {});
    expect(renamed.status).toBe(200);
    expect(renamed.body.agent?.platformModelRef).toBe(pool.freeTier);

    // Binding a library model clears the pool binding rather than tripping the one-binding CHECK.
    const [libraryModel] = await runAsTenant(freeTenant, () =>
      db
        .select({ id: modelRegistry.id })
        .from(modelRegistry)
        .where(eq(modelRegistry.modelName, `library-${marker}`)),
    );
    const libraryId =
      libraryModel?.id ??
      (
        await runAsTenant(freeTenant, () =>
          db
            .insert(modelRegistry)
            .values({ provider: "openai", modelName: `library-${marker}` })
            .returning({ id: modelRegistry.id }),
        )
      )[0].id;
    const onLibrary = await patch(freeTenant, coworker, {
      modelRef: libraryId,
    });
    expect(onLibrary.status).toBe(200);
    expect(await stored(freeTenant, coworker)).toEqual({
      modelRef: libraryId,
      platformModelRef: null,
    });

    // And binding the pool again clears the library binding.
    const back = await patch(freeTenant, coworker, {
      platformModelRef: pool.freeTier,
    });
    expect(back.status).toBe(200);
    expect(await stored(freeTenant, coworker)).toEqual({
      modelRef: null,
      platformModelRef: pool.freeTier,
    });

    const cleared = await patch(freeTenant, coworker, {
      platformModelRef: null,
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body.agent?.platformModelRef).toBeNull();
    expect(await stored(freeTenant, coworker)).toEqual({
      modelRef: null,
      platformModelRef: null,
    });
  });

  test("the coworker count on a pool row is the tenant's own", async () => {
    const freeBefore = mine((await library(freeTenant)).body.pool).find(
      (entry) => entry.id === pool.freeTier,
    )?.coworkers;
    const proBefore = mine((await library(proTenant)).body.pool).find(
      (entry) => entry.id === pool.freeTier,
    )?.coworkers;

    const freeOne = await newCoworker(freeTenant);
    const proOne = await newCoworker(proTenant);
    const proTwo = await newCoworker(proTenant);
    for (const [tenant, coworker] of [
      [freeTenant, freeOne],
      [proTenant, proOne],
      [proTenant, proTwo],
    ] as const) {
      const bound = await patch(tenant, coworker, {
        platformModelRef: pool.freeTier,
      });
      expect(bound.status).toBe(200);
    }

    const freeAfter = mine((await library(freeTenant)).body.pool).find(
      (entry) => entry.id === pool.freeTier,
    )?.coworkers;
    const proAfter = mine((await library(proTenant)).body.pool).find(
      (entry) => entry.id === pool.freeTier,
    )?.coworkers;
    expect(freeAfter).toBe((freeBefore ?? 0) + 1);
    expect(proAfter).toBe((proBefore ?? 0) + 2);
  });
});

describe("scripts/platform-models.ts: the operator CLI", () => {
  test("a key value is never an argument, and is never echoed back", () => {
    const secret = `sk-should-not-echo-${marker}`;
    for (const argv of [
      ["add", "--provider", "openai", "--api-key", secret],
      ["add", `--api-key=${secret}`],
      ["add", "--key", secret],
    ]) {
      const parsed = parsePlatformModelsCommand(argv);
      expect("error" in parsed).toBe(true);
      expect(JSON.stringify(parsed)).not.toContain(secret);
    }
    // A key pasted where the variable's NAME belongs is refused, not stored.
    const pasted = parsePlatformModelsCommand([
      "add",
      "--provider",
      "openai",
      "--model",
      "m",
      "--label",
      "l",
      "--api-key-env",
      secret,
    ]);
    expect("error" in pasted).toBe(true);
    expect(JSON.stringify(pasted)).not.toContain(secret);
    expect(
      "error" in
        parsePlatformModelsCommand([
          "add",
          "--provider",
          "openai",
          "--model",
          "m",
          "--label",
          "l",
          "--api-key-env",
          "DATABASE_URL",
        ]),
    ).toBe(true);
    expect(
      "error" in
        parsePlatformModelsCommand([
          "add",
          "--provider",
          "openai",
          "--model",
          "m",
          "--label",
          "l",
          "--api-key-env",
          CLI_KEY,
          "--tiers",
          "free,enterprise",
        ]),
    ).toBe(true);
    expect("error" in parsePlatformModelsCommand(["disable", "nope"])).toBe(
      true,
    );
  });

  test("add, list and disable through an owner connection; the tenant shelf follows", async () => {
    const add = parsePlatformModelsCommand([
      "add",
      "--provider",
      "openai",
      "--model",
      `cli-${marker}`,
      "--label",
      "命令行体验模型",
      `--api-key-env=${CLI_KEY}`,
      "--tiers",
      "free",
    ]);
    if ("error" in add) throw new Error(add.error);
    const added = await runPlatformModelsCommand(operator, add);
    expect(added.kind).toBe("added");
    const id = (added as { id: string }).id;

    const listed = await runPlatformModelsCommand(operator, { kind: "list" });
    expect(listed.kind).toBe("list");
    const row = (
      listed as { models: { id: string; apiKeyEnv: string }[] }
    ).models.find((model) => model.id === id);
    expect(row).toMatchObject({ apiKeyEnv: CLI_KEY, tiers: ["free"] });
    // The listing holds the variable's name, never a value.
    expect(JSON.stringify(listed)).not.toContain(
      environment[CLI_KEY] as string,
    );

    const offered = mine((await library(freeTenant)).body.pool).find(
      (entry) => entry.id === id,
    );
    expect(offered).toMatchObject({ available: true, coworkers: 0 });

    const disabled = await runPlatformModelsCommand(operator, {
      kind: "disable",
      id,
    });
    expect(disabled).toEqual({ kind: "disabled", id });
    const [stored] = await runAsTenant("platform", () =>
      operator
        .select({ enabled: platformModelPool.enabled })
        .from(platformModelPool)
        .where(eq(platformModelPool.id, id)),
    );
    expect(stored?.enabled).toBe(false);
    expect(
      mine((await library(freeTenant)).body.pool).some(
        (entry) => entry.id === id,
      ),
    ).toBe(false);

    expect(
      await runPlatformModelsCommand(operator, {
        kind: "disable",
        id: randomUUID(),
      }),
    ).toMatchObject({ kind: "missing" });
  });

  test("the application role cannot write the pool, so the CLI is the owner's alone", async () => {
    const add = parsePlatformModelsCommand([
      "add",
      "--provider",
      "openai",
      "--model",
      `app-${marker}`,
      "--label",
      "应用角色",
      "--api-key-env",
      CLI_KEY,
    ]);
    if ("error" in add) throw new Error(add.error);
    const refused = await runPlatformModelsCommand(db, add).then(
      () => null,
      (error: unknown) => error,
    );
    expect(refused).not.toBeNull();
  });
});
