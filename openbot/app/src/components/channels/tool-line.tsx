import {
  IconAlertTriangle,
  IconBan,
  IconCheck,
  IconChevronRight,
  IconLoader2,
} from "@tabler/icons-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * One line for one thing a Bot did.
 *
 * Every tool call in the transcript draws through this, so a browser action, an MCP call and a
 * refusal read as the same kind of event. Detail stays behind a disclosure so the transcript keeps a
 * single-line action rhythm.
 *
 * Drawn as a compact execution chip (docs/design/ios-studio: graphite, hairline border, the state in
 * an icon AND a word, never in colour alone): a spinner (and 「进行中」 for a screen reader) while it
 * runs — the text still shimmers, which is the signal that the Bot is working on something with nothing to show yet — a
 * check once it has finished, a stop sign for a refusal, a warning for a failure.
 */
export function ToolLine({
  label,
  detail,
  running,
  refused,
  failed,
  children,
}: {
  /** What was done, in a couple of words: "Searched Slack", "Filled in", "Read the page". */
  label: string;
  /** What it was done to. Muted, and truncated rather than wrapped. */
  detail?: string;
  running?: boolean;
  /** A policy or a boundary said no. Final: nothing the Bot does differently will help. */
  refused?: boolean;
  /** It was permitted and did not work. A different request might. */
  failed?: boolean;
  /** Shown when the line is expanded. Without it the line is not expandable. */
  children?: ReactNode;
}) {
  const tone = refused
    ? "text-signal-ink"
    : failed
      ? "text-amber-600 dark:text-amber-500"
      : running
        ? "text-foreground/85"
        : "text-muted-foreground";

  const icon = refused ? (
    <IconBan aria-hidden className="size-[14px] shrink-0 text-signal" />
  ) : failed ? (
    <IconAlertTriangle
      aria-hidden
      className="size-[14px] shrink-0 text-amber-600 dark:text-amber-500"
    />
  ) : running ? (
    <IconLoader2
      aria-hidden
      className="size-[14px] shrink-0 text-muted-foreground motion-safe:animate-spin"
    />
  ) : (
    <IconCheck aria-hidden className="size-[14px] shrink-0 text-faint" />
  );

  const text = (
    <span className="inline-flex min-w-0 max-w-full items-center gap-[7px] text-[13px]">
      {icon}
      <span
        className={cn("shrink-0", tone, running ? "tool-line-running" : "")}
      >
        {refused ? "已拦截" : failed ? `${label}，没有成功` : label}
      </span>
      {detail ? (
        <span className="min-w-0 truncate text-faint">{detail}</span>
      ) : null}
      {running ? <span className="sr-only">进行中</span> : null}
    </span>
  );

  /*
   * The chip: a hairline-bordered graphite row as wide as its words, so a run of actions reads as a
   * column of small events between the Bot's prose rather than as more prose.
   */
  const chip =
    "inline-flex min-w-0 max-w-full items-center gap-[7px] rounded-[10px] border border-border bg-card px-[10px] py-[5px] shadow-[inset_0_1px_0_rgb(255_255_255/0.03)]";

  if (!children)
    return (
      <div className="my-1.5 flex min-w-0">
        <div className={chip}>{text}</div>
      </div>
    );

  return (
    <details className="tool-line group/tool my-1.5 min-w-0">
      {/*
       * Native <details> owns expansion because SDK tool renderers can be re-invoked independently
       * of this component's React state.
       */}
      <summary
        className={cn(
          chip,
          "cursor-pointer list-none outline-none hover:border-foreground/15 focus-visible:ring-2 focus-visible:ring-ring/60 [&::-webkit-details-marker]:hidden",
        )}
      >
        {text}
        <IconChevronRight
          aria-hidden
          className="tool-line-chevron size-[13px] shrink-0 text-faint transition-transform motion-reduce:transition-none"
        />
      </summary>
      {/*
       * Headings are cut down to the size of the surrounding text. A tool result is markdown a
       * server wrote for a model, so its `#` is a section marker rather than a page title.
       */}
      <div className="mt-2 ml-[6px] max-h-80 overflow-auto border-border border-l pl-3 text-muted-foreground text-xs leading-relaxed [&_h1]:font-medium [&_h1]:text-sm [&_h2]:font-medium [&_h2]:text-xs [&_h3]:font-medium [&_h3]:text-xs [&_h4]:text-xs">
        {children}
      </div>
    </details>
  );
}
