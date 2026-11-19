import { useQuery } from "@tanstack/react-query";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { cn } from "@/lib/utils";

/** What a Bot's visibility is called on screen. */
export function visibilityLabel(visibility: "public" | "private"): string {
  return visibility === "public" ? "公开" : "仅自己";
}

/** The visibility tag; nothing in the personal edition, where there is nobody else to see it. */
export function VisibilityTag({
  visibility,
  className,
}: {
  visibility: "public" | "private";
  className?: string;
}) {
  const personal =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition === "personal";
  if (personal) return null;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-lg bg-muted text-muted-foreground",
        className,
      )}
    >
      {visibilityLabel(visibility)}
    </span>
  );
}
