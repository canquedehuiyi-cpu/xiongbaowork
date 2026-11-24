#!/usr/bin/env bun
/**
 * Path guard in front of the LibreOffice command-line tool (CLI-Anything's `cli-anything-libreoffice`).
 *
 * The tool writes wherever it is told to: `document new -o /etc/x.json` creates the file, and
 * `export render /anywhere.docx` overwrites with `--overwrite`. A Bot's computer runs it through
 * `computer_run_command`, which is approved like any other command; this guard adds one more line
 * of defence for the mistake or the injected instruction that names a path outside the employee's
 * own folder. It is not a sandbox: the approval and the per-employee user are the boundary, and the
 * guard only refuses the obvious escapes before the real tool is started.
 *
 * What it checks, for every path the tool would open or write:
 *   - no `..` segment at all (a lexical collapse of `link/..` disagrees with what the kernel does),
 *   - the path's real location, found with realpath on the deepest part that exists, is inside the
 *     workspace root, so a symlink that leaves the root is refused, and so is a new file whose
 *     parent directory is such a symlink,
 *   - a symlink that points nowhere is refused, because writing through it creates its target.
 *
 * Which arguments are paths is decided by the tool's own grammar (see {@link inspect}), not by what
 * a value looks like: `writer add-paragraph --text /etc/passwd` is a paragraph, not a path.
 *
 * The tool's one-shot commands do not keep edits between processes (each run loads the project,
 * changes it in memory and exits), so real editing goes through `repl` with commands on stdin. Those
 * lines name paths too, so stdin is read in full and checked line by line before it is handed on.
 */
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

export class GuardRefusal extends Error {}

/**
 * Python's `str.split()` whitespace, which is how the tool's REPL cuts a line into arguments. Not
 * the same set as the regular expression class `\s`: it has the information separators and NEL, and
 * not the byte-order mark.
 */
