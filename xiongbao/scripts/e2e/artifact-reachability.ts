/**
 * Gate G7: a file the Bot saved is reachable from the conversation (PR1 / P0 产物可达性接线), in a real
 * browser against a real server and PostgreSQL, with the model mocked (aimock). Same shape as G6
 * (`staffing-lifecycle.ts`) and as G4 (`wakerflow-lifecycle.ts`); it adds nothing to them.
 *
 * What is REAL here: the person's session, the conversation, the run, the mocked model's tool call, the
 * app's own scope rule applied to the answer it reads (`isWorkspaceScope` in
 * `lib/computers/artifact.ts`, which decides whether a link may be drawn at all), the anchor the
 * transcript draws, the browser's own decision to save that address instead of navigating to it, and the
 * dark theme the screenshots are taken in.
 *
 * What is FIXED, because a CI runner has no computer to reach (this is the whole fixture boundary, and
 * nothing else is answered by hand):
 *
 *   GET  /api/computers/:botId/local-tools  the deployment's answer to "where are this Bot's files".
 *                                        A cloud runtime without a container provider mounts no
 *                                        `/api/computers` route at all (`devices/selection.ts`), so the
 *                                        runner has no computer to ask; `workspace` is what a cloud
 *                                        container deployment answers and `device` what a
 *                                        paired-computer one does (states 4 and 5 below)
 *   POST /api/approvals/computer/:botId  the gate that executes a write — answers the computer's result
 *                                        (`{result: {ok, path, bytes}}`, or a refusal)
 *   POST /api/computers/:botId/files/list  the folders this turn wrote into — answers their entries,
 *                                          with one folder reporting `truncated`
 *   GET  /api/computers/:botId/files/download  answers the bytes with the headers
 *                                              `shared/file-download.ts` sends (opaque attachment)
 *
 * So this proves the address the chat hands out, what the chat draws for it, and that clicking it makes
 * the browser save that address — with the answer's status, content type and attachment file name read
 * back through the page's own network stack. It does NOT prove the workspace's own bytes: those
 * are the computer's, and the download route's answer is pinned by `server/tests/computer-download-
 * routes.test.ts` (WP-0.4) with a stubbed gateway.
 *
 * The states captured, in the dark theme at 2x:
 *
 *   1. 01-…-artifact-line: the line for a saved file, as a link (`href`/`download`/`rel`), beside a
 *      refused write that stays plain text;
 *   2. 02-…-artifact-list: the turn's artifact list, one row per saved file with its size, plus the
 *      `truncated` caption that says the folder was not read to the end;
 *   3. 03-…-download-clicked: the click, which starts a save of the download route at the path the chat
 *      named, and the answer that address gives, carrying the attachment's own file name;
 *   4. 04-…-paired-computer: the same conversation with the scope answered `device` (a paired computer,
 *      where a file may sit under a project root the route does not know): no link, no list, and the
 *      line still naming the file. That is the ruling being tested from the other side.
 *
 * Environment (same as G6; see its header):
 *   E2E_DATABASE_URL, E2E_ROLE_WRITER_DATABASE_URL, E2E_OWNER_DATABASE_URL, E2E_APP_DIST_DIR,
 *   E2E_CHROME_PATH, E2E_ARTIFACTS_DIR, E2E_SERVER_PORT
 *
 * Usage (from xiongbao/): bun scripts/e2e/artifact-reachability.ts
 */

import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, openSync, closeSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { LLMock } from "@copilotkit/aimock";
import { SQL, type Subprocess } from "bun";
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Page,
  type Route,
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
// The files this turn saves, and what the (fixed) computer answers for each
// ---------------------------------------------------------------------------------------------

/** What the person asks for, in one sentence. */
const SAY = { save: "把这季度的数据存成文件，另外把待确认的那份也存一下。" } as const;
/** What the mocked Bot says once its calls come back. */
const ANSWER = {
  saved: "E2E-存好了：季度报告在 reports 目录里，另一份文件名带空格。",
  plain: "好的。",
} as const;

/**
 * The three writes the model is scripted to make.
 *
 * `asked` is what the model puts in the call (and what the line shows, unchanged from before this
 * change); `result` is what the computer answers, and the link is named by THAT when it says anything.
 *  A: the answer carries the path, spelled differently from the request (`./reports/...` is the same
 *    file as `reports/...`, and must not become two rows).
 *  B: the answer carries no path, so the link falls back to the requested one — a name with a space,
 *    parentheses and Chinese characters, which is what a download address must survive.
 *  C: refused, so there is no file to hand over: no link, no row, and the line still names it.
 */
