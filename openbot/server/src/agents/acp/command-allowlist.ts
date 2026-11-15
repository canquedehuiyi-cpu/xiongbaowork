import {
  type CommandAnalysis,
  type CommandPart,
  SAFE_ENV_NAMES,
} from "./command-analysis";

/**
 * The commands an external employee may run without asking when its rule for running commands is
 * "dangerous ones only" (`runCommand: dangerous`): read-only commands and the everyday development
 * commands, with the subcommands and options that keep them so. Anything not named here is asked.
 *
 * A LIST, NOT A SANDBOX. `npm run build`, `make` and `git commit` run what the project says they run
 * (scripts, recipes, hooks), which XiongBao cannot see; they are here because they are the work an
 * agent is hired for, and their files are the working folder's.
 */

type Check = (args: readonly string[]) => boolean;

const any: Check = () => true;
/** None of the arguments matches any of `bad`. */
const without =
  (...bad: RegExp[]): Check =>
  (args) =>
    !args.some((arg) => bad.some((pattern) => pattern.test(arg)));
/** Exactly one of `forms`, nothing else. */
const only =
  (...forms: string[][]): Check =>
  (args) =>
    forms.some(
      (form) =>
        form.length === args.length &&
        form.every((word, index) => word === args[index]?.toLowerCase()),
    );
/** The first argument is one of `subcommands`, and the rest pass `rest`. */
const subcommand =
  (subcommands: Record<string, Check>): Check =>
  (args) => {
    const [first, ...rest] = args;
    const check =
      first === undefined ? subcommands[""] : subcommands[first.toLowerCase()];
    return check?.(rest) === true;
  };

const VERSION = only(["--version"], ["-v"], ["-version"], ["version"]);

/** git's global options that change nothing about what runs (`-C dir`, `--no-pager`). */
function gitCheck(args: readonly string[]): boolean {
  let i = 0;
  while (i < args.length && (args[i] as string).startsWith("-")) {
    const option = args[i] as string;
    if (option === "-C") i += 2;
    else if (option === "--no-pager" || option === "-P") i += 1;
    // `-c key=value` can make git run a program; any other global option is not looked into.
    else return false;
  }
  return GIT_SUBCOMMANDS(args.slice(i));
}
const noOutputFile = without(/^--output(=|$)/, /^--ext-diff$/, /^-O/);
const GIT_SUBCOMMANDS = subcommand({
  status: any,
  log: noOutputFile,
  diff: noOutputFile,
  show: noOutputFile,
  branch: without(
    /^-[a-z]*[dDmMcCf]/,
    /^--(delete|move|copy|force|set-upstream-to|unset-upstream|edit-description)/,
  ),
  add: any,
  commit: any,
  "rev-parse": any,
  "ls-files": any,
  blame: any,
  grep: without(/^-O/, /^--open-files-in-pager/),
  shortlog: any,
  describe: any,
  "--version": any,
  version: any,
});

const JS_SCRIPTS: Record<string, Check> = {
  test: any,
  t: any,
  tst: any,
  run: any,
  "run-script": any,
  build: any,
  lint: any,
  install: any,
  i: any,
  ci: any,
  ls: any,
  list: any,
  outdated: any,
  why: any,
  "--version": any,
  "-v": any,
};

/** Programs and what may follow them. Names are as `programName` gives them: lower case, no `.exe`. */
export const COMMAND_ALLOWLIST: Readonly<Record<string, Check>> = {
  // Reading files and folders.
  ls: any,
  dir: any,
  cat: any,
  type: any,
  head: any,
  tail: any,
  wc: any,
  nl: any,
  cut: any,
  sort: without(/^-o/, /^--output/),
  uniq: (args) => args.filter((arg) => !arg.startsWith("-")).length <= 1,
  diff: without(/^--to-file/),
  cmp: any,
  comm: any,
  file: any,
  stat: any,
  du: any,
  df: any,
  tree: without(/^-o$/),
  realpath: any,
  readlink: any,
  dirname: any,
  basename: any,
  grep: any,
  egrep: any,
  fgrep: any,
  rg: without(/^--pre(=|$)/, /^--pre-glob/),
  find: without(
    /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/i,
  ),
  jq: any,
  // Where and who.
  pwd: any,
  cd: any,
  pushd: any,
  popd: any,
  echo: any,
  printf: any,
  which: any,
  where: any,
  whereis: any,
  whoami: any,
  uname: any,
  date: any,
  true: any,
  false: any,
  // PowerShell's reads.
  "get-childitem": any,
  gci: any,
  "get-content": any,
  gc: any,
  "get-location": any,
  gl: any,
  "select-string": any,
  sls: any,
  "test-path": any,
  "resolve-path": any,
  "write-output": any,
  "write-host": any,
  "get-command": any,
  gcm: any,
  // Version control.
  git: gitCheck,
  // Building and testing.
  npm: subcommand(JS_SCRIPTS),
  pnpm: subcommand(JS_SCRIPTS),
  yarn: subcommand({ ...JS_SCRIPTS, "": any }),
  bun: subcommand({
    test: any,
    run: any,
    build: any,
    install: any,
    i: any,
    "--version": any,
    "-v": any,
  }),
  cargo: subcommand({
    build: any,
    test: any,
    check: any,
    clippy: any,
    fmt: any,
    doc: any,
    tree: any,
    metadata: any,
    "--version": any,
    "-v": any,
  }),
  go: subcommand({
    build: any,
    test: any,
    vet: any,
    version: any,
    list: any,
    env: any,
  }),
  pytest: any,
  tsc: any,
  make: without(/^-f$/, /^--file/, /^--eval/),
  eslint: any,
  prettier: any,
  jest: any,
  vitest: any,
  mypy: any,
  ruff: subcommand({ check: any, format: any, "--version": any }),
  // Versions only.
  node: VERSION,
  deno: VERSION,
  python: (args) => VERSION(args) || (args[0] === "-m" && args[1] === "pytest"),
  python3: (args) =>
    VERSION(args) || (args[0] === "-m" && args[1] === "pytest"),
  java: VERSION,
  rustc: VERSION,
};

/** Wrappers that change nothing about what runs; with options of their own they are not. */
const SAFE_WRAPPERS: ReadonlySet<string> = new Set(["env", "time"]);

function partAllowed(part: CommandPart): boolean {
  if (part.nested) return false;
  if (!part.wrappers.every((wrapper) => SAFE_WRAPPERS.has(wrapper)))
    return false;
  if (!part.env.every((name) => SAFE_ENV_NAMES.has(name))) return false;
  const check = COMMAND_ALLOWLIST[part.program];
  return check?.(part.args) === true;
}

/**
 * Whether a command line is let through without asking under `runCommand: dangerous`: it comes
 * apart cleanly, writes no file by redirection, hits no floor and nothing risky, and every simple
 * command in it is on the list. The SEC1 tables are asked separately (`danger`).
 */
export function commandAllowlisted(analysis: CommandAnalysis): boolean {
  return (
    analysis.clean &&
    !analysis.writesFile &&
    analysis.floor === undefined &&
    analysis.risky === undefined &&
    analysis.parts.length > 0 &&
    analysis.parts.every(partAllowed)
  );
}
