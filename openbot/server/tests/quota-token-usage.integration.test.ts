import { afterAll, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import { modelTokenCalls } from "../src/db/schema";
import { billingPeriod, createQuotaService } from "../src/quota/limits";
import { createQuotaRoutes } from "../src/quota/routes";
import {
  periodRange,
  type TokenUsage,
  tokenUsageFor,
} from "../src/quota/token-usage";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Spec K2 / defect #11 (read side): the plan panel's token line is aggregated from
 * `model_token_calls`, per tenant, per UTC calendar month, and an unknown count stays unknown.
 *
 * Real database as the NOBYPASSRLS application role, rows written through the tenant's own frame so
 * the owner-only policy is what decides who sees what. Every row satisfies the table's CHECKs: the
 * original digest is the sha256 of the original text, and only a completed call with an observed
 * time carries a receipt.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const tenants: string[] = [];
const tenantFor = (kind: string) => {
  const tenant = `tok-${kind}-${suite}`;
  tenants.push(tenant);
  return tenant;
};
const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

type Call = {
  startedAt: Date;
  outcome: "pending" | "completed" | "stopped" | "unknown";
  usageStatus: "reported" | "partial" | "unknown";
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
};

async function insertCalls(tenant: string, calls: Call[]) {
  const rows = calls.map((call, index) => {
    const originalText = `call ${index} for ${tenant}`;
    const completed = call.outcome === "completed";
    const receiptText = completed ? `receipt ${index} for ${tenant}` : null;
    return {
      tenantId: tenant,
      callId: randomUUID(),
      runId: `run-${index}`,
      threadId: `thread-${tenant}`,
      agentId: `agent-${tenant}`,
      executionEpoch: 1,
      modelRef: randomUUID(),
      provider: "openai",
      modelName: "fake-model",
      credentialId: randomUUID(),
      credentialDigest: sha256(`credential ${tenant}`),
      originalModelFingerprint: sha256(`fingerprint ${tenant}`),
      sdkProvider: "openai",
      sdkModelId: "fake-model",
      originalText,
      originalDigest: sha256(originalText),
      outcome: call.outcome,
      usageStatus: call.usageStatus,
      inputTokens: call.inputTokens ?? null,
      outputTokens: call.outputTokens ?? null,
      totalTokens: call.totalTokens ?? null,
      receiptText,
      receiptDigest: receiptText === null ? null : sha256(receiptText),
      startedAt: call.startedAt,
      observedAt: completed ? call.startedAt : null,
    };
  });
  await runAsTenant(tenant, () =>
    database.insert(modelTokenCalls).values(rows),
  );
}

const period = "2026-10";
const inOctober = new Date("2026-10-15T08:00:00Z");

test("a billing period is the half-open UTC calendar month", () => {
  expect(periodRange("2026-10")).toEqual({
    start: new Date("2026-10-01T00:00:00.000Z"),
    end: new Date("2026-11-01T00:00:00.000Z"),
  });
  expect(periodRange("2026-12")).toEqual({
    start: new Date("2026-12-01T00:00:00.000Z"),
    end: new Date("2027-01-01T00:00:00.000Z"),
  });
  expect(() => periodRange("2026-13")).toThrow();
  expect(() => periodRange("october")).toThrow();
});

test("only the tenant's own calls in the period count, and partial rows add only their known side", async () => {
  const tenantA = tenantFor("a");
  const tenantB = tenantFor("b");
  await insertCalls(tenantA, [
    // Reported with the provider's own total (it includes reasoning, so it is not input + output).
    {
      startedAt: inOctober,
      outcome: "completed",
      usageStatus: "reported",
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 160,
    },
    // Reported without a total, on the first instant of the month: total falls back to 10 + 5.
    {
      startedAt: new Date("2026-10-01T00:00:00.000Z"),
      outcome: "completed",
      usageStatus: "reported",
      inputTokens: 10,
      outputTokens: 5,
    },
    // Partial: the input side is known, the output side and so the total are not.
    {
      startedAt: inOctober,
      outcome: "stopped",
      usageStatus: "partial",
      inputTokens: 7,
    },
    { startedAt: inOctober, outcome: "unknown", usageStatus: "unknown" },
    { startedAt: inOctober, outcome: "pending", usageStatus: "unknown" },
    // The previous month and the next month's first instant are outside the period.
    {
      startedAt: new Date("2026-09-30T23:59:59.999Z"),
      outcome: "completed",
      usageStatus: "reported",
      inputTokens: 1000,
      outputTokens: 1000,
      totalTokens: 2000,
    },
    {
      startedAt: new Date("2026-11-01T00:00:00.000Z"),
      outcome: "completed",
      usageStatus: "reported",
      inputTokens: 3000,
      outputTokens: 3000,
      totalTokens: 6000,
    },
  ]);
  await insertCalls(tenantB, [
    {
      startedAt: inOctober,
      outcome: "completed",
      usageStatus: "reported",
      inputTokens: 9000,
      outputTokens: 900,
      totalTokens: 9900,
    },
  ]);

  expect(await tokenUsageFor(database, tenantA, period)).toEqual({
    period,
    scope: "bound-models",
    calls: 5,
    reportedCalls: 2,
    partialCalls: 1,
    unknownUsageCalls: 2,
    unsettledCalls: 2,
    inputTokens: 117,
    outputTokens: 55,
    totalTokens: 175,
    complete: false,
  } satisfies TokenUsage);

  // The previous month is its own period, and holds only that one row.
  const september = await tokenUsageFor(database, tenantA, "2026-09");
  expect(september.calls).toBe(1);
  expect(september.totalTokens).toBe(2000);
  expect(september.complete).toBe(true);

  // B's meter counts only B, and B's frame cannot read a single row of A's.
  expect(await tokenUsageFor(database, tenantB, period)).toEqual({
    period,
    scope: "bound-models",
    calls: 1,
    reportedCalls: 1,
    partialCalls: 0,
    unknownUsageCalls: 0,
    unsettledCalls: 0,
    inputTokens: 9000,
    outputTokens: 900,
    totalTokens: 9900,
    complete: true,
  } satisfies TokenUsage);
  const leaked = await runAsTenant(tenantB, () =>
    database
      .select({ callId: modelTokenCalls.callId })
      .from(modelTokenCalls)
      .where(eq(modelTokenCalls.tenantId, tenantA)),
  );
  expect(leaked).toEqual([]);
});

test("a tenant whose calls all lack usage has unknown tokens, not zero", async () => {
  const tenant = tenantFor("unknown");
  await insertCalls(tenant, [
    { startedAt: inOctober, outcome: "unknown", usageStatus: "unknown" },
    { startedAt: inOctober, outcome: "stopped", usageStatus: "unknown" },
  ]);
  const usage = await tokenUsageFor(database, tenant, period);
  expect(usage.calls).toBe(2);
  expect(usage.unknownUsageCalls).toBe(2);
  expect(usage.unsettledCalls).toBe(1);
  expect(usage.inputTokens).toBeNull();
  expect(usage.outputTokens).toBeNull();
  expect(usage.totalTokens).toBeNull();
  expect(usage.complete).toBe(false);
});

test("a partial-only tenant knows one side and no total", async () => {
  const tenant = tenantFor("partial");
  await insertCalls(tenant, [
    {
      startedAt: inOctober,
      outcome: "stopped",
      usageStatus: "partial",
      inputTokens: 40,
    },
  ]);
  const usage = await tokenUsageFor(database, tenant, period);
  expect(usage.inputTokens).toBe(40);
  expect(usage.outputTokens).toBeNull();
  expect(usage.totalTokens).toBeNull();
  expect(usage.partialCalls).toBe(1);
  expect(usage.complete).toBe(false);
});

test("a tenant with no calls has no sums at all and nothing outstanding", async () => {
  const usage = await tokenUsageFor(database, tenantFor("empty"), period);
  expect(usage).toEqual({
    period,
    scope: "bound-models",
    calls: 0,
    reportedCalls: 0,
    partialCalls: 0,
    unknownUsageCalls: 0,
    unsettledCalls: 0,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    complete: true,
  } satisfies TokenUsage);
});

test("GET /api/quota carries this period's tokens beside the existing fields", async () => {
  const tenant = tenantFor("route");
  const other = tenantFor("route-other");
  const now = new Date();
  await insertCalls(tenant, [
    {
      startedAt: now,
      outcome: "completed",
      usageStatus: "reported",
      inputTokens: 12,
      outputTokens: 30,
    },
    { startedAt: now, outcome: "pending", usageStatus: "unknown" },
  ]);
  await insertCalls(other, [
    {
      startedAt: now,
      outcome: "completed",
      usageStatus: "reported",
      inputTokens: 5000,
      outputTokens: 5000,
    },
  ]);
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", { id: tenant, role: "user" as const });
    await runAsTenant(tenant, () => next());
  };
  const routes = createQuotaRoutes(
    database,
    createQuotaService(database),
    requireUser,
  );
  const response = await routes.request(new Request("http://quota.test/"));
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    plan: { id: string };
    limits: { wakers: number };
    usage: { period: string };
    tokens: TokenUsage;
  };
  expect(body.plan.id).toBe("free");
  expect(body.limits.wakers).toBe(2);
  expect(body.usage.period).toBe(billingPeriod());
  expect(body.tokens).toEqual({
    period: billingPeriod(),
    scope: "bound-models",
    calls: 2,
    reportedCalls: 1,
    partialCalls: 0,
    unknownUsageCalls: 1,
    unsettledCalls: 1,
    inputTokens: 12,
    outputTokens: 30,
    totalTokens: 42,
    complete: false,
  } satisfies TokenUsage);
});

afterAll(async () => {
  for (const tenant of tenants)
    await runAsTenant(tenant, () =>
      database
        .delete(modelTokenCalls)
        .where(eq(modelTokenCalls.tenantId, tenant)),
    );
  await database.$client.close();
});
