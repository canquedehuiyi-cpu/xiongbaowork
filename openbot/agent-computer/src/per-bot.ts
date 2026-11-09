import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { createShell, type Shell } from "./shell";
import { createWorkspace } from "./workspace";

/**
 * Each employee its own computer, inside one shared container.
 *
 * WHY. The one-container image runs a single agent-computer process for every employee and tenant.
 * Without this, the file tools of one employee see another's files and every command runs as the same
 * Linux user. With `COMPUTER_PER_BOT_USERS=on`, an employee other than the default one gets its own
 * directory under `<workspace>/bots/<botKey>` and its commands run as its own Linux user `xb-<botKey>`.
 *
 * WHY A HASH. The bot id arrives in a request header and can be long, carry capitals, or anything
 * else; a Linux user name cannot. Twelve hex digits of sha256 always fit the user-name rules and
 * never carry the raw id into a path, so `a/../b` cannot address anything but its own directory.
 *
 * THE DEFAULT EMPLOYEE (`COMPUTER_BOT_ID`, `shared` unless configured) and every call without the
 * header keep the workspace root and the computer's own user, so existing data stays where it is.
 */

/** The hash part of `xb-<botKey>`: the first twelve hex digits of sha256(botId). */
export function botKeyOf(botId: string): string {
  return createHash("sha256").update(botId).digest("hex").slice(0, 12);
}

/** On only where it can work: Linux, with the switch set to `on`. */
export function perBotUsersEnabled(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): boolean {
  return (
    env.COMPUTER_PER_BOT_USERS?.trim().toLowerCase() === "on" &&
    platform === "linux"
  );
}

/** Whether this employee's calls go to its own Linux user rather than the shared one. */
export function usesOwnUser(
  botId: string,
  defaultBotId: string,
  enabled: boolean,
): boolean {
  return enabled && botId !== defaultBotId;
}

/** The root of this employee's files and the directory its commands start in. */
export function botHome(
  workspaceRoot: string,
  botId: string,
  defaultBotId: string,
  enabled: boolean,
): string {
  return usesOwnUser(botId, defaultBotId, enabled)
    ? `${workspaceRoot}/bots/${botKeyOf(botId)}`
    : workspaceRoot;
}

/** Where the root helper lives in the image. Root-owned, 0755, reachable only through sudo. */
export const XB_BOT_HELPER = "/usr/local/sbin/xb-bot";

/**
 * The workspace the helper is written for: it creates `/workspace/bots/<key>` and runs commands
 * there, whatever this process was told. Per-employee mode is only coherent on the same root.
 */
export const XB_BOT_WORKSPACE = "/workspace";

/** One call of the root helper: `ensure <botKey>` here, `run` from the shell. */
export type HelperRunner = (
  args: string[],
  options?: { timeoutMs?: number },
) => Promise<{ code: number; stdout: string; stderr: string }>;

/**
 * The computer cannot give this employee its own user right now.
 *
 * Answered as a 503 rather than falling back to the shared user: an employee that silently ran as the
 * shared user would see every other employee's files, which is the thing this exists to prevent.
 */
export class PerBotUnavailableError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`员工独立电脑未就绪：${reason}`);
    this.name = "PerBotUnavailableError";
    this.reason = reason;
  }
}

/** How long one `ensure` may take. Creating a user and three directories is well under a second. */
const HELPER_TIMEOUT_MS = 30_000;

/** `sudo -n`: never a password prompt, which nobody is there to answer. */
export const sudoHelper: HelperRunner = (args, options = {}) =>
  new Promise((resolve) => {
    const child = spawn("sudo", ["-n", XB_BOT_HELPER, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const timer = setTimeout(
      () => child.kill("SIGKILL"),
      options.timeoutMs ?? HELPER_TIMEOUT_MS,
    );
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr || error.message });
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        code: code ?? -1,
        stdout,
        stderr: stderr || (signal ? `辅助程序被信号 ${signal} 终止` : ""),
      });
    });
  });

