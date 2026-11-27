/**
 * How a Bot that can run commands closes the loop on its own work: change, run the project's own
 * checks, read the result, fix, and say what it ran (期五, spec 2026-11-19-codex-grade-employee).
 *
 * SAID ONLY TO A BOT THAT HOLDS THE SHELL. A Bot with no `computer_run_command` cannot run a test, and
 * telling it to would only teach it to claim it had. So these sections are their own, keyed on the
 * tools the run holds, and the shared sections every Bot reads stay as they were.
 */

/** The shell tool, by the name the model is offered. */
export const COMMAND_TOOL = "computer_run_command";

/** The coding tools, by the names the model is offered (`server/src/computer/headless-tools.ts`). */
export const EDIT_FILE_TOOL = "computer_edit_file";
export const GREP_TOOL = "computer_grep";
export const GLOB_TOOL = "computer_glob";

/** The verification loop, in the person's language: what to run, how many rounds, what to report. */
export const VERIFY_GUIDANCE = [
  "改了代码或数据之后，必须运行项目里现成的测试、构建或校验脚本（如 package.json 的 test、build、lint，pytest），读完输出再下结论。失败就修，修完再跑，最多 3 轮；仍然失败就停下，如实说明卡在哪一步、报什么错。",
  "交付或总结时附上验证记录：跑了哪些命令、各自的退出码、关键输出（如通过和失败的数量、报错的那一行）。",
  "找不到现成的测试时，自己写一个最小检查（一条命令或一小段脚本）验证改动生效，并说明是自己写的。没有真的跑过，就不要说「已验证」或「测试通过」。测试通过就交，不另写对照脚本，不逐个重读改过的文件。",
].join("\n\n");

/**
 * Said to a run that holds `computer_run_command`, and to no other: a Bot without the shell is not
 * told to run tests it cannot run.
 */
export function verifyGuidance(
  toolNames: readonly string[],
): string | undefined {
  return toolNames.includes(COMMAND_TOOL) ? VERIFY_GUIDANCE : undefined;
}

/** How to change a file: one passage per call, several unrelated edits issued in one step, never the whole file rewritten (期五). */
export const EDIT_GUIDANCE = `改已有的文件优先用 ${EDIT_FILE_TOOL}：先用 computer_read_file 读出要改的地方（长文件传 offset 和 limit 只读那一段），把要替换的原文一字不差地作为 old_string（带上足够的上下文，让它在文件里只出现一次），改后的内容写成 new_string。一次调用改一处；互不相关的几处修改（同一个文件或不同文件）放在同一步一起发出多个 computer_edit_file 调用，按顺序执行，不要一步只改一处。不要用 computer_write_file 整文件重写已有的文件，它只用来新建文件。`;

/** How to find code: by content and by name, not by paging through listings (期五). */
export const SEARCH_GUIDANCE = `找代码用 ${GREP_TOOL}（按内容搜正则表达式，可用 glob 限定文件类型）和 ${GLOB_TOOL}（按文件名模式找，如 src/**/*.ts），不要靠 computer_list_files 一层层翻目录，也不要用命令把整个文件打印出来。`;

/**
 * Said to a run that holds the coding tools, and to no other: the edit word to one that holds
 * `computer_edit_file`, the search word to one that holds `computer_grep` or `computer_glob`.
 */
