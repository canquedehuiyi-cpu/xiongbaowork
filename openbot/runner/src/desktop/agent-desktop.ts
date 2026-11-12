import { chmod, mkdir, readdir, rm } from "node:fs/promises";
import { join, win32 } from "node:path";
import {
  AGENT_DESKTOP_VERSION,
  DESKTOP_LIMITS,
  desktopMessage,
} from "../../../shared/desktop-control";
import { DesktopHelperError } from "./host";

/**
 * The calling layer for the agent-desktop CLI (plan docs/plans/2026-11-12-desktop-write.md, Task 7).
 *
 * ONE COMMAND AT A TIME. Every command, and every wipe of the state directory, goes through one
 * queue, so a device never runs two desktop actions at once.
 *
 * A NARROW SURFACE. A fixed set of flags (`FORBIDDEN_AD_ARGS`) never reaches the binary, the child
 * sees only the environment variables in `agentDesktopEnv`, and text for `type` travels on stdin,
 * never on the command line.
 *
 * A PRIVATE STATE DIRECTORY. agent-desktop keeps control names and the plaintext values of
 * non-password fields in `AGENT_DESKTOP_HOME`. It is created 0700 (on Windows: a protected DACL that
 * grants only the current user), and wiped after `idleWipeMs` without a command.
 *
 * FAILURES. An `ok:false` envelope is an `AgentDesktopError`. A timeout, a start failure, an
 * unparsable answer and a rejected argument are `DesktopHelperError`s (the `sent` flag says whether
 * a process was started); an abort is an `AbortError` carrying the same `sent`. A timeout and an
 * abort end the child's whole process tree, as `host.ts` does.
 */

export type AdError = {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  disposition?: { delivery?: string; retry?: string };
  platform_detail?: string;
};

export class AgentDesktopError extends Error {
  readonly code: string;
  readonly exitCode: number;
  /** The CLI says the action was not delivered (`disposition.delivery === "not_delivered"`). */
  readonly notDelivered: boolean;
  /** `details.kind`, or `platform_detail`. */
  readonly detail?: string;
  constructor(error: AdError, exitCode: number) {
    super(error.message);
    this.name = "AgentDesktopError";
    this.code = error.code;
    this.exitCode = exitCode;
    this.notDelivered = error.disposition?.delivery === "not_delivered";
    const kind = error.details?.kind;
    const detail = typeof kind === "string" ? kind : error.platform_detail;
    if (typeof detail === "string") this.detail = detail;
  }
}

export type AdRunOptions = {
  stdin?: string;
  headed?: boolean;
  force?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type AgentDesktopCli = {
  /** Runs one command and returns the envelope's `data`. */
  run(args: readonly string[], opts?: AdRunOptions): Promise<unknown>;
  /** Checks the version and creates the state directory (0700) on first use, once. */
  ensureReady(signal?: AbortSignal): Promise<void>;
  wipeState(): Promise<void>;
  close(): Promise<void>;
};

/** Arguments that never reach the binary. */
export const FORBIDDEN_AD_ARGS: ReadonlySet<string> = new Set([
  "mcp",
  "--trace",
  "--trace-strict",
  "--session",
  "--screenshots",
  "--cdp",
  "--no-attach",
  "--arg",
  "--env",
  "--agent-id",
]);

const ENV_KEEP = [
  "PATH",
  "HOME",
  "USER",
  "USERPROFILE",
  "SystemRoot",
  "windir",
  "TEMP",
  "TMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
] as const;

/** The child's whole environment: a short allow-list, and `AGENT_DESKTOP_HOME` set to `stateDir`. */
export function agentDesktopEnv(
  base: NodeJS.ProcessEnv,
  stateDir: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_KEEP) {
    const value = base[key];
    if (typeof value === "string") env[key] = value;
  }
  env.AGENT_DESKTOP_HOME = stateDir;
  return env;
}

type Child = {
  pid: number;
  exited: Promise<number>;
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  stdin: { write(data: string): unknown; end(): unknown } | null;
  kill(signal?: string): void;
};
type SpawnFn = (cmd: string[], options: Record<string, unknown>) => Child;

/** How long a killed child may take to be gone before the queue is given up on. */
const EXIT_WAIT_MS = 15_000;
const SECURE_DIR_TIMEOUT_MS = 30_000;

function abortError(sent: boolean): Error & { sent: boolean } {
  const error = new Error("The desktop request was aborted.");
  error.name = "AbortError";
  return Object.assign(error, { sent });
}

