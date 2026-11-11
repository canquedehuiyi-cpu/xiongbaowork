import { eq } from "drizzle-orm";
import { enterpriseControls } from "../admin/controls";
import { ownerTenantOfBot } from "../agents/bot-owner";
import type { Database } from "../db/client";
import { revokedAccess, users } from "../db/schema/core";
import type { AppInspection } from "./app-access-store";
import type { SharedAudience, SharedUseStore } from "./shared-use-store";
import type { PluginStore } from "./store";

/**
 * 员工的主人把自己的应用给自己的员工，不需要管理员（上游 `owner-grants.ts`，按 fork 改写）。
 *
 * 为什么这不是「管理员的授予去掉检查」。三处不同，每一处都是另外两处安全的理由：
 *
 * - 哪些应用。只有管理员添加、打开并对主人开放的（`mcp_servers.owner_grants`，经 `ownerGrantsOf` 读）。
 *   默认是每个人用自己账号连接的应用和内置的例行任务。主人从不添加、打开应用，那仍是管理员的事。
 * - 哪些员工。只有这个人自己拥有的。没有主人的员工（目录里的公开员工）代表的是没有人，仍由管理员配置。
 * - 谁的账号。授予标为 `granted_as = owner`，这样的调用永远用提问人自己的账号，即使在主人发布的 Team Bot
 *   上也一样（`team-bots.ts` 的 `credentialActorFor`）。发布员工不能把主人的邮箱交给队友。
 *
 * Shared 应用是「谁的账号」唯一的例外，两条规则不相交：Shared 应用不管凭据归谁都用部署的一个团队账号，
 * 所以主人标记送不到个人账号；它需要的是受众。管理员让主人决定时（`owner_grants = any`，Shared 应用从不
 * 默认如此），主人的授予设下受众：见 {@link approveOwnersSharedUse}。
 *
 * 管理员还能经 `ownerApps` 能力对任何人整个关掉它，这里每一处检查都读它。
 */

/** 管理员有没有让这个人把自己的应用给自己的员工。 */
export async function ownerAppsAllowed(userId: string): Promise<boolean> {
  return (
    (await enterpriseControls()?.capabilityFor(userId, "ownerApps")) ?? true
  );
}

/** 员工的主人是谁：id 与邮箱；没有主人为 null；读不出来为 `unknown`（按主人的授予处理，失败闭合）。 */
export type OwnerIdentity = { id: string; email: string } | null | "unknown";

export async function ownerIdentityOf(
  database: Database,
  botId: string,
): Promise<OwnerIdentity> {
  try {
    const owner = await ownerTenantOfBot(database, botId);
    if (!owner) return null;
    const [person] = await database
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, owner))
      .limit(1);
    return person ? { id: owner, email: person.email } : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * 这条授予是不是员工的主人做的。标了 `owner` 的是；标了 `admin` 的不是；没有标记的（这一列出现之前写的，
 * 0197 回填之外剩下的）看授予人：就是员工的主人（邮箱不分大小写，或 id）就是主人的。主人读不出来时按
 * 主人的授予处理——失败闭合：Team Bot 上不会因此走主人的账号。
 */
export function isOwnersGrant(
  grant: { grantedAs: string | null; grantedBy: string | null },
  owner: OwnerIdentity,
): boolean {
  if (grant.grantedAs === "owner") return true;
  if (grant.grantedAs === "admin") return false;
  if (!grant.grantedBy || owner === null) return false;
  if (owner === "unknown") return true;
  const by = grant.grantedBy.trim().toLowerCase();
  return (
    by === owner.email.trim().toLowerCase() || by === owner.id.toLowerCase()
  );
}

/** {@link isOwnersGrant}，先读出员工的主人。 */
export async function grantedByOwner(
  database: Database,
  botId: string,
  grant: { grantedAs: string | null; grantedBy: string | null },
): Promise<boolean> {
  if (grant.grantedAs === "owner") return true;
  if (grant.grantedAs === "admin" || !grant.grantedBy) return false;
  return isOwnersGrant(grant, await ownerIdentityOf(database, botId));
}

