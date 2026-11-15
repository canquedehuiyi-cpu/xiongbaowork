import { DEFAULT_SENSITIVE_PATHS, sensitivePath } from "../../approvals/policy";

/**
 * Which command lines an external employee runs without asking under "dangerous ones only"
 * (agents/acp/permissions.ts).
 *
 * WHAT CAN BE PROVEN, NOT WHAT CAN BE GUESSED. Shells (bash, zsh, PowerShell, cmd) read the same
 * line differently, and every program has options that run commands, write files or go online.
 * Taking a line apart cannot keep up with that, so going through unasked is kept to the smallest
 * set that can be checked by looking at the characters alone:
 *
 *  - STRICT CHARACTERS (`strictCharacters`): printable ASCII and plain spaces, and none of
 *    `# ' " \` $ \ ^ ; & | < > ( ) { } [ ] * ? ~ !`, no newline, no tab. No shell reads such a line as
 *    more than one program with plain words after it.
 *  - STRICTLY SAFE (`strictlySafe`): strict characters; the first word is a program of
 *    `STRICT_COMMANDS`, exactly as written there (no folder, no extension, same case); every word
 *    starting with `-` is, exactly, one of that program's (or subcommand's) options (no
 *    abbreviations, no clusters, no `--opt=` unless written so); every other word is a path relative
 *    to the working folder (not absolute, no `..`, no drive) that no sensitive-path pattern matches.
 *
 * A LIST, NOT A SANDBOX. `npm test`, `make test`, `git commit` run what the project says they run
 * (scripts, recipes, hooks), which XiongBao cannot see; they are here because they are the work an
 * agent is hired for.
 */

