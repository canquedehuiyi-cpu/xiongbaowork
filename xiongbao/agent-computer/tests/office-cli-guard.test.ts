import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkPath,
  GuardRefusal,
  guardInvocation,
  inspect,
  workspaceRoot,
} from "../office-cli/guard";

/**
 * The path guard in front of the LibreOffice command-line tool. The tool itself is replaced by a
 * small script that records what it was started with, so the suite needs no Python and no
 * LibreOffice; the last block runs the real tool when a path to it is given.
 */
const guardPath = join(import.meta.dir, "..", "office-cli", "guard.ts");

let base: string;
let root: string;
let outside: string;

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "office-cli-guard-")));
  root = join(base, "work");
  outside = join(base, "elsewhere");
  mkdirSync(join(root, "docs"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.json"), "{}");
  writeFileSync(join(root, "docs", "plan.json"), "{}");
  symlinkSync(outside, join(root, "escape-dir"));
  symlinkSync(join(outside, "secret.json"), join(root, "escape-file.json"));
  symlinkSync(join(outside, "not-yet.json"), join(root, "dangling.json"));
  symlinkSync(join(root, "docs"), join(root, "inside-link"));
  symlinkSync("loop-b", join(root, "loop-a"));
  symlinkSync("loop-a", join(root, "loop-b"));
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

const refused = (value: string) =>
  expect(() => checkPath(value, root, root)).toThrow(GuardRefusal);

describe("checkPath", () => {
  test("a new file and an existing file inside the workspace pass", () => {
    expect(checkPath("report.docx", root, root)).toBe(
      join(root, "report.docx"),
    );
    expect(checkPath("docs/plan.json", root, root)).toBe(
      join(root, "docs", "plan.json"),
    );
    expect(checkPath(join(root, "docs", "new", "deep.docx"), root, root)).toBe(
      join(root, "docs", "new", "deep.docx"),
    );
  });

  test("a relative path is read from the current directory, not from the root", () => {
    expect(checkPath("plan.json", root, join(root, "docs"))).toBe(
      join(root, "docs", "plan.json"),
    );
  });

  test("a symlink that stays inside the workspace passes", () => {
    expect(checkPath("inside-link/plan.json", root, root)).toBe(
      join(root, "docs", "plan.json"),
    );
  });

  test("a .. segment is refused even when it would land back inside", () => {
    refused("../elsewhere/secret.json");
    refused("docs/../../elsewhere/x.docx");
    refused("docs/../report.docx");
    refused("..");
  });

  test("an absolute path outside the workspace is refused", () => {
    refused("/etc/passwd");
    refused(join(outside, "x.docx"));
    refused(base);
  });

  test("the workspace's own sibling with the same prefix is outside", () => {
    mkdirSync(`${root}-extra`, { recursive: true });
    refused(join(`${root}-extra`, "x.docx"));
  });

  test("a symlink to a file outside is refused for reading and for writing", () => {
    refused("escape-file.json");
  });

  test("a new file below a symlinked directory that leaves the workspace is refused", () => {
    refused("escape-dir/out.docx");
    refused("escape-dir/nested/new/out.docx");
    expect(existsSync(join(outside, "nested"))).toBe(false);
  });

  test("a dangling symlink is refused because writing through it creates its target", () => {
    refused("dangling.json");
    expect(existsSync(join(outside, "not-yet.json"))).toBe(false);
  });

  test("a symlink loop is refused", () => {
    refused("loop-a");
  });

  test("an empty path, a NUL and a newline are refused", () => {
    refused("");
    refused("a\0b");
    refused("a\nb");
  });
});

describe("inspect: which arguments are paths", () => {
  test("the project option, in both spellings, before the command", () => {
    expect(inspect(["--project", "p.json", "document", "info"]).paths).toEqual([
      "p.json",
    ]);
    expect(
      inspect(["--json", "--project=p.json", "writer", "list"]).paths,
    ).toEqual(["p.json"]);
  });

  test("document new takes its path from -o, --output, --output= and -ofile", () => {
    for (const args of [
      ["document", "new", "-o", "a.json"],
      ["document", "new", "--output", "a.json"],
      ["document", "new", "--output=a.json"],
      ["document", "new", "-oa.json"],
      ["document", "new", "--type", "calc", "--name", "x", "-o", "a.json"],
    ])
      expect(inspect(args).paths).toEqual(["a.json"]);
  });

  test("document open, document save and export render take positional paths", () => {
    expect(inspect(["document", "open", "a.json"]).paths).toEqual(["a.json"]);
    expect(inspect(["document", "save", "b.json"]).paths).toEqual(["b.json"]);
    expect(inspect(["document", "save"]).paths).toEqual([]);
    expect(
      inspect([
        "export",
        "render",
        "out.docx",
        "--preset",
        "docx",
        "--overwrite",
      ]).paths,
    ).toEqual(["out.docx"]);
    // The value of --preset is not a path even when it is written like one.
    expect(
      inspect(["export", "render", "--preset", "/x", "o.pdf"]).paths,
    ).toEqual(["o.pdf"]);
  });

  test("values that only look like paths are not paths", () => {
    expect(
      inspect(["writer", "add-paragraph", "--text", "/etc/passwd"]).paths,
    ).toEqual([]);
    expect(inspect(["writer", "set-text", "0", "../../x"]).paths).toEqual([]);
    expect(inspect(["calc", "set-cell", "A1", "/tmp/a"]).paths).toEqual([]);
    expect(inspect(["document", "new", "--name", "../../x"]).paths).toEqual([]);
    expect(
      inspect(["style", "create", "S", "--prop", "color=/x"]).paths,
    ).toEqual([]);
  });

  test("a path command with an option it does not know is refused rather than guessed", () => {
    expect(() =>
      inspect(["export", "render", "o.pdf", "--tmpdir", "/x"]),
    ).toThrow(GuardRefusal);
    expect(() => inspect(["document", "new", "-o"])).toThrow(GuardRefusal);
    expect(() => inspect(["--project"])).toThrow(GuardRefusal);
  });

  test("a command the guard has not checked is refused, so a newer tool cannot slip a path in", () => {
    expect(() =>
      inspect(["document", "import", "/etc/passwd", "-o", "p.json"]),
    ).toThrow(GuardRefusal);
    expect(() => inspect(["writer", "add-image", "/etc/passwd"])).toThrow(
      GuardRefusal,
    );
    expect(() => inspect(["frobnicate", "x"])).toThrow(GuardRefusal);
    expect(inspect(["document", "--help"]).paths).toEqual([]);
    expect(inspect(["writer"]).paths).toEqual([]);
  });

  test("no command, or repl, means the REPL", () => {
    expect(inspect([]).repl).toBe(true);
    expect(inspect(["--project", "p.json"]).repl).toBe(true);
    expect(inspect(["repl", "--project", "p.json"])).toEqual({
      paths: ["p.json"],
      repl: true,
    });
    expect(inspect(["writer", "list"]).repl).toBe(false);
  });
});

describe("guardInvocation", () => {
  const run = (args: string[], stdinText: string | null = null) =>
    guardInvocation({ args, stdinText, root, cwd: root });

  test("a one-shot run inside the workspace passes untouched", () => {
    expect(
      run(["--project", "docs/plan.json", "export", "render", "o.docx"]),
    ).toBe(null);
  });

  test("a one-shot run outside the workspace is refused", () => {
    expect(() => run(["document", "new", "-o", "/tmp/x.json"])).toThrow(
      GuardRefusal,
    );
    expect(() => run(["--project", "../x.json", "document", "info"])).toThrow(
      GuardRefusal,
    );
    expect(() => run(["export", "render", "escape-dir/o.docx"])).toThrow(
      GuardRefusal,
    );
  });

  test("REPL lines are checked one by one, and paths in a later line are not missed", () => {
    const script = [
      "writer add-heading -t Title",
      "writer add-paragraph -t /etc/passwd",
      "document save docs/plan.json",
      "export render out.docx --preset docx",
      "exit",
    ].join("\n");
    expect(run(["repl", "--project", "docs/plan.json"], script)).toBe(script);
    for (const bad of [
      "document save /tmp/x.json",
      "export render escape-dir/o.docx --preset docx",
      "document open ../elsewhere/secret.json",
      "--project /etc/hosts document info",
      "document new -o /tmp/y.json",
    ])
      expect(() => run(["repl"], `writer list\n${bad}\nexit\n`)).toThrow(
        GuardRefusal,
      );
  });

  test("the REPL splits lines the way Python does, so odd spaces cannot hide a path", () => {
    // U+3000 and U+0085 separate words for Python's split(); a guard that only knew \s would miss them.
    expect(() => run(["repl"], "export　render　/tmp/x.docx\n")).toThrow(
      GuardRefusal,
    );
    expect(() => run(["repl"], "export render\u0085/tmp/x.docx\n")).toThrow(
      GuardRefusal,
    );
  });

  test("carriage returns, escapes and NULs in stdin are refused", () => {
    for (const text of [
      "writer list\rexport render /tmp/x.docx\n",
      "writer list\x1b[A\n",
      "writer list\0\n",
    ])
      expect(() => run(["repl"], text)).toThrow(GuardRefusal);
  });

  test("the REPL cannot be started by hand without stdin", () => {
    expect(() => run(["repl"], null)).toThrow(GuardRefusal);
    expect(() => run([], null)).toThrow(GuardRefusal);
  });
});

describe("workspaceRoot", () => {
  test("it is HOME, resolved, unless the override is set", () => {
    expect(workspaceRoot({ HOME: root })).toBe(root);
    expect(workspaceRoot({ HOME: "/", XIONGBAO_OFFICE_CLI_ROOT: root })).toBe(
      root,
    );
    expect(() => workspaceRoot({})).toThrow(GuardRefusal);
    expect(() => workspaceRoot({ HOME: "/" })).toThrow(GuardRefusal);
  });
});

describe("the program", () => {
  let fake: string;
  let log: string;

  beforeAll(() => {
    fake = join(base, "fake-tool.sh");
    log = join(base, "fake-tool.log");
    writeFileSync(
      fake,
      `#!/bin/sh\nprintf 'ARGS:%s\\n' "$*" >> "${log}"\ncat >> "${log}"\n`,
      { mode: 0o755 },
    );
  });

  const start = async (args: string[], stdin: string | null) => {
    const child = Bun.spawn(["bun", guardPath, ...args], {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: root,
        XIONGBAO_OFFICE_CLI_BIN: fake,
      },
      stdin: stdin === null ? "ignore" : new Blob([stdin]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, err] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    return { code, err };
  };

  test("a refused run exits 2, says why and never starts the tool", async () => {
    rmSync(log, { force: true });
    const result = await start(["document", "new", "-o", "/tmp/x.json"], null);
    expect(result.code).toBe(2);
    expect(result.err).toContain("路径不在工作区内");
    expect(existsSync(log)).toBe(false);
  });

  test("a passing run starts the tool with the same arguments and the same stdin", async () => {
    rmSync(log, { force: true });
    const script = "writer add-paragraph -t 你好\ndocument save p.json\nexit\n";
    const result = await start(["repl", "--project", "docs/plan.json"], script);
    expect(result.code).toBe(0);
    expect(readFileSync(log, "utf8")).toBe(
      `ARGS:repl --project docs/plan.json\n${script}`,
    );
  });

  test("a one-shot run does not wait for stdin", async () => {
    rmSync(log, { force: true });
    const result = await start(["export", "presets"], null);
    expect(result.code).toBe(0);
  });
});

const realTool = process.env.XIONGBAO_OFFICE_CLI_REAL_BIN;
describe.skipIf(!realTool)("with the real tool", () => {
  test("a document is built in the REPL and exported to .docx inside the workspace, and a write outside is refused", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "office-cli-real-")));
    try {
      const spawn = async (args: string[], stdin: string | null) => {
        const child = Bun.spawn(["bun", guardPath, ...args], {
          cwd: home,
          env: {
            PATH: process.env.PATH ?? "",
            HOME: home,
            XIONGBAO_OFFICE_CLI_BIN: realTool as string,
          },
          stdin: stdin === null ? "ignore" : new Blob([stdin]),
          stdout: "pipe",
          stderr: "pipe",
        });
        const [code, out] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
        ]);
        return { code, out };
      };
      expect(
        (await spawn(["document", "new", "-o", "r.json"], null)).code,
      ).toBe(0);
      const edit = await spawn(
        ["repl", "--project", "r.json"],
        [
          "writer add-heading -t Report",
          "writer add-paragraph -t body",
          "document save",
          "export render r.docx --preset docx --overwrite",
          "exit",
          "",
        ].join("\n"),
      );
      expect(edit.code).toBe(0);
      expect(existsSync(join(home, "r.docx"))).toBe(true);
      const outsideWrite = await spawn(
        ["repl", "--project", "r.json"],
        "export render /tmp/office-cli-escape.docx --preset docx\nexit\n",
      );
      expect(outsideWrite.code).toBe(2);
      expect(existsSync("/tmp/office-cli-escape.docx")).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
