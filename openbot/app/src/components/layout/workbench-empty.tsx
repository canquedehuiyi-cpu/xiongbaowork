import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * 熊宝, the product's own mascot: a round bear face drawn here, in our colours, for empty states.
 * The reference product puts its own character in the same place; ours is our brand's, not a copy.
 */
export function BearMascot({
  size = 64,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      aria-label="熊宝"
      className={cn("shrink-0", className)}
      height={size}
      role="img"
      viewBox="0 0 64 64"
      width={size}
    >
      <circle
        cx="32"
        cy="32"
        fill="var(--card)"
        r="31"
        stroke="var(--border)"
      />
      <circle cx="19" cy="21" fill="var(--primary)" r="7" />
      <circle cx="45" cy="21" fill="var(--primary)" r="7" />
      <circle
        cx="19"
        cy="21"
        fill="var(--primary-foreground)"
        opacity="0.35"
        r="3.5"
      />
      <circle
        cx="45"
        cy="21"
        fill="var(--primary-foreground)"
        opacity="0.35"
        r="3.5"
      />
      <ellipse cx="32" cy="35" fill="var(--primary)" rx="17" ry="15" />
      <circle cx="25.5" cy="32" fill="var(--primary-foreground)" r="2.2" />
      <circle cx="38.5" cy="32" fill="var(--primary-foreground)" r="2.2" />
      <ellipse
        cx="32"
        cy="40"
        fill="var(--card)"
        opacity="0.85"
        rx="7"
        ry="5"
      />
      <ellipse
        cx="32"
        cy="38.2"
        fill="var(--primary-foreground)"
        rx="2.4"
        ry="1.7"
      />
      <path
        d="M29.5 42.2 Q32 44.2 34.5 42.2"
        fill="none"
        stroke="var(--primary-foreground)"
        strokeLinecap="round"
        strokeWidth="1.3"
      />
    </svg>
  );
}

/** A workbench empty state: the mascot, a title and one sentence, and an optional action. */
export function WorkbenchEmpty({
  title,
  description,
  action,
  className,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 px-6 py-12 text-center",
        className,
      )}
    >
      <BearMascot />
      <p className="mt-2 font-medium text-[14px]">{title}</p>
      {description ? (
        <p className="max-w-md text-pretty text-[12px] text-muted-foreground">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
