import { type KeyboardEvent, type ReactNode, useRef } from "react";
import { cn } from "@/lib/utils";

export type SegmentedTab<T extends string> = {
  value: T;
  label: ReactNode;
  /** A count drawn after the label, e.g. how many rows the tab holds. */
  count?: number;
};

/**
 * A row of mutually exclusive views over one list: 员工 / 群组, 插件市场 / 我的插件, 列表 / 泳道.
 *
 * One primitive rather than a hand-rolled button row on every screen, so the workbench pages share
 * one height (32 CSS px, the reference product's toolbar control), one selected look and one
 * keyboard model: the tabs are a single stop in the tab order, and Left/Right/Home/End move the
 * selection the way the WAI-ARIA tabs pattern describes. The caller owns the state, so a tab can be
 * mirrored into the URL (`?tab=groups`) and survive a reload or a shared link.
 */
export function SegmentedTabs<T extends string>({
  tabs,
  value,
  onValueChange,
  label,
  className,
  size = "default",
}: {
  tabs: readonly SegmentedTab<T>[];
  value: T;
  onValueChange: (value: T) => void;
  /** The accessible name of the tab list. */
  label: string;
  className?: string;
  size?: "default" | "sm";
}) {
  const refs = useRef(new Map<T, HTMLButtonElement>());

  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = tabs.length - 1;
    const next =
      event.key === "ArrowRight"
        ? index === last
          ? 0
          : index + 1
        : event.key === "ArrowLeft"
          ? index === 0
            ? last
            : index - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null;
    if (next === null) return;
    event.preventDefault();
    const tab = tabs[next];
    if (!tab) return;
    onValueChange(tab.value);
    refs.current.get(tab.value)?.focus();
  };

  return (
    <div
      aria-label={label}
      className={cn(
        "inline-flex items-center gap-0.5 rounded-lg bg-foreground/[0.04] p-0.5",
        className,
      )}
      role="tablist"
    >
      {tabs.map((tab, index) => {
        const selected = tab.value === value;
        return (
          <button
            aria-selected={selected}
            className={cn(
              "inline-flex items-center justify-center gap-1.5 rounded-md px-3 font-medium whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60",
              size === "sm" ? "h-[26px] text-[12px]" : "h-[28px] text-[13px]",
              selected
                ? "bg-background text-foreground shadow-xs dark:bg-foreground/10"
                : "text-muted-foreground hover:text-foreground",
            )}
            key={tab.value}
            onClick={() => onValueChange(tab.value)}
            onKeyDown={(event) => move(event, index)}
            ref={(node) => {
              if (node) refs.current.set(tab.value, node);
              else refs.current.delete(tab.value);
            }}
            role="tab"
            tabIndex={selected ? 0 : -1}
            type="button"
          >
            {tab.label}
            {tab.count === undefined ? null : (
              <span className="text-muted-foreground tabular-nums">
                {tab.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
