import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AP_LOCAL_RECOVERY_UNWIRED } from "../src/approvals/local-recovery-composition";
import {
  abandonedWorkPhases,
  REAPED_ROUTINE_RUN,
  RECOVERY_SWEEP_KIND,
  type RecoveryPhaseName,
  recoveryBucketKey,
  sweepAbandonedWork,
} from "../src/recovery/abandoned-work";
import type { WorkItem, WorkQueue } from "../src/work/queue";

/**
 * Audit defect #10, the unit half: the sweep's control flow with fakes, and the wire from the server
 * and the CronJob to it, read as source (the server cannot be imported without starting it).
 *
 * The behaviour against real PostgreSQL, RLS and two concurrent replicas is
 * `restart-recovery-sweep.integration.test.ts`.
 */

type FakeQueue = Pick<
  WorkQueue,
  "offer" | "claim" | "renew" | "finish" | "release"
> & {
  calls: string[];
};

function fakeQueue(input: {
  claimed: (key: string) => WorkItem[];
  renew?: () => boolean;
  finish?: () => boolean;
}): FakeQueue {
  const calls: string[] = [];
  let offered = "";
  return {
    calls,
    offer: async ({ kind, key }) => {
      calls.push(`offer:${kind}:${key}`);
      offered = key;
      return "queued";
    },
    claim: async () => {
      calls.push("claim");
      return input.claimed(offered);
    },
    renew: async ({ key }) => {
      calls.push(`renew:${key}`);
      return input.renew ? input.renew() : true;
    },
    finish: async ({ key }) => {
      calls.push(`finish:${key}`);
      return input.finish ? input.finish() : true;
    },
    release: async ({ key }) => {
      calls.push(`release:${key}`);
      return true;
    },
  };
}

const item = (key: string): WorkItem => ({
  kind: RECOVERY_SWEEP_KIND,
  key,
  tenantId: "platform",
  payload: {},
  attempts: 1,
});

function recordingPhases(order: string[], throwing?: RecoveryPhaseName) {
  const phase = (name: RecoveryPhaseName, count: number) => async () => {
    order.push(name);
    if (name === throwing) throw new Error(`${name} broke`);
    return count;
  };
  return {
    routineRuns: phase("routineRuns", 1),
    pipelineRuns: phase("pipelineRuns", 2),
    cards: phase("cards", 3),
  };
}

test("the winner runs runs-then-cards in order, renews before each later phase, and finishes", async () => {
  const order: string[] = [];
  const queue = fakeQueue({ claimed: (key) => [item(key)] });
  const report = await sweepAbandonedWork({
    queue,
    owner: "replica-a",
    phases: recordingPhases(order),
    key: "bucket-1",
  });
  expect(order).toEqual(["routineRuns", "pipelineRuns", "cards"]);
  expect(report).toMatchObject({
    won: true,
    routineRuns: 1,
    pipelineRuns: 2,
    cards: 3,
    failed: [],
    leaseLost: false,
  });
  expect(queue.calls).toEqual([
    `offer:${RECOVERY_SWEEP_KIND}:bucket-1`,
    "claim",
    "renew:bucket-1",
    "renew:bucket-1",
    "finish:bucket-1",
  ]);
});

test("a replica that does not win this bucket runs no phase", async () => {
  const order: string[] = [];
  const queue = fakeQueue({ claimed: () => [] });
  const report = await sweepAbandonedWork({
    queue,
    owner: "replica-b",
    phases: recordingPhases(order),
    key: "bucket-1",
  });
  expect(report.won).toBe(false);
  expect(order).toEqual([]);
  expect(queue.calls).toEqual([
    `offer:${RECOVERY_SWEEP_KIND}:bucket-1`,
    "claim",
  ]);
});

test("an older bucket whose holder died is retired, not treated as a win", async () => {
  const order: string[] = [];
  const queue = fakeQueue({ claimed: () => [item("bucket-0")] });
  const report = await sweepAbandonedWork({
    queue,
    owner: "replica-b",
    phases: recordingPhases(order),
    key: "bucket-1",
  });
  expect(report.won).toBe(false);
  expect(order).toEqual([]);
  expect(queue.calls).toContain("finish:bucket-0");
});

test("a newer bucket from a replica whose clock runs ahead is handed back, not closed", async () => {
  const order: string[] = [];
  const queue = fakeQueue({ claimed: () => [item("bucket-2")] });
  const report = await sweepAbandonedWork({
    queue,
    owner: "replica-b",
    phases: recordingPhases(order),
    key: "bucket-1",
  });
  expect(report.won).toBe(false);
  expect(order).toEqual([]);
  expect(queue.calls).toContain("release:bucket-2");
  expect(queue.calls).not.toContain("finish:bucket-2");
});

