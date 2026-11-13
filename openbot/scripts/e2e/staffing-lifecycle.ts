/**
 * Gate G6: hiring and group-making by conversation (「对话招员工 / 组群聊」), end to end, in a real
 * browser against a real server and PostgreSQL, with the model mocked (aimock). No real provider is
 * ever called and no secret is read. Same shape as G4 (`wakerflow-lifecycle.ts`).
 *
 * Driven through the UI (asserted on screen, and through the API where the screen is thin):
 *
 *   1. sign up a fresh person; the server's own sign-up gives their 小管家 (`avatar-<id>`) the
 *      「招聘与组群」 tools by default (`staffing/default-grant.ts`);
 *   2. in a conversation with 小管家, say 「帮我招一个小红书运营」: the mocked model calls
 *      `mcp__staffing__propose_employee`, the tool only drafts, and an editable card appears;
 *   3. change the name on the card and press 确认创建: `GET /api/agents` lists the new employee under
 *      the edited name (never the drafted one), and the card turns into its step-by-step result;
 *   4. say it is confirmed: the model reads `mcp__staffing__proposal_status` (which answers 已执行完)
 *      and 小管家's next sentence appears in the conversation;
 *   5. say 「把 A 和 B 拉个群」: the model calls `mcp__staffing__propose_group` and a group card appears;
 *   6. a second account opens the same conversation and the same proposal: no card, no button, and
 *      the API refuses it (each password sign-up is its own workspace, so the row is not even visible
 *      to them; the one-line summary for a same-workspace member is covered by the app's card tests);
 *   7. back as the person who asked, press 确认建群: `GET /api/groups/:id` has the group with the
 *      employees in the drafted order `[A, B]`.
 *
 * The mocked model offers a tool call only when the request offers that tool, so a model call that
 * is not 小管家's turn (a conversation title, say) gets plain text and never runs anything.
 *
 * Environment (all required unless a default is given):
 *   E2E_DATABASE_URL              the API's role (openbot_app, NOSUPERUSER NOBYPASSRLS)
 *   E2E_ROLE_WRITER_DATABASE_URL  the restricted role writer (migration 0109)
 *   E2E_OWNER_DATABASE_URL        the migration owner; used ONLY for the fresh-database check
 *   E2E_APP_DIST_DIR              the built app (`bun run --cwd app build`), served by the server
 *   E2E_CHROME_PATH               a Chrome/Chromium binary (default: /opt/pw-browsers/chromium, then
 *                                 /usr/bin/google-chrome, /usr/bin/chromium)
 *   E2E_ARTIFACTS_DIR             screenshots, trace (on failure) and the server log
 *                                 (default: ./e2e-artifacts)
 *   E2E_SERVER_PORT               default: a free port
 *
 * Usage (from openbot/): bun scripts/e2e/staffing-lifecycle.ts
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
import { STAFFING_PROPOSAL_MARKER } from "../../shared/staffing-proposal";

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
async function screenshot(name: string, on: Page | undefined = page) {
  if (!on) return;
  shot += 1;
  await on
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
// The mocked model (aimock)
// ---------------------------------------------------------------------------------------------

/** What the person types, and what the mocked 小管家 answers. */
const SAY = {
  hire: "帮我招一个小红书运营",
  confirmed: "我在卡片上确认了，现在怎么样了？",
  group: (a: string, b: string) => `把 ${a} 和 ${b} 拉个群`,
} as const;
const ANSWER = {
  /** Right under the employee card: why it was drafted this way (spec §7). */
  employeeDrafted: "E2E-拟好了：我按小红书运营的日常拟了这位员工，你看看卡片。",
  /** After proposal_status answers 已执行完: the next sentence the brief asks to see. */
  employeeDone: "E2E-接着说：新员工已经建好了，可以在群里一起干活了。",
  groupDrafted: "E2E-拟好了：群里先由文案起稿，再由运营发布。",
  plain: "好的。",
} as const;

