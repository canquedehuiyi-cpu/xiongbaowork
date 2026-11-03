/**
 * Gate G4: the WakerFlow basic lifecycle, end to end, in a real browser against a real server and
 * PostgreSQL, with the model mocked (aimock). No real provider is ever called and no secret is read.
 *
 * Lifecycle driven through the UI (asserted on screen, and through the API where the screen is thin):
 *
 *   1. sign up a fresh person (the sign-in page's own email/password form);
 *   2. generate: one sentence -> the planning model (aimock) -> an editable plan on screen;
 *   3. edit a step's instruction, and add nothing else;
 *   4. save: the Flow is `ready` at a new revision, with the edited instruction;
 *   5. execute: run 1 starts; step 1 finishes, step 2's model call is held open at the mock;
 *   6. abort while step 2 is at the model: the run reads 已停止 with step 1's output kept (partial
 *      result), step 2/3 已停止, the in-flight model request is cancelled (the socket closes), step 3
 *      never reaches the model, and the held answer released afterwards changes nothing;
 *   7. a second run: step 1 finishes, step 2 is held at the model, and the server is killed (SIGKILL);
 *   8. restart and recover (spec D10 WF-F, `server/src/wakerflows/recovery.ts`): the interrupted run is
 *      closed as FAILED and NOT replayed — step 1 keeps its output, step 2 says it was interrupted and
 *      not replayed, step 3 says it was never started, and the model receives no further step request;
 *   9. a third run after the restart runs to 已完成 with every step's output.
 *
 * Recovery horizon. The server only closes a `running` Flow run whose heartbeat (`updated_at`) is older
 * than ABANDONED_RUN_MS (10 minutes, on the database clock), in a sweep that runs 60 s after start and
 * once per 5-minute bucket fleet-wide (`recovery/abandoned-work.ts`). A CI job cannot wait that out, so
 * after the kill — while no server process exists — this harness moves the stranded run's `updated_at`
 * back past the horizon and removes the sweep's per-bucket lease rows, exactly what the passage of
 * 10 minutes and a new bucket would have done. Nothing else is written behind the product's back; the
 * restarted server's own timer runs the production sweep.
 *
 * Environment (all required unless a default is given):
 *   E2E_DATABASE_URL              the API's role (openbot_app, NOSUPERUSER NOBYPASSRLS)
 *   E2E_ROLE_WRITER_DATABASE_URL  the restricted role writer (migration 0109)
 *   E2E_OWNER_DATABASE_URL        the migration owner; used ONLY for the fresh-database check and the
 *                                 recovery-horizon time shift described above
 *   E2E_APP_DIST_DIR              the built app (`bun run --cwd app build`), served by the server
 *   E2E_CHROME_PATH               a Chrome/Chromium binary (default: /opt/pw-browsers/chromium, then
 *                                 /usr/bin/google-chrome, /usr/bin/chromium)
 *   E2E_ARTIFACTS_DIR             screenshots, trace (on failure) and server logs (default: ./e2e-artifacts)
 *   E2E_SERVER_PORT               default: a free port
 *
 * Usage (from openbot/): bun scripts/e2e/wakerflow-lifecycle.ts
 */

import { randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { LLMock } from "@copilotkit/aimock";
import { SQL, type Subprocess } from "bun";
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Locator,
  type Page,
} from "playwright-core";

// ---------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------

const ROOT = resolve(import.meta.dir, "../..");
const SERVER_DIR = resolve(ROOT, "server");

function need(name: string): string {
  const value = process.env[name]?.trim();
  if (!value)
    throw new Error(`${name} is required (see the header of this file).`);
  return value;
}

