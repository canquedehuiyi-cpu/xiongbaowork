import { afterAll, expect, test } from "bun:test";
import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type RunAgentInput,
} from "@ag-ui/client";
import type { AgentRunnerRunRequest } from "@copilotkit/runtime/v2";
import { EMPTY, Observable, of } from "rxjs";
import type { Database } from "../src/db/client";
import type {
  ContinuationIdentity,
  ContinuationLease,
  DispatchIntent,
  TargetObservation,
} from "../src/approvals/continuation-protocol";
import {
  localInputDigest,
  localProofId,
  localReceipt,
  localRunId,
  localRunPlan,
  type LocalReceipt,
  type LocalRunTicket,
  type LocalTargetPersistence,
  type LocalTerminal,
} from "../src/approvals/continuation-target-local";
import { createLocalTargetStore } from "../src/approvals/continuation-target-store";
import { createLocalContinuationTurnTarget } from "../src/routines/run-turn";
import { PostgresAgentRunner } from "../src/threads/postgres-runner";
import { runAsTenant } from "../src/tenant/context";
import type { QuotaService } from "../src/quota/limits";
import {
  configureBotLifecycle,
  checkRunningTurnsForTests,
  resetBotLifecycleForTests,
} from "../src/agents/lifecycle";

// CPU ONLY: this fake persistence is an explicit fault seam, not PG/CAS proof.
// The actual runner and new run-turn entry are imported, never module-mocked.
const noDatabase = () =>
  new Proxy({} as Database, {
    get() {
      throw new Error("CPU database forbidden");
    },
  });
