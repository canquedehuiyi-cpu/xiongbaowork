import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { HeadlessToolSuspension } from "@openbot/toolkit/headless-tools";
import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import {
  createApprovalService,
  HANDLED_BY_PERSON,
} from "../src/approvals/service";
import { createApprovalStore } from "../src/approvals/store";
import { TOOL_DISABLED } from "../src/approvals/policy";
import {
  type ApprovalCandidate,
  ApprovalRefusedError,
} from "../src/approvals/types";
import { createAdminScope } from "../src/auth/admin-scope";
import { createRoleRepository } from "../src/auth/guards";
import { setRole } from "../src/auth/roles";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  agentSecuritySettings,
  approvalRules,
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
/** Somebody who uses the owner's team Bot (SEC1 D9). */
const member = `${prefix}-member`;
const teamBot = `${prefix}-team-bot`;
const privateBot = `${prefix}-private-bot`;
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
      context.set("actor", { id: admin, email: `${admin}@example.test`, role: "admin" });
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
      { id: member, email: `${member}@example.test` },
    ]);
    // A team Bot (stamped `team`, its profile naming the owner) and one of the owner's private Bots.
    await database.insert(agents).values([
      { id: teamBot, tenantId: "team", name: "Desk", type: "built_in", configuration: {} },
      { id: privateBot, tenantId: owner, name: "Desk", type: "built_in", configuration: {} },
    ]);
    await database.insert(agentProfiles).values([
      {
        agentId: teamBot,
        tenantId: "team",
        ownerUserId: owner,
        title: "Desk",
        roleDescription: "Shared desk.",
        avatarSeed: "seed",
        visibility: "public",
      },
      {
        agentId: privateBot,
        tenantId: owner,
        ownerUserId: owner,
        title: "Desk",
        roleDescription: "Private desk.",
        avatarSeed: "seed",
        visibility: "private",
      },
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
    await database
      .delete(agents)
      .where(inArray(agents.id, [teamBot, privateBot]));
    await database
      .delete(users)
      .where(inArray(users.id, [owner, admin, member]));
  });
  await releaseRoleWriter?.();
  await database.$client.close();
});

