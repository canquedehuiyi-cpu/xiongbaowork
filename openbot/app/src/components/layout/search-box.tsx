import { IconSearch } from "@tabler/icons-react";
import { cn } from "@/lib/utils";

/**
 * A workbench search box: 32px, the magnifier on the right as the reference draws it
 * (docs/acceptance/qoderwake-reference/). Controlled; the caller decides whether a keystroke writes
 * the URL or a local draft.
 */
export function SearchBox({
  label,
  value,
  onValueChange,
  placeholder,
  className,
}: {
  /** The accessible name. */
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "relative flex h-[32px] min-w-0 items-center rounded-[9px] border border-border bg-muted focus-within:ring-2 focus-within:ring-ring/60 dark:bg-[oklch(0.196_0.002_286.2)]",
        className,
      )}
      data-slot="search-box"
    >
      <input
        aria-label={label}
        className="h-full min-w-0 flex-1 bg-transparent pr-3 pl-[33px] text-[12px] outline-none placeholder:text-muted-foreground"
        onChange={(event) => onValueChange(event.target.value)}
        placeholder={placeholder}
        type="search"
        value={value}
      />
      <IconSearch
        aria-hidden="true"
        className="pointer-events-none absolute left-[11px] size-[15px] text-faint"
      />
    </div>
  );
}
