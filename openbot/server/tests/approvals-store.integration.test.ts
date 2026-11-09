import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import type { AppVariables } from "../src/app-variables";
import { createApprovalService } from "../src/approvals/service";
import { createApprovalStore } from "../src/approvals/store";
import {
  type ApprovalCandidate,
  ApprovalNotFoundError,
  approvalAction,
} from "../src/approvals/types";
import { createAdminScope } from "../src/auth/admin-scope";
import { createRoleRepository } from "../src/auth/guards";
import { setRole } from "../src/auth/roles";
import { createDatabase } from "../src/db/client";
import { approvalTeamSettings } from "../src/db/schema/approvals";
import { auditEvents, users } from "../src/db/schema/core";
import { TEAM_TENANT } from "../src/db/schema/tenant";
import { workItems } from "../src/db/schema/work";
import { asPlatform, runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { bindTestRoleWriter } from "./support/role-writer";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `approval-${randomUUID()}`;
const owner = `${prefix}-owner`,
  stranger = `${prefix}-stranger`,
  adminA = `${prefix}-admin-a`,
  adminB = `${prefix}-admin-b`;
const people = [owner, stranger, adminA, adminB];
const scope = createAdminScope({
  roleRepository: createRoleRepository(database),
});
let releaseRoleWriter: (() => Promise<void>) | undefined;
/** The deployment's one team settings row as it was, restored afterwards. */
let priorTeam: typeof approvalTeamSettings.$inferSelect | undefined;
const store = createApprovalStore(database);
const keys: string[] = [];
// The owner's calls run in her own frame, as the request guard frames them. The user rows are
// identity rows, written and removed in the deployment's own (platform) frame.
const asOwner = <T>(work: () => Promise<T>) => runAsTenant(owner, work);
// The stranger's probes run as `platform`, which can see the owner's row: in the stranger's own frame
// row-level security would hide it, and "not found" would no longer prove the store's owner filter.
const asStranger = <T>(work: () => Promise<T>) => runAsTenant("platform", work);
beforeAll(async () => {
  releaseRoleWriter = await bindTestRoleWriter(database);
  await runAsTenant("platform", async () => {
    await database
      .insert(users)
      .values(people.map((id) => ({ id, email: `${id}@example.test` })));
    [priorTeam] = await database
      .select()
      .from(approvalTeamSettings)
      .where(eq(approvalTeamSettings.id, "team"));
  });
  for (const id of [adminA, adminB])
    await asPlatform(() => setRole(database, id, "admin"));
});
afterAll(async () => {
  if (keys.length)
    await runAsTenant(owner, () =>
      database
        .delete(workItems)
        .where(
          and(
            eq(workItems.kind, "approval.resume"),
            inArray(workItems.key, keys),
          ),
        ),
    );
  await runAsTenant("platform", async () => {
    await database
      .delete(approvalTeamSettings)
      .where(eq(approvalTeamSettings.id, "team"));
    if (priorTeam)
      await database.insert(approvalTeamSettings).values(priorTeam);
    // `user_roles` follows its user by cascade.
    await database.delete(users).where(inArray(users.id, people));
  });
  await releaseRoleWriter?.();
  await database.$client.close();
});
function candidate(scope = "project"): ApprovalCandidate {
  const runId = randomUUID();
  return {
    actorId: owner,
    botId: `${prefix}-bot`,
    toolRef: "computer_write_file",
    effect: "write",
    scope,
    args: { path: "notes.txt", contents: "saved" },
    target: { filePath: `${scope}/notes.txt` },
    continuation: {
      runId,
      threadId: `${prefix}-thread`,
      toolCallId: randomUUID(),
      toolName: "computer_write_file",
      args: { path: "notes.txt", contents: "saved" },
      messages: [],
      state: {},
      context: [],
      forwardedProps: {},
    },
  };
}
test("PostgreSQL stores one immutable owned request, one decision queue item and one atomic consumption", () =>
  asOwner(async () => {
    await store.setEnabled(owner, true);
    const action = approvalAction(candidate());
    const requests = await Promise.all([
      store.open(action),
      store.open(action),
    ]);
    const request = requests[0];
    if (!request) throw new Error("missing request");
    keys.push(request.id);
    expect(requests[1]?.id).toBe(request.id);
    await expect(
      asStranger(() => store.get(stranger, request.id)),
    ).rejects.toBeInstanceOf(ApprovalNotFoundError);
    await expect(
      asStranger(() => store.decide(stranger, request.id, "allow_once")),
    ).rejects.toBeInstanceOf(ApprovalNotFoundError);
    const choices = await Promise.allSettled([
      store.decide(owner, request.id, "allow_once"),
      store.decide(owner, request.id, "allow_once"),
    ]);
    expect(
      choices.filter((choice) => choice.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      await database
        .select()
        .from(workItems)
        .where(
          and(
            eq(workItems.kind, "approval.resume"),
            eq(workItems.key, request.id),
          ),
        ),
    ).toHaveLength(1);
    const consumed = await Promise.all([
      store.consume(owner, request.id, action.actionDigest),
      store.consume(owner, request.id, action.actionDigest),
    ]);
    expect(consumed.filter(Boolean)).toHaveLength(1);
    await store.saveResult(owner, request.id, { content: '{"saved":true}' });
    await store.finish(owner, request.id);
    const restarted = createApprovalService(createApprovalStore(database));
    expect(await restarted.gate({ ...action })).toMatchObject({
      replay: { saved: true },
    });
    await expect(
      store.open(
        approvalAction({ ...action, args: { path: "different.txt" } }),
      ),
    ).rejects.toThrow("changed");
  }));
test("PostgreSQL persistent permissions are exact, revocable and denied choices stay durable", () =>
  asOwner(async () => {
    const first = await store.open(approvalAction(candidate("persistent")));
    keys.push(first.id);
    await store.decide(owner, first.id, "allow_always");
    const subsequent = await store.open(
      approvalAction(candidate("persistent")),
    );
    keys.push(subsequent.id);
    expect(subsequent.status).toBe("approved");
    const elsewhere = await store.open(
      approvalAction(candidate("other-project")),
    );
    keys.push(elsewhere.id);
    expect(elsewhere.status).toBe("pending");
    const [rule] = await store.rules(owner);
    if (!rule) throw new Error("missing rule");
    await expect(
      asStranger(() => store.revoke(stranger, rule.id)),
    ).rejects.toBeInstanceOf(ApprovalNotFoundError);
    await store.revoke(owner, rule.id);
    expect(
      await store.consume(owner, subsequent.id, subsequent.action.actionDigest),
    ).toBe(false);
    const denied = await store.open(approvalAction(candidate("deny")));
    keys.push(denied.id);
    await store.decide(owner, denied.id, "deny");
    const restarted = createApprovalService(createApprovalStore(database));
    await expect(restarted.gate(denied.action)).rejects.toThrow("declined");
  }));

/**
 * `work` inside an admin request, the way the team-settings route runs it: framed as `id`, through
 * `adminCapability`, which re-reads `user_roles`. Errors come back out to the caller.
 */
async function asAdminRequest<T>(id: string, work: () => Promise<T>) {
  let outcome: { value: T } | { error: unknown } | undefined;
  const app = new Hono<{ Variables: AppVariables }>();
  app.use(
    "*",
    async (context, next) => {
      context.set("actor", { id, role: "admin" });
      await runAsTenant(id, () => next());
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
}

test("two admins save the one team settings row in turn; members read it and the trail names each admin", async () => {
  /*
   * The regression: the row used to be stamped with the first admin's tenant, so a second admin could
   * neither see it nor save over it (the primary key collided with a row RLS hid). It is the team's
   * now, written from each admin's own frame with the capability.
   */
  const first = await asAdminRequest(adminA, () =>
    store.policy!.setTeamSettings(adminA, { hostCommandsCap: "ask" }),
  );
  expect(first.hostCommandsCap).toBe("ask");
  const second = await asAdminRequest(adminB, () =>
    store.policy!.setTeamSettings(adminB, { enforceAutoReview: true }),
  );
  // B saw A's change and kept it.
  expect(second).toMatchObject({
    hostCommandsCap: "ask",
    enforceAutoReview: true,
  });
  expect(
    await runAsTenant(stranger, () => store.policy!.teamSettings()),
  ).toMatchObject({ hostCommandsCap: "ask", enforceAutoReview: true });

  const [row] = await asPlatform(() =>
    database
      .select({
        tenantId: approvalTeamSettings.tenantId,
        updatedBy: approvalTeamSettings.updatedBy,
      })
      .from(approvalTeamSettings)
      .where(eq(approvalTeamSettings.id, "team")),
  );
  expect(row).toEqual({ tenantId: TEAM_TENANT, updatedBy: adminB });

  // A member's save, and an admin's without the capability, change nothing.
  await expect(
    runAsTenant(stranger, () =>
      store.policy!.setTeamSettings(stranger, { hostCommandsCap: "allow" }),
    ),
  ).rejects.toThrow();
  await expect(
    runAsTenant(adminA, () =>
      store.policy!.setTeamSettings(adminA, { hostCommandsCap: "allow" }),
    ),
  ).rejects.toThrow();
  expect(
    await runAsTenant(stranger, () => store.policy!.teamSettings()),
  ).toMatchObject({ hostCommandsCap: "ask" });

  // Each admin's audit row is in that admin's own tenant, not the team's.
  const trail = await asPlatform(() =>
    database
      .select({
        tenantId: auditEvents.tenantId,
        actorUserId: auditEvents.actorUserId,
      })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.eventType, "approval.settings_changed"),
          inArray(auditEvents.actorUserId, [adminA, adminB, stranger]),
        ),
      )
      .orderBy(desc(auditEvents.createdAt)),
  );
  expect(trail).toHaveLength(2);
  expect(trail).toEqual(
    expect.arrayContaining([
      { tenantId: adminA, actorUserId: adminA },
      { tenantId: adminB, actorUserId: adminB },
    ]),
  );
});
