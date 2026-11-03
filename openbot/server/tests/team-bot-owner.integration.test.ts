import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { LanguageModel } from "ai";
import { SQL } from "bun";
import { and, eq, like } from "drizzle-orm";
import {
  type EnterpriseControls,
  installEnterpriseControls,
  recordHeadlessModelUsage,
} from "../src/admin/controls";
import {
  deviceTargetForBot,
  ownerTenantOfBot,
  ownerTenantsOfBots,
} from "../src/agents/bot-owner";
import { createAuditStore } from "../src/audit";
import { AutomationRefusedError } from "../src/automations/types";
import { createAutomationStore } from "../src/automations/store";
import { ComputerUnavailableError } from "../src/computer/client";
import type {
  ComputerLocation,
  ComputerProvider,
} from "../src/computer/provider";
import { createCredentialStore, encryptSecret } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  auditEvents,
  automations,
  modelRegistry,
  modelTokenCalls,
  teamBotPublications,
  users,
  workItems,
} from "../src/db/schema";
import { TEAM_TENANT } from "../src/db/schema/tenant";
import type { DispatchTarget } from "../src/devices/channel";
import {
  createAgentModelResolver,
  type LanguageModelFactory,
} from "../src/models/runtime-resolver";
import {
  databaseTokenCallSink,
  type ModelTokenCallRow,
} from "../src/models/token-metering";
import { asPlatform, runAsTenant } from "../src/tenant/context";
import {
  CULL_KIND,
  offerIdleComputers,
  suspendClaimedComputers,
} from "../src/work/culler";
import { createWorkQueue } from "../src/work/queue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * G01-E P8a: a team Bot is stamped `team`, which is nobody — no machine, queue item, trail or bill
 * may be filed under it. Every site that used to read `agents.tenant_id` as "the owner" now asks
 * `agents/bot-owner.ts`, and the model resolver bills a team Bot's pool model to the person who
 * invokes it (the owner under background `platform`), and uses the owner's private library model
 * only in the owner's own frame (plan §2.4, user answer Q14).
 *
 * The Bots are stamped `team` directly under `platform`: raw fixture rows, the way the visibility
 * parity suite seeds them, because no production path moves a Bot into `team` before P8b. The pool
 * is platform-owned and read-only to the application, so its rows (and the teammate's subscription
 * cleanup) go through the owner connection. No provider is ever called: the model factory is a fake.
 */
const url = testDatabaseUrl();
const database = createDatabase(url, TEST_POOL);
const encryptionKey = Buffer.alloc(32, 7).toString("base64");
const credentialStore = createCredentialStore(database);
const suite = `tbo-${randomUUID().slice(0, 8)}`;
const MARK = suite.replaceAll("-", "_").toUpperCase();

const owner = `${suite}-owner`;
const teammate = `${suite}-teammate`;
/** Published to the whole team: every person can read it. */
const teamBot = `${suite}-team-bot`;
/** Stamped `team` but not published: only its owner can read it. */
const hiddenBot = `${suite}-hidden-bot`;
/** Stamped `team` with no owner on its profile: nobody's. */
const orphanBot = `${suite}-orphan-bot`;
/** A private Bot, stamped with its owner as before. */
const privateBot = `${suite}-private-bot`;
/** Team Bots bound to models. */
const proPoolBot = `${suite}-pro-pool-bot`;
const freePoolBot = `${suite}-free-pool-bot`;
const libraryBot = `${suite}-library-bot`;

const PRO_KEY = `OPENBOT_POOL_PRO_${MARK}`;
const FREE_KEY = `OPENBOT_POOL_FREE_${MARK}`;
const environment: Record<string, string | undefined> = {
  [PRO_KEY]: `pool-pro-secret-${suite}`,
  [FREE_KEY]: `pool-free-secret-${suite}`,
};

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
const ownerDb = ownerConnection();

