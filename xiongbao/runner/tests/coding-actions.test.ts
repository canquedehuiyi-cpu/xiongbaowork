import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunnerExecutor } from "../src/execute";
import { createRootRegistry } from "../src/roots";

/*
 * 期五 D on a paired machine: `files.read` with a line range, `files.edit`, `files.grep` and
 * `files.glob`, in the runner's workspace and in a project's folder. An edit is a write: only in a
 * folder its owner registered `write`, and only when the server's frame says the project is
 * writable. A search is a read: a read-only folder may be searched.
 */

const scratch = mkdtempSync(join(tmpdir(), "runner-coding-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let made = 0;
function machine() {
  made += 1;
  const dataDir = join(scratch, `data-${made}`);
  const workspace = join(dataDir, "runner-workspace");
  const writable = join(scratch, `code-${made}`);
  const readable = join(scratch, `docs-${made}`);
  for (const dir of [workspace, writable, readable])
    mkdirSync(join(dir, "src"), { recursive: true });
  for (const dir of [workspace, writable, readable])
    writeFileSync(join(dir, "src", "app.ts"), "const a = 1;\nconst b = 2;\n");
  const registry = createRootRegistry({ dataDir, privatePaths: [dataDir] });
  const write = registry.add("代码", writable, "write");
  const read = registry.add("文档", readable);
  return {
    execute: createRunnerExecutor(workspace, undefined, registry),
    workspace,
    writable,
    readable,
    write,
    read,
  };
}

type Outcome = { ok: boolean; output?: unknown; error?: string };

describe("in the runner's workspace", () => {
  test("a line range, an edit, a content search and a search by name", async () => {
    const m = machine();
    const act = (action: string, payload: object) =>
      m.execute({ action, payload }) as Promise<Outcome>;

    expect(
      await act("files.read", { path: "src/app.ts", offset: 2, limit: 1 }),
    ).toMatchObject({
      ok: true,
      output: { text: "     2\tconst b = 2;\n", totalLines: 2 },
    });
    // Without a range, unchanged.
    expect(await act("files.read", { path: "src/app.ts" })).toMatchObject({
      output: { text: "const a = 1;\nconst b = 2;\n" },
    });

    expect(
      await act("files.edit", {
        path: "src/app.ts",
        old_string: "const b = 2;",
        new_string: "const b = 3;",
      }),
    ).toMatchObject({ ok: true, output: { edited: true, replacements: 1 } });
    expect(readFileSync(join(m.workspace, "src", "app.ts"), "utf8")).toBe(
      "const a = 1;\nconst b = 3;\n",
    );
    expect(
      await act("files.edit", {
        path: "src/app.ts",
        old_string: "const",
        new_string: "let",
      }),
    ).toMatchObject({ ok: true, output: { edited: false } });

    expect(await act("files.grep", { pattern: "b = 3" })).toMatchObject({
      ok: true,
      output: { matches: 1, text: "src/app.ts:2:const b = 3;" },
    });
    expect(await act("files.glob", { pattern: "**/*.ts" })).toMatchObject({
      ok: true,
      output: { paths: ["src/app.ts"] },
    });
    expect(await act("files.grep", {})).toEqual({
      ok: false,
      error: "A pattern is required.",
    });
    expect(await act("files.edit", { path: "src/app.ts" })).toEqual({
      ok: false,
      error: "old_string and new_string are required.",
    });
  });
});

describe("in a project's folder", () => {
  test("a writable project is edited when the frame says writable; never otherwise", async () => {
    const m = machine();
    const edit = {
      path: "src/app.ts",
      old_string: "const b = 2;",
      new_string: "const b = 4;",
    };
    const done = (await m.execute({
      action: "files.edit",
      payload: { ...edit, root: m.write.ref, writable: true },
    })) as Outcome;
    expect(done).toMatchObject({ ok: true, output: { edited: true } });
    expect(readFileSync(join(m.writable, "src", "app.ts"), "utf8")).toContain(
      "const b = 4;",
    );

    // The frame did not say writable: refused before the folder is touched.
    const unsaid = (await m.execute({
      action: "files.edit",
      payload: { ...edit, old_string: "const a = 1;", root: m.write.ref },
    })) as Outcome;
    expect(unsaid.ok).toBe(false);
    expect(unsaid.error).toContain("read-only");

    // A folder its owner registered for reading: refused even when the frame says writable.
    const readOnly = (await m.execute({
      action: "files.edit",
      payload: { ...edit, root: m.read.ref, writable: true },
    })) as Outcome;
    expect(readOnly.ok).toBe(false);
    expect(readOnly.error).toContain("registered it for reading only");
    expect(readFileSync(join(m.readable, "src", "app.ts"), "utf8")).toContain(
      "const b = 2;",
    );
  });

  test("a read-only folder may be read by line, searched by content and by name", async () => {
    const m = machine();
    const act = (action: string, payload: object) =>
      m.execute({
        action,
        payload: { ...payload, root: m.read.ref },
      }) as Promise<Outcome>;
    expect(
      await act("files.read", { path: "src/app.ts", offset: 1, limit: 1 }),
    ).toMatchObject({ ok: true, output: { text: "     1\tconst a = 1;\n" } });
    expect(await act("files.grep", { pattern: "const a" })).toMatchObject({
      ok: true,
      output: { text: "src/app.ts:1:const a = 1;" },
    });
    expect(await act("files.glob", { pattern: "src/*.ts" })).toMatchObject({
      ok: true,
      output: { paths: ["src/app.ts"] },
    });
  });
});
