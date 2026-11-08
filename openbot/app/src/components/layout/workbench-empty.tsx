import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/* The character's own colours, the same in either theme: he is a character, not a surface. */
const INK = "oklch(0.16 0.012 40)";
const MASK_RED = "oklch(0.6 0.22 27)";
const MASK_WHITE = "oklch(0.99 0.005 80)";
const MUZZLE = "oklch(0.93 0.035 70)";
const IRIS = "oklch(0.42 0.09 50)";
const TONGUE = "oklch(0.74 0.13 10)";

/**
 * 熊宝, the product's own mascot, drawn after the brand's character sheet: a panda whose face is a
 * 京剧脸谱 — a red mask, black eye patches edged in white, a black brow stripe — with black ears, a
 * cream muzzle and a black nose, sitting on a disc ringed in the logo's gold.
 *
 * `mood` picks one of the sheet's expressions: `happy` (开心, both eyes open) or `wink` (调皮, one
 * eye shut and the tongue out).
 */
export function BearMascot({
  size = 64,
  mood = "happy",
  className,
}: {
  size?: number;
  mood?: "happy" | "wink";
  className?: string;
}) {
  return (
    <svg
      aria-label="熊宝"
      className={cn("shrink-0", className)}
      data-mood={mood}
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
        stroke="var(--brand-gold)"
        strokeOpacity="0.7"
      />
      <circle
        cx="16.5"
        cy="18"
        fill={INK}
        r="7"
        stroke="var(--foreground)"
        strokeOpacity="0.18"
      />
      <circle
        cx="47.5"
        cy="18"
        fill={INK}
        r="7"
        stroke="var(--foreground)"
        strokeOpacity="0.18"
      />
      <circle cx="16.5" cy="18" fill="oklch(0.3 0.02 40)" r="3.4" />
      <circle cx="47.5" cy="18" fill="oklch(0.3 0.02 40)" r="3.4" />
      <circle cx="32" cy="35" fill={MASK_RED} r="19.5" />
      <g stroke={MASK_WHITE} strokeLinejoin="round" strokeWidth="1.6">
        <path
          d="M14.8 31 Q18.5 23.5 28 27.5 Q29.4 35 24.2 39.6 Q16.4 38.6 14.8 31Z"
          fill={INK}
        />
        <path
          d="M49.2 31 Q45.5 23.5 36 27.5 Q34.6 35 39.8 39.6 Q47.6 38.6 49.2 31Z"
          fill={INK}
        />
        <path
          d="M29.2 16.6 Q32 15 34.8 16.6 L33.5 25.4 Q32 26.6 30.5 25.4Z"
          fill={INK}
        />
      </g>
      <Eye cx={24} />
      {mood === "wink" ? (
        <path
          d="M36.8 34 Q40 30.8 43.2 34"
          fill="none"
          stroke={MASK_WHITE}
          strokeLinecap="round"
          strokeWidth="1.7"
        />
      ) : (
        <Eye cx={40} />
      )}
      <ellipse cx="32" cy="45" fill={MUZZLE} rx="8.4" ry="6.2" />
      <ellipse cx="32" cy="41.6" fill={INK} rx="2.9" ry="2" />
      {mood === "wink" ? (
        <ellipse cx="32" cy="47.6" fill={TONGUE} rx="1.9" ry="1.7" />
      ) : null}
      <path
        d="M29.2 45.6 Q32 47.6 34.8 45.6"
        fill="none"
        stroke={INK}
        strokeLinecap="round"
        strokeWidth="1.2"
      />
    </svg>
  );
}

function Eye({ cx }: { cx: number }) {
  return (
    <g>
      <circle cx={cx} cy="33" fill={MASK_WHITE} r="3.4" />
      <circle cx={cx} cy="33.3" fill={IRIS} r="2.4" />
      <circle cx={cx} cy="33.4" fill={INK} r="1.2" />
      <circle cx={cx - 0.9} cy="32.2" fill={MASK_WHITE} r="0.7" />
    </g>
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
