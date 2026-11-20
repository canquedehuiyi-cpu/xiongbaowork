import { expect, test } from "bun:test";
import {
  type Capabilities,
  callSeries,
  inputThirds,
  longestInput,
  type TokenCallRow,
} from "./metrics";
import {
  DEFAULT_RESEARCH,
  pageCommand,
  researchCalls,
  researchPolicy,
  researchScriptFrom,
} from "./mock-research";
import type { MockRequest } from "./mock-model";
import type { EvalRecord, EvalResults } from "./records";
import { renderReport, stepCells } from "./report";

const row = (
  callId: string,
  runId: string,
  at: number,
  input: number | null,
  cached: number | null,
): TokenCallRow => ({
  callId,
  runId,
  startedAt: new Date(at),
  inputTokens: input,
  cachedInputTokens: cached,
});

test("callSeries lists each call's input and cached tokens in time order, whatever order the rows came in", () => {
  const series = callSeries(
    [
      row("c", "main", 3000, 300, 200),
      row("a", "main", 1000, 100, 0),
      row("b", "sub-1", 2000, 200, null),
    ],
    ["main"],
  );
  expect(series.callInputs).toEqual([100, 200, 300]);
  expect(series.callCached).toEqual([0, null, 200]);
  expect(series.callAgents).toEqual(["main", "other", "main"]);
  // Calls in the same instant keep a stable order by call id.
  const tied = callSeries(
    [row("b", "main", 1000, 2, 0), row("a", "main", 1000, 1, 0)],
    ["main"],
  );
  expect(tied.callInputs).toEqual([1, 2]);
});

test("the series adds up to the token summary: same rows, nothing dropped", () => {
  const rows = [
    row("a", "r1", 1, 100, 10),
    row("b", "r1", 2, 150, 90),
    row("c", "r2", 3, 400, 300),
  ];
  const series = callSeries(rows, ["r1", "r2"]);
  const sum = (values: (number | null)[]) =>
    values.reduce<number>((total, value) => total + (value ?? 0), 0);
  expect(sum(series.callInputs)).toBe(650);
  expect(sum(series.callCached)).toBe(400);
});

test("longestInput skips calls the provider did not report", () => {
  expect(longestInput([10, null, 300, 40])).toBe(300);
  expect(longestInput([null, null])).toBeNull();
  expect(longestInput([])).toBeNull();
  expect(longestInput(undefined)).toBeNull();
});

test("inputThirds averages the first, middle and last third of the calls", () => {
  expect(inputThirds([10, 10, 10, 20, 20, 20, 30, 30, 30])).toEqual([
    10, 20, 30,
  ]);
  // Not divisible by three: the front segments take the extra calls.
  expect(inputThirds([1, 1, 1, 2, 2, 3, 3])).toEqual([1, 2, 3]);
  // Fewer calls than segments: the empty segments are null, not zero.
  expect(inputThirds([5])).toEqual([5, null, null]);
  expect(inputThirds([5, 7])).toEqual([5, 7, null]);
  // A call without a number does not drag its segment down.
  expect(inputThirds([10, null, 30, 50, 50, 50])).toEqual([10, 40, 50]);
  expect(inputThirds([])).toEqual([null, null, null]);
  expect(inputThirds(undefined)).toEqual([null, null, null]);
});

const capabilities = (): Capabilities => ({
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
});

const record = (over: Partial<EvalRecord> = {}): EvalRecord => ({
  task: "research",
  title: "调研",
  passed: true,
  wallMs: 1000,
  timedOut: false,
  steps: 6,
  toolCalls: 5,
  modelCalls: 6,
  tokens: { input: 600, output: 60, total: 660, cachedInput: 300 },
  silentStop: false,
  nudges: 0,
  tools: {},
  capabilities: capabilities(),
  checks: [],
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

test("the report shows the longest step and the front / middle / back averages; old result files show dashes", () => {
  const stepped = record({
    callInputs: [100, 100, 200, 200, 900, 300],
    callCached: [0, 90, 150, 190, 0, 300],
    callAgents: ["main", "main", "main", "main", "main", "other"],
  });
  expect(stepCells(stepped)).toEqual(["900", "100 / 200 / 600", "1"]);
  expect(stepCells(record())).toEqual(["—", "—", "—"]);
  expect(stepCells(undefined)).toEqual(["—", "—", "—"]);
  const markdown = renderReport([results([stepped])]);
  expect(markdown).toContain("### 每步输入（逐步计量）");
  expect(markdown).toContain("熊宝最长一步输入");
  expect(markdown).toContain("| 调研 | 900 | 100 / 200 / 600 | 1 |");
  // A result file from before the series existed has no such section.
  expect(renderReport([results([record()])])).not.toContain("逐步计量");
});

test("the research script reads its settings from the environment and falls back to the defaults", () => {
  expect(researchScriptFrom({})).toBeNull();
  expect(researchScriptFrom({ EVAL_MOCK_SCRIPT: "other" })).toBeNull();
  expect(researchScriptFrom({ EVAL_MOCK_SCRIPT: "research" })).toEqual(
    DEFAULT_RESEARCH,
  );
  expect(
    researchScriptFrom({
      EVAL_MOCK_SCRIPT: "research",
      EVAL_MOCK_STEPS: "12",
      EVAL_MOCK_BYTES: "99999999",
      EVAL_MOCK_SCREENSHOTS: "3, 9,x,-1",
    }),
  ).toEqual({ steps: 12, bytes: DEFAULT_RESEARCH.bytes, screenshots: [3, 9] });
});

test("the research script runs one call per step, a screenshot step being a navigation and a screenshot", () => {
  const calls = researchCalls(
    { steps: 4, bytes: 1000, screenshots: [2] },
    "http://127.0.0.1/page",
  );
  expect(calls.map((call) => call.name)).toEqual([
    "computer_run_command",
    "computer_navigate",
    "computer_screenshot",
    "computer_run_command",
    "computer_run_command",
  ]);
  expect(pageCommand(3, 1000)).toContain("head -c 1000");
  expect(pageCommand(3, 1000)).not.toBe(pageCommand(4, 1000));
});

test("the research policy follows the tool results so far, finishes with text, and does not replay after a nudge", () => {
  const script = { steps: 2, bytes: 100, screenshots: [] };
  const ask = (
    toolResultsSinceUser: number,
    lastUser = "题目",
  ): MockRequest => ({
    protocol: "chat",
    lastUser,
    toolResultsSinceUser,
    offeredTools: [],
    raw: {},
  });
  expect(researchPolicy(ask(0), script, "u").tools).toHaveLength(1);
  expect(researchPolicy(ask(1), script, "u").tools).toHaveLength(1);
  expect(researchPolicy(ask(2), script, "u")).not.toHaveProperty("tools");
  expect(researchPolicy(ask(2), script, "u").text).toContain("2 份资料");
  expect(
    researchPolicy(ask(0, "继续完成上面交代的任务"), script, "u"),
  ).not.toHaveProperty("tools");
});
