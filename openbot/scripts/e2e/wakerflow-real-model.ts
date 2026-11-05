/**
 * Gate G4 with a REAL model: the WakerFlow lifecycle once more, through the API (no browser), against a
 * real server process, a real PostgreSQL and a real OpenAI-compatible provider (DeepSeek by default).
 * `wakerflow-lifecycle.ts` proves the same lifecycle in CI with the model mocked; this closes the gap
 * "does it hold when an actual model plans the Flow and answers the steps".
 *
 * Run only by `.github/workflows/model-e2e.yml` (job `wakerflow-real-model`), by hand, from main, inside
 * the GitHub Environment `model-e2e`. It spends real tokens on a real key, so — exactly like
 * `server/scripts/model-e2e.ts` (G6) — it refuses unless `MODEL_E2E=1`, `GITHUB_ACTIONS=true` and
 * `MODEL_E2E_API_KEY` are all set. `ci.yml` does not reference it.
 *
 *   1. one person signs up (password form API), is named administrator the documented way
 *      (`server/scripts/grant-admin.ts`) and moves the workspace to Pro;
 *   2. one model-library row points at the provider (`custom`, OpenAI-compatible, the key in the body
 *      of `POST /api/models` and nowhere else), and two coworkers are bound to it;
 *   3. generate: ONE short Chinese sentence -> the real planner -> a valid plan of at least two steps;
 *   4. edit every step's instruction (asks for a one-sentence answer, which also keeps spend tiny) and
 *      save: the Flow is `ready` at the next revision with the edited instructions;
 *   5. run 1 -> 已完成 (`done`), every step `done` with a non-empty output;
 *   6. run 2 -> aborted while a step is at the model: 已停止 (`aborted`), and no later step ran;
 *   7. `model_token_calls`, read AS THE TENANT (row-level security decides what is visible, the way G6
 *      reads it): every finished step of both runs has a `reported` row with input and output > 0.
 *
 * The deployment's own model (`OPENAI_BASE_URL`) is a local stub that answers 503 and is never meant
 * to be asked: every model call must go through the bound library row. Its hit count is asserted.
 *
 * Prints counts, ids and statuses only: never the key, a model's answer, or a provider error body.
 *
 * Local verification only: `MODEL_E2E_LOCAL_MOCK=1` replaces the `GITHUB_ACTIONS=true` requirement
 * and puts a local aimock (`@copilotkit/aimock`) in the provider's place. That mock listens on plain
 * http on loopback, so in that mode — and only in it — the server gets the development-only switch
 * `AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS=true` (audit defect #6). The mock mode refuses to run inside
 * GitHub Actions, so the real job can never pass against a mock.
 *
 * Environment:
 *   MODEL_E2E=1, MODEL_E2E_API_KEY       the gate (in mock mode any placeholder value)
 *   GITHUB_ACTIONS=true                  the gate, or MODEL_E2E_LOCAL_MOCK=1 (local only)
 *   MODEL_E2E_MODEL                      the model name (mock mode: default `g4-real-mock`)
 *   MODEL_E2E_BASE_URL                   the provider's https base URL (ignored in mock mode)
 *   E2E_DATABASE_URL                     the API's role (openbot_app, NOSUPERUSER NOBYPASSRLS)
 *   E2E_ROLE_WRITER_DATABASE_URL         the restricted role writer (migration 0109)
 *   E2E_ARTIFACTS_DIR                    where the server log goes (default ./e2e-artifacts); never printed
 *   E2E_SERVER_PORT                      default: a free port
 *
 * Usage (from openbot/): bun scripts/e2e/wakerflow-real-model.ts
 */

import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { resolve } from "node:path";
import type { Subprocess } from "bun";

// ---------------------------------------------------------------------------------------------
// The gate: decided before anything starts. Reasons name variables, never their values.
// ---------------------------------------------------------------------------------------------

type Config = {
  mock: boolean;
  apiKey: string;
  modelName: string;
  baseUrl: string | null;
  databaseUrl: string;
  roleWriterDatabaseUrl: string;
};