/** What the helper said, as one line a person can act on. */
function helperReason(result: { code: number; stderr: string }): string {
  const said = result.stderr.trim().split("\n").filter(Boolean).pop();
  return said
    ? `${said}（退出码 ${result.code}）`
    : `辅助程序退出码 ${result.code}`;
}

/** The key the readiness probe ensures. One extra empty user and directory, created once. */
const PROBE_BOT_ID = "__probe__";

/** /health waits this long for the probe, and no longer. */
const PROBE_TIMEOUT_MS = 5_000;

/**
 * How long a failed probe is believed. Long enough that /health, which needs no token, cannot be used
 * to start a root process per request; short enough that one failure at start-up (two `useradd`s
 * racing for the passwd lock) is not an unready computer until it restarts.
 */
const PROBE_FAILURE_TTL_MS = 30_000;

/**
 * What /health says when the helper cannot be used. /health is open to anyone who can reach the
 * port, so the helper's own words (sudo's error, a path) go to the log rather than into the answer.
 */
const HELPER_UNAVAILABLE = "员工独立电脑的辅助程序不可用";

const WRONG_WORKSPACE = `每员工模式要求工作目录为 ${XB_BOT_WORKSPACE}`;

/**
 * The helper's own refusals from `run`, before any command starts. A command that exits 64 or 65
 * itself reads the same way; the helper's protocol has no other signal, and a refusal mistaken for a
 * command's answer is the worse error of the two.
 */
const HELPER_REFUSED: Record<number, string> = {
  64: "辅助程序拒绝了这次调用（退出码 64：参数不合法）",
  65: "员工的系统用户不存在（退出码 65）",
};

export type PerBotStatus = {
  enabled: boolean;
  ready: boolean;
  reason?: string;
};

/**
 * The files of every employee on this computer, and the preparation an employee's own user needs.
 *
 * Instances are cached by botKey: a root is fixed for the life of the process, and a cached workspace
 * costs nothing. Only a successful `ensure` is remembered, so a helper that was missing a moment ago
 * is asked again rather than holding the employee out until a restart.
 */
