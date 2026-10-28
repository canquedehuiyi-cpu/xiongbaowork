import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  createApprovalStore,
  openStoredApprovalInTransaction,
} from "../src/approvals/store";
import {
  approvalAction,
  type ApprovalAction,
  ApprovalRefusedError,
} from "../src/approvals/types";
import { createDatabase } from "../src/db/client";
import { approvalRequests, approvalRules } from "../src/db/schema/approvals";
import { users } from "../src/db/schema/core";
import { runAsTenant } from "../src/tenant/context";
import { testDatabaseUrl } from "./support/database";

// SOURCE_ONLY: definitions, zero executions. Real PG17 only; never a CPU import.
// Reuse the repository's explicit TEST_DATABASE_URL resolver, then tighten to
// the existing AP disposable-name/acknowledgment convention. No DATABASE_URL
// fallback, DDL, migration, auto-creation, provider or alternate PG engine.
const raw = testDatabaseUrl();
const url = new URL(raw);
const databaseName = decodeURIComponent(url.pathname.slice(1));
if (
  !["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname) ||
  !/^openbot_continuation_test_[0-9a-f]{16}$/.test(databaseName) ||
  process.env.TEST_DATABASE_DISPOSABLE !== databaseName
)
  throw new Error("BLOCKED_NOT_DISPOSABLE: explicit one-time PG17 fixture required");

// A nested public open()/second pooled borrow would stall this exact fixture.
// No increased test timeout, mock transaction, fake connection or PG substitute.
const database = createDatabase(raw, { max: 1 });
const owner = `approval-open-tx-${randomUUID()}`;
const originalName = "SOURCE_TX1 disposable fixture";
const scope = <T>(body: () => T) => runAsTenant(owner, body);
type ApprovalTransaction = Parameters<typeof openStoredApprovalInTransaction>[0];
let initialized = false;

beforeAll(async () => {
  const [identity] = await database
    .select({
      name: sql<string>`current_database()`,
      version: sql<number>`current_setting('server_version_num')::int`,
      approvals: sql<string | null>`to_regclass('public.approval_requests')::text`,
      rules: sql<string | null>`to_regclass('public.approval_rules')::text`,
    })
    .from(sql`(select 1) as fixture_identity`);
  if (
    !identity || identity.name !== databaseName ||
    identity.version < 170_000 || identity.version >= 180_000 ||
    !identity.approvals || !identity.rules
  )
    throw new Error("BLOCKED_PG17_SCHEMA: canonical disposable PG17 fixture required");
  await scope(() => database.insert(users).values({
    id: owner,
    email: `${owner}@fixture.invalid`,
    name: originalName,
  }));
  initialized = true;
});

afterAll(async () => {
  try {
    if (initialized) {
      // Only this random fixture owner's entries, never database-wide cleanup.
      await scope(() => database.delete(approvalRequests).where(eq(approvalRequests.ownerUserId, owner)));
      await scope(() => database.delete(approvalRules).where(eq(approvalRules.ownerUserId, owner)));
      await scope(() => database.delete(users).where(eq(users.id, owner)));
    }
  } finally {
    await database.$client.close();
  }
});

function action(scopeName = "tx-fixture"): ApprovalAction {
  const args = { path: "notes.txt", content: "fixture content" };
  return approvalAction({
    actorId: owner,
    botId: "tx-fixture-bot",
    toolRef: "fixture/write",
    effect: "write",
    scope: scopeName,
    args,
    target: { path: "notes.txt" },
    continuation: {
      runId: randomUUID(),
      threadId: "tx-fixture-thread",
      toolCallId: randomUUID(),
      toolName: "fixture_write",
      args,
      messages: [],
      state: {},
      context: [],
      forwardedProps: {},
    },
  });
}

async function session(tx: ApprovalTransaction) {
  const [row] = await tx.select({
    pid: sql<number>`pg_backend_pid()`,
    tenant: sql<string>`current_setting('app.tenant_id', true)`,
    xid: sql<string>`pg_current_xact_id()::text`,
  }).from(users).where(eq(users.id, owner)).limit(1);
  if (!row || !Number.isInteger(row.pid) || row.pid <= 0 || typeof row.xid !== "string" || !/^[0-9]+$/.test(row.xid))
    throw new Error("PG fixture did not expose a real session/transaction");
  expect(row.tenant).toBe(owner);
  return row;
}

test("PG17 helper preserves the caller's session tenant and active transaction", async () => {
  const input = action("session");
  const created = await scope(() => database.transaction(async (tx) => {
    const before = await session(tx);
    const request = await openStoredApprovalInTransaction(tx, input);
    const after = await session(tx);
    expect(after.pid).toBe(before.pid);
    expect(after.xid).toBe(before.xid);
    expect(request.id).not.toBe("");
    expect(request.ownerUserId).toBe(owner);
    expect(request.action).toEqual(input);
    expect(request.status).toBe("pending");
    expect(request.decision).toBeNull();
    expect(request.decidedAt).toBeNull();
    const [stored] = await tx.select().from(approvalRequests).where(eq(approvalRequests.id, request.id));
    expect(stored).toBeDefined();
    expect(stored?.tenantId).toBe(owner);
    expect(stored?.runId).toBe(input.runId);
    expect(stored?.toolCallId).toBe(input.toolCallId);
    expect(stored?.actionDigest).toBe(input.actionDigest);
    return request;
  }));
  expect((await scope(() => createApprovalStore(database).get(owner, created.id))).id).toBe(created.id);
});

test("PG17 conflict returns the exact old ID and public open remains compatible", async () => {
  const input = action("same-action");
  const store = createApprovalStore(database);
  const first = await scope(() => store.open(input));
  const repeated = await scope(() => database.transaction((tx) => openStoredApprovalInTransaction(tx, input)));
  const publicAgain = await scope(() => store.open(input));
  expect(repeated.id).toBe(first.id);
  expect(publicAgain.id).toBe(first.id);
  expect(repeated.createdAt.getTime()).toBe(first.createdAt.getTime());
  expect(publicAgain.action).toEqual(first.action);
  const rows = await scope(() => database.select().from(approvalRequests).where(and(
    eq(approvalRequests.ownerUserId, owner),
    eq(approvalRequests.runId, input.runId),
    eq(approvalRequests.toolCallId, input.toolCallId),
  )));
  expect(rows).toHaveLength(1);
  expect(rows[0]?.id).toBe(first.id);
});

test("PG17 changed digest rejects without overwriting the existing action", async () => {
  const input = action("digest-conflict");
  const first = await scope(() => createApprovalStore(database).open(input));
  const changed = approvalAction({ ...input, args: { path: "different.txt" } });
  expect(changed.runId).toBe(input.runId);
  expect(changed.toolCallId).toBe(input.toolCallId);
  expect(changed.actionDigest).not.toBe(input.actionDigest);
  await expect(scope(() => database.transaction((tx) => openStoredApprovalInTransaction(tx, changed))))
    .rejects.toBeInstanceOf(ApprovalRefusedError);
  const saved = await scope(() => createApprovalStore(database).get(owner, first.id));
  expect(saved.id).toBe(first.id);
  expect(saved.action).toEqual(input);
  expect(saved.action.actionDigest).toBe(input.actionDigest);
  expect(saved.status).toBe("pending");
});

test("PG17 caller failure after helper rolls back approval and later caller write together", async () => {
  const input = action("outer-rollback");
  let stagedId = "";
  await expect(scope(() => database.transaction(async (tx) => {
    const request = await openStoredApprovalInTransaction(tx, input);
    stagedId = request.id;
    await tx.update(users).set({ name: "must rollback" }).where(eq(users.id, owner));
    const [visible] = await tx.select({ id: approvalRequests.id }).from(approvalRequests).where(eq(approvalRequests.id, stagedId));
    expect(visible?.id).toBe(stagedId);
    throw new Error("SOURCE_TX1_CALLER_ROLLBACK");
  }))).rejects.toThrow("SOURCE_TX1_CALLER_ROLLBACK");
  expect(stagedId).not.toBe("");
  const requests = await scope(() => database.select().from(approvalRequests).where(eq(approvalRequests.id, stagedId)));
  expect(requests).toHaveLength(0);
  const [person] = await scope(() => database.select({ name: users.name }).from(users).where(eq(users.id, owner)));
  expect(person?.name).toBe(originalName);
});

test("PG17 pool of one permits two helper calls on the one caller transaction", async () => {
  const first = action("pool-one-first");
  const second = action("pool-one-second");
  const ids = await scope(() => database.transaction(async (tx) => {
    const before = await session(tx);
    const a = await openStoredApprovalInTransaction(tx, first);
    const middle = await session(tx);
    const b = await openStoredApprovalInTransaction(tx, second);
    const after = await session(tx);
    expect(middle.pid).toBe(before.pid);
    expect(after.pid).toBe(before.pid);
    expect(middle.xid).toBe(before.xid);
    expect(after.xid).toBe(before.xid);
    expect(a.id).not.toBe(b.id);
    return [a.id, b.id];
  }));
  for (const id of ids) {
    const row = await scope(() => createApprovalStore(database).get(owner, id));
    expect(row.id).toBe(id);
  }
});

test("PG17 legacy allow rule and explicit ask keep the original status semantics", async () => {
  const legacy = action("rule-preservation");
  await scope(() => database.insert(approvalRules).values({
    id: randomUUID(),
    ownerUserId: owner,
    botId: legacy.botId,
    toolRef: legacy.toolRef,
    effect: legacy.effect,
    scope: legacy.scope,
    behaviour: "allow",
  }));
  const auto = await scope(() => database.transaction((tx) => openStoredApprovalInTransaction(tx, legacy)));
  expect(auto.status).toBe("approved");
  expect(auto.decision).toBe("allow_always");
  expect(auto.decidedAt).toBeInstanceOf(Date);
  const asking: ApprovalAction = {
    ...action("rule-preservation"),
    policy: { behaviour: "ask", source: "default", reason: "fixture asks the person" },
  };
  const pending = await scope(() => database.transaction((tx) => openStoredApprovalInTransaction(tx, asking)));
  expect(pending.status).toBe("pending");
  expect(pending.decision).toBeNull();
  expect(pending.decidedAt).toBeNull();
});
