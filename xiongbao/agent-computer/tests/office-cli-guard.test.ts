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

  test("the REPL cuts a line on Python's whitespace, not on the regular expression's", () => {
    // U+3000 separates words for Python's split(), so a path after it is seen.
    expect(() => run(["repl"], "export　render　/tmp/x.docx\n")).toThrow(
      GuardRefusal,
    );
    // A byte-order mark does not: Python keeps it inside the word, so this is one relative path
    // that starts with the mark. A guard that cut on `\s` would see the absolute path after it.
    expect(run(["repl"], `document save ﻿/etc/x.json\nexit\n`)).toBeString();
  });

  test("a Tab is refused: the tool's terminal library reads it as a key and inserts nothing", () => {
    // `.<Tab>./x` is two words to a whitespace split and `../x` to the tool.
    expect(() =>
      run(["repl"], "document save .\t./escaped.json\nexit\n"),
    ).toThrow(GuardRefusal);
    expect(() =>
      run(["repl"], "export render .\t./x.docx --preset docx\n"),
    ).toThrow(GuardRefusal);
    expect(() => run(["repl"], "document save a\tb.json\n")).toThrow(
      GuardRefusal,
    );
  });

  test("every control character is refused, the line end is not, and CRLF is made LF", () => {
    for (let code = 0; code < 0x20; code++) {
      if (code === 0x0a || code === 0x0d) continue;
      expect(() =>
        run(["repl"], `writer list${String.fromCharCode(code)}x\n`),
      ).toThrow(GuardRefusal);
    }
    for (const text of [
      "writer list\x1b[A\n",
      "writer list\rexport render /tmp/x.docx\n",
      "writer list\x7f\n",
      "writer list\x85\n",
      "writer list\x9b\n",
      "writer list export render /tmp/x.docx\n",
    ])
      expect(() => run(["repl"], text)).toThrow(GuardRefusal);
    expect(run(["repl"], "writer list\r\nexit\r\n")).toBe(
      "writer list\nexit\n",
    );
  });

  test("the REPL cannot be started by hand without stdin", () => {
    expect(() => run(["repl"], null)).toThrow(GuardRefusal);
    expect(() => run([], null)).toThrow(GuardRefusal);
  });

  test("export render accepts -p for the preset and checks the path beside it", () => {
    expect(run(["export", "render", "-p", "docx", "ok.docx"])).toBe(null);
    expect(run(["export", "render", "-pdocx", "ok.docx"])).toBe(null);
    expect(() =>
      run(["export", "render", "-p", "docx", "/tmp/x.docx"]),
    ).toThrow(GuardRefusal);
  });
});

describe("a project that names files", () => {
  const writeProject = (name: string, content: unknown) => {
    writeFileSync(join(root, name), JSON.stringify(content));
    return name;
  };
  const run = (args: string[], stdinText: string | null = null) =>
    guardInvocation({ args, stdinText, root, cwd: root });

  test("an image reference is refused on export, on --project, on document open and in the REPL", () => {
    const name = writeProject("with-image.json", {
      type: "writer",
      content: [{ type: "image_ref", path: join(outside, "secret.png") }],
    });
    expect(() => run(["--project", name, "export", "render", "o.pdf"])).toThrow(
      "图片引用",
    );
    expect(() => run(["document", "open", name])).toThrow(GuardRefusal);
    expect(() => run(["repl", "--project", name], "exit\n")).toThrow(
      GuardRefusal,
    );
    expect(() => run(["repl"], `document open ${name}\nexit\n`)).toThrow(
      GuardRefusal,
    );
  });

  test("a path-like field anywhere in the project is refused, however deep", () => {
    for (const [index, field] of [
      { path: "x" },
      { href: "http://example.com/a" },
      { src: "x" },
      { url: "file:///etc/passwd" },
      { file: "x" },
      { file_path: "x" },
      { "xlink:href": "x" },
    ].entries()) {
      const name = writeProject(`deep-${index}.json`, {
        type: "impress",
        slides: [{ title: "t", elements: [field] }],
      });
      expect(() => run(["--project", name, "document", "info"])).toThrow(
        GuardRefusal,
      );
    }
  });

  test("an ordinary project passes, including words that only contain those names", () => {
    const name = writeProject("plain.json", {
      type: "writer",
      name: "Report on the profile of files",
      metadata: { title: "path to growth", software: "libreoffice-cli 1.0" },
      content: [
        { type: "heading", level: 1, text: "Title /etc/passwd" },
        {
          type: "paragraph",
          text: "see https://example.com/file.png",
          style: {},
        },
        { type: "table", rows: 1, cols: 1, data: [["profile"]] },
      ],
    });
    expect(run(["--project", name, "export", "render", "o.docx"])).toBe(null);
  });

  test("a project that is missing, or not JSON, is left to the tool", () => {
    writeFileSync(join(root, "not-json.json"), "{ nope");
    expect(run(["--project", "not-json.json", "document", "info"])).toBe(null);
    expect(run(["--project", "absent.json", "document", "info"])).toBe(null);
  });
});