const DATABASE_URL = need("E2E_DATABASE_URL");
const ROLE_WRITER_DATABASE_URL = need("E2E_ROLE_WRITER_DATABASE_URL");
const OWNER_DATABASE_URL = need("E2E_OWNER_DATABASE_URL");
const APP_DIST_DIR = resolve(need("E2E_APP_DIST_DIR"));
const ARTIFACTS = resolve(
  process.env.E2E_ARTIFACTS_DIR?.trim() || "e2e-artifacts",
);
const CHROME =
  process.env.E2E_CHROME_PATH?.trim() ||
  [
    "/opt/pw-browsers/chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].find((path) => existsSync(path));
if (!CHROME) throw new Error("No browser found: set E2E_CHROME_PATH.");
if (!existsSync(resolve(APP_DIST_DIR, "index.html")))
  throw new Error(
    `${APP_DIST_DIR}/index.html is missing: build the app first.`,
  );
mkdirSync(ARTIFACTS, { recursive: true });

/** What the product writes on a step closed by restart recovery (`wakerflows/recovery.ts`). */
const FLOW_STEP_INTERRUPTED =
  "The server restarted during this step. It may already have acted; it was not replayed.";
const FLOW_STEP_NOT_STARTED =
  "The server restarted before this step started; the run stopped and this step was not run.";
/** The recovery horizon (`routines/sweep.ts` ABANDONED_RUN_MS) plus a minute of margin. */
const PAST_HORIZON = "11 minutes";

// ---------------------------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------------------------

const started = Date.now();
const timings: { name: string; seconds: number }[] = [];
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

let page: Page | undefined;
let shot = 0;
async function screenshot(name: string) {
  if (!page) return;
  shot += 1;
  await page
    .screenshot({
      path: resolve(ARTIFACTS, `${String(shot).padStart(2, "0")}-${name}.png`),
      fullPage: true,
    })
    .catch(() => undefined);
}

async function step(name: string, body: () => Promise<void>) {
  const at = Date.now();
  console.log(`\n== ${name}`);
  await body();
  const seconds = (Date.now() - at) / 1000;
  timings.push({ name, seconds });
  console.log(`   PASS ${name} (${seconds.toFixed(1)} s)`);
  await screenshot(name.replace(/[^a-z0-9]+/gi, "-").toLowerCase());
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
  let last: unknown;
  for (;;) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline)
      throw new Error(
        `Timed out after ${timeoutMs} ms waiting for ${what}${last ? `: ${String(last)}` : ""}`,
      );
    await Bun.sleep(everyMs);
  }
}

// ---------------------------------------------------------------------------------------------
// The mocked model: aimock, behind a counting proxy that also sees cancelled requests
// ---------------------------------------------------------------------------------------------

type Kind =
  | "plan"
  | "draft"
  | "review-edited"
  | "review-original"
  | "publish"
  | "other";
type Call = {
  kind: Kind;
  phase: string;
  path: string;
  /** The server dropped the request before an answer was sent (abort or process death). */
  cancelled: boolean;
  answered: boolean;
};

const MARK = {
  draft: "E2E-DRAFT",
  review: "E2E-REVIEW",
  reviewEdited: "E2E-REVIEW-EDITED",
  publish: "E2E-PUBLISH",
} as const;

let phase = "setup";
const calls: Call[] = [];
let holdReview = true;
const held: (() => void)[] = [];
const releaseHeld = () => {
  for (const release of held.splice(0)) release();
};

/**
 * The text of the newest user message, whatever shape the provider protocol gave it: Chat
 * Completions `messages` (planning, through the library row) or Responses `input` (coworker turns,
 * through the deployment model).
 */
function lastUserText(body: unknown): string {
  const record = (body ?? {}) as { messages?: unknown; input?: unknown };
  const items = Array.isArray(record.messages)
    ? record.messages
    : Array.isArray(record.input)
      ? record.input
      : typeof record.input === "string"
        ? [{ role: "user", content: record.input }]
        : [];
  const users = (items as { role?: string; content?: unknown }[]).filter(
    (item) => item?.role === "user",
  );
  const content = users.at(-1)?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((part) =>
        typeof part?.text === "string" ? part.text : JSON.stringify(part),
      )
      .join("\n");
  return JSON.stringify(content ?? "");
}

function classify(text: string): Kind {
  if (text.includes("用户的想法：")) return "plan";
  if (text.includes(MARK.publish)) return "publish";
  if (text.includes(MARK.reviewEdited)) return "review-edited";
  if (text.includes(MARK.review)) return "review-original";
  if (text.includes(MARK.draft)) return "draft";
  return "other";
}

const ids = { writer: "", reviewer: "" };
/**
 * The person under test. Listed in INITIAL_ADMIN_EMAILS (sign-in requires a list), but a password
 * sign-up is never promoted by it (`auth/roles.ts`), so the operator script grants the role below.
 */
const ADMIN_EMAIL = "g4-admin@example.test";
const IDEA = "每周把选题写成草稿、复核后整理成终稿";
const ORIGINAL_REVIEW = `${MARK.review} 复核草稿`;
const EDITED_REVIEW = `${MARK.reviewEdited} 逐条复核草稿并标注风险`;

