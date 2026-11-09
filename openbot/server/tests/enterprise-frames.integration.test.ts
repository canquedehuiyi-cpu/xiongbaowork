import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, like, or } from "drizzle-orm";
import { Hono } from "hono";
import {
  type EnterpriseControls,
  installEnterpriseControls,
} from "../src/admin/controls";
import { createEnterpriseGate } from "../src/admin/gate";
import { createEnterpriseAdminRoutes } from "../src/admin/routes";
import { createAuditStore } from "../src/audit";
import { createAdminScope } from "../src/auth/admin-scope";
import type { AppVariables } from "../src/auth/guards";
import { reconcileDirectoryState } from "../src/auth/scim";
import { computerKeyText } from "../src/computer/computer-key";
import type { ComputerProvider } from "../src/computer/provider";
import { createDatabase } from "../src/db/client";
import {
  actionRecords,
  agentProfiles,
  agents,
  auditEvents,
  groupTaskRuns,
  groupTaskTemplates,
  modelUsage,
  revokedAccess,
  tasks,
  users,
  wakerGroupMembers,
  wakerGroups,
} from "../src/db/schema";
import { createPipelineStore } from "../src/pipeline/store";
import { createTaskProjector } from "../src/tasks/projector";
import {
  assertPersonTenant,
  runAsTenant,
  TenantContextError,
} from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * G01-D: the enterprise controls' timers and SCIM's deferred offboarding have no person behind
 * them. Each says whose it is: the deployment's settings and cross-tenant questions as `platform`,
 * and a person's own computers and trail as that person, read from their own rows. Every access
 * needs a frame, so anything left to the legacy `system` fallback fails here.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const auditStore = createAuditStore(database);
