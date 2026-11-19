import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  analyzeXiongbao,
  type Features,
  featureProbe,
  headlessToolNames,
  observedFeatures,
  snapshotHasReasoning,
  snapshotMessages,
  toolCallsFromMessages,
  withObserved,
} from "./metrics";
import type { EvalRecord, EvalResults } from "./records";
import { cacheShare, renderReport } from "./report";

const CHECKOUT = resolve(import.meta.dir, "../../..");
const NONE: Features = {
  plan: false,
  subagent: false,
  reasoning: false,
  editTool: false,
  grepTool: false,
  stepLimit: false,
};

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** 一个只有几份产品模块的假 `xiongbao/` 目录。 */
function fakeRoot(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "eval-features-"));
  made.push(root);
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
  return root;
}

test("the probe reads main's real flags: thinking (期三) is in, the 期五 tools are built from the real tool list", () => {
  const features = featureProbe(CHECKOUT);
  expect(features.reasoning).toBe(true);
  expect(features.stepLimit).toBe(true);
  // 读的是真正构建出来的工具清单，不是源码里的字符串。
  const names = headlessToolNames(CHECKOUT);
  expect(names).toContain("computer_run_command");
  expect(features.editTool).toBe(names.includes("computer_edit_file"));
  expect(features.grepTool).toBe(names.includes("computer_grep"));
});

test("once the edit and grep tools are built by the product, they are detected with no change to the eval", () => {
  const root = fakeRoot({
    "server/src/computer/headless-tools.ts": `export function createHeadlessComputerTools() {
  return ["computer_run_command", "computer_edit_file", "computer_grep"].map((name) => ({ definition: { name } }));
}\n`,
    "shared/thinking.ts": `export const REASONING_EVENTS = ["REASONING_START"] as const;\n`,
  });
  expect(featureProbe(root)).toEqual({
    ...NONE,
    reasoning: true,
    editTool: true,
    grepTool: true,
  });
});

test("a source file that only mentions a name is not a feature", () => {
  const root = fakeRoot({
    // 旧探测会被这种字符串骗到：提到了名字，但工具清单里没有它。
    "server/src/computer/headless-tools.ts": `// computer_edit_file is coming in 期五
export function createHeadlessComputerTools() { return [{ definition: { name: "computer_run_command" } }]; }\n`,
    "shared/thinking.ts": `// REASONING_START\nexport const THINKING_DEFAULT = true;\n`,
    "shared/plan.ts": `export const UPDATE_PLAN_TOOL = "something_else";\n`,
  });
  expect(featureProbe(root)).toEqual(NONE);
});

test("a module that fails to load reads as absent, never an error", () => {
  const root = fakeRoot({
    "server/src/computer/headless-tools.ts": `throw new Error("boom");\n`,
    "shared/thinking.ts": `export const REASONING_EVENTS = 3;\n`,
  });
  expect(featureProbe(root)).toEqual(NONE);
});

test("what the run actually did fills in what the flags missed", () => {
  const seen = observedFeatures(
    [
      { type: "REASONING_MESSAGE_CONTENT", delta: "…" },
      { type: "CUSTOM", name: "step-limit" },
    ],
    [{ id: "1", name: "computer_grep", args: "{}", result: "" }],
    ["computer_edit_file"],
  );
  expect(seen).toEqual({
    reasoning: true,
    stepLimit: true,
    grepTool: true,
    editTool: true,
  });
  expect(withObserved(NONE, seen)).toEqual({
    ...NONE,
    reasoning: true,
    stepLimit: true,
    grepTool: true,
    editTool: true,
  });
  // 并集：标志说在的，运行没用上也还是在。
  expect(withObserved({ ...NONE, plan: true }, {}).plan).toBe(true);
});

test("reasoning events in a run read yes even when the flag probe found nothing", () => {
  const read = analyzeXiongbao(
    [{ type: "REASONING_MESSAGE_CONTENT", delta: "想一想" }],
    { features: NONE, editsData: false, modelCallsPerRound: [1] },
  );
  expect(read.reasoning).toBe("yes");
});