class IdleAgent extends AbstractAgent {
  aborts = 0;
  override abortRun() {
    this.aborts++;
    super.abortRun();
  }
  run() {
    return EMPTY;
  }
}
function inputFixture(
  agent: AbstractAgent = new IdleAgent({ agentId: "fixture-agent" }),
) {
  const seed = crypto.randomUUID();
  const binding = {
    approvalId: `approval-${seed}`,
    ownerId: "fixture-owner",
    tenantId: "fixture-owner",
    admissionId: `admission-${seed}`,
  };
  const identity: ContinuationIdentity = { ...binding, inputDigest: "pending" };
  const input: RunAgentInput = {
    threadId: `thread-${seed}`,
    runId: localRunId(identity),
    state: {},
    messages: [],
    tools: [],
    context: [],
    forwardedProps: {},
  };
  agent.threadId = input.threadId;
  agent.setMessages(input.messages);
  agent.setState(input.state);
  const request: AgentRunnerRunRequest = {
    threadId: input.threadId,
    agent,
    input,
    persistedInputMessages: [],
  };
  identity.inputDigest = localInputDigest(binding, request);
  const plan = localRunPlan(identity, request);
  const lease: ContinuationLease = {
    ...identity,
    workerId: "worker-a",
    fence: 1n,
  };
  const intent: DispatchIntent = {
    ...lease,
    intentId: "durable-intent",
    proofId: localProofId(lease),
  };
  return { plan, request, lease, intent };
}
function persistenceFixture(value: ReturnType<typeof inputFixture>) {
  let state: "absent" | "reserved" | "running" | "completed" = "absent";
  let receipt: LocalReceipt | undefined;
  let live = true;
  let beginAckLost = false;
  let reserveAckLost = false;
  let saveFailure: "none" | "before" | "after" = "none";
  let saveGate: (() => Promise<void>) | undefined;
  let terminal: LocalTerminal | undefined;
  let reserves = 0,
    starts = 0,
    saves = 0;
  const persistence: LocalTargetPersistence = {
    plan: value.plan,
    enabled: true,
    async observe(lease): Promise<TargetObservation> {
      if (state === "completed" && receipt)
        return receipt.failed
          ? { kind: "unknown" }
          : { kind: "completed", receipt };
      if (state !== "absent" || !live) return { kind: "unknown" };
      return {
        kind: "never_admitted",
        proof: { ...lease, proofId: localProofId(lease) },
      };
    },
    async reserve(intent) {
      reserves++;
      if (
        !live ||
        intent.fence !== 1n ||
        intent.intentId !== value.intent.intentId
      )
        return "unknown";
      if (state !== "absent") return "unknown";
      state = "reserved";
      if (reserveAckLost) throw new Error("fixture reserve commit ack lost");
      return "reserved";
    },
    async begin(intent) {
      if (!live || intent.fence !== 1n || state !== "reserved") return false;
      state = "running";
      starts++;
      if (beginAckLost) throw new Error("fixture begin commit ack lost");
      return true;
    },
    async saveTerminal(intent, result) {
      saves++;
      await saveGate?.();
      if (!live || intent.fence !== 1n) throw new Error("fixture fence lost");
      if (saveFailure === "before")
        throw new Error("fixture terminal rollback");
      terminal = result;
      receipt = localReceipt(value.plan, intent.fence, result);
      state = "completed";
      if (saveFailure === "after")
        throw new Error("fixture terminal commit ack lost");
      return receipt;
    },
  };
  return {
    persistence,
    loseLease: () => {
      live = false;
    },
    reserveAckLost: () => {
      reserveAckLost = true;
    },
    beginAckLost: () => {
      beginAckLost = true;
    },
    saveFailure: (phase: typeof saveFailure) => {
      saveFailure = phase;
    },
    saveGate: (gate: () => Promise<void>) => {
      saveGate = gate;
    },
    counts: () => ({ reserves, starts, saves }),
    terminal: () => terminal,
  };
}
class ControlledRunner extends PostgresAgentRunner {
  runs = 0;
  drive: (request: AgentRunnerRunRequest) => Observable<BaseEvent> = (
    request,
  ) => {
    request.agent.messages = [
      { id: "reply", role: "assistant", content: "CPU result" },
    ];
    return of(
      {
        type: EventType.RUN_STARTED,
        threadId: request.threadId,
        runId: request.input.runId,
      },
      {
        type: EventType.RUN_FINISHED,
        threadId: request.threadId,
        runId: request.input.runId,
      },
    );
  };
  stopCalls: { threadId: string; runId?: string }[] = [];
  override async stop(request: Parameters<PostgresAgentRunner["stop"]>[0]) {
    this.stopCalls.push({ threadId: request.threadId, runId: request.runId });
    return true;
  }
  constructor(quota?: QuotaService) {
    super(noDatabase(), undefined, quota);
  }
  protected override continuationStream(request: AgentRunnerRunRequest) {
    this.runs++;
    return this.drive(request);
  }
}
function setup(quota?: QuotaService) {
  const value = inputFixture();
  const storage = persistenceFixture(value);
  const runner = new ControlledRunner(quota);
  const target = createLocalContinuationTurnTarget({
    persistence: storage.persistence,
    runner,
    request: value.request,
  });
  return {
    ...value,
    ...storage,
    runner,
    target,
    admit: () =>
      runAsTenant(value.plan.tenantId, () => target.admit(value.intent)),
  };
}

