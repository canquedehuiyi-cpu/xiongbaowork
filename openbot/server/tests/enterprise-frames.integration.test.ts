import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, like } from "drizzle-orm";
import { Hono } from "hono";
import {
  type EnterpriseControls,
  installEnterpriseControls,
} from "../src/admin/controls";
import { createEnterpriseGate } from "../src/admin/gate";
import { createAuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import { reconcileDirectoryState } from "../src/auth/scim";
import type { ComputerProvider } from "../src/computer/provider";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  auditEvents,
  modelUsage,
  revokedAccess,
  users,
} from "../src/db/schema";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * G01-D: the enterprise controls' timers and SCIM's deferred offboarding have no person behind
 * them. Each says whose it is: the deployment's settings and cross-tenant questions as `platform`,
 * and a person's own computers and trail as that person, read from their own rows. Driven under
 * `OPENBOT_TENANT_FRAME_GUARD=throw`, so anything left to the legacy `system` fallback fails here.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const auditStore = createAuditStore(database);
const suite = randomUUID().slice(0, 8);
const person = {
  id: `entf-person-${suite}`,
  email: `entf-person-${suite}@acme.test`,
};
const bot = `entf-bot-${suite}`;
const remoteBot = `entf-remote-${suite}`;
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
  list: async () => [
    {
      botId: bot,
      status: "running",
      url: "",
      startedAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
    },
  ],
};
let controls: EnterpriseControls;
const savedGuard = process.env.OPENBOT_TENANT_FRAME_GUARD;

async function underThrow<T>(work: () => Promise<T>): Promise<T> {
  process.env.OPENBOT_TENANT_FRAME_GUARD = "throw";
  try {
    return await work();
  } finally {
    if (savedGuard === undefined) delete process.env.OPENBOT_TENANT_FRAME_GUARD;
    else process.env.OPENBOT_TENANT_FRAME_GUARD = savedGuard;
  }
}

/** Every audit row about `targetId` of one type, with the tenant it was filed under. */
const rowsAbout = (eventType: string, targetId: string) =>
  runAsTenant("platform", () =>
    database
      .select({ tenantId: auditEvents.tenantId })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.eventType, eventType),
          eq(auditEvents.targetId, targetId),
        ),
      ),
  );

async function eventually<T>(read: () => Promise<T[]>): Promise<T[]> {
  const deadline = Date.now() + 3000;
  for (;;) {
    const rows = await read();
    if (rows.length > 0 || Date.now() > deadline) return rows;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

beforeAll(async () => {
  // The identity row is the identity layer's, written as `platform` the way sign-up writes it.
  await runAsTenant("platform", () =>
    database.insert(users).values({ ...person, name: "Person" }),
  );
  // The person's own Bot, stamped with their tenant the way provisioning stamps it.
  await runAsTenant(person.id, async () => {
    await database.insert(agents).values({
      id: bot,
      tenantId: person.id,
      name: "Frames test Bot",
      type: "built_in",
      configuration: {},
    });
    await database.insert(agentProfiles).values({
      agentId: bot,
      tenantId: person.id,
      ownerUserId: person.id,
      title: "Test",
      roleDescription: "Test",
      avatarSeed: "x",
      visibility: "private",
    });
    await database.insert(agents).values({
      id: remoteBot,
      tenantId: person.id,
      name: "Frames test remote Bot",
      type: "remote_ag_ui",
      configuration: {},
    });
  });
  controls = await installEnterpriseControls({
    database,
    databaseUrl: testDatabaseUrl(),
    auditStore,
    provider,
    builtInModel: "openai/gpt-frames",
    env: {},
    // No intervals: each sweep is driven by the test.
    clock: {
      scheduleInterval: () => 0 as unknown as ReturnType<typeof setInterval>,
      cancelInterval: () => {},
    },
  });
});

afterAll(async () => {
  await controls?.stop();
  await runAsTenant("platform", async () => {
    await database
      .delete(modelUsage)
      .where(like(modelUsage.agentId, `entf-%${suite}`));
    await database.delete(agentProfiles).where(eq(agentProfiles.agentId, bot));
    await database.delete(agents).where(eq(agents.id, bot));
    await database.delete(agents).where(eq(agents.id, remoteBot));
    await database
      .delete(revokedAccess)
      .where(like(revokedAccess.email, `%${suite}%`));
    await database.delete(users).where(eq(users.id, person.id));
  });
  await database.$client.end({ timeout: 5 });
});

describe("enterprise controls with no frame of their own", () => {
  test("the settings refresh reads as platform", async () => {
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      await underThrow(() => controls.refresh());
      expect(
        errors.mock.calls.some((call) =>
          String(call[0]).includes("enterprise-controls-refresh-failed"),
        ),
      ).toBe(false);
    } finally {
      errors.mockRestore();
    }
    expect(controls.snapshot()).toBeDefined();
  });

  test("a Bot's network policy is resolved from its owner's profile, from no frame", async () => {
    const policy = await underThrow(() => controls.policyForBot(bot));
    expect(policy.mode).toBeDefined();
  });

  test("an inactive computer is stopped and the row filed in its owner's trail", async () => {
    stopped.length = 0;
    const result = await underThrow(() =>
      controls.terminateInactiveComputers(),
    );
    expect(result?.stopped).toContain(bot);
    expect(await rowsAbout("computer.terminated_inactive", bot)).toEqual([
      { tenantId: person.id },
    ]);
  });

  test("an administrator stopping a member's computers finds the member's Bots", async () => {
    stopped.length = 0;
    const admin = `entf-admin-${suite}`;
    const result = await runAsTenant(admin, () =>
      controls.terminateMemberComputers(person.id, { id: admin, email: "a@x" }),
    );
    expect(result.stopped).toEqual([bot]);
    expect(stopped).toEqual([bot]);
  });
});

describe("SCIM offboarding", () => {
  test("the deferred offboarding runs as the person, and their trail row is theirs", async () => {
    stopped.length = 0;
    const deps = { database, auditStore, initialAdminEmails: [] };
    // The SCIM handler runs as the identity layer (`platform`); the timer it leaves must not.
    await runAsTenant("platform", () =>
      reconcileDirectoryState(deps, { userId: person.id, active: false }),
    );
    expect(
      await eventually(() => rowsAbout("person.deprovisioned", person.id)),
    ).toEqual([{ tenantId: person.id }]);
    expect(stopped).toContain(bot);
    // (The administrator's stop above is filed in the administrator's own trail.)
    expect(await rowsAbout("computer.terminated", person.id)).toContainEqual({
      tenantId: person.id,
    });

    await runAsTenant("platform", () =>
      reconcileDirectoryState(deps, { userId: person.id, active: true }),
    );
    expect(await rowsAbout("person.reprovisioned", person.id)).toEqual([
      { tenantId: person.id },
    ]);
  });
});

/**
 * The HTTP gate in front of a run, with `requireUser` framing the request the way the production
 * guard does (`runAsTenant(<session user>, next)`), and a runtime stub that streams a model name.
 */
function gateFor(actor: { id: string; email: string }) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use(
    "/api/*",
    createEnterpriseGate(async (context, next) => {
      context.set("actor", { ...actor, role: "user" });
      await runAsTenant(actor.id, () => next());
    }),
  );
  app.post(
    "/api/copilotkit/agent/:id/run",
    () =>
      new Response(
        'data: {"type":"RUN_STARTED","model":"anthropic/claude-frames"}\n\n',
        {
          headers: { "content-type": "text/event-stream" },
        },
      ),
  );
  return app;
}

