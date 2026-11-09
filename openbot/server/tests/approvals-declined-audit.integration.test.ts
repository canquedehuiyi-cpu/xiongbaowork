import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { createApprovalStore } from "../src/approvals/store";
import {
  type ApprovalCandidate,
  ApprovalRefusedError,
  approvalAction,
} from "../src/approvals/types";
import type { AuditEventInput } from "../src/audit";
import { createDatabase } from "../src/db/client";
import { auditEvents, users } from "../src/db/schema/core";
import { workItems } from "../src/db/schema/work";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * The row a refused action leaves when the person is the one who refuses it (upstream #1106,
 * `declined`). The code that asks the gate hands in the row; the store writes it, once, in the
 * transaction that saves a denial, in the person's own tenant frame beside the decision row.
 * Real store, real audit table.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `declined-audit-${randomUUID()}`;
const owner = `${prefix}-owner`;
const bot = `${prefix}-bot`;
const store = createApprovalStore(database);
const asOwner = <T>(work: () => Promise<T>) => runAsTenant(owner, work);
const ids: string[] = [];

beforeAll(async () => {
  await runAsTenant("platform", () =>
    database
      .insert(users)
      .values({ id: owner, email: `${owner}@example.test` }),
  );
});
afterAll(async () => {
  if (ids.length)
    await asOwner(() =>
      database
        .delete(workItems)
        .where(
          and(
            eq(workItems.kind, "approval.resume"),
            inArray(workItems.key, ids),
          ),
        ),
    );
  await runAsTenant("platform", () =>
    database.delete(users).where(eq(users.id, owner)),
  );
  await database.$client.close();
});

const refusedRow = (tool: string, extra: Record<string, unknown> = {}) =>
  ({
    eventType: "mcp.call_rejected",
    targetType: "mcp_tool",
    targetId: `notes/${tool}`,
    payload: {
      actor: owner,
      bot,
      server: "notes",
      tool,
      decision: { allowed: true, carriedOut: false },
      refusal: "person_declined",
      reason: "The person declined this action.",
      ...extra,
    },
  }) satisfies AuditEventInput;

function candidate(
  tool: string,
  declined?: AuditEventInput,
): ApprovalCandidate {
  const toolCallId = randomUUID();
  const args = { title: "needle-argument-value-4417" };
  return {
    actorId: owner,
    botId: bot,
    toolRef: `notes/${tool}`,
    effect: "write",
    scope: "notes",
    args,
    target: { serverId: "notes", toolName: tool },
    ...(declined ? { declined } : {}),
    continuation: {
      runId: randomUUID(),
      threadId: `${prefix}-thread`,
      toolCallId,
      toolName: `mcp__notes__${tool}`,
      args,
      messages: [],
      state: {},
      context: [],
      forwardedProps: {},
    },
  };
}

const open = (input: ApprovalCandidate) =>
  asOwner(async () => {
    const request = await store.open(approvalAction(input));
    ids.push(request.id);
    return request.id;
  });

/** Every row the person's decisions left for one tool of this Bot, oldest first. */
const rowsFor = (tool: string) =>
  runAsTenant("platform", () =>
    database
      .select({
        eventType: auditEvents.eventType,
        tenantId: auditEvents.tenantId,
        payload: auditEvents.payload,
      })
      .from(auditEvents)
      .where(
        and(
          eq(sql<string>`${auditEvents.payload} ->> 'bot'`, bot),
          eq(sql<string>`${auditEvents.payload} ->> 'tool'`, `notes/${tool}`),
        ),
      )
      .orderBy(asc(auditEvents.createdAt)),
  );
const declinedRows = (tool: string) =>
  runAsTenant("platform", () =>
    database
      .select({
        tenantId: auditEvents.tenantId,
        payload: auditEvents.payload,
      })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.eventType, "mcp.call_rejected"),
          eq(sql<string>`${auditEvents.payload} ->> 'bot'`, bot),
          eq(sql<string>`${auditEvents.payload} ->> 'tool'`, tool),
        ),
      ),
  );

test("a denial writes the action's refused row once, in the person's tenant, beside the decision", async () => {
  const id = await open(candidate("deny_me", refusedRow("deny_me")));
  await asOwner(() => store.decide(owner, id, "deny"));

  const rows = await declinedRows("deny_me");
  expect(rows).toHaveLength(1);
  expect(rows[0]?.tenantId).toBe(owner);
  expect(rows[0]?.payload).toMatchObject({
    refusal: "person_declined",
    decision: { carriedOut: false },
  });
  // Never what was sent.
  expect(JSON.stringify(rows)).not.toContain("needle-argument-value-4417");

  // The decision row is there too, and the second answer is refused without writing again.
  const decisions = await runAsTenant("platform", () =>
    database
      .select({ tenantId: auditEvents.tenantId })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.eventType, "approval.person_decided"),
          eq(auditEvents.targetId, id),
        ),
      ),
  );
  expect(decisions).toEqual([{ tenantId: owner }]);
  await expect(
    asOwner(() => store.decide(owner, id, "deny")),
  ).rejects.toBeInstanceOf(ApprovalRefusedError);
  expect(await declinedRows("deny_me")).toHaveLength(1);
});

test("an allowed action, and a denial with nothing handed in, write no refused row", async () => {
  const allowed = await open(candidate("allow_me", refusedRow("allow_me")));
  await asOwner(() => store.decide(owner, allowed, "allow_once"));
  const bare = await open(candidate("bare"));
  await asOwner(() => store.decide(owner, bare, "deny"));

  expect(await declinedRows("allow_me")).toEqual([]);
  expect(await declinedRows("bare")).toEqual([]);
  // Only the person's decision itself.
  expect((await rowsFor("allow_me")).map((row) => row.eventType)).toEqual([
    "approval.person_decided",
  ]);
});

test("the handed-in row goes through redaction, and is no part of what the person approves", async () => {
  const withRow = candidate(
    "redact_me",
    refusedRow("redact_me", { token: "secret-token-value-9921" }),
  );
  const id = await open(withRow);
  await asOwner(() => store.decide(owner, id, "deny"));
  const rows = await declinedRows("redact_me");
  expect(rows).toHaveLength(1);
  expect(JSON.stringify(rows)).not.toContain("secret-token-value-9921");
  expect(rows[0]?.payload).toMatchObject({ token: "[REDACTED]" });

  const { declined: _declined, ...without } = withRow;
  expect(approvalAction(withRow).actionDigest).toBe(
    approvalAction(without).actionDigest,
  );
});
