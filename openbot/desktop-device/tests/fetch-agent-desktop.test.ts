import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentDesktopLock,
  archiveUrl,
  fetchAgentDesktop,
  sidecarFiles,
} from "../scripts/fetch-agent-desktop";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "fetch-agent-desktop-"));
  dirs.push(dir);
  return dir;
}
const sha = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");

const TRIPLE = "x86_64-unknown-linux-gnu";
const FILES: Record<string, string> = {
  "agent-desktop": "cli bytes",
  "agent-desktop-linux-clipboard-owner": "owner bytes",
};

/** Builds a tar.gz holding `files` (flat) and a lock that pins it. */
function build(files: Record<string, string> = FILES) {
  const src = scratch();
  for (const [name, body] of Object.entries(files))
    writeFileSync(join(src, name), body);
  const archive = join(scratch(), "a.tar.gz");
  const made = Bun.spawnSync(
    ["tar", "-czf", archive, "-C", src, ...Object.keys(files)],
    { stderr: "pipe" },
  );
  if (made.exitCode !== 0) throw new Error(made.stderr.toString());
  const bytes = new Uint8Array(readFileSync(archive));
  const lock: AgentDesktopLock = {
    version: "1.2.0",
    commit: "0".repeat(40),
    targets: {
      [TRIPLE]: {
        archive: `agent-desktop-v1.2.0-${TRIPLE}.tar.gz`,
        archiveSha256: sha(bytes),
        entries: Object.keys(FILES).map((name) => ({
          name,
          sha256: sha(FILES[name] ?? ""),
        })),
      },
    },
  };
  return { bytes, lock };
}

test("archiveUrl names the v1.2.0 release asset", () => {
  const lock = JSON.parse(
    readFileSync(
      join(import.meta.dir, "..", "agent-desktop.lock.json"),
      "utf8",
    ),
  ) as AgentDesktopLock;
  const url = archiveUrl(lock, "x86_64-pc-windows-msvc");
  expect(
    url.endsWith(
      "/releases/download/v1.2.0/agent-desktop-v1.2.0-x86_64-pc-windows-msvc.tar.gz",
    ),
  ).toBe(true);
  expect(url.startsWith("https://github.com/vercel-labs/agent-desktop/")).toBe(
    true,
  );
});

test("sidecarFiles: macOS brings its clipboard helper, Linux the CLI only, Windows an .exe", () => {
  expect(sidecarFiles("aarch64-apple-darwin")).toEqual([
    { entry: "agent-desktop", file: "agent-desktop-aarch64-apple-darwin" },
    {
      entry: "agent-desktop-macos-helper",
      file: "agent-desktop-macos-helper-aarch64-apple-darwin",
    },
  ]);
  expect(sidecarFiles("x86_64-unknown-linux-gnu")).toEqual([
    {
      entry: "agent-desktop",
      file: "agent-desktop-x86_64-unknown-linux-gnu",
    },
  ]);
  expect(sidecarFiles("x86_64-pc-windows-msvc")).toEqual([
    {
      entry: "agent-desktop.exe",
      file: "agent-desktop-x86_64-pc-windows-msvc.exe",
    },
  ]);
});

test("a wrong archive checksum fails and leaves nothing in outDir", async () => {
  const { bytes, lock } = build();
  const outDir = join(scratch(), "out");
  const bad = new Uint8Array(bytes);
  bad[bad.length - 1] = (bad[bad.length - 1] ?? 0) ^ 0xff;
  await expect(
    fetchAgentDesktop({
      triple: TRIPLE,
      lock,
      outDir,
      download: async () => bad,
    }),
  ).rejects.toThrow(new RegExp(`${lock.targets[TRIPLE]?.archiveSha256}`));
  expect(!existsSync(outDir) || readdirSync(outDir).length === 0).toBe(true);
});

test("an extra or missing entry in the archive fails before extracting", async () => {
  const outDir = join(scratch(), "out");
  const { lock } = build();
  const target = lock.targets[TRIPLE];
  if (!target) throw new Error("no target");
  for (const files of [
    { ...FILES, "surprise.sh": "boo" },
    { "agent-desktop": FILES["agent-desktop"] ?? "" },
  ]) {
    const other = build(files).bytes;
    target.archiveSha256 = sha(other);
    await expect(
      fetchAgentDesktop({
        triple: TRIPLE,
        lock,
        outDir,
        download: async () => other,
      }),
    ).rejects.toThrow(/entries/);
    expect(!existsSync(outDir) || readdirSync(outDir).length === 0).toBe(true);
  }
});

test("an entry whose bytes differ from the lock fails", async () => {
  const outDir = join(scratch(), "out");
  const { lock } = build();
  const target = lock.targets[TRIPLE];
  if (!target) throw new Error("no target");
  const tampered = build({ ...FILES, "agent-desktop": "evil bytes" }).bytes;
  target.archiveSha256 = sha(tampered);
  await expect(
    fetchAgentDesktop({
      triple: TRIPLE,
      lock,
      outDir,
      download: async () => tampered,
    }),
  ).rejects.toThrow(new RegExp(sha("cli bytes")));
  expect(!existsSync(outDir) || readdirSync(outDir).length === 0).toBe(true);
});

test("a good archive installs exactly the sidecar files, executable", async () => {
  const { bytes, lock } = build();
  const outDir = join(scratch(), "out");
  mkdirSync(outDir);
  const written = await fetchAgentDesktop({
    triple: TRIPLE,
    lock,
    outDir,
    download: async (url) => {
      expect(url).toBe(archiveUrl(lock, TRIPLE));
      return bytes;
    },
  });
  const name = `agent-desktop-${TRIPLE}`;
  expect(written).toEqual([join(outDir, name)]);
  expect(readdirSync(outDir)).toEqual([name]);
  expect(readFileSync(join(outDir, name), "utf8")).toBe("cli bytes");
  expect(statSync(join(outDir, name)).mode & 0o777).toBe(0o755);
});

test("the committed lock pins six targets and the binaries of design decision 2", () => {
  const lock = JSON.parse(
    readFileSync(
      join(import.meta.dir, "..", "agent-desktop.lock.json"),
      "utf8",
    ),
  ) as AgentDesktopLock;
  expect(Object.keys(lock.targets).sort()).toEqual([
    "aarch64-apple-darwin",
    "aarch64-pc-windows-msvc",
    "aarch64-unknown-linux-gnu",
    "x86_64-apple-darwin",
    "x86_64-pc-windows-msvc",
    "x86_64-unknown-linux-gnu",
  ]);
  const hash = (triple: string, name: string) =>
    lock.targets[triple]?.entries.find((e) => e.name === name)?.sha256;
  expect(hash("aarch64-apple-darwin", "agent-desktop")).toBe(
    "dec75e0bba0d1f9b589bdb88188770ad1a199cde9e02cf0a5b94175491f738e9",
  );
  expect(hash("x86_64-pc-windows-msvc", "agent-desktop.exe")).toBe(
    "d274667031322e50b9c2b1ab81c2ca46835d52cc932769a5c34bd4d481fd94c3",
  );
});