const allowlist = (value: { enabled: boolean; models: string[] }) =>
  runAsTenant("platform", async () => {
    await controls.store.setSetting("modelAllowlist", value, "test");
    await controls.refresh();
  });

/** The usage rows for one run, with the tenant each was filed under. */
const usageFor = (runId: string) =>
  runAsTenant("platform", () =>
    database
      .select({
        tenantId: modelUsage.tenantId,
        userId: modelUsage.userId,
        model: modelUsage.model,
        source: modelUsage.source,
        allowed: modelUsage.allowed,
      })
      .from(modelUsage)
      .where(eq(modelUsage.runId, runId)),
  );

describe("a governed run, inside the person's own frame", () => {
  const gate = gateFor(person);
  const run = (agentId: string, runId: string) =>
    gate.request(`/api/copilotkit/agent/${agentId}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId: `t-${suite}`, runId }),
    });

  test("a built-in Bot off the allowlist is refused, and the refusal is the person's row", async () => {
    await allowlist({ enabled: true, models: ["anthropic/claude-frames"] });
    try {
      const runId = `refused-${suite}`;
      const response = await underThrow(() => run(bot, runId));
      expect(response.status).toBe(403);
      expect(await usageFor(runId)).toEqual([
        {
          tenantId: person.id,
          userId: person.id,
          model: "openai/gpt-frames",
          source: "configured",
          allowed: false,
        },
      ]);
      expect(await rowsAbout("model.refused", bot)).toEqual([
        { tenantId: person.id },
      ]);
    } finally {
      await allowlist({ enabled: false, models: [] });
    }
  });

  test("a built-in Bot on the allowlist runs, and its usage row is the person's", async () => {
    await allowlist({ enabled: true, models: ["openai/gpt-frames"] });
    try {
      const runId = `allowed-${suite}`;
      const response = await underThrow(() => run(bot, runId));
      expect(response.status).toBe(200);
      expect(await usageFor(runId)).toEqual([
        {
          tenantId: person.id,
          userId: person.id,
          model: "openai/gpt-frames",
          source: "configured",
          allowed: true,
        },
      ]);
    } finally {
      await allowlist({ enabled: false, models: [] });
    }
  });

  test("a remote Bot's streamed model is recorded in the person's tenant after the stream is read", async () => {
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const runId = `remote-${suite}`;
      await underThrow(async () => {
        const response = await run(remoteBot, runId);
        expect(response.status).toBe(200);
        // The body is read outside any frame, as the server reads it.
        expect(await response.text()).toContain("anthropic/claude-frames");
        expect(await eventually(() => usageFor(runId))).toEqual([
          {
            tenantId: person.id,
            userId: person.id,
            model: "anthropic/claude-frames",
            source: "observed",
            allowed: true,
          },
        ]);
      });
      expect(
        errors.mock.calls.some((call) =>
          String(call[0]).includes("model-usage-write-failed"),
        ),
      ).toBe(false);
    } finally {
      errors.mockRestore();
    }
  });
});
