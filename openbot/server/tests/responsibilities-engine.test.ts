import { expect, test } from "bun:test";
import { HeadlessToolSuspension } from "../src/computer/headless-tools";
import { createResponsibilityEngine } from "../src/responsibilities/engine";
import {
  parseResponsibilityInput,
  parseResponsibilityEvent,
  type ResponsibilityRunContext,
  type ResponsibilityRunOutcome,
} from "../src/responsibilities/types";
import type { WorkItem } from "../src/work/queue";

function runContext(): ResponsibilityRunContext {
  return {
    runId: "run-1",
    responsibilityId: "goal-1",
    ownerUserId: "person-1",
    agentId: "bot-1",
    channelId: "channel-1",
    threadId: "thread-1",
    instruction: "Produce the quarterly graph",
    successCriteria: "Graph is visible",
    progress: "",
    eventId: "event-1",
    event: { source: "github", type: "issue.opened", payload: { number: 8 } },
    continuation: null,
  };
}

function fixture(
  runTurn: (
    input: ResponsibilityRunContext & { signal: AbortSignal },
  ) => Promise<{ replyText: string }>,
) {
  const outcomes: ResponsibilityRunOutcome[] = [];
  const finished: string[] = [];
  const context = runContext();
  let available = true;
  const item: WorkItem = {
    kind: "responsibility.run",
    key: "run-1",
    payload: { runId: "run-1" },
    attempts: 1,
  };
  const engine = createResponsibilityEngine({
    store: {
      async ingestEvent() {
        return { eventId: "event-1", duplicate: false, runIds: ["run-1"] };
      },
      async beginRun() {
        if (!available) return null;
        available = false;
        return context;
      },
      async settleRun(_id, outcome) {
        outcomes.push(outcome);
      },
    },
    queue: {
      async claim() {
        return [item];
      },
      async renew() {
        return true;
      },
      async finish(input) {
        finished.push(input.key);
        return true;
      },
    },
    runTurn,
  });
  return { engine, outcomes, finished };
}

test("validates finite goals and authenticated normalized event shape", () => {
  expect(() =>
    parseResponsibilityInput({
      agentId: "bot",
      channelId: "channel",
      title: " ",
      instruction: "do",
      successCriteria: "done",
    }),
  ).toThrow();
  expect(() =>
    parseResponsibilityEvent({
      ownerUserId: "person",
      source: "github",
      externalId: "",
      type: "issue",
      payload: {},
    }),
  ).toThrow();
  expect(
    parseResponsibilityInput({
      agentId: "bot",
      channelId: "channel",
      title: "Quarterly graph",
      instruction: "Draw graph",
      successCriteria: "Graph is visible",
      subscriptions: [{ source: "github", eventType: "issue.opened" }],
    }).subscriptions,
  ).toHaveLength(1);
});

test("runs the selected owned Bot once and preserves its progress reply", async () => {
  const received: ResponsibilityRunContext[] = [];
  const { engine, outcomes, finished } = fixture(async (input) => {
    received.push(input);
    return { replyText: "The quarterly graph is ready." };
  });
  await engine.dispatch({ owner: "replica-1" });
  await engine.dispatch({ owner: "replica-2" });
  expect(received).toHaveLength(1);
  expect(received[0]?.agentId).toBe("bot-1");
  expect(outcomes).toEqual([
    { status: "succeeded", replyText: "The quarterly graph is ready." },
  ]);
  expect(finished).toEqual(["run-1", "run-1"]);
});

test("suspension persists the canonical waiting action and does not retry", async () => {
  let calls = 0;
  const waiting = {
    kind: "approval",
    requestId: "approval-1",
    toolCallId: "tool-1",
    args: { destination: "team" },
    runId: "canonical-run",
  };
  const { engine, outcomes } = fixture(async () => {
    calls += 1;
    throw new HeadlessToolSuspension("Approve this message", waiting);
  });
  const report = await engine.dispatch({ owner: "replica-1" });
  await engine.dispatch({ owner: "replica-2" });
  expect(calls).toBe(1);
  expect(report.waiting).toEqual(["run-1"]);
  expect(outcomes).toEqual([
    { status: "waiting", waiting, error: "Approve this message" },
  ]);
});

test("a failed selected-agent turn is recorded and never silently retried", async () => {
  let calls = 0;
  const { engine, outcomes } = fixture(async () => {
    calls += 1;
    throw new Error("Agent transport unavailable");
  });
  const report = await engine.dispatch({ owner: "replica-1" });
  await engine.dispatch({ owner: "replica-2" });
  expect(calls).toBe(1);
  expect(report.failed).toEqual([
    { runId: "run-1", error: "Agent transport unavailable" },
  ]);
  expect(outcomes).toEqual([
    { status: "failed", error: "Agent transport unavailable" },
  ]);
});

