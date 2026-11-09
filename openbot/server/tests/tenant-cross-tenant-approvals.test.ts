import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createApprovalRoutes } from "../src/approvals/routes";
import { createApprovalService } from "../src/approvals/service";
import { createApprovalStore } from "../src/approvals/store";
import {
  type ApprovalCandidate,
  ApprovalNotFoundError,
  approvalAction,
} from "../src/approvals/types";
import { createAdminScope } from "../src/auth/admin-scope";
import {
  createDevRequireUser,
  DEV_ACTOR,
  initializeDevActorUser,
  seedDevActorRole,
} from "../src/auth/dev-actor";
import { createRoleRepository } from "../src/auth/guards";
import { setRole } from "../src/auth/roles";
import { HeadlessToolSuspension } from "../src/computer/headless-tools";
import { createDatabase } from "../src/db/client";
import {
  approvalRequests,
  approvalRules,
  approvalTeamRules,
  userRoles,
  users,
} from "../src/db/schema";
import { TEAM_TENANT } from "../src/db/schema/tenant";
import { workItems } from "../src/db/schema/work";
import { asPlatform, runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { bindTestRoleWriter } from "./support/role-writer";

/**
 * Spec test decision #7's approvals face.
 *
 * `createApprovalStore` never calls `runAsTenant` itself: it writes in whatever frame its caller
 * runs, and the request guard frames every request as the signed-in person (as the stub guard below
 * does). Besides the row-level security that keeps the owner's rows in her own tenant, the
 * `owner_user_id` predicate in these stores is the application's own gate; the store and the routes
 * must refuse a stranger whichever of the two would have caught it.
 *
 * The deciding is the damage case. Approving or denying a request resumes a paused run, so a refusal
 * that answered 404 and still moved the row would be a stranger executing work in another workspace
 * while being told their request did not land. The last test reads the status back for exactly that.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createApprovalStore(database);
const service = createApprovalService(store);
const suite = randomUUID().slice(0, 8);
const owner = `approval-tenant-${suite}-owner`;
const stranger = `approval-tenant-${suite}-stranger`;
/** Two administrators: team rules are the team's, so the second can change what the first made. */
const adminA = `approval-tenant-${suite}-admin-a`;
const adminB = `approval-tenant-${suite}-admin-b`;
const people = [owner, stranger, adminA, adminB];
const roleRepository = createRoleRepository(database);
const scope = createAdminScope({ roleRepository });
const queueKeys: string[] = [];
let releaseRoleWriter: (() => Promise<void>) | undefined;

function candidate(actorId: string): ApprovalCandidate {
  return {
    actorId,
    botId: `${suite}-bot`,
    toolRef: "computer_write_file",
    effect: "write",
    scope: "project",
    args: { path: "notes.txt", contents: "saved" },
    target: { filePath: "project/notes.txt" },
    continuation: {
      runId: randomUUID(),
      threadId: `${suite}-thread`,
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

/**
 * The routes as production mounts them: the request guard frames the request as the signed-in
 * person, and the team routes pass through `adminCapability`, which re-reads `user_roles`.
 */
const routesFor = (actorId: string) => {
  const role = actorId === adminA || actorId === adminB ? "admin" : "user";
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", { id: actorId, email: `${actorId}@example.test`, role });
    await runAsTenant(actorId, () => next());
  };
  return createApprovalRoutes(service, requireUser, scope.adminCapability);
};

const call = (
  actorId: string,
  path: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  body?: unknown,
) =>
  routesFor(actorId).request(
    new Request(`http://openbot.test/${path}`, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
    }),
  );

let requestId = "";
let ruleId = "";

beforeAll(async () => {
  releaseRoleWriter = await bindTestRoleWriter(database);
  // Several people's rows in one statement: a fixture across tenants, so the platform's frame.
  await runAsTenant("platform", () =>
    database
      .insert(users)
      .values(people.map((id) => ({ id, email: `${id}@example.test` }))),
  );
  // Role facts belong to no tenant: written as `platform`.
  for (const id of [adminA, adminB])
    await asPlatform(() => setRole(database, id, "admin"));
  // The owner's own request and rule, written in her frame as her requests write them.
  await runAsTenant(owner, async () => {
    await store.setEnabled(owner, true);
    const request = await store.open(approvalAction(candidate(owner)));
    if (!request) throw new Error("Expected an approval request to open.");
    requestId = request.id;
    queueKeys.push(request.id);

    /*
     * A personal rule the stranger also tries to revoke. Shaped exactly like one the owner's own
     * "allow always" click would write.
     */
    const [rule] = await database
      .insert(approvalRules)
      .values({
        id: randomUUID(),
        ownerUserId: owner,
        botId: `${suite}-bot`,
        toolRef: "computer_write_file",
        effect: "write",
        scope: "project",
      })
      .returning({ id: approvalRules.id });
    ruleId = rule!.id;
  });
});

afterAll(async () => {
  // Cleanup reaches whichever partition the fixture landed in, and several people's rows: the platform.
  await runAsTenant("platform", async () => {
    await database
      .delete(approvalTeamRules)
      .where(eq(approvalTeamRules.botId, `${suite}-bot`));
    await database
      .delete(approvalRules)
      .where(eq(approvalRules.ownerUserId, owner));
    await database
      .delete(approvalRequests)
      .where(inArray(approvalRequests.ownerUserId, [owner, stranger]));
    if (queueKeys.length) {
      await database
        .delete(workItems)
        .where(
          and(
            eq(workItems.kind, "approval.resume"),
            inArray(workItems.key, queueKeys),
          ),
        );
    }
    // `user_roles` follows its user by cascade.
    await database.delete(users).where(inArray(users.id, people));
  });
  await releaseRoleWriter?.();
});

test("the owner's inbox holds the request, so the refusals below are about tenancy", async () => {
  const inbox = await call(owner, "");
  expect(inbox.status).toBe(200);
  const body = (await inbox.json()) as { requests: { id: string }[] };
  expect(body.requests.map((entry) => entry.id)).toContain(requestId);
});

test("the request is absent from a stranger's inbox", async () => {
  /*
   * The row sits in the owner's tenant, so row-level security keeps it from this caller; the store's
   * owner predicate would keep it out of a stranger's list even where the database did not.
   */
  const inbox = await call(stranger, "");
  expect(inbox.status).toBe(200);
  const body = (await inbox.json()) as { requests: { id: string }[] };
  expect(body.requests.map((entry) => entry.id)).not.toContain(requestId);
});

test("a stranger's decision on that request is a 404, and their rule revoke is a 404", async () => {
  const deny = await call(stranger, `${requestId}/decision`, "POST", {
    decision: "deny",
  });
  expect(deny.status).toBe(404);

  const revoke = await call(stranger, `rules/${ruleId}`, "DELETE");
  expect(revoke.status).toBe(404);
});

test("nothing moved: the request is still pending and the rule is still granted", async () => {
  const [row] = await runAsTenant(owner, () =>
    database
      .select({
        status: approvalRequests.status,
        decision: approvalRequests.decision,
      })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, requestId))
      .limit(1),
  );
  expect(row?.status).toBe("pending");
  expect(row?.decision).toBeNull();

  const [rule] = await runAsTenant(owner, () =>
    database
      .select({ revokedAt: approvalRules.revokedAt })
      .from(approvalRules)
      .where(eq(approvalRules.id, ruleId))
      .limit(1),
  );
  expect(rule?.revokedAt).toBeNull();

  // The owner can still decide it, which is the answer a refusal must not have consumed.
  const mine = await call(owner, `${requestId}/decision`, "POST", {
    decision: "deny",
  });
  expect(mine.status).toBe(200);
});

