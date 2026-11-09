import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { harnessGate, summaryMarkdown } from "../scripts/model-e2e";

/**
 * Story G6 / audit defect #11: the real-model harness spends a real key, so the workflow that runs
 * it is a manual, main-only job inside the `model-e2e` Environment, with the key reaching it only as
 * that Environment's `secrets.DEEPSEEK_API_KEY` through `env`. The key lives in the Environment and
 * nowhere else (no repository or organisation secret is named). Nothing on a pull request or a push
 * may run it.
 */

const workflowPath = new URL(
  "../../../.github/workflows/model-e2e.yml",
  import.meta.url,
);
const ciPath = new URL("../../../.github/workflows/ci.yml", import.meta.url);
const text = readFileSync(workflowPath, "utf8");

type Step = {
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
};
type Job = {
  if?: string;
  environment?: string | { name?: string };
  "timeout-minutes"?: number;
  permissions?: unknown;
  services?: Record<string, { image?: string }>;
  steps: Step[];
};
type Workflow = {
  on: unknown;
  permissions: unknown;
  concurrency: { group?: string } | string;
  jobs: Record<string, Job>;
};

const workflow = parse(text) as Workflow;

/** A GitHub expression as the YAML spells it, e.g. `${{ vars.X }}`. */
const expression = (inner: string) => `\${{ ${inner} }}`;
const jobs = Object.values(workflow.jobs);

test("the only trigger is a manual dispatch", () => {
  const triggers =
    typeof workflow.on === "string"
      ? [workflow.on]
      : Array.isArray(workflow.on)
        ? workflow.on
        : Object.keys(workflow.on as Record<string, unknown>);
  expect(triggers).toEqual(["workflow_dispatch"]);
  for (const forbidden of [
    "pull_request",
    "pull_request_target",
    "push",
    "schedule",
    "workflow_run",
  ]) {
    expect(triggers).not.toContain(forbidden);
  }
});

test("every job runs only from main, by dispatch, inside the model-e2e Environment", () => {
  expect(jobs.length).toBeGreaterThan(0);
  for (const job of jobs) {
    const condition = (job.if ?? "").replace(/\s+/g, " ").trim();
    expect(condition).toContain("github.event_name == 'workflow_dispatch'");
    expect(condition).toContain("github.ref == 'refs/heads/main'");
    expect(condition).not.toContain("||");
    const environment =
      typeof job.environment === "string"
        ? job.environment
        : job.environment?.name;
    expect(environment).toBe("model-e2e");
    expect(job["timeout-minutes"]).toBeLessThanOrEqual(10);
    expect(job.permissions).toBeUndefined();
  }
});

test("permissions are read-only contents and runs never overlap", () => {
  expect(workflow.permissions).toEqual({ contents: "read" });
  const group =
    typeof workflow.concurrency === "string"
      ? workflow.concurrency
      : workflow.concurrency.group;
  expect(group).toBe("model-e2e");
});

test("actions are pinned to full commit SHAs, Bun is 1.4.4, the lockfile is frozen and no install script runs", () => {
  const steps = jobs.flatMap((job) => job.steps);
  for (const step of steps) {
    if (step.uses) expect(step.uses).toMatch(/@[0-9a-f]{40}$/);
  }
  const bun = steps.find((step) => step.uses?.startsWith("oven-sh/setup-bun@"));
  expect(bun?.with?.["bun-version"]).toBe("1.4.4");
  const installs = steps.filter((step) => step.run?.includes("bun install"));
  expect(installs.length).toBeGreaterThan(0);
  for (const step of installs) {
    expect(step.run).toContain("bun install --frozen-lockfile");
    expect(step.run).toContain("--ignore-scripts");
  }
  for (const job of jobs) {
    const images = Object.values(job.services ?? {}).map((s) => s.image ?? "");
    expect(images.some((image) => /(:|pg)17$/.test(image))).toBe(true);
  }
});