const PYTHON_WHITESPACE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the separators are control characters
  /[\t-\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/u;

const DEFAULT_BIN =
  "/opt/xiongbao-office-cli/venv/bin/cli-anything-libreoffice";

/**
 * Where the employee's own folder is, decided from the account the process runs as (its entry in the
 * passwd file, see {@link passwdHome}) and a constant. The caller supplies `accountHome`; nothing
 * here reads the environment, because a command can prefix any variable. With per-employee users the account's home directory is `/workspace/bots/<key>` (see
 * `docker/xb-bot.sh`), which is also where the command shell starts; without them every employee
 * works in `/workspace`.
 */
export function workspaceRoot(options: {
  accountHome: string;
  bots?: string;
  shared?: string;
}): string {
  const bots = options.bots ?? "/workspace/bots";
  const shared = options.shared ?? "/workspace";
  let configured = shared;
  try {
    const home = realpathSync(options.accountHome);
    if (dirname(home) === realpathSync(bots)) configured = home;
  } catch {
    // No such home or no bots directory: the shared workspace is the root.
  }
  let real: string;
  try {
    real = realpathSync(configured);
  } catch {
    throw new GuardRefusal(`找不到工作区根目录（${configured}）。`);
  }
  if (real === sep) throw new GuardRefusal("工作区根目录不能是 /。");
  return real;
}

function isInside(real: string, root: string): boolean {
  return real === root || real.startsWith(root + sep);
}

/**
 * The real location of `value`, for a path that may not exist yet (a file about to be written).
 * Throws {@link GuardRefusal} when it is not inside `root`.
 */
export function checkPath(value: string, root: string, cwd: string): string {
  if (value === "") throw new GuardRefusal("路径参数是空的。");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
  if (/[\x00-\x1f\x7f]/.test(value))
    throw new GuardRefusal(`路径里有控制字符：${JSON.stringify(value)}`);
  if (value.split(/[\\/]/).includes(".."))
    throw new GuardRefusal(`路径里不能有 ..：${value}`);

  const absolute = isAbsolute(value) ? resolve(value) : resolve(cwd, value);
  // Walk up to the deepest ancestor that exists; what is below it does not exist, so nothing there
  // can be a symlink, except one that dangles, which `lstat` still sees.
  let existing = absolute;
  const tail: string[] = [];
  for (;;) {
    try {
      existing = realpathSync(existing);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ELOOP") throw new GuardRefusal(`符号链接成环：${value}`);
      if (code !== "ENOENT" && code !== "ENOTDIR")
        throw new GuardRefusal(`无法解析路径 ${value}：${code ?? "未知错误"}`);
      try {
        lstatSync(existing);
        throw new GuardRefusal(`路径经过一个悬空的符号链接：${value}`);
      } catch (inner) {
        if (inner instanceof GuardRefusal) throw inner;
      }
      const parent = resolve(existing, "..");
      if (parent === existing) throw new GuardRefusal(`无法解析路径：${value}`);
      tail.unshift(existing.slice(parent.length + 1));
      existing = parent;
    }
  }
  const real = tail.length > 0 ? resolve(existing, ...tail) : existing;
  if (!isInside(real, root))
    throw new GuardRefusal(`路径不在工作区内（${root}）：${value}`);
  return real;
}

/** Options of the path-bearing commands: whether each takes a value. Anything else there is refused. */
const OPTIONS: Record<string, Record<string, boolean>> = {
  "document new": {
    "--type": true,
    "--name": true,
    "-n": true,
    "--profile": true,
    "-p": true,
    "--output": true,
    "-o": true,
    "--help": false,
  },
  "document open": { "--help": false },
  "document save": { "--help": false },
  "export render": {
    "--preset": true,
    "-p": true,
    "--overwrite": false,
    "--help": false,
  },
};

/** The option that carries a path in each of those commands. */
const PATH_OPTIONS: Record<string, string[]> = {
  "document new": ["--output", "-o"],
  "document open": [],
  "document save": [],
  "export render": [],
};

/** The positional arguments that are paths: `document open <path>`, `document save [path]`, `export render <output>`. */
const POSITIONAL_PATHS = new Set([
  "document open",
  "document save",
  "export render",
]);

/** Every command of cli-anything-libreoffice 1.0.0 (`--help` of each group). */
const KNOWN_COMMANDS = new Set(
  [
    "document info json new open profiles save",
    "writer add-heading add-list add-page-break add-paragraph add-table list remove set-text",
    "calc add-sheet get-cell list-sheets remove-sheet rename-sheet set-cell",
    "impress add-element add-slide list-slides remove-slide set-content",
    "style apply create list modify remove",
    "export preset-info presets render",
    "session history redo status undo",
  ].flatMap((line) => {
    const [group, ...commands] = line.split(" ");
    return commands.map((command) => `${group} ${command}`);
  }),
);

export type Inspection = {
  /** Every path argument found, in order. */
  paths: string[];
  /** The paths among them that are read as a project (`--project`, `document open`). */
  projects: string[];
  /** Whether the invocation ends up in the REPL, which then reads its commands from stdin. */
  repl: boolean;
};

/**
 * Reads one invocation (the arguments after the program name, or one REPL line) the way the tool's
 * own parser does and returns the paths it would touch. Throws {@link GuardRefusal} for a path
 * command with an option this guard does not know: failing closed beats guessing where its value goes.
 */
export function inspectWithProjects(args: readonly string[]): Inspection {
  const paths: string[] = [];
  const projects: string[] = [];
  const addProject = (value: string) => {
    paths.push(value);
    projects.push(value);
  };
  const result = (repl: boolean): Inspection => ({ paths, projects, repl });
  let i = 0;
  // Global options come before the command group.
  for (; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--json" || arg === "--help") continue;
    if (arg === "--project") {
      const value = args[++i];
      if (value === undefined)
        throw new GuardRefusal("--project 后面缺少路径。");
      addProject(value);
      continue;
    }
    if (arg.startsWith("--project=")) {
      addProject(arg.slice("--project=".length));
      continue;
    }
    break;
  }
  const group = args[i];
  if (group === undefined) return result(true);
  if (group === "repl") {
    for (let j = i + 1; j < args.length; j++) {
      const arg = args[j] ?? "";
      if (arg === "--project") {
        const value = args[++j];
        if (value === undefined)
          throw new GuardRefusal("--project 后面缺少路径。");
        addProject(value);
      } else if (arg.startsWith("--project=")) {
        addProject(arg.slice("--project=".length));
      } else if (arg !== "--help") {
        throw new GuardRefusal(`repl 不认识参数 ${arg}。`);
      }
    }
    return result(true);
  }

  const sub = args[i + 1];
  // A group on its own or asking for help opens nothing.
  if (sub === undefined || sub === "--help") return result(false);
  const key = `${group} ${sub}`;
  // Only the commands of the tool version this guard was written against. A newer tool may add one
  // that takes a path (upstream's next release adds `document import <file>`), and a command the
  // guard has never seen cannot be checked, so it is refused until the guard learns it.
  if (!KNOWN_COMMANDS.has(key))
    throw new GuardRefusal(
      `不认识的命令 ${key}：守卫只放行它已核对过的命令，工具版本可能比守卫新。`,
    );
  const known = OPTIONS[key];
  if (known === undefined) return result(false);

  const pathOptions = PATH_OPTIONS[key] ?? [];
  for (let j = i + 2; j < args.length; j++) {
    const arg = args[j] ?? "";
    if (!arg.startsWith("-") || arg === "-") {
      if (POSITIONAL_PATHS.has(key)) {
        if (key === "document open") addProject(arg);
        else paths.push(arg);
      }
      continue;
    }
    const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const name = equals > 0 ? arg.slice(0, equals) : arg;
    // `-ofile` is `-o file` to the tool's parser.
    const attached = !arg.startsWith("--") && arg.length > 2;
    const shortName = attached ? arg.slice(0, 2) : name;
    const takesValue = known[shortName];
    if (takesValue === undefined)
      throw new GuardRefusal(`${key} 不认识参数 ${arg}，为安全起见不执行。`);
    if (!takesValue) {
      if (equals > 0 || attached)
        throw new GuardRefusal(`${key} 的参数 ${arg} 写法不对。`);
      continue;
    }
    let value: string | undefined;
    if (equals > 0) value = arg.slice(equals + 1);
    else if (attached) value = arg.slice(2);
    else value = args[++j];
    if (value === undefined) throw new GuardRefusal(`${arg} 后面缺少值。`);
    if (pathOptions.includes(shortName) || pathOptions.includes(name))
      paths.push(value);
  }
  return result(false);
}

/**
 * Keys that name a file or a link in a project. The tool copies `image_ref.path` into the document
 * as a link that LibreOffice then loads (an image from outside the workspace ends up inside the PDF,
 * or an external link inside the DOCX), and nothing else in a project is a path, so the first version
 * refuses the whole project instead of vetting values one by one.
 */
const PATH_KEY =
  /(^|[_\-.: ])(path|paths|href|src|url|file|files)($|[_\-.: ])/i;

/** What {@link inspectWithProjects} finds, without the split between projects and other paths. */
export function inspect(args: readonly string[]): {
  paths: string[];
  repl: boolean;
} {
  const { paths, repl } = inspectWithProjects(args);
  return { paths, repl };
}

/** Throws {@link GuardRefusal} when the project file at `real` holds an image reference or a path-like field. */
export function checkProject(real: string, shown: string): void {
  let size: number;
  try {
    size = statSync(real).size;
  } catch {
    return; // Not there yet: the tool reports it, and there is nothing to read.
  }
  if (size > 20 * 1024 * 1024)
    throw new GuardRefusal(`项目文件太大，不检查就不执行：${shown}`);
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(real, "utf8"));
  } catch {
    // The tool reads projects with Python's json, which also takes NaN, Infinity and -Infinity, and
    // JSON.parse does not. A file this guard cannot read is a file whose content it cannot vouch
    // for, so it is refused instead of being left to the tool.
    throw new GuardRefusal(`项目文件不是标准 JSON，不检查就不执行：${shown}`);
  }
  const refuse = (where: string) => {
    throw new GuardRefusal(
      `项目文件 ${shown} 里有图片引用或路径类字段（${where}），暂不支持；请去掉后再导出。`,
    );
  };
  const walk = (node: unknown, where: string): void => {
    if (Array.isArray(node)) {
      for (const [index, item] of node.entries())
        walk(item, `${where}[${index}]`);
    } else if (node !== null && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        if (PATH_KEY.test(key)) refuse(`${where}.${key}`);
        if (key === "type" && value === "image_ref") refuse(`${where}.type`);
        walk(value, `${where}.${key}`);
      }
    }
  };
  walk(data, "$");
}