export function codingToolsGuidance(
  toolNames: readonly string[],
): string | undefined {
  const parts = [
    ...(toolNames.includes(EDIT_FILE_TOOL) ? [EDIT_GUIDANCE] : []),
    ...(toolNames.includes(GREP_TOOL) || toolNames.includes(GLOB_TOOL)
      ? [SEARCH_GUIDANCE]
      : []),
  ];
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/** The tools whose presence changes what the prompt says: the shell and the coding tools. */
export const PROMPT_SECTION_TOOLS = [
  COMMAND_TOOL,
  EDIT_FILE_TOOL,
  GREP_TOOL,
  GLOB_TOOL,
] as const;

/** The file-writing tool, by the name the model is offered. */
export const WRITE_FILE_TOOL = "computer_write_file";

/** Files that are prose, not something to run: writing one leaves nothing to test or build. */
const PROSE_FILE = /\.(md|markdown|txt|rst|log|docx?|pdf|pptx?)$/i;

/** A command that is itself a check: what a run does after a change to see that it holds. */
export const VERIFYING_COMMAND =
  /\b(test|tests|check|build|verify|validate|lint|tsc|diff|assert|pytest|jest|vitest|make)\b|\bwc\s+-l\b|\bhead\s/i;

/** A command that changes a file in place, other than by redirecting into one. */
export const IN_PLACE_COMMAND =
  /\bsed\s+-i\b|\bpatch\b|\bgit\s+apply\b|\b(mv|cp)\s/;

const argumentsOf = (input: unknown): Record<string, unknown> => {
  if (typeof input === "object" && input !== null)
    return input as Record<string, unknown>;
  if (typeof input !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(input);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

/** The command a shell call ran, or an empty string. */
function commandOf(input: unknown): string {
  const command = argumentsOf(input).command;
  return typeof command === "string" ? command : "";
}

/**
 * The files a shell command writes, as far as its text shows it: the targets of `>` and `>>` and of
 * `tee`, and the file `sed -i`, `mv` and `cp` leave behind. `/dev/null` and `2>&1` are not files.
 */
function writtenByCommand(command: string): string[] {
  const targets = [
    ...command.matchAll(/(?:^|[^=<>&0-9-])>{1,2}\s*([^\s;&|<>()]+)/g),
    ...command.matchAll(/\btee\s+(?:-a\s+)?([^\s;&|<>()]+)/g),
  ]
    .map((found) => (found[1] ?? "").replace(/^["']|["']$/g, ""))
    .filter((path) => path && path !== "/dev/null");
  if (IN_PLACE_COMMAND.test(command) && targets.length === 0)
    targets.push(command.trim().split(/\s+/).at(-1) ?? "");
  return targets;
}

/**
 * A skill's own check command (`<dir>` and the like stand for whatever this run used) as a pattern:
 * whitespace is flexible, a `<placeholder>` matches any one word.
 */
function checkPattern(check: string): RegExp {
  const source = check
    .trim()
    .split(/(<[A-Za-z_\u4e00-\u9fff-]{1,20}>)/)
    .map((piece) =>
      /^<.+>$/.test(piece)
        ? "\\S+"
        : piece.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"),
    )
    .join("");
  return new RegExp(source, "g");
}

/**
 * Whether a shell command ran the skill's check command: the check is somewhere in it, whatever comes
 * before (`cd <dir> && `) or after (`| tail`), a `<placeholder>` standing for whatever this run used.
 * Generous on purpose: quotes and spacing do not matter either, so a check written `python3 "check.py"`
 * is run by `python3 check.py`.
 */
export function ranCheckCommand(command: string, check: string): boolean {
  if (!check.trim()) return false;
  if (checkPattern(check).test(command)) return true;
  const plain = (text: string) =>
    text.replace(/["'`]/g, "").replace(/\s+/g, " ").trim();
  return checkPattern(plain(check)).test(plain(command));
}

/** Where, in the command, the last of the skill's check commands ends; -1 when none is in it. */
function lastCheckEnd(command: string, checks: readonly RegExp[]): number {
  let end = -1;
  for (const pattern of checks)
    for (const found of command.matchAll(pattern))
      end = Math.max(end, (found.index ?? 0) + found[0].length);
  return end;
}

/** One call a model made, in the order it made them. */
export type MadeCall = { name: string; input: unknown };

/**
 * The files a turn changed and has not checked since: everything the turn wrote or edited after the
 * last command that looks like a check (`test`, `build`, `lint`, `tsc` …), or all of them when it
 * ran none. Empty when the turn changed nothing worth checking: only prose files, or only reading.
 *
 * Read from the turn's calls, so it is the same on every run of a turn the host carries on between
 * runs, however the turn was cut into them.
 */
export function unverifiedChanges(
  calls: readonly MadeCall[],
  /**
   * The check commands the skill this run follows brought with it. Running one counts as checking,
   * even when it is not one of the commands the pattern above knows (`awk`, `python3 check.py`), and
   * even in the same command as the script it checks, as long as it comes after the last write.
   */
  skillChecks: readonly string[] = [],
): string[] {
  const own = skillChecks.filter((check) => check.trim()).map(checkPattern);
  let changed: string[] = [];
  for (const call of calls) {
    if (call.name === WRITE_FILE_TOOL || call.name === EDIT_FILE_TOOL) {
      const path = argumentsOf(call.input).path;
      if (typeof path === "string" && !PROSE_FILE.test(path))
        changed.push(path);
      continue;
    }
    if (call.name !== COMMAND_TOOL) continue;
    const command = commandOf(call.input);
    const written = writtenByCommand(command).filter(
      (path) => !PROSE_FILE.test(path),
    );
    const checked = lastCheckEnd(command, own);
    if (written.length > 0) {
      changed.push(...written);
      // Written by this command, checked by the skill's own check later in it.
      const lastWrite = Math.max(
        ...written.map((path) => command.indexOf(path) + path.length),
      );
      if (checked > lastWrite) changed = [];
    } else if (checked >= 0 || VERIFYING_COMMAND.test(command)) changed = [];
  }
  return [...new Set(changed)];
}