test("real runner/run-turn entry waits for terminal persistence, not stream completion", async () => {
  const h = setup();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  h.saveGate(async () => {
    entered.resolve();
    await release.promise;
  });
  let settled = false;
  const pending = h.admit().then((result) => {
    settled = true;
    return result;
  });
  try {
    await entered.promise;
    expect(h.runner.runs).toBe(1);
    expect(settled).toBe(false);
  } finally {
    release.resolve();
  }
  expect((await pending).kind).toBe("completed");
  expect(h.counts().saves).toBe(1);
});
test("terminal rollback rejects success and sequential retry never re-enters runtime", async () => {
  const h = setup();
  h.saveFailure("before");
  expect((await h.admit()).kind).toBe("unknown");
  expect((await h.admit()).kind).toBe("unknown");
  expect(h.runner.runs).toBe(1);
});
test("terminal commit acknowledgment loss is unknown, explicit reconcile recovers without replay", async () => {
  const h = setup();
  h.saveFailure("after");
  expect((await h.admit()).kind).toBe("unknown");
  expect((await h.target.reconcile(h.lease)).kind).toBe("completed");
  expect((await h.admit()).kind).toBe("completed");
  expect(h.runner.runs).toBe(1);
});
test("two adapter instances and sequential repeat share one CPU reservation; only one runtime call", async () => {
  const h = setup();
  const other = new ControlledRunner();
  const targetB = createLocalContinuationTurnTarget({
    persistence: h.persistence,
    runner: other,
    request: h.request,
  });
  const results = await runAsTenant(h.plan.tenantId, () =>
    Promise.all([h.target.admit(h.intent), targetB.admit(h.intent)]),
  );
  expect(results.some((x) => x.kind === "completed")).toBe(true);
  await h.admit();
  expect(h.runner.runs + other.runs).toBe(1);
});
test("reserve commit followed by process-loss simulation or ack loss is unknown, never a new run", async () => {
  const h = setup();
  h.reserveAckLost();
  expect((await h.admit()).kind).toBe("unknown");
  expect((await h.target.reconcile(h.lease)).kind).toBe("unknown");
  await h.admit();
  expect(h.runner.runs).toBe(0);
});
test("begin commit acknowledgment loss does not enter runtime or emit a negative proof", async () => {
  const h = setup();
  h.beginAckLost();
  expect((await h.admit()).kind).toBe("unknown");
  expect((await h.target.reconcile(h.lease)).kind).toBe("unknown");
  expect(h.runner.runs).toBe(0);
});
test("old fence late terminal loses and cannot claim success", async () => {
  const h = setup();
  h.saveGate(async () => h.loseLease());
  expect((await h.admit()).kind).toBe("unknown");
  expect(h.runner.runs).toBe(1);
  expect((await h.target.reconcile(h.lease)).kind).toBe("unknown");
});
test("error stream persists an admitted failure, never completion or absence", async () => {
  const h = setup();
  h.runner.drive = () =>
    new Observable((subscriber) =>
      subscriber.error(new Error("fixture transport")),
    );
  expect((await h.admit()).kind).toBe("unknown");
  expect(h.terminal()?.failed).toBe(true);
  expect(h.terminal()?.events.at(-1)?.type).toBe(EventType.RUN_ERROR);
  await h.admit();
  expect(h.runner.runs).toBe(1);
});
test("RUN_ERROR on a completed observable is a durable failed terminal", async () => {
  const h = setup();
  h.runner.drive = () =>
    of({ type: EventType.RUN_ERROR, message: "fixture failed" });
  expect((await h.admit()).kind).toBe("unknown");
  expect(h.terminal()?.failed).toBe(true);
  expect(h.counts().saves).toBe(1);
});
test("missing terminal event and empty reply do not become successful receipts", async () => {
  const h = setup();
  h.runner.drive = () => EMPTY;
  expect((await h.admit()).kind).toBe("unknown");
  expect(h.terminal()?.failed).toBe(true);
  expect(h.terminal()?.events.at(-1)?.type).toBe(EventType.RUN_ERROR);
});
test("mutated input, cross owner and caller-created ticket are refused before runtime", async () => {
  const h = setup();
  h.request.input.state = { mutated: true };
  expect((await h.admit()).kind).toBe("unknown");
  expect(h.counts().reserves).toBe(0);
  expect(
    (await h.target.admit({ ...h.intent, ownerId: "foreign-owner" })).kind,
  ).toBe("unknown");
  await expect(
    runAsTenant(h.plan.tenantId, () =>
      h.runner.runContinuation({} as LocalRunTicket, h.request),
    ),
  ).rejects.toThrow();
  expect(h.runner.runs).toBe(0);
});
test("ordinary run cannot enter the reserved AP run namespace via user flags", async () => {
  const h = setup();
  h.request.input.forwardedProps = { apTrusted: true };
  const error = await new Promise<unknown>((resolve) =>
    h.runner.run(h.request).subscribe({ error: resolve }),
  );
  expect(String(error)).toContain("local_target_trusted_entry_required");
  expect(h.runner.runs).toBe(0);
});
test("ordinary empty debug/404-like observation never authorizes admission", async () => {
  const h = setup();
  h.persistence.observe = async () => ({ kind: "not_found" });
  expect((await h.target.reconcile(h.lease)).kind).toBe("not_found");
  expect(h.runner.runs).toBe(0);
});
test("absent Root release has no capability and never touches DB or runtime", async () => {
  const h = setup();
  const store = createLocalTargetStore(noDatabase(), noDatabase(), h.plan);
  const unverified = createLocalTargetStore(
    noDatabase(),
    noDatabase(),
    h.plan,
    {
      release: {
        async readVerifiedRelease() {
          return null;
        },
      },
    },
  );
  expect(unverified.enabled).toBe(false); // merely configuring a callback never enables capability
  expect(await store.authorizeRelease()).toBe(false);
  const target = createLocalContinuationTurnTarget({
    persistence: store,
    runner: h.runner,
    request: h.request,
  });
  expect(Object.values(target.capabilities)).toEqual([false, false, false]);
  expect((await target.admit(h.intent)).kind).toBe("unknown");
  expect((await target.reconcile(h.lease)).kind).toBe("unknown");
  expect(
    await store.verifyNeverAdmittedProof({
      ...h.lease,
      proofId: localProofId(h.lease),
    }),
  ).toBe(false);
  expect(h.runner.runs).toBe(0);
});

