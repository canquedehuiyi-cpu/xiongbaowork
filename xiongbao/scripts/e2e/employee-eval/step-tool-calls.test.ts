import { expect, test } from "bun:test";
import type { EvalRecord, EvalResults } from "./records";
import { renderReport, toolCallsPerStep } from "./report";

/*
 * 平均每步工具调用数 = 运行事件里的工具调用数 ÷ 模型调用数。每步都要把整段历史再发一遍，这个数越大，同样的活
 * 要发的历史就越少；一步一个调用是 1.0，Codex 一次动作常常带多条命令。
 */

const record = (over: Partial<EvalRecord> = {}): EvalRecord => ({
  task: "research",
  title: "调研",
  passed: true,
  wallMs: 1000,
  timedOut: false,
  steps: 10,
  toolCalls: 15,
  modelCalls: 10,
  tokens: { input: 600, output: 60, total: 660, cachedInput: 300 },
  silentStop: false,
  nudges: 0,
  tools: {},
  capabilities: {
    plan: "no",
    planDone: "n/a",
    subagent: "no",
    subagentCount: 0,
    reasoning: "n/a",
    verified: "n/a",
    editTool: "n/a",
    grepTool: "n/a",
    stepLimit: "no",
    autoContinued: "no",
  },
  checks: [],
  callInputs: [100, 200, 300],
  ...over,
});

const results = (records: EvalRecord[]): EvalResults => ({
  side: "xiongbao",
  suite: "tasks",
  provider: "custom",
  model: "m",
  baseUrl: null,
  runner: "r",
  mock: false,
  startedAt: "",
  finishedAt: "",
  records,
  notes: [],
});

test("工具调用数除以模型调用数，保留一位小数", () => {
  expect(toolCallsPerStep(record())).toBe("1.5");
  expect(toolCallsPerStep(record({ toolCalls: 52, modelCalls: 52 }))).toBe(
    "1.0",
  );
  expect(toolCallsPerStep(record({ toolCalls: 19, modelCalls: 11 }))).toBe(
    "1.7",
  );
});

test("没有模型调用数、没有工具调用数、模型调用为 0，或没有这道题：「—」", () => {
  expect(toolCallsPerStep(record({ modelCalls: null }))).toBe("—");
  expect(toolCallsPerStep(record({ toolCalls: null }))).toBe("—");
  expect(toolCallsPerStep(record({ modelCalls: 0 }))).toBe("—");
  expect(toolCallsPerStep(undefined)).toBe("—");
});

test("报告的每步输入表多一列「每步工具调用」，旧列不变", () => {
  const markdown = renderReport([results([record()])]);
  expect(markdown).toContain("熊宝每步工具调用");
  expect(markdown).toContain("| 调研 | 300 | 100 / 200 / 300 | 0 | 1.5 |");
});