/*
 * Team approval rules ("team-rules", G01-E P6a). A team rule is the team's, not its author's: it is
 * stamped `team` from the admin's own frame, every member's gate reads it, any admin holding the
 * capability changes it, and nobody else writes it.
 */
const teamTool = `${suite}-team-tool`;
let teamRuleId = "";

/** A headless (routine-started) action by `actorId`: a rule that asks suspends it. */
function headless(actorId: string): ApprovalCandidate {
  const base = candidate(actorId);
  return {
    ...base,
    toolRef: teamTool,
    effect: "write",
    scope: "project",
    continuation: {
      ...base.continuation!,
      // Its own conversation, so an earlier answer in this file does not apply to it.
      threadId: `${suite}-thread-${randomUUID()}`,
      toolName: teamTool,
      initiator: { kind: "routine", id: `${suite}-routine` },
    },
  };
}

const suspends = (promise: Promise<unknown>) =>
  promise.then(
    () => false,
    (error: unknown) => error instanceof HeadlessToolSuspension,
  );

/** The database's refusal, not some other failure: the error (or the driver's cause) names RLS. */
async function refusedByRls(work: Promise<unknown>) {
  const error = await work.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(error).toBeInstanceOf(Error);
  const { message, cause } = error as Error & { cause?: unknown };
  expect(`${message} ${String(cause)}`).toContain("row-level security");
}