class SdkAgent extends AbstractAgent {
  calls = 0;
  run(input: RunAgentInput) {
    this.calls++;
    return of(
      {
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      },
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "sdk-answer",
        role: "assistant",
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "sdk-answer",
        delta: "Real SDK CPU",
      },
      { type: EventType.TEXT_MESSAGE_END, messageId: "sdk-answer" },
      {
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
      },
    );
  }
}
test("real locked local SDK with in-process agent preserves full events before CPU receipt", async () => {
  const agent = new SdkAgent({ agentId: "sdk-fixture-agent" });
  const h = inputFixture(agent);
  const storage = persistenceFixture(h);
  const runner = new PostgresAgentRunner(noDatabase());
  const target = createLocalContinuationTurnTarget({
    persistence: storage.persistence,
    request: h.request,
    runner,
  });
  const result = await runAsTenant(h.plan.tenantId, () =>
    target.admit(h.intent),
  );
  expect(result.kind).toBe("completed");
  expect(agent.calls).toBe(1);
  expect(storage.terminal()?.replyText).toBe("Real SDK CPU");
  expect(
    storage
      .terminal()
      ?.events.some(
        (event) =>
          event.type === EventType.TEXT_MESSAGE_CONTENT &&
          "delta" in event &&
          event.delta === "Real SDK CPU",
      ),
  ).toBe(true);
  await runAsTenant(h.plan.tenantId, () => target.admit(h.intent));
  expect(agent.calls).toBe(1);
});

afterAll(() => {
  const audit = Reflect.get(globalThis, "__AP_TARGET_NETWORK_AUDIT__");
  if (typeof audit === "function") {
    const attempts: unknown = audit();
    console.log(`AP_TARGET_NETWORK_ATTEMPTS=${String(attempts)}`);
    expect(attempts).toBe(0);
  }
});

test("input changes during begin round trip are refused before runtime", async () => {
  const h = setup();
  const begin = h.persistence.begin.bind(h.persistence);
  h.persistence.begin = async (intent) => {
    const admitted = await begin(intent);
    h.request.input.state = { changedDuringBegin: true };
    return admitted;
  };
  expect((await h.admit()).kind).toBe("unknown");
  expect(h.runner.runs).toBe(0);
  expect(h.counts().saves).toBe(0);
});
test("lease lost between reservation and start never enters runtime", async () => {
  const h = setup();
  const reserve = h.persistence.reserve.bind(h.persistence);
  h.persistence.reserve = async (intent) => {
    const result = await reserve(intent);
    h.loseLease();
    return result;
  };
  expect((await h.admit()).kind).toBe("unknown");
  expect(h.runner.runs).toBe(0);
  expect(h.counts().saves).toBe(0);
});

test("unserializable event capture cannot commit a partial terminal journal", async () => {
  const h = setup();
  h.runner.drive = (request) =>
    of(
      { type: EventType.CUSTOM, name: "fixture-uncloneable", value: () => 0 },
      {
        type: EventType.RUN_FINISHED,
        threadId: request.threadId,
        runId: request.input.runId,
      },
    );
  expect((await h.admit()).kind).toBe("unknown");
  expect(h.runner.runs).toBe(1);
  expect(h.counts().saves).toBe(0);
  await h.admit();
  expect(h.runner.runs).toBe(1);
});

