import type { Meter } from "@/lib/quota/queries";
import { cn } from "@/lib/utils";

/** From this share of the ceiling on, the bar and its words turn to the attention colour. */
const NEAR = 0.8;

/**
 * One row of the plans page's usage panel: the name, the count against the ceiling in words, and a
 * bar under it (docs/design/ios-studio: neutral grey, red only near or at the limit).
 *
 * The words are the reading; the bar is a second cue for the eye, so it is hidden from assistive
 * technology and a ceiling that does not exist ("不限") draws no bar at all rather than an empty one.
 */
export function UsageMeter({ label, value }: { label: string; value: Meter }) {
  const share =
    value.limit === null
      ? null
      : value.limit === 0
        ? value.used > 0
          ? 1
          : 0
        : Math.min(1, value.used / value.limit);
  const near = value.full || (share !== null && share >= NEAR);

  return (
    <div
      className="flex flex-col gap-[7px] px-4 py-[13px]"
      data-slot="usage-meter"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="font-medium text-[13px]">{label}</span>
        <span
          className={cn(
            "text-[12px] tabular-nums",
            near ? "text-signal-ink" : "text-muted-foreground",
          )}
        >
          已用 {value.used} / {value.limit === null ? "不限" : value.limit}
          {value.full ? " · 已到上限" : near ? " · 接近上限" : ""}
        </span>
      </div>
      {share === null ? null : (
        <div
          aria-hidden="true"
          className="h-[5px] overflow-hidden rounded-full bg-muted"
        >
          <div
            className={cn(
              "h-full rounded-full",
              near ? "bg-signal" : "bg-muted-foreground/70",
            )}
            style={{ width: `${Math.round(share * 100)}%` }}
          />
        </div>
      )}
    </div>
  );
}
