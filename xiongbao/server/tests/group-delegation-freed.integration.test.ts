import { afterAll, afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import {
  DELEGATE_EFFECT,
  delegationFreed,
  HANDOFF_REF,
} from "../src/approvals/delegation-freed";
import type { ApprovalAction } from "../src/approvals/types";
import { createDatabase } from "../src/db/client";
import { approvalConversationGrants } from "../src/db/schema/approval-conversation-grants";
import {
  approvalRequests,
  approvalRules,
  approvalTeamRules,
} from "../src/db/schema/approvals";
import { users } from "../src/db/schema/core";
import { TEAM_TENANT } from "../src/db/schema/tenant";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * What a group turn's framing reads before it tells a Bot whether `message_bot` reaches a peer:
 * the person's own "Allow for this conversation" answers, and saved rules. Read from the rows the
 * gate reads, so the sentence and the permit cannot disagree about a peer the person allowed
 * (2026-11-16, L4-3: a hop the framing promised would never be sent arrived).
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `freed-${randomUUID()}`;
const people: string[] = [];
const teamRules: string[] = [];

afterEach(async () => {
  await runAsTenant("platform", async () => {
    for (const id of people.splice(0)) {
      await runAsTenant(id, async () => {
        await database
          .delete(approvalConversationGrants)
          .where(eq(approvalConversationGrants.ownerUserId, id));
        await database
          .delete(approvalRequests)
          .where(eq(approvalRequests.ownerUserId, id));
        await database
          .delete(approvalRules)
          .where(eq(approvalRules.ownerUserId, id));
      });
      await database.delete(users).where(eq(users.id, id));
    }
    if (teamRules.length)
      await database
        .delete(approvalTeamRules)
        .where(inArray(approvalTeamRules.id, teamRules.splice(0)));
  });
});
afterAll(async () => {
  await database.$client.close();
});

async function person(): Promise<string> {
  const id = `${prefix}-user-${randomUUID()}`;
  await runAsTenant(id, () =>
    database
      .insert(users)
      .values({ id, email: `${id}@example.test`, name: "Freed Test" }),
  );
  people.push(id);
  return id;
}

/** One decided request, which a conversation answer hangs off. */
async function decidedRequest(
  owner: string,
  action: Partial<ApprovalAction> = {},
): Promise<string> {
  const id = `${prefix}-approval-${randomUUID()}`;
  const full = {
    actorId: owner,
    botId: "lead",
    toolRef: HANDOFF_REF,
    effect: DELEGATE_EFFECT,
    scope: "Grace",
    args: {},
    runId: `${prefix}-run`,
    threadId: `${prefix}-thread`,
    toolCallId: `${prefix}-call`,
    actionDigest: `${prefix}-digest`,
    ...action,
  } as ApprovalAction;
  await runAsTenant(owner, () =>
    database.insert(approvalRequests).values({
      id,
      ownerUserId: owner,
      runId: full.runId,
      toolCallId: full.toolCallId,
      actionDigest: full.actionDigest,
      action: full,
      status: "approved",
      decision: "allow_conversation",
    }),
  );
  return id;
}

test("a conversation answer frees exactly the peer it named", async () => {
  const owner = await person();
  const threadId = `${prefix}-thread`;
  const approvalId = await decidedRequest(owner, { threadId });
  await runAsTenant(owner, () =>
    database.insert(approvalConversationGrants).values({
      id: `${prefix}-grant-${randomUUID()}`,
      ownerUserId: owner,
      threadId,
      approvalId,
      botId: "lead",
      toolRef: HANDOFF_REF,
      effect: DELEGATE_EFFECT,
      scope: "Grace",
    }),
  );
  const freed = await runAsTenant(owner, () =>
    delegationFreed(database, {
      ownerUserId: owner,
      threadId,
      botId: "lead",
      peers: ["Grace", "Ops"],
    }),
  );
  expect([...freed]).toEqual(["Grace"]);
});

test("the answer belongs to its conversation, its Bot and its tool", async () => {
  const owner = await person();
  const threadId = `${prefix}-thread`;
  const approvalId = await decidedRequest(owner, { threadId });
  await runAsTenant(owner, () =>
    database.insert(approvalConversationGrants).values({
      id: `${prefix}-grant-${randomUUID()}`,
      ownerUserId: owner,
      threadId,
      approvalId,
      botId: "lead",
      toolRef: HANDOFF_REF,
      effect: DELEGATE_EFFECT,
      scope: "Grace",
    }),
  );
  const elsewhere = await runAsTenant(owner, () =>
    delegationFreed(database, {
      ownerUserId: owner,
      threadId: `${prefix}-another-thread`,
      botId: "lead",
      peers: ["Grace"],
    }),
  );
  const anotherBot = await runAsTenant(owner, () =>
    delegationFreed(database, {
      ownerUserId: owner,
      threadId,
      botId: "ops",
      peers: ["Grace"],
    }),
  );
  expect([...elsewhere]).toEqual([]);
  expect([...anotherBot]).toEqual([]);
});

test("a revoked answer frees nobody", async () => {
  const owner = await person();
  const threadId = `${prefix}-thread`;
  const approvalId = await decidedRequest(owner, { threadId });
  await runAsTenant(owner, () =>
    database.insert(approvalConversationGrants).values({
      id: `${prefix}-grant-${randomUUID()}`,
      ownerUserId: owner,
      threadId,
      approvalId,
      botId: "lead",
      toolRef: HANDOFF_REF,
      effect: DELEGATE_EFFECT,
      scope: "Grace",
      revokedAt: new Date(),
    }),
  );
  const freed = await runAsTenant(owner, () =>
    delegationFreed(database, {
      ownerUserId: owner,
      threadId,
      botId: "lead",
      peers: ["Grace"],
    }),
  );
  expect([...freed]).toEqual([]);
});

test("a saved allow rule and a team rule free the peers their scope names", async () => {
  const owner = await person();
  const teamRuleId = `${prefix}-team-${randomUUID()}`;
  // Remembered before the write: a row this frame may read is not one it can find again later.
  teamRules.push(teamRuleId);
  await runAsTenant(owner, async () => {
    await database.insert(approvalRules).values({
      id: `${prefix}-rule-${randomUUID()}`,
      ownerUserId: owner,
      botId: "*",
      toolRef: HANDOFF_REF,
      effect: DELEGATE_EFFECT,
      scope: "Ops",
      behaviour: "allow",
    });
  });
  // A `team` row is the workspace's, not this person's: its policy admits the platform frame.
  await runAsTenant("platform", () =>
    database.insert(approvalTeamRules).values({
      id: teamRuleId,
      // The team's own stamp (`TEAM_TENANT`), which is where a workspace-wide rule lives.
      tenantId: TEAM_TENANT,
      botId: "*",
      toolRef: "*",
      effect: DELEGATE_EFFECT,
      scope: "Grace",
      behaviour: "allow",
      createdBy: owner,
    }),
  );
  const freed = await runAsTenant(owner, () =>
    delegationFreed(database, {
      ownerUserId: owner,
      threadId: `${prefix}-thread`,
      botId: "lead",
      peers: ["Grace", "Ops", "Zoe"],
    }),
  );
  expect([...freed].sort()).toEqual(["Grace", "Ops"]);
});

test("a rule that asks, or was revoked, frees nobody", async () => {
  const owner = await person();
  await runAsTenant(owner, async () => {
    await database.insert(approvalRules).values({
      id: `${prefix}-rule-${randomUUID()}`,
      ownerUserId: owner,
      botId: "*",
      toolRef: HANDOFF_REF,
      effect: DELEGATE_EFFECT,
      scope: "Ops",
      behaviour: "ask",
    });
    await database.insert(approvalRules).values({
      id: `${prefix}-rule-${randomUUID()}`,
      ownerUserId: owner,
      botId: "*",
      toolRef: HANDOFF_REF,
      effect: DELEGATE_EFFECT,
      scope: "Grace",
      behaviour: "allow",
      revokedAt: new Date(),
    });
  });
  const freed = await runAsTenant(owner, () =>
    delegationFreed(database, {
      ownerUserId: owner,
      threadId: `${prefix}-thread`,
      botId: "lead",
      peers: ["Grace", "Ops"],
    }),
  );
  expect([...freed]).toEqual([]);
});
