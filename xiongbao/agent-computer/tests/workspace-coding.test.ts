import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorkspace,
  DEFAULT_WORKSPACE_LIMITS,
  GLOB_LIMITS,
  SEARCH_LIMITS,
  WorkspacePathError,
} from "../src/workspace";

/**
 * 期五 D: the coding primitives on the workspace itself — a line range of a file, one passage of a
 * file replaced, a content search (rg, or grep without it) and a search by name — each confined to
 * the workspace like every other file call, in the shared workspace and in confined (per-employee)
 * mode alike.
 */

let base: string;
let root: string;
let outside: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "workspace-coding-"));
  root = join(base, "workspace");
  outside = join(base, "outside");
  await mkdir(join(root, "src", "lib"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "secret.ts"), "export const needle = 1;\n");
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const lines = (count: number) =>
  Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n") +
  "\n";

for (const confineOpened of [false, true]) {
  const mode = confineOpened ? "confined" : "shared";
  const workspace = (options: Parameters<typeof createWorkspace>[2] = {}) =>
    createWorkspace(root, DEFAULT_WORKSPACE_LIMITS, {
      confineOpened,
      ...options,
    });

  describe(`a line range (${mode})`, () => {
    test("without offset or limit a read is what it always was", async () => {
      await writeFile(join(root, "notes.md"), "a\nb\n");
      expect(await workspace().read("notes.md")).toEqual({
        path: "notes.md",
        text: "a\nb\n",
        truncated: false,
        bytes: 4,
      });
    });

    test("offset and limit return those lines, numbered, with where they sit", async () => {
      await writeFile(join(root, "big.txt"), lines(50));
      const read = await workspace().read("big.txt", { offset: 10, limit: 3 });
      expect(read.text).toBe(
        "    10\tline 10\n    11\tline 11\n    12\tline 12\n",
      );
      expect(read).toMatchObject({
        startLine: 10,
        endLine: 12,
        totalLines: 50,
        truncated: false,
      });
      // Only a limit: from the first line. Only an offset: to the end.
      expect((await workspace().read("big.txt", { limit: 2 })).text).toBe(
        "     1\tline 1\n     2\tline 2\n",
      );
      const tail = await workspace().read("big.txt", { offset: 49 });
      expect(tail.text).toBe("    49\tline 49\n    50\tline 50\n");
      // Past the end: nothing, and it says where the file ends.
      const past = await workspace().read("big.txt", { offset: 80, limit: 5 });
      expect(past).toMatchObject({ text: "", endLine: 79, totalLines: 50 });
    });

    test("a range larger than the read limit stops at the limit and says so", async () => {
      await writeFile(
        join(root, "wide.txt"),
        `${"x".repeat(1000)}\n`.repeat(200),
      );
      const read = await workspace().read("wide.txt", {
        offset: 1,
        limit: 200,
      });
      expect(read.truncated).toBe(true);
      expect(Buffer.byteLength(read.text)).toBeLessThanOrEqual(
        DEFAULT_WORKSPACE_LIMITS.readBytes,
      );
      expect(read.endLine).toBeLessThan(200);
    });
  });

  describe(`an edit (${mode})`, () => {
    beforeEach(async () => {
      await writeFile(
        join(root, "src", "app.ts"),
        "const a = 1;\nconst b = 2;\nconst a2 = 1;\n",
      );
    });
    const file = () => readFile(join(root, "src", "app.ts"), "utf8");

    test("a passage that is there once is replaced, and nothing else changes", async () => {
      const result = await workspace().edit(
        "src/app.ts",
        "const b = 2;",
        "const b = 3;",
      );
      expect(result).toMatchObject({
        path: "src/app.ts",
        edited: true,
        replacements: 1,
      });
      expect(await file()).toBe("const a = 1;\nconst b = 3;\nconst a2 = 1;\n");
    });

    test("a passage that is not there is answered in words and the file is untouched", async () => {
      const result = await workspace().edit("src/app.ts", "const c = 4;", "x");
      expect(result.edited).toBe(false);
      expect(result).toMatchObject({
        error: expect.stringContaining("没有找到 old_string"),
      });
      expect(await file()).toBe("const a = 1;\nconst b = 2;\nconst a2 = 1;\n");
    });

    test("a passage that is there twice is answered with how many, unless replace_all", async () => {
      const ambiguous = await workspace().edit("src/app.ts", "= 1;", "= 9;");
      expect(ambiguous).toMatchObject({
        edited: false,
        error: expect.stringContaining("出现了 2 次"),
      });
      expect(await file()).toContain("const a = 1;");
      const all = await workspace().edit("src/app.ts", "= 1;", "= 9;", {
        replaceAll: true,
      });
      expect(all).toMatchObject({ edited: true, replacements: 2 });
      expect(await file()).toBe("const a = 9;\nconst b = 2;\nconst a2 = 9;\n");
    });

    test("replacement text is taken as it is, `$&` and all", async () => {
      await workspace().edit("src/app.ts", "const b = 2;", "const b = '$&$1';");
      expect(await file()).toContain("const b = '$&$1';");
    });

    test("an empty or unchanged passage is answered, never thrown", async () => {
      expect(await workspace().edit("src/app.ts", "", "x")).toMatchObject({
        edited: false,
        error: expect.stringContaining("old_string 不能为空"),
      });
      expect(
        await workspace().edit("src/app.ts", "const b = 2;", "const b = 2;"),
      ).toMatchObject({ edited: false });
    });

    test("a file larger than a write may be is not edited", async () => {
      const small = createWorkspace(
        root,
        { ...DEFAULT_WORKSPACE_LIMITS, writeBytes: 16 },
        { confineOpened },
      );
      const result = await small.edit("src/app.ts", "const b = 2;", "x");
      expect(result).toMatchObject({
        edited: false,
        error: expect.stringContaining("超过按块编辑的上限"),
      });
      expect(await file()).toContain("const b = 2;");
    });

    test("a path outside the workspace is refused as every file call refuses it", async () => {
      await expect(
        workspace().edit("../outside/secret.ts", "needle", "x"),
      ).rejects.toBeInstanceOf(WorkspacePathError);
      await symlink(outside, join(root, "escape"));
      await expect(
        workspace().edit("escape/secret.ts", "needle", "x"),
      ).rejects.toBeInstanceOf(WorkspacePathError);
      expect(await readFile(join(outside, "secret.ts"), "utf8")).toContain(
        "needle",
      );
    });
  });

  describe(`a content search (${mode})`, () => {
    beforeEach(async () => {
      await writeFile(join(root, "src", "a.ts"), "export const Needle = 1;\n");
      await writeFile(join(root, "src", "lib", "b.md"), "a needle here\n");
      await writeFile(join(root, ".env"), "needle=secret\n");
      await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
      await writeFile(join(root, "node_modules", "pkg", "i.js"), "needle\n");
      await symlink(outside, join(root, "escape"));
    });

    // An rg that is not there: the search falls back to grep.
    const engines = {
      rg: {},
      grep: { searchTools: { rg: join(tmpdir(), "no-such-rg-for-this-test") } },
    };
    for (const [engine, options] of Object.entries(engines)) {
      test(`${engine}: finds the lines as path:line:text, skipping hidden files, node_modules and links out`, async () => {
        const found = await workspace(options).grep({ pattern: "needle" });
        expect(found).toMatchObject({ engine, matches: 1, truncated: false });
        expect("text" in found && found.text).toBe(
          "src/lib/b.md:1:a needle here",
        );
        const any = await workspace(options).grep({
          pattern: "needle",
          ignoreCase: true,
        });
        expect("text" in any && any.text.split("\n").sort()).toEqual([
          "src/a.ts:1:export const Needle = 1;",
          "src/lib/b.md:1:a needle here",
        ]);
        const typed = await workspace(options).grep({
          pattern: "needle",
          ignoreCase: true,
          glob: "*.ts",
        });
        expect("text" in typed && typed.text).toBe(
          "src/a.ts:1:export const Needle = 1;",
        );
      });

      test(`${engine}: a folder or a single file can be searched`, async () => {
        const folder = await workspace(options).grep({
          pattern: "needle",
          path: "src/lib",
        });
        expect("text" in folder && folder.text).toBe(
          "src/lib/b.md:1:a needle here",
        );
        const one = await workspace(options).grep({
          pattern: "Needle",
          path: "src/a.ts",
        });
        expect("text" in one && one.text).toBe(
          "src/a.ts:1:export const Needle = 1;",
        );
        await expect(
          workspace(options).grep({ pattern: "needle", path: "escape" }),
        ).rejects.toBeInstanceOf(WorkspacePathError);
      });

      test(`${engine}: more than ${SEARCH_LIMITS.matches} matches stop there and say so`, async () => {
        await writeFile(join(root, "many.txt"), "hit\n".repeat(300));
        const found = await workspace(options).grep({ pattern: "hit" });
        expect(found).toMatchObject({
          matches: SEARCH_LIMITS.matches,
          truncated: true,
        });
      });

      test(`${engine}: no match is an empty answer, a bad pattern is answered in words`, async () => {
        expect(
          await workspace(options).grep({ pattern: "absent-word" }),
        ).toMatchObject({ matches: 0, text: "", truncated: false });
        const bad = await workspace(options).grep({ pattern: "(" });
        expect(bad).toMatchObject({
          error: expect.stringContaining("搜索没有完成"),
        });
      });
    }

    test("output beyond 64 KB stops there and says so", async () => {
      await writeFile(
        join(root, "long.txt"),
        `hit ${"y".repeat(400)}\n`.repeat(190),
      );
      const found = await workspace().grep({ pattern: "hit" });
      expect(found).toMatchObject({ truncated: true });
      expect(
        "text" in found && Buffer.byteLength(found.text),
      ).toBeLessThanOrEqual(SEARCH_LIMITS.bytes);
    });

    test("a machine with neither rg nor grep is told so, not thrown at", async () => {
      const none = await workspace({
        searchTools: {
          rg: join(base, "no-such-rg"),
          grep: join(base, "no-such-grep"),
        },
      }).grep({ pattern: "needle" });
      expect(none).toMatchObject({
        error: "这台电脑上没有 rg，也没有 grep，没法搜索文件内容。",
      });
    });
  });

  describe(`a search by name (${mode})`, () => {
    test("matches the pattern, newest first, never in node_modules or through a link", async () => {
      const at = (name: string, minutesAgo: number) => {
        const when = new Date(Date.now() - minutesAgo * 60_000);
        return utimes(join(root, name), when, when);
      };
      await writeFile(join(root, "src", "old.ts"), "");
      await writeFile(join(root, "src", "lib", "new.ts"), "");
      await writeFile(join(root, "src", "mid.ts"), "");
      await writeFile(join(root, "src", "notes.md"), "");
      await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
      await writeFile(join(root, "node_modules", "pkg", "x.ts"), "");
      await symlink(outside, join(root, "escape"));
      await at("src/old.ts", 30);
      await at("src/mid.ts", 20);
      await at("src/lib/new.ts", 10);
      const found = await workspace().glob({ pattern: "**/*.ts" });
      expect(found).toEqual({
        pattern: "**/*.ts",
        path: ".",
        paths: ["src/lib/new.ts", "src/mid.ts", "src/old.ts"],
        truncated: false,
      });
      // Relative to a folder when one is given; paths still from the workspace.
      expect(
        await workspace().glob({ pattern: "*.ts", path: "src/lib" }),
      ).toMatchObject({ paths: ["src/lib/new.ts"] });
      // node_modules when the pattern asks for it.
      expect(
        await workspace().glob({ pattern: "node_modules/**/*.ts" }),
      ).toMatchObject({ paths: ["node_modules/pkg/x.ts"] });
    });

    test(`at most ${GLOB_LIMITS.paths} paths, and it says there were more`, async () => {
      await mkdir(join(root, "many"));
      await Promise.all(
        Array.from({ length: GLOB_LIMITS.paths + 20 }, (_, index) =>
          writeFile(join(root, "many", `f${index}.txt`), ""),
        ),
      );
      const found = await workspace().glob({ pattern: "many/*.txt" });
      expect("paths" in found && found.paths).toHaveLength(GLOB_LIMITS.paths);
      expect(found).toMatchObject({ truncated: true });
    });

    test("an empty pattern is answered; a folder outside is refused", async () => {
      expect(await workspace().glob({ pattern: " " })).toMatchObject({
        error: "pattern 不能为空。",
      });
      await expect(
        workspace().glob({ pattern: "*", path: "../outside" }),
      ).rejects.toBeInstanceOf(WorkspacePathError);
    });
  });
}
