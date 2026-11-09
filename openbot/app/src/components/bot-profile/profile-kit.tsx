import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/*
 * The card language of an employee's own screens — its detail page, its assembly page, the role
 * templates and the team Bots — drawn to docs/design/ios-studio (theme.css `.panel`, `.section-head`;
 * the 「角色档案」 card of 04-员工管理.png): a 17px section title with its aside on the right, a quiet
 * 13px line under it, and the rows themselves in one graphite panel on a hairline, split by hairlines,
 * at a 14px radius with the reference's faint top highlight.
 *
 * Settings screens read rather than browse, so the rows stay dense and the panel carries no glow:
 * structure and spacing tell one group from the next, and red is left for what is selected or needs
 * the person.
 */

/** The graphite face every panel and card on these screens shares. */
export const PANEL_FACE =
  "rounded-[14px] border border-border bg-card shadow-[inset_0_1px_0_rgb(255_255_255/0.03)]";

/**
 * A titled group: a `<section>` named by its `<h2>`, so a screen reader can jump between them and a
 * test can ask for the section a heading names.
 */
export function ProfileSection({
  action,
  children,
  className,
  description,
  title,
  titleId,
}: {
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
  description?: ReactNode;
  title: string;
  titleId?: string;
}) {
  return (
    <section className={cn("min-w-0", className)}>
      <div className="flex min-h-[30px] flex-wrap items-center justify-between gap-x-[12px] gap-y-[6px]">
        <h2
          className="font-bold text-[17px] leading-[26px] tracking-[-0.02em]"
          id={titleId}
        >
          {title}
        </h2>
        {action ? (
          <div className="flex flex-wrap items-center gap-[7px]">{action}</div>
        ) : null}
      </div>
      {description ? (
        <p className="mt-[2px] max-w-[70ch] text-pretty text-[13px] text-muted-foreground leading-[1.6]">
          {description}
        </p>
      ) : null}
      {children}
    </section>
  );
}

/**
 * The rows of one group in one panel, a hairline between each. Rows are `Item`s (or anything else);
 * their own rounded corners are squared off so a hover fills the row edge to edge instead of floating
 * as a pill inside the panel.
 */
export function ProfilePanel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "mt-[10px] overflow-hidden [&>*+*]:border-t [&>*+*]:border-t-border!",
        PANEL_FACE,
        "[&>[data-slot=item]]:rounded-none [&>[data-slot=item]]:px-[14px] [&>[data-slot=item]]:py-[11px]",
        className,
      )}
      data-slot="profile-panel"
    >
      {children}
    </div>
  );
}

/** What a group says when it has nothing in it: one quiet sentence in a dashed slot. */
export function ProfileEmpty({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <p
      className={cn(
        "mt-[10px] rounded-[14px] border border-border border-dashed px-[14px] py-[13px] text-[13px] text-muted-foreground",
        className,
      )}
    >
      {children}
    </p>
  );
}

/** A failed read said in place of the group, never as its empty state. */
export function ProfileAlert({ children }: { children: ReactNode }) {
  return (
    <p
      className="mt-[10px] rounded-[14px] border border-destructive/30 bg-destructive/[0.06] px-[14px] py-[11px] text-[13px] text-destructive"
      role="alert"
    >
      {children}
    </p>
  );
}

/** A small round state tag (theme.css `.badge`), always with its word so no state is colour alone. */
export const PROFILE_TAG =
  "inline-flex h-[20px] shrink-0 items-center gap-[4px] rounded-full bg-foreground/[0.06] px-[8px] font-medium text-[11px] text-muted-foreground leading-none whitespace-nowrap";
