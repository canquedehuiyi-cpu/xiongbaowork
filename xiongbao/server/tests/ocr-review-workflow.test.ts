import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";

/**
 * The pre-review workflow is advice only. It may read the repository, run the review script with the
 * model key of its own Environment, and upload one artifact. It must not be able to comment, approve,
 * label or merge, and must not let a model key reach any other job, step or file. The key goes only to
 * a script read from main: a pull request's own workflow file or script never runs with it, so the only
 * trigger is a manual run on main, like the model-e2e workflow. This reads the YAML the way that
 * workflow's test does.
 */

const workflowPath = new URL(
  "../../../.github/workflows/ocr-review.yml",
  import.meta.url,
);
const ciPath = new URL("../../../.github/workflows/ci.yml", import.meta.url);
const scriptPath = new URL(
  "../../scripts/review/ocr/run-review.sh",
  import.meta.url,
);
const text = readFileSync(workflowPath, "utf8");
/** The YAML without its full-line comments, which talk about what the workflow must not do. */
const code = text
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("#"))
  .join("\n");

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
};
type Job = {
  if?: string;
  environment?: string | { name?: string };
  "continue-on-error"?: boolean;
  "timeout-minutes"?: number;
  "runs-on"?: string;
  permissions?: unknown;
  steps: Step[];
};
type Workflow = {
  on: Record<string, { inputs?: Record<string, unknown> }>;
  permissions: unknown;
  concurrency: { group?: string; "cancel-in-progress"?: boolean };
  jobs: Record<string, Job>;
};

/** A GitHub expression as the YAML spells it, e.g. `${{ vars.X }}`. */
const expression = (inner: string) => `\${{ ${inner} }}`;

const workflow = parse(text) as Workflow;
const job = workflow.jobs["ocr-review"] as Job;
const steps = Object.values(workflow.jobs).flatMap((one) => one.steps);

const reviewScript = "bash xiongbao/scripts/review/ocr/run-review.sh";
const expectedCondition =
  "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'";

test("it runs by hand and on nothing else", () => {
  expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
  expect(Object.keys(workflow.on.workflow_dispatch?.inputs ?? {})).toEqual([
    "base",
    "head",
  ]);
  expect(Object.keys(workflow.jobs)).toEqual(["ocr-review"]);
});

test("it never uses pull_request_target and has no pull_request, push or schedule trigger", () => {
  expect(code).not.toContain("pull_request_target");
  for (const trigger of ["pull_request", "push", "schedule", "workflow_run"])
    expect(Object.keys(workflow.on)).not.toContain(trigger);
  expect(code).not.toMatch(
    /^\s*(pull_request|push|schedule|workflow_run)\s*:/m,
  );
});

test("the job runs only for a manual run on main, so the script that sees the key is main's", () => {
  const condition = (job.if ?? "").replace(/\s+/g, " ").trim();
  expect(condition).toBe(expectedCondition);
});

test("the review range is read as git objects: the checkout is of main and no step checks out another ref", () => {
  const checkouts = steps.filter((step) =>
    step.uses?.startsWith("actions/checkout@"),
  );
  expect(checkouts).toHaveLength(1);
  expect(Object.keys(checkouts[0]?.with ?? {}).sort()).toEqual([
    "fetch-depth",
    "persist-credentials",
  ]);
  for (const step of steps)
    expect(step.run ?? "").not.toMatch(
      /\bgit\s+(checkout|switch|merge|rebase|pull|worktree)\b/,
    );
});

test("the token is read-only contents, for the workflow and the job", () => {
  expect(workflow.permissions).toEqual({ contents: "read" });
  expect(job.permissions).toBeUndefined();
  expect(code).not.toMatch(/:\s*write\b/);
  expect(code).not.toMatch(/\bwrite-all\b/);
  expect(code).not.toContain("GITHUB_TOKEN");
  expect(code).not.toMatch(/secrets\.GITHUB_TOKEN/);
});

test("a failed review fails nothing: the job continues on error and is bounded", () => {
  expect(job["continue-on-error"]).toBe(true);
  expect(job["timeout-minutes"]).toBeLessThanOrEqual(30);
  expect(job["runs-on"]).toBe("ubuntu-latest");
  expect(workflow.concurrency["cancel-in-progress"]).toBe(true);
});

