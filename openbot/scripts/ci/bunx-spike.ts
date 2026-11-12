#!/usr/bin/env bun
/**
 * Can the compiled runner stand in for `bun x`? (device app discovery, sub-project 3, PR-0)
 *
 *   cd openbot && bun scripts/ci/bunx-spike.ts            # Bun's own cache
 *   cd openbot && BUNX_SPIKE_COLD=1 bun scripts/ci/bunx-spike.ts   # an empty cache: a real download
 *
 * Discovery rewrites the `npx` / `bunx` apps it finds to run on the Bun the device app already
 * carries: the runner is a `bun build --compile` binary, and a compiled Bun binary started with
 * `BUN_BE_BUN=1` behaves as the `bun` CLI instead of its own entry point. This compiles the runner
 * exactly as the sidecar is built (`desktop-device/scripts/build-sidecar.ts`) and checks, against
 * that binary:
 *
 *   1. `BUN_BE_BUN=1 <runner> --version` prints a Bun version;
 *   2. `BUN_BE_BUN=1 <runner> <script.ts>` runs a TypeScript script, and the script's
 *      `process.execPath` is the runner;
 *   3. an MCP app whose command is the runner, `x --bun <SPIKE_PACKAGE> <workDir>` under
 *      `BUN_BE_BUN=1`, started through the runner's own `connectApp`, lists `read_text_file`;
 *   4. while that app runs, every process carrying its arguments is the runner (cmd.exe aside, which
 *      is how Windows starts it), so no Bun or Node from the machine did the work.
 *
 * Every child gets a PATH with nothing on it (POSIX: an empty folder; Windows: only System32), so a
 * Bun or Node installed on the machine cannot be found, whatever the parent's PATH holds.
 *
 * The third needs the npm registry (the package is fetched into Bun's cache), so it is not in the
 * unit tests; `runner/tests/runner-package.test.ts` covers the first two offline. A failure of the
 * third is reported as `network` (the registry was unreachable, or the error says so; retried a
 * bounded number of times) or `functional` (`bun x` itself did not work), because only the second
 * says anything about the runner. The WIN1 probe (`windows-runner-probe.ts`) runs the same checks on
 * Windows, where the app starts through cmd.exe.
 *
 * Run directly, it prints one JSON line per check and `BUNX_SPIKE_PASS` when all pass.
 */
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, win32 } from "node:path";
import { compileArgs } from "../../desktop-device/scripts/build-sidecar.ts";
import { connectApp } from "../../runner/src/mcp-client.ts";

/** A small, well-known npm MCP server, pinned so the check means the same thing on every run. */
export const SPIKE_PACKAGE = "@modelcontextprotocol/server-filesystem@2.2.0";

/** The tool the filesystem server offers that the third check looks for. */
const SPIKE_TOOL = "read_text_file";
const SCRIPT_MARKER = "BUNX_SPIKE_SCRIPT";
const REGISTRY_PROBE =
  "https://registry.npmjs.org/@modelcontextprotocol%2fserver-filesystem";

const COMPILE_TIMEOUT_MS = 180_000;
const AS_BUN_TIMEOUT_MS = 60_000;
/** Attempts at the third check when a failure is a network one; a functional failure is final. */
const NETWORK_ATTEMPTS = 3;

export type SpikeResult = {
  check: string;
  passed: boolean;
  /** Only on a failure: whether the network or `bun x` itself failed. */
  failure?: "network" | "functional";
  detail?: string;
};

type Run = { code: number | null; stdout: string; stderr: string };

/**
 * `argv` to its end, killed after `timeoutMs`. A timeout throws, naming what hung, so a stuck child
 * fails the check in a minute instead of holding the CI job until its own limit.
 */