const SNAPSHOT = [
  { id: "u1", role: "user", content: "做题" },
  { id: "r1", role: "reasoning", content: "先列计划" },
  {
    id: "a1",
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id: "c1",
        type: "function",
        function: {
          name: "update_plan",
          arguments: JSON.stringify({
            items: [{ text: "写报告", status: "done" }],
          }),
        },
      },
      {
        id: "c2",
        type: "function",
        function: { name: "run_subagent", arguments: '{"task":"查 A"}' },
      },
    ],
  },
  { id: "t1", role: "tool", toolCallId: "c1", content: "已更新计划" },
  { id: "t2", role: "tool", toolCallId: "c2", content: { answer: "A 的结果" } },
  { id: "a2", role: "assistant", content: "做完了" },
];

test("tool calls are read back from the thread's message snapshot when the run's events were not stored", () => {
  const calls = toolCallsFromMessages(SNAPSHOT);
  expect(calls).toEqual([
    {
      id: "c1",
      name: "update_plan",
      args: '{"items":[{"text":"写报告","status":"done"}]}',
      result: "已更新计划",
    },
    {
      id: "c2",
      name: "run_subagent",
      args: '{"task":"查 A"}',
      result: '{"answer":"A 的结果"}',
    },
  ]);
  expect(snapshotHasReasoning(SNAPSHOT)).toBe(true);
  // 快照列可能是一段 JSON 文本。
  expect(snapshotMessages(JSON.stringify(SNAPSHOT))).toEqual(SNAPSHOT);
  expect(snapshotMessages(SNAPSHOT)).toEqual(SNAPSHOT);
  expect(snapshotMessages("not json")).toEqual([]);
  expect(snapshotHasReasoning([{ role: "assistant" }])).toBe(false);
  // 没有事件也能读出计划、子代理和推理。
  const read = analyzeXiongbao([], {
    features: NONE,
    editsData: false,
    modelCallsPerRound: [3],
    calls,
    reasoningSeen: true,
  });
  expect(read).toMatchObject({
    plan: "yes",
    planDone: "yes",
    subagent: "yes",
    subagentCount: 1,
    reasoning: "yes",
  });
});

function record(overrides: Partial<EvalRecord>): EvalRecord {
  return {
    task: "code",
    title: "改代码",
    passed: true,
    wallMs: 1000,
    timedOut: false,
    steps: 18,
    toolCalls: 17,
    modelCalls: 18,
    tokens: { input: 1000, output: 100, total: 1100, cachedInput: 750 },
    silentStop: false,
    nudges: 0,
    tools: {},
    capabilities: analyzeXiongbao([], {
      features: NONE,
      editsData: false,
      modelCallsPerRound: [],
    }),
    checks: [],
    ...overrides,
  };
}

function results(side: "xiongbao" | "codex", one: EvalRecord): EvalResults {
  return {
    side,
    suite: "tasks",
    provider: "deepseek",
    model: "m",
    baseUrl: null,
    runner: "r",
    mock: false,
    startedAt: "",
    finishedAt: "",
    records: [one],
    notes: [],
  };
}

test("the report shows model-call steps, tool calls and the cache hit share, and says how each is counted", () => {
  expect(cacheShare(record({}))).toBe("75%");
  expect(
    cacheShare(
      record({
        tokens: { input: 10, output: 1, total: 11, cachedInput: null },
      }),
    ),
  ).toBe("—");
  const markdown = renderReport([
    results("xiongbao", record({})),
    results(
      "codex",
      record({
        steps: 11,
        toolCalls: 11,
        modelCalls: null,
        tokens: { input: 80, output: 10, total: 90 },
      }),
    ),
  ]);
  // 主表的列不变，步数换成模型调用次数；细分表另列工具调用和缓存命中。
  expect(markdown).toContain(
    "| 改代码（code） | ✅ 通过 | ✅ 通过 | 1 s | 1 s | 1,100 | 90 | 18 | 11 |",
  );
  expect(markdown).toContain(
    "| 改代码 | 18 | 17 | 11 | 1000 | 75% | — | 80 | — |",
  );
  expect(markdown).toContain(
    "步数：熊宝 = 模型调用次数（`model_token_calls` 的行数",
  );
});