function gate(
  env: Record<string, string | undefined>,
): { ok: true; config: Config } | { ok: false; reason: string } {
  if (env.MODEL_E2E !== "1")
    return { ok: false, reason: "MODEL_E2E=1 is not set" };
  const mock = env.MODEL_E2E_LOCAL_MOCK === "1";
  if (mock && env.GITHUB_ACTIONS === "true")
    return {
      ok: false,
      reason: "MODEL_E2E_LOCAL_MOCK=1 is for local verification only",
    };
  if (!mock && env.GITHUB_ACTIONS !== "true")
    return { ok: false, reason: "not running inside GitHub Actions" };
  const apiKey = env.MODEL_E2E_API_KEY?.trim();
  if (!apiKey) return { ok: false, reason: "MODEL_E2E_API_KEY is not set" };
  const modelName = env.MODEL_E2E_MODEL?.trim() || (mock ? "g4-real-mock" : "");
  if (!modelName) return { ok: false, reason: "MODEL_E2E_MODEL is not set" };
  let baseUrl: string | null = null;
  if (!mock) {
    baseUrl = env.MODEL_E2E_BASE_URL?.trim() || null;
    let protocol = "";
    try {
      protocol = baseUrl ? new URL(baseUrl).protocol : "";
    } catch {
      protocol = "";
    }
    if (protocol !== "https:")
      return { ok: false, reason: "MODEL_E2E_BASE_URL must be an https URL" };
  }
  const databaseUrl = env.E2E_DATABASE_URL?.trim();
  if (!databaseUrl) return { ok: false, reason: "E2E_DATABASE_URL is not set" };
  const roleWriterDatabaseUrl = env.E2E_ROLE_WRITER_DATABASE_URL?.trim();
  if (!roleWriterDatabaseUrl)
    return { ok: false, reason: "E2E_ROLE_WRITER_DATABASE_URL is not set" };
  return {
    ok: true,
    config: {
      mock,
      apiKey,
      modelName,
      baseUrl,
      databaseUrl,
      roleWriterDatabaseUrl,
    },
  };
}

const verdict = gate(process.env);
if (!verdict.ok) {
  console.error(`wakerflow-real-model refused: ${verdict.reason}`);
  process.exit(2);
}
const config = verdict.config;
// Nothing downstream needs the plaintext in the environment once it is held here.
delete process.env.MODEL_E2E_API_KEY;

// ---------------------------------------------------------------------------------------------
// Configuration and reporting
// ---------------------------------------------------------------------------------------------

const ROOT = resolve(import.meta.dir, "../..");
const SERVER_DIR = resolve(ROOT, "server");
const ARTIFACTS = resolve(
  process.env.E2E_ARTIFACTS_DIR?.trim() || "e2e-artifacts",
);
mkdirSync(ARTIFACTS, { recursive: true });

/** One short sentence, so the planning prompt stays small; it asks for two steps outright. */
const IDEA = "分两步：先列出一个选题的三个要点，再把要点总结成一句话。";
/** Appended to every step on Save: the edit under test, and what keeps each answer to a few tokens. */
const BRIEF = "（只用一句不超过二十字的中文回答。）";
const ADMIN_EMAIL = `g4-real-${randomUUID().slice(0, 8)}@example.test`;
const TERMINAL = new Set(["done", "failed", "aborted"]);

const started = Date.now();
let assertions = 0;

function check(condition: unknown, message: string): asserts condition {
  assertions += 1;
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  console.log(`  ok  ${message}`);
}

