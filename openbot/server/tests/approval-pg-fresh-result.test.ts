import { describe, expect, test } from "bun:test";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import {
  writeApprovalFreshResultInTransaction,
  type ApprovalFreshResultInput,
  type ApprovalFreshResultTransaction,
} from "../src/approvals/pg-fresh-result";
import { approvalFreshSeeds, approvalRequests } from "../src/db/schema/approvals";
import { runAsTenant } from "../src/tenant/context";

// CPU fixtures with real Drizzle builders and a non-network proxy callback.
// No PostgreSQL, RLS, row-lock serialization, audit, COMMIT, durable CAS,
// provenance, authority, or production acceptance is established by this file.
type RequestRow = typeof approvalRequests.$inferSelect;
type SeedRow = typeof approvalFreshSeeds.$inferSelect;
type Query = { query: string; params: unknown[]; method: string };
const identity = {
  approvalId: "approval", tenantId: "tenant", ownerId: "owner",
  runId: "run", toolCallId: "call", actionDigest: "digest",
  templateDigest: "a".repeat(64), producerProofId: "producer-proof",
};

const input = (): ApprovalFreshResultInput => ({
  seed: { ...identity }, result: { content: "outcome", error: "known detail" },
  disposition: "continue", expectedStatus: "approved",
});
const request = (): RequestRow => ({
  id: identity.approvalId, tenantId: identity.tenantId,
  ownerUserId: identity.ownerId, runId: identity.runId,
  toolCallId: identity.toolCallId, actionDigest: identity.actionDigest,
  action: {
    actorId: identity.ownerId, botId: "bot", toolRef: "tool",
    effect: "write", scope: "fixture.invalid", args: {},
    runId: identity.runId, threadId: "thread",
    toolCallId: identity.toolCallId, actionDigest: identity.actionDigest,
    continuation: {
      runId: identity.runId, threadId: "thread", toolCallId: identity.toolCallId,
      toolName: "tool", args: {}, messages: [], state: {}, context: [], forwardedProps: {},
    },
  },
  status: "approved", decision: "allow_once",
  result: null, resultDisposition: null, createdAt: new Date(0),
  decidedAt: new Date(0), consumedAt: null, completedAt: null,
});
const seedRow = (): SeedRow => ({
  approvalId: identity.approvalId, tenantId: identity.tenantId,
  ownerUserId: identity.ownerId, runId: identity.runId,
  toolCallId: identity.toolCallId, actionDigest: identity.actionDigest,
  templateDigest: identity.templateDigest, producerProofId: identity.producerProofId,
  preparedAt: new Date(0),
});

function wireRow(
  table: typeof approvalRequests | typeof approvalFreshSeeds,
  row: object,
): unknown[] {
  const record = row as Record<string, unknown>;
  return Object.keys(getTableColumns(table)).map((key) => {
    const value = record[key];
    if (!(value instanceof Date)) return value;
    return Number.isFinite(value.getTime()) ? value.toISOString() : "not-a-time";
  });
}

function fixture(options: {
  parent?: RequestRow | null;
  seed?: SeedRow | null;
  casRows?: number;
  beforeParent?: () => Promise<void>;
  failUpdate?: Error;
} = {}) {
  const parent = options.parent === undefined ? request() : options.parent;
  const seed = options.seed === undefined ? seedRow() : options.seed;
  const calls: Query[] = [];
  const db = drizzle(async (query, params, method) => {
    calls.push({ query, params: [...params], method });
    if (/^select\b/i.test(query) && query.includes('from "approval_requests"')) {
      await options.beforeParent?.();
      return { rows: parent ? [wireRow(approvalRequests, parent)] : [] };
    }
    if (/^select\b/i.test(query) && query.includes('from "approval_fresh_seeds"'))
      return { rows: seed ? [wireRow(approvalFreshSeeds, seed)] : [] };
    if (/^update "approval_requests" /i.test(query)) {
      if (options.failUpdate) throw options.failUpdate;
      return { rows: Array.from({ length: options.casRows ?? 1 }, () => [identity.approvalId]) };
    }
    throw new Error("unexpected fixture SQL: " + query);
  });
  // This cast is only a builder/execution fixture. It supplies no transaction,
  // authorization or commit semantics and is never exported as a production adapter.
  const tx = db as unknown as ApprovalFreshResultTransaction;
  const run = (value = input()) => runAsTenant(identity.tenantId, () =>
    writeApprovalFreshResultInTransaction(tx, value));
  const writes = () => calls.filter((call) => /^update\b/i.test(call.query));
  return { tx, calls, run, writes };
}