const WRITTEN = [
  {
    asked: "./reports/季度报告.md",
    result: { ok: true, path: "reports/季度报告.md", bytes: 4123 },
    saved: "reports/季度报告.md",
    name: "季度报告.md",
  },
  {
    asked: "季度 报告(1).md",
    result: { ok: true, bytes: 2049 },
    saved: "季度 报告(1).md",
    name: "季度 报告(1).md",
  },
  {
    asked: "临时/待确认.md",
    result: {
      ok: false,
      refused: true,
      reason: "E2E：这个位置不允许写。",
    },
    saved: undefined,
    name: "待确认.md",
  },
] as const;

/** The folders the artifact list asks about, answered as the workspace spells a listing. */
const FOLDERS: Record<string, unknown> = {
  // Read to the end: what is not here is not there.
  reports: {
    path: "reports",
    entries: [
      { path: "reports/季度报告.md", kind: "file", bytes: 4123 },
      { path: "reports/别的.md", kind: "file", bytes: 12 },
    ],
    truncated: false,
  },
  // The workspace itself: `truncated`, so a file missing from THIS batch proves nothing.
  ".": {
    path: ".",
    entries: [{ path: "季度 报告(1).md", kind: "file", bytes: 2049 }],
    truncated: true,
  },
  临时: { path: "临时", entries: [], truncated: false },
};

// ---------------------------------------------------------------------------------------------
// The mocked model (aimock)
// ---------------------------------------------------------------------------------------------

type Message = {
  role?: string;
  content?: unknown;
  tool_calls?: { function?: { name?: string } }[];
};
type ModelCall = { kind: "write_files" | "answered" | "plain"; offeredWrite: boolean };
const calls: ModelCall[] = [];

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

/** One turn: the person's sentence, then the three writes, then the sentence after the results. */
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
  const offeredWrite = offered.has("computer_write_file");

  if (said.includes("存") && offeredWrite && results.length === 0) {
    calls.push({ kind: "write_files", offeredWrite });
    return {
      toolCalls: WRITTEN.map((file) => ({
        name: "computer_write_file",
        arguments: JSON.stringify({ path: file.asked, contents: "E2E\n" }),
      })),
    };
  }
  if (said.includes("存") && results.length > 0) {
    calls.push({ kind: "answered", offeredWrite });
    return { content: ANSWER.saved };
  }
  calls.push({ kind: "plain", offeredWrite });
  return { content: ANSWER.plain };
}

const mock = new LLMock({ host: "127.0.0.1", port: 0 });
mock.onMessage(/[\s\S]*/, async (request) => answer(request));
const mockUrl = await mock.start();
const MODEL_BASE_URL = `${mockUrl}/v1`;

// ---------------------------------------------------------------------------------------------
// The server (the deployment under test: no computer paired with it)
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

const SIGN_UP_EMAIL = "g7-person@example.test";
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
  INITIAL_ADMIN_EMAILS: SIGN_UP_EMAIL,
  INTELLIGENCE_MODE: "local",
  TENANT_PACKAGE_DIR: "../examples/xiongbao",
  APP_DIST_DIR,
  // A cloud runtime with no container provider: `devices/selection.ts` gives it no computer provider,
  // so `/api/computers/*` is not mounted and the scope answer the page reads is handed by
  // `fixedComputer` — `workspace`, which is what a cloud container deployment answers for itself.
  OPENAI_BASE_URL: MODEL_BASE_URL,
  OPENAI_API_KEY: "g7-mock-key-not-a-secret",
  AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS: "true",
  // This gate drives the page-run computer path: the page's computer is answered by hand below and
  // the deployment has none of its own. Since 期九·六 a chat's computer tools are the server's by
  // default, so it pins `off`, the way back operators keep for one release; the server-run path is
  // G8's (`background-chat.ts`) and the real-model evaluation's.
  XIONGBAO_CHAT_SERVER_COMPUTER_TOOLS: "off",
  COPILOTKIT_TELEMETRY_DISABLED: "true",
  DO_NOT_TRACK: "1",
};

let server: Subprocess | undefined;