const DRAFT = {
  name: "小红书运营",
  edited: "小红书运营·小红",
  title: "内容运营",
  roleDescription:
    "负责小红书账号的日常运营：每周规划选题、写笔记初稿、跟进评论区的提问，并整理每周数据。",
  group: "小红书内容组",
} as const;

type ModelCall = {
  /** Which scripted answer was given. */
  kind:
    | "propose_employee"
    | "employee_drafted"
    | "proposal_status"
    | "employee_done"
    | "propose_group"
    | "group_drafted"
    | "plain";
  offeredStaffing: boolean;
};
const calls: ModelCall[] = [];
/** What `proposal_status` answered, as the model received it. */
const statusAnswers: string[] = [];
/** Filled in once the two employees exist: who the drafted group puts first and second. */
const members = { a: "", b: "", aName: "", bName: "" };

type Message = {
  role?: string;
  content?: unknown;
  tool_calls?: { function?: { name?: string } }[];
};

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((part) =>
        typeof part?.text === "string" ? part.text : JSON.stringify(part),
      )
      .join("\n");
  return JSON.stringify(content ?? "");
}

/**
 * One turn of the mocked model. aimock hands the request over in Chat Completions shape whatever
 * protocol the server spoke, so tool results are `role: "tool"` messages after the person's last one.
 */
function answer(request: unknown) {
  const body = (request ?? {}) as {
    messages?: Message[];
    tools?: { name?: string; function?: { name?: string } }[];
  };
  const messages = body.messages ?? [];
  const offered = new Set(
    (body.tools ?? []).map((tool) => tool.function?.name ?? tool.name ?? ""),
  );
  let lastUser = -1;
  for (const [index, message] of messages.entries())
    if (message.role === "user") lastUser = index;
  const said = lastUser >= 0 ? textOf(messages[lastUser]?.content) : "";
  const results = messages
    .slice(lastUser + 1)
    .filter((message) => message.role === "tool")
    .map((message) => textOf(message.content));
  const offers = (tool: string) => offered.has(`mcp__staffing__${tool}`);
  const record = (kind: ModelCall["kind"]) =>
    calls.push({ kind, offeredStaffing: offers("propose_employee") });

  if (said.includes("招") && offers("propose_employee")) {
    if (results.length === 0) {
      record("propose_employee");
      return {
        toolCalls: [
          {
            name: "mcp__staffing__propose_employee",
            arguments: JSON.stringify({
              name: DRAFT.name,
              title: DRAFT.title,
              roleDescription: DRAFT.roleDescription,
              persona: { tone: "活泼、亲切，像朋友聊天" },
            }),
          },
        ],
      };
    }
    record("employee_drafted");
    return { content: ANSWER.employeeDrafted };
  }
  if (said.includes("确认了") && offers("proposal_status")) {
    if (results.length === 0) {
      /*
       * The proposal this conversation drafted: its id is in the card marker of the tool's answer,
       * which reaches the model JSON-encoded inside the outside-content envelope (quotes escaped).
       */
      const drafted = messages
        .filter((message) => message.role === "tool")
        .map((message) => textOf(message.content))
        .filter((text) => text.includes(STAFFING_PROPOSAL_MARKER))
        .at(-1);
      const proposalId =
        /proposalId\W{0,6}([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})/.exec(
          drafted ?? "",
        )?.[1] ?? "";
      record("proposal_status");
      return {
        toolCalls: [
          {
            name: "mcp__staffing__proposal_status",
            arguments: JSON.stringify({ proposalId }),
          },
        ],
      };
    }
    statusAnswers.push(results.join("\n"));
    record("employee_done");
    return { content: ANSWER.employeeDone };
  }
  if (said.includes("拉个群") && offers("propose_group")) {
    if (results.length === 0) {
      record("propose_group");
      return {
        toolCalls: [
          {
            name: "mcp__staffing__propose_group",
            arguments: JSON.stringify({
              name: DRAFT.group,
              members: [members.a, members.b],
            }),
          },
        ],
      };
    }
    record("group_drafted");
    return { content: ANSWER.groupDrafted };
  }
  record("plain");
  return { content: ANSWER.plain };
}

