import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/*
 * The Bun the device brings with it, so an npm-style local app (`npx -y pkg`, `bunx pkg`) runs
 * without Node or Bun on the owner's machine.
 *
 * The compiled runner is itself Bun: started with BUN_BE_BUN=1 it behaves as the `bun` command, so
 * `<runner> x --bun pkg` is `bunx --bun pkg` with nothing else needed (no PATH, no shims). In
 * development the executing process is bun and works the same way. Only when the host is Node is
 * a `bun` beside it looked for.
 *
 * The path is worked out at every launch and never stored, so a device upgrade that moves it
 * breaks nothing.
 */

export type BundledRuntime = {
  command: string;
  prefix: string[];
  env: Record<string, string>;
};

const PREFIX = ["x", "--bun"];

export function bundledRuntime(
  opts: {
    execPath?: string;
    platform?: NodeJS.Platform;
    exists?: (path: string) => boolean;
  } = {},
): BundledRuntime | undefined {
  const execPath = opts.execPath ?? process.execPath;
  const platform = opts.platform ?? process.platform;
  const exists = opts.exists ?? existsSync;
  // Split on either separator: a Windows path must be read as one wherever this runs.
  const slash = Math.max(execPath.lastIndexOf("/"), execPath.lastIndexOf("\\"));
  const base = execPath.slice(slash + 1).toLowerCase();
  if (!/^node(js)?(\.exe)?$/.test(base)) {
    return { command: execPath, prefix: [...PREFIX], env: { BUN_BE_BUN: "1" } };
  }
  const dir = execPath.slice(0, Math.max(slash, 0));
  const bun =
    platform === "win32" ? `${dir}\\bun.exe` : join(dirname(execPath), "bun");
  return exists(bun)
    ? { command: bun, prefix: [...PREFIX], env: {} }
    : undefined;
}

/**
 * The package and its arguments when a stored command is one of the npm runners with nothing
 * between it and the package name: `npx -y|--yes pkg ...`, `bunx pkg ...`, `bun x pkg ...`.
 * Anything else (other options such as `npx -p`, other commands) is not ours to rewrite.
 */
export function toBundledArgs(spec: {
  command: string;
  args: string[];
}): string[] | undefined {
  const { command, args } = spec;
  let rest: string[];
  if (command === "npx") {
    if (args[0] !== "-y" && args[0] !== "--yes") return undefined;
    rest = args.slice(1);
  } else if (command === "bunx") {
    rest = args;
  } else if (command === "bun" && args[0] === "x") {
    rest = args.slice(1);
  } else {
    return undefined;
  }
  if (rest.length === 0 || rest[0]?.startsWith("-")) return undefined;
  return rest;
}