// r2 regressions. Mutations are queued by the helper's post-begin digest read,
// then execute AFTER that helper resolves but BEFORE the awaiting runner resumes.
// They intentionally leave the agent's thread/messages/state unchanged.
for (const field of [
  "tools",
  "context",
  "forwardedProps",
  "persistedInputMessages",
] as const) {
  test(`r2 P2-1 after-ticket-resolve microtask mutates ${field}: zero runtime and terminal save`, async () => {
    const h = setup();
    let armed = false,
      queued = false,
      mutated = false;
    let context = h.request.input.context;
    const begin = h.persistence.begin.bind(h.persistence);
    h.persistence.begin = async (intent) => {
      const value = await begin(intent);
      armed = true;
      return value;
    };
    Object.defineProperty(h.request.input, "context", {
      enumerable: true,
      configurable: true,
      get() {
        if (armed && !queued) {
          queued = true;
          queueMicrotask(() => {
            if (field === "tools")
              h.request.input.tools = [
                {
                  name: "microtask_tool",
                  description: "fixture",
                  parameters: {},
                },
              ];
            else if (field === "context")
              context = [
                { description: "fixture", value: "microtask context" },
              ];
            else if (field === "forwardedProps")
              h.request.input.forwardedProps = { microtask: true };
            else
              h.request.persistedInputMessages = [
                { id: "microtask-message", role: "user", content: "fixture" },
              ];
            mutated = true;
          });
        }
        return context;
      },
      set(value: RunAgentInput["context"]) {
        context = value;
      },
    });
    const result = await h.admit();
    console.log(
      `P2_1_FIELD=${field} queued=${queued} mutated=${mutated} starts=${h.counts().starts} runtime=${h.runner.runs} saves=${h.counts().saves} outcome=${result.kind}`,
    );
    expect(mutated).toBe(true);
    expect(result.kind).toBe("unknown");
    expect(h.counts().starts).toBe(1);
    expect(h.runner.runs).toBe(0);
    expect(h.counts().saves).toBe(0);
    expect((await h.target.reconcile(h.lease)).kind).toBe("unknown");
  });
}

// Only the real lifecycle guard creates the signal. The DB-shaped pause read
// below is a CPU fixture, not PostgreSQL evidence and not a production authority.
function lifecycleFixture() {
  resetBotLifecycleForTests();
  let paused = false;
  const query = {
    from() {
      return query;
    },
    where() {
      return query;
    },
    async limit() {
      return [{ pausedAt: paused ? new Date(0) : null }];
    },
  };
  const database = new Proxy({} as Database, {
    get(_target, property) {
      if (property === "select") return () => query;
      throw new Error("CPU lifecycle database operation forbidden");
    },
  });
  configureBotLifecycle({ database });
  return {
    async pause() {
      paused = true;
      await checkRunningTurnsForTests();
    },
    reset: resetBotLifecycleForTests,
  };
}

