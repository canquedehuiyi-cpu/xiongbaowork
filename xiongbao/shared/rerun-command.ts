/**
 * Which commands the server may run a second time at delivery (spec 2026-11-25-borrowed-improvements
 * §5.5: 改动类命令不复跑), by an allow list rather than a list of what to refuse.
 *
 * A command is re-run only when its whole text has this shape, and nothing else:
 *
 *     [cd <dir> &&] [NAME=value …] <a known check, in its read-only form> [| <read-only filter>]…
 *
 * A known check is a test runner, a type check or a linter run without writing anything back
 * (`bun test`, `pytest`, `tsc --noEmit`, `eslint .`, `biome check`, `prettier --check`, `go vet`,
 * `cargo test`, `make test`, `wc -l`, `grep`, `diff`…). The filters after a pipe only read
 * (`tail`, `head`, `grep`, `wc`, `sort`, `cut`…). Anything else is refused: a second command after
 * `;`, `&&` (but the `cd` in front), `||` or `&`; backticks, `$(…)`, `$VAR`, `\`, a newline or a
 * subshell; a redirect into a file (`2>&1` and `>/dev/null` only); a write-back flag (`--write`,
 * `--fix`, `-u`, `--update-snapshots`…); a word such as `install`, `migrate` or `clean`; and every
 * program this list does not know. Refusing a command costs a 「未复核」 on the card, never a bounce,
 * so the list errs on the side of refusing.
 */

/** One command parsed into the shape above: words unquoted. */
export type CheckCommand = {
  /** The directory of a leading `cd <dir> &&`. */
  cd?: string;
  /** `NAME=value` words in front of the check. */
  env: string[];
  /** The check itself: the program and its arguments. */
  check: string[];
  /** Each read-only filter after a pipe, as its words. */
  filters: string[][];
};

type Parsed = { ok: true; command: CheckCommand } | { ok: false; why: string };

const WHY = {
  chained:
    "命令里有 ;、||、&、反引号、$(…)、变量、反斜杠、括号或换行：复跑只认单条核对命令",
  andThen: "命令用 && 接了别的命令：复跑只认开头的「cd <目录> &&」",
  writesFile: "命令把输出写进文件",
  readsFile: "命令里有输入重定向",
  writeBack:
    "命令带写回类参数（--write、--fix、-u、--update-snapshots 等），会改动文件",
  changes: "命令会安装、迁移、清理、发布或改动东西",
  notCheck: "不像核对命令（测试、类型检查、lint 的只读形式、统计数）",
  filter: "管道后面只认只读的过滤（tail、head、grep、wc、sort、cut 等）",
  quote: "命令的引号没有配对",
} as const;

type Item = { word: string } | { op: "&&" | "|" };

/** Words and the two operators the shape allows, or why the text is refused. */
function tokens(text: string): { ok: true; items: Item[] } | Parsed {
  const items: Item[] = [];
  let word = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;
  const end = () => {
    if (inWord) items.push({ word });
    word = "";
    inWord = false;
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index] as string;
    if (quote === "'") {
      if (char === "'") quote = null;
      else word += char;
      continue;
    }
    if (char === "`" || char === "\\" || char === "\n" || char === "$")
      return { ok: false, why: WHY.chained };
    if (quote === '"') {
      if (char === '"') quote = null;
      else word += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      inWord = true;
      continue;
    }
    if (char === " " || char === "\t") {
      end();
      continue;
    }
    if (char === ";" || char === "(" || char === ")")
      return { ok: false, why: WHY.chained };
    if (char === "<") return { ok: false, why: WHY.readsFile };
    if (char === "&") {
      if (text[index + 1] === "&") {
        end();
        items.push({ op: "&&" });
        index++;
        continue;
      }
      return { ok: false, why: WHY.chained };
    }
    if (char === "|") {
      if (text[index + 1] === "|") return { ok: false, why: WHY.chained };
      end();
      items.push({ op: "|" });
      continue;
    }
    if (char === ">") {
      // Only a stream into another stream, or into nothing: `2>&1`, `>/dev/null`, `2>/dev/null`.
      const stream = inWord && /^[12]?$/.test(word) ? word : null;
      if (stream === null && inWord) return { ok: false, why: WHY.writesFile };
      const rest = text.slice(index + 1);
      const into = rest.match(/^&[12](?=\s|$|\|)|^\s*\/dev\/null(?=\s|$|\|)/);
      if (!into) return { ok: false, why: WHY.writesFile };
      word = "";
      inWord = false;
      index += into[0].length;
      continue;
    }
    word += char;
    inWord = true;
  }
  if (quote) return { ok: false, why: WHY.quote };
  end();
  return { ok: true, items };
}

