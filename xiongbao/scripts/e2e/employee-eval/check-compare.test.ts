import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkCompare, starCount } from "./check-compare";
import { CHECKERS } from "./checkers";
import { GOLD_DIR, HARD_TASKS, selectTasks, taskPrompt } from "./lib";
import type { EvalRecord, EvalResults } from "./records";
import { renderReport } from "./report";
import {
  cleanup,
  emptyDir,
  failed,
  solved,
  untouched,
  write,
} from "./test-support";

afterAll(cleanup);

const gold = readFileSync(join(GOLD_DIR, "compare", "compare.md"), "utf8");

test("the standard answer passes every check", async () => {
  const outcome = await checkCompare(solved("compare"));
  expect(failed(outcome)).toEqual([]);
  expect(outcome.passed).toBe(true);
  expect(outcome.task).toBe("compare");
  expect(await CHECKERS.compare(solved("compare"))).toEqual(outcome);
});

test("an empty directory and the untouched fixture fail", async () => {
  for (const dir of [emptyDir(), untouched("compare")]) {
    const outcome = await checkCompare(dir);
    expect(outcome.passed).toBe(false);
    expect(failed(outcome)).toContain("compare.md 存在");
  }
});

test("a wrong license, a made-up star count, a stale date and a missing link are each caught", async () => {
  const dir = untouched("compare");
  write(
    dir,
    "compare.md",
    gold
      .replace("| Linux | GPL-2.0 |", "| Linux | MIT |")
      .replace("| 19k |", "| 900 |")
      .replace("| 2026-11-12 |", "| 2024-01-01 |")
      .replace(
        "https://github.com/microsoft/vscode",
        "https://code.visualstudio.com",
      ),
  );
  expect(failed(await checkCompare(dir))).toEqual([
    "许可证与官方声明一致",
    "star 数是数字且不低于保守下限",
    "最近活跃日期是检索日期前一年内的 YYYY-MM-DD",
    "每行附了这个项目的 GitHub 地址",
  ]);
});

test("a dual license needs both halves, and a project with no paragraph of its own fails", async () => {
  const dir = untouched("compare");
  write(
    dir,
    "compare.md",
    gold
      .replace("| Rust | MIT / Apache-2.0 |", "| Rust | MIT |")
      .replace(/## Kubernetes\n\n[^\n]+\n/, "## Kubernetes\n\n见下表。\n"),
  );
  expect(failed(await checkCompare(dir))).toEqual([
    "五个项目各有一个小节、各写了一段",
    "许可证与官方声明一致",
  ]);
});

test("star counts are read in the usual ways people write them", () => {
  expect(starCount("200k")).toBe(200_000);
  expect(starCount("123,456")).toBe(123_456);
  expect(starCount("12.3万")).toBe(123_000);
  expect(starCount("约 1.2M")).toBe(1_200_000);
  expect(starCount("未查到")).toBeNull();
});

test("the hard task is picked by name or by `hard`, and `all` stays the five", () => {
  expect(HARD_TASKS).toEqual(["compare"]);
  expect(selectTasks("hard")).toEqual(["compare"]);
  expect(selectTasks("all,hard")).toHaveLength(6);
  expect(selectTasks("compare, code")).toEqual(["code", "compare"]);
  expect(taskPrompt("compare", "eval/compare")).toContain(
    "「五个开源项目对比」",
  );
});

test("the report shows the hard task in its own section and keeps it out of the five-task count", () => {
  const record = (task: string): EvalRecord => ({
    task,
    title: task,
    passed: true,
    wallMs: 1000,
    timedOut: false,
    steps: 30,
    modelCalls: 30,
    tokens: { input: 900, output: 100, total: 1000 },
    silentStop: false,
    nudges: 0,
    tools: {},
    capabilities: {
      plan: "yes",
      planDone: "yes",
      subagent: "yes",
      subagentCount: 5,
      reasoning: "yes",
      verified: "n/a",
      editTool: "n/a",
      grepTool: "n/a",
      stepLimit: "no",
      autoContinued: "no",
    },
    checks: [],
  });
  const side: EvalResults = {
    side: "xiongbao",
    suite: "tasks",
    provider: "deepseek",
    model: "m",
    baseUrl: null,
    runner: "r",
    mock: false,
    startedAt: "",
    finishedAt: "",
    records: [record("code"), record("compare")],
    notes: [],
  };
  const markdown = renderReport([side]);
  expect(markdown).toContain("## 五道题（熊宝 1/1，Codex —）");
  expect(markdown).toContain(
    "| 五个开源项目对比 | ✅ 通过 | — | 1,000 | — | 30 | 是 | 是（5） | — | — |",
  );
});
