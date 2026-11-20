import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/** 看板上派给岗位的卡：还没人领（open），或已被员工领走（claimed）。 */
export type BoardCard = {
  id: string;
  title: string;
  detail: string;
  /** 岗位，对应员工的头衔。 */
  role: string;
  priority: number;
  urgent: boolean;
  status: "open" | "claimed";
  /** 领它的员工；还没人领为 null。 */
  claimedBy: string | null;
  claimedAt: string | null;
  /** 领了之后开出来的看板卡，和那张卡现在的状态。 */
  taskId: string | null;
  taskStatus: string | null;
  createdAt: string;
};

export const boardCardKeys = {
  all: ["board-cards"] as const,
  list: () => ["board-cards", "list"] as const,
};

export function boardCardsQueryOptions() {
  return queryOptions({
    queryKey: boardCardKeys.list(),
    queryFn: async ({ signal }): Promise<BoardCard[]> =>
      client("/api/board-cards", "cards", {
        signal,
        fallback: "读不到派给岗位的卡",
      }),
  });
}