test("the model key is the ocr-review Environment's secret, in one step's env and nowhere else", () => {
  const environment =
    typeof job.environment === "string"
      ? job.environment
      : job.environment?.name;
  expect(environment).toBe("ocr-review");
  const references = code.match(/secrets\.[A-Za-z0-9_]+/g) ?? [];
  expect(references).toEqual(["secrets.OCR_API_KEY"]);
  expect(code).not.toMatch(/secrets\[/);
  expect(code).not.toContain("toJSON(secrets");
  expect(code).not.toContain("secrets: inherit");
  const carriers = steps.filter((step) =>
    Object.values(step.env ?? {}).some((value) =>
      String(value).includes("secrets."),
    ),
  );
  expect(carriers).toHaveLength(1);
  expect(carriers[0]?.env?.OCR_API_KEY).toBe(expression("secrets.OCR_API_KEY"));
  // The step that holds the key runs exactly the review script, nothing before or after it.
  expect(carriers[0]?.run?.trim()).toBe(reviewScript);
  expect(Object.hasOwn(carriers[0] ?? {}, "uses")).toBe(false);
  // The key is named once in the whole file, in that step's env.
  expect(text.match(/OCR_API_KEY\s*:/g) ?? []).toHaveLength(1);
  expect(code.match(/secrets\./g) ?? []).toHaveLength(1);
  for (const step of steps) {
    expect(step.run ?? "").not.toContain("secrets.");
    expect(JSON.stringify(step.with ?? {})).not.toContain("secrets.");
  }
  // Model and provider are variables of the same Environment. The provider has no default: the person
  // who opens the review chooses where the code goes.
  expect(carriers[0]?.env?.OCR_PROVIDER).toBe(expression("vars.OCR_PROVIDER"));
  expect(carriers[0]?.env?.OCR_INCLUDE_TESTS).toBe("1");
  expect(carriers[0]?.env?.OCR_MODEL).toBe(
    expression("vars.OCR_MODEL || 'deepseek-v4-flash'"),
  );
});

test("no step can send anything anywhere: curl, wget, nc and base64 do not appear", () => {
  expect(code).not.toMatch(/\b(curl|wget|nc|ncat|netcat|base64)\b/);
  // Only one step names the model key at all.
  const named = steps.filter((step) =>
    JSON.stringify(step).includes("OCR_API_KEY"),
  );
  expect(named).toHaveLength(1);
});

test("nothing in it can comment on, approve, label or merge a pull request", () => {
  const allowed = ["actions/checkout@", "actions/upload-artifact@"];
  for (const step of steps) {
    if (step.uses)
      expect(allowed.some((prefix) => step.uses?.startsWith(prefix))).toBe(
        true,
      );
  }
  for (const forbidden of [
    /github-script/,
    /peter-evans/,
    /\bgh\s+(pr|api|issue|release|run)\b/,
    /api\.github\.com/,
    /\/(pulls|issues|comments|reviews|merges)\b/,
    /createComment|createReview|pulls\.merge|enableAutoMerge|auto-merge/i,
    /--approve|--request-changes|--comment\b/,
    // `merge-base` is how the range is compared; any other merge is the merge button.
    /\bmerge(?!-base)\b/i,
  ]) {
    expect(code).not.toMatch(forbidden);
  }
  // The only thing it hands on is one artifact.
  const uploads = steps.filter((step) =>
    step.uses?.startsWith("actions/upload-artifact@"),
  );
  expect(uploads).toHaveLength(1);
  expect(uploads[0]?.with?.name).toBe("ocr-review-report");
});

test("every action is pinned to a full commit SHA, the same one ci.yml uses", () => {
  const ci = readFileSync(ciPath, "utf8");
  for (const step of steps) {
    if (!step.uses) continue;
    expect(step.uses).toMatch(/@[0-9a-f]{40}$/);
    expect(ci).toContain(`uses: ${step.uses}`);
  }
});

test("the checkout keeps no credentials and fetches the history the merge-base needs", () => {
  const checkout = steps.find((step) =>
    step.uses?.startsWith("actions/checkout@"),
  );
  expect(checkout?.with?.["persist-credentials"]).toBe(false);
  expect(checkout?.with?.["fetch-depth"]).toBe(0);
});

test("dispatch inputs reach the script as env, never in a shell line", () => {
  for (const step of steps) {
    expect(step.run ?? "").not.toContain("inputs.");
    expect(step.run ?? "").not.toContain("github.event");
    expect(step.run ?? "").not.toContain("${{");
  }
  const review = steps.find((step) => step.env?.OCR_BASE !== undefined);
  expect(review?.env?.OCR_BASE).toBe(expression("inputs.base"));
  expect(review?.env?.OCR_HEAD).toBe(expression("inputs.head"));
});

test("the review script exists, pins the ocr version, and installs it without lifecycle scripts", () => {
  expect(existsSync(scriptPath)).toBe(true);
  const script = readFileSync(scriptPath, "utf8");
  expect(script).toMatch(/^OCR_VERSION="\d+\.\d+\.\d+"$/m);
  expect(script).toContain("--ignore-scripts");
  expect(script).toContain('"@alibaba-group/open-code-review@$OCR_VERSION"');
  expect(script).not.toMatch(/open-code-review@latest|npm install -g/);
  // Nothing in the workflow installs it by another route.
  expect(code).not.toContain("npm install");
  expect(code).not.toContain("npx");
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
