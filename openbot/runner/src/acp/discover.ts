import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { AcpHarness } from "../../../shared/acp";
import {
  childEnv,
  isFileOnDisk,
  killProcessTree,
  launchSpec,
  resolveWindowsCommand,
} from "../mcp-client";
import { ACP_MANIFEST } from "./manifest";

/**
 * `agents.discover`: which of the agents XiongBao can hire this machine has (Codex, Claude Code,
 * Hermes), each with
 *   installed  its CLI is on the PATH the runner's children get
 *   version    the version that CLI prints for `--version`, or null
 *   acpReady   its ACP adapter can start: `npx` is there for the npm adapters, `hermes acp --check`
 *              passes for Hermes
 *   signedIn   from the CLI's own status command (`codex login status`, `claude auth status`);
 *              null when there is none (Hermes) or its answer could not be read
 *
 * ONLY BOOLEANS AND A VERSION LEAVE. No file is read here: everything comes from running the
 * agents' own CLIs, and of what they print only a version number and a yes or no are kept (a status
 * command may print an account's email or a masked key; none of it is passed on).
 *
 * BOUNDED. Every probe runs with stdin closed (a CLI that waits for input reads end-of-file) and is
 * stopped, with its whole process tree, after `timeoutMs`. The agents are probed at once.
 */

export type AgentReport = {
  harness: AcpHarness;
  version: string | null;
  installed: boolean;
  acpReady: boolean;
  signedIn: boolean | null;
};

export type ProbeResult = {
  /** The exit code; null when it was stopped, killed by a signal or could not start. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export type AgentProbeDeps = {
  /** The absolute path a command runs from, on the children's PATH; undefined when it is not there. */
  which(command: string): string | undefined;
  /** Runs one probe; never throws. */
  run(command: string, args: string[], timeoutMs: number): Promise<ProbeResult>;
  timeoutMs?: number;
};

const PROBE_TIMEOUT_MS = 8000;
/** Enough for any version line or status answer; the rest is dropped. */
const OUTPUT_LIMIT_BYTES = 64 * 1024;
const VERSION = /\d+(?:\.\d+)+(?:-[0-9A-Za-z.]+)?/;
const VERSION_LIMIT = 40;

type Probed = Exclude<AcpHarness, "custom">;

/** How each agent's signed-in state is read from its own status command. */
const SIGNED_IN: Record<
  Probed,
  { args: string[]; read(result: ProbeResult): boolean | null } | null
> = {
  // codex-rs/cli/src/login.rs `run_login_status`: exit 0 with "Logged in using …" or "API key
  // configured"; exit 1 with "Not logged in", or with an error (unknown).
  codex: {
    args: ["login", "status"],
    read: (result) => {
      if (result.timedOut) return null;
      if (result.code === 0) return true;
      return /not logged in/i.test(`${result.stdout}\n${result.stderr}`)
        ? false
        : null;
    },
  },
  // https://code.claude.com/docs/en/cli-reference: "Show authentication status as JSON … Exits with
  // code 0 if logged in, 1 if not." Only the JSON's `loggedIn` is believed.
  "claude-code": {
    args: ["auth", "status"],
    read: (result) => {
      if (result.timedOut) return null;
      try {
        const parsed = JSON.parse(result.stdout) as { loggedIn?: unknown };
        return typeof parsed.loggedIn === "boolean" ? parsed.loggedIn : null;
      } catch {
        return null;
      }
    },
  },
  // Hermes keeps one credential pool per model provider (`hermes auth status <provider>`): there is
  // no single signed-in state to read.
  hermes: null,
};

export function versionOf(result: ProbeResult): string | null {
  if (result.timedOut || result.code !== 0) return null;
  const match = VERSION.exec(result.stdout) ?? VERSION.exec(result.stderr);
  return match ? match[0].slice(0, VERSION_LIMIT) : null;
}

