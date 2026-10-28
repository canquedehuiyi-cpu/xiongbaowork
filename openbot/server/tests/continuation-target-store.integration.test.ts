import { afterAll, beforeAll, expect, test } from "bun:test";
import { AbstractAgent, type BaseEvent, EventType } from "@ag-ui/client";
import type { AgentRunnerRunRequest } from "@copilotkit/runtime/v2";
import { and, eq, inArray, sql } from "drizzle-orm";
import { EMPTY, of } from "rxjs";
import { createDatabase, type Database } from "../src/db/client";
import {
  approvalContinuations,
  approvalContinuationSteps,
  approvalRequests,
} from "../src/db/schema/approvals";
import { users } from "../src/db/schema/core";
import { threadRunEvents, threadRuns, threads } from "../src/db/schema/threads";
import { approvalAction } from "../src/approvals/types";
import { createContinuationStore } from "../src/approvals/continuation-store";
import type { ContinuationIdentity } from "../src/approvals/continuation-protocol";
import {
  localInputDigest,
  localRunId,
  localRunPlan,
  type LocalTerminal,
} from "../src/approvals/continuation-target-local";
import {
  createLocalTargetStore,
  type LocalReleaseAuthority,
} from "../src/approvals/continuation-target-store";
import { createLocalContinuationTurnTarget } from "../src/routines/run-turn";
import { PostgresAgentRunner } from "../src/threads/postgres-runner";
import { runAsTenant } from "../src/tenant/context";

// REAL PG only. No default URL, DDL, auto-migration, service, model or provider.
// Root supplies canonical schema/RLS and a non-owner, non-BYPASS fixture role.
const raw = process.env.TEST_DATABASE_URL;
if (!raw)
  throw new Error("BLOCKED_TEST_DATABASE_URL: PG bodies/connections NOT RUN");