/** A word that writes back what it checks, or sends it somewhere. */
const WRITE_BACK =
  /^(?:-u|-w|--write|--fix|--fix-[\w-]+|--apply|--apply-unsafe|--unsafe|--update|--update-snapshots?|--updateSnapshot|--snapshot-update|--watch|--watchAll|--in-place|--output[\w-]*|--outfile|--outputFile|--junitxml|--junit-xml|--html|--cov-report|--coverageDirectory)(?:=.*)?$/;

/** A word that names a change rather than a check, whichever program it is given to. */
const CHANGE_WORD =
  /^(?:install|uninstall|i|ci|add|remove|rm|delete|migrate|makemigrations|clean|deploy|publish|push|release|upgrade|update|reset|apply|destroy|init|create|drop|exec|shell|run-server|runserver|serve|start|up|down)$/;

/** Programs that only read the files they are given and print what they found. */
const READERS = new Set([
  "wc",
  "grep",
  "egrep",
  "fgrep",
  "diff",
  "cmp",
  "head",
  "tail",
  "cat",
  "sha256sum",
  "md5sum",
]);

/** A package script name that is a test or a type check (`test`, `test:unit`, `typecheck`). */
const SCRIPT =
  /^(?:test|tests|typecheck|type-check|types|check-types)(?::[\w:.-]+)?$/;

const has = (words: readonly string[], ...wanted: string[]) =>
  words.some((word) => wanted.includes(word));

/**
 * Whether these words (program first, environment words already taken off) are a known check in its
 * read-only form; why not, otherwise.
 */
