/**
 * 员工的 Git 工作流工具（期 4 · Task 4.2）：开分支、提交、看改动摘要、开 PR。名字和上限见
 * `shared/git-tools.ts`。
 *
 * 在员工的电脑（工作区）上执行。前三个把一条 git 命令交给电脑网关的 `runCommand`，所以和
 * `computer_run_command` 走同一套：同一个审批门（人设了要审批、命令撞上危险底线，都照样问），同一份审计。
 * 不另造执行器，也不绕开审批：工具调用不在审批上下文之外跑。
 *
 * 每个工具调用最多只产生一条要过审批门的命令，这样批准之后服务器把这次调用原样再跑一遍
 * （`approvals/execute.ts`），被批准的就是那一条。`git_commit` 提交前的脱敏检查因此不靠 git 命令：先用
 * 电脑网关的文件读取（读，不过审批）看一遍要提交的文件，再发出唯一的那条 `git add && git commit`。
 *
 * 只动工作区里的仓库：每条命令先 `cd` 进仓库目录，再核对 `git rev-parse --show-toplevel` 落在工作区之内
 * （工作区外面的上层仓库、指向工作区外的软链接，都会被挡下）。命令是写给 bash 的，所以只在云端工作区
 * 提供；接了本人电脑（可能是 Windows）的部署不提供这几个工具，员工照旧用 `computer_run_command`。
 *
 * `git_commit` 提交前脱敏：要提交的文件（以及提交说明）里有密钥、令牌、口令、带凭据的网址、私钥，或者文件
 * 名就是 `.env`、私钥一类，整个提交拒绝，什么也不提交，并说出是哪一类。复用 `learning/sensitive.ts`
 * 的 `findSensitive`，只取其中和密钥有关的几类（邮箱、手机号在代码里太常见，拦了就没法提交）。
 *
 * `open_pull_request` 不碰令牌：要求员工已经有 GitHub 一类连接器（授予它的应用工具里有「创建 PR」），
 * 请求原样交给那个连接器工具，外发的审批、账号、审计都是连接器自己那一套；没有就用一句话说明，请本人接入。
 * 参数和连接器的「创建 PR」一一对应、不改写，批准之后重放走的就是连接器那条路径。
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  GIT_BRANCH_TOOL,
  GIT_COMMIT_LIMITS,
  GIT_COMMIT_TOOL,
  GIT_DIFF_LIMITS,
  GIT_DIFF_SUMMARY_TOOL,
  OPEN_PULL_REQUEST_TOOL,
} from "../../../shared/git-tools";
import {
  currentApprovalContext,
  withApprovalContext,
} from "../approvals/types";
import { findSensitive, type SensitiveKind } from "../learning/sensitive";
import type { GrantedTool } from "../plugins/tools";

type ToolExecution = Parameters<GrantedTool["execute"]>[1];

export const GIT_BRANCH_REF = `bot/${GIT_BRANCH_TOOL}`;
export const GIT_COMMIT_REF = `bot/${GIT_COMMIT_TOOL}`;
export const GIT_DIFF_SUMMARY_REF = `bot/${GIT_DIFF_SUMMARY_TOOL}`;
export const OPEN_PULL_REQUEST_REF = `bot/${OPEN_PULL_REQUEST_TOOL}`;

/** 一条命令的结果，电脑网关 `runCommand` 答的那几项。 */
export type GitCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated?: boolean;
  timedOut?: boolean;
};

/** 工具要用到的电脑：跑一条命令，读一个文件。读不到（不存在）答 `null`，别的错误照抛。 */
export type GitComputer = {
  run(command: string, signal?: AbortSignal): Promise<GitCommandResult>;
  read(
    path: string,
    signal?: AbortSignal,
  ): Promise<{ text: string; truncated: boolean; bytes: number } | null>;
};

export type GitToolsOptions = {
  /** 这位员工现在能用的电脑。没有（不能用电脑）答 undefined，工具就照实说。 */
  computer: () => Promise<GitComputer | undefined>;
  /** 授予这位员工的应用工具，`open_pull_request` 从里面找「创建 PR」。 */
  connectorTools: () => Promise<readonly GrantedTool[]>;
};

