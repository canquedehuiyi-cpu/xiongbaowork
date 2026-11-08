import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { win32 } from "node:path";
import { plainPowerShellStderr } from "../../../agent-computer/src/shell";
import {
  DESKTOP_LIMITS,
  type DesktopErrorCode,
} from "../../../shared/desktop-control";

/**
 * Keeps the desktop helper running for `desktop.*` actions (docs/specs/2026-11-07-desktop-control.md
 * §2–§3; plan docs/plans/2026-11-08-desktop-control.md, Task 2).
 *
 * ONE HELPER, LAZY, IDLE-CLOSED. Nothing is spawned until the first request. The helper then serves
 * every request until `idleMs` (10 minutes) pass without one, or until it times out, is aborted, dies
 * or is closed; the next request starts a new one.
 *
 * THE WIRE. The helper prints `{"ready":true,"pid":N,"session":S,"interactive":true}` once it is up,
 * and only then is a request written: `{"id":N,"op":"...",...}` on one line. It answers
 * `{"id":N,"ok":true,"result":{...}}` or `{"id":N,"ok":false,"code":"<DesktopErrorCode>","message":
 * "<details>"}`. Any other stdout line (PowerShell's banners and prompts, a line that is not JSON, one
 * without an id, one whose id is not the request in flight) is dropped. stdout is decoded with a
 * streaming UTF-8 decoder, so a Chinese character cut across two chunks arrives whole.
 *
 * READ ONLY AT THIS LAYER TOO. Only the ops in `ops` (by default `HELPER_OPS`: windows, tree,
 * screenshot) are ever written to the helper. The request is frozen into its wire form the moment
 * `request()` is called (serialised once, copied out of the caller's object), and it is that frozen
 * copy which is checked and, later, written: a caller cannot change the op after the check by
 * mutating its object while the request waits, by a getter that answers differently the second
 * time, or by a `toJSON` of its own. Anything else is refused here as `unsupported`,
 * unsent, without starting a helper. The helper refuses other ops on its own as well; the two locks
 * stand independently.
 *
 * ONE REQUEST AT A TIME. Requests queue and run in order, so the helper never holds two.
 *
 * A NEW PREFIX PER PROCESS. Every helper gets six random hex digits. Snapshot ids are
 * `${prefix}-${n}`, numbered from 1 within that process, so a ref minted by an earlier helper (idled
 * out, crashed, killed) carries a prefix that no longer matches and can be refused as stale.
 *
 * FAILURES are `DesktopHelperError`s with a `code` and `sent`, which says whether the request had
 * been written to the helper's stdin. A timeout, and an abort, end the helper's whole process tree
 * (`taskkill /T /F` on Windows, the process group elsewhere). An abort is not wrapped: it rejects as
 * an `AbortError` carrying the same `sent`. A helper that reports session 0, or no interactive
 * desktop, can never see a window: it is ended, and every request from then on is refused as
 * `session0` without starting another.
 */

export type HelperLaunchSpec = {
  command: string;
  args: string[];
  /** Written to the helper's stdin, followed by `\n`, as soon as it is spawned. */
  preamble?: string;
  /** Added to the runner's own environment. */
  env?: Record<string, string>;
};

export type HelperReady = {
  pid: number;
  session: number;
  interactive: boolean;
};

const READ_OPS: readonly string[] = Object.freeze([
  "windows",
  "tree",
  "screenshot",
]);

/**
 * Every op the host will write to the helper. Others are refused here, and no helper is started.
 * For reading only: each host checks its own private copy, so changing this set changes no host.
 */
export const HELPER_OPS: ReadonlySet<string> = new Set(READ_OPS);

const STDERR_TAIL_BYTES = 4096;
/** Raw stderr kept while it arrives; the tail is cut from this. */
const STDERR_KEEP_CHARS = 65_536;
/** How long close() waits for a killed helper to be gone. */
const CLOSE_WAIT_MS = 3000;
/**
 * The longest stdout line kept while waiting for its newline. A 1280 px PNG in base64 is a few MB;
 * a helper that writes more than this without a newline is broken, and is ended.
 */
