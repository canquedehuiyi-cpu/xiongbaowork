import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { win32 } from "node:path";
import type { AppEntry } from "./apps";

/**
 * A minimal MCP client for the device-side local MCP bridge (spec §3.2). Zero dependencies: the MCP
 * SDK is installed for the server only, so the few JSON-RPC calls the bridge needs are written here:
 * `initialize`, `notifications/initialized`, `tools/list` (paged), `tools/call` and
 * `notifications/cancelled`. Two transports, both local: a child process spoken to over newline
 * delimited JSON on its pipes (`stdio`), and Streamable HTTP to a loopback url (`http`).
 *
 * What goes wrong is reported as a `McpAppError` whose `kind` says where, so the caller can word it
 * for the owner (the messages here are for logs, not for people):
 *   start         the child could not be started, or exited before the handshake finished
 *   unreachable   the request never reached the app: nothing listens at its loopback address
 *                 (the app is closed) or the address could not be dialled (http only)
 *   connect       the app went away after the request may have reached it
 *   timeout       no answer within the configured time
 *   protocol      the app answered, but not with something this client can use
 *   unknown_tool  the app has no tool of that name
 * A caller's own abort rejects with an `AbortError`, not a `McpAppError`.
 */

export type McpTool = {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    [k: string]: unknown;
  };
};

export type McpCallOutcome = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: unknown;
  isError: boolean;
  truncated: boolean;
};

export interface McpConnection {
  listTools(signal?: AbortSignal): Promise<McpTool[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpCallOutcome>;
  close(): Promise<void>;
  readonly closed: boolean;
}

export class McpAppError extends Error {
  kind:
    | "start"
    | "unreachable"
    | "connect"
    | "timeout"
    | "protocol"
    | "unknown_tool";
  stderrTail?: string;
  /** Chinese and fit to show the owner, when this client knows the reason better than the app does. */
  hint?: string;
  constructor(
    kind: McpAppError["kind"],
    message: string,
    stderrTail?: string,
    hint?: string,
  ) {
    super(message);
    this.name = "McpAppError";
    this.kind = kind;
    if (stderrTail !== undefined) this.stderrTail = stderrTail;
    if (hint !== undefined) this.hint = hint;
  }
}

const PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_TIMEOUTS = { initMs: 20_000, listMs: 20_000, callMs: 120_000 };
const RESULT_LIMIT_BYTES = 1_000_000;
const STDERR_LIMIT_BYTES = 4096;
const MAX_LIST_PAGES = 10;
const CLIENT_INFO = { name: "xiongbao-runner", version: "1" };

type Timeouts = { initMs?: number; listMs?: number; callMs?: number };
type Json = Record<string, unknown>;

/** One JSON-RPC exchange; `timeoutMs` is the whole wait, `signal` the caller's Stop. */
interface Transport {
  request(
    method: string,
    params: Json | undefined,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<unknown>;
  notify(method: string, params?: Json): Promise<void>;
  close(): Promise<void>;
  readonly closed: boolean;
  /** Called once the handshake is over, so a later loss reads as `connect`, not `start`. */
  markReady(): void;
  stderrTail(): string | undefined;
}

function abortError(): Error {
  const error = new Error("The call was aborted.");
  error.name = "AbortError";
  return error;
}

function rpcError(method: string, error: unknown): McpAppError {
  const { code, message } = (error ?? {}) as {
    code?: number;
    message?: string;
  };
  const text = typeof message === "string" ? message : "unknown error";
  if (
    method === "tools/call" &&
    code === -32602 &&
    /unknown|not found|no such/i.test(text)
  ) {
    return new McpAppError("unknown_tool", text);
  }
  return new McpAppError(
    "protocol",
    `${method} failed (${code ?? "?"}): ${text}`,
  );
}

// ---------------------------------------------------------------------------------------------
// Launching a stdio app
// ---------------------------------------------------------------------------------------------

/**
 * The parent's environment without anything of ours (`XIONGBAO_*` carries the runner's token and
 * server settings), with the entry's own `env` laid over it. The entry's `env` is the owner's
 * choice, so it is applied as given.
 */
export function childEnv(
  parent: Record<string, string | undefined>,
  entryEnv: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined || key.startsWith("XIONGBAO_")) continue;
    env[key] = value;
  }
  return { ...env, ...entryEnv };
}

