import { keepPreviousData, useQueries } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  latestPlan,
  type PlanItem,
  readPlan as readSharedPlan,
} from "@/lib/channels/plan";
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

/**
 * 群里一位员工的计划从哪里来（期二）。回复行上有服务器记下的 `plan` 就用它，群里每个人读到的一样，不读线程；最近
 * 那一行还没有（还在跑，或是记这个字段之前的老回复），就退回读它这条线程（先认你发起的那一行，那条线程你读得到），
 * 读不到时用更早那一行记下的计划。
 */
function planSources(
  messages: readonly GroupMessage[],
  bots: readonly { id: string; name: string }[],
  meId: string | undefined,
) {
  /*
   * 不只是读的人能用的员工：员工是发起人私有的时，同事拿到的名单里没有它，它的回复照样在群里，计划也该在。
   * 名字照群里一贯的说法，不知道就叫「一位员工」（`GroupLine`）。
   */
  const names = new Map(bots.map((bot) => [bot.id, bot.name]));
  const ids = [
    ...new Set([
      ...bots.map((bot) => bot.id),
      ...messages.flatMap((message) =>
        message.agentId ? [message.agentId] : [],
      ),
    ]),
  ];
  return ids.flatMap((id) => {
    const bot = { id, name: names.get(id) ?? "一位员工" };
    const lines = messages.filter((message) => message.agentId === bot.id);
    const recorded = lines.findLastIndex((message) => readPlan(message.plan));
    const fromRow =
      recorded === -1 ? null : (readPlan(lines[recorded]?.plan) ?? null);
    // 比记着计划的那一行更新的行：最新一行自己就带着计划时没有，不读线程。
    const newer = lines
      .slice(recorded + 1)
      .filter((message) => message.threadId);
    const line =
      newer.findLast((message) => message.ownerUserId === meId) ?? newer.at(-1);
    const thread = line?.threadId ? { line, threadId: line.threadId } : null;
    return fromRow || thread ? [{ bot, fromRow, thread }] : [];
  });
}

/** 回复行上记的清单，按计划的规矩读一遍；不像一份计划就当没有。 */
function readPlan(plan: GroupMessage["plan"]): PlanItem[] | undefined {
  return plan ? readSharedPlan({ items: plan }) : undefined;
}

/**
 * 群聊里每位员工各自最后一次的计划，一人一张卡，卡上带名字。退回读线程时，那一行还在跑就每两秒读一次，跑完
 * 再读一次。
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
    queries: sources.map(({ bot, thread }) => {
      const running =
        thread?.line.status === "running" || thread?.line.status === "queued";
      return {
        queryKey: [
          "group-plan",
          thread?.threadId ?? "",
          bot.id,
          thread?.line.id ?? "",
          thread?.line.status ?? "",
        ],
        queryFn: async () => {
          if (!thread) return null;
          const stored = await readThreadMessages(thread.threadId, bot.id);
          return stored.availability === "ready"
            ? latestPlan(stored.messages)
            : null;
        },
        enabled: thread !== null,
        placeholderData: keepPreviousData,
        refetchInterval: running ? 2_000 : (false as const),
      };
    }),
  });
  const cards = sources.flatMap(({ bot, fromRow }, index) => {
    const items = plans[index]?.data ?? fromRow;
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
