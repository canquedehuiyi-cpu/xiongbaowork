import type { ReactNode } from "react";
import { CARD_FACE, Tag } from "@/components/resources/resource-kit";
import { cn } from "@/lib/utils";

/**
 * The pieces the WakerFlow screens share (list, detail, editor, import), drawn to
 * docs/design/ios-studio: one card face, one section heading, one badge for a run's or a step's
 * state. The card and the badge are the 能力与资源 kit's own, so a Flow reads like every other
 * workbench resource.
 */

export { CARD_FACE };

/** A titled block of the detail page: a 17px heading, a quiet sentence, then its body. */
export function FlowSection({
  title,
  description,
  aside,
  children,
  className,
}: {
  title: string;
  description?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("mt-[28px]", className)}>
      <div className="flex min-h-[26px] flex-wrap items-center justify-between gap-[10px]">
        <h2 className="font-bold text-[17px] leading-[26px] tracking-[-0.02em]">
          {title}
        </h2>
        {aside}
      </div>
      {description ? (
        <p className="mt-[2px] text-pretty text-[13px] text-muted-foreground leading-[1.6]">
          {description}
        </p>
      ) : null}
      <div className="mt-[10px]">{children}</div>
    </section>
  );
}

/** A graphite card with the workbench hairline. */
export function FlowCard({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn(CARD_FACE, "p-[14px]", className)}>{children}</div>;
}

/**
 * A run's or a step's state as a badge. The words carry the state; the red plate only echoes the
 * ones that want a person's eye (going now, waiting on someone, failed).
 */
export function StateBadge({ state, label }: { state: string; label: string }) {
  const tone =
    state === "running" || state === "awaiting_action" || state === "failed"
      ? "warning"
      : state === "done" || state === "ready"
        ? "positive"
        : "muted";
  return <Tag tone={tone}>{label}</Tag>;
}

/** A native select at the workbench's 32px, on the same dark plate as `LabeledSelect`. */
export const SELECT_CLASS =
  "h-[32px] min-w-0 rounded-[9px] border border-border bg-muted px-[9px] text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-[oklch(0.196_0.002_286.2)]";
