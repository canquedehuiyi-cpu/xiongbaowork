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
  variant = "pill",
  panelId,
}: {
  tabs: readonly SegmentedTab<T>[];
  value: T;
  /**
   * `keyboard` is true for Left/Right/Home/End: moving across tabs with the arrows should replace
   * the current history entry rather than push one per keystroke, so Back leaves the page instead
   * of stepping back through every tab passed over.
   */
  onValueChange: (value: T, change: { keyboard: boolean }) => void;
  /** The accessible name of the tab list. */
  label: string;
  className?: string;
  size?: "default" | "sm";
  /**
   * `pill` is the boxed switch docs/design/ios-studio uses for every two- or three-way choice (员工 /
   * 群组, 需要操作 / 查收结果, 插件市场 / 我的插件, 列表 / 泳道); `underline` is a plain text tab with
   * a bar under the selected one, kept for screens that sit tabs over a long document.
   */
  variant?: "pill" | "underline";
  /**
   * The id of the panel the tabs switch (render it with `tabPanelProps`): every tab then names it in
   * `aria-controls`, and the panel is labelled by the selected tab.
   */
  panelId?: string;
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
    onValueChange(tab.value, { keyboard: true });
    refs.current.get(tab.value)?.focus();
  };

  return (
    <div
      aria-label={label}
      className={cn(
        variant === "underline"
          ? "flex items-end gap-6 border-border border-b"
          : "inline-flex items-center gap-[2px] rounded-[10px] border border-border bg-muted p-[3px] dark:bg-sidebar",
        className,
      )}
      data-variant={variant}
      role="tablist"
    >
      {tabs.map((tab, index) => {
        const selected = tab.value === value;
        return (
          <button
            aria-selected={selected}
            className={cn(
              "inline-flex items-center justify-center gap-1.5 font-medium whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60",
              variant === "underline"
                ? cn(
                    "-mb-px border-b-2 px-1",
                    size === "sm"
                      ? "h-[32px] text-[12px]"
                      : "h-[36px] text-[14px]",
                    selected
                      ? "border-foreground text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground",
                  )
                : cn(
                    // The reference's segment: a 7px-radius plate, raised with a hairline highlight.
                    "rounded-[7px] px-[11px]",
                    size === "sm"
                      ? "h-[24px] text-[12px]"
                      : "h-[26px] text-[12px]",
                    selected
                      ? "bg-card text-foreground shadow-[0_1px_2px_rgb(0_0_0/0.08)] dark:bg-accent dark:shadow-[inset_0_1px_0_rgb(255_255_255/0.07)]"
                      : "text-muted-foreground hover:text-foreground",
                  ),
            )}
            key={tab.value}
            aria-controls={panelId}
            id={panelId ? tabId(panelId, tab.value) : undefined}
            onClick={() => onValueChange(tab.value, { keyboard: false })}
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

function tabId(panelId: string, value: string): string {
  return `${panelId}-tab-${value}`;
}

/** Props for the panel a `SegmentedTabs` with `panelId` switches: labelled by the selected tab. */
export function tabPanelProps(panelId: string, selected: string) {
  return {
    "aria-labelledby": tabId(panelId, selected),
    id: panelId,
    role: "tabpanel" as const,
  };
}
