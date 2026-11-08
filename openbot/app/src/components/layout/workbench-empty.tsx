import type { ReactNode } from "react";
import { PRESET_IMAGES } from "@/components/portraits/preset-images";
import type { PortraitPreset } from "@/lib/portraits/queries";
import { cn } from "@/lib/utils";

/** 调皮 · 可爱 · 帅气 · 开心 · 卖萌, as the character sheet names them. */
export type BearMood = PortraitPreset;

/**
 * 熊宝, the product's own mascot: the 京剧脸谱 panda of the logo, in one of the character sheet's
 * expressions, as a round portrait ringed in the logo's gold. Each empty state picks the expression
 * that fits what it says; `happy` (开心) is the default.
 */
export function BearMascot({
  size = 64,
  mood = "happy",
  className,
}: {
  size?: number;
  mood?: BearMood;
  className?: string;
}) {
  return (
    <img
      alt="熊宝"
      className={cn(
        "shrink-0 select-none rounded-full bg-card shadow-sm ring-1 ring-brand-gold/60",
        className,
      )}
      data-mood={mood}
      decoding="async"
      draggable={false}
      height={size}
      src={PRESET_IMAGES[mood]}
      width={size}
    />
  );
}

/** A workbench empty state: the mascot, a title and one sentence, and an optional action. */
export function WorkbenchEmpty({
  title,
  description,
  action,
  mood,
  className,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  /** Which of 熊宝's expressions greets the empty list; 开心 unless the page says otherwise. */
  mood?: BearMood;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 px-6 py-12 text-center",
        className,
      )}
    >
      <BearMascot mood={mood} />
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
