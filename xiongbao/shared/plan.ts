/**
 * A Bot's plan for one piece of work: the checklist it writes with `update_plan`, then works through
 * one item at a time, ticking each off.
 *
 * ONE DECLARATION, READ FROM THREE SIDES. The server runs the tool and checks the list
 * (`server/src/agents/update-plan.ts`); the run harness holds a run to its own plan, sending it back
 * when it stops with items still open (`last-step.ts` in the toolkit, through `run-notices.ts`); the
 * chat draws the list pinned above the conversation.
 *
 * THE PLAN IS THE CALL. Each call carries the whole list, so the plan a conversation holds is the
 * arguments of its latest `update_plan` call. Nothing else stores it: a tool call's arguments are
 * kept with the run's events and in the thread's messages, and come back on a reload, so the chat
 * reads the last call in the thread and the harness reads the last call in the run's prompt.
 */

/** What the model is offered. One name, so a transcript can find every plan by searching for it. */
export const UPDATE_PLAN_TOOL = "update_plan";

/** Where one item stands. At most one is `in_progress` at a time. */
export const PLAN_STATUSES = ["pending", "in_progress", "done"] as const;

export type PlanStatus = (typeof PLAN_STATUSES)[number];

/** One item of a plan, as the model writes it and the chat draws it. */
export type PlanItem = { text: string; status: PlanStatus };

/** How many items a plan holds, and how long one item may be, in characters. */
export const PLAN_LIMITS = { items: 20, text: 200 } as const;

function isStatus(value: unknown): value is PlanStatus {
  return (
    typeof value === "string" &&
    (PLAN_STATUSES as readonly string[]).includes(value)
  );
}

/** A call's arguments, as an object: a stored call may carry them as JSON text. */
function argumentsOf(input: unknown): unknown {
  if (typeof input !== "string") return input;
  try {
    return JSON.parse(input);
  } catch {
    return undefined;
  }
}

/**
 * What is wrong with a call's arguments as a plan, said to the model in the person's language, or
 * undefined when it is a plan. The model reads this as the tool's answer and calls again.
 */
export function planProblem(input: unknown): string | undefined {
  const args = argumentsOf(input);
  const items =
    typeof args === "object" && args !== null
      ? (args as { items?: unknown }).items
      : undefined;
  if (!Array.isArray(items))
    return "计划没有更新：请传 items，一个由 { text, status } 组成的数组，每次传完整清单。";
  if (items.length === 0) return "计划没有更新：清单是空的，至少要有 1 项。";
  if (items.length > PLAN_LIMITS.items)
    return `计划没有更新：清单最多 ${PLAN_LIMITS.items} 项，这次有 ${items.length} 项。请合并相近的步骤后再传。`;
  for (const [index, item] of items.entries()) {
    const text =
      typeof item === "object" && item !== null
        ? (item as { text?: unknown }).text
        : undefined;
    const status =
      typeof item === "object" && item !== null
        ? (item as { status?: unknown }).status
        : undefined;
    if (typeof text !== "string" || text.trim() === "")
      return `计划没有更新：第 ${index + 1} 项的 text 是空的，每一项都要写清做什么。`;
    if ([...text.trim()].length > PLAN_LIMITS.text)
      return `计划没有更新：第 ${index + 1} 项超过 ${PLAN_LIMITS.text} 字，请写短一些。`;
    if (!isStatus(status))
      return `计划没有更新：第 ${index + 1} 项的 status 只能是 pending、in_progress 或 done。`;
  }
  const working = items.filter(
    (item) => (item as { status: PlanStatus }).status === "in_progress",
  ).length;
  if (working > 1)
    return `计划没有更新：同一时间最多 1 项 in_progress，这次有 ${working} 项。一次只做一项，其余标成 pending。`;
  return undefined;
}

/** A call's arguments as a plan, or undefined when they are not one ({@link planProblem}). */
export function readPlan(input: unknown): PlanItem[] | undefined {
  if (planProblem(input) !== undefined) return undefined;
  const { items } = argumentsOf(input) as { items: PlanItem[] };
  return items.map((item) => ({ text: item.text.trim(), status: item.status }));
}

/** The tool's answer to a plan it took: short, because the list itself is already in the call. */
export function planUpdated(items: readonly PlanItem[]): string {
  const done = items.filter((item) => item.status === "done").length;
  return `已更新计划：${items.length} 项，完成 ${done} 项`;
}
