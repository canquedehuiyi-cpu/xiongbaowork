import { expect, test } from "bun:test";
import { HeadlessToolSuspension } from "../src/computer/headless-tools";
import type { PipelineStepRunner } from "../src/pipeline/store";
import { createPipelineStepRunner } from "../src/pipeline/turn-channel";
import { frameFiring } from "../src/routines/run-turn";
import type { TurnRunner } from "../src/routines/runner";

/**
 * Ticket 021's one door into the execution channel (ADR-0001 = A).
 *
 * The store's own suite proves the sequence; this proves the adapter that hands a step to the deployment's
 * headless turn channel, because that is where the two contracts meet and every mistake here is a step
 * that either never reaches the person or reaches them wearing the wrong card.
 *
 * The channel itself is not retested -- the thread lock, the pause gate and the allowlist have their own
 * suites where they are implemented. What is asserted is what this file decides: which id the turn runs
 * under, what a suspension means, and what counts as an answer.
 */

type Call = Parameters<TurnRunner>[0];
const calls: Call[] = [];

function channel(reply: () => Promise<{ replyText: string }>) {
  calls.length = 0;
  return createPipelineStepRunner({
    runTurn: async (input) => {
      calls.push(input);
      return reply();
    },
  });
}

const step = (over: Partial<Parameters<PipelineStepRunner>[0]> = {}) => ({
  tenantId: "person-1",
  agentId: "backend-engineer",
  instruction: "写出实现",
  prior: [],
  initiatedBy: "person-1",
  runId: "run-1",
  stepRunRef: "step-run-1",
  ...over,
});

test("the step's turn runs under its card's id, in a thread named by that same id", async () => {
  const runner = channel(async () => ({ replyText: "实现写完了" }));
  const result = await runner(step());

  expect(result).toEqual({ status: "done", output: "实现写完了" });
  expect(calls[0]?.runId).toBe("step-run-1");
  /*
   * The approval gate parks a board card by the run id the request was opened with, so the value on the
   * line above is the whole linkage between "a coworker stopped to ask" and "this card is in 需要操作".
   * A second step of the same run gets its own thread rather than reading the first one's history.
   */
  expect(calls[0]?.threadId).toContain("step-run-1");
  expect(calls[0]?.ownerUserId).toBe("person-1");
  expect(calls[0]?.agentId).toBe("backend-engineer");
});

test("pipeline cancellation reaches the existing governed turn channel", async () => {
  const controller = new AbortController();
  const runner = channel(async () => ({ replyText: "mock only" }));
  await runner(step({ signal: controller.signal }));
  expect(calls[0]?.signal).toBe(controller.signal);
  controller.abort();
  expect(calls[0]?.signal?.aborted).toBe(true);
});

/** A resumed step keeps its card, and the thread it was minted from is derived from that card's id. */
test("the same step resumes in the same thread, so it finishes its own turn", async () => {
  const runner = channel(async () => ({ replyText: "接上次的往下做" }));
  await runner(step());
  const firstThread = calls[0]?.threadId;
  await runner(step());
  expect(calls[1]?.threadId).toBe(firstThread);

  await runner(step({ stepRunRef: "step-run-2" }));
  expect(calls[2]?.threadId).not.toBe(firstThread);
});

/**
 * Spec I3's two shapes, told apart rather than merged.
 *
 * An approval parks a card because there is a row to answer; a durable request has no such row, and
 * `needs_action` would be a lane promising a decision nobody can make -- the same distinction
 * `routines/runner.ts` draws for a suspension of its own.
 */
test("a turn parked on an approval reports the row, and a turn parked on a request reports none", async () => {
  const asking = createPipelineStepRunner({
    runTurn: async () => {
      throw new HeadlessToolSuspension("这个动作等你批准", {
        kind: "approval",
        approvalId: "approval-9",
        requestId: "approval-9",
      });
    },
  });
  await expect(asking(step())).resolves.toEqual({
    status: "awaiting_action",
    approvalId: "approval-9",
  });

  const waiting = createPipelineStepRunner({
    runTurn: async () => {
      throw new HeadlessToolSuspension("这台电脑还没上线", {
        kind: "computer.access",
        requestId: "request-4",
      });
    },
  });
  await expect(waiting(step())).resolves.toEqual({
    status: "awaiting_action",
  });
});

/**
 * A turn that answered nothing did not do the step.
 *
 * Ticket 030's finding, one layer up: an empty reply is indistinguishable from success on the board, and
 * a pipeline also feeds that nothing to every later step, so the person's summary is written out of thin
 * air. Naming the coworker is what makes the stop findable.
 */
test("an empty answer fails the step instead of passing it", async () => {
  const runner = channel(async () => ({ replyText: "   " }));
  const result = await runner(step());
  expect(result.status).toBe("failed");
  expect(result.status === "failed" && result.error).toContain(
    "backend-engineer",
  );
});

/** The channel's refusals are the step's failure, with the channel's own words. */
test("a refusal from the channel stops the run with the reason it gave", async () => {
  const runner = channel(async () => {
    throw new Error("这位员工没有可用的模型。");
  });
  await expect(runner(step())).resolves.toEqual({
    status: "failed",
    error: "这位员工没有可用的模型。",
  });
});

/*
 * The sentence a coworker reads decides what it does with the work, which is why this assertion is
 * about wording rather than plumbing. A step that arrives wearing a routine's frame reads as prose
 * about scheduling -- the exact mistake `frameFiring` exists to prevent, mirrored back at the crew.
 */
test("a step asks as a step, not as a routine firing", async () => {
  const runner = channel(async () => ({ replyText: "实现写完了" }));
  await runner(step({ instruction: "写出实现\n\n任务：给导入加一个进度列" }));

  const content = String(calls[0]?.userMessage?.content ?? "");
  expect(content).toContain("写出实现");
  expect(content).toContain("任务：给导入加一个进度列");
  expect(content).not.toContain(frameFiring("写出实现"));
  // The turn is still traceable to the crew run, which is what the frame was never carrying anyway.
  expect(calls[0]?.routineId).toBe("group-run:run-1");
});
