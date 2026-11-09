import { IconPlus } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/*
 * The 员工管理 wall's shared card language, for both tabs, measured off the reference screenshot
 * (docs/acceptance/qoderwake-reference/wakers.png): fixed 330 × 212 CSS px cards on a 12px grid,
 * the create card first. `min(330px,100%)` lets a single column shrink on a phone instead of
 * scrolling the page sideways.
 */
export const GRID =
  "grid grid-cols-[repeat(auto-fill,minmax(min(330px,100%),330px))] gap-[12px]";

/** The surface every cell on the wall shares: the card token on a 1px hairline. */
export const CARD_SURFACE =
  "group/card relative flex min-h-[212px] w-full flex-col overflow-hidden rounded-lg border border-border bg-card text-center transition-colors";

/** A card's footer: a hairline 16px in from each side, then two equal cells split by a rule. */
export function CardFooter({
  left,
  right,
  className,
}: {
  left: ReactNode;
  right: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "mx-4 mt-auto flex h-[50px] shrink-0 items-center pb-[8px] border-border border-t text-[13px] text-muted-foreground tabular-nums",
        className,
      )}
      data-card-footer=""
    >
      <div className="flex min-w-0 flex-1 items-center justify-center">
        {left}
      </div>
      <span aria-hidden="true" className="h-[16px] w-px shrink-0 bg-border" />
      <div className="flex min-w-0 flex-1 items-center justify-center">
        {right}
      </div>
    </div>
  );
}

/**
 * Three employee cards fanned out, the front one wearing a round avatar in our own colours: the
 * create card's picture. Drawn here, not taken from the reference, whose card shows its own
 * character.
 */
function StackedCards() {
  return (
    <svg
      aria-hidden="true"
      className="shrink-0"
      data-create-illustration=""
      height="108"
      viewBox="0 0 120 98"
      width="132"
    >
      <defs>
        <linearGradient id="waker-create-face" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stopColor="var(--primary)" />
          <stop offset="1" stopColor="var(--signal)" />
        </linearGradient>
      </defs>
      <g transform="rotate(-14 38 60)">
        <rect
          fill="var(--muted)"
          height="78"
          rx="7"
          stroke="var(--border)"
          width="58"
          x="10"
          y="16"
        />
      </g>
      <g transform="rotate(12 82 60)">
        <rect
          fill="var(--muted)"
          height="78"
          rx="7"
          stroke="var(--border)"
          width="58"
          x="52"
          y="16"
        />
      </g>
      <rect
        fill="var(--secondary)"
        height="84"
        rx="8"
        stroke="var(--muted-foreground)"
        strokeOpacity="0.35"
        width="62"
        x="29"
        y="7"
      />
      <circle cx="60" cy="36" fill="url(#waker-create-face)" r="15" />
      <circle cx="54.5" cy="34" fill="var(--primary-foreground)" r="1.8" />
      <circle cx="65.5" cy="34" fill="var(--primary-foreground)" r="1.8" />
      <path
        d="M55.5 40.5 Q60 44 64.5 40.5"
        fill="none"
        stroke="var(--primary-foreground)"
        strokeLinecap="round"
        strokeWidth="1.6"
      />
      <rect
        fill="var(--foreground)"
        height="4"
        opacity="0.55"
        rx="2"
        width="34"
        x="43"
        y="60"
      />
      <rect
        fill="var(--muted-foreground)"
        height="3"
        opacity="0.5"
        rx="1.5"
        width="24"
        x="48"
        y="70"
      />
      <rect
        fill="var(--primary)"
        height="3"
        opacity="0.7"
        rx="1.5"
        width="14"
        x="53"
        y="79"
      />
    </svg>
  );
}

/** Two faint curves behind the create card's picture: decoration, never content. */
function Curves() {
  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 size-full"
      preserveAspectRatio="none"
      viewBox="0 0 330 212"
    >
      <path
        d="M-10 40 C 90 70, 170 150, 230 230"
        fill="none"
        stroke="var(--foreground)"
        strokeOpacity="0.035"
        strokeWidth="26"
      />
      <path
        d="M60 -10 C 150 60, 250 90, 300 230"
        fill="none"
        stroke="var(--foreground)"
        strokeOpacity="0.07"
        strokeWidth="1.5"
      />
    </svg>
  );
}

/** What the create card shows: the curves, the stacked cards, and 「+ 新建…」 under them. */
export function CreateCardFace({ label }: { label: string }) {
  return (
    <>
      <Curves />
      <span className="relative flex flex-col items-center gap-[16px] pt-[36px]">
        <StackedCards />
        <span className="flex items-center gap-2 text-[16px] text-foreground/85 leading-[24px] transition-colors group-hover/card:text-foreground">
          <IconPlus aria-hidden="true" className="size-[16px]" />
          {label}
        </span>
      </span>
    </>
  );
}

/** The create card's own surface: dashed, so it reads as a slot rather than as an employee. */
export const CREATE_CARD = cn(
  CARD_SURFACE,
  "items-center border-dashed outline-none hover:border-foreground/30 focus-visible:ring-2 focus-visible:ring-ring/60",
);
