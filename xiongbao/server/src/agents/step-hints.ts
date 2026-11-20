/**
 * 少调几次模型（token 第四轮）：几件「记账」和零碎的事不再各占一步。
 *
 * 每一步都要把整段历史再发给模型一遍，所以模型调用次数就是输入 token 和墙钟的乘数。一张看板卡里，接活回执、
 * 更新计划、一条接一条的命令，原来各占一步；这里请员工把它们和同一步的别的动作一起发出：
 *
 *  - `XIONGBAO_ACCEPT_WITH_READS`：接活回执（`accept_task`）和第一批读取放在同一步发；
 *  - `XIONGBAO_PLAN_WITH_ACTION`：更新计划（`update_plan`）和下一步动作放在同一步发；
 *  - `XIONGBAO_MERGE_COMMANDS`：几条前后依赖、不需要看中间输出的命令，用 `&&` 合成一条（`slim-guidance.ts`）。
 *
 * 前两样还有一处并行标记：这两个工具在无头运行里可以和同一步的别的调用一起开始（`GrantedTool.concurrent`），
 * 同一步发出时不排在读取、命令后面。接活回执不改成「第一次干活就自动接」：验收标准和预计时间是员工自己写的，
 * 「必需：…」项的核对和逾期都靠它们，自动接下就会丢掉这些。
 *
 * 三个开关默认开，写 `off` 关；关着就是原来的话、原来没有的并行标记。三个互相独立。
 *
 * A LEAF MODULE: it imports nothing, so the prompt, the delivery tools and the plan tool all read it.
 */

export const ACCEPT_WITH_READS_ENV = "XIONGBAO_ACCEPT_WITH_READS";
export const PLAN_WITH_ACTION_ENV = "XIONGBAO_PLAN_WITH_ACTION";
export const MERGE_COMMANDS_ENV = "XIONGBAO_MERGE_COMMANDS";

type Env = Record<string, string | undefined>;

const on = (env: Env, key: string) => env[key]?.trim().toLowerCase() !== "off";

export function acceptWithReadsOn(env: Env = process.env): boolean {
  return on(env, ACCEPT_WITH_READS_ENV);
}

export function planWithActionOn(env: Env = process.env): boolean {
  return on(env, PLAN_WITH_ACTION_ENV);
}

export function mergeCommandsOn(env: Env = process.env): boolean {
  return on(env, MERGE_COMMANDS_ENV);
}

/** 接下活之后第一件事常常是读：回执不单独占一步。 */
export const ACCEPT_HINT =
  "接活回执和第一批读取、命令放在同一步一起发，不要单独占一步。";
/** 计划和动作：勾掉一项、开始下一项，和下一步要做的事一起发。 */
export const PLAN_HINT = "更新计划和下一步动作放在同一步发，不要单独占一步。";

/** 这个工具的描述后面要补的一句，没有（或开关关着）就是 undefined。 */
export function toolHint(
  toolName: string | undefined,
  env: Env = process.env,
): string | undefined {
  if (toolName === "accept_task" && acceptWithReadsOn(env)) return ACCEPT_HINT;
  if (toolName === "update_plan" && planWithActionOn(env)) return PLAN_HINT;
  return undefined;
}

/** 工具的描述，加上它那一句（有的话）。 */
export function withToolHint(
  toolName: string | undefined,
  description: string,
  env: Env = process.env,
): string {
  const hint = toolHint(toolName, env);
  return hint ? `${description} ${hint}` : description;
}
