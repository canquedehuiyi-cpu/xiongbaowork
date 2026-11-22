import { expect, test } from "bun:test";
import { evalSeed, pairFits, repeatPairs } from "./config";
import {
  EDITS_CODE_TASKS,
  REPEAT_PITFALL_TASK,
  REPEAT_TASK,
  REPEAT_TASKS,
  selectTasks,
  TASK_TITLES,
  TASKS,
  taskPrompt,
} from "./lib";
import type { Capabilities } from "./metrics";
import {
  combinePairs,
  combineRepeat,
  type EvalRecord,
  type EvalResults,
  pairsOf,
} from "./records";
import {
  learningRows,
  renderReport,
  repeatRows,
  repeatVerdicts,
} from "./report";

/*
 * 多对取平均：repeat 类题按 repeat_pairs 连做 N 对，每对新员工、新种子；报告给出每一对和平均值，
 * 平均值对照 30% 的目标。
 */

test("repeat-pitfall is picked by name, alone or with the meeting-notes repeat", () => {
  expect(selectTasks("repeat-pitfall")).toEqual([REPEAT_PITFALL_TASK]);
  expect(selectTasks("repeat,repeat-pitfall")).toEqual([
    REPEAT_TASK,
    REPEAT_PITFALL_TASK,
  ]);
  expect(selectTasks("repeat-pitfall,repeat")).toEqual([
    REPEAT_TASK,
    REPEAT_PITFALL_TASK,
  ]);
  expect(selectTasks("all")).not.toContain(REPEAT_PITFALL_TASK);
  expect(selectTasks("all,hard")).not.toContain(REPEAT_PITFALL_TASK);
  expect(selectTasks("repeat", [])).toEqual(["repeat"]);
  expect([...REPEAT_TASKS]).toEqual(["repeat", "repeat-pitfall"]);
  expect([...TASKS]).not.toContain("repeat-pitfall");
  expect(EDITS_CODE_TASKS).toContain("repeat-pitfall");
});

test("the pitfall is told to the employee under a plain name that gives nothing away", () => {
  const prompt = taskPrompt(REPEAT_PITFALL_TASK, "eval/repeat-pitfall-first");
  expect(prompt).toContain("「账单导入」");
  expect(prompt).toContain("eval/repeat-pitfall-first/TASK.md");
  for (const word of ["坑", "重复", "第一次", "技能"])
    expect(prompt).not.toContain(word);
  // 原来的题不动。
  expect(taskPrompt("repeat", "eval/repeat-first")).toContain("「多步办公」");
  expect(TASK_TITLES[REPEAT_PITFALL_TASK]).toContain("账单导入");
});

test("repeat_pairs: 1 to 6, default 1", () => {
  expect(repeatPairs({})).toEqual({ ok: true, pairs: 1 });
  expect(repeatPairs({ EVAL_REPEAT_PAIRS: "" })).toEqual({
    ok: true,
    pairs: 1,
  });
  for (const pairs of [4, 5, 6])
    expect(repeatPairs({ EVAL_REPEAT_PAIRS: String(pairs) })).toEqual({
      ok: true,
      pairs,
    });
  for (const bad of ["0", "7", "2.5", "abc", "-1", "1e1"])
    expect(repeatPairs({ EVAL_REPEAT_PAIRS: bad }).ok).toBe(false);
});

test("the seed comes from EVAL_SEED, and is otherwise drawn once and never empty", () => {
  expect(evalSeed({ EVAL_SEED: " run-42-1 " })).toBe("run-42-1");
  const drawn = evalSeed({});
  expect(drawn).toMatch(/^[0-9a-f]{8,}$/);
  expect(evalSeed({})).not.toBe(drawn);
});