async function startServer() {
  const log = resolve(ARTIFACTS, "server-1.log");
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
// The browser, its session, and the fixed computer answers
// ---------------------------------------------------------------------------------------------

let browser: Browser | undefined;
let context: BrowserContext | undefined;

async function api<T = Record<string, unknown>>(
  method: "GET" | "POST",
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

/** The sign-in page's own form, as G6 does; the account's 小管家 is its Bot. */
async function signUp(p: Page, name: string, email: string): Promise<string> {
  await p.goto(`${ORIGIN}/sign`);
  await p.getByRole("button", { name: "注册", exact: true }).click();
  await p.getByPlaceholder("你的名字").fill(name);
  await p.getByPlaceholder("you@example.com").fill(email);
  await p.getByPlaceholder("密码").fill(`pw-${randomUUID()}`);
  await p.getByRole("button", { name: "创建我的账户" }).click();
  await p.waitForURL((url) => !url.pathname.startsWith("/sign"), {
    timeout: 30_000,
  });
  const me = await api<{ user?: { id?: string } }>("GET", "/api/me");
  equal(me.status, 200, `${name}: the session cookie authenticates /api/me`);
  equal(
    (await api("POST", "/api/me/onboarding", { completed: true })).status,
    200,
    `${name}: onboarding marked complete`,
  );
  return me.body.user?.id ?? "";
}

async function send(p: Page, text: string) {
  const box = p.getByRole("textbox", { name: "消息" }).last();
  await box.fill(text);
  await p.getByRole("button", { name: "发送消息" }).last().click();
}

/** Everything the fixed computer was asked for, so the run can be read back afterwards. */
const gateBodies: string[] = [];
const listRequests: string[] = [];
const downloadRequests: string[] = [];
/** Every read of `…/local-tools` the page made, in order: the scope question, asked where? */
const scopeReads: string[] = [];
/**
 * The deployment's answer, handed to the page: `workspace` (a cloud container, the default here) or
 * `device` (a paired computer). States 4 and 5 are the same conversation with this one value moved.
 */
let scopeOverride: "workspace" | "device" | undefined;

const COMPUTER_PATH = /^\/api\/computers\/[^/]+\/(files\/(list|download))$/;
const GATE_PATH = /^\/api\/approvals\/computer\/[^/]+$/;

/** The bytes the fixed computer has for whichever file the download address names. */
const ANSWERED_BYTES = "E2E bytes for the file the chat named.\n";

/** What an address the page asked came back as. */
type AnsweredFile = {
  status: number;
  type: string | null;
  disposition: string | null;
  text: string;
};

/** The attachment headers `shared/file-download.ts` sends, for the file the path names. */
function attachmentHeaders(name: string): Record<string, string> {
  const ascii = [...name]
    .map((character) =>
      character >= " " && character <= "~" ? character : "_",
    )
    .join("");
  const escaped = encodeURIComponent(name).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return {
    "content-type": "application/octet-stream",
    "content-disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${escaped}`,
    "x-content-type-options": "nosniff",
    "cache-control": "private, no-store",
  };
}

/**
 * The file name an attachment header promises: the UTF-8 form first, the ASCII fallback behind it.
 *
 * The inverse of `attachmentHeaders` above, and the same reading a browser makes when it saves the
 * answer: this is where "the name the chat promised is the name that reaches disk" is decided.
 */
function attachmentNameOf(disposition: string | null): string | undefined {
  const header = disposition ?? "";
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(header)?.[1];
  const fallback =
    utf8 === undefined ? /filename="([^"]*)"/i.exec(header)?.[1] : undefined;
  const value = (utf8 ?? fallback)?.trim();
  if (value === undefined || value === "") return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * What an address says it saves: the route, and the path read back the way the route reads it.
 *
 * Both sides of the comparison go through this, so the assertion is about the file being saved and not
 * about how one percent-encoding happened to be spelled.
 */
function savedAddress(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}?${parsed.searchParams.get("path") ?? ""}`;
  } catch {
    return url;
  }
}

/**
 * Asks an address the way the page asks its own API: through the browser's network stack, where
 * `route()` does see it.
 *
 * Only the download answer needs this (step 5): a save started by `<a download>` runs in the browser
 * process and bypasses that interception in Chromium, while a request the page makes itself does not.
 */
async function askThePage(p: Page, href: string): Promise<AnsweredFile> {
  return p.evaluate(async (address: string) => {
    const response = await fetch(address, { credentials: "same-origin" });
    return {
      status: response.status,
      type: response.headers.get("content-type"),
      disposition: response.headers.get("content-disposition"),
      text: await response.text(),
    };
  }, href);
}

/**
 * The path the gated write names for ITSELF: `args.path` of the approval payload.
 *
 * Read out of the parsed body, never out of the body's text. The gate's payload carries the
 * conversation as well (`messages`), and the assistant message in it repeats every tool call of this
 * turn — so a whole-body search matches the FIRST scripted file on all three calls and answers each of
 * them with that one result: three links to the same address, one row in the list, and the refused
 * write drawn as a saved one. The call's own argument is the only thing that says which file is gated.
 */
function gatedWritePath(body: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const path = (parsed as { args?: { path?: unknown } } | null)?.args?.path;
  return typeof path === "string" ? path : undefined;
}

/**
 * The computer, answered by hand: the scope the page reads before drawing a link, the gate that runs a
 * write, the folders the list asks about, and the download the anchor points at. Nothing else is
 * intercepted, and nothing here is intercepted that the page could answer for itself.
 */
async function fixedComputer(route: Route): Promise<void> {
  const request = route.request();
  const url = new URL(request.url());
  const path = url.pathname;
  if (GATE_PATH.test(path) && request.method() === "POST") {
    const body = request.postData() ?? "";
    gateBodies.push(body);
    const file = WRITTEN.find(
      (candidate) => candidate.asked === gatedWritePath(body),
    );
    if (!file)
      throw new Error(
        `the approval gate was asked to save a file this run did not script: ${body.slice(0, 400)}`,
      );
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ result: file.result }),
    });
  }
  if (COMPUTER_PATH.test(path) && path.endsWith("/files/list")) {
    const body = (JSON.parse(request.postData() ?? "{}") || {}) as {
      path?: unknown;
    };
    const folder = typeof body.path === "string" ? body.path : ".";
    listRequests.push(folder);
    const answer =
      FOLDERS[folder] ?? { path: folder, entries: [], truncated: false };
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(answer),
    });
  }
  if (COMPUTER_PATH.test(path) && path.endsWith("/files/download")) {
    downloadRequests.push(path + url.search);
    // The route answers under the last segment of the path it was handed, as the attachment says.
    const name = (url.searchParams.get("path") ?? "").split("/").at(-1) as string;
    return route.fulfill({
      status: 200,
      headers: attachmentHeaders(name),
      body: ANSWERED_BYTES,
    });
  }
  if (/^\/api\/computers\/[^/]+\/local-tools$/.test(path)) {
    // The one answer both the line and the list read before drawing anything. A runner has no
    // computer to seat this Bot on — `devices/selection.ts` mounts no `/api/computers` routes at all
    // for a cloud runtime without a container provider — so the deployment's answer is handed here:
    // `workspace` is what a cloud container deployment answers, `device` what a paired-computer one
    // does (`gateway.ts` reads the runtime, never the conversation). States 4 and 5 flip this value;
    // nothing else about the page changes, which is what makes them a control for each other.
    scopeReads.push(path);
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        allowed: false,
        machine: scopeOverride ?? "workspace",
      }),
    });
  }
  return route.fallback();
}

const INTERCEPTED = (url: URL) =>
  GATE_PATH.test(url.pathname) ||
  COMPUTER_PATH.test(url.pathname) ||
  url.pathname.endsWith("/local-tools");

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
      // 2x, dark: the screenshots are the deliverable, so they are taken the way the app is used.
      viewport: { width: 1280, height: 1000 },
      deviceScaleFactor: 2,
      locale: "zh-CN",
      colorScheme: "dark",
      acceptDownloads: true,
    });
    await context.addInitScript(() => {
      window.localStorage.setItem("xiongbao-theme", "dark");
    });
    await context.route(INTERCEPTED, (route) => fixedComputer(route));
    await context.tracing.start({ screenshots: true, snapshots: true });
    page = await context.newPage();
    page.setDefaultTimeout(20_000);
    console.log(
      `   browser ${CHROME}, version ${browser.version()}; model mock ${MODEL_BASE_URL}`,
    );
  });
  const p = page as Page;

  let me = "";
  let bot = "";
  await step("sign up; the account's 小管家 is the Bot under test", async () => {
    me = await signUp(p, "G7 测试员", SIGN_UP_EMAIL);
    check(me, "the person has an id");
    bot = `avatar-${me}`;
    const listed = await api<{ agents: { id: string }[] }>("GET", "/api/agents");
    equal(listed.status, 200, "GET /api/agents answers the person's own list");
    check(
      listed.body.agents.some((agent) => agent.id === bot),
      `the 小管家 (${bot}) is among their employees`,
    );
    /*
     * Checked rather than assumed: this deployment has no computer of its own to ask.
     *
     * `devices/selection.ts` gives a cloud runtime without a container provider no provider at all, so
     * `/api/computers/*` is not mounted and the read answers 404. The scope answer the page then builds
     * on is the one `fixedComputer` hands it — which is only honest if the page really asked instead of
     * assuming, so the reads are counted there and read back in the next step.
     */
    const scope = await api<Record<string, unknown>>(
      "GET",
      `/api/computers/${encodeURIComponent(bot)}/local-tools`,
    );
    equal(scope.status, 404, "this deployment has no computer to answer for the Bot");
  });

  let channelPath = "";
  await step("「存成文件」 -> the saved file's line is a link", async () => {
    await p.goto(`${ORIGIN}/channel/new?agent=${encodeURIComponent(bot)}`);
    await send(p, SAY.save);
    const links = p.locator("[data-tool-download]");
    await until(
      "two saved-file lines carrying a download address",
      async () => (await links.count()) === 2,
    );
    channelPath = new URL(p.url()).pathname;
    check(
      channelPath.startsWith("/channel/") && channelPath !== "/channel/new",
      "the conversation has its own address",
    );
    equal(
      gateBodies.length,
      3,
      "the three writes went through the server's approval gate, and nothing else was answered by hand",
    );

    const first = links.first();
    const href = await first.getAttribute("href");
    equal(
      href,
      `/api/computers/${encodeURIComponent(bot)}/files/download?path=reports%2F%E5%AD%A3%E5%BA%A6%E6%8A%A5%E5%91%8A.md`,
      "the line's address names the path the computer answered with, encoded as one query value",
    );
    equal(await first.getAttribute("download"), "", "it saves rather than navigates");
    equal(await first.getAttribute("rel"), "noopener", "rel=noopener");
    check(
      (await first.innerText()).includes("./reports/季度报告.md"),
      "the words of the line still name the file it was asked to save",
    );
    const refusedLine = p.getByText("临时/待确认.md", { exact: false }).first();
    await refusedLine.waitFor();
    equal(
      await p.locator("[data-tool-download]").count(),
      2,
      "the refused write drew no link: a link is a promise the file is there",
    );
    equal(
      new Set(scopeReads).size,
      1,
      "the saved-file line and the turn's list asked one scope question about one Bot, and asked the server",
    );
    await screenshot("artifact-line");
  });

  await step("本轮产物 -> one list of the turn's files, with its truncated caption", async () => {
    const list = p.locator("[data-artifact-list]");
    await list.waitFor();
    const rows = p.locator("[data-artifact-path]");
    await until(
      "both saved files in the turn's list",
      async () => (await rows.count()) === 2,
    );
    equal(
      await rows.evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute("data-artifact-path") ?? ""),
      ),
      ["reports/季度报告.md", "季度 报告(1).md"],
      "the list is this turn's writes, in the order they were written, and the refused one is not in it",
    );
    check(
      (await rows.first().innerText()).includes("4"),
      "a row the folder confirmed also carries its size",
    );
    await p.locator("[data-artifact-truncated]").waitFor();
    check(
      (await p.locator("[data-artifact-truncated]").innerText()).includes(
        "没列全",
      ),
      "a folder that stopped at its own limit says so instead of claiming a full list",
    );
    equal(
      [...new Set(listRequests)].sort(),
      [".", "reports"],
      "only the folders this turn wrote into were listed: the list is not a directory scan",
    );
    await screenshot("artifact-list");
  });

  await step("点它 -> the browser asks the download route for that file", async () => {
    /*
     * Two halves, because Chromium will only let us prove one of them through the click itself. A save
     * started by `<a download>` runs in the browser process and never passes the interception a page's
     * own requests go through (microsoft/playwright#38585; this gate's own counters say it too — the
     * download event fires while `/files/download` is asked zero times). So the click is proved at the
     * click: the browser starts a SAVE, of the address the line carries. And the answer that address
     * gives is read back through the page's network stack, which IS intercepted: the same status, the
     * same opaque content type, the same attachment headers `shared/file-download.ts` sends, the same
     * promised file name. Both halves are what a person gets when they click.
     */
    const fromLine = p.locator("[data-tool-download]").first();
    const lineHref = (await fromLine.getAttribute("href")) ?? "";
    const [lineDownload] = await Promise.all([
      p.waitForEvent("download", { timeout: 20_000 }),
      fromLine.click(),
    ]);
    equal(
      savedAddress(lineDownload.url()),
      `/api/computers/${bot}/files/download?reports/季度报告.md`,
      "the line's click makes the browser save the download route with the path the chat named, not navigate to it",
    );
    const lineAnswer = await askThePage(p, lineHref);
    equal(
      lineAnswer.status,
      200,
      "the address the line hands out answers instead of 404ing on the way to the computer",
    );
    equal(
      lineAnswer.type,
      "application/octet-stream",
      "安全决策 A4: the answer is bytes, never a page rendered on this origin",
    );
    equal(
      lineAnswer.text,
      ANSWERED_BYTES,
      "the bytes it answers are the ones the computer has for that file",
    );
    equal(
      attachmentNameOf(lineAnswer.disposition),
      "季度报告.md",
      "the attachment promises the file under the name the computer saved it",
    );
    // Then the same file's row in the list, and the awkward name that only the link has to survive.
    const row = p.locator('[data-artifact-path="季度 报告(1).md"]');
    await row.focus();
    const rowHref = (await row.getAttribute("href")) ?? "";
    const [rowDownload] = await Promise.all([
      p.waitForEvent("download", { timeout: 20_000 }),
      row.click(),
    ]);
    equal(
      savedAddress(rowDownload.url()),
      `/api/computers/${bot}/files/download?季度 报告(1).md`,
      "the list's row saves the same route with the awkward path written back",
    );
    equal(
      attachmentNameOf((await askThePage(p, rowHref)).disposition),
      "季度 报告(1).md",
      "a name with a space, parentheses and Chinese characters arrives intact",
    );
    equal(
      downloadRequests.map((request) => {
        const url = new URL(`${ORIGIN}${request}`);
        return `${url.pathname}?${url.searchParams.get("path") ?? ""}`;
      }),
      [
        `/api/computers/${bot}/files/download?reports/季度报告.md`,
        `/api/computers/${bot}/files/download?季度 报告(1).md`,
      ],
      "both addresses were asked of /files/download with the bot id and the path, exactly once each",
    );
    await screenshot("download-clicked");
  });

  await step("作用域答成 device -> 没有链接，也没有这一页清单", async () => {
    scopeOverride = "device";
    await p.reload({ waitUntil: "load" });
    await p.getByText("./reports/季度报告.md", { exact: false }).first().waitFor();
    check(
      true,
      "the line for the file is still there after the scope changed: the words did not move",
    );
    equal(
      await p.locator("[data-tool-download]").count(),
      0,
      "a paired computer's files are not where this address looks, so no link is drawn",
    );
    equal(
      await p.locator("[data-artifact-list]").count(),
      0,
      "and no list of artifacts, so nothing promises a click that 404s",
    );
    await screenshot("paired-computer");
  });

  await step("同一个问题答回 workspace -> 同一份历史又把链接画回来了", async () => {
    // The control for the step above: the same messages, reloaded with the workspace answer back in
    // place, must draw the links again. Without it, "no link" would prove nothing about the scope — it
    // could just be a conversation read back from history drawing no links at all.
    scopeOverride = undefined;
    await p.reload({ waitUntil: "load" });
    await until(
      "the saved files' links to come back for the same history",
      async () => (await p.locator("[data-tool-download]").count()) === 2,
    );
    await until(
      "the turn's artifact list to come back",
      async () => (await p.locator("[data-artifact-path]").count()) === 2,
    );
    check(true, "the links and the list are decided by the scope answer, not by the hour");
    await screenshot("workspace-again");
  });

  /*
   * What a browser that cached the skin under the earlier name is handed, now that the window in which
   * both names were accepted has closed (PR4b; the ruling being checked is 「真删」). The pre-paint
   * script in `index.html` knows only the current key: it puts whatever that key holds on `<html>`,
   * because it is not told which names this build ships. The registry is what does know, and on load it
   * reads the cached name as the default and takes the attribute back off — then the account, which
   * always wins, writes the default into the cache. So the old name is on the page for less than a
   * frame, and the frame it is on is painted with the default tokens: no rule of any shipped skin
   * matches it. The record below is the evidence for all three of those, and the screenshot is the
   * page a person who never chose a skin sees.
   *
   * `app/src/skins/store.ts` is where the second and third halves live, so this is the only place the
   * pair is seen together: the unit test has no pre-paint script, and the script has no registry.
   */
  await step("the skin cached under the earlier name: first frame and settled", async () => {
    type Frame = { at: string; skin: string | null; background: string };
    const ctx = context as BrowserContext;
    const visit = await ctx.newPage();
    try {
      await visit.addInitScript(() => {
        // The cache a browser left behind before the rename: this key, that value.
        window.localStorage.setItem("xiongbao-skin", "openbot");
        const frames: Frame[] = [];
        const read = (at: string) => {
          const root = document.documentElement;
          if (!root) return;
          frames.push({
            at,
            skin: root.getAttribute("data-skin"),
            background: getComputedStyle(root)
              .getPropertyValue("--background")
              .trim(),
          });
        };
        /*
         * Every change of the attribute, in the order it happened, with the value it went out of as
         * well: a MutationObserver callback can be flushed once for two changes, and reading the page
         * inside the callback would then miss the first of them. `oldValue` is what keeps the earlier
         * frame in the record even when the app has already moved on.
         */
        new MutationObserver((records) => {
          for (const record of records) {
            const root = record.target as HTMLElement;
            frames.push({
              at: `${record.oldValue ?? "none"} -> ${root.getAttribute("data-skin") ?? "none"}`,
              skin: root.getAttribute("data-skin"),
              background: getComputedStyle(root)
                .getPropertyValue("--background")
                .trim(),
            });
          }
        }).observe(document, {
          attributeFilter: ["data-skin"],
          attributeOldValue: true,
          subtree: true,
        });
        read("start");
        document.addEventListener("DOMContentLoaded", () => read("parsed"));
        (
          window as unknown as { __xbSkinFrames?: Frame[] }
        ).__xbSkinFrames = frames;
      });
      // The same page the conversation is on, opened again: signed in, and no new
      // turn, so the model-call accounting in the step after this one is untouched.
      await visit.goto(p.url(), { waitUntil: "load" });

      // The registry settles the attribute on load, before the account is read.
      await until(
        "the application to take the cached name off <html>",
        async () =>
          await visit.evaluate(() =>
            document.documentElement.getAttribute("data-skin") === null
              ? "settled"
              : undefined,
          ),
      );
      equal(
        await visit.evaluate(
          () => document.documentElement.getAttribute("data-skin"),
        ),
        null,
        "the application settles <html> back to no skin attribute of its own",
      );
      // ...and the account, which always wins, leaves the cache holding what this
      // build ships.
      const cached = await until(
        "the account's skin to be written back over the pre-paint cache",
        async () => {
          const value = await visit.evaluate(() =>
            window.localStorage.getItem("xiongbao-skin"),
          );
          // Whatever this build writes back is an answer; the cached name is not,
          // because that is what was in the key before the page ran.
          return value === "openbot" ? undefined : { value };
        },
      );
      equal(
        cached.value,
        "xiongbao",
        "the cache ends up holding the id this build ships",
      );

      const frames = await visit.evaluate(
        () =>
          (
            window as unknown as {
              __xbSkinFrames?: {
                at: string;
                skin: string | null;
                background: string;
              }[];
            }
          ).__xbSkinFrames ?? [],
      );
      check(
        frames.length > 0,
        `the page recorded its own frames (${frames.length} of them)`,
      );
      check(
        frames.some((frame) => frame.skin === "openbot"),
        "the pre-paint script does put the cached old name on <html>: the half-sentence that used to hold it back is gone, and nothing else stands between the two",
      );
      check(
        frames.some((frame) => frame.skin === null),
        "and the application takes it back off again: the registry reads the old name as the default skin",
      );

      /*
       * The appearance question, answered in the only way this can be answered after the fact: the
       * attribute is put back by hand, the page is measured with it on, and it is compared with the
       * same page measured with it off. Same tokens means no rule of any shipped skin matched it,
       * which is what "an unknown name draws the default" has to mean on a real page.
       */
      const forced = await visit.evaluate(() => {
        const root = document.documentElement;
        const background = () =>
          getComputedStyle(root).getPropertyValue("--background").trim();
        const withoutName = background();
        root.dataset.skin = "openbot";
        const withOldName = background();
        delete root.dataset.skin;
        let named = 0;
        let oldName = 0;
        for (const sheet of Array.from(document.styleSheets)) {
          // A sheet this page may not read is not a sheet this build wrote.
          let rules: string[] = [];
          try {
            rules = Array.from(sheet.cssRules).map((rule) => rule.cssText);
          } catch {
            continue;
          }
          for (const text of rules) {
            if (!text.includes("data-skin")) continue;
            named += 1;
            if (text.includes('data-skin="openbot"')) oldName += 1;
          }
        }
        return { withoutName, withOldName, named, oldName };
      });
      check(
        forced.named > 0,
        `the sheets do carry skin rules (${forced.named} name the attribute at all), so the count below is a reading, not an empty hand`,
      );
      equal(
        forced.oldName,
        0,
        "not one of them matches the old name, so nothing could paint for it",
      );
      equal(
        forced.withOldName,
        forced.withoutName,
        "and the page with the old name on <html> takes the same --background as the page without it",
      );

      writeFileSync(
        resolve(ARTIFACTS, "skin-first-frame.json"),
        `${JSON.stringify({ frames, cached, forced }, null, 2)}\n`,
      );
      await screenshot("skin-cached-before-the-rename", visit);
      check(true, "the settled page is screenshotted and its frames written out");
    } finally {
      await visit.close().catch(() => undefined);
    }
  });

  await step("the mocked model, and nothing else", async () => {
    /*
     * The turn's calls, counted the way G6 counts them (`staffing-lifecycle.ts`, same step): a running
     * deployment asks its model for more than this conversation — the summariser titles the channel,
     * the translation loop asks for the skill words — and every one of those reaches the mock as a
     * request with no file tool in it, which `answer` scripts as `plain` and which runs nothing. So
     * `plain` is what says nothing was scripted into it, not a call to drop from the record:
     * `model-calls.json` still holds all of them, and the gate count above is what proves only the
     * three scripted writes ever reached a computer.
     */
    equal(
      calls.filter((call) => call.kind !== "plain").map((call) => call.kind),
      ["write_files", "answered"],
      "the turn made exactly these scripted model calls",
    );
    check(
      calls
        .filter((call) => call.kind === "plain")
        .every((call) => !call.offeredWrite),
      "every other request the mock saw was offered no file tool: no second turn wrote a file",
    );
    /*
     * The first **scripted** call, not `calls[0]`. A running deployment asks its model for other
     * things besides this conversation (the channel title, the skill words), and which of those
     * reaches the mock first is a matter of timing — `calls[0]` is legitimately a `plain` request
     * with no file tool, as it was in run 44261149743, where the turn itself (the next call) did
     * carry the tool and the three writes did reach a computer. Asserting `calls[0]` therefore read
     * as "the write tool was never offered" whenever the summariser won that race. What this line
     * means is "this run reached the real registration", i.e. the conversation turn was equipped
     * with the write tool, and that is the first non-plain call.
     */
    check(
      calls.find((call) => call.kind !== "plain")?.offeredWrite,
      "the conversation was offered the file tool: this run reached the real registration",
    );
    await p.getByText(ANSWER.saved).first().waitFor({ timeout: 30_000 });
    check(true, "the Bot's sentence after the writes is in the conversation");
    await p.locator("html").evaluate((node) => {
      if (!node.classList.contains("dark"))
        throw new Error("the screenshots would not be in the dark theme");
    });
    check(true, "the page is in the dark theme, which is what the screenshots show");
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
    `${JSON.stringify(
      { calls, gateBodies, listRequests, downloadRequests, scopeReads },
      null,
      2,
    )}\n`,
  );
  if (context && !failed) await context.tracing.stop().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  await stopServer().catch(() => undefined);
  await mock.stop().catch(() => undefined);
  await owner.close().catch(() => undefined);
}

const total = (Date.now() - started) / 1000;
console.log("\nRequests the computer answered by hand:");
console.log(
  `  gate ${gateBodies.length}, list ${listRequests.length}, download ${downloadRequests.length}, scope ${scopeReads.length}`,
);
console.log("\nTimings:");
for (const timing of timings)
  console.log(`  ${timing.seconds.toFixed(1).padStart(6)} s  ${timing.name}`);
console.log(`  ${total.toFixed(1).padStart(6)} s  total`);
console.log(
  failed
    ? `\nG7 ARTIFACT REACHABILITY: FAIL after ${assertions} assertions (artifacts in ${ARTIFACTS})`
    : `\nG7 ARTIFACT REACHABILITY: PASS (${assertions} assertions, ${calls.length} model requests, all mocked)`,
);
process.exit(failed ? 1 : 0);