/** Checks the paths one invocation names, and reads the projects among them. */
function checkInspected(
  inspected: Inspection,
  root: string,
  cwd: string,
): void {
  for (const path of inspected.paths) {
    const real = checkPath(path, root, cwd);
    if (inspected.projects.includes(path)) checkProject(real, path);
  }
}

/**
 * Checks everything a run would touch and returns the stdin to hand on (null when stdin is not used).
 * `stdinText` is the whole of stdin, or null when there is none.
 */
export function guardInvocation(options: {
  args: readonly string[];
  stdinText: string | null;
  root: string;
  cwd: string;
}): string | null {
  const { args, root, cwd } = options;
  const first = inspectWithProjects(args);
  checkInspected(first, root, cwd);
  if (!first.repl) return options.stdinText;
  if (options.stdinText === null)
    throw new GuardRefusal(
      "repl 需要把命令从标准输入送进来（例如 printf '...\\nexit\\n' | xb-office-cli repl --project p.json），不支持手敲交互。",
    );
  // The tool reads its lines through a terminal library, which takes a Tab as a key press (completion)
  // and inserts nothing: `document save .<Tab>./x` is read as `document save ../x` while a split on
  // whitespace sees two words. Escapes and the other controls are keys too. So the only control
  // character allowed is the line end (a CRLF is made a plain LF first), and C1 controls and the
  // Unicode line separators go with the rest.
  const stdinText = options.stdinText.replace(/\r\n/g, "\n");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
  if (/[\x00-\x09\x0b-\x1f\x7f-\x9f\u2028\u2029]/.test(stdinText))
    throw new GuardRefusal(
      "标准输入里只能有普通文本行（不能有制表符、回车符、转义符或其他控制字符）。",
    );
  for (const line of stdinText.split("\n")) {
    const tokens = line.split(PYTHON_WHITESPACE).filter((t) => t !== "");
    const head = tokens[0]?.toLowerCase();
    if (head === undefined || ["quit", "exit", "q", "help"].includes(head))
      continue;
    checkInspected(inspectWithProjects(tokens), root, cwd);
  }
  return stdinText;
}