function generatedPlan() {
  return {
    name: "E2E 周报流程",
    description: "起草、复核、定稿",
    members: [
      { agentId: ids.writer, role: "撰稿人" },
      { agentId: ids.reviewer, role: "复核人" },
    ],
    inputs: [{ key: "topic", label: "选题", required: true }],
    steps: [
      {
        id: "draft",
        agentId: ids.writer,
        instruction: `${MARK.draft} 根据选题写草稿`,
        inputKeys: ["topic"],
        outputKey: "draft",
      },
      {
        id: "review",
        agentId: ids.reviewer,
        instruction: ORIGINAL_REVIEW,
        inputKeys: ["draft"],
        outputKey: "review",
      },
      {
        id: "publish",
        agentId: ids.writer,
        instruction: `${MARK.publish} 整理成终稿`,
        inputKeys: ["review"],
        outputKey: "final",
      },
    ],
  };
}

const OUTPUT = {
  draft: "草稿产出：三条要点",
  review: "复核产出：两处风险已标注",
  publish: "终稿产出：可以发布",
  late: "迟到的复核产出：不应出现在任何运行里",
} as const;

const mock = new LLMock({ host: "127.0.0.1", port: 0 });
mock.onMessage(/[\s\S]*/, async (request) => {
  const kind = classify(lastUserText(request));
  switch (kind) {
    case "plan":
      // Models wrap answers in prose; the generator takes the first balanced JSON object.
      return {
        content: `好的，计划如下：\n${JSON.stringify(generatedPlan())}`,
      };
    case "draft":
      return { content: OUTPUT.draft };
    case "review-edited":
      if (holdReview) {
        // Held until the harness releases it (or a minute passes): this is the step in flight.
        await new Promise<void>((done) => {
          held.push(done);
          setTimeout(done, 60_000);
        });
        return { content: OUTPUT.late };
      }
      return { content: OUTPUT.review };
    case "review-original":
      return { content: "未编辑的复核指令被执行了" };
    case "publish":
      return { content: OUTPUT.publish };
    default:
      return { content: "好的。" };
  }
});
const mockUrl = await mock.start();

const proxy = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  // A held model call sends nothing for a while; the proxy must not be the one to hang up.
  idleTimeout: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const body = await request.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(body);
    } catch {}
    const call: Call = {
      kind: classify(lastUserText(parsed)),
      phase,
      path: url.pathname,
      cancelled: false,
      answered: false,
    };
    calls.push(call);
    request.signal.addEventListener("abort", () => {
      if (!call.answered) call.cancelled = true;
    });
    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.delete("content-length");
    try {
      const upstream = await fetch(`${mockUrl}${url.pathname}${url.search}`, {
        method: request.method,
        headers,
        body:
          request.method === "GET" || request.method === "HEAD"
            ? undefined
            : body,
      });
      const answer = await upstream.arrayBuffer();
      if (request.signal.aborted) {
        call.cancelled = true;
        return new Response(null, { status: 499 });
      }
      call.answered = true;
      const out = new Headers(upstream.headers);
      out.delete("content-length");
      out.delete("content-encoding");
      out.delete("transfer-encoding");
      return new Response(answer, { status: upstream.status, headers: out });
    } catch (error) {
      call.cancelled = call.cancelled || request.signal.aborted;
      return new Response(String(error), { status: 502 });
    }
  },
});
const MODEL_BASE_URL = `http://127.0.0.1:${proxy.port}/v1`;

const count = (kind: Kind, inPhase?: string) =>
  calls.filter(
    (call) =>
      call.kind === kind && (inPhase === undefined || call.phase === inPhase),
  ).length;

// ---------------------------------------------------------------------------------------------
// The server (Postgres-backed API that also serves the built app), started and killed by PID
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
  DATABASE_URL,
  ROLE_WRITER_DATABASE_URL,
  // Fresh per run, like the database.
  KEY_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
  BETTER_AUTH_URL: ORIGIN,
  OPENBOT_PUBLIC_URL: ORIGIN,
  INITIAL_ADMIN_EMAILS: ADMIN_EMAIL,
  INTELLIGENCE_MODE: "local",
  TENANT_PACKAGE_DIR: "../examples/qoderwake",
  APP_DIST_DIR,
  // The deployment's model (a coworker with no binding of its own speaks it) is the mock.
  OPENAI_BASE_URL: MODEL_BASE_URL,
  OPENAI_API_KEY: "g4-mock-key-not-a-secret",
  // The mock listens on loopback over plain http; development-only switch (audit defect #6).
  AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS: "true",
  COPILOTKIT_TELEMETRY_DISABLED: "true",
  DO_NOT_TRACK: "1",
};

