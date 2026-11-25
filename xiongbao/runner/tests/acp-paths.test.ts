import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyPath, permissionFacts } from "../src/acp/paths";

/*
 * Whether a path an agent names is inside its working folder: decided on the device, after `..` and
 * symlinks are resolved, and reported upward without any absolute path.
 */

const scratch = mkdtempSync(join(tmpdir(), "xiongbao-runner-acp-paths-"));
const work = join(scratch, "work");
const elsewhere = join(scratch, "elsewhere");
mkdirSync(join(work, "src"), { recursive: true });
mkdirSync(elsewhere, { recursive: true });
symlinkSync(elsewhere, join(work, "escape"));
symlinkSync(work, join(scratch, "work-link"));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

test("dot-dot and symlink resolve before comparing", () => {
  const p = process.platform;
  expect(classifyPath(work, join(work, "src", "a.ts"), p)).toBe("inside");
  expect(classifyPath(work, "src/../notes.md", p)).toBe("inside");
  expect(classifyPath(work, join(work, "..", "elsewhere", "x"), p)).toBe(
    "outside",
  );
  // A link inside the folder that points out of it is outside.
  expect(classifyPath(work, join(work, "escape", "secret.txt"), p)).toBe(
    "outside",
  );
  expect(classifyPath(work, join(work, "escape", "new", "file.txt"), p)).toBe(
    "outside",
  );
  // The folder reached through a link is the same folder, and so is the folder itself.
  expect(classifyPath(join(scratch, "work-link"), join(work, "a"), p)).toBe(
    "inside",
  );
  expect(classifyPath(work, join(scratch, "work-link", "src"), p)).toBe(
    "inside",
  );
  expect(classifyPath(work, work, p)).toBe("inside");
  // A sibling sharing the folder's name as a prefix is not inside it.
  expect(classifyPath(work, `${work}-other/x`, p)).toBe("outside");
});

test("win32 compares case-insensitively", () => {
  expect(
    classifyPath("C:\\Code\\x", "c:\\code\\x\\..\\x\\a.txt", "win32"),
  ).toBe("inside");
  expect(classifyPath("C:\\Code\\x", "C:\\CODE\\X", "win32")).toBe("inside");
  expect(classifyPath("C:\\Code\\x", "c:\\code\\y\\a.txt", "win32")).toBe(
    "outside",
  );
  expect(classifyPath("C:\\Code\\x", "D:\\Code\\x\\a.txt", "win32")).toBe(
    "outside",
  );
  // Case still matters where the platform says it does.
  expect(classifyPath("/Code/x", "/code/x/a.txt", "linux")).toBe("outside");
});

test("facts carry relative paths or bare file names, never absolute paths", () => {
  const facts = permissionFacts(
    work,
    {
      toolCallId: "call_1",
      kind: "edit",
      locations: [{ path: join(work, "src", "a.ts") }, { path: "notes.md" }],
      content: [
        {
          type: "diff",
          path: join(elsewhere, "secret.txt"),
          oldText: "a",
          newText: "b",
        },
      ],
      rawInput: { file_path: join(work, "src", "a.ts") },
    },
    process.platform,
  );
  expect(facts).toEqual({
    insideWorkdir: false,
    paths: ["src/a.ts", "notes.md", "secret.txt"],
  });
  expect(facts.paths.some((path) => path.includes(scratch))).toBe(false);

  expect(
    permissionFacts(
      work,
      { kind: "edit", locations: [{ path: join(work, "a") }] },
      process.platform,
    ),
  ).toEqual({ insideWorkdir: true, paths: ["a"] });
});

test("a tool call naming no path has insideWorkdir null", () => {
  expect(
    permissionFacts(
      work,
      { kind: "execute", rawInput: { command: "ls" } },
      process.platform,
    ),
  ).toEqual({ insideWorkdir: null, paths: [] });
  expect(permissionFacts(work, null, process.platform)).toEqual({
    insideWorkdir: null,
    paths: [],
  });
});

test("the folder a command runs in counts: cwd, workdir, directory, as a string or a list", () => {
  const run = (rawInput: Record<string, unknown>) =>
    permissionFacts(work, { kind: "execute", rawInput }, process.platform);
  expect(run({ command: "make", cwd: elsewhere }).insideWorkdir).toBe(false);
  expect(run({ command: ["cat", "x"], workdir: elsewhere }).insideWorkdir).toBe(
    false,
  );
  expect(
    run({ command: "git status", directory: [join(work, "src"), elsewhere] })
      .insideWorkdir,
  ).toBe(false);
  expect(run({ command: "ls", cwd: join(work, "src") })).toEqual({
    insideWorkdir: true,
    paths: ["src"],
  });
  expect(run({ command: "ls", workdir: work })).toEqual({
    insideWorkdir: true,
    paths: ["."],
  });
});
