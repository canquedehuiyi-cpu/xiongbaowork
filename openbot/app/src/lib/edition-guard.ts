import type { QueryClient } from "@tanstack/react-query";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";

/** This deployment's edition, or `team` when it could not be read. */
export async function editionOf(
  queryClient: QueryClient,
): Promise<"team" | "personal"> {
  const capabilities = await queryClient
    .ensureQueryData(deploymentCapabilitiesQueryOptions())
    .catch(() => undefined);
  return capabilities?.edition ?? "team";
}
