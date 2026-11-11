import type { AuditInitiator, AuditInitiatorKind } from "../audit";
import type { Decides } from "./broker";

/**
 * 谁可以驾驶一次用到 Shared 应用团队账号的运行——规则本身，不碰数据库（上游 `shared-use.ts`，按 fork
 * 改写）。
 *
 * 每次调用都检查，而不是在配置变化时检查，所以这里没想到的开始方式会被拒绝而不是放行：事实来自运行
 * 本身，这里没有点名的发起者永远不会被读成一个人。
 *
 * 闸门是「先查这位员工对这个应用的共享使用批准，没有批准行就拒绝，管理员也不例外；有批准才按受众
 * （`admits`）判」。批准、申请与闸门本身在 `./shared-use-store.ts`（X3，迁移 0196）；没接上那个闸门的
 * store 照 X1 评审 C1 一律拒绝。
 */

export const SHARED_AUDIENCES = ["owner", "people", "team"] as const;
export type SharedAudience = (typeof SHARED_AUDIENCES)[number];
export type ApprovalMember = { kind: "user" | "group"; value: string };
export type SharedUseApproval = {
  audience: SharedAudience;
  outsideInput: boolean;
  members: ApprovalMember[];
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
  if (!initiator)
    return { kind: "refuse", why: "这次运行没有说明是什么开始的" };
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

export type BotFacts = {
  ownerUserId: string | null;
  visibility: "public" | "private";
  publication: {
    audience: "team" | "people";
    members: ApprovalMember[];
  } | null;
  assignments: readonly string[];
  sources: readonly string[];
};

/**
 * 一位员工现在开放给谁：管理员要批准什么，这位员工用团队账号的每一次调用才能通过。公开的、发布给整个
 * 团队的、指派给 `*` 的，是整个团队；发布名单与指派的群组合起来是 `people`；其余只有主人。任何一个职责
 * 来源不是 `manual` / `schedule`，就是外部输入。
 */
export function exposureOf(bot: BotFacts): SharedUseApproval {
  const outsideInput = bot.sources.some(
    (source) => !OWNER_STEERED_SOURCES.has(source),
  );
  if (
    bot.visibility === "public" ||
    bot.publication?.audience === "team" ||
    bot.assignments.includes("*")
  ) {
    return { audience: "team", outsideInput, members: [] };
  }
  const named: ApprovalMember[] = [
    ...(bot.publication?.members ?? []),
    ...bot.assignments.map((group) => ({
      kind: "group" as const,
      value: group,
    })),
  ];
  // 一个群组可以既被发布、又被指派，在提议里仍是一个成员。按 (kind, value) 精确比较，所以同名的人和
  // 群组仍是两个。
  const members = named.filter(
    (member, index) =>
      named.findIndex(
        (other) => other.kind === member.kind && other.value === member.value,
      ) === index,
  );
  if (members.length > 0) return { audience: "people", outsideInput, members };
  return { audience: "owner", outsideInput, members: [] };
}

const RANK: Record<SharedAudience, number> = { owner: 0, people: 1, team: 2 };

/** 已批准的是否覆盖需要的：受众至少一样宽、名单包含每一个需要的成员、需要外部输入时批准了外部输入。 */
export function covers(
  approved: SharedUseApproval | null,
  needed: SharedUseApproval,
): boolean {
  if (!approved) return false;
  if (needed.outsideInput && !approved.outsideInput) return false;
  if (RANK[approved.audience] > RANK[needed.audience]) return true;
  if (RANK[approved.audience] < RANK[needed.audience]) return false;
  if (needed.audience !== "people") return true;
  return needed.members.every((member) =>
    approved.members.some(
      (held) => held.kind === member.kind && held.value === member.value,
    ),
  );
}

/** 浏览器送来的一条批准，读得出来才算；其余为 null。名单只在 `people` 时保留。 */
export function asSharedUseApproval(value: unknown): SharedUseApproval | null {
  if (!value || typeof value !== "object") return null;
  const { audience, outsideInput, members } = value as Record<string, unknown>;
  if (
    !SHARED_AUDIENCES.includes(audience as SharedAudience) ||
    typeof outsideInput !== "boolean"
  )
    return null;
  const listed = members === undefined ? [] : members;
  if (!Array.isArray(listed)) return null;
  const read: ApprovalMember[] = [];
  for (const member of listed) {
    const { kind, value: named } = (member ?? {}) as Record<string, unknown>;
    if (
      (kind !== "user" && kind !== "group") ||
      typeof named !== "string" ||
      !named.trim()
    )
      return null;
    read.push({ kind, value: named.trim() });
  }
  return {
    audience: audience as SharedAudience,
    outsideInput,
    members: audience === "people" ? read : [],
  };
}