test("the key reaches the job only as the model-e2e Environment's secrets.DEEPSEEK_API_KEY, through env", () => {
  const references = text.match(/secrets\.[A-Za-z0-9_]+/g) ?? [];
  // One reference per carrier job (below), and no other secret named anywhere.
  expect(references).toEqual([
    "secrets.DEEPSEEK_API_KEY",
    "secrets.DEEPSEEK_API_KEY",
  ]);
  expect(text).not.toMatch(/secrets\[/);
  expect(text).not.toContain("toJSON(secrets");

  // Environment secrets reach only jobs that name the Environment; every job here does (above).
  // Exactly two jobs carry the key — G6's reconciliation and G4's real-model WakerFlow run — each in
  // exactly one step, and each of them is one of those jobs.
  const carrierOf = (job: Job) =>
    job.steps.filter((step) =>
      Object.values(step.env ?? {}).some((value) =>
        String(value).includes("secrets."),
      ),
    );
  const carrierJobs = Object.entries(workflow.jobs).filter(
    ([, job]) => carrierOf(job).length > 0,
  );
  expect(carrierJobs.map(([name]) => name).sort()).toEqual([
    "model-e2e",
    "wakerflow-real-model",
  ]);
  for (const [, job] of carrierJobs) {
    expect(carrierOf(job)).toHaveLength(1);
    const carrierEnvironment =
      typeof job.environment === "string"
        ? job.environment
        : job.environment?.name;
    expect(carrierEnvironment).toBe("model-e2e");
  }

  const steps = jobs.flatMap((job) => job.steps);
  const carriers = steps.filter((step) =>
    Object.values(step.env ?? {}).some((value) =>
      String(value).includes("secrets."),
    ),
  );
  expect(carriers).toHaveLength(2);
  for (const step of steps) {
    expect(step.run ?? "").not.toContain("secrets.");
    expect(JSON.stringify(step.with ?? {})).not.toContain("secrets.");
  }
  for (const carrier of carriers) {
    expect(carrier.env?.MODEL_E2E_API_KEY).toBe(
      expression("secrets.DEEPSEEK_API_KEY"),
    );
    // Model and endpoint are variables with DeepSeek's own defaults when the variable is unset.
    expect(carrier.env?.MODEL_E2E_MODEL).toBe(
      expression("vars.MODEL_E2E_MODEL || 'deepseek-chat'"),
    );
    expect(carrier.env?.MODEL_E2E_BASE_URL).toBe(
      expression("vars.MODEL_E2E_BASE_URL || 'https://api.deepseek.com/v1'"),
    );
    expect(carrier.env?.MODEL_E2E).toBe("1");
    // The mock-provider switch is for a laptop only; the armed jobs never set it.
    expect(carrier.env?.MODEL_E2E_LOCAL_MOCK).toBeUndefined();
  }
  const [g6] = carrierOf(workflow.jobs["model-e2e"] as Job);
  // The key is a DeepSeek key, so G6's provider is DeepSeek.
  expect(g6?.env?.MODEL_E2E_PROVIDER).toBe("deepseek");
  expect(g6?.run).toContain("scripts/model-e2e.ts");
  const [g4] = carrierOf(workflow.jobs["wakerflow-real-model"] as Job);
  expect(g4?.run).toContain("scripts/e2e/wakerflow-real-model.ts");
});

test("the DeepSeek defaults pass the harness gate", () => {
  const gate = harnessGate({
    MODEL_E2E: "1",
    GITHUB_ACTIONS: "true",
    MODEL_E2E_API_KEY: "test-key-not-real",
    DATABASE_URL: "postgres://openbot_app:x@127.0.0.1:5432/e2e",
    MODEL_E2E_PROVIDER: "deepseek",
    MODEL_E2E_MODEL: "deepseek-chat",
    MODEL_E2E_BASE_URL: "https://api.deepseek.com/v1",
  });
  expect(gate.ok).toBe(true);
  if (gate.ok) {
    expect(gate.config.provider).toBe("deepseek");
    expect(gate.config.baseUrl).toBe("https://api.deepseek.com/v1");
  }
});

test("the workflow carries no key-like literal", () => {
  for (const pattern of [
    /sk-[A-Za-z0-9_-]{16,}/,
    /sk-ant-[A-Za-z0-9_-]+/,
    /AKIA[0-9A-Z]{16}/,
    /AIza[0-9A-Za-z_-]{20,}/,
    /gh[pousr]_[A-Za-z0-9]{20,}/,
    /xox[abprs]-[A-Za-z0-9-]+/,
    /Bearer\s+[A-Za-z0-9._-]{10,}/i,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /api[_-]?key\s*[:=]\s*["']?[A-Za-z0-9_-]{12,}/i,
  ]) {
    expect(text).not.toMatch(pattern);
  }
});

test("ci.yml never runs the harness", () => {
  const ci = readFileSync(ciPath, "utf8");
  expect(ci).not.toContain("model-e2e");
  expect(ci).not.toContain("MODEL_E2E");
});

test("the harness refuses to spend a key outside the armed GitHub job", () => {
  const armed = {
    MODEL_E2E: "1",
    GITHUB_ACTIONS: "true",
    MODEL_E2E_API_KEY: "test-key-not-real",
    DATABASE_URL: "postgres://openbot_app:x@127.0.0.1:5432/e2e",
    MODEL_E2E_PROVIDER: "openai",
    MODEL_E2E_MODEL: "gpt-test",
  };
  const gate = harnessGate(armed);
  expect(gate.ok).toBe(true);
  if (gate.ok) expect(gate.config.baseUrl).toBeNull();

  for (const [name, value] of [
    ["MODEL_E2E", undefined],
    ["MODEL_E2E", "true"],
    ["GITHUB_ACTIONS", undefined],
    ["GITHUB_ACTIONS", "false"],
    ["MODEL_E2E_API_KEY", undefined],
    ["MODEL_E2E_API_KEY", "   "],
    ["DATABASE_URL", undefined],
    ["MODEL_E2E_PROVIDER", undefined],
    ["MODEL_E2E_PROVIDER", "Open AI"],
    ["MODEL_E2E_MODEL", ""],
    ["MODEL_E2E_BASE_URL", "http://169.254.169.254/v1"],
    ["MODEL_E2E_BASE_URL", "not a url"],
  ] as const) {
    const refused = harnessGate({ ...armed, [name]: value });
    expect(refused.ok).toBe(false);
    // A refusal names the variable, never the key.
    if (!refused.ok) expect(refused.reason).not.toContain("test-key-not-real");
  }

  const withEndpoint = harnessGate({
    ...armed,
    MODEL_E2E_BASE_URL: "https://api.example.test/v1",
  });
  expect(withEndpoint.ok && withEndpoint.config.baseUrl).toBe(
    "https://api.example.test/v1",
  );
});

test("the step summary carries counts and field names, nothing else", () => {
  const summary = summaryMarkdown({
    originalText: "openai/gpt-test",
    usageStatus: "unknown",
    rowInput: 0,
    rowOutput: null,
    providerUsage: {},
    usageSource: "wire",
    callError: null,
    result: {
      ok: false,
      mismatches: [{ field: "inputTokens", expected: null, actual: 0 }],
    },
  });
  expect(summary).toContain("不一致");
  expect(summary).toContain("| inputTokens | null | 0 |");
  expect(summary).toContain("| 供应商报告 | null | null |");
  expect(summary).toContain("| model_token_calls | 0 | null |");
  expect(summary).toContain("响应体原始 usage");
});
