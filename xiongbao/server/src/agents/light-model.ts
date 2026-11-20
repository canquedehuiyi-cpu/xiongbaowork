/**
 * 轻量轮用员工的轻量模型（期 1·1.5）。
 *
 * 轻量轮是没人盯着、多数时候看一眼就收的运行：主动检查（巡检）和员工给自己留的跟进。它们每天按次数
 * 上限跑好几次，用不着员工平时那个贵的模型。员工设置里写了轻量模型（`shared/light-model.ts`）就用它；
 * 没写、或者写的那个模型现在已经不在本租户可用的模型里（管理员收回、换了提供方），就不动，用平时的模型。
 * 例行任务（routine）和目标（responsibility）是真干活的，不算轻量轮。
 */
import type { AuditInitiator } from "../audit";
import { isProactiveInitiator } from "../proactive/initiator";

/** 跟进（`wake-up.ts`）开的那一轮，发起者 id 的前缀。 */
const FOLLOW_UP_PREFIX = "follow-up:";
/** 心跳（`heartbeat/runner.ts`）醒来的那一轮，发起者 id 的前缀。 */
const HEARTBEAT_PREFIX = "heartbeat:";

/** 这一轮是不是轻量轮：巡检或跟进；转手的话看最初是什么发起的。 */
export function isLightTurn(
  initiator: AuditInitiator | undefined | null,
): boolean {
  if (!initiator) return false;
  if (isProactiveInitiator(initiator)) return true;
  if (initiator.kind === "handoff") return isLightTurn(initiator.origin);
  return (
    initiator.kind === "routine" &&
    "id" in initiator &&
    typeof initiator.id === "string" &&
    (initiator.id.startsWith(FOLLOW_UP_PREFIX) ||
      initiator.id.startsWith(HEARTBEAT_PREFIX))
  );
}

/**
 * 这一轮要用的轻量模型，没有就答 undefined（用平时的模型）。不是轻量轮不读设置；读失败只是没了这个设置，
 * 不影响这一轮。
 */
export async function lightModelFor(
  deps: {
    read: (agentId: string) => Promise<string | undefined>;
    /** 本租户可用的模型名：对话里模型选择器那份目录。 */
    allowed: () => Promise<readonly string[]>;
  },
  agentId: string | undefined,
  initiator: AuditInitiator | undefined | null,
): Promise<string | undefined> {
  if (!agentId || !isLightTurn(initiator)) return undefined;
  try {
    const saved = await deps.read(agentId);
    if (!saved) return undefined;
    return (await deps.allowed()).includes(saved) ? saved : undefined;
  } catch {
    return undefined;
  }
}
