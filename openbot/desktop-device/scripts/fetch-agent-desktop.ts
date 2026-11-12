#!/usr/bin/env bun
/**
 * Download agent-desktop, check it against the committed lock, and stage it as a Tauri sidecar.
 *
 *   bun desktop-device/scripts/fetch-agent-desktop.ts [--triple <rust target triple>] [--out <dir>]
 *
 * `--out` defaults to `src-tauri/binaries`, where `externalBin` (`tauri.bundle.conf.json`) looks for
 * `agent-desktop-<triple>[.exe]`. Without `--triple`, the host's (from `rustc -vV`).
 *
 * Nothing reaches `outDir` unless every check passes: the archive's SHA-256, the exact set of
 * entries (flat, no links), and each entry's SHA-256, all against `agent-desktop.lock.json`.
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostTriple } from "./build-sidecar";

const LOCK = join(import.meta.dir, "..", "agent-desktop.lock.json");
const BINARIES = join(import.meta.dir, "..", "src-tauri", "binaries");

export type AgentDesktopLock = {
  version: string;
  commit: string;
  targets: Record<
    string,
    {
      archive: string;
      archiveSha256: string;
      entries: { name: string; sha256: string }[];
    }
  >;
};

function targetOf(lock: AgentDesktopLock, triple: string) {
  const target = lock.targets[triple];
  if (!target) {
    throw new Error(
      `agent-desktop.lock.json has no target ${triple}. Known: ${Object.keys(lock.targets).join(", ")}`,
    );
  }
  return target;
}

export function archiveUrl(lock: AgentDesktopLock, triple: string): string {
  return `https://github.com/vercel-labs/agent-desktop/releases/download/v${lock.version}/${targetOf(lock, triple).archive}`;
}

/**
 * The files that go into `src-tauri/binaries`: the CLI as `agent-desktop-<triple>[.exe]`, plus on
 * macOS its clipboard helper. Linux ships only the CLI.
 */
export function sidecarFiles(
  triple: string,
): { entry: string; file: string }[] {
  const windows = triple.includes("windows");
  const files = [
    {
      entry: windows ? "agent-desktop.exe" : "agent-desktop",
      file: `agent-desktop-${triple}${windows ? ".exe" : ""}`,
    },
  ];
  if (triple.includes("apple-darwin")) {
    files.push({
      entry: "agent-desktop-macos-helper",
      file: `agent-desktop-macos-helper-${triple}`,
    });
  }
  return files;
}

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

function tarProgram(): string {
  // The same tar the upstream postinstall uses on Windows (Git Bash's tar cannot read C:\ paths).
  if (process.platform === "win32") {
    return join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  }
  return "tar";
}

/** A failure retrying cannot fix (an HTTP 4xx). */
class Permanent extends Error {}

async function download(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    const message = `GET ${url} answered ${response.status}`;
    // GitHub's release downloads answer 5xx for minutes at a time; a 4xx will not change.
    throw response.status >= 500 ? new Error(message) : new Permanent(message);
  }
  return new Uint8Array(await response.arrayBuffer());
}

const ATTEMPTS = 5;

/** Up to 5 attempts with 10s, 20s, 40s, 80s between them (about 2.5 minutes). */
async function withRetry(
  fn: () => Promise<Uint8Array>,
  sleep: (ms: number) => Promise<void>,
): Promise<Uint8Array> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof Permanent || attempt >= ATTEMPTS) throw error;
      const wait = 10_000 * 2 ** (attempt - 1);
      console.warn(
        `download failed (attempt ${attempt}/${ATTEMPTS}): ${error instanceof Error ? error.message : error}; retrying in ${wait / 1000}s`,
      );
      await sleep(wait);
    }
  }
}

