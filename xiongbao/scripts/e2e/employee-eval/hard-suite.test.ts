import { expect, test } from "bun:test";
import { xiongbaoModel } from "./config";
import { HARD_SUITE, HARD_TASKS, selectTasks, taskPrompt } from "./lib";
import {
  type Capabilities,
  promptBreakdown,
  summarizePrompts,
} from "./metrics";
import { combineRepeat, type EvalRecord, type EvalResults } from "./records";
import { promptRows, renderReport, repeatRows } from "./report";
import type { ChatRequest } from "./token-breakdown";

test("EVAL_TASKS=hard runs compare, refactor, terminal and webform; repeat is picked by name only", () => {
  expect(selectTasks("hard", HARD_SUITE)).toEqual([
    "compare",
    "refactor",
    "terminal",
    "webform",
  ]);
  expect(selectTasks("all,hard", HARD_SUITE)).toHaveLength(9);
  expect(selectTasks("repeat", HARD_SUITE)).toEqual(["repeat"]);
  expect(selectTasks("hard,repeat", HARD_SUITE)).toHaveLength(5);
  // `all` and the default `hard` keep their old meaning.
  expect(selectTasks("all", HARD_SUITE)).toHaveLength(5);
  expect(selectTasks("all")).not.toContain("repeat");
  expect(selectTasks("hard")).toEqual([...HARD_TASKS]);
  expect(selectTasks("webform, refactor", HARD_SUITE)).toEqual([
    "refactor",
    "webform",
  ]);
  expect(() => selectTasks("repeat,cooking", HARD_SUITE)).toThrow();
});

test("the repeat task is told to the employee as the office task, in a directory of its own", () => {
  const prompt = taskPrompt("repeat", "eval/repeat-first");
  expect(prompt).toContain("「多步办公」");
  expect(prompt).toContain("eval/repeat-first/TASK.md");
});

test("xiongbaoModel changes only the Xiongbao side, and only when the input names a model", () => {
  const base = "deepseek-v4-flash";
  expect(xiongbaoModel({}, base)).toEqual({
    ok: true,
    model: base,
    overridden: false,
  });
  for (const blank of ["", "   "])
    expect(xiongbaoModel({ EVAL_XIONGBAO_MODEL: blank }, base)).toEqual({
      ok: true,
      model: base,
      overridden: false,
    });
  expect(
    xiongbaoModel({ EVAL_XIONGBAO_MODEL: " deepseek-v4-pro " }, base),
  ).toEqual({ ok: true, model: "deepseek-v4-pro", overridden: true });
  // Naming the same model is not a swap.
  expect(xiongbaoModel({ EVAL_XIONGBAO_MODEL: base }, base)).toMatchObject({
    overridden: false,
  });
  const refused = xiongbaoModel({ EVAL_XIONGBAO_MODEL: "two words" }, base);
  expect(refused.ok).toBe(false);
});

const request = (history: string, tools = 1): ChatRequest => ({
  messages: [
    {
      role: "system",
      content: "<identity>\n你是员工\n</identity>\n\n<plan>\n先列计划\n</plan>",
    },
    { role: "user", content: "做题" },
    {
      role: "assistant",
      content: "好",
      reasoning_content: "想想",
      tool_calls: [{ function: { name: "run", arguments: '{"a":1}' } }],
    },
    { role: "tool", content: history },
  ],
  tools: Array.from({ length: tools }, () => ({
    function: { name: "run", description: "d", parameters: {} },
  })),
});

test("promptBreakdown counts characters for the system sections, the tools and each kind of history", () => {
  const part = promptBreakdown(request("x".repeat(100)));
  expect(part.system).toEqual({
    identity: "<identity>\n你是员工\n</identity>".length,
    plan: "<plan>\n先列计划\n</plan>".length,
  });
  expect(part.tools).toBe(
    JSON.stringify({
      function: { name: "run", description: "d", parameters: {} },
    }).length,
  );
  expect(part.toolCount).toBe(1);
  expect(part.history).toEqual({
    user: 2,
    assistantText: 1,
    toolCallArgs: 'run{"a":1}'.length,
    reasoning: 2,
    toolResults: 100,
  });
  expect(part.total).toBe(
    Object.values(part.system).reduce((a, b) => a + b, 0) +
      part.tools +
      Object.values(part.history).reduce((a, b) => a + b, 0),
  );
  expect(promptBreakdown({})).toMatchObject({ total: 0, toolCount: 0 });
});

test("summarizePrompts picks the first request that offers tools and the biggest one", () => {
  const noTools: ChatRequest = {
    messages: [{ role: "user", content: "起个标题" }],
  };
  const summary = summarizePrompts([
    noTools,
    request("a"),
    request("b".repeat(5000)),
    request("c".repeat(10)),
  ]);
  expect(summary?.requests).toBe(4);
  expect(summary?.totals).toHaveLength(4);
  expect(summary?.first.toolCount).toBe(1);
  expect(summary?.first.history.toolResults).toBe(1);
  expect(summary?.peak.history.toolResults).toBe(5000);
  expect(summarizePrompts([])).toBeNull();
});