const teamRuleRow = (frame: string) =>
  runAsTenant(frame, () =>
    database
      .select({
        tenantId: approvalTeamRules.tenantId,
        behaviour: approvalTeamRules.behaviour,
        revokedAt: approvalTeamRules.revokedAt,
      })
      .from(approvalTeamRules)
      .where(eq(approvalTeamRules.id, teamRuleId)),
  );

test("admin A's team rule is stamped `team`, and member M's frame reads and applies it", async () => {
  // Before the rule, M's headless action is allowed (M never switched "ask before changes" on).
  expect(
    await suspends(
      runAsTenant(stranger, () => service.gate(headless(stranger))),
    ),
  ).toBeFalse();

  const created = await call(adminA, "team/rules", "POST", {
    botId: `${suite}-bot`,
    toolRef: teamTool,
    effect: "*",
    scope: "*",
    behaviour: "ask",
  });
  expect(created.status).toBe(201);
  teamRuleId = ((await created.json()) as { rule: { id: string } }).rule.id;

  const seen = await runAsTenant(stranger, () => store.policy!.teamRules());
  expect(seen.map((rule) => rule.id)).toContain(teamRuleId);
  // ...and through the member's own inbox, as the locked rows they are shown.
  const inbox = await call(stranger, "");
  expect(inbox.status).toBe(200);
  const body = (await inbox.json()) as { teamRules: { id: string }[] };
  expect(body.teamRules.map((rule) => rule.id)).toContain(teamRuleId);

  expect(
    await suspends(
      runAsTenant(stranger, () => service.gate(headless(stranger))),
    ),
  ).toBeTrue();
});

test("the platform frame sees the rule stamped `team`; the `system` frame sees nothing", async () => {
  expect(await teamRuleRow("platform")).toEqual([
    { tenantId: TEAM_TENANT, behaviour: "ask", revokedAt: null },
  ]);
  expect(await teamRuleRow("system")).toEqual([]);
  // Nor is it the author's private row: it reads the same from the author's frame as from M's.
  expect((await teamRuleRow(adminA))[0]?.tenantId).toBe(TEAM_TENANT);
});

