#!/usr/bin/env bun
/**
 * Can the compiled runner stand in for `bun x`? (device app discovery, sub-project 3, PR-0)
 *
 *   cd openbot && bun scripts/ci/bunx-spike.ts
 *
 * Discovery rewrites the `npx` / `bunx` apps it finds to run on the Bun the device app already
 * carries: the runner is a `bun build --compile` binary, and a compiled Bun binary started with
 * `BUN_BE_BUN=1` behaves as the `bun` CLI instead of its own entry point. This compiles the runner
 * exactly as the sidecar is built (`desktop-device/scripts/build-sidecar.ts`) and checks three
 * things against that binary:
 *
 *   1. `BUN_BE_BUN=1 <runner> --version` prints a Bun version;
 *   2. `BUN_BE_BUN=1 <runner> <script.ts>` runs a TypeScript script;
 *   3. an MCP app whose command is the runner, `x --bun <SPIKE_PACKAGE> <workDir>` under
 *      `BUN_BE_BUN=1`, started through the runner's own `connectApp`, lists `read_text_file`.
 *
 * The third needs the npm registry (the package is fetched into Bun's cache), so it is not in the
 * unit tests; `runner/tests/runner-package.test.ts` covers the first two offline. The WIN1 probe
 * (`windows-runner-probe.ts`) runs the same checks on Windows, where the app starts through cmd.exe.
 *
 * Run directly, it prints one JSON line per check and `BUNX_SPIKE_PASS` when all three pass.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileArgs } from "../../desktop-device/scripts/build-sidecar.ts";
import { connectApp } from "../../runner/src/mcp-client.ts";

/** A small, well-known npm MCP server, pinned so the check means the same thing on every run. */
export const SPIKE_PACKAGE = "@modelcontextprotocol/server-filesystem@2.2.0";

/** The tool the filesystem server offers that the third check looks for. */
const SPIKE_TOOL = "read_text_file";

const SCRIPT_MARKER = "BUNX_SPIKE_SCRIPT";

export type SpikeResult = { check: string; passed: boolean; detail?: string };

/**
 * The runner compiled into `outDir` with the sidecar's own flags, for this machine (so no `--target`
 * and no `rustc`: the triple only has to be the same on both sides). Returns the binary's path.
 */
export async function compileRunner(outDir: string): Promise<string> {
  mkdirSync(outDir, { recursive: true });
  const outfile = join(
    outDir,
    process.platform === "win32" ? "openbot-runner.exe" : "openbot-runner",
  );
  const host = `${process.platform}-${process.arch}`;
  const build = Bun.spawn(
    [process.execPath, ...compileArgs(host, host, outfile)],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [code, stdout, stderr] = await Promise.all([
    build.exited,
    new Response(build.stdout).text(),
    new Response(build.stderr).text(),
  ]);
  if (code !== 0) {
    throw new Error(
      `bun build --compile failed (${code}):\n${stdout}\n${stderr}`,
    );
  }
  return outfile;
}

/** `runner args...` under BUN_BE_BUN=1, to its end. */
async function asBun(runner: string, args: string[], cwd: string) {
  const child = Bun.spawn([runner, ...args], {
    cwd,
    env: { ...process.env, BUN_BE_BUN: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const tail = (error as { stderrTail?: unknown }).stderrTail;
  return tail ? `${error.message}\n${String(tail)}` : error.message;
}

/** The three checks against `runner`; `workDir` is an existing folder the spike may write in. */
export async function runBunxSpike(
  runner: string,
  workDir: string,
): Promise<SpikeResult[]> {
  const results: SpikeResult[] = [];

  {
    const check = "BUN_BE_BUN=1 <runner> --version prints a Bun version";
    try {
      const run = await asBun(runner, ["--version"], workDir);
      const passed = run.code === 0 && /^\d+\.\d+\.\d+/.test(run.stdout);
      results.push({
        check,
        passed,
        detail: passed
          ? run.stdout.trim()
          : `exit ${run.code}: ${run.stdout}${run.stderr}`,
      });
    } catch (error) {
      results.push({ check, passed: false, detail: describe(error) });
    }
  }

  {
    const check = "BUN_BE_BUN=1 <runner> <script.ts> runs the script";
    try {
      const script = join(workDir, "bunx-spike-script.ts");
      writeFileSync(
        script,
        `const runtime: string = "Bun " + Bun.version;\nconsole.log("${SCRIPT_MARKER} " + runtime);\n`,
      );
      const run = await asBun(runner, [script], workDir);
      const line = run.stdout
        .split(/\r?\n/)
        .find((text) => text.startsWith(SCRIPT_MARKER));
      const passed = run.code === 0 && line !== undefined;
      results.push({
        check,
        passed,
        detail: passed ? line : `exit ${run.code}: ${run.stdout}${run.stderr}`,
      });
    } catch (error) {
      results.push({ check, passed: false, detail: describe(error) });
    }
  }

  {
    const check = `BUN_BE_BUN=1 <runner> x --bun ${SPIKE_PACKAGE} lists ${SPIKE_TOOL}`;
    try {
      const connection = await connectApp(
        {
          ref: "bunx-spike",
          name: "bunx spike",
          kind: "stdio",
          command: runner,
          args: ["x", "--bun", SPIKE_PACKAGE, workDir],
          env: { BUN_BE_BUN: "1" },
          cwd: workDir,
          enabled: true,
        },
        // The first start downloads the package and its dependencies into Bun's cache.
        { timeouts: { initMs: 180_000, listMs: 60_000 } },
      );
      try {
        const names = (await connection.listTools()).map((tool) => tool.name);
        results.push({
          check,
          passed: names.includes(SPIKE_TOOL),
          detail: names.join(","),
        });
      } finally {
        await connection.close();
      }
    } catch (error) {
      results.push({ check, passed: false, detail: describe(error) });
    }
  }

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
    const results = await runBunxSpike(runner, workDir);
    for (const result of results) console.log(JSON.stringify(result));
    failed = results.some((result) => !result.passed);
  } finally {
    // The binary is ~100MB: it does not outlive the run.
    rmSync(scratch, { recursive: true, force: true });
  }
  if (failed) process.exit(1);
  console.log("BUNX_SPIKE_PASS");
}
