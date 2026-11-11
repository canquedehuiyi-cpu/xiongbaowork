import {
  IconChevronLeft,
  IconChevronRight,
  IconLink,
} from "@tabler/icons-react";
import { Link, type LinkProps, useRouterState } from "@tanstack/react-router";
import { Component, type ReactNode } from "react";
import type * as React from "react";
import { cn } from "@/lib/utils";
import { ButlerButton } from "../app-sidebar/butler-button";
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
 * `workbench` is the primary pages' frame (docs/design/ios-studio): full width, with a gutter that
 * grows from 13px on a phone to 47px on a wide screen, as the reference's `--gutter` does. Written in
 * px because this app's root font size is 15px and Tailwind's rem steps would land a few px short.
 */
const GUTTER = "px-[13px] md:px-[clamp(21px,3vw,47px)]";
const WIDTHS: Record<Exclude<ShellWidth, "full">, string> = {
  prose: "mx-auto max-w-2xl px-4",
  wide: "mx-auto max-w-5xl px-4",
  workbench: `w-full max-w-[1750px] ${GUTTER}`,
};

export function PageShell({
  action,
  art,
  children,
  className,
  crumb,
  description,
  eyebrow,
  title,
  width = "prose",
  backButton,
}: {
  /** Sits on the title's baseline. For the page's one primary verb, if it has one. */
  action?: React.ReactNode;
  /**
   * A workbench page's illustration, drawn behind the right of the heading (the @Waker chat card,
   * the autonomous signal path). Decorative: hidden on narrow screens, and the heading, text and
   * actions are complete without it.
   */
  art?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  /**
   * The page's name in the workbench breadcrumb bar, when the heading is a sentence rather than the
   * name (@Waker's two-line headline). Defaults to `title`.
   */
  crumb?: string;
  description?: React.ReactNode;
  /**
   * The small line above a workbench title, e.g. `01 WORK RECORD`: a red dash, the index in white and
   * the rest in grey mono capitals. Decorative wayfinding; the title is the page's name.
   */
  eyebrow?: string;
  title: string;
  width?: ShellWidth;
  backButton?: {
    linkProps: LinkProps;
    label: string;
  };
}) {
  // Asked before any early return, so the hooks run in the same order on every render.
  const showToggle = useSidebarToggleVisible();
  if (width === "workbench") {
    return (
      <WorkbenchShell
        action={action}
        art={art}
        backButton={backButton}
        className={className}
        crumb={crumb ?? title}
        description={description}
        eyebrow={eyebrow}
        title={title}
      >
        {children}
      </WorkbenchShell>
    );
  }
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
            "pb-12",
            // Without a bar above it the heading keeps the full original space.
            bar ? "pt-8" : "pt-12",
            WIDTHS[width],
            className,
          )}
        >
          {/* `page-header` and `page-title` are the hooks a skin reads the page's title from (skins/). */}
          <header className="flex flex-col gap-2" data-slot="page-header">
            <div className="flex flex-row items-center justify-between gap-4">
              <h1
                className="font-bold text-2xl tracking-tight"
                data-slot="page-title"
              >
                {title}
              </h1>
              {action}
            </div>
            {description ? (
              <p className="max-w-prose text-pretty text-muted-foreground text-sm leading-relaxed">
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

/** `01 WORK RECORD` → a red dash, `01` in the text colour, the rest in spaced grey mono. */
export function Eyebrow({ text }: { text: string }) {
  const [index, ...rest] = text.split(" ");
  return (
    <p
      className="flex items-center gap-[8px] font-mono text-[10px] text-muted-foreground uppercase leading-[14px] tracking-[0.14em]"
      data-slot="eyebrow"
    >
      <span
        aria-hidden="true"
        className="h-[2px] w-[12px] rounded-[2px] bg-signal"
      />
      <span className="text-foreground/90">{index}</span>
      {rest.length > 0 ? <span>{rest.join(" ")}</span> : null}
    </p>
  );
}

/*
 * The breadcrumb bar above a workbench page (docs/design/ios-studio `.toolbar`): 61px, a hairline
 * under it, 「工作台 › 页面」 on the left and the 熊宝小管家 dock on the right. It also carries the
 * sidebar toggle and a page's Back link, which used to sit in a bar of their own.
 */
function WorkbenchBar({
  title,
  backButton,
}: {
  title: string;
  backButton?: { linkProps: LinkProps; label: string };
}) {
  const showToggle = useSidebarToggleVisible();
  return (
    <div
      className={cn(
        "flex h-[45px] shrink-0 items-center justify-between gap-[10px] border-border border-b md:h-[61px]",
        GUTTER,
      )}
      data-slot="workbench-bar"
    >
      <nav
        aria-label="当前位置"
        className="flex min-w-0 items-center gap-[10px] text-[12px] text-muted-foreground"
      >
        {showToggle ? <SidebarToggle /> : null}
        {backButton ? (
          <Link
            {...backButton.linkProps}
            className="inline-flex shrink-0 items-center gap-[6px] rounded-[7px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <IconChevronLeft aria-hidden="true" className="size-[15px]" />
            {backButton.label}
          </Link>
        ) : (
          <>
            <IconLink aria-hidden="true" className="size-[15px] shrink-0" />
            <OutsideRouter fallback={<span className="shrink-0">工作台</span>}>
              <RootCrumb />
            </OutsideRouter>
          </>
        )}
        <IconChevronRight aria-hidden="true" className="size-[13px] shrink-0" />
        <span
          aria-current="page"
          className="truncate font-medium text-foreground"
        >
          {title}
        </span>
      </nav>
      <OutsideRouter fallback={null}>
        <ButlerButton />
      </OutsideRouter>
    </div>
  );
}

/**
 * The bar's router-aware parts, with a plain fallback for a frame drawn outside a router (an isolated
 * preview or a component test), where there is no place to name and nothing to link to. The router's
 * hooks throw there rather than answer, so the question is asked by catching.
 */
class OutsideRouter extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** 「工作台」 for the app's pages, 「设置」 for the settings pages that share this frame. */
function RootCrumb() {
  const inSettings = useRouterState({
    select: (state) => state.location.pathname.startsWith("/settings"),
  });
  return <span className="shrink-0">{inSettings ? "设置" : "工作台"}</span>;
}

function WorkbenchShell({
  action,
  art,
  backButton,
  children,
  className,
  crumb,
  description,
  eyebrow,
  title,
}: {
  action?: React.ReactNode;
  art?: React.ReactNode;
  backButton?: { linkProps: LinkProps; label: string };
  children: React.ReactNode;
  className?: string;
  crumb: string;
  description?: React.ReactNode;
  eyebrow?: string;
  title: string;
}) {
  return (
    <>
      <WorkbenchBar backButton={backButton} title={crumb} />
      {/* The scroller: see the note in PageShell on why it lives in the frame, not the shell. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div
          className={cn("flex flex-col pb-[56px]", WIDTHS.workbench, className)}
        >
          <header
            className={cn(
              /*
               * The open heading: no box, the title large and tight, the line under it quiet, and
               * the page's verbs at the bottom right. 164px tall on a desktop, the eyebrow 25px
               * under the bar, as the reference measures it.
               */
              "relative isolate flex flex-wrap items-end justify-between gap-x-[18px] gap-y-3 pt-[20px] pb-[16px] md:pt-[25px] md:pb-[23px]",
              // The 164px open heading is the core pages'; a compact one only takes the room it needs.
              eyebrow ? "md:min-h-[164px]" : null,
              art ? "md:min-h-[206px] md:items-center" : null,
            )}
            data-slot="page-header"
          >
            {art ? (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-0 right-0 -z-10 hidden w-[53%] md:block"
                data-slot="page-art"
              >
                {art}
              </div>
            ) : null}
            <div className="relative z-[1] min-w-0 max-w-full">
              {eyebrow ? <Eyebrow text={eyebrow} /> : null}
              {/*
               * The large open title is the five workbench pages' (they carry an eyebrow). Settings
               * and other pages in this frame keep a compact one: reading and density come first there.
               */}
              <h1
                className={cn(
                  "max-w-full font-bold",
                  eyebrow
                    ? "mt-[11px] mb-[10px] text-[clamp(35px,4.5vw,55px)] leading-[1.06] tracking-[-0.05em]"
                    : "mb-[6px] text-[28px] leading-[1.2] tracking-[-0.03em]",
                )}
                data-slot="page-title"
              >
                {title}
              </h1>
              {description ? (
                <p className="max-w-[60ch] text-pretty text-[13px] text-muted-foreground leading-[1.6] tracking-[0.02em]">
                  {description}
                </p>
              ) : null}
            </div>
            {action ? (
              <div className="relative z-[1] flex flex-wrap items-center gap-[7px]">
                {action}
              </div>
            ) : null}
          </header>
          {children}
        </div>
      </div>
    </>
  );
}

export { PageCard, PageEmpty, PageRows, PageSection } from "./page-parts";
