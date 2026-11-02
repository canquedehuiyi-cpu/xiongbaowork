import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, like } from "drizzle-orm";
import {
  type EnterpriseControls,
  installEnterpriseControls,
} from "../src/admin/controls";
import { createAuditStore } from "../src/audit";
import { reconcileDirectoryState } from "../src/auth/scim";
import type { ComputerProvider } from "../src/computer/provider";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  auditEvents,
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
  });
  controls = await installEnterpriseControls({
    database,
    databaseUrl: testDatabaseUrl(),
    auditStore,
    provider,
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
    await database.delete(agentProfiles).where(eq(agentProfiles.agentId, bot));
    await database.delete(agents).where(eq(agents.id, bot));
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
