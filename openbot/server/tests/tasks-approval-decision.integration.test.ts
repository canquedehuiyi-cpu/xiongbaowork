import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { createApprovalRoutes } from "../src/approvals/routes";
import { createApprovalService } from "../src/approvals/service";
import { createApprovalStore } from "../src/approvals/store";
import { approvalAction } from "../src/approvals/types";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import { approvalRequests, tasks, users } from "../src/db/schema";
import { workItems } from "../src/db/schema/work";
import { createTaskProjector } from "../src/tasks/projector";
import { createTaskRoutes } from "../src/tasks/routes";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Spec A8, server half: the board's 批准/拒绝 is the existing `POST /api/approvals/:id/decision`, and the
 * card it answers moves -- allow → `running`, deny → `failed` -- read back through the board's own list
 * route, which is what the screen refetches after the decision.
 *
 * Everything runs in the approval row's tenant frame, the way a signed-in request does
 * (`auth/guards.ts` wraps the handler in `runAsTenant(session.user.id)`): the request is opened inside
 * the frame, so the row's `tenant_id` is the owner's own tenant rather than `system`, and row-level
 * security is answering the reads, not the test's goodwill. Another tenant, in ITS frame, gets the 404
 * and the owner's card does not move.
 *
 * The approval store projects its decision onto the board without awaiting it (`approvals/store.ts`),
 * so the board is read until it shows the decision, within a bound -- the assertion still runs on what
 * it finally says.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const projector = createTaskProjector(database);
const store = createApprovalStore(database, projector);
const service = createApprovalService(store);
const suite = randomUUID().slice(0, 8);
const owner = `board-approval-${suite}-owner`;
const stranger = `board-approval-${suite}-stranger`;
const approvalIds: string[] = [];

const actorFor =
  (id: string): MiddlewareHandler<{ Variables: AppVariables }> =>
  async (context, next) => {
    context.set("actor", {
      id,
      email: `${id}@openbot.test`,
      role: "user",
    });
    await next();
  };

/** The two route trees a person's board touches, mounted as that person in that person's frame. */
const as = (tenant: string) => {
  const approvals = createApprovalRoutes(service, actorFor(tenant));
  const board = createTaskRoutes(database, actorFor(tenant), projector);
  return {
    decide: (approvalId: string, decision: string) =>
      runAsTenant(tenant, () =>
        approvals.request(
          new Request(
            `http://openbot.test/${encodeURIComponent(approvalId)}/decision`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ decision }),
            },
          ),
        ),
      ),
    cards: () =>
      runAsTenant(tenant, async () => {
        const response = await board.request(
          new Request("http://openbot.test/"),
        );
        expect(response.status).toBe(200);
        const body = (await response.json()) as {
          tasks: {
            id: string;
            status: string;
            pendingApprovalId: string | null;
          }[];
        };
        return body.tasks;
      }),
  };
};

const ownerSide = as(owner);
const strangerSide = as(stranger);

/** Read the owner's card until `shown` holds, or give up and return what the board says. */
async function cardUntil(
  taskId: string,
  shown: (card: {
    status: string;
    pendingApprovalId: string | null;
  }) => boolean,
) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const card = (await ownerSide.cards()).find((entry) => entry.id === taskId);
    if (card && shown(card)) return card;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return (await ownerSide.cards()).find((entry) => entry.id === taskId);
}

/**
 * A chat card whose run asks for approval, opened exactly the way the gate does it: the card first,
 * then the approval request filed against the card's own run, inside the owner's frame. Returns once
 * the board shows the card parked on that request.
 */