const BANNED = /[#'"`$\\^;&|<>(){}[\]*?~!]/;

/** Printable ASCII and spaces only, none of the characters a shell gives meaning to. */
export function strictCharacters(command: string): boolean {
  return /^[\x20-\x7e]*$/.test(command) && !BANNED.test(command);
}

/** What may follow a program, or one of its subcommands. */
type Shape = {
  /** Options allowed, each exactly as written. */
  options?: readonly string[];
  /** Plain words allowed after it: paths, none, or at most one of these exact words. */
  words?: "paths" | "scripts" | "none" | readonly string[];
  /** Subcommands, each with its own shape; a program with subcommands needs one. */
  subcommands?: Readonly<Record<string, Shape>>;
};

const READ: Shape = { words: "paths" };
const VERSION: Shape = { options: ["--version"], words: "none" };
/** `run <script>`: a script's name from the project's manifest, never a file of code. */
const SCRIPT: Shape = { words: "scripts" };
const JS_TOOL: Shape = {
  subcommands: {
    test: { words: "none" },
    run: SCRIPT,
    build: { words: "none" },
    lint: { words: "none" },
    install: { words: "none" },
    ci: { words: "none" },
    "--version": { words: "none" },
  },
};

/** Programs, exactly as they must be written, and what may follow them. */
export const STRICT_COMMANDS: Readonly<Record<string, Shape>> = {
  // Reading files and folders.
  ls: {
    options: ["-l", "-a", "-la", "-al", "-lh", "-lah", "-A", "-1", "-R"],
    words: "paths",
  },
  dir: READ,
  cat: { options: ["-n"], words: "paths" },
  type: READ,
  head: { options: ["-n"], words: "paths" },
  tail: { options: ["-n"], words: "paths" },
  wc: { options: ["-l", "-w", "-c"], words: "paths" },
  grep: {
    options: [
      "-r",
      "-n",
      "-i",
      "-l",
      "-w",
      "-v",
      "-c",
      "-rn",
      "-ri",
      "-rl",
      "-E",
      "-F",
    ],
    words: "paths",
  },
  rg: { options: ["-n", "-i", "-l", "-w", "-F", "--files"], words: "paths" },
  find: {
    options: ["-name", "-iname", "-type", "-maxdepth", "-mindepth"],
    words: "paths",
  },
  pwd: { words: "none" },
  echo: { words: "paths" },
  which: { words: "paths" },
  whoami: { words: "none" },
  date: { words: "none" },
  "Get-ChildItem": READ,
  "Get-Content": READ,
  // Version control.
  git: {
    subcommands: {
      status: {
        options: ["-s", "-sb", "--short", "--porcelain"],
        words: "none",
      },
      log: {
        options: [
          "--oneline",
          "--stat",
          "--graph",
          "-p",
          "-1",
          "-5",
          "-10",
          "-20",
          "-50",
        ],
        words: "paths",
      },
      diff: {
        options: [
          "--stat",
          "--cached",
          "--staged",
          "--name-only",
          "--name-status",
        ],
        words: "paths",
      },
      show: { options: ["--stat", "--name-only"], words: "paths" },
      branch: {
        options: ["-a", "-r", "-v", "-vv", "--list", "--show-current"],
        words: "none",
      },
      add: { options: ["-A", "-u"], words: "paths" },
      commit: { options: ["-m", "-a", "-am"], words: "paths" },
      "rev-parse": {
        options: ["--show-toplevel", "--abbrev-ref", "--short"],
        words: "paths",
      },
      "ls-files": { words: "paths" },
      blame: { words: "paths" },
      "--version": { words: "none" },
    },
  },
  // Building and testing.
  npm: JS_TOOL,
  pnpm: JS_TOOL,
  yarn: JS_TOOL,
  bun: {
    subcommands: {
      test: { words: "paths" },
      run: SCRIPT,
      "--version": { words: "none" },
    },
  },
  make: { words: ["test", "build", "lint"] },
  cargo: {
    subcommands: { build: { words: "none" }, test: { words: "none" } },
  },
  go: {
    subcommands: {
      build: { words: ["./..."] },
      test: { words: ["./..."] },
      vet: { words: ["./..."] },
    },
  },
  gofmt: { options: ["-l"], words: "paths" },
  pytest: { options: ["-q", "-v", "-x"], words: "paths" },
  tsc: { options: ["--noEmit"], words: "none" },
  // Versions only.
  node: VERSION,
  python: VERSION,
  python3: VERSION,
};

/** A plain word after a program: a path relative to the working folder that holds no secret. */
function relativePath(word: string): boolean {
  return (
    !word.startsWith("/") &&
    // A drive (`C:`), or a revision's path (`HEAD:.env`): not a plain path.
    !word.includes(":") &&
    !word.includes("..") &&
    !sensitivePath(word, DEFAULT_SENSITIVE_PATHS)
  );
}

function fits(shape: Shape, words: readonly string[]): boolean {
  if (shape.subcommands) {
    const [first, ...rest] = words;
    const sub =
      first !== undefined && Object.hasOwn(shape.subcommands, first)
        ? shape.subcommands[first]
        : undefined;
    return sub !== undefined && fits(sub, rest);
  }
  const plain: string[] = [];
  for (const word of words) {
    if (word.startsWith("-")) {
      if (!shape.options?.includes(word)) return false;
    } else plain.push(word);
  }
  const allowed = shape.words ?? "none";
  if (allowed === "none") return plain.length === 0;
  if (allowed === "paths") return plain.every(relativePath);
  if (allowed === "scripts")
    return (
      plain.length === 1 &&
      /^[A-Za-z0-9_:-]+$/.test(plain[0] as string) &&
      !/^(ts|js|mjs|cjs|tsx|jsx|sh)$/.test(plain[0] as string)
    );
  // A fixed word (`make test`, `go test ./...`): at most one, exactly as listed.
  return plain.length <= 1 && plain.every((word) => allowed.includes(word));
}

/**
 * Whether a command line is strictly safe (see the top of this file): what "dangerous ones only"
 * runs without asking. The floors and the SEC1 tables are asked separately.
 */
export function strictlySafe(command: string): boolean {
  if (!strictCharacters(command)) return false;
  const words = command.trim().split(/ +/);
  const program = words[0];
  if (!program || !Object.hasOwn(STRICT_COMMANDS, program)) return false;
  return fits(STRICT_COMMANDS[program] as Shape, words.slice(1));
}
