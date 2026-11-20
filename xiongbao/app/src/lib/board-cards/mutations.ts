import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { type BoardCard, boardCardKeys } from "./queries";

export type NewBoardCard = {
  title: string;
  detail?: string;
  role: string;
  priority?: number;
  urgent?: boolean;
};

/** 放卡和撤卡之后，卡的清单和看板上的卡都要重读。 */
function refresh(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: boardCardKeys.all });
  void queryClient.invalidateQueries({ queryKey: ["tasks"] });
  void queryClient.invalidateQueries({ queryKey: ["tasks-summary"] });
}

export function postBoardCardMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (input: NewBoardCard): Promise<BoardCard> =>
      client("/api/board-cards", "card", {
        method: "POST",
        body: input,
        fallback: "这张卡没能放上去，请稍后再试。",
      }),
    onSuccess: () => refresh(queryClient),
  });
}

export function withdrawBoardCardMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (id: string): Promise<void> => {
      await client(`/api/board-cards/${encodeURIComponent(id)}`, {
        method: "DELETE",
        fallback: "这张卡没能撤掉。它可能已经被员工领走了。",
      });
    },
    onSuccess: () => refresh(queryClient),
  });
}
