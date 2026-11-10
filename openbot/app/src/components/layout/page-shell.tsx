import { IconChevronLeft } from "@tabler/icons-react";
import { Link, type LinkProps } from "@tanstack/react-router";
import type * as React from "react";
import { cn } from "@/lib/utils";
import { Button } from "../ui/button";
import { PageHeader } from "./page-parts";
import { SidebarToggle, useSidebarToggleVisible } from "./sidebar-toggle";

/**
 * The frame every configuration screen sits in.
 *
 * WHAT THIS IS FIXING. Admin was nine pages that shared no layout: four container widths plus three
 * pages with no container at all, four heading sizes, four padding schemes, and a sidebar 20px wider
 * than the rest of the app. Three of those pages imported nothing from `components/ui` and drew
 * their own buttons, inputs and tables. The result did not read as a different screen, it read as a
 * different application — which is the impression an administrator forms at exactly the moment they
 * are deciding whether to trust it with credentials.
 *
 * The shape was never in doubt: Skills and Settings already had it. So this is that shape, extracted
 * once and used everywhere, INCLUDING by Skills and Settings. Leaving those two as hand-written
 * copies would mean three dialects rather than two, and the next screen somebody writes copies
 * whichever it happened to see first.
 */

/**
 * `prose` is the default because configuration is mostly reading. A measure of around 65 characters
 * is where prose stays comfortable, and a row of label-and-control has no business being wider than
 * the sentence explaining it.
 *
 * `wide` is for pages that are a table you scan, where forcing the prose column would wrap every
 * row. It is not a licence for anything else to be wide.
 *
 * `full` is upstream's frame for the audit log (`page-parts.tsx`): exactly the panel's height, never
 * scrolls, so the table inside can be the one thing that scrolls.
 */
type ShellWidth = "prose" | "wide" | "workbench" | "full";

/*
 * `workbench` is the five primary pages' frame (parity plan F1): full width and left-aligned,
 * 40 CSS px in from the sidebar's edge, where the reference's main column starts. Written in px
 * because this app's root font size is 15px and Tailwind's rem steps would land a few px short.
 */
const WIDTHS: Record<Exclude<ShellWidth, "full">, string> = {
  prose: "mx-auto max-w-2xl px-4",
  wide: "mx-auto max-w-5xl px-4",
  workbench: "mx-auto max-w-[1760px] px-4 sm:px-6 lg:px-[40px]",
};

export function PageShell({
  action,
  children,
  className,
  description,
  title,
  width = "prose",
  backButton,
}: {
  /** Sits on the title's baseline. For the page's one primary verb, if it has one. */
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  description?: React.ReactNode;
  title: string;
  width?: ShellWidth;
  backButton?: {
    linkProps: LinkProps;
    label: string;
  };
}) {
  /*
   * The bar carries the toggle and the Back link, and is drawn when it has at least one of them.
   * The screens with a Back link already drew exactly this bar, so for them nothing changes; what
   * changed is that a sidebar is now reason enough on its own, because the toggle has to sit at the
   * pane's left edge in both states and the prose column is centred — a control inside it would be
   * 400px from the edge it belongs to on a wide screen. Drawing it with neither would be a 56px
   * band holding nothing, which reads as a layout bug rather than as chrome.
   *
   * The question is whether the toggle will DRAW, not whether a sidebar exists: it hides itself on
   * a desktop-width window while the sidebar is already open, which is most of the time on these
   * screens. Asking `useSidebarToggleVisible` rather than re-deriving the condition here is what
   * keeps the two from drifting apart and reintroducing that empty band. It also still answers false
   * on `/assist` and `/link/slack`, which draw PageShell directly under `_authed` with no sidebar
   * provider at all, so there is nothing for a toggle to act on there.
   */
  const showToggle = useSidebarToggleVisible();
  const bar = showToggle || !!backButton;

  const barRow = bar ? (
    <div className="max-w-7xl w-full h-14 flex items-center gap-1 px-3">
      {showToggle ? <SidebarToggle /> : null}
      {!!backButton && (
        <Button
          variant="ghost"
          render={(props) => <Link {...backButton.linkProps} {...props} />}
        >
          <IconChevronLeft />
          {backButton.label}
        </Button>
      )}
    </div>
  ) : null;

  if (width === "full") {
    return (
      /*
       * Exactly the panel's height, never scrolls. `min-w-0` lets a table wider than the pane scroll
       * inside its own container instead of pushing the page sideways.
       */
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {barRow}
        <div className={cn("shrink-0 px-4", bar ? "pt-8" : "pt-12")}>
          <PageHeader title={title} action={action} description={description} />
        </div>
        <div className={cn("mt-6 flex min-h-0 flex-1 flex-col", className)}>
          {children}
        </div>
      </div>
    );
  }

  return (
    <>
      {barRow}
      {/*
       * The scroller, and it has to live here rather than in either shell, because the two shells
       * this frame is used under disagree about who scrolls.
       *
       * Under `_authed` — admin, settings — the document scrolls, so a page taller than the window
       * has always just worked. Under `_authed/_app` it does not: that shell is `h-svh
       * overflow-hidden` on purpose ("one viewport, never scrolls: panes scroll inside it") and its
       * `main` is `overflow-hidden` too, so a PageShell taller than the window was silently CLIPPED
       * — 246px of Skills sat below the fold with no way to reach it, by keyboard or otherwise.
       *
       * `min-h-0` is the load-bearing half of `min-h-0 flex-1`: a flex item's default `min-height:
       * auto` refuses to shrink below its content, so `flex-1` alone would grow this past the pane
       * and clip exactly as before. Under `_authed` both are inert — the parent is not a flex
       * container — and `overflow-y-auto` on an auto-height element shows no scrollbar, so those
       * eighteen screens are unaffected.
       *
       * Separate from the centred column below so the scrollbar rides the pane's edge instead of
       * appearing inside a 630px measure with content either side of it.
       */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div
          className={cn(
            "flex w-full flex-col",
            /*
             * The workbench pages carry the floating 小管家 button at the bottom centre; the extra
             * room lets the last row scroll clear of it instead of ending underneath.
             */
            width === "workbench" ? "pb-[112px]" : "pb-12",
            // Without a bar above it the heading keeps the full original space.
            width === "workbench" ? "pt-[46px]" : bar ? "pt-8" : "pt-12",
            WIDTHS[width],
            className,
          )}
        >
          {/* `page-header` and `page-title` are the hooks a skin reads the page's title from (skins/). */}
          <header
            className={cn(
              "flex flex-col",
              width === "workbench" ? "gap-[5px]" : "gap-2",
            )}
            data-slot="page-header"
          >
            <div
              className={cn(
                "flex flex-row items-center justify-between gap-4",
                // On a phone the action drops below the title rather than squeezing it to a column.
                width === "workbench" && "flex-wrap gap-y-3",
              )}
            >
              <h1
                className={
                  width === "workbench"
                    ? "max-w-full shrink-0 font-semibold text-[28px] leading-[32px] tracking-tight"
                    : "font-bold text-2xl"
                }
                data-slot="page-title"
              >
                {title}
              </h1>
              {action}
            </div>
            {description ? (
              <p
                className={cn(
                  "max-w-prose text-pretty text-muted-foreground leading-relaxed",
                  width === "workbench" ? "text-[14px]" : "text-sm",
                )}
              >
                {description}
              </p>
            ) : null}
          </header>
          {children}
        </div>
      </div>
    </>
  );
}

export { PageCard, PageEmpty, PageRows, PageSection } from "./page-parts";
