import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

/**
 * 重复任务多对取平均：输入 `repeat_pairs`（1 到 4，默认 1）以环境变量交给熊宝和 Codex 两侧的作业，
 * 两个作业用同一个种子（同一次运行的 run id），夹具才是同一份。多对在同一次运行里做完（model-e2e 的并发组同一时刻
 * 只放一个在跑），所以作业各自在开头记下一个截止时间，脚本据此决定还来不来得及再做一对。
 * 作业的超时上限不动（model-e2e-workflow.test.ts 里钉着）。
 */

type Step = { name?: string; run?: string; env?: Record<string, string> };
type Job = { "timeout-minutes"?: number; steps: Step[] };
type Workflow = {
  on: {
    workflow_dispatch: {
      inputs: Record<
        string,
        {
          type?: string;
          default?: string;
          options?: string[];
          description?: string;
        }
      >;
    };
  };
  jobs: Record<string, Job>;
};

const workflow = parse(
  readFileSync(
    new URL("../../../.github/workflows/model-e2e.yml", import.meta.url),
    "utf8",
  ),
) as Workflow;
const expression = (inner: string) => `\${{ ${inner} }}`;
const carrierOf = (name: string) =>
  workflow.jobs[name]?.steps.find((step) =>
    Object.values(step.env ?? {}).some((value) =>
      String(value).includes("secrets."),
    ),
  );

test("repeat_pairs is a choice of 1 to 6 that defaults to 1, and tasks can name repeat-pitfall", () => {
  const inputs = workflow.on.workflow_dispatch.inputs;
  expect(inputs.repeat_pairs).toMatchObject({
    type: "choice",
    default: "1",
    options: ["1", "2", "3", "4", "5", "6"],
  });
  expect(inputs.repeat_pairs?.description).toContain("新员工");
  expect(inputs.tasks?.description).toContain("repeat-pitfall");
  // 已有的输入含义不变。
  expect(inputs.tasks?.default).toBe("all");
});

test("both sides get the pair count and one shared seed, and each records a deadline first", () => {
  const seeds = new Set<string | undefined>();
  for (const name of ["employee-eval-xiongbao", "employee-eval-codex"]) {
    const carrier = carrierOf(name);
    expect(carrier?.env?.EVAL_REPEAT_PAIRS).toBe(
      expression("inputs.repeat_pairs"),
    );
    expect(carrier?.env?.EVAL_SEED).toContain("github.run_id");
    seeds.add(carrier?.env?.EVAL_SEED);
    const steps = workflow.jobs[name]?.steps ?? [];
    const deadline = steps.findIndex((step) =>
      (step.run ?? "").includes("EVAL_DEADLINE_EPOCH"),
    );
    expect(deadline).toBeGreaterThanOrEqual(0);
    expect(steps[deadline]?.run).toContain("$GITHUB_ENV");
    expect(steps[deadline]?.run).not.toContain("inputs.");
    // 截止时间要比作业超时早，留出出报告和上传的时间。
    const minutes = Number(
      /\+\s*(\d+)\s*\*\s*60/.exec(steps[deadline]?.run ?? "")?.[1] ?? "0",
    );
    expect(minutes).toBeGreaterThan(0);
    expect(minutes).toBeLessThan(workflow.jobs[name]?.["timeout-minutes"] ?? 0);
    // 它在带 key 的那一步之前。
    expect(deadline).toBeLessThan(steps.indexOf(carrier as Step));
  }
  expect(seeds.size).toBe(1);
});

// 交付题验收：七题 × 单聊 / 群聊两条路径，失败还重跑，一个作业最长要到 GitHub 托管机器的上限 360 分钟（用户 2026-11-23 批准）。
test("the job ceilings are the approved ones", () => {
  expect(workflow.jobs["employee-eval-xiongbao"]?.["timeout-minutes"]).toBe(
    360,
  );
  expect(workflow.jobs["employee-eval-codex"]?.["timeout-minutes"]).toBe(120);
});
