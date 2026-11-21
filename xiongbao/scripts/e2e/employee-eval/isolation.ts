/**
 * 评测里员工的电脑与仓库隔离：员工的命令读不到评测仓库（出题、判分源码）和工作区以外的评测文件
 * （`done-runs` 归档等）。
 *
 * 做法：CI 里（GitHub Actions ubuntu runner，免密 sudo）以专用系统用户（`EVAL_EMPLOYEE_USER`，如 `xbeval`）
 * 起 `agent-computer`，它的文件工具和员工的命令都以这个用户运行；仓库检出目录在 runner 的 home 下，该用户进不去
 * （工作流里 `chmod o-rwx /home/runner`），`agent-computer` 的运行副本放在 `EVAL_COMPUTER_DIR`（工作流拷到 /opt）。
 * 没设用户、不是 Linux、或 sudo 不可用时照旧运行，日志打「员工电脑未与仓库隔离」，不让评测失败。
 *
 * 这里只放纯函数和很薄的系统调用，`run-xiongbao.ts` 负责接线。不改产品行为。
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

/** 隔离配置：员工命令用的系统用户，和该用户能读到的 `agent-computer` 运行副本目录。 */
export type Isolation = { user: string; computerDir: string };

/** Linux 用户名的常规写法；拒绝带空格、引号、斜杠的值，免得拼进命令。 */
const USER_NAME = /^[a-z_][a-z0-9_-]{0,31}$/;

/** 从环境变量读隔离配置；没设用户、用户名不合法、不是 Linux、没有副本目录时是 `undefined`（不隔离）。 */
export function isolationFrom(
  env: Record<string, string | undefined>,
  platform: string,
): Isolation | undefined {
  const user = env.EVAL_EMPLOYEE_USER?.trim();
  const computerDir = env.EVAL_COMPUTER_DIR?.trim();
  if (!user || !computerDir) return undefined;
  if (platform !== "linux" || !USER_NAME.test(user)) return undefined;
  return { user, computerDir };
}

/** 本机能不能免密 sudo 成这个用户。 */
export function canSudoAs(isolation: Isolation): boolean {
  if (!existsSync(isolation.computerDir)) return false;
  const probe = spawnSync("sudo", ["-n", "-u", isolation.user, "true"], {
    stdio: "ignore",
  });
  return probe.status === 0;
}

/** 起 `agent-computer` 的命令、环境和工作目录。 */
export type ComputerLaunch = {
  argv: string[];
  env: Record<string, string>;
  cwd: string;
};

/**
 * 起 `agent-computer` 的方式。不隔离：本机 `bun src/index.ts`，和以前一样。隔离：`sudo -u <用户>` 起；
 * 令牌走 `--preserve-env`（不进命令行，别的用户在 /proc 里看不到），其余变量写在 `env` 后面；`umask 000`
 * 让它建的文件对 runner 里的评测进程也可读写（拷产物、归档、清理要用）。
 */
export function computerLaunch(
  isolation: Isolation | undefined,
  vars: Record<string, string>,
  defaultCwd: string,
): ComputerLaunch {
  if (!isolation)
    return { argv: ["bun", "src/index.ts"], env: vars, cwd: defaultCwd };
  const { COMPUTER_TOKEN, HOME: _home, ...plain } = vars;
  return {
    argv: [
      "sudo",
      "-n",
      "-H",
      "-u",
      isolation.user,
      "--preserve-env=COMPUTER_TOKEN",
      "env",
      ...Object.entries(plain).map(([name, value]) => `${name}=${value}`),
      "sh",
      "-c",
      "umask 000; exec bun src/index.ts",
    ],
    env: { PATH: vars.PATH ?? "", COMPUTER_TOKEN: COMPUTER_TOKEN ?? "" },
    cwd: isolation.computerDir,
  };
}

/** 单引号包起来，里面的单引号转义，拼进 shell 命令用。 */
export function shellQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/** 自检里员工要读的、不该读到的路径：评测仓库里的出题与判分源码，和工作区以外的评测目录。 */
export type ProbePaths = {
  /** 评测仓库里的文件（如 `gen-pitfall.ts`，在 `$GITHUB_WORKSPACE` 下和本脚本所在检出里各一份）。 */
  repoFiles: string[];
  /** 评测的临时目录和它里面的归档目录。 */
  scratchPaths: string[];
  /** 员工应当能读写的工作区。 */
  workspace: string;
  /** 题目需要的工具。 */
  tools?: string[];
};

