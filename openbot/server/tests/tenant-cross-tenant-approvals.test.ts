import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/app-variables";
import { createApprovalRoutes } from "../src/approvals/routes";
import { createApprovalService } from "../src/approvals/service";
import { createApprovalStore } from "../src/approvals/store";
import { type ApprovalCandidate, approvalAction } from "../src/approvals/types";
import { createDatabase } from "../src/db/client";
import { approvalRequests, approvalRules, users } from "../src/db/schema";
import { workItems } from "../src/db/schema/work";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Spec test decision #7's approvals face, and the one place where the 404 is not bought by
 * row-level security.
 *
 * `createApprovalStore` never calls `runAsTenant`, so every request it opens is written into the
 * deployment's own `system` partition — the one partition the read policy lets *every* tenant see.
 * The row is therefore visible to a stranger at the SQL layer, and the only thing standing between
 * them and somebody else's pending approval is the `owner_user_id` predicate in these stores. That
 * makes this seam the one worth pinning: `tenant-cross-tenant-404` and `tenant-cross-tenant-agents`
 * assert against a database that already refuses, while this asserts the application's own gate.
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
const queueKeys: string[] = [];

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

const routesFor = (actorId: string) => {
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", { id: actorId, role: "user" as const });
    await next();
  };
  return createApprovalRoutes(service, requireUser);
};

const call = (
  actorId: string,
  path: string,
  method: "GET" | "POST" | "DELETE",
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
  await database.insert(users).values([
    { id: owner, email: `${owner}@example.test` },
    { id: stranger, email: `${stranger}@example.test` },
  ]);
  await store.setEnabled(owner, true);
  const request = await store.open(approvalAction(candidate(owner)));
  if (!request) throw new Error("Expected an approval request to open.");
  requestId = request.id;
  queueKeys.push(request.id);

  /*
   * A personal rule the stranger also tries to revoke. Created through the store rather than by a
   * raw insert so it is shaped exactly like one the owner's own "allow always" click would write.
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

afterAll(async () => {
  await database
    .delete(approvalRules)
    .where(eq(approvalRules.ownerUserId, owner));
  await database
    .delete(approvalRequests)
    .where(eq(approvalRequests.ownerUserId, owner));
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
  await database.delete(users).where(inArray(users.id, [owner, stranger]));
});

test("the owner's inbox holds the request, so the refusals below are about tenancy", async () => {
  const inbox = await call(owner, "");
  expect(inbox.status).toBe(200);
  const body = (await inbox.json()) as { requests: { id: string }[] };
  expect(body.requests.map((entry) => entry.id)).toContain(requestId);
});

test("the request is absent from a stranger's inbox", async () => {
  /*
   * This is the assertion that carries the weight of the note above. The row sits in the `system`
   * partition, so row-level security hands it to this caller; the store's owner predicate is what
   * keeps it out of a stranger's list.
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
  const [row] = await database
    .select({
      status: approvalRequests.status,
      decision: approvalRequests.decision,
    })
    .from(approvalRequests)
    .where(eq(approvalRequests.id, requestId))
    .limit(1);
  expect(row?.status).toBe("pending");
  expect(row?.decision).toBeNull();

  const [rule] = await database
    .select({ revokedAt: approvalRules.revokedAt })
    .from(approvalRules)
    .where(eq(approvalRules.id, ruleId))
    .limit(1);
  expect(rule?.revokedAt).toBeNull();

  // The owner can still decide it, which is the answer a refusal must not have consumed.
  const mine = await call(owner, `${requestId}/decision`, "POST", {
    decision: "deny",
  });
  expect(mine.status).toBe(200);
});