async function runWithTimeout(
  argv: string[],
  options: { cwd?: string; env?: Record<string, string> },
  timeoutMs: number,
  what: string,
): Promise<Run> {
  const child = Bun.spawn(argv, {
    ...options,
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (timedOut) {
      throw new Error(
        `${what} did not finish within ${timeoutMs / 1000}s and was killed.\n${stdout}${stderr}`,
      );
    }
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The runner compiled into `outDir` with the sidecar's own flags, for this machine (so no `--target`
 * and no `rustc`: the triple only has to be the same on both sides). Returns the binary's path.
 */
export async function compileRunner(outDir: string): Promise<string> {
  mkdirSync(outDir, { recursive: true });
  const outfile = resolve(
    outDir,
    process.platform === "win32" ? "xiongbao-runner.exe" : "xiongbao-runner",
  );
  const host = `${process.platform}-${process.arch}`;
  const build = await runWithTimeout(
    [process.execPath, ...compileArgs(host, host, outfile)],
    {},
    COMPILE_TIMEOUT_MS,
    "bun build --compile",
  );
  if (build.code !== 0) {
    throw new Error(
      `bun build --compile failed (${build.code}):\n${build.stdout}\n${build.stderr}`,
    );
  }
  return outfile;
}

/** A variable of `env` looked up the way Windows does: by name, ignoring case. */
function envValue(
  env: Record<string, string | undefined>,
  name: string,
): string | undefined {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

/**
 * The PATH every child gets: nothing a Bun or Node could be on. Windows keeps System32, where
 * cmd.exe and taskkill live (the runner reaches both by absolute path, but a Windows process without
 * System32 on PATH is not one anybody runs).
 */
function isolatedPath(workDir: string): string {
  if (process.platform === "win32") {
    return win32.join(
      envValue(process.env, "SYSTEMROOT") ?? "C:\\Windows",
      "System32",
    );
  }
  const empty = join(workDir, ".empty-path");
  mkdirSync(empty, { recursive: true });
  return empty;
}

/**
 * Variables to lay over the parent's environment (`connectApp` merges an entry's `env` over it) so
 * that no inherited PATH survives: every key the parent spells PATH in any case is overwritten with
 * the same value, in the parent's own spelling, so `Path` on Windows is replaced rather than joined
 * by a second `PATH` (and a parent carrying both gets both replaced). `PATH` when the parent has none.
 */
function pathOverlay(path: string): Record<string, string> {
  const overlay: Record<string, string> = {};
  for (const key of Object.keys(process.env)) {
    if (key.toUpperCase() === "PATH") overlay[key] = path;
  }
  if (Object.keys(overlay).length === 0) overlay.PATH = path;
  return overlay;
}

/** The full environment for a child started here: the parent's, with the PATH replaced. */
function isolatedEnv(
  path: string,
  extra: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.toUpperCase() === "PATH") continue;
    env[key] = value;
  }
  return { ...env, PATH: path, ...extra };
}

function samePath(a: string, b: string): boolean {
  const real = (path: string) => {
    try {
      return realpathSync(path);
    } catch {
      return resolve(path);
    }
  };
  return process.platform === "win32"
    ? real(a).toLowerCase() === real(b).toLowerCase()
    : real(a) === real(b);
}

function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const tail = (error as { stderrTail?: unknown }).stderrTail;
  return tail ? `${error.message}\n${String(tail)}` : error.message;
}

const NETWORK_SIGNS =
  /ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|getaddrinfo|ConnectionRefused|ConnectionClosed|ConnectionReset|socket hang up|fetch failed|registry|tarball|proxy|certificate|UNABLE_TO_GET|\b50[234]\b|\b429\b/i;