function equal<T>(actual: T, expected: T, message: string) {
  check(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`,
  );
}

async function step(name: string, body: () => Promise<void>) {
  const at = Date.now();
  console.log(`\n== ${name}`);
  await body();
  console.log(`   PASS ${name} (${((Date.now() - at) / 1000).toFixed(1)} s)`);
}

async function until<T>(
  what: string,
  probe: () =>
    | Promise<T | undefined | null | false>
    | T
    | undefined
    | null
    | false,
  timeoutMs = 30_000,
  everyMs = 250,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  for (;;) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      // Only this server's answers and this harness's own errors land here; capped all the same.
      last = (error instanceof Error ? error.message : "unknown").slice(0, 200);
    }
    if (Date.now() > deadline)
      throw new Error(
        `Timed out after ${timeoutMs} ms waiting for ${what}${last ? ` (last error: ${last})` : ""}`,
      );
    await Bun.sleep(everyMs);
  }
}

// ---------------------------------------------------------------------------------------------
// The deployment model stub (never meant to be asked) and, in mock mode only, the provider
// ---------------------------------------------------------------------------------------------

let deploymentHits = 0;
const deploymentStub = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch() {
    deploymentHits += 1;
    return new Response(null, { status: 503 });
  },
});

const ids = { lister: "", summarizer: "" };
let providerUrl = config.baseUrl ?? "";
let stopMock: () => Promise<unknown> = async () => undefined;
const mockCalls = { plan: 0, step: 0 };

if (config.mock) {
  const { LLMock } = await import("@copilotkit/aimock");
  const mock = new LLMock({ host: "127.0.0.1", port: 0 });
  mock.onMessage(/[\s\S]*/, async (request) => {
    const text = JSON.stringify(
      (request as { messages?: unknown }).messages ?? request,
    );
    if (text.includes("用户的想法：")) {
      mockCalls.plan += 1;
      // A real planner wraps its answer in prose; the generator takes the first balanced object.
      return {
        content: `好的：\n${JSON.stringify({
          name: "要点与总结",
          description: "列要点，再总结",
          members: [
            { agentId: ids.lister, role: "列要点" },
            { agentId: ids.summarizer, role: "写总结" },
          ],
          inputs: [{ key: "topic", label: "选题", required: true }],
          steps: [
            {
              id: "points",
              agentId: ids.lister,
              instruction: "列出选题的三个要点",
              inputKeys: ["topic"],
              outputKey: "points",
            },
            {
              id: "summary",
              agentId: ids.summarizer,
              instruction: "把要点总结成一句话",
              inputKeys: ["points"],
              outputKey: "summary",
            },
          ],
        })}`,
        usage: { prompt_tokens: 180, completion_tokens: 120 },
      };
    }
    mockCalls.step += 1;
    // About as long as a real provider takes, so run 2 has a step in flight to abort.
    await Bun.sleep(1500);
    return {
      content: "一句简短的回答。",
      usage: { prompt_tokens: 64, completion_tokens: 9 },
    };
  });
  providerUrl = `${await mock.start()}/v1`;
  stopMock = () => mock.stop();
}

// ---------------------------------------------------------------------------------------------
// The server, started and killed by PID (the lifecycle harness's recipe, minus the built app)
// ---------------------------------------------------------------------------------------------

async function freePort(): Promise<number> {
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  });
  const port = probe.port;
  probe.stop(true);
  return port as number;
}

const PORT = Number(process.env.E2E_SERVER_PORT?.trim() || (await freePort()));
const ORIGIN = `http://127.0.0.1:${PORT}`;
const serverEnv: Record<string, string> = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "/tmp",
  NODE_ENV: "test",
  PORT: String(PORT),
  DATABASE_URL: config.databaseUrl,
  ROLE_WRITER_DATABASE_URL: config.roleWriterDatabaseUrl,
  // Fresh per run, like the database.
  KEY_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
  BETTER_AUTH_URL: ORIGIN,
  OPENBOT_PUBLIC_URL: ORIGIN,
  INITIAL_ADMIN_EMAILS: ADMIN_EMAIL,
  INTELLIGENCE_MODE: "local",
  TENANT_PACKAGE_DIR: "../examples/qoderwake",
  // The deployment's model is the stub: nothing may reach it (asserted at the end).
  OPENAI_BASE_URL: `http://127.0.0.1:${deploymentStub.port}/v1`,
  OPENAI_API_KEY: "g4-deployment-stub-not-a-secret",
  COPILOTKIT_TELEMETRY_DISABLED: "true",
  DO_NOT_TRACK: "1",
  // The mock provider listens on loopback over plain http; development-only switch (audit defect
  // #6). Mock mode only: against the real provider the SSRF guard stays fully on.
  ...(config.mock ? { AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS: "true" } : {}),
};

let server: Subprocess | undefined;

async function startServer() {
  const log = resolve(ARTIFACTS, "server-real-model.log");
  // One descriptor for both streams, so stdout and stderr interleave instead of overwriting.
  const fd = openSync(log, "w");
  server = Bun.spawn(["bun", "src/index.ts"], {
    cwd: SERVER_DIR,
    env: serverEnv,
    stdout: fd,
    stderr: fd,
  });
  closeSync(fd);
  const pid = server.pid;
  await until(
    `server ${pid} /health`,
    async () => {
      if (server?.exitCode !== null)
        throw new Error(`server exited ${server?.exitCode}`);
      const response = await fetch(`${ORIGIN}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      return response.status === 200;
    },
    90_000,
    500,
  );
  console.log(`   server pid ${pid} healthy on ${ORIGIN}`);
}

async function stopServer() {
  const running = server;
  if (!running) return;
  running.kill("SIGTERM");
  const exited = await Promise.race([
    running.exited.then(() => true),
    Bun.sleep(10_000).then(() => false),
  ]);
  if (!exited) {
    running.kill("SIGKILL");
    await running.exited;
  }
  console.log(
    `   server pid ${running.pid} stopped, exit ${running.signalCode ?? running.exitCode}`,
  );
  server = undefined;
}

// ---------------------------------------------------------------------------------------------
// The API, with the session cookie the sign-up set
// ---------------------------------------------------------------------------------------------

const cookies = new Map<string, string>();

async function api<T = Record<string, unknown>>(
  method: "GET" | "POST" | "PUT" | "PATCH",
  path: string,
  data?: unknown,
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${ORIGIN}${path}`, {
    method,
    headers: {
      origin: ORIGIN,
      ...(cookies.size > 0
        ? {
            cookie: [...cookies]
              .map(([name, value]) => `${name}=${value}`)
              .join("; "),
          }
        : {}),
      ...(data === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    signal: AbortSignal.timeout(30_000),
  });
  for (const header of response.headers.getSetCookie()) {
    const pair = header.split(";")[0] ?? "";
    const at = pair.indexOf("=");
    if (at > 0) cookies.set(pair.slice(0, at), pair.slice(at + 1));
  }
  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: response.status, body: body as T };
}

/**
 * The status, and the server's own `error` sentence when there is one. The WakerFlow and model routes
 * only ever answer in the product's fixed wording (a provider's text never reaches a client), so this
 * prints no provider body; it is capped all the same.
 */
function why(response: { status: number; body: unknown }): string {
  const error = (response.body as { error?: unknown } | null)?.error;
  return typeof error === "string"
    ? `${response.status}: ${error.slice(0, 120)}`
    : String(response.status);
}

function expectStatus(
  response: { status: number; body: unknown },
  expected: number,
  message: string,
) {
  check(
    response.status === expected,
    `${message} (HTTP ${response.status === expected ? expected : why(response)})`,
  );
}

type PlanStep = {
  id: string;
  kind?: string;
  agentId?: string;
  instruction?: string;
};
type Plan = {
  name: string;
  members: { agentId: string }[];
  inputs: {
    key: string;
    required: boolean;
    type?: string;
    default?: string;
    options?: string[];
  }[];
  steps: PlanStep[];
};
type FlowRequest = {
  status: string;
  runId: string | null;
  error: string | null;
  result: { plan: Plan; revision: number | null; applied?: boolean } | null;
};
type RunStep = { id: string; state: string; output?: string; runRef?: string };
type Run = { id: string; status: string; steps: RunStep[] };

async function readRun(flowId: string, runId: string): Promise<Run> {
  const response = await api<{ run: Run }>(
    "GET",
    `/api/wakerflows/${flowId}/runs/${runId}`,
  );
  if (response.status !== 200)
    throw new Error(`GET run answered ${why(response)}`);
  return response.body.run;
}

async function settleRequest(
  flowId: string,
  requestId: string,
  first: FlowRequest,
  timeoutMs: number,
): Promise<FlowRequest> {
  if (first.status !== "pending") return first;
  return until(
    `request ${requestId} to settle`,
    async () => {
      const response = await api<{ request: FlowRequest }>(
        "GET",
        `/api/wakerflows/${flowId}/requests/${requestId}`,
      );
      return response.status === 200 &&
        response.body.request.status !== "pending"
        ? response.body.request
        : null;
    },
    timeoutMs,
    1000,
  );
}

/** A value for every input the plan asks for: its default, its first option, or a short topic. */
function inputsFor(plan: Plan): Record<string, string> {
  const values: Record<string, string> = {};
  for (const input of plan.inputs) {
    values[input.key] =
      input.default ??
      input.options?.[0] ??
      (input.type === "number"
        ? "3"
        : input.type === "boolean"
          ? "true"
          : "城市骑行");
  }
  return values;
}

async function startRun(
  flowId: string,
  revision: number,
  inputs: Record<string, string>,
): Promise<string> {
  const requestId = randomUUID();
  const response = await api<{ request: FlowRequest }>(
    "POST",
    `/api/wakerflows/${flowId}/runs`,
    { requestId, revision, inputs },
  );
  expectStatus(response, 200, "the run request is accepted");
  const request = await settleRequest(
    flowId,
    requestId,
    response.body.request,
    30_000,
  );
  check(request.runId, `the run is registered (request ${request.status})`);
  return request.runId;
}

// ---------------------------------------------------------------------------------------------
// The lifecycle
// ---------------------------------------------------------------------------------------------

let failed = false;
let tenant = "";
let flowId = "";
let plan: Plan | undefined;
let revision = -1;
let run1: Run | undefined;
let run2: Run | undefined;

try {
  await step("server up (real process, real PostgreSQL)", async () => {
    console.log(
      `   mode: ${config.mock ? "LOCAL MOCK provider (aimock)" : "REAL provider"}`,
    );
    await startServer();
  });

  await step("sign up, administrator, Pro plan", async () => {
    const signUp = await api("POST", "/api/auth/sign-up/email", {
      name: "G4 真实模型测试员",
      email: ADMIN_EMAIL,
      password: `pw-${randomUUID()}`,
    });
    expectStatus(signUp, 200, "the password sign-up succeeds");
    const me = await api<{ user?: { id?: string } }>("GET", "/api/me");
    expectStatus(me, 200, "the session cookie authenticates /api/me");
    tenant = me.body.user?.id ?? "";
    check(tenant, "the person has an id (the tenant every row is read as)");
    expectStatus(
      await api("POST", "/api/me/onboarding", { completed: true }),
      200,
      "onboarding marked complete",
    );
    // A password sign-up is never promoted by INITIAL_ADMIN_EMAILS (`auth/roles.ts`): the operator
    // names the administrator from the server's shell, as the lifecycle harness does.
    const grant = Bun.spawnSync(
      ["bun", "scripts/grant-admin.ts", ADMIN_EMAIL],
      {
        cwd: SERVER_DIR,
        env: {
          PATH: serverEnv.PATH,
          HOME: serverEnv.HOME,
          DATABASE_URL: config.databaseUrl,
          ROLE_WRITER_DATABASE_URL: config.roleWriterDatabaseUrl,
        },
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    equal(grant.exitCode, 0, "grant-admin.ts names the administrator");
    expectStatus(
      await api("POST", "/api/quota/plan", { planId: "pro" }),
      200,
      "the administrator moves the workspace to Pro",
    );
  });

  let modelRef = "";
  await step(
    "one model-library row on the provider, two coworkers bound to it",
    async () => {
      const model = await api<{ model: { id: string } }>(
        "POST",
        "/api/models",
        {
          provider: "custom",
          modelName: config.modelName,
          apiKey: config.apiKey,
          baseUrl: providerUrl,
          label: "G4 真实模型",
        },
      );
      expectStatus(model, 201, "the model-library row is created");
      modelRef = model.body.model.id;
      for (const [slot, name, title] of [
        ["lister", "G4 要点员", "列要点"],
        ["summarizer", "G4 总结员", "写总结"],
      ] as const) {
        const fields = {
          name,
          title,
          roleDescription: `${title}。每次只用一句不超过二十字的中文回答。`,
          visibility: "private",
        };
        const agent = await api<{ agent: { id: string } }>(
          "POST",
          "/api/agents",
          fields,
        );
        expectStatus(agent, 201, `coworker ${name} is created`);
        ids[slot] = agent.body.agent.id;
        // The binding is an edit, as on the coworker's settings page (`profile-store.ts` update).
        const bound = await api<{ agent: { modelRef?: string | null } }>(
          "PATCH",
          `/api/agents/${ids[slot]}`,
          { ...fields, modelRef },
        );
        expectStatus(bound, 200, `coworker ${name} is bound to the row`);
        equal(
          bound.body.agent.modelRef === modelRef,
          true,
          `coworker ${name} reads back the binding`,
        );
      }
      console.log(
        `   model row ${modelRef}; coworkers ${ids.lister}, ${ids.summarizer}`,
      );
    },
  );

  await step(
    "generate: one sentence -> the real planner -> a plan",
    async () => {
      const created = await api<{ flow: { id: string; revision: number } }>(
        "POST",
        "/api/wakerflows",
        { idea: IDEA, modelRef },
      );
      expectStatus(created, 201, "a draft Flow is created");
      flowId = created.body.flow.id;
      const requestId = randomUUID();
      const generated = await api<{ request: FlowRequest }>(
        "POST",
        `/api/wakerflows/${flowId}/generate`,
        {
          requestId,
          modelRef,
          idea: IDEA,
          members: [
            { agentId: ids.lister, name: "G4 要点员", role: "列要点" },
            { agentId: ids.summarizer, name: "G4 总结员", role: "写总结" },
          ],
        },
      );
      expectStatus(generated, 200, "the planning request is accepted");
      const request = await settleRequest(
        flowId,
        requestId,
        generated.body.request,
        150_000,
      );
      // `error` is always the product's own sentence, never the provider's.
      equal(
        [request.status, request.error],
        ["completed", null],
        "the planning request completed",
      );
      check(request.result, "the completed request carries a plan");
      plan = request.result.plan;
      const offered = new Set([ids.lister, ids.summarizer]);
      check(
        plan.steps.length >= 2,
        `the real planner's plan has at least two steps (${plan.steps.length})`,
      );
      check(
        plan.steps.every(
          (s) =>
            (s.kind === undefined || s.kind === "worker") &&
            typeof s.agentId === "string" &&
            offered.has(s.agentId) &&
            (s.instruction ?? "").trim().length > 0,
        ),
        "every step is a coworker step with an instruction, run by an offered coworker",
      );
      const flow = await api<{ flow: { status: string; revision: number } }>(
        "GET",
        `/api/wakerflows/${flowId}`,
      );
      equal(
        flow.body.flow.status,
        "draft",
        "generation alone leaves the Flow a draft",
      );
      revision = flow.body.flow.revision;
      console.log(
        `   plan: ${plan.steps.length} steps, ${plan.inputs.length} inputs, ${plan.members.length} members; revision ${revision}`,
      );
    },
  );

  const edited: string[] = [];
  await step("edit the steps' instructions and save", async () => {
    if (!plan) throw new Error("no plan");
    const next: Plan = {
      ...plan,
      steps: plan.steps.map((s) => ({
        ...s,
        instruction: `${s.instruction ?? ""}${BRIEF}`,
      })),
    };
    for (const s of next.steps) edited.push(s.instruction ?? "");
    const saved = await api<{
      flow: { status: string; revision: number; plan: Plan };
    }>("PUT", `/api/wakerflows/${flowId}`, { revision, plan: next });
    expectStatus(saved, 200, "Save is accepted");
    equal(saved.body.flow.status, "ready", "the saved Flow is ready to run");
    equal(
      saved.body.flow.revision,
      revision + 1,
      "Save moved the Flow to the next revision",
    );
    // Compared, never printed: the instructions are the planner's own words.
    check(
      JSON.stringify(saved.body.flow.plan.steps.map((s) => s.instruction)) ===
        JSON.stringify(edited) && edited.every((text) => text.endsWith(BRIEF)),
      `the stored plan carries every edited instruction (${edited.length})`,
    );
    const reread = await api<{ flow: { revision: number; plan: Plan } }>(
      "GET",
      `/api/wakerflows/${flowId}`,
    );
    check(
      reread.body.flow.plan.steps[0]?.instruction === edited[0],
      "a fresh read returns step 1's edited instruction",
    );
    revision = reread.body.flow.revision;
    plan = reread.body.flow.plan;
  });

  await step("run 1 completes with every step's output", async () => {
    if (!plan) throw new Error("no plan");
    const runId = await startRun(flowId, revision, inputsFor(plan));
    run1 = await until(
      "run 1 to finish",
      async () => {
        const run = await readRun(flowId, runId);
        return TERMINAL.has(run.status) ? run : null;
      },
      300_000,
      1000,
    );
    equal(run1.status, "done", "API: run 1 is done (已完成)");
    equal(
      run1.steps.map((s) => s.state),
      run1.steps.map(() => "done"),
      "API: every step of run 1 is done",
    );
    check(
      run1.steps.length === plan.steps.length &&
        run1.steps.every((s) => (s.output ?? "").trim().length > 0),
      "API: every step of run 1 has a non-empty output",
    );
    console.log(
      `   run 1 ${run1.id}: output lengths ${run1.steps.map((s) => (s.output ?? "").length).join(", ")}`,
    );
  });

  await step("run 2 is aborted while a step is running", async () => {
    if (!plan) throw new Error("no plan");
    const runId = await startRun(flowId, revision, inputsFor(plan));
    const inFlight = await until(
      "a step of run 2 to be running",
      async () => {
        const run = await readRun(flowId, runId);
        if (TERMINAL.has(run.status))
          throw new Error(
            `run 2 ended ${run.status} before it could be aborted`,
          );
        const index = run.steps.findIndex((s) => s.state === "running");
        return index >= 0 ? { index } : null;
      },
      120_000,
      100,
    );
    const aborted = await api(
      "POST",
      `/api/wakerflows/${flowId}/runs/${runId}/abort`,
    );
    expectStatus(
      aborted,
      200,
      `the abort is accepted (step ${inFlight.index + 1} was running)`,
    );
    run2 = await until(
      "run 2 to settle",
      async () => {
        const run = await readRun(flowId, runId);
        return TERMINAL.has(run.status) ? run : null;
      },
      60_000,
      500,
    );
    equal(run2.status, "aborted", "API: run 2 is aborted (已停止)");
    const firstOpen = run2.steps.findIndex((s) => s.state !== "done");
    check(
      firstOpen >= 0 && firstOpen < run2.steps.length,
      `API: run 2 stopped before its end (at step ${firstOpen + 1} of ${run2.steps.length})`,
    );
    equal(
      run2.steps.slice(firstOpen).map((s) => s.state),
      run2.steps.slice(firstOpen).map(() => "aborted"),
      "API: the step in flight and every later step read aborted",
    );
    check(
      run2.steps.slice(firstOpen).every((s) => !s.output),
      "API: no aborted step has an output",
    );
    check(
      run2.steps.slice(firstOpen + 1).every((s) => !s.runRef),
      "API: no later step was ever started (none has a turn reference)",
    );
    // A late answer to the stopped step must not land.
    await Bun.sleep(5000);
    const after = await readRun(flowId, runId);
    equal(after.status, "aborted", "API: run 2 stays aborted");
    equal(
      after.steps.map((s) => [s.state, Boolean(s.output)]),
      run2.steps.map((s) => [s.state, Boolean(s.output)]),
      "API: nothing changed on run 2 after the abort settled",
    );
    run2 = after;
    console.log(
      `   run 2 ${run2.id}: ${run2.steps.map((s) => s.state).join(", ")}`,
    );
  });

  await step(
    "model_token_calls, read as the tenant, meter both runs",
    async () => {
      if (!run1 || !run2) throw new Error("no runs");
      const { createDatabase } = await import("../../server/src/db/client");
      const { modelTokenCalls } = await import("../../server/src/db/schema");
      const { runAsTenant } = await import("../../server/src/tenant/context");
      const database = createDatabase(config.databaseUrl, { max: 2 });
      try {
        const finished = [
          ...run1.steps.filter((s) => s.state === "done"),
          ...run2.steps.filter((s) => s.state === "done"),
        ];
        const refs = finished.map((s) => s.runRef ?? "");
        check(
          refs.every((ref) => ref.length > 0),
          `every finished step carries its turn reference (${refs.length})`,
        );
        const run2Started = run2.steps
          .map((s) => s.runRef)
          .filter((ref): ref is string => Boolean(ref));
        // The sink writes when a call settles, without the turn awaiting it: poll briefly.
        const rows = await until(
          "a metered row for every finished step",
          async () => {
            // RLS decides what is visible: only this tenant's rows come back.
            const all = await runAsTenant(tenant, () =>
              database.select().from(modelTokenCalls),
            );
            return refs.every((ref) => all.some((row) => row.runId === ref))
              ? all
              : null;
          },
          30_000,
          1000,
        );
        check(
          rows.every((row) => row.tenantId === tenant),
          `every visible row is this tenant's (${rows.length} rows)`,
        );
        check(
          rows.every((row) => row.modelRef === modelRef),
          "every row was metered against the bound library row",
        );
        for (const [index, ref] of refs.entries()) {
          const mine = rows.filter((row) => row.runId === ref);
          check(
            mine.length > 0 &&
              mine.some(
                (row) =>
                  row.usageStatus === "reported" &&
                  (row.inputTokens ?? 0) > 0 &&
                  (row.outputTokens ?? 0) > 0,
              ),
            `finished step ${index + 1}: ${mine.length} row(s), reported with input and output tokens > 0`,
          );
        }
        const run1Rows = rows.filter((row) =>
          run1?.steps.some((s) => s.runRef === row.runId),
        );
        const run2Rows = rows.filter((row) => run2Started.includes(row.runId));
        check(
          run1Rows.length >= run1.steps.length,
          `run 1 has ${run1Rows.length} metered call(s)`,
        );
        const reported = (
          list: typeof rows,
          key: "inputTokens" | "outputTokens",
        ) => list.reduce((sum, row) => sum + (row[key] ?? 0), 0);
        console.log(
          `   run 1: ${run1Rows.length} rows, input ${reported(run1Rows, "inputTokens")}, output ${reported(run1Rows, "outputTokens")}`,
        );
        console.log(
          `   run 2: ${run2Rows.length} rows (${run2Rows.map((row) => `${row.outcome}/${row.usageStatus}`).join(", ") || "none"})`,
        );
        check(
          rows.every((row) => run1Rows.includes(row) || run2Rows.includes(row)),
          "every metered call belongs to a started step of run 1 or run 2 (planning is not metered)",
        );
      } finally {
        await database.$client.end({ timeout: 5 });
      }
    },
  );

  await step("nothing reached the deployment's own model", async () => {
    equal(deploymentHits, 0, "the deployment model stub was never asked");
    if (config.mock)
      check(
        mockCalls.plan === 1 && mockCalls.step >= 3,
        `the mock provider saw 1 planning call and ${mockCalls.step} step calls`,
      );
  });
} catch (error) {
  failed = true;
  // The message is this harness's own (assertions, timeouts); never a provider's.
  console.error(
    `\nFAIL: ${error instanceof Error ? error.message : String(error)}`,
  );
} finally {
  await stopServer().catch(() => undefined);
  deploymentStub.stop(true);
  await stopMock().catch(() => undefined);
}

const total = ((Date.now() - started) / 1000).toFixed(1);
console.log(
  failed
    ? `\nG4 WAKERFLOW REAL MODEL: FAIL after ${assertions} assertions (${total} s)`
    : `\nG4 WAKERFLOW REAL MODEL: PASS (${assertions} assertions, ${total} s, ${config.mock ? "LOCAL MOCK provider" : "real provider"})`,
);
process.exit(failed ? 1 : 0);
