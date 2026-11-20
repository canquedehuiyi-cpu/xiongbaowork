/**
 * 交付即收尾（token 第四轮）：看板卡的员工 `deliver_task` 被接受之后，这一轮直接结束。
 *
 * 交付的内容已经在工具参数里（交付物、自查），员工在交付之后多说的那一句「做完了」不带任何新东西，却要把整段
 * 历史再发给模型一遍：一张卡固定多出一次模型调用。所以运行器认得「交付被接受」的结果，下一步不再问模型
 * （`toolkit/src/copilotkit/last-step.ts` 的 `endsTurnAfter`）。
 *
 * 只在没有提醒要发的时候才收尾：计划里还有没做的项、改完没有校验，这两样提醒原来在交付之后的那一步里发，现在
 * 仍然发，只是只在真有提醒时才多走一步。被挡回的交付、交付之后又去做别的事，一步都不省。
 *
 * 部署开关 `XIONGBAO_DELIVER_ENDS_TURN=off` 回到原样：交付之后模型再说一句收尾的话。默认开。
 *
 * A LEAF MODULE: it imports nothing, so the model runtime's wiring (`copilot.ts`) can read it without
 * pulling in the delivery tools and what they reach.
 */

export const DELIVER_ENDS_TURN_ENV = "XIONGBAO_DELIVER_ENDS_TURN";

/** 开着吗：默认开，只有明确写 `off` 才关。 */
export function deliverEndsTurnOn(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[DELIVER_ENDS_TURN_ENV]?.trim().toLowerCase() !== "off";
}

/** The tool a coworker hands a card in with; `delivery-tools.ts` names it the same (checked by a test). */
const DELIVER_TOOL = "deliver_task";

/**
 * 这个工具结果是不是「交付被接受」：`deliver_task` 返回了 `delivered: true`。被挡回（`bounced`）、被拒
 * （以拒绝标记开头的文字）、读不懂的文字，都不是。
 */
export function acceptedDelivery(toolName: string, result: string): boolean {
  if (toolName !== DELIVER_TOOL) return false;
  try {
    const parsed: unknown = JSON.parse(result);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { delivered?: unknown }).delivered === true
    );
  } catch {
    return false;
  }
}