export function createPerBotComputer(options: {
  workspaceRoot: string;
  defaultBotId: string;
  enabled: boolean;
  helper?: HelperRunner;
  /** What an employee's command is handed to; the shell's own default (`sudo -n xb-bot`) if unset. */
  launcher?: string[];
  /**
   * The workspace root the helper works in. When given and the workspace is elsewhere, nobody gets
   * their own user: files would land in one directory and commands run in another.
   */
  helperRoot?: string;
  /** For tests: the clock the probe's failure is timed by, and where the helper's own words go. */
  now?: () => number;
  log?: (detail: string) => void;
}) {
  const { workspaceRoot, defaultBotId, enabled, launcher } = options;
  const helper = options.helper ?? sudoHelper;
  const now = options.now ?? Date.now;
  const log =
    options.log ??
    ((detail: string) =>
      console.warn(
        JSON.stringify({ type: "computer-per-bot-users-unready", detail }),
      ));
  const wrongWorkspace =
    enabled &&
    options.helperRoot !== undefined &&
    resolve(workspaceRoot) !== resolve(options.helperRoot);
  const shared = createWorkspace(workspaceRoot);
  // Rooted in the same workspace the file tools use, so a command and a written file see one
  // directory rather than two.
  const sharedShell = createShell(workspaceRoot);
  const workspaces = new Map<string, ReturnType<typeof createWorkspace>>();
  const shells = new Map<string, Shell>();
  const ensured = new Map<string, Promise<void>>();
  // Ready is remembered for good; a failure until `failedAt + PROBE_FAILURE_TTL_MS`.
  let ready = false;
  let failedAt: number | undefined;
  let probing: Promise<PerBotStatus> | undefined;

  const ensureKey = (key: string): Promise<void> => {
    const known = ensured.get(key);
    if (known) return known;
    const attempt = (async () => {
      let result: Awaited<ReturnType<HelperRunner>>;
      try {
        result = await helper(["ensure", key]);
      } catch (error) {
        throw new PerBotUnavailableError(
          error instanceof Error ? error.message : String(error),
        );
      }
      if (result.code !== 0)
        throw new PerBotUnavailableError(helperReason(result));
      // An employee prepared is the probe's question answered.
      ready = true;
    })();
    ensured.set(key, attempt);
    // Forgotten on failure, so the next call asks again.
    attempt.catch(() => {
      if (ensured.get(key) === attempt) ensured.delete(key);
    });
    return attempt;
  };

  const homeFor = (botId: string): string =>
    botHome(workspaceRoot, botId, defaultBotId, enabled);

  /** A no-op for the default employee and with the switch off: they have no user to prepare. */
  const ensure = async (botId: string): Promise<void> => {
    if (!usesOwnUser(botId, defaultBotId, enabled)) return;
    if (wrongWorkspace) throw new PerBotUnavailableError(WRONG_WORKSPACE);
    await ensureKey(botKeyOf(botId));
  };

  /** One question to the helper, bounded, answered as /health may repeat it. */
  const probe = async (): Promise<PerBotStatus> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<{ code: number; stderr: string }>((done) => {
      timer = setTimeout(
        () =>
          done({
            code: -1,
            stderr: `探测超时（${PROBE_TIMEOUT_MS / 1000} 秒）`,
          }),
        PROBE_TIMEOUT_MS,
      );
    });
    let detail: string | undefined;
    try {
      const result = await Promise.race([
        helper(["ensure", botKeyOf(PROBE_BOT_ID)], {
          timeoutMs: PROBE_TIMEOUT_MS,
        }),
        timedOut,
      ]);
      if (result.code !== 0) detail = helperReason(result);
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timer);
    }
    if (detail === undefined) {
      ready = true;
      return { enabled: true, ready: true };
    }
    if (ready) return { enabled: true, ready: true };
    failedAt = now();
    log(detail);
    return { enabled: true, ready: false, reason: HELPER_UNAVAILABLE };
  };

  return {
    homeFor,
    ensure,
    async workspaceFor(
      botId: string,
    ): Promise<ReturnType<typeof createWorkspace>> {
      if (!usesOwnUser(botId, defaultBotId, enabled)) return shared;
      await ensure(botId);
      const key = botKeyOf(botId);
      let workspace = workspaces.get(key);
      if (!workspace) {
        workspace = createWorkspace(homeFor(botId));
        workspaces.set(key, workspace);
      }
      return workspace;
    },
    /**
     * The shell an employee's commands run in: the shared one for the default employee, otherwise
     * one that hands each command to the helper to run as the employee's own user.
     */
    async shellFor(botId: string): Promise<Shell> {
      if (!usesOwnUser(botId, defaultBotId, enabled)) return sharedShell;
      await ensure(botId);
      const key = botKeyOf(botId);
      let shell = shells.get(key);
      if (!shell) {
        const runAs = createShell(homeFor(botId), process.env, {
          runAs: { key, ...(launcher ? { launcher } : {}) },
        });
        shell = {
          async run(input) {
            const result = await runAs.run(input);
            if (result.timedOut || result.stopped) return result;
            const refused = HELPER_REFUSED[result.exitCode];
            if (refused === undefined) return result;
            // The user is gone, so the next call prepares it again rather than trusting the cache.
            if (result.exitCode === 65) ensured.delete(key);
            throw new PerBotUnavailableError(refused);
          },
        };
        shells.set(key, shell);
      }
      return shell;
    },
    /**
     * Whether an employee could be given its own user now. Switched off, there is nothing to be ready
     * for. A success is remembered for good, a failure for 30 seconds, and callers at the same moment
     * share one probe.
     */
    async status(): Promise<PerBotStatus> {
      if (!enabled) return { enabled: false, ready: true };
      if (wrongWorkspace)
        return { enabled: true, ready: false, reason: WRONG_WORKSPACE };
      if (ready) return { enabled: true, ready: true };
      if (failedAt !== undefined && now() - failedAt < PROBE_FAILURE_TTL_MS)
        return { enabled: true, ready: false, reason: HELPER_UNAVAILABLE };
      probing ??= probe().finally(() => {
        probing = undefined;
      });
      return probing;
    },
  };
}

export type PerBotComputer = ReturnType<typeof createPerBotComputer>;
