import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorkspace,
  WorkspaceFileNotFoundError,
  WorkspacePathError,
} from "../src/workspace";

let root: string;
let outside: string;

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), "workspace-stat-"));
  root = join(base, "workspace");
  outside = join(base, "outside");
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "secret.txt"), "a private key", "utf8");
});

afterEach(async () => {
  await rm(join(root, ".."), { recursive: true, force: true });
});

const workspace = () => createWorkspace(root);

describe("stat in the workspace", () => {
  test("stat reports size; links and .. are refused", async () => {
    await writeFile(join(root, "a.pptx"), Buffer.alloc(10));
    await symlink(join(outside, "secret.txt"), join(root, "l.txt"));
    expect(await workspace().stat("a.pptx")).toMatchObject({
      path: "a.pptx",
      kind: "file",
      bytes: 10,
    });
    await expect(workspace().stat("l.txt")).rejects.toBeInstanceOf(
      WorkspacePathError,
    );
    await expect(
      workspace().stat("../outside/secret.txt"),
    ).rejects.toBeInstanceOf(WorkspacePathError);
  });

  test("a folder is reported as a folder, and a missing path is not found", async () => {
    await mkdir(join(root, "site"), { recursive: true });
    const folder = await workspace().stat("site");
    expect(folder.kind).toBe("folder");
    expect(folder.modifiedMs).toBeGreaterThan(0);
    await expect(workspace().stat("nope.md")).rejects.toBeInstanceOf(
      WorkspaceFileNotFoundError,
    );
  });
});