function candidate(over: Partial<ApprovalCandidate> = {}): ApprovalCandidate {
  const toolCallId = randomUUID();
  return {
    actorId: owner,
    botId: `${prefix}-bot`,
    // An ordinary change: sending, deleting, sharing and publishing ask whatever the rules say.
    toolRef: "mcp/gmail/create_label",
    effect: "write",
    scope: "gmail",
    args: { name: "Receipts" },
    continuation: {
      runId: randomUUID(),
      // Its own conversation, so earlier answers in this file do not apply to it.
      threadId: `${prefix}-thread-${toolCallId}`,
      toolCallId,
      toolName: "mcp/gmail/create_label",
      args: { name: "Receipts" },
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
      toolRef: "mcp/gmail/create_*",
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
    const first = candidate({ toolRef: "mcp/drive/rename_file", scope: "drive" });
    expect(await suspends(service.gate(first))).toBeTrue();
    const [request] = (await store.list(owner)).filter(
      (row) => row.action.toolCallId === first.continuation?.toolCallId,
    );
    expect(request?.action.policy?.behaviour).toBe("ask");
    await service.decide(owner, request?.id as string, "allow_always");
    const rules = await store.rules(owner);
    expect(rules).toContainEqual(
      expect.objectContaining({
        toolRef: "mcp/drive/rename_file",
        behaviour: "allow",
      }),
    );
    await expect(
      service.gate(candidate({ toolRef: "mcp/drive/rename_file", scope: "drive" })),
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

/*
 * SEC1 (docs/specs/2026-11-02-sec1-employee-tool-permissions.md §6.2), against real tables and row
 * security: the owner's rules and floors bind another person using the owner's Bot, read in the
 * owner's frame, and the member never reads the owner's rows themselves.
 */
const asMember = <T>(work: () => Promise<T>) => runAsTenant(member, work);
const memberCall = (over: Partial<ApprovalCandidate> = {}) =>
  candidate({ actorId: member, botId: teamBot, ...over });
const runCommand = (command: string, over: Partial<ApprovalCandidate> = {}) =>
  candidate({
    botId: privateBot,
    toolRef: "computer_run_command",
    scope: "workspace",
    args: { command },
    ...over,
  });

test("SEC1: a member using the owner's Bot is refused a tool the owner disabled, and the trail names the owner's layer", async () => {
  const disabled = await asOwner(() =>
    service.createRule(owner, {
      botId: teamBot,
      toolRef: "mcp/linear/create_issue",
      effect: "*",
      scope: "*",
      behaviour: "deny",
    }),
  );
  expect(disabled.behaviour).toBe("deny");
  const call = memberCall({ toolRef: "mcp/linear/create_issue", scope: "linear" });
  const refused = await asMember(() => service.gate(call)).catch(
    (error: unknown) => error,
  );
  expect(refused).toBeInstanceOf(ApprovalRefusedError);
  expect((refused as Error).message).toBe(TOOL_DISABLED);
  // Refused, not asked: nothing waits for anybody.
  expect(await asMember(() => store.list(member))).toEqual([]);
  const trail = await asMember(() =>
    database
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.actorUserId, member),
          eq(auditEvents.eventType, "approval.evaluated"),
        ),
      ),
  );
  expect(trail).toContainEqual(
    expect.objectContaining({
      payload: expect.objectContaining({
        bot: teamBot,
        tool: "mcp/linear/create_issue",
        outcome: expect.objectContaining({
          behaviour: "deny",
          source: "owner_rule",
          ruleId: disabled.id,
        }),
      }),
    }),
  );
  // The owner's own call is refused by the same rule, as theirs.
  await expect(
    asOwner(() =>
      service.gate(candidate({ botId: teamBot, toolRef: "mcp/linear/create_issue" })),
    ),
  ).rejects.toThrow(TOOL_DISABLED);
  // The member never read the owner's rule: their own frame still cannot see it.
  expect(
    await asMember(() =>
      database
        .select()
        .from(approvalRules)
        .where(eq(approvalRules.id, disabled.id)),
    ),
  ).toEqual([]);
  // A rule the owner saved for another Bot does not reach this one.
  await expect(
    asMember(() =>
      service.gate(memberCall({ botId: privateBot, toolRef: "mcp/linear/create_issue" })),
    ),
  ).resolves.toBeUndefined();
});

test("SEC1: the owner's floors bind a member, and only the owner can change them", async () => {
  const readsEnv = memberCall({
    toolRef: "computer_read_file",
    effect: "read",
    scope: "workspace",
    args: {},
    target: { filePath: ".env" },
  });
  expect(await suspends(asMember(() => service.gate(readsEnv)))).toBeTrue();
  // The member cannot switch the owner's floor off: the database refuses the row.
  await expect(
    asMember(() =>
      store.policy?.setEmployeeSecurity?.(member, teamBot, {
        sensitivePaths: "off",
      }) as Promise<unknown>,
    ),
  ).rejects.toMatchObject({
    cause: expect.objectContaining({
      message: expect.stringContaining("row-level security"),
    }),
  });
  // The owner can, in their own frame, and the member's next read goes through.
  await asOwner(
    () =>
      store.policy?.setEmployeeSecurity?.(owner, teamBot, {
        sensitivePaths: "off",
      }) as Promise<unknown>,
  );
  await expect(
    asMember(() => service.gate(memberCall({ ...readsEnv, continuation: candidate().continuation }))),
  ).resolves.toBeUndefined();
  expect(
    await asMember(() => database.select().from(agentSecuritySettings)),
  ).toEqual([]);
  await asOwner(
    () =>
      store.policy?.setEmployeeSecurity?.(owner, teamBot, {
        sensitivePaths: "ask",
      }) as Promise<unknown>,
  );
});

test("SEC1: with the team switch on, a dangerous command still asks after the Bot's own switch was turned off (D10)", async () => {
  await asOwner(
    () =>
      store.policy?.setEmployeeSecurity?.(owner, privateBot, {
        dangerousCommands: "off",
      }) as Promise<unknown>,
  );
  await expect(
    asOwner(() => service.gate(runCommand("rm -rf build"))),
  ).resolves.toBeUndefined();
  await asTeam(() =>
    service.setTeamSettings(admin, { enforceDangerousCommands: true }),
  );
  try {
    const dangerous = runCommand("rm -rf build");
    expect(await suspends(asOwner(() => service.gate(dangerous)))).toBeTrue();
    const [request] = (await asOwner(() => store.list(owner))).filter(
      (row) => row.action.toolCallId === dangerous.continuation?.toolCallId,
    );
    expect(request?.action.policy).toMatchObject({
      behaviour: "ask",
      source: "dangerous_command",
    });
    // A harmless command is not caught by the switch.
    await expect(
      asOwner(() => service.gate(runCommand("ls -la"))),
    ).resolves.toBeUndefined();
    expect(
      (await asOwner(() => service.inbox(owner))).team,
    ).toMatchObject({ enforceDangerousCommands: true });
  } finally {
    await asTeam(() =>
      service.setTeamSettings(admin, { enforceDangerousCommands: false }),
    );
  }
});

test("SEC1: a deny rule is saved and read back beside the four behaviours rows always had", () =>
  asOwner(async () => {
    const saved = [];
    for (const behaviour of ["allow", "pre_approved", "ask", "hand_off", "deny"] as const)
      saved.push(
        await service.createRule(owner, {
          botId: privateBot,
          toolRef: `mcp/readback/${behaviour}`,
          effect: "*",
          scope: "*",
          behaviour,
        }),
      );
    const rules = await store.rules(owner);
    for (const rule of saved)
      expect(rules).toContainEqual(
        expect.objectContaining({ id: rule.id, behaviour: rule.behaviour }),
      );
    await expect(
      service.gate(candidate({ botId: privateBot, toolRef: "mcp/readback/deny" })),
    ).rejects.toThrow(TOOL_DISABLED);
  }));
