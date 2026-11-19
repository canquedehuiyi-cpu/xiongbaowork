import { expect, test } from "bun:test";
import { DEFAULT_MODEL, evalGate, taskMinutes } from "./config";
import { selectTasks, taskPrompt } from "./lib";
import type { EvalResults } from "./records";
import { renderReport } from "./report";
import { codexConfig } from "./run-codex";
import { SMOKE, selectSmoke } from "./smoke";

const armed = {
  MODEL_E2E: "1",
  GITHUB_ACTIONS: "true",
  MODEL_E2E_API_KEY: "test-key-not-real",
};

test("the gate spends a key only inside the armed GitHub job, and never with the mock there", () => {
  const ok = evalGate(armed);
  expect(ok).toEqual({
    ok: true,
    config: {
      provider: "deepseek",
      model: DEFAULT_MODEL,
      baseUrl: "https://api.deepseek.com",
      apiKey: "test-key-not-real",
      mock: false,
    },
  });
  for (const change of [
    { MODEL_E2E: undefined },
    { GITHUB_ACTIONS: undefined },
    { MODEL_E2E_API_KEY: " " },
    { EVAL_LOCAL_MOCK: "1" },
    { EVAL_BASE_URL: "http://169.254.169.254/v1" },
    { EVAL_PROVIDER: "Deep Seek" },
    { EVAL_MODEL: "two words" },
  ]) {
    const refused = evalGate({ ...armed, ...change });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).not.toContain("test-key-not-real");
  }
  const local = evalGate({ MODEL_E2E: "1", EVAL_LOCAL_MOCK: "1" });
  expect(local.ok && local.config.mock).toBe(true);
});

test("provider, model and endpoint are parameters, not DeepSeek literals", () => {
  const other = evalGate({
    ...armed,
    EVAL_PROVIDER: "moonshot",
    EVAL_MODEL: "kimi-k3",
    EVAL_BASE_URL: "https://example.test/v1/",
  });
  expect(other.ok && other.config).toMatchObject({
    provider: "moonshot",
    model: "kimi-k3",
    baseUrl: "https://example.test/v1",
  });
  const unknown = evalGate({ ...armed, EVAL_PROVIDER: "someone" });
  expect(unknown.ok && unknown.config.baseUrl).toBeNull();
  expect(taskMinutes({})).toBe(20);
  expect(taskMinutes({ EVAL_TASK_MINUTES: "5" })).toBe(5);
});

test("the Codex config points a responses provider at the model, with the key only by env name", () => {
  const toml = codexConfig(
    {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      baseUrl: "https://api.deepseek.com",
    },
    "workspace-write",
  );
  expect(toml).toContain('model = "deepseek-v4-pro"');
  expect(toml).toContain('model_provider = "eval"');
  expect(toml).toContain('wire_api = "responses"');
  expect(toml).toContain('base_url = "https://api.deepseek.com"');
  expect(toml).toContain('env_key = "EVAL_MODEL_API_KEY"');
  expect(toml).toContain("network_access = true");
  expect(() =>
    codexConfig(
      { provider: "x", model: "m", baseUrl: null },
      "workspace-write",
    ),
  ).toThrow();
});

test("task and scenario selection refuse names they do not know", () => {
  expect(selectTasks("all")).toHaveLength(5);
  expect(selectTasks("code, data")).toEqual(["code", "data"]);
  expect(() => selectTasks("cooking")).toThrow();
  expect(selectSmoke(undefined)).toHaveLength(SMOKE.length);
  expect(selectSmoke("plan,long").map((s) => s.name)).toEqual(["plan", "long"]);
  expect(() => selectSmoke("nope")).toThrow();
  expect(taskPrompt("data", "eval/data")).toContain("eval/data/TASK.md");
});

test("the report puts both sides of a task in one row", () => {
  const record = (task: string, passed: boolean) => ({
    task,
    title: task,
    passed,
    wallMs: 61_000,
    timedOut: false,
    steps: 3,
    modelCalls: 4,
    tokens: { input: 10, output: 5, total: 15 },
    silentStop: false,
    nudges: 0,
    tools: {},
    capabilities: {
      plan: "yes" as const,
      planDone: "no" as const,
      subagent: "n/a" as const,
      subagentCount: 0,
      reasoning: "n/a" as const,
      verified: "yes" as const,
      editTool: "n/a" as const,
      grepTool: "n/a" as const,
      stepLimit: "no" as const,
      autoContinued: "no" as const,
    },
    checks: passed
      ? []
      : [{ name: "表头完全一致", ok: false, detail: "表头：x" }],
  });
  const side = (name: "xiongbao" | "codex", passed: boolean): EvalResults => ({
    side: name,
    suite: "tasks",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    baseUrl: "https://api.deepseek.com",
    runner: name,
    mock: false,
    startedAt: "",
    finishedAt: "",
    records: [record("data", passed)],
    notes: [],
  });
  const markdown = renderReport([side("xiongbao", true), side("codex", false)]);
  expect(markdown).toContain("## 五道题（熊宝 1/1，Codex 0/1）");
  expect(markdown).toContain(
    "| 数据处理（data） | ✅ 通过 | ❌ 未过 | 61 s | 61 s | 15 | 15 | 3 | 3 |",
  );
  expect(markdown).toContain(
    "| data | 是 | 否 | 不适用 | 不适用 | 是 | 不适用 | 不适用 | 否 | 否 | 否 | 0 |",
  );
  expect(markdown).toContain("- 表头完全一致：表头：x");
});
