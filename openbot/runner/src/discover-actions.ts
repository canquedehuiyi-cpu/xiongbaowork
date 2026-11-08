import { readFileSync, statSync } from "node:fs";
import { AppHostError, type createAppHost } from "./app-host";
import {
  APP_NAME_LIMIT,
  type AppEntry,
  type AppInput,
  AppRegistryError,
  type createAppRegistry,
} from "./apps";
import { toBundledArgs } from "./bundled-runtime";
import {
  type Candidate,
  type DiscoverDeps,
  DiscoverError,
  discoverApps,
  findCandidate,
} from "./discover";
import type { DiscoveredSpec } from "./discover-configs";
import {
  allInstalledNames,
  INSTALLED_LIMIT,
  readInstalledWindows,
} from "./discover-installed";
import type { ActionOutcome } from "./execute";
import { resolveWindowsCommand } from "./mcp-client";

/**
 * The device actions of app discovery (spec §3): what the server's `apps.discover` and `apps.enable`
 * frames and the device window's `--discover-apps` and `--enable-candidate` reach.
 *
 * `apps.discover` only reads. `apps.enable` registers the candidate a reference names (or switches
 * its app back on), starts it once to list its tools, and takes back what it wrote when that fails.
 * Neither ever answers "outcome unknown" and nothing pauses the device: asking again is always safe,
 * and enabling the same candidate twice answers the same app.
 *
 * ONLY NAMES LEAVE. The output is `discoverApps`'s own (names, fixed source labels, status, refs) and
 * the installed programs' names; for an enabled app, its reference, name and tools. The command, its
 * arguments, environment values and working folder are written only to `runner-apps.json`. A failure
 * is a fixed Chinese sentence, the registry's own refusal or the host's: an fs error would name the
 * data folder, and with it the owner's account.
 */

export const DISCOVER_ACTIONS: ReadonlySet<string> = new Set([
  "apps.discover",
  "apps.enable",
]);

