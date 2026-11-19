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
  "改了代码或数据之后，必须运行项目里现成的测试、构建或校验脚本（例如 package.json 里的 test、build、lint，Makefile，pytest），读完输出再下结论。失败就修，修完再跑，最多 3 轮；3 轮之后仍然失败，停下来如实说明卡在哪一步、报的是什么错。",
  "交付或总结时附上验证记录：跑了哪些命令、各自的退出码、关键输出（例如通过和失败的数量、报错的那一行）。",
  "找不到现成的测试时，自己写一个最小检查（一条命令或一小段脚本）来验证改动确实生效，并说明这是你自己写的检查。没有真的跑过，就不要说「已验证」或「测试通过」。",
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

/** How to change a file: one passage at a time, never the whole file rewritten (期五). */
export const EDIT_GUIDANCE = `改已有的文件优先用 ${EDIT_FILE_TOOL}：先用 computer_read_file 读出要改的地方（长文件传 offset 和 limit 只读那一段），把要替换的原文一字不差地作为 old_string（带上足够的上下文，让它在文件里只出现一次），改后的内容写成 new_string，一次改一处。不要用 computer_write_file 整文件重写已有的文件，它只用来新建文件。`;

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
