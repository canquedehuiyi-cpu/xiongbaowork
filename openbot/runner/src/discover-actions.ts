import { readFileSync, statSync } from "node:fs";
import type { createAppHost } from "./app-host";
import type { createAppRegistry } from "./apps";
import {
  type DiscoverDeps,
  DiscoverError,
  discoverApps,
  findCandidate,
} from "./discover";
import {
  allInstalledNames,
  INSTALLED_LIMIT,
  readInstalledWindows,
} from "./discover-installed";
import type { ActionOutcome } from "./execute";
import { resolveWindowsCommand } from "./mcp-client";

/**
 * The device actions of app discovery (spec §3): what the server's `apps.discover` frame and the
 * device window's `--discover-apps` reach. Only reads: nothing here registers, starts or changes an
 * app, so no outcome is ever "unknown" and nothing pauses the device.
 *
 * ONLY NAMES LEAVE. The output is `discoverApps`'s own (names, fixed source labels, status, refs) and
 * the installed programs' names. A failure is a fixed Chinese sentence: an fs error would name the data
 * folder, and with it the owner's account.
 */

export const DISCOVER_ACTIONS: ReadonlySet<string> = new Set(["apps.discover"]);

export type DiscoverActions = (
  action: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<ActionOutcome>;

/** A config file larger than this is skipped (`~/.claude.json` can grow to tens of MB). */
const READ_LIMIT_BYTES = 20 * 1024 * 1024;

const FAILED = "本机应用发现这次没有成功。";
const BAD_CANDIDATE = "候选应用的编号格式不对。";
const STOPPED = "已在设备上停止。";

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

  return async (action, body, signal) => {
    if (!DISCOVER_ACTIONS.has(action)) {
      return {
        ok: false,
        error: `Nothing on this machine handles "${action}".`,
      };
    }
    try {
      const outcome = await discover(body);
      // Only reads were done, so a stop is a plain failure: nothing to check on the device.
      return signal?.aborted ? { ok: false, error: STOPPED } : outcome;
    } catch (error) {
      return {
        ok: false,
        error: error instanceof DiscoverError ? error.message : FAILED,
      };
    }
  };
}