const url = new URL(raw);
const databaseName = decodeURIComponent(url.pathname.slice(1));
if (
  !/^postgres(?:ql)?:$/.test(url.protocol) ||
  !["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname) ||
  !/^openbot_continuation_test_[0-9a-f]{16}$/.test(databaseName) ||
  process.env.TEST_DATABASE_DISPOSABLE !== databaseName
)
  throw new Error(
    "BLOCKED_NOT_DISPOSABLE: explicit loopback one-time test DB required",
  );
const dbA = createDatabase(raw, { max: 1 });
const dbB = createDatabase(raw, { max: 1 });
const owner = `target-owner-${crypto.randomUUID()}`;
const tenant = owner;
const ids: string[] = [];
const threadIds: string[] = [];
let initialized = false;
const scoped = <T>(fn: () => T) => runAsTenant(tenant, fn);
// Fixture release ONLY, not a production Root release verifier. The real store
// still checks actual PG role, table owner, ENABLE/FORCE RLS and catalog facts.
// Production must supply Root's separately reviewed verified release authority.
const fixtureRelease: LocalReleaseAuthority = {
  async readVerifiedRelease(facts) {
    return {
      ...facts,
      lineage: "recovery-20261018-v1",
      feature: "approval-local-target-v1",
      releaseId: "DISPOSABLE-PG-FIXTURE-ONLY",
    };
  },
};
beforeAll(async () => {
  const a =
    await dbA.$client`select current_database() as db,pg_backend_pid() as pid`;
  const b = await dbB.$client`select pg_backend_pid() as pid`;
  expect(a[0]?.db).toBe(databaseName);
  expect(a[0]?.pid).not.toBe(b[0]?.pid);
  const [empty] = await runAsTenant("platform", () =>
    dbA.select({ count: sql<number>`count(*)::int` }).from(users),
  );
  if (empty?.count !== 0)
    throw new Error(
      "BLOCKED_NOT_EMPTY: disposable fixture database must be empty",
    );
  await scoped(() =>
    dbA.insert(users).values({ id: owner, email: `${owner}@example.test` }),
  );
  initialized = true;
});
afterAll(async () => {
  if (initialized) {
    if (ids.length)
      await scoped(() =>
        dbA.delete(approvalRequests).where(inArray(approvalRequests.id, ids)),
      );
    if (threadIds.length)
      await scoped(() =>
        dbA.delete(threads).where(inArray(threads.id, threadIds)),
      );
    await scoped(() => dbA.delete(users).where(eq(users.id, owner)));
  }
  await dbA.$client.close();
  await dbB.$client.close();
});
class FixtureAgent extends AbstractAgent {
  run() {
    return EMPTY;
  }
}
class FixtureRunner extends PostgresAgentRunner {
  runs = 0;
  protected override continuationStream(request: AgentRunnerRunRequest) {
    this.runs++;
    request.agent.messages = [
      {
        id: `reply-${request.input.runId}`,
        role: "assistant",
        content: "PG fixture answer",
      },
    ];
    return of<BaseEvent[]>(
      {
        type: EventType.RUN_STARTED,
        threadId: request.threadId,
        runId: request.input.runId,
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "fixture-message",
        delta: "PG fixture answer",
      },
      {
        type: EventType.RUN_FINISHED,
        threadId: request.threadId,
        runId: request.input.runId,
      },
    );
  }
}
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
function faultDatabase(db: Database, phase: "before_commit" | "after_commit") {
  let armed = false;
  const database = new Proxy(db, {
    get(target, property, receiver) {
      if (property !== "transaction")
        return Reflect.get(target, property, receiver);
      return async <T>(fn: (tx: Transaction) => Promise<T>) => {
        if (!armed) return target.transaction(fn);
        const value = await target.transaction(async (tx) => {
          const result = await fn(tx);
          if (phase === "before_commit")
            throw new Error("fixture before commit");
          return result;
        });
        throw new Error(`fixture lost commit ack:${typeof value}`);
      };
    },
  });
  return {
    database,
    arm: () => {
      armed = true;
    },
  };
}
async function setup() {
  const id = crypto.randomUUID();
  ids.push(id);
  const threadId = `target-thread-${id}`;
  threadIds.push(threadId);
  const binding = {
    approvalId: id,
    tenantId: tenant,
    ownerId: owner,
    admissionId: `local-admission-${id}`,
  };
  const identity: ContinuationIdentity = { ...binding, inputDigest: "pending" };
  const agent = new FixtureAgent({ agentId: "pg-fixture-agent" });
  const input = {
    threadId,
    runId: localRunId(identity),
    state: {},
    messages: [],
    tools: [],
    context: [],
    forwardedProps: {},
  };
  agent.threadId = threadId;
  agent.setState(input.state);
  agent.setMessages(input.messages);
  const request: AgentRunnerRunRequest = {
    threadId,
    agent,
    input,
    persistedInputMessages: [],
  };
  identity.inputDigest = localInputDigest(binding, request);
  const plan = localRunPlan(identity, request);
  const targetA = createLocalTargetStore(dbA, dbB, plan, {
    release: fixtureRelease,
  });
  const targetB = createLocalTargetStore(dbB, dbA, plan, {
    release: fixtureRelease,
  });
  if (
    !(await targetA.authorizeRelease()) ||
    !(await targetB.authorizeRelease())
  )
    throw new Error(
      `BLOCKED_CANONICAL_ROLE_RLS_RELEASE:${targetA.releaseReason}:${targetB.releaseReason}`,
    );
  const store = createContinuationStore(dbA, {
    leaseMs: 60000,
    authorizeCurrentProvisioning: async () => true, // fixture provenance, NOT production policy
    verifyNeverAdmittedProof: targetA.verifyNeverAdmittedProof,
    verifyReceipt: targetA.verifyReceipt,
  });
  const action = approvalAction({
    actorId: owner,
    botId: plan.agentId,
    toolRef: "fixture/write",
    effect: "write",
    scope: "fixture",
    args: {},
    target: {},
    continuation: {
      runId: `original-${id}`,
      threadId,
      toolCallId: `call-${id}`,
      toolName: "fixture_write",
      args: {},
      messages: [],
      state: {},
      context: [],
      forwardedProps: {},
    },
  });
  await scoped(() =>
    dbA.insert(approvalRequests).values({
      id,
      tenantId: tenant,
      ownerUserId: owner,
      runId: action.runId,
      toolCallId: action.toolCallId,
      actionDigest: action.actionDigest,
      action,
      status: "consumed",
      decision: "allow_once",
      result: { content: "saved original" },
    }),
  );
  await store.ensure({
    ...identity,
    branchKind: "thread",
    branchTargetId: threadId,
    origin: "current",
  });
  const claimed = await store.claim(identity, "target-worker-a");
  if (claimed.kind !== "acquired") throw new Error("claim missing");
  const lease = claimed.lease;
  const observed = await targetA.observe(lease);
  expect(observed.kind).toBe("never_admitted");
  if (observed.kind !== "never_admitted")
    throw new Error("authoritative negative proof missing");
  const intent = await store.checkpointIntent(lease, observed.proof);
  if (!intent) throw new Error("durable intent missing");
  return { plan, request, lease, intent, targetA, targetB, store };
}
function terminal(h: Awaited<ReturnType<typeof setup>>): LocalTerminal {
  return {
    events: [
      {
        type: EventType.RUN_STARTED,
        threadId: h.plan.threadId,
        runId: h.plan.runId,
      },
      {
        type: EventType.RUN_FINISHED,
        threadId: h.plan.threadId,
        runId: h.plan.runId,
      },
    ],
    messages: [
      {
        id: "terminal-message",
        role: "assistant",
        content: "PG fixture answer",
      },
    ],
    replyText: "PG fixture answer",
    failed: false,
  };
}
async function rows(h: Awaited<ReturnType<typeof setup>>) {
  return scoped(async () => ({
    step: await dbB
      .select()
      .from(approvalContinuationSteps)
      .where(eq(approvalContinuationSteps.approvalId, h.plan.approvalId)),
    run: await dbB
      .select()
      .from(threadRuns)
      .where(eq(threadRuns.id, h.plan.runId)),
    events: await dbB
      .select()
      .from(threadRunEvents)
      .where(eq(threadRunEvents.runId, h.plan.runId)),
  }));
}

test("two real pools reserve unique step/run and only one adapter enters actual AP runner", async () => {
  const h = await setup();
  const a = new FixtureRunner(dbA),
    b = new FixtureRunner(dbB);
  const targetA = createLocalContinuationTurnTarget({
    persistence: h.targetA,
    request: h.request,
    runner: a,
  });
  const targetB = createLocalContinuationTurnTarget({
    persistence: h.targetB,
    request: h.request,
    runner: b,
  });
  const result = await scoped(() =>
    Promise.all([targetA.admit(h.intent), targetB.admit(h.intent)]),
  );
  expect(result.some((x) => x.kind === "completed")).toBe(true);
  expect(a.runs + b.runs).toBe(1);
  expect((await scoped(() => targetA.admit(h.intent))).kind).toBe("completed");
  expect(a.runs + b.runs).toBe(1);
  const saved = await rows(h);
  expect(saved.step).toHaveLength(1);
  expect(saved.run).toHaveLength(1);
  expect(saved.events.length).toBeGreaterThan(2);
  expect(saved.run[0]?.eventCount).toBe(saved.events.length);
  expect(saved.step[0]?.state).toBe("completed");
  expect(saved.step[0]?.receipt).not.toBeNull();
  const receipt = saved.step[0]?.receipt;
  if (!receipt) throw new Error("receipt missing");
  // Real AP-store transaction holds its own row lock while receipt verification
  // uses independent pool B with plain SELECT. This must not deadlock max=1.
  expect(await h.store.complete(h.lease, receipt)).toBe("committed");
  const [approval] = await scoped(() =>
    dbA
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, h.plan.approvalId)),
  );
  expect(approval?.status).toBe("completed");
  expect(approval?.result).toEqual({ content: "saved original" });
});
for (const phase of ["before_commit", "after_commit"] as const) {
  test(`real reserve transaction ${phase}: uncertain acknowledgment cannot run`, async () => {
    const h = await setup();
    const fault = faultDatabase(dbA, phase);
    const faulted = createLocalTargetStore(fault.database, dbB, h.plan, {
      release: fixtureRelease,
    });
    expect(await faulted.authorizeRelease()).toBe(true);
    fault.arm();
    const runner = new FixtureRunner(dbA);
    const adapter = createLocalContinuationTurnTarget({
      persistence: faulted,
      request: h.request,
      runner,
    });
    expect((await scoped(() => adapter.admit(h.intent))).kind).toBe("unknown");
    expect(runner.runs).toBe(0);
    const saved = await rows(h);
    if (phase === "before_commit") {
      expect(saved.step).toHaveLength(0);
      expect(saved.run).toHaveLength(0);
      expect((await h.targetB.observe(h.lease)).kind).toBe("never_admitted");
    } else {
      expect(saved.step).toHaveLength(1);
      expect(saved.run).toHaveLength(1);
      expect(saved.events).toHaveLength(0);
      expect((await h.targetB.observe(h.lease)).kind).toBe("unknown");
      const retry = createLocalContinuationTurnTarget({
        persistence: h.targetB,
        request: h.request,
        runner,
      });
      expect((await scoped(() => retry.admit(h.intent))).kind).toBe("unknown");
      expect(runner.runs).toBe(0);
    }
  });
}
for (const phase of ["before_commit", "after_commit"] as const) {
  test(`terminal full events and receipt share real transaction ${phase}`, async () => {
    const h = await setup();
    expect(await h.targetA.reserve(h.intent)).toBe("reserved");
    expect(await h.targetA.begin(h.intent)).toBe(true);
    const fault = faultDatabase(dbA, phase);
    const faulted = createLocalTargetStore(fault.database, dbB, h.plan, {
      release: fixtureRelease,
    });
    expect(await faulted.authorizeRelease()).toBe(true);
    fault.arm();
    await expect(faulted.saveTerminal(h.intent, terminal(h))).rejects.toThrow();
    const saved = await rows(h);
    if (phase === "before_commit") {
      expect(saved.step[0]?.state).toBe("running");
      expect(saved.step[0]?.receipt).toBeNull();
      expect(saved.run[0]?.eventCount).toBe(0);
      expect(saved.events).toHaveLength(0);
      expect((await h.targetB.observe(h.lease)).kind).toBe("unknown");
    } else {
      expect(saved.step[0]?.state).toBe("completed");
      expect(saved.step[0]?.receipt).not.toBeNull();
      expect(saved.events).toHaveLength(3);
      expect(saved.run[0]?.eventCount).toBe(3);
      expect((await h.targetB.observe(h.lease)).kind).toBe("completed");
    }
  });
}
test("old worker late terminal after actual DB expiry/ABA is rejected with zero journal/receipt", async () => {
  const h = await setup();
  await h.targetA.reserve(h.intent);
  await h.targetA.begin(h.intent);
  await scoped(() =>
    dbB
      .update(approvalContinuations)
      .set({ leaseUntil: sql`clock_timestamp()-interval '1 second'` })
      .where(
        and(
          eq(approvalContinuations.approvalId, h.plan.approvalId),
          eq(approvalContinuations.tenantId, tenant),
        ),
      ),
  );
  const next = await h.store.claim(h.plan, "target-worker-a");
  expect(next.kind).toBe("acquired");
  if (next.kind !== "acquired") throw new Error("takeover missing");
  expect(next.lease.fence).toBeGreaterThan(h.lease.fence);
  await expect(h.targetA.saveTerminal(h.intent, terminal(h))).rejects.toThrow(
    "local_fence_lost",
  );
  const saved = await rows(h);
  expect(saved.events).toHaveLength(0);
  expect(saved.step[0]?.receipt).toBeNull();
  expect((await h.targetB.observe(next.lease)).kind).toBe("unknown");
});
test("owner/tenant/digest/intent mismatch cannot reserve or write terminal", async () => {
  const h = await setup();
  for (const change of [
    { ownerId: "foreign" },
    { tenantId: "foreign" },
    { inputDigest: "foreign" },
    { admissionId: "foreign" },
  ]) {
    await expect(h.targetA.reserve({ ...h.intent, ...change })).rejects.toThrow(
      "local_identity_conflict",
    );
  }
  await expect(
    h.targetA.reserve({ ...h.intent, intentId: "not-durable" }),
  ).rejects.toThrow("local_durable_intent_required");
  await expect(
    h.targetA.reserve({ ...h.intent, proofId: "caller-invented" }),
  ).rejects.toThrow("local_durable_intent_required");
  expect((await rows(h)).step).toHaveLength(0);
});
test("receipt is checked against immutable run journal, not mutable latest thread snapshot", async () => {
  const h = await setup();
  await h.targetA.reserve(h.intent);
  await h.targetA.begin(h.intent);
  const receipt = await h.targetA.saveTerminal(h.intent, terminal(h));
  expect(await h.targetA.verifyReceipt(receipt)).toBe(true);
  await scoped(() =>
    dbA
      .update(threads)
      .set({ messagesSnapshot: sql`'[]'::jsonb` })
      .where(eq(threads.id, h.plan.threadId)),
  );
  expect(await h.targetA.verifyReceipt(receipt)).toBe(true);
  await scoped(() =>
    dbA
      .update(threadRunEvents)
      .set({
        event: sql`${JSON.stringify({ type: EventType.RUN_ERROR, message: "tampered" })}::jsonb`,
      })
      .where(
        and(
          eq(threadRunEvents.runId, h.plan.runId),
          eq(threadRunEvents.seq, 0),
        ),
      ),
  );
  await expect(h.targetA.verifyReceipt(receipt)).rejects.toThrow();
});