/**
 * 员工的主人还能不能「给」：人还在（没有被移出部署，`revoked_access`），并且管理员没对他关掉 `ownerApps`。
 * 主人设下的团队账号受众与主人做的授予都在调用时问它，所以主人离开或被关掉能力之后，它们不再生效，
 * 不需要先清理。`allowed` 只为测试替换。
 */
export async function ownerStillGives(
  database: Database,
  ownerId: string,
  allowed: (userId: string) => Promise<boolean> = ownerAppsAllowed,
): Promise<boolean> {
  const [person] = await database
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, ownerId))
    .limit(1);
  if (!person) return false;
  const [removed] = await database
    .select({ email: revokedAccess.email })
    .from(revokedAccess)
    .where(eq(revokedAccess.email, person.email.trim().toLowerCase()))
    .limit(1);
  if (removed) return false;
  return allowed(ownerId);
}

/**
 * 这个人为什么不能自己把这个应用给这位员工；可以时为 null。句子就是他读到的那句。
 *
 * 问检查结果，不另推一遍：应用打开没有、对谁开放，和卡片与员工页画的是同一个答案。员工的主人在这里
 * 再读一次，因为 403 按此刻为真的事判，不按页面一分钟前读到的。
 */
export async function ownerGrantRefusal(
  store: Pick<PluginStore, "agentOwner" | "agentIsRegistered">,
  actorId: string,
  agentId: string,
  inspected: AppInspection,
): Promise<string | null> {
  const name = inspected.access.displayName;
  if (
    !(await store.agentIsRegistered(agentId)) ||
    (await store.agentOwner(agentId)) !== actorId
  )
    return "只能把应用给你自己的员工。";
  if (!(await ownerAppsAllowed(actorId)))
    return "管理员关闭了「把自己的应用给自己的员工」，所以没有做。";
  if (inspected.unavailable !== null || !inspected.answeringId)
    return `${name} 还没有打开。只有管理员可以打开它。`;
  if (inspected.access.ownerGrants !== "any")
    return `只有管理员可以把 ${name} 给员工。`;
  return null;
}

/**
 * 员工的主人这次授予设下的团队账号受众，以及它在轨迹里的一行。应用不是 Shared、规则不是 `any`、或这位
 * 员工已经有批准时什么都不做；见 `SharedUseStore.approveOwnerGrant`。在员工主人的帧里。
 */
export async function approveOwnersSharedUse(
  audience: Pick<SharedAudience, "record">,
  sharedUse: Pick<SharedUseStore, "approveOwnerGrant" | "appIdOf">,
  input: { botId: string; serverId: string; ownerId: string },
): Promise<void> {
  if (!input.serverId) return;
  const approval = await sharedUse.approveOwnerGrant({
    botId: input.botId,
    serverId: input.serverId,
    by: input.ownerId,
  });
  if (!approval) return;
  const appId = await sharedUse.appIdOf(input.serverId);
  await audience.record({
    eventType: "shared_use.owner_approved",
    targetId: appId,
    actorUserId: input.ownerId,
    payload: {
      bot: input.botId,
      server: appId,
      audience: approval.audience,
      members: approval.members,
      outsideInput: approval.outsideInput,
    },
  });
}

/**
 * 主人收回应用时，撤回他的授予在这个应用上为这位员工设下的受众，各写一行轨迹。管理员的批准从不动。
 * 在员工主人的帧里。管理员改规则时的撤回跨每位主人，在 `store.setOwnerGrants` 里做，轨迹由路由写。
 */
export async function withdrawOwnersSharedUse(
  audience: Pick<SharedAudience, "record">,
  sharedUse: Pick<SharedUseStore, "withdrawOwnerApprovals" | "appIdOf">,
  input: { serverId: string; botId: string; actorId: string },
): Promise<void> {
  const bots = await sharedUse.withdrawOwnerApprovals({
    serverId: input.serverId,
    botId: input.botId,
  });
  if (bots.length === 0) return;
  const appId = await sharedUse.appIdOf(input.serverId);
  for (const bot of bots)
    await audience.record({
      eventType: "shared_use.owner_withdrawn",
      targetId: appId,
      actorUserId: input.actorId,
      payload: { bot, server: appId, why: "owner_took_back" },
    });
}