/** A provider-shaped model that never leaves the process. */
const built: { modelName: string; apiKey: string }[] = [];
const fakeFactory: LanguageModelFactory = (
  provider,
  _baseUrl,
  modelName,
  apiKey,
) => {
  built.push({ modelName, apiKey });
  return {
    specificationVersion: "v3",
    provider: `${provider}.chat`,
    modelId: modelName,
    supportedUrls: {},
    doGenerate: async () => ({
      content: [{ type: "text", text: "ok" }],
      finishReason: "stop",
      usage: {
        inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 2, text: 2, reasoning: 0 },
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
type Callable = { doGenerate: (o: unknown) => Promise<unknown> };

const captured: ModelTokenCallRow[] = [];
/** The metering write is not awaited by the call it meters, so the suite waits for it here. */
const writes: Promise<void>[] = [];
const databaseSink = databaseTokenCallSink(database);
const sink = async (row: ModelTokenCallRow) => {
  captured.push(row);
  const write = databaseSink(row);
  writes.push(write);
  await write;
};
const resolveModel = createAgentModelResolver(
  database,
  credentialStore,
  encryptionKey,
  sink,
  { environment, languageModel: fakeFactory },
);
const modelIdOf = (model: LanguageModel | null) =>
  (model as unknown as { modelId?: string } | null)?.modelId ?? null;

const pool = { pro: "", free: "" };
let libraryModel = "";
let controls: EnterpriseControls | undefined;

/** A computer that has been running for ninety days and never acted: idle by every measure. */
const longAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
function providerWith(computers: ComputerLocation[]) {
  const stopped: string[] = [];
  const provider: ComputerProvider = {
    name: "fake",
    isolation: "per-bot",
    locate: async () => "http://unused",
    status: async (botId) => ({ botId, state: "ready" }),
    stop: async (botId) => {
      stopped.push(botId);
      return { wasRunning: true };
    },
    reset: async () => ({ cleared: false }),
    list: async () => computers,
  };
  return { provider, stopped };
}

async function seedTeamBot(
  id: string,
  options: {
    owner?: string | null;
    published?: boolean;
    modelRef?: string;
    platformModelRef?: string;
  } = {},
) {
  await asPlatform(async () => {
    await database.insert(agents).values({
      id,
      tenantId: TEAM_TENANT,
      name: `Reviewer ${id}`,
      type: "built_in",
      configuration: { systemPrompt: "test" },
    });
    await database.insert(agentProfiles).values({
      agentId: id,
      tenantId: TEAM_TENANT,
      ownerUserId: options.owner === undefined ? owner : options.owner,
      title: "Reviewer",
      roleDescription: "Reviews pull requests",
      avatarSeed: id,
      visibility: "private",
      modelRef: options.modelRef ?? null,
      platformModelRef: options.platformModelRef ?? null,
    });
    if (options.published)
      await database.insert(teamBotPublications).values({
        agentId: id,
        tenantId: TEAM_TENANT,
        publishedBy: owner,
        audience: "team",
      });
  });
}

async function poolRow(name: string, keyEnv: string, tiers: string) {
  const [row] = await ownerDb`
    insert into public.platform_model_pool
      (provider, model_name, label, api_key_env, tiers, enabled)
    values ('openai', ${`${name}-${suite}`}, ${`pool ${name}`}, ${keyEnv},
            ${tiers}::text[], true)
    returning id
  `;
  return String((row as { id: string }).id);
}

beforeAll(async () => {
  await asPlatform(() =>
    database.insert(users).values([
      { id: owner, email: `${owner}@example.test` },
      { id: teammate, email: `${teammate}@example.test` },
    ]),
  );
  pool.pro = await poolRow("pro-only", PRO_KEY, "{pro}");
  pool.free = await poolRow("free-tier", FREE_KEY, "{free,pro}");
  // The teammate is on Pro; the owner has no subscription at all, which is Free.
  await ownerDb`
    insert into public.subscriptions (tenant_id, plan_id) values (${teammate}, 'pro')
  `;
  libraryModel = await runAsTenant(owner, async () => {
    const credential = await credentialStore.create({
      kind: "model",
      provider: "openai",
      keyId: `${suite}-library`,
      encryptedValue: await encryptSecret(encryptionKey, "sk-owner-key"),
      metadata: {},
    });
    const [row] = await database
      .insert(modelRegistry)
      .values({
        provider: "openai",
        modelName: `library-${suite}`,
        credentialId: credential.id,
      })
      .returning({ id: modelRegistry.id });
    return row.id;
  });

  await seedTeamBot(teamBot, { published: true });
  await seedTeamBot(hiddenBot);
  await seedTeamBot(orphanBot, { owner: null });
  await seedTeamBot(proPoolBot, { published: true, platformModelRef: pool.pro });
  await seedTeamBot(freePoolBot, {
    published: true,
    platformModelRef: pool.free,
  });
  await seedTeamBot(libraryBot, { published: true, modelRef: libraryModel });
  await runAsTenant(owner, async () => {
    await database.insert(agents).values({
      id: privateBot,
      name: "Private Bot",
      type: "built_in",
      configuration: {},
    });
    await database.insert(agentProfiles).values({
      agentId: privateBot,
      ownerUserId: owner,
      title: "Private",
      roleDescription: "Private",
      avatarSeed: privateBot,
      visibility: "private",
    });
  });
});

afterAll(async () => {
  try {
    await controls?.stop();
    for (const person of [owner, teammate])
      await runAsTenant(person, () =>
        database.delete(automations).where(eq(automations.tenantId, person)),
      );
    await asPlatform(async () => {
      await database
        .delete(workItems)
        .where(
          and(eq(workItems.kind, CULL_KIND), like(workItems.key, `${suite}-%`)),
        );
      // Profiles and publications follow their agent by cascade.
      await database.delete(agents).where(like(agents.id, `${suite}-%`));
    });
    await ownerDb`delete from public.model_registry where model_name = ${`library-${suite}`}`;
    await ownerDb`delete from public.subscriptions where tenant_id = ${teammate}`;
    await ownerDb`delete from public.platform_model_pool where model_name like ${`%-${suite}`}`;
    await asPlatform(() =>
      database.delete(users).where(like(users.id, `${suite}-%`)),
    );
  } finally {
    await ownerDb.close();
    await database.$client.end({ timeout: 5 });
  }
});

describe("whose a team Bot is", () => {
  test("a team Bot's owner is its profile's owner; a private Bot's is its stamp; an orphan is nobody's", async () => {
    expect(await ownerTenantOfBot(database, teamBot)).toBe(owner);
    expect(await ownerTenantOfBot(database, privateBot)).toBe(owner);
    expect(await ownerTenantOfBot(database, orphanBot)).toBeNull();
    expect(await ownerTenantOfBot(database, `${suite}-missing`)).toBeNull();
    const many = await ownerTenantsOfBots(database, [
      teamBot,
      privateBot,
      orphanBot,
      `${suite}-missing`,
    ]);
    expect(Object.fromEntries(many)).toEqual({
      [teamBot]: owner,
      [privateBot]: owner,
      [orphanBot]: null,
    });
  });

  test("device mode dispatches a team Bot to its owner's machine, never to `team`", async () => {
    const asked: string[] = [];
    const registered: DispatchTarget[] = [];
    const deps = {
      database,
      reachableDevice: (tenantId: string) => {
        asked.push(tenantId);
        return tenantId === owner ? "owner-laptop" : null;
      },
      isRegistered: async (target: DispatchTarget) => {
        registered.push(target);
        return true;
      },
    };
    expect(
      await runAsTenant(teammate, () => deviceTargetForBot(deps, teamBot)),
    ).toEqual({ tenantId: owner, deviceId: "owner-laptop" });
    expect(asked).toEqual([owner]);
    expect(registered).toEqual([{ tenantId: owner, deviceId: "owner-laptop" }]);
    // A team Bot with no owner has no machine to run on, and is refused rather than sent to `team`.
    await expect(deviceTargetForBot(deps, orphanBot)).rejects.toBeInstanceOf(
      ComputerUnavailableError,
    );
    expect(asked).not.toContain(TEAM_TENANT);
  });

  test("the culler offers and suspends a team Bot's computer in its owner's frame", async () => {
    const { provider, stopped } = providerWith([
      { botId: teamBot, status: "running", url: "http://c", startedAt: longAgo },
    ]);
    const options = {
      database,
      queue: createWorkQueue(database),
      provider,
      idleAfterMs: 30 * 60_000,
      owner: `${suite}-replica`,
    };
    const offer = await offerIdleComputers(options);
    expect(offer.offered).toEqual([teamBot]);
    expect(offer.offeredAsPlatform).toEqual([]);
    const items = await asPlatform(() =>
      database
        .select({ tenantId: workItems.tenantId })
        .from(workItems)
        .where(and(eq(workItems.kind, CULL_KIND), eq(workItems.key, teamBot))),
    );
    expect(items).toEqual([{ tenantId: owner }]);

    const report = await suspendClaimedComputers(options);
    expect(report.suspended).toContain(teamBot);
    expect(stopped).toEqual([teamBot]);
  });

  test("the controls file a stopped team Bot's computer in its owner's trail", async () => {
    const { provider, stopped } = providerWith([
      { botId: teamBot, status: "running", url: "", startedAt: longAgo },
    ]);
    controls = await installEnterpriseControls({
      database,
      databaseUrl: url,
      auditStore: createAuditStore(database),
      provider,
      builtInModel: "openai/gpt-owner",
      env: {},
      clock: {
        scheduleInterval: () => 0 as unknown as ReturnType<typeof setInterval>,
        cancelInterval: () => {},
      },
    });
    const result = await controls.terminateInactiveComputers();
    expect(result?.stopped).toEqual([teamBot]);
    expect(stopped).toEqual([teamBot]);
    const rows = await asPlatform(() =>
      database
        .select({ tenantId: auditEvents.tenantId })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.eventType, "computer.terminated_inactive"),
            eq(auditEvents.targetId, teamBot),
          ),
        ),
    );
    expect(rows).toEqual([{ tenantId: owner }]);
  });

  test("headless model usage and token metering refuse `team` as a tenant", async () => {
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      await recordHeadlessModelUsage({
        tenantId: TEAM_TENANT,
        ownerUserId: owner,
        agentId: teamBot,
        threadId: null,
        runId: `${suite}-run`,
      });
      expect(
        errors.mock.calls.some((call) =>
          String(call[0]).includes("model-usage-without-tenant"),
        ),
      ).toBe(true);

      errors.mockClear();
      await databaseSink({
        tenantId: TEAM_TENANT,
        agentId: teamBot,
        callId: `${suite}-team-call`,
      } as ModelTokenCallRow);
      expect(
        errors.mock.calls.some(
          (call) =>
            JSON.stringify(call[0]).includes("model_token_call_write_failed") &&
            JSON.stringify(call[0]).includes("no_owning_tenant"),
        ),
      ).toBe(true);
    } finally {
      errors.mockRestore();
    }
  });
});