describe("workspaceRoot", () => {
  test("a per-employee account's home under the bots folder is the root", () => {
    const bots = join(base, "bots");
    const home = join(bots, "alice");
    mkdirSync(home, { recursive: true });
    expect(workspaceRoot({ accountHome: home, bots, shared: root })).toBe(home);
  });

  test("any other account works in the shared workspace", () => {
    const bots = join(base, "bots");
    mkdirSync(bots, { recursive: true });
    expect(workspaceRoot({ accountHome: "/root", bots, shared: root })).toBe(
      root,
    );
    expect(workspaceRoot({ accountHome: "", bots, shared: root })).toBe(root);
    // A directory beside the bots folder, or one nested below an employee's, is not an employee's own.
    expect(
      workspaceRoot({
        accountHome: join(base, "elsewhere"),
        bots,
        shared: root,
      }),
    ).toBe(root);
    mkdirSync(join(bots, "alice", "deeper"), { recursive: true });
    expect(
      workspaceRoot({
        accountHome: join(bots, "alice", "deeper"),
        bots,
        shared: root,
      }),
    ).toBe(root);
  });

  test("a missing shared workspace, or / , is refused", () => {
    expect(() =>
      workspaceRoot({ accountHome: "", shared: join(base, "no-such") }),
    ).toThrow(GuardRefusal);
    expect(() => workspaceRoot({ accountHome: "", shared: "/" })).toThrow(
      GuardRefusal,
    );
  });

  test("it does not read the environment", () => {
    const before = process.env.HOME;
    process.env.HOME = outside;
    process.env.XIONGBAO_OFFICE_CLI_ROOT = outside;
    try {
      expect(workspaceRoot({ accountHome: "", shared: root })).toBe(root);
    } finally {
      process.env.HOME = before;
      delete process.env.XIONGBAO_OFFICE_CLI_ROOT;
    }
  });
});

