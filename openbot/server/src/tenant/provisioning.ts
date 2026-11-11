import { STAFFING_TOOL_NAMES } from "../../../shared/staffing-proposal";
import type { Database } from "../db/client";
import {
  agentProfiles,
  agents,
  enterpriseSettings,
  pluginGrants,
  subscriptions,
} from "../db/schema";
import { runAsTenant } from "./context";

/**
 * The 分身's deterministic id.
 *
 * Deterministic so a retried provisioning hook cannot make a second one — and named here because the
 * coworker quota has to exclude it: the 分身 is the person's own voice, not a seat they bought.
 */
export function avatarAgentId(tenantId: string): string {
  return `avatar-${tenantId}`;
}

/** 小管家默认「招聘与组群」的授予记在 `plugin_grants.granted_by` 的标记。 */
export const STAFFING_DEFAULT_BY = "openbot:staffing-default";

/**
 * 「招聘与组群」六个工具的授予 ref，如 `staffing/propose_employee`；与 `staffing/executor.ts` 给新员工授予时
 * 同一个形状。
 */
export const STAFFING_REFS: readonly string[] = STAFFING_TOOL_NAMES.map(
  (tool) => `staffing/${tool}`,
);

/**
 * 「这位分身已经处理过默认招聘能力」的一行设置，每位分身一行（和 `personal_skills_given:` 同一种做法）。
 * 有了它，本人之后收回的就不会被补回来。
 */
export function staffingGivenSetting(avatarId: string): string {
  return `staffing_default_given:${avatarId}`;
}

/**
 * 新开通分身时与它一起写下的授予行。授予记为主人做的（`owner`），因为这是本人的员工拿到的本人的能力，
 * 本人可以在权限页上收回；开通在这个人自己的帧里写，所以只用行，不经插件库。
 */
export function staffingGrantRows(avatarId: string, tenantId: string) {
  return STAFFING_REFS.map((ref) => ({
    tenantId,
    kind: "mcp" as const,
    ref,
    agentId: avatarId,
    grantedBy: STAFFING_DEFAULT_BY,
    grantedAs: "owner" as const,
  }));
}

/**
 * What the 分身 is for, as its role description says it (story F1).
 *
 * A role description is read as a coworker's PURPOSE: the employee list shows it, and the router
 * offers it as the coworker's `for:` line (`routing/classify.ts`). It used to be an instruction to
 * the person ("选择你的信息来源，为个人分身完成输入配置。"), which told the router this coworker
 * exists to configure sources. Migration 0130 replaces that sentence with this one on every 分身 that
 * still carries it. Whether the 分身 is configured is `agent_profiles.configured_at`, not prose.
 *
 * It does not reach the 分身's own prompt: a `built_in` coworker runs on `configuration.systemPrompt`
 * below, and its declared sources are appended per run (`avatarSourcesGuidance` in copilot.ts).
 */
export const AVATAR_ROLE_DESCRIPTION =
  "代表你本人收集、整理和跟进工作信息，回答与你自己的资料、日程和待办有关的问题。";

/**
 * The id a brand package's conversation gets inside one person's workspace.
 *
 * Same reasoning as {@link avatarAgentId}: deterministic, so a retried sync cannot mint a second copy,
 * and namespaced by tenant because a channel is one person's thread list -- two people each getting
 * `operations` from the same package cannot share a primary key, and sharing the row itself would put
 * one person's messages in the other's sidebar.
 */
export function packageChannelId(tenantId: string, channelId: string): string {
  return `pkg-${tenantId}-${channelId}`;
}

/**
 * Everything a brand-new tenant gets before they see a single screen: a Free subscription and
 * their 分身, the personal coworker the onboarding then asks to configure (its information sources,
 * `avatar-sources.ts`; until then `configured_at` is null and the employee list says 待配置).
 *
 * Called from Better Auth's user-create hook, so every arrival path — password sign-up, OAuth,
 * SSO — provisions the same way; and from the paths that never pass through that hook, the
 * organization store (enterprise sign-in against a pinned authority) and the single-user actor at
 * start-up, so no tenant is left without a subscription row an administrator can switch. It must be
 * idempotent against a retry and a repeat: one subscription row and one agent row per user.
 */
export async function provisionTenant(
  database: Database,
  user: { id: string; email: string; name?: string | null },
  options: {
    /** 新建出分身时一并给它「招聘与组群」（`staffing/default-grant.ts`）；开通的入口按需要传。 */
    withStaffing?: boolean;
  } = {},
): Promise<void> {
  // The rows name a tenant that does not exist yet, so the write has to run
  // inside that tenant's scope; RLS will not admit another scope's stamp.
  await runAsTenant(user.id, async () => {
    // One subscription row per tenant (`subscriptions_tenant_unique`, 0129). Callers that run on
    // every sign-in (the organization store) and at every start (the single-user actor) call this
    // repeatedly, and two first calls can race; the conflict on the tenant makes every call after the
    // first a no-op, so an existing row, active or canceled, is the plan someone chose and is left
    // alone.
    await database
      .insert(subscriptions)
      .values({ tenantId: user.id, planId: "free" })
      .onConflictDoNothing({ target: subscriptions.tenantId });

    // One 分身 per tenant, keyed by a deterministic id so a retried hook cannot make a second.
    const avatarId = avatarAgentId(user.id);
    const created = await database
      .insert(agents)
      .values({
        id: avatarId,
        tenantId: user.id,
        name: "我的分身",
        type: "built_in",
        configuration: {
          systemPrompt:
            "你是用户的个人分身：代表用户收集、整理和跟进信息，语气自然、简洁、中文优先。你不确定的事要直说，不编造。",
        },
      })
      .onConflictDoNothing()
      .returning({ id: agents.id });

    /*
     * 新开通的分身默认会招人、组群。只在这一次真的建出了分身时写：开通在每次登录和每次启动都会再调，
     * 已有的分身要是又被补一遍，本人收回或禁用过的就会回来。已有的分身由启动时的补授处理。
     */
    if (created.length > 0 && options.withStaffing === true)
      await database
        .insert(pluginGrants)
        .values(staffingGrantRows(avatarId, user.id))
        .onConflictDoNothing();
    if (created.length > 0 && options.withStaffing === true)
      await database
        .insert(enterpriseSettings)
        .values({
          key: staffingGivenSetting(avatarId),
          value: { value: true },
          updatedBy: STAFFING_DEFAULT_BY,
        })
        .onConflictDoNothing();

    await database
      .insert(agentProfiles)
      .values({
        agentId: avatarId,
        tenantId: user.id,
        ownerUserId: user.id,
        title: "个人分身",
        roleDescription: AVATAR_ROLE_DESCRIPTION,
        avatarSeed: user.id.slice(0, 8),
        visibility: "private",
      })
      .onConflictDoNothing();
  });
}
