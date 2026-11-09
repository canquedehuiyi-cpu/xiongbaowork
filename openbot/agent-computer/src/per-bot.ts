import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

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

/** One call of the root helper: `ensure <botKey>` here, `run` from the shell. */
export type HelperRunner = (
  args: string[],
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
export const sudoHelper: HelperRunner = (args) =>
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
    const timer = setTimeout(() => child.kill("SIGKILL"), HELPER_TIMEOUT_MS);
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
}) {
  const { workspaceRoot, defaultBotId, enabled } = options;
  const helper = options.helper ?? sudoHelper;
  const shared = createWorkspace(workspaceRoot);
  const workspaces = new Map<string, ReturnType<typeof createWorkspace>>();
  const ensured = new Map<string, Promise<void>>();
  let probe:
    | Promise<{ enabled: boolean; ready: boolean; reason?: string }>
    | undefined;

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
    await ensureKey(botKeyOf(botId));
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
     * Whether an employee could be given its own user now, asked of the helper once and remembered.
     * Switched off, there is nothing to be ready for.
     */
    status(): Promise<{ enabled: boolean; ready: boolean; reason?: string }> {
      if (!enabled) return Promise.resolve({ enabled: false, ready: true });
      probe ??= (async () => {
        try {
          await ensureKey(botKeyOf(PROBE_BOT_ID));
          return { enabled: true, ready: true };
        } catch (error) {
          return {
            enabled: true,
            ready: false,
            reason:
              error instanceof PerBotUnavailableError
                ? error.reason
                : String(error),
          };
        }
      })();
      return probe;
    },
  };
}

export type PerBotComputer = ReturnType<typeof createPerBotComputer>;