describe("the program", () => {
  let fake: string;
  let log: string;
  let runner: string;

  beforeAll(() => {
    fake = join(base, "fake-tool.sh");
    log = join(base, "fake-tool.log");
    writeFileSync(
      fake,
      `#!/bin/sh\nprintf 'HOME:%s\\nARGS:%s\\n' "$HOME" "$*" >> "${log}"\ncat >> "${log}"\n`,
      { mode: 0o755 },
    );
    // The program with its tool and root passed in, as the production entry cannot take them.
    runner = join(base, "runner.ts");
    writeFileSync(
      runner,
      `import { main } from ${JSON.stringify(guardPath)};
const [bin, rootDir, ...args] = process.argv.slice(2);
process.exit(await main(args, () => ({
  bin: bin as string,
  root: rootDir as string,
  cwd: process.cwd(),
  readStdin: async () => await new Response(Bun.stdin.stream()).text(),
})));
`,
    );
  });

  const spawn = async (
    cmd: string[],
    options: {
      cwd?: string;
      env?: Record<string, string>;
      stdin: string | null;
    },
  ) => {
    const child = Bun.spawn(cmd, {
      cwd: options.cwd ?? root,
      env: { PATH: process.env.PATH ?? "", ...options.env },
      stdin: options.stdin === null ? "ignore" : new Blob([options.stdin]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, out, err };
  };

  const start = (args: string[], stdin: string | null, cwd = root) =>
    spawn(["bun", runner, fake, root, ...args], { cwd, stdin });

  test("a refused run exits 2, says why and never starts the tool", async () => {
    rmSync(log, { force: true });
    const result = await start(["document", "new", "-o", "/tmp/x.json"], null);
    expect(result.code).toBe(2);
    expect(result.err).toContain("路径不在工作区内");
    expect(existsSync(log)).toBe(false);
  });

  test("a run from a directory outside the workspace is refused", async () => {
    rmSync(log, { force: true });
    const result = await start(["writer", "list"], null, outside);
    expect(result.code).toBe(2);
    expect(result.err).toContain("当前目录不在工作区内");
    expect(existsSync(log)).toBe(false);
  });

  test("a passing run starts the tool with the same arguments and the same stdin, and its own HOME", async () => {
    rmSync(log, { force: true });
    const script = "writer add-paragraph -t 你好\ndocument save p.json\nexit\n";
    const result = await start(["repl", "--project", "docs/plan.json"], script);
    expect(result.code).toBe(0);
    const text = readFileSync(log, "utf8");
    expect(text).toContain(`ARGS:repl --project docs/plan.json\n${script}`);
    // Its history and profile go to a folder made for the run, not into the employee's folder.
    const home = /^HOME:(.*)$/m.exec(text)?.[1] ?? "";
    expect(home).not.toBe("");
    expect(home.startsWith(root)).toBe(false);
    expect(existsSync(home)).toBe(false);
  });

  test("a one-shot run does not wait for stdin", async () => {
    rmSync(log, { force: true });
    const result = await start(["export", "presets"], null);
    expect(result.code).toBe(0);
  });

  test("environment variables in front of the command change neither the root nor the tool", async () => {
    rmSync(log, { force: true });
    // The program as shipped: root from the account and a constant, the tool at a fixed path.
    const result = await spawn(
      ["bun", guardPath, "document", "new", "-o", "x.json"],
      {
        cwd: outside,
        env: {
          HOME: outside,
          XIONGBAO_OFFICE_CLI_ROOT: outside,
          XIONGBAO_OFFICE_CLI_BIN: fake,
        },
        stdin: null,
      },
    );
    expect(result.code).toBe(2);
    expect(result.err).toContain("/workspace");
    expect(existsSync(log)).toBe(false);
    expect(existsSync(join(outside, "x.json"))).toBe(false);
  });
});

describe("the launcher", () => {
  const launcherSource = readFileSync(
    join(import.meta.dir, "..", "..", "docker", "office-cli", "xb-office-cli"),
    "utf8",
  );

  /** The launcher with its /opt and bun paths pointed at a test folder, otherwise as shipped. */
  function installLauncher(bunfigText: string): {
    launcher: string;
    folder: string;
  } {
    const folder = join(
      base,
      `launcher-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "bunfig.toml"), "");
    // A guard stand-in that reports whether the workspace's bunfig ran and what environment it got.
    writeFileSync(
      join(folder, "guard.ts"),
      `console.log("ENV:" + JSON.stringify({ root: process.env.XIONGBAO_OFFICE_CLI_ROOT ?? null, bin: process.env.XIONGBAO_OFFICE_CLI_BIN ?? null, opts: process.env.BUN_OPTIONS ?? null, dot: process.env.FROM_DOTENV ?? null }));\n`,
    );
    const launcher = join(folder, "xb-office-cli");
    writeFileSync(
      launcher,
      launcherSource
        .replaceAll("/opt/xiongbao-office-cli", folder)
        .replace("/usr/local/bin/bun", process.execPath),
      { mode: 0o755 },
    );
    // The workspace the employee runs in, with its own bunfig.toml and .env.
    const workspace = join(folder, "workspace");
    mkdirSync(workspace);
    writeFileSync(join(workspace, "bunfig.toml"), bunfigText);
    writeFileSync(
      join(workspace, "evil.ts"),
      `require("node:fs").writeFileSync(${JSON.stringify(join(folder, "PWNED"))}, "x");\n`,
    );
    writeFileSync(join(workspace, ".env"), "FROM_DOTENV=1\n");
    return { launcher, folder };
  }

  test("a bunfig.toml with a preload, a .env and prefixed variables in the workspace do not reach the guard", async () => {
    const { launcher, folder } = installLauncher(`preload = ["./evil.ts"]\n`);
    const workspace = join(folder, "workspace");
    const child = Bun.spawn(["sh", launcher, "writer", "list"], {
      cwd: workspace,
      env: {
        PATH: process.env.PATH ?? "",
        XIONGBAO_OFFICE_CLI_ROOT: "/",
        XIONGBAO_OFFICE_CLI_BIN: "/bin/true",
        BUN_OPTIONS: `--preload=${join(workspace, "evil.ts")}`,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, out] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
    ]);
    expect(code).toBe(0);
    expect(existsSync(join(folder, "PWNED"))).toBe(false);
    expect(out).toContain(
      'ENV:{"root":null,"bin":null,"opts":null,"dot":null}',
    );
  });

  test("the same setup does run the workspace's preload when the launcher's protections are left out", async () => {
    // The control for the test above: without --config the preload runs, so the protection is what stops it.
    const { folder } = installLauncher(`preload = ["./evil.ts"]\n`);
    const workspace = join(folder, "workspace");
    const child = Bun.spawn([process.execPath, join(folder, "guard.ts")], {
      cwd: workspace,
      env: { PATH: process.env.PATH ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    await child.exited;
    expect(existsSync(join(folder, "PWNED"))).toBe(true);
  });

  test("it starts the guard from a clean environment under a root-owned bunfig", () => {
    expect(launcherSource).toContain("env -i");
    expect(launcherSource).toContain(
      "--config=/opt/xiongbao-office-cli/bunfig.toml",
    );
    expect(launcherSource).toContain("--no-env-file");
    expect(launcherSource).toContain("/opt/xiongbao-office-cli/guard.ts");
  });
});

const realTool = process.env.XIONGBAO_OFFICE_CLI_REAL_BIN;
describe.skipIf(!realTool)("with the real tool", () => {
  const toolRunner = (home: string) => {
    const file = join(
      home,
      "..",
      `real-runner-${Math.random().toString(36).slice(2)}.ts`,
    );
    writeFileSync(
      file,
      `import { main } from ${JSON.stringify(guardPath)};
process.exit(await main(process.argv.slice(2), () => ({
  bin: ${JSON.stringify(realTool)},
  root: ${JSON.stringify(home)},
  cwd: process.cwd(),
  readStdin: async () => await new Response(Bun.stdin.stream()).text(),
})));
`,
    );
    return file;
  };

  const through = async (
    home: string,
    args: string[],
    stdin: string | null,
  ) => {
    const child = Bun.spawn(["bun", toolRunner(home), ...args], {
      cwd: home,
      env: { PATH: process.env.PATH ?? "" },
      stdin: stdin === null ? "ignore" : new Blob([stdin]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, out, err };
  };

  test("a document is built in the REPL and exported to .docx inside the workspace, and a write outside is refused", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "office-cli-real-")));
    try {
      expect(
        (await through(home, ["document", "new", "-o", "r.json"], null)).code,
      ).toBe(0);
      const edit = await through(
        home,
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
      // Nothing of the tool's own is left in the employee's folder (its history file lives under HOME).
      expect(existsSync(join(home, ".cli-anything-libreoffice"))).toBe(false);
      const outsideWrite = await through(
        home,
        ["repl", "--project", "r.json"],
        "export render /tmp/office-cli-escape.docx --preset docx\nexit\n",
      );
      expect(outsideWrite.code).toBe(2);
      expect(existsSync("/tmp/office-cli-escape.docx")).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a Tab in the REPL can no longer write above the workspace", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "office-cli-real-")));
    const work = join(home, "work");
    mkdirSync(work);
    try {
      expect(
        (await through(work, ["document", "new", "-o", "p.json"], null)).code,
      ).toBe(0);
      const attempt = await through(
        work,
        ["repl", "--project", "p.json"],
        "document save .\t./escaped.json\nexit\n",
      );
      expect(attempt.code).toBe(2);
      expect(existsSync(join(home, "escaped.json"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a project with an image outside the workspace is refused instead of exported", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "office-cli-real-")));
    const work = join(home, "work");
    mkdirSync(work);
    try {
      expect(
        (await through(work, ["document", "new", "-o", "p.json"], null)).code,
      ).toBe(0);
      const project = JSON.parse(readFileSync(join(work, "p.json"), "utf8"));
      project.content = [{ type: "image_ref", path: join(home, "secret.png") }];
      writeFileSync(join(work, "p.json"), JSON.stringify(project));
      const attempt = await through(
        work,
        ["--project", "p.json", "export", "render", "o.pdf"],
        null,
      );
      expect(attempt.code).toBe(2);
      expect(existsSync(join(work, "o.pdf"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
