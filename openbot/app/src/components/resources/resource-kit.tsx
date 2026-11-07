import { IconArrowLeft, IconArrowRight, IconSearch } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { QueryError } from "@/components/layout/query-error";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * The pieces every tab of 能力与资源 is built from, so nine tabs share one header, one grid, one
 * set of states and one pager instead of each drawing its own.
 */

/** A tab's first row: what it is, its own actions, and its search. */
export function TabHeader({
  description,
  actions,
  search,
}: {
  description: ReactNode;
  actions?: ReactNode;
  search?: ReactNode;
}) {
  return (
    <div className="mt-[20px] flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
      <p className="max-w-prose text-pretty text-[13px] text-muted-foreground leading-relaxed">
        {description}
      </p>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {search}
        {actions}
      </div>
    </div>
  );
}

/** A search box in the toolbar: 32 CSS px, the reference's toolbar control height. */
export function TabSearch({
  label,
  value,
  onChange,
  className,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  return (
    <InputGroup className={cn("h-[32px] w-full sm:w-[240px]", className)}>
      <InputGroupAddon>
        <IconSearch />
      </InputGroupAddon>
      <InputGroupInput
        aria-label={label}
        onChange={(event) => onChange(event.target.value)}
        placeholder={label}
        type="search"
        value={value}
      />
    </InputGroup>
  );
}

/** The grid cards sit in: one column on a phone, up to four on a wide desktop. */
export function CardGrid({
  children,
  label,
  className,
}: {
  children: ReactNode;
  label: string;
  className?: string;
}) {
  return (
    <ul
      aria-label={label}
      className={cn(
        "grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4",
        className,
      )}
    >
      {children}
    </ul>
  );
}

/** The skeleton a tab shows while its first read is in flight. */
export function TabSkeleton({ label = "正在加载" }: { label?: string }) {
  return (
    <div
      aria-label={label}
      className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3"
      role="status"
    >
      <Skeleton className="h-[132px]" />
      <Skeleton className="h-[132px]" />
      <Skeleton className="h-[132px]" />
    </div>
  );
}

type QueryLike = {
  isPending: boolean;
  isFetching: boolean;
  error: unknown;
  data: unknown;
  refetch: () => unknown;
};

/**
 * Pending, failed-with-retry, and the content — with a failed BACKGROUND refetch keeping the cached
 * content on screen under the alert, since a stale list is still the best answer there is.
 */
export function QueryState({
  query,
  label,
  children,
  skeleton,
}: {
  query: QueryLike;
  /** What failed, said by the tab: "读不到插件". */
  label: string;
  children: ReactNode;
  skeleton?: ReactNode;
}) {
  if (query.isPending) return <>{skeleton ?? <TabSkeleton />}</>;
  return (
    <>
      {query.error ? (
        <div className="mt-4">
          <QueryError
            error={query.error}
            label={label}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
          />
        </div>
      ) : null}
      {query.data === undefined ? null : children}
    </>
  );
}

/** A tab with nothing in it yet: a fact and, where there is one, the way to change it. */
export function TabEmpty({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <Empty className="mt-4 h-[180px] border border-dashed">
      <EmptyHeader>
        <EmptyTitle className="text-muted-foreground">{title}</EmptyTitle>
        {description ? (
          <EmptyDescription>{description}</EmptyDescription>
        ) : null}
      </EmptyHeader>
      {action ? <EmptyContent>{action}</EmptyContent> : null}
    </Empty>
  );
}

/** A filter that matches nothing, with the one way back. */
export function NoMatch({
  title,
  onClear,
}: {
  title: string;
  onClear?: () => void;
}) {
  return (
    <div className="mt-4 flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-8 text-center">
      <p className="text-[13px] text-muted-foreground">{title}</p>
      {onClear ? (
        <Button onClick={onClear} size="sm" variant="outline">
          清除筛选
        </Button>
      ) : null}
    </div>
  );
}

/** A small tag beside a title. Not a control, so plain text a screen reader reads in line. */
export function Tag({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: "muted" | "positive" | "warning";
}) {
  return (
    <span
      className={cn(
        "inline-flex h-[20px] shrink-0 items-center rounded-full border px-2 font-normal text-[12px]",
        tone === "positive"
          ? "border-primary/30 text-primary"
          : tone === "warning"
            ? "border-amber-500/30 text-amber-600 dark:text-amber-400"
            : "border-border text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

/** "已授予 N 位员工", or that nobody holds it yet. */
export function grantedSentence(count: number): string {
  return count > 0 ? `已授予 ${count} 位员工` : "尚未授予任何员工";
}

/**
 * Which page numbers the pager draws: every page when there are five or fewer, otherwise the first,
 * the last, the current one and its neighbours (the first three while near the start, the last three
 * near the end), with `"gap"` where numbers are left out — 「1 2 3 … 7」 as the reference draws it.
 * A gap of exactly one page draws that page instead, since an ellipsis would be no shorter.
 */
export function pageWindow(page: number, pages: number): (number | "gap")[] {
  if (pages <= 5) return Array.from({ length: pages }, (_, index) => index + 1);
  const keep = new Set([1, pages, page - 1, page, page + 1]);
  if (page <= 2) for (const n of [2, 3]) keep.add(n);
  if (page >= pages - 1) for (const n of [pages - 2, pages - 1]) keep.add(n);
  const numbers = [...keep]
    .filter((n) => n >= 1 && n <= pages)
    .sort((a, b) => a - b);
  const out: (number | "gap")[] = [];
  let previous = 0;
  for (const n of numbers) {
    if (n - previous === 2) out.push(n - 1);
    else if (n - previous > 2) out.push("gap");
    out.push(n);
    previous = n;
  }
  return out;
}

const PAGER_BUTTON =
  "inline-flex size-[32px] items-center justify-center rounded-md text-[13px] tabular-nums outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60 disabled:pointer-events-none disabled:opacity-40";

/**
 * The pager under a grid, bottom right: ←, the page numbers with the current one boxed, →. One-based,
 * and the caller keeps the page in the URL so a reload or a shared link lands on the same page. The
 * arrows are named 上一页 / 下一页 for a screen reader.
 */
export function Pager({
  page,
  pages,
  onPage,
}: {
  page: number;
  pages: number;
  onPage: (page: number) => void;
}) {
  if (pages <= 1) return null;
  return (
    <nav
      aria-label="分页"
      className="mt-[20px] flex items-center justify-end gap-[4px]"
    >
      <button
        aria-label="上一页"
        className={cn(
          PAGER_BUTTON,
          "text-muted-foreground hover:text-foreground",
        )}
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
        type="button"
      >
        <IconArrowLeft aria-hidden="true" className="size-[16px]" />
      </button>
      {pageWindow(page, pages).map((item, index, all) =>
        item === "gap" ? (
          <span
            aria-hidden="true"
            className="inline-flex size-[32px] items-center justify-center text-[13px] text-muted-foreground"
            // A gap always follows a number, which names it.
            key={`gap-after-${all[index - 1]}`}
          >
            …
          </span>
        ) : (
          <button
            aria-current={item === page ? "page" : undefined}
            className={cn(
              PAGER_BUTTON,
              item === page
                ? "border border-foreground/25 font-medium text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
            data-current={item === page ? "true" : undefined}
            key={item}
            onClick={() => onPage(item)}
            type="button"
          >
            {item}
          </button>
        ),
      )}
      <button
        aria-label="下一页"
        className={cn(
          PAGER_BUTTON,
          "text-muted-foreground hover:text-foreground",
        )}
        disabled={page >= pages}
        onClick={() => onPage(page + 1)}
        type="button"
      >
        <IconArrowRight aria-hidden="true" className="size-[16px]" />
      </button>
    </nav>
  );
}