/** 提交前拦的敏感类别：和密钥有关的。邮箱、手机号、证件号、银行卡号在代码里太常见，不拦。 */
const SECRET_KINDS: ReadonlySet<SensitiveKind> = new Set<SensitiveKind>([
  "密钥或令牌",
  "口令",
  "带凭据的网址",
  "私钥",
]);

/** `findSensitive` 只看前 2 万个字符，长文字切块一块块看。 */
const SCAN_CHUNK = 15_000;

/** 文字里和密钥有关的敏感类别。 */
export function secretKindsIn(text: string): SensitiveKind[] {
  const found = new Set<SensitiveKind>();
  let chunk = "";
  const flush = () => {
    if (chunk)
      for (const kind of findSensitive(chunk))
        if (SECRET_KINDS.has(kind)) found.add(kind);
    chunk = "";
  };
  for (const line of text.split("\n")) {
    // 一行就超过一块的（压缩过的文件）自己切。
    for (let at = 0; at < line.length; at += SCAN_CHUNK) {
      const piece = line.slice(at, at + SCAN_CHUNK);
      if (chunk.length + piece.length + 1 > SCAN_CHUNK) flush();
      chunk += `${piece}\n`;
    }
  }
  flush();
  return [...found];
}

/** 文件名就是放密钥的：`.env`（`.env.example` 一类模板除外）、私钥、证书、凭据文件。 */
const SECRET_FILE =
  /(^|\/)(\.env(\.[^/]*)?|id_(rsa|dsa|ecdsa|ed25519)|[^/]*\.(pem|p12|pfx|key)|credentials(\.json)?|\.netrc|\.npmrc)$/i;
const SECRET_FILE_TEMPLATE = /\.(example|sample|template|dist)$/i;

export function isSecretFileName(path: string): boolean {
  return SECRET_FILE.test(path) && !SECRET_FILE_TEMPLATE.test(path);
}

