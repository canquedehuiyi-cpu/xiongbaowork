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
 *
 * Two facts the result carries sit on the line beside it, when the result carried them: how long the
 * step took, and why a failed one failed (its exit code, or the one sentence it came back with). Both
 * are words, both give way to the label before the label wraps, and neither is invented for a step
 * that reports nothing.
 */
/** A label this short stays on one line: "Asked you", "Searched the web", "Fetch". */
const SHORT_LABEL = 32;

/** 失败的原因抄到行上时给它的宽度：字符数，省略号算在内。 */
const FAILURE_LIMIT = 40;

/**
 * 失败那一步在行上怎么说：有退出码就报退出码，因为它是有数字的事实；没有数字才用结果给的那句话，
 * 报的是结果里写的那一句，不是这里编的。两个都没有就什么都没说，行上只剩原来那句「…，没有成功」。
 *
 * 那一句话说得长时截到 `FAILURE_LIMIT`：整段 stderr 铺在行上会把这一行挤没，要读全文的人本来就点得开
 * 这一步。截的是抄给行上的那一份，结果本身没动。
 *
 * 成功、进行中、被拦下的步骤不走这里：还没结束的调用没有退出码，说一个就是编。
 */
export function failureWords(
  failed: boolean,
  exitCode: number | undefined,
  failure: string | undefined,
): string {
  if (!failed) return "";
  if (exitCode !== undefined) return `退出码 ${exitCode}`;
  const reason = failure?.trim();
  if (!reason) return "";
  return reason.length > FAILURE_LIMIT
    ? `${reason.slice(0, FAILURE_LIMIT - 1)}…`
    : reason;
}

/**
 * How long a step took, said the way a person reads a duration on a line: seconds with one decimal.
 *
 * Only what the measurement says, never a rounded-up minute: a step timed in milliseconds has no
 * minutes in it unless it really ran a minute or more, and past that the decimal is noise. Nothing is
 * said for a value that never arrived, a negative one or a non-finite one — `0.0s` is drawn only for
 * a measurement of zero, which is a step the clock could not separate from its own start.
 */
export function elapsedWords(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "";
  if (ms >= 60_000) return `${Math.round(ms / 1000)}s`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function ToolLine({
  icon,
  label,
  attempted,
  detail,
  link,
  elapsed,
  exitCode,
  failure,
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
   * 被拦截或被拒绝时用的说法，未完成式：「执行命令」，不是「执行了命令」。`label` 多是完成式，
   * 拼成「已拦截：执行了命令」就成了命令已经执行了，与事实相反。不给就用 `label`。
   */
  attempted?: string;
  /** What it was done to. Muted, and truncated rather than wrapped. */
  detail?: string;
  /**
   * A download address for `detail`, when what it was done to is a file the person can have.
   *
   * Without it the detail stays the plain muted span it always was. With it the same words are drawn
   * by an anchor — same classes, so the line is as wide and truncates the same way — carrying the
   * address, `download`, and `rel="noopener"`. The safety decision behind `download` is A4: what comes
   * back is an attachment, never a page rendered on this origin.
   */
  link?: string;
  /**
   * 这一步跑了多久，毫秒。结果里带了才写（`elapsedWords`），没带就一个字也不写——写一个没量出来的
   * `0.0s` 比不写更糟：读的人以为这是个真的读数。
   */
  elapsed?: number;
  /**
   * 失败那一步的退出码。有数字就报数字，形状和命令卡片上的同一处一样（`退出码 N`）。
   * 只在 `failed` 时上屏：还没结束的调用没有退出码，说一个就是编。
   */
  exitCode?: number;
  /**
   * 失败那一步的原因，来自结果本身（设备或服务器给的一句话）。没有退出码可报时才用它；
   * 两个都没有，行上就只有原来那句「…，没有成功」。说得长时由 `failureWords` 截到行放得下的宽度。
   */
  failure?: string;
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
    ? "text-signal-ink"
    : failed
      ? "text-amber-600 dark:text-amber-500"
      : running
        ? "text-foreground/85"
        : "text-muted-foreground";

  /*
   * The state in an icon as well as a word: refused, failed and running always show theirs; a line
   * that finished shows the kinds a group passed in, or a quiet check.
   */
  const shownIcon = refused ? (
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
    (icon ?? (
      <IconCheck aria-hidden className="size-[14px] shrink-0 text-faint" />
    ))
  );

  /*
   * 有地址时，detail 这几个字就是那个文件本身：一样缩略、一样占位，只是点得动（`download` 背后是
   * 安全决策 A4——回来的是附件，不是这个源上的一页）。没有地址时，这行和以前一个字都不差。
   */
  const detailNode = detail ? (
    link === undefined ? (
      <span className="min-w-0 shrink-[100] truncate opacity-70">{detail}</span>
    ) : (
      <a
        className="min-w-0 shrink-[100] truncate opacity-70 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        data-tool-download=""
        // 空值是「就按服务器给的名字存」：这个属性带的值会被当成文件名，写成 `download` 在 JSX 里等于
        // `true`，存下来就成了一个叫 true 的文件。名字归路由的 Content-Disposition 定（安全决策 A4）。
        download=""
        href={link}
        rel="noopener"
      >
        {detail}
      </a>
    )
  ) : null;

  /*
   * 耗时和失败的原因都接在「对什么做的」后面：这一行多的两个事实，不是第三句话。两个都没有，这一行
   * 和以前一个字都不差。退出码优先，因为它是有数字的事实；原因只在没有数字时报，报的是结果给的那句，
   * 不是这里编的。
   */
  const spent = elapsedWords(elapsed);
  const why = failureWords(failed ?? false, exitCode, failure);

  const text = (
    <span
      className={`inline-flex min-w-0 max-w-full items-baseline gap-1.5 text-sm ${tone} ${
        running ? "tool-line-running" : ""
      }`}
    >
      <span className="shrink-0 self-center">{shownIcon}</span>
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
        {/* 拦下的是哪一步也写出来，不只一个「已拦截」。 */}
        {refused
          ? `${declined ? "已拒绝" : "已拦截"}：${attempted ?? label}`
          : failed
            ? `${label}，没有成功`
            : notYet
              ? `${label}，还没做`
              : byYou
                ? `${label}，由你完成`
                : label}
      </span>
      {detailNode}
      {spent ? (
        <span className="shrink-0 tabular-nums opacity-70">{spent}</span>
      ) : null}
      {why ? (
        <span className="min-w-0 shrink-[100] truncate opacity-70">{why}</span>
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
      <div
        className={`mt-2 ml-[6px] border-border border-l pl-3 text-muted-foreground text-xs leading-relaxed ${bare ? "" : "max-h-80 overflow-auto"} [&_h1]:text-sm [&_h2]:text-xs [&_h3]:text-xs [&_h4]:text-xs [&_h1]:font-medium [&_h2]:font-medium [&_h3]:font-medium`}
      >
        {children}
      </div>
    </details>
  );
}
