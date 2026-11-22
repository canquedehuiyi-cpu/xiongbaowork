import { expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  analyzeCodex,
  analyzeXiongbao,
  asksQuestion,
  type Features,
  featureProbe,
  lastAssistantText,
  runErrorsIn,
  toolCallsOf,
} from "./metrics";

const ALL: Features = {
  plan: true,
  subagent: true,
  reasoning: true,
  editTool: true,
  grepTool: true,
  stepLimit: true,
};
const NONE: Features = {
  plan: false,
  subagent: false,
  reasoning: false,
  editTool: false,
  grepTool: false,
  stepLimit: false,
};

function call(id: string, name: string, args: unknown) {
  return [
    { type: "TOOL_CALL_START", toolCallId: id, toolCallName: name },
    {
      type: "TOOL_CALL_ARGS",
      toolCallId: id,
      delta: JSON.stringify(args).slice(0, 5),
    },
    {
      type: "TOOL_CALL_ARGS",
      toolCallId: id,
      delta: JSON.stringify(args).slice(5),
    },
    { type: "TOOL_CALL_END", toolCallId: id },
    { type: "TOOL_CALL_RESULT", toolCallId: id, content: "ok" },
  ];
}

const plan = (status: string) => ({
  items: [
    { text: "a", status: "done" },
    { text: "b", status },
  ],
});

test("tool calls are put back together from their streamed arguments", () => {
  const calls = toolCallsOf(
    call("1", "computer_run_command", { command: "bun test" }),
  );
  expect(calls).toEqual([
    {
      id: "1",
      name: "computer_run_command",
      args: '{"command":"bun test"}',
      result: "ok",
    },
  ]);
});

test("plan, subagents, verification, step limit and reasoning are read from a run", () => {
  const events = [
    ...call("1", "update_plan", plan("in_progress")),
    ...call("2", "run_subagent", { task: "read part1" }),
    ...call("3", "run_subagent", { task: "read part2" }),
    ...call("4", "computer_write_file", { path: "src/a.ts", contents: "x" }),
    ...call("5", "computer_run_command", {
      command: "cd eval/code && bun test",
    }),
    ...call("6", "update_plan", plan("done")),
    { type: "REASONING_MESSAGE_CONTENT", delta: "想一想" },
    { type: "CUSTOM", name: "step-limit", value: { steps: 81 } },
  ];
  expect(
    analyzeXiongbao(events, {
      features: ALL,
      editsData: true,
      modelCallsPerRound: [81],
    }),
  ).toEqual({
    plan: "yes",
    planDone: "yes",
    subagent: "yes",
    subagentCount: 2,
    reasoning: "yes",
    verified: "yes",
    editTool: "no",
    grepTool: "no",
    stepLimit: "yes",
    autoContinued: "yes",
  });
});

test("an edit with no check after it, and an unfinished plan, read as no", () => {
  const events = [
    ...call("1", "update_plan", plan("pending")),
    ...call("2", "computer_run_command", { command: "bun test" }),
    ...call("3", "computer_write_file", { path: "summary.csv", contents: "x" }),
  ];
  const read = analyzeXiongbao(events, {
    features: ALL,
    editsData: true,
    modelCallsPerRound: [3],
  });
  expect([
    read.planDone,
    read.verified,
    read.autoContinued,
    read.stepLimit,
  ]).toEqual(["no", "no", "no", "no"]);
});

test("a capability the product does not have yet reads n/a, never an error", () => {
  const read = analyzeXiongbao([], {
    features: NONE,
    editsData: false,
    modelCallsPerRound: [],
  });
  expect(Object.values(read).filter((value) => value !== 0)).toEqual(
    Array(9).fill("n/a"),
  );
});

test("the feature probe reads this checkout without throwing", () => {
  const features = featureProbe(resolve(import.meta.dir, "../../.."));
  expect(features.plan).toBe(true);
  expect(features.subagent).toBe(true);
  expect(featureProbe("/nonexistent")).toEqual(NONE);
});

test("codex JSONL: usage, plan, verification and the last message", () => {
  const lines = [
    { type: "thread.started" },
    {
      type: "item.completed",
      item: { type: "todo_list", items: [{ text: "a", completed: true }] },
    },
    { type: "item.completed", item: { type: "file_change", changes: [] } },
    {
      type: "item.completed",
      item: { type: "command_execution", command: "bash -lc 'bun test'" },
    },
    { type: "item.completed", item: { type: "reasoning", text: "…" } },
    { type: "item.completed", item: { type: "agent_message", text: "做完了" } },
    { type: "turn.completed", usage: { input_tokens: 100, output_tokens: 20 } },
  ].map((line) => JSON.stringify(line));
  const summary = analyzeCodex([...lines, "not json"], { editsData: true });
  expect(summary.tokens).toEqual({ input: 100, output: 20, total: 120 });
  expect(summary.steps).toBe(2);
  expect(summary.lastMessage).toBe("做完了");
  expect(summary.capabilities).toMatchObject({
    plan: "yes",
    planDone: "yes",
    verified: "yes",
    reasoning: "yes",
    stepLimit: "n/a",
  });
  expect(analyzeCodex([], { editsData: false }).tokens).toBeNull();
});

test("the last assistant text and a closing question", () => {
  const events = [
    { type: "TEXT_MESSAGE_START", messageId: "a" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "a", delta: "先这样" },
    { type: "TEXT_MESSAGE_START", messageId: "b" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "b", delta: "要我继续吗？" },
  ];
  expect(lastAssistantText(events)).toBe("要我继续吗？");
  expect(asksQuestion("要我继续吗？")).toBe(true);
  expect(asksQuestion("我先去查一下。")).toBe(false);
});

test("run errors are listed with their position and the last tool call before them, single-lined and masked", () => {
  const events = [
    { type: "RUN_STARTED" },
    {
      type: "TOOL_CALL_START",
      toolCallId: "a",
      toolCallName: "computer_run_command",
    },
    { type: "TOOL_CALL_START", toolCallId: "b", toolCallName: "deliver_task" },
    {
      type: "RUN_ERROR",
      code: "stalled",
      message: `line one\nline two Bearer abc.def-123 key sk-abcdef123456 ${"x".repeat(300)}`,
    },
    { type: "RUN_ERROR", message: "later" },
  ];
  const found = runErrorsIn(events);
  expect(found).toHaveLength(2);
  expect(found[0]).toStartWith(
    "stalled：line one line two Bearer *** key sk-*** ",
  );
  expect(found[0]).not.toContain("abcdef123456");
  expect(found[0]).not.toContain("\n");
  expect(found[0]).toEndWith(
    "（在第 4 个事件，之前最后一个工具调用是 deliver_task）",
  );
  expect(found[0]?.split("（在第")[0]?.length).toBeLessThanOrEqual(
    "stalled：".length + 200,
  );
  expect(found[1]).toBe(
    "RUN_ERROR：later（在第 5 个事件，之前最后一个工具调用是 deliver_task）",
  );
});

test("no run errors, or one before any tool call", () => {
  expect(
    runErrorsIn([{ type: "RUN_STARTED" }, { type: "RUN_FINISHED" }]),
  ).toEqual([]);
  expect(runErrorsIn([{ type: "RUN_ERROR", code: "x", message: "m" }])).toEqual(
    ["x：m（在第 1 个事件，之前没有工具调用）"],
  );
});