const capabilities: Capabilities = {
  plan: "yes",
  planDone: "yes",
  subagent: "no",
  subagentCount: 0,
  reasoning: "n/a",
  verified: "n/a",
  editTool: "n/a",
  grepTool: "n/a",
  stepLimit: "no",
  autoContinued: "no",
};
const record = (over: Partial<EvalRecord> = {}): EvalRecord => ({
  task: "repeat",
  title: "t",
  passed: true,
  wallMs: 100_000,
  timedOut: false,
  steps: 20,
  toolCalls: 18,
  modelCalls: 20,
  tokens: { input: 40_000, output: 4_000, total: 44_000, cachedInput: 10_000 },
  silentStop: false,
  nudges: 0,
  tools: { computer_run_command: 10 },
  capabilities,
  checks: [{ name: "actions.csv 存在", ok: true, detail: "" }],
  ...over,
});

test("combineRepeat adds the two runs up and keeps each run's own numbers", () => {
  const first = record();
  const second = record({
    passed: false,
    wallMs: 50_000,
    steps: 10,
    toolCalls: 9,
    modelCalls: 10,
    tokens: { input: 20_000, output: 2_000, total: 22_000, cachedInput: 5_000 },
    nudges: 1,
    tools: { computer_run_command: 4, update_plan: 1 },
    checks: [{ name: "actions.csv 存在", ok: false, detail: "没有" }],
  });
  const both = combineRepeat(first, second);
  expect(both).toMatchObject({
    task: "repeat",
    passed: false,
    wallMs: 150_000,
    steps: 30,
    toolCalls: 27,
    modelCalls: 30,
    nudges: 1,
    tools: { computer_run_command: 14, update_plan: 1 },
  });
  expect(both.tokens).toMatchObject({
    input: 60_000,
    output: 6_000,
    total: 66_000,
    cachedInput: 15_000,
  });
  expect(both.firstRun).toMatchObject({
    passed: true,
    steps: 20,
    wallMs: 100_000,
    tokens: { input: 40_000, output: 4_000, total: 44_000 },
  });
  expect(both.secondRun).toMatchObject({
    passed: false,
    steps: 10,
    wallMs: 50_000,
    tokens: { input: 20_000 },
  });
  expect(both.checks.map((item) => item.name)).toEqual([
    "第一次：actions.csv 存在",
    "第二次：actions.csv 存在",
  ]);
});

const side = (
  name: "xiongbao" | "codex",
  model: string,
  records: EvalRecord[],
): EvalResults => ({
  side: name,
  suite: "tasks",
  provider: "deepseek",
  model,
  baseUrl: null,
  runner: name,
  mock: false,
  startedAt: "",
  finishedAt: "",
  records,
  notes: [],
});

test("the report shows the repeat table with the change from the first run to the second", () => {
  const repeated = combineRepeat(
    record(),
    record({
      steps: 10,
      wallMs: 50_000,
      tokens: { input: 20_000, output: 2_000, total: 22_000 },
    }),
  );
  const mine = side("xiongbao", "m", [repeated]);
  expect(repeatRows([["熊宝", mine]])).toEqual([
    [
      "熊宝",
      "✅ 20 步 / 输入 40,000 / 100 s",
      "✅ 10 步 / 输入 20,000 / 50 s",
      "-50%",
      "-50%",
      "-50%",
    ],
  ]);
  expect(repeatRows([["Codex", undefined]])).toEqual([]);
  const markdown = renderReport([mine]);
  expect(markdown).toContain("## 重复任务（同一位员工把同一道题连做两次）");
  expect(markdown).toContain("| -50% | -50% | -50% |");
});

test("the report shows the prompt sizes by section, and says when the two sides run different models", () => {
  const prompt = summarizePrompts([
    request("x".repeat(300)),
    request("y".repeat(900)),
  ]);
  const mine = side("xiongbao", "deepseek-v4-pro", [
    record({
      task: "refactor",
      title: "跨文件重构",
      promptChars: prompt ?? undefined,
    }),
    record({ task: "code", title: "改代码" }),
  ]);
  const rows = promptRows([["熊宝", mine]]);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.[0]).toBe("跨文件重构（熊宝）");
  expect(rows[0]?.[1]).toBe("2");
  expect(rows[0]?.[8]).toContain("identity");
  const markdown = renderReport([
    mine,
    side("codex", "deepseek-v4-flash", [
      record({ task: "refactor", title: "跨文件重构" }),
    ]),
  ]);
  expect(markdown).toContain("## 提示词体积（熊宝侧，字符数）");
  expect(markdown).toContain(
    "**模型不同**：熊宝侧用 `deepseek-v4-pro`，Codex 侧用 `deepseek-v4-flash`",
  );
  // The hard section lists every hard task that has a record, with the wall clock and per-step table.
  expect(markdown).toContain("## 加难题");
  expect(markdown).toContain("### 难题的墙钟与逐步计量");
  expect(markdown).toContain("| 跨文件重构 |");
});
