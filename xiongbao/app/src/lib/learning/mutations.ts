import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { learningKeys } from "./queries";

/** Learn now: start a Learning run over your own recordings. */
export function startPersonalLearningRunMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationFn: (container: string): Promise<{ id: string; status: string }> =>
      client(
        `/api/settings/learning/runs?container=${encodeURIComponent(container)}`,
        "run",
        {
          method: "POST",
          body: {},
          fallback: "没能开始学习。请再试一次。",
        },
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: learningKeys.all }),
  });
}
