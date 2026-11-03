import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import type { AppVariables } from "../src/app-variables";
import {
  createApprovalService,
  HANDLED_BY_PERSON,
} from "../src/approvals/service";
import { createApprovalStore } from "../src/approvals/store";
import type { ApprovalCandidate } from "../src/approvals/types";
import { createAdminScope } from "../src/auth/admin-scope";
import { createRoleRepository } from "../src/auth/guards";
import { setRole } from "../src/auth/roles";
import { HeadlessToolSuspension } from "../src/computer/headless-tools";
import { createDatabase } from "../src/db/client";
import {
  approvalTeamRules,
  approvalTeamSettings,
  auditEvents,
} from "../src/db/schema";
import { users } from "../src/db/schema/core";
import { workItems } from "../src/db/schema/work";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { bindTestRoleWriter } from "./support/role-writer";

/**
 * Rules, team settings, hand-offs and the audit trail, against real tables. Needs a database with
 * the TS schema applied (the coordinator's generated migration, or `drizzle-kit push` on a scratch
 * database). The team settings row is deployment-wide, so this file restores it afterwards.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `policy-${randomUUID()}`;
const owner = `${prefix}-owner`;
const admin = `${prefix}-admin`;
const store = createApprovalStore(database);
const service = createApprovalService(store);
const teamRuleIds: string[] = [];
let priorTeam: typeof approvalTeamSettings.$inferSelect | undefined;
const scope = createAdminScope({
  roleRepository: createRoleRepository(database),
});
let releaseRoleWriter: (() => Promise<void>) | undefined;

/*
 * Every call runs in an explicit frame. The member's own requests, rules and preferences are hers, so
 * they run as her. The team layer is the one set of rows every member's gate must read: it is
 * stamped `team` from the admin's own frame, inside an admin request that holds the capability
 * (G01-E "team-rules"), exactly as the team routes write it. The user rows, the saved team row and
 * the audit reads that span both are the deployment's own, so they run as `platform`.
 */
const asOwner = <T>(work: () => Promise<T>) => runAsTenant(owner, work);
const asTeam = async <T>(work: () => Promise<T>): Promise<T> => {
  let outcome: { value: T } | { error: unknown } | undefined;
  const app = new Hono<{ Variables: AppVariables }>();
  app.use(
    "*",
    async (context, next) => {
      context.set("actor", { id: admin, role: "admin" });
      await runAsTenant(admin, () => next());
    },
    scope.adminCapability,
  );
  app.get("/", async (context) => {
    outcome = await work().then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    return context.body(null, 204);
  });
  await app.request("http://openbot.test/");
  if (!outcome) throw new Error("The admin request never ran its work.");
  if ("error" in outcome) throw outcome.error;
  return outcome.value;
};
const asPlatform = <T>(work: () => Promise<T>) => runAsTenant("platform", work);

beforeAll(async () => {
  releaseRoleWriter = await bindTestRoleWriter(database);
  await asPlatform(async () => {
    await database.insert(users).values([
      { id: owner, email: `${owner}@example.test` },
      { id: admin, email: `${admin}@example.test` },
    ]);
    [priorTeam] = await database
      .select()
      .from(approvalTeamSettings)
      .where(eq(approvalTeamSettings.id, "team"));
    await setRole(database, admin, "admin");
  });
});
afterAll(async () => {
  await asPlatform(async () => {
    if (teamRuleIds.length)
      await database
        .delete(approvalTeamRules)
        .where(inArray(approvalTeamRules.id, teamRuleIds));
    await database
      .delete(approvalTeamSettings)
      .where(eq(approvalTeamSettings.id, "team"));
    if (priorTeam)
      await database.insert(approvalTeamSettings).values(priorTeam);
  });
  await asOwner(async () => {
    await database.delete(workItems).where(
      and(
        eq(workItems.kind, "approval.resume"),
        inArray(
          workItems.key,
          (await store.list(owner)).map((request) => request.id),
        ),
      ),
    );
  });
  // Audit rows are append-only by design and stay; they name only this run's throwaway ids.
  await asPlatform(async () => {
    await database.delete(users).where(inArray(users.id, [owner, admin]));
  });
  await releaseRoleWriter?.();
  await database.$client.close();
});