let server: Subprocess | undefined;
let serverStarts = 0;

async function startServer() {
  serverStarts += 1;
  const log = resolve(ARTIFACTS, `server-${serverStarts}.log`);
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
        throw new Error(`server exited ${server?.exitCode}; see ${log}`);
      const response = await fetch(`${ORIGIN}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      return response.status === 200;
    },
    90_000,
    500,
  );
  console.log(`   server pid ${pid} healthy on ${ORIGIN} (log ${log})`);
}

async function killServer() {
  const running = server;
  if (!running) return;
  running.kill("SIGKILL");
  await running.exited;
  console.log(
    `   server pid ${running.pid} killed (SIGKILL), exit ${running.signalCode ?? running.exitCode}`,
  );
  server = undefined;
}

// ---------------------------------------------------------------------------------------------
// The browser and the API (the API through the browser's own session cookie)
// ---------------------------------------------------------------------------------------------

let browser: Browser | undefined;
let context: BrowserContext | undefined;

async function api<T = Record<string, unknown>>(
  method: "GET" | "POST" | "PUT",
  path: string,
  data?: unknown,
): Promise<{ status: number; body: T }> {
  if (!context) throw new Error("no browser context");
  const response = await context.request.fetch(`${ORIGIN}${path}`, {
    method,
    headers: {
      origin: ORIGIN,
      ...(data === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(data === undefined ? {} : { data: JSON.stringify(data) }),
    failOnStatusCode: false,
    timeout: 15_000,
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: response.status(), body: body as T };
}

type RunStep = {
  id: string;
  state: string;
  output?: string;
  error?: string;
  instruction: string;
};
type Run = { id: string; status: string; steps: RunStep[] };

async function readRun(flowId: string, runId: string): Promise<Run> {
  const { status, body } = await api<{ run: Run }>(
    "GET",
    `/api/wakerflows/${flowId}/runs/${runId}`,
  );
  if (status !== 200)
    throw new Error(`GET run answered ${status}: ${JSON.stringify(body)}`);
  return body.run;
}

type Card = { id: string; status: string; parentTaskId: string | null };

/** The board cards of one run: its parent card and every step card opened under it. */
async function cardsOf(
  flowId: string,
  runId: string,
): Promise<{ parent: string; cards: Card[] }> {
  const runs = await api<{
    runs: { id: string; parentTaskId: string | null }[];
  }>("GET", `/api/wakerflows/${flowId}/runs`);
  const parent =
    runs.body.runs.find((run) => run.id === runId)?.parentTaskId ?? "";
  const board = await api<{ tasks: Card[] }>("GET", "/api/tasks");
  return {
    parent,
    cards: board.body.tasks.filter(
      (card) => card.id === parent || card.parentTaskId === parent,
    ),
  };
}

/** The detail of one run as the screen shows it: status, and each step's state/output/error text. */
function runDetail(p: Page) {
  return p.locator("[data-testid=run-detail-status]").locator("xpath=../..");
}
async function stepItem(p: Page, index: number): Promise<Locator> {
  return runDetail(p).locator("ol > li").nth(index);
}
async function expectStep(
  p: Page,
  index: number,
  state: string,
  text?: string,
) {
  const item = await stepItem(p, index);
  await item.getByText(state, { exact: true }).waitFor({ timeout: 20_000 });
  check(true, `step ${index + 1} on screen reads ${state}`);
  if (text) {
    await item.getByText(text).first().waitFor({ timeout: 10_000 });
    check(true, `step ${index + 1} on screen shows "${text.slice(0, 40)}"`);
  }
}

async function openRun(p: Page, runId: string) {
  const status = p.locator(`[data-run-status="${runId}"]`);
  await status.waitFor({ timeout: 20_000 });
  const toggle = status.locator("xpath=ancestor::button[1]");
  if ((await toggle.getAttribute("aria-expanded")) !== "true")
    await toggle.click();
}

// ---------------------------------------------------------------------------------------------
// The lifecycle
// ---------------------------------------------------------------------------------------------

const owner = new SQL(OWNER_DATABASE_URL);
let failed = false;

try {
  await step("fresh database, mock model, server and browser up", async () => {
    const [{ users }] = await owner`select count(*)::int as users from users`;
    equal(users, 0, "the database is fresh (no person has signed up)");
    await startServer();
    browser = await chromium.launch({
      executablePath: CHROME,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    context = await browser.newContext({
      viewport: { width: 1280, height: 1000 },
      locale: "zh-CN",
    });
    await context.tracing.start({ screenshots: true, snapshots: true });
    page = await context.newPage();
    page.setDefaultTimeout(20_000);
    console.log(
      `   browser ${CHROME}, version ${browser.version()}; model mock ${mockUrl} via ${MODEL_BASE_URL}`,
    );
  });
  const p = page as Page;

  await step("sign up through the sign-in page", async () => {
    await p.goto(`${ORIGIN}/sign`);
    await p.getByRole("button", { name: "注册", exact: true }).click();
    await p.getByPlaceholder("你的名字").fill("G4 测试员");
    await p.getByPlaceholder("you@example.com").fill(ADMIN_EMAIL);
    await p.getByPlaceholder("密码").fill(`pw-${randomUUID()}`);
    await p.getByRole("button", { name: "创建我的账户" }).click();
    await p.waitForURL((url) => !url.pathname.startsWith("/sign"), {
      timeout: 30_000,
    });
    const me = await api<{ user?: { id?: string } }>("GET", "/api/me");
    equal(me.status, 200, "the session cookie authenticates /api/me");
    // First-run onboarding is its own screen and not under test here.
    equal(
      (await api("POST", "/api/me/onboarding", { completed: true })).status,
      200,
      "onboarding marked complete",
    );
  });

  await step(
    "Pro plan, the mocked model and two coworkers (API setup)",
    async () => {
      // Free has no models of one's own (`quota/limits.ts`), and planning needs one. With no payment
      // provider, the documented path is: the operator names an administrator from the server's shell
      // (`server/scripts/grant-admin.ts`), and the administrator switches the plan by hand.
      const grant = Bun.spawnSync(
        ["bun", "scripts/grant-admin.ts", ADMIN_EMAIL],
        {
          cwd: SERVER_DIR,
          env: {
            PATH: serverEnv.PATH,
            HOME: serverEnv.HOME,
            DATABASE_URL,
            ROLE_WRITER_DATABASE_URL,
          },
        },
      );
      equal(
        grant.exitCode,
        0,
        `grant-admin.ts names the administrator (${grant.stderr.toString().trim().slice(0, 200)})`,
      );
      const plan = await api<{ changed?: boolean }>("POST", "/api/quota/plan", {
        planId: "pro",
      });
      equal(plan.status, 200, "the administrator moves the workspace to Pro");
      const model = await api<{ model: { id: string } }>(
        "POST",
        "/api/models",
        {
          provider: "openai",
          modelName: "g4-mock-planner",
          apiKey: "g4-mock-key-not-a-secret",
          baseUrl: MODEL_BASE_URL,
          label: "G4 模拟模型",
        },
      );
      equal(
        model.status,
        201,
        "model library row pointing at the mock is created",
      );
      for (const [slot, name, title] of [
        ["writer", "G4 撰稿人", "撰稿"],
        ["reviewer", "G4 复核人", "复核"],
      ] as const) {
        const agent = await api<{ agent: { id: string } }>(
          "POST",
          "/api/agents",
          {
            name,
            title,
            roleDescription: `${title}，只用于 G4 端到端测试。`,
            visibility: "private",
          },
        );
        equal(agent.status, 201, `coworker ${name} is created`);
        ids[slot] = agent.body.agent.id;
      }
    },
  );

  let flowId = "";
  let draftRevision = -1;
  await step("generate: natural language -> editable plan", async () => {
    phase = "generate";
    await p.goto(`${ORIGIN}/wakerflows/new`);
    await p.getByLabel("描述你想要的流程").fill(IDEA);
    await p.getByLabel("规划模型").selectOption({ label: "G4 模拟模型" });
    await p.getByLabel("G4 撰稿人").check();
    await p.getByLabel("G4 复核人").check();
    await p.getByRole("button", { name: "生成计划" }).click();
    await p
      .getByText("计划已生成，可以在下方修改后保存。")
      .waitFor({ timeout: 30_000 });
    check(true, "the screen says the plan was generated");
    equal(count("plan"), 1, "exactly one planning call reached the model");
    equal(
      await p.getByLabel("流程名称").inputValue(),
      "E2E 周报流程",
      "the plan's name is in the editor",
    );
    equal(
      await p.getByLabel("第 2 步要做什么").inputValue(),
      ORIGINAL_REVIEW,
      "step 2 holds the generated instruction",
    );
    equal(
      await p.getByLabel("第 3 步的输出名称").inputValue(),
      "final",
      "step 3's output name is editable",
    );
    const listed = await api<{
      flows: { id: string; status: string; revision: number }[];
    }>("GET", "/api/wakerflows");
    equal(listed.body.flows.length, 1, "one Flow exists");
    flowId = listed.body.flows[0]?.id ?? "";
    draftRevision = listed.body.flows[0]?.revision ?? -1;
    equal(
      listed.body.flows[0]?.status,
      "draft",
      "generation alone leaves the Flow a draft",
    );
  });

  await step("edit a step and save", async () => {
    await p.getByLabel("第 2 步要做什么").fill(EDITED_REVIEW);
    await p.getByRole("button", { name: "保存计划" }).click();
    await p.getByText("已保存。").waitFor();
    check(true, "the screen says 已保存。");
    const flow = await api<{
      flow: {
        status: string;
        revision: number;
        plan: { steps: { instruction: string }[] };
      };
    }>("GET", `/api/wakerflows/${flowId}`);
    equal(flow.body.flow.status, "ready", "the saved Flow is ready to run");
    equal(
      flow.body.flow.revision,
      draftRevision + 1,
      "Save moved the Flow to the next revision",
    );
    equal(
      flow.body.flow.plan.steps[1]?.instruction,
      EDITED_REVIEW,
      "the stored plan carries the edited instruction",
    );
    equal(
      flow.body.flow.plan.steps.length,
      3,
      "the stored plan has the three generated steps, nothing added",
    );
  });

  let run1 = "";
  await step("execute run 1 (step 2 held at the model)", async () => {
    phase = "run1";
    await p.goto(`${ORIGIN}/wakerflows/${flowId}`);
    await p.getByText("已保存，可以运行。").waitFor();
    await p.getByText(EDITED_REVIEW).first().waitFor();
    check(true, "the detail page shows the saved, edited plan");
    await p.getByLabel("选题（必填）").fill("第一次运行的选题");
    await p.getByRole("button", { name: "运行", exact: true }).click();
    await p.locator("[data-testid=run-detail-status]").waitFor();
    const runs = await api<{ runs: { id: string }[] }>(
      "GET",
      `/api/wakerflows/${flowId}/runs`,
    );
    equal(runs.body.runs.length, 1, "one run is registered");
    run1 = runs.body.runs[0]?.id ?? "";
    await until(
      "step 2 of run 1 to reach the model",
      () => count("review-edited", "run1") === 1,
      60_000,
    );
    equal(count("draft", "run1"), 1, "step 1 reached the model once");
    equal(
      count("review-original", "run1"),
      0,
      "the unedited instruction was never executed",
    );
    await expectStep(p, 0, "已完成", OUTPUT.draft);
    await expectStep(p, 1, "进行中");
    equal(
      (await readRun(flowId, run1)).status,
      "running",
      "API: run 1 is running",
    );
  });

  await step("abort run 1 while step 2 is at the model", async () => {
    await p.getByRole("button", { name: "停止" }).click();
    await p
      .locator("[data-testid=run-detail-status]")
      .getByText("已停止", { exact: true })
      .waitFor();
    check(true, "the run reads 已停止 on screen");
    await expectStep(p, 0, "已完成", OUTPUT.draft);
    await expectStep(p, 1, "已停止");
    await expectStep(p, 2, "已停止");
    const run = await readRun(flowId, run1);
    equal(run.status, "aborted", "API: run 1 is aborted");
    equal(
      run.steps.map((s) => s.state),
      ["done", "aborted", "aborted"],
      "API: step states after abort",
    );
    equal(
      run.steps[0]?.output,
      OUTPUT.draft,
      "API: step 1's output is kept (partial result)",
    );
    // The pipeline's heartbeat (500 ms) sees the abort and cancels the turn's model request.
    await until(
      "the held model request of run 1 to be cancelled by the server",
      () =>
        calls.some(
          (call) =>
            call.phase === "run1" &&
            call.kind === "review-edited" &&
            call.cancelled,
        ),
      15_000,
    );
    check(
      true,
      "the in-flight model request for step 2 was cancelled (the turn stopped, not just the record)",
    );
    // A late answer to the stopped step must not land.
    releaseHeld();
    await Bun.sleep(3000);
    const after = await readRun(flowId, run1);
    equal(
      after.status,
      "aborted",
      "API: run 1 stays aborted after the held answer is released",
    );
    check(
      !after.steps[1]?.output,
      "API: step 2 has no output from the late answer",
    );
    equal(count("publish"), 0, "step 3 never reached the model");
    const board = await cardsOf(flowId, run1);
    check(board.parent, "run 1 has a parent card on the task board");
    equal(
      board.cards.filter(
        (card) => card.status === "running" || card.status === "needs_action",
      ).length,
      0,
      "no card of run 1 is left in progress on the board",
    );
    equal(
      board.cards.find((card) => card.id === board.parent)?.status,
      "failed",
      "run 1's parent card is closed as failed",
    );
  });

  let run2 = "";
  await step("execute run 2 and kill the server mid-step", async () => {
    phase = "run2";
    await p.getByLabel("选题（必填）").fill("第二次运行的选题");
    await p.getByRole("button", { name: "运行", exact: true }).click();
    run2 = await until("run 2 to be registered", async () => {
      const runs = await api<{ runs: { id: string }[] }>(
        "GET",
        `/api/wakerflows/${flowId}/runs`,
      );
      return runs.body.runs.find((run) => run.id !== run1)?.id;
    });
    await until(
      "step 2 of run 2 to reach the model",
      () => count("review-edited", "run2") === 1,
      60_000,
    );
    await expectStep(p, 0, "已完成", OUTPUT.draft);
    await expectStep(p, 1, "进行中");
    await killServer();
    phase = "down";
    const down = await fetch(`${ORIGIN}/health`).then(
      () => "answered",
      () => "refused",
    );
    equal(down, "refused", "nothing answers on the server's port");
    const [row] =
      await owner`select status, advance_owner is not null as owned from group_task_runs where id = ${run2}`;
    equal(row?.status, "running", "DB: the killed run is stranded at running");
    check(
      calls.some(
        (call) =>
          call.phase === "run2" &&
          call.kind === "review-edited" &&
          call.cancelled,
      ),
      "step 2's model request died with the process (no answer was delivered)",
    );
  });

  await step(
    "restart and recover: the interrupted run is marked failed, not replayed",
    async () => {
      // Stand-in for ten minutes and a new sweep bucket passing while the server is down (see header).
      const shifted = await owner`
      update group_task_runs set updated_at = now() - ${PAST_HORIZON}::interval
      where id = ${run2} and status = 'running' returning id`;
      equal(
        shifted.length,
        1,
        "the stranded run's heartbeat is moved past the recovery horizon",
      );
      await owner`delete from work_items where kind = 'recovery.abandoned'`;
      phase = "recovery";
      holdReview = false;
      await startServer();
      const recovered = await until(
        "the restart sweep to close run 2 (it runs 60 s after start)",
        async () => {
          const run = await readRun(flowId, run2);
          return run.status === "running" ? null : run;
        },
        120_000,
        1000,
      );
      equal(
        recovered.status,
        "failed",
        "API: run 2 is failed after the restart",
      );
      equal(
        recovered.steps.map((s) => s.state),
        ["done", "failed", "failed"],
        "API: step states after recovery",
      );
      equal(
        recovered.steps[0]?.output,
        OUTPUT.draft,
        "API: step 1's output survives the restart",
      );
      equal(
        recovered.steps[1]?.error,
        FLOW_STEP_INTERRUPTED,
        "API: step 2 says it was interrupted and not replayed",
      );
      equal(
        recovered.steps[2]?.error,
        FLOW_STEP_NOT_STARTED,
        "API: step 3 says it never started",
      );
      equal(
        calls
          .filter((call) => call.phase === "recovery")
          .map((call) => call.kind),
        [],
        "no model request at all after the restart: nothing was replayed",
      );
      equal(
        (await readRun(flowId, run1)).status,
        "aborted",
        "API: run 1 is still aborted",
      );
      const board = await cardsOf(flowId, run2);
      equal(
        board.cards.filter(
          (card) => card.status === "running" || card.status === "needs_action",
        ).length,
        0,
        "no card of run 2 is left in progress on the board",
      );
      equal(
        board.cards.find((card) => card.id === board.parent)?.status,
        "failed",
        "run 2's parent card is closed as failed",
      );

      await p.reload();
      await p.getByText("已保存，可以运行。").waitFor({ timeout: 30_000 });
      await p
        .locator(`[data-run-status="${run2}"]`)
        .getByText("失败", { exact: true })
        .waitFor();
      await p
        .locator(`[data-run-status="${run1}"]`)
        .getByText("已停止", { exact: true })
        .waitFor();
      check(true, "the run list reads 失败 for run 2 and 已停止 for run 1");
      await openRun(p, run2);
      await expectStep(p, 0, "已完成", OUTPUT.draft);
      await expectStep(p, 1, "失败", FLOW_STEP_INTERRUPTED);
      await expectStep(p, 2, "失败", FLOW_STEP_NOT_STARTED);
      await screenshot("run-2-recovered");
      await openRun(p, run1);
      await expectStep(p, 0, "已完成", OUTPUT.draft);
      await expectStep(p, 1, "已停止");
    },
  );

  await step(
    "run 3 after the restart completes with every output",
    async () => {
      phase = "run3";
      await p.getByLabel("选题（必填）").fill("重启之后的选题");
      await p.getByRole("button", { name: "运行", exact: true }).click();
      const run3 = await until("run 3 to be registered", async () => {
        const runs = await api<{ runs: { id: string }[] }>(
          "GET",
          `/api/wakerflows/${flowId}/runs`,
        );
        return runs.body.runs.find((run) => run.id !== run1 && run.id !== run2)
          ?.id;
      });
      await p
        .locator("[data-testid=run-detail-status]")
        .getByText("已完成", { exact: true })
        .waitFor({ timeout: 60_000 });
      check(true, "run 3 reads 已完成 on screen");
      await expectStep(p, 0, "已完成", OUTPUT.draft);
      await expectStep(p, 1, "已完成", OUTPUT.review);
      await expectStep(p, 2, "已完成", OUTPUT.publish);
      const run = await readRun(flowId, run3);
      equal(run.status, "done", "API: run 3 is done");
      equal(
        run.steps.map((s) => s.output),
        [OUTPUT.draft, OUTPUT.review, OUTPUT.publish],
        "API: run 3 carries each step's output",
      );
      equal(
        calls
          .filter((call) => call.phase === "run3")
          .map((call) => call.kind)
          .filter((kind) => kind !== "other"),
        ["draft", "review-edited", "publish"],
        "run 3 asked the model for each step once, in order",
      );
    },
  );

  equal(
    calls.map((call) => `${call.phase}:${call.kind}`),
    [
      "generate:plan",
      "run1:draft",
      "run1:review-edited",
      "run2:draft",
      "run2:review-edited",
      "run3:draft",
      "run3:review-edited",
      "run3:publish",
    ],
    "the whole lifecycle made exactly these model requests, all to the mock",
  );
} catch (error) {
  failed = true;
  console.error(
    `\nFAIL: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
  await screenshot("failure");
  if (context)
    await context.tracing
      .stop({ path: resolve(ARTIFACTS, "trace.zip") })
      .catch(() => undefined);
} finally {
  writeFileSync(
    resolve(ARTIFACTS, "model-calls.json"),
    `${JSON.stringify(calls, null, 2)}\n`,
  );
  if (context && !failed) await context.tracing.stop().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  await killServer().catch(() => undefined);
  releaseHeld();
  proxy.stop(true);
  await mock.stop().catch(() => undefined);
  await owner.close().catch(() => undefined);
}

const total = (Date.now() - started) / 1000;
console.log("\nTimings:");
for (const timing of timings)
  console.log(`  ${timing.seconds.toFixed(1).padStart(6)} s  ${timing.name}`);
console.log(`  ${total.toFixed(1).padStart(6)} s  total`);
console.log(
  failed
    ? `\nG4 WAKERFLOW LIFECYCLE: FAIL after ${assertions} assertions (artifacts in ${ARTIFACTS})`
    : `\nG4 WAKERFLOW LIFECYCLE: PASS (${assertions} assertions, ${calls.length} model requests, all mocked)`,
);
process.exit(failed ? 1 : 0);
