/**
 * The tool every Bot plans its work with: `update_plan`, a checklist it writes before a job of
 * several steps and ticks off as it goes, one item at a time.
 *
 * HELD BY EVERY BOT, BY DEFAULT. Granted with the other tools a Bot needs to be itself, in a person's
 * run, a routine's and a subagent's alike, and left out like any of them when a `deny` rule names
 * `bot/update_plan` for that Bot (the per-employee tool permission).
 *
 * IT STORES NOTHING. Each call carries the whole list, so the plan is the latest call's arguments,
 * kept with the run like every other call and read back from there: by the chat, which pins it above
 * the conversation, and by the run harness, which sends a run back to work when it stops with items
 * still open (`shared/plan.ts`). The tool only checks the list and says it took it.
 *
 * A LIST IT CANNOT TAKE IS ANSWERED, NEVER THROWN. Too many items, an empty one, two in progress at
 * once: the model is told what to fix, in the person's language, and calls again.
 */
import { z } from "zod";
import {
  PLAN_LIMITS,
  PLAN_STATUSES,
  planProblem,
  planUpdated,
  readPlan,
  UPDATE_PLAN_TOOL,
} from "../../../shared/plan";
import type { GrantedTool } from "../plugins/tools";
import type { PlanApproval } from "./plan-approval";
import { planWithActionOn, withToolHint } from "./step-hints";

/** The spelling a rule switches it off by, as for every other tool. */
export const UPDATE_PLAN_REF = `bot/${UPDATE_PLAN_TOOL}`;

/*
 * What the model is shown. The limits are said, not enforced, here: a list the schema rejected would
 * be answered by the runtime in its own words, and the model is to be told in the person's.
 */
const parameters = z.object({
  items: z
    .array(
      z.object({
        text: z
          .string()
          .describe(`一项要做的事，一句话，不超过 ${PLAN_LIMITS.text} 字`),
        status: z
          .enum(PLAN_STATUSES)
          .describe("pending 未开始，in_progress 正在做，done 已完成"),
      }),
    )
    .describe(
      `完整的计划清单，1 到 ${PLAN_LIMITS.items} 项，按做的顺序排；同一时间最多 1 项 in_progress`,
    ),
});

/**
 * `approval` is given only for an employee under the plan-approval pilot (`plan-approval.ts`). Without
 * it the tool is exactly what it was. With it the tool also puts a long first plan to the owner, and
 * is not started alongside the next action: an action in the same step could run before the plan was
 * put, and the hold would come too late for it.
 */
export function updatePlanTools(options?: {
  approval?: PlanApproval;
}): GrantedTool[] {
  const approval = options?.approval;
  return [
    {
      name: UPDATE_PLAN_TOOL,
      ref: UPDATE_PLAN_REF,
      description: withToolHint(
        UPDATE_PLAN_TOOL,
        "列出或更新你这次工作的计划清单，每次都传完整清单。需要多步才能完成的任务，先用它列出计划；开始做哪一项就把它标成 in_progress，做完立刻标 done，全部 done 后再给出总结。一两步就能完成的简单问题不用列计划。",
      ),
      // 和同一步的别的调用一起开始（无头运行）；它什么都不存，不依赖也不影响同一步的其它调用。
      ...(planWithActionOn() && !approval ? { concurrent: true as const } : {}),
      parameters,
      async execute(args) {
        const problem = planProblem(args);
        if (problem !== undefined) return problem;
        const items = readPlan(args) ?? [];
        const updated = planUpdated(items);
        // A plan that cannot be put to the owner is still a plan: the failure is logged, never thrown.
        const note = await approval?.afterPlan(items).catch((error) => {
          console.error("plan approval failed", error);
          return undefined;
        });
        return note ? `${updated}。${note}` : updated;
      },
    },
  ];
}
