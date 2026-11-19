import { keepPreviousData, useQueries } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { latestPlan } from "@/lib/channels/plan";
import { readThreadMessages } from "@/lib/copilot/thread-messages";
import type { GroupMessage } from "@/lib/groups";
import { PlanCard } from "./plan-card";

/*
 * 对话区顶部钉计划卡的那一格（期二）。和输入框同一个列宽（`conversation-view.tsx` 的 composer-column），清单
 * 长时自己滚，不把对话挤没。
 */
export function PinnedPlans({ children }: { children: ReactNode }) {
  return (
    <div
      className="mx-auto flex max-h-[45vh] w-full max-w-[calc(var(--container-3xl)+2rem)] shrink-0 flex-col gap-2 overflow-y-auto px-4 pt-3"
      data-pinned-plans=""
    >
      {children}
    </div>
  );
}

/** 群里一位员工的计划从哪条线程读：它最近的一行（先认你发起的那一行，那条线程你读得到）。 */
function planSources(
  messages: readonly GroupMessage[],
  bots: readonly { id: string; name: string }[],
  meId: string | undefined,
) {
  return bots.flatMap((bot) => {
    const lines = messages.filter(
      (message) => message.agentId === bot.id && message.threadId,
    );
    const line =
      lines.findLast((message) => message.ownerUserId === meId) ?? lines.at(-1);
    return line?.threadId ? [{ bot, line, threadId: line.threadId }] : [];
  });
}

/**
 * 群聊里每位员工各自最后一次的计划，一人一张卡，卡上带名字。群回复只有正文，计划在那位员工这条线的消息里，
 * 所以从它的线程读（和对话的历史同一个接口）；那一行还在跑时每两秒读一次，跑完再读一次。读不到（不是你发起的
 * 线程）就不画。
 */
export function GroupPlans({
  messages,
  bots,
  meId,
}: {
  messages: readonly GroupMessage[];
  bots: readonly { id: string; name: string }[];
  meId: string | undefined;
}) {
  const sources = planSources(messages, bots, meId);
  const plans = useQueries({
    queries: sources.map(({ bot, line, threadId }) => {
      const running = line.status === "running" || line.status === "queued";
      return {
        queryKey: ["group-plan", threadId, bot.id, line.id, line.status],
        queryFn: async () => {
          const stored = await readThreadMessages(threadId, bot.id);
          return stored.availability === "ready"
            ? latestPlan(stored.messages)
            : null;
        },
        placeholderData: keepPreviousData,
        refetchInterval: running ? 2_000 : (false as const),
      };
    }),
  });
  const cards = sources.flatMap(({ bot }, index) => {
    const items = plans[index]?.data;
    return items ? [{ bot, items }] : [];
  });
  if (cards.length === 0) return null;
  return (
    <PinnedPlans>
      {cards.map(({ bot, items }) => (
        <PlanCard items={items} key={bot.id} name={bot.name} />
      ))}
    </PinnedPlans>
  );
}
