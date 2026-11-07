import type { AppEntry, createAppRegistry } from "./apps";
import {
  connectApp,
  type McpCallOutcome,
  McpAppError,
  type McpConnection,
  type McpTool,
} from "./mcp-client";

/**
 * Keeps the owner's local apps connected for the device-side MCP bridge (spec §3.2, §5).
 *
 * LAZY, REUSED, IDLE-CLOSED. Nothing is started until an app is first asked for; one connection per
 * app is then reused, and closed after `idleMs` (10 minutes) without use. The next use reconnects.
 * `closeAll()` is for the runner's exit.
 *
 * ONE THING AT A TIME PER APP. Every operation on an app (connecting, listing, calling) goes through
 * that app's promise chain, so two calls never overlap and an app never sees two requests at once.
 * Different apps run side by side.
 *
 * THE REGISTRY IS READ ON EVERY OPERATION. An app the owner disabled or removed stops working at its
 * next use without restarting the runner, and its connection is closed then. An app whose entry was
 * edited (a new command or url) loses its old connection and gets a fresh one. A connection that has
 * died (`closed`) is replaced the same way.
 *
 * ERRORS. A failure is thrown as an `AppHostError` whose `userMessage` is Chinese and fit to show as
 * it stands. `kind` and `phase` tell the caller what happened and when, and `cause` is the original
 * error, so the layer above can tell a call whose outcome is unknown (kind `timeout` or `connect`,
 * phase `call`) from one that never reached the app. A caller's own abort is NOT wrapped: it passes
 * through as the AbortError it is.
 */

export const IDLE_MS = 600_000;
export const DESCRIPTION_LIMIT_BYTES = 1024;

const DEFAULT_TIMEOUTS = { initMs: 20_000, listMs: 20_000, callMs: 120_000 };

export type AppHostErrorKind =
  | "unavailable" // not registered, or disabled
  | "start" // could not be started, or exited before the handshake finished
  | "connect" // could not be reached, or went away
  | "timeout"
  | "protocol" // answered with something unusable
  | "unknown_tool" // refused here, never sent to the app
  | "failed"; // anything else unexpected

/** Which step failed: setting up the connection, listing the tools, or calling one. */
export type AppHostPhase = "connect" | "list" | "call";

export class AppHostError extends Error {
  /** Chinese, for the owner and the model; the same text as `message`. */
  userMessage: string;
  kind: AppHostErrorKind;
  phase: AppHostPhase;
  /** The error that caused this one (an `McpAppError` for the app's own failures). */
  cause?: unknown;
  constructor(
    kind: AppHostErrorKind,
    phase: AppHostPhase,
    userMessage: string,
    cause?: unknown,
  ) {
    super(userMessage);
    this.name = "AppHostError";
    this.userMessage = userMessage;
    this.kind = kind;
    this.phase = phase;
    this.cause = cause;
  }
}

type Timeouts = { initMs?: number; listMs?: number; callMs?: number };

type State = {
  entry?: AppEntry;
  conn?: McpConnection;
  /** The tool names the connection offered when last listed: what a call is checked against. */
  tools?: McpTool[];
  chain: Promise<unknown>;
  busy: number;
  idle?: ReturnType<typeof setTimeout>;
};

const UNAVAILABLE = "这台电脑上没有这个本机应用，或它已停用。";

