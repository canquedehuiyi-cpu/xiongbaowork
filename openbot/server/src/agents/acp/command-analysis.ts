import { createHash } from "node:crypto";
import {
  DESTRUCTIVE_TOOL_REASON,
  dangerousCommand,
  OUTBOUND_SEND_REASON,
  PUBLISH_POST_REASON,
  SHARE_ACCESS_REASON,
  securityFloor,
} from "../../approvals/policy";
import { DEFAULT_EMPLOYEE_SECURITY } from "../../approvals/types";

/**
 * What an external employee's `execute` request's command line does (agents/acp/permissions.ts).
 *
 * NOT A SANDBOX. A command line is read, not run: what a script it starts will do (`bash x.sh`, an
 * `npm run` script) cannot be seen. So this answers three narrower questions, each failing closed:
 *
 *  - DOES IT HIT A FLOOR? Every simple command, wrappers (`env`, `sudo`, `nohup`, `xargs`, …) and
 *    shells (`sh -c '…'`, `pwsh -Command`, `cmd /c`, `find -exec`, `fd -x`) taken off, is judged on
 *    its own, and the whole line is read again with patterns that need no parsing (a messaging
 *    service's address anywhere, `twine upload`, `gh api …/collaborators/`). Either finding it is
 *    enough (`floor`).
 *  - IS IT RISKY? What runs code nobody can see is asked every time (`risky`): a line that does not
 *    come apart, a line too long to read, inline interpreter code (`python -c`, `node -e`, `perl -e`,
 *    `osascript -e`, `awk … system()`), an interpreter fed standard input or a pipe, `eval`,
 *    `Invoke-Expression`, `Invoke-Command`, `Start-Process`, .NET calls, `busybox`, `wsl`, remote
 *    execution over `ssh`, an encoded PowerShell command.
 *  - IS IT CLEAN? A line is clean when it is plain simple commands and nothing that builds a command
 *    at run time or wraps one in a structure: no `$( )` or backticks, no variable as the program, no
 *    alias, function, `.`/`source`, `trap`, no reserved words or control structures, no `{ }` or
 *    `( )`, no `&` (background, or PowerShell's call operator), no here-doc or here-string, no line
 *    continuation (`clean`). Only a clean line can be let through without asking (see
 *    command-allowlist.ts).
 */

/** Longer than this is not read at all: asked every time, and never handed to a pattern. */
export const MAX_ANALYSED_COMMAND = 4000;
/** Shells inside shells inside shells: past this, asked about. */
const MAX_DEPTH = 4;

export type CommandFloor = {
  source:
    | "destructive_tool"
    | "outbound_send"
    | "share_access"
    | "publish_post";
  reason: string;
};

/** One simple command, as the allowlist reads it. */
export type CommandPart = {
  /** The program's own name: lower case, no folder, no `.exe`. */
  program: string;
  args: string[];
  /** The wrappers in front of it (`env`, `time`, `sudo`, …); `<name>-options` when given options. */
  wrappers: string[];
  /** Names assigned in front of it (`NODE_ENV=test`, `env CI=1`). */
  env: string[];
  /** Reached through a shell, PowerShell, `cmd`, `find -exec` or the like. */
  nested: boolean;
};

export type CommandAnalysis = {
  parts: CommandPart[];
  /** See the top of this file. */
  clean: boolean;
  /** Why it is not clean, for the card. */
  unclean?: string;
  /** Output redirected into a file (not the null device). */
  writesFile: boolean;
  floor?: CommandFloor;
  risky?: string;
  /** The dangerous-command or sensitive-path tables of SEC1. */
  danger?: string;
  network: boolean;
  push: boolean;
};

const FLOOR_ORDER: CommandFloor["source"][] = [
  "destructive_tool",
  "outbound_send",
  "share_access",
  "publish_post",
];
const FLOOR_REASONS: Record<CommandFloor["source"], string> = {
  destructive_tool: DESTRUCTIVE_TOOL_REASON,
  outbound_send: OUTBOUND_SEND_REASON,
  share_access: SHARE_ACCESS_REASON,
  publish_post: PUBLISH_POST_REASON,
};

const UNREADABLE = "看不到这条命令的内容，先问你。";
const UNPARSEABLE = "这条命令拆不开，看不清它要做什么，先问你。";
const TOO_LONG = "这条命令太长，看不过来，先问你。";
const RISKY_PIPE =
  "这条命令把内容直接交给解释器执行（比如下载后立刻运行、从标准输入读脚本），先问你。";
const RISKY_EVAL =
  "这条命令会执行一段临时拼出来的代码（eval、Invoke-Expression 之类），先问你。";
const RISKY_INLINE =
  "这条命令直接执行一段内联代码（python -c、node -e 之类），看不清它要做什么，先问你。";
const RISKY_ENCODED = "这条命令是编码过的，看不清它要做什么，先问你。";
const RISKY_RUNNER =
  "这条命令借别的程序再去运行命令（Start-Process、Invoke-Command、busybox、wsl 之类），先问你。";
const RISKY_DOTNET = "这条命令直接调用 .NET，看不清它要做什么，先问你。";
const RISKY_REMOTE = "这条命令在别的电脑上执行命令，先问你。";
const RISKY_CONFIG = "这条命令临时改了会执行命令的 git 设置，先问你。";