const suite = randomUUID().slice(0, 8);
const person = {
  id: `entf-person-${suite}`,
  email: `entf-person-${suite}@acme.test`,
};
const bot = `entf-bot-${suite}`;
/** The Bot's own computer, as a provider and the trail name it (`bot:<id>`). */
const botComputer = `bot:${bot}`;
const remoteBot = `entf-remote-${suite}`;
const stopped: string[] = [];
const provider: ComputerProvider = {
  name: "fake",
  isolation: "per-person",
  locate: async () => "http://unused",
  status: async (seat) => ({ botId: seat.botId, state: "ready" }),
  stop: async (target) => {
    stopped.push(computerKeyText(target.key));
    return { wasRunning: true };
  },
  reset: async () => ({ cleared: false }),
  list: async () => [
    {
      key: { kind: "bot", botId: bot },
      status: "running",
      url: "",
      startedAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
    },
  ],
};
let controls: EnterpriseControls;

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
  await runAsTenant(person.id, async () => {
    await database.delete(tasks);
    await database.delete(groupTaskRuns);
    await database.delete(groupTaskTemplates);
    await database.delete(wakerGroups);
  });
  await runAsTenant("platform", async () => {
    await database
      .delete(actionRecords)
      .where(like(actionRecords.botId, `entf-%${suite}`));
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
      await controls.refresh();
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
    const policy = await controls.policyForBot(bot);
    expect(policy.mode).toBeDefined();
  });

  test("an inactive computer is stopped and the row filed in its owner's trail", async () => {
    stopped.length = 0;
    const result = await controls.terminateInactiveComputers();
    expect(result?.stopped).toContain(botComputer);
    expect(await rowsAbout("computer.terminated_inactive", botComputer)).toEqual([
      { tenantId: person.id },
    ]);
  });

  test("an administrator stopping a member's computers finds the member's Bots", async () => {
    stopped.length = 0;
    const admin = `entf-admin-${suite}`;
    const result = await runAsTenant(admin, () =>
      controls.terminateMemberComputers(person.id, { id: admin, email: "a@x" }),
    );
    // M3: computers are keyed by whose they are now: the member's own, then each Bot of theirs.
    expect(result.stopped).toEqual([`person:${person.id}`, botComputer]);
    expect(stopped).toEqual([`person:${person.id}`, botComputer]);
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
    expect(stopped).toContain(botComputer);
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
      const response = await run(bot, runId);
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
      const response = await run(bot, runId);
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

/*
 * G01-E P7: the administrator's recorded-actions screen reads as `platform`.
 *
 * Each `action_records` row is stamped with the person whose Bot acted, so the administrator's own
 * frame answered with their own actions only. The route reads through `asAdminPlatform`, which needs
 * the capability `adminCapability` grants after re-reading the role.
 */
describe("the administrator's actions screen", () => {
  const admin = {
    id: `entf-admin-${suite}`,
    email: `entf-admin-${suite}@acme.test`,
  };
  const other = `entf-other-${suite}`;
  const firstBot = `entf-act-a-${suite}`;
  const secondBot = `entf-act-b-${suite}`;

  const adminApp = (roles: string[]) => {
    const app = new Hono<{ Variables: AppVariables }>();
    app.route(
      "/api/admin/enterprise",
      createEnterpriseAdminRoutes(
        async (context, next) => {
          context.set("actor", { ...admin, role: "admin" });
          await runAsTenant(admin.id, () => next());
        },
        createAdminScope({
          roleRepository: { rolesForUser: async () => roles as never },
        }),
      ),
    );
    return app;
  };

  const seedActions = async () => {
    for (const [tenant, botId] of [
      [person.id, firstBot],
      [other, secondBot],
    ] as const) {
      await runAsTenant(tenant, () =>
        database.insert(actionRecords).values({
          surface: "cloud",
          botId,
          actorUserId: tenant,
          toolName: "click",
          command: "click",
          outcome: "allowed",
        }),
      );
    }
  };

  test("an administrator sees two people's actions", async () => {
    await seedActions();
    const response = await adminApp(["admin"]).request(
      "/api/admin/enterprise/actions?limit=500",
    );
    expect(response.status).toBe(200);
    const { actions } = (await response.json()) as {
      actions: { botId: string | null; tenantId: string }[];
    };
    expect(
      actions
        .filter((row) => row.botId === firstBot || row.botId === secondBot)
        .map((row) => `${row.botId}:${row.tenantId}`)
        .sort(),
    ).toEqual([`${firstBot}:${person.id}`, `${secondBot}:${other}`].sort());
  });

  test("a role removed since sign-in reads nobody's actions", async () => {
    const response = await adminApp(["user"]).request(
      "/api/admin/enterprise/actions?limit=500",
    );
    expect(response.status).toBe(403);
  });
});

/*
 * G01-E P7 (R10, R14): an answered approval resumes the crew run parked on it in the crew owner's
 * frame, and only when the approval's owner is that crew's owner.
 *
 * `runHoldingApproval` looks the run up as `platform`, so it can name anybody's run. The approval
 * worker (`index.ts`) asserts the run's stamp against the approval's owner with
 * `assertPersonTenant(parkedCrew.tenantId, input.ownerUserId)`, skips and logs a mismatch, and runs
 * `resume` inside `runAsTenant(owner)`. The worker is part of the server's boot module, which a test
 * cannot import, so the same three calls are driven here against a real parked run, and the
 * worker's use of them is pinned on its source.
 */
describe("a parked crew run, answered", () => {
  const stranger = `entf-stranger-${suite}`;
  const groupId = randomUUID();
  const approvalId = `entf-approval-${suite}`;
  const steps = [
    { id: "ask", agentId: `entf-ask-${suite}`, instruction: "ask first" },
    { id: "finish", agentId: `entf-finish-${suite}`, instruction: "finish" },
  ];
  const pipeline = createPipelineStore({
    database,
    board: createTaskProjector(database),
    executeStep: async ({ agentId }) =>
      agentId === steps[0]!.agentId
        ? ({ status: "awaiting_action", approvalId } as const)
        : ({ status: "done", output: "finished" } as const),
    canUse: async () => true,
    newRunId: () => randomUUID(),
  });

  /** What the approval worker does with an answered approval, in the frame it is handed. */
  const answer = async (ownerUserId: string) => {
    const parkedCrew = await pipeline.runHoldingApproval({ approvalId });
    if (!parkedCrew) return "none" as const;
    let tenant: string;
    try {
      tenant = assertPersonTenant(parkedCrew.tenantId, ownerUserId);
    } catch (error) {
      if (!(error instanceof TenantContextError)) throw error;
      return "skipped" as const;
    }
    await runAsTenant(tenant, () =>
      pipeline.resume({
        tenantId: tenant,
        runId: parkedCrew.runId,
        output: "approved",
      }),
    );
    return "resumed" as const;
  };

  test("a mismatched owner is skipped; the owner's answer resumes it, and its writes are the owner's", async () => {
    const started = await runAsTenant(person.id, async () => {
      await database
        .insert(wakerGroups)
        .values({ id: groupId, tenantId: person.id, name: `crew-${suite}` });
      await database.insert(wakerGroupMembers).values(
        steps.map((step, index) => ({
          groupId,
          agentId: step.agentId,
          position: String(index),
        })),
      );
      const templateId = await pipeline.createTemplate({
        tenantId: person.id,
        groupId,
        name: `crew-template-${suite}`,
        steps,
      });
      const started = await pipeline.start({
        tenantId: person.id,
        templateId,
        task: "parked on an approval",
        initiatedBy: person.id,
      });
      const parked = await pipeline.advance({
        tenantId: person.id,
        runId: started.runId,
      });
      expect(parked.status).toBe("awaiting_action");
      return started;
    });
    const { runId, parentTaskId } = started;
    const statusOf = () =>
      runAsTenant("platform", async () => {
        const [row] = await database
          .select({ status: groupTaskRuns.status })
          .from(groupTaskRuns)
          .where(eq(groupTaskRuns.id, runId));
        return row?.status;
      });

    // Somebody else's approval, answered in their own frame, names this run and is refused.
    expect(await runAsTenant(stranger, () => answer(stranger))).toBe("skipped");
    expect(await statusOf()).toBe("awaiting_action");

    // The owner's answer, handed over from `platform` (no person frame): resumed as the owner.
    expect(await runAsTenant("platform", () => answer(person.id))).toBe(
      "resumed",
    );
    expect(await statusOf()).toBe("done");
    const stamps = await runAsTenant("platform", async () => {
      const runs = await database
        .select({ tenantId: groupTaskRuns.tenantId })
        .from(groupTaskRuns)
        .where(eq(groupTaskRuns.id, runId));
      const cards = await database
        .select({ tenantId: tasks.tenantId })
        .from(tasks)
        .where(
          or(eq(tasks.id, parentTaskId), eq(tasks.parentTaskId, parentTaskId)),
        );
      return [...runs, ...cards].map((row) => row.tenantId);
    });
    expect(stamps.length).toBeGreaterThan(1);
    expect(new Set(stamps)).toEqual(new Set([person.id]));
  });

  test("the approval worker asserts the crew's owner and resumes in that frame", async () => {
    // M3: upstream moved the approval worker out of index.ts into approvals/resume-sweep.ts.
    const source = await Bun.file(
      new URL("../src/approvals/resume-sweep.ts", import.meta.url),
    ).text();
    // The owner check every parked run meets: the row's stamp, agreeing with the approval's owner.
    expect(source).toMatch(
      /const ownedBy = \([^]*?assertPersonTenant\(parked\.tenantId, ownerUserId\)/,
    );
    const lookup = source.indexOf("pipeline?.runHoldingApproval(");
    expect(lookup).toBeGreaterThan(-1);
    const window = source.slice(lookup, lookup + 2500);
    expect(window).toMatch(
      /ownedBy\(\s*parkedCrew,\s*input\.ownerUserId,\s*"parked-crew-owner-mismatch",/,
    );
    expect(window).toMatch(
      /runAsTenant\(crewTenant, \(\) =>\s*pipeline\.resume\(\{\s*tenantId: crewTenant,/,
    );
    // The only resume of a parked crew in the worker is the framed one, and index.ts has none.
    expect(source.match(/pipeline\.resume\(/g)?.length).toBe(1);
    const index = await Bun.file(
      new URL("../src/index.ts", import.meta.url),
    ).text();
    expect(index).not.toContain("pipelineStore.resume(");
  });
});