function knownCheck(words: readonly string[]): string | null {
  const [program, ...args] = words;
  if (!program) return WHY.notCheck;
  const first = args[0];
  const name = program.replace(/^\.\//, "");
  // Tools that only read what they are given (their -u, -w, -i mean something else there).
  if (READERS.has(name)) return null;
  if (name === "git")
    return first === "diff" && !args.some((word) => /^--output/.test(word))
      ? null
      : WHY.notCheck;
  if (args.some((word) => WRITE_BACK.test(word))) return WHY.writeBack;
  switch (name) {
    case "npx":
    case "bunx":
    case "pnpx":
      return args.length > 0 && !first?.startsWith("-")
        ? knownCheck(args)
        : WHY.notCheck;
    case "bun":
      if (first === "test") return changeIn(args.slice(1));
      if (first === "run" && args[1] && SCRIPT.test(args[1]))
        return changeIn(args.slice(2));
      if (first === "x" && args.length > 1) return knownCheck(args.slice(1));
      return WHY.notCheck;
    case "npm":
      if (first === "test" || first === "t") return changeIn(args.slice(1));
      if ((first === "run" || first === "run-script") && args[1])
        return SCRIPT.test(args[1]) ? changeIn(args.slice(2)) : WHY.notCheck;
      return WHY.notCheck;
    case "pnpm":
    case "yarn":
      if (first === "exec" && args.length > 1) return knownCheck(args.slice(1));
      if (first === "run" && args[1])
        return SCRIPT.test(args[1]) ? changeIn(args.slice(2)) : WHY.notCheck;
      if (first && SCRIPT.test(first)) return changeIn(args.slice(1));
      return WHY.notCheck;
    case "jest":
    case "vitest":
    case "mocha":
    case "pytest":
    case "py.test":
    case "mypy":
    case "pyright":
    case "flake8":
    case "pylint":
    case "eslint":
      return changeIn(args);
    case "python":
    case "python3":
      if (first === "-m" && args[1]) {
        if (
          [
            "pytest",
            "unittest",
            "mypy",
            "flake8",
            "pylint",
            "pyright",
          ].includes(args[1])
        )
          return changeIn(args.slice(2));
        if (args[1] === "ruff") return knownCheck(args.slice(1));
        return WHY.notCheck;
      }
      if (first === "manage.py" && args[1] === "test")
        return changeIn(args.slice(2));
      return WHY.notCheck;
    case "ruff":
      return first === "check"
        ? changeIn(args.slice(1))
        : first === "format" && has(args, "--check")
          ? changeIn(args.slice(1))
          : WHY.notCheck;
    case "black":
    case "isort":
      return has(args, "--check", "--check-only")
        ? changeIn(args)
        : WHY.writeBack;
    case "tsc":
      return has(args, "--noEmit") ? changeIn(args) : WHY.notCheck;
    case "biome":
      return first && ["check", "lint", "ci"].includes(first)
        ? changeIn(args.slice(1))
        : first === "format"
          ? WHY.writeBack
          : WHY.notCheck;
    case "prettier":
      return has(args, "--check", "-c", "--list-different", "-l")
        ? changeIn(args)
        : WHY.writeBack;
    case "go":
      return first === "test" || first === "vet"
        ? changeIn(args.slice(1))
        : WHY.notCheck;
    case "cargo":
      return first && ["test", "check", "clippy"].includes(first)
        ? changeIn(args.slice(1))
        : WHY.notCheck;
    case "deno":
      return first && ["test", "check", "lint"].includes(first)
        ? changeIn(args.slice(1))
        : WHY.notCheck;
    case "node":
      return first === "--test" ? changeIn(args.slice(1)) : WHY.notCheck;
    case "make":
      return args.length > 0 &&
        args.every(
          (word) => word.startsWith("-") || word === "test" || word === "check",
        ) &&
        args.some((word) => word === "test" || word === "check") &&
        !args.some((word) => /^-(?:C|f|-file|-directory)/.test(word))
        ? null
        : WHY.notCheck;
    case "mvn":
    case "gradle":
    case "gradlew":
      return first === "test" || first === "check" || first === "verify"
        ? changeIn(args.slice(1))
        : WHY.notCheck;
    default:
      return WHY.notCheck;
  }
}

/** The arguments of a check that names a change (`make test install`, `npm test -- clean`). */
function changeIn(args: readonly string[]): string | null {
  return args.some((word) => CHANGE_WORD.test(word)) ? WHY.changes : null;
}

/** Whether these words, after a pipe, only read what comes in. */
function readOnlyFilter(words: readonly string[]): boolean {
  const [program, ...args] = words;
  switch (program) {
    case "tail":
    case "head":
    case "grep":
    case "egrep":
    case "fgrep":
    case "wc":
    case "cut":
    case "tr":
      return true;
    case "sort":
      return !args.some((word) => /^(?:-o|--output)/.test(word));
    case "uniq":
      return args.every((word) => word.startsWith("-"));
    default:
      return false;
  }
}

/** A command in the one shape that may be re-run, or why it is not. */
export function parseCheckCommand(text: string): Parsed {
  const read = tokens(text.trim());
  if (!("items" in read)) return read;
  const segments: string[][] = [[]];
  const ops: ("&&" | "|")[] = [];
  for (const item of read.items) {
    if ("op" in item) {
      ops.push(item.op);
      segments.push([]);
    } else (segments.at(-1) as string[]).push(item.word);
  }
  if (segments.some((segment) => segment.length === 0))
    return { ok: false, why: WHY.chained };
  let cd: string | undefined;
  if (ops[0] === "&&") {
    const [first] = segments;
    if (first?.[0] !== "cd" || first.length !== 2)
      return { ok: false, why: WHY.andThen };
    cd = first[1];
    segments.shift();
    ops.shift();
  }
  if (ops.includes("&&")) return { ok: false, why: WHY.andThen };
  const [main, ...filters] = segments as [string[], ...string[][]];
  const env: string[] = [];
  while (main.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(main[0] as string))
    env.push(main.shift() as string);
  if (main[0] === "cd") return { ok: false, why: WHY.andThen };
  const why = knownCheck(main);
  if (why) return { ok: false, why };
  if (!filters.every(readOnlyFilter)) return { ok: false, why: WHY.filter };
  return {
    ok: true,
    command: { ...(cd !== undefined ? { cd } : {}), env, check: main, filters },
  };
}

/**
 * Whether a command the coworker ran is the check it named for re-running: both parse into the shape
 * above and run the same check, word for word (quotes and spacing aside). A `cd` or a filter the
 * coworker wrote must be the one it ran too; one it left out may be there.
 */
export function sameCheckCommand(ran: string, named: string): boolean {
  const done = parseCheckCommand(ran);
  const said = parseCheckCommand(named);
  if (!done.ok || !said.ok) return false;
  const words = (list: readonly string[]) => JSON.stringify(list);
  if (words(done.command.check) !== words(said.command.check)) return false;
  if (said.command.cd !== undefined && said.command.cd !== done.command.cd)
    return false;
  if (
    said.command.filters.length > 0 &&
    JSON.stringify(said.command.filters) !==
      JSON.stringify(done.command.filters)
  )
    return false;
  return true;
}