function candidate(over: Partial<ApprovalCandidate> = {}): ApprovalCandidate {
  const toolCallId = randomUUID();
  return {
    actorId: owner,
    botId: `${prefix}-bot`,
    toolRef: "mcp/gmail/send_email",
    effect: "write",
    scope: "gmail",
    args: { to: "sam@example.com" },
    continuation: {
      runId: randomUUID(),
      // Its own conversation, so earlier answers in this file do not apply to it.
      threadId: `${prefix}-thread-${toolCallId}`,
      toolCallId,
      toolName: "mcp/gmail/send_email",
      args: { to: "sam@example.com" },
      messages: [],
      state: {},
      context: [],
      forwardedProps: {},
      initiator: { kind: "routine", id: `${prefix}-routine` },
    },
    ...over,
  };
}

const suspends = (promise: Promise<unknown>) =>
  promise.then(
    () => false,
    (error: unknown) => error instanceof HeadlessToolSuspension,
  );

test("personal and team rules layer, the strictest wins, and switching custom rules off keeps team rules", async () => {
  await asOwner(() =>
    service.createRule(owner, {
      botId: "*",
      toolRef: "mcp/gmail/*",
      effect: "*",
      scope: "*",
      behaviour: "allow",
    }),
  );
  await expect(
    asOwner(() => service.gate(candidate())),
  ).resolves.toBeUndefined();

  const locked = await asTeam(() =>
    service.createTeamRule(admin, {
      botId: "*",
      toolRef: "mcp/gmail/send_*",
      effect: "write",
      scope: "*",
      behaviour: "ask",
    }),
  );
  teamRuleIds.push(locked.id);
  expect(await suspends(asOwner(() => service.gate(candidate())))).toBeTrue();

  await asTeam(() =>
    service.setTeamSettings(admin, { customRulesEnabled: false }),
  );
  await expect(
    asOwner(() =>
      service.createRule(owner, {
        botId: "*",
        toolRef: "*",
        effect: "*",
        scope: "*",
        behaviour: "allow",
      }),
    ),
  ).rejects.toThrow("switched custom rules off");
  await asTeam(() => service.revokeTeamRule(admin, locked.id));
  // Personal allow no longer applies; with no preference that is the default (allow).
  await expect(
    asOwner(() => service.gate(candidate())),
  ).resolves.toBeUndefined();
  await asTeam(() =>
    service.setTeamSettings(admin, { customRulesEnabled: true }),
  );

  const inbox = await asOwner(() => service.inbox(owner));
  expect(inbox.rules.map((rule) => rule.behaviour)).toContain("allow");
  expect(inbox.team).toMatchObject({ customRulesEnabled: true });
});

test("a safety hand-off is stored, cannot be allowed, and is marked done by the person", () =>
  asOwner(async () => {
    const paying = candidate({
      toolRef: "computer_click",
      args: { element: "Pay now" },
    });
    expect(await suspends(service.gate(paying))).toBeTrue();
    const [request] = (await store.list(owner)).filter(
      (row) => row.action.toolCallId === paying.continuation?.toolCallId,
    );
    expect(request?.action.policy).toMatchObject({
      behaviour: "hand_off",
      source: "safety",
    });
    await expect(
      service.decide(owner, request?.id as string, "allow_always"),
    ).rejects.toThrow("handed to you");
    const decided = await service.decide(
      owner,
      request?.id as string,
      "handled",
    );
    expect(decided.decision).toBe("handled");
    await expect(service.gate(paying)).resolves.toMatchObject({
      replay: HANDLED_BY_PERSON,
    });
  }));

test("'Always allow here' saves a personal allow rule that the gate then honours", () =>
  asOwner(async () => {
    await store.policy?.setPreferences(owner, { enabled: true });
    await store.setEnabled(owner, true);
    const first = candidate({ toolRef: "mcp/drive/share", scope: "drive" });
    expect(await suspends(service.gate(first))).toBeTrue();
    const [request] = (await store.list(owner)).filter(
      (row) => row.action.toolCallId === first.continuation?.toolCallId,
    );
    expect(request?.action.policy?.behaviour).toBe("ask");
    await service.decide(owner, request?.id as string, "allow_always");
    const rules = await store.rules(owner);
    expect(rules).toContainEqual(
      expect.objectContaining({
        toolRef: "mcp/drive/share",
        behaviour: "allow",
      }),
    );
    await expect(
      service.gate(candidate({ toolRef: "mcp/drive/share", scope: "drive" })),
    ).resolves.toBeUndefined();
    await store.setEnabled(owner, false);
  }));