const REPO_READABLE = "XB_REPO_READABLE";
const SCRATCH_READABLE = "XB_SCRATCH_READABLE";
const WORKSPACE_WRITABLE = "XB_WORKSPACE_WRITABLE";
const TOOL_MISSING = "XB_TOOL_MISSING";

/**
 * 以员工身份跑的自检命令。路径由评测进程展开成绝对路径写进去：员工的命令环境里没有 `$GITHUB_WORKSPACE`，
 * 写成变量会变成读不到而误判为隔离成功。输出几行标记，用 {@link parseProbe} 读。
 */
export function probeCommand(paths: ProbePaths): string {
  const tools = paths.tools ?? ["bun", "python3", "node"];
  const anyReadable = (list: string[]) =>
    list.map((path) => `test -r ${shellQuote(path)}`).join(" || ");
  return [
    `if ${anyReadable(paths.repoFiles)}; then echo ${REPO_READABLE}; fi`,
    `if ${anyReadable(paths.scratchPaths)}; then echo ${SCRATCH_READABLE}; fi`,
    `if test -w ${shellQuote(paths.workspace)}; then echo ${WORKSPACE_WRITABLE}; fi`,
    `for tool in ${tools.map(shellQuote).join(" ")}; do command -v "$tool" >/dev/null 2>&1 || echo ${TOOL_MISSING}:$tool; done`,
  ].join("\n");
}

/** 自检的结果。 */
export type Probe = {
  /** 读得到评测仓库里的文件（没隔离）。 */
  repoReadable: boolean;
  /** 读得到评测的临时目录或归档目录。 */
  scratchReadable: boolean;
  /** 工作区能写（不能写说明配置有误）。 */
  workspaceWritable: boolean;
  /** 找不到的工具。 */
  missingTools: string[];
};

/** 读自检命令的标准输出。 */
export function parseProbe(stdout: string): Probe {
  const lines = stdout.split("\n").map((line) => line.trim());
  return {
    repoReadable: lines.includes(REPO_READABLE),
    scratchReadable: lines.includes(SCRATCH_READABLE),
    workspaceWritable: lines.includes(WORKSPACE_WRITABLE),
    missingTools: lines
      .filter((line) => line.startsWith(`${TOOL_MISSING}:`))
      .map((line) => line.slice(TOOL_MISSING.length + 1)),
  };
}

/** 自检结论写进日志和报告的几行话；第一行是总结论，后面是需要注意的。 */
export function probeNotes(
  isolation: Isolation | undefined,
  probe: Probe,
): string[] {
  const notes: string[] = [];
  if (probe.repoReadable) {
    notes.push(
      isolation
        ? "员工电脑未隔离：自检里员工的命令读得到评测仓库（隔离配置没有生效）"
        : "员工电脑未与仓库隔离：员工的命令读得到评测仓库（本机运行，或没设 EVAL_EMPLOYEE_USER / sudo 不可用）",
    );
  } else {
    notes.push("员工的命令读不到评测仓库（自检通过）");
  }
  if (isolation && probe.scratchReadable)
    notes.push("员工的命令读得到评测的临时目录（工作区以外的归档等没有挡住）");
  if (isolation && !probe.workspaceWritable)
    notes.push(
      "员工的命令写不了工作区：隔离的用户和工作区权限不对，题目会做不成",
    );
  if (probe.missingTools.length > 0)
    notes.push(
      `员工的命令环境里找不到 ${probe.missingTools.join("、")}：题目需要的工具缺了`,
    );
  return notes;
}

/** 放开一个目录（含里面员工建的文件）给评测进程读写；只在隔离时要用。要跑的命令，不是结果。 */
export function openUpArgv(dir: string): string[] {
  return ["sudo", "-n", "chmod", "-R", "a+rwX", dir];
}

/** 跑 {@link openUpArgv}；失败不抛（拷产物时读不到会自己报）。 */
export function openUp(dir: string): void {
  const [command = "sudo", ...args] = openUpArgv(dir);
  spawnSync(command, args, { stdio: "ignore" });
}