export async function fetchAgentDesktop(opts: {
  triple: string;
  lock: AgentDesktopLock;
  outDir: string;
  download?: (url: string) => Promise<Uint8Array>;
  tar?: string;
  /** Waits between download attempts; tests inject an instant one. */
  sleep?: (ms: number) => Promise<void>;
}): Promise<string[]> {
  const { triple, lock, outDir } = opts;
  const target = targetOf(lock, triple);
  const tar = opts.tar ?? tarProgram();
  const url = archiveUrl(lock, triple);
  const work = mkdtempSync(join(tmpdir(), "agent-desktop-"));
  try {
    const get = opts.download ?? download;
    const bytes = await withRetry(
      () => get(url),
      opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    );
    const actual = sha256(bytes);
    if (actual !== target.archiveSha256) {
      throw new Error(
        `${target.archive}: SHA-256 is ${actual}, the lock expects ${target.archiveSha256}`,
      );
    }
    const archive = join(work, target.archive);
    writeFileSync(archive, bytes);

    const listed = Bun.spawnSync([tar, "-tzf", archive], { stderr: "pipe" });
    if (listed.exitCode !== 0) {
      throw new Error(`tar -tzf failed: ${listed.stderr.toString()}`);
    }
    const names = listed.stdout
      .toString()
      .split(/\r?\n/)
      .filter((line) => line !== "")
      .map((line) => line.replace(/^\.\//, ""))
      .sort();
    const expected = target.entries.map((e) => e.name).sort();
    if (
      names.length !== expected.length ||
      names.some((n, i) => n !== expected[i])
    ) {
      throw new Error(
        `${target.archive}: entries are [${names.join(", ")}], the lock expects [${expected.join(", ")}]`,
      );
    }

    // Only regular files: no directories, symlinks or hardlinks (first column of tar -tv).
    const verbose = Bun.spawnSync([tar, "-tvzf", archive], { stderr: "pipe" });
    if (verbose.exitCode !== 0) {
      throw new Error(`tar -tvzf failed: ${verbose.stderr.toString()}`);
    }
    for (const line of verbose.stdout.toString().split(/\r?\n/)) {
      if (line === "" || line.startsWith("-")) continue;
      const name =
        [...expected]
          .sort((a, b) => b.length - a.length)
          .find((n) => line.includes(n)) ?? line;
      throw new Error(
        `${target.archive}: entry ${name} is not a regular file (${line})`,
      );
    }

    const extracted = join(work, "extracted");
    mkdirSync(extracted);
    const untar = Bun.spawnSync([tar, "-xzf", archive, "-C", extracted], {
      stderr: "pipe",
    });
    if (untar.exitCode !== 0) {
      throw new Error(`tar -xzf failed: ${untar.stderr.toString()}`);
    }
    for (const entry of target.entries) {
      const got = sha256(readFileSync(join(extracted, entry.name)));
      if (got !== entry.sha256) {
        throw new Error(
          `${entry.name}: SHA-256 is ${got}, the lock expects ${entry.sha256}`,
        );
      }
    }

    // Everything checked: stage every file next to its destination as <name>.tmp, then rename them
    // all. A failure removes the .tmp files and leaves files already in outDir untouched.
    mkdirSync(outDir, { recursive: true });
    const staged: { tmp: string; to: string }[] = [];
    try {
      for (const { entry, file } of sidecarFiles(triple)) {
        if (!target.entries.some((e) => e.name === entry)) {
          throw new Error(`${target.archive} does not carry ${entry}`);
        }
        const to = join(outDir, file);
        const tmp = `${to}.tmp`;
        staged.push({ tmp, to });
        copyFileSync(join(extracted, entry), tmp);
        chmodSync(tmp, 0o755);
      }
      for (const { tmp, to } of staged) renameSync(tmp, to);
    } catch (error) {
      for (const { tmp } of staged) rmSync(tmp, { force: true });
      throw error;
    }
    return staged.map((s) => s.to);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name: string) => {
    const at = argv.indexOf(name);
    return at === -1 ? undefined : argv[at + 1];
  };
  let triple = flag("--triple");
  if (!triple) {
    const rustc = Bun.spawnSync(["rustc", "-vV"], { stdout: "pipe" });
    if (rustc.exitCode !== 0)
      throw new Error("rustc -vV failed; is Rust installed?");
    triple = hostTriple(rustc.stdout.toString());
  }
  const lock = JSON.parse(readFileSync(LOCK, "utf8")) as AgentDesktopLock;
  const written = await fetchAgentDesktop({
    triple,
    lock,
    outDir: flag("--out") ?? BINARIES,
  });
  for (const file of written) console.log(`agent-desktop: ${file}`);
}
