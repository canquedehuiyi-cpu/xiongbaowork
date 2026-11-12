import { IconAt } from "@tabler/icons-react";
import { BrandLogo } from "@/components/layout/brand-logo";
import { shortName } from "@/lib/brand";

/**
 * The @Waker heading's illustration (docs/design/ios-studio `.chat-stage`, 02-Waker.png): a graphite
 * group-chat card tilted in space, a second card behind it as its shadow, a red @ tile floating at
 * its corner, and a dark red pool of light under the whole. Someone @-mentions a coworker and 熊宝
 * answers, which is the page's one idea drawn once.
 *
 * Decorative only: `PageShell` mounts it under `aria-hidden` and hides it below md, and the heading,
 * the sentence under it and the four entries say everything without it. Nothing moves, so there is
 * no motion to reduce. The chat card stays graphite in both themes — it is a picture of a dark chat
 * window — while the light behind it follows the theme.
 */
export function ChatStage() {
  return (
    <div
      className={[
        "relative h-full w-full overflow-hidden",
        // The pool of light: theme.css `.chat-stage`, faded out before the box's edges so no edge shows;
        // warmer and softer on paper.
        "bg-[radial-gradient(closest-side_at_62%_52%,color-mix(in_oklab,var(--signal)_13%,transparent)_0,color-mix(in_oklab,var(--signal)_5%,transparent)_50%,transparent_100%)]",
        "dark:bg-[radial-gradient(closest-side_at_62%_52%,#4a3536_0,#2a2122_50%,#1a171830_85%,transparent_100%)]",
      ].join(" ")}
      data-slot="chat-stage"
    >
      {/*
       * The cards and the @ tile, in one 3D space. Under 1150px the heading needs more of the row
       * (theme.css narrows the stage to 44% there), so the group shrinks toward its right edge.
       */}
      <div className="absolute inset-0 origin-[100%_40%] [perspective:850px] max-[1149px]:scale-[0.82]">
        {/* The card behind, offset down and right: theme.css `.chat-shadow`. */}
        <div className="absolute top-[70px] right-[8%] h-[152px] w-[78%] min-w-[242px] max-w-[450px] rounded-[19px] border border-white/[0.14] bg-[linear-gradient(151deg,#2d2d2e,#161617)] [transform:rotateY(-15deg)_rotateZ(-7deg)] min-[1150px]:min-w-[300px]" />

        {/* The chat itself: theme.css `.chat-art`. */}
        <div className="absolute top-[52px] right-[13%] h-[152px] w-[78%] min-w-[242px] max-w-[450px] rounded-[19px] border border-white/25 bg-[linear-gradient(146deg,#454547,#252527_60%,#1e1e20)] px-[13px] py-[11px] shadow-[0_19px_42px_rgb(0_0_0/0.6),inset_0_1px_0_rgb(255_255_255/0.16)] [transform:rotateY(-15deg)_rotateZ(-7deg)] min-[1150px]:min-w-[300px]">
          <div className="flex items-center gap-[4px] border-white/10 border-b pb-[8px] text-[#c7c7c9] text-[10px]">
            <i className="size-[4px] rounded-full bg-signal" />
            <i className="size-[4px] rounded-full bg-[#9a9a9d]" />
            <i className="size-[4px] rounded-full bg-[#9a9a9d]" />
            <strong className="ml-[6px] font-medium">团队群聊</strong>
            <span className="ml-auto font-mono text-[10px] tracking-[0.12em]">
              IM
            </span>
          </div>
          <p className="mt-[10px] mb-[8px] ml-auto w-fit max-w-full rounded-[8px_8px_2px_8px] bg-[#e9e9e9] px-[9px] py-[7px] text-[#191919] text-[11px] leading-[1.4]">
            <b className="mr-[4px] text-[#a71d21]">@员工</b>
            把本周客户反馈按优先级整理。
          </p>
          <div className="flex items-center gap-[7px] text-[#ececec] text-[10px]">
            <BrandLogo className="rounded-[8px]" size={29} />
            <div className="rounded-[8px_8px_8px_2px] border border-white/[0.08] bg-[#161617] px-[8px] py-[5px] leading-[1.45]">
              <b className="font-semibold">{shortName()}助手</b>
              <p className="text-[#d0d0d0]">
                收到。我会整理成一份带优先级的清单。
              </p>
            </div>
          </div>
        </div>

        {/* The @ tile: theme.css `.chat-float`. */}
        <span className="absolute top-[16%] right-[8%] grid size-[48px] rotate-[10deg] place-items-center rounded-[14px] border border-white/30 bg-[linear-gradient(145deg,#ff6669,#ae2026_82%)] text-white shadow-[0_8px_25px_rgb(61_19_21/0.48),inset_0_1px_0_rgb(255_255_255/0.29)]">
          <IconAt className="size-[24px]" stroke={2} />
        </span>
      </div>

      {/* theme.css `.stage-caption`. */}
      <span className="absolute right-[8px] bottom-[12px] flex items-center gap-[5px] font-mono text-[9px] text-faint tracking-[0.1em]">
        <i className="size-[4px] rounded-full bg-signal" />
        群聊接入演示
      </span>
    </div>
  );
}