test("r2 P2-2 trusted guard pauses after guard before runner: no runtime or negative proof", async () => {
  const lifecycle = lifecycleFixture();
  const h = setup();
  const target = createLocalContinuationTurnTarget({
    persistence: h.persistence,
    request: h.request,
    runner: {
      async runContinuation(ticket, request, signal?: AbortSignal) {
        await lifecycle.pause();
        return h.runner.runContinuation(ticket, request, signal);
      },
    },
  });
  try {
    const result = await runAsTenant(h.plan.tenantId, () =>
      target.admit(h.intent),
    );
    console.log(
      `P2_2_AFTER_GUARD runtime=${h.runner.runs} saves=${h.counts().saves} outcome=${result.kind}`,
    );
    expect(result.kind).toBe("unknown");
    expect(h.runner.runs).toBe(0);
    expect(h.counts().saves).toBe(0);
    expect(h.counts().starts).toBe(0);
    expect((await target.reconcile(h.lease)).kind).toBe("unknown");
  } finally {
    lifecycle.reset();
  }
});
test("r2 P2-2 trusted pause during quota wait prevents admission and runtime", async () => {
  const lifecycle = lifecycleFixture();
  const unusedQuotaMethod = async () => {
    throw new Error("unused CPU quota method");
  };
  const quota: QuotaService = {
    async assertCapacity() {
      await lifecycle.pause();
    },
    planFor: unusedQuotaMethod,
    usageFor: unusedQuotaMethod,
    recordTask: unusedQuotaMethod,
    assertCapacityWithin: unusedQuotaMethod,
    recordTaskWithin: unusedQuotaMethod,
  };
  const h = setup(quota);
  try {
    const result = await h.admit();
    console.log(
      `P2_2_QUOTA runtime=${h.runner.runs} saves=${h.counts().saves} outcome=${result.kind}`,
    );
    expect(result.kind).toBe("unknown");
    expect(h.runner.runs).toBe(0);
    expect(h.counts().saves).toBe(0);
    expect(h.counts().starts).toBe(0);
    expect((await h.target.reconcile(h.lease)).kind).toBe("unknown");
  } finally {
    lifecycle.reset();
  }
});
test("r2 P2-2 trusted pause while begin waits prevents final SDK entry", async () => {
  const lifecycle = lifecycleFixture();
  const h = setup();
  const begin = h.persistence.begin.bind(h.persistence);
  h.persistence.begin = async (intent) => {
    const value = await begin(intent);
    await lifecycle.pause();
    return value;
  };
  try {
    const result = await h.admit();
    console.log(
      `P2_2_BEGIN runtime=${h.runner.runs} saves=${h.counts().saves} outcome=${result.kind}`,
    );
    expect(result.kind).toBe("unknown");
    expect(h.runner.runs).toBe(0);
    expect(h.counts().saves).toBe(0);
    expect(h.counts().starts).toBe(1);
    expect((await h.target.reconcile(h.lease)).kind).toBe("unknown");
  } finally {
    lifecycle.reset();
  }
});
test("r2 P2-2 stream pause stops exact run once, tears down listener and never saves success or replays", async () => {
  const lifecycle = lifecycleFixture();
  const h = setup();
  const entered = Promise.withResolvers<void>();
  let finish = () => {};
  let teardown = 0;
  let added = 0;
  let removed = 0;
  let guardedSignal: AbortSignal | undefined;
  h.runner.drive = (request) =>
    new Observable((subscriber) => {
      finish = () => {
        request.agent.messages = [
          { id: "pause-reply", role: "assistant", content: "must not succeed" },
        ];
        subscriber.next({
          type: EventType.RUN_FINISHED,
          threadId: request.threadId,
          runId: request.input.runId,
        });
        subscriber.complete();
      };
      entered.resolve();
      return () => {
        teardown++;
      };
    });
  const agent = h.request.agent;
  let aborts = 0;
  agent.abortRun = () => {
    aborts++;
    guardedSignal?.dispatchEvent(new Event("abort"));
  };
  const target = createLocalContinuationTurnTarget({
    persistence: h.persistence,
    request: h.request,
    runner: {
      async runContinuation(ticket, request, signal?: AbortSignal) {
        guardedSignal = signal;
        if (signal) {
          const add = signal.addEventListener.bind(signal);
          const remove = signal.removeEventListener.bind(signal);
          signal.addEventListener = (
            ...args: Parameters<AbortSignal["addEventListener"]>
          ) => {
            if (args[0] === "abort") added++;
            return add(...args);
          };
          signal.removeEventListener = (
            ...args: Parameters<AbortSignal["removeEventListener"]>
          ) => {
            if (args[0] === "abort") removed++;
            return remove(...args);
          };
        }
        return h.runner.runContinuation(ticket, request, signal);
      },
    },
  });
  const pending = runAsTenant(h.plan.tenantId, () => target.admit(h.intent));
  try {
    await entered.promise;
    await lifecycle.pause();
    // Bound the RED control too: r1 ignores pause, so manually completing the
    // fixture reveals its false success instead of hanging/changing timeout.
    finish();
    const result = await pending;
    console.log(
      `P2_2_STREAM runtime=${h.runner.runs} saves=${h.counts().saves} aborts=${aborts} stop=${h.runner.stopCalls.length} teardown=${teardown} listener=${added}/${removed} outcome=${result.kind}`,
    );
    expect(result.kind).toBe("unknown");
    expect(h.runner.runs).toBe(1);
    expect(h.counts().saves).toBe(0);
    expect(aborts).toBe(1);
    expect(h.runner.stopCalls).toEqual([
      { threadId: h.plan.threadId, runId: h.plan.runId },
    ]);
    expect(teardown).toBe(1);
    expect(added).toBe(1);
    expect(removed).toBe(1);
    expect((await target.reconcile(h.lease)).kind).toBe("unknown");
    expect(
      (await runAsTenant(h.plan.tenantId, () => target.admit(h.intent))).kind,
    ).toBe("unknown");
    expect(h.runner.runs).toBe(1);
  } finally {
    finish();
    await pending;
    lifecycle.reset();
  }
});

