import { IconSearch } from "@tabler/icons-react";
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
 * The pager under a grid: previous, the page numbers, next. One-based, and the caller keeps the page
 * in the URL so a reload or a shared link lands on the same page.
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
    <nav aria-label="分页" className="mt-4 flex items-center justify-end gap-1">
      <Button
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
        size="sm"
        variant="ghost"
      >
        上一页
      </Button>
      {Array.from({ length: pages }, (_, index) => index + 1).map((number) => (
        <Button
          aria-current={number === page ? "page" : undefined}
          className="min-w-[32px] tabular-nums"
          key={number}
          onClick={() => onPage(number)}
          size="sm"
          variant={number === page ? "secondary" : "ghost"}
        >
          {number}
        </Button>
      ))}
      <Button
        disabled={page >= pages}
        onClick={() => onPage(page + 1)}
        size="sm"
        variant="ghost"
      >
        下一页
      </Button>
    </nav>
  );
}