export type DiscoverActions = (
  action: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<ActionOutcome>;

/** A config file larger than this is skipped (`~/.claude.json` can grow to tens of MB). */
const READ_LIMIT_BYTES = 20 * 1024 * 1024;

/** What any unforeseen failure of discovery says: fixed, so no error text (or path) leaves. */
export const DISCOVER_FAILED = "本机应用发现这次没有成功。";
const BAD_CANDIDATE = "候选应用的编号格式不对。";
const STOPPED = "已在设备上停止。";
const NO_HOST = "本机应用服务没有运行，请稍后再试。";
/** `名称（2）` … `名称（9）`: how far a taken name is varied before the registry's refusal is shown. */
const MAX_NAME_VARIANT = 9;

/** `name`, cut to the 40 characters an app's name may have, with `suffix` kept whole after it. */
function nameWith(name: string, suffix: string): string {
  const room = APP_NAME_LIMIT - [...suffix].length;
  return `${[...name].slice(0, room).join("")}${suffix}`;
}

/** The app a candidate becomes: npm runners with the bundled runtime, anything else as written. */
function appInputOf(name: string, spec: DiscoveredSpec): AppInput {
  if (spec.kind === "http") return { kind: "http", name, url: spec.url };
  const cwd = spec.cwd === undefined ? {} : { cwd: spec.cwd };
  const bundled = toBundledArgs(spec);
  return bundled
    ? {
        kind: "stdio",
        name,
        command: "bunx",
        runtime: "bundled",
        args: bundled,
        env: { ...spec.env },
        ...cwd,
      }
    : {
        kind: "stdio",
        name,
        command: spec.command,
        args: [...spec.args],
        env: { ...spec.env },
        ...cwd,
      };
}

/** What a failed connection test says: the host's own Chinese sentence, else a fixed one. */
function enableFailure(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") return STOPPED;
  return error instanceof AppHostError ? error.userMessage : DISCOVER_FAILED;
}

function readTextFile(path: string): string | undefined {
  try {
    if (statSync(path).size > READ_LIMIT_BYTES) return undefined;
    return readFileSync(path, "utf8");
  } catch {
    // Not there (the usual case: most tools are not installed) or not readable: skipped.
    return undefined;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function createDiscoverActions(opts: {
  dataDir: string;
  registry: ReturnType<typeof createAppRegistry>;
  /** The running host, for `apps.enable` (phase 2). Discovery itself starts nothing. */
  host?: ReturnType<typeof createAppHost>;
  deps?: Partial<DiscoverDeps>;
}): DiscoverActions {
  const env = opts.deps?.env ?? process.env;
  const deps: DiscoverDeps = {
    platform: process.platform,
    dataDir: opts.dataDir,
    registry: opts.registry,
    readText: readTextFile,
    readInstalled: () => readInstalledWindows(),
    resolveCommand: (command) => resolveWindowsCommand(command, env, isFile),
    now: Date.now,
    ...opts.deps,
    env,
  };

  async function discover(
    body: Record<string, unknown>,
  ): Promise<ActionOutcome> {
    if (body.candidate !== undefined) {
      if (typeof body.candidate !== "string") {
        return { ok: false, error: BAD_CANDIDATE };
      }
      // One candidate, as this machine's config says now; the installed programs are not read.
      const found = await findCandidate(deps, body.candidate);
      return {
        ok: true,
        output: {
          platform: deps.platform,
          candidates: "candidate" in found ? [found.candidate] : [],
        },
      };
    }
    // How many names the cap left out: counted from the same entries discovery was handed.
    let total = 0;
    const result = await discoverApps({
      ...deps,
      readInstalled: async () => {
        const entries = await deps.readInstalled();
        total = allInstalledNames(entries).length;
        return entries;
      },
    });
    return {
      ok: true,
      output:
        total > INSTALLED_LIMIT
          ? { ...result, installedTruncated: total - INSTALLED_LIMIT }
          : result,
    };
  }

  /** Adds the candidate under its name, or the first free `名称（n）`; the registry's refusal is thrown. */
  function register(candidate: Candidate, spec: DiscoveredSpec): AppEntry {
    const name = nameWith(candidate.name, "");
    let free = name;
    for (let n = 2; opts.registry.byName(free); n += 1) {
      // Every variant taken: the plain name goes to the registry, which says it is taken.
      if (n > MAX_NAME_VARIANT) {
        free = name;
        break;
      }
      free = nameWith(candidate.name, `（${n}）`);
    }
    return opts.registry.add(appInputOf(free, spec));
  }

  async function enable(
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ActionOutcome> {
    if (typeof body.candidate !== "string") {
      return { ok: false, error: BAD_CANDIDATE };
    }
    const host = opts.host;
    if (!host) return { ok: false, error: NO_HOST };
    const found = await findCandidate(deps, body.candidate);
    if ("error" in found) return { ok: false, error: found.error };
    // Stopped while it waited its turn or scanned: nothing has been written yet.
    if (signal?.aborted) return { ok: false, error: STOPPED };
    const { candidate, spec } = found;
    if (candidate.status !== "ready") {
      return {
        ok: false,
        error: `「${candidate.name}」暂时不能启用：${candidate.note ?? ""}`,
      };
    }
    const known = candidate.app
      ? opts.registry.byRef(candidate.app)
      : undefined;
    let app: AppEntry;
    // What puts the registry back when the connection test fails.
    let restore: (() => void) | undefined;
    if (known?.enabled) {
      app = known;
    } else if (known) {
      app = opts.registry.setEnabled(known.ref, true);
      restore = () => opts.registry.setEnabled(known.ref, false);
    } else {
      const added = register(candidate, spec);
      app = added;
      restore = () => opts.registry.remove(added.ref);
    }
    try {
      const tools = await host.tools(app.ref, signal);
      return {
        ok: true,
        output: { app: { ref: app.ref, name: app.name }, tools },
      };
    } catch (error) {
      // A new app is removed again, one switched on is switched off again.
      restore?.();
      return { ok: false, error: enableFailure(error) };
    }
  }

  /** One enable at a time, so the same candidate asked for twice at once is added once. */
  let enabling: Promise<unknown> = Promise.resolve();

  return async (action, body, signal) => {
    if (!DISCOVER_ACTIONS.has(action)) {
      return {
        ok: false,
        error: `Nothing on this machine handles "${action}".`,
      };
    }
    try {
      if (action === "apps.enable") {
        const outcome = enabling.then(() => enable(body, signal));
        enabling = outcome.catch(() => {});
        return await outcome;
      }
      const outcome = await discover(body);
      // Only reads were done, so a stop is a plain failure: nothing to check on the device.
      return signal?.aborted ? { ok: false, error: STOPPED } : outcome;
    } catch (error) {
      // The registry's refusals (full, a name it will not take) are Chinese and name no path.
      return {
        ok: false,
        error:
          error instanceof DiscoverError || error instanceof AppRegistryError
            ? error.message
            : DISCOVER_FAILED,
      };
    }
  };
}