const mock = new LLMock({ host: "127.0.0.1", port: 0 });
mock.onMessage(/[\s\S]*/, async (request) => answer(request));
const mockUrl = await mock.start();
const MODEL_BASE_URL = `${mockUrl}/v1`;

const count = (kind: ModelCall["kind"]) =>
  calls.filter((call) => call.kind === kind).length;

// ---------------------------------------------------------------------------------------------
// The server (Postgres-backed API that also serves the built app)
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

/** Listed in INITIAL_ADMIN_EMAILS only so sign-in has a list; the role is granted below. */
const ADMIN_EMAIL = "g6-admin@example.test";
const OTHER_EMAIL = "g6-other@example.test";
/** What a conversation the signed-in account is not in renders as. */
const UNREADABLE_CONVERSATION = "读不到这段会话。";

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
  TENANT_PACKAGE_DIR: "../examples/xiongbao",
  APP_DIST_DIR,
  // The deployment's model (a coworker with no binding of its own speaks it) is the mock.
  OPENAI_BASE_URL: MODEL_BASE_URL,
  OPENAI_API_KEY: "g6-mock-key-not-a-secret",
  // The mock listens on loopback over plain http; development-only switch (audit defect #6).
  AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS: "true",
  COPILOTKIT_TELEMETRY_DISABLED: "true",
  DO_NOT_TRACK: "1",
};

let server: Subprocess | undefined;

