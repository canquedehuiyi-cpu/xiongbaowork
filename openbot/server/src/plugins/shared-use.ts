import type { AuditInitiator, AuditInitiatorKind } from "../audit";
import type { Decides } from "./broker";

/**
 * 谁可以驾驶一次用到 Shared 应用团队账号的运行——规则本身，不碰数据库（上游 `shared-use.ts`，按 fork
 * 改写）。
 *
 * 每次调用都检查，而不是在配置变化时检查，所以这里没想到的开始方式会被拒绝而不是放行：事实来自运行
 * 本身，这里没有点名的发起者永远不会被读成一个人。
 *
 * X1 只带来规则与最严的那一档受众（`owner`：只有员工的主人和管理员）。上游的「共享使用批准」
 * （`shared_use_approvals`，按员工放宽到指定的人、群组或全队）与它的申请流程在 X3 并入；在那之前，
 * 每个员工对每个 Shared 应用都按 {@link STRICTEST_APPROVAL} 判。
 */

export const SHARED_AUDIENCES = ["owner", "people", "team"] as const;
export type SharedAudience = (typeof SHARED_AUDIENCES)[number];
export type ApprovalMember = { kind: "user" | "group"; value: string };
export type SharedUseApproval = {
  audience: SharedAudience;
  outsideInput: boolean;
  members: ApprovalMember[];
};

/** X3 之前每个员工对 Shared 应用的批准：只有主人和管理员，不接受外部输入驱动。 */
export const STRICTEST_APPROVAL: SharedUseApproval = {
  audience: "owner",
  outsideInput: false,
  members: [],
};

/** 由人写提示词的两种来源。其余每一种来源（包括以后加的）都是外部输入。 */
export const OWNER_STEERED_SOURCES: ReadonlySet<string> = new Set([
  "manual",
  "schedule",
]);

export type Steering =
  | { kind: "refuse"; why: string }
  | { kind: "actor"; outside: boolean };

export async function steeringOf(
  initiator: AuditInitiator | undefined,
  sourcesOf: (responsibilityId: string) => Promise<readonly string[]>,
): Promise<Steering> {
  /*
   * 没有发起者不是一个人。每条运行员工的路径都说明了是什么开始了这次运行，所以没带发起者的调用是一条
   * 忘了说的路径，共享账号不能猜是谁在驾驶。拒绝，而不是读成提问者，这样以后加的后台调用方不会因为遗漏
   * 而拿到团队账号。
   */
  if (!initiator) return { kind: "refuse", why: "这次运行没有说明是什么开始的" };
  type _SteeringDecides = Decides<
    AuditInitiatorKind,
    {
      person: "the actor, who signed in and asked";
      routine: "the owner, who wrote the routine's prompt";
      memory: "the owner, who chose the sync's fixed arguments";
      responsibility: "the owner, and outside input when any source is not manual or schedule";
      handoff: "whatever started the first run, read from origin; refused without one";
      deployment: "refused — no person is behind it";
    }
  >;
  switch (initiator.kind) {
    case "person":
    case "routine":
    case "memory":
      return { kind: "actor", outside: false };
    case "responsibility": {
      const sources = await sourcesOf(initiator.id);
      return {
        kind: "actor",
        outside: sources.some((source) => !OWNER_STEERED_SOURCES.has(source)),
      };
    }
    case "handoff":
      if (!initiator.origin || initiator.origin.kind === "handoff") {
        return { kind: "refuse", why: "一次没有说明起点的转交" };
      }
      return steeringOf(initiator.origin, sourcesOf);
    case "deployment":
      return { kind: "refuse", why: "一次背后没有人的运行" };
    default:
      return { kind: "refuse", why: "一种这个部署不认识的开始方式" };
  }
}

export type ActorFacts = {
  actorId: string;
  isAdmin: boolean;
  groups: readonly string[];
};

export function admits(
  approval: SharedUseApproval,
  ownerUserId: string | null,
  actor: ActorFacts,
  steering: { outside: boolean },
): boolean {
  if (steering.outside && !approval.outsideInput) return false;
  if (actor.isAdmin || (ownerUserId !== null && actor.actorId === ownerUserId))
    return true;
  type _AudienceDecides = Decides<
    SharedAudience,
    {
      owner: "nobody but the owner and administrators";
      people: "people listed by id, and members of groups listed by name, as they were approved";
      team: "any signed-in person";
    }
  >;
  if (approval.audience === "team") return true;
  if (approval.audience === "owner") return false;
  return approval.members.some(
    (member) =>
      (member.kind === "user" && member.value === actor.actorId) ||
      (member.kind === "group" && actor.groups.includes(member.value)),
  );
}