/** At most `limit` bytes of UTF-8, never ending inside a character. */
function cutBytes(text: string, limit: number): string {
  if (Buffer.byteLength(text) <= limit) return text;
  let out = "";
  let size = 0;
  for (const char of text) {
    size += Buffer.byteLength(char);
    if (size > limit) break;
    out += char;
  }
  return out;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function createAppHost(
  registry: ReturnType<typeof createAppRegistry>,
  opts?: {
    idleMs?: number;
    connect?: typeof connectApp;
    timeouts?: Timeouts;
  },
): {
  tools(ref: string, signal?: AbortSignal): Promise<McpTool[]>;
  call(
    ref: string,
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpCallOutcome>;
  closeAll(): Promise<void>;
} {
  const idleMs = opts?.idleMs ?? IDLE_MS;
  const timeouts = { ...DEFAULT_TIMEOUTS, ...opts?.timeouts };
  const connect: typeof connectApp = opts?.connect ?? connectApp;
  const states = new Map<string, State>();

  const stateOf = (ref: string): State => {
    let state = states.get(ref);
    if (!state) {
      state = { chain: Promise.resolve(), busy: 0 };
      states.set(ref, state);
    }
    return state;
  };

  const seconds = (ms: number) => Math.max(1, Math.round(ms / 1000));

  /** The owner-facing wording of a failure of the app, per spec §5. */
  function wording(
    entry: AppEntry,
    phase: AppHostPhase,
    error: McpAppError,
  ): { kind: AppHostErrorKind; text: string } {
    const name = entry.name;
    const tail = error.stderrTail?.trim();
    switch (error.kind) {
      case "start":
        return {
          kind: "start",
          text: tail ? `「${name}」启动失败：${tail}` : `「${name}」启动失败。`,
        };
      case "connect":
        if (entry.kind === "http") {
          return {
            kind: "connect",
            text: `连不上「${name}」的本机地址，请确认软件已打开。`,
          };
        }
        // A stdio app that was running and is not any more: it exited after the handshake.
        return {
          kind: "connect",
          text: tail
            ? `「${name}」已意外退出：${tail}`
            : `「${name}」已意外退出。`,
        };
      case "timeout": {
        const ms =
          phase === "call"
            ? timeouts.callMs
            : phase === "list"
              ? timeouts.listMs
              : timeouts.initMs;
        return {
          kind: "timeout",
          text: `「${name}」在 ${seconds(ms)} 秒内没有返回。`,
        };
      }
      case "unknown_tool":
        return { kind: "unknown_tool", text: `「${name}」没有这个工具。` };
      default:
        return {
          kind: "protocol",
          text: `「${name}」返回了无法识别的内容。`,
        };
    }
  }

  function wrap(entry: AppEntry, phase: AppHostPhase, error: unknown): unknown {
    if (isAbort(error) || error instanceof AppHostError) return error;
    if (error instanceof McpAppError) {
      const { kind, text } = wording(entry, phase, error);
      return new AppHostError(kind, phase, text, error);
    }
    return new AppHostError(
      "failed",
      phase,
      `「${entry.name}」出了点问题，没能完成。`,
      error,
    );
  }

  /** Forgets the connection (synchronously, so a later operation cannot pick it up) and closes it. */
  async function drop(state: State) {
    const { conn } = state;
    state.conn = undefined;
    state.tools = undefined;
    if (state.idle) clearTimeout(state.idle);
    state.idle = undefined;
    if (conn) await conn.close().catch(() => {});
  }

  function armIdle(state: State) {
    if (state.idle) clearTimeout(state.idle);
    state.idle = setTimeout(() => {
      state.idle = undefined;
      if (state.busy === 0) void drop(state);
    }, idleMs);
    // An idle timer must never keep the runner alive.
    (state.idle as { unref?: () => void }).unref?.();
  }

  /** Runs `work` after everything queued before it for this app, on a live connection. */
  function run<T>(
    ref: string,
    phase: AppHostPhase,
    work: (conn: McpConnection, entry: AppEntry, state: State) => Promise<T>,
  ): Promise<T> {
    const state = stateOf(ref);
    state.busy += 1;
    const task = state.chain.then(async () => {
      if (state.idle) clearTimeout(state.idle);
      state.idle = undefined;
      try {
        const entry = registry.byRef(ref);
        if (!entry?.enabled) {
          await drop(state);
          throw new AppHostError("unavailable", "connect", UNAVAILABLE);
        }
        if (
          state.conn &&
          (state.conn.closed ||
            JSON.stringify(state.entry) !== JSON.stringify(entry))
        ) {
          await drop(state);
        }
        if (!state.conn) {
          try {
            state.conn = await connect(entry, { timeouts });
          } catch (error) {
            throw wrap(entry, "connect", error);
          }
          state.entry = entry;
        }
        const conn = state.conn;
        try {
          return await work(conn, entry, state);
        } catch (error) {
          // A connection the failure left dead is not kept for the next use.
          if (conn.closed && state.conn === conn) await drop(state);
          throw wrap(entry, phase, error);
        }
      } finally {
        state.busy -= 1;
        if (state.conn && state.busy === 0) armIdle(state);
      }
    });
    state.chain = task.catch(() => {});
    return task;
  }

  async function list(
    conn: McpConnection,
    state: State,
    signal?: AbortSignal,
  ): Promise<McpTool[]> {
    const tools = (await conn.listTools(signal)).map((tool) =>
      tool.description === undefined
        ? tool
        : {
            ...tool,
            description: cutBytes(tool.description, DESCRIPTION_LIMIT_BYTES),
          },
    );
    state.tools = tools;
    return tools;
  }

  return {
    tools: (ref, signal) =>
      run(ref, "list", (conn, _entry, state) => list(conn, state, signal)),

    call: (ref, tool, args, signal) =>
      run(ref, "list", async (conn, entry, state) => {
        const tools = state.tools ?? (await list(conn, state, signal));
        if (!tools.some((known) => known.name === tool)) {
          const names = tools.map((known) => known.name).join("、");
          throw new AppHostError(
            "unknown_tool",
            "call",
            `「${entry.name}」没有名为「${tool}」的工具（已有：${names}）。`,
          );
        }
        // From here the call is on its way to the app: a failure now may have had an effect.
        try {
          return await conn.callTool(tool, args, signal);
        } catch (error) {
          throw wrap(entry, "call", error);
        }
      }),

    async closeAll() {
      const all = [...states.values()];
      await Promise.all(all.map((state) => drop(state)));
    },
  };
}
