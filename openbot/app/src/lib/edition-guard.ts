import type { QueryClient } from "@tanstack/react-query";
import { redirect } from "@tanstack/react-router";
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

/**
 * A `beforeLoad` for a page only the personal edition has: anywhere else it sends the person to
 * `to`, the page that holds the same thing there. 上游原样（M5b 第 0 步随 `connections.browse.*` 一起补上）。
 */
export function personalOnly(to: "/connections" | "/settings") {
  return async ({ context }: { context: { queryClient: QueryClient } }) => {
    if ((await editionOf(context.queryClient)) !== "personal") {
      throw redirect({ to });
    }
  };
}