/** Reads a pipe to the end; `cancel` releases it at once (a timeout or abort must not wait for EOF). */
function collect(stream: ReadableStream<Uint8Array> | null | undefined): {
  text: Promise<string>;
  cancel: () => void;
} {
  if (!stream) return { text: Promise.resolve(""), cancel: () => {} };
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  const text = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        out += decoder.decode(value, { stream: true });
      }
    } catch {
      // Cancelled or the pipe broke: what was read so far is all there is.
    }
    return out + decoder.decode();
  })();
  return {
    text,
    cancel: () => {
      void reader.cancel().catch(() => {});
    },
  };
}

function systemRoot(): string {
  return process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
}

/** Ends the child and everything it started (`taskkill /T /F` on Windows, the process group elsewhere). */
function killTree(child: Child, platform: string): void {
  const { pid } = child;
  if (platform === "win32") {
    try {
      const killer = Bun.spawn(
        [
          win32.join(systemRoot(), "System32", "taskkill.exe"),
          "/PID",
          String(pid),
          "/T",
          "/F",
        ],
        {
          windowsHide: true,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        },
      );
      // A failed tree kill still ends the child itself.
      void killer.exited.then((code) => {
        if (code !== 0) child.kill();
      });
    } catch {
      child.kill();
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

const SECURE_DIR_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$p = $env:XB_AD_STATE_DIR",
  "$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User",
  "$acl = New-Object System.Security.AccessControl.DirectorySecurity",
  "$acl.SetAccessRuleProtection($true, $false)",
  "$acl.SetOwner($sid)",
  "$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')",
  "$acl.AddAccessRule($rule)",
  "Set-Acl -LiteralPath $p -AclObject $acl",
].join("; ");

/**
 * Windows: gives `dir` a protected DACL that grants only the current user FullControl, with nothing
 * inherited. agent-desktop's `snapshot` refuses a state directory whose DACL names anyone else. The
 * path is passed in an environment variable, never spliced into the script.
 */
export async function secureWindowsStateDir(dir: string): Promise<void> {
  const powershell = win32.join(
    systemRoot(),
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const proc = Bun.spawn(
    [
      powershell,
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      SECURE_DIR_SCRIPT,
    ],
    {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
      windowsHide: true,
      env: { ...agentDesktopEnv(process.env, dir), XB_AD_STATE_DIR: dir },
    },
  );
  const stderr = new Response(proc.stderr).text();
  const timer = setTimeout(() => proc.kill(), SECURE_DIR_TIMEOUT_MS);
  try {
    const code = await proc.exited;
    if (code !== 0) {
      const tail = (await stderr).trim().slice(-500);
      throw new Error(`退出码 ${code}${tail ? `：${tail}` : ""}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

function startFailed(detail: string): DesktopHelperError {
  return new DesktopHelperError(
    "start_failed",
    desktopMessage("start_failed", detail),
    false,
  );
}

export function createAgentDesktopCli(opts: {
  binary: string;
  stateDir: string;
  platform?: string;
  spawn?: typeof Bun.spawn;
  now?: () => number;
  idleWipeMs?: number;
  onIdleWipe?: () => void;
  /** Windows only: protects the state directory (default: `secureWindowsStateDir`). */
  secureDir?: (dir: string) => Promise<void>;
  /** How long a killed child may take to exit (default 15 s); a test hook. */
  exitWaitMs?: number;
}): AgentDesktopCli {
  const { binary, stateDir } = opts;
  const platform = opts.platform ?? process.platform;
  const spawn = (opts.spawn ?? Bun.spawn) as unknown as SpawnFn;
  const now = opts.now ?? Date.now;
  const idleWipeMs = opts.idleWipeMs ?? DESKTOP_LIMITS.adIdleWipeMs;
  const secureDir = opts.secureDir ?? secureWindowsStateDir;
  const exitWaitMs = opts.exitWaitMs ?? EXIT_WAIT_MS;

  let tail: Promise<unknown> = Promise.resolve();
  let ready = false;
  let closed = false;
  let current: Child | undefined;
  let busy = 0;
  /** A killed child did not exit in time: nothing more runs, so nothing can overlap it. */
  let stuck = false;
  let lastEnd = now();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  /** The killed child of the request in flight, if any, that the queue must wait for. */
  type Ctx = { drain?: Promise<void> };

  /**
   * Runs `task` after everything queued before it. `touch: false` is for a wipe: it leaves nothing
   * for the idle timer to wipe again. A `signal` that aborts while the request still waits rejects it
   * at once (`sent: false`) and takes it out of the queue's way. The next request starts only once
   * this one's killed child (if it killed one) has exited.
   */
  const enqueue = <T>(
    task: (ctx: Ctx) => Promise<T>,
    touch = true,
    signal?: AbortSignal,
  ): Promise<T> => {
    busy++;
    const prev = tail;
    const ctx: Ctx = {};
    const result = (async () => {
      let onAbort: (() => void) | undefined;
      try {
        const waiting = new Promise<never>((_, reject) => {
          if (!signal) return;
          if (signal.aborted) return reject(abortError(false));
          onAbort = () => reject(abortError(false));
          signal.addEventListener("abort", onAbort, { once: true });
        });
        await Promise.race([prev, waiting]);
      } catch (error) {
        busy--;
        throw error;
      } finally {
        if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      }
      try {
        if (stuck)
          throw new DesktopHelperError(
            "failed",
            desktopMessage("failed", "上一条桌面命令没能结束"),
            false,
          );
        return await task(ctx);
      } finally {
        busy--;
        if (touch) {
          lastEnd = now();
          armIdle(idleWipeMs);
        }
      }
    })();
    tail = Promise.all([
      prev,
      result.then(
        () => ctx.drain,
        () => ctx.drain,
      ),
    ]).then(() => {});
    return result;
  };

  const emptyDir = async (dir: string) => {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names)
      await rm(join(dir, name), { recursive: true, force: true });
  };

  const wipe = () => emptyDir(stateDir);

  const armIdle = (ms: number) => {
    if (idleTimer) clearTimeout(idleTimer);
    if (closed || idleWipeMs <= 0) return;
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      if (closed || busy > 0) return; // the task that ends re-arms the timer
      const rest = idleWipeMs - (now() - lastEnd);
      if (rest > 0) return armIdle(rest);
      void enqueue(async () => {
        await wipe();
        opts.onIdleWipe?.();
      }, false).catch(() => {});
    }, ms);
    idleTimer.unref?.();
  };

  /** Resolves when a killed child is gone; if it is not within the cap, the queue is given up on. */
  const drainOf = async (child: Child): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const gone = await Promise.race([
      child.exited.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), exitWaitMs);
      }),
    ]);
    clearTimeout(timer);
    if (!gone) stuck = true;
  };

  /** Spawns the binary once and reads its single envelope. Not queued. */
  const exec = async (
    args: readonly string[],
    o: AdRunOptions,
    ctx: Ctx,
  ): Promise<unknown> => {
    const { signal } = o;
    if (signal?.aborted) throw abortError(false);
    const argv = [
      ...(o.headed ? ["--headed"] : []),
      ...args,
      ...(o.force ? ["--force"] : []),
    ];
    let child: Child;
    try {
      child = spawn([binary, ...argv], {
        stdin: o.stdin !== undefined ? "pipe" : "ignore",
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
        detached: platform !== "win32",
        env: agentDesktopEnv(process.env, stateDir),
      });
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT")
        throw startFailed("没有找到 agent-desktop");
      throw startFailed(
        error instanceof Error ? error.message : "无法启动 agent-desktop",
      );
    }
    current = child;
    const stdout = collect(child.stdout);
    const stderr = collect(child.stderr);
    if (o.stdin !== undefined && child.stdin) {
      try {
        child.stdin.write(o.stdin);
        child.stdin.end();
      } catch {
        // The child went away first; its exit says why.
      }
    }
    const timeoutMs =
      o.timeoutMs ??
      (args[0] === "snapshot"
        ? DESKTOP_LIMITS.adSnapshotTimeoutMs
        : DESKTOP_LIMITS.adCommandTimeoutMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const interrupted = new Promise<"timeout" | "abort">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
      if (signal) {
        onAbort = () => resolve("abort");
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
    try {
      // The output is read inside the race: a descendant that keeps the pipe open after the CLI
      // exits must not hold the queue past the deadline or an abort.
      const outcome = await Promise.race([
        Promise.all([child.exited, stdout.text, stderr.text]).then(
          ([code, out, err]) => ({ code, out, err }),
        ),
        interrupted,
      ]);
      if (outcome === "timeout" || outcome === "abort") {
        killTree(child, platform);
        stdout.cancel();
        stderr.cancel();
        ctx.drain = drainOf(child);
        if (outcome === "abort") throw abortError(true);
        throw new DesktopHelperError(
          "timeout",
          desktopMessage("timeout", String(Math.round(timeoutMs / 1000))),
          true,
        );
      }
      const exitCode = outcome.code;
      if (closed) throw abortError(true);
      const text = outcome.out;
      if (exitCode === 2)
        throw new DesktopHelperError(
          "failed",
          desktopMessage("failed", "INVALID_ARGS"),
          false,
          outcome.err.trim().slice(-4096) || undefined,
        );
      let envelope: unknown;
      try {
        envelope = JSON.parse(text.trim());
      } catch {
        throw new DesktopHelperError(
          "failed",
          desktopMessage("failed", "agent-desktop 的输出不是有效的 JSON"),
          true,
          outcome.err.trim().slice(-4096) || undefined,
        );
      }
      const env = envelope as {
        ok?: unknown;
        data?: unknown;
        error?: AdError;
      } | null;
      if (
        env === null ||
        typeof env !== "object" ||
        typeof env.ok !== "boolean"
      )
        throw new DesktopHelperError(
          "failed",
          desktopMessage("failed", "agent-desktop 的输出不是有效的信封"),
          true,
        );
      if (!env.ok) {
        const error = env.error;
        if (!error || typeof error.code !== "string")
          throw new DesktopHelperError(
            "failed",
            desktopMessage("failed", "agent-desktop 的错误信封缺少错误码"),
            true,
          );
        throw new AgentDesktopError(
          { ...error, message: String(error.message ?? "") },
          exitCode,
        );
      }
      return env.data;
    } finally {
      if (timer) clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      if (current === child) current = undefined;
    }
  };

  /** Starts from nothing: whatever an earlier run left (control names, values, an old DACL) goes. */
  const ensureDir = async () => {
    await rm(stateDir, { recursive: true, force: true });
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    if (platform !== "win32") await chmod(stateDir, 0o700);
  };

  const prepare = async (
    ctx: Ctx,
    signal?: AbortSignal,
    timeoutMs?: number,
  ) => {
    if (closed) throw abortError(false);
    if (ready) return;
    try {
      await ensureDir();
    } catch (error) {
      throw startFailed(
        `无法创建状态目录：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (platform === "win32") {
      try {
        await secureDir(stateDir);
      } catch (error) {
        throw startFailed(
          `无法保护状态目录的访问权限：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    let data: unknown;
    try {
      data = await exec(["version"], { signal, timeoutMs }, ctx);
    } catch (error) {
      if (error instanceof AgentDesktopError)
        throw startFailed(error.detail ?? error.message);
      throw error;
    }
    const actual = (data as { version?: unknown } | null)?.version;
    if (actual !== AGENT_DESKTOP_VERSION)
      throw startFailed(`版本不对：${String(actual)}`);
    ready = true;
  };

  /** Whatever stopped before the requested command started never sent it. */
  const unsent = (error: unknown): never => {
    if (error && typeof error === "object" && "sent" in error)
      (error as { sent: boolean }).sent = false;
    throw error;
  };

  return {
    run(callerArgs, callerOptions = {}) {
      // Private copies, taken now: what is checked here is exactly what runs later, whatever the
      // caller does to its own array or options while the command waits in the queue.
      const args = [...callerArgs];
      const o: AdRunOptions = { ...callerOptions };
      for (const arg of args) {
        const bad = [...FORBIDDEN_AD_ARGS].find(
          (f) => arg === f || (f.startsWith("--") && arg.startsWith(`${f}=`)),
        );
        if (bad !== undefined)
          return Promise.reject(
            new DesktopHelperError(
              "failed",
              desktopMessage("failed", `不允许的参数：${bad}`),
              false,
            ),
          );
      }
      return enqueue(
        async (ctx) => {
          await prepare(ctx, o.signal, o.timeoutMs).catch(unsent);
          return exec(args, o, ctx);
        },
        true,
        o.signal,
      );
    },
    ensureReady(signal) {
      return enqueue((ctx) => prepare(ctx, signal).catch(unsent), true, signal);
    },
    wipeState() {
      return enqueue(wipe, false);
    },
    async close() {
      closed = true;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = undefined;
      if (current) {
        killTree(current, platform);
        await drainOf(current);
      }
      await tail;
      await wipe();
    },
  };
}