/**
 * Quote one argument for a `cmd.exe` command line, the way the Microsoft C runtime reads it back:
 * wrap in double quotes, put a backslash before each embedded quote (doubling any backslashes that
 * already precede it) and double a run of backslashes at the end so it cannot swallow the closing
 * quote. Characters cmd treats specially (& | < > ^) are inert inside quotes. KNOWN LIMIT: `%NAME%`
 * is still expanded by cmd, even in quotes, and cannot be escaped on a command line.
 */
function quoteForCmd(arg: string): string {
  const escaped = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1");
  return `"${escaped}"`;
}

/** cmd.exe's own list, used when the environment has no PATHEXT. */
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/**
 * A variable as a Windows child sees it. Names are case-insensitive there, and a plain object can
 * hold both `Path` (from the parent) and `PATH` (from the entry): the last one is taken, which is
 * the entry's, since `childEnv` lays the entry's variables after the parent's.
 */
function winEnvValue(
  env: Record<string, string | undefined>,
  name: string,
): string | undefined {
  let found: string | undefined;
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && key.toUpperCase() === name) found = value;
  }
  return found;
}

function isFileOnDisk(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The absolute path of what a bare Windows command name such as `npx` runs: the first folder of the
 * child's PATH holding the name, tried as written when it already has an extension, then with each
 * PATHEXT extension (`npx.cmd`). A command with a folder in it (absolute, `.\bin\x`, `C:x`) is the
 * owner's own choice and comes back exactly as written. `undefined` when nothing on PATH matches.
 * Neither the current folder nor a relative PATH folder is searched: only what is installed counts.
 */
export function resolveWindowsCommand(
  command: string,
  env: Record<string, string | undefined>,
  isFile: (path: string) => boolean,
): string | undefined {
  if (/[\\/]/.test(command) || /^[A-Za-z]:/.test(command)) return command;
  const extensions = (winEnvValue(env, "PATHEXT") ?? DEFAULT_PATHEXT)
    .split(";")
    .map((ext) => ext.trim())
    .filter((ext) => ext.startsWith("."))
    // Windows names are case-insensitive; `.cmd` is how npm and most installers spell their shims.
    .map((ext) => ext.toLowerCase());
  const names = [
    ...(win32.extname(command) ? [command] : []),
    ...extensions.map((ext) => command + ext),
  ];
  for (const raw of (winEnvValue(env, "PATH") ?? "").split(";")) {
    const dir = raw.trim().replace(/^"(.*)"$/, "$1");
    // A relative PATH folder would depend on where the app starts: not a place anything is installed.
    if (!win32.isAbsolute(dir)) continue;
    for (const name of names) {
      const candidate = win32.join(dir, name);
      if (isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

/** What to install for the commands people usually give, so a missing one can be named. */
const INSTALLED_BY: Record<string, string> = {
  node: "Node.js",
  npm: "Node.js",
  npx: "Node.js",
  uv: "uv",
  uvx: "uv",
  bun: "Bun",
  bunx: "Bun",
  python: "Python",
  py: "Python",
  docker: "Docker Desktop",
};

function commandNotFound(command: string): McpAppError {
  const product = INSTALLED_BY[command.replace(/\.[^.]*$/, "").toLowerCase()];
  const hint = product
    ? `找不到命令 ${command}，请确认已安装（例如 ${product}），并重启设备端。`
    : `找不到命令 ${command}，请确认已安装并已加入 PATH，然后重启设备端。`;
  return new McpAppError(
    "start",
    `${command} was not found on PATH.`,
    undefined,
    hint,
  );
}

/**
 * How to start a stdio app. On Windows the usual commands (`npx`, `bunx`, `uvx`) are `.cmd` shims
 * that `spawn` cannot run directly (ENOENT), so the whole command goes through
 * `cmd.exe /d /s /c "<each part quoted>"`. With `/s`, cmd drops the first and last quote of that
 * line and runs the rest, hence the extra outer pair; `windowsVerbatimArguments` stops Node from
 * quoting that line a second time. Elsewhere the command and its arguments are used as they are.
 *
 * On Windows a bare command is first turned into its absolute path on the child's PATH
 * (`resolveWindowsCommand`). cmd.exe must never be left to find a shim itself: for a batch file it
 * found through PATH under a quoted name, `%~dp0` reads as the CURRENT folder instead of the shim's
 * own, so npx.cmd, npm.cmd, pnpm.cmd... look for their scripts in the wrong place ("Cannot find
 * module ...\node_modules\npm\bin\npx-cli.js"). A command not found there fails as `start`, with a
 * Chinese `hint` naming it.
 *
 * Pure: the platform, the child's environment and the file check are passed in so every branch can
 * be tested anywhere.
 */
export function launchSpec(
  entry: AppEntry,
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  isFile: (path: string) => boolean = isFileOnDisk,
): { command: string; args: string[]; windowsVerbatimArguments?: boolean } {
  if (entry.kind !== "stdio") throw new Error("Only a stdio app is launched.");
  if (platform !== "win32") {
    return { command: entry.command, args: entry.args };
  }
  const command = resolveWindowsCommand(entry.command, env, isFile);
  if (command === undefined) throw commandNotFound(entry.command);
  const line = [command, ...entry.args].map(quoteForCmd).join(" ");
  return {
    command: winEnvValue(env, "COMSPEC") ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    windowsVerbatimArguments: true,
  };
}

/**
 * The folder a stdio app starts in: its own `cwd`, else the owner's home folder. Never the runner's
 * working folder, which for the device app is its private data folder and means nothing to the
 * owner (and an app given a relative path should find it where the owner would look).
 */
export function childCwd(entry: AppEntry, home: string): string {
  return entry.kind === "stdio" && entry.cwd ? entry.cwd : home;
}

// ---------------------------------------------------------------------------------------------
// stdio transport
// ---------------------------------------------------------------------------------------------

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  method: string;
};

class StdioTransport implements Transport {
  private closing = false;
  private child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private dead: McpAppError | undefined;
  private ready = false;
  private stderr = Buffer.alloc(0);
  private buffer = "";
  private decoder = new TextDecoder("utf-8");
  private exited: Promise<void>;
  private stopping = false;

  constructor(entry: AppEntry) {
    if (entry.kind !== "stdio") throw new Error("stdio entry expected");
    // The command is looked up in the PATH the child will have, which the entry may extend.
    const env = childEnv(process.env, entry.env);
    const spec = launchSpec(entry, process.platform, env);
    this.child = spawn(spec.command, spec.args, {
      cwd: childCwd(entry, homedir()),
      env,
      stdio: "pipe",
      windowsHide: true,
      // A group of its own on POSIX, so closing can take the whole tree down.
      detached: process.platform !== "win32",
      windowsVerbatimArguments: spec.windowsVerbatimArguments,
    });
    this.exited = new Promise<void>((resolve) => {
      this.child.once("close", (code, signal) => {
        this.fail(
          this.ready ? "connect" : "start",
          `The app exited${code !== null ? ` with code ${code}` : ""}${signal ? ` (${signal})` : ""}.`,
        );
        resolve();
      });
      this.child.on("error", (error) => {
        this.fail("start", `The app could not be started: ${error.message}`);
        resolve();
      });
    });
    this.child.stdin.on("error", () => {});
    this.child.stdout.on("error", () => {});
    this.child.stderr.on("error", () => {});
    this.child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => {
      const all = Buffer.concat([this.stderr, chunk]);
      let start = Math.max(0, all.length - STDERR_LIMIT_BYTES);
      // Do not begin in the middle of a multi-byte character.
      while (start < all.length && ((all[start] ?? 0) & 0xc0) === 0x80) {
        start += 1;
      }
      this.stderr = all.subarray(start);
    });
  }

  /** True once closed, and also once the child has gone: a dead connection must not be reused. */
  get closed() {
    return this.closing || this.dead !== undefined;
  }

  markReady() {
    this.ready = true;
  }

  stderrTail() {
    return this.stderr.length ? this.stderr.toString("utf8") : undefined;
  }

  private fail(kind: McpAppError["kind"], message: string) {
    if (this.dead) return;
    this.dead = new McpAppError(kind, message, this.stderrTail());
    for (const pending of this.pending.values()) pending.reject(this.dead);
    this.pending.clear();
  }

  private onStdout(chunk: Buffer) {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf("\n");
      if (line) this.onLine(line);
    }
  }

  private onLine(line: string) {
    let message: Json;
    try {
      const parsed = JSON.parse(line);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      )
        return;
      message = parsed as Json;
    } catch {
      // A banner or a log line on stdout: not ours to interpret.
      return;
    }
    const { id, method } = message;
    if (typeof method === "string") {
      // The app is asking us something. Answer `ping`, refuse the rest; notifications need nothing.
      if (id !== undefined) {
        this.write(
          method === "ping"
            ? { jsonrpc: "2.0", id, result: {} }
            : {
                jsonrpc: "2.0",
                id,
                error: { code: -32601, message: "Method not found" },
              },
        );
      }
      return;
    }
    if (typeof id !== "number") return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (message.error !== undefined)
      pending.reject(rpcError(pending.method, message.error));
    else pending.resolve(message.result);
  }

  private write(message: unknown) {
    if (this.dead || this.closed) return;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(
    method: string,
    params: Json | undefined,
    timeoutMs: number,
    signal?: AbortSignal,
  ) {
    if (this.dead) return Promise.reject(this.dead);
    if (this.closed)
      return Promise.reject(
        new McpAppError("connect", "The connection is closed."),
      );
    if (signal?.aborted) return Promise.reject(abortError());
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.pending.delete(id);
      };
      const cancel = (reason: string) => {
        this.notify("notifications/cancelled", { requestId: id, reason }).catch(
          () => {},
        );
      };
      const onAbort = () => {
        settle();
        cancel("aborted");
        reject(abortError());
      };
      timer = setTimeout(() => {
        settle();
        cancel("timeout");
        reject(
          new McpAppError(
            "timeout",
            `${method} did not answer within ${timeoutMs} ms.`,
            this.stderrTail(),
          ),
        );
      }, timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        method,
        resolve: (value) => {
          settle();
          resolve(value);
        },
        reject: (error) => {
          settle();
          reject(error);
        },
      });
      const body: Json = { jsonrpc: "2.0", id, method };
      if (params) body.params = params;
      this.write(body);
    });
  }

  async notify(method: string, params?: Json) {
    const body: Json = { jsonrpc: "2.0", method };
    if (params) body.params = params;
    this.write(body);
  }

  async close() {
    if (!this.closing) {
      this.closing = true;
      this.fail("connect", "The connection was closed.");
      this.stop();
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.exited,
      new Promise((resolve) => {
        timer = setTimeout(resolve, 3000);
      }),
    ]);
    clearTimeout(timer);
  }

  /** The whole process tree: a group kill on POSIX, `taskkill /T /F` on Windows. */
  private stop() {
    const { pid } = this.child;
    if (pid === undefined || this.stopping) return;
    // Already exited: its pid may belong to someone else by now.
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.stopping = true;
    if (process.platform === "win32") {
      const systemRoot =
        process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
      const killer = spawn(
        win32.join(systemRoot, "System32", "taskkill.exe"),
        ["/PID", String(pid), "/T", "/F"],
        { windowsHide: true, stdio: "ignore" },
      );
      killer.once("error", () => {
        this.child.kill();
      });
      killer.once("close", (code) => {
        if (code !== 0) this.child.kill();
      });
      return;
    }
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already gone, or the group went with it.
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Streamable HTTP transport
// ---------------------------------------------------------------------------------------------

/**
 * Failures that happen before a connection to the app exists, so the request cannot have reached it:
 * nothing listening (the app is closed), or an address that could not be dialled. A reset or a drop
 * once connected is not here: by then the app may have read the request.
 */
const NEVER_CONNECTED = new Set([
  "ECONNREFUSED",
  "ConnectionRefused",
  "FailedToOpenSocket",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EADDRNOTAVAIL",
  "EAFNOSUPPORT",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1", "[::1]"];

/**
 * Exempts the loopback hosts from any HTTP(S)_PROXY for this process's own requests. Bun's fetch
 * sends even `127.0.0.1` through a configured proxy unless NO_PROXY says otherwise, and has no
 * per-request way out; it reads NO_PROXY on every request, so adding the loopback hosts here is
 * enough. Nothing else changes: a request to any other host is proxied exactly as before. Both
 * spellings are set because which one is read differs between platforms.
 */
export function bypassProxyForLoopback(
  env: Record<string, string | undefined> = process.env,
): void {
  for (const name of ["NO_PROXY", "no_proxy"]) {
    const entries = (env[name] ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (entries.includes("*")) continue;
    const missing = LOOPBACK_HOSTS.filter((host) => !entries.includes(host));
    if (missing.length) env[name] = [...entries, ...missing].join(",");
  }
}

class HttpTransport implements Transport {
  private closing = false;
  private lost = false;
  private nextId = 1;
  private sessionId: string | undefined;
  private inflight = new Set<() => void>();

  constructor(private url: string) {}

  /** True once closed, and once the app has proved unreachable. */
  get closed() {
    return this.closing || this.lost;
  }

  markReady() {}

  stderrTail() {
    return undefined;
  }

  private headers() {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": PROTOCOL_VERSION,
    };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    return headers;
  }

  private async post(body: Json, signal: AbortSignal) {
    let response: Response;
    bypassProxyForLoopback();
    try {
      response = await fetch(this.url, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal,
        // A redirect would post the same body somewhere else: it is an answer this client refuses.
        redirect: "manual",
      });
    } catch (error) {
      if (signal.aborted) throw error;
      this.lost = true;
      const code = (error as { code?: unknown }).code;
      throw new McpAppError(
        typeof code === "string" && NEVER_CONNECTED.has(code)
          ? "unreachable"
          : "connect",
        `Could not reach the app: ${(error as Error).message}`,
      );
    }
    const session = response.headers.get("mcp-session-id");
    if (session) this.sessionId = session;
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new McpAppError(
        "protocol",
        `The app answered HTTP ${response.status}.`,
      );
    }
    return response;
  }

  async request(
    method: string,
    params: Json | undefined,
    timeoutMs: number,
    callerSignal?: AbortSignal,
  ) {
    if (this.closed)
      throw new McpAppError("connect", "The connection is closed.");
    if (callerSignal?.aborted) throw abortError();
    const id = this.nextId++;
    const controller = new AbortController();
    let reason: "timeout" | "abort" | "close" | undefined;
    const stopWith = (why: typeof reason) => {
      reason ??= why;
      controller.abort();
    };
    const stopForClose = () => stopWith("close");
    this.inflight.add(stopForClose);
    const timer = setTimeout(() => stopWith("timeout"), timeoutMs);
    const onAbort = () => stopWith("abort");
    callerSignal?.addEventListener("abort", onAbort, { once: true });
    try {
      const body: Json = { jsonrpc: "2.0", id, method };
      if (params) body.params = params;
      const response = await this.post(body, controller.signal);
      const type = response.headers.get("content-type") ?? "";
      const message = type.includes("text/event-stream")
        ? await readSse(response, id)
        : await readJson(response, id);
      if (message.error !== undefined) throw rpcError(method, message.error);
      return message.result;
    } catch (error) {
      if (reason === "timeout") {
        throw new McpAppError(
          "timeout",
          `${method} did not answer within ${timeoutMs} ms.`,
        );
      }
      if (reason === "abort") {
        this.notify("notifications/cancelled", {
          requestId: id,
          reason: "aborted",
        }).catch(() => {});
        throw abortError();
      }
      if (reason === "close")
        throw new McpAppError("connect", "The connection was closed.");
      if (error instanceof McpAppError) throw error;
      throw new McpAppError(
        "protocol",
        `Unreadable answer: ${(error as Error).message}`,
      );
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onAbort);
      this.inflight.delete(stopForClose);
    }
  }

  async notify(method: string, params?: Json) {
    const body: Json = { jsonrpc: "2.0", method };
    if (params) body.params = params;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await this.post(body, controller.signal);
      await response.body?.cancel().catch(() => {});
    } finally {
      clearTimeout(timer);
    }
  }

  async close() {
    if (this.closing) return;
    this.closing = true;
    for (const stop of [...this.inflight]) stop();
    if (this.sessionId) {
      // Best effort: tell the app the session is over.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1000);
      bypassProxyForLoopback();
      await fetch(this.url, {
        method: "DELETE",
        headers: { "Mcp-Session-Id": this.sessionId },
        signal: controller.signal,
        redirect: "manual",
      })
        .then((response) => response.body?.cancel())
        .catch(() => {});
      clearTimeout(timer);
    }
  }
}