const MAX_LINE_CHARS = 32 * 1024 * 1024;

const HELPER_CODES: ReadonlySet<string> = new Set<DesktopErrorCode>([
  "not_windows",
  "no_window",
  "stale",
  "elevated",
  "start_failed",
  "timeout",
  "session0",
  "sensitive",
  "unsupported",
  "failed",
]);

export class DesktopHelperError extends Error {
  code: DesktopErrorCode;
  /** The request had been written to the helper's stdin. */
  sent: boolean;
  /** The last ≤ 4096 bytes of the helper's stderr, with PowerShell's CLIXML taken apart. */
  stderrTail?: string;
  constructor(
    code: DesktopErrorCode,
    message: string,
    sent: boolean,
    stderrTail?: string,
  ) {
    super(message);
    this.name = "DesktopHelperError";
    this.code = code;
    this.sent = sent;
    if (stderrTail !== undefined) this.stderrTail = stderrTail;
  }
}

function abortError(sent: boolean): Error & { sent: boolean } {
  const error = new Error("The desktop request was aborted.");
  error.name = "AbortError";
  return Object.assign(error, { sent });
}

/** The last `limit` bytes of UTF-8 or fewer, never starting inside a character. */
function tailBytes(text: string, limit: number): string {
  if (Buffer.byteLength(text) <= limit) return text;
  const chars = Array.from(text);
  let size = 0;
  let start = chars.length;
  while (start > 0) {
    const next = Buffer.byteLength(chars[start - 1] ?? "");
    if (size + next > limit) break;
    size += next;
    start -= 1;
  }
  return chars.slice(start).join("");
}

function readyOf(message: Record<string, unknown>): HelperReady | undefined {
  if (message.ready !== true) return undefined;
  const { pid, session, interactive } = message;
  if (
    typeof pid !== "number" ||
    typeof session !== "number" ||
    typeof interactive !== "boolean"
  )
    return undefined;
  return { pid, session, interactive };
}

type Pending = {
  id: number;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
};

type Helper = {
  child: ChildProcessWithoutNullStreams;
  prefix: string;
  snapshots: number;
  info?: HelperReady;
  ready: Promise<HelperReady>;
  pending?: Pending;
  stderr: string;
  stopping: boolean;
  exited: boolean;
  closed: Promise<void>;
};

