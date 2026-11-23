import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isIgnoredArtifactPath } from "../../shared/turn-artifacts";
import {
  convertToPdf,
  PREVIEW_CACHE_DIR,
  pdfCachePath,
  shellWord,
} from "../src/office-preview";
import type { CommandRunner } from "../src/shell";
import { createWorkspace, WorkspacePathError } from "../src/workspace";

let base: string;
let root: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "office-preview-"));
  root = join(base, "workspace");
  await mkdir(root, { recursive: true });
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const result = (exitCode: number, extra: object = {}) => ({
  command: "",
  exitCode,
  stdout: "",
  stderr: "",
  truncated: false,
  timedOut: false,
  elapsedMs: 1,
  ...extra,
});

/** A stub that behaves like a successful soffice + mv by writing the cache file itself. */
function stubRunner(calls: string[], exit = 0): CommandRunner {
  return {
    async run(input) {
      calls.push(input.command);
      if (input.command.includes("soffice")) return result(exit);
      if (input.command.startsWith("'mv'")) {
        await mkdir(join(root, PREVIEW_CACHE_DIR), { recursive: true });
        const target =
          input.command.split(" ").at(-1)?.replaceAll("'", "") ?? "";
        await writeFile(join(root, target), "%PDF");
        return result(0);
      }
      return result(0);
    },
  };
}

describe("pdfCachePath", () => {
  test("an edit changes the cache path", () => {
    expect(pdfCachePath("a.pptx", 1)).not.toBe(pdfCachePath("a.pptx", 2));
    expect(pdfCachePath("a.pptx", 1)).toMatch(
      /^\.xb-preview\/[0-9a-f]{16}-1\.pdf$/,
    );
  });
  test("the cache folder is ignored as a turn artifact", () => {
    expect(isIgnoredArtifactPath(".xb-preview/x.pdf")).toBe(true);
  });
  test("shellWord keeps quotes and separators as data", () => {
    expect(shellWord("a b#;'c")).toBe(`'a b#;'\\''c'`);
  });
});

describe("convertToPdf", () => {
  test("second call is a cache hit", async () => {
    await writeFile(join(root, "my deck #1;'x'.pptx"), "x");
    const calls: string[] = [];
    const args = {
      workspace: createWorkspace(root),
      run: stubRunner(calls),
      path: "my deck #1;'x'.pptx",
    };
    const first = await convertToPdf(args);
    expect(first).toMatchObject({ cached: false });
    const used = calls.length;
    expect(
      calls.some((c) => c.includes(shellWord("my deck #1;'x'.pptx"))),
    ).toBe(true);
    const second = await convertToPdf(args);
    expect(second).toEqual({
      path: (first as { path: string }).path,
      cached: true,
    });
    expect(calls.length).toBe(used);
  });

  test("no soffice is unavailable", async () => {
    await writeFile(join(root, "a.docx"), "x");
    const calls: string[] = [];
    expect(
      await convertToPdf({
        workspace: createWorkspace(root),
        run: stubRunner(calls, 127),
        path: "a.docx",
      }),
    ).toEqual({ unavailable: true });
  });

  test("a failed conversion is an error", async () => {
    await writeFile(join(root, "a.docx"), "x");
    const run: CommandRunner = {
      async run(input) {
        return input.command.startsWith("'mv'")
          ? result(1)
          : result(0, { stderr: "boom" });
      },
    };
    await expect(
      convertToPdf({ workspace: createWorkspace(root), run, path: "a.docx" }),
    ).rejects.toThrow(/converted/);
  });

  test("a path outside the workspace is refused before any command", async () => {
    await writeFile(join(base, "secret.docx"), "x");
    await symlink(join(base, "secret.docx"), join(root, "l.docx"));
    const calls: string[] = [];
    for (const path of ["../secret.docx", "l.docx"]) {
      await expect(
        convertToPdf({
          workspace: createWorkspace(root),
          run: stubRunner(calls),
          path,
        }),
      ).rejects.toBeInstanceOf(WorkspacePathError);
    }
    expect(calls).toEqual([]);
  });

  test("two simultaneous requests share one conversion", async () => {
    await writeFile(join(root, "a.docx"), "x");
    const calls: string[] = [];
    const args = {
      workspace: createWorkspace(root),
      run: stubRunner(calls),
      path: "a.docx",
    };
    const [a, b] = await Promise.all([convertToPdf(args), convertToPdf(args)]);
    expect(a).toEqual(b);
    expect(calls.filter((c) => c.includes("soffice")).length).toBe(1);
  });
});

const hasSoffice = spawnSync("which", ["soffice"]).status === 0;
describe.skipIf(!hasSoffice)("real soffice", () => {
  test("converts a file with an awkward name", async () => {
    await writeFile(join(root, "a b #1.txt"), "hello preview");
    const { spawn } = await import("node:child_process");
    const run: CommandRunner = {
      run: (input) =>
        new Promise((resolve) => {
          const child = spawn("bash", ["-c", input.command], { cwd: root });
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (d) => {
            stdout += d;
          });
          child.stderr.on("data", (d) => {
            stderr += d;
          });
          child.on("close", (code) =>
            resolve(result(code ?? 1, { stdout, stderr })),
          );
        }),
    };
    const out = await convertToPdf({
      workspace: createWorkspace(root),
      run,
      path: "a b #1.txt",
    });
    expect(out).toMatchObject({ cached: false });
    const bytes = await readFile(join(root, (out as { path: string }).path));
    expect(bytes.subarray(0, 4).toString()).toBe("%PDF");
  }, 90_000);
});
