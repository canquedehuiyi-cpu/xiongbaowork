import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveRunDir } from "./lib";

/*
 * 每次运行做完，把它在工作区里的目录整个移到工作区之外：后面的运行读不到前面留下的笔记和配置。
 */

function setup() {
  const root = mkdtempSync(join(tmpdir(), "archive-run-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  return { root, workspace, archive: join(root, "done-runs") };
}

test("移走后工作区里没有原目录，归档目录里有文件", () => {
  const { root, workspace, archive } = setup();
  try {
    const dir = join(workspace, "eval", "repeat-pitfall-p1-first");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "NOTES.md"), "笔记");
    writeFileSync(join(dir, "src", "a.txt"), "a");
    expect(
      archiveRunDir(workspace, "eval/repeat-pitfall-p1-first", archive, "k1"),
    ).toBe(true);
    expect(existsSync(dir)).toBe(false);
    expect(readFileSync(join(archive, "k1", "NOTES.md"), "utf8")).toBe("笔记");
    expect(existsSync(join(archive, "k1", "src", "a.txt"))).toBe(true);
    expect(archive.startsWith(`${workspace}/`)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("源不存在时不抛错，返回 false", () => {
  const { root, workspace, archive } = setup();
  try {
    expect(archiveRunDir(workspace, "eval/none", archive, "k2")).toBe(false);
    expect(existsSync(join(archive, "k2"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("同名归档已存在时被替换，不抛错", () => {
  const { root, workspace, archive } = setup();
  try {
    mkdirSync(join(archive, "k3"), { recursive: true });
    writeFileSync(join(archive, "k3", "old.txt"), "old");
    mkdirSync(join(workspace, "smoke", "x"), { recursive: true });
    writeFileSync(join(workspace, "smoke", "x", "new.txt"), "new");
    expect(archiveRunDir(workspace, "smoke/x", archive, "k3")).toBe(true);
    expect(existsSync(join(archive, "k3", "old.txt"))).toBe(false);
    expect(existsSync(join(archive, "k3", "new.txt"))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