/** 单引号包起来，里面的单引号换成 `'\''`：bash 里这样的参数不会被当成命令。 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** 控制字符（换行、制表、NUL 等）：路径里不该有。 */
function hasControl(text: string): boolean {
  for (let at = 0; at < text.length; at += 1) {
    const code = text.charCodeAt(at);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

/** 仓库目录和文件路径：相对工作区、不能往上跳、不能以 `-` 开头。 */
function safeRelative(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 300 &&
    !hasControl(path) &&
    !path.startsWith("/") &&
    !path.startsWith("~") &&
    !path.startsWith("-") &&
    !/^[A-Za-z]:/.test(path) &&
    !path.split("/").includes("..")
  );
}

/** 路径写具体文件：不要通配符和 pathspec 魔法（`:(…)`），那样检查和提交看到的就不是同一批文件。 */
function concretePath(path: string): boolean {
  return safeRelative(path) && !/[*?[\]]/.test(path) && !path.startsWith(":");
}

const REF_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;

/** 分支名或比较用的引用：字母数字开头，只有 `. _ / -`，不含 `..`、`//`，不以 `/`、`.`、`.lock` 结尾。 */
export function validRefName(name: string): boolean {
  return (
    REF_NAME.test(name) &&
    !name.includes("..") &&
    !name.includes("//") &&
    !/[/.]$/.test(name) &&
    !name.endsWith(".lock")
  );
}

/**
 * 每条命令的脚本，退出码 90 到 97 是这里自己定的，下面翻译成话。
 *
 * 在一个干净的子进程里跑：`/usr/bin/env -i` 清空环境，只给固定的 PATH、HOME 和语言，再起 `bash --noprofile
 * --norc -c`，git 用绝对路径。不是直接贴进员工的活 shell：活 shell 里 `cd` 会一直留着，`exit` 会结束整个
 * shell（员工的后台进程跟着没了）；员工 shell 里导出的函数（`export -f git`）、放在 PATH 前面的假 git、别名，
 * 也会让下面所有的 `-c` 防护落空。清空环境之后，这些都进不了子进程；外面的目录不变、shell 不退出。
 * 要说明的是：这挡不住员工把 `HOME` 本身改掉（命令是贴进员工自己的 shell 里的，`$HOME` 在那里展开）。
 *
 * 工作区根是 `$HOME`（电脑把 HOME 设成工作区），不是当前目录：员工先 `cd app` 再调用，工作区根也还是那个根。
 *
 * 仓库里的 git 配置不能拿来绕过底线：不读全局和系统配置（`GIT_CONFIG_GLOBAL=/dev/null`、
 * `GIT_CONFIG_NOSYSTEM=1`：HOME 就是工作区，员工写个 `.gitconfig` 就会被当成全局配置）；每条 git 都经 `g`，
 * 关掉钩子（`core.hooksPath`）、文件系统监视器（`core.fsmonitor`，`git diff`、`git status` 会启动它）、外部
 * diff 程序、属性文件、提交签名程序；diff 再加 `--no-ext-diff --no-textconv`。过滤器（`filter.*.clean`）
 * 列不全，三个工具都在进仓库之后先查仓库自己的配置（含 `include.path` 引进来的），有 `filter.*` 就拒绝；
 * `.gitattributes` 指定了 `filter=` 而配置里没定义的，git 不会执行任何东西，放行。
 */
const EXIT = {
  filter: 90,
  mismatch: 91,
  directory: 92,
  diff: 93,
  noDir: 94,
  noRepo: 96,
  outside: 97,
};

/** 关掉仓库配置能带来的执行：钩子、监视器、外部 diff、属性文件、提交签名、换行转换。 */
const SAFE_GIT = `"$GITBIN" -c core.hooksPath=/dev/null -c core.fsmonitor= -c diff.external= -c core.attributesFile=/dev/null -c commit.gpgsign=false -c core.autocrlf=false`;

function inRepo(directory: string, body: string): string {
  return [
    "set +e",
    // git 用绝对路径，不走 PATH。
    'GITBIN=; for c in /usr/bin/git /usr/local/bin/git /bin/git; do [ -x "$c" ] && { GITBIN=$c; break; }; done',
    '[ -n "$GITBIN" ] || exit 89',
    `g() { ${SAFE_GIT} "$@"; }`,
    'W="$(cd -- "$HOME" 2>/dev/null && pwd -P)" || exit 95',
    'cd -- "$W" || exit 95',
    `cd -- ${shellQuote(directory)} 2>/dev/null || exit ${EXIT.noDir}`,
    `T="$(g rev-parse --show-toplevel 2>/dev/null)" || exit ${EXIT.noRepo}`,
    `case "$T" in "$W"|"$W"/*) ;; *) exit ${EXIT.outside};; esac`,
    // 有过滤器的仓库不处理：过滤器是仓库配置里的命令，列不全，也会改写文件内容。
    `[ -z "$(g config --get-regexp '^filter\\..*\\.(clean|smudge|process)$' 2>/dev/null)" ] || exit ${EXIT.filter}`,
    body,
  ].join("\n");
}

/**
 * 在这次工具调用的审批上下文里，把实际要执行的命令文本也写进 `args.command`：审批卡片和审计看到的是这份
 * 参数，只有模型传的几个字段（paths、message）的话，批准的人看不出究竟要跑什么。工具自己的参数解析会丢掉
 * 多出来的 `command`，所以批准之后重放不受影响；原调用和复核写进去的命令一样，摘要也一样。
 */
export function showingCommand<T>(
  command: string,
  work: () => Promise<T>,
): Promise<T> {
  const context = currentApprovalContext();
  if (!context) return work();
  const args =
    context.args &&
    typeof context.args === "object" &&
    !Array.isArray(context.args)
      ? (context.args as Record<string, unknown>)
      : {};
  return withApprovalContext({ ...context, args: { ...args, command } }, work);
}

/**
 * 把脚本交给一个干净的 bash：清空环境（只留固定的 PATH、HOME、语言，和不读全局、系统配置的两个变量），
 * 不读启动文件，没有员工 shell 里的别名、导出的函数和当前目录。`HOME` 由员工 shell 展开，是工作区根。
 */
export function launch(script: string): string {
  return `/usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$HOME" LANG=C.UTF-8 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 /bin/bash --noprofile --norc -c ${shellQuote(script)}`;
}

function failure(error: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ok: false, error, ...extra });
}