/** The keys an `execute` request's "allow for this conversation" is matched by. */
export function commandKey(command: string): string {
  let out = "";
  let quote: string | null = null;
  let space = "";
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i] as string;
    if (quote) {
      out += c;
      if (c === "\\" && quote === '"' && i + 1 < command.length) {
        out += command[i + 1];
        i += 1;
      } else if (c === quote) quote = null;
      continue;
    }
    if (/\s/.test(c)) {
      space = c === "\n" || c === "\r" || space === "\n" ? "\n" : " ";
      continue;
    }
    if (space) {
      out += space;
      space = "";
    }
    if (c === "'" || c === '"') quote = c;
    if (c === "\\" && i + 1 < command.length) {
      out += c + command[i + 1];
      i += 1;
      continue;
    }
    out += c;
  }
  return createHash("sha256").update(out.trim()).digest("hex").slice(0, 32);
}

type Word = {
  text: string;
  /** Starts with an unquoted `$` or `%`: a variable, not a name. */
  dynamic: boolean;
  /** An unquoted backslash before a letter: an escape a shell takes away. */
  escaped: boolean;
};
type Op = { op: string };
type Item = Word | Op;
type Lexed = { items: Item[]; subs: string[]; unclean?: string };

const isOp = (item: Item): item is Op => "op" in item;

