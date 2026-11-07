import { useEffect, useRef } from "react";
import type { BotAttention } from "@/lib/bot-lifecycle/queries";

/** Questions, approvals and stalled hand-offs: the things only the person can move forward. */
export function needsInput(bot: BotAttention): number {
  return bot.questions + bot.approvals + bot.handoffs;
}

/** What the badge says, in words, for the row's accessible name and its tooltip. */
export function attentionSummary(bot: BotAttention): string {
  const parts: string[] = [];
  if (bot.questions) parts.push(`${bot.questions} 个提问`);
  if (bot.approvals) parts.push(`${bot.approvals} 个审批`);
  if (bot.handoffs) parts.push(`${bot.handoffs} 个卡住的交接`);
  if (bot.unread) parts.push(`${bot.unread} 条未读`);
  return parts.join("、");
}

/**
 * A browser notification when a Bot starts needing this person, if they allowed notifications and
 * did not mute this Bot. Badges show either way; this is the interruption, and it is opt-in.
 */
export function useAttentionNotifications(bots: BotAttention[] | undefined) {
  const seen = useRef<Map<string, number> | null>(null);
  useEffect(() => {
    if (!bots) return;
    const previous = seen.current;
    seen.current = new Map(bots.map((bot) => [bot.agentId, needsInput(bot)]));
    // The first answer is the state on arrival, not news.
    if (!previous) return;
    let permitted = false;
    try {
      permitted =
        typeof Notification !== "undefined" &&
        Notification.permission === "granted";
    } catch {
      permitted = false;
    }
    if (!permitted) return;
    for (const bot of bots) {
      const now = needsInput(bot);
      if (bot.notify === "none" || now <= (previous.get(bot.agentId) ?? 0))
        continue;
      try {
        new Notification(`${bot.name} 需要你`, {
          body: attentionSummary(bot),
          tag: `openbot-attention-${bot.agentId}`,
        });
      } catch {
        // A browser that refuses the constructor still has the badge.
      }
    }
  }, [bots]);
}