async function readJson(response: Response, id: number): Promise<Json> {
  const parsed = (await response.json()) as unknown;
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const found = list.find((item) => item && (item as Json).id === id);
  if (!found) throw new Error("no response for the request id");
  return found as Json;
}

/** Reads server-sent events until the one carrying this request's answer; the rest is dropped. */
async function readSse(response: Response, id: number): Promise<Json> {
  if (!response.body) throw new Error("empty event stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  const take = (block: string): Json | undefined => {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) return undefined;
    try {
      const message = JSON.parse(data) as Json;
      return message && message.id === id && message.method === undefined
        ? message
        : undefined;
    } catch {
      return undefined;
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: !done });
      let match = /\r?\n\r?\n/.exec(buffer);
      while (match) {
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const found = take(block);
        if (found) return found;
        match = /\r?\n\r?\n/.exec(buffer);
      }
      if (done) {
        const found = buffer.trim() ? take(buffer) : undefined;
        if (found) return found;
        throw new Error("the event stream ended without a response");
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

// ---------------------------------------------------------------------------------------------
// The connection
// ---------------------------------------------------------------------------------------------

/** Cuts a string to at most `limit` bytes of UTF-8 without leaving half a character. */
function cutBytes(text: string, limit: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= limit) return text;
  let end = limit;
  // Back up over continuation bytes so the cut lands on a character boundary.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function kb(base64: unknown): number {
  const length = typeof base64 === "string" ? base64.length : 0;
  return Math.max(1, Math.round((length * 3) / 4 / 1024));
}

/** Text as is; images and audio as a one-line note; a resource as its uri plus its text part. */
function describe(item: unknown): string {
  const part = (item ?? {}) as Json;
  switch (part.type) {
    case "text":
      return typeof part.text === "string" ? part.text : "";
    case "image":
      return `[图片 ${kb(part.data)} KB，已省略]`;
    case "audio":
      return `[音频 ${kb(part.data)} KB，已省略]`;
    case "resource": {
      const resource = (part.resource ?? {}) as Json;
      const uri = typeof resource.uri === "string" ? resource.uri : "";
      const text = typeof resource.text === "string" ? resource.text : "";
      return text ? `[资源 ${uri}]\n${text}` : `[资源 ${uri}，已省略]`;
    }
    case "resource_link":
      return `[资源 ${typeof part.uri === "string" ? part.uri : ""}]`;
    default:
      return `[${typeof part.type === "string" ? part.type : "未知"}内容，已省略]`;
  }
}

function toOutcome(result: unknown): McpCallOutcome {
  if (typeof result !== "object" || result === null) {
    throw new McpAppError("protocol", "tools/call returned no result object.");
  }
  const raw = result as Json;
  const items = Array.isArray(raw.content) ? raw.content : [];
  let truncated = false;
  // One cap for the whole result: structuredContent is measured first and, if it fits, what is
  // left is the text's budget; if it alone is over the cap it is dropped.
  let structured: unknown;
  let budget = RESULT_LIMIT_BYTES;
  if (raw.structuredContent !== undefined) {
    const size = Buffer.byteLength(JSON.stringify(raw.structuredContent) ?? "");
    if (size <= RESULT_LIMIT_BYTES) {
      structured = raw.structuredContent;
      budget -= size;
    } else {
      truncated = true;
    }
  }
  const content: McpCallOutcome["content"] = [];
  for (const item of items) {
    const text = describe(item);
    if (budget <= 0) {
      truncated = true;
      break;
    }
    const kept = cutBytes(text, budget);
    if (kept.length < text.length) truncated = true;
    budget -= Buffer.byteLength(kept);
    content.push({ type: "text", text: kept });
  }
  const outcome: McpCallOutcome = {
    content,
    isError: raw.isError === true,
    truncated,
  };
  if (structured !== undefined) outcome.structuredContent = structured;
  return outcome;
}

class Connection implements McpConnection {
  constructor(
    private transport: Transport,
    private timeouts: Required<Timeouts>,
  ) {}

  get closed() {
    return this.transport.closed;
  }

  async handshake() {
    await this.transport.request(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      },
      this.timeouts.initMs,
    );
    await this.transport.notify("notifications/initialized");
    this.transport.markReady();
  }

  async listTools(signal?: AbortSignal): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const result = (await this.transport.request(
        "tools/list",
        cursor === undefined ? undefined : { cursor },
        this.timeouts.listMs,
        signal,
      )) as { tools?: unknown; nextCursor?: unknown } | null;
      if (!result || !Array.isArray(result.tools)) {
        throw new McpAppError(
          "protocol",
          "tools/list returned no tools array.",
        );
      }
      for (const tool of result.tools) {
        if (tool && typeof (tool as Json).name === "string")
          tools.push(tool as McpTool);
      }
      if (typeof result.nextCursor !== "string" || result.nextCursor === "")
        break;
      cursor = result.nextCursor;
    }
    return tools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    const result = await this.transport.request(
      "tools/call",
      { name, arguments: args },
      this.timeouts.callMs,
      signal,
    );
    return toOutcome(result);
  }

  close() {
    return this.transport.close();
  }
}

/** Starts or reaches the app and finishes the MCP handshake; the caller closes the result. */
export async function connectApp(
  entry: AppEntry,
  opts?: { timeouts?: Timeouts },
): Promise<McpConnection> {
  const timeouts = { ...DEFAULT_TIMEOUTS };
  for (const key of ["initMs", "listMs", "callMs"] as const) {
    const value = opts?.timeouts?.[key];
    if (value !== undefined) timeouts[key] = value;
  }
  const transport: Transport =
    entry.kind === "stdio"
      ? new StdioTransport(entry)
      : new HttpTransport(entry.url);
  const connection = new Connection(transport, timeouts);
  try {
    await connection.handshake();
  } catch (error) {
    await transport.close();
    // Whatever the child wrote to stderr before it failed is the best clue there is.
    if (error instanceof McpAppError && error.stderrTail === undefined) {
      const tail = transport.stderrTail();
      if (tail !== undefined) error.stderrTail = tail;
    }
    throw error;
  }
  return connection;
}
