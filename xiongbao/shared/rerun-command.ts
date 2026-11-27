/**
 * Which commands the server may run a second time at delivery (spec 2026-11-25-borrowed-improvements
 * §5.5: 改动类命令不复跑). Only what is recognised is re-run; everything else is not.
 *
 * A command is re-run only when its whole text is, word for word, of this shape:
 *
 *     [cd <path> && ]<a known check, called directly> [| <read-only filter>]…
 *
 * 1. Characters: letters, digits, space and `._/:=@,+-`, plus `|` between the check and a filter and
 *    the `&&` of a leading `cd`. A quote, a brace, `$`, a backtick, `*`, `?`, `~`, `\`, `;`, `>`, `<`,
 *    a newline, a tab or any full-width character, and the command is not re-run: nothing the shell
 *    would expand, substitute, redirect or split is left for it to do.
 * 2. No `NAME=value` in front, and no `env`: the first word is the program.
 * 3. The program is one of a handful of checks called directly, each with the flags it may carry; a
 *    word that does not start with `-` is a path (or a test name, a package) and is allowed, every
 *    other word must be on that program's own list, so `-iu` or `--update-snapshots` is refused
 *    because nobody listed it, not because somebody remembered to forbid it. No listed flag takes a
 *    value that is written to or loaded as a module (no `--reporter`); a word starting with `@` (an
 *    argument file) is not a path.
 * 4. Package scripts (`npm test`, `npm run …`, `yarn …`, `pnpm …`, `bun run …`), mvn, gradle, make and
 *    a project's own scripts are never re-run: what they do is not in the command.
 * 5. After a pipe, only `tail`/`head` (`-n N`, `-N`), `grep` (`-n`, `-v`, `-i`, `-E`, one pattern word)
 *    and `wc -l`.
 *
 * Refusing costs a 「未复核」 on the card, never a bounce, so the list errs on the side of refusing.
 */

type Parsed = { ok: true; words: string[] } | { ok: false; why: string };

const WHY = {
  writesFile: "命令把输出写进文件",
  characters:
    "命令里有不认识的字符（引号、花括号、$、反引号、*、?、~、\\、;、<、换行或全角标点等）：复跑只认直接调用的核对命令",
  andThen: "命令用 && 接了别的命令：复跑只认开头的「cd <路径> && 」",
  env: "命令前面带了环境变量（NAME=value 或 env）：不复跑",
  notCheck:
    "不是认得的核对命令（直接调用的测试、类型检查、lint）；package 脚本、make、mvn、gradle 和项目自己的脚本不复跑",
  flag: "命令带了这个核对程序名单之外的参数",
  filter: "管道后面只认 tail、head、grep（-n -v -i -E 加一个模式词）和 wc -l",
} as const;

/** Every character a re-run command may hold: the shape above, nothing the shell would act on. */
const ALLOWED_CHARS = /^[A-Za-z0-9 ._/:=@,+|&-]*$/;

/** A word that is a path, a test name or a package, not a flag. */
/**
 * A word that is a path, a test name or a package, not a flag. Not one starting with `@` either:
 * pytest and mypy read `@file` as more arguments, out of a file the command does not show.
 */
const plainWord = (word: string) =>
  word !== "" && !word.startsWith("-") && !word.startsWith("@");

/**
 * A program's flags: those that stand alone, and those that take the next word (or `=value`) as
 * their value. `checkValue` checks a value when not any plain word will do.
 */
type Flags = {
  alone: readonly string[];
  valued?: readonly string[];
  /** Flags whose whole word is fixed, `=` and all (`--maxfail=3`, `-count=1`). */
  exact?: RegExp;
  checkValue?: (flag: string, value: string) => boolean;
  /** Whether a plain word may stand on its own (a path, a test name). */
  paths?: boolean;
};

