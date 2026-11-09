import type { ReactNode } from "react";

/**
 * One line for one thing a Bot did.
 *
 * Every tool call in the transcript draws through this, so a browser action, an MCP call and a
 * refusal read as the same kind of event. Detail stays behind a disclosure so the transcript keeps a
 * single-line action rhythm.
 *
 * While it is still running the text shimmers, which is the only signal that the Bot is working on
 * something with nothing to show yet.
 */
/** A label this short stays on one line: "Asked you", "Searched the web", "Fetch". */
const SHORT_LABEL = 32;

export function ToolLine({
  icon,
  label,
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
  blockedLabel,
=======
  attempted,
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
  detail,
  running,
  refused,
  declined,
  failed,
  notYet,
  byYou,
  bare,
  children,
}: {
  /** Drawn before the label, small and muted. A group of steps puts its kinds here. */
  icon?: ReactNode;
  /** What was done, in a couple of words: "Searched Slack", "Filled in", "Read the page". */
  label: string;
  /**
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
   * 被拦截或被拒绝时用的说法，未完成式：「执行命令」，不是「执行了命令」。`label` 多是完成式，
   * 拼成「已拦截：执行了命令」就成了命令已经执行了，与事实相反。不给就用 `label`。
   */
  blockedLabel?: string;
=======
   * What was tried, for a step that was refused: "Save file", not "Saved file". A refused step did
   * not happen, so its line says what was attempted. Without it the label is used.
   */
  attempted?: string;
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
  /** What it was done to. Muted, and truncated rather than wrapped. */
  detail?: string;
  running?: boolean;
  /** A policy or a boundary said no. Final: nothing the Bot does differently will help. */
  refused?: boolean;
  /** 和 `refused` 一起用：说「不」的是主人自己（在对话卡片上拒绝了），不是策略或边界。 */
  declined?: boolean;
  /** It was permitted and did not work. A different request might. */
  failed?: boolean;
  /**
   * Nothing was done yet, for an ordinary reason: a computer still starting turned the call away
   * before it reached anything. Muted like a success, because nothing went wrong, and labelled so it
   * does not read as one.
   */
  notYet?: boolean;
  /**
   * The step was handed to the person and they did it themselves. Muted like a success, because it
   * was done, and labelled so it does not read as the Bot having done it.
   */
  byYou?: boolean;
  /** Shown when the line is expanded. Without it the line is not expandable. */
  children?: ReactNode;
  /**
   * The expanded part grows with what it holds instead of scrolling, for children that bound
   * themselves: a group's list of steps, each of which folds its own result. One scrolling box
   * inside another left two scrollbars side by side.
   */
  bare?: boolean;
}) {
  const tone = refused
    ? "text-destructive"
    : failed
      ? "text-amber-600 dark:text-amber-500"
      : "text-muted-foreground";

  const text = (
    <span
      className={`inline-flex min-w-0 max-w-full items-baseline gap-1.5 text-sm ${tone} ${
        running ? "tool-line-running" : ""
      }`}
    >
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
      <span className="shrink-0">
        {/* 拦下的是哪一步也写出来，不只一个「已拦截」。 */}
        {refused
          ? `${declined ? "已拒绝" : "已拦截"}：${blockedLabel ?? label}`
          : failed
            ? `${label}，没有成功`
            : label}
=======
      {icon ? <span className="shrink-0 self-center">{icon}</span> : null}
      {/*
       * Free to shrink, so a long label (a folded run's "Read 1 file, searched for 2 patterns and
       * listed 1 directory") wraps in a phone-width column instead of running past it. The detail
       * shrinks a hundred times faster, but even a hundred times faster still took a few pixels from
       * the label, enough to break "Asked you" over two lines beside a long question. So a label of a
       * few words never shrinks at all, and only a long one is left free to wrap.
       */}
      <span
        className={
          label.length <= SHORT_LABEL ? "shrink-0 whitespace-nowrap" : "min-w-0"
        }
      >
        {refused
          ? `Blocked: ${attempted ?? label}`
          : failed
            ? `${label}, didn't work`
            : notYet
              ? `${label}, not done yet`
              : byYou
                ? `${label}, done by you`
                : label}
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
      </span>
      {detail ? (
        <span className="min-w-0 shrink-[100] truncate opacity-70">
          {detail}
        </span>
      ) : null}
    </span>
  );

  if (!children) return <div className="my-1.5">{text}</div>;

  return (
    <details className="tool-line my-1.5 min-w-0">
      {/*
       * Native <details> owns expansion because SDK tool renderers can be re-invoked independently
       * of this component's React state.
       */}
      <summary className="flex cursor-pointer list-none items-baseline gap-1.5">
        <span
          aria-hidden
          className="tool-line-chevron shrink-0 text-xs text-muted-foreground transition-transform"
        >
          ▸
        </span>
        {text}
      </summary>
      {/*
       * Headings are cut down to the size of the surrounding text. A tool result is markdown a
       * server wrote for a model, so its `#` is a section marker rather than a page title.
       */}
      <div
        className={`mt-2 border-l pl-3 text-xs ${bare ? "" : "max-h-80 overflow-auto"} [&_h1]:text-sm [&_h2]:text-xs [&_h3]:text-xs [&_h4]:text-xs [&_h1]:font-medium [&_h2]:font-medium [&_h3]:font-medium`}
      >
        {children}
      </div>
    </details>
  );
}