/** 命令没成功时，对员工说的一句话。 */
function explain(result: GitCommandResult, directory: string): string {
  if (result.timedOut) return "git 命令超时了。";
  switch (result.exitCode) {
    case EXIT.noDir:
      return `工作区里没有「${directory}」这个目录。`;
    case EXIT.noRepo:
      return `「${directory}」不是 git 仓库。先用 computer_run_command 执行 git init，或者换一个仓库目录（repo 参数，相对工作区）。`;
    case EXIT.outside:
      return `「${directory}」所在的仓库不在你的工作区里面，这几个工具只动工作区里的仓库。`;
    case EXIT.diff:
      return "没能比较：base 写的引用不存在，或者仓库还没有任何提交。";
    case EXIT.filter:
      return "这个仓库的 git 配置里有过滤器（filter），它是会执行命令、改写文件内容的配置，这几个工具不处理这样的仓库。需要的话请本人来。";
    case EXIT.mismatch: {
      const path = /^@@mismatch=(.*)$/m.exec(result.stdout)?.[1];
      return `没有提交：暂存的「${path ?? "某个文件"}」和检查过的内容不一致（检查之后文件变了，或者 git 配置改写了内容），已经撤回暂存。请重新读一遍再提交。`;
    }
    case EXIT.directory:
      return "paths 里写了目录。请逐个写文件（可以先用 git_diff_summary 看有哪些改动文件）。";
    default: {
      const said = `${result.stderr}\n${result.stdout}`.trim();
      return said
        ? said.slice(-800)
        : `git 命令失败，退出码 ${result.exitCode}。`;
    }
  }
}

const repoField = z
  .string()
  .optional()
  .describe("仓库目录，相对工作区；不写就是工作区根目录");

/** 解析 repo 参数：没写是 `.`。写错了答 undefined。 */
function repoOf(repo: string | undefined): string | undefined {
  if (repo === undefined || repo === "" || repo === ".") return ".";
  return safeRelative(repo) ? repo : undefined;
}

/** 脚本输出按 `@@名字` 分段。 */
function sections(stdout: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of stdout.split("\n")) {
    const marker = /^@@([a-z]+)(?:=(.*))?$/.exec(line);
    if (marker) {
      current = marker[2] !== undefined ? [marker[2]] : [];
      found.set(marker[1] as string, current);
    } else current?.push(line);
  }
  return found;
}

const NO_COMPUTER = "你现在没有可用的电脑，这个工具要在你的工作区里跑 git。";

const NOT_CONNECTED =
  "你还没有接入可以开 Pull Request 的连接器（GitHub 一类，并且允许创建 PR）。我不会自己存令牌，也不会绕开：请本人在「应用」里接入 GitHub，并允许创建 Pull Request，接好之后再让我开。在那之前，可以把分支名、标题和说明交给本人，请本人手动开。";

/** 一段文字作为 git 对象（blob）的编号：sha1("blob <字节数>\0" + 内容)。 */
export function gitBlobId(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  return createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
}

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * 能开 Pull Request 的连接器，按 server id 精确认：内置目录的 GitHub（`github`，管理员把它放宽到带写权限的端点后
 * 才有「创建 PR」，默认的只读端点没有）、Composio 的 GitHub（`composio-github`）、Arcade 的（`arcade-github`），
 * 以及管理员登记 GitHub MCP 时用的 `github-mcp`。id 不在名单里的不认，免得名字里带 github 的别的服务被当成它。
 */
export const PULL_REQUEST_SERVERS: ReadonlySet<string> = new Set([
  "github",
  "composio-github",
  "arcade-github",
  "github-mcp",
]);

const PULL_REQUEST_ACTIONS: ReadonlySet<string> = new Set([
  "createpullrequest",
  "createapullrequest",
  "githubcreatepullrequest",
  "githubcreateapullrequest",
]);

/** 从授予员工的应用工具里找「创建 Pull Request」：server id 在名单里，动作名去掉符号后是 createpullrequest 一类。 */
export function findPullRequestTool(
  tools: readonly GrantedTool[],
): GrantedTool | undefined {
  return tools.find((tool) => {
    const [server = "", name = ""] = tool.ref.split("/");
    return (
      PULL_REQUEST_SERVERS.has(server) &&
      PULL_REQUEST_ACTIONS.has(name.toLowerCase().replace(/[^a-z]/g, ""))
    );
  });
}

