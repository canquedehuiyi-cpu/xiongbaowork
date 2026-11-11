import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { reviewerGuidanceKeys } from "./queries";

const FALLBACK = "自动审核的指引没能保存。";

const invalidateGuidance = (queryClient: QueryClient) =>
  queryClient.invalidateQueries({ queryKey: reviewerGuidanceKeys.all });

/**
 * Save the guidance. The server reads the words again and refuses them, saying why, unless they still
 * read as guidance; then it records the save on the trail with the words and the reading.
 */
export const saveReviewerGuidanceMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: (text: string) =>
      client("/api/approvals/team/guidance", {
        method: "PUT",
        body: { text },
        fallback: FALLBACK,
      }),
    onSuccess: () => invalidateGuidance(queryClient),
  });

/** Remove the guidance, so the reviewer reads only its own instructions again. Recorded on the trail. */
export const removeReviewerGuidanceMutationOptions = (
  queryClient: QueryClient,
) =>
  mutationOptions({
    mutationFn: () =>
      client("/api/approvals/team/guidance", {
        method: "DELETE",
        fallback: "自动审核的指引没能移除。",
      }),
    onSuccess: () => invalidateGuidance(queryClient),
  });
