/**
 * What a command printed.
 *
 * Shown behind the chevron on the transcript line and in the pane beside the screen, so the two say
 * the same thing in the same shape. Monospace and pre-wrapped, because shell output is laid out in
 * columns and reflowing it makes `ls -l` unreadable.
 *
 * A command that printed nothing says so. Blank space under an expanded line reads as a component
 * that failed to render, and "it printed nothing" is a real and common answer.
 */
export function CommandOutput({
  output,
  exitCode,
  truncated,
  timedOut,
}: {
  output: string;
  /** Absent for a file read or a listing, which have no exit status. */
  exitCode?: number;
  /** The far side cut the output short. Said out loud rather than left to be inferred. */
  truncated?: boolean;
  /** The command ran too long and was stopped, so what is here is not the whole story. */
  timedOut?: boolean;
}) {
  const failed = typeof exitCode === "number" && exitCode !== 0;

  return (
    <div className="space-y-1.5">
      {truncated ? (
        <p className="text-muted-foreground text-xs">
          输出开头被截掉了，下面是它的结尾部分。
        </p>
      ) : null}
      {output ? (
        <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
          {output}
        </pre>
      ) : (
        <p className="text-muted-foreground text-xs italic">没有任何输出。</p>
      )}
      {timedOut ? (
        <p className="text-destructive text-xs">运行时间太长，已被停止。</p>
      ) : null}
      {failed ? (
        <p className="text-amber-600 text-xs dark:text-amber-500">
          退出码 {exitCode}。
        </p>
      ) : null}
    </div>
  );
}