test("a lease lost during the last phase is reported, not passed off as a clean win", async () => {
  const order: string[] = [];
  const report = await sweepAbandonedWork({
    queue: fakeQueue({ claimed: (key) => [item(key)], finish: () => false }),
    owner: "replica-a",
    phases: recordingPhases(order),
    key: "bucket-1",
  });
  expect(order).toEqual(["routineRuns", "pipelineRuns", "cards"]);
  expect(report.won).toBe(true);
  expect(report.leaseLost).toBe(true);
});

test("one failing phase is reported and does not stop the others", async () => {
  const order: string[] = [];
  const report = await sweepAbandonedWork({
    queue: fakeQueue({ claimed: (key) => [item(key)] }),
    owner: "replica-a",
    phases: recordingPhases(order, "pipelineRuns"),
    key: "bucket-1",
  });
  expect(order).toEqual(["routineRuns", "pipelineRuns", "cards"]);
  expect(report.failed).toEqual([
    { phase: "pipelineRuns", reason: "pipelineRuns broke" },
  ]);
  expect(report.cards).toBe(3);
});

test("a lost lease stops before the next phase and leaves the item to its new holder", async () => {
  const order: string[] = [];
  const queue = fakeQueue({
    claimed: (key) => [item(key)],
    renew: () => false,
  });
  const report = await sweepAbandonedWork({
    queue,
    owner: "replica-a",
    phases: recordingPhases(order),
    key: "bucket-1",
  });
  expect(order).toEqual(["routineRuns"]);
  expect(report.leaseLost).toBe(true);
  expect(queue.calls).not.toContain("finish:bucket-1");
});

test("the bucket key is the same for every replica inside one five-minute window", () => {
  const start = Date.parse("2026-11-02T10:05:00.000Z");
  expect(recoveryBucketKey(start)).toBe("2026-11-02T10:05:00.000Z");
  expect(recoveryBucketKey(start + 299_999)).toBe("2026-11-02T10:05:00.000Z");
  expect(recoveryBucketKey(start + 300_000)).toBe("2026-11-02T10:10:00.000Z");
});

test("the production phases call the three reapers with the shared horizon", async () => {
  const seen: unknown[] = [];
  const phases = abandonedWorkPhases({
    routineStore: {
      reapAbandonedRuns: async (olderThanMs, error) => {
        seen.push(["routine", olderThanMs, error]);
        return 0;
      },
    },
    reapPipelineRuns: async (input) => {
      seen.push(["pipeline", input.olderThanMs]);
      return 0;
    },
    board: {
      reclaimAbandoned: async (input) => {
        seen.push(["cards", input.olderThanMs]);
        return 0;
      },
    },
  });
  await phases.routineRuns(600_000);
  await phases.pipelineRuns(600_000);
  await phases.cards(600_000);
  expect(seen).toEqual([
    ["routine", 600_000, REAPED_ROUTINE_RUN],
    ["pipeline", 600_000],
    ["cards", 600_000],
  ]);
});

/*
 * The wire. Read as text, like `cull-sweep-wiring.test.ts`: the server and the CronJob both start
 * work as a side effect of loading, so their one load-bearing line is otherwise untested.
 */
const server = readFileSync(
  join(import.meta.dir, "..", "src", "index.ts"),
  "utf8",
);
/** M3: upstream moved the approval resume loop out of index.ts, into approvals/resume-sweep.ts. */
const resumeSweep = readFileSync(
  join(import.meta.dir, "..", "src", "approvals", "resume-sweep.ts"),
  "utf8",
);
const cronJob = readFileSync(
  join(import.meta.dir, "..", "scripts", "fire-routines.ts"),
  "utf8",
);

test("the server starts the recovery sweep inside the startup lifecycle, not at import", () => {
  expect(server).not.toContain("deliberately NOT started here");
  const call = server.indexOf("sweepAbandonedWork({");
  expect(call).toBeGreaterThan(-1);
  const acquire = server.lastIndexOf("startup.acquireSync(", call);
  expect(acquire).toBeGreaterThan(-1);
  // The nearest lifecycle block opens the repeating loop that makes the call.
  expect(server.slice(acquire, call)).toContain("repeatAfterEach(");
  expect(server).toContain("kind: RECOVERY_SWEEP_KIND");
});

test("the CronJob uses the same sweep instead of its own copy", () => {
  expect(cronJob).toContain("sweepAbandonedWork({");
  expect(cronJob).not.toContain(".reclaimAbandoned(");
});

test("approval resume stays gated: the server never composes a recovery port or an attestation", () => {
  for (const source of [server, resumeSweep]) {
    expect(source).not.toContain("continuationRecovery");
    expect(source).not.toContain("composeLocalRecovery");
    expect(source).not.toContain("readVerifiedRelease");
  }
  expect(resumeSweep).toContain(
    "error instanceof ApprovalRecoveryBlockedError",
  );
  expect(resumeSweep).toContain("reason: APPROVAL_RESUME_GATED_REASON");
  expect(AP_LOCAL_RECOVERY_UNWIRED).toBeNull();
});