async function probeAgent(
  harness: Probed,
  deps: AgentProbeDeps,
  timeoutMs: number,
): Promise<AgentReport> {
  const entry = ACP_MANIFEST[harness];
  const cli = deps.which(entry.binary);
  const adapter =
    entry.adapter.command === entry.binary
      ? cli
      : deps.which(entry.adapter.command);
  const status = SIGNED_IN[harness];
  const [version, signedIn, acpReady] = await Promise.all([
    cli ? deps.run(cli, ["--version"], timeoutMs).then(versionOf) : null,
    cli && status
      ? deps.run(cli, status.args, timeoutMs).then(status.read)
      : null,
    // The adapter is the agent's own CLI: it says itself whether ACP can start.
    adapter && entry.adapter.command === entry.binary
      ? deps
          .run(adapter, [...entry.adapter.args, "--check"], timeoutMs)
          .then((result) => result.code === 0 && !result.timedOut)
      : adapter !== undefined,
  ]);
  return { harness, version, installed: cli !== undefined, acpReady, signedIn };
}

export async function discoverAgents(
  deps: AgentProbeDeps,
): Promise<{ agents: AgentReport[] }> {
  const timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS;
  const harnesses = Object.keys(ACP_MANIFEST) as Probed[];
  return {
    agents: await Promise.all(
      harnesses.map((harness) => probeAgent(harness, deps, timeoutMs)),
    ),
  };
}

function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where a bare command runs from on POSIX: the first absolute PATH folder holding an executable
 * file of that name. A command with a folder in it is taken as written when it is executable.
 */
export function whichPosix(
  command: string,
  env: Record<string, string | undefined>,
  executable: (path: string) => boolean = isExecutable,
): string | undefined {
  if (command.includes("/")) return executable(command) ? command : undefined;
  for (const dir of (env.PATH ?? "").split(":")) {
    // A relative PATH folder would depend on where the probe starts: not a place anything is installed.
    if (!isAbsolute(dir)) continue;
    const candidate = join(dir, command);
    if (executable(candidate)) return candidate;
  }
  return undefined;
}

function appendCapped(kept: Buffer, chunk: Buffer): Buffer {
  if (kept.length >= OUTPUT_LIMIT_BYTES) return kept;
  return Buffer.concat([kept, chunk]).subarray(0, OUTPUT_LIMIT_BYTES);
}

/**
 * Runs one probe the way the runner starts its children (`launchSpec`: Windows shims through
 * cmd.exe; the environment without `XIONGBAO_*`), in the owner's home folder, with stdin closed.
 * After `timeoutMs` the whole process tree is stopped and the result says `timedOut`. Never throws:
 * a command that cannot start answers `code: null`.
 */
export function runProbe(
  command: string,
  args: string[],
  opts: {
    timeoutMs: number;
    env?: Record<string, string | undefined>;
    platform?: NodeJS.Platform;
  },
): Promise<ProbeResult> {
  const platform = opts.platform ?? process.platform;
  const env = childEnv(opts.env ?? process.env, {});
  return new Promise((resolve) => {
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let timedOut = false;
    let done = false;
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({
        code: timedOut ? null : code,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        timedOut,
      });
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const spec = launchSpec({ command, args, env: {} }, platform, env);
      const child = spawn(spec.command, spec.args, {
        cwd: homedir(),
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        // A group of its own on POSIX, so a probe that hangs is stopped with everything it started.
        detached: platform !== "win32",
        windowsVerbatimArguments: spec.windowsVerbatimArguments,
      });
      timer = setTimeout(() => {
        timedOut = true;
        killProcessTree(child);
        // A tree that will not die must not hold the answer up.
        setTimeout(() => finish(null), 1000).unref?.();
      }, opts.timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => {
        stdout = appendCapped(stdout, chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = appendCapped(stderr, chunk);
      });
      child.stdout.on("error", () => {});
      child.stderr.on("error", () => {});
      child.once("error", () => finish(null));
      child.once("close", (code) => finish(code));
    } catch {
      // Not on PATH (Windows `launchSpec`), or spawn refused outright.
      finish(null);
    }
  });
}

/** The real machine: the children's PATH, the real `runProbe`. */
export function machineProbeDeps(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): AgentProbeDeps {
  const children = childEnv(env, {});
  return {
    which: (command) =>
      platform === "win32"
        ? resolveWindowsCommand(command, children, isFileOnDisk)
        : whichPosix(command, children),
    run: (command, args, timeoutMs) =>
      runProbe(command, args, { timeoutMs, env, platform }),
  };
}