test("a member cannot write team rules: 403 at the route, refused by the database underneath", async () => {
  const route = await call(stranger, "team/rules", "POST", {
    toolRef: teamTool,
    behaviour: "allow",
  });
  expect(route.status).toBe(403);
  const change = await call(stranger, `team/rules/${teamRuleId}`, "PATCH", {
    behaviour: "allow",
  });
  expect(change.status).toBe(403);

  // Straight past the route, in the member's own frame.
  await refusedByRls(
    runAsTenant(stranger, async () => {
      await database.insert(approvalTeamRules).values({
        id: `${suite}-member-rule`,
        tenantId: TEAM_TENANT,
        botId: `${suite}-bot`,
        toolRef: teamTool,
        effect: "*",
        scope: "*",
        behaviour: "allow",
      });
    }),
  );
  await expect(
    runAsTenant(stranger, () =>
      store.policy!.updateTeamRule(stranger, teamRuleId, {
        behaviour: "allow",
      }),
    ),
  ).rejects.toBeInstanceOf(ApprovalNotFoundError);
  await expect(
    runAsTenant(stranger, () =>
      store.policy!.revokeTeamRule(stranger, teamRuleId),
    ),
  ).rejects.toBeInstanceOf(ApprovalNotFoundError);
  expect(await teamRuleRow("platform")).toEqual([
    { tenantId: TEAM_TENANT, behaviour: "ask", revokedAt: null },
  ]);
});

test("an admin without the capability — a routine's frame — writes no team rule", async () => {
  await refusedByRls(
    runAsTenant(adminB, () =>
      store.policy!.createTeamRule(adminB, {
        botId: `${suite}-bot`,
        toolRef: teamTool,
        effect: "*",
        scope: "*",
        behaviour: "allow",
      }),
    ),
  );
  await expect(
    runAsTenant(adminB, () =>
      store.policy!.updateTeamRule(adminB, teamRuleId, { behaviour: "allow" }),
    ),
  ).rejects.toBeInstanceOf(ApprovalNotFoundError);
  await expect(
    runAsTenant(adminB, () => store.policy!.revokeTeamRule(adminB, teamRuleId)),
  ).rejects.toBeInstanceOf(ApprovalNotFoundError);
  const rows = await asPlatform(() =>
    database
      .select({ id: approvalTeamRules.id })
      .from(approvalTeamRules)
      .where(eq(approvalTeamRules.botId, `${suite}-bot`)),
  );
  expect(rows.map((row) => row.id)).toEqual([teamRuleId]);
  expect((await teamRuleRow("platform"))[0]?.behaviour).toBe("ask");
});

test("an admin with the capability cannot re-stamp a team rule into their own tenant", async () => {
  // A route the way production builds one: signed in, framed, and through `adminCapability`.
  let outcome: unknown = "not run";
  const restamp = createApprovalRoutes(
    service,
    async (context, next) => {
      context.set("actor", { id: adminA, email: `${adminA}@example.test`, role: "admin" });
      await runAsTenant(adminA, () => next());
    },
    scope.adminCapability,
  );
  restamp.post("/team/restamp", async (context) => {
    outcome = await database
      .update(approvalTeamRules)
      .set({ tenantId: adminA })
      .where(eq(approvalTeamRules.id, teamRuleId))
      .then(
        () => "updated",
        (error: unknown) => error,
      );
    return context.json({});
  });
  expect(
    (
      await restamp.request(
        new Request("http://openbot.test/team/restamp", { method: "POST" }),
      )
    ).status,
  ).toBe(200);
  expect(outcome).toBeInstanceOf(Error);
  expect(
    String((outcome as Error & { cause?: unknown }).cause ?? outcome),
  ).toContain("fixed");
  expect((await teamRuleRow("platform"))[0]?.tenantId).toBe(TEAM_TENANT);
});

test("admin B changes and revokes the rule admin A made, and M's gate follows", async () => {
  const changed = await call(adminB, `team/rules/${teamRuleId}`, "PATCH", {
    behaviour: "allow",
  });
  expect(changed.status).toBe(200);
  expect((await teamRuleRow("platform"))[0]?.behaviour).toBe("allow");
  expect(
    await suspends(
      runAsTenant(stranger, () => service.gate(headless(stranger))),
    ),
  ).toBeFalse();

  await call(adminB, `team/rules/${teamRuleId}`, "PATCH", {
    behaviour: "ask",
  });
  expect(
    await suspends(
      runAsTenant(stranger, () => service.gate(headless(stranger))),
    ),
  ).toBeTrue();

  const revoked = await call(adminB, `team/rules/${teamRuleId}`, "DELETE");
  expect(revoked.status).toBe(200);
  expect((await teamRuleRow("platform"))[0]?.revokedAt).not.toBeNull();
  expect(
    (await runAsTenant(stranger, () => store.policy!.teamRules())).map(
      (rule) => rule.id,
    ),
  ).not.toContain(teamRuleId);
  expect(
    await suspends(
      runAsTenant(stranger, () => service.gate(headless(stranger))),
    ),
  ).toBeFalse();
});

