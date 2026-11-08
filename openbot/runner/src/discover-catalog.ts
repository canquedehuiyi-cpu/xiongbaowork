import { existsSync } from "node:fs";
import { APP_NAME_LIMIT, isLoopbackUrl } from "./apps";
import catalog from "./discover-catalog.json" with { type: "json" };
import type { DiscoveredSpec } from "./discover-configs";
import { connectApp } from "./mcp-client";

/**
 * The built-in catalogue of well-known software (app discovery, spec §2.3): for programs that have
 * an MCP server but leave no trace in another AI tool's config, what to look for on this machine and
 * how to start it. It is compiled into the runner, never downloaded.
 *
 * AN ENTRY IS ADDED ONLY AFTER A REAL-MACHINE CHECK. `verified` records the date, the machine and the
 * software version it was checked against, and a `bunx` launch pins an exact package version, so what
 * a candidate starts is what was checked. The shipped file is empty until that has been done.
 *
 * LOOPBACK ONLY. A port probe or a url launch must name 127.0.0.1, localhost or [::1]; an entry that
 * names anything else is ignored, so a probe never leaves the machine.
 */

export type CatalogEntry = {
  id: string;
  name: string;
  /** `installed` is a regular expression source, matched against installed program names. */
  detect: {
    installed?: string;
    /** `%VAR%` is expanded from the environment. */
    paths?: string[];
    port?: { url: string };
  };
  launch: { bunx: { package: string; args?: string[] } } | { url: string };
  /** The real-machine check: date, machine, software version. */
  verified: string;
};

/** A candidate the catalogue found. It has its own label, which says whether the program is running. */
export type CatalogFound = {
  source: "catalog";
  sourceLabel: string;
  name: string;
  spec: DiscoveredSpec;
};

export type CatalogContext = {
  env: Record<string, string | undefined>;
  installed: string[];
  /**
   * The installed programs were not read (looking up one candidate by its reference): an entry with
   * an installed-name pattern is taken as present, since the reference was issued for it.
   */
  installedNotRead?: boolean;
  exists: (path: string) => boolean;
  probe: (url: string) => Promise<boolean>;
};

export const SHIPPED_CATALOG: CatalogEntry[] = (
  catalog as { entries: CatalogEntry[] }
).entries;

const PROBE_TIMEOUT_MS = 1_500;

/** One `initialize` against a loopback url, closed again. Any failure is "not running". */
export async function probeMcp(url: string): Promise<boolean> {
  if (!isLoopbackUrl(url)) return false;
  try {
    const connection = await connectApp(
      { ref: "app_probe", name: "probe", kind: "http", url, enabled: true },
      { timeouts: { initMs: PROBE_TIMEOUT_MS } },
    );
    await connection.close();
    return true;
  } catch {
    return false;
  }
}

export const defaultCatalogProbe = probeMcp;
export const defaultCatalogExists = (path: string): boolean => {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
};

/** `%VAR%` replaced from the environment (names are case-insensitive on Windows); undefined if one is not set. */
function expand(
  text: string,
  env: Record<string, string | undefined>,
): string | undefined {
  const lower = new Map<string, string>();
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) lower.set(key.toLowerCase(), value);
  }
  let missing = false;
  const out = text.replace(/%([^%]+)%/g, (_all, name: string) => {
    const value = lower.get(name.toLowerCase());
    if (value === undefined) missing = true;
    return value ?? "";
  });
  return missing ? undefined : out;
}

function matches(pattern: string, names: string[]): string[] {
  let re: RegExp;
  try {
    re = new RegExp(pattern, "i");
  } catch {
    return [];
  }
  return names.filter((name) => re.test(name));
}

function specOf(
  entry: CatalogEntry,
  env: Record<string, string | undefined>,
): DiscoveredSpec | undefined {
  const launch = entry.launch;
  if ("url" in launch) {
    return isLoopbackUrl(launch.url)
      ? { kind: "http", url: launch.url }
      : undefined;
  }
  const args: string[] = [];
  for (const arg of launch.bunx.args ?? []) {
    const value = expand(arg, env);
    if (value === undefined) return undefined;
    args.push(value);
  }
  return {
    kind: "stdio",
    command: "bunx",
    args: [launch.bunx.package, ...args],
    env: {},
  };
}

/**
 * The entries this machine has: one whose installed-name pattern matches an installed program, or
 * one of whose paths exists; an entry with only a port needs the probe to succeed. `matchedInstalled`
 * is every installed name a pattern matched, so the caller can drop them from the plain list.
 */
export async function matchCatalog(
  entries: CatalogEntry[],
  ctx: CatalogContext,
): Promise<{ found: CatalogFound[]; matchedInstalled: string[] }> {
  const matchedInstalled = new Set<string>();
  const results = await Promise.all(
    entries.map(async (entry): Promise<CatalogFound | undefined> => {
      const spec = specOf(entry, ctx.env);
      if (!spec) return undefined;
      const { detect } = entry;
      const names = detect.installed
        ? matches(detect.installed, ctx.installed)
        : [];
      for (const name of names) matchedInstalled.add(name);
      let present =
        names.length > 0 ||
        (ctx.installedNotRead === true && detect.installed !== undefined);
      for (const path of detect.paths ?? []) {
        if (present) break;
        const expanded = expand(path, ctx.env);
        if (expanded !== undefined && ctx.exists(expanded)) present = true;
      }
      let running = false;
      const url = detect.port?.url;
      if (url !== undefined && isLoopbackUrl(url)) {
        try {
          running = await ctx.probe(url);
        } catch {
          running = false;
        }
      }
      if (!present && !running) return undefined;
      const name = [...entry.name.trim()].slice(0, APP_NAME_LIMIT).join("");
      return {
        source: "catalog",
        sourceLabel: running
          ? `内置清单，检测到 ${name} 正在运行`
          : `内置清单，检测到已安装 ${name}，使用前请先打开它`,
        name,
        spec,
      };
    }),
  );
  return {
    found: results.filter((item): item is CatalogFound => item !== undefined),
    matchedInstalled: [...matchedInstalled],
  };
}
