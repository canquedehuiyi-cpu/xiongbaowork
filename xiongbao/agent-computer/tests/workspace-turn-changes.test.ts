import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isIgnoredArtifactPath } from "../../shared/turn-artifacts";
import { createWorkspace, DEFAULT_WORKSPACE_LIMITS } from "../src/workspace";

let base = "";
let root = "";

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "turn-changes-"));
  root = join(base, "ws");
  await mkdir(root, { recursive: true });
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

function workspace(scanLimit?: number) {
  return createWorkspace(root, DEFAULT_WORKSPACE_LIMITS, {
    artifactScanLimit: scanLimit,
  });
}

describe("turn changes", () => {
  test("new, modified, untouched", async () => {
    const ws = workspace();
    await writeFile(join(root, "old.txt"), "a");
    await writeFile(join(root, "keep.txt"), "k");
    await ws.mark("r1");
    await writeFile(join(root, "deck.pptx"), "x".repeat(50));
    await writeFile(join(root, "old.txt"), "ab");
    const result = await ws.changedSince("r1");
    expect(result?.files.map((f) => [f.path, f.change]).sort()).toEqual([
      ["deck.pptx", "new"],
      ["old.txt", "modified"],
    ]);
    expect(result?.files.find((f) => f.path === "deck.pptx")?.bytes).toBe(50);
    expect(result?.omitted).toBe(0);
    expect(result?.scanTruncated).toBe(false);
  });

  test("same size but newer mtime counts as modified", async () => {
    const ws = workspace();
    await writeFile(join(root, "a.txt"), "a");
    await utimes(join(root, "a.txt"), 1000, 1000);
    await ws.mark("r1");
    await utimes(join(root, "a.txt"), 2000, 2000);
    expect((await ws.changedSince("r1"))?.files.map((f) => f.change)).toEqual([
      "modified",
    ]);
  });

  test("tool-outputs, hidden folders, hidden files and empty files are not listed", async () => {
    const ws = workspace();
    await ws.mark("r1");
    await mkdir(join(root, "tool-outputs"), { recursive: true });
    await mkdir(join(root, ".cache"), { recursive: true });
    await mkdir(join(root, "node_modules", "x"), { recursive: true });
    await mkdir(join(root, "sub"), { recursive: true });
    await writeFile(join(root, "tool-outputs", "o.txt"), "o");
    await writeFile(join(root, ".cache", "c.txt"), "c");
    await writeFile(join(root, "node_modules", "x", "i.js"), "i");
    await writeFile(join(root, ".hidden"), "h");
    await writeFile(join(root, "empty.txt"), "");
    await writeFile(join(root, "sub", "real.txt"), "r");
    expect((await ws.changedSince("r1"))?.files.map((f) => f.path)).toEqual([
      "sub/real.txt",
    ]);
  });

  test("deleted files and symlinks are not listed", async () => {
    const ws = workspace();
    await writeFile(join(root, "gone.txt"), "g");
    await writeFile(join(base, "outside.txt"), "secret");
    await ws.mark("r1");
    await rm(join(root, "gone.txt"));
    await symlink(join(base, "outside.txt"), join(root, "link.txt"));
    await symlink(base, join(root, "linkdir"));
    expect((await ws.changedSince("r1"))?.files).toEqual([]);
  });

  test("205 changes list 200 and count 5 omitted", async () => {
    const ws = workspace();
    await ws.mark("r1");
    for (let i = 0; i < 205; i++) await writeFile(join(root, `f${i}.txt`), "x");
    const result = await ws.changedSince("r1");
    expect(result?.files.length).toBe(200);
    expect(result?.omitted).toBe(5);
  });

  test("a scan limit marks the result truncated", async () => {
    const ws = workspace(10);
    for (let i = 0; i < 15; i++) await writeFile(join(root, `f${i}.txt`), "x");
    const marked = await ws.mark("r1");
    expect(marked.scanTruncated).toBe(true);
    expect((await ws.changedSince("r1"))?.scanTruncated).toBe(true);
  });

  test("an unknown or already-used mark is null", async () => {
    const ws = workspace();
    expect(await ws.changedSince("nope")).toBeNull();
    await ws.mark("r1");
    expect(await ws.changedSince("r1")).not.toBeNull();
    expect(await ws.changedSince("r1")).toBeNull();
  });

  test("keeps at most 50 marks, dropping the oldest", async () => {
    const ws = workspace();
    for (let i = 0; i < 51; i++) await ws.mark(`m${i}`);
    expect(await ws.changedSince("m0")).toBeNull();
    expect(await ws.changedSince("m1")).not.toBeNull();
  });
});

describe("odd names and confined mode", () => {
  test("paths come back exactly as written", async () => {
    const ws = workspace();
    await ws.mark("r1");
    const names = [
      "a b#c?d%e 报告.docx",
      "out/子目录/x.txt",
      "back\\slash.txt",
    ];
    for (const name of names) {
      await mkdir(join(root, name, ".."), { recursive: true });
      await writeFile(join(root, name), "x");
    }
    expect(
      (await ws.changedSince("r1"))?.files.map((f) => f.path).sort(),
    ).toEqual([...names].sort());
  });

  test("a link to another employee's folder is not listed, confined", async () => {
    const theirs = join(base, "theirs");
    await mkdir(theirs, { recursive: true });
    await writeFile(join(theirs, "secret.txt"), "THEIR SECRET");
    const ws = createWorkspace(root, undefined, { confineOpened: true });
    await ws.mark("r1");
    await symlink(theirs, join(root, "linked"));
    await writeFile(join(root, "mine.txt"), "m");
    expect((await ws.changedSince("r1"))?.files.map((f) => f.path)).toEqual([
      "mine.txt",
    ]);
  });
});

describe("isIgnoredArtifactPath", () => {
  test("any segment in the list or starting with a dot", () => {
    expect(isIgnoredArtifactPath("tool-outputs/a.txt")).toBe(true);
    expect(isIgnoredArtifactPath("a/node_modules/b.js")).toBe(true);
    expect(isIgnoredArtifactPath("a/.secret/b")).toBe(true);
    expect(isIgnoredArtifactPath("reports/q3.xlsx")).toBe(false);
  });
});
