import { expect, test } from "bun:test";
import {
  BASE_SCENARIO,
  calibrate,
  compare,
  FIXED,
  MEASURED,
  render,
  runThread,
  simulate,
} from "./subagent-sim";

test("a thread resends its fixed prefix and the whole history on every step", () => {
  const steps = Array.from({ length: 3 }, () => ({
    call: 70,
    result: 700,
    label: "m",
  }));
  const thread = runThread({ fixed: 1_000, task: 200, steps });
  // 第一步：固定前缀加任务；之后每步多一个调用和一个结果。
  expect(thread.inputs).toEqual([1_200, 1_970, 2_740]);
  // 第一步没有上一步可比；之后前面的都命中，只有新加的一步没命中。
  expect(thread.hits).toEqual([0, 1_200, 1_970]);
});

test("nothing folds under the budget, and a long thread is held near it", () => {
  const fold = { window: 1_000_000, budget: 5_000 };
  const steps = Array.from({ length: 30 }, () => ({
    call: 70,
    result: 700,
    label: "m",
  }));
  const plain = runThread({ fixed: 1_000, task: 200, steps });
  const folded = runThread({ fixed: 1_000, task: 200, steps, fold });
  // 越线之前一步不差；越线之后，长对话的输入被压在预算附近而不是一路涨。
  const crossed = plain.inputs.findIndex((input) => input > 5_000);
  expect(crossed).toBeGreaterThan(0);
  expect(folded.inputs.slice(0, crossed)).toEqual(
    plain.inputs.slice(0, crossed),
  );
  expect(Math.max(...folded.inputs)).toBeLessThan(
    Math.max(...plain.inputs) / 2,
  );
});

test("the per-result size is solved so that the unfolded total is the measured one", () => {
  const size = calibrate(BASE_SCENARIO, MEASURED.input);
  const { total, calls } = simulate({ ...BASE_SCENARIO, resultTokens: size });
  expect(calls).toBe(MEASURED.modelCalls);
  expect(Math.abs(total - MEASURED.input) / MEASURED.input).toBeLessThan(0.001);
});

test("folding cuts the input, and a lighter subagent cuts exactly its fixed prefix on every step", () => {
  const { rows } = compare({});
  const [before, folded, lighter, both] = rows.map((row) => row.run);
  if (!before || !folded || !lighter || !both) throw new Error("four rows");
  expect(folded.total).toBeLessThan(before.total * 0.8);
  expect(folded.peak).toBeLessThan(before.peak / 2);
  const subCalls = BASE_SCENARIO.subagents * BASE_SCENARIO.subSteps;
  expect(before.total - lighter.total).toBe(
    subCalls * (FIXED.subBefore - FIXED.subAfter),
  );
  expect(both.total).toBeLessThan(folded.total);
  // 折叠改写前缀，缓存要重来：省的输入比省的钱多。
  expect(both.billed / before.billed).toBeGreaterThan(
    both.total / before.total,
  );
});

test("the report names every case and the measured figures", () => {
  const text = render();
  for (const word of ["改动前", "只折叠", "只瘦身子代理的工具", "敏感度"])
    expect(text).toContain(word);
  expect(text).toContain("4,949,852");
});
