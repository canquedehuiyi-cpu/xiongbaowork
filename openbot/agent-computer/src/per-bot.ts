import { createHash } from "node:crypto";

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
