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
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

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

/** The workspace root as the shell gives it to a command: `HOME` is the employee's own folder. */
export function workspaceRoot(env: Record<string, string | undefined>): string {
  const configured = env.XIONGBAO_OFFICE_CLI_ROOT?.trim() || env.HOME?.trim();
  if (!configured) throw new GuardRefusal("找不到工作区根目录（HOME 为空）。");
  const real = realpathSync(configured);
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
  "export render": { "--preset": true, "--overwrite": false, "--help": false },
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
  /** Whether the invocation ends up in the REPL, which then reads its commands from stdin. */
  repl: boolean;
};

/**
 * Reads one invocation (the arguments after the program name, or one REPL line) the way the tool's
 * own parser does and returns the paths it would touch. Throws {@link GuardRefusal} for a path
 * command with an option this guard does not know: failing closed beats guessing where its value goes.
 */
export function inspect(args: readonly string[]): Inspection {
  const paths: string[] = [];
  let i = 0;
  // Global options come before the command group.
  for (; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--json" || arg === "--help") continue;
    if (arg === "--project") {
      const value = args[++i];
      if (value === undefined)
        throw new GuardRefusal("--project 后面缺少路径。");
      paths.push(value);
      continue;
    }
    if (arg.startsWith("--project=")) {
      paths.push(arg.slice("--project=".length));
      continue;
    }
    break;
  }
  const group = args[i];
  if (group === undefined) return { paths, repl: true };
  if (group === "repl") {
    for (let j = i + 1; j < args.length; j++) {
      const arg = args[j] ?? "";
      if (arg === "--project") {
        const value = args[++j];
        if (value === undefined)
          throw new GuardRefusal("--project 后面缺少路径。");
        paths.push(value);
      } else if (arg.startsWith("--project=")) {
        paths.push(arg.slice("--project=".length));
      } else if (arg !== "--help") {
        throw new GuardRefusal(`repl 不认识参数 ${arg}。`);
      }
    }
    return { paths, repl: true };
  }

  const sub = args[i + 1];
  // A group on its own or asking for help opens nothing.
  if (sub === undefined || sub === "--help") return { paths, repl: false };
  const key = `${group} ${sub}`;
  // Only the commands of the tool version this guard was written against. A newer tool may add one
  // that takes a path (upstream's next release adds `document import <file>`), and a command the
  // guard has never seen cannot be checked, so it is refused until the guard learns it.
  if (!KNOWN_COMMANDS.has(key))
    throw new GuardRefusal(
      `不认识的命令 ${key}：守卫只放行它已核对过的命令，工具版本可能比守卫新。`,
    );
  const known = OPTIONS[key];
  if (known === undefined) return { paths, repl: false };

  const pathOptions = PATH_OPTIONS[key] ?? [];
  for (let j = i + 2; j < args.length; j++) {
    const arg = args[j] ?? "";
    if (!arg.startsWith("-") || arg === "-") {
      if (POSITIONAL_PATHS.has(key)) paths.push(arg);
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
  return { paths, repl: false };
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
  const { args, stdinText, root, cwd } = options;
  const first = inspect(args);
  for (const path of first.paths) checkPath(path, root, cwd);
  if (!first.repl) return stdinText;
  if (stdinText === null)
    throw new GuardRefusal(
      "repl 需要把命令从标准输入送进来（例如 printf '...\\nexit\\n' | xb-office-cli repl --project p.json），不支持手敲交互。",
    );
  // The tool reads its lines through a terminal library and Python's universal newlines, which
  // treat \r and escape sequences as input too. Only plain lines can be read the way they are checked.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
  if (/[\x00-\x08\x0b-\x1f\x7f\x85\u2028\u2029]/.test(stdinText))
    throw new GuardRefusal(
      "标准输入里只能有普通文本行（不能有回车符、转义符或控制字符）。",
    );
  for (const line of stdinText.split("\n")) {
    const tokens = line.split(PYTHON_WHITESPACE).filter((t) => t !== "");
    const head = tokens[0]?.toLowerCase();
    if (head === undefined || ["quit", "exit", "q", "help"].includes(head))
      continue;
    const inspected = inspect(tokens);
    for (const path of inspected.paths) checkPath(path, root, cwd);
  }
  return stdinText;
}

async function readStdin(): Promise<string | null> {
  if (process.stdin.isTTY) return null;
  return await new Response(Bun.stdin.stream()).text();
}

export async function main(argv: string[]): Promise<number> {
  const bin = process.env.XIONGBAO_OFFICE_CLI_BIN?.trim() || DEFAULT_BIN;
  let stdinText: string | null;
  try {
    const root = workspaceRoot(process.env);
    const cwd = realpathSync(process.cwd());
    if (!isInside(cwd, root))
      throw new GuardRefusal(`当前目录不在工作区内（${root}）。`);
    // stdin is read only when the tool would read commands from it; a one-shot run must not wait on it.
    stdinText = inspect(argv).repl ? await readStdin() : null;
    stdinText = guardInvocation({ args: argv, stdinText, root, cwd });
  } catch (error) {
    if (error instanceof GuardRefusal) {
      console.error(`xb-office-cli 拒绝执行：${error.message}`);
      return 2;
    }
    throw error;
  }
  const child = Bun.spawn([bin, ...argv], {
    stdin: stdinText === null ? "inherit" : "pipe",
    stdout: "inherit",
    stderr: "inherit",
  });
  // An explicit pipe: the tool's REPL saw an empty stdin when it was handed a Blob.
  if (stdinText !== null) {
    child.stdin?.write(stdinText);
    await child.stdin?.end();
  }
  return await child.exited;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