test("a pair is only started when it fits before the job's deadline", () => {
  const now = 1_000_000_000_000;
  const at = (minutes: number) => String(Math.floor(now / 1000) + minutes * 60);
  // 没设期限：照常做。
  expect(pairFits({}, now, undefined, 20)).toBe(true);
  // 还没有上一对的实测：按最坏情况（两次都跑满）算，2 × 20 分钟再加等复盘的 2 分钟。
  expect(pairFits({ EVAL_DEADLINE_EPOCH: at(60) }, now, undefined, 20)).toBe(
    true,
  );
  expect(pairFits({ EVAL_DEADLINE_EPOCH: at(40) }, now, undefined, 20)).toBe(
    false,
  );
  // 有上一对的实测：按它的一倍半留余量。
  const tenMinutes = 10 * 60_000;
  expect(pairFits({ EVAL_DEADLINE_EPOCH: at(16) }, now, tenMinutes, 20)).toBe(
    true,
  );
  expect(pairFits({ EVAL_DEADLINE_EPOCH: at(14) }, now, tenMinutes, 20)).toBe(
    false,
  );
  // 期限已过。
  expect(pairFits({ EVAL_DEADLINE_EPOCH: at(-1) }, now, tenMinutes, 20)).toBe(
    false,
  );
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
const run = (
  steps: number,
  input: number,
  over: Partial<EvalRecord> = {},
): EvalRecord => ({
  task: "repeat-pitfall",
  title: "t",
  passed: true,
  wallMs: steps * 10_000,
  timedOut: false,
  steps,
  toolCalls: steps,
  modelCalls: steps,
  tokens: { input, output: 1_000, total: input + 1_000 },
  silentStop: false,
  nudges: 0,
  tools: {},
  capabilities,
  checks: [{ name: "out/summary.json 存在", ok: true, detail: "" }],
  ...over,
});
const pair = (first: [number, number], second: [number, number]) =>
  combineRepeat(
    run(first[0], first[1]),
    run(second[0], second[1]),
    REPEAT_PITFALL_TASK,
  );
const side = (
  name: "xiongbao" | "codex",
  records: EvalRecord[],
): EvalResults => ({
  side: name,
  suite: "tasks",
  provider: "deepseek",
  model: "m",
  baseUrl: null,
  runner: name,
  mock: false,
  startedAt: "",
  finishedAt: "",
  records,
  notes: [],
});

test("combineRepeat takes the task name, and a one-pair record keeps its old shape", () => {
  const one = pair([20, 40_000], [10, 20_000]);
  expect(one.task).toBe("repeat-pitfall");
  expect(one.title).toBe(TASK_TITLES["repeat-pitfall"]);
  expect(one).not.toHaveProperty("pairs");
  expect(pairsOf(one)).toHaveLength(1);
  // 不带题名时仍是原来的会议纪要重复题。
  expect(combineRepeat(run(1, 1), run(1, 1)).task).toBe("repeat");
});

test("combinePairs sums the pairs, keeps each pair's two runs and prefixes the checks with the pair", () => {
  const p1 = pair([20, 40_000], [10, 20_000]);
  const p2 = pair([30, 60_000], [12, 24_000]);
  const all = combinePairs(REPEAT_PITFALL_TASK, [p1, p2]);
  expect(all).toMatchObject({
    task: "repeat-pitfall",
    passed: true,
    steps: 72,
    wallMs: 720_000,
  });
  expect(all.tokens?.input).toBe(144_000);
  expect(all).not.toHaveProperty("firstRun");
  expect(all).not.toHaveProperty("secondRun");
  const pairs = pairsOf(all);
  expect(pairs.map((one) => [one.firstRun.steps, one.secondRun.steps])).toEqual(
    [
      [20, 10],
      [30, 12],
    ],
  );
  expect(all.checks.map((item) => item.name)).toEqual([
    "第1对·第一次：out/summary.json 存在",
    "第1对·第二次：out/summary.json 存在",
    "第2对·第一次：out/summary.json 存在",
    "第2对·第二次：out/summary.json 存在",
  ]);
  // 一对时原样返回。
  expect(combinePairs(REPEAT_PITFALL_TASK, [p1])).toBe(p1);
});

test("the report table has one row per pair and an average row, the average judged against 30%", () => {
  const all = combinePairs(REPEAT_PITFALL_TASK, [
    pair([20, 40_000], [10, 20_000]), // -50% / -50%
    pair([30, 60_000], [24, 48_000]), // -20% / -20%
    pair([20, 40_000], [20, 40_000]), // 0 / 0
  ]);
  const rows = repeatRows([["熊宝", side("xiongbao", [all])]]);
  expect(rows).toHaveLength(4);
  expect(rows.map((row) => row[0])).toEqual([
    "熊宝 · 有坑可学 · 第1对",
    "熊宝 · 有坑可学 · 第2对",
    "熊宝 · 有坑可学 · 第3对",
    "熊宝 · 有坑可学 · 平均（3/3 对有效）",
  ]);
  expect(rows[0]).toEqual([
    "熊宝 · 有坑可学 · 第1对",
    "✅ 20 步 / 输入 40,000 / 200 s",
    "✅ 10 步 / 输入 20,000 / 100 s",
    "-50%",
    "-50%",
    "-50%",
  ]);
  // 平均：步数 (20+30+20)/3 -> (10+24+20)/3；变化是各对变化的平均（-50、-20、0 的平均是 -23%）。
  expect(rows[3]).toEqual([
    "熊宝 · 有坑可学 · 平均（3/3 对有效）",
    "✅ 23.3 步 / 输入 46,667 / 233 s",
    "✅ 18 步 / 输入 36,000 / 180 s",
    "-23%",
    "-23%",
    "-23%",
  ]);
  const verdict = repeatVerdicts([["熊宝", side("xiongbao", [all])]]);
  expect(verdict).toHaveLength(1);
  expect(verdict[0]).toContain("熊宝");
  expect(verdict[0]).toContain("-23%");
  expect(verdict[0]).toContain("未达标");
  expect(verdict[0]).toContain("30%");
});

test("an average at or beyond -30% is met; pairs where a run failed are left out of the average", () => {
  const good = pair([20, 40_000], [10, 20_000]);
  const failedSecond = combineRepeat(
    run(20, 40_000),
    run(2, 2_000, { passed: false }),
    REPEAT_PITFALL_TASK,
  );
  const all = combinePairs(REPEAT_PITFALL_TASK, [good, failedSecond]);
  const rows = repeatRows([["熊宝", side("xiongbao", [all])]]);
  expect(rows[2]?.[0]).toBe("熊宝 · 有坑可学 · 平均（1/2 对有效）");
  expect(rows[2]?.[3]).toBe("-50%");
  expect(rows[1]?.[2]).toContain("❌");
  const [verdict] = repeatVerdicts([["熊宝", side("xiongbao", [all])]]);
  expect(verdict).toContain("达标");
  expect(verdict).not.toContain("未达标");
  expect(verdict).toContain("1/2");
});

test("Codex gets its pairs and average too, marked as the control", () => {
  const codexAll = combinePairs(REPEAT_PITFALL_TASK, [
    pair([20, 40_000], [19, 39_000]),
    pair([20, 40_000], [21, 41_000]),
  ]);
  const mineAll = combinePairs(REPEAT_PITFALL_TASK, [
    pair([20, 40_000], [10, 20_000]),
    pair([20, 40_000], [12, 24_000]),
  ]);
  const markdown = renderReport([
    side("xiongbao", [mineAll]),
    side("codex", [codexAll]),
  ]);
  expect(markdown).toContain("Codex · 有坑可学 · 第1对");
  expect(markdown).toContain("Codex · 有坑可学 · 第2对");
  expect(markdown).toContain("Codex · 有坑可学 · 平均");
  expect(markdown).toContain("熊宝 · 有坑可学 · 平均");
  expect(markdown).toMatch(
    /熊宝、Codex 都给出各对的变化和平均值，Codex 只作对照/,
  );
  expect(markdown).toContain("目标");
});

test("the meeting-notes repeat keeps its plain labels when run alone, and is tagged next to the pitfall", () => {
  const meeting = (over: Partial<EvalRecord> = {}) =>
    combineRepeat(
      run(20, 40_000, { task: "repeat" }),
      run(10, 20_000, { task: "repeat", ...over }),
    );
  expect(repeatRows([["熊宝", side("xiongbao", [meeting()])]])[0]?.[0]).toBe(
    "熊宝",
  );
  const both = repeatRows([
    ["熊宝", side("xiongbao", [meeting(), pair([20, 40_000], [10, 20_000])])],
  ]);
  expect(both.map((row) => row[0])).toEqual([
    "熊宝 · 会议纪要（对照）",
    "熊宝 · 有坑可学",
  ]);
});

test("learning rows follow the pairs, and a lone pair is the old single row", () => {
  const learned = (skills: string[]) => ({
    newSkills: skills,
    newMemories: 0,
    usedSkills: [],
  });
  const withLearning = (names: string[]) =>
    combineRepeat(
      run(20, 40_000, { learning: learned(names) }),
      run(10, 20_000, { learning: { ...learned([]), usedSkills: names } }),
      REPEAT_PITFALL_TASK,
    );
  const rows = learningRows([
    [
      "熊宝",
      side("xiongbao", [
        combinePairs(REPEAT_PITFALL_TASK, [
          withLearning(["甲"]),
          withLearning(["乙"]),
        ]),
      ]),
    ],
  ]);
  expect(rows.map((row) => row[0])).toEqual([
    "熊宝 · 有坑可学 · 第1对",
    "熊宝 · 有坑可学 · 第2对",
  ]);
  expect(rows[0]?.[2]).toContain("甲");
  expect(rows[1]?.[2]).toContain("乙");
});
