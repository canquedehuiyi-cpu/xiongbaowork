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
  existsSync,
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

async function download(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`GET ${url} answered ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

export async function fetchAgentDesktop(opts: {
  triple: string;
  lock: AgentDesktopLock;
  outDir: string;
  download?: (url: string) => Promise<Uint8Array>;
  tar?: string;
}): Promise<string[]> {
  const { triple, lock, outDir } = opts;
  const target = targetOf(lock, triple);
  const tar = opts.tar ?? tarProgram();
  const url = archiveUrl(lock, triple);
  const work = mkdtempSync(join(tmpdir(), "agent-desktop-"));
  try {
    const bytes = await (opts.download ?? download)(url);
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

    // Everything checked: stage inside work first, then move, so a failure leaves outDir untouched.
    const staged: { from: string; to: string }[] = [];
    for (const { entry, file } of sidecarFiles(triple)) {
      if (!target.entries.some((e) => e.name === entry)) {
        throw new Error(`${target.archive} does not carry ${entry}`);
      }
      const from = join(work, `stage-${file}`);
      copyFileSync(join(extracted, entry), from);
      chmodSync(from, 0o755);
      staged.push({ from, to: join(outDir, file) });
    }
    mkdirSync(outDir, { recursive: true });
    for (const { from, to } of staged) {
      if (existsSync(to)) rmSync(to);
      try {
        renameSync(from, to);
      } catch {
        copyFileSync(from, to); // across devices
        chmodSync(to, 0o755);
      }
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
