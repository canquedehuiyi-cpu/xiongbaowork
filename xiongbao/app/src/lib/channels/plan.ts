import type { Message } from "@ag-ui/core";
import {
  type PlanItem,
  readPlan,
  UPDATE_PLAN_TOOL,
} from "../../../../shared/plan";

/*
 * 置顶的计划清单（期二）：员工用 `update_plan` 写下的清单，每次调用都带完整清单，所以这段对话的计划就是最后一次
 * 调用的参数（`shared/plan.ts`）。参数随消息保存，刷新、回放后都在；员工在跑时调用的参数随流式事件进到消息里，
 * 新的一份一到这里就换上。
 */

export type { PlanItem };
export { readPlan };

/**
 * 这段对话里最后一份像样的计划；没有为 null。参数还没传完、或不是一份计划的调用跳过，留着上一份：流式里不清空、
 * 不闪。
 */
export function latestPlan(
  messages: readonly Readonly<Message>[],
): PlanItem[] | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const calls = message.toolCalls ?? [];
    for (let call = calls.length - 1; call >= 0; call -= 1) {
      const found = calls[call];
      if (found?.function.name !== UPDATE_PLAN_TOOL) continue;
      const items = readPlan(found.function.arguments);
      if (items) return items;
    }
  }
  return null;
}
