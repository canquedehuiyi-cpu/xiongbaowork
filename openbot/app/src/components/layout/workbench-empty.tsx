import type { ReactNode } from "react";
import { PRESET_IMAGES } from "@/components/portraits/preset-images";
import { shortName } from "@/lib/brand";
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
      alt={shortName()}
      className={cn(
        "shrink-0 select-none rounded-[30%] border border-foreground/15 bg-accent shadow-[inset_0_1px_0_rgb(255_255_255/0.07)]",
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
  icon,
  mood,
  className,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  /**
   * A symbol in place of 熊宝, for a list whose emptiness is about a thing rather than a person (自主工作's
   * lightning). Drawn in the reference's 45px graphite signal tile.
   */
  icon?: ReactNode;
  /** Which of 熊宝's expressions greets the empty list; 开心 unless the page says otherwise. */
  mood?: BearMood;
  className?: string;
}) {
  return (
    <div
      className={cn(
        // docs/design/ios-studio `.empty`: a soft pool of light behind the mascot, the title, one line.
        "flex min-h-[169px] flex-col items-center justify-center gap-[3px] rounded-[14px] bg-[radial-gradient(ellipse_at_50%_35%,color-mix(in_oklab,var(--foreground)_6%,transparent),transparent_70%)] px-6 py-10 text-center",
        className,
      )}
    >
      {icon ? (
        <span
          aria-hidden="true"
          className="flex size-[45px] items-center justify-center rounded-[14px] border border-foreground/15 bg-accent text-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.07)] [&_svg]:size-[23px]"
        >
          {icon}
        </span>
      ) : (
        <BearMascot mood={mood} size={45} />
      )}
      <p className="mt-[8px] font-bold text-[15px]">{title}</p>
      {description ? (
        <p className="max-w-md text-pretty text-[12px] text-muted-foreground leading-[1.6]">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-[9px]">{action}</div> : null}
    </div>
  );
}
