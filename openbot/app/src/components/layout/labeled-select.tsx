import { IconChevronDown } from "@tabler/icons-react";
import { cn } from "@/lib/utils";

export type LabeledSelectOption<T extends string> = { value: T; label: string };

/**
 * A workbench filter: a 32px box that names itself in grey before its value — 「运行状态 在线 ▾」
 * — as the reference screenshots draw every toolbar filter (docs/acceptance/qoderwake-reference/).
 *
 * A native <select> underneath, so keyboard, screen readers and mobile pickers work for free; its
 * accessible name is the visible label.
 */
export function LabeledSelect<T extends string>({
  label,
  value,
  options,
  onValueChange,
  className,
  disabled,
}: {
  label: string;
  value: T;
  options: readonly LabeledSelectOption<T>[];
  onValueChange: (value: T) => void;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <label
      className={cn(
        "relative inline-flex h-[32px] min-w-0 items-center gap-2 rounded-[9px] border border-border bg-muted pr-7 pl-[11px] text-[12px] focus-within:ring-2 focus-within:ring-ring/60 dark:bg-[oklch(0.196_0.002_286.2)]",
        disabled && "opacity-50",
        className,
      )}
      data-slot="labeled-select"
    >
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <select
        aria-label={label}
        className="min-w-0 cursor-pointer appearance-none truncate bg-transparent font-medium text-foreground outline-none disabled:cursor-not-allowed"
        disabled={disabled}
        onChange={(event) => onValueChange(event.target.value as T)}
        value={value}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <IconChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute right-[9px] size-[14px] text-faint"
      />
    </label>
  );
}
