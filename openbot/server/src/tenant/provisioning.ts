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
 * their 分身, the personal coworker the onboarding then asks to configure.
 *
 * Called from Better Auth's user-create hook, so every arrival path — password sign-up, OAuth,
 * SSO — provisions the same way. It must be idempotent against a retry: one agent row per user.
 */
export async function provisionTenant(
  database: Database,
  user: { id: string; email: string; name?: string | null },
): Promise<void> {
  // The rows name a tenant that does not exist yet, so the write has to run
  // inside that tenant's scope; RLS will not admit another scope's stamp.
  await runAsTenant(user.id, async () => {
    await database
      .insert(subscriptions)
      .values({ tenantId: user.id, planId: "free" })
      .onConflictDoNothing();

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
        roleDescription: "选择你的信息来源，为个人分身完成输入配置。",
        avatarSeed: user.id.slice(0, 8),
        visibility: "private",
      })
      .onConflictDoNothing();
  });
}
