import type * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Small pieces the admin console, settings, plans and platform pages share
 * (docs/design/ios-studio: graphite panel, hairline border, 13–18px corners, a faint inner highlight;
 * red only for what needs attention).
 *
 * Kept here rather than in `components/ui` because they are page furniture for these screens, not
 * primitives: a table is wrapped once so every log and ledger on these pages scrolls sideways inside
 * its own rounded panel on a phone instead of pushing the page wider than the window.
 */

/** The rounded panel a table lives in; scrolls sideways inside itself when the window is narrow. */
export function TablePanel({
  children,
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "mt-4 overflow-x-auto rounded-[14px] border border-border bg-card shadow-[inset_0_1px_0_rgb(255_255_255/0.03)]",
        /*
         * One table vocabulary: a quiet header band, hairlines between rows, cells padded the same
         * on every page. Written against the table elements so the pages keep plain <table> markup
         * (and the roles their tests and screen readers rely on).
         */
        "[&_table]:w-full [&_table]:text-left [&_table]:text-[13px]",
        "[&_thead]:bg-muted/40 [&_th]:whitespace-nowrap [&_th]:px-4 [&_th]:py-[9px] [&_th]:font-medium [&_th]:text-[11px] [&_th]:text-muted-foreground [&_th]:tracking-[0.04em]",
        "[&_td]:px-4 [&_td]:py-[10px] [&_tbody_tr]:border-border [&_tbody_tr]:border-t",
        className,
      )}
      data-slot="table-panel"
      {...props}
    >
      {children}
    </div>
  );
}

export type StatusTone = "neutral" | "positive" | "attention" | "muted";

/**
 * A state in words, with a dot that repeats it in colour. The words carry the meaning; the dot is
 * only a second cue, so the state survives without colour.
 */
export function StatusBadge({
  children,
  className,
  tone = "neutral",
}: {
  children: React.ReactNode;
  className?: string;
  tone?: StatusTone;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-[22px] shrink-0 items-center gap-[6px] whitespace-nowrap rounded-full border px-[9px] font-medium text-[11px] leading-none",
        tone === "attention"
          ? "border-signal/30 bg-signal-soft text-signal-ink"
          : tone === "positive"
            ? "border-border bg-muted text-foreground"
            : tone === "muted"
              ? "border-border bg-transparent text-muted-foreground"
              : "border-border bg-muted text-muted-foreground",
        className,
      )}
      data-slot="status-badge"
      data-tone={tone}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-[6px] rounded-full",
          tone === "attention"
            ? "bg-signal"
            : tone === "positive"
              ? "bg-emerald-500"
              : tone === "muted"
                ? "bg-faint/60"
                : "bg-muted-foreground",
        )}
      />
      {children}
    </span>
  );
}