/** Whether `args` are all paths or flags this program lists. */
function argsAllowed(args: readonly string[], flags: Flags): boolean {
  for (let index = 0; index < args.length; index++) {
    const word = args[index] as string;
    if (plainWord(word)) {
      if (flags.paths === false) return false;
      continue;
    }
    if (flags.alone.includes(word)) continue;
    if (flags.exact?.test(word)) continue;
    const [name, inline] = word.includes("=")
      ? [word.slice(0, word.indexOf("=")), word.slice(word.indexOf("=") + 1)]
      : [word, undefined];
    if (!flags.valued?.includes(name)) return false;
    const value = inline ?? args[index + 1];
    if (value === undefined || !plainWord(value)) return false;
    if (flags.checkValue && !flags.checkValue(name, value)) return false;
    if (inline === undefined) index++;
  }
  return true;
}

/** `bun test`, `vitest run`, `jest`. */
const JS_TEST: Flags = {
  alone: ["--run", "--bail", "--silent"],
  /*
   * Only test-name patterns take a value here. No `--reporter`: `blob` and `html` write files, and a
   * path is loaded and run as a reporter module.
   */
  valued: ["-t", "--testNamePattern"],
};
const PYTEST: Flags = {
  alone: ["-q", "-x", "-v"],
  valued: ["-k", "-p"],
  exact: /^--maxfail=\d+$/,
  checkValue: (flag, value) => flag !== "-p" || value === "no:cacheprovider",
};
const CARGO: Flags = {
  alone: ["--workspace", "--all-targets", "--quiet"],
  valued: ["-p"],
};
const GO: Flags = {
  alone: ["-v", "-count=1"],
  valued: ["-run"],
};
const TSC: Flags = {
  alone: ["--noEmit"],
  valued: ["-p", "--project"],
  paths: false,
};
const LINT: Flags = { alone: ["--quiet"] };
const MYPY: Flags = { alone: ["--strict"] };

/** The flags of the check these words call, or null when they call nothing this list knows. */
function checkOf(words: readonly string[]): {
  args: readonly string[];
  flags: Flags;
  needs?: string;
} | null {
  const [first, second, third] = words;
  // `npx <tool>` runs the project's own copy of a tool on this list, and nothing else.
  if (first === "npx") {
    if (second === "vitest" && third === "run")
      return { args: words.slice(3), flags: JS_TEST };
    if (second === "jest") return { args: words.slice(2), flags: JS_TEST };
    if (second === "tsc")
      return { args: words.slice(2), flags: TSC, needs: "--noEmit" };
    if (second === "eslint") return { args: words.slice(2), flags: LINT };
    if (second === "biome" && third === "lint")
      return { args: words.slice(3), flags: LINT };
    return null;
  }
  switch (first) {
    case "bun":
      return second === "test"
        ? { args: words.slice(2), flags: JS_TEST }
        : null;
    case "vitest":
      return second === "run" ? { args: words.slice(2), flags: JS_TEST } : null;
    case "jest":
      return { args: words.slice(1), flags: JS_TEST };
    case "pytest":
      return { args: words.slice(1), flags: PYTEST };
    case "python":
    case "python3":
      return second === "-m" && third === "pytest"
        ? { args: words.slice(3), flags: PYTEST }
        : null;
    case "cargo":
      return second === "test" || second === "check" || second === "clippy"
        ? { args: words.slice(2), flags: CARGO }
        : null;
    case "go":
      return second === "test" || second === "vet"
        ? { args: words.slice(2), flags: GO }
        : null;
    case "tsc":
      return { args: words.slice(1), flags: TSC, needs: "--noEmit" };
    case "eslint":
      return { args: words.slice(1), flags: LINT };
    case "biome":
      return second === "lint" ? { args: words.slice(2), flags: LINT } : null;
    case "ruff":
      return second === "check" ? { args: words.slice(2), flags: LINT } : null;
    case "mypy":
      return { args: words.slice(1), flags: MYPY };
    default:
      return null;
  }
}