async function startServer() {
  const log = resolve(ARTIFACTS, "server-1.log");
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

async function stopServer() {
  const running = server;
  if (!running) return;
  running.kill("SIGKILL");
  await running.exited;
  server = undefined;
}

// ---------------------------------------------------------------------------------------------
// The browser and the API (the API through each browser context's own session cookie)
// ---------------------------------------------------------------------------------------------

let browser: Browser | undefined;
let context: BrowserContext | undefined;
let otherContext: BrowserContext | undefined;

async function api<T = Record<string, unknown>>(
  method: "GET" | "POST" | "PUT",
  path: string,
  data?: unknown,
  as: BrowserContext | undefined = context,
): Promise<{ status: number; body: T }> {
  if (!as) throw new Error("no browser context");
  const response = await as.request.fetch(`${ORIGIN}${path}`, {
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

/** The sign-in page's own email/password form; onboarding is its own screen and not under test. */
async function signUp(
  p: Page,
  as: BrowserContext,
  name: string,
  email: string,
) {
  await p.goto(`${ORIGIN}/sign`);
  await p.getByRole("button", { name: "注册", exact: true }).click();
  await p.getByPlaceholder("你的名字").fill(name);
  await p.getByPlaceholder("you@example.com").fill(email);
  await p.getByPlaceholder("密码").fill(`pw-${randomUUID()}`);
  await p.getByRole("button", { name: "创建我的账户" }).click();
  await p.waitForURL((url) => !url.pathname.startsWith("/sign"), {
    timeout: 30_000,
  });
  const me = await api<{ user?: { id?: string } }>(
    "GET",
    "/api/me",
    undefined,
    as,
  );
  equal(me.status, 200, `${name}: the session cookie authenticates /api/me`);
  equal(
    (await api("POST", "/api/me/onboarding", { completed: true }, as)).status,
    200,
    `${name}: onboarding marked complete`,
  );
  return me.body.user?.id ?? "";
}

type AgentRow = { id: string; name: string };
async function agentsOf(as: BrowserContext | undefined = context) {
  const listed = await api<{ agents: AgentRow[] }>(
    "GET",
    "/api/agents",
    undefined,
    as,
  );
  if (listed.status !== 200)
    throw new Error(`GET /api/agents answered ${listed.status}`);
  return listed.body.agents;
}

type ResultItem = { step: string; outcome: string; target?: string };
type ProposalView = {
  proposal?: { id: string; status: string; result?: ResultItem[] | null };
};
async function proposal(id: string, as: BrowserContext | undefined = context) {
  return api<ProposalView>("GET", `/api/proposals/${id}`, undefined, as);
}

/** The proposal card in the conversation, found by its proposal's id. */
function card(p: Page, proposalId: string): Locator {
  return p.locator(`[data-staffing-proposal="${proposalId}"]`).first();
}

/** The newest proposal card on screen: waits for it, then answers its id. */
async function newestCard(p: Page, known: string[]): Promise<string> {
  return until(
    "a new proposal card in the conversation",
    async () => {
      const ids = await p
        .locator("[data-staffing-proposal]")
        .evaluateAll((nodes) =>
          nodes.map(
            (node) => node.getAttribute("data-staffing-proposal") ?? "",
          ),
        );
      return ids.find((id) => id && !known.includes(id));
    },
    60_000,
  );
}

async function send(p: Page, text: string) {
  const box = p.getByRole("textbox", { name: "消息" }).last();
  await box.fill(text);
  await p.getByRole("button", { name: "发送消息" }).last().click();
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
      `   browser ${CHROME}, version ${browser.version()}; model mock ${MODEL_BASE_URL}`,
    );
  });
  const p = page as Page;

  let me = "";
  await step("sign up; the account comes with its 小管家", async () => {
    me = await signUp(p, context as BrowserContext, "G6 测试员", ADMIN_EMAIL);
    check(me, "the person has an id");
    const butler = (await agentsOf()).find(
      (agent) => agent.id === `avatar-${me}`,
    );
    check(butler, "the person's 小管家 (avatar) is among their employees");
  });

  await step("Pro plan and one existing employee (API setup)", async () => {
    // Free allows two employees; this run makes two and a 小管家 already exists. With no payment
    // provider, the documented path is: the operator names an administrator from the server's shell
    // (`server/scripts/grant-admin.ts`), and the administrator switches the plan by hand (as G4).
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
    const plan = await api("POST", "/api/quota/plan", { planId: "pro" });
    equal(plan.status, 200, "the administrator moves the workspace to Pro");
    const writer = await api<{ agent: { id: string; name: string } }>(
      "POST",
      "/api/agents",
      {
        name: "G6 文案",
        title: "文案",
        roleDescription: "写小红书笔记的文案，只用于 G6 端到端测试。",
        visibility: "private",
      },
    );
    equal(writer.status, 201, "the existing employee G6 文案 is created");
    members.b = writer.body.agent.id;
    members.bName = "G6 文案";
  });

  let channelPath = "";
  let employeeProposal = "";
  await step(
    "「帮我招一个小红书运营」 -> a draft card, nothing created yet",
    async () => {
      const before = (await agentsOf()).length;
      await p.goto(`${ORIGIN}/channel/new?agent=avatar-${me}`);
      await send(p, SAY.hire);
      employeeProposal = await newestCard(p, []);
      channelPath = await until(
        "the conversation to have its own address",
        () => {
          const path = new URL(p.url()).pathname;
          return (
            path.startsWith("/channel/") && path !== "/channel/new" && path
          );
        },
      );
      equal(count("propose_employee"), 1, "the model drafted one employee");
      check(
        calls.find((call) => call.kind === "propose_employee")?.offeredStaffing,
        "小管家's turn was offered the 「招聘与组群」 tools without anyone granting them",
      );
      const shown = card(p, employeeProposal);
      await shown.getByRole("button", { name: "确认创建" }).waitFor();
      check(true, "the card offers 确认创建 to the person who asked");
      equal(
        await shown.getByLabel("名字", { exact: true }).inputValue(),
        DRAFT.name,
        "the card shows the drafted name in an editable field",
      );
      await shown.getByText(DRAFT.roleDescription).first().waitFor();
      check(true, "the card shows the drafted role description in full");
      await p
        .getByText(ANSWER.employeeDrafted)
        .first()
        .waitFor({ timeout: 30_000 });
      check(true, "小管家's sentence about the draft is in the conversation");
      equal(
        (await proposal(employeeProposal)).body.proposal?.status,
        "pending",
        "API: the proposal waits for the person",
      );
      equal(
        (await agentsOf()).length,
        before,
        "API: drafting created no employee",
      );
    },
  );

  await step(
    "edit the name and confirm -> the employee exists under the edited name",
    async () => {
      const shown = card(p, employeeProposal);
      await shown.getByLabel("名字", { exact: true }).fill(DRAFT.edited);
      await shown.getByRole("button", { name: "确认创建" }).click();
      await p
        .locator(
          `[data-staffing-proposal="${employeeProposal}"][data-status="applied"]`,
        )
        .waitFor({ timeout: 30_000 });
      check(true, "the card reads 已完成 (applied)");
      const agents = await agentsOf();
      const hired = agents.find((agent) => agent.name === DRAFT.edited);
      check(hired, `API: GET /api/agents lists 「${DRAFT.edited}」`);
      check(
        !agents.some((agent) => agent.name === DRAFT.name),
        `API: nobody is called by the drafted name 「${DRAFT.name}」`,
      );
      members.a = hired.id;
      members.aName = DRAFT.edited;
      const view = (await proposal(employeeProposal)).body.proposal;
      equal(view?.status, "applied", "API: the proposal is applied");
      const items = view?.result ?? [];
      check(items.length > 0, "API: the result lists its steps");
      check(
        items.every((item) => item.outcome === "done"),
        `API: every step is done (${JSON.stringify(items.map((item) => [item.step, item.outcome]))})`,
      );
      const done = card(p, employeeProposal);
      await done.getByText("建员工").first().waitFor();
      await done.getByText("已完成", { exact: true }).first().waitFor();
      check(true, "the card shows the step-by-step result (建员工 ✓)");
      await done.getByRole("link", { name: "打开员工" }).waitFor();
      check(true, "the result offers 打开员工");
      check(
        (await done.getByRole("button", { name: "确认创建" }).count()) === 0,
        "the card no longer offers 确认创建",
      );
    },
  );

  await step(
    "say it is confirmed -> 小管家 reads the result and carries on",
    async () => {
      await send(p, SAY.confirmed);
      await p
        .getByText(ANSWER.employeeDone)
        .first()
        .waitFor({ timeout: 30_000 });
      check(true, "小管家's next sentence appears in the conversation");
      equal(count("proposal_status"), 1, "the model read proposal_status once");
      check(
        statusAnswers.some((text) => text.includes("已执行完")),
        `proposal_status answered 已执行完 (${statusAnswers.join(" | ").slice(0, 400)})`,
      );
    },
  );

  let groupProposal = "";
  await step(
    "「把 A 和 B 拉个群」 -> a group card in the drafted order",
    async () => {
      await send(p, SAY.group(members.aName, members.bName));
      groupProposal = await newestCard(p, [employeeProposal]);
      equal(count("propose_group"), 1, "the model drafted one group");
      const shown = card(p, groupProposal);
      await shown.getByRole("button", { name: "确认建群" }).waitFor();
      check(true, "the card offers 确认建群 to the person who asked");
      const order = await shown
        .locator("ol > li")
        .evaluateAll((items) => items.map((item) => item.textContent ?? ""));
      check(
        order.length === 2 &&
          order[0]?.includes(members.aName) &&
          order[1]?.includes(members.bName),
        `the card lists the members in the drafted order (${JSON.stringify(order)})`,
      );
      await p
        .getByText(ANSWER.groupDrafted)
        .first()
        .waitFor({ timeout: 30_000 });
      check(
        true,
        "小管家's sentence about the group draft is in the conversation",
      );
    },
  );

  await step(
    "another account opens the same conversation: no card, no button",
    async () => {
      otherContext = await (browser as Browser).newContext({
        viewport: { width: 1280, height: 1000 },
        locale: "zh-CN",
      });
      const other = await otherContext.newPage();
      other.setDefaultTimeout(20_000);
      await signUp(other, otherContext, "G6 旁人", OTHER_EMAIL);
      await other.goto(`${ORIGIN}${channelPath}`);
      // Wait for what the page actually settles on before counting what is missing: a conversation the
      // account is not in reads as unreadable. Counting zero cards on a page still loading proves nothing.
      await other
        .getByText(UNREADABLE_CONVERSATION)
        .first()
        .waitFor({ timeout: 30_000 });
      check(
        true,
        "the other account's page says it cannot read the conversation",
      );
      await screenshot("other-account-opens-the-conversation", other);
      for (const label of ["确认创建", "确认建群", "作废", "重试失败的步骤"])
        equal(
          await other.getByRole("button", { name: label }).count(),
          0,
          `the other account sees no 「${label}」 button`,
        );
      equal(
        await other.locator("[data-staffing-proposal]").count(),
        0,
        "the other account sees no proposal card",
      );
      check(
        (await other.getByText(DRAFT.roleDescription).count()) === 0,
        "the other account does not see the draft's text",
      );
      const read = await proposal(groupProposal, otherContext);
      check(
        read.status === 403 || read.status === 404,
        `API: the other account cannot read the group draft (${read.status})`,
      );
      const apply = await api(
        "POST",
        `/api/proposals/${groupProposal}/apply`,
        undefined,
        otherContext,
      );
      check(
        apply.status === 403 || apply.status === 404,
        `API: the other account cannot confirm it (${apply.status})`,
      );
      equal(
        (await proposal(groupProposal)).body.proposal?.status,
        "pending",
        "API: the group draft still waits for the person who asked",
      );
      await other.close();
    },
  );

  await step(
    "confirm the group -> the group exists, employees in order [A, B]",
    async () => {
      const shown = card(p, groupProposal);
      await shown.getByRole("button", { name: "确认建群" }).click();
      await p
        .locator(
          `[data-staffing-proposal="${groupProposal}"][data-status="applied"]`,
        )
        .waitFor({ timeout: 30_000 });
      check(true, "the group card reads 已完成 (applied)");
      const view = (await proposal(groupProposal)).body.proposal;
      equal(view?.status, "applied", "API: the group proposal is applied");
      const channelId =
        view?.result?.find((item) => item.step === "group")?.target ?? "";
      check(channelId, "API: the result names the new group");
      const group = await api<{ bots: { id: string; name: string }[] }>(
        "GET",
        `/api/groups/${channelId}`,
      );
      equal(group.status, 200, "API: GET /api/groups/:id answers");
      const listed = await api<{ channels: { id: string }[] }>(
        "GET",
        "/api/channels",
      );
      check(
        listed.body.channels.some((channel) => channel.id === channelId),
        "API: the new group is among the person's conversations",
      );
      equal(
        group.body.bots.map((bot) => bot.id),
        [members.a, members.b],
        "API: the group's employees are in the drafted order [A, B]",
      );
      await card(p, groupProposal)
        .getByRole("link", { name: "打开群组" })
        .waitFor();
      check(true, "the result offers 打开群组");
    },
  );

  await step("every model call went to the mock", async () => {
    check(calls.length > 0, "the mock answered model calls");
    equal(
      calls.filter((call) => call.kind !== "plain").map((call) => call.kind),
      [
        "propose_employee",
        "employee_drafted",
        "proposal_status",
        "employee_done",
        "propose_group",
        "group_drafted",
      ],
      "小管家's turns made exactly these scripted model calls",
    );
  });
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
  await otherContext?.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  await stopServer().catch(() => undefined);
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
    ? `\nG6 STAFFING LIFECYCLE: FAIL after ${assertions} assertions (artifacts in ${ARTIFACTS})`
    : `\nG6 STAFFING LIFECYCLE: PASS (${assertions} assertions, ${calls.length} model requests, all mocked)`,
);
process.exit(failed ? 1 : 0);
