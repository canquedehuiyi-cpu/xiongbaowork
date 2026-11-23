/**
 * 用了技能快路径的一轮，交付前要先跑过技能自带的核对命令（第十八轮）。
 *
 * 评测里有员工照技能的快路径几步就交付，快路径算出来的值没核对，交上去的结果和预期不一致。技能的
 * `fastPathCheck`（复盘写技能时留的一条核对快路径输出的命令）就是为这一步存的：用到了带核对命令的技能、这一轮
 * 还没运行过它，`deliver_task` 第一次被挡回，告诉员工先跑它再交；每轮只挡一次，再交就放行，不让员工卡死。
 *
 * 「用到」：这一轮开头附上了快路径（对上的自写技能，清单后面的那一段，见 `plugins/picked-skill.ts` 的
 * `ownSkillsGuidance`），或员工用 `read_skill` 读了一条带核对命令的技能。「跑过」：这一轮里员工的
 * `computer_run_command` 的命令里含有核对命令（`cd <目录> && ` 之类的前缀、`<dir>` 换成实际目录、引号和空白不同都算，
 * 见 `shared/verify.ts` 的 `ranCheckCommand`）；有几条核对命令时，跑过其中任何一条就算。
 *
 * 只看这一轮的对话（最后一条用户消息之后），不另存状态：「已经挡回过」也是从历史里的 `deliver_task` 结果认出来的。
 * 部署开关 `XIONGBAO_FASTPATH_CHECK_GATE=off` 关掉，默认开。被挡回的交付不算已交付：卡片没动，交付即收尾
 * （`tasks/delivery-end.ts`）只认 `delivered: true`。
 */

import { READ_SKILL_TOOL } from "../../../shared/self-skills";
import { COMMAND_TOOL, ranCheckCommand } from "../../../shared/verify";

export const FASTPATH_CHECK_GATE_ENV = "XIONGBAO_FASTPATH_CHECK_GATE";

/** 开着吗：默认开，只有明确写 `off` 才关。 */
export function fastPathCheckGateOn(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[FASTPATH_CHECK_GATE_ENV]?.trim().toLowerCase() !== "off";
}

/** 挡回结果里的标记：历史里有它，就是这一轮已经挡回过一次。 */
export const FASTPATH_BOUNCE_KEY = "fastPathCheckBounce";

/** 技能正文里核对命令那一行的开头（`shared/self-skills.ts` 的 `FAST_PATH_CHECK_LABEL`）。 */
const CHECK_LABEL = "快路径校验命令：";

/** 一行行读出文字里的核对命令，一条一项。 */
function checksIn(text: string): string[] {
  const found: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(CHECK_LABEL)) continue;
    const check = trimmed.slice(CHECK_LABEL.length).trim();
    if (check && !found.includes(check)) found.push(check);
  }
  return found;
}

/*
 * 这一轮开头附上的快路径带的核对命令，按运行号记着（`copilot.ts` 建这一轮时写）。只留最近的一批，不无限增长。
 */
const attached = new Map<string, string[]>();
const MOST_RUNS_KEPT = 500;

/** 这一轮开头附上了快路径：记下它带的核对命令（可以是空，空就什么也不记）。 */
export function noteAttachedFastPath(
  runId: string | undefined,
  checks: readonly string[],
): void {
  if (!runId || checks.length === 0) return;
  attached.delete(runId);
  attached.set(runId, [...checks]);
  while (attached.size > MOST_RUNS_KEPT) {
    const oldest = attached.keys().next().value;
    if (oldest === undefined) break;
    attached.delete(oldest);
  }
}

/** The part of a conversation message the gate reads, whichever way the runtime shaped it. */
type Turn = {
  role?: string;
  content?: unknown;
  toolCallId?: string;
  toolCalls?: {
    id?: string;
    function?: { name?: string; arguments?: string };
  }[];
};

const textOf = (content: unknown): string =>
  typeof content === "string" ? content : "";

/** 这一轮的消息：最后一条用户消息之后的。 */
function thisTurn(messages: readonly Turn[]): Turn[] {
  let start = 0;
  messages.forEach((message, index) => {
    if (message.role === "user") start = index + 1;
  });
  return messages.slice(start);
}

/** 一次工具调用的参数里的 `command`，读不出来就是空串。 */
function commandOf(args: string | undefined): string {
  try {
    const parsed: unknown = JSON.parse(args || "{}");
    const command = (parsed as { command?: unknown } | null)?.command;
    return typeof command === "string" ? command : "";
  } catch {
    return "";
  }
}

/**
 * 员工现在调 `deliver_task`，要不要先挡回：用到了带核对命令的技能、这一轮还没运行过任何一条核对命令、
 * 也没有挡回过，就返回要先运行的核对命令；别的情况返回 undefined（放行）。
 */
export function uncheckedFastPath(input: {
  runId: string;
  messages: readonly Turn[];
  env?: Record<string, string | undefined>;
}): string[] | undefined {
  if (!fastPathCheckGateOn(input.env)) return undefined;
  const turn = thisTurn(input.messages);
  // 这一轮已经挡回过一次：不管跑没跑，放行。
  const bouncedBefore = turn.some(
    (message) =>
      message.role === "tool" &&
      textOf(message.content).includes(`"${FASTPATH_BOUNCE_KEY}":true`),
  );
  if (bouncedBefore) return undefined;
  const checks = [...(attached.get(input.runId) ?? [])];
  const readIds = new Set<string>();
  const commands: string[] = [];
  for (const message of turn) {
    if (message.role !== "assistant") continue;
    for (const call of message.toolCalls ?? []) {
      const name = call.function?.name;
      if (name === READ_SKILL_TOOL && call.id) readIds.add(call.id);
      if (name === COMMAND_TOOL)
        commands.push(commandOf(call.function?.arguments));
    }
  }
  for (const message of turn)
    if (
      message.role === "tool" &&
      message.toolCallId &&
      readIds.has(message.toolCallId)
    )
      for (const check of checksIn(textOf(message.content)))
        if (!checks.includes(check)) checks.push(check);
  if (checks.length === 0) return undefined;
  const ran = checks.some((check) =>
    commands.some((command) => ranCheckCommand(command, check)),
  );
  return ran ? undefined : checks;
}

/** 给员工看的挡回原因：先跑技能的核对命令，确认通过再交付。 */
export function fastPathBounceReason(checks: readonly string[]): string {
  const shown = checks.map((check) => `「${check}」`).join("或");
  return `这一轮用了技能的快路径，交付前要先跑过技能自带的核对命令 ${shown}（目录换成这次的）并确认通过：不一致就先修，再交付。`;
}
