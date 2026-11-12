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
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentDesktopLock,
  archiveUrl,
  fetchAgentDesktop,
  sidecarFiles,
  tarProgram,
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

const noSleep = async () => {};
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
    [tarProgram(), "-czf", archive, "-C", src, ...Object.keys(files)],
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
  // Windows has no POSIX mode bits; elsewhere the sidecar must be 0755.
  if (process.platform !== "win32") {
    expect(statSync(join(outDir, name)).mode & 0o777).toBe(0o755);
  }
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

test("a download that fails twice is retried and installs", async () => {
  const { bytes, lock } = build();
  const outDir = join(scratch(), "out");
  let calls = 0;
  const waits: number[] = [];
  await fetchAgentDesktop({
    triple: TRIPLE,
    lock,
    outDir,
    sleep: async (ms) => {
      waits.push(ms);
    },
    download: async () => {
      if (++calls <= 2) throw new Error("504");
      return bytes;
    },
  });
  expect(calls).toBe(3);
  expect(waits.length).toBe(2);
  expect(readdirSync(outDir)).toEqual([`agent-desktop-${TRIPLE}`]);
});

test("a download that always fails gives up after 5 attempts", async () => {
  const { lock } = build();
  const outDir = join(scratch(), "out");
  let calls = 0;
  await expect(
    fetchAgentDesktop({
      triple: TRIPLE,
      lock,
      outDir,
      sleep: noSleep,
      download: async () => {
        calls++;
        throw new Error("boom");
      },
    }),
  ).rejects.toThrow("boom");
  expect(calls).toBe(5);
  expect(!existsSync(outDir) || readdirSync(outDir).length === 0).toBe(true);
});

test("a symlink entry is refused by name before anything is installed", async () => {
  const src = scratch();
  writeFileSync(join(src, "agent-desktop"), FILES["agent-desktop"] ?? "");
  symlinkSync("agent-desktop", join(src, "agent-desktop-linux-clipboard-owner"));
  const archive = join(scratch(), "a.tar.gz");
  const made = Bun.spawnSync(
    [tarProgram(), "-czf", archive, "-C", src, ...Object.keys(FILES)],
    { stderr: "pipe" },
  );
  expect(made.exitCode).toBe(0);
  const bytes = new Uint8Array(readFileSync(archive));
  const { lock } = build();
  const target = lock.targets[TRIPLE];
  if (!target) throw new Error("no target");
  target.archiveSha256 = sha(bytes);
  const outDir = join(scratch(), "out");
  await expect(
    fetchAgentDesktop({
      triple: TRIPLE,
      lock,
      outDir,
      download: async () => bytes,
    }),
  ).rejects.toThrow(/agent-desktop-linux-clipboard-owner.*not a regular file/);
  expect(!existsSync(outDir) || readdirSync(outDir).length === 0).toBe(true);
});

test("a failed install leaves existing files untouched and no .tmp behind", async () => {
  const { bytes, lock } = build();
  const outDir = join(scratch(), "out");
  mkdirSync(outDir);
  const name = `agent-desktop-${TRIPLE}`;
  // A directory where the file must go makes the final rename fail.
  mkdirSync(join(outDir, name));
  writeFileSync(join(outDir, "keep"), "keep");
  await expect(
    fetchAgentDesktop({
      triple: TRIPLE,
      lock,
      outDir,
      download: async () => bytes,
    }),
  ).rejects.toThrow();
  expect(readdirSync(outDir).sort()).toEqual([name, "keep"]);
});

test("macOS installs the CLI and its helper", async () => {
  const triple = "aarch64-apple-darwin";
  const files = {
    "agent-desktop": "mac cli",
    "agent-desktop-macos-helper": "mac helper",
  };
  const { bytes, lock } = build(files);
  const source = lock.targets[TRIPLE];
  if (!source) throw new Error("no target");
  lock.targets = {
    [triple]: {
      archive: `agent-desktop-v1.2.0-${triple}.tar.gz`,
      archiveSha256: source.archiveSha256,
      entries: Object.entries(files).map(([name, body]) => ({
        name,
        sha256: sha(body),
      })),
    },
  };
  const outDir = join(scratch(), "out");
  const written = await fetchAgentDesktop({
    triple,
    lock,
    outDir,
    download: async () => bytes,
  });
  expect(written.map((p) => p.slice(outDir.length + 1))).toEqual([
    `agent-desktop-${triple}`,
    `agent-desktop-macos-helper-${triple}`,
  ]);
  expect(readFileSync(join(outDir, `agent-desktop-${triple}`), "utf8")).toBe(
    "mac cli",
  );
  expect(
    readFileSync(join(outDir, `agent-desktop-macos-helper-${triple}`), "utf8"),
  ).toBe("mac helper");
  expect(readdirSync(outDir).length).toBe(2);
});