test("the single-user actor holds its admin role in `user_roles`, so it can change team settings and rules", async () => {
  // As src/index.ts boots a single-user deployment: the user row, then its role, with no frame
  // around either (each opens its own `platform` frame).
  expect(await initializeDevActorUser(database, true)).toBe(true);
  expect(await seedDevActorRole(database, true)).toBe(true);
  // Idempotent: every start runs it again.
  expect(await seedDevActorRole(database, true)).toBe(true);
  expect(await seedDevActorRole(database, false)).toBe(false);
  expect(
    await asPlatform(() =>
      database
        .select({ role: userRoles.role })
        .from(userRoles)
        .where(eq(userRoles.userId, DEV_ACTOR.id)),
    ),
  ).toEqual([{ role: "admin" }]);

  // The routes as a single-user deployment mounts them.
  const routes = createApprovalRoutes(
    service,
    createDevRequireUser(),
    scope.adminCapability,
  );
  const send = (path: string, method: "POST" | "PATCH", body: unknown) =>
    routes.request(
      new Request(`http://openbot.test/${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  // The settings row is shared by every suite: written back unchanged, which still goes through
  // the `team` insert-or-update that row-level security has to admit.
  const before = await runAsTenant(DEV_ACTOR.id, () =>
    store.policy!.teamSettings(),
  );
  const settings = await send("team", "PATCH", {
    enforceAutoReview: before.enforceAutoReview,
    customRulesEnabled: before.customRulesEnabled,
    hostCommandsCap: before.hostCommandsCap,
  });
  expect(settings.status).toBe(200);

  const created = await send("team/rules", "POST", {
    botId: `${suite}-bot`,
    toolRef: `${suite}-single-user-tool`,
    behaviour: "ask",
  });
  expect(created.status).toBe(201);
  const { rule } = (await created.json()) as { rule: { id: string } };
  expect(
    await asPlatform(() =>
      database
        .select({ tenantId: approvalTeamRules.tenantId })
        .from(approvalTeamRules)
        .where(eq(approvalTeamRules.id, rule.id)),
    ),
  ).toEqual([{ tenantId: TEAM_TENANT }]);
});

test("an admin the database does not know as one gets 403 on a team write, not a 500 echoing the SQL", async () => {
  // A session that says "admin" with no `user_roles` row: the guard admits it, the capability is
  // not granted, and row-level security refuses the insert.
  const routes = createApprovalRoutes(
    service,
    async (context, next) => {
      context.set("actor", { id: stranger, email: `${stranger}@example.test`, role: "admin" });
      await runAsTenant(stranger, () => next());
    },
    scope.adminCapability,
  );
  for (const [path, method, body] of [
    ["team/rules", "POST", { toolRef: teamTool, behaviour: "allow" }],
    ["team", "PATCH", { enforceAutoReview: true }],
  ] as const) {
    const response = await routes.request(
      new Request(`http://openbot.test/${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    expect(response.status).toBe(403);
    const text = await response.text();
    expect(text).not.toContain("insert");
    expect(text).not.toContain("approval_team");
  }
  const rows = await asPlatform(() =>
    database
      .select({ id: approvalTeamRules.id })
      .from(approvalTeamRules)
      .where(
        and(
          eq(approvalTeamRules.botId, "*"),
          eq(approvalTeamRules.toolRef, teamTool),
        ),
      ),
  );
  expect(rows).toEqual([]);
});
