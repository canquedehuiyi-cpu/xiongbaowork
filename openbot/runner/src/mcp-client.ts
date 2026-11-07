import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
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
 *   connect       the app could not be reached (http), or went away after the handshake
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
  kind: "start" | "connect" | "timeout" | "protocol" | "unknown_tool";
  stderrTail?: string;
  constructor(kind: McpAppError["kind"], message: string, stderrTail?: string) {
    super(message);
    this.name = "McpAppError";
    this.kind = kind;
    if (stderrTail !== undefined) this.stderrTail = stderrTail;
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

/**
 * How to start a stdio app. On Windows the usual commands (`npx`, `bunx`, `uvx`) are `.cmd` shims
 * that `spawn` cannot run directly (ENOENT), so the whole command goes through
 * `cmd.exe /d /s /c "<each part quoted>"`. With `/s`, cmd drops the first and last quote of that
 * line and runs the rest, hence the extra outer pair; `windowsVerbatimArguments` stops Node from
 * quoting that line a second time. Elsewhere the command and its arguments are used as they are.
 * Pure: the platform and the environment are passed in so both branches can be tested anywhere.
 */
export function launchSpec(
  entry: AppEntry,
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
): { command: string; args: string[]; windowsVerbatimArguments?: boolean } {
  if (entry.kind !== "stdio") throw new Error("Only a stdio app is launched.");
  if (platform !== "win32") {
    return { command: entry.command, args: entry.args };
  }
  const line = [entry.command, ...entry.args].map(quoteForCmd).join(" ");
  return {
    command: env.ComSpec ?? env.COMSPEC ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    windowsVerbatimArguments: true,
  };
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
    const spec = launchSpec(entry, process.platform, process.env);
    if (entry.kind !== "stdio") throw new Error("stdio entry expected");
    this.child = spawn(spec.command, spec.args, {
      cwd: entry.cwd,
      env: childEnv(process.env, entry.env),
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
    try {
      response = await fetch(this.url, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      this.lost = true;
      throw new McpAppError(
        "connect",
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
      await fetch(this.url, {
        method: "DELETE",
        headers: { "Mcp-Session-Id": this.sessionId },
        signal: controller.signal,
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