/** Whether these words, after a pipe, only read what comes in. */
function readOnlyFilter(words: readonly string[]): boolean {
  const [program, ...args] = words;
  switch (program) {
    case "tail":
    case "head":
      return (
        args.length === 0 ||
        (args.length === 1 && /^-\d+$/.test(args[0] as string)) ||
        (args.length === 2 &&
          args[0] === "-n" &&
          /^\d+$/.test(args[1] as string))
      );
    case "grep": {
      const patterns = args.filter(plainWord);
      return (
        patterns.length === 1 &&
        args.every(
          (word) => plainWord(word) || ["-n", "-v", "-i", "-E"].includes(word),
        )
      );
    }
    case "wc":
      return args.length === 1 && args[0] === "-l";
    default:
      return false;
  }
}

/** A command in the one shape that may be re-run, as its words, or why it is not. */
export function parseCheckCommand(text: string): Parsed {
  const trimmed = text.trim();
  if (trimmed.includes(">")) return { ok: false, why: WHY.writesFile };
  if (!ALLOWED_CHARS.test(trimmed)) return { ok: false, why: WHY.characters };
  let rest = trimmed;
  const prefix: string[] = [];
  const cd = rest.match(/^cd ([^\s|&]+) && /);
  if (cd) {
    if (!plainWord(cd[1] as string)) return { ok: false, why: WHY.andThen };
    prefix.push("cd", cd[1] as string, "&&");
    rest = rest.slice(cd[0].length);
  }
  if (rest.includes("&")) return { ok: false, why: WHY.andThen };
  const [main = "", ...piped] = rest.split("|");
  const split = (part: string) => part.split(" ").filter(Boolean);
  const words = split(main);
  const filters = piped.map(split);
  const [program] = words;
  if (!program || filters.some((filter) => filter.length === 0))
    return { ok: false, why: WHY.characters };
  if (program === "cd") return { ok: false, why: WHY.andThen };
  if (program === "env" || program.includes("="))
    return { ok: false, why: WHY.env };
  const check = checkOf(words);
  if (!check) return { ok: false, why: WHY.notCheck };
  if (check.needs && !check.args.includes(check.needs))
    return { ok: false, why: WHY.notCheck };
  if (!argsAllowed(check.args, check.flags))
    return { ok: false, why: WHY.flag };
  if (!filters.every(readOnlyFilter)) return { ok: false, why: WHY.filter };
  return {
    ok: true,
    words: [
      ...prefix,
      ...words,
      ...filters.flatMap((filter) => ["|", ...filter]),
    ],
  };
}

/**
 * Whether a command the coworker ran is the check it named for re-running: both are in the shape above
 * and are the same command, whole, word for word (spacing aside) — the `cd` in front and the filters
 * after included.
 */
export function sameCheckCommand(ran: string, named: string): boolean {
  const done = parseCheckCommand(ran);
  const said = parseCheckCommand(named);
  return done.ok && said.ok && done.words.join(" ") === said.words.join(" ");
}

/**
 * The forms a command the coworker ran can be named by, for finding the run a named check stands
 * for: the whole command, then without a leading `cd <path> && `, without the read-only filters (and
 * a `2>&1`) at its end, and without both — spacing aside. Only for finding that run: whether it is
 * re-run is still decided on the whole command it was.
 */
export function commandForms(text: string): string[] {
  const whole = text.replace(/\s+/g, " ").trim();
  const forms = [whole];
  const cd = whole.match(/^cd [^\s|&;]+ && (.+)$/);
  const withoutFilters = (command: string): string | null => {
    const [main = "", ...piped] = command.split(" | ");
    if (piped.length === 0)
      return / 2>&1$/.test(command) ? command.replace(/ 2>&1$/, "") : null;
    if (!piped.every((filter) => readOnlyFilter(filter.split(" "))))
      return null;
    return main.replace(/ 2>&1$/, "").trim() || null;
  };
  const bare = withoutFilters(whole);
  if (bare) forms.push(bare);
  if (cd?.[1]) {
    forms.push(cd[1]);
    const both = withoutFilters(cd[1]);
    if (both) forms.push(both);
  }
  return [...new Set(forms)];
}