/** The index of the `)` closing the `(` at `open`, skipping quoted text; -1 when there is none. */
function closing(input: string, open: number): number {
  let depth = 0;
  for (let i = open; i < input.length; i += 1) {
    const c = input[i];
    if (c === "'" || c === '"') {
      const end = input.indexOf(c, i + 1);
      if (end < 0) return -1;
      i = end;
    } else if (c === "(") depth += 1;
    else if (c === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** PowerShell reads curly quotes and dashes as quotes and dashes; so is the command read here. */
const plain = (command: string) =>
  command
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[–—―]/g, "-");

/**
 * A command line as words and operators, as a POSIX shell cuts it (and, near enough, cmd and
 * PowerShell). Separators are ops: `;` `&&` `||` `|` `&` newlines `(` `)` `{` `}`; a redirection is
 * an op whose target is the next word. `$( )`, `<( )`, `>( )` and backticks are commands of their
 * own (`subs`). In double quotes a backslash escapes only `$` `` ` `` `"` `\` and a newline (so a
 * Windows path keeps its `\`); unquoted, only a space, a quote or an operator. Null when something
 * is left open.
 */
function lex(input: string): Lexed | null {
  const items: Item[] = [];
  const subs: string[] = [];
  let unclean: string | undefined;
  const dirty = (why: string) => {
    unclean ??= why;
  };
  let text = "";
  let has = false;
  let dynamic = false;
  let escaped = false;
  const end = () => {
    if (has) items.push({ text, dynamic, escaped });
    text = "";
    has = false;
    dynamic = false;
    escaped = false;
  };
  const substitution = (body: string) => {
    subs.push(body);
    dirty("含命令替换");
  };
  for (let i = 0; i < input.length; ) {
    const c = input[i] as string;
    const next = input[i + 1];
    if (c === "'") {
      const stop = input.indexOf("'", i + 1);
      if (stop < 0) return null;
      text += input.slice(i + 1, stop);
      has = true;
      i = stop + 1;
      continue;
    }
    if (c === '"') {
      i += 1;
      while (i < input.length && input[i] !== '"') {
        const d = input[i] as string;
        if (
          d === "\\" &&
          i + 1 < input.length &&
          /[$`"\\\n]/.test(input[i + 1] as string)
        ) {
          if (input[i + 1] === "\n") dirty("含续行");
          text += input[i + 1];
          i += 2;
          continue;
        }
        if (d === "`") {
          const stop = input.indexOf("`", i + 1);
          if (stop < 0) return null;
          substitution(input.slice(i + 1, stop));
          text += "\u0000SUB";
          i = stop + 1;
          continue;
        }
        if (input.startsWith("$(", i)) {
          const stop = closing(input, i + 1);
          if (stop < 0) return null;
          substitution(input.slice(i + 2, stop));
          text += "\u0000SUB";
          i = stop + 1;
          continue;
        }
        text += d;
        i += 1;
      }
      if (i >= input.length) return null;
      has = true;
      i += 1;
      continue;
    }
    if (c === "\\" && next !== undefined) {
      if (next === "\n" || next === "\r") {
        dirty("含续行");
        i += next === "\r" && input[i + 2] === "\n" ? 3 : 2;
        continue;
      }
      if (/[\s'"`;&|()<>{}\\$]/.test(next)) {
        text += next;
        has = true;
        i += 2;
        continue;
      }
      // `C:\x`, `.\x`, `..\x` are paths; `\rm`, `r\m` are escapes a shell takes away.
      if (
        /[A-Za-z0-9]/.test(next) &&
        !/[:\\/]/.test(text) &&
        text !== "." &&
        text !== ".."
      )
        escaped = true;
      text += c;
      has = true;
      i += 1;
      continue;
    }
    if (c === "^" && (next === "\n" || next === "\r")) {
      dirty("含续行");
      i += 2;
      continue;
    }
    if (c === "`") {
      const stop = input.indexOf("`", i + 1);
      if (stop < 0) return null;
      substitution(input.slice(i + 1, stop));
      text += "\u0000SUB";
      has = true;
      i = stop + 1;
      continue;
    }
    if (
      c === "$" &&
      (next === "(" ||
        next === "{" ||
        next === "'" ||
        next === '"' ||
        /[A-Za-z_0-9@*#?!$-]/.test(next ?? ""))
    ) {
      if (next === "(") {
        const stop = closing(input, i + 1);
        if (stop < 0) return null;
        substitution(input.slice(i + 2, stop));
        if (!has) dynamic = true;
        text += "\u0000SUB";
        has = true;
        i = stop + 1;
        continue;
      }
      if (!has) dynamic = true;
      text += c;
      has = true;
      i += 1;
      continue;
    }
    if ((c === "<" || c === ">") && next === "(") {
      const stop = closing(input, i + 1);
      if (stop < 0) return null;
      substitution(input.slice(i + 2, stop));
      text += "\u0000PROC";
      has = true;
      i = stop + 1;
      continue;
    }
    if (c === "%" && !has) dynamic = true;
    if (
      c === "@" &&
      (next === "'" || next === '"' || next === "(" || next === "{")
    )
      dirty("含 PowerShell 的 here-string 或数组");
    const two = input.slice(i, i + 2);
    if (two === "&&" || two === "||" || two === "|&") {
      end();
      items.push({ op: two === "|&" ? "|" : two });
      i += 2;
      continue;
    }
    if (c === ">" || c === "<" || (c === "&" && next === ">")) {
      // A file descriptor written right before it (`2>`) belongs to it.
      if (has && /^\d+$/.test(text) && !dynamic) {
        text = "";
        has = false;
      }
      end();
      let redirect = "";
      while (i < input.length && /[<>&|]/.test(input[i] as string)) {
        if (input[i] === "|" && redirect !== ">") break;
        redirect += input[i];
        i += 1;
      }
      if (/&$/.test(redirect) && /[\d-]/.test(input[i] ?? "")) {
        // `2>&1`, `>&-`: a descriptor duplicated or closed, not a file.
        while (i < input.length && /[\d-]/.test(input[i] as string)) i += 1;
        continue;
      }
      if (redirect.startsWith("<<")) dirty("含 here-doc");
      items.push({ op: `redirect:${redirect}` });
      continue;
    }
    if (";|&\n\r(){}".includes(c)) {
      end();
      if (c === "(" || c === ")" || c === "{" || c === "}")
        dirty("含括号或脚本块");
      if (c === "&") dirty("含 & 运算符");
      items.push({ op: c === "\r" ? "\n" : c });
      i += 1;
      continue;
    }
    if (/\s/.test(c)) {
      end();
      i += 1;
      continue;
    }
    text += c;
    has = true;
    i += 1;
  }
  end();
  return { items, subs, ...(unclean ? { unclean } : {}) };
}

/** A program as it is called: its file name, lower case, without `.exe` and the like. */
export const programName = (word: string) =>
  (word.split(/[\\/]/).pop() ?? word)
    .toLowerCase()
    .replace(/\.(exe|cmd|bat|com)$/, "");

/** Shell words that make a line a structure, not a plain command. */
const RESERVED = new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "do",
  "done",
  "for",
  "while",
  "until",
  "case",
  "esac",
  "select",
  "function",
  "in",
  "!",
  "[[",
  "]]",
  "coproc",
  "foreach",
]);
/** Reserved words a command follows directly: what follows is still a command to judge. */
const LEADING = new Set([
  "then",
  "do",
  "else",
  "!",
  "if",
  "while",
  "until",
  "elif",
  "time",
]);
const SHELLS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "mksh",
  "fish",
  "ash",
  "csh",
  "tcsh",
]);
const INTERPRETERS = new Set([
  ...SHELLS,
  "python",
  "python2",
  "python3",
  "py",
  "node",
  "nodejs",
  "deno",
  "bun",
  "perl",
  "ruby",
  "php",
  "lua",
  "tclsh",
  "rscript",
  "osascript",
  "powershell",
  "pwsh",
  "cmd",
]);
/** The wrappers in front of a program, with the options of theirs that take a value. */
const WRAPPERS: Record<string, Set<string>> = {
  env: new Set(["-u", "--unset", "-C", "--chdir"]),
  sudo: new Set([
    "-u",
    "-g",
    "-U",
    "-C",
    "-h",
    "-p",
    "-r",
    "-t",
    "-D",
    "--user",
    "--group",
  ]),
  doas: new Set(["-u", "-C"]),
  nohup: new Set(),
  command: new Set(),
  exec: new Set(["-a"]),
  builtin: new Set(),
  time: new Set(["-f", "-o"]),
  nice: new Set(["-n"]),
  ionice: new Set(["-c", "-n"]),
  stdbuf: new Set(["-i", "-o", "-e"]),
  timeout: new Set(["-s", "-k", "--signal", "--kill-after"]),
  xargs: new Set([
    "-I",
    "-i",
    "-n",
    "-P",
    "-L",
    "-l",
    "-d",
    "-s",
    "-E",
    "-e",
    "-a",
  ]),
  parallel: new Set(["-j", "--jobs", "-S", "--sshlogin", "--joblog"]),
  watch: new Set(["-n", "-d"]),
  chronic: new Set(),
  caffeinate: new Set(),
  unbuffer: new Set(),
  // Windows: `start "" prog`.
  start: new Set(["/d"]),
  // Package runners: download a package and run its program.
  npx: new Set(["-p", "--package"]),
  pnpx: new Set(["-p", "--package"]),
  bunx: new Set(["-p", "--package"]),
  uvx: new Set(["--from", "--with", "-p", "--python"]),
  pipx: new Set(["--spec"]),
};
/** Wrappers that fetch what they run from the network. */
const DOWNLOADERS = new Set(["npx", "pnpx", "bunx", "uvx"]);
const DELETE_PROGRAMS = new Set([
  "rm",
  "rmdir",
  "unlink",
  "shred",
  "srm",
  "wipe",
  "truncate",
  "rimraf",
  "del-cli",
  "trash",
  "trash-put",
  "del",
  "erase",
  "rd",
  "remove-item",
  "ri",
  "clear-content",
  "clc",
  "remove-itemproperty",
]);
const MAIL_PROGRAMS = new Set([
  "send-mailmessage",
  "send-mgusermail",
  "sendmail",
  "mail",
  "mailx",
  "mutt",
  "neomutt",
  "msmtp",
  "swaks",
  "ssmtp",
]);
const HTTP_PROGRAMS = new Set([
  "curl",
  "wget",
  "invoke-webrequest",
  "invoke-restmethod",
  "iwr",
  "irm",
  "http",
  "https",
  "xh",
  "aria2c",
]);
const SOCKET_PROGRAMS = new Set(["nc", "ncat", "netcat", "socat", "telnet"]);
const REMOTE_COPY = new Set([
  "scp",
  "sftp",
  "ftp",
  "lftp",
  "tftp",
  "ncftp",
  "smbclient",
  "pscp",
]);
const RUNNERS = new Set([
  "busybox",
  "toybox",
  "wsl",
  "start-process",
  "saps",
  "invoke-command",
  "icm",
  "start-job",
  "sajb",
  "invoke-item",
  "ii",
  "forfiles",
  "runas",
  "schtasks",
  "at",
]);
const EVALUATORS = new Set(["eval", "iex", "invoke-expression"]);

/** Installing dependencies or downloading: the network rule, read per simple command. */
const NETWORK_COMMANDS = [
  /\b(npm|pnpm|yarn|bun|cnpm)\s+(install|i|add|ci|update|upgrade|up|dlx|x)\b/i,
  /^(npx|pnpx|bunx|uvx|pipx)\s+\S/i,
  /^yarn$/i,
  /\bpip3?\s+(install|download)\b/i,
  /\bpython3?\s+-m\s+pip\s+install\b/i,
  /\buv\s+(pip\s+install|add|sync|tool\s+install)\b/i,
  /\b(poetry|pdm|conda|mamba)\s+(add|install|update)\b/i,
  /\bcargo\s+(add|install|fetch|update)\b/i,
  /\bgo\s+(get|install|mod\s+download)\b/i,
  /\bgem\s+install\b/i,
  /\bbundle\s+(install|update)\b/i,
  /\b(brew|apt|apt-get|yum|dnf|apk|pacman|zypper|choco|winget|scoop|port)\s+(install|add|upgrade|-S)\b/i,
  /\bcomposer\s+(install|require|update)\b/i,
  /\bdotnet\s+(add\s+package|restore)\b/i,
];

/**
 * Floors read over the whole line, with nothing taken apart (the patterns of 880a55e3, unanchored):
 * wherever they show up, they count. Run only on a line short enough to read.
 */
const LINE_FLOORS: { source: CommandFloor["source"]; pattern: RegExp }[] = [
  {
    source: "outbound_send",
    pattern:
      /hooks\.slack\.com|slack\.com\/api\/chat\.|discord(app)?\.com\/api\/webhooks|api\.telegram\.org\/bot|oapi\.dingtalk\.com|qyapi\.weixin\.qq\.com|open\.feishu\.cn\/open-apis\/bot|api\.twilio\.com|api\.sendgrid\.com|api\.mailgun\.net|graph\.microsoft\.com\/\S*\/sendmail|\bsmtps?:\/\/|\/dev\/(tcp|udp)\/|\bsmtplib\b|\bnodemailer\b/i,
  },
  {
    source: "outbound_send",
    pattern:
      /(?:^|[;&|(\n]\s*|\bsudo\s+)(mail|mailx|sendmail|mutt|msmtp|swaks)\b|\bgh\b[^;&|\n]*\b(issue|pr)\s+(comment|review|create)\b|\bgh\s+api\b[^;&|\n]*(\s-[fF]\s|\s--(raw-)?field\b|\s--input\b|\s-X\s*(post|put|patch|delete)\b|\s--method\s+(post|put|patch|delete)\b)|\bgit\b[^;&|\n]*\b(send-email|imap-send)\b|\brclone\s+(copy|sync|move|copyto|moveto)\b|\baws\s+s3\s+(cp|sync|mv)\b|\bgsutil\s+(-m\s+)?(cp|rsync|mv)\b|\baz\s+storage\s+blob\s+upload/i,
  },
  {
    source: "share_access",
    pattern:
      /\bgh\s+repo\s+edit\b[^;&|\n]*--visibility\b|\bgh\s+repo\s+create\b[^;&|\n]*--public\b|\bgh\s+gist\s+create\b|\bgh\s+api\b[^;&|\n]*\/collaborators\//i,
  },
  {
    source: "publish_post",
    pattern:
      /\b(npm|pnpm|yarn)\b[^;&|\n]*\bpublish\b|\b(cargo|poetry|vsce|ovsx|flit|hatch)\s+publish\b|\btwine\s+upload\b|\bgem\s+push\b|\bgh\s+release\s+create\b|\bdocker\b[^;&|\n]*\bpush\b|\bpodman\s+push\b|\bdotnet\s+nuget\s+push\b/i,
  },
  {
    source: "destructive_tool",
    pattern:
      /\.(delete|deletesubkey|deletesubkeytree|removeall)\s*\(|\bshutil\.rmtree\b|\bos\.(remove|unlink|rmdir|removedirs)\b|\b(rmsync|unlinksync|rmdirsync)\b|\bcrontab\s+(-\S*\s+)*-r\b/i,
  },
];

/** The subcommand of `git`, past its global options, and those options. */
function gitSubcommand(args: string[]): {
  sub: string;
  rest: string[];
  config: string[];
} {
  const config: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === "-c") {
      config.push(args[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (/^(-C|--git-dir|--work-tree|--namespace|--exec-path)$/.test(arg)) {
      i += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    return { sub: arg.toLowerCase(), rest: args.slice(i + 1), config };
  }
  return { sub: "", rest: [], config };
}

/** Whether an HTTP client call sends something: data, a form, an upload, or a writing method. */
function uploads(program: string, args: string[]): boolean {
  const writing = (method: string | undefined) =>
    /^(post|put|patch|delete)$/i.test(method ?? "");
  if (program === "curl")
    return args.some(
      (arg, index) =>
        /^--(d|da|dat|data|data-[a-z]+|form|form-string|upload-file|json|mail-rcpt|mail-from)(=|$)/.test(
          arg,
        ) ||
        // Short options, case as curl reads it: -d data, -F form, -T upload (`-fsSL` is none).
        (/^-[A-Za-z]/.test(arg) &&
          !arg.startsWith("--") &&
          /^-[A-Za-z]*[dFT]/.test(arg)) ||
        /^-X(post|put|patch|delete)$/i.test(arg) ||
        ((arg === "-X" || arg === "--request") && writing(args[index + 1])) ||
        /^--request=(post|put|patch|delete)$/i.test(arg) ||
        /^(-K|--config)$/.test(arg),
    );
  if (program === "wget")
    return args.some(
      (arg, index) =>
        /^--(post-data|post-file|body-data|body-file)(=|$)/i.test(arg) ||
        /^--method=(post|put|patch|delete)$/i.test(arg) ||
        (arg === "--method" && writing(args[index + 1])) ||
        arg === "-e" ||
        /^--execute/.test(arg),
    );
  if (program === "http" || program === "https" || program === "xh")
    return args.some(
      (arg) =>
        writing(arg) ||
        /^(-f|--form|--raw)(=|$)/.test(arg) ||
        /^[\w.-]+(:=|=|@)/.test(arg),
    );
  if (program === "aria2c") return false;
  // PowerShell: -Body, -InFile, -Method Post|Put|Patch, -Method:Post, any unique prefix of them.
  const lower = args.map((arg) => arg.toLowerCase());
  const parameter = (arg: string, name: string, shortest: number) => {
    const bare = arg.replace(/^-/, "").split(":")[0] as string;
    return (
      arg.startsWith("-") && bare.length >= shortest && name.startsWith(bare)
    );
  };
  return lower.some(
    (arg, index) =>
      parameter(arg, "body", 1) ||
      parameter(arg, "infile", 1) ||
      (parameter(arg, "method", 1) &&
        (writing(arg.split(":")[1]) || writing(lower[index + 1]))),
  );
}

/** A remote end of `rsync`: `host:path`, `user@host:path`, `host::module`, `rsync://` (not `C:\…`). */
const remoteArg = (arg: string) =>
  !arg.startsWith("-") &&
  !/^[a-z]:[\\/]/i.test(arg) &&
  (/^[^/\\\s]+:/.test(arg) || /^rsync:\/\//i.test(arg));

/** Whether a PowerShell parameter is a prefix of `name` at least `shortest` long (`-Com`). */
const psParameter = (arg: string, name: string, shortest: number) => {
  const bare = arg.replace(/^[-/]/, "").toLowerCase();
  return /^[-/]/.test(arg) && bare.length >= shortest && name.startsWith(bare);
};
/** PowerShell's own parameters that take a value. */
const PS_VALUED = [
  ["executionpolicy", 2],
  ["ex", 2],
  ["ep", 2],
  ["workingdirectory", 2],
  ["wd", 2],
  ["outputformat", 2],
  ["inputformat", 2],
  ["windowstyle", 1],
  ["configurationname", 3],
  ["version", 1],
  ["psconsolefile", 2],
  ["settingsfile", 2],
  ["custompipename", 2],
] as const;

type Facts = {
  parts: CommandPart[];
  floors: Set<CommandFloor["source"]>;
  unclean?: string;
  risky?: string;
  writesFile: boolean;
  network: boolean;
  push: boolean;
};

const dirty = (facts: Facts, why: string) => {
  facts.unclean ??= why;
};
const risky = (facts: Facts, why: string) => {
  facts.risky ??= why;
};

/** How a simple command was reached: piped into, fed a file, inside something else. */
type Context = {
  pipedInto: boolean;
  stdin: boolean;
  nested: boolean;
  depth: number;
};

/** The words of a nested command (`find -exec …`, `fd -x …`) until its terminator. */
function execWords(args: Word[], from: number): Word[] {
  const words: Word[] = [];
  for (let i = from; i < args.length; i += 1) {
    const text = (args[i] as Word).text;
    if (text === ";" || text === "+" || text === "\\;") break;
    words.push(args[i] as Word);
  }
  return words;
}

/** One simple command: what it is, once its wrappers and shells are taken off. */
function simpleCommand(input: Word[], context: Context, facts: Facts): void {
  let words = [...input];
  const env: string[] = [];
  const wrappers: string[] = [];
  // Reserved words in front of a command (`then rm x`, `do rm $f`): structure, and still a command.
  while (words.length > 0 && LEADING.has((words[0] as Word).text)) {
    if ((words[0] as Word).text !== "time") dirty(facts, "含控制结构");
    else wrappers.push("time");
    words.shift();
  }
  for (let guard = 0; guard < 20 && words.length > 0; guard += 1) {
    while (
      words.length > 0 &&
      /^[A-Za-z_][A-Za-z0-9_]*=/.test((words[0] as Word).text)
    )
      env.push((words.shift() as Word).text.split("=")[0] as string);
    const name = programName((words[0] as Word | undefined)?.text ?? "");
    const valued = WRAPPERS[name];
    if (!valued) break;
    words.shift();
    let options = false;
    while (
      words.length > 0 &&
      ((words[0] as Word).text.startsWith("-") ||
        (name === "start" && (words[0] as Word).text.startsWith("/")))
    ) {
      const option = (words.shift() as Word).text;
      if (option === "--") break;
      options = true;
      if (
        (name === "env" && (option === "-S" || option === "--split-string")) ||
        (name === "npx" && (option === "-c" || option === "--call"))
      ) {
        const script = words.shift();
        if (script)
          analyseInto(
            script.text,
            { ...context, nested: true, depth: context.depth + 1 },
            facts,
          );
        return;
      }
      if (valued.has(option)) words.shift();
    }
    wrappers.push(options ? `${name}-options` : name);
    if (DOWNLOADERS.has(name)) facts.network = true;
    if (name === "pipx" && (words[0] as Word | undefined)?.text === "run") {
      facts.network = true;
      words.shift();
    }
    if (name === "timeout" && words.length > 0) words.shift();
    if (name === "parallel") {
      const marker = words.findIndex(
        (word) => word.text === ":::" || word.text === "::::",
      );
      if (marker >= 0) words = words.slice(0, marker);
    }
    if (name === "start" && words[0]?.text === "") words.shift();
  }
  if (words.length === 0) return;
  const head = words[0] as Word;
  if (RESERVED.has(head.text.toLowerCase())) {
    // `for f in *`, `case $x in`, `function f`: a structure; its words are not a command.
    dirty(facts, "含控制结构");
    return;
  }
  if (head.dynamic || head.text.includes("\u0000"))
    dirty(facts, "程序名是变量或替换出来的");
  if (head.escaped) dirty(facts, "程序名带转义");
  const program = programName(head.text);
  // `r\m` is `rm` to a shell: judged under both names.
  const names = new Set([program, programName(head.text.replace(/\\/g, ""))]);
  const argWords = words.slice(1);
  const args = argWords.map((word) => word.text);
  const lower = args.map((arg) => arg.toLowerCase());
  const nested = (script: string) =>
    analyseInto(
      script,
      { ...context, nested: true, depth: context.depth + 1 },
      facts,
    );
  const has = (set: Set<string>) => [...names].some((name) => set.has(name));

  // Structure, definitions and dynamic code.
  if (program === "alias") {
    dirty(facts, "含 alias");
    for (const arg of args) {
      const value = arg.split("=").slice(1).join("=");
      if (value) nested(value);
    }
    return;
  }
  if (program === "trap") {
    dirty(facts, "含 trap");
    if (args[0]) nested(args[0]);
    return;
  }
  if (program === "." || program === "source") {
    dirty(facts, "含 . 或 source");
    if (argWords.length > 0)
      simpleCommand(argWords, { ...context, nested: true }, facts);
    return;
  }
  if (has(EVALUATORS)) {
    risky(facts, RISKY_EVAL);
    return;
  }
  if (/\]::/.test(head.text) || args.some((arg) => /^\[[\w.]+\]::/.test(arg))) {
    risky(facts, RISKY_DOTNET);
  }
  if (has(RUNNERS)) {
    risky(facts, RISKY_RUNNER);
    // What it runs is still judged for floors.
    if (argWords.length > 0)
      simpleCommand(argWords, { ...context, nested: true }, facts);
    return;
  }

  // Shells and interpreters.
  if (SHELLS.has(program)) {
    const flag = args.findIndex((arg) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg));
    // Commands read from input (`xargs sh -c`, `sh -c '{}'`): nobody can see them.
    if (
      wrappers.some((wrapper) => /^(xargs|parallel)/.test(wrapper)) ||
      args.some((arg) => arg.includes("{}"))
    )
      risky(facts, RISKY_PIPE);
    if (flag >= 0) {
      const script = args[flag + 1];
      if (script === undefined || script.includes("\u0000"))
        risky(facts, script === undefined ? UNPARSEABLE : RISKY_PIPE);
      if (script !== undefined) nested(script);
      return;
    }
    const script = args.find((arg) => !arg.startsWith("-"));
    if (
      context.pipedInto ||
      context.stdin ||
      !script ||
      args.includes("-s") ||
      script.includes("\u0000")
    )
      risky(facts, RISKY_PIPE);
  }
  if (program === "powershell" || program === "pwsh") {
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i] as string;
      if (!/^[-/]/.test(arg)) {
        // No -Command and no -File: PowerShell runs the rest as a command.
        nested(args.slice(i).join(" "));
        return;
      }
      if (psParameter(arg, "encodedcommand", 1) || psParameter(arg, "ec", 2)) {
        risky(facts, RISKY_ENCODED);
        return;
      }
      if (
        psParameter(arg, "commandwithargs", 4) ||
        psParameter(arg, "cwa", 3) ||
        psParameter(arg, "command", 1)
      ) {
        const script = args.slice(i + 1).join(" ");
        if (script === "-" || script === "" || context.stdin)
          risky(facts, RISKY_PIPE);
        else nested(script);
        return;
      }
      if (psParameter(arg, "file", 1)) {
        // A script on disk: run, unseen. Not clean enough to go through unasked.
        dirty(facts, "运行脚本文件");
        break;
      }
      if (
        PS_VALUED.some(([name, shortest]) => psParameter(arg, name, shortest))
      )
        i += 1;
    }
    if (context.pipedInto || context.stdin) risky(facts, RISKY_PIPE);
  }
  if (program === "cmd") {
    const flag = lower.findIndex((arg) => /^\/[ckr]/.test(arg));
    if (flag >= 0) {
      const attached = (args[flag] as string).slice(2);
      nested([attached, ...args.slice(flag + 1)].filter(Boolean).join(" "));
      return;
    }
    if (context.pipedInto || context.stdin) risky(facts, RISKY_PIPE);
  }
  // Inline code, or code read from standard input.
  const inline = (flags: RegExp) => lower.some((arg) => flags.test(arg));
  if (/^python[0-9.]*$|^py$/.test(program)) {
    const script = args.find((arg) => !arg.startsWith("-"));
    if (
      inline(/^-[a-z]*c$/i) ||
      args.includes("-") ||
      ((!script || context.pipedInto || context.stdin) &&
        !inline(/^-(m|v|-version|h|-help)$/))
    )
      risky(facts, RISKY_INLINE);
  }
  if (program === "node" || program === "nodejs" || program === "bun") {
    if (
      inline(/^(-e|--eval|-p|--print|-pe)(=|$)/) ||
      args.includes("-") ||
      ((context.pipedInto || context.stdin) && args.length === 0)
    )
      risky(facts, RISKY_INLINE);
  }
  if (
    program === "deno" &&
    (lower[0] === "eval" || lower.includes("-") || inline(/^(-e|--eval)$/))
  )
    risky(facts, RISKY_INLINE);
  if (
    (program === "perl" || program === "ruby") &&
    (inline(/^-[a-z]*e[a-z]*$/i) ||
      ((context.pipedInto || context.stdin) &&
        !args.some((arg) => !arg.startsWith("-"))))
  )
    risky(facts, RISKY_INLINE);
  if (
    program === "php" &&
    (inline(/^-[a-z]*r$/) || inline(/^-(a|-run|-interactive)$/))
  )
    risky(facts, RISKY_INLINE);
  if (
    (program === "lua" || program === "tclsh" || program === "rscript") &&
    (inline(/^-e$/) || context.pipedInto || context.stdin)
  )
    risky(facts, RISKY_INLINE);
  if (program === "osascript") risky(facts, RISKY_INLINE);
  if (
    /^(g|m|n)?awk$/.test(program) &&
    args.some((arg) => /\bsystem\s*\(|\|\s*"|"\s*\|/.test(arg))
  )
    risky(facts, RISKY_INLINE);
  if (
    /^(vim?|nvim|ex|view)$/.test(program) &&
    args.some((arg) => /^(-c|--cmd|\+)/.test(arg))
  )
    risky(facts, RISKY_INLINE);
  if (
    (program === "ssh" || program === "plink") &&
    args.filter((arg) => !arg.startsWith("-")).length > 1
  )
    risky(facts, RISKY_REMOTE);
  if (
    INTERPRETERS.has(program) &&
    args.some((arg) => arg.includes("\u0000PROC"))
  )
    risky(facts, RISKY_PIPE);

  facts.parts.push({ program, args, wrappers, env, nested: context.nested });
  const text = [program, ...args].join(" ");

  // Deleting.
  if (has(DELETE_PROGRAMS)) facts.floors.add("destructive_tool");
  if (program === "find" || program === "fd" || program === "fdfind") {
    const exec = lower.findIndex((arg) =>
      program === "find"
        ? /^-(exec|execdir|ok|okdir)$/.test(arg)
        : /^(-x|--exec|--exec-batch)$/.test(arg),
    );
    if (lower.includes("-delete")) facts.floors.add("destructive_tool");
    if (exec >= 0) {
      dirty(facts, "交给别的命令执行");
      const sub = execWords(argWords, exec + 1);
      if (sub.length > 0)
        simpleCommand(sub, { ...context, nested: true }, facts);
    }
  }
  if (
    program === "rsync" &&
    lower.some(
      (arg) => arg.startsWith("--delete") || arg === "--remove-source-files",
    )
  )
    facts.floors.add("destructive_tool");
  if (program === "mv" && lower.at(-1) === "/dev/null")
    facts.floors.add("destructive_tool");
  if (program === "cp" && lower[0] === "/dev/null")
    facts.floors.add("destructive_tool");
  if (program === "crontab" && lower.some((arg) => /^-[a-z]*r/.test(arg)))
    facts.floors.add("destructive_tool");
  if (program === "git") {
    const { sub, rest, config } = gitSubcommand(args);
    if (
      config.some((value) =>
        /!|sshcommand|pager|editor|askpass|hookspath|fsmonitor|\.cmd|alias\.|credential\.helper|core\.(gitproxy|exec)/i.test(
          value,
        ),
      )
    )
      risky(facts, RISKY_CONFIG);
    if (sub === "rm") facts.floors.add("destructive_tool");
    if (
      sub === "clean" &&
      rest.some((arg) => /^-[a-z]*f/i.test(arg) || arg === "--force")
    )
      facts.floors.add("destructive_tool");
    if (sub === "send-email" || sub === "imap-send")
      facts.floors.add("outbound_send");
    if (sub === "push") facts.push = true;
    if (sub === "clone" || sub === "fetch" || sub === "pull")
      facts.network = true;
  }
  if (
    (program === "hg" && lower[0] === "push") ||
    (program === "jj" && lower[0] === "git" && lower[1] === "push")
  )
    facts.push = true;
  if (program === "svn" && (lower[0] === "commit" || lower[0] === "ci"))
    facts.push = true;

  // Sending to people.
  if (has(MAIL_PROGRAMS)) facts.floors.add("outbound_send");
  if (HTTP_PROGRAMS.has(program)) {
    facts.network = true;
    if (uploads(program, args)) facts.floors.add("outbound_send");
  }
  if (SOCKET_PROGRAMS.has(program)) {
    facts.network = true;
    facts.floors.add("outbound_send");
  }
  if (REMOTE_COPY.has(program)) {
    facts.network = true;
    facts.floors.add("outbound_send");
  }
  if (program === "rsync" && args.some(remoteArg)) {
    facts.network = true;
    facts.floors.add("outbound_send");
  }
  if (program === "ssh" || program === "plink") facts.network = true;
  if (program === "gh") {
    const verbs = lower.filter(
      (arg, index) =>
        !arg.startsWith("-") &&
        !/^-(r|R)$/.test(lower[index - 1] ?? "") &&
        lower[index - 1] !== "--repo",
    );
    const [area, verb] = verbs;
    if (
      (area === "issue" || area === "pr") &&
      (verb === "comment" || verb === "review")
    )
      facts.floors.add("outbound_send");
    if (area === "issue" && verb === "create")
      facts.floors.add("outbound_send");
    if (area === "pr" && (verb === "create" || verb === "merge"))
      facts.push = true;
    if (area === "release" && verb === "create")
      facts.floors.add("publish_post");
    if (
      area === "repo" &&
      verb === "edit" &&
      lower.some((arg) => arg.startsWith("--visibility"))
    )
      facts.floors.add("share_access");
    if (area === "gist" && verb === "create") facts.floors.add("share_access");
    if (area === "api") facts.network = true;
  }

  // Publishing.
  const firstVerb = lower.find((arg) => !arg.startsWith("-"));
  if (
    (["npm", "pnpm", "yarn", "cargo", "poetry", "vsce", "ovsx"].includes(
      program,
    ) &&
      lower.includes("publish") &&
      firstVerb !== "run") ||
    (program === "twine" && firstVerb === "upload") ||
    (program === "gem" && firstVerb === "push") ||
    ((program === "docker" || program === "podman") && lower.includes("push"))
  )
    facts.floors.add("publish_post");

  if (NETWORK_COMMANDS.some((pattern) => pattern.test(text)))
    facts.network = true;
}

/** Every simple command of a command line, into `facts`. */
function analyseInto(command: string, context: Context, facts: Facts): void {
  if (context.depth > MAX_DEPTH) {
    risky(facts, UNPARSEABLE);
    return;
  }
  const lexed = lex(command);
  if (!lexed) {
    risky(facts, UNPARSEABLE);
    return;
  }
  if (lexed.unclean) dirty(facts, lexed.unclean);
  for (const sub of lexed.subs)
    analyseInto(
      sub,
      { ...context, nested: true, depth: context.depth + 1 },
      facts,
    );
  let words: Word[] = [];
  let pipedInto = false;
  let stdin = false;
  let redirect: string | null = null;
  const flush = (next: Op | null) => {
    if (words.length > 0)
      simpleCommand(words, { ...context, pipedInto, stdin }, facts);
    words = [];
    stdin = false;
    pipedInto = next?.op === "|";
  };
  for (const item of lexed.items) {
    if (isOp(item)) {
      if (item.op.startsWith("redirect:")) {
        redirect = item.op.slice("redirect:".length);
        continue;
      }
      if (redirect) {
        risky(facts, UNPARSEABLE);
        redirect = null;
      }
      flush(item);
      continue;
    }
    if (redirect !== null) {
      // The word after a redirection is its target, not an argument.
      const target = item.text.toLowerCase();
      if (redirect.includes(">")) {
        if (/^\/dev\/(tcp|udp)\//.test(target))
          facts.floors.add("outbound_send");
        else if (
          !/^(\/dev\/null|nul|\$null|\/dev\/stdout|\/dev\/stderr)$/.test(target)
        )
          facts.writesFile = true;
      } else if (redirect.startsWith("<")) stdin = true;
      redirect = null;
      continue;
    }
    words.push(item);
  }
  if (redirect !== null) risky(facts, UNPARSEABLE);
  flush(null);
}

/** The SEC1 tables over one piece of a command line. */
function sec1(command: string): string | undefined {
  return securityFloor(
    {
      actorId: "",
      botId: "",
      toolRef: "computer_run_command",
      effect: "write",
      scope: "",
      args: { command },
    },
    DEFAULT_EMPLOYEE_SECURITY,
    true,
  )?.reason;
}

/** What an `execute` request's command line does (see the top of this file). */
export function analyseCommand(command: string | null): CommandAnalysis {
  const nothing = {
    parts: [],
    clean: false,
    writesFile: false,
    network: false,
    push: false,
  };
  if (command === null)
    return { ...nothing, unclean: UNREADABLE, risky: UNREADABLE };
  if (command.length > MAX_ANALYSED_COMMAND)
    return { ...nothing, unclean: TOO_LONG, risky: TOO_LONG, danger: TOO_LONG };
  const line = plain(command);
  const facts: Facts = {
    parts: [],
    floors: new Set(),
    writesFile: false,
    network: false,
    push: false,
  };
  analyseInto(
    line,
    { pipedInto: false, stdin: false, nested: false, depth: 0 },
    facts,
  );
  for (const { source, pattern } of LINE_FLOORS)
    if (pattern.test(line)) facts.floors.add(source);
  // The SEC1 table read over the whole line too: what it calls piping to a shell or `eval` is risky.
  const table = dangerousCommand(line);
  if (table?.id === "pipe_to_shell") risky(facts, RISKY_PIPE);
  if (table?.id === "eval") risky(facts, RISKY_EVAL);
  const danger =
    facts.risky ??
    [line, ...facts.parts.map((part) => [part.program, ...part.args].join(" "))]
      .map(sec1)
      .find((reason) => reason !== undefined);
  const source = FLOOR_ORDER.find((entry) => facts.floors.has(entry));
  const unclean = facts.unclean ?? facts.risky;
  return {
    parts: facts.parts,
    clean: unclean === undefined,
    ...(unclean ? { unclean } : {}),
    writesFile: facts.writesFile,
    ...(source ? { floor: { source, reason: FLOOR_REASONS[source] } } : {}),
    ...(facts.risky ? { risky: facts.risky } : {}),
    ...(danger ? { danger } : {}),
    network: facts.network,
    push: facts.push,
  };
}