test("r3 teardown throwing during trusted pause settles unknown and stops exact run once", async () => {
  const lifecycle = lifecycleFixture();
  const h = setup();
  const entered = Promise.withResolvers<void>();
  let finish = () => {};
  let teardown = 0;
  let added = 0;
  let removed = 0;
  let guardedSignal: AbortSignal | undefined;
  h.runner.drive = (request) =>
    new Observable((subscriber) => {
      finish = () => {
        request.agent.messages = [
          { id: "pause-reply", role: "assistant", content: "must not succeed" },
        ];
        subscriber.next({
          type: EventType.RUN_FINISHED,
          threadId: request.threadId,
          runId: request.input.runId,
        });
        subscriber.complete();
      };
      entered.resolve();
      return () => {
        teardown++;
        throw new Error("PRIVATE_DRIVER_TEARDOWN_DETAIL");
      };
    });
  const agent = h.request.agent;
  let aborts = 0;
  agent.abortRun = () => {
    aborts++;
    guardedSignal?.dispatchEvent(new Event("abort"));
  };
  const target = createLocalContinuationTurnTarget({
    persistence: h.persistence,
    request: h.request,
    runner: {
      async runContinuation(ticket, request, signal?: AbortSignal) {
        guardedSignal = signal;
        if (signal) {
          const add = signal.addEventListener.bind(signal);
          const remove = signal.removeEventListener.bind(signal);
          signal.addEventListener = (
            ...args: Parameters<AbortSignal["addEventListener"]>
          ) => {
            if (args[0] === "abort") added++;
            return add(...args);
          };
          signal.removeEventListener = (
            ...args: Parameters<AbortSignal["removeEventListener"]>
          ) => {
            if (args[0] === "abort") removed++;
            return remove(...args);
          };
        }
        return h.runner.runContinuation(ticket, request, signal);
      },
    },
  });
  const pending = runAsTenant(h.plan.tenantId, () => target.admit(h.intent));
  try {
    await entered.promise;
    let pauseFailed = false;
    try {
      await lifecycle.pause();
    } catch {
      pauseFailed = true;
    }
    // Bound the RED control too: r1 ignores pause, so manually completing the
    // fixture reveals its false success instead of hanging/changing timeout.
    const result = await pending;
    console.log(
      `R3_TEARDOWN runtime=${h.runner.runs} saves=${h.counts().saves} aborts=${aborts} stop=${h.runner.stopCalls.length} teardown=${teardown} listener=${added}/${removed} outcome=${result.kind}`,
    );
    expect(pauseFailed).toBe(false);
    expect(result.kind).toBe("unknown");
    expect(h.runner.runs).toBe(1);
    expect(h.counts().saves).toBe(0);
    expect(aborts).toBe(1);
    expect(h.runner.stopCalls).toEqual([
      { threadId: h.plan.threadId, runId: h.plan.runId },
    ]);
    expect(teardown).toBe(1);
    expect(added).toBe(1);
    expect(removed).toBe(1);
    expect((await target.reconcile(h.lease)).kind).toBe("unknown");
    expect(
      (await runAsTenant(h.plan.tenantId, () => target.admit(h.intent))).kind,
    ).toBe("unknown");
    expect(h.runner.runs).toBe(1);
  } finally {
    finish();
    lifecycle.reset();
  }
});