/** Whether the registry answers from here, so a failed start can be blamed on the network or not. */
async function registryReachable(): Promise<boolean> {
  try {
    const response = await fetch(REGISTRY_PROBE, {
      headers: { accept: "application/vnd.npm.install-v1+json" },
      signal: AbortSignal.timeout(15_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

type SeenProcess = {
  name: string;
  /** The runner: its path, or (`copy`) a file elsewhere with exactly its bytes. */
  runner: boolean;
  copy?: boolean;
  shell: boolean;
  shim: boolean;
};

/** Whether `path` holds exactly the runner's bytes (a copy or a link Bun made of it). */
function sameBytes(path: string, runner: string): boolean {
  try {
    const a = readFileSync(path);
    const b = readFileSync(runner);
    return (
      a.length === b.length &&
      createHash("sha256").update(a).digest("hex") ===
        createHash("sha256").update(b).digest("hex")
    );
  } catch {
    return false;
  }
}

/** A package manager's launcher for a package bin (Bun writes `.exe` shims there on Windows). */
const SHIM_DIR = /[\\/]node_modules[\\/]\.bin[\\/]/;

/**
 * The processes whose command line carries `marker`, each as whether it is the runner, the shell
 * that started it, or a package bin's launcher. Read from /proc on Linux and from Win32_Process on
 * Windows.
 */
async function processesCarrying(
  marker: string,
  runner: string,
): Promise<SeenProcess[]> {
  if (process.platform === "linux") {
    const found: SeenProcess[] = [];
    for (const pid of readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
      try {
        const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
        if (!cmdline.split("\0").some((arg) => arg.includes(marker))) continue;
        const exe = readlinkSync(`/proc/${pid}/exe`);
        const same = samePath(exe, runner);
        const copy = !same && sameBytes(exe, runner);
        found.push({
          name: exe,
          runner: same || copy,
          copy,
          shell: false,
          shim: SHIM_DIR.test(exe),
        });
      } catch {
        // Gone, or not ours to read.
      }
    }
    return found;
  }
  if (process.platform === "win32") {
    const systemRoot = envValue(process.env, "SYSTEMROOT") ?? "C:\\Windows";
    const script = [
      "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
      "$m = $env:SPIKE_MARKER; $r = $env:SPIKE_RUNNER; $c = $env:SPIKE_SHELL",
      "$rh = (Get-FileHash -LiteralPath $r -Algorithm SHA256).Hash",
      "$p = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($m) })",
      "$o = @($p | ForEach-Object {",
      "  $e = $_.ExecutablePath; $same = $e -ieq $r",
      "  $copy = (-not $same) -and $e -and (Test-Path -LiteralPath $e) -and ((Get-FileHash -LiteralPath $e -Algorithm SHA256).Hash -eq $rh)",
      "  $n = if ($copy) { $e } else { $_.Name }",
      "  @{ name = $n; runner = ($same -or $copy); copy = $copy; shell = ($e -ieq $c); shim = ($e -like '*\\node_modules\\.bin\\*') }",
      "})",
      "ConvertTo-Json -Compress -InputObject $o",
    ].join("\n");
    const run = await runWithTimeout(
      [
        win32.join(
          systemRoot,
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        ),
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        script,
      ],
      {
        env: isolatedEnv(win32.join(systemRoot, "System32"), {
          SPIKE_MARKER: marker,
          SPIKE_RUNNER: runner,
          SPIKE_SHELL:
            envValue(process.env, "COMSPEC") ??
            win32.join(systemRoot, "System32", "cmd.exe"),
        }),
      },
      AS_BUN_TIMEOUT_MS,
      "Listing processes with PowerShell",
    );
    if (run.code !== 0) {
      throw new Error(
        `PowerShell exited ${run.code}: ${run.stdout}${run.stderr}`,
      );
    }
    const parsed = JSON.parse(run.stdout.trim() || "[]");
    return Array.isArray(parsed) ? parsed : [parsed];
  }
  throw new Error(`No process listing for ${process.platform}.`);
}

/**
 * The checks against `runner`; `workDir` is an existing folder the spike may write in. Every check
 * runs and is reported, whatever an earlier one did, so a log always holds the whole picture.
 * `coldCache` points Bun's package cache at an empty folder under `workDir`, forcing a download.
 */
export async function runBunxSpike(
  runner: string,
  workDir: string,
  opts: { coldCache?: boolean } = {},
): Promise<SpikeResult[]> {
  const results: SpikeResult[] = [];
  const path = isolatedPath(workDir);
  const beBun = isolatedEnv(path, { BUN_BE_BUN: "1" });

  {
    const check = "BUN_BE_BUN=1 <runner> --version prints a Bun version";
    try {
      const run = await runWithTimeout(
        [runner, "--version"],
        { cwd: workDir, env: beBun },
        AS_BUN_TIMEOUT_MS,
        "BUN_BE_BUN=1 <runner> --version",
      );
      const passed = run.code === 0 && /^\d+\.\d+\.\d+/.test(run.stdout);
      results.push({
        check,
        passed,
        ...(passed ? {} : { failure: "functional" as const }),
        detail: passed
          ? run.stdout.trim()
          : `exit ${run.code}: ${run.stdout}${run.stderr}`,
      });
    } catch (error) {
      results.push({
        check,
        passed: false,
        failure: "functional",
        detail: describe(error),
      });
    }
  }

  {
    const check =
      "BUN_BE_BUN=1 <runner> <script.ts> runs the script, as the runner";
    try {
      const script = join(workDir, "bunx-spike-script.ts");
      writeFileSync(
        script,
        `const runtime: string = "Bun " + Bun.version;\nconsole.log("${SCRIPT_MARKER} " + runtime);\nconsole.log("EXEC_PATH " + process.execPath);\n`,
      );
      const run = await runWithTimeout(
        [runner, script],
        { cwd: workDir, env: beBun },
        AS_BUN_TIMEOUT_MS,
        "BUN_BE_BUN=1 <runner> <script.ts>",
      );
      const lines = run.stdout.split(/\r?\n/);
      const marker = lines.find((text) => text.startsWith(SCRIPT_MARKER));
      const execPath = lines
        .find((text) => text.startsWith("EXEC_PATH "))
        ?.slice("EXEC_PATH ".length);
      const passed =
        run.code === 0 &&
        marker !== undefined &&
        execPath !== undefined &&
        samePath(execPath, runner);
      results.push({
        check,
        passed,
        ...(passed ? {} : { failure: "functional" as const }),
        detail: passed
          ? `${marker}; process.execPath is the runner`
          : `exit ${run.code}: ${run.stdout}${run.stderr}`,
      });
    } catch (error) {
      results.push({
        check,
        passed: false,
        failure: "functional",
        detail: describe(error),
      });
    }
  }

  const listCheck = `BUN_BE_BUN=1 <runner> x --bun ${SPIKE_PACKAGE} lists ${SPIKE_TOOL}`;
  const processCheck =
    "the app's processes are the runner itself (no Bun or Node from the machine)";
  let listed: SpikeResult | undefined;
  let processes: SpikeResult = {
    check: processCheck,
    passed: false,
    failure: "functional",
    detail: "not run: the app did not start",
  };
  const cache = opts.coldCache ? join(workDir, "bun cache 冷") : undefined;
  if (cache) mkdirSync(cache, { recursive: true });
  for (let attempt = 1; attempt <= NETWORK_ATTEMPTS; attempt += 1) {
    try {
      const connection = await connectApp(
        {
          ref: "bunx-spike",
          name: "bunx spike",
          kind: "stdio",
          command: runner,
          args: ["x", "--bun", SPIKE_PACKAGE, workDir],
          env: {
            ...pathOverlay(path),
            BUN_BE_BUN: "1",
            ...(cache ? { BUN_INSTALL_CACHE_DIR: cache } : {}),
          },
          cwd: workDir,
          enabled: true,
        },
        // The first start downloads the package and its dependencies into Bun's cache.
        { timeouts: { initMs: 180_000, listMs: 60_000 } },
      );
      try {
        const names = (await connection.listTools()).map((tool) => tool.name);
        const passed = names.includes(SPIKE_TOOL);
        listed = {
          check: listCheck,
          passed,
          ...(passed ? {} : { failure: "functional" as const }),
          detail: `attempt ${attempt}: ${names.join(",")}`,
        };
        try {
          const seen = await processesCarrying(workDir, runner);
          // A bin launcher only hands over to an interpreter, which must then be the runner too.
          const others = seen.filter((p) => !p.runner && !p.shell && !p.shim);
          const shims = seen.filter((p) => p.shim);
          const copies = seen.filter((p) => p.copy);
          const ok = seen.some((p) => p.runner) && others.length === 0;
          processes = {
            check: processCheck,
            passed: ok,
            ...(ok ? {} : { failure: "functional" as const }),
            detail: `${seen.filter((p) => p.runner).length} runner process(es)${
              others.length
                ? `; others: ${others.map((p) => p.name).join(", ")}`
                : ""
            }${copies.length ? `; as byte-identical copies: ${copies.map((p) => p.name).join(", ")}` : ""}${shims.length ? `; bin launchers: ${shims.map((p) => p.name).join(", ")}` : ""}${
              seen.some((p) => p.runner) ? "" : "; no runner process found"
            }`,
          };
        } catch (error) {
          processes = {
            check: processCheck,
            passed: false,
            failure: "functional",
            detail: describe(error),
          };
        }
      } finally {
        await connection.close();
      }
      break;
    } catch (error) {
      const detail = describe(error);
      // The runner not starting at all is never the network's fault, whatever the registry does.
      const network =
        !(
          error instanceof Error &&
          error.message.includes("could not be started")
        ) &&
        (NETWORK_SIGNS.test(detail) || !(await registryReachable()));
      listed = {
        check: listCheck,
        passed: false,
        failure: network ? "network" : "functional",
        detail: `attempt ${attempt}/${NETWORK_ATTEMPTS} (${network ? "network: the npm registry looks unreachable; rerun before reading this as bun x not working" : "functional: not a network failure, so bun x itself failed"}): ${detail}`,
      };
      if (!network || attempt === NETWORK_ATTEMPTS) break;
      await Bun.sleep(5_000 * attempt);
    }
  }
  results.push(
    listed ?? {
      check: listCheck,
      passed: false,
      failure: "functional",
      detail: "not run",
    },
  );
  // Not run because the app never started: it fails for the same reason the listing did.
  if (listed?.failure === "network" && processes.detail?.startsWith("not run"))
    processes = { ...processes, failure: "network" };
  results.push(processes);
  return results;
}

if (import.meta.main) {
  console.log(
    JSON.stringify({
      runtime: `Bun ${Bun.version}`,
      platform: process.platform,
      arch: process.arch,
      package: SPIKE_PACKAGE,
    }),
  );
  const scratch = mkdtempSync(join(tmpdir(), "openbot-bunx-spike-"));
  let failed = true;
  try {
    const runner = await compileRunner(join(scratch, "bin"));
    const workDir = join(scratch, "work");
    mkdirSync(workDir, { recursive: true });
    const results = await runBunxSpike(runner, workDir, {
      coldCache: process.env.BUNX_SPIKE_COLD === "1",
    });
    for (const result of results) console.log(JSON.stringify(result));
    failed = results.some((result) => !result.passed);
  } finally {
    // The binary is ~100MB: it does not outlive the run. On Windows a just-killed exe can stay locked
    // for a moment; a leftover temp folder must not hide the results printed above.
    try {
      rmSync(scratch, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200,
      });
    } catch (error) {
      console.warn(`could not remove ${scratch}: ${describe(error)}`);
    }
  }
  if (failed) process.exit(1);
  console.log("BUNX_SPIKE_PASS");
}