/** 员工的工具权限里关掉的 git 工具不给：授予时和批准之后重放时都按它过滤。 */
export function offeredGitTools(
  tools: readonly GrantedTool[],
  disabled: (ref: string) => boolean,
): GrantedTool[] {
  return tools.filter((tool) => !disabled(tool.ref));
}

export function gitTools(options: GitToolsOptions): GrantedTool[] {
  const withComputer = async (
    run: (computer: GitComputer) => Promise<string>,
  ): Promise<string> => {
    const computer = await options.computer();
    return computer ? run(computer) : failure(NO_COMPUTER);
  };

  const branchTool: GrantedTool = {
    name: GIT_BRANCH_TOOL,
    ref: GIT_BRANCH_REF,
    description:
      "在工作区的 git 仓库里看分支、新建分支或切换分支。action：list（看分支，默认）、create（新建并切过去，name 是新分支名，start 可写从哪个分支或提交开始）、switch（切到已有分支）。分支名用字母数字和 . _ / -。有未提交的改动、切换会冲掉它们时 git 会拒绝，会把原话告诉你。",
    parameters: z.object({
      action: z.enum(["list", "create", "switch"]).optional(),
      name: z.string().optional().describe("create 和 switch 要写"),
      start: z
        .string()
        .optional()
        .describe("create 时从哪里开始，不写就是当前位置"),
      repo: repoField,
    }),
    async execute(raw, execution?: ToolExecution) {
      const input = z
        .object({
          action: z.enum(["list", "create", "switch"]).optional(),
          name: z.string().optional(),
          start: z.string().optional(),
          repo: z.string().optional(),
        })
        .safeParse(raw);
      if (!input.success)
        return failure("参数不对：action 只能是 list、create、switch。");
      const { action = "list", name, start } = input.data;
      const directory = repoOf(input.data.repo);
      if (!directory)
        return failure("repo 要写成相对工作区的目录，不能往上跳。");
      if (action !== "list" && (!name || !validRefName(name)))
        return failure(
          "name 要写分支名：字母数字开头，只含字母数字和 . _ / -，不超过 100 个字符。",
        );
      if (start !== undefined && !validRefName(start))
        return failure("start 要写分支名或提交的引用，不能含空格和特殊符号。");
      const change =
        action === "create"
          ? `g switch -c ${shellQuote(name as string)}${start ? ` ${shellQuote(start)}` : ""} 2>&1 || exit 1`
          : action === "switch"
            ? `g switch ${shellQuote(name as string)} 2>&1 || exit 1`
            : "";
      const script = inRepo(
        directory,
        [
          change,
          'echo "@@current=$(g branch --show-current)"',
          'echo "@@branches"',
          "g branch --list --format='%(refname:short)' | head -n 100",
        ]
          .filter(Boolean)
          .join("\n"),
      );
      return withComputer(async (computer) => {
        const result = await computer.run(launch(script), execution?.signal);
        if (result.exitCode !== 0)
          return failure(explain(result, directory), { action });
        const parts = sections(result.stdout);
        return JSON.stringify({
          ok: true,
          action,
          branch: parts.get("current")?.[0] ?? "",
          branches: (parts.get("branches") ?? []).filter(Boolean),
        });
      });
    },
  };

  const commitTool: GrantedTool = {
    name: GIT_COMMIT_TOOL,
    ref: GIT_COMMIT_REF,
    description: `把工作区里指定的文件提交到 git。paths 逐个写要提交的文件（相对仓库目录，不要写目录和通配符，最多 ${GIT_COMMIT_LIMITS.paths} 个；哪些文件有改动可以先用 git_diff_summary 看），message 写提交说明。只提交 paths 里的文件，别的已暂存的改动不受影响。提交前会检查这些文件和说明：里面有密钥、令牌、口令、带凭据的网址、私钥，或者文件本身就是 .env、私钥一类，就整个不提交并说明是哪一类，请先把它们拿掉。只提交工作区里的仓库。`,
    parameters: z.object({
      paths: z.array(z.string()).describe("要提交的文件，逐个写"),
      message: z.string().describe("提交说明"),
      repo: repoField,
    }),
    async execute(raw, execution?: ToolExecution) {
      const input = z
        .object({
          paths: z.array(z.string()).min(1),
          message: z.string().trim().min(1).max(2000),
          repo: z.string().optional(),
        })
        .safeParse(raw);
      if (!input.success)
        return failure(
          "参数不对：paths 至少写一个文件，message 写 1 到 2000 个字符的提交说明。",
        );
      const { message } = input.data;
      const paths = [...new Set(input.data.paths)];
      const directory = repoOf(input.data.repo);
      if (!directory)
        return failure("repo 要写成相对工作区的目录，不能往上跳。");
      if (paths.length > GIT_COMMIT_LIMITS.paths)
        return failure(
          `一次最多提交 ${GIT_COMMIT_LIMITS.paths} 个文件，请分批提交。`,
        );
      const badPath = paths.find((path) => !concretePath(path));
      if (badPath !== undefined)
        return failure(
          `路径「${badPath}」不能用：要写相对仓库目录的具体文件，不能往上跳，不能含通配符，也不能以 - 开头。`,
        );
      const secretName = paths.find(isSecretFileName);
      if (secretName !== undefined)
        return failure(
          `没有提交：「${secretName}」是放密钥的那类文件，不能提交。把它从 paths 里去掉（需要的话加进 .gitignore）。`,
          { refused: true },
        );
      const inMessage = secretKindsIn(message);
      if (inMessage.length > 0)
        return failure(
          `没有提交：提交说明里有${inMessage.join("、")}。把它拿掉再提交。`,
          { refused: true },
        );
      return withComputer(async (computer) => {
        /*
         * 先读一遍要提交的文件，算出它们作为 git 对象的编号，写进命令里。命令在 `git add` 之后核对每个文件的暂存
         * 内容编号和这里一样：一样，说明检查过的就是要提交的（无论过滤器、换行转换做过什么）；不一样就撤回暂存、
         * 不提交。这样检查看到的和提交的是同一份，而要过审批门的命令仍然只有一条。
         * 读不到（删除的文件）：命令里核对它确实不在暂存区里了。
         */
        const expected: { path: string; id: string }[] = [];
        for (const path of paths) {
          const file = await computer.read(
            directory === "." ? path : `${directory}/${path}`,
            execution?.signal,
          );
          if (!file) {
            expected.push({ path, id: "deleted" });
            continue;
          }
          if (file.truncated || file.bytes > GIT_COMMIT_LIMITS.fileBytes)
            return failure(
              `没有提交：「${path}」太大（${file.bytes} 字节），没法完整检查里面有没有密钥。请拆小，或者本人自己提交这个文件。`,
              { refused: true },
            );
          // 二进制文件看不了文字，没法检查，不提交。
          if (file.text.includes("\u0000"))
            return failure(
              `没有提交：「${path}」是二进制文件，没法检查里面有没有密钥。这个工具只提交文本文件，二进制文件请本人提交。`,
              { refused: true, path },
            );
          const kinds = secretKindsIn(file.text);
          if (kinds.length > 0)
            return failure(
              `没有提交：「${path}」里有${kinds.join("、")}。把它拿掉（改成从环境变量读取）再提交；这次什么都没有提交。`,
              { refused: true, path },
            );
          expected.push({ path, id: gitBlobId(file.text) });
        }
        const quoted = paths.map(shellQuote).join(" ");
        const checks = expected.map(
          ({ path, id }) =>
            `check ${shellQuote(path)} ${id} || { g reset -q -- ${quoted} >/dev/null 2>&1 || g rm --cached -q --ignore-unmatch -- ${quoted} >/dev/null 2>&1; printf '@@mismatch=%s\\n' ${shellQuote(path)}; exit ${EXIT.mismatch}; }`,
        );
        const script = inRepo(
          directory,
          [
            `for p in ${quoted}; do [ -d "$p" ] && exit ${EXIT.directory}; done`,
            // 没配置提交人的仓库，用一个固定的名字，免得提交因为「请告诉我你是谁」失败。
            'U="$(g config user.name || true)"; E="$(g config user.email || true)"',
            '[ -n "$U" ] || U=xiongbao; [ -n "$E" ] || E=employee@xiongbao.invalid',
            `g add -- ${quoted} 2>&1 || exit 1`,
            // 暂存区里这个文件的编号，和检查过的一样才算（deleted：已经不在暂存区里）。
            'check() { if [ "$2" = deleted ]; then g rev-parse -q --verify ":./$1" >/dev/null 2>&1 && return 1; return 0; fi; [ "$(g rev-parse -q --verify ":./$1" 2>/dev/null)" = "$2" ]; }',
            ...checks,
            `g -c user.name="$U" -c user.email="$E" commit -q -m ${shellQuote(message)} -- ${quoted} 2>&1 || exit 1`,
            // 核对和提交之间文件又变了：提交进去的不是检查过的。撤回这次提交（没有父提交就删掉 HEAD），不提交。
            'landed() { if [ "$2" = deleted ]; then g rev-parse -q --verify "HEAD:./$1" >/dev/null 2>&1 && return 1; return 0; fi; [ "$(g rev-parse -q --verify "HEAD:./$1" 2>/dev/null)" = "$2" ]; }',
            `undo() { if g rev-parse -q --verify HEAD~1 >/dev/null 2>&1; then g reset -q --soft HEAD~1 >/dev/null 2>&1; g reset -q -- ${quoted} >/dev/null 2>&1; else g update-ref -d HEAD >/dev/null 2>&1; g rm --cached -q -r --ignore-unmatch -- ${quoted} >/dev/null 2>&1; fi; }`,
            ...expected.map(
              ({ path, id }) =>
                `landed ${shellQuote(path)} ${id} || { undo; printf '@@mismatch=%s\\n' ${shellQuote(path)}; exit ${EXIT.mismatch}; }`,
            ),
            'echo "@@commit=$(g rev-parse HEAD)"',
            'echo "@@branch=$(g branch --show-current)"',
            'echo "@@stat"',
            "g show --no-ext-diff --no-textconv --stat --format= HEAD | tail -n 30",
          ].join("\n"),
        );
        const result = await computer.run(launch(script), execution?.signal);
        if (result.exitCode !== 0) return failure(explain(result, directory));
        const parts = sections(result.stdout);
        return JSON.stringify({
          ok: true,
          commit: parts.get("commit")?.[0] ?? "",
          branch: parts.get("branch")?.[0] ?? "",
          files: paths,
          stat: (parts.get("stat") ?? []).join("\n").trim(),
        });
      });
    },
  };

  const summaryTool: GrantedTool = {
    name: GIT_DIFF_SUMMARY_TOOL,
    ref: GIT_DIFF_SUMMARY_REF,
    description: `看仓库的改动摘要：改了哪些文件、每个文件增删多少行。不写 base 是工作区相对最近一次提交的全部改动（含已暂存的，另列未跟踪的新文件）；staged 为 true 只看已暂存的；写 base（如 main）是当前分支相对它的改动，用来写 PR 说明。include_diff 为 true 时再带一段截断后的 diff（最多 ${GIT_DIFF_LIMITS.most} 个字符，默认 ${GIT_DIFF_LIMITS.default}，max_diff_chars 可调）。只读。`,
    parameters: z.object({
      base: z.string().optional(),
      staged: z.boolean().optional(),
      include_diff: z.boolean().optional(),
      max_diff_chars: z.number().int().positive().optional(),
      repo: repoField,
    }),
    async execute(raw, execution?: ToolExecution) {
      const input = z
        .object({
          base: z.string().optional(),
          staged: z.boolean().optional(),
          include_diff: z.boolean().optional(),
          max_diff_chars: z.number().optional(),
          repo: z.string().optional(),
        })
        .safeParse(raw);
      if (!input.success) return failure("参数不对。");
      const { base, staged, include_diff: includeDiff } = input.data;
      const directory = repoOf(input.data.repo);
      if (!directory)
        return failure("repo 要写成相对工作区的目录，不能往上跳。");
      if (base !== undefined && !validRefName(base))
        return failure("base 要写分支名或提交的引用，不能含空格和特殊符号。");
      const limit = Math.min(
        Math.max(
          Math.round(input.data.max_diff_chars ?? GIT_DIFF_LIMITS.default),
          200,
        ),
        GIT_DIFF_LIMITS.most,
      );
      const mode = base ? "base" : staged ? "staged" : "worktree";
      const range =
        mode === "base"
          ? `${shellQuote(`${base}...HEAD`)}`
          : mode === "staged"
            ? "--cached"
            : '"$HEADREF"';
      const script = inRepo(
        directory,
        [
          `HEADREF="$(g rev-parse -q --verify HEAD || echo ${EMPTY_TREE})"`,
          'echo "@@branch=$(g branch --show-current)"',
          `NUM="$(g diff --no-ext-diff --no-textconv --numstat ${range})" || exit ${EXIT.diff}`,
          'echo "@@count=$(printf \'%s\\n\' "$NUM" | grep -c .)"',
          'echo "@@numstat"',
          "printf '%s\\n' \"$NUM\" | head -n 200",
          ...(mode === "worktree"
            ? [
                'echo "@@untracked"',
                "g ls-files --others --exclude-standard | head -n 100",
              ]
            : []),
          ...(includeDiff
            ? [
                'echo "@@diff"',
                `g diff --no-ext-diff --no-textconv --no-color ${range} | head -c ${limit}`,
              ]
            : []),
        ].join("\n"),
      );
      return withComputer(async (computer) => {
        const result = await computer.run(launch(script), execution?.signal);
        if (result.exitCode !== 0) return failure(explain(result, directory));
        const parts = sections(result.stdout);
        const files = (parts.get("numstat") ?? [])
          .map((line) => /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line))
          .filter((match): match is RegExpExecArray => match !== null)
          .map((match) => ({
            path: match[3] as string,
            added: match[1] === "-" ? null : Number(match[1]),
            deleted: match[2] === "-" ? null : Number(match[2]),
          }));
        const count = Number(parts.get("count")?.[0] ?? files.length);
        const diff = (parts.get("diff") ?? []).join("\n");
        return JSON.stringify({
          ok: true,
          mode,
          branch: parts.get("branch")?.[0] ?? "",
          files,
          totals: {
            files: count,
            added: files.reduce((sum, file) => sum + (file.added ?? 0), 0),
            deleted: files.reduce((sum, file) => sum + (file.deleted ?? 0), 0),
          },
          ...(count > files.length
            ? {
                note: `只列出了前 ${files.length} 个文件，增删行数按列出的算。`,
              }
            : {}),
          ...(mode === "worktree"
            ? { untracked: (parts.get("untracked") ?? []).filter(Boolean) }
            : {}),
          ...(includeDiff
            ? {
                diff,
                diffTruncated: Buffer.byteLength(diff, "utf8") >= limit,
              }
            : {}),
        });
      });
    },
  };

  const pullRequestTool: GrantedTool = {
    name: OPEN_PULL_REQUEST_TOOL,
    ref: OPEN_PULL_REQUEST_REF,
    description:
      "在 GitHub 上开一个 Pull Request，用你已接入的 GitHub 连接器。要求分支已经推送到远端（推送用 computer_run_command 执行 git push）。owner 和 repo 是仓库的所有者和名字，head 是你的分支，base 是要合入的分支，title 和 body 写标题和说明（可用 git_diff_summary 的 base 模式整理）。没有接入连接器时会说明，请本人接入；开 PR 是对外的写操作，会按审批规则先问本人。",
    parameters: z.object({
      owner: z.string(),
      repo: z.string(),
      title: z.string(),
      head: z.string(),
      base: z.string(),
      body: z.string().optional(),
      draft: z.boolean().optional(),
    }),
    async execute(raw, execution?: ToolExecution) {
      const input = z
        .object({
          owner: z.string().min(1),
          repo: z.string().min(1),
          title: z.string().trim().min(1),
          head: z.string().min(1),
          base: z.string().min(1),
          body: z.string().optional(),
          draft: z.boolean().optional(),
        })
        .safeParse(raw);
      if (!input.success)
        return failure("参数不对：owner、repo、title、head、base 都要写。");
      const connector = findPullRequestTool(await options.connectorTools());
      if (!connector) return failure(NOT_CONNECTED, { needsConnector: true });
      const kinds = secretKindsIn(
        `${input.data.title}\n${input.data.body ?? ""}`,
      );
      if (kinds.length > 0)
        return failure(
          `没有开 PR：标题或说明里有${kinds.join("、")}。把它拿掉再开。`,
          { refused: true },
        );
      // 原样交给连接器，参数一个不改：批准之后重放走的就是这一条路径。
      return connector.execute(raw, execution);
    },
  };

  return [branchTool, commitTool, summaryTool, pullRequestTool];
}
