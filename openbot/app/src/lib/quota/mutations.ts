import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { quotaKeys } from "./queries";

/**
 * Move to another tier by hand.
 *
 * There is no payment behind this — the decision was a complete plan system with no checkout — so the
 * honest verb is "switch", and the screen says so rather than pretending to start a purchase.
 */
export function switchPlanMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (planId: string): Promise<void> => {
      await client("/api/quota/plan", {
        method: "POST",
        body: { planId },
        fallback: "That plan could not be selected.",
      });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: quotaKeys.all }),
  });
}
