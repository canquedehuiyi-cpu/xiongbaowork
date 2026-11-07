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
        "relative flex h-[32px] min-w-0 items-center rounded-md border border-border focus-within:ring-2 focus-within:ring-ring/60",
        className,
      )}
      data-slot="search-box"
    >
      <input
        aria-label={label}
        className="h-full min-w-0 flex-1 bg-transparent pr-8 pl-3 text-[13px] outline-none placeholder:text-muted-foreground/80"
        onChange={(event) => onValueChange(event.target.value)}
        placeholder={placeholder}
        type="search"
        value={value}
      />
      <IconSearch
        aria-hidden="true"
        className="pointer-events-none absolute right-2.5 size-[15px] text-muted-foreground"
      />
    </div>
  );
}
