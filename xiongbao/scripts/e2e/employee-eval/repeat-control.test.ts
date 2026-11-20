import { expect, test } from "bun:test";
import { pairFits } from "./config";
import { REPEAT_PITFALL_TASK } from "./lib";
import type { Capabilities } from "./metrics";
import {
  combinePairs,
  combineRepeat,
  type EvalRecord,
  type EvalResults,
  pairsOf,
} from "./records";
import {
  abAverage,
  abRows,
  renderReport,
  repeatRows,
  repeatVerdicts,
} from "./report";

/*
 * 有坑可学的同种子对照：第二次（有技能）和对照运行（同一份夹具、没技能的新员工）比，
 * 每对变化 = 有技能 ÷ 没技能 − 1；平均有两种写法，判定用各对百分比的平均。
 */

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
/** 一对：第一次固定 40 步，第二次（有技能）、对照（没技能）各给 [步数, 输入 token]。 */
const abPair = (
  withSkill: [number, number],
  control: [number, number],
  over: { control?: Partial<EvalRecord>; second?: Partial<EvalRecord> } = {},
) =>
  combineRepeat(
    run(40, 80_000),
    run(withSkill[0], withSkill[1], over.second),
    REPEAT_PITFALL_TASK,
    run(control[0], control[1], over.control),
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

const three = () =>
  combinePairs(REPEAT_PITFALL_TASK, [
    abPair([10, 20_000], [20, 40_000]), // -50% / -50%
    abPair([24, 48_000], [30, 60_000]), // -20% / -20%
    abPair([12, 24_000], [12, 24_000]), // 0 / 0
  ]);

test("the control run is recorded beside the pair but stays out of the record's totals", () => {
  const one = abPair([10, 20_000], [20, 40_000]);
  expect(one.steps).toBe(50); // 40 + 10，不含对照的 20
  expect(one.controlRun?.steps).toBe(20);
  expect(one.passed).toBe(true);
  expect(pairsOf(one)[0]?.controlRun?.tokens?.input).toBe(40_000);
  const all = three();
  expect(all).not.toHaveProperty("controlRun");
  expect(pairsOf(all).map((pair) => pair.controlRun?.steps)).toEqual([
    20, 30, 12,
  ]);
  // 没有对照运行的对照旧：没有 controlRun 这一项。
  const plain = combineRepeat(run(1, 1), run(1, 1), REPEAT_PITFALL_TASK);
  expect(plain).not.toHaveProperty("controlRun");
});

test("per-pair change is withSkill / control - 1; the mean of the percentages and the ratio of the totals differ", () => {
  const average = abAverage(three());
  expect(average.valid).toBe(3);
  expect(average.total).toBe(3);
  // 各对 -50、-20、0 的平均 = -23.33；总量之比 46 / 62 - 1 = -25.8。
  expect(average.steps.mean).toBeCloseTo(-23.333, 2);
  expect(average.steps.ratio).toBeCloseTo((46 / 62 - 1) * 100, 6);
  expect(average.input.mean).toBeCloseTo(-23.333, 2);
  expect(average.input.ratio).toBeCloseTo((92_000 / 124_000 - 1) * 100, 6);
  expect(average.steps.withSkillTotal).toBe(46);
  expect(average.steps.controlTotal).toBe(62);
});

test("pairs where the with-skill run or the control failed are left out and counted", () => {
  const all = combinePairs(REPEAT_PITFALL_TASK, [
    abPair([10, 20_000], [20, 40_000]),
    // 对照没做成：对照步数少不代表什么。
    abPair([10, 20_000], [2, 2_000], { control: { passed: false } }),
    // 有技能的第二次没做成。
    abPair([1, 1_000], [20, 40_000], { second: { passed: false } }),
    abPair([15, 30_000], [30, 60_000]),
  ]);
  const average = abAverage(all);
  expect(average.valid).toBe(2);
  expect(average.total).toBe(4);
  expect(average.steps.mean).toBeCloseTo(-50, 6);
  expect(average.steps.ratio).toBeCloseTo((25 / 50 - 1) * 100, 6);
  // 第一次没做成不影响这张表（比的是第二次和对照）。
  const firstFailed = combineRepeat(
    run(40, 80_000, { passed: false }),
    run(10, 20_000),
    REPEAT_PITFALL_TASK,
    run(20, 40_000),
  );
  expect(abAverage(firstFailed).valid).toBe(1);
});

test("the A/B table has one row per pair, then the mean row (verdict) and the ratio row (reference)", () => {
  const rows = abRows([["熊宝", side("xiongbao", [three()])]]);
  expect(rows.map((row) => row[0])).toEqual([
    "熊宝 · 有坑可学 · 第1对",
    "熊宝 · 有坑可学 · 第2对",
    "熊宝 · 有坑可学 · 第3对",
    "熊宝 · 有坑可学 · 平均：各对百分比的平均，判定用（3/3 对有效）",
    "熊宝 · 有坑可学 · 总量之比，参考（3/3 对有效）",
  ]);
  expect(rows[0]).toEqual([
    "熊宝 · 有坑可学 · 第1对",
    "✅ 10 步 / 输入 20,000 / 100 s",
    "✅ 20 步 / 输入 40,000 / 200 s",
    "-50%",
    "-50%",
    "-50%",
  ]);
  expect(rows[3]?.slice(3)).toEqual(["-23%", "-23%", "-23%"]);
  expect(rows[4]?.slice(1)).toEqual([
    "✅ 46 步 / 输入 92,000 / 460 s",
    "✅ 62 步 / 输入 124,000 / 620 s",
    "-26%",
    "-26%",
    "-26%",
  ]);
  // 没有对照运行的记录不出这张表；一对也有平均行。
  const plain = combineRepeat(run(1, 1), run(1, 1), REPEAT_PITFALL_TASK);
  expect(abRows([["熊宝", side("xiongbao", [plain])]])).toEqual([]);
  expect(
    abRows([["熊宝", side("xiongbao", [abPair([10, 20_000], [20, 40_000])])]]),
  ).toHaveLength(3);
});

test("the verdict for the pitfall judges with-skill against the control by the mean of the per-pair percentages", () => {
  const [verdict] = repeatVerdicts([["熊宝", side("xiongbao", [three()])]]);
  expect(verdict).toBe(
    "- **熊宝 · 有坑可学**：有技能比没技能：平均步数 -23%、平均输入 token -23%（3/3 对有效）；目标是两项都降 ≥30%：❌ 未达标",
  );
  // 第二次比第一次本来 -75%，但这不再是判定：只看对照。
  const good = combinePairs(REPEAT_PITFALL_TASK, [
    abPair([10, 20_000], [20, 40_000]),
    abPair([14, 28_000], [20, 40_000]),
    abPair([10, 20_000], [20, 40_000], { control: { passed: false } }),
  ]);
  const [met] = repeatVerdicts([["熊宝", side("xiongbao", [good])]]);
  expect(met).toContain("平均步数 -40%、平均输入 token -40%（2/3 对有效）");
  expect(met).toContain("✅ 达标");
  // 数据都没有时不判。
  const none = combinePairs(REPEAT_PITFALL_TASK, [
    abPair([10, 20_000], [20, 40_000], { control: { passed: false } }),
  ]);
  expect(repeatVerdicts([["熊宝", side("xiongbao", [none])]])[0]).toContain(
    "不判目标",
  );
});

test("the first-vs-second table stays, the report labels it as reference and adds the A/B table", () => {
  const mine = side("xiongbao", [three()]);
  // 参考用的第二次比第一次仍然在。
  expect(repeatRows([["熊宝", mine]])).toHaveLength(4);
  const markdown = renderReport([mine]);
  expect(markdown).toContain("第二次比第一次（参考");
  expect(markdown).toContain("## 重复任务 · 同种子对照（有技能 vs 没技能）");
  expect(markdown).toContain("各对百分比的平均是判定用的");
  expect(markdown).toContain("有技能比没技能：平均步数 -23%");
});

test("Codex keeps the first-vs-second verdict: it has no control run", () => {
  const codex = combinePairs(REPEAT_PITFALL_TASK, [
    combineRepeat(run(20, 40_000), run(19, 39_000), REPEAT_PITFALL_TASK),
    combineRepeat(run(20, 40_000), run(21, 41_000), REPEAT_PITFALL_TASK),
  ]);
  const [verdict] = repeatVerdicts([["Codex", side("codex", [codex])]]);
  expect(verdict).toContain("（Codex 只作对照）");
  expect(verdict).not.toContain("有技能比没技能");
});

test("a pitfall pair takes three runs: the fit estimate counts three", () => {
  const now = 1_000_000_000_000;
  const at = (minutes: number) => String(Math.floor(now / 1000) + minutes * 60);
  // 没有上一对的实测：最坏 3 × 20 + 2 = 62 分钟。
  expect(pairFits({ EVAL_DEADLINE_EPOCH: at(70) }, now, undefined, 20, 3)).toBe(
    true,
  );
  expect(pairFits({ EVAL_DEADLINE_EPOCH: at(60) }, now, undefined, 20, 3)).toBe(
    false,
  );
  // 默认还是两次（会议纪要）。
  expect(pairFits({ EVAL_DEADLINE_EPOCH: at(60) }, now, undefined, 20)).toBe(
    true,
  );
  // 有上一对的实测（含三次）：按一倍半。
  const fourteen = 14 * 60_000;
  expect(pairFits({ EVAL_DEADLINE_EPOCH: at(22) }, now, fourteen, 20, 3)).toBe(
    true,
  );
  expect(pairFits({ EVAL_DEADLINE_EPOCH: at(20) }, now, fourteen, 20, 3)).toBe(
    false,
  );
});
