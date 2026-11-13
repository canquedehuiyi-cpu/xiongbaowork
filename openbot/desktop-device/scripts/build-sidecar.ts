#!/usr/bin/env bun
/**
 * Compile the runner into the sidecar this app ships (F2 stage 1).
 *
 *   bun desktop-device/scripts/build-sidecar.ts [--triple <rust target triple>]
 *
 * Writes `src-tauri/binaries/xiongbao-runner-<triple>[.exe]`, the name Tauri's `externalBin` looks
 * for (`tauri.bundle.conf.json`); the bundle installs it next to the app as `xiongbao-runner`.
 *
 * The flags are the ones the stage 0 package test proves (`runner/tests/runner-package.test.ts`):
 * `chromium-bidi` stays external because `playwright-core` only requires it for WebDriver BiDi
 * browsers, the runner drives Chrome and Edge over CDP, and the package is not installed.
 *
 * Without `--triple`, the host's (from `rustc -vV`). A different triple cross-compiles with Bun's
 * `--target`, which downloads that platform's Bun once.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const ENTRY = join(import.meta.dir, "..", "..", "runner", "src", "index.ts");
/**
 * Where the compile runs, whatever directory the script is called from: Bun writes each bundled
 * module's path into the binary as a comment, relative to this directory. Run from elsewhere those
 * become `../home/<user>/<checkout>/openbot/...`, the build machine's layout.
 */
export const BUILD_CWD = join(import.meta.dir, "..", "..");
const BINARIES = join(import.meta.dir, "..", "src-tauri", "binaries");

/** Rust target triples this app is built for, and the Bun target that runs on each. */
const BUN_TARGETS: Record<string, string> = {
  "x86_64-unknown-linux-gnu": "bun-linux-x64",
  "aarch64-unknown-linux-gnu": "bun-linux-arm64",
  "x86_64-pc-windows-msvc": "bun-windows-x64",
  "x86_64-apple-darwin": "bun-darwin-x64",
  "aarch64-apple-darwin": "bun-darwin-arm64",
};

export function bunTargetFor(triple: string): string {
  const target = BUN_TARGETS[triple];
  if (!target) {
    throw new Error(
      `No Bun target for ${triple}. Known: ${Object.keys(BUN_TARGETS).join(", ")}`,
    );
  }
  return target;
}

/** The file name `externalBin: ["binaries/xiongbao-runner"]` expects for `triple`. */
export function sidecarFile(triple: string): string {
  return `xiongbao-runner-${triple}${triple.includes("windows") ? ".exe" : ""}`;
}

/**
 * `entry` is the runner unless a test names another file to compile with exactly these flags
 * (`runner/tests/sidecar-playwright.test.ts`).
 */
export function compileArgs(
  triple: string,
  host: string,
  outfile: string,
  entry: string = ENTRY,
): string[] {
  return [
    "build",
    "--compile",
    ...(triple === host ? [] : [`--target=${bunTargetFor(triple)}`]),
    entry,
    "--external",
    "chromium-bidi",
    "--external",
    "chromium-bidi/*",
    "--outfile",
    outfile,
  ];
}

export function hostTriple(rustcVersion: string): string {
  const host = rustcVersion.match(/^host: (\S+)$/m)?.[1];
  if (!host) throw new Error("rustc -vV did not name a host triple.");
  return host;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const rustc = Bun.spawnSync(["rustc", "-vV"], { stdout: "pipe" });
  if (rustc.exitCode !== 0)
    throw new Error("rustc -vV failed; is Rust installed?");
  const host = hostTriple(rustc.stdout.toString());
  const asked = argv.indexOf("--triple");
  const triple = asked === -1 ? host : (argv[asked + 1] ?? "");
  bunTargetFor(triple);

  mkdirSync(BINARIES, { recursive: true });
  const outfile = join(BINARIES, sidecarFile(triple));
  const build = Bun.spawnSync(
    [process.execPath, ...compileArgs(triple, host, outfile)],
    {
      cwd: BUILD_CWD,
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  if (build.exitCode !== 0) process.exit(build.exitCode ?? 1);
  console.log(`sidecar: ${outfile}`);
}
