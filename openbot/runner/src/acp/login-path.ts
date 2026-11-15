import { type ProbeResult, runProbe } from "./discover";

/**
 * The PATH the owner's own terminal has, for the ACP paths only (agent discovery and the adapter's
 * environment; MCP apps are not touched). On macOS an app opened from Finder or the Dock inherits
 * launchd's short PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), so `codex`, `claude`, `hermes` and `npx`
 * installed through Homebrew, npm or `~/.local/bin` would look absent and the npx adapters could
 * not start. Linux desktop sessions can miss what a login shell's profile adds in the same way.
 *
 * On darwin and linux the owner's login shell (`$SHELL`, else zsh on macOS) is asked: `$SHELL -ilc`
 * printing PATH between two markers with the external `printenv`, which reads the exported variable
 * whatever the shell's syntax is (fish included). Only the one line between the markers is
 * believed, and only when every entry is an absolute folder; anything the profile prints around it
 * is ignored. It runs with stdin closed and is stopped after 10 s (a heavy profile, nvm and the
 * like, can take seconds). On any failure the inherited PATH is used as it is, for that call only:
 * a PATH found is kept for the life of the runner process, a failure is asked again next time. Windows is left unchanged: GUI apps there get
 * the user's PATH from the registry.
 *
 * The login PATH goes first, then whatever the runner inherited that it lacks.
 */

const START = "__XIONGBAO_PATH_START__";
const END = "__XIONGBAO_PATH_END__";
export const LOGIN_PATH_TIMEOUT_MS = 10_000;

export type LoginPathDeps = {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  run(command: string, args: string[], timeoutMs: number): Promise<ProbeResult>;
  timeoutMs?: number;
};

/** The entries of `first`, then those of `second` not already there; empty entries dropped. */
export function mergePaths(
  first: string | undefined,
  second: string | undefined,
): string {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const entry of [
    ...(first ?? "").split(":"),
    ...(second ?? "").split(":"),
  ]) {
    if (entry === "" || seen.has(entry)) continue;
    seen.add(entry);
    merged.push(entry);
  }
  return merged.join(":");
}

/** The one PATH line between the markers, when it holds only absolute folders. */
export function pathFromOutput(stdout: string): string | undefined {
  const lines = stdout.split(/\r?\n/);
  const start = lines.indexOf(START);
  const end = lines.indexOf(END, start + 1);
  if (start < 0 || end !== start + 2) return undefined;
  const path = lines[start + 1]?.trim() ?? "";
  const entries = path.split(":").filter(Boolean);
  if (entries.length === 0 || !entries.every((entry) => entry.startsWith("/")))
    return undefined;
  return path;
}

function loginShell(deps: LoginPathDeps): string | undefined {
  const shell = deps.env.SHELL;
  if (shell?.startsWith("/")) return shell;
  return deps.platform === "darwin" ? "/bin/zsh" : undefined;
}

/** The login shell's PATH, or undefined (Windows, no shell, a failure, a timeout, odd output). */
export async function readLoginShellPath(
  deps: LoginPathDeps,
): Promise<string | undefined> {
  if (deps.platform !== "darwin" && deps.platform !== "linux") return undefined;
  const shell = loginShell(deps);
  if (shell === undefined) return undefined;
  try {
    const result = await deps.run(
      shell,
      ["-ilc", `echo ${START}; /usr/bin/printenv PATH; echo ${END}`],
      deps.timeoutMs ?? LOGIN_PATH_TIMEOUT_MS,
    );
    if (result.timedOut || result.code !== 0) return undefined;
    return pathFromOutput(result.stdout);
  } catch {
    return undefined;
  }
}

/**
 * `env` with PATH = the login shell's PATH ahead of the inherited one; `env` itself when there is
 * no login PATH to add.
 */
export async function withLoginPath(
  deps: LoginPathDeps,
): Promise<Record<string, string | undefined>> {
  const login = await readLoginShellPath(deps);
  if (login === undefined) return deps.env;
  return { ...deps.env, PATH: mergePaths(login, deps.env.PATH) };
}

/**
 * `deps().env` with the login PATH, the shell asked until it once answers: a PATH found is kept and
 * the shell never asked again; a failure (or a timeout) answers the inherited environment for that
 * call and is not remembered. Callers at the same moment share one ask.
 */
export function createAcpProcessEnv(
  deps: () => LoginPathDeps,
): () => Promise<Record<string, string | undefined>> {
  let found: Record<string, string | undefined> | undefined;
  let asking: Promise<Record<string, string | undefined>> | undefined;
  return () => {
    if (found) return Promise.resolve(found);
    asking ??= (async () => {
      const current = deps();
      const login = await readLoginShellPath(current);
      if (login === undefined) return current.env;
      found = { ...current.env, PATH: mergePaths(login, current.env.PATH) };
      return found;
    })().finally(() => {
      asking = undefined;
    });
    return asking;
  };
}

/** This process's environment with the login PATH (`createAcpProcessEnv`). */
export const acpProcessEnv = createAcpProcessEnv(() => ({
  platform: process.platform,
  env: process.env,
  run: (command, args, timeoutMs) => runProbe(command, args, { timeoutMs }),
}));