/**
 * The task board an event-triggered goal leaves behind (ticket 020, spec C2).
 *
 * A separate fixture rather than the shared one, because everything above this line is about the
 * lease and the retry arithmetic — and those tests must keep proving what they prove whether or not
 * a board is wired in. A deployment with no board still has to run its goals.
 */
type Board = Pick<
  import("../src/tasks/projector").TaskProjector,
  "opened" | "finished"
>;

function cardFixture(
  runTurn: (
    input: ResponsibilityRunContext & { signal: AbortSignal },
  ) => Promise<{ replyText: string }>,
  options: { overQuota?: boolean } = {},
) {
  const cards: { kind: string; [key: string]: unknown }[] = [];
  const outcomes: ResponsibilityRunOutcome[] = [];
  const finished: string[] = [];
  const context = runContext();
  const item: WorkItem = {
    kind: "responsibility.run",
    key: "run-1",
    payload: { runId: "run-1" },
    attempts: 1,
  };
  const board: Board = {
    async opened(input) {
      cards.push({ kind: "opened", ...input });
      return "task-1";
    },
    async finished(input) {
      cards.push({ kind: "finished", ...input });
    },
  };
  const engine = createResponsibilityEngine({
    store: {
      async ingestEvent() {
        return { eventId: "event-1", duplicate: false, runIds: ["run-1"] };
      },
      async beginRun() {
        return context;
      },
      async settleRun(_id, outcome) {
        outcomes.push(outcome);
      },
    },
    queue: {
      async claim() {
        return [item];
      },
      async renew() {
        return true;
      },
      async finish(input) {
        finished.push(input.key);
        return true;
      },
    },
    runTurn,
    board,
    quota: {
      async assertCapacity() {
        if (options.overQuota) {
          const { QuotaExceeded } = await import("../src/quota/limits");
          throw new QuotaExceeded("tasksPerMonth", 50, 50, "Free");
        }
      },
    } as unknown as import("../src/quota/limits").QuotaService,
    deviceIdOf: async () => "laptop-1",
  });
  return { engine, cards, outcomes, finished };
}

test("an event that woke a coworker opens one card and closes it on the same run", async () => {
  const { engine, cards, outcomes } = cardFixture(async () => ({
    replyText: "The quarterly graph is ready.",
  }));

  await engine.dispatch({ owner: "replica-1" });

  expect(cards[0]).toMatchObject({
    kind: "opened",
    tenantId: "person-1",
    executorAgentId: "bot-1",
    source: "responsibility",
    channelRef: "channel-1",
    runRef: "run-1",
    // Device mode: the board has to say which machine the work happened on, the same fact a chat
    // run carries, or the machine filter answers differently depending on how the work started.
    deviceId: "laptop-1",
  });
  expect(cards[1]).toMatchObject({
    kind: "finished",
    tenantId: "person-1",
    runRef: "run-1",
  });
  expect(outcomes[0]).toMatchObject({ status: "succeeded" });
});

test("a goal that failed closes its card as failed", async () => {
  const { engine, cards } = cardFixture(async () => {
    throw new Error("the model refused");
  });

  await engine.dispatch({ owner: "replica-1" });

  expect(cards[1]).toMatchObject({ kind: "finished", failed: true });
});

test("a goal waiting on a person reviews, and is not filed against an approval it does not have", async () => {
  const { engine, cards } = cardFixture(async () => {
    throw new HeadlessToolSuspension("Approve this message", {
      kind: "approval",
      requestId: "approval-1",
    });
  });

  await engine.dispatch({ owner: "replica-1" });

  // `finished` without `failed` is the review lane. Nothing here writes an approval id: the card is
  // not held against a row nobody created.
  expect(cards[1]).toMatchObject({ kind: "finished" });
  expect(cards[1]).not.toMatchObject({ failed: true });
});

test("over the month's ceiling the goal is skipped without a card and without a turn", async () => {
  let turns = 0;
  const { engine, cards, outcomes, finished } = cardFixture(
    async () => {
      turns += 1;
      return { replyText: "should not happen" };
    },
    { overQuota: true },
  );

  const report = await engine.dispatch({ owner: "replica-1" });

  expect(turns).toBe(0);
  expect(cards).toEqual([]);
  expect(outcomes).toEqual([
    {
      status: "skipped",
      error: "The Free plan allows 50 tasks per month; this workspace is using 50.",
    },
  ]);
  // The lease is handed back like every other skip: a skipped goal must not sit claimed until expiry.
  expect(finished).toEqual(["run-1"]);
  expect(report.skipped).toEqual(["run-1"]);
});
