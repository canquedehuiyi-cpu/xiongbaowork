import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspace, WorkspacePathError } from "../src/workspace";

/**
 * One employee's files, against an employee who swaps a directory for a link between the check and
 * the open.
 *
 * In per-employee mode the file tools run as the computer's own user, which can reach every
 * employee's directory, while the paths inside an employee's directory are that employee's to change.
 * A check on the path and then an open by the path leaves a window in which `d` is a real directory
 * for the check and a link to another employee's directory for the open. The hook below makes that
 * window certain rather than a race: it swaps `d` just before the open.
 */

let base: string;
let mine: string;
let theirs: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "openbot-confined-"));
  mine = join(base, "bots", "aaaaaaaaaaaa");
  theirs = join(base, "bots", "bbbbbbbbbbbb");
  await mkdir(join(mine, "d"), { recursive: true });
  await mkdir(theirs, { recursive: true });
  await writeFile(join(mine, "d", "x.txt"), "mine");
  await writeFile(join(theirs, "x.txt"), "THEIR SECRET");
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

/**
 * Swaps `d` for a link to the other employee's directory, the first time anything under it is about
 * to be opened, or only when `at` (relative to the employee's directory) is.
 */
function swapping(at?: string) {
  let swapped = false;
  return createWorkspace(mine, undefined, {
    confineOpened: true,
    beforeOpen: async (path) => {
      if (swapped) return;
      if (
        at === undefined
          ? !path.startsWith(join(mine, "d"))
          : path !== join(mine, at)
      )
        return;
      swapped = true;
      await rename(join(mine, "d"), join(mine, "d.real"));
      await symlink(theirs, join(mine, "d"));
    },
  });
}

const confined = () =>
  createWorkspace(mine, undefined, { confineOpened: true });

async function theirFiles() {
  return execFileSync("ls", ["-A", theirs], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .sort();
}

describe("a directory swapped for a link between the check and the open", () => {
  test("a read is refused", async () => {
    await expect(swapping().read("d/x.txt")).rejects.toBeInstanceOf(
      WorkspacePathError,
    );
  });

  test("a download is refused", async () => {
    await expect(swapping().download("d/x.txt")).rejects.toBeInstanceOf(
      WorkspacePathError,
    );
  });

  test("a listing of it is refused", async () => {
    await expect(swapping().list("d")).rejects.toBeInstanceOf(
      WorkspacePathError,
    );
  });

  test("a listing that walks into it does not show the other employee's files", async () => {
    const listed = await swapping()
      .list(".")
      .catch((error) => error);
    if (listed instanceof Error) {
      expect(listed).toBeInstanceOf(WorkspacePathError);
      return;
    }
    expect(listed.entries.map((entry) => entry.path)).not.toContain("d/x.txt");
  });

  test("overwriting an existing file is refused, and their file is untouched", async () => {
    await expect(
      swapping().write("d/x.txt", "overwritten"),
    ).rejects.toBeInstanceOf(WorkspacePathError);
    expect(await readFile(join(theirs, "x.txt"), "utf8")).toBe("THEIR SECRET");
  });

  test("appending is refused, and their file is untouched", async () => {
    await expect(
      swapping().write("d/x.txt", "appended", { append: true }),
    ).rejects.toBeInstanceOf(WorkspacePathError);
    expect(await readFile(join(theirs, "x.txt"), "utf8")).toBe("THEIR SECRET");
  });

  test("creating a new file is refused, and nothing is left behind in their directory", async () => {
    await expect(
      swapping().write("d/new.txt", "planted"),
    ).rejects.toBeInstanceOf(WorkspacePathError);
    expect(await theirFiles()).toEqual(["x.txt"]);
  });

  test.each([
    ["overwriting", "d/x.txt"],
    ["creating", "d/new.txt"],
  ])(
    "%s a file swapped at the file itself is refused, and their directory is as it was",
    async (_, path) => {
      await expect(
        swapping(path).write(path, "planted"),
      ).rejects.toBeInstanceOf(WorkspacePathError);
      expect(await readFile(join(theirs, "x.txt"), "utf8")).toBe(
        "THEIR SECRET",
      );
      expect(await theirFiles()).toEqual(["x.txt"]);
    },
  );

  test("a read swapped at the file itself is refused", async () => {
    await expect(swapping("d/x.txt").read("d/x.txt")).rejects.toBeInstanceOf(
      WorkspacePathError,
    );
  });

  test("creating a new folder and file is refused, and nothing is left behind in their directory", async () => {
    await expect(
      swapping().write("d/sub/new.txt", "planted"),
    ).rejects.toBeInstanceOf(WorkspacePathError);
    expect(await theirFiles()).toEqual(["x.txt"]);
  });
});

describe("the confined workspace, with nobody racing it", () => {
  test("reads, writes, appends, lists and downloads its own files", async () => {
    const ws = confined();
    expect((await ws.read("d/x.txt")).text).toBe("mine");
    await ws.write("notes/today.txt", "one");
    await ws.write("notes/today.txt", " two", { append: true });
    expect((await ws.read("notes/today.txt")).text).toBe("one two");
    await ws.write("notes/today.txt", "short");
    expect(await readFile(join(mine, "notes", "today.txt"), "utf8")).toBe(
      "short",
    );
    const listed = await ws.list();
    expect(listed.entries.map((entry) => entry.path).sort()).toEqual([
      "d",
      "d/x.txt",
      "notes",
      "notes/today.txt",
    ]);
    expect(listed.entries.find((entry) => entry.path === "d/x.txt")).toEqual({
      path: "d/x.txt",
      kind: "file",
      bytes: 4,
    });
    const download = await ws.download("d/x.txt");
    expect(download.bytes).toBe(4);
    expect(await new Response(download.body).text()).toBe("mine");
  });

  test("a link that points back inside still works", async () => {
    await symlink(join(mine, "d"), join(mine, "alias"));
    expect((await confined().read("alias/x.txt")).text).toBe("mine");
  });

  test("a link that already points outside is refused, as before", async () => {
    await symlink(theirs, join(mine, "away"));
    await expect(confined().read("away/x.txt")).rejects.toBeInstanceOf(
      WorkspacePathError,
    );
    await expect(confined().write("away/x.txt", "no")).rejects.toBeInstanceOf(
      WorkspacePathError,
    );
    expect(await readFile(join(theirs, "x.txt"), "utf8")).toBe("THEIR SECRET");
  });

  test("a named pipe neither hangs a read nor a write", async () => {
    execFileSync("mkfifo", [join(mine, "pipe")]);
    const ws = confined();
    await expect(ws.read("pipe")).rejects.toThrow();
    await expect(ws.write("pipe", "x")).rejects.toThrow();
    expect((await stat(join(mine, "pipe"))).isFIFO()).toBe(true);
  });
});