async function readStdin(): Promise<string | null> {
  if (process.stdin.isTTY) return null;
  return await new Response(Bun.stdin.stream()).text();
}

/** What a run depends on. The program fixes them; a test passes its own. Nothing here is read from the environment. */
export type RunOptions = {
  bin: string;
  root: string;
  cwd: string;
  readStdin: () => Promise<string | null>;
};

/**
 * The home directory the passwd file gives `uid`, or "" when there is none. Read from the file and not
 * through `os.userInfo()`: Bun's answers with `$HOME` when it is set, and the environment is the
 * caller's to set.
 */
export function passwdHome(uid: number, passwdFile = "/etc/passwd"): string {
  let text: string;
  try {
    text = readFileSync(passwdFile, "utf8");
  } catch {
    return "";
  }
  for (const line of text.split("\n")) {
    const fields = line.split(":");
    if (fields.length >= 6 && Number(fields[2]) === uid && fields[2] !== "")
      return fields[5] ?? "";
  }
  return "";
}

export function productionOptions(
  where: { passwdFile?: string; bots?: string; shared?: string } = {},
): RunOptions {
  const accountHome = passwdHome(process.getuid?.() ?? -1, where.passwdFile);
  return {
    bin: DEFAULT_BIN,
    root: workspaceRoot({
      accountHome,
      bots: where.bots,
      shared: where.shared,
    }),
    cwd: process.cwd(),
    readStdin,
  };
}

export async function main(
  argv: string[],
  resolveOptions: () => RunOptions = productionOptions,
): Promise<number> {
  let stdinText: string | null;
  let options: RunOptions;
  try {
    options = resolveOptions();
    const cwd = realpathSync(options.cwd);
    if (!isInside(cwd, options.root))
      throw new GuardRefusal(`当前目录不在工作区内（${options.root}）。`);
    // stdin is read only when the tool would read commands from it; a one-shot run must not wait on it.
    stdinText = inspect(argv).repl ? await options.readStdin() : null;
    stdinText = guardInvocation({
      args: argv,
      stdinText,
      root: options.root,
      cwd,
    });
  } catch (error) {
    if (error instanceof GuardRefusal) {
      console.error(`xb-office-cli 拒绝执行：${error.message}`);
      return 2;
    }
    throw error;
  }
  // The tool keeps its REPL history and LibreOffice its profile under HOME. Neither belongs in the
  // employee's folder (the history would be listed with their files), so both go to a folder made for
  // this run and removed after it.
  const scratch = mkdtempSync(join(tmpdir(), "xb-office-cli-"));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  // A stop (the command's timeout sends SIGTERM) ends the tool first and then falls through to the
  // cleanup below; the exit code is the usual 128 + signal number. SIGKILL cannot be caught.
  let stoppedBy = 0;
  const stop = (signal: "SIGTERM" | "SIGINT", number: number) => () => {
    stoppedBy = number;
    child?.kill(signal);
  };
  const onTerm = stop("SIGTERM", 143);
  const onInt = stop("SIGINT", 130);
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);
  try {
    child = Bun.spawn([options.bin, ...argv], {
      cwd: options.cwd,
      env: { ...process.env, HOME: scratch },
      stdin: stdinText === null ? "inherit" : "pipe",
      stdout: "inherit",
      stderr: "inherit",
    });
    if (stoppedBy !== 0) child.kill("SIGTERM");
    // An explicit pipe: the tool's REPL saw an empty stdin when it was handed a Blob.
    if (stdinText !== null) {
      try {
        // Started with stdin "pipe" whenever there is text to hand on, so this is the sink.
        const sink = child.stdin as Bun.FileSink;
        sink.write(stdinText);
        await sink.end();
      } catch {
        // The tool went away before reading its input (stopped, or it exited early).
      }
    }
    const code = await child.exited;
    return stoppedBy !== 0 ? stoppedBy : code;
  } finally {
    process.off("SIGTERM", onTerm);
    process.off("SIGINT", onInt);
    try {
      rmSync(scratch, { recursive: true, force: true });
    } catch (error) {
      // Not worth replacing the tool's own exit code with.
      console.error(
        `xb-office-cli：临时目录 ${scratch} 没删掉：${String(error)}`,
      );
    }
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