describe("fresh result transaction primitive, CPU/SQL contract only", () => {
  test("locks the consume parent first, reads the seed under share lock, then performs one CAS", async () => {
    const h = fixture();
    expect(await h.run()).toEqual({ kind: "written_in_transaction", disposition: "continue" });
    expect(h.calls).toHaveLength(3);
    expect(h.calls[0]?.query).toContain('from "approval_requests"');
    expect(h.calls[0]?.query).toMatch(/\bfor update\b/i);
    expect(h.calls[1]?.query).toContain('from "approval_fresh_seeds"');
    expect(h.calls[1]?.query).toMatch(/\bfor share\b/i);
    const update = h.writes()[0];
    expect(update).toBeDefined();
    if (!update) throw new Error("missing update");
    const where = update.query.slice(update.query.indexOf(" where "));
    for (const column of ["id", "tenant_id", "owner_user_id", "action_digest", "run_id", "tool_call_id", "status"])
      expect(where).toContain('"' + column + '" = $');
    expect(where).toMatch(/"result" is null/i);
    expect(where).toMatch(/"result_disposition" is null/i);
    expect(update.query).toMatch(/set "result" = \$\d+, "result_disposition" = \$\d+/i);
    expect(update.query).not.toMatch(/"status" = .+?set|"completed_at" =/i);
    expect(update.params).toContainEqual({ content: "outcome", error: "known detail" });
    for (const value of ["approval", "tenant", "owner", "digest", "run", "call", "approved", "continue"])
      expect(update.params).toContain(value);
  });

  test("captures every caller-owned field before waiting for the parent lock", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const h = fixture({ beforeParent: async () => { entered.resolve(); await release.promise; } });
    const value = input();
    const pending = h.run(value);
    await entered.promise;
    value.seed.approvalId = "changed";
    value.seed.tenantId = "other-tenant";
    value.seed.ownerId = "other-owner";
    value.seed.actionDigest = "other-digest";
    value.seed.runId = "other-run";
    value.seed.toolCallId = "other-call";
    value.seed.templateDigest = "b".repeat(64);
    value.seed.producerProofId = "other-proof";
    value.result.content = "changed";
    value.result.error = "changed";
    value.disposition = "final";
    value.expectedStatus = "completed";
    release.resolve();
    expect(await pending).toEqual({ kind: "written_in_transaction", disposition: "continue" });
    expect(h.writes()[0]?.params).toContainEqual({ content: "outcome", error: "known detail" });
    expect(h.writes()[0]?.query).not.toContain("clock_timestamp()");
    for (const call of h.calls)
      expect(call.params).not.toContain("other-owner");
  });

  for (const [name, change] of [
    ["pending expected status", { expectedStatus: "pending" }],
    ["completed expected status", { expectedStatus: "completed" }],
    ["invalid expected status", { expectedStatus: "invalid" }],
    ["invalid disposition", { disposition: "invalid" }],
    ["null result", { result: null }],
    ["non-string content", { result: { content: 4 } }],
    ["non-string error", { result: { content: "x", error: 4 } }],
    ["extra result data", { result: { content: "x", extra: "unsafe" } }],
  ] as const) {
    test("refuses " + name + " before querying", async () => {
      const h = fixture();
      const bad = { ...input(), ...change } as unknown as ApprovalFreshResultInput;
      await expect(h.run(bad)).rejects.toThrow("approval_fresh_result_input_invalid");
      expect(h.calls).toHaveLength(0);
    });
  }

  test("refuses an ambient tenant mismatch before querying", async () => {
    const h = fixture();
    await expect(runAsTenant("other-tenant", () =>
      writeApprovalFreshResultInTransaction(h.tx, input())))
      .rejects.toThrow("approval_fresh_result_input_invalid");
    expect(h.calls).toHaveLength(0);
  });

  for (const key of ["approvalId", "tenantId", "ownerId", "actionDigest", "runId", "toolCallId", "producerProofId"] as const) {
    test("refuses blank input seed " + key, async () => {
      const h = fixture();
      const value = input();
      value.seed[key] = " ";
      await expect(h.run(value)).rejects.toThrow("approval_fresh_result_input_invalid");
      expect(h.calls).toHaveLength(0);
    });
  }
  test("refuses an invalid template digest before querying", async () => {
    const h = fixture();
    const value = input();
    value.seed.templateDigest = "not-a-sha256";
    await expect(h.run(value)).rejects.toThrow("approval_fresh_result_input_invalid");
    expect(h.calls).toHaveLength(0);
  });

  for (const status of ["pending", "completed", "consumed"] as const) {
    test("does not write after parent status changed to " + status, async () => {
      const h = fixture({ parent: { ...request(), status } });
      expect(await h.run()).toEqual({ kind: "not_written_in_transaction", reason: "status_changed" });
      expect(h.calls).toHaveLength(1);
      expect(h.writes()).toHaveLength(0);
    });
  }
  for (const change of [
    { result: { content: "already saved" } },
    { resultDisposition: "final" as const },
    { resultDisposition: "continue" as const },
  ]) {
    test("never clears an existing result or disposition", async () => {
      const h = fixture({ parent: { ...request(), ...change } });
      expect(await h.run()).toEqual({ kind: "not_written_in_transaction", reason: "result_exists" });
      expect(h.writes()).toHaveLength(0);
    });
  }

  for (const key of ["id", "tenantId", "ownerUserId", "actionDigest", "runId", "toolCallId"] as const) {
    test("rejects a parent " + key + " conflict without writing", async () => {
      const parent = request();
      parent[key] = "conflict";
      const h = fixture({ parent });
      expect(await h.run()).toEqual({ kind: "not_written_in_transaction", reason: "binding_mismatch" });
      expect(h.writes()).toHaveLength(0);
    });
  }
  for (const key of ["actorId", "actionDigest", "runId", "toolCallId"] as const) {
    test("rejects parent JSON action " + key + " conflict", async () => {
      const parent = request();
      parent.action[key] = "conflict";
      const h = fixture({ parent });
      expect(await h.run()).toEqual({ kind: "not_written_in_transaction", reason: "binding_mismatch" });
      expect(h.writes()).toHaveLength(0);
    });
  }
  test("requires the stored continuation identity to match the parent", async () => {
    const parent = request();
    if (!parent.action.continuation) throw new Error("missing fixture continuation");
    parent.action.continuation.toolCallId = "conflict";
    const h = fixture({ parent });
    expect(await h.run()).toEqual({ kind: "not_written_in_transaction", reason: "binding_mismatch" });
    expect(h.writes()).toHaveLength(0);
  });

  for (const key of ["approvalId", "tenantId", "ownerUserId", "actionDigest", "runId", "toolCallId", "templateDigest", "producerProofId"] as const) {
    test("rejects stored seed " + key + " conflict", async () => {
      const seed = seedRow();
      seed[key] = "conflict";
      const h = fixture({ seed });
      expect(await h.run()).toEqual({ kind: "not_written_in_transaction", reason: "binding_mismatch" });
      expect(h.writes()).toHaveLength(0);
    });
  }
  test("requires a valid stored prepared_at without claiming a sealed time proof", async () => {
    const h = fixture({ seed: { ...seedRow(), preparedAt: new Date("invalid") } });
    expect(await h.run()).toEqual({ kind: "not_written_in_transaction", reason: "binding_mismatch" });
    expect(h.writes()).toHaveLength(0);
  });
  for (const [name, options, reason] of [
    ["parent", { parent: null }, "request_missing"],
    ["seed", { seed: null }, "seed_missing"],
  ] as const) {
    test("does not reconstruct a missing " + name, async () => {
      const h = fixture(options);
      expect(await h.run()).toEqual({ kind: "not_written_in_transaction", reason });
      expect(h.writes()).toHaveLength(0);
    });
  }

  test("zero CAS rows report only an in-transaction miss, never another commit outcome", async () => {
    const h = fixture({ casRows: 0 });
    expect(await h.run()).toEqual({ kind: "not_written_in_transaction", reason: "cas_miss" });
    expect(h.writes()).toHaveLength(1);
  });
  test("database errors reject instead of becoming committed or lost", async () => {
    const h = fixture({ failUpdate: new Error("CPU database transport ACK unknown") });
    await expect(h.run()).rejects.toThrow();
    expect(h.writes()).toHaveLength(1);
  });
  test("an impossible multi-row CAS response rejects instead of claiming a write outcome", async () => {
    const h = fixture({ casRows: 2 });
    await expect(h.run()).rejects.toThrow("approval_fresh_result_row_count_invalid");
  });

  for (const status of ["approved", "denied", "consumed"] as const) {
    test("final atomically completes " + status + " with DB clock and no receipt or finish call", async () => {
      const h = fixture({ parent: { ...request(), status } });
      const value = input();
      value.expectedStatus = status;
      value.disposition = "final";
      expect(await h.run(value)).toEqual({ kind: "written_in_transaction", disposition: "final" });
      expect(h.writes()).toHaveLength(1);
      expect(h.calls).toHaveLength(3);
      const update = h.writes()[0];
      expect(update?.query).toContain('"completed_at" = clock_timestamp()');
      expect(update?.params).toContain("completed");
      expect(update?.params).toContain("final");
      for (const call of h.calls)
        expect(call.query).not.toMatch(/approval_continuations|receipt|insert into|audit/i);
    });
  }
});
