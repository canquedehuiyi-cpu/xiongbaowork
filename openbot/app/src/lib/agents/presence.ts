import {
  keepPreviousData,
  queryOptions,
  useQuery,
} from "@tanstack/react-query";
import { useMemo } from "react";
import { client } from "@/lib/client";
import { agentKeys } from "./queries";

/*
 * 员工此刻（聊天工作台 Task 8）：一批员工各自在忙、空闲还是被暂停，以及正在做的那件事，从
 * `GET /api/agents/presence?ids=…` 一次读出来。服务端读的是员工详情页 `useProfileStatus` 那两条读取同样的
 * 事实（暂停、看板上运行中的任务），所以状态点和详情页的状态徽章说法一致。
 *
 * 一个界面一次调用：列表、通讯录、对话顶栏各自把画出来的员工 id 合成一批，不是每行一个。
 */

export type PresenceStatus =
  | "working"
  | "resting"
  | "paused"
  | "offline"
  | "unknown";

export type Presence = {
  agentId: string;
  status: PresenceStatus;
  /** 正在做的那件事（运行中任务的标题），不在忙时为 null。 */
  doing: string | null;
  /**
   * 外部员工的电脑离线时排着几件活。只有离线时、只有招聘人读得到；群里的其他成员看到的离线没有它。
   */
  queued?: number;
};

/** 服务端一次最多回答这么多位，多出来的不问。 */
export const PRESENCE_MAX_IDS = 100;

/** 和员工详情页的运行中任务同一个节奏。 */
export const PRESENCE_POLL_MS = 10_000;

const EMPTY: ReadonlyMap<string, Presence> = new Map();

/**
 * 去重、截到上限、排序：同一批员工不管先后，用的是同一条缓存。超过上限时先给的留下，所以要紧的放前面
 * （消息列表把外部员工放在最前，离线提示条靠它们）。
 */
export function presenceIds(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id) => id.length > 0))]
    .slice(0, PRESENCE_MAX_IDS)
    .sort();
}

export function presenceQueryOptions(ids: readonly string[]) {
  const batch = presenceIds(ids);
  return queryOptions({
    queryKey: [...agentKeys.all, "presence", batch] as const,
    queryFn: (): Promise<Presence[]> =>
      client(
        `/api/agents/presence?${new URLSearchParams({ ids: batch.join(",") })}`,
        "items",
        { fallback: "读不到员工此刻的状态。" },
      ),
    enabled: batch.length > 0,
    // 列表多出一行时换了一批 id：新一批回来之前，已经知道的那几位照旧画着，不闪。
    placeholderData: keepPreviousData,
    refetchInterval: PRESENCE_POLL_MS,
  });
}

/**
 * 这批员工此刻的状态，按员工 id 查。还在加载、读失败了（包括上一次读到过、这一次失败）都是空的：读不到
 * 就不画，不拿旧的或编的顶上。
 */
export function usePresence(
  ids: readonly string[],
): ReadonlyMap<string, Presence> {
  const query = useQuery(presenceQueryOptions(ids));
  const failed = query.isError;
  const items = query.data;
  return useMemo(
    () =>
      failed || !Array.isArray(items)
        ? EMPTY
        : new Map(items.map((item) => [item.agentId, item])),
    [failed, items],
  );
}

/** 状态点和「此刻」用的字：`unknown` 和拿不到的都没有字。 */
export const PRESENCE_WORD: Record<
  Exclude<PresenceStatus, "unknown">,
  string
> = {
  working: "忙碌",
  resting: "空闲",
  paused: "已暂停",
  offline: "离线",
};

/** 这位员工画不画得出状态：拿到了、而且不是 `unknown`。 */
export function knownPresence(
  presence: Presence | undefined,
): (Presence & { status: Exclude<PresenceStatus, "unknown"> }) | undefined {
  return presence && presence.status !== "unknown"
    ? (presence as Presence & {
        status: Exclude<PresenceStatus, "unknown">;
      })
    : undefined;
}

/** 正在做的事：只有忙碌、而且有标题时才有。 */
export function presenceDoing(presence: Presence | undefined): string | null {
  return presence?.status === "working" && presence.doing?.trim()
    ? presence.doing.trim()
    : null;
}

/**
 * 状态的一句话：那个词，忙碌时跟着正在做的事（「忙碌 · 跑登录页的测试」），离线时跟着排队数（「离线 · 2 件
 * 排队中」，没有排队、或读的人不是招聘人时只写「离线」）。拿不到、`unknown` 时是空的。
 */
export function presenceSummary(presence: Presence | undefined): string {
  const known = knownPresence(presence);
  if (!known) return "";
  const queued =
    known.status === "offline" && known.queued && known.queued > 0
      ? `${known.queued} 件排队中`
      : null;
  return [PRESENCE_WORD[known.status], presenceDoing(known) ?? queued]
    .filter(Boolean)
    .join(" · ");
}
