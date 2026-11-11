import { IconPlus } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/*
 * The 员工管理 wall's shared card language, for both tabs, after docs/design/ios-studio
 * (04-员工管理.png; theme.css `.staff-grid` / `.staff-card`): a 「角色档案」 card — a mono
 * `PROFILE / 01` index and a status badge on top, a 44px rounded-square face beside a 16px name and
 * one line of role, one line of duties, and a 任务数 · 最近运行 footer under a hairline.
 *
 * Three equal columns 11px apart, two at the reference's 1150px break, one at its 440px break. The
 * cells stretch to the column instead of sitting at a fixed width, so a single column on a phone
 * never scrolls the page sideways.
 */
export const GRID =
  "grid grid-cols-1 gap-[11px] min-[441px]:grid-cols-2 min-[1151px]:grid-cols-3";

/**
 * The surface every cell on the wall shares: the graphite card on a hairline, 16px corners, a soft
 * light in its top left corner (drawn by `::before` so the card token's own sheen still applies)
 * and the reference's faint top highlight.
 */
export const CARD_SURFACE = cn(
  "group/card relative isolate flex min-h-[177px] w-full min-w-0 flex-col overflow-hidden rounded-[16px] border border-border bg-card px-[14px] pt-[12px] pb-[12px] text-left shadow-[inset_0_1px_0_rgb(255_255_255/0.03)] transition-colors",
  "before:pointer-events-none before:absolute before:inset-0 before:-z-10 before:bg-[radial-gradient(ellipse_at_20%_4%,color-mix(in_oklab,var(--foreground)_7%,transparent),transparent_74%)] before:content-['']",
);

/**
 * The person's own 分身 (theme.css `.staff-card.personal`): the one card on the wall that wears the
 * signal red, as a dark-red light in its top left and a faint red hairline. Structure, not colour,
 * still says what it is: its role line reads 个人分身.
 */
export const PERSONAL_SURFACE =
  "border-signal/25 before:bg-[radial-gradient(ellipse_at_8%_0,color-mix(in_oklab,var(--signal)_17%,transparent),transparent_75%)]";

/** The mono ordinal at a card's top left, e.g. `PROFILE / 01`. Wayfinding only, so not announced. */
export function CardIndex({ kind, index }: { kind: string; index: string }) {
  return (
    <span
      aria-hidden="true"
      className="shrink-0 whitespace-nowrap font-mono text-[9px] text-muted-foreground uppercase leading-[21px] tracking-[0.07em]"
      data-card-index=""
    >
      {kind} / {index}
    </span>
  );
}

/** Two digits, as the reference numbers its profiles. */
export const ordinal = (position: number) =>
  String(position + 1).padStart(2, "0");

/** A small tag on a card's top row (theme.css `.badge`): 已置顶 / 共享给你 / 已隐藏 / 待配置. */
export const CARD_TAG =
  "inline-flex h-[19px] shrink-0 items-center rounded-full border border-border px-[7px] font-medium text-[10px] text-muted-foreground leading-none whitespace-nowrap";

/** The 44px rounded-square frame a card's face sits in, with the reference's hairline and highlight. */
export const FACE_FRAME =
  "relative inline-flex size-[44px] shrink-0 items-center justify-center overflow-hidden rounded-[12px] border border-foreground/[0.13] bg-muted shadow-[inset_0_1px_0_rgb(255_255_255/0.07)]";

/** A card's footer: a hairline, then its two facts pushed to either end. */
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
        "mt-auto flex min-w-0 shrink-0 items-center justify-between gap-[5px] border-border border-t pt-[8px] text-[11px] text-muted-foreground tabular-nums",
        className,
      )}
      data-card-footer=""
    >
      <div className="flex min-w-0 items-center">{left}</div>
      <div className="flex min-w-0 items-center justify-end">{right}</div>
    </div>
  );
}

/** A footer fact: its label in grey, its value in the card's white, as the reference bolds them. */
export function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <>
      {label}{" "}
      <b className="ml-[3px] font-semibold text-foreground/90">{value}</b>
    </>
  );
}

/**
 * What a create card shows, laid out like a profile so it sits in the grid as one more card: a
 * `PROFILE / NEW` index, a dashed face with a red plus, the verb as the name and one line of what it
 * does.
 */
export function CreateCardFace({
  kind,
  label,
  hint,
}: {
  kind: string;
  label: string;
  hint: string;
}) {
  return (
    <>
      <span className="flex min-h-[21px] items-center">
        <CardIndex index="NEW" kind={kind} />
      </span>
      <span className="mt-[12px] flex min-w-0 items-center gap-[10px]">
        <span
          aria-hidden="true"
          className="inline-flex size-[44px] shrink-0 items-center justify-center rounded-[12px] border border-foreground/20 border-dashed text-signal transition-colors group-hover/card:border-foreground/35"
        >
          <IconPlus className="size-[20px]" stroke={1.8} />
        </span>
        <span className="min-w-0">
          <span className="block truncate font-bold text-[16px] text-foreground/90 leading-[22px] transition-colors group-hover/card:text-foreground">
            {label}
          </span>
          <span className="mt-px block truncate text-[12px] text-muted-foreground leading-[17px]">
            {hint}
          </span>
        </span>
      </span>
    </>
  );
}

/** The create card's own surface: dashed and without the light, so it reads as a slot, not a person. */
export const CREATE_CARD = cn(
  CARD_SURFACE,
  "border-dashed bg-transparent before:hidden outline-none hover:border-foreground/30 hover:bg-foreground/[0.02] focus-visible:ring-2 focus-visible:ring-ring/60",
);