describe("automations on a team Waker", () => {
  const store = createAutomationStore(database);
  const create = (tenant: string, agentId: string) =>
    runAsTenant(tenant, () =>
      store.create({
        name: `daily ${randomUUID().slice(0, 4)}`,
        target: { kind: "waker", agentId },
      }),
    );

  test("a published team Waker is a target for its owner and for a teammate", async () => {
    expect((await create(owner, teamBot)).tenantId).toBe(owner);
    expect((await create(teammate, teamBot)).tenantId).toBe(teammate);
  });

  test("a team Waker the person cannot see is refused", async () => {
    // Its owner can read it, so it is theirs to automate; nobody else can.
    expect((await create(owner, hiddenBot)).tenantId).toBe(owner);
    await expect(create(teammate, hiddenBot)).rejects.toBeInstanceOf(
      AutomationRefusedError,
    );
  });
});

describe("who pays for a team Bot's model", () => {
  test("a teammate's pool-model turn is planned and metered as the teammate, never `team`", async () => {
    // Pro-only: the teammate is on Pro and the owner is on Free, so a binding exists only if the plan
    // asked about is the teammate's.
    const model = await runAsTenant(teammate, () => resolveModel(proPoolBot));
    expect(modelIdOf(model)).toBe(`pro-only-${suite}`);
    const before = captured.length;
    await runAsTenant(teammate, () =>
      (model as unknown as Callable).doGenerate({}),
    );
    await Promise.all(writes);
    const rows = captured.slice(before);
    expect(rows.map((row) => row.tenantId)).toEqual([teammate]);
    const written = await runAsTenant(teammate, () =>
      database
        .select({ tenantId: modelTokenCalls.tenantId })
        .from(modelTokenCalls)
        .where(eq(modelTokenCalls.callId, rows[0].callId)),
    );
    expect(written).toEqual([{ tenantId: teammate }]);
    // For the owner, on Free, the same pro-only binding does not hold.
    expect(
      await runAsTenant(owner, () => resolveModel(proPoolBot)),
    ).toBeNull();
  });

  test("background work under `platform` bills the owner", async () => {
    const model = await asPlatform(() => resolveModel(freePoolBot));
    expect(modelIdOf(model)).toBe(`free-tier-${suite}`);
    const before = captured.length;
    await asPlatform(() => (model as unknown as Callable).doGenerate({}));
    expect(captured.slice(before).map((row) => row.tenantId)).toEqual([owner]);
    // And with the owner on Free, the pro-only one does not resolve under `platform` either.
    expect(await asPlatform(() => resolveModel(proPoolBot))).toBeNull();
  });

  test("the owner's private library model resolves for the owner only", async () => {
    const mine = await runAsTenant(owner, () => resolveModel(libraryBot));
    expect(modelIdOf(mine)).toBe(`library-${suite}`);
    expect(
      await runAsTenant(teammate, () => resolveModel(libraryBot)),
    ).toBeNull();
    expect(await asPlatform(() => resolveModel(libraryBot))).toBeNull();
    // The owner's key was handed to the factory only for the owner's own turn.
    expect(
      built.filter((call) => call.apiKey === "sk-owner-key"),
    ).toHaveLength(1);
  });
});
