import type { Database } from "../db/client";
import { agentProfiles, agents, subscriptions } from "../db/schema";
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
    await database
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