export function createDesktopHost(opts: {
  spec: () => HelperLaunchSpec;
  idleMs?: number;
  startMs?: number;
  timeoutMs?: number;
  /** Ops the host may write to the helper; `HELPER_OPS` unless a probe needs to test the helper itself. */
  ops?: ReadonlySet<string>;
  /** Called whenever a helper process has exited, for whatever reason. */
  onExit?: () => void;
  /** The longest stdout line the host waits for; `MAX_LINE_CHARS` unless a test needs it smaller. */
  maxLineChars?: number;
}): {
  request<T>(
    op: { op: string; [key: string]: unknown },
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<T>;
  /** This helper process's id prefix (six hex digits); undefined while no helper is running. */
  readonly prefix: string | undefined;
  /** The next snapshot id: `${prefix}-${n}`, n from 1, counting within this helper process only. */
  nextSnapshotId(): string;
  readonly running: boolean;
  close(): Promise<void>;
} {
  const idleMs = opts.idleMs ?? DESKTOP_LIMITS.helperIdleMs;
  const startMs = opts.startMs ?? DESKTOP_LIMITS.startTimeoutMs;
  const defaultTimeoutMs = opts.timeoutMs ?? DESKTOP_LIMITS.requestTimeoutMs;
  // Copied, so neither a later change to the caller's set nor to `HELPER_OPS` widens this host.
  const ops: ReadonlySet<string> = new Set(opts.ops ?? READ_OPS);
  const maxLineChars = opts.maxLineChars ?? MAX_LINE_CHARS;

  let current: Helper | undefined;
  /** Set once a helper reported session 0 or no interactive desktop: none ever will. */
  let noDesktop: HelperReady | undefined;
  let queue: Promise<void> = Promise.resolve();
  /** Bumped by close(): requests queued before it are refused instead of starting a new helper. */
  let generation = 0;
  let nextId = 0;
  let idle: ReturnType<typeof setTimeout> | undefined;

  const clearIdle = () => {
    if (idle) clearTimeout(idle);
    idle = undefined;
  };

  const stderrTail = (helper: Helper) =>
    tailBytes(plainPowerShellStderr(helper.stderr), STDERR_TAIL_BYTES);

  /** End the helper's whole process tree. It stops being `current` at once. */
  const stop = (helper: Helper) => {
    if (current === helper) {
      current = undefined;
      clearIdle();
    }
    if (helper.stopping || helper.exited) return;
    helper.stopping = true;
    const { pid } = helper.child;
    if (pid === undefined) return;
    if (process.platform === "win32") {
      const systemRoot =
        process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
      const killer = spawn(
        win32.join(systemRoot, "System32", "taskkill.exe"),
        ["/PID", String(pid), "/T", "/F"],
        { windowsHide: true, stdio: "ignore" },
      );
      // A failed tree kill still ends the helper itself.
      killer.once("error", () => helper.child.kill());
      killer.once("close", (code) => {
        if (code !== 0) helper.child.kill();
      });
      return;
    }
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      helper.child.kill("SIGKILL");
    }
  };

  const start = (): Helper => {
    const spec = opts.spec();
    const child = spawn(spec.command, spec.args, {
      stdio: "pipe",
      windowsHide: true,
      detached: process.platform !== "win32",
      env: spec.env ? { ...process.env, ...spec.env } : process.env,
    });
    let markReady: (info: HelperReady) => void = () => {};
    let failStart: (error: Error) => void = () => {};
    let markClosed: () => void = () => {};
    const helper: Helper = {
      child,
      prefix: randomBytes(3).toString("hex"),
      snapshots: 0,
      ready: new Promise<HelperReady>((resolve, reject) => {
        markReady = resolve;
        failStart = reject;
      }),
      stderr: "",
      stopping: false,
      exited: false,
      closed: new Promise<void>((resolve) => {
        markClosed = resolve;
      }),
    };
    // Whoever waits on it sees the failure; nobody waiting must not be an unhandled rejection.
    helper.ready.catch(() => {});

    const startTimer = setTimeout(() => {
      failStart(
        new DesktopHelperError(
          "start_failed",
          `the desktop helper was not ready within ${startMs} ms`,
          false,
          stderrTail(helper),
        ),
      );
      stop(helper);
    }, startMs);

    const onLine = (line: string) => {
      const text = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (!text.startsWith("{")) return;
      let message: unknown;
      try {
        message = JSON.parse(text);
      } catch {
        return;
      }
      if (typeof message !== "object" || message === null) return;
      const record = message as Record<string, unknown>;
      if (!helper.info) {
        const info = readyOf(record);
        if (!info) return;
        helper.info = info;
        clearTimeout(startTimer);
        markReady(info);
        return;
      }
      const pending = helper.pending;
      if (!pending || record.id !== pending.id) return;
      // An id but no verdict (a request echoed back, say) is not an answer.
      if (record.ok !== true && record.ok !== false) return;
      helper.pending = undefined;
      if (record.ok === true) {
        pending.resolve(record.result);
        return;
      }
      const code =
        typeof record.code === "string" && HELPER_CODES.has(record.code)
          ? (record.code as DesktopErrorCode)
          : "failed";
      const detail =
        typeof record.message === "string"
          ? record.message
          : "the desktop helper reported a failure";
      pending.reject(new DesktopHelperError(code, detail, true));
    };

    const outDecoder = new TextDecoder("utf-8");
    let partial = "";
    /** How much of `partial` is known to hold no newline, so a long line is not rescanned. */
    let scanned = 0;
    let overflowed = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (overflowed) return;
      partial += outDecoder.decode(chunk, { stream: true });
      let at = partial.indexOf("\n", scanned);
      while (at !== -1) {
        const line = partial.slice(0, at);
        partial = partial.slice(at + 1);
        onLine(line);
        at = partial.indexOf("\n");
      }
      scanned = partial.length;
      if (partial.length <= maxLineChars) return;
      overflowed = true;
      partial = "";
      const message = `the desktop helper wrote a line longer than ${maxLineChars} characters`;
      failStart(
        new DesktopHelperError(
          "start_failed",
          message,
          false,
          stderrTail(helper),
        ),
      );
      const pending = helper.pending;
      helper.pending = undefined;
      pending?.reject(new DesktopHelperError("failed", message, true));
      stop(helper);
    });
    const errDecoder = new TextDecoder("utf-8");
    child.stderr.on("data", (chunk: Buffer) => {
      helper.stderr += errDecoder.decode(chunk, { stream: true });
      if (helper.stderr.length > STDERR_KEEP_CHARS)
        helper.stderr = helper.stderr.slice(-STDERR_KEEP_CHARS / 2);
    });
    // A helper that is gone fails the write; its exit is what settles the request.
    child.stdin.on("error", () => {});

    let finished = false;
    const finish = (why: string) => {
      if (finished) return;
      finished = true;
      helper.exited = true;
      clearTimeout(startTimer);
      if (current === helper) {
        current = undefined;
        clearIdle();
      }
      const tail = stderrTail(helper);
      failStart(
        new DesktopHelperError(
          "start_failed",
          `the desktop helper ${why} before it was ready`,
          false,
          tail,
        ),
      );
      const pending = helper.pending;
      helper.pending = undefined;
      pending?.reject(
        new DesktopHelperError(
          "failed",
          `the desktop helper ${why}`,
          true,
          tail,
        ),
      );
      markClosed();
      opts.onExit?.();
    };
    child.once("error", (error) =>
      finish(`could not be started (${error.message})`),
    );
    child.once("close", (code, signal) =>
      finish(
        signal ? `was ended (${signal})` : `exited with code ${String(code)}`,
      ),
    );

    if (spec.preamble !== undefined) child.stdin.write(`${spec.preamble}\n`);
    return helper;
  };

  /** Rejects with an unsent AbortError as soon as `signal` aborts; `cleanup` stops listening. */
  const abortable = (signal: AbortSignal | undefined, onAbort: () => void) => {
    let cleanup = () => {};
    const aborted = new Promise<never>((_, reject) => {
      if (!signal) return;
      const listener = () => {
        onAbort();
        reject(abortError(false));
      };
      signal.addEventListener("abort", listener, { once: true });
      cleanup = () => signal.removeEventListener("abort", listener);
    });
    aborted.catch(() => {});
    return { aborted, cleanup: () => cleanup() };
  };

  const runOne = async <T>(
    /** The frozen request without its id: a serialised JSON object, `{"op":...}`. */
    body: string,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<T> => {
    if (noDesktop)
      throw new DesktopHelperError(
        "session0",
        `the desktop helper runs in session ${noDesktop.session} without an interactive desktop`,
        false,
      );
    clearIdle();
    const helper = current ?? start();
    current = helper;

    // Up and ready, or not at all.
    const waiting = abortable(signal, () => stop(helper));
    let info: HelperReady;
    try {
      info = await Promise.race([helper.ready, waiting.aborted]);
    } finally {
      waiting.cleanup();
    }
    if (info.session === 0 || !info.interactive) {
      noDesktop = info;
      stop(helper);
      throw new DesktopHelperError(
        "session0",
        `the desktop helper runs in session ${info.session} without an interactive desktop`,
        false,
      );
    }
    if (helper.exited || helper.stopping)
      throw new DesktopHelperError(
        "failed",
        "the desktop helper exited",
        false,
        stderrTail(helper),
      );

    const id = ++nextId;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      return await new Promise<T>((resolve, reject) => {
        helper.pending = {
          id,
          resolve: (result) => resolve(result as T),
          reject,
        };
        const give = (error: Error) => {
          if (helper.pending?.id !== id) return;
          helper.pending = undefined;
          reject(error);
          stop(helper);
        };
        timer = setTimeout(
          () =>
            give(
              new DesktopHelperError(
                "timeout",
                `the desktop helper did not answer within ${timeoutMs} ms`,
                true,
              ),
            ),
          timeoutMs,
        );
        onAbort = () => give(abortError(true));
        signal?.addEventListener("abort", onAbort, { once: true });
        // The id goes in front of the frozen body; nothing of the caller's is serialised here.
        helper.child.stdin.write(`{"id":${id},${body.slice(1)}\n`);
      });
    } finally {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  };

  const scheduleIdle = () => {
    clearIdle();
    const helper = current;
    if (!helper) return;
    idle = setTimeout(() => stop(helper), idleMs);
    // The helper's own pipes keep the runner's event loop alive while it runs, so this does not let
    // the runner exit early; the runner's shutdown calls close(). It only keeps the timer itself
    // from being a reason to stay.
    idle.unref?.();
  };

  return {
    request<T>(
      op: { op: string; [key: string]: unknown },
      requestOpts?: { signal?: AbortSignal; timeoutMs?: number },
    ): Promise<T> {
      // Frozen now: what is checked below is exactly what will be written.
      let wire: unknown;
      try {
        wire = JSON.parse(JSON.stringify(op));
      } catch {
        return Promise.reject(
          new DesktopHelperError(
            "failed",
            "the desktop request is not JSON",
            false,
          ),
        );
      }
      if (
        typeof wire !== "object" ||
        wire === null ||
        Array.isArray(wire) ||
        typeof (wire as { op?: unknown }).op !== "string" ||
        !ops.has((wire as { op: string }).op)
      )
        return Promise.reject(
          new DesktopHelperError(
            "unsupported",
            `unsupported op: ${String((wire as { op?: unknown } | null)?.op)}`,
            false,
          ),
        );
      // The host numbers requests itself; a caller's id is never written.
      const { id: _callerId, ...fields } = wire as Record<string, unknown>;
      const body = JSON.stringify(fields);
      const signal = requestOpts?.signal;
      if (signal?.aborted) return Promise.reject(abortError(false));
      const timeoutMs = requestOpts?.timeoutMs ?? defaultTimeoutMs;
      const enqueued = generation;

      // Waiting for its turn: an abort here leaves the queue without touching the helper.
      const waiting = abortable(signal, () => {});
      let skip = false;
      waiting.aborted.catch(() => {
        skip = true;
      });
      const turn = queue.then(async () => {
        waiting.cleanup();
        if (skip || signal?.aborted) throw abortError(false);
        if (enqueued !== generation)
          throw new DesktopHelperError(
            "failed",
            "the desktop helper was closed before this request ran",
            false,
          );
        try {
          return await runOne<T>(body, signal, timeoutMs);
        } finally {
          scheduleIdle();
        }
      });
      queue = turn.then(
        () => {},
        () => {},
      );
      return Promise.race([turn, waiting.aborted]);
    },
    get prefix() {
      const helper = current;
      return helper?.info && !helper.exited ? helper.prefix : undefined;
    },
    nextSnapshotId() {
      const helper = current;
      if (!helper?.info || helper.exited)
        throw new Error("The desktop helper is not running.");
      helper.snapshots += 1;
      return `${helper.prefix}-${helper.snapshots}`;
    },
    get running() {
      return current !== undefined && !current.exited;
    },
    async close() {
      generation += 1;
      clearIdle();
      const helper = current;
      if (!helper) return;
      stop(helper);
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        helper.closed,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, CLOSE_WAIT_MS);
        }),
      ]);
      clearTimeout(timer);
    },
  };
}