async function parkedCard(label: string) {
  const runRef = `run-${label}-${suite}`;
  const taskId = await projector.opened({
    tenantId: owner,
    title: `等你批准 ${label}`,
    executorAgentId: `agent-${suite}`,
    source: "chat",
    runRef,
  });
  const request = await runAsTenant(owner, () =>
    store.open(
      approvalAction({
        actorId: owner,
        botId: `bot-${suite}`,
        toolRef: "computer_write_file",
        effect: "write",
        scope: "project",
        args: { path: `${label}.txt`, contents: "saved" },
        target: { filePath: `project/${label}.txt` },
        continuation: {
          runId: runRef,
          threadId: `thread-${suite}`,
          toolCallId: `call-${label}-${suite}`,
          toolName: "computer_write_file",
          args: { path: `${label}.txt`, contents: "saved" },
          messages: [],
          state: {},
          context: [],
          forwardedProps: {},
        },
      }),
    ),
  );
  approvalIds.push(request.id);
  expect(request.status).toBe("pending");
  // Opened in the owner's frame, so the row is the owner's, not the platform partition's. Read back
  // from the row itself: `ApprovalRecord` does not declare the column the store returns with it.
  expect(await approvalTenant(request.id)).toBe(owner);
  const parked = await cardUntil(
    taskId,
    (card) => card.pendingApprovalId === request.id,
  );
  expect(parked?.status).toBe("needs_action");
  expect(parked?.pendingApprovalId).toBe(request.id);
  return { taskId, approvalId: request.id };
}

const approvalTenant = async (approvalId: string) => {
  const [row] = await runAsTenant(owner, () =>
    database
      .select({ tenantId: approvalRequests.tenantId })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, approvalId)),
  );
  return row?.tenantId;
};

const approvalStatus = async (approvalId: string) => {
  const [row] = await runAsTenant(owner, () =>
    database
      .select({ status: approvalRequests.status })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, approvalId)),
  );
  return row?.status;
};

beforeAll(async () => {
  await database.insert(users).values([
    { id: owner, email: `${owner}@example.test` },
    { id: stranger, email: `${stranger}@example.test` },
  ]);
});

afterAll(async () => {
  await runAsTenant(owner, async () => {
    await database.delete(tasks).where(eq(tasks.tenantId, owner));
    if (approvalIds.length) {
      await database
        .delete(workItems)
        .where(
          and(
            eq(workItems.kind, "approval.resume"),
            inArray(workItems.key, approvalIds),
          ),
        );
      await database
        .delete(approvalRequests)
        .where(inArray(approvalRequests.id, approvalIds));
    }
  });
  await database.delete(users).where(inArray(users.id, [owner, stranger]));
  await database.$client.close();
});

test("批准 on the board's approval makes its card 进行中", async () => {
  const { taskId, approvalId } = await parkedCard("allow");

  const response = await ownerSide.decide(approvalId, "allow_once");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ id: approvalId, status: "approved" });

  const card = await cardUntil(
    taskId,
    (entry) => entry.status !== "needs_action",
  );
  expect(card?.status).toBe("running");
  expect(card?.pendingApprovalId).toBeNull();
  expect(await approvalStatus(approvalId)).toBe("approved");
});

test("拒绝 on the board's approval makes its card 失败", async () => {
  const { taskId, approvalId } = await parkedCard("deny");

  const response = await ownerSide.decide(approvalId, "deny");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ id: approvalId, status: "denied" });

  const card = await cardUntil(
    taskId,
    (entry) => entry.status !== "needs_action",
  );
  expect(card?.status).toBe("failed");
  expect(card?.pendingApprovalId).toBeNull();
  expect(await approvalStatus(approvalId)).toBe("denied");
});

test("another tenant's decision is a 404 and the owner's card does not move", async () => {
  const { taskId, approvalId } = await parkedCard("stranger");

  for (const decision of ["allow_once", "deny"]) {
    const response = await strangerSide.decide(approvalId, decision);
    expect(response.status).toBe(404);
  }
  // The stranger's board never had the card to begin with.
  expect(
    (await strangerSide.cards()).find((entry) => entry.id === taskId),
  ).toBeUndefined();

  // Give a stray projection time to land if one had been fired, then read the owner's truth.
  await new Promise((resolve) => setTimeout(resolve, 100));
  const card = (await ownerSide.cards()).find((entry) => entry.id === taskId);
  expect(card?.status).toBe("needs_action");
  expect(card?.pendingApprovalId).toBe(approvalId);
  expect(await approvalStatus(approvalId)).toBe("pending");

  // And the owner can still answer it, which is the proof the refusal left the question open.
  const answered = await ownerSide.decide(approvalId, "deny");
  expect(answered.status).toBe(200);
  const after = await cardUntil(
    taskId,
    (entry) => entry.status !== "needs_action",
  );
  expect(after?.status).toBe("failed");
});