test("every non-trivial verdict is on the audit trail with its initiator", async () => {
  const rows = await asOwner(() =>
    database
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.actorUserId, owner),
          eq(auditEvents.eventType, "approval.evaluated"),
        ),
      ),
  );
  expect(rows.length).toBeGreaterThanOrEqual(4);
  expect(rows).toContainEqual(
    expect.objectContaining({
      initiatorKind: "routine",
      initiatorId: `${prefix}-routine`,
      payload: expect.objectContaining({
        outcome: expect.objectContaining({ source: "safety" }),
      }),
    }),
  );
  const changes = await asPlatform(() =>
    database
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.actorUserId, admin)),
  );
  expect(changes.map((row) => row.eventType)).toEqual(
    expect.arrayContaining([
      "approval.rule_changed",
      "approval.settings_changed",
    ]),
  );
});

test("host commands: the member's setting under the team cap, stricter wins", async () => {
  await asOwner(() => service.setPreferences(owner, { hostCommands: "allow" }));
  await asTeam(() =>
    service.setTeamSettings(admin, { hostCommandsCap: "ask" }),
  );
  expect(await asOwner(() => service.hostCommandPolicy(owner))).toBe("ask");
  await asOwner(() => service.setPreferences(owner, { hostCommands: "never" }));
  expect(await asOwner(() => service.hostCommandPolicy(owner))).toBe("never");
  await asTeam(() =>
    service.setTeamSettings(admin, { hostCommandsCap: "allow" }),
  );
  await asOwner(() => service.setPreferences(owner, { hostCommands: "allow" }));
  expect(await asOwner(() => service.hostCommandPolicy(owner))).toBe("allow");
});

test("a saved rule is changed in place, only by its owner, and the change is on the trail", async () => {
  const rule = await asOwner(() =>
    service.createRule(owner, {
      botId: "*",
      toolRef: "mcp/calendar/*",
      effect: "*",
      scope: "*",
      behaviour: "allow",
    }),
  );
  // Somebody else asking to change her rule. Run as `platform`, which can see her row, so "could not be
  // found" proves the service's owner check rather than row-level security hiding the row.
  await expect(
    asPlatform(() =>
      service.updateRule(admin, rule.id, { behaviour: "hand_off" }),
    ),
  ).rejects.toThrow("could not be found");
  const changed = await asOwner(() =>
    service.updateRule(owner, rule.id, {
      behaviour: "ask",
    }),
  );
  expect(changed).toMatchObject({ id: rule.id, behaviour: "ask" });
  expect(
    await suspends(
      asOwner(() =>
        service.gate(candidate({ toolRef: "mcp/calendar/create_event" })),
      ),
    ),
  ).toBeTrue();
  const locked = await asTeam(() =>
    service.createTeamRule(admin, {
      botId: "*",
      toolRef: "mcp/crm/*",
      effect: "*",
      scope: "*",
      behaviour: "ask",
    }),
  );
  teamRuleIds.push(locked.id);
  await expect(
    asTeam(() =>
      service.updateTeamRule(admin, locked.id, { behaviour: "hand_off" }),
    ),
  ).resolves.toMatchObject({ behaviour: "hand_off" });
  const rows = await asPlatform(() =>
    database
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.eventType, "approval.rule_changed")),
  );
  expect(
    rows.filter(
      (row) =>
        (row.targetId === rule.id || row.targetId === locked.id) &&
        (row.payload as { change?: string }).change === "updated",
    ),
  ).toHaveLength(2);
});

test("declining one connector call does not decline a different call to the same tool", () =>
  asOwner(async () => {
    await store.setEnabled(owner, true);
    const thread = `${prefix}-thread-equivalence`;
    const email = (to: string) => {
      const base = candidate();
      return candidate({
        // A tool no other test here has a rule for.
        toolRef: "mcp/mailer/send_email",
        scope: "mailer",
        args: { to, body: "hello" },
        // The connector target, as `plugins/store.ts` builds it: it names the tool, not the call.
        target: {
          serverId: "mailer",
          toolName: "send_email",
          url: "https://mailer.example",
          effect: "write",
        },
        continuation: {
          ...(base.continuation as NonNullable<
            ApprovalCandidate["continuation"]
          >),
          threadId: thread,
          args: { to, body: "hello" },
        },
      });
    };
    const first = email("a@example.test");
    expect(await suspends(service.gate(first))).toBeTrue();
    const [request] = (await store.list(owner)).filter(
      (row) => row.action.toolCallId === first.continuation?.toolCallId,
    );
    await service.decide(owner, request?.id as string, "deny");
    // The same call again, in the same conversation, is still declined.
    await expect(service.gate(email("a@example.test"))).rejects.toThrow(
      "declined",
    );
    // A different recipient is a different action: it is asked about, not refused as declined.
    expect(await suspends(service.gate(email("b@example.test")))).toBeTrue();
    await store.setEnabled(owner, false);
  }));
